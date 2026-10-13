import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  getPool,
  API_CONTRACT_HEADER,
  apiCapabilitiesForClient,
  parseComputeNodeExtension,
  claimEmbeddingChunks,
  completeEmbeddingClaim,
  completeEmbeddingClaims,
  ollamaModellInfo,
  registriereWorker,
  workerPausiert,
  meldeWorkerArbeit,
} from '@synapse/core';
import { validateToken, type AuthTokenRow } from '../services/auth.js';
import {
  authorizedNodeCapacity,
  embeddingNodeProjection,
  compatibilityProblems,
  EmbeddingReferenceUnavailable,
  releaseEmbeddingClaims,
  getEmbeddingReferenceContract,
  heartbeatEmbeddingNode,
  listEmbeddingNodes,
  normalizeDigest,
  registerEmbeddingNode,
  setEmbeddingNodeLock,
  validateNodeId,
  validateOllamaUrl,
  type EmbeddingNodeHeartbeat,
  type EmbeddingNodeRegistration,
  type EmbeddingNodeRow,
  type EmbeddingReferenceContract,
  type Queryable,
} from '../services/embedding-nodes.js';

interface EmbeddingNodeRouteDependencies {
  validateToken: (token: string) => Promise<AuthTokenRow | null>;
  db: Queryable;
}

function bearer(request: FastifyRequest): string | null {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string') return null;
  return /^Bearer\s+(.+)$/i.exec(raw.trim())?.[1]?.trim() ?? null;
}

async function principal(
  request: FastifyRequest,
  deps: EmbeddingNodeRouteDependencies,
): Promise<AuthTokenRow | null> {
  const token = bearer(request);
  return token ? deps.validateToken(token) : null;
}

function tokenAllowsNode(row: AuthTokenRow | null, nodeId: string): boolean {
  return row?.kind === 'service' && row.scope === `compute-node:${nodeId}`;
}

async function usableNode(
  auth: AuthTokenRow | null,
  nodeId: string,
  deps: EmbeddingNodeRouteDependencies,
) {
  if (!tokenAllowsNode(auth, nodeId)) return null;
  const nodes = await listEmbeddingNodes(deps.db);
  return nodes.find((node) =>
    node.node_id === nodeId &&
    node.service_token_hash === auth!.token_hash &&
    node.usable
  ) ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validRegistration(input: EmbeddingNodeRegistration): boolean {
  const bootStartedMs = Date.parse(input.bootStartedAt);
  return validateNodeId(input.nodeId) && input.host?.trim().length > 0 && input.host.length <= 255 &&
    input.model?.trim().length > 0 && input.model.length <= 200 &&
    typeof input.modelDigest === 'string' && validateOllamaUrl(input.ollamaUrl) &&
    UUID_RE.test(input.bootId) && Number.isFinite(bootStartedMs) &&
    bootStartedMs <= Date.now() + 5 * 60_000 &&
    Number.isInteger(input.nativeDimension) && input.nativeDimension > 0 &&
    Number.isInteger(input.targetDimension) && input.targetDimension > 0 &&
    Number.isInteger(input.numCtx) && input.numCtx > 0 &&
    Number.isInteger(input.vramTotalMb) && input.vramTotalMb >= 0 &&
    Number.isInteger(input.vramFreeMb) && input.vramFreeMb >= 0 && input.vramFreeMb <= input.vramTotalMb &&
    // P15-T9: maxConcurrency ist ein WUNSCH des Knotens und darf fehlen - dann entscheidet der Server
    // (SYNAPSE_NODE_MAX_CLAIMS, authorizedNodeCapacity).
    (input.maxConcurrency === undefined || input.maxConcurrency === null ||
      (Number.isInteger(input.maxConcurrency) && input.maxConcurrency > 0));
}

/** Hoechstzahl Eintraege je Stapel-Abschluss/-Freigabe - dieselbe Grenze wie limit beim Claimen. */
const MAX_STAPEL = 100;

interface KnotenFingerprint {
  model?: string;
  modelDigest?: string;
  quantization?: string | null;
  nativeDimension?: number;
  targetDimension?: number;
  numCtx?: number;
}

/**
 * Prueft den Modell-Fingerabdruck eines Abschlusses gegen Registry-Eintrag UND Referenzvertrag.
 * null = in Ordnung; sonst die Problemliste (leer bei reinem Registry-Abweichen).
 */
function fingerprintProbleme(
  f: KnotenFingerprint,
  node: EmbeddingNodeRow,
  reference: EmbeddingReferenceContract,
): string[] | null {
  const fingerprint = {
    model: f.model!, modelDigest: f.modelDigest!, quantization: f.quantization ?? null,
    nativeDimension: f.nativeDimension!, targetDimension: f.targetDimension!, numCtx: f.numCtx!,
  };
  const problems = compatibilityProblems(fingerprint, reference);
  const registryMismatch =
    f.model !== node.modell || normalizeDigest(f.modelDigest!) !== normalizeDigest(node.modell_digest) ||
    (f.quantization ?? null) !== node.quantisierung || f.nativeDimension !== node.native_dimension ||
    f.targetDimension !== node.ziel_dimension || f.numCtx !== node.num_ctx;
  return registryMismatch || problems.length > 0 ? problems : null;
}

function gueltigerFingerprint(f: KnotenFingerprint): boolean {
  return typeof f.model === 'string' && typeof f.modelDigest === 'string' &&
    Number.isInteger(f.nativeDimension) && Number.isInteger(f.targetDimension) && Number.isInteger(f.numCtx);
}

function validHeartbeat(body: EmbeddingNodeHeartbeat): boolean {
  return ['ready', 'busy'].includes(body?.status) && Number.isInteger(body.vramFreeMb) &&
    body.vramFreeMb >= 0 && Number.isInteger(body.activeJobs) && body.activeJobs >= 0 &&
    UUID_RE.test(body.bootId) && Number.isSafeInteger(body.sequence) && body.sequence > 0 &&
    typeof body.model === 'string' && body.model.length > 0 && typeof body.modelDigest === 'string' &&
    Number.isInteger(body.nativeDimension) && body.nativeDimension > 0 &&
    Number.isInteger(body.targetDimension) && body.targetDimension > 0 &&
    Number.isInteger(body.numCtx) && body.numCtx > 0;
}

export function createEmbeddingNodeRoutes(
  overrides: Partial<EmbeddingNodeRouteDependencies> = {},
): (fastify: FastifyInstance) => Promise<void> {
  const deps: EmbeddingNodeRouteDependencies = {
    validateToken: overrides.validateToken ?? validateToken,
    db: overrides.db ?? getPool(),
  };
  // P15-T12: Claim-Vergabe an externe GPU-Knoten einzeln pausierbar (intern worker_pausieren gpu_knoten)
  registriereWorker({
    name: 'gpu_knoten',
    beschreibung: 'Claim-Vergabe an externe GPU-Knoten (POST /api/embedding-nodes/:nodeId/claims); pausiert = leere Claims',
  });

  return async (fastify: FastifyInstance): Promise<void> => {
    // P15-T1: Referenzvertrag nicht ermittelbar (Env fehlt, Ollama des Servers antwortet nicht) ->
    // 503 mit den fehlenden Feldern statt stiller Altwerte. Gilt nur in diesem Plugin (register kapselt).
    fastify.setErrorHandler((error, _request, reply) => {
      if (error instanceof EmbeddingReferenceUnavailable) {
        return reply.code(503).send({ success: false, error: 'reference_unavailable', missing: error.missing });
      }
      return reply.send(error);
    });

    // GPU-3: Referenzdaten sind keine Geheimnisse. Der Tray zeigt Modell, VOLLEN
    // Digest und Dimension, bevor der Nutzer irgendeinen Download startet.
    fastify.get('/api/embedding-nodes/reference', async (_request, reply) => {
      const reference = await getEmbeddingReferenceContract();
      // P15-T1: Downloadgroesse aus /api/tags des Servers statt einer Zahl im Code; unbekannt -> null.
      const groesse = (await ollamaModellInfo().catch(() => null))?.groesseBytes ?? null;
      return reply.send({
        success: true,
        reference,
        download: {
          linux: 'https://ollama.com/download',
          windows: 'https://ollama.com/download/windows',
          macos: 'https://ollama.com/download/mac',
          model: `https://ollama.com/library/${encodeURIComponent(reference.model)}`,
          modelSizeGb: groesse === null ? null : Math.round(groesse / 1e8) / 10,
        },
      });
    });

    // Ein Compute-Token darf ausschliesslich den eigenen Registry-Eintrag lesen.
    fastify.get<{ Params: { nodeId: string } }>(
      '/api/embedding-nodes/:nodeId/self',
      async (request, reply) => {
        const { nodeId } = request.params;
        const auth = await principal(request, deps);
        if (!validateNodeId(nodeId) || !tokenAllowsNode(auth, nodeId)) {
          return reply.code(403).send({ success: false, error: 'node_token_mismatch' });
        }
        const node = (await listEmbeddingNodes(deps.db)).find((candidate) =>
          candidate.node_id === nodeId && candidate.service_token_hash === auth!.token_hash
        );
        if (!node) return reply.code(404).send({ success: false, error: 'node_not_registered' });
        const visible = embeddingNodeProjection(node, !!apiCapabilitiesForClient(request.headers[API_CONTRACT_HEADER]));
        return reply.send({ success: true, reference: await getEmbeddingReferenceContract(), node: visible });
      },
    );

    fastify.post<{ Body: EmbeddingNodeRegistration }>(
      '/api/embedding-nodes/register',
      async (request, reply) => {
        const input = request.body;
        if (!input || !validateNodeId(input.nodeId)) {
          return reply.code(400).send({ success: false, error: 'invalid_node_id' });
        }
        if (!validRegistration(input)) {
          return reply.code(400).send({ success: false, error: 'invalid_node_metadata' });
        }
        const auth = await principal(request, deps);
        if (!tokenAllowsNode(auth, input.nodeId)) {
          return reply.code(403).send({ success: false, error: 'node_token_mismatch' });
        }
        try { parseComputeNodeExtension(input, input.nodeId); }
        catch { return reply.code(400).send({ success: false, error: 'invalid_node_resources' }); }
        const reference = await getEmbeddingReferenceContract();
        // ⚠⚠ HIER STAND BIS ZUM 01.08.2026 AUCH EINE FREI-SCHWELLE, UND SIE WAR DIE
        // VIERTE UND LETZTE STELLE DERSELBEN FALLE.
        //
        // Der Server kann nicht wissen, WOVON der Speicher belegt ist. Ist es das
        // Modell des Knotens selbst — der Normalfall, sobald er einmal gearbeitet
        // hat — dann lehnt diese Bedingung genau den Knoten ab, der bereit ist.
        //
        // BEWIESEN am 01.08.2026 ueber die ganze Kette: register -> 409
        // insufficient_free_vram (7300 gefordert, 2165 gemessen, qwen belegte den
        // Rest) -> der neue Compute-Token wurde nie in service_token_hash
        // eingetragen -> GET /self fand den Knoten nicht (404) -> der Tray wartete
        // 45 s auf einen Handshake, der nicht kommen konnte, und meldete "nicht
        // eingerichtet". Drei Schichten Fehlermeldung, und die oberste nannte den
        // Grund nicht. GEGENPROBE: Modell entladen (keep_alive 0), 9250 MB frei,
        // Registrierung sofort erfolgreich, /self 200.
        //
        // DIE EINSTIEGSFRAGE GEHOERT AN DEN KNOTEN, NICHT HIERHER: der Agent prueft
        // sie lokal (probe.ts, Commit feb1709) und rechnet dabei den Speicher mit,
        // den sein eigenes Modell belegt — dieselbe Rechnung im Tray (8b3170e).
        // Nur er kann zwischen eigenem und fremdem Speicher unterscheiden.
        // Serverseitig bleibt die KAPAZITAET: passt die Karte ueberhaupt?
        if (input.vramTotalMb < reference.requiredTotalVramMb) {
          return reply.code(409).send({
            success: false,
            error: 'insufficient_total_vram',
            requiredTotalVramMb: reference.requiredTotalVramMb,
            measuredTotalVramMb: input.vramTotalMb,
          });
        }
        const problems = compatibilityProblems(input, reference);
        if (problems.length > 0) {
          return reply.code(409).send({
            success: false,
            error: 'incompatible_node',
            problems,
            reference,
          });
        }
        // P15-T9: Kapazitaet entscheidet der Server (Obergrenze SYNAPSE_NODE_MAX_CLAIMS, Wunsch des Knotens).
        const claimBatch = authorizedNodeCapacity(input.maxConcurrency);
        if (claimBatch === null) {
          return reply.code(503).send({
            success: false,
            error: 'node_capacity_not_configured',
            hint: 'SYNAPSE_NODE_MAX_CLAIMS an der API oder SYNAPSE_NODE_MAX_CONCURRENCY am Knoten setzen.',
          });
        }
        const node = await registerEmbeddingNode(auth!.token_hash, { ...input, maxConcurrency: claimBatch }, deps.db);
        if (!node) return reply.code(409).send({ success: false, error: 'stale_registration' });
        return reply.code(201).send({
          success: true,
          nodeId: node.node_id,
          status: node.gesperrt_vom_user ? 'locked' : 'ready',
          locked: node.gesperrt_vom_user,
          claimBatch,
        });
      },
    );

    fastify.post<{ Params: { nodeId: string }; Body: EmbeddingNodeHeartbeat }>(
      '/api/embedding-nodes/:nodeId/heartbeat',
      async (request, reply) => {
        const { nodeId } = request.params;
        if (!validateNodeId(nodeId)) {
          return reply.code(400).send({ success: false, error: 'invalid_node_id' });
        }
        const auth = await principal(request, deps);
        if (!tokenAllowsNode(auth, nodeId)) {
          return reply.code(403).send({ success: false, error: 'node_token_mismatch' });
        }
        const body = request.body;
        if (!body || !validHeartbeat(body)) {
          return reply.code(400).send({ success: false, error: 'invalid_heartbeat' });
        }
        try { parseComputeNodeExtension(body, nodeId); }
        catch { return reply.code(400).send({ success: false, error: 'invalid_node_resources' }); }
        const problems = compatibilityProblems(body, await getEmbeddingReferenceContract());
        if (problems.length > 0) {
          return reply.code(409).send({ success: false, error: 'incompatible_node', problems });
        }
        const node = await heartbeatEmbeddingNode(nodeId, auth!.token_hash, {
          status: body.status,
          vramFreeMb: body.vramFreeMb,
          activeJobs: body.activeJobs,
          bootId: body.bootId,
          sequence: body.sequence,
          model: body.model,
          modelDigest: body.modelDigest,
          quantization: body.quantization ?? null,
          nativeDimension: body.nativeDimension,
          targetDimension: body.targetDimension,
          numCtx: body.numCtx,
          ...parseComputeNodeExtension(body, nodeId),
        }, deps.db);
        if (!node) return reply.code(409).send({ success: false, error: 'heartbeat_rejected' });
        return reply.send({ success: true, nodeId, serverTime: new Date().toISOString() });
      },
    );

    fastify.post<{ Params: { nodeId: string }; Body: { limit?: number } }>(
      '/api/embedding-nodes/:nodeId/claims',
      async (request, reply) => {
        const { nodeId } = request.params;
        const auth = await principal(request, deps);
        const node = await usableNode(auth, nodeId, deps);
        if (!node) return reply.code(403).send({ success: false, error: 'node_not_usable' });
        const requested = request.body?.limit ?? 1;
        if (!Number.isInteger(requested) || requested <= 0 || requested > 100) {
          return reply.code(400).send({ success: false, error: 'invalid_claim_limit' });
        }
        // P15-T12: intern(worker_pausieren, gpu_knoten) -> leere Antwort, der Knoten geht in seinen
        // Leerlauf-Backoff. Abschluss/Freigabe laufender Claims (complete/release) bleiben offen.
        const pause = workerPausiert('gpu_knoten');
        if (pause) {
          return reply.send({
            success: true,
            claims: [],
            pausiert: pause,
            reference: await getEmbeddingReferenceContract(),
          });
        }
        const claims = await claimEmbeddingChunks(nodeId, {
          limit: requested,
          maxConcurrent: node.max_concurrency,
        });
        if (claims.length > 0) meldeWorkerArbeit('gpu_knoten');
        return reply.send({
          success: true,
          claims,
          reference: await getEmbeddingReferenceContract(),
        });
      },
    );

    fastify.post<{
      Params: { nodeId: string; chunkId: string };
      Body: {
        claimToken?: string;
        contentHash?: string;
        vector?: number[];
        model?: string;
        modelDigest?: string;
        quantization?: string | null;
        nativeDimension?: number;
        targetDimension?: number;
        numCtx?: number;
      };
    }>(
      '/api/embedding-nodes/:nodeId/claims/:chunkId/complete',
      async (request, reply) => {
        const { nodeId, chunkId } = request.params;
        const auth = await principal(request, deps);
        const node = await usableNode(auth, nodeId, deps);
        if (!node) return reply.code(403).send({ success: false, error: 'node_not_usable' });
        const {
          claimToken, contentHash, vector, model, modelDigest, quantization,
          nativeDimension, targetDimension, numCtx,
        } = request.body ?? {};
        if (!UUID_RE.test(claimToken ?? '') || !/^[a-f0-9]{64}$/.test(contentHash ?? '') ||
            !Array.isArray(vector) || typeof model !== 'string' || typeof modelDigest !== 'string' ||
            !Number.isInteger(nativeDimension) || !Number.isInteger(targetDimension) ||
            !Number.isInteger(numCtx)) {
          return reply.code(400).send({ success: false, error: 'invalid_completion' });
        }
        const fingerprint = {
          model, modelDigest, quantization: quantization ?? null,
          nativeDimension: nativeDimension!, targetDimension: targetDimension!, numCtx: numCtx!,
        };
        const reference = await getEmbeddingReferenceContract();
        const fingerprintProblems = compatibilityProblems(fingerprint, reference);
        const registryMismatch =
          model !== node.modell || normalizeDigest(modelDigest) !== normalizeDigest(node.modell_digest) ||
          (quantization ?? null) !== node.quantisierung || nativeDimension !== node.native_dimension ||
          targetDimension !== node.ziel_dimension || numCtx !== node.num_ctx;
        if (registryMismatch || fingerprintProblems.length > 0) {
          return reply.code(409).send({
            success: false,
            error: 'completion_fingerprint_mismatch',
            problems: fingerprintProblems,
          });
        }
        try {
          const result = await completeEmbeddingClaim({
            nodeId,
            chunkId,
            claimToken: claimToken!,
            contentHash: contentHash!,
            vector,
            expectedDimension: reference.targetDimension,
          });
          return reply.send({ success: true, ...result });
        } catch (error) {
          const code = (error as Error).message;
          const badVector = code === 'invalid_embedding_vector';
          const notFound = code === 'claim_not_found';
          return reply.code(badVector ? 400 : notFound ? 404 : 409).send({ success: false, error: code });
        }
      },
    );

    // P15-T9: Stapel-Abschluss fuer Knoten - EIN Aufruf fuer bis zu MAX_STAPEL Claims. Je Eintrag dieselben
    // Pruefungen wie beim Einzelabschluss (Vektor, Token, Knoten, Inhalts-Hash, Lease; completeEmbeddingClaims),
    // dazu EIN Qdrant-Upsert je Projekt. Abgelehnte Eintraege gibt der Server sofort frei - sonst lagen
    // sie bis zum Lease-Ende brach.
    fastify.post<{
      Params: { nodeId: string };
      Body: KnotenFingerprint & { items?: Array<{ chunkId?: string; claimToken?: string; contentHash?: string; vector?: number[] }> };
    }>(
      '/api/embedding-nodes/:nodeId/claims/complete',
      async (request, reply) => {
        const { nodeId } = request.params;
        const auth = await principal(request, deps);
        const node = await usableNode(auth, nodeId, deps);
        if (!node) return reply.code(403).send({ success: false, error: 'node_not_usable' });
        const body = request.body ?? {};
        const items = Array.isArray(body.items) ? body.items : [];
        const itemsOk = items.length > 0 && items.length <= MAX_STAPEL && items.every((i) =>
          typeof i?.chunkId === 'string' && i.chunkId.length > 0 && UUID_RE.test(i.claimToken ?? '') &&
          /^[a-f0-9]{64}$/.test(i.contentHash ?? '') && Array.isArray(i.vector));
        if (!itemsOk || !gueltigerFingerprint(body)) {
          return reply.code(400).send({ success: false, error: 'invalid_completion' });
        }
        const reference = await getEmbeddingReferenceContract();
        const probleme = fingerprintProbleme(body, node, reference);
        if (probleme) {
          return reply.code(409).send({ success: false, error: 'completion_fingerprint_mismatch', problems: probleme });
        }
        const eintraege = items.map((i) => ({
          chunkId: i.chunkId!, claimToken: i.claimToken!, contentHash: i.contentHash!, vector: i.vector!,
        }));
        const erg = await completeEmbeddingClaims(nodeId, eintraege, reference.targetDimension);
        const tokenVon = new Map(eintraege.map((e) => [e.chunkId, e.claimToken]));
        const freigegeben = await releaseEmbeddingClaims(nodeId, erg.abgelehnt
          .filter((a) => tokenVon.has(String(a.chunkId)))
          .map((a) => ({ chunkId: String(a.chunkId), claimToken: tokenVon.get(String(a.chunkId))! })), deps.db);
        return reply.send({ success: true, abgeschlossen: erg.abgeschlossen, abgelehnt: erg.abgelehnt, freigegeben });
      },
    );

    // P15-T9: Ein Knoten gibt eigene Claims zurueck (geordnetes Beenden, gescheiterter Stapel). Bewusst NICHT
    // usableNode: auch ein gesperrter oder inkompatibler Knoten muss seine Claims loswerden koennen. Die
    // Freigabe wirkt nur auf Chunks dieses Knotens mit genau diesem Token (releaseEmbeddingClaims).
    fastify.post<{ Params: { nodeId: string }; Body: { claims?: Array<{ chunkId?: string; claimToken?: string }> } }>(
      '/api/embedding-nodes/:nodeId/claims/release',
      async (request, reply) => {
        const { nodeId } = request.params;
        const auth = await principal(request, deps);
        if (!validateNodeId(nodeId) || !tokenAllowsNode(auth, nodeId)) {
          return reply.code(403).send({ success: false, error: 'node_token_mismatch' });
        }
        const claims = Array.isArray(request.body?.claims) ? request.body!.claims! : [];
        if (claims.length > MAX_STAPEL || !claims.every((c) =>
          typeof c?.chunkId === 'string' && c.chunkId.length > 0 && UUID_RE.test(c.claimToken ?? ''))) {
          return reply.code(400).send({ success: false, error: 'invalid_release' });
        }
        const freigegeben = await releaseEmbeddingClaims(
          nodeId,
          claims.map((c) => ({ chunkId: c.chunkId!, claimToken: c.claimToken! })),
          deps.db,
        );
        return reply.send({ success: true, freigegeben });
      },
    );

    fastify.get('/api/embedding-nodes', async (request, reply) => {
      const auth = await principal(request, deps);
      if (!auth || (auth.kind !== 'access' && auth.kind !== 'session')) {
        return reply.code(403).send({ success: false, error: 'admin_token_required' });
      }
      return reply.send({
        success: true,
        reference: await getEmbeddingReferenceContract(),
        nodes: (await listEmbeddingNodes(deps.db)).map(node => embeddingNodeProjection(node, !!apiCapabilitiesForClient(request.headers[API_CONTRACT_HEADER]))),
      });
    });

    fastify.patch<{ Params: { nodeId: string }; Body: { locked?: boolean; reason?: string } }>(
      '/api/embedding-nodes/:nodeId/lock',
      async (request, reply) => {
        const auth = await principal(request, deps);
        // Sperren/Entsperren darf: eine Admin-Sitzung (access/session) ODER ein
        // DAEMON-Service-Token (User-Vorgabe 01.08.2026 — der Tray soll dafuer
        // keinen zweiten TOTP verlangen).
        // ⚠️ AUSDRUECKLICH NICHT: ein compute-node-Token. Sonst koennte ein
        // gesperrter oder kompromittierter Knoten seine eigene Sperre aufheben,
        // und gesperrt_vom_user waere keine Entscheidung des Nutzers mehr,
        // sondern ein Vorschlag. Genau davor hat der Review in 17766 gewarnt.
        const istDaemonToken =
          auth?.kind === 'service' &&
          (auth.scope === 'daemon' || (auth.scope ?? '').startsWith('daemon:'));
        if (!auth || (auth.kind !== 'access' && auth.kind !== 'session' && !istDaemonToken)) {
          return reply.code(403).send({ success: false, error: 'admin_token_required' });
        }
        const { nodeId } = request.params;
        if (!validateNodeId(nodeId) || typeof request.body?.locked !== 'boolean') {
          return reply.code(400).send({ success: false, error: 'invalid_lock_request' });
        }
        const reason = request.body.reason?.trim().slice(0, 200) || null;
        const node = await setEmbeddingNodeLock(nodeId, request.body.locked, reason, deps.db);
        if (!node) return reply.code(404).send({ success: false, error: 'node_not_registered' });
        return reply.send({ success: true, nodeId, locked: node.gesperrt_vom_user });
      },
    );
  };
}

export const embeddingNodeRoutes = createEmbeddingNodeRoutes();
