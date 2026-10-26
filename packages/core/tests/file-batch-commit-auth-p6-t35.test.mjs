/** P6-T35: Commit-Berechtigung; nur synapse_test. */
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
const pool = (await load('db', 'client.js')).getPool();
const project = 'test-p6-t35-' + randomUUID();
const owner = 'p6t35-owner';
const outsider = 'p6t35-outsider';
const created = [];
const stableOwnerReply = (result) => ({
  keys: Object.keys(result).filter((key) => !key.startsWith('embeddings_')).sort(),
  file_keys: (result.files || []).map((file) => Object.keys(file).sort()),
  success: result.success,
  committed: result.committed,
  committed_ops: result.committed_ops,
  auf_platte: result.files?.[0]?.auf_platte,
  sync_hinweis: result.sync_hinweis,
});
// P25-T15: P6-T44 (13.10.2026, 'fs_pruefung nach commit ehrlich') ergaenzt die commit-Antwort gewollt um fs_pruefung.
const ownerGolden = {
  keys: ['batch_id', 'committed', 'committed_ops', 'files', 'fs_pruefung', 'plan_id', 'success', 'sync_hinweis'],
  file_keys: [['auf_platte', 'created', 'file_path', 'hash', 'size']],
  success: true,
  committed: 1,
  committed_ops: 1,
  auf_platte: 'unbekannt',
  sync_hinweis: 'PG->FS-Sync laeuft asynchron; ohne lokale Daemon-Bestaetigung ist auf_platte unbekannt. Vor lokaler Ausfuehrung kurz warten.',
};
const assertDeniedWithoutWrites = async (planId, caller) => {
  const before = await pool.query(
    'SELECT (SELECT count(*) FROM file_versions WHERE project=$1) AS versions, (SELECT status::text FROM file_batch_plans WHERE id=$2) AS status',
    [project, planId],
  );
  const reply = await batch.commitBatch({ plan_id: planId, ...(caller ? { agent_id: caller } : {}) });
  assert.equal(reply.success, false);
  assert.equal(reply.error, 'fremder_plan');
  assert.equal((await pool.query('SELECT status::text AS status FROM file_batch_plans WHERE id=$1', [planId])).rows[0].status, 'open');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_versions WHERE project=$1', [project])).rows[0].n, Number(before.rows[0].versions));
  return reply;
};
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'p6t35-test', '/tmp']);

  // Unbeteiligte Agenten einschliesslich fehlender agent_id: keine Mutation, Plan bleibt offen.
  const ownPlan = await batch.planBatch({ project, agent_id: outsider, ops: [{ file_path: 'own.txt', action: 'create', content: 'own\n' }] });
  const foreign = await batch.planBatch({ project, agent_id: owner, ops: [{ file_path: 'foreign.txt', action: 'create', content: 'foreign\n' }] });
  const denied = await assertDeniedWithoutWrites(foreign.plan_id, outsider);
  assert.equal(denied.owner_agent_id, owner);
  assert.ok(denied.eigene_offene_plaene.some((plan) => plan.plan_id === ownPlan.plan_id));
  await pool.query(
    `UPDATE file_batch_plans SET ops = jsonb_set(ops, '{0,agent_id}', to_jsonb($2::text), true) WHERE id=$1::bigint`,
    [foreign.plan_id, 'p6t35-other-author'],
  );
  await assertDeniedWithoutWrites(foreign.plan_id, undefined);

  // Koordinator darf einen fremden Plan committen.
  const coordinatorPlan = await batch.planBatch({ project, agent_id: owner, ops: [{ file_path: 'coordinator.txt', action: 'create', content: 'coord\n' }] });
  assert.equal((await batch.commitBatch({ plan_id: coordinatorPlan.plan_id, agent_id: 'coordinator' })).success, true);

  // Beteiligter Wait-Agent darf committen.
  const participant = 'p6t35-participant';
  const shared = await batch.planBatch({ project, agent_id: owner, open_for_coedit: true, ops: [{ file_path: 'shared.txt', action: 'create', content: 'shared\n' }] });
  await pool.query(
    `INSERT INTO file_batch_waits (source_plan_id, project, waiting_agent, primary_agent, shared_files, deferred_ops,
       deferred_op_indexes, primary_plan_id, status, expires_at)
     VALUES ($1::bigint,$2,$3,$4,ARRAY['shared.txt']::text[],'[]'::jsonb,'{}'::int[],$1::bigint,'ready',NOW()+INTERVAL '1 hour')`,
    [shared.plan_id, project, participant, owner],
  );
  assert.equal((await batch.commitBatch({ plan_id: shared.plan_id, agent_id: participant })).success, true);

  // Owner-Erfolgsausgabe entspricht der am Altstand erfassten Golden-Projektion.
  const ownerPlan = await batch.planBatch({ project, agent_id: owner, ops: [{ file_path: 'owner.txt', action: 'create', content: 'owner\n' }] });
  const ownerReply = await batch.commitBatch({ plan_id: ownerPlan.plan_id, agent_id: owner });
  assert.deepEqual(stableOwnerReply(ownerReply), ownerGolden);

  assert.equal((await pool.query('SELECT count(*)::int AS n FROM file_versions WHERE project=$1', [project])).rows[0].n, 3);
  console.log('OK P6-T35: fremder/no-id verweigert, Owner/Wait-Beteiligter/Koordinator erlaubt, Owner-Golden byte-stabil');
} finally {
  for (const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls','thoughts']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [project]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await pool.end().catch(() => {});
}
