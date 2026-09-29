/**
 * Synapse MCP - Plan Tools
 * Projekt-Plaene verwalten. Mehrere Plaene je Projekt (Task 137fabaf): planRef = Plan-UUID
 * oder Kurz-ID "P<n>"; ohne planRef wirkt der aktive Plan (bisheriges Verhalten). Antworten
 * tragen zusaetzlich plan_ref und bei mehreren Plaenen hinweis_plaene.
 */

import {
  getPlan,
  updatePlan,
  addTask,
  addTasksBatch,
  updateTask,
  deleteTasks,
  listPlans,
  createPlan,
  aktivierePlan,
  planKontext,
} from '@synapse/core';

import type { ProjectPlan, ProjectTask, PlanRef, PlanListenEintrag } from '@synapse/core';

/**
 * Ruft den Projekt-Plan ab (ohne planRef den aktiven)
 */
export async function getProjectPlan(project: string, planRef?: string): Promise<{
  success: boolean;
  plan: ProjectPlan | null;
  message: string;
  plan_ref?: PlanRef;
  hinweis_plaene?: string;
}> {
  try {
    const plan = await getPlan(project, planRef);

    if (!plan) {
      return {
        success: false,
        plan: null,
        message: `Kein Plan gefunden fuer Projekt: ${project}`,
      };
    }

    return {
      success: true,
      plan,
      message: `Plan "${plan.name}" geladen`,
      ...planKontext(plan),
    };
  } catch (error) {
    return {
      success: false,
      plan: null,
      message: `Fehler beim Laden des Plans: ${error}`,
    };
  }
}

/**
 * Aktualisiert den Projekt-Plan (ohne planRef den aktiven; inaktive Plaene sind abgeschlossen)
 */
export async function updateProjectPlan(
  project: string,
  updates: {
    name?: string;
    description?: string;
    goals?: string[];
    architecture?: string;
  },
  planRef?: string,
): Promise<{
  success: boolean;
  plan: ProjectPlan | null;
  message: string;
  plan_ref?: PlanRef;
  hinweis_plaene?: string;
}> {
  try {
    const plan = await updatePlan(project, updates, planRef);

    if (!plan) {
      return {
        success: false,
        plan: null,
        message: `Kein Plan gefunden fuer Projekt: ${project}`,
      };
    }

    return {
      success: true,
      plan,
      message: `Plan aktualisiert`,
      ...planKontext(plan),
    };
  } catch (error) {
    return {
      success: false,
      plan: null,
      message: `Fehler beim Aktualisieren des Plans: ${error}`,
    };
  }
}

/**
 * Fuegt eine Task zum Plan hinzu (ohne planRef zum aktiven)
 */
export async function addPlanTask(
  project: string,
  title: string,
  description: string,
  priority: 'low' | 'medium' | 'high' = 'medium',
  planRef?: string,
): Promise<{
  success: boolean;
  task: ProjectTask | null;
  message: string;
  plan_ref?: PlanRef;
  hinweis_plaene?: string;
}> {
  try {
    const task = await addTask(project, title, description, priority, planRef);

    if (!task) {
      return {
        success: false,
        task: null,
        message: `Kein Plan gefunden fuer Projekt: ${project}`,
      };
    }

    return {
      success: true,
      task,
      message: `Task "${title}" hinzugefuegt${task.kurz_id ? ` (${task.kurz_id})` : ''}`,
      ...(task.plan_ref ? { plan_ref: task.plan_ref } : {}),
      ...(task.hinweis_plaene ? { hinweis_plaene: task.hinweis_plaene } : {}),
    };
  } catch (error) {
    return {
      success: false,
      task: null,
      message: `Fehler beim Hinzufuegen der Task: ${error}`,
    };
  }
}

/**
 * Fuegt mehrere Tasks atomar zum Plan hinzu (Batch)
 */
export async function addPlanTasksBatch(
  project: string,
  tasksInput: Array<{ title: string; description: string; priority?: 'low' | 'medium' | 'high' }>,
  planRef?: string,
): Promise<{
  success: boolean;
  count: number;
  tasks: ProjectTask[];
  warning?: string;
  message: string;
  plan_ref?: PlanRef;
  hinweis_plaene?: string;
}> {
  try {
    if (tasksInput.length === 0) {
      return { success: false, count: 0, tasks: [], message: 'tasks darf nicht leer sein' };
    }
    if (tasksInput.length > 50) {
      return { success: false, count: 0, tasks: [], message: `Batch-Limit: Max 50 Tasks pro Call. Erhalten: ${tasksInput.length}` };
    }

    const result = await addTasksBatch(project, tasksInput, planRef);
    if (result.tasks.length === 0) {
      return { success: false, count: 0, tasks: [], message: `Kein Plan gefunden fuer Projekt: ${project}` };
    }

    return {
      success: true,
      count: result.tasks.length,
      tasks: result.tasks,
      warning: result.warning,
      message: `${result.tasks.length} Tasks hinzugefuegt`,
      ...(result.plan_ref ? { plan_ref: result.plan_ref } : {}),
      ...(result.hinweis_plaene ? { hinweis_plaene: result.hinweis_plaene } : {}),
    };
  } catch (error) {
    return {
      success: false,
      count: 0,
      tasks: [],
      message: `Fehler beim Batch-Hinzufuegen der Tasks: ${error}`,
    };
  }
}


/**
 * Aktualisiert eine Task (UUID oder Kurz-ID P<n>-T<m>; UUID ohne planRef in allen Plaenen)
 */
export async function updatePlanTask(
  project: string,
  taskId: string,
  updates: {
    title?: string;
    description?: string;
    status?: 'todo' | 'in_progress' | 'done' | 'blocked';
    priority?: 'low' | 'medium' | 'high';
  },
  planRef?: string,
): Promise<{
  success: boolean;
  task: ProjectTask | null;
  message: string;
  plan_ref?: PlanRef;
  hinweis_plaene?: string;
}> {
  try {
    const task = await updateTask(project, taskId, updates, planRef);

    if (!task) {
      return {
        success: false,
        task: null,
        message: `Task nicht gefunden: ${taskId}`,
      };
    }

    return {
      success: true,
      task,
      message: `Task aktualisiert`,
      ...(task.plan_ref ? { plan_ref: task.plan_ref } : {}),
      ...(task.hinweis_plaene ? { hinweis_plaene: task.hinweis_plaene } : {}),
    };
  } catch (error) {
    return {
      success: false,
      task: null,
      message: `Fehler beim Aktualisieren der Task: ${error}`,
    };
  }
}

/**
 * Loescht eine oder mehrere Tasks (UUID oder Kurz-ID)
 */
export async function deletePlanTasks(
  project: string,
  taskIds: string[],
  planRef?: string,
): Promise<{
  success: boolean;
  deleted: number;
  warning?: string;
  message: string;
  plan_refs?: PlanRef[];
}> {
  try {
    if (taskIds.length === 0) {
      return { success: false, deleted: 0, message: 'taskIds darf nicht leer sein' };
    }
    if (taskIds.length > 50) {
      return { success: false, deleted: 0, message: `Batch-Limit: Max 50 Task-IDs pro Call. Erhalten: ${taskIds.length}` };
    }

    const result = await deleteTasks(project, taskIds, planRef);
    if (result.deleted === 0) {
      return { success: false, deleted: 0, message: `Keine passende Task gefunden in Projekt: ${project}` };
    }
    return {
      success: true,
      deleted: result.deleted,
      warning: result.warning,
      message: `${result.deleted} Tasks geloescht`,
      ...(result.plan_refs ? { plan_refs: result.plan_refs } : {}),
    };
  } catch (error) {
    return {
      success: false,
      deleted: 0,
      message: `Fehler beim Loeschen der Tasks: ${error}`,
    };
  }
}

/**
 * Alle Plaene des Projekts mit Kurz-ID, Name, Ziel, aktiv, offen/erledigt (ohne Tasks)
 */
export async function listProjectPlans(project: string): Promise<{
  success: boolean;
  plaene: PlanListenEintrag[];
  aktiver_plan?: string | null;
  message: string;
}> {
  try {
    const plaene = await listPlans(project);
    const aktiv = plaene.find((p) => p.aktiv);
    return {
      success: true,
      plaene,
      aktiver_plan: aktiv ? (aktiv.kurz_id ?? aktiv.id) : null,
      message: plaene.length === 0
        ? `Keine Plaene im Projekt ${project}`
        : `${plaene.length} Plan/Plaene; ohne plan_id wirkt der aktive (${aktiv?.kurz_id ?? aktiv?.id ?? '-'})`,
    };
  } catch (error) {
    return { success: false, plaene: [], message: `Fehler beim Auflisten der Plaene: ${error}` };
  }
}

/**
 * Legt einen neuen Plan an (neuer Stand = neuer Plan, der alte bleibt abrufbar)
 */
export async function createProjectPlan(
  project: string,
  eingabe: { name: string; description?: string; goals?: string[]; architecture?: string; aktiv?: boolean },
): Promise<{ success: boolean; plan: ProjectPlan | null; message: string; plan_ref?: PlanRef; hinweis_plaene?: string }> {
  try {
    const plan = await createPlan(project, eingabe.name, eingabe.description ?? '', eingabe.goals ?? [], {
      aktiv: eingabe.aktiv === true,
      architecture: eingabe.architecture,
    });
    return {
      success: true,
      plan,
      message: `Plan ${plan.kurz_id ?? plan.id} "${plan.name}" angelegt${plan.aktiv ? ' und aktiv' : ' (nicht aktiv — plan(aktivieren) schaltet um)'}`,
      ...planKontext(plan),
    };
  } catch (error) {
    return { success: false, plan: null, message: `Fehler beim Anlegen des Plans: ${error}` };
  }
}

/**
 * Macht einen Plan zum aktiven Plan des Projekts
 */
export async function activateProjectPlan(project: string, planRef: string): Promise<{
  success: boolean;
  plan_ref?: PlanRef;
  message: string;
}> {
  try {
    const plan = await aktivierePlan(project, planRef);
    return {
      success: true,
      plan_ref: planKontext(plan).plan_ref,
      message: `Plan ${plan.kurz_id ?? plan.id} "${plan.name}" ist jetzt aktiv (gilt fuer Aufrufe ohne plan_id)`,
    };
  } catch (error) {
    return { success: false, message: `Fehler beim Aktivieren: ${error}` };
  }
}
