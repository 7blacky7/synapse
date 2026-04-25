/**
 * MODUL: Specialist-Queue (PostgreSQL-backed)
 * ZWECK: Queue-Service fuer REST-API ↔ FileWatcher-Daemon Specialist-Calls.
 *        Web-KIs (REST) koennen Spezialisten auf dem User-Host spawnen wo
 *        Claude-CLI + Projekt-FS liegen — nicht im Docker-Container der REST.
 *
 * API:
 *   - enqueueSpecialistJob(args)          → { id }
 *   - claimPendingSpecialistJob(...)      → SpecialistJobRow | null
 *   - completeSpecialistJob(id, res)      → void (inkl. NOTIFY)
 *   - waitForSpecialistJob(id, ms)        → SpecialistJobResult
 *   - expirePendingSpecialistJobs(maxSec) → number
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: INSERT/UPDATE auf specialist_jobs
 *   - PG NOTIFY: 'specialist_job_created' (Trigger) + 'specialist_job_done_<id>'
 */

import { getPool } from '../db/index.js';

export type SpecialistAction =
  | 'spawn'
  | 'spawn_batch'
  | 'stop'
  | 'purge'
  | 'wake'
  | 'update_skill';

export interface SpecialistJobRow {
  id: string;
  project: string;
  action: SpecialistAction;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout';
  result: Record<string, unknown> | null;
  error: string | null;
  message: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SpecialistJobCompletion {
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

export interface SpecialistJobResult {
  id: string;
  status: SpecialistJobRow['status'];
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

const TERMINAL_STATUSES: SpecialistJobRow['status'][] = ['done', 'failed', 'rejected', 'timeout'];

function doneChannelForJob(id: string): string {
  return `specialist_job_done_${id.replace(/-/g, '_')}`;
}

function formatResult(row: SpecialistJobRow): SpecialistJobResult {
  return {
    id: row.id,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    message: row.message ?? undefined,
  };
}

/**
 * Reiht einen Specialist-Job ein. NOTIFY auf 'specialist_job_created' kommt
 * automatisch via Trigger.
 */
export async function enqueueSpecialistJob(args: {
  project: string;
  action: SpecialistAction;
  args: Record<string, unknown>;
}): Promise<{ id: string }> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specialist_jobs (project, action, args)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [args.project, args.action, JSON.stringify(args.args)],
  );
  return { id: res.rows[0].id };
}

/**
 * Daemon-Seite: claimt aeltesten pending Job atomar via SELECT FOR UPDATE
 * SKIP LOCKED. Nur Jobs juenger als 30s — sonst expired.
 */
export async function claimPendingSpecialistJob(
  project: string,
  daemonId: string,
): Promise<SpecialistJobRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<SpecialistJobRow>(
      `SELECT * FROM specialist_jobs
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
    const upd = await client.query<SpecialistJobRow>(
      `UPDATE specialist_jobs
       SET status = 'running', claimed_by = $1, claimed_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [daemonId, job.id],
    );
    await client.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Schreibt Ergebnis und feuert pg_notify('specialist_job_done_<id>').
 */
export async function completeSpecialistJob(
  id: string,
  completion: SpecialistJobCompletion,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE specialist_jobs
     SET status = $2,
         result = $3::jsonb,
         error = $4,
         message = $5,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      completion.status,
      completion.result ? JSON.stringify(completion.result) : null,
      completion.error ?? null,
      completion.message ?? null,
    ],
  );
  await pool.query(`SELECT pg_notify($1, $2)`, [doneChannelForJob(id), completion.status]);
}

/**
 * REST-API-Seite: blockiert bis terminal status oder timeout.
 */
export async function waitForSpecialistJob(
  id: string,
  timeoutMs: number = 60_000,
): Promise<SpecialistJobResult> {
  const pool = getPool();
  const client = await pool.connect();
  const channel = doneChannelForJob(id);
  let notificationHandler: ((msg: { channel: string; payload?: string }) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const fetchFinal = async (): Promise<SpecialistJobResult> => {
    const r = await pool.query<SpecialistJobRow>(`SELECT * FROM specialist_jobs WHERE id = $1`, [id]);
    if (r.rows.length === 0) throw new Error(`Specialist-Job ${id} nicht gefunden`);
    return formatResult(r.rows[0]);
  };

  try {
    await client.query(`LISTEN "${channel}"`);

    const initial = await client.query<SpecialistJobRow>(
      `SELECT * FROM specialist_jobs WHERE id = $1`,
      [id],
    );
    if (initial.rows.length === 0) throw new Error(`Specialist-Job ${id} nicht gefunden`);
    if (TERMINAL_STATUSES.includes(initial.rows[0].status)) {
      return formatResult(initial.rows[0]);
    }

    return await new Promise<SpecialistJobResult>((resolve, reject) => {
      timer = setTimeout(() => {
        if (notificationHandler) {
          client.removeListener('notification', notificationHandler);
          notificationHandler = null;
        }
        fetchFinal().then(resolve).catch(reject);
      }, timeoutMs);

      notificationHandler = (msg) => {
        if (msg.channel !== channel) return;
        if (timer) { clearTimeout(timer); timer = null; }
        if (notificationHandler) {
          client.removeListener('notification', notificationHandler);
          notificationHandler = null;
        }
        fetchFinal().then(resolve).catch(reject);
      };
      client.on('notification', notificationHandler);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (notificationHandler) client.removeListener('notification', notificationHandler);
    try { await client.query(`UNLISTEN "${channel}"`); } catch { /* best effort */ }
    client.release();
  }
}

/**
 * Setzt alte pending Jobs auf 'rejected' (Default 30s).
 * Verhindert dass Jobs aus inaktiven Projekten spaeter ausgefuehrt werden.
 */
export async function expirePendingSpecialistJobs(maxAgeSec: number = 30): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE specialist_jobs
     SET status = 'rejected',
         error = 'expired',
         message = 'Job verworfen — Projekt war laenger als ' || $1::text || 's nicht aktiv. Aktiviere im Tray und sende erneut.',
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
