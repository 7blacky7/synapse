/**
 * MODUL: Asset-Intel Worker Runner
 * ZWECK: Fuehrt inspectAsset in einem eigenen node:worker_threads-Worker aus und bricht ihn HART
 *        ab (worker.terminate), wenn ein Inspektor haengt.
 *
 * WARUM EIN EIGENER THREAD: inspectAsset kann einen Inspektor, der in einer Schleife OHNE await
 * steckt, nicht unterbrechen (siehe run.ts, GRENZE DER ZEITSPERRE). Im Watcher-Prozess wuerde so
 * ein Haenger die Ereignisschleife blockieren — der Daemon traegt aber auch die Shell-Queue.
 * Abbrechen laesst sich nur der Thread als Ganzes (Vorbild parser/worker-pool.ts).
 *
 * PROTOKOLL (eine Datei, zwei Rollen — der Worker laedt genau diese Datei):
 *   In:  { id, pfad, timeoutMs?, registryModul? }
 *   Out: { id, ok: true, ergebnis: AssetResult } | { id, ok: false, fehler: string }
 * Die Worker-Rolle greift nur mit workerData.marke === WORKER_MARKE; wird die Datei im
 * Hauptthread oder in einem fremden Worker geladen, passiert beim Import nichts.
 *
 * HARTE GRENZE: timeoutMs (Standard STANDARD_GRENZEN.timeoutMs) + WORKER_GNADENFRIST_MS. Danach
 * terminate; das Ergebnis ist dann status 'fehler' mit Warnung 'worker_abgebrochen', und der
 * naechste Auftrag bekommt einen frischen Worker.
 *
 * NEBENEFFEKTE: startet bei Bedarf einen Worker-Thread; liest die Datei nur (inspectAsset).
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { STANDARD_GRENZEN } from './run.js';
import { erzeugeAssetResult } from './types.js';
import type { AssetResult, AssetSource, AssetLimits } from './types.js';

/** Zeit, die ein Worker ueber timeoutMs hinaus bekommt, bevor er hart beendet wird. */
export const WORKER_GNADENFRIST_MS = 5000;

const WORKER_MARKE = 'synapse-asset-intel-worker';

interface Auftrag {
  id: number;
  pfad: string;
  quelle?: { size: number };
  grenzen?: Partial<AssetLimits>;
  timeoutMs?: number;
  /** Modul (Pfad oder file:-URL) mit Export `registry` — nur fuer Tests. */
  registryModul?: string;
}

type Antwort = { id: number; ok: true; ergebnis: AssetResult } | { id: number; ok: false; fehler: string };


interface RangeAnfrage { art: 'readRange'; id: number; requestId: number; offset: number; length: number }
interface RangeAntwort { art: 'rangeAntwort'; id: number; requestId: number; bytes?: Uint8Array; fehler?: string }
let naechsterRange = 1;
const rangeWartend = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>();

function alsModulUrl(modul: string): string {
  return modul.startsWith('file:') ? modul : pathToFileURL(modul).href;
}

// ---------------------------------------------------------------------------
// Worker-Rolle
// ---------------------------------------------------------------------------

async function bearbeite(a: Auftrag): Promise<Antwort> {
  try {
    const asset = await import('./index.js');
    let registry: import('./registry.js').AssetRegistry | undefined;
    if (a.registryModul) {
      const m = await import(alsModulUrl(a.registryModul));
      registry = m.registry ?? m.default;
    }
    const opts = { ...a.grenzen, ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}), ...(registry ? { registry } : {}) };
    const source: AssetSource | undefined = a.quelle ? { filePath: a.pfad, size: a.quelle.size,
      readRange: (offset, length) => new Promise<Buffer>((resolve, reject) => {
        const requestId = naechsterRange++;
        rangeWartend.set(requestId, { resolve, reject });
        parentPort!.postMessage({ art: 'readRange', id: a.id, requestId, offset, length } satisfies RangeAnfrage);
      }),
    } : undefined;
    const ergebnis = source ? await asset.inspectAssetSource(source, opts) : await asset.inspectAsset(a.pfad, opts);
    return { id: a.id, ok: true, ergebnis };
  } catch (e) {
    return { id: a.id, ok: false, fehler: e instanceof Error ? e.message : String(e) };
  }
}

if (!isMainThread && parentPort && (workerData as { marke?: string } | null)?.marke === WORKER_MARKE) {
  const port = parentPort;
  port.on('message', (a: Auftrag | RangeAntwort) => {
    if ('art' in a) {
      const pending = rangeWartend.get(a.requestId);
      if (pending) { rangeWartend.delete(a.requestId); a.fehler ? pending.reject(new Error(a.fehler)) : pending.resolve(Buffer.from(a.bytes ?? [])); }
      return;
    }
    void bearbeite(a).then((antwort) => {
      for (const pending of rangeWartend.values()) pending.reject(new Error('Inspektion beendet'));
      rangeWartend.clear();
      try {
        port.postMessage(antwort);
      } catch (e) {
        // Ergebnis nicht uebertragbar (structuredClone) -> als Fehler melden statt still zu haengen.
        port.postMessage({ id: a.id, ok: false, fehler: `Ergebnis nicht uebertragbar: ${(e as Error).message}` } satisfies Antwort);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Hauptthread-Rolle
// ---------------------------------------------------------------------------

/** Optionen je Inspektion. */
export interface WorkerInspektionsOptionen {
  /** Betreibergrenzen; können nur reduziert werden. */
  grenzen?: Partial<AssetLimits>;
  /** Zeitgrenze von inspectAsset (Standard STANDARD_GRENZEN.timeoutMs). */
  timeoutMs?: number;
  /** Eigene Registry als Modul (Tests, z. B. ein haengender Inspektor). */
  registryModul?: string;
  /** Zusatzzeit bis zum harten Abbruch (Standard WORKER_GNADENFRIST_MS). */
  gnadenfristMs?: number;
}

interface Laufend {
  id: number;
  pfad: string;
  erledige: (r: AssetResult) => void;
  timer: NodeJS.Timeout;
  quelle?: AssetSource;
}

function fehlerErgebnis(pfad: string, code: string, meldung: string, quellGroesse?: number): AssetResult {
  let groesse = 0;
  try {
    groesse = quellGroesse ?? fs.statSync(pfad).size;
  } catch {
    /* Groesse ist nur Zusatzinformation */
  }
  const r = erzeugeAssetResult(pfad, groesse);
  r.status = 'fehler';
  r.warnings.push({ code, message: meldung });
  return r;
}

/**
 * Ein Worker-Slot: bearbeitet Auftraege nacheinander in EINEM langlebigen Thread. Haengt ein
 * Auftrag, wird der Thread beendet und fuer den naechsten neu gestartet. Im Leerlauf haelt der
 * Thread den Prozess nicht am Leben (unref).
 */
export class AssetInspektionsWorker {
  private worker: Worker | null = null;
  private laufend: Laufend | null = null;
  private naechsteId = 1;
  private kette: Promise<unknown> = Promise.resolve();
  private beendet = false;
  /** Zahl der hart abgebrochenen Auftraege (fuer Tests und Logs). */
  abgebrochen = 0;

  private starte(): Worker {
    const w = new Worker(new URL(import.meta.url), { workerData: { marke: WORKER_MARKE } });
    w.unref();
    w.on('message', (a: Antwort | RangeAnfrage) => {
      const l = this.laufend;
      if (!l || l.id !== a.id) return;
      if ('art' in a) {
        void (async () => {
          try {
            if (!l.quelle || !Number.isSafeInteger(a.offset) || a.offset < 0 || !Number.isSafeInteger(a.length) || a.length < 0) throw new Error('Ungültige Range-Anfrage');
            const bytes = await l.quelle.readRange(a.offset, a.length);
            if (this.laufend === l) w.postMessage({ art: 'rangeAntwort', id: a.id, requestId: a.requestId, bytes } satisfies RangeAntwort);
          } catch (e) {
            if (this.laufend === l) w.postMessage({ art: 'rangeAntwort', id: a.id, requestId: a.requestId, fehler: e instanceof Error ? e.message : String(e) } satisfies RangeAntwort);
          }
        })();
        return;
      }
      this.laufend = null;
      clearTimeout(l.timer);
      w.unref();
      l.erledige(a.ok ? a.ergebnis : fehlerErgebnis(l.pfad, 'worker_fehler', `Worker-Fehler: ${a.fehler}`, l.quelle?.size));
    });
    w.on('error', (e: Error) => this.verliere(w, 'worker_fehler', `Worker-Fehler: ${e.message}`));
    w.on('exit', (code: number) => this.verliere(w, 'worker_beendet', `Worker unerwartet beendet (exit ${code})`));
    return w;
  }

  /** Der Worker w ist weg: laufenden Auftrag mit Fehler beenden, naechster Auftrag startet neu. */
  private verliere(w: Worker, code: string, meldung: string): void {
    if (this.worker !== w) return;
    this.worker = null;
    const l = this.laufend;
    if (!l) return;
    this.laufend = null;
    clearTimeout(l.timer);
    l.erledige(fehlerErgebnis(l.pfad, code, meldung, l.quelle?.size));
  }

  /** Inspiziert eine Datei im Worker. Wirft nie; Auftraege laufen nacheinander. */
  inspiziere(absPfad: string, opts: WorkerInspektionsOptionen = {}): Promise<AssetResult> {
    const lauf = this.kette.then(() => this.einzeln(absPfad, opts));
    this.kette = lauf.catch(() => undefined);
    return lauf;
  }

  /** Dieselbe harte Worker-Grenze für FD-gebundene Share-Quellen. */
  inspiziereQuelle(quelle: AssetSource, opts: WorkerInspektionsOptionen = {}): Promise<AssetResult> {
    const lauf = this.kette.then(() => this.einzeln(quelle.filePath, opts, quelle));
    this.kette = lauf.catch(() => undefined);
    return lauf;
  }

  private einzeln(absPfad: string, opts: WorkerInspektionsOptionen, quelle?: AssetSource): Promise<AssetResult> {
    if (this.beendet) return Promise.resolve(fehlerErgebnis(absPfad, 'worker_beendet', 'Asset-Worker wurde beendet.', quelle?.size));
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : STANDARD_GRENZEN.timeoutMs;
    const gnade = opts.gnadenfristMs !== undefined && opts.gnadenfristMs >= 0 ? opts.gnadenfristMs : WORKER_GNADENFRIST_MS;
    return new Promise<AssetResult>((resolve) => {
      let w: Worker;
      try {
        w = this.worker ?? (this.worker = this.starte());
      } catch (e) {
        resolve(fehlerErgebnis(absPfad, 'worker_fehler', `Worker nicht startbar: ${(e as Error).message}`, quelle?.size));
        return;
      }
      const id = this.naechsteId++;
      const timer = setTimeout(() => {
        if (!this.laufend || this.laufend.id !== id) return;
        this.laufend = null;
        this.abgebrochen++;
        if (this.worker === w) this.worker = null;
        void w.terminate().catch(() => undefined);
        console.error(`[Asset-Intel] Worker nach ${timeoutMs + gnade} ms hart beendet: ${absPfad}`);
        resolve(fehlerErgebnis(absPfad, 'worker_abgebrochen', `Inspektion nach ${timeoutMs} ms + ${gnade} ms Gnadenfrist hart abgebrochen (Inspektor haengt).`, quelle?.size));
      }, timeoutMs + gnade);
      this.laufend = { id, pfad: absPfad, erledige: resolve, timer, quelle };
      w.ref();
      const auftrag: Auftrag = { id, pfad: absPfad, timeoutMs, ...(quelle ? { quelle: { size: quelle.size } } : {}), ...(opts.grenzen ? { grenzen: opts.grenzen } : {}), ...(opts.registryModul ? { registryModul: opts.registryModul } : {}) };
      w.postMessage(auftrag);
    });
  }

  /** Beendet den Worker; spaetere Auftraege liefern sofort ein Fehlerergebnis. */
  async beende(): Promise<void> {
    this.beendet = true;
    const w = this.worker;
    this.worker = null;
    if (this.laufend) {
      const l = this.laufend;
      this.laufend = null;
      clearTimeout(l.timer);
      l.erledige(fehlerErgebnis(l.pfad, 'worker_beendet', 'Asset-Worker wurde beendet.', l.quelle?.size));
    }
    if (w) await w.terminate().catch(() => undefined);
  }
}
