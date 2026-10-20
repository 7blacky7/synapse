/**
 * P22-T80: alte Agenten archivieren (Entwurf thought 66c2f47d, Teil 3 nach User-Entscheidung 8edbc2c7: UMBENENNEN in archiv-<Datum>-<alt>).
 * Schema 126 + 129 (Spiegel, idempotent), Vorschau (Arten, Schwelle, Ausnahmen, Hash, alt -> neu), Koordinatoren eingeschlossen, Schalter AUS =
 * nichts passiert, ausfuehren mit Bestaetigung benennt Eintraege um (Sitzung, Wrapper, Channel-Mitglied, Identitaet + Status deaktiviert),
 * Ausweis danach gesperrt, Ausblenden in den Listen, Inhalte unveraendert und mit Archiv-Verweis lesbar (Channel-Feed, thought get, Suche per
 * Archivname), neuer Agent mit altem Namen = neuer Eintrag, Wiederherstellen nur bei freiem Namen (sonst name_belegt), Einstellung, Rechte.
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
 await pool.query(core.AGENT_UMBENENNUNG_SCHEMA_SQL);await pool.query(core.AGENT_UMBENENNUNG_SCHEMA_SQL);
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},P='p80',ANDERES='p80-anderes';
 const tage=n=>new Date(Date.now()-n*86400000);
 const chat=await load('packages/core/dist/services/chat.js');
 const channels=await load('packages/core/dist/services/channels.js');
 const thoughtIds=await load('packages/core/dist/services/thought-ids.js');
 const inbox=await load('packages/core/dist/services/inbox.js');
 const arch=alt=>C.archivNameFuer(alt,new Date());
 const fehlerCode=async f=>{try{await f();return null;}catch(e){return e.code||e.message;}};

 await section('Schema 126: Spiegel identisch, idempotent, in ensureSchema',async()=>{
  const sql=readFileSync(join(root,'packages/core/src/db/schema-sql/126_agent_entfernung.sql'),'utf8');
  check(sql.trim()===C.AGENT_ENTFERNUNG_SCHEMA_SQL.trim(),'126 SQL-Spiegel identisch');
  check(!C.AGENT_ENTFERNUNG_SCHEMA_SQL.split('\n').some(z=>z.trim().startsWith('//')),'keine //-Kommentare im SQL');
  await pool.query(C.AGENT_ENTFERNUNG_SCHEMA_SQL);await pool.query(C.AGENT_ENTFERNUNG_SCHEMA_SQL);
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS agent_entfernungen ('),'126 im ensureSchema-SQL');
  const sql129=readFileSync(join(root,'packages/core/src/db/schema-sql/129_agent_umbenennung.sql'),'utf8');
  check(sql129.trim()===C.AGENT_UMBENENNUNG_SCHEMA_SQL.trim(),'129 SQL-Spiegel identisch');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.indexOf('ADD COLUMN IF NOT EXISTS frueherer_name')>SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS agent_entfernungen ('),'129 im ensureSchema-SQL nach 126');
  const sp=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_entfernungen' AND column_name IN ('frueherer_name','neuer_name','frueherer_identitaet_name','frueherer_status')",[schema])).rowCount;
  check(sp===4,'129: vier neue Spalten',sp);
  const t=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('agent_entfernungen','agent_entfernung_einstellungen') ORDER BY 1",[schema]);
  check(t.rowCount===2,'beide Tabellen im Testschema',t.rows);
 });

 // ---- Bestand -------------------------------------------------------------------------------------------------------------
 const sitzung=async(id,project,alt)=>pool.query("INSERT INTO agent_sessions (id,project,status,registered_at,sitzung_seit,aktiv_seit) VALUES ($1,$2,'active',$3,$3,$3)",[id,project,tage(alt)]);
 const identitaet=async(id,name,rolle,alt,project=P)=>pool.query("INSERT INTO agent_identitaeten (id,project,name,agent_id,rolle,erstellt_von,erstellt_am,zuletzt_aktiv) VALUES ($1,$2,$3,$3,$4,'test',$5,$5)",[id,project,name,rolle,tage(alt+10)].map((v,i)=>i===4?tage(alt):v));
 let MAIN,AUSW,THOUGHT_ALT_A,KANAL;
 await section('Bestand anlegen',async()=>{
  await sitzung('alt-a',P,40);await sitzung('neu-b',P,2);await sitzung('alt-c',P,31);await sitzung('grenz',P,29);
  await sitzung('koordinator',P,60);await sitzung('res-agent',P,60);await sitzung('fremd-alt',ANDERES,90);
  await pool.query("INSERT INTO thoughts (id,project,source,content,tags,timestamp) VALUES ($1,$2,'alt-c','Lebenszeichen',ARRAY[]::text[],$3)",[randomUUID(),P,tage(3)]);
  THOUGHT_ALT_A=randomUUID();
  await pool.query("INSERT INTO thoughts (id,project,source,content,tags,timestamp) VALUES ($1,$2,'alt-a','alte Arbeit',ARRAY[]::text[],$3)",[THOUGHT_ALT_A,P,tage(45)]);
  await pool.query("INSERT INTO file_reservations (project,agent_id,file_path,reserved_at,expires_at,content_hash_at_reservation) VALUES ($1,'res-agent','x.ts',NOW(),NOW()+INTERVAL '1 hour','h')",[P]);
  await pool.query("INSERT INTO wrapper_status (agent_name,project,status,last_activity) VALUES ('wrap-alt',$1,'stopped',$2)",[P,tage(50)]);
  await identitaet('alt-ident-id','alt-ident','subagent',50);
  await identitaet('k80','koord-ident','koordinator',1);
  await identitaet('k-alt','koord-alt','koordinator',50);
  await identitaet('neu-ident-id','neu-ident','subagent',1);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T80 Ausweis-Kern'},{system:'user'});
  AUSW=await C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name:'ausw-alt',grund:'Test T80 Ausweis alt'},USER);
  await pool.query("UPDATE agent_identitaeten SET zuletzt_aktiv=$2,erstellt_am=$3 WHERE id=$1",[AUSW.identity_id,tage(50),tage(60)]);
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T80 Main'});
  MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
  await pool.query("UPDATE agent_identitaeten SET zuletzt_aktiv=$2,erstellt_am=$2 WHERE id=$1",[MAIN,tage(80)]);
  const ch=await pool.query("INSERT INTO specialist_channels (name,project,created_by) VALUES ('chan80',$1,'test') RETURNING id",[P]);
  KANAL=ch.rows[0].id;
  for(const a of ['alt-a','neu-b'])await pool.query("INSERT INTO specialist_channel_members (channel_id,agent_name) VALUES ($1,$2)",[KANAL,a]);
  await pool.query("INSERT INTO specialist_channel_messages (channel_id,sender,content,created_at) VALUES ($1,'alt-a','Beitrag vom alten alt-a',$2)",[KANAL,tage(45)]);
  await pool.query("INSERT INTO chat_messages (project,sender_id,recipient_id,content,timestamp) VALUES ($1,'koord-ident','alt-a','DM an alten alt-a',$2),($1,'alt-a','neu-b','DM vom alten alt-a',$3)",[P,tage(45),tage(44)]);
  await pool.query("INSERT INTO specialist_inbox (project,from_agent,to_agent,content,created_at) VALUES ($1,'koord-ident','alt-a','Inbox an alten alt-a',$2)",[P,tage(45)]);
  await pool.query("INSERT INTO agent_wissen (project,agent_name,art,form,inhalt) VALUES ($1,'alt-a','regeln','block','Wissen des alten alt-a')",[P]);
  check(typeof AUSW?.token==='string'&&AUSW.identity_id,'Bestand angelegt (inkl. Ausweis-Identitaet ausw-alt)',AUSW&&{id:AUSW.identity_id});
 });

 const KOORD={art:'identitaet',principal:{art:'identity',project:P,agent_id:'koord-ident',identity_id:'k80',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null}};
 const admin_=(args,akteur=USER)=>C.fuehreAgentEntfernungAdminAus('agenten_aufraeumen',args,akteur);
 const ids=(l,art)=>l.filter(k=>k.art===art).map(k=>k.agent_id).sort();
 let vor;

 await section('Vorschau: Arten, Schwelle, Ausnahmen',async()=>{
  vor=await admin_({project:P});
  check(vor.success===true&&vor.modus==='vorschau'&&vor.tage===30,'Vorschau erfolgreich, Schwelle 30 (Standard)',vor);
  check(JSON.stringify(ids(vor.kandidaten,'legacy'))===JSON.stringify(['alt-a','koordinator','wrap-alt']),'Legacy: alt-a (40 Tage), koordinator (Name schuetzt nicht mehr), wrap-alt (nur Wrapper); alt-c hat Thought, grenz 29 Tage, neu-b neu',ids(vor.kandidaten,'legacy'));
  check(JSON.stringify(ids(vor.kandidaten,'identitaet'))===JSON.stringify(['alt-ident','ausw-alt','koord-alt']),'Identitaet: alt-ident, ausw-alt (mit Ausweis), koord-alt (Koordinator-Rolle schuetzt nicht mehr)',ids(vor.kandidaten,'identitaet'));
  const gr=Object.fromEntries(vor.ausgenommen.map(a=>[a.agent_id,a.grund]));
  check(gr.koordinator===undefined&&gr['koord-alt']===undefined&&gr['koord-ident']===undefined&&gr['res-agent']==='aktive_dateireservierung','Ausnahmen: nur Reservierung (kein Name/Koordinator mehr); aktiver Koordinator ist gar kein Kandidat',gr);
  check(vor.anzahl.gesamt===6&&vor.anzahl.legacy===3&&vor.anzahl.identitaet===3&&vor.schalter.aktiv===false,'Anzahlen + Schalter AUS sichtbar',vor.anzahl);
  const alt2neu=Object.fromEntries(vor.kandidaten.map(k=>[k.agent_id,k.neuer_name]));
  check(alt2neu['alt-a']===arch('alt-a')&&alt2neu.koordinator===arch('koordinator')&&alt2neu['koord-alt']===arch('koord-alt')&&/^archiv-\d{8}-alt-a$/.test(alt2neu['alt-a']),'Vorschau zeigt alt -> neu je Agent (archiv-<YYYYMMDD>-<alt>)',alt2neu);
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
  check(v.kandidaten.length===6&&v.anzahl.mit_warnung===2&&v.warnungen.length===2,'Warnung nimmt NICHT aus: weiter 6 Kandidaten, 2 mit Warnung',v.anzahl);
  check(v.bestaetigung===vor.bestaetigung,'Warnungen aendern die Bestaetigung nicht');
  const d=await C.fuehreW1bAdminAus('agenten_aufraeumen',{project:P},{akteur:{art:'user'}});
  check(d.success===true&&d.modus==='vorschau'&&d.anzahl.gesamt===6,'Dispatch fuehreW1bAdminAus -> agenten_aufraeumen',d);
  check(C.istW1bAdminAction('agenten_aufraeumen')&&C.W1B_ADMIN_ACTIONS.includes('agenten_aufraeumen')&&C.W1B_ADMIN_PARAMETER.aufraeumen_modus&&C.W1B_ADMIN_PARAMETER.mit_entfernten,'Aktion + Parameter im W1B-Katalog');
 });

 await section('Rechte',async()=>{
  const k=await admin_({project:P},KOORD);
  check(k.success===true&&k.kandidaten.length===6,'Koordinator sieht die Vorschau seines Projekts',k.error);
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
 await section('Ausfuehren: Bestaetigung, Umbenennung, Markierung, Audit, idempotent',async()=>{
  check((await admin_({project:P,aufraeumen_modus:'ausfuehren'})).error==='bestaetigung_fehlt','ohne bestaetigung -> bestaetigung_fehlt');
  const falsch=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:'0000000000000000'});
  check(falsch.error==='vorschau_veraltet','falsche bestaetigung -> vorschau_veraltet',falsch);
  const r=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:vor.bestaetigung,user_auftrag:'Test T80'});
  check(r.success===true&&r.entfernt===6&&r.schon_markiert===0&&typeof r.lauf_id==='string','ausfuehren archiviert 6',r);
  check(r.umbenannt?.length===6&&r.umbenannt.some(u=>u.alt==='koordinator'&&u.neu===arch('koordinator')),'Ergebnis listet alt -> neu',r.umbenannt);
  lauf=r.lauf_id;
  const m=(await pool.query("SELECT art,agent_id,frueherer_name,neuer_name,frueherer_status,identity_id,entfernt_grund,schwelle_tage,entfernt_von,letzte_aktivitaet FROM agent_entfernungen ORDER BY frueherer_name")).rows;
  check(m.length===6&&m.every(x=>x.entfernt_grund==='archiviert (umbenannt): inaktiv > 30 Tage'&&x.schwelle_tage===30&&x.letzte_aktivitaet&&/Auftrag: Test T80/.test(x.entfernt_von)
    &&x.agent_id===arch(x.frueherer_name)&&x.neuer_name===x.agent_id),'Markierungen: agent_id = neuer Name, frueherer_name = alt, Grund, Schwelle, Auftrag',m);
  const q1=async(sql,p)=>(await pool.query(sql,p)).rows;
  check((await q1("SELECT id FROM agent_sessions WHERE id=ANY($1)",[['alt-a','koordinator']])).length===0&&(await q1("SELECT id FROM agent_sessions WHERE id=ANY($1)",[[arch('alt-a'),arch('koordinator')]])).length===2,'Sitzungen alt-a und koordinator umbenannt (alter Name frei)');
  check((await q1("SELECT 1 FROM wrapper_status WHERE agent_name=$1",[arch('wrap-alt')])).length===1&&(await q1("SELECT 1 FROM wrapper_status WHERE agent_name='wrap-alt'")).length===0,'Wrapper-Status umbenannt');
  check(JSON.stringify((await q1("SELECT agent_name FROM specialist_channel_members WHERE channel_id=$1 ORDER BY 1",[KANAL])).map(x=>x.agent_name))===JSON.stringify([arch('alt-a'),'neu-b'].sort()),'Channel-Mitgliedschaft umbenannt');
  const ia=(await q1("SELECT agent_id,name,status FROM agent_identitaeten WHERE id='alt-ident-id'"))[0];
  check(ia.agent_id===arch('alt-ident')&&ia.name===arch('alt-ident')&&ia.status==='deaktiviert','Identitaet umbenannt (agent_id + name) und deaktiviert',ia);
  check(m.find(x=>x.frueherer_name==='alt-ident')?.frueherer_status==='aktiv','frueherer Status gespeichert');
  const au=(await pool.query("SELECT aktion,identity_id,alt,neu FROM agent_identitaet_audit WHERE aktion='archiviert' ORDER BY identity_id")).rows;
  check(au.length===3&&au.some(x=>x.identity_id==='k-alt'),'Audit archiviert je Identitaet (inkl. Koordinator)',au.map(x=>x.identity_id));
  const login=await fehlerCode(async()=>C.meldeAgentMitTokenAn(AUSW.token,P,await C.leseAgentBezugModus()));
  check(login!==null,'Ausweis der archivierten Identitaet: Anmeldung abgewiesen',login);
  const v2=await admin_({project:P});
  check(v2.kandidaten.length===0,'danach keine Kandidaten mehr (bereits markiert)',v2.kandidaten.length);
  const r2=await admin_({project:P,aufraeumen_modus:'ausfuehren',aufraeumen_bestaetigung:v2.bestaetigung});
  check(r2.success===true&&r2.entfernt===0,'zweiter Lauf entfernt 0',r2);
  const st=await admin_({aufraeumen_modus:'status',project:P});
  check(st.offene_markierungen.reduce((s,x)=>s+x.n,0)===6&&st.letzte_laeufe[0]?.lauf_id===lauf&&st.filter_wirksam===true,'status: 6 offene Markierungen, letzter Lauf, Filter wirksam',st);
 });

 await section('Ausblenden bei Schalter EIN, Daten bleiben',async()=>{
  const aktive=(await C.listActiveAgents(P)).map(a=>a.id);
  check(!aktive.includes('alt-a')&&!aktive.some(a=>a.startsWith('archiv-'))&&aktive.includes('neu-b')&&aktive.includes('alt-c'),'chat list: alt-a/Archiv weg, neu-b und alt-c da',aktive);
  const w=(await C.listWrapperStatus(P)).map(x=>x.agentName);
  check(!w.includes('wrap-alt')&&!w.includes(arch('wrap-alt')),'Spezialistenliste: wrap-alt weg',w);
  const ct=(await C.holeChannelTeilnehmer(P,'chan80')).map(x=>x.agent);
  check(!ct.includes('alt-a')&&!ct.includes(arch('alt-a'))&&ct.includes('neu-b'),'Channel-Teilnehmer: alt-a/Archiv weg',ct);
  const cu=await C.baueChannelUebersicht(P,false);
  check(cu&&!cu.channels[0].agenten.some(x=>/alt-a/.test(x))&&cu.channels[0].agenten.some(x=>/neu-b/.test(x)),'Channel-Uebersicht (Onboarding): alt-a weg',cu);
  const prof=await C.markiereEntfernteProfile(P,[{identity_id:'alt-ident-id'},{identity_id:'neu-ident-id'}],false);
  check(prof.length===1&&prof[0].identity_id==='neu-ident-id','Ausweisuebersicht: alt-ident weg',prof);
  const mit=await C.markiereEntfernteProfile(P,[{identity_id:'alt-ident-id'},{identity_id:'neu-ident-id'}],true);
  check(mit.length===2&&mit[0].entfernt?.grund==='archiviert (umbenannt): inaktiv > 30 Tage'&&mit[0].entfernt?.frueherer_name==='alt-ident','mit_entfernten: beide, Feld entfernt mit frueherem Namen',mit);
  // Daten bleiben (Inhalte unter dem alten Namen, Eintraege unter dem Archivnamen)
  check((await pool.query("SELECT count(*)::int n FROM agent_sessions WHERE id=$1",[arch('alt-a')])).rows[0].n===1&&(await pool.query("SELECT count(*)::int n FROM thoughts WHERE source='alt-a'")).rows[0].n===1
    &&(await pool.query("SELECT count(*)::int n FROM specialist_channel_messages WHERE sender='alt-a'")).rows[0].n===1
    &&(await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE id='alt-ident-id'")).rows[0].n===1&&(await pool.query("SELECT count(*)::int n FROM wrapper_status WHERE agent_name=$1",[arch('wrap-alt')])).rows[0].n===1,'Inhalte (Thought, Channel-Nachricht) unveraendert unter altem Namen; Eintraege unter Archivnamen');
 });

 await section('Agentenwissen- und Skill-Hook-Listen ohne Entfernte, Wissen bleibt',async()=>{
  await pool.query("INSERT INTO agent_wissen (project,agent_name,art,inhalt) VALUES ($1,'neu-b','regeln','x')",[P]);
  const wl=(await C.listeWissensAgenten(P)).map(x=>x.agent);
  check(!wl.includes('alt-a')&&wl.includes('neu-b'),'listeWissensAgenten: alt-a weg, neu-b da',wl);
  check((await pool.query("SELECT count(*)::int n FROM agent_wissen WHERE agent_name='alt-a'")).rows[0].n===0&&(await pool.query("SELECT inhalt FROM agent_wissen WHERE agent_name=$1",[arch('alt-a')])).rows[0]?.inhalt==='Wissen des alten alt-a','Wissen von alt-a gehoert dem Archiv-Eintrag (Inhalt unveraendert)');
  const ib=(await pool.query("SELECT to_agent,from_agent,content FROM specialist_inbox WHERE content='Inbox an alten alt-a'")).rows[0];
  check(ib?.to_agent===arch('alt-a')&&ib.from_agent==='koord-ident','Inbox an alt-a gehoert dem Archiv-Eintrag (Absender/Inhalt unveraendert)',ib);
  const sk=await C.aktiveProjektAgenten(P);
  check(!sk.some(k=>/alt-a|alt-ident-id/.test(k))&&sk.some(k=>/neu-b/.test(k)),'Skill-Hook-Empfaenger (aktiveProjektAgenten): Entfernte weg',sk);
 });

 await section('Inhalte lesbar mit Archiv-Verweis (Channel-Feed, thought get, Suche per Archivname)',async()=>{
  const feed=await channels.getChannelMessages(P,'chan80',{limit:20});
  const alt=feed.find(x=>x.sender==='alt-a');
  check(alt&&alt.content==='Beitrag vom alten alt-a'&&alt.absenderArchiv?.archiv_name===arch('alt-a')&&alt.absenderArchiv?.anzeige==='alt-a (archiviert)','Channel-Feed: Absender bleibt alt-a, Verweis auf Archiv',alt);
  const th=await thoughtIds.holeThoughtsPerEingabe(P,[THOUGHT_ALT_A]);
  check(th.thoughts[0]?.source==='alt-a'&&th.thoughts[0]?.content==='alte Arbeit'&&th.thoughts[0]?.absender_archiv?.archiv_name===arch('alt-a'),'thought get: source alt-a, Verweis auf Archiv',th.thoughts[0]);
  const su=await thoughtIds.leseThoughtsNachSourceAusPg(P,arch('alt-a'),10);
  check(su.length===1&&su[0].id===THOUGHT_ALT_A,'Suche per Archivname findet die Thoughts unter dem frueheren Namen',su.map(x=>x.id));
 });

 await section('Neuer Agent mit altem Namen = neuer Eintrag',async()=>{
  // Sperrriegel: Archivnamen sind weder registrier- noch anmeldbar
  check(/archivname_gesperrt/.test(await fehlerCode(()=>chat.registerAgent(arch('wrap-alt'),P,'opus'))??''),'register unter Archivnamen abgewiesen');
  check(/archivname_gesperrt/.test(await fehlerCode(()=>chat.beginneSitzung(arch('koordinator'),P,'neu'))??''),'Sitzungsbeginn unter Archivnamen abgewiesen');
  check((await fehlerCode(()=>C.stelleAgentTokenAus({project:P,name:arch('alt-ident')},{system:'user'})))==='archivname_gesperrt','Ausweis unter Archivnamen abgewiesen');
  check((await pool.query("SELECT status FROM agent_sessions WHERE id=$1",[arch('koordinator')])).rows[0]?.status==='active'&&(await pool.query("SELECT count(*)::int n FROM agent_entfernungen WHERE agent_id=$1 AND wiederhergestellt_am IS NULL",[arch('koordinator')])).rows[0].n===1,'Archiv bleibt unveraendert archiviert');
  check(!(await C.listActiveAgents(P)).some(a=>a.id===arch('wrap-alt')),'kein Archiv-Eintrag durch den Versuch sichtbar');
  await chat.registerAgent('alt-a',P,'opus');
  const s=(await pool.query("SELECT id,registered_at FROM agent_sessions WHERE id=ANY($1) ORDER BY id",[['alt-a',arch('alt-a')]])).rows;
  check(s.length===2&&new Date(s.find(x=>x.id==='alt-a').registered_at).getTime()>tage(1).getTime(),'neue Sitzung alt-a (frisch), Archiv-Sitzung bleibt',s);
  check((await pool.query("SELECT count(*)::int n FROM agent_entfernungen WHERE frueherer_name='alt-a' AND wiederhergestellt_am IS NULL")).rows[0].n===1,'keine automatische Rueckkehr: Markierung bleibt offen');
  const aktive=(await C.listActiveAgents(P)).map(a=>a.id);
  check(aktive.includes('alt-a')&&!aktive.includes(arch('alt-a')),'chat list: neuer alt-a sichtbar, Archiv nicht',aktive);
  await pool.query("INSERT INTO specialist_channel_messages (channel_id,sender,content) VALUES ($1,'alt-a','Beitrag vom neuen alt-a')",[KANAL]);
  const feed=await channels.getChannelMessages(P,'chan80',{limit:20});
  check(feed.find(x=>x.content==='Beitrag vom neuen alt-a')?.absenderArchiv===undefined&&feed.find(x=>x.content==='Beitrag vom alten alt-a')?.absenderArchiv,'neue Nachricht ohne Archiv-Verweis, alte mit',feed.map(x=>[x.content,x.absenderArchiv?.archiv_name]));
  await pool.query("INSERT INTO agent_identitaeten (id,project,name,agent_id,rolle,erstellt_von) VALUES ('neu-alt-ident',$1,'alt-ident','alt-ident','subagent','test')",[P]);
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND agent_id='alt-ident'",[P])).rows[0].n===1,'neue Identitaet mit altem Namen anlegbar (Name frei)');
  // DMs / Inbox / Wissen vor der Umbenennung gehoeren dem Archiv
  await pool.query("INSERT INTO chat_messages (project,sender_id,recipient_id,content,timestamp) VALUES ($1,'koord-ident','alt-a','DM an neuen alt-a',NOW())",[P]);
  C.leereEntfernungCache();
  const neu=(await chat.getMessages(P,{agentId:'alt-a',limit:50})).map(m=>m.content);
  check(!neu.includes('DM an alten alt-a')&&!neu.includes('DM vom alten alt-a')&&neu.includes('DM an neuen alt-a'),'neuer alt-a sieht alte DMs (an/von) NICHT, die neue schon',neu);
  const ar=(await chat.getMessages(P,{agentId:arch('alt-a'),limit:50})).map(m=>m.content);
  check(ar.includes('DM an alten alt-a')&&ar.includes('DM vom alten alt-a')&&!ar.includes('DM an neuen alt-a'),'Archiv-Eintrag sieht die alten DMs, nicht die neue',ar);
  const alle=(await chat.getMessages(P,{limit:50})).map(m=>m.content);
  check(alle.includes('DM an alten alt-a')&&alle.includes('DM an neuen alt-a'),'Koordinator (Projektsicht ohne agent_id) sieht alle');
  const hint=await C.getUnreadChatHint(P,'alt-a');
  check(!hint||!JSON.stringify(hint).includes('DM an alten alt-a'),'kein Ungelesen-Hinweis auf alte DMs fuer den neuen alt-a',hint);
  check((await inbox.getInboxHistory('alt-a',P)).length===0&&(await inbox.checkInbox('alt-a',P)).length===0,'neuer alt-a: Inbox leer (alte Nachricht nicht sichtbar, nicht quittiert)');
  const ai=await inbox.getInboxHistory(arch('alt-a'),P);
  check(ai.length===1&&ai[0].content==='Inbox an alten alt-a'&&ai[0].processed===false,'Archiv-Eintrag: alte Inbox-Nachricht da, unquittiert',ai);
  check(!(await C.listeWissensAgenten(P)).some(x=>x.agent==='alt-a'),'neuer alt-a erbt kein Wissen');
  // stdio-Feed wie REST
  const {getChannelFeedTool}=await load('packages/mcp-server/dist/tools/specialists.js');
  const st=JSON.parse((await getChannelFeedTool(P,'chan80',20)).content[0].text);
  const sm=st.messages?.find(x=>x.content==='Beitrag vom alten alt-a');
  check(sm?.absenderArchiv?.archiv_name===arch('alt-a')&&sm.absenderArchiv.anzeige==='alt-a (archiviert)'&&st.messages.find(x=>x.content==='Beitrag vom neuen alt-a')?.absenderArchiv===undefined,'stdio channel feed: absenderArchiv wie REST',sm);
 });

 await section('Schalter AUS: alles wieder sichtbar, Markierungen bleiben',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_entfernung',aktiv:false,grund:'Test T80 AUS'},{system:'user'});C.leereEntfernungCache();
  check((await C.listActiveAgents(P)).some(a=>a.id===arch('koordinator')),'Archiv-Eintrag unter Archivnamen sichtbar');
  check((await pool.query('SELECT count(*)::int n FROM agent_entfernungen WHERE wiederhergestellt_am IS NULL')).rows[0].n===6,'Markierungen bleiben');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_entfernung',aktiv:true,grund:'Test T80 EIN'},{system:'user'});C.leereEntfernungCache();
 });

 await section('Wiederherstellen: Rueckbenennen nur bei freiem Namen',async()=>{
  check((await admin_({project:P,aufraeumen_modus:'wiederherstellen',grund:'Test T80 ohne Auswahl'})).error==='auswahl_fehlt','ohne Auswahl -> auswahl_fehlt');
  check((await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_lauf_id:lauf})).error==='grund_fehlt','ohne grund -> grund_fehlt');
  const belegt=await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_ids:['alt-ident-id'],grund:'Test T80 einzeln belegt'});
  check(belegt.success===false&&belegt.error==='name_belegt'&&belegt.details?.abgelehnt?.[0]?.belegt_durch==='identitaet','Name alt-ident vergeben -> name_belegt mit Grund',belegt);
  check((await pool.query("SELECT agent_id FROM agent_identitaeten WHERE id='alt-ident-id'")).rows[0].agent_id===arch('alt-ident'),'nichts geaendert');
  await pool.query("DELETE FROM agent_identitaeten WHERE id='neu-alt-ident'");
  const one=await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_ids:['alt-ident'],grund:'Test T80 einzeln'});
  check(one.success===true&&one.wiederhergestellt===1,'einzeln (per frueherem Namen) wiederhergestellt',one);
  const ia=(await pool.query("SELECT agent_id,name,status FROM agent_identitaeten WHERE id='alt-ident-id'")).rows[0];
  check(ia.agent_id==='alt-ident'&&ia.name==='alt-ident'&&ia.status==='aktiv','Identitaet zurueckbenannt, Status wieder aktiv',ia);
  check((await C.markiereEntfernteProfile(P,[{identity_id:'alt-ident-id'}],false)).length===1,'alt-ident wieder sichtbar');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE aktion='entfernung_aufgehoben'")).rows[0].n===1,'Audit entfernung_aufgehoben');
  const rest=await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_lauf_id:lauf,grund:'Test T80 Lauf'});
  check(rest.success===true&&rest.wiederhergestellt===4&&rest.abgelehnt.length===1&&rest.abgelehnt[0].frueherer_name==='alt-a'&&rest.abgelehnt[0].belegt_durch==='sitzung','Rest: 4 zurueckbenannt, alt-a abgelehnt (neuer alt-a traegt den Namen)',rest);
  const s=(await pool.query("SELECT id FROM agent_sessions WHERE id=ANY($1)",[['koordinator',arch('koordinator')]])).rows.map(x=>x.id);
  check(s.length===1&&s[0]==='koordinator','koordinator zurueckbenannt',s);
  check((await pool.query("SELECT count(*)::int n FROM wrapper_status WHERE agent_name='wrap-alt'")).rows[0].n===1,'wrap-alt zurueckbenannt');
  check((await pool.query("SELECT count(*)::int n FROM agent_sessions WHERE id=$1",[arch('alt-a')])).rows[0].n===1,'Archiv alt-a bleibt bestehen');
  const p2=await fehlerCode(async()=>C.meldeAgentMitTokenAn(AUSW.token,P,await C.leseAgentBezugModus()));
  check(p2===null,'Ausweis nach Wiederherstellen wieder gueltig',p2);
  const nochmal=await admin_({project:P,aufraeumen_modus:'wiederherstellen',aufraeumen_lauf_id:lauf,grund:'Test T80 nochmal'});
  check(nochmal.success===false&&nochmal.error==='name_belegt','nur noch alt-a offen und belegt -> name_belegt',nochmal);
  const feed=await channels.getChannelMessages(P,'chan80',{limit:20});
  check(feed.find(x=>x.content==='Beitrag vom alten alt-a')?.absenderArchiv?.archiv_name===arch('alt-a'),'alter Beitrag zeigt weiter auf das Archiv');
 });

 await section('Einstellung der Schwelle',async()=>{
  const r=await admin_({aufraeumen_modus:'einstellen',aufraeumen_tage:14,grund:'Test T80'});
  check(r.success===true&&r.schwelle.tage===14&&r.schwelle.quelle==='einstellung','Schwelle 14, Quelle einstellung',r);
  check((await admin_({project:P})).tage===14,'Vorschau nutzt die Einstellung');
  check((await admin_({aufraeumen_modus:'einstellen',aufraeumen_tage:3,grund:'Test T80 zu klein'})).error==='tage_ungueltig','3 Tage -> tage_ungueltig');
  check((await admin_({aufraeumen_modus:'einstellen',aufraeumen_tage:20},KOORD)).error==='user_auftrag_fehlt','Koordinator braucht user_auftrag');
 });

 await section('Archivname belegt -> Zusatz -2',async()=>{
  await sitzung('doppel',P,60);await pool.query("INSERT INTO agent_sessions (id,project,status) VALUES ($1,$2,'inactive')",[arch('doppel'),ANDERES]);
  const v=await admin_({project:P,aufraeumen_ids:['doppel'],aufraeumen_tage:30});
  check(v.kandidaten[0]?.neuer_name===arch('doppel')+'-2','belegter Archivname bekommt -2',v.kandidaten[0]);
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
