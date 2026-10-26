/** P22-T180: Freigaben je Agent fuer die Web-UI - core api-agent-freigabe.ts apiAgentenStand + REST agent-api.ts (fastify inject, privates
 *  synapse_test-Schema), Formular-Body aus web-ui api-freigaben-logik.ts (derselbe Vertrag wie im Browser).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-freigaben-webui-p22-t180.test.mjs
 * Kein Key, kein Anbieteraufruf, kein externes Netz (fetch gesperrt und gezaehlt). Verbrauch nur ueber Reservierung + Abschluss (core).
 * Sichert ab (Task P22-T180, Folge aus P22-T179 thought 42fe86c8; Grundsatz P22-T106 'kostenpflichtig nie automatisch'):
 *   A Rechte: ohne Web-UI-Sitzung 401.
 *   B GET ?kandidaten=1: waehlbare Agenten (aktiv, subagent|koordinator, nicht Main), schalter_je_projekt EIN/AUS, ohne kandidaten=1 keine
 *     Liste, project-Filter; Lesen legt keine Freigabe an.
 *   C PUT mit Body aus freigabeKoerper + Grund: Freigabe angelegt (Heartbeat AUS), GET zeigt sie mit api_agenten_aktiv, Kandidat 'hat Freigabe';
 *     ohne Grund grund_fehlt; Projekt mit Schalter AUS funktion_aus (schalterText sagt AUS); Main rolle_nicht_zugelassen.
 *   D Verbrauch/Rest je Agent im Zeitraum des globalen Budgets (freigabeZeile zeigt verbraucht und Rest).
 *   E Aendern (Bearbeiten-Formular) und Entziehen: DELETE ohne Grund grund_fehlt, mit Grund entfernt, Kandidat ohne Freigabe.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich: ...'. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT',
 'SYNAPSE_HAUPTAGENT_API','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_ANTHROPIC_API_KEY','SYNAPSE_ANTHROPIC_WORKSPACE_ID','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','SYNAPSE_VERBRAUCH'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'0',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Netz gesperrt: jeder fetch zaehlt als Verstoss (Freigaben-Verwaltung ruft keinen Anbieter).
let network=0;globalThis.fetch=async(ziel)=>{network++;throw Error('Testnetz gesperrt: '+String(ziel?.url??ziel));};
const L=await load('packages/web-ui/src/components/api-freigaben-logik.ts');
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t180_'+process.pid+'_'+randomUUID().slice(0,8);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const P='p22-t180-a',P2='p22-t180-b',USER={art:'user'};
let C,pool,app,failure,checks=0;
const kurz=v=>{try{return JSON.stringify(v).slice(0,600);}catch{return String(v).slice(0,600);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):''));assert(value,label);console.log('OK '+label);};
const HD='P22-T180 core api-agent-freigabe.ts',HR='P22-T180 rest-api agent-api.ts',HL='P22-T180 web-ui api-freigaben-logik.ts';
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const seq=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,r]of seq.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema',
  'hauptagent-verlauf-schema','main-warteschlange-schema','agent-verbrauch-schema','agent-api-budget-schema','api-agent-schluessel-schema','api-agent-freigaben-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 await pool.query('CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr');
 for(const t of ['api_agent_freigaben','api_agent_reservierungen','api_agent_budget','agent_profil_schalter'])await pool.query('DELETE FROM '+t).catch(()=>undefined);
 // API-Modelle wie der Seed in schema.ts (P22-T8), nur im privaten Schema.
 await pool.query(`INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max,
   pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit) VALUES
  ('api-sonnet','claude-sonnet-5-5','anthropic-api',1000000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',80,97,2.00,10.00,0.20,'2026-06-01',128000),
  ('api-haiku','claude-haiku-4-5-20251001','anthropic-api',200000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',73,88,1.00,5.00,0.10,'2025-02-28',64000)
  ON CONFLICT (alias) DO NOTHING`);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T180 alle'},{system:'user'});
 const vor=(project,name,rolle)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project,name,rolle,grund:'Test T180 '+name},USER);
 const W=await vor(P,'t180-arbeit','subagent'),K=await vor(P,'t180-koord','koordinator'),W2=await vor(P2,'t180-anders','subagent');
 const MAIN='t180-main-'+process.pid;
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,'hauptagent',1,'hauptagent','main','test')",[MAIN,C.HAUPTAGENT_PROJEKT]);
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten',aktiv:true,grund:'Test T180 api_agenten EIN'},{system:'user'});

 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const inj=(method,url,payload,mitSitzung=true)=>app.inject({method,url,...(payload!==undefined?{payload}:{}),headers:mitSitzung?{authorization:'Bearer '+sitzung}:{}});
 const stand=async(q='?kandidaten=1')=>{const r=await inj('GET','/api/main-agent/api/freigaben'+q);assert.equal(r.statusCode,200,r.body);return r.json();};
 const anzahl=async()=>(await pool.query('SELECT count(*)::int n FROM api_agent_freigaben')).rows[0].n;

 // ================================================================ A Rechte
 let r=await inj('GET','/api/main-agent/api/freigaben?kandidaten=1',undefined,false);
 ok(r.statusCode===401,HR+' GET /api/main-agent/api/freigaben ohne Web-UI-Sitzung -> 401',{status:r.statusCode});
 r=await inj('PUT','/api/main-agent/api/freigaben',{identity_id:W.identity_id,modelle:['api-haiku'],grund:'Test T180 ohne Sitzung'},false);
 ok(r.statusCode===401&&await anzahl()===0,HR+' PUT ohne Web-UI-Sitzung -> 401, nichts gespeichert',{status:r.statusCode});

 // ================================================================ B Lesen
 let s=await stand();
 const ids=(s.kandidaten??[]).map(k=>k.identity_id);
 ok([W.identity_id,K.identity_id,W2.identity_id].every(i=>ids.includes(i))&&!ids.includes(MAIN),HD+' apiAgentenStand kandidaten: Arbeitsagent, Koordinator (beide Projekte), nie der Main',ids);
 const kW=s.kandidaten.find(k=>k.identity_id===W.identity_id),kK=s.kandidaten.find(k=>k.identity_id===K.identity_id),kW2=s.kandidaten.find(k=>k.identity_id===W2.identity_id);
 ok(kW.rolle==='subagent'&&kK.rolle==='koordinator'&&kW.freigabe===false&&kW.api_agenten_aktiv===true&&kW2.api_agenten_aktiv===false,HD+' kandidaten: Rolle, freigabe=false, api_agenten je Projekt',{kW,kK,kW2});
 ok(s.schalter_je_projekt?.[P]?.aktiv===true&&s.schalter_je_projekt?.[P2]?.aktiv===false&&typeof s.schalter?.aktiv==='boolean',HD+' schalter_je_projekt: P EIN, P2 AUS; globaler Schalter im Stand',{je:s.schalter_je_projekt,g:s.schalter});
 ok(L.kandidatLabel(kK)==='p22-t180-a · '+K.agent_id+' (Koordinator)'&&L.schalterText(P2,s.schalter_je_projekt[P2]).aktiv===false,HL+' kandidatLabel/schalterText auf der echten Antwort');
 ok(Array.isArray(s.freigaben)&&s.freigaben.length===0&&await anzahl()===0,HD+' Lesen legt keine Freigabe an (kostenpflichtig nie automatisch)',s.freigaben);
 const ohne=await stand('');
 ok(ohne.kandidaten===undefined&&Array.isArray(ohne.freigaben),HR+' GET ohne kandidaten=1: keine Kandidatenliste (Bestand T179)',Object.keys(ohne));
 const nurP=await stand('?project='+P+'&kandidaten=1');
 ok(nurP.kandidaten.length>=2&&nurP.kandidaten.every(k=>k.project===P),HR+' GET ?project=&kandidaten=1: nur Agenten des Projekts',nurP.kandidaten.map(k=>k.project));

 // ================================================================ C Setzen
 const form={...L.formularAus(null,['api-haiku','api-sonnet']),identity_id:W.identity_id,grenze:'0,5'};
 const koerper=L.freigabeKoerper(form);
 ok(koerper.ok&&koerper.koerper.heartbeat===false,HL+' freigabeKoerper: Body aus dem leeren Formular (Heartbeat AUS)',koerper);
 r=await inj('PUT','/api/main-agent/api/freigaben',koerper.koerper);
 ok(r.statusCode>=400&&r.json().error?.code==='grund_fehlt'&&await anzahl()===0,HR+' PUT ohne Grund -> grund_fehlt, nichts gespeichert',r.json());
 r=await inj('PUT','/api/main-agent/api/freigaben',{...koerper.koerper,grund:'Test T180 Arbeitsagent Haiku'});
 ok(r.statusCode===200&&r.json().freigabe?.identity_id===W.identity_id&&r.json().freigabe.heartbeat===false&&r.json().freigabe.gesetzt_von==='user'&&r.json().freigabe.grenze_usd===0.5,
  HR+' PUT mit Grund: Freigabe angelegt (User, Grenze 0.5, Heartbeat AUS)',r.json());
 r=await inj('PUT','/api/main-agent/api/freigaben',{...L.freigabeKoerper({...form,identity_id:W2.identity_id}).koerper,grund:'Test T180 Projekt AUS'});
 ok(r.statusCode>=400&&r.json().error?.code==='funktion_aus',HR+' PUT fuer Projekt mit Schalter api_agenten AUS -> funktion_aus',r.json());
 r=await inj('PUT','/api/main-agent/api/freigaben',{...L.freigabeKoerper({...form,identity_id:MAIN}).koerper,grund:'Test T180 Main'});
 ok(r.statusCode>=400&&r.json().error?.code==='rolle_nicht_zugelassen',HR+' PUT fuer den Main -> rolle_nicht_zugelassen (eigener Weg)',r.json());
 s=await stand();
 const fW=s.freigaben.find(f=>f.identity_id===W.identity_id);
 ok(s.freigaben.length===1&&fW&&fW.api_agenten_aktiv===true&&fW.verbraucht_usd===0&&s.kandidaten.find(k=>k.identity_id===W.identity_id).freigabe===true,
  HD+' GET nach PUT: genau eine Freigabe mit api_agenten_aktiv, Verbrauch 0, Kandidat hat Freigabe',s.freigaben);

 // ================================================================ D Verbrauch/Rest im Zeitraum des globalen Budgets
 await C.setzeApiSchalter(USER,{aktiv:true,grund:'Test T180 api EIN'});
 await C.setzeApiBudget(USER,{grenze_usd:5,zeitraum:'monat',reset_tag:1,erlaubte_modelle:['api-haiku','api-sonnet'],grund:'Test T180 Budget'});
 const res=await C.reserviereApiAufruf({identity_id:W.identity_id,project:P,agent_id:W.agent_id,modell:'api-haiku',eingabe_zeichen:300,max_tokens:500,zugang:'agent'});
 await C.schliesseApiAufrufAb({reservierung_id:res.reservierung_id,agent_id:W.agent_id,usage:{input_tokens:1000,output_tokens:100}});
 s=await stand();
 const v=s.freigaben.find(f=>f.identity_id===W.identity_id);
 ok(typeof s.budget_beginn==='string'&&Math.abs(v.verbraucht_usd-0.0015)<1e-9&&Math.abs(v.rest_usd-0.4985)<1e-9,HD+' Verbrauch je Agent seit Budgetbeginn, Rest = eigene Grenze - Verbrauch',v);
 const zeile=L.freigabeZeile(v);
 ok(zeile.includes('Grenze 0.5000 USD · verbraucht 0.0015 USD · Rest 0.4985 USD · Heartbeat AUS'),HL+' freigabeZeile auf der echten Antwort: Grenze, Verbrauch, Rest, Heartbeat',zeile);

 // ================================================================ E Aendern und Entziehen
 const bearb=L.formularAus(v,['api-haiku','api-sonnet']);
 r=await inj('PUT','/api/main-agent/api/freigaben',{...L.freigabeKoerper({...bearb,modelle:['api-haiku','api-sonnet'],aktiv:false}).koerper,grund:'Test T180 aendern'});
 ok(r.statusCode===200&&r.json().freigabe.aktiv===false&&r.json().freigabe.modelle.join()==='api-haiku,api-sonnet'&&r.json().freigabe.grenze_usd===0.5,HR+' PUT aus dem Bearbeiten-Formular: pausiert, Modelle ergaenzt, Grenze bleibt',r.json());
 r=await inj('DELETE','/api/main-agent/api/freigaben',{identity_id:W.identity_id});
 ok(r.statusCode>=400&&r.json().error?.code==='grund_fehlt'&&await anzahl()===1,HR+' DELETE ohne Grund -> grund_fehlt, Freigabe bleibt',r.json());
 r=await inj('DELETE','/api/main-agent/api/freigaben',{identity_id:W.identity_id,grund:'Test T180 entziehen'});
 ok(r.statusCode===200&&r.json().entfernt===true&&await anzahl()===0,HR+' DELETE mit Grund: Freigabe entzogen',r.json());
 s=await stand();
 ok(s.freigaben.length===0&&s.kandidaten.find(k=>k.identity_id===W.identity_id).freigabe===false,HD+' nach Entziehen: keine Freigabe, Kandidat ohne Freigabe');
 ok(network===0,'P22-T180: kein Netzaufruf (fetch gesperrt)',network);
 console.log('PASS P22-T180 core+REST '+checks+' checks; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);await admin.end();
}
process.exit(failure?1:0);
