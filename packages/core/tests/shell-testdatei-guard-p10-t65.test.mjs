/** P10-T65 Testdatei-Aufnahme: Guardnutzung plus echte Laufzeitprüfung, kein SHA-Katalog. */
import{test}from'node:test';import assert from'node:assert/strict';
import{ermittleShellLage}from'../dist/services/shell-lage.js';
import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';
import{testDateiNutztGuard}from'../dist/services/shell-testdatei-guard.js';
import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
const project='p10_shell_projektdb',root='/home/blacky/dev/'+project;
const target={host:'test.invalid',port:'6544',datenbank:'synapse_test',user:'tester'};
const proof={project,test_system_id:'123456789',ziele:[{...target,art:'test'}],live:{host:'live.invalid',port:'5432',datenbank:'synapse',user:'worker'}};
const src="import {oeffneGeschuetzteShellTestDb} from '../dist/services/test-db-laufzeit-schutz.js';const db=await oeffneGeschuetzteShellTestDb();await db.query('DROP SCHEMA owned CASCADE');await db.end();";
async function decision(rel,text=src,p=proof){
 const file=root+'/'+rel;
 const probe=async()=>({cwd:root,os:'linux',env:{},pfade:[],testdatei:{pfad:file,kanonisch:file,text,sha256:'a'.repeat(64)}});
 const lage=await ermittleShellLage('node '+rel,{cwd:root,project_root:root,shell:'sh',os:'linux',inspect:true,probe,env:{DATABASE_URL:'postgresql://tester:synthetic@test.invalid:6544/synapse_test'},env_vollstaendig:true,datenbank_freigabe:p});
 return pruefeShellStart({project,command:'node '+rel,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
}
test('Gemeinsamer Skripthelfer wird als Guard-Einstieg erkannt',async()=>{
 const text=src.replace('../dist/services/test-db-laufzeit-schutz.js','../../../scripts/lib/test-db-schutz.mjs');
 assert.equal((await decision('packages/core/tests/own.mjs',text)).darf_starten,true);
});
test('Versionierte Guard-Testdatei wird aufgenommen',async()=>{
 const r=await decision('packages/core/tests/own.mjs');assert.equal(r.darf_starten,true);assert.equal(r.audit.grund,'projekt_eigene_db');
});
for(const [name,text]of [
 ['ohne Guard',"const db=unknown;await db.query('DROP SCHEMA owned CASCADE')"],
 ['Guard nur im Kommentar',"// oeffneGeschuetzteShellTestDb()\nconst db=unknown;await db.query('DROP SCHEMA owned CASCADE')"],
 ['Query vor Guard',"import {oeffneGeschuetzteShellTestDb} from '../dist/services/test-db-laufzeit-schutz.js';await db.query('DROP SCHEMA owned');const db=await oeffneGeschuetzteShellTestDb();"],
 ['unbekannte DB daneben',src+"other.query('DELETE FROM owned')"],
])test('Optionaler Helfernachweis: '+name+' ungültig',async()=>{
 assert.equal(testDateiNutztGuard(text,root+'/packages/core/tests/own.mjs',root),false);
});
test('Cluster-Sollwert ist für Shell-Freigabe keine Pflicht',async()=>{
 assert.equal((await decision('packages/core/tests/own.mjs',src,{...proof,test_system_id:undefined})).darf_starten,true);
});
test('Eigener Zielkontext gilt außerhalb des Testpfadmusters',async()=>{
 assert.equal((await decision('src/own.mjs')).darf_starten,true);
});
