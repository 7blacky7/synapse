/**
 * P22-T173: Agenten-Identitaet umbenennen (admin identitaet_umbenennen, agent-umbenennung.ts) und Alias der frueheren Namen
 * (agent-namens-alias.ts). Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/agent-umbenennung-p22-t173.test.mjs
 * Abschnitte: A Schalter agent_umbenennung (Standard AUS, nicht ueber 'alle') | B Rechte je Akteur | C Pruefungen (Name, Main, belegt)
 *   | D Erfolg (Ausweis/identity_id bleiben, Eintrag umbenannt, Audit, Alias, Debug geaendert) | E Ausweis liefert den neuen Namen
 *   | F Alias-Aufloesung (loeseAgentFilter, Thought-Suche, Chat-Sicht, Channel-Verweis) | G Profil-Update-Diff 'Name alt -> neu'
 *   | H Reservierung des alten Namens (Ausweis, Umbenennung anderer) | I Rueckbenennen auf den eigenen alten Namen.
 * Jeder Check nennt seine Herkunft [Datei:Funktion]; bei Fehlschlag 'FAIL <Label>' auf stderr.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T173_ROOT||repo;
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
const schema='p22_t173_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t173',Q='p22-t173-fremd';
const failures=[];
let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,info){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(info!==undefined?' | '+mask(JSON.stringify(info)):''));}}
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-entfernung-schema','agent-namens-alias-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  // agent-entfernung-schema hat zwei Teile (126 + 129), beide in Reihenfolge.
  for(const sql of Object.values(module).filter(v=>typeof v==='string')){await pool.query(sql);await pool.query(sql);}
 }
 const C=core,USER={art:'user'};
 const BEZUG=await load('packages/core/dist/services/agent-bezug.js');
 const THOUGHTS=await load('packages/core/dist/services/thought-ids.js');
 const ENTF=await load('packages/core/dist/services/agent-entfernung.js');
 const UPD=await load('packages/core/dist/services/agent-profil-update.js');
 const IDENT=await load('packages/core/dist/services/agent-identitaet.js');
 const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
 const ident=async(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 const akt=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 await ident('t173-k',P,'t173-koord','koordinator');await ident('t173-s',P,'t173-sub','subagent');await ident('t173-b',P,'t173-belegt','subagent');
 await ident('t173-m',P,'t173-main','main');await ident('t173-f',Q,'t173-fremd','koordinator');
 const Kk=akt('t173-k',P,'koordinator'),Ss=akt('t173-s',P,'subagent'),Ff=akt('t173-f',Q,'koordinator');
 const adm=(a,args,akteur)=>C.fuehreW1bAdminAus(a,{project:P,...args},{akteur});
 const zeile=async id=>(await pool.query('SELECT id,agent_id,name,instanz_nr,status,profil_revision FROM agent_identitaeten WHERE id=$1',[id])).rows[0];
 let Z=null,TOKEN=null,REV_VOR=null;
 const ALT='t173-alt',NEU='t173-neu';

 await section('Vorbereitung',async()=>{
  const s=await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Test T173 alles ein'},USER);
  check(s.success===true,'[agent-profil-admin.ts:profil_schalter_setzen] Schalter alle EIN durch User',s);
  // Ziel mit echtem Ausweis (agent_vorbereiten) und einer Profil-Revision.
  const v=await adm('agent_vorbereiten',{agent_name:ALT,grund:'Test T173 Ausweis'},USER);
  check(v.success===true,'[agent-profil-admin.ts:agent_vorbereiten] Ziel-Identitaet mit Ausweis',v.error);
  Z=(await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[P,ALT])).rows[0]?.id;
  TOKEN=(await pool.query('SELECT token_offen FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL',[Z])).rows[0]?.token_offen;
  check(!!Z&&!!TOKEN,'[agent-identitaet.ts:stelleAgentTokenAus] Identitaet und Ausweis angelegt');
  let z=await zeile(Z);
  if(!z.profil_revision){
   const p=await adm('profil_aendern',{ziel_identity_id:Z,erwartete_revision:z.profil_revision??0,profil_patch:{briefing:'T173 Briefing'},grund:'Test T173 Revision'},USER);
   check(p.success===true,'[agent-profil-admin.ts:profil_aendern] erste Profil-Revision',p.error);
   z=await zeile(Z);
  }
  REV_VOR=z.profil_revision;
  check(REV_VOR>=1,'[agent-profil-dienst-a.ts:aendereProfil] Profil-Revision vor der Umbenennung >= 1',REV_VOR);
  // Namensgebundene Altzustaende und Inhalte unter dem alten Namen (vor der Umbenennung).
  await pool.query(`INSERT INTO thoughts(id,project,source,content,tags,"timestamp",source_identity_id) VALUES($1,$2,$3,'T173 alt ohne ID',ARRAY[]::text[],NOW()-interval '2 minutes',NULL)`,[randomUUID(),P,ALT]);
  await pool.query(`INSERT INTO thoughts(id,project,source,content,tags,"timestamp",source_identity_id) VALUES($1,$2,$3,'T173 alt mit ID',ARRAY[]::text[],NOW()-interval '2 minutes',$4)`,[randomUUID(),P,ALT,Z]);
  await pool.query(`INSERT INTO chat_messages(project,sender_id,recipient_id,content,"timestamp") VALUES($1,'t173-koord',$2,'T173 DM an alt',NOW()-interval '2 minutes')`,[P,ALT]);
 });

 await section('A Schalter agent_umbenennung',async()=>{
  check(SCH.PROFIL_PRODUKT_FUNKTIONEN.includes('agent_umbenennung')&&SCH.NUR_AUSDRUECKLICH.includes('agent_umbenennung'),
   '[agent-profil-schalter.ts:PROFIL_PRODUKT_FUNKTIONEN/NUR_AUSDRUECKLICH] agent_umbenennung im Katalog, nur ausdruecklich');
  const aus=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:NEU,grund:'Test T173 Schalter'},USER);
  check(aus.success===false&&aus.error==='funktion_aus'&&aus.details?.funktion==='agent_umbenennung',
   '[agent-profil-admin.ts:GRUPPE/pruefeSchalter] Standard AUS (auch nach alle EIN) -> funktion_aus',aus);
  check((await zeile(Z)).agent_id===ALT,'[agent-umbenennung.ts:benenneIdentitaetUm] AUS: nichts umbenannt');
  const ein=await adm('profil_schalter_setzen',{profil_funktion:'agent_umbenennung',aktiv:true,grund:'Test T173 Schalter ein'},USER);
  check(ein.success===true,'[agent-profil-admin.ts:profil_schalter_setzen] agent_umbenennung ausdruecklich EIN',ein.error);
 });

 await section('B Rechte je Akteur',async()=>{
  for(const [name,akteur] of [['Subagent mit Ausweis',Ss],['Koordinator eines fremden Projekts',Ff],['ohne Akteur',null]]){
   const r=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:NEU,grund:'Test T173 Rechte'},akteur);
   check(r.success===false&&r.error==='recht_fehlt','[agent-profil-admin.ts:fuehreW1bAdminAus/pruefeProfilVerwalter] '+name+' -> recht_fehlt',r);
  }
  check((await zeile(Z)).agent_id===ALT,'[agent-umbenennung.ts:benenneIdentitaetUm] ohne Recht nichts umbenannt');
 });

 await section('C Pruefungen',async()=>{
  for(const [name,code] of [['archiv-20261026-x','name_ungueltig'],['mit leer','name_ungueltig'],['user','name_ungueltig'],['koordinator','name_ungueltig'],['x','name_ungueltig'],['a#2','name_ungueltig']]){
   const r=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:name,grund:'Test T173 Pruefung'},USER);
   check(r.success===false&&r.error===code,'[agent-umbenennung.ts:pruefeNeuenAgentNamen] "'+name+'" -> '+code,r);
  }
  const fehlt=await adm('identitaet_umbenennen',{ziel_identity_id:Z,grund:'Test T173 Pruefung'},USER);
  check(fehlt.success===false&&fehlt.error==='neuer_name_fehlt','[agent-umbenennung.ts:pruefeNeuenAgentNamen] ohne neuer_name -> neuer_name_fehlt',fehlt);
  const grund=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:NEU},USER);
  check(grund.success===false&&grund.error==='grund_fehlt','[agent-profil-admin.ts:identitaet_umbenennen] ohne grund -> grund_fehlt',grund);
  const gleich=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:ALT,grund:'Test T173 Pruefung'},USER);
  check(gleich.success===false&&gleich.error==='name_unveraendert','[agent-umbenennung.ts:benenneIdentitaetUm] gleicher Name -> name_unveraendert',gleich);
  const belegt=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:'t173-belegt',grund:'Test T173 Pruefung'},USER);
  check(belegt.success===false&&belegt.error==='name_belegt'&&belegt.details?.belegt_durch==='identitaet','[agent-umbenennung.ts:BELEGT_SQL] Name einer anderen Identitaet -> name_belegt/identitaet',belegt);
  await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES('t173-sitzung',$1,'active')",[P]);
  const sitz=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:'t173-sitzung',grund:'Test T173 Pruefung'},USER);
  check(sitz.success===false&&sitz.error==='name_belegt'&&sitz.details?.belegt_durch==='sitzung','[agent-umbenennung.ts:BELEGT_SQL] Name einer Legacy-Sitzung -> name_belegt/sitzung',sitz);
  const main=await adm('identitaet_umbenennen',{ziel_identity_id:'t173-m',neuer_name:'t173-main-neu',grund:'Test T173 Pruefung'},USER);
  check(main.success===false&&main.error==='main_nicht_umbenennbar','[agent-umbenennung.ts:benenneIdentitaetUm] Main -> main_nicht_umbenennbar',main);
  const unb=await adm('identitaet_umbenennen',{ziel_identity_id:'t173-f',neuer_name:'t173-x',grund:'Test T173 Pruefung'},USER);
  check(unb.success===false&&unb.error==='identitaet_unbekannt','[agent-profil-admin.ts:zielIdentitaet] Identitaet eines anderen Projekts -> identitaet_unbekannt',unb);
  check((await zeile(Z)).agent_id===ALT,'[agent-umbenennung.ts:benenneIdentitaetUm] nach Fehlern unveraendert');
 });

 await section('D Erfolg (Koordinator)',async()=>{
  const tokVor=(await pool.query('SELECT id,identity_id,token_offen FROM agent_identitaet_tokens WHERE identity_id=$1 ORDER BY id',[Z])).rows;
  const r=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:NEU,grund:'Test T173 Erfolg',user_auftrag:'User 26.10. Name passt nicht'},Kk);
  check(r.success===true,'[agent-profil-admin.ts:identitaet_umbenennen] Koordinator benennt um',r);
  check(r.alt?.agent_id===ALT&&r.neu?.agent_id===NEU&&r.ziel_identity_id===Z,'[agent-umbenennung.ts:benenneIdentitaetUm] Antwort alt/neu/ziel',r);
  check(r.alias?.alter_name===ALT&&!!r.alias?.id,'[agent-umbenennung.ts:benenneIdentitaetUm] Antwort alias',r.alias);
  check(r.geaendert?.agent_identitaeten>=1,'[agent-umbenennung.ts:zaehlenderClient] Debug geaendert zaehlt agent_identitaeten',r.geaendert);
  check(r.profil_revision===REV_VOR+1,'[agent-umbenennung.ts:benenneIdentitaetUm] neue Profil-Revision (gleicher Inhalt)',{vor:REV_VOR,nach:r.profil_revision});
  const z=await zeile(Z);
  check(z.id===Z&&z.agent_id===NEU&&z.name===NEU&&z.instanz_nr===1&&z.status==='aktiv','[agent-entfernung.ts:benenneEintragUm] Identitaet: agent_id/name neu, id/Status bleiben',z);
  const tokNach=(await pool.query('SELECT id,identity_id,token_offen FROM agent_identitaet_tokens WHERE identity_id=$1 ORDER BY id',[Z])).rows;
  check(JSON.stringify(tokVor)===JSON.stringify(tokNach),'[agent-umbenennung.ts:benenneIdentitaetUm] Ausweis unveraendert (gleiche Zeilen, gleiche identity_id)');
  const au=(await pool.query("SELECT wer,alt,neu,grund FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='umbenannt'",[Z])).rows;
  check(au.length===1&&au[0].alt?.agent_id===ALT&&au[0].neu?.agent_id===NEU&&au[0].wer==='t173-k'&&au[0].neu?.user_auftrag==='User 26.10. Name passt nicht',
   '[agent-umbenennung.ts:benenneIdentitaetUm] Audit umbenannt (wer, alt, neu, user_auftrag)',au);
  const al=(await pool.query('SELECT alter_name,neuer_name,umbenannt_von,profil_revision FROM agent_namens_aliase WHERE identity_id=$1',[Z])).rows;
  check(al.length===1&&al[0].alter_name===ALT&&al[0].neuer_name===NEU&&al[0].umbenannt_von==='t173-k'&&al[0].profil_revision===REV_VOR+1,
   '[agent-umbenennung.ts:benenneIdentitaetUm] Alias-Zeile (Schema 159)',al);
  const d=await adm('profil_lesen',{ziel_identity_id:Z},USER);
  check(d.success===true&&d.aliase?.[0]?.alter_name===ALT,'[agent-profil-admin.ts:leseIdentitaetDetail] profil_lesen zeigt aliase',d.aliase);
 });

 await section('E Ausweis liefert den neuen Namen',async()=>{
  const a=await IDENT.pruefeAgentToken(TOKEN,P);
  check(a.agent_id===NEU&&a.identitaet.id===Z,'[agent-identitaet.ts:tokenIdentitaet] derselbe Ausweis meldet den neuen Namen beim naechsten Aufruf',{agent_id:a.agent_id});
 });

 await section('F Alias-Aufloesung',async()=>{
  const fAlt=await BEZUG.loeseAgentFilter(P,[ALT]);
  check(fAlt.identity_ids.includes(Z)&&fAlt.namen.includes(ALT),'[agent-bezug.ts:loeseAgentFilter] alter Name -> Identitaet (files history agent_filter)',fAlt);
  const fNeu=await BEZUG.loeseAgentFilter(P,[NEU]);
  check(fNeu.identity_ids.includes(Z)&&fNeu.namen.includes(ALT),'[agent-bezug.ts:loeseAgentFilter] neuer Name -> Identitaet + alter Name fuer Zeilen ohne ID',fNeu);
  for(const name of [ALT,NEU]){
   const t=await THOUGHTS.leseThoughtsNachSourceAusPg(P,name,50);
   const inhalte=t.map(x=>x.content).sort();
   check(inhalte.includes('T173 alt ohne ID')&&inhalte.includes('T173 alt mit ID'),'[thought-ids.ts:leseThoughtsNachSourceAusPg] Thoughts unter dem alten Namen ueber "'+name+'"',inhalte);
  }
  const sicht=await ENTF.archivSichtFuer(P,NEU);
  check(sicht.aliase?.some(a=>a.frueherer_name===ALT),'[agent-entfernung.ts:archivSichtFuer] neuer Name liest unter dem alten Namen (aliase)',sicht);
  const params=[P,NEU];const bind=v=>{params.push(v);return '$'+params.length;};
  const bed=ENTF.archivNamensBedingung('recipient_id','timestamp','$2',sicht,bind);
  const n=(await pool.query(`SELECT count(*)::int AS n FROM chat_messages WHERE project=$1 AND content='T173 DM an alt' AND ${bed}`,params)).rows[0].n;
  check(n===1,'[agent-entfernung.ts:archivNamensBedingung] alte DM an den alten Namen fuer den neuen Namen sichtbar (chat get)',{bed,n});
  const v=await ENTF.archivVerweise(P,[{name:ALT,identity:null,zeit:new Date(Date.now()-120000)},{name:'t173-koord',identity:null,zeit:new Date()}],(x)=>x);
  check(v[0]?.archiv_name===NEU&&/jetzt t173-neu/.test(v[0]?.anzeige??'')&&v[1]===null,'[agent-entfernung.ts:archivVerweise] Channel-Verweis alt -> jetzt neu',v);
 });

 await section('G Profil-Update-Diff',async()=>{
  const diff=await UPD.berechneDiff(Z,REV_VOR,REV_VOR+1,null);
  check(diff.eintraege.some(e=>e.schluessel==='name'&&e.text===`Name ${ALT} -> ${NEU}`),'[agent-profil-update.ts:berechneDiff] Hinweis w1b.profil_update nennt Name alt -> neu',diff.eintraege);
 });

 await section('H Reservierung des alten Namens',async()=>{
  const v=await adm('agent_vorbereiten',{agent_name:ALT,grund:'Test T173 Reservierung'},USER);
  check(v.success===false&&v.error==='name_ist_alias','[agent-identitaet.ts:stelleAgentTokenAus/aliasReserviertFuer] neuer Ausweis auf alten Namen -> name_ist_alias',v);
  const u=await adm('identitaet_umbenennen',{ziel_identity_id:'t173-b',neuer_name:ALT,grund:'Test T173 Reservierung'},USER);
  check(u.success===false&&u.error==='name_belegt'&&u.details?.belegt_durch==='alias','[agent-umbenennung.ts:BELEGT_SQL] andere Identitaet auf alten Namen -> name_belegt/alias',u);
 });

 await section('I Rueckbenennen auf den eigenen alten Namen',async()=>{
  const r=await adm('identitaet_umbenennen',{ziel_identity_id:Z,neuer_name:ALT,grund:'Test T173 zurueck'},USER);
  check(r.success===true&&(await zeile(Z)).agent_id===ALT,'[agent-umbenennung.ts:BELEGT_SQL] eigener frueherer Name ist frei (Alias derselben Identitaet)',r);
  const f=await BEZUG.loeseAgentFilter(P,[NEU]);
  check(f.identity_ids.includes(Z),'[agent-bezug.ts:loeseAgentFilter] Zwischenname bleibt Alias nach Rueckbenennung',f);
  const a=await IDENT.pruefeAgentToken(TOKEN,P);
  check(a.agent_id===ALT,'[agent-identitaet.ts:tokenIdentitaet] Ausweis meldet wieder den alten Namen',{agent_id:a.agent_id});
 });
}catch(e){
 failures.push('Rahmen: '+mask(e.message));console.error('FAIL Rahmen: '+mask(e.stack));
}finally{
 try{await core?.getPool?.().end?.();}catch(e){console.error('Aufraeumen Pool: '+mask(e.message));}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Aufraeumen: '+mask(e.message));}
 await admin.end().catch(()=>{});
}
console.log('P22-T173 Checks: '+checks+', Fehler: '+failures.length);
if(failures.length){console.error(failures.map(f=>' - '+f).join('\n'));process.exit(1);}
console.log('OK P22-T173 agent-umbenennung');
