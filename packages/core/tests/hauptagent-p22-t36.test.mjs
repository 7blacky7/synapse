/**
 * P22-T36 (W2-P1): Hauptagent – Schalter hauptagent (AUS = Altverhalten), Erstkontakt genau eine Identitaet + dauerhafter
 * Ausweis, zweiter Kontakt dieselbe Identitaet, Rechte-Matrix (User/Main/Koordinator/Legacy-Koordinator/Subagent),
 * Runtime-Auftraege (gewuenscht vs. tatsaechlich, Rahmen, Hands-Off, stop nur User), reservierter Bereich unsichtbar,
 * REST-Transport (Identitaets-Scope, Systemprompt ohne Ausweis).
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon/Docker.
 *   node packages/core/tests/hauptagent-p22-t36.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T36_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t36_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t36-projekt';
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','hauptagent-verlauf-schema','main-warteschlange-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT;
 const akt=(id,project,rolle,agent=id)=>({art:'identitaet',principal:{art:'identity',project,agent_id:agent,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 const ident=(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 await ident('t36-k',P,'t36-koord','koordinator');await ident('t36-s',P,'t36-sub','subagent');
 const KO=akt('t36-k',P,'koordinator'),SU=akt('t36-s',P,'subagent');
 const adm=(a,args,akteur,agent)=>C.fuehreW1bAdminAus(a,{...(agent?{agent_id:agent}:{}),...args},{akteur});
 const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

 await section('AUS = Altverhalten',async()=>{
  const s=await C.leseHauptagentSchalter();
  check(s.aktiv===false&&s.quelle==='standard','Schalter Standard AUS');
  check(await err(()=>C.stelleMainIdentitaetSicher(USER,{modell:'opus'}))==='funktion_aus','Erstkontakt bei AUS -> funktion_aus');
  check((await pool.query('SELECT 1 FROM agent_identitaeten WHERE project=$1',[HP])).rowCount===0,'AUS: keine Identitaet angelegt');
  const st=await adm('hauptagent_status',{},USER);
  check(st.success===true&&st.identitaet===null&&st.schalter.aktiv===false,'Status (User) bei AUS ohne Identitaet');
  check((await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 aus'},USER)).error==='funktion_aus','Auftrag (User) bei AUS -> funktion_aus');
  check(C.istVirtuellesProjekt(HP)&&C.istUnsichtbaresProjekt(HP)&&!C.istUnsichtbaresProjekt('reverse-bibliothek'),'Bereich virtuell+unsichtbar, reverse-bibliothek sichtbar');
 });

 await section('Schalter nur User',async()=>{
  check(await err(()=>C.setzeHauptagentSchalter(KO,{aktiv:true,grund:'Test T36 Koord'}))==='recht_fehlt','Koordinator mit Ausweis -> recht_fehlt');
  check(await err(()=>C.setzeHauptagentSchalter({art:'legacy_koordinator',agent_id:'koordinator'},{aktiv:true,grund:'Test T36 Legacy'}))==='recht_fehlt','Legacy-Koordinator -> recht_fehlt');
  check(await err(()=>C.setzeHauptagentSchalter(null,{aktiv:true,grund:'Test T36 ohne'}))==='recht_fehlt','ohne Akteur -> recht_fehlt');
  // profil_schalter 'alle' global (User) schaltet hauptagent NICHT
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T36 alle'},{system:'user'});
  check((await C.leseHauptagentSchalter()).aktiv===false,'profil_schalter alle EIN wirkt nicht auf hauptagent');
  const s=await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T36 User EIN'});
  check(s.aktiv===true&&s.quelle==='produkt-schalter'&&s.gesetzt_von==='user','User setzt EIN (produkt-schalter)');
  check(typeof s.main_synapse_mapping==='string'&&s.main_synapse_mapping.includes('main_synapse'),'Mapping main_synapse dokumentiert');
 });

 let MAIN,TOKEN;
 await section('Erstkontakt: genau eine Identitaet + Ausweis, Wiederkehr = dieselbe',async()=>{
  const [a,b]=await Promise.all([C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'}),C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})]);
  check(a.identity_id===b.identity_id,'paralleler Erstkontakt -> dieselbe Identitaet');
  check([a.outcome,b.outcome].includes('created'),'einmal created');
  check(/^sai_[a-z0-9]+$/.test(a.token)&&a.token===b.token,'dauerhafter Ausweis (gleicher Wert)');
  MAIN=a.identity_id;TOKEN=a.token;
  const z=(await pool.query('SELECT agent_id,rolle,startrezept,profil FROM agent_identitaeten WHERE project=$1',[HP])).rows;
  check(z.length===1&&z[0].agent_id==='hauptagent'&&z[0].rolle==='main','genau eine Identitaet hauptagent/main');
  check(JSON.stringify(z[0].startrezept.erlaubte_modelle)==='["opus"]'&&JSON.stringify(z[0].startrezept.erlaubte_runtimes)==='["claude"]','Rahmen im Startrezept');
  const c=await C.stelleMainIdentitaetSicher(USER,{modell:'sonnet'});
  check(c.outcome==='existing'&&c.identity_id===MAIN&&c.token===TOKEN,'zweiter Kontakt/neue Session: dieselbe Identitaet und derselbe Ausweis');
  check(await err(()=>C.stelleMainIdentitaetSicher(KO))==='recht_fehlt','Erstkontakt nur User');
  await C.registerVirtualProject(P);
  const sichtbar=(await C.listeProjekte()).map(e=>e.name);
  check(!sichtbar.includes(HP)&&sichtbar.includes(P),'Projektliste: Bereich unsichtbar, normales Projekt sichtbar');
  check((await C.listeProjekte({mitUnsichtbaren:true})).some(e=>e.name===HP),'intern mit mitUnsichtbaren sichtbar');
 });

 await section('Rechte-Matrix Main-Verwaltung',async()=>{
  const MA=akt(MAIN,HP,'main','hauptagent');
  const FREMD_MAIN=akt('t36-k',P,'main');
  const AKTEURE=[
   {name:'User',akteur:USER,agent:null,darf:true},
   {name:'Main selbst',akteur:MA,agent:null,darf:true},
   {name:'Koordinator mit Ausweis',akteur:KO,agent:null,darf:false},
   {name:'Legacy-Koordinator',akteur:null,agent:'koordinator',darf:false},
   {name:'Subagent',akteur:SU,agent:null,darf:false},
   {name:'Rolle main in fremdem Projekt',akteur:FREMD_MAIN,agent:null,darf:false},
  ];
  for(const x of AKTEURE){
   for(const [a,args] of [['hauptagent_status',{}],['hauptagent_auftraege',{}]]){
    const r=await adm(a,args,x.akteur,x.agent);
    check((r.success===true)===x.darf&&(x.darf||r.error==='recht_fehlt'),a+' / '+x.name+' -> '+JSON.stringify({s:r.success,e:r.error}));
   }
   const r=await adm('hauptagent_auftrag',{auftrag_art:'update',grund:'Test T36 Matrix',hands_off:{arbeitsstand:'x'},idempotenz_schluessel:'m-'+x.name},x.akteur,x.agent);
   check((r.success===true)===x.darf&&(x.darf||r.error==='recht_fehlt'),'hauptagent_auftrag / '+x.name+' -> '+JSON.stringify({s:r.success,e:r.error}));
   if(r.success)await adm('hauptagent_auftrag_abbrechen',{auftrag_id:r.auftrag.auftrag_id,grund:'Test T36 aufraeumen'},USER);
  }
  // Main sieht seinen Status: gewuenscht vs. tatsaechlich
  const st=await adm('hauptagent_status',{},MA);
  check(st.identitaet?.modell_gewuenscht==='opus'&&st.identitaet.modell_tatsaechlich===null,'Status: gewuenscht opus, tatsaechlich null (kein falscher Status)');
  check(st.identitaet.rahmen.erlaubte_modelle[0]==='opus','Status zeigt Rahmen');
  check(!JSON.stringify(st).includes(TOKEN),'Status enthaelt nie den Ausweis');
 });

 await section('Auftraege: Rahmen, Hands-Off, stop nur User, Abbrechen, Idempotenz',async()=>{
  const MA=akt(MAIN,HP,'main','hauptagent');
  check((await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 ohne HO'},MA)).error==='hands_off_fehlt','Main ohne hands_off -> hands_off_fehlt');
  const n1=await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 neustart',hands_off:{arbeitsstand:'Stand A',thought_id:'abc'}},MA);
  check(n1.success===true&&n1.auftrag.status==='pending'&&n1.auftrag.ausfuehrung==='wartet_auf_runtime_daemon'&&n1.auftrag.tatsaechlich===null,'Main legt Neustart an: pending (wartet auf Runtime-Daemon, P22-T6), tatsaechlich null');
  const n2=await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 doppelt',hands_off:{arbeitsstand:'B'}},MA);
  check(n2.error==='auftrag_offen_vorhanden'&&n2.details?.auftrag_id===n1.auftrag.auftrag_id,'zweiter offener Neustart -> auftrag_offen_vorhanden');
  check((await adm('hauptagent_auftrag',{auftrag_art:'modellwechsel',gewuenscht:{modell:'sonnet'},grund:'Test T36 Rahmen',hands_off:{arbeitsstand:'x'}},MA)).error==='ausserhalb_rahmen','Modell ausserhalb Rahmen -> ausserhalb_rahmen');
  check((await adm('hauptagent_auftrag',{auftrag_art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test T36 Rahmen',hands_off:{arbeitsstand:'x'}},MA)).error==='ausserhalb_rahmen','Runtime ausserhalb Rahmen -> ausserhalb_rahmen');
  const mw=await adm('hauptagent_auftrag',{auftrag_art:'modellwechsel',gewuenscht:{modell:'opus',effort:'high'},grund:'Test T36 Modell',hands_off:{arbeitsstand:'x'}},MA);
  check(mw.success===true&&mw.auftrag.gewuenscht.modell==='opus','Modellwechsel im Rahmen ok (ohne User-Freigabe)');
  const st2=await adm('hauptagent_status',{},MA);
  check(st2.identitaet.modell_tatsaechlich===null&&st2.auftraege_offen.some(a=>a.art==='modellwechsel'&&a.gewuenscht.modell==='opus'),'tatsaechliches Modell unveraendert bis ACK, Wunsch im offenen Auftrag');
  check((await adm('hauptagent_auftrag',{auftrag_art:'modellwechsel',grund:'Test T36 ohne Ziel',hands_off:{a:1}},MA)).error==='gewuenscht_modell_fehlt','Modellwechsel ohne Ziel');
  check((await adm('hauptagent_auftrag',{auftrag_art:'stop',grund:'Test T36 stop main',hands_off:{a:1}},MA)).error==='recht_fehlt','stop durch Main -> recht_fehlt');
  const us=await adm('hauptagent_auftrag',{auftrag_art:'stop',grund:'Test T36 stop user'},USER);
  check(us.success===true,'stop durch User ok');
  check((await adm('hauptagent_auftrag_abbrechen',{auftrag_id:us.auftrag.auftrag_id,grund:'Test T36 fremd'},MA)).error==='recht_fehlt','Main bricht User-Auftrag nicht ab');
  const ab=await adm('hauptagent_auftrag_abbrechen',{auftrag_id:n1.auftrag.auftrag_id,grund:'Test T36 eigen'},MA);
  check(ab.success===true&&ab.auftrag.status==='cancelled','Main bricht eigenen Auftrag ab');
  check((await adm('hauptagent_auftrag_abbrechen',{auftrag_id:n1.auftrag.auftrag_id,grund:'Test T36 nochmal'},MA)).error==='auftrag_nicht_abbrechbar','doppelt abbrechen -> nicht_abbrechbar');
  const i1=await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 idem',hands_off:{a:1},idempotenz_schluessel:'k1'},MA);
  const i2=await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 idem',hands_off:{a:1},idempotenz_schluessel:'k1'},MA);
  check(i1.success&&i2.idempotent===true&&i1.auftrag.auftrag_id===i2.auftrag.auftrag_id,'Idempotenz-Schluessel');
  check((await adm('hauptagent_auftrag',{auftrag_art:'update',grund:'Test T36 Ausweis',hands_off:{notiz:'mein '+TOKEN}},USER)).error==='inhalt_enthaelt_ausweis','Ausweis im hands_off abgelehnt');
  check((await adm('hauptagent_auftrag',{auftrag_art:'neustart',grund:'Test T36 ziel',ziel_identity_id:'t36-s'},USER)).error==='ziel_nicht_unterstuetzt','P1: nur Main-Identitaet als Ziel');
  const au=(await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion LIKE 'runtime_auftrag_%'",[MAIN])).rows[0].n;
  check(au>=4,'Audit je Auftrag/Abbruch ('+au+')');
  check(!JSON.stringify((await pool.query('SELECT * FROM agent_runtime_auftraege')).rows).includes(TOKEN),'Auftragstabelle ohne Ausweiswert');
 });

 await section('REST-Transport: Identitaets-Scope, Systemprompt ohne Ausweis, AUS-Weg unveraendert',async()=>{
  const M=await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  const D=await load('packages/rest-api/dist/services/agent-runtime/claude-driver.js');
  const scope=M.hauptagentIdentitaetScope(MAIN);
  const h={'x-synapse-werkzeugprofil':'main-synapse','x-synapse-agent-token':TOKEN};
  check(M.mainScopePasst(scope,'POST','/mcp/messages',h)===true,'Identitaets-Bearer: MCP-Weg mit Profil+Ausweis erlaubt');
  check(M.mainScopePasst(scope,'GET','/api/projects',h)===false,'Identitaets-Bearer: andere Routen gesperrt');
  check(M.mainScopePasst(scope,'POST','/',{'x-synapse-werkzeugprofil':'main-synapse'})===false,'Identitaets-Bearer ohne Ausweis gesperrt');
  const row={kind:'service',scope,expires_at:null};
  const deps=(aktiv,ok)=>({stand:async()=>({profile:'artefakt-only'}),token:async()=>row,session:async()=>false,hauptagent:async()=>({aktiv}),identitaet:async()=>ok});
  const hdr={...h,authorization:'Bearer x'};
  const a1=await M.mainToolAccess(hdr,deps(true,true));
  check(a1.profile==='main-synapse'&&a1.agentId==='hauptagent'&&a1.identityId===MAIN&&!a1.error,'mainToolAccess Identitaetsweg EIN');
  check((await M.mainToolAccess(hdr,deps(false,true))).error==='hauptagent_aus','Schalter AUS -> hauptagent_aus');
  check((await M.mainToolAccess(hdr,deps(true,false))).error==='main_identitaet_nicht_autorisiert','fremder Ausweis -> nicht autorisiert');
  const alt={stand:async()=>({profile:'artefakt-only'}),token:async()=>row,session:async()=>false};
  check((await M.mainToolAccess(hdr,alt)).error==='main_session_fehlt','ohne neue Deps (Bestand) bleibt Session-Weg');
  // echte PG-Pruefung des Ausweises
  const echt=await M.mainToolAccess(hdr,{...alt,hauptagent:async()=>({aktiv:true}),identitaet:undefined});
  check(echt.error==='main_session_fehlt','Deps unvollstaendig -> Session-Weg');
  const altBefehl=D.buildClaudeCommand(null,'sonnet','{}','main-synapse');
  check(JSON.stringify(altBefehl)===JSON.stringify(D.buildClaudeCommand(null,'sonnet','{}','main-synapse',null)),'Befehl ohne Systemprompt byte-gleich');
  const neu=D.buildClaudeCommand(null,'sonnet','{}','main-synapse',D.HAUPTAGENT_SYSTEMPROMPT);
  check(neu.includes('--append-system-prompt')&&!/sai_[a-z0-9]/.test(D.HAUPTAGENT_SYSTEMPROMPT),'Systemprompt angehaengt, ohne Ausweis');
  const cfg=D.buildHauptagentIdentitaetMcpConfig('http://x/','bearer',randomUUID());
  check(cfg.includes('${SYNAPSE_AGENT_TOKEN}')&&!cfg.includes('sai_'),'MCP-Config: Ausweis nur als Env-Referenz');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T36: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
