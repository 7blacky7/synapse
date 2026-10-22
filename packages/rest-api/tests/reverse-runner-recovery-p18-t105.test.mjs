/** P18-T105: nur synapse_test und Docker-Attrappen. Gemeinsame Testfixture für drei freigegebene Tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Duplex} from 'node:stream';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const require=createRequire(new URL('../../core/package.json',import.meta.url));
const {Pool}=require('pg');
export const core=await import('../../core/dist/index.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
export const {ReverseContainerRecovery}=await import('../dist/services/reverse-container-recovery.js');
export const {ReverseContainerTransport,reverseNichtGesendet,ReverseEntfernungAusstehend,istRemoval409}=await import('../dist/services/reverse-container-transport.js');
export const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
const {reverseToolDescriptor,ladeReverseExecutorKonfig}=await import('../dist/services/reverse-executor.js');
export const project='reverse-bibliothek';
export async function fixture(){
 const schema='t105_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public',max:8});
 await db.query("CREATE TABLE projects(name text,enabled boolean); INSERT INTO projects VALUES('reverse-bibliothek',true)");
 await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text,service_token_hash text,status text DEFAULT 'ready',gesperrt_vom_user boolean DEFAULT false,letzter_kontakt timestamptz DEFAULT now(),node_kind text DEFAULT 'cpu')");
 for(const sql of [WORK_JOBS_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL])await db.query(sql);
 await db.query("CREATE TABLE reverse_einstellungen(ebene text,project text,eintrag_id text,name text,wert bigint,wert_text text)");
 await db.query("INSERT INTO reverse_einstellungen(ebene,name,wert) VALUES('global','e_uebernahme_block_zeilen',1)");
 await db.query("CREATE TABLE reverse_leser_laeufe(id uuid PRIMARY KEY,work_job_id uuid,host_validiert boolean DEFAULT false,diagnose jsonb DEFAULT '{}',status text DEFAULT 'laeuft')");
 const who={nodeId:'t105',bootGeneration:randomUUID(),authHash:'t105-auth'};
 await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[who.nodeId,who.bootGeneration,who.authHash]);
 const d=reverseToolDescriptor(ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:fixture@sha256:'+'b'.repeat(64)},'/unused-t105'));
 d.mounts=[];d.lifecycle.start_timeout_ms=2000;
 const descriptors=new Map();
 const descriptor=async(tool='reverse-e')=>{
  const x=structuredClone(d);x.tool_id=tool;
  if(tool==='reverse-leser'){x.capability='reverse_leser';x.instance_scope='job';}
  await db.query('INSERT INTO tool_descriptors(tool_id,capability,descriptor,descriptor_hash,enabled) VALUES($1,$2,$3,$4,true) ON CONFLICT(tool_id) DO NOTHING',[x.tool_id,x.capability,x,core.toolDescriptorHash(x)]);
  await db.query("INSERT INTO tool_activation(tool_id,project,enabled,updated_by) VALUES($1,$2,true,'fixture') ON CONFLICT DO NOTHING",[tool,project]);
  descriptors.set(tool,x);return x;
 };
 await descriptor();
 const jobs=core.createWorkJobService({pool:db});
 const newJob=async({tool='reverse-e',state='leased',attempt=1,kind}={})=>{
  await descriptor(tool);
  const j=await jobs.enqueue({kind:kind??(tool==='reverse-e'?'reverse-E':'reverse-leser'),capability:tool==='reverse-e'?'reverse_bibliothek':'reverse_leser',project,scope:'reverse',
   inputRef:{scope:'reverse',id:'rev-t105',revision:'1',sha256:'a'.repeat(64)},resourceNeed:{cpu:1,ram:512,vram:0,gpu:false},priority:'hintergrund',idempotencyKey:randomUUID()});
  await db.query("UPDATE work_jobs SET state=$2,attempt=$3,owner_node=$4,boot_generation=$5,owner_auth_hash=$6,claim_token=$7,resource_domain='reverse:t105',lease_until=now()+interval '10 minutes',claimed_at=now() WHERE id=$1",[j.id,state,attempt,who.nodeId,who.bootGeneration,who.authHash,randomUUID()]);
  return jobs.get(j.id,project);
 };
 const instance=async(j=null,{tool='reverse-e',state='warm',generation=randomUUID(),id=randomUUID(),container='fake-'+randomUUID()}={})=>{
  await descriptor(tool);
  await db.query("INSERT INTO tool_containers(instance_id,tool_id,project,work_job_id,generation,state,container_id,resource_token,ready_at,operation_at) VALUES($1,$2,$3,$4,$5,$6,$7,'resource',now()-interval '1 hour',now()-interval '1 hour')",[id,tool,project,tool==='reverse-leser'?j?.id:null,generation,state,container]);
  return {instance_id:id,generation,container_id:container,tool_id:tool,project,job_id:j?.id,attempt:j?.attempt};
 };
 const run=async(j,b,state='unknown')=>db.query('INSERT INTO tool_container_runs(job_id,attempt,instance_id,generation,state) VALUES($1,$2,$3,$4,$5)',[j.id,j.attempt,b.instance_id,b.generation,state]);
 const row=async id=>(await db.query('SELECT * FROM tool_containers WHERE instance_id=$1',[id])).rows[0];
 return {db,who,jobs,newJob,instance,run,row,descriptor,descriptors,
  close:async()=>{await db.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}};
}
export function dockerFake(){
 const containers=new Map();let counter=0,writeMode='reply';const calls={write:0,stop:0,remove:0,start:0};
 const missing=()=>Object.assign(Error('No such container'),{statusCode:404});
 const docker={modem:{demuxStream(stream,out){stream.out=out;}},getImage:()=>({inspect:async()=>({Id:'sha256:'+'b'.repeat(64),RepoTags:['synapse-reverse:fixture']})}),
  async createContainer(options){
   const id='docker-'+(++counter),item={id,options,running:false,removed:false,remove409:0};
   const stream=new Duplex({read(){},write(chunk,encoding,cb){calls.write++;if(writeMode==='throw'){cb(Error('write failed'));return;}
    cb();if(writeMode==='reply')queueMicrotask(()=>stream.out.write(JSON.stringify({status:'fertig'})+'\n'));}});
   stream.on('error',()=>{});
   const c={id,item,stream,async attach(){return stream;},async start(){item.running=true;calls.start++;},
    async inspect(){if(item.removed)throw missing();return {Id:id,Image:'sha256:'+'b'.repeat(64),Config:{Image:options.Image,Labels:options.Labels},State:{Running:item.running,StartedAt:new Date().toISOString()}};},
    async stats(){return {read:new Date().toISOString(),cpu_stats:{cpu_usage:{total_usage:1},system_cpu_usage:10,online_cpus:1},precpu_stats:{cpu_usage:{total_usage:1},system_cpu_usage:10}};},
    async stop(){calls.stop++;if(item.removed)throw missing();item.running=false;},
    async remove(){calls.remove++;if(item.removed)throw missing();if(item.remove409-->0)throw Object.assign(Error('removal of container '+id+' is already in progress'),{statusCode:409});item.removed=true;}};
   containers.set(id,c);containers.set(options.name,c);return c;
  },getContainer(id){return containers.get(id)??{id,inspect:async()=>{throw missing();},remove:async()=>{throw missing();},stop:async()=>{throw missing();}};}};
 return {docker,calls,containers,setWriteMode:m=>{writeMode=m;}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
test('T105: atomare Idle-Recovery, Boot/Generation/aktive Jobs, fremder Guard ohne I/O',async()=>{
 const f=await fixture();try{
  let reads=0;const noio=new ReverseContainerRecovery({pool:f.db,ready:()=>{throw Error('ready forbidden');},identity:async()=>{throw Error('identity forbidden');}});
  assert.equal(await noio.allow({project:'projekt',kind:'compute',capability:'compute'},{query(){reads++;throw Error('DB forbidden');}}),true);assert.equal(reads,0);
  const r=new ReverseContainerRecovery({pool:f.db,ready:()=>false,identity:async()=>f.who});
  const j=await f.newJob({state:'pending'}),b=await f.instance();
  assert.equal(await r.allow(j,f.db),false);
  const both=await Promise.all([r.before('reverse-e',j.id),r.before('reverse-e',j.id)]);
  assert.deepEqual(both,[false,false]);assert.equal((await f.row(b.instance_id)).state,'stopping');
  const token=(await f.row(b.instance_id)).operation_token;await r.requestStop(b,true);assert.equal((await f.row(b.instance_id)).operation_token,token);
  await f.db.query("UPDATE tool_containers SET state='warm',generation=$2 WHERE instance_id=$1",[b.instance_id,randomUUID()]);
  assert.equal((await r.requestStop(b)).zustand,'reverse_generation_geaendert');
  const current=await r.current('reverse-e',j.id);
  await f.db.query('UPDATE embedding_knoten SET boot_id=$1',[randomUUID()]);
  assert.equal((await r.requestStop(current,true)).zustand,'reverse_recovery_fenced');
  await f.db.query('UPDATE embedding_knoten SET boot_id=$1',[f.who.bootGeneration]);
  await f.db.query("UPDATE work_jobs SET state='leased' WHERE id=$1",[j.id]);
  assert.equal((await r.requestStop(current,true)).zustand,'reverse_ende_unbestaetigt');
  await f.db.query("UPDATE work_jobs SET state='pending',resource_unconfirmed=true WHERE id=$1",[j.id]);
  assert.equal((await r.requestStop(current,true)).zustand,'reverse_ende_unbestaetigt');
  await f.db.query("UPDATE work_jobs SET resource_unconfirmed=false WHERE id=$1",[j.id]);await f.run(j,current);
  assert.equal((await r.requestStop(current,true)).zustand,'reverse_ende_unbestaetigt');
  await f.db.query("UPDATE tool_container_runs SET state='done'");
  const c=await f.db.connect();try{await c.query('BEGIN');const held=new ReverseContainerRecovery({pool:c,ready:()=>false,identity:async()=>f.who});
   const connect=c.connect;c.connect=()=>{throw Error('held reconnect');};
   assert.equal((await held.requestStop(current,true)).neu_gestartet,true);c.connect=connect;await c.query('ROLLBACK');
  }finally{c.release();}
  assert.equal((await f.row(b.instance_id)).state,'warm','caller rollback preserved');
 }finally{await f.close();}
});
test('T105: NichtGesendet nur vor write, exakter Run+Lease, Audit idempotent und TX1',async()=>{
 const f=await fixture();try{
  const fake=dockerFake(),r=new ReverseContainerRecovery({pool:f.db,ready:()=>false,identity:async()=>f.who});
  const j=await f.newJob(),b=await f.instance();await f.run(j,b);
  const t=new ReverseContainerTransport({docker:fake.docker,binding:(id,job)=>r.binding(id,job),stopSeconds:()=>r.stopSeconds()});
  let error;try{await t.command(b.container_id,{auftrag_id:j.id},1000,1000);}catch(e){error=e;}
  assert.equal(reverseNichtGesendet(error).generation,b.generation);assert.equal(fake.calls.write,0);
  assert.equal(reverseNichtGesendet(Error(error.message)),null);assert.equal(reverseNichtGesendet({message:error.message}),null);
  const mutations=[];f.db.on('connect',()=>{});
  const connect=f.db.connect.bind(f.db);f.db.connect=(...a)=>{if(a.some(x=>typeof x==='function'))return connect(...a);return connect(...a).then(c=>{const q=c.query.bind(c);let n=0;const saved=c.query;
   c.query=async(...args)=>{const sql=typeof args[0]==='string'?args[0]:args[0].text;if(sql==='BEGIN')n=0;
    const out=await q(...args);if(/^\s*(UPDATE|INSERT|DELETE)/i.test(sql))n+=out.rowCount??0;if(sql==='COMMIT')mutations.push(n);return out;};
   const rel=c.release.bind(c);c.release=(...args)=>{c.query=saved;c.release=rel;return rel(...args);};return c;});};
  // P20 release is tested separately from own single-row phases.
  let released=0;
  assert.equal(await r.releaseNotSent(error,j,f.who,{release:async()=>{released++;return true;}}),true);
  assert.equal(await r.releaseNotSent(error,j,f.who,{release:async()=>true}),true);
  assert.equal((await f.db.query("SELECT count(*) n FROM work_job_audit WHERE event='reverse_nicht_gesendet'")).rows[0].n,'1');
  assert.ok(mutations.every(n=>n<=1),JSON.stringify(mutations));assert.equal(released,1);
  f.db.connect=connect;
  assert.equal(await r.releaseNotSent(error,j,f.who,f.jobs),true);assert.equal((await f.jobs.get(j.id,project)).state,'pending');
  assert.equal(await r.releaseNotSent(Error('reverse_runner_nicht_angebunden'),j,f.who,f.jobs),false);
  assert.equal(await r.releaseNotSent(error,{...j,attempt:2},f.who,f.jobs),false);
 }finally{await f.close();}
});
test('T105: realer execute-Catch unknown -> nur belegter Nichtversand release; nach write bleibt Lease',async()=>{
 const f=await fixture();let lc;try{
  const fake=dockerFake();let transport;
  const recovery=new ReverseContainerRecovery({pool:f.db,ready:b=>transport.ready(b),identity:async()=>f.who});
  transport=new ReverseContainerTransport({docker:fake.docker,binding:(id,j)=>recovery.binding(id,j),stopSeconds:()=>recovery.stopSeconds()});
  lc=new ToolLifecycle({pool:f.db,executor:transport,resources:{acquire:async()=>null,release:async()=>{}},registerGuards:false});
  const job=await f.newJob(),b=await f.instance(),d=await f.descriptor();
  const {createHash}=await import('node:crypto');
  const id=createHash('sha256').update('reverse-e\0'+project+'\0project').digest('hex');
  await f.db.query('UPDATE tool_containers SET instance_id=$2 WHERE instance_id=$1',[b.instance_id,id]);b.instance_id=id;
  let error;try{await lc.execute('reverse-e',project,job.id,f.who,job.claimToken,async()=>({kommando:'fixture'}));}catch(e){error=e;}
  assert.ok(reverseNichtGesendet(error));
  const state=async j=>(await f.db.query('SELECT state FROM tool_container_runs WHERE job_id=$1 AND attempt=$2',[j.id,j.attempt])).rows[0]?.state;
  assert.equal(await state(job),'unknown');
  assert.equal(await recovery.releaseNotSent(error,job,f.who,f.jobs),true);
  assert.equal(await state(job),'done');assert.equal((await f.jobs.get(job.id,project)).state,'pending');
  const j2=await f.newJob();
  d.limits.time_ms=20;await f.db.query('UPDATE tool_descriptors SET descriptor=$2,descriptor_hash=$3 WHERE tool_id=$1',['reverse-e',d,core.toolDescriptorHash(d)]);
  const started=await transport.start(d,{instance_id:id,generation:b.generation,project,job_id:null,warmup_job_id:randomUUID(),name:'actual-execute',isCurrent:async()=>true});
  await f.db.query('UPDATE tool_containers SET container_id=$2 WHERE instance_id=$1',[id,started.id]);fake.setWriteMode('silent');
  let timeout;try{await lc.execute('reverse-e',project,j2.id,f.who,j2.claimToken,async()=>({kommando:'fixture'}));}catch(e){timeout=e;}
  assert.equal(timeout?.message,'tool_runner_timeout');assert.equal(await state(j2),'unknown');
  assert.equal(await recovery.releaseNotSent(timeout,j2,f.who,f.jobs),false);
  assert.equal((await f.jobs.get(j2.id,project)).state,'leased');assert.equal(fake.calls.write,1);
  fake.containers.get(started.id).stream.destroy();
 }finally{lc?.close();await f.close();}
});
// Regressionen aus rea4 df7765c3/f1e2172a: am Zwischenfenster prüfen, nicht nur den Endzustand.
for(const halt of ['keiner','generation','stopfehler']){
 test('T105 R1: Stopfence vor Leser-release, Halt='+halt,async()=>{
  const f=await fixture();try{
   const fake=dockerFake();let transport;
   const r=new ReverseContainerRecovery({pool:f.db,ready:b=>transport.ready(b),identity:async()=>f.who});
   transport=new ReverseContainerTransport({docker:fake.docker,binding:(id,j)=>r.binding(id,j),stopSeconds:()=>r.stopSeconds()});
   const job=await f.newJob({tool:'reverse-leser'}),b=await f.instance(job,{tool:'reverse-leser'}),d=await f.descriptor('reverse-leser');
   const start=await transport.start(d,{instance_id:b.instance_id,generation:b.generation,project,job_id:job.id,warmup_job_id:job.id,name:'review-race',isCurrent:async()=>true});
   b.container_id=start.id;await f.db.query('UPDATE tool_containers SET container_id=$2 WHERE instance_id=$1',[b.instance_id,start.id]);await f.run(job,b);
   let error;try{await transport.command(start.id,{auftrag_id:job.id,x:'too-long'},100,1000,undefined,1);}catch(e){error=e;}
   assert.ok(reverseNichtGesendet(error));assert.equal(fake.calls.write,0);assert.equal(transport.ready(b),true);
   let releases=0;
   const release={release:async(...args)=>{
    releases++;
    assert.equal((await f.row(b.instance_id)).state,'stopping','vor P20-release dauerhaft reserviert');
    const result=await f.jobs.release(...args),next=await f.jobs.get(job.id,project);
    assert.equal(next.state,'pending');
    assert.equal((await f.row(b.instance_id)).state,'stopping');
    assert.equal(await r.allow(next,f.db),false,'genau im früher offenen Claimfenster gesperrt');
    assert.equal(transport.ready(b),true,'Session ist noch bereit: Sperre muss aus PG kommen');
    return result;
   }};
   const before=async()=>{
    if(halt==='generation')await f.db.query('UPDATE tool_containers SET generation=$2 WHERE instance_id=$1',[b.instance_id,randomUUID()]);
    if(halt==='stopfehler')r.requestStop=async()=>{throw Error('fixture_stop_fehlgeschlagen');};
   };
   if(halt==='stopfehler')await assert.rejects(r.releaseNotSent(error,job,f.who,release,before),/fixture_stop_fehlgeschlagen/);
   else assert.equal(await r.releaseNotSent(error,job,f.who,release,before),halt==='keiner');
   assert.equal(releases,halt==='keiner'?1:0);
   assert.equal((await f.jobs.get(job.id,project)).state,halt==='keiner'?'pending':'leased');
   assert.equal(fake.calls.write,0);assert.equal(fake.calls.stop,0);
   fake.containers.get(start.id).stream.destroy();
  }finally{await f.close();}
 });
}
test('T105 R2: fehlende Bindung sperrt bekannte/unbekannte Reverse-IDs, Stop UND Cleanup',async()=>{
 const fake=dockerFake();let binding=null;
 const cfg={docker:fake.docker,binding:async()=>binding,stopSeconds:async()=>1};
 const t=new ReverseContainerTransport(cfg);
 const d=reverseToolDescriptor(ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:fixture@sha256:'+'b'.repeat(64)},'/unused'));d.mounts=[];
 const ctx={instance_id:'review-own',generation:randomUUID(),project,job_id:null,warmup_job_id:randomUUID(),name:'review-unresolved',isCurrent:async()=>true};
 const c=await t.start(d,ctx),item=fake.containers.get(c.id),labels=item.item.options.Labels;
 binding={instance_id:ctx.instance_id,generation:ctx.generation,container_id:c.id,tool_id:'reverse-e',project};
 labels['synapse.generation']='foreign-generation';
 await assert.rejects(t.stop(c.id),/reverse_container_foreign/);
 await assert.rejects(t.cleanup(c.id),/reverse_container_foreign/);
 binding=null;
 // Eigene, fremde und wechselnde Labels liefern ohne PG-Bindung KEINE Erlaubnis.
 for(const generation of [ctx.generation,'foreign-generation',ctx.generation]){
  labels['synapse.generation']=generation;
  for(const adapter of [t,new ReverseContainerTransport(cfg)]){
   await assert.rejects(adapter.stop(c.id),/reverse_container_binding_fehlt/);
   await assert.rejects(adapter.cleanup(c.id),/reverse_container_binding_fehlt/);
   await assert.rejects(adapter.observe(c.id),/reverse_container_binding_fehlt/);
   await assert.rejects(adapter.command(c.id,{},100,100),/reverse_container_binding_fehlt/);
  }
 }
 assert.equal(fake.calls.stop,0);assert.equal(fake.calls.remove,0);assert.equal(fake.calls.write,0);assert.equal(item.item.removed,false);
 // Auch ein bekannter Nicht-Reverse-Start darf bei gewechselten Labels nicht delegiert werden.
 const hex=await t.start({...d,tool_id:'hex'},{...ctx,name:'hex-proof',project:'x'}),hc=fake.containers.get(hex.id);
 hc.item.options.Labels['synapse.tool']='reverse-leser';
 await assert.rejects(t.stop(hex.id),/reverse_container_foreign/);await assert.rejects(t.cleanup(hex.id),/reverse_container_foreign/);
 assert.equal(fake.calls.stop,0);assert.equal(fake.calls.remove,0);
 hc.item.options.Labels['synapse.tool']='hex';
 await t.stop(hex.id);assert.equal(hc.item.removed,true,'positiv belegtes Hex unverändert delegiert');
 item.stream.destroy();
});
test('T105: Transportparität, Tail, write/Timeout bleiben unbekannt, falsche Labels fail closed',async()=>{
 const fake=dockerFake();let b,mode='reply';
 const t=new ReverseContainerTransport({docker:fake.docker,binding:async()=>b,stopSeconds:async()=>2});
 const d=reverseToolDescriptor(ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:fixture@sha256:'+'b'.repeat(64)},'/unused'));d.mounts=[];
 const ctx={instance_id:'instance',generation:randomUUID(),project,job_id:null,warmup_job_id:randomUUID(),name:'fixture',isCurrent:async()=>true};
 const start=await t.start(d,ctx);b={instance_id:ctx.instance_id,generation:ctx.generation,container_id:start.id,tool_id:'reverse-e',project,job_id:randomUUID(),attempt:1};
 const c=fake.containers.get(start.id),o=c.item.options;
 assert.equal(o.User,'65532:65532');assert.equal(o.HostConfig.ReadonlyRootfs,true);assert.deepEqual(o.HostConfig.CapDrop,['ALL']);assert.equal(o.HostConfig.NetworkMode,'none');
 let pre;try{await t.command(start.id,{auftrag_id:b.job_id,x:'long'},100,1000,undefined,1);}catch(e){pre=e;}
 assert.ok(reverseNichtGesendet(pre));assert.equal(fake.calls.write,0);
 assert.equal((await t.command(start.id,{auftrag_id:b.job_id},1000,1000)).status,'fertig','tail is free');
 fake.setWriteMode('silent');let timeout;try{await t.command(start.id,{auftrag_id:b.job_id},5,1000);}catch(e){timeout=e;}
 assert.equal(timeout.message,'tool_runner_timeout');assert.equal(reverseNichtGesendet(timeout),null);
 c.stream.destroy();
 const second=await t.start(d,{...ctx,name:'second',generation:randomUUID()});b={...b,generation:fake.containers.get(second.id).item.options.Labels['synapse.generation'],container_id:second.id};
 fake.setWriteMode('throw');let write;try{await t.command(second.id,{auftrag_id:b.job_id},100,1000);}catch(e){write=e;}assert.equal(reverseNichtGesendet(write),null);
 fake.containers.get(second.id).item.options.Labels['synapse.generation']='foreign';
 await assert.rejects(t.stop(second.id),/reverse_container_foreign/);assert.equal(fake.calls.stop,0);
 assert.equal(istRemoval409({statusCode:409,message:'other conflict'}),false);assert.equal(istRemoval409({statusCode:403,message:'removal in progress'}),false);
 const foreign=await t.start({...d,tool_id:'hex'}, {...ctx,name:'foreign',project:'x'});b=null;
 assert.equal((await t.observe(foreign.id)).running,true);await t.stop(foreign.id);
 assert.equal(fake.containers.get(foreign.id).item.removed,true);
});
}
