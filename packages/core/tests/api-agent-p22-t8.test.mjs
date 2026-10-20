/**
 * P22-T8 (W2-API): kostenpflichtiger API-Agent. Nur synapse_test:5433, eigenes privates Schema, Fake-Anthropic (lokaler
 * HTTP-Server ueber ANTHROPIC_BASE_URL), Fake-Synapse fuer den Worker, KEIN echter API-Key, kein externes Netz.
 *   node packages/core/tests/api-agent-p22-t8.test.mjs
 * A Schema 120 (2x idempotent), Seed api-* in SCHEMA_SQL = STATIC_FALLBACK, runtime-pfad findet dist/api-worker.js
 * B Schalter: Standard AUS, wirksam nur hauptagent UND Funktion api, setzen nur User, intern-Override registriert
 * C Budget: ohne Budget kein Aufruf, Validierung (Grenze, Zeitraum, Modell, Preis), nur User
 * D Reservierung: Formel, Kappung max_tokens, modell_nicht_erlaubt, budget_erschoepft, zwei gleichzeitig am letzten Rest,
 *   verfallen zaehlt voll
 * E Abschluss: Kosten aus usage (Cache), Buchung agent_verbrauch (api_worker) atomar + idempotent, freigegeben, ohne usage
 * F admin api_*: Rechte User/Main/Koordinator, Einstellwerte mit Quelle, Aktionen/Parameter im W1B-Dispatcher
 * G REST: Transport mit Fake-Anthropic (Key nie in Antwort, Modell-ID, Kappung, Buchung), Fehler (Key fehlt, 401, 429,
 *   Schalter AUS, falscher Ausweis), Rahmen, mainScopePasst
 * H Worker: Toolschleife (Runden, pause_turn, max_tokens, refusal, Grenzen, Anbieterfehler), Verlauf-Neustart, MCP-Client,
 *   Anthropic-Adapter, Zugang aus mcp-http.json, Prozess end-to-end gegen Fake-Synapse
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T8_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const requireApi=createRequire(join(root,'packages/rest-api/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT',
 'SYNAPSE_HAUPTAGENT_API','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','SYNAPSE_VERBRAUCH'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Netz: nur der lokale Fake-Anthropic ist erlaubt; jeder andere Aufruf zaehlt als Verstoss.
let network=0;const erlaubt=new Set();const echtesFetch=globalThis.fetch;
globalThis.fetch=async(ziel,opt)=>{const u=String(ziel?.url??ziel);if([...erlaubt].some(b=>u.startsWith(b)))return echtesFetch(ziel,opt);network++;throw Error('Testnetz gesperrt: '+u);};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t8_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t8-projekt';
const KEY='sk-ant-test-GEHEIM-p22t8-0123456789';
const failures=[];let core,pool,checks=0;const aufraeumen=[];
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]').split(KEY).join('[KEY]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};
const nah=(a,b)=>Math.abs(a-b)<1e-9;

/** Fake-Anthropic: POST /v1/messages als SSE-Strom (wie die echte API, stream:true). */
function sseNachricht(res,{content,stop_reason,usage,model}){
 res.writeHead(200,{'content-type':'text/event-stream'});
 const ev=(t,d)=>res.write('event: '+t+'\ndata: '+JSON.stringify({type:t,...d})+'\n\n');
 ev('message_start',{message:{id:'msg_test',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
  usage:{input_tokens:usage.input_tokens,output_tokens:1,cache_creation_input_tokens:usage.cache_creation_input_tokens??0,cache_read_input_tokens:usage.cache_read_input_tokens??0}}});
 content.forEach((b,i)=>{
  if(b.type==='text'){ev('content_block_start',{index:i,content_block:{type:'text',text:''}});ev('content_block_delta',{index:i,delta:{type:'text_delta',text:b.text}});}
  else{ev('content_block_start',{index:i,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});ev('content_block_delta',{index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});}
  ev('content_block_stop',{index:i});
 });
 ev('message_delta',{delta:{stop_reason,stop_sequence:null},usage:{output_tokens:usage.output_tokens}});
 ev('message_stop',{});res.end();
}
async function server(handler){
 const s=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;try{await handler(req,res,body?JSON.parse(body):null);}catch(e){res.writeHead(500);res.end(String(e));}});
 await new Promise(r=>s.listen(0,'127.0.0.1',r));aufraeumen.push(()=>new Promise(r=>s.close(()=>r())));
 return 'http://127.0.0.1:'+s.address().port;
}

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
 await ident('t8-k',P,'t8-koord','koordinator');
 const KO=akt('t8-k',P,'koordinator');
 const adm=(a,args,akteur)=>C.fuehreW1bAdminAus(a,args,{akteur});

 await section('A Schema 120 und Seed',async()=>{
  const M=await load('packages/core/dist/db/agent-api-budget-schema.js');
  await pool.query(M.AGENT_API_BUDGET_SCHEMA_SQL);await pool.query(M.AGENT_API_BUDGET_SCHEMA_SQL);
  for(const t of ['api_agent_budget','api_agent_einstellungen','api_agent_reservierungen'])check((await pool.query('SELECT to_regclass($1) r',[schema+'.'+t])).rows[0].r!==null,'Tabelle '+t+' im Testschema');
  const sqlDatei=await readFile(join(root,'packages/core/src/db/schema-sql/120_agent_api_budget.sql'),'utf8');
  for(const t of ['api_agent_budget','api_agent_einstellungen','api_agent_reservierungen'])check(sqlDatei.includes('CREATE TABLE IF NOT EXISTS '+t)&&M.AGENT_API_BUDGET_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS '+t),'120.sql und Spiegel: '+t);
  const schemaJs=await readFile(join(root,'packages/core/dist/db/schema.js'),'utf8');
  const S={SCHEMA_SQL:schemaJs};
  check(/\$\{AGENT_API_BUDGET_SCHEMA_SQL\}/.test(schemaJs)&&/import \{ AGENT_API_BUDGET_SCHEMA_SQL \} from '\.\/agent-api-budget-schema\.js'/.test(schemaJs),'SCHEMA_SQL haengt 120 ein');
  const A=await load('packages/agents/dist/models.js');
  for(const alias of ['api-opus','api-sonnet','api-haiku','api-fable']){
   const m=A.STATIC_FALLBACK[alias];
   check(m&&m.provider==='anthropic-api'&&m.binary==='node'&&m.runtimePath==='@synapse/agents/api-worker','STATIC_FALLBACK '+alias);
   const zeile=new RegExp("\\('"+alias+"',\\s*'"+m.fullId+"',\\s*'anthropic-api',\\s*"+m.contextWindow+",[^\\n]*'node',\\s*'@synapse/agents/api-worker',\\s*"+m.corridorMin+", "+m.corridorMax+",\\s*"+m.pricingInputUsdPerMtok.toFixed(2)+",\\s*"+m.pricingOutputUsdPerMtok.toFixed(2)+",\\s*"+m.pricingCacheUsdPerMtok.toFixed(2));
   check(zeile.test(S.SCHEMA_SQL),'Seed = STATIC_FALLBACK fuer '+alias);
   await pool.query(`INSERT INTO model_registry(alias,full_id,provider,context_window,runtime_binary,runtime_path,corridor_min,corridor_max,pricing_input_usd_per_mtok,pricing_output_usd_per_mtok,pricing_cache_usd_per_mtok,output_limit)
    VALUES($1,$2,'anthropic-api',$3,'node','@synapse/agents/api-worker',$4,$5,$6,$7,$8,$9)`,[alias,m.fullId,m.contextWindow,m.corridorMin,m.corridorMax,m.pricingInputUsdPerMtok,m.pricingOutputUsdPerMtok,m.pricingCacheUsdPerMtok,m.outputLimit]);
  }
  await pool.query(`INSERT INTO model_registry(alias,full_id,provider,context_window,runtime_binary,corridor_min,corridor_max) VALUES('api-ohnepreis','claude-x','anthropic-api',200000,'node',73,88)`);
  check(A.resolveModel('api-opus')?.binary==='node'&&A.resolveModel('opus')?.binary==='claude','resolveModel: api-opus node, opus bleibt claude-CLI');
  const R=await load('packages/agents/dist/runtime-pfad.js');
  const pfad=R.loeseRuntimePfad('@synapse/agents/api-worker',join(root,'packages/agents/dist'),{resolve:()=>{throw Error('kein Paketexport');},existsSync});
  check(pfad.endsWith(join('agents','dist','api-worker.js'))&&existsSync(pfad),'runtime-pfad findet dist/api-worker.js');
 });

 await section('B Schalter',async()=>{
  const s=await C.leseApiSchalter();
  check(s.aktiv===false&&s.api.aktiv===false&&s.api.quelle==='standard'&&s.hauptagent.aktiv===false,'Standard AUS');
  check(await err(()=>C.setzeApiSchalter(KO,{aktiv:true,grund:'Test T8 Koord'}))==='recht_fehlt','Koordinator -> recht_fehlt');
  check(await err(()=>C.setzeApiSchalter(null,{aktiv:true,grund:'Test T8 ohne'}))==='recht_fehlt','ohne Akteur -> recht_fehlt');
  check(await err(()=>C.setzeApiSchalter(USER,{aktiv:true}))==='grund_fehlt','ohne Grund -> grund_fehlt');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T8 alle'},{system:'user'});
  check((await C.leseApiFunktion()).aktiv===false,'profil_schalter alle EIN schaltet hauptagent_api nicht mit');
  const a=await C.setzeApiSchalter(USER,{aktiv:true,grund:'Test T8 api EIN'});
  check(a.api.aktiv===true&&a.api.quelle==='produkt-schalter'&&a.aktiv===false,'api EIN, hauptagent AUS -> nicht wirksam');
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T8 hauptagent EIN'});
  check((await C.leseApiSchalter()).aktiv===true,'hauptagent EIN + api EIN -> wirksam');
  const I=await load('packages/core/dist/services/intern-schalter.js');
  check(I.istSchalterName('hauptagent_api'),'intern-Override hauptagent_api registriert');
 });

 let MAIN,TOKEN;
 await section('C Budget',async()=>{
  const id=await C.stelleMainIdentitaetSicher(USER,{modell:'api-opus',runtime:'claude'});MAIN=id.identity_id;TOKEN=id.token;
  check((await C.leseApiBudget()).gesetzt===false,'ohne Budget: gesetzt false');
  check(await err(()=>C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:30,max_tokens:100}))==='budget_fehlt','ohne Budget -> budget_fehlt');
  check(await err(()=>C.setzeApiBudget(KO,{grenze_usd:1,erlaubte_modelle:['api-opus'],grund:'Test T8'}))==='recht_fehlt','Budget setzen Koordinator -> recht_fehlt');
  check(await err(()=>C.setzeApiBudget(USER,{grenze_usd:0,erlaubte_modelle:['api-opus'],grund:'Test T8'}))==='grenze_ungueltig','Grenze 0 -> grenze_ungueltig');
  check(await err(()=>C.setzeApiBudget(USER,{grenze_usd:1,zeitraum:'jahr',erlaubte_modelle:['api-opus'],grund:'Test T8'}))==='zeitraum_ungueltig','Zeitraum jahr -> zeitraum_ungueltig');
  check(await err(()=>C.setzeApiBudget(USER,{grenze_usd:1,erlaubte_modelle:['opus'],grund:'Test T8'}))==='modell_unbekannt','Abo-Modell opus ist kein API-Modell -> modell_unbekannt');
  check(await err(()=>C.setzeApiBudget(USER,{grenze_usd:1,erlaubte_modelle:['api-ohnepreis'],grund:'Test T8'}))==='preis_unbekannt','Modell ohne Preis -> preis_unbekannt');
  check(await err(()=>C.setzeApiBudget(USER,{grenze_usd:1,grund:'Test T8'}))==='erlaubte_modelle_fehlen','ohne Modelle -> erlaubte_modelle_fehlen');
  const b=await C.setzeApiBudget(USER,{grenze_usd:1,zeitraum:'monat',reset_tag:1,erlaubte_modelle:['api-opus','api-haiku'],grund:'Test T8 Budget'});
  check(b.gesetzt&&b.grenze_usd===1&&b.rest_usd===1&&b.erlaubte_modelle.length===2&&!b.erschoepft,'Budget gesetzt, Rest 1 USD');
  check(C.apiZeitraumBeginn('woche',1,new Date(2026,9,22))==='2026-10-19'&&C.apiZeitraumBeginn('tag',1,new Date(2026,9,22))==='2026-10-22'&&C.apiZeitraumBeginn('monat',15,new Date(2026,9,10))==='2026-09-15','Zeitraum-Beginn tag/woche/monat');
 });

 await section('D Reservierung',async()=>{
  const r=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:3000,max_tokens:1000});
  check(nah(r.reserviert_usd,(1000*4*1.25+1000*20)/1e6)&&r.anbieter_modell==='claude-opus-5-5'&&r.max_tokens===1000,'Reserve = Zeichen/3 x 4 x 1,25 + max_tokens x 20 ('+r.reserviert_usd+')');
  check(await err(()=>C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-sonnet',eingabe_zeichen:3,max_tokens:10}))==='modell_nicht_erlaubt','nicht erlaubtes Modell -> modell_nicht_erlaubt');
  const k=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-haiku',eingabe_zeichen:3,max_tokens:999999});
  check(k.max_tokens===32000,'max_tokens an max_tokens_obergrenze (32000) gekappt');
  await C.schliesseApiAufrufAb({reservierung_id:k.reservierung_id,agent_id:'hauptagent',usage:null,nichts_berechnet:true});
  await C.schliesseApiAufrufAb({reservierung_id:r.reservierung_id,agent_id:'hauptagent',usage:null,nichts_berechnet:true});
  // zwei gleichzeitig am letzten Rest: je 0,6 USD bei Grenze 1 -> genau eine
  const zwei=await Promise.allSettled([1,2].map(()=>C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:0,max_tokens:30000})));
  const ok=zwei.filter(x=>x.status==='fulfilled');
  check(ok.length===1&&zwei.some(x=>x.status==='rejected'&&x.reason?.code==='budget_erschoepft'),'zwei Worker am letzten Rest: genau eine Reservierung, die andere budget_erschoepft');
  const fehl=zwei.find(x=>x.status==='rejected')?.reason?.details;
  check(fehl&&nah(fehl.benoetigt_usd,0.6)&&fehl.rest_usd<0.6,'Fehlerdetails nennen benoetigt und Rest');
  // verfallen zaehlt voll
  await pool.query("UPDATE api_agent_reservierungen SET frist_bis=NOW()-interval '1 minute' WHERE id=$1",[ok[0].value.reservierung_id]);
  const b=await C.leseApiBudget();
  check(nah(b.verfallen_usd,0.6)&&b.offen_usd===0&&nah(b.rest_usd,0.4),'abgelaufene Reservierung verfaellt und zaehlt voll (Rest 0,4)');
  const st=(await pool.query('SELECT status,usd_quelle FROM api_agent_reservierungen WHERE id=$1',[ok[0].value.reservierung_id])).rows[0];
  check(st.status==='verfallen'&&st.usd_quelle==='reservierung','Status verfallen, Quelle reservierung');
  await pool.query('DELETE FROM api_agent_reservierungen');
  await C.setzeApiEinstellungen(USER,{werte:{max_tokens_obergrenze:500},grund:'Test T8 Kappung'});
  const e=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:0,max_tokens:4000});
  check(e.max_tokens===500,'Einstellwert max_tokens_obergrenze wirkt');
  await C.schliesseApiAufrufAb({reservierung_id:e.reservierung_id,agent_id:'hauptagent',usage:null,nichts_berechnet:true});
  await C.setzeApiEinstellungen(USER,{entfernen:['max_tokens_obergrenze'],grund:'Test T8 zurueck'});
 });

 await section('E Abschluss und Buchung',async()=>{
  const r=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:300,max_tokens:100});
  const u={input_tokens:1000,output_tokens:50,cache_creation_input_tokens:200,cache_read_input_tokens:300};
  const a=await C.schliesseApiAufrufAb({reservierung_id:r.reservierung_id,agent_id:'hauptagent',usage:u,stop_reason:'end_turn'});
  check(a.status==='gebucht'&&a.usd_quelle==='antwort'&&nah(a.usd,(1000*4+200*4*1.25+300*0.2+50*20)/1e6),'Kosten aus usage inkl. Cache ('+a.usd+')');
  check(nah(C.apiKostenAusUsage(u,{eingabe:4,ausgabe:20,cache_lesen:null},1.25),(1000*4+200*5+300*4+50*20)/1e6),'Cache-Lesen ohne Cachepreis = Eingabepreis');
  const v=(await pool.query("SELECT * FROM agent_verbrauch WHERE referenz=$1",['api-reservierung:'+r.reservierung_id])).rows;
  check(v.length===1&&v[0].zugang==='api'&&v[0].quelle==='api_worker'&&nah(Number(v[0].usd),a.usd)&&v[0].usd_quelle==='antwort'&&v[0].identity_id===MAIN&&v[0].modell==='claude-opus-5-5'&&Number(v[0].input_tokens)===1000,'agent_verbrauch: zugang api, USD, Tokens, Identitaet (ohne Schalter verbrauch)');
  const b=await C.schliesseApiAufrufAb({reservierung_id:r.reservierung_id,agent_id:'hauptagent',usage:{input_tokens:5,output_tokens:5}});
  check(nah(b.usd,a.usd)&&(await pool.query("SELECT count(*)::int n FROM agent_verbrauch WHERE referenz=$1",['api-reservierung:'+r.reservierung_id])).rows[0].n===1,'zweiter Abschluss idempotent');
  const r2=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:30,max_tokens:100});
  const f=await C.schliesseApiAufrufAb({reservierung_id:r2.reservierung_id,agent_id:'hauptagent',usage:null,nichts_berechnet:true,fehler:'HTTP 429'});
  check(f.status==='freigegeben'&&f.usd===0&&(await pool.query("SELECT count(*)::int n FROM agent_verbrauch WHERE referenz=$1",['api-reservierung:'+r2.reservierung_id])).rows[0].n===0,'Fehler vor Antwort: freigegeben, 0 USD, keine Buchung');
  const r3=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:30,max_tokens:100});
  const g=await C.schliesseApiAufrufAb({reservierung_id:r3.reservierung_id,agent_id:'hauptagent',usage:null,fehler:'ohne Antwort'});
  check(g.status==='gebucht'&&g.usd_quelle==='reservierung'&&nah(g.usd,r3.reserviert_usd),'ohne usage: volle Reservierung gebucht (nie kostenlos)');
  // Atomaritaet: scheitert die Verbrauchsbuchung, bleibt die Reservierung offen
  const r4=await C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-opus',eingabe_zeichen:30,max_tokens:100});
  await pool.query('ALTER TABLE agent_verbrauch RENAME TO agent_verbrauch_weg');
  const fehl=await err(()=>C.schliesseApiAufrufAb({reservierung_id:r4.reservierung_id,agent_id:'hauptagent',usage:{input_tokens:1,output_tokens:1}}));
  await pool.query('ALTER TABLE agent_verbrauch_weg RENAME TO agent_verbrauch');
  const st=(await pool.query('SELECT status FROM api_agent_reservierungen WHERE id=$1',[r4.reservierung_id])).rows[0].status;
  check(fehl!=='kein_fehler'&&st==='offen','Buchung scheitert -> Rollback, Reservierung bleibt offen');
  await C.schliesseApiAufrufAb({reservierung_id:r4.reservierung_id,agent_id:'hauptagent',usage:{input_tokens:1,output_tokens:1}});
  const k=await C.apiKostenUebersicht();
  check(k.gesamt.aufrufe===3&&k.je_agent.some(z=>z.agent_id==='hauptagent')&&k.je_modell.some(z=>z.modell==='api-opus'),'Kostenuebersicht je Agent/Modell (3 gebuchte Aufrufe)');
 });

 await section('F admin api_*',async()=>{
  const MA=akt(MAIN,HP,'main','hauptagent');
  for(const a of ['api_status','api_schalter','api_budget','api_einstellungen','api_kosten'])check(C.W1B_ADMIN_ACTIONS.includes(a),'W1B_ADMIN_ACTIONS enthaelt '+a);
  for(const p of ['api_zeitraum','erlaubte_modelle','api_einstellungen','einstellung_namen'])check(!!C.W1B_ADMIN_PARAMETER[p],'admin-Parameter '+p);
  const s=await adm('api_status',{},USER);
  check(s.success===true&&s.api_key_vorhanden===false&&s.modelle.some(m=>m.alias==='api-opus')&&!JSON.stringify(s).includes(KEY),'api_status User: Key nur ja/nein');
  check((await adm('api_status',{},MA)).success===true,'api_status Hauptagent selbst');
  check((await adm('api_status',{},KO)).error==='recht_fehlt','api_status Koordinator -> recht_fehlt');
  check((await adm('api_kosten',{},KO)).error==='recht_fehlt','api_kosten Koordinator -> recht_fehlt');
  check((await adm('api_budget',{modus:'setzen',grenze_usd:5,erlaubte_modelle:['api-opus'],grund:'Test T8 Main'},MA)).error==='recht_fehlt','api_budget setzen durch Main -> recht_fehlt');
  check((await adm('api_schalter',{modus:'setzen',aktiv:false,grund:'Test T8 Main'},MA)).error==='recht_fehlt','api_schalter setzen durch Main -> recht_fehlt');
  check((await adm('api_budget',{modus:'falsch'},USER)).error==='modus_ungueltig','unbekannter modus -> modus_ungueltig');
  const e1=await adm('api_einstellungen',{modus:'setzen',api_einstellungen:{toolrunden_max:7},grund:'Test T8 Einstellung'},USER);
  check(e1.success&&e1.einstellungen.toolrunden_max.wert===7&&e1.einstellungen.toolrunden_max.quelle==='einstellung'&&e1.einstellungen.laufzeit_minuten.quelle==='standard','Einstellwert mit Quelle');
  check((await adm('api_einstellungen',{modus:'setzen',api_einstellungen:{toolrunden_max:0},grund:'Test T8'},USER)).error==='einstellung_ungueltig','Einstellwert ausserhalb Grenzen -> einstellung_ungueltig');
  check((await adm('api_einstellungen',{modus:'setzen',api_einstellungen:{gibtsnicht:1},grund:'Test T8'},USER)).error==='einstellung_unbekannt','unbekannter Einstellwert');
  const e2=await adm('api_einstellungen',{modus:'entfernen',einstellung_namen:['toolrunden_max'],grund:'Test T8 entfernen'},USER);
  check(e2.einstellungen.toolrunden_max.wert===50&&e2.einstellungen.toolrunden_max.quelle==='standard','entfernen -> Code-Standard');
  const rahmen=await C.apiRahmenFuerAgent();
  check(rahmen.aktiv===true&&rahmen.grenzen.toolrunden_max===50&&Array.isArray(rahmen.erlaubte_modelle),'Rahmen fuer den Worker');
 });

 await section('G REST-Transport mit Fake-Anthropic',async()=>{
  const anfragen=[];let modus='tool_use';
  const basis=await server(async(req,res,body)=>{
   anfragen.push({url:req.url,headers:req.headers,body});
   if(modus==='429'){res.writeHead(429,{'content-type':'application/json','retry-after':'0','retry-after-ms':'1','x-should-retry':'false'});res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'zu viele'}}));return;}
   if(modus==='401'){res.writeHead(401,{'content-type':'application/json','x-should-retry':'false'});res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}}));return;}
   sseNachricht(res,{model:body.model,stop_reason:'tool_use',usage:{input_tokens:1000,output_tokens:50,cache_creation_input_tokens:0,cache_read_input_tokens:0},
    content:[{type:'text',text:'Ich pruefe.'},{type:'tool_use',id:'toolu_1',name:'mcp__synapse__thought',input:{action:'get'}}]});
  });
  erlaubt.add(basis);process.env.ANTHROPIC_BASE_URL=basis;
  const Fastify=requireApi('fastify');
  const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  const nutzlast={project:HP,modell:'api-opus',system:'Du bist der Hauptagent.',max_tokens:999999,
   messages:[{role:'user',content:[{type:'text',text:'Hallo'}]}],tools:[{name:'mcp__synapse__thought',description:'d',input_schema:{type:'object',properties:{}}}]};
  const post=(p=nutzlast,ausweis=TOKEN)=>f.inject({method:'POST',url:'/api/agent-api/messages',headers:ausweis?{'x-synapse-agent-token':ausweis}:{},payload:p});
  const anzahl=async()=>(await pool.query('SELECT count(*)::int n FROM api_agent_reservierungen')).rows[0].n;
  const vorher=await anzahl();
  let r=await post();
  check(r.statusCode===503&&r.json().error.code==='api_zugang_fehlt'&&await anzahl()===vorher&&anfragen.length===0,'ohne Key: api_zugang_fehlt, keine Reservierung, kein Anbieteraufruf');
  process.env.SYNAPSE_ANTHROPIC_API_KEY=KEY;
  r=await post();
  const j=r.json();
  check(r.statusCode===200&&j.success===true&&j.message.stop_reason==='tool_use'&&j.message.content.some(b=>b.type==='tool_use'&&b.input.action==='get'),'Antwort mit tool_use durchgereicht ('+r.statusCode+')');
  check(anfragen.length===1&&anfragen[0].url.startsWith('/v1/messages')&&anfragen[0].headers['x-api-key']===KEY&&anfragen[0].headers['anthropic-version']==='2023-06-01','Anbieter bekommt x-api-key + anthropic-version 2023-06-01');
  check(anfragen[0].body.model==='claude-opus-5-5'&&anfragen[0].body.max_tokens===32000&&anfragen[0].body.stream===true&&anfragen[0].body.tools[0].name==='mcp__synapse__thought'&&anfragen[0].body.system==='Du bist der Hauptagent.','Alias -> Anbieter-Modell, max_tokens gekappt, Strom, Tools/System');
  check(nah(j.kosten.usd,(1000*4+50*20)/1e6)&&j.kosten.usd_quelle==='antwort'&&typeof j.rest_usd==='number','Kosten + Rest in der Antwort');
  check(!r.body.includes(KEY),'Key nie in der Antwort');
  check((await pool.query("SELECT count(*)::int n FROM agent_verbrauch WHERE quelle='api_worker' AND usd IS NOT NULL")).rows[0].n>=4,'Transport bucht in agent_verbrauch');
  modus='429';r=await post();
  check(r.statusCode===503&&r.json().error.code==='ueberlastet','429 -> ueberlastet');
  check((await pool.query("SELECT status FROM api_agent_reservierungen ORDER BY erstellt_am DESC LIMIT 1")).rows[0].status==='freigegeben','429: Reservierung freigegeben (nichts berechnet)');
  modus='401';r=await post();
  check(r.statusCode===502&&r.json().error.code==='api_zugang_ungueltig'&&!r.body.includes(KEY),'401 -> api_zugang_ungueltig, ohne Key');
  modus='tool_use';
  r=await post(nutzlast,'sai_gibtsnicht');
  check(r.statusCode===401&&r.json().error.code==='ausweis_ungueltig','fremder Ausweis -> ausweis_ungueltig');
  r=await post(nutzlast,null);
  check(r.statusCode===401&&r.json().error.code==='ausweis_fehlt','ohne Ausweis -> ausweis_fehlt');
  r=await post({...nutzlast,messages:[{role:'system',content:[]}]});
  check(r.statusCode===400&&r.json().error.code==='messages_ungueltig','ungueltige messages -> 400');
  const n0=anfragen.length;
  await C.setzeApiSchalter(USER,{aktiv:false,grund:'Test T8 AUS'});
  r=await post();
  check(r.statusCode===409&&r.json().error.code==='funktion_aus'&&anfragen.length===n0,'Schalter AUS: funktion_aus, kein Anbieteraufruf');
  await C.setzeApiSchalter(USER,{aktiv:true,grund:'Test T8 EIN'});
  r=await post({...nutzlast,modell:'api-sonnet'});
  check(r.statusCode===400&&r.json().error.code==='modell_nicht_erlaubt'&&anfragen.length===n0,'nicht erlaubtes Modell: kein Anbieteraufruf, kein Ersatzmodell');
  const ra=await f.inject({method:'GET',url:'/api/agent-api/rahmen?project='+encodeURIComponent(HP),headers:{'x-synapse-agent-token':TOKEN}});
  check(ra.statusCode===200&&ra.json().grenzen.toolrunden_max===50,'GET /api/agent-api/rahmen');
  const st=await f.inject({method:'GET',url:'/api/main-agent/api'});
  check(st.statusCode===200&&st.json().api_key_vorhanden===true&&!st.body.includes(KEY),'User-Status: Key vorhanden, Wert nie sichtbar');
  const M=await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  const scope=M.hauptagentIdentitaetScope(MAIN);
  check(M.mainScopePasst(scope,'POST','/api/agent-api/messages',{'x-synapse-agent-token':TOKEN})===true&&M.mainScopePasst(scope,'GET','/api/agent-api/rahmen',{'x-synapse-agent-token':TOKEN})===true,'Identitaets-Bearer darf den Transport (mit Ausweis)');
  check(M.mainScopePasst(scope,'POST','/api/agent-api/messages',{})===false&&M.mainScopePasst(scope,'GET','/api/main-agent/api',{'x-synapse-agent-token':TOKEN})===false,'ohne Ausweis bzw. User-Route: gesperrt');
  delete process.env.SYNAPSE_ANTHROPIC_API_KEY;
 });

 await section('H Worker',async()=>{
  const T=await load('packages/agents/dist/api-worker/toolschleife.js');
  const V=await load('packages/agents/dist/api-worker/verlauf.js');
  const A=await load('packages/agents/dist/api-worker/anbieter-anthropic.js');
  const H=await load('packages/agents/dist/api-worker/mcp-http-client.js');
  const tmp=await mkdtemp(join(tmpdir(),'p22-t8-'));aufraeumen.push(()=>rm(tmp,{recursive:true,force:true}));
  const speicher=()=>{const l=[];const vm=[];return {l,vm,nachrichten:()=>l,fuegeHinzu:async n=>{l.push(n);},vermerkeAufruf:async a=>{vm.push(a.id);}};};
  const adapter=antworten=>({name:'fake',aufrufe:0,async rufe(){const a=antworten[this.aufrufe++];if(a instanceof Error)throw a;return a;}});
  const nutz={input:10,output:2,cache_read:0,cache_creation:0};
  const werkzeug=(id,name='mcp__synapse__thought')=>({typ:'werkzeug_aufruf',id,name,eingabe:{x:id}});
  const ausf={rufe:async(name,e)=>({inhalt:[{typ:'text',text:'ok '+e.x}],fehler:false})};
  // zwei Runden (parallel), pause_turn, dann Ende
  let v=speicher();
  let ad=adapter([
   {inhalt:[{typ:'text',text:'A'},werkzeug('t1'),werkzeug('t2')],stop:'werkzeug',stop_roh:'tool_use',nutzung:nutz,kosten_usd:0.1},
   {inhalt:[{typ:'roh',anbieter:'anthropic',block:{type:'thinking',thinking:'',signature:'s'}}],stop:'pause',stop_roh:'pause_turn',nutzung:nutz},
   {inhalt:[werkzeug('t3')],stop:'werkzeug',stop_roh:'tool_use',nutzung:nutz,kosten_usd:0.2},
   {inhalt:[{typ:'text',text:'Fertig'}],stop:'ende',stop_roh:'end_turn',nutzung:nutz},
  ]);
  let e=await T.fuehreNachrichtAus({adapter:ad,werkzeuge:[],ausfuehrer:ausf,verlauf:v,system:'s',max_tokens:100,grenzen:{toolrunden_max:5,laufzeit_ms:60000}});
  check(e.ende==='fertig'&&e.runden===2&&ad.aufrufe===4&&e.text.includes('A')&&e.text.includes('Fertig')&&nah(e.kosten_usd,0.3),'Schleife: 2 Toolrunden + pause_turn bis end_turn');
  const erg=v.l[1];
  check(erg.rolle==='user'&&erg.inhalt.length===2&&erg.inhalt.every(b=>b.typ==='werkzeug_ergebnis')&&erg.inhalt[0].aufruf_id==='t1','parallele Ergebnisse in EINER user-Nachricht');
  check(v.vm.join(',')==='t1,t2,t3','jeder Aufruf VOR der Ausfuehrung vermerkt');
  // Grenze Toolrunden: Verlauf bleibt gueltig
  v=speicher();ad=adapter([{inhalt:[werkzeug('g1')],stop:'werkzeug',nutzung:nutz},{inhalt:[werkzeug('g2')],stop:'werkzeug',nutzung:nutz}]);
  e=await T.fuehreNachrichtAus({adapter:ad,werkzeuge:[],ausfuehrer:ausf,verlauf:v,system:'s',max_tokens:100,grenzen:{toolrunden_max:1,laufzeit_ms:60000}});
  check(e.ende==='grenze_toolrunden'&&/Nicht fertig/.test(e.meldung)&&v.l[v.l.length-1].rolle==='user'&&ad.aufrufe===1,'Toolrunden-Grenze: ausdrueckliche Meldung, letzter Eintrag = Ergebnisse');
  // Laufzeit
  let uhr=0;ad=adapter([{inhalt:[werkzeug('l1')],stop:'werkzeug',nutzung:nutz}]);
  e=await T.fuehreNachrichtAus({adapter:ad,werkzeuge:[],ausfuehrer:{rufe:async()=>{uhr+=120000;return {inhalt:[],fehler:false};}},verlauf:speicher(),system:'s',max_tokens:100,grenzen:{toolrunden_max:9,laufzeit_ms:60000},jetzt:()=>uhr});
  check(e.ende==='grenze_laufzeit'&&/Laufzeitgrenze/.test(e.meldung),'Laufzeit-Grenze');
  for(const [stop,ende] of [['max_tokens','max_tokens'],['abgelehnt','abgelehnt'],['kontext_voll','kontext_voll']]){
   e=await T.fuehreNachrichtAus({adapter:adapter([{inhalt:[{typ:'text',text:'x'}],stop,nutzung:nutz}]),werkzeuge:[],ausfuehrer:ausf,verlauf:speicher(),system:'s',max_tokens:100,grenzen:{toolrunden_max:9,laufzeit_ms:60000}});
   check(e.ende===ende&&typeof e.meldung==='string'&&e.meldung.length>10,'Stop '+stop+' -> ausdrueckliche Meldung');
  }
  e=await T.fuehreNachrichtAus({adapter:adapter([new T.AnbieterFehler('budget_erschoepft','Budget erreicht')]),werkzeuge:[],ausfuehrer:ausf,verlauf:speicher(),system:'s',max_tokens:100,grenzen:{toolrunden_max:9,laufzeit_ms:60000}});
  check(e.ende==='anbieter_fehler'&&e.meldung.includes('budget_erschoepft'),'Anbieterfehler: kein Ersatz, Code in der Meldung');
  const fehlAusf={rufe:async()=>{throw Error('MCP weg');}};
  v=speicher();e=await T.fuehreNachrichtAus({adapter:adapter([{inhalt:[werkzeug('f1')],stop:'werkzeug',nutzung:nutz},{inhalt:[{typ:'text',text:'ok'}],stop:'ende',nutzung:nutz}]),werkzeuge:[],ausfuehrer:fehlAusf,verlauf:v,system:'s',max_tokens:100,grenzen:{toolrunden_max:9,laufzeit_ms:60000}});
  check(v.l[1].inhalt[0].fehler===true&&v.l[1].inhalt[0].inhalt[0].text.includes('MCP weg')&&e.ende==='fertig','Werkzeugfehler -> tool_result is_error, Schleife laeuft weiter');
  // Verlauf: Neustart wiederholt keinen offenen Aufruf
  const datei=join(tmp,'.synapse','agents','w','api-verlauf-s1.jsonl');
  const v1=await V.DateiVerlauf.oeffne(datei);
  await v1.fuegeHinzu({rolle:'user',inhalt:[{typ:'text',text:'hi'}]});
  await v1.fuegeHinzu({rolle:'assistant',inhalt:[werkzeug('r1')]});
  await v1.vermerkeAufruf(werkzeug('r1'));
  const v2=await V.DateiVerlauf.oeffne(datei);
  const letzte=v2.nachrichten()[v2.nachrichten().length-1];
  check(v2.nachrichten().length===3&&letzte.rolle==='user'&&letzte.inhalt[0].typ==='werkzeug_ergebnis'&&letzte.inhalt[0].fehler===true&&letzte.inhalt[0].inhalt[0].text.includes('NICHT wiederholt'),'Neustart: offener Aufruf bekommt Fehler-Ergebnis statt Wiederholung');
  const v3=await V.DateiVerlauf.oeffne(datei);
  check(v3.nachrichten().length===3,'erneutes Oeffnen repariert nichts doppelt');
  // Anthropic-Format
  const verlauf=[{rolle:'user',inhalt:[{typ:'text',text:'q'},{typ:'bild',media_type:'image/png',daten:'AAAA'}]},
   {rolle:'assistant',inhalt:[{typ:'roh',anbieter:'anthropic',block:{type:'thinking',thinking:'',signature:'sig'}},werkzeug('a1')]},
   {rolle:'user',inhalt:[{typ:'werkzeug_ergebnis',aufruf_id:'a1',fehler:true,inhalt:[{typ:'text',text:'kaputt'},{typ:'bild',media_type:'image/png',daten:'BB'}]}]},
   {rolle:'assistant',inhalt:[{typ:'roh',anbieter:'free-pool',block:{type:'x'}}]}];
  const an=A.nachAnthropic(verlauf);
  check(an.length===3&&an[0].content[1].type==='image'&&an[1].content[0].type==='thinking'&&an[1].content[0].signature==='sig'&&an[1].content[1].type==='tool_use','nachAnthropic: Bild, thinking unveraendert, tool_use; fremde Rohbloecke weg');
  check(an[2].content[0].type==='tool_result'&&an[2].content[0].is_error===true&&an[2].content[0].tool_use_id==='a1'&&an[2].content[0].content[1].type==='image','tool_result mit is_error und Bild');
  const zurueck=A.vonAnthropic([{type:'text',text:'t'},{type:'tool_use',id:'u',name:'n',input:{a:1}},{type:'thinking',thinking:'',signature:'z'}]);
  check(zurueck[0].typ==='text'&&zurueck[1].typ==='werkzeug_aufruf'&&zurueck[2].typ==='roh'&&zurueck[2].block.signature==='z','vonAnthropic inkl. thinking als roh');
  check(['end_turn','tool_use','pause_turn','max_tokens','refusal','model_context_window_exceeded','stop_sequence','neu'].map(A.stopAusAnthropic).join()==='ende,werkzeug,pause,max_tokens,abgelehnt,kontext_voll,ende,sonstig','stop_reason-Zuordnung');
  // Adapter ueber den Synapse-Transport
  const zugang={mcpUrl:'http://fake/mcp/messages',apiBasis:'http://fake',kopf:{Authorization:'Bearer B','x-synapse-agent-token':'sai_testwert'}};
  let gesehen=null;
  const holenOk=async(u,o)=>{gesehen={u,o,body:JSON.parse(o.body)};return new Response(JSON.stringify({success:true,message:{content:[{type:'text',text:'hi'}],stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:3}},kosten:{usd:0.01},rest_usd:0.5}),{status:200});};
  const ant=await new A.AnthropicUeberSynapse(zugang,{project:HP,modell:'api-opus'},holenOk).rufe({system:'s',verlauf,werkzeuge:[{name:'mcp__synapse__chat',beschreibung:'c',schema:{type:'object'}}],max_tokens:77});
  check(gesehen.u==='http://fake/api/agent-api/messages'&&gesehen.o.headers['x-synapse-agent-token']==='sai_testwert'&&gesehen.body.modell==='api-opus'&&gesehen.body.max_tokens===77&&gesehen.body.tools[0].input_schema.type==='object','Adapter ruft nur den Synapse-Transport (Ausweis, Alias, Tools)');
  check(!JSON.stringify(gesehen).toLowerCase().includes('x-api-key'),'Adapter sendet keinen Anbieter-Key');
  check(ant.stop==='ende'&&ant.nutzung.input===5&&ant.kosten_usd===0.01&&ant.rest_usd===0.5,'Adapter-Antwort normalisiert');
  const holenFehl=async()=>new Response(JSON.stringify({success:false,error:{code:'budget_erschoepft',message:'b',details:{rest_usd:0}}}),{status:402});
  check(await err(()=>new A.AnthropicUeberSynapse(zugang,{project:HP,modell:'api-opus'},holenFehl).rufe({system:'',verlauf,werkzeuge:[],max_tokens:1}))==='budget_erschoepft','Transportfehler -> AnbieterFehler mit Code');
  // MCP-Client: JSON und SSE
  const holenMcp=async(u,o)=>{const b=JSON.parse(o.body);
   if(b.method==='tools/list')return new Response(JSON.stringify({jsonrpc:'2.0',id:b.id,result:{tools:[{name:'thought',description:'T',inputSchema:{type:'object',properties:{a:{type:'string'}}}}]}}),{status:200});
   return new Response('event: message\ndata: '+JSON.stringify({jsonrpc:'2.0',id:b.id,result:{isError:b.params.name==='kaputt',content:[{type:'text',text:'name='+b.params.name},{type:'image',data:'QQ',mimeType:'image/png'}]}})+'\n\n',{status:200,headers:{'content-type':'text/event-stream'}});};
  const mc=new H.McpHttpClient(zugang,holenMcp);
  const tools=await mc.listeWerkzeuge();
  check(tools.length===1&&tools[0].name==='mcp__synapse__thought'&&tools[0].schema.properties.a,'tools/list mit Praefix und Schema');
  const rc=await mc.rufe('mcp__synapse__thought',{a:'1'});
  check(rc.fehler===false&&rc.inhalt[0].text==='name=thought'&&rc.inhalt[1].typ==='bild','tools/call: Praefix entfernt, SSE gelesen, Bild uebernommen');
  check((await mc.rufe('kaputt',{})).fehler===true,'isError -> fehler');
  const cfg=join(tmp,'mcp-http.json');
  await writeFile(cfg,JSON.stringify({mcpServers:{synapse:{type:'http',url:'http://h:9/mcp/messages',headers:{Authorization:'Bearer BB','x-synapse-agent-token':'${SYNAPSE_AGENT_TOKEN}'}}}}));
  const z=await H.leseSynapseZugang({SYNAPSE_MCP_CONFIG_FILE:cfg,SYNAPSE_AGENT_TOKEN:'sai_ausenv'});
  check(z.mcpUrl==='http://h:9/mcp/messages'&&z.apiBasis==='http://h:9'&&z.kopf['x-synapse-agent-token']==='sai_ausenv'&&z.kopf.Authorization==='Bearer BB','Zugang aus mcp-http.json, ${SYNAPSE_AGENT_TOKEN} ersetzt');
  check(await err(()=>H.leseSynapseZugang({}))!=='kein_fehler','ohne Bruecke und ohne API-Zugang: lauter Fehler, kein Direktweg');

  // Prozess end-to-end gegen Fake-Synapse
  const log={transport:[],mcp:[]};
  const fake=await server(async(req,res,body)=>{
   const json=(s,d)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(d));};
   if(req.url==='/mcp/messages'){log.mcp.push({body,headers:req.headers});
    if(body.method==='tools/list')return json(200,{jsonrpc:'2.0',id:body.id,result:{tools:[{name:'chat',description:'c',inputSchema:{type:'object'}},{name:'thought',description:'t',inputSchema:{type:'object'}}]}});
    const name=body.params.name;
    return json(200,{jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:name==='chat'?'REGELN-R1 Profil':'gespeichert'}]}});}
   if(req.url.startsWith('/api/agent-api/rahmen'))return json(200,{success:true,aktiv:true,grenzen:{toolrunden_max:5,laufzeit_minuten:5,max_tokens_obergrenze:1000}});
   if(req.url==='/api/agent-api/messages'){log.transport.push({body,headers:req.headers});
    if(log.transport.length===1)return json(200,{success:true,message:{content:[{type:'tool_use',id:'tu1',name:'mcp__synapse__thought',input:{action:'add'}}],stop_reason:'tool_use',usage:{input_tokens:100,output_tokens:10}},kosten:{usd:0.001},rest_usd:1});
    return json(200,{success:true,message:{content:[{type:'text',text:'Erledigt.'}],stop_reason:'end_turn',usage:{input_tokens:150,output_tokens:5}},kosten:{usd:0.002},rest_usd:0.99});}
   json(404,{});
  });
  const home=await mkdtemp(join(tmpdir(),'p22-t8-home-'));aufraeumen.push(()=>rm(home,{recursive:true,force:true}));
  const projekt=join(tmp,'projekt');const promptDatei=join(tmp,'prompt.txt');await writeFile(promptDatei,'SYSTEMPROMPT-W');
  const kind=spawn(process.execPath,[join(root,'packages/agents/dist/api-worker.js')],{cwd:tmp,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:home,
   SYNAPSE_WRAPPER_MODE:'1',SYNAPSE_AGENT_NAME:'hauptagent',SYNAPSE_AGENT_MODEL:'api-opus',SYNAPSE_PROJECT_PATH:projekt,SYNAPSE_PROJECT_NAME:HP,
   SYNAPSE_SYSTEM_PROMPT_FILE:promptDatei,SYNAPSE_SESSION_ID:'sess-e2e',SYNAPSE_AGENT_TOKEN:'sai_e2ewert',SYNAPSE_API_URL:fake,SYNAPSE_API_TOKEN:'bearer-e2e'}});
  let aus='',fehlerAus='';kind.stdout.on('data',d=>{aus+=d;});kind.stderr.on('data',d=>{fehlerAus+=d;});
  const zeilen=()=>aus.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return {roh:l};}});
  const warte=async(pred,ms=20000)=>{const ende=Date.now()+ms;while(Date.now()<ende){if(pred())return true;await new Promise(r=>setTimeout(r,50));}return false;};
  check(await warte(()=>zeilen().some(z=>z.type==='system'&&z.subtype==='init')),'Worker: init-Ereignis');
  kind.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'Bitte speichern'}]}})+'\n');
  const fertig=await warte(()=>zeilen().some(z=>z.type==='result'));
  kind.stdin.end();await new Promise(r=>{kind.once('exit',r);setTimeout(()=>{kind.kill('SIGKILL');r();},5000);});
  const res=zeilen().find(z=>z.type==='result');
  check(fertig&&res?.ende==='fertig'&&res.result.includes('Erledigt.')&&nah(res.kosten_usd,0.003),'Worker: result fertig mit Kosten ('+mask(fehlerAus.slice(-300))+')');
  check(zeilen().some(z=>z.type==='assistant'&&JSON.stringify(z).includes('Erledigt.')),'Worker: assistant-Text auf stdout');
  check(log.transport.length===2&&log.transport.every(t=>t.headers['x-synapse-agent-token']==='sai_e2ewert'&&t.headers.authorization==='Bearer bearer-e2e'&&t.body.modell==='api-opus'&&t.body.max_tokens===1000),'Worker: zwei Transport-Aufrufe mit Ausweis, Alias, gekapptem max_tokens');
  const zweite=log.transport[1]?.body;
  check(zweite&&zweite.system.includes('SYSTEMPROMPT-W')&&zweite.system.includes('REGELN-R1')&&zweite.tools.map(t=>t.name).join()==='mcp__synapse__chat,mcp__synapse__thought','Worker: Persona aus Prompt-Datei + Anmeldung, nur Synapse-Werkzeuge');
  const tr=zweite?.messages?.[zweite.messages.length-1];
  check(tr?.role==='user'&&tr.content[0].type==='tool_result'&&tr.content[0].tool_use_id==='tu1','Worker: Werkzeugergebnis an den Anbieter zurueck');
  const mcpCalls=log.mcp.filter(m=>m.body.method==='tools/call');
  check(mcpCalls.length===2&&mcpCalls[0].body.params.name==='chat'&&mcpCalls[0].body.params.arguments.action==='anmelden'&&mcpCalls[1].body.params.name==='thought','Worker: chat anmelden + genau ein Werkzeugaufruf');
  const vDatei=join(projekt,'.synapse','agents','hauptagent','api-verlauf-sess-e2e.jsonl');
  check(existsSync(vDatei)&&(await readFile(vDatei,'utf8')).includes('"art":"aufruf"'),'Worker: Verlauf mit Aufruf-Vermerk');
  const jdir=join(home,'.claude','projects',projekt.replace(/\//g,'-'));
  check(existsSync(join(jdir,'sess-e2e.jsonl'))&&(await readFile(join(jdir,'sess-e2e.jsonl'),'utf8')).includes('"input_tokens":150'),'Worker: Token-JSONL fuer den Wrapper');
  check(!aus.includes('sk-ant'),'Worker-Ausgabe ohne Anbieter-Key');
  void readdir;
 });

 check(network===0,'keine Netzwerkaufrufe ausser Fake ('+network+')');
 console.log('P22-T8: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const f of aufraeumen.reverse())await Promise.resolve().then(f).catch(()=>undefined);
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
