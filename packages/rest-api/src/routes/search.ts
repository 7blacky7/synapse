/**
 * Synapse API - Search Routes
 */

import { FastifyInstance } from 'fastify';
import { searchCode, searchDocsWithFallback } from '@synapse/core';

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/search/code
   * Semantische Code-Suche
   */
  fastify.post<{
    Body: {
      query: string;
      project: string;
      fileType?: string;
      limit?: number;
    };
  }>('/api/search/code', async (request, reply) => {
    const { query, project, fileType, limit = 10 } = request.body;

    if (!query || !project) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query und project sind erforderlich' },
      });
    }

    try {
      const results = await searchCode(query, project, fileType, limit);

      return {
        success: true,
        results: results.map(r => ({
          filePath: r.payload.file_path,
          fileName: r.payload.file_name,
          fileType: r.payload.file_type,
          lineStart: r.payload.line_start,
          lineEnd: r.payload.line_end,
          score: r.score,
          content: r.payload.content,
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
   * POST /api/search/docs
   * Dokumentations-Suche
   */
  fastify.post<{
    Body: {
      query: string;
      framework?: string;
      useContext7?: boolean;
      limit?: number;
    };
  }>('/api/search/docs', async (request, reply) => {
    const { query, framework, useContext7 = false, limit = 10 } = request.body;

    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query ist erforderlich' },
      });
    }

    try {
      const results = await searchDocsWithFallback(query, framework, useContext7, limit);

      return {
        success: true,
        results: results.map(r => ({
          framework: r.payload.framework,
          version: r.payload.version,
          title: r.payload.title,
          content: r.payload.content,
          url: r.payload.url,
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
}
