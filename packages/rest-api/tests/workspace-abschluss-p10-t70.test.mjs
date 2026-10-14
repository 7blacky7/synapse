/** T70-NOGO-Regressionskontrollen: echter Kontrollfluss/Helper, DB-/Dockergrenze hier simuliert. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {WorkspaceOrchestrator} from '../dist/services/workspace-orchestrator.js';
import {schreibeWorkspaceQuellen} from '../dist/services/workspace-quellschutz.js';
import {mitLesePool} from '../../core/dist/db/client.js';
import {SHELL_SICHERUNG_SEED} from '../../core/dist/services/shell-sicherung-seed.js';
const text="import{unlink}from'node:fs/promises';await unlink('/workspace/control.txt');";
const file='/workspace/packages/core/tests/fence.test.mjs';
for(const mode of ['streamerror','watchdog','inspecterror'])test('Kein Restore ohne belegtes Prozessende: '+mode,async()=>{
 let restores=0;let running=true;const updates=[];const auditId='11111111-1111-4111-8111-111111111111';
 const userExec={id:'runner-1',start:async()=>{
  const s=new PassThrough();
  if(mode==='streamerror'||mode==='inspecterror')setImmediate(()=>s.destroy(Error('transport failed')));
  return s;
 },inspect:async()=>{if(mode==='inspecterror')throw Error('inspect unavailable');return{Running:running,ExitCode:running?null:0};}};
 const c={inspect:async()=>({Config:{Env:['PATH=/usr/bin:/bin','HOME=/tmp']}}),exec:async o=>o.User==='0'?{
  start:async()=>Readable.from([]),inspect:async()=>({Running:false,ExitCode:0})}:userExec};
 const w=new WorkspaceOrchestrator();w.dockerAvailable=true;w.ensureProjectRunning=async()=>'container-1';
 w.recordActivity=async()=>{};w.appendToLog=async()=>{};w.stelleWorkspaceQuellenWiederHer=async()=>{restores++;return['control.txt'];};
 w.lageProbeImContainer=async(_c,input)=>({cwd:'/workspace',os:'linux',env:{HOME:'/tmp',PWD:'/workspace'},
  pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),prozesse:{pids:[],namen:[]},
  ...(input.testdatei===file?{testdatei:{pfad:file,kanonisch:file,text,sha256:createHash('sha256').update(text).digest('hex')}}:{})});
 w.docker={getContainer:()=>c,getExec:()=>userExec,modem:{demuxStream:(s,out,err)=>{s.pipe(out);err.resume();}}};
 const query=async(sql,values)=>{updates.push({sql:String(sql),values});return{rows:String(sql).includes(' AS katalog')?[{katalog:SHELL_SICHERUNG_SEED}]:String(sql).includes('INSERT INTO shell_jobs')?[{id:auditId}]:[],rowCount:1};};
 await mitLesePool({query,connect:async()=>({query,release(){}})},async()=>{
  const r=await w.exec('p10_t70_fence_'+mode,'node packages/core/tests/fence.test.mjs',{agent_id:'sol-2',timeoutMs:1});
  assert.equal(restores,0,'Running/unklares inspect darf keine Wiederherstellung auslösen');
  assert.equal(r.status,'failed');assert.equal(r.quellen_pruefung_ausstehend,true);assert.equal(r.quellen_wiederhergestellt,undefined);
  assert.ok(updates.some(x=>(JSON.stringify(x.values)??'').includes('quellen_pruefung_ausstehend')),'offene Prüfung muss dauerhaft gespeichert werden');
 });
});
const quelle={file_path:'control.txt',content:'x'.repeat(131072)};
async function bounded(promise,ms=300){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_HANG')),ms);})]);}
 finally{clearTimeout(timer);}
}
test('Große Quelle + frühes Upload-Reject: geordnetes Reject ohne unhandled/hängenden Producer',async()=>{
 await assert.rejects(()=>bounded(schreibeWorkspaceQuellen({putArchive:async()=>{throw Error('early upload failure');}},[quelle])),/early upload failure/);
});
test('Kein Consumer: Archiv-Zeitlimit gibt den Aufrufer wieder frei',async()=>{
 await assert.rejects(()=>bounded(schreibeWorkspaceQuellen({putArchive:()=>new Promise(()=>{})},[quelle],30)),/workspace_quellen_archiv_timeout/);
});
test('Producerfehler bricht auch einen lesenden Consumer ab',async()=>{
 const c={putArchive:async stream=>{for await(const chunk of stream){void chunk;}}};
 await assert.rejects(()=>bounded(schreibeWorkspaceQuellen(c,[{file_path:'bad',content:undefined}])),/string|Buffer|undefined/i);
});
