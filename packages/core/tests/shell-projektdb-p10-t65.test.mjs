/** P10-T65: statische Golden/Ownership-Matrix, kein Live-SQL. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../dist/services/shell-sicherung-seed.js';
const project='p10_shell_projektdb';
const own='postgresql://worker:synthetic@projekt.invalid:6544/p10_shell_projektdb';
const testdb='postgresql://tester:synthetic@test.invalid:6545/synapse_test';
const live='postgresql://worker:synthetic@projekt.invalid:5432/synapse';
const foreign='postgresql://worker:synthetic@projekt.invalid:6544/fremdes_projekt';
const proof={project,ziele:[
 {art:'projekt',host:'projekt.invalid',port:'6544',datenbank:project,user:'worker'},
 {art:'test',host:'test.invalid',port:'6545',datenbank:'synapse_test',user:'tester'},
],live:{host:'projekt.invalid',port:'5432',datenbank:'synapse',user:'worker'}};
const root='/home/blacky/dev/p10_shell_projektdb';
const ctx={shell:'sh',os:'linux',cwd:root,project_root:root,env:{},env_vollstaendig:true,inspect:false,datenbank_freigabe:proof};
const psql=(url,sql)=>"psql '"+url+"' -c '"+sql+"'";
const cli=(url,sql)=>psql(url,sql).replace("psql ","psql -X ");
const cases=[
 ['live',psql(live,'DROP SCHEMA owned CASCADE')],
 ['fremd',psql(foreign,'DROP SCHEMA owned CASCADE')],
 ['dynamisch','psql "$DATABASE_URL" -c "DROP SCHEMA owned CASCADE"'],
 ['gemischt',psql(own,'DELETE FROM owned')+'; '+psql(live,'DELETE FROM owned')],
 ['rm-ausserhalb','rm -rf /outside/p10-shell'],
 ['prozess','kill -- -1'],
];
async function decision(command, extra={}) {
 const lage=await ermittleShellLage(command,{...ctx,...extra});
 return pruefeShellStart({project,command,lage,agent_id:'sol-2',geschuetzte_pids:[4242]},SHELL_SICHERUNG_SEED);
}
const golden=[];
for(const [name,command]of cases){const r=await decision(command);golden.push({name,result:{darf_starten:r.darf_starten,stufe:r.audit.stufe,entscheidung:r.audit.entscheidung,grund:r.audit.grund}});}
if(process.argv.includes('--capture')){console.log(JSON.stringify(golden));process.exit(0);}
const wanted=(await readFile(new URL('./fixtures/shell-projektdb-p10-t65.golden.json',import.meta.url),'utf8')).trimEnd();
assert.equal(JSON.stringify(golden),wanted,'Bisherige fremde/live/unklare/andere Risikoentscheidungen bytegleich');
if(!process.argv.includes('--golden')){
 const good=[
  cli(own,'DROP SCHEMA owned CASCADE'),cli(testdb,'TRUNCATE owned'),
  cli(own,'DELETE FROM owned'),cli(own,'ALTER TABLE owned ADD COLUMN x int'),
 ];
 for(const command of good){const r=await decision(command);
  // P10-T73: DROP/TRUNCATE/DELETE ohne WHERE per psql ist auch auf der eigenen Projekt-DB eine Rueckfrage (kein Freigabe-Thema).
  if(/\b(?:DROP|TRUNCATE|DELETE)\b/.test(command)){assert.equal(r.darf_starten,false,command);assert.equal(r.antwort.stufe,'rueckfrage',command);continue;}
  assert.equal(r.darf_starten,true,command);assert.equal(r.audit.grund,'projekt_eigene_db');}
 assert.equal((await decision(good[0],{datenbank_freigabe:{...proof,project:'anders'}})).darf_starten,false);
 assert.equal((await decision(psql(own,'DROP SCHEMA owned')+'; rm -rf /outside')).darf_starten,false);
 assert.equal((await decision(psql(own,'DROP DATABASE fremdes_projekt'))).darf_starten,false,'SQL wechselt zu fremder DB');
 assert.equal((await decision(psql(own,'\\connect fremdes_projekt\nDROP SCHEMA owned'))).darf_starten,false);
 assert.equal((await decision(psql(own,'DELETE FROM owned'),{datenbank_freigabe:undefined})).darf_starten,false,'Ohne Registry keine Freigabe');
 const node="node -e \"const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.query('DROP SCHEMA owned CASCADE')\"";
 const allowed=await decision(node,{env:{DATABASE_URL:own}});
 assert.equal(allowed.darf_starten,true,'Eigener Zielkontext erlaubt Inline-JS ohne Helfer');assert.equal(allowed.audit.grund,'projekt_eigene_db');
 for(const command of [
  "node -e \"const{Client}=require('pg');const c=new Client({connectionString:process.env.UNKNOWN_URL});c.query('DROP SCHEMA owned')\"",
  "node -e \"const{Client}=require('pg');const a=new Client({connectionString:'"+own+"'});const b=new Client({connectionString:'"+foreign+"'});a.query('DROP SCHEMA owned');b.query('DELETE FROM owned')\"",
  "node -e \"process.env.DATABASE_URL=process.env.UNKNOWN;db.query('DROP SCHEMA owned')\"",
 // P10-T71 Teil 2: unbekannte/fremde Nicht-Prod-Ziele werden nicht mehr abgewiesen (nur Prod ist gesperrt).
 ])assert.equal((await decision(command,{env:{DATABASE_URL:own}})).darf_starten,true,command);
}

const {dbZielAusUrl}=await import('../dist/services/shell-db-zuordnung.js');
const source='/home/blacky/dev/p10_shell_projektdb/test-db.env';
const fakeProbe=async input=>({cwd:input.cwd,os:'linux',env:{},pfade:[],umgebungsdatei:{
 pfad:source,sha256:'a'.repeat(64),testprojekt:false,exportiert:false,datenbank_ziel:dbZielAusUrl(testdb),
}});
const loaded="set -a\n. "+source+"\nset +a\npsql \"$DATABASE_URL\" -X -c 'CREATE TABLE owned(x int)'";
const sourced=await decision(loaded,{inspect:true,probe:fakeProbe,env:{DATABASE_URL:live}});
assert.equal(sourced.darf_starten,true,'Geladene Quelle muss an konfiguriertes Ziel gebunden werden');
assert.equal(sourced.audit.grund,'projekt_eigene_db');
const badProbe=async input=>({...await fakeProbe(input),umgebungsdatei:{...await fakeProbe(input).then(x=>x.umgebungsdatei),datenbank_ziel:dbZielAusUrl(foreign)}});
// P10-T71: ohne Zuordnung der geladenen Quelle bleibt das Prozess-Ziel (hier Prod) massgeblich -> Prod-Sperre.
const bad=await decision(loaded,{inspect:true,probe:badProbe,env:{DATABASE_URL:live}});
assert.equal(bad.darf_starten,false,'Dateiname erteilt keine Freigabe');assert.equal(bad.audit.stufe,'sperre');
assert.notEqual(bad.audit.grund,'projekt_eigene_db');
const {holeShellDbFreigabe}=await import('../dist/services/shell-db-freigabe.js');
const registry={host:'projekt.invalid',port:6544,database:project,user:'worker',passwort:'synthetic',database_url:own,created_at:'2020-01-01'};
const meta=await holeShellDbFreigabe(project,{env:{DATABASE_URL:live,SYNAPSE_TEST_DATABASE_URL:testdb},leseZugang:async p=>p===project?registry:null});
assert.equal(meta.ziele.length,2);assert.equal(JSON.stringify(meta).includes('synthetic'),false);
const withoutTest=await holeShellDbFreigabe(project,{env:{DATABASE_URL:live},leseZugang:async()=>null});
assert.equal(withoutTest.ziele.length,0,'Ohne Konfiguration keine neue Ausnahme');
const fake=await holeShellDbFreigabe(project,{env:{DATABASE_URL:live,SYNAPSE_TEST_DATABASE_URL:live},leseZugang:async()=>({...registry,port:5432,database_url:live})});
assert.equal(fake.ziele.length,0,'Live-Instanz bleibt geschützt');

if(process.argv.includes('--integration')){
 const u=new URL(process.env.DATABASE_URL??'');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
 const {getPool,closePool}=await import('../dist/db/client.js');
 const {execShellInProject}=await import('../dist/services/shell-exec.js');
 const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');
 const pool=getPool();const actual=dbZielAusUrl(u.href);
 assert.ok(actual);
 const tmpRoot=await mkdtemp(new URL('./fixtures/p10-t65-',import.meta.url).pathname),root=new URL('../../../',import.meta.url).pathname,schema='p10_t65_'+process.pid;
 const systemId=process.env.SYNAPSE_TEST_DATABASE_SYSTEM_ID;assert.match(systemId??'',/^[1-9][0-9]{0,19}$/,'Trusted Testcluster-Sollwert muss von der Testkonfiguration kommen');
 const oldFetch=globalThis.fetch,oldSystem=process.env.SYNAPSE_DATABASE_URL,oldTest=process.env.SYNAPSE_TEST_DATABASE_URL;let registered=false,created=false;
 try{
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  assert.equal((await pool.query('SELECT count(*)::int n FROM projects WHERE name=$1',[project])).rows[0].n,0,'Eigener Testprojektname muss frei sein');
  await pool.query('INSERT INTO projects(name,hostname,path,enabled)VALUES($1,$2,$3,true)',[project,os.hostname(),root]);registered=true;
  await pool.query('CREATE SCHEMA '+schema);created=true;
  globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const command="DATABASE_URL="+quote(u.href)+" node packages/core/tests/fixtures/shell-testdb-drop-p10-t65.mjs "+schema;
  process.env.SYNAPSE_DATABASE_URL=live;process.env.SYNAPSE_TEST_DATABASE_URL=u.href;
  const {pruefeShellEinreihung}=await import('../dist/services/shell-einreihung-sicherung.js');
  const queued=await pruefeShellEinreihung({project,command});
  const transport=queued.sicherung?.anfrage?.datenbank_freigabe;
  assert.ok(transport,'API-Queue übermittelt dieselbe Zuordnung');
  assert.equal(transport.test_system_id,systemId,'Sollwert kommt aus Serverkonfiguration, nicht der Clientverbindung');
  assert.ok(transport.ziele.some(z=>z.host===actual.host&&z.port===actual.port&&z.datenbank===actual.datenbank&&z.user===actual.user));
  assert.equal(JSON.stringify(transport).includes('password'),false);
  assert.equal(JSON.stringify(transport).includes('database_url'),false);
  for(const [name,befehl,meta]of [
   ['falsche Clusterkennung',command,{...transport,test_system_id:'1'}],
   ['abweichende PG-Env','PGHOST=live.invalid '+command,transport],
   ['falsche DSN',"DATABASE_URL="+quote(live)+" node packages/core/tests/fixtures/shell-testdb-drop-p10-t65.mjs "+schema,transport],
  ]){
   let negativeStarted=false;
   const wrong=await execShellInProject({project,command:befehl,agent_id:'sol-2',datenbank_freigabe:meta,onStarted:()=>negativeStarted=true,tail_lines:3});
   if(name==='falsche Clusterkennung'){
    assert.equal(negativeStarted,true,'Optionaler Runtimeguard muss erreicht werden');
    assert.ok(typeof wrong.exit_code==='number'&&wrong.exit_code!==0,'Falsche Clusterkennung führt kein DROP aus');
   }else{
    assert.equal(negativeStarted,false,name+': abweichendes Ziel wird vor Spawn abgewiesen');
    assert.equal(wrong.error,'shell_anleitung');
   }
   assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,1,name+': eigenes Schema bleibt');
  }
  let started=false;
  const result=await execShellInProject({project,command,agent_id:'sol-2',datenbank_freigabe:transport,onStarted:()=>started=true,tail_lines:3});
  assert.equal(started,true,JSON.stringify(result));assert.equal(result.exit_code,0,JSON.stringify(result));
  assert.equal((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0,'DROP wirklich ausgeführt');created=false;
  const audit=await pool.query("SELECT sicherung->'audit' AS audit FROM shell_jobs WHERE project=$1 ORDER BY created_at DESC LIMIT 1",[project]);
  assert.equal(audit.rows[0]?.audit.grund,'projekt_eigene_db');
  assert.equal(audit.rows[0]?.audit.entscheidung,'erlaubt');
  console.log('P10-T65 echte DROP-SCHEMA-Ausführung + Audit in synapse_test grün');
 }finally{
  globalThis.fetch=oldFetch;
  oldSystem===undefined?delete process.env.SYNAPSE_DATABASE_URL:process.env.SYNAPSE_DATABASE_URL=oldSystem;
  oldTest===undefined?delete process.env.SYNAPSE_TEST_DATABASE_URL:process.env.SYNAPSE_TEST_DATABASE_URL=oldTest;
  if(created)await pool.query('DROP SCHEMA '+schema+' CASCADE');
  if(registered){await pool.query('DELETE FROM shell_jobs WHERE project=$1',[project]);await pool.query('DELETE FROM projects WHERE name=$1 AND hostname=$2',[project,os.hostname()]);}
  await closePool();await rm(tmpRoot,{recursive:true,force:true});
 }
}

console.log('P10-T65 Golden/Projekt-DB-Matrix grün');
