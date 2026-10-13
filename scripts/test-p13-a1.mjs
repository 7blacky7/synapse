// P13-T19: echte Projekt-Route, isoliertes Schema und Projekt p13_a1, ausschließlich synapse_test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/invalid');
assert.equal(url.pathname, '/synapse_test', 'A1-Tests brauchen synapse_test');
const schema = 'p13_a1_' + process.pid;
url.searchParams.set('options', '-c search_path=' + schema);
process.env.DATABASE_URL = url.href;
const { getPool, closePool } = await import('../packages/core/dist/db/client.js');
const require = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const Fastify = require('fastify');
const { projectRoutes } = await import('../packages/rest-api/dist/routes/projects.js');
const pool = getPool();
const app = Fastify();
let created = false;
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query('CREATE SCHEMA ' + schema);
  created = true;
  await pool.query('CREATE TABLE projects (name text, hostname text, path text, enabled boolean, last_access timestamptz)');
  await pool.query('INSERT INTO projects VALUES ($1,$2,$3,$4,$5)', [
    'p13_a1', 'p13-a1-host', '/home/blacky/dev/p13_a1', true, '2020-01-02T03:04:05Z',
  ]);
  await app.register(projectRoutes);
  const legacy = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(legacy.statusCode, 200);
  if (process.argv.includes('--capture')) {
    console.log(legacy.payload);
  } else {
    const golden = (await readFile(new URL('./fixtures/p13-a1-projects.golden.json', import.meta.url), 'utf8')).trimEnd();
    assert.equal(legacy.payload, golden, 'Alt-Client-Antwort muss bytegleich bleiben');
    if (!process.argv.includes('--golden')) {
      const c = await import('../packages/core/dist/vertrag/api-vertrag.js');
      const known = new Set(['asset_sync', 'future_feature']);
      assert.equal(c.parseApiContract(undefined, known), undefined);
      assert.equal(c.parseApiContract({}, known), undefined);
      assert.equal(c.parseApiContract({ contractVersion: 99, features: ['asset_sync'] }, known), undefined);
      const parsed = c.parseApiContract({
        contractVersion: 1, features: ['asset_sync', 'unknown', 'future_feature', 'asset_sync'],
        capabilityRevision: 0, policyRevision: 3, extra: 'ignored',
      }, known);
      assert.deepEqual(parsed, { contractVersion: 1, features: ['asset_sync', 'future_feature'], capabilityRevision: 0, policyRevision: 3 });
      assert.throws(() => c.parseApiContract({ contractVersion: 1, features: ['asset_sync', 3] }, known));
      assert.throws(() => c.parseApiContract({ contractVersion: 1, features: [], policyRevision: -1 }, known));
      assert.throws(() => c.parseApiContract({ contractVersion: 1, features: [], capabilityRevision: null }, known));
      assert.equal(c.apiCapabilitiesForClient(undefined, {}), undefined);
      const env = {
        SYNAPSE_API_FEATURE_CATALOG: 'asset_sync,custom_feature',
        SYNAPSE_API_FEATURES: 'custom_feature,unknown,asset_sync',
        SYNAPSE_API_POLICY_REVISION: '4', SYNAPSE_API_CAPABILITY_REVISION: '2',
      };
      assert.deepEqual(c.apiCapabilitiesForClient('1', env), {
        contractVersion: 1, features: ['custom_feature', 'asset_sync'], capabilityRevision: 2, policyRevision: 4,
      });
      assert.deepEqual(c.apiCapabilitiesForClient('1', {}).features, []);
      assert.equal(c.apiCapabilitiesForClient('99', env), undefined);
      const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
      Object.assign(process.env, env);
      try {
        const modern = await app.inject({ method: 'GET', url: '/api/projects', headers: { [c.API_CONTRACT_HEADER]: '1' } });
        const result = modern.json();
        assert.deepEqual(result.capabilities, c.apiCapabilitiesForClient('1', env));
        delete result.capabilities;
        assert.equal(JSON.stringify(result), golden, 'Neue Antwort behält alle Alt-Felder');
        const after = await app.inject({ method: 'GET', url: '/api/projects' });
        assert.equal(after.payload, golden, 'Auch mit aktivierten Features bleibt Legacy bytegleich');
        const future = await app.inject({ method: 'GET', url: '/api/projects', headers: { [c.API_CONTRACT_HEADER]: '99' } });
        assert.equal(future.payload, golden, 'Unbekannte Vertragsversion wird nicht als kompatibel ausgegeben');
      } finally {
        for (const [k,v] of Object.entries(saved)) v === undefined ? delete process.env[k] : process.env[k] = v;
      }
      const daemon = await import('../packages/file-watcher-daemon-ts/dist/api-vertrag.js');
      assert.equal(daemon.parseApiContract, c.parseApiContract, 'Daemon benutzt denselben Core-Parser');
    }
    console.log('P13-T19 p13_a1: Golden/Vertrag grün');
  }
} finally {
  await app.close();
  if (created) await pool.query('DROP SCHEMA ' + schema + ' CASCADE');
  await closePool();
}
