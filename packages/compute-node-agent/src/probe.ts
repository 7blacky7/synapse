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

/**
 * Wie viel VRAM das EIGENE Modell bereits belegt, in MB.
 *
 * Ollama meldet ueber /api/ps die geladenen Modelle samt size_vram. Nur der
 * Eintrag mit dem eigenen Modellnamen zaehlt — fremde Modelle auf derselben
 * Karte sind fremder Speicher und duerfen den Einstieg sehr wohl blockieren.
 * Faellt die Abfrage aus, wird 0 angenommen: lieber eine Registrierung zu viel
 * ablehnen als eine zu viel zulassen.
 */
async function eigenesModellImVram(): Promise<number> {
  try {
    const ollamaUrl = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
    if (!ollamaUrl) return 0;
    const model = process.env.OLLAMA_MODEL || 'qwen3-embedding:8b';
    const antwort = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(5_000) });
    if (!antwort.ok) return 0;
    const daten = await antwort.json() as { models?: Array<{ name?: string; model?: string; size_vram?: number }> };
    const treffer = (daten.models ?? []).find((eintrag) =>
      eintrag.name === model || eintrag.model === model || (eintrag.name ?? '').startsWith(`${model}:`),
    );
    return treffer?.size_vram ? Math.floor(treffer.size_vram / (1024 * 1024)) : 0;
  } catch {
    return 0;
  }
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

// pruefeEinstieg=true nur bei der ERSTEN Messung vor der Registrierung: dort ist
// die Frage "passt das Modell in den freien Speicher?" richtig. Danach immer
// false — sonst scheitert jede Folgemessung an dem Speicher, den das eigene
// Modell belegt (siehe Kommentar unten bei requiredFreeMb).
export async function probeNodeCapabilities(pruefeEinstieg = false): Promise<NodeCapabilities> {
  // GPU-3: fail-closed und zwingend VOR jedem Ollama-Netzaufruf.
  const gpu = await gpuInfo();
  const requiredFreeMb = envPositiveInt('SYNAPSE_GPU_REQUIRED_FREE_MB', 7300);
  const requiredTotalMb = envPositiveInt('SYNAPSE_GPU_REQUIRED_TOTAL_MB', 12000);

  // ⚠️ DIE FREI-SCHWELLE IST EINE EINSTIEGSBEDINGUNG, KEINE DAUERBEDINGUNG.
  // Sie beantwortet die Frage "passt das Modell ueberhaupt hinein?". Sobald es
  // GELADEN ist, belegt es genau diesen Speicher — die Bedingung kann dann nie
  // wieder erfuellt sein.
  //
  // GEMESSEN 01.08.2026: der Heartbeat rief diese Pruefung alle 30 s auf und
  // scheiterte mit "gemessen 12282 MB gesamt / 1925 MB frei". Der Heartbeat kam
  // damit nie beim Server an (0 Anfragen im Container-Log), letzter_kontakt
  // veraltete auf 167 s, der Knoten galt als 'failed' und bekam auf jeden Claim
  // ein 403 node_not_usable. DER KNOTEN SPERRTE SICH DURCH SEINEN EIGENEN
  // ERFOLG AUS: Modell laden -> VRAM belegt -> Heartbeat kaputt -> keine Arbeit.
  //
  // Deshalb: die harte Schwelle NUR beim Start (pruefeEinstieg=true). Im
  // laufenden Betrieb wird der freie Speicher nur noch GEMELDET; der Server
  // entscheidet anhand von Digest, Dimensionen und Lease, ob der Knoten taugt.
  // ⚠️ AUCH BEIM EINSTIEG ZAEHLT DER SPEICHER MIT, DEN DAS EIGENE MODELL SCHON
  // BELEGT. Sonst scheitert genau der Neustart, der am haeufigsten vorkommt:
  // Agent beendet -> sofort wieder gestartet -> das Modell liegt noch im VRAM
  // (Ollama entlaedt erst nach 5 min Leerlauf) -> "nur 2045 MB frei" -> keine
  // Registrierung. Gemessen am 01.08.2026 nach einem Neustart des Agenten.
  // Die Frage der Einstiegspruefung ist "passt das Modell hinein?", und wenn es
  // bereits DRIN ist, lautet die Antwort offensichtlich ja.
  const belegtVomEigenenModell = pruefeEinstieg ? await eigenesModellImVram() : 0;
  const verfuegbarMb = gpu.freeMb + belegtVomEigenenModell;
  const gpuFehlt = !gpu.name || gpu.totalMb < requiredTotalMb;
  const zuWenigFrei = verfuegbarMb < requiredFreeMb;
  if (gpuFehlt || (pruefeEinstieg && zuWenigFrei)) {
    throw new Error(
      `Hardware passt nicht / nicht moeglich: mindestens ${requiredTotalMb} MB VRAM und ${requiredFreeMb} MB frei erforderlich; ` +
      `gemessen ${gpu.totalMb} MB gesamt / ${gpu.freeMb} MB frei` +
      (belegtVomEigenenModell > 0 ? ` (+${belegtVomEigenenModell} MB bereits vom eigenen Modell belegt)` : ''),
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
