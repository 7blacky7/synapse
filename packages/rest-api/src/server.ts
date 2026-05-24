/**
 * Synapse API - Server
 * Fastify REST API Server
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { getConfig, initSynapse, getPool, registerVirtualProject } from '@synapse/core';
import { errorHandler } from './middleware/error.js';
import {
  statusRoutes,
  projectRoutes,
  searchRoutes,
  thoughtsRoutes,
  mcpRoutes,
  oauthRoutes,
  memoryRoutes,
  statsRoutes,
  ideasRoutes,
  techRoutes,
  proposalRoutes,
  codeIntelRoutes,
  filesRoutes,
  fsEventsRoutes,
  shellRoutes,
  specialistRoutes,
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

  // OAuth zuerst (für /.well-known Endpoints)
  await fastify.register(oauthRoutes);

  // MCP Routes (für Claude.ai Connectors)
  await fastify.register(mcpRoutes);

  // REST API Routes
  await fastify.register(statusRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(searchRoutes);
  await fastify.register(thoughtsRoutes);
  await fastify.register(memoryRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(ideasRoutes);
  await fastify.register(techRoutes);
  await fastify.register(proposalRoutes);
  await fastify.register(codeIntelRoutes);
  await fastify.register(filesRoutes);
  await fastify.register(fsEventsRoutes);
  await fastify.register(shellRoutes);
  await fastify.register(specialistRoutes);

  // Health Check
  fastify.get('/health', async () => ({ status: 'ok' }));

  // API-Info unter /api (Root liefert jetzt das Web-UI-Dashboard)
  fastify.get('/api', async () => ({
    name: 'Synapse API',
    version: '0.2.0',
    docs: '/api/status',
  }));

  // Web-UI (React-Dashboard) Same-Origin ausliefern, wenn ein Build vorliegt
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webUiDist = process.env.WEB_UI_DIST || join(__dirname, '..', '..', 'web-ui', 'dist');

  if (existsSync(join(webUiDist, 'index.html'))) {
    await fastify.register(fastifyStatic, {
      root: webUiDist,
      prefix: '/',
    });

    // SPA-Fallback: unbekannte GET-Routen (kein /api, /mcp, /.well-known) -> index.html
    fastify.setNotFoundHandler((request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api') &&
        !request.url.startsWith('/mcp') &&
        !request.url.startsWith('/.well-known')
      ) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not Found', path: request.url });
    });

    fastify.log.info(`[Synapse API] Web-UI wird ausgeliefert aus ${webUiDist}`);
  } else {
    fastify.log.warn(`[Synapse API] Kein Web-UI-Build gefunden (${webUiDist}) -- nur API aktiv`);
    fastify.get('/', async () => ({
      name: 'Synapse API',
      version: '0.2.0',
      docs: '/api/status',
    }));
  }

  return fastify;
}

/**
 * Startet den Server
 */
export async function startServer(): Promise<void> {
  const config = getConfig();

  console.log('[Synapse API] Initialisiere...');

  // Synapse Core initialisieren
  const initialized = await initSynapse('synapse-api');

  if (!initialized) {
    console.error('[Synapse API] Core-Initialisierung fehlgeschlagen');
    process.exit(1);
  }

  // Virtuelle Projekte fuer REST-API registrieren
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ name: string }>('SELECT DISTINCT name FROM projects');
    for (const p of rows) {
      await registerVirtualProject(p.name);
    }
    console.log(`[Synapse API] ${rows.length} Projekte virtuell registriert`);
  } catch (err) {
    console.warn('[Synapse API] Virtuelle Projekt-Registrierung fehlgeschlagen:', err);
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
