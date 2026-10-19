/**
 * P22-T34: Legacy-Koordinator (ohne Ausweis) darf ALLES, was User/Koordinator in der Profil-/Ausweis-/Schalterverwaltung duerfen
 * (memory entscheidung-agenten-ausweis-2026-10-19 Punkt 3a). Ausnahmen 'nur User' bleiben. Subagent/Spezialist/ohne Akteur nie.
 * Matrix: jede admin-Aktion des W1b-Dispatchers x 6 Akteure. Neue Aktionen ohne Matrixeintrag lassen den Test scheitern.
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/w1b-legacy-koordinator-p22-t34.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T34_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_AGENT_START_TOKEN_TTL_MIN:'10',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t34_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t34',Q='p22-t34-fremd';
const failures=[];
let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}

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

 const C=core,USER={art:'user'};
 const ident=async(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 const akt=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 const KOORD='koordinator-t34',SUB='subagent-t34';
 await ident('t34-k',P,'t34-koord','koordinator');await ident('t34-s',P,'t34-sub','subagent');await ident('t34-z',P,'t34-ziel','subagent');
 await ident('t34-tok',P,'koordinator-t34-tok','koordinator');
 const Kk=akt('t34-k',P,'koordinator'),Ss=akt('t34-s',P,'subagent');
 const adm=(a,args,akteur,agent)=>C.fuehreW1bAdminAus(a,{project:P,...(agent?{agent_id:agent}:{}),...args},{akteur});
 const recht=r=>r&&r.success===false&&r.error==='recht_fehlt';

 // Alle Produkt-Schalter EIN (User), danach Fixtures: Typ, Persona-Vorlage
 await section('Vorbereitung',async()=>{
  const s=await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Test T34 alles ein'},USER);
  check(s.success===true,'Vorbereitung: Schalter alle EIN durch User');
 });
 let TYP,VORLAGE;
 await section('Fixtures',async()=>{
  const t=await adm('typ_anlegen',{typ_schluessel:'t34-fix',typ_inhalt:{rolle:'x'},grund:'Fixture T34'},USER);
  check(t.success===true&&t.typ?.id,'Fixture: Typ');TYP=t.typ?.id;
  const p=await adm('persona_anlegen',{persona_name:'t34-fix',persona_inhalt:{stil:'x'},user_auftrag:'User: Fixture T34'},USER);
  check(p.success===true,'Fixture: Persona '+JSON.stringify(p).slice(0,200));VORLAGE=p.version?.vorlage_id??p.version?.id;
  const ueb=await adm('profil_uebersicht',{},USER);
  check(ueb.success===true&&ueb.profile.length>=4,'Fixture: Uebersicht');
 });

 // ---- Matrix ---------------------------------------------------------------------------------------------
 let n=0;const u=()=>++n;
 const MATRIX={
  profil_schalter_status:()=>({}),
  profil_schalter_setzen:()=>({profil_funktion:'alle',aktiv:true,grund:'Test T34 Matrix'}),
  profil_uebersicht:()=>({}),
  schattenprofil_liste:()=>({}),
  schattenprofil_korrigieren:()=>({schattenprofil_id:'unbekannt-t34',erwartete_revision:1,korrektur:{rolle:'x'},grund:'Test T34 Matrix'}),
  schattenprofil_bestaetigen:()=>({schattenprofil_id:'unbekannt-t34',erwartete_revision:1,grund:'Test T34 Matrix',user_zustimmung:'Test'}),
  schattenprofil_ablehnen:()=>({schattenprofil_id:'unbekannt-t34',erwartete_revision:1,grund:'Test T34 Matrix'}),
  typ_liste:()=>({}),
  typ_anlegen:()=>({typ_schluessel:'t34-m'+u(),typ_inhalt:{rolle:'x'},grund:'Test T34 Matrix'}),
  typ_aendern:()=>({typ_id:TYP,erwartete_revision:99,typ_inhalt:{rolle:'y'},grund:'Test T34 Matrix'}),
  typ_revision_lesen:()=>({typ_id:TYP}),
  profil_aendern:()=>({ziel_identity_id:'t34-z',erwartete_revision:99,profil_patch:{briefing:'x'},grund:'Test T34 Matrix'}),
  profil_historie:()=>({ziel_identity_id:'t34-z'}),
  profil_rollback:()=>({ziel_identity_id:'t34-z',ziel_revision:1,erwartete_revision:99,grund:'Test T34 Matrix'}),
  persona_liste:()=>({}),
  persona_versionen:()=>({persona_vorlage_id:VORLAGE}),
  persona_anlegen:()=>({persona_name:'t34-m'+u(),persona_inhalt:{stil:'x'},user_auftrag:'User: Test T34 Matrix'}),
  persona_neue_version:()=>({persona_vorlage_id:VORLAGE,persona_inhalt:{stil:'y'},user_auftrag:'User: Test T34 Matrix'}),
  persona_zuweisen:()=>({ziel_identity_id:'t34-z',persona_vorlage_id:VORLAGE,persona_version:1,user_auftrag:'User: Test T34 Matrix'}),
  persona_entfernen:()=>({ziel_identity_id:'t34-z',grund:'Test T34 Matrix'}),
  agent_vorbereiten:()=>({agent_name:'t34-neu-'+u(),grund:'Test T34 Matrix'}),
  token_abrufen:()=>({ziel_identity_id:'t34-z',anlass:'Test T34 Matrix'}),
  token_loeschen:()=>({ziel_identity_id:'t34-z',grund:'Test T34 Matrix'}),
  web_ui_koordinator_token:()=>({}),
  task_bindung_lesen:()=>({bindung_task_id:'P22-T34'}),
  task_bindung_festlegen:()=>({bindung_task_id:'T34-m'+u(),bindung_art:'identitaet',bindung_identity_ids:['t34-z'],grund:'Test T34 Matrix'}),
  task_bindung_aendern:()=>({bindung_task_id:'T34-keine-'+u(),bindung_art:'identitaet',bindung_identity_ids:['t34-z'],grund:'Test T34 Matrix'}),
  task_bindung_entblocken:()=>({bindung_task_id:'T34-keine-'+u(),grund:'Test T34 Matrix'}),
  // P22-T36: Hauptagent-Verwaltung nur User (bzw. Main selbst); Schalter hier AUS -> User bekommt funktion_aus/identitaet_unbekannt, nie recht_fehlt.
  hauptagent_status:()=>({}),
  hauptagent_auftrag:()=>({auftrag_art:'neustart',grund:'Test T34 Matrix'}),
  hauptagent_auftraege:()=>({}),
  hauptagent_auftrag_abbrechen:()=>({auftrag_id:'unbekannt-t34',grund:'Test T34 Matrix'}),
 };
 const NUR_USER=new Set(['web_ui_koordinator_token','hauptagent_status','hauptagent_auftrag','hauptagent_auftraege','hauptagent_auftrag_abbrechen']);
 const AKTEURE=[
  {name:'User',akteur:USER,agent:null,darf:a=>true},
  {name:'Koordinator mit Ausweis',akteur:Kk,agent:null,darf:a=>!NUR_USER.has(a)},
  {name:'Legacy-Koordinator',akteur:null,agent:KOORD,darf:a=>!NUR_USER.has(a)},
  {name:'Subagent mit Ausweis',akteur:Ss,agent:null,darf:a=>false},
  {name:'Legacy-Subagent',akteur:null,agent:SUB,darf:a=>false},
  {name:'ohne Akteur',akteur:null,agent:null,darf:a=>false},
 ];

 await section('Abdeckung: jede Aktion hat einen Matrixeintrag',async()=>{
  const fehlend=C.W1B_ADMIN_ACTIONS.filter(a=>!(a in MATRIX));
  check(fehlend.length===0,'Matrix deckt alle admin-Aktionen ab, fehlend: '+fehlend.join(','));
  check(C.W1B_ADMIN_ACTIONS.length===Object.keys(MATRIX).length,'Matrix hat keine Ueberzaehligen');
 });

 await section('Rechte-Matrix: Aktion x Akteur',async()=>{
  for(const aktion of C.W1B_ADMIN_ACTIONS){
   if(!(aktion in MATRIX))continue;
   for(const x of AKTEURE){
    const r=await adm(aktion,MATRIX[aktion](),x.akteur,x.agent);
    const soll=x.darf(aktion);
    check(recht(r)===!soll,aktion+' / '+x.name+': '+(soll?'erlaubt':'recht_fehlt')+' erwartet, bekommen '+JSON.stringify({success:r.success,error:r.error}));
   }
  }
 });

 await section('Legacy-Koordinator: Wirkung und Audit',async()=>{
  const L=a=>adm(a.aktion,a.args,null,KOORD);
  const st=await L({aktion:'profil_schalter_status',args:{}});
  check(st.success===true&&Array.isArray(st.schalter),'profil_schalter_status als Legacy-Koordinator (Ausgangsbefund t111)');
  const ss=await L({aktion:'profil_schalter_setzen',args:{profil_funktion:'persona',aktiv:true,grund:'Test T34 Setzen'}});
  check(ss.success===true,'profil_schalter_setzen (Projekt) als Legacy-Koordinator');
  const row=(await pool.query("SELECT gesetzt_von,setter_identity_id FROM agent_profil_schalter WHERE funktion='persona' AND project=$1",[P])).rows[0];
  check(row?.gesetzt_von==='legacy:'+KOORD&&row.setter_identity_id===null,'Schalter-Audit legacy:<id>');
  const gl=await L({aktion:'profil_schalter_setzen',args:{ebene:'global',profil_funktion:'persona',aktiv:true,grund:'Test T34 global'}});
  check(recht(gl),'Schalter global bleibt nur User');
  const ty=await L({aktion:'typ_anlegen',args:{typ_schluessel:'t34-legacy',typ_inhalt:{rolle:'x'},grund:'Test T34 Legacy'}});
  check(ty.success===true,'typ_anlegen als Legacy-Koordinator');
  const tr=(await pool.query('SELECT wer,actor_identity_id FROM agent_typ_revisionen WHERE typ_id=$1',[ty.typ?.id])).rows[0];
  check(tr?.wer==='legacy:'+KOORD&&tr.actor_identity_id===null,'Typ-Audit legacy:<id>');
  check(recht(await L({aktion:'typ_anlegen',args:{profil_scope:'global',typ_schluessel:'t34-glob',typ_inhalt:{rolle:'x'},grund:'Test T34 global'}})),'globaler Typ bleibt nur User');
  const ae=await L({aktion:'typ_aendern',args:{typ_id:ty.typ?.id,erwartete_revision:1,typ_inhalt:{rolle:'y'},grund:'Test T34 aendern'}});
  check(ae.success===true,'typ_aendern als Legacy-Koordinator');
  const rev=(await L({aktion:'profil_uebersicht',args:{}})).profile.find(p=>p.identity_id==='t34-z').profil_revision;
  const pa=await L({aktion:'profil_aendern',args:{ziel_identity_id:'t34-z',erwartete_revision:rev,profil_patch:{briefing:'T34'},grund:'Test T34 Profil'}});
  check(pa.success===true&&pa.profil_revision===rev+1,'profil_aendern als Legacy-Koordinator '+JSON.stringify(pa).slice(0,160));
  const hi=await L({aktion:'profil_historie',args:{ziel_identity_id:'t34-z'}});
  check(hi.success===true&&hi.revisionen.some(r=>r.wer==='legacy:'+KOORD),'profil_historie: Revision mit wer legacy:<id>');
  const rb=await L({aktion:'profil_rollback',args:{ziel_identity_id:'t34-z',ziel_revision:rev+1,erwartete_revision:rev+1,grund:'Test T34 Rollback'}});
  check(rb.success===true,'profil_rollback als Legacy-Koordinator '+JSON.stringify(rb).slice(0,160));
  // Persona: weiterhin nur mit User-Auftrag
  check((await L({aktion:'persona_anlegen',args:{persona_name:'t34-ohne',persona_inhalt:{stil:'x'}}})).error==='user_auftrag_fehlt','Persona ohne user_auftrag -> user_auftrag_fehlt');
  const pz=await L({aktion:'persona_zuweisen',args:{ziel_identity_id:'t34-z',persona_vorlage_id:VORLAGE,persona_version:1,user_auftrag:'User: Persona fuer Test T34'}});
  check(pz.success===true,'persona_zuweisen mit user_auftrag als Legacy-Koordinator '+JSON.stringify(pz).slice(0,160));
  // Task-Bindung
  const fe=await L({aktion:'task_bindung_festlegen',args:{bindung_task_id:'T34-legacy',bindung_art:'identitaet',bindung_identity_ids:['t34-z'],grund:'Test T34 Bindung'}});
  check(fe.success===true,'task_bindung_festlegen als Legacy-Koordinator '+JSON.stringify(fe).slice(0,160));
  const le=await L({aktion:'task_bindung_lesen',args:{bindung_task_id:'T34-legacy'}});
  check(le.success===true&&le.bindung?.art==='identitaet','task_bindung_lesen zeigt die Bindung');
  const au=(await pool.query("SELECT wer,actor_identity_id FROM plan_task_bindung_audit WHERE task_id='T34-legacy'")).rows[0];
  check(au?.wer==='legacy:'+KOORD&&au.actor_identity_id===null,'Bindungs-Audit legacy:<id>');
  check((await L({aktion:'task_bindung_entblocken',args:{bindung_task_id:'T34-legacy',grund:'Test T34 entblocken'}})).success===true,'task_bindung_entblocken als Legacy-Koordinator');
  check((await L({aktion:'schattenprofil_liste',args:{}})).success===true,'schattenprofil_liste (T31-Regression)');
  check((await L({aktion:'agent_vorbereiten',args:{agent_name:'t34-vorb',grund:'Test T34 vorbereiten'}})).success===true,'agent_vorbereiten (Regression)');
 });

 await section('Abgrenzung: Name gehoert einer Token-Identitaet, Rollenmuster, anderes Projekt',async()=>{
  check(recht(await adm('profil_schalter_status',{},null,'koordinator-t34-tok')),'Legacy-Name einer Token-Identitaet braucht deren Ausweis');
  check(recht(await adm('profil_uebersicht',{},null,'luna-1')),'Name ohne Koordinator-Muster -> recht_fehlt');
  check(recht(await C.fuehreW1bAdminAus('profil_uebersicht',{project:P,agent_id:'koordinator-t34'},{akteur:Ss})),'Subagent mit Ausweis bleibt recht_fehlt, auch mit Koordinator-agent_id');
  check((await C.fuehreW1bAdminAus('profil_uebersicht',{project:Q,agent_id:KOORD},{akteur:null})).error==='funktion_aus','Legacy-Koordinator in anderem Projekt: Recht ok, Schalter dort AUS -> funktion_aus (kein recht_fehlt)');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T34: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
