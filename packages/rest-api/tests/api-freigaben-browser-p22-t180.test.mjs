/** P22-T180: Browserabnahme 'Freigaben je Agent' im KI-Browser (privates synapse_test-Schema, echte API-Routen, kein Key, kein Anbieteraufruf).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-freigaben-browser-p22-t180.test.mjs
 * Testseite web-ui/tests/api-freigaben.html (Fixture api-freigaben-fixture.tsx: ApiBudgetPanel wie Einstellungen > API-Agenten, darin
 *   seit t211 D0 ApiFreigabenFeld mit Grund, busy und senden des Panels).
 * Sichert ab (Task P22-T180; Grundsatz P22-T106 'kostenpflichtig nie automatisch'):
 *   1 dunkel: keine Freigaben, Auswahl mit Arbeitsagent/Koordinator (nie Main), globaler Schalter sichtbar; ohne Grund kein Setzen.
 *   2 Projekt mit Schalter api_agenten AUS: Text AUS, Setzen gesperrt. 3 Arbeitsagent mit Haiku + Grenze per Klick -> Freigabe in Liste und PG,
 *     Heartbeat AUS. 4 Verbrauch/Rest in der Zeile. 5 Entziehen -> leer. 6 hell: gesetzte Freigabe. Keine Seitenfehler.
 *   Screenshots: ui-screenshots/p22-t180/<lauf-id>/*.png (P25-T7). Jedes Warten hat ein Zeitlimit.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ... | screenshot ...'. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
import {isolierterTab} from '../../../scripts/lib/ki-browser-isolation.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_ANTHROPIC_API_KEY','SYNAPSE_ANTHROPIC_WORKSPACE_ID',
 'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'0',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',
 SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t180b_'+process.pid+'_'+randomUUID().slice(0,8);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const P='p22-t180-a',P2='p22-t180-b',USER={art:'user'};
let C,pool,app,vite,tab,failure,checks=0,letzterShot='';
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
 console.error('DEBUG Timeout '+label+' | screenshot '+letzterShot+' | seitenfehler '+kurz(await json('JSON.stringify(window.__fehler??[])').catch(()=>'?')));throw Error('Timeout: '+label);};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert und letztem Screenshot.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):'')+' | screenshot '+letzterShot);assert(value,label);console.log('OK '+label);};
const HF='P22-T180 ApiFreigabenFeld.tsx (KI-Browser)';
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
 await pool.query(`INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max,
   pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit) VALUES
  ('api-sonnet','claude-sonnet-5-5','anthropic-api',1000000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',80,97,2.00,10.00,0.20,'2026-06-01',128000),
  ('api-haiku','claude-haiku-4-5-20251001','anthropic-api',200000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',73,88,1.00,5.00,0.10,'2025-02-28',64000)
  ON CONFLICT (alias) DO NOTHING`);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T180 alle'},{system:'user'});
 const vor=(project,name,rolle)=>C.W12_DIENSTE.ausweis.agentVorbereiten({project,name,rolle,grund:'Test T180 '+name},USER);
 const W=await vor(P,'t180-arbeit','subagent'),K=await vor(P,'t180-koord','koordinator'),W2=await vor(P2,'t180-anders','subagent');
 const MAIN='t180b-main-'+process.pid;
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,'hauptagent',1,'hauptagent','main','test')",[MAIN,C.HAUPTAGENT_PROJEKT]);
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'api_agenten',aktiv:true,grund:'Test T180 api_agenten EIN'},{system:'user'});
 const freigaben=async()=>(await pool.query('SELECT identity_id, heartbeat, grenze_usd::float AS grenze, modelle FROM api_agent_freigaben')).rows;

 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/api-freigaben.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t180'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{await evaluate("document.querySelector('[data-api-freigaben]')?.scrollIntoView({block:'start'})");const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/api-freigaben.html?token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(theme)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  await wait(async()=>!!(await evaluate("!!document.querySelector('[data-api-freigabe-formular] select option[value]:not([value=\"\"])')")),'Freigaben und Kandidaten geladen',30000);};
 const S_=JSON.stringify;
 const lage=()=>json("(()=>{const f=document.querySelector('[data-api-freigaben]');const form=f.querySelector('[data-api-freigabe-formular]');"
  +"return JSON.stringify({anzahl:f.getAttribute('data-api-freigaben'),leer:!!f.querySelector('[data-api-freigaben-leer]'),kopf:f.querySelector('small').innerText.replace(/\\s+/g,' '),"
  +"optionen:[...form.querySelectorAll('option')].map(o=>({v:o.value,t:o.textContent})),schalter:form.querySelector('[data-api-agenten-schalter]')?.getAttribute('data-api-agenten-schalter')??null,"
  +"schalterText:form.querySelector('[data-api-agenten-schalter]')?.innerText??'',haken:[...form.querySelectorAll('label')].filter(x=>x.querySelector('input[type=checkbox]')).map(x=>({t:x.textContent.trim(),an:x.querySelector('input').checked})),"
  +"zeilen:[...f.querySelectorAll('[data-api-freigabe]')].map(z=>({id:z.getAttribute('data-api-freigabe'),schalter:z.getAttribute('data-api-agenten-schalter'),text:z.querySelector('[data-api-freigabe-zeile]')?.innerText??''})),"
  +"status:[...document.querySelectorAll('.scope-warning')].find(x=>x.querySelector('b')?.textContent==='Status')?.innerText??''})})()");
 const tippe=(sel,wert)=>evaluate("(()=>{const e=document.querySelector("+S_(sel)+");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,"+S_(wert)+");e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
 const waehle=id=>evaluate("(()=>{const e=document.querySelector('[data-api-freigabe-formular] select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,"+S_(id)+");e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()");
 const knopf=text=>evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==="+S_(text)+");if(!b)return 'fehlt';if(b.disabled)return 'gesperrt';b.click();return 'ok'})()");

 // ================================================================ 1 dunkel: Ausgangslage
 await oeffne('dark');
 let l=await lage();
 const werte=l.optionen.map(o=>o.v);
 ok(l.anzahl==='0'&&l.leer&&[W.identity_id,K.identity_id,W2.identity_id].every(i=>werte.includes(i))&&!werte.includes(MAIN),HF+': keine Freigaben, Auswahl Arbeitsagent/Koordinator beider Projekte, nie der Main',l);
 ok(/Schalter api_agenten \(global\): (EIN|AUS)/.test(l.kopf)&&/nie automatisch/.test(l.kopf),HF+': globaler Schalter und Hinweis kostenpflichtig nie automatisch sichtbar',l.kopf);
 await shot('dunkel-ausgangslage');
 await waehle(W.identity_id);
 await wait(async()=>(await lage()).schalter==='ein','Schalter-Zeile fuer Projekt A');
 ok((await knopf('Freigabe setzen'))==='gesperrt',HF+': ohne Grund kein Setzen');

 // ================================================================ 2 Projekt mit Schalter AUS
 await tippe('input[placeholder^="z. B. Tageslimit"]','Arbeitsagent darf per Haiku arbeiten T180');
 await waehle(W2.identity_id);
 await wait(async()=>(await lage()).schalter==='aus','Schalter-Zeile fuer Projekt B');
 l=await lage();
 ok(/AUS/.test(l.schalterText)&&/abgelehnt/.test(l.schalterText)&&(await knopf('Freigabe setzen'))==='gesperrt',HF+': Projekt mit api_agenten AUS -> Text AUS, Setzen gesperrt',l.schalterText);
 await shot('dunkel-schalter-aus');

 // ================================================================ 3 Freigabe per Klick setzen
 await waehle(W.identity_id);
 await wait(async()=>(await lage()).schalter==='ein','Schalter EIN');
 l=await lage();
 const an=t=>l.haken.find(h=>h.t.startsWith(t))?.an;
 ok(l.haken.filter(h=>h.t.startsWith('api-')&&h.an).map(h=>h.t).join()==='api-haiku'&&an('Heartbeat')===false&&an('aktiv')===true,
  HF+': Vorschlag nur Haiku, Heartbeat AUS, aktiv (kostenpflichtig nie automatisch)',l.haken);
 await tippe('[data-api-freigabe-formular] input[type=number]','0.5');
 ok((await knopf('Freigabe setzen'))==='ok',HF+': Freigabe setzen ausloesbar');
 await wait(async()=>(await lage()).zeilen.length===1,'Freigabe in der Liste');
 l=await lage();
 const pg=await freigaben();
 ok(l.zeilen[0].id===W.identity_id&&l.zeilen[0].schalter==='ein'&&/Grenze 0\.5000 USD/.test(l.zeilen[0].text)&&/Heartbeat AUS/.test(l.zeilen[0].text)&&/gesetzt von User/.test(l.zeilen[0].text)
  &&pg.length===1&&pg[0].heartbeat===false&&pg[0].grenze===0.5&&pg[0].modelle.join()==='api-haiku',HF+': Freigabe in Liste und PG (Haiku, Grenze 0.5, Heartbeat AUS, User)',{l:l.zeilen,pg});
 await shot('dunkel-freigabe-gesetzt');

 // ================================================================ 4 Verbrauch und Rest
 await C.setzeApiSchalter(USER,{aktiv:true,grund:'Test T180 api EIN'});
 await C.setzeApiBudget(USER,{grenze_usd:5,zeitraum:'monat',reset_tag:1,erlaubte_modelle:['api-haiku','api-sonnet'],grund:'Test T180 Budget'});
 const res=await C.reserviereApiAufruf({identity_id:W.identity_id,project:P,agent_id:W.agent_id,modell:'api-haiku',eingabe_zeichen:300,max_tokens:500,zugang:'agent'});
 await C.schliesseApiAufrufAb({reservierung_id:res.reservierung_id,agent_id:W.agent_id,usage:{input_tokens:1000,output_tokens:100}});
 await oeffne('dark');
 await wait(async()=>/verbraucht 0\.0015 USD/.test((await lage()).zeilen[0]?.text??''),'Verbrauch sichtbar');
 l=await lage();
 ok(/verbraucht 0\.0015 USD · Rest 0\.4985 USD/.test(l.zeilen[0].text),HF+': Verbrauch und Rest je Agent in der Zeile',l.zeilen[0].text);
 await shot('dunkel-verbrauch');

 // ================================================================ 5 Entziehen
 await tippe('input[placeholder^="z. B. Tageslimit"]','Freigabe wieder entziehen T180');
 ok((await knopf('Entziehen'))==='ok',HF+': Entziehen ausloesbar');
 await wait(async()=>(await lage()).leer,'Freigabe entzogen');
 ok((await freigaben()).length===0&&/entzogen/.test((await lage()).status),HF+': entzogen, PG leer, Statusmeldung',await lage());
 const seitenfehler=await json('JSON.stringify(window.__fehler??[])');
 ok(seitenfehler.length===0,'P22-T180 Testseite (KI-Browser): keine Seitenfehler',seitenfehler);

 // ================================================================ 6 hell (Freigabe ueber die echte Route gesetzt)
 const p=await fetch(api+'/api/main-agent/api/freigaben',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+sitzung},
  body:JSON.stringify({identity_id:K.identity_id,modelle:['api-haiku','api-sonnet'],grenze_usd:null,heartbeat:false,aktiv:true,grund:'T180 helle Darstellung'})});
 ok(p.status===200,'P22-T180 agent-api.ts PUT /api/main-agent/api/freigaben (Koordinator, nur globales Budget)',p.status);
 await oeffne('light');
 await wait(async()=>(await lage()).zeilen.length===1,'hell: Freigabe sichtbar');
 l=await lage();
 ok(/Grenze nur globales Budget/.test(l.zeilen[0].text)&&/Modelle api-haiku, api-sonnet/.test(l.zeilen[0].text),HF+': hell, Koordinator mit nur globalem Budget',l.zeilen[0].text);
 await shot('hell-freigabe');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,hinweis:'kein Key, kein Anbieteraufruf'},null,2));
 console.log('PASS P22-T180 Freigaben Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
