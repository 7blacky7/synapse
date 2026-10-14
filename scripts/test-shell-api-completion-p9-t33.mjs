#!/usr/bin/env node
/** P9-T33: unit/rot/golden ohne DB; integration nur synapse_test.
 * Eigene HTTP-Test-API, eigenes Temp-HOME/Projekt, keine echten Daemons/Tray/Registry.
 * SOL14_MODULE_ROOT=<Basis-Worktree> testet dieselben fachlichen Assertions am Basisstand.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pruefeTestDbUrl} from './lib/test-db-schutz.mjs';

const mode=process.argv[2]??'unit';
assert.ok(['unit','rot','golden','integration'].includes(mode));
const moduleRoot=process.env.SOL14_MODULE_ROOT??fileURLToPath(new URL('../',import.meta.url));
const imp=p=>import(pathToFileURL(path.join(moduleRoot,p)).href);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'sol14-p9-t33-'));
const projectRoot=path.join(root,'projekt'),project='sol14-t33-'+randomUUID();
fs.mkdirSync(projectRoot);
const originalHome=os.homedir,oldHome=process.env.HOME,oldFetch=globalThis.fetch;
os.homedir=()=>root;process.env.HOME=root;syncBuiltinESMExports();
const cfgDir=path.join(root,'.synapse','file-watcher');fs.mkdirSync(cfgDir,{recursive:true});
const logs=[],originalError=console.error;console.error=(...x)=>{logs.push(x.map(String).join(' '));originalError(...x);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const streams=path.join(root,'.synapse','shell-streams');
let app,pool,admin,schema,worker;
const children=[],pendingRuns=[];
const check=async(name,fn)=>{await fn();console.log('PASS '+name);};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const js=s=>process.execPath+' -e '+quote(s);
const emptyDb={project,ziele:[],live:null,server_metadaten:[]};
const kontext={project,project_root:projectRoot,projekt_db:null,datenbank_freigabe:emptyDb,
 katalog:{regeln:[],antworten:[],risiko_verben:[]},sicherung:async()=>undefined};
const response=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const results=new Map(),jobRows=new Map();
let apiMode='ok',apiAttempts=0,queued=null,slowContextRelease;
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://test');
  if(u.pathname.endsWith('/status'))return response(res,{enabled:true});
  if(req.headers.authorization!=='Bearer fixture')return response(res,{error:'unauthorized'},401);
  let raw='';for await(const chunk of req)raw+=chunk;
  const b=raw?JSON.parse(raw):{};
  if(u.pathname==='/api/daemon/shell/abschluss'){
   apiAttempts++;
   if(apiMode==='transient'&&apiAttempts<3)return response(res,{error:'temporary'},503);
   if(apiMode==='413'&&apiAttempts===1)return response(res,{error:'too_large'},413);
   if(apiMode==='always413')return response(res,{error:'too_large'},413);
   if(apiMode==='down')return response(res,{error:'temporary'},503);
   results.set(b.id,b.abschluss);return response(res,{success:true});
  }
  if(u.pathname==='/api/daemon/shell/kontext'){
   if(apiMode==='hold-context')await new Promise(r=>{slowContextRelease=r;});
   return response(res,{kontext});
  }
  if(u.pathname==='/api/daemon/shell/sicherung')return response(res,{success:true});
  if(u.pathname==='/api/daemon/shell/wartung')return response(res,b.aktion==='eigene_laufende'?{jobs:[...jobRows.values()]}:{anzahl:0});
  if(u.pathname==='/api/daemon/shell/jobs'){
   const jobs=queued?[queued]:[];queued=null;
   if(!jobs.length&&Number(u.searchParams.get('warte'))>0)await sleep(100);
   return response(res,{jobs,abbrueche:[]});
  }
  return response(res,{success:true});
 }catch(e){response(res,{error:'fixture_error'},500);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
fs.writeFileSync(path.join(cfgDir,'config.json'),JSON.stringify({synapse_api_url:url,synapse_api_token:'fixture',projekte:[],daemon_jobs_weg:'api'}));
process.env.SYNAPSE_DAEMON_JOBS_WEG='api';
globalThis.fetch=(input,init)=>String(input).includes('/projects/'+project+'/status')?Promise.resolve(new Response('{"enabled":true}',{status:200})):oldFetch(input,init);
const timeout=async(p,ms,reason)=>{let timer;try{return await Promise.race([p,new Promise((_,rej)=>{timer=setTimeout(()=>rej(Error(reason)),ms);})]);}finally{clearTimeout(timer);}};
try{
 const {execShellInProject}=await imp('packages/core/dist/services/shell-exec.js');
 const api=await imp('packages/file-watcher-daemon-ts/dist/daemon-jobs-api.js');
 const {ShellAbschlussWiederholung}=await imp('packages/file-watcher-daemon-ts/dist/shell-job-completion.js');
 const run=(command,extra={})=>{const p=execShellInProject({project,command,kontext,queued_stream_id:randomUUID().replaceAll('-','').slice(0,16),sicherungs_job_id:randomUUID(),...extra});pendingRuns.push(p);return p;};
 const golden=async()=>{
  const out={};
  for(const [name,c]of [['success',"printf 'one\\ntwo\\n'"],['failure',"printf 'bad\\n'; exit 3"]]){
   const r=await run(c);
   out[name]={status:r.status,exit_code:r.exit_code,tail:r.tail,detached:r.detached,output:fs.readFileSync(path.join(streams,r.stream_id+'.log'),'utf8'),output_truncated:r.output_truncated===true};
  }
  return out;
 };
 if(mode==='golden'){console.log(JSON.stringify(await golden(),null,2));}
 else if(mode==='unit'||mode==='rot'){
  // Inhaltliche Rotkontrolle: wirklich beendete Shell, weiter offener Output-FD.
  // Hintergrundprozess schreibt nach Detach einen Burst und haelt die Pipe danach.
  await check('beendeter Prozess mit geerbter Pipe schliesst nach begrenztem Drain',async()=>{
   const childScript="process.stdout.write('BURST-'+ 'x'.repeat(8192)+'\\n');process.stderr.write('ERR-BURST\\n');setTimeout(()=>{},10000)";
   const command="sleep 0.15; "+js(childScript)+" & echo ROOT-EXIT";
   const started=Date.now();
   const r=await timeout(run(command,{detach_after_ms:50,onStarted:ctl=>children.push(ctl.pid)}),3500,'ROT: Prozess beendet, Abschluss wartet weiter auf geerbte Ausgabepipe');
   assert.equal(r.status,'done');assert.equal(r.exit_code,0);assert.equal(r.detached,true);
   assert.equal(r.output_truncated,true);
   assert.ok(Date.now()-started<3500);
   const text=fs.readFileSync(path.join(streams,r.stream_id+'.log'),'utf8');
   assert.match(text,/ROOT-EXIT/);assert.match(text,/BURST-x{8192}/);
   const meta=JSON.parse(fs.readFileSync(path.join(streams,r.stream_id+'.meta.json'),'utf8'));
   assert.equal(meta.status,'done');assert.equal(meta.exit_code,0);assert.equal(meta.output_truncated,true);
  });
  if(mode==='unit'){
   await check('nach Hintergrunduebergang schneller Mehr-KB-Output bleibt vollstaendig',async()=>{
    const r=await run("sleep 0.15; "+js("process.stdout.write('x'.repeat(32768)+'\\n');process.stderr.write('y'.repeat(8192)+'\\n')"),{detach_after_ms:50});
    assert.equal(r.status,'done');assert.equal(r.exit_code,0);assert.equal(r.detached,true);
    assert.notEqual(r.output_truncated,true);
    const text=fs.readFileSync(path.join(streams,r.stream_id+'.log'),'utf8');
    assert.match(text,/x{32768}\n/);assert.match(text,/y{8192}\n/);
   });
   await check('Logfehler verliert terminalen Status nicht und wird protokolliert',async()=>{
    const write=fs.writeSync;fs.writeSync=()=>{throw Object.assign(Error('fixture'),{code:'EIO'});};syncBuiltinESMExports();
    let r;try{r=await timeout(run("printf 'lost\\n'"),3000,'Ausgabe-Fehler verlor Abschluss');}finally{fs.writeSync=write;syncBuiltinESMExports();}
    assert.equal(r.status,'done');assert.equal(r.exit_code,0);assert.equal(r.output_truncated,true);
    assert.ok(logs.some(x=>x.includes('Ausgabe/Metadaten fehlgeschlagen:')&&x.includes('EIO')));
   });
   await check('Meta-Schreibfehler verliert Abschluss nicht',async()=>{
    const write=fs.writeFileSync;fs.writeFileSync=(p,...a)=>{if(String(p).endsWith('.meta.json'))throw Object.assign(Error('fixture'),{code:'EIO'});return write(p,...a);};
    syncBuiltinESMExports();let r;try{r=await timeout(run("printf 'meta-fail\\n'"),3000,'Meta-Fehler verlor Abschluss');}finally{fs.writeFileSync=write;syncBuiltinESMExports();}
    assert.equal(r.exit_code,0);assert.equal(r.output_truncated,true);
   });
   await check('API 503 wird begrenzt mit Backoff wiederholt und Fehler sichtbar',async()=>{
    apiMode='transient';apiAttempts=0;const reports=[],waits=[];
    const retry=new ShellAbschlussWiederholung({complete:(id,r)=>api.meldeShellAbschlussApi(id,api.DAEMON_API_ID,r),report:(_id,_e,n)=>reports.push(n),wait:async n=>{waits.push(n);}});
    assert.equal(await retry.complete('retry',{status:'done',exit_code:0,output:'once'}),true);
    assert.equal(apiAttempts,3);assert.deepEqual(reports,[1,2]);assert.deepEqual(waits,[100,200]);assert.equal(results.get('retry').status,'done');
   });
   await check('413 Ausgabe abgelehnt: Status/Exit trotzdem gespeichert und truncated',async()=>{
    apiMode='413';apiAttempts=0;
    await api.meldeShellAbschlussApi('413',api.DAEMON_API_ID,{status:'done',exit_code:0,output:'fixture'});
    assert.equal(apiAttempts,2);assert.equal(results.get('413').status,'done');assert.equal(results.get('413').exit_code,0);assert.equal(results.get('413').output_truncated,true);
   });
   await check('JSON-Escape/UTF8-Bodycap verhindert 413 vor Upload',async()=>{
    apiMode='ok';apiAttempts=0;
    await api.meldeShellAbschlussApi('cap',api.DAEMON_API_ID,{status:'done',exit_code:0,output:'😀'.repeat(300000)});
    assert.equal(apiAttempts,1);assert.equal(results.get('cap').status,'done');assert.equal(results.get('cap').output_truncated,true);
   });
   await check('dauerhafte API-Stoerung bleibt retrybar, spaeter minimal terminal',async()=>{
    apiMode='down';apiAttempts=0;
    const retry=new ShellAbschlussWiederholung({complete:(id,r)=>api.meldeShellAbschlussApi(id,api.DAEMON_API_ID,r),report:()=>{},wait:async()=>{}});
    assert.equal(await retry.complete('down',{status:'done',output:'lost'}),false);assert.equal(apiAttempts,3);
    await retry.flush();assert.equal(apiAttempts,6);apiMode='ok';await retry.flush();
    assert.equal(results.get('down').status,'failed');assert.equal(results.get('down').error,'completion_persistence_failed');assert.equal(results.get('down').output_truncated,true);assert.equal(retry.size,0);
   });
   await check('echter API-Worker: Burst nach Hintergrunduebergang mit Upload-Retry',async()=>{
    const w=await imp('packages/file-watcher-daemon-ts/dist/shell-job-worker.js');
    const id=randomUUID(),stream=randomUUID().replaceAll('-','').slice(0,16);
    const row={id,project,stream_id:stream,
     command:"sleep 21; "+js("process.stdout.write('API-BURST-'+ 'x'.repeat(16384)+'\\n');process.stderr.write('API-ERR\\n')"),
     timeout_ms:60000,tail_lines:5,agent_id:'sol14-fixture'};
    jobRows.clear();jobRows.set(id,row);queued=row;apiMode='transient';apiAttempts=0;
    worker=await w.startShellJobWorker(()=>[project]);
    await timeout((async()=>{while(!results.has(id))await sleep(100);})(),30000,'API-Worker hat Burst-Abschluss verloren');
    const r=results.get(id);
    assert.equal(r.status,'done');assert.equal(r.exit_code,0);
    assert.match(r.output,/API-BURST-x{16384}/);assert.match(r.output,/API-ERR/);
    assert.equal(apiAttempts,3);
    assert.ok(logs.some(x=>x.includes(id)&&x.includes('laeuft im Hintergrund weiter')));
    assert.ok(logs.some(x=>x.includes(id)&&x.includes('Versuch 1 fehlgeschlagen')));
    await worker.stop();worker=null;jobRows.clear();
   });
   await check('API-Recovery erkennt intern aktive, aber verschwundene Prozesse',async()=>{
    const w=await imp('packages/file-watcher-daemon-ts/dist/shell-job-worker.js');
    const id=randomUUID(),stream=randomUUID().replaceAll('-','').slice(0,16);
    const dead=spawn(process.execPath,['-e','']);await new Promise(r=>dead.once('exit',r));
    fs.writeFileSync(path.join(streams,stream+'.log'),'fixture-recovery\\n');
    fs.writeFileSync(path.join(streams,stream+'.meta.json'),JSON.stringify({project,status:'running',pid:dead.pid}));
    const row={id,project,stream_id:stream,command:"printf fixture",timeout_ms:60000,tail_lines:5};
    jobRows.set(id,row);queued=row;apiMode='hold-context';
    worker=await w.startShellJobWorker(()=>[project]);
    await timeout((async()=>{while(!slowContextRelease)await sleep(25);})(),3000,'Job wurde nicht intern aktiv');
    await w.gleicheShellAbschluesseAb();
    assert.equal(results.get(id)?.status,'failed');assert.equal(results.get(id)?.error,'completion_reconciled');
    assert.equal(results.get(id)?.output_truncated,true);assert.equal(results.get(id)?.nur_laufend,true);
    assert.match(results.get(id)?.message??'',/nicht mehr vorhanden/);
    // Unbekannter/fremder Zustand und lebende PID bleiben unangetastet.
    jobRows.clear();const alive=randomUUID(),foreign=randomUUID();
    for(const [j,pid,proj]of [[alive,process.pid,project],[foreign,dead.pid,'foreign']]){
     const st=randomUUID().replaceAll('-','').slice(0,16);jobRows.set(j,{...row,id:j,stream_id:st});
     fs.writeFileSync(path.join(streams,st+'.meta.json'),JSON.stringify({project:proj,status:'running',pid}));
    }
    await w.gleicheShellAbschluesseAb();assert.equal(results.has(alive),false);assert.equal(results.has(foreign),false);
    apiMode='ok';slowContextRelease();
    await timeout((async()=>{while(results.get(id)?.status!=='done')await sleep(25);})(),3000,'Freigegebener Fixture-Job endet nicht');
    await worker.stop();worker=null;
   });
   console.log('P9-T33 UNIT PASS');
  }
 } else {
  pruefeTestDbUrl('P9-T33 integration');
  const require=createRequire(path.join(moduleRoot,'packages/core/package.json'));
  const {Client}=require('pg');admin=new Client({connectionString:process.env.DATABASE_URL});await admin.connect();
  assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  schema='p9_t33_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);
  for(const table of ['shell_jobs','code_files'])await admin.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING ALL)');
  process.env.PGOPTIONS='-c search_path='+schema+',public';
  const core=await imp('packages/core/dist/index.js');pool=core.getPool();
  assert.equal((await pool.query('SELECT current_schema() AS n')).rows[0].n,schema);
  const id=(await pool.query("INSERT INTO shell_jobs(project,command,status,claimed_by) VALUES($1,'fixture','running',$2) RETURNING id",[project,api.DAEMON_API_ID])).rows[0].id;
  await check('echte Queue: kleine unvollstaendige Ausgabe wird als truncated gespeichert',async()=>{
   await core.completeShellJob(id,{status:'done',exit_code:0,output:'partial',output_truncated:true});
   const r=(await pool.query('SELECT status,exit_code,output,output_truncated FROM shell_jobs WHERE id=$1',[id])).rows[0];
   assert.deepEqual(r,{status:'done',exit_code:0,output:'partial',output_truncated:true});
  });
  await check('echte Queue-CAS: spaete Recovery ueberschreibt terminalen Erfolg nicht',async()=>{
   await core.completeShellJob(id,{status:'failed',exit_code:-1,error:'completion_reconciled',nur_laufend:true,output:'recovery'});
   const r=(await pool.query('SELECT status,exit_code,output FROM shell_jobs WHERE id=$1',[id])).rows[0];
   assert.deepEqual(r,{status:'done',exit_code:0,output:'partial'});
  });
  console.log('P9-T33 INTEGRATION PASS');
 }
}finally{
 if(slowContextRelease)slowContextRelease();
 await worker?.stop();
 for(const pid of children)if(pid){try{process.kill(-pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')console.error('Fixture-Prozessgruppe konnte nicht beendet werden:',e.code);}}
 await timeout(Promise.allSettled(pendingRuns),3000,'Cleanup wartet auf Prozessende').catch(e=>console.error('Fixture-Cleanup:',e.message));
 await app?.close();await pool?.end();
 if(schema)await admin.query('DROP SCHEMA '+schema+' CASCADE');
 await admin?.end();
 await new Promise(r=>server.close(r));
 globalThis.fetch=oldFetch;console.error=originalError;os.homedir=originalHome;syncBuiltinESMExports();
 if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;
 fs.rmSync(root,{recursive:true,force:true});
}
