/**
 * P22-T80: alte Agenten weich als 'entfernt' markieren (Entwurf thought 66c2f47d).
 * Schema 126 (Spiegel, idempotent), Vorschau (Arten, Schwelle, Ausnahmen, Hash), Schalter AUS = nichts passiert, ausfuehren mit
 * Bestaetigung, Ausblenden in chat list / Spezialistenliste / Channel-Teilnehmern / Ausweisuebersicht, Daten bleiben, Wiederherstellen,
 * Rueckkehr durch Anmeldung, Einstellung der Schwelle, Rechte.
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon/Docker.
 *   node packages/core/tests/agent-entfernung-p22-t80.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T80_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t80_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-ausweis-fristen-schema','agent-ausweis-projekte-schema','agent-verbrauch-schema','agent-entfernung-schema']){
  try{const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);}catch(e){if(file!=='agent-entfernung-schema'&&/Cannot find module|ERR_MODULE_NOT_FOUND/.test(e.message))continue;throw e;}
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},P='p80',ANDERES='p80-anderes';
 const tage=n=>new Date(Date.now()-n*86400000);
 const chat=await load('packages/core/dist/services/chat.js');

 await section('Schema 126: Spiegel identisch, idempotent, in ensureSchema',async()=>{
  const sql=readFileSync(join(root,'packages/core/src/db/schema-sql/126_agent_entfernung.sql'),'utf8');
  check(sql.trim()===C.AGENT_ENTFERNUNG_SCHEMA_SQL.trim(),'126 SQL-Spiegel identisch');
  check(!C.AGENT_ENTFERNUNG_SCHEMA_SQL.split('\n').some(z=>z.trim().startsWith('//')),'keine //-Kommentare im SQL');
  await pool.query(C.AGENT_ENTFERNUNG_SCHEMA_SQL);await pool.query(C.AGENT_ENTFERNUNG_SCHEMA_SQL);
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS agent_entfernungen ('),'126 im ensureSchema-SQL');
  const t=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('agent_entfernungen','agent_entfernung_einstellungen') ORDER BY 1",[schema]);
  check(t.rowCount===2,'beide Tabellen im Testschema',t.rows);
 });

 // ---- Bestand -------------------------------------------------------------------------------------------------------------
 const sitzung=async(id,project,alt)=>pool.query("INSERT INTO agent_sessions (id,project,status,registered_at,sitzung_seit,aktiv_seit) VALUES ($1,$2,'active',$3,$3,$3)",[id,project,tage(alt)]);
 const identitaet=async(id,name,rolle,alt,project=P)=>pool.query("INSERT INTO agent_identitaeten (id,project,name,agent_id,rolle,erstellt_von,erstellt_am,zuletzt_aktiv) VALUES ($1,$2,$3,$3,$4,'test',$5,$5)",[id,project,name,rolle,tage(alt+10)].map((v,i)=>i===4?tage(alt):v));
 let MAIN;
 await section('Bestand anlegen',async()=>{
  await sitzung('alt-a',P,40);await sitzung('neu-b',P,2);await sitzung('alt-c',P,31);await sitzung('grenz',P,29);
  await sitzung('koordinator',P,60);await sitzung('res-agent',P,60);await sitzung('fremd-alt',ANDERES,90);
  await pool.query("INSERT INTO thoughts (id,project,source,content,tags,timestamp) VALUES ($1,$2,'alt-c','Lebenszeichen',ARRAY[]::text[],$3)",[randomUUID(),P,tage(3)]);
  await pool.query("INSERT INTO thoughts (id,project,source,content,tags,timestamp) VALUES ($1,$2,'alt-a','alte Arbeit',ARRAY[]::text[],$3)",[randomUUID(),P,tage(45)]);
  await pool.query("INSERT INTO file_reservations (project,agent_id,file_path,reserved_at,expires_at,content_hash_at_reservation) VALUES ($1,'res-agent','x.ts',NOW(),NOW()+INTERVAL '1 hour','h')",[P]);
  await pool.query("INSERT INTO wrapper_status (agent_name,project,status,last_activity) VALUES ('wrap-alt',$1,'stopped',$2)",[P,tage(50)]);
  await identitaet('alt-ident-id','alt-ident','subagent',50);
  await identitaet('k80','koord-ident','koordinator',50);
  await identitaet('neu-ident-id','neu-ident','subagent',1);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T80 Ausweis-Kern'},{system:'user'});
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T80 Main'});
  MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
  await pool.query("UPDATE agent_identitaeten SET zuletzt_aktiv=$2,erstellt_am=$2 WHERE id=$1",[MAIN,tage(80)]);
  const ch=await pool.query("INSERT INTO specialist_channels (name,project,created_by) VALUES ('chan80',$1,'test') RETURNING id",[P]);
  for(const a of ['alt-a','neu-b'])await pool.query("INSERT INTO specialist_channel_members (channel_id,agent_name) VALUES ($1,$2)",[ch.rows[0].id,a]);
  check(true,'Bestand angelegt');
 });

 const KOORD={art:'identitaet',principal:{art:'identity',project:P,agent_id:'koord-ident',identity_id:'k80',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null}};
 const admin_=(args,akteur=USER)=>C.fuehreAgentEntfernungAdminAus('agenten_aufraeumen',args,akteur);
 const ids=(l,art)=>l.filter(k=>k.art===art).map(k=>k.agent_id).sort();
 let vor;

 await section('Vorschau: Arten, Schwelle, Ausnahmen',async()=>{
  vor=await admin_({project:P});
  check(vor.success===true&&vor.modus==='vorschau'&&vor.tage===30,'Vorschau erfolgreich, Schwelle 30 (Standard)',vor);
  check(JSON.stringify(ids(vor.kandidaten,'legacy'))===JSON.stringify(['alt-a','wrap-alt']),'Legacy: alt-a (40 Tage), wrap-alt (nur Wrapper-Status); alt-c hat Thought, grenz 29 Tage, neu-b neu',ids(vor.kandidaten,'legacy'));
  check(JSON.stringify(ids(vor.kandidaten,'identitaet'))===JSON.stringify(['alt-ident']),'Identitaet: alt-ident',ids(vor.kandidaten,'identitaet'));
  const gr=Object.fromEntries(vor.ausgenommen.map(a=>[a.agent_id,a.grund]));
  check(gr.koordinator==='geschuetzter_name'&&gr['koord-ident']==='rolle_koordinator'&&gr['res-agent']==='aktive_dateireservierung','Ausnahmen mit Grund: Name, Koordinator-Rolle, Reservierung',gr);
  check(vor.anzahl.gesamt===3&&vor.anzahl.legacy===2&&vor.anzahl.identitaet===1&&vor.schalter.aktiv===false,'Anzahlen + Schalter AUS sichtbar',vor.anzahl);
  check(typeof vor.bestaetigung==='string'&&vor.bestaetigung.length===16,'Bestaetigung (Hash)');
  const k=vor.kandidaten.find(x=>x.agent_id==='alt-a');
  check(k&&k.letzte_spur&&new Date(k.letzte_aktivitaet).getTime()<tage(39).getTime(),'letzte Aktivitaet + Spur je Kandidat',k);
  const eng=await admin_({project:P,aufraeumen_tage:28});
  check(ids(eng.kandidaten,'legacy').includes('grenz'),'Schwelle 28 Tage: Grenzfall grenz (29) ist Kandidat',ids(eng.kandidaten,'legacy'));
  const alle=await admin_({});
  check(alle.kandidaten.some(x=>x.agent_id==='fremd-alt')&&alle.ausgenommen.some(a=>a.identity_id===MAIN&&/main|geschuetzt/.test(a.grund)),'User ohne project: alle Projekte; Main ausgenommen',alle.ausgenommen.filter(a=>a.identity_id===MAIN));
  check(ids((await admin_({project:P,aufraeumen_art:'identitaet'})).kandidaten,'legacy').length===0,'art identitaet beschraenkt');
  check(JSON.stringify((await admin_({project:P,aufraeumen_ids:['alt-a']})).kandidaten.map(x=>x.agent_id))===JSON.stringify(['alt-a']),'ids beschraenken');
  const st=await admin_({aufraeumen_modus:'status'});
  check(st.success===true&&st.schalter.aktiv===false&&st.schwelle.quelle==='standard'&&st.offene_markierungen.length===0,'status zeigt Schalter, Schwelle+Quelle, keine Markierungen',st);
 });

 await section('Task-Warnung (keine Ausnahme), Dispatch ueber admin',async()=>{
  await pool.query("INSERT INTO plan_tasks (id,project,plan_id,task,updated_at) VALUES ('t80-a',$1,'plan-80',$2::jsonb,'2026-10-01')",[P,JSON.stringify({status:'in_progress',kurz_id:'P80-T1',beteiligte:[{identity_id:'alt-ident-id',agent_id:'alt-ident'},{agent_id:'alt-a'}]})]);
  await pool.query("INSERT INTO plan_tasks (id,project,plan_id,task,updated_at) VALUES ('t80-b',$1,'plan-80',$2::jsonb,'2026-10-01')",[P,JSON.stringify({status:'done',kurz_id:'P80-T2',beteiligte:[{agent_id:'wrap-alt'}]})]);
  const v=await admin_({project:P});
  const w=Object.fromEntries(v.kandidaten.map(k=>[k.agent_id,k.warnungen]));
  check(JSON.stringify(w['alt-ident'])===JSON.stringify(['offene_task:P80-T1'])&&JSON.stringify(w['alt-a'])===JSON.stringify(['offene_task:P80-T1']),'offene Task als Warnung bei Identitaet und Legacy',w);
  check(w['wrap-alt'].length===0,'erledigte Task (done) warnt nicht',w);
  check(v.kandidaten.length===3&&v.anzahl.mit_warnung===2&&v.warnungen.length===2,'Warnung nimmt NICHT aus: weiter 3 Kandidaten, 2 mit Warnung',v.anzahl);
  check(v.bestaetigung===vor.bestaetigung,'Warnungen aendern die Bestaetigung nicht');
  const d=await C.fuehreW1bAdminAus('agenten_aufraeumen',{project:P},{akteur:{art:'user'}});
  check(d.success===true&&d.modus==='vorschau'&&d.anzahl.gesamt===3,'Dispatch fuehreW1bAdminAus -> agenten_aufraeumen',d);
  check(C.istW1bAdminAction('agenten_aufraeumen')&&C.W1B_ADMIN_ACTIONS.includes('agenten_aufraeumen')&&C.W1B_ADMIN_PARAMETER.aufraeumen_modus&&C.W1B_ADMIN_PARAMETER.mit_entfernten,'Aktion + Parameter im W1B-Katalog');
 });

 await section('Rechte',async()=>{
  const k=await admin_({project:P},KOORD);
  check(k.success===true&&k.kandidaten.length===3,'Koordinator sieht die Vorschau seines Projekts',k.error);
  const fremd=await admin_({project:ANDERES},KOORD);
  check(fremd.success===false&&fremd.error==='recht_fehlt','Koordinator fremdes Projekt -> recht_fehlt',fremd);
  const ohneAuftrag=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:vor.bestaetigung},KOORD);
  check(ohneAuftrag.success===false&&ohneAuftrag.error==='user_auftrag_fehlt','Koordinator ohne user_auftrag -> user_auftrag_fehlt',ohneAuftrag);
  check((await admin_({project:P},null)).error==='recht_fehlt','ohne Akteur -> recht_fehlt');
  const bad=await admin_({project:P,aufraeumen_tage:3});
  check(bad.success===false&&bad.error==='tage_ungueltig','tage < 7 -> tage_ungueltig',bad);
 });

 await section('Schalter AUS: ausfuehren abgewiesen, nichts markiert, nichts ausgeblendet',async()=>{
  const r=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:vor.bestaetigung});
  check(r.success===false&&r.error==='funktion_aus','ausfuehren -> funktion_aus',r);
  check((await pool.query('SELECT count(*)::int n FROM agent_entfernungen')).rows[0].n===0,'keine Markierung');
  check((await C.listActiveAgents(P)).some(a=>a.id==='alt-a'),'alt-a bleibt sichtbar');
 });

 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_entfernung',aktiv:true,grund:'Test T80 EIN'},{system:'user'});
 C.leereEntfernungCache();

 let lauf;
 await section('Ausfuehren: Bestaetigung, Markierung, Audit, idempotent',async()=>{
  check((await admin_({project:P,aufraeumen_modus:'ausfuehren'})).error==='bestaetigung_fehlt','ohne bestaetigung -> bestaetigung_fehlt');
  const falsch=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:'0000000000000000'});
  check(falsch.error==='vorschau_veraltet','falsche bestaetigung -> vorschau_veraltet',falsch);
  const r=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:vor.bestaetigung,user_auftrag:'Test T80'});
  check(r.success===true&&r.entfernt===3&&r.schon_markiert===0&&typeof r.lauf_id==='string',' ausfuehren entfernt 3 (alt-a, wrap-alt, alt-ident)',r);
  lauf=r.lauf_id;
  const m=(await pool.query("SELECT art,agent_id,identity_id,entfernt_grund,schwelle_tage,entfernt_von,letzte_aktivitaet FROM agent_entfernungen ORDER BY agent_id")).rows;
  check(m.length===3&&m.every(x=>x.entfernt_grund==='wurde entfernt: inaktiv > 30 Tage'&&x.schwelle_tage===30&&x.letzte_aktivitaet&&/Auftrag: Test T80/.test(x.entfernt_von)),'Markierungen mit Grund, Schwelle, letzter Aktivitaet, Auftrag',m);
  const au=(await pool.query("SELECT aktion,identity_id FROM agent_identitaet_audit WHERE aktion='entfernt'")).rows;
  check(au.length===1&&au[0].identity_id==='alt-ident-id','Audit-Zeile nur fuer die Identitaet',au);
  const v2=await admin_({project:P});
  check(v2.kandidaten.length===0,'danach keine Kandidaten mehr (bereits markiert)',v2.kandidaten.length);
  const r2=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:v2.bestaetigung});
  check(r2.success===true&&r2.entfernt===0,'zweiter Lauf entfernt 0',r2);
  const st=await admin_({aufraeumen_modus:'status',project:P});
  check(st.offene_markierungen.reduce((s,x)=>s+x.n,0)===3&&st.letzte_laeufe[0]?.lauf_id===lauf&&st.filter_wirksam===true,'status: 3 offene Markierungen, letzter Lauf, Filter wirksam',st);
 });

 await section('Ausblenden bei Schalter EIN, Daten bleiben',async()=>{
  const aktive=(await C.listActiveAgents(P)).map(a=>a.id);
  check(!aktive.includes('alt-a')&&aktive.includes('neu-b')&&aktive.includes('alt-c'),'chat list: alt-a weg, neu-b und alt-c da',aktive);
  const w=(await C.listWrapperStatus(P)).map(x=>x.agentName);
  check(!w.includes('wrap-alt'),'Spezialistenliste: wrap-alt weg',w);
  const ct=(await C.holeChannelTeilnehmer(P,'chan80')).map(x=>x.agent);
  check(!ct.includes('alt-a')&&ct.includes('neu-b'),'Channel-Teilnehmer: alt-a weg',ct);
  const cu=await C.baueChannelUebersicht(P,false);
  check(cu&&!cu.channels[0].agenten.some(x=>/alt-a/.test(x))&&cu.channels[0].agenten.some(x=>/neu-b/.test(x)),'Channel-Uebersicht (Onboarding): alt-a weg',cu);
  const prof=await C.markiereEntfernteProfile(P,[{identity_id:'alt-ident-id'},{identity_id:'neu-ident-id'}],false);
  check(prof.length===1&&prof[0].identity_id==='neu-ident-id','Ausweisuebersicht: alt-ident weg',prof);
  const mit=await C.markiereEntfernteProfile(P,[{identity_id:'alt-ident-id'},{identity_id:'neu-ident-id'}],true);
  check(mit.length===2&&mit[0].entfernt?.grund==='wurde entfernt: inaktiv > 30 Tage','mit_entfernten: beide, Feld entfernt',mit);
  // Daten bleiben
  check((await pool.query("SELECT count(*)::int n FROM agent_sessions WHERE id='alt-a'")).rows[0].n===1&&(await pool.query("SELECT count(*)::int n FROM thoughts WHERE source='alt-a'")).rows[0].n===1
    &&(await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE id='alt-ident-id'")).rows[0].n===1&&(await pool.query("SELECT count(*)::int n FROM wrapper_status WHERE agent_name='wrap-alt'")).rows[0].n===1,'Sitzung, Thought, Identitaet, Wrapper-Status bleiben unveraendert');
 });

 await section('Agentenwissen- und Skill-Hook-Listen ohne Entfernte, Wissen bleibt',async()=>{
  for(const a of ['alt-a','neu-b'])await pool.query("INSERT INTO agent_wissen (project,agent_name,art,inhalt) VALUES ($1,$2,'regeln','x')",[P,a]);
  const wl=(await C.listeWissensAgenten(P)).map(x=>x.agent);
  check(!wl.includes('alt-a')&&wl.includes('neu-b'),'listeWissensAgenten: alt-a weg, neu-b da',wl);
  check((await pool.query("SELECT count(*)::int n FROM agent_wissen WHERE agent_name='alt-a'")).rows[0].n===1,'Wissenszeile von alt-a bleibt');
  const sk=await C.aktiveProjektAgenten(P);
  check(!sk.some(k=>/alt-a|alt-ident-id/.test(k))&&sk.some(k=>/neu-b/.test(k)),'Skill-Hook-Empfaenger (aktiveProjektAgenten): Entfernte weg',sk);
  await pool.query("INSERT INTO specialist_channel_members (channel_id,agent_name) SELECT id,'alt-a' FROM specialist_channels WHERE name='chan80' ON CONFLICT DO NOTHING");
 });

 await section('Schalter AUS: alles wieder sichtbar, Markierungen bleiben',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_entfernung',aktiv:false,grund:'Test T80 AUS'},{system:'user'});C.leereEntfernungCache();
  check((await C.listActiveAgents(P)).some(a=>a.id==='alt-a'),'alt-a wieder sichtbar');
  check((await pool.query('SELECT count(*)::int n FROM agent_entfernungen WHERE wiederhergestellt_am IS NULL')).rows[0].n===3,'Markierungen bleiben');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_entfernung',aktiv:true,grund:'Test T80 EIN'},{system:'user'});C.leereEntfernungCache();
 });

 await section('Wiederherstellen und Rueckkehr',async()=>{
  check((await admin_({project:P,aufraeumen_modus:'wiederherstellen',grund:'Test T80 ohne Auswahl'})).error==='auswahl_fehlt','ohne Auswahl -> auswahl_fehlt');
  check((await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_lauf_id:lauf})).error==='grund_fehlt','ohne grund -> grund_fehlt');
  const one=await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_ids:['alt-ident-id'],grund:'Test T80 einzeln'});
  check(one.success===true&&one.wiederhergestellt===1,'einzeln per identity_id wiederhergestellt',one);
  check((await C.markiereEntfernteProfile(P,[{identity_id:'alt-ident-id'}],false)).length===1,'alt-ident wieder sichtbar');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE aktion='entfernung_aufgehoben'")).rows[0].n===1,'Audit entfernung_aufgehoben');
  const rest=await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_lauf_id:lauf,grund:'Test T80 Lauf'});
  check(rest.success===true&&rest.wiederhergestellt===2,'Rest des Laufs wiederhergestellt',rest);
  check((await C.listActiveAgents(P)).some(a=>a.id==='alt-a'),'alt-a sichtbar');
  check((await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_lauf_id:lauf,grund:'Test T80 nochmal'})).wiederhergestellt===0,'zweites Wiederherstellen = 0');
  // Rueckkehr: erneut entfernen, dann meldet sich alt-a
  const v=await admin_({project:P,aufraeumen_ids:['alt-a']});
  check(v.kandidaten.length===1,'alt-a ist wieder Kandidat',v.kandidaten.length);
  await admin_({project:P,aufraeumen_ids:['alt-a'],aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:v.bestaetigung});
  check(!(await C.listActiveAgents(P)).some(a=>a.id==='alt-a'),'alt-a wieder ausgeblendet');
  await chat.registerAgent('alt-a',P,'opus');
  const rk=(await pool.query("SELECT wiederhergestellt_von FROM agent_entfernungen WHERE agent_id='alt-a' AND wiederhergestellt_am IS NOT NULL ORDER BY id DESC LIMIT 1")).rows[0];
  check(rk?.wiederhergestellt_von==='auto:anmeldung'&&(await C.listActiveAgents(P)).some(a=>a.id==='alt-a'),'Rueckkehr per chat register schliesst die Markierung automatisch',rk);
 });

 await section('Einstellung der Schwelle',async()=>{
  const r=await admin_({aufraeumen_modus:'einstellen',aufraeumen_tage:14,grund:'Test T80'});
  check(r.success===true&&r.schwelle.tage===14&&r.schwelle.quelle==='einstellung','Schwelle 14, Quelle einstellung',r);
  check((await admin_({project:P})).tage===14,'Vorschau nutzt die Einstellung');
  check((await admin_({aufraeumen_modus:'einstellen',aufraeumen_tage:3,grund:'Test T80 zu klein'})).error==='tage_ungueltig','3 Tage -> tage_ungueltig');
  check((await admin_({aufraeumen_modus:'einstellen',aufraeumen_tage:20},KOORD)).error==='user_auftrag_fehlt','Koordinator braucht user_auftrag');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T80: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
