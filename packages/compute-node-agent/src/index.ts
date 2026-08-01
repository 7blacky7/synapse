#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { probeNodeCapabilities } from './probe.js';

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

interface EmbeddingReference {
  model: string;
  modelDigest: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
  quantization: string | null;
}

interface ClaimResponse {
  claims?: EmbeddingClaim[];
  reference?: EmbeddingReference;
}

function sameFingerprint(
  capability: Awaited<ReturnType<typeof probeNodeCapabilities>>,
  reference: EmbeddingReference,
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

const bootId = randomUUID();
const bootStartedAt = new Date().toISOString();
let sequence = 0;
let stopped = false;
let activeJobs = 0;
let capabilities: Awaited<ReturnType<typeof probeNodeCapabilities>> | null = null;
const stop = (): void => { stopped = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (!stopped) {
  try {
    capabilities = await probeNodeCapabilities();
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

async function heartbeatLoop(): Promise<void> {
  while (!stopped) {
    await sleep(heartbeatMs);
    if (stopped) return;
    try {
      const current = await probeNodeCapabilities();
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
  while (!stopped) {
    try {
      const response = await api<ClaimResponse>(
        `/api/embedding-nodes/${encodeURIComponent(registered.nodeId)}/claims`,
        { limit: 1 },
      );
      const claim = response.claims?.[0];
      if (!claim) {
        await sleep(retryMs);
        continue;
      }
      if (!response.reference) throw new Error('claim response has no embedding reference');
      const before = await probeNodeCapabilities();
      if (!sameFingerprint(before, response.reference)) {
        throw new Error('local model fingerprint differs from claim reference');
      }

      activeJobs++;
      try {
        const vector = await embed(claim.content, {
          priority: 'background',
          strictOllama: true,
        });
        const after = await probeNodeCapabilities();
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
