/** R4.1 echter Agentprozess mit Fake-nvidia/Ollama/API, nur eigene mkdtemp-Dateien. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const digest='a'.repeat(64),model='r41-fixture:latest',device='GPU-r41-e2e';
const reference={model,modelDigest:digest,nativeDimension:16,targetDimension:8,numCtx:512,quantization:'Q8_0',requiredTotalVramMb:1000,requiredFreeVramMb:500,queryPraefix:'q: ',dokPraefix:'d: ',maxStueckZeichen:1000};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const listen=async s=>{s.listen(0,'127.0.0.1');await once(s,'listening');return 'http://127.0.0.1:'+s.address().port;};
const json=(res,body)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));};
test('Agent: Drain aus Vorlaufantwort unterbricht Stapel/Abschluss nicht; B wird zurückgegeben, erst danach Unload-Ack',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sol2-r41-e2e-'));let child,stderr='',claims=0,completed=false,loaded=true,unloadCalls=0,embeds=0,register,drain=false;
 const releases=[],observations=[];let done;
 const acknowledged=new Promise(r=>{done=r;});let embedStarted;
 const started=new Promise(r=>{embedStarted=r;});
 const command=()=>({revision:1,bootId:register.bootId,action:'drain',capability:'embedding',deviceId:device,reason:'own fixture',deadline:new Date(Date.now()+60000).toISOString()});
 // Deadline bleibt stabil: dieselbe Revision darf ihre Bedeutung nicht ändern.
 let desired;
 const control=()=>({desired:drain?(desired??=command()):null,allowed:true,policyRevision:1,nodeUpdatedAt:'2026-01-01T00:00:00.000Z'});
 const ollama=createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const body=text?JSON.parse(text):{};
  if(req.url==='/api/tags')return json(res,{models:[{name:model,digest,details:{quantization_level:'Q8_0'}}]});
  if(req.url==='/api/show')return json(res,{model_info:{'fixture.embedding_length':16},details:{quantization_level:'Q8_0'}});
  if(req.url==='/api/ps')return json(res,{models:loaded?[{name:model,digest,size_vram:1048576}]:[]});
  if(req.url==='/api/embed'){
   embeds++;assert.equal(embeds,1,'vorausgeholter Stapel B darf nie rechnen');
   embedStarted();await delay(250);assert.equal(res.destroyed,false,'aktiver HTTP-Stapel wird nicht abgebrochen');
   return json(res,{embeddings:(Array.isArray(body.input)?body.input:[body.input]).map(()=>Array.from({length:16},(_,i)=>i+1))});
  }
  if(req.url==='/api/generate'){
   assert.equal(completed,true,'Unload muss auch den Ergebnisabschluss abwarten');unloadCalls++;loaded=false;
   assert.deepEqual(body,{model,keep_alive:0,stream:false});return json(res,{});
  }
  res.writeHead(404);res.end('{}');
 });
 const api=createServer(async(req,res)=>{
  let text='';for await(const p of req)text+=p;const body=text?JSON.parse(text):{};
  if(req.url==='/api/embedding-nodes/reference')return json(res,{success:true,reference});
  if(req.url==='/api/embedding-nodes/register'){register=body;return json(res,{success:true,claimBatch:4,control:control()});}
  if(req.url.endsWith('/admission'))return json(res,{success:true,enabled:false});
  if(req.url.endsWith('/claims')){
   claims++;assert.ok(claims<=2,'nach Drain keine neuen Claims');
   const id=claims===1?'A':'B';if(claims===2){await started;drain=true;}
   return json(res,{claims:[{chunkId:id,claimToken:id==='A'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222',content:id,contentHash:'b'.repeat(64)}],reference,control:control()});
  }
  if(req.url.endsWith('/claims/release')){releases.push(...body.claims.map(x=>x.chunkId));return json(res,{success:true,released:body.claims.map(x=>x.chunkId)});}
  if(req.url.endsWith('/claims/complete')){
   assert.deepEqual(body.items.map(x=>x.chunkId),['A']);await delay(150);completed=true;
   return json(res,{abgeschlossen:['A'],abgelehnt:[]});
  }
  if(req.url.endsWith('/heartbeat')){
   if(body.controlObservation){observations.push(body.controlObservation);if(body.controlObservation.ackRevision===1)done();}
   return json(res,{success:true,control:control()});
  }
  res.writeHead(404);res.end('{}');
 });
 try{
  const ollamaUrl=await listen(ollama),apiUrl=await listen(api);
  await writeFile(join(root,'nvidia-smi'),'#!/bin/sh\nprintf "Fixture GPU, 16000, 12000, '+device+', 15\\n"\n',{mode:0o700});
  const env={...process.env,PATH:root+':'+process.env.PATH,SYNAPSE_GPU_INDEX:'0',SYNAPSE_NODE_ID:'r41-e2e',SYNAPSE_API_URL:apiUrl,SYNAPSE_API_URL_RUECKFALL:'',SYNAPSE_API_TOKEN:'own-test-token',OLLAMA_URL:ollamaUrl,SYNAPSE_NODE_HEARTBEAT_MS:'50',SYNAPSE_NODE_RETRY_MS:'10',SYNAPSE_NODE_IDLE_MAX_MS:'20',SYNAPSE_COMPUTE_ADMISSION_ENABLED:'0',DATABASE_URL:'postgresql://127.0.0.1:1/forbidden',SYNAPSE_DATABASE_URL:'',SYNAPSE_NODE_STATUS_DATEI:''};
  for(const k of Object.keys(env))if(/^PG/.test(k))delete env[k];
  child=spawn(process.execPath,['packages/compute-node-agent/dist/index.js'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),env,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',x=>{stderr+=x;});
  let timer;try{await Promise.race([acknowledged,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Ack timeout: '+stderr.slice(-3000))),12000);})]);}finally{clearTimeout(timer);}
  assert.equal(claims,2);assert.equal(embeds,1);assert.equal(unloadCalls,1);assert.equal(completed,true);assert.deepEqual(releases,['B']);
  assert.ok(register.features.includes('compute_resources'));assert.ok(register.features.includes('compute_control'));assert.equal(register.resources.gpus[0].deviceId,device);
  assert.ok(observations.some(x=>x.state==='draining'&&x.ackRevision===undefined));
  const ack=observations.find(x=>x.ackRevision===1);assert.equal(ack.pendingClaims,0);assert.equal(ack.activeBatches,0);assert.equal(ack.modelPresent,false);
  console.log('R41_AGENT_DRAIN_VORLAUF_ABSCHLUSS_ACK_OK');
 }finally{
  if(child){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(1000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  for(const s of [api,ollama]){s.closeAllConnections();await new Promise(r=>s.close(r));}
  await rm(root,{recursive:true,force:true});
 }
});
