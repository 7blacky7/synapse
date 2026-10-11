/**
 * MODUL: Jev-Client (P15-T33 E0.5, 11.10.2026) - EINZIGE Aufrufstelle von Jev (OpenRouter
 *        POST /api/v1/systemone). jev-empfehlung.ts, jev-entscheidung.ts und plan-einordnen.ts
 *        rufen nur noch rufeJev(); E1 (erklaerungstopf) ebenso.
 *
 * ABLAUF je Aufruf: Schalter pruefen (jev-schalter.ts, inkl. Budget-Pause) -> Budget reservieren
 *   (jev-kosten.ts) -> fetch mit Timeout -> Kosten aus usage.cost (Fallback Listenpreis) ->
 *   Budget nachbuchen -> Zeile in jev_aufrufe (auch bei HTTP-/Netzfehler, dann usd 0).
 * ERGEBNIS: ok:true mit den rohen Antwortdaten (answers, usage) wie bisher, oder ok:false mit grund
 *   aus | budget | kein_key | timeout | netz | http und einer Meldung im bisherigen Wortlaut
 *   ("Jev-Timeout nach N ms", "Jev nicht erreichbar: ...", "Jev-Fehler HTTP s: ..."). Ein
 *   unlesbarer Antwort-Body wirft wie vorher (der Aufrufer meldet ihn in seinem catch).
 * ENV: JEV_OPENROUTER_API_KEY (Pflicht, nie ausgegeben), JEV_API_URL, JEV_MODELL, JEV_TIMEOUT_MS
 *   (10000), JEV_PREIS_JE_MIO_EINGABE (0.042), JEV_BUDGET_RESERVE_USD (0.001).
 */

import { jevWirksam, type JevFunktion, type JevWirkung } from './jev-schalter.js';
import { bucheJevAufruf, bucheJevBudget, jevKostenAusUsage, reserviereJevBudget, type JevUsdQuelle } from './jev-kosten.js';

export const JEV_STANDARD_URL = 'https://openrouter.ai/api/v1/systemone';
export const JEV_STANDARD_MODELL = 'typesafe/jev-1.13-20260917';
const STANDARD_TIMEOUT_MS = 10_000;

export interface JevKonfig {
  key: string;
  url: string;
  modell: string;
  timeoutMs: number;
}

/** Konfiguration aus der Umgebung (bei jedem Aufruf neu gelesen). */
export function jevKonfig(): JevKonfig {
  const roh = process.env.JEV_TIMEOUT_MS?.trim();
  const t = roh ? Number(roh) : NaN;
  return {
    key: process.env.JEV_OPENROUTER_API_KEY?.trim() ?? '',
    url: process.env.JEV_API_URL?.trim() || JEV_STANDARD_URL,
    modell: process.env.JEV_MODELL?.trim() || JEV_STANDARD_MODELL,
    timeoutMs: Number.isFinite(t) ? t : STANDARD_TIMEOUT_MS,
  };
}

export interface JevAnfrage {
  funktion: JevFunktion;
  project: string | null;
  agent_id?: string | null;
  state: unknown;
  questions: Record<string, unknown>;
}

export interface JevAntwortDaten {
  answers?: Record<string, { choice?: unknown; confidence?: unknown; noul?: unknown; [k: string]: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number; [k: string]: unknown };
  [k: string]: unknown;
}

export type JevErgebnis =
  | {
      ok: true;
      daten: JevAntwortDaten;
      dauer_ms: number;
      modell: string;
      kosten: { usd: number; quelle: JevUsdQuelle; input_tokens: number | null; output_tokens: number | null };
    }
  | {
      ok: false;
      grund: 'aus' | 'budget' | 'kein_key' | 'timeout' | 'netz' | 'http';
      message: string;
      status?: number;
      timeoutMs?: number;
      wirkung?: JevWirkung;
    };

function kurz(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ohneKey(text: string, key: string): string {
  return key ? text.split(key).join('***') : text;
}

const zahlOderNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Der eine Jev-Aufruf. Wirft nur, wenn der Antwort-Body kein JSON ist (wie bisher). */
export async function rufeJev(a: JevAnfrage, deps: { fetch?: typeof fetch } = {}): Promise<JevErgebnis> {
  const k = jevKonfig();
  if (!k.key) {
    return { ok: false, grund: 'kein_key', message: 'Jev nicht konfiguriert: JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses (REST-API bzw. MCP-Server).' };
  }
  const w = await jevWirksam(a.project, a.funktion);
  if (!w.an) return { ok: false, grund: w.ebene === 'budget' ? 'budget' : 'aus', message: w.text ?? 'Jev ist abgeschaltet.', wirkung: w };
  const reservierung = await reserviereJevBudget();
  if (!reservierung.ok) {
    return { ok: false, grund: 'budget', message: reservierung.message, wirkung: { an: false, ebene: 'budget', funktion: 'alle', grund: 'budget', text: reservierung.message } };
  }

  const basis = { project: a.project, funktion: a.funktion, agent_id: a.agent_id ?? null };
  const fehlschlag = async (ms: number, fehler: string) => {
    await bucheJevBudget(reservierung, 0);
    await bucheJevAufruf({ ...basis, input_tokens: null, output_tokens: null, usd: 0, usd_quelle: 'keine', ms, ok: false, fehler });
  };

  const f = deps.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), k.timeoutMs);
  const start = Date.now();
  let antwort: Response;
  try {
    antwort = await f(k.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k.key}` },
      body: JSON.stringify({ model: k.modell, state: a.state, questions: a.questions }),
      signal: ctrl.signal,
    });
  } catch (err) {
    const ms = Date.now() - start;
    if (ctrl.signal.aborted) {
      await fehlschlag(ms, 'timeout');
      return { ok: false, grund: 'timeout', message: `Jev-Timeout nach ${k.timeoutMs} ms`, timeoutMs: k.timeoutMs };
    }
    const message = ohneKey(`Jev nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`, k.key);
    await fehlschlag(ms, message);
    return { ok: false, grund: 'netz', message };
  } finally {
    clearTimeout(timer);
  }
  if (!antwort.ok) {
    const text = await antwort.text().catch(() => '');
    const message = ohneKey(`Jev-Fehler HTTP ${antwort.status}: ${kurz(text, 300)}`, k.key);
    await fehlschlag(Date.now() - start, message);
    return { ok: false, grund: 'http', status: antwort.status, message };
  }
  let daten: JevAntwortDaten;
  try {
    daten = (await antwort.json()) as JevAntwortDaten;
  } catch (err) {
    await fehlschlag(Date.now() - start, 'Antwort kein JSON');
    throw err;
  }
  const dauer = Date.now() - start;
  const kosten = jevKostenAusUsage(daten?.usage);
  const inputTokens = zahlOderNull(daten?.usage?.input_tokens);
  const outputTokens = zahlOderNull(daten?.usage?.output_tokens);
  await bucheJevBudget(reservierung, kosten.usd);
  await bucheJevAufruf({ ...basis, input_tokens: inputTokens, output_tokens: outputTokens, usd: kosten.usd, usd_quelle: kosten.quelle, ms: dauer, ok: true });
  return {
    ok: true,
    daten: daten ?? {},
    dauer_ms: dauer,
    modell: k.modell,
    kosten: { usd: kosten.usd, quelle: kosten.quelle, input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
