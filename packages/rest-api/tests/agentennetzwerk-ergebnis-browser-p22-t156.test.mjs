/** P22-T156 (+T155): Browser-Sichtprobe der Ergebnis-Effekte im KI-Browser (privates synapse_test-Schema, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agentennetzwerk-ergebnis-browser-p22-t156.test.mjs
 * Je Ergebnisart (falsch aufgerufen, gesperrt, nicht gefunden, Konflikt, Serverfehler, wartet, sonstiges) eine echte tool_calls-Zeile des
 * Arbeitsagenten; der Snapshot klassifiziert sie, der Canvas zeigt den Effekt auf halber Strecke (Debug data-ergebnis-effekte zaehlt je Art).
 * Dunkel und hell. T155: Zeile ohne Absender wird kein Knoten, Debug-Zaehler ohne_absender. Schalter fehler_effekte=0: kein Ergebnis-Effekt.
 * Screenshots: ui-screenshots/p22-t156/. */
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
const schema='p22_t156_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser'; // Fixture-Seite tests/agentennetzwerk.html zeigt dieses Projekt (privates Schema)
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;const fixtureRoot=await mkdtemp(join(tmpdir(),'synapse-p22-t156-'));
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw Error('Timeout: '+label);};
const ok=(value,label)=>{assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const belege={};
// Je Art: Zeile wie im echten Audit (Fehlerspalte bzw. success:false im Ergebnis) und Zeitpunkt der Aufnahme nach Effektbeginn.
const ARTEN=[
 {art:'falsch_aufgerufen',tool:'shell',action:'exec',ok:false,error:'unbekannter_parameter',result:{success:false,error:'unbekannter_parameter',unbekannte_parameter:['timeout']},nach:450},
 {art:'gesperrt',tool:'admin',action:'profil_aendern',ok:true,error:null,result:{success:false,error:'recht_fehlt'},nach:200},
 {art:'nicht_gefunden',tool:'thought',action:'get',ok:true,error:null,result:{success:false,thought:null,message:'Gedanke nicht gefunden',status:'nicht_gefunden'},nach:600},
 {art:'konflikt',tool:'files',action:'commit',ok:true,error:null,result:{success:false,error:'plan_failed'},nach:1100},
 {art:'serverfehler',tool:'intern',action:'status',ok:false,error:'interner_fehler',result:{success:false,error:'interner_fehler'},nach:450},
 {art:'wartet',tool:'shell',action:'exec',ok:true,error:null,result:{stufe:'rueckfrage',ausgefuehrt:false,error:'shell_rueckfrage'},nach:2500},
 {art:'sonstiges',tool:'reverse',action:'status',ok:true,error:null,result:{success:false,action:'status'},nach:450},
];
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
 await pool.query('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[P,fixtureRoot,'t156-fixture']);
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
 await app.register(specialistRoutes);await app.register(mcpRoutes);
 await registerAgentProfilRoutes(app,{validateToken:async t=>t==='p22-user'?{kind:'session',scope:null}:null});
 await app.ready();
 const ident=(id,name,rolle,modell,project=P)=>pool.query(
  "INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv,modell_selbstauskunft) VALUES($1,$2,$3,$3,$4,'aktiv','test',NOW(),$5)",[id,project,name,rolle,modell]);
 await ident('e56-main',C.HAUPTAGENT_AGENT_ID,'main','claude-test',C.HAUPTAGENT_PROJEKT);
 await ident('e56-nord','koordinator-nord','koordinator','claude-test');
 for(const name of ['claude-ui','codex-api'])await ident('e56-'+name,name,'subagent',name==='claude-ui'?'claude-test':'gpt-test');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:true,grund:'T156 private fixture'},{system:'user'});
 const einstellen=async(werte)=>{const r=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},payload:{netzwerk_werte:werte,grund:'T156 Browserabnahme'}});assert.equal(r.statusCode,200,r.body);return r.json();};
 // Effekte fuer die Aufnahme etwas laenger (Einstellungen live ueber den Katalog).
 await einstellen({abgleich_sekunden:3,fehler_effekt_ms:2500,wartet_halte_ms:9000});
 const snapshot=async()=>(await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'})).json();
 const zeile=(a,agent='claude-ui',iid='e56-claude-ui')=>pool.query(
  "INSERT INTO tool_calls(project,tool_name,action,source,args_preview,ok,error,result,ts,agent_id,identity_id) VALUES($1,$2,$3,'cloud',$4,$5,$6,$7,NOW(),$8,$9) RETURNING id",
  [P,a.tool,a.action,JSON.stringify({action:a.action}),a.ok,a.error,JSON.stringify(a.result),agent,iid]);
 // Grundaktivitaet: Koordinator und Arbeitsagenten sichtbar (erfolgreiche Aufrufe).
 for(const [agent,iid] of [['koordinator-nord','e56-nord'],['claude-ui','e56-claude-ui'],['codex-api','e56-codex-api']])
  await zeile({tool:'code_intel',action:'search',ok:true,error:null,result:{success:true,count:3}},agent,iid);
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const folder=join(repo,'ui-screenshots/p22-t156');await mkdir(folder,{recursive:true});
 const shot=async name=>{const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);await writeFile(join(folder,name),Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT ui-screenshots/p22-t156/'+name);};
 const zahl=()=>evaluate("JSON.parse(document.querySelector('canvas.nw-gl')?.dataset.ergebnisEffekte||'{}')");
 const refresh=()=>evaluate("document.dispatchEvent(new Event('visibilitychange'));true");
 const hell=on=>evaluate("(()=>{const r=document.getElementById('root');r.className="+(on?"'synapse-control'":"''")+";if("+(on?'true':'false')+"){r.dataset.theme='light';document.documentElement.style.background='#f4f2ee'}else{delete r.dataset.theme;document.documentElement.style.background=''}return true})()");
 tab=(await kb('/tabs/new',{url:ui+'/tests/agentennetzwerk.html'})).tab_id;
 await wait(()=>evaluate("!!document.querySelector('canvas.nw-gl')?.dataset.renderer"),'Netzwerk-Canvas');
 await sleep(1500);
 // Snapshot-Klassifikation je Art (API-Vertrag)
 for(const a of ARTEN)a.id=String((await zeile(a)).rows[0].id);
 const s=await snapshot();
 for(const a of ARTEN){const e=s.ereignisse.find(x=>x.id===a.id);ok(e&&e.ergebnis_art===a.art&&(e.fehler_code===null||/^[a-z][a-z0-9_]{1,39}$/.test(e.fehler_code)),'Snapshot: '+a.art+' ('+(e&&e.fehler_code)+')');}
 belege.snapshot=ARTEN.map(a=>{const e=s.ereignisse.find(x=>x.id===a.id);return {art:e?.ergebnis_art,code:e?.fehler_code};});
 await refresh();await sleep(4000+9000); // erste Welle (alle Arten gleichzeitig) abklingen lassen
 const lauf=async(modus,nr)=>{
  for(const a of ARTEN){
   const vorher=(await zahl())[a.art]??0;
   await zeile(a);await refresh();
   await wait(async()=>((await zahl())[a.art]??0)>vorher,modus+': Effekt '+a.art+' beginnt auf halber Strecke');
   await sleep(a.nach);await shot(String(nr++).padStart(2,'0')+'-'+modus+'-'+a.art.replaceAll('_','-')+'.png');
   ok(true,modus+': Effekt '+a.art+' gezeichnet');
   await sleep(a.art==='wartet'?9500:2600);
  }
  return nr;
 };
 let nr=await lauf('dunkel',1);
 await hell(true);await sleep(1500);
 nr=await lauf('hell',nr);
 await hell(false);
 // T155: Zeile ohne Absender -> kein Knoten, Zaehler ohne_absender
 await pool.query("INSERT INTO tool_calls(project,tool_name,action,source,args_preview,ok,error,ts) VALUES($1,'shell','exec','cloud','{\"action\":\"exec\",\"timeout\":5}',false,'unbekannter_parameter',NOW())",[P]);
 await refresh();await sleep(1200);
 const s2=await snapshot();
 ok(s2.ohne_absender>=1&&!s2.ereignisse.some(e=>!e.identity_id&&(e.agent==='cloud'||e.agent==='')),'T155: ohne Absender nur als Zaehler ('+s2.ohne_absender+')');
 const ohneCloud=await evaluate("fetch('/api/projects/"+P+"/agentennetzwerk').then(r=>r.json()).then(s=>{const g=window.p22szene(s,Date.now());return g.knoten.every(k=>!['cloud','stdio'].includes(String(k.name)))})");
 ok(ohneCloud===true,'T155: kein Knoten cloud/stdio im Canvas');
 // Schalter fehler_effekte=0: kein Ergebnis-Effekt (bisheriger roter Fehlerimpuls)
 await einstellen({fehler_effekte:0});await refresh();await sleep(3500);
 const z0=(await zahl()).gesperrt??0;await zeile(ARTEN[1]);await refresh();await sleep(4000);
 ok(((await zahl()).gesperrt??0)===z0,'Schalter fehler_effekte=0: kein Ergebnis-Effekt');
 await shot(String(nr++).padStart(2,'0')+'-dunkel-effekte-aus.png');
 await einstellen({fehler_effekte:1});
 belege.zaehler=await zahl();
 // P22-T162: Projektsonne bei stern_max_promille 2000 und vollen Dateien doppelt so gross; Grenzen 1000..2000.
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) SELECT 't162f'||g,$1,'f'||g||'.ts','f'||g||'.ts','ts' FROM generate_series(1,2000) g",[P]);
 const rand=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},payload:{netzwerk_werte:{stern_max_promille:2001},grund:'T162 Grenze'}});
 ok(rand.statusCode>=400||rand.json().success===false,'T162: stern_max_promille 2001 abgewiesen');
 await einstellen({stern_voll_dateien:2000,stern_max_promille:2000,index_cache_ms:1000,index_cache_schnell_ms:1000});
 await sleep(1200);await refresh();
 await wait(async()=>Number(await evaluate("document.querySelector('canvas.nw-gl')?.dataset.stern"))===2,'T162: Projektsonne bei 200 %',20000);
 ok(true,'T162: stern 2 bei vollen Dateien (stern_max_promille 2000)');
 await sleep(1500);await shot(String(nr++).padStart(2,'0')+'-dunkel-projektsonne-200.png');
 await hell(true);await sleep(1500);await shot(String(nr++).padStart(2,'0')+'-hell-projektsonne-200.png');await hell(false);
 await einstellen({stern_max_promille:1000});await sleep(1200);await refresh();
 await wait(async()=>Number(await evaluate("document.querySelector('canvas.nw-gl')?.dataset.stern"))===1,'T162: zurueck auf 100 %',20000);
 ok(true,'T162: Standard 1000 -> stern 1');
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,...belege},null,2));
 console.log('PASS P22-T156 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(fixtureRoot,{recursive:true,force:true});
}
process.exit(failure?1:0);
