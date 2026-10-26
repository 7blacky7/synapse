/** P22-T165: Browserabnahme anklickbarer Artefakte im KI-Browser (privates synapse_test-Schema, echte API, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-verweise-browser-p22-t165.test.mjs
 * Fixture: Vorlage (modus live) mit Quelle plan.alle: ein Radio je Plan, Verweis je Task, Plan-Link; fertiger Main-Chat-Block mit
 * mehrdeutigem Wert und Thought-Link. Prueft dunkel und hell: Schalter AUS = kein Lesefenster; EIN: Plan-Navigation per CSS, Task-Klick ->
 * Lesefenster mit Beschreibung, Plan-Link ohne Hash-Aenderung, live-Update ohne Aufbau-Animation mit erhaltener Plan-Auswahl,
 * mehrdeutig -> Auswahl, Thought; Persoenliche Artefakte und Top-Artefakte. Screenshots: ui-screenshots/p22-t165/<lauf-id>/ (P25-T7). */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t165_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t165-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,120));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,500):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const belege={};
const TH1='abcd1234-0000-4000-8000-'+randomUUID().slice(-12),TH2='abcd1234-1111-4000-8000-'+randomUUID().slice(-12);
const task=(plan,nr,status,titel)=>({id:randomUUID(),kurz_id:plan+'-T'+nr,title:titel,description:'Beschreibung '+plan+'-T'+nr+': voll lesbar im Lesefenster.',status,priority:'medium',
 createdAt:'2026-10-2'+nr+'T10:00:00Z',updatedAt:'2026-10-2'+nr+'T10:00:00Z'});
const P1=[task('P1',1,'done','Quelle plan.alle'),task('P1',2,'done','Verweis-Muster'),task('P1',3,'in_progress','Zustand ueber Live-Updates'),task('P1',4,'todo','Browserabnahme')];
const P2=[task('P2',1,'todo','Nebenaufgabe eins'),task('P2',2,'blocked','Nebenaufgabe zwei')];
// Vorlage: Radio je Plan (CSS-Navigation ohne Skript), Verweis je Task, Plan-Link; Farben folgen dem Theme der Web-UI (:host-context).
const VORLAGE='<div class="pf" data-synapse-projekt="{{_meta.project}}"><style>'
 +'.pf{--bg:#f7f5f0;--ink:#1d1d22;--mut:#6b6b73;--acc:#b8761a;--line:#ddd6c9;background:var(--bg);color:var(--ink);font:14px system-ui;padding:14px 16px;border-radius:12px}'
 +':host-context([data-theme="dark"]) .pf{--bg:#11151c;--ink:#e6e9ef;--mut:#9aa3b2;--acc:#e0a24a;--line:#273041}'
 +'.pf h2{margin:0 0 10px;font-size:17px}.pf input[type=radio]{position:absolute;opacity:0;pointer-events:none}'
 +'.pf .tabs{display:flex;gap:6px;margin-bottom:10px}.pf .tabs label{padding:4px 10px;border:1px solid var(--line);border-radius:999px;cursor:pointer;color:var(--mut)}'
 +'.pf .v{display:none}.pf .v ul{list-style:none;margin:6px 0 0;padding:0}.pf .v li{display:flex;gap:8px;padding:5px 0;border-top:1px solid var(--line)}'
 +'.pf [data-synapse-verweis]{color:var(--acc);text-decoration:underline}.pf .st{font:11px ui-monospace,monospace;color:var(--mut);min-width:84px}.pf a{color:var(--acc)}'
 +'{{#each plan.plaene as p}}#r-{{p.kurz_id}}:checked~.ansichten .v-{{p.kurz_id}}{display:block}#r-{{p.kurz_id}}:checked~.tabs label[for="r-{{p.kurz_id}}"]{background:var(--acc);color:var(--bg);border-color:var(--acc)}{{/each}}'
 +'</style><h2>Projektfortschritt · {{_meta.project}}</h2>'
 +'{{#each plan.plaene as p}}<input type="radio" name="plan" id="r-{{p.kurz_id}}" {{#if @erster}}checked{{/if}}>{{/each}}'
 +'<div class="tabs">{{#each plan.plaene as p}}<label for="r-{{p.kurz_id}}">{{p.kurz_id}} · {{p.tasks_erledigt}}/{{p.tasks_gesamt}}</label>{{/each}}</div>'
 +'<div class="ansichten">{{#each plan.plaene as p}}<section class="v v-{{p.kurz_id}}"><a href="#verweis:{{p.kurz_id}}">{{p.kurz_id}} {{p.name}}</a><ul>'
 +'{{#each p.tasks as t}}<li><span class="st">{{t.status}}</span><span data-synapse-verweis="{{t.kurz_id}}">{{t.kurz_id}} {{t.title}}</span></li>{{/each}}</ul></section>{{/each}}</div></div>';
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
 for(const sql of [C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL,C.ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL,C.ARTEFAKT_VORLAGEN_SCHEMA_SQL])await pool.query(sql);
 const schalter=async(f,aktiv)=>{await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T165 Browser-Fixture','user')",[f,aktiv]);};
 for(const f of ['artefakt_bewertung','artefakt_vorlagen','artefakt_vorlagen_live','artefakt_ausweis_zeigen'])await schalter(f,true);
 await C.setzeArtefaktVorlagenEinstellungen({drossel_ms:1000,buendel_ms:200},'T165 Browserabnahme: schneller live','user');
 const KOORD=randomUUID();
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t165')",[KOORD,P]);
 const PLAN2=randomUUID();
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Artefakte interaktiv','',$3::jsonb,true,'P1','hoch')",[randomUUID(),P,JSON.stringify(P1)]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Nebenplan','',$3::jsonb,false,'P2','niedrig')",[PLAN2,P,JSON.stringify(P2)]);
 for(const [id,text] of [[TH1,'Entwurf: Artefakte interaktiv (Thought eins)'],[TH2,'Abschluss: Artefakte interaktiv (Thought zwei)']])
  await pool.query("INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,'t165',$3,ARRAY['t165'])",[id,P,text]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const AT=await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
 const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
 const tool=(args)=>C.mitAgentAufrufKontext({principal:{art:'identity',project:P,agent_id:'koordinator',identity_id:KOORD,rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null},bezug},()=>AT.fuehreArtefaktAus(args,'koordinator'));
 const j=await tool({action:'zeigen',titel:'Projektfortschritt (interaktiv)',vorlage:VORLAGE,quellen:[{name:'plan',vertrag:'plan.alle'}],modus:'live'});
 assert.equal(j.success,true,JSON.stringify(j));const A=j.artefakt_id;
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.ready();
 const bw=(await app.inject({method:'POST',url:'/api/agent-runtimes/artefakt-bewertung',payload:{quelle_art:'artefakt',quelle_ref:A,urteil:'hoch',kommentar:'Plaene anklickbar'}})).json();
 assert.equal(bw.success,true,JSON.stringify(bw));
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t165/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t165'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(f,Buffer.from(await r.arrayBuffer())));};
 const oeffne=async(theme,ansicht)=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await kb('/tabs/new',{url:ui+'/tests/artefakt-verweise.html?project='+P+'&theme='+theme+'&ansicht='+ansicht+'&artefakt='+A+'&th='+TH1})).tab_id;};
 // Shadow-Roots: Vorlage (erste Flaeche mit .pf) und Main-Block.
 const SR="[...document.querySelectorAll('.agent-rendering-shadow')].map(h=>h.shadowRoot).find(s=>s&&s.querySelector('.pf'))";
 const SM="[...document.querySelectorAll('.agent-rendering-shadow')].map(h=>h.shadowRoot).find(s=>s&&s.querySelector('[data-fixture=main-block]'))";
 const klickIn=(sr,sel)=>evaluate('(()=>{const s='+sr+';const e=s&&s.querySelector('+JSON.stringify(sel)+');if(!e)return false;e.click();return true})()');
 const fenster=()=>evaluate("JSON.stringify([...document.querySelectorAll('.verweis-fenster')].map(f=>({art:f.querySelector('.verweis-titel small')?.textContent,titel:f.querySelector('.verweis-titel strong')?.textContent,text:f.querySelector('.verweis-inhalt')?.innerText})))").then(v=>typeof v==='string'?JSON.parse(v):(v??[]));
 const schliesseFenster=()=>evaluate("(()=>{const b=[...document.querySelectorAll('.verweis-fenster .verweis-titel button')];b.forEach(x=>x.click());return b.length})()");
 const sichtbar=(sel)=>evaluate('(()=>{const s='+SR+';const e=s&&s.querySelector('+JSON.stringify(sel)+');return !!e&&getComputedStyle(e).display!=="none"})()');
 const lauf=async(theme)=>{
  const T=theme==='dark'?'dunkel':'hell';
  // P25-T16: Seit P22-T169 (User 25.10.2026, thought 403c12bd) merkt die Vorlage die Plan-Auswahl je Artefakt und Betrachter im
  // localStorage (synapse-artefakt-zustand:artefakt:<id>). Der dunkle Durchgang waehlt P2; ohne Aufraeumen startete der helle
  // Durchgang (gleicher Vite-Origin) mit P2. Jeder Durchgang leert deshalb im ersten Tab (Schalter AUS: nichts wird gemerkt oder
  // eingesetzt) die gemerkten Zustaende, bevor der Tab mit Schalter EIN oeffnet.
  // Schalter AUS: Klick bleibt wirkungslos (Bestand)
  await schalter('artefakt_verweise',false);
  await oeffne(theme,'koordinator');
  await wait(()=>evaluate('!!('+SR+')?.querySelector("[data-synapse-verweis=\'P1-T4\']")'),T+': Vorlage mit plan.alle gerendert');
  const geleert=await evaluate("(()=>{const k=Object.keys(localStorage).filter(x=>x.startsWith('synapse-artefakt-zustand:'));k.forEach(x=>localStorage.removeItem(x));return k.length})()");
  console.log('P25-T16 '+T+': gemerkte Artefakt-Zustaende geleert: '+JSON.stringify(geleert));
  await sleep(700);
  ok(await klickIn(SR,'[data-synapse-verweis="P1-T4"]'),T+': Klick bei Schalter AUS');await sleep(800);
  ok((await fenster()).length===0,T+': Schalter AUS -> kein Lesefenster (Bestand)');
  // Schalter EIN (neuer Tab, damit der 30-s-Cache neu fragt)
  await schalter('artefakt_verweise',true);
  await oeffne(theme,'koordinator');
  await wait(()=>evaluate('!!('+SR+')?.querySelector("[data-synapse-verweis=\'P1-T4\']")'),T+': Vorlage geladen');
  await sleep(900);
  const startOk=await sichtbar('.v-P1')&&!(await sichtbar('.v-P2'));
  if(!startOk)console.error('DEBUG '+T+' Start | '+JSON.stringify(await evaluate("(()=>{const s="+SR+";const v=c=>{const e=s&&s.querySelector(c);return e?getComputedStyle(e).display:'fehlt'};return JSON.stringify({p1:v('.v-P1'),p2:v('.v-P2'),radios:s?[...s.querySelectorAll('input[type=radio]')].map(r=>r.id+'='+r.checked):null,gemerkt:Object.keys(localStorage).filter(x=>x.startsWith('synapse-artefakt-zustand:')).map(x=>x+'='+localStorage.getItem(x).slice(0,160)),theme:document.documentElement.dataset.theme||document.documentElement.className})})()")));
  ok(startOk,T+': Start: Plan P1 sichtbar, P2 verborgen');
  await shot(T+'-koordinator-p1');
  ok(await klickIn(SR,'label[for="r-P2"]'),T+': Plan P2 anklicken (Radio-Label)');
  await wait(()=>sichtbar('.v-P2'),T+': Plan P2 sichtbar');ok(!(await sichtbar('.v-P1')),T+': Plan P1 verborgen (CSS-Navigation ohne Skript)');
  ok(await klickIn(SR,'[data-synapse-verweis="P2-T1"]'),T+': Task P2-T1 anklicken');
  await wait(async()=>(await fenster()).some(f=>/Beschreibung P2-T1/.test(f.text||'')),T+': Lesefenster mit voller Task-Beschreibung');
  let fs=await fenster();ok(fs[0].art==='Task'&&/Nebenaufgabe eins/.test(fs[0].titel||''),T+': Lesefenster Task mit Titel',fs);
  await sleep(400);await shot(T+'-koordinator-task-lesefenster');
  await schliesseFenster();
  ok(await klickIn(SR,'a[href="#verweis:P2"]'),T+': Plan-Link #verweis:P2 anklicken');
  await wait(async()=>(await fenster()).some(f=>f.art==='Plan'&&/Nebenplan/.test(f.titel||'')),T+': Plan im Lesefenster');
  ok(await evaluate('location.hash')==='',T+': Seiten-URL unveraendert (kein Hash)');
  await schliesseFenster();
  // live: Datenaenderung -> sofort getauscht (ohne Aufbau-Animation), Plan-Auswahl bleibt
  const neu=[...P2,task('P2',3,'todo','Neu live '+T)];
  await pool.query('UPDATE plans SET tasks=$2::jsonb, updated_at=NOW() WHERE id=$1',[PLAN2,JSON.stringify(neu)]);
  let streamtBeiAnkunft=null;
  await wait(async()=>{const v=await evaluate('(()=>{const s='+SR+';if(!s||!/Neu live/.test(s.textContent))return null;return document.querySelector(".artefakt-live-block .agent-rendering-surface").classList.contains("is-streaming")})()');
   if(v===null||v===undefined)return false;streamtBeiAnkunft=v;return true;},T+': live neu gezeichnet',30000);
  ok(streamtBeiAnkunft===false,T+': Vorlagen-Update ohne Aufbau-Animation sofort getauscht');
  ok(await evaluate('('+SR+').querySelector("#r-P2").checked')===true&&await sichtbar('.v-P2'),T+': Plan-Auswahl P2 ueberlebt das Live-Update');
  await sleep(300);await shot(T+'-koordinator-nach-live-update');
  // Main-Chat-Block: mehrdeutig -> Auswahl; Thought-Link
  ok(await klickIn(SM,'[data-synapse-verweis="abcd1234"]'),T+': mehrdeutigen Wert anklicken');
  await wait(()=>evaluate("document.querySelectorAll('[data-artefakt-verweis-auswahl] button').length===2"),T+': Auswahl mit zwei Thoughts');
  await sleep(300);await shot(T+'-main-block-auswahl');
  ok(await evaluate("(()=>{const b=document.querySelector('[data-artefakt-verweis-auswahl] button');b.click();return true})()"),T+': ersten Treffer waehlen');
  await wait(async()=>(await fenster()).some(f=>f.art==='Thought'),T+': Thought im Lesefenster');
  await schliesseFenster();
  ok(await klickIn(SM,'a[href^="#verweis:thought:"]'),T+': Thought-Link (art:id) anklicken');
  await wait(async()=>(await fenster()).some(f=>f.art==='Thought'&&/Thought eins/.test(f.text||'')),T+': Thought per art:id im Lesefenster');
  await sleep(300);await shot(T+'-main-block-thought');
  await schliesseFenster();
  // Persoenliche Artefakte
  await oeffne(theme,'persoenlich');
  await wait(()=>evaluate("!![...document.querySelectorAll('.memory-list button')].find(b=>/Projektfortschritt \\(interaktiv\\)/.test(b.textContent))"),T+': Persoenliche Artefakte: Eintrag da');
  await evaluate("[...document.querySelectorAll('.memory-list button')].find(b=>/Projektfortschritt \\(interaktiv\\)/.test(b.textContent)).click()");
  await wait(()=>evaluate('!!('+SR+')?.querySelector("[data-synapse-verweis=\'P1-T3\']")'),T+': Persoenliche Artefakte: Vorlage gerendert');
  await sleep(800);
  ok(await klickIn(SR,'[data-synapse-verweis="P1-T3"]'),T+': Persoenliche Artefakte: Task anklicken');
  await wait(async()=>(await fenster()).some(f=>/Beschreibung P1-T3/.test(f.text||'')),T+': Persoenliche Artefakte: Lesefenster');
  await sleep(300);await shot(T+'-persoenliche-artefakte-lesefenster');
  // Top-Artefakte
  await oeffne(theme,'top');
  await wait(()=>evaluate("!![...document.querySelectorAll('.dashboard-tabs button')].find(b=>/Top-Artefakte/.test(b.textContent))"),T+': Arbeitsraum geladen');
  await evaluate("[...document.querySelectorAll('.dashboard-tabs button')].find(b=>/Top-Artefakte/.test(b.textContent)).click()");
  await wait(()=>evaluate("!!document.querySelector('.top-eintrag .top-kopf')"),T+': Top-Eintrag da');
  await evaluate("document.querySelector('.top-eintrag .top-kopf').click()");
  await wait(()=>evaluate('!!('+SR+')?.querySelector("[data-synapse-verweis=\'P1-T4\']")'),T+': Top-Artefakte: Vorlage ausgeklappt');
  await sleep(800);
  ok(await klickIn(SR,'[data-synapse-verweis="P1-T4"]'),T+': Top-Artefakte: Task anklicken');
  await wait(async()=>(await fenster()).some(f=>/Beschreibung P1-T4/.test(f.text||'')),T+': Top-Artefakte: Lesefenster');
  await sleep(300);await shot(T+'-top-artefakte-lesefenster');
  await kb('/tabs/close',{tab_id:tab});tab=null;
  await pool.query('UPDATE plans SET tasks=$2::jsonb, updated_at=NOW() WHERE id=$1',[PLAN2,JSON.stringify(P2)]);await sleep(1500);
 };
 await lauf('dark');
 await lauf('light');
 belege.artefakt=A;belege.plan_alle=(await C.ladePlanAlle(P,{})).debug_quelle;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,belege},null,2));
 console.log('PASS P22-T165 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
