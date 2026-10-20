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
} from '@synapse/core';
import { leseRuntimeDaemonZugang, stelleRuntimeDaemonZugangAus, widerrufeRuntimeDaemonZugangKomplett } from '../services/agent-runtime/daemon-zugang.js';

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
async function bucheMainChatVerbrauch(session: MainAgentSession, modell: string | null, usage: Record<string, unknown> | null): Promise<void> {
  if (!usage) return;
  await bucheAgentVerbrauch({
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
  fastify.get('/api/main-agent/status', async (_request, reply) => {
    try { return { success: true, ...(await hauptagentStatus(USER)) }; } catch (error) { return sendFachFehler(reply, error); }
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
  fastify.post<{ Body: { runtime?: unknown; modell?: unknown; grund?: unknown; hands_off?: unknown } }>('/api/main-agent/wechsel', async (request, reply) => {
    const b = request.body ?? {};
    const runtime = typeof b.runtime === 'string' ? b.runtime : '';
    const modell = typeof b.modell === 'string' && b.modell.trim() ? b.modell.trim() : null;
    if (!manager.listDrivers().some((d) => d.runtime === runtime)) {
      return reply.status(400).send({ success: false, error: { code: 'runtime_unbekannt', message: 'runtime_unbekannt' } });
    }
    try {
      await manager.assertMainRuntimeReady(runtime as RuntimeName, false);
    } catch {
      return reply.status(409).send({ success: false, error: { code: 'runtime_nicht_bereit', message: 'Runtime ist nicht installiert, laufend und angemeldet' } });
    }
    try {
      const identitaet = (await leseHauptagentSchalter()).aktiv ? await hauptagentIdentitaetsId() : null;
      if (identitaet) {
        const status = await hauptagentStatus(USER) as { identitaet?: { runtime_tatsaechlich?: string | null; runtime_gewuenscht?: string | null } };
        const aktuell = status.identitaet?.runtime_tatsaechlich ?? status.identitaet?.runtime_gewuenscht ?? null;
        const nurModell = !!modell && aktuell === runtime;
        const ergebnis = await legeRuntimeAuftragAn(USER, {
          art: nurModell ? 'modellwechsel' : 'runtime_wechsel',
          gewuenscht: nurModell ? { modell } : { runtime, ...(modell ? { modell } : {}) },
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
    Body: { message?: string };
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

    // Artefakt-Zustellung: solange dieser Strom offen ist, kann das artefakt-Tool
    // Events in GENAU diese Session einspeisen (kein Broadcast, artifact-stream.ts).
    registerArtifactStream(session.id, (item: RuntimeStreamEvent) => sse(reply, item.event, item.data));

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
          sse(reply, item.event, item.data);
        },
        controller.signal,
      );
      await manager.completeSession(session.id, result.runtimeSessionId, result.context);
      // P22-T6: auf dem dauerhaften Container-Weg bucht der Wrapper selbst (T7 meldeVerbrauch); hier nur der Altweg.
      if (result.context?.hauptagent_weg !== 'dauerhaft') await bucheMainChatVerbrauch(session, modell, letzteUsage);
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
      if (!controller.signal.aborted) {
        sse(reply, 'error', { message: errorMessage(error) });
        reply.raw.end();
      }
    } finally {
      unregisterArtifactStream(session.id);
      reply.raw.off('close', onClose);
    }
  });
}
