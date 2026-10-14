/** t82: historische Guard-Fehlblockaden; Quelltexte nur prüfen, nie ausführen. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../dist/services/shell-sicherung-seed.js';
import {dbZielAusUrl,pruefeDbKommando} from '../dist/services/shell-db-zuordnung.js';
import {mitLesePool} from '../dist/db/client.js';
import {vergissJobUmgebungCache} from '../dist/services/shell-job-umgebung.js';
import {WorkspaceOrchestrator} from '../../rest-api/dist/services/workspace-orchestrator.js';
const root='/home/blacky/dev/synapse',project='p10_t82_test';
const own='postgresql://tester:synthetic@test.invalid:5433/synapse_test';
const live='postgresql://system:synthetic@system.invalid:6123/system_catalog';
const proof={project,live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(own),art:'test'}],test_system_id:'123456789'};
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/shell-db-sql-frei-p10-t65.json',import.meta.url),'utf8'));
function probeFor(c,base=root){
 return async input=>({
  cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),
  ...(input.testdatei===base+'/'+c.file?{testdatei:{pfad:input.testdatei,kanonisch:input.testdatei,text:c.text,sha256:c.sha256}}:{}),
  ...(input.umgebungsdatei?{umgebungsdatei:{pfad:input.umgebungsdatei,sha256:'a'.repeat(64),testprojekt:true,exportiert:true,port:'5433',datenbank:'synapse_test',datenbank_ziel:dbZielAusUrl(own)}}:{})
 });
}
for(const c of fixtures)test('Historischer Aufruf '+c.id.slice(0,8)+' ist regulär frei',async()=>{
 assert.equal(createHash('sha256').update(c.text).digest('hex'),c.sha256,'Originalsnapshot unverändert');
 const lage=await ermittleShellLage(c.command,{cwd:path.join(root,c.cwd_relative),project_root:root,os:'linux',shell:'sh',inspect:true,probe:probeFor(c),env:{},env_vollstaendig:true,datenbank_freigabe:proof});
 const r=pruefeShellStart({project,command:c.command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
 assert.equal(r.darf_starten,true,JSON.stringify({audit:r.audit,lage}));
 assert.equal(lage.datenbank_zuordnung?.grund,'projekt_eigene_db');
 assert.equal(lage.datenbank_abgewiesen,undefined);
});
const js=text=>pruefeDbKommando({argv:[{text:'node'}],inline_skript:{sprache:'node',text}},{DATABASE_URL:own},proof);
for(const [name,text] of [
 ['SQL-Variable',"const db=getPool();const name='owned';db.query('CREATE SCHEMA '+name);db.query('SET search_path TO '+name);db.query('DROP SCHEMA '+name+' CASCADE')"],
 ['QueryConfig',"const db=getPool();const q={text:'DROP TABLE owned'};q.text=process.env.SQL;db.query(q)"],
 ['SQL-Template',"const db=getPool();const name='owned';db.query("+String.fromCharCode(96)+"CREATE TABLE "+String.fromCharCode(36)+"{name}(x int)"+String.fromCharCode(96)+")"],
 ['Leseprüfung der DSN',"const u=new URL(process.env.DATABASE_URL);assert.equal(u.port,'5433');const db=getPool();db.query(process.env.SQL)"],
 ['Nicht-DB-Umgebung',"process.env.QDRANT_URL='http://127.0.0.1:9';const db=getPool();db.query(process.env.SQL)"],
 ['Fachliche Metadaten',"const expected={host:'render.invalid',port:8080,user:'worker'};const db=getPool();db.query(process.env.SQL)"]
])test(name+' ohne Verbindungsumbau frei',()=>assert.equal(js(text).erlaubt,true));
for(const [name,text] of [
 ['DB-Wechsel in Konkatenation',"const db=getPool();db.query('DROP DATABASE '+'system_catalog')"],
 ['DB-Wechsel in Template',"const db=getPool();const name='system_catalog';db.query("+String.fromCharCode(96)+"DROP DATABASE "+String.fromCharCode(36)+"{name}"+String.fromCharCode(96)+")"],
 ['dblink',"const db=getPool();db.query('SELECT * FROM dblink($1,$2)')"],
 ['URL-Hostmutation',"const u=new URL(process.env.DATABASE_URL);u.hostname='system.invalid';const db=getPool();db.query(process.env.SQL)"],
 ['URL-Parameterumbau',"const u=new URL(process.env.DATABASE_URL);u.searchParams.set('host','system.invalid');const db=getPool();db.query(process.env.SQL)"],
 ['PG-Umgebung geändert',"process.env.PGHOST='system.invalid';const db=getPool();db.query(process.env.SQL)"]
])test(name+' bleibt Anleitung',()=>assert.equal(js(text).erlaubt,false));

test('Reguläre Helfer-Freigabe gibt Servermetadaten an echten Kindprozess weiter',async()=>{
 const saved={...process.env};
 let starts=0;
 try{
  process.env.SYNAPSE_DATABASE_URL=live;
  process.env.SYNAPSE_TEST_DATABASE_URL=own;
  process.env.SYNAPSE_TEST_DATABASE_SYSTEM_ID=proof.test_system_id;
  const c=fixtures[0];
  const container={
  putArchive:async stream=>{for await(const chunk of stream){void chunk;}},
   inspect:async()=>({Config:{Env:['DATABASE_URL='+live,'PGPASSWORD=synthetic']}}),
   exec:async o=>{
    if(o.User==='0')return{start:async()=>Readable.from([]),inspect:async()=>({ExitCode:0})};
    starts++;
    assert.ok(o.Cmd.some(x=>x.startsWith('SYNAPSE_SHELL_DB_FREIGABE=')),'Private Metadaten fehlen');
    // Echter Docker-Startvektor, statt SQL nur DB-freie Beobachtung des Kind-Env.
    const code="process.stdout.write(JSON.stringify({proof:JSON.parse(process.env.SYNAPSE_SHELL_DB_FREIGABE),hasSystem:Object.values(process.env).includes(process.argv[1]),pg:Object.keys(process.env).some(k=>/^PG/.test(k))}))";
    const cmd=o.Cmd.slice(0,-1);
    cmd.push('node -e '+JSON.stringify(code)+' '+JSON.stringify(live));
    const child=spawnSync(cmd[0],cmd.slice(1),{env:{PATH:process.env.PATH,DATABASE_URL:live,PGPASSWORD:'synthetic'},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    return {start:async()=>Readable.from([Buffer.from(child.stdout)]),inspect:async()=>({ExitCode:child.status})};
   }
  };
  const w=new WorkspaceOrchestrator();
  w.dockerAvailable=true;w.ensureProjectRunning=async()=>'synthetic-container';
  w.recordActivity=async()=>{};w.appendToLog=async()=>{};
  w.lageProbeImContainer=async(_container,input,cwd)=>({...await probeFor(c,'/workspace')({...input,cwd:input.cwd??cwd}),env:{HOME:'/home/synthetic',PWD:cwd},prozesse:{pids:[],namen:[]}});
  w.docker={getContainer:()=>container,modem:{demuxStream:(stream,stdout,stderr)=>{stream.pipe(stdout);stderr.end();}}};
  const query=async sql=>({rows:String(sql).includes(' AS katalog')?[{katalog:SHELL_SICHERUNG_SEED}]:String(sql).includes('INSERT INTO shell_jobs')?[{id:'11111111-1111-4111-8111-111111111111'}]:[],rowCount:0});
  const client={query,release(){}};const pool={query,connect:async()=>client};
  vergissJobUmgebungCache(project);
  const r=await mitLesePool(pool,()=>w.exec(project,c.command,{agent_id:'sol-2'}));
  assert.equal(starts,1,JSON.stringify(r));assert.equal(r.exitCode,0,r.stderr);
  const observed=JSON.parse(r.stdout);
  assert.equal(observed.proof.test_system_id,proof.test_system_id);
  assert.ok(observed.proof.ziele.some(z=>z.art==='test'&&z.datenbank==='synapse_test'));
  assert.equal(observed.hasSystem,false);assert.equal(observed.pg,false);
 }finally{
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
  Object.assign(process.env,saved);vergissJobUmgebungCache(project);
 }
});
