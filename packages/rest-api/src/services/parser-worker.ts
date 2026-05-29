/**
 * MODUL: ParserWorker
 * ZWECK: Server-seitiges Background-Parsing fuer Files die via REST/Web-KI in
 *        code_files landen. Schliesst die Luecke, wenn KEIN lokaler FileWatcher-
 *        Daemon laeuft — sonst wuerde code_intel (symbols, statements, ...) auf
 *        neue Files nichts zeigen.
 *
 * INPUT:  intervalMs (Default 30s), enabled-Flag
 * OUTPUT: ruft parseUnparsedFiles(project) fuer alle Projekte mit unembedded
 *         Backlog. Optional: konsumiert project-init-queue Jobs (TODO Phase B).
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

import { getPool, parseUnparsedFiles, expirePendingProjectInitJobs } from '@synapse/core';

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
    const pool = getPool();

    // Projekte mit unparsed Files (content vorhanden, parsed_at NULL).
    // GUARD: Nur Projekte verarbeiten, die in der projects-Registry stehen
    // UND enabled sind. Sonst werden (a) verwaiste code_files-Leichen (z.B. ein
    // versehentlich als Projekt initialisiertes Home-Verzeichnis) oder (b) im
    // Tray/Daemon deaktivierte Projekte weiter geparst & embedded. Das enabled-Flag
    // wird vom Daemon via setProjectEnabled() server-seitig gespiegelt.
    const r = await pool.query(
      `SELECT cf.project, count(*)::int unparsed
         FROM code_files cf
        WHERE cf.content IS NOT NULL AND cf.parsed_at IS NULL
          AND EXISTS (SELECT 1 FROM projects p WHERE p.name = cf.project AND p.enabled)
        GROUP BY cf.project
        ORDER BY unparsed DESC
        LIMIT $1`,
      [this.cfg.maxPerTick]
    );

    if (r.rows.length === 0) {
      // Stale init-jobs aufraeumen (15 Min-Cutoff) — kostet nichts wenn nichts da.
      await expirePendingProjectInitJobs(900).catch(() => 0);
      return;
    }

    for (const row of r.rows) {
      try {
        const n = await parseUnparsedFiles(row.project);
        if (n > 0) {
          this.filesDone += n;
          console.error(`[parser-worker] ${row.project}: ${n} files geparst (Backlog war ${row.unparsed})`);
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
