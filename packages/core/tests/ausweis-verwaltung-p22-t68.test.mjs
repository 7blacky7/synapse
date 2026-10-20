/**
 * P22-T68: Web-UI-Ausweisverwaltung - Aktionen profil_lesen, identitaet_deaktivieren, identitaet_reaktivieren und die additiven
 * Felder von profil_uebersicht. Rechte je Akteur (User, Koordinator, Legacy-Koordinator, Main, Subagent, fremder Koordinator,
 * ohne Akteur) wie im Backend (fuehreW1bAdminAus). Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/ausweis-verwaltung-p22-t68.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T68_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t68_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t68',Q='p22-t68-fremd';
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
 const KOORD='koordinator-t68',SUB='subagent-t68';
 await ident('t68-k',P,'t68-koord','koordinator');await ident('t68-s',P,'t68-sub','subagent');await ident('t68-z',P,'t68-ziel','subagent');
 await ident('t68-m',P,'t68-main','main');await ident('t68-f',Q,'t68-fremd','koordinator');
 const Kk=akt('t68-k',P,'koordinator'),Ss=akt('t68-s',P,'subagent'),Mm=akt('t68-m',P,'main'),Ff=akt('t68-f',Q,'koordinator');
 const adm=(a,args,akteur,agent)=>C.fuehreW1bAdminAus(a,{project:P,...(agent?{agent_id:agent}:{}),...args},{akteur});
 const recht=r=>r&&r.success===false&&r.error==='recht_fehlt';
 const status=async id=>(await pool.query('SELECT status FROM agent_identitaeten WHERE id=$1',[id])).rows[0]?.status;
 const auditAnzahl=async(id,aktion)=>(await pool.query('SELECT count(*)::int AS n FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion=$2',[id,aktion])).rows[0].n;

 await section('Vorbereitung',async()=>{
  const s=await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Test T68 alles ein'},USER);
  check(s.success===true,'Schalter alle EIN durch User');
 });

 await section('Rechte je Akteur',async()=>{
  const AKTEURE=[
   {name:'User',akteur:USER,agent:null,lesen:true,verwalten:true},
   {name:'Koordinator mit Ausweis',akteur:Kk,agent:null,lesen:true,verwalten:true},
   {name:'Legacy-Koordinator',akteur:null,agent:KOORD,lesen:true,verwalten:true},
   {name:'Main (fremdes Profil)',akteur:Mm,agent:null,lesen:false,verwalten:false},
   {name:'Subagent mit Ausweis',akteur:Ss,agent:null,lesen:false,verwalten:false},
   {name:'Legacy-Subagent',akteur:null,agent:SUB,lesen:false,verwalten:false},
   {name:'Koordinator eines fremden Projekts',akteur:Ff,agent:null,lesen:false,verwalten:false},
   {name:'ohne Akteur',akteur:null,agent:null,lesen:false,verwalten:false},
  ];
  for(const x of AKTEURE){
   const l=await adm('profil_lesen',{ziel_identity_id:'t68-z'},x.akteur,x.agent);
   check(x.lesen?l.success===true:recht(l),'profil_lesen / '+x.name+': '+(x.lesen?'erlaubt':'recht_fehlt')+' erwartet, bekommen '+JSON.stringify({s:l.success,e:l.error}));
   const d=await adm('identitaet_deaktivieren',{ziel_identity_id:'t68-z',grund:'Test T68 Rechte'},x.akteur,x.agent);
   check(x.verwalten?d.success===true:recht(d),'identitaet_deaktivieren / '+x.name+': '+(x.verwalten?'erlaubt':'recht_fehlt')+' erwartet, bekommen '+JSON.stringify({s:d.success,e:d.error}));
   const r=await adm('identitaet_reaktivieren',{ziel_identity_id:'t68-z',grund:'Test T68 Rechte'},x.akteur,x.agent);
   check(x.verwalten?r.success===true:recht(r),'identitaet_reaktivieren / '+x.name+': '+(x.verwalten?'erlaubt':'recht_fehlt')+' erwartet, bekommen '+JSON.stringify({s:r.success,e:r.error}));
  }
  check(await status('t68-z')==='aktiv','nach der Rechte-Runde ist t68-z wieder aktiv');
 });

 await section('Main liest nur das eigene Profil',async()=>{
  const eigen=await adm('profil_lesen',{ziel_identity_id:'t68-m'},Mm);
  check(eigen.success===true&&eigen.identitaet?.identity_id==='t68-m','Main: eigenes profil_lesen erlaubt '+JSON.stringify({s:eigen.success,e:eigen.error}));
  const fremd=await adm('profil_lesen',{ziel_identity_id:'t68-z'},Mm);
  check(recht(fremd),'Main: fremdes profil_lesen recht_fehlt');
  const eigenDeakt=await adm('identitaet_deaktivieren',{ziel_identity_id:'t68-m',grund:'Test T68 Main'},Mm);
  check(recht(eigenDeakt)&&await status('t68-m')==='aktiv','Main darf sich nicht selbst deaktivieren');
 });

 await section('Deaktivieren und Reaktivieren: Wirkung und Audit',async()=>{
  const vorher=await auditAnzahl('t68-z','deaktivieren');
  const d=await adm('identitaet_deaktivieren',{ziel_identity_id:'t68-z',grund:'Test T68 Wirkung'},USER);
  check(d.success===true&&d.status==='deaktiviert'&&await status('t68-z')==='deaktiviert','Deaktivieren setzt status deaktiviert');
  check(await auditAnzahl('t68-z','deaktivieren')===vorher+1,'Deaktivieren schreibt genau eine Audit-Zeile');
  const zeile=(await pool.query("SELECT wer,grund FROM agent_identitaet_audit WHERE identity_id='t68-z' AND aktion='deaktivieren' ORDER BY id DESC LIMIT 1")).rows[0];
  check(zeile?.wer==='user'&&zeile.grund==='Test T68 Wirkung','Audit: wer user, Grund im Wortlaut');
  const d2=await adm('identitaet_deaktivieren',{ziel_identity_id:'t68-z',grund:'Test T68 doppelt'},USER);
  check(d2.success===true&&await auditAnzahl('t68-z','deaktivieren')===vorher+1,'zweites Deaktivieren ist idempotent ohne neue Audit-Zeile');
  const lesen=await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER);
  check(lesen.success===true&&lesen.identitaet?.status==='deaktiviert','profil_lesen zeigt deaktivierte Identitaet weiter an');
  const ohneGrund=await adm('identitaet_reaktivieren',{ziel_identity_id:'t68-z'},USER);
  check(ohneGrund.success===false&&ohneGrund.error==='grund_fehlt'&&await status('t68-z')==='deaktiviert','Reaktivieren ohne Grund abgelehnt, nichts geaendert');
  const lauefeVorher=(await pool.query("SELECT count(*)::int AS n FROM agent_identitaet_laeufe WHERE identity_id='t68-z'")).rows[0].n;
  const nR=await auditAnzahl('t68-z','reaktivieren');
  const r=await adm('identitaet_reaktivieren',{ziel_identity_id:'t68-z',grund:'Test T68 zurueck'},USER);
  check(r.success===true&&r.status==='aktiv'&&await status('t68-z')==='aktiv','Reaktivieren setzt status aktiv');
  check(await auditAnzahl('t68-z','reaktivieren')===nR+1,'Reaktivieren schreibt genau eine Audit-Zeile');
  const lauefeNachher=(await pool.query("SELECT count(*)::int AS n FROM agent_identitaet_laeufe WHERE identity_id='t68-z'")).rows[0].n;
  check(lauefeNachher===lauefeVorher,'Reaktivieren legt keinen Lauf an');
  const r2=await adm('identitaet_reaktivieren',{ziel_identity_id:'t68-z',grund:'Test T68 doppelt'},USER);
  check(r2.success===true&&await auditAnzahl('t68-z','reaktivieren')===nR+1,'zweites Reaktivieren ist idempotent ohne neue Audit-Zeile');
  const unbekannt=await adm('identitaet_deaktivieren',{ziel_identity_id:'gibt-es-nicht',grund:'Test T68 unbekannt'},USER);
  check(unbekannt.success===false&&unbekannt.error==='identitaet_unbekannt','unbekannte Identitaet -> identitaet_unbekannt');
  const fremdesProjekt=await C.fuehreW1bAdminAus('identitaet_deaktivieren',{project:Q,ziel_identity_id:'t68-z',grund:'Test T68 Projekt'},{akteur:USER});
  check(fremdesProjekt.success===false&&fremdesProjekt.error==='identitaet_unbekannt'&&await status('t68-z')==='aktiv','Identitaet eines anderen Projekts bleibt unberuehrt');
  check(C.w1bFehlerStatus('identitaet_recht_fehlt')===403&&C.w1bFehlerStatus('identitaet_unbekannt')===404,'HTTP-Status: 403 fuer Rechte, 404 fuer unbekannt');
 });

 await section('profil_lesen ist tokenfrei',async()=>{
  const vorb=await adm('agent_vorbereiten',{agent_name:'t68-neu',grund:'Test T68 Ausweis'},USER);
  check(vorb.success===true,'Fixture: Ausweis vorbereitet '+JSON.stringify({s:vorb.success,e:vorb.error}));
  const neu=(await pool.query("SELECT id FROM agent_identitaeten WHERE project=$1 AND name='t68-neu'",[P])).rows[0]?.id;
  const abruf=neu?await adm('token_abrufen',{ziel_identity_id:neu,anlass:'Test T68 Fixture'},USER):null;
  const token=(JSON.stringify(abruf??vorb).match(/sai_[A-Za-z0-9_-]+/)||[])[0];
  check(!!token,'Fixture: Ausweis per token_abrufen lesbar '+JSON.stringify({s:abruf?.success,e:abruf?.error}));
  await pool.query("UPDATE agent_identitaeten SET profil = profil || $2::jsonb WHERE id=$1",['t68-z',JSON.stringify({kontext:{ausweise:'sai_geheim1234567890'},briefing:'sichtbar'})]);
  const z=await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER);
  const textZ=JSON.stringify(z);
  check(z.success===true&&z.identitaet?.kontext_vorhanden===true&&!textZ.includes('sai_geheim')&&z.identitaet?.profil?.briefing==='sichtbar','Freitext-Kontext (kann Ausweise enthalten) fehlt in der Antwort, Rest sichtbar');
  check(Array.isArray(z.tokens)&&Array.isArray(z.audit)&&Array.isArray(z.gebundene_tasks)&&'lauf' in z&&'persona' in z,'Detail hat tokens, audit, gebundene_tasks, lauf, persona');
  if(neu){
   const n=await adm('profil_lesen',{ziel_identity_id:neu},USER);
   const textN=JSON.stringify(n);
   check(n.success===true&&n.tokens.length>=1&&n.tokens.every(t=>!('token_hash' in t)&&!('token_offen' in t)),'Ausweis-Metadaten ohne Hash und Wert');
   check(!token||!textN.includes(token),'Tokenwert steht nicht im Detail');
   check(!textN.includes('token_offen')&&!textN.includes('token_hash'),'keine Token-Spalten irgendwo im Detail');
   const alt=await adm('profil_lesen',{ziel_identity_id:neu},null,SUB);
   check(recht(alt),'Legacy-Subagent erhaelt auch beim Ausweis-Detail recht_fehlt');
  }
  const unbekannt=await adm('profil_lesen',{ziel_identity_id:'gibt-es-nicht'},USER);
  check(unbekannt.success===false&&unbekannt.error==='identitaet_unbekannt','profil_lesen: unbekannte Identitaet');
  const ohneZiel=await adm('profil_lesen',{},USER);
  check(ohneZiel.success===false&&ohneZiel.error==='ziel_identity_id_fehlt','profil_lesen ohne Ziel');
 });

 await section('profil_uebersicht additiv',async()=>{
  const u=await adm('profil_uebersicht',{},USER);
  const z=u.profile?.find(p=>p.identity_id==='t68-z');
  check(u.success===true&&z&&'modell_bestaetigt' in z&&'modell_selbstauskunft' in z&&typeof z.lauf_aktiv==='boolean','Uebersicht traegt modell_bestaetigt, modell_selbstauskunft, lauf_aktiv');
  check(z&&'token_abrufbar' in z&&'ausweis_zustand' in z&&'profil_revision' in z,'bestehende Felder bleiben');
 });

 await section('Formular-Aktionen je Akteur: Typ, Zuschnitt, Persona, Task-Bindung',async()=>{
  await pool.query("UPDATE agent_identitaeten SET profil = profil - 'kontext' WHERE id='t68-z'"); // Fixture des Abschnitts 'tokenfrei' (Ausweis im Kontext) entfernen: das Backend lehnt Aenderungen mit Ausweis im Kontext eines Nicht-Koordinators ab
  const typ=await adm('typ_anlegen',{typ_schluessel:'t68-typ',typ_inhalt:{rolle:'x'},grund:'Fixture T68'},USER);
  const vorlage=await adm('persona_anlegen',{persona_name:'t68-persona',persona_inhalt:{stil:'ruhig'}},USER);
  check(typ.success===true&&typ.typ?.id,'Fixture: Typ');
  const typId=typ.typ?.id,vorlageId=vorlage.version?.vorlage_id??vorlage.version?.id;
  check(vorlage.success===true&&!!vorlageId,'Fixture: Persona-Vorlage');
  const AKTEURE=[
   {name:'User',akteur:USER,agent:null,darf:true},
   {name:'Koordinator mit Ausweis',akteur:Kk,agent:null,darf:true},
   {name:'Legacy-Koordinator',akteur:null,agent:KOORD,darf:true},
   {name:'Main (fremdes Profil)',akteur:Mm,agent:null,darf:false},
   {name:'Subagent mit Ausweis',akteur:Ss,agent:null,darf:false},
   {name:'Legacy-Subagent',akteur:null,agent:SUB,darf:false},
   {name:'Koordinator eines fremden Projekts',akteur:Ff,agent:null,darf:false},
   {name:'ohne Akteur',akteur:null,agent:null,darf:false},
  ];
  const abgelehnt=r=>r&&r.success===false&&(r.error==='recht_fehlt'||r.error==='eigenprofil_nicht_aenderbar');
  const revision=async()=>(await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER)).identitaet.profil_revision;
  for(const x of AKTEURE){
   const aendern=await adm('profil_aendern',{ziel_identity_id:'t68-z',erwartete_revision:await revision(),typ_id:typId,profil_patch:{zuschnitt:{standard:'erlaubt',schreiben:false,tools:{shell:'verweigert'},shell_stufe_max:'hinweis'}},grund:'Test T68 Formular '+x.name},x.akteur,x.agent);
   check(x.darf?aendern.success===true:abgelehnt(aendern),'profil_aendern (Typ + Zuschnitt) / '+x.name+': '+(x.darf?'erlaubt':'abgelehnt')+' erwartet, bekommen '+JSON.stringify({s:aendern.success,e:aendern.error}));
   const zu=await adm('persona_zuweisen',{ziel_identity_id:'t68-z',persona_vorlage_id:vorlageId,persona_version:1,user_auftrag:'User: Test T68 Persona'},x.akteur,x.agent);
   check(x.darf?zu.success===true:abgelehnt(zu),'persona_zuweisen / '+x.name+': bekommen '+JSON.stringify({s:zu.success,e:zu.error}));
   const weg=await adm('persona_entfernen',{ziel_identity_id:'t68-z',grund:'Test T68 Persona weg'},x.akteur,x.agent);
   check(x.darf?(weg.success===true||weg.error==='keine_zuweisung'):abgelehnt(weg),'persona_entfernen / '+x.name+': bekommen '+JSON.stringify({s:weg.success,e:weg.error}));
   const bind=await adm('task_bindung_festlegen',{bindung_task_id:'T68-'+x.name.replace(/[^A-Za-z]/g,'').slice(0,12),bindung_art:'identitaet',bindung_identity_ids:['t68-z'],grund:'Test T68 Bindung'},x.akteur,x.agent);
   check(x.darf?bind.success===true:abgelehnt(bind),'task_bindung_festlegen / '+x.name+': bekommen '+JSON.stringify({s:bind.success,e:bind.error}));
  }
  const gelesen=await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER);
  check(gelesen.identitaet?.typ_id===typId&&gelesen.identitaet?.profil?.zuschnitt?.standard==='erlaubt'&&gelesen.identitaet.profil.zuschnitt.tools?.shell==='verweigert','profil_lesen zeigt Typ und eigenen Zuschnitt des Profils');
  check(Array.isArray(gelesen.gebundene_tasks)&&gelesen.gebundene_tasks.length>=3,'profil_lesen zeigt gebundene Tasks ('+(gelesen.gebundene_tasks?.length)+')');
  const aufgabe=gelesen.gebundene_tasks?.[0]?.task_id;
  const lesen=await adm('task_bindung_lesen',{bindung_task_id:aufgabe},USER);
  check(lesen.success===true&&lesen.bindung?.art==='identitaet'&&lesen.bindung.identity_id==='t68-z','task_bindung_lesen: Art und Identitaet');
  const koordLoest=await adm('task_bindung_entblocken',{bindung_task_id:aufgabe,grund:'Test T68 loesen'},Kk);
  check(koordLoest.success===true,'Koordinator loest eine Bindung');
  const subLoest=await adm('task_bindung_entblocken',{bindung_task_id:gelesen.gebundene_tasks?.[1]?.task_id,grund:'Test T68 loesen'},Ss);
  check(abgelehnt(subLoest),'Subagent darf keine Bindung loesen');
  const typWeg=await adm('profil_aendern',{ziel_identity_id:'t68-z',erwartete_revision:await revision(),typ_id:null,profil_patch:{zuschnitt:{}},grund:'Test T68 Typ loesen'},USER);
  const danach=await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER);
  check(typWeg.success===true&&!danach.identitaet.typ_id&&Object.keys(danach.identitaet.profil.zuschnitt??{}).length===0,'Typ loesen und Zuschnitt leeren ueber profil_aendern');
 });

 await section('Kataloge, Hinweisarten und Rollback je Akteur',async()=>{
  const AKTEURE=[
   {name:'User',akteur:USER,agent:null,darf:true},
   {name:'Koordinator mit Ausweis',akteur:Kk,agent:null,darf:true},
   {name:'Legacy-Koordinator',akteur:null,agent:KOORD,darf:true},
   {name:'Main (fremdes Profil)',akteur:Mm,agent:null,darf:false},
   {name:'Subagent mit Ausweis',akteur:Ss,agent:null,darf:false},
   {name:'Legacy-Subagent',akteur:null,agent:SUB,darf:false},
   {name:'Koordinator eines fremden Projekts',akteur:Ff,agent:null,darf:false},
   {name:'ohne Akteur',akteur:null,agent:null,darf:false},
  ];
  const abgelehnt=r=>r&&r.success===false&&(r.error==='recht_fehlt'||r.error==='eigenprofil_nicht_aenderbar');
  const katalog=(await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER)).hinweis_katalog;
  check(Array.isArray(katalog)&&katalog.length>5&&katalog.every(e=>e.schluessel&&e.klasse&&'zweck' in e&&'standard' in e),'profil_lesen liefert den Hinweiskatalog');
  const optional=katalog.find(e=>e.klasse==='optional')?.schluessel,pflicht=katalog.find(e=>e.klasse==='pflicht')?.schluessel;
  check(!!optional&&!!pflicht,'Katalog hat optionale und Pflichtarten');
  let typId;
  for(const [i,x] of AKTEURE.entries()){
   const name='t68-kat-'+i;
   const t=await adm('typ_anlegen',{typ_schluessel:name,typ_inhalt:{regeln:['Regel '+i],hinweise:{[optional]:false}},grund:'Test T68 Typ '+x.name},x.akteur,x.agent);
   check(x.darf?t.success===true:abgelehnt(t),'typ_anlegen / '+x.name+': bekommen '+JSON.stringify({s:t.success,e:t.error}));
   if(x.darf&&!typId)typId=t.typ?.id;
   const p=await adm('persona_anlegen',{persona_name:name,persona_inhalt:{stil:'ruhig '+i},user_auftrag:'User: Test T68 Persona '+i},x.akteur,x.agent);
   check(x.darf?p.success===true:abgelehnt(p),'persona_anlegen / '+x.name+': bekommen '+JSON.stringify({s:p.success,e:p.error}));
  }
  const vorlage=(await adm('persona_liste',{},USER)).vorlagen.find(v=>v.name==='t68-kat-0');
  check(!!typId&&!!vorlage,'Fixture: Typ und Persona-Vorlage aus der Akteur-Runde');
  for(const x of AKTEURE){
   const rev=(await adm('typ_revision_lesen',{typ_id:typId},USER)).revision.revision;
   const a=await adm('typ_aendern',{typ_id:typId,erwartete_revision:rev,typ_inhalt:{regeln:['neu '+x.name],hinweise:{[optional]:true}},grund:'Test T68 Typ aendern'},x.akteur,x.agent);
   check(x.darf?a.success===true:abgelehnt(a),'typ_aendern / '+x.name+': bekommen '+JSON.stringify({s:a.success,e:a.error}));
   const v=await adm('persona_neue_version',{persona_vorlage_id:vorlage.id,persona_inhalt:{stil:'neu '+x.name},user_auftrag:'User: Test T68 Version'},x.akteur,x.agent);
   check(x.darf?v.success===true:abgelehnt(v),'persona_neue_version / '+x.name+': bekommen '+JSON.stringify({s:v.success,e:v.error}));
  }
  const alt=await adm('typ_aendern',{typ_id:typId,erwartete_revision:1,typ_inhalt:{regeln:['x']},grund:'Test T68 veraltet'},USER);
  check(alt.success===false&&alt.error==='typ_revision_veraltet'||alt.success===false&&/veraltet/.test(String(alt.error)),'Typ: veraltete Revision wird abgelehnt (CAS), bekam '+JSON.stringify({s:alt.success,e:alt.error}));
  const typLesen=await adm('typ_revision_lesen',{typ_id:typId},USER);
  check(typLesen.revision.inhalt.hinweise?.[optional]===true&&typLesen.revision.revision>=2,'Typ-Revision traegt die gespeicherten Hinweisarten');
  const versionen=await adm('persona_versionen',{persona_vorlage_id:vorlage.id},USER);
  check(versionen.versionen.length>=2,'Persona-Versionen vorhanden ('+versionen.versionen?.length+')');
  // Hinweisarten je Identitaet ueber profil_aendern
  const revision=async()=>(await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER)).identitaet.profil_revision;
  for(const x of AKTEURE){
   const h=await adm('profil_aendern',{ziel_identity_id:'t68-z',erwartete_revision:await revision(),profil_patch:{hinweise:{[optional]:false}},grund:'Test T68 Hinweise '+x.name},x.akteur,x.agent);
   check(x.darf?h.success===true:abgelehnt(h),'profil_aendern (Hinweisart aus) / '+x.name+': bekommen '+JSON.stringify({s:h.success,e:h.error}));
  }
  check((await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER)).identitaet.profil.hinweise?.[optional]===false,'Hinweisart ist am Profil gespeichert');
  const pf=await adm('profil_aendern',{ziel_identity_id:'t68-z',erwartete_revision:await revision(),profil_patch:{hinweise:{[pflicht]:false}},grund:'Test T68 Pflicht'},USER);
  check(pf.success===false&&/pflicht/.test(String(pf.error)),'Pflichtart ist nicht abschaltbar: '+JSON.stringify({e:pf.error}));
  // Rollback
  const hist=await adm('profil_historie',{ziel_identity_id:'t68-z'},USER);
  const revs=hist.revisionen.map(r=>r.revision).sort((a,b)=>a-b);
  const ziel=revs[1]??revs[0];
  for(const x of AKTEURE){
   const aktuell=await revision();
   const r=await adm('profil_rollback',{ziel_identity_id:'t68-z',ziel_revision:ziel,erwartete_revision:aktuell,grund:'Test T68 Rollback '+x.name},x.akteur,x.agent);
   check(x.darf?r.success===true:abgelehnt(r),'profil_rollback / '+x.name+': bekommen '+JSON.stringify({s:r.success,e:r.error}));
  }
  const nach=await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER);
  check(nach.identitaet.profil.hinweise?.[optional]!==false,'Rollback stellt den frueheren Stand her (Hinweisart wieder ohne Override)');
  const veraltet=await adm('profil_rollback',{ziel_identity_id:'t68-z',ziel_revision:ziel,erwartete_revision:1,grund:'Test T68 veraltet'},USER);
  check(veraltet.success===false&&/veraltet/.test(String(veraltet.error)),'Rollback mit veralteter Revision abgelehnt: '+JSON.stringify({e:veraltet.error}));
 });

 await section('REST-Routen je Akteur (Sitzung, Koordinator-Ausweis, Subagent-Ausweis, fremdes Projekt)',async()=>{
  const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
  const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
  const tokens={web:{kind:'session',scope:null},access:{kind:'access',scope:'mcp:tools'}};
  const app=fastify({logger:false});
  await registerAgentProfilRoutes(app,{validateToken:async t=>tokens[t]?{token_hash:t,...tokens[t]}:null});await app.ready();
  const call=async(method,path,bearer,payload,ausweis,projekt=P)=>{
   const r=await app.inject({method,url:'/api/projects/'+projekt+'/agent-profile'+path,headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),...(ausweis?{'x-synapse-agent-token':ausweis}:{})},payload});
   let body;try{body=r.json();}catch{body=null;}return {status:r.statusCode,body,header:r.headers};
  };
  const hole=async(projekt,name,rolle)=>{
   await C.fuehreW1bAdminAus('agent_vorbereiten',{project:projekt,agent_name:name,rolle,grund:'Test T68 REST'},{akteur:USER});
   const id=(await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1 AND name=$2',[projekt,name])).rows[0].id;
   const t=await C.fuehreW1bAdminAus('token_abrufen',{project:projekt,ziel_identity_id:id,anlass:'Test T68 REST'},{akteur:USER});
   return {id,token:(JSON.stringify(t).match(/sai_[A-Za-z0-9_-]+/)||[])[0]};
  };
  await C.fuehreW1bAdminAus('profil_schalter_setzen',{project:Q,profil_funktion:'alle',aktiv:true,grund:'Test T68 fremdes Projekt'},{akteur:USER});
  const kr=await hole(P,'t68-rest-koord','koordinator'),sr=await hole(P,'t68-rest-sub','subagent'),fr=await hole(Q,'t68-rest-fremd','koordinator');
  check(kr.token&&sr.token&&fr.token,'Fixture: drei echte Ausweise');
  const ziel='/identitaeten/t68-z',grundBody={grund:'Test T68 REST Grund'};
  check((await call('GET',ziel,null)).status===401,'ohne Bearer 401');
  const ohneAusweis=await call('GET',ziel,'access');
  check(ohneAusweis.status===403&&ohneAusweis.body.error.code==='nur_user_oder_koordinator','Access-Token ohne Ausweis 403');
  const web=await call('GET',ziel,'web');
  check(web.status===200&&web.header['cache-control']==='no-store'&&web.body.identitaet?.identity_id==='t68-z','Sitzung (User): Detail 200, no-store');
  check((await call('POST',ziel+'/deaktivieren','web',grundBody)).status===200&&await status('t68-z')==='deaktiviert','Sitzung: deaktivieren 200');
  check((await call('POST',ziel+'/reaktivieren','web',grundBody)).status===200&&await status('t68-z')==='aktiv','Sitzung: reaktivieren 200');
  const ohneGrund=await call('POST',ziel+'/deaktivieren','web',{});
  check(ohneGrund.status===400&&ohneGrund.body.error.code==='grund_fehlt'&&await status('t68-z')==='aktiv','ohne Grund 400, nichts geaendert');
  check((await call('GET','/identitaeten/gibt-es-nicht','web')).status===404,'unbekannte Identitaet 404');
  const kd=await call('GET',ziel,'access',undefined,kr.token);
  check(kd.status===200&&!JSON.stringify(kd.body).includes(kr.token),'Koordinator-Ausweis: Detail 200, Tokenwert nicht in der Antwort');
  check((await call('POST',ziel+'/deaktivieren','access',grundBody,kr.token)).status===200&&await status('t68-z')==='deaktiviert','Koordinator-Ausweis: deaktivieren 200');
  check((await call('POST',ziel+'/reaktivieren','access',grundBody,kr.token)).status===200&&await status('t68-z')==='aktiv','Koordinator-Ausweis: reaktivieren 200');
  for(const [name,m,pfad,body] of [['Detail','GET',ziel],['deaktivieren','POST',ziel+'/deaktivieren',grundBody],['reaktivieren','POST',ziel+'/reaktivieren',grundBody]]){
   const r=await call(m,pfad,'access',body,sr.token);
   check(r.status===403&&r.body.error.code==='recht_fehlt','Subagent-Ausweis: '+name+' 403 recht_fehlt, bekam '+r.status);
  }
  check(await status('t68-z')==='aktiv','Subagent hat nichts veraendert');
  const fremd=await call('GET',ziel,'access',undefined,fr.token);
  check(fremd.status===401&&fremd.body.error.code==='ausweis_ungueltig','Koordinator-Ausweis eines anderen Projekts: 401 ausweis_ungueltig');
 });

 await section('Schalter AUS sperrt profil_lesen',async()=>{
  const aus=await adm('profil_schalter_setzen',{profil_funktion:'profilverwaltung',aktiv:false,grund:'Test T68 aus'},USER);
  check(aus.success===true,'profilverwaltung AUS');
  const l=await adm('profil_lesen',{ziel_identity_id:'t68-z'},USER);
  check(l.success===false&&l.error==='funktion_aus','profil_lesen bei Schalter AUS -> funktion_aus');
  check(C.w1bFehlerStatus('funktion_aus')===409,'funktion_aus -> HTTP 409');
  await adm('profil_schalter_setzen',{profil_funktion:'profilverwaltung',aktiv:true,grund:'Test T68 ein'},USER);
 });
}catch(e){
 failures.push('Aufbau: '+mask(e.stack||e.message));console.error('FAIL Aufbau: '+mask(e.stack||e.message));
}finally{
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch{}
 try{await admin.end();}catch{}
 try{await core?.getPool?.().end();}catch{}
}
console.log(checks+' Pruefungen, '+failures.length+' Fehler');
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
process.exit(0);
