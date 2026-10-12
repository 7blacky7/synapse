/** P6-T25/T26: neue Warnung/Audit; Alt-Ausgabe mit Task bleibt bytegleich. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.pathname, '/synapse_test');
assert.equal(url.port, '5433');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';
const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', 'dist');
const db = await import(join(core, 'db/client.js'));
const cw = await import(join(core, 'services/code-write.js'));
const fv = await import(join(core, 'services/file-versions.js'));
const fb = await import(join(core, 'services/file-batch.js'));
const { filesTool } = await import(join(here, '../../mcp-server/dist/tools/consolidated/files.js'));
const { handleToolCall } = await import(join(here, '../../rest-api/dist/routes/mcp.js'));
const pool = db.getPool();
const P = 'test-p6-t26-' + randomUUID();
const A = 'sol-2-tasktest', B = 'anderer-testagent';
const T = randomUUID(), T2 = randomUUID();
const capture = process.argv.includes('--capture');
const call = (args) => filesTool.handler({ project: P, agent_id: A, ...args });
const raw = async (id) => (await pool.query('SELECT task_id FROM file_versions WHERE id=$1', [id])).rows[0].task_id;
try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [P, 'test', join(here, 'fixtures')]);
  await pool.query('INSERT INTO plans(id,project,name,kurz_id,tasks) VALUES($1,$2,$3,$4,$5::jsonb)',
    [randomUUID(), P, 'Task-Test', 'P6', JSON.stringify([
      { id: T, kurz_id: 'P6-T26', title: 'Warnung', status: 'todo' },
      { id: T2, kurz_id: 'P6-T25', title: 'Anzeige', status: 'todo' }
    ])]);
  const tagged = await call({ action: 'create', file_path: 'tagged.txt', content: 'tagged\n', task_id: 'P6-T26' });
  const golden = JSON.stringify(tagged);
  if (capture) console.error('GOLDEN_TAGGED=' + golden);
  else {
    assert.equal(golden, readFileSync(join(here, 'fixtures/file-task-p6-t26.golden.json'), 'utf8').trim());
    const write = await call({ action: 'create', file_path: 'missing.txt', content: 'one\n' });
    assert.match(write.warnung_task || '', /task_id fehlt/);
    assert.equal(write.version_ids.length, 1);
    assert.equal(await raw(write.version_ids[0]), null);
    assert.equal(await cw.getFileContentFromPg(P, 'missing.txt'), 'one\n', 'Write geht durch');
    const old = await cw.createFileInPg(P, 'altbestand.txt', 'old\n', A);
    const before = await pool.query("SELECT id::text AS id FROM file_versions WHERE project=$1 AND file_path='altbestand.txt'", [P]);
    const oldId = before.rows[0].id;
    const ownParallel = await Promise.all(['parallel-a.txt', 'parallel-b.txt'].map((file_path) =>
      call({ action: 'create', file_path, content: 'parallel\n' })));
    for (let i = 0; i < ownParallel.length; i++) {
      assert.equal(ownParallel[i].version_ids.length, 1);
      const path = (await pool.query('SELECT file_path FROM file_versions WHERE id=$1', [ownParallel[i].version_ids[0]])).rows[0].file_path;
      assert.equal(path, ['parallel-a.txt', 'parallel-b.txt'][i], 'Receipt bleibt beim eigenen Aufruf');
    }
    await cw.createFileInPg(P, 'foreign.txt', 'foreign\n', B);
    const foreignId = (await pool.query("SELECT id::text AS id FROM file_versions WHERE project=$1 AND file_path='foreign.txt'", [P])).rows[0].id;
    await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P6-T26', version_ids: [write.version_ids[0], foreignId] }), /berechtigt/);
    assert.equal(await raw(write.version_ids[0]), null, 'gemischter Satz wird vollstaendig abgelehnt');
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM file_version_task_zuordnungen WHERE version_id=$1', [write.version_ids[0]])).rows[0].n), 0);
    const future = await call({ action: 'history', ohne_task: true, agent_filter: A, seit: '2099-01-01' });
    assert.equal(future.entries.length, 0, 'seit begrenzt tasklosen Bestand');
    const entries = await call({ action: 'history', ohne_task: true, agent_filter: A, since: '2000-01-01T00:00:00Z' });
    assert.ok(entries.entries.some((v) => v.id === oldId));
    assert.ok(entries.entries.every((v) => !Object.hasOwn(v, 'task_id')));
    const assignment = await call({ action: 'task_zuordnen', task_id: 'P6-T26', version_ids: write.version_ids, grund: 'Eigene Testversion zuordnen' });
    assert.equal(assignment.success, true);
    assert.equal(await raw(write.version_ids[0]), T);
    assert.equal(await raw(oldId), null, 'Altbestand bleibt unzugeordnet');
    const view = await call({ action: 'get_version', version_id: write.version_ids[0] });
    assert.equal(view.version.task_id, T);
    assert.equal(view.version.task_kurz_id, 'P6-T26');
    const same = await call({ action: 'task_zuordnen', task_id: 'P6-T25', version_ids: write.version_ids });
    assert.equal(await raw(write.version_ids[0]), T, 'bestehende Zuordnung bleibt ohne ueberschreiben');
    await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P6-T25', version_ids: write.version_ids, ueberschreiben: true }), /grund/);
    await call({ action: 'task_zuordnen', task_id: 'P6-T25', version_ids: write.version_ids, ueberschreiben: true, grund: 'Korrigierte Testzuordnung' });
    assert.equal(await raw(write.version_ids[0]), T2);
    const audit = await pool.query('SELECT agent_id, vorher_task_id, task_id, grund, created_at FROM file_version_task_zuordnungen WHERE version_id=$1 ORDER BY id', [write.version_ids[0]]);
    assert.deepEqual(audit.rows.map((r) => r.agent_id), [A, A]);
    assert.equal(audit.rows[1].vorher_task_id, T);
    assert.equal(audit.rows[1].task_id, T2);
    assert.equal(audit.rows[1].grund, 'Korrigierte Testzuordnung');
    assert.ok(audit.rows.every((r) => r.created_at instanceof Date), 'Audit enthaelt Zeitpunkte');
    await assert.rejects(call({ action: 'task_zuordnen', agent_id: B, task_id: 'P6-T26', version_ids: [oldId] }), /berechtigt/);
    await call({ action: 'task_zuordnen', agent_id: 'koordinator', task_id: 'P6-T26', version_ids: [oldId], grund: 'Koordinator-Test' });
    assert.equal(await raw(oldId), T);
    const noTaskPlan = await call({ action: 'plan', ops: [{ action: 'create', file_path: 'plan.txt', content: 'plan\n' }] });
    assert.match(noTaskPlan.warnung_task, /task_id fehlt/);
    const commit = await call({ action: 'commit', plan_id: noTaskPlan.plan_id });
    assert.match(commit.warnung_task, /task_id fehlt/);
    assert.ok(commit.version_ids.length);
    await call({ action: 'task_zuordnen', task_id: 'P6-T26', plan_id: noTaskPlan.plan_id });
    assert.ok((await pool.query('SELECT task_id FROM file_versions WHERE project=$1 AND batch_id=$2', [P, noTaskPlan.plan_id])).rows.every((v) => v.task_id === T));
    const pending = await call({ action: 'plan', ops: [{ action: 'create', file_path: 'pending.txt', content: 'pending\n' }] });
    await call({ action: 'plan_update', plan_id: pending.plan_id, task_id: 'P6-T26', ops: [{ action: 'create', file_path: 'pending.txt', content: 'pending\n' }] });
    const committed = await call({ action: 'commit', plan_id: pending.plan_id });
    assert.ok(!Object.hasOwn(committed, 'warnung_task'), 'Plan-Task uebernommen');
    const probe = await call({ action: 'create', file_path: 'coedit-test/probe.txt', content: 'probe\n' });
    assert.ok(!Object.hasOwn(probe, 'warnung_task'));
    const restore = await call({ action: 'restore', version_id: write.version_ids[0] });
    assert.ok(!Object.hasOwn(restore, 'warnung_task'));
    const noop = await call({ action: 'update', file_path: 'pending.txt', content: 'pending\n' });
    assert.ok(!Object.hasOwn(noop, 'warnung_task'), 'Idempotenter Write ohne neue Version warnt nicht');
    const rest = await handleToolCall('files', { project: P, agent_id: A, action: 'create', file_path: 'rest.txt', content: 'rest\n' }, A);
    assert.match(rest.warnung_task, /task_id fehlt/);
    const restAssign = await handleToolCall('files_batch', { project: P, agent_id: A, action: 'task_zuordnen', task_id: 'P6-T26', version_ids: rest.version_ids }, A);
    assert.equal(restAssign.success, true);
    const versions = await call({ action: 'versions', file_path: 'rest.txt', ohne_task: true, since: '2000-01-01T00:00:00Z' });
    assert.equal(versions.versions.length, 0);
    console.error('P6-T25/T26: Golden, Warnungen, Filter, Rechte, Audit und beide Adapter gruen.');
  }
} finally { await db.closePool(); }
process.exit(0);
