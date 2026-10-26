/**
 * P22-T183 B3: Provider-Transport der API-Agenten als Funktion - genutzt von der Route POST /api/agent-api/messages (Altweg: Worker im
 * Runtime-Container, Anthropic-Format) und vom Lauf IM API-Prozess (api-agent-lauf.ts, internes Format, Anthropic UND OpenRouter).
 * ABLAUF je Aufruf: Anbieter aus model_registry (provider anthropic-api | openrouter-api) -> Key vorhanden? -> Budget reservieren
 *   (core reserviereApiAufruf: Schalter, Freigabe je Identitaet, Restbudget, atomar) -> Anbieter rufen -> echte Kosten buchen
 *   (schliesseApiAufrufAb: Reservierung + agent_verbrauch in einer Transaktion) -> Antwort. Kein Ersatzmodell, kein Ersatzanbieter.
 *   HTTP-Fehler des Anbieters (Status vorhanden) = nichts berechnet (usd 0); Abbruch/Verbindung = unbekannt -> volle Reservierung.
 * ANTHROPIC: offizielles SDK, wirksamer Key (aktuellerApiKey: Web-UI vor Env), Header anthropic-workspace-id (anthropicKopfzeilen).
 * OPENROUTER (Koordinator-Entscheid O1, thought dd072217): POST <basis>/chat/completions im OpenAI-Format, Key aus
 *   SYNAPSE_OPENROUTER_API_KEY, Rueckfall NUR lesend auf JEV_OPENROUTER_API_KEY. body usage.include = true -> usage.cost (USD) wird
 *   gebucht (Quelle antwort). Budget/Buchung in api_agent_reservierungen/agent_verbrauch, NIE in jev_budget_stand (Jev-Bremse getrennt).
 *   Basis-URL: SYNAPSE_OPENROUTER_BASE_URL (Tests: lokaler Fake-Server), sonst https://openrouter.ai/api/v1.
 * Der Key steht nie in einer Antwort oder Meldung (Text wird maskiert); die Debugzeile nennt nur die Key-Quelle.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  reserviereApiAufruf, schliesseApiAufrufAb, leseApiModelle, aktuellerApiKey, anthropicKopfzeilen, istWorkspaceFehlt, API_WORKSPACE_HINWEIS,
  API_ANBIETER, API_ANBIETER_OPENROUTER, nachAnthropic, vonAnthropic, stopAusAnthropic, nachOpenAi, werkzeugeNachOpenAi, antwortAusOpenAi,
  nutzungAusOpenAi,
  type ApiAnbieter, type ApiNachricht, type ApiWerkzeugDef, type ApiAnbieterAntwort, type ApiUsage, type ApiNutzung,
} from '@synapse/core';

/** Ein Bild zaehlt fuer die Reservierung pauschal so viele Zeichen (statt seiner Base64-Laenge). */
const BILD_ZEICHEN = 5_000;
const ZEITLIMIT_MS = 30 * 60_000;
export const OPENROUTER_KEY_ENV = 'SYNAPSE_OPENROUTER_API_KEY' as const;
export const OPENROUTER_KEY_RUECKFALL_ENV = 'JEV_OPENROUTER_API_KEY' as const;
export const OPENROUTER_BASIS_ENV = 'SYNAPSE_OPENROUTER_BASE_URL' as const;
const OPENROUTER_BASIS = 'https://openrouter.ai/api/v1';

export class TransportFehler extends Error {
  constructor(readonly code: string, readonly status: number, message?: string, readonly details?: unknown, readonly retryAfter?: number | null) {
    super(message ?? code);
  }
}

export interface TransportKontext { identity_id: string; agent_id: string; project: string; zugang: 'main' | 'agent' }

/** Zeichen fuer die konservative Kostenschaetzung; Bilder pauschal statt Base64-Laenge. */
export function eingabeZeichen(teile: unknown): number {
  let bilder = 0;
  const text = JSON.stringify(teile, (k, v) => {
    // 'data' = Anthropic base64; 'url' nur als data:-URL (OpenAI-Format image_url) - Anthropic-Schaetzung damit unveraendert.
    if (typeof v === 'string' && v.length > 1_000 && (k === 'data' || (k === 'url' && v.startsWith('data:')))) { bilder += 1; return ''; }
    return v;
  }) ?? '';
  return text.length + bilder * BILD_ZEICHEN;
}

function retryAfter(headers: unknown): number | null {
  const h = headers as { get?: (n: string) => string | null } | Record<string, string> | undefined;
  const roh = typeof (h as { get?: unknown })?.get === 'function' ? (h as { get: (n: string) => string | null }).get('retry-after') : (h as Record<string, string> | undefined)?.['retry-after'];
  const n = roh ? Number(roh) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** OpenRouter-Key: eigener Env-Name, sonst lesend der Jev-Key. Liefert nur die Quelle fuer Debug, nie den Wert nach aussen. */
export function openRouterSchluessel(env: NodeJS.ProcessEnv = process.env): { key: string | null; quelle: typeof OPENROUTER_KEY_ENV | typeof OPENROUTER_KEY_RUECKFALL_ENV | null } {
  const eigen = env[OPENROUTER_KEY_ENV]?.trim();
  if (eigen) return { key: eigen, quelle: OPENROUTER_KEY_ENV };
  const jev = env[OPENROUTER_KEY_RUECKFALL_ENV]?.trim();
  if (jev) return { key: jev, quelle: OPENROUTER_KEY_RUECKFALL_ENV };
  return { key: null, quelle: null };
}

export function openRouterBasis(env: NodeJS.ProcessEnv = process.env): string {
  return (env[OPENROUTER_BASIS_ENV]?.trim() || OPENROUTER_BASIS).replace(/\/+$/, '');
}

export interface TransportAnfrage {
  kontext: TransportKontext;
  /** Registry-Alias (api-sonnet, or-deepseek-chat, ...) */
  modell: string;
  system?: string;
  max_tokens: number;
  /** Altweg-Route: Nachrichten/Werkzeuge schon im Anthropic-Format (nur Anthropic-Modelle). */
  anthropic?: { messages: unknown[]; tools: unknown[] };
  /** Lauf in der API: internes Format (beide Anbieter). */
  verlauf?: ApiNachricht[];
  werkzeuge?: ApiWerkzeugDef[];
  signal?: AbortSignal;
  /** Nur Tests: fetch fuer OpenRouter, Fabrik fuer den Anthropic-Client. */
  holen?: typeof fetch;
  anthropicFabrik?: (o: ConstructorParameters<typeof Anthropic>[0]) => Anthropic;
}

export interface TransportErgebnis {
  anbieter: ApiAnbieter;
  /** Original-Nachricht bei Anthropic (fuer die Altweg-Route unveraendert), sonst null. */
  anthropic_nachricht: { id: string; model: string; content: unknown; stop_reason: unknown; stop_details: unknown; usage: unknown } | null;
  /** Antwort im internen Format (Toolschleife), kosten_usd/rest_usd gesetzt. */
  antwort: ApiAnbieterAntwort;
  kosten: { usd: number; usd_quelle: string };
  rest_usd: number;
  /** Tokens im Kontextfenster dieses Aufrufs (Eingabe inkl. Cache) - Grundlage der Kontextmessung je Lauf. */
  kontext_tokens: number | null;
}

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const kontextAus = (u: ApiNutzung | null): number | null => (u ? u.input + u.cache_read + u.cache_creation : null);

/**
 * Ein Anbieteraufruf mit Reservierung und Buchung. Wirft TransportFehler (Transportcodes) bzw. die Fachfehler der Reservierung
 * (funktion_aus, budget_erschoepft, api_freigabe_fehlt, preis_unbekannt, ...).
 */
export async function rufeApiTransport(a: TransportAnfrage): Promise<TransportErgebnis> {
  const modellZeile = (await leseApiModelle()).find(m => m.alias === a.modell);
  const anbieter: ApiAnbieter = modellZeile?.anbieter ?? API_ANBIETER;
  if (anbieter === API_ANBIETER_OPENROUTER) return rufeOpenRouter(a);
  return rufeAnthropic(a);
}

async function rufeAnthropic(a: TransportAnfrage): Promise<TransportErgebnis> {
  const messages = a.anthropic ? a.anthropic.messages : nachAnthropic(a.verlauf ?? []);
  const tools = a.anthropic ? a.anthropic.tools : (a.werkzeuge ?? []).map(w => ({ name: w.name, description: w.beschreibung, input_schema: w.schema }));
  const key = (await aktuellerApiKey()).key;
  if (!key) throw new TransportFehler('api_zugang_fehlt', 503, 'Kein Anthropic-API-Key: weder in der Web-UI hinterlegt noch in der Umgebung der synapse-api (SYNAPSE_ANTHROPIC_API_KEY)');
  const k = a.kontext;
  let reservierung: Awaited<ReturnType<typeof reserviereApiAufruf>> | null = await reserviereApiAufruf({
    identity_id: k.identity_id, project: k.project, agent_id: k.agent_id, modell: a.modell,
    eingabe_zeichen: eingabeZeichen({ system: a.system, messages, tools }), max_tokens: a.max_tokens, zugang: k.zugang,
  });
  try {
    let nachricht: Awaited<ReturnType<ReturnType<Anthropic['messages']['stream']>['finalMessage']>>;
    try {
      const optionen = { apiKey: key, defaultHeaders: anthropicKopfzeilen() };
      const client = a.anthropicFabrik ? a.anthropicFabrik(optionen) : new Anthropic(optionen);
      const params = {
        model: reservierung.anbieter_modell, max_tokens: reservierung.max_tokens, messages,
        ...(a.system ? { system: a.system } : {}), ...(tools.length ? { tools } : {}),
      } as unknown as Parameters<Anthropic['messages']['stream']>[0];
      nachricht = await client.messages.stream(params, { signal: a.signal }).finalMessage();
    } catch (err) {
      // HTTP-Fehler der API (Status vorhanden) = nichts berechnet; Abbruch/Verbindung = unbekannt -> volle Reservierung.
      const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : null;
      const text = err instanceof Error ? err.message.split(key).join('***').slice(0, 400) : 'unbekannt';
      await schliesseApiAufrufAb({ reservierung_id: reservierung.reservierung_id, agent_id: k.agent_id, usage: null,
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
    }
    const abschluss = await schliesseApiAufrufAb({
      reservierung_id: reservierung.reservierung_id, agent_id: k.agent_id,
      usage: (nachricht.usage ?? null) as unknown as ApiUsage | null,
      stop_reason: nachricht.stop_reason ?? null,
    });
    const rest = Math.max(0, Math.round((reservierung.rest_usd_vorher - abschluss.usd) * 1e8) / 1e8);
    reservierung = null;
    const u = (nachricht.usage ?? null) as unknown as Record<string, unknown> | null;
    const nutzung: ApiNutzung | null = u ? { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens), cache_creation: n(u.cache_creation_input_tokens) } : null;
    const stopDetails = (nachricht as unknown as { stop_details?: unknown }).stop_details ?? null;
    return {
      anbieter: API_ANBIETER,
      anthropic_nachricht: { id: nachricht.id, model: nachricht.model, content: nachricht.content, stop_reason: nachricht.stop_reason, stop_details: stopDetails, usage: nachricht.usage },
      antwort: {
        inhalt: vonAnthropic(nachricht.content), stop: stopAusAnthropic(nachricht.stop_reason),
        stop_roh: typeof nachricht.stop_reason === 'string' ? nachricht.stop_reason : null, stop_details: stopDetails,
        nutzung, kosten_usd: abschluss.usd, rest_usd: rest,
      },
      kosten: { usd: abschluss.usd, usd_quelle: abschluss.usd_quelle },
      rest_usd: rest,
      kontext_tokens: kontextAus(nutzung),
    };
  } catch (error) {
    if (reservierung) {
      // Fehler nach der Reservierung, aber vor bzw. nach dem Anbieter: konservativ volle Reservierung.
      await schliesseApiAufrufAb({ reservierung_id: reservierung.reservierung_id, agent_id: k.agent_id, usage: null, fehler: 'Abschluss im Transport fehlgeschlagen' }).catch(() => undefined);
    }
    throw error;
  }
}

async function rufeOpenRouter(a: TransportAnfrage): Promise<TransportErgebnis> {
  if (a.anthropic) {
    throw new TransportFehler('anbieter_nur_api_lauf', 400, 'OpenRouter-Modelle laufen nur als API-Lauf in der synapse-api (P22-T183), nicht ueber den Worker im Runtime-Container');
  }
  const { key } = openRouterSchluessel();
  if (!key) throw new TransportFehler('api_zugang_fehlt', 503, `Kein OpenRouter-Key in der Umgebung der synapse-api (${OPENROUTER_KEY_ENV}, Rueckfall ${OPENROUTER_KEY_RUECKFALL_ENV})`);
  const k = a.kontext;
  const messages = nachOpenAi(a.system ?? '', a.verlauf ?? []);
  const tools = werkzeugeNachOpenAi(a.werkzeuge ?? []);
  let reservierung: Awaited<ReturnType<typeof reserviereApiAufruf>> | null = await reserviereApiAufruf({
    identity_id: k.identity_id, project: k.project, agent_id: k.agent_id, modell: a.modell,
    eingabe_zeichen: eingabeZeichen({ messages, tools }), max_tokens: a.max_tokens, zugang: k.zugang,
  });
  const maske = (t: string): string => t.split(key).join('***');
  const holen = a.holen ?? fetch;
  try {
    let daten: Record<string, unknown>;
    try {
      const signal = a.signal ? AbortSignal.any([a.signal, AbortSignal.timeout(ZEITLIMIT_MS)]) : AbortSignal.timeout(ZEITLIMIT_MS);
      const antwort = await holen(`${openRouterBasis()}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'HTTP-Referer': 'https://synapse.local', 'X-Title': 'Synapse' },
        body: JSON.stringify({
          model: reservierung.anbieter_modell, max_tokens: reservierung.max_tokens, messages,
          ...(tools.length ? { tools } : {}), usage: { include: true },
        }),
        signal,
      });
      const text = await antwort.text();
      let roh: Record<string, unknown> = {};
      try { roh = JSON.parse(text) as Record<string, unknown>; } catch { /* unten */ }
      const fehlerObj = (roh.error && typeof roh.error === 'object' ? roh.error : null) as { code?: unknown; message?: unknown } | null;
      if (!antwort.ok || fehlerObj) {
        const status = !antwort.ok ? antwort.status : (typeof fehlerObj?.code === 'number' ? fehlerObj.code : 400);
        const meldung = maske(String(fehlerObj?.message ?? text)).slice(0, 400);
        await schliesseApiAufrufAb({ reservierung_id: reservierung.reservierung_id, agent_id: k.agent_id, usage: null,
          nichts_berechnet: true, fehler: `HTTP ${status}: ${meldung}` }).catch(() => undefined);
        reservierung = null;
        if (status === 401 || status === 403) throw new TransportFehler('api_zugang_ungueltig', 502, 'Der OpenRouter-Key wurde abgelehnt');
        if (status === 402) throw new TransportFehler('anbieter_guthaben_fehlt', 402, 'OpenRouter: kein Guthaben fuer diesen Aufruf (HTTP 402)');
        if (status === 429 || status >= 500) throw new TransportFehler('ueberlastet', 503, `OpenRouter HTTP ${status}`, undefined, retryAfter(antwort.headers));
        throw new TransportFehler('anfrage_abgelehnt', 400, meldung);
      }
      daten = roh;
    } catch (err) {
      if (err instanceof TransportFehler) throw err;
      const text = maske(err instanceof Error ? err.message : 'unbekannt').slice(0, 400);
      await schliesseApiAufrufAb({ reservierung_id: reservierung!.reservierung_id, agent_id: k.agent_id, usage: null,
        fehler: `ohne Antwort: ${text}` }).catch(() => undefined);
      reservierung = null;
      throw new TransportFehler('anbieter_nicht_erreichbar', 502, text);
    }
    const choice = Array.isArray(daten.choices) ? daten.choices[0] : undefined;
    const nutzung = nutzungAusOpenAi(daten.usage);
    const uRoh = (daten.usage && typeof daten.usage === 'object' ? daten.usage : null) as Record<string, unknown> | null;
    const usage: ApiUsage | null = nutzung ? {
      input_tokens: nutzung.input, output_tokens: nutzung.output, cache_read_input_tokens: nutzung.cache_read, cache_creation_input_tokens: 0,
      kosten_usd: typeof uRoh?.cost === 'number' ? uRoh.cost : null,
    } : null;
    const teil = antwortAusOpenAi(choice);
    const abschluss = await schliesseApiAufrufAb({
      reservierung_id: reservierung.reservierung_id, agent_id: k.agent_id, usage, stop_reason: teil.stop_roh,
      fehler: choice ? null : 'Antwort ohne choices',
    });
    const rest = Math.max(0, Math.round((reservierung.rest_usd_vorher - abschluss.usd) * 1e8) / 1e8);
    reservierung = null;
    if (!choice) throw new TransportFehler('anbieter_antwort_ungueltig', 502, 'OpenRouter-Antwort ohne choices');
    return {
      anbieter: API_ANBIETER_OPENROUTER,
      anthropic_nachricht: null,
      antwort: { inhalt: teil.inhalt, stop: teil.stop, stop_roh: teil.stop_roh, nutzung, kosten_usd: abschluss.usd, rest_usd: rest },
      kosten: { usd: abschluss.usd, usd_quelle: abschluss.usd_quelle },
      rest_usd: rest,
      kontext_tokens: kontextAus(nutzung),
    };
  } catch (error) {
    if (reservierung) {
      await schliesseApiAufrufAb({ reservierung_id: reservierung.reservierung_id, agent_id: k.agent_id, usage: null, fehler: 'Abschluss im Transport fehlgeschlagen' }).catch(() => undefined);
    }
    throw error;
  }
}
