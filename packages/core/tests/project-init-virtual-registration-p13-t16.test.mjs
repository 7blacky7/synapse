import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestFixtureCleanup } from './_helfer/test-fixture-cleanup.mjs';

const dbUrl = new URL(process.env.DATABASE_URL ?? '');
assert.equal(dbUrl.pathname, '/synapse_test', 'P13-T16 darf nur synapse_test verwenden');
assert.equal(dbUrl.port, '5433', 'P13-T16 darf nur die Test-DB verwenden');

const cleanup = createTestFixtureCleanup();
const project = 'p13t16_' + randomUUID().replaceAll('-', '').slice(0, 16);
const oldRoot = process.env.SYNAPSE_WORKSPACE_ROOT;
const oldBridgeDisabled = process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED;
let core;
let worker;
try {
  core = await import('../dist/index.js');
  const { startProjectInitWorker } = await import('../../file-watcher-daemon-ts/dist/project-init-worker.js');
  const pool = core.getPool();

  const root = await cleanup.createRoot('synapse-p13-t16-');
  await mkdir(join(root, project));
  process.env.SYNAPSE_WORKSPACE_ROOT = root;
  process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED = '1';

  const manager = { register: async () => undefined };
  worker = await startProjectInitWorker(manager);

  async function runInit() {
    const { id } = await core.enqueueProjectInitJob({ name: project, hostname: os.hostname(), requested_by: 'p13-t16-test' });
    const until = Date.now() + 8_000;
    let job;
    do {
      job = await core.getProjectInitJob(id);
      if (job?.status === 'done' || job?.status === 'failed' || job?.status === 'rejected') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    assert.equal(job?.status, 'done', `Init-Job muss erfolgreich enden: ${JSON.stringify(job)}`);
  }

  await runInit();
  const firstRows = await core.getProjectRegistryRows(project);
  assert.ok(firstRows.some(row => row.hostname === os.hostname()), 'lokale Host-Registry muss vorhanden sein');
  assert.ok(firstRows.some(row => row.hostname === 'rest-api' && row.path === '/virtual/rest-api'), 'REST-Registry muss sofort vorhanden sein');

  await runInit();
  const secondRows = await core.getProjectRegistryRows(project);
  assert.equal(secondRows.filter(row => row.hostname === 'rest-api').length, 1, 'wiederholtes Init darf keine REST-Duplikate erzeugen');
  assert.equal(secondRows.filter(row => row.hostname === os.hostname()).length, 1, 'wiederholtes Init darf keine lokale Duplikate erzeugen');

  console.log('P13-T16 GRUEN: virtuelle REST-Registrierung sofort sichtbar und wiederholtes Init idempotent.');
} finally {
  await worker?.stop();
  if (core) {
    const pool = core.getPool();
    await pool.query('DELETE FROM project_init_jobs WHERE name = $1', [project]);
    await pool.query('DELETE FROM projects WHERE name = $1', [project]);
    await core.closePool();
  }
  if (oldRoot === undefined) delete process.env.SYNAPSE_WORKSPACE_ROOT;
  else process.env.SYNAPSE_WORKSPACE_ROOT = oldRoot;
  if (oldBridgeDisabled === undefined) delete process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED;
  else process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED = oldBridgeDisabled;
  await cleanup.cleanup();
  cleanup.dispose();
}
