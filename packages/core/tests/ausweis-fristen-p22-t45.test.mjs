/**
 * P22-T45: Ausweis-Fristen als Einstellung (Schema 117, EINE Lesestelle agent-ausweis-fristen.ts).
 * Prueft: Standard (= Altverhalten 24 h / 10 min / 30 min), global, projekt, Rangfolge + Quelle, Wirkung auf NEUE Fristen
 * (Schatten-Anlage, Ausweis-Ausstellung), laufende bleiben, Entfernen, Rechte (User, Koordinator, Legacy-Koordinator,
 * Subagent, fremder Koordinator, global nur User), Validierung, Lesefehler -> Standard, Puffer, REST GET/PUT,
 * MCP-Schema (Aktion/Parameter), keine Env und keine Hartwerte mehr im Quelltext.
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/ausweis-fristen-p22-t45.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T45_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE',
 'SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_AGENT_START_TOKEN_TTL_MIN'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',
 SYNAPSE_ONBOARDING_RUHE_MIN:'0',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t45_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t45-projekt',Q='p22-t45-anderes';
const failures=[];let core,pool,checks=0,app;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-ausweis-fristen-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},DAEMON={art:'daemon'};
 const akt=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',project,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
 const ident=(id,project,name,rolle)=>pool.query('INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,1,$3,$4,$5)',[id,project,name,rolle,'test']);
 await ident('t45-k',P,'t45-koord','koordinator');await ident('t45-s',P,'t45-sub','subagent');await ident('t45-kq',Q,'t45-koord-q','koordinator');
 const KO=akt('t45-k',P,'koordinator'),SU=akt('t45-s',P,'subagent'),KQ=akt('t45-kq',Q,'koordinator');
 const adm=(args,akteur,agent)=>C.fuehreW1bAdminAus('ausweis_fristen',{project:P,...(agent?{agent_id:agent}:{}),...args},{akteur});
 const ttlSek=async token=>Number((await pool.query('SELECT EXTRACT(epoch FROM gueltig_bis-NOW()) AS t FROM agent_identitaet_tokens WHERE token_offen=$1',[token])).rows[0].t);
 const neuerAusweis=async name=>(await C.stelleAgentTokenAus({project:P,name,erstnutzung:true},{system:'daemon'})).token;
 const schatten=async agent=>C.W1B_DIENSTE.schatten.legeSchattenprofilAn({project:P,ursprung_agent_id:agent,ursprung_art:'legacy_register',selbstangaben:{}},DAEMON);
 const dauerH=s=>(Date.parse(s.ablauf_am)-Date.parse(s.erstellt_am))/3600e3;
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test P22-T45 Kern EIN'},{system:'user'});

 await section('Standard = Altverhalten, Quelle standard',async()=>{
  const st=await C.leseAusweisFristen(P);
  const f=st.fristen;
  check(st.letzter_fehler===null,'Lesen ohne Fehler');
  check(f.schatten_stunden.wert===24&&f.schatten_stunden.ms===86400000&&f.schatten_stunden.quelle==='standard','Schatten Standard 24 h');
  check(f.erstnutzung_minuten.wert===10&&f.erstnutzung_minuten.ms===600000&&f.erstnutzung_minuten.quelle==='standard','Erstnutzung Standard 10 min');
  check(f.visum_minuten.wert===30&&f.visum_minuten.quelle==='standard','Visum Standard 30 min (vorgesehen)');
  check(f.arbeitsfreigabe_stunden.wert===24&&f.arbeitsfreigabe_stunden.ms===86400000&&f.arbeitsfreigabe_stunden.quelle==='standard','Arbeitsfreigabe Standard 24 h (vorgesehen)');
  check(await C.schattenFristMs(P)===86400000&&await C.erstnutzungFristMs(P)===600000,'Kurzformen liefern Standard');
  const t=await neuerAusweis('t45-std');
  const s=await ttlSek(t);check(s>590&&s<=600,'neuer Ausweis: Erstnutzungsfrist 10 min ('+Math.round(s)+' s)');
  const sch=await schatten('t45-leg-std');check(Math.abs(dauerH(sch)-24)<0.001,'neuer Schatten: 24 h');
  const r=await adm({},USER);
  check(r.success===true&&r.modus==='status'&&r.ausweis_fristen.fristen.erstnutzung_minuten.quelle==='standard','admin status (Standard-modus) zeigt Wert + Quelle');
 });

 let laufend;
 await section('global (User) und projekt (Koordinator): Rangfolge, Quelle, Wirkung nur auf neue Fristen',async()=>{
  laufend=await neuerAusweis('t45-laufend');const vorher=(await pool.query('SELECT gueltig_bis FROM agent_identitaet_tokens WHERE token_offen=$1',[laufend])).rows[0].gueltig_bis.toISOString();
  const g=await adm({modus:'setzen',ebene:'global',schatten_stunden:2,erstnutzung_minuten:5,grund:'Test global'},USER);
  check(g.success===true,'User setzt global ('+(g.error??'ok')+')');
  let f=(await C.leseAusweisFristen(P)).fristen;
  check(f.schatten_stunden.wert===2&&f.schatten_stunden.quelle==='global'&&f.schatten_stunden.global===2&&f.schatten_stunden.projekt===null,'Schatten global 2 h');
  check(f.erstnutzung_minuten.wert===5&&f.erstnutzung_minuten.quelle==='global'&&f.erstnutzung_minuten.gesetzt_von==='user','Erstnutzung global 5 min, gesetzt_von user');
  check(f.visum_minuten.quelle==='standard','nicht gesetzter Wert bleibt Standard');
  const ag=await adm({modus:'setzen',ebene:'global',arbeitsfreigabe_stunden:48,grund:'Test Arbeitsfreigabe'},USER);
  check(ag.success===true&&ag.ausweis_fristen.fristen.arbeitsfreigabe_stunden.wert===48&&ag.ausweis_fristen.fristen.arbeitsfreigabe_stunden.quelle==='global','Arbeitsfreigabe global 48 h, Quelle global');
  const ap=await adm({modus:'setzen',arbeitsfreigabe_stunden:12,grund:'Test Arbeitsfreigabe Projekt'},USER);
  check(ap.ausweis_fristen.fristen.arbeitsfreigabe_stunden.wert===12&&ap.ausweis_fristen.fristen.arbeitsfreigabe_stunden.quelle==='projekt','Arbeitsfreigabe Projekt 12 h vor global');
  const ax=await adm({modus:'setzen',arbeitsfreigabe_stunden:721,grund:'Test Grenze'},USER);
  check(ax.error==='frist_ungueltig','Arbeitsfreigabe 721 h abgelehnt');
  await adm({modus:'entfernen',frist_namen:['arbeitsfreigabe_stunden'],grund:'Test zurueck'},USER);
  await adm({modus:'entfernen',ebene:'global',frist_namen:['arbeitsfreigabe_stunden'],grund:'Test zurueck'},USER);
  const p=await C.mitAgentAufrufKontext({principal:KO.principal,bezug:{modus:'beide',standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},()=>adm({modus:'setzen',erstnutzung_minuten:3,grund:'Test projekt'},KO));
  check(p.success===true,'Koordinator setzt Projektwert ('+(p.error??'ok')+')');
  f=p.ausweis_fristen.fristen;
  check(f.erstnutzung_minuten.wert===3&&f.erstnutzung_minuten.quelle==='projekt'&&f.erstnutzung_minuten.global===5&&f.erstnutzung_minuten.projekt===3,'Projekt vor global, beide sichtbar');
  check(f.erstnutzung_minuten.gesetzt_von==='t45-k','gesetzt_von = Koordinator-Identitaet');
  const fq=(await C.leseAusweisFristen(Q)).fristen;
  check(fq.erstnutzung_minuten.wert===5&&fq.erstnutzung_minuten.quelle==='global','anderes Projekt: global 5');
  const t=await neuerAusweis('t45-neu');const s=await ttlSek(t);
  check(s>170&&s<=180,'neuer Ausweis nutzt Projektwert 3 min ('+Math.round(s)+' s)');
  const nachher=(await pool.query('SELECT gueltig_bis FROM agent_identitaet_tokens WHERE token_offen=$1',[laufend])).rows[0].gueltig_bis.toISOString();
  check(vorher===nachher,'laufende Erstnutzungsfrist bleibt unveraendert');
  const sch=await schatten('t45-leg-neu');check(Math.abs(dauerH(sch)-2)<0.001,'neuer Schatten nutzt global 2 h');
 });

 await section('Entfernen: Rueckfall auf naechste Ebene',async()=>{
  const e=await adm({modus:'entfernen',frist_namen:['erstnutzung_minuten'],grund:'Test entfernen'},null,'koordinator');
  check(e.success===true,'Legacy-Koordinator entfernt Projektwert ('+(e.error??'ok')+')');
  const f=e.ausweis_fristen.fristen;
  check(f.erstnutzung_minuten.wert===5&&f.erstnutzung_minuten.quelle==='global'&&f.erstnutzung_minuten.projekt===null,'Rueckfall auf global 5');
  const g=await adm({modus:'entfernen',ebene:'global',frist_namen:['erstnutzung_minuten','schatten_stunden'],grund:'Test global weg'},USER);
  check(g.success===true&&g.ausweis_fristen.fristen.erstnutzung_minuten.quelle==='standard'&&g.ausweis_fristen.fristen.schatten_stunden.wert===24,'global entfernt -> Standard');
 });

 await section('Rechte',async()=>{
  const ctx=(a,f)=>C.mitAgentAufrufKontext({principal:a.principal,bezug:{modus:'beide',standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},f);
  const sub=await ctx(SU,()=>adm({modus:'setzen',erstnutzung_minuten:7,grund:'Test Subagent'},SU));
  check(sub.success===false&&sub.error==='recht_fehlt','Subagent darf nicht setzen');
  const subLesen=await ctx(SU,()=>adm({},SU));
  check(subLesen.success===false&&subLesen.error==='recht_fehlt','Subagent: auch status nur Verwaltung (wie profil_schalter_status)');
  const kg=await ctx(KO,()=>adm({modus:'setzen',ebene:'global',erstnutzung_minuten:6,grund:'Test Koord global'},KO));
  check(kg.success===true&&kg.ausweis_fristen.fristen.erstnutzung_minuten.global===6&&kg.ausweis_fristen.fristen.erstnutzung_minuten.gesetzt_von==='t45-k','Koordinator darf global setzen (Grundsatz 3a)');
  const lg=await adm({modus:'setzen',ebene:'global',erstnutzung_minuten:9,grund:'Test Legacy global'},null,'koordinator');
  check(lg.success===true&&lg.ausweis_fristen.fristen.erstnutzung_minuten.global===9&&lg.ausweis_fristen.fristen.erstnutzung_minuten.gesetzt_von==='legacy:koordinator','Legacy-Koordinator darf global setzen');
  const sg=await ctx(SU,()=>adm({modus:'setzen',ebene:'global',erstnutzung_minuten:7,grund:'Test Subagent global'},SU));
  check(sg.success===false&&sg.error==='recht_fehlt','Subagent darf global nicht setzen');
  const lge=await adm({modus:'entfernen',ebene:'global',frist_namen:['erstnutzung_minuten'],grund:'Test Legacy global weg'},null,'koordinator');
  check(lge.success===true&&lge.ausweis_fristen.fristen.erstnutzung_minuten.global===null,'Legacy-Koordinator entfernt globalen Wert');
  const fremd=await ctx(KQ,()=>adm({modus:'setzen',erstnutzung_minuten:7,grund:'Test fremd'},KQ));
  check(fremd.success===false&&fremd.error==='recht_fehlt','Koordinator eines anderen Projekts darf nicht setzen');
  const ohne=await adm({modus:'setzen',erstnutzung_minuten:7,grund:'Test ohne'},null,'irgendwer');
  check(ohne.success===false&&ohne.error==='recht_fehlt','ohne Akteur kein Recht');
  check((await pool.query("SELECT count(*)::int n FROM agent_ausweis_fristen WHERE wert=7")).rows[0].n===0,'nichts geschrieben');
 });

 await section('Validierung',async()=>{
  for(const [args,code,label] of [
   [{modus:'setzen',erstnutzung_minuten:0,grund:'Test Grenze'},'frist_ungueltig','0 abgelehnt'],
   [{modus:'setzen',schatten_stunden:721,grund:'Test Grenze'},'frist_ungueltig','721 h abgelehnt'],
   [{modus:'setzen',visum_minuten:1.5,grund:'Test Grenze'},'frist_ungueltig','keine Ganzzahl abgelehnt'],
   [{modus:'setzen',grund:'Test leer'},'fristen_fehlen','ohne Werte abgelehnt'],
   [{modus:'setzen',erstnutzung_minuten:4,grund:'x'},'grund_fehlt','Grund Pflicht'],
   [{modus:'entfernen',frist_namen:['quatsch'],grund:'Test Name'},'frist_name_ungueltig','unbekannter Name abgelehnt'],
   [{modus:'loeschen',grund:'Test Modus'},'modus_ungueltig','unbekannter Modus abgelehnt'],
   [{modus:'setzen',ebene:'welt',erstnutzung_minuten:4,grund:'Test Ebene'},'ebene_ungueltig','unbekannte Ebene abgelehnt'],
  ]){const r=await adm(args,USER);check(r.success===false&&r.error===code,label+' ('+(r.error??'ok')+')');}
  const v=await adm({modus:'setzen',erstnutzung_minuten:0,grund:'Test Grenze'},USER);
  check(v.details?.name==='erstnutzung_minuten'&&v.details?.min===1&&v.details?.max===1440,'Fehler nennt Name und Bereich');
 });

 await section('Lesefehler -> Standard mit letzter_fehler; Puffer',async()=>{
  await adm({modus:'setzen',erstnutzung_minuten:4,grund:'Test Puffer'},USER);
  await pool.query('ALTER TABLE agent_ausweis_fristen RENAME TO agent_ausweis_fristen_weg');
  // synapse_test kann public.agent_ausweis_fristen enthalten (search_path schema,public). public wird NICHT angefasst
  // (gemeinsame Testdatenbank): eine Fehler-View gleichen Namens im privaten Schema verdeckt public und macht das Lesen
  // unmoeglich (Spalten fehlen) - das ist der Lesefehler-Fall.
  await pool.query('CREATE VIEW agent_ausweis_fristen AS SELECT 1 AS kein_fristen_schema');
  try{
   const st=await C.leseAusweisFristen(P,{frisch:true});
   check(st.letzter_fehler==='ausweis_fristen_nicht_lesbar'&&st.fristen.erstnutzung_minuten.wert===10&&st.fristen.erstnutzung_minuten.quelle==='standard','Tabelle fehlt -> Standard + letzter_fehler');
  }finally{
   await pool.query('DROP VIEW agent_ausweis_fristen');
   await pool.query('ALTER TABLE agent_ausweis_fristen_weg RENAME TO agent_ausweis_fristen');
  }
  process.env.SYNAPSE_W1B_GATE_TTL_MS='60000';C.leereAusweisFristenCache();
  try{
   check((await C.leseAusweisFristen(P)).fristen.erstnutzung_minuten.wert===4,'Puffer gefuellt (4)');
   await pool.query("UPDATE agent_ausweis_fristen SET wert=6 WHERE name='erstnutzung_minuten'");
   check((await C.leseAusweisFristen(P)).fristen.erstnutzung_minuten.wert===4,'innerhalb der TTL gepuffert');
   check((await C.leseAusweisFristen(P,{frisch:true})).fristen.erstnutzung_minuten.wert===6,'frisch umgeht den Puffer');
   await adm({modus:'setzen',erstnutzung_minuten:8,grund:'Test Puffer leeren'},USER);
   check((await C.leseAusweisFristen(P)).fristen.erstnutzung_minuten.wert===8,'Setzen leert den Puffer im eigenen Prozess');
  }finally{process.env.SYNAPSE_W1B_GATE_TTL_MS='0';C.leereAusweisFristenCache();}
  await adm({modus:'entfernen',ebene:'projekt',frist_namen:['erstnutzung_minuten'],grund:'Test Aufraeumen'},USER);
 });

 await section('REST GET/PUT (Web-UI-Weg)',async()=>{
  const rreq=createRequire(join(root,'packages/rest-api/package.json'));
  const Fastify=rreq('fastify');app=(Fastify.default??Fastify)({logger:false});
  const R=await load('packages/rest-api/dist/routes/agent-profil.js');
  await R.registerAgentProfilRoutes(app,{validateToken:async()=>({kind:'session',scope:null})});
  const h={authorization:'Bearer web-ui'};
  const g=await app.inject({method:'GET',url:'/api/projects/'+P+'/agent-profile/ausweis-fristen',headers:h});
  const gj=g.json();
  check(g.statusCode===200&&gj.ausweis_fristen?.fristen?.schatten_stunden?.quelle==='standard','GET liefert Stand mit Quelle');
  const p=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/ausweis-fristen',headers:h,payload:{schatten_stunden:12,grund:'Test REST'}});
  const pj=p.json();
  check(p.statusCode===200&&pj.ausweis_fristen.fristen.schatten_stunden.wert===12&&pj.ausweis_fristen.fristen.schatten_stunden.quelle==='projekt','PUT setzt Projektwert (Standard-modus setzen)');
  const f=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/ausweis-fristen',headers:h,payload:{schatten_stunden:0,grund:'Test REST'}});
  check(f.statusCode===400&&f.json().error?.code==='frist_ungueltig','PUT ungueltig -> 400 frist_ungueltig');
  const u=await app.inject({method:'GET',url:'/api/projects/'+P+'/agent-profile/ausweis-fristen'});
  check(u.statusCode===401,'ohne Bearer 401');
 });

 await section('MCP-Schema und Quelltext',async()=>{
  check(C.W1B_ADMIN_ACTIONS.includes('ausweis_fristen'),'admin-Aktion ausweis_fristen im Schema');
  for(const k of ['schatten_stunden','erstnutzung_minuten','visum_minuten','arbeitsfreigabe_stunden','frist_namen'])check(!!C.W1B_ADMIN_PARAMETER[k],'admin-Parameter '+k);
  check(C.SCHATTEN_FRIST_MS===undefined,'SCHATTEN_FRIST_MS entfallen');
  const treffer=[];
  const lauf=d=>{for(const n of readdirSync(d)){const p=join(d,n);if(n==='node_modules'||n==='dist')continue;
   if(statSync(p).isDirectory())lauf(p);else if(/\.(ts|tsx|mjs|js)$/.test(n)&&!p.includes('/tests/')){
    const t=readFileSync(p,'utf8');if(t.includes('SYNAPSE_AGENT_START_TOKEN_TTL_MIN')||t.includes('SCHATTEN_FRIST_MS')||/24\s*\*\s*3_?600_?000/.test(t)&&p.includes('agent-profil'))treffer.push(p.replace(root,''));}}};
  for(const pk of ['core','rest-api','mcp-server','file-watcher-daemon-ts'])lauf(join(root,'packages',pk,'src'));
  check(treffer.length===0,'keine Env/Hartwerte mehr im Quelltext: '+treffer.join(', '));
  const sql=readFileSync(join(root,'packages/core/src/db/schema-sql/117_agent_ausweis_fristen.sql'),'utf8');
  const {AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL:ts}=await load('packages/core/dist/db/agent-ausweis-fristen-schema.js');
  check(sql.trim()===ts.trim(),'117 SQL-Spiegel identisch zum Laufzeitschema');
  // P22-T50: einzige Ausnahme = Ersetzen des Namens-CHECK (neuer Wert anmeldung_plaene_minuten); keine Daten, keine Tabelle.
  const ohneCheckErsatz=sql.replace(/--.*$/gm,'').replace('ALTER TABLE agent_ausweis_fristen DROP CONSTRAINT IF EXISTS agent_ausweis_fristen_name_check;','');
  check(!/DROP|DELETE|TRUNCATE/i.test(ohneCheckErsatz),'117 additiv (ausser Namens-CHECK-Ersatz P22-T50)');
  check((sql.match(/DROP/g)||[]).length===1,'117: genau ein DROP (Namens-CHECK)');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T45: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(app)await app.close().catch(()=>{});
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
