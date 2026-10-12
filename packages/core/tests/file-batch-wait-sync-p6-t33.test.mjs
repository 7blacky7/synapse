/** P6-T33: optionale, daemonbestaetigte auf_platte-Antwort; nur synapse_test. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(dbUrl.port, '5433', 'nur Test-Instanz');
const here = new URL('.', import.meta.url);
const dist = process.env.PLAENE_TEST_DIST || fileURLToPath(new URL('../dist/', here));
const load = (...parts) => import(pathToFileURL(join(dist, ...parts)).href);
const batch = await load('services', 'file-batch.js');
const bridge = await load('services', 'daemon-bruecke.js');
const pool = (await load('db', 'client.js')).getPool();
const project = 'test-p6-t33-' + randomUUID();
const host = 'p6t33-test-daemon';
const agent = 'p6t33-agent';
const content = 'P6-T33 disk confirmation\n';
const hash = createHash('sha256').update(content, 'utf8').digest('hex');

let stop = false;
let daemon;
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, host, '/tmp/p6t33']);
  bridge.meldeDaemonStatus(host, []);
  process.env.SYNAPSE_COMMIT_WAIT_SYNC_MAX_SECONDS = '0.3';
  let fehlt = false;
  daemon = (async () => {
    while (!stop) {
      const commands = await bridge.holeDaemonBefehle(host, 100);
      for (const command of commands) {
        assert.equal(command.befehl, 'sync_datei');
        // Vor plan/commit fehlt die Datei. Erst ein sichtbarer PG-Commit wird synchronisiert.
        const committed = await pool.query('SELECT content_hash FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [project, command.args.file_path]);
        bridge.meldeDaemonAntwort(host, command.id, {
          success: true,
          action: 'sync_datei',
          platte: fehlt || !committed.rows.length ? { existiert: false } : { existiert: true, sha256: committed.rows[0].content_hash },
        });
      }
    }
  })();

  const plan = await batch.planBatch({
    project,
    agent_id: agent,
    ops: [{ file_path: 'sync-target.txt', action: 'create', content }],
  });
  const result = await batch.commitBatch({ plan_id: plan.plan_id, agent_id: agent, wait_sync: true });
  assert.equal(result.success, true);
  assert.equal(result.files[0].auf_platte, 'ja', 'gleicher Hash auf dem Daemon bestaetigt ja');

  fehlt = true;
  const missingPlan = await batch.planBatch({project,agent_id:agent,ops:[{file_path:'missing.txt',action:'create',content}]});
  const missing = await batch.commitBatch({plan_id:missingPlan.plan_id,agent_id:agent,wait_sync:true});
  stop = true;
  await daemon;
  assert.equal(missing.success,true);
  assert.equal(missing.files[0].auf_platte,'nein','Daemon bestätigt fehlende Datei: bekannt nicht synchronisiert');
  console.log('OK P6-T33/T41: gleicher Hash ja, bestätigt fehlende Datei nein');
} finally {
  stop = true;
  await daemon;
  bridge.vergissDaemons();
  for (const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls','thoughts']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=$1', [project]).catch(() => {});
  }
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await pool.end().catch(() => {});
}
