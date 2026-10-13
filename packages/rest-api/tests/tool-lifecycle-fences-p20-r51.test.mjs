/** R5.1 durable fences: own synapse_test schema, synthetic execution only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const db=await oeffneGeschuetzteShellTestDb(),runtimeDb=await oeffneGeschuetzteShellTestDb();
const S='p20_r51_'+randomUUID().replaceAll('-',''),P='p20_r51_'+randomUUID();
const adapter=c=>({query:c.query.bind(c),async connect(){return {query:c.query.bind(c),release(){}};}});
const pool=adapter(runtimeDb),services=[];
await db.query('CREATE SCHEMA '+S);
await db.query('SET search_path TO '+S);await runtimeDb.query('SET search_path TO '+S);
try {
 const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
 const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
 const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
 const {validateToolDescriptor,registerToolDescriptor,setToolActivation}=await import('../../core/dist/services/tool-descriptor.js');
 const {allowWorkJobClaim}=await import('../../core/dist/services/work-job-guards.js');
 const {erfasseToolAktivitaet}=await import('../../core/dist/services/tool-aktivitaet.js');
 const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
 await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(TOOL_AKTIVITAET_SCHEMA_SQL);await db.query(TOOL_CONTAINER_SCHEMA_SQL);
 await db.query('CREATE TABLE projects(name text,enabled boolean)');
 await db.query('INSERT INTO projects VALUES($1,true)',[P]);
 await db.query('CREATE TABLE embedding_knoten(node_id text,boot_id uuid,service_token_hash text)');
 const d=validateToolDescriptor({tool_id:'fences',tool:'reverse',capability:'fixture.fences',image:'fixture:1',digest:'sha256:'+'a'.repeat(64),mounts:[],
  resources:{cpu:1,ram:64,vram:0,gpu:false,pids:32,tmpfs:8,concurrency:1},limits:{time_ms:30,output_bytes:4096,input_bytes:4096},
  lifecycle:{idle_ms:1,activity_lookback_seconds:1,cpu_idle_percent:1,gpu_idle_percent:1,measurement_max_age_ms:1000,start_timeout_ms:30,max_starts:100,start_window_ms:60000,pause_ms:60000}});
 const actor={role:'koordinator',authenticated:true};
 await registerToolDescriptor(pool,d,actor);await setToolActivation(pool,d.tool_id,null,true,actor);await setToolActivation(pool,d.tool_id,P,true,actor);
 const activity=()=>erfasseToolAktivitaet({project:P,tool:'reverse',aktion:'inspect',akzeptiert:true,zaehltAlsAktivitaet:true},
  {descriptor:{toolId:d.tool_id,tool:'reverse',aktivitaetsAktionen:['inspect']},gebundenesProjekt:P,berechtigt:true},adapter(db));
 const expire=async()=>{await db.query("UPDATE tool_aktivitaet SET zeit=now()-interval '10 minutes'");await db.query("UPDATE tool_containers SET ready_at=now()-interval '10 minutes'");};
 const row=async()=> (await db.query('SELECT * FROM tool_containers')).rows[0];
 const make=(executor,resources)=>{const s=new ToolLifecycle({pool,executor,resources,maxContainers:1});services.push(s);return s;};
 let alive=false,starts=0,stops=0,releases=0,measurement='fresh',cpu=0,gpu=null,proof=false;
 const executor={
  async start(desc,ctx){starts++;alive=true;return {id:ctx.name,coldstart_ms:1};},
  async observe(id){const t=(await db.query('SELECT clock_timestamp() AS t')).rows[0].t;
   return {container_id:measurement==='foreign'?'foreign':id,running:alive,cpu_percent:cpu,gpu_percent:gpu,
    measured_at:new Date(+t+(measurement==='stale'?-60000:measurement==='future'?60000:0)).toISOString(),start_observed:proof};},
  async stop(){stops++;alive=false;},async cleanup(){},
  async command(){return {status:'ok'};}
 };
 const resources={async acquire(){return 'fixture-resource';},async release(){assert.equal(alive,false,'physical end before release');releases++;}};
 const waiting=make(executor,undefined);
 await activity();await waiting.wake(d.tool_id,P);const waitRow=await row();
 assert.equal(waitRow.state,'waiting');assert.equal(starts,0);
 await waiting.wake(d.tool_id,P);assert.equal((await row()).warmup_job_id,waitRow.warmup_job_id);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM work_jobs WHERE kind='tool-warmup'")).rows[0].n,1,'one reusable resource-wait warmup');
 assert.equal(await allowWorkJobClaim({kind:'tool-warmup',capability:d.capability+'.warmup',project:P},db),false);
 assert.equal(await allowWorkJobClaim({kind:'fixture',capability:'legacy.unregistered',project:P},db),true,'unregistered legacy capability unchanged');
 const lifecycle=make(executor,resources);
 await lifecycle.wake(d.tool_id,P);assert.equal(starts,1);
 const runtime=await row(),claim={kind:'fixture',capability:d.capability,project:P,id:randomUUID()};
 assert.equal(await allowWorkJobClaim(claim,db),true);
 await setToolActivation(pool,d.tool_id,P,false,actor);
 assert.equal(await allowWorkJobClaim(claim,db),false);await setToolActivation(pool,d.tool_id,P,true,actor);
 await expire();
 for(const m of ['stale','future','foreign']){measurement=m;await lifecycle.tick();assert.equal(stops,0,m+' measurement cannot authorize stop');}
 measurement='fresh';cpu=null;await lifecycle.tick();assert.equal(stops,0,'unknown CPU is not idle');
 cpu=50;await lifecycle.tick();assert.equal(stops,0,'busy CPU is not idle');cpu=0;
 const job=randomUUID(),who={nodeId:'fixture-node',bootGeneration:randomUUID(),authHash:'fixture-auth'},token=randomUUID();
 await db.query('INSERT INTO embedding_knoten VALUES($1,$2,$3)',[who.nodeId,who.bootGeneration,who.authHash]);
 await db.query("INSERT INTO work_jobs(id,kind,capability,project,scope,input_ref,resource_need,priority,idempotency_key,request_hash,state,owner_node,boot_generation,owner_auth_hash,resource_domain,claim_token,attempt,lease_until) VALUES($1,'fixture',$2,$3,'fixture',$4,$5,'interaktiv',$6,$7,'leased',$8,$9,$10,'fixture-domain',$11,1,clock_timestamp()+interval '1 minute')",
  [job,d.capability,P,{scope:'fixture',id:'input',revision:'1',sha256:'b'.repeat(64)},{cpu:1,ram:16,vram:0,gpu:false},'fixture-'+job,'c'.repeat(64),who.nodeId,who.bootGeneration,who.authHash,token]);
 await assert.rejects(()=>lifecycle.execute(d.tool_id,P,job,{...who,authHash:'wrong'},token,async()=>({op:'fixture'})),/tool_job_fenced/);
 let terminal;
 executor.command=async(id,payload,timeout,maxOutput,onTerminal)=>{assert.equal(payload.auftrag_id,job);terminal=onTerminal;throw Error('fixture timeout');};
 await assert.rejects(()=>lifecycle.execute(d.tool_id,P,job,who,token,async()=>({op:'fixture'})),/fixture timeout/);
 assert.equal((await db.query('SELECT state FROM tool_container_runs WHERE job_id=$1',[job])).rows[0].state,'unknown');
 await db.query("UPDATE work_jobs SET state='expired',resource_unconfirmed=false WHERE id=$1",[job]);
 await lifecycle.tick();assert.equal(stops,0,'unknown physical runner survives lease expiry');
 assert.equal(await allowWorkJobClaim(claim,db),false,'unknown physical runner blocks new claim');
 terminal();
 for(let n=0;n<100&&(await db.query('SELECT state FROM tool_container_runs WHERE job_id=$1',[job])).rows[0].state!=='done';n++)await pause(2);
 assert.equal((await db.query('SELECT state FROM tool_container_runs WHERE job_id=$1',[job])).rows[0].state,'done');
 await lifecycle.tick();assert.equal(stops,1);assert.equal(releases,1);
 assert.equal(await allowWorkJobClaim(claim,db),false,'cold tool blocks claim');
 await activity();let finishStart;
 executor.start=async(desc,ctx)=>{starts++;return await new Promise(resolve=>{finishStart=()=>{alive=true;resolve({id:ctx.name,coldstart_ms:1});};});};
 await assert.rejects(()=>lifecycle.wake(d.tool_id,P),/tool_operation_timeout/);
 assert.equal((await row()).state,'stopping');assert.equal((await row()).start_inflight,true);
 await lifecycle.tick();assert.equal(releases,1,'missing container after request timeout is not end proof');
 finishStart();await pause(10);await lifecycle.tick();assert.equal(releases,2,'late start is stopped before release');assert.equal(alive,false);
 await expire();
 // A restarted API may settle the start fence only from positive StartedAt proof.
 await db.query("UPDATE tool_containers SET state='stopping',container_id='orphan-fixture',resource_token='orphan-resource',operation_token=$1,start_inflight=true,wake_requested=false",[randomUUID()]);
 alive=true;proof=true;await lifecycle.tick();assert.equal(releases,3);assert.equal((await row()).state,'cold');
 // Fresh CPU data alone cannot stop GPU containers with unknown own GPU utilization.
 const g=validateToolDescriptor({...d,tool_id:'gpu-fences',capability:'fixture.gpu',gpu_driver:'nvidia',gpu_device_ids:['GPU-fixture'],resource_domain:'fixture-gpu',resources:{...d.resources,gpu:true,vram:32}});
 await registerToolDescriptor(pool,g,actor);await setToolActivation(pool,g.tool_id,null,true,actor);await setToolActivation(pool,g.tool_id,P,true,actor);
 await setToolActivation(pool,d.tool_id,P,false,actor);
 await erfasseToolAktivitaet({project:P,tool:'reverse',aktion:'inspect',akzeptiert:true,zaehltAlsAktivitaet:true},
  {descriptor:{toolId:g.tool_id,tool:'reverse',aktivitaetsAktionen:['inspect']},gebundenesProjekt:P,berechtigt:true},adapter(db));
 executor.start=async(desc,ctx)=>{starts++;alive=true;return {id:ctx.name,coldstart_ms:1};};
 await lifecycle.wake(g.tool_id,P);await expire();const before=stops;gpu=null;
 await lifecycle.tick();assert.equal(stops,before,'missing GPU observation is unknown');
 gpu=50;await lifecycle.tick();assert.equal(stops,before,'busy GPU prevents stop');
 gpu=0;await lifecycle.tick();assert.equal(stops,before+1);
 console.log('PASS p20_r51 fences: admissionwait/dedup/legacyclaim/controljob/activation/stale/future/foreign/CPU/GPU/job-auth/timeout/unknown/late-ACK/start-inflight/orphan-recovery');
} finally {
 for(const s of services)s.close();await runtimeDb.end();await db.query('SET search_path TO public');await db.query('DROP SCHEMA '+S+' CASCADE');await db.end();
}
