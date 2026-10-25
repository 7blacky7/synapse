/**
 * P22-T139: Task-Bindung loesen auffindbar, profil_lesen trennt offene und erledigte gebundene Tasks, Produkt-Schalter
 * task_bindung_loesen_bei_done (Standard AUS). Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon.
 *  A task_bindung_aendern mit bindung_art 'offen' == task_bindung_entblocken (Bindung weg, Audit entblocken, Grund Pflicht);
 *    offen mit Identitaeten / festlegen offen -> bindung_ungueltig mit Loese-Hinweis; Schema enum == Beschreibung.
 *  B profil_lesen: gebundene_tasks nur offen (mit status), erledigte abgesetzt (anzahl, Kurzliste, Hinweis); gleiche Menge wie
 *    die Anmeldung (gebundeneTasks); keine Teilstring-Treffer fremder IDs.
 *  C Schalter: im Katalog, nur ausdruecklich, Standard AUS (done laesst die Bindung stehen); EIN -> done loest (UUID und Kurz-ID),
 *    Audit 'Task erledigt'; andere Status loesen nicht.
 *   node packages/core/tests/task-bindung-loesen-p22-t139.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Netz gesperrt: der Qdrant-Index der Plaene (indexNachziehen) scheitert hier erwartet und ist nicht Gegenstand des Tests.
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t139_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t139';
const failures=[];
let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}

try{
 await admin.query('CREATE SCHEMA '+schema);
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const sequence=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 // plans -> plan_tasks per Trigger (CREATE TABLE ... LIKE kopiert keine Trigger); gebundeneTasks liest den Task-Status aus plan_tasks.
 await pool.query(core.PLAN_TASK_SCHEMA_SQL);
 const C=core,USER={art:'user'};
 const ADM=await load('packages/core/dist/services/agent-profil-admin.js');
 const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
 const UPD=await load('packages/core/dist/services/agent-profil-update.js');
 const PL=await load('packages/core/dist/services/plans.js');
 const ident=async(id,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,P,name,rolle,'test']);
 await ident('t139-k','t139-koord','koordinator');await ident('t139-z','t139-ziel','subagent');await ident('t139-z2','t139-ziel2','subagent');
 const Kk={art:'identitaet',principal:{art:'identity',project:P,agent_id:'t139-k',identity_id:'t139-k',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null}};
 const adm=(a,args,akteur=Kk)=>C.fuehreW1bAdminAus(a,{project:P,...args},{akteur});
 const bindung=async task=>(await pool.query('SELECT art,identity_ids FROM plan_task_bindungen WHERE project=$1 AND task_id=$2',[P,task])).rows[0]??null;
 const audit=async task=>(await pool.query('SELECT aktion,alt,neu,wer,grund FROM plan_task_bindung_audit WHERE project=$1 AND task_id=$2 ORDER BY id',[P,task])).rows;
 const binde=(task,id='t139-z')=>adm('task_bindung_festlegen',{bindung_task_id:task,bindung_art:'identitaet',bindung_identity_ids:[id],grund:'Test T139 binden'});
 let T=[];

 await section('Vorbereitung',async()=>{
  check((await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Test T139 alles ein'},USER)).success===true,'Schalter alle EIN durch User');
  await pool.query(`INSERT INTO plans(id,project,name,description,goals,architecture,tasks,created_at,updated_at,kurz_id,aktiv,naechste_task_nr,prioritaet)
    VALUES($1,$2,'T139 Plan','',$3,'','[]'::jsonb,NOW(),NOW(),'P1',true,1,'mittel')`,[randomUUID(),P,[]]);
  for(let i=1;i<=8;i++)T.push(await PL.addTask(P,'T139 Task '+i,'Bindung '+i,'medium'));
  check(T.every(t=>t?.id&&t.kurz_id),'acht Tasks mit Kurz-ID',T.map(t=>t?.kurz_id));
 });

 await section('A aendern(offen) == entblocken',async()=>{
  const [t1,t2]=T;
  check((await binde(t1.id)).success===true&&(await binde(t2.id)).success===true,'zwei Tasks gebunden');
  const ohne=await adm('task_bindung_aendern',{bindung_task_id:t1.id,bindung_art:'offen'});
  check(ohne.success===false&&ohne.error==='grund_fehlt'&&(await bindung(t1.id))!==null,'offen ohne Grund -> grund_fehlt, Bindung bleibt',ohne);
  const r=await adm('task_bindung_aendern',{bindung_task_id:t1.id,bindung_art:'offen',grund:'Test T139 loesen ueber aendern'});
  check(r.success===true&&r.bindung?.art==='offen'&&r.geloest_wie==='task_bindung_entblocken','aendern offen: success, bindung offen',r);
  check((await bindung(t1.id))===null,'aendern offen: Zeile geloescht');
  const e=await adm('task_bindung_entblocken',{bindung_task_id:t2.id,grund:'Test T139 loesen ueber entblocken'});
  check(e.success===true&&e.bindung?.art==='offen'&&(await bindung(t2.id))===null,'entblocken: success, Zeile geloescht',e);
  const a1=(await audit(t1.id)).at(-1),a2=(await audit(t2.id)).at(-1);
  check(a1?.aktion==='entblocken'&&a1.grund==='Test T139 loesen ueber aendern'&&a1.wer==='t139-k','Audit aendern(offen): aktion entblocken, Grund, Akteur',a1);
  check(a1&&a2&&a1.aktion===a2.aktion&&JSON.stringify(a1.alt)===JSON.stringify(a2.alt)&&JSON.stringify(a1.neu)===JSON.stringify(a2.neu)&&a1.wer===a2.wer,'Audit aendern(offen) gleich wie entblocken (aktion, alt, neu, wer)',{a1,a2});
  const nochmal=await adm('task_bindung_aendern',{bindung_task_id:t1.id,bindung_art:'offen',grund:'Test T139 nochmal'});
  const nochmalE=await adm('task_bindung_entblocken',{bindung_task_id:t2.id,grund:'Test T139 nochmal'});
  check(nochmal.error==='keine_bindung'&&nochmalE.error==='keine_bindung','ohne Bindung: beide Wege keine_bindung',{nochmal,nochmalE});
  await binde(t1.id);
  const mitIds=await adm('task_bindung_aendern',{bindung_task_id:t1.id,bindung_art:'offen',bindung_identity_ids:['t139-z'],grund:'Test T139 offen mit IDs'});
  check(mitIds.success===false&&mitIds.error==='bindung_ungueltig'&&/task_bindung_entblocken/.test(mitIds.details?.hinweis??'')&&(await bindung(t1.id))!==null,'offen mit Identitaeten -> bindung_ungueltig mit Loese-Hinweis, Bindung bleibt',mitIds);
  const fest=await adm('task_bindung_festlegen',{bindung_task_id:T[7].id,bindung_art:'offen',grund:'Test T139 festlegen offen'});
  check(fest.success===false&&fest.error==='bindung_ungueltig'&&/bindung_art "offen"/.test(fest.details?.hinweis??''),'festlegen offen -> bindung_ungueltig mit Loese-Hinweis',fest);
  await adm('task_bindung_entblocken',{bindung_task_id:t1.id,grund:'Test T139 aufraeumen'});
  const sp=ADM.W1B_ADMIN_PARAMETER.bindung_art;
  check(JSON.stringify(sp.enum)===JSON.stringify(['identitaet','team','offen'])&&/offen/.test(sp.description)&&/task_bindung_entblocken/.test(sp.description),'Schema: enum identitaet|team|offen, Beschreibung nennt entblocken',sp);
 });

 await section('B profil_lesen trennt offen/erledigt',async()=>{
  const [,,t3,t4]=T;
  await binde(t3.id);await binde(t4.id);await binde('T139-ohne-plan');
  await binde(T[6].id,'t139-z2');
  const d=await PL.updateTask(P,t4.id,{status:'done'});
  check(d?.status==='done'&&(await bindung(t4.id))!==null,'Schalter AUS: done laesst die Bindung stehen');
  const l=await adm('profil_lesen',{ziel_identity_id:'t139-z'});
  check(l.success===true,'profil_lesen ok',l.error);
  const offen=(l.gebundene_tasks??[]).map(t=>t.task_id).sort();
  check(JSON.stringify(offen)===JSON.stringify([t3.id,'T139-ohne-plan'].sort()),'gebundene_tasks: nur offene (inkl. Task ohne Plan-Zeile)',offen);
  const z3=(l.gebundene_tasks??[]).find(t=>t.task_id===t3.id);
  check(z3?.status==='todo'&&z3.kurz_id===t3.kurz_id&&z3.art==='identitaet'&&typeof z3.titel==='string','je Task status, kurz_id, titel, art',z3);
  const er=l.erledigte_gebundene_tasks;
  check(er?.anzahl===1&&er.tasks?.[0]?.task_id===t4.id&&er.tasks[0].kurz_id===t4.kurz_id&&/task_bindung_entblocken/.test(er.hinweis??''),'erledigte abgesetzt: anzahl 1, Kurzliste, Loese-Hinweis',er);
  check(!offen.includes(T[6].id),'keine Teilstring-Treffer: Task von t139-z2 fehlt bei t139-z');
  const anmeldung=(await UPD.gebundeneTasks(P,'t139-z')).map(t=>t.task_id).sort();
  check(JSON.stringify(anmeldung)===JSON.stringify(offen),'gleiche Menge wie die Anmeldung (gebundeneTasks)',{anmeldung,offen});
  const l2=await adm('profil_lesen',{ziel_identity_id:'t139-z2'});
  check(l2.erledigte_gebundene_tasks?.anzahl===0&&!('hinweis' in (l2.erledigte_gebundene_tasks??{}))&&(l2.gebundene_tasks??[]).length===1,'ohne erledigte: anzahl 0, kein Hinweis',l2.erledigte_gebundene_tasks);
 });

 await section('C Schalter task_bindung_loesen_bei_done',async()=>{
  const F='task_bindung_loesen_bei_done';
  check(SCH.PROFIL_PRODUKT_FUNKTIONEN.includes(F)&&SCH.NUR_AUSDRUECKLICH.includes(F)&&!SCH.STANDARD_EIN.includes(F),'im Katalog, nur ausdruecklich, nicht Standard EIN');
  check(ADM.W1B_ADMIN_PARAMETER.profil_funktion.enum.includes(F),'in admin profil_funktion');
  const st=await SCH.leseProfilProduktSchalter(F,P);
  check(st.aktiv===false,'Standard AUS, auch nach alle EIN',st);
  const [,,,,t5,t6]=T;
  check((await adm('profil_schalter_setzen',{profil_funktion:F,aktiv:true,ebene:'projekt',grund:'Test T139 loesen bei done EIN'},USER)).success===true,'Schalter EIN (projekt) durch User');
  await binde(t5.id);
  await PL.updateTask(P,t5.id,{status:'in_progress'});
  check((await bindung(t5.id))!==null,'EIN: in_progress loest nicht');
  await PL.updateTask(P,t5.id,{status:'done'});
  check((await bindung(t5.id))===null,'EIN: done loest die Bindung (UUID)');
  const a=(await audit(t5.id)).at(-1);
  check(a?.aktion==='entblocken'&&a.wer==='system:task_erledigt'&&a.grund==='Task erledigt'&&a.neu?.art==='offen'&&a.alt?.identity_id==='t139-z','Audit: entblocken, system:task_erledigt, Grund Task erledigt',a);
  const n=(await audit(t5.id)).length;
  await binde(t5.id);
  await PL.updateTask(P,t5.id,{status:'done'});
  check((await bindung(t5.id))!==null&&(await audit(t5.id)).length===n+1,'schon erledigt -> erneutes done loest nicht (nur der Uebergang)');
  await binde(t6.kurz_id);
  await PL.updateTask(P,t6.kurz_id,{status:'done'});
  check((await bindung(t6.kurz_id))===null,'EIN: Bindung unter der Kurz-ID wird ebenfalls geloest');
  await adm('profil_schalter_setzen',{profil_funktion:F,aktiv:false,ebene:'projekt',grund:'Test T139 loesen bei done AUS'},USER);
  await binde(T[7].id);
  await PL.updateTask(P,T[7].id,{status:'done'});
  check((await bindung(T[7].id))!==null,'wieder AUS: done laesst die Bindung stehen');
 });

 console.log('P22-T139: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
