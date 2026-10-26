/** P22-T168 Punkte 8/9: Browserabnahme 'User-Entscheidung anpinnen' im KI-Browser (privates synapse_test-Schema, echte API).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/user-entscheidung-browser-p22-t168.test.mjs
 * Fixture wie chat-zitate-browser-p22-t168 (Testseite tests/chat-zitate.html, zwei Agentenfenster). Task P1-T2 hat den Beteiligten
 * rea4 (Identitaet B). Schalter chat_zitate NUR ueber den befristeten internen Test-Schalter (Produkt-Schalter AUS).
 * Prueft: AUS = Lesefenster ohne Knopf; EIN: Lesefenster -> 'User-Entscheidung anpinnen' -> Wortlaut -> Speichern -> thought (source
 * user, task_id P1-T2, Tag user-entscheidung, Wortlaut gleich), sichtbar im Lesefenster und in den Task-Verknuepfungen/Pins (plan);
 * Hinweis nur an den Bearbeiter rea4, nicht an A; keine Chat-Nachricht. Kontextmenue am Chat-Verweis -> Lesefenster mit Editor.
 * Plan-Bezug ueber die Route (Tag P1, task_id leer). Screenshots: ui-screenshots/p22-t168/<lauf-id>/ue-*.png (P25-T7). */
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
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t168u_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t168-entscheidung';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,600):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const A=randomUUID(),Bid=randomUUID();
const task=(nr,status,titel,extra={})=>({id:randomUUID(),kurz_id:'P1-T'+nr,title:titel,description:'Beschreibung P1-T'+nr+': im Lesefenster lesbar.',status,priority:'medium',
 createdAt:'2026-10-2'+nr+'T10:00:00Z',updatedAt:'2026-10-2'+nr+'T10:00:00Z',...extra});
const WORTLAUT='Erst die Zustellung pruefen, dann P1-T3 freigeben.\nBitte genau so.';
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
  await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('chat_zitate','freigegeben',$1,NOW()+interval '2 hours','T168 Browserabnahme User-Entscheidung (befristet)')",[aktiv]);};
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$3,'koordinator','koordinator','koordinator','aktiv','t168'),($2,$3,'rea4','rea4','subagent','aktiv','t168')",[A,Bid,P]);
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Zitat-Anhaenge','',$3::jsonb,true,'P1','hoch')",
  [randomUUID(),P,JSON.stringify([task(1,'done','Erste Aufgabe'),task(2,'in_progress','Zweite Aufgabe',{beteiligte:[{agent_id:'rea4',identity_id:Bid,seit:'2026-10-25T19:00:00Z'}]}),task(3,'todo','Dritte Aufgabe')])]);
 const inbox=(von,an,text,vonId,anId,min)=>pool.query('INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [von,an,text,P,vonId,anId,new Date(Date.UTC(2026,9,25,19,min)).toISOString()]);
 await inbox('koordinator','user','Stand: P1-T2 ist offen. Details stehen in P1-T3.',A,null,1);
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
 let nr=1;const shot=async name=>{const f='ue-'+String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(f,Buffer.from(await r.arrayBuffer())));};
 const url=theme=>ui+'/tests/chat-zitate.html?project='+P+'&a='+A+'&b='+Bid+'&theme='+theme+'&ansicht=zwei';
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(theme)})).tab_id;};
 const link=(f,text)=>json('(()=>{const e=[...document.querySelectorAll(\'[data-fenster="'+f+'"] .verweis-link\')].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');'
  +'if(!e)return "null";const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})})()');
 const geladen=async()=>{await wait(async()=>!!(await link('a','P1-T2')),'Fenster A mit Verweis P1-T2');};
 const lesefenster=re=>evaluate("(()=>{const f=[...document.querySelectorAll('.verweis-fenster')].find(f=>"+re+".test(f.innerText));return f?f.innerText:''})()");
 const imFenster=(re,sel)=>"[...document.querySelectorAll('.verweis-fenster')].find(f=>"+re+".test(f.innerText))?.querySelector("+JSON.stringify(sel)+")";
 const menue=()=>json("JSON.stringify([...document.querySelectorAll('.zitat-menue button')].map(b=>b.textContent.trim()))");
 const schliesseFenster=()=>evaluate("[...document.querySelectorAll('.verweis-fenster .verweis-titel button')].filter(b=>b.getAttribute('aria-label')==='Fenster schließen').forEach(b=>b.click())");
 const thoughts=async task=>(await pool.query("SELECT id::text id,source,content,tags,task_id FROM thoughts WHERE project=$1 AND task_id IS NOT DISTINCT FROM $2 ORDER BY timestamp",[P,task])).rows;

 // ---------------------------------------------------------------- AUS: Lesefenster ohne Knopf
 await testSchalter(false);
 await oeffne('dark');await geladen();
 let l=await link('a','P1-T2');await kb('/click',{tab_id:tab,x:l.x,y:l.y});
 await wait(async()=>/Beschreibung P1-T2/.test(await lesefenster('/Beschreibung P1-T2/')),'AUS: Lesefenster P1-T2');
 await sleep(800);
 ok(!(await evaluate("!!document.querySelector('.verweis-fenster .verweis-entscheidung')"))&&!(await evaluate("!!document.querySelector('.user-entscheidungen')")),'AUS: Lesefenster ohne User-Entscheidung anpinnen (Bestand)');

 // ---------------------------------------------------------------- EIN: Lesefenster -> anpinnen
 await testSchalter(true);
 await oeffne('dark');await geladen();
 const vorA=await anA(),vorB=await anB(),vorChat=await zaehle('SELECT count(*) n FROM specialist_channel_messages');
 l=await link('a','P1-T2');await kb('/click',{tab_id:tab,x:l.x,y:l.y});
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.verweis-entscheidung'))),'EIN: Knopf im Lesefenster P1-T2');
 ok(true,'Lesefenster (aus dem Chat geoeffnet) hat den Knopf User-Entscheidung anpinnen');
 await shot('dunkel-lesefenster-knopf');
 await evaluate(imFenster('/Beschreibung P1-T2/','.verweis-entscheidung')+'.click()');
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.user-entscheidung-editor textarea'))),'Editor im Lesefenster');
 const kopf=await evaluate(imFenster('/Beschreibung P1-T2/','.user-entscheidung-editor header')+'?.innerText??""');
 ok(/Task P1-T2/.test(kopf)&&/Zweite Aufgabe/.test(kopf),'Editor nennt Task und Titel',kopf);
 await kb('/type',{tab_id:tab,selector:'.verweis-fenster .user-entscheidung-editor textarea',text:WORTLAUT});
 await shot('dunkel-editor');
 await evaluate("[...document.querySelectorAll('.user-entscheidung-editor button')].find(b=>b.textContent.trim()==='Speichern').click()");
 await wait(async()=>/User-Entscheidungen \(1\)/i.test(await lesefenster('/Beschreibung P1-T2/')),'Entscheidung im Lesefenster sichtbar');
 const t2=(await thoughts('P1-T2')).filter(t=>t.tags.includes('user-entscheidung'));
 ok(t2.length===1&&t2[0].source==='user'&&t2[0].content===WORTLAUT&&t2[0].tags.includes('P1-T2'),'thought: source user, task_id P1-T2, Tags user-entscheidung + P1-T2, Wortlaut unveraendert',t2);
 const fenstertext=await lesefenster('/Beschreibung P1-T2/');
 ok(fenstertext.includes('Erst die Zustellung pruefen')&&/Angepinnt an Task P1-T2\. Hinweis an rea4\./.test(fenstertext),'Lesefenster: Eintrag und Meldung mit Hinweis-Empfaenger',fenstertext);
 const vk=await C.taskVerknuepfungen(P,'P1-T2');
 ok(vk.thoughts.eintraege.some(x=>x.id===t2[0].id),'sichtbar in den Task-Verknuepfungen/Pins (plan: upper(task_id) wie plan search)',vk.thoughts);
 const T2uuid=(await pool.query("SELECT task->>'id' id FROM plans p CROSS JOIN LATERAL jsonb_array_elements(p.tasks) task WHERE p.project=$1 AND task->>'kurz_id'='P1-T2'",[P])).rows[0].id;
 ok((await C.taskVerknuepfungen(P,T2uuid)).thoughts.eintraege.some(x=>x.id===t2[0].id),'auch ueber die Task-UUID gefunden');
 await wait(async()=>(await anB())===vorB+1,'Hinweis an den Bearbeiter rea4');
 const h=(await pool.query("SELECT content,to_agent,to_identity_id FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
 ok(h.to_agent==='rea4'&&h.content.startsWith('User-Entscheidung an P1-T2 angepinnt (thought '+t2[0].id+'): Erst die Zustellung pruefen'),'Hinweis: kurz, mit Kurz-ID und thought-ID',h);
 ok((await anA())===vorA&&(await zaehle('SELECT count(*) n FROM specialist_channel_messages'))===vorChat,'kein Hinweis an A, keine Channel-/Chat-Nachricht');
 await shot('dunkel-angepinnt');
 // F5: Entscheidung bleibt sichtbar (aus der DB)
 await kb('/navigate',{tab_id:tab,url:url('dark')});await geladen();
 l=await link('a','P1-T2');await kb('/click',{tab_id:tab,x:l.x,y:l.y});
 await wait(async()=>/User-Entscheidungen \(1\)/i.test(await lesefenster('/Beschreibung P1-T2/')),'nach F5 weiter sichtbar');
 ok(true,'nach Neuladen: angepinnte Entscheidung im Lesefenster');
 await schliesseFenster();

 // ---------------------------------------------------------------- Kontextmenue am Chat-Verweis
 l=await link('a','P1-T3');await kb('/click',{tab_id:tab,x:l.x,y:l.y,button:'right'});
 await wait(async()=>(await menue()).length>0,'Menue nach Rechtsklick');
 const m=await menue();
 ok(m.includes('Zitat anfügen')&&m.includes('User-Entscheidung anpinnen')&&m.includes('Öffnen'),'Kontextmenue im Chat: Zitat anfügen, User-Entscheidung anpinnen, Öffnen',m);
 await shot('dunkel-kontextmenue');
 await evaluate("[...document.querySelectorAll('.zitat-menue button')].find(b=>b.textContent.trim()==='User-Entscheidung anpinnen').click()");
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T3/','.user-entscheidung-editor textarea'))),'Lesefenster P1-T3 mit offenem Editor');
 ok(true,'Menuepunkt oeffnet das Lesefenster mit Editor');
 await kb('/type',{tab_id:tab,selector:'.verweis-fenster .user-entscheidung-editor textarea',text:'P1-T3 erst nach P1-T2.'});
 await evaluate("[...document.querySelectorAll('.user-entscheidung-editor button')].find(b=>b.textContent.trim()==='Speichern').click()");
 await wait(async()=>/User-Entscheidungen \(1\)/i.test(await lesefenster('/Beschreibung P1-T3/')),'Entscheidung P1-T3 sichtbar');
 const t3=(await thoughts('P1-T3')).filter(t=>t.tags.includes('user-entscheidung'));
 ok(t3.length===1&&t3[0].content==='P1-T3 erst nach P1-T2.','thought an P1-T3 angelegt',t3);
 await sleep(500);
 ok((await anB())===vorB+1&&(await anA())===vorA,'P1-T3 ohne Bearbeiter: kein Hinweis');
 ok(!/Hinweis an/.test(await lesefenster('/Beschreibung P1-T3/')),'Meldung ohne Hinweis-Empfaenger');
 await shot('dunkel-kontextmenue-angepinnt');
 await schliesseFenster();

 // ---------------------------------------------------------------- hell
 await oeffne('light');await geladen();
 l=await link('a','P1-T2');await kb('/click',{tab_id:tab,x:l.x,y:l.y});
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.verweis-entscheidung'))),'hell: Knopf');
 await evaluate(imFenster('/Beschreibung P1-T2/','.verweis-entscheidung')+'.click()');
 await wait(async()=>!!(await evaluate('!!'+imFenster('/Beschreibung P1-T2/','.user-entscheidung-editor textarea'))),'hell: Editor');
 await shot('hell-lesefenster-editor-liste');
 await evaluate("[...document.querySelectorAll('.user-entscheidung-editor button')].find(b=>b.textContent.trim()==='Abbrechen').click()");
 await sleep(300);
 ok((await thoughts('P1-T2')).filter(t=>t.tags.includes('user-entscheidung')).length===1,'Abbrechen legt nichts an');

 // ---------------------------------------------------------------- Plan-Bezug und Fehler ueber die Route
 const post=body=>app.inject({method:'POST',url:'/api/agent-runtimes/user-entscheidung',payload:body});
 let r=await post({project:P,art:'plan',id:'P1',text:'Plan P1 bleibt hoch.'});
 ok(r.statusCode===200&&r.json().task_id===null&&r.json().tags.join()==='user-entscheidung,P1'&&r.json().hinweis.uebersprungen==='plan','Plan: Tag P1, task_id leer, kein Hinweis',r.json());
 const lp=(await app.inject({method:'GET',url:'/api/agent-runtimes/user-entscheidungen?project='+P+'&art=plan&id=P1'})).json();
 ok(lp.success&&lp.eintraege.length===1&&lp.eintraege[0].content==='Plan P1 bleibt hoch.','Plan-Liste liest genau Tag P1 ohne task_id',lp);
 r=await post({project:P,art:'task',id:'P1-T9',text:'x'});
 ok(r.statusCode===404&&r.json().error.code==='task_unbekannt','unbekannte Task -> 404 task_unbekannt');
 // (angepasst P22-T171, User 83b5014f Punkt 4: jede Verweis-Art des Lesefensters; abgelehnt wird nur eine Nicht-Verweis-Art)
 r=await post({project:P,art:'ausschnitt',id:'x',text:'x'});
 ok(r.statusCode===400&&r.json().error.code==='art_ungueltig','keine Verweis-Art (ausschnitt) -> 400 art_ungueltig');
 r=await post({project:P,art:'task',id:'P1-T2',text:'x'.repeat(2001)});
 ok(r.statusCode===400&&r.json().error.code==='text_zu_lang','Grenze anmerkung_max');
 await testSchalter(false);
 r=await post({project:P,art:'task',id:'P1-T2',text:'aus'});
 ok(r.statusCode===409&&r.json().error.code==='funktion_aus'&&r.json().schalter.quelle==='intern','Schalter AUS -> 409 funktion_aus mit Schalterquelle',r.json());

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege-user-entscheidung.json'),JSON.stringify({checks,schema,schalter:'intern_schalter chat_zitate (befristet), Produkt-Schalter AUS'},null,2));
 console.log('PASS P22-T168 User-Entscheidung Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
