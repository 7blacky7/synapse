/** P10-T65 F1/F2: reine synthetische Zielentscheidungen, keine SQL-Ausführung. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../dist/services/shell-sicherung-seed.js';
const project='p10_shell_projektdb';
const own='postgresql://worker:synthetic@projekt.invalid:6544/'+project;
const proof={project,ziele:[{art:'projekt',host:'projekt.invalid',port:'6544',datenbank:project,user:'worker'}],
 live:{host:'live.invalid',port:'5432',datenbank:'synapse',user:'worker'}};
async function check(command,env={DATABASE_URL:own}) {
 const root='/home/blacky/dev/'+project;
 const lage=await ermittleShellLage(command,{shell:'sh',os:'linux',cwd:root,project_root:root,env,env_vollstaendig:true,inspect:false,datenbank_freigabe:proof});
 return pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
}
test('F1 psql ohne Verbindungsargument: DATABASE_URL beweist kein Ziel',async()=>{
 const r=await check("psql -c 'DROP SCHEMA owned CASCADE'",{DATABASE_URL:own,PGHOST:'live.invalid',PGPORT:'5432',PGDATABASE:'synapse',PGUSER:'worker'});
 assert.equal(r.darf_starten,false);
});
test('F1 auch ohne PG-Variablen bleiben psql-Defaults unklar',async()=>{
 assert.equal((await check("psql -c 'DROP SCHEMA owned CASCADE'")).darf_starten,false);
});
const config="{connectionString:'"+own+"'}";
for(const [name,body]of [
 ['Block',"const c=unknown; c.query('DROP SCHEMA owned CASCADE')"],
 ['Parameter',"function run(c){c.query('DROP SCHEMA owned CASCADE')}run(unknown)"],
])test('Zielkontext statt Clientanalyse: '+name,async()=>{
 const js="const {Client}=require('pg');const c=new Client("+config+");{"+body+"}";
 assert.equal((await check('node -e "'+js+'"')).darf_starten,true);
});

for(const [name,prefix,constructor] of [
 ['Namespace',"let pg=require('pg');pg={Client:require('other-driver').Client};",'pg.Client'],
 ['Namespace-Eigenschaft',"const pg=require('pg');pg.Client=require('other-driver').Client;",'pg.Client'],
 ['direkter Client',"let {Client}=require('pg');Client=require('other-driver').Client;",'Client'],
 ['Pool-Alias',"let {Pool:DbPool}=require('pg');DbPool=require('other-driver').Pool;",'DbPool'],
])test('Umgebundener '+name+' mit eigenem Ziel',async()=>{
 const js=prefix+"const c=new "+constructor+"("+config+");c.query('DROP SCHEMA owned CASCADE')";
 assert.equal((await check('node -e "'+js+'"')).darf_starten,true);
});
test('Core-Pool-Alias mit eigenem Umgebungskontext',async()=>{
 const js="import {getPool as pool} from '@synapse/core';pool=other;const c=pool();c.query('DROP SCHEMA owned')";
 assert.equal((await check('node --input-type=module -e "'+js+'"')).darf_starten,true);
});
for(const [name,js] of [
 ['F4 mutierter Client-Alias',"const {Client}=require('pg');const c=new Client("+config+");let d=c;d=require('other-driver').connect();const e=d;e.query('DROP SCHEMA owned CASCADE')"],
 ['F5 Object.assign-Hersteller',"const pg=require('pg');Object.assign(pg,{Client:require('other-driver').Client});const c=new pg.Client("+config+");c.query('DROP SCHEMA owned CASCADE')"],
 ['Inline mit eigenem Ziel',"const {Client}=require('pg');const c=new Client("+config+");c.query('DROP SCHEMA owned CASCADE')"],
])test(name+' im eigenen DB-Kontext frei',async()=>{
 const r=await check('node -e "'+js+'"');assert.equal(r.darf_starten,true);assert.equal(r.audit.grund,'projekt_eigene_db');
});
for(const [key,value] of [
 ['PGHOST','live.invalid'],['PGPORT','5432'],['PGDATABASE','synapse'],['PGUSER','other'],
 ['PGSERVICE','unknown'],['PGSERVICEFILE','unknown'],['PGHOSTADDR','127.0.0.1'],
])test('CLI: abweichendes '+key+' verweigert Ausnahme',async()=>{
 assert.equal((await check("psql -X '"+own+"' -c 'DROP SCHEMA owned CASCADE'",{[key]:value})).darf_starten,false);
});
test('Positivkontrolle: explizite psql-URI',async()=>{
 const r=await check("psql -X '"+own+"' -c 'DROP SCHEMA owned CASCADE'");
 assert.equal(r.darf_starten,true);assert.equal(r.audit.grund,'projekt_eigene_db');
});
const {pruefeDbKommando}=await import('../dist/services/shell-db-zuordnung.js');
const {parseShellText}=await import('../dist/services/shell-sicherung-parser.js');
for(const [name,command,env,wanted]of [
 ['dump explizit',"pg_dump --clean '"+own+"'",{},true],
 ['dump abweichender Port',"pg_dump --clean '"+own+"'",{PGPORT:'5432'},false],
 ['dump ohne DSN',"pg_dump --clean",{},false],
 ['URI+CLI-Hostoverride',"psql -X '"+own+"' -h live.invalid -c 'DROP SCHEMA owned'",{},false],
 ['zwei DSNs',"psql -X '"+own+"' '"+own+"' -c 'DROP SCHEMA owned'",{},false],
 ['psql ohne Helfer/Rc-Pflicht',"psql '"+own+"' -c 'DROP SCHEMA owned'",{},true],
 ['Hosttuple konsistent',"psql -X '"+own+"' -c 'DROP SCHEMA owned'",{PGHOST:'projekt.invalid',PGPORT:'6544',PGDATABASE:project,PGUSER:'worker'},true],
])test('Enges CLI-Muster: '+name,()=>{
 const k=parseShellText(command,'sh').kommandos[0];
 assert.equal(pruefeDbKommando(k,env,proof).erlaubt,wanted);
});
