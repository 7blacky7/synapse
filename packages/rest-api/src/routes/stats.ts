/**
 * Synapse API - Stats Routes
 * Index-Statistiken und Projekt-Übersicht
 */

import { FastifyInstance } from 'fastify';
import {
  getProjectStats,
  getCollectionStats,
  scrollVectors,
} from '@synapse/core';

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects/:name/stats
   * Index-Statistiken für ein Projekt
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/stats', async (request, reply) => {
    const { name } = request.params;

    try {
      // Code-Stats holen
      const codeStats = await getProjectStats(name);

      // Thoughts-Collection Stats
      let thoughtsCount = 0;
      let memoriesCount = 0;

      try {
        const thoughtsStats = await getCollectionStats('synapse_thoughts');
        thoughtsCount = thoughtsStats?.pointsCount ?? 0;
      } catch {
        // Collection existiert möglicherweise nicht
      }

      try {
        const memoriesStats = await getCollectionStats('synapse_memories');
        memoriesCount = memoriesStats?.pointsCount ?? 0;
      } catch {
        // Collection existiert möglicherweise nicht
      }

      return {
        success: true,
        stats: {
          project: name,
          totalFiles: codeStats?.fileCount ?? 0,
          totalVectors: (codeStats?.chunkCount ?? 0) + thoughtsCount + memoriesCount,
          collections: {
            code: { vectors: codeStats?.chunkCount ?? 0 },
            thoughts: { vectors: thoughtsCount },
            memories: { vectors: memoriesCount },
          },
        },
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/stats/detailed
   * Detaillierte Statistiken
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/stats/detailed', async (request, reply) => {
    const { name } = request.params;

    try {
      // Code-Chunks nach Dateityp gruppieren
      const collectionName = `project_${name}`;
      let codeByType: Record<string, number> = {};
      let totalChunks = 0;

      try {
        const codePoints = await scrollVectors<{ file_type: string }>(
          collectionName,
          {},
          10000
        );
        totalChunks = codePoints.length;
        codeByType = codePoints.reduce(
          (acc, p) => {
            const type = p.payload?.file_type || 'unknown';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );
      } catch {
        // Collection existiert nicht
      }

      // Thoughts nach Source
      let thoughtsBySource: Record<string, number> = {};
      let totalThoughts = 0;

      try {
        const thoughtPoints = await scrollVectors<{ source: string; project: string }>(
          'synapse_thoughts',
          { must: [{ key: 'project', match: { value: name } }] },
          10000
        );
        totalThoughts = thoughtPoints.length;
        thoughtsBySource = thoughtPoints.reduce(
          (acc, p) => {
            const source = p.payload?.source || 'unknown';
            acc[source] = (acc[source] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );
      } catch {
        // Collection existiert nicht
      }

      // Memories nach Category
      let memoriesByCategory: Record<string, number> = {};
      let totalMemories = 0;

      try {
        const memoryPoints = await scrollVectors<{ category: string; project: string }>(
          'synapse_memories',
          { must: [{ key: 'project', match: { value: name } }] },
          10000
        );
        totalMemories = memoryPoints.length;
        memoriesByCategory = memoryPoints.reduce(
          (acc, p) => {
            const cat = p.payload?.category || 'unknown';
            acc[cat] = (acc[cat] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );
      } catch {
        // Collection existiert nicht
      }

      return {
        success: true,
        stats: {
          project: name,
          code: {
            totalChunks,
            byFileType: codeByType,
          },
          thoughts: {
            total: totalThoughts,
            bySource: thoughtsBySource,
          },
          memories: {
            total: totalMemories,
            byCategory: memoriesByCategory,
          },
        },
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
