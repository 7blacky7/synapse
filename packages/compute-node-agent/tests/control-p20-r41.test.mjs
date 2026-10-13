/** W3 R4.1: echte Loopback-HTTP-Gegenstelle, keine GPU-/Live-DB-/Fremdmodell-Eingriffe. */
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import childProcess from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {ComputeNodeControl} from '../dist/control.js';
import {parseComputeControlCommand} from '../../core/dist/vertrag/compute-steuerung.js';
const digest='a'.repeat(64),device='GPU-r41-fixture',boot='r41-boot';
const command=(action='drain',revision=1,extra={})=>({revision,bootId:boot,action,deviceId:device,capability:'embedding',reason:'W3 test',deadline:new Date(Date.now()+60000).toISOString(),...extra});
const response=(desired,extra={})=>({desired,allowed:true,policyRevision:1,nodeUpdatedAt:new Date().toISOString(),...extra});
async function fixture(t,{models=[{name:'own:latest',digest}],unload=true,psStatus=200,hang=false}={}){
 const state={models,unload,psStatus,calls:[],device:true};
 const server=createServer(async(req,res)=>{
  state.calls.push(req.url);
  if(req.url==='/api/ps'){if(hang)return;res.writeHead(state.psStatus,{'content-type':'application/json'});res.end(JSON.stringify({models:state.models}));return;}
  if(req.url==='/api/generate'){
   let raw='';for await(const part of req)raw+=part;
   const body=JSON.parse(raw);assert.deepEqual(body,{model:'own',keep_alive:0,stream:false});
   if(state.unload)state.models=state.models.filter(m=>m.name!=='own:latest');
   res.end('{}');return;
  }
  res.writeHead(404);res.end();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const url='http://127.0.0.1:'+server.address().port;
 return {state,url,control:new ComputeNodeControl(boot,device,'own',digest,url,async()=>state.device,parseComputeControlCommand)};
}
test('Drain lässt aktiven Stapel und offene Claims auslaufen; erst positive Abwesenheit bestätigt',async t=>{
 const {control:c,state}=await fixture(t);
 assert.equal(c.begin(),true);c.receive(response(command()));
 assert.equal(c.begin(),false);assert.equal(c.canClaim(),false);
 await c.settle(0);assert.equal(c.report().state,'draining');assert.equal(c.report().ackRevision,undefined);assert.deepEqual(state.calls,[]);
 c.end();await c.settle(2);assert.equal(c.report().pendingClaims,2);assert.deepEqual(state.calls,[]);
 await c.settle(0);assert.equal(c.report().state,'unloaded');assert.equal(c.report().ackRevision,1);
 assert.deepEqual(state.calls,['/api/ps','/api/generate','/api/ps']);
});
for(const action of ['pause','drain','unload'])test(action+' sperrt neue Arbeit und meldet eigenen Modellabbau',async t=>{
 const {control:c}=await fixture(t);c.receive(response(command(action)));assert.equal(c.canClaim(),false);
 await c.settle(0);assert.equal(c.report().modelPresent,false);assert.equal(c.report().ackRevision,1);
});
for(const [name,options] of [
 ['Digest gehört fremdem Modell',{models:[{name:'own:latest',digest:'b'.repeat(64)}]}],
 ['Digest unbekannt',{models:[{name:'own:latest'}]}],
 ['HTTP-Gegenstelle fehlerhaft',{psStatus:503}],
 ['Echter HTTP-Abwesenheits-Timeout',{hang:true}],
 ['Modell nach Entladen weiter resident',{unload:false}],
])test(name+' bleibt pending ohne Ack',async t=>{
 const {control:c,state}=await fixture(t,options);c.receive(response(command()));await c.settle(0);
 assert.equal(c.report().state,'pending');assert.equal(c.report().ackRevision,undefined);
 if(name.startsWith('Digest'))assert.equal(state.calls.includes('/api/generate'),false);
});
test('Fremder Modellname wird nie entladen',async t=>{
 const foreign={name:'foreign:latest',digest:'b'.repeat(64)};
 const {control:c,state}=await fixture(t,{models:[foreign]});c.receive(response(command()));await c.settle(0);
 assert.deepEqual(state.models,[foreign]);assert.equal(state.calls.includes('/api/generate'),false);assert.equal(c.report().ackRevision,1);
});
test('Fehlende Gerätebindung und abgelaufene Deadline erzeugen keinen Ack',async t=>{
 const {control:c,state}=await fixture(t);state.device=false;c.receive(response(command()));await c.settle(0);
 assert.equal(c.report().state,'pending');assert.deepEqual(state.calls,[]);
 state.device=true;c.receive(response(command('unload',2,{deadline:new Date(Date.now()-1000).toISOString()})));
 await c.settle(0);assert.equal(c.report().ackRevision,undefined);
});
test('Resume hebt Usersperre nicht auf; alte Policyantwort kann neue Sperre nicht überschreiben',async t=>{
 const {control:c}=await fixture(t);const desired=command('resume');
 const newer='2030-01-01T00:00:02.000Z',older='2030-01-01T00:00:01.000Z';
 c.receive(response(desired,{allowed:false,policyRevision:4,nodeUpdatedAt:newer}));await c.settle(0);
 assert.equal(c.canClaim(),false);assert.equal(c.report().ackRevision,undefined);
 c.receive(response(desired,{allowed:true,policyRevision:3,nodeUpdatedAt:older}));assert.equal(c.canClaim(),false);
 c.receive(response(command('resume',2),{allowed:true,policyRevision:5,nodeUpdatedAt:'2030-01-01T00:00:03.000Z'}));
 await c.settle(0);assert.equal(c.report().state,'running');assert.equal(c.report().ackRevision,2);
});
test('Boot-/Geräte-/Revisionskonflikt ist fail closed',async t=>{
 for(const extra of [{bootId:'previous-boot'},{deviceId:'GPU-foreign'}]){
  const {control:c}=await fixture(t);assert.throws(()=>c.receive(response(command('resume',1,extra))),/target_mismatch/);assert.equal(c.canClaim(),false);
 }
 const {control:c}=await fixture(t);c.receive(response(command()));assert.throws(()=>c.receive(response(command('resume'))),/revision_conflict/);assert.equal(c.canClaim(),false);
});
test('Neustart/Legacy/fehlende Verhandlung behauptet keinen physischen Ack',async t=>{
 const {control:c,state}=await fixture(t);await c.settle(0);assert.equal(c.report(),undefined);assert.deepEqual(state.calls,[]);
 assert.throws(()=>new ComputeNodeControl(boot,device,'own',digest,'http://192.0.2.1:11434',async()=>true,parseComputeControlCommand),/not_local/);
});
test('GPU-Probe bindet exakt ausgewählten Index; ungültige Auswahl bleibt unbekannt',async t=>{
 const originalExec=childProcess.execFile;
 const saved={...process.env};t.after(()=>{childProcess.execFile=originalExec;syncBuiltinESMExports();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);mock.restoreAll();});
 const calls=[];
 const fake=()=>{throw Error('nur promisify-Variante erwartet');};
 fake[promisify.custom]=async(executable,args)=>{calls.push({executable,args});return{stdout:'Fixture GPU, 16000, 12000, '+device+', 42\n',stderr:''};};
 childProcess.execFile=fake;syncBuiltinESMExports();
 const {gpuInfo,probeResourceReport}=await import('../dist/probe.js?r41-probe-test');
 process.env.SYNAPSE_GPU_INDEX='2';const gpu=await gpuInfo();
 assert.equal(gpu.deviceId,device);assert.equal(gpu.freeMb,12000);assert.equal(gpu.utilization,42);assert.equal(calls.length,1);
 assert.equal(calls[0].executable,'nvidia-smi');assert.ok(calls[0].args.includes('--id=2'));
 process.env.SYNAPSE_GPU_INDEX='0,1';assert.equal((await gpuInfo()).deviceId,null);assert.equal(calls.length,1);
 const report=await probeResourceReport('own',gpu);
 assert.equal(report.gpus[0].freeMb.quality,'measured');assert.equal(report.gpus[0].freeMb.scope,'device');
 assert.equal(report.gpus[0].residentOwnModelMb.value,null,'fehlender Ollama-Zugang bleibt unknown statt 0');
});
