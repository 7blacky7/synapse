/** P22-T174: KI-Browser-Abnahme "mehrere Zitate sammeln sich" (privates synapse_test-Schema, echte API, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/zitate-sammeln-browser-p22-t174.test.mjs
 * WARUM (User inbox 1275, 26.10.2026 01:14): "wenn ich zitate hinzufüge wird das vorige verworfen". Ursache: ein weiteres Zitat
 * (Rechtsklick-Menue, Knopf im Lesefenster, Markierung, Kaertchen) ersetzte den offenen Anmerkungs-Editor und verwarf ein noch nicht
 * gespeichertes Zitat. Fix: web-ui ZitatAnhaenge.tsx uebernimmt den offenen Editor (zitat-logik.ts uebernimmZitatEditor).
 * Fixture wie P22-T168 (tests/chat-zitate.html: zwei echte EinheitlicherAgentChat-Fenster A/B), Plan P1 (P1-T1..T3), Schalter chat_zitate
 * NUR ueber den befristeten internen Test-Schalter (Produkt-Schalter AUS).
 * Prueft dunkel: drei Zitate nacheinander (1 Editor offen -> 2 per Rechtsklick, offen -> 3 per Knopf im Lesefenster) -> drei Kaertchen,
 * Senden -> genau EINE Inbox-Zeile an A mit Block 3 in Reihenfolge, B unberuehrt; einzeln entfernen (x), Abbrechen verwirft nur das
 * offene; Senden mit offenem Editor nimmt sein Zitat mit (leere Anmerkung = ohne). Hell: zwei Zitate nacheinander (erstes offen) ->
 * zwei Kaertchen -> Senden mit Block 2. Alle Verweise werden ECHT per Koordinate geklickt; bei offenem Editor wird vorher per
 * elementFromPoint belegt, dass der Editor (im Eingabebereich) den Verweis nicht verdeckt.
 * Screenshots: ui-screenshots/p22-t174/<lauf-id>/ (P25-T7). Debug bei Fehlschlag: Label mit Herkunft + tatsaechlicher Wert. */
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
// Befristeter interner Test-Schalter: intern-Tool beim Start EIN (nur dieser Testprozess); der Produkt-Schalter bleibt AUS.
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t174_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t174-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0,letzterShot='';
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label+(letzterShot?' | letzter Screenshot: '+letzterShot:''));};
// Herkunft im Label (P22-T174 + Einheit); Fehlschlag: DEBUG-Zeile mit tatsaechlichem Wert und letztem Screenshot.
const ok=(value,label,info)=>{if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+JSON.stringify(info).slice(0,600):'')+(letzterShot?' | Screenshot: '+letzterShot:''));assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const task=(nr,status,titel)=>({id:randomUUID(),kurz_id:'P1-T'+nr,title:titel,description:'Beschreibung P1-T'+nr+': im Lesefenster lesbar.',status,priority:'medium',
 createdAt:'2026-10-2'+nr+'T10:00:00Z',updatedAt:'2026-10-2'+nr+'T10:00:00Z'});
const A=randomUUID(),Bid=randomUUID();
const NACHRICHT_A='Stand: P1-T2 ist offen. Details stehen in P1-T3, Grundlage ist P1-T1.';
const kopfZeilen=t=>[...t.matchAll(/^(\d+)\) (.+)$/gm)].map(m=>m[2]);
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
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',true,'T174 Browser-Fixture','user')",[P]);
 await pool.query("DELETE FROM intern_schalter WHERE name='chat_zitate'");
 await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',true,NOW()+interval '2 hours','T174 Browserabnahme (befristet)')");
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$3,'koordinator','koordinator','koordinator','aktiv','t174'),($2,$3,'rea4','rea4','subagent','aktiv','t174')",[A,Bid,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Zitate sammeln','',$3::jsonb,true,'P1','hoch')",
  [randomUUID(),P,JSON.stringify([task(1,'done','Erste Aufgabe'),task(2,'in_progress','Zweite Aufgabe'),task(3,'todo','Dritte Aufgabe')])]);
 const inbox=(von,an,text,vonId,anId,min)=>pool.query('INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [von,an,text,P,vonId,anId,new Date(Date.UTC(2026,9,26,0,min)).toISOString()]);
 await inbox('koordinator','user',NACHRICHT_A,A,null,1);
 await inbox('rea4','user','Hallo von rea4 zu P1-T1.',Bid,null,2);
 const zaehle=async(sql,p=[])=>Number((await pool.query(sql,p)).rows[0].n);
 const anA=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user' AND (to_identity_id=$1 OR to_agent='koordinator')",[A]);
 const anB=()=>zaehle("SELECT count(*) n FROM specialist_inbox WHERE from_agent='user' AND (to_identity_id=$1 OR to_agent='rea4')",[Bid]);
 const letzteAnA=async()=>(await pool.query("SELECT content,to_agent FROM specialist_inbox WHERE from_agent='user' AND to_agent='koordinator' ORDER BY id DESC LIMIT 1")).rows[0];
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.ready();
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t174/<lauf-id>/, nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t174'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=theme=>ui+'/tests/chat-zitate.html?project='+P+'&a='+A+'&b='+Bid+'&theme='+theme+'&ansicht=zwei';
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await kb('/tabs/new',{url:url(theme)})).tab_id;};
 const link=(f,text)=>json('(()=>{const e=[...document.querySelectorAll(\'[data-fenster="'+f+'"] .message-feed .verweis-link\')].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');'
  +'if(!e)return "null";e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()');
 const rechts=async p=>kb('/click',{tab_id:tab,x:p.x,y:p.y,button:'right'});
 const menue=()=>json("JSON.stringify([...document.querySelectorAll('.zitat-menue button')].map(b=>b.textContent.trim()))");
 const menuePunkt=t=>evaluate("(()=>{const b=[...document.querySelectorAll('.zitat-menue button')].find(x=>x.textContent.trim().startsWith("+JSON.stringify(t)+"));if(!b)return false;b.click();return true})()");
 const editorText=()=>evaluate("document.querySelector('.zitat-editor')?.innerText??''");
 const editorKnopf=t=>evaluate("(()=>{const b=[...document.querySelectorAll('.zitat-editor button')].find(x=>x.textContent.trim()==="+JSON.stringify(t)+");if(!b)return false;b.click();return true})()");
 const tippe=async(selector,text)=>kb('/type',{tab_id:tab,selector,text});
 const karten=f=>json("JSON.stringify([...document.querySelectorAll('[data-fenster=\\\""+f+"\\\"] .zitat-entwuerfe .zitat-karte')].map(k=>k.innerText.replace(/\\s+/g,' ').trim()))");
 const kartenKopf=async f=>(await karten(f)).map(k=>(/^(Task P1-T\d)/.exec(k)||[k])[0]);
 const entwurf=id=>json("JSON.stringify(JSON.parse(localStorage.getItem('synapse:zitat-entwurf:agent:"+id+"')||'[]'))");
 const editorStand=()=>evaluate("document.querySelector('[data-fenster=\\\"a\\\"] section').getAttribute('data-zitat-editor')");
 const geladen=async()=>{await wait(async()=>!!(await link('a','P1-T1')),'Fenster A mit Verweis P1-T1');await wait(async()=>!!(await link('b','P1-T1')),'Fenster B mit Verweis P1-T1');
  await wait(async()=>(await evaluate("document.querySelector('[data-fenster=\\\"a\\\"] section').getAttribute('data-zitat-schalter')"))==='ein','Schalter chat_zitate EIN im Fenster A');};
 // Verweise werden ECHT per Koordinate geklickt (CDP), auch bei offenem Editor (Koordinator 26.10.2026: das Anmerkungsfeld darf die
 // Nachrichtenzeile und ihre Verweise nicht verdecken). punkt holt den Verweis in den sichtbaren Bereich und misst, bis die Lage steht
 // (der Feed folgt beim Poll von 1 s nach unten; Lauf ez-20261026-013131-f423 lief daran in einen Timeout).
 const punkt=async(f,id)=>{let a=await link(f,id);for(let i=0;i<8;i++){await sleep(250);const b=await link(f,id);if(a&&b&&a.x===b.x&&a.y===b.y)return b;a=b;}return a;};
 // An der Klickstelle liegt wirklich der Verweis dieser Nachricht (nichts darueber, z. B. der Editor) - elementFromPoint.
 const frei=(f,id,p)=>evaluate("(()=>{const e=document.elementFromPoint("+p.x+","+p.y+");const l=e&&e.closest('.verweis-link');return !!l&&!!l.closest('[data-fenster=\""+f+"\"] .message-feed')&&l.textContent.trim()==="+JSON.stringify(id)+"})()");
 const pruefeFrei=async(f,id,p)=>{if((await editorStand())!=='zu')ok(await frei(f,id,p),'P22-T174 ZitatAnhaenge.tsx Editor im Eingabebereich: Verweis '+id+' bei offenem Editor nicht verdeckt (elementFromPoint)',p);};
 const rechtsKlick=async(f,id)=>{const p=await punkt(f,id);await pruefeFrei(f,id,p);await rechts(p);};
 const linksKlick=async(f,id)=>{const p=await punkt(f,id);await pruefeFrei(f,id,p);await kb('/click',{tab_id:tab,x:p.x,y:p.y});};
 const editorOrt=()=>json("JSON.stringify((()=>{const e=document.querySelector('.zitat-editor');return e?{ort:e.getAttribute('data-zitat-editor-ort'),imEingabebereich:!!e.closest('[data-fenster=\"a\"] .agent-composer')}:null})())");
 const zitatPerMenue=async(f,id)=>{await rechtsKlick(f,id);await wait(async()=>(await menue()).length>0,'Menue nach Rechtsklick auf '+id);
  ok(await menuePunkt('Zitat anfügen'),'P22-T174 ZitatAnhaenge.tsx Menue: Zitat anfügen fuer '+id);await wait(async()=>new RegExp('Task '+id).test(await editorText()),'Editor fuer '+id);};
 const senden=async(f,text)=>{if(text)await tippe('[data-fenster="'+f+'"] .chat-eingabefeld textarea',text);await evaluate("document.querySelector('[data-fenster=\\\""+f+"\\\"] .composer-send').click()");};

 // ---------------------------------------------------------------- dunkel: drei Zitate nacheinander, jeweils ohne vorher zu speichern
 await oeffne('dark');await geladen();
 const vorA=await anA(),vorB=await anB();
 // 1 erstes Zitat: Editor offen lassen (genau der Fall des Users); echter Rechtsklick im KI-Browser
 await zitatPerMenue('a','P1-T2');
 await tippe('.zitat-editor textarea','Erstes Zitat, noch nicht gespeichert.');
 const ort=await editorOrt();
 ok(ort?.ort==='eingabe'&&ort.imEingabebereich,'P22-T174 ZitatAnhaenge.tsx Editor steht im Eingabebereich von A (data-zitat-editor-ort=eingabe), nicht ueber der Nachricht',ort);
 ok((await editorStand())==='neu'&&(await karten('a')).length===0,'P22-T174 ZitatAnhaenge.tsx debug data-zitat-editor=neu: Editor offen, noch kein Kaertchen',{editor:await editorStand(),karten:await karten('a')});
 await shot('dunkel-zitat1-editor-offen');
 // 2 zweites Zitat per Rechtsklick: vorher verwarf das das erste
 await rechtsKlick('a','P1-T3');await wait(async()=>(await menue()).length>0,'Menue nach Rechtsklick auf P1-T3');
 let k=await karten('a');
 ok(k.length===1&&/Task P1-T2/.test(k[0])&&/Erstes Zitat/.test(k[0]),'P22-T174 ZitatAnhaenge.tsx anbieter.menue: zweites Zitat verwirft das erste nicht (als Kaertchen uebernommen)',k);
 await shot('dunkel-zitat2-menue-erstes-uebernommen');
 ok(await menuePunkt('Zitat anfügen'),'P22-T174 Menue Zitat anfügen fuer P1-T3');
 await wait(async()=>/Task P1-T3/.test(await editorText()),'Editor fuer P1-T3');
 // 3 drittes Zitat ueber den Knopf im Lesefenster (Linksklick auf P1-T1), Editor fuer P1-T3 noch offen
 // Echter Linksklick per Koordinate auf P1-T1 bei offenem Editor (P1-T3) - der Editor steht im Eingabebereich und verdeckt ihn nicht.
 await linksKlick('a','P1-T1');
 await wait(async()=>!!(await evaluate("[...document.querySelectorAll('.verweis-fenster')].some(f=>/Beschreibung P1-T1/.test(f.innerText)&&f.querySelector('.verweis-zitat'))")),'Lesefenster P1-T1 mit Knopf');
 await evaluate("[...document.querySelectorAll('.verweis-fenster')].find(f=>/Beschreibung P1-T1/.test(f.innerText)).querySelector('.verweis-zitat').click()");
 await wait(async()=>/Task P1-T1/.test(await editorText()),'Editor fuer P1-T1 aus dem Lesefenster');
 ok((await kartenKopf('a')).join(',')==='Task P1-T2,Task P1-T3','P22-T174 ZitatAnhaenge.tsx anbieter.anfuegen (Knopf im Lesefenster): offenes Zitat P1-T3 uebernommen',await karten('a'));
 await tippe('.zitat-editor textarea','Drittes Zitat aus dem Lesefenster.');
 ok(await editorKnopf('Speichern'),'P22-T174 Editor Speichern fuer P1-T1');
 await wait(async()=>(await karten('a')).length===3,'drei Kaertchen in A');
 await evaluate("[...document.querySelectorAll('.verweis-fenster .verweis-titel button')].filter(b=>b.getAttribute('aria-label')==='Fenster schließen').forEach(b=>b.click())");
 ok((await kartenKopf('a')).join(',')==='Task P1-T2,Task P1-T3,Task P1-T1','P22-T174 ZitatAnhaenge.tsx karten: drei Zitate in Reihenfolge am Eingabefeld',await karten('a'));
 ok((await karten('b')).length===0&&(await entwurf(A)).length===3&&(await entwurf(Bid)).length===0,'P22-T174 Entwurf je Chat (localStorage): A 3, B 0',{a:(await entwurf(A)).length,b:(await entwurf(Bid)).length});
 const sichtbar=await json(`JSON.stringify((()=>{const c=document.querySelector('[data-fenster="a"] .zitat-entwuerfe');const r=c.getBoundingClientRect();
  return [...c.querySelectorAll('.zitat-karte')].map(k=>{const b=k.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1&&b.top>=r.top-1&&b.bottom<=r.bottom+1;});})())`);
 ok(sichtbar.length===3&&sichtbar.every(Boolean),'P22-T174 chat-zitate.css .zitat-entwuerfe: alle drei Kaertchen ganz sichtbar (Umbruch statt rechts abgeschnitten)',sichtbar);
 await shot('dunkel-drei-kaertchen');
 // 4 Senden -> genau EINE Inbox-Zeile an A mit Block 3 in Reihenfolge
 await senden('a','Drei Zitate bitte ansehen');
 await wait(async()=>(await anA())===vorA+1,'genau eine neue Inbox-Zeile an A');
 let zeile=await letzteAnA();
 ok(zeile.content.startsWith('Drei Zitate bitte ansehen\n\n[Synapse-Zitate: 3]\n'),'P22-T174 routes/agent-runtimes.ts agent-chat: Nachricht + Block mit 3 Zitaten an A',zeile.content.slice(0,200));
 ok(kopfZeilen(zeile.content).join(',')==='Task P1-T2,Task P1-T3,Task P1-T1'&&/Erstes Zitat, noch nicht gespeichert/.test(zeile.content)&&/Drittes Zitat aus dem Lesefenster/.test(zeile.content),
  'P22-T174 Block: alle drei in Reihenfolge, Anmerkung des nie gespeicherten ersten Zitats enthalten',kopfZeilen(zeile.content));
 ok((await anB())===vorB&&(await zaehle('SELECT count(*) n FROM specialist_channel_messages'))===0,'P22-T174 kein Rundversand: B und Channels unberuehrt');
 await wait(async()=>(await karten('a')).length===0,'Entwurf nach dem Senden geleert');
 await wait(async()=>(await evaluate("Math.max(0,...[...document.querySelectorAll('[data-fenster=\\\"a\\\"] .zitat-karten-nachricht')].map(e=>e.querySelectorAll('.zitat-karte-nachricht').length))"))===3,'gesendete Nachricht zeigt drei Zitat-Kaertchen');
 await sleep(800);await shot('dunkel-drei-gesendet');
 // 5 einzeln entfernbar + Abbrechen verwirft nur das offene
 await zitatPerMenue('a','P1-T2');await editorKnopf('Speichern');await wait(async()=>(await karten('a')).length===1,'Kaertchen P1-T2');
 await zitatPerMenue('a','P1-T3');await editorKnopf('Speichern');await wait(async()=>(await karten('a')).length===2,'Kaertchen P1-T3');
 await zitatPerMenue('a','P1-T1');await editorKnopf('Abbrechen');await sleep(300);
 ok((await kartenKopf('a')).join(',')==='Task P1-T2,Task P1-T3'&&(await editorStand())==='zu','P22-T174 ZitatAnhaenge.tsx Abbrechen: verwirft nur das offene, beide Kaertchen bleiben',await karten('a'));
 await evaluate("document.querySelectorAll('[data-fenster=\\\"a\\\"] .zitat-karte-weg')[0].click()");
 await wait(async()=>(await karten('a')).length===1,'x entfernt ein Kaertchen');
 ok((await kartenKopf('a')).join(',')==='Task P1-T3'&&(await entwurf(A)).length===1,'P22-T174 ZitatAnhaenge.tsx x: entfernt genau dieses Zitat (P1-T2), P1-T3 bleibt',await karten('a'));
 await shot('dunkel-einzeln-entfernt');
 await evaluate("document.querySelectorAll('[data-fenster=\\\"a\\\"] .zitat-karte-weg')[0].click()");
 await wait(async()=>(await karten('a')).length===0,'Entwurf leer');
 // 6 Senden mit offenem Editor (Koordinator 26.10.2026: 'Der User erwartet, dass alles mitgeht, was er sieht'): ein gespeichertes
 //   Kaertchen + ein offener Editor mit Anmerkung -> beide gehen mit; danach offener Editor mit LEERER Anmerkung und sonst nichts ->
 //   Senden ist frei, das Zitat geht ohne Anmerkung mit.
 const vorA6=await anA();
 await zitatPerMenue('a','P1-T2');await editorKnopf('Speichern');await wait(async()=>(await karten('a')).length===1,'Kaertchen P1-T2 vor dem Senden');
 await zitatPerMenue('a','P1-T3');
 await tippe('.zitat-editor textarea','Beim Senden noch offen.');
 ok((await editorStand())==='neu'&&(await karten('a')).length===1&&Number(await evaluate("document.querySelector('[data-fenster=\"a\"] section').getAttribute('data-zitate-versand')"))===2,
  'P22-T174 ZitatAnhaenge.tsx sendeZitate (data-zitate-versand=2): offener Editor zaehlt beim Senden mit',{editor:await editorStand(),karten:await karten('a')});
 await shot('dunkel-senden-editor-offen');
 await senden('a','Senden mit offenem Editor');
 await wait(async()=>(await anA())===vorA6+1,'eine Inbox-Zeile beim Senden mit offenem Editor');
 zeile=await letzteAnA();
 ok(zeile.content.startsWith('Senden mit offenem Editor\n\n[Synapse-Zitate: 2]\n')&&kopfZeilen(zeile.content).join(',')==='Task P1-T2,Task P1-T3'&&/Beim Senden noch offen/.test(zeile.content),
  'P22-T174 Senden mit offenem Editor: Zitat des offenen Editors geht mit (Block 2, Anmerkung enthalten)',zeile.content.slice(0,300));
 await wait(async()=>(await karten('a')).length===0&&(await editorStand())==='zu','nach dem Senden: Entwurf leer, Editor zu');
 ok(!(await evaluate("!!document.querySelector('.zitat-editor')"))&&(await entwurf(A)).length===0,'P22-T174 ZitatAnhaenge.tsx leeren: Editor nach dem Senden geschlossen, Speicher leer');
 await zitatPerMenue('a','P1-T1');
 ok(!(await evaluate("document.querySelector('[data-fenster=\"a\"] .composer-send').disabled")),'P22-T174 Senden frei: nur ein offener Editor mit leerer Anmerkung, kein Text, kein Kaertchen');
 await senden('a','');
 await wait(async()=>(await anA())===vorA6+2,'Inbox-Zeile nur mit dem offenen Zitat');
 zeile=await letzteAnA();
 ok(zeile.content.startsWith('[Synapse-Zitate: 1]\n1) Task P1-T1')&&!/Beim Senden/.test(zeile.content),'P22-T174 Senden mit offenem Editor, leere Anmerkung: Zitat geht ohne Anmerkung mit',zeile.content.slice(0,300));
 await wait(async()=>(await editorStand())==='zu','Editor nach dem Senden zu');
 await sleep(800);await shot('dunkel-senden-editor-gesendet');

 // ---------------------------------------------------------------- hell: zwei Zitate nacheinander, erstes offen
 await oeffne('light');await geladen();
 const vorA2=await anA();
 await zitatPerMenue('a','P1-T3');
 await tippe('.zitat-editor textarea','Hell: erstes offen.');
 await shot('hell-zitat1-editor-offen');
 await zitatPerMenue('a','P1-T1');
 ok((await kartenKopf('a')).join(',')==='Task P1-T3','P22-T174 hell: zweites Zitat uebernimmt das offene erste',await karten('a'));
 await shot('hell-zitat2-editor');
 await editorKnopf('Speichern');await wait(async()=>(await karten('a')).length===2,'hell: zwei Kaertchen');
 ok((await kartenKopf('a')).join(',')==='Task P1-T3,Task P1-T1','P22-T174 hell: zwei Kaertchen in Reihenfolge',await karten('a'));
 await shot('hell-zwei-kaertchen');
 await senden('a','');
 await wait(async()=>(await anA())===vorA2+1,'hell: eine Inbox-Zeile an A');
 zeile=await letzteAnA();
 ok(zeile.content.startsWith('[Synapse-Zitate: 2]\n')&&kopfZeilen(zeile.content).join(',')==='Task P1-T3,Task P1-T1'&&/Hell: erstes offen/.test(zeile.content),
  'P22-T174 hell: nur Zitate (F3) -> Block mit beiden an A',zeile.content.slice(0,200));
 await wait(async()=>(await karten('a')).length===0,'hell: Entwurf geleert');
 await sleep(800);await shot('hell-zwei-gesendet');
 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,schalter:'intern_schalter chat_zitate (befristet), Produkt-Schalter AUS'},null,2));
 console.log('PASS P22-T174 Browser '+checks+' checks; KI-Browser; private schema '+schema+'; Screenshots '+folder);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
