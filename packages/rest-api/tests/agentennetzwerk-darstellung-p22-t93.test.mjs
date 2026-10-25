/**
 * P22-T93 Darstellung "Nervensystem": Browser-Abnahme mit echten Synapse-Ereignissen.
 * Nur synapse_test:5433, privates Schema je Lauf (am Ende entfernt). Chat/Channel ueber echte MCP-Aufrufe,
 * weitere Werkzeuge als echte tool_calls-Zeilen im Testschema (der PG-NOTIFY-Trigger liefert sie live).
 * P22-T163: laeuft im KI-Browser (192.168.50.65:9222, gleicher Weg wie T149/T152/T156), kein Playwright.
 * Die Fixture-Seite liegt in einem gleich-originigen Rahmen (iframe 1500x1000 bzw. 390x844 = Viewport, Neuladen = Rahmen neu laden);
 * Hover/Klick als Zeigerereignisse im Rahmen, Elementbilder als Ausschnitt des Tab-Screenshots. Ein vorab eingespieltes Skript
 * (Vite transformIndexHtml) setzt das Sitzungstoken und sammelt JavaScript-Fehler (Ersatz fuer addInitScript/pageerror).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test [P22_SHOTS=<eigener Ordner, sonst ui-screenshots/p22-t93/<lauf-id>/ (P25-T7)>] [P22_GPU=0]
 *   node packages/rest-api/tests/agentennetzwerk-darstellung-p22-t93.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t93d_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0,laeuft=false;const laeufe=[];
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
// Achtung: der KI-Browser liefert undefined als Zeichenkette 'undefined' -> Skripte geben fehlende Werte als null zurueck.
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
// Skript im Fenster der Fixture-Seite (Rahmen) ausfuehren; Promises werden abgewartet.
const imRahmen=script=>evaluate('Promise.resolve(document.getElementById("rahmen").contentWindow.eval('+JSON.stringify(script)+'))');
// Warten wie waitForFunction: Fehler waehrend des Neuladens zaehlen als "noch nicht".
const wait=async(fn,label,ms=15000)=>{const end=Date.now()+ms;let letzter;while(Date.now()<end){try{if(await fn())return;}catch(e){letzter=e;}await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label+(letzter?' ('+letzter.message+')':''));};
const ok=(value,label)=>{assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const messung={},errors=[];
// Vorab im Rahmen: Sitzungstoken (wie addInitScript) und Fehlersammler (wie pageerror/console error).
const VORAB="localStorage.setItem('synapse_session_token','p22-user');window.__t93Fehler=[];"+
 "addEventListener('error',e=>__t93Fehler.push(String(e.message||e)));"+
 "addEventListener('unhandledrejection',e=>__t93Fehler.push('unhandledrejection: '+String(e.reason&&e.reason.message||e.reason)));"+
 "{const ce=console.error.bind(console);console.error=(...a)=>{__t93Fehler.push(a.map(String).join(' '));ce(...a);};}";
const RAHMEN='<!doctype html><html lang="de"><meta charset="utf-8"/><title>P22-T93 Rahmen</title><body style="margin:0;background:#101214">'+
 '<iframe id="rahmen" src="/tests/agentennetzwerk.html" style="border:0;display:block;width:1500px;height:1000px"></iframe></body></html>';
const kiBrowserPlugin={name:'p22-t163-ki-browser',
 transformIndexHtml:()=>[{tag:'script',children:VORAB,injectTo:'head-prepend'}],
 configureServer(s){s.middlewares.use((req,res,next)=>{if(!req.url.startsWith('/t93-rahmen.html'))return next();res.setHeader('content-type','text/html; charset=utf-8');res.end(RAHMEN);});}};
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
 const {AGENTENNETZWERK_SCHEMA_SQL}=await load('packages/core/dist/db/agentennetzwerk-schema.js');
 await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
 await app.register(specialistRoutes);await app.register(mcpRoutes);
 await registerAgentProfilRoutes(app,{validateToken:async t=>t==='p22-user'?{kind:'session',scope:null}:null});
 await app.ready();
 const ident=(id,name,rolle,modell,project=P)=>pool.query(
  "INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv,modell_selbstauskunft) VALUES($1,$2,$3,$3,$4,'aktiv','test',NOW(),$5)",[id,project,name,rolle,modell]);
 await ident('d93-main',C.HAUPTAGENT_AGENT_ID,'main','claude-test',C.HAUPTAGENT_PROJEKT);
 await ident('d93-nord','koordinator-nord','koordinator','claude-test');
 await ident('d93-sued','koordinator-sued','koordinator','gpt-test');
 // Testteam (synapse_test): Modellfamilien gemischt, Zuordnung nur ueber echte Startauftraege.
 const team=[['claude-ui','claude-test','d93-nord'],['codex-api','gpt-test','d93-nord'],['claude-docs','claude-test','d93-nord'],['codex-db','gpt-test','d93-nord'],['claude-tests','claude-test','d93-nord'],
  ['codex-hex','gpt-test','d93-sued'],['codex-netz','gpt-test','d93-sued'],['claude-review','claude-test','d93-sued'],['sol-parser','claude-test',null],['gpt-pruefer','gpt-test',null]];
 for(const [name,modell,koord] of team){
  await ident('d93-'+name,name,'subagent',modell);
  if(koord)await pool.query("INSERT INTO specialist_jobs(id,project,action,args,status,actor_identity_id,target_identity_id,completed_at) VALUES($1,$2,'spawn',$3::jsonb,'done',$4,$5,NOW())",[randomUUID(),P,JSON.stringify({name,identity_id:'d93-'+name}),koord,'d93-'+name]);
 }
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:true,grund:'Test P22 T93 Darstellung'},{system:'user'});
 const einstellen=async werte=>{const r=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},payload:{netzwerk_werte:werte,grund:'Test T93 Darstellung'}});assert.equal(r.statusCode,200,r.body);};
 await einstellen({abgleich_sekunden:3,animation_ms:2600,buendel_ms:120});
 const call=async(tool,args,agent)=>{
  const res=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{project:P,agent_id:agent,...args}}}});
  assert.equal(res.statusCode,200);const rr=res.json();assert(!rr.error,JSON.stringify(rr.error));return rr.result;
 };
 // Channels anlegen (echte MCP-Aufrufe).
 for(const [name,von] of [['kern-sync','claude-ui'],['review','codex-hex']]){
  await call('channel',{action:'create',name,description:'Testdaten P22 T93',created_by:von},von);
  await call('channel',{action:'post',channel_name:name,sender:von,content:'Testimpuls'},von);
 }
 // P22-T95: zwei offene files-Plaene im Testschema (A mit Co-Edit dreier Agenten, B allein); nur Metadaten.
 const planNeu=async(owner,beitraege,dateien)=>(await pool.query(`INSERT INTO file_batch_plans(project,owner_agent_id,owner_identity_id,ops,expected_hashes,previews,status,open_for_coedit,expires_at)
  VALUES($1,$2,$3,$4::jsonb,'{}'::jsonb,'[]'::jsonb,'open',true,NOW()+INTERVAL '1 hour') RETURNING id::text`,
  [P,owner,'d93-'+owner,JSON.stringify(dateien.map((file_path,i)=>({file_path,action:'update',agent_id:beitraege[i%beitraege.length],author_identity_id:'d93-'+beitraege[i%beitraege.length]})))])).rows[0].id;
 const planA=await planNeu('claude-ui',['claude-ui','codex-api','claude-docs'],['packages/web-ui/src/a.tsx','packages/web-ui/src/b.css','docs/c.md']);
 const planB=await planNeu('codex-hex',['codex-hex'],['packages/core/src/hex.ts']);
 const planC=await planNeu('codex-netz',['codex-netz','claude-review'],['packages/rest-api/src/x.ts','packages/rest-api/src/y.ts']);
 const planD=await planNeu('sol-parser',['sol-parser'],['packages/core/src/z.ts']);
 const WERKZEUGE=['shell','plan','files','code_intel','memory','thought','docs','specialist','skills','asset_intel','event','admin'];
 const alleAgenten=['koordinator-nord','koordinator-sued',...team.map(t=>t[0])];
 let takt=0;
 // Weitere Werkzeugaufrufe als echte tool_calls-Zeilen im Testschema (Trigger meldet sie per NOTIFY).
 const audit=async(n,namen=alleAgenten)=>{
  const werte=[],params=[P];
  for(let i=0;i<n;i++){const a=namen[(takt*7+i*3)%namen.length],t=WERKZEUGE[(takt+i)%WERKZEUGE.length],fehl=(takt+i)%23===0;
   params.push(a,t,fehl);werte.push(`($1,$${params.length-2},$${params.length-1},'get',NOT $${params.length},'{}')`);}
  takt++;
  await pool.query('INSERT INTO tool_calls(project,agent_id,tool_name,action,ok,args_preview) VALUES '+werte.join(','),params);
 };
 const leben=(ms,dichte,namen)=>{const p=lebenLauf(ms,dichte,namen);laeufe.push(p.catch(()=>{}));return p;};
 const lebenLauf=async(ms,dichte=2,namen)=>{
  laeuft=true;const ende=Date.now()+ms;let i=0;
  while(Date.now()<ende&&laeuft){
   await audit(dichte,namen);
   if(!namen&&i%5===1)await call('chat',{action:'send',recipient_id:team[i%5][0],sender_id:'koordinator-nord',content:'Test-DM P22 T93'},'koordinator-nord');
   if(!namen&&i%5===3)await call('chat',{action:'send',recipient_id:'koordinator-sued',sender_id:team[5+i%3][0],content:'Test-DM P22 T93'},team[5+i%3][0]);
   if(!namen&&i%4===2)await call('channel',{action:'post',channel_name:i%8===2?'kern-sync':'review',sender:team[i%10][0],content:'Test P22 T93'},team[i%10][0]);
   if(!namen&&i%6===4)await call('channel',{action:'feed',channel_name:'kern-sync'},team[(i+3)%10][0]);
   if(!namen&&i%6===1)await pool.query("INSERT INTO tool_calls(project,agent_id,tool_name,action,ok,args_preview,result) VALUES($1,$2,'code_intel','search',true,'{}',$3)",[P,team[i%10][0],'{"success":true,"results":[],"count":0}']);
   if(!namen&&i%2===0)await pool.query("INSERT INTO tool_calls(project,agent_id,tool_name,action,ok,args_preview,result_bytes) VALUES($1,$2,'files','plan_status',true,$3,$4)",
    [P,i%4===0?'codex-hex':['claude-ui','codex-api','claude-docs'][i%3],JSON.stringify({action:'plan_status',plan_id:i%4===0?planB:planA}),200*(i%10+1)**2]);
   i++;await sleep(140);
  }
 };
 await app.listen({host:'127.0.0.1',port:0});
 const api='http://127.0.0.1:'+app.server.address().port;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},plugins:[kiBrowserPlugin],server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const gpu=process.env.P22_GPU!=='0';
 // P25-T7 scripts/lib/ui-screenshots.mjs: Standard ui-screenshots/p22-t93/<lauf-id>/ (nie ueberschreiben); P22_SHOTS bleibt als ausdruecklich eigener Ordner.
 const ablage=process.env.P22_SHOTS?null:await screenshotAblage(repo,'p22-t93');
 const folder=ablage?ablage.ordner:join(repo,process.env.P22_SHOTS);await mkdir(folder,{recursive:true});
 // Viewport = Groesse des Rahmens; Elementbild = Ausschnitt des Tab-Screenshots (Rahmen liegt bei 0,0).
 const viewport=async(w,h)=>{await evaluate("(()=>{const f=document.getElementById('rahmen');f.style.width='"+w+"px';f.style.height='"+h+"px';return true})()");await sleep(300);};
 const shot=async(name,sel='.agent-network')=>{
  // Nach dem Scrollen zwei Frames abwarten: sonst zeigt das Bild noch die alte Scrollposition (KI-Browser zeichnet mit ~30 Bildern/s).
  const r=await imRahmen("(async()=>{const e=document.querySelector("+JSON.stringify(sel)+");e.scrollIntoView({block:'nearest',inline:'nearest'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=e.getBoundingClientRect(),f=parent.document.getElementById('rahmen').getBoundingClientRect();"+
   "const x0=Math.max(b.left,0),y0=Math.max(b.top,0),x1=Math.min(b.right,innerWidth),y1=Math.min(b.bottom,innerHeight);return {x:f.left+x0,y:f.top+y0,w:x1-x0,h:y1-y0}})()");
  const q=new URLSearchParams({tab_id:tab,clip_x:String(Math.round(r.x)),clip_y:String(Math.round(r.y)),clip_width:String(Math.round(r.w)),clip_height:String(Math.round(r.h))});
  const res=await fetch(B+'/screenshot?'+q);assert(res.ok);const bild=Buffer.from(await res.arrayBuffer());
  console.log('BILD '+(ablage?await ablage.speichere(name,bild):(await writeFile(join(folder,name),bild),relative(repo,join(folder,name)))));
 };
 const da=name=>imRahmen("document.querySelector('canvas.nw-gl')?.getAttribute("+JSON.stringify(name)+")??null");
 const fps=async(sekunden)=>{const werte=[];for(let i=0;i<sekunden;i++){await sleep(1000);werte.push(Number(await da('data-fps')));}return werte;};
 const anzahl=sel=>imRahmen('document.querySelectorAll('+JSON.stringify(sel)+').length');
 const sichtbar=sel=>imRahmen('(()=>{const e=document.querySelector('+JSON.stringify(sel)+');return !!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=="hidden"})()');
 const knopf=async name=>ok0(await imRahmen('(()=>{const n='+JSON.stringify(name)+',b=[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")===n||b.textContent.trim()===n);if(!b)return false;b.click();return true})()'),'Knopf '+name);
 const ok0=(value,label)=>assert(value,label+' nicht gefunden');
 const dialog=name=>wait(async()=>(await anzahl('[role="dialog"][aria-label='+JSON.stringify(name)+']'))>0,'Dialog '+name,5000);
 // Maus: Zeigerereignisse auf der Textebene (Hover = pointermove, weg = pointerout, Klick = click).
 const zeiger=(art,p)=>imRahmen("(()=>{const c=document.querySelector('canvas.nw-text'),o={bubbles:true,cancelable:true,composed:true,pointerId:1,pointerType:'mouse',isPrimary:true,clientX:"+(p?.x??0)+",clientY:"+(p?.y??0)+"};"+
  "if('"+art+"'==='click')c.dispatchEvent(new MouseEvent('click',o));else c.dispatchEvent(new PointerEvent('"+art+"','"+art+"'==='pointerout'?{...o,relatedTarget:document.body}:o));return true})()");
 const fehlerHolen=async()=>errors.push(...(await imRahmen('(()=>{const f=window.__t93Fehler||[];window.__t93Fehler=[];return f})()')||[]));
 tab=(await kb('/tabs/new',{url:ui+'/t93-rahmen.html'})).tab_id;
 await wait(()=>da('data-renderer'),'Netzwerk-Canvas',30000);
 const renderer=await da('data-renderer');
 ok(renderer.startsWith('webgl2'),'WebGL2-Lichtrenderer aktiv: '+renderer);messung.renderer=renderer;
 ok(await anzahl('.nw-debug,.nw-stats,.nw-legend')===0,'Erklaerungen standardmaessig AUS');
 // Desktop live
 const lauf=leben(9000);
 await sleep(5200);await shot('01-desktop-live.png');
 await sleep(900);await shot('02-desktop-live-b.png');
 messung.plan_impulse=0;
 for(let i=0;i<15;i++){messung.plan_impulse=Math.max(messung.plan_impulse,Number(await da('data-plan-impulse')));await sleep(100);}
 messung.desktop_fps=await fps(3);
 await lauf;
 const kn=await imRahmen("(()=>{const c=document.querySelector('canvas.nw-gl');return {knoten:Number(c.dataset.knoten),channels:Number(c.dataset.channelCount),sprites:Number(c.dataset.sprites),plaene:Number(c.dataset.plaene)};})()");
 ok(kn.channels===2,'zwei aktive Channels als Synapsen: '+JSON.stringify(kn));
 ok(kn.plaene===4,'vier offene files-Plaene als Schattenplan-Knoten');
 ok(Number(await da('data-leer'))>0,'P22-T97: leere Ergebnisse zerplatzen unterwegs');
 ok(Number(await da('data-rueck'))>0,'P22-T97: Ergebnisse fliessen sichtbar zum Agenten zurueck');
 ok(messung.plan_impulse>0,'Aufrufe mit plan_id laufen in den Schattenplan ('+messung.plan_impulse+' Impulse gleichzeitig)');
 // Hover-Karte auf Koordinator nord
 const bildschirm=name=>imRahmen("(async()=>{const name="+JSON.stringify(name)+";"+
  "const c=document.querySelector('canvas.nw-gl'),r=c.getBoundingClientRect(),s=await(await fetch('/api/projects/p22-t93-browser/agentennetzwerk')).json(),g=window.p22szene(s,Date.now()),k=g.alias.get(name);"+
  "const z=Number(c.dataset.zoom),cx=Number(c.dataset.camX),cy=Number(c.dataset.camY),fx=Number(c.dataset.streckX||1),fy=Number(c.dataset.streckY||1);"+
  "return {x:r.x+r.width/2+(k.x*fx-cx)*z,y:r.y+r.height/2+(k.y*fy-cy)*z};})()");
 await knopf('Netzwerk vergrößern');await knopf('Netzwerk verkleinern');
 await sleep(2500);
 const p=await bildschirm('koordinator-nord');await zeiger('pointermove',p);
 await dialog('Knoten koordinator-nord');
 ok((await imRahmen("document.querySelector('.nw-card').textContent")).includes('claude-test'),'Hover-Karte zeigt Modell aus agenten-team');
 await shot('03-desktop-karte.png');
 await zeiger('pointerout');
 const pp=await bildschirm('plan:'+planA);await zeiger('pointermove',pp);
 await dialog('Knoten Plan '+planA);
 ok((await imRahmen("document.querySelector('.nw-card').textContent")).includes('Beitragende'),'Schattenplan-Karte zeigt Status, Besitzer und Beitragende');
 await shot('03b-desktop-schattenplan.png');
 await zeiger('pointerout');
 await knopf('Erklärungen');
 await knopf('Icon-Legende');
 const lauf2=leben(4000);await sleep(2600);await shot('04-desktop-erklaerungen.png');await lauf2;
 ok(await sichtbar('.nw-debug'),'Erklaerungen EIN zeigen Diagnose');
 await knopf('Icon-Legende');
 await knopf('Erklärungen');
 // P22-T95: Commit von Plan B fliesst ins Projekt, Verwerfen von Plan C explodiert (Bildfolgen der Buehne).
 const folge=async(name,art)=>{
  const vorher=Number(await da('data-abgang-'+art));
  await pool.query("INSERT INTO tool_calls(project,agent_id,tool_name,action,ok,args_preview) VALUES($1,'claude-ui','files','plan_status',true,'{}')",[P]);
  await wait(async()=>Number(await da('data-abgang-'+art))>vorher,'Abgang '+art,15000);
  for(const [i,ms] of [[1,120],[2,380],[3,420],[4,500]]){await sleep(ms);await shot(name+'-'+i+'.png','.nw-stage');}
 };
 await pool.query("UPDATE file_batch_plans SET status='committed',committed_at=NOW() WHERE id=$1::bigint",[planB]);
 await folge('09-commit','commit');
 ok(true,'Commit: Schattenplan B fliesst ins Projekt (Bildfolge 09-commit-1..4)');
 await pool.query("UPDATE file_batch_plans SET status='cancelled' WHERE id=$1::bigint",[planC]);
 await folge('10-explosion','explosion');
 ok(true,'Verworfen: Schattenplan C explodiert (Bildfolge 10-explosion-1..4)');
 const ende=(await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'})).json().plaene_ende;
 ok(ende.some(p=>p.id===planB&&p.status==='committed')&&ende.some(p=>p.id===planC&&p.status==='cancelled'),'Snapshot liefert Endstatus nur lesend (plaene_ende)');
 // Mobil 390 px
 await viewport(390,844);
 await knopf('Einpassen');
 const lauf3=leben(6000);await sleep(3800);await shot('05-mobil-live.png');
 const mobil=await imRahmen("({seite:document.documentElement.scrollWidth,vw:innerWidth,canvas:document.querySelector('canvas.nw-gl').clientWidth})");
 ok(mobil.seite<=mobil.vw&&mobil.canvas<=390,'390 px ohne horizontalen Ueberlauf '+JSON.stringify(mobil));
 messung.mobil_fps=await fps(2);await lauf3;
 await pool.query("UPDATE file_batch_plans SET status='expired' WHERE id=$1::bigint",[planD]);
 await folge('11-mobil-explosion','explosion');
 ok(true,'Mobil: abgelaufener Plan D explodiert (Bildfolge 11-mobil-explosion-1..4)');
 const pm=await bildschirm('claude-ui');await zeiger('click',pm);
 await dialog('Knoten claude-ui');
 await shot('06-mobil-karte.png');
 await knopf('Knotenkarte schließen');
 // 600-Agenten-Last
 await viewport(1500,1000);
 await einstellen({sichtbare_agenten:600,animation_limit:400,ereignis_limit:1200});
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv,modell_selbstauskunft)
  SELECT 'd93-last-'||n,$1,'zelle-'||LPAD(n::text,3,'0'),'zelle-'||LPAD(n::text,3,'0'),'subagent','aktiv','test',NOW(),CASE WHEN n%2=0 THEN 'claude-test' ELSE 'gpt-test' END FROM generate_series(1,600) n`,[P]);
 await pool.query(`INSERT INTO specialist_jobs(id,project,action,args,status,actor_identity_id,target_identity_id,completed_at)
  SELECT gen_random_uuid(),$1,'spawn',jsonb_build_object('identity_id','d93-last-'||n),'done',CASE WHEN n%3=0 THEN 'd93-nord' ELSE 'd93-sued' END,'d93-last-'||n,NOW() FROM generate_series(1,600) n WHERE n%5<>0`,[P]);
 const zellen=Array.from({length:600},(_,i)=>'zelle-'+String(i+1).padStart(3,'0'));
 await audit(600,zellen);
 const lauf4=leben(14000,30,zellen);
 const t0=Date.now(),probe=await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'});messung.snapshot_ms=Date.now()-t0;
 console.log('SNAPSHOT '+messung.snapshot_ms+' ms, agenten '+probe.json().agenten.length+', werte '+JSON.stringify(probe.json().werte));
 await fehlerHolen();
 await evaluate("document.getElementById('rahmen').contentWindow.location.reload();true");
 await wait(async()=>Number(await da('data-knoten'))>500,'600 Zellen nach Neuladen',90000).catch(async e=>{
  console.log('DIAGNOSE '+JSON.stringify(await imRahmen("({canvas:document.querySelectorAll('canvas').length,knoten:document.querySelector('canvas.nw-gl')?.getAttribute('data-knoten'),text:document.querySelector('.agent-network')?.innerText.slice(0,400)})").catch(x=>x.message))+' FEHLER '+errors.join(' | '));throw e;});
 await sleep(5000);await shot('07-last-600-desktop.png');
 messung.last_fps=await fps(5);
 messung.last=await imRahmen("(()=>{const c=document.querySelector('canvas.nw-gl');return {knoten:Number(c.dataset.knoten),sprites:Number(c.dataset.sprites),impulse:Number(c.dataset.animationCount),frameMs:Number(c.dataset.frameMs)};})()");
 await viewport(390,844);await sleep(2500);await shot('08-last-600-mobil.png');
 messung.last_mobil_fps=await fps(2);
 laeuft=false;await lauf4;
 ok(messung.last.knoten>500,'600 echte Testidentitaeten als Zellen gezeichnet '+JSON.stringify(messung.last));
 messung.qualitaet=await da('data-qualitaet');
 // Rohe Bildwiederholrate des KI-Browsers: er liefert selbst nur ~30 Bilder/s (Messung 25.10.2026: roh 31). Wie T149 gilt daher
 // 55 FPS bzw. 90 % der rohen Browserrate, falls diese darunter liegt.
 messung.roh_fps=await imRahmen("new Promise(r=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0<1000)requestAnimationFrame(f);else r(n)};requestAnimationFrame(f)})");
 const fpsSoll=Math.min(55,Math.floor(messung.roh_fps*0.9));
 if(gpu)ok(Math.min(...messung.last_fps)>=fpsSoll,'600 Agenten: mindestens '+fpsSoll+' FPS je Sekunde (55 bzw. 90 % der rohen Browserrate '+messung.roh_fps+') '+messung.last_fps.join(','));
 else console.log('SOFTWARE-RENDERING (nur Messung): FPS '+messung.last_fps.join(',')+' Qualitaetsstufe '+messung.qualitaet);
 await fehlerHolen();
 ok(!errors.length,'Browser ohne JavaScript-Fehler: '+errors.join(';'));
 await writeFile(join(folder,'messung.json'),JSON.stringify({checks,schema,gpu,browser:'ki-browser',...messung},null,2));
 console.log('MESSUNG '+JSON.stringify(messung));
 console.log('PASS P22-T93 Darstellung: '+checks+' Pruefungen; KI-Browser; '+schema+' wird entfernt');
}catch(e){failure=e;console.error(e);}finally{
 laeuft=false;await Promise.allSettled(laeufe);
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
