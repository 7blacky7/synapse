/**
 * Synapse API - Search Routes
 */

import { FastifyInstance } from 'fastify';
import {
  searchCode,
  searchDocsWithFallback,
  globalSearch,
  SearchType,
} from '@synapse/core';

/**
 * SSE Helper - sendet Daten im Server-Sent Events Format
 */
function sendSSE(reply: unknown, event: string, data: unknown): void {
  const fastifyReply = reply as { raw: { write: (chunk: string) => void } };
  fastifyReply.raw.write(`event: ${event}\n`);
  fastifyReply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function endSSE(reply: unknown): void {
  const fastifyReply = reply as { raw: { end: () => void } };
  fastifyReply.raw.end();
}

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

  /**
   * POST /api/search/code/stream
   * Semantische Code-Suche mit SSE (Server-Sent Events)
   */
  fastify.post<{
    Body: {
      query: string;
      project: string;
      fileType?: string;
      limit?: number;
    };
  }>('/api/search/code/stream', async (request, reply) => {
    const { query, project, fileType, limit = 10 } = request.body;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    if (!query || !project) {
      sendSSE(reply, 'error', { message: 'query und project sind erforderlich' });
      endSSE(reply);
      return;
    }

    try {
      sendSSE(reply, 'start', { status: 'searching', query, project });

      const results = await searchCode(query, project, fileType, limit);

      // Sende jedes Ergebnis einzeln
      for (const r of results) {
        sendSSE(reply, 'result', {
          filePath: r.payload.file_path,
          fileName: r.payload.file_name,
          fileType: r.payload.file_type,
          lineStart: r.payload.line_start,
          lineEnd: r.payload.line_end,
          score: r.score,
          content: r.payload.content,
        });
      }

      sendSSE(reply, 'done', { count: results.length });
      endSSE(reply);
    } catch (error) {
      sendSSE(reply, 'error', { message: String(error) });
      endSSE(reply);
    }
  });

  /**
   * POST /api/search/docs/stream
   * Dokumentations-Suche mit SSE
   */
  fastify.post<{
    Body: {
      query: string;
      framework?: string;
      useContext7?: boolean;
      limit?: number;
    };
  }>('/api/search/docs/stream', async (request, reply) => {
    const { query, framework, useContext7 = false, limit = 10 } = request.body;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    if (!query) {
      sendSSE(reply, 'error', { message: 'query ist erforderlich' });
      endSSE(reply);
      return;
    }

    try {
      sendSSE(reply, 'start', { status: 'searching', query, framework });

      const results = await searchDocsWithFallback(query, framework, useContext7, limit);

      for (const r of results) {
        sendSSE(reply, 'result', {
          framework: r.payload.framework,
          version: r.payload.version,
          title: r.payload.title,
          content: r.payload.content,
          url: r.payload.url,
          score: r.score,
        });
      }

      sendSSE(reply, 'done', { count: results.length });
      endSSE(reply);
    } catch (error) {
      sendSSE(reply, 'error', { message: String(error) });
      endSSE(reply);
    }
  });

  /**
   * POST /api/search/global
   * Globale Suche ueber alle Projekte (fuer externe KI-Agenten)
   *
   * Durchsucht parallel:
   * - Code-Collections (alle project_*)
   * - Thoughts-Collection
   * - Memories-Collection
   */
  fastify.post<{
    Body: {
      query: string;
      types?: SearchType[];
      projectFilter?: string[];
      limit?: number;
      minScore?: number;
    };
  }>('/api/search/global', async (request, reply) => {
    const { query, types, projectFilter, limit = 10, minScore = 0.5 } = request.body;

    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query ist erforderlich' },
      });
    }

    try {
      const result = await globalSearch(query, {
        types,
        projectFilter,
        limit,
        minScore,
      });

      return {
        success: true,
        results: result.results,
        counts: result.counts,
        searchedProjects: result.searchedProjects,
        searchTimeMs: result.searchTimeMs,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/search/global/stream
   * Globale Suche mit SSE (Server-Sent Events)
   */
  fastify.post<{
    Body: {
      query: string;
      types?: SearchType[];
      projectFilter?: string[];
      limit?: number;
      minScore?: number;
    };
  }>('/api/search/global/stream', async (request, reply) => {
    const { query, types, projectFilter, limit = 10, minScore = 0.5 } = request.body;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    if (!query) {
      sendSSE(reply, 'error', { message: 'query ist erforderlich' });
      endSSE(reply);
      return;
    }

    try {
      sendSSE(reply, 'start', { status: 'searching', query, types, projectFilter });

      const result = await globalSearch(query, {
        types,
        projectFilter,
        limit,
        minScore,
      });

      // Sende jedes Ergebnis einzeln
      for (const item of result.results) {
        sendSSE(reply, 'result', item);
      }

      sendSSE(reply, 'done', {
        counts: result.counts,
        searchedProjects: result.searchedProjects,
        searchTimeMs: result.searchTimeMs,
      });
      endSSE(reply);
    } catch (error) {
      sendSSE(reply, 'error', { message: String(error) });
      endSSE(reply);
    }
  });
}
