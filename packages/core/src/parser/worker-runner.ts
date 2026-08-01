/**
 * MODUL: Parser Worker Runner
 * ZWECK: Laeuft in einem node:worker_threads Worker und parst Dateien off-thread.
 *
 * PROTOKOLL:
 *   In:  { filePath: string; fileType: string; content: string }
 *   Out: { ok: true; result: ParseResult | null }  oder  { ok: false; error: string }
 *
 * DESIGN:
 *   - Kein top-level await (Kompatibilitaet mit allen Node-Versionen / ESM-Loader).
 *   - Parser-Registry wird via dynamic import geladen (".js"-Endung, ESM-Compile).
 *   - Wenn fuer den Pfad kein Parser existiert: result = null (kein Fehler).
 */

import { parentPort } from 'node:worker_threads';
import type { ParseResult } from './types.js';

interface WorkerRequest {
  filePath: string;
  fileType: string;
  content: string;
}

type WorkerResponse =
  | { ok: true; result: ParseResult | null }
  | { ok: false; error: string };

if (!parentPort) {
  throw new Error('worker-runner.ts must be run as a worker_thread (parentPort is null).');
}

const port = parentPort;

async function handle(msg: WorkerRequest): Promise<WorkerResponse> {
  try {
    const { getParserForFile } = await import('./index.js');
    const parser = getParserForFile(msg.filePath, msg.content);
    if (!parser) {
      return { ok: true, result: null };
    }
    const result = parser.parse(msg.content, msg.filePath);
    return { ok: true, result };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

port.on('message', (msg: WorkerRequest) => {
  handle(msg).then(
    (resp) => port.postMessage(resp),
    (err) => {
      const error = err instanceof Error ? err.message : String(err);
      port.postMessage({ ok: false, error } satisfies WorkerResponse);
    },
  );
});
