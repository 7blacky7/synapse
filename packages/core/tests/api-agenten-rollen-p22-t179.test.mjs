/**
 * P22-T179 (Teil P22-T106): kostenpflichtiger API-Agent als ARBEITSAGENT (rolle subagent) und als KOORDINATOR - Freigabe je Identitaet.
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/api-agenten-rollen-p22-t179.test.mjs
 * WARUM: User 26.10.2026 ~01:35 "ob sie als Arbeitsagenten oder Koordinator-Agenten ebenso eingesetzt werden koennen"; Grundsatz P22-T106
 *   (User 24.10.): kostenpflichtig NUR auf ausdruecklichen Wunsch (User selbst oder Main mit user_auftrag), nie automatisch; jede Buchung je
 *   Agent sichtbar; Heartbeat Standard AUS. Ist-Analyse/Vorschlag thought 04de2775.
 * NUR synapse_test:5433, eigenes privates Schema, Fake-Anthropic (lokaler SSE-Server ueber ANTHROPIC_BASE_URL), KEIN echter Key,
 * kein externes Netz (Zaehler network = 0). Kein Heartbeat, keine echten Agentenprozesse.
 * Geprueft (Quelldateien):
 *   A core db/api-agent-freigaben-schema.ts + schema-sql/161 (2x idempotent, in SCHEMA_SQL), agent-profil-schalter.ts api_agenten
 *     (Katalog, nur ausdruecklich: 'alle' schaltet es nicht)
 *   B core services/api-agent-freigabe.ts setzeApiFreigabe/entferneApiFreigabe: Rechte (User; Main nur mit user_auftrag; Koordinator und
 *     Agent selbst nie), Schalter AUS, Ziel Main/unbekannt, Modelle/Preis/Grenze
 *   C core services/api-agent-dienst.ts reserviereApiAufruf zugang 'agent': Funktion api, Schalter, Freigabe, Modell, eigene Grenze vor
 *     globalem Rest; Main-Weg (zugang main) unveraendert
 *   D rest-api routes/agent-api.ts Transport mit Fake-Anthropic fuer Arbeitsagent UND Koordinator: Schalter AUS = Bestand nur_hauptagent,
 *     ohne Freigabe kein Anbieteraufruf, mit Freigabe 200 + Buchung je Identitaet (agent_verbrauch, je_agent), Rahmen je Agent,
 *     main-tool-profile.ts mainScopePasst fuer agent:identitaet:
 *   E core services/hauptagent-lauf.ts heartbeatBeimSpawnFuerZiel: API-Agent Standard AUS, Freigabe heartbeat true -> EIN, ohne Freigabe
 *     bzw. Schalter AUS = Bestand (an)
 *   F admin api_freigabe (W1B-Dispatcher, api-agent-dienst.ts), apiAgentStatus.agenten; REST /api/main-agent/api/freigaben (User)
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
 'SYNAPSE_HAUPTAGENT_API','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_ANTHROPIC_API_KEY','SYNAPSE_ANTHROPIC_WORKSPACE_ID','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','SYNAPSE_VERBRAUCH'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Netz: nur der lokale Fake-Anthropic ist erlaubt; jeder andere Aufruf zaehlt als Verstoss.
let network=0;const erlaubt=new Set();const echtesFetch=globalThis.fetch;
globalThis.fetch=async(ziel,opt)=>{const u=String(ziel?.url??ziel);if([...erlaubt].some(b=>u.startsWith(b)))return echtesFetch(ziel,opt);network++;throw Error('Testnetz gesperrt: '+u);};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t179_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t179-projekt';
const KEY='sk-ant-test-GEHEIM-p22t179-0123456789';
const failures=[];let core,pool,checks=0;const aufraeumen=[];
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]').split(KEY).join('[KEY]');
// Herkunft im Label (regel-tests-mit-herkunft-kommentieren); Fehlschlag: DEBUG mit tatsaechlichem Wert.
function check(ok,label,info){checks++;if(ok)return;failures.push(label);console.error('FAIL '+label+(info!==undefined?' | DEBUG tatsaechlich: '+mask(JSON.stringify(info)).slice(0,600):''));}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

/** Fake-Anthropic: POST /v1/messages als SSE-Strom (wie P22-T8). */
function sseNachricht(res,{content,stop_reason,usage,model}){
 res.writeHead(200,{'content-type':'text/event-stream'});
 const ev=(t,d)=>res.write('event: '+t+'\ndata: '+JSON.stringify({type:t,...d})+'\n\n');
 ev('message_start',{message:{id:'msg_t179',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
  usage:{input_tokens:usage.input_tokens,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
 content.forEach((b,i)=>{ev('content_block_start',{index:i,content_block:{type:'text',text:''}});ev('content_block_delta',{index:i,delta:{type:'text_delta',text:b.text}});ev('content_block_stop',{index:i});});
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema',
  'hauptagent-verlauf-schema','main-warteschlange-schema','agent-verbrauch-schema','agent-api-budget-schema','api-agent-schluessel-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 // API-Modelle wie der Seed in schema.ts (P22-T8), nur im privaten Schema.
 await pool.query(`INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max,
   pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit) VALUES
  ('api-sonnet','claude-sonnet-5-5','anthropic-api',1000000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',80,97,2.00,10.00,0.20,'2026-06-01',128000),
  ('api-haiku','claude-haiku-4-5-20251001','anthropic-api',200000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',73,88,1.00,5.00,0.10,'2025-02-28',64000)
  ON CONFLICT (alias) DO NOTHING`);
 const C=core,USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT;
 const akt=(id,project,rolle,agent=id)=>({art:'identitaet',principal:{art:'identity',project,agent_id:agent,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 // Ausweis-Kern EIN wie P22-T8 ('alle' schaltet api_agenten NICHT mit - nur ausdruecklich).
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T179 alle'},{system:'user'});
 const vor=(name,rolle)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name,rolle,grund:'Test T179 '+name},USER);
 const W=await vor('t179-arbeit','subagent');
 const K=await vor('t179-koord','koordinator');
 const MAIN='t179-main';
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,'hauptagent',1,'hauptagent','main','test')",[MAIN,HP]);
 const MA=akt(MAIN,HP,'main','hauptagent'),KO=akt(K.identity_id,P,'koordinator',K.agent_id),WA=akt(W.identity_id,P,'subagent',W.agent_id);
 const schalterAgenten=aktiv=>C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten',aktiv,grund:'Test T179 api_agenten '+(aktiv?'EIN':'AUS')},{system:'user'});

 await section('A Schema 161 und Schalter api_agenten',async()=>{
  const M=await load('packages/core/dist/db/api-agent-freigaben-schema.js');
  await pool.query(M.API_AGENT_FREIGABEN_SCHEMA_SQL);await pool.query(M.API_AGENT_FREIGABEN_SCHEMA_SQL);
  check((await pool.query('SELECT to_regclass($1) r',[schema+'.api_agent_freigaben'])).rows[0].r!==null,'P22-T179 db/api-agent-freigaben-schema.ts: Tabelle api_agent_freigaben (2x idempotent)');
  const sqlDatei=await readFile(join(repo,'packages/core/src/db/schema-sql/161_api_agent_freigaben.sql'),'utf8');
  check(M.API_AGENT_FREIGABEN_SCHEMA_SQL.includes(sqlDatei.trim().split('\n').slice(-3).join('\n')),'P22-T179 schema-sql/161 = Spiegel api-agent-freigaben-schema.ts');
  const schemaJs=await readFile(join(repo,'packages/core/dist/db/schema.js'),'utf8');
  check(/\$\{API_AGENT_FREIGABEN_SCHEMA_SQL\}/.test(schemaJs),'P22-T179 db/schema.ts: SCHEMA_SQL haengt 161 ein');
  const S=await load('packages/core/dist/services/agent-profil-schalter.js');
  check(S.PROFIL_PRODUKT_FUNKTIONEN.includes('api_agenten')&&S.NUR_AUSDRUECKLICH.includes('api_agenten'),'P22-T179 agent-profil-schalter.ts: api_agenten im Katalog, nur ausdruecklich');
  const s=await C.leseApiAgentenSchalter(P);
  check(s.aktiv===false,'P22-T179 api-agent-freigabe.ts leseApiAgentenSchalter: Standard AUS, alle EIN schaltet es nicht mit',s);
 });

 await section('B Freigabe setzen: Rechte und Pruefungen',async()=>{
  const e={identity_id:W.identity_id,modelle:['api-haiku'],grenze_usd:0.01,grund:'Test T179 Arbeitsagent'};
  check(await err(()=>C.setzeApiFreigabe(USER,e))==='funktion_aus','P22-T179 setzeApiFreigabe: Schalter api_agenten AUS -> funktion_aus');
  await schalterAgenten(true);
  check(await err(()=>C.setzeApiFreigabe(KO,e))==='recht_fehlt','P22-T179 setzeApiFreigabe: Koordinator -> recht_fehlt (nie automatisch durch Koordinator)');
  check(await err(()=>C.setzeApiFreigabe(WA,e))==='recht_fehlt','P22-T179 setzeApiFreigabe: Agent fuer sich selbst -> recht_fehlt');
  check(await err(()=>C.setzeApiFreigabe(null,e))==='recht_fehlt','P22-T179 setzeApiFreigabe: ohne Akteur -> recht_fehlt');
  check(await err(()=>C.setzeApiFreigabe(MA,e))==='user_auftrag_fehlt','P22-T179 setzeApiFreigabe: Main ohne user_auftrag -> user_auftrag_fehlt');
  check(await err(()=>C.setzeApiFreigabe(USER,{...e,identity_id:MAIN}))==='rolle_nicht_zugelassen','P22-T179 setzeApiFreigabe: Ziel Main -> rolle_nicht_zugelassen (eigener Weg)');
  check(await err(()=>C.setzeApiFreigabe(USER,{...e,identity_id:'gibtsnicht'}))==='identitaet_unbekannt','P22-T179 setzeApiFreigabe: unbekannte Identitaet');
  check(await err(()=>C.setzeApiFreigabe(USER,{...e,modelle:['haiku']}))==='modell_unbekannt','P22-T179 setzeApiFreigabe: Abo-Modell ist kein API-Modell');
  check(await err(()=>C.setzeApiFreigabe(USER,{...e,modelle:[]}))==='erlaubte_modelle_fehlen','P22-T179 setzeApiFreigabe: ohne Modelle');
  check(await err(()=>C.setzeApiFreigabe(USER,{...e,grenze_usd:0}))==='grenze_ungueltig','P22-T179 setzeApiFreigabe: Grenze 0');
  check(await err(()=>C.setzeApiFreigabe(USER,{...e,grund:''}))==='grund_fehlt','P22-T179 setzeApiFreigabe: ohne Grund');
  const fw=await C.setzeApiFreigabe(USER,e);
  check(fw.aktiv&&fw.gesetzt_von==='user'&&fw.modelle.join()==='api-haiku'&&fw.grenze_usd===0.01&&fw.heartbeat===false&&fw.rolle==='subagent','P22-T179 setzeApiFreigabe: User setzt Arbeitsagent (Heartbeat Standard AUS)',fw);
  const fk=await C.setzeApiFreigabe(MA,{identity_id:K.identity_id,modelle:['api-haiku'],grund:'Test T179 Koordinator',user_auftrag:'User: Koordinator darf per Haiku-API arbeiten'});
  check(fk.gesetzt_von==='main'&&fk.user_auftrag.startsWith('User:')&&fk.rolle==='koordinator'&&fk.grenze_usd===null,'P22-T179 setzeApiFreigabe: Main mit user_auftrag setzt Koordinator',fk);
  check(await err(()=>C.entferneApiFreigabe(KO,{identity_id:K.identity_id,grund:'x'}))==='recht_fehlt','P22-T179 entferneApiFreigabe: Koordinator -> recht_fehlt');
 });

 await section('C Reservierung zugang agent (Gate unter der Budgetsperre)',async()=>{
  const r=(o={})=>C.reserviereApiAufruf({identity_id:W.identity_id,project:P,agent_id:W.agent_id,modell:'api-haiku',eingabe_zeichen:300,max_tokens:500,zugang:'agent',...o});
  check(await err(()=>r())==='funktion_aus','P22-T179 reserviereApiAufruf agent: Funktion api AUS -> funktion_aus');
  await C.setzeApiSchalter(USER,{aktiv:true,grund:'Test T179 api EIN'});
  check(await err(()=>r())==='budget_fehlt','P22-T179 reserviereApiAufruf agent: ohne globales Budget -> budget_fehlt (hauptagent AUS ist fuer Agenten egal)');
  await C.setzeApiBudget(USER,{grenze_usd:5,zeitraum:'monat',reset_tag:1,erlaubte_modelle:['api-haiku','api-sonnet'],grund:'Test T179 Budget'});
  check(await err(()=>C.reserviereApiAufruf({identity_id:MAIN,project:HP,agent_id:'hauptagent',modell:'api-haiku',eingabe_zeichen:3,max_tokens:10}))==='funktion_aus',
   'P22-T179 reserviereApiAufruf main: Bestand - Main braucht weiter hauptagent EIN');
  const ok1=await r();
  check(ok1.reserviert_usd>0&&ok1.anbieter_modell==='claude-haiku-4-5-20251001','P22-T179 reserviereApiAufruf agent: mit Freigabe reserviert',ok1);
  await C.schliesseApiAufrufAb({reservierung_id:ok1.reservierung_id,agent_id:W.agent_id,usage:{input_tokens:1000,output_tokens:100}});
  check(await err(()=>r({modell:'api-sonnet'}))==='modell_nicht_freigegeben','P22-T179 pruefeAgentFreigabeTx: Modell im Budget, aber nicht in der Freigabe');
  check(await err(()=>r({max_tokens:4000}))==='agent_budget_erschoepft','P22-T179 pruefeAgentFreigabeTx: eigene Grenze 0.01 USD greift vor dem globalen Rest (5 USD)');
  check(await err(()=>r({identity_id:'nicht-freigegeben'}))==='api_freigabe_fehlt','P22-T179 pruefeAgentFreigabeTx: ohne Freigabe -> api_freigabe_fehlt');
  await schalterAgenten(false);
  check(await err(()=>r())==='funktion_aus','P22-T179 reserviereApiAufruf agent: Schalter api_agenten AUS -> funktion_aus');
  await schalterAgenten(true);
 });

 await section('D REST-Transport Arbeitsagent und Koordinator (Fake-Anthropic)',async()=>{
  const anfragen=[];
  const basis=await server(async(req,res,body)=>{anfragen.push({url:req.url,body});
   sseNachricht(res,{model:body.model,stop_reason:'end_turn',usage:{input_tokens:1000,output_tokens:50},content:[{type:'text',text:'Erledigt.'}]});});
  erlaubt.add(basis);process.env.ANTHROPIC_BASE_URL=basis;process.env.SYNAPSE_ANTHROPIC_API_KEY=KEY;
  const Fastify=requireApi('fastify');
  const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  const nutzlast={project:P,modell:'api-haiku',system:'Du bist ein Arbeitsagent.',max_tokens:500,messages:[{role:'user',content:[{type:'text',text:'Hallo'}]}]};
  const post=(token,p=nutzlast)=>f.inject({method:'POST',url:'/api/agent-api/messages',headers:{'x-synapse-agent-token':token},payload:p});
  const verbrauch=async id=>(await pool.query("SELECT count(*)::int n, COALESCE(sum(usd),0)::float usd FROM agent_verbrauch WHERE identity_id=$1 AND quelle='api_worker'",[id])).rows[0];
  // Schalter AUS = Bestand: nur_hauptagent, kein Anbieteraufruf
  await schalterAgenten(false);
  let r=await post(W.token);
  check(r.statusCode===403&&r.json().error.code==='nur_hauptagent'&&anfragen.length===0,'P22-T179 agent-api.ts agentAus: Schalter api_agenten AUS -> Bestand nur_hauptagent',r.json());
  await schalterAgenten(true);
  // Koordinator ohne Freigabe -> api_freigabe_fehlt (403), kein Anbieteraufruf
  await C.entferneApiFreigabe(USER,{identity_id:K.identity_id,grund:'Test T179 ohne Freigabe'});
  r=await post(K.token);
  check(r.statusCode===403&&r.json().error.code==='api_freigabe_fehlt'&&anfragen.length===0,'P22-T179 agent-api.ts: Koordinator ohne Freigabe -> 403 api_freigabe_fehlt, kein Anbieteraufruf',r.json());
  // Arbeitsagent mit Freigabe -> 200, Buchung je Identitaet
  const vW=await verbrauch(W.identity_id);
  r=await post(W.token);
  const j=r.json();
  check(r.statusCode===200&&j.success&&j.message.content[0].text==='Erledigt.'&&anfragen.length===1&&anfragen[0].body.model==='claude-haiku-4-5-20251001','P22-T179 agent-api.ts: Arbeitsagent mit Freigabe -> 200, Haiku beim Anbieter',{status:r.statusCode,j});
  check(Math.abs(j.kosten.usd-(1000*1+50*5)/1e6)<1e-9&&!r.body.includes(KEY),'P22-T179 agent-api.ts: Kosten aus usage (1000 in, 50 out Haiku), Key nie in der Antwort',j.kosten);
  const nW=await verbrauch(W.identity_id);
  check(nW.n===vW.n+1&&nW.usd>vW.usd,'P22-T179 api-agent-dienst.ts schliesseApiAufrufAb: Buchung in agent_verbrauch je Arbeitsagent',{vorher:vW,nachher:nW});
  // Koordinator mit Freigabe (User) -> 200
  await C.setzeApiFreigabe(USER,{identity_id:K.identity_id,modelle:['api-haiku'],grenze_usd:1,grund:'Test T179 Koordinator wieder frei'});
  r=await post(K.token,{...nutzlast,system:'Du bist ein Koordinator.'});
  check(r.statusCode===200&&anfragen.length===2&&(await verbrauch(K.identity_id)).n===1,'P22-T179 agent-api.ts: Koordinator mit Freigabe -> 200 und eigene Buchung',r.json());
  // Modell ausserhalb der Freigabe -> 403, kein Anbieteraufruf
  r=await post(W.token,{...nutzlast,modell:'api-sonnet'});
  check(r.statusCode===403&&r.json().error.code==='modell_nicht_freigegeben'&&anfragen.length===2,'P22-T179 agent-api.ts: modell_nicht_freigegeben -> 403, kein Ersatzmodell',r.json());
  // Kosten je Agent sichtbar
  const k=await C.apiKostenUebersicht();
  const jeAgent=Object.fromEntries(k.je_agent.map(z=>[z.identity_id,z]));
  check(jeAgent[W.identity_id]?.aufrufe>=2&&jeAgent[K.identity_id]?.aufrufe===1,'P22-T179 api-agent-dienst.ts apiKostenUebersicht.je_agent: Arbeitsagent und Koordinator getrennt',k.je_agent);
  // Rahmen je Agent
  const ra=await f.inject({method:'GET',url:'/api/agent-api/rahmen?project='+encodeURIComponent(P),headers:{'x-synapse-agent-token':W.token}});
  const rj=ra.json();
  check(ra.statusCode===200&&rj.zugang==='agent'&&rj.aktiv===true&&rj.freigabe?.modelle?.join()==='api-haiku'&&rj.freigabe.grenze_usd===0.01,'P22-T179 apiRahmenFuerIdentitaet: Rahmen nur mit eigener Freigabe, aktiv je Agent',rj);
  // Container-Bearer agent:identitaet:<id> darf den Transport (mit Ausweis), sonst nichts Neues
  const M=await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  const scope=M.agentIdentitaetScope(W.identity_id);
  check(M.mainScopePasst(scope,'POST','/api/agent-api/messages',{'x-synapse-agent-token':W.token})===true&&M.mainScopePasst(scope,'GET','/api/agent-api/rahmen',{'x-synapse-agent-token':W.token})===true,
   'P22-T179 main-tool-profile.ts mainScopePasst: agent:identitaet darf den API-Transport mit Ausweis');
  check(M.mainScopePasst(scope,'POST','/api/agent-api/messages',{})===false&&M.mainScopePasst(scope,'GET','/api/main-agent/api',{'x-synapse-agent-token':W.token})===false,
   'P22-T179 main-tool-profile.ts mainScopePasst: ohne Ausweis bzw. User-Route weiter gesperrt');
  delete process.env.SYNAPSE_ANTHROPIC_API_KEY;
 });

 await section('E Heartbeat: API-Agent Standard AUS',async()=>{
  const ziel={art:'identity',project:P,agent_id:K.agent_id,identity_id:K.identity_id};
  const wrapper=async()=>{await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[K.identity_id]);
   await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled) VALUES($1,$2,$3,'running',false,NOW(),true)",[K.identity_id,P,K.agent_id]);};
  const hb=async()=>(await pool.query('SELECT heartbeat_enabled FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[K.identity_id])).rows[0]?.heartbeat_enabled;
  await wrapper();await C.heartbeatBeimSpawnFuerZiel(P,ziel);
  check(await hb()===false,'P22-T179 hauptagent-lauf.ts heartbeatBeimSpawnFuerZiel: API-Agent mit Freigabe -> Heartbeat AUS (Standard)',await hb());
  await C.setzeApiFreigabe(USER,{identity_id:K.identity_id,modelle:['api-haiku'],heartbeat:true,grund:'Test T179 Heartbeat EIN'});
  check(await hb()===true,'P22-T179 setzeApiFreigabe heartbeat:true: laufender Wrapper sofort EIN',await hb());
  await C.setzeApiFreigabe(USER,{identity_id:K.identity_id,modelle:['api-haiku'],grund:'Test T179 Heartbeat wieder AUS'});
  check(await hb()===false,'P22-T179 setzeApiFreigabe ohne heartbeat: laufender Wrapper sofort AUS',await hb());
  await schalterAgenten(false);await wrapper();await C.heartbeatBeimSpawnFuerZiel(P,ziel);
  check(await hb()===true,'P22-T179 heartbeatBeimSpawnFuerZiel: Schalter api_agenten AUS -> Bestand (an, adaptiv)',await hb());
  await schalterAgenten(true);
  await C.entferneApiFreigabe(USER,{identity_id:K.identity_id,grund:'Test T179 ohne Freigabe'});await wrapper();await C.heartbeatBeimSpawnFuerZiel(P,ziel);
  check(await hb()===true,'P22-T179 heartbeatBeimSpawnFuerZiel: ohne Freigabe -> Bestand (an)',await hb());
 });

 await section('F admin api_freigabe, Status, REST-Routen des Users',async()=>{
  check(C.W1B_ADMIN_ACTIONS.includes('api_freigabe')&&C.API_AGENT_ADMIN_ACTIONS.includes('api_freigabe')&&'api_heartbeat' in C.API_AGENT_ADMIN_PARAMETER,
   'P22-T179 api-agent-dienst.ts: admin-Aktion api_freigabe und Parameter api_heartbeat im W1B-Dispatcher');
  const adm=(args,akteur)=>C.fuehreW1bAdminAus('api_freigabe',args,{akteur});
  let a=await adm({modus:'setzen',ziel_identity_id:K.identity_id,erlaubte_modelle:['api-haiku'],grenze_usd:0.5,grund:'Test T179 admin',user_auftrag:'User: ja'},MA);
  check(a.success&&a.freigabe.gesetzt_von==='main'&&a.freigabe.grenze_usd===0.5,'P22-T179 admin api_freigabe setzen: Main mit user_auftrag',a);
  a=await adm({modus:'setzen',ziel_identity_id:W.identity_id,erlaubte_modelle:['api-haiku'],grund:'Test T179 admin'},KO);
  check(a.success===false&&a.error==='recht_fehlt','P22-T179 admin api_freigabe setzen: Koordinator -> recht_fehlt',a);
  a=await adm({modus:'status'},KO);
  check(a.success===false&&a.error==='recht_fehlt','P22-T179 admin api_freigabe status: Koordinator -> recht_fehlt (Lesen User + Main)',a);
  a=await adm({modus:'status',project:P},USER);
  const zeile=a.freigaben?.find(z=>z.identity_id===W.identity_id);
  check(a.success&&a.schalter.aktiv===true&&a.freigaben.length===2&&zeile&&zeile.verbraucht_usd>0&&typeof zeile.rest_usd==='number','P22-T179 apiAgentenStand: Schalter + Freigaben mit Verbrauch je Agent',a);
  const st=await C.apiAgentStatus();
  check(Array.isArray(st.agenten?.freigaben)&&st.agenten.freigaben.length===2,'P22-T179 apiAgentStatus.agenten: Freigaben im Gesamtstatus (admin api_status, GET /api/main-agent/api)',st.agenten);
  // REST des Users (Guard der Web-UI-Sitzung liegt in agentRuntimeRoutes; hier die Routen selbst)
  const Fastify=requireApi('fastify');
  const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  let r=await f.inject({method:'GET',url:'/api/main-agent/api/freigaben?project='+encodeURIComponent(P)});
  check(r.statusCode===200&&r.json().freigaben.length===2,'P22-T179 agent-api.ts GET /api/main-agent/api/freigaben',r.json());
  r=await f.inject({method:'PUT',url:'/api/main-agent/api/freigaben',payload:{identity_id:W.identity_id,modelle:['api-haiku'],aktiv:false,grund:'Test T179 REST aus'}});
  check(r.statusCode===200&&r.json().freigabe.aktiv===false,'P22-T179 agent-api.ts PUT /api/main-agent/api/freigaben (aktiv false)',r.json());
  check(await err(()=>C.reserviereApiAufruf({identity_id:W.identity_id,project:P,agent_id:W.agent_id,modell:'api-haiku',eingabe_zeichen:3,max_tokens:10,zugang:'agent'}))==='api_freigabe_fehlt',
   'P22-T179 pruefeAgentFreigabeTx: inaktive Freigabe -> api_freigabe_fehlt');
  r=await f.inject({method:'DELETE',url:'/api/main-agent/api/freigaben',payload:{identity_id:W.identity_id,grund:'Test T179 REST entfernen'}});
  check(r.statusCode===200&&r.json().entfernt===true,'P22-T179 agent-api.ts DELETE /api/main-agent/api/freigaben',r.json());
  r=await f.inject({method:'PUT',url:'/api/main-agent/api/freigaben',payload:{identity_id:MAIN,modelle:['api-haiku'],grund:'Test T179 Main'}});
  check(r.statusCode===400&&r.json().error.code==='rolle_nicht_zugelassen','P22-T179 agent-api.ts PUT: Main als Ziel -> rolle_nicht_zugelassen',r.json());
 });

 // G Nachtrag (Koordinator 26.10.2026 nach Live-Probe 04dd2649: echter Key ohne Workspace -> HTTP 400 "not scoped to a workspace"):
 //   optionale Env SYNAPSE_ANTHROPIC_WORKSPACE_ID -> Header anthropic-workspace-id an JEDEM Anthropic-Aufruf (Transport, Key testen);
 //   leer = wie bisher; eindeutige Anthropic-Meldung -> Fehlercode api_workspace_fehlt mit Hinweis; Stand nur ja/nein.
 await section('G Workspace-ID (Nachtrag)',async()=>{
  const anfragen=[];let modus='ok';
  const basis=await server(async(req,res,body)=>{anfragen.push({url:req.url,headers:req.headers});
   if(modus==='ws400'){res.writeHead(400,{'content-type':'application/json','x-should-retry':'false'});
    res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.'}}));return;}
   if(req.url.startsWith('/v1/models')){res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({data:[{type:'model',id:'claude-haiku-4-5-20251001',display_name:'Haiku',created_at:'2025-10-01T00:00:00Z'}],has_more:false,first_id:'claude-haiku-4-5-20251001',last_id:'claude-haiku-4-5-20251001'}));return;}
   sseNachricht(res,{model:body.model,stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5},content:[{type:'text',text:'ok'}]});});
  erlaubt.add(basis);process.env.ANTHROPIC_BASE_URL=basis;process.env.SYNAPSE_ANTHROPIC_API_KEY=KEY;
  const Fastify=requireApi('fastify');
  const R=await load('packages/rest-api/dist/routes/agent-api.js');
  const f=Fastify();await R.agentApiRoutes(f);await f.ready();aufraeumen.push(()=>f.close());
  const nutzlast={project:P,modell:'api-haiku',max_tokens:100,messages:[{role:'user',content:[{type:'text',text:'Hallo'}]}]};
  const post=()=>f.inject({method:'POST',url:'/api/agent-api/messages',headers:{'x-synapse-agent-token':K.token},payload:nutzlast});
  const testen=()=>f.inject({method:'POST',url:'/api/main-agent/api/key/testen'});
  const kopf=()=>anfragen.at(-1)?.headers['anthropic-workspace-id'];
  delete process.env.SYNAPSE_ANTHROPIC_WORKSPACE_ID;
  let r=await post();
  check(r.statusCode===200&&kopf()===undefined,'P22-T179 agent-api.ts Transport ohne SYNAPSE_ANTHROPIC_WORKSPACE_ID: kein Header (wie bisher)',{status:r.statusCode,kopf:kopf()});
  check((await C.leseApiKeyStand()).workspace_id_gesetzt===false,'P22-T179 api-schluessel-dienst.ts leseApiKeyStand: workspace_id_gesetzt false');
  process.env.SYNAPSE_ANTHROPIC_WORKSPACE_ID='wrkspc_test_t179';
  r=await post();
  check(r.statusCode===200&&kopf()==='wrkspc_test_t179','P22-T179 agent-api.ts Transport mit Workspace-ID: Header anthropic-workspace-id gesetzt',{status:r.statusCode,kopf:kopf()});
  let t=await testen();
  check(t.statusCode===200&&t.json().test.ok===true&&anfragen.at(-1).url.startsWith('/v1/models')&&kopf()==='wrkspc_test_t179','P22-T179 agent-api.ts Key testen: Header auch bei GET /v1/models',{test:t.json(),kopf:kopf()});
  const st=await C.leseApiKeyStand();
  check(st.workspace_id_gesetzt===true&&/workspace=ja/.test(st.debug)&&!JSON.stringify(st).includes('wrkspc_test_t179'),'P22-T179 leseApiKeyStand: nur ja/nein, Wert nie im Stand',st.debug);
  // Anthropic meldet "not scoped to a workspace" -> api_workspace_fehlt (503) mit Hinweis, Reservierung freigegeben, 0 USD
  delete process.env.SYNAPSE_ANTHROPIC_WORKSPACE_ID;modus='ws400';
  r=await post();
  const j=r.json();
  const letzte=(await pool.query("SELECT status, usd FROM api_agent_reservierungen WHERE identity_id=$1 ORDER BY erstellt_am DESC LIMIT 1",[K.identity_id])).rows[0];
  check(r.statusCode===503&&j.error.code==='api_workspace_fehlt'&&/SYNAPSE_ANTHROPIC_WORKSPACE_ID/.test(j.error.message)&&!r.body.includes(KEY),'P22-T179 agent-api.ts: "not scoped to a workspace" -> 503 api_workspace_fehlt mit Hinweis',j);
  check(letzte?.status==='freigegeben'&&Number(letzte.usd)===0,'P22-T179 agent-api.ts api_workspace_fehlt: Reservierung freigegeben, 0 USD',letzte);
  t=await testen();
  check(t.json().test.ok===false&&t.json().test.fehler==='api_workspace_fehlt'&&t.json().test.http_status===400,'P22-T179 agent-api.ts Key testen: api_workspace_fehlt',t.json());
  delete process.env.SYNAPSE_ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_BASE_URL;
 });

 check(network===0,'P22-T179: keine echten Netzwerk-/Modellaufrufe (nur Fake-Anthropic)',network);
}finally{
 for(const f of aufraeumen.reverse())await f().catch(()=>undefined);
 await core?.closePool?.().catch?.(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end().catch(()=>undefined);
}
console.log(failures.length?'FEHLER P22-T179: '+failures.length+' von '+checks+' | '+failures.slice(0,5).join(' | '):'PASS P22-T179 API-Agenten Arbeitsagent/Koordinator '+checks+' Pruefungen');
process.exit(failures.length?1:0);
