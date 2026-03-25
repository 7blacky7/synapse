/**
 * Synapse MCP - Consolidated Thought Tool
 * Kombiniert add_thought, get_thoughts, delete_thought, update_thought
 * in ein einziges Tool mit action-Parameter
 */

import { str, reqStr, num } from './types.js';
import type { ConsolidatedTool } from './types.js';
import {
  addThought,
  getThoughts,
  getThoughtsByIdsTool,
  deleteThought,
  searchThoughts,
  updateThoughtTool,
} from '../index.js';

export const thoughtTool: ConsolidatedTool = {
  definition: {
    name: 'thought',
    description: 'Gedankenaustausch zwischen KIs - speichern, abrufen, suchen, aktualisieren, loeschen',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'get', 'delete', 'update', 'search'],
          description: 'Aktion: add (speichern), get (abrufen), search (suchen), update (aktualisieren), delete (loeschen)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
        },
        source: {
          type: 'string',
          description: 'Quelle (z.B. claude-code, gpt, user) - fuer action "add"',
        },
        content: {
          type: 'string',
          description: 'Inhalt des Gedankens - fuer action "add" oder "update"',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optionale Tags - fuer action "add" oder "update"',
        },
        id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'ID des Gedankens - fuer action "get" (einzeln oder Array), "delete" oder "update"',
        },
        query: {
          type: 'string',
          description: 'Suchanfrage - fuer action "search"',
        },
        limit: {
          type: 'number',
          description: 'Maximale Anzahl Ergebnisse (Standard: 50 fuer get, 10 fuer search)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'add': {
        const project = reqStr(args, 'project');
        const source = reqStr(args, 'source');
        const content = reqStr(args, 'content');
        const tags = (args.tags as string[] | undefined) ?? [];

        const result = await addThought(project, source, content, tags);
        return result;
      }

      case 'get': {
        const project = reqStr(args, 'project');

        // NEU: Wenn id angegeben → spezifische Thoughts laden
        if (args.id !== undefined) {
          const isBatch = Array.isArray(args.id);
          const ids = isBatch ? (args.id as string[]) : [args.id as string];
          const result = await getThoughtsByIdsTool(project, ids);

          // Scalar-Input → einzelnes Thought zurückgeben
          if (!isBatch) {
            return result.thoughts.length > 0
              ? { success: true, thought: result.thoughts[0], message: '1 Gedanke geladen' }
              : { success: false, thought: null, message: `Gedanke "${args.id}" nicht gefunden` };
          }

          // Array-Input → Batch-Response
          return result;
        }

        // Bestehend: Alle Thoughts des Projekts auflisten
        const limit = num(args, 'limit');
        const result = await getThoughts(project, limit);
        return result;
      }

      case 'search': {
        const query = reqStr(args, 'query');
        const project = str(args, 'project');
        const limit = num(args, 'limit') ?? 10;

        const result = await searchThoughts(query, project ?? '', limit);
        return result;
      }

      case 'delete': {
        const project = reqStr(args, 'project');
        const id = reqStr(args, 'id');

        const result = await deleteThought(project, id);
        return result;
      }

      case 'update': {
        const project = reqStr(args, 'project');
        const id = reqStr(args, 'id');
        const changes: { content?: string; tags?: string[] } = {};

        if (args.content) changes.content = str(args, 'content');
        if (args.tags) changes.tags = args.tags as string[];

        const result = await updateThoughtTool(project, id, changes);
        return result;
      }

      default:
        throw new Error(`Unbekannte action: "${action}". Erlaubte Werte: add, get, search, delete, update`);
    }
  },
};
