/**
 * P22-T219 (Stresstest P22-T214 B4, Befund dad9b3e8): task_zuordnen mit plan_id vor dem Commit.
 * Ursache belegt: plan_update verliert die task_id nicht; task_zuordnen trifft nur committete Versionen.
 * Prueft: Folgeplan nach plan_update traegt die Task bis in file_versions; offener, ersetzter und
 * unbekannter Plan liefern eine verstaendliche Meldung mit fertigem Aufruf. Nur synapse_test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.pathname, '/synapse_test');
assert.equal(url.port, '5433');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_MODEL = 'fake-embed';
const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', 'dist');
const db = await import(join(core, 'db/client.js'));
const { filesTool } = await import(join(here, '../../mcp-server/dist/tools/consolidated/files.js'));
const pool = db.getPool();
const P = 'test-p22-t219-' + randomUUID();
const A = 'sol-t219-tasktest';
const T = randomUUID();
const call = (args) => filesTool.handler({ project: P, agent_id: A, ...args });
const tasks = async (batch) => (await pool.query('SELECT task_id FROM file_versions WHERE project=$1 AND batch_id=$2 ORDER BY id', [P, batch])).rows.map((r) => r.task_id);
let checks = 0;
const ok = (n) => console.error('PASS ' + (++checks) + ' ' + n);
try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [P, 'test', join(here, 'fixtures')]);
  await pool.query('INSERT INTO plans(id,project,name,kurz_id,tasks) VALUES($1,$2,$3,$4,$5::jsonb)',
    [randomUUID(), P, 'T219', 'P9', JSON.stringify([{ id: T, kurz_id: 'P9-T1', title: 'Zuordnung', status: 'todo' }])]);
  const base = await call({ action: 'create', file_path: 'spaet.ts', content: 'a\nb\nc\nz10\n', task_id: 'P9-T1' });
  assert.equal(base.success, true, JSON.stringify(base));

  // Wie stress-10: Plan mit task_id, eine Zeilen-Op scheitert am Anker -> plan_update ohne task_id -> Folgeplan.
  const failed = await call({ action: 'plan', task_id: 'P9-T1', ops: [
    { action: 'replace_lines', file_path: 'spaet.ts', line_start: 1, line_end: 1, anchor_text: 'z10', content: 'z10 // marke' }] });
  assert.equal(failed.error, 'plan_failed', JSON.stringify(failed));
  const update = await call({ action: 'plan_update', plan_id: failed.plan_id, op_index: 0, ops: [
    { action: 'replace_lines', file_path: 'spaet.ts', line_start: 4, line_end: 4, anchor_text: 'z10', content: 'z10 // marke' }] });
  assert.equal(update.success, true, JSON.stringify(update));
  assert.equal(update.task_geerbt, T, 'plan_update meldet die geerbte Task');
  assert.ok(!Object.hasOwn(update, 'warnung_task') && !Object.hasOwn(update, 'hinweis_task'), 'keine falsche Task-Warnung: ' + JSON.stringify(update.warnung_task));
  const folge = String(update.plan_id);
  const opTask = (await pool.query("SELECT ops->0->>'task_id' AS t FROM file_batch_plans WHERE id=$1", [folge])).rows[0].t;
  assert.equal(opTask, T, 'plan_update uebernimmt die task_id der Op');
  ok('plan_update behaelt task_id der Op (' + (folge === String(failed.plan_id) ? 'gleicher Plan' : 'Folgeplan ' + folge) + ')');

  // Vor dem Commit: verstaendliche Meldung mit fertigem Aufruf statt 'Version(en) nicht gefunden'.
  await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P9-T1', plan_id: folge }), (e) => {
    assert.match(e.message, new RegExp(`Plan ${folge} ist noch nicht committet \\(status \\w+\\)`));
    assert.ok(e.message.includes(`files(action:"commit", plan_id:"${folge}", task_id:"P9-T1")`), e.message);
    assert.ok(!/Version\(en\) nicht gefunden/.test(e.message), e.message);
    return true;
  });
  ok('task_zuordnen vor Commit nennt Status und commit-Aufruf');

  if (folge !== String(failed.plan_id)) {
    await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P9-T1', plan_id: String(failed.plan_id) }), (e) => {
      assert.match(e.message, new RegExp(`durch Folgeplan ${folge} ersetzt`));
      assert.ok(e.message.includes(`plan_id:"${folge}"`), e.message);
      return true;
    });
    ok('ersetzter Plan verweist auf den Folgeplan');
  }

  const commit = await call({ action: 'commit', plan_id: folge });
  assert.equal(commit.success, true, JSON.stringify(commit));
  assert.ok(!Object.hasOwn(commit, 'warnung_task'), 'keine Task-Warnung');
  const vt = await tasks(folge);
  assert.ok(vt.length > 0 && vt.every((t) => t === T), 'committete Versionen tragen die Task: ' + JSON.stringify(vt));
  ok('commit -> file_versions.task_id gesetzt');
  const nach = await call({ action: 'task_zuordnen', task_id: 'P9-T1', plan_id: folge });
  assert.equal(nach.success, true);
  assert.deepEqual(nach.version_ids, [], 'schon zugeordnet, nichts geaendert');
  ok('task_zuordnen nach Commit erfolgreich (unveraendert)');

  // Offener Plan ohne Task: Hinweis nennt commit mit task_id; danach hat die Version die Task.
  const offen = await call({ action: 'plan', ops: [{ action: 'create', file_path: 'neu.txt', content: 'neu\n' }] });
  await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P9-T1', plan_id: String(offen.plan_id) }), /noch nicht committet/);
  const c2 = await call({ action: 'commit', plan_id: String(offen.plan_id), task_id: 'P9-T1' });
  assert.equal(c2.success, true, JSON.stringify(c2));
  assert.ok((await tasks(String(offen.plan_id))).every((t) => t === T));
  ok('vorgeschlagener commit mit task_id wirkt');

  // Unbekannte ID: alte Meldung bleibt erkennbar, mit Zusatz.
  await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P9-T1', plan_id: '999999999999' }), /weder Versionen noch einen Plan/);
  await assert.rejects(call({ action: 'task_zuordnen', task_id: 'P9-T1', version_ids: ['999999999999'] }), /Version\(en\) nicht gefunden in diesem Projekt$/);

  // In-Place-Update ohne task_id (offener Plan ohne gescheiterte Op) erbt ebenfalls; fremde Task wird nicht erfunden.
  const ip = await call({ action: 'plan', task_id: 'P9-T1', ops: [{ action: 'create', file_path: 'inplace.txt', content: 'x\n' }] });
  const ipu = await call({ action: 'plan_update', plan_id: String(ip.plan_id), op_index: 0, ops: [{ action: 'create', file_path: 'inplace.txt', content: 'y\n' }] });
  assert.equal(ipu.success, true, JSON.stringify(ipu));
  assert.equal((await pool.query("SELECT ops->0->>'task_id' AS t FROM file_batch_plans WHERE id=$1", [String(ipu.plan_id)])).rows[0].t, T);
  const ohne = await call({ action: 'plan', ops: [{ action: 'create', file_path: 'ohne.txt', content: 'x\n' }] });
  const ohneU = await call({ action: 'plan_update', plan_id: String(ohne.plan_id), op_index: 0, ops: [{ action: 'create', file_path: 'ohne.txt', content: 'y\n' }] });
  assert.ok(!Object.hasOwn(ohneU, 'task_geerbt'), 'ohne Plan-Task wird nichts geerbt');
  assert.match(ohneU.warnung_task || '', /task_id fehlt/, 'Warnung bleibt, wenn wirklich keine Task da ist');
  ok('In-Place-Update erbt; ohne Plan-Task bleibt die Warnung');
  ok('unbekannte plan_id/version_ids');
  console.error(`P22-T219: ${checks} Pruefungen gruen.`);
} finally { await db.closePool(); }
process.exit(0);
