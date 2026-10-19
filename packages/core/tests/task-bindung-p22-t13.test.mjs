/**
 * P22-T13 Paket T (Task-Bindung, K14): Dienst gegen synapse_test:5433, privates Schema, synthetische Daten.
 *   node packages/core/tests/task-bindung-p22-t13.test.mjs
 * Schema 113 wird im privaten Schema eingespielt (wie w1b-phase-v). Prueft: AUS-Verhalten, offen/identitaet/team,
 * fremde Identitaet mit Grund abgelehnt, Entblocken nur mit Grund, leeres Team kein Entblocken, Recht, Mitglieder, Audit.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t13_task_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t13-task-synthetic', ANDERES='p22-t13-task-anders';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function wirft(p,code,label){
  try{await p;check(false,label+' (kein Fehler)');}
  catch(e){check(e?.code===code,label+' (Code '+(e?.code??e?.message)+')');}
}
const user={art:'user'};
const akt=(id,rolle,proj=P)=>({art:'identitaet',principal:{art:'identity',project:proj,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  // Basis (111) kopieren; Schema 113 einspielen - alles auf EINER Verbindung mit search_path = privates Schema
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  // (Kopie oben)
  const sql113=readFileSync(join(repo,'packages/core/src/db/schema-sql/113_agent_profil.sql'),'utf8');
  const cl=await admin.connect();
  try{await cl.query('SET search_path TO '+schema);for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));await cl.query(sql113);}
  finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const C=await load('packages/core/dist/services/agent-profil-vertrag.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();
  const setzeSchalter=async(an)=>{
    await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='task_bindung'");
    if(an)await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'task_bindung',true,'Test Paket T','user')");
  };
  for(const [id,proj,rolle] of [['k1',P,'koordinator'],['a1',P,'subagent'],['b1',P,'subagent'],['c1',P,'subagent'],['x1',ANDERES,'subagent']]){
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$1,$1,$3,'test')",[id,proj,rolle]);
  }

  // AUS (Standard): nichts wirkt, Gate blockiert nicht
  await setzeSchalter(false);
  await wirft(C.taskBindungDienst.legeFest(P,'T-aus',{art:'identitaet',identity_id:'a1'},user,'Test'),'funktion_aus','AUS: Festlegen abgewiesen');
  check((await C.taskBindungDienst.leseBindung(P,'T-aus')).art==='offen','AUS: keine Bindung entstanden');
  check(await C.pruefeTaskBindungZugriff(P,'T-aus',null)===null,'AUS: Gate blockiert nicht');

  // EIN
  await setzeSchalter(true);
  check(await C.pruefeTaskBindungZugriff(P,'T-offen',null)===null,'offen: jede Identitaet/ohne Identitaet erlaubt');
  await C.taskBindungDienst.legeFest(P,'T-einzel',{art:'identitaet',identity_id:'a1'},user,'Freigabe Einzel');
  check(await C.pruefeTaskBindungZugriff(P,'T-einzel','a1')===null,'identitaet: berechtigte Identitaet erlaubt (Positivkontrolle)');
  const ablehnung=await C.pruefeTaskBindungZugriff(P,'T-einzel','b1','T-einzel');
  check(typeof ablehnung==='string'&&ablehnung.includes('gebunden')&&ablehnung.includes('T-einzel'),'identitaet: fremde Identitaet mit Grund abgelehnt');
  check(typeof await C.pruefeTaskBindungZugriff(P,'T-einzel',null)==='string','identitaet: ohne Identitaet (Legacy-Agent) abgelehnt');
  await wirft(C.taskBindungDienst.legeFest(P,'T-einzel',{art:'identitaet',identity_id:'b1'},user,'doppelt'),'bindung_existiert','festlegen auf vorhandene Bindung abgewiesen');
  // Team
  await C.taskBindungDienst.legeFest(P,'T-team',{art:'team',identity_ids:['a1','b1']},akt('k1','koordinator'),'Team Test');
  check(await C.pruefeTaskBindungZugriff(P,'T-team','a1')===null&&await C.pruefeTaskBindungZugriff(P,'T-team','b1')===null,'team: beide Mitglieder erlaubt');
  check(typeof await C.pruefeTaskBindungZugriff(P,'T-team','c1')==='string','team: Nichtmitglied im selben Projekt abgelehnt');
  check(typeof await C.pruefeTaskBindungZugriff(P,'T-team','x1')==='string','team: fremdes Projekt abgelehnt');
  await wirft(C.taskBindungDienst.legeFest(P,'T-fremd',{art:'team',identity_ids:['a1','x1']},user,'fremd'),'identitaet_fremd','team mit Mitglied aus fremdem Projekt abgewiesen');
  // Recht
  await wirft(C.taskBindungDienst.legeFest(P,'T-recht',{art:'identitaet',identity_id:'a1'},akt('a1','subagent'),'Agent'),'recht_fehlt','Agent darf Bindung nicht setzen');
  check((await C.taskBindungDienst.leseBindung(P,'T-recht')).art==='offen','Recht: unveraendert offen');
  await C.taskBindungDienst.legeFest(P,'T-koord',{art:'identitaet',identity_id:'b1'},akt('k1','koordinator'),'Koordinator');
  check((await C.taskBindungDienst.leseBindung(P,'T-koord')).art==='identitaet','Koordinator darf festlegen');
  // Pflicht-Grund und leeres Team
  await wirft(C.taskBindungDienst.aendere(P,'T-team',{art:'team',identity_ids:['a1']},user,'  '),'grund_fehlt','Teamaenderung ohne Grund abgewiesen');
  await wirft(C.taskBindungDienst.aendere(P,'T-team',{art:'team',identity_ids:[]},user,'leer'),'team_leer','leeres Team abgewiesen');
  await wirft(C.taskBindungDienst.entblocke(P,'T-team',user,''),'grund_fehlt','Entblocken ohne Grund abgewiesen');
  const teamNachAblehnung=await C.taskBindungDienst.leseBindung(P,'T-team');
  check(teamNachAblehnung.art==='team'&&teamNachAblehnung.identity_ids.length===2,'Ablehnungen lassen Team unveraendert');
  await C.taskBindungDienst.aendere(P,'T-team',{art:'team',identity_ids:['a1','c1']},user,'c1 aufgenommen, b1 raus');
  check(await C.pruefeTaskBindungZugriff(P,'T-team','c1')===null&&typeof await C.pruefeTaskBindungZugriff(P,'T-team','b1')==='string','Teamaenderung wirkt');
  // Entblocken
  await C.taskBindungDienst.legeFest(P,'T-entblock',{art:'identitaet',identity_id:'a1'},user,'Test Entblock');
  await C.taskBindungDienst.entblocke(P,'T-entblock',akt('k1','koordinator'),'Freigabe fuer alle');
  check((await C.taskBindungDienst.leseBindung(P,'T-entblock')).art==='offen','Entblocken stellt offen her');
  check(await C.pruefeTaskBindungZugriff(P,'T-entblock','b1')===null,'nach Entblocken: fremde Identitaet frei');
  await wirft(C.taskBindungDienst.entblocke(P,'T-entblock',user,'nochmal'),'keine_bindung','Entblocken ohne Bindung abgewiesen');
  // update_task-Gate: EIN -> fremde Identitaet/fremdes Projekt abgelehnt, Mitglied/Koordinator/User erlaubt
  const gateEin=(p,id)=>C.pruefeTaskBindungBearbeitenFuer(P,id,p,id);
  check(typeof await gateEin(akt('b1','subagent').principal,'T-einzel')==='string','update_task: fremde Identitaet abgelehnt');
  check(await gateEin(akt('a1','subagent').principal,'T-einzel')===null,'update_task: Bindungsmitglied erlaubt');
  check(await gateEin(akt('k1','koordinator').principal,'T-einzel')===null,'update_task: Koordinator erlaubt');
  check(await C.pruefeTaskBindungBearbeitenFuer(P,'T-einzel',null)===null,'update_task: ohne Principal unveraendert');
  check(typeof await gateEin(akt('c1','subagent',ANDERES).principal,'T-einzel')==='string','update_task: fremdes Projekt abgelehnt');
  check(await gateEin(akt('b1','subagent').principal,'T-offen')===null,'update_task: offene Task frei');
  await setzeSchalter(false);
  check(await gateEin(akt('b1','subagent').principal,'T-einzel')===null,'update_task AUS: unveraendert erlaubt');
  await setzeSchalter(true);
  // P22-T18: Legacy-Agent (agent_id ohne Token-Principal) auf gebundener Task -> nur mit Grund, Audit
  const legacy=(id,grund,agent='legacy-x')=>C.pruefeTaskBindungBearbeitenFuer(P,id,null,id,{agent_id:agent,grund});
  const audN=async(id)=>(await pool.query('SELECT aktion,grund,wer,alt,neu,actor_identity_id FROM plan_task_bindung_audit WHERE project=$1 AND task_id=$2 ORDER BY id',[P,id])).rows;
  const vorLeg=(await audN('T-einzel')).length;
  await wirft(legacy('T-einzel',undefined),'grund_noetig','Legacy ohne Grund abgewiesen');
  await wirft(legacy('T-einzel','   '),'grund_noetig','Legacy mit leerem Grund abgewiesen');
  try{await legacy('T-einzel',undefined);}catch(e){check(/grund angeben/.test(e.message)&&e.message.includes('T-einzel')&&e.message.includes('a1'),'Legacy-Abweisung nennt Hinweis "grund angeben" und die Bindung');}
  check((await audN('T-einzel')).length===vorLeg,'Abweisung ohne Audit');
  check(await legacy('T-einzel','  Status nach Absprache  ')===null,'Legacy mit Grund erlaubt');
  const audL=await audN('T-einzel');
  const zl=audL[audL.length-1];
  check(audL.length===vorLeg+1&&zl.aktion==='aendern'&&zl.wer==='legacy:legacy-x'&&zl.grund==='[update_task ohne Token] Status nach Absprache'&&zl.actor_identity_id===null&&zl.neu?.ereignis==='update_task_legacy'&&zl.alt?.identity_id==='a1'&&zl.neu?.identity_id==='a1','Audit: wer legacy:<id>, Grund getrimmt, Bindung unveraendert, Ereignis update_task_legacy');
  check((await C.taskBindungDienst.leseBindung(P,'T-einzel')).identity_id==='a1','Bindung nach Legacy-Update unveraendert');
  await C.taskBindungDienst.legeFest(P,'T-team18',{art:'team',identity_ids:['a1','b1']},user,'Team fuer T18');
  try{await legacy('T-team18',undefined);check(false,'Legacy ohne Grund auf Team-Task abgewiesen');}catch(e){check(e?.code==='grund_noetig'&&e.message.includes('Team a1, b1'),'Legacy ohne Grund auf Team-Task abgewiesen, Hinweis nennt Team');}
  check(await legacy('T-team18','Team-Task bearbeitet')===null,'Legacy mit Grund auf Team-Task erlaubt');
  check(await legacy('T-offen',undefined)===null&&(await audN('T-offen')).length===0,'Legacy auf offener Task: unveraendert, kein Audit');
  check(await legacy('T-einzel',undefined,'koordinator')===null&&await legacy('T-einzel',undefined,'koordinator-w11')===null,'Legacy-Koordinator (Namensmuster) ohne Grund unveraendert');
  check(await C.pruefeTaskBindungBearbeitenFuer(P,'T-einzel',null,'T-einzel',{grund:'nur Grund'})===null&&await C.pruefeTaskBindungBearbeitenFuer(P,'T-einzel',null,'T-einzel',{agent_id:'  '})===null,'User-Pfad (ohne agent_id) unveraendert');
  check(await C.pruefeTaskBindungBearbeitenFuer(P,'T-einzel',akt('a1','subagent').principal,'T-einzel',{agent_id:'legacy-x'})===null&&typeof await C.pruefeTaskBindungBearbeitenFuer(P,'T-einzel',akt('b1','subagent').principal,'T-einzel',{agent_id:'legacy-x',grund:'Grund darf die Token-Pruefung nicht umgehen'})==='string','Token-Principal: Mitglied unveraendert, fremde Identitaet trotz Grund abgelehnt');
  check((await audN('T-einzel')).length===vorLeg+1,'Token-Pfade und Koordinator schreiben kein Legacy-Audit');
  await setzeSchalter(false);
  check(await legacy('T-einzel',undefined)===null&&(await audN('T-einzel')).length===vorLeg+1,'Schalter AUS: Legacy ohne Grund unveraendert erlaubt, kein Audit');
  await setzeSchalter(true);
  // P22-T18 End-to-End ueber plans.updateTask
  const PL=await load('packages/core/dist/services/plans.js');
  await pool.query(`INSERT INTO plans(id,project,name,description,goals,architecture,tasks,created_at,updated_at,kurz_id,aktiv,naechste_task_nr,prioritaet)
    VALUES($1,$2,'E2E T18','',$3,'','[]'::jsonb,NOW(),NOW(),'P1',true,1,'mittel')`,[randomUUID(),P,[]]);
  const et=await PL.addTask(P,'E2E T18','Legacy-Gate','medium');
  await C.taskBindungDienst.legeFest(P,et.id,{art:'identitaet',identity_id:'a1'},user,'E2E Bindung');
  let e2eFehler;try{await PL.updateTask(P,et.id,{status:'in_progress'},null,{agent_id:'legacy-x'});}catch(e){e2eFehler=e;}
  check(e2eFehler?.code==='grund_noetig'&&/grund angeben/.test(e2eFehler.message),'E2E updateTask: Legacy ohne Grund abgewiesen');
  check((await PL.getAllePlaene(P)).flatMap(p=>p.tasks).find(t=>t.id===et.id)?.status==='todo','E2E: Status nach Abweisung unveraendert');
  const er=await PL.updateTask(P,et.id,{status:'in_progress'},null,{agent_id:'legacy-x',grund:'E2E: Task uebernommen nach Absprache'});
  check(er?.status==='in_progress','E2E updateTask: Legacy mit Grund erlaubt, Status gesetzt');
  const audEt=await audN(et.id);
  check(audEt.map(r=>r.aktion).join()==='festlegen,aendern'&&audEt[1].wer==='legacy:legacy-x'&&audEt[1].grund.endsWith('E2E: Task uebernommen nach Absprache'),'E2E: Audit-Eintrag fuer das Legacy-Update');
  check((await PL.updateTask(P,et.id,{status:'done'}))?.status==='done','E2E updateTask: reiner User-Pfad (ohne bearbeiter) unveraendert');
  // Audit
  const aud=(await pool.query('SELECT aktion,grund,alt,neu,wer FROM plan_task_bindung_audit WHERE project=$1 AND task_id=$2 ORDER BY id',[P,'T-team'])).rows;
  check(aud.map(r=>r.aktion).join()==='festlegen,aendern','Audit T-team: festlegen, aendern (Ablehnungen ohne Audit)');
  check(aud[1]?.grund==='c1 aufgenommen, b1 raus'&&aud[1]?.alt&&aud[1]?.neu,'Audit: alt/neu und sichtbarer Grund');
  const audE=(await pool.query('SELECT aktion,grund,wer,neu FROM plan_task_bindung_audit WHERE project=$1 AND task_id=$2 ORDER BY id',[P,'T-entblock'])).rows;
  check(audE.map(r=>r.aktion).join()==='festlegen,entblocken'&&audE[1].grund==='Freigabe fuer alle'&&audE[1].wer==='k1','Audit Entblocken mit Grund und Akteur');
  const alleAudit=JSON.stringify((await pool.query('SELECT * FROM plan_task_bindung_audit')).rows);
  check(!alleAudit.includes('sai_'),'Audit ohne Token');
}catch(e){
  failures.push('Abschnitt: '+e.message);console.error('FAIL Abschnitt: '+e.stack);
}finally{
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
  await admin.end();
  console.log('Pruefungen: '+checks+', Fehler: '+failures.length);
  process.exit(failures.length?1:0);
}
