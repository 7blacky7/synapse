/**
 * MODUL: Parser Worker Pool
 * ZWECK: Verteilt Parse-Calls auf N node:worker_threads Worker, off-thread.
 *
 * PROTOKOLL (siehe worker-runner.ts):
 *   In:  { filePath, fileType, content }
 *   Out: { ok: true; result: ParseResult | null } | { ok: false; error: string }
 *
 * VERHALTEN:
 *   - size via PARSER_WORKER_THREADS (Default 4).
 *   - PARSER_WORKER_THREADS === '0'  =>  Pool deaktiviert: getParserPool() => null.
 *   - parse(): findet freien Worker oder queued; ein Worker bearbeitet
 *     zu einem Zeitpunkt genau einen Request.
 *   - Fehlerhafte Worker (error/exit) werden bis zu MAX_RETRIES neu gespawned.
 */

import { Worker } from 'node:worker_threads';
import type { ParseResult } from './types.js';

export interface ParseArgs {
  filePath: string;
  fileType: string;
  content: string;
}

type WorkerResponse =
  | { ok: true; result: ParseResult | null }
  | { ok: false; error: string };

interface PendingResolver {
  resolve: (result: ParseResult | null) => void;
  reject: (err: Error) => void;
}

interface QueueItem {
  args: ParseArgs;
  resolver: PendingResolver;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  current: PendingResolver | null;
  retries: number;
  timer: NodeJS.Timeout | null;
}

const MAX_RETRIES = 3;

/**
 * Fehler der Reissleine: der Parse einer Datei wurde hart abgebrochen.
 * Der Aufrufer MUSS diesen Fall von einem normalen Pool-Fehler unterscheiden —
 * ein Fallback auf parser.parse() im Main-Thread wuerde den Prozess sicher
 * aufhaengen, denn genau dort kommt der Parse ja nicht zurueck.
 */
export class ParseTimeoutError extends Error {
  readonly filePath: string;
  readonly limitMs: number;
  constructor(filePath: string, limitMs: number) {
    super(`Parse von ${filePath} nach ${limitMs} ms abgebrochen (Reissleine)`);
    this.name = 'ParseTimeoutError';
    this.filePath = filePath;
    this.limitMs = limitMs;
  }
}

/**
 * Zeitlimit fuer einen einzelnen Parse.
 *
 * Warum Zeit und kein Iterationszaehler: der Fehlerfall ist katastrophales
 * Backtracking innerhalb EINES regex.exec()-Aufrufs. Die Regex-Engine kehrt nie
 * zurueck, es gibt zwischen zwei Schritten nichts, was sich zaehlen liesse, und
 * JavaScript kennt keinen Interrupt fuer laufende Regexe. Abbrechen laesst sich
 * nur der Worker-Thread als Ganzes.
 *
 * Das Limit ist bewusst grosszuegig und waechst mit der Dateigroesse, damit es
 * auf einer langsamen oder ausgelasteten Maschine nicht faelschlich zuschlaegt:
 * es soll Haenger fangen, nicht langsame Rechner bestrafen.
 */
function parseTimeoutFor(contentLength: number): number {
  const ausEnv = Number(process.env.PARSER_TIMEOUT_MS);
  if (Number.isFinite(ausEnv) && ausEnv > 0) return ausEnv;
  return Math.min(30_000 + Math.floor(contentLength / 100_000) * 15_000, 180_000);
}

function workerRunnerUrl(): URL {
  // Compiled JS-Pfad neben worker-pool.js
  return new URL('./worker-runner.js', import.meta.url);
}

export class ParserWorkerPool {
  readonly size: number;
  private slots: WorkerSlot[] = [];
  private queue: QueueItem[] = [];
  private initialized = false;
  private shuttingDown = false;

  constructor(size?: number) {
    const fromEnv = Number(process.env.PARSER_WORKER_THREADS);
    const resolved = size ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4);
    this.size = Math.max(1, Math.floor(resolved));
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (let i = 0; i < this.size; i++) {
      this.spawnSlot(i);
    }
  }

  private spawnSlot(index: number, retries = 0): void {
    const worker = new Worker(workerRunnerUrl());
    const slot: WorkerSlot = {
      worker,
      busy: false,
      current: null,
      retries,
      timer: null,
    };
    this.slots[index] = slot;

    worker.on('message', (msg: WorkerResponse) => {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      const resolver = slot.current;
      slot.current = null;
      slot.busy = false;
      slot.retries = 0;
      if (resolver) {
        if (msg.ok) resolver.resolve(msg.result);
        else resolver.reject(new Error(msg.error));
      }
      this.drainQueue();
    });

    const handleFailure = (cause: unknown) => {
      if (this.shuttingDown) return;
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      const resolver = slot.current;
      slot.current = null;
      slot.busy = false;
      try { worker.terminate(); } catch { /* ignore */ }

      if (resolver) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        resolver.reject(new Error(`parser worker failed: ${msg}`));
      }

      const nextRetries = retries + 1;
      if (nextRetries > MAX_RETRIES) {
        // eslint-disable-next-line no-console
        console.error(`[parser-worker-pool] slot ${index} exceeded ${MAX_RETRIES} retries; not respawning`);
        // slot bleibt leer; drainQueue ueberspringt es
        this.slots[index] = { worker, busy: true, current: null, retries: nextRetries, timer: null };
        return;
      }
      this.spawnSlot(index, nextRetries);
      this.drainQueue();
    };

    worker.on('error', handleFailure);
    worker.on('exit', (code) => {
      if (code !== 0) handleFailure(new Error(`worker exited with code ${code}`));
    });
  }

  parse(args: ParseArgs): Promise<ParseResult | null> {
    if (!this.initialized) this.init();
    if (this.shuttingDown) {
      return Promise.reject(new Error('ParserWorkerPool is shutting down'));
    }
    return new Promise<ParseResult | null>((resolve, reject) => {
      const resolver: PendingResolver = { resolve, reject };
      const free = this.findFreeSlot();
      if (free) {
        this.dispatch(free, args, resolver);
      } else {
        this.queue.push({ args, resolver });
      }
    });
  }

  private findFreeSlot(): WorkerSlot | null {
    for (const slot of this.slots) {
      if (slot && !slot.busy && slot.retries <= MAX_RETRIES) return slot;
    }
    return null;
  }

  private dispatch(slot: WorkerSlot, args: ParseArgs, resolver: PendingResolver): void {
    slot.busy = true;
    slot.current = resolver;

    // REISSLEINE: haengt der Worker (typisch: Backtracking in einer Regex), wird
    // er hart beendet und der Slot neu aufgesetzt. Die Datei faellt aus, der Lauf
    // laeuft weiter. Ohne das blockiert eine einzige Datei den gesamten Bestand —
    // real passiert an spine_mem_pool.cpp, die deshalb zwei Monate lang mit null
    // Symbolen im Index stand, ohne dass es irgendwo aufgefallen waere.
    const index = this.slots.indexOf(slot);
    const limitMs = parseTimeoutFor(args.content.length);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const wartender = slot.current;
      slot.current = null;
      slot.busy = false;
      // eslint-disable-next-line no-console
      console.error(`[parser-worker-pool] PARSE-TIMEOUT nach ${limitMs} ms: ${args.filePath} — Worker wird beendet, Datei uebersprungen`);
      try { slot.worker.terminate(); } catch { /* ignore */ }
      if (wartender) wartender.reject(new ParseTimeoutError(args.filePath, limitMs));
      if (index >= 0 && !this.shuttingDown) this.spawnSlot(index);
      this.drainQueue();
    }, limitMs);
    // Der Timer darf den Prozess nicht am Leben halten.
    if (typeof slot.timer.unref === 'function') slot.timer.unref();

    try {
      slot.worker.postMessage(args);
    } catch (err) {
      if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
      slot.busy = false;
      slot.current = null;
      resolver.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const free = this.findFreeSlot();
      if (!free) break;
      const item = this.queue.shift()!;
      this.dispatch(free, item.args, item.resolver);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.resolver.reject(new Error('ParserWorkerPool shutting down'));
    }
    await Promise.all(
      this.slots.map(async (slot) => {
        if (!slot) return;
        if (slot.current) {
          slot.current.reject(new Error('ParserWorkerPool shutting down'));
          slot.current = null;
        }
        try {
          await slot.worker.terminate();
        } catch {
          /* ignore */
        }
      }),
    );
    this.slots = [];
    this.initialized = false;
  }
}

let singleton: ParserWorkerPool | null = null;
let singletonDisabled = false;

export function getParserPool(): ParserWorkerPool | null {
  if (process.env.PARSER_WORKER_THREADS === '0') {
    singletonDisabled = true;
    return null;
  }
  if (singletonDisabled) return null;
  if (!singleton) {
    singleton = new ParserWorkerPool();
    singleton.init();
  }
  return singleton;
}

/** Test-Hook: setzt Singleton zurueck (nur fuer Tests / Reload-Szenarien). */
export async function resetParserPool(): Promise<void> {
  if (singleton) {
    await singleton.shutdown();
    singleton = null;
  }
  singletonDisabled = false;
}
