/** P10-T65 User-Richtungswechsel2: Zielzuordnung ohne Helferpflicht. Keine SQL-Ausführung. */
import {test} from 'node:test';
import ts from 'typescript';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../dist/services/shell-sicherung-seed.js';
import {dbZielAusUrl} from '../dist/services/shell-db-zuordnung.js';
const root='/home/blacky/dev/p10_shell_ziel',project='p10_shell_ziel';
const own='postgresql://tester:synthetic@test.invalid:5433/synapse_test';
const live='postgresql://worker:synthetic@live.invalid:5432/synapse';
const proof={project,live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(own),art:'test'}]};
async function decision(command,{cwd=root,texts={},env={},freigabe=proof}={}){
 const probe=async input=>({
  cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),
  ...(input.testdatei&&texts[input.testdatei]?{testdatei:{pfad:input.testdatei,kanonisch:input.testdatei,text:texts[input.testdatei],sha256:createHash('sha256').update(texts[input.testdatei]).digest('hex')}}:{}),
  ...(input.umgebungsdatei?{umgebungsdatei:{pfad:input.umgebungsdatei,sha256:'a'.repeat(64),testprojekt:true,exportiert:true,port:'5433',datenbank:'synapse_test',datenbank_ziel:dbZielAusUrl(own)}}:{})
 });
 const lage=await ermittleShellLage(command,{cwd,project_root:root,os:'linux',shell:'sh',inspect:true,probe,env,env_vollstaendig:true,datenbank_freigabe:freigabe});
 return pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
}
const captures=JSON.parse(readFileSync(new URL('./fixtures/shell-projektdb-w2-p10-t65.json',import.meta.url),'utf8'));
for(const c of captures)for(const s of c.scripts){const f=ts.createSourceFile(s.file,s.text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(f.parseDiagnostics.length,0,'Quellsnapshot muss syntaktisch gültig sein: '+s.file);}
for(const c of captures)test('W2-Aufruf '+c.id.slice(0,8)+' ohne Helferpflicht freigegeben',async()=>{
 const cwd=path.join(root,c.cwd_relative);
 const texts=Object.fromEntries(c.scripts.map(s=>[path.resolve(cwd,s.file),s.text.replaceAll('/home/blacky/dev/synapse',root)]));
 const r=await decision(c.command,{cwd,texts});
 assert.equal(r.darf_starten,true,JSON.stringify({audit:r.audit,risiko:r.antwort?.risiko,lage:r.antwort?.lage.ungeklaert}));
 assert.equal(r.audit.grund,'projekt_eigene_db');
});
const inline=text=>'node -e '+JSON.stringify(text);
for(const [name,command,env] of [
 ['Inline-SQL',inline("const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.query('DROP SCHEMA owned CASCADE')"),{DATABASE_URL:own}],
 ['Explizite Inline-DSN',inline("const{Client}=require('pg');const c=new Client({connectionString:'"+own+"'});c.query('CREATE TABLE owned(x int)')"),{}],
 ['psql ohne -X',"psql '"+own+"' -c 'DROP SCHEMA owned CASCADE'",{}],
 ['psql PG-Umgebung',"psql -c 'CREATE TABLE owned(x int)'",{PGHOST:'test.invalid',PGPORT:'5433',PGUSER:'tester',PGDATABASE:'synapse_test'}],
 ['Projekt-DB', "psql 'postgresql://owner:synthetic@project.invalid:5433/spielwiese' -c 'DROP TABLE owned'",{}]
])test(name+' erlaubt',async()=>{
 const freigabe=name==='Projekt-DB'?{...proof,ziele:[{art:'projekt',host:'project.invalid',port:'5433',user:'owner',datenbank:'spielwiese'}]}:proof;
 assert.equal((await decision(command,{env,freigabe})).darf_starten,true);
});
test('Node-Datei außerhalb Testpfadmuster ohne Helfer',async()=>{
 const file=root+'/tools/adhoc.mjs',text="const pool=getPool();await pool.query('DROP TABLE owned')";
 assert.equal((await decision('node tools/adhoc.mjs',{texts:{[file]:text},env:{DATABASE_URL:own}})).darf_starten,true);
});
for(const [name,command,env]of [
 ['Live CLI',"psql '"+live+"' -c 'DROP SCHEMA public CASCADE'",{}],
 ['Live Inline',inline("const{Client}=require('pg');const c=new Client({connectionString:'"+live+"'});c.query('DROP SCHEMA public CASCADE')"),{DATABASE_URL:own}],
 ['Unbekannte Umgebung',inline("const c=getPool();c.query('DROP TABLE owned')"),{}],
 ['Unbekannter Override',inline("const{Client}=require('pg');const c=new Client({connectionString:process.env.UNKNOWN_URL});c.query('DROP TABLE owned')"),{DATABASE_URL:own}],
 ['psql ignoriert DATABASE_URL',"psql -c 'DROP TABLE owned'",{DATABASE_URL:own}],
 ['PG-Override unklar',"psql '"+own+"' -c 'DROP TABLE owned'",{PGHOST:'live.invalid'}],
 ['Unbekanntes Ziel',"psql 'postgresql://tester:synthetic@other.invalid:5433/unknown' -c 'DROP TABLE owned'",{}],
 ['SQL wechselt DB',"psql '"+own+"' -c '\\connect synapse'",{}],
])test(name+' bleibt Anleitung',async()=>{
 const r=await decision(command,{env});assert.equal(r.darf_starten,false);assert.equal(r.audit.stufe,'anleitung');
});
test('Andere Risiken neben erlaubter DB bleiben aktiv',async()=>{
 const r=await decision(inline("const c=getPool();c.query('DROP TABLE owned');require('child_process').execSync(process.env.COMMAND)"),{env:{DATABASE_URL:own}});
 assert.equal(r.darf_starten,false);
});

test('Rekursive reine Normalisierung verbirgt keine echte Prozessoperation',async()=>{
 const text="const normalize=x=>Array.isArray(x)?x.map(normalize):x;const run=x=>run(x)+require('child_process').execSync(process.env.CMD);const c=getPool();c.query('DROP TABLE owned');run(normalize([]));";
 assert.equal((await decision(inline(text),{env:{DATABASE_URL:own}})).darf_starten,false);
});
test('Node-Datei außerhalb des Projektroots hat keine Helferpflicht',async()=>{
 const file='/tmp/p10_shell_ziel_adhoc.mjs',text="const pool=getPool();await pool.query('DROP TABLE owned')";
 assert.equal((await decision('node '+file,{texts:{[file]:text},env:{DATABASE_URL:own}})).darf_starten,true);
});
