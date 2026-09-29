/**
 * Model-Registry: Single-Source-of-Truth fuer Spezialisten-Modelle.
 *
 * Iter 2: statische STATIC_FALLBACK fuer Bootstrap (wenn DB nicht erreichbar
 * oder Migration noch nicht gelaufen).
 * Iter 2.5: getModel/listModels rufen den DB-Service auf, statische REGISTRY
 * dient als Last-Resort-Fallback.
 */

import {
  berechneKontextSchwellen, KORRIDOR_1M, KORRIDOR_200K, type KontextSchwellen,
  istEffortStufe, pruefeEffort, waehleEffort, type EffortStufe,
} from '@synapse/core';

export type Provider = 'anthropic' | 'google' | 'antigravity';

export interface ModelEntry {
  /** User-facing Alias z.B. "opus", "gemini-flash-lite" */
  alias: string;
  /** API-Modell-String z.B. "claude-opus-5-5", "gemini-3.1-flash-lite-preview" */
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
  /** Wissensstand (YYYY-MM-DD); massgeblich fuer Agenten ist core model_cutoffs */
  cutoffDate?: string;
  /** Stufen, die das Modell fuer `claude --effort` wirklich bekommt. Leer/fehlt: kein Flag (haiku, node-Runtimes) */
  effortStufen?: EffortStufe[];
  /** Stufe fuer --effort, wenn der Spawn keine nennt — fest statt effortLevel aus den User-Settings */
  defaultEffort?: EffortStufe;
}

/**
 * Statische Fallback-REGISTRY.
 * Iter 2.5 ueberschreibt das mit DB-Werten via model-registry-Service.
 * Bei DB-Unavailable wird diese Fallback-Liste genutzt (mit Warning-Log).
 */
// Claude-Versionen: Output-Limit, Preise ($ je 1M Tokens: input / output / cache_read)
// und Cutoff gelten JE VERSION (full_id), nicht je Familie — Quelle models.dev,
// Stand 29.09.2026. Jeder Alias einer Version (rein, [1m], versioniert) bekommt
// dieselben Werte; gleiche Werte stehen im Seed (core db/schema.ts).
// Effort-Stufen je Version (29.09.2026, claude-CLI 2.1.284). Belege je Zeile:
//  K = in die CLI eingebetteter Modellkatalog, runtime.effort_levels (gelesen von d3n(),
//      ausgewertet von VS() = Effort ueberhaupt, K6e() = xhigh, nJ() = max);
//  R = Mitschnitt des API-Requests (ANTHROPIC_BASE_URL auf einen lokalen Fang-Server),
//      output_config.effort bei --effort low/xhigh/max.
// Kann ein Modell eine Stufe nicht, weicht die CLI STILL aus (R: xhigh -> high bei
// opus-4.6/sonnet-4.6; haiku schickt gar kein output_config). Synapse lehnt solche
// Stufen deshalb ab (core waehleEffort). Gleiche Werte im SCHEMA_SQL (core db/schema.ts).
const ALLE_STUFEN: EffortStufe[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const OHNE_XHIGH: EffortStufe[] = ['low', 'medium', 'high', 'max'];
const KEINE_STUFEN: EffortStufe[] = [];

interface ClaudeVersion {
  outputLimit: number;
  preis: [input: number, output: number, cache: number];
  cutoffDate: string;
  /** Stufen fuer --effort (Belege siehe oben) */
  effort: EffortStufe[];
}
const CLAUDE_VERSIONEN: Record<string, ClaudeVersion> = {
  // K: low..max; R: low/xhigh/max unveraendert
  'claude-fable-5-1': { outputLimit: 128_000, preis: [10, 50, 0.25], cutoffDate: '2026-06-01', effort: ALLE_STUFEN },
  // fable-5: Anthropic nennt keinen Cutoff, models.dev ueber Vertex. Effort: K low..max; R unveraendert
  'claude-fable-5': { outputLimit: 128_000, preis: [10, 50, 1], cutoffDate: '2026-01-31', effort: ALLE_STUFEN },
  // K: low..max (Katalog-Standard medium); R: low/xhigh/max unveraendert
  'claude-opus-5-5': { outputLimit: 128_000, preis: [4, 20, 0.2], cutoffDate: '2026-06-01', effort: ALLE_STUFEN },
  // K: low..max; R: low/xhigh/max unveraendert
  'claude-opus-5': { outputLimit: 128_000, preis: [5, 25, 0.5], cutoffDate: '2026-05-01', effort: ALLE_STUFEN },
  // K: low..max; R: low/xhigh/max unveraendert
  'claude-opus-4-8': { outputLimit: 128_000, preis: [5, 25, 0.5], cutoffDate: '2026-01-01', effort: ALLE_STUFEN },
  // K: low..max (Katalog-Standard xhigh); R: xhigh/max unveraendert
  'claude-opus-4-7': { outputLimit: 128_000, preis: [5, 25, 0.5], cutoffDate: '2026-01-31', effort: ALLE_STUFEN },
  // K: low,medium,high,max; K6e schliesst claude-opus-4-6 aus; R: xhigh -> high (still), max bleibt
  'claude-opus-4-6': { outputLimit: 128_000, preis: [5, 25, 0.5], cutoffDate: '2025-05-31', effort: OHNE_XHIGH },
  // NICHT im eingebetteten Katalog, VS/K6e/nJ schliessen es nicht aus; R: xhigh/max unveraendert
  'claude-sonnet-5-5': { outputLimit: 128_000, preis: [2, 10, 0.2], cutoffDate: '2026-06-01', effort: ALLE_STUFEN },
  // K: low..max; R: low/xhigh/max unveraendert
  'claude-sonnet-5': { outputLimit: 128_000, preis: [2, 10, 0.2], cutoffDate: '2026-01-31', effort: ALLE_STUFEN },
  // K: low,medium,high,max; K6e schliesst claude-sonnet-4-6 aus; R: xhigh -> high (still), max bleibt
  'claude-sonnet-4-6': { outputLimit: 128_000, preis: [3, 15, 0.3], cutoffDate: '2025-08-31', effort: OHNE_XHIGH },
  // K: kein effort_levels (thinking type none); VS schliesst claude-haiku-4-5 aus; R: kein output_config
  'claude-haiku-4-5-20251001': { outputLimit: 64_000, preis: [1, 5, 0.1], cutoffDate: '2025-02-28', effort: KEINE_STUFEN },
};

/**
 * Stufe, wenn der Spawn keine nennt. 'medium' = das bisherige Verhalten (effortLevel
 * des Users stand auf medium), jetzt aber fest statt still geerbt. Gleicher Wert im
 * SCHEMA_SQL (core db/schema.ts, UPDATE nach dem model_registry-Seed).
 */
const STANDARD_EFFORT: EffortStufe = 'medium';

/**
 * Claude-Eintrag fuer einen Alias. Kontext = Abo-Kontext der CLI (200k, [1m] = 1M,
 * fable immer 1M), Korridor je Groessenklasse (core services/kontext-korridor.ts),
 * alles andere je Version aus CLAUDE_VERSIONEN.
 */
function claude(alias: string, fullId: string): ModelEntry {
  const version = CLAUDE_VERSIONEN[fullId];
  const einsM = alias.endsWith('[1m]') || alias.startsWith('fable');
  const korridor = einsM ? KORRIDOR_1M : KORRIDOR_200K;
  return {
    alias, fullId, provider: 'anthropic',
    contextWindow: einsM ? 1_000_000 : 200_000,
    outputLimit: version.outputLimit,
    envRequired: [], binary: 'claude',
    corridorMin: korridor.corridorMin, corridorMax: korridor.corridorMax,
    pricingInputUsdPerMtok: version.preis[0],
    pricingOutputUsdPerMtok: version.preis[1],
    pricingCacheUsdPerMtok: version.preis[2],
    cutoffDate: version.cutoffDate,
    effortStufen: version.effort,
    defaultEffort: version.effort.includes(STANDARD_EFFORT) ? STANDARD_EFFORT : undefined,
  };
}

// Claude-Korridore je Groessenklasse: 200k = 73/88, 1M = 80/97 (Token-Budget und
// Begruendung: core services/kontext-korridor.ts, gleiche Werte im Seed schema.ts).
export const STATIC_FALLBACK: Record<string, ModelEntry> = {
  // Reine Aliase: immer die neueste Version (die CLI loest sie selbst auf)
  opus: claude('opus', 'claude-opus-5-5'),
  sonnet: claude('sonnet', 'claude-sonnet-5-5'),
  haiku: claude('haiku', 'claude-haiku-4-5-20251001'),
  'opus[1m]': claude('opus[1m]', 'claude-opus-5-5'),
  'sonnet[1m]': claude('sonnet[1m]', 'claude-sonnet-5-5'),
  // fable: 1M nativ ([1m] nimmt die CLI an, ignoriert es aber)
  fable: claude('fable', 'claude-fable-5-1'),
  // Versionierte Aliase: aeltere Claude-Versionen gezielt waehlbar. Die CLI kennt
  // diese Aliase nicht — process.ts gibt ihr fullId (plus [1m]), siehe cliModelArg.
  // sonnet-4.6[1m] fehlt bewusst: 1M fuer Sonnet 4.6 ist nicht im Abo (API-Credits noetig).
  'opus-5': claude('opus-5', 'claude-opus-5'),
  'opus-5[1m]': claude('opus-5[1m]', 'claude-opus-5'),
  'sonnet-5': claude('sonnet-5', 'claude-sonnet-5'),
  'sonnet-5[1m]': claude('sonnet-5[1m]', 'claude-sonnet-5'),
  'fable-5': claude('fable-5', 'claude-fable-5'),
  'opus-4.8': claude('opus-4.8', 'claude-opus-4-8'),
  'opus-4.8[1m]': claude('opus-4.8[1m]', 'claude-opus-4-8'),
  'opus-4.7': claude('opus-4.7', 'claude-opus-4-7'),
  'opus-4.7[1m]': claude('opus-4.7[1m]', 'claude-opus-4-7'),
  'opus-4.6': claude('opus-4.6', 'claude-opus-4-6'),
  'opus-4.6[1m]': claude('opus-4.6[1m]', 'claude-opus-4-6'),
  'sonnet-4.6': claude('sonnet-4.6', 'claude-sonnet-4-6'),
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
  // Antigravity (agy) CLI: laeuft auf der Pro-Abo-Quota via Keyring — KEIN API-Key
  // (envRequired leer). Strikt getrennt vom 'google'-Provider (Gemini/API-Key).
  // corridorMin hoch: agy verwaltet seinen Kontext selbst, Synapse-Handoff quasi aus.
  antigravity: {
    alias: 'antigravity', fullId: 'agy-1.0.2', provider: 'antigravity',
    contextWindow: 1_000_000, envRequired: [], binary: 'node',
    runtimePath: '@synapse/agents-antigravity/runtime',
    corridorMin: 95, corridorMax: 99,
  },
};

/**
 * In-Memory-Cache fuer DB-Modelle (DB-1: 1x Lookup beim ersten Zugriff).
 * Wird von loadFromDb() gefuellt — aufgerufen im Spawn-Pfad (mcp-server
 * spawnSpecialistTool), beim Wrapper-Start und in der Gemini-Runtime.
 * Lebt fuer Prozess-Lebensdauer.
 */
let dbCache: Map<string, ModelEntry> | null = null;
/** Laufender Ladevorgang — gleichzeitige Aufrufer teilen sich eine DB-Abfrage. */
let dbLaden: Promise<void> | null = null;
/** Laenger wartet niemand auf die Registry: ein Wrapper ohne erreichbare DB startet mit STATIC_FALLBACK. */
const DB_LADE_TIMEOUT_MS = 5_000;

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
 * Laedt EINMAL je Prozess; weitere Aufrufe nach Erfolg sind ein No-op, darum
 * darf ihn jeder Pfad vor resolveModel aufrufen.
 * Bei DB-Fehler oder Timeout bleibt der Cache leer (Log) und resolveModel faellt
 * auf STATIC_FALLBACK; der naechste Aufruf versucht es erneut.
 *
 * Befund 29.09.2026: diese Funktion wurde nirgends aufgerufen — der Spawn sah
 * nur STATIC_FALLBACK, ein Modell, das nur in model_registry stand, war
 * "unbekannt", und Wrapper und core-Respawn rechneten mit verschiedenen Quellen.
 */
export async function loadFromDb(): Promise<void> {
  if (dbCache) return;
  if (dbLaden) return dbLaden;
  dbLaden = ladeAusDb().finally(() => { dbLaden = null; });
  return dbLaden;
}

async function ladeAusDb(): Promise<void> {
  try {
    // Dynamic import um circular dep zu vermeiden (core importiert agents nicht)
    const { listModels: dbListModels } = await import('@synapse/core');
    const dbModels = await Promise.race([
      dbListModels(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`keine Antwort nach ${DB_LADE_TIMEOUT_MS} ms`)), DB_LADE_TIMEOUT_MS).unref();
      }),
    ]);
    const map = new Map<string, ModelEntry>();
    for (const m of dbModels) {
      map.set(m.alias, {
        alias: m.alias,
        fullId: m.fullId,
        provider: m.provider as Provider,
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
        cutoffDate: m.cutoffDate ?? undefined,
        effortStufen: (m.effortStufen ?? []).filter(istEffortStufe),
        defaultEffort: istEffortStufe(m.defaultEffort) ? m.defaultEffort : undefined,
      });
    }
    dbCache = map;
  } catch (err) {
    console.error(
      `[models] DB-Lookup fehlgeschlagen, nutze STATIC_FALLBACK: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Reine CLI-Aliase ohne Versionsnummer — die claude-CLI loest sie selbst auf die neueste Version auf. */
const CLI_ALIAS_OHNE_VERSION = /^(opus|sonnet|haiku|fable)(\[1m\])?$/;

/**
 * Wert fuer `claude --model`.
 * Reine Aliase (opus, sonnet[1m], fable ...) gehen unveraendert durch: sie
 * bedeuten "immer die neueste Version". Versionierte Aliase (opus-4.7,
 * sonnet-5[1m] ...) gibt es nur in der Registry; die CLI bekommt dafuer die
 * volle ID, bei [1m]-Aliasen mit angehaengtem [1m] (claude-opus-4-7[1m]).
 * SYNAPSE_AGENT_MODEL und Registry-Lookups bleiben beim Alias.
 */
export function cliModelArg(entry: ModelEntry): string {
  if (CLI_ALIAS_OHNE_VERSION.test(entry.alias)) return entry.alias;
  return entry.alias.endsWith('[1m]') ? `${entry.fullId}[1m]` : entry.fullId;
}

/**
 * Wert fuer `claude --effort` — oder undefined, dann setzt process.ts kein Flag.
 * Angefragte Stufe (Spawn-Parameter effort, im Wrapper SYNAPSE_AGENT_EFFORT) vor
 * default_effort des Modells, geprueft gegen die effortStufen DIESES Modells: eine
 * Stufe, die es nicht kann, ist ein Fehler statt eines stillen Ausweichens der CLI
 * (core waehleEffort). Kein Flag fuer node-Runtimes (Gemini/agy kennen es nicht) und
 * unbekannte Modelle; dort wird nur die Stufe selbst geprueft.
 */
export function effortFuerCli(entry: ModelEntry | null, gewuenscht?: unknown): EffortStufe | undefined {
  if (!entry || entry.binary !== 'claude') {
    pruefeEffort(gewuenscht);
    return undefined;
  }
  return waehleEffort(entry.alias, entry.effortStufen ?? [], entry.defaultEffort, gewuenscht);
}

/**
 * Context-Schwellen (absolute Tokens) fuer einen Alias — dieselbe Rechnung wie
 * der Respawn-Check in core (berechneKontextSchwellen). Unbekannter Alias:
 * Rueckfall aus core fallbackKorridor.
 */
export function kontextSchwellen(alias: string): KontextSchwellen {
  return berechneKontextSchwellen(resolveModel(alias), alias);
}

/**
 * Alle Aliase, die resolveModel aufloest: DB-Registry UND STATIC_FALLBACK.
 * (Vorher nur die DB, sobald geladen — dann fehlten in Fehlermeldungen Aliase,
 * die resolveModel sehr wohl kannte, z.B. neue vor dem Registry-Update.)
 */
export function listAliases(): string[] {
  const aliase = new Set(Object.keys(STATIC_FALLBACK));
  if (dbCache) for (const alias of dbCache.keys()) aliase.add(alias);
  return Array.from(aliase);
}
