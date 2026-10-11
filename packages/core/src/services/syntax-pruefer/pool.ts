/**
 * MODUL: Worker-Pool der Syntaxpruefer (P16-T4, 11.10.2026)
 *
 * Eigener Pool, NICHT der Parser-Pool (parser/worker-pool.ts): Syntaxpruefung haengt am Schreibweg
 * (files plan/commit, Einzelschreibweg) und darf weder auf einen Index-Lauf warten noch ihn blockieren.
 * Uebernimmt die Lehren aus P15-T19:
 *  - ein Worker wird hoechstens EINMAL als ausgefallen behandelt ('error' + 'exit' = ein Ausfall);
 *  - absichtlich beendete Worker (Timeout) zaehlen nicht als Ausfall und werden nicht doppelt ersetzt;
 *  - nach MAX_AUSFAELLE in Folge wird der Slot stillgelegt, nach SYNTAX_POOL_WIEDERBELEBUNG_MS
 *    (Standard 60 s) beim naechsten Auftrag neu besetzt; sind alle Slots still, wird sofort abgelehnt.
 *
 * Grenzen (alle per Env, Standardwerte in Klammern):
 *  - SYNTAX_WORKER_THREADS (2): Anzahl Worker; '0' = kein Pool (Pruefung im Haupt-Thread, index.ts).
 *  - SYNTAX_PRUEFER_TIMEOUT_MS (5000): Reissleine je Auftrag, danach wird der Worker beendet; 0 = aus.
 *  - SYNTAX_WORKER_MAX_MB (256): Heap-Grenze je Worker (resourceLimits); Ueberschreitung = Ausfall.
 *  - SYNTAX_WARTESCHLANGE_MAX (64): mehr wartende Auftraege werden sofort abgelehnt (kein Stau).
 *  - SYNTAX_CACHE_EINTRAEGE (128): Ergebnis-Cache je (Pruefer, Pfad, Inhalt-Hash).
 *
 * BUDGET UND NACHLIEFERUNG: das Budget setzt der Aufrufer (fehlermuster-pruefung.ts, Promise.race).
 * Ein Auftrag, der das Budget reisst, laeuft im Worker zu Ende; sein Ergebnis landet im Cache.
 * Die naechste Pruefung desselben Inhalts (commit nach plan, plan_status, erneutes plan) bekommt es
 * dann sofort - so kommt der verspaetete Befund doch noch an den Plan. Gleiche Auftraege, die
 * gleichzeitig laufen, teilen sich EINEN Worker-Lauf.
 */

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import type { SyntaxMeldung } from '../fehlermuster-pruefung.js';

const MAX_AUSFAELLE = 3;

function envZahl(name: string, standard: number): number {
  const roh = process.env[name];
  const wert = roh === undefined || roh.trim() === '' ? NaN : Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : standard;
}

export class SyntaxPrueferTimeout extends Error {
  constructor(readonly pruefer: string, readonly pfad: string, readonly limitMs: number) {
    super(`Syntaxpruefer ${pruefer} fuer ${pfad} nach ${limitMs} ms abgebrochen (Reissleine)`);
    this.name = 'SyntaxPrueferTimeout';
  }
}

export class SyntaxPoolNichtVerfuegbar extends Error {
  constructor(grund: string) {
    super(`Syntax-Pool nicht verfuegbar: ${grund}`);
    this.name = 'SyntaxPoolNichtVerfuegbar';
  }
}

interface Auftrag {
  id: number;
  pruefer: string;
  inhalt: string;
  pfad: string;
  resolve: (m: SyntaxMeldung[]) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  auftrag: Auftrag | null;
  ausfaelle: number;
  timer: NodeJS.Timeout | null;
  stillgelegtSeit: number | null;
  gestartet: number | null;
}

type Antwort = { id: number; ok: true; meldungen: SyntaxMeldung[]; ms: number } | { id: number; ok: false; error: string } | { bereit: true };

function workerUrl(): URL {
  return new URL('./worker.js', import.meta.url);
}

export class SyntaxWorkerPool {
  readonly size: number;
  private slots: Slot[] = [];
  private queue: Auftrag[] = [];
  private naechsteId = 1;
  private beendend = new Set<Worker>();
  private laufend = new Map<string, Promise<SyntaxMeldung[]>>();
  private cache = new Map<string, SyntaxMeldung[]>();
  private aus = false;
  private z = { auftraege: 0, cache_treffer: 0, geteilt: 0, timeouts: 0, ausfaelle: 0, abgelehnt: 0, worker_gestartet: 0, ms_summe: 0 };

  constructor(size?: number) {
    this.size = Math.max(1, Math.floor(size ?? (envZahl('SYNTAX_WORKER_THREADS', 2) || 2)));
    for (let i = 0; i < this.size; i++) this.starteSlot(i, 0);
  }

  private beende(worker: Worker): void {
    this.beendend.add(worker);
    worker.once('exit', () => { this.beendend.delete(worker); });
    try { void worker.terminate(); } catch { /* ignore */ }
  }

  private starteSlot(index: number, ausfaelle: number): void {
    const maxMb = envZahl('SYNTAX_WORKER_MAX_MB', 256) || 256;
    const worker = new Worker(workerUrl(), {
      resourceLimits: { maxOldGenerationSizeMb: maxMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.floor(maxMb / 8))) },
    });
    this.z.worker_gestartet++;
    worker.unref();
    const slot: Slot = { worker, auftrag: null, ausfaelle, timer: null, stillgelegtSeit: null, gestartet: null };
    this.slots[index] = slot;
    let abgehandelt = false;

    worker.on('message', (msg: Antwort) => {
      if ('bereit' in msg) return;
      const a = slot.auftrag;
      if (!a || a.id !== msg.id) return;
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      if (slot.gestartet !== null) this.z.ms_summe += Date.now() - slot.gestartet;
      slot.auftrag = null;
      slot.gestartet = null;
      slot.ausfaelle = 0;
      worker.unref();
      if (msg.ok) a.resolve(msg.meldungen);
      else a.reject(new Error(msg.error));
      this.verteile();
    });

    const ausfall = (ursache: unknown) => {
      if (this.aus || abgehandelt) return;
      abgehandelt = true;
      // Absichtlich beendet (Reissleine) oder Slot schon neu besetzt: Nachfolger laeuft bereits.
      if (this.beendend.has(worker) || this.slots[index] !== slot) return;
      this.z.ausfaelle++;
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      const a = slot.auftrag;
      slot.auftrag = null;
      this.beende(worker);
      const text = ursache instanceof Error ? ursache.message : String(ursache);
      if (a) a.reject(new Error(`Syntax-Worker ausgefallen: ${text}`));
      const naechste = slot.ausfaelle + 1;
      if (naechste > MAX_AUSFAELLE) {
        console.error(`[syntax-pool] Slot ${index} nach ${MAX_AUSFAELLE} Ausfaellen in Folge stillgelegt (${text})`);
        this.slots[index] = { ...slot, auftrag: null, ausfaelle: naechste, stillgelegtSeit: Date.now() };
        if (this.alleStill()) for (const q of this.queue.splice(0)) q.reject(new SyntaxPoolNichtVerfuegbar('alle Worker stillgelegt'));
        return;
      }
      this.starteSlot(index, naechste);
      this.verteile();
    };
    worker.on('error', ausfall);
    worker.on('exit', (code) => { if (code !== 0) ausfall(new Error(`Worker beendet mit Code ${code}`)); });
  }

  private alleStill(): boolean {
    return this.slots.length > 0 && this.slots.every((s) => s.stillgelegtSeit !== null);
  }

  private belebe(): void {
    const pause = envZahl('SYNTAX_POOL_WIEDERBELEBUNG_MS', 60_000);
    const jetzt = Date.now();
    this.slots.forEach((s, i) => {
      if (s.stillgelegtSeit !== null && jetzt - s.stillgelegtSeit >= pause) this.starteSlot(i, 0);
    });
  }

  private freierSlot(): Slot | null {
    return this.slots.find((s) => s.stillgelegtSeit === null && s.auftrag === null) ?? null;
  }

  private verteile(): void {
    while (this.queue.length > 0) {
      const s = this.freierSlot();
      if (!s) return;
      this.starte(s, this.queue.shift()!);
    }
  }

  private starte(slot: Slot, a: Auftrag): void {
    slot.auftrag = a;
    slot.gestartet = Date.now();
    slot.worker.ref();
    const limit = envZahl('SYNTAX_PRUEFER_TIMEOUT_MS', 5000);
    if (limit > 0) {
      slot.timer = setTimeout(() => {
        slot.timer = null;
        if (slot.auftrag !== a) return;
        slot.auftrag = null;
        this.z.timeouts++;
        console.error(`[syntax-pool] TIMEOUT nach ${limit} ms: ${a.pruefer} ${a.pfad} - Worker wird ersetzt`);
        this.beende(slot.worker);
        a.reject(new SyntaxPrueferTimeout(a.pruefer, a.pfad, limit));
        const index = this.slots.indexOf(slot);
        if (index >= 0 && !this.aus) this.starteSlot(index, slot.ausfaelle);
        this.verteile();
      }, limit);
      slot.timer.unref();
    }
    try {
      slot.worker.postMessage({ id: a.id, pruefer: a.pruefer, inhalt: a.inhalt, pfad: a.pfad });
    } catch (err) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      slot.auftrag = null;
      a.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Prueft inhalt mit dem genannten Katalog-Pruefer im Worker. */
  pruefe(pruefer: string, inhalt: string, pfad: string): Promise<SyntaxMeldung[]> {
    if (this.aus) return Promise.reject(new SyntaxPoolNichtVerfuegbar('Pool beendet'));
    const schluessel = `${pruefer}|${pfad}|${createHash('sha1').update(inhalt).digest('hex')}`;
    const treffer = this.cache.get(schluessel);
    if (treffer) {
      this.z.cache_treffer++;
      this.cache.delete(schluessel);
      this.cache.set(schluessel, treffer);
      return Promise.resolve(treffer);
    }
    const laeuft = this.laufend.get(schluessel);
    if (laeuft) { this.z.geteilt++; return laeuft; }
    this.belebe();
    if (this.alleStill()) return Promise.reject(new SyntaxPoolNichtVerfuegbar('alle Worker stillgelegt'));
    if (this.queue.length >= envZahl('SYNTAX_WARTESCHLANGE_MAX', 64)) {
      this.z.abgelehnt++;
      return Promise.reject(new SyntaxPoolNichtVerfuegbar('Warteschlange voll'));
    }
    this.z.auftraege++;
    const p = new Promise<SyntaxMeldung[]>((resolve, reject) => {
      const a: Auftrag = { id: this.naechsteId++, pruefer, inhalt, pfad, resolve, reject };
      const s = this.freierSlot();
      if (s) this.starte(s, a); else this.queue.push(a);
    });
    this.laufend.set(schluessel, p);
    p.then((m) => {
      const max = envZahl('SYNTAX_CACHE_EINTRAEGE', 128);
      if (max > 0) {
        this.cache.set(schluessel, m);
        while (this.cache.size > max) this.cache.delete(this.cache.keys().next().value as string);
      }
    }, () => { /* Fehler nicht cachen */ }).finally(() => { this.laufend.delete(schluessel); });
    return p;
  }

  /** Diagnose (intern/Tests): Slots, Warteschlange, Zaehler. */
  zustand(): Record<string, unknown> {
    return {
      groesse: this.size,
      warteschlange: this.queue.length,
      laufend: this.laufend.size,
      cache: this.cache.size,
      beendet_exit_ausstehend: this.beendend.size,
      slots: this.slots.map((s, i) => ({
        slot: i, thread_id: s.worker.threadId, busy: s.auftrag !== null, ausfaelle: s.ausfaelle,
        stillgelegt: s.stillgelegtSeit !== null, datei: s.auftrag?.pfad ?? null,
        laufzeit_ms: s.gestartet === null ? null : Date.now() - s.gestartet,
      })),
      zaehler: { ...this.z },
    };
  }

  async beenden(): Promise<void> {
    this.aus = true;
    for (const q of this.queue.splice(0)) q.reject(new SyntaxPoolNichtVerfuegbar('Pool beendet'));
    await Promise.all(this.slots.map(async (s) => {
      if (s.timer) clearTimeout(s.timer);
      if (s.auftrag) { s.auftrag.reject(new SyntaxPoolNichtVerfuegbar('Pool beendet')); s.auftrag = null; }
      try { await s.worker.terminate(); } catch { /* ignore */ }
    }));
    this.slots = [];
  }
}
