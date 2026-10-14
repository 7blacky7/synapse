/** P18-T59/B1: Reverse-Knoten hat eine eigene Identität; Parser-Knoten (SYNAPSE_SERVER_*) bleibt byte-gleich. Ohne DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {createServerExecutorIdentity}=await import('../../core/dist/services/server-executor.js');
const {ServerExecutor,readServerHostProbe}=await import('../dist/services/server-executor.js');
const ex=await import('../dist/services/reverse-executor.js');
const SERVER={SYNAPSE_SERVER_NODE_ID:'unraid-embed',SYNAPSE_SERVER_EXECUTOR_OWNER:'api-a'};
const REVERSE={SYNAPSE_REVERSE_NODE_ID:'unraid-reverse',SYNAPSE_REVERSE_EXECUTOR_OWNER:'api-a',
 SYNAPSE_REVERSE_NODE_REGISTRATION:JSON.stringify({features:['embedding'],host:'unraid'})};
const mitEnv=async(werte,fn)=>{const alt={...process.env};Object.assign(process.env,werte);try{return await fn();}finally{for(const k of Object.keys(process.env))if(!(k in alt))delete process.env[k];Object.assign(process.env,alt);}};

test('Parser-Identität unabhängig von Reverse-Env',async()=>{
 for(const k of Object.keys(process.env))if(k.startsWith('SYNAPSE_SERVER_')||k.startsWith('SYNAPSE_REVERSE_'))delete process.env[k];
 const ohne=await mitEnv(SERVER,()=>({core:createServerExecutorIdentity(),exec:new ServerExecutor()}));
 const mit=await mitEnv({...SERVER,...REVERSE},()=>({core:createServerExecutorIdentity(),exec:new ServerExecutor()}));
 assert.deepEqual(mit.core,ohne.core,'Default-Präfix liest nur SYNAPSE_SERVER_*');
 assert.deepEqual(mit.exec.identity,ohne.exec.identity);
 assert.equal(mit.exec.identity.nodeId,'unraid-embed');
 assert.equal(mit.exec.cpuOnly,false);assert.equal(ohne.exec.cpuOnly,false);
 assert.deepEqual(createServerExecutorIdentity({...SERVER},'SYNAPSE_SERVER_'),createServerExecutorIdentity({...SERVER}),'expliziter Default gleich');
});

test('Reverse-Identität eigener Namensraum, eindeutiger claimOwner',async()=>{
 await mitEnv({...SERVER,...REVERSE},async()=>{
  const parser=new ServerExecutor(),reverse=new ServerExecutor({envPrefix:'SYNAPSE_REVERSE_',nurCpu:true,lokaleAdmission:false});
  assert.equal(reverse.identity.nodeId,'unraid-reverse');
  assert.notEqual(reverse.identity.claimOwner,parser.identity.claimOwner);
  assert.equal(reverse.identity.bootId,parser.identity.bootId,'gleiche Prozess-Bootgeneration, verschiedene Knoten');
  // nurCpu: Embedding-Registrierung wird vor jedem DB-Zugriff abgewiesen.
  await assert.rejects(()=>reverse.start(),/server_executor_cpu_only_required/);
  assert.equal(reverse.cpuOnly,false);assert.equal(parser.cpuOnly,false);
 });
 await mitEnv({...SERVER,SYNAPSE_REVERSE_NODE_ID:'unraid-reverse',SYNAPSE_REVERSE_EXECUTOR_OWNER:'api-a',SYNAPSE_SERVER_NODE_REGISTRATION:'{"features":["compute_cpu_only"]}'},async()=>{
  await assert.rejects(()=>new ServerExecutor({envPrefix:'SYNAPSE_REVERSE_',nurCpu:true}).start(),/server_executor_registration_missing/,'liest nicht SYNAPSE_SERVER_NODE_REGISTRATION');
 });
 await mitEnv({SYNAPSE_REVERSE_NODE_ID:'gleich',SYNAPSE_REVERSE_EXECUTOR_OWNER:'o',SYNAPSE_SERVER_NODE_ID:'gleich',SYNAPSE_SERVER_EXECUTOR_OWNER:'o'},async()=>{
  assert.equal(await ex.reverseServerIdentitaet()(),null,'gleiche node_id wie Parser -> keine Claims');
 });
 await mitEnv({},async()=>{assert.equal(await ex.reverseServerIdentitaet()(),null,'ohne SYNAPSE_REVERSE_NODE_ID keine Claims');});
});

test('Hostprobe je Namensraum',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'p18-t59-probe-'));
 try{
  const probe=join(dir,'probe.json');await writeFile(probe,JSON.stringify({gpus:[],cpu:{cores:{value:8,quality:'measured',freshness:'fresh',scope:'host'}}}));
  await mitEnv({SYNAPSE_COMPUTE_RESOURCE_BINDINGS:JSON.stringify({'unraid-reverse':{hostResourceDomain:'unraid',deviceIds:[]}}),SYNAPSE_REVERSE_HOST_PROBE_FILE:probe},async()=>{
   const viaDefault=await readServerHostProbe('unraid-reverse',true);
   const viaReverse=await readServerHostProbe('unraid-reverse',true,process.env.SYNAPSE_REVERSE_HOST_PROBE_FILE);
   assert.ok(viaDefault&&viaReverse,'beide Wege liefern normalisierte Ressourcen ohne Ausnahme');
   assert.deepEqual(viaDefault.gpus,[]);assert.deepEqual(viaReverse.gpus,[]);
  });
 }finally{await rm(dir,{recursive:true,force:true});}
});
