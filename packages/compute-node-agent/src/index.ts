#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { probeNodeCapabilities, type EmbeddingReference } from './probe.js';

const apiUrl = (process.env.SYNAPSE_API_URL || '').replace(/\/$/, '');
const token = process.env.SYNAPSE_API_TOKEN || '';
const heartbeatMs = Number(process.env.SYNAPSE_NODE_HEARTBEAT_MS) || 30_000;
const retryMs = Number(process.env.SYNAPSE_NODE_RETRY_MS) || 2_000;
const configuredConcurrency = Number(process.env.SYNAPSE_NODE_MAX_CONCURRENCY);
const nodeConcurrency = Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
  ? configuredConcurrency
  : 2;

if (!apiUrl || !token) {
  console.error('SYNAPSE_API_URL and SYNAPSE_API_TOKEN are required');
  process.exit(1);
}

let parsedApiUrl: URL;
try {
  parsedApiUrl = new URL(apiUrl);
} catch {
  console.error('SYNAPSE_API_URL must be a valid absolute URL');
  process.exit(1);
}
const loopbackHost = parsedApiUrl.hostname === '127.0.0.1' ||
  parsedApiUrl.hostname === 'localhost' ||
  parsedApiUrl.hostname === '[::1]';
if (parsedApiUrl.protocol !== 'https:' && !(parsedApiUrl.protocol === 'http:' && loopbackHost)) {
  console.error('SYNAPSE_API_URL must use HTTPS (HTTP is allowed only on loopback)');
  process.exit(1);
}
if (parsedApiUrl.username || parsedApiUrl.password || parsedApiUrl.search || parsedApiUrl.hash) {
  console.error('SYNAPSE_API_URL must not contain credentials, query parameters, or fragments');
  process.exit(1);
}

// Der Compute-Prozess ist strikt lokal: kein getEmbeddingProvider() und damit
// kein stiller OpenAI-Fallback. Die Node-Parallelitaet ist eine eigene Workerzahl
// und veraendert EMBED_MAX_CONCURRENT des Servers nicht.
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.SYNAPSE_COMPUTE_NODE = '1';
process.env.SYNAPSE_NODE_MAX_CONCURRENCY = String(nodeConcurrency);

interface EmbeddingClaim {
  chunkId: string;
  claimToken: string;
  content: string;
  contentHash: string;
}

interface ClaimResponse {
  claims?: EmbeddingClaim[];
  reference?: EmbeddingReference;
}

type Fingerprint = Pick<EmbeddingReference, 'model' | 'modelDigest' | 'nativeDimension' | 'targetDimension' | 'numCtx' | 'quantization'>;

function sameFingerprint(
  capability: Awaited<ReturnType<typeof probeNodeCapabilities>>,
  reference: Fingerprint,
): boolean {
  return capability.model === reference.model &&
    capability.modelDigest.toLowerCase().replace(/^sha256:/, '') ===
      reference.modelDigest?.toLowerCase().replace(/^sha256:/, '') &&
    capability.nativeDimension === reference.nativeDimension &&
    capability.targetDimension === reference.targetDimension &&
    capability.numCtx === reference.numCtx &&
    (!reference.quantization || capability.quantization === reference.quantization);
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Synapse API ${response.status}: ${JSON.stringify(payload)}`);
  return payload as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * P15-T6: Referenzvertrag der API (oeffentlich, ohne Token). Ohne erreichbare API gibt es KEINE
 * Altwerte — der Aufrufer meldet den Fehler und versucht es spaeter erneut.
 */
async function holeReferenz(): Promise<EmbeddingReference> {
  const response = await fetch(apiUrl + '/api/embedding-nodes/reference', {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  const payload = await response.json().catch(() => ({})) as { reference?: EmbeddingReference };
  if (!response.ok || !payload.reference) {
    throw new Error('Referenzvertrag der API nicht abrufbar (HTTP ' + response.status + '): ' + JSON.stringify(payload));
  }
  return payload.reference;
}

/**
 * core/embed() liest Modell, Zieldimension und num_ctx aus der Env (OLLAMA_MODEL,
 * EMBEDDING_TARGET_DIM, EMBEDDING_NUM_CTX). Der Knoten setzt sie aus dem Vertrag, BEVOR core
 * geladen wird — so rechnet er genau das, was er meldet, ohne eigene Vorgaben.
 */
function uebernehmeReferenz(reference: EmbeddingReference): void {
  process.env.OLLAMA_MODEL = reference.model;
  process.env.EMBEDDING_TARGET_DIM = String(reference.targetDimension);
  process.env.EMBEDDING_NUM_CTX = String(reference.numCtx);
}

/** Hat sich der Vertrag in einem Punkt geaendert, den core beim Laden uebernommen hat? */
function vertragGewechselt(alt: EmbeddingReference, neu: EmbeddingReference): boolean {
  return alt.model !== neu.model || alt.targetDimension !== neu.targetDimension || alt.numCtx !== neu.numCtx;
}

const bootId = randomUUID();
const bootStartedAt = new Date().toISOString();
let sequence = 0;
let stopped = false;
let activeJobs = 0;
let capabilities: Awaited<ReturnType<typeof probeNodeCapabilities>> | null = null;
let startReferenz: EmbeddingReference | null = null;
const stop = (): void => { stopped = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopped) {
  try {
    // P15-T6: erst der Vertrag der API, dann die Messung dagegen.
    const reference = await holeReferenz();
    uebernehmeReferenz(reference);
    // Einzige Stelle mit harter Schwellenpruefung: vor der Registrierung.
    capabilities = await probeNodeCapabilities(reference, true);
    startReferenz = reference;
    await api('/api/embedding-nodes/register', { ...capabilities, bootId, bootStartedAt });
    console.error(`[ComputeNode] registered ${capabilities.nodeId} (${capabilities.modelDigest})`);
    break;
  } catch (error) {
    console.error('[ComputeNode] registration failed, retrying:', error);
    await sleep(heartbeatMs);
  }
}

if (!capabilities) process.exit(0);

const { embed } = await import('@synapse/core');
const registered = capabilities;
const registrierteReferenz = startReferenz!;

async function heartbeatLoop(): Promise<void> {
  while (!stopped) {
    await sleep(heartbeatMs);
    if (stopped) return;
    try {
      const reference = await holeReferenz();
      if (vertragGewechselt(registrierteReferenz, reference)) {
        // core hat Modell/Dimension/num_ctx beim Laden uebernommen -> sauber neu starten statt
        // mit dem alten Stand weiterzurechnen. Der Dienst-Supervisor startet den Agenten neu.
        console.error('[ComputeNode] Referenzvertrag der API hat sich geaendert, Agent beendet sich fuer einen Neustart:',
          JSON.stringify({ alt: registrierteReferenz, neu: reference }));
        stop();
        return;
      }
      const current = await probeNodeCapabilities(reference);
      await api(`/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/heartbeat`, {
        status: activeJobs > 0 ? 'busy' : 'ready',
        vramFreeMb: current.vramFreeMb,
        activeJobs,
        bootId,
        sequence: ++sequence,
        model: current.model,
        modelDigest: current.modelDigest,
        quantization: current.quantization,
        nativeDimension: current.nativeDimension,
        targetDimension: current.targetDimension,
        numCtx: current.numCtx,
      });
    } catch (error) {
      console.error('[ComputeNode] heartbeat failed, will retry:', error);
    }
  }
}

async function claimLoop(worker: number): Promise<void> {
  // Wartezeit waechst, solange es nichts zu holen gibt, und faellt beim ersten
  // Treffer sofort zurueck. Grund (User-Vorgabe 01.08.2026): ein Knoten ohne
  // Arbeit soll pausieren statt anzuklopfen — gemessen wurden 16 ergebnislose
  // Anfragen in 20 Sekunden, die nur das Serverlog fuellten.
  // ⚠️ Der Backoff verschweigt KEINEN Fehler: er greift nur bei einer leeren
  // Antwort ("nichts frei"), nicht bei einer abgelehnten. Wer ihn benutzt, um
  // 403-Ketten leiser zu machen, verdeckt den eigentlichen Befund.
  const wartezeitMax = Number(process.env.SYNAPSE_NODE_IDLE_MAX_MS) || 60_000;
  let wartezeit = retryMs;
  while (!stopped) {
    try {
      const response = await api<ClaimResponse>(
        `/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/claims`,
        { limit: 1 },
      );
      const claim = response.claims?.[0];
      if (!claim) {
        await sleep(wartezeit);
        wartezeit = Math.min(wartezeit * 2, wartezeitMax);
        continue;
      }
      wartezeit = retryMs;
      if (!response.reference) throw new Error('claim response has no embedding reference');
      const before = await probeNodeCapabilities(response.reference);
      if (!sameFingerprint(before, response.reference)) {
        throw new Error('local model fingerprint differs from claim reference');
      }

      activeJobs++;
      try {
        const vector = await embed(claim.content, {
          priority: 'background',
          strictOllama: true,
        });
        const after = await probeNodeCapabilities(response.reference);
        if (!sameFingerprint(after, response.reference) || !sameFingerprint(after, {
          model: before.model,
          modelDigest: before.modelDigest,
          nativeDimension: before.nativeDimension,
          targetDimension: before.targetDimension,
          numCtx: before.numCtx,
          quantization: before.quantization,
        })) {
          throw new Error('local model fingerprint changed while embedding');
        }
        await api(
          `/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/claims/${encodeURIComponent(claim.chunkId)}/complete`,
          {
            claimToken: claim.claimToken,
            contentHash: claim.contentHash,
            vector,
            model: after.model,
            modelDigest: after.modelDigest,
            quantization: after.quantization,
            nativeDimension: after.nativeDimension,
            targetDimension: after.targetDimension,
            numCtx: after.numCtx,
          },
        );
      } finally {
        activeJobs--;
      }
    } catch (error) {
      console.error(`[ComputeNode] worker ${worker} failed, will retry:`, error);
      await sleep(retryMs);
    }
  }
}

await Promise.all([
  heartbeatLoop(),
  ...Array.from({ length: nodeConcurrency }, (_value, index) => claimLoop(index + 1)),
]);
