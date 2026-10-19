/**
 * P6-T49: offene files-Plaene laufen nach der Frist files_plan_stunden ohne Aktivitaet ab; Koordinator/User verwerfen
 * fremde offene Plaene ausdruecklich (cancel mit grund), Agenten weiterhin nur eigene.
 * Prueft: Plan aelter als Frist -> expired (Ops bleiben, Vermerk, nichts geschrieben, commit danach nicht moeglich);
 * juenger -> bleibt; Wait-Bewegung zaehlt als Aktivitaet; Frist geaendert (Projektwert) -> wirkt, Debug Wert + Quelle;
 * Koordinator-cancel fremd mit grund ok (verworfen_fremd); Subagent-cancel fremd abgelehnt (fremd_verwerfen_abgelehnt);
 * Koordinator mit zu kurzem grund -> nur eigene; Frist-Einstellung im admin-Schema; open_plans-Hinweis nennt Frist + Quelle
 * und die Kompaktierung behaelt diesen Satz.
 * Nur synapse_test:5433, eigenes privates Schema (Kopie der public-Tabellen), keine Modelle/Netz/Daemon.
 *   node packages/core/tests/file-plan-ablauf-p6-t49.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_AGENT_NAME'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_W1B_GATE_TTL_MS:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p6_t49_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p6-t49-projekt';
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail!==undefined?' - '+mask(JSON.stringify(detail)):''));}}
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
 // Schema 117 (Namens-CHECK um files_plan_stunden erweitert) im privaten Schema anwenden, zweimal = idempotent.
 const {AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL:fristenSql}=await load('packages/core/dist/db/agent-ausweis-fristen-schema.js');
 await pool.query(fristenSql);await pool.query(fristenSql);
 const ablauf=await load('packages/core/dist/services/file-plan-ablauf.js');
 const batch=await load('packages/core/dist/services/file-batch.js');
 const op=(agent,datei)=>({file_path:datei,action:'create',content:'inhalt '+datei+'\n',agent_id:agent});
 const plan=async(owner,ops,alterStunden)=>(await pool.query(
  `INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,created_at)
   VALUES($1,$2,$3::jsonb,'{}'::jsonb,$4::jsonb,'open',NOW()-($5::double precision*INTERVAL '1 hour')) RETURNING id::text AS id`,
  [P,owner,JSON.stringify(ops),JSON.stringify(ops.map((o,index)=>({index,file_path:o.file_path,action:o.action,ok:true}))),alterStunden])).rows[0].id;
 const zeile=async id=>(await pool.query('SELECT status::text AS status, ops, reason FROM file_batch_plans WHERE id=$1::bigint',[id])).rows[0];

 let alt,jung,mitWait;
 await section('Frist-Einstellung: Standard 48 h, Quelle standard, admin-Schema',async()=>{
  const f=(await core.leseAusweisFristen(P,{frisch:true})).fristen.files_plan_stunden;
  check(f&&f.wert===48&&f.ms===48*3600e3&&f.quelle==='standard'&&f.einheit==='stunden','files_plan_stunden Standard 48 h',f);
  check(f.bereich.min===1&&f.bereich.max===720,'Bereich 1..720 h',f.bereich);
  check(core.AUSWEIS_FRIST_NAMEN.includes('files_plan_stunden'),'Fristname bekannt');
  check(!!core.W1B_ADMIN_PARAMETER.files_plan_stunden,'admin-Parameter files_plan_stunden im Schema');
  check(typeof core.laufeFilesPlaeneAb==='function'&&core.FILES_PLAN_ABLAUF_AKTEUR==='synapse-plan-ablauf','Kern exportiert laufeFilesPlaeneAb');
 });

 await section('Plan aelter als Frist -> expired, juenger bleibt, Wait-Bewegung zaehlt als Aktivitaet',async()=>{
  alt=await plan('p49-a',[op('p49-a','alt.md'),op('p49-b','alt2.md')],72);
  jung=await plan('p49-a',[op('p49-a','jung.md')],24);
  mitWait=await plan('p49-a',[op('p49-a','wait.md')],72);
  // Leerer Traeger von p49-b (auch 72 h alt) mit frisch bewegtem Wait auf mitWait: beide zaehlen als aktiv.
  const traeger=await plan('p49-b',[],72);
  await pool.query(`INSERT INTO file_batch_waits(source_plan_id,project,waiting_agent,primary_agent,shared_files,deferred_ops,deferred_op_indexes,primary_plan_id,status,expires_at,updated_at)
    VALUES($1::bigint,$2,'p49-b','p49-a',ARRAY['wait.md'],'[]'::jsonb,'{}'::int[],$3::bigint,'waiting',NOW()+INTERVAL '1 hour',NOW())`,[traeger,P,mitWait]);
  const r=await ablauf.laufeFilesPlaeneAb({project:P});
  check(r.fristen[P]?.stunden===48&&r.fristen[P]?.quelle==='standard','Debug: Frist 48 h, Quelle standard im Ergebnis',r.fristen);
  check(r.abgelaufen.some(x=>x.plan_id===alt),'alter Plan im Ergebnis abgelaufen',r);
  check(!r.abgelaufen.some(x=>x.plan_id===jung||x.plan_id===mitWait),'junger Plan / Plan mit frischer Wait-Bewegung nicht abgelaufen',r);
  const a=await zeile(alt),j=await zeile(jung),m=await zeile(mitWait);
  check(a.status==='expired','alter Plan Status expired',a.status);
  check(Array.isArray(a.ops)&&a.ops.length===2,'Ops bleiben lesbar (Historie)',a.ops?.length);
  check(/abgelaufen \(Frist files_plan_stunden/.test(a.reason??'')&&/synapse-plan-ablauf/.test(a.reason??'')&&/Frist abgelaufen: 48 h/.test(a.reason??''),'Vermerk mit Frist im reason',a.reason);
  check(/inkl\. fremder Ops von p49-a, p49-b/.test(a.reason??''),'Vermerk nennt die Autoren (Ablauf verwirft alle Ops)',a.reason);
  check(j.status==='open','junger Plan bleibt open',j.status);
  check(m.status==='open','Plan mit Wait-Aktivitaet bleibt open',m.status);
  const n=(await pool.query('SELECT count(*)::int n FROM code_files WHERE project=$1',[P])).rows[0].n;
  check(n===0,'nichts geschrieben (keine code_files)',n);
  const ev=(await pool.query("SELECT payload FROM agent_events WHERE project=$1 AND event_type='PLAN_CANCELLED'",[P])).rows;
  check(ev.some(e=>/"abgelaufen":true/.test(e.payload)&&/p49-b|p49-a/.test(e.payload+'')||/"abgelaufen":true/.test(e.payload)),'Betroffene bekommen PLAN_CANCELLED mit abgelaufen:true',ev.length);
  let commit;try{commit=await batch.commitBatch({plan_id:alt,agent_id:'p49-a'});}catch(e){commit={success:false,error:e.message};}
  check(commit.success!==true,'commit eines abgelaufenen Plans schreibt nicht',commit);
  const nochmal=await ablauf.laufeFilesPlaeneAb({project:P});
  check(!nochmal.abgelaufen.some(x=>x.plan_id===alt),'zweiter Lauf: abgelaufener Plan nicht erneut',nochmal);
 });

 await section('Frist geaendert (Projektwert 12 h) -> wirkt, Quelle projekt',async()=>{
  await core.setzeAusweisFristen({ebene:'projekt',project:P,werte:{files_plan_stunden:12},grund:'Test P6-T49'},{wer:'user',setter_identity_id:null});
  const r=await ablauf.laufeFilesPlaeneAb({project:P});
  check(r.fristen[P]?.stunden===12&&r.fristen[P]?.quelle==='projekt','Debug: Frist 12 h, Quelle projekt',r.fristen);
  check(r.abgelaufen.some(x=>x.plan_id===jung),'24 h alter Plan laeuft mit 12-h-Frist ab',r);
  check((await zeile(jung)).status==='expired','junger Plan jetzt expired');
  check((await zeile(mitWait)).status==='open','Plan mit frischer Wait-Bewegung bleibt auch bei 12 h');
  let ungueltig;try{await core.setzeAusweisFristen({ebene:'projekt',project:P,werte:{files_plan_stunden:721},grund:'Test Grenze'},{wer:'user',setter_identity_id:null});}catch(e){ungueltig=e.code;}
  check(ungueltig==='frist_ungueltig','721 h abgelehnt',ungueltig);
  await core.setzeAusweisFristen({ebene:'projekt',project:P,entfernen:['files_plan_stunden'],grund:'Test zurueck'},{wer:'user',setter_identity_id:null});
  check((await core.leseAusweisFristen(P,{frisch:true})).fristen.files_plan_stunden.quelle==='standard','Entfernen -> wieder Standard');
 });

 await section('Produkt-Schalter files_plan_ablauf: Standard EIN, projekt AUS stoppt, Recht, Rangfolge, entfernen',async()=>{
  const st=await core.leseFilesPlanAblaufSchalter(P);
  check(st.aktiv===true&&st.quelle==='standard'&&st.letzter_fehler===null,'Schalter Standard EIN, Quelle standard',st);
  const schalterPlan=await plan('p49-a',[op('p49-a','schalter.md')],100);
  const adm=(args,agent)=>core.fuehreW1bAdminAus('ausweis_fristen',{project:P,agent_id:agent,...args},{akteur:null});
  const sub=await adm({modus:'setzen',files_plan_ablauf_aktiv:false,grund:'Test Subagent'},'p49-sub');
  check(sub.success===false&&sub.error==='recht_fehlt','Subagent darf den Schalter nicht setzen',sub);
  const aus=await adm({modus:'setzen',files_plan_ablauf_aktiv:false,grund:'Test Projekt aus'},'koordinator');
  check(aus.success===true&&aus.files_plan_ablauf?.aktiv===false&&aus.files_plan_ablauf?.quelle==='projekt','Koordinator schaltet Projekt AUS (Quelle projekt)',aus);
  const r1=await ablauf.laufeFilesPlaeneAb({project:P});
  check(r1.schalter[P]?.aktiv===false&&r1.schalter[P]?.quelle==='projekt'&&r1.aus.includes(P),'Worker: Schalter AUS mit Quelle im Ergebnis',r1);
  check((await zeile(schalterPlan)).status==='open','Schalter AUS: alter Plan bleibt open');
  await core.setzeFilesPlanAblaufSchalter({ebene:'global',aktiv:false,grund:'Test global aus'},{wer:'user',setter_identity_id:null});
  const an=await adm({modus:'setzen',files_plan_ablauf_aktiv:true,grund:'Test Projekt an'},'koordinator');
  check(an.files_plan_ablauf?.aktiv===true&&an.files_plan_ablauf?.quelle==='projekt'&&an.files_plan_ablauf?.global===false,'Projekt EIN geht vor global AUS',an.files_plan_ablauf);
  const weg=await adm({modus:'entfernen',files_plan_ablauf_aktiv:true,grund:'Test Projektwert weg'},'koordinator');
  check(weg.success===true&&weg.files_plan_ablauf?.aktiv===false&&weg.files_plan_ablauf?.quelle==='global','entfernen: Rueckfall auf global AUS',weg.files_plan_ablauf);
  const st2=await adm({},'koordinator');
  check(st2.success===true&&!!st2.ausweis_fristen?.fristen?.files_plan_stunden&&st2.files_plan_ablauf?.quelle==='global','status zeigt Frist und Schalter mit Quelle',st2.files_plan_ablauf);
  await core.setzeFilesPlanAblaufSchalter({ebene:'global',entfernen:true,grund:'Test global weg'},{wer:'user',setter_identity_id:null});
  const r2=await ablauf.laufeFilesPlaeneAb({project:P});
  check(r2.schalter[P]?.aktiv===true&&r2.schalter[P]?.quelle==='standard'&&r2.abgelaufen.some(x=>x.plan_id===schalterPlan),'wieder Standard EIN: alter Plan laeuft ab',r2);
  let f;try{await core.setzeFilesPlanAblaufSchalter({ebene:'projekt',project:P,aktiv:'ja',grund:'Test ungueltig'},{wer:'user',setter_identity_id:null});}catch(e){f=e.code;}
  check(f==='files_plan_ablauf_aktiv_ungueltig','nicht-boolean abgelehnt',f);
  const ohneWerte=await adm({modus:'setzen',grund:'Test leer'},'koordinator');
  check(ohneWerte.success===false&&ohneWerte.error==='fristen_fehlen','ohne Frist und ohne Schalter weiter fristen_fehlen',ohneWerte);
  check(!!core.W1B_ADMIN_PARAMETER.files_plan_ablauf_aktiv,'admin-Parameter files_plan_ablauf_aktiv im Schema');
 });

 await section('cancel mit grund: Koordinator verwirft fremd, Subagent nicht',async()=>{
  const fremd=await plan('p49-a',[op('p49-a','fremd.md'),op('p49-b','fremd2.md')],1);
  const sub=await batch.cancelBatch(fremd,'p49-sub','Bitte verwerfen',{fremdeVerwerfen:true});
  check(sub.ok===false&&sub.mode==='none'&&sub.fremd_verwerfen_abgelehnt==='nur_koordinator_oder_user','Subagent: fremd abgelehnt',sub);
  check((await zeile(fremd)).status==='open','Plan nach Subagent-cancel weiter open');
  const subAntwort=batch.buildCancelResponse(fremd,sub);
  check(/nur fuer Koordinator\/User/.test(subAntwort.hinweis_fremd??''),'Antwort erklaert die Ablehnung (hinweis_fremd)',subAntwort);
  const kurz=await batch.cancelBatch(fremd,'koordinator','kurz',{fremdeVerwerfen:true});
  check(kurz.ok===false&&kurz.mode==='none'&&kurz.fremd_verwerfen_abgelehnt==='grund_zu_kurz','Koordinator mit zu kurzem grund: nur eigene (keine)',kurz);
  const ohne=await batch.cancelBatch(fremd,'koordinator','Altplan aufraeumen');
  check(ohne.ok===false&&ohne.mode==='none','Koordinator OHNE fremdeVerwerfen: bisheriges Verhalten',ohne);
  const ko=await batch.cancelBatch(fremd,'koordinator','Altplan aufraeumen',{fremdeVerwerfen:true});
  check(ko.ok===true&&ko.status==='cancelled'&&ko.mode==='cancelled','Koordinator mit grund verwirft den ganzen Plan',ko);
  check(JSON.stringify(ko.verworfen_fremd?.sort())===JSON.stringify(['p49-a','p49-b']),'verworfen_fremd nennt die fremden Autoren',ko.verworfen_fremd);
  const z=await zeile(fremd);
  check(z.status==='cancelled'&&/verworfen von koordinator/.test(z.reason??'')&&/Altplan aufraeumen/.test(z.reason??''),'Vermerk wer/warum',z.reason);
  const antwort=batch.buildCancelResponse(fremd,ko);
  check(/inkl\. fremder Ops von/.test(antwort.message),'Antwort nennt fremde Ops',antwort.message);
  const eigen=await plan('p49-sub',[op('p49-sub','eigen.md')],1);
  const se=await batch.cancelBatch(eigen,'p49-sub','Eigenen Plan weg',{fremdeVerwerfen:true});
  check(se.ok===true&&se.status==='cancelled'&&se.fremd_verwerfen_abgelehnt===undefined,'Subagent verwirft eigenen Plan mit grund wie bisher',se);
 });

 await section('open_plans-Hinweis nennt Frist + Quelle; Kompaktierung behaelt den Satz',async()=>{
  const hints=await load('packages/core/dist/services/plan-hints.js');
  const offen=(await pool.query("SELECT count(*)::int n FROM file_batch_plans WHERE project=$1 AND status='open' AND jsonb_array_length(ops)>0",[P])).rows[0].n;
  check(offen>0,'Voraussetzung: offener Plan fuer open_plans vorhanden',offen);
  const h=await hints.claimOpenPlanHints(P,'p49-beobachter-'+process.pid,Date.now(),false,'files');
  check(h&&/^Offene Plaene laufen nach 48 h ohne Aktivitaet ab \(files_plan_stunden, Quelle standard/.test(h.hinweis),'Hinweis nennt Frist und Quelle',h?.hinweis);
  const {baueToolErgebnis}=await load('packages/core/dist/services/tool-antwort.js');
  const k=JSON.parse(baueToolErgebnis({success:true,open_plans:h},{tool:'files',strukturiert:true}).content[0].text);
  check(/^Offene Pläne laufen nach 48 h ohne Aktivitaet ab \(files_plan_stunden, Quelle standard; Status expired, nichts geschrieben\)\. Prüfen:/.test(k.open_plans?.hinweis??''),'kompakt: Frist-Satz bleibt',k.open_plans?.hinweis);
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
 console.log('P6-T49: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
