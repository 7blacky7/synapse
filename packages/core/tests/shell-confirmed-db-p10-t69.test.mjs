/** P10-T69: bestätigte Jobs erhalten nur nachgewiesene private Test-DB-Metadaten. */
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
test('Bekannte Test-DB trotz Kette: vor Bestätigung abgewiesen, danach Metadaten',async()=>{
 const l=await lage(),{first,confirmed}=decide(command,l);
 assert.equal(first.darf_starten,false);assert.equal(l.datenbank_zuordnung,undefined);
 assert(l.datenbank_testzuordnung,JSON.stringify(l));
 assert.equal(privateShellTestDbFreigabe(l,proof,first),undefined);
 assert.equal(confirmed.darf_starten,true);assert.equal(confirmed.audit.entscheidung,'bestaetigt');
 assert.deepEqual(JSON.parse(privateShellTestDbFreigabe(l,proof,confirmed)),proof);
});
test('Rollenbindung, Drift und kurze Begründung erlauben keine Metadaten',async()=>{
 const l=await lage();
 for(const [who,changes]of [['sol-5',{}],['user',{}],['koordinator',{lage_hash:'drift'}],['koordinator',{befehl_hash:'drift'}],['koordinator',{regelversion:'drift'}],['koordinator',{grund:'kurz'}]]){
  const {confirmed}=decide(command,l,who,changes);
  assert.equal(confirmed.darf_starten,false);assert.equal(privateShellTestDbFreigabe(l,proof,confirmed),undefined);
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
test('Geprüfte Envdatei kann Testidentität für bestätigte Kette liefern',async()=>{
 const c=". /tmp/test.env; "+command,l=await lage(c,proof,{});
 const {first,confirmed}=decide(c,l);assert.equal(first.darf_starten,false);
 assert.equal(confirmed.darf_starten,true);
 assert.deepEqual(JSON.parse(privateShellTestDbFreigabe(l,proof,confirmed)),proof);
});
test('Altstand-Golden: erlaubte Lage, Hash und Startantwort bytegleich t88',async()=>{
 const base=process.env.P10_T69_GOLDEN_BASE??'/tmp/synapse-basis-e502866';
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
  assert.deepEqual(stable(now),stable(previous));
  if(after.datenbank_zuordnung)assert.equal(privateShellTestDbFreigabe(after,proof,now),JSON.stringify(proof));
 }
});
test('D1 verwendet vor jeder Nutzabfrage den privaten Sollwert; Drift bleibt gesperrt',async()=>{
 const l=await lage(),{confirmed}=decide(command,l);
 const metadata=JSON.parse(privateShellTestDbFreigabe(l,proof,confirmed)),calls=[];
 let system=proof.test_system_id;
 const client={async connect(){},async end(){},async query(text){
  calls.push(text);return {rows:text.includes('pg_control_system')?[{datenbank:'synapse_test',system_id:system,user:'tester'}]:[{ok:1}]};
 }};
 const db=await oeffneGeschuetzteTestDb(own,metadata,()=>client);
 await db.query('SELECT 1');assert.equal(calls.length,2);assert.match(calls[0],/pg_control_system/);
 system='987654321';await assert.rejects(()=>db.query('SELECT 2'),/laufzeit_ziel_abweichend/);
 assert.equal(calls.includes('SELECT 2'),false);await db.end();
});
test('Workspace: akzeptierte Bestätigung erreicht echten env-i Kindprozess; Live/PG fehlen',async()=>{
 const saved={...process.env};let starts=0,seen;
 try{
  process.env.SYNAPSE_DATABASE_URL=live;process.env.SYNAPSE_TEST_DATABASE_URL=own;process.env.SYNAPSE_TEST_DATABASE_SYSTEM_ID=proof.test_system_id;
  const c=". /tmp/test.env; "+command;
  const container={inspect:async()=>({Config:{Env:['DATABASE_URL='+live,'PGPASSWORD=synthetic']}}),
   exec:async o=>{
    if(o.User==='0')return {start:async()=>Readable.from([]),inspect:async()=>({Running:false,ExitCode:0})};
    starts++;seen=o.Cmd;
    const code="console.log(JSON.stringify({proof:JSON.parse(process.env.SYNAPSE_SHELL_DB_FREIGABE),pg:Object.keys(process.env).some(k=>/^PG/.test(k)),live:Object.values(process.env).includes(process.argv[1])}))";
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
  const rejected=await mitLesePool(pool,()=>w.exec(project,c,{agent_id:'sol-5'}));
  assert.equal(starts,0);assert.equal(rejected.status,'rejected');assert(rejected.bestaetigungsdaten);
  const r=await mitLesePool(pool,()=>w.exec(project,c,{agent_id:'koordinator',bestaetigt:{grund:'P10-T69 isolierter Workspace-Test',...rejected.bestaetigungsdaten}}));
  assert.equal(starts,1,JSON.stringify(r));assert.equal(r.exitCode,0,r.stderr);
  assert.deepEqual(seen.slice(0,2),['/usr/bin/env','-i']);
  assert(seen.some(x=>x.startsWith('SYNAPSE_SHELL_DB_FREIGABE=')));
  const child=JSON.parse(r.stdout);assert.deepEqual(child.proof,proof);assert.equal(child.pg,false);assert.equal(child.live,false);
 }finally{
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
  Object.assign(process.env,saved);vergissJobUmgebungCache(project);
 }
});
