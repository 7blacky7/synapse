/**
 * P22-T183 (Koordinator-Entscheid O2, thought dd072217): Preise der OpenRouter-Modelle der API-Agenten (provider 'openrouter-api' in
 * model_registry) werden NICHT von Hand festgeschrieben, sondern aus der OpenRouter-Modellliste uebernommen: zuerst der OEFFENTLICHE
 * Katalog GET https://openrouter.ai/api/v1/models (ohne Key, Timeout KATALOG_TIMEOUT_MS; pricing.prompt/completion je Token -> USD je
 * 1 Mio.; Env SYNAPSE_OPENROUTER_KATALOG_URL fuer Tests). Fix Live-Test 26.10.: kostenpflichtige Modelle (deepseek/deepseek-chat) stehen
 * NICHT im Free-Model-Pool. Der Pool (free-model-pool.ts getPoolModel, P22-T41; Referenz 'openrouter/<full_id>') ist nur Rueckfall,
 * wenn der Katalog fehlt oder das Modell dort nicht steht. Ein Katalogfehler steht nur im Debug (katalog.fehler), wirft nicht.
 * Ohne Preis (null oder 0) bleibt das Modell ohne Preis: reserviereApiAufruf lehnt mit preis_unbekannt ab, eine Freigabe greift nicht.
 * Ein fehlgeschlagener Abruf aendert nichts (der letzte gute Preis bleibt). Stand je Modell (Quelle, Zeitpunkt, Werte) steht in
 * api_modell_preisstand (Schema 163) und erscheint im Debug (Rueckgabe, Lauf-Status).
 */
import { getPool } from '../db/client.js';
import { getPoolModel, type PoolModel } from './free-model-pool.js';
import { API_ANBIETER_OPENROUTER } from './api-agent-dienst.js';

export interface PreisAbgleichZeile {
  alias: string;
  anbieter_modell: string;
  status: 'aktualisiert' | 'ohne_preis' | 'nicht_im_katalog' | 'fehler';
  eingabe: number | null;
  ausgabe: number | null;
  context_window: number | null;
  quelle: string | null;
  fehler?: string;
}
export interface PreisAbgleich {
  zeitpunkt: string;
  zeilen: PreisAbgleichZeile[];
  /** Debug: oeffentlicher Katalog (null = nicht benutzt, z. B. Test mit holeModell). */
  katalog: { url: string; modelle: number | null; fehler: string | null; dauer_ms: number } | null;
}

/** Eintrag fuer den Abgleich: aus dem oeffentlichen Katalog oder dem Free-Model-Pool (PoolModel hat diese Felder). */
export interface PreisKatalogEintrag {
  priceInPerMTok: number | null; priceOutPerMTok: number | null; contextLength: number | null; maxOutputTokens: number | null; metadataSource: string;
}

const positiv = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export const OPENROUTER_KATALOG_URL = 'https://openrouter.ai/api/v1/models';
const KATALOG_URL_ENV = 'SYNAPSE_OPENROUTER_KATALOG_URL';
const KATALOG_TIMEOUT_MS = 15_000;
const jeMio = (x: unknown): number | null => {
  const n = typeof x === 'string' || typeof x === 'number' ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};
const ganz = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : null);

/** Oeffentlicher OpenRouter-Katalog (ohne Key). Liefert id -> Eintrag; wirft bei HTTP-/Formatfehler (Aufrufer: nur Debug). */
export async function ladeOpenRouterKatalog(o: { holen?: typeof fetch; url?: string; timeoutMs?: number } = {}): Promise<Map<string, PreisKatalogEintrag>> {
  const url = o.url ?? (process.env[KATALOG_URL_ENV]?.trim() || OPENROUTER_KATALOG_URL);
  const r = await (o.holen ?? fetch)(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? KATALOG_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`katalog_http_${r.status}`);
  const daten = (await r.json()) as { data?: unknown };
  if (!Array.isArray(daten?.data)) throw new Error('katalog_format');
  const aus = new Map<string, PreisKatalogEintrag>();
  for (const m of daten.data as Array<{ id?: unknown; context_length?: unknown; pricing?: { prompt?: unknown; completion?: unknown }; top_provider?: { max_completion_tokens?: unknown } }>) {
    if (typeof m?.id !== 'string') continue;
    aus.set(m.id, { priceInPerMTok: jeMio(m.pricing?.prompt), priceOutPerMTok: jeMio(m.pricing?.completion), contextLength: ganz(m.context_length),
      maxOutputTokens: ganz(m.top_provider?.max_completion_tokens), metadataSource: 'api-v1-models' });
  }
  return aus;
}

/** Gleicht alle Registry-Zeilen mit provider 'openrouter-api' ab. holeModell nur fuer Tests (Fake-Katalog, Netz 0). */
export async function aktualisiereOpenRouterPreise(o: {
  holeModell?: (ref: string) => Promise<PreisKatalogEintrag | PoolModel | null>;
  /** Nur Tests: Ersatz fuer fetch des oeffentlichen Katalogs (Fake-Katalog, Netz 0). */
  holen?: typeof fetch;
} = {}): Promise<PreisAbgleich> {
  let katalogDebug: PreisAbgleich['katalog'] = null;
  let hole = o.holeModell;
  if (!hole) {
    const start = Date.now();
    const url = process.env[KATALOG_URL_ENV]?.trim() || OPENROUTER_KATALOG_URL;
    let katalog: Map<string, PreisKatalogEintrag> | null = null;
    try {
      katalog = await ladeOpenRouterKatalog({ holen: o.holen, url });
      katalogDebug = { url, modelle: katalog.size, fehler: null, dauer_ms: Date.now() - start };
    } catch (err) {
      katalogDebug = { url, modelle: null, fehler: (err instanceof Error ? err.message : String(err)).slice(0, 200), dauer_ms: Date.now() - start };
    }
    // Katalog zuerst; nur wenn er fehlt oder das Modell dort nicht steht: Free-Model-Pool als Rueckfall.
    hole = async (ref: string) => {
      const k = katalog?.get(ref.replace(/^openrouter\//, ''));
      if (k) return k;
      const p = await getPoolModel(ref);
      return p ? { ...p, metadataSource: 'free-pool-' + p.metadataSource } : null;
    };
  }
  const pool = getPool();
  const r = await pool.query<{ alias: string; full_id: string }>(
    'SELECT alias, full_id FROM model_registry WHERE provider = $1 ORDER BY alias', [API_ANBIETER_OPENROUTER]);
  const zeilen: PreisAbgleichZeile[] = [];
  for (const z of r.rows) {
    const basis = { alias: z.alias, anbieter_modell: z.full_id, eingabe: null, ausgabe: null, context_window: null, quelle: null };
    let m: PreisKatalogEintrag | PoolModel | null;
    try {
      m = await hole(`openrouter/${z.full_id}`);
    } catch (err) {
      zeilen.push({ ...basis, status: 'fehler', fehler: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      continue;
    }
    if (!m) { zeilen.push({ ...basis, status: 'nicht_im_katalog' }); continue; }
    const quelle = `openrouter-katalog:${m.metadataSource}`;
    const ctx = positiv(m.contextLength) ? Math.round(m.contextLength) : null;
    if (!positiv(m.priceInPerMTok) || !positiv(m.priceOutPerMTok)) {
      zeilen.push({ ...basis, status: 'ohne_preis', context_window: ctx, quelle });
      continue;
    }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE model_registry SET pricing_input_usd_per_mtok = $2, pricing_output_usd_per_mtok = $3,
                context_window = COALESCE($4, context_window), output_limit = COALESCE($5, output_limit), updated_at = NOW()
          WHERE alias = $1 AND provider = $6`,
        [z.alias, m.priceInPerMTok, m.priceOutPerMTok, ctx, positiv(m.maxOutputTokens) ? Math.round(m.maxOutputTokens) : null, API_ANBIETER_OPENROUTER]);
      await c.query(
        `INSERT INTO api_modell_preisstand (alias, quelle, eingabe_usd_mtok, ausgabe_usd_mtok, context_window, stand)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (alias) DO UPDATE SET quelle=EXCLUDED.quelle, eingabe_usd_mtok=EXCLUDED.eingabe_usd_mtok,
           ausgabe_usd_mtok=EXCLUDED.ausgabe_usd_mtok, context_window=EXCLUDED.context_window, stand=EXCLUDED.stand`,
        [z.alias, quelle, m.priceInPerMTok, m.priceOutPerMTok, ctx]);
      await c.query('COMMIT');
      zeilen.push({ ...basis, status: 'aktualisiert', eingabe: m.priceInPerMTok, ausgabe: m.priceOutPerMTok, context_window: ctx, quelle });
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      zeilen.push({ ...basis, status: 'fehler', fehler: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    } finally {
      c.release();
    }
  }
  return { zeitpunkt: new Date().toISOString(), zeilen, katalog: katalogDebug };
}

/** Stand je Modell fuer Status/Debug; fehlt die Tabelle (Schema 163 noch nicht gelaufen), leer mit Hinweis. */
export async function leseOpenRouterPreisstand(): Promise<{ zeilen: Array<Record<string, unknown>>; fehler: string | null }> {
  try {
    const r = await getPool().query(
      `SELECT alias, quelle, eingabe_usd_mtok::float AS eingabe, ausgabe_usd_mtok::float AS ausgabe, context_window, stand FROM api_modell_preisstand ORDER BY alias`);
    return { zeilen: r.rows, fehler: null };
  } catch (err) {
    return { zeilen: [], fehler: (err as { code?: string })?.code ?? 'nicht_lesbar' };
  }
}
