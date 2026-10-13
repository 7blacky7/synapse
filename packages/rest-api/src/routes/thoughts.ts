/**
 * Synapse API - Thoughts Routes
 * Gedankenaustausch zwischen KIs
 */

import { FastifyInstance } from 'fastify';
import {
  addThought,
  getThoughts,
  searchThoughts,
  deleteThought,
} from '@synapse/core';

export async function thoughtsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects/:name/thoughts
   * Gedanken abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { limit?: string };
  }>('/api/projects/:name/thoughts', async (request, reply) => {
    const { name } = request.params;
    const limit = parseInt(request.query.limit || '50', 10);

    try {
      const thoughts = await getThoughts(name, limit);

      return {
        success: true,
        thoughts,
        count: thoughts.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/thoughts
   * Gedanken hinzufuegen
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      source: string;
      content: string;
      tags?: string[];
    };
  }>('/api/projects/:name/thoughts', async (request, reply) => {
    const { name } = request.params;
    const { source, content, tags = [] } = request.body;

    if (!source || !content) {
      return reply.status(400).send({
        success: false,
        error: { message: 'source und content sind erforderlich' },
      });
    }

    try {
      const thought = await addThought(name, source, content, tags);

      return {
        success: true,
        thought,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/thoughts/search
   * Gedanken durchsuchen
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      query: string;
      limit?: number;
    };
  }>('/api/projects/:name/thoughts/search', async (request, reply) => {
    const { name } = request.params;
    const { query, limit = 10 } = request.body;

    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query ist erforderlich' },
      });
    }

    try {
      const results = await searchThoughts(query, name, limit);

      return {
        success: true,
        results: results.map(r => ({
          id: r.id,
          project: r.payload.project,
          source: r.payload.source,
          content: r.payload.content,
          tags: r.payload.tags,
          timestamp: r.payload.timestamp,
          score: r.score,
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
   * DELETE /api/projects/:name/thoughts/:id
   * Gedanken loeschen
   */
  fastify.delete<{
    Params: { name: string; id: string };
  }>('/api/projects/:name/thoughts/:id', async (request, reply) => {
    const { name, id } = request.params;

    try {
      const deleted = await deleteThought(name, id);

      return {
        success: deleted.success,
        message: `Gedanke "${id}" geloescht`,
        warning: deleted.warning,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
