/**
 * Model-Registry: Single-Source-of-Truth fuer Spezialisten-Modelle.
 *
 * Iter 2: statische STATIC_FALLBACK fuer Bootstrap (wenn DB nicht erreichbar
 * oder Migration noch nicht gelaufen).
 * Iter 2.5: getModel/listModels rufen den DB-Service auf, statische REGISTRY
 * dient als Last-Resort-Fallback.
 */

export type Provider = 'anthropic' | 'google';

export interface ModelEntry {
  /** User-facing Alias z.B. "opus", "gemini-flash-lite" */
  alias: string;
  /** API-Modell-String z.B. "claude-opus-4-7", "gemini-3.1-flash-lite-preview" */
  fullId: string;
  provider: Provider;
  /** Token-Kapazitaet (input + output kombiniert) */
  contextWindow: number;
  /** Output-Limit pro Turn */
  outputLimit?: number;
  /** Welche ENV-Vars muessen gesetzt sein (z.B. ['GOOGLE_API_KEY']) */
  envRequired: string[];
  /** Welcher Subprozess startet diesen Spezialisten */
  binary: 'claude' | 'node';
  /** Pfad zur Runtime (nur wenn binary='node') */
  runtimePath?: string;
  /** Auto-Handoff-Schwelle: ab wann wird der Agent gewarnt (Prozent 0-100) */
  corridorMin: number;
  /** Hard-Rotation-Schwelle (Prozent 0-100) */
  corridorMax: number;
  /** Pricing in USD pro 1M Tokens (fuer Cost-Tracking) */
  pricingInputUsdPerMtok?: number;
  pricingOutputUsdPerMtok?: number;
  pricingCacheUsdPerMtok?: number;
}

/**
 * Statische Fallback-REGISTRY.
 * Iter 2.5 ueberschreibt das mit DB-Werten via model-registry-Service.
 * Bei DB-Unavailable wird diese Fallback-Liste genutzt (mit Warning-Log).
 */
export const STATIC_FALLBACK: Record<string, ModelEntry> = {
  opus: {
    alias: 'opus', fullId: 'claude-opus-4-7', provider: 'anthropic',
    contextWindow: 200_000, envRequired: [], binary: 'claude',
    corridorMin: 90, corridorMax: 99,
    pricingInputUsdPerMtok: 15, pricingOutputUsdPerMtok: 75, pricingCacheUsdPerMtok: 1.5,
  },
  sonnet: {
    alias: 'sonnet', fullId: 'claude-sonnet-4-6', provider: 'anthropic',
    contextWindow: 200_000, envRequired: [], binary: 'claude',
    corridorMin: 80, corridorMax: 88,
    pricingInputUsdPerMtok: 3, pricingOutputUsdPerMtok: 15, pricingCacheUsdPerMtok: 0.3,
  },
  haiku: {
    alias: 'haiku', fullId: 'claude-haiku-4-5', provider: 'anthropic',
    contextWindow: 200_000, envRequired: [], binary: 'claude',
    corridorMin: 80, corridorMax: 88,
    pricingInputUsdPerMtok: 1, pricingOutputUsdPerMtok: 5, pricingCacheUsdPerMtok: 0.1,
  },
  'opus[1m]': {
    alias: 'opus[1m]', fullId: 'claude-opus-4-7', provider: 'anthropic',
    contextWindow: 1_000_000, envRequired: [], binary: 'claude',
    corridorMin: 80, corridorMax: 99,
    pricingInputUsdPerMtok: 15, pricingOutputUsdPerMtok: 75, pricingCacheUsdPerMtok: 1.5,
  },
  'sonnet[1m]': {
    alias: 'sonnet[1m]', fullId: 'claude-sonnet-4-6', provider: 'anthropic',
    contextWindow: 1_000_000, envRequired: [], binary: 'claude',
    corridorMin: 70, corridorMax: 88,
    pricingInputUsdPerMtok: 3, pricingOutputUsdPerMtok: 15, pricingCacheUsdPerMtok: 0.3,
  },
  'gemini-flash-lite': {
    alias: 'gemini-flash-lite', fullId: 'gemini-3.1-flash-lite-preview', provider: 'google',
    contextWindow: 1_000_000, envRequired: ['GOOGLE_API_KEY'], binary: 'node',
    runtimePath: '@synapse/agents-gemini/runtime',
    corridorMin: 80, corridorMax: 88,
    pricingInputUsdPerMtok: 0.25, pricingOutputUsdPerMtok: 1.5, pricingCacheUsdPerMtok: 0.025,
  },
  'gemini-flash': {
    alias: 'gemini-flash', fullId: 'gemini-3-flash-preview', provider: 'google',
    contextWindow: 1_000_000, envRequired: ['GOOGLE_API_KEY'], binary: 'node',
    runtimePath: '@synapse/agents-gemini/runtime',
    corridorMin: 80, corridorMax: 88,
    pricingInputUsdPerMtok: 0.5, pricingOutputUsdPerMtok: 3, pricingCacheUsdPerMtok: 0.05,
  },
  'gemini-pro': {
    alias: 'gemini-pro', fullId: 'gemini-2.5-pro', provider: 'google',
    contextWindow: 1_000_000, envRequired: ['GOOGLE_API_KEY'], binary: 'node',
    runtimePath: '@synapse/agents-gemini/runtime',
    corridorMin: 80, corridorMax: 88,
    pricingInputUsdPerMtok: 1.25, pricingOutputUsdPerMtok: 10, pricingCacheUsdPerMtok: 0.13,
  },
};

/**
 * In-Memory-Cache fuer DB-Modelle (DB-1: 1x Lookup beim ersten Zugriff).
 * Wird bei Erstaufruf von resolveModel populiert. Lebt fuer Prozess-Lebensdauer.
 */
let dbCache: Map<string, ModelEntry> | null = null;

/**
 * Synchroner Resolver fuer hot-paths (wrapper.ts heartbeat alle 15s).
 * Nutzt nur den bereits gecachten DB-Snapshot ODER STATIC_FALLBACK.
 * Caller die DB-Werte garantiert brauchen muessen vorher loadFromDb() rufen.
 */
export function resolveModel(aliasOrId: string): ModelEntry | null {
  // 1. DB-Cache zuerst (falls schon geladen)
  if (dbCache) {
    if (dbCache.has(aliasOrId)) return dbCache.get(aliasOrId)!;
    for (const entry of dbCache.values()) {
      if (entry.fullId === aliasOrId) return entry;
    }
  }
  // 2. STATIC_FALLBACK (Bootstrap, Tests, DB-Down)
  if (STATIC_FALLBACK[aliasOrId]) return STATIC_FALLBACK[aliasOrId];
  for (const entry of Object.values(STATIC_FALLBACK)) {
    if (entry.fullId === aliasOrId) return entry;
  }
  return null;
}

/**
 * Asynchroner Loader: holt aktuelle Modell-Liste aus der DB und cached sie.
 * Sollte einmal beim Start des Prozesses (MCP-Server, Wrapper) gerufen werden.
 * Bei DB-Fehler bleibt der Cache leer und resolveModel faellt auf STATIC_FALLBACK.
 */
export async function loadFromDb(): Promise<void> {
  try {
    // Dynamic import um circular dep zu vermeiden (core importiert agents nicht)
    const { listModels: dbListModels } = await import('@synapse/core');
    const dbModels = await dbListModels();
    const map = new Map<string, ModelEntry>();
    for (const m of dbModels) {
      map.set(m.alias, {
        alias: m.alias,
        fullId: m.fullId,
        provider: m.provider as 'anthropic' | 'google',
        contextWindow: m.contextWindow,
        outputLimit: m.outputLimit ?? undefined,
        envRequired: m.envRequired,
        binary: m.binary,
        runtimePath: m.runtimePath ?? undefined,
        corridorMin: m.corridorMin,
        corridorMax: m.corridorMax,
        pricingInputUsdPerMtok: m.pricingInputUsdPerMtok ?? undefined,
        pricingOutputUsdPerMtok: m.pricingOutputUsdPerMtok ?? undefined,
        pricingCacheUsdPerMtok: m.pricingCacheUsdPerMtok ?? undefined,
      });
    }
    dbCache = map;
  } catch (err) {
    console.error(
      `[models] DB-Lookup fehlgeschlagen, nutze STATIC_FALLBACK: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function listAliases(): string[] {
  if (dbCache) return Array.from(dbCache.keys());
  return Object.keys(STATIC_FALLBACK);
}
