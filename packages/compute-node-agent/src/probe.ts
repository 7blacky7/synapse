import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NodeCapabilities {
  nodeId: string;
  host: string;
  ollamaUrl: string;
  model: string;
  modelDigest: string;
  quantization: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
  vramTotalMb: number;
  vramFreeMb: number;
  systemMemoryMb: number;
  cpuCores: number;
  gpuName: string | null;
  maxConcurrency: number;
  agentVersion: string;
}

interface OllamaTag {
  name: string;
  model?: string;
  digest: string;
  details?: { quantization_level?: string };
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function gpuInfo(): Promise<{ name: string | null; totalMb: number; freeMb: number }> {
  try {
    const gpuIndex = process.env.SYNAPSE_GPU_INDEX;
    if (!gpuIndex || !/^\d+$/.test(gpuIndex)) throw new Error('SYNAPSE_GPU_INDEX must select exactly one GPU');
    const { stdout } = await execFileAsync('nvidia-smi', [
      `--id=${gpuIndex}`,
      '--query-gpu=name,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 });
    const [name, total, free] = stdout.trim().split('\n')[0].split(',').map((v) => v.trim());
    return { name: name || null, totalMb: Number(total) || 0, freeMb: Number(free) || 0 };
  } catch {
    return { name: null, totalMb: 0, freeMb: 0 };
  }
}

export async function probeNodeCapabilities(): Promise<NodeCapabilities> {
  // GPU-3: fail-closed und zwingend VOR jedem Ollama-Netzaufruf.
  const gpu = await gpuInfo();
  const requiredFreeMb = envPositiveInt('SYNAPSE_GPU_REQUIRED_FREE_MB', 7300);
  const requiredTotalMb = envPositiveInt('SYNAPSE_GPU_REQUIRED_TOTAL_MB', 12000);
  if (!gpu.name || gpu.totalMb < requiredTotalMb || gpu.freeMb < requiredFreeMb) {
    throw new Error(
      `Hardware passt nicht / nicht moeglich: mindestens ${requiredTotalMb} MB VRAM und ${requiredFreeMb} MB frei erforderlich; ` +
      `gemessen ${gpu.totalMb} MB gesamt / ${gpu.freeMb} MB frei`,
    );
  }
  const ollamaUrl = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
  let parsedOllama: URL;
  try { parsedOllama = new URL(ollamaUrl); } catch { throw new Error('OLLAMA_URL must be a loopback URL'); }
  if (parsedOllama.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsedOllama.hostname)) {
    throw new Error('OLLAMA_URL must be strict loopback HTTP');
  }
  const model = process.env.OLLAMA_MODEL || 'qwen3-embedding:8b';
  const tagsResponse = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!tagsResponse.ok) throw new Error(`Ollama tags failed: ${tagsResponse.status}`);
  const tags = await tagsResponse.json() as { models: OllamaTag[] };
  const tag = tags.models.find((item) =>
    item.name === model || item.model === model || item.name.startsWith(`${model}:`),
  );
  if (!tag?.digest) throw new Error(`Ollama model or full digest missing: ${model}`);

  const showResponse = await fetch(`${ollamaUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!showResponse.ok) throw new Error(`Ollama show failed: ${showResponse.status}`);
  const show = await showResponse.json() as {
    details?: { quantization_level?: string };
    model_info?: Record<string, unknown>;
  };
  const embeddingLength = Object.entries(show.model_info ?? {})
    .find(([key, value]) => key.endsWith('.embedding_length') && Number.isInteger(value))?.[1];
  if (!Number.isInteger(embeddingLength) || Number(embeddingLength) <= 0) {
    throw new Error('Ollama model_info has no embedding_length');
  }

  return {
    nodeId: process.env.SYNAPSE_NODE_ID || os.hostname().toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    host: os.hostname(),
    ollamaUrl,
    model,
    modelDigest: tag.digest,
    quantization: show.details?.quantization_level || tag.details?.quantization_level || null,
    nativeDimension: Number(embeddingLength),
    targetDimension: envPositiveInt('EMBEDDING_TARGET_DIM', 3072),
    numCtx: envPositiveInt('EMBEDDING_NUM_CTX', 8192),
    vramTotalMb: gpu.totalMb,
    vramFreeMb: gpu.freeMb,
    systemMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    cpuCores: os.cpus().length,
    gpuName: gpu.name,
    maxConcurrency: envPositiveInt('SYNAPSE_NODE_MAX_CONCURRENCY', 2),
    agentVersion: '0.1.0',
  };
}
