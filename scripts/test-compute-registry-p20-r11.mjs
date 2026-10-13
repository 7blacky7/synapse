import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const require = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const { Pool } = createRequire(new URL('../packages/core/package.json', import.meta.url))('pg');
const admin = new Pool({ connectionString: url.href });
const SCHEMA = 'p20_r11';
await admin.query('CREATE SCHEMA IF NOT EXISTS p20_r11');
const db = new Pool({ connectionString: url.href, options: '-c search_path=p20_r11,public' });
const mode = process.argv[2] ?? 'verify';
const goldenPath = new URL('./fixtures/p20-r11-legacy.golden.json', import.meta.url);
Object.assign(process.env, {
  OLLAMA_MODEL: 'p20-r11-fixture', SYNAPSE_OLLAMA_MODEL_DIGEST: 'a'.repeat(64),
  SYNAPSE_OLLAMA_NATIVE_DIMENSION: '8', EMBEDDING_TARGET_DIM: '4', EMBEDDING_NUM_CTX: '512',
  SYNAPSE_GPU_REQUIRED_TOTAL_MB: '100', SYNAPSE_GPU_REQUIRED_FREE_MB: '50',
  EMBEDDING_QUERY_PREFIX: 'q: ', EMBEDDING_DOC_PREFIX: 'd: ', SYNAPSE_NODE_MAX_CLAIMS: '2',
  OLLAMA_URL: 'http://127.0.0.1:9', SYNAPSE_API_FEATURES: 'compute_resources',
});
globalThis.fetch = async () => { throw new Error('synthetische Probe ohne Netzwerk'); };
const core = await import('../packages/core/dist/index.js');
const { createEmbeddingNodeRoutes } = await import('../packages/rest-api/dist/routes/embedding-nodes.js');
const Fastify = require('fastify');
const tokens = new Map(['a', 'b'].map(id => [id, { kind: 'service', scope: 'compute-node:p20-r11-' + id, token_hash: 'p20-r11-' + id }]));
tokens.set('wrong-hash', { kind: 'service', scope: 'compute-node:p20-r11-a', token_hash: 'unbound-hash' });
const app = Fastify();
await app.register(createEmbeddingNodeRoutes({ db, validateToken: async id => tokens.get(id) ?? null }));
const boot = '11111111-1111-4111-8111-111111111111';
const fp = { model: process.env.OLLAMA_MODEL, modelDigest: 'a'.repeat(64), nativeDimension: 8, targetDimension: 4, numCtx: 512 };
const registration = id => ({ ...fp, nodeId: 'p20-r11-' + id, host: 'fixture', ollamaUrl: 'http://127.0.0.1:9',
  vramTotalMb: 1000, vramFreeMb: 0, maxConcurrency: 2, bootId: boot, bootStartedAt: '2026-01-01T00:00:00.000Z' });
const heartbeat = sequence => ({ ...fp, status: 'ready', vramFreeMb: 0, activeJobs: 0, bootId: boot, sequence });
const send = (method, path, payload, token = 'a', headers = {}) => app.inject({
  method, url: '/api/embedding-nodes/' + path, headers: { authorization: 'Bearer ' + token, ...headers }, ...(payload === undefined ? {} : { payload }),
});
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
    [key, ['serverTime','server_now','boot_started_at','registriert_am','letzter_kontakt','aktualisiert_am','bis','seit'].includes(key) ? '<zeit>' : stable(v)]));
  return value;
}
const snapshot = {};
async function capture(name, method, path, payload) {
  const r = await send(method, path, payload);
  snapshot[name] = { status: r.statusCode, body: stable(r.json()) };
  return r;
}
try {
  await db.query('DROP TABLE IF EXISTS p20_r11.embedding_knoten');
  // Altstand-DDL, unveränderte Registry-Grundlage mit eigenem Testbereich.
  const source = readFileSync(new URL('../packages/core/src/db/schema-sql/45_modelle_embedding.sql', import.meta.url), 'utf8');
  const table = source.match(/CREATE TABLE public.embedding_knoten \([\s\S]*?\n\);/)[0].replace('public.embedding_knoten', 'p20_r11.embedding_knoten');
  await db.query(table);
  await db.query('CREATE UNIQUE INDEX ON p20_r11.embedding_knoten(node_id)');
  if (mode !== 'record' && mode !== 'red') {
    const ddl = readFileSync(new URL('../packages/core/src/db/schema-sql/46_compute_ressourcen.sql', import.meta.url), 'utf8');
    await db.query(ddl); await db.query(ddl); // additive/idempotente Migration
  }
  await capture('reference', 'GET', 'reference');
  assert.equal((await capture('register', 'POST', 'register', registration('a'))).statusCode, 201);
  await capture('self', 'GET', 'p20-r11-a/self');
  await capture('heartbeat', 'POST', 'p20-r11-a/heartbeat', heartbeat(1));
  // Keine fremden Testprojekte claimen; Legacy-Antwort bei pausierter Vergabe.
  core.pausiereWorker('gpu_knoten', { dauer_min: 5, grund: 'p20_r11', von: 'sol-5' });
  await capture('claims', 'POST', 'p20-r11-a/claims', { limit: 1 });
  await capture('complete', 'POST', 'p20-r11-a/claims/complete', {});
  await capture('release', 'POST', 'p20-r11-a/claims/release', { claims: [] });
  if (mode === 'record') { console.log('GOLDEN=' + JSON.stringify(snapshot)); }
  else if (mode === 'red') {
    const r = await send('GET', 'p20-r11-a/self', undefined, 'a', { 'x-synapse-contract-version': '1' });
    assert.equal(r.json().node.contractVersion, 1, 'R1.1 fehlt am Altstand');
  } else {
    assert.equal(JSON.stringify(snapshot), JSON.stringify(JSON.parse(readFileSync(goldenPath, 'utf8'))), 'Legacy bytegleich nach Laufzeitnormalisierung');
    process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS = JSON.stringify({
      'p20-r11-a': { hostResourceDomain: 'fixture-host', deviceIds: ['GPU-fixture'], location: 'pc' },
      'p20-r11-b': { hostResourceDomain: 'fixture-host', deviceIds: ['GPU-fixture'], location: 'pc' },
    });
    const negotiated = { 'x-synapse-contract-version': '1' };
    const fixedEnv = { ...process.env, SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS: '1000' };
    const fixed = core.parseComputeNodeExtension({ contractVersion: 1, features: [], resources: {
      cpu: { loadPercent: { value: 10, measuredAt: '2026-01-01T00:00:00Z', scope: 'container', quality: 'measured',
        serverReceivedAt: 'forged', freshness: 'fresh' } } } }, 'p20-r11-a', fixedEnv, '2026-01-01T00:00:00.100Z');
    assert.equal(fixed.resources.cpu.loadPercent.serverReceivedAt, '2026-01-01T00:00:00.100Z');
    assert.equal(fixed.resources.cpu.loadPercent.freshness, 'fresh');
    assert.equal(core.computeResourceSnapshot(fixed.resources, Date.parse('2026-01-01T00:00:02Z'), fixedEnv).cpu.loadPercent.freshness, 'stale');
    assert.equal(fixed.resources.cpu.cores.value, null);
    assert.equal(core.computePhysicalDeviceKey(core.computeResourceBinding('p20-r11-a'), 'GPU-fixture'),
      core.computePhysicalDeviceKey(core.computeResourceBinding('p20-r11-b'), 'GPU-fixture'));
    assert.throws(() => core.parseComputeNodeExtension({ contractVersion: 1, resources: { gpus: [
      { deviceId: 'GPU-fixture' }, { deviceId: 'GPU-fixture' }] } }, 'p20-r11-a'));
    assert.throws(() => core.parseComputeNodeExtension({ contractVersion: 1, resources: { cpu: {
      cores: { value: 12 } } } }, 'p20-r11-a'));

    let r = await send('GET', 'p20-r11-a/self', undefined, 'a', negotiated);
    assert.equal(r.json().node.resources, null, 'Legacy-Messung bleibt unknown');
    const measurement = (value, scope = 'device') => ({ value, measuredAt: new Date().toISOString(), scope, quality: 'measured' });
    const extra = { contractVersion: 1, features: ['compute_resources', 'unbekannt'], capabilityRevision: 2, policyRevision: 3,
      location: 'pc', hostResourceDomain: 'fixture-host', capabilities: [{ id: 'custom.future', profileRef: { scope: 'test', id: 'profile', revision: '1', sha256: 'f'.repeat(64) } }],
      resources: { cpu: { cores: measurement(16, 'container') }, ram: { totalMb: measurement(2048, 'container') },
        gpus: [{ deviceId: 'GPU-fixture', totalMb: measurement(1000), freeMb: measurement(0), residentOwnModelMb: measurement(900), utilizationPercent: measurement(10), origin: 'fixture-probe' }] } };
    for (const id of ['a', 'b']) {
      r = await send('POST', 'register', { ...registration(id), ...extra }, id);
      assert.equal(r.statusCode, 201, r.body);
    }
    const row = (await db.query('SELECT * FROM embedding_knoten WHERE node_id=$1', ['p20-r11-a'])).rows[0];
    assert.deepEqual(row.features, ['compute_resources']); assert.equal(row.capability_revision, '2');
    assert.equal(row.ressourcen.ram.totalMb.scope, 'container');
    assert.equal(row.ressourcen.ram.availableMb.value, null);
    assert.ok(row.ressourcen.gpus[0].totalMb.serverReceivedAt);
    assert.equal(row.ressourcen.gpus[0].freeMb.value, 0, 'echte Null bleibt Null');
    const devices = await db.query("SELECT COUNT(DISTINCT host_resource_domain || ':' || (ressourcen->'gpus'->0->>'deviceId')) AS n FROM embedding_knoten");
    assert.equal(devices.rows[0].n, '1', 'zwei Prozesse sind ein physisches Gerät');
    r = await send('GET', 'p20-r11-a/self', undefined, 'a', negotiated);
    assert.equal(r.json().node.contractVersion, 1); assert.equal(r.json().node.usable, true, 'freier VRAM sperrt nicht');
    r = await send('GET', 'reference', undefined, 'a', negotiated);
    assert.ok(!r.body.includes('fixture-host') && !r.body.includes('resources'), 'keine private Last öffentlich');
    for (const change of [{ hostResourceDomain: 'forged' }, { resources: { gpus: [{ deviceId: 'forged' }] } }]) {
      r = await send('POST', 'register', { ...registration('a'), ...extra, ...change });
      assert.equal(r.statusCode, 400, r.body);
    }
    const before = (await db.query('SELECT ressourcen FROM embedding_knoten WHERE node_id=$1', ['p20-r11-a'])).rows[0];
    for (const [body, token] of [
      [{ ...heartbeat(2), ...extra, bootId: '22222222-2222-4222-8222-222222222222' }, 'a'],
      [{ ...heartbeat(0), ...extra }, 'a'], [{ ...heartbeat(2), ...extra }, 'b'],
      [{ ...heartbeat(2), ...extra }, 'wrong-hash'],
    ]) assert.ok((await send('POST', 'p20-r11-a/heartbeat', body, token)).statusCode >= 400);
    assert.deepEqual((await db.query('SELECT ressourcen FROM embedding_knoten WHERE node_id=$1', ['p20-r11-a'])).rows[0], before);
    r = await send('POST', 'p20-r11-a/heartbeat', { ...heartbeat(2), ...extra });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await send('POST', 'p20-r11-a/heartbeat', { ...heartbeat(1), ...extra })).statusCode, 409);
    await db.query("UPDATE embedding_knoten SET gesperrt_vom_user=true WHERE node_id='p20-r11-a'");
    assert.equal((await send('GET', 'p20-r11-a/self', undefined, 'a', negotiated)).json().node.usable, false);
    console.log('R1.1 grün: sieben Legacy-Goldens, Unknown/Scope/Gerätebindung/Fences/Usersperre, idempotentes DDL');
  }
} finally {
  await app.close(); await db.query('DROP TABLE IF EXISTS p20_r11.embedding_knoten');
  await db.end(); await admin.end(); await core.getPool().end();
}
