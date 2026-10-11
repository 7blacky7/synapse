/**
 * MODUL: Syntax-Worker (P16-T4, 11.10.2026) - laeuft in einem node:worker_threads Worker.
 *
 * PROTOKOLL (siehe pool.ts):
 *   In:  { id, pruefer, inhalt, pfad }
 *   Out: { id, ok: true, meldungen: SyntaxMeldung[], ms } | { id, ok: false, error }
 *
 * Beim Start werden alle Pruefer des Katalogs einmal aufgewaermt (Bibliothek laden, JIT), damit der
 * erste echte Auftrag nicht das Budget (FEHLERPRUEFUNG_BUDGET_MS) mit dem Laden von typescript reisst.
 */

import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { katalog, prueferNachName } from './katalog.js';

interface Auftrag { id: number; pruefer: string; inhalt: string; pfad: string }

if (!parentPort) throw new Error('syntax-pruefer/worker.ts laeuft nur als worker_thread');
const port = parentPort;

// Aufwaermen ist best effort; Auftraege warten, bis es fertig ist (der Pool startet seine Reissleine erst
// mit der Meldung 'bereit', siehe pool.ts).
const aufgewaermt = Promise.allSettled(katalog().map(async (p) => (p.aufwaermen ? p.pruefe(p.aufwaermen.inhalt, p.aufwaermen.pfad) : [])));

port.on('message', async (a: Auftrag) => {
  await aufgewaermt;
  const t0 = performance.now();
  try {
    const p = prueferNachName(a.pruefer);
    if (!p) throw new Error(`unbekannter Syntaxpruefer: ${a.pruefer}`);
    const meldungen = await p.pruefe(a.inhalt, a.pfad);
    port.postMessage({ id: a.id, ok: true, meldungen, ms: performance.now() - t0 });
  } catch (err) {
    port.postMessage({ id: a.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

void aufgewaermt.then(() => port.postMessage({ bereit: true }));
