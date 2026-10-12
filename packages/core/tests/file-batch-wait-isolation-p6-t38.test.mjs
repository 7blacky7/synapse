/** P6-T38: Freigabe weckt nur betroffene Waits; Folgefehler aendern keinen erfolgreichen Write. Rotkontrolle vor Fix. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const db = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(db.pathname, '/synapse_test');
assert.equal(db.port, '5433');
const batch = await import('../dist/services/file-batch.js');
const reservations = await import('../dist/services/file-reservations.js');
const write = await import('../dist/services/code-write.js');
const { getPool } = await import('../dist/db/client.js');
const pool = getPool();
const projects = [];
const results = [];
async function scenario(mode, broken = false) {
  const project = 'test-sol3-t38-' + randomUUID();
  projects.push(project);
  const owner = project + '-owner', oldOwner = project + '-old-owner';
  const oldAgent = project + '-old', goodAgent = project + '-good', badAgent = project + '-bad';
  const create = await batch.planBatch({ project, agent_id: owner,
    ops: ['old.txt','good.txt','bad.txt','own.txt'].map(file_path => ({ action:'create', file_path, content:'BASE\n' })) });
  assert.equal((await batch.commitBatch({plan_id:create.plan_id,agent_id:owner})).success,true);
  const waiting = async (agent, holder, file) => {
    await reservations.addFileReservations({project,agentId:holder,filePaths:[file]});
    const p = await batch.planBatch({project,agent_id:agent,
      ops:[{action:'search_replace',file_path:file,search:'BASE',replace:'CHANGED'}]});
    assert.equal(p.total_ops,0);
    assert.ok(p.coedit_waits?.[0]?.wait_token);
    return p.coedit_waits[0].wait_token;
  };
  const oldToken = await waiting(oldAgent,oldOwner,'old.txt');
  const goodToken = await waiting(goodAgent,owner,'good.txt');
  const badToken = broken ? await waiting(badAgent,owner,'bad.txt') : null;
  // Unabhaengiger Alt-Wait: Reservierung abgelaufen, Suchtext inzwischen verschwunden.
  const drift = async file => pool.query(
    'UPDATE code_files SET content=$3,content_hash=$4 WHERE project=$1 AND file_path=$2',
    [project,file,'DRIFT\n',createHash('sha256').update('DRIFT\n').digest('hex')]);
  await drift('old.txt');
  if (broken) await drift('bad.txt');
  await pool.query("UPDATE file_reservations SET expires_at=NOW()-interval '1 day',released_at=NOW()-interval '1 day' WHERE project=$1 AND agent_id=$2",[project,oldOwner]);
  const oldSnapshot = (await pool.query('SELECT to_jsonb(w) AS data FROM file_batch_waits w WHERE wait_token=$1',[oldToken])).rows[0].data;
  const oldPlans = (await pool.query('SELECT id FROM file_batch_plans WHERE project=$1 AND owner_agent_id=$2 ORDER BY id',[project,oldAgent])).rows;
  let result, error, committedPlan;
  try {
    await batch.replanUnblockedReservationWaits(project, []);
    if (mode === 'parallel') {
      await pool.query("UPDATE file_reservations SET released_at=NOW() WHERE project=$1 AND agent_id=$2 AND released_at IS NULL",[project,owner]);
      result = await Promise.all(Array.from({length:3},()=>batch.replanUnblockedReservationWaits(project,['good.txt','bad.txt'])));
    } else if (mode === 'single') {
      result = await write.updateFileInPg(project,'own.txt','OWN\n',owner,'update');
    } else if (mode === 'release') {
      result = await reservations.releaseFileReservations({project,agentId:owner,filePaths:broken?['good.txt','bad.txt']:['good.txt']});
    } else if (mode === 'expiry') {
      await pool.query("UPDATE file_reservations SET expires_at=NOW()-interval '1 second' WHERE project=$1 AND agent_id=$2 AND released_at IS NULL",[project,owner]);
      result = await reservations.releaseStaleFileReservations({project});
    } else {
      const p = await batch.planBatch({project,agent_id:owner,open_for_coedit:mode==='coedit',
        ops:[{action:'search_replace',file_path:'own.txt',search:'BASE',replace:'OWN'}]});
      if (mode === 'coedit') {
        const coauthor = project + '-coauthor';
        const op = {action:'search_replace',file_path:'own.txt',search:'OWN',replace:'OWN\nCO'};
        await batch.planBatch({project,agent_id:coauthor,ops:[op]});
        const added = await batch.addCoeditContribution({project,plan_id:p.plan_id,agent_id:coauthor,ops:[op]});
        assert.equal(added.success,true,JSON.stringify(added));
        await batch.markCoeditReady({project,plan_id:p.plan_id,agent_id:coauthor});
      }
      committedPlan = p.plan_id;
      result = await batch.commitBatch({plan_id:p.plan_id,agent_id:owner});
    }
  } catch (caught) { error = caught; }
  if (committedPlan) {
    const persisted = (await pool.query('SELECT status FROM file_batch_plans WHERE id=$1',[committedPlan])).rows[0];
    assert.equal(persisted.status,'committed','Hauptcommit ist bereits persistent');
  }
  console.log(JSON.stringify({mode,broken,threw:!!error,error_name:error?.name,error_detail:error?.name === 'AssertionError' ? error.message : undefined,result_success:result?.success}));
  assert.ok(!error,'fremder Folgefehler darf eigene erfolgreiche Aktion nicht als Fehler melden: '+error?.name);
  const after = (await pool.query('SELECT to_jsonb(w) AS data FROM file_batch_waits w WHERE wait_token=$1',[oldToken])).rows[0].data;
  assert.deepEqual(after,oldSnapshot,'unbeteiligter Alt-Wait bleibt bytegleich');
  assert.deepEqual((await pool.query('SELECT id FROM file_batch_plans WHERE project=$1 AND owner_agent_id=$2 ORDER BY id',[project,oldAgent])).rows,oldPlans,'kein fremder Folgeplan');
  const goodPlans = (await pool.query("SELECT id FROM file_batch_plans WHERE project=$1 AND owner_agent_id=$2 AND status='open' AND jsonb_array_length(ops)=1",[project,goodAgent])).rows;
  assert.equal(goodPlans.length,1,'betroffener gueltiger Wait wird genau einmal eingeplant');
  assert.equal((await pool.query('SELECT status FROM file_batch_waits WHERE wait_token=$1',[goodToken])).rows[0].status,'closed');
  if (broken) {
    const badPlans = (await pool.query("SELECT id FROM file_batch_plans WHERE project=$1 AND owner_agent_id=$2 AND status='open' AND jsonb_array_length(ops)=1",[project,badAgent])).rows;
    assert.equal(badPlans.length,1,'nicht anwendbarer Beitrag bleibt als korrigierbarer Entwurf erhalten');
    assert.equal((await pool.query('SELECT status FROM file_batch_waits WHERE wait_token=$1',[badToken])).rows[0].status,'closed','kein erneutes automatisches Wiederholen');
    const ev = (await pool.query("SELECT payload FROM agent_events WHERE project=$1 AND scope=$2 AND event_type='PLAN_CHANGED'",[project,'agent:'+badAgent])).rows;
    assert.ok(ev.some(row=>String(row.payload).includes(String(badPlans[0].id))),'nur betroffener Autor bekommt Folgefehler mit Plan-ID');
    await batch.replanUnblockedReservationWaits(project,['bad.txt']);
    assert.equal((await pool.query("SELECT count(*)::int n FROM file_batch_plans WHERE project=$1 AND owner_agent_id=$2 AND jsonb_array_length(ops)=1",[project,badAgent])).rows[0].n,1);
  }
}
try {
  assert.equal((await pool.query('SELECT current_database() db')).rows[0].db,'synapse_test');
  for (const mode of ['legacy','coedit','single','release','expiry','parallel']) {
    for (const broken of [false,true]) {
      try { await scenario(mode,broken); results.push({mode,broken,ok:true}); }
      catch(error) {results.push({mode,broken,ok:false,error:error.message});}
    }
  }
} finally {
  for (const project of projects) {
    await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)',[project]);
    for (const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls']) {
      await pool.query('DELETE FROM '+table+' WHERE project=$1',[project]);
    }
  }
  await pool.end();
}
console.log(JSON.stringify({results,cleanup:'done'}));
process.exit(results.some(r=>!r.ok)?1:0);
