/**
 * Synapse MCP - Server
 * MCP Server Implementation mit allen Tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  initProjekt,
  stopProjekt,
  listActiveProjects,
  cleanupProjekt,
  getProjectStatusWithStats,
  semanticCodeSearch,
  searchDocumentation,
  searchByPath,
  searchCodeWithPath,
  searchDocumentsWrapper,
  getProjectPlan,
  updateProjectPlan,
  addPlanTask,
  updatePlanTask,
  addThought,
  getThoughts,
  searchThoughts,
  detectProjectTechnologies,
  indexTechDocs,
  writeMemory,
  readMemory,
  listMemories,
  searchMemory,
  deleteMemory,
  readMemoryWithCode,
  findMemoriesForFile,
  getIndexStats,
  getDetailedStats,
  saveProjectIdea,
  confirmIdea,
  checkAgentOnboarding,
} from './tools/index.js';

/**
 * Erstellt und konfiguriert den MCP Server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: 'synapse-mcp',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool-Liste registrieren
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ===== PROJEKT-MANAGEMENT =====
      {
        name: 'init_projekt',
        description: '⚠️ STOPP! Bevor du dieses Tool aufrufst: 1) Erstelle ZUERST eine .synapseignore Datei im Projekt-Root 2) Füge Muster für Dateien ein die NICHT indexiert werden sollen (große Dateien, generierte Dateien, etc.) 3) Syntax ist wie .gitignore. Beispiel-Inhalt für .synapseignore: "*.pdf\\n*.zip\\n*.min.js\\ndocs/archived/\\ntests/fixtures/\\n*.generated.*". Erst DANACH dieses Tool aufrufen!',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
            name: {
              type: 'string',
              description: 'Optionaler Projekt-Name (Standard: Ordnername)',
            },
            index_docs: {
              type: 'boolean',
              description: 'Framework-Dokumentation vorladen (Standard: true)',
            },
            agent_id: {
              type: 'string',
              description: 'Optionale Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln (category: rules Memories).',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'detect_technologies',
        description: 'Erkennt verwendete Technologien in einem Projekt (Frameworks, Libraries, Tools)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'index_tech_docs',
        description: 'Indexiert Framework-Dokumentation fuer erkannte Technologien',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
            force_reindex: {
              type: 'boolean',
              description: 'Bereits gecachte Docs neu indexieren (Standard: false)',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'cleanup_projekt',
        description: 'Bereinigt ein Projekt nach Änderungen an .synapseignore - löscht alle Dateien aus der Vektordatenbank die jetzt ignoriert werden sollen. Zeigt detailliertes Feedback: welche Dateien gelöscht wurden, nach Pattern gruppiert.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt-Ordner',
            },
            name: {
              type: 'string',
              description: 'Projekt-Name',
            },
          },
          required: ['path', 'name'],
        },
      },
      {
        name: 'get_index_stats',
        description: 'Zeigt Index-Statistiken für ein Projekt: Anzahl Dateien, Vektoren, aufgeteilt nach Collections (Code, Thoughts, Memories)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'get_detailed_stats',
        description: 'Detaillierte Statistiken: Code nach Dateityp, Thoughts nach Source, Memories nach Kategorie',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'stop_projekt',
        description: 'Stoppt den FileWatcher für ein Projekt und setzt Status auf stopped',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            path: {
              type: 'string',
              description: 'Optional: Absoluter Pfad zum Projekt (fuer Status-Update)',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'list_active_projects',
        description: 'Listet alle Projekte mit aktivem FileWatcher auf',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_project_status',
        description: 'Zeigt den persistenten Status eines Projekts (.synapse/status.json)',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absoluter Pfad zum Projekt',
            },
          },
          required: ['path'],
        },
      },

      // ===== CODE-SUCHE =====
      {
        name: 'semantic_code_search',
        description: 'Durchsucht den Code semantisch - findet konzeptuell aehnlichen Code',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage in natuerlicher Sprache',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            file_type: {
              type: 'string',
              description: 'Optional: Dateityp filtern (z.B. typescript, python)',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query', 'project'],
        },
      },
      {
        name: 'search_by_path',
        description: 'Exakte Pfadsuche ohne Embedding - findet Dateien nach Glob-Pattern. Beispiele: "backend/src/*", "**/*.ts", "**/utils/*"',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            path_pattern: {
              type: 'string',
              description: 'Glob-Pattern für Dateipfade (z.B. "src/**/*.ts", "backend/*")',
            },
            content_pattern: {
              type: 'string',
              description: 'Optional: Regex-Pattern für Content-Filter',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 50)',
            },
          },
          required: ['project', 'path_pattern'],
        },
      },
      {
        name: 'search_code_with_path',
        description: 'Kombinierte Suche: Semantisch + Pfad-Filter. Erst semantisch ranken, dann nach Pfad filtern.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Semantische Suchanfrage',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            path_pattern: {
              type: 'string',
              description: 'Optional: Glob-Pattern für Pfad-Filter',
            },
            file_type: {
              type: 'string',
              description: 'Optional: Dateityp filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query', 'project'],
        },
      },
      {
        name: 'search_docs',
        description: 'Durchsucht Framework-Dokumentation (Cache und optional Context7)',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage',
            },
            framework: {
              type: 'string',
              description: 'Optional: Framework filtern (z.B. react, vue)',
            },
            use_context7: {
              type: 'boolean',
              description: '0=nur Cache, 1=Context7 als Fallback',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_documents',
        description: 'Durchsucht indexierte Dokumente (PDF, Word, Excel) semantisch',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage in natuerlicher Sprache',
            },
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            document_type: {
              type: 'string',
              enum: ['pdf', 'docx', 'xlsx', 'all'],
              description: 'Optional: Dokumententyp filtern (Standard: all)',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query', 'project'],
        },
      },

      // ===== PROJEKT-PLANUNG =====
      {
        name: 'get_project_plan',
        description: 'Ruft den Projekt-Plan ab (Ziele, Tasks, Architektur)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'update_project_plan',
        description: 'Aktualisiert den Projekt-Plan',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Neuer Plan-Name',
            },
            description: {
              type: 'string',
              description: 'Neue Beschreibung',
            },
            goals: {
              type: 'array',
              items: { type: 'string' },
              description: 'Neue Ziele',
            },
            architecture: {
              type: 'string',
              description: 'Architektur-Beschreibung',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'add_plan_task',
        description: 'Fuegt eine neue Task zum Projekt-Plan hinzu',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            title: {
              type: 'string',
              description: 'Task-Titel',
            },
            description: {
              type: 'string',
              description: 'Task-Beschreibung',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Prioritaet (Standard: medium)',
            },
          },
          required: ['project', 'title', 'description'],
        },
      },

      // ===== GEDANKENAUSTAUSCH =====
      {
        name: 'add_thought',
        description: 'Speichert einen Gedanken/eine Idee im Gedankenaustausch (max. 10.000 Zeichen empfohlen)',
        inputSchema: {
          type: 'object',
          properties: {
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
              description: 'Quelle (z.B. claude-code, gpt, user)',
            },
            content: {
              type: 'string',
              description: 'Inhalt des Gedankens',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optionale Tags',
            },
          },
          required: ['project', 'source', 'content'],
        },
      },
      {
        name: 'get_thoughts',
        description: 'Ruft den Gedankenaustausch fuer ein Projekt ab',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl (Standard: 50)',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'search_thoughts',
        description: 'Durchsucht Gedanken semantisch',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query'],
        },
      },

      // ===== MEMORY (LANGZEIT-SPEICHER) =====
      {
        name: 'write_memory',
        description: 'Speichert längere Dokumentation/Notizen persistent. Überschreibt bei gleichem Namen. Für große Dokumente geeignet. Kategorie "rules" fuer Projekt-Regeln die neue Agenten beim Onboarding sehen.',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Eindeutiger Name für das Memory (z.B. "architecture-overview", "api-docs")',
            },
            content: {
              type: 'string',
              description: 'Inhalt des Memories (beliebig lang)',
            },
            category: {
              type: 'string',
              enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
              description: 'Kategorie (Standard: note). "rules" = Projekt-Regeln fuer Agent-Onboarding',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optionale Tags für bessere Suche',
            },
          },
          required: ['project', 'name', 'content'],
        },
      },
      {
        name: 'read_memory',
        description: 'Liest ein Memory nach Name',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Name des Memories',
            },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'list_memories',
        description: 'Listet alle Memories eines Projekts auf',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            category: {
              type: 'string',
              enum: ['documentation', 'note', 'architecture', 'decision', 'rules', 'other'],
              description: 'Optional: Nach Kategorie filtern. "rules" = Projekt-Regeln fuer Agent-Onboarding',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'search_memory',
        description: 'Durchsucht Memories semantisch',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Suchanfrage',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt filtern',
            },
            limit: {
              type: 'number',
              description: 'Maximale Anzahl Ergebnisse (Standard: 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'delete_memory',
        description: 'Löscht ein Memory',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
            },
            agent_id: {
              type: 'string',
              description: 'Agent-ID fuer Onboarding. Neue Agenten sehen automatisch Projekt-Regeln.',
            },
            name: {
              type: 'string',
              description: 'Name des Memories',
            },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'read_memory_with_code',
        description: 'Liest ein Memory und findet verwandten Code basierend auf Dateipfaden im Content',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
            name: { type: 'string', description: 'Memory-Name' },
            codeLimit: { type: 'number', description: 'Max. Code-Chunks (Standard: 10)' },
            includeSemanticMatches: { type: 'boolean', description: 'Semantische Matches einbeziehen (Standard: true)' },
          },
          required: ['project', 'name'],
        },
      },
      {
        name: 'find_memories_for_file',
        description: 'Findet Memories die auf eine bestimmte Datei verweisen',
        inputSchema: {
          type: 'object',
          properties: {
            project: { type: 'string', description: 'Projekt-Name' },
            agent_id: { type: 'string', description: 'Agent-ID fuer Onboarding' },
            filePath: { type: 'string', description: 'Dateipfad' },
            limit: { type: 'number', description: 'Max. Ergebnisse (Standard: 10)' },
          },
          required: ['project', 'filePath'],
        },
      },

      // ===== PROJEKT-IDEEN =====
      {
        name: 'save_project_idea',
        description: 'Speichert eine Projektidee. Generiert automatisch einen Namen und fragt nach Bestaetigung.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Die Projektidee',
            },
            project: {
              type: 'string',
              description: 'Optional: Projekt (Standard: "ideas")',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optionale Tags',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'confirm_idea',
        description: 'Bestaetigt eine vorgeschlagene Idee und speichert sie persistent',
        inputSchema: {
          type: 'object',
          properties: {
            temp_id: {
              type: 'string',
              description: 'Temporaere ID der vorgemerkten Idee',
            },
            custom_name: {
              type: 'string',
              description: 'Optional: Eigener Name statt des vorgeschlagenen',
            },
          },
          required: ['temp_id'],
        },
      },
    ],
  }));

  // Tool-Aufrufe verarbeiten
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Globale Parameter fuer Agent-Onboarding extrahieren
    const agentId = args?.agent_id as string | undefined;
    const projectName = args?.project as string | undefined;

    // Helper: Ergebnis mit Onboarding erweitern
    const withOnboarding = async (result: Record<string, unknown>) => {
      if (!agentId || !projectName) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const onboarding = await checkAgentOnboarding(projectName, agentId);
      if (onboarding?.isFirstVisit && onboarding.rules && onboarding.rules.length > 0) {
        const enhanced = {
          ...result,
          agentOnboarding: {
            isFirstVisit: true,
            message: '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:',
            rules: onboarding.rules,
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(enhanced, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    };

    try {
      switch (name) {
        // ===== PROJEKT-MANAGEMENT =====
        case 'init_projekt': {
          const result = await initProjekt(
            args?.path as string,
            args?.name as string | undefined,
            args?.index_docs !== false,
            agentId
          );
          // Pfad wird automatisch in initProjekt gecacht
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'detect_technologies': {
          const result = await detectProjectTechnologies(args?.path as string);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'index_tech_docs': {
          const result = await indexTechDocs(
            args?.path as string,
            args?.force_reindex as boolean | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'cleanup_projekt': {
          const result = await cleanupProjekt(
            args?.path as string,
            args?.name as string
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_index_stats': {
          const result = await getIndexStats(args?.project as string);
          return withOnboarding(result);
        }

        case 'get_detailed_stats': {
          const result = await getDetailedStats(args?.project as string);
          return withOnboarding(result);
        }

        case 'stop_projekt': {
          const projectName = args?.project as string;
          const projectPath = args?.path as string | undefined;
          const stopped = await stopProjekt(projectName, projectPath);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: stopped,
                project: projectName,
                message: stopped
                  ? `FileWatcher für "${projectName}" gestoppt, Status auf 'stopped' gesetzt`
                  : `Projekt "${projectName}" war nicht aktiv`,
              }, null, 2),
            }],
          };
        }

        case 'list_active_projects': {
          const projects = listActiveProjects();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                count: projects.length,
                projects,
                message: projects.length > 0
                  ? `${projects.length} aktive Projekte: ${projects.join(', ')}`
                  : 'Keine aktiven Projekte',
              }, null, 2),
            }],
          };
        }

        case 'get_project_status': {
          const { path: projectPath } = args as { path: string };
          const result = await getProjectStatusWithStats(projectPath);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        // ===== CODE-SUCHE =====
        case 'semantic_code_search': {
          const result = await semanticCodeSearch(
            args?.query as string,
            args?.project as string,
            args?.file_type as string | undefined,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'search_by_path': {
          const result = await searchByPath(
            args?.project as string,
            args?.path_pattern as string,
            {
              contentPattern: args?.content_pattern as string | undefined,
              limit: args?.limit as number | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'search_code_with_path': {
          const result = await searchCodeWithPath(
            args?.query as string,
            args?.project as string,
            {
              pathPattern: args?.path_pattern as string | undefined,
              fileType: args?.file_type as string | undefined,
              limit: args?.limit as number | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'search_docs': {
          const result = await searchDocumentation(
            args?.query as string,
            args?.framework as string | undefined,
            args?.use_context7 as boolean | undefined,
            args?.limit as number | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'search_documents': {
          const result = await searchDocumentsWrapper(
            args?.query as string,
            args?.project as string,
            args?.document_type as 'pdf' | 'docx' | 'xlsx' | 'all' | undefined,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        // ===== PROJEKT-PLANUNG =====
        case 'get_project_plan': {
          const result = await getProjectPlan(args?.project as string);
          return withOnboarding(result);
        }

        case 'update_project_plan': {
          const result = await updateProjectPlan(
            args?.project as string,
            {
              name: args?.name as string | undefined,
              description: args?.description as string | undefined,
              goals: args?.goals as string[] | undefined,
              architecture: args?.architecture as string | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'add_plan_task': {
          const result = await addPlanTask(
            args?.project as string,
            args?.title as string,
            args?.description as string,
            args?.priority as 'low' | 'medium' | 'high' | undefined
          );
          return withOnboarding(result);
        }

        // ===== GEDANKENAUSTAUSCH =====
        case 'add_thought': {
          const result = await addThought(
            args?.project as string,
            args?.source as string,
            args?.content as string,
            args?.tags as string[] | undefined
          );
          return withOnboarding(result);
        }

        case 'get_thoughts': {
          const result = await getThoughts(
            args?.project as string,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'search_thoughts': {
          const result = await searchThoughts(
            args?.query as string,
            args?.project as string | undefined,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        // ===== MEMORY =====
        case 'write_memory': {
          const result = await writeMemory(
            args?.project as string,
            args?.name as string,
            args?.content as string,
            args?.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined,
            args?.tags as string[] | undefined
          );
          return withOnboarding({ message: result });
        }

        case 'read_memory': {
          const result = await readMemory(
            args?.project as string,
            args?.name as string
          );
          return withOnboarding(result);
        }

        case 'list_memories': {
          const result = await listMemories(
            args?.project as string,
            args?.category as 'documentation' | 'note' | 'architecture' | 'decision' | 'rules' | 'other' | undefined
          );
          return withOnboarding(result);
        }

        case 'search_memory': {
          const result = await searchMemory(
            args?.query as string,
            args?.project as string | undefined,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        case 'delete_memory': {
          const result = await deleteMemory(
            args?.project as string,
            args?.name as string
          );
          return withOnboarding({ message: result });
        }

        case 'read_memory_with_code': {
          const result = await readMemoryWithCode(
            args?.project as string,
            args?.name as string,
            {
              codeLimit: args?.codeLimit as number | undefined,
              includeSemanticMatches: args?.includeSemanticMatches as boolean | undefined,
            }
          );
          return withOnboarding(result);
        }

        case 'find_memories_for_file': {
          const result = await findMemoriesForFile(
            args?.project as string,
            args?.filePath as string,
            args?.limit as number | undefined
          );
          return withOnboarding(result);
        }

        // ===== PROJEKT-IDEEN =====
        case 'save_project_idea': {
          const result = await saveProjectIdea(
            args?.content as string,
            args?.project as string | undefined,
            args?.tags as string[] | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'confirm_idea': {
          const result = await confirmIdea(
            args?.temp_id as string,
            args?.custom_name as string | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          throw new Error(`Unbekanntes Tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Startet den MCP Server
 */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error('[Synapse MCP] Server gestartet (v0.2.0)');
}
