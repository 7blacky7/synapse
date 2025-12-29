/**
 * Synapse API - Server
 * Fastify REST API Server
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { getConfig, initSynapse } from '@synapse/core';
import { errorHandler } from './middleware/error.js';
import {
  statusRoutes,
  projectRoutes,
  searchRoutes,
  thoughtsRoutes,
} from './routes/index.js';

/**
 * Erstellt und konfiguriert den Fastify Server
 */
export async function createServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: 'info',
    },
  });

  // CORS aktivieren (fuer Browser-Zugriff)
  await fastify.register(cors, {
    origin: true, // Alle Origins erlauben (fuer lokales Netzwerk ok)
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
  });

  // Error Handler
  fastify.setErrorHandler(errorHandler);

  // Routes registrieren
  await fastify.register(statusRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(thoughtsRoutes);

  // Health Check
  fastify.get('/health', async () => ({ status: 'ok' }));

  // Root
  fastify.get('/', async () => ({
    name: 'Synapse API',
    version: '0.1.0',
    docs: '/api/status',
  }));

  return fastify;
}

/**
 * Startet den Server
 */
export async function startServer(): Promise<void> {
  const config = getConfig();

  console.log('[Synapse API] Initialisiere...');

  // Synapse Core initialisieren
  const initialized = await initSynapse();

  if (!initialized) {
    console.error('[Synapse API] Core-Initialisierung fehlgeschlagen');
    process.exit(1);
  }

  // Server erstellen und starten
  const server = await createServer();

  try {
    await server.listen({
      host: config.api.host,
      port: config.api.port,
    });

    console.log(`[Synapse API] Server laeuft auf http://${config.api.host}:${config.api.port}`);
  } catch (error) {
    console.error('[Synapse API] Server-Start fehlgeschlagen:', error);
    process.exit(1);
  }
}
