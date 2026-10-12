/** P6-T24: Vollstaendige Golden-Ausgaben, isoliert und ohne Loeschen von Testdaten. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(dbUrl.port, '5433', 'nur Test-Instanz');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_MODEL = 'fake-embed';
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';
const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(dist, ...teile)).href);
const cw = await lade('services', 'code-write.js');
const fv = await lade('services', 'file-versions.js');
const db = await lade('db', 'client.js');
const pool = db.getPool();
const PROJECT = 'test-p6-t24-' + randomUUID();
const AGENT = 'sol-2-p6-test';
const TASK = randomUUID();
const FILE = 'golden.txt';
const capture = process.argv.includes('--capture');
const normalisiere = (value) => JSON.parse(JSON.stringify(value, (key, val) => {
  if (key === 'project' && val === PROJECT) return '<testprojekt>';
  if (key === 'id' && typeof val === 'string') return '<id>';
  if (key === 'created_at') return '<zeit>';
  return val;
}));
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  if (capture) {
    const plans = await lade('services', 'plans.js');
    assert.equal(plans.resolveProjectTaskId, undefined, 'Golden nur mit Build vor P6-T24 erfassen');
  }
  await pool.query(
    'INSERT INTO plans (id, project, name, kurz_id, aktiv, tasks) VALUES ($1,$2,$3,$4,true,$5::jsonb)',
    [randomUUID(), PROJECT, 'P6-T24 Testplan', 'P6', JSON.stringify([
      { id: TASK, title: 'Testtask', status: 'todo', kurz_id: 'P6-T24' }
    ])]);
  await pool.query('INSERT INTO projects (name, hostname, path) VALUES ($1,$2,$3)', [PROJECT, 'p6-t24-test', join(hier, 'fixtures')]);
  const create = await cw.createFileInPg(PROJECT, FILE, 'eins\n', AGENT, 'Golden create');
  const update = await cw.updateFileInPg(PROJECT, FILE, 'zwei\n', AGENT, 'update', undefined, 'Golden update');
  // Diff-Nachberechnung schreibt nebenlaeufig. Vor der Messung auf den gespeicherten Stand warten.
  await fv.listFileVersions(PROJECT, FILE);
  for (let i = 0; i < 50; i++) {
    const pending = await pool.query('SELECT count(*)::int AS n FROM file_versions WHERE project=$1 AND diff IS NULL', [PROJECT]);
    if (pending.rows[0].n === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const versions = await fv.listFileVersions(PROJECT, FILE);
  const history = await fv.listFileHistory(PROJECT, { file_path: FILE });
  const version = await fv.getFileVersion(versions[0].id);
  const golden = normalisiere({ create, update, versions, history, version });
  if (capture) {
    console.error('GOLDEN_JSON=' + JSON.stringify(golden));
  } else {
    assert.equal(JSON.stringify(golden), readFileSync(join(hier, 'fixtures', 'file-version-task-id-p6-t24.golden.json'), 'utf8').trim(), 'ohne task_id byte-gleiche normalisierte Ausgabe');
    console.error('OK Golden: create/update/versions/history/get_version byte-gleich');
    await cw.updateFileInPg(PROJECT, FILE, 'drei\n', AGENT, 'update', undefined, 'Task write', { task_id: 'P6-T24' });
    const tagged = await fv.listFileHistory(PROJECT, { task_id: 'P6-T24' });
    assert.equal(tagged.length, 1, 'Filter liefert nur die zugeordnete Version');
    assert.equal(tagged[0].file_path, FILE);
    assert.deepEqual(await fv.listFileVersions(PROJECT, FILE, 50, TASK), tagged, 'UUID- und Kurz-ID-Filter gleich');
    const before = await pool.query('SELECT content, content_hash FROM code_files WHERE project=$1 AND file_path=$2', [PROJECT, FILE]);
    const count = Number((await pool.query('SELECT count(*) AS n FROM file_versions WHERE project=$1', [PROJECT])).rows[0].n);
    await assert.rejects(cw.updateFileInPg(PROJECT, FILE, 'ungueltig\n', AGENT, 'update', undefined, undefined, { task_id: 'P999-T999' }), /nicht gefunden/);
    assert.deepEqual((await pool.query('SELECT content, content_hash FROM code_files WHERE project=$1 AND file_path=$2', [PROJECT, FILE])).rows, before.rows);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM file_versions WHERE project=$1', [PROJECT])).rows[0].n), count);
    console.error('OK Task-Filter und ungueltige Task ohne Mutation');
    const fb = await lade('services', 'file-batch.js');
    const resolver = await lade('services', 'task-id-resolver.js');
    assert.equal(await resolver.resolveProjectTaskId(PROJECT, ' p6-t24 '), TASK);
    await assert.rejects(resolver.resolveProjectTaskId(PROJECT + '-fremd', TASK), /nicht gefunden/);
    await assert.rejects(resolver.resolveProjectTaskId(PROJECT, '  '), /leer/);
    const TASK2 = randomUUID();
    await pool.query('INSERT INTO plans (id,project,name,kurz_id,aktiv,tasks) VALUES ($1,$2,$3,$4,false,$5::jsonb)',
      [randomUUID(), PROJECT, 'Inaktiver Plan', 'P7', JSON.stringify([
        { id: TASK2, title: 'Task zwei', status: 'todo', kurz_id: 'P7-T1', alias_kurz_ids: ['P3-T9'] }
      ])]);
    assert.equal(await resolver.resolveProjectTaskId(PROJECT, 'p3-t9'), TASK2);

    const mutationStand = async () => (await pool.query(
      'SELECT (SELECT count(*) FROM file_versions WHERE project=$1) AS versionen, (SELECT count(*) FROM file_batch_plans WHERE project=$1) AS plaene',
      [PROJECT])).rows;
    const stand = await mutationStand();
    await assert.rejects(fb.planBatch({ project: PROJECT, agent_id: AGENT, task_id: 'P999-T999',
      ops: [{ action: 'create', file_path: 'ungueltig.txt', content: 'x' }] }), /nicht gefunden/);
    assert.deepEqual(await mutationStand(), stand);

    const plan = await fb.planBatch({ project: PROJECT, agent_id: AGENT, task_id: 'P6-T24',
      ops: [{ action: 'create', file_path: 'plan.txt', content: 'a\nb\n' }] });
    assert.equal((await fb.getBatchPlan(plan.plan_id)).ops[0].task_id, TASK);
    assert.equal((await fb.commitBatch({ plan_id: plan.plan_id, agent_id: AGENT })).success, true);
    const replan = await fb.planBatch({ project: PROJECT, agent_id: AGENT, task_id: 'P6-T24',
      ops: [{ action: 'search_replace', file_path: 'plan.txt', search: 'a', replace: 'A' },
        { action: 'search_replace', file_path: 'plan.txt', search: 'b', replace: 'B', task_id: 'P7-T1' }] });
    const stored = await fb.getBatchPlan(replan.plan_id);
    await assert.rejects(fb.replanBatch({ project: PROJECT, plan_id: replan.plan_id, agent_id: AGENT, op_index: 0,
      ops: [{ ...stored.ops[0], task_id: 'P999-T999' }] }), /nicht gefunden/);
    assert.deepEqual((await fb.getBatchPlan(replan.plan_id)).ops, stored.ops);
    const committed = await fb.commitBatch({ plan_id: replan.plan_id, agent_id: AGENT });
    assert.equal(committed.success, true, JSON.stringify(committed));
    const attribution = await pool.query('SELECT task_id FROM file_versions WHERE project=$1 AND batch_id=$2 ORDER BY task_id', [PROJECT, replan.plan_id]);
    assert.deepEqual(attribution.rows.map((x) => x.task_id).sort(), [TASK, TASK2].sort(), 'je Task ein Snapshot bei derselben Datei');
    const fallback = await fb.planBatch({ project: PROJECT, agent_id: AGENT,
      ops: [{ action: 'search_replace', file_path: 'plan.txt', search: 'A', replace: 'AA' }] });
    assert.equal((await fb.commitBatch({ plan_id: fallback.plan_id, agent_id: AGENT, task_id: 'P7-T1' })).success, true);
    assert.equal((await pool.query('SELECT task_id FROM file_versions WHERE project=$1 AND batch_id=$2', [PROJECT, fallback.plan_id])).rows[0].task_id, TASK2);
    await cw.copyFileInPg(PROJECT, FILE, 'copy.txt', AGENT, 'P6-T24');
    assert.equal((await pool.query("SELECT task_id FROM file_versions WHERE project=$1 AND file_path='copy.txt'", [PROJECT])).rows[0].task_id, TASK);
    await fv.restoreFileVersion(tagged[0].id, AGENT, 'Task restore', 'P7-T1');
    await fv.restoreBatch(fallback.plan_id, AGENT, 'Task restore batch', 'P6-T24');
    const nullDiff = await pool.query(
      'INSERT INTO file_versions (project,file_path,content,content_hash,edit_action,agent_id,batch_id,size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [PROJECT, 'rollback-invalid.txt', 'vorher\n', cw.contentHash('vorher\n'), 'test', AGENT, fallback.plan_id, 7]);
    await assert.rejects(fv.restoreBatch(fallback.plan_id, AGENT, 'ungueltig', 'P999-T999'), /nicht gefunden/);
    // Die Ablehnung muss auch den Diff-Zustand einer neuen Testversion unveraendert lassen.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await pool.query('SELECT diff FROM file_versions WHERE id=$1', [nullDiff.rows[0].id])).rows[0].diff, null);
    console.error('OK Resolver/Projektbindung/Alias, Plan/Per-Op/Commit/Restore/Copy');

    await cw.createFileInPg(PROJECT, 'coedit.txt', 'alpha\nbeta\n', AGENT);
    const primary = await fb.planBatch({ project: PROJECT, agent_id: AGENT, task_id: 'P6-T24',
      ops: [{ action: 'search_replace', file_path: 'coedit.txt', search: 'alpha', replace: 'ALPHA' }] });
    const PEER = 'sol-2-p6-peer';
    const peerOps = [{ action: 'search_replace', file_path: 'coedit.txt', search: 'beta', replace: 'BETA', task_id: 'P7-T1' }];
    const peerPlan = await fb.planBatch({ project: PROJECT, agent_id: PEER, ops: peerOps });
    const wait = peerPlan.coedit_waits?.[0];
    assert.ok(wait, 'Co-Edit-Wait vorhanden');
    const coeditStand = (await fb.getBatchPlan(primary.plan_id)).ops;
    await assert.rejects(fb.addCoeditContribution({ project: PROJECT, plan_id: primary.plan_id, agent_id: PEER,
      wait_token: wait.wait_token, ops: [{ ...peerOps[0], task_id: 'P999-T999' }] }), /nicht gefunden/);
    assert.deepEqual((await fb.getBatchPlan(primary.plan_id)).ops, coeditStand);
    await fb.addCoeditContribution({ project: PROJECT, plan_id: primary.plan_id, agent_id: PEER,
      wait_token: wait.wait_token, ops: peerOps });
    await fb.markCoeditReady({ project: PROJECT, plan_id: primary.plan_id, agent_id: PEER });
    assert.equal((await fb.commitBatch({ plan_id: primary.plan_id, agent_id: AGENT })).success, true);
    const peerAttribution = await pool.query('SELECT task_id FROM file_versions WHERE project=$1 AND batch_id=$2', [PROJECT, primary.plan_id]);
    assert.deepEqual(peerAttribution.rows.map((x) => x.task_id).sort(), [TASK, TASK2].sort());
    await assert.rejects(fv.restoreFileVersion(tagged[0].id, AGENT, 'ungültig', ''), /leer/);
    console.error('OK Co-Edit: Task-Bezug beider Agenten und ungueltiger Beitrag ohne Mutation');

    // Beide Tool-Adapter mit echten Writes in genau dieser Test-DB.
    const repo = join(hier, '..', '..', '..');
    const { filesTool } = await import(pathToFileURL(join(repo, 'packages/mcp-server/dist/tools/consolidated/files.js')).href);
    const { handleToolCall } = await import(pathToFileURL(join(repo, 'packages/rest-api/dist/routes/mcp.js')).href);
    for (const [name, call] of [
      ['mcp', (args) => filesTool.handler(args)],
      ['rest', (args) => handleToolCall('files', args, AGENT)],
      ['batch', (args) => handleToolCall('files_batch', args, AGENT)]
    ]) {
      const args = { project: PROJECT, agent_id: AGENT, task_id: 'P6-T24' };
      const file = name + '.txt';
      if (name === 'batch') {
        const planned = await call({ ...args, action: 'plan', ops: [{ action: 'create', file_path: file, content: 'x\n' }] });
        assert.equal((await call({ ...args, action: 'commit', plan_id: planned.plan_id })).success, true);
      } else {
        assert.equal((await call({ ...args, action: 'create', file_path: file, content: 'x\n' })).success, true);
        assert.equal((await call({ ...args, action: 'search_replace', file_path: file, search: 'x', replace: 'y' })).success, true);
        const rows = (await call({ ...args, action: 'versions', file_path: file })).versions;
        assert.equal(rows.length, 2, name + ' versions Task-Filter');
        const history = await call({ ...args, action: 'history', file_path: file });
        assert.equal(history.entries.length, 2, name + ' history Task-Filter');
        assert.equal((await call({ ...args, action: 'move', file_path: file, new_path: name + '-moved.txt' })).success, true);
        assert.equal((await call({ ...args, action: 'delete', file_path: name + '-moved.txt' })).success, true);
      }
    }
    console.error('OK MCP/REST/files_batch: Task-Weitergabe bei echten Schreibwegen');

  }
} finally {
  await db.closePool();
}
console.error('P6-T24: alle Pruefungen bestanden.');
process.exit(0); // Importierte Tool-Adapter halten Hintergrund-Timer offen.
