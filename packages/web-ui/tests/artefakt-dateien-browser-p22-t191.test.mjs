/**
 * P22-T191: ArtefaktDateienPanel.tsx mit echten agent-profil REST/Core/PG-Diensten im KI-Browser.
 * Private Testdaten nur synapse_test:5433. Keine Produktfreigabe. Prüft AUS/EIN, Grenzen persistiert,
 * Validierungsfehler und echte API-Unterbrechung samt Erholung; Screenshots ui-screenshots/p22-t191.
 * Herkunft jeder Prüfung: P22-T191 ArtefaktDateienPanel.tsx -> agent-profil.ts -> artefakt-dateien.ts.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isolierterTab,evaluateWert} from '../../../scripts/lib/ki-browser-isolation.mjs';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'), req=createRequire(join(repo,'packages/web-ui/package.json'));
const {createServer}=await import(pathToFileURL(join(dirname(req.resolve('vite/package.json')),'dist/node/index.js')).href);
const db=new URL(process.env.DATABASE_URL||process.env.SYNAPSE_DATABASE_URL);
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const coreReq=createRequire(join(repo,'packages/core/package.json')), {Pool}=coreReq('pg');
const admin=new Pool({connectionString:db.href}),schema='p22_t191_browser_'+randomUUID().replaceAll('-','');
for(const n of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[n];
db.searchParams.set('options','-c search_path='+schema);
Object.assign(process.env,{DATABASE_URL:db.href,SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1'});
const KB=process.env.SYNAPSE_KI_BROWSER_URL||'http://192.168.50.65:9222',HOST=process.env.SYNAPSE_UI_TEST_HOST||'192.168.50.10';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
let C,app,vite,tab,checks=0,outage=false;
const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
const wait=async(script,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await ev('Boolean('+script+')'))return;await new Promise(r=>setTimeout(r,150));}throw Error('P22-T191 '+label+' erwartet=true ist='+await ev('document.body.innerText'));};
const ok=(v,label,actual)=>{if(!v)console.error('DEBUG P22-T191 ArtefaktDateienPanel.tsx '+label+' erwartet=true ist='+JSON.stringify(actual??v));assert.ok(v,label);checks++;console.log('OK P22-T191 '+label);};
const buttons="Array.from(document.querySelectorAll('button'))";
const button=t=>buttons+".find(e=>e.textContent==="+JSON.stringify(t)+")";
const click=script=>ev(script+'.click()');
const set=async(selector,value)=>ev("(()=>{const e="+selector+";Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,"+JSON.stringify(value)+");e.dispatchEvent(new Event('input',{bubbles:true}));})()");
const text="document.body.innerText";
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const t of ['auth_tokens','agent_identitaeten','agent_profil_schalter','runtime_ueberwachung_einstellungen','intern_schalter','agent_artifacts'])
  await admin.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 C=await import('../../core/dist/index.js');
 const pool=C.getPool();await pool.query(C.ARTEFAKT_DATEIEN_SCHEMA_SQL);
 const apiReq=createRequire(join(repo,'packages/rest-api/package.json')),Fastify=apiReq('fastify');
 const auth=await import('../../rest-api/dist/services/auth.js'),token=(await auth.issueSessionToken(null,600000)).token;
 app=Fastify({logger:false});
 app.addHook('onRequest',async(_req,reply)=>{if(outage)return reply.code(503).send({success:false,error:'T191_API_UNTERBROCHEN'});});
 const {agentProfilRoutes}=await import('../../rest-api/dist/routes/agent-profil.js');
 await app.register(agentProfilRoutes);await app.listen({host:'127.0.0.1',port:0});
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/artefakt-dateien.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:'http://127.0.0.1:'+app.server.address().port,headers:{authorization:'Bearer '+token}}}}});
 await vite.listen();
 const ablage=await screenshotAblage(repo,'p22-t191');
 const shot=async name=>{const r=await fetch(KB+'/screenshot?tab_id='+tab);assert.ok(r.ok);console.log('SCREENSHOT '+await ablage.speichere(name+'.png',Buffer.from(await r.arrayBuffer())));};
 tab=(await isolierterTab(kb,{url:'http://'+HOST+':'+vite.httpServer.address().port+'/tests/artefakt-dateien.html'})).tab_id;
 await wait(text+".includes('Artefakte wie Dateien: AUS')",'Standard geladen');
 ok(await ev(text+".includes('Große Antworten als Artefakt: AUS')"),'beide Schalter Standard AUS');
 ok(await ev(buttons+".filter(e=>e.textContent==='Einschalten').every(e=>e.disabled)"),'Grund erforderlich vor Schalten');
 const grund="Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes('Grund')).querySelector('input')";
 const max="Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes('Maximale Antwortgröße')).querySelector('input')";
 await shot('01-standard-aus');
 await set(grund,'P22-T191 isolierter Browserbeleg');
 await click(button('Einschalten'));await wait(text+".includes('Artefakte wie Dateien: EIN')",'Dateien EIN');
 await click(button('Einschalten'));await wait(text+".includes('Große Antworten als Artefakt: EIN')",'Überlauf EIN');
 const flags=(await pool.query('SELECT funktion,ebene,project,aktiv FROM agent_profil_schalter ORDER BY funktion')).rows;
 ok(flags.length===2&&flags.every(r=>r.aktiv&&r.ebene==='projekt'&&r.project==='p22-t191-browser'),'echte PG-Schalter nur Testprojekt',flags);
 await set(max,'26000');await click(button('Grenzen speichern'));await wait(text+".includes('Quelle: einstellung')",'PG-Grenzen gespeichert');
 ok((await pool.query("SELECT wert FROM artefakt_datei_einstellungen WHERE name='antwort_max_bytes'")).rows[0]?.wert===26000,'echte PG-Grenze 26000');
 await set(max,'30000');await click(button('Neu laden'));await wait(max+".value==='26000'",'Neuladen stellt gespeicherten Wert her');
 ok(await ev(max+".value==='26000'"),'Neuladen verwirft ungespeicherte Grenze');
 await shot('02-ein-und-persistiert');
 await set(max,'1');await click(button('Grenzen speichern'));await wait("document.querySelector('[role=alert]')?.textContent.includes('einstellung_ungueltig')",'Validierungsfehler');
 ok((await pool.query("SELECT wert FROM artefakt_datei_einstellungen WHERE name='antwort_max_bytes'")).rows[0]?.wert===26000,'ungültiger Wert verändert PG nicht');
 await click(button('Neu laden'));await wait("!document.querySelector('[role=alert]')",'Fehler erholt');
 outage=true;await click(button('Neu laden'));await wait("document.querySelector('[role=alert]')?.textContent.includes('T191_API_UNTERBROCHEN')",'API-Ausfall');
 ok(await ev(text+".includes('Artefakte wie Dateien: EIN')"),'Ausfall behält letzten Status und zeigt Fehler');
 await shot('03-api-fehler');
 outage=false;await click(button('Neu laden'));await wait("!document.querySelector('[role=alert]')",'API erholt');
 ok(await ev(max+".value==='26000'"),'API-Erholung stellt Werte her');
 for(let i=0;i<2;i++){await click(button('Ausschalten'));await wait(buttons+".filter(e=>e.textContent==='Ausschalten').length==="+(1-i),'Schalter AUS');}
 ok((await pool.query('SELECT count(*)::int n FROM agent_profil_schalter WHERE aktiv=true')).rows[0].n===0,'beide Testfreigaben am Ende AUS');
 await shot('04-erholt-aus');
 console.log('BESTANDEN '+checks+' P22-T191 KI-Browser-Prüfungen; echte REST/PG-Dienste. Tab wird geschlossen.');
}finally{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});await vite?.close();await app?.close();await C?.closePool();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
