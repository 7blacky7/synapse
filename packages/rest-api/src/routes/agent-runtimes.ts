import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validateToken, type TokenKind } from '../services/auth.js';
import { getAgentRuntimeManager, shutdownAgentRuntimeManager } from '../services/agent-runtime/manager.js';
import type { MainAgentSession, RuntimeName, RuntimeStreamEvent } from '../services/agent-runtime/types.js';
import { countArtifacts, registerArtifactStream, unregisterArtifactStream } from '../services/agent-runtime/artifact-stream.js';
import { agentApiRoutes } from './agent-api.js';
import {
  leseHauptagentSchalter, setzeHauptagentSchalter, hauptagentStatus, listeRuntimeAuftraege, legeRuntimeAuftragAn, brecheRuntimeAuftragAb, w1bFehlerStatus,
  listeRuntimeProjekte,
  leseHauptagentHeartbeat, setzeHauptagentHeartbeat, hauptagentIdentitaetsId, leseVerbrauchSchalter, setzeVerbrauchSchalter, leseAgentVerbrauch,
  bucheAgentVerbrauch, HAUPTAGENT_PROJEKT, HAUPTAGENT_AGENT_ID,
  leseRuntimeUeberwachung, setzeRuntimeUeberwachungSchalter, setzeRuntimeUeberwachungEinstellungen, markiereRuntimeAngehalten,
  listeArtefakte, ladeArtefakt, onlineKoordinatoren, queryToolCalls,
  leseCliModelleSchalter, pruefeModellFuerRuntime, leseUserModellWahl, synapseModellId, CLI_MODELL_RUNTIMES, type CliModellRuntime,
  pruefeEffortFuerModell, leseEffortWahl,
  leseVerlaufSchalter, setzeVerlaufSchalter, legeVerlaufTurnAn, starteVerlaufAntwort, leseVerlauf, leereVerlauf, verlaufStatus, geraetAusUserAgent, rendereToolBild,
} from '@synapse/core';
import { leseRuntimeDaemonZugang, stelleRuntimeDaemonZugangAus, widerrufeRuntimeDaemonZugangKomplett } from '../services/agent-runtime/daemon-zugang.js';
import { letzterMainWegFehler } from '../services/agent-runtime/dauerhafter-main.js';

/**
 * P22-T7: Art einer Runtime. CLI-Runtimes laufen mit Abo-Login im Container (nur Token-Anzeige), alle anderen sind
 * API-Zugaenge (eigene Anmeldung/Konfiguration, Kosten). Getrennt halten, nie vermischen (User 88f80455 Punkt 2).
 */
export function runtimeArt(runtime: string): 'cli' | 'api' {
  return runtime === 'claude' || runtime === 'codex' ? 'cli' : 'api';
}

function zahl(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** P22-T7: Turn-Verbrauch des Web-UI-Main-Chats (Altweg docker exec je Turn); letzte usage-Meldung des Turns zaehlt. */
async function bucheMainChatVerbrauch(session: MainAgentSession, modell: string | null, usage: Record<string, unknown> | null, referenz: string | null = null): Promise<void> {
  if (!usage) return;
  await bucheAgentVerbrauch({
    // P22-T63: referenz verlauf:<antwort_id> verknuepft die Buchung mit dem Verlauf und bucht sie genau einmal.
    referenz,
    project: HAUPTAGENT_PROJEKT, identity_id: session.identityId ?? null, agent_id: HAUPTAGENT_AGENT_ID, runtime: session.runtime,
    zugang: runtimeArt(session.runtime) === 'cli' ? 'abo' : 'api', modell,
    input_tokens: zahl(usage.inputTokens), output_tokens: zahl(usage.outputTokens),
    cache_read_tokens: zahl(usage.cacheReadInputTokens ?? usage.cachedInputTokens), cache_creation_tokens: zahl(usage.cacheCreationInputTokens),
    quelle: 'main_chat', lauf_id: session.laufId ?? null,
  }).catch(() => undefined);
}

/** P22-T36: Fachfehler (Code) mit passendem HTTP-Status, nie Ausweis-/DB-Texte. */
function sendFachFehler(reply: FastifyReply, error: unknown): FastifyReply {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{2,80}$/.test(code)) {
    const details = (error as { details?: unknown }).details;
    return reply.status(w1bFehlerStatus(code)).send({ success: false,
      error: { code, message: code, ...(details && typeof details === 'object' ? { details } : {}) } });
  }
  return sendError(reply, error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendError(reply: FastifyReply, error: unknown, status = 500): FastifyReply {
  return reply.status(status).send({ success: false, error: { message: errorMessage(error) } });
}

function sse(reply: FastifyReply, event: string, data: Record<string, unknown>): void {
  reply.raw.write('event: ' + event + '\n');
  reply.raw.write('data: ' + JSON.stringify(data) + '\n\n');
}

export function runtimeTokenAllowed(kind: TokenKind): boolean {
  return kind === 'access' || kind === 'session';
}

function requestToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string'
    ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim()
    : null;
  if (bearer) return bearer;
  const query = request.query as Record<string, unknown> | undefined;
  if (typeof query?.sse_token === 'string') return query.sse_token;
  const cookie = request.headers.cookie;
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'synapse_session') return decodeURIComponent(value.join('='));
  }
  return null;
}

async function guardInteractiveRuntimeRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const pathname = request.url.split('?')[0];
  if (!pathname.startsWith('/api/agent-runtimes') && !pathname.startsWith('/api/main-agent')) return;
  if (process.env.SYNAPSE_AUTH_DISABLED === '1') return;
  const token = requestToken(request);
  const principal = token ? await validateToken(token) : null;
  if (!principal) {
    await reply.code(401).send({ success: false, error: { code: 'unauthorized', message: 'Interaktive Benutzer-Session erforderlich' } });
    return;
  }
  if (!runtimeTokenAllowed(principal.kind)) {
    await reply.code(403).send({ success: false, error: { code: 'service_token_forbidden', message: 'Service-/Daemon-/Wrapper-Tokens duerfen Agent-Runtimes nicht bedienen' } });
  }
}

export async function agentRuntimeRoutes(fastify: FastifyInstance): Promise<void> {
  const manager = getAgentRuntimeManager();

  fastify.addHook('onRequest', guardInteractiveRuntimeRequest);
  fastify.addHook('onClose', async () => shutdownAgentRuntimeManager());
  // P22-T8: API-Agent - User-Routen unter /api/main-agent/api* (Guard oben), Transport /api/agent-api/* (Ausweis).
  await agentApiRoutes(fastify);

  fastify.get('/api/agent-runtimes', async (_request, reply) => {
    try {
      return {
        success: true,
        drivers: manager.listDrivers(),
        instances: await manager.listStatuses(),
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<{ Params: { runtime: string } }>('/api/agent-runtimes/:runtime/status', async (request, reply) => {
    try {
      return { success: true, status: await manager.driver(request.params.runtime).status() };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  fastify.put<{
    Params: { runtime: string };
    Body: { rootPath?: string; image?: string; model?: string };
  }>('/api/agent-runtimes/:runtime/config', async (request, reply) => {
    if (!request.body?.rootPath || typeof request.body.rootPath !== 'string') {
      return sendError(reply, new Error('rootPath ist erforderlich'), 400);
    }
    try {
      const status = await manager.driver(request.params.runtime).configure({
        rootPath: request.body.rootPath,
        image: request.body.image,
        model: request.body.model,
      });
      // P22-T58: configure kann den Container entfernen (Image-/Root-Wechsel) - die Ueberwachung legt ihn dann nicht selbst neu an.
      if (status.container.status !== 'running') await markiereRuntimeAngehalten(request.params.runtime, 'user:configure');
      return { success: true, status };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  for (const action of ['setup', 'start', 'stop'] as const) {
    fastify.post<{ Params: { runtime: string } }>('/api/agent-runtimes/:runtime/' + action, async (request, reply) => {
      try {
        const driver = manager.driver(request.params.runtime);
        const status = action === 'setup'
          ? await driver.setup()
          : action === 'start'
            ? await driver.start()
            : await driver.stop();
        // P22-T58: vom User angehalten -> die Runtime-Ueberwachung startet den Container nicht wieder.
        if (action === 'stop') await markiereRuntimeAngehalten(request.params.runtime, 'user:stop');
        return { success: true, status };
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }

  fastify.post<{
    Params: { runtime: string };
    Body: { cols?: number; rows?: number; command?: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions', async (request, reply) => {
    try {
      const session = await manager.driver(request.params.runtime).openTerminal(request.body ?? {});
      manager.terminals.add(session);
      return { success: true, sessionId: session.id };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<{
    Params: { runtime: string; sessionId: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId/events', async (request, reply) => {
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const subscription = manager.terminals.subscribe(request.params.sessionId, (item) => {
        sse(reply, item.event, item.data);
      });
      for (const item of subscription.replay) sse(reply, item.event, item.data);
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
      const cleanup = (): void => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
      };
      reply.raw.once('close', cleanup);
      reply.raw.once('error', cleanup);
    } catch (error) {
      if (!reply.sent) return sendError(reply, error, 404);
    }
  });

  fastify.post<{
    Params: { runtime: string; sessionId: string };
    Body: { data?: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId/input', async (request, reply) => {
    if (typeof request.body?.data !== 'string') return sendError(reply, new Error('data ist erforderlich'), 400);
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      manager.terminals.write(request.params.sessionId, request.body.data);
      return { success: true };
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  fastify.post<{
    Params: { runtime: string; sessionId: string };
    Body: { cols?: number; rows?: number };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId/resize', async (request, reply) => {
    const cols = Number(request.body?.cols);
    const rows = Number(request.body?.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 8) {
      return sendError(reply, new Error('cols >= 20 und rows >= 8 sind erforderlich'), 400);
    }
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      await manager.terminals.resize(request.params.sessionId, cols, rows);
      return { success: true };
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  fastify.delete<{
    Params: { runtime: string; sessionId: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId', async (request, reply) => {
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      return { success: true, closed: manager.terminals.close(request.params.sessionId) };
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  fastify.get('/api/main-agent/runtime', async (_request, reply) => {
    try {
      return { success: true, ...(await manager.mainAssignment()) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<{
    Body: { runtime?: RuntimeName | null };
  }>('/api/main-agent/runtime', async (request, reply) => {
    const runtime = request.body?.runtime ?? null;
    if (runtime !== null && runtime !== 'codex' && runtime !== 'claude' && runtime !== 'free-pool') {
      return sendError(reply, new Error('Unbekannte Runtime'), 400);
    }
    try {
      return { success: true, ...(await manager.assignMain(runtime)) };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  // P22-T36 (W2-P1): Hauptagent. Diese Routen sind nur fuer den interaktiven User offen (Guard oben) -> Akteur User.
  const USER = { art: 'user' } as const;
  fastify.get('/api/main-agent/schalter', async (_request, reply) => {
    try { return { success: true, schalter: await leseHauptagentSchalter() }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/schalter', async (request, reply) => {
    try {
      return { success: true, schalter: await setzeHauptagentSchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund }) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T63: Gespraechsverlauf des Hauptagenten je Main-Identitaet (geraeteuebergreifend, Vertrag thought 97d9a354).
  // Ohne seit_rev: Seite (neueste zuerst, vor_id = aeltere nachladen); mit seit_rev: nur Aenderungen fuer den Live-Abgleich.
  fastify.get<{ Querystring: { limit?: string; vor_id?: string; seit_rev?: string; ab_id?: string } }>('/api/main-agent/verlauf', async (request, reply) => {
    try { return { success: true, ...(await leseVerlauf(request.query)) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  // Leeren nur durch den User mit ausdruecklicher Bestaetigung (Knopf mit Rueckfrage), nie automatisch.
  fastify.delete<{ Body: { bestaetigt?: unknown } }>('/api/main-agent/verlauf', async (request, reply) => {
    try { return { success: true, ...(await leereVerlauf(USER, { bestaetigt: request.body?.bestaetigt })) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/verlauf/schalter', async (_request, reply) => {
    try { return { success: true, schalter: await leseVerlaufSchalter() }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/verlauf/schalter', async (request, reply) => {
    try {
      return { success: true, schalter: await setzeVerlaufSchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund }) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/verlauf/status', async (_request, reply) => {
    try { return { success: true, ...(await verlaufStatus()) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  // P8-T25: Koordinatoren aller Projekte mit aktuellem Lebenszeichen (Seitenleiste der Web-UI).
  fastify.get('/api/koordinatoren/online', async (_request, reply) => {
    try {
      const koordinatoren = await onlineKoordinatoren();
      return { success: true, count: koordinatoren.length, koordinatoren };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P8-T25: HTML-Artefakte des Hauptagenten (agent_artifacts) fuer "Persoenliche Artefakte" – nur lesend.
  fastify.get<{ Querystring: { limit?: string } }>('/api/main-agent/artefakte', async (request, reply) => {
    try {
      const artefakte = await listeArtefakte(request.query.limit ? Number(request.query.limit) : 100);
      return { success: true, count: artefakte.length, artefakte };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get<{ Params: { id: string } }>('/api/main-agent/artefakte/:id', async (request, reply) => {
    try {
      const artefakt = await ladeArtefakt(request.params.id);
      if (!artefakt) return reply.code(404).send({ success: false, error: { message: 'Artefakt nicht gefunden' } });
      return { success: true, artefakt };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P8-T26: Tool-Aufrufe NUR des Hauptagenten (projektuebergreifend) fuer Main-Chat und Arbeitsraum. Akteur aus
  // gespeicherten Daten: Main-Identitaet (identity_id), agent_id 'hauptagent' ohne identity_id (Identitaetsweg ausserhalb
  // seines Bereichs) und 'main-<session>' (Altweg). Nie Aufrufe anderer Agenten als Ersatz; leer bleibt leer.
  const hauptagentAkteure = async () => {
    const identityId = await hauptagentIdentitaetsId();
    return { identityIds: identityId ? [identityId] : [], agentIds: [HAUPTAGENT_AGENT_ID], mainSessions: true };
  };
  fastify.get<{ Querystring: { limit?: string } }>('/api/main-agent/tool-calls', async (request, reply) => {
    const limit = Number(request.query.limit);
    try {
      const calls = await queryToolCalls({ akteure: await hauptagentAkteure(), limit: Number.isFinite(limit) ? limit : 12, detail: 'summary' });
      return { success: true, count: calls.length, calls };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get<{ Params: { id: string } }>('/api/main-agent/tool-calls/:id', async (request, reply) => {
    try {
      const rows = await queryToolCalls({ akteure: await hauptagentAkteure(), id: request.params.id, detail: 'full', limit: 1 });
      if (!rows.length) return reply.code(404).send({ success: false, error: { message: 'Tool-Aufruf des Hauptagenten nicht gefunden' } });
      return { success: true, call: rows[0] };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T67: Bild zu einem Werkzeugaufruf (Verweis project + file_path [+ revision] aus dem Verlauf); Rechte wie die Web-UI-Sitzung.
  fastify.get<{ Querystring: { project?: string; file_path?: string; revision?: string } }>('/api/main-agent/tool-bild', async (request, reply) => {
    try {
      const bild = await rendereToolBild({ project: request.query.project, file_path: request.query.file_path, revision: request.query.revision });
      if (!bild.ok) return reply.code(bild.status).send({ success: false, error: { code: bild.fehlercode, message: bild.grund } });
      return reply.code(200).type('image/png').header('Cache-Control', 'private, max-age=300').header('X-Bild-Revision', bild.revision)
        .header('X-Bild-Aktuell', bild.aktuell ? '1' : '0').header('X-Bild-Breite', String(bild.breite)).header('X-Bild-Hoehe', String(bild.hoehe)).send(bild.png);
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/status', async (_request, reply) => {
    // P22-T66: debug_main_weg = letzter Fehler des dauerhaften Main-Wegs mit Ursache (null = keiner seit API-Start).
    try { return { success: true, ...(await hauptagentStatus(USER)), debug_main_weg: { letzter_fehler: letzterMainWegFehler() } }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/auftraege', async (_request, reply) => {
    try { return { success: true, ...(await listeRuntimeAuftraege(USER)) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Body: { art?: unknown; gewuenscht?: unknown; hands_off?: unknown; grund?: unknown; idempotenz_schluessel?: unknown } }>(
    '/api/main-agent/auftraege', async (request, reply) => {
      const b = request.body ?? {};
      try {
        return { success: true, ...(await legeRuntimeAuftragAn(USER, {
          art: b.art, gewuenscht: b.gewuenscht, hands_off: b.hands_off, grund: b.grund, idempotenz_schluessel: b.idempotenz_schluessel,
        })) };
      } catch (error) { return sendFachFehler(reply, error); }
    });
  fastify.post<{ Params: { auftragId: string }; Body: { grund?: unknown } }>(
    '/api/main-agent/auftraege/:auftragId/abbrechen', async (request, reply) => {
      try {
        return { success: true, ...(await brecheRuntimeAuftragAb(USER, { auftrag_id: request.params.auftragId, grund: request.body?.grund })) };
      } catch (error) { return sendFachFehler(reply, error); }
    });

  // P22-T5 (W2b): Runtime-Daemon-Zugang (Client-Zugang des Daemons im Container, NICHT der Agenten-Ausweis) und Projekte
  // des Container-Hosts (projects.hostname, nur lesen). Nur der interaktive User (Guard oben); Klartext erscheint in keiner Antwort.
  const CONTAINER_RUNTIMES = ['claude', 'codex'];
  const containerRuntime = (r: string): string => {
    if (!CONTAINER_RUNTIMES.includes(r)) throw Object.assign(new Error('runtime_ungueltig'), { code: 'runtime_ungueltig' });
    return r;
  };
  fastify.get<{ Params: { runtime: string } }>('/api/agent-runtimes/:runtime/daemon-zugang', async (request, reply) => {
    try { return { success: true, zugang: await leseRuntimeDaemonZugang(containerRuntime(request.params.runtime)) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Params: { runtime: string }; Body: { grund?: unknown } }>('/api/agent-runtimes/:runtime/daemon-zugang', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try { return { success: true, zugang: await stelleRuntimeDaemonZugangAus(containerRuntime(request.params.runtime), request.body?.grund) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.delete<{ Params: { runtime: string }; Body: { grund?: unknown } }>('/api/agent-runtimes/:runtime/daemon-zugang', async (request, reply) => {
    try { return { success: true, zugang: await widerrufeRuntimeDaemonZugangKomplett(containerRuntime(request.params.runtime), request.body?.grund) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  /**
   * P22-T61: Modellliste der CLI im Container (claude: Modellkatalog der CLI, codex: app-server model/list bzw. models_cache.json).
   * Kein Rueckfall auf feste Listen: ohne Quelle leere Liste + grund. ?neu=1 umgeht den Zwischenspeicher (60 s).
   */
  fastify.get<{ Params: { runtime: string }; Querystring: { neu?: string } }>('/api/agent-runtimes/:runtime/modelle', async (request, reply) => {
    try {
      const driver = manager.driver(containerRuntime(request.params.runtime));
      if (!driver.modelle) throw Object.assign(new Error('runtime_ungueltig'), { code: 'runtime_ungueltig' });
      const neu = request.query?.neu === '1' || request.query?.neu === 'true';
      return { success: true, modelle: await driver.modelle({ neu }) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get<{ Params: { runtime: string } }>('/api/agent-runtimes/:runtime/projekte', async (request, reply) => {
    try { return { success: true, projekte: await listeRuntimeProjekte(containerRuntime(request.params.runtime)) }; } catch (error) { return sendFachFehler(reply, error); }
  });

  // P22-T7 (W2d): Heartbeat des Hauptagenten (nur User), Runtime-Wechsel, Runtime-Liste getrennt nach Art, Verbrauch.
  fastify.get('/api/main-agent/heartbeat', async (_request, reply) => {
    try { return { success: true, ...(await leseHauptagentHeartbeat(USER)) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; intervall_ms?: unknown; grund?: unknown } }>('/api/main-agent/heartbeat', async (request, reply) => {
    const b = request.body ?? {};
    try {
      return { success: true, ...(await setzeHauptagentHeartbeat(USER, { aktiv: b.aktiv, intervall_ms: b.intervall_ms, grund: b.grund })) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/runtimes', async (_request, reply) => {
    try {
      const statuses = await manager.listStatuses();
      return {
        success: true,
        runtimes: manager.listDrivers().map((d) => {
          const s = statuses.find((x) => x.runtime === d.runtime);
          const bereit = !!s && s.installed && s.container.status === 'running' && s.authentication.status === 'authenticated';
          return { runtime: d.runtime, label: d.label, art: runtimeArt(d.runtime), bereit, zugewiesen: !!s?.assignedToMain, modell: s?.model ?? null };
        }),
      };
    } catch (error) { return sendError(reply, error); }
  });
  /**
   * Wechsel jederzeit (User 88f80455 Punkt 3). Schalter hauptagent EIN + Identitaet: Auftrag runtime_wechsel bzw. modellwechsel
   * an die Identitaet (Ausweis bleibt, Ausfuehrung durch den Runtime-Daemon, P22-T6). Sonst Altweg: Zuweisung assigned_to_main.
   */
  fastify.post<{ Body: { runtime?: unknown; modell?: unknown; effort?: unknown; grund?: unknown; hands_off?: unknown } }>('/api/main-agent/wechsel', async (request, reply) => {
    const b = request.body ?? {};
    const runtime = typeof b.runtime === 'string' ? b.runtime : '';
    let modell = typeof b.modell === 'string' && b.modell.trim() ? b.modell.trim() : null;
    if (!manager.listDrivers().some((d) => d.runtime === runtime)) {
      return reply.status(400).send({ success: false, error: { code: 'runtime_unbekannt', message: 'runtime_unbekannt' } });
    }
    try {
      await manager.assertMainRuntimeReady(runtime as RuntimeName, false);
    } catch {
      return reply.status(409).send({ success: false, error: { code: 'runtime_nicht_bereit', message: 'Runtime ist nicht installiert, laufend und angemeldet' } });
    }
    // P22-T62 (Schalter hauptagent_cli_modelle EIN): Modell muss in der Liste der Ziel-Runtime stehen; ehrliche Meldung statt
    // stillem Ersetzen. Codex-slug ohne Praefix wird zu 'codex/<slug>'.
    if (modell && (runtime === 'claude' || runtime === 'codex')) {
      try {
        const p = await pruefeModellFuerRuntime(modell, runtime);
        if (p.quelle !== 'schalter_aus') {
          if (!p.passt) {
            const code = p.grund?.startsWith('modellliste_fehlt') ? 'modellliste_fehlt' : (p.grund ?? 'modell_passt_nicht');
            return reply.status(400).send({ success: false, error: { code, message: p.grund ?? code, details: { modell, runtime, gelistet: p.gelistet } } });
          }
          modell = p.modell;
        }
      } catch (error) { return sendFachFehler(reply, error); }
    }
    try {
      const identitaet = (await leseHauptagentSchalter()).aktiv ? await hauptagentIdentitaetsId() : null;
      if (identitaet) {
        const status = await hauptagentStatus(USER) as { identitaet?: { runtime_tatsaechlich?: string | null; runtime_gewuenscht?: string | null; modell_gewuenscht?: string | null } };
        const aktuell = status.identitaet?.runtime_tatsaechlich ?? status.identitaet?.runtime_gewuenscht ?? null;
        // P22-T65 (Schalter hauptagent_cli_modelle EIN): Effort-Stufe je Modell. Ohne Modell gilt das aktuelle Modell derselben
        // Runtime (Effort-Wechsel ohne Modellwechsel = modellwechsel). Ungueltige Stufe -> ehrliche Meldung. Ohne Stufe beim
        // Modellwechsel bleibt die gespeicherte Stufe dieses Modells (sonst Standard der CLI).
        const effortRoh = typeof b.effort === 'string' && b.effort.trim() ? b.effort.trim() : null;
        const cliEin = (runtime === 'claude' || runtime === 'codex') && (await leseCliModelleSchalter()).aktiv;
        let effort: string | null = null;
        if (effortRoh) {
          if (!cliEin) return reply.status(400).send({ success: false, error: { code: 'effort_nur_mit_modellwahl', message: 'Effort-Wahl braucht den Schalter hauptagent_cli_modelle' } });
          const zielModell = modell ?? (aktuell === runtime ? status.identitaet?.modell_gewuenscht ?? null : null);
          if (!zielModell) return reply.status(400).send({ success: false, error: { code: 'effort_ohne_modell', message: 'Fuer die Effort-Stufe ein Modell waehlen' } });
          const pe = await pruefeEffortFuerModell(runtime as CliModellRuntime, zielModell, effortRoh);
          if (!pe.ok) {
            return reply.status(400).send({ success: false, error: { code: pe.grund ?? 'effort_ungueltig', message: pe.grund ?? 'effort_ungueltig',
              details: { effort: effortRoh, modell: zielModell, stufen: pe.stufen } } });
          }
          effort = pe.effort;
          modell = zielModell;
        } else if (cliEin && modell) {
          effort = (await leseEffortWahl().catch(() => ({} as Record<string, string>)))[modell] ?? null;
        }
        const nurModell = !!modell && aktuell === runtime;
        const ergebnis = await legeRuntimeAuftragAn(USER, {
          art: nurModell ? 'modellwechsel' : 'runtime_wechsel',
          gewuenscht: nurModell ? { modell, ...(effort ? { effort } : {}) } : { runtime, ...(modell ? { modell } : {}), ...(effort ? { effort } : {}) },
          hands_off: b.hands_off, grund: b.grund,
        });
        return { success: true, weg: 'auftrag', art: runtimeArt(runtime), ...ergebnis };
      }
      if (modell) {
        return reply.status(400).send({ success: false, error: { code: 'modellwechsel_nur_identitaetsweg', message: 'Modellwechsel braucht den Schalter hauptagent und die Main-Identitaet' } });
      }
      return { success: true, weg: 'zuweisung', art: runtimeArt(runtime), ...(await manager.assignMain(runtime as RuntimeName)) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  /**
   * P22-T62: Modelle BEIDER CLI-Runtimes fuer die Hauptagent-Steuerung. Nur bereite Runtimes (installiert, laufend, angemeldet)
   * liefern ihre Liste; die andere steht mit ehrlichem Grund da. Je Runtime: Standard ohne Wahl (quelle user_wahl|kleinstes|
   * schalter_aus|keins, grund), gespeicherte User-Wahl, Synapse-ID je Modell (codex: 'codex/<slug>'). Schalter mit Quelle (Debug).
   */
  fastify.get('/api/main-agent/modelle', async (_request, reply) => {
    try {
      const [schalter, statuses, wahl, effortWahl] = await Promise.all([
        leseCliModelleSchalter(), manager.listStatuses(), leseUserModellWahl().catch(() => ({} as Partial<Record<CliModellRuntime, string>>)),
        leseEffortWahl().catch(() => ({} as Record<string, string>)),
      ]);
      const runtimes = await Promise.all(CLI_MODELL_RUNTIMES.map(async (rt) => {
        const d = manager.driver(rt);
        const s = statuses.find((x) => x.runtime === rt);
        const grund = !s || !s.configured ? 'nicht_konfiguriert' : !s.installed ? 'cli_nicht_installiert'
          : s.container.status !== 'running' ? 'container_' + s.container.status : s.authentication.status !== 'authenticated' ? 'nicht_angemeldet' : null;
        const liste = grund ? null : await d.modelle!();
        const standard = await manager.standardModellWahl(rt)
          .catch((error) => ({ modell: null, quelle: 'keins' as const, grund: errorMessage(error), user_wahl: wahl[rt] ?? null }));
        return {
          runtime: rt, label: d.label, bereit: !grund, zugewiesen: !!s?.assignedToMain, grund: grund ?? (liste?.modelle.length ? null : liste?.grund ?? 'keine_modelle'),
          standard, standard_grund: standard.grund, user_wahl: wahl[rt] ?? null, pruefung: s?.pruefung ?? null, quelle: liste?.quelle ?? null, quelle_detail: liste?.quelle_detail ?? null, stand: liste?.stand ?? null,
          cli_version: liste?.cli_version ?? null, hinweise: liste?.hinweise ?? [],
          // P22-T65: effort_wahl = gespeicherte Stufe des Modells (sonst gilt standard_effort).
          modelle: (liste?.modelle ?? []).map((m) => ({ ...m, modell: synapseModellId(rt, m.id), effort_wahl: effortWahl[synapseModellId(rt, m.id)] ?? null })),
        };
      }));
      return { success: true, schalter, runtimes };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/verbrauch/schalter', async (_request, reply) => {
    try { return { success: true, schalter: await leseVerbrauchSchalter() }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/verbrauch/schalter', async (request, reply) => {
    try {
      return { success: true, schalter: await setzeVerbrauchSchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund }) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  /**
   * P22-T58: Runtime-Ueberwachung (Steuerung in der API). Lesen: Schalter, Stand je Runtime, letzte Ereignisse, Einstellungen.
   * Schalter/Einstellungen setzt hier der User; Koordinatoren nutzen admin (profil_schalter_setzen, runtime_ueberwachung).
   */
  fastify.get<{ Querystring: { ereignisse?: string } }>('/api/main-agent/ueberwachung', async (request, reply) => {
    try {
      const n = Number(request.query?.ereignisse);
      return { success: true, ...(await leseRuntimeUeberwachung({ ereignisse: Number.isFinite(n) && n > 0 ? n : 20 })) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/ueberwachung/schalter', async (request, reply) => {
    try {
      return { success: true, schalter: await setzeRuntimeUeberwachungSchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund }) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { werte?: unknown; entfernen?: unknown; grund?: unknown } }>('/api/main-agent/ueberwachung/einstellungen', async (request, reply) => {
    const b = request.body ?? {};
    try {
      return { success: true, einstellungen: await setzeRuntimeUeberwachungEinstellungen(USER, null, { werte: b.werte, entfernen: b.entfernen, grund: b.grund }) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Body: { trocken?: unknown } }>('/api/main-agent/ueberwachung/takt', async (request, reply) => {
    try {
      return { success: true, bericht: await manager.ueberwachungJetzt(request.body?.trocken !== false) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  /** Verbrauch aller Agenten (nicht nur des Hauptagenten) je Agent/Projekt/Monat; User sieht alle Projekte. */
  fastify.get<{ Querystring: { monat?: string; project?: string } }>('/api/main-agent/verbrauch', async (request, reply) => {
    try {
      return { success: true, ...(await leseAgentVerbrauch(USER, { monat: request.query?.monat, project: request.query?.project })) };
    } catch (error) { return sendFachFehler(reply, error); }
  });

  fastify.post<{
    Body: { runtime?: RuntimeName };
  }>('/api/main-agent/sessions', async (request, reply) => {
    try {
      const session = await manager.createMainSession(request.body?.runtime);
      return { success: true, session };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  fastify.post<{
    Params: { sessionId: string };
    Body: { message?: string; anhaenge?: unknown };
  }>('/api/main-agent/sessions/:sessionId/messages', async (request, reply) => {
    if (typeof request.body?.message !== 'string' || !request.body.message.trim()) {
      return sendError(reply, new Error('message ist erforderlich'), 400);
    }
    let session;
    let modell: string | null = null;
    try {
      session = await manager.getMainSession(request.params.sessionId);
      manager.driver(session.runtime);
      modell = (await manager.assertMainRuntimeReady(session.runtime)).model;
      await manager.markSessionRunning(session.id);
    } catch (error) {
      return sendError(reply, error, 404);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sse(reply, 'ready', { sessionId: session.id, runtime: session.runtime });

    // P22-T63: Verlauf je Main-Identitaet. User-Nachricht + laufende Antwort sofort in PG (andere Geraete sehen sie), danach
    // jedes Stromereignis gedrosselt. Nur Sitzungen der Main-Identitaet bei Schalter hauptagent_verlauf EIN; Fehler hier
    // lassen den Turn nie scheitern. 'verlauf' sagt der Web-UI, unter welchen Server-IDs die beiden Zeilen stehen.
    const turn = await legeVerlaufTurnAn({
      identity_id: session.identityId, text: request.body.message, session_id: session.id, runtime: session.runtime, modell,
      lauf_id: 'altweg:' + session.id, geraet: geraetAusUserAgent(request.headers['user-agent']), anhaenge: request.body.anhaenge,
    });
    const verlauf = turn.gespeichert ? starteVerlaufAntwort(turn.antwort_id, {
      // Lauf: Altweg je CLI-Sitzung; auf dem dauerhaften Weg setzt core den Lauf des Main (aktuellerMainLauf).
      modell, identity_id: turn.identity_id, user_id: turn.user_id, user_text: request.body.message, runtime: session.runtime, lauf_id: 'altweg:' + session.id,
    }) : null;
    sse(reply, 'verlauf', turn.gespeichert ? { user_id: turn.user_id, antwort_id: turn.antwort_id } : { aus: turn.grund });

    // Artefakt-Zustellung: solange dieser Strom offen ist, kann das artefakt-Tool
    // Events in GENAU diese Session einspeisen (kein Broadcast, artifact-stream.ts).
    registerArtifactStream(session.id, (item: RuntimeStreamEvent) => {
      verlauf?.ereignis(item.event, item.data);
      sse(reply, item.event, item.data);
    });

    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    reply.raw.once('close', onClose);
    let letzteUsage: Record<string, unknown> | null = null;
    try {
      const result = await manager.driver(session.runtime).sendMessage(
        session,
        request.body.message,
        (item: RuntimeStreamEvent) => {
          if (item.event === 'usage') letzteUsage = item.data;
          verlauf?.ereignis(item.event, item.data);
          sse(reply, item.event, item.data);
        },
        controller.signal,
      );
      await manager.completeSession(session.id, result.runtimeSessionId, result.context);
      // P22-T6: auf dem dauerhaften Container-Weg bucht der Wrapper selbst (T7 meldeVerbrauch); hier nur der Altweg.
      if (result.context?.hauptagent_weg !== 'dauerhaft') {
        const referenz = verlauf && letzteUsage ? 'verlauf:' + verlauf.antwort_id : null;
        await bucheMainChatVerbrauch(session, modell, letzteUsage, referenz);
        if (referenz) verlauf?.verbrauchReferenz(referenz);
      }
      await verlauf?.abschliessen(controller.signal.aborted ? 'abgebrochen' : 'fertig', { laufkontext: result.context });
      if (!controller.signal.aborted) {
        sse(reply, 'done', {
          sessionId: session.id,
          runtimeSessionId: result.runtimeSessionId,
          context: result.context,
          // Zaehlung fuer die Empfangsseite (Format 19189/3): weicht sie von den
          // tatsaechlich angekommenen Events ab, macht die UI das sichtbar.
          artifacts: countArtifacts(session.id),
        });
        reply.raw.end();
      }
    } catch (error) {
      await manager.failSession(session.id, error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
      await verlauf?.abschliessen(controller.signal.aborted ? 'abgebrochen' : 'fehler', { fehler: errorMessage(error) });
      if (!controller.signal.aborted) {
        sse(reply, 'error', { message: errorMessage(error) });
        reply.raw.end();
      }
    } finally {
      unregisterArtifactStream(session.id);
      reply.raw.off('close', onClose);
      // Idempotent: nur wirksam, wenn oben kein Endstand geschrieben wurde.
      void verlauf?.abschliessen('abgebrochen');
    }
  });
}
