/**
 * MODUL: daemon-heartbeat
 * ZWECK: Track ob fuer ein Projekt aktuell ein lokaler FileWatcher-Daemon laeuft.
 *        Genutzt vom shell-Tool fuer Auto-Routing zwischen lokaler Queue
 *        (Daemon-FS) und Workspace-Container (synapse-api Docker).
 */

import { getPool } from '../db/client.js';

const ALIVE_WINDOW_SEC = 30;

export interface DaemonHeartbeatRow {
  project: string;
  hostname: string;
  daemon_pid: number | null;
  last_seen: Date;
}

/** Daemon UPSERTed pro aktivem Projekt — last_seen=NOW(). */
export async function upsertDaemonHeartbeat(
  project: string,
  hostname: string,
  daemonPid: number | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO daemon_heartbeats (project, hostname, daemon_pid, last_seen)
       VALUES ($1, $2, $3, NOW())
     ON CONFLICT (project) DO UPDATE
       SET hostname = EXCLUDED.hostname,
           daemon_pid = EXCLUDED.daemon_pid,
           last_seen = NOW()`,
    [project, hostname, daemonPid],
  );
}

/** Prueft: ist Heartbeat fuer Projekt frischer als ALIVE_WINDOW_SEC? */
export async function isDaemonAliveForProject(project: string): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query<{ alive: boolean }>(
    `SELECT (last_seen > NOW() - ($2 || ' seconds')::interval) AS alive
       FROM daemon_heartbeats
      WHERE project = $1`,
    [project, ALIVE_WINDOW_SEC],
  );
  return r.rows[0]?.alive ?? false;
}

/** Liefert Heartbeat-Row (oder null) — fuer Debug/Status. */
export async function getDaemonHeartbeat(project: string): Promise<DaemonHeartbeatRow | null> {
  const pool = getPool();
  const r = await pool.query<DaemonHeartbeatRow>(
    `SELECT project, hostname, daemon_pid, last_seen
       FROM daemon_heartbeats WHERE project = $1`,
    [project],
  );
  return r.rows[0] ?? null;
}

/** Heartbeat-Eintrag entfernen — bei graceful shutdown des Daemons. */
export async function clearDaemonHeartbeat(project: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM daemon_heartbeats WHERE project = $1`, [project]);
}
