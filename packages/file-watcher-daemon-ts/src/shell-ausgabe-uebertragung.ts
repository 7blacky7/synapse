/**
 * MODUL: shell-ausgabe-uebertragung.ts (P22-T243, mit P22-T208)
 * ZWECK: Uebertraegt die VOLLE Ausgabe eines Shell-Jobs blockweise aus der lokalen Stream-Datei (dort bereits maskiert)
 *   als Teile an die API (daemon_jobs_weg=api) bzw. direkt an den Core (PG-Weg). Die Datei wird nie ganz eingelesen.
 *   - live (P22-T208): ab der Abloesung alle live_intervall_s nur vollstaendige Zeilen; laufende Jobs sind so in PG lesbar.
 *   - final: der Rest, auch eine letzte Zeile ohne Zeilenende.
 *   - Grenze je Job (grenze_erreicht): weiterlesen und nur zaehlen; die letzten ende_reserve_bytes bleiben gepuffert und
 *     gehen am Ende als 'ende'-Teile mit der ausgelassenen Menge raus (die API setzt den sichtbaren Marker).
 *   - Schalter aus (shell_ausgabe_funktion_aus): status 'aus', der Worker nimmt unveraendert den Altweg.
 *   - Fehler (nach 3 Versuchen, Luecke, fremder Job): status 'fehler'; der Abschluss meldet die Teiluebertragung als
 *     unvollstaendig, die lokale Stream-Datei bleibt 1 h liegen.
 * Einstellwerte (teil_bytes, live_intervall_s, ende_reserve_bytes) kommen mit jeder Teil-Antwort vom Server.
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import {
  schneideAusgabeTeile,
  SHELL_AUSGABE_EINSTELLUNGEN,
  SHELL_AUSGABE_TEIL_HART_BYTES,
  type ShellAusgabeTeilEingabe,
  type ShellAusgabeTeilErgebnis,
  type ShellAusgabeAbschlussMeta,
} from '@synapse/core';

export type ShellAusgabeTeilSender = (teil: ShellAusgabeTeilEingabe) => Promise<ShellAusgabeTeilErgebnis>;

const BLOCK_BYTES = 1 << 20;
const DAUERHAFTE_FEHLER = new Set(['ausgabe_teil_luecke', 'ausgabe_job_nicht_berechtigt', 'job_unbekannt', 'ausgabe_teil_ungueltig',
  'ausgabe_teil_zu_gross', 'ausgabe_ende_zu_gross', 'nicht_eigener_job']);

function fehlerCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  if (typeof c === 'string' && c) return c;
  return e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
}

function zaehleUmbrueche(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

export class ShellAusgabeUebertragung {
  status: 'bereit' | 'aus' | 'fehler' | 'fertig' = 'bereit';
  fehler: string | null = null;
  private offset = 0;
  private folge = 0;
  private rest = '';
  private readonly decoder = new StringDecoder('utf8');
  private teilBytes: number = SHELL_AUSGABE_EINSTELLUNGEN.teil_bytes;
  private endeReserve: number = SHELL_AUSGABE_EINSTELLUNGEN.ende_reserve_bytes;
  private intervallS: number = SHELL_AUSGABE_EINSTELLUNGEN.live_intervall_s;
  private grenze = false;
  private ring = '';
  private ausgelassenBytes = 0;
  private ausgelassenZeilen = 0;
  private kette: Promise<void> = Promise.resolve();
  private beschaeftigt = false;
  private timer: NodeJS.Timeout | null = null;
  private gelesen = 0;

  constructor(private readonly logPfad: string, private readonly senden: ShellAusgabeTeilSender,
    private readonly melde: (text: string) => void = (t) => console.error(t)) {}

  get aktiv(): boolean { return this.status === 'bereit'; }
  get live(): boolean { return this.timer !== null; }
  get teile(): number { return this.folge; }

  /** P22-T208: ab jetzt alle live_intervall_s uebertragen (nur vollstaendige Zeilen). */
  starteLive(): void {
    if (this.timer || !this.aktiv) return;
    this.timer = setInterval(() => { if (!this.beschaeftigt && this.aktiv) this.runde(false); }, Math.max(1, this.intervallS) * 1000);
    this.timer.unref?.();
    this.runde(false);
  }

  /** Letzte Runde nach Prozessende; danach status fertig | aus | fehler. */
  async beende(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.runde(true);
    await this.kette;
    if (this.aktiv) this.status = 'fertig';
  }

  /** Abschluss-Meta fuer completeShellJob. */
  meta(): ShellAusgabeAbschlussMeta {
    return { teile: this.folge, bytes_gesamt: this.gelesen, ...(this.fehler && this.status === 'fehler' ? { fehler: this.fehler } : {}) };
  }

  private runde(final: boolean): void {
    this.kette = this.kette.then(async () => {
      if (!this.aktiv) return;
      this.beschaeftigt = true;
      try { await this.lies(final); }
      catch (e) { this.setzeFehler(fehlerCode(e)); }
      finally { this.beschaeftigt = false; }
    });
  }

  private setzeFehler(code: string): void {
    if (this.status !== 'bereit') return;
    this.status = 'fehler';
    this.fehler = code;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.melde(`[shell-ausgabe] Teiluebertragung abgebrochen (${code}) nach ${this.folge} Teilen: ${this.logPfad}`);
  }

  private async lies(final: boolean): Promise<void> {
    let fd: number;
    try { fd = fs.openSync(this.logPfad, 'r'); }
    catch { if (final) this.setzeFehler('stream_datei_fehlt'); return; }
    try {
      const puffer = Buffer.alloc(BLOCK_BYTES);
      for (;;) {
        const n = fs.readSync(fd, puffer, 0, BLOCK_BYTES, this.offset);
        if (n <= 0) break;
        this.offset += n;
        this.gelesen += n;
        this.rest += this.decoder.write(puffer.subarray(0, n));
        await this.verarbeite(false);
        if (!this.aktiv) return;
      }
      if (final) {
        this.rest += this.decoder.end();
        await this.verarbeite(true);
        if (this.aktiv && this.grenze) await this.sendeEnde();
      }
    } finally { try { fs.closeSync(fd); } catch { /* schon zu */ } }
  }

  private async verarbeite(final: boolean): Promise<void> {
    if (this.grenze) { this.puffereEnde(); return; }
    const { teile, rest } = schneideAusgabeTeile(this.rest, this.teilBytes, { offenLassen: !final });
    this.rest = rest;
    for (let i = 0; i < teile.length; i++) {
      const r = await this.sende({ folge: this.folge, inhalt: teile[i] });
      if (!r) return;
      if (r.grenze_erreicht) {
        this.grenze = true;
        this.rest = teile.slice(i).join('') + this.rest;
        this.puffereEnde();
        return;
      }
      this.folge++;
    }
  }

  /** Nach erreichter Grenze: nur noch das Ende puffern, den Rest zaehlen. */
  private puffereEnde(): void {
    this.ring += this.rest;
    this.rest = '';
    if (this.ring.length > 2 * this.endeReserve) this.kuerzeRing();
  }

  private kuerzeRing(): void {
    if (this.ring.length <= this.endeReserve) return;
    let schnitt = this.ring.length - this.endeReserve;
    const nl = this.ring.indexOf('\n', schnitt);
    if (nl >= 0 && nl + 1 < this.ring.length) schnitt = nl + 1;
    else {
      const c = this.ring.charCodeAt(schnitt - 1);
      if (c >= 0xd800 && c <= 0xdbff) schnitt--;
    }
    const weg = this.ring.slice(0, schnitt);
    this.ausgelassenBytes += Buffer.byteLength(weg, 'utf8');
    this.ausgelassenZeilen += zaehleUmbrueche(weg);
    this.ring = this.ring.slice(schnitt);
  }

  private async sendeEnde(): Promise<void> {
    this.ring += this.rest;
    this.rest = '';
    this.kuerzeRing();
    const { teile } = schneideAusgabeTeile(this.ring, this.teilBytes);
    let erstes = true;
    for (const t of teile) {
      const r = await this.sende({ folge: this.folge, inhalt: t, art: 'ende',
        ...(erstes ? { ausgelassen_bytes: this.ausgelassenBytes, ausgelassen_zeilen: this.ausgelassenZeilen } : {}) });
      if (!r) return;
      this.folge++;
      erstes = false;
    }
    this.ring = '';
  }

  private async sende(teil: ShellAusgabeTeilEingabe): Promise<ShellAusgabeTeilErgebnis | null> {
    for (let versuch = 1; versuch <= 3; versuch++) {
      try {
        const r = await this.senden(teil);
        this.uebernehme(r?.einstellungen);
        return r;
      } catch (e) {
        const code = fehlerCode(e);
        if (code === 'shell_ausgabe_funktion_aus') {
          this.status = 'aus';
          this.fehler = code;
          if (this.timer) { clearInterval(this.timer); this.timer = null; }
          return null;
        }
        if (DAUERHAFTE_FEHLER.has(code) || versuch === 3) { this.setzeFehler(code); return null; }
        await new Promise((ok) => setTimeout(ok, 500 * versuch));
      }
    }
    return null;
  }

  private uebernehme(e: ShellAusgabeTeilErgebnis['einstellungen'] | undefined): void {
    if (!e) return;
    if (Number.isSafeInteger(e.teil_bytes) && e.teil_bytes > 0) this.teilBytes = Math.min(e.teil_bytes, SHELL_AUSGABE_TEIL_HART_BYTES);
    if (Number.isSafeInteger(e.ende_reserve_bytes) && e.ende_reserve_bytes > 0) this.endeReserve = e.ende_reserve_bytes;
    if (Number.isSafeInteger(e.live_intervall_s) && e.live_intervall_s > 0 && e.live_intervall_s !== this.intervallS) {
      this.intervallS = e.live_intervall_s;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => { if (!this.beschaeftigt && this.aktiv) this.runde(false); }, this.intervallS * 1000);
        this.timer.unref?.();
      }
    }
  }
}
