/** P22-T270: Browserabnahme Agententeam-Suche mit „Ausweis erstellen“ und Ausweis-Fenster (Bearbeiten, Channel-Icon) im KI-Browser
 * (privates synapse_test-Schema, echte API-Routen in diesem Prozess, kein Deploy, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agententeam-suche-browser-p22-t270.test.mjs
 * Testseite web-ui/tests/agententeam-suche.html (Fixture agententeam-suche-fixture.tsx: echte AgentenTeamSuche + AusweisFenster).
 * Herkunft: User thought 9ddef22c + 7b25b0c1, Task P22-T270. Sichert ab:
 *   1 Suche: erster Eintrag „Ausweis erstellen“, danach die Agenten des Projekts (GET agenten-team, specialists.ts); Filter.
 *   2 Fenster: Klick oeffnet den Ausweis im Fenster mit Ausweis-Karte und Fakten (AusweisFenster.tsx AusweisAnsicht).
 *   3 Bearbeiten: Felder hinzufuegen (Briefing, Modell) und speichern -> Profil in PG (agent-profil-admin profil_aendern).
 *   4 Channel-Icon: Channel zuweisen und wieder entziehen -> Profilfeld channels in PG.
 *   5 Ausweis erstellen: Anlege-Modus legt die Identitaet an (agent_vorbereiten) und zeigt danach ihren Ausweis im Fenster.
 *   6 dunkel und hell. Jedes Warten hat ein Zeitlimit. Screenshots: ui-screenshots/p22-t270/<lauf-id>/*.png (P25-T7).
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
// Wie P22-T173: Ausweis-Kern braucht agent_bezug_modus 'beide', sonst antwortet die Verwaltung funktion_aus.
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',
 DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t270_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t270-browser';
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
const Z=randomUUID(),K=randomUUID(),ALPHA='t270-alpha',KOORD='t270-koord',NEU='t270-neu',CH='t270-team',CH2='t270-review';
const HS='P22-T270 AgentenTeamSuche.tsx (KI-Browser)',HF='P22-T270 AusweisFenster.tsx (KI-Browser)';
// Helfer im Browser: React-Eingaben setzen (nativer Setter + input/change), Knopf nach Text klicken.
const JS_HELFER="window.__setze=(el,v)=>{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;"
 +"Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));};"
 +"window.__knopf=(t,wurzel=document)=>[...wurzel.querySelectorAll('button')].find(b=>b.textContent.trim()===t);"
 +"window.__fenster=(name)=>[...document.querySelectorAll('.ausweis-fenster')].find(f=>(f.getAttribute('aria-label')||'').startsWith(name));true";
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-entfernung-schema','agent-namens-alias-schema']){
  const m=await load('packages/core/dist/db/'+file+'.js');
  for(const sql of Object.values(m).filter(v=>typeof v==='string'))await pool.query(sql);
 }
 const USER={art:'user'};
 const adm=(a,args)=>C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus(a,{project:P,...args},{akteur:USER}));
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$3,$4,1,$4,'subagent','aktiv','t270'),($2,$3,$5,1,$5,'koordinator','aktiv','t270')`,[Z,K,P,ALPHA,KOORD]);
 await C.createChannel(P,CH,'Team-Channel der Testseite','t270');
 await C.createChannel(P,CH2,'Review-Channel der Testseite','t270');
 const ein=await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Test T270 Browser alle ein'});
 ok(ein.success===true,'P22-T270 agent-profil-admin.ts profil_schalter_setzen: Verwaltung (alle) EIN',ein);
 const tz=await adm('profil_schalter_setzen',{profil_funktion:'team_ausweis_zeigen',aktiv:true,grund:'Test T270 Ausweis-Karte'});
 ok(tz.success===true,'P22-T270 agent-profil-schalter.ts team_ausweis_zeigen EIN (Ausweis-Karte im Fenster)',tz);
 const profil=async id=>JSON.stringify(await adm('profil_lesen',{ziel_identity_id:id}));

 const auth=await load('packages/rest-api/dist/services/auth.js');
 const AP=await load('packages/rest-api/dist/routes/agent-profil.js');
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(AP.agentProfilRoutes);await app.register(specialistRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/agententeam-suche.html']},server:{host:'0.0.0.0',port:0,hmr:false,watch:{ignored:['**/*']},proxy:{'/api':{target:api}}}});
 // Browserlauf 2: Commits anderer Agenten im Repo loesten ein Neuladen der Testseite aus (Fensterzustand und Helfer weg) - darum ohne HMR/Watch.
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t270'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{await new Promise(r=>setTimeout(r,350));const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(theme='dark')=>ui+'/tests/agententeam-suche.html?project='+P+'&token='+encodeURIComponent(sitzung)+'&theme='+theme;
 const oeffne=async theme=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(theme)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  await wait(async()=>!!(await evaluate("!!document.querySelector('[data-agententeam-knopf] b')")),'Knopf Agententeam mit Zahl',40000);
  await evaluate(JS_HELFER);};
 const sucheOeffnen=async()=>{await evaluate("document.querySelector('[data-agententeam-knopf]').click();true");
  await wait(async()=>(await evaluate("document.querySelectorAll('.agententeam-suche .channel-suche-liste>button').length"))>=3,'Suche mit Eintraegen');};
 const treffer=()=>json("JSON.stringify([...document.querySelectorAll('.agententeam-suche .channel-suche-liste>button')].map(b=>b.querySelector('strong')?.textContent.trim()))");
 const agentOeffnen=async name=>{await evaluate("[...document.querySelectorAll('.agententeam-suche .channel-suche-liste>button')].find(b=>b.querySelector('strong')?.textContent.trim()==="+JSON.stringify(name)+").click();true");
  await wait(async()=>(await evaluate("window.__fenster("+JSON.stringify('Ausweis '+name)+")?.querySelector('.ausweis-fenster-inhalt')?.dataset.profil??''"))==='bereit','Fenster '+name+' mit Profil',30000);};
 const imFenster=(name,js)=>evaluate("(()=>{if(!window.__fenster)return 'seite-neu-geladen';const f=window.__fenster("+JSON.stringify('Ausweis '+name)+");if(!f)return 'kein-fenster';"+js+"})()");
 const meldung=name=>json("JSON.stringify((()=>{const f=window.__fenster("+JSON.stringify('Ausweis '+name)+");return {meldung:f?.querySelector('.af-meldung')?.innerText??'',fehler:[...(f?.querySelectorAll('.af-fehler')??[])].map(x=>x.innerText).join(' | ')};})())");

 // ================================================================ 1 Suche (dunkel)
 await oeffne('dark');
 await sucheOeffnen();
 let t=await treffer();
 ok(t[0]==='+Ausweis erstellen',HS+': erster Eintrag ist „Ausweis erstellen“',t);
 ok(t.includes(ALPHA)&&t.includes(KOORD),HS+': danach die Projektagenten aus agenten-team',t);
 await shot('dunkel-suche');
 await evaluate("window.__setze(document.querySelector('.agententeam-suche input'),'koord');true");
 await wait(async()=>(await treffer()).length===2,'Filter koord');
 t=await treffer();
 ok(t[0]==='+Ausweis erstellen'&&t[1]===KOORD,HS+': Filter laesst „Ausweis erstellen“ oben stehen',t);
 await evaluate("window.__setze(document.querySelector('.agententeam-suche input'),'');true");

 // ================================================================ 2 Fenster
 await agentOeffnen(ALPHA);
 ok(!(await evaluate("!!document.querySelector('.agententeam-suche')")),HS+': Suche schliesst nach der Wahl');
 const inhalt=await imFenster(ALPHA,"return JSON.stringify({karte:!!f.querySelector('.team-ausweis'),fakten:f.querySelectorAll('.af-fakten>div').length,name:f.querySelector('.af-name')?.textContent??'',projekt:f.querySelector('.channel-eigenfenster-projekt')?.textContent??''})");
 const iv=typeof inhalt==='string'?JSON.parse(inhalt):inhalt;
 ok(iv.karte&&iv.fakten>=12&&iv.name.startsWith(ALPHA)&&iv.projekt===P,HF+': Ausweis-Karte, Fakten wie rechts auf der Agententeam-Seite, Projekt im Kopf',iv);
 await shot('dunkel-fenster');

 // ================================================================ 3 Bearbeiten: Felder hinzufuegen und speichern
 await imFenster(ALPHA,"window.__knopf('Bearbeiten',f).click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return !!f.querySelector('.af-editor')"))===true,'Editor offen');
 const feldHinzu=async(schluessel,wert)=>{
  await imFenster(ALPHA,"window.__setze(f.querySelector('.af-hinzufuegen select'),"+JSON.stringify(schluessel)+");return true");
  await imFenster(ALPHA,"window.__knopf('+ Feld hinzufügen',f).click();return true");
  await wait(async()=>(await imFenster(ALPHA,"return !!f.querySelector('[data-feld=\""+schluessel+"\"] :is(input,textarea)')"))===true,'Feld '+schluessel);
  await imFenster(ALPHA,"window.__setze(f.querySelector('[data-feld=\""+schluessel+"\"] :is(input,textarea)'),"+JSON.stringify(wert)+");return true");};
 await feldHinzu('briefing','T270 Briefing aus dem Ausweis-Fenster');
 await feldHinzu('modell','opus');
 ok((await imFenster(ALPHA,"return window.__knopf('Speichern (2)',f)?'ja':'nein'"))==='ja',HF+': Speichern zaehlt 2 geaenderte Felder');
 await shot('dunkel-bearbeiten');
 await imFenster(ALPHA,"window.__knopf('Speichern (2)',f).click();return true");
 await wait(async()=>/Ausweis gespeichert/.test((await meldung(ALPHA)).meldung)||(await meldung(ALPHA)).fehler!=='','Speichern beendet',30000);
 const m1=await meldung(ALPHA);
 ok(/Ausweis gespeichert/.test(m1.meldung)&&m1.fehler==='',HF+': Meldung nach dem Speichern',m1);
 const p1=await profil(Z);
 ok(p1.includes('T270 Briefing aus dem Ausweis-Fenster')&&p1.includes('"opus"'),'P22-T270 agent-profil-admin.ts profil_lesen: Briefing und Modell im Profil (PG)',p1);
 await wait(async()=>/T270 Briefing/.test(await imFenster(ALPHA,"return f.querySelector('.af-profil')?.innerText??''")),'Ausweis-Felder zeigen den neuen Stand');
 const felder=String(await imFenster(ALPHA,"return f.querySelector('.af-profil')?.innerText??''"));
 ok(/T270 Briefing/.test(felder)&&/opus/.test(felder),HF+': Abschnitt Ausweis-Felder zeigt Briefing und Modell (modell_bestaetigt als Rueckfall)',felder);

 // ================================================================ 4 Channel-Icon: zuweisen, entziehen, zuweisen
 await imFenster(ALPHA,"f.querySelector('.af-channel-icon').click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return f.querySelectorAll('.af-channel').length"))>=2,'Channel-Liste');
 const klickChannel=async name=>{await imFenster(ALPHA,"[...f.querySelectorAll('.af-channel')].find(b=>b.querySelector('strong')?.textContent==='#'+"+JSON.stringify(name)+").click();return true");};
 const gedrueckt=async name=>String(await imFenster(ALPHA,"return [...f.querySelectorAll('.af-channel')].find(b=>b.querySelector('strong')?.textContent==='#'+"+JSON.stringify(name)+")?.getAttribute('aria-pressed')??''"));
 await klickChannel(CH);
 await wait(async()=>{const m=await meldung(ALPHA);return /zugewiesen/.test(m.meldung)||m.fehler!=='';},'Channel-Klick beantwortet',30000);
 console.log('DEBUG Channel-Klick | meldung '+kurz(await meldung(ALPHA))+' | aria-pressed '+(await gedrueckt(CH))+' | revision '+(await imFenster(ALPHA,"return f.querySelector('.ausweis-fenster-inhalt')?.dataset.revision??''"))+' | profil '+(await profil(Z)).slice(0,900));
 await wait(async()=>(await gedrueckt(CH))==='true'||(await meldung(ALPHA)).fehler!=='','Channel zugewiesen',15000);
 ok((await gedrueckt(CH))==='true'&&/zugewiesen/.test((await meldung(ALPHA)).meldung),HF+': Channel-Icon weist #'+CH+' zu',await meldung(ALPHA));
 ok((await profil(Z)).includes('"'+CH+'"'),'P22-T270 agent-profil-admin.ts profil_lesen: channels enthaelt '+CH+' (PG)');
 await klickChannel(CH);
 await wait(async()=>(await gedrueckt(CH))==='false','Channel entzogen',30000);
 ok(!(await profil(Z)).includes('"'+CH+'"'),HF+': Channel-Icon entzieht #'+CH+' wieder (PG)');
 await klickChannel(CH);
 await wait(async()=>(await gedrueckt(CH))==='true','Channel erneut zugewiesen',30000);
 ok(String(await imFenster(ALPHA,"return f.querySelector('.af-channel-icon b')?.textContent??''"))==='1',HF+': Icon zeigt die Zahl der Ausweis-Channels');
 await shot('dunkel-channels');

 // ================================================================ 5 Ausweis erstellen
 await sucheOeffnen();
 await evaluate("document.querySelector('.agententeam-suche-erstellen').click();true");
 await wait(async()=>!!(await evaluate("!!document.querySelector('.ausweis-fenster[data-modus=\"anlegen\"] form')")),'Anlege-Fenster');
 await evaluate("window.__setze(document.querySelector('.ausweis-fenster[data-modus=\"anlegen\"] input'),"+JSON.stringify(NEU)+");true");
 await shot('dunkel-erstellen');
 await evaluate("window.__knopf('Ausweis erstellen',document.querySelector('.ausweis-fenster[data-modus=\"anlegen\"]')).click();true");
 await wait(async()=>(await evaluate("window.__fenster("+JSON.stringify('Ausweis '+NEU)+")?.querySelector('.ausweis-fenster-inhalt')?.dataset.profil??(document.querySelector('.ausweis-fenster[data-modus=\"anlegen\"] .af-fehler')?.innerText?'fehler':'')"))!=='','Neuer Ausweis im Fenster',40000);
 const fehlerAnlegen=await evaluate("document.querySelector('.ausweis-fenster[data-modus=\"anlegen\"] .af-fehler')?.innerText??''");
 ok(fehlerAnlegen==='',HF+': Anlegen ohne Fehler',fehlerAnlegen);
 const neu=(await pool.query('SELECT id,rolle,status FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[P,NEU])).rows;
 ok(neu.length===1&&neu[0].rolle==='subagent','P22-T270 agent-profil-admin.ts agent_vorbereiten: Identitaet '+NEU+' angelegt (PG)',neu);
 ok(!(await evaluate("!!document.querySelector('.ausweis-fenster[data-modus=\"anlegen\"]')")),HF+': Anlege-Fenster wechselt in die Ansicht des neuen Ausweises');
 await wait(async()=>(await evaluate("window.__fenster("+JSON.stringify('Ausweis '+NEU)+")?.querySelector('.ausweis-fenster-inhalt')?.dataset.profil??''"))==='bereit','Profil des neuen Ausweises',30000);
 await shot('dunkel-erstellt');

 // ================================================================ 6 hell
 await oeffne('light');
 await sucheOeffnen();
 await shot('hell-suche');
 await agentOeffnen(ALPHA);
 await shot('hell-fenster');
 await imFenster(ALPHA,"f.querySelector('.af-channel-icon').click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return f.querySelectorAll('.af-channel').length"))>=2,'Channel-Liste hell');
 ok((await gedrueckt(CH))==='true',HF+' (hell): zugewiesener Channel ist markiert');
 await shot('hell-channels');
 await imFenster(ALPHA,"f.querySelector('.af-channel-icon').click();window.__knopf('Bearbeiten',f).click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return !!f.querySelector('.af-editor')"))===true,'Editor hell');
 await shot('hell-bearbeiten');
 const fehler=await json('JSON.stringify(window.__fehler??[])');
 console.log('SEITENFEHLER '+kurz(fehler));

 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,identity_id:Z,neu:NEU,channel:CH,seitenfehler:fehler},null,2));
 console.log('PASS P22-T270 Agententeam-Suche Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
