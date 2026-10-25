/** P22-T170: Browserabnahme 'Herkunft des Lesefensters' im KI-Browser (privates synapse_test-Schema, echte API, Skripte per API).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/lesefenster-herkunft-browser-p22-t170.test.mjs
 * Testseite tests/lesefenster-herkunft.html (ansicht agent|main|channel|ohne). Schalter chat_zitate NUR ueber den befristeten internen
 * Test-Schalter (Produkt-Schalter AUS). Keine Endlosschleifen: jedes Warten hat ein Zeitlimit.
 * Prueft: Agenten-Chat (Pin + Zitat als Kaertchen, Senden -> genau eine Inbox-Zeile an diesen Agenten mit beiden im Block);
 * Main-Chat-Weg (Herkunft main, Pin + Zitat im Main-Entwurf, nichts in die Inbox); Channel-Fenster (Kaertchen, Post mit Block an den
 * Channel, keine Inbox, Zitate im Feed als Kaertchen); ohne Herkunft (Artefakte-Seite und Dashboard im Main-Provider): Pin nur
 * gespeichert, kein Kaertchen, kein Menue am Verweis, Empfaengerauswahl (3 sichtbar, Filter behaelt Auswahl) -> genau 2 Inbox-Zeilen.
 * Screenshots: ui-screenshots/p22-t170/<lauf-id>/*.png (P25-T7). */
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
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t170b_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t170-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,700):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const A=randomUUID(),B=randomUUID(),Cid=randomUUID(),D=randomUUID(),M=randomUUID();
const task=(nr,status,titel)=>({id:randomUUID(),kurz_id:'P1-T'+nr,title:titel,description:'Beschreibung P1-T'+nr+': im Lesefenster lesbar.',status,priority:'medium',
 createdAt:'2026-10-2'+nr+'T10:00:00Z',updatedAt:'2026-10-2'+nr+'T10:00:00Z'});
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
 await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',true,'T170 Browser-Fixture','user')",[P]);
 const testSchalter=async aktiv=>{await pool.query("DELETE FROM intern_schalter WHERE name='chat_zitate'");
  await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',$1,NOW()+interval '2 hours','T170 Browserabnahme Herkunft (befristet)')",[aktiv]);};
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$6,'koordinator','koordinator','koordinator','aktiv','t170'),($2,$6,'rea4','rea4','subagent','aktiv','t170'),($3,$6,'claude-t50','claude-t50','subagent','aktiv','t170'),
  ($4,$6,'deploy-t200','deploy-t200','subagent','aktiv','t170'),($5,'synapse-hauptagent','main','main','main','aktiv','t170')`,[A,B,Cid,D,M,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Herkunft','',$3::jsonb,true,'P1','hoch')",
  [randomUUID(),P,JSON.stringify([task(1,'done','Erste Aufgabe'),task(2,'in_progress','Zweite Aufgabe'),task(3,'todo','Dritte Aufgabe')])]);
 await pool.query("INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES('koordinator','user','Stand: P1-T2 ist offen.',$1,$2,null,$3)",
  [P,A,new Date(Date.UTC(2026,9,25,19,1)).toISOString()]);
 await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('team',$1,'t170')",[P]);
 const kanal=(await pool.query("SELECT id FROM specialist_channels WHERE project=$1 AND name='team'",[P])).rows[0].id;
 await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,'koordinator','Bitte P1-T2 im Channel ansehen.')",[kanal]);
 const zaehle=async(sql,p=[])=>Number((await pool.query(sql,p)).rows[0].n);
 const inbox=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user'");
 const posts=()=>zaehle("SELECT count(*) n FROM specialist_channel_messages WHERE channel_id=$1",[kanal]);
 const pins=async kurz=>(await pool.query("SELECT id::text id,source,content,tags,task_id FROM thoughts WHERE project=$1 AND task_id=$2 AND 'user-entscheidung'=ANY(tags) ORDER BY timestamp",[P,kurz])).rows;
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.register(S.specialistRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 // optimizeDeps.entries: Vite findet alle Abhaengigkeiten der Testseite (auch dynamische Importe) VOR dem ersten Laden. Ohne das
 // entdeckt Vite einige erst spaeter und laedt dann offene Seiten neu (im KI-Browser: leere Seite mitten im Test).
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/lesefenster-herkunft.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t170/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t170'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(f,Buffer.from(await r.arrayBuffer())));};
 const url=(ansicht,theme='dark')=>ui+'/tests/lesefenster-herkunft.html?project='+P+'&a='+A+'&token='+encodeURIComponent(sitzung)+'&theme='+theme+'&ansicht='+ansicht;
 let zuletzt=null;
 const bereit=()=>wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
 const oeffne=async(ansicht,theme)=>{
  if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
  zuletzt=url(ansicht,theme)+'&leeren=1';
  tab=(await kb('/tabs/new',{url:zuletzt})).tab_id;
  await bereit();
 };
 // Wartet auf einen Verweis; haengt die Seite (selten, KI-Browser), wird sie GENAU einmal neu geladen.
 const linkGeladen=async(bereich,text,label)=>{
  try{await wait(()=>linkDa(bereich,text),label,12000);}
  catch{
   const diag=await evaluate("JSON.stringify({url:location.href.slice(-60),links:document.querySelectorAll('.verweis-link').length,root:(document.getElementById('root')?.innerText??'').slice(0,300),fehler:(window.__fehler||[]).slice(0,5)})").catch(e=>String(e));
   console.log('HINWEIS neu laden: '+label+' '+(typeof diag==='string'?diag:JSON.stringify(diag)));await kb('/navigate',{tab_id:tab,url:zuletzt});await bereit();await wait(()=>linkDa(bereich,text),label,30000);}
 };
 const S_=JSON.stringify;
 const linkDa=(bereich,text)=>evaluate("!!["+"...document.querySelectorAll("+S_(bereich+' .verweis-link')+")].find(b=>b.textContent.trim()==="+S_(text)+")");
 const klickeLink=(bereich,text)=>evaluate("(()=>{const b=[...document.querySelectorAll("+S_(bereich+' .verweis-link')+")].find(b=>b.textContent.trim()==="+S_(text)+");if(!b)return false;b.click();return true})()");
 const fenster=re=>"[...document.querySelectorAll('.verweis-fenster')].find(f=>"+re+".test(f.innerText))";
 const fensterAttr=(re,attr)=>evaluate("("+fenster(re)+")?.getAttribute("+S_(attr)+")??null");
 const imFenster=(re,sel)=>"("+fenster(re)+")?.querySelector("+S_(sel)+")";
 const klick=sel=>evaluate("(()=>{const e="+sel+";if(!e)return false;e.click();return true})()");
 const knopfIn=(wurzel,t)=>"[...(document.querySelector("+S_(wurzel)+")?.querySelectorAll('button')??[])].find(b=>b.textContent.trim()==="+S_(t)+")";
 const setze=(sel,wert)=>evaluate("(()=>{const e=document.querySelector("+S_(sel)+");if(!e)return false;const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value');d.set.call(e,"+S_(wert)+");e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
 const tippe=(selector,text)=>kb('/type',{tab_id:tab,selector,text});
 const karten=wurzel=>json("JSON.stringify([...document.querySelectorAll("+S_(wurzel+' .zitat-entwuerfe .zitat-karte')+")].map(k=>({pin:k.getAttribute('data-zitat-pin'),text:k.innerText.replace(/\\s+/g,' ').trim()})))");
 const schliesseFenster=()=>evaluate("[...document.querySelectorAll('.verweis-fenster .verweis-titel button')].filter(b=>b.getAttribute('aria-label')==='Fenster schließen').forEach(b=>b.click())");
 const ladeFenster=async(re,label)=>wait(async()=>!!(await evaluate('!!'+fenster(re))),label);
 const pinne=async(re,wortlaut)=>{
  await wait(async()=>!!(await evaluate('!!'+imFenster(re,'.verweis-entscheidung'))),'Knopf User-Entscheidung anpinnen');
  await klick(imFenster(re,'.verweis-entscheidung'));
  await wait(async()=>!!(await evaluate('!!'+imFenster(re,'[data-user-entscheidung-editor] textarea'))),'Pin-Editor');
  await tippe('.verweis-fenster [data-user-entscheidung-editor] textarea',wortlaut);
  await klick("[...document.querySelectorAll('[data-user-entscheidung-editor] button')].find(b=>b.textContent.trim()==='Speichern')");
  await wait(async()=>/Angepinnt an Task/.test(await evaluate("("+fenster(re)+")?.innerText??''")),'Meldung Angepinnt');
  return evaluate("("+fenster(re)+")?.querySelector('.user-entscheidung-meldung')?.innerText??''");
 };
 const zitiereMitHerkunft=async(re,anmerkung)=>{
  await klick(imFenster(re,'.verweis-zitat:not([data-zitat-ohne-herkunft])'));
  await wait(async()=>!!(await evaluate("!!document.querySelector('.zitat-editor textarea')")),'Zitat-Editor');
  const kopf=await evaluate("document.querySelector('.zitat-editor header')?.innerText??''");
  await tippe('.zitat-editor textarea',anmerkung);
  await klick("[...document.querySelectorAll('.zitat-editor button')].find(b=>b.textContent.trim()==='Speichern')");
  await wait(async()=>!(await evaluate("!!document.querySelector('.zitat-editor')")),'Zitat-Editor zu');
  return kopf;
 };

 // ================================================================ 1 Agenten-Chat (Koordinator-Fenster)
 await testSchalter(true);
 await oeffne('agent');
 await linkGeladen('[data-fenster="a"]','P1-T2','Agentenfenster mit Verweis P1-T2');
 let vorInbox=await inbox(),vorPosts=await posts();
 await klickeLink('[data-fenster="a"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster P1-T2 aus dem Agenten-Chat');
 ok((await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-herkunft'))==='agent'&&(await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-ziel'))==='koordinator','1 Herkunft agent, Ziel koordinator (Debug am Lesefenster)');
 let meldung=await pinne('/Beschreibung P1-T2/','Agent: erst pruefen, dann freigeben.');
 let p2=await pins('P1-T2');
 ok(p2.length===1&&p2[0].source==='user'&&p2[0].content==='Agent: erst pruefen, dann freigeben.','1 Pin gespeichert (thought source user, task_id P1-T2)',p2);
 ok(/Als Kärtchen im Entwurf an koordinator\./.test(meldung),'1 Meldung: Kaertchen im Entwurf an koordinator',meldung);
 await wait(async()=>(await karten('[data-fenster="a"]')).some(k=>k.pin===p2[0].id),'Pin-Kaertchen im Agentenfenster');
 const kopf1=await zitiereMitHerkunft('/Beschreibung P1-T2/','Agent: bitte lesen.');
 ok(/Zitat an koordinator/i.test(kopf1),'1 Zitat anfügen haengt an genau diesen Chat an',kopf1);
 let k=await karten('[data-fenster="a"]');
 ok(k.length===2&&k[0].pin===p2[0].id&&/User-Entscheidung/.test(k[0].text)&&/Task P1-T2/.test(k[1].text),'1 Entwurf: Pin-Kaertchen + Zitat-Kaertchen',k);
 await shot('dunkel-agent-pin-und-zitat');
 await tippe('[data-fenster="a"] .chat-eingabefeld textarea','Bitte beides ansehen');
 await klick("document.querySelector('[data-fenster=\"a\"] .composer-send')");
 await wait(async()=>(await inbox())===vorInbox+1,'genau eine Inbox-Zeile an koordinator');
 let zeile=(await pool.query("SELECT to_agent,to_identity_id::text tid,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(zeile.to_agent==='koordinator'&&(zeile.tid===null||zeile.tid===A),'1 Empfaenger genau der Agent dieses Chats',zeile);
 ok(zeile.content.startsWith('Bitte beides ansehen\n\n[Synapse-Zitate: 2]')&&zeile.content.includes('Angepinnte User-Entscheidung an Task P1-T2\n   Thought: '+p2[0].id)&&zeile.content.includes('Task P1-T2')&&zeile.content.includes('Anmerkung: Agent: bitte lesen.'),'1 Pin und Zitat gemeinsam im Block (gleicher Weg)',zeile.content);
 ok((await posts())===vorPosts,'1 kein Channel-Post');
 await wait(async()=>(await karten('[data-fenster="a"]')).length===0,'Entwurf nach dem Senden leer');
 await shot('dunkel-agent-gesendet');

 // ================================================================ 2 Main-Chat-Weg
 await oeffne('main');
 await linkGeladen('[data-fenster="m"]','P1-T2','Main-Fenster mit Verweis');
 vorInbox=await inbox();
 await klickeLink('[data-fenster="m"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster aus dem Main-Chat');
 ok((await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-herkunft'))==='main'&&(await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-ziel'))==='Hauptagent','2 Herkunft main, Ziel Hauptagent');
 meldung=await pinne('/Beschreibung P1-T2/','Main: so umsetzen.');
 p2=await pins('P1-T2');
 const mainPin=p2.find(t=>t.content==='Main: so umsetzen.');
 ok(mainPin&&/Als Kärtchen im Entwurf an Hauptagent\./.test(meldung),'2 Pin gespeichert und als Kaertchen im Main-Entwurf',meldung);
 const kopf2=await zitiereMitHerkunft('/Beschreibung P1-T2/','Main: bitte lesen.');
 ok(/Zitat an Hauptagent/i.test(kopf2),'2 Zitat an den Hauptagenten',kopf2);
 const sende=await json("document.querySelector('[data-fenster=\"m\"]').getAttribute('data-main-sende')");
 ok(sende.length===2&&sende[0].art==='thought'&&sende[0].id===mainPin.id&&sende[1].art==='task'&&sende[1].anmerkung==='Main: bitte lesen.','2 Sendefeld des Main enthaelt Pin + Zitat (gleicher Block-Weg wie die Zitate)',sende);
 ok((await json("localStorage.getItem('synapse:zitat-entwurf:main')")).length===2,'2 Entwurf unter dem Main-Schluessel');
 ok((await inbox())===vorInbox,'2 nichts in die Inbox (Main-Herkunft geht nur mit der Main-Nachricht)');
 await shot('dunkel-main-pin-und-zitat');

 // ================================================================ 3 Channel-Fenster
 await oeffne('channel');
 await linkGeladen('[data-fenster="c"] .channel-messages','P1-T2','Channel-Fenster mit Verweis');
 vorInbox=await inbox();vorPosts=await posts();
 await klickeLink('[data-fenster="c"] .channel-messages','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster aus dem Channel');
 ok((await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-herkunft'))==='channel'&&(await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-ziel'))==='#team','3 Herkunft channel, Ziel #team');
 meldung=await pinne('/Beschreibung P1-T2/','Channel: alle beachten.');
 const chPin=(await pins('P1-T2')).find(t=>t.content==='Channel: alle beachten.');
 ok(chPin&&/Als Kärtchen im Entwurf an #team\./.test(meldung),'3 Pin gespeichert und als Kaertchen im Channel-Entwurf',meldung);
 const kopf3=await zitiereMitHerkunft('/Beschreibung P1-T2/','Channel: bitte lesen.');
 ok(/Zitat an #team/i.test(kopf3),'3 Zitat an den Channel',kopf3);
 k=await karten('[data-fenster="c"] .channel-composer');
 ok(k.length===2&&k[0].pin===chPin.id,'3 Channel-Fenster hat Kaertchen (Pin + Zitat) ueber dem Eingabefeld',k);
 await schliesseFenster();
 await shot('dunkel-channel-kaertchen');
 await tippe('[data-fenster="c"] .channel-composer textarea','An alle');
 await evaluate("document.querySelector('[data-fenster=\"c\"] .channel-composer').requestSubmit()");
 await wait(async()=>(await posts())===vorPosts+1,'genau ein neuer Channel-Post');
 const post=(await pool.query("SELECT sender,content FROM specialist_channel_messages WHERE channel_id=$1 ORDER BY id DESC LIMIT 1",[kanal])).rows[0];
 ok(post.sender==='user'&&post.content.startsWith('An alle\n\n[Synapse-Zitate: 2]')&&post.content.includes('Thought: '+chPin.id)&&post.content.includes('Anmerkung: Channel: bitte lesen.'),'3 Post an den ganzen Channel mit Pin + Zitat als Block',post.content);
 ok((await inbox())===vorInbox,'3 keine Inbox-Zeile');
 await wait(async()=>(await karten('[data-fenster="c"] .channel-composer')).length===0,'Channel-Entwurf nach dem Senden leer');
 await wait(async()=>!!(await evaluate("!!document.querySelector('[data-fenster=\"c\"] .channel-messages .zitat-karten-nachricht')")),'Zitate im Channel-Feed als Kaertchen');
 ok(!(await evaluate("[...document.querySelectorAll('[data-fenster=\"c\"] .channel-messages')].some(e=>e.innerText.includes('[Synapse-Zitate'))")),'3 Feed zeigt den Block als Kaertchen, nicht als Rohtext');
 await shot('dunkel-channel-gesendet');

 // ================================================================ 4 ohne Herkunft (Artefakte-Seite, Dashboard im Main-Provider)
 await oeffne('ohne');
 await linkGeladen('[data-bereich="artefakte"]','P1-T2','Artefakte-Seite mit Verweis');
 await linkGeladen('[data-bereich="dashboard"]','P1-T3','Dashboard mit Verweis');
 vorInbox=await inbox();vorPosts=await posts();
 const kontext=await json("(()=>{const e=[...document.querySelectorAll('[data-bereich=\"dashboard\"] .verweis-link')].find(b=>b.textContent.trim()==='P1-T3');"
  +"const ev=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20});e.dispatchEvent(ev);return JSON.stringify({verhindert:ev.defaultPrevented,menue:!!document.querySelector('.zitat-menue')})})()");
 ok(!kontext.verhindert&&!kontext.menue,'4 Dashboard/Top-Artefakte: kein neues Menue am Verweis (Browser-Menue bleibt)',kontext);
 await klickeLink('[data-bereich="dashboard"]','P1-T3');await ladeFenster('/Beschreibung P1-T3/','Lesefenster aus dem Dashboard');
 ok((await fensterAttr('/Beschreibung P1-T3/','data-lesefenster-herkunft'))==='ohne','4 Dashboard im Main-Provider: Herkunft ohne');
 await klickeLink('[data-fenster="m"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster aus dem Main daneben');
 ok((await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-herkunft'))==='main','4 derselbe Provider, Main-Chat daneben: Herkunft main');
 await schliesseFenster();
 await klickeLink('[data-bereich="dashboard"]','P1-T3');await ladeFenster('/Beschreibung P1-T3/','Lesefenster P1-T3 erneut');
 meldung=await pinne('/Beschreibung P1-T3/','Dashboard: nur speichern.');
 const p3=await pins('P1-T3');
 ok(p3.length===1&&p3[0].content==='Dashboard: nur speichern.','4 Pin gespeichert (thought an P1-T3)',p3);
 ok(meldung.trim()==='Angepinnt an Task P1-T3.','4 Meldung ohne Kaertchen-Zusatz (nur speichern)',meldung);
 ok((await karten('[data-fenster="m"]')).length===0&&(await evaluate("localStorage.getItem('synapse:zitat-entwurf:main')"))===null,'4 kein Kaertchen im Main-Entwurf');
 await schliesseFenster();
 // Empfaengerauswahl von der Artefakte-Seite
 await klickeLink('[data-bereich="artefakte"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster aus der Artefakte-Seite');
 ok((await fensterAttr('/Beschreibung P1-T2/','data-lesefenster-herkunft'))==='ohne','4 Artefakte-Seite: Herkunft ohne');
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.verweis-zitat[data-zitat-ohne-herkunft]'))),'Knopf Zitat anfügen (ohne Herkunft)');
 await klick(imFenster('/Beschreibung P1-T2/','.verweis-zitat[data-zitat-ohne-herkunft]'));
 // (angepasst P22-T171: Eingabefeld - die Vorschlaege erscheinen erst nach Klick ins Feld; Auswahl per Klick auf den Vorschlag)
 await wait(async()=>!!(await evaluate("!!document.querySelector('.zitat-empfaenger .zitat-empfaenger-eingabe')")),'Eingabefeld der Empfaengerauswahl');
 await klick("document.querySelector('.zitat-empfaenger .zitat-empfaenger-eingabe')");
 await wait(async()=>(await evaluate("document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]').length"))===5,'Empfaengerliste geladen');
 const liste=await json("JSON.stringify([...document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]')].map(l=>l.getAttribute('data-empfaenger')))");
 ok(liste.join()==='main,koordinator,claude-t50,deploy-t200,rea4','4 Agenten des Projekts inkl. Main und Koordinator',liste);
 const sicht=async()=>json("(()=>{const u=document.querySelector('.zitat-empfaenger-liste');const l=u.querySelector('li');return JSON.stringify({sichtbar:Math.round(u.clientHeight/l.offsetHeight),scroll:u.scrollHeight>u.clientHeight+1,zeilen:u.querySelectorAll('li').length})})()");
 let s=await sicht();
 ok(s.sichtbar===3&&s.scroll,'4 genau 3 Zeilen sichtbar, Rest per Scrollen',s);
 await shot('dunkel-ohne-empfaengerauswahl');
 await setze('.zitat-empfaenger-filter','rea');
 await wait(async()=>(await evaluate("document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]').length"))===1,'Filter rea');
 s=await sicht();
 ok(s.sichtbar===1&&s.zeilen===1,'4 gefiltert: ein Treffer (P22-T171: hoechstens 3 sichtbar statt fester Hoehe)',s);
 await klick("document.querySelector('.zitat-empfaenger li[data-empfaenger=\"rea4\"]')");
 await setze('.zitat-empfaenger-filter','');
 await wait(async()=>(await evaluate("document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]').length"))===5,'Filter leer');
 await klick("document.querySelector('.zitat-empfaenger li[data-empfaenger=\"koordinator\"]')");
 await setze('.zitat-empfaenger-filter','koord');
 await wait(async()=>(await evaluate("document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]').length"))===1,'Filter koord');
 await setze('.zitat-empfaenger-filter','');
 await wait(async()=>(await evaluate("document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]').length"))===5,'Filter wieder leer');
 const gewaehlt=await json("JSON.stringify([...document.querySelectorAll('.zitat-empfaenger li[data-empfaenger][aria-selected=\"true\"]')].map(l=>l.getAttribute('data-empfaenger')))");
 ok(gewaehlt.sort().join()==='koordinator,rea4'&&String(await evaluate("document.querySelector('.zitat-empfaenger').getAttribute('data-zitat-empfaenger-auswahl')"))==='2','4 Auswahl bleibt beim Filtern erhalten (2 gewaehlt)',gewaehlt);
 await setze('.zitat-empfaenger textarea','Ohne Chat: bitte lesen.');
 await shot('dunkel-ohne-auswahl-2');
 await klick(knopfIn('.zitat-empfaenger','Senden'));
 await wait(async()=>(await inbox())===vorInbox+2,'genau 2 Inbox-Zeilen');
 const zwei=(await pool.query("SELECT to_agent,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 2")).rows;
 ok(zwei.map(z=>z.to_agent).sort().join()==='koordinator,rea4','4 genau an die 2 Gewaehlten',zwei.map(z=>z.to_agent));
 ok(zwei[0].content===zwei[1].content&&zwei[0].content.startsWith('[Synapse-Zitate: 1]')&&zwei[0].content.includes('1) Task P1-T2')&&zwei[0].content.includes('Anmerkung: Ohne Chat: bitte lesen.'),'4 je Empfaenger eine Zeile, gleicher Block',zwei[0].content);
 ok((await posts())===vorPosts,'4 kein Channel-Post');
 await wait(async()=>/Zitat gesendet an rea4, koordinator\./.test(await evaluate("("+fenster('/Beschreibung P1-T2/')+")?.innerText??''")),'Meldung gesendet');
 ok(true,'4 Meldung nennt die Empfaenger');
 await shot('dunkel-ohne-gesendet');

 // ---------------------------------------------------------------- hell
 await oeffne('ohne','light');
 await linkGeladen('[data-bereich="artefakte"]','P1-T2','hell: Artefakte-Seite');
 await klickeLink('[data-bereich="artefakte"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','hell: Lesefenster');
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.verweis-zitat[data-zitat-ohne-herkunft]'))),'hell: Knopf');
 await klick(imFenster('/Beschreibung P1-T2/','.verweis-zitat[data-zitat-ohne-herkunft]'));
 await wait(async()=>!!(await evaluate("!!document.querySelector('.zitat-empfaenger .zitat-empfaenger-eingabe')")),'hell: Eingabefeld');
 await klick("document.querySelector('.zitat-empfaenger .zitat-empfaenger-eingabe')");
 await wait(async()=>(await evaluate("document.querySelectorAll('.zitat-empfaenger li[data-empfaenger]').length"))===5,'hell: Liste');
 await klick("document.querySelector('.zitat-empfaenger li[data-empfaenger=\"main\"]')");
 await shot('hell-ohne-empfaengerauswahl');
 await oeffne('channel','light');
 await linkGeladen('[data-fenster="c"] .channel-messages','P1-T2','hell: Channel');
 await wait(async()=>!!(await evaluate("!!document.querySelector('[data-fenster=\"c\"] .channel-messages .zitat-karten-nachricht')")),'hell: Zitate im Feed');
 await shot('hell-channel-feed-zitate');

 // ---------------------------------------------------------------- AUS: Bestand
 await testSchalter(false);
 await oeffne('ohne');
 await linkGeladen('[data-bereich="artefakte"]','P1-T2','AUS: Artefakte-Seite');
 await klickeLink('[data-bereich="artefakte"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','AUS: Lesefenster');
 await sleep(800);
 ok(!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.verweis-zitat')))&&!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.verweis-entscheidung'))),'AUS: kein Zitat-/Pin-Knopf (Bestand)');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,schalter:'intern_schalter chat_zitate (befristet), Produkt-Schalter AUS'},null,2));
 console.log('PASS P22-T170 Lesefenster-Herkunft Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
