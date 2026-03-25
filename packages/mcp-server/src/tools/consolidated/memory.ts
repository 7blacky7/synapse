/**
 * Konsolidiertes Memory Tool
 *
 * Vereint 7 separate MCP-Tools in einem einzigen Tool mit action-Parameter:
 * - write_memory → "write"
 * - read_memory → "read"
 * - read_memory_with_code → "read_with_code"
 * - list_memories → "list"
 * - delete_memory → "delete"
 * - update_memory → "update"
 * - find_memories_for_file → "find_for_file"
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConsolidatedTool, str, reqStr, bool, num } from './types.js';
import {
  writeMemory,
  readMemory,
  readMemories,
  listMemories,
  deleteMemory,
  readMemoryWithCode,
  findMemoriesForFile,
  updateMemoryTool,
} from '../index.js';

const memoryTool: ConsolidatedTool = {
  definition: {
    name: 'memory',
    description: 'Verwende für alle Memory-Operationen: write, read, read_with_code, list, delete, update und find_for_file',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'read_with_code', 'list', 'delete', 'update', 'find_for_file'],
          description: 'Aktion: write | read | read_with_code | list | delete | update | find_for_file',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name (erforderlich für alle Aktionen)',
        },
        name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Memory-Name (erforderlich für read, read_with_code, delete, update). Array erlaubt fuer: read',
        },
        content: {
          type: 'string',
          description: 'Memory-Inhalt (erforderlich für write, optional für update)',
        },
        category: {
          type: 'string',
          enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
          description: 'Kategorie (optional für write, optional für update)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags (optional für write, optional für update)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID für Onboarding (optional)',
        },
        file_path: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Dateipfad (erforderlich für find_for_file). Array erlaubt fuer: find_for_file',
        },
        limit: {
          type: 'number',
          description: 'Max. Ergebnisse (optional, Standard: 10 für find_for_file)',
        },
        codeLimit: {
          type: 'number',
          description: 'Max. Code-Chunks (optional, Standard: 10 für read_with_code)',
        },
        includeSemanticMatches: {
          type: 'boolean',
          description: 'Semantische Matches einbeziehen (optional, Standard: true für read_with_code)',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = str(args, 'action');
    const project = reqStr(args, 'project');

    if (!action) {
      return {
        success: false,
        message: 'Parameter "action" ist erforderlich',
      };
    }

    try {
      switch (action) {
        case 'write': {
          const name = reqStr(args, 'name');
          const content = reqStr(args, 'content');
          const category = str(args, 'category') as
            | 'documentation'
            | 'note'
            | 'architecture'
            | 'decision'
            | 'rules'
            | 'other'
            | undefined;
          const tags = Array.isArray(args.tags) ? (args.tags as string[]) : undefined;

          const result = await writeMemory(project, name, content, category, tags);
          return { message: result };
        }

        case 'read': {
          // Array-Support: Mehrere Memories in einem Call
          if (Array.isArray(args.name)) {
            const names = args.name as string[];
            const result = await readMemories(project, names);
            return result;
          }

          // Bestehend: Einzelnes Memory
          const name = reqStr(args, 'name');
          const result = await readMemory(project, name);
          return result;
        }

        case 'read_with_code': {
          const name = reqStr(args, 'name');
          const codeLimit = num(args, 'codeLimit');
          const includeSemanticMatches = bool(args, 'includeSemanticMatches');

          const result = await readMemoryWithCode(project, name, {
            codeLimit,
            includeSemanticMatches,
          });
          return result;
        }

        case 'list': {
          const category = str(args, 'category') as
            | 'documentation'
            | 'note'
            | 'architecture'
            | 'decision'
            | 'rules'
            | 'other'
            | undefined;

          const result = await listMemories(project, category);
          return result;
        }

        case 'delete': {
          const name = reqStr(args, 'name');
          const result = await deleteMemory(project, name);
          return { message: result };
        }

        case 'update': {
          const name = reqStr(args, 'name');
          const changes: {
            content?: string;
            category?: 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other';
            tags?: string[];
          } = {};

          if (args.content) changes.content = args.content as string;
          if (args.category) {
            changes.category = args.category as
              | 'documentation'
              | 'note'
              | 'architecture'
              | 'decision'
              | 'rules'
              | 'other';
          }
          if (Array.isArray(args.tags)) {
            changes.tags = args.tags as string[];
          }

          const result = await updateMemoryTool(project, name, changes);
          return result;
        }

        case 'find_for_file': {
          // Array-Support: Mehrere Dateien in einem Call
          if (Array.isArray(args.file_path)) {
            const filePaths = args.file_path as string[];
            const settled = await Promise.allSettled(
              filePaths.map(fp => findMemoriesForFile(project, fp))
            );
            const results: Array<Record<string, unknown>> = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors };
          }

          // Bestehend: Einzelner Dateipfad
          const filePath = reqStr(args, 'file_path');
          const limit = num(args, 'limit');

          const result = await findMemoriesForFile(project, filePath, limit);
          return result;
        }

        default:
          return {
            success: false,
            message: `Unbekannte action: "${action}". Gültig sind: write | read | read_with_code | list | delete | update | find_for_file`,
          };
      }
    } catch (error) {
      return {
        success: false,
        message: `Fehler bei action "${action}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export { memoryTool };
