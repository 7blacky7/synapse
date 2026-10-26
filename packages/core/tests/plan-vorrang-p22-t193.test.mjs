/**
 * P22-T193 / Abnahme5cca231a P2.1: echter planIndex.sync aus plans.ts gegen echte lokale Embedding-Queue
 * und echte createComputeAdmission-PG-Zulassung. Code > Plan/Wissen > Verlauf, laufender Datensatz bleibt.
 * Nur synapse_test:5433, privates Schema; Ollama/Qdrant-HTTP sind kontrollierte Transportattrappen,
 * keine Modellguete/Produktivhardware. Keine Quellenoption fuer Plan im Test: Herkunft MUSS vom Dienst kommen.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const testDbEingang=process.env.DATABASE_URL;
const pgOnly=process.argv.includes('--pg');
const db=new URL(process.env.DATABASE_URL);assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const schema='p193_plan_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:db.href});
db.searchParams.set('options','-c search_path='+schema);
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_SKIP_EMBEDDINGS'])delete process.env[k];
const starts=[],pending=[],jobs=[];let aborted=0,checks=0,pool,gate,finishing=false;
const track=p=>{p.catch(()=>{});jobs.push(p);return p;};
const server=createServer(async(req,res)=>{
 let raw='';for await(const p of req)raw+=p;const body=raw?JSON.parse(raw):{};
 const reply=result=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({result,status:'ok',time:0}));};
 if(req.url==='/api/tags')return res.end(JSON.stringify({models:[{name:'p193-fixture',digest:'a'.repeat(64)}]}));
 if(req.url==='/api/embed'){
  starts.push(body.input[0]);
  if(finishing){res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0,0,0])}));return;}
  pending.push({res,body});
  res.on('close',()=>{if(!res.writableEnded)aborted++;});return;
 }
 if(req.url==='/')return res.end(JSON.stringify({title:'fixture',version:'1.15.0'}));
 if(req.url==='/collections')return reply({collections:[]});
 if(req.url.includes('/points'))return reply({status:'completed',operation_id:1});
 return reply({config:{params:{vectors:{size:4,distance:'Cosine'}}},points_count:0});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const backend='http://127.0.0.1:'+server.address().port;
Object.assign(process.env,{DATABASE_URL:db.href,SYNAPSE_COMPUTE_NODE:'1',SYNAPSE_NODE_MAX_CONCURRENCY:pgOnly?'4':'1',
 SYNAPSE_COMPUTE_ADMISSION:'0',EMBED_MIN_GAP_MS:'0',EMBEDDING_PROVIDER:'ollama',OLLAMA_MODEL:'p193-fixture',
 OLLAMA_URL:backend,QDRANT_URL:backend,EMBEDDING_QUERY_PREFIX:'',EMBEDDING_DOC_PREFIX:'',
 EMBEDDING_NUM_CTX:'512',EMBEDDING_MAX_CHARS:'2048',EMBEDDING_TARGET_DIM:'4'});
const complete=()=>{const p=pending.shift();assert.ok(p,'P22-T193 Ollama pending');p.res.end(JSON.stringify({embeddings:p.body.input.map(()=>[1,0,0,0])}));};
async function wait(fn,label){const end=Date.now()+12000;while(!(await fn())){if(Date.now()>end)throw Error('P22-T193 '+label+' erwartet=Fortschritt ist='+JSON.stringify({starts,aborted}));await new Promise(r=>setTimeout(r,10));}}
function ok(value,label,ist){assert.ok(value,'P22-T193 plans.ts/compute-admission.ts '+label+' erwartet=true ist='+JSON.stringify(ist??{starts,aborted}));checks++;console.log('OK P22-T193 '+label);}
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const t of ['plans','projects','code_files','code_chunks','embed_prioritaet','intern_schalter','embedding_knoten'])
  await admin.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 const D=await import('../dist/db/client.js');pool=D.getPool();
 await pool.query('CREATE TABLE auth_tokens(token_hash text PRIMARY KEY,kind text,scope text,expires_at timestamptz)');
 for(const [file,key]of [['compute-admission-schema','COMPUTE_ADMISSION_SCHEMA_SQL'],['compute-policy-schema','COMPUTE_POLICY_SCHEMA_SQL'],['work-jobs-schema','WORK_JOBS_SCHEMA_SQL']]){
  const m=await import('../dist/db/'+file+'.js');await pool.query(m[key]);
 }
 const emb=await import('../dist/embeddings/index.js'),plans=await import('../dist/services/plans.js');
 gate=await import('../dist/services/compute-admission.js');
 const identity={nodeId:'p193-plan',bootId:randomUUID(),authHash:'a'.repeat(64)},host=schema,device='GPU-p193',key=JSON.stringify([host,device]);
 const stamp=new Date().toISOString(),metric=value=>({value,measuredAt:stamp,serverReceivedAt:stamp,scope:'device',quality:'measured',freshness:'fresh'});
 const resources={cpu:{cores:metric(8),loadPercent:metric(0)},ram:{totalMb:metric(4096),availableMb:metric(2048)},gpus:[{deviceId:device,origin:'fixture',totalMb:metric(1000),freeMb:metric(1000),residentOwnModelMb:metric(0),utilizationPercent:metric(0)}]};
 Object.assign(process.env,{SYNAPSE_COMPUTE_POLICY_ENABLED:'1',SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS:'600000',
 SYNAPSE_COMPUTE_RESOURCE_BINDINGS:JSON.stringify({[identity.nodeId]:{hostResourceDomain:host,deviceIds:[device],location:'pc'}}),
 SYNAPSE_COMPUTE_ADMISSION_DOMAINS:JSON.stringify({[key]:{maxHttp:1,interactiveReserve:0,vramMb:1000,modelMb:{'p193-fixture':100},pollMs:10,maxWaitMs:20000,agingMs:100}})});
 await pool.query("INSERT INTO auth_tokens VALUES($1,'service',$2,NULL)",[identity.authHash,'compute-node:'+identity.nodeId]);
 await pool.query("INSERT INTO embedding_knoten(node_id,host,ollama_url,modell,modell_digest,native_dimension,ziel_dimension,num_ctx,vram_gesamt_mb,vram_frei_mb,max_concurrency,service_token_hash,boot_id,boot_started_at,host_resource_domain,status,letzter_kontakt,features,ressourcen) VALUES($1,'fixture',$2,'p193-fixture',$3,4,4,512,1000,1000,1,$3,$4,clock_timestamp(),$5,'ready',clock_timestamp(),ARRAY['compute_admission'],$6::jsonb)",[identity.nodeId,backend,identity.authHash,identity.bootId,host,JSON.stringify(resources)]);
 await pool.query('INSERT INTO compute_node_policy(node_id,ausfuehrungsfreigabe) VALUES($1,true)',[identity.nodeId]);
 const service=gate.createComputeAdmission(pool);
 // Einmalige Infrastruktur-Dimensionserkennung ist kein Plan-Dokumentauftrag.
 finishing=true;await (await import('../dist/qdrant/index.js')).ensureCollection('p193-warm');finishing=false;starts.length=0;
 // Getrennte Prozesse: lokal1 Slot, PG4 lokale Plaetze/1 physischer Slot.
 for(const pg of [pgOnly]){
  const mode=pg?'PG-Admission':'lokale Queue',offset=starts.length;
  process.env.SYNAPSE_COMPUTE_ADMISSION=pg?'1':'0';
  gate.configureRemoteComputeAdmission(pg?{
   acquire:(model,c)=>service.acquire({...identity,model,source:c.source,priority:c.priority,maxWaitMs:c.maxWaitMs,backend:c.backend}),
   finish:(lease,confirmed)=>service.finish(identity,lease,confirmed),
  }:null);
  const plan={id:randomUUID(),project:'p193-private',name:'plan-'+mode,description:'Wissen',goals:[],tasks:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await pool.query('INSERT INTO plans(id,project,name,description,goals,tasks) VALUES($1,$2,$3,$4,$5::text[],$6::jsonb)',[plan.id,plan.project,plan.name,plan.description,[],'[]']);
  const lauf=track(emb.embed('alt-'+mode,{art:'dokument',priority:'background',admissionSource:'verlauf'}));
  await wait(()=>starts.length===offset+1,mode+' erster HTTP-Aufruf');
  const verlauf=track(emb.embed('neu-'+mode,{art:'dokument',priority:'background',admissionSource:'verlauf'}));
  const code=track(emb.embed('code-'+mode,{art:'dokument',priority:'background',admissionSource:'parser-worker'}));
  const planJob=track(plans.planIndex.sync(plan)); // KEINE Herkunft aus dem Test einschmuggeln.
  if(pg){
   await wait(async()=>Number((await pool.query("SELECT count(*) AS n FROM compute_admission_requests WHERE state='waiting'")).rows[0].n)===3,mode+' drei wartende PG-Auftraege');
   const rows=(await pool.query("SELECT source,priority FROM compute_admission_requests WHERE source='wissen:plans' AND state='waiting'")).rows;
   ok(rows.length===1&&rows[0].priority==='hintergrund',mode+' direkter Plan meldet wissen:plans/hintergrund',rows);
  }else{
   await wait(()=>emb.embeddingWarteschlangeEintraege().length===3,mode+' drei wartende Auftraege');
   ok(emb.embeddingWarteschlangeEintraege().map(x=>x.klasse).join(',')==='code,wissen,verlauf',mode+' direkter Plan ist Wissensklasse',emb.embeddingWarteschlangeEintraege());
  }
  ok(starts.length===offset+1&&aborted===0,mode+' Plan unterbricht laufenden Datensatz nicht');
  complete();await lauf;await wait(()=>starts.length===offset+2,mode+' Code startet');
  ok(starts[offset+1]==='code-'+mode,mode+' Code vor neuem Plan');complete();await code;
  await wait(()=>starts.length===offset+3,mode+' Plan startet');
  ok(starts[offset+2].startsWith(plan.name),mode+' Plan vor wartendem Verlauf');complete();await planJob;
  ok(!!(await pool.query('SELECT embedded_at FROM plans WHERE id=$1',[plan.id])).rows[0].embedded_at,mode+' echter Plan-Index markiert PG');
  await wait(()=>starts.length===offset+4,mode+' Verlauf startet');
  ok(starts[offset+3]==='neu-'+mode,mode+' Verlauf nach Code und Plan');complete();await verlauf;
 }
 ok(aborted===0,'keine Abbrueche oder Doppelstarts');
 console.log('BESTANDEN '+checks+' P22-T193 direkter Plan/echte PG-Admission');
}catch(error){console.error('DEBUG P22-T193 Plan/Admission erwartet=Vertrag erfuellt ist='+error.stack);throw error;}finally{
 finishing=true;while(pending.length)complete();await Promise.allSettled(jobs);
 gate?.configureRemoteComputeAdmission(null);
 server.closeAllConnections();await new Promise(r=>server.close(r));
 const D=await import('../dist/db/client.js');await D.closePool().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
// Der normale Testlaeufer muss beide Betriebsarten abdecken, ohne manuelles --pg.
if(!pgOnly)await new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--pg'],{
  env:{...process.env,DATABASE_URL:testDbEingang},stdio:'inherit',
 });
 child.once('error',reject);
 child.once('close',code=>code===0?resolve():reject(Error('P22-T193 PG-Kindprozess erwartet=0 ist='+code)));
});
