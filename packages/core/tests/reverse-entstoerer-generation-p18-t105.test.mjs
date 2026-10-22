/** P18-T105: veraltete Diagnose darf eine neue globale Generation nicht treffen. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,core,ReverseContainerRecovery} from '../../rest-api/tests/reverse-runner-recovery-p18-t105.test.mjs';
const {mitLesePool}=await import('../dist/db/client.js');
test('T105: Diagnose Job+Attempt+Generation; Entstörer-CAS und Readerinstanz bleiben getrennt',async()=>{
 const f=await fixture();let unhook;
 try{
  await f.db.query("CREATE TABLE reverse_auftraege(id uuid,eintrag_id text,schicht text,status text,fehlercode text,p20_auftrag_id uuid,versuch int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())");
  await f.db.query("INSERT INTO reverse_einstellungen(ebene,name,wert) VALUES('global','entstoerer_gnade_s',0)");
  const r=new ReverseContainerRecovery({pool:f.db,ready:()=>false,identity:async()=>f.who});
  const old=await f.newJob(),b=await f.instance();await f.run(old,b);
  const newer=randomUUID();await f.db.query('UPDATE tool_containers SET generation=$2 WHERE instance_id=$1',[b.instance_id,newer]);
  const pending=await f.newJob({state:'pending'}),reader=await f.newJob({tool:'reverse-leser'});
  const rb=await f.instance(reader,{tool:'reverse-leser'});await f.run(reader,rb,'done');
  unhook=core.meldeReverseAusfuehrer({kinds:['reverse-E','reverse-S3'],parallel:2,kapazitaet:async()=>({belegt:2,max:4}),
   containerNeustart:async(_j,beleg)=>r.requestStop(beleg,false,true)});
  const diag=await mitLesePool(f.db,()=>core.diagnoseReverse({pool:f.db}));
  const a=diag.auftraege.find(x=>x.p20_auftrag_id===old.id),p=diag.auftraege.find(x=>x.p20_auftrag_id===pending.id);
  assert.equal(a.container_zustand,'alte_generation');assert.equal(a.container_generation,b.generation);assert.equal(a.container_instanz,null);
  assert.equal(p.container_generation,newer);assert.equal(p.container_instanz,b.instance_id);
  assert.equal(diag.container.instanzen.find(c=>c.instance_id===b.instance_id).runs_unbekannt,0,'alte Runs zählen nicht für neue Generation');
  assert.equal(diag.container.instanzen.find(c=>c.instance_id===rb.instance_id).tool_id,'reverse-leser');
  const preview=await mitLesePool(f.db,()=>core.entstoereReverse({pool:f.db,ausfuehren:false,ursachen:['container_haengt']}));
  assert.equal(preview.anzahl,0,'alte Generation macht neue Instanz nicht zum Neustartkandidaten');
  assert.equal((await r.requestStop(b)).zustand,'reverse_generation_geaendert');assert.equal((await f.row(b.instance_id)).state,'warm');
  // Current attempt can be stopped only using its exact tuple, never the old leased row.
  await f.db.query("UPDATE work_jobs SET state='failed',error_code='fixture' WHERE id=$1",[old.id]);
  await f.db.query("UPDATE work_jobs SET state='leased' WHERE id=$1",[pending.id]);
  const current={...b,generation:newer,job_id:pending.id,attempt:pending.attempt};await f.run(pending,current);
  const now=await mitLesePool(f.db,()=>core.diagnoseReverse({pool:f.db}));
  const n=now.auftraege.find(x=>x.p20_auftrag_id===pending.id);assert.equal(n.container_generation,newer);assert.equal(n.ursache,'container_haengt');
  const active=await f.newJob();await f.run(active,current,'running');
  assert.equal((await r.requestStop(current,false,true)).zustand,'reverse_diagnose_veraltet','laufender Folgejob schützt auch dieselbe Generation');
  assert.equal((await f.row(b.instance_id)).state,'warm');
  await f.db.query("UPDATE tool_container_runs SET state='done' WHERE job_id=$1",[active.id]);
  await mitLesePool(f.db,()=>core.entstoereReverse({pool:f.db,ausfuehren:true,ursachen:['container_haengt']}));
  assert.equal((await f.row(b.instance_id)).state,'stopping');assert.equal((await f.row(rb.instance_id)).state,'warm');
 }finally{unhook?.();await f.close();}
});
