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
  listeArtefakte, ladeArtefakt, onlineKoordinatoren, queryToolCalls, postToInbox, mitAgentAufrufKontext, leseAgentBezugModus,
  leseCliModelleSchalter, pruefeModellFuerRuntime, leseUserModellWahl, synapseModellId, CLI_MODELL_RUNTIMES, type CliModellRuntime,
  pruefeEffortFuerModell, leseEffortWahl, listModels, setzeCliKontextQuelle,
  leseVerlaufSchalter, setzeVerlaufSchalter, legeVerlaufTurnAn, starteVerlaufAntwort, leseVerlauf, leereVerlauf, verlaufStatus, geraetAusUserAgent, rendereToolBild,
  leseVerlaufFuer, AGENT_VERLAUF_ALLE_FUNKTION, leseProfilProduktSchalter, getPool, leseToolKartenSchalter, toolKarteFuerStrom,
  leseToolKartenEinstellungen, setzeToolKartenEinstellungen,
  warteschlangeAktiv, mainWechselOffen, stelleInWarteschlange, NICHT_ERREICHT_CODES, warteschlangeStatus, leseWarteschlangeSchalter, setzeWarteschlangeSchalter,
} from '@synapse/core';
import { leseRuntimeDaemonZugang, stelleRuntimeDaemonZugangAus, widerrufeRuntimeDaemonZugangKomplett } from '../services/agent-runtime/daemon-zugang.js';
import { leseRuntimeUebersicht, leseRuntimeAgentLog, leseRuntimeProzesse, steuereRuntimeAgent, frageProzessAenderungAn, bestaetigeProzessAenderung, wechslePlattformAgentModell } from '@synapse/core';
import { bewerteArtefakt, leseBewertungen, leseDesignVorlieben, zerlegeQuellenListe, BewertungsFehler, leseTopArtefakte, leseBewertungsSchnappschuss, artefaktBewertungSchalter } from '@synapse/core';
import { abonniereBewertungsLive, bewertungLiveStatus } from '../services/artefakt-bewertung-live.js';
import {
  renderArtefakt, renderungsProjekte, ladeVorlagenZeile, artefaktVorlagenSchalter, leseArtefaktVorlagenEinstellungen, setzeArtefaktVorlagenEinstellungen,
  artefaktQuellenKatalog, ArtefaktVorlagenFehler, ARTEFAKT_VORLAGEN_LIVE_FUNKTION, ARTEFAKT_VERWEISE_FUNKTION, type ArtefaktRenderErgebnis,
} from '@synapse/core';
// P22-T166: Artefakte mit Skript (nur Top-Artefakte) - nur lesende Daten-Bruecke.
import { artefaktSkriptBruecke, artefaktSkripteSchalter, skriptBrueckeStatus, ArtefaktSkriptFehler } from '@synapse/core';
// P22-T168: Zitat-Anhaenge im Chat (Schalter chat_zitate, Grenzen als Einstellungen, Textblock fuer jede Agentenart).
import {
  pruefeChatZitateAnfrage, textMitZitaten, zitatAlsVerlaufAnhang, leseChatZitateSchalter, leseChatZitateEinstellungen, setzeChatZitateEinstellungen,
  type ZitatDebug,
} from '@synapse/core';
// P22-T168 Punkte 8/9: User-Entscheidung anpinnen (derselbe Server-Weg wie thought(add) mit task_id, source user).
import { pinneUserEntscheidung, listeUserEntscheidungen, type UserEntscheidungZiel } from '@synapse/core';
// P22-T170: Zitat aus einem Lesefenster ohne Chat-/Channel-Herkunft an die per Checkbox gewaehlten Agenten.
import { listeZitatEmpfaenger, sendeZitatAnEmpfaenger } from '@synapse/core';
import { leseVerweis } from '../services/verweise.js';
import { abonniereArtefaktLive, artefaktLiveStatus } from '../services/artefakt-live.js';
import { letzterMainWegFehler } from '../services/agent-runtime/dauerhafter-main.js';
import { gleicheCliListeMitRegistry } from '../services/agent-runtime/registry-abgleich.js';
import type { CliModellListe } from '../services/agent-runtime/cli-modelle.js';

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

/**
 * P22-T112: Chat mit Plattform-Agenten (Koordinatoren, Spezialisten im Container) aus der Seitenleiste der Web-UI.
 * PG-Produkt-Schalter plattform_agent_chat im Projekt der Zielidentitaet, Standard AUS (POST 409 funktion_aus).
 * Zustellung: specialist_inbox (Absender 'user'), der Wrapper des Agenten pollt die Inbox und weckt das CLI. Die Antwort
 * erscheint im Verlauf der Identitaet (GET /api/agent-runtimes/agent-verlauf, P22-T81). Der Main hat seinen eigenen Chat.
 * DEBUG: GET /api/agent-runtimes/agent-chat/status (Schalter, Quelle, Wert).
 */
export async function plattformAgentChatSchalter(project: string) {
  const stand = await leseProfilProduktSchalter('plattform_agent_chat', project);
  const aktiv = stand.aktiv && !stand.letzter_fehler;
  return { ...stand, aktiv, name: 'plattform_agent_chat', wert: aktiv ? 'ein' : 'aus', standard: false as const };
}

type EingangsFehler = { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };
type ZitatAntwort = (ZitatDebug & { block_zeichen: number }) | null;

/**
 * P22-T168: Inhalt EINER Nachricht an EINEN Plattform-Agenten (ein Inbox-Eintrag, kein Rundversand): Text + Zitat-Block. Schalter
 * chat_zitate im Projekt der Zielidentitaet; ohne zitate unveraendert. Text leer ist erlaubt, wenn Zitate dabei sind (F3).
 */
export async function plattformChatInhalt(text: string, zitateRoh: unknown, project: string): Promise<{ ok: true; inhalt: string; zitate: ZitatAntwort } | EingangsFehler> {
  const z = await pruefeChatZitateAnfrage(zitateRoh, project);
  if (!z.ok) return z;
  if (!text && !z.zitate.length) return { ok: false, status: 400, code: 'text_fehlt', message: 'Nachricht ist leer' };
  const inhalt = textMitZitaten(text, z.zitate);
  return { ok: true, inhalt, zitate: z.debug ? { ...z.debug, block_zeichen: inhalt.length - text.length } : null };
}

/**
 * P22-T168: Eingang einer Main-Nachricht. Modelltext = Nachricht + Zitat-Block (Schalter chat_zitate global); der Verlauf speichert den
 * reinen Text und die Zitate als anhaenge (art 'zitat', die Warteschlange baut den Block daraus). message leer ist erlaubt, wenn Zitate
 * dabei sind (F3); ohne zitate wie bisher.
 */
export async function mainNachrichtEingang(body: { message?: unknown; anhaenge?: unknown; zitate?: unknown } | undefined | null): Promise<
  { ok: true; nachricht: string; modellText: string; anhaenge: unknown; zitate: ZitatAntwort } | EingangsFehler> {
  const nachricht = typeof body?.message === 'string' ? body.message : '';
  const z = await pruefeChatZitateAnfrage(body?.zitate, null);
  if (!z.ok) return z;
  if (!nachricht.trim() && !z.zitate.length) return { ok: false, status: 400, code: 'message_fehlt', message: 'message ist erforderlich' };
  const modellText = textMitZitaten(nachricht, z.zitate);
  const anhaenge = z.zitate.length ? [...(Array.isArray(body?.anhaenge) ? body.anhaenge : []), ...z.zitate.map(zitatAlsVerlaufAnhang)] : body?.anhaenge;
  return { ok: true, nachricht, modellText, anhaenge, zitate: z.debug ? { ...z.debug, block_zeichen: modellText.length - nachricht.length } : null };
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

/** P22-T116/T117: Akteur 'user' NUR fuer eine gepruefte interaktive User-Session (gleiche Regel wie der Guard), sonst null (recht_fehlt). */
async function userAkteur(request: FastifyRequest): Promise<{ art: 'user' } | null> {
  if (process.env.SYNAPSE_AUTH_DISABLED === '1') return { art: 'user' };
  const token = requestToken(request);
  const principal = token ? await validateToken(token) : null;
  return principal && runtimeTokenAllowed(principal.kind) ? { art: 'user' } : null;
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
  // P22-T81: Verlauf JEDER Identitaet (Koordinatoren, Spezialisten am PC und im Container) aus PG, dieselbe Lesestelle und Form wie
  // /api/main-agent/verlauf. Ziel: identity_id ODER project + agent (Name der Identitaet). Nur der interaktive User (Guard oben).
  fastify.get<{ Querystring: { identity_id?: string; project?: string; agent?: string; limit?: string; vor_id?: string; seit_rev?: string; ab_id?: string } }>(
    '/api/agent-runtimes/agent-verlauf', async (request, reply) => {
      try {
        const q = request.query ?? {};
        let identityId = typeof q.identity_id === 'string' ? q.identity_id.trim() : '';
        if (!identityId && typeof q.project === 'string' && typeof q.agent === 'string') {
          const r = await getPool().query<{ id: string }>('SELECT id FROM agent_identitaeten WHERE project = $1 AND agent_id = $2', [q.project, q.agent]);
          identityId = r.rows[0]?.id ?? '';
          if (!identityId) return reply.code(404).send({ success: false, error: { code: 'identitaet_unbekannt', message: 'Agent ohne Ausweis-Identitaet: kein Verlauf in PG' } });
        }
        if (!/^[a-f0-9-]{36}$/.test(identityId)) return reply.code(400).send({ success: false, error: { code: 'identity_id_fehlt', message: 'identity_id oder project + agent angeben' } });
        const schalter = await leseProfilProduktSchalter(AGENT_VERLAUF_ALLE_FUNKTION, null);
        const verlauf = await leseVerlaufFuer(identityId, { limit: q.limit, vor_id: q.vor_id, seit_rev: q.seit_rev, ab_id: q.ab_id });
        return { success: true, ...verlauf, agent_verlauf_alle: { aktiv: schalter.aktiv, quelle: schalter.quelle } };
      } catch (error) { return sendFachFehler(reply, error); }
    });
  // P22-T123: Tool-Karten live. PG-NOTIFY synapse_tool_activity (Trigger auf tool_calls, Schema 135) -> SSE 'tool' mit der Karte,
  // nur belegte eigene Aufrufe der Identitaet (identity_id oder akteur_identity_id; ohne Angabe: der Main), nie nach Namen.
  // Rechte wie die Chatansicht (Guard oben: nur der interaktive User). Schalter verlauf_tool_karten AUS -> Ereignis 'aus',
  // Ende; auch waehrend des Stroms (je Ereignis und alle sse_schalter_pruefung_ms). Takte aus den PG-Einstellungen.
  // DEBUG: Ereignis 'bereit' {identity_id, main, schalter}; jede Karte traegt nr (laufende Zaehlung dieses Stroms).
  fastify.get<{ Querystring: { identity_id?: string } }>('/api/agent-runtimes/tool-karten/stream', async (request, reply) => {
    const roh = typeof request.query?.identity_id === 'string' ? request.query.identity_id.trim() : '';
    const mainId = await hauptagentIdentitaetsId();
    const identityId = roh || mainId || '';
    if (!/^[a-f0-9-]{36}$/.test(identityId)) {
      return reply.code(400).send({ success: false, error: { code: 'identity_id_fehlt', message: 'identity_id angeben (ohne: keine Main-Identitaet)' } });
    }
    const schalter = await leseToolKartenSchalter();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.sent = true;
    if (!schalter.aktiv) { sse(reply, 'aus', { schalter }); reply.raw.end(); return; }
    const main = mainId === identityId;
    const einstellungen = (await leseToolKartenEinstellungen()).werte;
    let client: import('pg').PoolClient | null = null;
    let zu = false;
    let nr = 0;
    const takt = setInterval(() => { if (!zu) reply.raw.write(': takt\n\n'); }, einstellungen.sse_takt_ms);
    // R2 (Abnahme 2ecbc7e7): Schalter AUS waehrend des Stroms -> 'aus' und Ende, je Ereignis und im Pruef-Takt, fail-closed.
    const abschalten = () => {
      if (zu) return;
      sse(reply, 'aus', { grund: 'schalter_aus' });
      ende();
      reply.raw.end();
    };
    const pruefung = setInterval(() => {
      if (!zu) void leseToolKartenSchalter().then((s) => { if (s.aktiv !== true) abschalten(); }).catch(abschalten);
    }, einstellungen.sse_schalter_pruefung_ms);
    const melden = (msg: { channel: string; payload?: string }) => {
      if (zu || msg.channel !== 'synapse_tool_activity') return;
      let p: { id?: unknown; identity_id?: unknown; akteur_identity_id?: unknown } = {};
      try { p = JSON.parse(msg.payload || '{}'); } catch { return; }
      // R1: nur belegte Aufrufe der Identitaet (identity_id oder akteur_identity_id), kein Namensfallback.
      if (p.identity_id !== identityId && p.akteur_identity_id !== identityId) return;
      void toolKarteFuerStrom(identityId, p).then((r) => {
        if (zu) return;
        if (r.aus) { abschalten(); return; }
        if (r.karte) { nr += 1; sse(reply, 'tool', { karte: r.karte, nr }); }
      }).catch(() => undefined);
    };
    const ende = () => {
      if (zu) return;
      zu = true;
      clearInterval(takt);
      clearInterval(pruefung);
      const c = client;
      client = null;
      if (c) { c.removeListener('notification', melden); void c.query('UNLISTEN synapse_tool_activity').catch(() => undefined).finally(() => c.release()); }
    };
    reply.raw.on('close', ende);
    try {
      const c = await getPool().connect();
      if (zu) { c.release(); return; }
      client = c;
      c.on('notification', melden);
      await c.query('LISTEN synapse_tool_activity');
      sse(reply, 'bereit', { identity_id: identityId, main, schalter });
    } catch (error) {
      sse(reply, 'fehler', { message: errorMessage(error) });
      ende();
      reply.raw.end();
    }
  });
  // P22-T123 (R4): Einstellwerte der Tool-Karten (PG verlauf_tool_karten_einstellungen, Code-Standard, Quelle je Wert).
  // Lesen und Setzen nur der interaktive User (Guard oben); werte {name: zahl|null}, null = Code-Standard, grund Pflicht.
  fastify.get('/api/agent-runtimes/tool-karten/einstellungen', async (_request, reply) => {
    try { return { success: true, schalter: await leseToolKartenSchalter(), ...(await leseToolKartenEinstellungen()) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { werte?: unknown; grund?: unknown } }>('/api/agent-runtimes/tool-karten/einstellungen', async (request, reply) => {
    try { return { success: true, ...(await setzeToolKartenEinstellungen(request.body?.werte, request.body?.grund, 'user')) }; } catch (error) { return sendFachFehler(reply, error); }
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
  // P22-T73: Warteschlange des Main-Chats (Debug: was wartet warum, Schwelle mit Quelle, letzter Takt) und ihr Schalter.
  fastify.get('/api/main-agent/warteschlange', async (_request, reply) => {
    try { return { success: true, ...(await warteschlangeStatus(await hauptagentIdentitaetsId())) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get('/api/main-agent/warteschlange/schalter', async (_request, reply) => {
    try { return { success: true, schalter: await leseWarteschlangeSchalter() }; } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/warteschlange/schalter', async (request, reply) => {
    try {
      return { success: true, schalter: await setzeWarteschlangeSchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund }) };
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
  // P22-T116: Runtime-Agenten (Uebersicht, Log, Prozesse, Steuern, Prozess-Signal mit Bestaetigung). Unter /api/agent-runtimes, damit
  // guardInteractiveRuntimeRequest greift (nur interaktive User-Session; Service-/Daemon-/Wrapper-Tokens 403). Akteur = userAkteur (geprueft).
  fastify.get<{ Querystring: { project?: string } }>('/api/agent-runtimes/runtime-agenten', async (request, reply) => {
    try {
      const project = request.query.project?.trim() ?? '';
      const u = await leseRuntimeUebersicht(project);
      // P22-T122: neue Darstellung (Schalter runtime_agenten_panel_neu, Std AUS; Lesefehler -> AUS).
      const panel_neu = u ? await leseProfilProduktSchalter('runtime_agenten_panel_neu', project).then(s => s.aktiv && !s.letzter_fehler, () => false) : false;
      return u ? { success: true, aktiv: true, project, panel_neu, ...u } : { success: true, aktiv: false, project, schalter: 'runtime_agenten_uebersicht' };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get<{ Querystring: { identity_id?: string; max_bytes?: string } }>('/api/agent-runtimes/runtime-agenten/log', async (request, reply) => {
    try { return await leseRuntimeAgentLog({ identity_id: request.query.identity_id, max_bytes: request.query.max_bytes }, await userAkteur(request)); }
    catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get<{ Querystring: { project?: string } }>('/api/agent-runtimes/runtime-agenten/prozesse', async (request, reply) => {
    try { return await leseRuntimeProzesse({ project: request.query.project }, await userAkteur(request)); }
    catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Body: { identity_id?: unknown; aktion?: unknown; grund?: unknown; message?: unknown; bestaetigung?: { id?: unknown; grund?: unknown; project?: unknown; identity_id?: unknown } } }>('/api/agent-runtimes/runtime-agenten/steuern', async (request, reply) => {
    try {
      const b = request.body ?? {};
      // Bestaetigung an Projekt + Identitaet der Instanz gebunden, die die Vorschau zeigte (da3d601a).
      const best = b.bestaetigung && typeof b.bestaetigung === 'object'
        ? { id: b.bestaetigung.id, grund: b.bestaetigung.grund, project: b.bestaetigung.project, identity_id: b.bestaetigung.identity_id } : null;
      return await steuereRuntimeAgent({ identity_id: b.identity_id, aktion: b.aktion, grund: b.grund, message: b.message, bestaetigung: best }, await userAkteur(request));
    }
    catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Body: { project?: unknown; runtime?: unknown; pid?: unknown; signal?: unknown; grund?: unknown; bestaetigung?: { id?: unknown; grund?: unknown } } }>('/api/agent-runtimes/runtime-agenten/prozess', async (request, reply) => {
    try {
      const b = request.body ?? {};
      const akteur = await userAkteur(request);
      if (b.bestaetigung && typeof b.bestaetigung === 'object') return await bestaetigeProzessAenderung({ id: b.bestaetigung.id, grund: b.bestaetigung.grund, project: b.project }, akteur);
      return await frageProzessAenderungAn({ project: b.project, runtime: b.runtime, pid: b.pid, signal: b.signal, grund: b.grund }, akteur);
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T117 (R5): Modell/CLI-Anbieter eines Plattform-Agenten wechseln. Unter /api/agent-runtimes (Guard), Akteur geprueft; nur Abo-Runtimes (R3).
  fastify.post<{ Body: { identity_id?: unknown; runtime?: unknown; modell?: unknown; effort?: unknown; grund?: unknown } }>('/api/agent-runtimes/runtime-agenten/modellwechsel', async (request, reply) => {
    try {
      const b = request.body ?? {};
      return await wechslePlattformAgentModell({ identity_id: b.identity_id, runtime: b.runtime, modell: b.modell, effort: b.effort, grund: b.grund }, await userAkteur(request));
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T112: Chat mit Plattform-Agenten (Schalter siehe plattformAgentChatSchalter). Verlauf liest die Web-UI ueber agent-verlauf.
  fastify.get<{ Querystring: { identity_id?: string } }>('/api/agent-runtimes/agent-chat/status', async (request, reply) => {
    try {
      const id = request.query.identity_id?.trim() ?? '';
      if (!/^[a-f0-9-]{36}$/.test(id)) return reply.code(400).send({ success: false, error: { code: 'identity_id_fehlt', message: 'identity_id angeben' } });
      const ziel = (await getPool().query<{ project: string }>('SELECT project FROM agent_identitaeten WHERE id=$1', [id])).rows[0];
      if (!ziel) return reply.code(404).send({ success: false, error: { code: 'identitaet_unbekannt', message: 'Identitaet nicht gefunden' } });
      // P22-T124: einheitliches Chatfenster (Schalter agent_chat_einheitlich, Std AUS); Debug: Quelle und Fehler mitliefern.
      const e = await leseProfilProduktSchalter('agent_chat_einheitlich', ziel.project).catch(() => null);
      const einheitlich = { name: 'agent_chat_einheitlich', aktiv: !!e && e.aktiv && !e.letzter_fehler, quelle: e?.quelle ?? 'fehler', letzter_fehler: e ? e.letzter_fehler : 'nicht_lesbar' };
      return { success: true, schalter: await plattformAgentChatSchalter(ziel.project), einheitlich };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Body: { identity_id?: unknown; text?: unknown; zitate?: unknown } }>('/api/agent-runtimes/agent-chat', async (request, reply) => {
    try {
      let schalter: Awaited<ReturnType<typeof plattformAgentChatSchalter>> | undefined;
      const fehler = (status: number, code: string, message: string) => reply.code(status).send({ success: false, error: { code, message }, ...(schalter ? { schalter } : {}) });
      const identityId = typeof request.body?.identity_id === 'string' ? request.body.identity_id.trim() : '';
      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      if (!/^[a-f0-9-]{36}$/.test(identityId)) return fehler(400, 'identity_id_fehlt', 'identity_id angeben');
      // P22-T168 (F3): nur Zitate ohne Text ist erlaubt.
      const mitZitaten = Array.isArray(request.body?.zitate) && request.body.zitate.length > 0;
      if (!text && !mitZitaten) return fehler(400, 'text_fehlt', 'Nachricht ist leer');
      if (text.length > 20_000) return fehler(400, 'text_zu_lang', 'Nachricht laenger als 20000 Zeichen');
      const r = await getPool().query<{ agent_id: string; project: string; rolle: string; status: string }>(
        'SELECT agent_id, project, rolle, status FROM agent_identitaeten WHERE id = $1', [identityId]);
      const ziel = r.rows[0];
      if (!ziel) return fehler(404, 'identitaet_unbekannt', 'Identitaet nicht gefunden');
      if (ziel.rolle === 'main') return fehler(400, 'hauptagent_eigener_chat', 'Der Hauptagent hat seinen eigenen Chat (/api/main-agent)');
      if (ziel.status !== 'aktiv') return fehler(409, 'identitaet_inaktiv', 'Identitaet ist nicht aktiv');
      schalter = await plattformAgentChatSchalter(ziel.project);
      if (!schalter.aktiv) return fehler(409, 'funktion_aus', 'Chat mit Plattform-Agenten ist aus (plattform_agent_chat)');
      // P22-T168: Zitat-Anhaenge gehen nur mit DIESER Nachricht an DIESE Identitaet (ein Inbox-Eintrag, kein Rundversand).
      const inhalt = await plattformChatInhalt(text, request.body?.zitate, ziel.project);
      if (!inhalt.ok) {
        return reply.code(inhalt.status).send({ success: false, error: { code: inhalt.code, message: inhalt.message, ...(inhalt.details ? { details: inhalt.details } : {}) }, schalter });
      }
      if (inhalt.inhalt.length > 20_000) return fehler(400, 'text_zu_lang', 'Nachricht mit Zitaten laenger als 20000 Zeichen');
      // P22-T134: an die Identitaet adressieren (to_identity_id), sonst findet die Zustellung je Identitaet (Mod-Inbox,
      // Startort P22-T113) die Nachricht nie; to_agent bleibt fuer die Namens-Leser gesetzt. Ein Identitaetsziel braucht den
      // Agent-Bezug-Kontext (wie daemon-sync/daemon-jobs); im Modus 'alt' bleibt es beim Namen.
      const bezug = await leseAgentBezugModus();
      const gesendet = bezug.modus === 'alt'
        ? await postToInbox('user', ziel.agent_id, inhalt.inhalt, ziel.project)
        : await mitAgentAufrufKontext({ principal: null, bezug }, () =>
          postToInbox('user', { art: 'identity', project: ziel.project, agent_id: ziel.agent_id, identity_id: identityId }, inhalt.inhalt, ziel.project));
      return { success: true, weg: 'inbox', inbox_id: gesendet.id, gesendet_am: gesendet.createdAt, agent_id: ziel.agent_id, project: ziel.project, identity_id: identityId,
        ...(inhalt.zitate ? { zitate: { ...inhalt.zitate, empfaenger: identityId } } : {}) };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T137 (Punkt 5): Inbox zwischen User und dieser Identitaet (beide Richtungen) fuer den Fensterverlauf. Antworten per
  // chat(inbox_send) an 'user' stehen nicht im CLI-Transkript; die Web-UI sortiert sie zeitlich ein. Schalter wie der Chat
  // (plattform_agent_chat im Projekt der Zielidentitaet; AUS -> aktiv false, leer). Nur lesend, processed bleibt unberuehrt.
  // Zuordnung: Identitaet (to_/from_identity_id), ohne Identitaet der Name im Projekt. DEBUG: debug {anzahl, limit, schalter_quelle, modus}.
  // P22-T146 (additiv, ohne Parameter wie bisher): ab_id = nur juengere als ab_id (aufsteigend, Abgleich des Fensters), vor_id = die
  // limit Nachrichten vor vor_id (aeltere nachladen); ab_id gewinnt. mehr = es gibt ueber limit hinaus weitere in dieser Richtung.
  fastify.get<{ Querystring: { identity_id?: string; limit?: string; ab_id?: string; vor_id?: string } }>('/api/agent-runtimes/agent-chat/inbox', async (request, reply) => {
    try {
      const id = request.query.identity_id?.trim() ?? '';
      if (!/^[a-f0-9-]{36}$/.test(id)) return reply.code(400).send({ success: false, error: { code: 'identity_id_fehlt', message: 'identity_id angeben' } });
      const ziel = (await getPool().query<{ agent_id: string; project: string }>('SELECT agent_id, project FROM agent_identitaeten WHERE id=$1', [id])).rows[0];
      if (!ziel) return reply.code(404).send({ success: false, error: { code: 'identitaet_unbekannt', message: 'Identitaet nicht gefunden' } });
      const schalter = await plattformAgentChatSchalter(ziel.project);
      if (!schalter.aktiv) return { success: true, aktiv: false, identity_id: id, nachrichten: [], mehr: false, schalter };
      const n = Number(request.query.limit);
      const limit = Number.isFinite(n) && n > 0 ? Math.min(100, Math.trunc(n)) : 40;
      const idWert = (v: string | undefined): string | null => (/^\d{1,18}$/.test(v?.trim() ?? '') ? String(v).trim() : null);
      const ab_id = idWert(request.query.ab_id);
      const vor_id = ab_id ? null : idWert(request.query.vor_id);
      const modus = ab_id ? 'ab' : vor_id ? 'vor' : 'letzte';
      const r = await getPool().query<{ id: number | string; from_agent: string; to_agent: string; content: string; created_at: Date }>(
        `SELECT id, from_agent, to_agent, content, created_at FROM specialist_inbox
          WHERE project = $1 AND (
            (from_agent = 'user' AND to_agent <> 'user' AND (to_identity_id = $2 OR (to_identity_id IS NULL AND to_agent = $3)))
            OR (to_agent = 'user' AND from_agent <> 'user' AND (from_identity_id = $2 OR (from_identity_id IS NULL AND from_agent = $3))))
            AND ($5::bigint IS NULL OR id > $5::bigint) AND ($6::bigint IS NULL OR id < $6::bigint)
          ORDER BY id ${ab_id ? 'ASC' : 'DESC'} LIMIT $4`, [ziel.project, id, ziel.agent_id, limit + 1, ab_id, vor_id]);
      const mehr = r.rows.length > limit;
      const zeilen = r.rows.slice(0, limit);
      const nachrichten = (ab_id ? zeilen : zeilen.reverse()).map((z) => ({ id: Number(z.id), richtung: z.from_agent === 'user' ? 'ein' as const : 'aus' as const,
        von: z.from_agent, an: z.to_agent, text: z.content, erstellt_am: new Date(z.created_at).toISOString() }));
      return { success: true, aktiv: true, identity_id: id, agent_id: ziel.agent_id, project: ziel.project, nachrichten, mehr,
        debug: { anzahl: nachrichten.length, limit, schalter_quelle: schalter.quelle, modus } };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T141: Artefakt-Bewertung (Design-Gedaechtnis, core artefakt-bewertung.ts). Unter /api/agent-runtimes, also nur die interaktive
  // User-Session (Guard oben): bewertet_von ist immer 'user'. Schalter artefakt_bewertung (global, Std AUS): POST 409 funktion_aus,
  // GET aktiv false und leer. Schnappschuss liest der Server aus der Quelle. DEBUG: vorlieben.debug, schalter_quelle.
  const bewertungsFehler = (reply: FastifyReply, error: unknown) => error instanceof BewertungsFehler
    ? reply.code(error.status).send({ success: false, error: { code: error.code, message: error.message } })
    : sendFachFehler(reply, error);
  fastify.post<{ Body: { quelle_art?: unknown; quelle_ref?: unknown; identity_id?: unknown; urteil?: unknown; kommentar?: unknown } }>(
    '/api/agent-runtimes/artefakt-bewertung', async (request, reply) => {
      try {
        const b = request.body ?? {};
        return { success: true, ...(await bewerteArtefakt({ quelle_art: b.quelle_art, quelle_ref: b.quelle_ref, identity_id: b.identity_id, urteil: b.urteil, kommentar: b.kommentar })) };
      } catch (error) { return bewertungsFehler(reply, error); }
    });
  fastify.get<{ Querystring: { quellen?: string } }>('/api/agent-runtimes/artefakt-bewertung', async (request, reply) => {
    try { return { success: true, ...(await leseBewertungen(zerlegeQuellenListe(request.query.quellen))) }; }
    catch (error) { return bewertungsFehler(reply, error); }
  });
  fastify.get<{ Querystring: { limit?: string } }>('/api/agent-runtimes/artefakt-bewertung/vorlieben', async (request, reply) => {
    try { return { success: true, ...(await leseDesignVorlieben({ limit: request.query.limit })) }; }
    catch (error) { return bewertungsFehler(reply, error); }
  });
  // P22-T161: Top-Artefakte je Projekt des Arbeitsraums aus den Bewertungen (core leseTopArtefakte), nur lesend, ohne HTML. alle=1 zeigt auch
  // ueberarbeiten/versuch_gezeigt/verbannt (verbannt ganz unten). Schalter artefakt_bewertung AUS -> aktiv false, leer. Statische Pfade
  // (top, top/stream, top/:id/schnappschuss) gehen in Fastify vor /api/main-agent/artefakte/:id. DEBUG: debug, live (Strom-Status).
  fastify.get<{ Querystring: { project?: string; alle?: string; limit?: string } }>('/api/main-agent/artefakte/top', async (request, reply) => {
    try {
      return { success: true, ...(await leseTopArtefakte({ project: request.query.project, alle: request.query.alle, limit: request.query.limit })), live: bewertungLiveStatus() };
    } catch (error) { return bewertungsFehler(reply, error); }
  });
  fastify.get<{ Params: { id: string } }>('/api/main-agent/artefakte/top/:id/schnappschuss', async (request, reply) => {
    try { return { success: true, schnappschuss: await leseBewertungsSchnappschuss(request.params.id) }; }
    catch (error) { return bewertungsFehler(reply, error); }
  });
  // P22-T161: Live-Strom der Top-Liste: 'bereit', danach 'geaendert' {anzahl, ereignisse} je Buendel (NOTIFY synapse_artefakt_bewertung).
  // Schalter artefakt_bewertung AUS -> 'aus', Ende.
  fastify.get('/api/main-agent/artefakte/top/stream', async (request, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.sent = true;
    try {
      const s = await artefaktBewertungSchalter();
      if (!s.aktiv) { sse(reply, 'aus', { grund: 'schalter', schalter: s }); reply.raw.end(); return; }
      const abmelden = await abonniereBewertungsLive((event, data) => sse(reply, event, data));
      sse(reply, 'bereit', { status: bewertungLiveStatus() });
      const takt = setInterval(() => { reply.raw.write(': takt\n\n'); }, 15000);
      request.raw.once('close', () => { clearInterval(takt); abmelden(); });
    } catch (error) {
      sse(reply, 'fehler', { message: errorMessage(error) });
      reply.raw.end();
    }
  });
  // P8-T25: HTML-Artefakte des Hauptagenten (agent_artifacts) fuer "Persoenliche Artefakte" – nur lesend.
  fastify.get<{ Querystring: { limit?: string } }>('/api/main-agent/artefakte', async (request, reply) => {
    try {
      const artefakte = await listeArtefakte(request.query.limit ? Number(request.query.limit) : 100);
      return { success: true, count: artefakte.length, artefakte };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T154: mit Vorlage rendert der Server fuer ?project= (Standard: standard_project) mit den Rechten des Users (alle Projekte);
  // stand = Momentaufnahme, live = neu, wenn aelter als die Drossel. render/projekte nur bei Vorlagen-Artefakten.
  const vorlagenFehler = (reply: FastifyReply, error: unknown) => error instanceof ArtefaktVorlagenFehler
    ? reply.code(error.status).send({ success: false, error: { code: error.code, message: error.message } })
    : sendFachFehler(reply, error);
  const renderAntwort = (r: ArtefaktRenderErgebnis) => ({ modus: r.modus, project: r.project, revision: r.revision, gerendert_am: r.gerendert_am, neu: r.neu,
    fehler: r.fehler, ...(r.hinweis ? { hinweis: r.hinweis } : {}), ...(r.debug ? { debug: r.debug } : {}) });
  fastify.get<{ Params: { id: string }; Querystring: { project?: string } }>('/api/main-agent/artefakte/:id', async (request, reply) => {
    try {
      const artefakt = await ladeArtefakt(request.params.id);
      if (!artefakt) return reply.code(404).send({ success: false, error: { message: 'Artefakt nicht gefunden' } });
      if (!artefakt.hatVorlage) return { success: true, artefakt };
      const r = await renderArtefakt(artefakt.id, { project: request.query.project ?? null, betrachter: { art: 'user' }, anlass: 'anzeigen', von: 'user' });
      return { success: true, artefakt: { ...artefakt, html: r.html }, render: renderAntwort(r), projekte: await renderungsProjekte(artefakt.id) };
    } catch (error) { return vorlagenFehler(reply, error); }
  });
  fastify.post<{ Params: { id: string }; Body: { project?: unknown } }>('/api/main-agent/artefakte/:id/neu-zeichnen', async (request, reply) => {
    try {
      const project = typeof request.body?.project === 'string' ? request.body.project : null;
      const r = await renderArtefakt(request.params.id, { project, betrachter: { art: 'user' }, anlass: 'neu_zeichnen', von: 'user' });
      return { success: true, artefakt_id: r.artefakt_id, html: r.html, render: renderAntwort(r), projekte: await renderungsProjekte(r.artefakt_id) };
    } catch (error) { return vorlagenFehler(reply, error); }
  });
  // P22-T154 Etappe 5: Live-Strom eines Artefakts fuer ein Projekt. Schalter artefakt_vorlagen_live AUS oder kein live-Artefakt ->
  // Ereignis 'aus', Ende. Sonst 'bereit' {kanaele, status}, danach 'artefakt' {html, revision, ...} bei neuer Renderung.
  fastify.get<{ Params: { id: string }; Querystring: { project?: string } }>('/api/main-agent/artefakte/:id/stream', async (request, reply) => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.sent = true;
    try {
      const live = await artefaktVorlagenSchalter(ARTEFAKT_VORLAGEN_LIVE_FUNKTION);
      if (!live.aktiv) { sse(reply, 'aus', { grund: 'schalter', schalter: live }); reply.raw.end(); return; }
      const z = await ladeVorlagenZeile(request.params.id);
      const project = (typeof request.query.project === 'string' && request.query.project.trim()) || z?.standard_project || '';
      if (!z || !z.vorlage || z.modus !== 'live' || !project) { sse(reply, 'aus', { grund: !z ? 'unbekannt' : !project ? 'projekt_fehlt' : 'kein_live_artefakt' }); reply.raw.end(); return; }
      const abo = await abonniereArtefaktLive(z.id, project, { art: 'user' }, (event, data) => sse(reply, event, data));
      sse(reply, 'bereit', { artefakt_id: z.id, project, kanaele: abo.kanaele, status: artefaktLiveStatus() });
      const takt = setInterval(() => { reply.raw.write(': takt\n\n'); }, 15000);
      request.raw.once('close', () => { clearInterval(takt); abo.abmelden(); });
    } catch (error) {
      sse(reply, 'fehler', { message: errorMessage(error) });
      reply.raw.end();
    }
  });
  // P22-T154: interne Einstellungen der Vorlagen (Drossel, Buendelung, Kappungen) und Debug (Schalter, Katalog, Live-Status).
  fastify.get('/api/main-agent/artefakt-vorlagen', async () => {
    const [s, live, ausweis, verweise] = await Promise.all([artefaktVorlagenSchalter(), artefaktVorlagenSchalter(ARTEFAKT_VORLAGEN_LIVE_FUNKTION),
      artefaktVorlagenSchalter('artefakt_ausweis_zeigen'), artefaktVorlagenSchalter(ARTEFAKT_VERWEISE_FUNKTION)]);
    return { success: true, schalter: { artefakt_vorlagen: s, artefakt_vorlagen_live: live, artefakt_ausweis_zeigen: ausweis, artefakt_verweise: verweise,
      artefakt_skripte: await artefaktSkripteSchalter() },
      einstellungen: await leseArtefaktVorlagenEinstellungen(), katalog: artefaktQuellenKatalog(), live: artefaktLiveStatus(), skript_bruecke: skriptBrueckeStatus() };
  });
  // P22-T165: Schalter artefakt_verweise fuer die Web-UI (Klick auf Verweise im Artefakt, Zustand ueber Live-Updates). Wirft nie.
  fastify.get('/api/main-agent/artefakt-verweise', async () => {
    const s = await artefaktVorlagenSchalter(ARTEFAKT_VERWEISE_FUNKTION);
    return { success: true, aktiv: s.aktiv, schalter: s };
  });
  // P22-T168: Zitat-Anhaenge fuer die Web-UI: Schalter chat_zitate (project = Projekt des Empfaengers, ohne = global/Main) und Grenzen
  // mit Quelle. Wirft nie. Setzen der Grenzen nur der User (Guard oben): werte {name: zahl|null}, null = Code-Standard, grund Pflicht.
  fastify.get<{ Querystring: { project?: string } }>('/api/main-agent/chat-zitate', async (request) => {
    const p = typeof request.query?.project === 'string' && request.query.project.trim() ? request.query.project.trim() : null;
    const [schalter, einstellungen] = await Promise.all([leseChatZitateSchalter(p), leseChatZitateEinstellungen()]);
    return { success: true, aktiv: schalter.aktiv, schalter, grenzen: einstellungen.werte, einstellungen };
  });
  fastify.put<{ Body: { werte?: unknown; grund?: unknown } }>('/api/main-agent/chat-zitate/einstellungen', async (request, reply) => {
    try { return { success: true, ...(await setzeChatZitateEinstellungen(request.body?.werte, request.body?.grund, 'user')) }; } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T168 Punkte 8/9: User-Entscheidung an eine Task bzw. einen Plan anpinnen (nur der User, Guard oben). Speichert SOFORT einen
  // thought (source user, Tag user-entscheidung + Kurz-ID, task_id bei Tasks) und gibt dem Bearbeiter der Task einen kurzen
  // Inbox-Hinweis (identitaetsadressiert wie agent-chat). Schalter chat_zitate im Projekt des Verweises; Debug: schalter, hinweis.
  // P22-T171 Punkt 4: art = jede Verweis-Art des Lesefensters (Tag '<art>:<id>' ausser Task/Plan), titel optional.
  fastify.post<{ Body: { project?: unknown; art?: unknown; id?: unknown; text?: unknown; titel?: unknown } }>('/api/agent-runtimes/user-entscheidung', async (request, reply) => {
    try {
      const bezug = await leseAgentBezugModus();
      const sende = (ziel: UserEntscheidungZiel, text: string) => (bezug.modus === 'alt' || ziel.art === 'legacy'
        ? postToInbox('user', ziel.agent_id, text, ziel.project)
        : mitAgentAufrufKontext({ principal: null, bezug }, () => postToInbox('user', ziel, text, ziel.project)));
      const r = await pinneUserEntscheidung(request.body ?? {}, sende);
      if (!r.ok) return reply.code(r.status).send({ success: false, error: { code: r.code, message: r.message }, ...(r.schalter ? { schalter: r.schalter } : {}) });
      const { ok: _ok, ...rest } = r;
      return { success: true, ...rest };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.get<{ Querystring: { project?: string; art?: string; id?: string } }>('/api/agent-runtimes/user-entscheidungen', async (request, reply) => {
    try {
      const r = await listeUserEntscheidungen(request.query?.project, request.query?.art, request.query?.id);
      if (!r.ok) return reply.code(r.status).send({ success: false, error: { code: r.code, message: r.message }, ...(r.schalter ? { schalter: r.schalter } : {}) });
      const { ok: _ok, ...rest } = r;
      return { success: true, ...rest };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T170: Lesefenster OHNE Chat-/Channel-Herkunft (Artefakte, Top-Artefakte, sonst wo): 'Zitat anfügen' zeigt die Agenten des
  // Projekts (inkl. Koordinator und Main) als Checkbox-Auswahl; 'Senden' legt je gewaehltem Agenten EINE Inbox-Zeile an (gleicher
  // Block [Synapse-Zitate], identitaetsadressiert wie agent-chat). Nur der User (Guard oben). Schalter chat_zitate; Debug: empfaenger.
  fastify.get<{ Querystring: { project?: string } }>('/api/agent-runtimes/zitat-empfaenger', async (request, reply) => {
    try {
      const r = await listeZitatEmpfaenger(request.query?.project);
      if (!r.ok) return reply.code(r.status).send({ success: false, error: { code: r.code, message: r.message } });
      const { ok: _ok, ...rest } = r;
      return { success: true, ...rest };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  fastify.post<{ Body: { project?: unknown; empfaenger?: unknown; text?: unknown; zitate?: unknown } }>('/api/agent-runtimes/zitat-inbox', async (request, reply) => {
    try {
      const bezug = await leseAgentBezugModus();
      const sende = (ziel: UserEntscheidungZiel, text: string) => (bezug.modus === 'alt' || ziel.art === 'legacy'
        ? postToInbox('user', ziel.agent_id, text, ziel.project)
        : mitAgentAufrufKontext({ principal: null, bezug }, () => postToInbox('user', ziel, text, ziel.project)));
      const r = await sendeZitatAnEmpfaenger(request.body ?? {}, sende);
      if (!r.ok) {
        return reply.code(r.status).send({ success: false, error: { code: r.code, message: r.message, ...(r.details ? { details: r.details } : {}) }, ...(r.schalter ? { schalter: r.schalter } : {}) });
      }
      const { ok: _ok, ...rest } = r;
      return { success: true, ...rest };
    } catch (error) { return sendFachFehler(reply, error); }
  });
  // P22-T166: Schalter artefakt_skripte fuer die Web-UI (Hinweis im Chatfenster) plus Debug der Bruecke. Wirft nie.
  fastify.get('/api/main-agent/artefakt-skripte', async () => {
    const s = await artefaktSkripteSchalter();
    return { success: true, aktiv: s.aktiv, schalter: s, bruecke: skriptBrueckeStatus() };
  });
  // P22-T166: nur lesende Daten-Bruecke fuer das Skript eines Top-Artefakts. Der Rahmen der Web-UI (kios/SkriptRahmen.tsx) reicht jede
  // Anfrage des sandboxed iframe hierher; project setzt der Rahmen (Render-Projekt). Betrachter = User (Guard oben), dazu die
  // Urheber-Klammer im core. op quelle = Katalogvertrag, op lese = Lesefenster (task/plan/thought/memory). Kein Schreiben.
  fastify.post<{ Params: { id: string }; Body: unknown }>('/api/main-agent/artefakte/:id/bruecke', async (request, reply) => {
    try {
      const e = await artefaktSkriptBruecke(request.params.id, request.body, {
        betrachter: { art: 'user' },
        lese: (project, art, ref) => leseVerweis(project, art, ref),
      });
      return { success: true, ...e };
    } catch (error) {
      if (error instanceof ArtefaktSkriptFehler) return reply.code(error.status).send({ success: false, error: { code: error.code, message: error.message } });
      return sendFachFehler(reply, error);
    }
  });
  fastify.put<{ Body: { werte?: unknown; grund?: unknown } }>('/api/main-agent/artefakt-vorlagen/einstellungen', async (request, reply) => {
    try { return { success: true, ...(await setzeArtefaktVorlagenEinstellungen(request.body?.werte, request.body?.grund, 'user')) }; }
    catch (error) { return vorlagenFehler(reply, error); }
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
  // P22-T75: Kontextfenster aus der CLI-Liste fuer Modelle, die die Registry nicht kennt (codex/<slug>, neue claude-ID); core fragt
  // beim Kontextstand des Main hier nach (quelle 'cli' im Chip). Liste je Runtime 5 Min gemerkt (30 s, wenn sie leer war).
  const cliFensterCache = new Map<'claude' | 'codex', { bis: number; liste: CliModellListe | null }>();
  setzeCliKontextQuelle(async (modell) => {
    const codex = /^codex\/(.+)$/.exec(modell);
    const rt: 'claude' | 'codex' | null = codex ? 'codex' : /^claude-/.test(modell) ? 'claude' : null;
    if (!rt) return null;
    const id = codex ? codex[1] : modell.replace(/\[1m\]$/, '');
    let c = cliFensterCache.get(rt);
    if (!c || c.bis < Date.now()) {
      const d = manager.driver(rt);
      const liste = d.modelle ? await d.modelle().catch(() => null) : null;
      c = { bis: Date.now() + (liste?.modelle.length ? 300_000 : 30_000), liste };
      cliFensterCache.set(rt, c);
    }
    return c.liste?.modelle.find((m) => m.id === id)?.kontext_ein ?? null;
  });
  fastify.get<{ Params: { runtime: string }; Querystring: { neu?: string } }>('/api/agent-runtimes/:runtime/modelle', async (request, reply) => {
    try {
      const driver = manager.driver(containerRuntime(request.params.runtime));
      if (!driver.modelle) throw Object.assign(new Error('runtime_ungueltig'), { code: 'runtime_ungueltig' });
      const neu = request.query?.neu === '1' || request.query?.neu === 'true';
      const liste = await driver.modelle({ neu });
      // P22-T75: Abgleich CLI-Liste <-> model_registry als Befund (nie stille Anlage).
      return { success: true, modelle: { ...liste, registry_abgleich: gleicheCliListeMitRegistry(liste, await listModels().catch(() => null)) } };
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
      const registryZeilen = await listModels().catch(() => null);
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
          // P22-T75: Abgleich CLI-Liste <-> model_registry (Befund, keine Anlage).
          registry_abgleich: liste ? gleicheCliListeMitRegistry(liste, registryZeilen) : null,
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
    Body: { message?: string; anhaenge?: unknown; zitate?: unknown };
  }>('/api/main-agent/sessions/:sessionId/messages', async (request, reply) => {
    // P22-T168: Zitat-Anhaenge gehen nur an den Main dieser Sitzung; ohne zitate wie bisher (message Pflicht).
    const eingang = await mainNachrichtEingang(request.body);
    if (!eingang.ok) {
      return reply.status(eingang.status).send({ success: false, error: { code: eingang.code, message: eingang.message, ...(eingang.details ? { details: eingang.details } : {}) } });
    }
    let session;
    let modell: string | null = null;
    // P22-T71: die Main-Identitaet spricht immer mit der ZUGEWIESENEN Runtime (Wechsel mitten im Gespraech), nicht mit der der
    // Sitzung. P22-T73: mit Warteschlange wird eine Nachricht bei nicht bereiter Runtime oder offenem Wechsel eingereiht statt
    // abgelehnt; die Antwort kommt spaeter in dieselbe Antwortzeile (Live-Abgleich des Verlaufs).
    let runtime: RuntimeName;
    let warteschlange = false;
    let nichtBereit: string | null = null;
    try {
      session = await manager.getMainSession(request.params.sessionId);
      runtime = session.runtime;
      const istMain = !!session.identityId && (await hauptagentIdentitaetsId().catch(() => null)) === session.identityId;
      if (istMain) {
        const zugewiesen = await manager.zugewieseneMainRuntime();
        if (zugewiesen === 'claude' || zugewiesen === 'codex') runtime = zugewiesen;
        warteschlange = await warteschlangeAktiv();
      }
      manager.driver(runtime);
      try {
        modell = (await manager.assertMainRuntimeReady(runtime)).model;
      } catch (error) {
        if (!warteschlange) throw error;
        nichtBereit = 'runtime_nicht_bereit';
      }
      if (warteschlange && !nichtBereit && session.identityId && await mainWechselOffen(session.identityId)) nichtBereit = 'wechsel_offen';
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
    sse(reply, 'ready', { sessionId: session.id, runtime });

    // P22-T63: Verlauf je Main-Identitaet. User-Nachricht + laufende Antwort sofort in PG (andere Geraete sehen sie), danach
    // jedes Stromereignis gedrosselt. Nur Sitzungen der Main-Identitaet bei Schalter hauptagent_verlauf EIN; Fehler hier
    // lassen den Turn nie scheitern. 'verlauf' sagt der Web-UI, unter welchen Server-IDs die beiden Zeilen stehen.
    const turn = await legeVerlaufTurnAn({
      identity_id: session.identityId, text: eingang.nachricht, session_id: session.id, runtime, modell,
      lauf_id: 'altweg:' + session.id, geraet: geraetAusUserAgent(request.headers['user-agent']), anhaenge: eingang.anhaenge,
    });
    const verlauf = turn.gespeichert ? starteVerlaufAntwort(turn.antwort_id, {
      // Lauf: Altweg je CLI-Sitzung; auf dem dauerhaften Weg setzt core den Lauf des Main (aktuellerMainLauf).
      modell, identity_id: turn.identity_id, user_id: turn.user_id, user_text: eingang.modellText, runtime, lauf_id: 'altweg:' + session.id,
    }) : null;
    sse(reply, 'verlauf', { ...(turn.gespeichert ? { user_id: turn.user_id, antwort_id: turn.antwort_id } : { aus: turn.grund }), ...(eingang.zitate ? { zitate: eingang.zitate } : {}) });

    // P22-T73: Antwortzeile an die Warteschlange geben und den Strom ohne Fehler beenden ('done' mit wartet). false = ging nicht
    // (Schalter aus, kein Verlauf), dann bleibt es beim bisherigen Weg.
    const aktuelleSitzung = session;
    const einreihen = async (grund: string, meldung: string | null, art: 'warten' | 'einwurf' = 'warten', inboxId: number | null = null): Promise<boolean> => {
      if (!warteschlange || !verlauf) return false;
      await verlauf.uebergeben();
      if (!(await stelleInWarteschlange(verlauf.antwort_id, { art, grund, meldung, inbox_id: inboxId }))) return false;
      await manager.completeSession(aktuelleSitzung.id, aktuelleSitzung.runtimeSessionId, aktuelleSitzung.context ?? null).catch(() => undefined);
      sse(reply, 'runtime', { hauptagent: { weg: 'dauerhaft', schritt: art === 'einwurf' ? 'einwurf' : 'wartet', grund, ...(meldung ? { meldung } : {}) } });
      sse(reply, 'done', {
        sessionId: aktuelleSitzung.id, runtimeSessionId: aktuelleSitzung.runtimeSessionId, context: aktuelleSitzung.context ?? null,
        wartet: { art, grund, antwort_id: verlauf.antwort_id }, artifacts: countArtifacts(aktuelleSitzung.id),
      });
      reply.raw.end();
      return true;
    };
    if (nichtBereit && await einreihen(nichtBereit, null)) return;

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
      const result = await manager.driver(runtime).sendMessage(
        session,
        eingang.modellText,
        (item: RuntimeStreamEvent) => {
          if (item.event === 'usage') letzteUsage = item.data;
          verlauf?.ereignis(item.event, item.data);
          sse(reply, item.event, item.data);
        },
        controller.signal,
      );
      // P22-T73: Main beschaeftigt -> Einwurf; die Antwort schreibt die Zustellung dieser Inbox-Nachricht in dieselbe Zeile.
      const einwurf = (result.context as { einwurf?: { inbox_id?: number | null } } | null)?.einwurf;
      if (einwurf && await einreihen('beschaeftigt', null, 'einwurf', einwurf.inbox_id ?? null)) return;
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
      // P22-T73: hat die Nachricht den Main nicht erreicht (Start, Wechsel, Ausfall), wartet sie statt als Fehler zu enden.
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string' && NICHT_ERREICHT_CODES.includes(code)
        && await einreihen(code, typeof (error as { meldung?: unknown }).meldung === 'string' ? (error as { meldung: string }).meldung : null)) return;
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
