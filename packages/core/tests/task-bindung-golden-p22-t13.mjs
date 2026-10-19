/**
 * P22-T13 Paket T, Golden AUS: plan uebernehmen / abmelden / passende_tasks / update_task gegen EINEN Stand.
 *   node packages/core/tests/task-bindung-golden-p22-t13.mjs <stand-root>  -> normalisierte Antworten als JSON (stdout)
 * Vergleich: mit Basis (/tmp/synapse-basis-1074d443) und aktuellem Stand laufen lassen, Ausgaben per cmp vergleichen.
 * Synthetische Plan-Daten im privaten Schema von synapse_test; Schalter task_bindung bleibt AUS.
 */
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=process.argv[2];
if(!root){console.error('Aufruf: node task-bindung-golden-p22-t13.mjs <stand-root>');process.exit(2);}
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(url.port!=='5433'||url.pathname!=='/synapse_test'){console.error('nur synapse_test:5433');process.exit(2);}
process.env.QDRANT_URL='http://127.0.0.1:1';process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const require=createRequire(join(root,'packages/core/package.json'));
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t13_gold_'+process.pid;
const P='p22-t13-gold';
const U=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ts='2026-01-01T00:00:00.000Z';
const out={};
const norm=v=>JSON.parse(JSON.stringify(v,(k,x)=>typeof x==='string'?x.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z?/g,'<ts>'):x));
async function lauf(name,fn){try{out[name]=norm(await fn());}catch(e){out[name]={throw:String(e.message).slice(0,300)};}}

try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  // Tabellen oben bereits kopiert
  // (siehe Kopie oben)
  // Schema 113 (nur im Stand mit Paket T relevant; Basis ignoriert es)
  const cl=await admin.connect();
  try{await cl.query('SET search_path TO '+schema);for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql'])await cl.query(readFileSync(new URL('../src/db/schema-sql/'+f, import.meta.url),'utf8'));}
  finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const Z=await import(pathToFileURL(join(root,'packages/core/dist/services/plan-zuweisung.js')).href);
  const PL=await import(pathToFileURL(join(root,'packages/core/dist/services/plans.js')).href);
  const tasks=[
    {id:U(11),title:'Task A',description:'',status:'todo',priority:'medium',kurz_id:'P1-T1',createdAt:ts,updatedAt:ts},
    {id:U(12),title:'Task B',description:'',status:'todo',priority:'medium',kurz_id:'P1-T2',createdAt:ts,updatedAt:ts},
  ];
  await admin.query(
    `INSERT INTO ${schema}.plans(id,project,name,description,goals,architecture,tasks,created_at,updated_at,kurz_id,aktiv,naechste_task_nr,prioritaet)
     VALUES($1,$2,'Golden','',$3,'',$4,NOW(),NOW(),'P1',true,3,'mittel')`,
    [U(1),P,[],JSON.stringify(tasks)]);
  const jetzt=new Date(ts);
  await lauf('passende_vorher',()=>Z.passendeTasks(P,'agent-x','P1',jetzt));
  await lauf('uebernehme_1',()=>Z.uebernehmeTask(P,'P1','P1-T1','agent-x'));
  await lauf('uebernehme_2_gleich',()=>Z.uebernehmeTask(P,'P1','P1-T1','agent-x'));
  await lauf('passende_nach_uebernahme',()=>Z.passendeTasks(P,'agent-y','P1',jetzt));
  await lauf('abmelde_1',()=>Z.meldeTaskAb(P,'P1','P1-T1','agent-x'));
  await lauf('update_status',()=>PL.updateTask(P,U(12),{status:'in_progress'},'P1'));
  await lauf('update_todo',()=>PL.updateTask(P,U(12),{status:'todo'},'P1'));
  await lauf('update_titel',()=>PL.updateTask(P,U(12),{title:'Task B neu'},'P1'));
  process.stdout.write(JSON.stringify(out,null,1)+'\n');
}catch(e){
  console.error('GOLDEN-FEHLER: '+e.message);process.exitCode=1;
}finally{
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
  await admin.end();
  process.exit(process.exitCode??0);
}
