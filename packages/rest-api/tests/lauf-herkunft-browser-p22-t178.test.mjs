/** P22-T178: Browserabnahme Lauf-Herkunft ('api · haiku') im KI-Browser (privates synapse_test-Schema, echte API-Routen).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/lauf-herkunft-browser-p22-t178.test.mjs
 * Testseite web-ui/tests/agent-task-marke.html (Fixture aus P22-T172: echtes Channel-Fenster ChannelsView + Team-Zeile).
 * Sichert ab (Task P22-T178, User 26.10.2026 ~01:35):
 *   1 Schalter agent_lauf_herkunft AUS: keine Herkunft-Marke (Altverhalten), Namen und Task-Marken wie bisher.
 *   2 EIN: Channel-Agentenleiste 'claude-a · api · haiku' (API-Agent) und 'claude-b · cli · opus' (Abo-CLI), Channel-Absender mit Herkunft,
 *     Tooltip mit Quelle (LaufHerkunftMarke.tsx, SynapseWorkspaceMock.tsx). 3 hell: Darstellung.
 *   Screenshots: ui-screenshots/p22-t178/<lauf-id>/*.png (P25-T7). Jedes Warten hat ein Zeitlimit.
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
// listWrapperStatus liest Identitaets-Wrapperzeilen nur bei Bezugsmodus beide/neu (Prod: beide).
Object.assign(process.env,{SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t178b_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t178-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const HM='P22-T178 LaufHerkunftMarke.tsx (KI-Browser)';
const A=randomUUID(),B=randomUUID();
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
 await pool.query(C.AGENT_AKTUELLE_TASK_SCHEMA_SQL);await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$3,'claude-a','claude-a','subagent','aktiv','t178'),($2,$3,'claude-b','claude-b','subagent','aktiv','t178')`,[A,B,P]);
 await pool.query(`INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled,provider,model) VALUES
  ($1,$3,'claude-a','running',false,NOW(),false,'anthropic-api','api-haiku'),($2,$3,'claude-b','idle',false,NOW(),false,'anthropic','opus')`,[A,B,P]);
 const schalter=async aktiv=>{await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='agent_lauf_herkunft'");
  if(aktiv)await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agent_lauf_herkunft',true,'T178 Browserabnahme','user')",[P]);};
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.register(S.specialistRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/agent-task-marke.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t178'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/agent-task-marke.html?project='+P+'&a='+A+'&b='+B+'&token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await kb('/tabs/new',{url:url(theme)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  await wait(async()=>(await evaluate("document.querySelectorAll('.channel-agent-card').length"))===2,'Channel-Agentenleiste gerendert',30000);};
 const marken=()=>json("JSON.stringify([...document.querySelectorAll('.lauf-herkunft-marke')].map(m=>({karte:m.closest('.channel-agent-card')?.querySelector('strong')?.textContent??null,"
  +"absender:!!m.closest('.channel-messages,article header'),art:m.getAttribute('data-lauf-herkunft'),quelle:m.getAttribute('data-lauf-herkunft-quelle'),text:m.innerText,titel:m.getAttribute('title')})))");

 // ================================================================ 1 Schalter AUS
 await schalter(false);
 await oeffne('dark');
 const aus=await json("fetch('/api/projects/"+P+"/agenten-lauf-herkunft').then(r=>r.json()).then(d=>JSON.stringify({aktiv:d.aktiv,n:d.agenten?.length,quelle:d.schalter?.quelle}))");
 await sleep(1500);
 const m0=await marken();
 ok(aus.aktiv===false&&aus.n===0&&m0.length===0,HM+': Schalter AUS -> keine Herkunft-Marke (Altverhalten)',{aus,m0});
 await shot('dunkel-schalter-aus');

 // ================================================================ 2 Schalter EIN
 await schalter(true);
 await oeffne('dark');
 await wait(async()=>(await marken()).filter(m=>m.karte).length>=2,'Herkunft-Marken in der Agentenleiste',30000);
 const m1=await marken();
 const a=m1.find(x=>x.karte==='claude-a'),b=m1.find(x=>x.karte==='claude-b');
 ok(a&&a.art==='api'&&a.text.replace(/\s+/g,' ').trim()==='· api · haiku'&&a.quelle==='provider:anthropic-api',"P22-T178 SynapseWorkspaceMock.tsx Agentenleiste (KI-Browser): 'claude-a · api · haiku'",m1);
 ok(b&&b.art==='cli'&&/cli · opus/.test(b.text),"P22-T178 SynapseWorkspaceMock.tsx Agentenleiste (KI-Browser): 'claude-b · cli · opus'",m1);
 ok(m1.some(x=>x.absender&&x.art==='api'),'P22-T178 SynapseWorkspaceMock.tsx Channel-Absender (KI-Browser): Nachricht von claude-a mit api-Herkunft',m1);
 ok(/^Läuft über die API/.test(a.titel)&&/Quelle: provider:anthropic-api/.test(a.titel),HM+': Tooltip mit Weg und Quelle (Debug)',a.titel);
 const farbe=await json("JSON.stringify((()=>{const t=document.querySelector('.lauf-herkunft-marke.art-api .lauf-herkunft-text');const s=getComputedStyle(t);return {farbe:s.color,rand:s.borderTopColor,font:s.fontFamily}})())");
 ok(farbe.farbe===farbe.rand&&/Plex Mono|monospace/i.test(farbe.font),HM+': api-Marke in Akzentfarbe mit Rahmen (lauf-herkunft-marke.css)',farbe);
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await sleep(400);
 await shot('dunkel-herkunft');
 ok((await json('JSON.stringify(window.__fehler??[])')).length===0,'P22-T178 Testseite (KI-Browser): keine Seitenfehler',await json('JSON.stringify(window.__fehler??[])'));

 // ================================================================ 3 hell
 await oeffne('light');
 await wait(async()=>(await marken()).filter(m=>m.karte).length>=2,'hell: Herkunft-Marken',30000);
 // KI-Browser: Screenshot erst nach dem Zeichnen (ein Lauf zeigte hell ein Bild vor dem Paint, obwohl die DOM-Pruefung bestand).
 await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');await sleep(400);
 await shot('hell-herkunft');
 ok(true,HM+': helle Darstellung (Screenshot)');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,schalter:'agent_lauf_herkunft (Projekt)'},null,2));
 console.log('PASS P22-T178 Lauf-Herkunft Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
