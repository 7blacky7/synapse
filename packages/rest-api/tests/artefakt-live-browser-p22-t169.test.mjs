/** P22-T169: Browserabnahme im KI-Browser (privates synapse_test-Schema, echte API in diesem Prozess, keine Produktionsdaten).
 * SICHERT AB (User-Befunde thoughts 99745146, c4858305, Entscheidung 403c12bd): dasselbe Live-Artefakt im Koordinator-Chat
 *   (web-ui EinheitlicherAgentChat -> ArtefaktLiveBlock) UND in den Top-Artefakten (MainAgentDashboard) zeichnet bei Plan-/Task-Aenderungen
 *   neu (rest-api artefakt-live.ts); Ersetzen per Ausweis (artefakt-tool.ts zeigePerAusweis, core meldeArtefaktImVerlauf) aktualisiert die
 *   Einbettung und zeigt eine Zeile 'aktualisiert', ein gescheitertes Ersetzen eine Zeile 'fehler'; die Radio-Auswahl bleibt ueber das
 *   Neuladen erhalten (web-ui AgentRenderingSurface zustandSchluessel, localStorage).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-live-browser-p22-t169.test.mjs
 * Fixture: web-ui/tests/artefakt-live-p22-t169.html (Chat links, Top-Artefakte rechts). Screenshots: ui-screenshots/p22-t169/<lauf-id>/.
 * Bei FAIL: Assertion mit Herkunft im Label + erwartet/tatsaechlich (Texte gekuerzt), belege.json im Screenshot-Ordner. */
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t169_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t169-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=25000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,'FAIL '+label+(info!==undefined?' '+JSON.stringify(info).slice(0,600):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const belege={};
const task=(plan,nr,status)=>({id:randomUUID(),kurz_id:plan+'-T'+nr,title:'Task '+plan+'-'+nr,description:'',status,priority:'medium',
 createdAt:new Date(Date.UTC(2026,9,1,0,nr)).toISOString(),updatedAt:new Date(Date.UTC(2026,9,1,0,nr)).toISOString()});
// Vorlage: Radio je Plan (CSS-Navigation), alle Task-Staende als Text (Pruefung per textContent), Kennzeichen der Fassung.
const vorlage=(fassung)=>'<div class="lf" data-synapse-projekt="{{_meta.project}}"><style>'
 +'.lf{--bg:#f7f5f0;--ink:#1d1d22;--acc:#b8761a;--line:#ddd6c9;background:var(--bg);color:var(--ink);font:14px system-ui;padding:12px 14px;border-radius:12px}'
 +':host-context([data-theme="dark"]) .lf{--bg:#11151c;--ink:#e6e9ef;--acc:#e0a24a;--line:#273041}'
 +'.lf input[type=radio]{position:absolute;opacity:0;pointer-events:none}.lf .tabs{display:flex;gap:6px;margin:6px 0}.lf .tabs label{padding:3px 9px;border:1px solid var(--line);border-radius:999px;cursor:pointer}'
 +'.lf .v{display:none;margin:4px 0;font:12px ui-monospace,monospace}'
 +'{{#each alle.plaene as p}}#r-{{p.kurz_id}}:checked~.ansichten .v-{{p.kurz_id}}{display:block}#r-{{p.kurz_id}}:checked~.tabs label[for="r-{{p.kurz_id}}"]{background:var(--acc);color:var(--bg)}{{/each}}'
 +'</style><b data-fassung="'+fassung+'">Leitstand T169 · '+fassung+'</b>'
 +'{{#each alle.plaene as p}}<input type="radio" name="plan" id="r-{{p.kurz_id}}" {{#if @erster}}checked{{/if}}>{{/each}}'
 +'<div class="tabs">{{#each alle.plaene as p}}<label for="r-{{p.kurz_id}}">{{p.kurz_id}} #{{p.nummer}}</label>{{/each}}</div>'
 +'<div class="ansichten">{{#each alle.plaene as p}}<p class="v v-{{p.kurz_id}}">{{p.kurz_id}}:{{#each p.tasks as t}} {{t.kurz_id}}={{t.status}}{{/each}}</p>{{/each}}</div></div>';
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const seq=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,r]of seq.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 // hauptagent_verlauf.rev zaehlt per nextval('hauptagent_verlauf_rev') (Schema 124): eigene Sequenz im Testschema.
 await admin.query('CREATE SEQUENCE IF NOT EXISTS '+schema+'.hauptagent_verlauf_rev');
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const sql of [C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL,C.ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL,C.ARTEFAKT_VORLAGEN_SCHEMA_SQL])await pool.query(sql);
 await pool.query("ALTER TABLE hauptagent_verlauf ALTER COLUMN rev SET DEFAULT nextval('hauptagent_verlauf_rev')").catch(()=>undefined);
 const schalter=async(f,aktiv,project=null)=>{await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$1",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES($3,$4,$1,$2,'P22-T169 Browser-Fixture','user')",[f,aktiv,project?'projekt':'global',project]);};
 for(const f of ['artefakt_bewertung','artefakt_vorlagen','artefakt_vorlagen_live','artefakt_ausweis_zeigen','artefakt_verweise'])await schalter(f,true);
 for(const f of ['plattform_agent_chat','agent_chat_einheitlich'])await schalter(f,true,P);
 await C.setzeArtefaktVorlagenEinstellungen({drossel_ms:1000,buendel_ms:200},'P22-T169 Browserabnahme: schneller live','user');
 const KOORD=randomUUID();
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','p22-t169')",[KOORD,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id) VALUES($1,$2,'Eins','',$3::jsonb,true,'P1')",[randomUUID(),P,JSON.stringify([task('P1',1,'done'),task('P1',2,'todo'),task('P1',3,'todo'),task('P1',4,'todo')])]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id) VALUES($1,$2,'Zwei','',$3::jsonb,false,'P2')",[randomUUID(),P,JSON.stringify([task('P2',1,'todo')])]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id) VALUES($1,$2,'Zehn','',$3::jsonb,false,'P10')",[randomUUID(),P,JSON.stringify([task('P10',1,'todo')])]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const AT=await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
 const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
 const tool=(args)=>C.mitAgentAufrufKontext({principal:{art:'identity',project:P,agent_id:'koordinator',identity_id:KOORD,rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null},bezug},()=>AT.fuehreArtefaktAus(args,'koordinator'));
 const QUELLEN=[{name:'alle',vertrag:'plan.alle'}];
 const j=await tool({action:'zeigen',titel:'Leitstand T169',vorlage:vorlage('Fassung 1'),quellen:QUELLEN,modus:'live'});
 assert.equal(j.success,true,JSON.stringify(j));const A=j.artefakt_id;belege.artefakt=A;belege.verlauf_einbettung=j.verlauf_id;
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.ready();
 const bw=(await app.inject({method:'POST',url:'/api/agent-runtimes/artefakt-bewertung',payload:{quelle_art:'artefakt',quelle_ref:A,urteil:'hoch',kommentar:'Leitstand live'}})).json();
 assert.equal(bw.success,true,JSON.stringify(bw));
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t169'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(f,Buffer.from(await r.arrayBuffer())));};
 // P25-T19: isolierterTab leert den Storage; fuer die Neuladen-Probe (Abschnitt 3) bleibt er mit leeren:false stehen.
 const oeffne=async(theme,{leeren=true}={})=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:ui+'/tests/artefakt-live-p22-t169.html?project='+P+'&theme='+theme+'&koord='+KOORD},{leeren})).tab_id;};
 // Shadow-Roots: Einbettung im Chat bzw. ausgeklappte Vorlage in den Top-Artefakten.
 const CHAT="(()=>{const h=document.querySelector('[data-fixture=chat] .agent-chat-artefakt .agent-rendering-shadow');return h&&h.shadowRoot})()";
 const TOP="(()=>{const h=document.querySelector('[data-fixture=top] .top-ansicht .agent-rendering-shadow');return h&&h.shadowRoot})()";
 const text=(sr)=>evaluate('(()=>{const s='+sr+';return s?s.textContent:""})()').then(v=>String(v??''));
 const chatTexte=()=>evaluate("[...document.querySelectorAll('[data-fixture=chat] [data-nachricht]')].map(n=>n.innerText).join(' | ')").then(v=>String(v??''));
 const topAufklappen=async(T)=>{
  await wait(()=>evaluate("!![...document.querySelectorAll('[data-fixture=top] .dashboard-tabs button')].find(b=>/Top-Artefakte/.test(b.textContent))"),T+': Top-Artefakte-Reiter da');
  await evaluate("[...document.querySelectorAll('[data-fixture=top] .dashboard-tabs button')].find(b=>/Top-Artefakte/.test(b.textContent)).click()");
  await wait(()=>evaluate("!!document.querySelector('[data-fixture=top] .top-eintrag .top-kopf')"),T+': Top-Eintrag da');
  await evaluate("document.querySelector('[data-fixture=top] .top-eintrag .top-kopf').click()");
  await wait(async()=>/P1-T2=/.test(await text(TOP)),T+': Top-Artefakte: Vorlage ausgeklappt');
 };
 const beide=async(re,label)=>{
  await wait(async()=>re.test(await text(CHAT))&&re.test(await text(TOP)),label,30000).catch(async e=>{throw Error(e.message+' '+JSON.stringify({chat:(await text(CHAT)).slice(0,300),top:(await text(TOP)).slice(0,300)}));});
  ok(true,label);
 };
 // ---------------------------------------------------------------- dunkel: alles
 let T='dunkel';
 await oeffne('dark');
 await wait(async()=>/Fassung 1/.test(await text(CHAT)),'P22-T169 EinheitlicherAgentChat: Live-Artefakt im Koordinator-Chat eingebettet');ok(true,'P22-T169 EinheitlicherAgentChat: Live-Artefakt im Koordinator-Chat eingebettet');
 await topAufklappen(T);
 await wait(()=>evaluate("document.querySelector('[data-fixture=chat] .artefakt-live-block')?.dataset.live==='bereit'"),T+': Chat-Einbettung live bereit');
 ok(true,'P22-T169 ArtefaktLiveBlock (Chat): Live-Strom bereit');
 await sleep(1200);await shot(T+'-start-chat-und-top');
 // 1. update_task -> beide (User-Befund 99745146: Chat zeichnete nicht neu)
 await C.updateTask(P,'P1-T2',{status:'in_progress'},null);
 await beide(/P1-T2=in_progress/,'P22-T169 artefakt-live.ts: update_task -> Chat UND Top-Artefakte zeigen den neuen Stand');
 // 2. verschieben direkt danach (innerhalb der Drossel; frueher ging das verloren)
 await C.verschiebeTasks(P,['P1-T4'],'P2');
 await beide(/P2-T2=todo/,'P22-T169 artefakt-live.ts: verschieben direkt danach -> Chat UND Top-Artefakte (keine verworfene Renderung)');
 ok(!/P1-T4=/.test(await text(CHAT)),'P22-T169 Chat: verschobene Task nicht mehr im Quellplan',(await text(CHAT)).slice(0,300));
 await sleep(400);await shot(T+'-nach-verschieben');
 // 3. Auswahl ueber das Neuladen (Entscheidung 403c12bd Punkt 3)
 ok(await evaluate('(()=>{const s='+CHAT+';const l=s&&s.querySelector(\'label[for="r-P2"]\');if(!l)return false;l.click();return true})()'),'P22-T169 Chat: Plan P2 anklicken');
 await wait(()=>evaluate('('+CHAT+').querySelector("#r-P2").checked===true'),T+': P2 gewaehlt');
 await sleep(300);
 const gespeichert=await evaluate("localStorage.getItem('synapse-artefakt-zustand:artefakt:"+A+"')");
 // Der KI-Browser gibt JSON-Text schon geparst zurueck; beide Formen zulassen.
 const gemerkt=typeof gespeichert==='string'?JSON.parse(gespeichert):gespeichert;
 ok(gemerkt?.geprueft?.['#r-P2']===true,'P22-T169 AgentRenderingSurface: Auswahl im localStorage gemerkt',gespeichert);
 await oeffne('dark',{leeren:false});
 await wait(async()=>/P2-T2=/.test(await text(CHAT)),T+': nach Neuladen Chat-Einbettung da');
 await wait(()=>evaluate('('+CHAT+').querySelector("#r-P2")?.checked===true'),'P22-T169 AgentRenderingSurface: Plan P2 nach dem Neuladen wieder gewaehlt').catch(async e=>{throw Error(e.message+' '+JSON.stringify(await evaluate('[...('+CHAT+').querySelectorAll("input")].map(i=>i.id+":"+i.checked)')));});
 ok(true,'P22-T169 AgentRenderingSurface: Plan P2 nach dem Neuladen wieder gewaehlt');
 await topAufklappen(T);
 await sleep(600);await shot(T+'-nach-neuladen-p2-gewaehlt');
 // 4. Ersetzen per Ausweis (User-Befund c4858305: im Chat erschien gar nichts)
 const j2=await tool({action:'zeigen',artefakt_id:A,titel:'Leitstand T169',vorlage:vorlage('Fassung 2'),quellen:QUELLEN,modus:'live'});
 ok(j2.success===true&&j2.verlauf_id===belege.verlauf_einbettung&&!!j2.meldung_verlauf_id,'P22-T169 artefakt-tool.ts zeigePerAusweis: Ersetzen -> gleiche Einbettung + Meldezeile',j2);
 belege.meldung_aktualisiert=j2.meldung_verlauf_id;
 await wait(async()=>/Fassung 2/.test(await text(CHAT)),'P22-T169 Chat: Einbettung zeigt die neue Fassung').catch(async e=>{throw Error(e.message+' '+(await text(CHAT)).slice(0,200));});
 ok(true,'P22-T169 Chat: Einbettung zeigt die neue Fassung an ihrem Platz');
 await wait(async()=>/aktualisiert \(Revision \d+\)/.test(await chatTexte()),'P22-T169 Chat: Zeile "aktualisiert" erscheint').catch(async e=>{throw Error(e.message+' '+(await chatTexte()).slice(-400));});
 ok(true,'P22-T169 core meldeArtefaktImVerlauf: Zeile "aktualisiert" im Koordinator-Chat');
 await C.updateTask(P,'P10-T1',{status:'blocked'},null);
 await wait(async()=>/P10-T1=blocked/.test(await text(CHAT)),'P22-T169 Chat: nach dem Ersetzen weiter live').catch(async e=>{throw Error(e.message+' '+(await text(CHAT)).slice(0,300));});
 ok(true,'P22-T169 artefakt-live.ts: ersetzte Einbettung zeichnet weiter live neu');
 await sleep(400);await shot(T+'-nach-ersetzen-aktualisiert');
 // 5. Ersetzen scheitert -> sichtbar im Chat
 const j3=await tool({action:'zeigen',artefakt_id:A,vorlage:'{{#each alle.plaene as p}}offen',quellen:QUELLEN,modus:'live'});
 ok(j3.success===false&&!!j3.meldung_verlauf_id,'P22-T169 artefakt-tool.ts zeigePerAusweis: kaputte Vorlage -> Fehler + Meldezeile',j3);
 belege.meldung_fehler=j3.meldung_verlauf_id;
 await wait(async()=>/ersetzen fehlgeschlagen/.test(await chatTexte()),'P22-T169 Chat: Zeile "fehler" erscheint').catch(async e=>{throw Error(e.message+' '+(await chatTexte()).slice(-400));});
 ok(true,'P22-T169 core meldeArtefaktImVerlauf: gescheitertes Ersetzen im Koordinator-Chat sichtbar');
 await sleep(400);await shot(T+'-ersetzen-fehler');
 // ---------------------------------------------------------------- hell: Darstellung + live
 T='hell';
 await oeffne('light');
 await wait(async()=>/Fassung 2/.test(await text(CHAT)),T+': Chat-Einbettung da');
 await topAufklappen(T);
 await C.updateTask(P,'P1-T3',{status:'done'},null);
 await beide(/P1-T3=done/,'P22-T169 hell: update_task -> Chat UND Top-Artefakte');
 await sleep(400);await shot(T+'-chat-und-top');
 belege.live=(await app.inject({method:'GET',url:'/api/main-agent/artefakt-vorlagen'})).json().live;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,belege},null,2));
 console.log('PASS P22-T169 Browser '+checks+' checks; KI-Browser; private schema '+schema+'; Ordner '+folder);
}catch(e){failure=e;console.error('FAIL P22-T169 Browser '+(e?.message??e));}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
