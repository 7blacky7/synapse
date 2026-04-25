/**
 * Synapse MCP - Konsolidiertes Plan-Tool
 * Konsolidiert: get_project_plan, update_project_plan, add_plan_task
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, strArray, objArray } from './types.js';
import {
  getProjectPlan,
  updateProjectPlan,
  addPlanTask,
  addPlanTasksBatch,
  updatePlanTask,
  deletePlanTasks,
} from '../plans.js';

export const planTool: ConsolidatedTool = {
  definition: {
    name: 'plan',
    description: 'Verwaltet Projekt-Plaene: Abrufen, Aktualisieren, Tasks hinzufuegen',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'update', 'add_task', 'add_tasks_batch', 'update_task', 'delete_task'],
          description:
            'Aktion: "get" zum Abrufen, "update" zum Aktualisieren, "add_task" um eine Task hinzuzufuegen, "add_tasks_batch" um mehrere Tasks atomar hinzuzufuegen, "update_task" um eine Task zu aendern (status/priority/title/description), "delete_task" um eine oder mehrere Tasks zu loeschen (id als String oder Array)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        agent_id: {
          type: 'string',
          description:
            'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
        },
        // fuer "update"
        name: {
          type: 'string',
          description: 'Neuer Plan-Name',
        },
        description: {
          type: 'string',
          description: 'Neue Beschreibung',
        },
        goals: {
          type: 'array',
          items: { type: 'string' },
          description: 'Neue Ziele',
        },
        architecture: {
          type: 'string',
          description: 'Architektur-Beschreibung',
        },
        // fuer "add_task"
        title: {
          type: 'string',
          description: 'Task-Titel',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Prioritaet (Standard: medium)',
        },
        // fuer "update_task" / "delete_task"
        task_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
          ],
          description: 'Task-ID (String fuer update_task/delete_task, Array fuer Batch-delete_task)',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done', 'blocked'],
          description: 'Neuer Task-Status (fuer update_task)',
        },
        // fuer "add_tasks_batch"
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['title', 'description'],
          },
          minItems: 1,
          maxItems: 50,
          description: 'Tasks fuer Batch-Add (1..50 Items mit title, description, optional priority)',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');

    switch (action) {
      case 'get': {
        const result = await getProjectPlan(project);
        return result;
      }

      case 'update': {
        const result = await updateProjectPlan(project, {
          name: str(args, 'name'),
          description: str(args, 'description'),
          goals: strArray(args, 'goals'),
          architecture: str(args, 'architecture'),
        });
        return result;
      }

      case 'add_task': {
        const title = reqStr(args, 'title');
        const description = reqStr(args, 'description');
        const priority = (str(args, 'priority') || 'medium') as
          | 'low'
          | 'medium'
          | 'high';

        const result = await addPlanTask(project, title, description, priority);
        return result;
      }

      case 'add_tasks_batch': {
        const tasks = objArray<{ title: string; description: string; priority?: string }>(args, 'tasks');
        if (!tasks || tasks.length === 0) {
          return { success: false, count: 0, tasks: [], message: 'tasks (Array) ist erforderlich' };
        }
        const normalized = tasks.map(t => ({
          title: String(t.title ?? ''),
          description: String(t.description ?? ''),
          priority: (t.priority as 'low' | 'medium' | 'high' | undefined) ?? undefined,
        }));
        const result = await addPlanTasksBatch(project, normalized);
        return result;
      }

      case 'update_task': {
        const taskId = reqStr(args, 'task_id');
        const updates: { title?: string; description?: string; status?: 'todo' | 'in_progress' | 'done' | 'blocked'; priority?: 'low' | 'medium' | 'high' } = {};
        const t = str(args, 'title'); if (t !== undefined) updates.title = t;
        const d = str(args, 'description'); if (d !== undefined) updates.description = d;
        const s = str(args, 'status'); if (s !== undefined) updates.status = s as 'todo' | 'in_progress' | 'done' | 'blocked';
        const p = str(args, 'priority'); if (p !== undefined) updates.priority = p as 'low' | 'medium' | 'high';
        const result = await updatePlanTask(project, taskId, updates);
        return result;
      }

      case 'delete_task': {
        const ids = strArray(args, 'task_id');
        if (!ids || ids.length === 0) {
          return { success: false, deleted: 0, message: 'task_id (String oder Array) ist erforderlich' };
        }
        const result = await deletePlanTasks(project, ids);
        return result;
      }

      default:
        throw new Error(`Unbekannte Aktion: ${action}`);
    }
  },
};
