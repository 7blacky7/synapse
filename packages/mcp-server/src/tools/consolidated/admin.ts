/**
 * Konsolidiertes Admin/Utility-Tool für Synapse MCP
 *
 * Kombiniert 7 separate Admin-Tools zu einem einzigen Tool mit action-Parameter:
 * - migrate (migrate_embeddings)
 * - restore (restore_backup)
 * - save_idea (save_project_idea)
 * - confirm_idea (confirm_idea)
 * - index_media (index_media)
 * - index_stats (get_index_stats)
 * - detailed_stats (get_detailed_stats)
 */

import type { ConsolidatedTool } from './types.js';
import { str, reqStr, bool } from './types.js';
import {
  getIndexStats,
  getDetailedStats,
  migrateEmbeddings,
  restoreFromBackup,
  saveProjectIdea,
  confirmIdea,
  indexMediaWrapper,
} from '../index.js';
import { migrateToRelativePaths } from '@synapse/core';

export const adminTool: ConsolidatedTool = {
  definition: {
    name: 'admin',
    description: 'Konsolidiertes Admin/Utility-Tool mit verschiedenen Actions für Projekt-Management, Statistiken, Ideen und Media-Indexierung',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['migrate', 'restore', 'save_idea', 'confirm_idea', 'index_media', 'index_stats', 'detailed_stats', 'migrate_paths'],
          description: 'Die auszuführende Admin-Action',
        },
        // === migrate ===
        project: {
          type: 'string',
          description: 'Projekt-Name (erforderlich für alle Actions außer confirm_idea)',
        },
        collections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional für migrate: Nur bestimmte Collections migrieren',
        },
        dry_run: {
          type: 'boolean',
          description: 'Optional für migrate: Nur prüfen ohne zu migrieren (Standard: false)',
        },
        // === restore ===
        backup_type: {
          type: 'string',
          enum: ['thoughts', 'memories', 'plans', 'proposals', 'all'],
          description: 'Optional für restore: Was wiederherstellen (Standard: all)',
        },
        // === save_idea ===
        title: {
          type: 'string',
          description: 'Erforderlich für save_idea: Titel der Idee',
        },
        description: {
          type: 'string',
          description: 'Erforderlich für save_idea: Beschreibung der Idee',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional für save_idea: Tags für die Idee',
        },
        // === confirm_idea ===
        idea_id: {
          type: 'string',
          description: 'Erforderlich für confirm_idea: ID der zu bestätigenden Idee',
        },
        custom_name: {
          type: 'string',
          description: 'Optional für confirm_idea: Eigener Name statt des vorgeschlagenen',
        },
        // === index_media ===
        path: {
          type: 'string',
          description: 'Erforderlich für index_media: Absoluter Pfad zu Datei oder Verzeichnis',
        },
        recursive: {
          type: 'boolean',
          description: 'Optional für index_media: Rekursiv durchsuchen (Standard: true)',
        },
        agent_id: {
          type: 'string',
          description: 'Optional für index_media/index_stats/detailed_stats: Agent-ID für Onboarding',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = str(args, 'action');
    if (!action) {
      throw new Error('Parameter "action" ist erforderlich');
    }

    switch (action) {
      // ===== MIGRATE =====
      case 'migrate': {
        const project = reqStr(args, 'project');
        const collections = args.collections as string[] | undefined;
        const dryRun = bool(args, 'dry_run');

        const result = await migrateEmbeddings(project, {
          collections,
          dryRun,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      // ===== RESTORE =====
      case 'restore': {
        const project = reqStr(args, 'project');
        const backupType = (args.backup_type as 'thoughts' | 'memories' | 'plans' | 'proposals' | 'all') || 'all';

        const result = await restoreFromBackup(backupType, project);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      // ===== SAVE_IDEA =====
      case 'save_idea': {
        const title = reqStr(args, 'title');
        const description = reqStr(args, 'description');
        const project = str(args, 'project');
        const tags = args.tags as string[] | undefined;

        // Kombiniere title und description zu content für saveProjectIdea
        const content = `## ${title}\n\n${description}`;

        const result = await saveProjectIdea(content, project, tags);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      // ===== CONFIRM_IDEA =====
      case 'confirm_idea': {
        const ideaId = reqStr(args, 'idea_id');
        const customName = str(args, 'custom_name');

        const result = await confirmIdea(ideaId, customName);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      // ===== INDEX_MEDIA =====
      case 'index_media': {
        const path = reqStr(args, 'path');
        const project = reqStr(args, 'project');
        const recursive = bool(args, 'recursive');

        const result = await indexMediaWrapper(path, project, recursive);

        return result;
      }

      // ===== INDEX_STATS =====
      case 'index_stats': {
        const project = reqStr(args, 'project');

        const result = await getIndexStats(project);

        return result;
      }

      // ===== DETAILED_STATS =====
      case 'detailed_stats': {
        const project = reqStr(args, 'project');

        const result = await getDetailedStats(project);

        return result;
      }

      // ===== MIGRATE_PATHS =====
      case 'migrate_paths': {
        const result = await migrateToRelativePaths();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unbekannte Admin-Action: "${action}"`);
    }
  },
};
