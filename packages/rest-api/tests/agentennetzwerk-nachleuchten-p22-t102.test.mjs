/** P22-T102: real private synapse_test API and KI-Browser, no deployment or production writes. */
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
const schema='p22_t102_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;const fixtureRoot=await mkdtemp(join(tmpdir(),'synapse-p22-t102-'));
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,120));}throw Error('Timeout: '+label);};
const ok=(value,label)=>{assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const messung={};
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
 await pool.query(AGENTENNETZWERK_SCHEMA_SQL);await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
 await pool.query('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[P,fixtureRoot,'t102-fixture']);
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

 for(const name of ['claude-ui','codex-api'])await ident('d93-'+name,name,'subagent',name==='claude-ui'?'claude-test':'gpt-test');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:true,grund:'T102 private fixture'},{system:'user'});
 const cfg=await C.leseNetzwerkKonfiguration(P);
 ok(cfg.werte.plan_nachleuchten_sekunden===30&&cfg.werte.plan_mindestanzeige_sekunden===3,'setting defaults 30s/3s');
 const setting=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},
  payload:{netzwerk_werte:{plan_nachleuchten_sekunden:8,plan_mindestanzeige_sekunden:3,abgleich_sekunden:3},grund:'T102 bounded browser test'}});
 assert.equal(setting.statusCode,200,setting.body);ok(setting.json().einstellungen.plan_nachleuchten_sekunden.quelle==='einstellung','setting persists and exposes source');
 const call=async(args,agent='claude-ui')=>{
  const r=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'files',arguments:{project:P,agent_id:agent,...args}}}});
  assert.equal(r.statusCode,200,r.body);const d=r.json();assert(!d.error,JSON.stringify(d));
  const result=d.result.structuredContent??JSON.parse(d.result.content.find(c=>c.type==='text').text);
  assert.equal(result.success,true,JSON.stringify(result));return result;
 };
 const plan=async(name,auto=false,coedit=true)=>call({action:'plan',auto_commit:auto,open_for_coedit:coedit,ops:[{action:'create',file_path:name,content:'T102 private test\\n'}]});
 const normal=await plan('normal.txt'),cancel=await plan('cancel.txt');
 const snapshot=async()=>(await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'})).json();
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const {PlanNachleuchten,planFade,planFarbe}=await vite.ssrLoadModule('/src/components/netzwerk/plan-nachleuchten.ts');
 const {netzwerkSzene}=await vite.ssrLoadModule('/src/components/netzwerk/nerven-szene.ts');
 let raw=await snapshot(),n=Date.now(),keep=new PlanNachleuchten();
 const p={...raw.plaene[0],status:'committed',committed:new Date(n-7900).toISOString()};
 const local=keep.aktualisiere({...raw,stand:new Date(n).toISOString(),plaene:[p]},n+90000);
 ok(planFade(local.plaene[0],n+91000,local)>0,'server/client clock skew and minimum display');
 const retained=keep.aktualisiere({...raw,plaene:[],plaene_ende:[{id:p.id,status:'committed'}]},n+91000);
 ok(retained.plaene.length===1,'minimum survives missing next snapshot');
 const again=keep.aktualisiere({...raw,stand:new Date(n+2000).toISOString(),plaene:[p]},n+92000);
 ok(planFade(again.plaene[0],n+92000,again)<0.5,'poll does not restart afterglow');
 ok(keep.aktualisiere({...raw,plaene:[],plaene_ende:[{id:p.id,status:'committed'}]},n+94000).plaene.length===0,'expires exactly once');
 keep=new PlanNachleuchten();keep.aktualisiere({...raw,plaene:[p]},n);
 ok(keep.aktualisiere({...raw,plaene:[],plaene_ende:[{id:p.id,status:'cancelled'}]},n+100).plaene.length===0,'cancel cannot glow as commit');
 const many=netzwerkSzene({...raw,plaene:Array.from({length:20},(_,i)=>({...p,id:'many-'+i,committed:new Date(n).toISOString()}))},n);
 ok(many.plaene===20,'no old 16-plan cutoff loses just committed plans');
 const folder=join(repo,'ui-screenshots/p22-t102');await mkdir(folder,{recursive:true});
 const shot=async name=>{await sleep(300);const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);await writeFile(join(folder,name),Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+join(folder,name));};
 tab=(await kb('/tabs/new',{url:ui+'/tests/agentennetzwerk.html'})).tab_id;
 await wait(()=>evaluate("!!document.querySelector('canvas.nw-gl')?.dataset.renderer"),'network canvas');
 const states=()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl')?.dataset.planZustaende||'[]')");
 const refresh=()=>evaluate("document.dispatchEvent(new Event('visibilitychange'));true");
 await wait(async()=>(await states()).some(p=>p.id===normal.plan_id),'open before commit');
 const auto=await plan('auto.txt',true),autoId=auto.plan_id;
 ok(auto.auto_committed===true,'real MCP auto_commit succeeds');
 const disk=(await pool.query('SELECT auto_commit FROM file_batch_plans WHERE id=$1',[autoId])).rows[0];
 ok(disk.auto_commit===true,'successful auto-commit provenance stored, not guessed');
 await call({action:'commit',plan_id:normal.plan_id});
 const legacy=await plan('legacy.txt',true,false);
 ok((await pool.query('SELECT auto_commit FROM file_batch_plans WHERE id=$1',[legacy.plan_id])).rows[0].auto_commit===true,'legacy atomic path records auto flag too');
 raw=await snapshot();
 ok(raw.plaene.some(p=>p.id===autoId&&p.auto_commit===true),'API exposes boolean auto_commit');
 ok(raw.plaene.some(p=>p.id===normal.plan_id&&p.auto_commit===false),'fast separate commit stays normal');
 ok(!JSON.stringify(raw.plaene).includes('T102 private test'),'plan response metadata has no file contents');
 await refresh();
 await wait(async()=>{const s=await states();return s.some(p=>p.id===autoId&&p.status==='auto-committet')&&s.some(p=>p.id===normal.plan_id&&p.status==='committet');},'instant auto and normal visible');
 const colors=await states();messung.farben=colors;
 ok(new Set(colors.map(p=>p.farbe)).size===3,'open / committed / auto have three distinct colors');
 ok(colors.filter(p=>[autoId,normal.plan_id].includes(p.id)).every(p=>p.beitraege===1),'afterglow nodes retain contributor links');
 const first=(await states()).find(p=>p.id===autoId).fade;await sleep(1150);
 ok((await states()).find(p=>p.id===autoId).fade<first,'actual canvas afterglow fades');
 await shot('01-offen-committet-auto.png');
 // Click/hover the real canvas node and read the visible status card.
 raw=await snapshot();
 const point=await evaluate("(()=>{const g=window.p22szene("+JSON.stringify(raw)+",Date.now()),k=g.alias.get('plan:"+autoId+"'),c=document.querySelector('canvas.nw-gl'),r=c.getBoundingClientRect(),d=c.dataset;return{x:r.x+r.width/2+(k.x*Number(d.streckX)-Number(d.camX))*Number(d.zoom),y:r.y+r.height/2+(k.y*Number(d.streckY)-Number(d.camY))*Number(d.zoom)};})()");
 await evaluate("(()=>{const c=document.querySelector('canvas.nw-text');c.dispatchEvent(new PointerEvent('pointermove',{clientX:"+point.x+",clientY:"+point.y+",pointerType:'mouse',bubbles:true}));c.dispatchEvent(new MouseEvent('click',{clientX:"+point.x+",clientY:"+point.y+",bubbles:true}));return true})()");
 await wait(()=>evaluate("document.querySelector('.nw-card')?.innerText.includes('auto-committet')"),'auto status tooltip');
 messung.tooltip=await evaluate("document.querySelector('.nw-card').innerText");await sleep(250);await shot('02-auto-tooltip.png');
 await evaluate("(()=>{document.querySelector('[aria-label=\"Knotenkarte schließen\"]')?.click();const e=document.querySelector('[aria-label=\"Erklärungen\"]');if(e.getAttribute('aria-checked')!=='true')e.click();return true})()");
 await wait(()=>evaluate("document.querySelector('[aria-label=\"Erklärungen\"]')?.getAttribute('aria-checked')==='true'"),'explanations ON');
 await evaluate("document.querySelector('[aria-label=\"Icon-Legende\"]').click();true");
 await wait(()=>evaluate("!!document.querySelector('.nw-legend')"),'legend');
 const legend=await evaluate("document.querySelector('.nw-legend').innerText");messung.legende=legend;
 await sleep(300);
 const legendVisible=await evaluate("(()=>{const l=document.querySelector('.nw-legend'),r=l.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:!!document.elementFromPoint(r.x+r.width/2,r.y+20)?.closest('.nw-legend')}})()");
 console.log('LEGEND '+JSON.stringify(legendVisible));ok(legendVisible.visible,'legend actually visible above canvas');
 ok(['offen (gold)','committet (grün','auto-committet (blau','verworfen (rote'].every(s=>legend.includes(s)),'legend names all four states');
 await shot('03-legende.png');
 await evaluate("document.querySelector('[aria-label=\"Icon-Legende\"]').click();true");
 const before=await evaluate("Number(document.querySelector('canvas.nw-gl').dataset.abgangExplosion)");
 await call({action:'cancel',plan_id:cancel.plan_id});await refresh();
 await wait(async()=>await evaluate("Number(document.querySelector('canvas.nw-gl').dataset.abgangExplosion)")>before,'discard explosion');
 ok(!(await states()).some(p=>p.id===cancel.plan_id),'cancelled plan removed, not committed afterglow');await shot('04-verworfen.png');
 // Near-window-end arrival: next API snapshot no longer contains it, local min duration does.
 const late=await plan('late.txt',true);
 await pool.query("UPDATE file_batch_plans SET committed_at=clock_timestamp()-INTERVAL '7.6 seconds' WHERE id=$1",[late.plan_id]);
 await refresh();await wait(async()=>(await states()).some(p=>p.id===late.plan_id),'late auto commit first seen');
 await sleep(650);await refresh();
 ok(!(await snapshot()).plaene.some(p=>p.id===late.plan_id),'late plan gone from API window');
 ok((await states()).some(p=>p.id===late.plan_id&&p.fade>0),'late plan still visible for local minimum');await shot('05-mindestanzeige.png');
 await wait(async()=>!(await states()).some(p=>p.id===late.plan_id),'minimum eventually expires',8000);
 ok(true,'local minimum ends without resurrection');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:false,grund:'T102 switch OFF check'},{system:'user'});
 await refresh();await wait(()=>evaluate("!document.querySelector('canvas.nw-gl')"),'existing product switch OFF');
 ok(!(await snapshot()).plaene?.length,'product OFF returns no plan metadata');
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,...messung},null,2));
 console.log('PASS P22-T102 '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(fixtureRoot,{recursive:true,force:true});
}
// Core's background file/embedding timers must not keep this isolated fixture process alive.
process.exit(failure?1:0);
