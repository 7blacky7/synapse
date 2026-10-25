/**
 * MODUL: cli-verlauf.ts (P22-T133)
 * ZWECK: Lokale Claude-Code-Sitzungen (~/.claude/projects/<ordner>/<sitzung>.jsonl) in den Agenten-Verlauf der
 *        Web-UI uebertragen. Die Unterhaltung mit einem CLI-Agenten auf diesem PC (z. B. dem Koordinator) ist dann
 *        dort sichtbar, wo man auch die Container-Agenten sieht.
 *
 * SCHALTER: config.json cli_verlauf.aktiv (Tray-Haken "CLI-Verlauf an Synapse", Standard aus). Wird je Takt frisch
 *   von der Platte gelesen; aus = nichts wird gelesen oder gesendet.
 * ZUORDNUNG: der Ausweis (sai_...), mit dem sich die Sitzung per chat(anmelden) gemeldet hat. Zeilen vor der ersten
 *   Anmeldung gehoeren zum ersten Ausweis, nach einem Wechsel zum neuen. Sitzungen ohne Ausweis werden nie
 *   uebertragen. Der Server prueft den Ausweis (POST /api/daemon/cli-verlauf) und nimmt jede ref genau einmal auf.
 * STAND: ~/.synapse/file-watcher/cli-verlauf-stand.json je Datei; nur vollstaendige Zeilen gelten als gelesen.
 *   Geprueft werden Dateien, die in den letzten CLI_VERLAUF_TAGE (Standard 2) Tagen geaendert wurden.
 *   Aus: CLI_VERLAUF_DISABLED=1. Codex-Rollouts (anderes Format) folgen spaeter.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sitzungsEintraegeAus, type SitzungsEintrag } from '@synapse/agents';
import { configDir, configFilePath } from './config.js';
import { anfrage, DaemonJobsApiFehler, DAEMON_API_ID, DAEMON_HOST } from './daemon-jobs-api.js';

const TAKT_MS = 15_000;
const STAPEL_EINTRAEGE = 100;
const STAPEL_BYTES = 3 * 1024 * 1024;
const AUSWEIS = /^sai_[A-Za-z0-9_-]{1,64}$/;

interface DateiStand {
  /** Byte-Position hinter der letzten uebertragenen vollstaendigen Zeile. */
  offset: number;
  /** Ausweis der letzten Anmeldung in dieser Sitzung (null = noch keiner gesehen). */
  ausweis: string | null;
  /** Ohne Ausweis: bis hierher wurde nach einer Anmeldung gesucht. */
  gesucht_bis?: number;
  gesendet: number;
  fehler?: string | null;
}
type Stand = Record<string, DateiStand>;

/** Ausweis aus einer chat(anmelden)-Zeile (tool_use mit action anmelden und agent_kennung/token), sonst null. */
export function ausweisAusZeile(zeile: string): string | null {
  if (!zeile.includes('anmelden') || !zeile.includes('sai_')) return null;
  let obj: { type?: unknown; message?: { content?: unknown } };
  try { obj = JSON.parse(zeile) as typeof obj; } catch { return null; }
  if (obj.type !== 'assistant' || !Array.isArray(obj.message?.content)) return null;
  let gefunden: string | null = null;
  for (const b of obj.message.content as Array<Record<string, unknown> | null>) {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string' || !/(^|__)chat$/.test(b.name)) continue;
    const input = (b.input ?? {}) as Record<string, unknown>;
    if (input.action !== 'anmelden') continue;
    const k = input.agent_kennung ?? input.token;
    if (typeof k === 'string' && AUSWEIS.test(k)) gefunden = k;
  }
  return gefunden;
}

/**
 * Eintraege einer Sitzung je Ausweis (rein). Zeilen vor der ersten Anmeldung gehoeren zum ersten gefundenen Ausweis
 * bzw. zu startAusweis aus einem frueheren Takt, nach einem Wechsel zum neuen. Ohne jeden Ausweis: keine Gruppen.
 */
export function eintraegeJeAusweis(zeilen: readonly string[], startAusweis: string | null = null):
  { gruppen: Array<{ ausweis: string; eintraege: SitzungsEintrag[] }>; letzterAusweis: string | null } {
  const gruppen: Array<{ ausweis: string; zeilen: string[] }> = startAusweis ? [{ ausweis: startAusweis, zeilen: [] }] : [];
  let vorlauf: string[] = [];
  for (const z of zeilen) {
    const a = ausweisAusZeile(z);
    const letzte = gruppen[gruppen.length - 1];
    if (a && a !== letzte?.ausweis) {
      gruppen.push({ ausweis: a, zeilen: letzte ? [] : vorlauf });
      vorlauf = [];
    }
    const ziel = gruppen[gruppen.length - 1];
    if (ziel) ziel.zeilen.push(z);
    else vorlauf.push(z);
  }
  return {
    gruppen: gruppen.map((g) => ({ ausweis: g.ausweis, eintraege: sitzungsEintraegeAus(g.zeilen) })).filter((g) => g.eintraege.length > 0),
    letzterAusweis: gruppen[gruppen.length - 1]?.ausweis ?? null,
  };
}

/**
 * Null-Bytes raus (rein): PostgreSQL weist text mit 0x00 ab, und der Fehler kippt den ganzen Stapel (gesehen an
 * einer Werkzeug-Ausgabe der Koordinator-Sitzung, 25.10.2026). Bereinigt werden die Strings selbst, nicht der
 * JSON-Text - sonst wuerde ein woertliches "\u0000" (mit Backslash) im Inhalt zerstoert.
 */
function bereinige(v: unknown): unknown {
  if (typeof v === 'string') return v.includes('\0') ? v.replace(/\0/g, '') : v;
  if (Array.isArray(v)) return v.map(bereinige);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, bereinige(w)]));
  return v;
}
export function ohneNullBytes(e: SitzungsEintrag): SitzungsEintrag {
  return JSON.stringify(e).includes('\\u0000') ? bereinige(e) as SitzungsEintrag : e;
}

/** Stapel fuer den Versand: hoechstens STAPEL_EINTRAEGE Eintraege bzw. etwa STAPEL_BYTES (rein), ohne Null-Bytes. */
export function inStapeln(eintraege: readonly SitzungsEintrag[]): SitzungsEintrag[][] {
  const stapel: SitzungsEintrag[][] = [];
  let aktuell: SitzungsEintrag[] = [];
  let bytes = 0;
  for (const roh of eintraege) {
    const e = ohneNullBytes(roh);
    const n = Buffer.byteLength(JSON.stringify(e), 'utf8');
    if (aktuell.length && (aktuell.length >= STAPEL_EINTRAEGE || bytes + n > STAPEL_BYTES)) { stapel.push(aktuell); aktuell = []; bytes = 0; }
    aktuell.push(e);
    bytes += n;
  }
  if (aktuell.length) stapel.push(aktuell);
  return stapel;
}

function schalterAktiv(): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(configFilePath(), 'utf-8')) as { cli_verlauf?: { aktiv?: unknown } };
    return j?.cli_verlauf?.aktiv === true;
  } catch { return false; }
}

const standPfad = (): string => path.join(configDir(), 'cli-verlauf-stand.json');
function leseStand(): Stand {
  try { const j = JSON.parse(fs.readFileSync(standPfad(), 'utf-8')); return j && typeof j === 'object' && !Array.isArray(j) ? j as Stand : {}; }
  catch { return {}; }
}
function schreibeStand(s: Stand): void {
  const tmp = standPfad() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, standPfad());
}

function sitzungsDateien(): Array<{ pfad: string; groesse: number }> {
  const wurzel = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const tage = Number(process.env.CLI_VERLAUF_TAGE);
  const ab = Date.now() - (Number.isFinite(tage) && tage > 0 ? tage : 2) * 86_400_000;
  const aus: Array<{ pfad: string; groesse: number }> = [];
  let ordner: string[] = [];
  try { ordner = fs.readdirSync(wurzel); } catch { return aus; }
  for (const o of ordner) {
    let namen: string[] = [];
    try { namen = fs.readdirSync(path.join(wurzel, o)); } catch { continue; }
    for (const n of namen) {
      if (!n.endsWith('.jsonl')) continue;
      const pfad = path.join(wurzel, o, n);
      try { const st = fs.statSync(pfad); if (st.isFile() && st.mtimeMs >= ab) aus.push({ pfad, groesse: st.size }); } catch { /* weg */ }
    }
  }
  return aus;
}

/** Vollstaendige Zeilen ab Byte-Position; ende = Position hinter der letzten vollstaendigen Zeile. */
function liesZeilenAb(pfad: string, ab: number, bis: number): { zeilen: string[]; ende: number } {
  if (bis <= ab) return { zeilen: [], ende: ab };
  const fd = fs.openSync(pfad, 'r');
  try {
    const puffer = Buffer.alloc(bis - ab);
    const n = fs.readSync(fd, puffer, 0, puffer.length, ab);
    const letzte = puffer.subarray(0, n).lastIndexOf(0x0a);
    if (letzte < 0) return { zeilen: [], ende: ab };
    return { zeilen: puffer.subarray(0, letzte).toString('utf8').split('\n'), ende: ab + letzte + 1 };
  } finally { fs.closeSync(fd); }
}

async function sende(ausweis: string, eintraege: SitzungsEintrag[]): Promise<number> {
  let aufgenommen = 0;
  for (const stapel of inStapeln(eintraege)) {
    const r = await anfrage<{ aufgenommen?: unknown }>('/api/daemon/cli-verlauf',
      { method: 'POST', body: { host: DAEMON_HOST, daemon_id: DAEMON_API_ID, ausweis, runtime: 'claude', eintraege: stapel } }, 60_000);
    aufgenommen += typeof r.aufgenommen === 'number' ? r.aufgenommen : 0;
  }
  return aufgenommen;
}

/** Ein Takt: alle frischen Sitzungsdateien nachziehen. Transportfehler: Stand bleibt, naechster Takt versucht es erneut. */
export async function cliVerlaufTakt(): Promise<void> {
  if (!schalterAktiv()) return;
  const stand = leseStand();
  let geaendert = false;
  for (const { pfad, groesse } of sitzungsDateien()) {
    const s: DateiStand = stand[pfad] ?? { offset: 0, ausweis: null, gesendet: 0 };
    if (s.offset >= groesse && (s.gesucht_bis ?? 0) >= groesse) continue;
    if (!s.ausweis) {
      // Noch kein Ausweis: nur den neuen Teil nach einer Anmeldung durchsuchen, erst bei einem Fund alles lesen.
      const neu = liesZeilenAb(pfad, s.gesucht_bis ?? 0, groesse);
      if (!neu.zeilen.some((z) => ausweisAusZeile(z))) {
        if (neu.ende !== (s.gesucht_bis ?? 0)) { stand[pfad] = { ...s, gesucht_bis: neu.ende }; geaendert = true; }
        continue;
      }
    }
    const { zeilen, ende } = liesZeilenAb(pfad, s.offset, groesse);
    if (!zeilen.length) continue;
    const { gruppen, letzterAusweis } = eintraegeJeAusweis(zeilen, s.ausweis);
    try {
      let gesendet = 0;
      for (const g of gruppen) gesendet += await sende(g.ausweis, g.eintraege);
      stand[pfad] = { offset: ende, ausweis: letzterAusweis, gesucht_bis: ende, gesendet: s.gesendet + gesendet, fehler: null };
      geaendert = true;
      if (gesendet) console.error(`[cli-verlauf] ${path.basename(pfad)}: ${gesendet} Eintrag/Eintraege uebertragen`);
    } catch (err) {
      const code = err instanceof DaemonJobsApiFehler ? err.code : undefined;
      if (code === 'ausweis_ungueltig') {
        // Ausweis widerrufen/unbekannt: diese Zeilen nie wieder senden, aber sichtbar vermerken.
        stand[pfad] = { ...s, offset: ende, ausweis: letzterAusweis, gesucht_bis: ende, fehler: 'ausweis_ungueltig' };
        geaendert = true;
        continue;
      }
      stand[pfad] = { ...s, fehler: (err as Error).message.slice(0, 300) };
      geaendert = true;
      console.error(`[cli-verlauf] ${path.basename(pfad)}: Uebertragung fehlgeschlagen, naechster Takt versucht es erneut: ${(err as Error).message}`);
      break;
    }
  }
  if (geaendert) schreibeStand(stand);
}

export interface CliVerlaufHandle { stop(): void }

export function startCliVerlauf(): CliVerlaufHandle {
  let laeuft = false;
  const takt = async () => {
    if (laeuft) return;
    laeuft = true;
    try { await cliVerlaufTakt(); }
    catch (err) { console.error('[cli-verlauf] Takt fehlgeschlagen:', (err as Error).message); }
    finally { laeuft = false; }
  };
  const timer = setInterval(() => { void takt(); }, TAKT_MS);
  timer.unref();
  void takt();
  return { stop: () => clearInterval(timer) };
}
