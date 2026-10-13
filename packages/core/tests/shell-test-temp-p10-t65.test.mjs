/** t84: ausschließlich Faktenprüfung; keine gespeicherte Team-Testquelle wird ausgeführt. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {skriptFakten} from '../dist/services/shell-inline-pruefung.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../dist/services/shell-sicherung-seed.js';
const root='/home/blacky/dev/synapse',project='p10_t84_fixture',file='packages/core/tests/temp-proof.test.mjs';
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/shell-test-temp-p10-t65.json',import.meta.url),'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const target={host:'test.invalid',port:'5433',datenbank:'synapse_test',user:'tester'};
const proof={project,ziele:[{...target,art:'test'}],live:{host:'live.invalid',port:'6123',datenbank:'system',user:'system'}};
async function decide(text,{source=file,helpers=[],outside=false,inline=false}={}){
 const full=root+'/'+source,command=inline?'node -e '+JSON.stringify(text):'node '+source;
 const probe=async input=>({cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:outside&&p===root+'/coedit-test'?'/outside/coedit':p,existiert:true,links:[]})),
  ...(input.testdatei===full?{testdatei:{pfad:full,kanonisch:full,text,sha256:hash(text),tmpdir:'/tmp',helfer:helpers.map(h=>({pfad:root+'/'+h.file,text:h.text,sha256:h.sha256??hash(h.text)}))}}:{})});
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',env:{DATABASE_URL:'postgresql://tester:synthetic@test.invalid:5433/synapse_test'},env_vollstaendig:true,inspect:true,probe,datenbank_freigabe:proof});
 const r=pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
 const fs=skriptFakten(text,'node',{cwd:root,projekt_root:root,os:'linux',testdatei_pfad:full,test_tmpdir:'/tmp',inline_pfade:lage.inline_pfade,testhelfer:helpers.map(h=>({pfad:root+'/'+h.file,text:h.text,sha256:h.sha256??hash(h.text)}))}).filter(k=>/^fs\./.test(k.skript_operation?.name??'')).map(k=>k.skript_operation);
 return {r,lage,fs};
}
for(const f of fixtures)test('Historischer Quellstand '+f.job.slice(0,8)+' wird begrenzt freigegeben',async()=>{
 assert.equal(hash(f.text),f.sha256);
 for(const h of f.helpers??[])assert.equal(hash(h.text),h.sha256);
 const {r,fs}=await decide(f.text,{source:f.file,helpers:f.helpers});
 assert.equal(r.darf_starten,true,JSON.stringify({risiko:r.antwort?.risiko,fs}));
});
test('A12 tmpdir-Variante ist frei',async()=>{
 const f=fixtures[0],text=f.text.replace("import {dirname,join} from 'node:path';","import {dirname,join} from 'node:path';import {tmpdir} from 'node:os';").replace("mkdtemp(join(here,'fixtures','a12-runtime-'))","mkdtemp(join(tmpdir(),'synapse-a12-'))");
 assert.equal((await decide(text,{source:f.file})).r.darf_starten,true);
});
const imports="import{mkdtemp,rm,writeFile,rename}from'node:fs/promises';import{join,resolve,dirname}from'node:path';import{tmpdir}from'node:os';";
const made="const root=await mkdtemp(join(tmpdir(),'owned-fixture-'));";
for(const text of [
 imports+made+"await writeFile(join(root,'x.json'),'{}');await rm(root,{recursive:true})",
 imports+"const root=await mkdtemp(join('/home/blacky/dev/synapse/packages/core/tests/fixtures','owned-fixture-'));await rm(root,{recursive:true})",
 imports+"const root=await mkdtemp(join('/home/blacky/dev/synapse/coedit-test','owned-fixture-'));await writeFile(join(root,'config.json'),'{}');await rm(root,{recursive:true})",
 imports+made+"const child=join(root,'dir','x');await writeFile(child,'a');await rename(child,join(root,'new'));await rm(dirname(child),{recursive:true})",
 imports+"await writeFile('/home/blacky/dev/synapse/coedit-test/owned/config.json','{}')",
 imports+made+"const save=x=>writeFile(join(root,x),'a');save('nested/file.json')"
])test('Nachgewiesener eigener Testpfad bleibt frei',async()=>assert.equal((await decide(text)).r.darf_starten,true));
for(const [name,text,options] of [
 ['außerhalb',imports+"await rm('/outside',{recursive:true})",{}],
 ['Quellcode',imports+"await writeFile('/home/blacky/dev/synapse/packages/core/src/index.ts','changed')",{}],
 ['tmp ohne mkdtemp',imports+"await rm(join(tmpdir(),'foreign'),{recursive:true})",{}],
 ['fremder Prefix',imports+"const root=await mkdtemp('/outside/owned-fixture-');await rm(root,{recursive:true})",{}],
 ['Prefix fehlt',imports+"const root=await mkdtemp(tmpdir());await rm(root,{recursive:true})",{}],
 ['Traversal',imports+made+"await rm(join(root,'..','foreign'),{recursive:true})",{}],
 ['Sibling',imports+made+"await rm(root+'.old',{recursive:true})",{}],
 ['unklare Teilpfade',imports+made+"await writeFile(join(root,process.env.PATH),'x')",{}],
 ['root neu zugewiesen',imports+"let root=await mkdtemp(join(tmpdir(),'owned-fixture-'));root='/outside';await rm(root,{recursive:true})",{}],
 ['Importalias geändert',imports+"mkdtemp=other;"+made+"await rm(root,{recursive:true})",{}],
 ['TMPDIR geändert',imports+"process.env.TMPDIR='/outside';"+made+"await rm(root,{recursive:true})",{}],
 ['Rename raus',imports+made+"await rename(join(root,'x'),'/outside/x')",{}],
 ['coedit root komplett',imports+"await rm('/home/blacky/dev/synapse/coedit-test',{recursive:true})",{}],
 ['coedit symlink raus',imports+"await rm('/home/blacky/dev/synapse/coedit-test/owned',{recursive:true})",{outside:true}],
 ['Nicht-Testdatei',imports+made+"await rm(root,{recursive:true})",{source:'packages/core/src/probe.mjs'}],
 ['Inline statt Testdatei',imports+made+"await rm(root,{recursive:true})",{inline:true}],
])test(name+' bleibt Anleitung',async()=>assert.equal((await decide(text,options)).r.darf_starten,false));
test('Script-Testpfad ist dieselbe begrenzte Ausnahme',async()=>{
 assert.equal((await decide(imports+made+"await rm(root,{recursive:true})",{source:'scripts/test-temp.mjs'})).r.darf_starten,true);
});
test('Beliebiger Helfername ist kein Besitznachweis',async()=>{
 const text="import{createTestFixtureCleanup}from'./_helfer/fake.mjs';const cleanup=createTestFixtureCleanup();const root=await cleanup.createRoot('owned-fixture-');import{rm}from'node:fs/promises';await rm(root,{recursive:true})";
 const h={file:'packages/core/tests/_helfer/fake.mjs',text:"export function createTestFixtureCleanup(){return{createRoot:async()=>'/outside'}}"};
 assert.equal((await decide(text,{helpers:[h]})).r.darf_starten,false);
});
test('Helfer außerhalb Testpfad oder Factory-Override gewährt keine Ausnahme',async()=>{
 const h=fixtures[1].helpers[0];
 const source=fixtures[1].text.replace("createTestFixtureCleanup()","createTestFixtureCleanup({rootDirectory:'/outside'})");
 assert.equal((await decide(source,{source:fixtures[1].file,helpers:[h]})).r.darf_starten,false);
});

test('TMP-Änderung in später deklarierter, vorher aufgerufener Funktion bleibt gesperrt',async()=>{
 const text=imports+"change();"+made+"await writeFile(join(root,'x'),'a');function change(){process.env.TMPDIR='/outside'}";
 assert.equal((await decide(text)).r.darf_starten,false);
});
test('Umgebungs-Restore nach finalem Root-Cleanup ist keine Änderung der Inspektionswurzel',async()=>{
 const text=imports+"try{"+made+"await rm(root,{recursive:true});}finally{process.env.TMPDIR='/restore'}";
 assert.equal((await decide(text)).r.darf_starten,false,'anderes finally enthält nicht die letzte FS-Operation');
 const proper=imports+made+"try{await writeFile(join(root,'x'),'a');}finally{await rm(root,{recursive:true});for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,saved);}";
 assert.equal((await decide(proper)).r.darf_starten,true);
});
test('Unbekannte Object.assign-Env und CWD-Wechsel bleiben gesperrt',async()=>{
 for(const text of [imports+"Object.assign(process.env,settings);"+made+"await rm(root,{recursive:true})",imports+"process.chdir('/outside');"+made+"await rm(root,{recursive:true})"])
  assert.equal((await decide(text)).r.darf_starten,false);
});
test('Symlink im Test gewährt keine spätere Schreibausnahme',async()=>{
 const text=imports+"import{symlink as ln}from'node:fs/promises';"+made+"await ln('/outside',join(root,'link'));await writeFile(join(root,'link','x'),'a')";
 assert.equal((await decide(text)).r.darf_starten,false);
});
test('Native Probe liest und bindet nur Test-Helfer; kompiliertes Standalone-Programm funktioniert',async()=>{
 const {probeShellLage,shellLageProbeProgramm}=await import('../dist/services/shell-lage-probe.js');
 const {spawnSync}=await import('node:child_process');
 const {tmpdir}=await import('node:os');
 const source='packages/core/tests/fixtures/shell-test-temp-native-p10-t65.mjs';
 const input={cwd:root,projekt_root:root,testdatei:root+'/'+source};
 const direct=await probeShellLage(input);
 assert.equal(direct.testdatei.tmpdir,tmpdir());
 assert.equal(direct.testdatei.helfer.length,1);
 assert.match(direct.testdatei.helfer[0].pfad,/tests\/_helfer\/test-fixture-cleanup\.mjs$/);
 assert.equal(hash(direct.testdatei.helfer[0].text),direct.testdatei.helfer[0].sha256);
 const child=spawnSync(process.execPath,['-e',shellLageProbeProgramm(),JSON.stringify(input)],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 const embedded=JSON.parse(child.stdout);
 assert.deepEqual(embedded.testdatei,direct.testdatei);
 const command='node '+source;
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,env:{},env_vollstaendig:true});
 assert.ok(lage.kommandos[0].inline_skript.testhelfer.length);
 assert.equal(pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED).darf_starten,true);
});

test('Gleichnamige Helper-Bindings in fremdem Scope beweisen keine eigene Wurzel',async()=>{
 const helper={file:'packages/core/tests/_helfer/shadow.mjs',text:
  "import{mkdtemp}from'node:fs/promises';import{join}from'node:path';export function make(){const rootBase='/outside';const createRoot=async prefix=>{const root=await mkdtemp(join(rootBase,prefix));return root;};function unrelated(){const rootBase='/home/blacky/dev/synapse/coedit-test';}return{createRoot};}"};
 const source="import{make}from'./_helfer/shadow.mjs';import{rm}from'node:fs/promises';const factory=make();const root=await factory.createRoot('owned-fixture-');await rm(root,{recursive:true});";
 assert.equal((await decide(source,{helpers:[helper]})).r.darf_starten,false);
});
