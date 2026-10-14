/** W3 T68: echter W3-Fastify-Server + eigene PG-Tabellen; nur die Executorgrenze ist simuliert.
 * P10-T71 (14.10.2026): ausser der Prod-DB-Sperre gibt es nur Warnhinweise. Frueher 'rejected/Anleitung'
 * heisst jetzt: laeuft MIT Hinweis (nicht still). */
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {mitLesePool} from '../../core/dist/db/client.js';
import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';
import {ermittleShellLage} from '../../core/dist/services/shell-lage.js';
import {pruefeShellStart} from '../../core/dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../../core/dist/services/shell-sicherung-seed.js';
import {WorkspaceOrchestrator,initWorkspaceOrchestrator,getWorkspaceOrchestrator,shutdownWorkspaceOrchestrator} from '../dist/services/workspace-orchestrator.js';
import {createServer} from '../dist/server.js';
const project='p10_t68_http_'+process.pid,schema=project;
const file='packages/core/tests/t68-http-fixture.mjs';
const writer="import{writeFile,rm}from'node:fs/promises';await writeFile('/tmp/owned/value','ok');await rm('/tmp/owned',{recursive:true});";
const frei=v=>v.darf_starten===true&&v.audit?.stufe==='laeuft'&&!v.hinweis;
const mitHinweis=r=>{assert.equal(r.status,'done',JSON.stringify(r));assert.match(JSON.stringify(r),/"(?:shell_)?hinweis"/,'Risiko muss als Hinweis sichtbar sein: '+JSON.stringify(r));};
test('T68 In-Process-Kandidat: echte MCP-Shellroute bis Guard/Rootschutz und Executorgrenze',async t=>{
 const uri=new URL(process.env.DATABASE_URL??'');assert.equal(uri.pathname,'/synapse_test');assert.equal(uri.port,'5433');
 const client=await oeffneGeschuetzteShellTestDb(),saved={...process.env};let created=false,app;
 const sources=new Map([[file,writer],['packages/core/src/t68-product.mjs',writer],['scripts/test-t68.mjs',writer]]);
 let canonicalOutside=false,rootFailure=false,userExecutions=0,localWorkerCalls=0,simulateLocal=false,userRunning=false,localVerdict;
 const rootCommands=[];
 const q=client.query.bind(client);
 const probeFor=(root,input)=>({cwd:root,os:'linux',env:{HOME:'/home/fixture',PWD:root},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),prozesse:{pids:[],namen:[]},
  ...(input.testdatei&&sources.has(input.testdatei.slice(root.length+1))?{testdatei:{pfad:input.testdatei,kanonisch:canonicalOutside?'/outside/file.mjs':input.testdatei,text:sources.get(input.testdatei.slice(root.length+1)),sha256:createHash('sha256').update(sources.get(input.testdatei.slice(root.length+1))).digest('hex')}}:{})});
 // Simulierter lokaler Worker wertet die echte native Guardpipeline aus, führt den Quelltext nie aus.
 const pool={connect:async()=>({query:q,release(){},on(){},once(){}}),async query(sql,values){
  const r=await q(sql,values);
  if(simulateLocal&&/INSERT INTO shell_jobs/i.test(sql)&&values?.includes('node '+file)&&r.rows[0]?.id){
   localWorkerCalls++;
   const command='node '+file,root=process.cwd();
   const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',env:{},env_vollstaendig:true,probe:async input=>probeFor(root,input)});
   const verdict=pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
   assert.equal(frei(verdict),false,'lokaler Worker bekommt keine private Workspace-Ausnahme (Hinweis statt still)');
   localVerdict=verdict;
   await q("UPDATE shell_jobs SET status='rejected',error='shell_anleitung',sicherung=$2::jsonb WHERE id=$1",[r.rows[0].id,JSON.stringify({antwort:verdict.antwort??{stufe:'hinweis',...verdict.hinweis}})]);
  }
  return r;
 }};
 try{
  assert.equal((await client.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  await q('CREATE SCHEMA '+schema);created=true;
  // Nur Definitionen kopieren, nie Daten. Alle Tabellen verhindern Public-Fallbacks durch Handler.
  const tables=(await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const {tablename}of tables){assert.match(tablename,/^[a-zA-Z0-9_]+$/);await q('CREATE TABLE '+schema+'."'+tablename+'" (LIKE public."'+tablename+'" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');}
  await q('CREATE SEQUENCE '+schema+'.fixture_seq START 1000000');
  const serial=(await q("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",['public'])).rows;
  for(const {table_name,column_name}of serial)await q('ALTER TABLE '+schema+'."'+table_name+'" ALTER COLUMN "'+column_name+'" SET DEFAULT nextval(\''+schema+'.fixture_seq\')');
  await q('SET search_path TO '+schema+',public');
  await q('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[project,process.cwd(),'t68-fixture']);
  process.env.SYNAPSE_AUTH_DISABLED='1';process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.PARSER_LOOP_DISABLED='1';
  await mitLesePool(pool,async()=>{
   mock.method(WorkspaceOrchestrator.prototype,'init',async function(){this.dockerAvailable=true;return true;});
   await initWorkspaceOrchestrator();const w=getWorkspaceOrchestrator();
   w.ensureProjectRunning=async()=> 't68-simulated-container';w.recordActivity=async()=>{};w.appendToLog=async()=>{};
   w.lageProbeImContainer=async(_container,input)=>probeFor('/workspace',input);
   const container={
    inspect:async()=>({Config:{Env:['PATH=/usr/bin:/bin','HOME=/home/fixture']}}),
    exec:async opts=>{
     if(opts.User==='0'){
      rootCommands.push(opts);
      if(rootFailure)throw Error('t68_root_protection_failed');
      return{start:async()=>Readable.from([]),inspect:async()=>({Running:false,ExitCode:0})};
     }
     userExecutions++;return{id:'t70-http-exec',start:async()=>Readable.from([Buffer.from('T68_EXECUTOR_STUB_OK')]),inspect:async()=>({Running:userRunning,ExitCode:userRunning?null:0})};
    }
   };
   w.docker={getContainer:()=>container,getExec:()=>({inspect:async()=>({Running:userRunning,ExitCode:userRunning?null:0})}),modem:{demuxStream:(s,out,err)=>{s.pipe(out);err.end();}}};
   app=await createServer();await app.ready();let id=0,session;
   const rpc=async(payload)=>{
    const headers={'content-type':'application/json',accept:'application/json, text/event-stream',...(session?{'mcp-session-id':session}:{})};
    const r=await app.inject({method:'POST',url:'/mcp/messages',headers,payload});
    assert.equal(r.statusCode,200,r.body);if(r.headers['mcp-session-id'])session=r.headers['mcp-session-id'];
    return String(r.headers['content-type']).includes('text/event-stream')?JSON.parse(r.body.split('\n').filter(x=>x.startsWith('data:')).at(-1).slice(5)):r.json();
   };
   await rpc({jsonrpc:'2.0',id:++id,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'t68-fixture',version:'1'}}});
   const call=async(command,extra={})=>{
    const r=await rpc({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'shell',arguments:{action:'exec',project,agent_id:'sol-2',command,isolated:true,...extra}}});
    assert.equal(r.error,undefined,JSON.stringify(r));
    const result=r.result.structuredContent??JSON.parse(r.result.content[0].text);return result;
   };
   await t.test('isolated:true erreicht ohne Bestätigung private Ausnahme und Executor',async()=>{
    const before=userExecutions,r=await call('node '+file);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.executed_via,'workspace');assert.equal(userExecutions,before+1);
    assert.ok(rootCommands.length>0);for(const opts of rootCommands){assert.equal(opts.User,'0');assert.ok(opts.Cmd[2].includes('/bin/stat -c %u:%g:%a /workspace'));}
   });
   await t.test('Wiederherstellungsliste erreicht echte MCP-Antwort; Restorefehler bleibt Fehler',async()=>{
    const saved=w.stelleWorkspaceQuellenWiederHer;
    try{
     w.stelleWorkspaceQuellenWiederHer=async()=>['control.txt'];
     const r=await call('node '+file);assert.equal(r.success,true);assert.deepEqual(r.quellen_wiederhergestellt,['control.txt']);
     const row=(await q('SELECT sicherung FROM shell_jobs WHERE id=$1',[r.id])).rows[0];
     assert.deepEqual(row.sicherung.quellen_wiederhergestellt,['control.txt']);
     w.stelleWorkspaceQuellenWiederHer=async()=>{throw Error('t70_restore_failed');};
     const failed=await call('node '+file);assert.equal(failed.success,false);assert.match(failed.message,/t70_restore_failed/);
    }finally{w.stelleWorkspaceQuellenWiederHer=saved;}
   });
   await t.test('Unklares Ende meldet failed+ausstehend, späterer Exec holt die Prüfung nach',async()=>{
    const saved=w.stelleWorkspaceQuellenWiederHer;let restored=0;
    try{
     w.stelleWorkspaceQuellenWiederHer=async()=>{restored++;return[];};userRunning=true;
     const r=await call('node '+file);assert.equal(r.success,false);assert.equal(r.status,'failed');
     assert.equal(r.quellen_pruefung_ausstehend,true);assert.equal(r.quellen_wiederhergestellt,undefined);assert.equal(restored,0);
     userRunning=false;const next=await call('node '+file);assert.equal(next.success,true);
     assert.ok(restored>=1);
     const original=(await q('SELECT sicherung FROM shell_jobs WHERE id=$1',[r.id])).rows[0];
     assert.equal(original.sicherung.quellen_pruefung_ausstehend,undefined);assert.equal(original.sicherung.quellen_pruefung_nachgeholt,true);
    }finally{userRunning=false;w.stelleWorkspaceQuellenWiederHer=saved;}
   });
   await t.test('scripts/test-* hat dieselbe native Ausnahme',async()=>assert.equal((await call('node scripts/test-t68.mjs')).success,true));
   await t.test('Produktdatei und unbekannter kanonischer Pfad laufen nur mit Hinweis',async()=>{
    const before=userExecutions;mitHinweis(await call('node packages/core/src/t68-product.mjs'));
    canonicalOutside=true;try{mitHinweis(await call('node '+file));}finally{canonicalOutside=false;}
    assert.equal(userExecutions,before+2);
   });
   // P10-T78 (Auflage 61ca8b09): das pg.Client-Tupel live.invalid/synapse ist NICHT die Prod-DB dieses Testservers
   // (live = dessen DATABASE_URL auf synapse_test) und bleibt deshalb Hinweis. Ein Tupel auf die echte Prod-DB ist
   // auch aus einer Workspace-Datei gesperrt: core/tests/shell-test-temp-p10-t65 'Workspace-Testdatei ... (P10-T78)'.
   await t.test('DB- und Prozessrisiken bleiben trotz Workspace-Datei als Hinweis sichtbar',async()=>{
    const before=userExecutions;
    for(const source of ["import pg from'pg';new pg.Client({host:'live.invalid',database:'synapse'}).query('DROP TABLE foreign');","import{exec}from'node:child_process';exec(process.env.UNKNOWN);"]){
     sources.set(file,source);mitHinweis(await call('node '+file));
    }
    sources.set(file,writer);assert.equal(userExecutions,before+2);
   });
   await t.test('Rootschutzfehler stoppt vor Lageprobe/Nutzerexec',async()=>{
    const before=userExecutions;rootFailure=true;
    try{const r=await call('node '+file);assert.equal(r.success,false);assert.match(r.message,/root_protection_failed/);}finally{rootFailure=false;}
    assert.equal(userExecutions,before);
   });
   await t.test('Explizit lokal und gefälschtes Clientflag gewähren keine Ausnahme',async()=>{
    const spoof=await call('node '+file,{isolated:false,target:'local',workspace_testdateien:true});
    assert.equal(spoof.error,'unbekannter_parameter');assert.deepEqual(spoof.unbekannte_parameter,['workspace_testdateien']);
    const before=userExecutions;simulateLocal=true;
    let r;try{r=await call('node '+file,{isolated:false,target:'local'});}finally{simulateLocal=false;}
    // P10-T71: der simulierte lokale Worker sieht einen Hinweis (keine stille Workspace-Ausnahme).
    assert.equal(r.executed_via,'local',JSON.stringify(r));assert.equal(localWorkerCalls,1);assert.equal(userExecutions,before);
    assert.equal(localVerdict.darf_starten,true);assert.equal(localVerdict.hinweis?.stufe,'hinweis');
   });
  });
 }finally{
  if(app)await app.close();shutdownWorkspaceOrchestrator();mock.restoreAll();
  // MCP protokolliert best-effort nach der Antwort; vor dem eigenen Schema-Teardown auslaufen lassen.
  await new Promise(resolve=>setTimeout(resolve,100));
  if(created)await q('DROP SCHEMA '+schema+' CASCADE');
  await client.end();for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 }
});
