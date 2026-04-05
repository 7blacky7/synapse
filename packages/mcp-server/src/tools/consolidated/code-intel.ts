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
  searchCode,
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
        recursive: {
          type: 'boolean',
          description: 'Unterverzeichnisse einschliessen (Standard: true, fuer tree). false = nur Dateien direkt im Verzeichnis.',
        },
        depth: {
          type: 'number',
          description: 'Max. Verzeichnis-Tiefe relativ zum path (0 = nur das Verzeichnis, 1 = +1 Ebene, fuer tree)',
        },
        show_lines: {
          type: 'boolean',
          description: 'Zeilenzahl pro Datei anzeigen (Standard: true, fuer tree)',
        },
        show_counts: {
          type: 'boolean',
          description: 'Funktions-/Variablen-Counts anzeigen (Standard: true, fuer tree)',
        },
        show_comments: {
          type: 'boolean',
          description: 'Kommentare unter Dateien anzeigen (Standard: false, fuer tree)',
        },
        show_functions: {
          type: 'boolean',
          description: 'Funktionsnamen auflisten (Standard: false, fuer tree)',
        },
        show_imports: {
          type: 'boolean',
          description: 'Import-Statements auflisten (Standard: false, fuer tree)',
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
        const tree = await getProjectTree(project, {
          path: str(args, 'path') ?? str(args, 'file_path'),
          recursive: bool(args, 'recursive'),
          depth: num(args, 'depth'),
          show_lines: bool(args, 'show_lines'),
          show_counts: bool(args, 'show_counts'),
          show_comments: bool(args, 'show_comments'),
          show_functions: bool(args, 'show_functions'),
          show_imports: bool(args, 'show_imports'),
          file_type: str(args, 'file_type'),
        });
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

        // PG-Volltext zuerst (schnell, exakt)
        const pgResults = await fullTextSearchCode(project, query, fileType, limit);

        if (pgResults.length > 0) {
          return { success: true, results: pgResults, count: pgResults.length, source: 'pg-fulltext', project };
        }

        // Auto-Fallback auf Qdrant-Semantik bei 0 PG-Treffern
        const semanticResults = await searchCode(query, project, fileType, limit);
        const mappedResults = semanticResults.map(r => ({
          file_path: r.payload.file_path,
          file_type: r.payload.file_type,
          headline: r.payload.content.substring(0, 200),
          rank: r.score,
        }));

        return { success: true, results: mappedResults, count: mappedResults.length, source: 'semantic-fallback', project };
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
