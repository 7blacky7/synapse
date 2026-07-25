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
import { registerAuthHook } from './middleware/auth-hook.js';
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
  workspaceRoutes,
  trayRoutes,
  cliAgentRoutes,
  authRoutes,
  graphRoutes,
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

  // Globaler Auth-Hook (AUTH-4, PLAN-002): gated /api/* + /mcp/* via Bearer-Token
  // (PG-validiert). Allowlist (OAuth, /api/auth/*, /health, Web-UI-Assets, SPA),
  // SSE-Sonderbehandlung (Cookie/?sse_token=) und ENV-Notausgang
  // SYNAPSE_AUTH_DISABLED=1 sind in registerAuthHook gekapselt. Frueh registriert,
  // damit onRequest VOR allen Routen-Handlern feuert.
  registerAuthHook(fastify);

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
  await fastify.register(workspaceRoutes);
  // Tray-Routen (TRAY-1): read-only Endpunkte fuer den Go-Tray. Ersetzen dessen
  // eigene PG-Verbindung mit hartcodierter IP (tray.go:309). Hinter Auth-Hook (AUTH-4).
  await fastify.register(trayRoutes);
  // CLI-Agent-Routen (DIND-5): liefern 503 wenn SYNAPSE_DIND_ENABLED!=1.
  await fastify.register(cliAgentRoutes);

  // Graph-View (PLAN-003 / GRAPH-1): /api/graph/* — Aggregationen direkt aus
  // @synapse/core (PG + Qdrant), kein HTTP-Loopback. Hinter Auth-Hook (AUTH-4).
  await fastify.register(graphRoutes);

  // Web-UI-Auth (AUTH-5): /api/auth/* — im Auth-Hook allowlisted (Bootstrap).
  await fastify.register(authRoutes);

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

  // Workspace-Orchestrator initialisieren (graceful: ohne Docker-Socket faellt
  // er still aus, REST laeuft weiter). Steuerbar per ENV:
  //   WORKSPACE_DISABLED=1           — komplett ausschalten
  //   WORKSPACE_DOCKER_SOCKET=...    — default /var/run/docker.sock
  //   WORKSPACE_IMAGE=...            — default synapse-workspace:latest
  //   WORKSPACE_NETWORK=...          — default proxynet
  //   WORKSPACE_MAX_CONCURRENT=N     — default 5
  //   WORKSPACE_IDLE_MINUTES=N       — default 10
  if (process.env.WORKSPACE_DISABLED !== '1') {
    const { initWorkspaceOrchestrator } = await import('./services/workspace-orchestrator.js');
    // Nur definierte ENV-Werte uebergeben (sonst ueberschreibt 'undefined' die Defaults beim Spread).
    const wsCfg: Record<string, unknown> = {};
    if (process.env.WORKSPACE_DOCKER_SOCKET) wsCfg.socketPath = process.env.WORKSPACE_DOCKER_SOCKET;
    if (process.env.WORKSPACE_IMAGE) wsCfg.image = process.env.WORKSPACE_IMAGE;
    if (process.env.WORKSPACE_NETWORK) wsCfg.network = process.env.WORKSPACE_NETWORK;
    if (process.env.WORKSPACE_MAX_CONCURRENT) wsCfg.maxConcurrent = parseInt(process.env.WORKSPACE_MAX_CONCURRENT, 10);
    if (process.env.WORKSPACE_IDLE_MINUTES) wsCfg.idleStopMinutes = parseInt(process.env.WORKSPACE_IDLE_MINUTES, 10);
    await initWorkspaceOrchestrator(wsCfg);
  } else {
    console.log('[Synapse API] Workspace-Orchestrator per WORKSPACE_DISABLED=1 ausgeschaltet');
  }

  // CLI-Agent-Orchestrator (PLAN-004 / DIND-5): persistente CLI-Agenten-Container
  // (claude/codex/antigravity) auf dem HOST-Docker via docker.sock. ADDITIV +
  // FEATURE-GATED: nur aktiv wenn SYNAPSE_DIND_ENABLED=1 (default aus -> Betrieb,
  // WorkspaceOrchestrator, REST/Web/Auth 100% unveraendert). Steuerbar per ENV:
  //   CLI_AGENT_DOCKER_SOCKET=...  — default /var/run/docker.sock
  //   CLI_AGENT_NETWORK=...        — default proxynet
  if (process.env.SYNAPSE_DIND_ENABLED === '1') {
    const { initCliAgentOrchestrator } = await import('./services/cli-agent-orchestrator.js');
    const cliCfg: Record<string, unknown> = {};
    if (process.env.CLI_AGENT_DOCKER_SOCKET) cliCfg.socketPath = process.env.CLI_AGENT_DOCKER_SOCKET;
    if (process.env.CLI_AGENT_NETWORK) cliCfg.network = process.env.CLI_AGENT_NETWORK;
    await initCliAgentOrchestrator(cliCfg);
  }

  // Parser-Worker-Pool: off-thread parser.parse() via node:worker_threads.
  // Verhindert Event-Loop-Stall bei grossen Files. ENV PARSER_WORKER_THREADS
  // (Default 4, 0=disabled).
  try {
    const { getParserPool } = await import('@synapse/core');
    const pPool = getParserPool();
    if (pPool) {
      await pPool.init();
      console.log(`[Synapse API] ParserPool aktiv (${process.env.PARSER_WORKER_THREADS ?? 4} Workers)`);
    } else {
      console.log('[Synapse API] ParserPool deaktiviert (PARSER_WORKER_THREADS=0)');
    }
  } catch (err) {
    console.error('[Synapse API] ParserPool-Init fehlgeschlagen:', err);
  }

  // Parser-Worker: server-seitige parseUnparsedFiles-Schleife. Schliesst die Luecke
  // wenn KEIN lokaler FileWatcher-Daemon laeuft — Files die via files-Tool / Web-KI
  // in code_files landen, werden hier nachgezogen + code_intel sieht sie.
  // ENV: PARSER_LOOP_DISABLED=1 (default an); PARSER_LOOP_INTERVAL_MS (default 30000).
  if (process.env.PARSER_LOOP_DISABLED !== '1') {
    const { initParserWorker } = await import('./services/parser-worker.js');
    const pwCfg: Record<string, unknown> = {};
    if (process.env.PARSER_LOOP_INTERVAL_MS) pwCfg.intervalMs = parseInt(process.env.PARSER_LOOP_INTERVAL_MS, 10);
    if (process.env.PARSER_LOOP_MAX_PER_TICK) pwCfg.maxPerTick = parseInt(process.env.PARSER_LOOP_MAX_PER_TICK, 10);
    initParserWorker(pwCfg);
  } else {
    console.log('[Synapse API] Parser-Worker per PARSER_LOOP_DISABLED=1 ausgeschaltet');
  }

  // Tool-Call-Retention: aeltert Eintraege im Activity-Store (tool_calls) aus.
  // Laeuft hier (24/7-REST) statt im lokalen Daemon, da die DB zentral ist. ENV:
  //   TOOLCALL_RETENTION_DISABLED=1        — Worker ausschalten
  //   SYNAPSE_TOOLCALL_RETENTION_DAYS=N    — Frist in Tagen (Default 90)
  //   TOOLCALL_RETENTION_INTERVAL_MS=N     — Lauf-Intervall (Default 6h)
  if (process.env.TOOLCALL_RETENTION_DISABLED !== '1') {
    const { expireOldToolCalls } = await import('@synapse/core');
    const retentionIntervalMs = process.env.TOOLCALL_RETENTION_INTERVAL_MS
      ? parseInt(process.env.TOOLCALL_RETENTION_INTERVAL_MS, 10)
      : 6 * 60 * 60 * 1000;
    const runRetention = (): void => {
      void expireOldToolCalls().then((n) => {
        if (n > 0) console.log(`[Synapse API] Tool-Call-Retention: ${n} Eintraege ausgealtert`);
      });
    };
    runRetention(); // einmal beim Start
    setInterval(runRetention, retentionIntervalMs).unref();
    console.log(`[Synapse API] Tool-Call-Retention aktiv (Intervall ${retentionIntervalMs}ms)`);
  } else {
    console.log('[Synapse API] Tool-Call-Retention per TOOLCALL_RETENTION_DISABLED=1 ausgeschaltet');
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
