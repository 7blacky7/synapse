#!/usr/bin/env node
/**
 * P10-T69, angepasst P10-T71 Teil 2 (14.10.2026, memory regel-datenbanken-nur-prod-gesperrt):
 * Echter nativer Shell-Job und Queue-Worker schreiben ohne Bestaetigung und ohne private Freigabe-Metadaten
 * in synapse_test (eigenes Schema). Schreibendes SQL gegen die (synthetische) Prod-DB wird vor dem Spawn gesperrt.
 * Mit argv[2]=<Basis-Worktree> laeuft die Rot-Kontrolle gegen den alten Stand (dort ohne Metadaten kein Nutzwrite).
 */
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
const require=createRequire(new URL('../packages/core/package.json',import.meta.url)),{Client}=require('pg');
async function openDb(){
 const c=new Client({connectionString:url.href});await c.connect();
 try{const r=(await c.query('SELECT current_database() AS db')).rows[0];assert.equal(r.db,'synapse_test');return c;}
 catch(e){await c.end();throw e;}
}
const db=await openDb(),schema='p10_t71_'+randomUUID().replaceAll('-',''),project='p10_t71_'+process.pid;
const root=await mkdtemp(path.join(os.tmpdir(),'tp-b-t71-'));
const originalHome=os.homedir,originalFetch=globalThis.fetch,saved={...process.env},closing=[];
os.homedir=()=>root;syncBuiltinESMExports();
const {mitLesePool}=await import(mod('packages/core/dist/db/client.js'));
const {dbZielAusUrl}=await import(mod('packages/core/dist/services/shell-db-zuordnung.js'));
const {execShellInProject}=await import(mod('packages/core/dist/services/shell-exec.js'));
const {vergissJobUmgebungCache}=await import(mod('packages/core/dist/services/shell-job-umgebung.js'));
const {runClaimedJob}=await import(mod('packages/file-watcher-daemon-ts/dist/shell-job-worker.js'));
// Synthetische "Prod"-Angabe (nicht erreichbar); echte Prod-DB wird nie angesprochen.
const live='postgresql://system:synthetic@system.invalid:6123/system_catalog';
const proof={project,live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(url.href),art:'test'}],test_system_id:process.env.SYNAPSE_TEST_DATABASE_SYSTEM_ID};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const pool={query:db.query.bind(db),async connect(){
 const c=await openDb();await c.query('SET search_path TO '+schema+',public');
 return {query:c.query.bind(c),release(){closing.push(c.end());}};
}};
let made=false,passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const command=". "+quote(path.join(root,'test-db.env'))+"; node packages/core/tests/test-confirmed.mjs && printf '\\n'";
const helper=(baseline?pathToFileURL(baseline+'/scripts/lib/test-db-schutz.mjs'):new URL('../scripts/lib/test-db-schutz.mjs',import.meta.url)).href;
const zahl=async()=>Number((await db.query('SELECT count(*) AS n FROM observations')).rows[0].n);
try{
 await db.query('SET search_path TO '+schema+',public');
 await db.query('CREATE SCHEMA '+schema);made=true;
 for(const name of ['shell_jobs','projects','code_files','projekt_datenbanken','shell_sicherungsregeln','shell_antworttopf','shell_risiko_verben'])
  await db.query('CREATE TABLE '+schema+'.'+name+' (LIKE public.'+name+' INCLUDING ALL)');
 await db.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),root]);
 await mkdir(path.join(root,'packages/core/tests'),{recursive:true});
 await mkdir(path.join(root,'scripts/lib'),{recursive:true});
 await writeFile(path.join(root,'test-db.env'),'export DATABASE_URL='+quote(url.href)+'\n',{mode:0o600});
 // Nur Reexport des echten Repo-Helfers; keine kopierte Guard-Logik.
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
 if(baseline){
  const r=await call({});
  assert.ok(r.status!=='done'||await zahl()===0,JSON.stringify(r));
  assert.equal(await zahl(),0);
  console.log('T95_ROT_KONTROLLE: alter Stand schreibt ohne Bestaetigung/Metadaten nicht in die Test-DB (status '+r.status+').');
 }else{
 await check('Nativer Job schreibt ohne Bestaetigung und ohne Freigabe-Metadaten in synapse_test',async()=>{
  const r=await call({});
  assert.equal(r.status,'done',JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));
  const log=await readFile(path.join(root,'.synapse/shell-streams',r.stream_id+'.log'),'utf8');
  assert.match(log,/D1_OPEN /);const observation=JSON.parse(log.split('D1_OPEN ')[1].split('\n')[0]);
  assert.equal(observation.private,false);assert.equal(observation.pg,false);assert.equal(observation.live,false);
  assert.equal(await zahl(),1);
 });
 await check('Schreibendes SQL gegen die Prod-DB wird vor dem Spawn gesperrt',async()=>{
  let started=false;
  const r=await call({command:'psql '+quote(live)+" -c 'DELETE FROM shell_jobs'",onStarted:()=>{started=true;}});
  assert.equal(r.status,'rejected',JSON.stringify(r));assert.equal(r.error,'shell_sperre');assert.equal(started,false);
  const bestaetigt=await call({command:'psql '+quote(live)+" -c 'DELETE FROM shell_jobs'",agent_id:'koordinator',bestaetigt:{grund:'P10-T71 Negativkontrolle Prod-Sperre',...r.bestaetigungsdaten}});
  assert.equal(bestaetigt.status,'rejected');assert.equal(bestaetigt.error,'shell_sperre');
 });
 await check('Realer Queue-Worker laeuft ohne Bestaetigung/Metadaten',async()=>{
  const id=randomUUID(),stream=randomUUID().replaceAll('-','').slice(0,16);
  await db.query("INSERT INTO shell_jobs(id,project,command,agent_id,status,claimed_by,claimed_at,stream_id,sicherung) VALUES($1,$2,$3,'sol-5','running',$4,clock_timestamp(),$5,$6::jsonb)",
   [id,project,command,'daemon-'+os.hostname()+'-'+process.pid,stream,JSON.stringify({anfrage:{datenbank_freigabe:proof,shell:'sh'}})]);
  const j=(await db.query('SELECT * FROM shell_jobs WHERE id=$1',[id])).rows[0];
  await mitLesePool(pool,()=>runClaimedJob(project,j));
  const r=(await db.query('SELECT status,exit_code,output,error FROM shell_jobs WHERE id=$1',[id])).rows[0];
  assert.equal(r.status,'done',JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));assert.match(r.output,/D1_OPEN /);
  assert.equal(await zahl(),2);
 });
 await check('Abweichende Clusterkennung spielt keine Rolle mehr',async()=>{
  const r=await call({datenbank_freigabe:{...proof,test_system_id:'1'}});
  assert.equal(r.status,'done',JSON.stringify(r));assert.equal(await zahl(),3);
 });
 console.log('P10-T71 NATIVE_PG_GRUEN '+passed+' Gruppen, 0 Skip; eigener Schema und mkdtemp bereinigt.');
 }
}finally{
 globalThis.fetch=originalFetch;os.homedir=originalHome;syncBuiltinESMExports();
 for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
 vergissJobUmgebungCache(project);await Promise.all(closing);
 if(made)await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();await rm(root,{recursive:true,force:true});
}
