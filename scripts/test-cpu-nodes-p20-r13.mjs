#!/usr/bin/env node
// P20-T13: Golden vor Produktcode; Guard auf jeder echten Test-DB-Abfrage.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {oeffneGeschuetzteShellTestDb} from './lib/test-db-schutz.mjs';
const base=new URL(process.env.TEST_DATABASE_URL??process.env.DATABASE_URL??'');
assert.equal(base.pathname,'/synapse_test');assert.equal(base.port,'5433');
const schema='p20_r13_'+process.pid;
const db=await oeffneGeschuetzteShellTestDb();
await db.query('SET search_path TO '+schema+',public');
const mode=process.argv[2]??'test';
const req=createRequire(new URL('../packages/rest-api/package.json',import.meta.url));
const Fastify=req('fastify');
Object.assign(process.env,{OLLAMA_MODEL:'r13-fixture',SYNAPSE_OLLAMA_MODEL_DIGEST:'a'.repeat(64),
  SYNAPSE_OLLAMA_NATIVE_DIMENSION:'8',EMBEDDING_TARGET_DIM:'4',EMBEDDING_NUM_CTX:'512',
  SYNAPSE_GPU_REQUIRED_TOTAL_MB:'100',SYNAPSE_GPU_REQUIRED_FREE_MB:'50',
  EMBEDDING_QUERY_PREFIX:'q: ',EMBEDDING_DOC_PREFIX:'d: ',SYNAPSE_NODE_MAX_CLAIMS:'2',
  SYNAPSE_API_FEATURES:'compute_resources',OLLAMA_URL:'http://127.0.0.1:9'});
globalThis.fetch=async()=>{throw Error('Synthetische Probe ohne Netzwerk');};
const core=await import('../packages/core/dist/index.js');
const {createEmbeddingNodeRoutes}=await import('../packages/rest-api/dist/routes/embedding-nodes.js');
const tokens={gpu:{kind:'service',scope:'compute-node:r13-gpu',token_hash:'r13-gpu-hash'},
  cpu:{kind:'service',scope:'compute-node:r13-cpu',token_hash:'r13-cpu-hash'},
  admin:{kind:'session',scope:'mcp:tools',token_hash:'r13-admin-hash'}};
const app=Fastify();
await app.register(createEmbeddingNodeRoutes({db,validateToken:async x=>tokens[x]??null}));
const boot='11111111-1111-4111-8111-111111111111';
const fp={model:'r13-fixture',modelDigest:'a'.repeat(64),nativeDimension:8,targetDimension:4,numCtx:512};
const gpu={...fp,nodeId:'r13-gpu',host:'fixture',ollamaUrl:'http://127.0.0.1:9',
  vramTotalMb:1000,vramFreeMb:0,maxConcurrency:2,bootId:boot,bootStartedAt:'2026-01-01T00:00:00Z'};
const send=(method,path,body,token='gpu',version=false)=>app.inject({method,url:'/api/embedding-nodes/'+path,
  headers:{authorization:'Bearer '+token,...(version?{'x-synapse-contract-version':'1'}:{})},
  ...(body===undefined?{}:{payload:body})});
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(
  Object.entries(x).map(([k,v])=>[k,['serverTime','server_now','boot_started_at','registriert_am','letzter_kontakt','aktualisiert_am','bis','seit'].includes(k)?'<zeit>':stable(v)])):x;
const snap={};
async function capture(name,method,path,body){const r=await send(method,path,body);snap[name]={status:r.statusCode,body:stable(r.json())};return r;}
let made=false;
try{
  await db.query('CREATE SCHEMA '+schema);made=true;
  await db.query('CREATE TABLE '+schema+'.embedding_knoten (LIKE public.embedding_knoten INCLUDING ALL)');
  await capture('reference','GET','reference');
  assert.equal((await capture('register','POST','register',gpu)).statusCode,201);
  await capture('self','GET','r13-gpu/self');
  await capture('heartbeat','POST','r13-gpu/heartbeat',{...fp,status:'ready',vramFreeMb:0,activeJobs:0,bootId:boot,sequence:1});
  core.pausiereWorker('gpu_knoten',{dauer_min:5,grund:'p20_r13',von:'sol-1'});
  await capture('claims','POST','r13-gpu/claims',{limit:1});
  await capture('complete','POST','r13-gpu/claims/complete',{});
  await capture('release','POST','r13-gpu/claims/release',{claims:[]});
  if(mode==='golden-capture')console.log(JSON.stringify({golden:snap}));
  else{
    const expected=JSON.parse(await readFile(new URL('./fixtures/p20-r13-legacy.golden.json',import.meta.url),'utf8'));
    assert.equal(JSON.stringify(snap),JSON.stringify(expected),'Legacy-Golden bytegleich');
    console.log('R1.3 sieben Legacy-Goldens unverändert');
    const {CPU_NODES_SCHEMA_SQL}=await import('../packages/core/dist/db/cpu-nodes-schema.js');
    await db.query(CPU_NODES_SCHEMA_SQL);await db.query(CPU_NODES_SCHEMA_SQL);
    process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify({'r13-cpu':{hostResourceDomain:'r13-host',deviceIds:[],location:'unraid'}});
    const cpu={nodeId:'r13-cpu',host:'fixture',bootId:boot,bootStartedAt:'2026-01-01T00:00:00Z',maxConcurrency:2,
      contractVersion:1,features:['compute_cpu_only','compute_resources'],
      location:'unraid',hostResourceDomain:'r13-host',resources:{cpu:{},ram:{},gpus:[]},
      capabilities:[{id:'reverse.inspect',profileRef:{scope:'test',id:'cpu-profile',revision:'1',sha256:'c'.repeat(64)}}]};
    assert.equal((await send('POST','register',cpu,'cpu',true)).statusCode,503,'Gate aus');
    process.env.SYNAPSE_API_FEATURES='compute_resources,compute_cpu_only';
    assert.equal((await send('POST','register',cpu,'cpu',false)).statusCode,503,'A1 fehlt');
    const registered=await send('POST','register',cpu,'cpu',true);
    assert.equal(registered.statusCode,201,registered.body);
    const row=(await db.query('SELECT * FROM embedding_knoten WHERE node_id=$1',['r13-cpu'])).rows[0];
    for(const key of ['modell','modell_digest','ollama_url','native_dimension','ziel_dimension','num_ctx','vram_gesamt_mb','vram_frei_mb'])assert.equal(row[key],null,key);
    assert.equal(row.node_kind,'cpu');assert.equal(row.ressourcen.cpu.cores.value,null);
    assert.equal((await send('GET','r13-cpu/self',undefined,'cpu',false)).statusCode,404);
    assert.equal((await send('GET','r13-cpu/self',undefined,'cpu',true)).statusCode,200);
    assert.equal((await send('POST','r13-cpu/claims',{limit:1},'cpu',true)).statusCode,403,'Nie Embeddingclaim');
    assert.equal((await send('POST','r13-cpu/claims/complete',{},'cpu',true)).statusCode,403);
    const hb={contractVersion:1,features:cpu.features,status:'ready',activeJobs:0,bootId:boot,sequence:1,resources:cpu.resources};
    assert.equal((await send('POST','r13-cpu/heartbeat',hb,'cpu',true)).statusCode,200);
    assert.equal((await send('POST','r13-cpu/heartbeat',hb,'cpu',true)).statusCode,409);
    assert.equal((await send('POST','r13-cpu/heartbeat',{...hb,sequence:2,bootId:'22222222-2222-4222-8222-222222222222'},'cpu',true)).statusCode,409);
    assert.equal((await send('POST','register',{...cpu,model:'dummy'},'cpu',true)).statusCode,400);
    assert.equal((await send('POST','register',{...cpu,resources:{gpus:[{deviceId:'GPU-fake'}]}},'cpu',true)).statusCode,400);
    const oldList=await app.inject({method:'GET',url:'/api/embedding-nodes',headers:{authorization:'Bearer admin'}});
    assert.ok(oldList.json().nodes.every(n=>n.node_id!=='r13-cpu'));
    const modern=await app.inject({method:'GET',url:'/api/embedding-nodes',headers:{authorization:'Bearer admin','x-synapse-contract-version':'1'}});
    assert.ok(modern.json().nodes.some(n=>n.node_id==='r13-cpu'));
    await capture('reference','GET','reference');
    await capture('register','POST','register',gpu);
    await capture('self','GET','r13-gpu/self');
    await capture('heartbeat','POST','r13-gpu/heartbeat',{...fp,status:'ready',vramFreeMb:0,activeJobs:0,bootId:boot,sequence:1});
    await capture('claims','POST','r13-gpu/claims',{limit:1});
    await capture('complete','POST','r13-gpu/claims/complete',{});
    await capture('release','POST','r13-gpu/claims/release',{claims:[]});
    assert.equal(JSON.stringify(snap),JSON.stringify(expected),'Legacy-Golden mit CPU-Zeile bytegleich');
    console.log('R1.3 CPU/Gates/NULL/Heartbeatfences/Legacyfilter: grün');
  }
}finally{
  await app.close();await core.closePool();
  if(made)await db.query('DROP SCHEMA '+schema+' CASCADE');
  await db.end();
}
