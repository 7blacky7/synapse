/**
 * P22-T310: Ueberlauf mit Weiterlese-ID fuer ALLE Agenten - Seitengroesse je Agent aus dem Modellfenster.
 * Vorlage P22-T287 Paket 0 (thought 028a2534): dieselbe Kernregel (toolAusgabeTokens), derselbe Ueberlauf
 * (begrenzeArtefaktAntwort, PG agent_artifacts ueberlauf=true) und dieselbe Weiterlese-Aktion
 * artefakt(action:"tool_antwort_weiterlesen") - hier ueber den ECHTEN REST/MCP-Dispatch (apiLaufWerkzeugAufruf ->
 * fuehreToolsCallAus -> begrenzeAntwortFuerAgent).
 * NUR synapse_test:5433, eigenes privates Schema; keine Anbieteraufrufe, kein Netz.
 *   pnpm --filter @synapse/core run build && pnpm --filter @synapse/rest-api run build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/tool-ausgabe-seiten-p22-t310.test.mjs
 * Herkunft je Abschnitt:
 *   A core api-tool-ausgabe.ts kontextFensterFuerIdentitaet: Fenster aus der Modell-Registry, Quellen Wrapper > Startrezept > API-Lauf,
 *     unbekanntes Modell = kein geratener Wert
 *   B Schalter tool_ausgabe_seiten AUS (auch bei 'alle' EIN, nur ausdruecklich) = Bestand: Grenze aus, Antwort unveraendert
 *   C Grenze = toolAusgabeTokens(min(Wunsch, Fenster*Prozent/100)) * Zeichen je Token, Debug mit Modellfenster-Quelle
 *   D Claude-, Codex- und DeepSeek-Identitaet: uebergrosse memory-Antwort -> erste Seite + Weiterlese-ID, alle Folgeseiten
 *     unter der Grenze, zusammengesetzt vollstaendig gleich der ungekuerzten Antwort
 *   E Weiterlese-Aktion auf einem normalen Artefakt abgelehnt (keine_tool_antwort)
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
 'SYNAPSE_HAUPTAGENT','SYNAPSE_HAUPTAGENT_API','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL',
 'SYNAPSE_OPENROUTER_API_KEY','JEV_OPENROUTER_API_KEY','SYNAPSE_OPENROUTER_BASE_URL'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Kein Netz: alle Antworten kommen aus PG/the Eigenschaftsablage.
let netz=0;const netzZiele=[];
globalThis.fetch=async (ziel)=>{netz++;const u=String(ziel?.url??ziel);netzZiele.push(u);throw Error('Testnetz gesperrt: '+u);};

const admin=new Pool({connectionString:url.href});
const schema='p22_t310_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t310-projekt';
const GROSS='x'.repeat(600000);
const failures=[];const perFall={};let checks=0,core,pool,MCP;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,fall,label,info){
 checks++;const z=perFall[fall]??(perFall[fall]={pass:0,fail:0});
 if(ok){z.pass++;return;}
 z.fail++;failures.push(fall+' · '+label);
 console.error('FAIL ['+fall+'] '+label+(info!==undefined?' | DEBUG tatsaechlich: '+mask(JSON.stringify(info)).slice(0,700):''));
}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+e.message);console.error('FAIL Abschnitt '+name+': '+mask(e.stack??e.message));}}
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
 MCP=await import('../dist/routes/mcp.js');
 const USER={art:'user'};
 await core.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'T310 Testbestand'},{system:'user'});
 for(const funktion of ['agenten_ausweis','agent_verlauf_alle','artefakt_dateien','tool_antwort_ueberlauf'])
  await core.setzeProfilProduktSchalter({ebene:'global',funktion,aktiv:true,grund:'T310 Testfreigabe'},{system:'user'});
 await pool.query(`INSERT INTO model_registry(alias,full_id,provider,context_window,output_limit,corridor_min,corridor_max,pricing_input_usd_per_mtok,pricing_output_usd_per_mtok,pricing_cache_usd_per_mtok) VALUES
  ('sonnet','claude-sonnet-4-5-20250929','anthropic',200000,64000,70,88,3,15,0.3),
  ('gpt-5-codex','gpt-5-codex','openai',400000,64000,70,88,1,4,0.1),
  ('or-deepseek-chat','deepseek/deepseek-chat','openrouter-api',1000000,1000,70,88,0.25,1,0.025)
  ON CONFLICT (alias) DO NOTHING`);
 const ident=async(name,modell)=>{
  const a=await core.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name,rolle:'subagent',grund:'T310 Testidentitaet '+name},USER);
  if(modell) await pool.query('UPDATE agent_identitaeten SET startrezept = COALESCE(startrezept,\'{}\'::jsonb) || $2::jsonb WHERE id=$1',[a.identity_id,JSON.stringify({modell})]);
  return a;
 };
 const zugang=id=>MCP.apiLaufZugang(id,false);
 const ruf=async(a,tool,args)=>MCP.apiLaufWerkzeugAufruf(tool,args,a.token,zugang(a.identity_id));
 const wert=r=>r&&typeof r==='object'?(r.structuredContent??r):r;

 const CLAUDE=await ident('t310-claude','sonnet');
 const CODEX=await ident('t310-codex',null);
 await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,last_activity,heartbeat_enabled,model) VALUES ($1,$2,'t310-codex','idle',NOW(),false,'gpt-5-codex')",[CODEX.identity_id,P]);
 const DEEP=await ident('t310-deepseek',null);
 await core.legeApiLaufAn({identity_id:DEEP.identity_id,project:P,agent_id:DEEP.agent_id,rolle:'subagent',modell:'or-deepseek-chat',anbieter:'openrouter-api',gestartet_von:'user'});

 await section('A Modellfenster je Identitaet',async()=>{
  for(const [a,fenster,modell] of [[CLAUDE,200000,'sonnet'],[CODEX,400000,'gpt-5-codex'],[DEEP,1000000,'or-deepseek-chat']]){
   const r=await core.kontextFensterFuerIdentitaet(a.identity_id);
   check(r.fenster===fenster&&r.modell===modell&&r.quelle==='model_registry','A','Modellfenster '+modell+' = '+fenster+' aus model_registry',r);
  }
  const X=await ident('t310-ohne-modell',null);
  const rx=await core.kontextFensterFuerIdentitaet(X.identity_id);
  check(rx.fenster===null&&rx.quelle==='kein_modell','A','ohne Modell kein geratenes Fenster',rx);
 });

 // Uebergrosse Antwort direkt in PG anlegen (kein Schreib-/Einbettungsweg im Test) und ueber den ECHTEN Werkzeugweg lesen.
 await pool.query('INSERT INTO memories (id,project,name,content,category) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),P,'t310-riesig',GROSS,'note']);
 // Pruefer claude-birke: Referenz OHNE den T191-Ueberlauf lesen (sonst ist sie schon dessen erste Seite); danach wieder EIN,
 // damit D belegt, dass bei aktiver Seitengrenze nur sie gilt.
 await core.setzeProfilProduktSchalter({ebene:'global',funktion:'tool_antwort_ueberlauf',aktiv:false,grund:'T310 Referenz ungekuerzt'},{system:'user'});
 const ungekuerzt=wert(await ruf(CLAUDE,'memory',{action:'read',project:P,name:'t310-riesig'}));
 await core.setzeProfilProduktSchalter({ebene:'global',funktion:'tool_antwort_ueberlauf',aktiv:true,grund:'T310 Testfreigabe'},{system:'user'});
 check(ungekuerzt?.ueberlauf!==true&&JSON.stringify(ungekuerzt??'').length>GROSS.length,'A','Referenz ist die volle Antwort (kein Ueberlauf)',{ueberlauf:ungekuerzt?.ueberlauf});
 check(JSON.stringify(ungekuerzt??'').includes(GROSS.slice(0,1000)),'A','Bestand: memory-Antwort enthaelt den vollen Inhalt (Schalter noch AUS)',
  {laenge:String(JSON.stringify(ungekuerzt??'')).length});

 await section('B Schalter AUS = Bestand',async()=>{
  const g=await core.leseToolAusgabeSeitenGrenze(P,CLAUDE.identity_id);
  check(g.aktiv===false&&g.zeichen===null&&g.debug.schalter.aktive!==true,'B','Grenze AUS trotz global alle EIN (nur ausdruecklich)',g.debug);
  const r=await core.begrenzeAntwortFuerAgent(ungekuerzt,{identity_id:CLAUDE.identity_id,agent_id:CLAUDE.agent_id,project:P,main:false},'memory','read');
  check(r.ergebnis===ungekuerzt&&r.debug===null,'B','AUS: Antwort unveraendert, kein Debug');
  check(core.PROFIL_PRODUKT_FUNKTIONEN.includes('tool_ausgabe_seiten')&&core.NUR_AUSDRUECKLICH.includes('tool_ausgabe_seiten'),'B','Schalter tool_ausgabe_seiten im Katalog und nur ausdruecklich');
 });

 await core.setzeProfilProduktSchalter({ebene:'global',funktion:'tool_ausgabe_seiten',aktiv:true,grund:'T310 Test EIN'},{system:'user'});

 await section('C Grenze aus dem Modellfenster',async()=>{
  const st=await core.leseRuntimeToolAusgabe(P,{identity_id:CLAUDE.identity_id});
  for(const [a] of [[CLAUDE],[CODEX],[DEEP]]){
   const f=await core.kontextFensterFuerIdentitaet(a.identity_id);
   const erw=core.toolAusgabeTokens({wunsch:st.werte.api_tool_output_tokens,prozent:st.werte.tool_ausgabe_kontext_prozent,freigegeben:true,kontext:f.fenster});
   const g=await core.leseToolAusgabeSeitenGrenze(P,a.identity_id);
   check(g.aktiv===true&&g.tokens===erw.tokens&&g.zeichen===erw.tokens*core.API_TOOL_AUSGABE_ZEICHEN_JE_TOKEN,
    'C','Grenze = toolAusgabeTokens(Modellfenster '+f.fenster+') * Zeichen je Token',{g:g.tokens,erw:erw.tokens,zeichen:g.zeichen});
   check(g.debug.modellfenster?.fenster===f.fenster&&g.debug.modellfenster?.quelle==='model_registry','C','Debug nennt Modellfenster und Quelle',g.debug.modellfenster);
  }
 });

 await section('D Claude, Codex, DeepSeek: Seiten und Weiterlesen',async()=>{
  for(const [a,name] of [[CLAUDE,'claude'],[CODEX,'codex'],[DEEP,'deepseek']]){
   const g=await core.leseToolAusgabeSeitenGrenze(P,a.identity_id);
   const erste=wert(await ruf(a,'memory',{action:'read',project:P,name:'t310-riesig'}));
   check(erste?.ueberlauf===true&&erste?.art==='tool_antwort_fortsetzung'&&typeof erste?.artefakt_id==='string',
    'D','erste Seite '+name+': Ueberlauf-Eintrag (tool_antwort_fortsetzung) mit ID',erste&&{art:erste.art,id:erste.artefakt_id,art2:erste.art});
   check(erste?.naechster_aufruf?.action==='tool_antwort_weiterlesen'&&erste?.naechster_aufruf?.artefakt_id===erste?.artefakt_id
    &&Number.isSafeInteger(erste?.naechster_aufruf?.seiten_bytes),'D','erste Seite '+name+': genauer Weiterlese-Aufruf',erste?.naechster_aufruf);
   check(erste?.tool_ausgabe_debug?.modellfenster?.fenster===g.debug.modellfenster.fenster,'D','Debug je Antwort nennt das Modellfenster ('+name+')',erste?.tool_ausgabe_debug?.modellfenster);
   const seiten=[String(erste?.content??'')];
   let naechster=erste?.naechster_aufruf,schutz=0;
   while(naechster&&schutz<200){
    schutz++;
    const s=wert(await ruf(a,'artefakt',{action:'tool_antwort_weiterlesen',artefakt_id:naechster.artefakt_id,
      from_line:naechster.from_line,from_column:naechster.from_column,seiten_bytes:naechster.seiten_bytes}));
    seiten.push(String(s?.content??''));
    naechster=s?.naechster_aufruf??null;
    if(s?.success===false){check(false,'D','Folgeseite '+name+' lesbar',s);break;}
   }
   check(seiten.length>=2,'D','mehrere Seiten fuer '+name+' (uebergrosse Antwort)',seiten.map(s=>s.length));
   check(seiten.every(s=>s.length<=g.zeichen+2000),'D','jede Seite '+name+' unter der Grenze '+g.zeichen,seiten.map(s=>s.length));
   const zusammen=seiten.join('');
   let geparst=null;try{geparst=JSON.parse(zusammen);}catch{geparst=null;}
   // Pruefer claude-birke: Vergleich ohne die je Aufruf wechselnden Anhaenge (pending_events, shell_activity, Skill-Hinweise ...).
   const ohneAnhang=v=>{const o={...(v??{})};for(const k of Object.keys(o))if(!['success','memory'].includes(k))delete o[k];return JSON.stringify(o);};
   check(!naechster,'D','alle Folgeseiten gelesen ('+name+', '+seiten.length+' Seiten)',{schutz});
   check(!!geparst&&JSON.stringify(geparst).includes(JSON.stringify(GROSS))&&ohneAnhang(geparst)===ohneAnhang(ungekuerzt),'D','Folgeseiten zusammengesetzt vollstaendig gleich der ungekuerzten Antwort ('+name+')',
    {laenge:zusammen.length,soll:String(JSON.stringify(ungekuerzt)).length,schluessel:geparst&&Object.keys(geparst),soll_schluessel:Object.keys(ungekuerzt??{})});
  }
 });

 await section('E Weiterlesen nur fuer Ueberlauf-Eintraege',async()=>{
  const r=await ruf(CLAUDE,'artefakt',{action:'tool_antwort_weiterlesen',artefakt_id:randomUUID(),from_line:1,from_column:0});
  const v=wert(r);
  check(v?.success===false&&typeof v?.error==='string','E','unbekannte ID wird abgelehnt (kein Absturz)',v);
 });

 await section('Netz',async()=>{
  const anbieter=netzZiele.filter(u=>/openrouter|anthropic|deepseek|openai|generativelanguage/i.test(u));
  check(anbieter.length===0,'D','keine echten Anbieteraufrufe',{anbieter,gezaehlt:netz});
 });
}catch(e){
 failures.push('Abbruch: '+mask(e.stack??e.message));console.error('FAIL Abbruch: '+mask(e.stack??e.message));
}finally{
 try{if(pool)await pool.end();}catch(e){console.error('DEBUG pool.end: '+mask(e.message));}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('DEBUG Schema-Rueckbau: '+mask(e.message));}
 await admin.end();
 for(const f of Object.keys(perFall).sort())console.log('FALL '+f+': '+perFall[f].pass+' PASS / '+perFall[f].fail+' FAIL');
 console.log('P22-T310: '+checks+' Pruefungen, '+failures.length+' FAIL, network='+netz);
 if(failures.length){for(const f of failures)console.log('ROT '+f);process.exitCode=1;}
}
