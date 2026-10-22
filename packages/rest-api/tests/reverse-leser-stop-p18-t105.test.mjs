/** P18-T105: echter Reverse-Stopadapter + P20-Lifecycle, synthetische PG-Jobs und Docker-Attrappe. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {fixture,dockerFake,core,project,ReverseContainerRecovery,ReverseContainerTransport,ToolLifecycle} from './reverse-runner-recovery-p18-t105.test.mjs';
const {ReverseLeserExecutor}=await import('../dist/services/reverse-leser-executor.js');

for(const fall of ['erfolg','leaseverlust','frist'])test('T105: Leserantwort + zweimal Removal409 / '+fall,async()=>{
 const f=await fixture(),root=await mkdtemp(join(tmpdir(),'t105-reader-'));let lc;
 try{
  await f.db.query("ALTER TABLE reverse_leser_laeufe ADD eintrag_id text,ADD manifest_key text,ADD manifest_sha256 text,ADD ausgabe_anzahl bigint,ADD ausgabe_bytes bigint,ADD offen bigint,ADD fehlercode text,ADD cursor_key text,ADD beendet_at timestamptz");
  const fake=dockerFake();let transport;
  const recovery=new ReverseContainerRecovery({pool:f.db,ready:b=>transport.ready(b),identity:async()=>f.who});
  transport=new ReverseContainerTransport({docker:fake.docker,binding:(id,j)=>recovery.binding(id,j),stopSeconds:()=>recovery.stopSeconds()});
  let released=0;lc=new ToolLifecycle({pool:f.db,executor:transport,resources:{acquire:async()=>null,release:async()=>{released++;}},registerGuards:false});
  const job=await f.newJob({tool:'reverse-leser'}),descriptor=await f.descriptor('reverse-leser');
  const b=await f.instance(job,{tool:'reverse-leser'});
  // Fixture instance id follows lifecycle's public deterministic descriptor key.
  const instanceId=createHash('sha256').update('reverse-leser\0'+project+'\0'+job.id).digest('hex');
  await f.db.query('UPDATE tool_containers SET instance_id=$2 WHERE instance_id=$1',[b.instance_id,instanceId]);b.instance_id=instanceId;
  const started=await transport.start(descriptor,{instance_id:b.instance_id,generation:b.generation,project,job_id:job.id,warmup_job_id:randomUUID(),name:'reader-fixture',isCurrent:async()=>true});
  b.container_id=started.id;await f.db.query('UPDATE tool_containers SET container_id=$2 WHERE instance_id=$1',[b.instance_id,started.id]);
  fake.containers.get(started.id).item.remove409=2;
  const s=await core.leseReverseEinstellwerte({eintrag_id:'rev-t105'},f.db);
  // Poll/test deadlines are synthetic snapshot values, never written to live settings.
  s.werte.guard_intervall_ms.wert='5';s.werte.container_start_timeout_ms.wert='2000';
  const id=randomUUID(),l={id,eintrag_id:'rev-t105',datei_id:'1',quell_sha256:'a'.repeat(64),generation:randomUUID(),groesse:'1',testmodus:true,host_validiert:false};
  await f.db.query("INSERT INTO reverse_leser_laeufe(id,work_job_id,eintrag_id) VALUES($1,$2,$3)",[id,job.id,l.eintrag_id]);
  const manifest={ausgabetypen:['struktur'],entrypoint:'reader.py'};
  const records=[{art:'objekt',member_id:'one',objektpfad:'one',typ:'struktur',quelle:{offset:'0',laenge:'1'},datei:null,metadaten:{fixture:true}},
   {art:'ende',status:'fertig',grund:null,offen:'0',objekte:'1'}];
  const protocol=records.map(x=>JSON.stringify(x)+'\n').join('');await writeFile(join(root,'.leser-protokoll.jsonl'),protocol);
  const answer={status:'fertig',leser_exit:0,leser_protokoll:{pfad:'.leser-protokoll.jsonl',sha256:createHash('sha256').update(protocol).digest('hex'),bytes:String(Buffer.byteLength(protocol)),zeilen:'2'}};
  const reader=new ReverseLeserExecutor({pool:f.db,reverseRoot:root,image:descriptor.image,digest:descriptor.digest,hostRoot:async()=>root,lifecycle:()=>lc,identitaet:async()=>f.who});
  reader.recoveryAnbinden(recovery);reader.s=s;reader.lauf=async()=>l;
  reader.vorbereitet.set(job.id,{s,lauf:l,r:{manifest,id:'b'.repeat(64),code_sha256:'c'.repeat(64)},ausgabe:root,key:'fixture-output'});
  let executed=0,staged=0,completed=0,failed=0;
  reader.jobs={renew:async()=>true,stage:async()=>{assert.equal((await f.row(b.instance_id)).state,'cold');staged++;return true;},complete:async()=>{completed++;return {completed:true};}};
  reader.fehlerAbschliessen=async()=>{failed++;};
  const facade={execute:async()=>{executed++;await f.run(job,b,'done');return answer;}};
  if(fall==='frist')job.deadline=new Date(Date.now()+250).toISOString();
  const done=reader.ausfuehren(facade,f.who,job).then(()=>null,e=>e);
  for(let i=0;i<100&&(await f.row(b.instance_id)).state!=='stopping';i++)await wait(5);
  assert.equal((await f.row(b.instance_id)).state,'stopping');
  for(let i=0;i<2;i++){await lc.tick();assert.equal((await f.row(b.instance_id)).state,'stopping');assert.equal(released,0);assert.equal(failed,0);assert.equal(staged,0);assert.equal(executed,1);}
  if(fall==='leaseverlust')await f.db.query("UPDATE work_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  if(fall==='frist')await wait(300);
  await lc.tick();const error=await done;
  assert.equal(released,1);assert.equal(executed,1);
  const diag=(await f.db.query('SELECT diagnose FROM reverse_leser_laeufe WHERE id=$1',[id])).rows[0].diagnose;
  if(fall==='erfolg'){assert.equal(error,null);assert.equal(failed,0);assert.equal(staged,1);assert.equal(completed,1);assert.equal(diag.host_validiert,true);}
  else{assert.match(error?.message??'',/leser_(lease_verloren|job_fenced)/);assert.equal(failed,1);assert.equal(staged,0);assert.equal(completed,0);assert.notEqual(diag.host_validiert,true);}
  assert.equal(await readFile(join(root,'.leser-protokoll.jsonl'),'utf8'),protocol);
 }finally{lc?.close();await f.close();await rm(root,{recursive:true,force:true});}
});
test('T105: Stop-Wartefrist/Generationwechsel geben keinen falschen Endbeleg, Crash-Guard hält nur betroffenen Leser',async()=>{
 const f=await fixture();try{
  const recovery=new ReverseContainerRecovery({pool:f.db,ready:()=>true,identity:async()=>f.who});
  const job=await f.newJob({tool:'reverse-leser'}),b=await f.instance(job,{tool:'reverse-leser'});await f.run(job,b,'done');
  await assert.rejects(recovery.waitStopped(b,25,5),/leser_stop_unbestaetigt/);
  assert.equal((await f.row(b.instance_id)).state,'stopping');assert.equal((await f.jobs.get(job.id,project)).state,'leased');
  const p=recovery.waitStopped(b,500,5);await f.db.query('UPDATE tool_containers SET generation=$2 WHERE instance_id=$1',[b.instance_id,randomUUID()]);
  await assert.rejects(p,/reverse_generation_geaendert/);
  await f.db.query("UPDATE tool_containers SET state='warm',generation=$2 WHERE instance_id=$1",[b.instance_id,b.generation]);
  await f.db.query("INSERT INTO reverse_leser_laeufe(id,work_job_id,diagnose) VALUES($1,$2,$3)",[randomUUID(),job.id,{transport:{phase:'stop',versuch:1},host_validiert:false}]);
  assert.equal(await recovery.allow(job,f.db),false);
  const next=await f.newJob({tool:'reverse-leser'});await f.instance(next,{tool:'reverse-leser'});
  assert.equal(await recovery.allow(next,f.db),true,'gesunder Folgejob bleibt claimbar');
  await f.db.query("UPDATE reverse_leser_laeufe SET diagnose=diagnose||'{\"host_validiert\":true}'::jsonb WHERE work_job_id=$1",[job.id]);
  const resumed=new ReverseContainerRecovery({pool:f.db,ready:()=>false,identity:async()=>f.who});
  assert.equal(await resumed.allow(job,f.db),true,'bestehender Hostvalidierungsresume braucht keine neue lokale Session');
 }finally{await f.close();}
});
