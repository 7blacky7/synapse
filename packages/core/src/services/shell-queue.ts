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
}

export interface ShellJobResult {
  id: string;
  status: ShellJobRow['status'];
  exit_code?: number;
  tail?: string[];
  error?: string;
  stream_id?: string;
}

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
       WHERE project = $1 AND status = 'pending'
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
  await pool.query(
    `UPDATE shell_jobs
     SET status = $2,
         exit_code = $3,
         tail = $4::jsonb,
         error = $5,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      result.status,
      result.exit_code ?? null,
      result.tail ? JSON.stringify(result.tail) : null,
      result.error ?? null,
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
