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
}

const MAX_RETRIES = 3;

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
    };
    this.slots[index] = slot;

    worker.on('message', (msg: WorkerResponse) => {
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
        this.slots[index] = { worker, busy: true, current: null, retries: nextRetries };
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
    try {
      slot.worker.postMessage(args);
    } catch (err) {
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
