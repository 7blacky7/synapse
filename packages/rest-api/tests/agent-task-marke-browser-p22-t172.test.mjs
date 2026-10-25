/** P22-T172: Browserabnahme 'Name · aktuelle Task' im KI-Browser (privates synapse_test-Schema, echte API, Skripte per API).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agent-task-marke-browser-p22-t172.test.mjs
 * Testseite web-ui/tests/agent-task-marke.html (Fixture agent-task-marke-fixture.tsx: echtes Channel-Fenster + Agententeam-Zeile).
 * Sichert ab (Task P22-T172; User inbox 1265/1266/1267, Entwurf thought c1261c51):
 *   1 Schalter agent_aktuelle_task AUS: nur Namen, keine Marke (Altverhalten; AgentTaskMarke.tsx, agent-aktuelle-task.ts).
 *   2 EIN (intern-Override, befristet): Channel-Agentenleiste 'claude-a · P1-T2' (Aktivitaet) und 'claude-b · P1-T4' (Bindung),
 *     Channel-Absender, Agententeam-Zeile, Absatz 'Aktuelle Task' mit Quelle (SynapseWorkspaceMock.tsx, AgentTaskMarke.tsx).
 *   3 Klick auf die Task in der Agentenleiste -> Lesefenster P1-T2, Agentenfenster oeffnet sich NICHT.
 *   4 Klick in der Team-Zeile (ohne umgebenden Provider) -> Lesefenster, Schaltflaeche der Zeile wird NICHT ausgeloest.
 *   5 hell: Darstellung. Jedes Warten hat ein Zeitlimit. Screenshots: ui-screenshots/p22-t172/*.png.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ... | screenshot ...'. */
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
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t172b_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t172-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0,letzterShot='';
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
 console.error('DEBUG Timeout '+label+' | screenshot '+letzterShot+' | seitenfehler '+JSON.stringify(await evaluate('JSON.stringify(window.__fehler??[])').catch(()=>'?')));throw Error('Timeout: '+label);};
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert und letztem Screenshot.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):'')+' | screenshot '+letzterShot);assert(value,label);console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const A=randomUUID(),B=randomUUID(),T2=randomUUID(),T4=randomUUID();
const task=(id,nr,status,titel)=>({id,kurz_id:'P1-T'+nr,title:titel,description:'Beschreibung P1-T'+nr+': im Lesefenster lesbar.',status,priority:'medium',
 createdAt:'2026-10-25T10:00:00Z',updatedAt:'2026-10-25T10:00:00Z',beteiligte:[]});
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
 await pool.query(C.AGENT_AKTUELLE_TASK_SCHEMA_SQL);await pool.query(C.CHAT_ZITATE_SCHEMA_SQL);
 const schalter=async aktiv=>{await pool.query("DELETE FROM intern_schalter WHERE name='agent_aktuelle_task'");
  await pool.query("INSERT INTO intern_schalter(name,modus,aktiv,bis,grund) VALUES('agent_aktuelle_task','freigegeben',$1,NOW()+interval '2 hours','T172 Browserabnahme (befristet)')",[aktiv]);C.leereAktuelleTaskCache();};
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$3,'claude-a','claude-a','subagent','aktiv','t172'),($2,$3,'claude-b','claude-b','subagent','aktiv','t172')`,[A,B,P]);
 const tasks=[task(T2,2,'in_progress','Zweite Aufgabe'),task(T4,4,'in_progress','Vierte Aufgabe')];
 // plans.tasks ist die Wahrheit (Lesefenster), plan_tasks die Projektion (Ermittlung); im privaten Schema ohne Trigger beides setzen.
 const planId=randomUUID();
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id,prioritaet) VALUES($1,$2,'Marken','',$3::jsonb,true,'P1','hoch')",[planId,P,JSON.stringify(tasks)]);
 await pool.query('DELETE FROM plan_tasks WHERE project=$1',[P]);
 for(const t of tasks)await pool.query("INSERT INTO plan_tasks(id,project,plan_id,plan_kurz_id,task,updated_at) VALUES($1,$2,$3,'P1',$4,NOW()::text)",[t.id,P,planId,t]);
 await pool.query("INSERT INTO tool_calls(project,tool_name,action,source,args_preview,ok,ts,agent_id,identity_id) VALUES($1,'plan','get','rest',$2,true,NOW()-interval '5 minutes','claude-a',$3)",
  [P,JSON.stringify({action:'get',project:P,task_id:'P1-T2'}),A]);
 await pool.query("INSERT INTO plan_task_bindungen(project,task_id,art,identity_ids,gesetzt_von,gesetzt_am) VALUES($1,'P1-T4','identitaet',ARRAY[$2]::text[],'t172',NOW()-interval '1 hour')",[P,B]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const V=await load('packages/rest-api/dist/routes/verweise.js');
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.register(V.verweiseRoutes);await app.register(S.specialistRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/agent-task-marke.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const folder=join(repo,'ui-screenshots/p22-t172');await mkdir(folder,{recursive:true});
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);await writeFile(join(folder,f),Buffer.from(await r.arrayBuffer()));letzterShot='ui-screenshots/p22-t172/'+f;console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/agent-task-marke.html?project='+P+'&a='+A+'&b='+B+'&token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const bereit=()=>wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await kb('/tabs/new',{url:url(theme)})).tab_id;await bereit();
  await wait(async()=>(await evaluate("document.querySelectorAll('.channel-agent-card').length"))===2,'Channel-Agentenleiste gerendert',30000);};
 const S_=JSON.stringify;
 const marken=()=>json("JSON.stringify([...document.querySelectorAll('.agent-task-marke[data-aktuelle-task]')].map(m=>({ort:m.closest('[data-bereich],.channel-agent-card,.channel-messages,.aktuelle-task-absatz')?.className||m.closest('[data-bereich]')?.getAttribute('data-bereich')||'?',bereich:m.closest('[data-bereich]')?.getAttribute('data-bereich')??null,karte:m.closest('.channel-agent-card')?.querySelector('strong')?.textContent??null,absender:!!m.closest('.channel-messages'),task:m.getAttribute('data-aktuelle-task'),quelle:m.getAttribute('data-aktuelle-task-quelle'),text:m.textContent})))");
 const fenster=re=>"[...document.querySelectorAll('.verweis-fenster')].find(f=>"+re+".test(f.innerText))";
 const HM='P22-T172 AgentTaskMarke.tsx (KI-Browser)';
 const HW='P22-T172 SynapseWorkspaceMock.tsx ChannelsView (KI-Browser)';

 // ================================================================ 1 Schalter AUS: nur Namen
 await schalter(false);
 await oeffne('dark');
 const aus=await json("fetch('/api/projects/"+P+"/agenten-aktuelle-task',{headers:{authorization:'Bearer '+"+S_(sitzung)+"}}).then(r=>r.json()).then(d=>JSON.stringify({aktiv:d.aktiv,quelle:d.schalter?.quelle,n:d.agenten?.length}))");
 await sleep(1500);
 const m0=await marken();
 ok(aus.aktiv===false&&aus.quelle==='intern'&&aus.n===0&&m0.length===0,HM+': Schalter AUS -> keine Marke, nur Namen (Altverhalten)',{aus,m0});
 ok((await evaluate("[...document.querySelectorAll('.channel-agent-card strong')].map(s=>s.textContent).join()"))==='claude-a,claude-b',HW+': Agentenleiste nennt die Namen der Identitaeten (keine Ausweiswerte)');
 await shot('dunkel-schalter-aus');

 // ================================================================ 2 Schalter EIN: Name · Task an allen Stellen der Testseite
 await schalter(true);
 await oeffne('dark');
 await wait(async()=>(await marken()).length>=5,'Marken nach dem Laden',30000);
 const m1=await marken();
 const karteA=m1.find(x=>x.karte==='claude-a'),karteB=m1.find(x=>x.karte==='claude-b');
 ok(karteA&&karteA.task==='P1-T2'&&karteA.quelle==='aktivitaet:tool_calls'&&karteA.text===' · P1-T2',HW+": Agentenleiste 'claude-a · P1-T2' (Quelle Aktivitaet)",m1);
 ok(karteB&&karteB.task==='P1-T4'&&karteB.quelle==='bindung',HW+": Agentenleiste 'claude-b · P1-T4' (Quelle Task-Bindung)",m1);
 ok(m1.some(x=>x.absender&&x.task==='P1-T2'),HW+': Channel-Absender claude-a mit Task',m1);
 ok(m1.some(x=>x.bereich==='team'&&x.task==='P1-T2'),HM+': Agententeam-Zeile mit Task',m1);
 const absatz=await evaluate("document.querySelector('[data-bereich=\"team-detail\"] .aktuelle-task-absatz')?.innerText.replace(/\\s+/g,' ').trim()??''");
 ok(/^Aktuelle Task: P1-T2 Zweite Aufgabe/.test(absatz)&&/Quelle: letzte Aktivität \(Tool-Aufruf\)/.test(absatz),'P22-T172 AgentTaskMarke.tsx AktuelleTaskAbsatz (KI-Browser): Task, Titel und Quelle der Ermittlung',absatz);
 const titel=await evaluate("document.querySelector('.channel-agent-card .agent-task-marke')?.getAttribute('title')??''");
 ok(/^P1-T2: Zweite Aufgabe/.test(titel)&&/Quelle:/.test(titel),HM+': Tooltip mit Titel und Quelle (Debug)',titel);
 await shot('dunkel-name-task');

 // ================================================================ 3 Klick in der Agentenleiste -> Lesefenster, kein Agentenfenster
 await evaluate("document.querySelector('.channel-agent-card .agent-task-link').click()");
 await wait(async()=>!!(await evaluate('!!'+fenster('/Beschreibung P1-T2/'))),'Lesefenster P1-T2 aus der Agentenleiste');
 const offen=await evaluate("document.querySelectorAll('.channel-agent-card.is-open').length");
 ok(offen===0,HW+': Klick auf die Task oeffnet das Lesefenster, nicht das Agentenfenster',{offen});
 ok((await evaluate("("+fenster('/Beschreibung P1-T2/')+")?.getAttribute('data-lesefenster-herkunft')"))==='ohne','P22-T172 Lesefenster.tsx (KI-Browser): Task-Marke oeffnet mit Herkunft ohne');
 await shot('dunkel-lesefenster-aus-leiste');
 await evaluate("[...document.querySelectorAll('.verweis-fenster .verweis-titel button')].filter(b=>b.getAttribute('aria-label')==='Fenster schließen').forEach(b=>b.click())");

 // ================================================================ 4 Team-Zeile ohne Provider: eigener Provider, Schaltflaeche bleibt unberuehrt
 await evaluate("document.querySelector('[data-bereich=\"team\"] [data-team-zeile] .agent-task-link').click()");
 await wait(async()=>!!(await evaluate('!!'+fenster('/Beschreibung P1-T2/'))),'Lesefenster P1-T2 aus der Team-Zeile');
 ok((await evaluate('window.__teamKlicks'))===0,HM+': eigener Provider ohne Umgebung, Klick loest die Zeilen-Schaltflaeche nicht aus',await evaluate('window.__teamKlicks'));
 await shot('dunkel-lesefenster-aus-team');
 ok((await json('JSON.stringify(window.__fehler??[])')).length===0,'P22-T172 Testseite (KI-Browser): keine Seitenfehler',await json('JSON.stringify(window.__fehler??[])'));

 // ================================================================ 5 hell
 await oeffne('light');
 await wait(async()=>(await marken()).length>=5,'hell: Marken',30000);
 await shot('hell-name-task');
 ok(true,HM+': helle Darstellung (Screenshot)');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,schalter:'intern_schalter agent_aktuelle_task (befristet), Produkt-Schalter AUS'},null,2));
 console.log('PASS P22-T172 Name+Task Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
