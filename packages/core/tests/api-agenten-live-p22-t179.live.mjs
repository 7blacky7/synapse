/**
 * P22-T179 LIVE-PROBE (Freigabe Koordinator 26.10.2026): echter Anthropic-Key, AUSSCHLIESSLICH lokale Testinstanz - rest-api-Routen im
 * Testprozess gegen ein privates Schema in synapse_test:5433, nie Prod. Kein Teil von test-alle (Endung .live.mjs, braucht P22_T179_LIVE=1).
 *   set -a; . ~/.config/synapse/secrets.env; set +a   (im SELBEN shell-exec, kein set -x)
 *   P22_T179_LIVE=1 DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/api-agenten-live-p22-t179.live.mjs
 * Ablauf: Budget 0,30 USD (Zeitraum tag), nur api-haiku, max_tokens_obergrenze 512, Heartbeat AUS (keine Wrapper, kein Heartbeat).
 *   Je ein echter api-worker-Prozess (packages/agents/dist/api-worker.js, Wrapper-Modus) fuer einen Arbeitsagenten (subagent) und einen
 *   Koordinator mit Freigabe bekommt einen kurzen Auftrag; der Worker ruft den Transport POST /api/agent-api/messages dieser Testinstanz
 *   (127.0.0.1, zufaelliger Port), der die echte Anthropic-API mit dem Key aufruft. Gegenprobe: dritter Agent ohne Freigabe -> abgelehnt,
 *   keine Reservierung, 0 Kosten. Belege: agent_verbrauch und api_agent_reservierungen je Identitaet, apiKostenUebersicht.je_agent.
 * Abbruch bei mehr als 0,30 USD (das Budget selbst ist die harte Grenze; zusaetzlich Pruefung vor jedem Auftrag).
 * Der Key steht nie in einer Ausgabe (Maskierung), geht nicht an die Kindprozesse und nicht in Logs.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

if(process.env.P22_T179_LIVE!=='1'){console.error('Abbruch: Live-Probe nur mit P22_T179_LIVE=1');process.exit(2);}
const KEY=(process.env.SYNAPSE_ANTHROPIC_API_KEY||'').trim();
if(!KEY){console.error('Abbruch: SYNAPSE_ANTHROPIC_API_KEY fehlt (secrets.env im selben exec laden)');process.exit(2);}
const GRENZE_USD=0.30;
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const url=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_HAUPTAGENT','SYNAPSE_HAUPTAGENT_API','ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
 SYNAPSE_W1B_GATE_TTL_MS:'0',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
// Netz im Testprozess: nur localhost und die Anthropic-API.
let fremd=0;const echtesFetch=globalThis.fetch;
globalThis.fetch=async(ziel,opt)=>{const u=String(ziel?.url??ziel);if(/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)||u.startsWith('https://api.anthropic.com/'))return echtesFetch(ziel,opt);fremd++;throw Error('Netz gesperrt: '+u);};
const mask=s=>String(s).split(KEY).join('[KEY]').replace(/sk-ant-[A-Za-z0-9_-]{8,}/g,'[KEY]').replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
const log=(...a)=>console.log(mask(a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')));
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t179_live_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t179-live';
const failures=[];let core,pool,checks=0;const aufraeumen=[];
function check(ok,label,info){checks++;if(ok){log('OK '+label);return;}failures.push(label);log('FAIL '+label+(info!==undefined?' | DEBUG tatsaechlich: '+JSON.stringify(info).slice(0,600):''));}

/** Echten api-worker im Wrapper-Modus mit einem Auftrag starten; liefert das result-Ereignis und die Ausgabezeilen. */
async function worker({name,token,auftrag,basis,home}){
 const env={...process.env};
 for(const k of ['SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','DATABASE_URL','SYNAPSE_DATABASE_URL'])delete env[k];
 const projektPfad=await mkdtemp(join(tmpdir(),'t179-live-proj-'));aufraeumen.push(()=>rm(projektPfad,{recursive:true,force:true}));
 Object.assign(env,{HOME:home,SYNAPSE_WRAPPER_MODE:'1',SYNAPSE_AGENT_NAME:name,SYNAPSE_AGENT_MODEL:'api-haiku',SYNAPSE_PROJECT_PATH:projektPfad,SYNAPSE_PROJECT_NAME:P,
  SYNAPSE_SESSION_ID:'live-'+name,SYNAPSE_AGENT_TOKEN:token,SYNAPSE_API_URL:basis,SYNAPSE_API_TOKEN:'live-probe-ohne-auth'});
 const kind=spawn(process.execPath,[join(repo,'packages/agents/dist/api-worker.js')],{env,stdio:['pipe','pipe','pipe']});
 const zeilen=[];let rest='';let stderr='';
 const ergebnis=new Promise((ok,nein)=>{
  const t=setTimeout(()=>{kind.kill();nein(Error('Worker '+name+': Zeitlimit 120 s'));},120_000);
  kind.stdout.on('data',d=>{rest+=d;let i;while((i=rest.indexOf('\n'))>=0){const z=rest.slice(0,i);rest=rest.slice(i+1);if(!z.trim())continue;
   let e;try{e=JSON.parse(z);}catch{continue;}zeilen.push(e);if(e.type==='result'){clearTimeout(t);kind.stdin.end();ok(e);}}});
  kind.stderr.on('data',d=>{stderr+=d;});
  kind.on('exit',c=>{clearTimeout(t);if(!zeilen.some(e=>e.type==='result'))nein(Error('Worker '+name+' beendet ohne result (exit '+c+'): '+mask(stderr).slice(-400)));});
 });
 kind.stdin.write(JSON.stringify({type:'user',message:{content:[{type:'text',text:auftrag}]}})+'\n');
 const r=await ergebnis;
 return {result:r,zeilen,stderr:mask(stderr)};
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
  'hauptagent-verlauf-schema','main-warteschlange-schema','agent-verbrauch-schema','agent-api-budget-schema','api-agent-schluessel-schema','api-agent-freigaben-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  await pool.query(Object.values(module).find(v=>typeof v==='string'));
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 await pool.query(`INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max,
   pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit) VALUES
  ('api-haiku','claude-haiku-4-5-20251001','anthropic-api',200000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',73,88,1.00,5.00,0.10,'2025-02-28',64000)
  ON CONFLICT (alias) DO NOTHING`);
 const C=core,USER={art:'user'};
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Live T179 Ausweis-Kern'},{system:'user'});
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten',aktiv:true,grund:'Live T179 api_agenten EIN'},{system:'user'});
 await C.setzeApiSchalter(USER,{aktiv:true,grund:'Live T179 Funktion api EIN (nur Testinstanz)'});
 await C.setzeApiBudget(USER,{grenze_usd:GRENZE_USD,zeitraum:'tag',erlaubte_modelle:['api-haiku'],grund:'Live T179 Budget 0,30 USD nur Haiku'});
 await C.setzeApiEinstellungen(USER,{werte:{max_tokens_obergrenze:512,toolrunden_max:3,laufzeit_minuten:2},grund:'Live T179 kleine Aufrufe'});
 const vor=(name,rolle)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name,rolle,grund:'Live T179 '+name},USER);
 const W=await vor('live-arbeit','subagent'),K=await vor('live-koord','koordinator'),O=await vor('live-ohne','subagent');
 await C.setzeApiFreigabe(USER,{identity_id:W.identity_id,modelle:['api-haiku'],grenze_usd:0.10,grund:'Live T179 Arbeitsagent'});
 await C.setzeApiFreigabe(USER,{identity_id:K.identity_id,modelle:['api-haiku'],grenze_usd:0.10,grund:'Live T179 Koordinator'});
 const fw=await C.leseApiFreigabe(W.identity_id),fk=await C.leseApiFreigabe(K.identity_id);
 check(fw?.heartbeat===false&&fk?.heartbeat===false&&!(await C.leseApiFreigabe(O.identity_id)),'Freigaben: Arbeitsagent + Koordinator (Heartbeat AUS), dritter Agent OHNE Freigabe');

 // Lokale Testinstanz: Transport-Routen + minimaler MCP-Endpunkt (keine Werkzeuge, chat anmelden quittiert) auf 127.0.0.1:<frei>.
 const Fastify=requireApi('fastify');
 const R=await load('packages/rest-api/dist/routes/agent-api.js');
 const f=Fastify({logger:false});await R.agentApiRoutes(f);
 f.post('/mcp/messages',async req=>{const b=req.body??{};
  if(b.method==='tools/list')return {jsonrpc:'2.0',id:b.id,result:{tools:[]}};
  if(b.method==='tools/call')return {jsonrpc:'2.0',id:b.id,result:{content:[{type:'text',text:'Angemeldet (Live-Probe P22-T179, keine Synapse-Werkzeuge).'}]}};
  return {jsonrpc:'2.0',id:b.id,result:{}};});
 await f.listen({host:'127.0.0.1',port:0});aufraeumen.push(()=>f.close());
 const basis='http://127.0.0.1:'+f.server.address().port;
 const home=await mkdtemp(join(tmpdir(),'t179-live-home-'));aufraeumen.push(()=>rm(home,{recursive:true,force:true}));
 log('Testinstanz',{schema,basis});

 const gesamt=async()=>(await C.apiKostenUebersicht()).gesamt.usd;
 const jeIdent=async id=>({
  verbrauch:(await pool.query("SELECT count(*)::int n, COALESCE(sum(usd),0)::float usd, COALESCE(sum(input_tokens),0)::int input, COALESCE(sum(output_tokens),0)::int output FROM agent_verbrauch WHERE identity_id=$1 AND quelle='api_worker'",[id])).rows[0],
  reservierungen:(await pool.query("SELECT count(*)::int n FROM api_agent_reservierungen WHERE identity_id=$1",[id])).rows[0].n,
 });
 const auftraege=[
  {wer:'Arbeitsagent (subagent)',a:W,auftrag:'Kurzer Arbeitsauftrag: Antworte nur mit dem Wort ERLEDIGT.'},
  {wer:'Koordinator',a:K,auftrag:'Kurzer Auftrag als Koordinator: Nenne in hoechstens einem Satz den naechsten Schritt fuer eine Testaufgabe.'},
 ];
 for(const x of auftraege){
  const vorher=await gesamt();
  if(vorher>GRENZE_USD){failures.push('Abbruch: Gesamtkosten '+vorher+' > '+GRENZE_USD);break;}
  const r=await worker({name:x.a.agent_id,token:x.a.token,auftrag:x.auftrag,basis,home});
  const b=await jeIdent(x.a.identity_id);
  log('Antwort '+x.wer+':',{ende:r.result.ende,text:String(r.result.result).slice(0,200),kosten_usd:r.result.kosten_usd});
  check(r.result.ende!=='fehler'&&r.result.ende!=='anbieter_fehler'&&String(r.result.result).trim().length>0,x.wer+': echter Aufruf beantwortet',r.result);
  check(b.verbrauch.n>=1&&b.verbrauch.usd>0&&b.reservierungen>=1,x.wer+': Buchung in agent_verbrauch je Identitaet',b);
  log('Beleg '+x.wer+':',b);
 }
 // Gegenprobe: ohne Freigabe -> abgelehnt, keine Reservierung, 0 Kosten
 const ro=await worker({name:O.agent_id,token:O.token,auftrag:'Antworte mit OK.',basis,home});
 const bo=await jeIdent(O.identity_id);
 log('Gegenprobe ohne Freigabe:',{ende:ro.result.ende,text:String(ro.result.result).slice(0,200)});
 check(/api_freigabe_fehlt/.test(String(ro.result.result))&&bo.verbrauch.n===0&&bo.verbrauch.usd===0&&bo.reservierungen===0,'Gegenprobe ohne Freigabe: abgelehnt (api_freigabe_fehlt), keine Reservierung, 0 USD',{result:ro.result,beleg:bo});
 const k=await C.apiKostenUebersicht();
 const je=Object.fromEntries(k.je_agent.map(z=>[z.identity_id,z]));
 log('Kosten je Agent (apiKostenUebersicht.je_agent):',k.je_agent.map(z=>({agent_id:z.agent_id,aufrufe:z.aufrufe,usd:z.usd,input:z.input_tokens,output:z.output_tokens})));
 log('Gesamt:',k.gesamt);
 check(je[W.identity_id]?.usd>0&&je[K.identity_id]?.usd>0&&!je[O.identity_id],'Kosten je Agent getrennt sichtbar, Gegenprobe ohne Zeile',k.je_agent);
 check(k.gesamt.usd<=GRENZE_USD,'Gesamtkosten '+k.gesamt.usd+' USD <= '+GRENZE_USD+' USD');
 const st=await C.apiAgentenStand(P);
 log('Freigaben-Stand:',st.freigaben.map(z=>({agent_id:z.agent_id,rolle:z.rolle,verbraucht_usd:z.verbraucht_usd,rest_usd:z.rest_usd,heartbeat:z.heartbeat})));
 check(fremd===0,'Netz: nur localhost und api.anthropic.com',fremd);
}catch(e){failures.push('Fehler: '+mask(e.message));log('FEHLER',mask(e.stack));}
finally{
 for(const f of aufraeumen.reverse())await f().catch(()=>undefined);
 await core?.closePool?.().catch?.(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end().catch(()=>undefined);
}
log(failures.length?'FEHLER Live-Probe P22-T179: '+failures.join(' | '):'PASS Live-Probe P22-T179 '+checks+' Pruefungen');
process.exit(failures.length?1:0);
