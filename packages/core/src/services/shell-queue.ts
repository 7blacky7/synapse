/**
 * MODUL: Shell-Queue (PostgreSQL-backed)
 * ZWECK: Queue-Service fuer REST-API ↔ FileWatcher-Daemon Shell-Exec.
 *        Jobs werden in `shell_jobs` eingereiht; PG LISTEN/NOTIFY pusht neue Jobs
 *        an den Daemon. Der Daemon claimt per SELECT FOR UPDATE SKIP LOCKED und
 *        schreibt das Ergebnis zurueck, begleitet von pg_notify('shell_job_done_<id>').
 *
 * API:
 *   - enqueueShellJob(args)       → { id, stream_id }
 *   - claimPendingShellJob(...)   → ShellJobRow | null
 *   - completeShellJob(id, res)   → void (inkl. Notify)
 *   - waitForShellJob(id, ms)     → ShellJobResult (blockiert bis done/timeout)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: INSERT/UPDATE auf shell_jobs
 *   - PG NOTIFY: Channels `shell_job_created` (statisch) und `shell_job_done_<id>`
 *     (id mit `-` → `_` fuer LISTEN-Identifier-Kompatibilitaet)
 */

import { randomUUID } from 'node:crypto';
import { getPool } from '../db/index.js';

export interface EnqueueArgs {
  project: string;
  command: string;
  cwd_relative?: string;
  timeout_ms?: number;
  tail_lines?: number;
}

export interface ShellJobRow {
  id: string;
  project: string;
  command: string;
  cwd_relative: string | null;
  timeout_ms: number;
  tail_lines: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code: number | null;
  tail: string[] | null;
  output: string | null;
  output_truncated: boolean | null;
  error: string | null;
  stream_id: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShellJobCompletion {
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code?: number;
  tail?: string[];
  error?: string;
  /** Voller stdout+stderr-Output. Wird gecappt auf MAX_OUTPUT_BYTES. */
  output?: string;
}

export interface ShellJobResult {
  id: string;
  status: ShellJobRow['status'];
  exit_code?: number;
  tail?: string[];
  error?: string;
  stream_id?: string;
}

/** Max bytes die wir in shell_jobs.output speichern. Groesseres wird truncated. */
export const MAX_OUTPUT_BYTES = 1_000_000;

/**
 * Mapped eine Job-UUID auf einen LISTEN-kompatiblen Channel-Namen.
 * PG-Channel-Identifier duerfen keine Bindestriche enthalten.
 */
function doneChannelForJob(id: string): string {
  return `shell_job_done_${id.replace(/-/g, '_')}`;
}

function formatResult(row: ShellJobRow): ShellJobResult {
  return {
    id: row.id,
    status: row.status,
    exit_code: row.exit_code ?? undefined,
    tail: row.tail ?? undefined,
    error: row.error ?? undefined,
    stream_id: row.stream_id ?? undefined,
  };
}

const TERMINAL_STATUSES: ShellJobRow['status'][] = ['done', 'failed', 'rejected', 'timeout'];

/**
 * Reiht einen Shell-Job ein. Der NOTIFY auf `shell_job_created` passiert
 * automatisch via Trigger `trg_shell_jobs_notify`.
 */
export async function enqueueShellJob(
  args: EnqueueArgs,
): Promise<{ id: string; stream_id: string }> {
  const pool = getPool();
  const streamId = randomUUID().replace(/-/g, '').slice(0, 16);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO shell_jobs (project, command, cwd_relative, timeout_ms, tail_lines, stream_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      args.project,
      args.command,
      args.cwd_relative ?? null,
      args.timeout_ms ?? 30_000,
      args.tail_lines ?? 5,
      streamId,
    ],
  );
  return { id: res.rows[0].id, stream_id: streamId };
}

/**
 * Daemon-Seite: claimt den aeltesten pending Job fuer ein Projekt atomar
 * via SELECT FOR UPDATE SKIP LOCKED. Setzt Status auf `running` und schreibt
 * `claimed_by` / `claimed_at`. Gibt die Job-Row zurueck oder `null` wenn keine
 * pending Jobs mehr existieren.
 */
export async function claimPendingShellJob(
  project: string,
  daemonId: string,
): Promise<ShellJobRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<ShellJobRow>(
      `SELECT * FROM shell_jobs
       WHERE project = $1
         AND status = 'pending'
         AND created_at > NOW() - interval '30 seconds'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [project],
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const job = res.rows[0];
    const upd = await client.query<ShellJobRow>(
      `UPDATE shell_jobs
       SET status = 'running', claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [daemonId, job.id],
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Schreibt Ergebnis eines Jobs und feuert pg_notify('shell_job_done_<id>').
 * Der Channel-Name wird auf LISTEN-kompatibles Format gemappt (`-` → `_`).
 */
export async function completeShellJob(
  id: string,
  result: ShellJobCompletion,
): Promise<void> {
  const pool = getPool();
  // Output cappen — sehr grosse Logs sprengen die JSON-Response der KI-Tools.
  // Bei Bedarf kann der File-Fallback die volle Groesse liefern.
  let output = result.output ?? null;
  let truncated = false;
  if (output !== null && output.length > MAX_OUTPUT_BYTES) {
    output =
      output.slice(0, MAX_OUTPUT_BYTES) +
      `\n\n[... output truncated at ${MAX_OUTPUT_BYTES} bytes — full log via stream_id ...]`;
    truncated = true;
  }
  await pool.query(
    `UPDATE shell_jobs
     SET status = $2,
         exit_code = $3,
         tail = $4::jsonb,
         error = $5,
         output = $6,
         output_truncated = $7,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      result.status,
      result.exit_code ?? null,
      result.tail ? JSON.stringify(result.tail) : null,
      result.error ?? null,
      output,
      truncated,
    ],
  );
  const channel = doneChannelForJob(id);
  // pg_notify akzeptiert beliebige Strings als Channel — sicherer Weg via Parameter.
  await pool.query(`SELECT pg_notify($1, $2)`, [channel, result.status]);
}

/**
 * REST-API-Seite: blockiert bis der Job einen terminalen Status erreicht oder
 * der Timeout ablaeuft. Nutzt PostgreSQL LISTEN/NOTIFY; initial wird der DB-
 * Zustand abgefragt (falls der Job bereits fertig ist bevor wir lauschen).
 */
export async function waitForShellJob(
  id: string,
  timeoutMs: number = 35_000,
): Promise<ShellJobResult> {
  const pool = getPool();
  const client = await pool.connect();
  const channel = doneChannelForJob(id);
  let notificationHandler: ((msg: { channel: string; payload?: string }) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const fetchFinal = async (): Promise<ShellJobResult> => {
    const r = await pool.query<ShellJobRow>(
      `SELECT * FROM shell_jobs WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) {
      throw new Error(`Shell-Job ${id} nicht gefunden`);
    }
    return formatResult(r.rows[0]);
  };

  try {
    await client.query(`LISTEN "${channel}"`);

    // Race-Schutz: Job koennte bereits fertig sein bevor LISTEN aktiv wurde.
    const initial = await client.query<ShellJobRow>(
      `SELECT * FROM shell_jobs WHERE id = $1`,
      [id],
    );
    if (initial.rows.length === 0) {
      throw new Error(`Shell-Job ${id} nicht gefunden`);
    }
    if (TERMINAL_STATUSES.includes(initial.rows[0].status)) {
      return formatResult(initial.rows[0]);
    }

    return await new Promise<ShellJobResult>((resolve, reject) => {
      timer = setTimeout(() => {
        if (notificationHandler) {
          client.removeListener('notification', notificationHandler);
          notificationHandler = null;
        }
        // Timeout ueberschritten — aktuellen Stand aus DB zurueckgeben.
        fetchFinal().then(resolve).catch(reject);
      }, timeoutMs);

      notificationHandler = (msg) => {
        if (msg.channel !== channel) return;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (notificationHandler) {
          client.removeListener('notification', notificationHandler);
          notificationHandler = null;
        }
        fetchFinal().then(resolve).catch(reject);
      };
      client.on('notification', notificationHandler);
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (notificationHandler) {
      client.removeListener('notification', notificationHandler);
    }
    try {
      await client.query(`UNLISTEN "${channel}"`);
    } catch {
      /* best effort */
    }
    client.release();
  }
}

/**
 * Setzt alle pending Jobs die aelter als `maxAgeSec` Sekunden sind auf
 * `rejected` (Default: 30s). NOTIFY wird fuer jeden Job gefeuert damit
 * wartende `waitForShellJob`-Calls aufwachen.
 *
 * Sicherheit: Verhindert dass Jobs die eingereiht wurden als das Projekt
 * inaktiv war, spaeter automatisch ausgefuehrt werden wenn das Projekt
 * wieder aktiv wird.
 */
/**
 * History-Lookup: liefert die letzten N Jobs eines Projekts (oder ueber alle
 * Projekte falls project=undefined). Sortiert nach created_at DESC.
 *
 * Returnt KEIN output-Feld — die Liste soll klein bleiben. Fuer den vollen
 * Output ein einzelnes `getShellJobById` aufrufen.
 */
export async function getShellJobs(opts: {
  project?: string;
  limit?: number;
  offset?: number;
  status?: ShellJobRow['status'];
}): Promise<Array<Omit<ShellJobRow, 'output'>>> {
  const pool = getPool();
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.project) { params.push(opts.project); conditions.push(`project = $${params.length}`); }
  if (opts.status)  { params.push(opts.status);  conditions.push(`status = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await pool.query<Omit<ShellJobRow, 'output'>>(
    `SELECT id, project, command, cwd_relative, timeout_ms, tail_lines,
            status, exit_code, tail, error, output_truncated, stream_id,
            claimed_by, claimed_at, completed_at, created_at, updated_at
     FROM shell_jobs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/**
 * Holt einen einzelnen Job inklusive vollem Output (falls vorhanden).
 * Fuer das Detail-Lookup einer KI nach `history`.
 */
export async function getShellJobById(id: string): Promise<ShellJobRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<ShellJobRow>(
    `SELECT * FROM shell_jobs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function expirePendingShellJobs(maxAgeSec: number = 30): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE shell_jobs
     SET status = 'rejected',
         error = 'expired — Projekt war zu lange nicht aktiv (max ' || $1::text || 's Grace-Window)',
         completed_at = NOW(),
         updated_at = NOW()
     WHERE status = 'pending'
       AND created_at < NOW() - ($1::integer * interval '1 second')
     RETURNING id`,
    [maxAgeSec],
  );
  for (const row of res.rows) {
    await pool.query(`SELECT pg_notify($1, $2)`, [doneChannelForJob(row.id), 'rejected']);
  }
  return res.rows.length;
}

