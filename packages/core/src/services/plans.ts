/**
 * MODUL: Projekt-Plan-System
 * ZWECK: Plaene mit Zielen, Architektur und Tasks je Projekt (PostgreSQL = Wahrheit, Qdrant = Index)
 *
 * MEHRERE PLAENE JE PROJEKT (Task 137fabaf, User-Vorgabe 29.09.2026):
 *   - Je Projekt beliebig viele Plaene mit stabilen Kurz-IDs P<n>; Tasks heissen P<n>-T<m>
 *     (plan-kurz-ids.ts). Genau EIN Plan ist aktiv (plans.aktiv).
 *   - OHNE planRef gilt der AKTIVE Plan — das ist das bisherige Verhalten (ein Plan je
 *     Projekt). Ist keiner markiert (Bestand vor scripts/plaene-kurz-ids.mjs), gilt der
 *     zuletzt geaenderte: genau der Plan, den getPlan frueher als ersten Qdrant-Treffer bekam.
 *   - planRef = Plan-UUID oder Kurz-ID "P<n>"; taskRef = Task-UUID oder "P<n>-T<m>".
 *   - Eine Task-UUID ohne planRef wird ueber ALLE Plaene des Projekts gesucht: alte UUIDs
 *     funktionieren ueberall weiter, auch in inaktiven Plaenen.
 *   - Rueckgaben tragen nur ZUSAETZLICHE Felder (kurz_id, aktiv, plaene_im_projekt, plan_ref,
 *     hinweis_plaene) — nichts entfernt oder umbenannt.
 *
 * LESEN NUR AUS POSTGRESQL (Task a82fd42f): frueher kam getPlan aus Qdrant. Lieferte Qdrant
 * kurz nichts, legten Projekt-Aktivierung und init einen ZWEITEN Plan an (so entstand der
 * leere synapse-Plan vom 15.03.). Qdrant ist nur noch Suchindex und wird NACH dem PG-Schreiben
 * best effort nachgezogen (planIndex.sync).
 *
 * SCHREIBEN OPTIMISTISCH: UPDATE ... WHERE id = $ AND tasks = $alt::jsonb, bei Konflikt neu
 * lesen (hoechstens drei Versuche). Gleichzeitige Task-Aenderungen und der Kurz-ID-Zaehler
 * gehen so nicht verloren; keine Sperre haelt waehrend eines Client-Wartens.
 *
 * ABGESCHLOSSEN: update (Metadaten) wirkt nur auf den aktiven Plan — ein inaktiver Plan wird
 * nicht ueberschrieben, ein neuer Stand ist ein neuer Plan (createPlan). Task-Status bleibt
 * auch in inaktiven Plaenen aenderbar (UUID-Kompatibilitaet).
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ProjectPlan,
  ProjectTask,
  ProjectPlanPayload,
  COLLECTIONS,
} from '../types/index.js';
import {
  ensureCollection,
  insertVector,
  deleteVector,
} from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';
import { getPool } from '../db/client.js';
import {
  planNummer, taskNummer, planKurzId, taskKurzId, waehleAktiven, ergaenzeTaskKurzIds,
} from './plan-kurz-ids.js';

/** plans-Zeile wie aus PG gelesen */
interface PlanZeile {
  id: string;
  project: string;
  name: string;
  description: string | null;
  goals: string[] | null;
  architecture: string | null;
  tasks: ProjectTask[] | null;
  created_at: string | Date;
  updated_at: string | Date;
  kurz_id: string | null;
  aktiv: boolean | null;
  naechste_task_nr: number | null;
}

/** Kurzer Verweis auf einen Plan — steht in jeder Antwort, die einen Plan benutzt. */
export interface PlanRef {
  id: string;
  kurz_id: string | null;
  name: string;
  aktiv: boolean;
}

export interface PlanListenEintrag {
  id: string;
  kurz_id: string | null;
  name: string;
  ziel: string;
  aktiv: boolean;
  tasks_gesamt: number;
  tasks_offen: number;
  tasks_erledigt: number;
  created_at: string;
  updated_at: string;
}

/**
 * Qdrant-Index eines Plans (best effort, NACH dem PG-Schreiben). Als Objekt exportiert, damit
 * Tests den Index ersetzen koennen; ein Fehler kommt als warning zurueck, nie als Ausnahme.
 */
export const planIndex = {
  async sync(plan: ProjectPlan): Promise<void> {
    const collection = COLLECTIONS.projectPlans(plan.project);
    await ensureCollection(collection);
    const vector = await embed(`${plan.name}\n${plan.description}\n${plan.goals.join('\n')}`);
    const payload: ProjectPlanPayload = {
      project: plan.project,
      name: plan.name,
      description: plan.description,
      goals: plan.goals,
      architecture: plan.architecture,
      tasks: plan.tasks,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
      kurz_id: plan.kurz_id ?? null,
      aktiv: plan.aktiv ?? false,
    };
    try {
      await deleteVector(collection, plan.id);
    } catch { /* Punkt fehlte — insert legt ihn an */ }
    await insertVector(collection, vector, payload, plan.id);
  },
};

async function indexNachziehen(plan: ProjectPlan): Promise<string | undefined> {
  try {
    await planIndex.sync(plan);
    return undefined;
  } catch (error) {
    console.error('[Synapse] Qdrant Plan-Index nicht nachgezogen (PG ist geschrieben):', error);
    return `Qdrant-Write fehlgeschlagen: ${error}`;
  }
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

const iso = (x: string | Date | null | undefined): string =>
  x instanceof Date ? x.toISOString() : String(x ?? '');

async function lesePlaene(project: string): Promise<PlanZeile[]> {
  const { rows } = await getPool().query<PlanZeile>(
    `SELECT id, project, name, description, goals, architecture, tasks, created_at, updated_at,
            kurz_id, aktiv, naechste_task_nr
     FROM plans WHERE project = $1 ORDER BY created_at, id`,
    [project],
  );
  return rows.map((z) => ({ ...z, tasks: Array.isArray(z.tasks) ? z.tasks : [] }));
}

function zuPlan(z: PlanZeile, alle: PlanZeile[]): ProjectPlan {
  const aktiv = waehleAktiven(alle);
  return {
    id: z.id,
    project: z.project,
    name: z.name,
    description: z.description ?? '',
    goals: z.goals ?? [],
    architecture: z.architecture ?? undefined,
    tasks: z.tasks ?? [],
    createdAt: iso(z.created_at),
    updatedAt: iso(z.updated_at),
    kurz_id: z.kurz_id ?? null,
    aktiv: aktiv?.id === z.id,
    plaene_im_projekt: alle.length,
  };
}

function planListe(alle: PlanZeile[]): string {
  return alle.map((z) => `${z.kurz_id ?? z.id} "${z.name}"`).join(', ') || '(keine)';
}

/**
 * Plan zu planRef (UUID oder P<n>); ohne planRef der aktive. Unbekannter planRef -> Error mit
 * der Planliste des Projekts. null nur, wenn das Projekt keinen Plan hat.
 */
function findePlan(project: string, alle: PlanZeile[], planRef?: string | null): PlanZeile | null {
  if (!planRef) return waehleAktiven(alle);
  const ref = planRef.trim();
  const nr = planNummer(ref);
  const treffer = nr !== null
    ? alle.find((z) => planNummer(z.kurz_id) === nr)
    : alle.find((z) => z.id === ref);
  if (!treffer) {
    throw new Error(`Plan "${ref}" nicht gefunden im Projekt ${project}. Vorhanden: ${planListe(alle)}. Uebersicht: plan(list).`);
  }
  return treffer;
}

export function planRefVon(plan: ProjectPlan): PlanRef {
  return { id: plan.id, kurz_id: plan.kurz_id ?? null, name: plan.name, aktiv: plan.aktiv === true };
}

/** Hinweis fuer Antworten, wenn das Projekt mehr als einen Plan hat — sonst undefined. */
export function hinweisPlaene(plan: ProjectPlan | null | undefined): string | undefined {
  if (!plan || (plan.plaene_im_projekt ?? 1) <= 1) return undefined;
  return `Plan ${plan.kurz_id ?? plan.id} "${plan.name}"${plan.aktiv ? ' (aktiv)' : ' (nicht aktiv)'} benutzt — weitere Plaene: plan(list)`;
}

/** plan_ref + ggf. hinweis_plaene zum Anhaengen an eine Antwort */
export function planKontext(plan: ProjectPlan): { plan_ref: PlanRef; hinweis_plaene?: string } {
  const hinweis = hinweisPlaene(plan);
  return { plan_ref: planRefVon(plan), ...(hinweis ? { hinweis_plaene: hinweis } : {}) };
}

/**
 * Ruft einen Plan ab: ohne planRef den aktiven (bisheriges Verhalten), sonst den genannten.
 * null, wenn das Projekt keinen Plan hat; unbekannter planRef -> Error.
 */
export async function getPlan(project: string, planRef?: string | null): Promise<ProjectPlan | null> {
  const alle = await lesePlaene(project);
  const z = findePlan(project, alle, planRef);
  return z ? zuPlan(z, alle) : null;
}

/** Alle Plaene des Projekts MIT Tasks (created_at-Reihenfolge) — fuer passende_tasks ohne plan_id. */
export async function getAllePlaene(project: string): Promise<ProjectPlan[]> {
  const alle = await lesePlaene(project);
  return alle.map((z) => zuPlan(z, alle));
}

/**
 * task_id -> Task DIESES Plans: UUID oder Kurz-ID P<n>-T<m>. Gehoert die Kurz-ID zu einem
 * anderen Plan oder gibt es die Task nicht: Fehlertext statt Task.
 */
export function findeTaskInPlan(plan: ProjectPlan, ref: string): ProjectTask | string {
  const kurz = taskNummer(ref);
  if (kurz) {
    if (planNummer(plan.kurz_id) !== kurz.plan) {
      return `Task ${ref} gehoert nicht zu Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
    }
    const t = plan.tasks.find((x) => typeof x.kurz_id === 'string' && x.kurz_id.toUpperCase() === ref.toUpperCase());
    return t ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id}`;
  }
  return plan.tasks.find((x) => x.id === ref) ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
}

/** Alle Plaene des Projekts ohne Tasks (plan(list)). */
export async function listPlans(project: string): Promise<PlanListenEintrag[]> {
  const alle = await lesePlaene(project);
  const aktiv = waehleAktiven(alle);
  return alle.map((z) => {
    const tasks = z.tasks ?? [];
    const erledigt = tasks.filter((t) => t.status === 'done').length;
    return {
      id: z.id,
      kurz_id: z.kurz_id ?? null,
      name: z.name,
      ziel: (z.description ?? '').slice(0, 200),
      aktiv: aktiv?.id === z.id,
      tasks_gesamt: tasks.length,
      tasks_offen: tasks.length - erledigt,
      tasks_erledigt: erledigt,
      created_at: iso(z.created_at),
      updated_at: iso(z.updated_at),
    };
  });
}

/** Kompakte Liste fuer das Onboarding: aktive oder offene Plaene, keine Tasks. */
export async function planUebersicht(
  project: string,
): Promise<Array<{ kurz_id: string | null; name: string; aktiv: boolean; offen: number; gesamt: number }>> {
  const liste = await listPlans(project);
  return liste
    .filter((p) => p.aktiv || p.tasks_offen > 0)
    .map((p) => ({ kurz_id: p.kurz_id, name: p.name, aktiv: p.aktiv, offen: p.tasks_offen, gesamt: p.tasks_gesamt }));
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

interface PlanStand {
  name: string;
  description: string;
  goals: string[];
  architecture: string | null;
  tasks: ProjectTask[];
  naechste_task_nr: number | null;
}

/**
 * Liest den Plan (planId), laesst `aendern` den neuen Stand bauen und schreibt ihn nur, wenn
 * tasks seit dem Lesen unveraendert ist — sonst neu lesen, hoechstens drei Versuche.
 * Fehlende Task-Kurz-IDs werden dabei ergaenzt, aber nur, wenn der Plan schon eine Kurz-ID hat
 * (vor dem Befuellungs-Skript werden bewusst keine vergeben).
 */
async function schreibePlan<R>(
  project: string,
  planId: string,
  aendern: (stand: PlanStand, zeile: PlanZeile) => { stand: PlanStand; ergebnis: R } | null,
): Promise<{ plan: ProjectPlan; ergebnis: R; warning?: string } | null> {
  for (let versuch = 0; versuch < 3; versuch++) {
    const alle = await lesePlaene(project);
    const zeile = alle.find((z) => z.id === planId);
    if (!zeile) return null;
    const alt: PlanStand = {
      name: zeile.name,
      description: zeile.description ?? '',
      goals: zeile.goals ?? [],
      architecture: zeile.architecture,
      tasks: zeile.tasks ?? [],
      naechste_task_nr: zeile.naechste_task_nr,
    };
    const res = aendern(structuredClone(alt), zeile);
    if (!res) return null;
    let { stand } = res;
    if (zeile.kurz_id) {
      const erg = ergaenzeTaskKurzIds(zeile.kurz_id, stand.tasks as Array<Record<string, unknown>>, stand.naechste_task_nr);
      stand = { ...stand, tasks: erg.tasks as ProjectTask[], naechste_task_nr: erg.naechste_task_nr };
    }
    const jetzt = new Date().toISOString();
    const r = await getPool().query(
      `UPDATE plans SET name = $1, description = $2, goals = $3, architecture = $4, tasks = $5::jsonb,
              naechste_task_nr = $6, updated_at = $7
       WHERE id = $8 AND tasks = $9::jsonb`,
      [stand.name, stand.description, stand.goals, stand.architecture, JSON.stringify(stand.tasks),
        stand.naechste_task_nr, jetzt, planId, JSON.stringify(zeile.tasks ?? [])],
    );
    if (r.rowCount === 1) {
      const neu: PlanZeile = { ...zeile, ...stand, updated_at: jetzt };
      const plan = zuPlan(neu, alle.map((z) => (z.id === planId ? neu : z)));
      const warning = await indexNachziehen(plan);
      // Ergebnis mit den vergebenen Kurz-IDs neu aufloesen (aendern kannte sie noch nicht)
      return { plan, ergebnis: res.ergebnis, ...(warning ? { warning } : {}) };
    }
  }
  throw new Error(`Plan ${planId} wurde waehrenddessen mehrfach geaendert, nichts geschrieben. Bitte erneut versuchen.`);
}

/**
 * Aendert Tasks eines Plans (planId) optimistisch — fuer Aktionen ausserhalb dieses Moduls
 * (plan empfehlen, uebernehmen). `aendern` bekommt die aktuellen Tasks und liefert die neuen;
 * wirft es, wird nichts geschrieben. Kein Treffer (Plan weg) -> null.
 */
export async function aendereTasks<R>(
  project: string,
  planId: string,
  aendern: (tasks: ProjectTask[]) => { tasks: ProjectTask[]; ergebnis: R } | null,
): Promise<{ plan: ProjectPlan; ergebnis: R; warning?: string } | null> {
  return schreibePlan(project, planId, (stand) => {
    const r = aendern(stand.tasks);
    return r ? { stand: { ...stand, tasks: r.tasks }, ergebnis: r.ergebnis } : null;
  });
}

function neueTask(title: string, description: string, priority: ProjectTask['priority'], jetzt: string): ProjectTask {
  return { id: uuidv4(), title, description, status: 'todo', priority, createdAt: jetzt, updatedAt: jetzt };
}

/**
 * Erstellt einen Plan. Kurz-ID = naechste freie P-Nummer (nur wenn alle vorhandenen Plaene
 * schon eine haben — sonst vergibt sie das Befuellungs-Skript in created_at-Reihenfolge).
 * Erster Plan des Projekts ist aktiv; weitere nur mit optionen.aktiv. Ist noch keiner markiert,
 * wird zuerst der bisher effektiv aktive markiert, damit der neue ihn nicht still abloest.
 */
export async function createPlan(
  project: string,
  name: string,
  description: string,
  goals: string[] = [],
  optionen: { aktiv?: boolean; architecture?: string } = {},
): Promise<ProjectPlan> {
  const alle = await lesePlaene(project);
  const alleMitKurz = alle.every((z) => planNummer(z.kurz_id) !== null);
  const maxP = alle.reduce((m, z) => Math.max(m, planNummer(z.kurz_id) ?? 0), 0);
  const kurzId = alleMitKurz ? planKurzId(maxP + 1) : null;
  const aktiv = alle.length === 0 || optionen.aktiv === true;
  const now = new Date().toISOString();
  const id = uuidv4();

  const pool = getPool();
  if (!aktiv && alle.length > 0 && !alle.some((z) => z.aktiv === true)) {
    const bisher = waehleAktiven(alle)!;
    await pool.query('UPDATE plans SET aktiv = (id = $2) WHERE project = $1', [project, bisher.id]);
  }
  // 1. PostgreSQL (Write-Primary) — fail-fast
  await pool.query(
    `INSERT INTO plans (id, project, name, description, goals, architecture, tasks, created_at, updated_at,
                        kurz_id, aktiv, naechste_task_nr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, project, name, description, goals, optionen.architecture ?? null, JSON.stringify([]), now, now,
      kurzId, aktiv, kurzId ? 1 : null],
  );
  if (aktiv && alle.length > 0) {
    await pool.query('UPDATE plans SET aktiv = (id = $2) WHERE project = $1', [project, id]);
  }

  const plan = (await getPlan(project, id))!;
  const warning = await indexNachziehen(plan);
  console.error(`[Synapse] Plan erstellt: "${name}" (${kurzId ?? id}) fuer Projekt "${project}"`);
  return { ...plan, ...(warning ? { warning } : {}) };
}

/** Macht planRef zum aktiven Plan des Projekts — EIN UPDATE, keine Sperre mit Client-Wartezeit. */
export async function aktivierePlan(project: string, planRef: string): Promise<ProjectPlan> {
  const alle = await lesePlaene(project);
  const z = findePlan(project, alle, planRef);
  if (!z) throw new Error(`Projekt ${project} hat keinen Plan.`);
  await getPool().query('UPDATE plans SET aktiv = (id = $2) WHERE project = $1', [project, z.id]);
  const plan = (await getPlan(project, z.id))!;
  await indexNachziehen(plan);
  return plan;
}

/**
 * Aktualisiert Plan-Metadaten — ohne planRef am aktiven Plan (bisheriges Verhalten).
 * Ein INAKTIVER Plan wird nicht ueberschrieben (abgeschlossen): Fehler, neuer Stand = createPlan.
 * Hat das Projekt noch keinen Plan, wird wie bisher einer angelegt (Upsert).
 */
export async function updatePlan(
  project: string,
  updates: Partial<Pick<ProjectPlan, 'name' | 'description' | 'goals' | 'architecture'>>,
  planRef?: string | null,
): Promise<ProjectPlan | null> {
  const alle = await lesePlaene(project);
  if (alle.length === 0) {
    console.error(`[Synapse] Plan-Upsert: lege neuen Plan an fuer Projekt "${project}"`);
    return await createPlan(project, updates.name ?? `Plan fuer ${project}`, updates.description ?? '', updates.goals ?? [], {
      architecture: updates.architecture,
    });
  }
  const ziel = findePlan(project, alle, planRef)!;
  if (waehleAktiven(alle)?.id !== ziel.id) {
    throw new Error(
      `Plan ${ziel.kurz_id ?? ziel.id} "${ziel.name}" ist nicht aktiv (abgeschlossen) — Name, Ziel und Architektur bleiben unveraendert. ` +
      'Neuer Stand = neuer Plan: plan(create), oder den Plan erst aktivieren: plan(aktivieren).',
    );
  }
  const r = await schreibePlan(project, ziel.id, (stand) => ({
    stand: {
      ...stand,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.description !== undefined ? { description: updates.description } : {}),
      ...(updates.goals !== undefined ? { goals: updates.goals } : {}),
      ...(updates.architecture !== undefined ? { architecture: updates.architecture ?? null } : {}),
    },
    ergebnis: null,
  }));
  if (!r) return null;
  console.error(`[Synapse] Plan aktualisiert: "${r.plan.name}"`);
  return { ...r.plan, ...(r.warning ? { warning: r.warning } : {}) };
}

/** Fuegt eine Task hinzu — ohne planRef zum aktiven Plan. null, wenn das Projekt keinen Plan hat. */
export async function addTask(
  project: string,
  title: string,
  description: string,
  priority: ProjectTask['priority'] = 'medium',
  planRef?: string | null,
): Promise<(ProjectTask & { plan_ref?: PlanRef; hinweis_plaene?: string }) | null> {
  const alle = await lesePlaene(project);
  const ziel = findePlan(project, alle, planRef);
  if (!ziel) {
    console.warn(`[Synapse] Kein Plan gefunden fuer Projekt: ${project}`);
    return null;
  }
  const task = neueTask(title, description, priority, new Date().toISOString());
  const r = await schreibePlan(project, ziel.id, (stand) => ({ stand: { ...stand, tasks: [...stand.tasks, task] }, ergebnis: task.id }));
  if (!r) return null;
  const gespeichert = r.plan.tasks.find((t) => t.id === task.id)!;
  console.error(`[Synapse] Task hinzugefuegt: "${title}"`);
  return { ...gespeichert, ...planKontext(r.plan), ...(r.warning ? { warning: r.warning } : {}) };
}

/** Fuegt mehrere Tasks atomar hinzu (ein Schreibvorgang) — ohne planRef zum aktiven Plan. */
export async function addTasksBatch(
  project: string,
  tasksInput: Array<{ title: string; description: string; priority?: ProjectTask['priority'] }>,
  planRef?: string | null,
): Promise<{ tasks: ProjectTask[]; warning?: string; plan_ref?: PlanRef; hinweis_plaene?: string }> {
  if (tasksInput.length === 0) return { tasks: [] };
  const alle = await lesePlaene(project);
  const ziel = findePlan(project, alle, planRef);
  if (!ziel) {
    console.warn(`[Synapse] Kein Plan gefunden fuer Projekt: ${project}`);
    return { tasks: [] };
  }
  const jetzt = new Date().toISOString();
  const neu = tasksInput.map((t) => neueTask(t.title, t.description, t.priority ?? 'medium', jetzt));
  const r = await schreibePlan(project, ziel.id, (stand) => ({ stand: { ...stand, tasks: [...stand.tasks, ...neu] }, ergebnis: null }));
  if (!r) return { tasks: [] };
  const ids = new Set(neu.map((t) => t.id));
  const gespeichert = r.plan.tasks.filter((t) => ids.has(t.id));
  console.error(`[Synapse] ${gespeichert.length} Tasks hinzugefuegt (Batch)`);
  return { tasks: gespeichert, ...(r.warning ? { warning: r.warning } : {}), ...planKontext(r.plan) };
}

/**
 * Findet eine Task: "P<n>-T<m>" -> in Plan P<n>; UUID -> im genannten Plan, sonst in allen
 * Plaenen des Projekts (aktiver zuerst). Passt eine Kurz-ID nicht zum genannten planRef: Error.
 */
function findeTask(project: string, alle: PlanZeile[], taskRef: string, planRef?: string | null): { plan: PlanZeile; task: ProjectTask } | null {
  const ref = taskRef.trim();
  const kurz = taskNummer(ref);
  if (kurz) {
    const plan = alle.find((z) => planNummer(z.kurz_id) === kurz.plan);
    if (planRef) {
      const genannt = findePlan(project, alle, planRef)!;
      if (!plan || plan.id !== genannt.id) {
        throw new Error(`Task ${ref} gehoert nicht zu Plan ${genannt.kurz_id ?? genannt.id} "${genannt.name}".`);
      }
    }
    const task = plan?.tasks?.find((t) => typeof t.kurz_id === 'string' && t.kurz_id.toUpperCase() === ref.toUpperCase());
    return plan && task ? { plan, task } : null;
  }
  const kandidaten = planRef
    ? [findePlan(project, alle, planRef)!]
    : [waehleAktiven(alle), ...alle].filter((z): z is PlanZeile => !!z);
  for (const plan of kandidaten) {
    const task = plan.tasks?.find((t) => t.id === ref);
    if (task) return { plan, task };
  }
  return null;
}

/** Aktualisiert eine Task (UUID oder P<n>-T<m>). null, wenn es sie nicht gibt (wie bisher). */
export async function updateTask(
  project: string,
  taskId: string,
  updates: Partial<Pick<ProjectTask, 'title' | 'description' | 'status' | 'priority'>>,
  planRef?: string | null,
): Promise<(ProjectTask & { plan_ref?: PlanRef; hinweis_plaene?: string }) | null> {
  const alle = await lesePlaene(project);
  const fund = findeTask(project, alle, taskId, planRef);
  if (!fund) {
    console.warn(`[Synapse] Task nicht gefunden: ${taskId}`);
    return null;
  }
  const zielId = fund.task.id;
  const r = await schreibePlan(project, fund.plan.id, (stand) => {
    const i = stand.tasks.findIndex((t) => t.id === zielId);
    if (i === -1) return null;
    const tasks = [...stand.tasks];
    tasks[i] = { ...tasks[i], ...updates, updatedAt: new Date().toISOString() };
    return { stand: { ...stand, tasks }, ergebnis: null };
  });
  if (!r) return null;
  const gespeichert = r.plan.tasks.find((t) => t.id === zielId)!;
  console.error(`[Synapse] Task aktualisiert: "${gespeichert.title}"`);
  return { ...gespeichert, ...planKontext(r.plan), ...(r.warning ? { warning: r.warning } : {}) };
}

/** Loescht Tasks (UUID oder P<n>-T<m>), auch ueber mehrere Plaene; je Plan ein Schreibvorgang. */
export async function deleteTasks(
  project: string,
  taskIds: string[],
  planRef?: string | null,
): Promise<{ deleted: number; warning?: string; plan_refs?: PlanRef[] }> {
  if (taskIds.length === 0) return { deleted: 0 };
  const alle = await lesePlaene(project);
  const jePlan = new Map<string, Set<string>>();
  for (const ref of taskIds) {
    const fund = findeTask(project, alle, ref, planRef);
    if (!fund) continue;
    const menge = jePlan.get(fund.plan.id) ?? new Set<string>();
    menge.add(fund.task.id);
    jePlan.set(fund.plan.id, menge);
  }
  if (jePlan.size === 0) {
    console.warn(`[Synapse] Kein Plan/keine Task gefunden fuer Projekt: ${project}`);
    return { deleted: 0 };
  }
  let deleted = 0;
  const warnungen: string[] = [];
  const refs: PlanRef[] = [];
  for (const [planId, ids] of jePlan) {
    const r = await schreibePlan(project, planId, (stand) => {
      const tasks = stand.tasks.filter((t) => !ids.has(t.id));
      return { stand: { ...stand, tasks }, ergebnis: stand.tasks.length - tasks.length };
    });
    if (!r) continue;
    deleted += r.ergebnis;
    refs.push(planRefVon(r.plan));
    if (r.warning) warnungen.push(r.warning);
  }
  console.error(`[Synapse] ${deleted} Tasks geloescht`);
  return { deleted, ...(warnungen.length ? { warning: warnungen.join('; ') } : {}), plan_refs: refs };
}

/** Loescht einen Plan (ohne planRef den aktiven) aus PostgreSQL + Qdrant */
export async function deletePlan(project: string, planRef?: string | null): Promise<{ success: boolean; warning?: string }> {
  const alle = await lesePlaene(project);
  const plan = findePlan(project, alle, planRef);
  if (!plan) return { success: false };

  await getPool().query('DELETE FROM plans WHERE id = $1', [plan.id]);
  let warning: string | undefined;
  try {
    await deleteVector(COLLECTIONS.projectPlans(project), plan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Plan-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }
  console.error(`[Synapse] Plan geloescht fuer Projekt: ${project}`);
  return { success: true, warning };
}

export { taskKurzId };
