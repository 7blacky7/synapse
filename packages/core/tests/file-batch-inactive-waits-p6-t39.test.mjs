/** P6-T39: inaktive/fehlende Sessions nie automatisch neu planen. Nur synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const u=new URL(process.env.DATABASE_URL);assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const {getPool}=await import('../dist/db/client.js');
const batch=await import('../dist/services/file-batch.js');
const reservations=await import('../dist/services/file-reservations.js');
// P25-T15: seit P6-T48 erzeugt planBatch auf eine nur reservierte Datei keinen Wait mehr -> Altfall-Wait synthetisch
const {legeAltfallWaitAn}=await import('./_helfer/altfall-wait.mjs');
const pool=getPool(),projects=[],checks=[];
async function scenario(status,shared=false){
 const project='sol3-t39-'+randomUUID();projects.push(project);
 const agent=project+'-agent',holder=project+'-holder';
 if(status!=='missing')await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,$3,NOW())",[agent,project,status]);
 await reservations.addFileReservations({project,agentId:holder,filePaths:['one.txt']});
 const p=await legeAltfallWaitAn(pool,{project,waitingAgent:agent,primaryAgent:holder,ops:[{action:'create',file_path:'one.txt',content:'ONE'}]});
 const id=p.coedit_waits[0].wait_token;
 const before=(await pool.query('SELECT * FROM file_batch_waits WHERE wait_token=$1',[id])).rows[0];
 let other;
 if(shared){
  other=randomUUID();
  await pool.query("INSERT INTO file_batch_waits(wait_token,source_plan_id,project,waiting_agent,primary_agent,shared_files,deferred_ops,deferred_op_indexes,expires_at,status) SELECT $2,source_plan_id,project,waiting_agent,primary_agent,ARRAY['other.txt'],deferred_ops,deferred_op_indexes,expires_at,'waiting' FROM file_batch_waits WHERE wait_token=$1",[id,other]);
 }
 const foreign=randomUUID();
 await pool.query("INSERT INTO file_batch_waits(wait_token,source_plan_id,project,waiting_agent,primary_agent,shared_files,deferred_ops,deferred_op_indexes,expires_at,status) SELECT $2,source_plan_id,project,waiting_agent,primary_agent,ARRAY['foreign.txt'],deferred_ops,deferred_op_indexes,expires_at,'waiting' FROM file_batch_waits WHERE wait_token=$1",[id,foreign]);
 // foreign bewusst anderer Traeger: blockiert nicht die Leertraegerpruefung dieses Tests.
 const foreignCarrier=(await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status) VALUES($1,$2,'[]','{}','[]','open') RETURNING id",[project,agent])).rows[0].id;
 await pool.query('UPDATE file_batch_waits SET source_plan_id=$2 WHERE wait_token=$1',[foreign,foreignCarrier]);
 const foreignBefore=(await pool.query('SELECT to_jsonb(w) AS data FROM file_batch_waits w WHERE wait_token=$1',[foreign])).rows[0].data;
 await pool.query("UPDATE file_reservations SET released_at=NOW() WHERE project=$1",[project]);
 await Promise.all(Array.from({length:4},()=>batch.replanUnblockedReservationWaits(project,['one.txt'])));
 const after=(await pool.query('SELECT * FROM file_batch_waits WHERE wait_token=$1',[id])).rows[0];
 assert.equal(after.status,'closed');
 assert.deepEqual(after.deferred_ops,before.deferred_ops);
 assert.deepEqual((await pool.query('SELECT to_jsonb(w) AS data FROM file_batch_waits w WHERE wait_token=$1',[foreign])).rows[0].data,foreignBefore,'fremder Pfad unveraendert');
 const plans=(await pool.query('SELECT id,status,ops,reason FROM file_batch_plans WHERE project=$1 ORDER BY id',[project])).rows;
 if(status==='active')assert.equal(plans.filter(p=>p.ops.length>0).length,1,'aktive Session normal');
 else {
  assert.equal(plans.filter(p=>p.ops.length>0).length,0,'inaktive/fehlende Session erzeugt keinen Plan');
  const carrier=plans.find(p=>String(p.id)===String(before.source_plan_id));
  assert.equal(carrier.status,shared?'open':'cancelled','Traeger nur ohne andere offene Waits schliessen');
  const events=(await pool.query("SELECT payload FROM agent_events WHERE project=$1 AND event_type='PLAN_CHANGED'",[project])).rows;
  assert.equal(events.filter(e=>String(e.payload).includes('inactive_wait_closed')).length,1,'genau ein nachvollziehbarer Vermerk');
 }
 checks.push({status,shared,ok:true});
}
try{for(const status of ['inactive','missing','active'])await scenario(status);await scenario('inactive',true);console.log(JSON.stringify(checks));}
finally{
 for(const project of projects){
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]);
  for(const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls','agent_sessions'])await pool.query('DELETE FROM '+table+' WHERE project=$1',[project]);
 }await pool.end();
}
