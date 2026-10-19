/**
 * P22-T57 (User 20.10.2026): bestaetigter Koordinator (mit Ausweis oder Legacy) setzt Produkt-Schalter auch ebene global,
 * wie der User; Audit gesetzt_von. Subagent, fremder Koordinator, Legacy-Name einer Token-Identitaet und ohne Akteur nie.
 * Einheitlichkeit: ausweis_fristen global fuer dieselben Akteure. Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node packages/core/tests/produkt-schalter-global-koordinator-p22-t57.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T57_ROOT||repo;
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
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t57_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t57',Q='p22-t57-fremd';
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-ausweis-fristen-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }

 const C=core,USER={art:'user'};
 const ident=async(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 const akt=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 await ident('t57-k',P,'t57-koord','koordinator');await ident('t57-s',P,'t57-sub','subagent');
 await ident('t57-kq',Q,'t57-koord-q','koordinator');await ident('t57-ka',P,'t57-koord-alt','koordinator');
 await ident('t57-tok',P,'koordinator-t57-tok','koordinator');
 await pool.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id='t57-ka'");
 const K=akt('t57-k',P,'koordinator'),S=akt('t57-s',P,'subagent'),KQ=akt('t57-kq',Q,'koordinator'),KA=akt('t57-ka',P,'koordinator');
 const KOORD='koordinator-t57',SUB='subagent-t57';
 const adm=(aktion,args,akteur,agent,project=P)=>C.fuehreW1bAdminAus(aktion,{project,...(agent?{agent_id:agent}:{}),...args},{akteur});
 const setzeGlobal=(akteur,agent,funktion='tool_beschreibungen_kurz',aktiv=true,project=P)=>
  adm('profil_schalter_setzen',{ebene:'global',profil_funktion:funktion,aktiv,grund:'Test P22-T57 global'},akteur,agent,project);
 const recht=r=>r&&r.success===false&&r.error==='recht_fehlt';
 const zeile=async(f)=>(await pool.query("SELECT aktiv,gesetzt_von,setter_identity_id FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1",[f])).rows[0];
 const weg=()=>pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global'");

 await section('Koordinator mit Ausweis setzt global',async()=>{
  const r=await setzeGlobal(K,null);
  check(r.success===true,'Koordinator mit Ausweis: global erlaubt '+JSON.stringify({e:r.error,d:r.details}));
  const z=await zeile('tool_beschreibungen_kurz');
  check(z?.aktiv===true&&z.gesetzt_von==='t57-k'&&z.setter_identity_id==='t57-k','Audit gesetzt_von/setter_identity_id = Identitaet');
  check((await C.leseProfilProduktSchalter('tool_beschreibungen_kurz',null)).aktiv,'global ohne Projekt lesbar EIN (tools/list liest ohne Projekt)');
  check((await C.leseProfilProduktSchalter('tool_beschreibungen_kurz',Q)).aktiv,'global wirkt auch im anderen Projekt');
  const aus=await setzeGlobal(K,null,'tool_beschreibungen_kurz',false);
  check(aus.success===true&&(await zeile('tool_beschreibungen_kurz'))?.aktiv===false,'Koordinator schaltet global wieder AUS');
  await weg();
 });

 await section('Legacy-Koordinator setzt global',async()=>{
  const r=await setzeGlobal(null,KOORD);
  check(r.success===true,'Legacy-Koordinator: global erlaubt '+JSON.stringify({e:r.error}));
  const z=await zeile('tool_beschreibungen_kurz');
  check(z?.gesetzt_von==='legacy:'+KOORD&&z.setter_identity_id===null,'Audit legacy:<id>');
  await weg();
  check(recht(await setzeGlobal(null,'koordinator-t57-tok')),'Legacy-Name einer Token-Identitaet braucht deren Ausweis');
  check(!(await zeile('tool_beschreibungen_kurz')),'nichts geschrieben');
 });

 await section('Nie: Subagent, fremder/inaktiver Koordinator, ohne Akteur',async()=>{
  check(recht(await setzeGlobal(S,null)),'Subagent mit Ausweis: recht_fehlt');
  check(recht(await setzeGlobal(null,SUB)),'Legacy-Subagent: recht_fehlt');
  check(recht(await setzeGlobal(null,null)),'ohne Akteur: recht_fehlt');
  check(recht(await setzeGlobal(KQ,null)),'Koordinator aus Q ruft mit Projekt P: recht_fehlt');
  check(recht(await setzeGlobal(KA,null)),'nicht aktiver Koordinator: recht_fehlt');
  check(!(await zeile('tool_beschreibungen_kurz')),'nichts geschrieben');
  const fehler=async(fn)=>{try{await fn();return null;}catch(e){return e.code;}};
  check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'global',funktion:'persona',aktiv:true,grund:'Test P22-T57'},{legacy_koordinator:KOORD}))==='recht_fehlt','Legacy ohne Aufrufprojekt: recht_fehlt');
  check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'global',funktion:'persona',aktiv:true,grund:'Test P22-T57'},{identity_id:'t57-s'}))==='recht_fehlt','Kern: Subagent ohne Aufrufprojekt recht_fehlt');
  const ohne=await C.setzeProfilProduktSchalter({ebene:'global',funktion:'persona',aktiv:true,grund:'Test P22-T57'},{identity_id:'t57-k'});
  check(ohne.aktiv&&ohne.gesetzt_von==='t57-k','Kern: Koordinator mit Ausweis ohne Aufrufprojekt (eigenes Projekt) erlaubt');
  await weg();
 });

 await section('Gleiche Pruefungen wie beim User',async()=>{
  check((await adm('profil_schalter_setzen',{ebene:'global',profil_funktion:'persona',aktiv:true,grund:'x'},K)).error==='grund_fehlt','Grund Pflicht');
  check((await adm('profil_schalter_setzen',{ebene:'global',profil_funktion:'gibtsnicht',aktiv:true,grund:'Test P22-T57'},K)).error==='funktion_unbekannt','Funktion geprueft');
  const m=process.env.SYNAPSE_AGENT_BEZUG_MODUS;process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
  try{
   check((await setzeGlobal(K,null,'agenten_ausweis')).error==='agent_bezug_modus_nicht_beide','Ausweis-Kern global: Modus-Pruefung auch fuer Koordinator');
   check((await setzeGlobal(USER,null,'agenten_ausweis')).error==='agent_bezug_modus_nicht_beide','... und fuer den User');
  }finally{if(m===undefined)delete process.env.SYNAPSE_AGENT_BEZUG_MODUS;else process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;}
  check((await setzeGlobal(USER,null)).success===true,'User global weiter erlaubt');
  check((await zeile('tool_beschreibungen_kurz'))?.gesetzt_von==='user','User-Audit');
  await weg();
 });

 await section('Einheitlich mit ausweis_fristen global',async()=>{
  const f=(akteur,agent)=>adm('ausweis_fristen',{modus:'setzen',ebene:'global',erstnutzung_minuten:11,grund:'Test P22-T57 Fristen'},akteur,agent);
  check((await f(K,null)).success===true,'ausweis_fristen global: Koordinator mit Ausweis');
  check((await f(null,KOORD)).success===true,'ausweis_fristen global: Legacy-Koordinator');
  check(recht(await f(S,null)),'ausweis_fristen global: Subagent recht_fehlt');
  await pool.query("DELETE FROM agent_ausweis_fristen");
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T57: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
