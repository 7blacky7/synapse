/**
 * MODUL: Standard-Syntaxpruefer Stufe 1 anmelden (P16-T4, 11.10.2026)
 *
 * registriereStandardSyntaxPruefer() meldet jeden Pruefer aus katalog.ts ueber registriereSyntaxPruefer()
 * (fehlermuster-pruefung.ts) an. Die eigentliche Pruefung laeuft im Syntax-Worker-Pool (pool.ts); mit
 * SYNTAX_WORKER_THREADS=0 im Haupt-Thread. Der Pool startet beim Anmelden, damit die Worker die
 * Bibliotheken schon geladen haben, wenn der erste Schreibvorgang kommt.
 *
 * Aufruf beim Start jedes Prozesses, der Dateien schreibt (REST-API, MCP stdio). Mehrfacher Aufruf
 * ist harmlos (gleichnamige Pruefer werden ersetzt, der Pool bleibt derselbe).
 * Notaus: SYNTAXPRUEFUNG=0 (nichts wird angemeldet).
 * Worker-Zahl (P16-T9): SYNTAX_WORKER_THREADS vor opt.threads vor 2, begrenzt 1..min(8, Kerne); Logzeile beim Start.
 */

import { registriereSyntaxPruefer, type SyntaxMeldung } from '../fehlermuster-pruefung.js';
import { katalog, paketVersion, type PrueferDefinition } from './katalog.js';
import { SyntaxWorkerPool, syntaxWorkerZahl } from './pool.js';

export {
  SyntaxWorkerPool,
  SyntaxPrueferTimeout,
  SyntaxPoolNichtVerfuegbar,
  syntaxWorkerZahl,
  syntaxWorkerObergrenze,
  SYNTAX_WORKER_STANDARD,
  SYNTAX_WORKER_HOECHSTENS,
  type SyntaxWorkerWahl,
} from './pool.js';
export { PRUEFER_KATALOG, katalog as syntaxPrueferKatalog, type PrueferDefinition } from './katalog.js';

let pool: SyntaxWorkerPool | null = null;

function poolAn(): boolean {
  return process.env.SYNTAX_WORKER_THREADS !== '0';
}

let poolGroesse: number | undefined;
let hauptThreadGemeldet = false;

function holePool(): SyntaxWorkerPool {
  // SYNTAX_WORKER_THREADS (Env) geht vor der Vorgabe des Aufrufers; Grenzen und Hinweise: syntaxWorkerZahl (pool.ts).
  if (!pool) {
    const wahl = syntaxWorkerZahl(poolGroesse);
    pool = new SyntaxWorkerPool(wahl.anzahl);
    const quelle = wahl.quelle === 'env' ? 'SYNTAX_WORKER_THREADS' : wahl.quelle === 'vorgabe' ? 'Vorgabe des Prozesses' : 'Standard';
    // stderr: im MCP-stdio-Prozess gehoert stdout dem Protokoll.
    console.error(`[syntax-pool] gestartet: ${pool.size} Worker (${quelle})${wahl.hinweis ? ` - ${wahl.hinweis}` : ''}`);
  }
  return pool;
}

function pruefeMit(def: PrueferDefinition): (inhalt: string, pfad: string) => SyntaxMeldung[] | Promise<SyntaxMeldung[]> {
  return (inhalt, pfad) => (poolAn() ? holePool().pruefe(def.name, inhalt, pfad) : def.pruefe(inhalt, pfad));
}

/**
 * Meldet alle Stufe-1-Pruefer an. Rueckgabe: angemeldete Namen (leer bei SYNTAXPRUEFUNG=0).
 * opt.threads: Poolgroesse, wenn SYNTAX_WORKER_THREADS nicht gesetzt ist (API ohne Angabe = Standard 2, MCP stdio 1);
 * begrenzt wie syntaxWorkerZahl. Beim Start des Pools steht eine Logzeile '[syntax-pool] gestartet: N Worker (...)'
 * auf stderr.
 */
export function registriereStandardSyntaxPruefer(opt: { threads?: number } = {}): string[] {
  if (process.env.SYNTAXPRUEFUNG === '0') return [];
  if (opt.threads !== undefined && !pool) poolGroesse = opt.threads;
  const namen: string[] = [];
  for (const def of katalog()) {
    registriereSyntaxPruefer({
      name: def.name,
      version: def.version ?? paketVersion(def.paket),
      endungen: def.endungen,
      ...(def.dateinamen ? { dateinamen: def.dateinamen } : {}),
      sperrfaehig: def.sperrfaehig,
      pruefe: pruefeMit(def),
    });
    namen.push(def.name);
  }
  if (poolAn()) holePool();
  else if (!hauptThreadGemeldet) {
    hauptThreadGemeldet = true;
    console.error('[syntax-pool] kein Pool (SYNTAX_WORKER_THREADS=0): Syntaxpruefung im Haupt-Thread');
  }
  return namen;
}

/** Diagnose: Zustand des Syntax-Pools (null = kein Pool aktiv). */
export function syntaxPoolZustand(): Record<string, unknown> | null {
  return pool ? pool.zustand() : null;
}

/** Pool beenden (Tests, geordnetes Herunterfahren). */
export async function beendeSyntaxPool(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.beenden();
}
