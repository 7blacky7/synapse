/**
 * P3-T15: Task-/Plansuche und Task-Nachzug. PostgreSQL-Pläne liefern jeden Treffertext.
 * plan_tasks ist nur der durch den plans-Trigger gepflegte Nachzugstand.
 */
import { getPool } from '../db/client.js';
import { embed, scoreSchwelleOderHinweis, type EmbedOptions } from '../embeddings/index.js';
import { searchVectors, deleteByFilter, ensureCollection, insertVectors } from '../qdrant/index.js';
import { COLLECTIONS, type ProjectPlan, type ProjectTask } from '../types/index.js';
import { getAllePlaene, planRefVon, taskSchlaeft, resolveProjectTaskId } from './plans.js';
import { betteEinzelnEin, betteStapelEin, type NachzugQuelle } from './embed-nachzug.js';

export const taskIndexKey = (project: string, id: string): string => project + ':' + id;
export function geaenderteTaskIds(alt: ProjectTask[], neu: ProjectTask[]): string[] {
  const vorher = new Map(alt.map(t => [t.id, JSON.stringify(t)]));
  const nachher = new Map(neu.map(t => [t.id, JSON.stringify(t)]));
  return [...nachher].filter(([id, text]) => vorher.get(id) !== text).map(([id]) => id);
}

export const TASK_STAND = "t.updated_at || ':' || md5(t.task::text || t.plan_id || COALESCE(t.plan_kurz_id, ''))";
export const taskNachzug: NachzugQuelle = {
  tabelle: 'plan_tasks', idSpalte: 'key', idTyp: 'text', standSql: TASK_STAND,
  async lese(ids) {
    const { rows } = await getPool().query<{
      key: string; id: string; project: string; plan_id: string; plan_kurz_id: string | null;
      task: ProjectTask; stand: string;
    }>(`SELECT t.*, ${TASK_STAND} AS stand FROM plan_tasks t
        JOIN plans p ON p.id = t.plan_id AND p.project = t.project
        WHERE t.key = ANY($1::text[])
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.tasks) x WHERE x->>'id' = t.id AND x = t.task)`, [ids]);
    return rows.map(r => ({
      id: r.key, project: r.project, collection: COLLECTIONS.projectTasks(r.project),
      text: [r.task.title, r.task.description].join('\n'), stand: r.stand,
      payload: {
        project: r.project, task_id: r.id, plan_id: r.plan_id, plan_kurz_id: r.plan_kurz_id,
        kurz_id: r.task.kurz_id ?? null, status: r.task.status, priority: r.task.priority,
        zugewiesen_an: r.task.zugewiesen_an ?? null, updatedAt: r.task.updatedAt,
        alias_kurz_ids: r.task.alias_kurz_ids ?? [],
      },
    }));
  },
  async schreibe(collection, liste) {
    await ensureCollection(collection);
    // PG-Schlüssel projektgebunden, Qdrant-ID weiterhin die UUID in ihrer Projekt-Collection.
    await insertVectors(collection, liste.map(({ punkt, vector }) => ({ id: String(punkt.payload.task_id), vector, payload: punkt.payload })));
  },
};

export async function embeddeTaskNach(project: string | null, id: string, options: EmbedOptions = {}): Promise<void> {
  await betteEinzelnEin(taskNachzug, project && !id.startsWith(project + ':') ? taskIndexKey(project, id) : id, { priority: 'background', ...options }, p => !project || p.project === project);
}

/** Austauschbare Testnaht; Plan-Index und Task-Index scheitern unabhängig. */
export const taskIndex = {
  async sync(plan: ProjectPlan, options: EmbedOptions = {}, geaendert?: string[]): Promise<void> {
    const collection = COLLECTIONS.projectTasks(plan.project);
    await ensureCollection(collection);
    // Vor dem Embedding frisch lesen: ein alter Schreibaufruf darf keinen neueren Stand zurückschreiben.
    const { rows } = await getPool().query<{ key: string; id: string; embedded_at: unknown }>(
      'SELECT key, id, embedded_at FROM plan_tasks WHERE project=$1 AND plan_id=$2', [plan.project, plan.id]);
    await deleteByFilter(collection, {
      must: [{ key: 'plan_id', match: { value: plan.id } }],
      ...(rows.length ? { must_not: [{ has_id: rows.map(r => r.id) }] } : {}),
    });
    const pending = rows.filter(r => r.embedded_at === null && (geaendert === undefined || geaendert.includes(r.id))).map(r => r.key);
    if (pending.length) await betteStapelEin(taskNachzug, pending, options);
  },
  async removePlan(project: string, planId: string): Promise<void> {
    await deleteByFilter(COLLECTIONS.projectTasks(project), { must: [{ key: 'plan_id', match: { value: planId } }] });
  },
};

/** Beide MCP-Schemas verwenden denselben Vertrag. */
export const PLAN_SEARCH_PROPERTIES: Record<string, unknown> = {
  query: { type: 'string', description: 'Semantische Anfrage (search). Vor neuen Tasks suchen.' },
  art: { type: 'string', enum: ['tasks', 'plans'], description: 'plan(search): tasks (Standard) oder plans.' },
  status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'], description: 'Suchfilter oder neuer Task-Status.' },
  plan_id: { type: 'string', description: 'Plan-UUID/Kurz-ID; search ohne Wert durchsucht alle Pläne, andere Aktionen den aktiven.' },
  priority: { type: 'string', enum: ['low', 'medium', 'high', 'hoch', 'mittel', 'niedrig'], description: 'Tasks low/medium/high, Plansuche hoch/mittel/niedrig.' },
  alle: { type: 'boolean', description: 'Auch zurückgestellte Pläne/Tasks (Standard false).' },
  mit_verknuepfungen: { type: 'boolean', description: 'Zusätzlich zu Pin-Anzahlen die jüngsten Thought-/Dateiversion-IDs.' },
} as const;

export interface PlanSuchOptionen {
  limit?: number; status?: string; plan_id?: string; priority?: string;
  alle?: boolean; mit_verknuepfungen?: boolean;
}
export interface TaskPins {
  thoughts: number; dateiversionen: number;
  thought_ids?: string[]; dateiversion_ids?: string[];
}
export interface PlanSuchTreffer {
  id: string; kurz_id: string | null; title: string; plan: ReturnType<typeof planRefVon>;
  status: string; priority: string; vorschau: string; score: number; pins: TaskPins;
  zugewiesen_an?: unknown; zurueckgestellt?: boolean;
}
export interface PlanSuchErgebnis {
  success: true; results: PlanSuchTreffer[]; count: number; verworfen_ohne_pg: number;
}
function taskRefs(t: ProjectTask): string[] {
  const aliases = Array.isArray(t.alias_kurz_ids) ? t.alias_kurz_ids.filter((x): x is string => typeof x === 'string') : [];
  return [...new Set([t.id, ...(t.kurz_id ? [t.kurz_id] : []), ...aliases])];
}
const preview = (s: string) => s.length > 300 ? s.slice(0, 300) + '…' : s;
function planSchlaeft(p: ProjectPlan): boolean {
  return !p.aktiv && !!p.zurueckgestellt_bis && new Date(p.zurueckgestellt_bis).getTime() > Date.now();
}

/** Pro Treffer die Pins aller zugehörigen Tasks, als zwei gebündelte PG-Abfragen. */
async function pins(
  project: string, groups: Array<{ hit: { id: string }; taskIds: string[] }>, details: boolean,
): Promise<Map<string, TaskPins>> {
  const out = new Map(groups.map(g => [g.hit.id, { thoughts: 0, dateiversionen: 0, ...(details ? { thought_ids: [], dateiversion_ids: [] } : {}) } as TaskPins]));
  if (!groups.length) return out;
  const payload = JSON.stringify(groups.map(g => ({ id: g.hit.id, task_ids: g.taskIds })));
  const [thoughts, versions] = await Promise.all([
    getPool().query<{ id: string; n: number; ids?: string[] }>(
      `SELECT g.id, count(*)::int AS n${details ? ", (array_agg(t.id::text ORDER BY t.timestamp DESC, t.id DESC))[1:5] AS ids" : ''}
       FROM jsonb_to_recordset($2::jsonb) g(id text, task_ids jsonb)
       JOIN thoughts t ON t.project=$1 AND upper(t.task_id) IN (SELECT upper(jsonb_array_elements_text(g.task_ids)))
       GROUP BY g.id`, [project, payload]),
    getPool().query<{ id: string; n: number; ids?: string[] }>(
      `SELECT g.id, count(*)::int AS n${details ? ", (array_agg(v.id::text ORDER BY v.created_at DESC, v.id DESC))[1:5] AS ids" : ''}
       FROM jsonb_to_recordset($2::jsonb) g(id text, task_ids jsonb)
       JOIN file_versions v ON v.project=$1 AND upper(v.task_id) IN (SELECT upper(jsonb_array_elements_text(g.task_ids)))
       GROUP BY g.id`, [project, payload]),
  ]);
  for (const r of thoughts.rows) Object.assign(out.get(r.id)!, { thoughts: r.n, ...(details ? { thought_ids: r.ids ?? [] } : {}) });
  for (const r of versions.rows) Object.assign(out.get(r.id)!, { dateiversionen: r.n, ...(details ? { dateiversion_ids: r.ids ?? [] } : {}) });
  return out;
}

/** Lesende Testnaht für Embedding/Qdrant; Texte und Filter bleiben immer PG-autoritativ. */
export const planSuchIndex = {
  embed: (query: string) => embed(query, { art: 'query' }),
  search: (collection: string, vector: number[], limit: number, filter: Record<string, unknown>) =>
    searchVectors<Record<string, unknown>>(collection, vector, limit, filter),
};

export async function suchePlanWissen(
  project: string, query: string, art: 'tasks' | 'plans' = 'tasks', options: PlanSuchOptionen = {},
): Promise<PlanSuchErgebnis> {
  if (!project.trim() || !query.trim()) throw new Error('project und query sind erforderlich');
  if (!['tasks', 'plans'].includes(art)) throw new Error('art muss tasks oder plans sein');
  if (options.status && !['todo', 'in_progress', 'done', 'blocked'].includes(options.status)) throw new Error('Ungültiger status');
  const prios = art === 'tasks' ? ['low', 'medium', 'high'] : ['hoch', 'mittel', 'niedrig'];
  if (options.priority && !prios.includes(options.priority)) throw new Error('Ungültige priority für ' + art);
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit muss 1..200 sein');
  const plans = await getAllePlaene(project);
  const selected = options.plan_id ? plans.find(p => p.id === options.plan_id || p.kurz_id?.toUpperCase() === options.plan_id!.trim().toUpperCase()) : undefined;
  if (options.plan_id && !selected) throw new Error('Plan nicht gefunden: ' + options.plan_id);
  const byPlan = new Map(plans.map(p => [p.id, p]));
  const byTask = new Map(plans.flatMap(p => p.tasks.map(t => [t.id, { p, t }] as const)));
  if ((art === 'tasks' ? byTask.size : byPlan.size) === 0) {
    return { success: true, results: [], count: 0, verworfen_ohne_pg: 0 };
  }
  const vector = await planSuchIndex.embed(query);
  const must: unknown[] = [{ key: 'project', match: { value: project } }];
  // Metadatenfilter werden in PG angewendet: ein verspäteter Vektor nach Verschieben/Statuswechsel
  // darf den aktuellen Treffer nicht aufgrund seiner alten Payload ausblenden.
  const collection = art === 'tasks' ? COLLECTIONS.projectTasks(project) : COLLECTIONS.projectPlans(project);
  const orphans = new Set<string>();
  const candidates: Array<{ hit: PlanSuchTreffer; taskIds: string[] }> = [];
  let take = Math.max(limit, 32);
  while (true) {
    const hits = await planSuchIndex.search(collection, vector, take, { must });
    candidates.length = 0;
    const seen = new Set<string>();
    for (const h of hits) {
      const id = String(h.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const fund = byTask.get(id);
      const p = art === 'tasks' ? fund?.p : byPlan.get(id);
      if (!p || (art === 'tasks' && !fund)) { orphans.add(id); continue; }
      const t = art === 'tasks' ? fund!.t : undefined;
      if (selected && p.id !== selected.id) continue;
      const sleeping = planSchlaeft(p) || !!(t && taskSchlaeft(t));
      if (!options.alle && sleeping) continue;
      const status = t?.status ?? (p.tasks.length && p.tasks.every(x => x.status === 'done') ? 'done' : p.tasks.some(x => x.status === 'in_progress') ? 'in_progress' : p.tasks.some(x => x.status === 'blocked') ? 'blocked' : 'todo');
      const priority = t?.priority ?? p.prioritaet ?? 'mittel';
      if (options.status && options.status !== status) continue;
      if (options.priority && options.priority !== priority) continue;
      candidates.push({ hit: {
        id, kurz_id: t?.kurz_id ?? p.kurz_id ?? null, title: t?.title ?? p.name,
        plan: planRefVon(p), status, priority, vorschau: preview(t?.description ?? p.description),
        score: h.score, pins: { thoughts: 0, dateiversionen: 0 },
        ...(t?.zugewiesen_an ? { zugewiesen_an: t.zugewiesen_an } : {}),
        ...(sleeping ? { zurueckgestellt: true } : {}),
      }, taskIds: t ? taskRefs(t) : p.tasks.flatMap(taskRefs) });
    }
    if (candidates.length >= limit || hits.length < take) break;
    take *= 2;
  }
  const chosen = candidates.slice(0, limit);
  const links = await pins(project, chosen, options.mit_verknuepfungen === true);
  for (const c of chosen) c.hit.pins = links.get(c.hit.id)!;
  if (orphans.size) console.error('[Synapse] Plan-Suche: ' + orphans.size + ' Qdrant-Treffer ohne PG verworfen');
  return { success: true, results: chosen.map(c => c.hit), count: chosen.length, verworfen_ohne_pg: orphans.size };
}

export const searchTasks = (query: string, project: string, options: PlanSuchOptionen = {}) => suchePlanWissen(project, query, 'tasks', options);
export const searchPlans = (query: string, project: string, options: PlanSuchOptionen = {}) => suchePlanWissen(project, query, 'plans', options);

/** Gemeinsamer Dispatcher für REST und stdio; plan(search) sucht standardmäßig Tasks. */
export function suchePlanTool(args: Record<string, unknown>, art?: 'tasks' | 'plans') {
  const string = (key: string) => typeof args[key] === 'string' ? args[key] as string : undefined;
  return suchePlanWissen(string('project') ?? '', string('query') ?? '', art ?? (string('art') ?? 'tasks') as 'tasks' | 'plans', {
    limit: typeof args.limit === 'number' ? args.limit : undefined, status: string('status'),
    plan_id: string('plan_id'), priority: string('priority'),
    alle: args.alle === true, mit_verknuepfungen: args.mit_verknuepfungen === true,
  });
}

/** Kein Grenzwert im Code; fehlende Kalibrierung oder Suchfehler blockieren das Anlegen nie. */
export async function taskDublettenHinweis(project: string, title: string, description: string, ausschluss: string[] = []) {
  try {
    const threshold = await scoreSchwelleOderHinweis('tasks');
    if (threshold.schwelle === null) return { aehnlich: [], aehnlich_hinweis: threshold.hinweis };
    const found = await searchTasks([title, description].join('\n'), project, { alle: true, limit: 20 });
    return { aehnlich: found.results.filter(r => !ausschluss.includes(r.id) && r.score >= threshold.schwelle!).map(r => ({
      id: r.id, kurz_id: r.kurz_id, title: r.title, plan: r.plan, status: r.status, score: r.score,
    })) };
  } catch (e) { return { aehnlich: [], aehnlich_hinweis: 'Dubletten-Suche nicht verfügbar: ' + String(e) }; }
}

/** Bestands-Thoughts speicherten auch rohe Kurz-IDs; nach Verschieben zählen die Aliase weiter. */
export async function thoughtTaskRefs(project: string, ref: string): Promise<string[]> {
  const id = await thoughtTaskFilter(project, ref);
  const task = (await getAllePlaene(project)).flatMap(p => p.tasks).find(t => t.id === id);
  return task ? taskRefs(task) : [id];
}

/** Alias/UUID/Kurz-ID wird vor dem Thought-Filter projektgebunden aufgelöst. */
export async function thoughtTaskFilter(project: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.trim())) return ref.trim();
  return await resolveProjectTaskId(project, ref);
}
