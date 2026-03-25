/**
 * Consolidated Specialist Tool
 * Konsolidiert 6 MCP-Specialist-Tools zu einem einzigen Tool mit action-Parameter
 *
 * Actions:
 * - spawn: Spawnt einen neuen Spezialisten
 * - stop: Stoppt einen laufenden Spezialisten
 * - status: Holt Status aller oder eines einzelnen Spezialisten
 * - wake: Sendet eine Nachricht an einen Spezialisten
 * - update_skill: Aktualisiert SKILL.md eines Spezialisten
 * - capabilities: Prüft verfügbare Features (Claude CLI etc.)
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConsolidatedTool, reqStr, str, bool } from './types.js';
import {
  spawnSpecialistTool,
  stopSpecialistTool,
  specialistStatusTool,
  wakeSpecialistTool,
  updateSpecialistSkillTool,
  getAgentCapabilitiesTool,
} from '../index.js';

export const specialistTool: ConsolidatedTool = {
  definition: {
    name: 'specialist',
    description:
      'Konsolidiertes Tool für Spezialisten-Management. Unterstützt Spawning, Stopping, Status-Checks, Wake-Calls, Skill-Updates und Capabilities-Checks.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['spawn', 'stop', 'status', 'wake', 'update_skill', 'capabilities'],
          description: 'Die auszuführende Aktion',
        },

        // spawn parameters
        name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Name des Spezialisten (erforderlich für: spawn, stop, status, wake, update_skill). Array erlaubt für: status',
        },
        model: {
          type: 'string',
          enum: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'],
          description: 'Claude Modell (erforderlich für: spawn)',
        },
        expertise: {
          type: 'string',
          description: 'Fachgebiet des Spezialisten (erforderlich für: spawn)',
        },
        task: {
          type: 'string',
          description: 'Aufgabe für den Spezialisten (erforderlich für: spawn)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name (erforderlich für: spawn)',
        },
        project_path: {
          type: 'string',
          description: 'Absoluter Pfad zum Projekt-Ordner (erforderlich für: spawn, stop, status, update_skill)',
        },
        cwd: {
          type: 'string',
          description: 'Arbeitsverzeichnis (optional für: spawn, Standard: Projekt-Pfad)',
        },
        channel: {
          type: 'string',
          description: 'Channel für Kommunikation (optional für: spawn, Standard: {project}-general)',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Erlaubte Tools für den Spezialisten (optional für: spawn)',
        },
        keep_alive: {
          type: 'boolean',
          description:
            'Agent bei jedem Heartbeat-Poll wecken (optional für: spawn, Standard: false)',
        },

        // status parameters
        // name, project_path: siehe oben

        // wake parameters
        message: {
          type: 'string',
          description: 'Nachricht an den Spezialisten (erforderlich für: wake)',
        },

        // update_skill parameters
        section: {
          type: 'string',
          enum: ['regeln', 'fehler', 'patterns'],
          description: 'Abschnitt der SKILL.md (erforderlich für: update_skill)',
        },
        skill_action: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Hinzufuegen oder entfernen (erforderlich fuer: update_skill)',
        },
        content: {
          type: 'string',
          description: 'Inhalt des Eintrags (erforderlich für: update_skill)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'spawn': {
        const name = reqStr(args, 'name');
        const model = reqStr(args, 'model') as
          | 'opus'
          | 'sonnet'
          | 'haiku'
          | 'opus[1m]'
          | 'sonnet[1m]';
        const expertise = reqStr(args, 'expertise');
        const task = reqStr(args, 'task');
        const project = reqStr(args, 'project');
        const projectPath = reqStr(args, 'project_path');
        const cwd = str(args, 'cwd');
        const channel = str(args, 'channel');
        const allowedTools = Array.isArray(args.allowed_tools)
          ? (args.allowed_tools as string[])
          : undefined;
        const keepAlive = bool(args, 'keep_alive');

        return await spawnSpecialistTool(
          name,
          model,
          expertise,
          task,
          project,
          projectPath,
          cwd,
          channel,
          allowedTools,
          keepAlive,
        );
      }

      case 'stop': {
        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');

        return await stopSpecialistTool(name, projectPath);
      }

      case 'status': {
        const projectPath = reqStr(args, 'project_path');

        // Array-Support: Mehrere Spezialisten-Status in einem Call
        if (Array.isArray(args.name)) {
          const names = args.name as string[];
          const settled = await Promise.allSettled(
            names.map(n => specialistStatusTool(projectPath, n))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Name (oder alle wenn kein Name)
        const name = str(args, 'name');
        return await specialistStatusTool(projectPath, name);
      }

      case 'wake': {
        const name = reqStr(args, 'name');
        const message = reqStr(args, 'message');

        return await wakeSpecialistTool(name, message);
      }

      case 'update_skill': {
        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        const section = reqStr(args, 'section') as 'regeln' | 'fehler' | 'patterns';
        const skillAction = reqStr(args, 'skill_action') as 'add' | 'remove';
        const content = reqStr(args, 'content');

        return await updateSpecialistSkillTool(name, projectPath, section, skillAction, content);
      }

      case 'capabilities': {
        return getAgentCapabilitiesTool();
      }

      default: {
        throw new Error(`Unbekannte Action: ${action}`);
      }
    }
  },
};
