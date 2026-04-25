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
import { ConsolidatedTool, reqStr, str, bool, strArray } from './types.js';
import {
  spawnSpecialistTool,
  stopSpecialistTool,
  purgeSpecialistTool,
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
          enum: ['spawn', 'stop', 'purge', 'status', 'wake', 'update_skill', 'capabilities'],
          description: 'Die auszuführende Aktion. purge = Stop + komplette Entfernung (FS-Verzeichnis, status.json, Channel-Memberships, Chat-Session). Auto-Respawn unmoeglich danach.',
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
          description:
            'Claude Modell (erforderlich für: spawn). MODELLE: opus/sonnet/haiku = 200k Context (Standard fuer kurze Tasks). opus[1m]/sonnet[1m] = 1M Context (fuer langlaufende Code-Arbeit ohne Handoff-Risiko). ⚠️ ABO-LIMIT: Nur EIN Modell-Typ darf gleichzeitig auf 1M laufen — wenn der Koordinator opus[1m] nutzt, duerfen Spezialisten AUCH opus[1m] sein, aber NIEMALS sonnet[1m] dazu (rate-limit-Block). Bei Mix-Bedarf: andere Modelle auf 200k spawnen. Empfehlung: Deep-Code-Work → opus[1m], One-Shot-Tasks → opus/sonnet 200k, einfache Mechanik → haiku.',
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
            '⚠️ WICHTIG: keep_alive: true setzen fuer langlaufende Spezialisten. Aktiviert (a) periodisches Wecken im Idle UND (b) Auto-Respawn bei Crash (Context-Limit, OOM). Ohne keep_alive stirbt der Wrapper mit dem Agenten — kein Comeback, manueller Spawn noetig. Standard: false (nur fuer kurze One-Shot-Tasks ok).',
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
          description: 'Abschnitt der SKILL.md (legacy, optional fuer: update_skill). Alternative: file',
        },
        file: {
          type: 'string',
          enum: ['rules', 'errors', 'patterns', 'context'],
          description: 'Ziel-Datei (neu, optional fuer: update_skill). Alternative zu section (legacy).',
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
        const allowedTools = strArray(args, 'allowed_tools');
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
        // Array-Support: Mehrere Spezialisten stoppen
        const names = strArray(args, 'name');
        if (names && names.length > 1) {
          const projectPath = reqStr(args, 'project_path');
          const settled = await Promise.allSettled(
            names.map(n => stopSpecialistTool(n, projectPath))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Stop
        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        return await stopSpecialistTool(name, projectPath);
      }

      case 'purge': {
        // Array-Support: Mehrere Spezialisten purgen
        const names = strArray(args, 'name');
        if (names && names.length > 1) {
          const projectPath = reqStr(args, 'project_path');
          const settled = await Promise.allSettled(
            names.map(n => purgeSpecialistTool(n, projectPath))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        return await purgeSpecialistTool(name, projectPath);
      }

      case 'status': {
        const projectPath = reqStr(args, 'project_path');

        // Array-Support: Mehrere Spezialisten-Status in einem Call
        const names = strArray(args, 'name');
        if (names && names.length > 1) {
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
        const message = reqStr(args, 'message');

        // Array-Support: Mehrere Spezialisten mit gleichem Message wecken
        const names = strArray(args, 'name');
        if (names && names.length > 1) {
          const settled = await Promise.allSettled(
            names.map(n => wakeSpecialistTool(n, message))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Wake
        const name = reqStr(args, 'name');
        return await wakeSpecialistTool(name, message);
      }

      case 'update_skill': {
        const name = reqStr(args, 'name');
        const projectPath = reqStr(args, 'project_path');
        const section = str(args, 'section') as 'regeln' | 'fehler' | 'patterns' | undefined;
        const file = str(args, 'file') as 'rules' | 'errors' | 'patterns' | 'context' | undefined;
        if (!section && !file) throw new Error('Parameter "section" oder "file" erforderlich');
        const skillAction = reqStr(args, 'skill_action') as 'add' | 'remove';
        const content = reqStr(args, 'content');

        return await updateSpecialistSkillTool(name, projectPath, section, skillAction, content, file);
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
