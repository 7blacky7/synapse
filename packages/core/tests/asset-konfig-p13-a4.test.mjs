import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const load = (...parts) => import(pathToFileURL(join(repo, ...parts)).href);

test('P13-T22 p13_a4: project options upsert one row, bump policy_revision, and enforce operator ceilings', { skip: !process.env.DATABASE_URL }, async () => {
  const raw = process.env.DATABASE_URL;
  const url = new URL(raw);
  assert.equal(url.pathname, '/synapse_test', 'Nur synapse_test');
  assert.equal(url.port, '5433', 'Nur Port 5433');

  const pg = createRequire(join(repo, 'packages/core/package.json'))('pg');
  const admin = new pg.Client({ connectionString: raw });
  let db;
  let schemaCreated = false;
  const schema = 'p13_a4_' + process.pid;
  const project = 'p13_a4';
  try {
    await admin.connect();
    assert.equal((await admin.query('SELECT current_database() AS n')).rows[0].n, 'synapse_test');
    await admin.query('CREATE SCHEMA ' + schema);
    schemaCreated = true;
    await admin.query(`CREATE TABLE ${schema}.asset_projekt_optionen (
      project TEXT PRIMARY KEY,
      richtung TEXT CHECK (richtung IN ('both','pc_to_share','share_to_pc')),
      loeschfenster_ms BIGINT CHECK (loeschfenster_ms >= 0),
      max_datei_bytes BIGINT CHECK (max_datei_bytes >= 0),
      max_projekt_bytes BIGINT CHECK (max_projekt_bytes >= 0),
      max_projekt_dateien BIGINT CHECK (max_projekt_dateien >= 0),
      erlaubte_typen TEXT[],
      policy_revision BIGINT NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    url.searchParams.set('options', '-c search_path=' + schema + ',public');
    process.env.DATABASE_URL = url.toString();
    delete process.env.SYNAPSE_DATABASE_URL;
    Object.assign(process.env, {
      SYNAPSE_AUTH_DISABLED: '1',
      SYNAPSE_SKIP_EMBEDDINGS: '1',
      PARSER_LOOP_DISABLED: '1',
      QDRANT_URL: 'http://127.0.0.1:1',
    });

    const coreDb = await load('packages/core/dist/db/client.js');
    db = coreDb;
    assert.doesNotThrow(() => coreDb.getPool(), 'getPool must load default config before an optional Asset-Intel import');
    await load('packages/core/dist/asset-intel/index.js');
    const configModule = await load('packages/core/dist/config/asset-konfig.js');
    configModule.resetAssetKonfiguration();
    const config = configModule.getAssetKonfiguration();
    const service = await load('packages/core/dist/services/asset-projekt-optionen.js');

    assert.equal(await service.ladeAssetProjektoptionen(project), null);
    const erlaubteTypen = config.speicher.transferFormate.slice(0, 1);
    const first = await service.setzeAssetProjektoptionen(project, {
      richtung: 'share_to_pc',
      restoreWindowMs: 60_000,
      maxDateiBytes: 4096,
      maxProjektBytes: 8192,
      maxProjektDateien: 2,
      erlaubteTypen,
    });
    assert.equal(first.policyRevision, 1);
    assert.deepEqual(first.optionen.erlaubteTypen, erlaubteTypen);

    const loaded = await service.ladeAssetProjektoptionen(project);
    assert.equal(loaded.policyRevision, 1);
    assert.equal(loaded.optionen.richtung, 'share_to_pc');
    assert.equal(loaded.optionen.maxDateiBytes, 4096);

    const second = await service.setzeAssetProjektoptionen(project, { maxDateiBytes: 2048 });
    assert.equal(second.policyRevision, 2);
    const idempotent = await service.setzeAssetProjektoptionen(project, { maxDateiBytes: 2048 });
    assert.equal(idempotent.policyRevision, 2, 'No-op writes must keep the policy revision');

    assert.equal(second.optionen.maxDateiBytes, 2048);
    const count = await coreDb.getPool().query('SELECT count(*)::int AS n FROM asset_projekt_optionen WHERE project=$1', [project]);
    assert.equal(count.rows[0].n, 1);

    await assert.rejects(
      service.setzeAssetProjektoptionen(project, { maxDateiBytes: config.speicher.maxDateiBytes + 1 }),
      /Betreibergrenze/,
    );
    const unchanged = await service.ladeAssetProjektoptionen(project);
    assert.equal(unchanged.policyRevision, 2);
    assert.equal(unchanged.optionen.maxDateiBytes, 2048);
  } finally {
    if (db) await db.closePool();
    if (schemaCreated) await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
});
