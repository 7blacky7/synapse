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
import { aktuelleAgentIdentityId, aktuellerAgentAufruf, leseAgentBezugModus, loeseAgentZiel } from './agent-bezug.js';
import { WRAPPER_ZIEL_SQL, runtimeProjektPfad } from './runtime-daemon-zugang.js';

export type SpecialistAction =
  | 'spawn'
  | 'spawn_batch'
  | 'stop'
  | 'purge'
  | 'wake'
  | 'update_skill'
  | 'status'
  // Neustart-Aufforderung aus maybeTriggerRespawn (REST-Weg): der Daemon schreibt
  // den Rotations-Marker auf dem Rechner, auf dem der Wrapper laeuft.
  | 'rotate'
  // P22-T6: Nachricht an einen Agenten im Runtime-Container zustellen (Container-Daemon -> Wrapper -> Modell).
  | 'zustellen'
  // P22-T116: Debug/Steuerung der Runtime-Agenten (runtime-agenten-steuerung.ts): Log lesen, Prozessliste, Signal an PID.
  | 'log_lesen'
  | 'prozesse'
  | 'prozess_signal';

export interface SpecialistJobRow {
  actor_identity_id?: string | null;
  target_identity_id?: string | null;
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
  let jobArgs = args.args;
  const bezug = aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  // P22-T82: stop eines Spezialisten im Runtime-Container per Name: Ziel ist sein Container (letzter Spawn-Job), nicht ein PC.
  if (args.action === 'stop' && jobArgs.target_runtime === undefined && typeof jobArgs.name === 'string' && bezug.modus !== 'alt') {
    const perId = typeof jobArgs.identity_id === 'string' ? jobArgs.identity_id : jobArgs.name.startsWith('identity:') ? jobArgs.name.slice(9) : null;
    const c = await pool.query<{ identity_id: string; ziel: string | null }>(
      `SELECT w.identity_id, ${WRAPPER_ZIEL_SQL} AS ziel FROM agent_identitaet_wrapper_status w JOIN agent_identitaeten i ON i.id = w.identity_id
        WHERE w.project = $1 AND i.project = $1 AND (CASE WHEN $3::text IS NULL THEN i.agent_id = $2 ELSE i.id = $3 END)
          AND w.status IN ('running','idle') LIMIT 1`, [args.project, jobArgs.name, perId]);
    const z = c.rows[0];
    if (z?.ziel && (SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(z.ziel)) {
      jobArgs = { ...jobArgs, identity_id: z.identity_id, target_runtime: z.ziel, project_path: runtimeProjektPfad(args.project) };
    }
  }
  const identityId = typeof jobArgs.identity_id === 'string' ? jobArgs.identity_id
    : typeof jobArgs.name === 'string' && jobArgs.name.startsWith('identity:') ? jobArgs.name.slice(9) : undefined;
  let targetIdentity: string | null = null;
  if (identityId) {
    if (bezug.modus === 'alt') throw new Error('specialist_identity_im_altmodus');
    const ziel = await loeseAgentZiel(args.project, { identity_id: identityId });
    if (ziel.art !== 'identity') throw new Error('specialist_ziel_ungueltig');
    if (typeof jobArgs.name === 'string' && !jobArgs.name.startsWith('identity:') && jobArgs.name !== ziel.agent_id)
      throw new Error('specialist_ziel_name_falsch');
    targetIdentity = ziel.identity_id;
    jobArgs = { ...jobArgs, name: ziel.agent_id, identity_id: ziel.identity_id };
  }
  if (jobArgs.target_runtime !== undefined
    && (typeof jobArgs.target_runtime !== 'string' || !(SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(jobArgs.target_runtime))) {
    throw new Error('specialist_ziel_runtime_ungueltig');
  }
  // P22-T6: Container-Ziel (target_runtime) braucht keinen PC-Zielhost; der Pfad kommt vom Aufrufer.
  if (args.action === 'stop' && jobArgs.target_runtime === undefined) {
    const pfad = typeof jobArgs.project_path === 'string' ? jobArgs.project_path : null;
    const { rows } = await pool.query<{ hostname: string; path: string }>(
      "SELECT DISTINCT hostname,path FROM projects WHERE name=$1 AND path NOT LIKE '/virtual/%' AND ($2::text IS NULL OR path=$2)",
      [args.project, pfad]);
    if (rows.length !== 1) throw new Error('Stop-Zielhost nicht eindeutig registriert');
    jobArgs = { ...jobArgs, project: args.project, project_path: rows[0].path, target_hostname: rows[0].hostname };
  }
  if (bezug.modus !== 'alt') {
    const res = await pool.query<{ id: string }>(
      'INSERT INTO specialist_jobs(project,action,args,actor_identity_id,target_identity_id) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING id',
      [args.project,args.action,JSON.stringify(jobArgs),aktuelleAgentIdentityId(args.project),targetIdentity]);
    await merkeStartOrtAusJobSicher(args.project, args.action, jobArgs, null, 'specialist_jobs:auftrag');
    return { id: res.rows[0].id };
  }
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specialist_jobs (project, action, args)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [args.project, args.action, JSON.stringify(jobArgs)],
  );
  await merkeStartOrtAusJobSicher(args.project, args.action, jobArgs, null, 'specialist_jobs:auftrag');
  return { id: res.rows[0].id };
}

/** P22-T113: Startort aus dem Job merken (Schalter agent_start_ort; lazy gegen Importzyklen, wirft nie). */
async function merkeStartOrtAusJobSicher(project: string, action: string, jobArgs: Record<string, unknown>, hostname: string | null, quelle: string): Promise<void> {
  try {
    const { merkeStartOrtAusJob } = await import('./agent-start-ort.js');
    await merkeStartOrtAusJob({ project, action, args: jobArgs, hostname, quelle });
    // P22-T117 (R4): beim Enqueue NUR die Startabsicht (plattform_modell_absicht); das Laufmodell schreibt completeSpecialistJob
    // erst nach bestaetigtem Start. Schalter plattform_agent_modellwechsel; wirft nie.
    await (await import('./plattform-agent-modellwechsel.js')).merkeModellAbsicht({ project, action, args: jobArgs });
  } catch { /* Zusatzinformation, nie ein Startfehler */ }
}

/** P22-T6: Runtimes, deren Container-Daemon Spezialisten-Jobs ausfuehrt (args.target_runtime). */
export const SPECIALIST_ZIEL_RUNTIMES = ['claude', 'codex'] as const;
export type SpecialistZielRuntime = typeof SPECIALIST_ZIEL_RUNTIMES[number];

/**
 * Daemon-Seite: claimt aeltesten pending Job atomar via SELECT FOR UPDATE
 * SKIP LOCKED. Nur Jobs juenger als 30s — sonst expired.
 * P22-T6: ohne runtime (PC-Daemon) nie Jobs mit args.target_runtime; mit runtime (Container-Daemon)
 * NUR Jobs mit args.target_runtime = runtime (target_hostname spielt dort keine Rolle).
 */
export async function claimPendingSpecialistJob(
  project: string,
  daemonId: string,
  hostname?: string,
  runtime?: SpecialistZielRuntime,
): Promise<SpecialistJobRow | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<SpecialistJobRow>(
      `SELECT * FROM specialist_jobs
       WHERE project = $1
         AND status = 'pending'
         AND (($3::text IS NULL AND args->>'target_runtime' IS NULL
               AND (args->>'target_hostname' IS NULL OR args->>'target_hostname'=$2::text))
           OR ($3::text IS NOT NULL AND args->>'target_runtime'=$3::text))
         AND created_at > NOW() - interval '30 seconds'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [project, hostname ?? null, runtime ?? null],
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
    // P22-T113: PC-Daemon claimt -> Hostname als Startziel (Container-Jobs tragen ihre Runtime schon seit dem Auftrag).
    if (!runtime && hostname) await merkeStartOrtAusJobSicher(project, job.action, (job.args ?? {}) as Record<string, unknown>, hostname, 'specialist_jobs:claim');
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
  const upd = await pool.query(
    `UPDATE specialist_jobs
     SET status = $2,
         result = $3::jsonb,
         error = $4,
         message = $5,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING project, action, args, target_identity_id`,
    [
      id,
      completion.status,
      completion.result ? JSON.stringify(completion.result) : null,
      completion.error ?? null,
      completion.message ?? null,
    ],
  );
  // P22-T117 (R4): Modell erst nach bestaetigtem Start an die Laufgeneration binden (spawn/spawn_batch, auch Namensstarts). Wirft nie.
  const row = (upd.rows[0] ?? null) as { project: string; action: string; args: Record<string, unknown>; target_identity_id: string | null } | null;
  if (row && completion.status === 'done' && (row.action === 'spawn' || row.action === 'spawn_batch')) {
    try {
      await (await import('./plattform-agent-modellwechsel.js')).merkeAusweisModellNachStart({ id, project: row.project, action: row.action,
        args: row.args ?? {}, target_identity_id: row.target_identity_id ?? null, result: completion.result ?? null });
    } catch { /* Zusatzinformation, nie ein Abschlussfehler */ }
  }
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
