/**
 * Konsolidiertes MCP-Tool fuer Tech-Docs
 *
 * Kombiniert 3 separate Tools in ein einziges Tool mit action-Parameter:
 * - add: Indexiert ein Tech-Doc in PostgreSQL + Qdrant
 * - search: Durchsucht Tech-Docs semantisch
 * - get_for_file: Holt relevante Docs fuer eine Datei (Wissens-Airbag)
 */

import { ConsolidatedTool, reqStr, str, num, bool, strArray, objArray } from './types.js';
import {
  addTechDocTool,
  searchTechDocsTool,
  getDocsForFileTool,
} from '../tech-docs.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const docsTool: ConsolidatedTool = {
  definition: {
    name: 'docs',
    description: 'Konsolidiertes MCP-Tool fuer Tech-Docs: Indexieren, Suchen, Wissens-Airbag',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'search', 'get_for_file'],
          description: 'Aktion: add (Indexieren), search (Suchen), get_for_file (Wissens-Airbag)',
        },
        // ===== ACTION: add =====
        framework: {
          type: 'string',
          description: 'Framework/Sprache (z.B. react, python, express)',
        },
        version: {
          type: 'string',
          description: 'Version (z.B. 19.0, 3.12)',
        },
        section: {
          type: 'string',
          description: 'Abschnitt (z.B. hooks, routing, breaking-changes)',
        },
        content: {
          type: 'string',
          description: 'Inhalt des Docs',
        },
        type: {
          type: 'string',
          enum: [
            'feature',
            'breaking-change',
            'migration',
            'gotcha',
            'code-example',
            'best-practice',
            'known-issue',
            'community',
          ],
          description: 'Chunk-Type',
        },
        category: {
          type: 'string',
          enum: ['framework', 'language'],
          description: 'framework oder language (Standard: framework)',
        },
        source: {
          type: 'string',
          enum: ['research', 'context7', 'manual'],
          description: 'Quelle (Standard: research)',
        },
        // ===== ACTION: search =====
        query: {
          type: 'string',
          description: 'Suchanfrage',
        },
        limit: {
          type: 'number',
          description: 'Max Ergebnisse (Standard: 10)',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global', 'all'],
          description:
            'Suchbereich: project (nur Projekt-Collection), global (nur globale), all (beide)',
        },
        // ===== ACTION: get_for_file =====
        file_path: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Dateipfad (z.B. src/api.ts). Array erlaubt fuer get_for_file (Multi-File-Analyse)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID fuer Cutoff-Ermittlung',
        },
        // ===== GEMEINSAM =====
        project: {
          type: 'string',
          description: 'Projekt-Name (optional)',
        },
        docs: {
          type: 'array',
          description: 'Bulk-Mode fuer add: 1..50 Tech-Docs in einem Call. Jedes Item: { framework, version, section, content, type, category?, source? }. project gilt fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              framework: { type: 'string' },
              version: { type: 'string' },
              section: { type: 'string' },
              content: { type: 'string' },
              type: { type: 'string', enum: ['feature', 'breaking-change', 'migration', 'gotcha', 'code-example', 'best-practice', 'known-issue', 'community'] },
              category: { type: 'string', enum: ['framework', 'language'] },
              source: { type: 'string', enum: ['research', 'context7', 'manual'] },
            },
            required: ['framework', 'version', 'section', 'content', 'type'],
          },
        },
      },
      required: ['action'],
    },
  } as Tool,

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'add': {
        const project = str(args, 'project');

        // Bulk-Mode
        type DocItem = {
          framework?: string;
          version?: string;
          section?: string;
          content?: string;
          type?: string;
          category?: string;
          source?: string;
        };
        const docs = objArray<DocItem>(args, 'docs');
        if (docs && docs.length > 0) {
          const results: Array<{ index: number; ok: boolean; id?: string; duplicate?: boolean; error?: string }> = [];
          let applied = 0;
          let failed = 0;
          for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            try {
              if (!d.framework) throw new Error('framework fehlt');
              if (!d.version) throw new Error('version fehlt');
              if (!d.section) throw new Error('section fehlt');
              if (!d.content) throw new Error('content fehlt');
              if (!d.type) throw new Error('type fehlt');
              const r = await addTechDocTool(
                d.framework,
                d.version,
                d.section,
                d.content,
                d.type as 'feature' | 'breaking-change' | 'migration' | 'gotcha' | 'code-example' | 'best-practice' | 'known-issue' | 'community',
                d.category,
                d.source,
                project,
              );
              results.push({ index: i, ok: r.success, id: r.id, duplicate: r.duplicate });
              if (r.success) applied++; else failed++;
            } catch (err) {
              results.push({ index: i, ok: false, error: (err as Error).message });
              failed++;
            }
          }
          return {
            total: docs.length,
            applied,
            failed,
            results,
            message: `${applied}/${docs.length} Docs indexiert${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
          };
        }

        // Single-Mode
        const framework = reqStr(args, 'framework');
        const version = reqStr(args, 'version');
        const section = reqStr(args, 'section');
        const content = reqStr(args, 'content');
        const type = reqStr(args, 'type') as
          | 'feature'
          | 'breaking-change'
          | 'migration'
          | 'gotcha'
          | 'code-example'
          | 'best-practice'
          | 'known-issue'
          | 'community';
        const category = str(args, 'category');
        const source = str(args, 'source');

        const result = await addTechDocTool(
          framework,
          version,
          section,
          content,
          type,
          category,
          source,
          project
        );

        return {
          success: result.success,
          id: result.id,
          duplicate: result.duplicate,
          message: result.message,
        };
      }

      case 'search': {
        const query = reqStr(args, 'query');
        const framework = str(args, 'framework');
        const type = str(args, 'type');
        const source = str(args, 'source');
        const project = str(args, 'project');
        const limit = num(args, 'limit');
        const scope = str(args, 'scope') as 'global' | 'project' | 'all' | undefined;

        const result = await searchTechDocsTool(query, {
          framework,
          type,
          source,
          project,
          limit,
          scope,
        });

        return {
          success: result.success,
          results: result.results,
          message: result.message,
        };
      }

      case 'get_for_file': {
        const agentId = reqStr(args, 'agent_id');
        const project = reqStr(args, 'project');

        // Array-Support: Mehrere Dateien in einem Call
        const filePaths = strArray(args, 'file_path');
        if (filePaths && filePaths.length > 1) {
          const settled = await Promise.allSettled(
            filePaths.map(fp => getDocsForFileTool(fp, agentId, project))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') {
              const val = r.value;
              results.push({
                success: val.success,
                warnings: val.warnings,
                agentCutoff: val.agentCutoff,
                message: val.message,
              });
            } else {
              errors.push(String(r.reason));
            }
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Dateipfad
        const filePath = reqStr(args, 'file_path');
        const result = await getDocsForFileTool(filePath, agentId, project);

        return {
          success: result.success,
          warnings: result.warnings,
          agentCutoff: result.agentCutoff,
          message: result.message,
        };
      }

      default:
        throw new Error(`Unbekannte action: "${action}"`);
    }
  },
};
