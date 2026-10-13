/** W3 R4.1: echte synapse_test-Verbindung, ausschließlich eigenes Schema/Projekt. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';
import {COMPUTE_CONTROL_SCHEMA_SQL} from '../dist/db/compute-control-schema.js';
import {setComputeNodeControl,computeNodeControlResponse,observeComputeNodeControl} from '../dist/services/compute-node-control.js';
const project='p20_r41_'+process.pid,schema=project,nodeId='r41-node',boot='r41-boot',device='GPU-r41-fixture';
test('R4.1 PG: Revision, Boot, Deadline, Gerätebeleg und Usersperre begrenzen Ack',async t=>{
 const db=await oeffneGeschuetzteShellTestDb(),q=db.query.bind(db),saved={...process.env};let created=false;
 const node={node_id:nodeId,boot_id:boot,features:['compute_control'],gesperrt_vom_user:false,aktualisiert_am:new Date()};
 const desired=action=>({bootId:boot,action,capability:'embedding',deviceId:device,reason:'own W3 fixture',deadline:new Date(Date.now()+60000).toISOString()});
 const row=async()=> (await q('SELECT * FROM compute_node_control WHERE node_id=$1',[nodeId])).rows[0];
 const stamp=async()=> (await q('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
 const observe=async(c,extra={})=>({revision:c.revision,bootId:boot,state:'unloaded',activeBatches:0,pendingClaims:0,modelPresent:false,ackRevision:c.revision,measuredAt:await stamp(),...extra});
 const measured=async()=>{
  const at=await stamp(),m={quality:'measured',value:10000,measuredAt:at};
  await q('UPDATE embedding_knoten SET ressourcen=$2::jsonb WHERE node_id=$1',[nodeId,JSON.stringify({gpus:[{deviceId:device,totalMb:m,freeMb:m}]})]);
 };
 try{
  assert.equal((await db.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  await q('CREATE SCHEMA '+schema);created=true;await q('SET search_path TO '+schema);
  await q('CREATE TABLE projects(name text PRIMARY KEY)');await q('INSERT INTO projects VALUES($1)',[project]);
  await q('CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text,features text[],gesperrt_vom_user boolean,aktualisiert_am timestamptz,ressourcen jsonb)');
  await q('INSERT INTO embedding_knoten VALUES($1,$2,$3,false,clock_timestamp(),NULL)',[nodeId,boot,['compute_control']]);
  await q(COMPUTE_CONTROL_SCHEMA_SQL);await q(COMPUTE_CONTROL_SCHEMA_SQL);
  process.env.SYNAPSE_API_FEATURES='compute_control';delete process.env.SYNAPSE_COMPUTE_POLICY_ENABLED;
  process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify({[nodeId]:{hostResourceDomain:'r41-host',deviceIds:[device]}});
  await t.test('Legacy-Knoten ohne verhandeltes Feature erhält kein neues Feld',async()=>{
   let queried=false;assert.equal(await computeNodeControlResponse({...node,features:[]},{query:async()=>{queried=true;throw Error('nicht abfragen');}}),undefined);assert.equal(queried,false);
  });
  let c=await setComputeNodeControl(nodeId,desired('drain'),db);assert.equal(c.revision,1);
  await t.test('Kein GPU-Beleg: Beobachtung wird gespeichert, physischer Ack bleibt NULL',async()=>{
   await observeComputeNodeControl(node,await observe(c),db);assert.equal((await row()).ack_revision,null);
  });
  await measured();
  await t.test('Aktive Stapel oder offene Claims verhindern Freigabe',async()=>{
   for(const extra of [{activeBatches:1},{pendingClaims:1},{modelPresent:true},{state:'pending',modelPresent:null}]){
    await observeComputeNodeControl(node,await observe(c,extra),db);assert.equal((await row()).ack_revision,null);
   }
  });
  await t.test('Frischer Gerätebeleg und positive Abwesenheit bestätigen aktuelle Revision',async()=>{
   await observeComputeNodeControl(node,await observe(c),db);assert.equal((await row()).ack_revision,'1');
  });
  await t.test('Neuer Sollzustand erhöht Revision und verwirft alten Ack',async()=>{
   c=await setComputeNodeControl(nodeId,desired('unload'),db);assert.equal(c.revision,2);assert.equal((await row()).ack_revision,null);
   await measured();
   for(const extra of [{revision:1,ackRevision:1},{measuredAt:'2000-01-01T00:00:00.000Z'},{measuredAt:'2099-01-01T00:00:00.000Z'}]){
    await observeComputeNodeControl(node,await observe(c,extra),db);assert.equal((await row()).ack_revision,null);
   }
   await assert.rejects(()=>observeComputeNodeControl(node,{revision:2,ackRevision:2,bootId:'old-boot',state:'unloaded',activeBatches:0,pendingClaims:0,modelPresent:false,measuredAt:new Date().toISOString()},db),/boot_mismatch/);
  });
  await t.test('Ablauf und Neustart sind kein Freigabe-Ack',async()=>{
   await q("UPDATE compute_node_control SET desired=jsonb_set(desired,'{deadline}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE node_id=$1",[nodeId]);
   await observeComputeNodeControl(node,await observe(c),db);assert.equal((await row()).ack_revision,null);
   c=await setComputeNodeControl(nodeId,desired('pause'),db);
   await q('UPDATE embedding_knoten SET boot_id=$2 WHERE node_id=$1',[nodeId,'new-boot']);
   await measured();await observeComputeNodeControl(node,await observe(c),db);assert.equal((await row()).ack_revision,null);
   await q('UPDATE embedding_knoten SET boot_id=$2 WHERE node_id=$1',[nodeId,boot]);
  });
  await t.test('Resume-Ack hebt Knoten-Usersperre nicht auf',async()=>{
   c=await setComputeNodeControl(nodeId,desired('resume'),db);
   await q('UPDATE embedding_knoten SET gesperrt_vom_user=true WHERE node_id=$1',[nodeId]);
   const locked={...node,gesperrt_vom_user:true};
   assert.equal((await computeNodeControlResponse(locked,db)).allowed,false);
   await observeComputeNodeControl(locked,await observe(c,{state:'running',modelPresent:null}),db);assert.equal((await row()).ack_revision,null);
   await q('UPDATE embedding_knoten SET gesperrt_vom_user=false WHERE node_id=$1',[nodeId]);
   await observeComputeNodeControl(node,await observe(c,{state:'running',modelPresent:null}),db);assert.equal((await row()).ack_revision,String(c.revision));
  });
  await t.test('Bestehende Fähigkeits-Usersperre verhindert Resume-Ack',async()=>{
   await q("ALTER TABLE embedding_knoten ADD COLUMN status text DEFAULT 'ready',ADD COLUMN letzter_kontakt timestamptz DEFAULT clock_timestamp(),ADD COLUMN modell text DEFAULT 'own',ADD COLUMN native_dimension int DEFAULT 16,ADD COLUMN ziel_dimension int DEFAULT 8");
   await q('UPDATE embedding_knoten SET ressourcen=NULL WHERE node_id=$1',[nodeId]);
   await q('CREATE TABLE compute_node_policy(node_id text PRIMARY KEY,ausfuehrungsfreigabe boolean,modus text,faehigkeit_schalter jsonb,usersperre jsonb,policy_revision bigint)');
   await q('CREATE TABLE compute_project_policy(project text PRIMARY KEY,pc_gpu_ausgeschlossen boolean,policy_revision bigint)');
   await q("INSERT INTO compute_node_policy VALUES($1,true,'automatik','{}','{\"embedding\":true}',1)",[nodeId]);
   process.env.SYNAPSE_COMPUTE_POLICY_ENABLED='1';c=await setComputeNodeControl(nodeId,desired('resume'),db);
   assert.equal((await computeNodeControlResponse(node,db)).allowed,false);
   await observeComputeNodeControl(node,await observe(c,{state:'running',modelPresent:null}),db);assert.equal((await row()).ack_revision,null);
   await q("UPDATE compute_node_policy SET usersperre='{}',policy_revision=2 WHERE node_id=$1",[nodeId]);
   assert.equal((await computeNodeControlResponse(node,db)).allowed,true);
   await observeComputeNodeControl(node,await observe(c,{state:'running',modelPresent:null}),db);assert.equal((await row()).ack_revision,String(c.revision));
  });
  await t.test('Nicht gebundenes Gerät und deaktiviertes Feature verweigern neue Steuerung',async()=>{
   await assert.rejects(()=>setComputeNodeControl(nodeId,{...desired('drain'),deviceId:'GPU-foreign'},db),/target_invalid/);
   process.env.SYNAPSE_API_FEATURES='';await assert.rejects(()=>setComputeNodeControl(nodeId,desired('drain'),db),/disabled/);
  });
 }finally{
  if(created)await q('DROP SCHEMA '+schema+' CASCADE');
  await db.end();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 }
});
