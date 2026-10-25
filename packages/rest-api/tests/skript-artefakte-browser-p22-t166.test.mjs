/** P22-T166: Browserabnahme Artefakte mit Skript im KI-Browser (privates synapse_test-Schema, echte API, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/skript-artefakte-browser-p22-t166.test.mjs
 * Fixture (Koordinator per Ausweis, Projekt P): Probe-Artefakt mit Skript, Endlosschleife, Wegnavigation, Live-Vorlage mit Skript.
 * Prueft dunkel und hell: Chatfenster bleibt bereinigt (Hinweis), Chip 'Skript', ausgeklappt erst Warnung + Vorschau, Start per Klick,
 * iframe-Attribute, im iframe Cookie/localStorage/Eltern-DOM/fetch gesperrt (Ergebnis als Hoehe codiert), Bruecke liefert Daten,
 * oeffne -> Lesefenster, abgelehnte Anfrage gezaehlt, while(true) -> Watchdog (Web-UI bleibt bedienbar?), location -> Stopp,
 * Live-Vorlage: 'neuer Stand · neu laden' ohne Neuladen, Einklappen entfernt den iframe. Screenshots: ui-screenshots/p22-t166/. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
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
const schema='p22_t166_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t166-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const B='http://192.168.50.65:9222';
const kb=async(path,body,ms=20000)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(ms)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async(script,ms)=>(await kb('/evaluate',{tab_id:tab,script},ms)).result.result;
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,500):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const belege={};
// Probe: Ergebnisbits als Hoehe (300 + maske*20 px): 1 Cookie lesbar, 2 localStorage lesbar, 4 Eltern-DOM lesbar, 8 fetch durch, 16 Bruecke lieferte Daten.
const PROBE='<div id="probe" style="box-sizing:border-box;height:200px;overflow:hidden;padding:12px;font:14px system-ui;color:var(--synapse-text)">'
 +'<h2 style="margin:0 0 6px;color:var(--synapse-accent)">Skript-Probe</h2><ul id="erg" style="margin:0"></ul></div><script>(function(){'
 +'var maske=0,fertig=0;function z(t){var li=document.createElement("li");li.textContent=t;document.getElementById("erg").appendChild(li);}'
 +'try{var c=document.cookie;if(c&&c.indexOf("t166")>=0){maske|=1;z("Cookie LESBAR")}else z("Cookie: nichts sichtbar")}catch(e){z("Cookie: gesperrt ("+e.name+")")}'
 +'try{var v=localStorage.getItem("synapse_session_token");if(v){maske|=2;z("localStorage LESBAR")}else z("localStorage: leer")}catch(e){z("localStorage: gesperrt ("+e.name+")")}'
 +'try{var t=parent.document.title;maske|=4;z("Eltern-DOM LESBAR: "+t)}catch(e){z("Eltern-DOM: gesperrt ("+e.name+")")}'
 +'function ende(){if(++fertig<2)return;document.getElementById("probe").style.height=(300+maske*20)+"px";z("Maske "+maske)}'
 +'try{fetch("/api/main-agent/artefakte/top?project=x").then(function(){maske|=8;z("fetch DURCHGEKOMMEN")},function(){z("fetch: gesperrt (CSP)")}).then(ende)}catch(e){z("fetch: gesperrt");ende()}'
 +'synapse.bereit(function(s){s.quelle("plan.list").then(function(d){if(d&&d[0]&&d[0].kurz_id==="P1"){maske|=16;z("Bruecke plan.list: "+d[0].name+" ("+d[0].tasks_offen+" offen)")}})'
 +'.then(function(){return s.lese("task","P1-T1").then(function(t){z("Bruecke lese: "+t.titel)})})'
 +'.then(function(){return s.quelle("plan.list",{project:"fremd"}).then(function(){z("project-Argument DURCH")},function(e){z("project-Argument abgelehnt: "+e.code)})})'
 +'.then(function(){s.oeffne("P1-T1");z("Lesefenster geoeffnet ("+s.projekt+", "+s.thema+")")})'
 +'.catch(function(e){z("Fehler "+(e.code||e.message))}).then(ende)})})()</script>';
// ACHTUNG (Befund 25.10.2026): Im KI-Browser laeuft der sandboxed iframe im selben Renderer-Prozess; for(;;){} fror den Tab und den
// ganzen KI-Browser dauerhaft ein. Darum hier eine BEGRENZTE Blockade (8 s busy), die denselben Befund zeigt und wieder freigibt.
const SCHLEIFE='<div style="padding:12px;font:14px system-ui"><h2 style="margin:0">Endlosschleife</h2><p>Nach 1,5 s blockiert das Skript seinen Thread (Test: 8 s).</p></div>'
 +'<script>setTimeout(function(){var ende=Date.now()+8000;while(Date.now()<ende){}},1500)</script>';
const WEG='<div style="padding:12px;font:14px system-ui"><h2 style="margin:0">Wegnavigation</h2><p>Nach 0,8 s versucht das Skript, wegzunavigieren.</p></div>'
 +'<script>setTimeout(function(){location.href="about:blank"},800)</script>';
const VORLAGE='<div style="padding:12px;font:14px system-ui"><h2 style="margin:0">Live mit Skript</h2>{{#each plaene as p}}<p>{{p.kurz_id}}: <b class="offen">{{p.tasks_offen}}</b> offen</p>{{/each}}'
 +'<p id="neu">kein neuer Stand</p></div><script>synapse.beiNeuemStand(function(i){document.getElementById("neu").textContent="neuer Stand gemeldet: "+i.revision})</script>';
const tasks=(done,offen)=>JSON.stringify([...Array.from({length:done},(_,i)=>({id:randomUUID(),kurz_id:'P1-T'+(i+1),title:i===0?'Erste Aufgabe':'erledigt '+i,description:'Beschreibung '+i,status:'done',priority:'medium'})),
 ...Array.from({length:offen},(_,i)=>({id:randomUUID(),kurz_id:'P1-T'+(done+i+1),title:'offen '+i,description:'',status:'todo',priority:'medium'}))]);
const RAHMEN=b=>"document.querySelector('[data-bewertung=\""+b+"\"] .skript-rahmen')";
const attr=(b,a)=>evaluate("("+RAHMEN(b)+"||{}).getAttribute?.("+JSON.stringify(a)+")??null");
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
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T166 Browser-Fixture','user')",[f,aktiv]);};
 for(const f of ['artefakt_bewertung','artefakt_vorlagen','artefakt_vorlagen_live','artefakt_ausweis_zeigen','artefakt_verweise','artefakt_skripte'])await schalter(f,true);
 belege.einstellungen=await C.setzeArtefaktVorlagenEinstellungen({drossel_ms:1000,buendel_ms:200},'T166 Browserabnahme: schneller live','user').catch(e=>({fehler:String(e?.message||e)}));
 const KOORD=randomUUID();
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t166')",[KOORD,P]);
 const PLAN=randomUUID();
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id) VALUES($1,$2,'Skript-Abnahme','',$3::jsonb,true,'P1')",[PLAN,P,tasks(3,1)]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const AT=await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
 const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
 const tool=args=>C.mitAgentAufrufKontext({principal:{art:'identity',project:P,agent_id:'koordinator',identity_id:KOORD,rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null},bezug},()=>AT.fuehreArtefaktAus(args,'koordinator'));
 const zeige=async(titel,extra)=>{const j=await tool({action:'zeigen',titel,...extra});assert.equal(j.success,true,JSON.stringify(j));return j.artefakt_id;};
 const A_PROBE=await zeige('Skript-Probe',{html:PROBE});
 const A_SCHLEIFE=await zeige('Endlosschleife',{html:SCHLEIFE});
 const A_WEG=await zeige('Wegnavigation',{html:WEG});
 const A_LIVE=await zeige('Live mit Skript',{vorlage:VORLAGE,quellen:[{name:'plaene',vertrag:'plan.list'}],modus:'live'});
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.ready();
 const bewerte=async ref=>{const r=(await app.inject({method:'POST',url:'/api/agent-runtimes/artefakt-bewertung',payload:{quelle_art:'artefakt',quelle_ref:ref,urteil:'hoch'}})).json();assert.equal(r.success,true,JSON.stringify(r));return r.bewertung.id;};
 const B_PROBE=await bewerte(A_PROBE),B_SCHLEIFE=await bewerte(A_SCHLEIFE),B_WEG=await bewerte(A_WEG),B_LIVE=await bewerte(A_LIVE);
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const folder=join(repo,'ui-screenshots/p22-t166');await mkdir(folder,{recursive:true});
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab,{signal:AbortSignal.timeout(20000)});assert(r.ok);await writeFile(join(folder,f),Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT ui-screenshots/p22-t166/'+f);};
 const klick=sel=>evaluate("(()=>{const e=document.querySelector("+JSON.stringify(sel)+");if(!e)return false;e.click();return true})()");
 const klickText=(sel,text)=>evaluate("(()=>{const e=[...document.querySelectorAll("+JSON.stringify(sel)+")].find(x=>x.textContent.trim().startsWith("+JSON.stringify(text)+"));if(!e)return false;e.click();return true})()");
 const ausklappen=async(b,label)=>{ok(await klick('[data-bewertung="'+b+'"] .top-kopf'),label);await wait(()=>evaluate("!!"+RAHMEN(b)),label+': Rahmen da');};
 const lauf=async(theme)=>{
  const erg={};
  tab=(await kb('/tabs/new',{url:ui+'/tests/skript-artefakte.html?project='+P+'&theme='+theme})).tab_id;
  await wait(()=>evaluate("!!document.querySelector('.dashboard-tabs')"),theme+': Arbeitsraum geladen');
  // Geheimnisse der Web-UI, die das Skript NICHT sehen darf
  await evaluate("(()=>{document.cookie='t166_geheim=1; path=/';localStorage.setItem('synapse_session_token','geheim-t166');document.title='Web-UI geheim';return true})()");
  // Chatfenster: Skript entfernt, Hinweis sichtbar, nichts ausgefuehrt
  await wait(()=>evaluate("[...document.querySelectorAll('.t166-chat .skript-entfernt')].length===1"),theme+': Chatfenster zeigt Hinweis Skript entfernt');
  ok(await evaluate("(()=>{const h=document.querySelector('.t166-chat .agent-rendering-shadow');return !!h&&!h.shadowRoot.querySelector('script')&&window.__t166_chat_lief===undefined&&document.title==='Web-UI geheim'})()"),
   theme+': Chatfenster bereinigt (kein script im Shadow-DOM, nichts ausgefuehrt)');
  ok(await klickText('.dashboard-tabs button','Top-Artefakte'),theme+': Reiter Top-Artefakte');
  await wait(()=>evaluate("document.querySelectorAll('.top-eintrag').length===4"),theme+': vier Skript-Artefakte in der Liste');
  ok(await evaluate("[...document.querySelectorAll('.top-eintrag')].every(e=>[...e.querySelectorAll('.top-chip')].some(c=>c.textContent==='Skript'))"),theme+': Chip Skript an jedem Eintrag');
  await shot(theme+'-liste-und-chatfenster');
  // Probe: Warnung + bereinigte Vorschau, erst Klick startet
  await ausklappen(B_PROBE,theme+': Probe ausklappen');
  ok(await attr(B_PROBE,'data-skript-zustand')==='wartet'&&await evaluate("!document.querySelector('.skript-rahmen iframe')&&/nie Codes oder Passwörter/.test(document.querySelector('.skript-warnung')?.textContent||'')"),
   theme+': vor dem Start Warnung, kein iframe (Plan B)');
  await sleep(500);await shot(theme+'-probe-vor-start');
  ok(await klickText('.skript-leiste button','Skript starten'),theme+': Skript starten');
  await wait(async()=>await attr(B_PROBE,'data-bruecke')==='verbunden',theme+': Bruecke verbunden');
  const f=await evaluate("(()=>{const i=document.querySelector('.skript-rahmen iframe');return {sandbox:i.getAttribute('sandbox'),allow:i.getAttribute('allow'),ref:i.getAttribute('referrerpolicy'),csp:/connect-src 'none'/.test(i.srcdoc),sop:(()=>{try{return !!i.contentDocument}catch(e){return 'wirft'}})()}})()");
  ok(f.sandbox==='allow-scripts'&&/camera 'none'/.test(f.allow)&&f.ref==='no-referrer'&&f.csp&&f.sop===false,theme+': iframe sandbox=allow-scripts, allow none, CSP, Eltern sieht kein contentDocument (fremder Ursprung)',f);
  await wait(async()=>Number(await attr(B_PROBE,'data-bruecke-ok'))>=3,theme+': Bruecke: quelle + lese + oeffne ok');
  ok(Number(await attr(B_PROBE,'data-bruecke-abgelehnt'))>=1,theme+': project-Argument aus dem Skript abgelehnt (gezaehlt)');
  await wait(async()=>/Erste Aufgabe/.test(await evaluate("[...document.querySelectorAll('.verweis-fenster')].map(f=>f.textContent).join(' ')")),theme+': oeffne -> Lesefenster mit der Task');
  await wait(async()=>/^\d+px$/.test(await evaluate("document.querySelector('.skript-rahmen iframe')?.style.height||''"))&&await evaluate("document.querySelector('.skript-rahmen iframe').style.height")!=='240px',theme+': Hoehe gemeldet');
  await sleep(600);
  erg.hoehe=await evaluate("document.querySelector('.skript-rahmen iframe').style.height");
  ok(erg.hoehe==='620px',theme+': im iframe Cookie, localStorage, Eltern-DOM und fetch gesperrt, Bruecke lieferte Daten (Maske 16)',erg.hoehe);
  ok(await evaluate("document.title==='Web-UI geheim'"),theme+': Eltern-Titel unveraendert');
  await shot(theme+'-probe-laeuft-mit-lesefenster');
  await evaluate("document.querySelectorAll('.verweis-fenster button[aria-label=\"Fenster schließen\"]').forEach(b=>b.click())");
  // Einklappen entfernt den iframe
  ok(await klick('[data-bewertung="'+B_PROBE+'"] .top-kopf'),theme+': Probe einklappen');
  await wait(()=>evaluate("!document.querySelector('.skript-rahmen iframe')"),theme+': eingeklappt -> kein iframe');
  ok(true,theme+': iframe beim Einklappen entfernt');
  // Wegnavigation
  await ausklappen(B_WEG,theme+': Wegnavigation ausklappen');
  ok(await klickText('.skript-leiste button','Skript starten'),theme+': Wegnavigation starten');
  await wait(async()=>await attr(B_WEG,'data-skript-zustand')==='navigation',theme+': Wegnavigation erkannt und gestoppt',10000);
  ok(await evaluate("!document.querySelector('.skript-rahmen iframe')&&/wegzunavigieren/.test(document.querySelector('.skript-gestoppt')?.textContent||'')"),theme+': iframe entfernt, Hinweis');
  await shot(theme+'-wegnavigation-gestoppt');
  ok(await klick('[data-bewertung="'+B_WEG+'"] .top-kopf'),theme+': zuklappen');
  // Live-Vorlage mit Skript: neuer Stand ohne Neuladen
  await ausklappen(B_LIVE,theme+': Live-Vorlage ausklappen');
  ok(await klickText('[data-bewertung="'+B_LIVE+'"] .skript-leiste button','Skript starten'),theme+': Live-Vorlage starten');
  await wait(async()=>await attr(B_LIVE,'data-bruecke')==='verbunden',theme+': Live-Vorlage verbunden');
  await sleep(1200);
  await pool.query('UPDATE plans SET tasks=$2::jsonb, updated_at=NOW() WHERE id=$1',[PLAN,theme==='dark'?tasks(2,2):tasks(1,3)]);
  await wait(()=>evaluate("!!document.querySelector('[data-bewertung=\""+B_LIVE+"\"] .skript-neuer-stand')"),theme+': neuer Stand -> Hinweis neu laden (kein Neuladen)',30000);
  ok(await attr(B_LIVE,'data-skript-zustand')==='laeuft',theme+': Skript laeuft weiter (kein Neuladen)');
  await sleep(500);await shot(theme+'-live-neuer-stand');
  ok(await klickText('[data-bewertung="'+B_LIVE+'"] .skript-leiste button','neuer Stand'),theme+': neu laden auf Wunsch');
  await wait(async()=>await attr(B_LIVE,'data-bruecke')==='verbunden'&&!await evaluate("!!document.querySelector('.skript-neuer-stand')"),theme+': neu geladen');
  ok(await klick('[data-bewertung="'+B_LIVE+'"] .top-kopf'),theme+': zuklappen');
  // Endlosschleife: Watchdog; bleibt die Web-UI bedienbar?
  await ausklappen(B_SCHLEIFE,theme+': Endlosschleife ausklappen');
  ok(await klickText('.skript-leiste button','Skript starten'),theme+': Endlosschleife starten');
  await wait(async()=>await attr(B_SCHLEIFE,'data-bruecke')==='verbunden',theme+': Schleife verbunden');
  await sleep(2500);
  const t0=Date.now();let antwort;
  try{antwort=await evaluate("1+1",8000);}catch(e){antwort='keine Antwort: '+(e?.name||e);}
  erg.bedienbar={antwort,ms:Date.now()-t0};
  console.log('BEFUND '+theme+': Web-UI waehrend while(true): '+JSON.stringify(erg.bedienbar));
  erg.eingefroren=antwort!==2;
  if(erg.eingefroren)console.log('BEFUND '+theme+': Seite eingefroren - der iframe laeuft im selben Prozess, der Watchdog greift erst nach der Blockade');
  await wait(async()=>await attr(B_SCHLEIFE,'data-skript-zustand')==='watchdog',theme+': Watchdog stoppt das blockierende Skript',30000);
  erg.watchdog_ms=Date.now()-t0+2500;
  ok(Number(await attr(B_SCHLEIFE,'data-watchdog'))===1&&await evaluate("!document.querySelector('.skript-rahmen iframe')&&/reagiert nicht/.test(document.querySelector('.skript-gestoppt')?.textContent||'')"),
   theme+': Watchdog-Zaehler, iframe entfernt, Hinweis');
  await shot(theme+'-watchdog-gestoppt');
  await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=null;
  return erg;
 };
 belege.dunkel=await lauf('dark');
 await pool.query('UPDATE plans SET tasks=$2::jsonb, updated_at=NOW() WHERE id=$1',[PLAN,tasks(3,1)]);
 await sleep(1500);
 belege.hell=await lauf('light');
 belege.bruecke=C.skriptBrueckeStatus();
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,belege},null,2));
 console.log('BELEGE '+JSON.stringify({dunkel:belege.dunkel,hell:belege.hell,bruecke:{aufrufe:belege.bruecke.aufrufe,ok:belege.bruecke.ok,abgelehnt:belege.bruecke.abgelehnt}}));
 console.log('PASS P22-T166 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
