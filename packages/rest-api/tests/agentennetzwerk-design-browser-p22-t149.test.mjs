/** P22-T148/T149: Browserabnahme der Design-Welle im KI-Browser (privates synapse_test-Schema, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agentennetzwerk-design-browser-p22-t149.test.mjs
 * Prueft im echten Canvas (dunkel und hell): Projektstern/Trabanten/Nebel aus der Index-Groesse, kein User-Knoten, Feuern ueber die Membran
 * (inbox_send an user, artefakt zeigen), Commit-Flug gruen bzw. blau mit Projektreaktion, Explosion bei cancel, Schalter-Rueckfall, Bildrate.
 * Screenshots: ui-screenshots/p22-t149/. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
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
const schema='p22_t149_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;const fixtureRoot=await mkdtemp(join(tmpdir(),'synapse-p22-t149-'));
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
const ok=(value,label)=>{assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const belege={};
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
 await pool.query('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[P,fixtureRoot,'t149-fixture']);
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
 for(const name of ['claude-ui','codex-api'])await ident('d93-'+name,name,'subagent',name==='claude-ui'?'claude-test':'gpt-test');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:true,grund:'T149 private fixture'},{system:'user'});
 const einstellen=async(werte)=>{const r=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},payload:{netzwerk_werte:werte,grund:'T149 Browserabnahme'}});assert.equal(r.statusCode,200,r.body);return r.json();};
 await einstellen({abgleich_sekunden:3});
 // Index wie synapse (2.000 Dateien, 22.300 Chunks): Stern klein, 20 Trabanten, 223 Nebelpunkte.
 const index=async(dateien,chunks)=>{
  await pool.query('DELETE FROM code_files WHERE project=$1',[P]);await pool.query('DELETE FROM code_chunks WHERE project=$1',[P]);
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) SELECT 't149f'||g,$1,'f'||g||'.ts','f'||g||'.ts','ts' FROM generate_series(1,$2::int) g",[P,dateien]);
  await pool.query("INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) SELECT 't149c'||g,$1,'f1.ts',g,'x',1,1 FROM generate_series(1,$2::int) g",[P,chunks]);
 };
 await index(2000,22300);
 const call=async(name,args,agent='claude-ui')=>{
  const r=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{project:P,agent_id:agent,...args}}}});
  assert.equal(r.statusCode,200,r.body);const d=r.json();assert(!d.error,JSON.stringify(d));
  const result=d.result.structuredContent??JSON.parse(d.result.content.find(c=>c.type==='text').text);
  assert.equal(result.success,true,JSON.stringify(result));return result;
 };
 const plan=(file,auto=false)=>call('files',{action:'plan',auto_commit:auto,open_for_coedit:true,ops:[{action:'create',file_path:file,content:'T149 private test\\n'}]});
 const snapshot=async()=>(await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'})).json();
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const folder=join(repo,'ui-screenshots/p22-t149');await mkdir(folder,{recursive:true});
 const shot=async name=>{const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);await writeFile(join(folder,name),Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT ui-screenshots/p22-t149/'+name);};
 const ds=()=>evaluate("(()=>{const d=document.querySelector('canvas.nw-gl')?.dataset||{};return {stern:Number(d.stern),trabanten:Number(d.trabanten),einzeln:Number(d.trabantenEinzeln),nebel:Number(d.nebelPunkte),anUser:Number(d.anUser),commit:Number(d.abgangCommit),explosion:Number(d.abgangExplosion),farben:JSON.parse(d.commitFarben||'{}'),fps:Number(d.fps),frameMs:Number(d.frameMs),qualitaet:Number(d.qualitaet),sprites:Number(d.sprites),renderer:d.renderer,akzent:d.akzent}})()");
 const refresh=()=>evaluate("document.dispatchEvent(new Event('visibilitychange'));true");
 // Rohe Bildwiederholrate des KI-Browsers (ohne Netzwerk-Arbeit): Massstab fuer 'keine Ruckler'.
 const raf=()=>evaluate("new Promise(r=>{let n=0;const t0=performance.now();const f=()=>{n++;if(performance.now()-t0<1000)requestAnimationFrame(f);else r(n)};requestAnimationFrame(f)})");
 const fluessig=async(name)=>{const roh=await raf(),x=await ds();belege['bildrate_'+name]={roh,fps:x.fps,frameMs:x.frameMs,qualitaet:x.qualitaet,sprites:x.sprites,renderer:x.renderer};console.log('BILDRATE '+name+' '+JSON.stringify(belege['bildrate_'+name]));
  ok(x.fps>=Math.min(45,roh*0.85)&&x.frameMs<8&&x.qualitaet===0,'Bildrate '+name+': '+x.fps+' FPS bei roher Browserrate '+roh+', Zeichnen '+x.frameMs+' ms, volle Qualitaetsstufe');};
 const hell=on=>evaluate("(()=>{const r=document.getElementById('root');r.className=" + (on?"'synapse-control'":"''") + ";if(" + (on?'true':'false') + "){r.dataset.theme='light';document.documentElement.style.background='#f4f2ee'}else{delete r.dataset.theme;document.documentElement.style.background=''}return true})()");
 tab=(await kb('/tabs/new',{url:ui+'/tests/agentennetzwerk.html'})).tab_id;
 await wait(()=>evaluate("!!document.querySelector('canvas.nw-gl')?.dataset.renderer"),'Netzwerk-Canvas');
 await wait(async()=>(await ds()).trabanten===20,'Index im Canvas angekommen');
 let d=await ds();belege.start=d;
 ok(Math.abs(d.stern-(0.08+0.92*2000/10000))<1e-6,'Stern linear: 2.000 Dateien -> '+d.stern.toFixed(3));
 ok(d.trabanten===20&&d.einzeln===20,'20 Trabanten (je 100 Dateien)');
 ok(d.nebel===223,'223 Nebelpunkte (je 100 Chunks) als Ebene');
 await sleep(2500);await fluessig('dunkel');
 await shot('01-dunkel-stern-trabanten-nebel.png');

 // T148: Nachricht an den User und Artefakt des Hauptagenten feuern ueber die Membran; kein User-Knoten.
 const vorher=(await ds()).anUser;
 await call('chat',{action:'inbox_send',to_agent:'user',from_agent:'koordinator-nord',content:'<p>T149 an den User</p>'},'koordinator-nord');
 await pool.query("INSERT INTO tool_calls(project,tool_name,action,source,args_preview,ok,ts,agent_id,identity_id) VALUES($1,'artefakt','zeigen','cloud','{\"action\":\"zeigen\"}',true,NOW(),$2,'d93-main')",[C.HAUPTAGENT_PROJEKT,C.HAUPTAGENT_AGENT_ID]);
 // Das Audit des MCP-Aufrufs wird nach der Antwort geschrieben: auf beide Ereignisse im Snapshot warten.
 let s1;await wait(async()=>{s1=await snapshot();return s1.ereignisse.some(e=>e.art==='an_user')&&s1.ereignisse.some(e=>e.art==='artefakt');},'an_user und artefakt im Snapshot');
 ok(s1.ereignisse.some(e=>e.art==='an_user'&&e.empfaenger.length===0)&&s1.ereignisse.some(e=>e.art==='artefakt'),'API: Ereignisse an_user und artefakt, Empfaenger ohne user');
 await refresh();await sleep(900);await shot('02-dunkel-membran-signal.png');
 await wait(async()=>(await ds()).anUser>=vorher+2,'beide Signale erreichen den Netzrand');
 const ohneUser=await evaluate("fetch('/api/projects/"+P+"/agentennetzwerk').then(r=>r.json()).then(s=>{const g=window.p22szene(s,Date.now());return g.knoten.every(k=>!['user','system'].includes(String(k.id).toLowerCase())&&!['user','system'].includes(String(k.name).toLowerCase()))})");
 ok(ohneUser===true,'kein Knoten user/system im Netzwerk');

 // T149: Commit-Flug gruen (normaler Commit) und blau (auto_commit) mit Projektreaktion; cancel explodiert.
 const offen=await plan('normal.txt');await refresh();
 await wait(()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl').dataset.planZustaende||'[]').some(p=>p.id==='"+offen.plan_id+"')"),'offener Plan als Raute');
 let f0=(await ds()).farben;
 await call('files',{action:'commit',plan_id:offen.plan_id});await refresh();
 await wait(async()=>((await ds()).farben.committet??0)>(f0.committet??0),'gruener Commit-Flug startet');
 await sleep(350);await shot('03-dunkel-commit-flug-gruen.png');await sleep(950);await shot('04-dunkel-projektreaktion-gruen.png');
 f0=(await ds()).farben;
 await plan('auto.txt',true);await refresh();
 await wait(async()=>((await ds()).farben.auto??0)>(f0.auto??0),'blauer Flug (auto_commit, nie als Raute gesehen)');
 await sleep(350);await shot('05-dunkel-commit-flug-blau.png');await sleep(950);await shot('06-dunkel-projektreaktion-blau.png');
 ok(!(await evaluate("JSON.parse(document.querySelector('canvas.nw-gl').dataset.planZustaende||'[]').length")),'committete Plaene bleiben keine Knoten (kein Fade-out mehr)');
 const ex=(await ds()).explosion,weg=await plan('cancel.txt');await refresh();
 await wait(()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl').dataset.planZustaende||'[]').some(p=>p.id==='"+weg.plan_id+"')"),'zu verwerfender Plan sichtbar');
 await call('files',{action:'cancel',plan_id:weg.plan_id});await refresh();
 await wait(async()=>(await ds()).explosion>ex,'cancel explodiert');
 d=await ds();belege.fluege=d.farben;ok(d.farben.committet>=1&&d.farben.auto>=1,'Commit-Arten nur per Farbe: '+JSON.stringify(d.farben));

 // Helles Design 'Tinte auf Papier'
 await hell(true);await sleep(1500);await shot('07-hell-stern-trabanten-nebel.png');
 // Kopf und Zaehlerzeile im hellen Design: Kontrast (WCAG) von Ueberschrift, Status, Zaehlern und Zaehlertext gegen den Kopfgrund.
 const kontrast=await evaluate("(()=>{const rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number),lum=c=>{const [r,g,b]=c.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*r+0.7152*g+0.0722*b},k=(a,b)=>{const x=lum(rgb(a)),y=lum(rgb(b));return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};const bg=getComputedStyle(document.querySelector('.agent-network')).getPropertyValue('--nw-head-top').trim();const hex=h=>'rgb('+[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)).join(',')+')';const B=hex(bg),f=s=>getComputedStyle(document.querySelector(s)).color;return {ueberschrift:k(f('.nw-head strong'),B),status:k(f('.nw-head small'),B),zahl:k(f('.nw-stats b'),B),zaehlertext:k(f('.nw-stats span'),B),feedname:document.querySelector('.nw-feed strong')?k(f('.nw-feed strong'),hex(getComputedStyle(document.querySelector('.agent-network')).getPropertyValue('--nw-bg').trim())):99,punkt:getComputedStyle(document.querySelector('.nw-signal')).backgroundColor}})()");
 belege.kontrast_hell=kontrast;console.log('KONTRAST hell '+JSON.stringify(kontrast));
 ok(kontrast.ueberschrift>=7&&kontrast.status>=4.5&&kontrast.zahl>=4.5&&kontrast.zaehlertext>=4.5&&kontrast.feedname>=4.5,'helles Design: Kopf, Zaehlerzeile und Feed lesbar (Ueberschrift '+kontrast.ueberschrift.toFixed(1)+':1)');
 ok(/249,\s*115,\s*22/.test(kontrast.punkt),'Statuspunkt bleibt in der Akzentfarbe');
 await evaluate("document.querySelector('.agent-network').scrollIntoView({block:'start'});true");await sleep(300);await shot('13-hell-kopf.png');
 const v2=(await ds()).anUser;
 await call('chat',{action:'inbox_send',to_agent:'user',from_agent:'koordinator-nord',content:'T149 hell'},'koordinator-nord');
 await refresh();await sleep(900);await shot('08-hell-membran-signal.png');
 await wait(async()=>(await ds()).anUser>v2,'Signal im hellen Design');
 f0=(await ds()).farben;const h=await plan('hell.txt');await refresh();
 await wait(()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl').dataset.planZustaende||'[]').some(p=>p.id==='"+h.plan_id+"')"),'Raute hell');
 await call('files',{action:'commit',plan_id:h.plan_id});await refresh();
 await wait(async()=>((await ds()).farben.committet??0)>(f0.committet??0),'Commit-Flug hell');
 await sleep(350);await shot('09-hell-commit-flug.png');await sleep(950);await shot('10-hell-projektreaktion.png');
 await sleep(2000);await fluessig('hell');

 // Grosser Bestand (wie parser-testkorpus): Zeichengrenze 300, Nebel 4.511, Stern am Deckel. Cache der Index-Groesse: 30 s.
 await hell(false);await index(58165,451100);await sleep(31000);await refresh();
 await wait(async()=>(await ds()).trabanten===581,'grosser Bestand angekommen',15000);
 d=await ds();belege.gross=d;
 ok(d.einzeln===300&&d.nebel===4511&&d.stern>0.97,'grosser Bestand: 581 Trabanten (300 einzeln, Rest dichter), 4.511 Nebelpunkte, Stern '+d.stern.toFixed(3));
 await sleep(2500);await fluessig('gross');
 await shot('11-dunkel-grosser-bestand.png');await hell(true);await sleep(1500);await shot('12-hell-grosser-bestand.png');await hell(false);

 // Schalter: orbit_nebel=0 -> feste Darstellung; an_user_animation=0 -> nur Feed.
 await einstellen({orbit_nebel:0,an_user_animation:0});await refresh();
 await wait(async()=>{const x=await ds();return x.trabanten===42&&x.nebel===0&&x.stern===1;},'Rueckfall orbit_nebel=0');
 ok(true,'Schalter orbit_nebel=0: 42 feste Teilchen, kein Nebel, feste Sterngroesse');
 const v3=(await ds()).anUser;
 await call('chat',{action:'inbox_send',to_agent:'user',from_agent:'koordinator-nord',content:'T149 aus'},'koordinator-nord');await refresh();await sleep(2500);
 ok((await ds()).anUser===v3,'Schalter an_user_animation=0: keine Animation, nur Feed');
 await einstellen({orbit_nebel:1,an_user_animation:1});
 // Produkt-Schalter AUS: Netzwerk verschwindet, bestehende Hauptagent-Ansicht bleibt.
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:false,grund:'T149 Schalter AUS'},{system:'user'});
 await refresh();
 try{await wait(()=>evaluate("!document.querySelector('canvas.nw-gl')"),'Produkt-Schalter AUS');}
 catch(e){belege.aus_diagnose=await evaluate("fetch('/api/projects/"+P+"/agentennetzwerk').then(r=>r.json()).then(s=>({aktiv:s.schalter&&s.schalter.aktiv,fehler:document.querySelector('.nw-error')?.innerText??null,status:document.querySelector('.nw-head small')?.innerText??null}))");console.log('DIAGNOSE AUS '+JSON.stringify(belege.aus_diagnose));throw e;}
 ok(true,'Produkt-Schalter AUS blendet das Netzwerk aus');
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,...belege},null,2));
 console.log('PASS P22-T148/T149 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(fixtureRoot,{recursive:true,force:true});
}
process.exit(failure?1:0);
