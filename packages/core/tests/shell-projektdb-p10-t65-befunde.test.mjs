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
])test('F3 verschatteter Client: '+name,async()=>{
 const js="const {Client}=require('pg');const c=new Client("+config+");{"+body+"}";
 assert.equal((await check('node -e "'+js+'"')).darf_starten,false);
});

for(const [name,prefix,constructor] of [
 ['Namespace',"let pg=require('pg');pg={Client:require('other-driver').Client};",'pg.Client'],
 ['Namespace-Eigenschaft',"const pg=require('pg');pg.Client=require('other-driver').Client;",'pg.Client'],
 ['direkter Client',"let {Client}=require('pg');Client=require('other-driver').Client;",'Client'],
 ['Pool-Alias',"let {Pool:DbPool}=require('pg');DbPool=require('other-driver').Pool;",'DbPool'],
])test('F2 umgebundener '+name+' bleibt unklar',async()=>{
 const js=prefix+"const c=new "+constructor+"("+config+");c.query('DROP SCHEMA owned CASCADE')";
 assert.equal((await check('node -e "'+js+'"')).darf_starten,false);
});
test('F2 umgebundene Core-Pool-Funktion bleibt unklar',async()=>{
 const js="import {getPool as pool} from '@synapse/core';pool=other;const c=pool();c.query('DROP SCHEMA owned')";
 assert.equal((await check('node --input-type=module -e "'+js+'"')).darf_starten,false);
});
test('Positivkontrollen: explizite psql-URI und unveränderter pg-Konstruktor',async()=>{
 for(const command of ["psql '"+own+"' -c 'DROP SCHEMA owned CASCADE'",'node -e "const {Client}=require(\'pg\');const c=new Client('+config+');c.query(\'DROP SCHEMA owned CASCADE\')"']){
  const r=await check(command);assert.equal(r.darf_starten,true);assert.equal(r.audit.grund,'projekt_eigene_db');
 }
});
