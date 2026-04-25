/**
 * Synapse MCP - Konsolidiertes Plan-Tool
 * Konsolidiert: get_project_plan, update_project_plan, add_plan_task
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, strArray } from './types.js';
import {
  getProjectPlan,
  updateProjectPlan,
  addPlanTask,
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
          enum: ['get', 'update', 'add_task'],
          description:
            'Aktion: "get" zum Abrufen, "update" zum Aktualisieren, "add_task" um eine Task hinzuzufuegen',
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

      default:
        throw new Error(`Unbekannte Aktion: ${action}`);
    }
  },
};
