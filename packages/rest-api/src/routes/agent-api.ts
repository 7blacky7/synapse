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
 *
 * USER (nur interaktive User-Sitzung; registriert innerhalb agentRuntimeRoutes, damit dessen Guard fuer /api/main-agent greift):
 *   GET    /api/main-agent/api                 Status (Schalter, Budget, Einstellwerte, Modelle, Key vorhanden ja/nein)
 *   PUT    /api/main-agent/api/schalter        {aktiv, grund}
 *   PUT    /api/main-agent/api/budget          {grenze_usd, zeitraum?, reset_tag?, erlaubte_modelle[], grund}
 *   DELETE /api/main-agent/api/budget          {grund}
 *   PUT    /api/main-agent/api/einstellungen   {werte?: {name: zahl}, entfernen?: [name], grund}
 *   GET    /api/main-agent/api/kosten?seit=&bis=
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import {
  HAUPTAGENT_PROJEKT, agentPrincipalAusAnmeldung, leseAgentBezugModus, pruefeAgentToken, w1bFehlerStatus,
  reserviereApiAufruf, schliesseApiAufrufAb, apiRahmenFuerAgent, apiAgentStatus, setzeApiSchalter, setzeApiBudget, entferneApiBudget,
  setzeApiEinstellungen, apiKostenUebersicht,
} from '@synapse/core';
import { validateToken } from '../services/auth.js';
import { HAUPTAGENT_IDENTITAET_SCOPE } from '../services/agent-runtime/main-tool-profile.js';

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
    const status = code === 'budget_erschoepft' || code === 'budget_fehlt' ? 402 : w1bFehlerStatus(code);
    return reply.status(status).send({ success: false, error: { code, message: code, ...(details && typeof details === 'object' ? { details } : {}) } });
  }
  return reply.status(500).send({ success: false, error: { code: 'api_transport_fehler', message: 'Interner Fehler im API-Transport' } });
}

interface AgentKontext { identity_id: string; agent_id: string; project: string }

/** Ausweis + Bearer: nur die aktive Hauptagenten-Identitaet; ein Identitaets-Bearer muss zu ihr gehoeren. */
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
  if (principal.project !== HAUPTAGENT_PROJEKT || principal.rolle !== 'main') {
    throw new TransportFehler('nur_hauptagent', 403, 'Der kostenpflichtige API-Weg ist in W2 nur fuer den Hauptagenten freigegeben');
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? ''))?.[1]?.trim();
  const row = bearer ? await validateToken(bearer) : null;
  if (row?.scope?.startsWith(HAUPTAGENT_IDENTITAET_SCOPE) && row.scope.slice(HAUPTAGENT_IDENTITAET_SCOPE.length) !== principal.identity_id) {
    throw new TransportFehler('ausweis_passt_nicht_zum_zugang', 403);
  }
  return { identity_id: principal.identity_id, agent_id: principal.agent_id, project: principal.project };
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
      const key = process.env.SYNAPSE_ANTHROPIC_API_KEY?.trim();
      if (!key) throw new TransportFehler('api_zugang_fehlt', 503, 'Kein Anthropic-API-Key in der Umgebung der synapse-api (SYNAPSE_ANTHROPIC_API_KEY)');
      reservierung = await reserviereApiAufruf({
        identity_id: agent.identity_id, project: agent.project, agent_id: agent.agent_id, modell: a.modell,
        eingabe_zeichen: eingabeZeichen({ system: a.system, messages: a.messages, tools: a.tools }), max_tokens: a.max_tokens,
      });
      const abbruch = new AbortController();
      // Abbruch nur, wenn der Worker die Verbindung schliesst, bevor die Antwort fertig ist (request 'close' feuert schon nach dem Body).
      const beiSchluss = (): void => { if (!reply.raw.writableFinished) abbruch.abort(); };
      reply.raw.once('close', beiSchluss);
      let nachricht: Awaited<ReturnType<ReturnType<Anthropic['messages']['stream']>['finalMessage']>>;
      try {
        const client = new Anthropic({ apiKey: key });
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
      await agentAus(request, request.query?.project);
      return { success: true, ...(await apiRahmenFuerAgent()) };
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
}
