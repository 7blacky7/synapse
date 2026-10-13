/** T68: reine Guard-/Transporttests, keine synthetische Quelle wird ausgeführt, kein SQL. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import tar from 'tar-stream';
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
test('Nur native Workspace-Testdatei erhält Datei-Ausnahme',async()=>{
 const positive=await decision(writer,{workspace:true});
 assert.equal(positive.result.darf_starten,true,JSON.stringify(positive));
 for(const options of [{},{startWorkspace:true},{workspace:true,startWorkspace:false},{workspace:true,path:'packages/core/src/product.mjs'},
  {workspace:true,canonical:'/outside/test.mjs'}])assert.equal((await decision(writer,options)).result.darf_starten,false);
 assert.equal((await decision(writer,{workspace:true,path:'scripts/test-write.mjs'})).result.darf_starten,true);
});
test('DB und Prozessregeln bleiben im Workspace wirksam',async()=>{
 for(const text of [
  "import{exec}from'node:child_process';exec(process.env.UNKNOWN);",
  "import pg from'pg';const db=new pg.Client({connectionString:'postgresql://user:pw@live.invalid:6123/system'});await db.query('DROP TABLE outside');",
 ])assert.equal((await decision(text,{workspace:true})).result.darf_starten,false);
});
test('Root-Lockfile wird transportiert, bleibt verborgen; abhängige/geschützte Pfade gesperrt',()=>{
 assert.equal(istGesperrt('pnpm-lock.yaml','/no-fs-needed','p10_t68'),false);
 assert.equal(shouldIgnore(createDefaultIgnore(),'pnpm-lock.yaml'),true);
 assert.equal(istWorkspaceIgnoriert('pnpm-lock.yaml'),false);
 for(const p of ['node_modules/pnpm-lock.yaml','.git/pnpm-lock.yaml','.synapse/pnpm-lock.yaml','.env','.env.test'])
  assert.equal(istWorkspaceIgnoriert(p),true,p);
});
test('Nur identische private Test-DB-Konfiguration kommt ins Systemprojekt',()=>{
 const uri='postgresql://tester:synthetic@test.invalid:5433/synapse_test';
 const target={host:'test.invalid',port:'5433',datenbank:'synapse_test',user:'tester'};
 const proof={project:'synapse',live:{host:'live.invalid',port:'6123',datenbank:'system',user:'system'},ziele:[{...target,art:'test'}]};
 assert.equal(workspaceJobDatenbank('synapse',{},proof,{SYNAPSE_TEST_DATABASE_URL:uri}).DATABASE_URL,uri);
 for(const env of [{},{SYNAPSE_TEST_DATABASE_URL:uri.replace('5433','6123')},{SYNAPSE_TEST_DATABASE_URL:uri.replace('synapse_test','system')},
  {SYNAPSE_TEST_DATABASE_URL:uri+'?host=live.invalid'}])
  assert.equal(workspaceJobDatenbank('synapse',{DATABASE_URL:'postgresql://system:secret@live.invalid:6123/system'},proof,env).DATABASE_URL,undefined);
 assert.equal(workspaceJobDatenbank('synapse',{}, {...proof,ziele:[]},{SYNAPSE_TEST_DATABASE_URL:uri}).DATABASE_URL,undefined);
 const own={DATABASE_URL:'registry-project-value'};
 assert.deepEqual(workspaceJobDatenbank('other',own,{...proof,project:'other'},{SYNAPSE_TEST_DATABASE_URL:uri}),own);
});
test('Quellschutz überträgt feste Root-Metadaten statt einen Nutzerpfad',async()=>{
 const headers=[];
 await schuetzeWorkspaceWurzel({putArchive:async stream=>{
  const extract=tar.extract();
  extract.on('entry',(header,entry,next)=>{headers.push(header);entry.resume();entry.on('end',next);});
  await new Promise((resolve,reject)=>{extract.on('finish',resolve);extract.on('error',reject);stream.pipe(extract);});
 }});
 assert.equal(headers.length,1);assert.equal(headers[0].name,'.');assert.equal(headers[0].type,'directory');
 assert.equal(headers[0].uid,0);assert.equal(headers[0].gid,0);assert.equal(headers[0].mode&0o777,0o755);
});
