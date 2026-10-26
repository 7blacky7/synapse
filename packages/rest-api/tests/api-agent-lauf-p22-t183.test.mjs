/**
 * P22-T183 (User 26.10.2026: API-Agenten direkt im synapse-api-Container): Schritt B, Teil B1-B4.
 *   pnpm -C packages/core build && pnpm -C packages/agents build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-agent-lauf-p22-t183.test.mjs
 * NUR synapse_test:5433, eigenes privates Schema. Fake-Anthropic (lokaler SSE-Server ueber ANTHROPIC_BASE_URL) und Fake-OpenRouter
 * (lokaler HTTP-Server ueber SYNAPSE_OPENROUTER_BASE_URL), KEIN echter Key, kein externes Netz (Zaehler network = 0).
 * Geprueft (Quelldateien):
 *   A core services/api-agent-schleife.ts: Anthropic-Format unveraendert (agents re-exportiert dieselben Funktionen), OpenAI-Format
 *     nachOpenAi/vonOpenAi/stopAusOpenAi/antwortAusOpenAi/nutzungAusOpenAi, Schleife mit Werkzeugrunde
 *   B core db/api-agent-lauf-schema.ts + schema-sql/164 (2x idempotent, in SCHEMA_SQL), Seed or-deepseek-* OHNE Preis
 *   C core services/api-anbieter-preise.ts aktualisiereOpenRouterPreise (Fake-Katalog): Preis/Kontext/Preisstand, ohne Preis, fehlt
 *   D rest-api services/api-agent-transport.ts OpenRouter: Key-Quelle (eigener Name, Rueckfall Jev), ohne Key/Freigabe kein Aufruf,
 *     Buchung usage.cost je Agent (runtime openrouter-api, nicht jev), 402/401-Mapping mit usd 0, Key nie im Text; Route lehnt OpenRouter ab
 *   E api-agent-transport.ts Anthropic im internen Format (tool_use -> werkzeug_aufruf, Kontext-Tokens); Route weiter 200 (Bestand)
 *   F rest-api services/api-agent-direkt.ts AnbieterDirekt + WerkzeugeDirekt in fuehreApiNachrichtAus (OpenRouter-Werkzeugrunde),
 *     Fehler -> ApiAnbieterFehler mit Fachcode; echte tools/list + tools/call in-process (routes/mcp.ts apiLaufWerkzeug*)
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const url=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT',
 'SYNAPSE_HAUPTAGENT_API','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_ANTHROPIC_API_KEY','SYNAPSE_ANTHROPIC_WORKSPACE_ID','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN',
 'ANTHROPIC_BASE_URL','SYNAPSE_VERBRAUCH','SYNAPSE_OPENROUTER_API_KEY','JEV_OPENROUTER_API_KEY','SYNAPSE_OPENROUTER_BASE_URL','FREEPOOL_OPENROUTER_API_KEY'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Netz: nur die lokalen Fake-Server sind erlaubt; jeder andere Aufruf zaehlt als Verstoss.
let network=0;const erlaubt=new Set();const echtesFetch=globalThis.fetch;
globalThis.fetch=async(ziel,opt)=>{const u=String(ziel?.url??ziel);if([...erlaubt].some(b=>u.startsWith(b)))return echtesFetch(ziel,opt);network++;throw Error('Testnetz gesperrt: '+u);};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t183_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t183-projekt';
const KEY_A='sk-ant-test-GEHEIM-p22t183-0123456789',KEY_OR='sk-or-test-GEHEIM-p22t183-abcdef',KEY_JEV='sk-or-jev-GEHEIM-p22t183-999';
const failures=[];let core,pool,checks=0;const aufraeumen=[];
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]').split(KEY_A).join('[KEY]').split(KEY_OR).join('[KEY]').split(KEY_JEV).join('[KEY]');
// Herkunft im Label (regel-tests-mit-herkunft-kommentieren); Fehlschlag: DEBUG mit tatsaechlichem Wert.
function check(ok,label,info){checks++;if(ok)return;failures.push(label);console.error('FAIL '+label+(info!==undefined?' | DEBUG tatsaechlich: '+mask(JSON.stringify(info)).slice(0,700):''));}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

/** Fake-Anthropic: POST /v1/messages als SSE-Strom; Bloecke text oder tool_use. */
function sseNachricht(res,{content,stop_reason,usage,model}){
 res.writeHead(200,{'content-type':'text/event-stream'});
 const ev=(t,d)=>res.write('event: '+t+'\ndata: '+JSON.stringify({type:t,...d})+'\n\n');
 ev('message_start',{message:{id:'msg_t183',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
  usage:{input_tokens:usage.input_tokens,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:usage.cache_read??0}}});
 content.forEach((b,i)=>{
  if(b.type==='tool_use'){ev('content_block_start',{index:i,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});
   ev('content_block_delta',{index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});}
  else{ev('content_block_start',{index:i,content_block:{type:'text',text:''}});ev('content_block_delta',{index:i,delta:{type:'text_delta',text:b.text}});}
  ev('content_block_stop',{index:i});});
 ev('message_delta',{delta:{stop_reason,stop_sequence:null},usage:{output_tokens:usage.output_tokens}});
 ev('message_stop',{});res.end();
}
async function server(handler){
 const s=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;try{await handler(req,res,body?JSON.parse(body):null);}catch(e){res.writeHead(500);res.end(String(e));}});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));aufraeumen.push(()=>new Promise(r=>s.close(()=>r())));
 return 'http://127.0.0.1:'+s.address().port;
}
const json=(res,status,daten)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(daten));};

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema',
  'hauptagent-verlauf-schema','main-warteschlange-schema','agent-verbrauch-schema','agent-api-budget-schema','api-agent-schluessel-schema','api-agent-freigaben-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 await pool.query(`INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max,
   pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit) VALUES
  ('api-haiku','claude-haiku-4-5-20251001','anthropic-api',200000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',73,88,1.00,5.00,0.10,'2025-02-28',64000)
  ON CONFLICT (alias) DO NOTHING`);
 const C=core,USER={art:'user'};
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T183 alle'},{system:'user'});
 const vor=(name,rolle)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name,rolle,grund:'Test T183 '+name},USER);
 const W=await vor('t183-arbeit','subagent');
 const K=await vor('t183-koord','koordinator');
 const kontext=(a,rolle)=>({identity_id:a.identity_id,agent_id:a.agent_id,project:P,zugang:'agent',rolle});

 await section('A Schleife und Formate (core api-agent-schleife.ts)',async()=>{
  const AA=await load('packages/agents/dist/api-worker/anbieter-anthropic.js');
  const AT=await load('packages/agents/dist/api-worker/toolschleife.js');
  check(AA.nachAnthropic===C.nachAnthropic&&AT.fuehreNachrichtAus===C.fuehreApiNachrichtAus&&AT.AnbieterFehler===C.ApiAnbieterFehler,
   'P22-T183 agents toolschleife.ts/anbieter-anthropic.ts: re-exportieren dieselben Funktionen aus core (Altweg unveraendert)');
  const verlauf=[{rolle:'user',inhalt:[{typ:'text',text:'Hallo'}]},
   {rolle:'assistant',inhalt:[{typ:'roh',anbieter:'anthropic',block:{type:'thinking'}},{typ:'text',text:'Ich pruefe.'},{typ:'werkzeug_aufruf',id:'c1',name:'mcp__synapse__chat',eingabe:{action:'x'}}]},
   {rolle:'user',inhalt:[{typ:'werkzeug_ergebnis',aufruf_id:'c1',fehler:true,inhalt:[{typ:'text',text:'kaputt'},{typ:'bild',media_type:'image/png',daten:'AAAA'}]}]}];
  const o=C.nachOpenAi('SYS',verlauf);
  check(o.length===5&&o[0].role==='system'&&o[2].role==='assistant'&&o[2].content==='Ich pruefe.'&&o[2].tool_calls[0].function.arguments==='{"action":"x"}'
   &&o[3].role==='tool'&&o[3].tool_call_id==='c1'&&o[3].content==='[Fehler] kaputt'&&o[4].role==='user'&&o[4].content[1].image_url.url==='data:image/png;base64,AAAA',
   'P22-T183 api-agent-schleife.ts nachOpenAi: system, tool_calls, tool-Nachricht mit [Fehler], Bild als user-Nachricht, Anthropic-roh weg',o);
  const a=C.antwortAusOpenAi({message:{content:null,tool_calls:[{id:'t1',type:'function',function:{name:'f',arguments:'{kaputt'}}]},finish_reason:'stop'});
  check(a.stop==='werkzeug'&&a.inhalt.some(b=>b.typ==='werkzeug_aufruf'&&b.id==='t1'&&Object.keys(b.eingabe).length===0)&&a.inhalt.some(b=>b.typ==='text'&&/kein gueltiges JSON/.test(b.text)),
   'P22-T183 antwortAusOpenAi: tool_calls trotz finish stop -> werkzeug; kaputtes JSON -> leere Eingabe + Text',a);
  check(C.stopAusOpenAi('length')==='max_tokens'&&C.stopAusOpenAi('content_filter')==='abgelehnt'&&C.stopAusOpenAi('stop')==='ende','P22-T183 stopAusOpenAi: length/content_filter/stop');
  const n=C.nutzungAusOpenAi({prompt_tokens:1000,completion_tokens:50,prompt_tokens_details:{cached_tokens:200}});
  check(n.input===800&&n.cache_read===200&&n.output===50,'P22-T183 nutzungAusOpenAi: input ohne Cache-Treffer',n);
  // Schleife mit einer Werkzeugrunde (Fake-Adapter): Vermerk vor Ausfuehrung, Ergebnisse in EINER user-Nachricht.
  const liste=[{rolle:'user',inhalt:[{typ:'text',text:'Los'}]}];const vermerke=[];let ruf=0;
  const r=await C.fuehreApiNachrichtAus({adapter:{name:'fake',rufe:async()=>(++ruf===1
    ?{inhalt:[{typ:'werkzeug_aufruf',id:'w1',name:'x',eingabe:{}}],stop:'werkzeug',stop_roh:'tool_calls',nutzung:null,kosten_usd:0.001}
    :{inhalt:[{typ:'text',text:'Fertig.'}],stop:'ende',stop_roh:'stop',nutzung:null,kosten_usd:0.002})},
   werkzeuge:[],ausfuehrer:{rufe:async()=>({inhalt:[{typ:'text',text:'ok'}],fehler:false})},
   verlauf:{nachrichten:()=>liste,fuegeHinzu:async m=>{liste.push(m);},vermerkeAufruf:async x=>{vermerke.push(x.id);}},
   system:'',max_tokens:100,grenzen:{toolrunden_max:5,laufzeit_ms:60_000}});
  check(r.ende==='fertig'&&r.runden===1&&Math.abs(r.kosten_usd-0.003)<1e-12&&vermerke.join()==='w1'&&liste.length===4,'P22-T183 fuehreApiNachrichtAus: eine Werkzeugrunde, Kosten summiert, Vermerk',{r,vermerke,n:liste.length});
 });

 await section('B Schema 164 (api-agent-lauf-schema.ts)',async()=>{
  const M=await load('packages/core/dist/db/api-agent-lauf-schema.js');
  await pool.query(M.API_AGENT_LAUF_SCHEMA_SQL);await pool.query(M.API_AGENT_LAUF_SCHEMA_SQL);
  for(const t of ['api_agent_laeufe','api_agent_verlauf','api_agent_eingang','api_agent_turns','api_agent_lauf_einstellungen','api_modell_preisstand'])
   check((await pool.query('SELECT to_regclass($1) r',[schema+'.'+t])).rows[0].r!==null,'P22-T183 db/api-agent-lauf-schema.ts: Tabelle '+t+' (2x idempotent)');
  const seed=(await pool.query("SELECT alias,full_id,pricing_input_usd_per_mtok AS pi FROM model_registry WHERE provider='openrouter-api' ORDER BY alias")).rows;
  check(seed.length===2&&seed[0].alias==='or-deepseek-chat'&&seed[1].full_id==='deepseek/deepseek-r1'&&seed.every(z=>z.pi===null),'P22-T183 schema-sql/164: Seed deepseek-chat/r1 OHNE Preis (Entscheid O2)',seed);
  const sqlDatei=await readFile(join(repo,'packages/core/src/db/schema-sql/164_api_agent_lauf.sql'),'utf8');
  check(M.API_AGENT_LAUF_SCHEMA_SQL.includes(sqlDatei.trim().split('\n').slice(-3).join('\n')),'P22-T183 schema-sql/164 = Spiegel api-agent-lauf-schema.ts');
  const schemaJs=await readFile(join(repo,'packages/core/dist/db/schema.js'),'utf8');
  check(/\$\{API_AGENT_LAUF_SCHEMA_SQL\}/.test(schemaJs),'P22-T183 db/schema.ts: SCHEMA_SQL haengt 164 ein');
  const modelle=await C.leseApiModelle();
  check(modelle.some(m=>m.alias==='or-deepseek-chat'&&m.anbieter==='openrouter-api'&&m.eingabe===null)&&modelle.some(m=>m.alias==='api-haiku'&&m.anbieter==='anthropic-api'),
   'P22-T183 api-agent-dienst.ts leseApiModelle: beide Anbieter mit provider',modelle);
 });

 await section('C Preisabgleich OpenRouter (api-anbieter-preise.ts)',async()=>{
  const katalog={'openrouter/deepseek/deepseek-chat':{priceInPerMTok:0.3,priceOutPerMTok:1.2,contextLength:163840,maxOutputTokens:16384,metadataSource:'provider'},
   'openrouter/deepseek/deepseek-r1':{priceInPerMTok:0,priceOutPerMTok:0,contextLength:163840,maxOutputTokens:null,metadataSource:'provider'}};
  const ab=await C.aktualisiereOpenRouterPreise({holeModell:async ref=>katalog[ref]??null});
  const z=Object.fromEntries(ab.zeilen.map(x=>[x.alias,x]));
  check(z['or-deepseek-chat']?.status==='aktualisiert'&&z['or-deepseek-r1']?.status==='ohne_preis','P22-T183 aktualisiereOpenRouterPreise: Preis uebernommen bzw. ohne Preis',ab);
  const m=(await C.leseApiModelle()).find(x=>x.alias==='or-deepseek-chat');
  check(m.eingabe===0.3&&m.ausgabe===1.2&&m.context_window===163840&&m.output_limit===16384,'P22-T183 api-anbieter-preise.ts: model_registry Preis + Kontext aus dem Katalog',m);
  const st=await C.leseOpenRouterPreisstand();
  check(st.fehler===null&&st.zeilen.length===1&&st.zeilen[0].quelle==='openrouter-katalog:provider'&&st.zeilen[0].stand,'P22-T183 leseOpenRouterPreisstand: Quelle und Zeitpunkt',st);
  const ab2=await C.aktualisiereOpenRouterPreise({holeModell:async()=>{throw new Error('Katalog weg');}});
  const m2=(await C.leseApiModelle()).find(x=>x.alias==='or-deepseek-chat');
  check(ab2.zeilen.every(x=>x.status==='fehler')&&m2.eingabe===0.3,'P22-T183 aktualisiereOpenRouterPreise: Abruffehler aendert nichts (letzter guter Preis bleibt)',{ab2,m2});
  // Fix Live-Test 26.10.: oeffentlicher Katalog GET /api/v1/models (ohne Key) statt Free-Model-Pool (kostenpflichtige Modelle fehlen dort).
  const kat=[];
  const holen=async(ziel,opt)=>{kat.push({url:String(ziel),auth:opt?.headers?.Authorization??opt?.headers?.authorization??null});
   return new Response(JSON.stringify({data:[
    {id:'deepseek/deepseek-chat',context_length:163840,pricing:{prompt:'0.0000002574',completion:'0.0000010287'},top_provider:{max_completion_tokens:16384}},
    {id:'deepseek/deepseek-r1',context_length:163840,pricing:{prompt:'0',completion:'0'}},
    {id:'andere/x',pricing:{prompt:'0.000001',completion:'0.000002'}}]}),{status:200,headers:{'content-type':'application/json'}});};
  const ab3=await C.aktualisiereOpenRouterPreise({holen});
  const z3=Object.fromEntries(ab3.zeilen.map(x=>[x.alias,x]));
  const m3=(await C.leseApiModelle()).find(x=>x.alias==='or-deepseek-chat');
  check(kat.length===1&&kat[0].url===C.OPENROUTER_KATALOG_URL&&kat[0].auth===null&&z3['or-deepseek-chat']?.status==='aktualisiert'
   &&z3['or-deepseek-chat'].quelle==='openrouter-katalog:api-v1-models'&&z3['or-deepseek-r1']?.status==='ohne_preis'
   &&m3.eingabe===0.2574&&m3.ausgabe===1.0287&&m3.context_window===163840&&ab3.katalog?.modelle===3&&ab3.katalog.fehler===null,
   'P22-T183 aktualisiereOpenRouterPreise: oeffentlicher Katalog /api/v1/models ohne Key, Preise je 1 Mio. Tokens, Debug katalog',{kat,ab3,m3});
  const f500=await C.ladeOpenRouterKatalog({holen:async()=>new Response('x',{status:500})}).then(()=>'kein_fehler',e=>e.message);
  check(f500==='katalog_http_500','P22-T183 ladeOpenRouterKatalog: HTTP-Fehler -> Fehlercode (aktualisiereOpenRouterPreise schreibt ihn nur ins Debug)',f500);
 });

 // Funktion api + Schalter api_agenten + Budget + Freigaben (wie T179).
 await C.setzeApiSchalter(USER,{aktiv:true,grund:'Test T183 Funktion api'});
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten',aktiv:true,grund:'Test T183 api_agenten EIN'},{system:'user'});
 await C.setzeApiBudget(USER,{grenze_usd:5,erlaubte_modelle:['api-haiku','or-deepseek-chat'],grund:'Test T183 Budget'});

 await section('D Transport OpenRouter (api-agent-transport.ts, Fake-OpenRouter)',async()=>{
  const T=await load('packages/rest-api/dist/services/api-agent-transport.js');
  const anfragen=[];const antworten=[];
  const basis=await server(async(req,res,body)=>{anfragen.push({url:req.url,auth:req.headers.authorization,titel:req.headers['x-title'],body});
   const a=antworten.shift()??{status:200,daten:{id:'gen1',choices:[{message:{role:'assistant',content:'Hallo zurueck.'},finish_reason:'stop'}],
    usage:{prompt_tokens:1000,completion_tokens:40,cost:0.00042}}};json(res,a.status,a.daten);});
  erlaubt.add(basis);process.env.SYNAPSE_OPENROUTER_BASE_URL=basis;
  const anfrage=(extra={})=>({kontext:kontext(W,'subagent'),modell:'or-deepseek-chat',system:'Du bist ein Arbeitsagent.',max_tokens:500,
   verlauf:[{rolle:'user',inhalt:[{typ:'text',text:'Hallo'}]}],werkzeuge:[{name:'mcp__synapse__chat',beschreibung:'Chat',schema:{type:'object',properties:{}}}],...extra});
  check(T.openRouterSchluessel({}).quelle===null&&T.openRouterSchluessel({JEV_OPENROUTER_API_KEY:'j'}).quelle==='JEV_OPENROUTER_API_KEY'
   &&T.openRouterSchluessel({JEV_OPENROUTER_API_KEY:'j',SYNAPSE_OPENROUTER_API_KEY:'s'}).quelle==='SYNAPSE_OPENROUTER_API_KEY','P22-T183 openRouterSchluessel: eigener Name vor Jev-Rueckfall (O1)');
  check(await err(()=>T.rufeApiTransport(anfrage()))==='api_zugang_fehlt'&&anfragen.length===0,'P22-T183 rufeApiTransport: ohne OpenRouter-Key -> api_zugang_fehlt, kein Aufruf');
  process.env.JEV_OPENROUTER_API_KEY=KEY_JEV;
  check(await err(()=>T.rufeApiTransport(anfrage()))==='api_freigabe_fehlt'&&anfragen.length===0,'P22-T183 rufeApiTransport: ohne Freigabe -> api_freigabe_fehlt, kein Aufruf');
  await C.setzeApiFreigabe(USER,{identity_id:W.identity_id,modelle:['or-deepseek-chat','api-haiku'],grenze_usd:1,grund:'Test T183 Arbeitsagent'});
  const jevVor=await pool.query('SELECT count(*)::int n FROM jev_aufrufe').then(r=>r.rows[0].n).catch(()=>null);
  const e=await T.rufeApiTransport(anfrage());
  const b=anfragen[0]?.body??{};
  check(anfragen.length===1&&anfragen[0].url==='/chat/completions'&&anfragen[0].auth==='Bearer '+KEY_JEV&&anfragen[0].titel==='Synapse'&&b.model==='deepseek/deepseek-chat'
   &&b.usage?.include===true&&b.messages[0].role==='system'&&b.tools[0].function.name==='mcp__synapse__chat','P22-T183 rufeOpenRouter: Anfrage (Jev-Key-Rueckfall, full_id, usage.include, OpenAI-Werkzeuge)',anfragen[0]);
  check(e.anbieter==='openrouter-api'&&e.antwort.stop==='ende'&&e.antwort.inhalt[0].text==='Hallo zurueck.'&&e.kosten.usd===0.00042&&e.kosten.usd_quelle==='antwort'&&e.kontext_tokens===1000,
   'P22-T183 rufeOpenRouter: Antwort intern, Kosten = usage.cost, Kontext-Tokens',e);
  const v=(await pool.query("SELECT runtime,usd::float usd,modell FROM agent_verbrauch WHERE identity_id=$1 AND quelle='api_worker'",[W.identity_id])).rows;
  check(v.length===1&&v[0].runtime==='openrouter-api'&&v[0].usd===0.00042&&v[0].modell==='deepseek/deepseek-chat','P22-T183 schliesseApiAufrufAb: Buchung je Agent, runtime openrouter-api',v);
  const jevNach=await pool.query('SELECT count(*)::int n FROM jev_aufrufe').then(r=>r.rows[0].n).catch(()=>null);
  check(jevVor===jevNach,'P22-T183: OpenRouter-Agentenaufruf bucht NICHT in die Jev-Bremse (jev_aufrufe unveraendert)',{jevVor,jevNach});
  process.env.SYNAPSE_OPENROUTER_API_KEY=KEY_OR;
  antworten.push({status:402,daten:{error:{code:402,message:'Insufficient credits for key '+KEY_OR}}});
  const fehler402=await T.rufeApiTransport(anfrage()).catch(x=>x);
  const res402=(await pool.query('SELECT status,usd::float usd,fehler FROM api_agent_reservierungen ORDER BY erstellt_am DESC LIMIT 1')).rows[0];
  check(fehler402.code==='anbieter_guthaben_fehlt'&&fehler402.status===402&&anfragen[1].auth==='Bearer '+KEY_OR&&res402.status==='freigegeben'&&res402.usd===0&&!res402.fehler.includes(KEY_OR),
   'P22-T183 rufeOpenRouter: 402 -> anbieter_guthaben_fehlt, usd 0, eigener Key vor Jev, Key nie im Fehlertext',{code:fehler402.code,res402});
  antworten.push({status:401,daten:{error:{code:401,message:'bad key'}}});
  check(await err(()=>T.rufeApiTransport(anfrage()))==='api_zugang_ungueltig','P22-T183 rufeOpenRouter: 401 -> api_zugang_ungueltig');
  // Altweg-Route lehnt OpenRouter-Modelle ab (kein Anbieteraufruf), Anthropic bleibt dort.
  const Fastify=requireApi('fastify');const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  const n=anfragen.length;
  const r=await f.inject({method:'POST',url:'/api/agent-api/messages',headers:{'x-synapse-agent-token':W.token},
   payload:{project:P,modell:'or-deepseek-chat',max_tokens:100,messages:[{role:'user',content:[{type:'text',text:'x'}]}]}});
  check(r.statusCode===400&&r.json().error.code==='anbieter_nur_api_lauf'&&anfragen.length===n,'P22-T183 agent-api.ts: OpenRouter-Modell im Altweg -> 400 anbieter_nur_api_lauf, kein Aufruf',r.json());
  check(typeof R.eingabeZeichen==='function'&&R.eingabeZeichen({data:'x'.repeat(5000)})===R.eingabeZeichen({data:''})+5000-0,'P22-T183 agent-api.ts: eingabeZeichen weiter exportiert, Bildpauschale');
 });

 await section('E Transport Anthropic intern + Route (Fake-Anthropic)',async()=>{
  const T=await load('packages/rest-api/dist/services/api-agent-transport.js');
  const anfragen=[];const folge=[];
  const basis=await server(async(req,res,body)=>{anfragen.push({url:req.url,body});
   const x=folge.shift()??{content:[{type:'text',text:'Erledigt.'}],stop_reason:'end_turn'};
   sseNachricht(res,{model:body.model,stop_reason:x.stop_reason,usage:{input_tokens:900,output_tokens:30,cache_read:100},content:x.content});});
  erlaubt.add(basis);process.env.ANTHROPIC_BASE_URL=basis;process.env.SYNAPSE_ANTHROPIC_API_KEY=KEY_A;
  folge.push({content:[{type:'tool_use',id:'tu1',name:'mcp__synapse__chat',input:{action:'identitaet'}}],stop_reason:'tool_use'});
  const e=await T.rufeApiTransport({kontext:kontext(W,'subagent'),modell:'api-haiku',system:'S',max_tokens:300,
   verlauf:[{rolle:'user',inhalt:[{typ:'text',text:'Wer bin ich?'}]}],werkzeuge:[{name:'mcp__synapse__chat',beschreibung:'Chat',schema:{type:'object',properties:{}}}]});
  check(e.anbieter==='anthropic-api'&&e.antwort.stop==='werkzeug'&&e.antwort.inhalt[0].typ==='werkzeug_aufruf'&&e.antwort.inhalt[0].eingabe.action==='identitaet'
   &&e.kontext_tokens===1000&&anfragen[0].body.tools[0].input_schema.type==='object'&&anfragen[0].body.model==='claude-haiku-4-5-20251001',
   'P22-T183 rufeAnthropic: internes Format -> tool_use -> werkzeug_aufruf, Kontext 900+100 Cache',{e,body:anfragen[0]?.body});
  const Fastify=requireApi('fastify');const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  const r=await f.inject({method:'POST',url:'/api/agent-api/messages',headers:{'x-synapse-agent-token':W.token},
   payload:{project:P,modell:'api-haiku',system:'S',max_tokens:100,messages:[{role:'user',content:[{type:'text',text:'x'}]}]}});
  const j=r.json();
  check(r.statusCode===200&&j.success&&j.message.content[0].text==='Erledigt.'&&j.message.id==='msg_t183'&&'stop_details' in j.message&&typeof j.rest_usd==='number'&&!r.body.includes(KEY_A),
   'P22-T183 agent-api.ts: Route ueber rufeApiTransport weiter 200 mit message/kosten/rest_usd (Bestand)',j);
 });

 await section('F AnbieterDirekt + WerkzeugeDirekt (api-agent-direkt.ts)',async()=>{
  const D=await load('packages/rest-api/dist/services/api-agent-direkt.js');
  const T=await load('packages/rest-api/dist/services/api-agent-transport.js');
  const anfragen=[];const antworten=[
   {choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'mcp__synapse__chat',arguments:'{"action":"identitaet"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:500,completion_tokens:20,cost:0.0002}},
   {choices:[{message:{role:'assistant',content:'Fertig.'},finish_reason:'stop'}],usage:{prompt_tokens:700,completion_tokens:10,cost:0.0003}}];
  const basis=await server(async(req,res,body)=>{anfragen.push(body);json(res,200,antworten.shift());});
  erlaubt.add(basis);process.env.SYNAPSE_OPENROUTER_BASE_URL=basis;
  const aufrufe=[];
  const werkzeuge=new D.WerkzeugeDirekt({identity_id:W.identity_id,main:false,ausweis:W.token,
   liste:async()=>[{name:'chat',description:'Chat',inputSchema:{type:'object',properties:{action:{type:'string'}}}}],
   aufruf:async(name,args)=>{aufrufe.push({name,args});return {content:[{type:'text',text:'{"agent_id":"t183-arbeit"}'}],isError:false};}});
  const defs=await werkzeuge.liste();
  check(defs.length===1&&defs[0].name==='mcp__synapse__chat'&&defs[0].schema.properties.action,'P22-T183 WerkzeugeDirekt.liste: Praefix mcp__synapse__ wie der Worker',defs);
  const adapter=new D.AnbieterDirekt({kontext:kontext(W,'subagent'),modell:'or-deepseek-chat',anbieter:'openrouter-api'});
  const liste=[{rolle:'user',inhalt:[{typ:'text',text:'Wer bin ich?'}]}];
  const r=await C.fuehreApiNachrichtAus({adapter,werkzeuge:defs,ausfuehrer:werkzeuge,
   verlauf:{nachrichten:()=>liste,fuegeHinzu:async m=>{liste.push(m);},vermerkeAufruf:async()=>{}},system:'S',max_tokens:200,grenzen:{toolrunden_max:5,laufzeit_ms:60_000}});
  const zweite=anfragen[1]?.messages??[];
  check(r.ende==='fertig'&&r.text==='Fertig.'&&r.runden===1&&Math.abs(r.kosten_usd-0.0005)<1e-12&&aufrufe[0]?.name==='chat'&&aufrufe[0].args.action==='identitaet'
   &&zweite.some(m=>m.role==='tool'&&m.tool_call_id==='call_1')&&adapter.letzterKontext===700,
   'P22-T183 AnbieterDirekt+WerkzeugeDirekt: OpenRouter-Werkzeugrunde in der Schleife, Name ohne Praefix, Kosten, Kontext',{r,aufrufe,zweite,k:adapter.letzterKontext});
  // Fehler -> ApiAnbieterFehler mit Fachcode (Schleife endet ausdruecklich).
  const ohne=new D.AnbieterDirekt({kontext:kontext(K,'koordinator'),modell:'or-deepseek-chat',anbieter:'openrouter-api'});
  const f1=await ohne.rufe({system:'',verlauf:liste,werkzeuge:[],max_tokens:10}).catch(x=>x);
  check(f1 instanceof C.ApiAnbieterFehler&&f1.code==='api_freigabe_fehlt','P22-T183 AnbieterDirekt: Fachfehler der Reservierung -> ApiAnbieterFehler(api_freigabe_fehlt)',{name:f1?.name,code:f1?.code});
  const f2=await new D.AnbieterDirekt({kontext:kontext(W,'subagent'),modell:'or-deepseek-chat',anbieter:'openrouter-api',
   transport:async()=>{throw new T.TransportFehler('ueberlastet',503,'x',undefined,7);}}).rufe({system:'',verlauf:liste,werkzeuge:[],max_tokens:10}).catch(x=>x);
  check(f2 instanceof C.ApiAnbieterFehler&&f2.code==='ueberlastet'&&f2.retryAfterSek===7,'P22-T183 AnbieterDirekt: TransportFehler -> ApiAnbieterFehler mit retry_after',{code:f2?.code,r:f2?.retryAfterSek});
  // Echte tools/list + tools/call in-process (routes/mcp.ts) mit dem Ausweis des Arbeitsagenten.
  const M=await load('packages/rest-api/dist/routes/mcp.js');
  const echt=new D.WerkzeugeDirekt({identity_id:W.identity_id,main:false,ausweis:W.token});
  const alle=await echt.liste();
  check(alle.length>5&&alle.some(t=>t.name==='mcp__synapse__chat')&&alle.every(t=>t.name.startsWith('mcp__synapse__')),'P22-T183 routes/mcp.ts apiLaufWerkzeugListe: Gate-Liste in-process',alle.map(t=>t.name));
  const id=await echt.rufe('mcp__synapse__chat',{action:'identitaet',agent_kennung:W.token});
  const text=id.inhalt.map(b=>b.text??'').join('');
  check(id.fehler===false&&text.includes(W.identity_id),'P22-T183 routes/mcp.ts apiLaufWerkzeugAufruf: tools/call als dieser Agent (chat identitaet)',{fehler:id.fehler,text:text.slice(0,400)});
  check(M.apiLaufZugang('x',true).profile==='main-synapse'&&M.apiLaufZugang('x',false).profile==='artefakt-only','P22-T183 apiLaufZugang: Main-Identitaetsweg bzw. Ausweis-Weg');
 });
 await section('G Lauf-Verwaltung (core api-agent-lauf-dienst.ts + rest-api api-agent-lauf.ts)',async()=>{
  const L=await load('packages/rest-api/dist/services/api-agent-lauf.js');
  const UID=randomUUID();
  // Fake-Transport (kein Anbieter): Plan je Aufruf {text|werkzeug|fehler|warte|kontext}; Signal bricht ab.
  const rufe=[];const plan=[];
  const transport=async a=>{rufe.push({system:a.system,verlauf:JSON.parse(JSON.stringify(a.verlauf)),identity:a.kontext.identity_id});
   const x=plan.shift()??{text:'Ok.'};
   if(x.warte)await new Promise((ok,nein)=>{const t=setTimeout(ok,x.warte);a.signal?.addEventListener('abort',()=>{clearTimeout(t);nein(new Error('abgebrochen'));});});
   if(x.fehler)throw Object.assign(new Error(x.fehler),{code:x.fehler});
   const inhalt=x.werkzeug?[{typ:'werkzeug_aufruf',id:x.werkzeug.id,name:'mcp__synapse__'+x.werkzeug.name,eingabe:x.werkzeug.eingabe}]:[{typ:'text',text:x.text}];
   return {anbieter:'openrouter-api',antwort:{inhalt,stop:x.werkzeug?'werkzeug':'ende',stop_roh:null,nutzung:{input:x.kontext??1000,output:10,cache_read:0,cache_creation:0},kosten_usd:0.001},
    kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:1,kontext_tokens:x.kontext??1000};};
  const werkzeugRufe=[];
  const liste=async()=>[{name:'chat',description:'Chat',inputSchema:{type:'object',properties:{}}},{name:'thought',description:'Thought',inputSchema:{type:'object',properties:{}}}];
  const aufruf=async(name,args)=>{werkzeugRufe.push({name,args});
   if(name==='chat'&&args.action==='anmelden')return {content:[{type:'text',text:'ANMELDUNG OK'}]};
   if(name==='thought')return {content:[{type:'text',text:JSON.stringify({success:true,thought:{id:UID}})}]};
   return {content:[{type:'text',text:'{"agent_id":"t183-arbeit"}'}],isError:false};};
  const opt={transport,liste,aufruf,ausweis:async()=>W.token};
  const lauf=async id=>(await pool.query('SELECT status,sitzung::text sitzung,turns,kontext_tokens,kontext_anteil::float anteil,neustarts,letzter_fehler,lease_token FROM api_agent_laeufe WHERE identity_id=$1',[id])).rows[0];
  const offen=async id=>(await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL',[id])).rows[0].n;
  const verlaufZeilen=async(id,s)=>(await pool.query('SELECT art,inhalt FROM api_agent_verlauf WHERE identity_id=$1 AND sitzung=$2 ORDER BY nr',[id,s])).rows;
  const letzterTurn=async id=>(await pool.query('SELECT ende,kosten_usd::float kosten,runden,kontext_tokens FROM api_agent_turns WHERE identity_id=$1 ORDER BY id DESC LIMIT 1',[id])).rows[0];

  // Schalter und Einstellwerte
  const s0=await C.leseApiLaufSchalter(P);
  check(s0.aktiv===false&&s0.quelle==='standard'&&/AUS/.test(s0.debug),'P22-T183 api-agent-lauf-dienst.ts leseApiLaufSchalter: Standard AUS, \'alle\' schaltet ihn NICHT ein (nur ausdruecklich)',s0);
  const e0=await C.leseApiLaufEinstellungen();
  check(e0.api_laeufe_max.wert===3&&e0.buendel_sekunden.wert===10&&e0.neustart_schwelle_prozent.wert===80&&e0.lease_sekunden.wert===120&&e0.api_laeufe_max.quelle==='standard',
   'P22-T183 leseApiLaufEinstellungen: Code-Standard 3/10/80/120 mit Quelle',e0);
  const MAIN_AKT={art:'identitaet',principal:{identity_id:'x',project:P,rolle:'subagent',agent_id:'x'}};
  check(await err(()=>C.setzeApiLaufEinstellungen(MAIN_AKT,{werte:{buendel_sekunden:1},grund:'x'}))==='recht_fehlt'
   &&await err(()=>C.setzeApiLaufEinstellungen(USER,{werte:{buendel_sekunden:0},grund:'Test T183'}))==='einstellung_ungueltig'
   &&await err(()=>C.setzeApiLaufEinstellungen(USER,{werte:{buendel_sekunden:1}}))==='grund_fehlt','P22-T183 setzeApiLaufEinstellungen: nur User, Bereich, Grund Pflicht');
  const e1=await C.setzeApiLaufEinstellungen(USER,{werte:{buendel_sekunden:1},grund:'Test T183 kurzes Buendelfenster'});
  check(e1.buendel_sekunden.wert===1&&e1.buendel_sekunden.quelle==='einstellung','P22-T183 setzeApiLaufEinstellungen: Wert mit Quelle einstellung',e1.buendel_sekunden);

  const a1=await C.legeApiLaufAn({identity_id:W.identity_id,project:P,agent_id:W.agent_id,rolle:'subagent',modell:'or-deepseek-chat',anbieter:'openrouter-api',
   system_prompt:'Du bist t183-arbeit.',gestartet_von:'test-t183'});
  check(a1.neu===true&&a1.status==='bereit'&&a1.sitzung,'P22-T183 legeApiLaufAn: neuer Lauf bereit mit Sitzung',a1);
  const v=new L.LaufVerwaltung(opt);

  // Gegenprobe Schalter AUS: Eingang bleibt liegen, kein Anbieteraufruf.
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Hallo Agent',quelle:'chat',absender:'claude-x',sofort:true});
  const t0=await v.takt();await v.warteAufTurns();
  check(t0.gestartet.length===0&&rufe.length===0&&await offen(W.identity_id)===1&&/AUS/.test(v.zustand().schalter_aus[P]??''),
   'P22-T183 LaufVerwaltung: Schalter api_agenten_lauf_intern AUS -> kein Turn, Eingang bleibt, Debug nennt das Projekt',{t0,rufe:rufe.length,z:v.zustand().schalter_aus});
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten_lauf_intern',aktiv:true,grund:'Test T183 Lauf EIN'},{system:'user'});

  // Buendelung (O3): zweiter Eingang im Fenster -> EIN Turn mit beiden; Werkzeugrunde; Verlauf, Turn, Kontext.
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Noch etwas',quelle:'inbox',absender:'claude-y'});
  plan.push({werkzeug:{id:'w1',name:'chat',eingabe:{action:'identitaet'}}},{text:'Erledigt.',kontext:16384});
  const t1=await v.takt();await v.warteAufTurns();
  const l1=await lauf(W.identity_id);const z1=await verlaufZeilen(W.identity_id,l1.sitzung);const tu1=await letzterTurn(W.identity_id);
  const ersteNachricht=rufe[0]?.verlauf?.[0]?.inhalt?.[0]?.text??'';
  check(t1.gestartet.length===1&&rufe.length===2&&/2 Nachrichten \(gebuendelt\)/.test(ersteNachricht)&&/claude-y/.test(ersteNachricht)&&await offen(W.identity_id)===0,
   'P22-T183 LaufVerwaltung: offene Eingaenge gebuendelt zu EINEM Turn (O3)',{t1,n:rufe.length,ersteNachricht});
  check(/Du bist t183-arbeit\./.test(rufe[0]?.system)&&/ANMELDUNG OK/.test(rufe[0]?.system)&&rufe[0].system.includes(W.token)
   &&werkzeugRufe.some(w=>w.name==='chat'&&w.args.action==='identitaet'),'P22-T183 LaufVerwaltung.sitzung: System = Basis + eigene Anmeldung + Kennung; Werkzeug ueber WerkzeugeDirekt',
   {sys:mask(rufe[0]?.system??'').slice(0,300),werkzeugRufe});
  check(z1.map(z=>z.art).join()==='nachricht,nachricht,aufruf,nachricht,nachricht'&&z1[2].inhalt.id==='w1','P22-T183 VerlaufPg: Nachrichten + Vermerk VOR dem Werkzeugaufruf in api_agent_verlauf',z1.map(z=>z.art));
  check(l1.status==='bereit'&&l1.turns===1&&l1.kontext_tokens===16384&&Math.abs(l1.anteil-16384/163840)<1e-4&&l1.lease_token===null&&tu1.ende==='fertig'&&Math.abs(tu1.kosten-0.002)<1e-9&&tu1.runden===1,
   'P22-T183 LaufVerwaltung: Turn gebucht (Kosten, Runden), Kontext je Lauf (Tokens/Fenster), Sperre frei',{l1,tu1});

  // Buendelfenster: noch nicht faellig -> kein Turn; nach dem Fenster -> Turn.
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Spaeter',quelle:'inbox',absender:'claude-z'});
  const t2=await v.takt();
  await new Promise(r=>setTimeout(r,1200));
  const t3=await v.takt();await v.warteAufTurns();
  check(t2.gestartet.length===0&&t3.gestartet.length===1&&await offen(W.identity_id)===0,'P22-T183 LaufVerwaltung: Turn erst nach buendel_sekunden',{t2,t3});

  // Fehler vor dem Anbieter: kein Verlauf, Eingang bleibt offen, Status fehler; fortsetzen -> Turn.
  const vorFehler=(await verlaufZeilen(W.identity_id,l1.sitzung)).length;
  plan.push({fehler:'api_freigabe_fehlt'});
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Bitte',quelle:'chat',sofort:true});
  await v.takt();await v.warteAufTurns();
  const l2=await lauf(W.identity_id);
  check(l2.status==='fehler'&&l2.letzter_fehler==='api_freigabe_fehlt'&&await offen(W.identity_id)===1&&(await verlaufZeilen(W.identity_id,l1.sitzung)).length===vorFehler
   &&(await letzterTurn(W.identity_id)).ende==='nicht_begonnen','P22-T183 LaufVerwaltung: Fachfehler vor dem Anbieter -> Eingang bleibt, kein Verlauf, Status fehler',l2);
  const t4=await v.takt();
  check(t4.gestartet.length===0,'P22-T183 LaufVerwaltung: Status fehler startet keinen Turn',t4);
  const fs=await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'fortsetzen',grund:'Test T183 Freigabe da'});
  await v.takt();await v.warteAufTurns();
  check(fs.lauf.status==='bereit'&&await offen(W.identity_id)===0&&(await lauf(W.identity_id)).status==='bereit','P22-T183 steuereApiLauf fortsetzen: fehler -> bereit, Eingang abgearbeitet',fs.lauf);

  // Stop bricht den laufenden Turn ab (Pruefung im naechsten Takt).
  plan.push({warte:30_000});
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Lange Aufgabe',quelle:'chat',sofort:true});
  await v.takt();
  await new Promise(r=>setTimeout(r,100));
  const st=await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'stoppen',grund:'Test T183 Stop'});
  const startStop=Date.now();await v.takt();await v.warteAufTurns();
  const l3=await lauf(W.identity_id);
  check(st.vorher==='laeuft'&&l3.status==='gestoppt'&&l3.lease_token===null&&(await letzterTurn(W.identity_id)).ende==='abgebrochen'&&Date.now()-startStop<5000,
   'P22-T183 LaufVerwaltung: stoppen -> laufender Turn abgebrochen, Status bleibt gestoppt',{l3,vorher:st.vorher});
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Nach Stop',quelle:'chat',sofort:true});
  const t5=await v.takt();
  check(t5.gestartet.length===0,'P22-T183 LaufVerwaltung: gestoppt -> kein neuer Turn',t5);
  await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'pausieren',grund:'Test T183 Pause'}).catch(x=>x);
  check(await err(()=>C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'pausieren',grund:'Test T183'}))==='lauf_status_unpassend','P22-T183 steuereApiLauf: gestoppt -> pausieren unpassend');
  await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'fortsetzen',grund:'Test T183 weiter'});
  await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'pausieren',grund:'Test T183 Pause'});
  const t6=await v.takt();
  check(t6.gestartet.length===0&&(await lauf(W.identity_id)).status==='pausiert','P22-T183 LaufVerwaltung: pausiert -> kein neuer Turn',t6);
  await C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'fortsetzen',grund:'Test T183 weiter'});
  await v.takt();await v.warteAufTurns();

  // Neustart bei Schwelle mit Uebergabe (Kontext 150000/163840 >= 80 %).
  const sAlt=(await lauf(W.identity_id)).sitzung;
  plan.push({text:'Arbeit getan.',kontext:150000},{text:'UEBERGABE-TEXT: Auftrag X, offen Y.'});
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'Letzter Schritt',quelle:'chat',sofort:true});
  await v.takt();await v.warteAufTurns();
  const l4=await lauf(W.identity_id);const z4=await verlaufZeilen(W.identity_id,l4.sitzung);
  const th=werkzeugRufe.find(w=>w.name==='thought');
  check(l4.sitzung!==sAlt&&l4.neustarts===1&&l4.kontext_tokens===null&&l4.status==='bereit'&&th?.args?.tags?.includes('session-uebergabe')&&/UEBERGABE-TEXT/.test(th.args.content)
   &&z4.length===2&&new RegExp('thought '+UID).test(z4[0].inhalt.inhalt[0].text)&&/UEBERGABE-TEXT/.test(z4[0].inhalt.inhalt[0].text),
   'P22-T183 LaufVerwaltung: Kontext ueber neustart_schwelle_prozent -> Uebergabe-Turn, thought, neue Sitzung beginnt mit der Uebergabe',{l4,th:th?.args,z4:z4.map(z=>z.inhalt)});
  const uebergabeTurn=(await pool.query("SELECT count(*)::int n FROM api_agent_turns WHERE identity_id=$1 AND ende='uebergabe'",[W.identity_id])).rows[0].n;
  check(uebergabeTurn===1,'P22-T183 api_agent_turns: Uebergabe-Turn mit ende uebergabe',uebergabeTurn);

  // VerlaufPg: offener Werkzeugaufruf nach API-Neustart wird NICHT wiederholt.
  const sR=randomUUID();const vR=await L.VerlaufPg.oeffne(pool,W.identity_id,sR);
  await vR.fuegeHinzu({rolle:'user',inhalt:[{typ:'text',text:'x'}]});
  await vR.fuegeHinzu({rolle:'assistant',inhalt:[{typ:'werkzeug_aufruf',id:'offen1',name:'mcp__synapse__files',eingabe:{}}]});
  await vR.vermerkeAufruf({typ:'werkzeug_aufruf',id:'offen1',name:'mcp__synapse__files',eingabe:{}});
  const vR2=await L.VerlaufPg.oeffne(pool,W.identity_id,sR);
  const letzte=vR2.nachrichten().at(-1);
  check(letzte.rolle==='user'&&letzte.inhalt[0].typ==='werkzeug_ergebnis'&&letzte.inhalt[0].aufruf_id==='offen1'&&letzte.inhalt[0].fehler===true&&/NICHT wiederholt/.test(letzte.inhalt[0].inhalt[0].text),
   'P22-T183 VerlaufPg.oeffne: offener Aufruf -> Fehler-Ergebnis "nicht wiederholt" (Neustart-Schutz)',letzte);

  // Doppellauf-Sperre (zwei Verwaltungen) und api_laeufe_max.
  await C.legeApiLaufAn({identity_id:K.identity_id,project:P,agent_id:K.agent_id,rolle:'koordinator',modell:'or-deepseek-chat',anbieter:'openrouter-api',gestartet_von:'test-t183'});
  await C.setzeApiLaufEinstellungen(USER,{werte:{api_laeufe_max:1},grund:'Test T183 max 1'});
  plan.push({warte:300,text:'Ok A.'},{warte:300,text:'Ok B.'});
  await C.legeApiEingangAn({identity_id:W.identity_id,text:'A',quelle:'chat',sofort:true});
  await C.legeApiEingangAn({identity_id:K.identity_id,text:'B',quelle:'chat',sofort:true});
  const v2=new L.LaufVerwaltung(opt);const n0=rufe.length;
  const [d1,d2]=await Promise.all([v.takt(),v2.takt()]);
  const gleichzeitig=d1.gestartet.length+d2.gestartet.length;
  const ueberlapp=d1.gestartet.filter(x=>d2.gestartet.includes(x)).length;
  await Promise.all([v.warteAufTurns(),v2.warteAufTurns()]);
  check(ueberlapp===0&&d1.gestartet.length<=1&&d2.gestartet.length<=1&&gleichzeitig>=1,'P22-T183 LaufVerwaltung: PG-Sperre - nie zwei Turns derselben Identitaet, je Verwaltung hoechstens api_laeufe_max',{d1,d2});
  await v.takt();await v.warteAufTurns();
  check(await offen(W.identity_id)===0&&await offen(K.identity_id)===0&&rufe.length-n0===2,'P22-T183 LaufVerwaltung: nach dem ersten Turn folgt der zweite',{n:rufe.length-n0,oW:await offen(W.identity_id),oK:await offen(K.identity_id),v:v.zustand().letzte.slice(0,3),v2:v2.zustand().letzte.slice(0,3)});
  await C.setzeApiLaufEinstellungen(USER,{werte:{api_laeufe_max:3},grund:'Test T183 zurueck'});

  // O3 mit echtem Transport: Koordinator ohne Freigabe -> kein Anbieteraufruf, Eingang bleibt, Status fehler.
  const vEcht=new L.LaufVerwaltung({liste,aufruf,ausweis:async()=>K.token});const netzVor=network;
  await C.legeApiEingangAn({identity_id:K.identity_id,text:'Teuer?',quelle:'inbox',absender:'claude-x',sofort:true});
  await vEcht.takt();await vEcht.warteAufTurns();
  const lK=await lauf(K.identity_id);
  check(lK.status==='fehler'&&lK.letzter_fehler==='api_freigabe_fehlt'&&await offen(K.identity_id)===1&&network===netzVor,
   'P22-T183 LaufVerwaltung + rufeApiTransport: Inbox ohne Freigabe -> kein Anbieteraufruf, Eingang bleibt (O3)',{lK,letzte:vEcht.zustand().letzte[0]});

  // Rechte, admin api_lauf (REST + stdio), REST-Routen der Web-UI
  const SUB={art:'identitaet',principal:{identity_id:W.identity_id,project:P,rolle:'subagent',agent_id:W.agent_id}};
  const KOORD={art:'identitaet',principal:{identity_id:K.identity_id,project:P,rolle:'koordinator',agent_id:K.agent_id}};
  const FREMD={art:'identitaet',principal:{identity_id:K.identity_id,project:'anderes-projekt',rolle:'koordinator',agent_id:K.agent_id}};
  check(await err(()=>C.steuereApiLauf(SUB,{identity_id:W.identity_id,aktion:'stoppen',grund:'x'}))==='recht_fehlt'
   &&await err(()=>C.steuereApiLauf(FREMD,{identity_id:W.identity_id,aktion:'stoppen',grund:'x'}))==='recht_fehlt'
   &&await err(()=>C.steuereApiLauf(USER,{identity_id:W.identity_id,aktion:'stoppen'}))==='grund_fehlt'
   &&await err(()=>C.steuereApiLauf(USER,{identity_id:'gibt-es-nicht',aktion:'stoppen',grund:'x'}))==='lauf_unbekannt','P22-T183 steuereApiLauf: Rechte (kein Arbeitsagent, kein fremder Koordinator), Grund, unbekannt');
  const ks=await C.apiLaeufeStand(KOORD,null);
  check(ks.project===P&&ks.laeufe.length===2&&ks.schalter.aktiv===true,'P22-T183 apiLaeufeStand: Koordinator sieht sein Projekt',{p:ks.project,n:ks.laeufe.length});
  check(C.W1B_ADMIN_ACTIONS.includes('api_lauf')&&!!C.W1B_ADMIN_PARAMETER.api_lauf_werte,'P22-T183 admin: Aktion api_lauf + Parameter api_lauf_werte');
  const ad=await C.fuehreApiAgentAdminAus('api_lauf',{modus:'status',project:P},USER);
  const wz=ad.laeufe?.find(z=>z.identity_id===W.identity_id);
  check(ad.success&&wz&&wz.turns>=5&&wz.kosten_usd>0&&wz.neustarts===1&&typeof wz.kosten_usd_sitzung==='number'&&wz.letzter_turn&&ad.einstellungen.buendel_sekunden.quelle==='einstellung',
   'P22-T183 admin api_lauf status: Kontext, Verbrauch (gesamt/Sitzung), Status, letzter Turn, Einstellwerte (Verwaltung E)',wz);
  const ad2=await C.fuehreApiAgentAdminAus('api_lauf',{modus:'einstellungen',api_lauf_werte:{buendel_sekunden:10},grund:'x'},KOORD);
  const ad3=await C.fuehreApiAgentAdminAus('api_lauf',{modus:'preise'},KOORD);
  check(ad2.success===false&&ad2.error==='recht_fehlt'&&ad3.error==='recht_fehlt','P22-T183 admin api_lauf: einstellungen/preise nur User',{ad2,ad3});
  const Fastify=requireApi('fastify');const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  const g=await f.inject({method:'GET',url:'/api/main-agent/api/laeufe?project='+P});
  const p1=await f.inject({method:'POST',url:'/api/main-agent/api/laeufe/steuern',payload:{identity_id:W.identity_id,aktion:'pausieren'}});
  const p2=await f.inject({method:'POST',url:'/api/main-agent/api/laeufe/steuern',payload:{identity_id:W.identity_id,aktion:'pausieren',grund:'Test T183 REST'}});
  const p3=await f.inject({method:'PUT',url:'/api/main-agent/api/laeufe/einstellungen',payload:{werte:{neustart_schwelle_prozent:85},grund:'Test T183 REST'}});
  check(g.statusCode===200&&g.json().laeufe.length===2&&p1.json().error?.code==='grund_fehlt'&&p2.statusCode===200&&p2.json().lauf.status==='pausiert'
   &&p3.json().einstellungen?.neustart_schwelle_prozent?.wert===85,'P22-T183 agent-api.ts: GET laeufe, POST steuern (Grund Pflicht), PUT einstellungen',{g:g.statusCode,p1:p1.json(),p2:p2.statusCode,p3:p3.json()});
  const z=v.zustand();
  check(z.takte>5&&z.turns>=5&&Array.isArray(z.letzte)&&z.letzte.some(x=>x.ende==='neustart')&&z.aktive.length===0,'P22-T183 LaufVerwaltung.zustand: Debug (Takte, Turns, letzte Ergebnisse, aktive)',z);
 });
 await section('H Einstiege (core api-agent-einstieg.ts, B7a/c/d)',async()=>{
  const U=f=>C.mitUserHerkunft('web-ui-chat',f);
  const warte=ms=>new Promise(r=>setTimeout(r,ms));
  const eingaenge=async(id,quelle)=>(await pool.query('SELECT quelle,absender,text,faellig_ab<=NOW() faellig FROM api_agent_eingang WHERE identity_id=$1 AND ($2::text IS NULL OR quelle=$2) ORDER BY id',[id,quelle??null])).rows;
  check(await C.apiProviderFuerModell('or-deepseek-chat')==='openrouter-api'&&await C.apiProviderFuerModell('api-haiku')==='anthropic-api'&&await C.apiProviderFuerModell('gibt-es-nicht')===null,
   'P22-T183 apiProviderFuerModell: nur anthropic-api/openrouter-api');
  check(await U(()=>C.spawneAlsApiLauf({project:'p22-t183-aus',name:'t183-aus',model:'or-deepseek-chat',task:'x'}))===null,'P22-T183 spawneAlsApiLauf: Schalter AUS im Projekt -> null (Bestand, Daemon-Weg)');
  check(await U(()=>C.spawneAlsApiLauf({project:P,name:'t183-cli',model:'gibt-es-nicht',task:'x'}))===null,'P22-T183 spawneAlsApiLauf: kein API-Modell -> null (Bestand)');
  const ohne=await C.spawneAlsApiLauf({project:P,name:'t183-neu',model:'or-deepseek-chat',task:'Bitte pruefen'});
  check(ohne?.success===false&&ohne.error==='recht_fehlt','P22-T183 spawneAlsApiLauf: ohne User/Koordinator -> recht_fehlt',ohne);
  const sp=await U(()=>C.spawneAlsApiLauf({project:P,name:'t183-neu',model:'or-deepseek-chat',expertise:'Pruefung',task:'Bitte pruefen',channel:'t183-team'}));
  check(sp?.success===true&&sp.ort==='api'&&sp.identitaet_neu===true&&sp.freigabe.vorhanden===false&&/KEIN Turn/.test(sp.message),'P22-T183 spawneAlsApiLauf: Identitaet neu, Hinweis ohne Freigabe',sp);
  const lz=(await pool.query('SELECT status,system_prompt,anbieter,modell FROM api_agent_laeufe WHERE identity_id=$1',[sp.identity_id])).rows[0];
  const ea=await eingaenge(sp.identity_id,'auftrag');
  check(lz?.status==='bereit'&&lz.anbieter==='openrouter-api'&&/Spezialist fuer Pruefung/.test(lz.system_prompt)&&/t183-team/.test(lz.system_prompt)&&ea.length===1&&ea[0].faellig&&ea[0].text==='Bitte pruefen',
   'P22-T183 spawneAlsApiLauf: Lauf + Auftrag als sofort faelliger Eingang',{lz,ea});
  const sp2=await U(()=>C.spawneAlsApiLauf({project:P,name:'t183-neu',model:'or-deepseek-chat',task:'Zweiter Auftrag'}));
  check(sp2?.success&&sp2.identity_id===sp.identity_id&&sp2.identitaet_neu===false&&sp2.lauf.neu===false&&(await eingaenge(sp.identity_id,'auftrag')).length===2,
   'P22-T183 spawneAlsApiLauf: erneuter Spawn = dieselbe Identitaet, derselbe Lauf, neuer Auftrag',sp2);
  // c) Zustellung (O3): Inbox und Chat-DM an den Agenten -> Eingang mit Buendelfenster
  await C.postToInbox('claude-x','t183-neu','Hallo ueber die Inbox',P);
  await C.postToInbox('claude-x','t183-ohne-lauf','Hallo',P);
  await warte(400);
  const ei=await eingaenge(sp.identity_id,'inbox');
  const zs=C.apiLaufZustellungStand();
  check(ei.length===1&&ei[0].absender==='claude-x'&&ei[0].text==='Hallo ueber die Inbox'&&zs.zugestellt>=1&&zs.ohne_lauf>=1,'P22-T183 inbox.ts postToInbox: Inbox an API-Agenten -> Eingang; ohne Lauf nichts',{ei,zs});
  let dm=null;try{await C.sendChatMessage(P,K.agent_id,'DM an dich','t183-neu');await warte(400);dm=await eingaenge(sp.identity_id,'chat');}catch(e){dm={fehler:mask(e.message)};}
  check(Array.isArray(dm)&&dm.length===1&&dm[0].absender===K.agent_id,'P22-T183 chat.ts sendMessage: Chat-DM an API-Agenten -> Eingang chat',dm);
  // Gegenprobe Schalter AUS: keine Zustellung, stop = Bestand
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten_lauf_intern',aktiv:false,grund:'Test T183 Gegenprobe AUS'},{system:'user'});
  const vorAus=(await eingaenge(sp.identity_id)).length;const ausVor=C.apiLaufZustellungStand().schalter_aus;
  await C.postToInbox('claude-x','t183-neu','Bei AUS',P);await warte(400);
  check((await eingaenge(sp.identity_id)).length===vorAus&&C.apiLaufZustellungStand().schalter_aus===ausVor+1,'P22-T183 stelleApiLaufZu: Schalter AUS -> kein Eingang (Bestand), Zaehler schalter_aus');
  check(await U(()=>C.stoppeAlsApiLauf(P,'t183-neu'))===null,'P22-T183 stoppeAlsApiLauf: Schalter AUS -> null (Bestand)');
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten_lauf_intern',aktiv:true,grund:'Test T183 wieder EIN'},{system:'user'});
  // d) stop
  check((await C.stoppeAlsApiLauf(P,'t183-neu'))?.error==='recht_fehlt','P22-T183 stoppeAlsApiLauf: ohne User/Koordinator -> recht_fehlt');
  const so=await U(()=>C.stoppeAlsApiLauf(P,'t183-neu'));
  const ls=(await pool.query('SELECT status FROM api_agent_laeufe WHERE identity_id=$1',[sp.identity_id])).rows[0];
  check(so?.success&&so.status==='gestoppt'&&ls.status==='gestoppt','P22-T183 stoppeAlsApiLauf: Status gestoppt',{so,ls});
  check(await U(()=>C.stoppeAlsApiLauf(P,'gibt-es-nicht'))===null,'P22-T183 stoppeAlsApiLauf: ohne Lauf -> null (Bestand)');
  // b) Main-Chat synchron: warteAufEingang (Fake-Transport) - fertig mit Antwort bzw. nicht_begonnen bei Fachfehler.
  const Lm=await load('packages/rest-api/dist/services/api-agent-lauf.js');
  await C.steuereApiLauf(USER,{identity_id:sp.identity_id,aktion:'fortsetzen',grund:'Test T183 B7b'});
  await pool.query('UPDATE api_agent_eingang SET erledigt_am=NOW() WHERE identity_id=$1 AND erledigt_am IS NULL',[sp.identity_id]);
  const fx=[{text:'Antwort fuer den Chat.'},{fehler:'api_freigabe_fehlt'}];
  const vm=new Lm.LaufVerwaltung({transport:async()=>{const x=fx.shift();if(x.fehler)throw Object.assign(new Error(x.fehler),{code:x.fehler});
    return {anbieter:'openrouter-api',antwort:{inhalt:[{typ:'text',text:x.text}],stop:'ende',stop_roh:null,nutzung:{input:100,output:5,cache_read:0,cache_creation:0},kosten_usd:0.0001},
     kosten:{usd:0.0001},rest_usd:1,kontext_tokens:100};},liste:async()=>[],aufruf:async()=>({content:[{type:'text',text:'ok'}]}),ausweis:async()=>W.token});
  const em1=await C.legeApiEingangAn({identity_id:sp.identity_id,text:'Frage aus dem Chat',quelle:'main_chat',absender:'user'});
  const w1=await vm.warteAufEingang(em1.id,10_000);
  const em2=await C.legeApiEingangAn({identity_id:sp.identity_id,text:'Noch eine',quelle:'main_chat',absender:'user'});
  const w2=await vm.warteAufEingang(em2.id,10_000);
  check(w1.art==='fertig'&&w1.text==='Antwort fuer den Chat.'&&w1.output_tokens===5&&w2.art==='nicht_begonnen'&&w2.code==='api_freigabe_fehlt',
   'P22-T183 LaufVerwaltung.warteAufEingang: synchroner Turn (Main-Chat) fertig bzw. Fachfehler',{w1,w2});
  const dm2=await readFile(join(repo,'packages/rest-api/src/services/agent-runtime/dauerhafter-main.ts'),'utf8');
  check(/apiLaufMainTurn/.test(dm2)&&/leseApiLaufSchalter\(HAUPTAGENT_PROJEKT\)/.test(dm2)&&/warteAufEingang/.test(dm2),'P22-T183 dauerhafter-main.ts: Main-Chat mit API-Modell ueber die Lauf-Verwaltung (Schalter), sonst Bestand');
  // REST-Weg (handleToolCallKern): specialist spawn landet im API-Lauf; Quelltext stdio-Weg ruft dieselben core-Funktionen.
  const stdio=await readFile(join(repo,'packages/mcp-server/src/tools/consolidated/specialist.ts'),'utf8');
  const rest=await readFile(join(repo,'packages/rest-api/src/routes/mcp.ts'),'utf8');
  check(/spawneAlsApiLauf/.test(stdio)&&/stoppeAlsApiLauf/.test(stdio)&&/spawneAlsApiLauf/.test(rest)&&/stoppeAlsApiLauf/.test(rest),'P22-T183 specialist spawn/stop: REST und stdio rufen dieselben core-Einstiege');
 });
 await section('I Rueckfall auf Container bei Tageslimit (api-agent-lauf.ts, agent-container.ts spawneRueckfallImContainer)',async()=>{
  const L=await load('packages/rest-api/dist/services/api-agent-lauf.js');
  const warte=ms=>new Promise(r=>setTimeout(r,ms));
  check(L.containerModellFuer('api-opus',{})==='opus'&&L.containerModellFuer('or-deepseek-chat',{})==='sonnet'
   &&L.containerModellFuer('api-haiku',{SYNAPSE_API_RUECKFALL_MODELL:'codex'})==='codex','P22-T183 containerModellFuer: api-<cli> -> <cli>, sonst sonnet, Env ueberschreibt');
  const ein=await C.leseApiLaufEinstellungen();
  check(!('auto_turns_max' in ein)&&!C.API_LAUF_EINSTELLUNG_NAMEN.includes('auto_turns_max'),'P22-T183 User-Korrektur: auto_turns_max entfernt (einzige Grenze = Tageslimit)');
  // spawneRueckfallImContainer: serverintern ohne Akteur (public spawneImContainer verlangt User/Koordinator).
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'spezialisten_container',aktiv:true,grund:'Test T183 Container EIN'},{system:'user'});
  const pub=await C.spawneImContainer({project:P,name:W.agent_id,model:'sonnet',expertise:'x',task:'y'});
  const sys=await C.spawneRueckfallImContainer({project:P,name:W.agent_id,model:'sonnet',expertise:'x',task:'y'});
  check(pub.error==='recht_fehlt'&&sys.success===false&&sys.error==='kontingent_erreicht','P22-T183 agent-container.ts: Rueckfall-Spawn ohne Akteur (Kontingent/Schalter gelten), oeffentlicher Spawn weiter nur User/Koordinator',{pub:pub.error,sys:sys.error});
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'spezialisten_container',aktiv:false,grund:'Test T183 Container AUS'},{system:'user'});
  const R=await vor('t183-rueck','subagent');
  await C.legeApiLaufAn({identity_id:R.identity_id,project:P,agent_id:R.agent_id,rolle:'subagent',modell:'or-deepseek-chat',anbieter:'openrouter-api',gestartet_von:'test-t183'});
  const UID=randomUUID();const spawns=[];const plan=[];const werkzeugRufe=[];
  const transport=async()=>{const x=plan.shift()??{text:'Ok.'};if(x.fehler)throw Object.assign(new Error(x.fehler),{code:x.fehler});
   const inhalt=x.werkzeug?[{typ:'werkzeug_aufruf',id:'rf'+randomUUID().slice(0,6),name:'mcp__synapse__chat',eingabe:{action:'identitaet'}}]:[{typ:'text',text:x.text}];
   return {anbieter:'openrouter-api',antwort:{inhalt,stop:x.werkzeug?'werkzeug':'ende',stop_roh:null,nutzung:{input:100,output:5,cache_read:0,cache_creation:0},kosten_usd:0.0001},
    kosten:{usd:0.0001},rest_usd:0,kontext_tokens:100};};
  const aufruf=async(name,args)=>{werkzeugRufe.push({name,args});
   if(name==='thought')return {content:[{type:'text',text:JSON.stringify({success:true,id:UID})}]};
   return {content:[{type:'text',text:'ok'}]};};
  const liste=async()=>[{name:'chat',description:'Chat',inputSchema:{type:'object',properties:{}}},{name:'thought',description:'Thought',inputSchema:{type:'object',properties:{}}}];
  const v=new L.LaufVerwaltung({transport,aufruf,liste,ausweis:async()=>R.token,rueckfall:async x=>{spawns.push(x);return {success:true,ort:'container',runtime:'claude',identity_id:R.identity_id};}});
  const lauf=async x=>(await pool.query('SELECT status,letzter_fehler,lease_token FROM api_agent_laeufe WHERE identity_id=$1',[x.identity_id])).rows[0];
  const offen=async x=>(await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1 AND erledigt_am IS NULL',[x.identity_id])).rows[0].n;
  // 1) Tageslimit vor dem Anbieteraufruf: Rueckfall mit Uebergabe, offene Eingaenge gehen mit.
  plan.push({text:'Erste Antwort.'},{fehler:'budget_erschoepft'});
  await C.legeApiEingangAn({identity_id:R.identity_id,text:'Erster Auftrag',quelle:'auftrag',absender:'user'});
  await v.takt();await v.warteAufTurns();
  await C.legeApiEingangAn({identity_id:R.identity_id,text:'Zweite Nachricht',quelle:'chat',absender:'claude-x',sofort:true});
  await C.legeApiEingangAn({identity_id:R.identity_id,text:'Dritte Nachricht',quelle:'inbox',absender:'claude-y',sofort:true});
  await v.takt();await v.warteAufTurns();
  const l1=await lauf(R);const th=werkzeugRufe.find(w=>w.name==='thought');const sp=spawns[0];
  check(l1.status==='gestoppt'&&/^rueckfall_container: Container-Agent gestartet \(sonnet\)/.test(l1.letzter_fehler??'')&&l1.lease_token===null&&await offen(R)===0,
   'P22-T183 Rueckfall: budget_erschoepft -> Lauf gestoppt mit Marke rueckfall_container, Eingaenge uebergeben',l1);
  check(th&&th.args.tags.includes('session-uebergabe')&&/Erste Antwort\./.test(th.args.content)&&/Zweite Nachricht/.test(th.args.content)&&/Dritte Nachricht/.test(th.args.content),
   'P22-T183 Rueckfall: Uebergabe-thought (session-uebergabe) aus Verlauf + offenen Eingaengen',th?.args);
  check(spawns.length===1&&sp.name===R.agent_id&&sp.project===P&&sp.model==='sonnet'&&sp.task.includes(UID)&&/Zweite Nachricht/.test(sp.task)&&/Dritte Nachricht/.test(sp.task),
   'P22-T183 Rueckfall: Container-Agent mit demselben Namen (= Identitaet/Ausweis), Uebergabe und offenen Eingaengen im Auftrag',sp);
  const z=v.zustand().ruckfall_container;
  check(z.anzahl===1&&z.letzter.ok===true&&z.letzter.thought===UID&&v.zustand().letzte.some(x=>x.ende==='ruckfall_container'),'P22-T183 LaufVerwaltung.zustand: Debug ruckfall_container',z);
  // Im Rueckfall: Inbox und stop gehen an den Bestand; KEIN automatischer Rueckwechsel.
  await C.postToInbox('claude-x',R.agent_id,'Nach dem Rueckfall',P);await warte(400);
  await v.takt();await v.warteAufTurns();
  check(await offen(R)===0&&(await lauf(R)).status==='gestoppt'&&C.apiLaufZustellungStand().im_rueckfall>=1,'P22-T183 Rueckfall: Inbox bleibt beim Container-Agenten (kein Eingang, kein Turn, kein Rueckwechsel)');
  check(await C.mitUserHerkunft('web-ui-chat',()=>C.stoppeAlsApiLauf(P,R.agent_id))===null,'P22-T183 Rueckfall: stop geht an den Bestand (Daemon)');
  await C.steuereApiLauf(USER,{identity_id:R.identity_id,aktion:'fortsetzen',grund:'Test T183 User wechselt zurueck'});
  check((await lauf(R)).status==='bereit','P22-T183 Rueckfall: Rueckwechsel nur ausdruecklich durch den User (fortsetzen)');
  // 2) Tageslimit mitten im Turn; Spawn scheitert -> Status fehler mit Grund.
  plan.push({werkzeug:true},{fehler:'budget_erschoepft'});const spawnsF=[];
  const vF=new L.LaufVerwaltung({transport,aufruf,liste,ausweis:async()=>R.token,rueckfall:async x=>{spawnsF.push(x);return {success:false,error:'kontingent_erreicht'};}});
  await C.legeApiEingangAn({identity_id:R.identity_id,text:'Mitten im Turn',quelle:'chat',sofort:true});
  await vF.takt();await vF.warteAufTurns();
  const l2=await lauf(R);
  check(spawnsF.length===1&&l2.status==='fehler'&&/^rueckfall_container_fehlgeschlagen: kontingent_erreicht/.test(l2.letzter_fehler??'')&&vF.zustand().ruckfall_container.fehlgeschlagen===1,
   'P22-T183 Rueckfall: budget_erschoepft mitten im Turn -> Rueckfall; Spawn scheitert -> Status fehler mit Grund',l2);
  // 3) Grenze je Agent (agent_budget_erschoepft, Live-Grenztest): Rueckfall statt Status fehler.
  await C.steuereApiLauf(USER,{identity_id:R.identity_id,aktion:'fortsetzen',grund:'Test T183 Agent-Grenze'});
  plan.length=0;plan.push({fehler:'agent_budget_erschoepft'});const vorA=spawns.length;
  await C.legeApiEingangAn({identity_id:R.identity_id,text:'Grenze des Agenten',quelle:'chat',sofort:true});
  await v.takt();await v.warteAufTurns();
  const l3=await lauf(R);
  check(spawns.length===vorA+1&&l3.status==='gestoppt'&&/^rueckfall_container: .*agent_budget_erschoepft/.test(l3.letzter_fehler??'')&&await offen(R)===0,
   'P22-T183 Rueckfall: agent_budget_erschoepft (nicht begonnen) -> gestoppt mit rueckfall_container statt fehler',l3);
  // Gegenprobe Schalter AUS: kein Turn, kein Rueckfall (Bestand).
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten_lauf_intern',aktiv:false,grund:'Test T183 Gegenprobe AUS'},{system:'user'});
  await C.steuereApiLauf(USER,{identity_id:R.identity_id,aktion:'fortsetzen',grund:'Test T183 Gegenprobe'});
  plan.length=0;plan.push({fehler:'budget_erschoepft'});const vorSpawns=spawns.length;
  await C.legeApiEingangAn({identity_id:R.identity_id,text:'Bei AUS',quelle:'chat',sofort:true});
  await v.takt();await v.warteAufTurns();
  check(spawns.length===vorSpawns&&(await lauf(R)).status==='bereit'&&await offen(R)>=1,'P22-T183 Rueckfall Gegenprobe: Schalter AUS -> kein Turn, kein Rueckfall (Bestand)');
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten_lauf_intern',aktiv:true,grund:'Test T183 wieder EIN'},{system:'user'});
  await C.steuereApiLauf(USER,{identity_id:R.identity_id,aktion:'stoppen',grund:'Test T183 Ende'});
  const dm=await readFile(join(repo,'packages/rest-api/src/services/agent-runtime/dauerhafter-main.ts'),'utf8');
  check(/rueckfall_container/.test(dm)&&/ruckfall_container/.test(dm),'P22-T183 dauerhafter-main.ts: Main im Rueckfall -> Bestand (Container-Main)');
 });
 check(network===0,'P22-T183: kein externes Netz (nur lokale Fake-Server)',network);
}finally{
 for(const f of aufraeumen.reverse())await f().catch(()=>undefined);
 await core?.closePool?.().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);await admin.end();
}
console.log(failures.length?`P22-T183 FAIL ${failures.length}/${checks}`:`P22-T183 PASS ${checks}/${checks}`);
process.exit(failures.length?1:0);
