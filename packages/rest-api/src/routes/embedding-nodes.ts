import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  getPool,
  claimEmbeddingChunks,
  completeEmbeddingClaim,
} from '@synapse/core';
import { validateToken, type AuthTokenRow } from '../services/auth.js';
import {
  compatibilityProblems,
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
    Number.isInteger(input.maxConcurrency) && input.maxConcurrency > 0;
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

  return async (fastify: FastifyInstance): Promise<void> => {
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
        const problems = compatibilityProblems(input);
        if (problems.length > 0) {
          return reply.code(409).send({
            success: false,
            error: 'incompatible_node',
            problems,
            reference: getEmbeddingReferenceContract(),
          });
        }
        const node = await registerEmbeddingNode(auth!.token_hash, input, deps.db);
        if (!node) return reply.code(409).send({ success: false, error: 'stale_registration' });
        return reply.code(201).send({ success: true, nodeId: node.node_id, status: 'ready' });
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
        const problems = compatibilityProblems(body);
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
        const claims = await claimEmbeddingChunks(nodeId, {
          limit: requested,
          maxConcurrent: node.max_concurrency,
        });
        return reply.send({
          success: true,
          claims,
          reference: getEmbeddingReferenceContract(),
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
        const fingerprintProblems = compatibilityProblems(fingerprint);
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
            expectedDimension: getEmbeddingReferenceContract().targetDimension,
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

    fastify.get('/api/embedding-nodes', async (request, reply) => {
      const auth = await principal(request, deps);
      if (!auth || (auth.kind !== 'access' && auth.kind !== 'session')) {
        return reply.code(403).send({ success: false, error: 'admin_token_required' });
      }
      return reply.send({
        success: true,
        reference: getEmbeddingReferenceContract(),
        nodes: (await listEmbeddingNodes(deps.db)).map(({ service_token_hash: _secret, ...node }) => node),
      });
    });

    fastify.patch<{ Params: { nodeId: string }; Body: { locked?: boolean; reason?: string } }>(
      '/api/embedding-nodes/:nodeId/lock',
      async (request, reply) => {
        const auth = await principal(request, deps);
        if (!auth || (auth.kind !== 'access' && auth.kind !== 'session')) {
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
