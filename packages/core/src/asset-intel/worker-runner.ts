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
import type { AssetResult } from './types.js';

/** Zeit, die ein Worker ueber timeoutMs hinaus bekommt, bevor er hart beendet wird. */
export const WORKER_GNADENFRIST_MS = 5000;

const WORKER_MARKE = 'synapse-asset-intel-worker';

interface Auftrag {
  id: number;
  pfad: string;
  timeoutMs?: number;
  /** Modul (Pfad oder file:-URL) mit Export `registry` — nur fuer Tests. */
  registryModul?: string;
}

type Antwort = { id: number; ok: true; ergebnis: AssetResult } | { id: number; ok: false; fehler: string };

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
    const ergebnis = await asset.inspectAsset(a.pfad, {
      ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}),
      ...(registry ? { registry } : {}),
    });
    return { id: a.id, ok: true, ergebnis };
  } catch (e) {
    return { id: a.id, ok: false, fehler: e instanceof Error ? e.message : String(e) };
  }
}

if (!isMainThread && parentPort && (workerData as { marke?: string } | null)?.marke === WORKER_MARKE) {
  const port = parentPort;
  port.on('message', (a: Auftrag) => {
    void bearbeite(a).then((antwort) => {
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
}

function fehlerErgebnis(pfad: string, code: string, meldung: string): AssetResult {
  let groesse = 0;
  try {
    groesse = fs.statSync(pfad).size;
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
    w.on('message', (a: Antwort) => {
      const l = this.laufend;
      if (!l || l.id !== a.id) return;
      this.laufend = null;
      clearTimeout(l.timer);
      w.unref();
      l.erledige(a.ok ? a.ergebnis : fehlerErgebnis(l.pfad, 'worker_fehler', `Worker-Fehler: ${a.fehler}`));
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
    l.erledige(fehlerErgebnis(l.pfad, code, meldung));
  }

  /** Inspiziert eine Datei im Worker. Wirft nie; Auftraege laufen nacheinander. */
  inspiziere(absPfad: string, opts: WorkerInspektionsOptionen = {}): Promise<AssetResult> {
    const lauf = this.kette.then(() => this.einzeln(absPfad, opts));
    this.kette = lauf.catch(() => undefined);
    return lauf;
  }

  private einzeln(absPfad: string, opts: WorkerInspektionsOptionen): Promise<AssetResult> {
    if (this.beendet) return Promise.resolve(fehlerErgebnis(absPfad, 'worker_beendet', 'Asset-Worker wurde beendet.'));
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : STANDARD_GRENZEN.timeoutMs;
    const gnade = opts.gnadenfristMs !== undefined && opts.gnadenfristMs >= 0 ? opts.gnadenfristMs : WORKER_GNADENFRIST_MS;
    return new Promise<AssetResult>((resolve) => {
      let w: Worker;
      try {
        w = this.worker ?? (this.worker = this.starte());
      } catch (e) {
        resolve(fehlerErgebnis(absPfad, 'worker_fehler', `Worker nicht startbar: ${(e as Error).message}`));
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
        resolve(fehlerErgebnis(absPfad, 'worker_abgebrochen', `Inspektion nach ${timeoutMs} ms + ${gnade} ms Gnadenfrist hart abgebrochen (Inspektor haengt).`));
      }, timeoutMs + gnade);
      this.laufend = { id, pfad: absPfad, erledige: resolve, timer };
      w.ref();
      const auftrag: Auftrag = { id, pfad: absPfad, timeoutMs, ...(opts.registryModul ? { registryModul: opts.registryModul } : {}) };
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
      l.erledige(fehlerErgebnis(l.pfad, 'worker_beendet', 'Asset-Worker wurde beendet.'));
    }
    if (w) await w.terminate().catch(() => undefined);
  }
}
