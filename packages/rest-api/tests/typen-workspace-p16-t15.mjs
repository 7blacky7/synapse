/** P16-T15: echter Workspace-Adapter/Bootstrap/TS-Worker, Docker-Transport als Testdouble. */
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import {Duplex,PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {Worker} from 'node:worker_threads';
import * as url from 'node:url';
import {WorkspaceOrchestrator,initWorkspaceOrchestrator,shutdownWorkspaceOrchestrator} from '../dist/services/workspace-orchestrator.js';
import {installTypWorkspacePruefer} from '../dist/services/typen-pruefung-workspace.js';
const require=createRequire(import.meta.url);
export async function pruefeWorkspaceTransport({project,pool,typen,root,datei,basis,ergebnis,check}){
 const originalInit=WorkspaceOrchestrator.prototype.init,originalEnsure=WorkspaceOrchestrator.prototype.ensureProjectRunning;
 const originalContainer=Docker.prototype.getContainer,modemProto=Object.getPrototypeOf(new Docker().modem),originalDemux=modemProto.demuxStream;
 let mode='normal',lastWire,lastOptions,lastPayload,lastProject,workers=[];
 WorkspaceOrchestrator.prototype.init=async()=>true;
 WorkspaceOrchestrator.prototype.ensureProjectRunning=async function(name){lastProject=name;return 'p16-test-container';};
 modemProto.demuxStream=function(stream,out){stream.on('data',b=>out.write(b));};
 Docker.prototype.getContainer=function(id){
  assert.equal(id,'p16-test-container');
  return {exec:async options=>{
   lastOptions=options;
   return {start:async()=>{
    const stdin=new PassThrough();
    const wire=new Duplex({read(){},write(chunk,encoding,done){
     lastPayload=JSON.parse(chunk.toString('utf8'));
     const split=chunk.findIndex(b=>b>=128);
     try{if(split>=0){stdin.write(chunk.subarray(0,split+1));stdin.write(chunk.subarray(split+1));}else stdin.write(chunk);}
     catch(err){if(err.message!=='simulierter Prozessabbruch')throw err;}
     done();
    }});
    lastWire=wire;
    if(mode==='stalled')return wire;
    class TrackedWorker extends Worker {constructor(...args){super(...args);workers.push(this);}}
    const fakeRequire=name=>{
     if(name==='node:worker_threads')return {Worker:TrackedWorker};
     if(name==='node:module')return {createRequire:()=>({resolve:()=>{if(mode==='missing')throw Error('kein Compiler');return require.resolve('typescript');}})};
     if(name==='node:url')return url;
     throw Error('unerwartetes Bootstrap-Modul '+name);
    };
    fakeRequire.resolve=()=>{throw Error('kein globaler Compiler');};
    runInNewContext(options.Cmd[2],{require:fakeRequire,Buffer,URL,setTimeout,clearTimeout,
     process:{stdin,stdout:{write(data,callback){wire.push(Buffer.from(data));callback?.();}},exit(){wire.push(null);if(mode==='missing')throw Error('simulierter Prozessabbruch');}}});
    return wire;
   }};
  }};
 };
 try{
  await initWorkspaceOrchestrator();installTypWorkspacePruefer();
  await pool.query('UPDATE projects SET path=$2 WHERE name=$1',[project,'/virtual/test-sol10-workspace']);
  const input={file_path:datei,basis,ergebnis,ops:[{op_index:0,agent_id:'sol-10-test',spannen:[[0,ergebnis.split('\n').length]]}]};
  const result=await typen.pruefePlanTypen(project,[input]);
  check('Workspace-Adapter mit echtem Bootstrap/TS-Worker',()=>{assert.equal(result.status,'fertig',JSON.stringify(result));assert(result.befunde.some(b=>b.code==='TS2322'&&b.datei===datei&&b.op_index===0),JSON.stringify(result));});
  check('Workspace-Payload PG+Overlay und sichere Dockeroptionen',()=>{
   assert.equal(lastProject,project);assert.equal(lastPayload.auftrag.project,project);
   assert.equal(lastPayload.auftrag.dateien[0].ergebnis,ergebnis);
   assert(lastPayload.engine.includes('pruefeTypAuftrag'));assert(lastPayload.diff.includes('aenderungsBereiche'));
   assert.equal(lastOptions.WorkingDir,'/workspace');assert.equal(lastOptions.User,'synapse');
   assert.deepEqual(lastOptions.Env,['DATABASE_URL=','SYNAPSE_DATABASE_URL=']);
   assert.equal(lastOptions.Cmd[0],'node');assert.equal(lastOptions.Cmd[1],'-e');
   assert(lastWire.destroyed);
  });
  mode='missing';
  const missing=await typen.pruefePlanTypen(project,[input]);
  check('Workspace ohne TypeScript meldet Abdeckungslücke',()=>{assert.equal(missing.status,'nicht_verfuegbar');assert(missing.fehlende_module.includes('typescript'));assert.equal(missing.befunde.filter(b=>b.severity==='error').length,0);});
  mode='stalled';process.env.FEHLERPRUEFUNG_TYPEN_MS='100';
  const start=performance.now(),limit=await typen.pruefePlanTypen(project,[input]);
  check('Workspace-Transport harter Zeitdeckel+Streamabbruch',()=>{assert.equal(limit.status,'zeitlimit',JSON.stringify(limit));assert.equal(limit.befunde.filter(b=>b.severity==='error').length,0);assert(lastWire.destroyed);assert(performance.now()-start<2500);});
 }finally{
  process.env.FEHLERPRUEFUNG_TYPEN_MS='20000';
  await pool.query('UPDATE projects SET path=$2 WHERE name=$1',[project,root]);
  await Promise.all(workers.map(w=>w.terminate()));
  shutdownWorkspaceOrchestrator();
  WorkspaceOrchestrator.prototype.init=originalInit;WorkspaceOrchestrator.prototype.ensureProjectRunning=originalEnsure;
  Docker.prototype.getContainer=originalContainer;modemProto.demuxStream=originalDemux;
 }
}
