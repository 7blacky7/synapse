/** P6-T34: disjunkte Co-Edits und Folgeersetzungen; nur eigene Daten in synapse_test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(url.port, '5433', 'nur Test-Instanz');
const dist = process.env.PLAENE_TEST_DIST || fileURLToPath(new URL('../dist/', import.meta.url));
const batch = await import(pathToFileURL(join(dist, 'services/file-batch.js')).href);
const pool = (await import(pathToFileURL(join(dist, 'db/client.js')).href)).getPool();
const project = 'test-sol3-p6-t34-' + randomUUID();
const owner = project + '-a';
const author = project + '-b';
const seedAgent = project + '-seed';
const baseline = 'KOPF\nANKER-OBEN\nMITTE\nANKER-UNTEN\nFUSS\n';
const sr = (search, replace) => ({ action: 'search_replace', search, replace });
const ia = (after_line, content) => ({ action: 'insert_after', after_line, content });
const results = [];
let sequence = 0;
const read = async (file) => (await pool.query(
  'SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [project, file]
)).rows[0]?.content;
async function scenario(name, first, contributions, expected, conflict = false) {
  const file = 'case-' + (++sequence) + '.txt';
  const withFile = (ops) => ops.map((op) => ({ ...op, file_path: file }));
  const seed = await batch.planBatch({ project, agent_id: seedAgent,
    ops: [{ action: 'create', file_path: file, content: baseline }] });
  assert.equal((await batch.commitBatch({ plan_id: seed.plan_id, agent_id: seedAgent })).success, true);
  const plan = await batch.planBatch({ project, agent_id: owner, ops: withFile(first) });
  assert.ok(plan.plan_id);
  const warnings = [];
  for (const [agent, ops] of contributions) {
    const carrier = await batch.planBatch({ project, agent_id: agent, ops: withFile(ops) });
    assert.ok(carrier.plan_id, JSON.stringify(carrier));
    const added = await batch.addCoeditContribution({ project, plan_id: plan.plan_id, agent_id: agent, ops: withFile(ops) });
    assert.equal(added.success, true, JSON.stringify(added));
    warnings.push(...(added.overlap_warnings ?? []));
  }
  const status = await batch.getBatchPlan(plan.plan_id);
  await batch.markCoeditReady({ project, plan_id: plan.plan_id, agent_id: author });
  const committed = await batch.commitBatch({ plan_id: plan.plan_id, agent_id: owner });
  const actual = await read(file);
  const evidence = { name, plan_id: plan.plan_id, warnings: warnings.map((w) => ({
    reason: w.reason, left: w.left_op_index, right: w.right_op_index
  })), status_warnings: status.overlap_warnings?.length ?? 0, commit: committed.error ?? committed.status ?? committed.success };
  console.log(JSON.stringify(evidence));
  if (conflict) {
    assert.ok(warnings.length > 0 || status.overlap_warnings?.length > 0, 'echte Ueberlappung muss gemeldet werden');
    assert.equal(committed.success, false, JSON.stringify(committed));
    assert.equal(actual, baseline, 'Konflikt darf nichts schreiben');
  } else {
    assert.equal(warnings.length, 0, 'keine falschen Ueberlappungen: ' + JSON.stringify(evidence));
    assert.equal(status.overlap_warnings?.length ?? 0, 0);
    assert.equal(committed.success, true, JSON.stringify(committed));
    assert.equal(actual, expected, 'beide Beitraege genau einmal, exakte Reihenfolge');
  }
}
async function check(name, ...args) {
  try { await scenario(name, ...args); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.error(name + ': ' + error.message); }
}
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'sol3-p6t34-test', '/tmp']);
  await check('disjunkte insert_after', [ia(4, 'NEU-A')], [[author, [ia(2, 'NEU-B')]]],
    'KOPF\nANKER-OBEN\nNEU-B\nMITTE\nANKER-UNTEN\nNEU-A\nFUSS\n');
  await check('replace A plus insert B', [sr('ANKER-UNTEN', 'UNTEN-NEU')],
    [[author, [ia(2, 'NEU-B')]]], 'KOPF\nANKER-OBEN\nNEU-B\nMITTE\nUNTEN-NEU\nFUSS\n');
  // Plan 25209: Op5 fuegt fern ein; Op8 fuegt eigene Zeile ein; Op9 ersetzt diese.
  await check('25209 eigene Folgeersetzung', [sr('ANKER-UNTEN', 'NEU-A\nANKER-UNTEN')],
    [[author, [ia(2, 'export {maske} from "m";')]],
     [author, [sr('export {maske} from "m";', 'export {maske,ausgabe} from "m";')]]],
    'KOPF\nANKER-OBEN\nexport {maske,ausgabe} from "m";\nMITTE\nNEU-A\nANKER-UNTEN\nFUSS\n');
  await check('eigene Folgeersetzung nach search_replace', [sr('ANKER-UNTEN', 'UNTEN-NEU')],
    [[author, [sr('ANKER-OBEN', 'OBEN-NEU')]], [author, [sr('OBEN-NEU', 'OBEN-FERTIG')]]],
    'KOPF\nOBEN-FERTIG\nMITTE\nUNTEN-NEU\nFUSS\n');
  await check('eigene Folgeersetzungskette', [sr('ANKER-UNTEN', 'UNTEN-NEU')],
    [[author, [ia(2, 'NEU-B')]], [author, [sr('NEU-B', 'ZWEITE-B')]], [author, [sr('ZWEITE-B', 'DRITTE-B')]]],
    'KOPF\nANKER-OBEN\nDRITTE-B\nMITTE\nUNTEN-NEU\nFUSS\n');
  await check('reine Einfuegungen am gleichen Punkt', [ia(2, 'NEU-A')], [[author, [ia(2, 'NEU-B')]]],
    'KOPF\nANKER-OBEN\nNEU-B\nNEU-A\nMITTE\nANKER-UNTEN\nFUSS\n');
  await check('Einfuegung auf fremdem neuem Text', [sr('ANKER-OBEN', 'ANKER-OBEN\nNEU-A')],
    [[author, [sr('NEU-A', 'NEU-A\nNEU-B')]]],
    'KOPF\nANKER-OBEN\nNEU-A\nNEU-B\nMITTE\nANKER-UNTEN\nFUSS\n');
  await check('echte Ersetzungsueberlappung', [sr('MITTE', 'X-MITTE-X')], [[author, [sr('MITTE', 'Y-MITTE-Y')]]], undefined, true);
  await check('fremden neuen Text ersetzen bleibt Konflikt', [ia(2, 'NEU-A')],
    [[author, [sr('NEU-A', 'FREMD-ERSETZT')]]], undefined, true);
  await check('eigene Folgeersetzung ueberlappt fremde Aenderung', [sr('ANKER-OBEN', 'X-ANKER-OBEN-X')],
    [[author, [sr('ANKER-OBEN', 'Y-ANKER-OBEN-Y')]], [author, [sr('Y-ANKER-OBEN-Y', 'OBEN-FERTIG')]]], undefined, true);
} finally {
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [project]);
  for (const table of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [project]);
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]);
  await pool.end();
}
console.log(JSON.stringify({ project, cleanup: 'done', results }));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
