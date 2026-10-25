/**
 * P22-T157 (Entwurf e8d2f0dc Fassung 2, GO R1-R8): Sitzungsverlaeufe semantisch durchsuchbar.
 * Prueft: Schema 153 (Spiegel, idempotent, ensureSchema), Zerlegung + Schwaerzung (rein), Ausloeser ueber abgeloesten Lauf und
 * Altersregel, laufende Zeile stoppt den Schnitt, nur Identitaeten mit Ausweis, Prioritaet ganz hinten (Wissen/Code vor Verlauf),
 * Schalter AUS, Suche mit Spanne/Filtern/Pflichtfilter identity_id aus dem Principal, Nachlesen, Wiederaufbau mit gleichen IDs,
 * Fall-Skill. Nur synapse_test:5433, eigenes privates Schema; Embedding/Qdrant ueber setzeVerlaufAbhaengigkeitenFuerTests ersetzt.
 *   node packages/core/tests/verlauf-einbetten-p22-t157.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_VERLAUF_SCORE_MIN','SYNAPSE_VERLAUF_EINBETTEN_ALTER_MIN','SYNAPSE_VERLAUF_STAPEL'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t157_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[A-Za-z0-9_-]{6,}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s"]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail)).slice(0,600)));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-zustellungen-schema','hauptagent-verlauf-schema','main-warteschlange-schema','agent-startkontext-schema','agent-container-schema','verlauf-stuecke-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},P='p157-'+randomUUID().slice(0,6);
 const alsUser=fn=>C.mitUserHerkunft('web-ui-chat',fn);
 const schalter=(funktion,aktiv)=>C.setzeProfilProduktSchalter({ebene:'global',funktion,aktiv,grund:'Test P22-T157 '+funktion},{system:'user'});
 await schalter('alle',true);
 await pool.query("INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,'pc-host',true)",[P,'/home/test/'+P]);

 // Fakes fuer Embedding/Qdrant (die Logik bleibt die echte).
 const einbett=[];let letzteP=null,embedAufrufe=0,sucheAufrufe=0,letzterFilter=null,sucheAntwort=[];
 C.setzeVerlaufAbhaengigkeitenFuerTests({
  betteEin:async ids=>{einbett.push([...ids]);letzteP=await C.verlaufStueckNachzug.lese(ids);await pool.query('UPDATE verlauf_stuecke SET embedded_at=NOW() WHERE id=ANY($1::uuid[])',[ids]);return letzteP.length;},
  embedQuery:async()=>{embedAufrufe++;return [0.1,0.2,0.3];},
  sucheVektoren:async(v,limit,filter)=>{sucheAufrufe++;letzterFilter=filter;return sucheAntwort;},
 });

 await section('Schema 153: Spiegel identisch, idempotent, in ensureSchema',async()=>{
  const sql=readFileSync(join(repo,'packages/core/src/db/schema-sql/153_verlauf_stuecke.sql'),'utf8');
  check(sql.trim()===C.VERLAUF_STUECKE_SCHEMA_SQL.trim(),'153 SQL-Spiegel identisch');
  await pool.query(C.VERLAUF_STUECKE_SCHEMA_SQL);
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS verlauf_stuecke'),'153 im ensureSchema-SQL');
 });

 await section('Zerlegung rein: Zeilentext, Gruppen, Schnitt, Stuecke',async()=>{
  const z=(id,rolle,richtung,weg,text,o={})=>({id:String(id),rolle,richtung,weg,status:o.status??'fertig',text,meta:o.meta??{},absender:o.absender??null,lauf_id:o.lauf??'L1',erstellt_am:o.zeit??new Date(Date.now()-86400000),context_epoch:1});
  check(C.verlaufZeileText(z(1,'ausgabe','intern','lauf','gedacht'))===null,'Denkphase wird nicht eingebettet');
  const aufruf=C.verlaufZeileText(z(2,'ausgabe','aus','werkzeug','x'.repeat(900),{meta:{name:'mcp__synapse__shell'}}));
  check(aufruf.startsWith('→ mcp__synapse__shell: ')&&aufruf.length<=330,'Werkzeugaufruf auf 300 Zeichen verdichtet',aufruf.length);
  const schreib=C.verlaufZeileText(z(3,'ausgabe','aus','werkzeug','y'.repeat(1800),{meta:{name:'SendMessage'}}));
  check(schreib.length>1400&&schreib.length<=1530,'Schreibwerkzeug bis 1500 Zeichen',schreib.length);
  const erg=C.verlaufZeileText(z(4,'nachricht','ein','werkzeug','e'.repeat(900),{meta:{fehler:true}}));
  check(erg.startsWith('← fehler: ')&&erg.length<=230,'Werkzeugergebnis 200 Zeichen mit Fehlerkennung',erg.length);
  check(C.verlaufZeileText(z(5,'nachricht','ein','lauf','Hallo',{absender:{agent_id:'user',herkunft:'cli'}}))==='User (CLI): Hallo','CLI-Eingabe des Users');
  check(C.verlaufZeileText(z(6,'nachricht','ein','channel','Hi',{absender:{agent_id:'koordinator'}}))==='Nachricht (channel) von koordinator: Hi','Zustellung mit Absender');
  // Gruppen + Schnitt
  const zeilen=[z(10,'user','ein','webui','Frage 1'),z(11,'ausgabe','aus','lauf','Antwort 1'),z(12,'user','ein','webui','Frage 2'),z(13,'ausgabe','aus','lauf','Antwort 2')];
  let r=C.zerlegeVerlauf(zeilen,{aktiverLauf:'L2',jetztMs:Date.now(),alterMs:6*3600000,mehrVorhanden:false});
  check(r.gruppen.length===2&&r.bis_id==='13','zwei fertige Gruppen, Schnitt hinter der letzten',r);
  r=C.zerlegeVerlauf([...zeilen,z(14,'ausgabe','aus','lauf','laeuft noch',{status:'laeuft'})],{aktiverLauf:'L2',jetztMs:Date.now(),alterMs:6*3600000,mehrVorhanden:false});
  check(r.gruppen.length===1&&r.bis_id==='11','laufende Zeile stoppt: angefangene Gruppe wartet',r.bis_id);
  r=C.zerlegeVerlauf(zeilen.map(x=>({...x,lauf_id:'L2',erstellt_am:new Date()})),{aktiverLauf:'L2',jetztMs:Date.now(),alterMs:6*3600000,mehrVorhanden:false});
  check(r.gruppen.length===0&&r.bis_id===null,'aktiver Lauf, jung: nichts schnittreif');
  r=C.zerlegeVerlauf(zeilen.map(x=>({...x,lauf_id:'L2',erstellt_am:new Date()})),{aktiverLauf:'L2',jetztMs:Date.now()+7*3600000,alterMs:6*3600000,mehrVorhanden:false});
  check(r.gruppen.length===2,'aktiver Lauf nach der Altersregel schnittreif');
  r=C.zerlegeVerlauf([z(20,'user','ein','webui','Riese'),z(21,'ausgabe','aus','lauf','a'),z(22,'ausgabe','aus','lauf','b')],{aktiverLauf:null,jetztMs:Date.now(),alterMs:1,mehrVorhanden:true});
  check(r.gruppen.length===1&&r.bis_id==='22','Riesengruppe ueber den ganzen Ausschnitt wird erzwungen');
  r=C.zerlegeVerlauf([z(30,'user','ein','webui','A'),z(31,'ausgabe','aus','lauf','a'),z(32,'user','ein','webui','B')],{aktiverLauf:null,jetztMs:Date.now(),alterMs:1,mehrVorhanden:true});
  check(r.gruppen.length===1&&r.bis_id==='31','letzte Gruppe wartet, wenn weitere Zeilen nicht geladen sind');
  // Stuecke
  const teile=C.teileVerlaufText('a'.repeat(4500));
  check(teile.length===3&&teile[0].length===2000&&teile[1].startsWith('a')&&teile.every(t=>t.length<=2000),'Stuecke 2000 Zeichen mit 200 Ueberlappung',teile.map(t=>t.length));
  const st=C.verlaufStueckeAus({von_id:'1',bis_id:'2',zeit_von:new Date('2026-10-25T10:00:00Z'),zeit_bis:new Date('2026-10-25T10:05:00Z'),lauf_id:'abcdef123456',context_epoch:1,rollen:['user'],zeilen:['User: x']},'spez-a');
  check(st.length===1&&st[0].text.startsWith('[spez-a · 2026-10-25 10:00–2026-10-25 10:05 UTC · Lauf abcdef12]\n'),'Kopf je Stueck',st[0]?.text);
  check(C.verlaufStueckId('i','1',0)===C.verlaufStueckId('i','1',0)&&C.verlaufStueckId('i','1',0)!==C.verlaufStueckId('i','1',1),'deterministische Stueck-IDs');
 });

 const GEHEIM=['Geheim123xyz','SuperGeheim99','abcdefghijklmnopqrstuvwxyz123456','PwGeheim77'];
 await section('Schwaerzung rein',async()=>{
  const s=C.schwaerzeVerlaufText('sshpass -p Geheim123xyz ssh root@host\nexport PGPASSWORD=SuperGeheim99\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456\npsql postgres://user:PwGeheim77@db:5432/x');
  for(const g of GEHEIM)check(!s.text.includes(g),'geschwaerzt: '+g.slice(0,6)+'…',s.text);
  check(s.treffer>=3,'Treffer gezaehlt',s.treffer);
 });

 // Identitaeten mit Ausweis
 const vb=async n=>alsUser(()=>C.fuehreW1bAdminAus('agent_vorbereiten',{project:P,agent_name:n,grund:'Test T157'},{akteur:USER}));
 const va=await vb('spez-a'),vbb=await vb('spez-b'),vc=await vb('spez-c');
 const A=va.identity_id,B=vbb.identity_id,CI=vc.identity_id,TOKEN_A=va.token;
 check(!!A&&!!B&&!!CI&&typeof TOKEN_A==='string','drei Identitaeten mit Ausweis vorbereitet');
 const L1='l1-'+randomUUID(),L2='l2-'+randomUUID(),LB='lb-'+randomUUID();
 await pool.query("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status) VALUES ($1,$2,1,'abgeloest'),($3,$2,2,'aktiv'),($4,$5,1,'abgeloest')",[L1,A,L2,LB,B]);
 const alt=Date.now()-2*86400000;
 const zeile=async(identity,{rolle,richtung,weg,text,meta={},absender=null,lauf,zeit,status='fertig'})=>(await pool.query(
  `INSERT INTO hauptagent_verlauf (identity_id,rolle,richtung,weg,absender,status,text,meta,lauf_id,erstellt_am) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10) RETURNING id::text AS id`,
  [identity,rolle,richtung,weg,absender?JSON.stringify(absender):null,status,text,JSON.stringify(meta),lauf,new Date(zeit)])).rows[0].id;
 const ids={};
 ids.g1=await zeile(A,{rolle:'user',richtung:'ein',weg:'webui',text:'Bitte den Deploy pruefen',lauf:L1,zeit:alt});
 await zeile(A,{rolle:'ausgabe',richtung:'aus',weg:'lauf',text:'Ich pruefe mit sshpass -p Geheim123xyz ssh root@unraid und Ausweis '+TOKEN_A,lauf:L1,zeit:alt+60000});
 await zeile(A,{rolle:'ausgabe',richtung:'aus',weg:'werkzeug',text:JSON.stringify({command:'docker ps '+'z'.repeat(900)}),meta:{name:'mcp__synapse__shell',art:'werkzeug_aufruf'},lauf:L1,zeit:alt+61000});
 await zeile(A,{rolle:'nachricht',richtung:'ein',weg:'werkzeug',text:'CONTAINER '+'r'.repeat(900),meta:{art:'werkzeug_ergebnis'},absender:{agent_id:'werkzeug'},lauf:L1,zeit:alt+62000});
 await zeile(A,{rolle:'ausgabe',richtung:'intern',weg:'lauf',text:'DENKPHASE-XYZ',meta:{art:'denken'},lauf:L1,zeit:alt+63000});
 ids.g2=await zeile(A,{rolle:'nachricht',richtung:'ein',weg:'lauf',text:'Zweite Frage zur Qdrant Payload',absender:{agent_id:'user',herkunft:'cli'},meta:{art:'eingabe'},lauf:L1,zeit:alt+120000});
 await zeile(A,{rolle:'ausgabe',richtung:'aus',weg:'lauf',text:'Antwort: is_tenant Index anlegen. export PGPASSWORD=SuperGeheim99',lauf:L1,zeit:alt+121000});
 ids.g2ende=await zeile(A,{rolle:'ausgabe',richtung:'aus',weg:'werkzeug',text:'Nachricht an koordinator: '+'s'.repeat(1400),meta:{name:'SendMessage',art:'werkzeug_aufruf'},lauf:L1,zeit:alt+122000});
 ids.g3=await zeile(A,{rolle:'user',richtung:'ein',weg:'webui',text:'Dritte Frage aktuell zum Nachzug',lauf:L2,zeit:Date.now()-60000});
 await zeile(A,{rolle:'ausgabe',richtung:'aus',weg:'lauf',text:'Antwort drei zum Nachzug',lauf:L2,zeit:Date.now()-50000});
 ids.b1=await zeile(B,{rolle:'user',richtung:'ein',weg:'webui',text:'Fremde Frage von B',lauf:LB,zeit:alt});
 await zeile(B,{rolle:'ausgabe',richtung:'aus',weg:'lauf',text:'Fremde Antwort von B',lauf:LB,zeit:alt+1000});

 await section('Schalter AUS (Standard): nichts zerlegt, Suche funktion_aus',async()=>{
  check((await C.leseVerlaufEinbettSchalter('einbetten')).aktiv===false,'verlauf_einbetten Standard AUS (alle schaltet ihn nicht)');
  check((await C.leseVerlaufEinbettSchalter('suche')).aktiv===false,'verlauf_suche Standard AUS');
  const r=await C.verlaufNachzugSchritt({wissenRest:0});
  check(r.status==='schalter_aus'&&einbett.length===0,'Nachzug bei Schalter AUS tut nichts',r);
  check((await pool.query('SELECT count(*)::int AS n FROM verlauf_stuecke')).rows[0].n===0,'keine Stuecke bei Schalter AUS');
  const s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{query:'Deploy'});
  check(s.success===false&&s.error==='funktion_aus'&&sucheAufrufe===0,'Suche bei Schalter AUS: funktion_aus',s);
 });
 await schalter('verlauf_einbetten',true);await schalter('verlauf_suche',true);

 await section('Ausloeser: abgeloester Lauf wird zerlegt, aktiver erst nach der Altersregel',async()=>{
  const r=await C.zerlegeVerlaufVon(A);
  check(r.neue_stuecke===2&&r.bis_verlauf_id===ids.g2ende,'zwei Gruppen des abgeloesten Laufs, Schnitt vor dem aktiven Lauf',r);
  const st=(await pool.query('SELECT text,lauf_id,context_epoch,rollen,schwaerz_treffer,zerleger_version,embedded_at FROM verlauf_stuecke WHERE identity_id=$1 ORDER BY von_verlauf_id',[A])).rows;
  const alles=st.map(x=>x.text).join('\n');
  for(const g of GEHEIM)check(!alles.includes(g),'kein Geheimnis in verlauf_stuecke: '+g.slice(0,6)+'…');
  check(!alles.includes(TOKEN_A),'kein Ausweis in verlauf_stuecke');
  check(!alles.includes('DENKPHASE-XYZ'),'Denkphase nicht eingebettet');
  check(alles.includes('User: Bitte den Deploy pruefen')&&alles.includes('User (CLI): Zweite Frage')&&alles.includes('→ SendMessage: '),'Zeilentexte in den Stuecken');
  check(st.every(x=>x.lauf_id===L1&&x.context_epoch===1&&x.embedded_at===null&&x.zerleger_version===C.VERLAUF_ZERLEGER_VERSION),'Metadaten lauf_id/context_epoch, noch nicht eingebettet');
  check(st.reduce((n,x)=>n+x.schwaerz_treffer,0)>=2,'Schwaerz-Treffer gezaehlt');
  check((await C.zerlegeVerlaufVon(A)).neue_stuecke===0,'erneuter Lauf: idempotent, nichts Neues');
  const r2=await C.zerlegeVerlaufVon(A,{jetztMs:Date.now()+7*3600000});
  check(r2.neue_stuecke===1,'aktiver Lauf nach 6 h zerlegt',r2);
  await zeile(A,{rolle:'ausgabe',richtung:'aus',weg:'lauf',text:'laeuft gerade',status:'laeuft',lauf:L2,zeit:Date.now()-40000});
  await zeile(A,{rolle:'user',richtung:'ein',weg:'webui',text:'naechste',lauf:L2,zeit:Date.now()-30000});
  check((await C.zerlegeVerlaufVon(A,{jetztMs:Date.now()+7*3600000})).neue_stuecke===0,'laufende Zeile stoppt den Schnitt');
  const stand=(await pool.query('SELECT bis_verlauf_id::text AS bis, stuecke_gesamt FROM verlauf_einbett_stand WHERE identity_id=$1',[A])).rows[0];
  check(stand.stuecke_gesamt===3,'Stand: stuecke_gesamt 3',stand);
 });

 await section('Nur Identitaeten mit Ausweis',async()=>{
  check((await C.zerlegeVerlaufVon(B)).neue_stuecke===1,'B (mit Ausweis) wird zerlegt');
  await pool.query('UPDATE agent_identitaet_tokens SET widerrufen_am=NOW() WHERE identity_id=$1',[B]);
  await zeile(B,{rolle:'user',richtung:'ein',weg:'webui',text:'nach Widerruf',lauf:LB,zeit:alt+5000});
  await zeile(B,{rolle:'user',richtung:'ein',weg:'webui',text:'nach Widerruf 2',lauf:LB,zeit:alt+6000});
  check((await C.zerlegeVerlaufVon(B)).neue_stuecke===0,'ohne gueltigen Ausweis wird nichts mehr zerlegt');
 });

 await section('Prioritaet ganz hinten',async()=>{
  check(await C.verlaufVorrangGrund(0)===null,'alles frei -> Verlauf darf');
  check(await C.verlaufVorrangGrund(3)==='wissen_rueckstand','Wissens-Rueckstand geht vor');
  await pool.query("INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) VALUES ('t157-chunk',$1,'a.ts',0,'x',1,1)",[P]);
  check(await C.verlaufVorrangGrund(0)==='code_rueckstand','offener Code-Chunk (aktives Projekt) geht vor');
  let r=await C.verlaufNachzugSchritt({wissenRest:0});
  check(r.status==='wartet'&&r.wartegrund==='code_rueckstand'&&einbett.length===0,'Nachzug wartet hinter Code',r);
  r=await C.verlaufNachzugSchritt({wissenRest:5});
  check(r.status==='wartet'&&r.wartegrund==='wissen_rueckstand'&&einbett.length===0,'Nachzug wartet hinter Wissen',r);
  await pool.query("DELETE FROM code_chunks WHERE id='t157-chunk'");
  r=await C.verlaufNachzugSchritt({wissenRest:0});
  check(r.status==='ok'&&r.eingebettet===4&&einbett.length===1,'danach wird eingebettet (4 Stuecke A+B)',r);
  const p=(letzteP??[]).find(x=>x.payload.identity_id===A);
  check(!!p&&p.collection===C.VERLAUF_COLLECTION&&typeof p.payload.zeit_von_ts==='number'&&typeof p.payload.zeit_bis_ts==='number'&&!('text' in p.payload),'Payload: identity_id, Zeitbereich, kein Text',p?.payload);
  check((await pool.query('SELECT count(*)::int AS n FROM verlauf_stuecke WHERE embedded_at IS NULL')).rows[0].n===0,'alle Stuecke eingebettet');
  r=await C.verlaufNachzugSchritt({erzwingen:true});
  check(r.status==='ok'&&r.eingebettet===0,'worker_durchlauf (erzwingen) ohne offene Stuecke');
 });

 await section('Suche: Pflichtfilter, Spanne, Filter, Rechte, Nachlesen',async()=>{
  const stA=(await pool.query('SELECT id::text AS id, von_verlauf_id::text AS von FROM verlauf_stuecke WHERE identity_id=$1 ORDER BY von_verlauf_id',[A])).rows;
  const stB=(await pool.query('SELECT id::text AS id FROM verlauf_stuecke WHERE identity_id=$1',[B])).rows;
  let s=await C.sucheVerlauf(null,{query:'Deploy'});
  check(s.success===false&&s.error==='verlauf_ausweis_noetig'&&sucheAufrufe===0,'ohne Ausweis keine Suche',s);
  sucheAntwort=[{id:stA[0].id,score:0.91},{id:stB[0].id,score:0.95},{id:stA[1].id,score:0.1}];
  s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{query:'Deploy pruefen'});
  check(s.success===true&&s.treffer.length===1&&s.treffer[0].verlauf_ids[0]===stA[0].von,'nur eigene Treffer ueber der Score-Grenze (fremde ID verworfen)',s);
  check(letzterFilter?.must?.[0]?.key==='identity_id'&&letzterFilter.must[0].match.value===A,'Pflichtfilter identity_id aus dem Principal zuerst',letzterFilter);
  const seit=letzterFilter.must.find(m=>m.key==='zeit_bis_ts')?.range?.gte,bis=letzterFilter.must.find(m=>m.key==='zeit_von_ts')?.range?.lte;
  check(Math.abs((bis-seit)-7*86400000)<5000&&s.spanne.standard===true,'Standard-Spanne 7 Tage',{seit,bis});
  check(s.treffer[0].auszug.includes('Deploy')&&!/Geheim123xyz/.test(s.treffer[0].auszug),'Auszug aus PG, geschwaerzt',s.treffer[0].auszug);
  check(/verlauf_id:"\d+"/.test(s.treffer[0].nachlesen),'Verweis zum Nachlesen');
  s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{query:'x',seit:'2026-10-01T00:00:00Z',bis:'2026-10-02T00:00:00Z',lauf_id:L1,identity_id:B});
  check(letzterFilter.must[0].match.value===A&&letzterFilter.must.some(m=>m.key==='lauf_id'&&m.match.value===L1),'lauf_id-Filter; identity_id-Argument wirkungslos',letzterFilter);
  check(letzterFilter.must.find(m=>m.key==='zeit_bis_ts').range.gte===Date.parse('2026-10-01T00:00:00Z'),'seit wirkt als Range-Filter');
  s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{query:'x',seit:'kein-datum'});
  check(s.error==='zeit_ungueltig','ungueltige Zeit',s);
  s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{});
  check(s.error==='query_fehlt','ohne query',s);
  s=await C.sucheVerlauf({identity_id:CI,agent_id:'spez-c'},{query:'x'});
  check(s.success===true&&s.ergebnis==='kein_verlauf'&&Array.isArray(s.treffer)&&s.treffer.length===0,'Identitaet ohne Verlauf: kein_verlauf mit Hinweis',s);
  s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{verlauf_id:ids.g1,umfeld:2});
  check(s.success===true&&s.zeilen.some(z=>z.id===ids.g1)&&s.zeilen.length<=5,'Nachlesen: Zeilen rund um verlauf_id',s.zeilen?.length);
  check(!JSON.stringify(s).includes('Geheim123xyz')&&!JSON.stringify(s).includes(TOKEN_A),'Nachlesen geschwaerzt');
  s=await C.sucheVerlauf({identity_id:A,agent_id:'spez-a'},{verlauf_id:ids.b1});
  check(s.success===false&&s.error==='verlauf_id_unbekannt','fremde verlauf_id abgewiesen',s);
  // Tool-Weg: Identitaet nur aus dem Principal
  const bezug={modus:'beide',standard:'beide',quelle:'standard',bis:null,letzter_fehler:null};
  s=await C.mitAgentAufrufKontext({principal:{art:'identity',project:P,agent_id:'spez-a',identity_id:A,rolle:'subagent',modell:null,context_epoch:2,lauf_id:L2},bezug},()=>C.sucheVerlaufTool({query:'Deploy'}));
  check(s.success===true&&letzterFilter.must[0].match.value===A,'sucheVerlaufTool nimmt die Identitaet aus dem Ausweis-Principal',s.error);
  s=await C.mitAgentAufrufKontext({principal:{art:'legacy',project:P,agent_id:'spez-a'},bezug},()=>C.sucheVerlaufTool({query:'Deploy'}));
  check(s.error==='verlauf_ausweis_noetig','Legacy-Principal: verlauf_ausweis_noetig');
  check(embedAufrufe>=3,'Anfrage-Embedding je Suche');
 });

 await section('Wiederaufbau aus PG: gleiche Punkt-IDs',async()=>{
  const vorher=(await pool.query('SELECT id::text AS id FROM verlauf_stuecke ORDER BY id')).rows.map(r=>r.id);
  await pool.query('UPDATE verlauf_stuecke SET embedded_at = NULL WHERE TRUE');
  const n=einbett.length;
  const r=await C.verlaufNachzugSchritt({wissenRest:0});
  check(r.eingebettet===vorher.length&&einbett.length===n+1&&[...einbett[n]].sort().join()===vorher.join(),'Neuaufbau bettet dieselben IDs ein',r);
  const NE=await load('packages/core/dist/services/neu-einbetten.js');
  check(NE.ordneCollectionEin('agent_verlauf').art==='verlauf'&&NE.NEU_EINBETTEN_ARTEN.includes('verlauf'),'neu_einbetten kennt die Art verlauf');
 });

 await section('Debug-Status',async()=>{
  const st=await C.verlaufEinbettStatus();
  const a=st.je_identitaet?.find(x=>x.identity_id===A);
  check(st.schalter?.verlauf_einbetten?.aktiv===true&&!!a&&a.stuecke===3&&a.eingebettet===3&&a.offene_zeilen>=2,'Status: Schalter, Stuecke, offene Zeilen je Identitaet',a);
  check(st.letzter_lauf&&typeof st.letzter_lauf.dauer_ms==='number','Status: letzter Lauf mit Dauer');
 });

 await section('Fall-Skill',async()=>{
  const F=await load('packages/core/dist/services/fall-skills.js');
  check(F.ermittleFallSkill('search',{success:false,error:'verlauf_ausweis_noetig'},'ausweis')?.name==='fall-search-verlauf','Fehlercode -> fall-search-verlauf');
  const seed=readFileSync(join(repo,'skills/seed/fall-skills/wissen-index.json'),'utf8');
  check(JSON.parse(seed)&&seed.includes('"fall-search-verlauf"'),'Seed enthaelt fall-search-verlauf');
 });

 C.setzeVerlaufAbhaengigkeitenFuerTests(null);
 check(network===0,'keine echten Netzwerk-/Modellaufrufe',network);
}finally{
 await core?.closePool?.().catch?.(()=>undefined);
 await pool?.end?.().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end().catch(()=>undefined);
}
console.log(`ERGEBNIS P22-T157: ${checks-failures.length}/${checks} gruen${failures.length?' – FEHLER: '+failures.map(mask).join(' | '):''}`);
process.exit(failures.length?1:0);
