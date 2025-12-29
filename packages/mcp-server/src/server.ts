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
  semanticCodeSearch,
  searchDocumentation,
  getProjectPlan,
  updateProjectPlan,
  addPlanTask,
  updatePlanTask,
  addThought,
  getThoughts,
  searchThoughts,
  detectProjectTechnologies,
  indexTechDocs,
} from './tools/index.js';

/**
 * Erstellt und konfiguriert den MCP Server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: 'synapse-mcp',
      version: '0.1.0',
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
        description: 'Bereinigt ein Projekt nach Änderungen an .synapseignore - löscht alle Dateien aus der Vektordatenbank die jetzt ignoriert werden sollen. Nutze dieses Tool wenn du nachträglich Einträge zur .synapseignore hinzugefügt hast.',
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
        name: 'get_project_plan',
        description: 'Ruft den Projekt-Plan ab (Ziele, Tasks, Architektur)',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
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
      {
        name: 'add_thought',
        description: 'Speichert einen Gedanken/eine Idee im Gedankenaustausch',
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Projekt-Name',
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
    ],
  }));

  // Tool-Aufrufe verarbeiten
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'init_projekt': {
          const result = await initProjekt(
            args?.path as string,
            args?.name as string | undefined,
            args?.index_docs !== false // Standard: true
          );
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

        case 'semantic_code_search': {
          const result = await semanticCodeSearch(
            args?.query as string,
            args?.project as string,
            args?.file_type as string | undefined,
            args?.limit as number | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

        case 'get_project_plan': {
          const result = await getProjectPlan(args?.project as string);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'add_plan_task': {
          const result = await addPlanTask(
            args?.project as string,
            args?.title as string,
            args?.description as string,
            args?.priority as 'low' | 'medium' | 'high' | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'add_thought': {
          const result = await addThought(
            args?.project as string,
            args?.source as string,
            args?.content as string,
            args?.tags as string[] | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_thoughts': {
          const result = await getThoughts(
            args?.project as string,
            args?.limit as number | undefined
          );
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'search_thoughts': {
          const result = await searchThoughts(
            args?.query as string,
            args?.project as string | undefined,
            args?.limit as number | undefined
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

  console.error('[Synapse MCP] Server gestartet');
}
