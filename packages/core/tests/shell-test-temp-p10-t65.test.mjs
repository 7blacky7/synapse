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
async function decide(text,{source=file,helpers=[],outside=false,inline=false,canonical=p=>p}={}){
 const full=root+'/'+source,command=inline?'node -e '+JSON.stringify(text):'node '+source;
 const probe=async input=>({cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:outside&&p===root+'/coedit-test'?'/outside/coedit':canonical(p),existiert:true,links:[]})),
  ...(input.testdatei===full?{testdatei:{pfad:full,kanonisch:full,text,sha256:hash(text),tmpdir:'/tmp',helfer:helpers.map(h=>({pfad:root+'/'+h.file,text:h.text,sha256:h.sha256??hash(h.text)}))}}:{})});
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',env:{DATABASE_URL:'postgresql://tester:synthetic@test.invalid:5433/synapse_test'},env_vollstaendig:true,inspect:true,probe,datenbank_freigabe:proof});
 const r=pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
 const fs=skriptFakten(text,'node',{cwd:root,projekt_root:root,os:'linux',testdatei_pfad:full,test_tmpdir:'/tmp',inline_pfade:lage.inline_pfade,testhelfer:helpers.map(h=>({pfad:root+'/'+h.file,text:h.text,sha256:h.sha256??hash(h.text)}))}).filter(k=>/^fs\./.test(k.skript_operation?.name??'')).map(k=>k.skript_operation);
 return {r,lage,fs};
}
for(const f of fixtures)test('Historischer Quellstand '+f.job.slice(0,8)+(f.job.startsWith('7364031f')?' wird begrenzt freigegeben':' bleibt Anleitung'),async()=>{
 assert.equal(hash(f.text),f.sha256);
 for(const h of f.helpers??[])assert.equal(hash(h.text),h.sha256);
 const {r,fs}=await decide(f.text,{source:f.file,helpers:f.helpers});
 assert.equal(r.darf_starten,f.job.startsWith('7364031f'),JSON.stringify({risiko:r.antwort?.risiko,fs}));
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
 imports+made+"const child=join(root,'dir','x');await writeFile(child,'a');await rename(child,join(root,'new'));await rm(dirname(child),{recursive:true})",
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
test('Native Probe bindet direkte Testdatei ohne Helfer-Snapshots; Standalone funktioniert',async()=>{
 const {probeShellLage,shellLageProbeProgramm}=await import('../dist/services/shell-lage-probe.js');
 const {spawnSync}=await import('node:child_process');
 const {tmpdir}=await import('node:os');
 const source='packages/core/tests/fixtures/shell-test-temp-native-p10-t65.mjs';
 const input={cwd:root,projekt_root:root,testdatei:root+'/'+source};
 const direct=await probeShellLage(input);
 assert.equal(direct.testdatei.tmpdir,await(await import('node:fs/promises')).realpath(tmpdir()));
 assert.equal(hash(direct.testdatei.text),direct.testdatei.sha256);
 assert.match(direct.testdatei.text,/mkdtemp/);
 assert.equal(Object.hasOwn(direct.testdatei,'helfer'),false);
 const child=spawnSync(process.execPath,['-e',shellLageProbeProgramm(),JSON.stringify(input)],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 const embedded=JSON.parse(child.stdout);
 assert.deepEqual(embedded.testdatei,direct.testdatei);
 const command='node '+source;
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,env:{},env_vollstaendig:true});
 assert.equal(Object.hasOwn(lage.kommandos[0].inline_skript,'testhelfer'),false);
 assert.equal(pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED).darf_starten,true);
});

test('Gleichnamige Helper-Bindings in fremdem Scope beweisen keine eigene Wurzel',async()=>{
 const helper={file:'packages/core/tests/_helfer/shadow.mjs',text:
  "import{mkdtemp}from'node:fs/promises';import{join}from'node:path';export function make(){const rootBase='/outside';const createRoot=async prefix=>{const root=await mkdtemp(join(rootBase,prefix));return root;};function unrelated(){const rootBase='/home/blacky/dev/synapse/coedit-test';}return{createRoot};}"};
 const source="import{make}from'./_helfer/shadow.mjs';import{rm}from'node:fs/promises';const factory=make();const root=await factory.createRoot('owned-fixture-');await rm(root,{recursive:true});";
 assert.equal((await decide(source,{helpers:[helper]})).r.darf_starten,false);
});

const helperSource=effect=>"import{mkdtemp,rm,writeFile,mkdir,rename}from'node:fs/promises';import{join}from'node:path';export function createFixture(){const base=join(process.cwd(),'coedit-test');const createRoot=async prefix=>{"+effect+"const created=await mkdtemp(join(base,prefix));return created;};return{createRoot};}";
const helperCaller="import{createFixture}from'./fixtures/pruefer1-helper.mjs';import{rm}from'node:fs/promises';const fixture=createFixture();const created=await fixture.createRoot('pruefer1-owned-');await rm(created,{recursive:true});";
for(const [label,effect] of [
 ['B1 Außenwrite',"await writeFile('/outside/pruefer1-counterexample','x');"],
 ['B2 Außenrm',"await rm('/outside/pruefer1-counterexample',{recursive:true});"],
 ['indirekter Außenwrite',"const hidden=()=>writeFile('/outside/pruefer1-counterexample','x');await hidden();"],
 ['dynamisches Ziel',"await rm(process.env.DEST,{recursive:true});"],
 ['Link im Helper',"await symlink('/outside',join(base,'linked'));"],
])test('NOGO: Helper '+label+' bleibt Anleitung',async()=>{
 const helpers=[{file:'packages/core/tests/fixtures/pruefer1-helper.mjs',text:helperSource(effect)}];
 assert.equal((await decide(helperCaller,{helpers})).r.darf_starten,false);
});
test('Auch reine importierte Test-Helfer bleiben Anleitung',async()=>{
 assert.equal((await decide(helperCaller,{helpers:[{file:'packages/core/tests/fixtures/pruefer1-helper.mjs',text:helperSource('')}]})).r.darf_starten,false);
});
for(const base of [root+'/coedit-test/nested',root+'/packages/core/tests/fixtures/nested','/tmp/nested'])test('NOGO: konkreter Prefix über Symlink '+base+' bleibt Anleitung',async()=>{
 const text=imports+"const own=await mkdtemp(join("+JSON.stringify(base)+",'pruefer1-owned-'));await rm(own,{recursive:true});";
 const canonical=p=>p===base||p.startsWith(base+'/')?'/outside/nested'+p.slice(base.length):p;
 const {r,lage}=await decide(text,{canonical});
 assert.equal(r.darf_starten,false,JSON.stringify(lage.inline_pfade));
});
test('NOGO: nativer Eltern-Symlink wird aufgelöst und blockiert',async()=>{
 const fs=await import('node:fs/promises'),p=await import('node:path'),os=await import('node:os');
 const {probeShellLage}=await import('../dist/services/shell-lage-probe.js');
 const own=await fs.mkdtemp(p.join(root,'packages/core/tests/fixtures','t84-symlink-'));
 const external=await fs.mkdtemp(p.join(os.tmpdir(),'t84-external-'));
 try{
  const linked=p.join(own,'nested');await fs.symlink(external,linked);
  const source=imports+"const own=await mkdtemp("+JSON.stringify(p.join(linked,'pruefer1-owned-'))+");await rm(own,{recursive:true});";
  const full=root+'/'+file;
  const probe=async input=>input.testdatei?{cwd:root,os:'linux',env:{},pfade:[],testdatei:{pfad:full,kanonisch:full,text:source,sha256:hash(source),tmpdir:os.tmpdir()}}:probeShellLage(input);
  const command='node '+file;
  const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,probe,env:{},env_vollstaendig:true});
  assert.equal(pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED).darf_starten,false);
 }finally{await fs.rm(own,{recursive:true,force:true});await fs.rm(external,{recursive:true,force:true});}
});

test('Ungeklärter Helfer blockiert auch ohne anschließende Caller-FS-Operation',async()=>{
 const helpers=[{file:'packages/core/tests/fixtures/pruefer1-helper.mjs',text:helperSource("await writeFile('/outside/pruefer1-counterexample','x');")}];
 assert.equal((await decide(helperCaller.replace("await rm(created,{recursive:true});",""),{helpers})).r.darf_starten,false);
});
test('Factory-/Modulinitialisierung mit Außenwrite ist keine reine Factory',async()=>{
 for(const source of [
  helperSource('').replace("const base=","writeFile('/outside/factory','x');const base="),
  helperSource('')+"await writeFile('/outside/module','x');",
 ])assert.equal((await decide(helperCaller,{helpers:[{file:'packages/core/tests/fixtures/pruefer1-helper.mjs',text:source}]})).r.darf_starten,false);
});

test('Fehlender oder negativer nativer Prefix-Nachweis gewährt keine Provenanz',()=>{
 for(const inline_pfade of [undefined,{}, {[root+'/coedit-test']:true,[root+'/coedit-test/owned-fixture-']:false}]){
  const source=imports+"const created=await mkdtemp(join("+JSON.stringify(root+'/coedit-test')+",'owned-fixture-'));await rm(created,{recursive:true});";
  const fs=skriptFakten(source,'node',{cwd:root,projekt_root:root,os:'linux',testdatei_pfad:root+'/'+file,test_tmpdir:'/tmp',inline_pfade}).filter(k=>k.skript_operation?.name==='fs.promises.rm');
  assert.equal(fs.length,1);assert.equal(fs[0].skript_operation.ziel_im_projekt,false);
 }
});
test('Helfer-Override, unzulässiger Prefix und ungeprüfte Methode blockieren ohne Caller-Writer',async()=>{
 const helpers=[{file:'packages/core/tests/fixtures/pruefer1-helper.mjs',text:helperSource('')}];
 for(const source of [
  helperCaller.replace("createFixture()","createFixture({root:'/outside'})").replace("await rm(created,{recursive:true});",""),
  helperCaller.replace("'pruefer1-owned-'","'../../outside-'").replace("await rm(created,{recursive:true});",""),
  helperCaller.replace("await rm(created,{recursive:true});","await fixture.unknown();"),
 ])assert.equal((await decide(source,{helpers})).r.darf_starten,false);
});

for(const [label,source] of [
 ['B4 Namespace',"import * as h from './fixtures/pruefer1-helper.mjs';const fixture=h.createFixture();await fixture.createRoot('pruefer1-owned-');"],
 ['B5 Default',"import createFixture from './fixtures/pruefer1-helper.mjs';const fixture=createFixture();await fixture.createRoot('pruefer1-owned-');"],
 ['Seitenimport',"import './fixtures/pruefer1-helper.mjs';"],
 ['Dynamischer Import',"const h=await import('./fixtures/pruefer1-helper.mjs');await h.createFixture().createRoot('pruefer1-owned-');"],
 ['require',"const h=require('./fixtures/pruefer1-helper.mjs');h.createFixture().createRoot('pruefer1-owned-');"],
 ['unaufgelöster Import',"await import(process.env.HELPER);"],
])test('Enge Scopeentscheidung: '+label+' bleibt Anleitung ohne Caller-Writer',async()=>{
 const text=helperSource("await writeFile('/outside/import-form','x');")+(label==='B5 Default'?'export default createFixture;':'');
 assert.equal((await decide(source,{helpers:[{file:'packages/core/tests/fixtures/pruefer1-helper.mjs',text}]})).r.darf_starten,false);
});
test('coedit-test besitzt keine Sonderfreigabe mehr',async()=>{
 for(const text of [
  imports+"const created=await mkdtemp("+JSON.stringify(root+'/coedit-test/owned-fixture-')+");await writeFile(join(created,'x'),'a');await rm(created,{recursive:true});",
  imports+"await writeFile("+JSON.stringify(root+'/coedit-test/owned/config.json')+",'{}');",
 ])assert.equal((await decide(text)).r.darf_starten,false);
});

test('Direkte Testdatei: gleichnamiger Root aus fremdem Scope ist kein Besitznachweis',async()=>{
 const text=imports+"function remove(){const owned='/outside';return rm(owned,{recursive:true});}function unrelated(){const owned=mkdtemp(join(tmpdir(),'owned-fixture-'));}await remove();";
 assert.equal((await decide(text)).r.darf_starten,false);
});
test('Umgebundene FS-API der Testdatei erhält keine direkte Schreibfreigabe',async()=>{
 const text=imports+made+"writeFile=customWriter;await writeFile(join(root,'x'),'a');";
 assert.equal((await decide(text)).r.darf_starten,false);
});

test('Aktueller A12-Test mit direktem Cleanup erhält native Freigabe ohne SQL-Ausführung',async()=>{
 const command='node packages/core/tests/asset-inspektion-share-p13-a12.test.mjs';
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,env:{DATABASE_URL:'postgresql://tester:synthetic@test.invalid:5433/synapse_test'},env_vollstaendig:true,datenbank_freigabe:proof});
 assert.equal(lage.kommandos[0].inline_skript.testdatei_pfad,root+'/packages/core/tests/asset-inspektion-share-p13-a12.test.mjs');
 const r=pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
 assert.equal(r.darf_starten,true,JSON.stringify({risiko:r.antwort?.risiko,ungeklaert:lage.ungeklaert}));
});

test('Root vor try bleibt bei terminalem Env-Restore und direktem Callback-Cleanup gebunden',async()=>{
 const text=imports+made+"after(async()=>{await rm(root,{recursive:true});});try{await writeFile(join(root,'x'),'a');}finally{for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,saved);}";
 assert.equal((await decide(text)).r.darf_starten,true);
 const second=imports+made+"try{await writeFile(join(root,'x'),'a');}finally{process.env.TMPDIR='/outside';}const other=await mkdtemp(join(tmpdir(),'second-root-'));await rm(other,{recursive:true});";
 assert.equal((await decide(second)).r.darf_starten,false);
});

test('Produkt-dist-Imports bleiben neutral; Testpfade, Writerpakete und unklare Imports nicht',async()=>{
 for(const text of [
  "import{Client}from'../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';new Client({name:'fixture'},{capabilities:{}});",
  "import {pathToFileURL}from'node:url';import{resolve}from'node:path';const root=process.cwd();await import(pathToFileURL(resolve(root,'packages/core/dist/index.js')));",
  "const dist=new URL('../dist/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('services/module.js');",
 ])assert.equal((await decide(text)).r.darf_starten,true);
 for(const text of [
  "const dist=new URL('./fixtures/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('helper.mjs');",
  "const dist=new URL('../dist/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('../tests/fixtures/helper.mjs');",
  "import writer from'fs-extra';writer.remove('/outside');",
  "import writer from'../node_modules/rimraf/dist/esm/index.js';writer('/outside');",
  "import{Client}from'./fixtures/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';new Client({name:'fixture'});",
  "import helper from '../../../scripts/lib/helper.mjs';helper();",
 ])assert.equal((await decide(text)).r.darf_starten,false);
});

test('Direkte bekannte FS-Writer benötigen eigene Wurzel auch außerhalb alter Regexliste',async()=>{
 for(const text of [
  imports+"await mkdtemp('/outside/owned-fixture-');",
  "import{appendFile}from'node:fs/promises';await appendFile('/outside/x','a');",
  "import{copyFile}from'node:fs/promises';await copyFile('/owned/x','/outside/x');",
  "import{mkdir}from'node:fs/promises';await mkdir('/outside/x');",
  imports+"await mkdtemp("+JSON.stringify(root+'/coedit-test/owned-fixture-')+");",
 ])assert.equal((await decide(text)).r.darf_starten,false);
 for(const text of [
  imports+made+"import{appendFile}from'node:fs/promises';await appendFile(join(root,'x'),'a');await rm(root,{recursive:true});",
  imports+made+"import{copyFile}from'node:fs/promises';await copyFile(join(root,'a'),join(root,'b'));await rm(root,{recursive:true});",
 ])assert.equal((await decide(text)).r.darf_starten,true);
});

test('DB-Bootstrap-Vertrauen gilt nur für die beiden expliziten Infrastrukturpfade',async()=>{
 for(const module of ['../../../scripts/lib/test-db-schutz.mjs','../dist/services/test-db-laufzeit-schutz.js']){
  assert.equal((await decide("import {oeffneGeschuetzteShellTestDb}from'"+module+"';const db=await oeffneGeschuetzteShellTestDb();await db.query('SELECT 1');await db.end();")).r.darf_starten,true);
 }
 for(const module of [
  './fixtures/test-db-schutz.mjs','./fixtures/test-db-laufzeit-schutz.js',
  '../../../scripts/lib/other/test-db-schutz.mjs','../../../other/scripts/lib/test-db-schutz.mjs',
  '/outside/scripts/lib/test-db-schutz.mjs','../../../scripts/lib/test-db-schutz.mjs.backup',
 ])assert.equal((await decide("import{oeffneGeschuetzteShellTestDb}from'"+module+"';await oeffneGeschuetzteShellTestDb();")).r.darf_starten,false);
});

test('Importformen mit file-URL behalten dieselbe exakte Pfadklassifikation',async()=>{
 for(const text of [
  "await import('file://"+root+"/scripts/lib/test-db-schutz.mjs');",
  "await import(new URL('../../../scripts/lib/test-db-schutz.mjs',import.meta.url));",
 ])assert.equal((await decide(text)).r.darf_starten,true);
 for(const text of [
  "await import('file://"+root+"/packages/core/tests/fixtures/test-db-schutz.mjs');",
  "import * as h from 'file://"+root+"/packages/core/tests/fixtures/pruefer1-helper.mjs';h.createFixture();",
 ])assert.equal((await decide(text)).r.darf_starten,false);
});

test('B6 gemischte Produkt-/Test-Basis bleibt Anleitung in beiden Branch-Reihenfolgen',async()=>{
 for(const [first,second]of [['../dist/','./fixtures/'],['./fixtures/','../dist/']]){
  const source="const dist=process.env.WHICH?new URL("+JSON.stringify(first)+",import.meta.url):new URL("+JSON.stringify(second)+",import.meta.url);const load=rel=>import(new URL(rel,dist));await load('helper.mjs');";
  assert.equal((await decide(source)).r.darf_starten,false);
 }
});
test('B7 path.resolve verwendet das letzte absolute Segment',async()=>{
 const source="import{resolve}from'node:path';import{pathToFileURL}from'node:url';const root=process.cwd();await import(pathToFileURL(resolve(root,'packages/core/dist',"+JSON.stringify(root+'/packages/core/tests/fixtures/helper.mjs')+")));";
 assert.equal((await decide(source)).r.darf_starten,false);
});

test('B6 alle konkreten Basen und unaufgelöste Zweige werden geprüft',async()=>{
 for(const source of [
  "const dist=process.env.WHICH?new URL(process.env.UNKNOWN,import.meta.url):new URL('../dist/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('helper.mjs');",
  "const dist=process.env.WHICH?new URL('../dist/',import.meta.url):new URL(process.env.UNKNOWN,import.meta.url);const load=rel=>import(new URL(rel,dist));await load('helper.mjs');",
  "const dist=process.env.WHICH?new URL('../dist/nested/',import.meta.url):new URL('../dist/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('../tests/fixtures/helper.mjs');",
  "const dist=new URL('../dist/index.js',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('../tests/fixtures/helper.mjs');",
  "const dist=new URL('../dist/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('file://"+root+"/packages/core/tests/fixtures/helper.mjs');",
 ])assert.equal((await decide(source)).r.darf_starten,false);
 const both="const dist=process.env.WHICH?new URL('../dist/nested/',import.meta.url):new URL('../dist/',import.meta.url);const load=rel=>import(new URL(rel,dist));await load('module.js');";
 assert.equal((await decide(both)).r.darf_starten,true);
});

test('B8 bekannte Pfadbasen behalten ihre Node-Semantik und Herkunft',async()=>{
 const pre="import{resolve,join}from'node:path';import{pathToFileURL}from'node:url';";
 for(const op of ['resolve','join']){
  for(const base of [root+'/packages/core/tests/fixtures','/outside']){
   for(const binding of ['', 'const base='+JSON.stringify(base)+';', 'const original='+JSON.stringify(base)+';const base=(original);']){
    const first=binding?'base':JSON.stringify(base);
    assert.equal((await decide(pre+binding+"await import(pathToFileURL("+op+"("+first+",'packages/core/dist/helper.mjs')));")).r.darf_starten,false);
   }
  }
  assert.equal((await decide(pre+"const base="+JSON.stringify(root)+";await import(pathToFileURL("+op+"(base,'packages/core/dist/helper.mjs')));")).r.darf_starten,true);
  for(const binding of [
   "const base=process.env.UNKNOWN;",
   "const base=process.env.WHICH?"+JSON.stringify(root)+":"+JSON.stringify(root+'/packages/core/tests/fixtures')+";",
   "const base=process.env.WHICH?"+JSON.stringify(root)+":process.env.UNKNOWN;",
  ])assert.equal((await decide(pre+binding+"await import(pathToFileURL("+op+"(base,'packages/core/dist/helper.mjs')));")).r.darf_starten,false);
  for(const binding of [
   "let base="+JSON.stringify(root)+";base='/outside';",
   "const base='/outside';function other(){const base="+JSON.stringify(root)+";}",
  ])assert.equal((await decide(pre+binding+"await import(pathToFileURL("+op+"(base,'packages/core/dist/helper.mjs')));")).r.darf_starten,false);
  const everyProduct="const base=process.env.WHICH?"+JSON.stringify(root)+":"+JSON.stringify(root+'/packages/core/dist/nested')+";const module='packages/core/dist/helper.mjs';";
  assert.equal((await decide(pre+everyProduct+"await import(pathToFileURL("+op+"(base,module)));")).r.darf_starten,true);
 }
 const concrete=pre+"const base=resolve("+JSON.stringify(root)+",'packages/core/tests/fixtures');await import(pathToFileURL(resolve(base,'packages/core/dist/helper.mjs')));";
 assert.equal((await decide(concrete)).r.darf_starten,false);
});
