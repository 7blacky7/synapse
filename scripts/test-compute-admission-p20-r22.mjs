#!/usr/bin/env node
/** P20-T15/R2.2: eigener guarded Testbereich; keine Hardware und keine Live-DB. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {r22Pool} from './lib/p20-r22-db.mjs';
const mode=process.argv[2]??'test',root=process.argv[3];
const moduleUrl=p=>root?pathToFileURL(root+'/'+p):new URL('../'+p,import.meta.url);
if(mode==='feature-probe'){
 const m=await import(moduleUrl('packages/core/dist/services/compute-admission.js'));
 assert.equal(typeof m.createComputeAdmission,'function');console.log('R2.2 FEATURE_PRESENT');process.exit(0);
}
const schema='p20_r22_'+process.pid,pool=await r22Pool(schema);
const {mitLesePool}=await import(moduleUrl('packages/core/dist/db/client.js'));
const claimsModule=await import(moduleUrl('packages/core/dist/services/embedding-claims.js'));
const boot='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),host=schema,device='GPU-r22',key=JSON.stringify([host,device]);
const identity=nodeId=>({nodeId,bootId:boot,authHash:hash+nodeId});
let backend='http://127.0.0.1:9',count=0,made=false,admission,service,config,children=[],server;
const envKeys=['SYNAPSE_COMPUTE_ADMISSION','SYNAPSE_COMPUTE_POLICY_ENABLED','SYNAPSE_COMPUTE_RESOURCE_BINDINGS','SYNAPSE_COMPUTE_ADMISSION_DOMAINS','SYNAPSE_COMPUTE_NODE','SYNAPSE_SERVER_NODE_ID','SYNAPSE_SERVER_EMBED_DEVICE_ID','SYNAPSE_COMPUTE_ADMISSION_DEVICES','SYNAPSE_COMPUTE_MAX_CPU_LOAD_PERCENT','SYNAPSE_COMPUTE_MAX_GPU_LOAD_PERCENT','SYNAPSE_COMPUTE_PC_HELP_NEEDED','SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS'];
const saved=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
async function check(label,fn){await fn();count++;console.log('PASS '+label);}
function setConfig(next){config=next;process.env.SYNAPSE_COMPUTE_ADMISSION_DOMAINS=JSON.stringify({[key]:next});}
function resources(free=1000,own=0,age=0,quality='measured'){
 const stamp=new Date(Date.now()-age).toISOString(),m=value=>({value,measuredAt:stamp,serverReceivedAt:stamp,scope:'device',quality,freshness:'fresh'});
 return {cpu:{cores:m(8),loadPercent:m(0)},ram:{totalMb:m(4096),availableMb:m(2048)},gpus:[{deviceId:device,origin:'fixture',totalMb:m(1000),freeMb:m(free),residentOwnModelMb:m(own),utilizationPercent:m(0)}]};
}
async function reset(){
 await pool.query('TRUNCATE compute_admission_requests,compute_admission_models,compute_admission_metrics,compute_admission_domains,work_jobs,work_job_audit,compute_project_policy');
 await pool.query("UPDATE embedding_knoten SET status='ready',gesperrt_vom_user=false,boot_id=$1,letzter_kontakt=clock_timestamp(),modell='r22-fixture',ollama_url=$2,features=ARRAY['compute_admission'],ressourcen=$3::jsonb",[boot,backend,JSON.stringify(resources())]);
 await pool.query("UPDATE compute_node_policy SET ausfuehrungsfreigabe=true,usersperre='{}'");
 process.env.SYNAPSE_COMPUTE_ADMISSION='1';process.env.SYNAPSE_COMPUTE_POLICY_ENABLED='1';
 setConfig({maxHttp:2,interactiveReserve:1,vramMb:1000,modelMb:{'r22-fixture':100},pollMs:10,maxWaitMs:10000,agingMs:100});
}
const input=(node='r22-a',extra={})=>({...identity(node),id:randomUUID(),source:'parser-worker',priority:'hintergrund',model:'r22-fixture',backend,...extra});
const run=i=>service.attempt(i);
const error=code=>e=>e.code===code||e.message===code;
async function seedChunks(prio=null){
 await pool.query('TRUNCATE code_chunks,code_files,projects,embed_prioritaet');
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES('p20_r22','fixture','/synthetic',true)");
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) VALUES('r22-file','p20_r22','src/a.ts','a.ts','typescript')");
 for(let i=0;i<4;i++)await pool.query('INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end,prio) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[
 '22222222-2222-4222-8222-'+String(i+1).padStart(12,'0'),'p20_r22','src/a.ts',i,'synthetic '+i,i+1,i+2,prio]);
}
async function claim(node='r22-a',options={}){return mitLesePool(pool,()=>claimsModule.claimEmbeddingChunks(node,{limit:2,maxConcurrent:2,...options},pool));}
async function golden(){
 const result={};
 for(const [name,prio]of [['vorgezogen',3],['normal',null],['hinten',-3]]){
  await seedChunks(prio);
  const first=await claim(),second=await claim();
  result[name]={first:first.map(c=>({...c,claimToken:'<token>',leaseUntil:'<time>'})),second};
  assert.equal(first.length,2);assert.equal(second.length,0);
 }
 return result;
}
async function actor(){
 const proc=fork(new URL('./lib/p20-r22-child.mjs',import.meta.url),[],{env:{...process.env,R22_SCHEMA:schema,OLLAMA_URL:backend,OLLAMA_MODEL:'r22-fixture'},stdio:['ignore','pipe','pipe','ipc']});
 children.push(proc);let output='';proc.stdout.on('data',x=>{output+=x;});proc.stderr.on('data',x=>{output+=x;});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child_ready_timeout '+output)),15000);
 proc.once('error',reject);proc.once('exit',code=>reject(Error('child_exit '+code+' '+output)));proc.once('message',m=>{clearTimeout(timer);assert.equal(m.ready,true);resolve();});});
 let serial=0;
 return {proc,request(body){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{proc.off('message',receive);reject(Error('child_request_timeout '+output));},15000);
 function receive(m){if(m.id===id){clearTimeout(timer);proc.off('message',receive);m.error?reject(Error(m.error)):resolve(m.value);}}
 proc.on('message',receive);proc.send({id,...body});});}};
}
try{
 await pool.query('CREATE SCHEMA '+schema);made=true;
 for(const table of ['projects','code_files','code_chunks','embed_prioritaet','intern_schalter','embedding_knoten'])
  await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING ALL)');
 await pool.query("CREATE TABLE auth_tokens(token_hash text PRIMARY KEY,kind text,scope text,expires_at timestamptz)");
 delete process.env.SYNAPSE_COMPUTE_ADMISSION;delete process.env.SYNAPSE_COMPUTE_POLICY_ENABLED;
 const snap=await golden();
 if(mode==='golden-capture'){console.log('GOLDEN_JSON '+JSON.stringify(snap));}
 else{
  const expected=JSON.parse(await readFile(new URL('./fixtures/p20-r22-claims-t85.golden.json',import.meta.url),'utf8'));
  await check('t85-Golden: drei Chunkprioritäten und per-Node-Cap unverändert',()=>assert.deepEqual(snap,expected));
  if(mode!=='golden-verify'){
  admission=await import('../packages/core/dist/services/compute-admission.js');
  const {COMPUTE_ADMISSION_SCHEMA_SQL}=await import('../packages/core/dist/db/compute-admission-schema.js');
  const {COMPUTE_POLICY_SCHEMA_SQL}=await import('../packages/core/dist/db/compute-policy-schema.js');
  const {WORK_JOBS_SCHEMA_SQL}=await import('../packages/core/dist/db/work-jobs-schema.js');
  await pool.query(COMPUTE_ADMISSION_SCHEMA_SQL);await pool.query(COMPUTE_POLICY_SCHEMA_SQL);await pool.query(WORK_JOBS_SCHEMA_SQL);
  await check('Admission-DDL zweimal auf echter PG-Verbindung',()=>pool.query(COMPUTE_ADMISSION_SCHEMA_SQL));
  service=admission.createComputeAdmission(pool);
  for(const node of ['r22-a','r22-b']){
   await pool.query("INSERT INTO auth_tokens VALUES($1,'service',$2,NULL)",[identity(node).authHash,'compute-node:'+node]);
   await pool.query("INSERT INTO embedding_knoten(node_id,host,ollama_url,modell,modell_digest,native_dimension,ziel_dimension,num_ctx,vram_gesamt_mb,vram_frei_mb,max_concurrency,service_token_hash,boot_id,boot_started_at,host_resource_domain) VALUES($1,'fixture',$2,'r22-fixture',$3,4,4,512,1000,1000,2,$4,$5,clock_timestamp(),$6)",[node,backend,hash,identity(node).authHash,boot,host]);
   await pool.query("INSERT INTO compute_node_policy(node_id,ausfuehrungsfreigabe) VALUES($1,true)",[node]);
  }
  for(const k of envKeys)delete process.env[k];
  process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify(Object.fromEntries(['r22-a','r22-b'].map(n=>[n,{hostResourceDomain:host,deviceIds:[device],location:'pc'}])));
  process.env.SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS='600000';
  await reset();
  await check('Gate aus benötigt weder DB noch Binding',async()=>{
   process.env.SYNAPSE_COMPUTE_ADMISSION='0';
   const trap=admission.createComputeAdmission({query(){throw Error('PG forbidden');},connect(){throw Error('PG forbidden');}});
   assert.equal(await trap.attempt(input()),null);assert.equal(admission.computeAdmissionDomain('missing'),null);
  });
  await reset();
  await check('Gate verlangt R1.2-Policy',async()=>{
   delete process.env.SYNAPSE_COMPUTE_POLICY_ENABLED;
   await assert.rejects(()=>run(input()),error('admission_policy_required'));process.env.SYNAPSE_COMPUTE_POLICY_ENABLED='1';
  });
  await check('Modellalias mit widersprüchlichen Budgets abgewiesen',()=>{
   setConfig({...config,modelMb:{'r22-fixture':100,'r22-fixture:latest':200}});
   assert.throws(()=>admission.computeAdmissionDomain('r22-a'),error('admission_model_budget_conflict'));
  });
  await reset();
  await check('HTTP-Cap + Interaktivreserve + Modell genau einmal',async()=>{
   const bg=await run(input()),wait=await run(input('r22-b'));
   assert.equal(bg.state,'running');assert.equal(wait.state,'waiting');
   const interactive=await run(input('r22-b',{priority:'interaktiv'}));assert.equal(interactive.state,'running');
   assert.equal((await run(input('r22-a',{priority:'interaktiv'}))).state,'waiting');
   assert.equal((await pool.query('SELECT SUM(reserved_mb)::int AS n FROM compute_admission_models')).rows[0].n,100);
   assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM compute_admission_requests WHERE state='running'")).rows[0].n,2);
  });
  await reset();
  await check('Gealterter BG-Kopf verbraucht keine harte Interaktivreserve',async()=>{
   await run(input());const waiting=await run(input('r22-b',{priority:'nachzug'}));
   await pool.query("UPDATE compute_admission_requests SET queued_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=$1",[waiting.id]);
   assert.equal((await run(input('r22-b',{priority:'interaktiv'}))).state,'running');
  });
  await reset();
  await check('Alle Prioritäten teilen Slots; maxWait0 kann einmal sofort zulassen',async()=>{
   setConfig({...config,interactiveReserve:0});
   for(const priority of ['nachzug','hintergrund','interaktiv']){
    await pool.query('TRUNCATE compute_admission_requests,compute_admission_models,compute_admission_metrics');
    const a=await run(input('r22-a',{priority,maxWaitMs:0})),b=await run(input('r22-b',{priority,maxWaitMs:0}));
    assert.equal(a.state,'running');assert.equal(b.state,'running');assert.equal(await run(input('r22-b',{priority,maxWaitMs:0})),null);
   }
  });
  await reset();
  await check('Retry-ID idempotent, Identitäts-/Requestwechsel gesperrt',async()=>{
   const i=input(),lease=await run(i);assert.deepEqual(await run({...i,model:'r22-fixture:latest'}),lease);
   await assert.rejects(()=>run({...i,source:'media-code'}),error('admission_request_conflict'));
   assert.equal((await pool.query("SELECT requested::int AS n FROM compute_admission_metrics WHERE source='parser-worker'")).rows[0].n,1);
  });
  await reset();
  await check('Node-, Boot-, Auth-, Backend- und Modellfences',async()=>{
   for(const [patch,code]of [[{bootId:randomUUID()},'admission_node_not_usable'],[{authHash:'bad'},'admission_node_not_usable'],[{backend:backend+'/other'},'admission_backend_binding_invalid'],[{model:'other'},'admission_model_budget_missing']])
    await assert.rejects(()=>run(input('r22-a',patch)),error(code));
   await pool.query("UPDATE auth_tokens SET expires_at=clock_timestamp()-INTERVAL '1 hour' WHERE scope='compute-node:r22-a'");
   await assert.rejects(()=>run(input()),error('admission_auth_invalid'));
   await pool.query("UPDATE auth_tokens SET expires_at=NULL");
  });
  await reset();
  await check('Usersperre und fehlender Consent verhindern Zulassung',async()=>{
   await pool.query("UPDATE embedding_knoten SET gesperrt_vom_user=true WHERE node_id='r22-a'");
   await assert.rejects(()=>run(input()),error('admission_node_not_usable'));
   await pool.query("UPDATE embedding_knoten SET gesperrt_vom_user=false WHERE node_id='r22-a'");
   await pool.query("UPDATE compute_node_policy SET ausfuehrungsfreigabe=false WHERE node_id='r22-a'");
   await assert.rejects(()=>run(input()),error('admission_policy_denied'));
  });
  await reset();
  await check('Ungebundener Produzent sichtbar und gesperrt',async()=>{
   await assert.rejects(()=>run(input('r22-a',{source:'unbound'})),error('admission_producer_unbound'));
   assert.equal((await pool.query("SELECT uncovered::int AS n FROM compute_admission_metrics WHERE source='unbound'")).rows[0].n,1);
  });
  await reset();
  await check('Frische Telemetrie Pflicht: stale/estimated/fehlend sperren',async()=>{
   for(const res of [resources(1000,0,900000),resources(1000,0,0,'estimated'),null]){
    await pool.query('UPDATE embedding_knoten SET ressourcen=$1::jsonb',[res&&JSON.stringify(res)]);
    assert.equal((await run(input())).state,'waiting');
    await pool.query('TRUNCATE compute_admission_requests');
   }
  });
  await reset();
  await check('Modellbudget gegen reales freies VRAM; Eigenmodellkredit gedeckelt',async()=>{
   await pool.query('UPDATE embedding_knoten SET ressourcen=$1::jsonb',[JSON.stringify(resources(0,500))]);
   setConfig({...config,modelMb:{'r22-fixture':100}});
   assert.equal((await run(input())).state,'running','beobachtetes eigenes Modell gedeckt');
   const need={gpu:true,vram:200};
   assert.equal(await admission.computeAdmissionAllowsWork(pool,'r22-a',need,'interaktiv',host),false,'500 gemeldet,100 gebucht ergibt keinen freien Kredit');
   assert.equal(await admission.computeAdmissionAllowsWork(pool,'r22-a',{gpu:false,vram:0},'hintergrund','wrong'),true);
   assert.equal(await admission.computeAdmissionAllowsWork(pool,'r22-a',{gpu:true,vram:0},'interaktiv','wrong'),false);
  });
  await reset();
  await check('Fremde Modellresidenz erzeugt keinen Eigenkredit',async()=>{
   await pool.query("UPDATE embedding_knoten SET modell='other',ressourcen=$1::jsonb",[JSON.stringify(resources(0,500))]);
   setConfig({...config,modelMb:{'r22-fixture':100,'other':100}});
   // Bei Matching-Registrymodell darf nur dessen prospektive Reservation kreditiert werden.
   await pool.query("INSERT INTO compute_admission_models(resource_domain,model,reserved_mb) VALUES($1,'r22-fixture:latest',100)",[key]);
   assert.equal(await admission.computeAdmissionAllowsWork(pool,'r22-a',{gpu:true,vram:1},'interaktiv',host),false);
  });
  await reset();
  await check('Unconfirmed hält Slot; Late-ACK und Finish idempotent auch Gateoff',async()=>{
   const i=input(),lease=await run(i);assert.equal(await service.finish(identity('r22-a'),lease,false),true);
   assert.equal(await service.finish(identity('r22-a'),lease,false),true);
   assert.equal((await run(input('r22-b'))).state,'waiting');
   assert.equal(await service.finish(identity('r22-b'),lease,true),false);
   process.env.SYNAPSE_COMPUTE_ADMISSION='0';
   assert.equal(await service.finish(identity('r22-a'),lease,true),true);assert.equal(await service.finish(identity('r22-a'),lease,true),true);
   const m=(await pool.query("SELECT completed::int,unconfirmed::int FROM compute_admission_metrics WHERE source='parser-worker'")).rows[0];
   assert.deepEqual(m,{completed:1,unconfirmed:1});
  });
  await reset();
  await check('Modelabsenz nur ohne aktive Rechnung und mit exakter Revision',async()=>{
   const i=input(),a=await run(i),old=await service.modelObservation('r22-a','r22-fixture');
   await assert.rejects(()=>service.observeModelAbsent('r22-a','r22-fixture',old),error('admission_model_busy'));
   await service.finish(identity('r22-a'),a,true);
   const b=await run(input()),next=await service.modelObservation('r22-a','r22-fixture');assert.notEqual(next,old);
   await service.finish(identity('r22-a'),b,true);
   await service.observeModelAbsent('r22-a','r22-fixture',old);assert.equal(await service.modelObservation('r22-a','r22-fixture'),next);
   await service.observeModelAbsent('r22-a','r22-fixture',next);assert.equal(await service.modelObservation('r22-a','r22-fixture'),null);
  });
  await reset();
  await check('Konfigurationshash sperrt abweichende Prozesse; CAS nur drained',async()=>{
   const a=await run(input()),old=(await pool.query('SELECT policy_hash FROM compute_admission_domains')).rows[0].policy_hash;
   setConfig({...config,maxHttp:3});await assert.rejects(()=>run(input('r22-b')),error('admission_domain_config_conflict'));
   await assert.rejects(()=>service.setDomainConfig('r22-a',old),error('admission_domain_not_drained'));
   await service.finish(identity('r22-a'),a,true);
   await pool.query('TRUNCATE compute_admission_models');
   assert.equal(await service.setDomainConfig('r22-a','f'.repeat(64)),false);
   assert.equal(await service.setDomainConfig('r22-a',old),true);assert.equal((await run(input('r22-b'))).state,'running');
  });
  await reset();
  await check('Compute-node braucht aktuelle eigene TEXT-Chunkrefs; Opt-out nach Prefetch gilt',async()=>{
   await seedChunks(3);const leased=await claim(),refs=leased.map(({chunkId,claimToken,contentHash})=>({chunkId,claimToken,contentHash}));
   await assert.rejects(()=>run(input('r22-a',{source:'compute-node',claims:[null]})),error('admission_claims_invalid'));
   await assert.rejects(()=>run(input('r22-b',{source:'compute-node',claims:refs})),error('admission_claims_stale'));
   await assert.rejects(()=>run(input('r22-a',{source:'compute-node',claims:refs.map(r=>({...r,contentHash:'f'.repeat(64)}))})),error('admission_claims_stale'));
   assert.equal((await run(input('r22-a',{source:'compute-node',claims:refs}))).state,'running');
   await pool.query("INSERT INTO compute_project_policy(project,pc_gpu_ausgeschlossen) VALUES('p20_r22',true)");
   await assert.rejects(()=>run(input('r22-a',{source:'compute-node',claims:refs})),error('admission_project_denied'));
  });
  await reset();
  await check('Prefetch verbraucht keinen HTTP-Slot und Cap gilt in allen Claimzweigen',async()=>{
   for(const prio of [3,null,-3]){
    await seedChunks(prio);
    const cs=await claim();assert.equal(cs.length,2);assert.equal((await claim()).length,0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM compute_admission_requests')).rows[0].n,0);
    assert.equal((await service.status()).leasedChunks.find(x=>x.owner==='r22-a').leased_chunks,2);
   }
   await pool.query("UPDATE embedding_knoten SET features=ARRAY[]::text[] WHERE node_id='r22-b'");
   await seedChunks();assert.equal((await claim('r22-b')).length,0,'alter ungecoverter Client bekommt keine GPUclaims');
  });
  await reset();
  await check('Vorhandene GPU-Workreservation blockiert HTTP, CPU zählt nicht',async()=>{
   await pool.query("INSERT INTO work_jobs(id,kind,capability,project,scope,input_ref,resource_need,priority,idempotency_key,request_hash,state,resource_domain,owner_node,boot_generation,resource_unconfirmed) VALUES($1,'fixture','fixture','p20_r22','test','{}','{\"cpu\":1,\"ram\":1,\"gpu\":true,\"vram\":100}', 'hintergrund','r22-job',$2,'pending',$3,'r22-a',$4,true)",[randomUUID(),hash,host,boot]);
   const request=input();assert.equal((await run(request)).state,'waiting');
   await pool.query("UPDATE work_jobs SET resource_need='{\"cpu\":1,\"ram\":1,\"gpu\":false,\"vram\":0}'");
   assert.equal((await run(request)).state,'running');
  });
  await reset();
  await check('Unzuordenbare Legacy-GPUarbeit bleibt konservativ reserviert',async()=>{
   await pool.query("INSERT INTO work_jobs(id,kind,capability,project,scope,input_ref,resource_need,priority,idempotency_key,request_hash,state,resource_domain,resource_unconfirmed) VALUES($1,'fixture','fixture','p20_r22','test','{}','{\"cpu\":1,\"ram\":1,\"gpu\":true,\"vram\":100}', 'hintergrund','r22-legacy',$2,'pending','unknown-legacy',true)",[randomUUID(),hash]);
   assert.equal((await run(input())).state,'waiting');
  });
  await reset();
  await check('Intern-Modellcontrol wartet exklusiv und sperrt neue HTTPs',async()=>{
   const bg=await run(input()),i=input('r22-b',{source:'intern-ollama',priority:'interaktiv'}),wait=await run(i);
   assert.equal(wait.state,'waiting');await service.finish(identity('r22-a'),bg,true);
   const control=await run(i);assert.equal(control.state,'running');
   assert.equal((await run(input('r22-a',{priority:'interaktiv'}))).state,'waiting');
  });
  await reset();
  await check('Remoteadapter gibt lokalen Slot während PG-Warten frei und bestätigt kompletten Body',async()=>{
   let released=false,resumed=false,finished;
   admission.configureRemoteComputeAdmission({acquire:async()=>{assert.equal(released,true);assert.equal(resumed,false);return {id:randomUUID(),token:randomUUID(),domain:key,state:'running'};},finish:async(_l,c)=>{finished=c;}});
   const value=await admission.mitComputeAdmissionKontext({source:'media-code',priority:'interaktiv',releaseLocal:()=>{released=true;},resumeLocal:async()=>{resumed=true;}},()=>admission.mitComputeAdmission('r22-fixture',async end=>{assert.equal(resumed,true);end();return 7;},backend));
   assert.equal(value,7);assert.equal(finished,true);
   admission.configureRemoteComputeAdmission({acquire:async()=>({id:randomUUID(),token:randomUUID(),domain:key,state:'running'}),finish:async(_l,c)=>{finished=c;}});
   await assert.rejects(()=>admission.mitComputeAdmission('r22-fixture',async()=>{throw Error('network_unknown');}),/network_unknown/);assert.equal(finished,false);
   admission.configureRemoteComputeAdmission(null);
  });
  await reset();
  await check('Zwei unabhängige Prozesse teilen das Domaincap',async()=>{
   setConfig({...config,interactiveReserve:0});const a=await actor(),b=await actor();assert.notEqual(a.proc.pid,b.proc.pid);
   const results=await Promise.all(Array.from({length:10},(_,i)=>(i%2?a:b).request({action:'attempt',input:input(i%2?'r22-a':'r22-b')})));
   assert.equal(results.filter(x=>x.state==='running').length,2);
   assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM compute_admission_requests WHERE state='running'")).rows[0].n,2);
  });
  await reset();
  await check('Zwei echte HTTP-Blätter: Interaktiv startet ohne laufenden BG-Abbruch',async()=>{
   const pending=[],started=[];let aborted=0;
   server=createServer(async(req,res)=>{let text='';for await(const data of req)text+=data;
    const body=JSON.parse(text);started.push(body.input[0]);pending.push({body,res});
    res.on('close',()=>{if(!res.writableEnded)aborted++;});
   });
   await new Promise(r=>server.listen(0,'127.0.0.1',r));backend='http://127.0.0.1:'+server.address().port;
   await pool.query('UPDATE embedding_knoten SET ollama_url=$1',[backend]);
   const a=await actor(),b=await actor(),c=await actor();
   const first=a.request({action:'embed',identity:identity('r22-a'),source:'parser-worker',priority:'hintergrund',text:'BG1'});
   const waitFor=async fn=>{const until=Date.now()+8000;while(!fn()){if(Date.now()>until)throw Error('http_start_timeout');await new Promise(r=>setTimeout(r,10));}};
   await waitFor(()=>started.length===1);
   const bg2=b.request({action:'embed',identity:identity('r22-b'),source:'wissen-nachzug',priority:'hintergrund',text:'BG2'});
   // Warten auf tatsächliche PG-Warteschlange statt willkürlicher Zeitannahme.
   for(let i=0;i<100;i++){if((await pool.query("SELECT COUNT(*)::int AS n FROM compute_admission_requests WHERE state='waiting'")).rows[0].n===1)break;await new Promise(r=>setTimeout(r,10));}
   const interactive=c.request({action:'embed',identity:identity('r22-b'),source:'core-interaktiv',priority:'interaktiv',text:'INTER'});
   await waitFor(()=>started.length===2);assert.deepEqual(started,['BG1','INTER']);assert.equal(aborted,0);
   for(const p of pending.splice(0))p.res.end(JSON.stringify({embeddings:p.body.input.map(()=>[1,0,0,0])}));
   await first;await interactive;await waitFor(()=>started.length===3);assert.equal(started[2],'BG2');
   const last=pending.shift();last.res.end(JSON.stringify({embeddings:[[1,0,0,0]]}));await bg2;assert.equal(aborted,0);
   assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM compute_admission_requests WHERE state='finished'")).rows[0].n,3);
   await new Promise(r=>server.close(r));server=null;
  });
  await reset();
  await check('REST-Ausweis ist nodegebunden; Clientpriorität/Quelle kann Reserve nicht stehlen',async()=>{
   const req=createRequire(new URL('../packages/rest-api/package.json',import.meta.url)),Fastify=req('fastify');
   const {registerComputeAdmissionRoutes}=await import('../packages/rest-api/dist/routes/compute-admission.js');
   const app=Fastify(),tokens={a:{kind:'service',scope:'compute-node:r22-a',token_hash:identity('r22-a').authHash},b:{kind:'service',scope:'compute-node:r22-b',token_hash:identity('r22-b').authHash}};
   const calls=[];await registerComputeAdmissionRoutes(app,{validateToken:async t=>tokens[t]??null,admission:{...service,attempt:async i=>{calls.push(i);return null;}}});
   try{
    assert.equal((await app.inject({url:'/api/embedding-nodes/r22-a/admission',headers:{authorization:'Bearer b'}})).statusCode,403);
    const body={id:randomUUID(),bootId:boot,model:'r22-fixture',source:'intern-ollama',priority:'interaktiv',claims:[],backend};
    assert.equal((await app.inject({method:'POST',url:'/api/embedding-nodes/r22-a/admission',headers:{authorization:'Bearer a'},payload:body})).statusCode,200);
    assert.equal(calls[0].source,'compute-node');assert.equal(calls[0].priority,'hintergrund');assert.equal(calls[0].authHash,identity('r22-a').authHash);
   }finally{await app.close();}
  });
  await reset();
  await check('PC-Client verhandelt HTTP-only, stable ID, Claimrefs und korrektes Finish',async()=>{
   const {installComputeAdmissionClient,withComputeAdmissionFeature}=await import('../packages/compute-node-agent/dist/admission.js');
   const calls=[],leaseToken=randomUUID();let attempts=0;
   await installComputeAdmissionClient({nodeId:'r22-a',bootId:boot,stopped:()=>false,transport:async(_p,init)=>{
    if(init.method==='GET')return Response.json({success:true,enabled:true,pollMs:1,maxWaitMs:1000});
    const body=JSON.parse(init.body);calls.push(body);
    return Response.json(body.action==='finish'?{success:true,enabled:true,finished:true}:{success:true,enabled:true,admission:{id:body.id,token:leaseToken,domain:key,state:++attempts===1?'waiting':'running'}});
   }});
   const refs=[{chunkId:randomUUID(),claimToken:randomUUID(),contentHash:hash}];
   await mitLesePool({query(){throw Error('PC opened PG');},connect(){throw Error('PC opened PG');}},()=>admission.mitComputeAdmissionKontext({source:'compute-node',priority:'hintergrund',claims:refs},()=>admission.mitComputeAdmission('r22-fixture',async end=>{end();},backend)));
   assert.equal(calls.length,3);assert.equal(calls[0].id,calls[1].id);assert.deepEqual(calls[0].claims,refs);assert.equal(calls[2].confirmed,true);
   assert.deepEqual(withComputeAdmissionFeature({features:['compute_resources','compute_resources']}),{contractVersion:1,features:['compute_resources','compute_admission']});
   await installComputeAdmissionClient({nodeId:'r22-a',bootId:boot,stopped:()=>false,transport:async()=>new Response('',{status:404})});
   process.env.SYNAPSE_COMPUTE_NODE='1';
   assert.equal(admission.computeAdmissionAktiv(),false);assert.equal(await admission.mitComputeAdmission('m',async end=>{end();return 'legacy';}), 'legacy');
   delete process.env.SYNAPSE_COMPUTE_NODE;
  });
  console.log('R2.2 TEST_GRUEN '+count+' Prüfgruppen; 0 Skip; guarded synapse_test; eigene Schema-Bereinigung.');
  }
 }
}finally{
 admission?.configureRemoteComputeAdmission(null);admission?.configureLocalComputeAdmission(null);
 for(const child of children){if(child.connected)child.disconnect();}
 await Promise.all(children.map(p=>p.exitCode!==null?Promise.resolve():new Promise(r=>{p.once('exit',r);setTimeout(()=>{p.kill();r();},3000).unref();})));
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 if(made)await pool.query('DROP SCHEMA '+schema+' CASCADE');
 await pool.end();
 for(const [k,v]of Object.entries(saved))v===undefined?delete process.env[k]:process.env[k]=v;
}
