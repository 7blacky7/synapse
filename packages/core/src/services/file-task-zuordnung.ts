/** P6-T25/T26: Versionsbezug, weiche Pflicht und explizite, auditierte Nachzuordnung. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { aktuelleAgentIdentityId, aktuellerAgentPrincipal } from './agent-bezug.js';
import { posix } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { resolveProjectTaskId } from './task-id-resolver.js';

type TaskVersion = { id: string; file_path: string; task_id: string | null; edit_action?: string };
const neueVersionen = new AsyncLocalStorage<TaskVersion[]>();

/** Nur die aktuelle Tool-Ausfuehrung erfasst ihre eigenen INSERT-IDs; keine Suche im Altbestand. */
export function merkeFileTaskVersion(version: TaskVersion): void {
  neueVersionen.getStore()?.push(version);
}
function probePfad(path: string): boolean {
  return posix.normalize(path.replace(/\\/g, '/')).startsWith('coedit-test/');
}
const WRITE_ACTIONS = new Set(['create', 'update', 'search_replace', 'search_replace_batch', 'replace_lines',
  'insert_after', 'delete_lines', 'delete', 'move', 'copy', 'plan', 'plan_update', 'coedit_add', 'commit']);

/** Warnung nur an neuen Schreibaufrufen; keine Zusatzfelder bei zugeordneten Writes oder reinen Reads. */
export async function mitFileTaskWarnung<T>(args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const action = typeof args.action === 'string' ? args.action : '';
  if (!WRITE_ACTIONS.has(action)) return run();
  return neueVersionen.run([], async () => {
    const result = await run();
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const response = result as Record<string, unknown>;
    const missing = (neueVersionen.getStore() ?? []).filter((v) => !v.task_id && !probePfad(v.file_path)
      && !v.edit_action?.startsWith('fs_') && !v.edit_action?.startsWith('restore:'));
    let plannedMissing = false;
    // P22-T219: plan_update vererbt die Plan-Task an Ops ohne task_id (task_geerbt) - dann fehlt nichts.
    const geerbt = response.task_geerbt ?? (response.plan as Record<string, unknown> | undefined)?.task_geerbt;
    if (response.success !== false && ['plan', 'plan_update', 'coedit_add'].includes(action) && !args.task_id && !geerbt) {
      const input = Array.isArray(args.ops) ? args.ops as Array<{ task_id?: string; file_path?: string }> : [];
      plannedMissing = input.some((op) => !op.task_id && op.file_path && !probePfad(op.file_path));
    }
    // create kann bei einem existierenden/ignorierten Pfad einen Schutzplan statt eines Writes liefern.
    if (response.success !== false && action === 'create' && response.plan_id && !args.task_id
      && typeof args.file_path === 'string' && !probePfad(args.file_path)) plannedMissing = true;
    if (!missing.length && !plannedMissing) return result;
    return { ...response,
      warnung_task: 'task_id fehlt - Änderung keiner Task zugeordnet; nachtragen mit files(task_zuordnen)',
      version_ids: [...new Set(missing.map((v) => v.id))],
      ...(plannedMissing ? { hinweis_task: 'Task vor dem Commit mit plan_update ergänzen; danach task_zuordnen verwenden.' } : {}),
    } as T;
  });
}

/** Selektierte task_id: NULL bleibt unsichtbar; bekannte Kurz-ID wird nur bei gesetzter UUID ergänzt. */
export async function ergaenzeFileTasks<T extends { project: string; task_id?: string | null; task_kurz_id?: string }>(rows: T[]): Promise<T[]> {
  const tagged = rows.filter((row) => typeof row.task_id === 'string' && row.task_id);
  for (const row of rows) if (!row.task_id) delete row.task_id;
  if (!tagged.length) return rows;
  const tasks = await getPool().query<{ project: string; id: string; kurz_id: string | null }>(
    `SELECT p.project, task->>'id' AS id, task->>'kurz_id' AS kurz_id
       FROM plans p CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.tasks, '[]'::jsonb)) task
      WHERE p.project = ANY($1::text[]) AND task->>'id' = ANY($2::text[])`,
    [[...new Set(tagged.map((r) => r.project))], [...new Set(tagged.map((r) => r.task_id))]],
  );
  const names = new Map(tasks.rows.map((t) => [t.project + '\u0000' + t.id, t.kurz_id]));
  for (const row of tagged) {
    const kurz = names.get(row.project + '\u0000' + row.task_id);
    if (kurz) row.task_kurz_id = kurz;
  }
  return rows;
}

export interface FileTaskZuordnung {
  project: string;
  agent_id?: string;
  task_id: string;
  version_ids?: string[];
  batch_id?: string;
  plan_id?: string;
  ueberschreiben?: boolean;
  grund?: string;
}

/**
 * P22-T219 (Stresstest P22-T214 B4): batch_id/plan_id ohne Versionen. task_zuordnen trifft nur committete
 * Versionen; ein offener oder per plan_update ersetzter Plan bekommt Ursache und fertigen Aufruf genannt.
 */
async function meldungPlanOhneVersionen(client: PoolClient, args: FileTaskZuordnung, batch: string): Promise<string> {
  const plan = (await client.query<{ status: string; reason: string | null }>(
    'SELECT status::text AS status, reason FROM file_batch_plans WHERE project = $1 AND id = $2::bigint',
    [args.project, batch])).rows[0];
  const task = JSON.stringify(args.task_id);
  const selector = args.batch_id !== undefined ? 'batch_id' : 'plan_id';
  if (!plan) return `Version(en) nicht gefunden in diesem Projekt: zu ${selector} ${batch} gibt es weder Versionen noch einen Plan`;
  const folge = /\[ersetzt durch Plan (\d+)\]/.exec(plan.reason ?? '')?.[1];
  if (folge) return `Plan ${batch} wurde durch Folgeplan ${folge} ersetzt (plan_update) und hat keine Versionen. `
    + `Folgeplan mit Task committen: files(action:"commit", plan_id:"${folge}", task_id:${task}); `
    + `ist er schon committet: files(action:"task_zuordnen", plan_id:"${folge}", task_id:${task}).`;
  if (plan.status !== 'committed') return `Plan ${batch} ist noch nicht committet (status ${plan.status}); task_zuordnen gilt nur fuer committete Versionen. `
    + `Task beim Commit setzen: files(action:"commit", plan_id:"${batch}", task_id:${task}) (gilt fuer Ops ohne eigene task_id) `
    + `oder vorher plan_update mit task_id; nach dem Commit: files(action:"task_zuordnen", plan_id:"${batch}", task_id:${task}).`;
  return `Plan ${batch} ist committet, unter batch_id ${batch} liegen aber keine Versionen (z. B. Teilcommit mit eigener batch_id). `
    + `Versionen per files(action:"history") suchen und mit version_ids zuordnen.`;
}

/** Explizite Nachzuordnung: gesamter Satz autorisiert und atomar; niemals automatischer Backfill. */
export async function ordneFileTasksZu(args: FileTaskZuordnung): Promise<Record<string, unknown>> {
  const agent = args.agent_id?.trim();
  if (!agent) throw new Error('agent_id ist fuer task_zuordnen erforderlich');
  const selectors = [args.version_ids !== undefined, args.batch_id !== undefined, args.plan_id !== undefined];
  if (selectors.filter(Boolean).length !== 1) throw new Error('Genau version_ids oder batch_id oder plan_id angeben');
  const ids = args.version_ids ? [...new Set(args.version_ids.map(String))] : undefined;
  if (ids && (!ids.length || ids.some((id) => !/^\d+$/.test(id)))) throw new Error('version_ids muss nichtleere BIGINT-IDs enthalten');
  const batch = args.batch_id ?? args.plan_id;
  if (batch !== undefined && !/^\d+$/.test(batch)) throw new Error('batch_id/plan_id muss eine BIGINT-ID sein');
  const taskId = await resolveProjectTaskId(args.project, args.task_id);
  const identityId = aktuelleAgentIdentityId(args.project, agent);
  const p = aktuellerAgentPrincipal();
  const coordinator = identityId ? p?.art === 'identity' && /^(koordinator|coordinator)$/.test(p.rolle) : /^(koordinator|coordinator|user)$/i.test(agent); // bestehende Synapse-Rollen-Konvention
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ id: string; agent_id: string | null; author_identity_id: string | null; task_id: string | null }>(
      `SELECT id::text AS id, agent_id, author_identity_id, task_id FROM file_versions
        WHERE project = $1 AND ${ids ? 'id = ANY($2::bigint[])' : 'batch_id = $2::bigint'}
        ORDER BY id::bigint FOR UPDATE`, [args.project, ids ?? batch]);
    if (!selected.rows.length && batch !== undefined) throw new Error(await meldungPlanOhneVersionen(client, args, batch));
    if (!selected.rows.length || (ids && selected.rows.length !== ids.length)) throw new Error('Version(en) nicht gefunden in diesem Projekt');
    if (selected.rows.some((v) => !(identityId ? v.author_identity_id === identityId : !v.author_identity_id && v.agent_id === agent) && !coordinator)) throw new Error('Nicht berechtigt: nur Autor oder Koordinator darf Versionen zuordnen');
    const changed = selected.rows.filter((v) => v.task_id !== taskId && (v.task_id === null || args.ueberschreiben === true));
    if (changed.some((v) => v.task_id !== null) && !args.grund?.trim()) throw new Error('ueberschreiben braucht einen grund');
    let auditIds: string[] = [];
    if (changed.length) {
      await client.query('UPDATE file_versions SET task_id = $2 WHERE id = ANY($1::bigint[])',
        [changed.map((v) => v.id), taskId]);
      const audit = await client.query<{ id: string }>(
        `INSERT INTO file_version_task_zuordnungen (project, version_id, vorher_task_id, task_id, agent_id, grund, actor_identity_id)
         SELECT $1, v.version_id, v.vorher_task_id, $4, $5, $6, $7
           FROM unnest($2::bigint[], $3::text[]) AS v(version_id, vorher_task_id)
         RETURNING id::text AS id`,
        [args.project, changed.map((v) => v.id), changed.map((v) => v.task_id),
          taskId, agent, args.grund?.trim() || 'Nachtraegliche Task-Zuordnung', identityId]);
      auditIds = audit.rows.map((row) => row.id);
    }
    await client.query('COMMIT');
    const assigned = changed.map((v) => v.id);
    return { success: true, project: args.project, task_id: taskId, version_ids: assigned,
      unveraendert: selected.rows.filter((v) => !assigned.includes(v.id)).map((v) => v.id), protokoll_ids: auditIds,
      message: `${assigned.length} Version(en) zugeordnet; bestehende Zuordnungen bleiben ohne ueberschreiben:true + grund unveraendert.` };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
