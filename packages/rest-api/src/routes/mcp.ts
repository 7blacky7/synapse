/**
 * Synapse API - MCP over HTTP Routes
 * Für Claude.ai Connectors
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { searchCode, searchDocsWithFallback, listCollections } from '@synapse/core';
import { randomUUID } from 'crypto';

// MCP Tool Definitionen
const MCP_TOOLS = [
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
    description: 'Durchsucht Framework-Dokumentation',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchanfrage' },
        framework: { type: 'string', description: 'Optional: Framework filtern' },
        limit: { type: 'number', description: 'Max Ergebnisse (Standard: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_projects',
    description: 'Listet alle aktiven Projekte',
    inputSchema: {
      type: 'object',
      properties: {},
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
        false,
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
      // Liste Collections die mit "project_" beginnen
      const collections = await listCollections();
      const projects = collections
        .filter(c => c.startsWith('project_'))
        .map(c => c.replace('project_', ''));
      return { projects };
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
   * OPTIONS Handler für CORS Preflight
   */
  fastify.options('/mcp/*', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');
    return reply.status(204).send();
  });
}
