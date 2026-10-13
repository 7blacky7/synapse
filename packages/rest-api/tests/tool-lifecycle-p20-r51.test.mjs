/** Permanente R5.1-Verhaltensprobe: nur eigene synapse_test/p20_r51-Fixtures. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';
const db=await oeffneGeschuetzteShellTestDb();
const aDb=await oeffneGeschuetzteShellTestDb();
const bDb=await oeffneGeschuetzteShellTestDb();
const adapter=client=>({query:client.query.bind(client),async connect(){return {query:client.query.bind(client),release(){}};}});
const S='p20_r51_'+randomUUID().replaceAll('-',''),P='p20_r51_'+randomUUID();
await db.query('CREATE SCHEMA '+S);
await db.query('SET search_path TO '+S);
await aDb.query('SET search_path TO '+S);
await bDb.query('SET search_path TO '+S);
const pool=adapter(db);
try {
 const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
 const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
 const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
 const {validateToolDescriptor,registerToolDescriptor,setToolActivation}=await import('../../core/dist/services/tool-descriptor.js');
 const {erfasseToolAktivitaet}=await import('../../core/dist/services/tool-aktivitaet.js');
 const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
 await db.query(WORK_JOBS_SCHEMA_SQL);await db.query(TOOL_AKTIVITAET_SCHEMA_SQL);
 await db.query(TOOL_CONTAINER_SCHEMA_SQL);await db.query(TOOL_CONTAINER_SCHEMA_SQL);
 await db.query('CREATE TABLE projects(name text,enabled boolean)');
 await db.query('INSERT INTO projects VALUES($1,true)',[P]);
 const d=validateToolDescriptor({tool_id:'fixture',tool:'reverse',capability:'fixture.reverse',image:'fixture:1',digest:'sha256:'+'a'.repeat(64),
  mounts:[],resources:{cpu:1,ram:64,vram:0,gpu:false,pids:32,tmpfs:8,concurrency:2},
  limits:{time_ms:1000,output_bytes:4096,input_bytes:4096},
  lifecycle:{idle_ms:1,activity_lookback_seconds:1,cpu_idle_percent:1,gpu_idle_percent:1,measurement_max_age_ms:1000,start_timeout_ms:1000,max_starts:3,start_window_ms:60000,pause_ms:60000}});
 const actor={role:'koordinator',authenticated:true};
 assert.throws(()=>validateToolDescriptor({...d,digest:'latest'}));
 assert.throws(()=>validateToolDescriptor({...d,mounts:[{role:'project',target:'/project',write:true,project_share:true}]}));
 await assert.rejects(()=>registerToolDescriptor(pool,d,{role:'compute',authenticated:true}));
 await registerToolDescriptor(pool,d,actor);
 await setToolActivation(pool,d.tool_id,null,true,actor);
 await setToolActivation(pool,d.tool_id,P,true,actor);
 let starts=0,stops=0,releases=0,alive=false,fail=false,resolveStop;
 const executor={
  async start(desc,ctx){starts++;assert.equal(desc.network,'none');assert.equal(ctx.project,P);if(fail)throw Error('fixture crash');await pause(5);alive=true;return {id:'fake-'+ctx.generation,coldstart_ms:5};},
  async observe(id){return {running:alive,cpu_percent:0,gpu_percent:null,container_id:id,measured_at:(await db.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString()};},
  async stop(){stops++;await new Promise(resolve=>{resolveStop=resolve;});alive=false;},
  async command(){return {status:'ok'};}
 };
 const resources={async acquire(){return 'resource-fixture';},async release(){releases++;}};
 const a=new ToolLifecycle({pool:adapter(aDb),executor,resources,maxContainers:1});
 const b=new ToolLifecycle({pool:adapter(bDb),executor,resources,maxContainers:1});
 await a.tick();assert.equal(starts,0,'enabled alone is not activity');
 assert.equal((await a.status('fixture',P)).coldstart_estimate_ms,'unknown');
 const act=()=>erfasseToolAktivitaet({project:P,tool:'reverse',aktion:'inspect',akzeptiert:true,zaehltAlsAktivitaet:true},
  {descriptor:{toolId:'fixture',tool:'reverse',aktivitaetsAktionen:['inspect']},gebundenesProjekt:P,berechtigt:true},pool);
 await act();
 await Promise.all([a.wake('fixture',P),b.wake('fixture',P),a.wake('fixture',P)]);
 assert.equal(starts,1,'PG coldstart singleflight across services');
 assert.equal((await a.status('fixture',P)).coldstart_estimate_ms,5);
 await db.query("UPDATE tool_aktivitaet SET zeit=now()-interval '10 minutes'");
 await db.query("UPDATE tool_containers SET ready_at=now()-interval '10 minutes'");
 const jobId=randomUUID();
 await db.query("INSERT INTO work_jobs(id,kind,capability,project,scope,input_ref,resource_need,priority,idempotency_key,request_hash) VALUES($1,'fixture','fixture.reverse',$2,'fixture',$3,$4,'interaktiv','fixture-job',$5)",
  [jobId,P,{scope:'fixture',id:'input',revision:'1',sha256:'b'.repeat(64)},{cpu:1,ram:16,vram:0,gpu:false},'c'.repeat(64)]);
 await a.tick();assert.equal(stops,0,'open job prevents idle stop beyond X');
 await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[jobId]);
 const stopping=a.tick();
 for(let n=0;!resolveStop&&n<500;n++)await pause(10);assert(resolveStop,JSON.stringify(await a.status('fixture',P)));
 assert.equal((await a.status('fixture',P)).status,'stopping');
 await act();await b.wake('fixture',P);
 assert.equal(starts,1,'call while stopping is durably queued');
 resolveStop();await stopping;
 assert.equal(releases,1,'resource release only after observed Docker end');
 await a.tick();assert.equal(starts,2,'held activity is not lost');
 await db.query("UPDATE tool_aktivitaet SET zeit=now()-interval '10 minutes'");
 await db.query("UPDATE tool_containers SET ready_at=now()-interval '10 minutes'");
 resolveStop=undefined;
 const stop2=a.tick();for(let n=0;!resolveStop&&n<500;n++)await pause(10);assert(resolveStop,JSON.stringify(await a.status('fixture',P)));resolveStop();await stop2;
 fail=true;await act();
 await assert.rejects(()=>a.wake('fixture',P),/fixture crash|container_gesperrt/);
 await a.wake('fixture',P).catch(()=>{});
 assert.equal((await a.status('fixture',P)).status,'blocked','crash loop blocks starts');
 console.log('PASS p20_r51: descriptor/auth/DDL/enabled/singleflight/PGjobs/idle/stopping/requeue/coldstart/crashblock');
 a.close();b.close();
} finally {await aDb.end();await bDb.end();await db.query('SET search_path TO public');await db.query('DROP SCHEMA '+S+' CASCADE');await db.end();}
