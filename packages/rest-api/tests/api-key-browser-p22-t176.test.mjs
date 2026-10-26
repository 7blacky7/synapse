/** P22-T176: Browserabnahme 'API-Key hinterlegen' im KI-Browser (privates synapse_test-Schema, echte API-Routen, Fake-Keys, Fake-Anthropic).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-key-browser-p22-t176.test.mjs
 * Testseite web-ui/tests/api-budget.html (Fixture api-budget-fixture.tsx: ApiBudgetPanel wie Einstellungen > API-Agenten).
 * Sichert ab (Task P22-T176, User 26.10.2026 ~01:30):
 *   1 Schalter AUS: 'nein', kein Eingabefeld (ApiKeyFeld.tsx). 2 Grund + 'Eingabe einschalten' -> Passwortfeld.
 *   3 Fake-Key eintippen -> 'Key hinterlegen' -> 'ja', Quelle Web-UI, endet auf …xxxx; Feld leer; Wert nirgends in der Seite; PG nur Chiffre.
 *   4 'Key testen' -> gueltig (Fake-Anthropic GET /v1/models). 5 'Key entfernen' -> 'nein'. 6 hell: hinterlegter Key.
 *   Screenshots: ui-screenshots/p22-t176/<lauf-id>/*.png (P25-T7). Jedes Warten hat ein Zeitlimit.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ... | screenshot ...' (nie ein Key-Wert). */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer as httpServer} from 'node:http';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
import {isolierterTab} from '../../../scripts/lib/ki-browser-isolation.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','SYNAPSE_AGENT_TOKEN_SCHLUESSEL'])delete process.env[k];
const WEB_KEY='sk-ant-test-browser-'+randomBytes(12).toString('hex');
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'0',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1',SYNAPSE_AGENT_TOKEN_SCHLUESSEL:randomBytes(32).toString('hex')});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t176b_'+process.pid+'_'+randomUUID().slice(0,8);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,fake,tab,failure,checks=0,letzterShot='';
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const json=async script=>{const v=await evaluate(script);return typeof v==='string'?JSON.parse(v):v;};
const ohneKey=t=>!String(t).includes(WEB_KEY);
const kurz=v=>{let s;try{s=JSON.stringify(v);}catch{s=String(v);}return ohneKey(s)?s.slice(0,700):'<enthaelt Key - unterdrueckt>';};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
 console.error('DEBUG Timeout '+label+' | screenshot '+letzterShot+' | seitenfehler '+kurz(await json('JSON.stringify(window.__fehler??[])').catch(()=>'?')));throw Error('Timeout: '+label);};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert (ohne Key) und letztem Screenshot.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):'')+' | screenshot '+letzterShot);assert(value,label);console.log('OK '+label);};
const HF='P22-T176 ApiKeyFeld.tsx (KI-Browser)';
let fakeAnfragen=0;
try{
 fake=httpServer((req,res)=>{fakeAnfragen++;
  if(req.url.startsWith('/v1/models')&&req.headers['x-api-key']===WEB_KEY){res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({data:[{type:'model',id:'claude-fake-1',display_name:'Fake',created_at:'2026-01-01T00:00:00Z'}],has_more:false,first_id:'claude-fake-1',last_id:'claude-fake-1'}));return;}
  res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}}));
 });
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));process.env.ANTHROPIC_BASE_URL='http://127.0.0.1:'+fake.address().port;
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
 await pool.query(C.AGENT_API_BUDGET_SCHEMA_SQL);await pool.query(C.API_AGENT_SCHLUESSEL_SCHEMA_SQL);
 await pool.query('DELETE FROM api_agent_schluessel');await pool.query('DELETE FROM api_agent_budget');
 await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$1",[C.API_KEY_WEBUI_FUNKTION]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/api-budget.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t176'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/api-budget.html?token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(theme)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  await wait(async()=>!!(await evaluate("!!document.querySelector('[data-api-key-feld]')")),'Key-Feld geladen',30000);};
 const S_=JSON.stringify;
 const keyBlock=()=>json("(()=>{const k=document.querySelector('[data-api-key-vorhanden]');return JSON.stringify({wert:k.getAttribute('data-api-key-vorhanden'),text:k.innerText.replace(/\\s+/g,' ').trim()})})()");
 const feld=()=>json("(()=>{const f=document.querySelector('[data-api-key-feld]');const i=f.querySelector('input');return JSON.stringify({schalter:f.getAttribute('data-api-key-schalter'),input:i?{type:i.type,auto:i.autocomplete,leer:i.value===''}:null,"
  +"test:f.querySelector('[data-api-key-test]')?.innerText??'',debug:f.querySelector('[data-api-key-debug]')?.innerText??''})})()");
 const tippe=(sel,wert)=>evaluate("(()=>{const e=document.querySelector("+S_(sel)+");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,"+S_(wert)+");e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
 const knopf=text=>evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==="+S_(text)+");if(!b)return 'fehlt';if(b.disabled)return 'gesperrt';b.click();return 'ok'})()");

 // ================================================================ 1 Schalter AUS
 await oeffne('dark');
 let k=await keyBlock(),f=await feld();
 ok(k.wert==='nein'&&f.schalter==='aus'&&f.input===null&&/schalter=AUS/.test(f.debug),HF+': Schalter AUS -> nein, kein Eingabefeld, Debugzeile',{k,f});
 await shot('dunkel-schalter-aus');

 // ================================================================ 2 Eingabe einschalten
 ok((await knopf('Eingabe einschalten'))==='gesperrt',HF+': ohne Grund kein Einschalten');
 await tippe('input[placeholder^="z. B. Tageslimit"]','Key in der Web-UI hinterlegen T176');
 ok((await knopf('Eingabe einschalten'))==='ok',HF+': Eingabe einschalten');
 await wait(async()=>(await feld()).schalter==='ein','Schalter EIN');
 f=await feld();
 ok(f.input&&f.input.type==='password'&&f.input.auto==='new-password'&&f.input.leer,HF+': Passwortfeld ohne Autofill erscheint',f);

 // ================================================================ 3 Fake-Key hinterlegen
 ok((await knopf('Key hinterlegen'))==='gesperrt',HF+': leeres Feld -> Hinterlegen gesperrt');
 await tippe('[data-api-key-feld] input[type=password]',WEB_KEY);
 ok((await knopf('Key hinterlegen'))==='ok',HF+': Key hinterlegen ausloesbar');
 await wait(async()=>(await keyBlock()).wert==='ja','Key hinterlegt');
 k=await keyBlock();f=await feld();
 ok(/Quelle: Web-UI \(verschlüsselt auf dem Server\)/.test(k.text)&&k.text.includes('endet auf …'+WEB_KEY.slice(-4))&&/gesetzt am /.test(k.text)&&f.input?.leer,HF+': ja, Quelle Web-UI, gesetzt am, letzte 4; Feld wieder leer',{k,f});
 const seite=await evaluate('document.documentElement.outerHTML');
 const row=(await pool.query('SELECT chiffre FROM api_agent_schluessel WHERE id=1')).rows[0];
 ok(ohneKey(seite)&&row&&row.chiffre.startsWith('v1:')&&ohneKey(row.chiffre),'P22-T176 Seite + api_agent_schluessel (KI-Browser): Wert weder in der Seite noch im Klartext in PG',{seite:seite.length,v1:row?.chiffre.startsWith('v1:')});
 await shot('dunkel-key-hinterlegt');

 // ================================================================ 4 Key testen
 ok((await knopf('Key testen'))==='ok',HF+': Key testen');
 await wait(async()=>/Key gültig/.test((await feld()).test),'Testergebnis');
 f=await feld();
 ok(/^Key gültig \(Quelle Web-UI, \d+ ms, ohne Token-Verbrauch\)\.$/.test(f.test)&&fakeAnfragen>=1,HF+': Key testen -> gueltig (GET /v1/models am Fake-Anbieter)',f.test);
 await shot('dunkel-key-getestet');

 // ================================================================ 5 Key entfernen
 ok((await knopf('Key entfernen'))==='ok',HF+': Key entfernen');
 await wait(async()=>(await keyBlock()).wert==='nein','Key entfernt');
 ok((await pool.query('SELECT count(*)::int n FROM api_agent_schluessel')).rows[0].n===0&&/Trage den Key unten ein/.test((await keyBlock()).text),HF+': entfernt, ohne Env -> nein mit Hinweis aufs Eingabefeld');
 const seitenfehler=await json('JSON.stringify(window.__fehler??[])');
 ok(seitenfehler.length===0,'P22-T176 Testseite (KI-Browser): keine Seitenfehler',seitenfehler);

 // ================================================================ 6 hell (Key ueber die echte Route hinterlegt)
 const p=await fetch(api+'/api/main-agent/api/key',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+sitzung},body:JSON.stringify({key:WEB_KEY,grund:'T176 helle Darstellung'})});
 ok(p.status===200&&ohneKey(await p.text()),'P22-T176 agent-api.ts PUT /api/main-agent/api/key: Antwort ohne Wert');
 await oeffne('light');
 await wait(async()=>(await keyBlock()).wert==='ja','hell: Key vorhanden');
 await shot('hell-key-hinterlegt');
 ok(true,HF+': helle Darstellung (Screenshot)');

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,key:'nur Fake-Key, nie angezeigt'},null,2));
 console.log('PASS P22-T176 API-Key Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(ohneKey(e?.stack??e)?e:'Fehler (Text enthielt Key, unterdrueckt)');}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();fake?.close();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
