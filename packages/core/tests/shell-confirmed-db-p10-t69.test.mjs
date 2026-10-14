/**
 * P10-T69, angepasst P10-T71 Teil 2 (14.10.2026, memory regel-datenbanken-nur-prod-gesperrt):
 * Test-DB-Zugriffe laufen ohne Bestaetigung und ohne private Freigabe-Metadaten
 * (SYNAPSE_SHELL_DB_FREIGABE entfaellt, privateShellTestDbFreigabe liefert immer undefined).
 * Gesperrt bleibt nur schreibender Zugriff auf die Synapse-Produktions-DB.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {privateShellTestDbFreigabe} from '../dist/services/shell-db-freigabe.js';
import {dbZielAusUrl} from '../dist/services/shell-db-zuordnung.js';
import {SHELL_SICHERUNG_SEED as catalog} from '../dist/services/shell-sicherung-seed.js';
import {mitLesePool} from '../dist/db/client.js';
import {vergissJobUmgebungCache} from '../dist/services/shell-job-umgebung.js';
import {WorkspaceOrchestrator} from '../../rest-api/dist/services/workspace-orchestrator.js';
import {oeffneGeschuetzteTestDb} from '../dist/services/test-db-laufzeit-schutz.js';
const project='p10_t69',root='/workspace';
const own='postgresql://tester:synthetic@test.invalid:5433/synapse_test';
const live='postgresql://system:synthetic@system.invalid:6123/system_catalog';
const proof={project,live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(own),art:'test'}],test_system_id:'123456789'};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const js="const db=getPool();db.query('SELECT 1')";
const command="node -e "+quote(js)+" && printf done";
function probe(env={DATABASE_URL:own},source={}){
 return async input=>({cwd:input.cwd,os:'linux',env,
  pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),
  ...(input.umgebungsdatei?{umgebungsdatei:{pfad:input.umgebungsdatei,sha256:'a'.repeat(64),testprojekt:true,exportiert:true,port:'5433',datenbank:'synapse_test',datenbank_ziel:dbZielAusUrl(own),...source}}:{})});
}
async function lage(c=command,freigabe=proof,env={DATABASE_URL:own},source={}){
 return ermittleShellLage(c,{cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,probe:probe(env,source),env,env_vollstaendig:true,datenbank_freigabe:freigabe});
}
function decide(c,l,who='koordinator',changes={}){
 const first=pruefeShellStart({project,command:c,lage:l,agent_id:'sol-5'},catalog);
 const confirmed=pruefeShellStart({project,command:c,lage:l,agent_id:who,bestaetigt:{grund:'Isolierte P10-T69 Testprobe',...first.antwort?.bestaetigungsdaten,...changes}},catalog);
 return {first,confirmed};
}
test('Bekannte Test-DB in einer Kette laeuft ohne Bestaetigung und ohne Metadaten',async()=>{
 const l=await lage(),{first,confirmed}=decide(command,l);
 assert.equal(first.darf_starten,true,JSON.stringify(first.antwort?.risiko));assert.equal(first.audit.entscheidung,'erlaubt');
 assert.equal(l.datenbank_testzuordnung,undefined,'P10-T71: keine Testzuordnung mehr');
 assert.equal(privateShellTestDbFreigabe(l,proof,first),undefined);
 assert.equal(confirmed.darf_starten,true);
 assert.equal(privateShellTestDbFreigabe(l,proof,confirmed),undefined);
});
test('Schreibendes SQL auf die Prod-DB bleibt gesperrt, auch bestaetigt',async()=>{
 const c="psql "+quote(live)+" -c 'DELETE FROM shell_jobs'";
 const l=await lage(c,proof,{DATABASE_URL:own});
 assert.equal(l.datenbank_live,true,JSON.stringify(l.ungeklaert));
 const {first,confirmed}=decide(c,l);
 assert.equal(first.darf_starten,false);assert.equal(first.audit.stufe,'sperre');
 assert.equal(confirmed.darf_starten,false);assert.equal(confirmed.antwort.error,'shell_sperre');
 const lesen="psql "+quote(live)+" -c 'SELECT 1'",ll=await lage(lesen,proof,{DATABASE_URL:own});
 assert.notEqual(decide(lesen,ll).first.audit.stufe,'sperre','Lesen auf Prod ist frei');
});
test('Rollen, Drift und kurze Begruendung aendern nichts: Test-DB laeuft, keine Metadaten',async()=>{
 const l=await lage();
 for(const [who,changes]of [['sol-5',{}],['user',{}],['koordinator',{lage_hash:'drift'}],['koordinator',{befehl_hash:'drift'}],['koordinator',{regelversion:'drift'}],['koordinator',{grund:'kurz'}]]){
  const {confirmed}=decide(command,l,who,changes);
  assert.equal(confirmed.darf_starten,true);assert.equal(privateShellTestDbFreigabe(l,proof,confirmed),undefined);
 }
});
for(const [name,c,env,p,source]of [
 ['Live',command,{DATABASE_URL:live},proof,{}],
 ['Unregistriert',command,{DATABASE_URL:own.replace('test.invalid','foreign.invalid')},proof,{}],
 ['Unbekannte DSN',command,{},proof,{}],
 ['Gemischte DB',command+"; psql "+quote(live)+" -c 'SELECT 1'",{DATABASE_URL:own},proof,{}],
 ['PG-Override',command,{DATABASE_URL:own,PGPORT:'5432'},proof,{}],
 ['Shell-Export',"export PGHOST=foreign.invalid; "+command,{DATABASE_URL:own},proof,{}],
 ['Unbekannter Interpreter',command+"; node unknown-script.mjs",{DATABASE_URL:own},proof,{}],
 ['Nur Testmarker',". /tmp/test.env; "+command,{},proof,{datenbank_ziel:undefined}],
 ['Fehlende Clusterkennung',command,{DATABASE_URL:own},{...proof,test_system_id:undefined},{}],
 ['Ungültige Clusterkennung',command,{DATABASE_URL:own},{...proof,test_system_id:'0'},{}],
 ['Fremdes Projekt',command,{DATABASE_URL:own},{...proof,project:'foreign'},{}],
])test(name+' gibt selbst bei bestätigter Ausführung keine privaten Metadaten',async()=>{
 const l=await lage(c,name==='Fremdes Projekt'?proof:p,env,source),{confirmed}=decide(c,l);
 assert.equal(privateShellTestDbFreigabe(l,p,confirmed),undefined);
});
test('Gepruefte Envdatei: Kette laeuft ohne Bestaetigung, keine Metadaten',async()=>{
 const c=". /tmp/test.env; "+command,l=await lage(c,proof,{});
 const {first}=decide(c,l);assert.equal(first.darf_starten,true,JSON.stringify(first.antwort?.risiko));
 assert.equal(privateShellTestDbFreigabe(l,proof,first),undefined);
});
// P10-T71: Basis ist der letzte Deploy t95 (9f5b103a); Lage und Startantwort bleiben bytegleich,
// nur die privaten Metadaten entfallen.
test('Altstand-Golden: erlaubte Lage, Hash und Startantwort bytegleich t95',async()=>{
 const base=process.env.P10_T69_GOLDEN_BASE??'/tmp/synapse-basis-9f5b103';
 const old=await import(pathToFileURL(base+'/packages/core/dist/services/shell-lage.js'));
 const oldStart=await import(pathToFileURL(base+'/packages/core/dist/services/shell-start-sicherung.js'));
 for(const [c,freigabe] of [["printf plain",proof],["node -e "+quote(js),proof],...[undefined,'0','invalid','01'].map(id=>[command,{...proof,test_system_id:id}])]){
  const ctx={cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,probe:probe(),env:{DATABASE_URL:own},env_vollstaendig:true,datenbank_freigabe:freigabe};
  const before=await old.ermittleShellLage(c,ctx);
  const previous=oldStart.pruefeShellStart({project,command:c,lage:before,agent_id:'sol-5'},catalog);
  const after=await ermittleShellLage(c,ctx);
  assert.equal(JSON.stringify(after),JSON.stringify(before));
  const now=pruefeShellStart({project,command:c,lage:after,agent_id:'sol-5'},catalog);
  const stable=x=>({...x,audit:{...x.audit,zeit:'runtime'}});
  // P10-T71 Teil 2 (gewollte Abweichung): datenbank_abgewiesen hebt die Stufe nicht mehr an (t95: Hinweis -> jetzt laeuft).
  if(after.datenbank_abgewiesen&&previous.audit.stufe==='hinweis'){
   assert.equal(now.darf_starten,true);assert.equal(now.audit.stufe,'laeuft');assert.equal(now.hinweis,undefined);
   assert.deepEqual({...stable(now).audit,stufe:'hinweis'},stable(previous).audit);
  }else assert.deepEqual(stable(now),stable(previous));
  assert.equal(privateShellTestDbFreigabe(after,proof,now),undefined);
 }
});
test('D1 oeffnet die Test-DB direkt ohne Sollwert-Pruefung; Prod-Ziel bleibt abgewiesen',async()=>{
 const calls=[];
 const client={async connect(){},async end(){},async query(text){calls.push(text);return {rows:[{ok:1}]};}};
 const db=await oeffneGeschuetzteTestDb(own,undefined,()=>client);
 await db.query('SELECT 1');await db.query('SELECT 2');
 assert.deepEqual(calls,['SELECT 1','SELECT 2'],'keine pg_control_system-Abfrage mehr');await db.end();
 let created=false;
 await assert.rejects(()=>oeffneGeschuetzteTestDb(live,proof,()=>{created=true;return client;}),/test_db_ist_produktion/);
 assert.equal(created,false);
});
test('Workspace: Test-DB-Kette startet ohne Bestaetigung im env-i Kindprozess; Metadaten/Live/PG fehlen',async()=>{
 const saved={...process.env};let starts=0,seen;
 try{
  process.env.SYNAPSE_DATABASE_URL=live;process.env.SYNAPSE_TEST_DATABASE_URL=own;process.env.SYNAPSE_TEST_DATABASE_SYSTEM_ID=proof.test_system_id;
  const c=". /tmp/test.env; "+command;
  const container={inspect:async()=>({Config:{Env:['DATABASE_URL='+live,'PGPASSWORD=synthetic']}}),
   exec:async o=>{
    if(o.User==='0')return {start:async()=>Readable.from([]),inspect:async()=>({Running:false,ExitCode:0})};
    starts++;seen=o.Cmd;
    const code="console.log(JSON.stringify({freigabe:'SYNAPSE_SHELL_DB_FREIGABE' in process.env,pg:Object.keys(process.env).some(k=>/^PG/.test(k)),live:Object.values(process.env).includes(process.argv[1])}))";
    const cmd=o.Cmd.slice(0,-1);cmd.push('node -e '+quote(code)+' '+quote(live));
    const child=spawnSync(cmd[0],cmd.slice(1),{env:{PATH:process.env.PATH,DATABASE_URL:live,PGPASSWORD:'synthetic'},encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    return {start:async()=>Readable.from([Buffer.from(child.stdout)]),inspect:async()=>({Running:false,ExitCode:0})};
   }};
  const w=new WorkspaceOrchestrator();w.dockerAvailable=true;w.ensureProjectRunning=async()=>'test';
  w.recordActivity=async()=>{};w.appendToLog=async()=>{};
  w.lageProbeImContainer=async(_c,input,cwd)=>({...await probe({HOME:'/home/synthetic',PWD:cwd})({...input,cwd:input.cwd??cwd}),prozesse:{pids:[],namen:[]}});
  w.docker={getContainer:()=>container,modem:{demuxStream:(s,out,err)=>{s.pipe(out);err.end();}}};
  const query=async sql=>({rows:String(sql).includes(' AS katalog')?[{katalog:catalog}]:String(sql).includes('INSERT INTO shell_jobs')?[{id:'11111111-1111-4111-8111-111111111111'}]:[],rowCount:0});
  const pool={query,connect:async()=>({query,release(){}})};
  vergissJobUmgebungCache(project);
  const r=await mitLesePool(pool,()=>w.exec(project,c,{agent_id:'sol-5'}));
  assert.equal(starts,1,JSON.stringify(r));assert.equal(r.exitCode,0,r.stderr);
  assert.deepEqual(seen.slice(0,2),['/usr/bin/env','-i']);
  assert.equal(seen.some(x=>x.startsWith('SYNAPSE_SHELL_DB_FREIGABE=')),false);
  const child=JSON.parse(r.stdout);assert.equal(child.freigabe,false);assert.equal(child.pg,false);assert.equal(child.live,false);
 }finally{
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
  Object.assign(process.env,saved);vergissJobUmgebungCache(project);
 }
});
// P10-T71 c): Workspace-eigene DB-Container (auch zusaetzlich angelegte) sind kein unbekanntes, gesperrtes Ziel.
test('Workspace-eigene Test-DB (Container auf 5432, andere DB) laeuft ohne Sperre und ohne Rueckfrage',async()=>{
 const ws='postgresql://postgres:synthetic@synapse-ws-demo-db:5432/kommunikation_test';
 const prodProof={...proof,live:{host:'192.168.50.65',port:'5432',datenbank:'synapse',user:'synapse'}};
 const c="psql '"+ws+"' -c 'CREATE TABLE kommunikation(x int)'";
 const l=await lage(c,prodProof,{DATABASE_URL:ws});
 assert.notEqual(l.datenbank_live,true);
 const {first}=decide(c,l);assert.equal(first.darf_starten,true,JSON.stringify(first.antwort?.risiko));
 assert.notEqual(first.audit.stufe,'sperre');
});
