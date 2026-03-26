/**
 * Synapse MCP - Consolidated code_intel Tool
 * Strukturierte Code-Abfragen via PostgreSQL (kein Qdrant)
 *
 * 7 Actions:
 *   tree      — Projekt-Verzeichnisbaum mit Symbol-Counts
 *   functions — Funktionen mit usage_count und parent_name
 *   variables — Variablen, optional mit Wert
 *   symbols   — Generische Symbol-Abfrage nach symbol_type
 *   references — Definition + alle Referenzen eines Symbols
 *   search    — PostgreSQL-Volltext-Suche (tsv / ts_rank)
 *   file      — Dateiinhalt aus PG laden
 */

import {
  getProjectTree,
  getFunctions,
  getVariables,
  getSymbols,
  getReferences,
  fullTextSearchCode,
  getFileContent,
} from '@synapse/core';

import { ConsolidatedTool, str, reqStr, num, bool } from './types.js';

export const codeIntelTool: ConsolidatedTool = {
  definition: {
    name: 'code_intel',
    description:
      'Strukturierte Code-Abfragen aus PostgreSQL: Dateibaum, Funktionen, Variablen, Symbole, Referenzen, Volltext-Suche und Dateiinhalt.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['tree', 'functions', 'variables', 'symbols', 'references', 'search', 'file'],
          description:
            'Aktion: tree|functions|variables|symbols|references|search|file',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name (erforderlich)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID fuer Onboarding',
        },

        // --- tree ---
        path: {
          type: 'string',
          description: 'Verzeichnis-Pfad-Prefix zum Filtern (fuer tree und file)',
        },
        detail: {
          type: 'string',
          enum: ['minimal', 'normal', 'full'],
          description: 'Detail-Level fuer tree: minimal|normal|full (Standard: normal)',
        },

        // --- functions / variables / symbols ---
        file_path: {
          type: 'string',
          description: 'Datei-Pfad-Filter (LIKE-Pattern, fuer functions/variables/symbols/file)',
        },
        name: {
          type: 'string',
          description: 'Symbol-Name-Filter (fuer functions/variables/symbols/references)',
        },
        exported_only: {
          type: 'boolean',
          description: 'Nur exportierte Funktionen zurueckgeben (fuer functions)',
        },

        // --- variables ---
        with_values: {
          type: 'boolean',
          description: 'Wert-Spalte einschliessen (fuer variables)',
        },

        // --- symbols ---
        symbol_type: {
          type: 'string',
          enum: [
            'function',
            'variable',
            'string',
            'comment',
            'import',
            'export',
            'class',
            'interface',
            'enum',
            'const_object',
            'todo',
          ],
          description: 'Symbol-Typ fuer symbols-Action',
        },

        // --- search ---
        query: {
          type: 'string',
          description: 'Suchbegriff fuer search-Action (Volltext)',
        },
        file_type: {
          type: 'string',
          description: 'Dateityp-Filter fuer search-Action (z.B. "ts", "js")',
        },
        limit: {
          type: 'number',
          description: 'Max. Ergebnisse fuer search-Action (Standard: 20)',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');

    switch (action) {
      case 'tree': {
        const dirPath = str(args, 'path') ?? str(args, 'file_path');
        const detail = (str(args, 'detail') as 'minimal' | 'normal' | 'full' | undefined) ?? 'normal';
        const tree = await getProjectTree(project, dirPath, detail);
        return { success: true, tree, project };
      }

      case 'functions': {
        const filePath = str(args, 'file_path');
        const name = str(args, 'name');
        const exportedOnly = bool(args, 'exported_only');
        const functions = await getFunctions(project, filePath, name, exportedOnly);
        return { success: true, functions, count: functions.length, project };
      }

      case 'variables': {
        const filePath = str(args, 'file_path');
        const name = str(args, 'name');
        const withValues = bool(args, 'with_values');
        const variables = await getVariables(project, filePath, name, withValues);
        return { success: true, variables, count: variables.length, project };
      }

      case 'symbols': {
        const symbolType = reqStr(args, 'symbol_type');
        const filePath = str(args, 'file_path');
        const name = str(args, 'name');
        const symbols = await getSymbols(project, symbolType, filePath, name);
        return { success: true, symbols, count: symbols.length, symbol_type: symbolType, project };
      }

      case 'references': {
        const name = reqStr(args, 'name');
        const result = await getReferences(project, name);
        return { success: true, ...result, project };
      }

      case 'search': {
        const query = reqStr(args, 'query');
        const fileType = str(args, 'file_type');
        const limit = num(args, 'limit') ?? 20;
        const results = await fullTextSearchCode(project, query, fileType, limit);
        return { success: true, results, count: results.length, project };
      }

      case 'file': {
        const filePath = str(args, 'file_path') ?? str(args, 'path');
        if (!filePath) throw new Error('Parameter "file_path" oder "path" ist erforderlich fuer action "file"');
        const file = await getFileContent(project, filePath);
        if (!file) {
          return { success: false, message: `Datei nicht gefunden: ${filePath}`, project };
        }
        return { success: true, ...file, project };
      }

      default:
        throw new Error(
          `Unbekannte action: "${action}". Erlaubte Werte: tree, functions, variables, symbols, references, search, file`
        );
    }
  },
};
