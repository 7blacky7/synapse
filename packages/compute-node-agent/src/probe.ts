import os from 'node:os';
import {existsSync} from 'node:fs';
import type {ComputeNodeExtension} from '@synapse/core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NodeCapabilities extends ComputeNodeExtension {
  deviceId?: string;
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
  /** P15-T9: nur ein WUNSCH (SYNAPSE_NODE_MAX_CONCURRENCY); fehlt er, legt der Server die Stapelgroesse fest. */
  maxConcurrency?: number;
  agentVersion: string;
}

interface OllamaTag {
  name: string;
  model?: string;
  digest: string;
  details?: { quantization_level?: string };
}

/**
 * Referenzvertrag der API (GET /api/embedding-nodes/reference, P15-T1). EINZIGE Quelle fuer Modell,
 * Zieldimension, num_ctx und VRAM-Bedarf des Knotens — keine eigenen Defaults (Regel
 * regel-keine-festverdrahteten-modellwerte). Bis zum 11.10.2026 standen hier qwen3-embedding:8b,
 * 3072, 8192 und 12000/7300 MB als Rueckfall; nach dem Wechsel auf Nemotron haette ein Knoten ohne
 * passende Env mit Altwerten registriert und waere (zu Recht) abgewiesen worden.
 */
export interface EmbeddingReference {
  model: string;
  modelDigest: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
  quantization: string | null;
  requiredTotalVramMb: number;
  requiredFreeVramMb: number;
  /** P15-T8: Praefixe und Stueckgroesse aus dem Modellprofil der API (der Knoten liest kein PG). */
  queryPraefix: string;
  dokPraefix: string;
  maxStueckZeichen: number | null;
}

function envPositiveInt(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
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
async function eigenesModellImVram(model: string): Promise<number> {
  try {
    const ollamaUrl = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
    if (!ollamaUrl) return 0;
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

export async function gpuInfo(): Promise<{ name: string | null; deviceId:string|null; utilization:number|null;totalMb: number; freeMb: number }> {
  try {
    const gpuIndex = process.env.SYNAPSE_GPU_INDEX;
    if (!gpuIndex || !/^\d+$/.test(gpuIndex)) throw new Error('SYNAPSE_GPU_INDEX must select exactly one GPU');
    const { stdout } = await execFileAsync('nvidia-smi', [
      `--id=${gpuIndex}`,
      '--query-gpu=name,memory.total,memory.free,uuid,utilization.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 });
    const rows=stdout.trim().split('\n');if(rows.length!==1)throw Error('GPU selection is ambiguous');
    const [name,total,free,deviceId,load]=rows[0].split(',').map(v=>v.trim());
    const utilization=Number(load);
    return {name:name||null,deviceId:deviceId?.startsWith('GPU-')?deviceId:null,
      utilization:Number.isFinite(utilization)&&utilization>=0&&utilization<=100?utilization:null,totalMb:Number(total)||0,freeMb:Number(free)||0};
  } catch {
    return { name: null, deviceId:null, utilization:null,totalMb: 0, freeMb: 0 };
  }
}


let previousCpu:{idle:number;total:number}|undefined;
/** Deltalast statt Load-Average; fehlende Messung bleibt unknown. */
export async function probeResourceReport(model:string,gpu?:Awaited<ReturnType<typeof gpuInfo>>):Promise<NonNullable<ComputeNodeExtension['resources']>>{
 const current=gpu??await gpuInfo(),at=new Date().toISOString();
 const container=existsSync('/.dockerenv')||existsSync('/run/.containerenv')||!!process.env.container;
 const cpu=os.cpus().reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((n,v)=>n+v,0)}),{idle:0,total:0});
 const before=previousCpu;previousCpu=cpu;
 const load=before&&cpu.total>before.total?100*(1-(cpu.idle-before.idle)/(cpu.total-before.total)):null;
 const measurement=(value:number|null,scope:'host'|'device'|'container')=>({value,scope,measuredAt:value===null?null:at,quality:value===null?'unknown' as const:'measured' as const});
 const own=await eigenesModellImVramBeobachtet(model);
 return {
  cpu:{cores:measurement(container?null:os.cpus().length,'host'),loadPercent:measurement(container?null:load===null?null:Math.max(0,Math.min(100,load)),'host')},
  ram:{totalMb:measurement(container?null:Math.floor(os.totalmem()/1048576),'host'),availableMb:measurement(container?null:Math.floor(os.freemem()/1048576),'host')},
  gpus:current.deviceId?[{deviceId:current.deviceId,origin:'nvidia-smi',totalMb:measurement(current.totalMb,'device'),
   freeMb:measurement(current.freeMb,'device'),residentOwnModelMb:measurement(own,'device'),utilizationPercent:measurement(current.utilization,'device')}]:[],
 };
}
async function eigenesModellImVramBeobachtet(model:string):Promise<number|null>{
 try{
  const r=await fetch(lokaleOllamaUrl()+'/api/ps',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)return null;
  const p=await r.json() as {models?:Array<{name?:string;model?:string;size_vram?:number}>};
  if(!Array.isArray(p.models))return null;
  const normal=(s:string)=>s.includes(':')?s:s+':latest';
  const entry=p.models.find(m=>normal(m.model??m.name??'')===normal(model));
  return entry?typeof entry.size_vram==='number'&&entry.size_vram>=0?Math.floor(entry.size_vram/1048576):null:0;
 }catch{return null;}
}

/** OLLAMA_URL, nur strikt lokal (loopback HTTP). */
function lokaleOllamaUrl(): string {
  const ollamaUrl = (process.env.OLLAMA_URL || '').replace(/\/$/, '');
  let parsedOllama: URL;
  try { parsedOllama = new URL(ollamaUrl); } catch { throw new Error('OLLAMA_URL must be a loopback URL'); }
  if (parsedOllama.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsedOllama.hostname)) {
    throw new Error('OLLAMA_URL must be strict loopback HTTP');
  }
  return ollamaUrl;
}

async function ollamaTag(ollamaUrl: string, model: string): Promise<OllamaTag> {
  const tagsResponse = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!tagsResponse.ok) throw new Error(`Ollama tags failed: ${tagsResponse.status}`);
  const tags = await tagsResponse.json() as { models: OllamaTag[] };
  const tag = tags.models.find((item) =>
    item.name === model || item.model === model || item.name.startsWith(`${model}:`),
  );
  if (!tag?.digest) throw new Error(`Ollama model or full digest missing: ${model}`);
  return tag;
}

/**
 * P15-T11: Nur der volle Digest des lokalen Modells (ein /api/tags, wenige ms, kein nvidia-smi).
 * Der Knoten prueft damit nach JEDEM Stapel, dass das Modell waehrend des Rechnens nicht gewechselt
 * hat; die volle Messung (probeNodeCapabilities) laeuft nur noch beim Start, periodisch und nach Fehlern.
 * Ein anderes Modell, eine andere Quantisierung oder Dimension hat immer einen anderen Digest.
 */
export async function lokalerModellDigest(model: string): Promise<string> {
  return (await ollamaTag(lokaleOllamaUrl(), model)).digest;
}

// pruefeEinstieg=true nur bei der ERSTEN Messung vor der Registrierung: dort ist
// die Frage "passt das Modell in den freien Speicher?" richtig. Danach immer
// false — sonst scheitert jede Folgemessung an dem Speicher, den das eigene
// Modell belegt (siehe Kommentar unten bei requiredFreeMb).
export async function probeNodeCapabilities(
  reference: EmbeddingReference,
  pruefeEinstieg = false,
): Promise<NodeCapabilities> {
  // GPU-3: fail-closed und zwingend VOR jedem Ollama-Netzaufruf.
  const gpu = await gpuInfo();
  // P15-T6: Bedarf und Modell aus dem Referenzvertrag, nicht aus eigenen Defaults.
  const requiredFreeMb = reference.requiredFreeVramMb;
  const requiredTotalMb = reference.requiredTotalVramMb;
  const model = reference.model;

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
  const belegtVomEigenenModell = pruefeEinstieg ? await eigenesModellImVram(model) : 0;
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
  const ollamaUrl = lokaleOllamaUrl();
  const tag = await ollamaTag(ollamaUrl, model);

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
    // Zieldimension und num_ctx sind Vorgaben des Vertrags; index.ts setzt sie fuer core/embed()
    // in die Env (EMBEDDING_TARGET_DIM, EMBEDDING_NUM_CTX), damit gemeldet = gerechnet gilt.
    targetDimension: reference.targetDimension,
    numCtx: reference.numCtx,
    contractVersion:1,features:['compute_resources','compute_control'],
    ...(gpu.deviceId?{deviceId:gpu.deviceId}:{}),
    resources:await probeResourceReport(model,gpu),
    vramTotalMb: gpu.totalMb,
    vramFreeMb: gpu.freeMb,
    systemMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    cpuCores: os.cpus().length,
    gpuName: gpu.name,
    // P15-T9: hier stand ein fester Default 2 (216 Chunks/min); jetzt Wunsch oder Server-Vorgabe.
    maxConcurrency: envPositiveInt('SYNAPSE_NODE_MAX_CONCURRENCY'),
    agentVersion: '0.1.0',
  };
}
