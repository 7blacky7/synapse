/**
 * Synapse API - Memory Routes
 * Persistente Speicherung von Dokumentation und Notizen
 */

import { FastifyInstance } from 'fastify';
import {
  writeMemory,
  getMemoryByName,
  listMemories,
  searchMemories,
  deleteMemory,
  readMemoryWithRelatedCode,
  findMemoriesForPath,
} from '@synapse/core';

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/projects/:name/memories
   * Memory schreiben/aktualisieren
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      memoryName: string;
      content: string;
      category?: 'documentation' | 'note' | 'architecture' | 'decision' | 'other';
      tags?: string[];
    };
  }>('/api/projects/:name/memories', async (request, reply) => {
    const { name } = request.params;
    const { memoryName, content, category = 'note', tags = [] } = request.body;

    if (!memoryName || !content) {
      return reply.status(400).send({
        success: false,
        error: { message: 'memoryName und content sind erforderlich' },
      });
    }

    try {
      const existing = await getMemoryByName(name, memoryName);
      const memory = await writeMemory(name, memoryName, content, category, tags);

      return {
        success: true,
        memory: {
          name: memory.name,
          category: memory.category,
          tags: memory.tags,
          sizeChars: memory.content.length,
          createdAt: memory.createdAt,
          updatedAt: memory.updatedAt,
        },
        isUpdate: !!existing,
        message: existing
          ? `Memory "${memoryName}" aktualisiert (${content.length} Zeichen)`
          : `Memory "${memoryName}" erstellt (${content.length} Zeichen)`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/memories/:memoryName
   * Memory lesen
   */
  fastify.get<{
    Params: { name: string; memoryName: string };
  }>('/api/projects/:name/memories/:memoryName', async (request, reply) => {
    const { name, memoryName } = request.params;

    try {
      const memory = await getMemoryByName(name, memoryName);

      if (!memory) {
        return reply.status(404).send({
          success: false,
          error: { message: `Memory "${memoryName}" nicht gefunden in Projekt "${name}"` },
        });
      }

      return {
        success: true,
        memory,
        message: `Memory "${memoryName}" geladen (${memory.content.length} Zeichen)`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/memories
   * Alle Memories eines Projekts auflisten
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { category?: string };
  }>('/api/projects/:name/memories', async (request, reply) => {
    const { name } = request.params;
    const { category } = request.query;

    try {
      const memories = await listMemories(
        name,
        category as 'documentation' | 'note' | 'architecture' | 'decision' | 'other' | undefined
      );

      return {
        success: true,
        memories: memories.map((m) => ({
          name: m.name,
          category: m.category,
          tags: m.tags,
          sizeChars: m.content.length,
          updatedAt: m.updatedAt,
        })),
        count: memories.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/memories/search
   * Memories semantisch durchsuchen
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      query: string;
      limit?: number;
    };
  }>('/api/projects/:name/memories/search', async (request, reply) => {
    const { name } = request.params;
    const { query, limit = 10 } = request.body;

    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query ist erforderlich' },
      });
    }

    try {
      const results = await searchMemories(query, name, limit);

      return {
        success: true,
        results: results.map((r) => ({
          name: r.payload.name,
          category: r.payload.category,
          score: r.score,
          preview: r.payload.content.substring(0, 200) + (r.payload.content.length > 200 ? '...' : ''),
        })),
        count: results.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * DELETE /api/projects/:name/memories/:memoryName
   * Memory löschen
   */
  fastify.delete<{
    Params: { name: string; memoryName: string };
  }>('/api/projects/:name/memories/:memoryName', async (request, reply) => {
    const { name, memoryName } = request.params;

    try {
      const deleted = await deleteMemory(name, memoryName);

      if (!deleted) {
        return reply.status(404).send({
          success: false,
          error: { message: `Memory "${memoryName}" nicht gefunden` },
        });
      }

      return {
        success: true,
        message: `Memory "${memoryName}" gelöscht`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/memories/:memoryName/with-code
   * Memory mit verwandtem Code abrufen
   */
  fastify.get<{
    Params: { name: string; memoryName: string };
    Querystring: { codeLimit?: string; includeSemanticMatches?: string };
  }>('/api/projects/:name/memories/:memoryName/with-code', async (request, reply) => {
    const { name, memoryName } = request.params;
    const codeLimit = request.query.codeLimit ? parseInt(request.query.codeLimit, 10) : 10;
    const includeSemanticMatches = request.query.includeSemanticMatches !== 'false';

    try {
      const result = await readMemoryWithRelatedCode(name, memoryName, {
        codeLimit,
        includeSemanticMatches,
      });

      if (!result) {
        return reply.status(404).send({
          success: false,
          error: { message: `Memory "${memoryName}" nicht gefunden` },
        });
      }

      return {
        success: true,
        memory: result.memory,
        relatedCode: result.relatedCode,
        hasMoreCode: result.hasMoreCode,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/files/:filePath/memories
   * Memories für eine Datei finden
   * Hinweis: filePath muss URL-encoded sein
   */
  fastify.get<{
    Params: { name: string; filePath: string };
    Querystring: { limit?: string };
  }>('/api/projects/:name/files/:filePath/memories', async (request, reply) => {
    const { name, filePath } = request.params;
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 10;

    try {
      const results = await findMemoriesForPath(name, decodeURIComponent(filePath), limit);

      return {
        success: true,
        results: results.map(r => ({
          name: r.memory.name,
          category: r.memory.category,
          matchType: r.matchType,
          score: r.score,
          linkedPaths: r.memory.linkedPaths,
          preview: r.memory.content.substring(0, 200) + (r.memory.content.length > 200 ? '...' : ''),
        })),
        count: results.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
