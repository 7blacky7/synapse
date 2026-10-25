/** P22-T161: Browserabnahme der Top-Artefakte im KI-Browser (privates synapse_test-Schema, echte API, keine Produktionsdaten).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/top-artefakte-browser-p22-t161.test.mjs
 * Fixture: Koordinator per Ausweis mit Live-Vorlage (plan.list) und fertigem Artefakt, HTML aus Verlauf und Inbox, ein fremdes Projekt.
 * Prueft im echten Arbeitsraum (dunkel und hell): Liste nur mit Projektdaten und Vorbildern, Rangfolge, Chips; Ausklappen zeigt das
 * Artefakt in voller Ansicht, Vorlage live mit den Daten des Projekts (Plan-Aenderung -> neue Zahlen ohne Neuladen), Live-Abo nur solange
 * ausgeklappt; neue Bewertung -> Liste aktualisiert sich live; 'Alle' mit verbannt ganz unten; Schnappschuss-Umschalter; Sitzungsliste mit
 * Bewertungs-Chip. Screenshots: ui-screenshots/p22-t161/<lauf-id>/ (P25-T7). */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',SYNAPSE_KI_BROWSER_URL:'http://127.0.0.1:9',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t161_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t161-browser',Q='p22-t161-fremd';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,tab,failure,checks=0;
const B='http://192.168.50.65:9222';
const kb=async(path,body)=>{const r=await fetch(B+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
const evaluate=async script=>(await kb('/evaluate',{tab_id:tab,script})).result.result;
const text=async script=>{const v=await evaluate(script);return typeof v==='string'?v:JSON.stringify(v??'');};
const wait=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,120));}throw Error('Timeout: '+label);};
const ok=(value,label,info)=>{assert(value,label+(info!==undefined?' '+JSON.stringify(info).slice(0,500):''));checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const belege={};
const VORLAGE='<div class="sf"><style>.sf{--bg:#f6f5f2;--ink:#1d1d22;--acc:#b8761a;background:var(--bg);color:var(--ink);padding:16px;border-radius:14px;font:15px system-ui}.sf .kpi b{font-size:26px;color:var(--acc)}.sf .bar{height:10px;border-radius:6px;background:#dcd8cf;overflow:hidden}.sf .bar i{display:block;height:100%;background:#24885a}@media (prefers-color-scheme:dark){.sf{--bg:#0b0d14;--ink:#e9e7f0;--acc:#f0b54a}}</style><h1>{{_meta.project}} – Projektfortschritt</h1>{{#each plaene as p}}<div class="kpi" data-plan="{{p.kurz_id}}"><b>{{p.tasks_erledigt}}/{{p.tasks_gesamt}}</b> {{p.name}} ({{prozent(p.tasks_erledigt, p.tasks_gesamt)}}%)<div class="bar"><i style="width:{{prozent(p.tasks_erledigt, p.tasks_gesamt)}}%"></i></div></div>{{/each}}</div>';
const QUELLEN=[{name:'plaene',vertrag:'plan.list'}];
const tasks=(done,offen)=>JSON.stringify([...Array.from({length:done},(_,i)=>({id:randomUUID(),kurz_id:'P1-T'+(i+1),title:'erledigt '+i,description:'',status:'done',priority:'medium'})),
 ...Array.from({length:offen},(_,i)=>({id:randomUUID(),kurz_id:'P1-T'+(done+i+1),title:'offen '+i,description:'',status:'todo',priority:'medium'}))]);
// Text aller Eintraege und der ausgeklappten Ansicht (Shadow-Root der AgentRenderingSurface eingeschlossen).
const LISTE="JSON.stringify([...document.querySelectorAll('.top-eintrag')].map(e=>({b:e.dataset.bewertung,weg:e.dataset.weg,titel:e.querySelector('.top-text strong')?.textContent,chips:[...e.querySelectorAll('.top-chip')].map(c=>c.textContent),offen:e.classList.contains('offen')})))";
const ANSICHT="(()=>{const a=document.querySelector('.top-ansicht');if(!a)return '';let t=a.innerText;for(const h of a.querySelectorAll('*'))if(h.shadowRoot)t+=' '+h.shadowRoot.textContent;return t})()";
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
 for(const sql of [C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL,C.ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL,C.ARTEFAKT_VORLAGEN_SCHEMA_SQL])await pool.query(sql);
 const schalter=async(f,aktiv)=>{await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T161 Browser-Fixture','user')",[f,aktiv]);};
 for(const f of ['artefakt_bewertung','artefakt_vorlagen','artefakt_vorlagen_live','artefakt_ausweis_zeigen'])await schalter(f,true);
 belege.einstellungen=await C.setzeArtefaktVorlagenEinstellungen({drossel_ms:1000,buendel_ms:200},'T161 Browserabnahme: schneller live','user').catch(e=>({fehler:String(e?.message||e)}));
 const KOORD=randomUUID(),FREMD=randomUUID();
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t161'),($3,$4,'koordinator','koordinator','koordinator','aktiv','t161')",[KOORD,P,FREMD,Q]);
 const PLAN=randomUUID();
 await pool.query("INSERT INTO plans(id,project,name,description,tasks,aktiv,kurz_id) VALUES($1,$2,'Top-Artefakte','',$3::jsonb,true,'P1')",[PLAN,P,tasks(3,1)]);
 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const AT=await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
 const LIVE=await load('packages/rest-api/dist/services/artefakt-live.js');
 const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
 const tool=(identity,project,args)=>C.mitAgentAufrufKontext({principal:{art:'identity',project,agent_id:'koordinator',identity_id:identity,rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null},bezug},()=>AT.fuehreArtefaktAus(args,'koordinator'));
 let j=await tool(KOORD,P,{action:'zeigen',titel:'Projektfortschritt (live)',vorlage:VORLAGE,quellen:QUELLEN,modus:'live'});
 assert.equal(j.success,true,JSON.stringify(j));const A_LIVE=j.artefakt_id;
 j=await tool(KOORD,P,{action:'zeigen',titel:'Wellenstatus',html:'<div style="padding:14px;border:1px solid #c9c2b5;border-radius:10px"><h2 style="margin:0 0 6px">Wellenstatus</h2><p>W3 laeuft, W4 vorbereitet.</p></div>'});
 assert.equal(j.success,true,JSON.stringify(j));const A_FERTIG=j.artefakt_id;
 j=await tool(FREMD,Q,{action:'zeigen',titel:'Fremdes Projekt',html:'<div><h2>Fremd</h2></div>'});const A_FREMD=j.artefakt_id;
 const VERL=(await pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,text) VALUES($1,'ausgabe','aus','lauf',$2) RETURNING id",[KOORD,'<div style="padding:12px;background:#1d2733;color:#e6edf3;border-radius:8px"><h3 style="margin:0">Verlauf-HTML</h3><p>Antwort im Koordinator-Fenster.</p></div>'])).rows[0].id;
 const INB=(await pool.query("INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id) VALUES('koordinator','user',$1,$2,$3) RETURNING id",['<section><h3>Inbox-HTML</h3><p>zu bunt</p></section>',P,KOORD])).rows[0].id;
 const INB2=(await pool.query("INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id) VALUES('koordinator','user',$1,$2,$3) RETURNING id",['<section><h3>Verbanntes HTML</h3></section>',P,KOORD])).rows[0].id;
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const bewerte=async b=>{const r=(await app.inject({method:'POST',url:'/api/agent-runtimes/artefakt-bewertung',payload:b})).json();assert.equal(r.success,true,JSON.stringify(r));return r.bewertung.id;};
 const B_FERTIG=await bewerte({quelle_art:'artefakt',quelle_ref:A_FERTIG,urteil:'hoch',kommentar:'klar und ruhig'});
 await bewerte({quelle_art:'artefakt',quelle_ref:A_FERTIG,urteil:'hoch',kommentar:'klar und ruhig, gern wieder'});
 const B_LIVE=await bewerte({quelle_art:'artefakt',quelle_ref:A_LIVE,urteil:'hoch',kommentar:'die farben anpassen :D'});
 const B_VERL=await bewerte({quelle_art:'verlauf',quelle_ref:String(VERL),identity_id:KOORD,urteil:'hoch'});
 await bewerte({quelle_art:'inbox',quelle_ref:String(INB),identity_id:KOORD,urteil:'runter',kommentar:'weniger Farben'});
 const B_VERB=await bewerte({quelle_art:'inbox',quelle_ref:String(INB2),identity_id:KOORD,urteil:'runter'});
 await bewerte({quelle_art:'artefakt',quelle_ref:A_FREMD,urteil:'hoch'});
 // Revision nach der Bewertung: der Hinweis 'bewertet in Rev. N' soll erscheinen
 await tool(KOORD,P,{action:'zeigen',artefakt_id:A_FERTIG,titel:'Wellenstatus',html:'<div style="padding:14px;border:1px solid #c9c2b5;border-radius:10px"><h2 style="margin:0 0 6px">Wellenstatus</h2><p>W3 fertig, W4 laeuft.</p></div>'});
 const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
 await app.listen({host:'127.0.0.1',port:0});const api='http://127.0.0.1:'+app.server.address().port;
 vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:api}}}});
 await vite.listen();const ui='http://192.168.50.10:'+vite.httpServer.address().port;
 // P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t161/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
 const ablage=await screenshotAblage(repo,'p22-t161'),folder=ablage.ordner;
 let nr=1;const shot=async name=>{const f=String(nr++).padStart(2,'0')+'-'+name+'.png';const r=await fetch(B+'/screenshot?tab_id='+tab);assert(r.ok);console.log('SCREENSHOT '+await ablage.speichere(f,Buffer.from(await r.arrayBuffer())));};
 const klick=sel=>evaluate("(()=>{const e=document.querySelector("+JSON.stringify(sel)+");if(!e)return false;e.click();return true})()");
 const klickText=(sel,text)=>evaluate("(()=>{const e=[...document.querySelectorAll("+JSON.stringify(sel)+")].find(x=>x.textContent.trim().startsWith("+JSON.stringify(text)+"));if(!e)return false;e.click();return true})()");
 const liste=async()=>{const v=await evaluate(LISTE);return typeof v==='string'?JSON.parse(v):(v??[]);}; // der KI-Browser liefert JSON-Text schon geparst
 const lauf=async(theme)=>{
  tab=(await kb('/tabs/new',{url:ui+'/tests/top-artefakte.html?project='+P+'&theme='+theme+'&block='+A_FERTIG})).tab_id;
  await wait(()=>evaluate("!!document.querySelector('.dashboard-tabs')"),theme+': Arbeitsraum geladen');
  ok(await klickText('.dashboard-tabs button','Top-Artefakte'),theme+': Reiter Top-Artefakte');
  await wait(async()=>(await liste()).length===3,theme+': drei Vorbilder');
  await wait(()=>evaluate("document.querySelector('.top-artefakte')?.dataset.live==='bereit'"),theme+': Live-Strom bereit');
  let l=await liste();
  ok(l.map(e=>e.b).join(',')===[B_FERTIG,B_VERL,B_LIVE].join(','),theme+': Rangfolge Saldo 2, dann juengste',l);
  ok(!l.some(e=>/Fremd|Inbox|Verbannt/.test(e.titel||'')),theme+': nur Vorbilder mit Daten des Projekts',l);
  ok(l.find(e=>e.b===B_LIVE)?.chips.join('|')==='Live|Vorlage'&&l.find(e=>e.b===B_FERTIG)?.chips.join('|')==='Ausweis'&&l.find(e=>e.b===B_VERL)?.chips.join('|')==='Verlauf',theme+': Chips Live/Vorlage, Ausweis, Verlauf',l);
  ok(await evaluate("document.querySelector('[data-bewertung=\""+B_LIVE+"\"] q')?.textContent")==='die farben anpassen :D',theme+': Kommentar-Vorschau');
  const reiter=await text("[...document.querySelectorAll('.dashboard-tabs button')].map(b=>b.textContent).join('|')");
  ok(/Top-Artefakte\s*3/i.test(reiter),theme+': Zahl im Reiter',reiter);
  await shot(theme+'-liste');
  // Ausklappen: Live-Vorlage mit den Daten des Projekts
  ok(await klick('[data-bewertung="'+B_LIVE+'"] .top-kopf'),theme+': Live-Vorlage ausklappen');
  await wait(async()=>/3\/4/.test(await text(ANSICHT)),theme+': Vorlage gerendert mit Plandaten (3/4)');
  await wait(()=>evaluate("!!document.querySelector('.top-ansicht .artefakt-bewertung')"),theme+': Bewertungsleiste in der Ansicht');
  await wait(async()=>LIVE.artefaktLiveStatus().abonnenten===1,theme+': Live-Abo laeuft, solange ausgeklappt');
  await sleep(800);await shot(theme+'-live-vorlage-ausgeklappt');
  await pool.query('UPDATE plans SET tasks=$2::jsonb, updated_at=NOW() WHERE id=$1',[PLAN,theme==='dark'?tasks(4,0):tasks(2,2)]);
  const ziel=theme==='dark'?/4\/4/:/2\/4/;
  await wait(async()=>ziel.test(await text(ANSICHT)),theme+': Plan-Aenderung -> Vorlage live neu gezeichnet ohne Neuladen',30000);
  ok(true,theme+': live neu gezeichnet');await sleep(600);await shot(theme+'-live-vorlage-nach-planaenderung');
  // Einklappen beendet das Live-Abo
  ok(await klick('[data-bewertung="'+B_LIVE+'"] .top-kopf'),theme+': einklappen');
  await wait(async()=>LIVE.artefaktLiveStatus().abonnenten===0,theme+': eingeklappt -> kein Live-Abo');
  ok(true,theme+': Live-Abo nur solange ausgeklappt');
  // Fertiges Artefakt: Revisionshinweis + Schnappschuss-Umschalter (nur einer offen)
  ok(await klick('[data-bewertung="'+B_FERTIG+'"] .top-kopf'),theme+': fertiges Artefakt ausklappen');
  await wait(async()=>/W3 fertig/.test(await text(ANSICHT)),theme+': aktueller Stand (Rev. 2)');
  ok(/bewertet in Rev\. 1 · jetzt Rev\. 2/.test(await text(ANSICHT)),theme+': Hinweis bewertet in Rev. 1, jetzt Rev. 2');
  ok(await klickText('.top-ansicht .top-umschalter button','Bewerteter Stand'),theme+': Umschalter Bewerteter Stand');
  await wait(async()=>/W3 laeuft/.test(await text(ANSICHT)),theme+': Schnappschuss zeigt den bewerteten Stand');
  ok((await liste()).filter(e=>e.offen).length===1,theme+': genau ein Eintrag offen');
  await sleep(500);await shot(theme+'-fertig-bewerteter-stand');
  ok(await klick('[data-bewertung="'+B_FERTIG+'"] .top-kopf'),theme+': zuklappen');
  // Neue Bewertung von aussen -> Liste aktualisiert sich live
  const neu=await tool(KOORD,P,{action:'zeigen',titel:'Neu bewertet ('+theme+')',html:'<div style="padding:10px"><h2>Neu</h2></div>'});
  const B_NEU=await bewerte({quelle_art:'artefakt',quelle_ref:neu.artefakt_id,urteil:'hoch',kommentar:'live dazu'});
  await wait(async()=>(await liste()).some(e=>e.b===B_NEU),theme+': neue Bewertung erscheint live ohne Neuladen');
  ok(true,theme+': Liste live aktualisiert');await sleep(400);await shot(theme+'-liste-nach-neuer-bewertung');
  // Alle: verbannt ganz unten
  ok(await klickText('.top-umschalter button','Alle'),theme+': Umschalter Alle');
  await wait(async()=>(await liste()).some(e=>e.b===B_VERB),theme+': alle Bewertungen geladen');
  l=await liste();
  ok(l[l.length-1].b===B_VERB&&l[l.length-1].chips[0]==='Verbannt'&&l.some(e=>e.chips.includes('Wird überarbeitet')),theme+': verbannt ganz unten, ueberarbeiten mit Chip',l);
  await sleep(400);await shot(theme+'-alle-bewertungen');
  // Sitzungsliste mit Bewertungs-Chip
  ok(await klickText('.artefakt-unterreiter button','Diese Sitzung'),theme+': Unterreiter Diese Sitzung');
  await wait(()=>evaluate("[...document.querySelectorAll('.sitzung-artefakte .top-chip')].map(c=>c.textContent).join('|')==='Vorbild|offen'"),theme+': Sitzungsliste mit Bewertungs-Chip statt gesichert-Knopf');
  ok(true,theme+': Sitzungsliste Chip');await sleep(300);await shot(theme+'-sitzungsliste');
  await kb('/tabs/close',{tab_id:tab});tab=null;
  return B_NEU;
 };
 belege.dunkel=await lauf('dark');
 // fuer den hellen Lauf die zusaetzliche Bewertung wieder herausnehmen (verbannen, damit Rang/Anzahl wie im dunklen Lauf beginnen)
 await pool.query("UPDATE artefakt_bewertungen SET zustand='verbannt', urteil='runter' WHERE id=$1::bigint",[belege.dunkel]);
 await pool.query('UPDATE plans SET tasks=$2::jsonb, updated_at=NOW() WHERE id=$1',[PLAN,tasks(3,1)]);
 await sleep(1500);
 belege.hell=await lauf('light');
 await writeFile(join(folder,'belege.json'),JSON.stringify({checks,schema,belege},null,2));
 console.log('PASS P22-T161 Browser '+checks+' checks; KI-Browser; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
 await vite?.close();await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
