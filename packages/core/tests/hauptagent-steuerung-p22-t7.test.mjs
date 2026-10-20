/**
 * P22-T7 (W2d): Heartbeat des Hauptagenten (Einstellung, Rechte nach User de950bab: User; Koordinator und Main selbst nur mit
 * user_auftrag; alle anderen recht_fehlt; Grund + Auftrag in Revision/Audit; Wrapper-Zeile wird nachgezogen), Wechsel-Auftrag
 * (gewuenscht aus offenem Auftrag, Ausweis bleibt), Verbrauch (Schema 119 idempotent, Schalter verbrauch AUS = keine Abo-Buchung,
 * nur User setzt, referenz bucht genau einmal, Wrapper-Weg aus JSONL ohne Doppelzaehlung, Monatsauswertung + Rechte).
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon/Docker.
 *   node packages/core/tests/hauptagent-steuerung-p22-t7.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T7_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_VERBRAUCH'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t7_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t7-projekt',P2='p22-t7-anderes';
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-verbrauch-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT;
 const akt=(id,project,rolle,agent=id)=>({art:'identitaet',principal:{art:'identity',project,agent_id:agent,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 const ident=(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 await ident('t7-k',P,'t7-koord','koordinator');await ident('t7-s',P,'t7-sub','subagent');await ident('t7-f',P,'t7-falsch','subagent');
 const KO=akt('t7-k',P,'koordinator'),SU=akt('t7-s',P,'subagent'),FALSCH=akt('t7-f',P,'koordinator');
 const LEG={art:'legacy_koordinator',agent_id:'koordinator'};
 const adm=(a,args,akteur,agent)=>C.fuehreW1bAdminAus(a,{...(agent?{agent_id:agent}:{}),...args},{akteur});
 const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

 await section('Schema 119: Spiegel identisch, idempotent, in ensureSchema',async()=>{
  const sql=readFileSync(join(root,'packages/core/src/db/schema-sql/119_agent_verbrauch.sql'),'utf8');
  check(sql.trim()===C.AGENT_VERBRAUCH_SCHEMA_SQL.trim(),'119 SQL-Spiegel identisch');
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS agent_verbrauch'),'119 im ensureSchema-SQL');
  check((await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='agent_verbrauch'",[schema])).rowCount===1,'Tabelle im Testschema');
 });

 let MAIN,TOKEN;
 await section('Heartbeat vor Erstkontakt: Standard AUS, Setzen ohne Identitaet abgelehnt',async()=>{
  const h=await C.leseHauptagentHeartbeat(USER);
  check(h.identitaet===null&&h.gewuenscht.aktiv===false&&h.gewuenscht.quelle==='standard','ohne Identitaet: Standard AUS');
  check(await err(()=>C.setzeHauptagentHeartbeat(USER,{aktiv:true,grund:'Test T7 vorher'}))==='identitaet_unbekannt','Setzen ohne Identitaet -> identitaet_unbekannt');
  const s=C.hauptagentHeartbeatAusStartrezept({});
  check(s.aktiv===false&&s.intervall_ms===null&&s.quelle==='standard','Lesestelle: leeres Startrezept = AUS');
  check(C.hauptagentHeartbeatAusStartrezept({heartbeat:{aktiv:true,intervall_ms:1000}}).intervall_ms===null,'Lesestelle: Takt unter 5000 ms wird adaptiv');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T7 Ausweis-Kern'},{system:'user'});
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T7 hauptagent EIN'});
  const r=await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'});
  MAIN=r.identity_id;TOKEN=r.token;
  const st=await C.hauptagentStatus(USER);
  check(st.heartbeat?.gewuenscht.aktiv===false&&st.heartbeat.tatsaechlich.lauf===false,'Status nach Erstkontakt: Heartbeat AUS, kein Lauf');
 });

 await section('Heartbeat-Rechte (de950bab)',async()=>{
  const MA=akt(MAIN,HP,'main','hauptagent');
  const revVor=(await pool.query('SELECT profil_revision FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0].profil_revision;
  const u=await C.setzeHauptagentHeartbeat(USER,{aktiv:true,intervall_ms:60000,grund:'Test T7 User'});
  check(u.gewuenscht.aktiv===true&&u.gewuenscht.intervall_ms===60000&&u.gewuenscht.quelle==='einstellung','User setzt EIN, Takt 60 s');
  check(await err(()=>C.setzeHauptagentHeartbeat(KO,{aktiv:false,grund:'Test T7 Koord ohne'}))==='user_auftrag_fehlt','Koordinator ohne user_auftrag -> user_auftrag_fehlt');
  const k=await C.setzeHauptagentHeartbeat(KO,{aktiv:false,grund:'Test T7 Koord',user_auftrag:'User: setz den Heartbeat aus'});
  check(k.gewuenscht.aktiv===false,'Koordinator mit user_auftrag setzt AUS');
  check((await C.setzeHauptagentHeartbeat(LEG,{aktiv:true,grund:'Test T7 Legacy',user_auftrag:'User: Heartbeat an'})).gewuenscht.aktiv===true,'Legacy-Koordinator mit user_auftrag');
  check(await err(()=>C.setzeHauptagentHeartbeat(MA,{aktiv:false,grund:'Test T7 Main ohne'}))==='user_auftrag_fehlt','Main ohne user_auftrag -> user_auftrag_fehlt');
  check((await C.setzeHauptagentHeartbeat(MA,{aktiv:false,grund:'Test T7 Main',user_auftrag:'User: setz dein Heartbeat aus'})).gewuenscht.aktiv===false,'Main selbst mit user_auftrag');
  for(const [name,a] of [['Subagent',SU],['Koordinator laut Principal, in PG subagent',FALSCH],['ohne Akteur',null],['Main fremder Bereich',akt('t7-k',P,'main')]]){
   check(await err(()=>C.setzeHauptagentHeartbeat(a,{aktiv:true,grund:'Test T7 verboten',user_auftrag:'User: x'}))==='recht_fehlt','Setzen '+name+' -> recht_fehlt');
   check(await err(()=>C.leseHauptagentHeartbeat(a))==='recht_fehlt','Lesen '+name+' -> recht_fehlt');
  }
  check((await C.leseHauptagentHeartbeat(KO)).identitaet===MAIN,'Koordinator darf lesen');
  check((await C.leseHauptagentHeartbeat(MA)).identitaet===MAIN,'Main darf lesen');
  check(await err(()=>C.setzeHauptagentHeartbeat(USER,{aktiv:true,intervall_ms:1000,grund:'Test T7 Takt'}))==='intervall_ungueltig','Takt < 5000 ms -> intervall_ungueltig');
  check(await err(()=>C.setzeHauptagentHeartbeat(USER,{aktiv:'ja',grund:'Test T7 Typ'}))==='aktiv_fehlt','aktiv kein boolean -> aktiv_fehlt');
  check(await err(()=>C.setzeHauptagentHeartbeat(USER,{aktiv:true,grund:'x'}))==='grund_fehlt','Grund zu kurz -> grund_fehlt');
  const revNach=(await pool.query('SELECT profil_revision FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0].profil_revision;
  check(revNach===revVor+4,'je erfolgreicher Aenderung eine Profil-Revision (4)');
  const rev=await pool.query('SELECT wer,user_auftrag,grund FROM agent_profil_revisionen WHERE identity_id=$1 AND revision>$2 ORDER BY revision',[MAIN,revVor]);
  check(rev.rows.length===4&&rev.rows[0].wer==='user'&&rev.rows[0].user_auftrag===null&&rev.rows[1].wer==='t7-k'&&rev.rows[1].user_auftrag==='User: setz den Heartbeat aus'
   &&rev.rows[2].wer==='legacy:koordinator'&&rev.rows[3].wer===MAIN,'Revisionen: wer + user_auftrag');
  const au=await pool.query("SELECT wer,neu,grund FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='hauptagent_heartbeat' ORDER BY id",[MAIN]);
  check(au.rows.length===4&&au.rows[1].neu.user_auftrag==='User: setz den Heartbeat aus'&&au.rows[1].neu.akteur==='koordinator'&&au.rows[1].grund==='Test T7 Koord'
   &&au.rows[3].neu.akteur==='main'&&au.rows[0].neu.user_auftrag===undefined,'Audit: Grund, user_auftrag, Akteur');
  const sr=(await pool.query('SELECT startrezept FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0].startrezept;
  check(sr.heartbeat?.aktiv===false&&sr.heartbeat.gesetzt_von==='main'&&JSON.stringify(sr.erlaubte_modelle)==='["opus"]','Startrezept: heartbeat gesetzt, Rahmen unveraendert');
  // admin-Weg
  const a1=await adm('hauptagent_heartbeat',{},KO);
  check(a1.success===true&&a1.gewuenscht.aktiv===false,'admin hauptagent_heartbeat lesen (Koordinator)');
  const a2=await adm('hauptagent_heartbeat',{aktiv:true,grund:'Test T7 admin'},KO);
  check(a2.success===false&&a2.error==='user_auftrag_fehlt','admin setzen Koordinator ohne user_auftrag');
  const a3=await adm('hauptagent_heartbeat',{aktiv:true,grund:'Test T7 admin',user_auftrag:'User: an'},KO);
  check(a3.success===true&&a3.gewuenscht.aktiv===true,'admin setzen Koordinator mit user_auftrag');
  check((await adm('hauptagent_heartbeat',{},SU)).error==='recht_fehlt','admin Subagent -> recht_fehlt');
  check(!JSON.stringify(a3).includes(TOKEN),'Antwort ohne Ausweis');
 });

 await section('Heartbeat zieht laufenden Wrapper nach',async()=>{
  await pool.query('INSERT INTO agent_identitaet_wrapper_status(identity_id,agent_name,project,status,heartbeat_enabled) VALUES($1,$2,$3,$4,true)',[MAIN,'hauptagent',HP,'idle']);
  const r=await C.setzeHauptagentHeartbeat(USER,{aktiv:false,intervall_ms:null,grund:'Test T7 Wrapper'});
  check(r.wrapper_nachgezogen===true&&r.tatsaechlich.lauf===true&&r.tatsaechlich.aktiv===false,'Wrapper-Zeile auf AUS nachgezogen');
  const z=(await pool.query('SELECT heartbeat_enabled,heartbeat_interval_ms FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[MAIN])).rows[0];
  check(z.heartbeat_enabled===false&&z.heartbeat_interval_ms===null,'PG: heartbeat_enabled false, Takt adaptiv');
 });

 await section('Wechsel-Auftrag: gewuenscht aus offenem Auftrag, Ausweis bleibt',async()=>{
  const a=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test T7 Wechsel'});
  check(a.auftrag.art==='runtime_wechsel'&&a.auftrag.status==='pending'&&a.auftrag.erstellt_von==='user','Auftrag runtime_wechsel angelegt (User)');
  const st=await C.hauptagentStatus(USER);
  check(st.identitaet.runtime_gewuenscht==='codex'&&st.identitaet.runtime_tatsaechlich===null,'Status: gewuenscht codex aus offenem Auftrag, tatsaechlich unbestaetigt');
  check(typeof st.auftraege_offen[0]?.ausfuehrung==='string','offener Auftrag traegt Ausfuehrungsstand');
  check(await err(()=>C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'claude'},grund:'Test T7 zweiter'}))==='auftrag_offen_vorhanden','zweiter offener Wechsel -> auftrag_offen_vorhanden');
  const t=await C.stelleMainIdentitaetSicher(USER,{});
  check(t.identity_id===MAIN&&t.token===TOKEN,'Ausweis nach Wechselauftrag unveraendert');
  await C.brecheRuntimeAuftragAb(USER,{auftrag_id:a.auftrag.auftrag_id,grund:'Test T7 aufraeumen'});
  const R=await load('packages/rest-api/dist/routes/agent-runtimes.js').catch(()=>null);
  if(R){check(R.runtimeArt('claude')==='cli'&&R.runtimeArt('codex')==='cli'&&R.runtimeArt('free-pool')==='api','runtimeArt: CLI vs API getrennt');}
  else check(false,'rest-api dist ladbar (runtimeArt)');
 });

 await section('Schalter verbrauch: Standard AUS, nur User, AUS bucht keine Abo-Quelle',async()=>{
  const s=await C.leseVerbrauchSchalter();
  check(s.aktiv===false&&s.quelle==='standard','Standard AUS');
  const b={project:P,agent_id:'t7-sub',identity_id:'t7-s',runtime:'claude',zugang:'abo',input_tokens:10,output_tokens:5,quelle:'wrapper',referenz:'claude:aus-1'};
  const r=await C.bucheAgentVerbrauch(b);
  check(r.gebucht===false&&r.grund==='funktion_aus','AUS: wrapper-Buchung -> funktion_aus');
  check((await pool.query('SELECT count(*)::int n FROM agent_verbrauch')).rows[0].n===0,'AUS: nichts in der Tabelle');
  for(const [n,a] of [['Koordinator',KO],['Legacy',LEG],['Main',akt(MAIN,HP,'main','hauptagent')],['ohne',null]]){
   check(await err(()=>C.setzeVerbrauchSchalter(a,{aktiv:true,grund:'Test T7 verbrauch'}))==='recht_fehlt','Schalter verbrauch '+n+' -> recht_fehlt');
  }
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T7 alle'},{system:'user'}).catch(()=>undefined);
  check((await C.leseVerbrauchSchalter()).aktiv===false,"profil_schalter 'alle' schaltet verbrauch nicht");
  check(C.PROFIL_PRODUKT_FUNKTIONEN.includes('verbrauch'),'verbrauch im Produkt-Schalter-Katalog');
  const st=await adm('profil_schalter_status',{project:P},USER);
  check(st.success===true&&JSON.stringify(st).includes('"verbrauch"'),'profil_schalter_status listet verbrauch');
  const ks=await adm('profil_schalter_setzen',{project:P,profil_funktion:'verbrauch',aktiv:true,ebene:'projekt',grund:'Test T7 Koord Projekt'},KO);
  check(ks.success===true,'Koordinator setzt verbrauch fuer sein Projekt (Katalogweg) '+JSON.stringify(ks.error??''));
  check((await C.leseVerbrauchSchalter(P)).aktiv===true&&(await C.leseVerbrauchSchalter(P)).ebene==='projekt'&&(await C.leseVerbrauchSchalter(P2)).aktiv===false,'Projektzeile wirkt nur im Projekt');
  await adm('profil_schalter_setzen',{project:P,profil_funktion:'verbrauch',aktiv:false,ebene:'projekt',grund:'Test T7 Koord Projekt aus'},KO);
  const e=await C.setzeVerbrauchSchalter(USER,{aktiv:true,grund:'Test T7 verbrauch EIN'});
  check(e.aktiv===true&&e.quelle==='produkt-schalter'&&e.gesetzt_von==='user'&&e.ebene==='global','User setzt EIN (dauerhaft in PG, global)');
  check((await C.leseVerbrauchSchalter(P)).aktiv===false,'Projektzeile AUS hat Vorrang vor global EIN');
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='verbrauch' AND ebene='projekt'");
 });

 await section('Buchung: referenz genau einmal, leer/ungueltig, Transaktion',async()=>{
  const b={project:P,agent_id:'t7-sub',identity_id:'t7-s',runtime:'claude',zugang:'abo',modell:'claude-opus',input_tokens:100,output_tokens:20,cache_read_tokens:1000,cache_creation_tokens:50,quelle:'wrapper',referenz:'claude:msg_1'};
  const r1=await C.bucheAgentVerbrauch(b),r2=await C.bucheAgentVerbrauch(b);
  check(r1.gebucht===true&&r2.gebucht===false&&r2.grund==='doppelt','gleiche referenz: einmal gebucht, zweites Mal doppelt');
  check((await C.bucheAgentVerbrauch({...b,referenz:'claude:leer',input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0})).grund==='leer','0 Tokens -> leer');
  check((await C.bucheAgentVerbrauch({...b,referenz:'claude:x',zugang:'gold'})).grund==='ungueltig','unbekannter zugang -> ungueltig');
  check((await C.bucheAgentVerbrauch({...b,referenz:'claude:y',input_tokens:-5})).grund==='ungueltig','negative Tokens -> ungueltig');
  check((await C.bucheAgentVerbrauch({...b,referenz:null,agent_id:'t7-ohne-ref'})).gebucht===true,'ohne referenz bucht (main_chat-Fall)');
  const c=await pool.connect();
  try{await c.query('BEGIN');await C.bucheAgentVerbrauch({...b,referenz:'claude:tx'},c);await c.query('ROLLBACK');}finally{c.release();}
  check((await pool.query("SELECT 1 FROM agent_verbrauch WHERE referenz='claude:tx'")).rowCount===0,'Buchung mit db folgt der Transaktion (Rollback)');
  const z=(await pool.query("SELECT * FROM agent_verbrauch WHERE referenz='claude:msg_1'")).rows[0];
  check(z.usd===null&&z.zugang==='abo'&&Number(z.cache_read_tokens)===1000&&z.identity_id==='t7-s','Zeile: Abo ohne USD, Cache-Tokens, Identitaet');
 });

 await section('Wrapper-Weg: JSONL je message.id einmal, Neumeldung bucht nicht doppelt',async()=>{
  const T=await load('packages/agents/dist/token-stand.js');
  const zeile=(id,inp,out,cr)=>JSON.stringify({type:'assistant',message:{id,model:'claude-opus-5-5',usage:{input_tokens:inp,output_tokens:out,cache_read_input_tokens:cr,cache_creation_input_tokens:0}}});
  const zeilen=[zeile('msg_a',10,1,100),zeile('msg_a',10,1,100),zeile('msg_b',20,2,200),'kaputt',JSON.stringify({type:'user',message:{content:'x'}}),JSON.stringify({message:{usage:{input_tokens:5}}})];
  const v=T.verbrauchAusZeilen(zeilen);
  check(v.length===2&&v[0].id==='msg_a'&&v[1].input_tokens===20&&v[1].cache_read_tokens===200,'verbrauchAusZeilen: je message.id einmal, ohne id/kaputt uebersprungen');
  const st=T.berechneTokenStand(zeilen);
  check(st.turns===4,'berechneTokenStand unveraendert (zaehlt weiter jede usage-Zeile)');
  const {PgTransport}=await load('packages/agents/dist/transport/pg.js');
  process.env.SYNAPSE_AGENT_IDENTITY_ID='t7-s';
  const tr=new PgTransport({agentName:'t7-sub',projekt:P,log:()=>{}});
  const ein=v.map(x=>({referenz:'claude:'+x.id,modell:x.modell,input_tokens:x.input_tokens,output_tokens:x.output_tokens,cache_read_tokens:x.cache_read_tokens,cache_creation_tokens:x.cache_creation_tokens}));
  const e1=await tr.bucheVerbrauch('claude',ein),e2=await tr.bucheVerbrauch('claude',ein);
  check(e1.gebucht===2&&e2.gebucht===0&&e2.grund===null,'pg-Transport: erste Meldung 2, Neumeldung (Wrapper-Neustart) 0');
  check(tr.bilanz().faehigkeiten.verbrauch.aufrufe===2&&tr.bilanz().faehigkeiten.verbrauch.fehler===0,'Zaehler verbrauch sichtbar');
  delete process.env.SYNAPSE_AGENT_IDENTITY_ID;
  const n=(await pool.query("SELECT count(*)::int n, sum(input_tokens)::int i FROM agent_verbrauch WHERE quelle='wrapper' AND referenz IN ('claude:msg_a','claude:msg_b')")).rows[0];
  check(n.n===2&&n.i===30,'Tabelle: msg_a + msg_b genau einmal (30 Eingabe-Tokens)');
  await C.setzeVerbrauchSchalter(USER,{aktiv:false,grund:'Test T7 verbrauch AUS'});
  const e3=await tr.bucheVerbrauch('claude',[{...ein[0],referenz:'claude:msg_c'}]);
  check(e3.gebucht===0&&e3.grund==='funktion_aus','Schalter AUS: Wrapper bekommt funktion_aus');
  await C.setzeVerbrauchSchalter(USER,{aktiv:true,grund:'Test T7 verbrauch EIN 2'});
 });

 await section('api-Weg: Bridge-Route POST .../verbrauch (ohne Doppelzaehlung, Validierung)',async()=>{
  const restRequire=createRequire(join(root,'packages/rest-api/package.json'));
  const Fastify=restRequire('fastify');
  const {wrapperBridgeRoutes}=await load('packages/rest-api/dist/routes/wrapper-bridge.js');
  const app=Fastify();await app.register(wrapperBridgeRoutes);await app.ready();
  try{
   const pfad='/api/projects/'+encodeURIComponent(P)+'/specialists/t7-api/verbrauch';
   const body={runtime:'claude',eintraege:[{referenz:'claude:api_1',modell:'m',input_tokens:3,output_tokens:4,cache_read_tokens:5,cache_creation_tokens:0}]};
   const r1=await app.inject({method:'POST',url:pfad,payload:body}),r2=await app.inject({method:'POST',url:pfad,payload:body});
   const d1=r1.json(),d2=r2.json();
   check(r1.statusCode===200&&d1.gebucht===1&&d2.gebucht===0&&d2.doppelt===1,'Route: erste Meldung gebucht, Wiederholung doppelt ('+r1.statusCode+' '+JSON.stringify(d1)+')');
   const r3=await app.inject({method:'POST',url:pfad,payload:{eintraege:[]}});
   check(r3.statusCode===400,'Route: ohne runtime -> 400');
   const z=(await pool.query("SELECT agent_id,quelle,zugang FROM agent_verbrauch WHERE referenz='claude:api_1'")).rows;
   check(z.length===1&&z[0].agent_id==='t7-api'&&z[0].quelle==='wrapper'&&z[0].zugang==='abo','Route: Zeile Agent aus Pfad, quelle wrapper, abo');
  }finally{await app.close();}
 });

 await section('Auswertung je Agent/Projekt/Monat + Rechte',async()=>{
  await pool.query(`INSERT INTO agent_verbrauch(zeit,project,agent_id,runtime,zugang,input_tokens,quelle,referenz) VALUES (NOW()-INTERVAL '2 months',$1,'t7-sub','claude','abo',999999,'wrapper','claude:alt')`,[P]);
  await C.bucheAgentVerbrauch({project:P2,agent_id:'fremd',runtime:'claude',zugang:'abo',input_tokens:7,quelle:'wrapper',referenz:'claude:p2'});
  const u=await C.leseAgentVerbrauch(USER,{});
  const sub=u.je_agent.find(a=>a.agent_id==='t7-sub'&&a.project===P);
  check(sub&&sub.tokens_gesamt===(100+20+1000+50)+(10+1+100)+(20+2+200),'je Agent: Monatssumme ohne Vormonat');
  check(u.je_projekt.some(p=>p.project===P2)&&u.summe.abo.tokens_gesamt>0,'User sieht alle Projekte');
  const k=await C.leseAgentVerbrauch(KO,{project:P});
  check(k.je_agent.every(a=>a.project===P),'Koordinator: eigenes Projekt');
  check(await err(()=>C.leseAgentVerbrauch(KO,{project:P2}))==='recht_fehlt','Koordinator fremdes Projekt -> recht_fehlt');
  check(await err(()=>C.leseAgentVerbrauch(KO,{}))==='project_fehlt','Koordinator ohne project -> project_fehlt');
  check(await err(()=>C.leseAgentVerbrauch(SU,{project:P}))==='recht_fehlt','Subagent -> recht_fehlt');
  check(await err(()=>C.leseAgentVerbrauch(USER,{monat:'2026-13'}))==='monat_ungueltig','Monat ungueltig');
  const alt=(await pool.query("SELECT to_char(NOW()-INTERVAL '2 months','YYYY-MM') m")).rows[0].m;
  check((await C.leseAgentVerbrauch(USER,{monat:alt,project:P})).summe.abo.input_tokens===999999,'Vormonat getrennt abrufbar');
  const a=await adm('agent_verbrauch',{project:P},KO);
  check(a.success===true&&Array.isArray(a.je_agent),'admin agent_verbrauch (Koordinator, eigenes Projekt)');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T7: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
