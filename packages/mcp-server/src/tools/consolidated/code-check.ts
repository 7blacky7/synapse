/**
 * Synapse MCP - Consolidated code_check Tool
 * Fehler-Patterns verwalten: add, list, delete
 */

import {
  addErrorPattern,
  listErrorPatterns,
  deleteErrorPattern,
} from '@synapse/core';

import { ConsolidatedTool, str, reqStr, num } from './types.js';

export const codeCheckTool: ConsolidatedTool = {
  definition: {
    name: 'code_check',
    description:
      'Fehler-Pattern-System: Bekannte Fehler speichern und verwalten. ' +
      'Patterns werden automatisch bei Write-Operationen geprueft und als Warnings angezeigt.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add_pattern', 'list_patterns', 'delete_pattern'],
          description: 'Action: add_pattern | list_patterns | delete_pattern',
        },
        description: {
          type: 'string',
          description: 'Erforderlich fuer add_pattern: Was ist der Fehler',
        },
        fix: {
          type: 'string',
          description: 'Erforderlich fuer add_pattern: Wie sieht der Fix aus',
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
          description: 'Optional fuer add_pattern: Schweregrad (Standard: warning)',
        },
        found_in_model: {
          type: 'string',
          description: 'Erforderlich fuer add_pattern: Modell das den Fehler machte (z.B. "haiku", "sonnet", "opus")',
        },
        found_by: {
          type: 'string',
          description: 'Erforderlich fuer add_pattern: Agent-ID die den Fehler fand',
        },
        model_scope: {
          type: 'string',
          description: 'Optional fuer list_patterns: Filter nach model_scope',
        },
        id: {
          type: 'string',
          description: 'Erforderlich fuer delete_pattern: Pattern-ID',
        },
        limit: {
          type: 'number',
          description: 'Optional fuer list_patterns: Max. Ergebnisse (Standard: 20)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID fuer Onboarding (Standard-Parameter)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'add_pattern': {
        const description = reqStr(args, 'description');
        const fix = reqStr(args, 'fix');
        const severity = str(args, 'severity') ?? 'warning';
        const foundInModel = reqStr(args, 'found_in_model');
        const foundBy = reqStr(args, 'found_by');

        const result = await addErrorPattern(description, fix, severity, foundBy, foundInModel);
        return {
          success: true,
          ...result,
          message: `Pattern gespeichert (scope: ${result.modelScope})`,
        };
      }

      case 'list_patterns': {
        const modelScope = str(args, 'model_scope');
        const limit = num(args, 'limit') ?? 20;

        const patterns = await listErrorPatterns(modelScope, limit);
        return {
          success: true,
          patterns,
          count: patterns.length,
        };
      }

      case 'delete_pattern': {
        const id = reqStr(args, 'id');
        const deleted = await deleteErrorPattern(id);
        return {
          success: deleted,
          message: deleted ? 'Pattern geloescht' : 'Pattern nicht gefunden',
        };
      }

      default:
        throw new Error(`Unbekannte action: ${action}. Erlaubt: add_pattern, list_patterns, delete_pattern`);
    }
  },
};
