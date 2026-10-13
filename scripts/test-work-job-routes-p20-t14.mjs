#!/usr/bin/env node
// P20-T14: neue Claim-Familie, Auth/Feature-/Inputgrenzen; kein Live-Backend.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../packages/rest-api/package.json',import.meta.url));
const Fastify=req('fastify');
const {registerWorkJobRoutes}=await import('../packages/rest-api/dist/routes/work-jobs.js');
const {createEmbeddingNodeRoutes}=await import('../packages/rest-api/dist/routes/embedding-nodes.js');
const calls=[];
const boot='11111111-1111-4111-8111-111111111111';
const jobId='22222222-2222-4222-8222-222222222222';
const claimToken='33333333-3333-4333-8333-333333333333';
const ref={scope:'reverse',id:'synthetic',revision:'1',sha256:'a'.repeat(64)};
const service={
  ready:()=>true,
  enqueue:async input=>{calls.push(['enqueue',input]);return {id:jobId,project:'p20_r21',claimToken:null};},
  get:async()=>({id:jobId,project:'p20_r21',claimToken}),
  claim:async(who)=>{calls.push(['claim',who]);return [{id:jobId,claimToken}];},
  renew:async(...args)=>{calls.push(['renew',...args]);return true;},
  stage:async(...args)=>{calls.push(['stage',...args]);return true;},
  complete:async(...args)=>{calls.push(['complete',...args]);return {completed:true};},
  release:async(...args)=>{calls.push(['release',...args]);return true;},
};
const tokens={
  session:{kind:'session',scope:'mcp:tools',token_hash:'session-hash'},
  node:{kind:'service',scope:'compute-node:node-a',token_hash:'node-a-hash'},
  foreign:{kind:'service',scope:'compute-node:node-b',token_hash:'node-b-hash'},
  daemon:{kind:'service',scope:'daemon',token_hash:'daemon-hash'},
};
const app=Fastify();
await registerWorkJobRoutes(app,{validateToken:async token=>tokens[token]??null,service});
const headers=token=>({authorization:'Bearer '+token,'x-synapse-contract-version':'1'});
const invoke=(method,url,token,payload)=>app.inject({method,url,headers:headers(token),payload});
try {
  const create={kind:'reverse-inspect',capability:'reverse.inspect',project:'p20_r21',scope:'reverse',
    inputRef:ref,resourceNeed:{cpu:1,ram:128,vram:0,gpu:false},idempotencyKey:'route-create'};
  delete process.env.SYNAPSE_WORK_JOBS_ENABLED;
  assert.equal((await invoke('POST','/api/embedding-nodes/work/jobs','session',create)).statusCode,503);
  process.env.SYNAPSE_WORK_JOBS_ENABLED='1';
  process.env.SYNAPSE_API_FEATURES='compute_resources';
  assert.equal((await invoke('POST','/api/embedding-nodes/work/jobs','node',create)).statusCode,403);
  assert.equal((await invoke('POST','/api/embedding-nodes/work/jobs','session',create)).statusCode,201);
  assert.equal((await invoke('POST','/api/embedding-nodes/node-a/work/claims','foreign',{bootGeneration:boot})).statusCode,403);
  assert.equal((await invoke('POST','/api/embedding-nodes/node-a/work/claims','daemon',{bootGeneration:boot})).statusCode,403);
  assert.equal((await invoke('POST','/api/embedding-nodes/node-a/work/claims','node',{bootGeneration:boot,authHash:'forged'})).statusCode,200);
  assert.equal(calls.find(c=>c[0]==='claim')[1].authHash,'node-a-hash');
  const noHeader=await app.inject({method:'POST',url:'/api/embedding-nodes/node-a/work/claims',
    headers:{authorization:'Bearer node'},payload:{bootGeneration:boot}});
  assert.equal(noHeader.statusCode,503);
  for(const action of ['renew','stage','complete','release']) {
    const body={bootGeneration:boot,claimToken,inputRef:ref,outputRef:ref};
    const r=await invoke('POST','/api/embedding-nodes/node-a/work/jobs/'+jobId+'/'+action,'node',body);
    assert.equal(r.statusCode,200,r.body);
  }
  const bad=await invoke('POST','/api/embedding-nodes/node-a/work/jobs/'+jobId+'/stage','node',
    {bootGeneration:boot,claimToken,outputRef:{...ref,id:'/etc/passwd'}});
  assert.equal(bad.statusCode,400);
  const viewed=await invoke('GET','/api/embedding-nodes/work/jobs/'+jobId+'?project=p20_r21','session');
  assert.equal(viewed.statusCode,200);
  assert.equal('claimToken' in viewed.json().job,false);
  const mounted=Fastify();
  await mounted.register(createEmbeddingNodeRoutes({validateToken:async token=>tokens[token]??null,
    db:{query:async()=>({rows:[]})},workJobs:service}));
  const hooked=await mounted.inject({method:'POST',url:'/api/embedding-nodes/node-a/work/claims',
    headers:headers('node'),payload:{bootGeneration:boot}});
  assert.equal(hooked.statusCode,200,hooked.body);
  await mounted.close();
  delete process.env.SYNAPSE_WORK_JOBS_ENABLED;
  delete process.env.DATABASE_URL;
  process.env.SYNAPSE_WORK_LEASE_SECONDS='invalid-disabled-feature-config';
  const legacyOnly=Fastify();
  await legacyOnly.register(createEmbeddingNodeRoutes({validateToken:async token=>tokens[token]??null,
    db:{query:async()=>({rows:[]})}}));
  const disabled=await legacyOnly.inject({method:'POST',url:'/api/embedding-nodes/node-a/work/claims',
    headers:headers('node'),payload:{bootGeneration:boot}});
  assert.equal(disabled.statusCode,503,disabled.body);
  await legacyOnly.close();
  console.log('R2.1 HTTP Auth/Verhandlung/Inputref/Lease-Aktionen: grün');
} finally {await app.close();}
