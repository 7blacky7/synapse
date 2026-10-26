/** P22-T173: Browserabnahme Knopf 'Umbenennen …' (Einstellungen > Agenten-Ausweis) im KI-Browser (privates synapse_test-Schema,
 * echte API in diesem Prozess, kein Deploy, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/identitaet-umbenennen-browser-p22-t173.test.mjs
 * Testseite web-ui/tests/identitaet-umbenennen.html (Fixture identitaet-umbenennen-fixture.tsx: echtes AusweisIdentitaetenPanel).
 * Sichert ab (Task P22-T173, User 26.10.2026 'Name aendern, Ausweis-ID bleibt'; Ergebnis thought 708f5e02):
 *   1 Schalter agent_umbenennung AUS: Knopf vorhanden, Umbenennen endet mit Fehlermeldung 'ausgeschaltet', nichts umbenannt
 *     (AusweisIdentitaetenPanel.tsx umbenennen, ausweis-verwaltung.ts FEHLERTEXT funktion_aus, agent-profil-admin.ts GRUPPE).
 *   2 Schalter EIN: Umbenennen einer Test-Identitaet -> Meldung, neuer Name in Liste und Titel, 'Fruehere Namen' zeigt den alten
 *     (agent-umbenennung.ts benenneIdentitaetUm, agent-profil-admin.ts leseIdentitaetDetail aliase); alter Name als Alias auffindbar
 *     (agent-bezug.ts loeseAgentFilter), identity_id und Ausweis unveraendert.
 *   3 dunkel und hell. Jedes Warten hat ein Zeitlimit. Screenshots: ui-screenshots/p22-t173/<lauf-id>/*.png (P25-T7).
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich ... | screenshot ...'. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
// Ausweis-Kern braucht agent_bezug_modus 'beide' (agent-profil-schalter.ts leseAusweisKern), sonst antwortet die Verwaltung funktion_aus.
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',
 DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t173b_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t173-browser';
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
const Z=randomUUID(),K=randomUUID(),ALT='t173b-alt',NEU='t173b-neu';
const HP='P22-T173 AusweisIdentitaetenPanel.tsx umbenennen (KI-Browser)';
const HA='P22-T173 agent-umbenennung.ts benenneIdentitaetUm';
// Helfer im Browser: React-Eingabe setzen (nativer Setter + input-Ereignis), Knopf nach Text klicken.
const JS_HELFER="window.__setze=(el,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};"
 +"window.__knopf=(t)=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);true";
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
 // Identitaets-/Profil-/Ausweis-Schemata und 126/129/159 (synapse_test public kennt 159 noch nicht).
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-entfernung-schema','agent-namens-alias-schema']){
  const m=await load('packages/core/dist/db/'+file+'.js');
  for(const sql of Object.values(m).filter(v=>typeof v==='string'))await pool.query(sql);
 }
 const BEZUG=await load('packages/core/dist/services/agent-bezug.js');
 const USER={art:'user'};
 const adm=(a,args)=>C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus(a,{project:P,...args},{akteur:USER}));
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$3,$4,1,$4,'subagent','aktiv','t173'),($2,$3,'t173b-koord',1,'t173b-koord','koordinator','aktiv','t173')`,[Z,K,P,ALT]);
 const ein=await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Test T173 Browser alle ein'});
 ok(ein.success===true,'P22-T173 agent-profil-admin.ts profil_schalter_setzen: Verwaltung (alle) EIN',ein);
 const umbSchalter=async aktiv=>{const r=await adm('profil_schalter_setzen',{profil_funktion:'agent_umbenennung',aktiv,grund:'Test T173 Browser Schalter'});
  ok(r.success===true,'P22-T173 agent-profil-schalter.ts agent_umbenennung '+(aktiv?'EIN':'AUS'),r);};
 const zeile=async()=>(await pool.query('SELECT id,agent_id,name,status FROM agent_identitaeten WHERE id=$1',[Z])).rows[0];

 const auth=await load('packages/rest-api/dist/services/auth.js');
 const AP=await load('packages/rest-api/dist/routes/agent-profil.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(AP.agentProfilRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/identitaet-umbenennen.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t173/<lauf-id>/, nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t173'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/identitaet-umbenennen.html?project='+P+'&token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(theme)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  await wait(async()=>(await evaluate("document.querySelectorAll('.av-zeile').length"))>=2,'Identitaetenliste gerendert',40000);
  await evaluate(JS_HELFER);};
 const waehle=async name=>{await evaluate("[...document.querySelectorAll('.av-zeile')].find(z=>z.querySelector('strong')?.textContent.startsWith("+JSON.stringify(name)+"))?.click()");
  await wait(async()=>(await evaluate("document.querySelector('.av-titel h4')?.textContent??''"))===name,'Detail '+name);};
 const grund=()=>evaluate("window.__setze(document.querySelector('.av-grund input'),'Test T173 Browserabnahme');true");
 const frageOeffnen=async name=>{await evaluate("window.__knopf('Umbenennen …').click()");
  await wait(async()=>!!(await evaluate("!![...document.querySelectorAll('.av-frage b')].find(b=>b.textContent==='Identitaet umbenennen?')")),'Rueckfrage Umbenennen');
  await evaluate("window.__setze(document.querySelector('.av-frage input'),"+JSON.stringify(name)+");true");};
 const meldung=()=>json("JSON.stringify({fehler:document.querySelector('.av-fehler')?.innerText??'',meldung:document.querySelector('.av-meldung')?.innerText??''})");
 const fruehere=()=>evaluate("[...document.querySelectorAll('.av-fakten div')].find(d=>d.querySelector('dt')?.textContent==='Fruehere Namen')?.querySelector('dd')?.textContent??''");

 // ================================================================ 1 Schalter AUS: Fehlermeldung, nichts umbenannt (Standard laut Task: Schalter + Debug)
 await umbSchalter(false);
 await oeffne('dark');
 await waehle(ALT);await grund();
 ok(!(await evaluate("window.__knopf('Umbenennen …').disabled")),HP+': Knopf Umbenennen sichtbar und mit Grund bedienbar');
 await frageOeffnen(NEU);
 await shot('dunkel-rueckfrage');
 await evaluate("window.__knopf('Ja, umbenennen').click()");
 await wait(async()=>(await meldung()).fehler!=='','Fehlermeldung bei Schalter AUS');
 const m1=await meldung();
 ok(/ausgeschaltet/i.test(m1.fehler)&&/HTTP 409/.test(m1.fehler),HP+': Schalter AUS -> Fehlermeldung funktion_aus (ausweis-verwaltung.ts FEHLERTEXT)',m1);
 ok((await zeile()).agent_id===ALT,HA+': Schalter AUS -> nichts umbenannt',await zeile());
 await shot('dunkel-schalter-aus-fehler');

 // ================================================================ 2 Schalter EIN: Umbenennen, neuer Name im Panel, alter als Alias
 await umbSchalter(true);
 const tokVor=(await pool.query('SELECT count(*)::int AS n FROM agent_identitaet_tokens WHERE identity_id=$1',[Z])).rows[0].n;
 await evaluate("window.__knopf('Ja, umbenennen').click()");
 await wait(async()=>/Umbenannt/.test((await meldung()).meldung),'Meldung Umbenannt',30000);
 const m2=await meldung();
 ok(m2.meldung.includes('Umbenannt: '+ALT+' -> '+NEU)&&m2.fehler==='',HP+': Meldung nennt alt -> neu',m2);
 await wait(async()=>(await evaluate("document.querySelector('.av-titel h4')?.textContent??''"))===NEU,'Titel mit neuem Namen');
 const liste=await evaluate("[...document.querySelectorAll('.av-zeile strong')].map(s=>s.firstChild?.textContent??s.textContent).join('|')");
 ok(liste.split('|').includes(NEU)&&!liste.split('|').includes(ALT),HP+': Liste zeigt den neuen Namen, nicht mehr den alten',liste);
 const fr=await fruehere();
 ok(fr.includes(ALT),'P22-T173 AusweisIdentitaetenPanel.tsx Fruehere Namen (KI-Browser): alter Name als Alias sichtbar',fr);
 const z=await zeile();
 ok(z.id===Z&&z.agent_id===NEU&&z.name===NEU&&z.status==='aktiv',HA+': identity_id bleibt, agent_id/name neu',z);
 ok((await pool.query('SELECT count(*)::int AS n FROM agent_identitaet_tokens WHERE identity_id=$1',[Z])).rows[0].n===tokVor,HA+': Ausweiszeilen unveraendert');
 const f=await BEZUG.loeseAgentFilter(P,[ALT]);
 ok(f.identity_ids.includes(Z),'P22-T173 agent-bezug.ts loeseAgentFilter: alter Name findet die umbenannte Identitaet (Alias)',f);
 await shot('dunkel-umbenannt');

 // ================================================================ 3 hell: Detail mit frueherem Namen und Rueckfrage
 await oeffne('light');
 await waehle(NEU);await grund();
 ok((await fruehere()).includes(ALT),'P22-T173 AusweisIdentitaetenPanel.tsx Fruehere Namen (KI-Browser, hell)');
 await shot('hell-umbenannt');
 await frageOeffnen('t173b-weiter');
 await shot('hell-rueckfrage');
 const fehler=await json('JSON.stringify(window.__fehler??[])');
 console.log('SEITENFEHLER '+kurz(fehler));

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,identity_id:Z,alt:ALT,neu:NEU,seitenfehler:fehler,schalter:'Produkt-Schalter agent_umbenennung (privates Schema)'},null,2));
 console.log('PASS P22-T173 Umbenennen Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
