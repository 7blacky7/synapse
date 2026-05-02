/**
 * MODUL: project-init-queue.ts
 *
 * ZWECK: Queue fuer Self-Service Project-Init durch Web-KIs (REST). Eine Web-KI
 *        ruft `project(action: "init", name: "neu")` ohne Pfad — REST schreibt
 *        einen Job in `project_init_jobs`, der lokale FileWatcher-Daemon
 *        nimmt ihn auf, resolved den Pfad gegen `SYNAPSE_WORKSPACE_ROOT`,
 *        legt den Ordner an, registriert das Projekt in der `projects`-Tabelle
 *        und startet ggf. den FileWatcher.
 *
 * ERROR-SEMANTIK:
 *   - rejected = Validierungsfehler (illegal name, Projekt existiert schon)
 *   - failed   = Daemon-Fehler beim Anlegen (mkdir/git/registerProject)
 *   - timeout  = Job wartete zu lange auf Daemon (Watcher down)
 *   - done     = Erfolg, resolved_path ist gesetzt
 */

import { getPool } from '../db/client.js';

export type ProjectInitStatus = 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout';

export interface ProjectInitJobRow {
  id: string;
  name: string;
  hostname: string | null;
  template: string | null;
  requested_by: string | null;
  status: ProjectInitStatus;
  resolved_path: string | null;
  error: string | null;
  message: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectInitCompletion {
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  resolved_path?: string;
  error?: string;
  message?: string;
}

/** Validiert Projekt-Namen (kein Path-Traversal, keine Sonderzeichen). */
export function isValidProjectName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(name);
}

const TERMINAL_STATUSES: ProjectInitStatus[] = ['done', 'failed', 'rejected', 'timeout'];

function doneChannelForJob(id: string): string {
  return `project_init_done_${id.replace(/-/g, '_')}`;
}

/** Reiht einen Project-Init-Job ein. NOTIFY laeuft via Trigger automatisch. */
export async function enqueueProjectInitJob(args: {
  name: string;
  hostname?: string;
  template?: string;
  requested_by?: string;
}): Promise<{ id: string }> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO project_init_jobs (name, hostname, template, requested_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [args.name, args.hostname ?? null, args.template ?? null, args.requested_by ?? null],
  );
  return { id: res.rows[0].id };
}

/**
 * Daemon-Seite: claimt den aeltesten pending Job atomar.
 * Filter: nur Jobs ohne hostname-Vorgabe ODER mit Match auf den eigenen Hostname.
 * Aelter als 30s = ueberspringen (gilt als timeout via expirePending).
 */
export async function claimPendingProjectInitJob(
  daemonId: string,
  hostname: string,
): Promise<ProjectInitJobRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<ProjectInitJobRow>(
      `SELECT * FROM project_init_jobs
       WHERE status = 'pending'
         AND (hostname IS NULL OR hostname = $1)
         AND created_at > NOW() - interval '30 seconds'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [hostname],
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const job = res.rows[0];
    const upd = await client.query<ProjectInitJobRow>(
      `UPDATE project_init_jobs
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

/** Schreibt Ergebnis und feuert pg_notify('project_init_done_<id>'). */
export async function completeProjectInitJob(
  id: string,
  result: ProjectInitCompletion,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE project_init_jobs
     SET status = $2,
         resolved_path = $3,
         error = $4,
         message = $5,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      result.status,
      result.resolved_path ?? null,
      result.error ?? null,
      result.message ?? null,
    ],
  );
  const channel = doneChannelForJob(id);
  await pool.query(`SELECT pg_notify($1, $2)`, [channel, result.status]);
}

/** Setzt Jobs aelter als maxAgeSec auf timeout (Daemon down / nicht erreichbar). */
export async function expirePendingProjectInitJobs(maxAgeSec: number = 30): Promise<number> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `UPDATE project_init_jobs
     SET status = 'timeout',
         error = 'Daemon hat den Job nicht abgeholt — Watcher laeuft moeglicherweise nicht.',
         message = 'Pruefe ob der FileWatcher-Daemon auf dem Ziel-PC laeuft (Tray) und der Hostname stimmt.',
         completed_at = NOW(),
         updated_at = NOW()
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 || ' seconds')::interval
     RETURNING id`,
    [String(maxAgeSec)],
  );
  for (const row of res.rows) {
    const channel = doneChannelForJob(row.id);
    await pool.query(`SELECT pg_notify($1, $2)`, [channel, 'timeout']);
  }
  return res.rowCount ?? 0;
}

/** REST-Seite: blockiert bis terminaler Status ODER Timeout. */
export async function waitForProjectInitJob(
  id: string,
  timeoutMs: number = 35_000,
): Promise<ProjectInitJobRow> {
  const pool = getPool();
  const client = await pool.connect();
  const channel = doneChannelForJob(id);
  let notificationHandler: ((msg: { channel: string; payload?: string }) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const fetchFinal = async (): Promise<ProjectInitJobRow> => {
    const r = await pool.query<ProjectInitJobRow>(
      `SELECT * FROM project_init_jobs WHERE id = $1`,
      [id],
    );
    if (r.rows.length === 0) throw new Error(`Project-Init-Job ${id} nicht gefunden`);
    return r.rows[0];
  };

  try {
    await client.query(`LISTEN "${channel}"`);

    const initial = await client.query<ProjectInitJobRow>(
      `SELECT * FROM project_init_jobs WHERE id = $1`,
      [id],
    );
    if (initial.rows.length === 0) throw new Error(`Project-Init-Job ${id} nicht gefunden`);
    if (TERMINAL_STATUSES.includes(initial.rows[0].status)) return initial.rows[0];

    return await new Promise<ProjectInitJobRow>((resolve, reject) => {
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

/** Reads a single job — fuer Status-Polling per Job-ID. */
export async function getProjectInitJob(id: string): Promise<ProjectInitJobRow | null> {
  const pool = getPool();
  const r = await pool.query<ProjectInitJobRow>(
    `SELECT * FROM project_init_jobs WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}
