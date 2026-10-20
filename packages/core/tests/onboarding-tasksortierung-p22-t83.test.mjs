/**
 * P22-T83: Anzeige-Sortierung der Tasks des aktiven Plans in der Koordinator-Anmeldung (koordinatorPlanKurz).
 * synapse_test:5433, privates Schema nur mit der Tabelle plans.
 *   node packages/core/tests/onboarding-tasksortierung-p22-t83.test.mjs
 * A reine Funktion: Prioritaet high > medium > low > ohne; gleiche Prioritaet: zuletzt angefasst zuerst; sonst Planreihenfolge.
 * B koordinatorPlanKurz: nur offene, nicht zurueckgestellte; hoechstens 5 + offen; top3 und gespeicherte Reihenfolge unveraendert.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t83_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t83-synthetic';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const basis=Date.parse('2026-10-01T10:00:00.000Z');
const um=min=>new Date(basis+min*60000).toISOString();
// angefasst = Minuten nach Anlage (null = nie angefasst: updatedAt == createdAt)
const task=(kurz,priority,angefasst=null,status='todo',extra={})=>({id:randomUUID(),kurz_id:kurz,title:'Titel '+kurz,description:'',status,
  ...(priority?{priority}:{}),createdAt:um(0),updatedAt:angefasst===null?um(0):um(angefasst),...extra});

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  await admin.query(`CREATE TABLE ${schema}.plans (LIKE public.plans INCLUDING ALL)`);
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  // Ladereihenfolge wie P22-T49: plans.js direkt zuerst geladen trifft einen Importzyklus (intern-tool/INTERN_SCHALTER)
  await load('packages/core/dist/services/agent-token-tools.js');
  const PL=await load('packages/core/dist/services/plans.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  // Planreihenfolge absichtlich gemischt
  const aktivTasks=[
    task('P1-T1','medium'),                    // nie angefasst
    task('P1-T2','low',30),
    task('P1-T3','medium',10),
    task('P1-T4','high'),
    task('P1-T5','medium',50),                 // juengste medium
    task('P1-T6',null),                        // ohne Prioritaet
    task('P1-T7','high',90,'done'),            // erledigt -> raus
    task('P1-T8','medium',95,'todo',{zurueckgestellt_bis:new Date(Date.now()+86400000).toISOString()}), // schlaeft -> raus
    task('P1-T9','low'),
    task('P1-T10','medium'),                   // nie angefasst, Gleichstand mit T1 -> Planreihenfolge
    task('P1-T11','high',5,'blocked'),
  ];

  // ================= A: reine Funktion =================
  const kopie=JSON.stringify(aktivTasks);
  const offen=aktivTasks.filter(t=>!['P1-T7','P1-T8'].includes(t.kurz_id));
  const sortiert=PL.onboardingTaskReihenfolge(offen).map(t=>t.kurz_id);
  check(JSON.stringify(sortiert)===JSON.stringify(['P1-T11','P1-T4','P1-T5','P1-T3','P1-T1','P1-T10','P1-T2','P1-T9','P1-T6']),
    'A Reihenfolge: high (angefasst vor nie) > medium (juengste zuerst, dann Planreihenfolge) > low > ohne ('+sortiert.join(',')+')');
  check(JSON.stringify(aktivTasks)===kopie,'A Eingabe unveraendert (keine Mutation)');
  const deutsch=PL.onboardingTaskReihenfolge([task('X1','niedrig'),task('X2','hoch'),task('X3','mittel')]).map(t=>t.kurz_id);
  check(JSON.stringify(deutsch)==='["X2","X3","X1"]','A deutsche Prioritaetswerte werden gleich eingeordnet');
  const gleich=PL.onboardingTaskReihenfolge([task('Y1','medium'),task('Y2','medium'),task('Y3','medium')]).map(t=>t.kurz_id);
  check(JSON.stringify(gleich)==='["Y1","Y2","Y3"]','A alle gleich und nie angefasst -> Planreihenfolge');

  // ================= B: koordinatorPlanKurz =================
  const plan=(id,kurz,name,aktiv,prio,tasks)=>pool.query(
    `INSERT INTO plans(id,project,name,description,goals,tasks,created_at,updated_at,kurz_id,aktiv,naechste_task_nr,prioritaet)
     VALUES($1,$2,$3,'',ARRAY[]::text[],$4,NOW(),NOW(),$5,$6,20,$7)`,[id,P,name,JSON.stringify(tasks),kurz,aktiv,prio]);
  await plan('t83-p1','P1','Aktiv',true,'mittel',aktivTasks);
  // Anderer Plan: top3 behaelt Planreihenfolge, obwohl P2-T3 zuletzt angefasst wurde
  await plan('t83-p2','P2','Andere',false,'hoch',[task('P2-T1','high'),task('P2-T2','high',20),task('P2-T3','high',80),task('P2-T4','high')]);
  const lage=await PL.koordinatorPlanKurz(P);
  console.log('BEISPIEL '+JSON.stringify(lage));
  check(lage.aktiver_plan?.offen===9,'B offen zaehlt alle offenen, nicht zurueckgestellten Tasks (9)');
  check(JSON.stringify(lage.aktiver_plan?.tasks)===JSON.stringify(['P1-T11 Titel P1-T11','P1-T4 Titel P1-T4','P1-T5 Titel P1-T5','P1-T3 Titel P1-T3','P1-T1 Titel P1-T1']),
    'B aktiver_plan.tasks: hoechstens 5 in neuer Reihenfolge');
  check(JSON.stringify(lage.top3)==='["1 P2-T1 Titel P2-T1","2 P2-T2 Titel P2-T2","3 P2-T3 Titel P2-T3"]','B top3 unveraendert (Planreihenfolge)');
  const gespeichert=(await pool.query("SELECT tasks FROM plans WHERE id='t83-p1'")).rows[0].tasks.map(t=>t.kurz_id);
  check(JSON.stringify(gespeichert)===JSON.stringify(aktivTasks.map(t=>t.kurz_id)),'B gespeicherte Planreihenfolge unveraendert');
  const geholt=(await PL.getPlan(P,'P1'))?.tasks?.map(t=>t.kurz_id)??[];
  check(geholt.indexOf('P1-T1')<geholt.indexOf('P1-T4'),'B plan(get) zeigt weiter Planreihenfolge');
}finally{
  try{await pool?.end?.();}catch(e){console.error('[t83] pool.end fehlgeschlagen:',e?.message);}
  try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('[t83] Schema-Aufraeumen fehlgeschlagen:',e?.message);}
  await admin.end();
}
console.log(`\n${checks-failures.length}/${checks} ok`);
if(failures.length){console.error('FEHLER:\n'+failures.join('\n'));process.exit(1);}
