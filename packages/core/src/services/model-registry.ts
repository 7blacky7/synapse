/**
 * Model-Registry Service: zentraler DB-Loader fuer Spezialisten-Modelle.
 *
 * Architektur (DB-1 Bootstrap):
 * - In-Memory-Cache wird beim ersten Lookup populiert.
 * - Cache lebt fuer Prozess-Lebensdauer (Wrapper, MCP-Server, REST-API).
 * - Bei DB-Down → klare Error-Message (KEIN silent fallback, sonst falsche
 *   Schwellen).
 * - Multi-Daemon: kein Cache-Drift weil agent_sessions.id PK ist und
 *   Modell pro Spawn fixiert wird (siehe DB-2-Begruendung).
 *
 * KEIN PostgreSQL LISTEN/NOTIFY. Wenn Modell-Daten geaendert werden:
 * MCP-Server / Wrapper neustarten (Maintenance-Event).
 */

import { getPool } from '../db/index.js';

export type Provider = 'anthropic' | 'google' | string;

export interface ModelEntry {
  alias: string;
  fullId: string;
  provider: Provider;
  contextWindow: number;
  outputLimit?: number | null;
  envRequired: string[];
  binary: 'claude' | 'node';
  runtimePath?: string | null;
  corridorMin: number;
  corridorMax: number;
  pricingInputUsdPerMtok?: number | null;
  pricingOutputUsdPerMtok?: number | null;
  pricingCacheUsdPerMtok?: number | null;
  cutoffDate?: string | null;
  enabled: boolean;
}

let cache: Map<string, ModelEntry> | null = null;

interface DbRow {
  alias: string;
  full_id: string;
  provider: string;
  context_window: number;
  output_limit: number | null;
  env_required: string[] | null;
  runtime_binary: string;
  runtime_path: string | null;
  corridor_min: number;
  corridor_max: number;
  pricing_input_usd_per_mtok: string | null;
  pricing_output_usd_per_mtok: string | null;
  pricing_cache_usd_per_mtok: string | null;
  cutoff_date: Date | null;
  enabled: boolean;
}

function rowToEntry(row: DbRow): ModelEntry {
  return {
    alias: row.alias,
    fullId: row.full_id,
    provider: row.provider,
    contextWindow: row.context_window,
    outputLimit: row.output_limit,
    envRequired: row.env_required ?? [],
    binary: (row.runtime_binary === 'node' ? 'node' : 'claude'),
    runtimePath: row.runtime_path,
    corridorMin: row.corridor_min,
    corridorMax: row.corridor_max,
    pricingInputUsdPerMtok: row.pricing_input_usd_per_mtok ? Number(row.pricing_input_usd_per_mtok) : null,
    pricingOutputUsdPerMtok: row.pricing_output_usd_per_mtok ? Number(row.pricing_output_usd_per_mtok) : null,
    pricingCacheUsdPerMtok: row.pricing_cache_usd_per_mtok ? Number(row.pricing_cache_usd_per_mtok) : null,
    cutoffDate: row.cutoff_date ? row.cutoff_date.toISOString().slice(0, 10) : null,
    enabled: row.enabled,
  };
}

async function loadCache(): Promise<Map<string, ModelEntry>> {
  if (cache) return cache;
  const pool = getPool();
  const result = await pool.query<DbRow>(
    `SELECT alias, full_id, provider, context_window, output_limit, env_required, runtime_binary, runtime_path,
            corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok,
            pricing_cache_usd_per_mtok, cutoff_date, enabled
     FROM model_registry WHERE enabled = true`,
  );
  cache = new Map(result.rows.map(r => [r.alias, rowToEntry(r)]));
  return cache;
}

/**
 * Loest einen Alias auf einen ModelEntry auf.
 * Returns null wenn unbekannt — Caller MUSS auf null checken und klare Error
 * mit listAliases() zurueckgeben (DB-4).
 */
export async function getModel(alias: string): Promise<ModelEntry | null> {
  const map = await loadCache();
  if (map.has(alias)) return map.get(alias)!;
  // Fallback: full_id-Lookup
  for (const entry of map.values()) {
    if (entry.fullId === alias) return entry;
  }
  return null;
}

/** Liste aller aktiven Modell-Aliases. Nuetzlich fuer Error-Messages und MCP-Tool-Schemas. */
export async function listAliases(): Promise<string[]> {
  const map = await loadCache();
  return Array.from(map.keys());
}

export async function listModels(): Promise<ModelEntry[]> {
  const map = await loadCache();
  return Array.from(map.values());
}

export async function listProviders(): Promise<Provider[]> {
  const map = await loadCache();
  return Array.from(new Set(Array.from(map.values()).map(e => e.provider)));
}

/** Cache zuruecksetzen (z.B. nach Modell-Update via Web-UI). Nicht thread-safe — nur fuer Tests + Maintenance. */
export function invalidateCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Provider-Credentials (PL #7667 Punkt 2)
// ---------------------------------------------------------------------------

/**
 * Liefert den API-Key fuer einen Provider aus der provider_credentials-Tabelle.
 * Nur relevant wenn SYNAPSE_GEMINI_USE_EMBEDDING_KEY=false. Sonst wird die ENV
 * direkt benutzt.
 */
export async function getProviderCredential(provider: string): Promise<string | null> {
  const pool = getPool();
  const result = await pool.query<{ api_key: string }>(
    `SELECT api_key FROM provider_credentials WHERE provider = $1`,
    [provider],
  );
  return result.rows[0]?.api_key ?? null;
}

export async function setProviderCredential(provider: string, apiKey: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO provider_credentials (provider, api_key, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (provider) DO UPDATE SET api_key = EXCLUDED.api_key, updated_at = NOW()`,
    [provider, apiKey],
  );
}
