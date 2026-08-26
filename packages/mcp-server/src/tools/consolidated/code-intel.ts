/**
 * Synapse MCP - Consolidated code_intel Tool
 * Strukturierte Code-Abfragen via PostgreSQL (kein Qdrant)
 *
 * 11 Actions:
 *   tree        — Projekt-Verzeichnisbaum mit Symbol-Counts
 *   functions   — Funktionen mit usage_count und parent_name
 *   variables   — Variablen, optional mit Wert
 *   symbols     — Generische Symbol-Abfrage nach symbol_type
 *   references  — Definition + alle Referenzen eines Symbols
 *   search      — PostgreSQL-Volltext-Suche (tsv / ts_rank)
 *   file        — Dateiinhalt aus PG laden
 *   statements  — Ablauf-Ebene: Statements einer Datei/Scope
 *   calls       — Ablauf-Ebene: Call-Edges (Aufrufe)
 *   flow        — Geordnete Top-Level-Ausfuehrung einer Datei/Scope
 *   entrypoints — Projektweite Top-Level executable Statements
 */

import {
  getProjectTree,
  getFunctions,
  getVariables,
  getSymbols,
  getReferences,
  getStatements,
  getCallEdges,
  getExecutionFlow,
  getEntrypoints,
  fullTextSearchCode,
  getFileContent,
  searchCode,
  getParserGesundheitDatei,
  getParserGesundheitUebersicht,
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
          enum: ['tree', 'functions', 'variables', 'symbols', 'references', 'search', 'file', 'statements', 'calls', 'flow', 'entrypoints', 'health'],
          description:
            'Aktion: tree|functions|variables|symbols|references|search|file|statements|calls|flow|entrypoints',
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
          type: ['boolean', 'integer', 'string'],
          description:
            "Kommentare unter Dateien anzeigen (Standard: false, fuer tree). true = einer je Datei, Zahl = so viele, '*' = alle bis 50. Gezeigt werden Zeilennummer und Inhalt; wird gekappt, steht das in der Ausgabe.",
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
        value_contains: {
          type: 'string',
          description:
            "Sucht im INHALT des Symbols statt im Namen (fuer symbols). PFLICHT fuer Kommentare, Strings und TODOs: die tragen name=NULL, ein name-Filter findet dort nie etwas. Beispiel: symbol_type='comment' + value_contains='@SYN-'.",
        },
        include_name_matches: {
          type: 'boolean',
          description:
            'Nur fuer references: mischt die aussortierten Namensgleichen zurueck in references (Standard false). Sie stehen ohnehin immer unter name_matches.',
        },
        comment_chars: {
          type: 'integer',
          description: 'Anzeigelaenge je Kommentarzeile in Zeichen (fuer tree, Standard 100).',
        },
        comment_from: {
          type: 'integer',
          description:
            'Startpunkt im Kommentartext (fuer tree, Standard 0). Mit comment_chars ein Fenster: comment_from=5 + comment_chars=20 zeigt Zeichen 5 bis 24.',
        },
        comment_skip: {
          type: 'integer',
          description:
            'Die ersten N Kommentare je Datei ueberspringen (fuer tree, Standard 0). Blaetterfunktion: comment_skip=9 + show_comments=6 liefert Kommentar 10 bis 15.',
        },
        comment_contains: {
          type: 'string',
          description:
            "Nur Kommentare zeigen, die diesen Text enthalten (fuer tree, zusammen mit show_comments). Macht den Baum zur Suche: show_comments='*' + comment_contains='@SYN-' listet alle Marken mit Datei und Zeile.",
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
            'route',
            'sql_query',
            'table',
            'column',
            'index',
            'view',
            'trigger',
            'constraint',
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
          description: 'Max. Ergebnisse (search: Standard 20; entrypoints: Standard 200)',
        },

        // --- file (range + truncation) ---
        from_line: {
          type: 'number',
          description: 'file: Start-Zeile (1-basiert, Standard: 1)',
        },
        to_line: {
          type: 'number',
          description: 'file: End-Zeile inklusiv (Standard: letzte Zeile). Wird automatisch reduziert wenn Content > 80k Zeichen.',
        },
        truncate_long_lines: {
          type: 'number',
          description: 'file: Zeilen laenger als N Zeichen werden gekuerzt und mit Marker versehen. 0 = deaktiviert (Standard).',
        },

        // --- statements / calls / flow (Ablauf-Ebene) ---
        scope: {
          type: 'string',
          description: 'Scope-Name-Filter fuer statements/flow (z.B. Funktionsname). Ohne scope bei flow: Top-Level-Ausfuehrung der Datei.',
        },
        callee: {
          type: 'string',
          description: 'callee_name-Filter fuer calls-Action (aufgerufener Funktions-/Methodenname).',
        },
        top_level_only: {
          type: 'boolean',
          description: 'Nur Top-Level-Statements zurueckgeben (fuer statements).',
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
          show_comments: args.show_comments as boolean | number | string | undefined,
          comment_contains: str(args, 'comment_contains'),
          comment_chars: num(args, 'comment_chars'),
          comment_from: num(args, 'comment_from'),
          comment_skip: num(args, 'comment_skip'),
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
        const symbols = await getSymbols(project, symbolType, filePath, name, num(args, 'limit') ?? 100, str(args, 'value_contains'));
        return { success: true, symbols, count: symbols.length, symbol_type: symbolType, project };
      }

      case 'references': {
        const name = reqStr(args, 'name');
        // Muss mit rest-api/src/routes/mcp.ts uebereinstimmen — gleiches Schema,
        // gleiches Verhalten. Ein hier nicht ausgelesener Parameter waere genau
        // der Fehler, der bei 'search' und file_path schon einmal passiert ist.
        const result = await getReferences(project, name, bool(args, 'include_name_matches') ?? false);
        return { success: true, ...result, project };
      }

      case 'search': {
        const query = reqStr(args, 'query');
        const fileType = str(args, 'file_type');
        const limit = num(args, 'limit') ?? 20;
        // ⚠️ file_path wurde hier bis 15.08.2026 STILL VERWORFEN — der Parameter stand im
        // Schema, wurde aber nie ausgelesen, und die Suche lieferte Treffer aus dem ganzen
        // Projekt. Das ist derselbe Fehler wie CI-1 (08.08.), der damals nur in core und in
        // der REST-API behoben wurde: rest-api/src/routes/mcp.ts:3783/3794 reicht file_path
        // seitdem an beide Suchen durch, dieser stdio-Handler nicht. Ergebnis waren zwei
        // Strecken mit gleichem Schema und verschiedenem Verhalten — die lokale antwortete
        // ungefiltert, ohne das zu sagen.
        // Semantik wie in der API: Volltext als LIKE-Teilpfad, semantic als VOLLSTAENDIGER
        // Pfad (Qdrant kennt keinen Teilstring-Vergleich).
        const filePath = str(args, 'file_path');

        // .md-Dateien nur bei explizitem file_type:'md' — sonst aus Code-Suche ausschliessen
        const effectiveFileType = fileType;
        const excludeMd = !fileType;

        // PG-Volltext zuerst (schnell, exakt)
        let pgResults = await fullTextSearchCode(project, query, effectiveFileType, limit, filePath);
        if (excludeMd) {
          pgResults = pgResults.filter(r => r.file_type !== 'md');
        }

        if (pgResults.length > 0) {
          return { success: true, results: pgResults, count: pgResults.length, source: 'pg-fulltext', project };
        }

        // Auto-Fallback auf Qdrant-Semantik bei 0 PG-Treffern
        const semanticResults = await searchCode(query, project, effectiveFileType, limit, filePath);
        const mappedResults = semanticResults
          .filter(r => r.score >= 0.65) // Score-Cutoff: keine False Positives
          .filter(r => !excludeMd || r.payload.file_type !== 'md') // .md ausschliessen wenn kein Filter
          .map(r => ({
            file_path: r.payload.file_path,
            file_type: r.payload.file_type,
            headline: (r.payload.content || '').substring(0, 200),
            rank: r.score,
          }));

        return { success: true, results: mappedResults, count: mappedResults.length, source: 'semantic-fallback', project };
      }

      case 'file': {
        const filePath = str(args, 'file_path') ?? str(args, 'path');
        if (!filePath) throw new Error('Parameter "file_path" oder "path" ist erforderlich fuer action "file"');
        const file = await getFileContent(project, filePath, {
          from: num(args, 'from_line'),
          to: num(args, 'to_line'),
          truncate_long_lines: num(args, 'truncate_long_lines'),
        });
        if (!file) {
          return { success: false, message: `Datei nicht gefunden: ${filePath}`, project };
        }
        return { success: true, ...file, project };
      }

      case 'statements': {
        const filePath = str(args, 'file_path');
        const scope = str(args, 'scope');
        const topLevelOnly = bool(args, 'top_level_only');
        const statements = await getStatements(project, filePath, scope, topLevelOnly);
        return { success: true, statements, count: statements.length, project };
      }

      case 'calls': {
        const filePath = str(args, 'file_path');
        const callee = str(args, 'callee') ?? str(args, 'name');
        const calls = await getCallEdges(project, filePath, callee);
        return { success: true, calls, count: calls.length, project };
      }

      case 'flow': {
        const filePath = str(args, 'file_path');
        if (!filePath) throw new Error('Parameter "file_path" ist erforderlich fuer action "flow"');
        const scope = str(args, 'scope');
        const flow = await getExecutionFlow(project, filePath, scope);
        return { success: true, ...flow, count: flow.statements.length, project };
      }

      case 'entrypoints': {
        const filePath = str(args, 'file_path');
        const limit = num(args, 'limit') ?? 200;
        const entrypoints = await getEntrypoints(project, filePath, limit, bool(args, 'include_declarations') === true);
        return { success: true, entrypoints, count: entrypoints.length, project };
      }

      case 'health': {
        // Diagnose statt Raten: unterscheidet "Datei ist leer" von "Parser hat
        // nichts erkannt". Genau diese Unterscheidung fehlte, als index.html mit
        // 100.001 Zeilen functions=0 meldete.
        const filePath = str(args, 'file_path');
        if (!filePath) {
          // Ohne file_path: Projekt-Uebersicht. Zuerst die parser-weiten Befunde,
          // dann die auffaelligen Einzeldateien.
          const uebersicht = await getParserGesundheitUebersicht(project, {
            limit: num(args, 'limit'),
          });
          return { success: true, uebersicht, project };
        }
        const health = await getParserGesundheitDatei(project, filePath);
        if (!health) {
          return { success: false, error: `Datei nicht im Index: ${filePath}`, project };
        }
        return { success: true, health, project };
      }

      default:
        throw new Error(
          `Unbekannte action: "${action}". Erlaubte Werte: tree, functions, variables, symbols, references, search, file, statements, calls, flow, entrypoints, health`
        );
    }
  },
};
