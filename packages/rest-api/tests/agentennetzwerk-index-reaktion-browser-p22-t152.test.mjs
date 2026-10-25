/** P22-T152: Browserabnahme der Index-Reaktion im KI-Browser (privates synapse_test-Schema, echte API, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agentennetzwerk-index-reaktion-browser-p22-t152.test.mjs
 * Prueft im echten Canvas (dunkel und hell): Ruhe ohne Aenderung, neue Nebelpunkte leuchten (genau die neuen), Aenderung ohne neuen Punkt
 * als Impuls, neue Trabanten leuchten, Trabanten-Impuls, Rueckgang verglimmt, Abklingen zurueck in die Ruhe, adaptiver Index-Cache.
 * Bildfolge: ui-screenshots/p22-t152/. */
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
const schema='p22_t152_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser'; // Projektname fest in tests/agentennetzwerk-fixture.tsx (privates Schema, keine Ueberschneidung)
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;const fixtureRoot=await mkdtemp(join(tmpdir(),'synapse-p22-t152-'));
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const wait=async(fn,label,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);};
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
 await pool.query('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[P,fixtureRoot,'t152-fixture']);
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
 const {vergissIndexGroesse,indexCacheDauer}=await load('packages/rest-api/dist/services/agentennetzwerk.js');
 await app.register(specialistRoutes);await app.register(mcpRoutes);
 await registerAgentProfilRoutes(app,{validateToken:async t=>t==='p22-user'?{kind:'session',scope:null}:null});
 await app.ready();
 const ident=(id,name,rolle,modell,project=P)=>pool.query(
  "INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv,modell_selbstauskunft) VALUES($1,$2,$3,$3,$4,'aktiv','test',NOW(),$5)",[id,project,name,rolle,modell]);
 await ident('t152-main',C.HAUPTAGENT_AGENT_ID,'main','claude-test',C.HAUPTAGENT_PROJEKT);
 await ident('t152-nord','koordinator-nord','koordinator','claude-test');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv:true,grund:'T152 private fixture'},{system:'user'});
 const r0=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},payload:{netzwerk_werte:{abgleich_sekunden:3},grund:'T152 Browserabnahme'}});
 assert.equal(r0.statusCode,200,r0.body);
 // Index setzen (nur Zaehlungen zaehlen) und den Cache vergessen, damit der naechste Snapshot die neue Zahl sofort traegt.
 const index=async(dateien,chunks)=>{
  await pool.query('DELETE FROM code_files WHERE project=$1',[P]);await pool.query('DELETE FROM code_chunks WHERE project=$1',[P]);
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) SELECT 't152f'||g,$1,'f'||g||'.ts','f'||g||'.ts','ts' FROM generate_series(1,$2::int) g",[P,dateien]);
  await pool.query("INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) SELECT 't152c'||g,$1,'f1.ts',g,'x',1,1 FROM generate_series(1,$2::int) g",[P,chunks]);
  vergissIndexGroesse(P);
 };
 await index(2000,22300);
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const folder=join(repo,'ui-screenshots/p22-t152');await mkdir(folder,{recursive:true});
 const shot=async name=>{const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);await writeFile(join(folder,name),Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT ui-screenshots/p22-t152/'+name);};
 const ds=()=>evaluate("(()=>{const d=document.querySelector('canvas.nw-gl')?.dataset||{};const z=k=>Number(d[k]||0);return {trabanten:z('trabanten'),nebel:z('nebelPunkte'),nr:d.nebelReaktion,ng:z('nebelGlanz'),ni:z('nebelImpulse'),nn:z('nebelNeu'),nw:z('nebelWeg'),tr:d.trabantenReaktion,tg:z('trabantenGlanz'),ti:z('trabantenImpulse'),tn:z('trabantenNeu'),stand:d.indexStand,fps:z('fps'),frameMs:z('frameMs'),qualitaet:z('qualitaet')}})()");
 const refresh=()=>evaluate("document.dispatchEvent(new Event('visibilitychange'));true");
 const hell=on=>evaluate("(()=>{const r=document.getElementById('root');r.className=" + (on?"'synapse-control'":"''") + ";if(" + (on?'true':'false') + "){r.dataset.theme='light';document.documentElement.style.background='#f4f2ee'}else{delete r.dataset.theme;document.documentElement.style.background=''}return true})()");
 const aendern=async(dateien,chunks)=>{await index(dateien,chunks);await refresh();await wait(async()=>(await ds()).stand===dateien+'/'+chunks,'Index '+dateien+'/'+chunks+' im Canvas');};
 tab=(await kb('/tabs/new',{url:ui+'/tests/agentennetzwerk.html'})).tab_id;
 await wait(()=>evaluate("!!document.querySelector('canvas.nw-gl')?.dataset.renderer"),'Netzwerk-Canvas');
 await wait(async()=>(await ds()).stand==='2000/22300','erster Index im Canvas');
 let d=await ds();belege.start=d;
 ok(d.nr==='ruhe'&&d.ng===0&&d.ni===0&&d.tr==='ruhe','Erster Snapshot: Ruhe (kein Feuerwerk beim Oeffnen)');
 ok(indexCacheDauer(P)===10000,'Index-Cache je Projekt: billige Zaehlung -> 10 s');
 await sleep(2000);await shot('01-dunkel-ruhe.png');

 // 1 Neue Nebelpunkte: 22.300 -> 22.800 = genau 5 neue Punkte (223..227) leuchten
 await aendern(2000,22800);await sleep(250);
 d=await ds();belege.neu=d;
 ok(d.nr==='neu'&&d.nn===5&&d.ng===5&&d.nebel===228,'5 neue Nebelpunkte leuchten (genau die neuen): '+JSON.stringify({nn:d.nn,ng:d.ng,nebel:d.nebel}));
 ok(d.tr==='ruhe'&&d.tg===0,'Trabanten bleiben ruhig (Dateien unveraendert)');
 await shot('02-dunkel-neue-nebelpunkte.png');
 await wait(async()=>(await ds()).ng===0,'Glanz klingt ab',8000);
 ok(true,'nach dem Abklingen keine Leuchtpunkte mehr (Ruhe)');

 // 2 Aenderung ohne neuen Punkt: 22.800 -> 22.850 = Impuls
 await aendern(2000,22850);await sleep(600);
 d=await ds();belege.impuls=d;
 ok(d.nr==='impuls'&&d.ni===1&&d.ng===0,'Chunks innerhalb der Stufe: Impuls durch den Nebel, kein neuer Punkt');
 await shot('03-dunkel-nebel-impuls.png');

 // 3 Neue Trabanten: 2.000 -> 2.300 Dateien = 3 neue
 await sleep(2500);await aendern(2300,22850);await sleep(250);
 d=await ds();belege.trabanten=d;
 ok(d.tr==='neu'&&d.tn===3&&d.tg===3&&d.trabanten===23,'3 neue Trabanten leuchten an ihrer Bahnposition');
 ok(d.ni===1,'Nebel unveraendert (kein weiterer Impuls)');
 await shot('04-dunkel-neue-trabanten.png');

 // 4 Trabanten-Impuls: 2.300 -> 2.350
 await sleep(2500);await aendern(2350,22850);await sleep(400);
 d=await ds();
 ok(d.tr==='impuls'&&d.ti===1,'Dateien innerhalb der Stufe: Impuls am Stern');
 await shot('05-dunkel-trabanten-impuls.png');

 // 5 Rueckgang: 22.850 -> 22.650 = 2 Punkte verglimmen
 await sleep(2500);await aendern(2350,22650);await sleep(200);
 d=await ds();
 ok(d.nr==='weg'&&d.nw===2&&d.nebel===226,'Rueckgang: 2 wegfallende Punkte verglimmen');
 await shot('06-dunkel-verglimmen.png');

 // 6 Ruhe: ohne Aenderung bleibt alles still (mehrere Snapshots)
 await sleep(5000);const vorRuhe=await ds();await refresh();await sleep(1500);await refresh();await sleep(1500);
 d=await ds();
 ok(d.ni===vorRuhe.ni&&d.nn===vorRuhe.nn&&d.nw===vorRuhe.nw&&d.ti===vorRuhe.ti&&d.ng===0&&d.tg===0,'Ruhe: neue Snapshots ohne Aenderung loesen nichts aus');
 ok(d.qualitaet===0,'volle Qualitaetsstufe ('+d.fps+' FPS, '+d.frameMs+' ms)');

 // 7 Hell (Tinte auf Papier)
 await hell(true);await sleep(1200);
 // Erster Frame im hellen Design zeichnet die Nebelebene neu: auf den Glanz warten statt fester Pause (Lauf 14:48 einmal zu frueh gelesen).
 await aendern(2350,23150);await wait(async()=>(await ds()).ng===5,'hell: Glanz der neuen Punkte',3000).catch(()=>{});
 d=await ds();
 ok(d.nr==='neu'&&d.ng===5,'hell: 5 neue Nebelpunkte leuchten '+JSON.stringify(d));
 await shot('07-hell-neue-nebelpunkte.png');
 await sleep(2500);await aendern(2350,23180);await sleep(600);
 ok((await ds()).nr==='impuls','hell: Impuls');
 await shot('08-hell-nebel-impuls.png');
 await sleep(2500);await aendern(2650,23180);await sleep(250);
 ok((await ds()).tg===3,'hell: 3 neue Trabanten');
 await shot('09-hell-neue-trabanten.png');
 await hell(false);
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,...belege},null,2));
 console.log('PASS P22-T152 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();await rm(fixtureRoot,{recursive:true,force:true});
}
process.exit(failure?1:0);
