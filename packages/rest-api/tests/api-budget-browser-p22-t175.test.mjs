/** P22-T175: Browserabnahme API-Budget im KI-Browser (privates synapse_test-Schema, echte API-Routen, kein echter Key, kein Anbieter-Aufruf).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-budget-browser-p22-t175.test.mjs
 * Testseite web-ui/tests/api-budget.html (Fixture api-budget-fixture.tsx: ApiBudgetPanel wie Einstellungen > API-Agenten).
 * Sichert ab (Task P22-T175; User inbox 1276 '25 euro grenze am tag, wo api key hinterlegen'):
 *   1 Ohne Key, ohne Budget: 'API-Key vorhanden: nein' mit Ort (secrets.env), Vorschlag 25 / tag / api-haiku+api-sonnet vorbelegt (ApiBudgetPanel.tsx).
 *   2 'Budget setzen' ueber die echte Route PUT /api/main-agent/api/budget -> api_agent_budget 25 USD je tag, Haiku + Sonnet (api-agent-dienst.ts).
 *   3 Gebuchte/offene Reservierung -> Budgetzeile gebucht/offen/Rest (budgetZeile in api-budget-logik.ts).
 *   4 Fake-Key in der Prozessumgebung -> 'API-Key vorhanden: ja', der Wert steht weder in der Seite noch in der API-Antwort.
 *   5 Nur User: ohne Web-UI-Sitzung 401 (Guard agent-runtimes.ts), Budget unveraendert. 6 hell: Darstellung.
 *   Screenshots: ui-screenshots/p22-t175/<lauf-id>/*.png (P25-T7). Jedes Warten hat ein Zeitlimit.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ... | screenshot ...'. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','SYNAPSE_HAUPTAGENT_API'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'0',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1',ANTHROPIC_BASE_URL:'http://127.0.0.1:9'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t175b_'+process.pid+'_'+randomUUID().slice(0,8);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const FAKE_KEY='sk-ant-test-p22t175-'+randomUUID();
let C,pool,app,vite,tab,failure,checks=0,letzterShot='';
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
 console.error('DEBUG Timeout '+label+' | screenshot '+letzterShot+' | seitenfehler '+JSON.stringify(await evaluate('JSON.stringify(window.__fehler??[])').catch(()=>'?')));throw Error('Timeout: '+label);};
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert und letztem Screenshot.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):'')+' | screenshot '+letzterShot);assert(value,label);console.log('OK '+label);};
const HP='P22-T175 ApiBudgetPanel.tsx (KI-Browser)';
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
 await pool.query(C.AGENT_API_BUDGET_SCHEMA_SQL);
 // API-Modelle wie der Seed in schema.ts (P22-T8), nur im privaten Schema.
 await pool.query(`INSERT INTO model_registry (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max,
   pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit) VALUES
  ('api-opus','claude-opus-5-5','anthropic-api',1000000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',80,97,4.00,20.00,0.20,'2026-06-01',128000),
  ('api-sonnet','claude-sonnet-5-5','anthropic-api',1000000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',80,97,2.00,10.00,0.20,'2026-06-01',128000),
  ('api-haiku','claude-haiku-4-5-20251001','anthropic-api',200000,ARRAY[]::TEXT[],'node','@synapse/agents/api-worker',73,88,1.00,5.00,0.10,'2025-02-28',64000)
  ON CONFLICT (alias) DO NOTHING`);
 await pool.query('DELETE FROM api_agent_budget');await pool.query('DELETE FROM api_agent_reservierungen');
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/api-budget.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t175'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/api-budget.html?token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await kb('/tabs/new',{url:url(theme)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  await wait(async()=>['ja','nein'].includes(await evaluate("document.querySelector('[data-api-key-vorhanden]')?.getAttribute('data-api-key-vorhanden')??''")),'Status geladen',30000);};
 const keyBlock=()=>json("(()=>{const k=document.querySelector('[data-api-key-vorhanden]');return JSON.stringify({wert:k.getAttribute('data-api-key-vorhanden'),text:k.innerText.replace(/\\s+/g,' ').trim()})})()");
 const zeile=()=>evaluate("document.querySelector('[data-budget-zeile]')?.innerText.replace(/\\s+/g,' ').trim()??''");
 const S_=JSON.stringify;
 // React-kontrollierte Eingabe: Wert ueber den nativen Setter, dann input-Event.
 const tippe=(sel,wert)=>evaluate("(()=>{const e=document.querySelector("+S_(sel)+");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,"+S_(wert)+");e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
 const knopf=text=>evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==="+S_(text)+");if(!b)return 'fehlt';if(b.disabled)return 'gesperrt';b.click();return 'ok'})()");

 // ================================================================ 1 ohne Key, ohne Budget: Ort + Vorschlag
 await oeffne('dark');
 const k1=await keyBlock();
 ok(k1.wert==='nein'&&/API-Key vorhanden: nein/.test(k1.text)&&k1.text.includes('SYNAPSE_ANTHROPIC_API_KEY=… in ~/.config/synapse/secrets.env'),HP+': ohne Key "nein" mit Ort zum Hinterlegen',k1);
 const form=await json("JSON.stringify({grenze:document.querySelector('input[type=number][step=\"0.01\"]').value,zeitraum:document.querySelector('select').value,"
  +"reset:document.querySelector('input[min=\"1\"][max=\"28\"]').disabled,modelle:[...document.querySelectorAll('input[type=checkbox]')].filter(c=>c.checked).map(c=>c.parentElement.textContent.trim().split(' ')[0]),"
  +"vorschlag:!!document.querySelector('[data-api-budget-vorschlag]'),budget:document.querySelector('[data-api-budget]')?.getAttribute('data-api-budget')})");
 ok(form.grenze==='25'&&form.zeitraum==='tag'&&form.reset===true&&form.modelle.join()==='api-haiku,api-sonnet'&&form.vorschlag&&form.budget==='fehlt',HP+': Vorschlag 25 / tag / Haiku + Sonnet vorbelegt, Reset-Tag gesperrt, Budget fehlt',form);
 await shot('dunkel-ohne-key-vorschlag');

 // ================================================================ 2 Budget setzen ueber die echte Route
 ok((await knopf('Budget setzen'))==='gesperrt',HP+': ohne Grund kein Setzen (Grund Pflicht)');
 await tippe('input[placeholder^="z. B. Tageslimit"]','Tageslimit 25 USD Browserabnahme T175');
 ok((await knopf('Budget setzen'))==='ok',HP+': Budget setzen ausloesbar');
 await wait(async()=>/^Grenze 25\.0000 USD je Tag/.test(await zeile()),'Budgetzeile nach dem Setzen');
 const b=(await pool.query('SELECT grenze_usd::float AS g, zeitraum, erlaubte_modelle, gesetzt_von FROM api_agent_budget WHERE id=1')).rows[0];
 ok(b&&b.g===25&&b.zeitraum==='tag'&&[...b.erlaubte_modelle].sort().join()==='api-haiku,api-sonnet'&&b.gesetzt_von==='user','P22-T175 api-agent-dienst.ts setzeApiBudget (ueber PUT /api/main-agent/api/budget): 25 USD je tag, Haiku + Sonnet, gesetzt_von user',b);
 ok(!(await evaluate("!!document.querySelector('[data-api-budget-vorschlag]')"))&&(await evaluate("document.querySelector('[data-api-budget]').getAttribute('data-api-budget')"))==='gesetzt',HP+': nach dem Setzen kein Vorschlag mehr');

 // ================================================================ 3 Reservierungen -> gebucht/offen/Rest
 await pool.query(`INSERT INTO api_agent_reservierungen (id, project, modell, anbieter_modell, reserviert_usd, status, usd, usd_quelle, frist_bis) VALUES
  ($1,'synapse-hauptagent','api-sonnet','claude-sonnet-5-5',2,'gebucht',1.5,'antwort',NOW()+interval '10 minutes'),
  ($2,'synapse-hauptagent','api-haiku','claude-haiku-4-5-20251001',0.5,'offen',NULL,NULL,NOW()+interval '10 minutes')`,[randomUUID(),randomUUID()]);
 ok((await knopf('Neu laden'))==='ok',HP+': Neu laden');
 await wait(async()=>/gebucht 1\.5000 USD/.test(await zeile()),'Budgetzeile mit Buchung');
 const z3=await zeile();
 ok(/gebucht 1\.5000 USD · offen 0\.5000 USD · Rest 23\.0000 USD$/.test(z3),HP+': Budgetzeile gebucht/offen/Rest',z3);
 await shot('dunkel-budget-gesetzt');

 // ================================================================ 4 Fake-Key in der Umgebung -> ja, Wert nirgends sichtbar
 process.env.SYNAPSE_ANTHROPIC_API_KEY=FAKE_KEY;
 await oeffne('dark');
 const k4=await keyBlock();
 ok(k4.wert==='ja'&&/API-Key vorhanden: ja/.test(k4.text)&&/nie angezeigt/.test(k4.text),HP+': mit Key "ja"',k4);
 const seite=await evaluate('document.documentElement.outerHTML');
 const roh=await (await fetch(api+'/api/main-agent/api',{headers:{authorization:'Bearer '+sitzung}})).text();
 ok(!seite.includes(FAKE_KEY)&&!roh.includes(FAKE_KEY)&&!roh.includes('sk-ant-')&&JSON.parse(roh).api_key_vorhanden===true,'P22-T175 agent-api.ts GET /api/main-agent/api + Seite: nur ja/nein, kein Key-Wert',{seite:seite.length,roh:roh.slice(0,200)});
 await shot('dunkel-key-vorhanden');
 const seitenfehler=await json('JSON.stringify(window.__fehler??[])');
 ok(seitenfehler.length===0,'P22-T175 Testseite (KI-Browser): keine Seitenfehler',seitenfehler);

 // ================================================================ 5 nur User: ohne Sitzung kein Zugriff
 const ohne=await fetch(api+'/api/main-agent/api/budget',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({grenze_usd:1000,zeitraum:'monat',erlaubte_modelle:['api-opus'],grund:'ohne Sitzung'})});
 const b5=(await pool.query('SELECT grenze_usd::float AS g FROM api_agent_budget WHERE id=1')).rows[0];
 ok(ohne.status===401&&b5.g===25,'P22-T175 agent-runtimes.ts Guard: PUT /api/main-agent/api/budget ohne Web-UI-Sitzung -> 401, Budget unveraendert',{status:ohne.status,b5});

 // ================================================================ 6 hell
 await oeffne('light');
 await wait(async()=>/^Grenze 25\.0000 USD je Tag/.test(await zeile()),'hell: Budgetzeile');
 await shot('hell-budget-gesetzt');
 ok(true,HP+': helle Darstellung (Screenshot)');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,key:'nur Fake-Key in der Prozessumgebung, nie angezeigt'},null,2));
 console.log('PASS P22-T175 API-Budget Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 delete process.env.SYNAPSE_ANTHROPIC_API_KEY;
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
