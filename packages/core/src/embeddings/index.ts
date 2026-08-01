/**
 * MODUL: Embedding Service
 * ZWECK: Einheitlicher Zugriff auf alle Embedding-Provider — Ollama, OpenAI, Google, Cohere.
 *
 * INPUT:
 *   - EMBEDDING_PROVIDER (via config) - Provider-Name (ollama | openai | mistral | jina | voyage | google | cohere)
 *   - EMBEDDING_API_KEY / provider-spezifischer Key - API-Authentifizierung
 *   - text: string - Zu embeddender Text
 *   - texts: string[] - Batch-Texte
 *   - data: Buffer + mimeType: string - Medien-Datei (nur multimodale Provider)
 *
 * OUTPUT:
 *   - EmbeddingProvider: Aktiver Provider (Singleton)
 *   - number[]: Embedding-Vektor
 *   - number[][]: Batch-Vektoren
 *   - number: Vektor-Dimension des Modells (gecached)
 *   - boolean: Multimodal-Support-Flag
 *
 * NEBENEFFEKTE:
 *   - Cached den Provider und die Dimension im Prozess-Speicher (_provider, _cachedDimension)
 *   - Fallback: Ollama nicht erreichbar → OpenAI wird automatisch versucht
 *   - Netzwerk: Ruft je nach Provider externe APIs auf
 */

import { getConfig } from '../config.js';
import { SynapseConfig } from '../types/index.js';
import { EmbeddingProvider } from './types.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAICompatibleProvider, PROVIDER_PRESETS } from './openai-compatible.js';
import { GoogleEmbeddingProvider } from './google.js';
import { CohereEmbeddingProvider } from './cohere.js';

export * from './types.js';
export { OllamaEmbeddingProvider } from './ollama.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
export { OpenAICompatibleProvider as OpenAIEmbeddingProvider } from './openai-compatible.js';
export { GoogleEmbeddingProvider } from './google.js';
export { CohereEmbeddingProvider } from './cohere.js';

let _provider: EmbeddingProvider | null = null;
let _cachedDimension: number | null = null;

/** ENV-Variablen-Mapping fuer provider-spezifische API-Keys */
const API_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  jina: 'JINA_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  google: 'GOOGLE_API_KEY',
  cohere: 'COHERE_API_KEY',
};

/**
 * Loest den API-Key fuer einen Provider auf
 * Kaskade: Provider-spezifisch > EMBEDDING_API_KEY > OPENAI_API_KEY
 */
function resolveApiKey(provider: string, config: SynapseConfig): string {
  const envVar = API_KEY_ENV[provider];
  const key = (envVar ? process.env[envVar] : undefined)
    || config.embeddings.apiKey
    || config.embeddings.openai.apiKey;

  if (!key) {
    throw new Error(
      `API Key fuer "${provider}" nicht konfiguriert. ` +
      `Setze ${envVar || 'EMBEDDING_API_KEY'} in der .env Datei.`
    );
  }
  return key;
}

/**
 * Erstellt einen Provider basierend auf dem Namen
 */
function createProvider(name: string, config: SynapseConfig): EmbeddingProvider {
  switch (name) {
    case 'ollama':
      return new OllamaEmbeddingProvider();

    case 'openai':
    case 'mistral':
    case 'jina':
    case 'voyage': {
      const preset = PROVIDER_PRESETS[name];
      const apiKey = resolveApiKey(name, config);
      const model = config.embeddings.model || preset.defaultModel;
      const baseURL = config.embeddings.baseUrl || preset.baseURL;
      return new OpenAICompatibleProvider({ name, apiKey, model, baseURL });
    }

    case 'google': {
      const apiKey = resolveApiKey('google', config);
      const model = config.embeddings.model || undefined;
      return new GoogleEmbeddingProvider(apiKey, model);
    }

    case 'cohere': {
      const apiKey = resolveApiKey('cohere', config);
      const model = config.embeddings.model || undefined;
      return new CohereEmbeddingProvider(apiKey, model);
    }

    default:
      throw new Error(`Unbekannter Embedding Provider: ${name}`);
  }
}

/**
 * Gibt den konfigurierten Embedding Provider zurueck
 * Versucht Fallback auf OpenAI wenn Ollama nicht erreichbar
 */
export interface GetEmbeddingProviderOptions {
  /** Compute-Nodes duerfen niemals auf einen externen Provider ausweichen. */
  strictOllama?: boolean;
}

export async function getEmbeddingProvider(
  options: GetEmbeddingProviderOptions = {},
): Promise<EmbeddingProvider> {
  if (_provider) {
    if (options.strictOllama && _provider.name !== 'ollama') {
      throw new Error('Strict Ollama required, cached provider is not Ollama');
    }
    return _provider;
  }

  const config = getConfig();
  const providerName = config.embeddings.provider;
  if (options.strictOllama && providerName !== 'ollama') {
    throw new Error(`Strict Ollama required, configured provider is ${providerName}`);
  }

  // Ollama mit Fallback-Logik
  if (providerName === 'ollama') {
    const ollama = new OllamaEmbeddingProvider();
    if (await ollama.testConnection()) {
      _provider = ollama;
      return _provider;
    }

    if (options.strictOllama) {
      throw new Error('Strict Ollama required, local Ollama is unavailable');
    }

    console.error('[Synapse] Ollama nicht erreichbar, versuche OpenAI Fallback...');
    if (config.embeddings.openai.apiKey) {
      const preset = PROVIDER_PRESETS['openai'];
      const openai = new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: config.embeddings.openai.apiKey,
        model: config.embeddings.model || preset.defaultModel,
        baseURL: preset.baseURL,
      });
      if (await openai.testConnection()) {
        _provider = openai;
        return _provider;
      }
    }

    throw new Error('Kein Embedding Provider erreichbar (Ollama und OpenAI fehlgeschlagen)');
  }

  // Alle anderen Provider
  const provider = createProvider(providerName, config);
  if (!(await provider.testConnection())) {
    throw new Error(`Embedding Provider "${providerName}" nicht erreichbar`);
  }

  _provider = provider;
  return _provider;
}

// ───── Globale Embedding-Queue ────────────────────────────────────────────
// Interaktive Aufrufe haben Vorrang vor Parser-/Backfill-Arbeit. Ein bereits
// laufender Provider-Call wird nie abgebrochen; die Prioritaet wirkt nur beim
// naechsten frei werdenden Slot.
function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

const MAX_CONCURRENT_EMBED = positiveEnvInt(
  process.env.SYNAPSE_COMPUTE_NODE === '1'
    ? 'SYNAPSE_NODE_MAX_CONCURRENCY'
    : 'EMBED_MAX_CONCURRENT',
  2,
);
const MIN_GAP_MS = nonNegativeEnvInt('EMBED_MIN_GAP_MS', 100);
const INTERACTIVE_QUEUE_LIMIT = positiveEnvInt('EMBED_INTERACTIVE_QUEUE_LIMIT', 100);
const BACKGROUND_QUEUE_LIMIT = positiveEnvInt('EMBED_BACKGROUND_QUEUE_LIMIT', 10_000);
const INTERACTIVE_MAX_WAIT_MS = nonNegativeEnvInt('EMBED_INTERACTIVE_MAX_WAIT_MS', 30_000);
const INITIAL_ESTIMATED_CALL_MS = positiveEnvInt('EMBED_ESTIMATED_CALL_MS', 1_000);

export type EmbedPriority = 'interactive' | 'background';

export interface EmbedOptions {
  /** Default: interactive. Bulk-/Backfill-Pfade muessen background explizit setzen. */
  priority?: EmbedPriority;
  /** 0 = nur sofortiger Slot, sonst typisierter Fehler statt stillem Timeout. */
  maxQueueWaitMs?: number;
  /** Compute-Node: lokales Ollama erzwingen, insbesondere bei gesetztem OpenAI-Key. */
  strictOllama?: boolean;
}

export interface EmbeddingQueueStats {
  maxConcurrent: number;
  active: Record<EmbedPriority, number>;
  queued: Record<EmbedPriority, number>;
  submitted: Record<EmbedPriority, number>;
  started: Record<EmbedPriority, number>;
  completed: Record<EmbedPriority, number>;
  rejected: Record<EmbedPriority, number>;
  currentLongestWaitMs: Record<EmbedPriority, number>;
  longestWaitMs: Record<EmbedPriority, number>;
  averageCallMs: number;
}

interface EmbedLease {
  priority: EmbedPriority;
  startedAt: number;
}

interface QueueEntry {
  priority: EmbedPriority;
  queuedAt: number;
  resolve: (lease: EmbedLease) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const zeroCounts = (): Record<EmbedPriority, number> => ({ interactive: 0, background: 0 });

let activeEmbedCalls = 0;
let lastEmbedFinishMs = 0;
let averageCallMs = INITIAL_ESTIMATED_CALL_MS;
const activeByPriority = zeroCounts();
const submittedByPriority = zeroCounts();
const startedByPriority = zeroCounts();
const completedByPriority = zeroCounts();
const rejectedByPriority = zeroCounts();
const longestWaitByPriority = zeroCounts();
const interactiveQueue: QueueEntry[] = [];
const backgroundQueue: QueueEntry[] = [];

export class EmbeddingQueueFullError extends Error {
  readonly code = 'EMBEDDING_QUEUE_FULL';

  constructor(
    readonly priority: EmbedPriority,
    readonly ahead: number,
    readonly estimatedWaitMs: number,
  ) {
    super(
      `Embedding-Warteschlange voll: ${ahead} Auftraege vor dir, ` +
        `geschaetzte Wartezeit ${Math.ceil(estimatedWaitMs / 1000)} s.`,
    );
    this.name = 'EmbeddingQueueFullError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queueFor(priority: EmbedPriority): QueueEntry[] {
  return priority === 'interactive' ? interactiveQueue : backgroundQueue;
}

function jobsAhead(priority: EmbedPriority): number {
  return activeEmbedCalls + interactiveQueue.length +
    (priority === 'background' ? backgroundQueue.length : 0);
}

function estimateWaitMs(ahead: number): number {
  return Math.max(1, Math.ceil(ahead / MAX_CONCURRENT_EMBED)) *
    Math.max(MIN_GAP_MS, averageCallMs);
}

function queueFullError(
  priority: EmbedPriority,
  ahead = jobsAhead(priority),
): EmbeddingQueueFullError {
  return new EmbeddingQueueFullError(priority, ahead, Math.round(estimateWaitMs(ahead)));
}

function startLease(priority: EmbedPriority, queuedAt: number): EmbedLease {
  const now = Date.now();
  const waitMs = now - queuedAt;
  activeEmbedCalls++;
  activeByPriority[priority]++;
  startedByPriority[priority]++;
  longestWaitByPriority[priority] = Math.max(longestWaitByPriority[priority], waitMs);
  return { priority, startedAt: now };
}

function dispatchNext(): void {
  if (activeEmbedCalls >= MAX_CONCURRENT_EMBED) return;
  const entry = interactiveQueue.shift() ?? backgroundQueue.shift();
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolve(startLease(entry.priority, entry.queuedAt));
}

function acquireEmbedSlot(options: EmbedOptions = {}): Promise<EmbedLease> {
  const priority = options.priority ?? 'interactive';
  submittedByPriority[priority]++;
  const now = Date.now();

  if (activeEmbedCalls < MAX_CONCURRENT_EMBED) {
    return Promise.resolve(startLease(priority, now));
  }

  const queue = queueFor(priority);
  const limit = priority === 'interactive' ? INTERACTIVE_QUEUE_LIMIT : BACKGROUND_QUEUE_LIMIT;
  const maxWaitMs = options.maxQueueWaitMs ??
    (priority === 'interactive' ? INTERACTIVE_MAX_WAIT_MS : Number.POSITIVE_INFINITY);

  if (queue.length >= limit || maxWaitMs <= 0) {
    rejectedByPriority[priority]++;
    return Promise.reject(queueFullError(priority));
  }

  return new Promise<EmbedLease>((resolve, reject) => {
    const entry: QueueEntry = { priority, queuedAt: now, resolve, reject };
    queue.push(entry);

    if (Number.isFinite(maxWaitMs)) {
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index === -1) return;
        const ahead = activeEmbedCalls + index +
          (priority === 'background' ? interactiveQueue.length : 0);
        queue.splice(index, 1);
        rejectedByPriority[priority]++;
        reject(queueFullError(priority, ahead));
      }, maxWaitMs);
    }
  });
}

function releaseEmbedSlot(lease: EmbedLease): void {
  const durationMs = Math.max(0, Date.now() - lease.startedAt);
  averageCallMs = Math.round(averageCallMs * 0.8 + durationMs * 0.2);
  completedByPriority[lease.priority]++;
  activeByPriority[lease.priority]--;
  activeEmbedCalls--;
  lastEmbedFinishMs = Date.now();
  dispatchNext();
}

async function runQueued<T>(
  operation: () => Promise<T>,
  options: EmbedOptions = {},
): Promise<T> {
  const lease = await acquireEmbedSlot(options);
  try {
    const gap = Date.now() - lastEmbedFinishMs;
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
    return await operation();
  } finally {
    releaseEmbedSlot(lease);
  }
}

/** Prozesslokale Scheduler-Metriken; Queue-Schutz ist ebenfalls pro Prozess. */
export function getEmbeddingQueueStats(): EmbeddingQueueStats {
  const now = Date.now();
  const oldest = (queue: QueueEntry[]): number =>
    queue.length === 0 ? 0 : now - queue[0].queuedAt;

  return {
    maxConcurrent: MAX_CONCURRENT_EMBED,
    active: { ...activeByPriority },
    queued: {
      interactive: interactiveQueue.length,
      background: backgroundQueue.length,
    },
    submitted: { ...submittedByPriority },
    started: { ...startedByPriority },
    completed: { ...completedByPriority },
    rejected: { ...rejectedByPriority },
    currentLongestWaitMs: {
      interactive: oldest(interactiveQueue),
      background: oldest(backgroundQueue),
    },
    longestWaitMs: { ...longestWaitByPriority },
    averageCallMs,
  };
}

/** Generiert ein Embedding. Ohne Optionen ist der Aufruf interaktiv. */
export async function embed(
  text: string,
  options: EmbedOptions = {},
): Promise<number[]> {
  return runQueued(async () => {
    const provider = await getEmbeddingProvider({ strictOllama: options.strictOllama });
    return provider.embed(text);
  }, options);
}

/**
 * Generiert mehrere Embeddings.
 *
 * Ollama besitzt kein natives Batch-Embedding. Jeder Text wird deshalb separat
 * gescheduled: eine interaktive Anfrage kann nach dem gerade laufenden Text
 * einspringen, statt auf die ganze Bulk-Scheibe zu warten. Promise.all behaelt
 * die Ergebnisreihenfolge bei.
 */
export async function embedBatch(
  texts: string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (getConfig().embeddings.provider === 'ollama') {
    return Promise.all(texts.map((text) => embed(text, options)));
  }
  return runQueued(async () => {
    const provider = await getEmbeddingProvider({ strictOllama: options.strictOllama });
    return provider.embedBatch(texts);
  }, options);
}

/**
 * Prueft ob der aktuelle Provider Multimodal-Embeddings unterstuetzt
 */
export async function supportsMultimodal(): Promise<boolean> {
  const provider = await getEmbeddingProvider();
  return typeof provider.embedMedia === 'function';
}

/**
 * Generiert Embedding fuer eine Medien-Datei (Bild/Video)
 * Nur verfuegbar bei multimodalen Providern (Google Gemini)
 */
export async function embedMedia(data: Buffer, mimeType: string): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  if (!provider.embedMedia) {
    throw new Error(
      `Provider "${provider.name}" unterstuetzt keine Multimodal-Embeddings. ` +
      `Setze EMBEDDING_PROVIDER=google fuer Bild/Video-Support.`
    );
  }
  return provider.embedMedia(data, mimeType);
}

/**
 * Ermittelt die Vektor-Dimension des aktuellen Embedding-Modells
 * Ergebnis wird gecached fuer die Prozess-Lebensdauer
 */
export async function getEmbeddingDimension(): Promise<number> {
  if (_cachedDimension !== null) return _cachedDimension;

  const testVector = await embed('synapse dimension detection');
  _cachedDimension = testVector.length;
  console.error(`[Synapse] Erkannte Embedding-Dimension: ${_cachedDimension}`);
  return _cachedDimension;
}

/**
 * Setzt den Provider zurueck (fuer Tests)
 */
export function resetEmbeddingProvider(): void {
  _provider = null;
  _cachedDimension = null;
}
