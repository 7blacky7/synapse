#!/usr/bin/env node
// test-worker-pause-claims.mjs — P15-T12 E1: GPU-Knoten pausieren ueber die Worker-Steuerung, gegen die TEST-DB.
//   P1 gpu_knoten pausiert -> POST /claims liefert success:true, claims:[], pausiert{bis,grund}; der offene Chunk
//      bleibt unberuehrt (claimed_by NULL)
//   P2 waehrend der Pause bleibt der Abschluss offen: ein vorher vergebener Claim wird per /claims/complete fertig
//      (keine verwaisten Claims)
//   P3 nach worker_fortsetzen kommen wieder Claims (ohne pausiert-Feld); sie werden danach freigegeben
// Aufruf: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node scripts/test-worker-pause-claims.mjs
// Braucht gebautes packages/core/dist und packages/rest-api/dist.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

import { pruefeTestDbUrl } from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-worker-pause-claims');

// Fake-Qdrant: nimmt alles an.
const qdrant = http.createServer((req, res) => {
  let roh = '';
  req.on('data', (d) => { roh += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && /^\/collections\/[^/]+$/.test((req.url ?? '').split('?')[0])) {
      return res.end(JSON.stringify({ status: 'ok', result: { status: 'green', points_count: 0, config: { params: { vectors: { size: 4, distance: 'Cosine' } } } } }));
    }
    res.end(JSON.stringify({ status: 'ok', result: { status: 'completed', operation_id: 1 } }));
  });
});
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));

const DIGEST = 'e'.repeat(64);
const NODE = 'p15-pause-knoten';
const PROJEKT = 'p15-pause-test';
Object.assign(process.env, {
  QDRANT_URL: `http://127.0.0.1:${qdrant.address().port}`,
  EMBEDDING_PROVIDER: 'ollama',
  OLLAMA_URL: 'http://127.0.0.1:9',
  OLLAMA_MODEL: 'p15-pause-modell:latest',
  SYNAPSE_OLLAMA_MODEL_DIGEST: DIGEST,
  SYNAPSE_OLLAMA_NATIVE_DIMENSION: '8',
  EMBEDDING_TARGET_DIM: '4',
  EMBEDDING_NUM_CTX: '512',
  SYNAPSE_GPU_REQUIRED_TOTAL_MB: '100',
  SYNAPSE_GPU_REQUIRED_FREE_MB: '50',
  EMBEDDING_QUERY_PREFIX: 'q: ',
  EMBEDDING_DOC_PREFIX: 'd: ',
  EMBEDDING_MAX_INPUT_CHARS: '1000',
  SYNAPSE_NODE_MAX_CLAIMS: '4',
});

const requireFromRest = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const Fastify = requireFromRest('fastify');
const core = await import('../packages/core/dist/index.js');
const { createEmbeddingNodeRoutes } = await import('../packages/rest-api/dist/routes/embedding-nodes.js');
const pool = core.getPool();

const tokens = new Map([['node-token', { token_hash: 'hash-p15-pause', kind: 'service', scope: `compute-node:${NODE}` }]]);
const app = Fastify({ logger: false });
await app.register(createEmbeddingNodeRoutes({ db: pool, validateToken: async (t) => tokens.get(t) ?? null }));
const auth = { authorization: 'Bearer node-token' };
const fingerprint = { model: process.env.OLLAMA_MODEL, modelDigest: DIGEST, quantization: null, nativeDimension: 8, targetDimension: 4, numCtx: 512 };
const ctoken = (n) => `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;

const aufraeumen = async () => {
  await pool.query('UPDATE code_chunks SET claimed_by = NULL, claim_token = NULL, lease_until = NULL WHERE claimed_by = $1 AND embedded_at IS NULL', [NODE]);
  await pool.query('DELETE FROM code_chunks WHERE project = $1', [PROJEKT]);
  await pool.query('DELETE FROM code_files WHERE project = $1', [PROJEKT]);
  await pool.query('DELETE FROM projects WHERE name = $1', [PROJEKT]);
  await pool.query('DELETE FROM embedding_knoten WHERE node_id = $1', [NODE]);
  await pool.query('DELETE FROM auth_tokens WHERE token_hash = $1', ['hash-p15-pause']);
};
const zeile = async (nr) => (await pool.query('SELECT embedded_at, claimed_by FROM code_chunks WHERE id = $1', [`${PROJEKT}-c${nr}`])).rows[0];

try {
  await aufraeumen();
  if ((await core.leseSchalter('embedding')).aktiv) {
    console.log('SKIP: PG-Schalter embedding in der Test-DB aktiv (claimEmbeddingChunks liefert dann immer leer)');
    process.exitCode = 0;
  } else {
    await pool.query(`INSERT INTO auth_tokens (token_hash, kind, scope, label) VALUES ($1, 'service', $2, 'p15-pause-test')`, ['hash-p15-pause', `compute-node:${NODE}`]);
    let r = await app.inject({
      method: 'POST', url: '/api/embedding-nodes/register', headers: auth,
      payload: {
        nodeId: NODE, host: 'test', ollamaUrl: 'http://127.0.0.1:11435', ...fingerprint, quantization: undefined,
        vramTotalMb: 1000, vramFreeMb: 900, bootId: '00000001-1111-4111-8111-111111111111',
        bootStartedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    await pool.query(`INSERT INTO projects (name, hostname, path, enabled) VALUES ($1, 'test', '/tmp/p15-pause-test', true)`, [PROJEKT]);
    await pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type) VALUES ($1, $2, 'src/a.ts', 'a.ts', 'typescript')`, [`${PROJEKT}-f`, PROJEKT]);
    // c1: offen; c2: vor der Pause an den Knoten vergeben
    await pool.query(`INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end) VALUES ($1, $2, 'src/a.ts', 1, 'offen', 1, 1)`, [`${PROJEKT}-c1`, PROJEKT]);
    await pool.query(
      `INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end, content_hash, claim_token, claimed_by, lease_until)
       VALUES ($1, $2, 'src/a.ts', 2, 'vergeben', 1, 1, $3, $4, $5, NOW() + INTERVAL '5 minutes')`,
      [`${PROJEKT}-c2`, PROJEKT, core.embeddingContentHash('vergeben'), ctoken(2), NODE],
    );

    // P1
    const p = core.pausiereWorker('gpu_knoten', { dauer_min: 5, grund: 'Test P15-T12', von: 'test' });
    assert.equal(p.pausiert.length, 1);
    r = await app.inject({ method: 'POST', url: `/api/embedding-nodes/${NODE}/claims`, headers: auth, payload: { limit: 4 } });
    assert.equal(r.statusCode, 200, r.body);
    const p1 = r.json();
    assert.equal(p1.success, true);
    assert.deepEqual(p1.claims, []);
    assert.equal(p1.pausiert.grund, 'Test P15-T12');
    assert.ok(Date.parse(p1.pausiert.bis) > Date.now());
    assert.equal((await zeile(1)).claimed_by, null, 'offener Chunk darf waehrend der Pause nicht vergeben werden');
    console.log('OK  P1 pausiert: claims [] + pausiert{bis,grund}, offener Chunk unberuehrt');

    // P2
    r = await app.inject({
      method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/complete`, headers: auth,
      payload: { ...fingerprint, items: [{ chunkId: `${PROJEKT}-c2`, claimToken: ctoken(2), contentHash: core.embeddingContentHash('vergeben'), vector: [0.5, 0.5, 0.5, 0.5] }] },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().abgeschlossen, [`${PROJEKT}-c2`]);
    assert.ok((await zeile(2)).embedded_at, 'laufender Claim wurde abgeschlossen');
    console.log('OK  P2 waehrend der Pause: vorher vergebener Claim per complete abgeschlossen');

    // P3
    core.setzeWorkerFort('gpu_knoten', 'test');
    r = await app.inject({ method: 'POST', url: `/api/embedding-nodes/${NODE}/claims`, headers: auth, payload: { limit: 4 } });
    assert.equal(r.statusCode, 200, r.body);
    const p3 = r.json();
    assert.equal(p3.pausiert, undefined);
    assert.ok(p3.claims.length >= 1, 'nach dem Fortsetzen wieder Claims: ' + r.body);
    r = await app.inject({
      method: 'POST', url: `/api/embedding-nodes/${NODE}/claims/release`, headers: auth,
      payload: { claims: p3.claims.map((c) => ({ chunkId: c.chunkId, claimToken: c.claimToken })) },
    });
    assert.equal(r.statusCode, 200, r.body);
    console.log(`OK  P3 fortgesetzt: ${p3.claims.length} Claim(s), danach freigegeben`);
    console.log('ALLE PRUEFUNGEN GRUEN');
  }
} finally {
  core.setzeWorkerFort('alle');
  await aufraeumen().catch(() => {});
  await app.close();
  await core.closePool?.();
  qdrant.close();
}
