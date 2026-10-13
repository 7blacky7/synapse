import {
  aktivePraefixe,
  API_CONTRACT_VERSION,
  parseComputeNodeExtension,
  computeResourceSnapshot,
  type ComputeNodeExtension,
  type ComputeResources,
  type ComputeCapability,
  embeddingModellName,
  geladenesModellprofil,
  getPool,
  ollamaModellInfo,
  sichereModellprofil,
  zielDimension,
} from '@synapse/core';

export type EmbeddingNodeEffectiveStatus = 'locked' | 'failed' | 'busy' | 'ready';

export interface EmbeddingReferenceContract {
  model: string;
  modelDigest: string | null;
  nativeDimension: number;
  targetDimension: number;
  numCtx: number;
  quantization: string | null;
  requiredTotalVramMb: number;
  requiredFreeVramMb: number;
  /** P15-T8: aus dem Modellprofil - der Knoten liest kein PostgreSQL und uebernimmt sie als Env. */
  queryPraefix: string;
  dokPraefix: string;
  /** null = nicht kalibriert; der Knoten lernt die Grenze dann aus einer Ablehnung von Ollama. */
  maxStueckZeichen: number | null;
}

export interface EmbeddingNodeRegistration extends ComputeNodeExtension {
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

export interface EmbeddingNodeHeartbeat extends ComputeNodeExtension {
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
  node_kind?: 'embedding'|'cpu';
  executor_owner?: string|null;
  contract_version?: number | null;
  features?: string[] | null;
  capability_revision?: string | null;
  policy_revision?: string | null;
  location?: string | null;
  host_resource_domain?: string | null;
  ressourcen?: ComputeResources | null;
  capabilities?: ComputeCapability[] | null;
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

function positiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Referenzvertrag nicht vollstaendig ermittelbar; missing nennt die Felder samt Quelle. */
export class EmbeddingReferenceUnavailable extends Error {
  constructor(public readonly missing: string[]) {
    super(`Embedding-Referenz unvollstaendig: ${missing.join(', ')}`);
  }
}

/**
 * Referenzvertrag fuer GPU-Knoten und Tray (P15-T1).
 *
 * ⚠️ KEINE MODELLWERTE IM CODE (Regel regel-keine-festverdrahteten-modellwerte): hier standen bis zum
 * 11.10.2026 4096/3072/8192/12000/7300 als Rueckfall. Nach dem Wechsel qwen3 -> Nemotron haette der
 * Vertrag ohne passende Env weiter qwen-Werte verlangt und jeden Nemotron-Knoten abgewiesen.
 *
 * Quellen je Feld (Env ausdruecklich vor Ollama des Servers bzw. Core):
 *   model            embeddingModellName()
 *   modelDigest      SYNAPSE_OLLAMA_MODEL_DIGEST | /api/tags (fehlt beides: null -> reference_digest_not_configured)
 *   nativeDimension  SYNAPSE_OLLAMA_NATIVE_DIMENSION | /api/show <arch>.embedding_length
 *   targetDimension  zielDimension() (EMBEDDING_TARGET_DIM | erkannte Dimension des aktiven Modells)
 *   numCtx           EMBEDDING_NUM_CTX | Modellprofil num_ctx | /api/show <arch>.context_length
 *   Praefixe         EMBEDDING_QUERY_PREFIX/_DOC_PREFIX | Modellprofil (P15-T8) - Pflicht
 *   maxStueckZeichen EMBEDDING_MAX_INPUT_CHARS | Profil max_stueck_zeichen | EMBEDDING_NUM_BATCH | Profil num_batch | null
 *   quantization     SYNAPSE_OLLAMA_QUANTIZATION (sonst null = wird nicht verglichen)
 *   VRAM             SYNAPSE_GPU_REQUIRED_TOTAL_MB / _FREE_MB | belegter VRAM (/api/ps, wenn geladen)
 *                    bzw. Modellgroesse (/api/tags) plus SYNAPSE_GPU_RESERVE_MB
 * Fehlt ein Pflichtwert und ist er nicht ermittelbar: EmbeddingReferenceUnavailable statt stillem Default.
 */
export async function getEmbeddingReferenceContract(): Promise<EmbeddingReferenceContract> {
  const env = process.env;
  const envDigest = (env.SYNAPSE_OLLAMA_MODEL_DIGEST ?? '').trim().toLowerCase();
  const nativeEnv = positiveInt(env.SYNAPSE_OLLAMA_NATIVE_DIMENSION);
  const numCtxEnv = positiveInt(env.EMBEDDING_NUM_CTX);
  const totalEnv = positiveInt(env.SYNAPSE_GPU_REQUIRED_TOTAL_MB);
  const freeEnv = positiveInt(env.SYNAPSE_GPU_REQUIRED_FREE_MB);
  // Ollama nur fragen, wenn die Env nicht alles ausdruecklich festlegt.
  const info = !envDigest || !nativeEnv || !numCtxEnv || !totalEnv || !freeEnv ? await ollamaModellInfo() : null;
  const modellBytes = info?.vramBytes ?? info?.groesseBytes ?? null;
  const bedarfMb = modellBytes ? Math.ceil(modellBytes / 1024 / 1024) + (positiveInt(env.SYNAPSE_GPU_RESERVE_MB) ?? 0) : null;
  let targetDimension: number | null = null;
  try {
    targetDimension = await zielDimension();
  } catch { /* unten als fehlend gemeldet */ }

  // P15-T8: dieselben Quellen wie der Core-Provider (Env vor Modellprofil), damit Knoten und Server
  // gleich rechnen. Praefixe fehlen -> der Knoten wuerde falsche Vektoren liefern -> Pflichtfeld.
  let praefixe: { query: string; dokument: string } | null = null;
  try {
    await sichereModellprofil();
    praefixe = aktivePraefixe();
  } catch { /* unten als fehlend gemeldet */ }
  const profil = geladenesModellprofil();
  const maxStueckZeichen = positiveInt(env.EMBEDDING_MAX_INPUT_CHARS) ?? profil?.maxStueckZeichen
    ?? positiveInt(env.EMBEDDING_NUM_BATCH) ?? profil?.numBatch ?? null;

  const nativeDimension = nativeEnv ?? info?.nativeDimension ?? null;
  const numCtx = numCtxEnv ?? profil?.numCtx ?? info?.kontextLaenge ?? null;
  const requiredTotalVramMb = totalEnv ?? bedarfMb;
  const requiredFreeVramMb = freeEnv ?? bedarfMb;
  const missing: string[] = [];
  if (nativeDimension === null) missing.push('nativeDimension (SYNAPSE_OLLAMA_NATIVE_DIMENSION | Ollama /api/show)');
  if (targetDimension === null) missing.push('targetDimension (EMBEDDING_TARGET_DIM | Embedding-Probe)');
  if (numCtx === null) missing.push('numCtx (EMBEDDING_NUM_CTX | Ollama /api/show)');
  if (requiredTotalVramMb === null) missing.push('requiredTotalVramMb (SYNAPSE_GPU_REQUIRED_TOTAL_MB | Ollama /api/ps, /api/tags)');
  if (requiredFreeVramMb === null) missing.push('requiredFreeVramMb (SYNAPSE_GPU_REQUIRED_FREE_MB | Ollama /api/ps, /api/tags)');
  if (praefixe === null) missing.push('praefixe (Modellprofil query_praefix/dok_praefix | EMBEDDING_QUERY_PREFIX/EMBEDDING_DOC_PREFIX)');
  if (missing.length > 0) throw new EmbeddingReferenceUnavailable(missing);

  return {
    model: embeddingModellName(),
    modelDigest: envDigest || info?.digest || null,
    nativeDimension: nativeDimension!,
    targetDimension: targetDimension!,
    numCtx: numCtx!,
    quantization: env.SYNAPSE_OLLAMA_QUANTIZATION?.trim() || null,
    requiredTotalVramMb: requiredTotalVramMb!,
    requiredFreeVramMb: requiredFreeVramMb!,
    queryPraefix: praefixe!.query,
    dokPraefix: praefixe!.dokument,
    maxStueckZeichen,
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
  reference: EmbeddingReferenceContract,
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

/** Legacy-Antwort behält exakt ihre Felder; private Messungen nur nach A1-Verhandlung. */
export function embeddingNodeProjection<T extends EmbeddingNodeRow>(row: T, contract: boolean): Record<string, unknown> {
  const { service_token_hash: _secret, contract_version, features, capability_revision, policy_revision,
    location, host_resource_domain, ressourcen, capabilities, node_kind:_kind, executor_owner:_owner, ...legacy } = row;
  if (!contract) return legacy;
  return { ...legacy, contractVersion: contract_version ?? API_CONTRACT_VERSION, features: features ?? [],
    capabilityRevision: capability_revision === null || capability_revision === undefined ? null : Number(capability_revision),
    policyRevision: policy_revision === null || policy_revision === undefined ? null : Number(policy_revision),
    location: location ?? null, hostResourceDomain: host_resource_domain ?? null,
    executorOwner: _owner ?? null, bootGeneration: row.boot_id,
    resources: computeResourceSnapshot(ressourcen), capabilities: capabilities ?? [] };
}

export async function registerEmbeddingNode(
  tokenHash: string,
  input: EmbeddingNodeRegistration,
  db: Queryable = getPool(),
): Promise<EmbeddingNodeRow | null> {
  const extension = parseComputeNodeExtension(input, input.nodeId);
  const result = await db.query<EmbeddingNodeRow>(
    `INSERT INTO embedding_knoten (
       node_id, host, ollama_url, modell, modell_digest, quantisierung,
       native_dimension, ziel_dimension, num_ctx, vram_gesamt_mb, vram_frei_mb,
       system_memory_mb, cpu_cores, gpu_name, max_concurrency, active_jobs,
       status, service_token_hash, agent_version, boot_id, last_sequence, boot_started_at,
       letzter_kontakt, aktualisiert_am, contract_version, features, capability_revision,
       policy_revision, location, host_resource_domain, ressourcen, capabilities
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,'ready',$16,$17,$18,0,$19,NOW(),NOW(),
       ($20::jsonb->>'contractVersion')::integer,
       CASE WHEN $20::jsonb ? 'features' THEN ARRAY(SELECT jsonb_array_elements_text($20::jsonb->'features')) END,
       ($20::jsonb->>'capabilityRevision')::bigint, ($20::jsonb->>'policyRevision')::bigint,
       $20::jsonb->>'location', $20::jsonb->>'hostResourceDomain', $20::jsonb->'resources', $20::jsonb->'capabilities'
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
       letzter_kontakt=NOW(), aktualisiert_am=NOW(),
       contract_version=COALESCE(EXCLUDED.contract_version,embedding_knoten.contract_version),
       features=COALESCE(EXCLUDED.features,embedding_knoten.features),
       capability_revision=COALESCE(EXCLUDED.capability_revision,embedding_knoten.capability_revision),
       policy_revision=COALESCE(EXCLUDED.policy_revision,embedding_knoten.policy_revision),
       location=COALESCE(EXCLUDED.location,embedding_knoten.location),
       host_resource_domain=COALESCE(EXCLUDED.host_resource_domain,embedding_knoten.host_resource_domain),
       ressourcen=COALESCE(EXCLUDED.ressourcen,embedding_knoten.ressourcen),
       capabilities=COALESCE(EXCLUDED.capabilities,embedding_knoten.capabilities)
     WHERE embedding_knoten.modell IS NOT NULL AND (embedding_knoten.boot_started_at <= EXCLUDED.boot_started_at
        OR embedding_knoten.letzter_kontakt < NOW() - INTERVAL '2 minutes')
     RETURNING *`,
    [
      input.nodeId, input.host, input.ollamaUrl, input.model, normalizeDigest(input.modelDigest),
      input.quantization ?? null, input.nativeDimension, input.targetDimension, input.numCtx,
      input.vramTotalMb, input.vramFreeMb, input.systemMemoryMb ?? null, input.cpuCores ?? null,
      input.gpuName ?? null, input.maxConcurrency, tokenHash, input.agentVersion ?? null,
      input.bootId, new Date(input.bootStartedAt), JSON.stringify(extension ?? {}),
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
            letzter_kontakt=NOW(), aktualisiert_am=NOW(),
            contract_version=COALESCE(($14::jsonb->>'contractVersion')::integer,contract_version),
            features=CASE WHEN $14::jsonb ? 'features' THEN ARRAY(SELECT jsonb_array_elements_text($14::jsonb->'features')) ELSE features END,
            capability_revision=COALESCE(($14::jsonb->>'capabilityRevision')::bigint,capability_revision),
            policy_revision=COALESCE(($14::jsonb->>'policyRevision')::bigint,policy_revision),
            location=COALESCE($14::jsonb->>'location',location),
            host_resource_domain=COALESCE($14::jsonb->>'hostResourceDomain',host_resource_domain),
            ressourcen=COALESCE($14::jsonb->'resources',ressourcen),
            capabilities=COALESCE($14::jsonb->'capabilities',capabilities)
      WHERE node_id=$1 AND service_token_hash=$2 AND boot_id=$3 AND last_sequence < $4
        AND modell=$8 AND modell_digest=$9 AND native_dimension=$10
        AND ziel_dimension=$11 AND num_ctx=$12
        AND quantisierung IS NOT DISTINCT FROM $13
      RETURNING *`,
    [nodeId, tokenHash, heartbeat.bootId, heartbeat.sequence,
      heartbeat.status, heartbeat.vramFreeMb, heartbeat.activeJobs,
      heartbeat.model, normalizeDigest(heartbeat.modelDigest), heartbeat.nativeDimension,
      heartbeat.targetDimension, heartbeat.numCtx, heartbeat.quantization ?? null,
      JSON.stringify(parseComputeNodeExtension(heartbeat, nodeId) ?? {})],
  );
  return result.rows[0] ?? null;
}

export async function listEmbeddingNodes(
  db: Queryable = getPool(),
  nowMs?: number,
): Promise<Array<EmbeddingNodeRow & { effectiveStatus: EmbeddingNodeEffectiveStatus; usable: boolean; compatibilityProblems: string[] }>> {
  const result = await db.query<EmbeddingNodeRow>('SELECT *, NOW() AS server_now FROM embedding_knoten WHERE modell IS NOT NULL AND modell_digest IS NOT NULL AND ollama_url IS NOT NULL AND native_dimension IS NOT NULL AND ziel_dimension IS NOT NULL AND num_ctx IS NOT NULL AND vram_gesamt_mb IS NOT NULL AND vram_frei_mb IS NOT NULL ORDER BY node_id');
  const reference = await getEmbeddingReferenceContract();
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
    // ⚠️ NUR DIE KAPAZITAET IST EINE DAUERBEDINGUNG.
    // Hier stand zusaetzlich `row.vram_frei_mb < reference.requiredFreeVramMb`.
    // Das ist eine EINSTIEGSbedingung ("passt das Modell ueberhaupt hinein?")
    // und im Dauerbetrieb unerfuellbar: sobald der Knoten das Modell GELADEN hat,
    // belegt es genau diesen Speicher.
    // GEMESSEN 01.08.2026 an einer RTX 4070 Ti: 12.282 MB gesamt, nach dem Laden
    // 1.925 MB frei bei geforderten 7.300. Folge: insufficient_free_vram ->
    // usable=false -> 403 auf JEDEN Claim, dauerhaft. Der Knoten sperrte sich
    // durch seinen eigenen Erfolg aus, und die Lastverteilung blieb wirkungslos.
    // Die Frei-Schwelle gehoert an die Registrierung (dort prueft sie der Agent
    // vor dem Start) — nicht in eine Bedingung, die bei jedem Claim neu gilt.
    if (row.vram_gesamt_mb < reference.requiredTotalVramMb) {
      problems.push('insufficient_total_vram');
    }
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

/**
 * P15-T9: Wie viele Claims ein Knoten gleichzeitig halten (und je Runde als EINEN Stapel einbetten)
 * darf. Der Server entscheidet: SYNAPSE_NODE_MAX_CLAIMS ist die Obergrenze; ein Knoten darf weniger
 * verlangen (seine Env SYNAPSE_NODE_MAX_CONCURRENCY). Hier stand nichts, und der Knoten nahm fest 2
 * (gemessen 11.10.2026: 216 Chunks/min; mit 8 per Env 1020 Chunks/min).
 * Ist weder Obergrenze noch Wunsch gesetzt, gibt es keinen erfundenen Wert: null -> der Aufrufer
 * lehnt die Registrierung mit node_capacity_not_configured ab.
 */
export function authorizedNodeCapacity(requested: number | null | undefined): number | null {
  const serverMax = positiveInt(process.env.SYNAPSE_NODE_MAX_CLAIMS);
  const wunsch = Number.isInteger(requested) && (requested as number) > 0 ? (requested as number) : null;
  if (serverMax !== null && wunsch !== null) return Math.min(serverMax, wunsch);
  return serverMax ?? wunsch;
}

/**
 * P15-T9: Gibt Claims eines Knotens frei (geordnetes Beenden des Helfers, abgelehnte Stapel-Eintraege).
 * Wirkt nur auf Chunks, die dieser Knoten mit genau diesem Token haelt und die noch nicht fertig sind -
 * ein Nachzuegler hebt nie den Claim eines anderen auf. Ohne Freigabe blieben sie bis zum Lease-Ende
 * (bis 15 min) blockiert.
 */
export async function releaseEmbeddingClaims(
  nodeId: string,
  claims: Array<{ chunkId: string; claimToken: string }>,
  db: Queryable = getPool(),
): Promise<string[]> {
  if (claims.length === 0) return [];
  const result = await db.query<{ id: string }>(
    `UPDATE code_chunks c
        SET claimed_by = NULL, claim_token = NULL, lease_until = NULL
       FROM unnest($2::text[], $3::text[]) AS u(id, token)
      WHERE c.id::text = u.id AND c.claim_token = u.token AND c.claimed_by = $1 AND c.embedded_at IS NULL
      RETURNING c.id::text AS id`,
    [nodeId, claims.map((c) => String(c.chunkId)), claims.map((c) => c.claimToken)],
  );
  return result.rows.map((r) => String(r.id));
}

