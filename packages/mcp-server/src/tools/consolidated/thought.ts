/**
 * Synapse MCP - Consolidated Thought Tool
 * Kombiniert add_thought, get_thoughts, delete_thought, update_thought
 * in ein einziges Tool mit action-Parameter
 */

import { str, reqStr, num, bool, strArray, strArrayOrEmpty, objArray } from './types.js';
import type { ConsolidatedTool } from './types.js';
import {
  addThought,
  addThoughtsBatchTool,
  getThoughts,
  getThoughtsByIdsTool,
  deleteThought,
  deleteThoughtsBatch,
  searchThoughts,
  updateThoughtTool,
} from '../index.js';

export const thoughtTool: ConsolidatedTool = {
  definition: {
    name: 'thought',
    description: 'Gedankenaustausch zwischen KIs - speichern, abrufen, suchen, aktualisieren, loeschen. add/add_batch akzeptieren optional task_id (Verknuepfung mit Plan-Task) + task_status (setzt zugleich den Status der Task — spart einen plan(update_task)-Call). Atomarer Status-Bericht + Task-Update in einem Aufruf.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'add_batch', 'get', 'delete', 'update', 'search'],
          description: 'Aktion: add (speichern), add_batch (mehrere atomar speichern), get (abrufen), search (suchen), update (aktualisieren), delete (loeschen)',
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
        dry_run: {
          type: 'boolean',
          description: 'Preview: Zeigt was geloescht wuerde ohne tatsaechlich zu loeschen (nur fuer delete mit Array)',
        },
        max_items: {
          type: 'number',
          description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              task_id: { type: 'string', description: 'Optional: Task-ID fuer Verknuepfung pro Item' },
            },
            required: ['content'],
          },
          minItems: 1,
          maxItems: 50,
          description: 'Items fuer add_batch (1..50 Gedanken mit content + optional tags + optional task_id). source gilt fuer alle Items.',
        },
        task_id: {
          type: 'string',
          description: 'Optional fuer add: Verknuepft den Thought mit einer Plan-Task. Erlaubt spaetere Suche "alle Thoughts zu Task X" und Plan-Lookups via Spalte task_id.',
        },
        task_status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done', 'blocked'],
          description: 'Optional fuer add/add_batch: setzt zugleich den Status der via task_id verlinkten Task. Spart einen separaten plan(update_task)-Call.',
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
        const tags = strArrayOrEmpty(args, 'tags');
        const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
        const taskStatus = typeof args.task_status === 'string' ? args.task_status as Parameters<typeof addThought>[5] : undefined;

        const result = await addThought(project, source, content, tags, taskId, taskStatus);
        return result;
      }

      case 'add_batch': {
        const project = reqStr(args, 'project');
        const source = reqStr(args, 'source');
        const items = objArray<{ content: string; tags?: string[]; task_id?: string }>(args, 'items');
        if (!items || items.length === 0) {
          return { success: false, count: 0, thoughts: [], message: 'items (Array) ist erforderlich' };
        }
        const normalized = items.map(it => ({
          content: String(it.content ?? ''),
          tags: Array.isArray(it.tags) ? it.tags.map(String) : undefined,
          task_id: typeof (it as { task_id?: unknown }).task_id === 'string' ? (it as { task_id: string }).task_id : undefined,
        }));
        const taskStatus = typeof args.task_status === 'string' ? args.task_status as Parameters<typeof addThought>[5] : undefined;
        const result = await addThoughtsBatchTool(project, source, normalized, taskStatus);
        return result;
      }

      case 'get': {
        const project = reqStr(args, 'project');

        // NEU: Wenn id angegeben → spezifische Thoughts laden
        if (args.id !== undefined) {
          const ids = strArray(args, 'id');
          const isBatch = Array.isArray(args.id);
          if (!ids || ids.length === 0) {
            return { success: false, thought: null, message: 'id ist erforderlich' };
          }
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

        // Array-Support: Batch-Delete mit Safeguards
        const ids = strArray(args, 'id');
        if (ids && ids.length > 1) {
          const dryRun = bool(args, 'dry_run') ?? false;
          const maxItems = num(args, 'max_items') ?? 10;
          return await deleteThoughtsBatch(project, ids, dryRun, maxItems);
        }

        // Bestehend: Einzelnes Delete
        const id = reqStr(args, 'id');
        const result = await deleteThought(project, id);
        return result;
      }

      case 'update': {
        const project = reqStr(args, 'project');
        const id = reqStr(args, 'id');
        const changes: { content?: string; tags?: string[] } = {};

        const newContent = str(args, 'content');
        if (newContent !== undefined) changes.content = newContent;
        const newTags = strArray(args, 'tags');
        if (newTags !== undefined) changes.tags = newTags;

        const result = await updateThoughtTool(project, id, changes);
        return result;
      }

      default:
        throw new Error(`Unbekannte action: "${action}". Erlaubte Werte: add, get, search, delete, update`);
    }
  },
};
