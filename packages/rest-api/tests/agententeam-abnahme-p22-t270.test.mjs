/** P22-T270 UNABHAENGIGE ABNAHME (claude-linde, 01.11.2026; Auftrag Koordinator, Quellen 428e12b2, 98fc9126, User 9ddef22c + 7b25b0c1,
 * Entscheidung 1537101e). KI-Browser gegen ein privates synapse_test-Schema mit echten Routen (agent-profil, specialists), kein Deploy.
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agententeam-abnahme-p22-t270.test.mjs
 * Testseite web-ui/tests/agententeam-abnahme.html (Fixture agententeam-abnahme-fixture.tsx). Prueft ergaenzend zum Test von claude-eiche:
 *   A Schalter web_ui_agententeam_suche: Standard AUS, auch nach profil_schalter_setzen 'alle' EIN (NUR_AUSDRUECKLICH).
 *   B Suche wie Channels: Klassen der ChannelSuche, erster Eintrag „Ausweis erstellen“ (auch gefiltert), Escape und Klick daneben schliessen.
 *   C Fenster: Bearbeiten mit „Feld hinzufuegen“ (nur vorhandene Ausweis-Felder), Channel-Icon zuweisen/entziehen (PG).
 *   D Panel Einstellungen > Agenten-Ausweis: Modell im Fenster gespeichert -> Panel zeigt denselben Wert; im Panel gespeichert -> Panel zeigt
 *     nach dem Neuladen denselben Wert (PG modell_bestaetigt), Fenster ebenso.
 *   E hell und dunkel, schmaler Viewport 390x844 (Rahmen): Suche und Fenster innerhalb des Viewports.
 *   F P22-T254 Channel-Fenster (ChannelFenster.tsx, gemeinsame Begrenzung fenster-grenze.ts): bei 390px und auf dem Desktop im Viewport.
 * Gestaltungs-/Viewport-Abweichungen werden als BEFUND gezaehlt (belege.json, Zeile 'BEFUND ...'), Funktionsfehler brechen ab.
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
// Wie P22-T173/T270: Ausweis-Kern braucht agent_bezug_modus 'beide', sonst antwortet die Verwaltung funktion_aus.
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',
 DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t270_ab_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t270-abnahme';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0,letzterShot='';const befunde=[];
const KB='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
// Ziel-Fenster: im Rahmen das iframe, sonst die Seite selbst. Ergebnisse als JSON-Text (der KI-Browser parst JSON-artige Ergebnisse selbst).
const inZiel=js=>evaluate("(()=>{const W=window.__ziel||window,D=W.document;"+js+"})()");
const json=async js=>{const v=await inZiel('return JSON.stringify((()=>{'+js+'})())');return typeof v==='string'?JSON.parse(v):v;};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}
 console.error('DEBUG Timeout '+label+' | screenshot '+letzterShot+' | seitenfehler '+JSON.stringify(await inZiel('return JSON.stringify(W.__fehler??[])').catch(()=>'?')));throw Error('Timeout: '+label);};
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert und Screenshot.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):'')+' | screenshot '+letzterShot);assert(value,label);console.log('OK '+label);};
const befund=(value,label,info)=>{checks++;if(value){console.log('OK '+label);return;}befunde.push({label,info,screenshot:letzterShot});console.log('BEFUND '+label+' | tatsaechlich: '+kurz(info)+' | screenshot '+letzterShot);};
const Z=randomUUID(),K=randomUUID(),ALPHA='t270-ab-alpha',KOORD='t270-ab-koord',CH='t270-ab-team',CH2='t270-ab-review';
const HS='P22-T270 AgentenTeamSuche.tsx (KI-Browser, Abnahme)',HF='P22-T270 AusweisFenster.tsx (KI-Browser, Abnahme)',HP='P22-T270 AusweisIdentitaetenPanel.tsx + ausweis-verwaltung.ts ladeDetail (KI-Browser, Abnahme)';
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
  ($1,$3,$4,1,$4,'subagent','aktiv','t270ab'),($2,$3,$5,1,$5,'koordinator','aktiv','t270ab')`,[Z,K,P,ALPHA,KOORD]);
 await C.createChannel(P,CH,'Team-Channel der Abnahme','t270ab');
 await C.createChannel(P,CH2,'Review-Channel der Abnahme','t270ab');

 // ================================================================ A Schalter (regel-neue-funktionen-mit-schalter-und-debug)
 const S=await load('packages/core/dist/services/agent-profil-schalter.js');
 ok((await S.leseProfilProduktSchalter('web_ui_agententeam_suche',P)).aktiv===false,'P22-T270 agent-profil-schalter.ts: web_ui_agententeam_suche Standard AUS');
 const ein=await adm('profil_schalter_setzen',{profil_funktion:'alle',aktiv:true,grund:'Abnahme T270 alle ein'});
 ok(ein.success===true,'P22-T270 agent-profil-admin.ts profil_schalter_setzen alle EIN',ein);
 ok((await S.leseProfilProduktSchalter('web_ui_agententeam_suche',P)).aktiv===false&&S.NUR_AUSDRUECKLICH.includes('web_ui_agententeam_suche'),'P22-T270 agent-profil-schalter.ts: auch mit alle EIN bleibt die Suche AUS (nur ausdruecklich)');
 await adm('profil_schalter_setzen',{profil_funktion:'team_ausweis_zeigen',aktiv:true,grund:'Abnahme T270 Ausweis-Karte'});
 const spalte=async()=>(await pool.query('SELECT modell_bestaetigt FROM agent_identitaeten WHERE id=$1',[Z])).rows[0]?.modell_bestaetigt??null;

 const auth=await load('packages/rest-api/dist/services/auth.js');
 const AP=await load('packages/rest-api/dist/routes/agent-profil.js');
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(AP.agentProfilRoutes);await app.register(specialistRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/agententeam-abnahme.html']},server:{host:'0.0.0.0',port:0,hmr:false,watch:{ignored:['**/*']},proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 const ablage=await screenshotAblage(repo,'p22-t270'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{await new Promise(r=>setTimeout(r,400));const f='ab-'+String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(KB+'/screenshot?tab_id='+tab);assert(r.ok);letzterShot=await ablage.speichere(f,Buffer.from(await r.arrayBuffer()));console.log('SCREENSHOT '+letzterShot);};
 const url=(o)=>ui+'/tests/agententeam-abnahme.html?project='+P+'&token='+encodeURIComponent(sitzung)+'&theme='+(o.theme||'dark')+'&modus='+(o.modus||'suche')+(o.rahmen?'&rahmen='+o.rahmen:'');
 // Beobachtet 01.11.: Entdeckt vite beim Wechsel der Testseiten neue Abhaengigkeiten (Panel, Channels), optimiert es neu; ohne HMR startet
 // das Fixture-Modul im naechsten Tab dann nicht (#root bleibt leer). Darum: nicht gerendert -> einmal neu laden (nur Test-Harness).
 const gerendert=async()=>(await evaluate("(()=>{const f=document.getElementById('rahmen');const d=f?f.contentDocument:document;return d&&d.readyState==='complete'&&d.querySelector('#root>*')?'ja':'nein'})()"))==='ja';
 const oeffne=async o=>{if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});tab=(await isolierterTab(kb,{url:url(o)})).tab_id;
  await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite geladen');
  try{await wait(gerendert,'Fixture gerendert',15000);}catch{console.log('HINWEIS Testseite leer (vite-Neuoptimierung) -> einmal neu laden');
   await evaluate('location.reload();true');await new Promise(r=>setTimeout(r,1500));
   await wait(async()=>(await evaluate('document.readyState'))==='complete','Seite neu geladen');await wait(gerendert,'Fixture nach Neuladen gerendert',40000);}
  if(o.rahmen)await evaluate("window.__ziel=document.getElementById('rahmen').contentWindow;true");
  await inZiel('W.eval('+JSON.stringify(JS_HELFER)+');return true');};
 const sucheBereit=async()=>{try{await wait(async()=>!!(await inZiel("return !!D.querySelector('button[data-agententeam-knopf] b')")),'Knopf Agententeam mit Zahl',40000);}
  catch(e){console.error('DEBUG agenten-team '+String(await inZiel("return fetch('/api/projects/'+encodeURIComponent("+JSON.stringify(P)+")+'/agenten-team',{headers:{Authorization:'Bearer '+W.localStorage.getItem('synapse_session_token')}}).then(async r=>r.status+' '+(await r.text())).catch(x=>'fetch '+x)")).slice(0,300));
   console.error('DEBUG seite '+String(await inZiel("return W.location.href+' | '+(D.querySelector('button[data-agententeam-knopf]')?.outerHTML??'kein-knopf')+' | '+D.body.innerHTML.slice(0,500)")).slice(0,900));throw e;}};
 const sucheOeffnen=async()=>{await inZiel("D.querySelector('button[data-agententeam-knopf]').click();return true");
  await wait(async()=>(await inZiel("return D.querySelectorAll('.agententeam-suche .channel-suche-liste>button').length"))>=3,'Suche mit Eintraegen');};
 const treffer=()=>json("return [...D.querySelectorAll('.agententeam-suche .channel-suche-liste>button')].map(b=>b.querySelector('strong')?.textContent.trim())");
 const agentOeffnen=async name=>{await inZiel("[...D.querySelectorAll('.agententeam-suche .channel-suche-liste>button')].find(b=>b.querySelector('strong')?.textContent.trim()==="+JSON.stringify(name)+").click();return true");
  await wait(async()=>(await inZiel("return W.__fenster("+JSON.stringify('Ausweis '+name)+")?.querySelector('.ausweis-fenster-inhalt')?.dataset.profil??''"))==='bereit','Fenster '+name+' mit Profil',30000);};
 const imFenster=(name,js)=>inZiel("const f=W.__fenster("+JSON.stringify('Ausweis '+name)+");if(!f)return 'kein-fenster';"+js);
 const meldung=name=>json("const f=W.__fenster("+JSON.stringify('Ausweis '+name)+");return {meldung:f?.querySelector('.af-meldung')?.innerText??'',fehler:[...(f?.querySelectorAll('.af-fehler')??[])].map(x=>x.innerText).join(' | ')};");
 const rechteck=sel=>json("const e=D.querySelector("+JSON.stringify(sel)+");if(!e)return null;const r=e.getBoundingClientRect();return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom),vw:W.innerWidth,vh:W.innerHeight};");
 const imViewport=r=>!!r&&r.l>=0&&r.r<=r.vw&&r.t>=0;

 // ================================================================ B Suche wie Channels (dunkel)
 await oeffne({theme:'dark'});await sucheBereit();await sucheOeffnen();
 const klassen=await inZiel("return D.querySelector('.agententeam-suche')?.className??''");
 ok(/seitenleiste-projektsuche/.test(klassen)&&/channel-suche/.test(klassen)&&(await inZiel("return D.querySelector('.agententeam-suche input')===D.activeElement?'ja':'nein'"))==='ja',HS+': gleiche Klassen wie die ChannelSuche, Feld hat den Fokus',klassen);
 let t=await treffer();
 ok(t[0]==='+Ausweis erstellen'&&t.includes(ALPHA)&&t.includes(KOORD),HS+': erster Eintrag „Ausweis erstellen“, danach die Projektagenten',t);
 await inZiel("W.__setze(D.querySelector('.agententeam-suche input'),'alpha');return true");
 await wait(async()=>(await treffer()).length===2,'Filter alpha');
 t=await treffer();ok(t[0]==='+Ausweis erstellen'&&t[1]===ALPHA,HS+': gefiltert bleibt „Ausweis erstellen“ oben',t);
 await shot('dunkel-suche-gefiltert');
 // Wie die ChannelSuche behaelt die Suche den Suchtext beim Schliessen; fuer die weiteren Schritte leeren.
 await inZiel("W.__setze(D.querySelector('.agententeam-suche input'),'');return true");
 await inZiel("W.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return true");
 await wait(async()=>!(await inZiel("return !!D.querySelector('.agententeam-suche')")),'Escape schliesst');
 ok(true,HS+': Escape schliesst die Suche (wie ChannelSuche)');
 await sucheOeffnen();
 await inZiel("D.querySelector('.standard-page').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return true");
 await wait(async()=>!(await inZiel("return !!D.querySelector('.agententeam-suche')")),'Klick daneben schliesst');
 ok(true,HS+': Klick daneben schliesst die Suche (wie ChannelSuche)');

 // ================================================================ C Fenster: Bearbeiten, Feld hinzufuegen, Channel-Icon
 await sucheOeffnen();await agentOeffnen(ALPHA);
 const werkzeug=await json("const f=W.__fenster('Ausweis '+"+JSON.stringify(ALPHA)+");return {bearbeiten:!!W.__knopf('Bearbeiten',f)||[...f.querySelectorAll('.af-werkzeug')].some(b=>/Bearbeiten/.test(b.textContent)),icon:!!f.querySelector('.af-channel-icon'),karte:!!f.querySelector('.team-ausweis'),fakten:f.querySelectorAll('.af-fakten>div').length}");
 ok(werkzeug.bearbeiten&&werkzeug.icon&&werkzeug.karte&&werkzeug.fakten>=12,HF+': Fenster mit Bearbeiten, Channel-Icon, Ausweis-Karte und Fakten',werkzeug);
 await imFenster(ALPHA,"[...f.querySelectorAll('.af-werkzeug')].find(b=>/Bearbeiten/.test(b.textContent)).click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return !!f.querySelector('.af-editor')"))===true,'Editor offen');
 const optionen=await json("const f=W.__fenster('Ausweis '+"+JSON.stringify(ALPHA)+");return [...f.querySelectorAll('.af-hinzufuegen select option')].map(o=>o.value).filter(Boolean)");
 ok(optionen.length>=5&&optionen.every(o=>['modell','effort','kontext_stufe','briefing','arbeitsweise','regeln','skills'].includes(o)),HF+': „Feld hinzufuegen“ bietet nur vorhandene Ausweis-Felder an',optionen);
 await imFenster(ALPHA,"W.__setze(f.querySelector('.af-hinzufuegen select'),'modell');return true");
 await imFenster(ALPHA,"W.__knopf('+ Feld hinzufügen',f).click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return !!f.querySelector('[data-feld=\"modell\"] input')"))===true,'Feld Modell');
 await imFenster(ALPHA,"W.__setze(f.querySelector('[data-feld=\"modell\"] input'),'sonnet');return true");
 await shot('dunkel-fenster-feld-hinzufuegen');
 await imFenster(ALPHA,"W.__knopf('Speichern (1)',f).click();return true");
 await wait(async()=>{const m=await meldung(ALPHA);return /Ausweis gespeichert/.test(m.meldung)||m.fehler!=='';},'Fenster speichert',30000);
 ok(/Ausweis gespeichert/.test((await meldung(ALPHA)).meldung)&&(await spalte())==='sonnet',HF+': Modell im Fenster gespeichert (PG modell_bestaetigt)',{m:await meldung(ALPHA),spalte:await spalte()});
 await imFenster(ALPHA,"f.querySelector('.af-channel-icon').click();return true");
 await wait(async()=>(await imFenster(ALPHA,"return f.querySelectorAll('.af-channel').length"))>=2,'Channel-Liste');
 const chKlick=async n=>imFenster(ALPHA,"[...f.querySelectorAll('.af-channel')].find(b=>b.querySelector('strong')?.textContent==='#'+"+JSON.stringify(n)+").click();return true");
 const chDrin=async n=>String(await imFenster(ALPHA,"return [...f.querySelectorAll('.af-channel')].find(b=>b.querySelector('strong')?.textContent==='#'+"+JSON.stringify(n)+")?.getAttribute('aria-pressed')??''"));
 const profilText=async()=>JSON.stringify(await adm('profil_lesen',{ziel_identity_id:Z}));
 await chKlick(CH2);await wait(async()=>(await chDrin(CH2))==='true'||(await meldung(ALPHA)).fehler!=='','Channel zugewiesen',30000);
 ok((await chDrin(CH2))==='true',HF+': Channel-Klick ohne Fehler im Fenster',{m:await meldung(ALPHA),revision:await imFenster(ALPHA,"return f.querySelector('.ausweis-fenster-inhalt')?.dataset.revision??''")});
 ok((await profilText()).includes('"'+CH2+'"')&&String(await imFenster(ALPHA,"return f.querySelector('.af-channel-icon b')?.textContent??''"))==='1',HF+': Channel-Icon weist #'+CH2+' zu (PG), Icon zeigt 1');
 await shot('dunkel-fenster-channels');
 await chKlick(CH2);await wait(async()=>(await chDrin(CH2))==='false','Channel entzogen',30000);
 ok(!(await profilText()).includes('"'+CH2+'"'),HF+': Channel-Icon entzieht #'+CH2+' wieder (PG)');

 // ================================================================ D Panel Einstellungen > Agenten-Ausweis: derselbe Modellwert
 const panelOeffnen=async theme=>{await oeffne({theme,modus:'panel'});
  await wait(async()=>(await inZiel("return [...D.querySelectorAll('.av-zeile')].some(b=>b.querySelector('strong')?.textContent.startsWith("+JSON.stringify(ALPHA)+"))?'ja':'nein'"))==='ja','Panel-Liste',30000);
  await inZiel("[...D.querySelectorAll('.av-zeile')].find(b=>b.querySelector('strong')?.textContent.startsWith("+JSON.stringify(ALPHA)+")).click();return true");
  await wait(async()=>!!(await inZiel("return !!D.querySelector('input[list=\"av-modelle\"]')")),'Panel-Detail',30000);};
 const panelModell=()=>json("const i=D.querySelector('input[list=\"av-modelle\"]');return {wert:i?.value??null,herkunft:i?.parentElement?.querySelector('small')?.textContent??''}");
 await panelOeffnen('dark');
 let pm=await panelModell();
 ok(pm.wert==='sonnet'&&/profil/.test(pm.herkunft),HP+': Panel zeigt das im Fenster gespeicherte Modell (sonnet, aus profil)',pm);
 await inZiel("W.__setze(D.querySelector('.av-grund input'),'Abnahme T270 Modell im Panel');W.__setze(D.querySelector('input[list=\"av-modelle\"]'),'opus');return true");
 await wait(async()=>(await inZiel("return [...D.querySelectorAll('.av-aktionen button')].find(b=>b.textContent.startsWith('Profil speichern'))?.disabled===false?'ja':'nein'"))==='ja','Speichern freigegeben');
 await shot('dunkel-panel-vor-speichern');
 await inZiel("[...D.querySelectorAll('.av-aktionen button')].find(b=>b.textContent.startsWith('Profil speichern')).click();return true");
 await wait(async()=>/Profil gespeichert/.test(String(await inZiel("return D.querySelector('.av-meldung')?.textContent??D.querySelector('.av-fehler')?.textContent??''"))),'Panel speichert',30000);
 pm=await panelModell();
 ok(pm.wert==='opus'&&(await spalte())==='opus',HP+': nach dem Speichern zeigt das Panel denselben Modellwert (opus = PG)',{pm,spalte:await spalte()});
 await shot('dunkel-panel-nach-speichern');
 await panelOeffnen('light');
 pm=await panelModell();
 ok(pm.wert==='opus'&&/profil/.test(pm.herkunft),HP+': nach Neuladen weiter opus (hell)',pm);
 await shot('hell-panel');

 // Fenster zeigt denselben Wert wie das Panel (hell).
 await oeffne({theme:'light'});await sucheBereit();await sucheOeffnen();await shot('hell-suche');await agentOeffnen(ALPHA);
 const felder=String(await imFenster(ALPHA,"return f.querySelector('.af-profil')?.innerText??''"));
 const desk=await rechteck('.ausweis-fenster');
 ok(imViewport(desk)&&desk.l===140,HF+' (Desktop): Startposition unveraendert (x=140), ganz im Viewport',desk);
 ok(/modell[\s\S]*opus/i.test(felder)&&/opus/.test(String(await imFenster(ALPHA,"return [...f.querySelectorAll('.af-fakten:not(.af-profil)>div')].find(d=>/modell/i.test(d.querySelector('dt')?.textContent??''))?.querySelector('dd')?.textContent??''"))),HF+': Ausweis-Felder zeigen dasselbe Modell wie das Panel (opus)',felder);
 await shot('hell-fenster');

 // ================================================================ E schmaler Viewport 390x844 (dunkel und hell)
 for(const theme of ['dark','light']){
  await oeffne({theme,rahmen:'390x844'});await sucheBereit();
  // Die Testseite (Seitenleiste + Inhalt ohne Mobil-Layout) ist bei 390px selbst breiter: Vergleich vorher/nachher statt absolut.
  const breiteVorher=Number(await inZiel('return D.documentElement.scrollWidth'));
  await sucheOeffnen();
  const rs=await rechteck('.agententeam-suche');
  ok(imViewport(rs),HS+' (390px, '+theme+'): Suche liegt im Viewport',rs);
  await shot((theme==='dark'?'dunkel':'hell')+'-390-suche');
  await agentOeffnen(ALPHA);
  const rf=await rechteck('.ausweis-fenster');
  // B1 behoben (Abnahme 576de978, Fix AusweisFenster.tsx grenze): Fenster ganz im Viewport.
  ok(imViewport(rf)&&rf.l>=8&&rf.r<=rf.vw-8,HF+' (390px, '+theme+'): Ausweis-Fenster liegt im Viewport (8px Rand)',rf);
  const kopf=await rechteck('.ausweis-fenster .channel-eigenfenster-knopf.schliessen');
  ok(imViewport(kopf),HF+' (390px, '+theme+'): Schliessen-Knopf erreichbar',kopf);
  ok(imViewport(await rechteck('.ausweis-fenster .channel-eigenfenster-knopf:not(.schliessen)')),HF+' (390px, '+theme+'): Minimieren-Knopf erreichbar');
  const breiteNachher=Number(await inZiel('return D.documentElement.scrollWidth'));
  ok(breiteNachher<=breiteVorher,HF+' (390px, '+theme+'): das Fenster verbreitert die Seite nicht (kein zusaetzliches waagerechtes Scrollen)',{breiteVorher,breiteNachher});
  await shot((theme==='dark'?'dunkel':'hell')+'-390-fenster');
 }
 // ================================================================ F Channel-Fenster P22-T254 (Auftrag Koordinator: bei 390px mitmessen, gleiche Begrenzung)
 await adm('profil_schalter_setzen',{profil_funktion:'web_ui_channel_suche',aktiv:true,grund:'Abnahme T254 Channel-Fenster'});
 for(const [theme,rahmen] of [['dark','390x844'],['light','390x844'],['dark',null],['light',null]]){
  await oeffne({theme,modus:'channels',rahmen});
  await wait(async()=>!!(await inZiel("return !!D.querySelector('.control-sidebar nav button b')")),'Knopf Channels mit Zahl',40000);
  await inZiel("D.querySelector('.control-sidebar nav button').click();return true");
  await wait(async()=>(await inZiel("return D.querySelectorAll('.channel-suche .channel-suche-liste>button').length"))>=1,'Channel-Suche');
  await inZiel("[...D.querySelectorAll('.channel-suche .channel-suche-liste>button')].find(b=>b.textContent.includes("+JSON.stringify(CH)+")).click();return true");
  await wait(async()=>!!(await inZiel("return !!D.querySelector('.channel-eigenfenster')")),'Channel-Fenster',30000);
  await new Promise(r=>setTimeout(r,600));
  const rc=await rechteck('.channel-eigenfenster'),zuKnopf=await rechteck('.channel-eigenfenster .channel-eigenfenster-knopf.schliessen');
  const lage=' ('+(rahmen?'390px':'Desktop')+', '+theme+')',HC='P22-T254 ChannelFenster.tsx + fenster-grenze.ts (KI-Browser)';
  ok(imViewport(rc)&&rc.l>=8&&rc.r<=rc.vw-8,HC+lage+': Channel-Fenster liegt im Viewport (8px Rand)',rc);
  ok(imViewport(zuKnopf),HC+lage+': Schliessen-Knopf erreichbar',zuKnopf);
  if(!rahmen)ok(rc.l===80,HC+lage+': Startposition auf dem Desktop unveraendert (x=80)',rc);
  await shot((theme==='dark'?'dunkel':'hell')+'-'+(rahmen?'390':'desktop')+'-channel-fenster');
 }
 const fehler=await inZiel('return JSON.stringify(W.__fehler??[])');
 console.log('SEITENFEHLER '+fehler);
 await kb('/tabs/close',{tab_id:tab});tab=null;
 await writeFile(join(folder,'abnahme-belege.json'),JSON.stringify({checks,schema,befunde,seitenfehler:fehler},null,2));
 console.log('PASS P22-T270 Abnahme '+checks+' Pruefungen, BEFUNDE '+befunde.length+'; Ordner '+folder);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
