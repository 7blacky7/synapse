import { getConfig, getPool } from '@synapse/core';

export type EmbeddingNodeEffectiveStatus = 'locked' | 'failed' | 'busy' | 'ready';

export interface EmbeddingReferenceContract {
  model: string;
  modelDigest: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
  quantization: string | null;
}

export interface EmbeddingNodeRegistration {
  nodeId: string;
  host: string;
  ollamaUrl: string;
  model: string;
  modelDigest: string;
  quantization?: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
  vramTotalMb: number;
  vramFreeMb: number;
  systemMemoryMb?: number | null;
  cpuCores?: number | null;
  gpuName?: string | null;
  maxConcurrency: number;
  agentVersion?: string | null;
  bootId: string;
  bootStartedAt: string;
}

export interface EmbeddingNodeHeartbeat {
  status: 'ready' | 'busy';
  vramFreeMb: number;
  activeJobs: number;
  bootId: string;
  sequence: number;
  model: string;
  modelDigest: string;
  quantization?: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
}

export interface EmbeddingNodeRow {
  node_id: string;
  host: string;
  ollama_url: string;
  modell: string;
  modell_digest: string;
  quantisierung: string | null;
  native_dimension: number;
  ziel_dimension: number;
  num_ctx: number;
  vram_gesamt_mb: number;
  vram_frei_mb: number;
  system_memory_mb: number | null;
  cpu_cores: number | null;
  gpu_name: string | null;
  max_concurrency: number;
  active_jobs: number;
  status: 'ready' | 'busy' | 'locked' | 'failed';
  gesperrt_vom_user: boolean;
  sperrgrund: string | null;
  service_token_hash: string;
  agent_version: string | null;
  boot_id: string;
  last_sequence: number;
  boot_started_at: Date;
  server_now?: Date;
  registriert_am: Date;
  letzter_kontakt: Date;
  aktualisiert_am: Date;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getEmbeddingReferenceContract(): EmbeddingReferenceContract {
  const digest = (process.env.SYNAPSE_OLLAMA_MODEL_DIGEST ?? '').trim().toLowerCase();
  return {
    model: process.env.OLLAMA_MODEL || getConfig().embeddings.ollama.model,
    modelDigest: digest || null,
    nativeDimension: positiveInt(process.env.SYNAPSE_OLLAMA_NATIVE_DIMENSION, 4096),
    targetDimension: positiveInt(process.env.EMBEDDING_TARGET_DIM, 3072),
    numCtx: positiveInt(process.env.EMBEDDING_NUM_CTX, 8192),
    quantization: process.env.SYNAPSE_OLLAMA_QUANTIZATION?.trim() || null,
  };
}

export function normalizeDigest(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '');
}

export function validateNodeId(nodeId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(nodeId);
}

/** Registry-Validierung fuer reine Metadaten; auch Node-lokaler Loopback ist erlaubt. */
export function validateOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function compatibilityProblems(
  node: Pick<EmbeddingNodeRegistration, 'model' | 'modelDigest' | 'nativeDimension' | 'targetDimension' | 'numCtx' | 'quantization'>,
  reference = getEmbeddingReferenceContract(),
): string[] {
  const problems: string[] = [];
  const digest = normalizeDigest(typeof node.modelDigest === 'string' ? node.modelDigest : '');
  const expectedDigest = reference.modelDigest ? normalizeDigest(reference.modelDigest) : null;
  if (!/^[a-f0-9]{64}$/.test(digest)) problems.push('model_digest_not_full_sha256');
  if (!expectedDigest) problems.push('reference_digest_not_configured');
  else if (digest !== expectedDigest) problems.push('model_digest_mismatch');
  if (node.model !== reference.model) problems.push('model_mismatch');
  if (node.nativeDimension !== reference.nativeDimension) problems.push('native_dimension_mismatch');
  if (node.targetDimension !== reference.targetDimension) problems.push('target_dimension_mismatch');
  if (node.numCtx !== reference.numCtx) problems.push('num_ctx_mismatch');
  if (reference.quantization && node.quantization !== reference.quantization) {
    problems.push('quantization_mismatch');
  }
  return problems;
}

export function deriveEmbeddingNodeStatus(
  row: Pick<EmbeddingNodeRow, 'gesperrt_vom_user' | 'status' | 'letzter_kontakt'>,
  nowMs = Date.now(),
  ttlMs = 120_000,
): EmbeddingNodeEffectiveStatus {
  if (row.gesperrt_vom_user) return 'locked';
  if (nowMs - new Date(row.letzter_kontakt).getTime() > ttlMs) return 'failed';
  return row.status === 'busy' ? 'busy' : 'ready';
}

export async function registerEmbeddingNode(
  tokenHash: string,
  input: EmbeddingNodeRegistration,
  db: Queryable = getPool(),
): Promise<EmbeddingNodeRow | null> {
  const result = await db.query<EmbeddingNodeRow>(
    `INSERT INTO embedding_knoten (
       node_id, host, ollama_url, modell, modell_digest, quantisierung,
       native_dimension, ziel_dimension, num_ctx, vram_gesamt_mb, vram_frei_mb,
       system_memory_mb, cpu_cores, gpu_name, max_concurrency, active_jobs,
       status, service_token_hash, agent_version, boot_id, last_sequence, boot_started_at,
       letzter_kontakt, aktualisiert_am
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,'ready',$16,$17,$18,0,$19,NOW(),NOW()
     )
     ON CONFLICT (node_id) DO UPDATE SET
       host=EXCLUDED.host, ollama_url=EXCLUDED.ollama_url, modell=EXCLUDED.modell,
       modell_digest=EXCLUDED.modell_digest, quantisierung=EXCLUDED.quantisierung,
       native_dimension=EXCLUDED.native_dimension, ziel_dimension=EXCLUDED.ziel_dimension,
       num_ctx=EXCLUDED.num_ctx, vram_gesamt_mb=EXCLUDED.vram_gesamt_mb,
       vram_frei_mb=EXCLUDED.vram_frei_mb, system_memory_mb=EXCLUDED.system_memory_mb,
       cpu_cores=EXCLUDED.cpu_cores, gpu_name=EXCLUDED.gpu_name,
       max_concurrency=EXCLUDED.max_concurrency, active_jobs=0, status='ready',
       service_token_hash=EXCLUDED.service_token_hash, agent_version=EXCLUDED.agent_version,
       boot_id=EXCLUDED.boot_id, last_sequence=0, boot_started_at=EXCLUDED.boot_started_at,
       letzter_kontakt=NOW(), aktualisiert_am=NOW()
     WHERE embedding_knoten.boot_started_at <= EXCLUDED.boot_started_at
        OR embedding_knoten.letzter_kontakt < NOW() - INTERVAL '2 minutes'
     RETURNING *`,
    [
      input.nodeId, input.host, input.ollamaUrl, input.model, normalizeDigest(input.modelDigest),
      input.quantization ?? null, input.nativeDimension, input.targetDimension, input.numCtx,
      input.vramTotalMb, input.vramFreeMb, input.systemMemoryMb ?? null, input.cpuCores ?? null,
      input.gpuName ?? null, input.maxConcurrency, tokenHash, input.agentVersion ?? null,
      input.bootId, new Date(input.bootStartedAt),
    ],
  );
  return result.rows[0] ?? null;
}

export async function heartbeatEmbeddingNode(
  nodeId: string,
  tokenHash: string,
  heartbeat: EmbeddingNodeHeartbeat,
  db: Queryable = getPool(),
): Promise<EmbeddingNodeRow | null> {
  const result = await db.query<EmbeddingNodeRow>(
    `UPDATE embedding_knoten
        SET status=$5, vram_frei_mb=$6, active_jobs=$7, last_sequence=$4,
            letzter_kontakt=NOW(), aktualisiert_am=NOW()
      WHERE node_id=$1 AND service_token_hash=$2 AND boot_id=$3 AND last_sequence < $4
        AND modell=$8 AND modell_digest=$9 AND native_dimension=$10
        AND ziel_dimension=$11 AND num_ctx=$12
        AND quantisierung IS NOT DISTINCT FROM $13
      RETURNING *`,
    [nodeId, tokenHash, heartbeat.bootId, heartbeat.sequence,
      heartbeat.status, heartbeat.vramFreeMb, heartbeat.activeJobs,
      heartbeat.model, normalizeDigest(heartbeat.modelDigest), heartbeat.nativeDimension,
      heartbeat.targetDimension, heartbeat.numCtx, heartbeat.quantization ?? null],
  );
  return result.rows[0] ?? null;
}

export async function listEmbeddingNodes(
  db: Queryable = getPool(),
  nowMs?: number,
): Promise<Array<EmbeddingNodeRow & { effectiveStatus: EmbeddingNodeEffectiveStatus; usable: boolean; compatibilityProblems: string[] }>> {
  const result = await db.query<EmbeddingNodeRow>('SELECT *, NOW() AS server_now FROM embedding_knoten ORDER BY node_id');
  const reference = getEmbeddingReferenceContract();
  return result.rows.map((row) => {
    const problems = compatibilityProblems({
      model: row.modell,
      modelDigest: row.modell_digest,
      nativeDimension: row.native_dimension,
      targetDimension: row.ziel_dimension,
      numCtx: row.num_ctx,
      quantization: row.quantisierung,
    }, reference);
    const effectiveStatus = deriveEmbeddingNodeStatus(
      row,
      nowMs ?? new Date(row.server_now ?? Date.now()).getTime(),
    );
    return {
      ...row,
      effectiveStatus,
      usable: problems.length === 0 && (effectiveStatus === 'ready' || effectiveStatus === 'busy'),
      compatibilityProblems: problems,
    };
  });
}

export async function setEmbeddingNodeLock(
  nodeId: string,
  locked: boolean,
  reason: string | null,
  db: Queryable = getPool(),
): Promise<EmbeddingNodeRow | null> {
  const result = await db.query<EmbeddingNodeRow>(
    `UPDATE embedding_knoten
        SET gesperrt_vom_user=$2, sperrgrund=CASE WHEN $2 THEN $3 ELSE NULL END,
            aktualisiert_am=NOW()
      WHERE node_id=$1
      RETURNING *`,
    [nodeId, locked, reason],
  );
  return result.rows[0] ?? null;
}
