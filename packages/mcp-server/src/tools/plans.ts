/**
 * Synapse MCP - Plan Tools
 * Projekt-Plaene verwalten
 */

import {
  getPlan,
  updatePlan,
  addTask,
  updateTask,
} from '@synapse/core';
import type { ProjectPlan, ProjectTask } from '@synapse/core';

/**
 * Ruft den Projekt-Plan ab
 */
export async function getProjectPlan(project: string): Promise<{
  success: boolean;
  plan: ProjectPlan | null;
  message: string;
}> {
  try {
    const plan = await getPlan(project);

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
 * Aktualisiert den Projekt-Plan
 */
export async function updateProjectPlan(
  project: string,
  updates: {
    name?: string;
    description?: string;
    goals?: string[];
    architecture?: string;
  }
): Promise<{
  success: boolean;
  plan: ProjectPlan | null;
  message: string;
}> {
  try {
    const plan = await updatePlan(project, updates);

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
 * Fuegt eine Task zum Plan hinzu
 */
export async function addPlanTask(
  project: string,
  title: string,
  description: string,
  priority: 'low' | 'medium' | 'high' = 'medium'
): Promise<{
  success: boolean;
  task: ProjectTask | null;
  message: string;
}> {
  try {
    const task = await addTask(project, title, description, priority);

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
      message: `Task "${title}" hinzugefuegt`,
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
 * Aktualisiert eine Task
 */
export async function updatePlanTask(
  project: string,
  taskId: string,
  updates: {
    title?: string;
    description?: string;
    status?: 'todo' | 'in_progress' | 'done' | 'blocked';
    priority?: 'low' | 'medium' | 'high';
  }
): Promise<{
  success: boolean;
  task: ProjectTask | null;
  message: string;
}> {
  try {
    const task = await updateTask(project, taskId, updates);

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
    };
  } catch (error) {
    return {
      success: false,
      task: null,
      message: `Fehler beim Aktualisieren der Task: ${error}`,
    };
  }
}
