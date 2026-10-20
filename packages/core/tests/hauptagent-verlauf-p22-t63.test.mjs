/**
 * P22-T63: Gespraechsverlauf des Hauptagenten-Chats (Vertrag thought 97d9a354).
 * Schema 124 (Spiegel identisch, idempotent, in ensureSchema), Schalter hauptagent_verlauf (Standard EIN, nur User per REST-Weg,
 * 'alle' wirkt nicht, AUS = nichts speichern/lesen), Turn + Antwort (gedrosselt, Endstand, Artefakt-Revision, Hinweise),
 * genau eine Antwort je User-Nachricht, Seiten (neueste zuerst, vor_id), Aenderungen (seit_rev), verwaiste Antworten,
 * Leeren (nur User, nur bestaetigt, geleert_rev).
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon/Docker.
 *   node packages/core/tests/hauptagent-verlauf-p22-t63.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T63_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t63_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const warte=ms=>new Promise(r=>setTimeout(r,ms));

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-verbrauch-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'};
 const KOORD={art:'identitaet',principal:{art:'identity',project:'p22-t63',agent_id:'k',identity_id:'k',rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null}};
 const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

 await section('Schema 124: Spiegel identisch, idempotent, in ensureSchema',async()=>{
  const sql=readFileSync(join(root,'packages/core/src/db/schema-sql/124_hauptagent_verlauf.sql'),'utf8');
  check(sql.trim()===C.HAUPTAGENT_VERLAUF_SCHEMA_SQL.trim(),'124 SQL-Spiegel identisch');
  check(!C.HAUPTAGENT_VERLAUF_SCHEMA_SQL.split('\n').some(z=>z.trim().startsWith('//')),'keine //-Kommentare im SQL');
  await pool.query(C.HAUPTAGENT_VERLAUF_SCHEMA_SQL);await pool.query(C.HAUPTAGENT_VERLAUF_SCHEMA_SQL);
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS hauptagent_verlauf ('),'124 im ensureSchema-SQL');
  const t=await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('hauptagent_verlauf','hauptagent_verlauf_stand') ORDER BY 1",[schema]);
  check(t.rowCount===2,'beide Tabellen im Testschema',t.rows);
  const m=await pool.query("SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_verbrauch' AND column_name='messart'",[schema]);
  check(m.rowCount===1&&String(m.rows[0].column_default).includes('gemessen'),'agent_verbrauch.messart (Standard gemessen)',m.rows);
  const sp=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='hauptagent_verlauf'",[schema])).rows.map(r=>r.column_name);
  check(['richtung','weg','absender','quelle_ref','gehoert_zu','tokens','kontext','zug','verbrauch_referenzen','zaehlt','lauf_id','modell'].every(c=>sp.includes(c)),'Spalten fuer alle Richtungen/Tokens/Kontext',sp);
 });

 await section('Schalter: Standard EIN, ohne Main-Identitaet nichts verfuegbar',async()=>{
  const s=await C.leseVerlaufSchalter();
  check(s.aktiv===true&&s.quelle==='standard'&&s.standard===true,'Standard EIN',s);
  const p=await C.leseProfilProduktSchalter('hauptagent_verlauf',null);
  check(p.aktiv===true&&p.quelle==='standard','profil_schalter_status zeigt Standard EIN',p);
  check(C.PROFIL_PRODUKT_FUNKTIONEN.includes('hauptagent_verlauf'),'im Produkt-Schalter-Katalog');
  check((await C.leseProfilProduktSchalter('verbrauch',null)).aktiv===false,'andere Funktionen bleiben Standard AUS');
  const v=await C.leseVerlauf();
  check(v.verfuegbar===false&&v.grund==='keine_hauptagent_identitaet','ohne Identitaet: keine_hauptagent_identitaet',v);
  const t=await C.legeVerlaufTurnAn({identity_id:'x',text:'hallo'});
  check(t.gespeichert===false&&t.grund==='keine_hauptagent_identitaet','Turn ohne Identitaet speichert nichts',t);
 });

 let MAIN;
 await section('Main-Identitaet anlegen',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T63 Ausweis-Kern'},{system:'user'});
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T63 hauptagent EIN'});
  MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
  check(typeof MAIN==='string'&&MAIN.length>0,'Main-Identitaet vorhanden');
 });

 let U1,A1;
 await section('Turn + gedrosselte Antwort + Endstand',async()=>{
  check((await C.legeVerlaufTurnAn({identity_id:'fremd',text:'x'})).grund==='keine_hauptagent_identitaet','fremde identity_id speichert nichts');
  const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'Hallo Hauptagent',session_id:'s-1',runtime:'claude',modell:'opus',lauf_id:'lauf-1',geraet:C.geraetAusUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'),anhaenge:[{name:'a.png',typ:'image/png',groesse:12},{kaputt:true}]});
  check(t.gespeichert===true,'Turn gespeichert',t);
  U1=t.user_id;A1=t.antwort_id;
  const s0=await C.leseVerlauf();
  check(s0.verfuegbar===true&&s0.eintraege.length===2,'User-Nachricht + laufende Antwort sofort sichtbar',s0.eintraege.length);
  const u=s0.eintraege.find(e=>e.id===U1),a=s0.eintraege.find(e=>e.id===A1);
  check(u?.rolle==='user'&&u.geraet==='Firefox · Linux'&&u.anhaenge.length===1&&u.anhaenge[0].name==='a.png','User-Zeile mit Geraet und Anhang-Metadaten',u);
  check(a?.rolle==='agent'&&a.status==='laeuft'&&a.antwort_auf===U1,'Antwort laeuft, verweist auf User-Nachricht',a);
  check(u?.richtung==='ein'&&u.weg==='webui'&&a?.richtung==='aus'&&a.weg==='webui'&&a.modell==='opus','Richtung/Weg/Modell gesetzt',{u,a});
  const w=C.starteVerlaufAntwort(A1,{drossel_ms:20,modell:'opus'});
  w.ereignis('delta',{content:'Hallo '});
  w.ereignis('tool',{phase:'start',id:'t1',name:'code_intel',input:{action:'search'}});
  w.ereignis('thinking',{content:'\n  Ich suche zuerst.\nZweite Zeile'});
  w.ereignis('artifact',{id:'b1',html:'<p>1</p>',revision:1});
  await warte(80);
  const zw=(await C.leseVerlauf({seit_rev:s0.max_rev,ab_id:U1})).eintraege.find(e=>e.id===A1);
  check(zw?.status==='laeuft'&&zw.text==='Hallo '&&zw.werkzeuge.calls[0]?.ende===null,'Zwischenstand gedrosselt geschrieben',zw);
  w.ereignis('tool',{phase:'end',id:'t1',output:'x'.repeat(5000)});
  w.ereignis('artifact',{id:'b1',html:'<p>2</p>',revision:2});
  w.ereignis('artifact',{id:'b1',html:'<p>alt</p>',revision:1});
  w.ereignis('runtime',{hauptagent:{weg:'altweg',hinweis:'runtime_daemon_fehlt'}});
  w.ereignis('usage',{inputTokens:10,outputTokens:5,cacheReadInputTokens:100,cacheCreationInputTokens:20});
  w.ereignis('delta',{content:'Welt'});
  w.verbrauchReferenz('verlauf:'+A1);w.verbrauchReferenz('verlauf:'+A1);
  await w.abschliessen('fertig',{laufkontext:{model:'opus',num_turns:3,total_cost_usd:0.0123}});
  await w.abschliessen('fehler',{fehler:'darf nicht mehr wirken'});
  w.ereignis('delta',{content:'zu spaet'});
  await warte(60);
  const e=(await C.leseVerlauf()).eintraege.find(x=>x.id===A1);
  check(e?.status==='fertig'&&e.text==='Hallo Welt','Endstand fertig mit ganzem Text',e?.text);
  check(e?.werkzeuge.calls.length===1&&e.werkzeuge.calls[0].name==='code_intel'&&e.werkzeuge.calls[0].ende!==null&&e.werkzeuge.calls[0].output.length===5000,'Werkzeug mit Ende, Ausgabe VOLLSTAENDIG (nie gekuerzt)',e?.werkzeuge.calls[0]?.output?.length);
  check(e?.werkzeuge.phasen[0]==='Ich suche zuerst.'&&e.meta.denkphasen?.[0]==='\n  Ich suche zuerst.\nZweite Zeile','Denkphase: Kurzfassung fuer die Anzeige, Volltext in meta',e?.meta.denkphasen);
  check(e?.tokens.gemessen?.input===10&&e.tokens.gemessen.cache_read===100&&e.tokens.gemessen.cache_creation===20&&e.tokens.gemessen.output===5,'gemessene Tokens je Zug',e?.tokens);
  check(e?.zug?.zuege===3&&e.zug.kosten?.usd===0.0123&&e.zug.kosten.quelle==='cli'&&e.zug.dauer_ms>=0,'Zugdaten: Zuege, Kosten der CLI, Dauer',e?.zug);
  check(e?.kontext?.tokens===135&&e.kontext.fenster>0&&e.kontext.modell==='opus'&&e.kontext.handoff>0&&e.kontext.quelle==='gemessen','Kontextstand mit Fenster/Schwellen des Modells',e?.kontext);
  check(JSON.stringify(e?.verbrauch_referenzen)===JSON.stringify(['verlauf:'+A1])&&e.lauf_id==='lauf-1','Verbrauchs-Referenz einmal, lauf_id',{r:e?.verbrauch_referenzen,l:e?.lauf_id});
  check(e?.artefakte.length===1&&e.artefakte[0].html==='<p>2</p>'&&e.artefakte[0].revision===2,'Artefakt nach Revision ersetzt, aeltere ignoriert',e?.artefakte);
  check(e?.hinweise.includes('Hinweis: runtime_daemon_fehlt')&&!e.hinweise.some(h=>h.includes('darf nicht')),'Hinweis gespeichert, zweiter Abschluss wirkungslos',e?.hinweise);
  check(e?.meta.usage?.inputTokens===10&&e.meta.hauptagent_weg==='altweg'&&e.meta.laufkontext?.model==='opus','meta: usage, Weg, Laufkontext',e?.meta);
 });

 await section('Genau eine Antwort je User-Nachricht',async()=>{
  check(await err(()=>pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,antwort_auf,status) VALUES($1,'agent','aus','webui',$2,'laeuft')",[MAIN,U1]))!=='kein_fehler','zweite Antwortzeile abgewiesen (UNIQUE)');
  check(await err(()=>pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,status) VALUES($1,'agent','aus','webui','laeuft')",[MAIN]))!=='kein_fehler','Antwort ohne antwort_auf abgewiesen (CHECK)');
  check(await err(()=>pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,text) VALUES($1,'nachricht','ein','funk','x')",[MAIN]))!=='kein_fehler','unbekannter Weg abgewiesen (CHECK)');
 });

 await section('Zugestellt (beschaeftigter Main) und Fehler/Abbruch',async()=>{
  const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'zweite'});
  const w=C.starteVerlaufAntwort(t.antwort_id,{drossel_ms:5});
  w.ereignis('runtime',{hauptagent:{weg:'dauerhaft',schritt:'zugestellt',hinweis:'Nachricht zugestellt'}});
  w.ereignis('delta',{content:'Nachricht zugestellt'});
  await w.abschliessen('fertig');
  const t2=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'dritte'});
  const w2=C.starteVerlaufAntwort(t2.antwort_id,{drossel_ms:5});
  await w2.abschliessen('fehler',{fehler:'Container weg'});
  const t3=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'vierte'});
  await C.starteVerlaufAntwort(t3.antwort_id).abschliessen('abgebrochen');
  const alle=(await C.leseVerlauf()).eintraege;
  const z=alle.find(e=>e.id===t.antwort_id),f=alle.find(e=>e.id===t2.antwort_id),ab=alle.find(e=>e.id===t3.antwort_id);
  check(z?.meta.zugestellt===true&&z.hinweise.length===0&&z.text==='Nachricht zugestellt','zugestellt: meta, kein doppelter Hinweis',z);
  check(f?.status==='fehler'&&f.hinweise.includes('Runtime-Fehler: Container weg'),'Fehler mit Hinweiszeile',f);
  check(ab?.status==='abgebrochen'&&ab.hinweise.includes('Ausgabe abgebrochen'),'Abbruch sichtbar',ab);
 });

 await section('Seiten, Reihenfolge, Aenderungen',async()=>{
  const s=await C.leseVerlauf({limit:3});
  check(s.eintraege.length===3&&s.mehr===true,'Seite limit 3, mehr',s.eintraege.length);
  const ids=s.eintraege.map(e=>Number(e.id));
  check(ids.every((v,i)=>i===0||v>ids[i-1]),'aufsteigend nach id',ids);
  const alle=(await C.leseVerlauf()).eintraege;
  check(Number(alle[alle.length-1].id)>=10&&alle.every((e,i)=>i===0||Number(e.id)>Number(alle[i-1].id)),'numerisch aufsteigend auch ueber 9->10 (keine Textsortierung)',alle.map(e=>e.id));
  check(Number(s.eintraege[2].id)===Number(alle[alle.length-1].id),'Seite = neueste Eintraege');
  const s2=await C.leseVerlauf({limit:3,vor_id:s.eintraege[0].id});
  check(s2.eintraege.length===3&&Number(s2.eintraege[2].id)<Number(s.eintraege[0].id),'vor_id liefert aeltere',s2.eintraege.map(e=>e.id));
  const s3=await C.leseVerlauf({limit:50,vor_id:s2.eintraege[0].id});
  check(s3.mehr===false&&s3.eintraege.length===alle.length-6,'letzte Seite ohne mehr',{s:s.eintraege.map(e=>e.id),s2:s2.eintraege.map(e=>e.id),s3:s3.eintraege.map(e=>e.id),alle:alle.map(e=>e.id)});
  await warte(3200);
  const ruhig=await C.leseVerlauf({seit_rev:s.max_rev,ab_id:'0'});
  check(ruhig.eintraege.length===0,'ohne Aenderung: keine Eintraege',ruhig.eintraege.map(e=>e.id));
  const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'neu'});
  const n=await C.leseVerlauf({seit_rev:s.max_rev,ab_id:'0'});
  check(n.eintraege.length===2&&n.eintraege.every(e=>e.id===t.user_id||e.id===t.antwort_id)&&Number(n.max_rev)>Number(s.max_rev),'Aenderungen: genau der neue Turn',n.eintraege.map(e=>e.id));
  await C.starteVerlaufAntwort(t.antwort_id).abschliessen('fertig');
 });

 await section('Verwaiste laufende Antwort wird abgeschlossen',async()=>{
  const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'verwaist'});
  await pool.query("UPDATE hauptagent_verlauf SET aktualisiert_am=NOW()-interval '5 minutes' WHERE id=$1",[t.antwort_id]);
  const aktiv=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'aktiv'});
  const w=C.starteVerlaufAntwort(aktiv.antwort_id);
  await pool.query("UPDATE hauptagent_verlauf SET aktualisiert_am=NOW()-interval '5 minutes' WHERE id=$1",[aktiv.antwort_id]);
  const e=(await C.leseVerlauf()).eintraege;
  const v=e.find(x=>x.id===t.antwort_id),a=e.find(x=>x.id===aktiv.antwort_id);
  check(v?.status==='abgebrochen'&&v.hinweise.some(h=>h.includes('ohne Abschluss')),'verwaist -> abgebrochen mit Hinweis',v);
  check(a?.status==='laeuft','Antwort mit aktivem Strom bleibt laufend',a?.status);
  await w.abschliessen('fertig');
  const st=await C.verlaufStatus();
  check(st.identity_id===MAIN&&st.laufend===0&&st.anzahl===e.length&&st.letzter_fehler===null&&st.schalter.aktiv===true,'verlaufStatus (Debug)',st);
 });

 await section('Leeren: nur User, nur bestaetigt, andere Geraete sehen geleert_rev',async()=>{
  const vor=await C.leseVerlauf();
  check(await err(()=>C.leereVerlauf(KOORD,{bestaetigt:true}))==='recht_fehlt','Koordinator -> recht_fehlt');
  check(await err(()=>C.leereVerlauf(USER,{}))==='bestaetigung_fehlt','ohne bestaetigt -> bestaetigung_fehlt');
  const anzahlVor=(await C.verlaufStatus()).anzahl;
  const r=await C.leereVerlauf(USER,{bestaetigt:true});
  check(r.ausgeblendet===vor.eintraege.length&&Number(r.geleert_rev)>Number(vor.max_rev),'ausgeblendet, geleert_rev hinter max_rev',r);
  const nach=await C.leseVerlauf({seit_rev:vor.max_rev,ab_id:'0'});
  check(nach.eintraege.length===0&&nach.geleert_rev===r.geleert_rev&&nach.max_rev===r.geleert_rev,'Abgleich meldet geleert_rev',nach);
  check((await C.leseVerlauf()).eintraege.length===0,'Seite nach dem Ausblenden leer');
  const st=await C.verlaufStatus();
  check(st.anzahl===anzahlVor&&st.sichtbar===0,'Daten bleiben vollstaendig gespeichert (nur ausgeblendet)',st);
  const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'nach dem Leeren'});
  await C.starteVerlaufAntwort(t.antwort_id).abschliessen('fertig');
  const neu=await C.leseVerlauf();
  check(neu.eintraege.length===2&&neu.eintraege[0].id===t.user_id,'neue Eintraege nach dem Ausblenden sichtbar',neu.eintraege.map(e=>e.id));
  const r2=await C.leereVerlauf(USER,{bestaetigt:true});
  check(r2.ausgeblendet===2,'zweites Ausblenden zaehlt nur die neuen',r2);
 });

 await section('Schalter AUS: nichts speichern/lesen; Rechte; alle wirkt nicht',async()=>{
  check(await err(()=>C.setzeVerlaufSchalter(KOORD,{aktiv:false,grund:'Test T63'}))==='recht_fehlt','REST-Weg nur User');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:false,grund:'Test T63 alle AUS'},{system:'user'});
  check((await C.leseVerlaufSchalter()).aktiv===true,"'alle' AUS schaltet den Verlauf nicht ab");
  const s=await C.setzeVerlaufSchalter(USER,{aktiv:false,grund:'Test T63 AUS'});
  check(s.aktiv===false&&s.quelle==='produkt-schalter'&&s.grund==='Test T63 AUS','User schaltet AUS, Quelle sichtbar',s);
  check((await C.leseVerlauf()).grund==='schalter_aus','Lesen: schalter_aus');
  check((await C.legeVerlaufTurnAn({identity_id:MAIN,text:'x'})).grund==='schalter_aus','Schreiben: schalter_aus');
  await C.setzeVerlaufSchalter(USER,{aktiv:true,grund:'Test T63 wieder EIN'});
  check((await C.leseVerlauf()).verfuegbar===true,'wieder EIN');
 });

 await section('B: eigene Token-Zaehlung (Schalter, Verfahren, Kalibrierung, Grundlast, Kontext, berechnete Buchung)',async()=>{
  const zk=(t,lauf)=>({modell:'opus',identity_id:MAIN,user_id:t.user_id,runtime:'claude',lauf_id:lauf,drossel_ms:5});
  const t0=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'ohne Zaehlung',runtime:'claude',modell:'opus',lauf_id:'lauf-b'});
  await C.starteVerlaufAntwort(t0.antwort_id,{...zk(t0,'lauf-b'),user_text:'ohne Zaehlung'}).abschliessen('fertig');
  const e0=(await C.leseVerlauf()).eintraege.find(e=>e.id===t0.antwort_id);
  check(!e0?.tokens.berechnet&&(await C.leseTokenZaehlSchalter()).aktiv===false,'Schalter Standard AUS: keine eigene Zaehlung',e0?.tokens);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_token_zaehlung',aktiv:true,grund:'Test T63 B EIN'},{system:'user'});
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verbrauch',aktiv:true,grund:'Test T63 Verbrauch EIN'},{system:'user'});
  const s=await C.leseTokenZaehlSchalter();
  check(s.aktiv===true&&s.quelle==='produkt-schalter','Schalter EIN ueber Produkt-Schalter',s);
  const z=await C.zaehleTokens('Hallo Welt, wie geht es?','openai');
  check(z.verfahren==='o200k_exakt'&&z.tokens>0&&z.tokens<20,'openai: o200k exakt',z);
  check(C.modellFamilie('codex','codex/gpt-6')==='openai'&&C.modellFamilie('claude','opus')==='anthropic'&&C.modellFamilie(null,'x')==='sonstige','Modellfamilien');
  check((await C.zaehleTokens('abcdefgh',null)).verfahren==='zeichen_4'||(await C.zaehleTokens('abcdefgh','sonstige')).tokens===2,'sonstige: Zeichen/4');
  const lang='Antwort '.repeat(400);
  const t1=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'Frage eins',runtime:'claude',modell:'opus',lauf_id:'lauf-b2'});
  const w1=C.starteVerlaufAntwort(t1.antwort_id,{...zk(t1,'lauf-b2'),user_text:'Frage eins'});
  w1.ereignis('delta',{content:lang});w1.ereignis('usage',{inputTokens:5000,outputTokens:800,cacheReadInputTokens:0,cacheCreationInputTokens:0});
  await w1.abschliessen('fertig');
  let alle=(await C.leseVerlauf()).eintraege;
  const e1=alle.find(e=>e.id===t1.antwort_id),u1=alle.find(e=>e.id===t1.user_id);
  check(u1?.tokens.berechnet?.tokens>0&&u1.tokens.berechnet.verfahren==='zeichen_kalibriert','User-Zeile berechnet (claude kalibriert)',u1?.tokens);
  check(e1?.tokens.berechnet?.tokens===Math.ceil(lang.length/3.5),'Antwort berechnet mit Startfaktor 3.5',e1?.tokens);
  check(e1?.kontext?.quelle==='max'&&e1.kontext.tokens===5800,'erster Zug: Grundlast kalibriert, Kontext = max(gemessen, berechnet)',e1?.kontext);
  const kal=await C.leseKalibrierung(MAIN,'anthropic');
  check(kal?.messungen===1&&Math.abs(kal.faktor-lang.length/800)<0.01,'Kalibrierfaktor aus gemessener Ausgabe',kal);
  const t2=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'Frage zwei',runtime:'claude',modell:'opus',lauf_id:'lauf-b2'});
  const w2=C.starteVerlaufAntwort(t2.antwort_id,{...zk(t2,'lauf-b2'),user_text:'Frage zwei'});
  w2.ereignis('delta',{content:'kurz'});
  await w2.abschliessen('fertig');
  alle=(await C.leseVerlauf()).eintraege;
  const e2=alle.find(e=>e.id===t2.antwort_id);
  check(e2?.kontext?.quelle==='berechnet'&&e2.kontext.tokens>5800,'ohne Messung: berechneter Kontext = Grundlast + Summe',e2?.kontext);
  const vb=await pool.query('SELECT messart,output_tokens FROM agent_verbrauch WHERE referenz=$1',['verlauf:'+t2.antwort_id]);
  check(vb.rowCount===1&&vb.rows[0].messart==='berechnet','ohne CLI-usage: genau eine berechnete Buchung (messart)',vb.rows);
  check(e2?.verbrauch_referenzen.includes('verlauf:'+t2.antwort_id),'Buchungs-Referenz im Verlauf');
  check((await pool.query('SELECT 1 FROM agent_verbrauch WHERE referenz=$1',['verlauf:'+t1.antwort_id])).rowCount===0,'mit CLI-usage keine berechnete Buchung');
  const t3=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'dauerhaft',runtime:'claude',modell:'opus',lauf_id:'lauf-b2'});
  const w3=C.starteVerlaufAntwort(t3.antwort_id,{...zk(t3,'lauf-b2'),user_text:'dauerhaft'});
  w3.ereignis('runtime',{hauptagent:{weg:'dauerhaft',schritt:'arbeitet'}});w3.ereignis('delta',{content:'x'});
  await w3.abschliessen('fertig');
  check((await pool.query('SELECT 1 FROM agent_verbrauch WHERE referenz=$1',['verlauf:'+t3.antwort_id])).rowCount===0,'dauerhafter Weg: nie berechnet buchen (bucht der Wrapper)');
  const st=await C.verlaufStatus();
  check(st.token_zaehlung?.schalter.aktiv===true&&st.token_zaehlung.kalibrierung?.anthropic&&st.token_zaehlung.kalibrierung?.grundlast?.['lauf-b2']>=0,'verlaufStatus zeigt Zaehlung, Kalibrierung, Grundlast',st.token_zaehlung);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_token_zaehlung',aktiv:false,grund:'Test T63 B AUS'},{system:'user'});
 });

 await section('Stufe 2 A2/A3/C/D: alle Richtungen, Sitzung, Korridor, Uebergabe',async()=>{
  const ein=async f=>C.setzeProfilProduktSchalter({ebene:'global',funktion:f,aktiv:true,grund:'Test T63 Stufe 2 '+f},{system:'user'});
  // A2 AUS: nichts
  const zst={message_id:1,weg:'inbox',absender:{agent_id:'koordinator',identity_id:null,rolle:'koordinator',project:'synapse'},empfaenger:{identity_id:MAIN,agent_id:'hauptagent'},inhalt:'Bitte Stand melden',gesendet_am:new Date().toISOString()};
  check(await C.schreibeZustellVerlauf(MAIN,4711,zst,{response:'x'})===null,'A2 Schalter AUS: Zustellung nicht im Verlauf');
  for(const f of ['verlauf_alle_richtungen','verlauf_token_zaehlung','main_korridor','verlauf_uebergabe'])await ein(f);
  const z=await C.schreibeZustellVerlauf(MAIN,4711,zst,{response:'Stand: alles gruen',tokens:{input:100,output:20}});
  check(z?.nachricht_id&&z.antwort_id,'A2: Nachricht + Antwort angelegt',z);
  let alle=(await C.leseVerlauf()).eintraege;
  const n=alle.find(e=>e.id===z?.nachricht_id),a=alle.find(e=>e.id===z?.antwort_id);
  check(n?.rolle==='nachricht'&&n.richtung==='ein'&&n.weg==='inbox'&&n.absender?.agent_id==='koordinator'&&n.text==='Bitte Stand melden'&&n.quelle_ref==='zustellung:4711','A2: Nachricht mit Weg, Absender, vollem Inhalt, quelle_ref',n);
  check(a?.antwort_auf===z?.nachricht_id&&a.text==='Stand: alles gruen'&&a.hauptagent_weg==='dauerhaft'&&a.tokens.gemessen?.input===100&&a.weg==='inbox','A2: Antwort des Main mit gemessenen Tokens',a);
  check(await C.schreibeZustellVerlauf(MAIN,4711,zst,{response:'nochmal'})===null,'A2: idempotent je Ledger-Zeile');
  // A3
  const {sitzungsEintraegeAus}=await load('packages/agents/dist/verlauf-melden.js');
  const zeilen=[
   JSON.stringify({type:'user',uuid:'u1',timestamp:'2026-10-20T10:00:00Z',message:{role:'user',content:'Wake: Bitte pruefen'}}),
   JSON.stringify({type:'assistant',uuid:'a1',message:{role:'assistant',model:'opus',content:[{type:'thinking',thinking:'ueberlege'},{type:'tool_use',id:'t1',name:'channel',input:{action:'post',content:'Hallo Team'}}]}}),
   JSON.stringify({type:'user',uuid:'r1',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:[{type:'text',text:'gepostet #42'}]}]}}),
   JSON.stringify({type:'assistant',uuid:'a2',message:{id:'m2',role:'assistant',model:'opus',content:[{type:'text',text:'Erledigt.'}],usage:{input_tokens:5,output_tokens:2}}}),
   'kein json', JSON.stringify({type:'summary',summary:'x'}),
  ];
  const ez=sitzungsEintraegeAus(zeilen);
  check(ez.length===5&&ez.map(e=>e.art).join(',')==='eingabe,denken,werkzeug_aufruf,werkzeug_ergebnis,text','A3 Parser: alle Arten in Reihenfolge',ez.map(e=>e.art));
  check(ez[3].inhalt==='gepostet #42'&&ez[2].inhalt.content==='Hallo Team'&&ez[2].name==='channel','A3 Parser: voller Inhalt',ez);
  check((await C.importiereSitzungsEintraege('fremd',ez,{runtime:'claude'})).grund==='nicht_main','A3: fremde Identitaet -> nicht_main');
  const im=await C.importiereSitzungsEintraege(MAIN,ez,{runtime:'claude'});
  check(im.aufgenommen===5&&im.grund===null,'A3: 5 Eintraege aufgenommen',im);
  check((await C.importiereSitzungsEintraege(MAIN,ez,{runtime:'claude'})).aufgenommen===0,'A3: idempotent je ref');
  const js=(await pool.query("SELECT rolle,richtung,weg,text,zaehlt,meta,tokens FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref LIKE 'jsonl:%' ORDER BY id",[MAIN])).rows;
  const tu=js.find(r=>r.meta.art==='werkzeug_aufruf'),tr=js.find(r=>r.meta.art==='werkzeug_ergebnis'),dk=js.find(r=>r.meta.art==='denken');
  check(tu?.rolle==='ausgabe'&&tu.richtung==='aus'&&tu.weg==='werkzeug'&&tu.meta.name==='channel'&&JSON.parse(tu.text).content==='Hallo Team','A3: eigener Channel-Post als Werkzeugaufruf (aus, voll)',tu);
  check(tr?.rolle==='nachricht'&&tr.richtung==='ein'&&tr.text==='gepostet #42','A3: Werkzeug-Ergebnis (ein)',tr);
  check(dk?.zaehlt===false&&tu.tokens.berechnet?.tokens>0,'A3: Denkphase zaehlt nicht, berechnete Tokens je Eintrag',{dk,t:tu?.tokens});
  // Spiegel: dauerhafter Web-UI-Zug bei alle_richtungen EIN
  const ts=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'dauerhaft gespiegelt',runtime:'claude',modell:'opus'});
  const ws=C.starteVerlaufAntwort(ts.antwort_id,{modell:'opus',identity_id:MAIN,user_id:ts.user_id,user_text:'dauerhaft gespiegelt',runtime:'claude',drossel_ms:5});
  ws.ereignis('runtime',{hauptagent:{weg:'dauerhaft'}});ws.ereignis('delta',{content:'ok'});await ws.abschliessen('fertig');
  const sp=(await pool.query('SELECT id::text AS id,zaehlt FROM hauptagent_verlauf WHERE id IN ($1,$2)',[ts.user_id,ts.antwort_id])).rows;
  check(sp.length===2&&sp.every(r=>r.zaehlt===false),'A3: Web-UI-Zeilen des dauerhaften Wegs sind Spiegel (zaehlt false)',sp);
  // C1
  const k={tokens:150000,quelle:'gemessen',modell:'opus',fenster:200000,prozent:75,handoff:146000,rotation:176000,hard:176000,schwellen_quelle:'fallback'};
  check(await C.pruefeMainKorridor(MAIN,{...k,tokens:1000},'lauf-k')==='nichts','C1: unter Handoff nichts');
  check(await C.pruefeMainKorridor(MAIN,k,'lauf-k')==='nichts','C1: ohne zugewiesene Runtime nichts');
  const spalten=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_runtime_instances' AND is_nullable='NO' AND column_default IS NULL",[schema])).rows;
  const wert={runtime:'claude',container_name:'t63-claude',role:'main'};
  const werte=spalten.map(s=>wert[s.column_name]??(s.data_type==='boolean'?false:s.data_type.includes('int')?0:s.data_type.includes('json')?'{}':s.data_type.includes('time')?new Date():'x'));
  await pool.query(`INSERT INTO agent_runtime_instances(${spalten.map(s=>'\"'+s.column_name+'\"').join(',')}) VALUES(${spalten.map((_,i)=>'$'+(i+1)).join(',')})`,werte);
  await pool.query("UPDATE agent_runtime_instances SET assigned_to_main=true WHERE runtime='claude'");
  check(await C.zugewieseneMainRuntime()==='claude','C1: zugewiesene Main-Runtime');
  check(await C.pruefeMainKorridor(MAIN,k,'lauf-k')==='handoff','C1: ab Handoff-Schwelle Handoff-Wake');
  check(await C.pruefeMainKorridor(MAIN,k,'lauf-k')==='nichts','C1: Handoff nur einmal je Lauf');
  const wj=(await pool.query("SELECT action,args FROM specialist_jobs WHERE project=$1 AND action IN ('wake','rotate') ORDER BY created_at",[C.HAUPTAGENT_PROJEKT])).rows;
  check(wj.length===1&&wj[0].action==='wake'&&wj[0].args.target_runtime==='claude'&&String(wj[0].args.message).includes('trigger_respawn'),'C1: Wake-Job an den Container-Daemon',wj);
  check(await C.pruefeMainKorridor(MAIN,{...k,tokens:180000},'lauf-k')==='rotation','C1: ab Rotationsschwelle Rotation');
  const rj=(await pool.query("SELECT args FROM specialist_jobs WHERE project=$1 AND action='rotate'",[C.HAUPTAGENT_PROJEKT])).rows;
  check(rj.length===1&&rj[0].args.target_runtime==='claude'&&rj[0].args.name==='hauptagent','C1: rotate-Job mit target_runtime',rj);
  check(await C.pruefeMainKorridor(MAIN,{...k,tokens:180000},'lauf-k2')==='rotation','C1: neuer Lauf, neue Pruefung');
  // C2
  const d=await C.maybeTriggerRespawn(C.HAUPTAGENT_PROJEKT,'hauptagent',{ueberDaemon:true});
  check(d.triggered===false&&/Hauptagent laeuft nicht/.test(d.message),'C2: Main-Weg statt Projektpfad (ohne laufenden Main kein Neustart)',d);
  // D
  const ueb=(await pool.query("SELECT id,content,tags FROM thoughts WHERE project=$1 AND 'verlauf-uebergabe'=ANY(tags) ORDER BY timestamp",[C.HAUPTAGENT_PROJEKT])).rows;
  check(ueb.length===2&&ueb[0].content.startsWith('VERLAUF-UEBERGABE')&&ueb[0].content.includes('## Kurzstand')&&ueb[0].tags.includes('session-uebergabe'),'D: Korridor-Neustart erzeugt Uebergabe-Thought (Handoff-Tags)',ueb.map(x=>x.tags));
  const u=await C.erzeugeVerlaufUebergabe(MAIN,{runtime:'codex',modell:'codex/gpt-6'},'runtime_wechsel');
  check(u&&u.zuege>0&&u.tokens>0,'D: Uebergabe mit vollen Zuegen, gezaehlt fuer die Zielfamilie',u);
  const th=(await pool.query('SELECT content,source,source_identity_id FROM thoughts WHERE id=$1',[u?.thought_id])).rows[0];
  check(th?.source==='hauptagent'&&th.source_identity_id===MAIN&&th.content.includes('Stand: alles gruen')&&th.content.includes('openai'),'D: Inhalt aus dem Verlauf, Quelle Main, Ziel codex (o200k)',th?.content?.slice(0,300));
  const sys=(await pool.query("SELECT text,meta,zaehlt FROM hauptagent_verlauf WHERE identity_id=$1 AND weg='wechsel' ORDER BY id DESC LIMIT 1",[MAIN])).rows[0];
  check(sys?.text.startsWith('Wechsel ')&&sys.text.includes('Kontext uebergeben')&&sys.meta.thought_id===u?.thought_id&&sys.zaehlt===false,'D: Verlaufseintrag Wechsel X -> Y',sys);
  const an=await pool.query(`SELECT id FROM thoughts WHERE project=$1 AND (source_identity_id=$2 OR source='hauptagent') AND tags && ARRAY['auto-handoff','session-state','session-uebergabe']::text[] ORDER BY "timestamp" DESC LIMIT 1`,[C.HAUPTAGENT_PROJEKT,MAIN]);
  check(an.rows[0]?.id===u?.thought_id,'D: die Anmeldung liefert die Uebergabe als juengsten Handoff');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_uebergabe',aktiv:false,grund:'Test T63 D AUS'},{system:'user'});
  check(await C.erzeugeVerlaufUebergabe(MAIN,{runtime:'claude',modell:'opus'},'x')===null,'D: Schalter AUS -> keine Uebergabe');
  check((await C.verlaufStatus()).letzte_uebergabe?.thought_id===u?.thought_id,'Status zeigt letzte Uebergabe');
  for(const f of ['verlauf_alle_richtungen','verlauf_token_zaehlung','main_korridor'])await C.setzeProfilProduktSchalter({ebene:'global',funktion:f,aktiv:false,grund:'Test T63 Stufe 2 AUS'},{system:'user'});
 });

 await section('Reine Funktionen',async()=>{
  const st=C.neuerAntwortStand();
  check(C.wendeStromEreignisAn(st,'unbekannt',{})===false&&C.wendeStromEreignisAn(st,'delta',{content:''})===false,'unbekannt/leer aendert nichts');
  check(C.wendeStromEreignisAn(st,'error',{message:'kaputt'})===true&&st.hinweise[0]==='Runtime-Fehler: kaputt','error -> Hinweiszeile');
  check(C.geraetAusUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0')==='Edge · Windows','Edge/Windows');
  check(C.geraetAusUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')==='Safari · iOS','Safari/iOS');
  check(C.geraetAusUserAgent(undefined)===null,'ohne User-Agent null');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T63: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
