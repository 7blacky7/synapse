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
import { embeddingKlasse, EMBEDDING_RANG, type EmbeddingKlasse } from '../services/embedding-rang.js';
import {computeAdmissionAktiv,mitComputeAdmissionKontext} from '../services/compute-admission.js';
import { SynapseConfig } from '../types/index.js';
import { EmbeddingProvider } from './types.js';
import { OllamaEmbeddingProvider } from './ollama.js';
import { OpenAICompatibleProvider, PROVIDER_PRESETS } from './openai-compatible.js';
import { GoogleEmbeddingProvider } from './google.js';
import { CohereEmbeddingProvider } from './cohere.js';
import { mitPraefix, sichereModellprofil, type EmbedArt } from './modell-profil.js';
import { schalterHaeltAn, type InternSchalterStand } from '../services/intern-schalter.js';

export * from './types.js';
export * from './modell-profil.js';
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
 * Modellname fuer Cloud-Provider aus EMBEDDING_MODEL (P15-T8). Bis zum 11.10.2026 stand je Provider ein
 * Standardname im Code (gemini-embedding-2, text-embedding-3-small ...) - ein anderes Modell heisst ein
 * anderer Vektorraum, das darf nie still passieren (Regel regel-keine-festverdrahteten-modellwerte).
 */
function konfiguriertesModell(provider: string, config: SynapseConfig): string {
  const model = config.embeddings.model;
  if (!model) {
    throw new Error(`Kein Embedding-Modell fuer "${provider}" konfiguriert: EMBEDDING_MODEL setzen (kein Standardname im Code).`);
  }
  return model;
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
      const model = konfiguriertesModell(name, config);
      const baseURL = config.embeddings.baseUrl || preset.baseURL;
      return new OpenAICompatibleProvider({ name, apiKey, model, baseURL });
    }

    case 'google': {
      const apiKey = resolveApiKey('google', config);
      return new GoogleEmbeddingProvider(apiKey, konfiguriertesModell('google', config));
    }

    case 'cohere': {
      const apiKey = resolveApiKey('cohere', config);
      return new CohereEmbeddingProvider(apiKey, konfiguriertesModell('cohere', config));
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
    // Nur mit ausdruecklich konfiguriertem Modell (EMBEDDING_MODEL) - kein Standardname im Code.
    if (config.embeddings.openai.apiKey && config.embeddings.model) {
      const preset = PROVIDER_PRESETS['openai'];
      const openai = new OpenAICompatibleProvider({
        name: 'openai',
        apiKey: config.embeddings.openai.apiKey,
        model: config.embeddings.model,
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
// R2.2: Bei aktiver PG-Admission laufen bestehende Requests ohne Abort zu Ende; Vorrang
// und Reserve gelten pro physischer Domain. Die lokale Queue bleibt Backpressure.
// Der folgende P5-T15-Abortpfad gilt nur ohne aktiviertes R2.2-Gate.
// Interaktive Aufrufe haben Vorrang vor Parser-/Backfill-Arbeit (P5-T15, User-Vorgabe
// 11.10.2026: KI-Anfragen werden nie blockiert):
//   - Ein Hintergrundauftrag startet nur, wenn KEIN interaktiver Auftrag laeuft oder wartet —
//     auch nicht auf einen freien Slot.
//   - Kommt ein interaktiver Auftrag, werden alle laufenden Hintergrund-Aufrufe per
//     AbortController abgebrochen (Ollama: fetch-Abbruch) und hinten neu eingereiht; danach
//     laufen sie automatisch weiter. Provider ohne Signal-Unterstuetzung rechnen zu Ende.
//   - GEWOLLT: unter Dauerlast interaktiver Auftraege ruht der Hintergrund entsprechend laenger.
//     Nichts geht verloren — verdraengte Auftraege warten in der Queue, und was in PG mit
//     embedded_at NULL steht, holt der Backlog nach.
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
  /** R2.2: Herkunftszähler, kein vom Client gelieferter ResourceDomain-Schlüssel. */
  admissionSource?: string;
  admissionClaims?: Array<{chunkId:string;claimToken:string;contentHash:string}>;
  /**
   * P12-T4: 'query' fuer Suchanfragen, sonst 'dokument' (Standard). Bestimmt den Praefix laut
   * Model-Card (modell-profil.ts). Jeder Suchpfad MUSS 'query' setzen - ohne Praefix verlieren
   * die Modelle messbar an Treffsicherheit.
   */
  art?: EmbedArt;
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
  /** P5-T15: wie oft ein laufender Hintergrund-Aufruf fuer einen interaktiven verdraengt wurde. */
  preemptedBackground: number;
}

interface EmbedLease {
  klasse: EmbeddingKlasse;
  priority: EmbedPriority;
  startedAt: number;
}

interface QueueEntry {
  klasse: EmbeddingKlasse;
  priority: EmbedPriority;
  queuedAt: number;
  resolve: (lease: EmbedLease) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const zeroCounts = (): Record<EmbedPriority, number> => ({ interactive: 0, background: 0 });

let activeEmbedCalls = 0;
let activeQueries = 0;
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
/** P5-T15: laufende Hintergrund-Aufrufe, die ein interaktiver Auftrag abbrechen darf. */
const laufendeHintergrund = new Set<AbortController>();
let verdraengtHintergrund = 0;

/** Laeuft oder wartet gerade ein interaktiver Auftrag? Dann startet kein Hintergrund. */
function interaktivBeschaeftigt(): boolean {
  return activeByPriority.interactive > 0 || interactiveQueue.length > 0;
}

/** Bricht alle laufenden Hintergrund-Aufrufe ab; runQueued reiht sie hinten neu ein. */
function brichHintergrundAb(): void {
  for (const abbruch of laufendeHintergrund) abbruch.abort();
}

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

/** P14-T2: der Schalter embedding (intern-Tool) haelt diesen Auftrag an. */
export class EmbeddingAngehaltenError extends Error {
  readonly code = 'EMBEDDING_ANGEHALTEN';

  constructor(readonly priority: EmbedPriority, stand: InternSchalterStand) {
    super(
      `Embeddings angehalten (intern-Schalter embedding, modus ${stand.modus}, ` +
        `${stand.dauerhaft ? 'dauerhaft' : `bis ${stand.bis}`}${stand.grund ? `, Grund: ${stand.grund}` : ''}). ` +
        'Semantische Suche und neue Vektoren sind solange nicht verfuegbar — Volltext nutzen ' +
        '(z. B. code_intel search ohne semantic). Geschriebenes bleibt in PostgreSQL und wird nach der Freigabe nachgetragen.',
    );
    this.name = 'EmbeddingAngehaltenError';
  }
}

/**
 * P14-T2: modus 'hintergrund' haelt Hintergrund-Auftraege an, 'alle' zusaetzlich die interaktiven.
 * Rechenknoten (SYNAPSE_COMPUTE_NODE=1) fragen keinen Schalter — der gilt fuer die API.
 */
async function pruefeEmbeddingSchalter(priority: EmbedPriority): Promise<void> {
  if (process.env.SYNAPSE_COMPUTE_NODE === '1') return;
  const stand = priority === 'background'
    ? await schalterHaeltAn('embedding', 'embedding (hintergrund)')
    : await schalterHaeltAn('embedding', 'embedding (interaktiv)', ['alle']);
  if (stand) throw new EmbeddingAngehaltenError(priority, stand);
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

function startLease(priority: EmbedPriority, queuedAt: number, klasse: EmbeddingKlasse): EmbedLease {
  const now = Date.now();
  const waitMs = now - queuedAt;
  activeEmbedCalls++;
  if (klasse === 'interaktiv') activeQueries++;
  activeByPriority[priority]++;
  startedByPriority[priority]++;
  longestWaitByPriority[priority] = Math.max(longestWaitByPriority[priority], waitMs);
  return { priority, startedAt: now, klasse };
}

function dispatchNext(): void {
  while (activeEmbedCalls < MAX_CONCURRENT_EMBED) {
    // P22-T193: nur tatsaechlich wartende Arbeit zaehlt, kein globaler PG-Rueckstandsblock.
    const entry = [...interactiveQueue, ...backgroundQueue].sort((a, b) =>
      EMBEDDING_RANG[a.klasse] - EMBEDDING_RANG[b.klasse] || a.queuedAt - b.queuedAt)[0];
    if (!entry || (activeQueries > 0 && entry.klasse !== 'interaktiv')) return;
    const queue = queueFor(entry.priority);
    queue.splice(queue.indexOf(entry), 1);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(startLease(entry.priority, entry.queuedAt, entry.klasse));
  }
}

function acquireEmbedSlot(options: EmbedOptions = {}, neuversuch = false): Promise<EmbedLease> {
  const priority = options.priority ?? 'interactive';
  // Ein Neuversuch nach Verdraengung ist kein neuer Auftrag
  if (!neuversuch) submittedByPriority[priority]++;
  const now = Date.now();

  // P5-T15: ein interaktiver Auftrag verdraengt laufende Hintergrund-Aufrufe; ein
  // Hintergrundauftrag nimmt keinen freien Slot, solange Interaktives laeuft oder wartet.
  const klasse = embeddingKlasse(options.admissionSource, priority, options.art);
  // P22-T204: ein Neuversuch nach Verdraengung verdraengt seinerseits niemanden.
  if (klasse === 'interaktiv' && !neuversuch && !computeAdmissionAktiv()) brichHintergrundAb();
  if (activeEmbedCalls < MAX_CONCURRENT_EMBED && interactiveQueue.length + backgroundQueue.length === 0
      && (klasse === 'interaktiv' || activeQueries === 0)) {
    return Promise.resolve(startLease(priority, now, klasse));
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
    const entry: QueueEntry = { priority, klasse, queuedAt: now, resolve, reject };
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
    dispatchNext();
  });
}

function releaseEmbedSlot(lease: EmbedLease): void {
  const durationMs = Math.max(0, Date.now() - lease.startedAt);
  averageCallMs = Math.round(averageCallMs * 0.8 + durationMs * 0.2);
  completedByPriority[lease.priority]++;
  activeByPriority[lease.priority]--;
  activeEmbedCalls--;
  if (lease.klasse === 'interaktiv') activeQueries--;
  lastEmbedFinishMs = Date.now();
  dispatchNext();
}

async function runQueued<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: EmbedOptions = {},
): Promise<T> {
  // Die Schleife wiederholt sich NUR nach einer Verdraengung (sonst return/throw).
  for (let neuversuch = false; ; neuversuch = true) {
    await pruefeEmbeddingSchalter(options.priority ?? 'interactive');
    let lease:EmbedLease|null = await acquireEmbedSlot(options, neuversuch);
    const priority=lease.priority;
    // Nur Hintergrund-Aufrufe sind verdraengbar.
    // P22-T204 (Livelock 26.10.): eine Suchanfrage ist nie verdraengbar, auch mit Hintergrund-Prioritaet -
    // sonst verdraengen sich zwei solche Anfragen endlos gegenseitig und blockieren alle anderen.
    const abbruch = priority === 'background' && lease.klasse !== 'verlauf' && lease.klasse !== 'interaktiv' && !computeAdmissionAktiv() ? new AbortController() : null;
    if (abbruch) laufendeHintergrund.add(abbruch);
    try {
      const gap = Date.now() - lastEmbedFinishMs;
      if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
      // P14-T2: ein Hintergrund-Auftrag kann lange in der Queue gewartet haben -> Schalter erneut pruefen
      if (lease.priority === 'background') await pruefeEmbeddingSchalter('background');
      if (abbruch?.signal.aborted) {
        verdraengtHintergrund++;
        continue; // noch vor dem Aufruf verdraengt -> hinten neu einreihen
      }
      return await mitComputeAdmissionKontext({
        source:options.admissionSource??(priority==='interactive'?'core-interactive':'core-background'),
        priority:lease.klasse==='interaktiv'?'interaktiv':'hintergrund',maxWaitMs:options.maxQueueWaitMs,claims:options.admissionClaims,
        releaseLocal:()=>{if(lease){releaseEmbedSlot(lease);lease=null;}},
        resumeLocal:async()=>{lease??=await acquireEmbedSlot(options,true);},
      },()=>operation(abbruch?.signal));
    } catch (error) {
      if (!abbruch?.signal.aborted) throw error;
      // P5-T15: ein interaktiver Auftrag hat diesen Hintergrund-Aufruf verdraengt -> Slot frei
      // (finally) und hinten neu einreihen; der Auftrag laeuft danach automatisch weiter.
      verdraengtHintergrund++;
    } finally {
      if (abbruch) laufendeHintergrund.delete(abbruch);
      if(lease)releaseEmbedSlot(lease);
    }
  }
}

/**
 * P15-T12 E3: wartende Auftraege dieses Prozesses in Abarbeitungsreihenfolge (interaktiv vor
 * Hintergrund) - nur lesend, fuer intern(warteschlange_liste, embedding_queue).
 */
export function embeddingWarteschlangeEintraege(): Array<{ klasse: EmbeddingKlasse; prioritaet: EmbedPriority; position: number; wartet_ms: number }> {
  const jetzt = Date.now();
  return [...interactiveQueue, ...backgroundQueue].sort((a, b) => EMBEDDING_RANG[a.klasse] - EMBEDDING_RANG[b.klasse] || a.queuedAt - b.queuedAt).map((e, i) => ({
    klasse: e.klasse,
    prioritaet: e.priority,
    position: i + 1,
    wartet_ms: jetzt - e.queuedAt,
  }));
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
    preemptedBackground: verdraengtHintergrund,
  };
}

/** Generiert ein Embedding. Ohne Optionen ist der Aufruf interaktiv. */
export async function embed(
  text: string,
  options: EmbedOptions = {},
): Promise<number[]> {
  // P15-T8: Praefixe/num_ctx kommen aus dem Modellprofil (PG) - vor dem Slot laden, nicht darin.
  await sichereModellprofil();
  return runQueued(async (signal) => {
    const provider = await getEmbeddingProvider({ strictOllama: options.strictOllama });
    return provider.embed(mitPraefix(text, options.art), signal);
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
  await sichereModellprofil();
  // Verlauf je Datensatz: neue Code-/Wissensarbeit geht vor dem naechsten Stueck vor, ohne Abbruch.
  if (options.admissionSource === 'verlauf') {
    const result: number[][] = [];
    for (const text of texts) result.push(await embed(text, options));
    return result;
  }
  if (getConfig().embeddings.provider === 'ollama') {
    // Interaktiv: weiterhin je Text, damit eine Anfrage nach dem laufenden Text einspringen kann.
    if ((options.priority ?? 'interactive') === 'interactive') {
      return Promise.all(texts.map((text) => embed(text, options)));
    }
    // P12-T14: Hintergrund in Scheiben von EMBED_OLLAMA_BATCH (Standard 16) als EIN Aufruf je Scheibe.
    // Vorher ein Queue-Slot je Text plus EMBED_MIN_GAP_MS Pause -> Code-Nachzug nur ~5 Chunks/s.
    // Verdraengt ein interaktiver Auftrag eine Scheibe, laeuft sie danach als Ganzes erneut.
    const scheibe = Math.max(1, Number(process.env.EMBED_OLLAMA_BATCH) || 16);
    const scheiben: string[][] = [];
    for (let i = 0; i < texts.length; i += scheibe) scheiben.push(texts.slice(i, i + scheibe));
    const teile = await Promise.all(scheiben.map((s) => runQueued(async (signal) => {
      const provider = await getEmbeddingProvider({ strictOllama: options.strictOllama });
      return provider.embedBatch(s.map((t) => mitPraefix(t, options.art)), signal);
    }, options)));
    return teile.flat();
  }
  return runQueued(async () => {
    const provider = await getEmbeddingProvider({ strictOllama: options.strictOllama });
    return provider.embedBatch(texts.map((t) => mitPraefix(t, options.art)));
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
export async function embedMedia(data: Buffer, mimeType: string, options: EmbedOptions = {}): Promise<number[]> {
  const provider = await getEmbeddingProvider();
  if (!provider.embedMedia) {
    throw new Error(
      `Provider "${provider.name}" unterstuetzt keine Multimodal-Embeddings. ` +
      `Setze EMBEDDING_PROVIDER=google fuer Bild/Video-Support.`
    );
  }
  const operation=()=>provider.embedMedia!(data,mimeType);
  return computeAdmissionAktiv()?runQueued(operation,{priority:'background',admissionSource:'media',...options}):operation();
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
 * Zieldimension der Vektoren (P12-T14): EMBEDDING_TARGET_DIM, sonst die tatsaechlich erkannte
 * Dimension des aktiven Modells. EINZIGE Quelle fuer Collection-Groessen und Vektor-Pruefungen.
 * ⚠️ NIE eine Zahl im Code als Rueckfall (User-Vorgabe 11.10.2026): fest verdrahtete 3072 im
 * Parse-Weg und in den Embedding-Claims haetten nach dem Wechsel auf Nemotron/1024 neue
 * Collections mit der falschen Dimension angelegt und meldeten bei jedem Lauf DIMENSIONS-MISMATCH.
 */
export async function zielDimension(): Promise<number> {
  const n = Number(process.env.EMBEDDING_TARGET_DIM);
  if (Number.isInteger(n) && n > 0) return n;
  return getEmbeddingDimension();
}

/**
 * Setzt den Provider zurueck (fuer Tests)
 */
export function resetEmbeddingProvider(): void {
  _provider = null;
  _cachedDimension = null;
}
