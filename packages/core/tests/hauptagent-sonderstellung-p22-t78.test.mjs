/**
 * P22-T78 + P22-T79 + Rest P22-T72 (Entwurf thought 67e6d433). Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz.
 *   node packages/core/tests/hauptagent-sonderstellung-p22-t78.test.mjs
 * T78: Startkontext aus dem Verlauf (enthaelt 'ich heisse X' nach einem Wechsel), Nachweis am Wechsel-Eintrag und im Stand, Schalter
 *      main_startkontext (Standard EIN, AUS = kein Anhang), Prompt-Route: Main bekommt Prompt + Startkontext (laenge passt), andere
 *      Agenten byte-gleich.
 * T79: Main liest in Projekten mit und ohne Koordinator (immer Visum), Schreiben -> main_nur_lesen, unbekanntes Projekt ->
 *      projekt_unbekannt, main_hinweis im internen Bereich (lesend ja, schreibend nein), Schalter main_lesezugriff AUS = Bestand,
 *      Nicht-Main unveraendert (fremdes_projekt), keine Arbeitsfreigabe fuer den Main.
 * T72: fehlende Qdrant-Collection wird als leeres Ergebnis erkannt (istSammlungFehlt).
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG',
 'SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_HINWEIS_BUDGET_MS:'5000',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t78_'+process.pid+'_'+randomUUID().slice(0,8);
const A='p22-t78-mit-koord',F='p22-t78-frei',H='p22-t78-heimat',SRV='srv-t78';
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}else console.log('ok   '+label);}
async function section(name,fn){try{await fn();}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.t78_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-verbrauch-schema','agent-entfernung-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 for(const f of ['117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql','124_hauptagent_verlauf.sql','128_agent_startkontext.sql','128_agent_startkontext.sql'])await pool.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 await pool.query("ALTER TABLE hauptagent_verlauf ALTER COLUMN rev SET DEFAULT nextval('hauptagent_verlauf_rev')");
 const C=core,USER={art:'user'};
 const T=await load('packages/core/dist/services/agent-token-tools.js');
 const AP=await load('packages/core/dist/services/agent-ausweis-projekte.js');
 const S=await load('packages/core/dist/services/hauptagent-sonderstellung.js');
 const TH=await load('packages/core/dist/services/thoughts.js');
 const aufruf=async(tool,args,arbeit)=>{let k;const r=await T.mitAgentToolAufruf(tool,args,SRV,async x=>{k=x;return arbeit?arbeit(x):{success:true};});return {k,r};};
 // Zeile mit allen Pflichtspalten ohne Standardwert (Testschema = Kopie von public).
 const zeile=async(tabelle,wert)=>{
  const sp=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND (is_nullable='NO' AND column_default IS NULL OR column_name = ANY($3::text[]))",[schema,tabelle,Object.keys(wert)])).rows;
  const w=sp.map(s=>wert[s.column_name]??(s.data_type==='boolean'?false:s.data_type.includes('int')?0:s.data_type.includes('json')?'{}':s.data_type.includes('time')?new Date():s.data_type==='ARRAY'?[]:'x'));
  await pool.query(`INSERT INTO ${tabelle}(${sp.map(s=>'"'+s.column_name+'"').join(',')}) VALUES(${sp.map((_,i)=>'$'+(i+1)).join(',')})`,w);
 };

 await section('Schalter: Standard EIN, Katalog',async()=>{
  const sql128=readFileSync(join(repo,'packages/core/src/db/schema-sql/128_agent_startkontext.sql'),'utf8');
  check(sql128.trim()===C.AGENT_STARTKONTEXT_SCHEMA_SQL.trim(),'128 SQL-Spiegel identisch (2x idempotent angewendet)');
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('startkontext_offen'),'128 im ensureSchema-SQL');
  for(const f of ['main_lesezugriff','startkontext']){
   const s=await S.leseMainSchalter(f);
   check(s.aktiv===true&&s.quelle==='standard',f+': Standard EIN',s);
   check(C.PROFIL_PRODUKT_FUNKTIONEN.includes(f)&&C.STANDARD_EIN.includes(f)&&C.NUR_AUSDRUECKLICH.includes(f),f+': Katalog, STANDARD_EIN, nur ausdruecklich');
   check((await C.leseProfilProduktSchalter(f,null)).aktiv===true,f+': profil_schalter_status zeigt EIN');
  }
 });

 let MAIN,TOK;
 await section('Main-Identitaet und Projekte',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T78 Ausweis-Kern'},{system:'user'});
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T78 hauptagent EIN'});
  MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
  TOK=(await pool.query('SELECT token_offen FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL LIMIT 1',[MAIN])).rows[0]?.token_offen;
  check(typeof MAIN==='string'&&typeof TOK==='string'&&TOK.startsWith('sai_'),'Main-Identitaet mit Ausweis');
  check(await S.mainIdentitaetDesAusweises(TOK)===MAIN,'Ausweis gehoert dem Main');
  for(const p of [A,F,H])await zeile('projects',{name:p,path:'/tmp/'+p,enabled:true});
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('t78-ka',$1,'t78-ka','t78-ka','koordinator','test')",[A]);
  const pr=await S.sichtbareUserProjekte();
  check(pr.includes(A)&&pr.includes(F)&&!pr.includes(C.HAUPTAGENT_PROJEKT),'sichtbare User-Projekte ohne internen Bereich',pr);
 });

 await section('T79: Main liest jedes User-Projekt (immer Visum)',async()=>{
  const {k}=await aufruf('thought',{action:'search',project:A,query:'x',token:TOK});
  check(!k.antwort&&k.args.project===A&&k.bestaetigt?.zugang==='visum'&&k.bestaetigt?.ziel_project===A,'A mit Koordinator: lesen, Visum',{a:k.antwort,b:k.bestaetigt});
  const {k:kf}=await aufruf('plan',{action:'get',project:F,token:TOK});
  check(!kf.antwort&&kf.args.project===F&&kf.bestaetigt?.zugang==='visum','F ohne Koordinator: trotzdem Visum (nicht frei)',kf.bestaetigt);
  const {k:kc}=await aufruf('channel',{action:'post',project:A,channel_name:'c',content:'Hinweis vom Main',token:TOK});
  check(!kc.antwort,'Channel posten in A erlaubt (Kommunikation)');
  const {k:kd}=await aufruf('chat',{action:'send',project:A,recipient_id:'t78-ka',content:'Frage vom Main',token:TOK});
  check(!kd.antwort,'Direktnachricht an den Koordinator von A erlaubt (Main schreibt jeden Agenten an)',kd.antwort);
  for(const [tool,args,p] of [['thought',{action:'add',content:'x'},A],['files',{action:'update',file_path:'a.ts',content:'x'},F],['plan',{action:'update_task',task_id:'P1-T1'},A]]){
   const {k:kw}=await aufruf(tool,{...args,project:p,token:TOK});
   check(kw.antwort?.error==='main_nur_lesen'&&/Koordinator/.test(kw.antwort.message),tool+'.'+args.action+' in '+p+' -> main_nur_lesen',kw.antwort);
  }
  const e=(await pool.query('SELECT zugang_zuletzt FROM agent_ausweis_projekte WHERE identity_id=$1 AND project=$2',[MAIN,F])).rows[0];
  check(e?.zugang_zuletzt==='visum','Eintrag F: zugang visum');
  const {k:ku}=await aufruf('thought',{action:'search',project:'gibt-es-nicht',query:'x',token:TOK});
  check(ku.antwort?.error==='projekt_unbekannt'&&ku.antwort.projekte.includes(A),'unbekanntes Projekt -> projekt_unbekannt mit Liste',ku.antwort);
  let fehler=null;try{await AP.erteileArbeitsfreigabe(A,MAIN,'Test T79 Freigabe',{wer:'user',actor_identity_id:null});}catch(x){fehler=x.code;}
  check(fehler==='main_nur_lesen','keine Arbeitsfreigabe fuer den Main',fehler);
 });

 await section('T79: Lenkhinweis im internen Bereich',async()=>{
  const {k,r}=await aufruf('thought',{action:'search',query:'x',token:TOK});
  check(!k.antwort&&k.args.project===C.HAUPTAGENT_PROJEKT,'ohne project: interner Bereich');
  check(typeof r.main_hinweis==='string'&&r.main_hinweis.includes(A)&&r.main_hinweis.includes('project:'),'lesend im internen Bereich -> main_hinweis mit Projekten',r);
  const {r:r2}=await aufruf('thought',{action:'add',content:'eigener Handoff',token:TOK});
  check(!('main_hinweis' in r2),'schreibend (eigener Thought) -> kein Hinweis');
  const {r:r3}=await aufruf('thought',{action:'search',project:A,query:'x',token:TOK});
  check(!('main_hinweis' in r3)&&!('ausweis_projekte_hinweis' in r3),'im User-Projekt kein Hinweis');
 });

 await section('T79: Schalter AUS = Bestand, Nicht-Main unveraendert',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'main_lesezugriff',aktiv:false,grund:'Test T79 AUS'},{system:'user'});
  check((await S.leseMainSchalter('main_lesezugriff')).quelle==='produkt-schalter','AUS aus dem Produkt-Schalter');
  const {k}=await aufruf('thought',{action:'search',project:A,query:'x',token:TOK});
  check(k.antwort?.error==='agent_token_fremdes_projekt','AUS: Main bekommt wieder agent_token_fremdes_projekt',k.antwort);
  const {r}=await aufruf('thought',{action:'search',query:'x',token:TOK});
  check(!('main_hinweis' in r),'AUS: kein Lenkhinweis');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'main_lesezugriff',aktiv:true,grund:'Test T79 EIN'},{system:'user'});
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('t78-sub',$1,'t78-sub','t78-sub','subagent','test')",[H]);
  const t=('sai_'+randomBytes(32).toString('hex'));
  await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),'t78-sub',t,t.slice(0,12),'register']);
  const {k:ks}=await aufruf('thought',{action:'search',project:A,query:'x',token:t});
  check(ks.antwort?.error==='agent_token_fremdes_projekt','Nicht-Main ohne mehrprojekt: unveraendert fremdes_projekt',ks.antwort);
  const {r:rs}=await aufruf('thought',{action:'search',query:'x',token:t});
  check(!('main_hinweis' in rs),'Nicht-Main: kein main_hinweis');
 });

 let WECHSEL;
 await section('T78: Startkontext aus dem Verlauf',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_uebergabe',aktiv:true,grund:'Test T78 Uebergabe EIN'},{system:'user'});
  const zug=async(text,antwort)=>{
   const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text,runtime:'claude',modell:'claude-haiku-5-5'});
   const w=C.starteVerlaufAntwort(t.antwort_id,{drossel_ms:10,modell:'claude-haiku-5-5'});
   w.ereignis('delta',{content:antwort});await w.abschliessen('fertig',{});
  };
  await zug('ich heisse Moritz','Hallo Moritz, freut mich.');
  await zug('was ist 2+2','4');
  const u=await C.erzeugeVerlaufUebergabe(MAIN,{runtime:'codex',modell:'codex/gpt-6-luna'},'runtime_wechsel');
  check(!!u?.thought_id,'Uebergabe-Thought beim Wechsel (unveraendert)',u);
  WECHSEL=u?.thought_id;
  const th=(await pool.query('SELECT content FROM thoughts WHERE id=$1',[WECHSEL])).rows[0]?.content??'';
  check(th.startsWith('VERLAUF-UEBERGABE')&&th.includes('ich heisse Moritz'),'Uebergabe-Text wie bisher, enthaelt den Namen');
  const sk=await C.mainStartkontext(MAIN);
  check(!!sk&&sk.zuege>=2&&sk.tokens>0,'Startkontext mit Zuegen',sk&&{zuege:sk.zuege,tokens:sk.tokens});
  check(sk?.text.includes('GEDAECHTNIS')&&sk.text.includes('ich heisse Moritz')&&sk.text.includes('Hallo Moritz')&&sk.text.includes(A),'Startkontext: Gedaechtnis-Kopf, Name, Antwort, Projektliste');
  const w=(await pool.query("SELECT meta FROM hauptagent_verlauf WHERE identity_id=$1 AND weg='wechsel' ORDER BY id DESC LIMIT 1",[MAIN])).rows[0]?.meta;
  check(w?.uebergabe_eingespielt===true&&w.eingespielt_zuege>=2&&w.thought_id===WECHSEL,'Nachweis am Wechsel-Eintrag (uebergabe_eingespielt)',w);
  check(sk?.text.includes('bis zum Ende')&&sk.text.includes('## Eigene Hinweise'),'Startkontext: eigene Hinweise mit Autonomie-Baustein');
  const offen=(await pool.query('SELECT startkontext_offen o FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0]?.o;
  check(offen?.zuege>=2&&offen.uebergabe_thought_id===WECHSEL,'Nachweis offen an der Identitaet bis zum neuen Lauf',offen);
  check((await C.verlaufStatus()).letzter_startkontext?.uebergabe_thought_id===WECHSEL,'Debug: verlaufStatus.letzter_startkontext');
  // Nur bei NEUEM Lauf (7762d427): ein normaler Zug bucht nichts, die Anmeldung (= neuer Lauf) genau einmal.
  await aufruf('thought',{action:'search',query:'x',token:TOK});
  check(!!(await pool.query('SELECT startkontext_offen o FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0]?.o,'normaler Aufruf bucht nichts');
  const {k:an}=await aufruf('chat',{action:'anmelden',token:TOK});
  const lauf1=an.principal?.lauf_id;
  const l1=(await pool.query('SELECT startkontext_am,startkontext_meta FROM agent_identitaet_laeufe WHERE id=$1',[lauf1])).rows[0];
  check(!!lauf1&&!!l1?.startkontext_am&&l1.startkontext_meta?.zuege>=2,'Anmeldung: Startkontext auf den neuen Lauf gebucht',l1);
  check(!(await pool.query('SELECT startkontext_offen o FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0]?.o,'danach nichts mehr offen');
  const {k:an2}=await aufruf('chat',{action:'anmelden',token:TOK});
  const l2=(await pool.query('SELECT startkontext_am FROM agent_identitaet_laeufe WHERE id=$1',[an2.principal?.lauf_id])).rows[0];
  check(an2.principal?.lauf_id&&an2.principal.lauf_id!==lauf1&&l2&&l2.startkontext_am===null,'naechster Lauf ohne neuen Prozess: kein Startkontext gebucht (einmal je Lauf)',l2);
 });

 await section('T78: Prompt-Route spielt den Startkontext ein',async()=>{
  const fastify=createRequire(join(repo,'packages/rest-api/package.json'))('fastify');
  const {agentWissenRoutes}=await load('packages/rest-api/dist/routes/agent-wissen.js');
  const app=fastify({logger:false});await app.register(agentWissenRoutes);await app.ready();
  try{
   const prompt='SYSTEMPROMPT '.repeat(40);
   for(const [p,a] of [[C.HAUPTAGENT_PROJEKT,'hauptagent'],[A,'anderer']]){
    const basis=`/api/projects/${encodeURIComponent(p)}/specialists/${a}/wissen`;
    await app.inject({method:'POST',url:basis+'/anlegen',payload:{model:'opus',expertise:'Test'}});
    const put=await app.inject({method:'PUT',url:basis+'/system-prompt',payload:{inhalt:prompt}});
    check(put.statusCode===200,'PUT system-prompt '+a,put.body);
   }
   const m=JSON.parse((await app.inject({method:'GET',url:`/api/projects/${C.HAUPTAGENT_PROJEKT}/specialists/hauptagent/wissen/system-prompt`})).body);
   check(m.success&&m.inhalt.startsWith(prompt)&&m.inhalt.includes('GEDAECHTNIS')&&m.inhalt.includes('ich heisse Moritz'),'Main: Prompt + Startkontext',m.inhalt?.slice(0,200));
   check(m.laenge===m.inhalt.length&&m.startkontext?.zuege>=2,'Main: laenge passt (ApiWissen prueft), startkontext gemeldet',{laenge:m.laenge,sk:m.startkontext});
   const o=JSON.parse((await app.inject({method:'GET',url:`/api/projects/${A}/specialists/anderer/wissen/system-prompt`})).body);
   check(o.success&&o.inhalt===prompt&&!o.startkontext,'anderer Agent: Prompt byte-gleich');
   await C.setzeProfilProduktSchalter({ebene:'global',funktion:'startkontext',aktiv:false,grund:'Test T78 AUS'},{system:'user'});
   check(await C.mainStartkontext(MAIN)===null,'Schalter AUS: kein Startkontext');
   const m2=JSON.parse((await app.inject({method:'GET',url:`/api/projects/${C.HAUPTAGENT_PROJEKT}/specialists/hauptagent/wissen/system-prompt`})).body);
   check(m2.inhalt===prompt&&!m2.startkontext,'Schalter AUS: Main-Prompt wie gespeichert (Bestand)');
   await C.setzeProfilProduktSchalter({ebene:'global',funktion:'startkontext',aktiv:true,grund:'Test T78 EIN'},{system:'user'});
  }finally{await app.close();}
 });

 await section('T72/T82: Codex arbeitet selbststaendig',async()=>{
  const X=await load('packages/agents/dist/codex-runtime.js');
  const a=X.baueCodexArgs({threadId:null,cwd:'/p',modell:null,deaktiviert:[],mcpOverrides:[]});
  const i=a.indexOf('approval_policy="never"');
  check(i>0&&a[i-1]==='-c'&&a[a.indexOf('--sandbox')+1]==='read-only','Standard: approval_policy never, Sandbox read-only',a);
  const r=X.baueCodexArgs({threadId:'th1',cwd:'/p',modell:null,deaktiviert:[],mcpOverrides:[],approval:'on-request',sandbox:'workspace-write'});
  check(r.includes('approval_policy="on-request"')&&r[r.indexOf('--sandbox')+1]==='workspace-write'&&r.slice(-3).join(' ')==='resume th1 -','je Rolle einstellbar, resume auf demselben Thread',r);
  check(X.baueCodexArgs({threadId:null,cwd:'/p',modell:null,deaktiviert:[],mcpOverrides:[],approval:'bogus',sandbox:'x'}).includes('approval_policy="never"'),'ungueltige Werte -> Standard');
  check(JSON.stringify(X.codexAutonomie({}))===JSON.stringify({approval:'never',sandbox:'read-only',anstossMax:2}),'codexAutonomie Standard');
  check(X.codexAutonomie({SYNAPSE_CODEX_ANSTOSS_MAX:'0',SYNAPSE_CODEX_SANDBOX:'workspace-write'}).anstossMax===0,'Anstoss abschaltbar');
  for(const t of ['Ich warte auf deine Freigabe.','Soll ich fortfahren?','Ich warte auf den User.','Shall I proceed with the changes?','I am waiting for your confirmation.'])check(X.wartetAufUser(t),'wartet: '+t);
  for(const t of ['Fertig: drei Dateien geaendert, Build gruen.','Erledigt. Sag Bescheid, wenn du noch etwas brauchst.','Done. Let me know if you need anything else.',''])check(!X.wartetAufUser(t),'wartet nicht: '+(t||'(leer)'));
  check(/kein|niemand/i.test(X.ANSTOSS_TEXT)&&!/schritt\s*1|zuerst.*dann/i.test(X.ANSTOSS_TEXT),'Anstoss ohne Schrittfolge');
  check(C.autonomieHinweis('subagent').includes('KEIN User anwesend')&&C.autonomieHinweis('main').includes('bis zum Ende'),'Prompt-Baustein je Rolle');
 });

 await section('T72: fehlende Collection = leeres Ergebnis',async()=>{
  check(TH.istSammlungFehlt({status:404,message:'Not Found'})===true,'HTTP 404 -> Collection fehlt');
  check(TH.istSammlungFehlt(new Error('Not Found'))===true,"'Not Found' -> Collection fehlt");
  check(TH.istSammlungFehlt(new Error('fetch failed'))===false&&TH.istSammlungFehlt(null)===false,'andere Fehler bleiben Fehler');
 });

 console.log('P22-T78/T79: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
