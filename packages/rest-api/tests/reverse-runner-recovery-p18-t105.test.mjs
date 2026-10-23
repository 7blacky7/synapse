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


/** Echte PG-Recovery + unveränderter Lifecycle, nur Docker ist eine Attrappe. */
async function altlastRecovery(f,job,instanceId,alterRunUnklar=false){
 const fake=dockerFake(),b=await f.row(instanceId),d=await f.descriptor();
 const cfg={docker:fake.docker,binding:async(id,j)=>recovery.binding(id,j),stopSeconds:async()=>1};
 let recovery,lc;
 const oldTransport=new ReverseContainerTransport(cfg);
 const started=await oldTransport.start(d,{instance_id:instanceId,generation:b.generation,project,job_id:null,warmup_job_id:randomUUID(),name:'old-api-session',isCurrent:async()=>true});
 await f.db.query('UPDATE tool_containers SET container_id=$2 WHERE instance_id=$1',[instanceId,started.id]);
 // API-Neustart: Container bleibt, lokaler Transport ist neu.
 const transport=new ReverseContainerTransport(cfg);
 const txRows=[],txBytes=[];
 const pool={get totalCount(){return f.db.totalCount;},get idleCount(){return f.db.idleCount;},get waitingCount(){return f.db.waitingCount;},
  query:(...a)=>f.db.query(...a),connect:async()=>{
   const c=await f.db.connect();let rows=0,bytes=0;
   return {release:()=>c.release(),query:async(...a)=>{const sql=String(a[0]);if(sql==='BEGIN'){rows=0;bytes=0;}
    const out=await c.query(...a);if(/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)){rows+=out.rowCount??0;bytes+=Buffer.byteLength(JSON.stringify(a[1]??[]));}
    if(sql==='COMMIT'){txRows.push(rows);txBytes.push(bytes);}return out;}};
  }};
 recovery=new ReverseContainerRecovery({pool,ready:x=>transport.ready(x),identity:async()=>f.who,claimIdentity:()=>f.who});
 const oldGeneration=randomUUID(),oldIds=[];
 for(const [state,generation,runState] of [['failed',oldGeneration,alterRunUnklar?'unknown':'done'],['cancelled',oldGeneration,'done'],['completed',b.generation,'done']]){
  const j=await f.newJob();
  await f.db.query("UPDATE work_jobs SET state=$2,output_ref=input_ref,resource_unconfirmed=true,error_code='historische_fixture',completed_at=now() WHERE id=$1",[j.id,state]);
  await f.run(j,{...b,generation},runState);oldIds.push(j.id);
 }
 const snapshot=async()=>({
  jobs:(await f.db.query('SELECT * FROM work_jobs WHERE id=ANY($1::uuid[]) ORDER BY id',[oldIds])).rows,
  runs:(await f.db.query('SELECT * FROM tool_container_runs WHERE instance_id=$1 AND generation=$2 ORDER BY job_id',[instanceId,oldGeneration])).rows
 });
 const before=await snapshot();
 assert.equal(transport.ready({...b,container_id:started.id}),false);
 assert.equal(await recovery.allow(job,f.db),false);
 assert.equal(await recovery.before('reverse-e',job.id),false);
 const reserved=await f.row(instanceId),diag=JSON.parse(reserved.last_error);
 assert.equal(reserved.state,'stopping');assert.equal(diag.ruhe.terminale_marker,'3');assert.equal(diag.ruhe.alte_runs_offen,alterRunUnklar?'1':'0');
 assert.equal(diag.ruhe.aktive_runs,'0');assert.equal(diag.ruhe.offene_jobs,'0');
 assert.equal(recovery.beforeGrund('reverse-e',job.id),'stopping');
 assert.deepEqual(await snapshot(),before,'Recovery verändert keine alten Marker/Runs');
 assert.ok(txRows.length>0&&txRows.every(n=>n<=1),JSON.stringify(txRows));
 const budget=core.reverseBigInt(await core.leseReverseEinstellwerte({},f.db),'materialisierung_tx_bytes');
 assert.ok(txBytes.every(n=>BigInt(n)<=budget));
 try{
  let released=0;
  lc=new ToolLifecycle({pool:f.db,executor:transport,resources:{acquire:async()=> 'new-fixture-resource',release:async()=>{released++;}},registerGuards:false});
  await lc.tick();
  assert.equal((await f.row(instanceId)).state,'cold');assert.equal(released,1);assert.equal(fake.calls.stop,1);
  assert.deepEqual(await snapshot(),before,'Lifecycle bestätigt keine terminalen Altmarker oder Runs alter Generationen');
  assert.equal(await recovery.before('reverse-e',job.id),true);
  await lc.wake('reverse-e',project,job.id);
  const next=await f.row(instanceId);
  assert.equal(next.state,'warm');assert.notEqual(next.generation,b.generation);
  assert.equal(transport.ready(next),true);assert.equal(await recovery.before('reverse-e',job.id),true);
  assert.equal(await recovery.allow(job,f.db),true);
  assert.equal(recovery.beforeGrund('reverse-e',job.id),undefined);
  return {transport,evidence:{oldGeneration:b.generation,newGeneration:next.generation,oldIds,diag,txRows,txBytes,stop:fake.calls.stop,start:fake.calls.start},
   verify:async()=>assert.deepEqual(await snapshot(),before,'alte Endmarker bleiben nach echtem Claim bytegleich'),
   close:()=>{for(const x of new Set(fake.containers.values()))x.stream.destroy();}};
 }finally{lc?.close();}
}

/** Realer Provider + ServerExecutor.refresh + P20.claim, nur die Registrierung ist vorab gefixt.
 * Während der Messung arbeiten exakt A/B; Docker/Hostmessung brauchen keine echte Nutzlast. */
export async function claimParallelProbe(t,{tool='reverse-e',kind,negativ=false,fehlenderSnapshot=false,resume=false,altlast=false,alterRunUnklar=false}={}){
 const {AsyncLocalStorage}=await import('node:async_hooks');
 const {setTimeout:pause}=await import('node:timers/promises');
 const {createHash}=await import('node:crypto');
 const {ServerExecutor}=await import('../dist/services/server-executor.js');
 const {reverseServerIdentitaet}=await import('../dist/services/reverse-executor.js');
 const {mitLesePool}=await import('../../core/dist/db/client.js');
 const f=await fixture();let a,b,lc,unregister,refreshPending,recovered;
 const envKeys=['SYNAPSE_COMPUTE_RESOURCE_BINDINGS','SYNAPSE_COMPUTE_ADMISSION','SYNAPSE_COMPUTE_POLICY'];
 const oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
 const guardContext=new AsyncLocalStorage();
 const evidence={tool,kind:kind??tool,negativ,fehlenderSnapshot,resume,guardSelects:0,guardWrites:0,guardSecondConnections:0,blocker:[],guardCalls:0};
 try{
  process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify({[f.who.nodeId]:{hostResourceDomain:'t105-test',deviceIds:[]}});
  process.env.SYNAPSE_COMPUTE_ADMISSION='0';process.env.SYNAPSE_COMPUTE_POLICY='0';
  await f.db.query("ALTER TABLE embedding_knoten ADD ressourcen jsonb,ADD last_sequence bigint DEFAULT 0,ADD aktualisiert_am timestamptz,ADD executor_owner text DEFAULT 't105-owner'");
  await f.db.query("CREATE TABLE auth_tokens(token_hash text,kind text,scope text,expires_at timestamptz)");
  await f.db.query("INSERT INTO auth_tokens VALUES($1,'service',$2,NULL)",[f.who.authHash,'compute-node:'+f.who.nodeId]);
  const other={nodeId:'t105-other',bootGeneration:randomUUID(),authHash:'other-auth'};
  await f.db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[other.nodeId,other.bootGeneration,other.authHash]);
  const job=await f.newJob({tool,kind,state:'pending',attempt:0});
  const instanceId=createHash('sha256').update(tool+'\0'+project+'\0'+(tool==='reverse-leser'?job.id:'project')).digest('hex');
  await f.instance(job,{tool,id:instanceId});
  if(altlast){recovered=await altlastRecovery(f,job,instanceId,alterRunUnklar);evidence.recovery=recovered.evidence;}
  if(tool==='reverse-leser')await f.db.query("INSERT INTO reverse_leser_laeufe(id,work_job_id,diagnose) VALUES($1,$2,$3)",[randomUUID(),job.id,resume?{host_validiert:true}:{transport:{phase:'vorbereitung'}}]);
  const foreign=await f.jobs.enqueue({kind:'test-normal',capability:'test-normal',project:'t105-project',scope:'test',
   inputRef:{scope:'test',id:'synthetic',revision:'1',sha256:'d'.repeat(64)},resourceNeed:{cpu:1,ram:32,vram:0,gpu:false},idempotencyKey:randomUUID()});
  a=await f.db.connect();b=await f.db.connect();
  const qa=a.query.bind(a),qb=b.query.bind(b);
  evidence.pidA=(await qa('SELECT pg_backend_pid() pid')).rows[0].pid;
  evidence.pidB=(await qb('SELECT pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual(evidence.pidA,evidence.pidB);
  await qa("SET statement_timeout='5000ms'");
  await qb(negativ?"SET statement_timeout='1500ms'":"SET statement_timeout='5000ms'");
  // Testhülle kontrolliert ausschließlich Verbindungswahl; alle Statements gehen an echte PG-Clients.
  const queryA=async(...args)=>{
   const sql=typeof args[0]==='string'?args[0]:args[0].text;
   if(guardContext.getStore()){
    if(!/^\s*SELECT\b/i.test(sql)){evidence.guardWrites++;assert.fail('Guard schreibt: '+sql);}
    evidence.guardSelects++;
   }
   return qa(...args);
  };
  const clientA={query:queryA,release(){}};
  const poolA={query:queryA,connect:async()=>{
   if(guardContext.getStore()){evidence.guardSecondConnections++;assert.fail('connect im Guard');}
   return clientA;
  }};
  const poolB={query:async(...args)=>{
   if(guardContext.getStore()){evidence.guardSecondConnections++;assert.fail('zweite Verbindung im Guard');}
   return qb(...args);
  },connect:async()=>{assert.equal(guardContext.getStore(),undefined);return {query:qb,release(){}};}};
  const forbiddenPool={query:()=>{evidence.guardSecondConnections++;assert.fail('Recovery-Pool im Guard');},
   connect:()=>{evidence.guardSecondConnections++;assert.fail('Recovery-connect im Guard');}};
  // start() repräsentiert nur die bereits autorisierte Registrierung; refresh() bleibt die echte Methode.
  const server=Object.assign(Object.create(ServerExecutor.prototype),{
   identity:{nodeId:f.who.nodeId},fence:{nodeId:f.who.nodeId,bootId:f.who.bootGeneration,tokenHash:f.who.authHash,executorOwner:'t105-owner'},
   ready:true,cpuOnly:true,prefix:'T105_TEST_',hex:'aus',hexGebunden:false,start:async()=>0,
  });
  const provider=reverseServerIdentitaet({},server);
  assert.equal(provider.snapshot(),null);
  if(!fehlenderSnapshot){assert.deepEqual(await provider(),f.who);assert.equal(Object.isFrozen(provider.snapshot()),true);}
  const guard=new ReverseContainerRecovery({pool:forbiddenPool,identity:provider,claimIdentity:provider.snapshot,ready:x=>recovered?recovered.transport.ready(x):!resume});
  lc=new ToolLifecycle({pool:poolA,executor:{},registerGuards:true});
  const allow=guard.allow.bind(guard);let first=true,blockedRefresh=false,parallelBarrier=null;
  guard.allow=async(j,c)=>{
   if(parallelBarrier&&j.id===parallelBarrier.id){
    const barrier=parallelBarrier;parallelBarrier=null;barrier.entered();
    await barrier.started;
    const deadline=Date.now()+1000;
    while(Date.now()<deadline){
     const row=(await qa('SELECT pg_blocking_pids($1) blockers',[evidence.pidB])).rows[0];
     if(row.blockers.includes(evidence.pidA)){evidence.parallelClaimBlocker=row.blockers;break;}
     await pause(5);
    }
    assert.ok(evidence.parallelClaimBlocker?.includes(evidence.pidA),'Nicht-Reverse-Claim wartet begrenzt auf denselben Lifecycle-Lock');
   }
   if(j.id===job.id&&first&&!fehlenderSnapshot){
    first=false;
    // Start des echten Refresh auf B nach Erwerb der Claim-Locks auf A.
    refreshPending=mitLesePool(poolB,()=>provider());
    const deadline=Date.now()+1000;
    while(Date.now()<deadline){
     const row=(await qa('SELECT pg_blocking_pids($1) blockers',[evidence.pidB])).rows[0];
     if(row.blockers.includes(evidence.pidA)){evidence.blocker=row.blockers;blockedRefresh=true;break;}
     await pause(5);
    }
    assert.equal(blockedRefresh,true,'PG muss B->A als echte Sperrbeziehung sehen');
    const locks=await qa('SELECT locktype,mode,granted FROM pg_locks WHERE pid=$1 AND (locktype=$2 OR NOT granted)',[evidence.pidA,'advisory']);
    evidence.claimLocks=locks.rows;
    assert.ok(locks.rows.some(x=>x.locktype==='advisory'&&x.granted));
    if(negativ){
     // Alte Produktionskette: im Claim auf denselben schreibenden Refresh warten.
     // statement_timeout auf B begrenzt die Kontrolle; provider liefert nach Fehler null.
     assert.equal(await mitLesePool(poolB,()=>provider()),null);
     assert.equal(provider.snapshot(),null);return false;
    }
   }
   evidence.guardCalls++;
   return guardContext.run(true,()=>allow(j,c));
  };
  unregister=guard.register();
  const service=pool=>core.createWorkJobService({pool,config:{interactiveReserve:0},
   resourceDomain:id=>'domain:'+id,
   authorizeJob:async(node,j)=>((node.node_id===f.who.nodeId)===(j.project===project))
    ?{resourceDomain:'domain:'+node.node_id,maxConcurrent:4,budget:{cpu:16,ram:8192,vram:0,gpu:false}}:null,
   inputStillCurrent:async()=>true,outputIsStaged:async()=>true});
  const claims=await service(poolA).claim(f.who,{limit:1});
  if(refreshPending)await refreshPending;
  assert.equal(claims.length,negativ||fehlenderSnapshot||alterRunUnklar?0:1);
  if(claims.length){assert.equal(claims[0].id,job.id);assert.equal(claims[0].attempt,1);}
  const next=await service(poolB).claim(other,{limit:1});
  assert.equal(next[0]?.id,foreign.id,'echter Nicht-Reverse-Claim nach Freigabe globaler Claimlocks');
  if(alterRunUnklar){
   // Zusätzlicher P20-Bestandbefund: generischer Guard zählt unknown ohne Generation.
   // Kein Bestätigen/Umgehen im Reverse-Fix; keine Assertion des positiven Live-Falls abschwächen.
   assert.equal(claims.length,0);assert.equal(next.length,1);assert.equal(evidence.guardSelects,0);
   await recovered.verify();
   t.diagnostic('T105 zusätzliche P20-Negativprobe '+JSON.stringify({...evidence,reverseClaims:0,nonReverseClaims:1}));
   return;
  }
  // Zweite echte Parallelrunde: A/B claimen überlappend, gleicher allgemeiner Lifecycle-Guard.
  const more=await service(poolA).enqueue({kind:'test-normal',capability:'test-normal',project:'t105-project',scope:'test',
   inputRef:{scope:'test',id:'next',revision:'1',sha256:'e'.repeat(64)},resourceNeed:{cpu:1,ram:32,vram:0,gpu:false},idempotencyKey:randomUUID()});
  const second=await service(poolA).enqueue({kind:job.kind,capability:job.capability,project,scope:'reverse',
   inputRef:{scope:'reverse',id:'rev-second',revision:'1',sha256:'f'.repeat(64)},resourceNeed:job.resourceNeed,idempotencyKey:randomUUID()});
  if(tool==='reverse-leser'){
   const iid=createHash('sha256').update(tool+'\0'+project+'\0'+second.id).digest('hex');
   await qa("INSERT INTO tool_containers(instance_id,tool_id,project,work_job_id,generation,state,container_id,resource_token) VALUES($1,$2,$3,$4,$5,'warm','second-fake','second-resource')",[iid,tool,project,second.id,randomUUID()]);
   await qa("INSERT INTO reverse_leser_laeufe(id,work_job_id,diagnose) VALUES($1,$2,$3)",[randomUUID(),second.id,resume?{host_validiert:true}:{}]);
  }
  let entered,startB;
  const entry=new Promise(resolve=>{entered=resolve;}),started=new Promise(resolve=>{startB=resolve;});
  parallelBarrier={id:second.id,entered,started};
  const claimA=service(poolA).claim(f.who,{limit:1});
  await Promise.race([entry,claimA.then(()=>{throw Error('Claim A erreichte zweite Reverse-Zeile nicht');})]);
  const claimB=service(poolB).claim(other,{limit:1});startB();
  const [again,parallel]=await Promise.all([claimA,claimB]);
  assert.equal(parallel[0]?.id,more.id);
  if(negativ||fehlenderSnapshot)assert.equal(again.length,0);
  else{assert.equal(again[0]?.id,second.id);assert.equal(again[0]?.attempt,1);}
  evidence.parallelReverseClaims=again.length;
  const residual=(await qa("SELECT pid,state,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND (state LIKE 'idle in transaction%' OR cardinality(pg_blocking_pids(pid))>0)",[[evidence.pidA,evidence.pidB]])).rows;
  assert.deepEqual(residual,[]);
  assert.equal(evidence.guardWrites,0);assert.equal(evidence.guardSecondConnections,0);
  evidence.reverseClaims=claims.length;evidence.nonReverseClaims=next.length+parallel.length;evidence.residual=residual;
  await recovered?.verify();
  t.diagnostic('T105 echte PG-Probe '+JSON.stringify(evidence));
 }finally{
  unregister?.();lc?.close();recovered?.close();
  // Auch Negativkontrollen verlassen keine offenen Transaktionen.
  if(a)await a.query('ROLLBACK').catch(()=>{});
  if(refreshPending)await refreshPending.catch(()=>{});
  if(b)await b.query('ROLLBACK').catch(()=>{});
  a?.release();b?.release();
  for(const [key,value] of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await f.close();
 }
}

if(process.argv[1]===fileURLToPath(import.meta.url)){

test('T105 Nachtrag: Altlast -> Recovery -> Lifecycle -> neue Generation -> echter Parallelclaim',{timeout:20000},t=>claimParallelProbe(t,{altlast:true}));
test('T105 Abgrenzung: alter unknown-Run sperrt im unveränderten P20, Nicht-Reverse läuft',{timeout:20000},t=>claimParallelProbe(t,{altlast:true,alterRunUnklar:true}));

test('T105 Nachtrag: aktuelle Runs/offene Jobs bleiben gesperrt, Diagnose und TX1',{timeout:20000},async t=>{
 const f=await fixture();const warning=console.warn,logs=[];let c;
 try{
  console.warn=(...a)=>{if(a[0]==='[reverse-recovery]')logs.push(a);else warning(...a);};
  const pending=await f.newJob({state:'pending',attempt:0}),b=await f.instance();
  const old=await f.newJob();await f.db.query("UPDATE work_jobs SET state='failed',resource_unconfirmed=true WHERE id=$1",[old.id]);
  await f.run(old,{...b,generation:randomUUID()},'unknown');
  const current=await f.newJob();await f.run(current,b,'running');
  c=await f.db.connect();const query=c.query.bind(c),rows=[],bytes=[];let mutations=0,txBytes=0;
  c.connect=()=>{throw Error('B1 reconnect');};
  c.query=async(...a)=>{const sql=String(a[0]);const out=await query(...a);
   if(/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)){mutations+=out.rowCount??0;txBytes+=Buffer.byteLength(JSON.stringify(a[1]??[]));}return out;};
  const r=new ReverseContainerRecovery({pool:c,ready:()=>false,identity:async()=>f.who,claimIdentity:()=>f.who});
  const step=async()=>{await query('BEGIN');mutations=0;txBytes=0;
   try{assert.equal(await r.before('reverse-e',pending.id),false);await query('COMMIT');rows.push(mutations);bytes.push(txBytes);}
   catch(e){await query('ROLLBACK');throw e;}
   return JSON.parse((await f.row(b.instance_id)).last_error);
  };
  const active=await step();assert.equal(active.grund,'reverse_ende_unbestaetigt');assert.equal(active.ruhe.aktive_runs,'1');assert.equal(active.ruhe.offene_jobs,'1');
  const stamp=(await f.row(b.instance_id)).updated_at,logCount=logs.length;await step();
  assert.deepEqual((await f.row(b.instance_id)).updated_at,stamp);assert.equal(logs.length,logCount,'kein Poll-Logspam');assert.equal(rows.at(-1),0);
  await f.db.query("UPDATE work_jobs SET state='completed',output_ref=input_ref,resource_unconfirmed=true WHERE id=$1",[current.id]);
  await f.db.query("UPDATE tool_container_runs SET state='unknown' WHERE job_id=$1",[current.id]);
  const unknown=await step();assert.equal(unknown.ruhe.aktive_runs,'1');assert.equal(unknown.ruhe.aktuelle_enden_offen,'1');
  await f.db.query("UPDATE tool_container_runs SET state='done' WHERE job_id=$1",[current.id]);
  for(const state of ['pending','leased','staged']){
   await f.db.query("UPDATE work_jobs SET state=$2,staged_output_ref=input_ref,resource_unconfirmed=true WHERE id=$1",[current.id,state]);
   const blocked=await step();assert.equal(blocked.ruhe.offene_jobs,'1');assert.equal((await f.row(b.instance_id)).state,'warm');
  }
  assert.equal(r.beforeGrund('reverse-e',pending.id),'reverse_ende_unbestaetigt');
  // Echter Executor-Durchlauf muss den Vor-Claim-Grund zurückgeben (sonstige Arbeit ersetzt).
  const {ReverseExecutor}=await import('../dist/services/reverse-executor.js');
  const executor=Object.assign(Object.create(ReverseExecutor.prototype),{beendet:false,eingerichtet:true,k:{parallel:1,kinds:['reverse-E'],leaseSeconds:60},
   laufend:new Map(),altScope:false,pool:{query:async()=>({rows:[{id:pending.id}]})},deps:{lifecycle:()=>({wake:()=>assert.fail('gesperrt')}),identitaet:async()=>f.who,recovery:r},
   jobs:{get:async()=>pending,claim:async()=>[]},raeumeArbeitAuf:async()=>0,policyPruefen:async()=>{}});
  const result=await executor.durchlauf();assert.equal(result.hinweis,'reverse_ende_unbestaetigt');assert.equal(result.gestartet,0);
  const budget=core.reverseBigInt(await core.leseReverseEinstellwerte({},f.db),'materialisierung_tx_bytes');
  assert.ok(rows.every(n=>n<=1));assert.ok(bytes.every(n=>BigInt(n)<=budget));
  assert.ok(logs.every(x=>!x[1].includes('historische_fixture')&&!x[1].includes('t105-auth')));
  t.diagnostic(JSON.stringify({txRows:rows,txBytes:bytes,grund:result.hinweis,logs:logs.length}));
 }finally{console.warn=warning;if(c){await c.query('ROLLBACK').catch(()=>{});c.release();}await f.close();}
});

for(const kind of ['reverse-E','reverse-S3'])test('T105: echter Claim/Guard gegen parallelen Refresh '+kind,{timeout:15000},t=>claimParallelProbe(t,{kind}));
test('T105: begrenzte Negativkontrolle alter Claim->Refresh-Wartepfad',{timeout:15000},t=>claimParallelProbe(t,{negativ:true}));
test('T105: fehlender Snapshot hält nur Reverse, Nicht-Reverse claimt',{timeout:15000},t=>claimParallelProbe(t,{fehlenderSnapshot:true}));
test('T105: Identitätssnapshot wird bei Fehler, Rotation und Stop ungültig',{timeout:10000},async()=>{
 const {reverseServerIdentitaet}=await import('../dist/services/reverse-executor.js');
 const who={nodeId:'snapshot',bootId:randomUUID(),tokenHash:'snapshot-auth'};
 let finish,mode='ok',count=0;
 const server={identity:{nodeId:who.nodeId},fence:who,start:async()=>0,refresh:async()=>{
  count++;if(mode==='pending')return new Promise(resolve=>{finish=resolve;});
  if(mode==='error')throw Error('test-refresh-error');return mode==='ok';
 }};
 const p=reverseServerIdentitaet({},server);assert.equal(p.snapshot(),null);await p();
 const first=p.snapshot();assert.equal(Object.isFrozen(first),true);
 mode='pending';const updating=p();assert.equal(p.snapshot(),first,'kein Warten auf Promise');
 finish(true);await updating;
 mode='false';assert.equal(await p(),null);assert.equal(p.snapshot(),null);
 mode='ok';await p();server.fence={...who,bootId:randomUUID()};
 assert.equal(p.snapshot(),null,'lokaler Fencewechsel invalidiert ohne I/O');await p();assert.equal(p.snapshot().bootGeneration,server.fence.bootId);
 mode='error';assert.equal(await p(),null);assert.equal(p.snapshot(),null);
 mode='ok';await p();mode='pending';const last=p();p.beende();finish(true);assert.equal(await last,null);assert.equal(p.snapshot(),null);
 const calls=count;assert.equal(await p(),null);assert.equal(count,calls,'beendet startet nichts mehr');
});
test('T105: atomare Idle-Recovery, Boot/Generation/aktive Jobs, fremder Guard ohne I/O',async()=>{
 const f=await fixture();try{
  let reads=0;const noio=new ReverseContainerRecovery({pool:f.db,ready:()=>{throw Error('ready forbidden');},identity:async()=>{throw Error('identity forbidden');},claimIdentity:()=>{throw Error('snapshot forbidden');}});
  assert.equal(await noio.allow({project:'projekt',kind:'compute',capability:'compute'},{query(){reads++;throw Error('DB forbidden');}}),true);assert.equal(reads,0);
  const r=new ReverseContainerRecovery({pool:f.db,ready:()=>false,identity:async()=>f.who,claimIdentity:()=>f.who});
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
  const c=await f.db.connect();try{await c.query('BEGIN');const held=new ReverseContainerRecovery({pool:c,ready:()=>false,identity:async()=>f.who,claimIdentity:()=>f.who});
   const connect=c.connect;c.connect=()=>{throw Error('held reconnect');};
   assert.equal((await held.requestStop(current,true)).neu_gestartet,true);c.connect=connect;await c.query('ROLLBACK');
  }finally{c.release();}
  assert.equal((await f.row(b.instance_id)).state,'warm','caller rollback preserved');
 }finally{await f.close();}
});
test('T105: NichtGesendet nur vor write, exakter Run+Lease, Audit idempotent und TX1',async()=>{
 const f=await fixture();try{
  const fake=dockerFake(),r=new ReverseContainerRecovery({pool:f.db,ready:()=>false,identity:async()=>f.who,claimIdentity:()=>f.who});
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
  const recovery=new ReverseContainerRecovery({pool:f.db,ready:b=>transport.ready(b),identity:async()=>f.who,claimIdentity:()=>f.who});
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
   const r=new ReverseContainerRecovery({pool:f.db,ready:b=>transport.ready(b),identity:async()=>f.who,claimIdentity:()=>f.who});
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
