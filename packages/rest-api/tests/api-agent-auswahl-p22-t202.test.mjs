/**
 * P22-T202 / Entwurf 90467652: API-Laufwahl, Budgethinweis, Rechte, Main ohne CLI und CLI/API-Sperre.
 * Quellen: core/api-agent-auswahl.ts, specialist-queue.ts; rest-api/api-agent-auswahl.ts,
 * agent-api.ts, agent-runtime/manager.ts. Nur synapse_test:5433, privates Schema, kein Browser/Modell/Daemon.
 * Fehlerlabels tragen Einheit und erwartet/tatsaechlich; echte Providerzugriffe werden gesperrt.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(new URL('../../core/package.json',import.meta.url)),{Pool}=require('pg');
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','SYNAPSE_OPENROUTER_API_KEY','JEV_OPENROUTER_API_KEY'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_HAUPTAGENT:'1',
 SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1'});
const echtesFetch=globalThis.fetch;
let netz=0;globalThis.fetch=async()=>{netz++;throw Error('P22-T202 Netzwerk gesperrt');};
const admin=new Pool({connectionString:url.href}),schema='p22_t202_'+process.pid+'_'+randomUUID().slice(0,8);
let C,pool,manager,mainWorker,checks=0;const P='t202-privat',USER={art:'user'};
const check=(ok,label,wert)=>{checks++;assert.ok(ok,'P22-T202 '+label+' | erwartet wahr / tatsaechlich '+JSON.stringify(wert??ok));};
const error=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const q=s=>'"'+s.replaceAll('"','""')+'"',seq=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+seq);
  await admin.query('ALTER TABLE '+schema+'.'+q(r.table_name)+' ALTER COLUMN '+q(r.column_name)+" SET DEFAULT nextval('"+seq+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 C=await import('../../core/dist/index.js');pool=C.getPool();
 const A=await import('../dist/services/api-agent-auswahl.js');
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'T202 Testbestand aktiv'},{system:'user'});
 const vor=(name,rolle,project=P)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project,name,rolle,grund:'T202 Testidentitaet'},USER);
 const W=await vor('t202-arbeit','subagent'),K=await vor('t202-koord','koordinator'),F=await vor('t202-fremd','koordinator','fremdes-testprojekt');
 const id=W.identity_id,anfrage={identity_id:id,modell:'or-deepseek-chat',auftrag:'Antworte TEST202 genau einmal.',grund:'T202 expliziter Testauftrag',kosten_bestaetigt:true,wechsel_bestaetigt:true,idempotenz_schluessel:randomUUID()};
 check(!(await C.leseApiAuswahlSchalter(P)).aktiv,'core Auswahl: Standard AUS trotz alle');
 check(await error(()=>A.starteApiAuswahl(anfrage,USER))==='funktion_aus','Start AUS blockiert');
 for(const project of [P,C.HAUPTAGENT_PROJEKT]){
  for(const funktion of ['api_agenten_auswahl','api_agenten_lauf_intern','api_agenten'])
   await C.setzeProfilProduktSchalter({ebene:'projekt',project,funktion,aktiv:true,grund:'T202 explizit EIN'},{system:'user'});
 }
 await pool.query(`INSERT INTO model_registry(alias,full_id,provider,context_window,output_limit,corridor_min,corridor_max,pricing_input_usd_per_mtok,pricing_output_usd_per_mtok,pricing_cache_usd_per_mtok)
   VALUES('or-deepseek-chat','deepseek/deepseek-chat','openrouter-api',100000,1000,70,88,0.25,1,0.025)`);
 await C.setzeApiSchalter(USER,{aktiv:true,grund:'T202 API-Funktion Test'});
 check((await A.apiAuswahlStand(id,USER)).blocker.includes('budget_fehlt'),'Readiness Budget fehlt');
 check(await error(()=>A.starteApiAuswahl(anfrage,USER))==='budget_fehlt','Start ohne Budget blockiert');
 await C.setzeApiBudget(USER,{grenze_usd:0.1,zeitraum:'tag',erlaubte_modelle:['or-deepseek-chat'],grund:'T202 kleines privates Budget'});
 check(await error(()=>A.starteApiAuswahl(anfrage,USER))==='api_freigabe_fehlt','Start ohne eigene Freigabe blockiert');
 await C.setzeApiFreigabe(USER,{identity_id:id,modelle:['or-deepseek-chat'],grenze_usd:0.05,grund:'T202 explizite Freigabe'});
 check(await error(()=>A.starteApiAuswahl(anfrage,USER))==='api_zugang_fehlt','Start ohne OpenRouter-Key blockiert');
 process.env.SYNAPSE_OPENROUTER_API_KEY='T202-NUR-FAKE-KEY';
 check(!(await A.apiAnbieterStand())['anthropic-api'].vorhanden&&(await A.apiAnbieterStand())['openrouter-api'].vorhanden,'Anbieterstatus OpenRouter getrennt');
 check(await error(()=>A.starteApiAuswahl({...anfrage,kosten_bestaetigt:false},USER))==='kostenbestaetigung_fehlt','keine implizite Kostenbestaetigung');
 check(await error(()=>A.apiAuswahlStand(id,{art:'identity',identity_id:F.identity_id}))==='recht_fehlt','fremder Koordinator abgelehnt');
 check(await error(()=>A.apiAuswahlStand(id,{art:'identity',identity_id:id}))==='recht_fehlt','Arbeitsagent kann nicht verwalten');
 check((await A.apiAuswahlStand(id,{art:'identity',identity_id:K.identity_id})).identity.identity_id===id,'Projektkoordinator liest vorhandene Freigabe');
 const start=await A.starteApiAuswahl(anfrage,USER);
 check(start.identity_id===id&&(await C.leseApiLaufWahl(id)).phase==='aktiv','Start bestehende Identitaet ohne Container');
 const nochmal=await A.starteApiAuswahl(anfrage,USER);
 check(nochmal.idempotent===true,'Startretry mit identischer User-Anfrage ist idempotent');
 check(await error(()=>A.starteApiAuswahl({...anfrage,auftrag:'Anderer Auftrag bei gleichem Schluessel'},USER))==='idempotenz_konflikt','gleicher Schluessel fuer anderen Inhalt abgelehnt');
 check((await pool.query('SELECT count(*)::int n FROM api_agent_eingang WHERE identity_id=$1',[id])).rows[0].n===1,'Originalauftrag genau einmal');
 check((await pool.query('SELECT count(*)::int n FROM specialist_jobs')).rows[0].n===0,'kein Daemon-Spawn');
 check(await error(()=>C.enqueueSpecialistJob({project:P,action:'spawn',args:{name:W.agent_id,model:'haiku'}}))==='api_lauf_gewaehlt','CLI-Namensstart durch PG-Wahl gesperrt');
 check(await error(()=>C.enqueueSpecialistJob({project:P,action:'spawn_batch',args:{specialists:[{name:W.agent_id,model:'haiku'}]}}))==='api_lauf_gewaehlt','CLI-Batchstart gesperrt');
 const {LaufVerwaltung}=await import('../dist/services/api-agent-lauf.js');
 const v=new LaufVerwaltung({db:pool,liste:async()=>[],ausweis:async()=>W.token,
   aufruf:async()=>({content:[{type:'text',text:'T202 Anmeldung Testprofil'}]}),
   transport:async()=>({anbieter:'openrouter-api',antwort:{inhalt:[{typ:'text',text:'FAKE-T202-ANTWORT sichtbar'}],stop:'ende',stop_roh:null,
     nutzung:{input:10,output:4,cache_read:0,cache_creation:0},kosten_usd:0.001},kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:0.099,kontext_tokens:10})});
 await v.takt();await v.warteAufTurns();await v.beende();
 const sichtbar=await pool.query("SELECT text,meta->>'quelle' AS quelle FROM hauptagent_verlauf WHERE identity_id=$1 AND text LIKE 'FAKE-T202-ANTWORT%'",[id]);
 check(sichtbar.rows.length===1&&sichtbar.rows[0].quelle==='api','API-Worker-Antwort sichtbar im vorhandenen Chat, Herkunft API',sichtbar.rows);
 await C.legeApiEingangAn({identity_id:id,text:'Offener Auftrag fuer Wechselprobe',quelle:'auftrag',absender:'user'});
 await pool.query("UPDATE api_agent_laeufe SET lease_token=gen_random_uuid(),lease_bis=NOW()+interval '1 minute' WHERE identity_id=$1",[id]);
 check(await error(()=>A.beendeApiAuswahl(id,'T202 User wechselt auf CLI',USER))==='lauf_turn_aktiv','CLI-Wechsel wartet auf Turn');
 check((await pool.query('SELECT status FROM api_agent_laeufe WHERE identity_id=$1',[id])).rows[0].status==='gestoppt','Stop trotz Blocker COMMIT statt Rollback');
 await pool.query("UPDATE api_agent_laeufe SET lease_token=NULL,lease_bis=NULL WHERE identity_id=$1",[id]);
 check(await error(()=>A.beendeApiAuswahl(id,'T202 User wechselt auf CLI',USER))==='api_eingaenge_offen','Offene Auftraege bleiben erhalten');
 await pool.query('UPDATE api_agent_eingang SET erledigt_am=NOW() WHERE identity_id=$1',[id]);
 await A.beendeApiAuswahl(id,'T202 User wechselt auf CLI',USER);
 check(await C.leseApiLaufWahl(id)===null,'CLI-Wahl nach abgeschlossenem API-Lauf freigegeben');
 check(await C.stelleApiLaufZu(P,{identity_id:id},'Neue CLI-Nachricht','inbox','user')===false,'Nach CLI-Wahl keine doppelte Zustellung in den alten API-Lauf');
 // P22-T202 / api-agent-lauf.ts: T183-Budgetfallback muss trotz expliziter API-Wahl
 // denselben Agenten kontrolliert an CLI uebergeben; Fake-Spawn prueft Lease und Handoff.
 await A.starteApiAuswahl({...anfrage,idempotenz_schluessel:randomUUID()},USER);
 let fallback=0;
 const f=new LaufVerwaltung({db:pool,liste:async()=>[],ausweis:async()=>W.token,
   aufruf:async()=>({content:[{type:'text',text:'T202 Fallback Profil'}]}),
   transport:async()=>{throw Object.assign(Error('Budget erschoepft'),{code:'budget_erschoepft'});},
   rueckfall:async args=>{
     fallback++;
     const row=(await pool.query('SELECT lease_token FROM api_agent_laeufe WHERE identity_id=$1',[id])).rows[0];
     check(await C.leseApiLaufWahl(id)===null&&row.lease_token===null,'Budgetfallback gibt API-Wahl und Lease vor CLI-Start frei',row);
     check(args.task.includes(anfrage.auftrag),'Budgetfallback uebergibt Originalauftrag',args.task);
     return {success:true,runtime:'claude'};
   }});
 await f.takt();await f.warteAufTurns();await f.beende();
 check(fallback===1,'Budgetfallback genau ein kontrollierter CLI-Start',fallback);
 // Main startet als API ohne konfigurierte/angemeldete CLI; Budget bleibt unveraendert.
 const main=await A.starteApiAuswahl({...anfrage,identity_id:'main',idempotenz_schluessel:randomUUID()},USER);
 check(main.identity_id!==id,'Main eigene bestehende/angelegte Identitaet');
 const {AgentRuntimeManager}=await import('../dist/services/agent-runtime/manager.js');
 manager=new AgentRuntimeManager();
 const status=await manager.mainAssignment();
 check(status.runtime===null&&status.status===null&&status.api_lauf.wahl.modell==='or-deepseek-chat','Main Status API, kein fingierter Container');
 const session=await manager.createMainSession();
 check(session.identityId===main.identity_id&&session.context.laufart==='api'&&session.runtimeSessionId===null,'Main Session ohne CLI-Readiness');
 const b=await C.leseApiBudget();check(b.grenze_usd===0.1&&b.gebucht_usd===0,'Start aendert Budget nicht und bucht nichts');
 // HTTP-Vertrag ohne Umgehung des Fachdienstes; Akteur kommt injiziert vom authentifizierenden Parent-Guard.
 const reqApi=createRequire(new URL('../package.json',import.meta.url)),Fastify=reqApi('fastify'),app=Fastify({logger:false});
 try{
   const {agentApiRoutes}=await import('../dist/routes/agent-api.js');
   await app.register(async f=>agentApiRoutes(f,async()=>USER));
   const get=await app.inject({method:'GET',url:'/api/main-agent/api/laeufe/auswahl?identity_id='+id});
   check(get.statusCode===200&&get.json().identity.identity_id===id,'GET Auswahl REST bindet Zielidentitaet');
   const post=await app.inject({method:'POST',url:'/api/main-agent/api/laeufe/starten',payload:{...anfrage,identity_id:main.identity_id,idempotenz_schluessel:randomUUID(),kosten_bestaetigt:false}});
   check(post.json().error.code==='kostenbestaetigung_fehlt','POST Start REST ohne Kostenauftrag verweigert');
 }finally{await app.close();}
 // Main-Session -> echter REST-SSE-Vertrag -> existierender apiLaufMainTurn, ohne CLI-Anmeldung/Container.
 process.env.SYNAPSE_AUTH_DISABLED='1';process.env.DOCKER_SOCKET='/nicht/vorhanden/docker.sock';
 const LM=await import('../dist/services/api-agent-lauf.js');
 mainWorker=LM.starteApiAgentLauf({db:pool,liste:async()=>[],ausweis:async()=>W.token,
   aufruf:async()=>({content:[{type:'text',text:'T202 Main-Test Anmeldung'}]}),
   transport:async()=>({anbieter:'openrouter-api',antwort:{inhalt:[{typ:'text',text:'MAIN-API-T202-ANTWORT'}],stop:'ende',stop_roh:null,
    nutzung:{input:20,output:5,cache_read:0,cache_creation:0},kosten_usd:0.001},kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:0.099,kontext_tokens:20})});
 await mainWorker.takt();await mainWorker.warteAufTurns();
 const RM=await import('../dist/routes/agent-runtimes.js'),mainApp=Fastify({logger:false});
 try{
   await mainApp.register(RM.agentRuntimeRoutes);
   const sitzung=await mainApp.inject({method:'POST',url:'/api/main-agent/sessions',payload:{}});
   check(sitzung.statusCode===200,'Main REST Session ohne CLI',sitzung.json());
   const turn=await mainApp.inject({method:'POST',url:'/api/main-agent/sessions/'+sitzung.json().session.id+'/messages',payload:{message:'Hallo Main per API'}});
   check(turn.statusCode===200&&turn.body.includes('MAIN-API-T202-ANTWORT')&&turn.body.includes('api_lauf')&&turn.body.includes('event: done'),'Main REST-Nachricht ueber API-SSE beantwortet',turn.body.slice(-600));
   const buchungen=(await pool.query('SELECT count(*)::int n FROM agent_verbrauch')).rows[0].n;
   check(buchungen===0,'Main-Route bucht Fake-API-Usage nicht nochmals als Abo-Verbrauch',buchungen);
 }finally{await mainApp.close();await mainWorker.beende();}
 check(netz===0,'keine Netzwerk-/Modellaufrufe',netz);
 const ui=await readFile(new URL('../../web-ui/src/components/ApiAgentLaufwahl.tsx',import.meta.url),'utf8');
 check(ui.includes('Einstellungen &gt; API-Agenten')&&ui.includes('kosten_bestaetigt:kosten')&&ui.includes('api_freigabe_fehlt'),'UI explizite Kostenwahl und Budget-Link');
 console.log('P22-T202 '+checks+' Prüfungen grün; network='+netz);
 if(process.argv.includes('--browser')){manager.shutdown();const {pruefeLaufwahlBrowser}=await import('./api-agent-auswahl-browser-helfer.mjs');await pruefeLaufwahlBrowser({C,pool,W,K,P,fetcher:echtesFetch});}
}finally{
 await mainWorker?.beende();manager?.shutdown();if(pool)await pool.end();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
