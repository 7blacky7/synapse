/** P22-T171: Browserabnahme 'Pin ohne Herkunft optional an Agenten' + 'Empfaengerauswahl als Eingabefeld' im KI-Browser
 *  (privates synapse_test-Schema, echte API, Skripte per API).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/pin-empfaenger-browser-p22-t171.test.mjs
 * Testseite web-ui/tests/lesefenster-herkunft.html (Fixture lesefenster-herkunft-fixture.tsx, ansicht ohne|agent, memory=<name>).
 * Sichert ab (Task P22-T171; User inbox 1258, Entscheidung 83b5014f):
 *   1 Artefakte-Seite (ohne Herkunft): Pin OHNE Auswahl = nur gespeichert, 0 Inbox (UserEntscheidung.tsx, ZitatEmpfaenger.tsx).
 *   2 Eingabefeld (useEmpfaengerFeld): Klick oeffnet, Tippen filtert, hoechstens 3 sichtbar + Scrollen, Marken mit x, Escape und Klick
 *     daneben schliessen; Pin MIT 2 Empfaengern = gespeichert + genau 2 Inbox-Zeilen, Block 'Angepinnte User-Entscheidung an Task P1-T2'.
 *   3 Pin an eine Memory (Punkt 4): Tag memory:<name>, Liste im Lesefenster.
 *   4 Agenten-Chat (Herkunft, T170 unveraendert): Pin-Kaertchen und Kennzeichnung im gesendeten Block/Feed (Punkt 5).
 * Schalter chat_zitate NUR ueber den befristeten internen Test-Schalter. Jedes Warten hat ein Zeitlimit (keine Schleife ohne Ende).
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ... | screenshot ...'. Screenshots: ui-screenshots/p22-t171/<lauf-id>/*.png (P25-T7). */
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
const schema='p22_t171b_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t171-browser',MEM='regel-t171-test';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0,letzterShot='';
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
 console.error('DEBUG Timeout '+label+' | screenshot '+letzterShot);throw Error('Timeout: '+label);};
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert und letztem Screenshot.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):'')+' | screenshot '+letzterShot);assert(value,label);console.log('OK '+label);};
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
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',true,'T171 Browser-Fixture','user')",[P]);
 await pool.query("DELETE FROM intern_schalter WHERE name='chat_zitate'");
 await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',true,NOW()+interval '2 hours','T171 Browserabnahme (befristet)')");
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$6,'koordinator','koordinator','koordinator','aktiv','t171'),($2,$6,'rea4','rea4','subagent','aktiv','t171'),($3,$6,'claude-t50','claude-t50','subagent','aktiv','t171'),
  ($4,$6,'deploy-t200','deploy-t200','subagent','aktiv','t171'),($5,'synapse-hauptagent','main','main','main','aktiv','t171')`,[A,B,Cid,D,M,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Pins','',$3::jsonb,true,'P1','hoch')",
  [randomUUID(),P,JSON.stringify([task(2,'in_progress','Zweite Aufgabe'),task(3,'todo','Dritte Aufgabe')])]);
 await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,$3,'rules','Regel fuer die T171-Browserabnahme.',ARRAY[]::text[])",[randomUUID(),P,MEM]);
 await pool.query("INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES('koordinator','user','Stand: P1-T2 ist offen.',$1,$2,null,$3)",
  [P,A,new Date(Date.UTC(2026,9,25,19,1)).toISOString()]);
 const zaehle=async(sql,p=[])=>Number((await pool.query(sql,p)).rows[0].n);
 const inbox=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user'");
 const pins=async tag=>(await pool.query("SELECT id::text id,content,tags,task_id FROM thoughts WHERE project=$1 AND 'user-entscheidung'=ANY(tags) AND $2=ANY(tags) ORDER BY timestamp",[P,tag])).rows;
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.register(S.specialistRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 // optimizeDeps.entries wie T170: Vite kennt alle Abhaengigkeiten der Testseite vor dem ersten Laden (sonst Neuladen mitten im Test).
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/lesefenster-herkunft.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t171/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t171'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(ansicht,theme='dark')=>ui+'/tests/lesefenster-herkunft.html?project='+P+'&a='+A+'&token='+encodeURIComponent(sitzung)+'&theme='+theme+'&ansicht='+ansicht+'&memory='+MEM;
 let zuletzt=null;
 const bereit=()=>wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
 const oeffne=async(ansicht,theme)=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});zuletzt=url(ansicht,theme)+'&leeren=1';tab=(await kb('/tabs/new',{url:zuletzt})).tab_id;await bereit();};
 const S_=JSON.stringify;
 const linkDa=(bereich,text)=>evaluate("!![...document.querySelectorAll("+S_(bereich+' .verweis-link')+")].find(b=>b.textContent.trim()==="+S_(text)+")");
 // Haengt die Seite (selten, KI-Browser), wird sie GENAU einmal neu geladen (wie T170).
 const linkGeladen=async(bereich,text,label)=>{
  try{await wait(()=>linkDa(bereich,text),label,12000);}
  catch{console.log('HINWEIS neu laden: '+label);await kb('/navigate',{tab_id:tab,url:zuletzt});await bereit();await wait(()=>linkDa(bereich,text),label,30000);}
 };
 const klickeLink=(bereich,text)=>evaluate("(()=>{const b=[...document.querySelectorAll("+S_(bereich+' .verweis-link')+")].find(b=>b.textContent.trim()==="+S_(text)+");if(!b)return false;b.click();return true})()");
 const fenster=re=>"[...document.querySelectorAll('.verweis-fenster')].find(f=>"+re+".test(f.innerText))";
 const imFenster=(re,sel)=>"("+fenster(re)+")?.querySelector("+S_(sel)+")";
 const klick=sel=>evaluate("(()=>{const e="+sel+";if(!e)return false;e.click();return true})()");
 const tippe=(selector,text)=>kb('/type',{tab_id:tab,selector,text});
 const ladeFenster=async(re,label)=>wait(async()=>!!(await evaluate('!!'+fenster(re))),label);
 const schliesseFenster=()=>evaluate("[...document.querySelectorAll('.verweis-fenster .verweis-titel button')].filter(b=>b.getAttribute('aria-label')==='Fenster schließen').forEach(b=>b.click())");
 const ED='[data-user-entscheidung-editor]';
 const feldStand=()=>json("(()=>{const f=document.querySelector("+S_(ED+' .zitat-empfaenger-feld')+");if(!f)return JSON.stringify(null);const u=f.querySelector('.zitat-empfaenger-liste');const l=u?.querySelector('li');"
  +"return JSON.stringify({offen:f.getAttribute('data-empfaenger-offen'),zeilen:u?u.querySelectorAll('li[data-empfaenger]').length:0,namen:u?[...u.querySelectorAll('li[data-empfaenger]')].map(x=>x.getAttribute('data-empfaenger')):[],"
  +"sichtbar:u&&l?Math.round(u.clientHeight/l.offsetHeight):0,scroll:u?u.scrollHeight>u.clientHeight+1:false,marken:[...f.querySelectorAll('.zitat-empfaenger-marke')].map(m=>m.getAttribute('data-marke')),"
  +"wert:f.querySelector('input').value})})()");
 const editorAuf=async(re)=>{
  await wait(async()=>!!(await evaluate('!!'+imFenster(re,'.verweis-entscheidung'))),'Knopf User-Entscheidung anpinnen');
  await klick(imFenster(re,'.verweis-entscheidung'));
  await wait(async()=>!!(await evaluate('!!'+imFenster(re,ED+' textarea'))),'Pin-Editor');
 };
 const speichern=async(re,knopfText)=>{
  await klick("[...document.querySelectorAll('"+ED+" button')].find(b=>b.textContent.trim()==="+S_(knopfText)+")");
  await wait(async()=>/Angepinnt an /.test(await evaluate("("+fenster(re)+")?.querySelector('.user-entscheidung-meldung')?.innerText??''")),'Meldung Angepinnt');
  return evaluate("("+fenster(re)+")?.querySelector('.user-entscheidung-meldung')?.innerText??''");
 };
 const HU='P22-T171 UserEntscheidung.tsx+ZitatEmpfaenger.tsx (KI-Browser)';
 const HF='P22-T171 ZitatEmpfaenger.tsx useEmpfaengerFeld (KI-Browser)';

 // ================================================================ 1 Artefakte-Seite: Pin ohne Auswahl = nur gespeichert
 await oeffne('ohne');
 await linkGeladen('[data-bereich="artefakte"]','P1-T2','Artefakte-Seite mit Verweis P1-T2');
 let vorInbox=await inbox();
 await klickeLink('[data-bereich="artefakte"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster P1-T2 (Artefakte)');
 ok((await evaluate("("+fenster('/Beschreibung P1-T2/')+")?.getAttribute('data-lesefenster-herkunft')"))==='ohne','P22-T171 Lesefenster.tsx: Artefakte-Seite = Herkunft ohne');
 await editorAuf('/Beschreibung P1-T2/');
 let f=await feldStand();
 ok(f&&f.offen==='0'&&f.zeilen===0&&f.marken.length===0,HF+': Editor zeigt das Eingabefeld, Vorschlaege noch zu',f);
 await shot('dunkel-pin-editor-feld-zu');
 await tippe('.verweis-fenster '+ED+' textarea','Artefakt: nur speichern.');
 let meldung=await speichern('/Beschreibung P1-T2/','Speichern');
 let p=await pins('P1-T2');
 ok(p.length===1&&p[0].content==='Artefakt: nur speichern.'&&p[0].task_id==='P1-T2',HU+': ohne Auswahl gespeichert (thought an P1-T2)',p);
 ok(meldung.trim()==='Angepinnt an Task P1-T2.'&&(await inbox())===vorInbox,HU+': ohne Auswahl 0 Inbox-Zeilen, Meldung ohne Zusatz',{meldung,inbox:await inbox(),vorInbox});
 await shot('dunkel-pin-nur-gespeichert');

 // ================================================================ 2 Eingabefeld + Pin mit 2 Empfaengern
 vorInbox=await inbox();
 await editorAuf('/Beschreibung P1-T2/');
 await tippe('.verweis-fenster '+ED+' textarea','Artefakt: an zwei Agenten.');
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-eingabe')+")");
 await wait(async()=>(await feldStand())?.zeilen===5,'Vorschlaege nach Klick geladen');
 f=await feldStand();
 ok(f.offen==='1'&&f.namen.join()==='main,koordinator,claude-t50,deploy-t200,rea4',HF+': Klick ins Feld oeffnet die Vorschlaege (Agenten inkl. Main/Koordinator)',f);
 ok(f.sichtbar===3&&f.scroll,HF+': hoechstens 3 sichtbar, mehr per Scrollen',f);
 await shot('dunkel-feld-offen-3-sichtbar');
 await tippe('.verweis-fenster '+ED+' .zitat-empfaenger-filter','rea');
 await wait(async()=>(await feldStand())?.zeilen===1,'Tippen filtert auf rea4');
 f=await feldStand();
 ok(f.namen.join()==='rea4'&&f.wert==='rea',HF+': Tippen filtert',f);
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-liste li[data-empfaenger="rea4"]')+")");
 await wait(async()=>(await feldStand())?.marken.join()==='rea4','Marke rea4');
 f=await feldStand();
 ok(f.wert===''&&f.offen==='1'&&f.zeilen===5,HF+': Auswahl per Klick -> Marke, Filter leer, Liste bleibt offen',f);
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-liste li[data-empfaenger="main"]')+")");
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-liste li[data-empfaenger="koordinator"]')+")");
 await wait(async()=>(await feldStand())?.marken.length===3,'drei Marken');
 await shot('dunkel-feld-drei-marken');
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-marke[data-marke="main"] button')+")");
 await wait(async()=>(await feldStand())?.marken.join()==='rea4,koordinator','Marke main entfernt');
 ok(true,HF+': x an der Marke entfernt (rea4, koordinator bleiben)');
 await evaluate("document.querySelector("+S_(ED+' .zitat-empfaenger-filter')+").dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
 await wait(async()=>(await feldStand())?.offen==='0','Escape schliesst die Liste');
 ok(!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/',ED))),HF+': Escape schliesst nur die Liste, der Editor bleibt offen');
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-eingabe')+")");
 await wait(async()=>(await feldStand())?.offen==='1','erneut offen');
 // Klick daneben: der Fokus wandert aus dem Feld (focusout mit Ziel ausserhalb, wie bei einem Mausklick in die Textflaeche).
 await evaluate("(()=>{const t=document.querySelector("+S_(ED+' textarea')+");document.querySelector("+S_(ED+' .zitat-empfaenger-filter')+").dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:t}));t.focus();})()");
 await wait(async()=>(await feldStand())?.offen==='0','Klick daneben schliesst');
 ok(true,HF+': Klick daneben schliesst die Liste');
 const knopfText=await evaluate("[...document.querySelectorAll('"+ED+" button.zitat-speichern')].map(b=>b.textContent.trim())[0]");
 ok(knopfText==='Speichern und senden',HU+': mit Auswahl heisst der Knopf "Speichern und senden"',knopfText);
 await shot('dunkel-pin-zwei-empfaenger');
 meldung=await speichern('/Beschreibung P1-T2/','Speichern und senden');
 await wait(async()=>(await inbox())===vorInbox+2,'genau 2 Inbox-Zeilen');
 p=await pins('P1-T2');
 const neu=p.find(x=>x.content==='Artefakt: an zwei Agenten.');
 ok(neu&&p.length===2,HU+': Pin gespeichert (2. Pin an P1-T2)',p);
 const zwei=(await pool.query("SELECT to_agent,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 2")).rows;
 ok(zwei.map(z=>z.to_agent).sort().join()==='koordinator,rea4'&&(await inbox())===vorInbox+2,HU+': genau 2 Inbox-Zeilen an genau die Gewaehlten',zwei.map(z=>z.to_agent));
 ok(zwei[0].content===zwei[1].content&&zwei[0].content.startsWith('[Synapse-Zitate: 1]\n1) Angepinnte User-Entscheidung an Task P1-T2\n   Thought: '+neu.id)
  &&zwei[0].content.includes('Wortlaut: Artefakt: an zwei Agenten.')&&!/Anmerkung:/.test(zwei[0].content),'P22-T171 chat-zitate.ts baueZitatBlock (KI-Browser): Pin gekennzeichnet, Wortlaut, keine leere Anmerkung',zwei[0].content);
 ok(/^Angepinnt an Task P1-T2\. Gesendet an rea4, koordinator\.$/.test(meldung.trim()),HU+': Meldung nennt die Empfaenger',meldung);
 await shot('dunkel-pin-gesendet');
 await schliesseFenster();

 // ================================================================ 3 Pin an eine Memory (Punkt 4)
 await linkGeladen('[data-bereich="artefakte-memory"]',MEM,'Memory-Verweis auf der Artefakte-Seite');
 vorInbox=await inbox();
 await klickeLink('[data-bereich="artefakte-memory"]',MEM);await ladeFenster('/Regel fuer die T171-Browserabnahme/','Lesefenster Memory');
 await editorAuf('/Regel fuer die T171-Browserabnahme/');
 await tippe('.verweis-fenster '+ED+' textarea','Memory: gilt weiter.');
 meldung=await speichern('/Regel fuer die T171-Browserabnahme/','Speichern');
 const memPins=(await pool.query("SELECT content,tags,task_id FROM thoughts WHERE project=$1 AND 'user-entscheidung'=ANY(tags) AND EXISTS(SELECT 1 FROM unnest(tags) x WHERE x LIKE 'memory:%')",[P])).rows;
 ok(memPins.length===1&&memPins[0].content==='Memory: gilt weiter.'&&!memPins[0].task_id,'P22-T171 user-entscheidung.ts (KI-Browser): Pin an Memory, Tag memory:<id>, ohne task_id',memPins);
 ok(/^Angepinnt an Memory /.test(meldung.trim())&&(await inbox())===vorInbox,HU+': Memory-Pin ohne Auswahl nur gespeichert',meldung);
 await wait(async()=>/User-Entscheidungen \(1\)/i.test(await evaluate("("+fenster('/Regel fuer die T171-Browserabnahme/')+")?.querySelector('.user-entscheidungen')?.innerText??''")),'Liste im Memory-Lesefenster');
 ok(true,'P22-T171 UserEntscheidung.tsx (KI-Browser): angepinnte Entscheidung im Memory-Lesefenster sichtbar');
 await shot('dunkel-memory-pin');

 // ================================================================ 4 Agenten-Chat (Herkunft): Kennzeichnung im Block und im Feed
 await oeffne('agent');
 await linkGeladen('[data-fenster="a"]','P1-T2','Agentenfenster mit Verweis P1-T2');
 vorInbox=await inbox();
 await klickeLink('[data-fenster="a"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','Lesefenster aus dem Agenten-Chat');
 await editorAuf('/Beschreibung P1-T2/');
 ok(!(await evaluate('!!document.querySelector('+S_(ED+' .zitat-empfaenger-feld')+')')),'P22-T171 Lesefenster.tsx (KI-Browser): mit Chat-Herkunft kein Empfaenger-Feld (T170 unveraendert)');
 await tippe('.verweis-fenster '+ED+' textarea','Chat: so umsetzen.');
 meldung=await speichern('/Beschreibung P1-T2/','Speichern');
 ok(/Als Kärtchen im Entwurf an koordinator\./.test(meldung),'P22-T171 Lesefenster.tsx (KI-Browser): Pin als Kaertchen in den Entwurf (T170)',meldung);
 const karte=await evaluate("document.querySelector('[data-fenster=\"a\"] .zitat-entwuerfe .zitat-karte.ist-pin')?.innerText.replace(/\\s+/g,' ').trim()??''");
 ok(/^Angepinnte User-Entscheidung an Task P1-T2/.test(karte),'P22-T171 ZitatAnhaenge.tsx (KI-Browser): Kaertchen "Angepinnte User-Entscheidung an Task P1-T2"',karte);
 await schliesseFenster();
 await tippe('[data-fenster="a"] .chat-eingabefeld textarea','Bitte ansehen');
 await klick("document.querySelector('[data-fenster=\"a\"] .composer-send')");
 await wait(async()=>(await inbox())===vorInbox+1,'eine Inbox-Zeile an koordinator');
 const zeile=(await pool.query("SELECT to_agent,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(zeile.to_agent==='koordinator'&&zeile.content.startsWith('Bitte ansehen\n\n[Synapse-Zitate: 1]\n1) Angepinnte User-Entscheidung an Task P1-T2')&&!/Anmerkung:/.test(zeile.content),
  'P22-T171 chat-zitate.ts (KI-Browser): Agenten-Chat sendet den Pin gekennzeichnet, ohne leere Anmerkung',zeile);
 await wait(async()=>/Angepinnte User-Entscheidung an Task P1-T2/.test(await evaluate("document.querySelector('[data-fenster=\"a\"] .zitat-karten-nachricht')?.innerText??''")),'Feed zeigt den Pin gekennzeichnet',30000);
 ok(true,'P22-T171 zitat-logik.ts zerlegeZitatBlock (KI-Browser): Feed-Kaertchen "Angepinnte User-Entscheidung an Task P1-T2"');
 await shot('dunkel-agent-feed-pin');

 // ---------------------------------------------------------------- hell
 await oeffne('ohne','light');
 await linkGeladen('[data-bereich="artefakte"]','P1-T2','hell: Artefakte-Seite');
 await klickeLink('[data-bereich="artefakte"]','P1-T2');await ladeFenster('/Beschreibung P1-T2/','hell: Lesefenster');
 await editorAuf('/Beschreibung P1-T2/');
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-eingabe')+")");
 await wait(async()=>(await feldStand())?.zeilen===5,'hell: Vorschlaege');
 await klick("document.querySelector("+S_(ED+' .zitat-empfaenger-liste li[data-empfaenger="rea4"]')+")");
 await wait(async()=>(await feldStand())?.marken.join()==='rea4','hell: Marke');
 await shot('hell-feld-offen-marke');
 // Zitat ohne Herkunft nutzt dasselbe Feld (gilt fuer Zitat UND Pin)
 await klick("document.querySelector("+S_(ED+' footer button')+")");
 await klick(imFenster('/Beschreibung P1-T2/','.verweis-zitat[data-zitat-ohne-herkunft]'));
 await wait(async()=>!!(await evaluate("!!document.querySelector('.zitat-empfaenger .zitat-empfaenger-feld')")),'Zitat-Bereich mit Feld');
 ok(!(await evaluate("!!document.querySelector('.zitat-empfaenger input[type=checkbox]')"))&&String(await evaluate("document.querySelector('.zitat-empfaenger .zitat-empfaenger-feld').getAttribute('data-empfaenger-offen')"))==='0',
  'P22-T171 ZitatEmpfaenger.tsx useZitatEmpfaengerAuswahl (KI-Browser): Zitat ohne Herkunft mit Eingabefeld, keine Checkboxen');
 await shot('hell-zitat-feld');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,schalter:'intern_schalter chat_zitate (befristet), Produkt-Schalter AUS'},null,2));
 console.log('PASS P22-T171 Pin-Empfaenger Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
