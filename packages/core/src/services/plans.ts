/**
 * MODUL: Projekt-Plan-System
 * ZWECK: Verwaltet Projekt-Plaene mit Zielen, Architektur und Tasks in Qdrant
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator (1 Plan pro Projekt)
 *   - name: string - Plan-Name
 *   - description: string - Plan-Beschreibung
 *   - goals: string[] - Liste der Projektziele
 *   - updates: Partial<ProjectPlan> - Teil-Updates fuer Plan
 *   - title, description, priority: Task-Parameter
 *   - taskId: string - Task-ID fuer Updates
 *
 * OUTPUT:
 *   - ProjectPlan: Erstellter/aktualisierter Plan mit Tasks
 *   - ProjectPlan | null: Plan oder null wenn nicht gefunden
 *   - ProjectTask | null: Erstellte/aktualisierte Task
 *   - boolean: Erfolg bei Plan-Loeschung
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Schreibt/loescht in per-Projekt Collection "project_{name}_plans"
 *   - Logs: Konsolenausgabe bei CRUD-Operationen
 *
 * ABHÄNGIGKEITEN:
 *   - ../types/index.js (intern) - ProjectPlan, ProjectTask, ProjectPlanPayload Typen
 *   - ../qdrant/index.js (intern) - Collection und Vektor-Operationen
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Nur 1 Plan pro Projekt erlaubt (getPlan gibt ersten Treffer zurueck)
 *   - Embedding basiert auf Name + Description + Goals (nicht Tasks)
 *   - Task-Updates erfordern komplettes Plan-Neuschreiben (Delete+Insert)
 *   - Task-Status: 'todo' | 'in_progress' | 'done'
 *   - Task-Priority: 'low' | 'medium' | 'high'
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
  scrollVectors,
  deleteVector,
  getVector,
} from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';
import { getPool } from '../db/client.js';

/**
 * Erstellt einen neuen Projekt-Plan
 */
export async function createPlan(
  project: string,
  name: string,
  description: string,
  goals: string[] = []
): Promise<ProjectPlan> {
  // Collection sicherstellen
  await ensureCollection(COLLECTIONS.projectPlans(project));

  const now = new Date().toISOString();

  const plan: ProjectPlan = {
    id: uuidv4(),
    project,
    name,
    description,
    goals,
    tasks: [],
    createdAt: now,
    updatedAt: now,
  };

  // Embedding aus Beschreibung + Goals generieren
  const textForEmbedding = `${name}\n${description}\n${goals.join('\n')}`;
  const vector = await embed(textForEmbedding);

  const payload: ProjectPlanPayload = {
    project: plan.project,
    name: plan.name,
    description: plan.description,
    goals: plan.goals,
    architecture: plan.architecture,
    tasks: plan.tasks,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `INSERT INTO plans (id, project, name, description, goals, architecture, tasks, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       name = $3, description = $4, goals = $5, tasks = $7, updated_at = $9`,
    [plan.id, project, name, description, goals, null, JSON.stringify([]), plan.createdAt, plan.updatedAt]
  );

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    await insertVector(COLLECTIONS.projectPlans(project), vector, payload, plan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Plan-Write fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Plan erstellt: "${name}" fuer Projekt "${project}"`);
  return { ...plan, warning };
}

/**
 * Ruft den Plan fuer ein Projekt ab
 */
export async function getPlan(project: string): Promise<ProjectPlan | null> {
  const results = await scrollVectors<ProjectPlanPayload>(
    COLLECTIONS.projectPlans(project),
    {
      must: [
        {
          key: 'project',
          match: { value: project },
        },
      ],
    },
    1
  );

  if (results.length === 0) {
    return null;
  }

  const r = results[0];
  return {
    id: r.id,
    project: r.payload.project,
    name: r.payload.name,
    description: r.payload.description,
    goals: r.payload.goals,
    architecture: r.payload.architecture,
    tasks: r.payload.tasks,
    createdAt: r.payload.created_at,
    updatedAt: r.payload.updated_at,
  };
}

/**
 * Aktualisiert einen Plan
 */
export async function updatePlan(
  project: string,
  updates: Partial<Pick<ProjectPlan, 'name' | 'description' | 'goals' | 'architecture'>>
): Promise<ProjectPlan | null> {
  const existingPlan = await getPlan(project);

  if (!existingPlan) {
    console.warn(`[Synapse] Kein Plan gefunden fuer Projekt: ${project}`);
    return null;
  }

  // Plan aktualisieren
  const updatedPlan: ProjectPlan = {
    ...existingPlan,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const textForEmbedding = `${updatedPlan.name}\n${updatedPlan.description}\n${updatedPlan.goals.join('\n')}`;
  const vector = await embed(textForEmbedding);

  const payload: ProjectPlanPayload = {
    project: updatedPlan.project,
    name: updatedPlan.name,
    description: updatedPlan.description,
    goals: updatedPlan.goals,
    architecture: updatedPlan.architecture,
    tasks: updatedPlan.tasks,
    created_at: updatedPlan.createdAt,
    updated_at: updatedPlan.updatedAt,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `UPDATE plans SET name = $1, description = $2, goals = $3, architecture = $4, tasks = $5, updated_at = $6 WHERE id = $7`,
    [updatedPlan.name, updatedPlan.description, updatedPlan.goals, updatedPlan.architecture || null, JSON.stringify(updatedPlan.tasks), updatedPlan.updatedAt, updatedPlan.id]
  );

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    await deleteVector(COLLECTIONS.projectPlans(project), existingPlan.id);
    await insertVector(COLLECTIONS.projectPlans(project), vector, payload, updatedPlan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Plan-Update fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Plan aktualisiert: "${updatedPlan.name}"`);
  return { ...updatedPlan, warning };
}

/**
 * Fuegt eine Task zum Plan hinzu
 */
export async function addTask(
  project: string,
  title: string,
  description: string,
  priority: ProjectTask['priority'] = 'medium'
): Promise<ProjectTask | null> {
  const plan = await getPlan(project);

  if (!plan) {
    console.warn(`[Synapse] Kein Plan gefunden fuer Projekt: ${project}`);
    return null;
  }

  const now = new Date().toISOString();

  const task: ProjectTask = {
    id: uuidv4(),
    title,
    description,
    status: 'todo',
    priority,
    createdAt: now,
    updatedAt: now,
  };

  // Task hinzufuegen
  plan.tasks.push(task);
  plan.updatedAt = now;

  const textForEmbedding = `${plan.name}\n${plan.description}\n${plan.goals.join('\n')}`;
  const vector = await embed(textForEmbedding);

  const payload: ProjectPlanPayload = {
    project: plan.project,
    name: plan.name,
    description: plan.description,
    goals: plan.goals,
    architecture: plan.architecture,
    tasks: plan.tasks,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('UPDATE plans SET tasks = $1, updated_at = $2 WHERE id = $3',
    [JSON.stringify(plan.tasks), plan.updatedAt, plan.id]);

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    await deleteVector(COLLECTIONS.projectPlans(project), plan.id);
    await insertVector(COLLECTIONS.projectPlans(project), vector, payload, plan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Task-Add fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Task hinzugefuegt: "${title}"`);
  return { ...task, warning };
}

/**
 * Fuegt mehrere Tasks atomar zum Plan hinzu (Batch).
 * 1× getPlan, lokale Generierung aller Tasks, 1× UPDATE der tasks-JSONB,
 * 1× Qdrant-Re-Insert (Plan-Embedding bleibt gleich, Tasks aendern es nicht).
 */
export async function addTasksBatch(
  project: string,
  tasksInput: Array<{ title: string; description: string; priority?: ProjectTask['priority'] }>
): Promise<{ tasks: ProjectTask[]; warning?: string }> {
  if (tasksInput.length === 0) return { tasks: [] };

  const plan = await getPlan(project);
  if (!plan) {
    console.warn(`[Synapse] Kein Plan gefunden fuer Projekt: ${project}`);
    return { tasks: [] };
  }

  const now = new Date().toISOString();
  const newTasks: ProjectTask[] = tasksInput.map(t => ({
    id: uuidv4(),
    title: t.title,
    description: t.description,
    status: 'todo',
    priority: t.priority ?? 'medium',
    createdAt: now,
    updatedAt: now,
  }));

  plan.tasks.push(...newTasks);
  plan.updatedAt = now;

  // 1. PostgreSQL (Write-Primary)
  const pool = getPool();
  await pool.query('UPDATE plans SET tasks = $1, updated_at = $2 WHERE id = $3',
    [JSON.stringify(plan.tasks), plan.updatedAt, plan.id]);

  // 2. Qdrant: Plan-Embedding aus name+description+goals (Tasks nicht im Embedding-Text)
  let warning: string | undefined;
  try {
    const textForEmbedding = `${plan.name}\n${plan.description}\n${plan.goals.join('\n')}`;
    const vector = await embed(textForEmbedding);
    const payload: ProjectPlanPayload = {
      project: plan.project,
      name: plan.name,
      description: plan.description,
      goals: plan.goals,
      architecture: plan.architecture,
      tasks: plan.tasks,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
    };
    await deleteVector(COLLECTIONS.projectPlans(project), plan.id);
    await insertVector(COLLECTIONS.projectPlans(project), vector, payload, plan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Tasks-Batch-Add fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] ${newTasks.length} Tasks hinzugefuegt (Batch)`);
  return { tasks: newTasks, warning };
}


/**
 * Aktualisiert eine Task
 */
export async function updateTask(
  project: string,
  taskId: string,
  updates: Partial<Pick<ProjectTask, 'title' | 'description' | 'status' | 'priority'>>
): Promise<ProjectTask | null> {
  const plan = await getPlan(project);

  if (!plan) {
    return null;
  }

  const taskIndex = plan.tasks.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    console.warn(`[Synapse] Task nicht gefunden: ${taskId}`);
    return null;
  }

  // Task aktualisieren
  const updatedTask: ProjectTask = {
    ...plan.tasks[taskIndex],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  plan.tasks[taskIndex] = updatedTask;
  plan.updatedAt = new Date().toISOString();

  const textForEmbedding = `${plan.name}\n${plan.description}\n${plan.goals.join('\n')}`;
  const vector = await embed(textForEmbedding);

  const payload: ProjectPlanPayload = {
    project: plan.project,
    name: plan.name,
    description: plan.description,
    goals: plan.goals,
    architecture: plan.architecture,
    tasks: plan.tasks,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  };

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('UPDATE plans SET tasks = $1, updated_at = $2 WHERE id = $3',
    [JSON.stringify(plan.tasks), plan.updatedAt, plan.id]);

  // 2. Qdrant (Vektor-Index) — Warning bei Fehler, PG-Daten bleiben erhalten
  let warning: string | undefined;
  try {
    await deleteVector(COLLECTIONS.projectPlans(project), plan.id);
    await insertVector(COLLECTIONS.projectPlans(project), vector, payload, plan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Task-Update fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Task aktualisiert: "${updatedTask.title}"`);
  return { ...updatedTask, warning };
}

/**
 * Loescht eine oder mehrere Tasks aus dem Plan (atomar).
 * 1× getPlan, lokale Filterung, 1× UPDATE der tasks-JSONB,
 * 1× Qdrant-Re-Insert (Plan-Embedding bleibt gleich).
 */
export async function deleteTasks(
  project: string,
  taskIds: string[]
): Promise<{ deleted: number; warning?: string }> {
  if (taskIds.length === 0) return { deleted: 0 };

  const plan = await getPlan(project);
  if (!plan) {
    console.warn(`[Synapse] Kein Plan gefunden fuer Projekt: ${project}`);
    return { deleted: 0 };
  }

  const idSet = new Set(taskIds);
  const before = plan.tasks.length;
  plan.tasks = plan.tasks.filter(t => !idSet.has(t.id));
  const removed = before - plan.tasks.length;
  if (removed === 0) return { deleted: 0 };

  plan.updatedAt = new Date().toISOString();

  const pool = getPool();
  await pool.query('UPDATE plans SET tasks = $1, updated_at = $2 WHERE id = $3',
    [JSON.stringify(plan.tasks), plan.updatedAt, plan.id]);

  let warning: string | undefined;
  try {
    const textForEmbedding = `${plan.name}\n${plan.description}\n${plan.goals.join('\n')}`;
    const vector = await embed(textForEmbedding);
    const payload: ProjectPlanPayload = {
      project: plan.project,
      name: plan.name,
      description: plan.description,
      goals: plan.goals,
      architecture: plan.architecture,
      tasks: plan.tasks,
      created_at: plan.createdAt,
      updated_at: plan.updatedAt,
    };
    await deleteVector(COLLECTIONS.projectPlans(project), plan.id);
    await insertVector(COLLECTIONS.projectPlans(project), vector, payload, plan.id);
  } catch (error) {
    console.error('[Synapse] Qdrant Tasks-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] ${removed} Tasks geloescht`);
  return { deleted: removed, warning };
}

/**
 * Loescht einen Plan aus PostgreSQL + Qdrant
 */
export async function deletePlan(project: string): Promise<{ success: boolean; warning?: string }> {
  const plan = await getPlan(project);

  if (!plan) {
    return { success: false };
  }

  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('DELETE FROM plans WHERE id = $1', [plan.id]);

  // 2. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
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
