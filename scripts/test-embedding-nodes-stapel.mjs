#!/usr/bin/env node
// test-embedding-nodes-stapel.mjs — P15-T9: GPU-Knoten im Stapel, API-Seite, gegen die TEST-DB.
//   K1 Kapazitaet: ohne SYNAPSE_NODE_MAX_CLAIMS und ohne Wunsch -> 503 node_capacity_not_configured;
//      mit Obergrenze 8 -> claimBatch 8; Wunsch 3 -> 3 (Server-Obergrenze bleibt Grenze).
//   S1 Stapel-Abschluss: 3 Eintraege in EINEM Aufruf, 2 gueltig -> embedded_at gesetzt, 1 mit kaputtem
//      Vektor -> abgelehnt UND sofort freigegeben (claimed_by NULL); Qdrant bekam EINEN Upsert.
//   S2 Validierung: leere items -> 400 invalid_completion.
//   R1 Freigabe: eigener Claim mit Token -> frei; fremder Knoten-Token -> 403; falsches Token -> nichts.
// Aufruf: set -a; . <test-db.env>; set +a; node scripts/test-embedding-nodes-stapel.mjs
// Braucht gebautes packages/core/dist und packages/rest-api/dist.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH: DATABASE_URL zeigt nicht auf die Test-DB (:5433/synapse_test).');
  process.exit(2);
}

// Fake-Qdrant: nimmt alles an und zaehlt Upserts (PUT .../points).
const qdrantUpserts = [];
const qdrant = http.createServer((req, res) => {
  let roh = '';
  req.on('data', (d) => { roh += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'PUT' && /\/points(\?|$)/.test(req.url ?? '')) qdrantUpserts.push(JSON.parse(roh || '{}'));
    if (req.method === 'GET' && /^\/collections\/[^/]+$/.test((req.url ?? '').split('?')[0])) {
      return res.end(JSON.stringify({ status: 'ok', result: { status: 'green', points_count: 0, config: { params: { vectors: { size: 4, distance: 'Cosine' } } } } }));
    }
    res.end(JSON.stringify({ status: 'ok', result: { status: 'completed', operation_id: 1 } }));
  });
});
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));

const DIGEST = 'f'.repeat(64);
const NODE = 'p15-stapel-knoten';
const PROJEKT = 'p15-stapel-test';
Object.assign(process.env, {
  QDRANT_URL: `http://127.0.0.1:${qdrant.address().port}`,
  EMBEDDING_PROVIDER: 'ollama',
  OLLAMA_URL: 'http://127.0.0.1:9',
  OLLAMA_MODEL: 'p15-stapel-modell:latest',
  SYNAPSE_OLLAMA_MODEL_DIGEST: DIGEST,
  SYNAPSE_OLLAMA_NATIVE_DIMENSION: '8',
  EMBEDDING_TARGET_DIM: '4',
  EMBEDDING_NUM_CTX: '512',
  SYNAPSE_GPU_REQUIRED_TOTAL_MB: '100',
  SYNAPSE_GPU_REQUIRED_FREE_MB: '50',
  EMBEDDING_QUERY_PREFIX: 'q: ',
  EMBEDDING_DOC_PREFIX: 'd: ',
  EMBEDDING_MAX_INPUT_CHARS: '1000',
});
delete process.env.SYNAPSE_NODE_MAX_CLAIMS;

const requireFromRest = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const Fastify = requireFromRest('fastify');
const core = await import('../packages/core/dist/index.js');
const { createEmbeddingNodeRoutes } = await import('../packages/rest-api/dist/routes/embedding-nodes.js');
const pool = core.getPool();

const tokens = new Map([
  ['node-token', { token_hash: 'hash-p15-stapel', kind: 'service', scope: `compute-node:${NODE}` }],
  ['fremd-token', { token_hash: 'hash-fremd', kind: 'service', scope: 'compute-node:anderer-knoten' }],
]);
const app = Fastify({ logger: false });
await app.register(createEmbeddingNodeRoutes({ db: pool, validateToken: async (t) => tokens.get(t) ?? null }));

const auth = { authorization: 'Bearer node-token' };
let boot = 0;
const registrierung = (extra = {}) => ({
  nodeId: NODE, host: 'test', ollamaUrl: 'http://127.0.0.1:11435',
  model: process.env.OLLAMA_MODEL, modelDigest: DIGEST, nativeDimension: 8, targetDimension: 4, numCtx: 512,
  vramTotalMb: 1000, vramFreeMb: 900, bootId: `${String(++boot).padStart(8, '0')}-1111-4111-8111-111111111111`,
  bootStartedAt: new Date(Date.now() - 60_000 + boot * 1000).toISOString(), ...extra,
});
const fingerprint = { model: process.env.OLLAMA_MODEL, modelDigest: DIGEST, quantization: null, nativeDimension: 8, targetDimension: 4, numCtx: 512 };
const token = (n) => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;

const aufraeumen = async () => {
  await pool.query('DELETE FROM code_files WHERE project = $1', [PROJEKT]);
  await pool.query('DELETE FROM embedding_knoten WHERE node_id = $1', [NODE]);
  await pool.query('DELETE FROM auth_tokens WHERE token_hash = $1', ['hash-p15-stapel']);
};
async function chunk(nr, content, claimToken) {
  await pool.query(
    `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end, content_hash, claim_token, claimed_by, lease_until)
     VALUES ($1, $2, 'src/a.ts', $3, $4, 1, 1, $5, $6, $7, NOW() + INTERVAL '5 minutes')`,
    [`${PROJEKT}-c${nr}`, PROJEKT, nr, content, core.embeddingContentHash(content), claimToken, NODE],
  );
}
const zeile = async (nr) => (await pool.query('SELECT embedded_at, claimed_by, claim_token FROM code_chunks WHERE id = $1', [`${PROJEKT}-c${nr}`])).rows[0];

try {
  await aufraeumen();
  // embedding_knoten.service_token_hash verweist auf auth_tokens
  await pool.query(`INSERT INTO auth_tokens (token_hash, kind, scope, label) VALUES ($1, 'service', $2, 'p15-stapel-test')`, ['hash-p15-stapel', `compute-node:${NODE}`]);
  // K1
  let r = await app.inject({ method: 'POST', url: '/api/embedding-nodes/register', headers: auth, payload: registrierung() });
  assert.equal(r.statusCode, 503, r.body);
  assert.equal(r.json().error, 'node_capacity_not_configured');
  process.env.SYNAPSE_NODE_MAX_CLAIMS = '8';
  r = await app.inject({ method: 'POST', url: '/api/embedding-nodes/register', headers: auth, payload: registrierung() });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().claimBatch, 8);
  r = await app.inject({ method: 'POST', url: '/api/embedding-nodes/register', headers: auth, payload: registrierung({ maxConcurrency: 3 }) });
  assert.equal(r.json().claimBatch, 3, r.body);
  r = await app.inject({ method: 'POST', url: '/api/embedding-nodes/register', headers: auth, payload: registrierung({ maxConcurrency: 20 }) });
  assert.equal(r.json().claimBatch, 8, 'Server-Obergrenze gilt: ' + r.body);
  const reg = (await pool.query('SELECT max_concurrency FROM embedding_knoten WHERE node_id = $1', [NODE])).rows[0];
  assert.equal(reg.max_concurrency, 8);
  console.log('OK  K1 Kapazitaet: ohne Konfig 503, Obergrenze 8, Wunsch 3, Wunsch 20 -> 8');

  // S1
  await pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type) VALUES ($1, $2, 'src/a.ts', 'a.ts', 'typescript')`, [`${PROJEKT}-f`, PROJEKT]);
  await chunk(1, 'eins', token(1));
  await chunk(2, 'zwei', token(2));
  await chunk(3, 'drei', token(3));
  const upsertsVorher = qdrantUpserts.length;
  r = await app.inject({
    method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/complete`, headers: auth,
    payload: {
      ...fingerprint,
      items: [
        { chunkId: `${PROJEKT}-c1`, claimToken: token(1), contentHash: core.embeddingContentHash('eins'), vector: [0.5, 0.5, 0.5, 0.5] },
        { chunkId: `${PROJEKT}-c2`, claimToken: token(2), contentHash: core.embeddingContentHash('zwei'), vector: [1, 0, 0, 0] },
        { chunkId: `${PROJEKT}-c3`, claimToken: token(3), contentHash: core.embeddingContentHash('drei'), vector: [1, 0, 0] },
      ],
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  const s1 = r.json();
  assert.deepEqual([...s1.abgeschlossen].sort(), [`${PROJEKT}-c1`, `${PROJEKT}-c2`]);
  assert.deepEqual(s1.abgelehnt.map((a) => [a.chunkId, a.grund]), [[`${PROJEKT}-c3`, 'invalid_embedding_vector']]);
  assert.deepEqual(s1.freigegeben, [`${PROJEKT}-c3`]);
  assert.ok((await zeile(1)).embedded_at && (await zeile(2)).embedded_at);
  const z3 = await zeile(3);
  assert.equal(z3.embedded_at, null);
  assert.equal(z3.claimed_by, null, 'abgelehnter Eintrag wurde nicht freigegeben');
  assert.equal(qdrantUpserts.length - upsertsVorher, 1, 'erwartet EIN Qdrant-Upsert fuer den Stapel');
  assert.equal(qdrantUpserts.at(-1).points.length, 2);
  console.log('OK  S1 Stapel-Abschluss: 2 fertig in EINEM Upsert, kaputter Vektor abgelehnt und freigegeben');

  // S2
  r = await app.inject({ method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/complete`, headers: auth, payload: { ...fingerprint, items: [] } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'invalid_completion');
  console.log('OK  S2 leere items -> 400');

  // R1
  await chunk(4, 'vier', token(4));
  r = await app.inject({ method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/release`, headers: { authorization: 'Bearer fremd-token' }, payload: { claims: [{ chunkId: `${PROJEKT}-c4`, claimToken: token(4) }] } });
  assert.equal(r.statusCode, 403);
  r = await app.inject({ method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/release`, headers: auth, payload: { claims: [{ chunkId: `${PROJEKT}-c4`, claimToken: token(9) }] } });
  assert.deepEqual(r.json().freigegeben, []);
  assert.equal((await zeile(4)).claimed_by, NODE, 'falsches Token darf nichts freigeben');
  r = await app.inject({ method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/release`, headers: auth, payload: { claims: [{ chunkId: `${PROJEKT}-c4`, claimToken: token(4) }] } });
  assert.deepEqual(r.json().freigegeben, [`${PROJEKT}-c4`]);
  const z4 = await zeile(4);
  assert.equal(z4.claimed_by, null);
  assert.equal(z4.claim_token, null);
  console.log('OK  R1 Freigabe: fremder Knoten 403, falsches Token nichts, eigenes Token frei');
  console.log('ALLE PRUEFUNGEN GRUEN');
} finally {
  await aufraeumen().catch(() => {});
  await app.close();
  await core.closePool?.();
  qdrant.close();
}
