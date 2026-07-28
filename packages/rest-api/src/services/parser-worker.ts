/**
 * MODUL: ParserWorker
 * ZWECK: Server-seitiges Background-Parsing fuer Files die via REST/Web-KI in
 *        code_files landen. Schliesst die Luecke, wenn KEIN lokaler FileWatcher-
 *        Daemon laeuft — sonst wuerde code_intel (symbols, statements, ...) auf
 *        neue Files nichts zeigen.
 *
 * INPUT:  intervalMs (Default 30s), enabled-Flag
 * OUTPUT: ruft parseUnparsedFiles(project) fuer alle Projekte mit offenem
 *         Backlog — welche das sind, beantwortet projekteMitBacklog() in core.
 *         Optional: konsumiert project-init-queue Jobs (TODO Phase B).
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: SELECT auf code_files, parseAndEmbed-Aufrufe (DELETE+INSERT
 *     auf code_symbols/code_references/code_statements/code_call_edges/code_chunks)
 *   - Optional Embeddings (wenn SYNAPSE_SKIP_EMBEDDINGS nicht gesetzt)
 *
 * RACE-SAFETY: parseAndEmbed hat pg_advisory_xact_lock pro File → parallele
 *   Aufrufe (z.B. lokaler Daemon + dieser Worker) werden serialisiert, keine
 *   Duplikate. Bedeutet: dieser Worker kann auch laufen wenn ein lokaler
 *   Daemon existiert — Doppel-Arbeit, aber kein Schaden.
 */

import { parseUnparsedFiles, projekteMitBacklog, expirePendingProjectInitJobs } from '@synapse/core';

export interface ParserWorkerConfig {
  intervalMs?: number;       // default 30_000
  maxPerTick?: number;       // max Projekte pro Tick (Default 20, schuetzt vor Spitzenlast)
}

const DEFAULTS = {
  intervalMs: 30_000,
  maxPerTick: 20,
};

export class ParserWorker {
  private cfg: Required<ParserWorkerConfig>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;          // Re-Entrancy-Schutz
  private ticksDone = 0;
  private filesDone = 0;

  constructor(cfg: ParserWorkerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...cfg } as Required<ParserWorkerConfig>;
  }

  init(): void {
    if (this.timer) return;
    console.error(
      `[parser-worker] aktiv (interval=${this.cfg.intervalMs}ms, maxPerTick=${this.cfg.maxPerTick})`
    );
    // Erster Tick gleich nach 2s (nicht beim Boot, damit Schema/Init durch sind).
    setTimeout(() => this.fire(), 2_000);
    this.timer = setInterval(() => this.fire(), this.cfg.intervalMs);
  }

  shutdown(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  getStats(): { ticksDone: number; filesDone: number; running: boolean } {
    return { ticksDone: this.ticksDone, filesDone: this.filesDone, running: this.running };
  }

  private fire(): void {
    if (this.running) return;       // vorheriger Tick noch aktiv → ueberspringen
    this.running = true;
    this.tick()
      .catch(err => console.error(`[parser-worker] tick error: ${(err as Error).message}`))
      .finally(() => { this.running = false; });
  }

  private async tick(): Promise<void> {
    this.ticksDone++;

    // WELCHE PROJEKTE FAELLIG SIND, ENTSCHEIDET CORE — nicht dieser Worker.
    // Hier stand bis zum 28.07.2026 eine eigene Query, die nur parsed_at und
    // indexed_at kannte. Ein Projekt, dessen Dateien ausschliesslich VERALTET
    // waren (Parser-Version erhoeht, Inhalt unveraendert), tauchte darin nie auf.
    // parseUnparsedFiles kannte den Fall bereits, wurde fuer solche Projekte aber
    // nie gerufen — der Nachziehmechanismus war dadurch wirkungslos, obwohl beide
    // Haelften einzeln richtig aussahen. Eine zweite Formulierung derselben Regel
    // laeuft frueher oder spaeter wieder auseinander; deshalb genau eine.
    // Der Registry- und enabled-Guard steckt ebenfalls in projekteMitBacklog().
    const projekte = await projekteMitBacklog(this.cfg.maxPerTick);

    if (projekte.length === 0) {
      // Stale init-jobs aufraeumen (15 Min-Cutoff) — kostet nichts wenn nichts da.
      await expirePendingProjectInitJobs(900).catch(() => 0);
      return;
    }

    for (const row of projekte) {
      try {
        const n = await parseUnparsedFiles(row.project);
        if (n > 0) {
          this.filesDone += n;
          console.error(`[parser-worker] ${row.project}: ${n} files geparst (Backlog war ${row.faellig})`);
        }
      } catch (err) {
        console.error(`[parser-worker] ${row.project} fehlgeschlagen: ${(err as Error).message}`);
      }
    }
  }
}

// ─── Singleton fuer Server-Lifecycle ─────────────────────────────────────────
let _instance: ParserWorker | null = null;

export function initParserWorker(cfg?: ParserWorkerConfig): ParserWorker {
  if (_instance) return _instance;
  _instance = new ParserWorker(cfg);
  _instance.init();
  return _instance;
}

export function getParserWorker(): ParserWorker | null {
  return _instance;
}

export function shutdownParserWorker(): void {
  if (_instance) { _instance.shutdown(); _instance = null; }
}
