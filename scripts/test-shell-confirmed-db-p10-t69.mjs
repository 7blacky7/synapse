#!/usr/bin/env node
/** P10-T69: A12 für Fixture-PG; echter D1 im bestätigten nativen Kind und Queue-Worker. */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const baseline=process.argv[2];
const mod=p=>baseline?pathToFileURL(baseline+'/'+p):new URL('../'+p,import.meta.url);
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const systemId=process.env.SYNAPSE_TEST_DATABASE_SYSTEM_ID;
assert.match(systemId??'',/^[1-9][0-9]{0,19}$/,'Vertrauenswürdiger Cluster-SOLL muss vom Server kommen, nicht aus einer Testabfrage');
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Client}=require('pg');
async function openDb(){
 const c=new Client({connectionString:url.href});await c.connect();
 try{const r=(await c.query('SELECT current_database() AS db, inet_server_port() AS mapped_port')).rows[0];assert.equal(r.db,'synapse_test');assert.equal(r.mapped_port,5432,'5433 URL -> 5432 Containerport ist zulässig');return c;}
 catch(e){await c.end();throw e;}
}
const db=await openDb(),schema='p10_t69_'+randomUUID().replaceAll('-',''),project='p10_t69_'+process.pid;
const root=await mkdtemp(path.join(os.tmpdir(),'sol-5-t69-'));
const originalHome=os.homedir,originalFetch=globalThis.fetch,saved={...process.env},closing=[];
os.homedir=()=>root;syncBuiltinESMExports();
const {mitLesePool}=await import(mod('packages/core/dist/db/client.js'));
const {dbZielAusUrl}=await import(mod('packages/core/dist/services/shell-db-zuordnung.js'));
const {execShellInProject}=await import(mod('packages/core/dist/services/shell-exec.js'));
const {vergissJobUmgebungCache}=await import(mod('packages/core/dist/services/shell-job-umgebung.js'));
const {runClaimedJob}=await import(mod('packages/file-watcher-daemon-ts/dist/shell-job-worker.js'));
const live='postgresql://system:synthetic@system.invalid:6123/system_catalog';
const proof={project,live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(url.href),art:'test'}],test_system_id:systemId};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pool={query:db.query.bind(db),async connect(){
 const c=await openDb();await c.query('SET search_path TO '+schema+',public');
 return {query:c.query.bind(c),release(){closing.push(c.end());}};
}};
let made=false,passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const command=". "+quote(path.join(root,'test-db.env'))+"; node packages/core/tests/test-confirmed.mjs && printf '\\n'";
const helper=new URL('../scripts/lib/test-db-schutz.mjs',import.meta.url).href;
try{
 await db.query('SET search_path TO '+schema+',public');
 await db.query('CREATE SCHEMA '+schema);made=true;
 for(const name of ['shell_jobs','projects','code_files','projekt_datenbanken','shell_sicherungsregeln','shell_antworttopf','shell_risiko_verben'])
  await db.query('CREATE TABLE '+schema+'.'+name+' (LIKE public.'+name+' INCLUDING ALL)');
 await db.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),root]);
 await mkdir(path.join(root,'packages/core/tests'),{recursive:true});
 await mkdir(path.join(root,'scripts/lib'),{recursive:true});
 await writeFile(path.join(root,'test-db.env'),'export DATABASE_URL='+quote(url.href)+'\n',{mode:0o600});
 // Nur Reexport des echten Repo-Helfers; keine kopierte Guard-Logik und kein selbst gelernter SOLL.
 await writeFile(path.join(root,'scripts/lib/test-db-schutz.mjs'),"export {oeffneGeschuetzteShellTestDb} from "+JSON.stringify(helper)+";\n");
 await writeFile(path.join(root,'packages/core/tests/test-confirmed.mjs'),
  "import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';\n"+
  "const db=await oeffneGeschuetzteShellTestDb();\n"+
  "try{\n"+
  "await db.query('INSERT INTO "+schema+".observations(value) VALUES(1)');\n"+
  "console.log('D1_OPEN '+JSON.stringify({db:'synapse_test',private:!!process.env.SYNAPSE_SHELL_DB_FREIGABE,pg:Object.keys(process.env).some(k=>/^PG/.test(k)),live:process.env.SYNAPSE_DATABASE_URL!==undefined}));\n"+
  "}finally{await db.end();}\n");
 await db.query('CREATE TABLE '+schema+'.observations(value int)');
 process.env.SYNAPSE_DATABASE_URL=live;
 process.env.PGPASSWORD='synthetic-parent-secret';process.env.PGPORT='5432';
 globalThis.fetch=async()=>Response.json({enabled:true});
 vergissJobUmgebungCache(project);
 const call=args=>mitLesePool(pool,()=>execShellInProject({project,command,agent_id:'sol-5',datenbank_freigabe:proof,...args}));
 let rejected;
 await check('Unbestätigter nativer Job startet weder Kind noch Nutz-SQL',async()=>{
  rejected=await call({});assert.equal(rejected.status,'rejected');assert(rejected.bestaetigungsdaten);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n),0);
 });
 const confirmed={grund:'P10-T69 isolierter Test mit vertrauenswürdigem Server-SOLL',...rejected.bestaetigungsdaten};
 if(baseline){
  const r=await call({agent_id:'koordinator',bestaetigt:confirmed});assert.equal(r.status,'failed');
  const log=await readFile(path.join(root,'.synapse/shell-streams',r.stream_id+'.log'),'utf8');
  assert.match(log,/test_db_servermetadaten_fehlen/);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n),0);
  console.log('T88_ROT_KONTROLLE: bestätigter nativer Job ohne private Metadaten, 0 Nutzwrites.');
 }else{
 await check('Realer nativer bestätigter Job öffnet D1 und schreibt nur eigenen Schema',async()=>{
  const r=await call({agent_id:'koordinator',bestaetigt:confirmed});
  assert.equal(r.status,'done',JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));
  const m=JSON.parse(await readFile(path.join(root,'.synapse/shell-streams',r.stream_id+'.meta.json'),'utf8'));
  assert.equal(m.project,project);assert.equal(m.status,'done');
  const log=await readFile(path.join(root,'.synapse/shell-streams',r.stream_id+'.log'),'utf8');
  assert.match(log,/D1_OPEN /);const observation=JSON.parse(log.split('D1_OPEN ')[1].split('\n')[0]);
  assert.equal(observation.private,true);assert.equal(observation.pg,false);assert.equal(observation.live,false);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n),1);
 });
 await check('Rollen- und Lage-Drift starten keinen weiteren Kindprozess',async()=>{
  for(const args of [{agent_id:'sol-5',bestaetigt:confirmed},{agent_id:'koordinator',bestaetigt:{...confirmed,lage_hash:'drift'}}]){
   const r=await call(args);assert.equal(r.status,'rejected');
  }
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n),1);
 });
 await check('Realer Queue-Worker reicht API-Freigabe an D1 durch',async()=>{
  const id=randomUUID(),stream=randomUUID().replaceAll('-','').slice(0,16);
  await db.query("INSERT INTO shell_jobs(id,project,command,agent_id,status,claimed_by,claimed_at,stream_id,sicherung) VALUES($1,$2,$3,'koordinator','running',$4,clock_timestamp(),$5,$6::jsonb)",
   [id,project,command,'daemon-'+os.hostname()+'-'+process.pid,stream,JSON.stringify({anfrage:{bestaetigt:confirmed,datenbank_freigabe:proof,shell:'sh'}})]);
  const j=(await db.query('SELECT * FROM shell_jobs WHERE id=$1',[id])).rows[0];
  await mitLesePool(pool,()=>runClaimedJob(project,j));
  const r=(await db.query('SELECT status,exit_code,output,error FROM shell_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(r.status,'done',JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));assert.match(r.output,/D1_OPEN /);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n),2);
 });
 await check('Falscher Cluster-SOLL bleibt trotz Bestätigung vor Nutz-SQL gesperrt',async()=>{
  const bad={...proof,test_system_id:systemId==='1'?'2':'1'};
  const first=await call({datenbank_freigabe:bad});
  const r=await call({datenbank_freigabe:bad,agent_id:'koordinator',bestaetigt:{grund:'Isolierte D1 Negativkontrolle',...first.bestaetigungsdaten}});
  assert.equal(r.status,'failed');assert.notEqual(r.exit_code,0);
  const log=await readFile(path.join(root,'.synapse/shell-streams',r.stream_id+'.log'),'utf8');
  assert.match(log,/test_db_laufzeit_ziel_abweichend/);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n),2);
 });
 console.log('P10-T69 NATIVE_PG_GRUEN '+passed+' Gruppen, 0 Skip; eigener Schema und mkdtemp bereinigt.');
 }
}finally{
 globalThis.fetch=originalFetch;os.homedir=originalHome;syncBuiltinESMExports();
 for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 vergissJobUmgebungCache(project);await Promise.all(closing);
 if(made)await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();await rm(root,{recursive:true,force:true});
}
