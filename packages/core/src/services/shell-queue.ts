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
 * Schreibt einen bereits abgeschlossenen Job direkt als Row — ohne Queue-Detour.
 * Wird vom lokalen MCP-Server genutzt (der execShellInProject synchron ruft)
 * damit dessen Aufrufe in der gleichen History landen wie REST/Queue-Jobs.
 *
 * KEIN NOTIFY (kein Worker erwartet das), KEIN pending-Status (Job ist done).
 */
export async function insertCompletedShellJob(args: {
  project: string;
  command: string;
  cwd_relative?: string;
  timeout_ms?: number;
  tail_lines?: number;
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  exit_code?: number;
  tail?: string[];
  error?: string;
  message?: string;
  output?: string;
  stream_id?: string;
  source: 'mcp_local' | 'rest_queue';
}): Promise<{ id: string }> {
  const pool = getPool();
  let output = args.output ?? null;
  let truncated = false;
  if (output !== null && output.length > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES) + `\n\n[... output truncated at ${MAX_OUTPUT_BYTES} bytes ...]`;
    truncated = true;
  }
  const res = await pool.query<{ id: string }>(
    `INSERT INTO shell_jobs (
       project, command, cwd_relative, timeout_ms, tail_lines,
       status, exit_code, tail, error, message, output, output_truncated,
       stream_id, claimed_by, claimed_at, completed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
     RETURNING id`,
    [
      args.project,
      args.command,
      args.cwd_relative ?? null,
      args.timeout_ms ?? 30_000,
      args.tail_lines ?? 5,
      args.status,
      args.exit_code ?? null,
      args.tail ? JSON.stringify(args.tail) : null,
      args.error ?? null,
      args.message ?? null,
      output,
      truncated,
      args.stream_id ?? null,
      args.source,
    ],
  );
  return { id: res.rows[0].id };
}

/** Zaehlt Newlines im Output — billig (eine Iteration). */
function countLines(s: string | null | undefined): number {
  if (!s) return 0;
  // Kein newline am Ende? trotzdem 1 Zeile.
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  // Trailing newline → letzte "leere" Zeile nicht zaehlen.
  if (s.charCodeAt(s.length - 1) === 10) n--;
  return Math.max(0, n);
}

export interface ShellJobSummary {
  id: string;
  project: string;
  command: string;
  cwd_relative: string | null;
  status: ShellJobRow['status'];
  exit_code: number | null;
  tail: string[] | null;
  error: string | null;
  message: string | null;
  output_truncated: boolean | null;
  output_line_count: number;
  stream_id: string | null;
  /** "mcp_local" | "daemon-<hostname>-<pid>" — woher kam der Job. */
  source: string | null;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * History-Lookup: liefert die letzten N Jobs eines Projekts (oder ueber alle
 * Projekte falls project=undefined). Sortiert nach created_at DESC.
 *
 * Returnt KEIN output-Feld — die Liste soll klein bleiben. output_line_count
 * gibt der KI aber an wie gross der jeweilige Log ist und ob ein detail-
 * Lookup mit `get` oder `log` lohnt.
 */
export async function getShellJobs(opts: {
  project?: string;
  limit?: number;
  offset?: number;
  status?: ShellJobRow['status'];
}): Promise<ShellJobSummary[]> {
  const pool = getPool();
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.project) { params.push(opts.project); conditions.push(`project = $${params.length}`); }
  if (opts.status)  { params.push(opts.status);  conditions.push(`status = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  // length(output) - length(replace(output, E'\n', '')) zaehlt Newlines in PG
  // direkt — billig + spart Datenuebertragung des output-TEXT-Felds.
  const { rows } = await pool.query(
    `SELECT id, project, command, cwd_relative, status, exit_code, tail, error,
            message, output_truncated, stream_id, claimed_by AS source,
            created_at, completed_at,
            CASE
              WHEN output IS NULL OR output = '' THEN 0
              WHEN substring(output FROM length(output) FOR 1) = E'\n'
                THEN length(output) - length(replace(output, E'\n', ''))
              ELSE length(output) - length(replace(output, E'\n', '')) + 1
            END AS output_line_count
     FROM shell_jobs
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows as ShellJobSummary[];
}

export interface ShellJobDetail extends ShellJobRow {
  output_line_count: number;
}

/**
 * Holt einen einzelnen Job inklusive vollem Output (falls vorhanden).
 * Fuer das Detail-Lookup einer KI nach `history`.
 */
export async function getShellJobById(id: string): Promise<ShellJobDetail | null> {
  const pool = getPool();
  const { rows } = await pool.query<ShellJobRow>(
    `SELECT * FROM shell_jobs WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return { ...row, output_line_count: countLines(row.output) };
}

/**
 * Liefert eine Zeilen-Range aus dem Output eines Jobs.
 * fromLine/toLine sind 1-basiert, beide inklusiv. Default: erste 100 Zeilen.
 */
export async function getShellJobLogLines(
  id: string,
  fromLine?: number,
  toLine?: number,
): Promise<{
  found: boolean;
  total_lines: number;
  from_line: number;
  to_line: number;
  lines: string[];
} | null> {
  const job = await getShellJobById(id);
  if (!job) return null;
  const all = (job.output ?? '').split('\n');
  // Trailing leere Zeile durch \n am Ende entfernen
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const total = all.length;
  const from = Math.max(1, fromLine ?? 1);
  const to = Math.min(total, toLine ?? from + 99);
  const lines = total === 0 ? [] : all.slice(from - 1, to);
  return { found: true, total_lines: total, from_line: from, to_line: to, lines };
}

/**
 * Sucht im Output eines Jobs. Modi:
 *   - regex=true: Pattern als RegExp interpretiert
 *   - sonst: Substring-Match (case-insensitive default).
 *
 * Zahlen-Suche: einfach query="42" mit substring → findet alle Zeilen mit "42".
 */
export async function searchShellJobLog(
  id: string,
  query: string,
  opts: { regex?: boolean; case_sensitive?: boolean; max_matches?: number } = {},
): Promise<{
  found: boolean;
  total_lines: number;
  total_matches: number;
  matches: Array<{ line_number: number; content: string }>;
  truncated: boolean;
} | null> {
  const job = await getShellJobById(id);
  if (!job) return null;
  const all = (job.output ?? '').split('\n');
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const total = all.length;

  const max = Math.max(1, Math.min(opts.max_matches ?? 200, 2000));
  const matches: Array<{ line_number: number; content: string }> = [];
  let totalMatches = 0;

  let test: (s: string) => boolean;
  if (opts.regex) {
    const re = new RegExp(query, opts.case_sensitive ? '' : 'i');
    test = (s) => re.test(s);
  } else if (opts.case_sensitive) {
    test = (s) => s.includes(query);
  } else {
    const q = query.toLowerCase();
    test = (s) => s.toLowerCase().includes(q);
  }

  for (let i = 0; i < total; i++) {
    if (test(all[i])) {
      totalMatches++;
      if (matches.length < max) matches.push({ line_number: i + 1, content: all[i] });
    }
  }

  return {
    found: true,
    total_lines: total,
    total_matches: totalMatches,
    matches,
    truncated: totalMatches > matches.length,
  };
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

