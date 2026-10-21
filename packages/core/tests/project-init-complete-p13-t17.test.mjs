import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestFixtureCleanup } from './_helfer/test-fixture-cleanup.mjs';
import { oeffneGeschuetzteShellTestDb } from '../../../scripts/lib/test-db-schutz.mjs';

const cleanup = createTestFixtureCleanup();
const db = await oeffneGeschuetzteShellTestDb();
let core;
const originalWorkspaceRoot = process.env.SYNAPSE_WORKSPACE_ROOT;
const originalBridgeDisabled = process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED;
const names = [
  'p13t17_' + randomUUID().replaceAll('-', '').slice(0, 16),
  'p13t17_' + randomUUID().replaceAll('-', '').slice(0, 16),
];

try {
  await db.query('SELECT 1');
  core = await import('../dist/index.js');
  const { mitLesePool } = await import('../dist/db/client.js');
  const worker = await import('../../file-watcher-daemon-ts/dist/project-init-worker.js');
  const enabledSync = await import('../../file-watcher-daemon-ts/dist/enabled-sync.js');
  const root = await cleanup.createRoot('synapse-p13-t17-');
  process.env.SYNAPSE_WORKSPACE_ROOT = root;
  process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED = '1';

  const [successName, failureName] = names;
  const successPath = join(root, successName);
  const failurePath = join(root, failureName);
  await Promise.all([mkdir(successPath), mkdir(failurePath)]);

  const configured = [];
  const discovered = [];
  const manager = {
    register: async (name, projectPath) => { configured.push({ name, projectPath }); },
    discoverFromRegistry: (rows) => { discovered.push(...rows); },
  };
  const queueJob = async (name) => {
    const result = await db.query(
      'INSERT INTO project_init_jobs (name, hostname, requested_by) VALUES ($1, $2, $3) RETURNING *',
      [name, os.hostname(), 'p13-t17-test'],
    );
    return result.rows[0];
  };

  const successfulJob = await queueJob(successName);
  await mitLesePool(db, () => worker.processProjectInitJob(successfulJob, manager));

  const completed = await db.query(
    'SELECT status, resolved_path, error FROM project_init_jobs WHERE id = $1',
    [successfulJob.id],
  );
  assert.equal(completed.rows[0]?.status, 'done', 'Init ist nur nach vollstaendiger Einrichtung erledigt');
  assert.equal(completed.rows[0]?.resolved_path, successPath);

  const registry = await db.query(
    'SELECT hostname, path FROM projects WHERE name = $1 ORDER BY hostname',
    [successName],
  );
  assert.ok(registry.rows.some((row) => row.hostname === os.hostname() && row.path === successPath), 'lokale PG-Registry muss den Projektpfad fuehren');
  assert.ok(registry.rows.some((row) => row.hostname === 'rest-api' && row.path === '/virtual/rest-api'), 'REST-Registry muss vorhanden sein');
  assert.deepEqual(configured, [{ name: successName, projectPath: successPath }], 'Daemon-Manager muss vor Erfolg registriert sein');

  const statusPath = join(successPath, '.synapse', 'status.json');
  const initialStatus = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(initialStatus.project, successName);
  assert.equal(initialStatus.setupPhase, 'initial-pending', 'frisches Projekt bekommt denselben Setup-Startzustand wie lokales init');

  const phase = await db.query('SELECT setup_phase FROM project_setup_status WHERE project = $1', [successName]);
  assert.equal(phase.rows[0]?.setup_phase, 'initial-pending', 'PG bleibt Quelle fuer setupPhase');

  await mitLesePool(db, () => core.setSetupPhase(successName, 'complete', { updatedBy: 'p13-t17-test' }));
  await enabledSync.synchronisiereProjektCache(manager, [
    { name: successName, path: successPath, enabled: true, setup_phase: 'complete' },
  ]);
  assert.deepEqual(discovered, [{ name: successName, pfad: successPath, enabled: true }], 'PG-Snapshot muss an die Registry-Entdeckung des Daemons gehen');
  const completedStatus = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(completedStatus.setupPhase, 'complete', 'Daemon-Sync aktualisiert den status.json-Cache aus PG');

  const failedManager = { register: async () => { throw new Error('config write failed'); } };
  const failedJob = await queueJob(failureName);
  await mitLesePool(db, () => worker.processProjectInitJob(failedJob, failedManager));

  const failed = await db.query(
    'SELECT status, error, message FROM project_init_jobs WHERE id = $1',
    [failedJob.id],
  );
  assert.equal(failed.rows[0]?.status, 'failed', 'Config-/Watcher-Fehler darf nicht als erfolgreicher Init gelten');
  assert.match(failed.rows[0]?.message ?? '', /config write failed/);
  assert.equal(configured.length, 1, 'fehlgeschlagene Registrierung darf keinen Erfolg vortaeuschen');

  console.log('P13-T17 GRUEN: PG-Registry, Daemon-Registrierung, Setup-Cache und ehrlicher Teilerfolg.');
} finally {
  try {
    await db.query('DELETE FROM project_init_jobs WHERE name = ANY($1::text[])', [names]);
    await db.query('DELETE FROM project_setup_status WHERE project = ANY($1::text[])', [names]);
    await db.query('DELETE FROM projects WHERE name = ANY($1::text[])', [names]);
  } finally {
    if (originalWorkspaceRoot === undefined) delete process.env.SYNAPSE_WORKSPACE_ROOT;
    else process.env.SYNAPSE_WORKSPACE_ROOT = originalWorkspaceRoot;
    if (originalBridgeDisabled === undefined) delete process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED;
    else process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED = originalBridgeDisabled;
    await db.end();
    await cleanup.cleanup();
    cleanup.dispose();
    if (core) await core.closePool();
  }
}
