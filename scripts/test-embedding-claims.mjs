import assert from 'node:assert/strict';
import {
  claimEmbeddingChunks,
  completeEmbeddingClaim,
  deterministicChunkPointId,
  embeddingContentHash,
  validateEmbeddingVector,
} from '../packages/core/dist/index.js';

class ClaimState {
  constructor() {
    this.rows = Array.from({ length: 4 }, (_unused, index) => ({
      id: `chunk-${index + 1}`,
      project: 'p',
      file_path: 'src/a.ts',
      file_type: 'typescript',
      chunk_index: index,
      content: `content-${index + 1}`,
      line_start: index + 1,
      line_end: index + 1,
      total_chunks: 4,
      embedded_at: null,
      claimed_by: null,
      lease_until: null,
      claim_attempt: 0,
    }));
    this.locks = new Set();
    this.nodeLocks = new Set();
    this.nodeWaiters = new Map();
  }

  pool() {
    return { connect: async () => this.client() };
  }

  client() {
    const held = new Set();
    let heldNodeKey = null;
    return {
      query: async (sql, values = []) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q === 'BEGIN') return { rows: [] };
        if (q === 'COMMIT' || q === 'ROLLBACK') {
          for (const id of held) this.locks.delete(id);
          if (heldNodeKey) {
            const waiters = this.nodeWaiters.get(heldNodeKey) ?? [];
            const next = waiters.shift();
            if (next) next();
            else this.nodeLocks.delete(heldNodeKey);
            if (waiters.length === 0) this.nodeWaiters.delete(heldNodeKey);
            heldNodeKey = null;
          }
          return { rows: [] };
        }
        if (q.startsWith('SELECT pg_advisory_xact_lock')) {
          const key = values[0];
          if (this.nodeLocks.has(key)) {
            await new Promise((resolve) => {
              const waiters = this.nodeWaiters.get(key) ?? [];
              waiters.push(resolve);
              this.nodeWaiters.set(key, waiters);
            });
          } else {
            this.nodeLocks.add(key);
          }
          heldNodeKey = key;
          return { rows: [{}] };
        }
        if (q.startsWith('SELECT COUNT(*)::text AS count')) {
          const count = this.rows.filter((row) =>
            row.claimed_by === values[0] && !row.embedded_at &&
            row.lease_until && row.lease_until >= new Date()
          ).length;
          return { rows: [{ count: String(count) }] };
        }
        if (q.includes('FOR UPDATE OF cc SKIP LOCKED')) {
          const limit = values[0];
          const now = new Date();
          const rows = this.rows.filter((row) =>
            !row.embedded_at && (!row.lease_until || row.lease_until < now) &&
            !this.locks.has(row.id)
          ).slice(0, limit);
          for (const row of rows) {
            this.locks.add(row.id);
            held.add(row.id);
          }
          return { rows: rows.map((row) => ({ ...row })) };
        }
        if (q.startsWith('UPDATE code_chunks') && q.includes('claim_attempt=claim_attempt+1')) {
          const row = this.rows.find((item) => item.id === values[0]);
          assert.ok(row);
          row.content_hash = values[1];
          row.claim_token = values[2];
          row.claimed_by = values[3];
          row.lease_until = new Date(Date.now() + values[4] * 1000);
          row.claim_attempt++;
          return { rows: [{ claim_attempt: row.claim_attempt, lease_until: row.lease_until }], rowCount: 1 };
        }
        throw new Error(`unexpected claim SQL: ${q}`);
      },
      release() {},
    };
  }
}

function completionPool({ content = 'stable', hash = embeddingContentHash(content), ackRows = 1 } = {}) {
  const now = new Date();
  const row = {
    id: 'chunk-complete',
    project: 'p',
    file_path: 'src/a.ts',
    file_type: 'typescript',
    chunk_index: 0,
    content,
    content_hash: hash,
    line_start: 1,
    line_end: 2,
    claim_token: '11111111-1111-4111-8111-111111111111',
    claimed_by: 'node-a',
    lease_until: new Date(now.getTime() + 60_000),
    embedded_at: null,
    total_chunks: 1,
    server_now: now,
  };
  return {
    row,
    connect: async () => ({
      query: async (sql) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
        if (q === 'SELECT project, file_path FROM code_chunks WHERE id=$1') {
          return { rows: [{ project: row.project, file_path: row.file_path }] };
        }
        if (q.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [{}] };
        if (q.includes('FOR UPDATE OF cc')) return { rows: [{ ...row }] };
        if (q.startsWith('UPDATE code_chunks')) return { rows: [], rowCount: ackRows };
        throw new Error(`unexpected completion SQL: ${q}`);
      },
      release() {},
    }),
  };
}

const state = new ClaimState();
const [nodeA, nodeB] = await Promise.all([
  claimEmbeddingChunks('node-a', { limit: 2, maxConcurrent: 2 }, state.pool()),
  claimEmbeddingChunks('node-b', { limit: 2, maxConcurrent: 2 }, state.pool()),
]);
assert.equal(nodeA.length, 2);
assert.equal(nodeB.length, 2);
assert.equal(new Set([...nodeA, ...nodeB].map((claim) => claim.chunkId)).size, 4);

const sameNodeState = new ClaimState();
const sameNode = await Promise.all([
  claimEmbeddingChunks('node-same', { limit: 2, maxConcurrent: 2 }, sameNodeState.pool()),
  claimEmbeddingChunks('node-same', { limit: 2, maxConcurrent: 2 }, sameNodeState.pool()),
]);
assert.equal(sameNode.flat().length, 2);
assert.equal(new Set(sameNode.flat().map((claim) => claim.chunkId)).size, 2);

state.rows[0].embedded_at = null;
state.rows[0].claimed_by = 'dead-node';
state.rows[0].lease_until = new Date(Date.now() - 1_000);
const reclaimed = await claimEmbeddingChunks('node-c', { limit: 1, maxConcurrent: 1 }, state.pool());
assert.equal(reclaimed[0].chunkId, 'chunk-1');
assert.equal(reclaimed[0].claimAttempt, 2);

assert.equal(validateEmbeddingVector([1, 0, 0], 3), true);
assert.equal(validateEmbeddingVector([1, Number.NaN, 0], 3), false);
assert.equal(validateEmbeddingVector([0, 0, 0], 3), false);

let writes = 0;
const changedPool = completionPool({ content: 'new-content', hash: embeddingContentHash('old-content') });
await assert.rejects(
  completeEmbeddingClaim({
    nodeId: 'node-a',
    chunkId: changedPool.row.id,
    claimToken: changedPool.row.claim_token,
    contentHash: changedPool.row.content_hash,
    vector: [1, 0, 0],
    expectedDimension: 3,
  }, {
    pool: changedPool,
    ensureCollection: async () => 'code_p',
    writeVector: async () => { writes++; },
  }),
  /claim_fence_rejected/,
);
assert.equal(writes, 0);

const qdrant = new Map();
const pointIds = [];
const input = {
  nodeId: 'node-a',
  chunkId: 'chunk-complete',
  claimToken: '11111111-1111-4111-8111-111111111111',
  contentHash: embeddingContentHash('stable'),
  vector: [1, 0, 0],
  expectedDimension: 3,
};
const first = completionPool({ ackRows: 0 });
await assert.rejects(
  completeEmbeddingClaim(input, {
    pool: first,
    ensureCollection: async (_project, dimension) => {
      assert.equal(dimension, 3);
      return 'code_p';
    },
    writeVector: async (_collection, vector, payload, pointId) => {
      pointIds.push(pointId);
      qdrant.set(pointId, { vector, payload });
    },
  }),
  /claim_ack_race/,
);
const second = completionPool({ ackRows: 1 });
const completed = await completeEmbeddingClaim(input, {
  pool: second,
  ensureCollection: async (_project, dimension) => {
    assert.equal(dimension, 3);
    return 'code_p';
  },
  writeVector: async (_collection, vector, payload, pointId) => {
    pointIds.push(pointId);
    qdrant.set(pointId, { vector, payload });
  },
});
assert.equal(completed.alreadyCompleted, false);
assert.equal(pointIds.length, 2);
assert.equal(pointIds[0], pointIds[1]);
assert.equal(qdrant.size, 1);
assert.equal(
  pointIds[0],
  deterministicChunkPointId('p', 'src/a.ts', 0, 'stable'),
);

console.log('GPU-2 claim tests: cross_node_disjoint=4 same_node_cap=2 reclaim=1 fence=closed retry_points=1 vectors=validated');
