/** P10-T65 User-Richtungswechsel2: Zielzuordnung ohne Helferpflicht. Keine SQL-Ausführung.
 * P10-T71 (14.10.2026, memory regel-datenbanken-nur-prod-gesperrt): gesperrt ist nur schreibender Zugriff auf
 * die Prod-DB; DROP/TRUNCATE/DELETE per psql ist Rueckfrage (P10-T73); alles andere laeuft, unklare Ziele mit
 * Hinweis und OHNE Projekt-DB-Zuordnung (frueher 'Anleitung'). */
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
for(const c of captures)test('W2-Aufruf '+c.id.slice(0,8)+' trennt SQL von Verbindungsumbau',async()=>{
 const cwd=path.join(root,c.cwd_relative);
 const texts=Object.fromEntries(c.scripts.map(s=>[path.resolve(cwd,s.file),s.text.replaceAll('/home/blacky/dev/synapse',root)]));
 const r=await decision(c.command,{cwd,texts});
 const sqlOhneUmbau=/^(?:edcd8ef2|ae9789bf)/.test(c.id);
 if(sqlOhneUmbau)assert.equal(r.darf_starten,true,JSON.stringify({audit:r.audit,risiko:r.antwort?.risiko,lage:r.antwort?.lage.ungeklaert}));
 else hinweisOderProdSperre(r,false);
});
const inline=text=>'node -e '+JSON.stringify(text);
const frei=r=>r.darf_starten===true&&r.audit.stufe==='laeuft'&&!r.hinweis;
/** P10-T71: frueher 'Anleitung' -> jetzt Hinweis (laeuft, keine Zuordnung) oder, bei erkanntem Prod-Ziel, Sperre. */
function hinweisOderProdSperre(r,prod){
 if(prod){assert.equal(r.darf_starten,false);assert.equal(r.audit.stufe,'sperre');return;}
 assert.equal(r.darf_starten,true,JSON.stringify(r.audit));assert.equal(r.audit.stufe,'hinweis');assert.notEqual(r.audit.grund,'projekt_eigene_db');
}
for(const [name,command,env] of [
 ['Inline-SQL',inline("const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});c.query('DROP SCHEMA owned CASCADE')"),{DATABASE_URL:own}],
 ['Explizite Inline-DSN',inline("const{Client}=require('pg');const c=new Client({connectionString:'"+own+"'});c.query('CREATE TABLE owned(x int)')"),{}],
 ['psql ohne -X',"psql '"+own+"' -c 'CREATE TABLE owned(x int)'",{}],
 ['psql PG-Umgebung',"psql -c 'CREATE TABLE owned(x int)'",{PGHOST:'test.invalid',PGPORT:'5433',PGUSER:'tester',PGDATABASE:'synapse_test'}],
 ['Projekt-DB', "psql 'postgresql://owner:synthetic@project.invalid:5433/spielwiese' -c 'CREATE TABLE owned(x int)'",{}]
])test(name+' erlaubt',async()=>{
 const freigabe=name==='Projekt-DB'?{...proof,ziele:[{art:'projekt',host:'project.invalid',port:'5433',user:'owner',datenbank:'spielwiese'}]}:proof;
 // P10-T71 Teil 2: auch die explizite Inline-DSN laeuft (frueher abgewiesen).
 assert.equal((await decision(command,{env,freigabe})).darf_starten,true);
});
// P10-T73: DROP/TRUNCATE/DELETE ohne WHERE per psql ist auch auf der eigenen Projekt-DB eine Rueckfrage.
for(const [name,command] of [['psql ohne -X',"psql '"+own+"' -c 'DROP SCHEMA owned CASCADE'"],['Projekt-DB',"psql 'postgresql://owner:synthetic@project.invalid:5433/spielwiese' -c 'DROP TABLE owned'"]])
 test(name+' DROP ist Rueckfrage',async()=>{
  const freigabe=name==='Projekt-DB'?{...proof,ziele:[{art:'projekt',host:'project.invalid',port:'5433',user:'owner',datenbank:'spielwiese'}]}:proof;
  const r=await decision(command,{freigabe});assert.equal(r.darf_starten,false);assert.equal(r.antwort.stufe,'rueckfrage');
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
])test(name+' (P10-T71: Prod gesperrt, T73-Rueckfrage, sonst ohne Zuordnung)',async()=>{
 const r=await decision(command,{env});
 // P10-T73: psql mit DROP ist db.massiv -> rueckfrage (Live faellt unter die Prod-Sperre).
 const erwartet=/^Live/.test(name)?'sperre':/^psql\b/.test(command)&&/DROP/.test(command)?'rueckfrage':null;
 if(erwartet){assert.equal(r.darf_starten,false);assert.equal(r.audit.stufe,erwartet);}
 else{assert.equal(r.darf_starten,true);assert.notEqual(r.audit.grund,'projekt_eigene_db');}
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

/** NOGO b1680e68: erkennbare Overrides werden unabhängig vom eigenen Default blockiert. */
for(const [name,js]of [
 ['H1 partielles Live-Tuple',"const{Client}=require('pg');const c=new Client({host:'live.invalid',port:5432,database:'synapse'});c.query('DROP TABLE owned')"],
 ['H1 nur fremde DB',"const{Client}=require('pg');const c=new Client({database:'foreign'});c.query('DROP TABLE owned')"],
 ['H1 nur Live-Port',"const{Pool}=require('pg');const c=new Pool({port:5432});c.query('DROP TABLE owned')"],
 ['H1 Configvariable',"const{Client}=require('pg');const cfg={database:'foreign'};const c=new Client(cfg);c.query('DROP TABLE owned')"],
 ['H1 nachträgliches Configfeld',"const{Client}=require('pg');const cfg={database:'synapse_test'};cfg.database='foreign';const c=new Client(cfg);c.query('DROP TABLE owned')"],
 ['H1 unbekanntes partielles Feld',"const{Client}=require('pg');const c=new Client({host:process.env.UNKNOWN_HOST});c.query('DROP TABLE owned')"],
 ['H2 geänderte URI',"const{Client}=require('pg');let uri=process.env.DATABASE_URL;uri='"+live+"';const c=new Client({connectionString:uri});c.query('DROP TABLE owned')"],
 ['H2 URI-Alias',"const{Client}=require('pg');let uri=process.env.DATABASE_URL;uri='"+live+"';const alias=uri;const c=new Client({connectionString:alias});c.query('DROP TABLE owned')"],
 ['H2 Objektfeld geändert',"const{Client}=require('pg');const cfg={connectionString:process.env.DATABASE_URL};cfg.connectionString='"+live+"';const c=new Client(cfg);c.query('DROP TABLE owned')"],
 ['H3 SQL-Konstante',"const c=getPool();const sql='DROP DATABASE synapse';c.query(sql)"],
 ['H3 SQL-Verkettung',"const c=getPool();const sql='DROP DATABASE '+'synapse';c.query(sql)"],
 ['H3 SQL-Zuweisung',"const c=getPool();let sql='DROP TABLE owned';sql='DROP DATABASE synapse';c.query(sql)"],
 ['H3 QueryConfig',"const c=getPool();const sql='DROP DATABASE synapse';c.query({text:sql})"],
 ['H3 eigene explizite DSN ohne Default',"const{Client}=require('pg');const c=new Client({connectionString:'"+own+"'});const sql='DROP DATABASE synapse';c.query(sql)"]
])test(name+' bleibt Hinweis bzw. Prod-Sperre',async()=>{
 // P10-T71 Nachtrag (Befund e8459f6a): 'H1 partielles Live-Tuple' war todo, jetzt echte Prod-Sperre.
 const env=name==='H3 eigene explizite DSN ohne Default'?{}:{DATABASE_URL:own};
 const r=await decision(inline(js),{env});
 hinweisOderProdSperre(r,/^H2 (?:geänderte URI|URI-Alias|Objektfeld geändert)$/.test(name)||name==='H1 partielles Live-Tuple');
});
for(const [name,js]of [
 ['eigenes partielles Tuple',"const{Client}=require('pg');const c=new Client({host:'test.invalid',port:5433,database:'synapse_test'});c.query('DROP TABLE owned')"],
 ['eigene URI-Zuweisung',"const{Client}=require('pg');let uri=process.env.DATABASE_URL;uri='"+own+"';const c=new Client({connectionString:uri});c.query('DROP TABLE owned')"],
 ['eigene SQL-Konstante',"const c=getPool();const sql='DROP TABLE owned';c.query(sql)"],
 ['eigene QueryConfig',"const c=getPool();const sql='CREATE TABLE owned(x int)';c.query({text:sql})"]
])test(name+' bleibt frei ohne Helfer',async()=>{
 // P10-T71 Teil 2: auch eigenes Tupel / eigene URI-Zuweisung laufen (frueher ohne Nachweis abgewiesen).
 const r=await decision(inline(js),{env:{DATABASE_URL:own}});assert.equal(r.darf_starten,true);
});

for(const [name,js]of [
 ['H1 Pool-Importalias',"const{Pool:DbPool}=require('pg');const c=new DbPool({database:'foreign'});c.query('DROP TABLE owned')"],
 ['H1 Configalias',"const{Client}=require('pg');const cfg={database:'synapse_test'};const alias=cfg;alias.database='foreign';const c=new Client(cfg);c.query('DROP TABLE owned')"],
 ['H1 verschachtelte Config',"const{Client}=require('pg');const cfg={db:{database:'foreign'}};const c=new Client(cfg.db);c.query('DROP TABLE owned')"],
 ['H2 partielle Configvariable geändert',"const{Client}=require('pg');let port=5433;port=5432;const c=new Client({port});c.query('DROP TABLE owned')"],
 ['H2 unbekannte URI-Änderung',"const{Client}=require('pg');let uri=process.env.DATABASE_URL;uri=uri.replace('synapse_test','synapse');const c=new Client({connectionString:uri});c.query('DROP TABLE owned')"],
 ['H3 DB-Name vor SQL geändert',"const c=getPool();let name='synapse_test';name='synapse';const sql='DROP DATABASE '+name;c.query(sql)"],
 ['H3 QueryConfig-Text geändert',"const c=getPool();const cfg={text:'DROP TABLE owned'};cfg.text='DROP DATABASE synapse';c.query(cfg)"],
 ['H3 SQL-Template',"const c=getPool();const name='synapse';const sql=`DROP DATABASE ${name}`;c.query(sql)"]
])test(name+' bleibt Hinweis',async()=>{
 const r=await decision(inline(js),{env:{DATABASE_URL:own}});hinweisOderProdSperre(r,false);
});
/** P10-T71 Nachtrag (Befund e8459f6a): schreibendes SQL gegen die Prod-DB als pg-Config-Tupel OHNE URL
 * (Client/Pool-Objekt, PGHOST/PGPORT/PGDATABASE, psql -h/-p/-d, Conninfo) ist wie per URL datenbank_live und gesperrt.
 * Gleiches Tupel gegen synapse_test/5433 oder eine Workspace-DB laeuft; Lesen der Prod-DB bleibt frei. */
async function lageFuer(command,env){
 const probe=async input=>({cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]}))});
 return ermittleShellLage(command,{cwd:root,project_root:root,os:'linux',shell:'sh',inspect:true,probe,env,env_vollstaendig:true,datenbank_freigabe:proof});
}
const pgJs=(cfg,sql,klasse='Client')=>inline("const{"+klasse+"}=require('pg');const c=new "+klasse+"("+cfg+");c.query('"+sql+"')");
const prodEnv={DATABASE_URL:own,PGHOST:'live.invalid',PGPORT:'5432',PGDATABASE:'synapse'};
for(const [name,command,env] of [
 ['Client-Tupel',pgJs("{host:'live.invalid',port:5432,database:'synapse',user:'worker'}",'INSERT INTO t VALUES (1)'),{DATABASE_URL:own}],
 ['Client-Tupel Port als String',pgJs("{host:'live.invalid',port:'5432',database:'synapse'}",'UPDATE t SET x=1 WHERE id=1'),{DATABASE_URL:own}],
 ['Client-Tupel ohne Port (pg-Standard 5432)',pgJs("{host:'live.invalid',database:'synapse'}",'INSERT INTO t VALUES (1)'),{DATABASE_URL:own}],
 ['Pool-Config',pgJs("{host:'live.invalid',port:5432,database:'synapse',max:2}",'DELETE FROM t WHERE id=1','Pool'),{DATABASE_URL:own}],
 ['Pool-Config ueber Variable',inline("const{Pool}=require('pg');const cfg={host:'live.invalid',port:5432,database:'synapse'};const c=new Pool(cfg);c.query('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['PG-Env Node ohne Config',pgJs('','INSERT INTO t VALUES (1)'),prodEnv],
 ['PG-Env Zuweisung psql',"PGHOST=live.invalid PGPORT=5432 PGDATABASE=synapse psql -c 'INSERT INTO t VALUES (1)'",{}],
 ['PG-Env Job psql',"psql -c 'UPDATE t SET x=1 WHERE id=1'",prodEnv],
 ['psql -h/-p/-d',"psql -h live.invalid -p 5432 -d synapse -c 'INSERT INTO t VALUES (1)'",{}],
 ['psql --host= --port= --dbname=',"psql --host=live.invalid --port=5432 --dbname=synapse -c 'UPDATE t SET x=1 WHERE id=1'",{}],
 ['psql Conninfo',"psql 'host=live.invalid port=5432 dbname=synapse' -c 'INSERT INTO t VALUES (1)'",{}],
 ['psql Skriptdatei',"psql -h live.invalid -p 5432 -d synapse -f migrate.sql",{}]
])test('Prod-Tupel ohne URL gesperrt: '+name,async()=>{
 assert.equal((await lageFuer(command,env)).datenbank_live,true,'datenbank_live erwartet');
 const r=await decision(command,{env});
 assert.equal(r.darf_starten,false);assert.equal(r.audit.stufe,'sperre');
});
for(const [name,command,env] of [
 ['Client-Tupel synapse_test/5433',pgJs("{host:'test.invalid',port:5433,database:'synapse_test'}",'INSERT INTO t VALUES (1)'),{DATABASE_URL:own}],
 ['Client-Tupel Workspace-DB',pgJs("{host:'localhost',port:5432,database:'workspace_app'}",'INSERT INTO t VALUES (1)'),{DATABASE_URL:own}],
 ['Pool-Config Workspace-DB-Container',pgJs("{host:'db',port:5432,database:'app_test'}",'UPDATE t SET x=1 WHERE id=1','Pool'),{DATABASE_URL:own}],
 ['Client gleiche DB anderer Port',pgJs("{host:'test.invalid',port:5433,database:'synapse'}",'INSERT INTO t VALUES (1)'),{DATABASE_URL:own}],
 ['PG-Env Node synapse_test',pgJs('','INSERT INTO t VALUES (1)'),{DATABASE_URL:own,PGHOST:'test.invalid',PGPORT:'5433',PGDATABASE:'synapse_test'}],
 ['psql synapse_test',"psql -h test.invalid -p 5433 -d synapse_test -c 'INSERT INTO t VALUES (1)'",{}],
 ['psql Workspace-DB',"psql -h localhost -p 5432 -d workspace_app -c 'INSERT INTO t VALUES (1)'",{}],
 ['PG-Env Zuweisung psql synapse_test',"PGHOST=test.invalid PGPORT=5433 PGDATABASE=synapse_test psql -c 'INSERT INTO t VALUES (1)'",{}],
 ['Lesen Prod Client-Tupel',pgJs("{host:'live.invalid',port:5432,database:'synapse'}",'SELECT count(*) FROM code_files'),{DATABASE_URL:own}],
 ['Lesen Prod psql -h/-p/-d',"psql -h live.invalid -p 5432 -d synapse -c 'SELECT count(*) FROM code_files'",{}],
 ['Lesen Prod pg_dump -h/-p/-d',"pg_dump -h live.invalid -p 5432 -d synapse",{}]
])test('Nicht-Prod bzw. Lesen laeuft: '+name,async()=>{
 assert.equal((await lageFuer(command,env)).datenbank_live,undefined,'kein datenbank_live');
 const r=await decision(command,{env});
 assert.equal(r.darf_starten,true,JSON.stringify(r.audit));assert.notEqual(r.audit.stufe,'sperre');
});
test('Configaliase gehen ohne Datenflussanalyse zur Anleitung',async()=>{
});
/** P10-T71 Nachbesserung (Abnahme d996c097): weitere Schreibwege gegen die Prod-DB sind datenbank_live und gesperrt:
 * dropdb/createdb/pg_restore -d, psql-Metabefehle (\i) bzw. -f neben -c, export/env-Zuweisungen ueber mehrere
 * Kommandos, Python-Clients (psycopg2/psycopg/asyncpg/SQLAlchemy), URL ohne Port bzw. ohne DB-Namen (libpq: DB=User).
 * Gegenfaelle: synapse_test/5433, Workspace-DBs und Lesen der Prod-DB bleiben ohne datenbank_live. */
const py=text=>'python3 -c '+JSON.stringify(text);
for(const [name,command,env] of [
 ['dropdb -h/-p',"dropdb -h live.invalid -p 5432 synapse",{}],
 ['dropdb --port=',"dropdb --host=live.invalid --port=5432 synapse",{}],
 ['dropdb Standardport',"dropdb -h live.invalid synapse",{}],
 ['dropdb ueber Wartungs-DB',"dropdb -p 5432 --maintenance-db=synapse other_db",{}],
 ['createdb',"createdb -h live.invalid -p 5432 synapse",{}],
 ['pg_restore -d',"pg_restore -h live.invalid -p 5432 -d synapse --clean dump.bin",{}],
 ['pg_restore -d URL',"pg_restore -d postgresql://worker@live.invalid:5432/synapse dump.bin",{}],
 ['pg_restore -p5432 -dsynapse',"pg_restore -p5432 -dsynapse dump.bin",{}],
 ['timeout-Wrapper dropdb',"timeout 30 dropdb -h live.invalid -p 5432 synapse",{}],
 ['sudo-Wrapper pg_restore',"sudo -u postgres pg_restore -p 5432 -d synapse dump.bin",{}],
 ['psql \\i Datei',"psql -h live.invalid -p 5432 -d synapse -c '\\i migrate.sql'",{}],
 ['psql -c SELECT plus -f',"psql -h live.invalid -p 5432 -d synapse -c 'SELECT 1' -f migrate.sql",{}],
 ['psql URL ohne Port',"psql postgresql://worker@live.invalid/synapse -c 'INSERT INTO t VALUES (1)'",{}],
 ['psql URL ohne DB (DB=User)',"psql postgresql://synapse@live.invalid:5432 -c 'INSERT INTO t VALUES (1)'",{}],
 ['export ueber ein Kommando',"export PGPORT=5432 PGDATABASE=synapse; psql -h live.invalid -c 'INSERT INTO t VALUES (1)'",{}],
 ['export ueber mehrere Kommandos',"export PGPORT=5432; export PGDATABASE=synapse; psql -f migrate.sql",{}],
 ['Zuweisung dann export',"PGPORT=5432; PGDATABASE=synapse; export PGPORT PGDATABASE; psql -c 'DELETE FROM t WHERE id=1'",{}],
 ['env-Wrapper psql',"env PGPORT=5432 PGDATABASE=synapse psql -c 'INSERT INTO t VALUES (1)'",{}],
 ['export dann dropdb',"export PGPORT=5432; dropdb synapse",{}],
 ['Node URL ohne Port',inline("const{Client}=require('pg');const c=new Client({connectionString:'postgresql://worker@live.invalid/synapse'});c.query('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['psycopg2 Schluesselwoerter',py("import psycopg2\nc=psycopg2.connect(host='live.invalid',port=5432,dbname='synapse',user='worker')\nc.cursor().execute('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['psycopg2 ohne Port',py("import psycopg2\nc=psycopg2.connect(host='live.invalid',dbname='synapse')\nc.cursor().execute('UPDATE t SET x=1')"),{DATABASE_URL:own}],
 ['psycopg2 URL',py("import psycopg2\nc=psycopg2.connect('postgresql://worker@live.invalid/synapse')\nc.cursor().execute('DELETE FROM t')"),{DATABASE_URL:own}],
 ['psycopg2 Conninfo',py("import psycopg2\nc=psycopg2.connect('host=live.invalid port=5432 dbname=synapse')\nc.cursor().execute('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['psycopg2 PG-Env',py("import psycopg2\nc=psycopg2.connect()\nc.cursor().execute('INSERT INTO t VALUES (1)')"),prodEnv],
 ['psycopg Dict-Config',py("import psycopg\ncfg={'host':'live.invalid','port':5432,'dbname':'synapse'}\nc=psycopg.connect(**cfg)\nc.execute('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['asyncpg',py("import asyncpg\nc=await asyncpg.connect(host='live.invalid',port=5432,database='synapse')\nawait c.execute('TRUNCATE t')"),{DATABASE_URL:own}],
 ['SQLAlchemy',py("from sqlalchemy import create_engine,text\ne=create_engine('postgresql+psycopg2://worker@live.invalid:5432/synapse')\ne.connect().execute(text('DROP TABLE t'))"),{DATABASE_URL:own}],
])test('Prod-Schreibweg gesperrt: '+name,async()=>{
 assert.equal((await lageFuer(command,env)).datenbank_live,true,'datenbank_live erwartet');
 const r=await decision(command,{env});
 assert.equal(r.darf_starten,false);assert.equal(r.audit.stufe,'sperre');
});
for(const [name,command,env] of [
 ['dropdb synapse_test',"dropdb -h test.invalid -p 5433 synapse_test",{}],
 ['dropdb Workspace-DB',"dropdb -h localhost -p 5432 workspace_app",{}],
 ['createdb gleicher Name anderer Port',"createdb -h test.invalid -p 5433 synapse",{}],
 ['pg_restore synapse_test',"pg_restore -h test.invalid -p 5433 -d synapse_test dump.bin",{}],
 ['pg_restore ohne -d (nur Ausgabe)',"pg_restore -f out.sql dump.bin",{}],
 ['pg_dumpall Prod liest nur',"pg_dumpall -h live.invalid -p 5432 -f all.sql",{}],
 ['psql Prod Metabefehl lesend',"psql -h live.invalid -p 5432 -d synapse -c '\\dt'",{}],
 ['psql \\i gegen synapse_test',"psql -h test.invalid -p 5433 -d synapse_test -c '\\i migrate.sql'",{}],
 ['export synapse_test',"export PGPORT=5433 PGDATABASE=synapse_test; psql -h test.invalid -c 'INSERT INTO t VALUES (1)'",{}],
 ['export Prod dann unset',"export PGPORT=5432 PGDATABASE=synapse; unset PGDATABASE; psql -h test.invalid -c 'INSERT INTO t VALUES (1)'",{}],
 ['env-Wrapper synapse_test',"env PGPORT=5433 PGDATABASE=synapse_test psql -c 'INSERT INTO t VALUES (1)'",{}],
 ['Node URL synapse_test ohne Port-Angabe im Code',inline("const{Client}=require('pg');const c=new Client({connectionString:'postgresql://tester@test.invalid:5433/synapse_test'});c.query('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['psycopg2 synapse_test',py("import psycopg2\nc=psycopg2.connect(host='test.invalid',port=5433,dbname='synapse_test')\nc.cursor().execute('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['psycopg2 Workspace-DB',py("import psycopg2\nc=psycopg2.connect('postgresql://app@localhost:5432/workspace_app')\nc.cursor().execute('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
 ['psycopg2 Prod lesend',py("import psycopg2\nc=psycopg2.connect(host='live.invalid',port=5432,dbname='synapse')\nc.cursor().execute('SELECT count(*) FROM code_files')"),{DATABASE_URL:own}],
 ['psycopg2 Port aus Variable (unklar)',py("import psycopg2,os\nc=psycopg2.connect(host='test.invalid',port=os.environ['P'],dbname='synapse')\nc.cursor().execute('INSERT INTO t VALUES (1)')"),{DATABASE_URL:own}],
])test('Nicht-Prod bzw. Lesen ohne Prod-Sperre: '+name,async()=>{
 assert.equal((await lageFuer(command,env)).datenbank_live,undefined,'kein datenbank_live');
 const r=await decision(command,{env});
 assert.notEqual(r.audit.stufe,'sperre',JSON.stringify(r.audit));
 // Allgemeine Rueckfrage fuer gefaehrliche Befehle (P10-T73, z. B. dropdb) ist keine DB-Sperre.
 if(!r.darf_starten)assert.equal(r.audit.stufe,'rueckfrage',JSON.stringify(r.audit));

 const js="const{Client}=require('pg');const cfg={database:'synapse_test'};const alias=cfg;alias.database='synapse_test';const c=new Client(alias);const sql='DROP TABLE owned';c.query({text:sql})";
 assert.equal(frei(await decision(inline(js),{env:{DATABASE_URL:own}})),false);
});
