/** P22-T168: Browserabnahme der Zitat-Anhaenge im KI-Browser (privates synapse_test-Schema, echte API, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/chat-zitate-browser-p22-t168.test.mjs
 * Fixture: Plan P1 (Tasks P1-T1..T3), Koordinator A und Spezialist B im selben Projekt, Inbox-Nachrichten mit Verweisen, zwei echte
 * Agentenfenster (EinheitlicherAgentChat). Schalter chat_zitate NUR ueber den befristeten internen Test-Schalter (Produkt-Schalter AUS).
 * Prueft dunkel: AUS = kein Menue; EIN: Rechtsklick auf Verweis -> Menue -> Anmerkung -> Kaertchen nur in A; Markierung -> Ausschnitt;
 * Abbrechen; Bearbeiten; Knopf im Lesefenster; x; F5 behaelt den Entwurf; Senden -> genau EINE Inbox-Zeile an A mit Block, B und
 * Channels unberuehrt, Kaertchen in der Nachricht; B nur mit Zitat. Hell: Menue und Editor. Mobil: langes Druecken.
 * Screenshots: ui-screenshots/p22-t168/<lauf-id>/ (P25-T7). */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
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
// Befristeter interner Test-Schalter: intern-Tool beim Start EIN (nur dieser Testprozess); der Produkt-Schalter bleibt AUS.
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t168_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t168-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,600):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const task=(nr,status,titel)=>({id:randomUUID(),kurz_id:'P1-T'+nr,title:titel,description:'Beschreibung P1-T'+nr+': im Lesefenster lesbar.',status,priority:'medium',
 createdAt:'2026-10-2'+nr+'T10:00:00Z',updatedAt:'2026-10-2'+nr+'T10:00:00Z'});
const A=randomUUID(),Bid=randomUUID();
const NACHRICHT_A='Stand: P1-T2 ist offen. Details stehen in P1-T3, bitte zuerst den Abschnitt zur Zustellung lesen.';
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
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',true,'T168 Browser-Fixture','user')",[P]);
 const testSchalter=async aktiv=>{await pool.query("DELETE FROM intern_schalter WHERE name='chat_zitate'");
  await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',$1,NOW()+interval '2 hours','T168 Browserabnahme (befristet)')",[aktiv]);};
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$3,'koordinator','koordinator','koordinator','aktiv','t168'),($2,$3,'rea4','rea4','subagent','aktiv','t168')",[A,Bid,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Zitat-Anhaenge','',$3::jsonb,true,'P1','hoch')",
  [randomUUID(),P,JSON.stringify([task(1,'done','Erste Aufgabe'),task(2,'in_progress','Zweite Aufgabe'),task(3,'todo','Dritte Aufgabe')])]);
 const inbox=(von,an,text,vonId,anId,min)=>pool.query('INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [von,an,text,P,vonId,anId,new Date(Date.UTC(2026,9,25,19,min)).toISOString()]);
 await inbox('koordinator','user',NACHRICHT_A,A,null,1);
 await inbox('rea4','user','Hallo von rea4 zu P1-T1.',Bid,null,2);
 const zaehle=async(sql,p=[])=>Number((await pool.query(sql,p)).rows[0].n);
 const anA=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user' AND (to_identity_id=$1 OR to_agent='koordinator')",[A]);
 const anB=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user' AND (to_identity_id=$1 OR to_agent='rea4')",[Bid]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.ready();
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t168/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t168'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(f,Buffer.from(await r.arrayBuffer())));};
 const url=(theme,ansicht='zwei')=>ui+'/tests/chat-zitate.html?project='+P+'&a='+A+'&b='+Bid+'&theme='+theme+'&ansicht='+ansicht;
 const oeffne=async(theme,ansicht)=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(theme,ansicht)})).tab_id;};
 // Verweis-Link im Fenster markieren und seine Mitte liefern.
 const link=(f,text)=>json('(()=>{const e=[...document.querySelectorAll(\'[data-fenster="'+f+'"] .verweis-link\')].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');'
  +'if(!e)return "null";const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()');
 const rechts=async p=>kb('/click',{tab_id:tab,x:p.x,y:p.y,button:'right'});
 const menue=()=>json("JSON.stringify([...document.querySelectorAll('.zitat-menue button')].map(b=>b.textContent.trim()))");
 const menuePunkt=t=>evaluate("(()=>{const b=[...document.querySelectorAll('.zitat-menue button')].find(x=>x.textContent.trim().startsWith("+JSON.stringify(t)+"));if(!b)return false;b.click();return true})()");
 const editorText=()=>evaluate("document.querySelector('.zitat-editor')?.innerText??''");
 const editorKnopf=t=>evaluate("(()=>{const b=[...document.querySelectorAll('.zitat-editor button')].find(x=>x.textContent.trim()==="+JSON.stringify(t)+");if(!b)return false;b.click();return true})()");
 const tippe=async(selector,text)=>kb('/type',{tab_id:tab,selector,text});
 const karten=f=>json("JSON.stringify([...document.querySelectorAll('[data-fenster=\""+f+"\"] .zitat-entwuerfe .zitat-karte')].map(k=>k.innerText.replace(/\\s+/g,' ').trim()))");
 const entwurf=id=>json("JSON.stringify(JSON.parse(localStorage.getItem('synapse:zitat-entwurf:agent:"+id+"')||'[]'))");
 const geladen=async()=>{await wait(async()=>!!(await link('a','P1-T2')),'Fenster A mit Verweis P1-T2');await wait(async()=>!!(await link('b','P1-T1')),'Fenster B mit Verweis P1-T1');};

 // ---------------------------------------------------------------- AUS (befristeter Test-Schalter AUS) = Bestand
 await testSchalter(false);
 await oeffne('dark');await geladen();await sleep(600);
 const aus=await json("(()=>{const e=[...document.querySelectorAll('[data-fenster=\"a\"] .verweis-link')].find(b=>b.textContent.trim()==='P1-T2');"
  +"const ev=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10});e.dispatchEvent(ev);"
  +"return JSON.stringify({verhindert:ev.defaultPrevented,menue:!!document.querySelector('.zitat-menue'),schalter:document.querySelector('[data-fenster=\"a\"] section').getAttribute('data-zitat-schalter')})})()");
 ok(!aus.verhindert&&!aus.menue&&aus.schalter==='aus','AUS: Rechtsklick bleibt beim Browser-Menue, kein Zitat-Menue',aus);

 // ---------------------------------------------------------------- EIN (befristeter Test-Schalter EIN)
 await testSchalter(true);
 await oeffne('dark');await geladen();
 await wait(async()=>(await evaluate("document.querySelector('[data-fenster=\"a\"] section').getAttribute('data-zitat-schalter')"))==='ein','Schalter EIN im Fenster');
 const vorA=await anA(),vorB=await anB();
 // 1 Rechtsklick auf P1-T2 in A
 await rechts(await link('a','P1-T2'));
 await wait(async()=>(await menue()).length>0,'Menue nach Rechtsklick');
 let m=await menue();
 ok(m[0]==='Zitat anfügen'&&m.includes('Öffnen'),'Rechtsklick auf Verweis: Zitat anfügen + Öffnen',m);
 await shot('dunkel-menue-verweis');
 ok(await menuePunkt('Zitat anfügen'),'Zitat anfügen gewaehlt');
 await wait(async()=>/Task P1-T2/.test(await editorText()),'Editor offen');
 ok(/Zweite Aufgabe/.test(await editorText())&&/Zitat an koordinator/i.test(await editorText()),'Editor: Art, ID, Titel, Empfaenger',await editorText());
 await tippe('.zitat-editor textarea','Bitte zuerst erledigen, dann melden.');
 await shot('dunkel-editor');
 ok(await editorKnopf('Speichern'),'Speichern');
 await wait(async()=>(await karten('a')).length===1,'Kaertchen in A');
 ok((await karten('b')).length===0,'Kaertchen nur im Fenster des Empfaengers A, nicht in B');
 ok(/Task P1-T2/.test((await karten('a'))[0])&&/Bitte zuerst erledigen/.test((await karten('a'))[0]),'Kaertchen: Art, ID, Titel, Anfang der Anmerkung',await karten('a'));
 await shot('dunkel-kaertchen-nur-in-a');
 // 2 Markierter Text in einer Nachricht von A
 const markiere=()=>json("(()=>{const ziel='den Abschnitt zur Zustellung';const w=document.createTreeWalker(document.querySelector('[data-fenster=\"a\"] .message-feed'),NodeFilter.SHOW_TEXT);"
  +"let n;while((n=w.nextNode())){const i=n.textContent.indexOf(ziel);if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+ziel.length);const s=getSelection();s.removeAllRanges();s.addRange(r);"
  +"const b=r.getBoundingClientRect();return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)})}}return 'null'})()");
 const sel=await markiere();
 ok(sel,'Text in der Nachricht markiert');
 await rechts(sel);await sleep(600);
 const diag=await json("JSON.stringify({auswahl:getSelection().toString(),menue:!!document.querySelector('.zitat-menue')})");
 if(!diag.menue){
  // Der Rechtsklick des KI-Browsers (CDP) hebt die Markierung vor dem contextmenu auf; dann dasselbe Ereignis im Browser ausloesen.
  console.log('HINWEIS echter Rechtsklick ohne Markierung: '+JSON.stringify(diag));
  const p2=await markiere();
  await evaluate("(()=>{const e=document.elementFromPoint("+p2.x+","+p2.y+");e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:"+p2.x+",clientY:"+p2.y+"}));return true})()");
 }
 await wait(async()=>(await menue()).length>0,'Menue nach Rechtsklick auf Markierung');
 m=await menue();
 ok(m[0]==='Zitat anfügen'&&m.includes('Kopieren'),'Markierung: eigenes Menue mit Kopieren (F4)',m);
 await shot('dunkel-markierung-menue');
 await menuePunkt('Zitat anfügen');
 await wait(async()=>/den Abschnitt zur Zustellung/.test(await editorText()),'Editor mit Ausschnitt');
 await tippe('.zitat-editor textarea','Diesen Satz bitte pruefen.');
 await editorKnopf('Speichern');
 await wait(async()=>(await karten('a')).length===2,'zweites Kaertchen');
 // 3 Abbrechen
 await rechts(await link('a','P1-T3'));await wait(async()=>(await menue()).length>0,'Menue P1-T3');
 await menuePunkt('Zitat anfügen');await wait(async()=>/Task P1-T3/.test(await editorText()),'Editor P1-T3');
 await editorKnopf('Abbrechen');await sleep(300);
 ok((await karten('a')).length===2&&!(await evaluate("!!document.querySelector('.zitat-editor')")),'Abbrechen fuegt nichts hinzu');
 // 4 Bearbeiten per Klick aufs Kaertchen
 await evaluate("document.querySelector('[data-fenster=\"a\"] .zitat-karte .zitat-karte-inhalt').click()");
 await wait(async()=>(await evaluate("document.querySelector('.zitat-editor textarea')?.value??''"))==='Bitte zuerst erledigen, dann melden.','Editor mit vorhandener Anmerkung');
 await tippe('.zitat-editor textarea','Bitte zuerst erledigen (geaendert).');
 await editorKnopf('Speichern');
 await wait(async()=>/geaendert/.test((await karten('a'))[0]),'Kaertchen bearbeitet');
 ok((await karten('a')).length===2,'Bearbeiten erzeugt kein weiteres Zitat');
 // 5 Knopf im Lesefenster (Linksklick auf P1-T3 oeffnet das Lesefenster)
 const l3=await link('a','P1-T3');await kb('/click',{tab_id:tab,x:l3.x,y:l3.y});
 await wait(async()=>!!(await evaluate("[...document.querySelectorAll('.verweis-fenster')].some(f=>/Beschreibung P1-T3/.test(f.innerText))")),'Lesefenster P1-T3');
 ok(await evaluate("!!document.querySelector('.verweis-fenster .verweis-zitat')"),'Lesefenster hat den Knopf Zitat anfügen');
 await shot('dunkel-lesefenster-knopf');
 await evaluate("document.querySelector('.verweis-fenster .verweis-zitat').click()");
 await wait(async()=>/Task P1-T3/.test(await editorText())&&/Dritte Aufgabe/.test(await editorText()),'Editor aus dem Lesefenster');
 await editorKnopf('Speichern');
 await wait(async()=>(await karten('a')).length===3,'drittes Kaertchen aus dem Lesefenster');
 await evaluate("[...document.querySelectorAll('.verweis-fenster .verweis-titel button')].filter(b=>b.getAttribute('aria-label')==='Fenster schließen').forEach(b=>b.click())");
 // 6 x loescht genau dieses Zitat
 await evaluate("[...document.querySelectorAll('[data-fenster=\"a\"] .zitat-karte-weg')][2].click()");
 await wait(async()=>(await karten('a')).length===2,'x entfernt das dritte Zitat');
 ok((await entwurf(A)).length===2&&(await entwurf(Bid)).length===0,'Entwurf je Chat in localStorage (A 2, B 0)');
 // 7 F5
 await kb('/navigate',{tab_id:tab,url:url('dark')});await geladen();
 await wait(async()=>(await karten('a')).length===2,'nach F5: Kaertchen in A wieder da');
 ok((await karten('b')).length===0,'nach F5: B ohne Kaertchen');
 await shot('dunkel-nach-f5');
 // 8 Senden in A
 await tippe('[data-fenster="a"] .chat-eingabefeld textarea','Bitte ansehen');
 await evaluate("document.querySelector('[data-fenster=\"a\"] .composer-send').click()");
 await wait(async()=>(await anA())===vorA+1,'genau eine neue Inbox-Zeile an A');
 const zeile=(await pool.query("SELECT content,to_agent,to_identity_id FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(zeile.to_agent==='koordinator'&&(zeile.to_identity_id===null||zeile.to_identity_id===A)&&zeile.content.startsWith('Bitte ansehen\n\n[Synapse-Zitate: 2]\n1) Task P1-T2'),'Inhalt: Nachricht + Block an A',zeile);
 ok(/Ausschnitt: den Abschnitt zur Zustellung/.test(zeile.content)&&/Quelle: Nachricht inbox:\d+/.test(zeile.content)&&/geaendert/.test(zeile.content),'Block enthaelt Ausschnitt mit Quelle und bearbeitete Anmerkung',zeile.content);
 ok((await anB())===vorB&&(await zaehle('SELECT count(*) n FROM specialist_channel_messages'))===0,'B und Channels unberuehrt (kein Rundversand)');
 await wait(async()=>(await karten('a')).length===0,'Entwurf nach dem Senden geleert');
 ok((await entwurf(A)).length===0,'localStorage-Entwurf von A geleert');
 await wait(async()=>!!(await evaluate("!!document.querySelector('[data-fenster=\"a\"] .zitat-karten-nachricht')")),'Zitate als Kaertchen in der gesendeten Nachricht');
 await sleep(2500);
 const sicht=await json("JSON.stringify({roh:/\\[Synapse-Zitate/.test(document.querySelector('[data-fenster=\"a\"] .message-feed').innerText),karten:document.querySelectorAll('[data-fenster=\"a\"] .zitat-karten-nachricht .zitat-karte-nachricht').length})");
 ok(!sicht.roh&&sicht.karten>=2,'Nachricht zeigt den Block nur als Kaertchen (kein Rohtext)',sicht);
 await shot('dunkel-gesendet-a');
 // 9 B nur mit Zitat (F3)
 await rechts(await link('b','P1-T1'));await wait(async()=>(await menue()).length>0,'Menue in B');
 await menuePunkt('Zitat anfügen');await wait(async()=>/Task P1-T1/.test(await editorText())&&/Zitat an rea4/i.test(await editorText()),'Editor in B');
 await editorKnopf('Speichern');await wait(async()=>(await karten('b')).length===1,'Kaertchen in B');
 ok((await karten('a')).length===0,'Zitat aus B landet nicht in A');
 await evaluate("document.querySelector('[data-fenster=\"b\"] .composer-send').click()");
 await wait(async()=>(await anB())===vorB+1,'eine Inbox-Zeile an B');
 const zb=(await pool.query("SELECT content,to_agent FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(zb.to_agent==='rea4'&&zb.content.startsWith('[Synapse-Zitate: 1]\n1) Task P1-T1'),'nur Zitat ohne Text an B',zb);
 ok((await anA())===vorA+1,'A bekommt dabei nichts');
 await sleep(1500);await shot('dunkel-b-nur-zitat');

 // ---------------------------------------------------------------- hell
 await oeffne('light');await geladen();
 await wait(async()=>(await evaluate("document.querySelector('[data-fenster=\"a\"] section').getAttribute('data-zitat-schalter')"))==='ein','hell: Schalter EIN');
 await rechts(await link('a','P1-T3'));await wait(async()=>(await menue()).length>0,'hell: Menue');
 await shot('hell-menue');
 await menuePunkt('Zitat anfügen');await wait(async()=>/Task P1-T3/.test(await editorText()),'hell: Editor');
 await tippe('.zitat-editor textarea','Helle Darstellung pruefen.');
 await shot('hell-editor');
 await editorKnopf('Speichern');await wait(async()=>(await karten('a')).length===1,'hell: Kaertchen');
 await shot('hell-kaertchen');
 await evaluate("document.querySelector('[data-fenster=\"a\"] .zitat-karte-weg').click()");

 // ---------------------------------------------------------------- mobil: langes Druecken (Touch)
 await oeffne('dark','mobil');
 await wait(async()=>!!(await link('a','P1-T2')),'mobil: Fenster A');
 await wait(async()=>(await evaluate("document.querySelector('[data-fenster=\"a\"] section').getAttribute('data-zitat-schalter')"))==='ein','mobil: Schalter EIN');
 const lm=await link('a','P1-T2');
 await evaluate("(()=>{const e=[...document.querySelectorAll('[data-fenster=\"a\"] .verweis-link')].find(b=>b.textContent.trim()==='P1-T2');"
  +"e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',clientX:"+lm.x+",clientY:"+lm.y+",isPrimary:true}));return true})()");
 await sleep(800);
 m=await menue();
 ok(m[0]==='Zitat anfügen','mobil: langes Druecken oeffnet das Menue',m);
 await evaluate("document.querySelector('[data-fenster=\"a\"] .verweis-link').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch'}))");
 await shot('mobil-langes-druecken');
 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,schalter:'intern_schalter chat_zitate (befristet), Produkt-Schalter AUS'},null,2));
 console.log('PASS P22-T168 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
