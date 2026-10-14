/** T68: reine Guard-/Transporttests, keine synthetische Quelle wird ausgeführt, kein SQL. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {ermittleShellLage} from '../../core/dist/services/shell-lage.js';
import {pruefeShellStart} from '../../core/dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../../core/dist/services/shell-sicherung-seed.js';
import {istGesperrt,createDefaultIgnore,shouldIgnore} from '../../core/dist/watcher/ignore.js';
import {istWorkspaceIgnoriert} from '../dist/services/workspace-orchestrator.js';
import {workspaceJobDatenbank} from '../dist/services/workspace-job-db.js';
import {schuetzeWorkspaceWurzel} from '../dist/services/workspace-quellschutz.js';
const project='p10_t68',root='/workspace',file='packages/core/tests/write.test.mjs';
async function decision(text,{workspace=false,path=file,canonical=root+'/'+path,startWorkspace=workspace,env={},proof}={}){
 const full=root+'/'+path,command='node '+path;
 const probe=async input=>({cwd:root,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),
  ...(input.testdatei===full?{testdatei:{pfad:full,kanonisch:canonical,text,sha256:createHash('sha256').update(text).digest('hex')}}:{})});
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',env,env_vollstaendig:true,probe,
  workspace_testdateien:workspace,datenbank_freigabe:proof});
 return {lage,result:pruefeShellStart({project,command,lage,workspace_testdateien:startWorkspace,agent_id:'sol-2'},SHELL_SICHERUNG_SEED)};
}
const writer="import{rm,writeFile}from'node:fs/promises';await writeFile('/tmp/owned/x','a');await rm('/tmp/owned',{recursive:true});";
// P10-T71: ausser der Prod-DB-Sperre nur Warnhinweise. Frueher darf_starten:false heisst jetzt: nicht stilles 'laeuft'.
const frei=r=>r.darf_starten===true&&r.audit.stufe==='laeuft'&&!r.hinweis;
test('Nur native Workspace-Testdatei erhält Datei-Ausnahme',async()=>{
 const positive=await decision(writer,{workspace:true});
 assert.equal(positive.result.darf_starten,true,JSON.stringify(positive));
 for(const options of [{},{startWorkspace:true},{workspace:true,startWorkspace:false},{workspace:true,path:'packages/core/src/product.mjs'},
  {workspace:true,canonical:'/outside/test.mjs'}])assert.equal(frei((await decision(writer,options)).result),false);
 assert.equal((await decision(writer,{workspace:true,path:'scripts/test-write.mjs'})).result.darf_starten,true);
});
test('DB und Prozessregeln bleiben im Workspace wirksam (Hinweis)',async()=>{
 for(const text of [
  "import{exec}from'node:child_process';exec(process.env.UNKNOWN);",
  "import pg from'pg';const db=new pg.Client({connectionString:'postgresql://user:pw@live.invalid:6123/system'});await db.query('DROP TABLE outside');",
 ])assert.equal(frei((await decision(text,{workspace:true})).result),false);
});
test('Root-Lockfile wird transportiert, bleibt verborgen; abhängige/geschützte Pfade gesperrt',()=>{
 assert.equal(istGesperrt('pnpm-lock.yaml','/no-fs-needed','p10_t68'),false);
 assert.equal(shouldIgnore(createDefaultIgnore(),'pnpm-lock.yaml'),true);
 assert.equal(istWorkspaceIgnoriert('pnpm-lock.yaml'),false);
 for(const p of ['node_modules/pnpm-lock.yaml','.git/pnpm-lock.yaml','.synapse/pnpm-lock.yaml','.env','.env.test'])
  assert.equal(istWorkspaceIgnoriert(p),true,p);
});
// P10-T72: kein Sonderfall fuer synapse mehr; nur die registrierte Projekt-DB (art 'projekt') bleibt, fuer jedes Projekt.
test('Workspace: nur registrierte Projekt-DB, kein Test-DB-Fallback, kein Projekt-Sonderfall',()=>{
 const uri='postgresql://tester:synthetic@test.invalid:5433/synapse_test';
 const target={host:'test.invalid',port:'5433',datenbank:'synapse_test',user:'tester'};
 const live={host:'live.invalid',port:'6123',datenbank:'system',user:'system'};
 for(const p of ['synapse','other']){
  const proof={project:p,live,ziele:[{...target,art:'projekt'}]};
  assert.equal(workspaceJobDatenbank(p,{DATABASE_URL:uri},proof,{}).DATABASE_URL,uri,p+' registriert');
  // Eine Test-DSN aus der Serverkonfiguration ist keine Projektfreigabe (frueher nur fuer synapse).
  assert.equal(workspaceJobDatenbank(p,{},{...proof,ziele:[{...target,art:'test'}]},{SYNAPSE_TEST_DATABASE_URL:uri}).DATABASE_URL,undefined,p+' kein Test-Fallback');
  assert.equal(workspaceJobDatenbank(p,{DATABASE_URL:uri},{...proof,ziele:[{...target,art:'test'}]},{}).DATABASE_URL,undefined,p+' test ist nicht projekt');
  for(const env of [{DATABASE_URL:'postgresql://system:secret@live.invalid:6123/system'},{DATABASE_URL:uri.replace('5433','6123')},
   {DATABASE_URL:uri.replace('synapse_test','system')},{DATABASE_URL:uri+'?host=live.invalid'},{DATABASE_URL:'registry-project-value'}])
   assert.equal(workspaceJobDatenbank(p,env,proof,{}).DATABASE_URL,undefined,p+' '+env.DATABASE_URL);
  assert.equal(workspaceJobDatenbank(p,{DATABASE_URL:uri},{...proof,project:'fremd'},{}).DATABASE_URL,undefined,p+' fremde Freigabe');
  assert.equal(workspaceJobDatenbank(p,{DATABASE_URL:uri},{...proof,ziele:[]},{}).DATABASE_URL,undefined,p+' ohne Ziel');
  assert.equal(workspaceJobDatenbank(p,{DATABASE_URL:uri},{project:p,ziele:[{...target,art:'projekt'}]},{}).DATABASE_URL,undefined,p+' ohne Systemgrenze');
 }
});
test('Quellschutz nutzt festen Root-Exec und prüft dessen Erfolg',async()=>{
 let seen;
 const container=exit=>({exec:async opts=>{seen=opts;return{start:async()=>Readable.from([]),inspect:async()=>({ExitCode:exit})};}});
 await schuetzeWorkspaceWurzel(container(0));
 assert.equal(seen.User,'0');assert.deepEqual(seen.Cmd.slice(0,2),['/bin/sh','-ec']);
 assert.ok(seen.Cmd[2].includes('/bin/chown 1000:1000 /workspace'));
 assert.ok(seen.Cmd[2].includes('/bin/chmod 0755 /workspace'));
 assert.ok(seen.Cmd[2].includes('/bin/stat -c %u:%g:%a /workspace'));
 assert.ok(seen.Cmd[2].includes('"1000:1000:755"'));
 for(const exit of [1,null])await assert.rejects(()=>schuetzeWorkspaceWurzel(container(exit)),/workspace_quellen_helfer_fehlgeschlagen/);
});
