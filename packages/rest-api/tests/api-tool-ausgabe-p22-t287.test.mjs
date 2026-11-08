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
 *   B/C/E laufen ohne artefakt im Werkzeugangebot (Fake-Liste leer): nach Entscheid Koordinator trotzdem Ueberlauf (nur api_tool_ausgabe
 *      zaehlt), KEIN Kuerzen; erste Seite unter der jeweiligen Grenze mit Weiterlese-Aufruf, Debug weiterlesen_angeboten false.
 *   F  User-Entscheidung addbecda (Ueberlauf mit Weiterlese-ID): artefakt(tool_antwort_weiterlesen) im Werkzeugangebot -> 600 000 Zeichen
 *      werden ueber den vorhandenen Ueberlauf (core artefakt-ueberlauf.ts) abgelegt; das Fake-Modell folgt jedem naechster_aufruf durch die
 *      echte Schleife und den echten artefakt-Dispatcher (rest-api artefakt-tool.ts fuehreArtefaktAus + begrenzeArtefaktWerkzeugAntwort):
 *      jede Seite unter der Grenze, Inhalt vollstaendig, nicht in list/search/Galerie, Verlaufszeile Tool-Antwort-Fortsetzung, fremd gesperrt.
 *   G  Notbremse (Entscheid Koordinator): Ablage scheitert (Pruefregel im privaten Schema) -> gekuerzt, aber sichtbar: Hinweis
 *      „Ablage fehlgeschlagen, gekuerzt (Grund …)“ im Ergebnis, Debug letzte_kuerzung grund ablage_fehler, Ereignis werkzeug_gekuerzt
 *      (Verlaufszeile meta.werkzeug_gekuerzt).
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
let core,pool,L,AT,checks=0;
const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
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
 // F: echter artefakt-Dispatcher samt Transportgrenze (wie fuehreToolsCallAus: Ergebnis -> begrenzeArtefaktWerkzeugAntwort -> MCP-Huelle).
 if(werkzeug==='artefakt'){
  const principal={art:'identity',identity_id:id,agent_id:'api-'+id.slice(0,8),project:P,rolle:'subagent',modell:null,context_epoch:1,lauf_id:null};
  const wert=await core.mitAgentAufrufKontext({principal,bezug},()=>AT.fuehreArtefaktAus({...eingabe},'api-'+id.slice(0,8)));
  const begrenzt=await core.mitAgentAufrufKontext({principal,bezug},()=>AT.begrenzeArtefaktWerkzeugAntwort(wert,eingabe??{},'artefakt',eingabe?.action));
  return core.baueToolErgebnis(begrenzt,{tool:'artefakt',strukturiert:true});
 }
 return {content:[{type:'text',text:'werkzeug-ok'}]};
};
const verwaltung=(o={})=>new (L.LaufVerwaltung)({db:pool,takt_ms:60_000,pausiert:()=>true,liste:o.liste??(async()=>[]),aufruf,
 ausweis:async(_p,id)=>tokens.get(id)??'sai_test',transport:o.transport??transportRufen});

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
 AT=await import('../dist/services/agent-runtime/artefakt-tool.js');
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
  const r=await pool.query("SELECT max(length(inhalt::text))::int AS n, bool_or(inhalt::text LIKE '%gezielter abfragen%') AS hinweis, bool_or(inhalt::text LIKE '%tool_antwort_weiterlesen%') AS weiter, bool_or(inhalt::text LIKE '%Ablage fehlgeschlagen, gekürzt (Grund:%') AS ablage, bool_or(inhalt::text LIKE '%ENDE-DES-RIESENERGEBNISSES%') AS ende FROM api_agent_verlauf WHERE identity_id=$1",[a.identity_id]);
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
  check(r.zeile.weiter===true&&!r.zeile.hinweis&&r.zeile.ende===false&&r.zeile.n<g.zeichen+2000,'B EIN: erste Seite mit Weiterlese-Aufruf statt Kuerzung, auch ohne artefakt im Werkzeugangebot (Entscheid)',{zeile:r.zeile,zeichen:g.zeichen});
  check(z.gekuerzt===0&&z.ueberlauf===1&&z.letzter_ueberlauf?.identity_id===B.identity_id&&z.letzter_ueberlauf?.werkzeug==='mcp__synapse__code_intel'&&z.letzter_ueberlauf?.laenge>600000
   &&z.letzter_ueberlauf?.weiterlesen_angeboten===false,
   'B Debug zustand().tool_ausgabe: Ueberlauf gezaehlt, laufende Identitaet, Werkzeug, Laenge, weiterlesen_angeboten false',z);
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
  check(r.zeile.weiter===true&&!r.zeile.hinweis&&r.zeile.n<gC.zeichen+2000,'C erste Seite von C unter der Grenze von C (Ziel = laufende API-Identitaet)',{zeile:r.zeile,zeichen:gC.zeichen});
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
  check(r.zeile.weiter===true&&!r.zeile.hinweis&&r.zeile.n<g.zeichen+2000,'E erste Seite von E unter 6000 Zeichen mit Weiterlese-Aufruf',{zeile:r.zeile,zeichen:g.zeichen});
 });

 await section('F Ueberlauf mit Weiterlese-ID (User addbecda): erste Seite + ID, alle Folgeseiten, Inhalt vollstaendig',async()=>{
  const F=await ident('t287-p0-ueberlauf');
  const g=await core.leseApiToolAusgabeGrenze(P,F.identity_id,FENSTER);
  // Werkzeugangebot MIT artefakt(tool_antwort_weiterlesen) - sonst gilt der Rueckfall Kuerzen (Abschnitte B/C/E).
  const liste=async()=>[{name:'artefakt',description:core.ARTEFAKT_DEFINITION.description,inputSchema:core.ARTEFAKT_DEFINITION.inputSchema}];
  const seiten=[];
  // Fake-Modell folgt jedem naechster_aufruf der letzten Werkzeugantwort, bis keiner mehr kommt.
  const folge=async (a)=>{
   let letztes=null;
   for(const n of a?.verlauf??[])for(const b of (Array.isArray(n?.inhalt)?n.inhalt:[]))if(b?.typ==='werkzeug_ergebnis')letztes=b;
   if(!letztes)return werkzeugAntwort('call_f0','mcp__synapse__code_intel',{action:'functions',path:'gibt/es/nicht.ts'});
   const text=letztes.inhalt.filter(x=>x.typ==='text').map(x=>x.text).join('');
   let j=null;try{j=JSON.parse(text);}catch{j=null;}
   seiten.push({laenge:text.length,j});
   const n=j?.naechster_aufruf;
   if(n&&seiten.length<40){const {tool:_t,...args}=n;return werkzeugAntwort('call_f'+seiten.length,'mcp__synapse__'+String(n.tool??'artefakt'),args);}
   return textAntwort('FERTIG');
  };
  await core.legeApiLaufAn({identity_id:F.identity_id,project:P,agent_id:F.agent_id,rolle:'subagent',modell:MOD,anbieter:'openrouter-api',gestartet_von:'user'});
  await core.legeApiEingangAn({identity_id:F.identity_id,text:'Liste alle Funktionen',quelle:'auftrag',absender:'user'});
  const v=verwaltung({liste,transport:folge});await v.takt();await v.warteAufTurns();
  const lauf=(await pool.query('SELECT status,letzter_fehler FROM api_agent_laeufe WHERE identity_id=$1',[F.identity_id])).rows[0];
  const erste=seiten[0]?.j;
  check(!!erste&&erste.ueberlauf===true&&erste.art==='tool_antwort_fortsetzung'&&typeof erste.artefakt_id==='string'
   &&erste.naechster_aufruf?.action==='tool_antwort_weiterlesen'&&erste.naechster_aufruf?.artefakt_id===erste.artefakt_id&&Number.isSafeInteger(erste.naechster_aufruf?.seiten_bytes)
   &&String(erste.hinweis).includes('tool_antwort_weiterlesen'),
   'F erste Seite: Kennzeichnung tool_antwort_fortsetzung, ID und genauer Weiterlese-Aufruf (eigener Aufruf, nicht artefakt read)',{erste:erste&&{...erste,content:String(erste.content).slice(0,80)},seiten:seiten.length});
  check(seiten.length>=3&&seiten.every(s=>s.laenge<=g.zeichen),'F jede Seite (erste + Folgeseiten) unter der Grenze '+g.zeichen+' Zeichen',{seiten:seiten.map(s=>s.laenge),grenze:g.zeichen});
  const gelesen=seiten.map(s=>s.j?.content??'').join('');
  let voll=null;try{voll=JSON.parse(gelesen);}catch{voll=null;}
  check(voll?.text===GROSS&&seiten.slice(1).every(s=>s.j?.artefakt_id===erste?.artefakt_id&&s.j?.success===true)&&seiten.at(-1)?.j?.returned_range?.eof===true&&!seiten.at(-1)?.j?.naechster_aufruf&&/Ende erreicht/.test(String(seiten.at(-1)?.j?.hinweis)),
   'F alle Folgeseiten lesbar, Inhalt vollstaendig (600 000 Zeichen + ENDE, nichts verloren)',{seiten:seiten.length,zeichen:gelesen.length,ende:gelesen.slice(-60),fehler:seiten.map(s=>s.j?.error).filter(Boolean),
    parse:voll===null?'kein JSON':'ok',text_laenge:voll?.text?.length,soll_laenge:GROSS.length,ids:seiten.map(s=>String(s.j?.artefakt_id).slice(0,8)),
    erfolg:seiten.map(s=>s.j?.success),letzter_aufruf:seiten.at(-1)?.j?.naechster_aufruf,grenzen:seiten.map(s=>[s.j?.returned_range,String(s.j?.content).slice(0,12)])});
  const z=v.zustand().tool_ausgabe;
  check(lauf?.status==='bereit'&&z.ueberlauf>=1&&z.letzter_ueberlauf?.identity_id===F.identity_id&&z.letzte_grenze?.weiterlesen===true&&z.gekuerzt===0,
   'F Lauf bereit, Debug zustand().tool_ausgabe: ueberlauf, letzter_ueberlauf, weiterlesen angeboten, nichts gekuerzt',{lauf,z});
  const verlaufMax=(await pool.query('SELECT max(length(inhalt::text))::int AS n FROM api_agent_verlauf WHERE identity_id=$1',[F.identity_id])).rows[0].n;
  check(verlaufMax<g.zeichen+5000,'F api_agent_verlauf haelt nur Seiten (kein Riesenergebnis)',{verlaufMax,grenze:g.zeichen});
  const id=erste?.artefakt_id;
  const zeile=(await pool.query('SELECT ueberlauf,created_by_identity_id,ablauf_am,title FROM agent_artifacts WHERE id=$1',[id])).rows[0];
  check(zeile?.ueberlauf===true&&zeile.created_by_identity_id===F.identity_id&&zeile.ablauf_am!==null&&/^Tool-Antwort-Fortsetzung /.test(zeile.title),
   'F Ablage im vorhandenen Ueberlauf (agent_artifacts ueberlauf=true, TTL, Urheber = laufende Identitaet)',zeile);
  const vz=(await pool.query('SELECT text,meta FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref=$2',[F.identity_id,'tool-antwort-fortsetzung:'+id])).rows[0];
  check(!!vz&&/^Tool-Antwort-Fortsetzung: code_intel/.test(vz.text)&&vz.meta?.tool_antwort_fortsetzung?.id===id&&!('artefakt_id' in (vz.meta??{})),
   'F Verlauf: Zeile Tool-Antwort-Fortsetzung ohne Artefakt-Bezug',vz);
  const galerie=await core.listeArtefakte(500);
  check(!galerie.some(a=>a.id===id),'F nicht in Galerie/Persoenlichen Artefakten (listeArtefakte)',{anzahl:galerie.length});
  await schalter('projekt','artefakt_dateien',true,P);
  const principal={art:'identity',identity_id:F.identity_id,agent_id:F.agent_id,project:P,rolle:'subagent',modell:null,context_epoch:1,lauf_id:null};
  const alsF=fn=>core.mitAgentAufrufKontext({principal,bezug},fn);
  const kat=await alsF(()=>AT.fuehreArtefaktAus({action:'list',project:P,limit:200},'t287'));
  const such=await alsF(()=>AT.fuehreArtefaktAus({action:'search',project:P,query:'Tool-Antwort'},'t287'));
  const name=await alsF(()=>AT.fuehreArtefaktAus({action:'read',project:P,artefakt_id:'tool-antwort-'+id},'t287'));
  check(kat.success&&!JSON.stringify(kat).includes(id)&&such.success&&!JSON.stringify(such).includes(id)&&name.success===false,
   'F nicht in Artefakt-Liste/Suche/Namensaufloesung',{kat:kat.count,such:such.count,name:name.error});
  await schalter('projekt','artefakt_dateien',false,P);
  const fremd={...principal,identity_id:randomUUID(),project:P+'-fremd'};
  const fr=await core.mitAgentAufrufKontext({principal:fremd,bezug},()=>AT.fuehreArtefaktAus({action:'tool_antwort_weiterlesen',artefakt_id:id},'t287'));
  check(fr.success===false&&fr.error==='artefakt_unbekannt','F fremdes Projekt kann die Fortsetzung nicht lesen',fr);
  const kein=await alsF(()=>AT.fuehreArtefaktAus({action:'tool_antwort_weiterlesen',artefakt_id:randomUUID()},'t287'));
  check(kein.success===false&&kein.error==='artefakt_unbekannt','F unbekannte ID klar abgelehnt',kein);
 });

 await section('G Notbremse: Ablage scheitert -> sichtbar gekuerzt (Hinweis, Debug, Ereignis werkzeug_gekuerzt)',async()=>{
  const G=await ident('t287-p0-notbremse');
  const g=await core.leseApiToolAusgabeGrenze(P,G.identity_id,FENSTER);
  // Ablage technisch sperren: Ueberlauf-Zeilen verletzen im PRIVATEN Schema eine Pruefregel (INSERT scheitert), danach wieder frei.
  await pool.query('ALTER TABLE agent_artifacts ADD CONSTRAINT t287_ablage_sperre CHECK (NOT ueberlauf) NOT VALID');
  let r;try{r=await turnMitRiesenErgebnis(G);}finally{await pool.query('ALTER TABLE agent_artifacts DROP CONSTRAINT IF EXISTS t287_ablage_sperre');}
  const z=r.v.zustand().tool_ausgabe;
  check(r.zeile.ablage===true&&r.zeile.hinweis===true&&!r.zeile.weiter&&r.zeile.ende===false&&r.zeile.n<g.zeichen+2000,
   'G Ergebnis gekuerzt MIT Hinweis „Ablage fehlgeschlagen, gekuerzt (Grund …)“, kein Riesenergebnis',{zeile:r.zeile,zeichen:g.zeichen});
  check(z.gekuerzt===1&&z.ueberlauf===0&&z.letzte_kuerzung?.grund==='ablage_fehler'&&z.letzte_kuerzung?.ereignis===core.API_TOOL_AUSGABE_EREIGNIS
   &&/t287_ablage_sperre/.test(String(z.letzte_kuerzung?.ursache))&&z.letzte_kuerzung?.identity_id===G.identity_id&&!!z.letzte_kuerzung?.verlauf_id,
   'G Debug zustand().tool_ausgabe.letzte_kuerzung: grund ablage_fehler, Ursache, Ereignis, Verlaufszeile',z);
  const ev=(await pool.query("SELECT text,status,meta FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref LIKE 'werkzeug-gekuerzt:%'",[G.identity_id])).rows;
  check(ev.length===1&&ev[0].status==='fehler'&&ev[0].meta?.werkzeug_gekuerzt?.ereignis==='werkzeug_gekuerzt'&&ev[0].meta?.werkzeug_gekuerzt?.grund==='ablage_fehler'
   &&/Ablage fehlgeschlagen/.test(ev[0].text),'G Ereignis werkzeug_gekuerzt (grund ablage_fehler) als Verlaufszeile der laufenden Identitaet',ev);
  const abl=(await pool.query('SELECT count(*)::int AS n FROM agent_artifacts WHERE ueberlauf AND created_by_identity_id=$1',[G.identity_id])).rows[0].n;
  check(abl===0&&r.lauf.status==='bereit','G keine halbe Ablage, Lauf endet regulaer',{abl,lauf:r.lauf});
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
