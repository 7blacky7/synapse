/**
 * P22-T287 Paket 0 (Befund 605fbf55 Pkt 1, Entscheidung da3cf527, Auflage A1 37e9817c): Werkzeugergebnisse im API-Lauf kuerzen.
 * NUR synapse_test:5433 mit eigenem privaten Schema; Fake-Transport (keine Anbieteraufrufe), Fake-tools/call liefert ein
 * uebergrosses code_intel-Ergebnis (wie der Befund: code_intel functions mit falschem path).
 *   pnpm --filter @synapse/core run build && pnpm --filter @synapse/rest-api run build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-tool-ausgabe-p22-t287.test.mjs
 * Herkunft je Abschnitt:
 *   U  core api-tool-ausgabe.ts kuerzeApiWerkzeugInhalt: unter der Grenze unveraendert, darueber Text gekappt + Hinweis, Bild bleibt
 *   A  Schalter api_tool_ausgabe AUS (auch bei 'alle' EIN, nur ausdruecklich) = Bestand: Ergebnis ungekuerzt im api_agent_verlauf
 *   B  Schalter EIN (Projekt): Grenze = codexToolAusgabe(Modellfenster, Werte runtime_tool_ausgabe) * 3 Zeichen, Hinweis im Ergebnis,
 *      Debug zustand().tool_ausgabe
 *   C  Wert je Identitaet (S4a, schalter_identitaet EIN): tool_ausgabe_kontext_prozent 5 nur fuer C -> engere Grenze nur fuer C
 *   D  unbekanntes Modellfenster = Bestand (keine geratene Grenze)
 *   E  eigener Wert api_tool_output_tokens je Identitaet (2000) bestimmt die API-Grenze; codex_tool_output_tokens bleibt unberuehrt
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';

const requireCore=createRequire(new URL('../../core/package.json',import.meta.url));
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
globalThis.fetch=async (ziel)=>{throw Error('Testnetz gesperrt: '+String(ziel?.url??ziel));};

const admin=new Pool({connectionString:url.href});
const schema='p22_t287_p0_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t287-p0-projekt';
const MOD='or-deepseek-chat';
const FENSTER=200000;
const GROSS='F'.repeat(600000)+'ENDE-DES-RIESENERGEBNISSES';
const tokens=new Map(), idVonToken=new Map();
let core,pool,L,checks=0;
const failures=[];
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,info){checks++;if(ok){console.log('OK '+label);return;}failures.push(label);console.error('FAIL '+label+(info!==undefined?' | DEBUG tatsaechlich: '+mask(JSON.stringify(info)).slice(0,700):''));}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+e.message);console.error('FAIL Abschnitt '+name+': '+mask(e.stack??e.message));}}

// Fake-Anbieter: Runde 1 ruft code_intel, Runde 2 antwortet mit Text.
let antworten=[];
const textAntwort=text=>({anbieter:'openrouter-api',antwort:{inhalt:[{typ:'text',text}],stop:'ende',stop_roh:null,nutzung:{input:10,output:4,cache_read:0,cache_creation:0},kosten_usd:0.001},
 kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:null,kontext_tokens:120});
const werkzeugAntwort=(id,name,eingabe)=>({anbieter:'openrouter-api',antwort:{inhalt:[{typ:'werkzeug_aufruf',id,name,eingabe}],stop:'werkzeug',stop_roh:null,
 nutzung:{input:10,output:4,cache_read:0,cache_creation:0},kosten_usd:0.001},kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:null,kontext_tokens:120});
const transportRufen=async ()=>{const z=antworten.shift();if(!z)throw Object.assign(new Error('kein Fake-Transport'),{code:'anbieter_fehler'});return z;};
const aufruf=async (werkzeug,eingabe,ausweis)=>{
 const id=idVonToken.get(ausweis)??'unbekannt';
 if(werkzeug==='chat'&&eingabe?.action==='anmelden')return {content:[{type:'text',text:JSON.stringify({success:true,principal:{identity_id:id,project:P}})}]};
 if(werkzeug==='code_intel')return {content:[{type:'text',text:GROSS}]};
 return {content:[{type:'text',text:'werkzeug-ok'}]};
};
const verwaltung=()=>new (L.LaufVerwaltung)({db:pool,takt_ms:60_000,pausiert:()=>true,liste:async()=>[],aufruf,
 ausweis:async(_p,id)=>tokens.get(id)??'sai_test',transport:transportRufen});

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
 const Z=await import('../../core/dist/services/agent-profil-schalter-ziel.js');
 await pool.query(core.API_AGENT_LAUF_SCHEMA_SQL);
 // S4a-Tabellen (agent_einstellung_ziel/_verlauf, Schema 182 additiv) fehlen in synapse_test bis zum Deploy: im privaten Schema anlegen.
 const SZ=await import('../../core/dist/db/agent-profil-schalter-ziel-schema.js');
 await pool.query(SZ.AGENT_PROFIL_SCHALTER_ZIEL_SCHEMA_SQL);

 const schalter=(ebene,funktion,aktiv,project)=>core.setzeProfilProduktSchalter({ebene,...(project?{project}:{}),funktion,aktiv,grund:'T287 Paket 0 Test'},{system:'user'});
 await schalter('global','alle',true);
 await schalter('projekt','api_agenten_lauf_intern',true,P);
 await pool.query("INSERT INTO model_registry(alias,full_id,provider,context_window,output_limit,corridor_min,corridor_max,pricing_input_usd_per_mtok,pricing_output_usd_per_mtok,pricing_cache_usd_per_mtok) VALUES ($1,'deepseek/deepseek-chat','openrouter-api',$2,1000,70,88,0.25,1,0.025) ON CONFLICT (alias) DO UPDATE SET context_window=EXCLUDED.context_window",[MOD,FENSTER]);
 const USER={art:'user'};
 const ident=async name=>{
  const a=await core.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name,rolle:'subagent',grund:'T287 Paket 0 Testidentitaet '+name},USER);
  tokens.set(a.identity_id,a.token);idVonToken.set(a.token,a.identity_id);return a;
 };
 const turnMitRiesenErgebnis=async a=>{
  await core.legeApiLaufAn({identity_id:a.identity_id,project:P,agent_id:a.agent_id,rolle:'subagent',modell:MOD,anbieter:'openrouter-api',gestartet_von:'user'});
  await core.legeApiEingangAn({identity_id:a.identity_id,text:'Liste alle Funktionen',quelle:'auftrag',absender:'user'});
  antworten=[werkzeugAntwort('call_1','mcp__synapse__code_intel',{action:'functions',path:'gibt/es/nicht.ts'}),textAntwort('FERTIG')];
  const v=verwaltung();await v.takt();await v.warteAufTurns();
  const r=await pool.query("SELECT max(length(inhalt::text))::int AS n, bool_or(inhalt::text LIKE '%gezielter abfragen%') AS hinweis, bool_or(inhalt::text LIKE '%ENDE-DES-RIESENERGEBNISSES%') AS ende FROM api_agent_verlauf WHERE identity_id=$1",[a.identity_id]);
  return {v,zeile:r.rows[0],lauf:(await pool.query('SELECT status,letzter_fehler FROM api_agent_laeufe WHERE identity_id=$1',[a.identity_id])).rows[0]};
 };

 await section('U Kuerzung rein',async()=>{
  const bild={typ:'bild',media_type:'image/png',daten:'AAAA'};
  const klein=[{typ:'text',text:'abc'}];
  const u0=core.kuerzeApiWerkzeugInhalt(klein,100,null);
  check(u0.gekuerzt===false&&u0.inhalt===klein,'U kuerzeApiWerkzeugInhalt: unter der Grenze unveraendert (dasselbe Array)',u0);
  const u1=core.kuerzeApiWerkzeugInhalt([{typ:'text',text:'x'.repeat(5000)},bild,{typ:'text',text:'y'.repeat(5000)}],1000,333);
  check(u1.gekuerzt&&u1.vorher===10000&&u1.nachher<=1000&&u1.inhalt.some(b=>b.typ==='bild')
   &&u1.inhalt.at(-1).text.includes(core.API_TOOL_AUSGABE_HINWEIS)&&u1.inhalt.at(-1).text.includes('~333 Tokens'),
   'U kuerzeApiWerkzeugInhalt: Text auf Grenze inkl. Hinweis, Bild bleibt, Hinweis nennt Tokens',{vorher:u1.vorher,nachher:u1.nachher,letzter:u1.inhalt.at(-1)});
 });

 await section('A Schalter AUS = Bestand',async()=>{
  const A=await ident('t287-p0-aus');
  const g=await core.leseApiToolAusgabeGrenze(P,A.identity_id,FENSTER);
  check(g.aktiv===false&&g.zeichen===null&&g.debug.schalter.aktiv===false,'A Grenze AUS trotz global alle EIN (nur ausdruecklich)',g.debug);
  const r=await turnMitRiesenErgebnis(A);
  check(r.zeile.n>600000&&r.zeile.ende===true&&!r.zeile.hinweis,'A AUS: code_intel-Ergebnis ungekuerzt im api_agent_verlauf (Bestand)',{zeile:r.zeile,lauf:r.lauf});
  check(r.v.zustand().tool_ausgabe.gekuerzt===0,'A AUS: keine Kuerzung gezaehlt',r.v.zustand().tool_ausgabe);
 });

 await schalter('projekt','api_tool_ausgabe',true,P);
 let grenzeB=null;
 await section('B Schalter EIN: Grenze aus Modellfenster, Hinweis',async()=>{
  const B=await ident('t287-p0-ein');
  const g=await core.leseApiToolAusgabeGrenze(P,B.identity_id,FENSTER);
  const st=await core.leseRuntimeToolAusgabe(P,{identity_id:B.identity_id});
  const env={...core.toolAusgabeUmgebung(st),SYNAPSE_TOOL_AUSGABE_AKTIV:'1',SYNAPSE_CODEX_TOOL_OUTPUT_TOKENS:String(st.werte.api_tool_output_tokens)};
  check(st.werte.api_tool_output_tokens===100000&&st.quellen.api_tool_output_tokens==='standard','B api_tool_output_tokens Standard 100000',{werte:st.werte,quellen:st.quellen});
  const erwartet=core.codexToolAusgabe(env,FENSTER).tokens;
  grenzeB=g.zeichen;
  check(g.aktiv&&g.tokens===erwartet&&g.zeichen===erwartet*core.API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN&&g.debug.schalter.quelle!=='standard',
   'B Grenze = codexToolAusgabe(Modellfenster) * Zeichen je Token, Schalter aus dem Projekt',{g:g.debug,erwartet});
  const r=await turnMitRiesenErgebnis(B);
  const z=r.v.zustand().tool_ausgabe;
  check(r.zeile.hinweis===true&&r.zeile.ende===false&&r.zeile.n<g.zeichen+2000,'B EIN: Ergebnis gekuerzt, Hinweis "gekuerzt, gezielter abfragen" im Verlauf',{zeile:r.zeile,zeichen:g.zeichen});
  check(z.gekuerzt===1&&z.letzte_kuerzung?.identity_id===B.identity_id&&z.letzte_kuerzung?.werkzeug==='mcp__synapse__code_intel'&&z.letzte_kuerzung?.vorher>600000,
   'B Debug zustand().tool_ausgabe: Anzahl, laufende Identitaet, Werkzeug, Laengen',z);
  check(r.lauf.status==='bereit','B Lauf endet regulaer (bereit)',r.lauf);
 });

 await section('C Wert je Identitaet (S4a-Rang-Helfer)',async()=>{
  const C=await ident('t287-p0-ziel');const D=await ident('t287-p0-ohne');
  await schalter('projekt','schalter_identitaet',true,P);
  await Z.setzeZielWerte({bereich:'runtime_tool_ausgabe',ebene:'identitaet',project:P,ziel:C.identity_id,werte:{tool_ausgabe_kontext_prozent:5},grund:'T287 Paket 0 je Identitaet'},USER);
  const gC=await core.leseApiToolAusgabeGrenze(P,C.identity_id,FENSTER);
  const gD=await core.leseApiToolAusgabeGrenze(P,D.identity_id,FENSTER);
  check(gC.aktiv&&gC.debug.werte_quellen.tool_ausgabe_kontext_prozent==='identitaet'&&gC.zeichen<gD.zeichen&&gD.zeichen===grenzeB,
   'C nur C bekommt den engeren Anteil (Quelle identitaet), D behaelt die Projektgrenze',{c:gC.debug,d:gD.debug});
  const r=await turnMitRiesenErgebnis(C);
  check(r.zeile.hinweis===true&&r.zeile.n<gC.zeichen+2000,'C Turn von C wird auf die Grenze von C gekuerzt (Ziel = laufende API-Identitaet)',{zeile:r.zeile,zeichen:gC.zeichen});
 });

 await section('E eigener API-Wert je Identitaet',async()=>{
  const E=await ident('t287-p0-apiwert');
  await Z.setzeZielWerte({bereich:'runtime_tool_ausgabe',ebene:'identitaet',project:P,ziel:E.identity_id,werte:{api_tool_output_tokens:2000},grund:'T287 Paket 0 API-Wert je Identitaet'},USER);
  const g=await core.leseApiToolAusgabeGrenze(P,E.identity_id,FENSTER);
  const st=await core.leseRuntimeToolAusgabe(P,{identity_id:E.identity_id});
  check(g.tokens===2000&&g.zeichen===2000*core.API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN&&g.debug.werte_quellen.api_tool_output_tokens==='identitaet',
   'E api_tool_output_tokens 2000 nur fuer E bestimmt die Grenze (Quelle identitaet)',g.debug);
  check(st.werte.codex_tool_output_tokens===100000&&st.quellen.codex_tool_output_tokens!=='identitaet','E codex_tool_output_tokens bleibt unberuehrt (getrennt einstellbar)',{werte:st.werte,quellen:st.quellen});
  const r=await turnMitRiesenErgebnis(E);
  check(r.zeile.hinweis===true&&r.zeile.n<g.zeichen+2000,'E Turn von E auf 6000 Zeichen gekuerzt',{zeile:r.zeile,zeichen:g.zeichen});
 });

 await section('D unbekanntes Modellfenster = Bestand',async()=>{
  const g=await core.leseApiToolAusgabeGrenze(P,'unbekannt-'+randomUUID(),null);
  check(g.aktiv===false&&g.zeichen===null,'D ohne Modellfenster keine geratene Grenze',g.debug);
 });
}catch(e){failures.push('Aufbau: '+e.message);console.error('FAIL Aufbau: '+mask(e.stack??e.message));}
finally{
 try{await core?.closePool?.();}catch(e){console.error('DEBUG closePool: '+mask(e.message));}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('DEBUG Aufraeumen: '+mask(e.message));}
 await admin.end();
}
console.log('P22-T287 Paket 0: '+(checks-failures.length)+'/'+checks+' gruen'+(failures.length?' | FEHLER: '+failures.join(' ; '):''));
process.exit(failures.length?1:0);
