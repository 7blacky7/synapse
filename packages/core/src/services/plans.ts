/**
 * Synapse Core - Plans Service
 * Projekt-Plaene speichern und abrufen
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
  await ensureCollection(COLLECTIONS.projectPlans);

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

  await insertVector(COLLECTIONS.projectPlans, vector, payload, plan.id);

  console.log(`[Synapse] Plan erstellt: "${name}" fuer Projekt "${project}"`);
  return plan;
}

/**
 * Ruft den Plan fuer ein Projekt ab
 */
export async function getPlan(project: string): Promise<ProjectPlan | null> {
  const results = await scrollVectors<ProjectPlanPayload>(
    COLLECTIONS.projectPlans,
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

  // Alten loeschen, neuen einfuegen (Embedding aktualisieren)
  await deleteVector(COLLECTIONS.projectPlans, existingPlan.id);

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

  await insertVector(COLLECTIONS.projectPlans, vector, payload, updatedPlan.id);

  console.log(`[Synapse] Plan aktualisiert: "${updatedPlan.name}"`);
  return updatedPlan;
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

  // Plan aktualisieren (ohne Embedding-Aenderung)
  await deleteVector(COLLECTIONS.projectPlans, plan.id);

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

  await insertVector(COLLECTIONS.projectPlans, vector, payload, plan.id);

  console.log(`[Synapse] Task hinzugefuegt: "${title}"`);
  return task;
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

  // Plan speichern
  await deleteVector(COLLECTIONS.projectPlans, plan.id);

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

  await insertVector(COLLECTIONS.projectPlans, vector, payload, plan.id);

  console.log(`[Synapse] Task aktualisiert: "${updatedTask.title}"`);
  return updatedTask;
}

/**
 * Loescht einen Plan
 */
export async function deletePlan(project: string): Promise<boolean> {
  const plan = await getPlan(project);

  if (!plan) {
    return false;
  }

  await deleteVector(COLLECTIONS.projectPlans, plan.id);
  console.log(`[Synapse] Plan geloescht fuer Projekt: ${project}`);
  return true;
}
