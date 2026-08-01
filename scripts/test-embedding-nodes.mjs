#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const DIGEST = 'a'.repeat(64);
const BOOT_1 = '11111111-1111-4111-8111-111111111111';
const BOOT_2 = '22222222-2222-4222-8222-222222222222';
const BOOT_STARTED_1 = new Date(Date.now() - 10 * 60_000).toISOString();
const BOOT_STARTED_2 = new Date(Date.now() - 9 * 60_000).toISOString();
process.env.SYNAPSE_OLLAMA_MODEL_DIGEST = DIGEST;
process.env.OLLAMA_MODEL = 'qwen3-embedding:8b';
process.env.SYNAPSE_OLLAMA_NATIVE_DIMENSION = '4096';
process.env.EMBEDDING_TARGET_DIM = '3072';
process.env.EMBEDDING_NUM_CTX = '8192';

const requireFromRest = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const Fastify = requireFromRest('fastify');
const { createEmbeddingNodeRoutes } =
  await import('../packages/rest-api/dist/routes/embedding-nodes.js');
const {
  compatibilityProblems,
  deriveEmbeddingNodeStatus,
  validateOllamaUrl,
} = await import('../packages/rest-api/dist/services/embedding-nodes.js');

const tokenRow = (kind, scope, hash) => ({
  token_hash: hash, kind, client_id: null, scope, label: null,
  redirect_uri: null, code_challenge: null, parent_token: null,
  created_at: new Date(), expires_at: null, last_used_at: new Date(),
});
const tokens = new Map([
  ['node-a-token', tokenRow('service', 'compute-node:node-a', 'hash-node-a')],
  ['garbage-scope', tokenRow('service', 'compute-node:node-a:garbage', 'hash-garbage')],
  ['daemon-token', tokenRow('service', 'daemon:node-a', 'hash-daemon')],
  ['session-token', tokenRow('session', null, 'hash-session')],
  ['admin-token', tokenRow('access', null, 'hash-admin')],
]);

const rows = new Map();
const sqlSeen = [];
const db = {
  async query(sql, values = []) {
    sqlSeen.push({ sql, values });
    if (sql.startsWith('INSERT INTO embedding_knoten')) {
      const existing = rows.get(values[0]);
      const row = {
        node_id: values[0], host: values[1], ollama_url: values[2], modell: values[3],
        modell_digest: values[4], quantisierung: values[5], native_dimension: values[6],
        ziel_dimension: values[7], num_ctx: values[8], vram_gesamt_mb: values[9],
        vram_frei_mb: values[10], system_memory_mb: values[11], cpu_cores: values[12],
        gpu_name: values[13], max_concurrency: values[14], active_jobs: 0, status: 'ready',
        gesperrt_vom_user: existing?.gesperrt_vom_user ?? false,
        sperrgrund: existing?.sperrgrund ?? null,
        service_token_hash: values[15], agent_version: values[16], boot_id: values[17],
        last_sequence: 0, boot_started_at: new Date(values[18]),
        registriert_am: existing?.registriert_am ?? new Date(),
        letzter_kontakt: new Date(), aktualisiert_am: new Date(),
      };
      const existingLeaseIsStale = existing &&
        Date.now() - existing.letzter_kontakt.getTime() > 120_000;
      if (existing && existing.boot_started_at > row.boot_started_at && !existingLeaseIsStale) {
        return { rows: [], rowCount: 0 };
      }
      rows.set(row.node_id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SET status=$5')) {
      const row = rows.get(values[0]);
      const matches = row && row.service_token_hash === values[1] &&
        row.boot_id === values[2] && row.last_sequence < values[3] &&
        row.modell === values[7] && row.modell_digest === values[8] &&
        row.native_dimension === values[9] && row.ziel_dimension === values[10] &&
        row.num_ctx === values[11] && row.quantisierung === values[12];
      if (!matches) return { rows: [], rowCount: 0 };
      row.status = values[4]; row.vram_frei_mb = values[5]; row.active_jobs = values[6];
      row.last_sequence = values[3]; row.letzter_kontakt = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SET gesperrt_vom_user=$2')) {
      const row = rows.get(values[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.gesperrt_vom_user = values[1]; row.sperrgrund = values[1] ? values[2] : null;
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith('SELECT *, NOW() AS server_now FROM embedding_knoten')) {
      return { rows: [...rows.values()].map((row) => ({ ...row, server_now: new Date() })), rowCount: rows.size };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
};

let forbiddenFetches = 0;
globalThis.fetch = async () => {
  forbiddenFetches++;
  throw new Error('REST registry must not fetch client ollama_url');
};

const app = Fastify({ logger: false });
await app.register(createEmbeddingNodeRoutes({
  db,
  validateToken: async (token) => tokens.get(token) ?? null,
}));

const registration = {
  nodeId: 'node-a', host: 'gpu-box', ollamaUrl: 'http://10.0.0.22:11434',
  model: 'qwen3-embedding:8b', modelDigest: DIGEST, quantization: 'Q8_0',
  nativeDimension: 4096, targetDimension: 3072, numCtx: 8192,
  vramTotalMb: 24576, vramFreeMb: 22000, systemMemoryMb: 65536,
  cpuCores: 16, gpuName: 'Fake GPU', maxConcurrency: 2,
  agentVersion: 'test', bootId: BOOT_1, bootStartedAt: BOOT_STARTED_1,
};
const heartbeatPayload = (overrides = {}) => ({
  status: 'busy', vramFreeMb: 21000, activeJobs: 1, bootId: BOOT_1, sequence: 1,
  model: registration.model, modelDigest: DIGEST, quantization: registration.quantization,
  nativeDimension: 4096, targetDimension: 3072, numCtx: 8192, ...overrides,
});

for (const ollamaUrl of ['file:///tmp/socket', 'http://user:pass@10.0.0.2']) {
  assert.equal(validateOllamaUrl(ollamaUrl), false, ollamaUrl);
}
for (const ollamaUrl of [registration.ollamaUrl, 'http://127.0.0.1:11434', 'http://localhost:11434']) {
  assert.equal(validateOllamaUrl(ollamaUrl), true, ollamaUrl);
}

for (const change of [
  { nodeId: 'Node-A' },
  { host: '' },
  { model: '' },
  { bootId: 'not-a-uuid' },
  { bootStartedAt: new Date(Date.now() + 10 * 60_000).toISOString() },
  { maxConcurrency: 0 },
  { vramTotalMb: -1 },
  { vramFreeMb: registration.vramTotalMb + 1 },
  { nativeDimension: 0 },
]) {
  const before = sqlSeen.length;
  const response = await app.inject({
    method: 'POST', url: '/api/embedding-nodes/register',
    headers: { authorization: 'Bearer node-a-token' },
    payload: { ...registration, ...change },
  });
  assert.equal(response.statusCode, 400, JSON.stringify(change));
  assert.equal(sqlSeen.length, before, 'Invalid registration metadata mutated DB');
}

for (const token of ['session-token', 'daemon-token', 'garbage-scope', 'revoked-token']) {
  const before = sqlSeen.length;
  const response = await app.inject({
    method: 'POST', url: '/api/embedding-nodes/register',
    headers: { authorization: `Bearer ${token}` }, payload: registration,
  });
  assert.equal(response.statusCode, 403, token);
  assert.equal(sqlSeen.length, before, `${token} mutated DB`);
}

const crossBefore = sqlSeen.length;
const cross = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/register',
  headers: { authorization: 'Bearer node-a-token' },
  payload: { ...registration, nodeId: 'node-b' },
});
assert.equal(cross.statusCode, 403);
assert.equal(sqlSeen.length, crossBefore);

for (const change of [
  { modelDigest: 'b'.repeat(64) }, { model: 'other' }, { nativeDimension: 3072 },
  { targetDimension: 4096 }, { numCtx: 4096 },
]) {
  const before = sqlSeen.length;
  const response = await app.inject({
    method: 'POST', url: '/api/embedding-nodes/register',
    headers: { authorization: 'Bearer node-a-token' },
    payload: { ...registration, ...change },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(sqlSeen.length, before, 'Incompatible registration refreshed TTL');
}

const registered = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/register',
  headers: { authorization: 'Bearer node-a-token' }, payload: registration,
});
assert.equal(registered.statusCode, 201);
assert.equal(forbiddenFetches, 0);

const beforeMismatchContact = rows.get('node-a').letzter_kontakt;
const mismatchQueries = sqlSeen.length;
const mismatchHeartbeat = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/node-a/heartbeat',
  headers: { authorization: 'Bearer node-a-token' },
  payload: heartbeatPayload({ modelDigest: 'b'.repeat(64) }),
});
assert.equal(mismatchHeartbeat.statusCode, 409);
assert.equal(sqlSeen.length, mismatchQueries);
assert.equal(rows.get('node-a').letzter_kontakt, beforeMismatchContact);

const heartbeat = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/node-a/heartbeat',
  headers: { authorization: 'Bearer node-a-token' },
  payload: {
    ...heartbeatPayload(), gesperrt_vom_user: false,
    letzter_kontakt: '2099-01-01T00:00:00Z', ollama_url: 'http://127.0.0.1:1',
  },
});
assert.equal(heartbeat.statusCode, 200);
const heartbeatSql = sqlSeen.findLast((entry) => entry.sql.includes('SET status=$5'));
assert.ok(heartbeatSql && heartbeatSql.sql.includes('letzter_kontakt=NOW()'));
assert.ok(!heartbeatSql.sql.includes('gesperrt_vom_user'));
assert.equal(forbiddenFetches, 0);

const locked = await app.inject({
  method: 'PATCH', url: '/api/embedding-nodes/node-a/lock',
  headers: { authorization: 'Bearer admin-token' },
  payload: { locked: true, reason: 'maintenance' },
});
assert.equal(locked.statusCode, 200);
assert.equal(rows.get('node-a').gesperrt_vom_user, true);
rows.get('node-a').letzter_kontakt = new Date(Date.now() - 121_000);
let listed = await app.inject({
  method: 'GET', url: '/api/embedding-nodes',
  headers: { authorization: 'Bearer admin-token' },
});
let listedNode = listed.json().nodes[0];
assert.equal(listedNode.effectiveStatus, 'locked');
assert.equal(listedNode.usable, false);
const unlocked = await app.inject({
  method: 'PATCH', url: '/api/embedding-nodes/node-a/lock',
  headers: { authorization: 'Bearer admin-token' }, payload: { locked: false },
});
assert.equal(unlocked.statusCode, 200);
listed = await app.inject({
  method: 'GET', url: '/api/embedding-nodes',
  headers: { authorization: 'Bearer admin-token' },
});
listedNode = listed.json().nodes[0];
assert.equal(listedNode.effectiveStatus, 'failed');
assert.equal(listedNode.usable, false);
await app.inject({
  method: 'PATCH', url: '/api/embedding-nodes/node-a/lock',
  headers: { authorization: 'Bearer admin-token' },
  payload: { locked: true, reason: 'maintenance' },
});

const reregister = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/register',
  headers: { authorization: 'Bearer node-a-token' },
  payload: { ...registration, bootId: BOOT_2, bootStartedAt: BOOT_STARTED_2 },
});
assert.equal(reregister.statusCode, 201);
assert.equal(rows.get('node-a').gesperrt_vom_user, true, 'Restart overwrote user lock');
const newBootContact = rows.get('node-a').letzter_kontakt;
const delayedRegister = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/register',
  headers: { authorization: 'Bearer node-a-token' },
  payload: registration,
});
assert.equal(delayedRegister.statusCode, 409);
assert.equal(rows.get('node-a').boot_id, BOOT_2);
assert.equal(rows.get('node-a').letzter_kontakt, newBootContact);
const delayedOldBoot = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/node-a/heartbeat',
  headers: { authorization: 'Bearer node-a-token' },
  payload: heartbeatPayload({ sequence: 2 }),
});
assert.equal(delayedOldBoot.statusCode, 409);
assert.equal(rows.get('node-a').letzter_kontakt, newBootContact);

rows.get('node-a').letzter_kontakt = new Date(Date.now() - 121_000);
const staleLeaseRecovery = await app.inject({
  method: 'POST', url: '/api/embedding-nodes/register',
  headers: { authorization: 'Bearer node-a-token' },
  payload: registration,
});
assert.equal(staleLeaseRecovery.statusCode, 201);
assert.equal(rows.get('node-a').boot_id, BOOT_1);
assert.equal(rows.get('node-a').gesperrt_vom_user, true, 'Stale recovery overwrote user lock');

const now = Date.now();
const statusRow = (age, extra = {}) => ({
  gesperrt_vom_user: false, status: 'ready', letzter_kontakt: new Date(now - age), ...extra,
});
assert.equal(deriveEmbeddingNodeStatus(statusRow(119_999), now), 'ready');
assert.equal(deriveEmbeddingNodeStatus(statusRow(120_000), now), 'ready');
assert.equal(deriveEmbeddingNodeStatus(statusRow(120_001), now), 'failed');
assert.equal(deriveEmbeddingNodeStatus(statusRow(120_001, { status: 'busy' }), now), 'failed');
assert.equal(
  deriveEmbeddingNodeStatus(statusRow(120_001, { gesperrt_vom_user: true }), now),
  'locked',
);
assert.deepEqual(compatibilityProblems(registration), []);

await app.close();
console.log(JSON.stringify({
  success: true, crossNode: cross.statusCode, digestMismatch: mismatchHeartbeat.statusCode,
  registered: registered.statusCode, heartbeat: heartbeat.statusCode,
  staleRegister: delayedRegister.statusCode, staleOldBoot: delayedOldBoot.statusCode,
  staleLeaseRecovery: staleLeaseRecovery.statusCode, oldBootAgeMinutes: 10,
  ssrfFetches: forbiddenFetches,
  statuses: ['locked', 'failed', 'busy', 'ready'],
}));
