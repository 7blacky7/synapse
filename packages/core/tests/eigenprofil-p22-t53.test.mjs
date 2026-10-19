/**
 * P22-T53 (User 58c38995, ersetzt F2 aus a0f710e0 Punkt 4; ausweis-fix 27989-27997):
 *  (1) Koordinator und Main-Agent aendern ihr EIGENES Profil (Historie, CAS); andere Rollen eigenprofil_nicht_aenderbar.
 *  (2) Subagenten-Ausweise unter kontext des eigenen Koordinator-Profils: offen gespeichert, Audit und Antworten an Dritte maskiert.
 *  (3) profil.kontext.memories/tasks: Verweise per Name, Anmeldung nur eine Zeile (Art + Name + Titel + Abrufweg, kein Volltext).
 * Nur synapse_test:5433, eigenes privates Schema.   node packages/core/tests/eigenprofil-p22-t53.test.mjs
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 SYNAPSE_AGENT_TOKEN_SCHLUESSEL:'ab'.repeat(32),QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t53_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let checks=0,core,pool;
const P='t53-projekt',HP='synapse-hauptagent';
const AUS1='sai_'+'t53a',AUS2='sai_'+'t53b';
const MASKE=/sai_t53[ab]/;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+String(e.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));console.error('FAIL Abschnitt '+name+': '+String(e.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));}
}
const code=async fn=>{try{await fn();return null;}catch(e){return e.code??('X:'+e.message);}};
const rows=async(sql,v=[])=>(await pool.query(sql,v)).rows;
const one=async(sql,v=[])=>(await rows(sql,v))[0];
const user={art:'user'};
const pr=(id,rolle,p=P)=>({art:'identitaet',principal:{art:'identity',project:p,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
const rev=async id=>(await one('SELECT profil_revision r FROM agent_identitaeten WHERE id=$1',[id])).r;

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES
  ('k1',$1,'k1','k1','koordinator','test'),('k2',$1,'k2','k2','koordinator','test'),('s1',$1,'s1','s1','subagent','test'),
  ('hm',$2,'hauptagent','hauptagent','main','test'),('hs',$2,'hs','hs','subagent','test')`,[P,HP]);
 process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
 try{await core.setzeProfilProduktSchalter({ebene:'global',funktion:'profilverwaltung',aktiv:true,grund:'test p22-t53'},{system:'user'});}
 finally{process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';}
 const A=core.W1B_DIENSTE.profil;
 const DA=await load('packages/core/dist/services/agent-profil-dienst-a.js');
 const K1=pr('k1','koordinator'),K2=pr('k2','koordinator'),S1=pr('s1','subagent'),HM=pr('hm','main',HP),HS=pr('hs','subagent',HP);
 const ch=(id,r,patch,akteur,extra={})=>A.aendereProfil({identity_id:id,erwartete_revision:r,patch,grund:'Test P22-T53',...extra},akteur);
 const adm=(action,args,akteur)=>core.fuehreW1bAdminAus(action,args,{akteur});

 await section('(1) Eigenprofil: Koordinator ja, andere Rollen nein, CAS + Historie',async()=>{
  check((await ch('k1',0,{briefing:'eigen'},K1)).profil_revision===1,'Koordinator aendert sein Eigenprofil (Dienst)');
  const h=await A.profilHistorie('k1',K1);
  check(h.length===1&&h[0].wer==='k1'&&h[0].grund==='Test P22-T53','Historie mit Akteur und Grund');
  check(await code(()=>ch('k1',0,{briefing:'alt'},K1))==='profil_revision_veraltet','CAS bleibt');
  check(await code(()=>ch('s1',0,{briefing:'x'},S1))==='eigenprofil_nicht_aenderbar','Subagent eigenes Profil -> eigenprofil_nicht_aenderbar (Dienst)');
  const sa=await adm('profil_aendern',{project:P,ziel_identity_id:'s1',erwartete_revision:0,profil_patch:{briefing:'x'},grund:'Eigenprofil Subagent'},S1);
  check(sa.success===false&&sa.error==='eigenprofil_nicht_aenderbar'&&core.w1bFehlerStatus(sa.error)===403,'Subagent eigenes Profil ueber admin -> eigenprofil_nicht_aenderbar (403)');
  const sr=await adm('profil_rollback',{project:P,ziel_identity_id:'s1',ziel_revision:1,erwartete_revision:0,grund:'Eigenprofil Subagent'},S1);
  check(sr.error==='eigenprofil_nicht_aenderbar','Subagent eigenes Rollback -> eigenprofil_nicht_aenderbar');
  const ka=await adm('profil_aendern',{project:P,ziel_identity_id:'k1',erwartete_revision:1,profil_patch:{briefing:'admin'},grund:'Eigenprofil Koordinator'},K1);
  check(ka.success===true&&ka.profil_revision===2,'Koordinator eigenes Profil ueber admin '+JSON.stringify(ka));
  check((await ch('k1',2,{effort:'hoch'},K2)).profil_revision===3,'anderer Koordinator aendert fremdes Koordinator-Profil');
  check(await code(()=>ch('k1',3,{effort:'x'},S1))==='recht_fehlt','Subagent aendert fremdes Profil nicht');
  check(await rev('s1')===0&&(await one('SELECT count(*)::int n FROM agent_profil_revisionen WHERE identity_id=$1',['s1'])).n===0,'abgewiesene Eigenaenderung schreibt nichts');
  check(core.darfProfilAendern(S1,{identity_id:'s1',project:P})===false&&core.darfProfilAendern(K1,{identity_id:'k1',project:P})===true
   &&core.darfProfilAendern(HM,{identity_id:'hm',project:HP})===true&&core.darfProfilAendern(K1,{identity_id:'k1',project:'anders'})===false,'darfProfilAendern (reine Regel)');
 });

 await section('(1) Main-Agent: eigenes Profil ja, Rahmen nur User',async()=>{
  check((await ch('hm',0,{briefing:'main'},HM)).profil_revision===1,'Main aendert sein Eigenprofil');
  check(await code(()=>ch('hm',1,{startrezept:{erlaubte_modelle:['x']}},HM))==='main_rahmen_nur_user','Main: startrezept nur User');
  check(await code(()=>ch('hm',1,{rolle:'koordinator'},HM))==='main_rahmen_nur_user','Main: rolle nur User');
  check(await code(()=>ch('hm',1,{zuschnitt:{standard:'erlaubt'}},HM))==='main_rahmen_nur_user','Main: zuschnitt nur User');
  check((await ch('hm',1,{startrezept:{erlaubte_modelle:['x']}},user)).profil_revision===2,'User setzt Main-Rahmen');
  const ma=await adm('profil_aendern',{project:HP,ziel_identity_id:'hm',erwartete_revision:2,profil_patch:{kontext_stufe:'kompakt'},grund:'Main selbst'},HM);
  check(ma.success===true&&ma.profil_revision===3,'Main eigenes Profil ueber admin '+JSON.stringify(ma));
  check((await adm('profil_historie',{project:HP,ziel_identity_id:'hm'},HM)).revisionen?.length===3,'Main liest eigene Historie ueber admin');
  check(await code(()=>A.rollbackProfil('hm',1,3,HM,'Main Rollback'))==='main_rahmen_nur_user','Main: Rollback auf Stand ohne Rahmen nur User');
  check((await adm('profil_aendern',{project:HP,ziel_identity_id:'hs',erwartete_revision:0,profil_patch:{briefing:'x'},grund:'Main fremd'},HM)).error==='recht_fehlt','Main aendert fremdes Profil nicht');
  check(await code(()=>ch('hs',0,{briefing:'x'},HS))==='eigenprofil_nicht_aenderbar','Subagent im Main-Bereich: eigenes Profil nicht');
  check(await code(()=>ch('hs',0,{briefing:'x'},pr('hs','main',HP)))==='recht_fehlt','Principal behauptet main, PG sagt subagent -> recht_fehlt');
 });

 await section('(2) Ausweise im kontext des eigenen Koordinator-Profils',async()=>{
  let r=await rev('k1');
  check((await ch('k1',r,{kontext:{subagenten:[{name:'claude-w13-r',ausweis:AUS1}]}},K1)).profil_revision===r+1,'Koordinator legt Subagenten-Ausweis im eigenen kontext ab');
  check(JSON.stringify((await one('SELECT profil FROM agent_identitaeten WHERE id=$1',['k1'])).profil.kontext).includes(AUS1),'offen gespeichert (wie der Ausweis selbst)');
  const eigen=JSON.stringify(await A.profilHistorie('k1',K1)),fremd=JSON.stringify(await A.profilHistorie('k1',K2)),vomUser=JSON.stringify(await A.profilHistorie('k1',user));
  check(eigen.includes(AUS1)&&vomUser.includes(AUS1),'Inhaber und User sehen den Ausweis');
  check(!MASKE.test(fremd)&&fremd.includes('[maskiert]'),'anderer Koordinator sieht ihn maskiert');
  const fa=await adm('profil_historie',{project:P,ziel_identity_id:'k1'},K2);
  check(fa.success&&!MASKE.test(JSON.stringify(fa)),'Tool-Antwort an Dritte (admin profil_historie) maskiert');
  r=await rev('k1');
  check(await code(()=>ch('k1',r,{kontext:{subagenten:[{ausweis:AUS2}]}},K2))==='inhalt_enthaelt_ausweis','anderer Koordinator schreibt keinen Ausweis in fremden kontext');
  check((await ch('k1',r,{briefing:'von k2'},K2)).profil_revision===r+1,'anderer Koordinator aendert uebrige Felder weiter');
  r=await rev('k1');
  check(await code(()=>ch('k1',r,{briefing:'x '+AUS1},K1))==='inhalt_enthaelt_ausweis','Ausweis ausserhalb kontext abgelehnt');
  check(await code(()=>ch('k1',r,{rolle:'subagent'},K1))==='inhalt_enthaelt_ausweis','Rolle weg von koordinator mit Ausweisen im kontext abgelehnt');
  check(await code(()=>ch('s1',0,{kontext:{a:AUS2}},user))==='inhalt_enthaelt_ausweis','kein Ausweis im kontext eines Nicht-Koordinators (auch nicht durch den User)');
  check(await code(()=>ch('k1',r,{kontext:{token:'x'}},K1))==='inhalt_enthaelt_zugangswert','Zugangswert-Schluessel im kontext abgelehnt');
  check(await code(()=>ch('k1',r,{kontext:['x']},K1))==='inhalt_ungueltig','kontext muss Objekt sein');
  check((await ch('k1',r,{kontext:{subagenten:[{ausweis:AUS2}]}},user)).profil_revision===r+1,'User legt Ausweis im Koordinator-kontext ab');
  const mitAus2=await rev('k1');
  check((await A.rollbackProfil('k1',1,mitAus2,K2,'Rollback ohne kontext')).profil_revision===mitAus2+1,'Rollback auf Stand ohne Ausweis durch anderen Koordinator');
  check(await code(()=>A.rollbackProfil('k1',mitAus2,mitAus2+1,K2,'Rollback mit Ausweis'))==='inhalt_enthaelt_ausweis','anderer Koordinator holt Ausweise nicht per Rollback zurueck');
  check((await A.rollbackProfil('k1',mitAus2,mitAus2+1,K1,'eigener Rollback')).profil_revision===mitAus2+2,'Inhaber holt eigenen Stand per Rollback zurueck');
  check(await code(()=>DA.pruefeProfilInhalt({kontext:{a:AUS1}}))==='inhalt_enthaelt_ausweis'&&await code(()=>DA.pruefeProfilInhalt({kontext:{a:AUS1}},{ausweisImKontext:true}))===null,'Strukturpruefung: Ausweis im kontext nur mit Freigabe');
  check(DA.maskiereAusweise({a:['x '+AUS1]}).a[0]==='x [maskiert]'&&DA.maskiereAusweise(null)===null,'maskiereAusweise');
  const audit=JSON.stringify(await rows('SELECT alt,neu,grund FROM agent_identitaet_audit'));
  check(audit.length>10&&!MASKE.test(audit),'Audit (Log) ohne Ausweiswerte');
 });

 await section('(3) Verweise per Name im Profil, Anmeldung eine Zeile ohne Volltext',async()=>{
  await core.writeMemory(P,'koordinator-subagent-ausweise','# Subagenten-Ausweise\nGeheimer Volltext '+AUS1+' bleibt hier.','note',[]);
  await pool.query("INSERT INTO plan_tasks(id,project,plan_id,task,updated_at) VALUES($1,$2,'pl-t53',$3::jsonb,$4)",[randomUUID(),P,JSON.stringify({kurz_id:'P1-T9',title:'Testaufgabe',status:'todo'}),new Date().toISOString()]).catch(e=>console.error('Hinweis plan_tasks: '+e.message));
  let r=await rev('k1');
  check(await code(()=>ch('k1',r,{kontext:{memories:['ungueltig name']}},K1))==='inhalt_ungueltig','kontext.memories validiert');
  check((await ch('k1',r,{kontext:{memories:['koordinator-subagent-ausweise','fehlt-x'],tasks:['P1-T9']}},K1)).profil_revision===r+1,'Koordinator verweist im eigenen Profil auf Memory/Task');
  const ON=await load('packages/core/dist/services/agent-onboarding.js');
  check(typeof ON.holeAgentOnboarding==='function','Onboarding-Modul geladen');
  const zeile=typeof ON.kontextVerweiseFuer==='function'?await ON.kontextVerweiseFuer('k1',P):undefined;
  if(zeile!==undefined){
   check(typeof zeile==='string'&&zeile.includes('memory koordinator-subagent-ausweise "Subagenten-Ausweise"')&&zeile.includes('memory fehlt-x (nicht gefunden)'),'Zeile: Art + Name + Titel '+zeile);
   check(!zeile.includes('Geheimer Volltext')&&!MASKE.test(zeile),'kein Volltext, kein Ausweis');
   check(zeile.includes('memory(action:"read"'),'Abrufweg genannt');
   check(zeile.includes('task P1-T9 "Testaufgabe"')&&zeile.includes('plan(action:"get"'),'Task-Verweis mit Titel und Abrufweg');
   check(zeile.split('\n').length===1,'genau eine Zeile');
   check(await ON.kontextVerweiseFuer('s1',P)===null,'ohne Eintraege keine Zeile');
  }else check(false,'kontextVerweiseFuer nicht exportiert');
 });

 console.log('P22-T53: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(String(error.stack).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]'));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
