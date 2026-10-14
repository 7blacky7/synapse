#!/usr/bin/env node
/** P9-T26: guarded PG, echte Kindprozesse, nur eigene mkdtemp-Dateien und eigener Schema. */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const mode=process.argv[2]??'test',repo=process.argv[3];
const mod=p=>repo?pathToFileURL(repo+'/'+p):new URL('../'+p,import.meta.url);
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Client}=require('pg');
async function openDb(){
 const c=new Client({connectionString:url.href});await c.connect();
 try{assert.equal((await c.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');return c;}
 catch(e){await c.end();throw e;}
}
const db=await openDb();
const schema='p9_t26_'+process.pid,project='p9_t26',root=await mkdtemp(path.join(os.tmpdir(),'sol-10-t26-'));
const originalHome=os.homedir,originalSpawn=childProcess.spawn,originalFetch=globalThis.fetch,calls=[];
os.homedir=()=>root; // Produktstreams/Secrets unter eigener Root, HOME bleibt unverändert.
childProcess.spawn=(bin,argv,opts)=>{calls.push({bin,argv,cwd:opts?.cwd});return originalSpawn(bin,argv,opts);};
syncBuiltinESMExports();
await db.query('SELECT current_database() AS datenbank'); // Sichtbarer Test-DB-Nachweis.
await db.query('SET search_path TO '+schema);
const pool={query:db.query.bind(db),async connect(){const c=await openDb();await c.query('SET search_path TO '+schema);return {query:c.query.bind(c),release(){closing.push(c.end());}};}};
const closing=[];let made=false,passed=0;
const {mitLesePool}=await import(mod('packages/core/dist/db/client.js'));
const queue=await import(mod('packages/core/dist/services/shell-queue.js'));
const {maskiereShellVorSpeichern}=await import(mod('packages/core/dist/services/shell-maske.js'));
const {maskiereShellText}=await import(mod('packages/core/dist/services/env-maske.js'));
const check=async(label,fn)=>{await fn();passed++;console.log('PASS '+label);};
const row=async id=>(await db.query('SELECT status,exit_code,tail,output,error,message,output_truncated FROM shell_jobs WHERE id=$1',[id])).rows[0];
const daemon='daemon-'+os.hostname()+'-'+process.pid;
async function job(command='printf fixture',owner=daemon,stream=randomUUID().replaceAll('-','').slice(0,16)){
 const id=randomUUID();
 await db.query("INSERT INTO shell_jobs(id,project,command,agent_id,status,claimed_by,claimed_at,stream_id,tail_lines) VALUES($1,$2,$3,'sol-10','running',$4,clock_timestamp(),$5,5)",[id,project,command,owner,stream]);
 return (await db.query('SELECT * FROM shell_jobs WHERE id=$1',[id])).rows[0];
}
async function golden(){
 const snapshot={};
 for(const [name,result]of [
 ['success',{status:'done',exit_code:0,tail:['plain☃😀'],output:'plain☃😀\n'}],
 ['failure',{status:'failed',exit_code:7,tail:['plain error'],output:'plain error\n',error:'fixture_failed',message:'synthetic failure'}],
 ['cancelled',{status:'done',exit_code:0,tail:['plain'],output:'plain\n'}],
 ]){
  const j=await job();
  if(name==='cancelled')await db.query("UPDATE shell_jobs SET cancelled_at=clock_timestamp() WHERE id=$1",[j.id]);
  await mitLesePool(pool,()=>queue.completeShellJob(j.id,result));
  snapshot[name]=await row(j.id);
 }
 return snapshot;
}
const streamDir=path.join(root,'.synapse','shell-streams');
async function metadata(j,m,output='recovered\n'){
 await mkdir(streamDir,{recursive:true});
 await writeFile(path.join(streamDir,j.stream_id+'.meta.json'),JSON.stringify({project,...m}));
 await writeFile(path.join(streamDir,j.stream_id+'.log'),output);
}
try{
 await db.query('CREATE SCHEMA '+schema);made=true;
 for(const name of ['shell_jobs','projects','code_files','projekt_datenbanken','shell_sicherungsregeln','shell_antworttopf','shell_risiko_verben'])
  await db.query('CREATE TABLE '+schema+'.'+name+' (LIKE public.'+name+' INCLUDING ALL)');
 await db.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),root]);
 globalThis.fetch=async()=>Response.json({enabled:true});
 const snapshot=await golden();
 if(mode==='golden-capture'){
  console.log('GOLDEN_JSON '+JSON.stringify(snapshot));
  const j=await job();
  await assert.rejects(()=>mitLesePool(pool,()=>queue.completeShellJob(j.id,{status:'done',exit_code:0,tail:['old\u0000'],output:'old\u0000'})),e=>['22021','22P05'].includes(e.code));
  assert.equal((await row(j.id)).status,'running');console.log('ALTSTAND_NUL_ROT: PG weist NUL ab, Job bleibt running.');
 }
 else{
  const expected=JSON.parse(await readFile(new URL('./fixtures/shell-completion-p9-t26-t88.golden.json',import.meta.url),'utf8'));
  await check('t88-Golden: Erfolg/Fehler/Abbruch unverändert',()=>assert.deepEqual(snapshot,expected));
  if(mode!=='golden-verify'){
  await check('Echtes PG speichert NUL in Output/Tail/Error/Message nach Bereinigung',async()=>{
   const j=await job();
   await mitLesePool(pool,()=>queue.completeShellJob(j.id,{status:'done',exit_code:0,output:'A\0β😀\n',tail:['A\0β😀'],error:'fixture\0',message:'M\0'}));
   const r=await row(j.id);assert.equal(r.status,'done');assert.equal(r.output,'A\\0β😀\n');
   assert.deepEqual(r.tail,['A\\0β😀']);assert.match(r.message,/NUL-Bytes ersetzt: 4/);assert.equal(JSON.stringify(r).includes('\\u0000'),false);
  });
  await check('Secretmaske bleibt vor NUL-Sicherung erhalten',async()=>{
   await mkdir(path.join(root,'.config','synapse'),{recursive:true});
   await writeFile(path.join(root,'.config','synapse','secrets.env'),'P9_FAKE_API_KEY=synthetic-secret-value\n');
   const safe=await mitLesePool(pool,()=>maskiereShellVorSpeichern(project,{tail:['synthetic-secret-value\0β'],output:'synthetic-secret-value\0β'}));
   assert.equal(JSON.stringify(safe).includes('synthetic-secret-value'),false);assert.equal(JSON.stringify(safe).includes('\\u0000'),false);assert.match(safe.message,/NUL-Bytes ersetzt: 2/);
  });
  const worker=await import('../packages/file-watcher-daemon-ts/dist/shell-job-worker.js');
  await check('Realer Worker: NUL-stdout/Stderr, PGabschluss und Queue-/Stream-ID',async()=>{
   const command="printf 'A\\000β😀\\n'; printf 'ERR\\000Z\\n' >&2",j=await job(command);
   calls.length=0;await mitLesePool(pool,()=>worker.runClaimedJob(project,j));
   const r=await row(j.id);assert.equal(r.status,'done');assert.equal(r.exit_code,0);
   assert(r.output.includes('A\\0β😀'));assert(r.output.includes('ERR\\0Z'));assert.match(r.output,/NUL-Bytes ersetzt: 2/);
   assert.equal(JSON.stringify(r).includes('\\u0000'),false);
   const m=JSON.parse(await readFile(path.join(streamDir,j.stream_id+'.meta.json'),'utf8'));assert.equal(m.status,'done');assert.equal(m.project,project);
   assert.equal(calls.filter(c=>c.cwd===root&&c.argv?.includes(command)).length,1);
  });
  await check('Transienter PG-Ausfall nach Prozessende: Retry führt Kommando genau einmal aus',async()=>{
   const command='printf RETRY_ONCE',j=await job(command);calls.length=0;let errors=2,attempts=0;
   const flaky={...pool,query:async(sql,v)=>{
    if(/UPDATE shell_jobs\s+SET status = CASE/.test(sql)){attempts++;if(errors-- >0)throw Object.assign(Error('synthetic PG outage'),{code:'ECONNREFUSED'});}
    return pool.query(sql,v);
   }};
   await mitLesePool(flaky,()=>worker.runClaimedJob(project,j));
   assert.equal((await row(j.id)).status,'done');assert.equal(attempts,3);
   assert.equal(calls.filter(c=>c.cwd===root&&c.argv?.includes(command)).length,1);
  });
  await check('Ausstehender Abschluss wird im Safety-Net nachgetragen, ohne Prozessrestart',async()=>{
   const command='printf PENDING_ONCE',j=await job(command);calls.length=0;let errors=3;
   const flaky={...pool,query:async(sql,v)=>{
    if(/UPDATE shell_jobs\s+SET status = CASE/.test(sql)&&errors-- >0)throw Error('synthetic PG outage');
    return pool.query(sql,v);
   }};
   await mitLesePool(flaky,()=>worker.runClaimedJob(project,j));
   assert.equal((await row(j.id)).status,'running');
   await mitLesePool(pool,()=>worker.gleicheShellAbschluesseAb());
   assert.equal((await row(j.id)).status,'done');
   assert.equal(calls.filter(c=>c.cwd===root&&c.argv?.includes(command)).length,1);
  });
  await check('Beendete eigene Metadaten recovern; fehlender Prozess wird ehrlich failed',async()=>{
   const good=await job(),missing=await job();
   await metadata(good,{status:'done',exit_code:0,pid:process.pid},'historic\0β\n');
   await metadata(missing,{status:'running',pid:999999999});
   await mitLesePool(pool,()=>worker.gleicheShellAbschluesseAb());
   const a=await row(good.id),b=await row(missing.id);
   assert.equal(a.status,'done');assert.equal(a.output,'historic\\0β\n');assert.equal(b.status,'failed');assert.equal(b.error,'completion_reconciled');
  });
  await check('Alive/unklare/fremde Host-/Daemon-/Projektmetadaten werden nicht abgeschlossen',async()=>{
   const fixtures=[
    [await job(),{status:'running',pid:process.pid}],
    [await job(),{status:'running'}],
    [await job('fixture','daemon-foreign-123'),{status:'done',exit_code:0}],
    [await job('fixture','daemon-'+os.hostname()+'-old'),{status:'done',exit_code:0}],
    [await job(),{project:'foreign',status:'done',exit_code:0}],
   ];
   for(const [j,m]of fixtures)await metadata(j,m);
   const noMeta=await job();
   await mitLesePool(pool,()=>worker.gleicheShellAbschluesseAb());
   for(const [j]of fixtures)assert.equal((await row(j.id)).status,'running');assert.equal((await row(noMeta.id)).status,'running');
  });
  await check('Notify-Fehler nach gespeichertem UPDATE darf Erfolg nicht in failed umwandeln',async()=>{
   const j=await job(),{ShellAbschlussWiederholung}=await import('../packages/file-watcher-daemon-ts/dist/shell-job-completion.js');
   let errors=6;
   const flaky={...pool,query:async(sql,v)=>{
    if(/SELECT pg_notify/.test(sql)&&errors-- >0)throw Error('synthetic notification outage');
    return pool.query(sql,v);
   }};
   const retry=new ShellAbschlussWiederholung({complete:(id,r)=>mitLesePool(flaky,()=>queue.completeShellJob(id,r)),report:()=>{},wait:async()=>{}});
   await retry.complete(j.id,{status:'done',exit_code:0,output:'saved\n'});await retry.flush();await retry.flush();
   assert.equal((await row(j.id)).status,'done','gespeicherter Erfolg bleibt terminal, selbst nach wiederholtem Notificationausfall');
  });
  console.log('P9-T26 TEST_GRUEN '+passed+' PG-/Prozessgruppen, 0 Skip; eigene Schema/Root-Bereinigung.');
  }
 }
}finally{
 globalThis.fetch=originalFetch;os.homedir=originalHome;childProcess.spawn=originalSpawn;syncBuiltinESMExports();
 await Promise.all(closing);
 if(made)await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();
 await rm(root,{recursive:true,force:true});
}
