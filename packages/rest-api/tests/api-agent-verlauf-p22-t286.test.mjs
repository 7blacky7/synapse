/**
 * P22-T286 Teil C: API-Agenten schreiben ihren Turn in den GEMEINSAMEN Verlauf (hauptagent_verlauf), Startkontext und
 * Prompt-Wiederverwendung, Buendelwachstum, Rueckfall-Ziel, parallele Identitaeten, Main-Route ohne Doppelzeile.
 * NUR synapse_test:5433 mit eigenem privaten Schema; Fake-Transport (keine echten Anbieteraufrufe), Fake-tools/list+call.
 *   pnpm --filter @synapse/core run build && pnpm --filter @synapse/rest-api run build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-agent-verlauf-p22-t286.test.mjs
 * Herkunft je Abschnitt (Testfall):
 *   T1  Antwortzeile rolle 'ausgabe', antwort_auf NULL, Text genau einmal
 *   T2  Main-Chat: keine api-Zeilen, Werkzeuge als Stromereignisse in der Antwortzeile (werkzeuge.calls)
 *   T3  nicht begonnen: 0 Eingabezeilen, Lauf 'fehler' mit Code
 *   T4  Prozessneustart: gebauter Prompt wird wiederverwendet, Startkontext nicht neu gebaut
 *   T5  gemischter Verlauf (Web-UI-Ausloeser + api-Zuege) im Uebergabetext
 *   T6  Rueckfall: Ziel = Kandidat der Kette, Wechsel-Zeile (Nicht-Main) mit meta.thought_id
 *   T7  Schalter AUS = Bestand: keine api-Zeilen, Anmeldetext auf 20 000 gekappt, Main schreibt die Route
 *   T8  Schalter EIN Nicht-Main: Stueck im Verlauf (zerlegeVerlaufVon) und Startkontext enthaelt die Zuege
 *   K1  zwei Identitaeten im selben Takt: jede nur ihre Zeilen, main_schreiber_weg bleibt 0
 *   K2  Reihenfolge Aufruf<Ergebnis, gemessene Tokens an der Antwortzeile
 *   K4  Startkontext genau einmal, Prompt nur anmeldeKurz
 *   K6  Buendelwachstum: genau EINE Eingabezeile 'eingang:1-2', keine Waise
 *   K7  nach nicht_begonnen ist kein Main-Schreiber mehr registriert
 *   R1  Main-Antwortzeile enthaelt den Text GENAU einmal (Text-Gleichheit)
 *   R2  beendeter Reply (Client weg): kein Wurf, kein error-Event, Lauf 'bereit', Verlauf vollstaendig
 *   R3  Main-Neustart ueber Schwelle: Uebergabe als api-Zeilen, Chat-Antwortzeile ohne Uebergabetext
 *   R4  Schalter EIN ohne Startkontext: Prompt wird trotzdem gespeichert
 *   Schema 2x idempotent + usage > 0 im AUS-Zweig (tokens.gemessen, camelCase)
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {request as httpRequest} from 'node:http';

const requireCore=createRequire(new URL('../../core/package.json',import.meta.url));
const requireApi=createRequire(new URL('../package.json',import.meta.url));
const {Pool}=requireCore('pg');
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433','nur synapse_test:5433');
assert.equal(url.pathname,'/synapse_test','nur Datenbank synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE',
 'SYNAPSE_HAUPTAGENT','SYNAPSE_HAUPTAGENT_API','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN',
 'ANTHROPIC_BASE_URL','SYNAPSE_VERBRAUCH','SYNAPSE_OPENROUTER_API_KEY','JEV_OPENROUTER_API_KEY','SYNAPSE_OPENROUTER_BASE_URL'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Kein Netzzugriff: alle Anbieteraufrufe laufen ueber den Fake-Transport, fetch ist gesperrt.
let netz=0;const netzZiele=[];
globalThis.fetch=async (ziel)=>{netz++;const u=String(ziel?.url??ziel);netzZiele.push(u);throw Error('Testnetz gesperrt: '+u);};

const admin=new Pool({connectionString:url.href});
const schema='p22_t286_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t286-projekt';
const MOD='or-deepseek-chat';
const THOUGHT_ID=randomUUID();
const tokens=new Map(), idVonToken=new Map();
let core,pool,worker,app=null,checks=0,Fastify,RM;
const failures=[];const perFall={};
function sseEventsGlobal(body){return [...String(body).matchAll(/event: ([^\n]+)\ndata: (.*)\n/g)].map(m=>({event:m[1],daten:(()=>{try{return JSON.parse(m[2]);}catch{return m[2];}})()}));}
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,fall,label,info){
 checks++;const z=perFall[fall]??(perFall[fall]={pass:0,fail:0});
 if(ok){z.pass++;return;}
 z.fail++;failures.push(fall+' · '+label);
 console.error('FAIL ['+fall+'] '+label+(info!==undefined?' | DEBUG tatsaechlich: '+mask(JSON.stringify(info)).slice(0,700):''));
}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+e.message);console.error('FAIL Abschnitt '+name+': '+mask(e.stack??e.message));}}

// ------------------------------------------------------------------ Fake-Anbieter und Fake-Werkzeuge
let antworten=[];let haken=null;const transportAufrufe=[];
const setAntworten=l=>{antworten=[...l];};
const wirft=code=>()=>{throw Object.assign(new Error('Fake-Fehler '+code),{code});};
const textAntwort=(text,o={})=>({anbieter:'openrouter-api',
 antwort:{inhalt:[{typ:'text',text}],stop:'ende',stop_roh:null,nutzung:o.nutzung??{input:10,output:4,cache_read:0,cache_creation:0},kosten_usd:o.kosten??0.001},
 kosten:{usd:o.kosten??0.001,usd_quelle:'antwort'},rest_usd:null,kontext_tokens:o.kontext??120});
const werkzeugAntwort=(id,name,eingabe)=>({anbieter:'openrouter-api',
 antwort:{inhalt:[{typ:'werkzeug_aufruf',id,name,eingabe}],stop:'werkzeug',stop_roh:null,nutzung:{input:10,output:4,cache_read:0,cache_creation:0},kosten_usd:0.001},
 kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:null,kontext_tokens:120});
const transportRufen=async a=>{
 transportAufrufe.push({system:a.system,modell:a.modell});
 let ziel=antworten[0];
 if(antworten.length>1)antworten.shift();
 if(haken)await haken(a);
 if(!ziel)throw Object.assign(new Error('kein Fake-Transport gesetzt'),{code:'anbieter_fehler'});
 return typeof ziel==='function'?await ziel(a):ziel;
};
const PAD='X'.repeat(21000);
let anmeldeNr=0;
const aufruf=async (werkzeug,eingabe,ausweis)=>{
 const id=idVonToken.get(ausweis)??'unbekannt';
 if(werkzeug==='chat'&&eingabe?.action==='anmelden'){
  anmeldeNr+=1;
  const kurz={success:true,principal:{identity_id:id,agent_id:agentIdVon.get(id)??id,project:P,rolle:'subagent',modell:MOD,context_epoch:1,lauf_id:'lauf-'+anmeldeNr},
   lauf_id:'lauf-'+anmeldeNr,
   agentOnboarding:{isFirstVisit:true,message:'Testanmeldung',rules:[{name:'lang',content:PAD+'ENDE-DER-LANGEN-ANMELDUNG'}]}};
  return {content:[{type:'text',text:JSON.stringify(kurz)}]};
 }
 if(werkzeug==='thought')return {content:[{type:'text',text:JSON.stringify({success:true,id:THOUGHT_ID})}]};
 return {content:[{type:'text',text:'werkzeug-ok'}]};
};
const agentIdVon=new Map();

const verwaltung=(extra={})=>new (L.LaufVerwaltung)({db:pool,takt_ms:60_000,pausiert:()=>true,liste:async()=>[],aufruf,
 ausweis:async(_p,id)=>tokens.get(id)??'sai_test',transport:transportRufen,...extra});

const dreh=async aktiv=>core.setzeProfilProduktSchalter({ebene:'global',funktion:'api_verlauf_hauptverlauf',aktiv,grund:'T286 Test '+(aktiv?'EIN':'AUS')},{system:'user'});
const apiZeilen=async id=>(await pool.query("SELECT id::text AS id,rolle,antwort_auf::text AS antwort_auf,text,tokens,meta,weg,quelle_ref FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref LIKE 'api:%' ORDER BY hauptagent_verlauf.id",[id])).rows;
const eingang=async(id,text,quelle='auftrag')=>core.legeApiEingangAn({identity_id:id,text,quelle,absender:'user'});
const neuerLauf=async(a,rolle,projekt)=>core.legeApiLaufAn({identity_id:a.identity_id,project:projekt??P,agent_id:a.agent_id,rolle,modell:MOD,anbieter:'openrouter-api',gestartet_von:'user'});
const laufStand=async id=>(await pool.query('SELECT status,letzter_fehler,sitzung::text AS sitzung,neustarts FROM api_agent_laeufe WHERE identity_id=$1',[id])).rows[0];
const laufBereit=async id=>pool.query("UPDATE api_agent_laeufe SET status='bereit',letzter_fehler=NULL WHERE identity_id=$1",[id]);

let L,MAIN;
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+seq);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await import('../../core/dist/index.js');pool=core.getPool();
 L=await import('../dist/services/api-agent-lauf.js');
 MAIN=await import('../dist/services/agent-runtime/dauerhafter-main.js');
 worker=L.starteApiAgentLauf({db:pool,takt_ms:60_000,pausiert:()=>true,liste:async()=>[],aufruf,
  ausweis:async(_p,id)=>tokens.get(id)??'sai_test',transport:transportRufen});
 // Fehlende (noch nicht deployte) Tabellen des privaten Schemas anlegen - und genau das 2x (Idempotenz).

 await section('Schema',async()=>{
  await pool.query(core.API_AGENT_LAUF_SCHEMA_SQL);
  await pool.query(core.API_AGENT_LAUF_SCHEMA_SQL);
  const t=await pool.query("SELECT to_regclass('api_agent_sitzung_prompt')::text AS t");
  check(!!t.rows[0].t,'Schema','API_AGENT_LAUF_SCHEMA_SQL 2x idempotent: api_agent_sitzung_prompt existiert',t.rows[0]);
  const sp=await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name='api_agent_sitzung_prompt' AND column_name IN ('identity_id','sitzung','system_prompt')",[schema]);
  check(sp.rows[0].n===3,'Schema','api_agent_sitzung_prompt hat identity_id/sitzung/system_prompt',sp.rows[0]);
 });

 await core.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'T286 Testbestand'},{system:'user'});
 for(const projekt of [P,core.HAUPTAGENT_PROJEKT])
  await core.setzeProfilProduktSchalter({ebene:'projekt',project:projekt,funktion:'api_agenten_lauf_intern',aktiv:true,grund:'T286 Testlauf'},{system:'user'});
 const STARTKON=core.STARTKONTEXT_FUNKTION??'startkontext';
 try{await core.setzeProfilProduktSchalter({ebene:'global',funktion:STARTKON,aktiv:true,grund:'T286 Startkontext'},{system:'user'});}
 catch(e){console.error('DEBUG Startkontext-Schalter: '+mask(e.message));}
 await pool.query("INSERT INTO model_registry(alias,full_id,provider,context_window,output_limit,corridor_min,corridor_max,pricing_input_usd_per_mtok,pricing_output_usd_per_mtok,pricing_cache_usd_per_mtok) VALUES ($1,'deepseek/deepseek-chat','openrouter-api',200000,1000,70,88,0.25,1,0.025) ON CONFLICT (alias) DO NOTHING",[MOD]);
 const USER={art:'user'};
 const identCache=new Map();
 const ident=async(name,rolle='subagent',projekt=P)=>{
  const schluessel=projekt+'|'+name+'|'+rolle;
  if(identCache.has(schluessel))return identCache.get(schluessel);
  const a=await core.W12_DIENSTE.ausweis.agentVorbereiten({project:projekt,name,rolle,grund:'T286 Testidentitaet '+name},USER);
  identCache.set(schluessel,a);
  tokens.set(a.identity_id,a.token);idVonToken.set(a.token,a.identity_id);agentIdVon.set(a.identity_id,a.agent_id);
  return a;
 };

 await section('T7 Bestand AUS',async()=>{
  const A=await ident('t286-t7');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-BESTAND-AUFTRAG');
  setAntworten([textAntwort('T286-BESTAND-ANTWORT')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const sys=transportAufrufe.at(-1).system;
  check(sys.includes('# Synapse-Anmeldung'),'T7','Anmeldung steht im Prompt');
  check(!sys.includes('ENDE-DER-LANGEN-ANMELDUNG'),'T7','Anmeldetext auf 20 000 Zeichen gekappt (Ende fehlt)',{laenge:sys.length});
  check((v.zustand().hauptverlauf??{}).anmeldung_lang===1,'T7','Debug zaehlt die gekappte lange Anmeldung',v.zustand().hauptverlauf);
  const rows=await apiZeilen(A.identity_id);
  check(rows.length===0,'T7','AUS = Bestand: keine api-Zeilen (kein eingang:/<sitzung>:)',rows.map(r=>r.quelle_ref));
 });

 await dreh(true);
 await section('T1 Antwortzeile',async()=>{
  const A=await ident('t286-t1');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-T1-AUFTRAG');
  setAntworten([textAntwort('T286-T1-ANTWORT')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const rows=await apiZeilen(A.identity_id);
  const a=rows.find(r=>r.meta.art==='text');
  check(!!a,'T1','Antwortzeile im gemeinsamen Verlauf vorhanden',rows.map(r=>r.meta));
  if(a){
   check(a.rolle==='ausgabe','T1',"Antwortzeile rolle 'ausgabe'",a.rolle);
   check(a.antwort_auf===null,'T1','Antwortzeile antwort_auf NULL (eigene Zeile je Turn)',a.antwort_auf);
   check(a.text==='T286-T1-ANTWORT','T1','Antworttext genau einmal (Text-Gleichheit)',a.text);
   check(a.meta.quelle==='api','T1','Herkunft api an der Zeile',a.meta);
  }
 });

 await section('K2 Reihenfolge und Tokens',async()=>{
  const A=await ident('t286-k2');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-K2-AUFTRAG');
  setAntworten([werkzeugAntwort('call-k2','mcp__synapse__project',{action:'status'}),textAntwort('T286-K2-ANTWORT')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const rows=await apiZeilen(A.identity_id);
  const auf=rows.find(r=>r.meta.art==='werkzeug_aufruf'),erg=rows.find(r=>r.meta.art==='werkzeug_ergebnis');
  check(!!auf&&!!erg,'K2','Werkzeug-Aufruf und -Ergebnis als Zeilen',rows.map(r=>r.meta.art));
  if(auf&&erg){
   check(Number(auf.id)<Number(erg.id),'K2','id(Aufruf) < id(Ergebnis) bei Sofort-Ergebnis',{auf:auf.id,erg:erg.id});
   check(auf.meta.werkzeug_id==='call-k2'&&erg.meta.werkzeug_id==='call-k2','K2','Aufruf/Ergebnis tragen dieselbe Werkzeug-ID',{a:auf.meta,e:erg.meta});
  }
  const a=rows.find(r=>r.meta.art==='text');
  const g=a?.tokens?.gemessen;
  check(!!g&&Number(g.input)>0&&Number(g.output)>0,'K2','setzeGemesseneTokens trifft die Antwortzeile (tokens.gemessen > 0)',g);
  check(g?.quelle==='anbieter_gemessen','K2','Quelle der Messwerte ist anbieter_gemessen',g?.quelle);
 });

 await section('T5 gemischter Verlauf',async()=>{
  const B=await ident('t286-t5');await neuerLauf(B,'subagent');
  const u=await pool.query("INSERT INTO hauptagent_verlauf (identity_id,rolle,richtung,weg,status,text) VALUES ($1,'user','ein','webui','fertig','T286-WEBUI-FRAGE') RETURNING id::text AS id",[B.identity_id]);
  await pool.query("INSERT INTO hauptagent_verlauf (identity_id,rolle,richtung,weg,antwort_auf,status,text) VALUES ($1,'agent','aus','webui',$2::bigint,'fertig','T286-WEBUI-ANTWORT')",[B.identity_id,u.rows[0].id]);
  await eingang(B.identity_id,'T286-API-FRAGE');
  setAntworten([textAntwort('T286-API-ANTWORT')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const ue=await core.baueUebergabeText(B.identity_id,{runtime:'claude',modell:'haiku'},'t286_misch');
  check(ue.text.includes('T286-WEBUI-FRAGE')&&ue.text.includes('T286-WEBUI-ANTWORT'),'T5','Uebergabe enthaelt den Web-UI-Zug',ue.text.slice(0,400));
  check(ue.text.includes('T286-API-FRAGE')&&ue.text.includes('T286-API-ANTWORT'),'T5','Uebergabe enthaelt zusaetzlich den api-Zug',ue.bloecke?.length);
 });

 await section('K4 und T4 (Startkontext, Prompt-Wiederverwendung)',async()=>{
  const A=await ident('t286-k4');await neuerLauf(A,'subagent');
  await pool.query("INSERT INTO hauptagent_verlauf (identity_id,rolle,richtung,weg,status,text,lauf_id) VALUES ($1,'user','ein','webui','fertig','T286-VORGESCHICHTE','alt-1')",[A.identity_id]);
  await eingang(A.identity_id,'T286-K4-AUFTRAG');
  setAntworten([textAntwort('T286-K4-ANTWORT')]);
  const vorNr=anmeldeNr;
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const sys1=transportAufrufe.at(-1).system;
  const p1=await pool.query('SELECT system_prompt,aktualisiert_am FROM api_agent_sitzung_prompt WHERE identity_id=$1',[A.identity_id]);
  check(p1.rows.length===1,'K4','genau ein gespeicherter Sitzungs-Prompt',p1.rows.length);
  check(p1.rows[0]?.system_prompt===sys1,'K4','gespeicherter Prompt = gebauter Prompt',{gleich:p1.rows[0]?.system_prompt===sys1});
  check(sys1.includes('T286-VORGESCHICHTE'),'K4','Startkontext genau einmal im Prompt (Vorgeschichte eingespielt)');
  check(sys1.includes('"principal"')&&!sys1.includes('agentOnboarding')&&!sys1.includes('ENDE-DER-LANGEN-ANMELDUNG'),
   'K4','Prompt uebernimmt aus der Anmeldung nur principal/lauf_id (kein Regel-/Onboardingblock)',sys1.slice(0,300));
  check(sys1.includes('"lauf_id":"lauf-'+anmeldeNr+'"'),'K4','Kurz-Anmeldung des ersten Laufs im Prompt',anmeldeNr);
  const standVor=(await pool.query('SELECT startkontext_offen FROM agent_identitaeten WHERE id=$1',[A.identity_id])).rows[0].startkontext_offen;
  // T4: Prozessneustart - neue LaufVerwaltung (leere Sitzungs-Map), gleiche Sitzung.
  await eingang(A.identity_id,'T286-T4-NACH-NEUSTART');
  setAntworten([textAntwort('T286-T4-ANTWORT')]);
  const v2=verwaltung();await v2.takt();await v2.warteAufTurns();
  const sys2=transportAufrufe.at(-1).system;
  const p2=await pool.query('SELECT system_prompt FROM api_agent_sitzung_prompt WHERE identity_id=$1',[A.identity_id]);
  check(sys2===p1.rows[0]?.system_prompt,'T4','Prozessneustart: gespeicherter Prompt wird wiederverwendet',{gleich:sys2===p1.rows[0]?.system_prompt});
  check(p2.rows[0]?.system_prompt===p1.rows[0]?.system_prompt,'T4','Prompt unveraendert (kein neues Onboarding)',p2.rows.length);
  check(!sys2.includes('"lauf_id":"lauf-'+anmeldeNr+'"'),'T4','Anmeldung des neuen Laufs kam NICHT in den Prompt',anmeldeNr);
  const standNach=(await pool.query('SELECT startkontext_offen FROM agent_identitaeten WHERE id=$1',[A.identity_id])).rows[0].startkontext_offen;
  check(JSON.stringify(standVor)===JSON.stringify(standNach),'T4','Startkontext nicht neu gebaut (startkontext_offen unveraendert)',{vor:standVor?.am,nach:standNach?.am});
  check(vorNr<anmeldeNr,'T4','Anmeldung lief beim Neustart trotzdem (neuer Lauf)',{vorNr,anmeldeNr});
  // K4 (Pkt. 5): ohne aktive Identitaet schreibt der Schalter nichts (Bestand).
  const X=await ident('t286-k4-inaktiv');await neuerLauf(X,'subagent');
  await pool.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1",[X.identity_id]);
  await eingang(X.identity_id,'T286-K4-INAKTIV-AUFTRAG');
  setAntworten([textAntwort('T286-K4-INAKTIV-ANTWORT')]);
  const vx=verwaltung();await vx.takt();await vx.warteAufTurns();
  const restX=await apiZeilen(X.identity_id);
  check(restX.length===0,'K4','ohne aktive Identitaet: keine api-Zeile im gemeinsamen Verlauf (Bestand)',restX.map(r=>r.quelle_ref));
 });

 await section('R4 Prompt ohne Startkontext',async()=>{
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:STARTKON,aktiv:false,grund:'T286 R4 ohne Startkontext'},{system:'user'});
  const A=await ident('t286-r4');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-R4-AUFTRAG');
  setAntworten([textAntwort('T286-R4-ANTWORT')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const p=await pool.query('SELECT system_prompt FROM api_agent_sitzung_prompt WHERE identity_id=$1',[A.identity_id]);
  check(p.rows.length===1&&String(p.rows[0].system_prompt).includes('# Synapse-Anmeldung'),'R4','Schalter EIN ohne Startkontext: Prompt wird trotzdem gespeichert',{zeilen:p.rows.length});
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:STARTKON,aktiv:true,grund:'T286 Startkontext wieder EIN'},{system:'user'});
 });

 await section('K6 Buendelwachstum',async()=>{
  const A=await ident('t286-k6');await neuerLauf(A,'subagent');
  const e1=await eingang(A.identity_id,'T286-K6-EINS');
  setAntworten([wirft('funktion_aus')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  check((await apiZeilen(A.identity_id)).length===0,'K6','erster Versuch nicht begonnen: keine api-Zeile');
  await laufBereit(A.identity_id);
  const e2=await eingang(A.identity_id,'T286-K6-ZWEI');
  await pool.query('UPDATE api_agent_eingang SET faellig_ab=NOW() WHERE identity_id=$1',[A.identity_id]);
  setAntworten([textAntwort('T286-K6-ANTWORT')]);
  const v2=verwaltung();await v2.takt();await v2.warteAufTurns();
  const ref='api:eingang:'+[e1.id,e2.id].sort((a,b)=>Number(a)-Number(b)).join('-');
  const rows=await apiZeilen(A.identity_id);
  const eingaben=rows.filter(r=>r.meta.art==='eingabe');
  check(eingaben.length===1,'K6','genau EINE Eingabezeile nach dem Buendeln',eingaben.map(r=>r.quelle_ref));
  check(eingaben[0]?.quelle_ref===ref,'K6',"Eingabezeile traegt 'eingang:1-2' (gebündelt)",{ist:eingaben[0]?.quelle_ref,soll:ref});
  check(!rows.some(r=>r.quelle_ref==='api:eingang:'+e1.id),'K6','keine Waise eingang:1',rows.map(r=>r.quelle_ref));
 });

 await section('T3 nicht begonnen',async()=>{
  const A=await ident('t286-t3');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-T3-AUFTRAG');
  setAntworten([wirft('funktion_aus')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const av=await pool.query('SELECT count(*)::int AS n FROM api_agent_verlauf WHERE identity_id=$1',[A.identity_id]);
  check(av.rows[0].n===0,'T3','nicht begonnen: 0 Eingabezeilen im technischen Verlauf',av.rows[0]);
  const restZeilen=await apiZeilen(A.identity_id);
  check(restZeilen.length===0,'T3','nicht begonnen: 0 Zeilen im gemeinsamen Verlauf',restZeilen.map(r=>({ref:r.quelle_ref,art:r.meta.art})));
  const st=await laufStand(A.identity_id);
  check(st.status==='fehler'&&st.letzter_fehler==='funktion_aus','T3','Lauf meldet fehler + Fachcode',st);
 });

 await section('T8 Verlaufssuche und Startkontext',async()=>{
  const A=await ident('t286-t8');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-T8-AUFTRAG');
  setAntworten([textAntwort('T286-T8-ANTWORT')]);
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const rows=await apiZeilen(A.identity_id);
  check(rows.some(r=>r.text==='T286-T8-ANTWORT'&&r.meta.art==='text'),'T8','Antwort liegt vollstaendig im gemeinsamen Verlauf (Grundlage der Verlaufssuche)',rows.map(r=>r.meta.art));
  await core.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_einbetten',aktiv:true,grund:'T286 T8'},{system:'user'});
  const z=await core.zerlegeVerlaufVon(A.identity_id).catch(e=>({fehler:mask(e.message)}));
  const st=await pool.query('SELECT text FROM verlauf_stuecke WHERE identity_id=$1',[A.identity_id]);
  const alles=st.rows.map(r=>r.text).join('\n');
  check(alles.includes('T286-T8-ANTWORT'),'T8','Verlaufsstueck (search(verlauf)-Quelle) enthaelt den api-Zug',{stuecke:st.rows.length,z});
  const sk=await core.baueStartkontext(A.identity_id);
  check(!!sk&&sk.text.includes('T286-T8-ANTWORT'),'T8','Startkontext des neuen Laufs enthaelt die Zuege',sk?sk.text.slice(0,200):null);
 });

 await section('T6 Rueckfall',async()=>{
  const A=await ident('t286-t6');await neuerLauf(A,'subagent');
  await eingang(A.identity_id,'T286-T6-AUFTRAG');
  await pool.query("INSERT INTO api_agent_rueckfall (id,modelle,effort,grund,gesetzt_von,gesetzt_am) VALUES (1,ARRAY['haiku'],NULL,'T286 Testkette','user',NOW()) ON CONFLICT (id) DO UPDATE SET modelle=EXCLUDED.modelle, grund=EXCLUDED.grund");
  let spawnArgs=null;
  setAntworten([wirft('budget_erschoepft')]);
  const v=verwaltung({rueckfall:async args=>{spawnArgs=args;return {success:true,runtime:'claude'};}});
  await v.takt();await v.warteAufTurns();
  check(!!spawnArgs&&spawnArgs.model==='haiku','T6','Rueckfall-Ziel = Kandidat der Kette (haiku), nicht das API-Modell',spawnArgs&&{modell:spawnArgs.model});
  const w=(await pool.query("SELECT text,meta FROM hauptagent_verlauf WHERE identity_id=$1 AND weg='wechsel'",[A.identity_id])).rows;
  check(w.length===1,'T6','genau eine Wechsel-Zeile fuer den Nicht-Main',w.length);
  if(w[0]){
   check(w[0].meta.anlass==='api_rueckfall','T6','Wechsel-Zeile anlass api_rueckfall',w[0].meta);
   check(w[0].meta.thought_id===THOUGHT_ID,'T6','Wechsel-Zeile traegt meta.thought_id der Uebergabe',w[0].meta.thought_id);
   check(w[0].meta.von==='openrouter-api/'+MOD,'T6','Wechsel-Zeile nennt das von-Modell',w[0].meta.von);
   check(String(w[0].meta.nach||'')!==w[0].meta.von,'T6','Wechsel-Zeile nennt ein anderes Ziel als das von-Modell',w[0].meta.nach);
  }
  check(v.zustand().ruckfall_container.anzahl===1,'T6','Rueckfall im Debug gezaehlt',v.zustand().ruckfall_container);
 });

 await section('K1 parallel',async()=>{
  const M=await ident('hauptagent','main',core.HAUPTAGENT_PROJEKT);await neuerLauf(M,'main',core.HAUPTAGENT_PROJEKT);
  const S=await ident('t286-k1-spez');await neuerLauf(S,'subagent');
  await eingang(S.identity_id,'T286-K1-SPEZ-AUFTRAG');
  await eingang(M.identity_id,'T286-K1-MAIN-AUFTRAG','main_chat');
  const ereignisse=[];
  const schreiber={ereignis:(e,d)=>ereignisse.push({e,d}),abschliessen:async()=>{}};
  const par={max:0,offen:0};
  haken=async a=>{par.offen++;par.max=Math.max(par.max,par.offen);await new Promise(r=>setTimeout(r,400));par.offen--;};
  setAntworten([a=>textAntwort(/t286-k1-spez/.test(a.system)?'T286-K1-ANTWORT-SPEZ':'T286-K1-ANTWORT-MAIN')]);
  const v=verwaltung();v.setzeMainSchreiber(M.identity_id,schreiber,false);
  const vorWeg=(v.zustand().hauptverlauf??{}).main_schreiber_weg??0;
  await v.takt();await v.warteAufTurns();haken=null;
  check(par.max>=2,'K1','zwei Identitaeten gleichzeitig im selben Takt',par.max);
  const sRows=await apiZeilen(S.identity_id),mRows=await apiZeilen(M.identity_id);
  check(mRows.length===0,'K1','Main-Chat schreibt keine api-Zeilen',mRows.map(r=>r.quelle_ref));
  check(sRows.some(r=>r.text==='T286-K1-ANTWORT-SPEZ'),'K1','Spezialist schreibt seine eigene Antwort',sRows.map(r=>r.text));
  check(!sRows.some(r=>String(r.text).includes('ANTWORT-MAIN')),'K1','Spezialist schreibt nichts vom Main');
  const deltas=ereignisse.filter(x=>x.e==='delta').map(x=>x.d.content).join('');
  check(deltas.includes('T286-K1-ANTWORT-MAIN')&&!deltas.includes('ANTWORT-SPEZ'),'K1','Main-Antwort geht nur in die Main-Antwortzeile',deltas);
  check(((v.zustand().hauptverlauf??{}).main_schreiber_weg??0)===vorWeg,'K1','main_schreiber_weg bleibt 0 (Schreiber vorhanden)',v.zustand().hauptverlauf);
 });

 await section('K7 und R3 Main',async()=>{
  const M=await ident('hauptagent','main',core.HAUPTAGENT_PROJEKT);
  await laufBereit(M.identity_id);
  const session={identityId:M.identity_id,runtime:'claude',runtimeSessionId:null,context:{}};
  const ereignisse=[];
  const schreiber={ereignis:(e,d)=>ereignisse.push({e,d}),abschliessen:async()=>{}};
  const info={verlauf_schreiber:schreiber};
  await eingang(M.identity_id,'T286-K7-MAIN-FEHLT','main_chat');
  setAntworten([wirft('funktion_aus')]);
  const fehler=await (async()=>{try{await MAIN.apiLaufMainTurn(session,'T286-K7-MAIN-FEHLT',MOD,()=>{},info);return null;}catch(e){return e.code??e.message;}})();
  check(fehler==='funktion_aus','K7','Main-Turn meldet den Fachfehler durch',fehler);
  await laufBereit(M.identity_id);
  const vorWeg=(worker.zustand().hauptverlauf??{}).main_schreiber_weg??0;
  await pool.query('UPDATE api_agent_eingang SET faellig_ab=NOW() WHERE identity_id=$1',[M.identity_id]);
  const vorEvents=ereignisse.length;
  setAntworten([textAntwort('T286-K7-ZWEITE-ANTWORT')]);
  await worker.takt();await worker.warteAufTurns();
  check(((worker.zustand().hauptverlauf??{}).main_schreiber_weg??0)===vorWeg+1,'K7','nach nicht_begonnen ist kein Main-Schreiber mehr registriert',worker.zustand().hauptverlauf);
  check(ereignisse.length===vorEvents,'K7','kein Ereignis mehr an den alten Schreiber');
  // R3/T9: Neustart ueber der Kontextschwelle - Uebergabe geht als api-Zeilen in den Verlauf, nicht in die Chat-Antwortzeile.
  await laufBereit(M.identity_id);
  await pool.query("INSERT INTO api_agent_lauf_einstellungen (name,wert,grund,gesetzt_von) VALUES ('neustart_schwelle_prozent',1,'T286 Neustart erzwingen','test') ON CONFLICT (name) DO UPDATE SET wert=1");
  await eingang(M.identity_id,'T286-R3-MAIN-AUFTRAG','main_chat');
  const r3=[];
  const schreiber3={ereignis:(e,d)=>r3.push({e,d}),abschliessen:async()=>{}};
  worker.setzeMainSchreiber(M.identity_id,schreiber3,true);
  setAntworten([textAntwort('T286-R3-ANTWORT',{kontext:200000}),textAntwort('T286-R3-UEBERGABETEXT')]);
  await worker.takt();await worker.warteAufTurns();
  const r3deltas=r3.filter(x=>x.e==='delta').map(x=>x.d.content).join('');
  check(r3deltas.includes('T286-R3-ANTWORT'),'R3','Chat-Antwortzeile bekommt die Antwort des Users',r3deltas);
  check(!r3deltas.includes('T286-R3-UEBERGABETEXT'),'R3','Chat-Antwortzeile enthaelt NICHT den Uebergabetext',r3deltas);
  const ueber=(await pool.query("SELECT text,quelle_ref,meta FROM hauptagent_verlauf WHERE identity_id=$1 AND text IN ('T286-R3-UEBERGABETEXT',$2) ORDER BY id",[M.identity_id,L.UEBERGABE_AUFTRAG])).rows;
  const ueberText=ueber.find(r=>r.text==='T286-R3-UEBERGABETEXT');
  check(!!ueberText&&String(ueberText.quelle_ref).startsWith('api:'),'R3','Uebergabetext steht als api-Zeile im Verlauf',ueber.map(r=>({ref:r.quelle_ref,text:String(r.text).slice(0,20)})));
  await pool.query("INSERT INTO api_agent_lauf_einstellungen (name,wert,grund,gesetzt_von) VALUES ('neustart_schwelle_prozent',80,'T286 Schwelle zurueck','test') ON CONFLICT (name) DO UPDATE SET wert=80");
  const st=await laufStand(M.identity_id);
  check(st.neustarts>=1,'R3','Lauf hat die Sitzung neu gestartet',st);
 });

 await section('T2 R1 Main-Route',async()=>{
  process.env.SYNAPSE_AUTH_DISABLED='1';process.env.DOCKER_SOCKET='/nicht/vorhanden/docker.sock';
  const M=await ident('hauptagent','main',core.HAUPTAGENT_PROJEKT);
  await laufBereit(M.identity_id);
  await pool.query("UPDATE agent_identitaeten SET startrezept=jsonb_set(COALESCE(startrezept,'{}'::jsonb),'{api_lauf_wahl}', $2::jsonb) WHERE id=$1",
   [M.identity_id,JSON.stringify({laufart:'api',modell:MOD,anbieter:'openrouter-api',phase:'aktiv',grund:'T286 Testwahl',wer:'user',am:new Date().toISOString()})]);
  Fastify=requireApi('fastify');RM=await import('../dist/routes/agent-runtimes.js');
  app=Fastify({logger:false});await app.register(RM.agentRuntimeRoutes);
  const sitzung=await app.inject({method:'POST',url:'/api/main-agent/sessions',payload:{}});
  check(sitzung.statusCode===200,'T2','Main-Session ohne CLI (API-Wahl aktiv)',sitzung.body.slice(0,300));
  const sid=sitzung.json().session?.id;
  const sseEvents=body=>[...String(body).matchAll(/event: ([^\n]+)\ndata: (.*)\n/g)].map(m=>({event:m[1],daten:(()=>{try{return JSON.parse(m[2]);}catch{return m[2];}})()}));
  // T7/usage: Schalter AUS = Bestand. Die Route schreibt die Antwortzeile, usage kommt als camelCase-Event.
  await dreh(false);
  setAntworten([textAntwort('T286-MAIN-AUS-ANTWORT',{nutzung:{input:42,output:7,cache_read:0,cache_creation:0},kontext:150})]);
  const aus=await app.inject({method:'POST',url:'/api/main-agent/sessions/'+sid+'/messages',payload:{message:'T286 MAIN AUS'}});
  const ausEvents=sseEvents(aus.body);
  const ausVerlauf=ausEvents.find(x=>x.event==='verlauf')?.daten;
  check(aus.statusCode===200&&ausEvents.some(x=>x.event==='done'),'T7','AUS: Route beantwortet den Main-Chat (Bestand)',aus.body.slice(-300));
  check(Array.isArray(ausVerlauf?.antwort_id)||typeof ausVerlauf?.antwort_id==='string','T7','AUS: Route fuehrt die Antwortzeile (kein Schreiber des Turns)',ausVerlauf);
  if(ausVerlauf?.antwort_id){
   const row=(await pool.query('SELECT text,tokens FROM hauptagent_verlauf WHERE id=$1',[ausVerlauf.antwort_id])).rows[0];
   check(row?.text==='T286-MAIN-AUS-ANTWORT','T7','AUS: Antwortzeile enthaelt den Text genau einmal',row?.text);
   const g=row?.tokens?.gemessen;
   check(!!g&&Number(g.input)>0,'T7','AUS: usage > 0 in tokens.gemessen der Main-Antwortzeile (camelCase)',row?.tokens);
  }
  // T2/R1: Schalter EIN. Werkzeugrunde + Antwort; keine zweite Zeile, Text genau einmal.
  await dreh(true);
  await laufBereit(M.identity_id);
  const mApiVor=(await apiZeilen(M.identity_id)).length;
  setAntworten([werkzeugAntwort('call-route','mcp__synapse__project',{action:'status'}),textAntwort('T286-MAIN-EIN-ANTWORT')]);
  const ein=await app.inject({method:'POST',url:'/api/main-agent/sessions/'+sid+'/messages',payload:{message:'T286 MAIN EIN'}});
  const einEvents=sseEvents(ein.body);
  const einVerlauf=einEvents.find(x=>x.event==='verlauf')?.daten;
  check(ein.statusCode===200,'T2','EIN: Route beantwortet den Main-Chat',ein.body.slice(-300));
  if(einVerlauf?.antwort_id){
   const row=(await pool.query('SELECT text,werkzeuge FROM hauptagent_verlauf WHERE id=$1',[einVerlauf.antwort_id])).rows[0];
   check(row?.text==='T286-MAIN-EIN-ANTWORT','R1','Main-Antwortzeile enthaelt den Text GENAU einmal (Text-Gleichheit)',row?.text);
   const calls=row?.werkzeuge?.calls??[];
   check(calls.length===1&&String(calls[0].name).includes('project'),'T2','Werkzeug nur in werkzeuge.calls der Antwortzeile',calls);
  }
  const mRows=await apiZeilen(M.identity_id);
  check(mRows.length===mApiVor&&!mRows.some(r=>String(r.text).includes('T286-MAIN-EIN-ANTWORT')),'T2','Main: der Turn schreibt keine api-Zeile (keine Doppelzeile)',{vor:mApiVor,nach:mRows.length,zeilen:mRows.map(r=>({ref:r.quelle_ref,text:String(r.text).slice(0,25)}))});
 });

 await section('R2 beendeter Reply',async()=>{
  const M=await ident('hauptagent','main',core.HAUPTAGENT_PROJEKT);
  await laufBereit(M.identity_id);
  // Beendeter Reply im Test: der Reply-Ersatz meldet nach dem verlauf-Event writableEnded und destroyed (wie nach dem Ende des SSE-Stroms).
  await app.close();app=Fastify({logger:false});
  const raws=[];let gesehen=0;
  await app.register(async f=>{f.addHook('preHandler',async (req,reply)=>{
   if(!String(req.url).includes('/messages'))return;
   let zu=false;
   const raw=reply.raw;
   Object.defineProperty(raw,'writableEnded',{get:()=>zu,configurable:true});
   Object.defineProperty(raw,'destroyed',{get:()=>zu,configurable:true});
   raws.push({ende:()=>{zu=true;}});gesehen+=1;
  });await RM.agentRuntimeRoutes(f);});
  const sid=(await app.inject({method:'POST',url:'/api/main-agent/sessions',payload:{}})).json().session?.id;
  let torEingang=null,torFrei=null;
  haken=async()=>{if(torEingang)torEingang();await new Promise(r=>{torFrei=r;});};
  const eingetreten=new Promise(r=>{torEingang=r;});
  setAntworten([textAntwort('T286-R2-ANTWORT')]);
  const laeuft=app.inject({method:'POST',url:'/api/main-agent/sessions/'+sid+'/messages',payload:{message:'T286 R2'}});
  await eingetreten;
  raws.at(-1)?.ende();torFrei();haken=null;
  const antwort=await laeuft;
  const stand=await laufStand(M.identity_id);
  const verlauf=sseEventsGlobal(antwort.body).find(x=>x.event==='verlauf')?.daten;
  check(gesehen===1&&raws.length===1,'R2','Reply-Ersatz fuer den Main-Strom aktiv (writableEnded/destroyed)',gesehen);
  check(antwort.statusCode===200&&!/event: error/.test(antwort.body),'R2','kein error-Event am beendeten Reply',antwort.body.slice(-400));
  check(stand?.status==='bereit','R2','Lauf danach bereit (kein interner_fehler)',stand);
  if(verlauf?.antwort_id){
   const row=(await pool.query('SELECT text FROM hauptagent_verlauf WHERE id=$1',[verlauf.antwort_id])).rows[0];
   check(row?.text==='T286-R2-ANTWORT','R2','Verlauf vollstaendig: Text nach dem Stream-Ende genau einmal geschrieben',{text:row?.text,letzte:(worker.zustand().letzte??[]).slice(0,1)});
  } else check(false,'R2','verlauf-Event mit Antwortzeile empfangen',antwort.body.slice(-400));
 });

 await section('Netz',async()=>{
  const anbieter=netzZiele.filter(u=>/openrouter|anthropic|deepseek|openai|generativelanguage/i.test(u));
  check(anbieter.length===0,'R1','keine echten Anbieteraufrufe (nur Fake-Transport)',{anbieter,gezaehlt:netz,ziele:netzZiele.slice(0,5)});
 });
}catch(e){
 failures.push('Abbruch: '+mask(e.stack??e.message));console.error('FAIL Abbruch: '+mask(e.stack??e.message));
}finally{
 try{if(app)await app.close();}catch(e){console.error('DEBUG app.close: '+mask(e.message));}
 try{await worker?.beende();}catch(e){console.error('DEBUG beende: '+mask(e.message));}
 try{if(pool)await pool.end();}catch(e){console.error('DEBUG pool.end: '+mask(e.message));}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('DEBUG Schema-Rueckbau: '+mask(e.message));}
 await admin.end();
 const faelle=Object.keys(perFall).sort();
 for(const f of faelle)console.log('FALL '+f+': '+perFall[f].pass+' PASS / '+perFall[f].fail+' FAIL');
 console.log('P22-T286 Teil C: '+checks+' Pruefungen, '+failures.length+' FAIL, network='+netz);
 if(failures.length){for(const f of failures)console.log('ROT '+f);process.exitCode=1;}
}
