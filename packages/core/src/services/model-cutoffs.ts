/**
 * Model-Cutoffs: Wissensstand (knowledge cutoff) je Modell, datengetrieben.
 *
 * Quelle der Wahrheit ist die Tabelle model_cutoffs (Seed in db/schema.ts,
 * Aktualisierung per scripts/modelle-2026-09-aktualisieren.mjs). Ersetzt die
 * frueher hart codierte MODEL_CUTOFFS-Liste in chat.ts — die war veraltet und
 * ihr startsWith-Praefix traf falsch (gpt-5 matchte gpt-5.6-sol).
 *
 * MODEL_CUTOFF_SEED ist derselbe Stand als Liste im Code:
 *   - Rueckfall, solange die Tabelle nicht lesbar ist (vor dem Deploy, DB weg)
 *   - Vergleichsbasis: scripts/test-modelle-cutoffs.mjs prueft, dass der Seed
 *     im SCHEMA_SQL und diese Liste gleich sind. Wer eine Zeile aendert, aendert
 *     beide (und das Aktualisierungs-Skript liest diese Liste).
 *
 * Aufloesung (resolveCutoff):
 *   0. normalisieren: lowercase, trim, Provider-Praefix (openai/, anthropic/,
 *      google/) weg, [1m] weg, Datums-Suffix -YYYYMMDD weg
 *   1. exakter Treffer in model_cutoffs
 *   2. model_registry per Alias (opus, fable, opus-4.7 ...) -> deren full_id in
 *      model_cutoffs, sonst cutoff_date des Registry-Eintrags
 *   3. laengster Praefix NUR an '-'-Grenze (gpt-5.6-thinking -> gpt-5.6).
 *      '.' ist keine Grenze: gpt-5.6-sol faellt nie auf gpt-5.
 * Unbekannt -> null. Wirft nie.
 *
 * Cache wie model-registry.ts: einmal laden, lebt fuer die Prozess-Lebensdauer.
 */

import { getPool } from '../db/client.js';
import { getModel } from './model-registry.js';

/** [model_id, cutoff_date (YYYY-MM-DD), quelle] — Stand 29.09.2026. Monatsangaben -> Tag 01. */
export const MODEL_CUTOFF_SEED: ReadonlyArray<readonly [string, string, string]> = [
  // Claude — offiziell ("reliable knowledge cutoff")
  ['claude-fable-5-1', '2026-06-01', 'platform.claude.com'],
  ['claude-opus-5-5', '2026-06-01', 'platform.claude.com'],
  ['claude-sonnet-5-5', '2026-06-01', 'platform.claude.com'],
  ['claude-haiku-4-5', '2025-02-28', 'platform.claude.com'],
  // Claude — aeltere Versionen (claude-fable-5: Anthropic nennt keinen Wert, models.dev ueber Vertex)
  ['claude-opus-5', '2026-05-01', 'models.dev'],
  ['claude-sonnet-5', '2026-01-31', 'models.dev'],
  ['claude-opus-4-8', '2026-01-01', 'models.dev'],
  ['claude-opus-4-7', '2026-01-31', 'models.dev'],
  ['claude-sonnet-4-6', '2025-08-31', 'models.dev'],
  ['claude-opus-4-6', '2025-05-31', 'models.dev'],
  ['claude-sonnet-4-5', '2025-07-31', 'models.dev'],
  ['claude-opus-4-5', '2025-05-01', 'models.dev'],
  ['claude-fable-5', '2026-01-31', 'models.dev (vertex)'],
  // OpenAI (Codex-Abo und API)
  ['gpt-6-astra', '2026-04-30', 'models.dev'],
  ['gpt-6-sol', '2026-04-20', 'models.dev'],
  ['gpt-6-luna', '2026-05-18', 'models.dev'],
  ['gpt-5.6', '2026-02-16', 'models.dev'],
  ['gpt-5.6-sol', '2026-02-16', 'models.dev'],
  ['gpt-5.6-terra', '2026-02-16', 'models.dev'],
  ['gpt-5.6-luna', '2026-02-16', 'models.dev'],
  ['gpt-5.5', '2025-12-01', 'models.dev'],
  ['gpt-5.4', '2025-08-31', 'models.dev'],
  ['gpt-5.3-codex', '2025-08-31', 'models.dev'],
  ['gpt-5.2', '2025-08-31', 'models.dev'],
  ['gpt-5.1', '2024-09-30', 'models.dev'],
  ['gpt-5', '2024-09-30', 'models.dev'],
  ['gpt-5-mini', '2024-05-30', 'models.dev'],
  ['gpt-5-nano', '2024-05-30', 'models.dev'],
  ['gpt-4o', '2023-09-01', 'models.dev'],
  ['gpt-4o-mini', '2023-09-01', 'models.dev'],
  ['gpt-4-turbo', '2023-12-01', 'models.dev'],
  // Google Gemini
  ['gemini-3.8-flash', '2026-03-01', 'ai.google.dev'],
  ['gemini-3.7-flash', '2026-03-01', 'deepmind-model-card'],
  ['gemini-3.6-flash', '2026-03-01', 'models.dev'],
  ['gemini-3.5-flash-lite', '2026-03-01', 'models.dev'],
  ['gemini-3.5-flash', '2025-01-01', 'models.dev'],
  ['gemini-3.1-flash-lite', '2025-01-01', 'models.dev'],
  ['gemini-3.1-pro-preview', '2025-01-01', 'models.dev'],
  ['gemini-3-flash-preview', '2025-01-01', 'models.dev'],
  ['gemini-2.5-pro', '2025-01-01', 'models.dev'],
  ['gemini-2.5-flash', '2025-01-01', 'models.dev'],
  // gemini-2.0-flash: models.dev fuehrt keinen knowledge-Wert (29.09.2026) — nicht geraten
  // xAI
  ['grok-4.7', '2026-05-01', 'models.dev'],
  ['grok-4.6', '2026-02-01', 'models.dev'],
];

let cache: Map<string, string> | null = null;
let rueckfallGemeldet = false;

async function ladeCutoffs(): Promise<Map<string, string>> {
  if (cache) return cache;
  try {
    // ::text statt DATE: pg macht aus DATE ein lokales Date-Objekt, toISOString
    // verschiebt das oestlich von UTC auf den Vortag.
    const result = await getPool().query<{ model_id: string; cutoff_date: string }>(
      `SELECT model_id, cutoff_date::text AS cutoff_date FROM model_cutoffs`,
    );
    cache = new Map(result.rows.map(r => [r.model_id.toLowerCase(), String(r.cutoff_date).slice(0, 10)]));
    return cache;
  } catch (err) {
    // Nicht cachen: sobald die Tabelle da ist, gilt sie.
    if (!rueckfallGemeldet) {
      rueckfallGemeldet = true;
      console.error(
        `[model-cutoffs] model_cutoffs nicht lesbar, nutze eingebaute Liste: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return new Map(MODEL_CUTOFF_SEED.map(([id, datum]) => [id, datum]));
  }
}

/** Bringt Modellnamen auf die Form der model_cutoffs-Schluessel. */
export function normalisiereModell(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/^(openai|anthropic|google)\//, '');
  m = m.replace(/\[1m\]$/, '');
  m = m.replace(/-\d{8}$/, '');
  return m;
}

/** Laengster Praefix von key, der an einer '-'-Grenze endet und in der Tabelle steht. */
function praefixTreffer(tabelle: Map<string, string>, key: string): string | null {
  const teile = key.split('-');
  for (let n = teile.length - 1; n >= 1; n--) {
    const treffer = tabelle.get(teile.slice(0, n).join('-'));
    if (treffer) return treffer;
  }
  return null;
}

/**
 * Bekannter Cutoff (YYYY-MM-DD) fuer ein Modell oder einen Registry-Alias,
 * sonst null. Wirft nie — ein DB-Fehler wirkt wie "unbekannt" bzw. faellt auf
 * MODEL_CUTOFF_SEED zurueck.
 */
export async function resolveCutoff(model: string | null | undefined): Promise<string | null> {
  if (!model) return null;
  const key = normalisiereModell(model);
  if (!key) return null;
  const tabelle = await ladeCutoffs();

  // 1. exakt
  const exakt = tabelle.get(key);
  if (exakt) return exakt;

  // 2. Registry-Alias -> full_id. Ein bekannter Alias ohne Cutoff bleibt null
  //    (fable-5), statt ueber einen Praefix geraten zu werden.
  const eintrag = await getModel(key).catch(() => null);
  if (eintrag) {
    const fullId = normalisiereModell(eintrag.fullId);
    const ueberFullId = tabelle.get(fullId) ?? praefixTreffer(tabelle, fullId);
    if (ueberFullId) return ueberFullId;
    return eintrag.cutoffDate ?? null;
  }

  // 3. Praefix an '-'-Grenze
  return praefixTreffer(tabelle, key);
}

/** Cache zuruecksetzen (nach Aktualisierung der Tabelle). Nur fuer Tests + Maintenance. */
export function invalidateCutoffCache(): void {
  cache = null;
}
