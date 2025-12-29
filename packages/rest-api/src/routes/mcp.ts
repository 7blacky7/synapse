/**
 * Synapse API - MCP over HTTP Routes
 * Für Claude.ai Connectors
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  searchCode,
  searchDocsWithFallback,
  listCollections,
  detectTechnologies,
  indexProjectTechnologies,
  getPlan,
  updatePlan,
  addTask,
  addThought,
  getThoughts,
  searchThoughts,
} from '@synapse/core';
import { randomUUID } from 'crypto';

// MCP Tool Definitionen
const MCP_TOOLS = [
  {
    name: 'init_projekt',
    description: 'Initialisiert ein Projekt: FileWatcher, Technologie-Erkennung, Doku-Caching',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        name: { type: 'string', description: 'Optionaler Projekt-Name (Standard: Ordnername)' },
        index_docs: { type: 'boolean', description: 'Framework-Dokumentation vorladen (Standard: true)' },
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
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
      },
      required: ['path'],
    },
  },
  {
    name: 'index_tech_docs',
    description: 'Indexiert Framework-Dokumentation für erkannte Technologien',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        force_reindex: { type: 'boolean', description: 'Bereits gecachte Docs neu indexieren (Standard: false)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'semantic_code_search',
    description: 'Durchsucht den Code semantisch - findet konzeptuell ähnlichen Code',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage in natürlicher Sprache' },
        project: { type: 'string', description: 'Projekt-Name' },
        file_type: { type: 'string', description: 'Optional: Dateityp filtern' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
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
        query: { type: 'string', description: 'Suchanfrage' },
        framework: { type: 'string', description: 'Optional: Framework filtern' },
        use_context7: { type: 'boolean', description: 'Context7 als Fallback nutzen' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_projects',
    description: 'Listet alle aktiven/indexierten Projekte',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_project_plan',
    description: 'Ruft den Projekt-Plan ab (Ziele, Tasks, Architektur)',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        name: { type: 'string', description: 'Neuer Plan-Name' },
        description: { type: 'string', description: 'Neue Beschreibung' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Neue Ziele' },
        architecture: { type: 'string', description: 'Architektur-Beschreibung' },
      },
      required: ['project'],
    },
  },
  {
    name: 'add_plan_task',
    description: 'Fügt eine neue Task zum Projekt-Plan hinzu',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        title: { type: 'string', description: 'Task-Titel' },
        description: { type: 'string', description: 'Task-Beschreibung' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priorität' },
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
        project: { type: 'string', description: 'Projekt-Name' },
        source: { type: 'string', description: 'Quelle (z.B. claude-web, gpt, user)' },
        content: { type: 'string', description: 'Inhalt des Gedankens' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Tags' },
      },
      required: ['project', 'source', 'content'],
    },
  },
  {
    name: 'get_thoughts',
    description: 'Ruft den Gedankenaustausch für ein Projekt ab',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Projekt-Name' },
        limit: { type: 'number', description: 'Max Anzahl (Standard: 50)' },
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
        query: { type: 'string', description: 'Suchanfrage' },
        project: { type: 'string', description: 'Optional: Projekt filtern' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
      },
      required: ['query'],
    },
  },
];

// SSE Verbindungen speichern
const sseConnections = new Map<string, FastifyReply>();

/**
 * Sendet SSE Nachricht
 */
function sendSSEMessage(reply: FastifyReply, message: object): void {
  const data = JSON.stringify(message);
  reply.raw.write(`data: ${data}\n\n`);
}

/**
 * Verarbeitet MCP Tool Aufrufe
 */
async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'init_projekt': {
      // Hinweis: Im Docker-Container kann kein FileWatcher gestartet werden
      // da die lokalen Dateien nicht zugänglich sind. Stattdessen nur
      // Technologien erkennen und Docs indexieren.
      const projectPath = args.path as string;
      const projectName = (args.name as string) || projectPath.split(/[/\\]/).pop() || 'unknown';
      const indexDocs = args.index_docs !== false;

      // Technologien erkennen und Docs indexieren
      let techs: Awaited<ReturnType<typeof detectTechnologies>> = [];
      let docsIndexed = 0;

      if (indexDocs) {
        techs = await detectTechnologies(projectPath);
        const result = await indexProjectTechnologies(techs);
        docsIndexed = result.indexed;
      }

      return {
        success: true,
        project: projectName,
        path: projectPath,
        technologies: techs,
        docsIndexed,
        message: `Projekt "${projectName}" - Docs indexiert (FileWatcher nicht verfügbar über HTTP)`,
      };
    }

    case 'detect_technologies': {
      const techs = await detectTechnologies(args.path as string);
      return { technologies: techs };
    }

    case 'index_tech_docs': {
      const techs = await detectTechnologies(args.path as string);
      const result = await indexProjectTechnologies(
        techs,
        args.force_reindex as boolean
      );
      return result;
    }

    case 'semantic_code_search': {
      const results = await searchCode(
        args.query as string,
        args.project as string,
        args.file_type as string | undefined,
        (args.limit as number) || 10
      );
      return results.map(r => ({
        filePath: r.payload.file_path,
        fileName: r.payload.file_name,
        fileType: r.payload.file_type,
        lineStart: r.payload.line_start,
        lineEnd: r.payload.line_end,
        score: r.score,
        content: r.payload.content,
      }));
    }

    case 'search_docs': {
      const results = await searchDocsWithFallback(
        args.query as string,
        args.framework as string | undefined,
        args.use_context7 as boolean || false,
        (args.limit as number) || 10
      );
      return results.map(r => ({
        framework: r.payload.framework,
        title: r.payload.title,
        content: r.payload.content,
        url: r.payload.url,
        score: r.score,
      }));
    }

    case 'list_projects': {
      const collections = await listCollections();
      const projects = collections
        .filter(c => c.startsWith('project_'))
        .map(c => c.replace('project_', ''));
      return { projects };
    }

    case 'get_project_plan': {
      const plan = await getPlan(args.project as string);
      return plan || { message: 'Kein Plan gefunden' };
    }

    case 'update_project_plan': {
      const result = await updatePlan(args.project as string, {
        name: args.name as string | undefined,
        description: args.description as string | undefined,
        goals: args.goals as string[] | undefined,
        architecture: args.architecture as string | undefined,
      });
      return result;
    }

    case 'add_plan_task': {
      const result = await addTask(
        args.project as string,
        args.title as string,
        args.description as string,
        args.priority as 'low' | 'medium' | 'high' | undefined
      );
      return result;
    }

    case 'add_thought': {
      const result = await addThought(
        args.project as string,
        args.source as string,
        args.content as string,
        args.tags as string[] | undefined
      );
      return result;
    }

    case 'get_thoughts': {
      const thoughts = await getThoughts(
        args.project as string,
        (args.limit as number) || 50
      );
      return { thoughts };
    }

    case 'search_thoughts': {
      const results = await searchThoughts(
        args.query as string,
        args.project as string | undefined,
        (args.limit as number) || 10
      );
      return results;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /mcp/sse - SSE Endpoint für MCP
   * Claude.ai verbindet sich hier für Server-to-Client Nachrichten
   */
  fastify.get('/mcp/sse', async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = randomUUID();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });

    // Session speichern
    sseConnections.set(sessionId, reply);

    // Endpoint URL für messages senden
    const baseUrl = `${request.protocol}://${request.hostname}`;
    sendSSEMessage(reply, {
      jsonrpc: '2.0',
      method: 'endpoint',
      params: {
        endpoint: `${baseUrl}/mcp/messages?sessionId=${sessionId}`,
      },
    });

    // Keepalive
    const keepalive = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, 30000);

    // Cleanup bei Disconnect
    request.raw.on('close', () => {
      clearInterval(keepalive);
      sseConnections.delete(sessionId);
    });

    // Nicht sofort beenden - Verbindung offen halten
    return reply;
  });

  /**
   * POST /mcp/messages - JSON-RPC Endpoint für MCP
   * Empfängt Tool-Aufrufe von Claude.ai
   */
  fastify.post<{
    Querystring: { sessionId?: string };
    Body: {
      jsonrpc: string;
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
  }>('/mcp/messages', async (request, reply) => {
    const { jsonrpc, id, method, params } = request.body;
    const sessionId = request.query.sessionId;

    // CORS Headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', '*');

    if (jsonrpc !== '2.0') {
      return reply.status(400).send({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC version' },
      });
    }

    try {
      let result: unknown;

      switch (method) {
        case 'initialize': {
          result = {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'synapse-mcp',
              version: '0.1.0',
            },
          };
          break;
        }

        case 'tools/list': {
          result = { tools: MCP_TOOLS };
          break;
        }

        case 'tools/call': {
          const toolName = params?.name as string;
          const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
          const toolResult = await handleToolCall(toolName, toolArgs);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(toolResult, null, 2),
              },
            ],
          };
          break;
        }

        case 'notifications/initialized': {
          // Acknowledgment - keine Antwort nötig
          return reply.status(202).send();
        }

        default: {
          return reply.status(400).send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
      }

      // Erfolgreiche Antwort
      const response = { jsonrpc: '2.0', id, result };

      // Auch über SSE senden wenn Session existiert
      if (sessionId && sseConnections.has(sessionId)) {
        const sseReply = sseConnections.get(sessionId)!;
        sendSSEMessage(sseReply, response);
      }

      return response;
    } catch (error) {
      return reply.status(500).send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: String(error) },
      });
    }
  });

  /**
   * POST / - Root MCP JSON-RPC Endpoint
   * Claude.ai macht POST auf / für MCP Requests
   */
  fastify.post<{
    Body: {
      jsonrpc: string;
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
  }>('/', async (request, reply) => {
    const { jsonrpc, id, method, params } = request.body || {};

    // CORS Headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', '*');

    // Wenn kein JSON-RPC, ignorieren (nicht unser Request)
    if (!jsonrpc) {
      return reply.status(400).send({ error: 'Not a JSON-RPC request' });
    }

    if (jsonrpc !== '2.0') {
      return reply.status(400).send({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC version' },
      });
    }

    console.log(`[MCP] Request: ${method}`);

    try {
      let result: unknown;

      switch (method) {
        case 'initialize': {
          result = {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'synapse-mcp',
              version: '0.1.0',
            },
          };
          break;
        }

        case 'tools/list': {
          result = { tools: MCP_TOOLS };
          break;
        }

        case 'tools/call': {
          const toolName = params?.name as string;
          const toolArgs = (params?.arguments || {}) as Record<string, unknown>;
          const toolResult = await handleToolCall(toolName, toolArgs);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(toolResult, null, 2),
              },
            ],
          };
          break;
        }

        case 'notifications/initialized': {
          // Acknowledgment - keine Antwort nötig bei Notifications
          return reply.status(202).send();
        }

        case 'ping': {
          result = {};
          break;
        }

        default: {
          return reply.status(400).send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
      }

      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      console.error(`[MCP] Error:`, error);
      return reply.status(500).send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: String(error) },
      });
    }
  });

  /**
   * OPTIONS Handler für CORS Preflight
   */
  fastify.options('/mcp/*', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');
    return reply.status(204).send();
  });

  fastify.options('/', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');
    return reply.status(204).send();
  });
}
