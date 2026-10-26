/** P6-T37: Autorenreservierungen nach fruehem Commit; nur synapse_test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(dbUrl.port, '5433', 'nur Test-Instanz');
const here = new URL('.', import.meta.url);
const dist = process.env.PLAENE_TEST_DIST || fileURLToPath(new URL('../dist/', here));
const load = (...parts) => import(pathToFileURL(join(dist, ...parts)).href);
const batch = await load('services', 'file-batch.js');
const reservations = await load('services', 'file-reservations.js');
const events = await load('services', 'events.js');
const pool = (await load('db', 'client.js')).getPool();
const project = 'test-p6-t37-' + randomUUID();
const created = [];
const plan = async (agent, file, content, extra = {}, anchor = 'seed') => {
  const result = await batch.planBatch({
    project, agent_id: agent, ...extra,
    ops: [{ file_path: file, action: 'update', content, anchor_text: anchor }]
  });
  created.push(result.plan_id);
  return result;
};
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'p6t37-test', '/tmp']);

  // Basisdateien
  const seed = await batch.planBatch({
    project, agent_id: 'p6t37-seed',
    ops: [
      { file_path: 'outsider.txt', action: 'create', content: 'seed outsider\n' },
      { file_path: 'coedit.txt', action: 'create', content: 'seed coedit\n' }
    ]
  });
  created.push(seed.plan_id);
  assert.equal((await batch.commitBatch({ plan_id: seed.plan_id, agent_id: 'coordinator' })).success, true);

  // Fremder Commit: Autoren-Reservierung wird nach Commit mit dem neuen Hash planlos fortgeführt.
  const author = 'p6t37-author';
  const foreign = await plan(author, 'outsider.txt', 'committed by coordinator\n');
  await reservations.addFileReservations({ project, agentId: author, filePaths: ['outsider.txt'], planId: foreign.plan_id });
  const foreignCommit = await batch.commitBatch({ plan_id: foreign.plan_id, agent_id: 'coordinator' });
  assert.equal(foreignCommit.success, true);
  const held = (await reservations.listFileReservations({ project, agentId: author, filePaths: ['outsider.txt'] }))[0];
  const file = (await pool.query('SELECT content_hash FROM code_files WHERE project=$1 AND file_path=$2', [project, 'outsider.txt'])).rows[0];
  assert.equal(held.plan_id, null);
  assert.equal(held.content_hash_at_reservation, file.content_hash);
  assert.ok(new Date(held.expires_at).getTime() > Date.now());
  assert.ok(new Date(held.expires_at).getTime() <= Date.now() + 5 * 60_000 + 10_000);
  const authorEvents = await events.getPendingEvents(project, author, 100);
  const foreignEvent = authorEvents.find((event) => event.eventType === 'PLAN_COMMITTED' && event.payload?.includes(foreign.plan_id));
  assert.ok(foreignEvent, 'persistentes PLAN_COMMITTED-Event fuer Autor');
  const payload = JSON.parse(foreignEvent.payload);
  assert.equal(payload.committed_by, 'coordinator');
  assert.ok(payload.version_ids.length > 0);
  assert.equal(payload.reservierungen[0].content_hash_at_reservation, file.content_hash);
  assert.match(payload.hinweis, /anchor_text\/expected_hashes sind ungueltig/);
  assert.match(payload.hinweis, /reservation_release/);

  // P25-T15: Die rebasierte Autorenreservierung ist planlos. Seit P6-T48 (13.10.2026) wartet C daran nicht mehr,
  // sondern plant sofort mit reservation_hint (vorher: Wait, erst die Freigabe machte C planbar).
  const waiter = 'p6t37-waiter';
  const waiting = await plan(waiter, 'outsider.txt', 'waiter content\n', {}, 'committed by coordinator');
  const activeWait = await pool.query(
    `SELECT wait_token FROM file_batch_waits
      WHERE project=$1 AND waiting_agent=$2 AND primary_agent=$3
        AND status IN ('waiting','linked') AND shared_files @> ARRAY['outsider.txt']::text[]`,
    [project, waiter, author],
  );
  assert.ok(activeWait.rows.length === 0 && waiting.total_ops === 1 && waiting.reservation_hint?.files?.[0]?.reserviert_von === author,
    'P25-T15 file-batch-commit-rebase-p6-t37.test.mjs: C plant trotz planloser Autorenreservierung sofort mit Hinweis (P6-T48): '
    + JSON.stringify({ waits: activeWait.rows.length, total_ops: waiting.total_ops, hint: waiting.reservation_hint }));
  await reservations.releaseFileReservations({ project, agentId: author, filePaths: ['outsider.txt'] });
  const cPlan = await pool.query(
    `SELECT id::text AS id FROM file_batch_plans
      WHERE project=$1 AND owner_agent_id=$2 AND status='open' AND ops @> '[{"file_path":"outsider.txt"}]'::jsonb
      ORDER BY id DESC LIMIT 1`,
    [project, waiter],
  );
  assert.ok(cPlan.rows.length > 0, 'C hat nach der Freigabe einen offenen Plan auf outsider.txt');

  // Co-Edit: B committet den gemeinsamen Plan, bevor A ready ist; A behaelt seine Reservierung.
  const coauthorA = 'p6t37-coauthor-a';
  const coauthorB = 'p6t37-coauthor-b';
  const shared = await plan(coauthorA, 'coedit.txt', 'coedit committed by B\n', { open_for_coedit: true });
  await pool.query(
    `UPDATE file_batch_plans SET ops = jsonb_set(ops, '{0,agent_id}', to_jsonb($2::text), true)
      WHERE id=$1::bigint`,
    [shared.plan_id, coauthorB],
  );
  await reservations.addFileReservations({ project, agentId: coauthorA, filePaths: ['coedit.txt'], planId: shared.plan_id });
  const coeditCommit = await batch.commitBatch({ plan_id: shared.plan_id, agent_id: coauthorB });
  assert.equal(coeditCommit.success, true);
  const coeditHeld = (await reservations.listFileReservations({ project, agentId: coauthorA, filePaths: ['coedit.txt'] }))[0];
  const coeditFile = (await pool.query('SELECT content_hash FROM code_files WHERE project=$1 AND file_path=$2', [project, 'coedit.txt'])).rows[0];
  assert.equal(coeditHeld.plan_id, null);
  assert.equal(coeditHeld.content_hash_at_reservation, coeditFile.content_hash);
  const coeditEvents = await events.getPendingEvents(project, coauthorA, 100);
  const coeditEvent = coeditEvents.find((event) => event.eventType === 'PLAN_COMMITTED' && event.payload?.includes(shared.plan_id));
  assert.ok(coeditEvent, 'frueher Commit informiert den noch nicht fertigen Autor persistent');

  console.log('OK P6-T37: Fremd- und Coedit-Commit rebased Autorenreservierungen, Event persistent, Freigabe weckt Wartenden');
} finally {
  for (const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_event_acks','agent_events','tool_calls','thoughts']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [project]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await pool.end().catch(() => {});
}
