/** P22-T104: echte Anzeigedauer committeter Plaene im KI-Browser messen (privates synapse_test-Schema, keine Produktionsdaten).
 * P22_T104_NUR_MESSEN=1: nur messen und belegen (Vorher-Lauf), keine Soll-Pruefungen. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
import {isolierterTab} from '../../../scripts/lib/ki-browser-isolation.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const nurMessen=process.env.P22_T104_NUR_MESSEN==='1',praefix=nurMessen?'vorher-':'';

for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t104_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;const fixtureRoot=await mkdtemp(join(tmpdir(),'synapse-p22-t104-'));
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=10000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,120));}throw Error('Timeout: '+label);};
const ok=(value,label)=>{if(nurMessen){console.log((value?'(ok) ':'(ABWEICHUNG) ')+label);return;}assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const messung={nur_messen:nurMessen};
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
 await pool.query('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[P,fixtureRoot,'t104-fixture']);
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
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:true,grund:'T104 private fixture'},{system:'user'});
 // Keine Einstellung gesetzt: gemessen wird der Standard, so wie ihn der User ohne Eingriff sieht.
 const cfg=await C.leseNetzwerkKonfiguration(P);
 messung.einstellungen={plan_nachleuchten_sekunden:cfg.einstellungen.plan_nachleuchten_sekunden,plan_nachleuchten_auto_sekunden:cfg.einstellungen.plan_nachleuchten_auto_sekunden,plan_mindestanzeige_sekunden:cfg.einstellungen.plan_mindestanzeige_sekunden,abgleich_sekunden:cfg.einstellungen.abgleich_sekunden};
 console.log('EINSTELLUNGEN '+JSON.stringify(messung.einstellungen));
 const fenster=cfg.werte.plan_nachleuchten_sekunden*1000,fensterAuto=(cfg.werte.plan_nachleuchten_auto_sekunden??cfg.werte.plan_nachleuchten_sekunden)*1000,soll={committet:fenster,'auto-committet':fensterAuto};
 ok(cfg.werte.plan_nachleuchten_auto_sekunden===3&&cfg.werte.plan_nachleuchten_sekunden===3,'Standard kurz: auto 3 s, committet '+cfg.werte.plan_nachleuchten_sekunden+' s');
 const call=async(args,agent='claude-ui')=>{
  const r=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'files',arguments:{project:P,agent_id:agent,...args}}}});
  assert.equal(r.statusCode,200,r.body);const d=r.json();assert(!d.error,JSON.stringify(d));
  const result=d.result.structuredContent??JSON.parse(d.result.content.find(c=>c.type==='text').text);
  assert.equal(result.success,true,JSON.stringify(result));return result;
 };
 const plan=async(name,auto=false,agent='claude-ui')=>call({action:'plan',auto_commit:auto,open_for_coedit:true,ops:[{action:'create',file_path:name,content:'T104 private test\\n'}]},agent);
 const snapshot=async()=>(await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'})).json();
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;

 // Teil A (Logik): ein abgelaufener Plan, der kurz aus dem Snapshot faellt und wiederkommt, darf nicht erneut aufleuchten.
 const {PlanNachleuchten,planFade}=await vite.ssrLoadModule('/src/components/netzwerk/plan-nachleuchten.ts');
 const raw=await snapshot(),n=Date.now(),keep=new PlanNachleuchten();
 const p={id:'t104-x',besitzer:null,besitzer_name:null,status:'committed',auto_commit:false,coedit:false,erstellt:new Date(n-2000).toISOString(),committed:new Date(n-1000).toISOString(),ops:1,dateien:1,dateien_beispiele:[],beitraege:[]};
 const mit=t=>({...raw,stand:new Date(t).toISOString(),plaene:[p]}),ohne=t=>({...raw,stand:new Date(t).toISOString(),plaene:[],plaene_ende:[{id:p.id,status:'committed'}]});
 keep.aktualisiere(mit(n),n);
 // Spaetestens nach dem vollen Fenster ab Empfang abgelaufen (Mindestanzeige ist auf das Fenster gedeckelt).
 const ablauf=n+fenster+500;
 ok(keep.aktualisiere(mit(ablauf),ablauf).plaene.length===0,'Logik: nach Ablauf unsichtbar, obwohl der Server ihn noch liefert');
 keep.aktualisiere(ohne(ablauf+200),ablauf+200);
 const wieder=keep.aktualisiere(mit(ablauf+400),ablauf+400);
 messung.logik_wiederkehr={sichtbar:wieder.plaene.length>0};
 ok(wieder.plaene.length===0,'Logik: Wiederkehr im Snapshot startet die Frist nicht neu');

 // Teil B (Browser, umgestellt mit P22-T149, User-Entscheidung thought 79c0bd8b): committete und auto-committete Plaene verblassen nicht
 // mehr als Knoten, sondern fliegen sofort ins Projekt (gruen bzw. blau); erneute Snapshots starten keinen zweiten Flug.
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t104/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t104'),folder=ablage.ordner;
 const shot=async name=>{const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(praefix+name,Buffer.from(await r.arrayBuffer())));};
 tab=(await isolierterTab(kb,{url:ui+'/tests/agentennetzwerk.html'})).tab_id;
 await wait(()=>evaluate("!!document.querySelector('canvas.nw-gl')?.dataset.renderer"),'network canvas');
 const states=()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl')?.dataset.planZustaende||'[]')");
 const refresh=()=>evaluate("document.dispatchEvent(new Event('visibilitychange'));true");
 const farben=()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl')?.dataset.commitFarben||'{}')");
 const offen=await plan('offen.txt',false,'codex-api'),normal=await plan('normal.txt');
 await refresh();await wait(async()=>(await states()).some(x=>x.id===normal.plan_id),'open plans visible');
 const f0=await farben();
 await call({action:'commit',plan_id:normal.plan_id});
 const auto=await plan('auto.txt',true);
 await refresh();
 await wait(async()=>{const f=await farben();return (f.committet??0)>(f0.committet??0)&&(f.auto??0)>(f0.auto??0);},'gruener und blauer Flug');
 await sleep(400);await shot('01-flug.png');
 messung.farben=await farben();
 for(let i=0;i<8;i++){await refresh();await sleep(300);}
 const s=await states(),f1=await farben();
 ok(!s.some(x=>[normal.plan_id,auto.plan_id].includes(x.id)),'Browser: committete Plaene sind keine Knoten mehr (Flug statt Nachleuchten)');
 ok(f1.committet===messung.farben.committet&&f1.auto===messung.farben.auto,'Browser: erneute Snapshots starten keinen zweiten Flug');
 ok(s.find(x=>x.id===offen.plan_id)?.animation==='puls','Browser: offener Plan behält Puls');
 await shot('02-nach-flug.png');

 // Teil C: Wert bleibt Einstellung in PG (wirkt nur noch auf die Logik von PlanNachleuchten, nicht mehr als Knotenanzeige).
 if(!nurMessen){
  const setting=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},
   payload:{netzwerk_werte:{plan_nachleuchten_auto_sekunden:2},grund:'T104 Einstellung wirkt'}});
  assert.equal(setting.statusCode,200,setting.body);ok(setting.json().einstellungen.plan_nachleuchten_auto_sekunden.quelle==='einstellung','Einstellung auto persistiert mit Quelle');
 }
 await writeFile(join(folder,praefix+'belege.json'),JSON.stringify({checks,...messung},null,2));
 console.log((nurMessen?'MESSUNG FERTIG':'PASS P22-T104 '+checks+' checks')+'; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(fixtureRoot,{recursive:true,force:true});
}
process.exit(failure?1:0);
