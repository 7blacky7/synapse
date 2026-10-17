/** P22-T15 Tray-Stop: echte buildApi-Routen, ausschliesslich injizierte Transport-/Prozessattrappen. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../packages/file-watcher-daemon-ts/package.json',import.meta.url));
const ts=require('typescript'),Fastify=require('fastify');
const source=readFileSync(new URL('../packages/file-watcher-daemon-ts/src/api.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const project='p22-t15-tray-fake',id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const calls=[],signals=[],removed=[];
let mode='beide',missing=false;
const now=new Date(),legacy={agentName:'worker',project,lastActivity:now,status:'idle',wrapperPid:101};
const identity={...legacy,identityId:id,wrapperPid:202};
const status={specialists:{worker:{wrapperPid:303},['identity:'+id]:{wrapperPid:404}},maxSpecialists:5,lastUpdate:now.toISOString()};
const fail=()=>{throw Error('Ungeplanter Seiteneffekt im Tray-Test');};
const fakeProcess={env:{},kill:(pid,signal)=>signals.push({pid,signal})};
const context=vm.createContext({console,process:fakeProcess,Date,URL,Buffer,setTimeout,clearTimeout});
const synthetic=(values)=>new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});
const core=Object.fromEntries(['loeseAgentZiel','getPool','listChannels','getChannelMessages','postChannelMessage','listActiveAgents','listWrapperStatus','getWrapperStatus','removeWrapperStatus','resetProjectParse','reparseProject'].map(k=>[k,fail]));
const mods={
 fastify:{default:Fastify},
 '@synapse/core':core,
 '@synapse/agents':{readStatus:async()=>status,removeSpecialist:async(path,name)=>removed.push({path,name})},
 './skills-proxy.js':{registriereSkillsProxy:()=>{},istLoopback:()=>true},
 './daemon-jobs-api.js':{daemonJobsWeg:()=> 'api'},
 './daemon-sync-api.js':{trayApi:async(action,p,args={})=>{
  calls.push({action,project:p,args});assert.equal(p,project);
  if(action==='specialists')return {zeilen:mode==='alt'?[legacy]:[legacy,identity]};
  if(action==='specialist')return {zeile:args.identity_id?(mode==='alt'||missing?null:identity):legacy};
  if(action==='specialist_entfernen')return {success:true};
  return fail();
 }}
};
const module=new vm.SourceTextModule(js,{context,identifier:'p22-tray-api'});
await module.link(async name=>synthetic(mods[name]??await import(name)));
await module.evaluate();
const app=module.namespace.buildApi({manager:{status:p=>p===project?{pfad:'/tmp/fake-tray'}:null}});
let checks=0;const pass=s=>console.log('PASS '+(++checks)+' '+s);
const stop=target=>app.inject({method:'POST',url:'/projects/'+project+'/specialists/'+encodeURIComponent(target)+'/stop'});
try{
 for(mode of ['alt','beide','neu','alt','beide']){
  const listing=await app.inject({method:'GET',url:'/projects/'+project+'/specialists'});
  assert.equal(listing.statusCode,200,listing.body);
  const rows=listing.json().specialists;assert(rows.worker);
  assert.equal(!!rows['identity:'+id],mode!=='alt');
  const before=signals.length,cleanup=removed.length;
  const response=await stop('identity:'+id);
  if(mode==='alt'){assert.equal(response.statusCode,404);assert.equal(signals.length,before);}
  else{
   assert.equal(response.statusCode,200,response.body);
   assert.deepEqual(signals.at(-1),{pid:202,signal:'SIGTERM'});
   assert.equal(removed.length,cleanup,'ID darf status.json nicht per Name bereinigen');
   assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{action:'specialist_entfernen',project,args:{identity_id:id}});
  }
 }
 pass('Modusfolge: eindeutige lokale Listenkeys und ID-Stop mit exakter API-ID');
 missing=true;const before=signals.length;
 const denied=await stop('identity:'+id);
 assert.equal(denied.statusCode,404);assert.equal(signals.length,before,'Kein status.json-Fallback fuer ID');
 pass('Fehlende ID-Zeile benutzt weder Namens-PID noch gleichnamigen status.json-Key');
 missing=false;
 for(const target of ['worker','legacy:worker']){
  const response=await stop(target);assert.equal(response.statusCode,200,response.body);
  assert.deepEqual(signals.at(-1),{pid:101,signal:'SIGTERM'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{action:'specialist_entfernen',project,args:{agent:'worker'}});
  assert.equal(removed.at(-1).name,'worker');
 }
 pass('Beide Legacy-Adressformen behalten API-Ziel und Statusbereinigung');
 const unknown=await app.inject({method:'POST',url:'/projects/foreign/specialists/'+encodeURIComponent('identity:'+id)+'/stop'});
 assert.equal(unknown.statusCode,404);
 pass('Unbekanntes Projekt wird vor Transport und Prozessattrappe abgewiesen');
 console.log('P22-T15 Tray PASS '+checks+' Gruppen; keine echten Prozesse, Dateien oder Netzaufrufe');
}finally{await app.close();}
