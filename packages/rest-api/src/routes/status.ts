/**
 * Synapse API - Status Route
 */

import { FastifyInstance } from 'fastify';
import { testQdrantConnection, getEmbeddingProvider, listCollections } from '@synapse/core';

export async function statusRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/status
   * Server-Status und Verbindungen pruefen
   */
  fastify.get('/api/status', async (request, reply) => {
    const qdrantOk = await testQdrantConnection();

    let embeddingProvider = 'nicht verfuegbar';
    try {
      const provider = await getEmbeddingProvider();
      embeddingProvider = provider.name;
    } catch {
      // Provider nicht verfuegbar
    }

    let collections: string[] = [];
    try {
      collections = await listCollections();
    } catch {
      // Collections nicht abrufbar
    }

    return {
      success: true,
      status: {
        server: 'running',
        qdrant: qdrantOk ? 'connected' : 'disconnected',
        embeddings: embeddingProvider,
        collections: collections.length,
        timestamp: new Date().toISOString(),
      },
    };
  });
}
