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
 * VERSCHIEBEN (P3-T1): verschiebeTasks haengt Tasks ATOMAR an einen anderen Plan (ein Statement
 * ueber alle betroffenen plans-Zeilen, optimistisch wie oben). UUID und Felder bleiben, die Task
 * bekommt im Zielplan eine neue Kurz-ID; die alte(n) stehen in alias_kurz_ids und werden von
 * findeTask/findeTaskInPlan plan-uebergreifend aufgeloest. Nummern werden nie wiederverwendet.
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

/** Task traegt die (alte) Kurz-ID ref (GROSS) als Alias aus einem Verschieben? */
function hatAlias(t: ProjectTask, refGross: string): boolean {
  const a = (t as Record<string, unknown>).alias_kurz_ids;
  return Array.isArray(a) && a.some((x) => typeof x === 'string' && x.toUpperCase() === refGross);
}

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
  /** hoch | mittel | niedrig; fehlt/null = mittel (Zeilen vor der Migration) */
  prioritaet?: string | null;
  /** Wiedervorlage (P3-T3): bis dahin aus list/Onboarding ausgeblendet; fehlt/null = nicht zurueckgestellt */
  zurueckgestellt_bis?: string | Date | null;
}

/** Plan-Prioritaet (P3-T2): Reihenfolge fuer die Sortierung, kleiner = wichtiger */
export const PLAN_PRIORITAETEN = ['hoch', 'mittel', 'niedrig'] as const;
export type PlanPrioritaet = (typeof PLAN_PRIORITAETEN)[number];

/** Zeile/Eingabe -> gueltige Prioritaet; fehlt oder leer -> mittel (bei lesen=true auch Muell -> mittel) */
function prioritaetVon(x: unknown): PlanPrioritaet {
  const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
  return (PLAN_PRIORITAETEN as readonly string[]).includes(s) ? (s as PlanPrioritaet) : 'mittel';
}

/** Prueft eine EINGABE (create/update): undefined -> undefined, ungueltig -> Error, sonst normalisiert. */
export function pruefePrioritaet(x: unknown): PlanPrioritaet | undefined {
  if (x === undefined || x === null) return undefined;
  const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
  if (!(PLAN_PRIORITAETEN as readonly string[]).includes(s)) {
    throw new Error(`Ungueltige Plan-Prioritaet "${String(x)}" — erlaubt: ${PLAN_PRIORITAETEN.join(' | ')} (Parameter plan_prioritaet).`);
  }
  return s as PlanPrioritaet;
}

const PRIO_RANG: Record<PlanPrioritaet, number> = { hoch: 0, mittel: 1, niedrig: 2 };

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
  prioritaet: PlanPrioritaet;
  tasks_gesamt: number;
  tasks_offen: number;
  tasks_erledigt: number;
  created_at: string;
  updated_at: string;
  /** Nur bei zurueckgestellten Plaenen (P3-T3): sonst fehlt das Feld, alte Antwortform bleibt */
  zurueckgestellt?: boolean;
  zurueckgestellt_bis?: string;
  /** Wiedervorlage abgelaufen: Datum, an dem der Plan wieder vorgelegt wurde */
  wieder_vorgelegt_seit?: string;
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
      prioritaet: plan.prioritaet ?? 'mittel',
      ...(plan.zurueckgestellt_bis ? { zurueckgestellt_bis: plan.zurueckgestellt_bis } : {}),
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
            kurz_id, aktiv, naechste_task_nr, prioritaet, zurueckgestellt_bis
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
    prioritaet: prioritaetVon(z.prioritaet),
    ...(z.zurueckgestellt_bis ? { zurueckgestellt_bis: iso(z.zurueckgestellt_bis) } : {}),
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
    const refU = ref.toUpperCase();
    const t = plan.tasks.find((x) => typeof x.kurz_id === 'string' && x.kurz_id.toUpperCase() === refU)
      ?? plan.tasks.find((x) => hatAlias(x, refU));
    if (t) return t;
    if (planNummer(plan.kurz_id) !== kurz.plan) {
      return `Task ${ref} gehoert nicht zu Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
    }
    return t ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id}`;
  }
  return plan.tasks.find((x) => x.id === ref) ?? `Task ${ref} nicht gefunden in Plan ${plan.kurz_id ?? plan.id} "${plan.name}"`;
}

/** Optionen fuer list/Onboarding (P3-T3). jetzt nur fuer Tests. */
export interface ListenOptionen {
  /** true = auch zurueckgestellte Plaene, mit Vermerk */
  alle?: boolean;
  jetzt?: Date;
}

/** Zeitpunkt der Wiedervorlage einer Zeile als Date; fehlt/kaputt -> null */
function bisVon(z: PlanZeile): Date | null {
  if (!z.zurueckgestellt_bis) return null;
  const d = new Date(z.zurueckgestellt_bis);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Alle Plaene des Projekts ohne Tasks (plan(list)) plus Zahl der ausgeblendeten (zurueckgestellten).
 * Zurueckgestellt = zurueckgestellt_bis liegt NACH jetzt und der Plan ist nicht aktiv (der aktive
 * Plan wird nie ausgeblendet). bis == jetzt ist wieder sichtbar.
 */
export async function listPlansDetail(
  project: string,
  optionen: ListenOptionen = {},
): Promise<{ plaene: PlanListenEintrag[]; ausgeblendet: number }> {
  const jetzt = optionen.jetzt ?? new Date();
  const alle = await lesePlaene(project);
  const aktiv = waehleAktiven(alle);
  // Reihenfolge: aktiver Plan zuerst, dann hoch > mittel > niedrig, dann zuletzt geaendert
  const sortiert = [...alle].sort((a, b) =>
    (aktiv?.id === b.id ? 1 : 0) - (aktiv?.id === a.id ? 1 : 0)
    || PRIO_RANG[prioritaetVon(a.prioritaet)] - PRIO_RANG[prioritaetVon(b.prioritaet)]
    || iso(b.updated_at).localeCompare(iso(a.updated_at)));
  let ausgeblendet = 0;
  const plaene: PlanListenEintrag[] = [];
  for (const z of sortiert) {
    const istAktiv = aktiv?.id === z.id;
    const bis = istAktiv ? null : bisVon(z);
    const schlaeft = bis !== null && bis.getTime() > jetzt.getTime();
    if (schlaeft && !optionen.alle) {
      ausgeblendet++;
      continue;
    }
    const tasks = z.tasks ?? [];
    const erledigt = tasks.filter((t) => t.status === 'done').length;
    plaene.push({
      id: z.id,
      kurz_id: z.kurz_id ?? null,
      name: z.name,
      ziel: (z.description ?? '').slice(0, 200),
      aktiv: istAktiv,
      prioritaet: prioritaetVon(z.prioritaet),
      tasks_gesamt: tasks.length,
      tasks_offen: tasks.length - erledigt,
      tasks_erledigt: erledigt,
      created_at: iso(z.created_at),
      updated_at: iso(z.updated_at),
      ...(schlaeft && bis ? { zurueckgestellt: true, zurueckgestellt_bis: bis.toISOString() } : {}),
      ...(!schlaeft && bis ? { wieder_vorgelegt_seit: bis.toISOString() } : {}),
    });
  }
  return { plaene, ausgeblendet };
}

/** Alle sichtbaren Plaene des Projekts ohne Tasks (plan(list)); alle:true auch zurueckgestellte. */
export async function listPlans(project: string, optionen: ListenOptionen = {}): Promise<PlanListenEintrag[]> {
  return (await listPlansDetail(project, optionen)).plaene;
}

/** Kompakte Liste fuer das Onboarding: aktive oder offene, nicht zurueckgestellte Plaene, keine Tasks. */
export async function planUebersicht(
  project: string,
  jetzt?: Date,
): Promise<Array<{
  kurz_id: string | null; name: string; aktiv: boolean; prioritaet: PlanPrioritaet; offen: number; gesamt: number;
  wieder_vorgelegt_seit?: string;
}>> {
  const liste = await listPlans(project, { jetzt });
  return liste
    .filter((p) => p.aktiv || p.tasks_offen > 0)
    .map((p) => ({
      kurz_id: p.kurz_id, name: p.name, aktiv: p.aktiv, prioritaet: p.prioritaet, offen: p.tasks_offen, gesamt: p.tasks_gesamt,
      ...(p.wieder_vorgelegt_seit ? { wieder_vorgelegt_seit: p.wieder_vorgelegt_seit } : {}),
    }));
}

const MAX_TAGE = 3650;

/**
 * Gemeinsame Pruefung von tage/bis fuer Plaene und Tasks: liefert das Ziel-Datum (null = aufheben)
 * oder einen Fehlertext. Nichts wird geschrieben.
 */
function berechneWiedervorlage(
  eingabe: { tage?: unknown; bis?: unknown },
  jetzt: Date,
): { ziel: Date | null } | { fehler: string } {
  const hatTage = eingabe.tage !== undefined && eingabe.tage !== null && eingabe.tage !== '';
  const hatBis = eingabe.bis !== undefined && eingabe.bis !== null && eingabe.bis !== '';
  if (hatTage && hatBis) return { fehler: 'Entweder tage ODER bis angeben, nicht beides.' };
  if (!hatTage && !hatBis) return { fehler: 'tage (Anzahl Tage, 0 = aufheben) oder bis (Datum) ist Pflicht.' };
  if (hatTage) {
    const n = typeof eingabe.tage === 'number' ? eingabe.tage : Number(String(eingabe.tage).trim());
    if (!Number.isFinite(n) || n < 0 || n > MAX_TAGE) {
      return { fehler: `tage muss eine Zahl von 0 bis ${MAX_TAGE} sein (0 hebt die Zurueckstellung auf).` };
    }
    return { ziel: n === 0 ? null : new Date(jetzt.getTime() + n * 24 * 3600 * 1000) };
  }
  const d = new Date(String(eingabe.bis).trim());
  if (Number.isNaN(d.getTime())) return { fehler: `bis "${String(eingabe.bis)}" ist kein Datum (Format 2026-10-15 oder ISO-Zeitpunkt).` };
  if (d.getTime() <= jetzt.getTime()) return { fehler: 'bis liegt nicht in der Zukunft.' };
  return { ziel: d };
}

/** Wiedervorlage-Zeitpunkt einer Task; fehlt/kaputt -> null */
export function taskBis(t: ProjectTask): Date | null {
  const v = (t as unknown as Record<string, unknown>).zurueckgestellt_bis;
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Ist die Task jetzt zurueckgestellt (Wiedervorlage liegt NACH jetzt; bis == jetzt ist wieder sichtbar)? */
export function taskSchlaeft(t: ProjectTask, jetzt: Date = new Date()): boolean {
  const bis = taskBis(t);
  return bis !== null && bis.getTime() > jetzt.getTime();
}

export interface WiedervorlageFilter {
  /** true = auch zurueckgestellte Tasks, mit Vermerk zurueckgestellt:true */
  alle?: boolean;
  /** ausdrueckliche task_id(s) (UUID/Kurz-ID/Alias): diese Tasks werden immer gezeigt */
  taskIds?: string[];
  jetzt?: Date;
}

/**
 * Blendet zurueckgestellte Tasks aus (P3-T4). Tasks ohne Wiedervorlage kommen UNVERAENDERT zurueck.
 * Abgelaufene (bis <= jetzt, nicht done) tragen wieder_vorgelegt_seit; schlafende, die trotzdem
 * gezeigt werden (alle / taskIds), tragen zurueckgestellt:true.
 */
export function filtereWiedervorlageTasks(
  tasks: ProjectTask[],
  filter: WiedervorlageFilter = {},
): { tasks: ProjectTask[]; ausgeblendet: number } {
  const jetzt = filter.jetzt ?? new Date();
  const refs = new Set((filter.taskIds ?? []).map((r) => r.trim().toUpperCase()));
  const ausdruecklich = (t: ProjectTask): boolean =>
    refs.size > 0
    && (refs.has(t.id.toUpperCase())
      || (typeof t.kurz_id === 'string' && refs.has(t.kurz_id.toUpperCase()))
      || [...refs].some((r) => hatAlias(t, r)));
  let ausgeblendet = 0;
  const aus: ProjectTask[] = [];
  for (const t of tasks) {
    const bis = taskBis(t);
    if (bis === null) { aus.push(t); continue; }
    if (bis.getTime() > jetzt.getTime()) {
      if (filter.alle || ausdruecklich(t)) aus.push({ ...t, zurueckgestellt: true } as ProjectTask);
      else ausgeblendet++;
    } else if (t.status !== 'done') {
      aus.push({ ...t, wieder_vorgelegt_seit: bis.toISOString() } as ProjectTask);
    } else {
      aus.push(t);
    }
  }
  return { tasks: aus, ausgeblendet };
}

/**
 * Bug 2faebaf8: plan(get, task_id) ignorierte task_id und lieferte alle Tasks. Diese Funktion
 * begrenzt die Liste auf die genannten Tasks (UUID, Kurz-ID P<n>-T<m>, Alias-Kurz-ID nach einem
 * Verschieben; gross/klein egal). Reihenfolge = Plan-Reihenfolge, jede Task hoechstens einmal.
 * Unbekannte IDs kommen unter nichtGefunden zurueck. Ohne (verwertbare) IDs: unveraendert.
 */
export function filtereNachTaskIds(
  tasks: ProjectTask[],
  taskIds: unknown,
): { tasks: ProjectTask[]; nichtGefunden: string[]; gefiltert: boolean } {
  const refsRoh = Array.isArray(taskIds) ? taskIds : [];
  const refs = refsRoh
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (refs.length === 0) return { tasks, nichtGefunden: [], gefiltert: false };
  const treffer = (t: ProjectTask, refGross: string): boolean =>
    t.id.toUpperCase() === refGross
    || (typeof t.kurz_id === 'string' && t.kurz_id.toUpperCase() === refGross)
    || hatAlias(t, refGross);
  const gewaehlt = tasks.filter((t) => refs.some((r) => treffer(t, r.toUpperCase())));
  const nichtGefunden = refs.filter((r) => !tasks.some((t) => treffer(t, r.toUpperCase())));
  return { tasks: gewaehlt, nichtGefunden, gefiltert: true };
}

export type ZurueckstellenTaskErgebnis =
  | { success: true; plan_ref: PlanRef; task: ProjectTask; zurueckgestellt_bis: string | null; message: string; warning?: string }
  | { success: false; message: string };

/**
 * Wiedervorlage fuer eine Task (P3-T4): task_id = UUID, Kurz-ID oder Alias, plan-uebergreifend
 * (planRef optional, dann muss die Task dazu gehoeren). tage:0 hebt auf (Feld wird entfernt).
 * Erledigte Tasks koennen nicht zurueckgestellt werden. Ein optimistisches UPDATE ohne Sperre.
 */
export async function zurueckstelleTask(
  project: string,
  planRef: string | null | undefined,
  taskRef: string,
  eingabe: { tage?: unknown; bis?: unknown },
  jetzt: Date = new Date(),
): Promise<ZurueckstellenTaskErgebnis> {
  const zz = berechneWiedervorlage(eingabe, jetzt);
  if ('fehler' in zz) return { success: false, message: zz.fehler };
  const ziel = zz.ziel;
  try {
    const alle = await lesePlaene(project);
    const fund = findeTask(project, alle, String(taskRef ?? ''), planRef ?? null);
    if (!fund) return { success: false, message: `Task ${taskRef} nicht gefunden.` };
    const zielId = fund.task.id;
    const bisIso = ziel ? ziel.toISOString() : null;
    const r = await schreibePlan(project, fund.plan.id, (stand) => {
      const i = stand.tasks.findIndex((t) => t.id === zielId);
      if (i === -1) throw new Error(`Task ${taskRef} ist waehrenddessen verschwunden.`);
      if (bisIso && stand.tasks[i].status === 'done') {
        throw new Error(`Task ${stand.tasks[i].kurz_id ?? zielId} ist erledigt und kann nicht zurueckgestellt werden.`);
      }
      const tasks = [...stand.tasks];
      const neu = { ...tasks[i] } as ProjectTask & { zurueckgestellt_bis?: string };
      if (bisIso) neu.zurueckgestellt_bis = bisIso;
      else delete neu.zurueckgestellt_bis;
      tasks[i] = neu;
      return { stand: { ...stand, tasks }, ergebnis: null };
    });
    if (!r) return { success: false, message: `Task ${taskRef} ist waehrenddessen verschwunden.` };
    const task = r.plan.tasks.find((t) => t.id === zielId)!;
    const name = `${task.kurz_id ?? task.id} "${task.title}"`;
    return {
      success: true,
      plan_ref: planRefVon(r.plan),
      task,
      zurueckgestellt_bis: bisIso,
      message: bisIso ? `Task ${name} zurueckgestellt bis ${bisIso}.` : `Zurueckstellung von Task ${name} aufgehoben.`,
      ...(r.warning ? { warning: r.warning } : {}),
    };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type ZurueckstellenErgebnis =
  | { success: true; plan_ref: PlanRef; zurueckgestellt_bis: string | null; message: string; warning?: string }
  | { success: false; message: string };

/**
 * Wiedervorlage fuer einen Plan (P3-T3): bis = jetzt + tage Tage oder ein Datum (bis). tage:0 hebt
 * die Zurueckstellung auf. Der AKTIVE Plan kann nicht zurueckgestellt werden. EIN schreibendes
 * Statement (updated_at/Tasks bleiben), keine Sperre; Qdrant-Index wird nachgezogen.
 * Fehler kommen als success:false, nichts wird geschrieben.
 */
export async function zurueckstellePlan(
  project: string,
  planRef: string | null | undefined,
  eingabe: { tage?: unknown; bis?: unknown },
  jetzt: Date = new Date(),
): Promise<ZurueckstellenErgebnis> {
  const zz = berechneWiedervorlage(eingabe, jetzt);
  if ('fehler' in zz) return { success: false, message: zz.fehler };
  const ziel = zz.ziel;

  const alle = await lesePlaene(project);
  let z: PlanZeile | null;
  try {
    z = findePlan(project, alle, planRef);
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!z) return { success: false, message: `Projekt ${project} hat keinen Plan.` };
  if (ziel !== null && waehleAktiven(alle)?.id === z.id) {
    return {
      success: false,
      message: `Plan ${z.kurz_id ?? z.id} "${z.name}" ist der AKTIVE Plan und kann nicht zurueckgestellt werden. Erst einen anderen aktivieren: plan(aktivieren).`,
    };
  }

  const bisIso = ziel ? ziel.toISOString() : null;
  await getPool().query('UPDATE plans SET zurueckgestellt_bis = $1 WHERE id = $2', [bisIso, z.id]);
  const neu: PlanZeile = { ...z, zurueckgestellt_bis: bisIso };
  const plan = zuPlan(neu, alle.map((x) => (x.id === z.id ? neu : x)));
  const warning = await indexNachziehen(plan);
  const name = `${z.kurz_id ?? z.id} "${z.name}"`;
  return {
    success: true,
    plan_ref: planRefVon(plan),
    zurueckgestellt_bis: bisIso,
    message: bisIso ? `Plan ${name} zurueckgestellt bis ${bisIso}.` : `Zurueckstellung von Plan ${name} aufgehoben.`,
    ...(warning ? { warning } : {}),
  };
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
  optionen: { aktiv?: boolean; architecture?: string; prioritaet?: string } = {},
): Promise<ProjectPlan> {
  const prioritaet = pruefePrioritaet(optionen.prioritaet) ?? 'mittel'; // ungueltig -> Error, nichts geschrieben
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
                        kurz_id, aktiv, naechste_task_nr, prioritaet)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, project, name, description, goals, optionen.architecture ?? null, JSON.stringify([]), now, now,
      kurzId, aktiv, kurzId ? 1 : null, prioritaet],
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
  updates: Partial<Pick<ProjectPlan, 'name' | 'description' | 'goals' | 'architecture'>> & { prioritaet?: string },
  planRef?: string | null,
): Promise<ProjectPlan | null> {
  const { prioritaet: prioEingabe, ...metadaten } = updates;
  const prioritaet = pruefePrioritaet(prioEingabe); // ungueltig -> Error, nichts geschrieben
  const alle = await lesePlaene(project);
  if (alle.length === 0) {
    console.error(`[Synapse] Plan-Upsert: lege neuen Plan an fuer Projekt "${project}"`);
    return await createPlan(project, updates.name ?? `Plan fuer ${project}`, updates.description ?? '', updates.goals ?? [], {
      architecture: updates.architecture,
      prioritaet,
    });
  }
  const ziel = findePlan(project, alle, planRef)!;
  const nurPrioritaet = prioritaet !== undefined && Object.values(metadaten).every((v) => v === undefined);
  if (nurPrioritaet && waehleAktiven(alle)?.id !== ziel.id) {
    // Inaktiver Plan: nur die Prioritaet ist aenderbar — EIN Statement, updated_at/Tasks bleiben
    await getPool().query('UPDATE plans SET prioritaet = $1 WHERE id = $2', [prioritaet, ziel.id]);
    const neu: PlanZeile = { ...ziel, prioritaet };
    const plan = zuPlan(neu, alle.map((z) => (z.id === ziel.id ? neu : z)));
    const warning = await indexNachziehen(plan);
    console.error(`[Synapse] Plan-Prioritaet gesetzt: "${plan.name}" = ${prioritaet}`);
    return { ...plan, ...(warning ? { warning } : {}) };
  }
  if (waehleAktiven(alle)?.id !== ziel.id) {
    throw new Error(
      `Plan ${ziel.kurz_id ?? ziel.id} "${ziel.name}" ist nicht aktiv (abgeschlossen) — Name, Ziel und Architektur bleiben unveraendert. ` +
      'Neuer Stand = neuer Plan: plan(create), oder den Plan erst aktivieren: plan(aktivieren).',
    );
  }
  // Prioritaet zuerst (eigenes Statement, aendert updated_at nicht) — schreibePlan liest danach
  // neu und zieht den Index schon mit der neuen Prioritaet nach.
  if (prioritaet !== undefined) {
    await getPool().query('UPDATE plans SET prioritaet = $1 WHERE id = $2', [prioritaet, ziel.id]);
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
    const refU = ref.toUpperCase();
    let plan = alle.find((z) => planNummer(z.kurz_id) === kurz.plan);
    let task = plan?.tasks?.find((t) => typeof t.kurz_id === 'string' && t.kurz_id.toUpperCase() === refU);
    if (!task) {
      // Alte Kurz-ID einer verschobenen Task (P3-T1): plan-uebergreifend ueber alias_kurz_ids
      for (const z of alle) {
        const t = z.tasks?.find((x) => hatAlias(x, refU));
        if (t) { plan = z; task = t; break; }
      }
    }
    if (planRef) {
      const genannt = findePlan(project, alle, planRef)!;
      if (!plan || plan.id !== genannt.id) {
        throw new Error(`Task ${ref} gehoert nicht zu Plan ${genannt.kurz_id ?? genannt.id} "${genannt.name}".`);
      }
    }
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

export interface VerschiebeErgebnis {
  success: boolean;
  message?: string;
  verschoben: Array<{ id: string; title: string; alt_kurz_id: string | null; neu_kurz_id: string | null; von_plan: string | null }>;
  uebersprungen: Array<{ task_id: string; grund: string }>;
  ziel?: PlanRef;
  warning?: string;
}

/**
 * Verschiebt Tasks (UUID oder Kurz-ID, auch alte Aliase) in den Plan zielRef. ATOMAR: ein
 * einziges Statement schreibt alle betroffenen plans-Zeilen oder keine (Zeilen werden nur
 * innerhalb des Statements gesperrt, kein Client-Warten); hat sich eine Zeile seit dem Lesen
 * geaendert, wird neu gelesen (hoechstens drei Versuche). Bleibt gleich: UUID, Titel,
 * Beschreibung, Status, Prioritaet, empfehlung, zugewiesen_an, createdAt und alle weiteren
 * Felder. Neu: kurz_id aus dem Zaehler des Zielplans; die alte steht in alias_kurz_ids.
 * Fehler (unbekannter Plan/Task, Ziel ohne Kurz-ID) -> success:false, nichts geschrieben.
 */
export async function verschiebeTasks(
  project: string,
  taskRefs: string | string[],
  zielRef: string | null | undefined,
): Promise<VerschiebeErgebnis> {
  const leer = { verschoben: [], uebersprungen: [] };
  const fehler = (message: string): VerschiebeErgebnis => ({ success: false, message, ...leer });
  const refs = (Array.isArray(taskRefs) ? taskRefs : [taskRefs]).map((r) => String(r ?? '').trim()).filter(Boolean);
  if (refs.length === 0) return fehler('task_id (String oder Array) ist erforderlich');
  if (!zielRef || !zielRef.trim()) return fehler('ziel (Plan-UUID oder Kurz-ID P<n>) ist erforderlich');

  for (let versuch = 0; versuch < 3; versuch++) {
    const alle = await lesePlaene(project);
    let ziel: PlanZeile | null;
    try {
      ziel = findePlan(project, alle, zielRef.trim());
    } catch (e) {
      return fehler(e instanceof Error ? e.message : String(e));
    }
    if (!ziel) return fehler(`Projekt ${project} hat keinen Plan.`);
    if (!ziel.kurz_id) {
      return fehler(`Zielplan ${ziel.id} "${ziel.name}" hat noch keine Kurz-ID (Bestand vor dem Befuellungs-Skript) — Verschieben nicht moeglich.`);
    }

    const gefunden = new Map<string, { plan: PlanZeile; task: ProjectTask }>();
    const unbekannt: string[] = [];
    for (const ref of refs) {
      let fund: { plan: PlanZeile; task: ProjectTask } | null;
      try {
        fund = findeTask(project, alle, ref, null);
      } catch (e) {
        return fehler(e instanceof Error ? e.message : String(e));
      }
      if (!fund) unbekannt.push(ref);
      else if (!gefunden.has(fund.task.id)) gefunden.set(fund.task.id, fund);
    }
    if (unbekannt.length > 0) {
      return fehler(`Task nicht gefunden: ${unbekannt.join(', ')} — nichts verschoben. Uebersicht: plan(get, plan_id).`);
    }

    const uebersprungen: VerschiebeErgebnis['uebersprungen'] = [];
    const zuVerschieben: Array<{ plan: PlanZeile; task: ProjectTask }> = [];
    for (const fund of gefunden.values()) {
      if (fund.plan.id === ziel.id) {
        uebersprungen.push({ task_id: fund.task.id, grund: `liegt schon in Plan ${ziel.kurz_id}` });
      } else {
        zuVerschieben.push(fund);
      }
    }
    if (zuVerschieben.length === 0) {
      return { success: true, verschoben: [], uebersprungen, ziel: planRefVon(zuPlan(ziel, alle)) };
    }

    // Neue Staende: Quellplaene ohne die Tasks (Zaehler unveraendert), Ziel mit neuen Kurz-IDs
    const weg = new Set(zuVerschieben.map((f) => f.task.id));
    const staende = new Map<string, { zeile: PlanZeile; tasks: ProjectTask[]; nr: number | null }>();
    for (const f of zuVerschieben) {
      if (staende.has(f.plan.id)) continue;
      staende.set(f.plan.id, {
        zeile: f.plan,
        tasks: (f.plan.tasks ?? []).filter((t) => !weg.has(t.id)),
        nr: f.plan.naechste_task_nr,
      });
    }
    const basis = ergaenzeTaskKurzIds(ziel.kurz_id, (ziel.tasks ?? []) as Array<Record<string, unknown>>, ziel.naechste_task_nr);
    let naechste = basis.naechste_task_nr;
    const zielTasks = [...(basis.tasks as ProjectTask[])];
    const verschoben: VerschiebeErgebnis['verschoben'] = [];
    for (const f of zuVerschieben) {
      const { kurz_id: altKurz, ...rest } = f.task as ProjectTask & { kurz_id?: string };
      const alt = typeof altKurz === 'string' && altKurz ? altKurz : null;
      const alias = [...new Set([...(((rest as Record<string, unknown>).alias_kurz_ids as string[] | undefined) ?? []), ...(alt ? [alt] : [])])];
      const neuKurz = taskKurzId(ziel.kurz_id, naechste++);
      zielTasks.push({ ...rest, kurz_id: neuKurz, ...(alias.length ? { alias_kurz_ids: alias } : {}) } as ProjectTask);
      verschoben.push({ id: f.task.id, title: f.task.title, alt_kurz_id: alt, neu_kurz_id: neuKurz, von_plan: f.plan.kurz_id ?? f.plan.id });
    }
    staende.set(ziel.id, { zeile: ziel, tasks: zielTasks, nr: naechste });

    const ids = [...staende.keys()];
    const jetzt = new Date().toISOString();
    const r = await getPool().query(
      `WITH neu AS (
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[]) AS t(id, tasks, nr, alt)
       ), gesperrt AS (
         SELECT p.id FROM plans p JOIN neu ON p.id::text = neu.id AND p.tasks = neu.alt::jsonb
         ORDER BY p.id FOR UPDATE OF p
       ), upd AS (
         UPDATE plans p SET tasks = neu.tasks::jsonb, naechste_task_nr = neu.nr, updated_at = $5::timestamptz
         FROM neu
         WHERE p.id::text = neu.id AND p.id IN (SELECT id FROM gesperrt) AND (SELECT count(*) FROM gesperrt) = $6::int
         RETURNING p.id
       )
       SELECT id FROM upd`,
      [
        ids,
        ids.map((id) => JSON.stringify(staende.get(id)!.tasks)),
        ids.map((id) => staende.get(id)!.nr),
        ids.map((id) => JSON.stringify(staende.get(id)!.zeile.tasks ?? [])),
        jetzt,
        ids.length,
      ],
    );
    if (r.rowCount !== ids.length) continue; // gleichzeitig geaendert -> neu lesen

    const neuZeilen = alle.map((z) => {
      const s = staende.get(z.id);
      return s ? { ...z, tasks: s.tasks, naechste_task_nr: s.nr, updated_at: jetzt } : z;
    });
    const warnungen: string[] = [];
    for (const id of ids) {
      const w = await indexNachziehen(zuPlan(neuZeilen.find((z) => z.id === id)!, neuZeilen));
      if (w) warnungen.push(w);
    }
    console.error(`[Synapse] ${verschoben.length} Task(s) nach Plan ${ziel.kurz_id} verschoben`);
    return {
      success: true,
      verschoben,
      uebersprungen,
      ziel: planRefVon(zuPlan(neuZeilen.find((z) => z.id === ziel!.id)!, neuZeilen)),
      ...(warnungen.length ? { warning: warnungen.join('; ') } : {}),
    };
  }
  return fehler('Plaene wurden waehrenddessen mehrfach geaendert, nichts verschoben. Bitte erneut versuchen.');
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
