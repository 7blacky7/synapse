/**
 * P22-T8 (W2-API): Provider-Transport fuer den kostenpflichtigen API-Agenten und die User-Verwaltung dazu.
 *
 * TRANSPORT (Agent mit eigenem Ausweis, Header x-synapse-agent-token zusaetzlich zum Bearer):
 *   POST /api/agent-api/messages  {project, modell, system?, messages, tools?, max_tokens}
 *     Schalter (hauptagent + Funktion api) -> Budget reservieren (core api-agent-dienst.ts, atomar) -> Anthropic Messages API
 *     mit dem serverseitigen Key (Env SYNAPSE_ANTHROPIC_API_KEY, offizielles SDK @anthropic-ai/sdk) -> echte Kosten buchen
 *     (Reservierung + agent_verbrauch in einer Transaktion) -> Antwort {message, kosten, rest_usd}. Kein Ersatzmodell, kein
 *     Ersatzanbieter. Der Key erscheint nie in Antwort, Log oder Fehlermeldung.
 *   GET  /api/agent-api/rahmen?project=  Schalter, Restbudget, erlaubte Modelle, Grenzen (Einstellwerte) fuer den Worker.
 *   Berechtigt ist in W2 nur die Hauptagenten-Identitaet (Rolle main im reservierten Bereich); andere -> nur_hauptagent.
 *   P22-T179: zusaetzlich Arbeitsagent (subagent) und Koordinator, wenn Schalter api_agenten im Projekt EIN ist (AUS = Bestand
 *   nur_hauptagent). Ob er wirklich zahlen darf, entscheidet core reserviereApiAufruf (zugang 'agent': Funktion api, Freigabe je
 *   Identitaet, Modell der Freigabe, eigene Grenze, globales Budget). Bearer hauptagent:identitaet:<id> bzw. agent:identitaet:<id>
 *   muss zur Identitaet des Ausweises passen.
 *   GET/PUT/DELETE /api/main-agent/api/freigaben  (User) Freigaben je Agent: Stand mit Verbrauch, setzen {identity_id, aktiv?, modelle,
 *   grenze_usd?, heartbeat?, grund}, entfernen {identity_id, grund}.
 *
 * USER (nur interaktive User-Sitzung; registriert innerhalb agentRuntimeRoutes, damit dessen Guard fuer /api/main-agent greift):
 *   GET    /api/main-agent/api                 Status (Schalter, Budget, Einstellwerte, Modelle, Key vorhanden ja/nein)
 *   PUT    /api/main-agent/api/schalter        {aktiv, grund}
 *   PUT    /api/main-agent/api/budget          {grenze_usd, zeitraum?, reset_tag?, erlaubte_modelle[], grund}
 *   DELETE /api/main-agent/api/budget          {grund}
 *   PUT    /api/main-agent/api/einstellungen   {werte?: {name: zahl}, entfernen?: [name], grund}
 *   GET    /api/main-agent/api/kosten?seit=&bis=
 * P22-T176: Anthropic-Key aus der Web-UI (core api-schluessel-dienst.ts, verschluesselt im Server-Tresor; Wert nie in einer Antwort):
 *   GET    /api/main-agent/api/key             Stand (vorhanden, Quelle webui|env, gesetzt am, letzte 4, Schalter, Tresor, debug)
 *   PUT    /api/main-agent/api/key             {key, grund}  hinterlegen/ersetzen (nur Schalter hauptagent_api_key_webui EIN)
 *   DELETE /api/main-agent/api/key             {grund}       entfernen -> Env gilt wieder
 *   PUT    /api/main-agent/api/key/schalter    {aktiv, grund}
 *   POST   /api/main-agent/api/key/testen      GET /v1/models (limit 1) mit dem wirksamen Key: kein Token-Verbrauch
 *   Der Transport nimmt den wirksamen Key (aktuellerApiKey: Web-UI vor Env).
 * P22-T179 Nachtrag: optionale Workspace-ID (Env SYNAPSE_ANTHROPIC_WORKSPACE_ID) geht als Header anthropic-workspace-id an jeden
 *   Anthropic-Aufruf (Transport und 'Key testen', core anthropicKopfzeilen); leer = wie bisher. Meldet Anthropic "not scoped to a
 *   workspace", wird daraus der Fehlercode api_workspace_fehlt mit Hinweis, wo die ID hingehoert.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import {
  HAUPTAGENT_PROJEKT, agentPrincipalAusAnmeldung, leseAgentBezugModus, pruefeAgentToken, w1bFehlerStatus,
  reserviereApiAufruf, schliesseApiAufrufAb, apiRahmenFuerAgent, apiAgentStatus, setzeApiSchalter, setzeApiBudget, entferneApiBudget,
  setzeApiEinstellungen, apiKostenUebersicht, aktuellerApiKey, leseApiKeyStand, setzeApiKey, entferneApiKey, setzeApiKeySchalter,
  API_AGENT_ROLLEN, leseApiAgentenSchalter, apiAgentenStand, setzeApiFreigabe, entferneApiFreigabe, apiRahmenFuerIdentitaet,
  anthropicKopfzeilen, istWorkspaceFehlt, API_WORKSPACE_HINWEIS,
} from '@synapse/core';
import { validateToken } from '../services/auth.js';
import { HAUPTAGENT_IDENTITAET_SCOPE, AGENT_IDENTITAET_SCOPE } from '../services/agent-runtime/main-tool-profile.js';

const CODE = /^[a-z][a-z0-9_]{2,80}$/;
/** Ein Bild zaehlt fuer die Reservierung pauschal so viele Zeichen (statt seiner Base64-Laenge). */
const BILD_ZEICHEN = 5_000;

class TransportFehler extends Error {
  constructor(readonly code: string, readonly status: number, message?: string, readonly details?: unknown, readonly retryAfter?: number | null) {
    super(message ?? code);
  }
}

function sendeFehler(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof TransportFehler) {
    return reply.status(error.status).send({ success: false, error: { code: error.code, message: error.message,
      ...(error.details ? { details: error.details } : {}), ...(error.retryAfter != null ? { retry_after: error.retryAfter } : {}) } });
  }
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && CODE.test(code)) {
    const details = (error as { details?: unknown }).details;
    // P22-T179: Grenze des Agenten wie das Budget (402); fehlende Freigabe bzw. nicht freigegebenes Modell = verboten (403).
    const status = code === 'budget_erschoepft' || code === 'budget_fehlt' || code === 'agent_budget_erschoepft' ? 402
      : code === 'api_freigabe_fehlt' || code === 'modell_nicht_freigegeben' ? 403 : w1bFehlerStatus(code);
    return reply.status(status).send({ success: false, error: { code, message: code, ...(details && typeof details === 'object' ? { details } : {}) } });
  }
  return reply.status(500).send({ success: false, error: { code: 'api_transport_fehler', message: 'Interner Fehler im API-Transport' } });
}

interface AgentKontext { identity_id: string; agent_id: string; project: string; zugang: 'main' | 'agent' }

/**
 * Ausweis + Bearer: die aktive Hauptagenten-Identitaet (zugang main) bzw. P22-T179 ein Arbeitsagent/Koordinator bei Schalter
 * api_agenten EIN im Projekt (zugang agent). Ein Identitaets-Bearer muss zu dieser Identitaet gehoeren.
 */
async function agentAus(request: FastifyRequest, project: unknown): Promise<AgentKontext> {
  if (typeof project !== 'string' || !project.trim()) throw new TransportFehler('project_fehlt', 400);
  const ausweis = request.headers['x-synapse-agent-token'];
  if (typeof ausweis !== 'string' || !ausweis.trim()) throw new TransportFehler('ausweis_fehlt', 401, 'Header x-synapse-agent-token fehlt');
  let principal: ReturnType<typeof agentPrincipalAusAnmeldung>;
  try {
    principal = agentPrincipalAusAnmeldung(await pruefeAgentToken(ausweis.trim(), project.trim(), await leseAgentBezugModus(), { ids: [] }));
  } catch {
    throw new TransportFehler('ausweis_ungueltig', 401);
  }
  if (principal.art !== 'identity') throw new TransportFehler('ausweis_ungueltig', 401);
  const main = principal.project === HAUPTAGENT_PROJEKT && principal.rolle === 'main';
  if (!main) {
    // P22-T179: Arbeitsagent/Koordinator nur bei Schalter api_agenten EIN; AUS = Bestand (nur_hauptagent).
    const zugelassen = principal.project !== HAUPTAGENT_PROJEKT && (API_AGENT_ROLLEN as readonly string[]).includes(principal.rolle);
    const schalter = zugelassen ? await leseApiAgentenSchalter(principal.project) : null;
    if (!schalter?.aktiv) {
      throw new TransportFehler('nur_hauptagent', 403, 'Der kostenpflichtige API-Weg ist nur fuer den Hauptagenten freigegeben'
        + (zugelassen ? ' (Schalter api_agenten im Projekt AUS)' : ''), { rolle: principal.rolle, api_agenten: schalter ? { aktiv: false, quelle: schalter.quelle } : null });
    }
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ''))?.[1]?.trim();
  const row = bearer ? await validateToken(bearer) : null;
  const scope = row?.scope ?? '';
  const bearerIdentitaet = scope.startsWith(HAUPTAGENT_IDENTITAET_SCOPE) ? scope.slice(HAUPTAGENT_IDENTITAET_SCOPE.length)
    : scope.startsWith(AGENT_IDENTITAET_SCOPE) ? scope.slice(AGENT_IDENTITAET_SCOPE.length) : null;
  if (bearerIdentitaet !== null && bearerIdentitaet !== principal.identity_id) {
    throw new TransportFehler('ausweis_passt_nicht_zum_zugang', 403);
  }
  return { identity_id: principal.identity_id, agent_id: principal.agent_id, project: principal.project, zugang: main ? 'main' : 'agent' };
}

/** Zeichen fuer die konservative Kostenschaetzung; Bilder pauschal statt Base64-Laenge. */
export function eingabeZeichen(teile: unknown): number {
  let bilder = 0;
  const text = JSON.stringify(teile, (k, v) => {
    if (k === 'data' && typeof v === 'string' && v.length > 1_000) { bilder += 1; return ''; }
    return v;
  }) ?? '';
  return text.length + bilder * BILD_ZEICHEN;
}

function pruefeAnfrage(b: Record<string, unknown>): { modell: string; system: string | undefined; messages: unknown[]; tools: unknown[]; max_tokens: number } {
  if (typeof b.modell !== 'string' || !b.modell.trim()) throw new TransportFehler('modell_fehlt', 400);
  if (!Array.isArray(b.messages) || b.messages.length === 0) throw new TransportFehler('messages_fehlen', 400);
  for (const m of b.messages) {
    const r = (m as { role?: unknown })?.role;
    if ((r !== 'user' && r !== 'assistant') || !Array.isArray((m as { content?: unknown }).content)) throw new TransportFehler('messages_ungueltig', 400);
  }
  const tools = b.tools === undefined ? [] : b.tools;
  if (!Array.isArray(tools) || !tools.every(t => t && typeof (t as { name?: unknown }).name === 'string' && typeof (t as { input_schema?: unknown }).input_schema === 'object')) {
    throw new TransportFehler('tools_ungueltig', 400);
  }
  if (b.system !== undefined && typeof b.system !== 'string') throw new TransportFehler('system_ungueltig', 400);
  const max = b.max_tokens;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) throw new TransportFehler('max_tokens_ungueltig', 400);
  return { modell: b.modell.trim(), system: b.system as string | undefined, messages: b.messages, tools, max_tokens: max };
}

function retryAfter(headers: unknown): number | null {
  const h = headers as { get?: (n: string) => string | null } | Record<string, string> | undefined;
  const roh = typeof (h as { get?: unknown })?.get === 'function' ? (h as { get: (n: string) => string | null }).get('retry-after') : (h as Record<string, string> | undefined)?.['retry-after'];
  const n = roh ? Number(roh) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function agentApiRoutes(fastify: FastifyInstance): Promise<void> {
  // ---- Transport ------------------------------------------------------------------------------
  fastify.post<{ Body: Record<string, unknown> }>('/api/agent-api/messages', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let reservierung: Awaited<ReturnType<typeof reserviereApiAufruf>> | null = null;
    let agent: AgentKontext | null = null;
    try {
      const body = request.body && typeof request.body === 'object' ? request.body : {};
      agent = await agentAus(request, body.project);
      const a = pruefeAnfrage(body);
      const key = (await aktuellerApiKey()).key;
      if (!key) throw new TransportFehler('api_zugang_fehlt', 503, 'Kein Anthropic-API-Key: weder in der Web-UI hinterlegt noch in der Umgebung der synapse-api (SYNAPSE_ANTHROPIC_API_KEY)');
      reservierung = await reserviereApiAufruf({
        identity_id: agent.identity_id, project: agent.project, agent_id: agent.agent_id, modell: a.modell,
        eingabe_zeichen: eingabeZeichen({ system: a.system, messages: a.messages, tools: a.tools }), max_tokens: a.max_tokens,
        zugang: agent.zugang,
      });
      const abbruch = new AbortController();
      // Abbruch nur, wenn der Worker die Verbindung schliesst, bevor die Antwort fertig ist (request 'close' feuert schon nach dem Body).
      const beiSchluss = (): void => { if (!reply.raw.writableFinished) abbruch.abort(); };
      reply.raw.once('close', beiSchluss);
      let nachricht: Awaited<ReturnType<ReturnType<Anthropic['messages']['stream']>['finalMessage']>>;
      try {
        const client = new Anthropic({ apiKey: key, defaultHeaders: anthropicKopfzeilen() });
        const params = {
          model: reservierung.anbieter_modell, max_tokens: reservierung.max_tokens, messages: a.messages,
          ...(a.system ? { system: a.system } : {}), ...(a.tools.length ? { tools: a.tools } : {}),
        } as unknown as Parameters<Anthropic['messages']['stream']>[0];
        nachricht = await client.messages.stream(params, { signal: abbruch.signal }).finalMessage();
      } catch (err) {
        // HTTP-Fehler der API (Status vorhanden) = nichts berechnet; Abbruch/Verbindung = unbekannt -> volle Reservierung.
        const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : null;
        const text = err instanceof Error ? err.message.split(key).join('***').slice(0, 400) : 'unbekannt';
        await schliesseApiAufrufAb({ reservierung_id: reservierung.reservierung_id, agent_id: agent.agent_id, usage: null,
          nichts_berechnet: status !== null, fehler: status !== null ? `HTTP ${status}: ${text}` : `ohne Antwort: ${text}` }).catch(() => undefined);
        reservierung = null;
        if (status === 401 || status === 403) throw new TransportFehler('api_zugang_ungueltig', 502, 'Der Anthropic-API-Key wurde abgelehnt');
        // P22-T179 Nachtrag: Key ohne Workspace und keine (passende) Workspace-ID -> klarer Code statt anfrage_abgelehnt.
        if (status === 400 && istWorkspaceFehlt(text)) throw new TransportFehler('api_workspace_fehlt', 503, API_WORKSPACE_HINWEIS);
        if (status === 429 || status === 529 || (status !== null && status >= 500)) {
          throw new TransportFehler('ueberlastet', 503, `Anthropic HTTP ${status}`, undefined, retryAfter((err as { headers?: unknown }).headers));
        }
        if (status !== null) throw new TransportFehler('anfrage_abgelehnt', 400, text);
        throw new TransportFehler('anbieter_nicht_erreichbar', 502, text);
      } finally {
        reply.raw.off('close', beiSchluss);
      }
      const abschluss = await schliesseApiAufrufAb({
        reservierung_id: reservierung.reservierung_id, agent_id: agent.agent_id,
        usage: (nachricht.usage ?? null) as unknown as Parameters<typeof schliesseApiAufrufAb>[0]['usage'],
        stop_reason: nachricht.stop_reason ?? null,
      });
      const rest = Math.max(0, Math.round((reservierung.rest_usd_vorher - abschluss.usd) * 1e8) / 1e8);
      reservierung = null;
      return {
        success: true,
        message: {
          id: nachricht.id, model: nachricht.model, content: nachricht.content, stop_reason: nachricht.stop_reason,
          stop_details: (nachricht as unknown as { stop_details?: unknown }).stop_details ?? null, usage: nachricht.usage,
        },
        kosten: { usd: abschluss.usd, usd_quelle: abschluss.usd_quelle },
        rest_usd: rest,
      };
    } catch (error) {
      if (reservierung && agent) {
        // Fehler nach der Reservierung, aber vor bzw. nach dem Anbieter: konservativ volle Reservierung.
        await schliesseApiAufrufAb({ reservierung_id: reservierung.reservierung_id, agent_id: agent.agent_id, usage: null, fehler: 'Abschluss im Transport fehlgeschlagen' }).catch(() => undefined);
      }
      return sendeFehler(reply, error);
    }
  });

  fastify.get<{ Querystring: { project?: string } }>('/api/agent-api/rahmen', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const agent = await agentAus(request, request.query?.project);
      // P22-T179: Nicht-Main sieht zusaetzlich nur die eigene Freigabe; aktiv gilt dann fuer genau diesen Agenten.
      return { success: true, ...(await apiRahmenFuerAgent()),
        ...(agent.zugang === 'agent' ? await apiRahmenFuerIdentitaet(agent.identity_id, agent.project) : { zugang: 'main' }) };
    } catch (error) { return sendeFehler(reply, error); }
  });

  // ---- User -----------------------------------------------------------------------------------
  const USER = { art: 'user' } as const;
  fastify.get('/api/main-agent/api', async (_request, reply) => {
    try { return { success: true, ...(await apiAgentStatus()) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/api/schalter', async (request, reply) => {
    try { return { success: true, schalter: await setzeApiSchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund }) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.put<{ Body: { grenze_usd?: unknown; zeitraum?: unknown; reset_tag?: unknown; erlaubte_modelle?: unknown; grund?: unknown } }>(
    '/api/main-agent/api/budget', async (request, reply) => {
      const b = request.body ?? {};
      try {
        return { success: true, budget: await setzeApiBudget(USER, { grenze_usd: b.grenze_usd, zeitraum: b.zeitraum, reset_tag: b.reset_tag, erlaubte_modelle: b.erlaubte_modelle, grund: b.grund }) };
      } catch (error) { return sendeFehler(reply, error); }
    });
  fastify.delete<{ Body: { grund?: unknown } }>('/api/main-agent/api/budget', async (request, reply) => {
    try { return { success: true, budget: await entferneApiBudget(USER, { grund: request.body?.grund }) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.put<{ Body: { werte?: unknown; entfernen?: unknown; grund?: unknown } }>('/api/main-agent/api/einstellungen', async (request, reply) => {
    const b = request.body ?? {};
    try { return { success: true, einstellungen: await setzeApiEinstellungen(USER, { werte: b.werte, entfernen: b.entfernen, grund: b.grund }) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.get<{ Querystring: { seit?: string; bis?: string } }>('/api/main-agent/api/kosten', async (request, reply) => {
    try { return { success: true, ...(await apiKostenUebersicht({ seit: request.query?.seit, bis: request.query?.bis })) }; } catch (error) { return sendeFehler(reply, error); }
  });
  // P22-T179: Freigaben je Arbeitsagent/Koordinator (nur User-Sitzung; Kosten je Agent: /api/main-agent/api/kosten je_agent).
  fastify.get<{ Querystring: { project?: string } }>('/api/main-agent/api/freigaben', async (request, reply) => {
    try { return { success: true, ...(await apiAgentenStand(request.query?.project?.trim() || null)) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.put<{ Body: { identity_id?: unknown; aktiv?: unknown; modelle?: unknown; grenze_usd?: unknown; heartbeat?: unknown; grund?: unknown } }>(
    '/api/main-agent/api/freigaben', async (request, reply) => {
      const b = request.body ?? {};
      try {
        return { success: true, freigabe: await setzeApiFreigabe(USER, { identity_id: b.identity_id, aktiv: b.aktiv, modelle: b.modelle,
          grenze_usd: b.grenze_usd, heartbeat: b.heartbeat, grund: b.grund }) };
      } catch (error) { return sendeFehler(reply, error); }
    });
  fastify.delete<{ Body: { identity_id?: unknown; grund?: unknown } }>('/api/main-agent/api/freigaben', async (request, reply) => {
    try { return { success: true, ...(await entferneApiFreigabe(USER, { identity_id: request.body?.identity_id, grund: request.body?.grund })) }; } catch (error) { return sendeFehler(reply, error); }
  });

  // ---- P22-T176: API-Key aus der Web-UI (Antworten nur Stand, nie der Wert) ---------------------
  fastify.get('/api/main-agent/api/key', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return { success: true, api_key: await leseApiKeyStand() }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.put<{ Body: { key?: unknown; grund?: unknown } }>('/api/main-agent/api/key', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return { success: true, api_key: await setzeApiKey(USER, { key: request.body?.key, grund: request.body?.grund }) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.delete<{ Body: { grund?: unknown } }>('/api/main-agent/api/key', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return { success: true, api_key: await entferneApiKey(USER, { grund: request.body?.grund }) }; } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.put<{ Body: { aktiv?: unknown; grund?: unknown } }>('/api/main-agent/api/key/schalter', async (request, reply) => {
    try {
      await setzeApiKeySchalter(USER, { aktiv: request.body?.aktiv, grund: request.body?.grund });
      return { success: true, api_key: await leseApiKeyStand() };
    } catch (error) { return sendeFehler(reply, error); }
  });
  fastify.post('/api/main-agent/api/key/testen', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const start = Date.now();
    let zugang: Awaited<ReturnType<typeof aktuellerApiKey>> | null = null;
    try {
      zugang = await aktuellerApiKey();
      if (!zugang.key) return { success: true, test: { ok: false, quelle: null, http_status: null, fehler: 'api_zugang_fehlt', dauer_ms: Date.now() - start } };
      // GET /v1/models (limit 1): prueft den Key ohne Token-Verbrauch.
      const seite = await new Anthropic({ apiKey: zugang.key, maxRetries: 0, timeout: 15_000, defaultHeaders: anthropicKopfzeilen() }).models.list({ limit: 1 });
      return { success: true, test: { ok: true, quelle: zugang.quelle, http_status: 200, modelle: seite.data.length, dauer_ms: Date.now() - start } };
    } catch (err) {
      const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : null;
      const roh = err instanceof Error ? err.message : 'unbekannt';
      const text = (zugang?.key ? roh.split(zugang.key).join('***') : roh).slice(0, 300);
      const fehlerCode = status === 401 || status === 403 ? 'api_zugang_ungueltig' : status === null ? 'anbieter_nicht_erreichbar'
        : status === 400 && istWorkspaceFehlt(roh) ? 'api_workspace_fehlt' : 'anbieter_fehler';
      return { success: true, test: { ok: false, quelle: zugang?.quelle ?? null, http_status: status, fehler: fehlerCode, text, dauer_ms: Date.now() - start } };
    }
  });
}
