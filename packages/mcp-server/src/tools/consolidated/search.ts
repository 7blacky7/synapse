/**
 * Consolidated Search Tool
 * Konsolidiert 8 MCP-Such-Tools zu einem einzigen "search" Tool mit action-Parameter
 *
 * ALTE TOOLS → ACTIONS:
 * - semantic_code_search → "code"
 * - search_by_path → "path"
 * - search_code_with_path → "code_with_path"
 * - search_memory → "memory"
 * - search_thoughts → "thoughts"
 * - search_proposals → "proposals"
 * - search_tech_docs → "tech_docs"
 * - search_media → "media"
 */

import {
  semanticCodeSearch,
  searchByPath,
  searchCodeWithPath,
  searchMediaWrapper,
} from '../index.js';

import {
  searchThoughts,
} from '../thoughts.js';

import {
  searchMemory,
} from '../memory.js';

import {
  searchProposalsWrapper,
} from '../proposals.js';

import {
  searchTechDocsTool,
} from '../tech-docs.js';

import { ConsolidatedTool, str, reqStr, num, bool } from './types.js';

type SearchAction =
  | 'code'
  | 'path'
  | 'code_with_path'
  | 'memory'
  | 'thoughts'
  | 'proposals'
  | 'tech_docs'
  | 'media';

export const searchTool: ConsolidatedTool = {
  definition: {
    name: 'search',
    description:
      'Konsolidierte Such-Funktion mit action-Parameter fuer Code, Paths, Memory, Thoughts, Proposals, Tech-Docs und Media',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'code',
            'path',
            'code_with_path',
            'memory',
            'thoughts',
            'proposals',
            'tech_docs',
            'media',
          ],
          description:
            'Such-Aktion: code|path|code_with_path|memory|thoughts|proposals|tech_docs|media',
        },

        // Gemeinsame Parameter
        query: {
          type: 'string',
          description: 'Suchanfrage (erforderlich fuer die meisten Actions)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID fuer Onboarding',
        },
        limit: {
          type: 'number',
          description: 'Max. Ergebnisse (Standard: 10 oder 50)',
        },

        // Action-spezifische Parameter
        file_type: {
          type: 'string',
          description: 'Dateityp-Filter (fuer code, code_with_path)',
        },
        path_pattern: {
          type: 'string',
          description: 'Glob-Pattern fuer Pfad-Filter (fuer path, code_with_path)',
        },
        content_pattern: {
          type: 'string',
          description: 'Regex-Pattern fuer Content-Filter (fuer path)',
        },
        media_type: {
          type: 'string',
          enum: ['image', 'video'],
          description: 'Media-Typ-Filter (image|video, fuer media)',
        },
        framework: {
          type: 'string',
          description: 'Framework-Filter (fuer tech_docs)',
        },
        type: {
          type: 'string',
          description: 'Tech-Doc-Type-Filter (fuer tech_docs)',
        },
        source: {
          type: 'string',
          description: 'Source-Filter (fuer tech_docs)',
        },
        scope: {
          type: 'string',
          enum: ['project', 'global', 'all'],
          description: 'Suchbereich (project|global|all, fuer tech_docs)',
        },
        category: {
          type: 'string',
          description: 'Memory-Kategorie-Filter (fuer memory)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action') as SearchAction;

    try {
      switch (action) {
        case 'code': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const fileType = str(args, 'file_type');
          const limit = num(args, 'limit');

          const result = await semanticCodeSearch(query, project, fileType, limit);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'path': {
          const project = reqStr(args, 'project');
          const pathPattern = reqStr(args, 'path_pattern');
          const contentPattern = str(args, 'content_pattern');
          const limit = num(args, 'limit');

          const result = await searchByPath(project, pathPattern, {
            contentPattern,
            limit,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'code_with_path': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const pathPattern = str(args, 'path_pattern');
          const fileType = str(args, 'file_type');
          const limit = num(args, 'limit');

          const result = await searchCodeWithPath(query, project, {
            pathPattern,
            fileType,
            limit,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'memory': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const limit = num(args, 'limit');

          const result = await searchMemory(query, project, limit);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'thoughts': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const limit = num(args, 'limit');

          const result = await searchThoughts(query, project, limit);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'proposals': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const limit = num(args, 'limit');

          const result = await searchProposalsWrapper(query, project, limit);

          return {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result),
              },
            ],
          };
        }

        case 'tech_docs': {
          const query = reqStr(args, 'query');
          const framework = str(args, 'framework');
          const type = str(args, 'type');
          const source = str(args, 'source');
          const project = str(args, 'project');
          const limit = num(args, 'limit');
          const scope = str(args, 'scope') as
            | 'global'
            | 'project'
            | 'all'
            | undefined;

          const result = await searchTechDocsTool(query, {
            framework,
            type,
            source,
            project,
            limit,
            scope,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'media': {
          const query = reqStr(args, 'query');
          const project = reqStr(args, 'project');
          const mediaType = str(args, 'media_type') as
            | 'image'
            | 'video'
            | undefined;
          const limit = num(args, 'limit');

          const result = await searchMediaWrapper(query, project, mediaType, limit);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: `Unbekannte Action: ${action}`,
                }),
              },
            ],
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              message: `Fehler bei Search-Action "${action}": ${error}`,
            }),
          },
        ],
      };
    }
  },
};
