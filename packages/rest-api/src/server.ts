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
import { getConfig, initSynapse, getPool, registerVirtualProject, setzeOnboardingRuhe } from '@synapse/core';
import { errorHandler } from './middleware/error.js';
import { registerAuthHook } from './middleware/auth-hook.js';
import {
  statusRoutes,
  projectRoutes,
  assetsRoutes,
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
  authRoutes,
  graphRoutes,
  embeddingNodeRoutes,
  wrapperBridgeRoutes,
  agentWissenRoutes,
  agentRuntimeRoutes,
  modelPoolRoutes,
  projektDbRoutes,
} from './routes/index.js';
import {reverseEingangRoutes} from './routes/reverse-eingang.js';
import { internDaemonRoutes } from './routes/intern-daemon.js';
// P9-T27: Shell-/Spezialisten-Jobs des lokalen Daemons ueber die API
import { daemonJobsRoutes } from './routes/daemon-jobs.js';

/**
 * Erstellt und konfiguriert den Fastify Server
 */
export async function createServer(): Promise<FastifyInstance> {
  // Keine Beschraenkung beim Aendern (29.09.2026): Fastify nimmt ohne Angabe nur 1 MiB Body an.
  // Grosse Plaene (viele Ops, Dateien mit Megabytes) scheiterten daran mit 413, bevor Synapse sie
  // sah. 64 MB, per SYNAPSE_BODY_LIMIT_MB ueberschreibbar. Gilt fuer ALLE Routen, auch die
  // MCP-Endpunkte (POST /, /mcp/messages) — sie laufen ueber denselben JSON-Parser.
  // Davor liegt der Cloudflare-Tunnel: Cloudflare Free/Pro nimmt bis 100 MB je Request an.
  const bodyLimitMb = Number(process.env.SYNAPSE_BODY_LIMIT_MB);
  const fastify = Fastify({
    logger: {
      level: 'info',
    },
    bodyLimit: Math.round((Number.isFinite(bodyLimitMb) && bodyLimitMb > 0 ? bodyLimitMb : 64) * 1024 * 1024),
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
  await fastify.register(assetsRoutes);
  await fastify.register(reverseEingangRoutes);
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
  await fastify.register(projektDbRoutes);
  // Tray-Routen (TRAY-1): read-only Endpunkte fuer den Go-Tray. Ersetzen dessen
  // eigene PG-Verbindung mit hartcodierter IP (tray.go:309). Hinter Auth-Hook (AUTH-4).
  await fastify.register(trayRoutes);
  // GPU-1: Registry/Heartbeat externer Ollama-Compute-Knoten.
  await fastify.register(embeddingNodeRoutes);
  // P15-T12 E2: Debug-Steuerung lokaler Daemons (Long-Poll; ohne SYNAPSE_INTERN_TOOL=1 nur debug:false).
  await fastify.register(internDaemonRoutes);
  // P9-T27 (Welle 1): Shell- und Spezialisten-Jobs des lokalen Daemons per Long-Poll statt PG LISTEN.
  // Rein additiv; der Daemon nutzt sie nur mit SYNAPSE_DAEMON_JOBS_WEG=api bzw. config daemon_jobs_weg.
  await fastify.register(daemonJobsRoutes);

  // API-Bruecke Schritt 1: alles, was der Spezialisten-Wrapper heute per direkter
  // PostgreSQL-Verbindung macht, als HTTP-Routen. Rein additiv — kein bestehender
  // Aufrufweg aendert sich, laufende Wrapper merken davon nichts.
  // Sichtbarkeit: GET /api/projects/:name/wrapper-bridge/health.
  await fastify.register(wrapperBridgeRoutes);

  // API-Bruecke Schritt 4: das Wissen eines Spezialisten (meta, Regeln, Fehler,
  // Muster, Kontext) und sein System-Prompt aus der Datenbank statt von der Platte.
  // Rein additiv — der Dateiweg unter .synapse/agents/<name>/ bleibt unveraendert
  // und wird von niemandem abgeschaltet.
  // Sichtbarkeit: GET /api/projects/:name/agent-wissen/health.
  await fastify.register(agentWissenRoutes);

  // AR-1: generische Agent-Runtimes; Codex ist nur der erste Driver.
  await fastify.register(agentRuntimeRoutes);

  // FP-1: Modell-Pool — Ansicht und Freigabe. Die Freigabe liegt bewusst hier
  // und nicht im MCP-Werkzeug: sie ist eine Entscheidung des Nutzers ueber Geld.
  await fastify.register(modelPoolRoutes);

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
  // P7-T14: NUR die API fuehrt das Schema aus (ensureSchema sperrt alle Tabellen ~2,3 s); Wrapper, MCP-stdio
  // und project(init) pruefen nur. Deploy-Reihenfolge: API zuerst — sie schreibt schema_stand.
  const initialized = await initSynapse('synapse-api', { schema: 'ausfuehren' });

  if (!initialized) {
    console.error('[Synapse API] Core-Initialisierung fehlgeschlagen');
    process.exit(1);
  }

  // ON-2: Ruhefenster starten. NUR hier — der Start der REST-API ist der Deploy, und nur er
  // entwertet die Server-Kennungen aller Agenten. Der lokale MCP-Server fragt den Zeitpunkt
  // bloss ab; wuerde er ihn selbst setzen, begaenne die Ruhe bei jeder Session von vorn.
  await setzeOnboardingRuhe('synapse-api');

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
    const { installTypWorkspacePruefer } = await import('./services/typen-pruefung-workspace.js');
    installTypWorkspacePruefer();
  } else {
    console.log('[Synapse API] Workspace-Orchestrator per WORKSPACE_DISABLED=1 ausgeschaltet');
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

  // P16-T4: Syntaxpruefer Stufe 1 (TS/JS, JSON, CSS ...) fuer files plan/commit und Einzelschreibweg.
  // Eigener Worker-Pool (SYNTAX_WORKER_THREADS, Default 2; 0 = Haupt-Thread), startet hier vorgewaermt.
  // Notaus: SYNTAXPRUEFUNG=0.
  try {
    const { registriereStandardSyntaxPruefer } = await import('@synapse/core');
    const namen = registriereStandardSyntaxPruefer();
    console.log(namen.length > 0
      ? `[Synapse API] Syntaxpruefer angemeldet: ${namen.join(', ')}`
      : '[Synapse API] Syntaxpruefer aus (SYNTAXPRUEFUNG=0)');
  } catch (err) {
    console.error('[Synapse API] Syntaxpruefer-Anmeldung fehlgeschlagen (Schreibweg laeuft ohne Syntaxpruefung):', err);
  }

  // P16-T5: Pruef-Container (Stufe S3) fuer Sprachen ausserhalb des Node-Prozesses (E1: Rust). Die API verwaltet
  // ihn selbst ueber docker.sock (Start bei Bedarf, Idle-Stop, Neustart nach Absturz), siehe services/pruef-container.ts.
  // Ohne Docker oder ohne Image (docker build -t synapse-pruefcontainer:latest docker/synapse-pruefcontainer) bleibt
  // es bei Stufe 1. Notaus: PRUEFCONTAINER=0. Limits: PRUEFCONTAINER_MEM_MB (256), PRUEFCONTAINER_CPUS (1).
  try {
    const { registriereContainerSyntaxPruefer } = await import('./services/pruef-container.js');
    const namen = await registriereContainerSyntaxPruefer();
    if (namen.length > 0) console.log(`[Synapse API] Container-Syntaxpruefer angemeldet: ${namen.join(', ')}`);
  } catch (err) {
    console.error('[Synapse API] Container-Syntaxpruefer-Anmeldung fehlgeschlagen (Schreibweg laeuft ohne):', err);
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

  // R5.2: durable Toolaktivitaet hat eigene Retention; Audit-Vertrag bleibt unveraendert.
  // SYNAPSE_TOOL_AKTIVITAET_RETENTION_DAYS (Default 90), *_INTERVAL_MS (Default 6h).
  if (process.env.SYNAPSE_TOOL_AKTIVITAET_RETENTION_DISABLED !== '1') {
    const {bereinigeToolAktivitaet,toolAktivitaetRetentionTage,registriereWorker,workerPausiert,meldeWorkerArbeit} = await import('@synapse/core');
    toolAktivitaetRetentionTage(); // Fehlkonfiguration nicht still als sichere Leere behandeln.
    const roh = process.env.SYNAPSE_TOOL_AKTIVITAET_RETENTION_INTERVAL_MS;
    const intervall = roh === undefined ? 6 * 60 * 60 * 1000 : Number(roh);
    if (!Number.isSafeInteger(intervall) || intervall < 1 || intervall > 2147483647) {
      throw new Error('Ungueltiges Toolaktivitaet-Retention-Intervall');
    }
    const lauf = async (): Promise<{ausgealtert:number}> => {
      const n = await bereinigeToolAktivitaet();
      if (n > 0) meldeWorkerArbeit('tool-aktivitaet-retention');
      return {ausgealtert:n};
    };
    registriereWorker({name:'tool-aktivitaet-retention',beschreibung:'R5.2 strukturierte Toolaktivitaet',durchlauf:lauf});
    const starten = (): void => {
      if (workerPausiert('tool-aktivitaet-retention')) return;
      void lauf().catch((err:unknown)=>console.error('[Synapse API] Toolaktivitaet-Retention fehlgeschlagen:',err));
    };
    starten();
    setInterval(starten,intervall).unref();
  }

  // P10-T73: bestaetigt demaskierte Shell-Jobs nach Frist wieder maskieren. Arbeitet NUR die kleine
  // Liste shell_demaskierungen ab (kein Scan ueber shell_jobs) und loescht verworfene Rueckfragen.
  //   SYNAPSE_SHELL_NACHMASKIEREN_DISABLED=1   — Worker ausschalten
  //   SYNAPSE_SHELL_NACHMASKIEREN_INTERVAL_MS  — Intervall (Default 60 s)
  //   SYNAPSE_SHELL_DEMASKIERT_STUNDEN         — Frist bis zum Nachmaskieren (Default 72 h)
  if (process.env.SYNAPSE_SHELL_NACHMASKIEREN_DISABLED !== '1') {
    const {shellNachmaskierLauf,registriereWorker,workerPausiert,meldeWorkerArbeit} = await import('@synapse/core');
    const roh = process.env.SYNAPSE_SHELL_NACHMASKIEREN_INTERVAL_MS;
    const intervall = roh === undefined ? 60_000 : Number(roh);
    if (!Number.isSafeInteger(intervall) || intervall < 1000 || intervall > 2147483647) {
      throw new Error('Ungueltiges Shell-Nachmaskier-Intervall');
    }
    const lauf = async (): Promise<{nachmaskiert:number;rueckfragen_entfernt:number}> => {
      const r = await shellNachmaskierLauf();
      if (r.nachmaskiert || r.rueckfragen_entfernt) meldeWorkerArbeit('shell-nachmaskieren');
      return r;
    };
    registriereWorker({name:'shell-nachmaskieren',beschreibung:'P10-T73 bestaetigt demaskierte Shell-Jobs nachmaskieren',durchlauf:lauf});
    const starten = (): void => {
      if (workerPausiert('shell-nachmaskieren')) return;
      void lauf().catch((err:unknown)=>console.error('[Synapse API] Shell-Nachmaskieren fehlgeschlagen:',err));
    };
    starten();
    setInterval(starten,intervall).unref();
  }

  // Tool-Call-Retention: aeltert Eintraege im Activity-Store (tool_calls) aus.
  // Laeuft hier (24/7-REST) statt im lokalen Daemon, da die DB zentral ist. ENV:
  //   TOOLCALL_RETENTION_DISABLED=1        — Worker ausschalten
  //   SYNAPSE_TOOLCALL_RETENTION_DAYS=N    — Frist in Tagen (Default 90)
  //   TOOLCALL_RETENTION_INTERVAL_MS=N     — Lauf-Intervall (Default 6h)
  if (process.env.TOOLCALL_RETENTION_DISABLED !== '1') {
    const { expireOldToolCalls, registriereWorker, workerPausiert, meldeWorkerArbeit } = await import('@synapse/core');
    const retentionIntervalMs = process.env.TOOLCALL_RETENTION_INTERVAL_MS
      ? parseInt(process.env.TOOLCALL_RETENTION_INTERVAL_MS, 10)
      : 6 * 60 * 60 * 1000;
    // P15-T12: pausierbar und einzeln ausloesbar ueber intern(worker_*)
    const retentionLauf = async (): Promise<{ ausgealtert: number }> => {
      const n = await expireOldToolCalls();
      if (n > 0) {
        meldeWorkerArbeit('retention');
        console.log(`[Synapse API] Tool-Call-Retention: ${n} Eintraege ausgealtert`);
      }
      return { ausgealtert: n };
    };
    registriereWorker({ name: 'retention', beschreibung: `Tool-Call-Retention (Intervall ${retentionIntervalMs} ms)`, durchlauf: retentionLauf });
    const runRetention = (): void => {
      if (workerPausiert('retention')) return;
      void retentionLauf().catch((err: unknown) => console.error('[Synapse API] Tool-Call-Retention fehlgeschlagen:', err));
    };
    runRetention(); // einmal beim Start
    setInterval(runRetention, retentionIntervalMs).unref();
    console.log(`[Synapse API] Tool-Call-Retention aktiv (Intervall ${retentionIntervalMs}ms)`);
  } else {
    console.log('[Synapse API] Tool-Call-Retention per TOOLCALL_RETENTION_DISABLED=1 ausgeschaltet');
  }

  // P15-T33 E1: Erklaerungs-Topf - Tagespruefung (belegte Faelle verifizieren, Stufenmodell: ab 6 Monaten
  // markieren, nach 9 Monaten loeschen). Laeuft hier (24/7-REST, zentrale DB). ENV:
  //   ERKLAERUNGEN_JOB_DISABLED=1   - Worker ausschalten
  //   ERKLAERUNGEN_JOB_INTERVAL_MS  - Intervall (Default 24 h)
  if (process.env.ERKLAERUNGEN_JOB_DISABLED !== '1') {
    const { erklaerungenTagespruefung, registriereWorker, workerPausiert, meldeWorkerArbeit } = await import('@synapse/core');
    const erklIntervallMs = process.env.ERKLAERUNGEN_JOB_INTERVAL_MS
      ? parseInt(process.env.ERKLAERUNGEN_JOB_INTERVAL_MS, 10)
      : 24 * 60 * 60 * 1000;
    const erklLauf = async (): Promise<Record<string, unknown>> => {
      const r = await erklaerungenTagespruefung();
      if (r.verifiziert || r.markiert || r.geloescht_9_monate) meldeWorkerArbeit('erklaerungen');
      return r;
    };
    registriereWorker({ name: 'erklaerungen', beschreibung: `Erklaerungs-Topf Tagespruefung (Intervall ${erklIntervallMs} ms)`, durchlauf: erklLauf });
    const runErkl = (): void => {
      if (workerPausiert('erklaerungen')) return;
      void erklLauf().catch((err: unknown) => console.error('[Synapse API] Erklaerungs-Tagespruefung fehlgeschlagen:', err));
    };
    setTimeout(runErkl, 5 * 60 * 1000).unref(); // erster Lauf 5 min nach dem Start
    setInterval(runErkl, erklIntervallMs).unref();
    console.log(`[Synapse API] Erklaerungs-Tagespruefung aktiv (Intervall ${erklIntervallMs}ms)`);
  }

  // P15 E1: Entscheidungs-Topf - Startbestand (packages/core/data/entscheidungstopf-seed.json) idempotent laden
  // (Inhalts-ID und vorhandene Seed-Inhalte), Status aktiv; danach fehlende Vektoren im Hintergrund. 30 s nach dem Start.
  //   ENTSCHEIDUNGSTOPF_SEED_DISABLED=1 - nicht laden (dann per admin(jev_entscheidungstopf, modus seed_laden))
  if (process.env.ENTSCHEIDUNGSTOPF_SEED_DISABLED !== '1') {
    const { ladeEntscheidungstopfSeed, ergaenzeTopfEmbeddings } = await import('@synapse/core');
    setTimeout(() => {
      void ladeEntscheidungstopfSeed({ agent: 'synapse-api-start' })
        .then((r) => {
          console.log(`[Synapse API] Entscheidungs-Topf Seed: ${JSON.stringify({ neu: r.neu, vorhanden: r.vorhanden, fehlerhaft: r.fehlerhaft, error: r.error })}`);
          return ergaenzeTopfEmbeddings();
        })
        .catch((err: unknown) => console.error('[Synapse API] Entscheidungs-Topf Seed fehlgeschlagen:', err));
    }, 30_000).unref();
  }

  // P15-T33 E2: Erklaerungs-Topf - Startbestand (packages/core/data/erklaerungstopf-seed.json) idempotent laden und
  // liegengebliebene Fehlersituationen (erklaerung_ereignisse, abgebrochener Prozess) nachholen. 30 s nach dem Start.
  //   ERKLAERUNGSTOPF_SEED_DISABLED=1 - Seed nicht laden (dann per admin(jev_erklaerungstopf, modus seed_laden));
  //   das Nachholen laeuft trotzdem (auch in der Tagespruefung).
  setTimeout(() => {
    void (async () => {
      const { ladeErklaerungstopfSeed, holeErklaerungsEreignisseNach } = await import('@synapse/core');
      if (process.env.ERKLAERUNGSTOPF_SEED_DISABLED !== '1') {
        const r = await ladeErklaerungstopfSeed({ agent: 'synapse-api-start' });
        console.log(`[Synapse API] Erklaerungs-Topf Seed: ${JSON.stringify({ neu: r.neu, vorhanden: r.vorhanden, abgelehnt: r.abgelehnt, fehlerhaft: r.fehlerhaft, error: r.error })}`);
      }
      const n = await holeErklaerungsEreignisseNach();
      if (n.geholt || n.error) console.log(`[Synapse API] Erklaerungs-Topf nachgeholt: ${JSON.stringify(n)}`);
    })().catch((err: unknown) => console.error('[Synapse API] Erklaerungs-Topf Start fehlgeschlagen:', err));
  }, 30_000).unref();

  // Session-Reaper: meldet Agenten-Sessions ab, die seit Stunden kein Lebenszeichen
  // mehr zeigen. Ohne das bleibt jede Session ewig 'active' — gepurgte, abgestuerzte
  // und verschwundene Agenten inklusive. Am 2026-07-26 zeigte die Liste 28 Eintraege
  // ohne einen einzigen lebenden Prozess, den aeltesten vom 15. Maerz. Laeuft hier
  // statt im lokalen Daemon, weil die DB zentral ist und dieser Prozess 24/7 laeuft.
  //   SESSION_REAPER_DISABLED=1        — Worker ausschalten
  //   SYNAPSE_SESSION_IDLE_HOURS=N     — Frist ohne Lebenszeichen (Default 4)
  //   SESSION_REAPER_INTERVAL_MS=N     — Lauf-Intervall (Default 30 min)
  if (process.env.SESSION_REAPER_DISABLED !== '1') {
    const { expireIdleAgentSessions, registriereWorker, workerPausiert, meldeWorkerArbeit } = await import('@synapse/core');
    const reaperIntervalMs = process.env.SESSION_REAPER_INTERVAL_MS
      ? parseInt(process.env.SESSION_REAPER_INTERVAL_MS, 10)
      : 30 * 60 * 1000;
    // P15-T12: pausierbar und einzeln ausloesbar ueber intern(worker_*)
    const reaperLauf = async (): Promise<{ abgemeldet: number }> => {
      const n = await expireIdleAgentSessions();
      if (n > 0) {
        meldeWorkerArbeit('session_reaper');
        console.log(`[Synapse API] Session-Reaper: ${n} Session(s) abgemeldet`);
      }
      return { abgemeldet: n };
    };
    registriereWorker({ name: 'session_reaper', beschreibung: `Agenten-Sessions ohne Lebenszeichen abmelden (Intervall ${reaperIntervalMs} ms)`, durchlauf: reaperLauf });
    const runReaper = (): void => {
      if (workerPausiert('session_reaper')) return;
      void reaperLauf().catch((err: unknown) => console.error('[Synapse API] Session-Reaper fehlgeschlagen:', err));
    };
    runReaper(); // einmal beim Start
    setInterval(runReaper, reaperIntervalMs).unref();
    console.log(`[Synapse API] Session-Reaper aktiv (Intervall ${reaperIntervalMs}ms)`);
  } else {
    console.log('[Synapse API] Session-Reaper per SESSION_REAPER_DISABLED=1 ausgeschaltet');
  }

  // CE-6: skalierbare Reservierungs-TTLs im 24/7-REST-Prozess (Default an).
  if (process.env.SYNAPSE_RESERVATION_TTL_WORKER_DISABLED !== '1') {
    const { getReservationTtlConfig, renewFileReservationTtls, releaseStaleFileReservations, registriereWorker, workerPausiert } = await import('@synapse/core');
    const reservationTtl = getReservationTtlConfig();
    if (reservationTtl.enabled) {
      // P15-T27: neben dem Verlaengern auch freigeben — abgelaufene nach der Grace-Frist und die
      // abgemeldeter Agenten. Vorher verlaengerte der Worker nur, eine abgelaufene Reservierung blieb
      // mit released_at NULL ewig stehen (Reservierung 3996).
      const reservationLauf = async (): Promise<{ erneuert: number; abgelaufen: number; abgemeldet: number }> => {
        const erneuert = await renewFileReservationTtls();
        const frei = await releaseStaleFileReservations();
        if (frei.abgelaufen + frei.abgemeldet > 0) {
          console.log(`[Synapse API] Reservation-TTL-Worker: ${frei.abgelaufen} abgelaufene, ${frei.abgemeldet} abgemeldete Reservierung(en) freigegeben`);
        }
        return { erneuert, ...frei };
      };
      // P15-T12: pausierbar und einzeln ausloesbar ueber intern(worker_*)
      registriereWorker({
        name: 'reservation_ttl',
        beschreibung: `Reservierungs-TTLs verlaengern, tote Reservierungen freigeben (Intervall ${reservationTtl.workerIntervalMs} ms)`,
        durchlauf: reservationLauf,
      });
      const runReservationRenewal = (): void => {
        if (workerPausiert('reservation_ttl')) return;
        void reservationLauf().catch((error: unknown) => {
          console.error('[Synapse API] Reservation-TTL-Worker fehlgeschlagen:', error);
        });
      };
      runReservationRenewal();
      setInterval(runReservationRenewal, reservationTtl.workerIntervalMs).unref();
      console.log(`[Synapse API] Reservation-TTL-Worker aktiv (Basis ${reservationTtl.baseMinutes}m, Cap ${reservationTtl.maxMinutes}m)`);
    } else {
      console.log('[Synapse API] Reservation-TTL Legacy-Modus aktiv (BASE=0, 5 Minuten)');
    }
  } else {
    console.log('[Synapse API] Reservation-TTL-Worker explizit ausgeschaltet');
  }

  // Server erstellen und starten
  const server = await createServer();
  // A13: derselbe periodische Scanner für Projekt-Share und RV5/_direkt.
  const {registriereProjektShareScanner,starteShareScanner,getAssetKonfiguration}=await import('@synapse/core');
  const shareCfg=getAssetKonfiguration();
  if(shareCfg.aktiv||shareCfg.reverse.aktiv){
    const stopProjektScanner=shareCfg.aktiv?registriereProjektShareScanner():()=>{};
    const {reverseEingang}=await import('@synapse/core');
    const stopReverseScanner=shareCfg.reverse.aktiv?reverseEingang().registriereScanner():()=>{};
    server.addHook('onClose',async()=>{stopReverseScanner();});
    const shareLoop=starteShareScanner();
    const {starteAssetRetention}=await import('@synapse/core');
    const retentionLoop=shareCfg.aktiv?starteAssetRetention():null;
    server.addHook('onClose',async()=>{await shareLoop.beende();await retentionLoop?.beende();stopProjektScanner();});
  }
  // A12: leichte dauerhafte PG-Aufträge; ausschließlich bestätigte Share-Revisionen.
  const {starteAssetInspektion}=await import('@synapse/core');
  const assetInspektion=starteAssetInspektion();
  const {starteReversePipeline}=await import('@synapse/core');
  const reversePipeline=starteReversePipeline();
  if(reversePipeline)server.addHook('onClose',async()=>{await reversePipeline.beende();});
  if(assetInspektion)server.addHook('onClose',async()=>{await assetInspektion.beende();});
  // P18-T59/RV12: Reverse-Executor (nur SYNAPSE_REVERSE_ENABLED=1); Adapter vor initToolLifecycle setzen.
  const {starteReverseExecutor} = await import('./services/reverse-executor.js');
  const reverseExecutor=starteReverseExecutor();
  if(reverseExecutor)server.addHook('onClose',async()=>{await reverseExecutor.beende();});
  // R5.1: eigener opt-in Tool-Lifecycle; alte Workspace/Syntax-Verträge unverändert.
  const {initToolLifecycle,closeToolLifecycle} = await import('./services/tool-lifecycle-runtime.js');
  initToolLifecycle();
  server.addHook('onClose',async()=>{closeToolLifecycle();});

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
