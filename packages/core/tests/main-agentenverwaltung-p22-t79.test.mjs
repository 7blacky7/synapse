/**
 * P22-T79 (Befund d93b8a2e): Agenten-Verwaltung des Main in User-Projekten. Nur synapse_test:5433, eigenes privates Schema.
 *   node packages/core/tests/main-agentenverwaltung-p22-t79.test.mjs
 * Schalter main_agentenverwaltung AUS -> Bestand (main_nur_lesen). EIN -> Positivliste (admin agent_vorbereiten, specialist status ...)
 * passiert die Ausweis-Grenze mit Principal = Main; Projektarbeit (thought add, profil_schalter_setzen) bleibt main_nur_lesen;
 * pruefeProfilVerwalter laesst den Main nur mit dem Kontext-Flag zu.
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG',
 'SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_HINWEIS_BUDGET_MS:'5000',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t79v_'+process.pid+'_'+randomUUID().slice(0,8);
const A='p22-t79v-a',SRV='srv-t79v';
const failures=[];let core,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}else console.log('ok   '+label);}

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.t79v_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 core=await load('packages/core/dist/index.js');const pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-verbrauch-schema','agent-entfernung-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 for(const f of ['117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql','124_hauptagent_verlauf.sql','128_agent_startkontext.sql'])await pool.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'};
 const T=await load('packages/core/dist/services/agent-token-tools.js');
 const V=await load('packages/core/dist/services/agent-profil-verwalter.js');
 const S=await load('packages/core/dist/services/hauptagent-sonderstellung.js');
 const aufruf=async(tool,args,arbeit)=>{let k;const r=await T.mitAgentToolAufruf(tool,args,SRV,async x=>{k=x;return arbeit?arbeit(x):{success:true};});return {k,r};};
 const sp=(await pool.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='projects' AND is_nullable='NO' AND column_default IS NULL",[schema])).rows;
 const werte={name:A,path:'/tmp/'+A,enabled:true};
 await pool.query(`INSERT INTO projects(${sp.map(s=>'"'+s.column_name+'"').join(',')}) VALUES(${sp.map((_,i)=>'$'+(i+1)).join(',')})`,
  sp.map(s=>werte[s.column_name]??(s.data_type==='boolean'?false:s.data_type.includes('int')?0:s.data_type.includes('json')?'{}':s.data_type.includes('time')?new Date():'x')));
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T79v Ausweis-Kern'},{system:'user'});
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T79v alle'},{system:'user'});
 await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test T79v hauptagent EIN'});
 const MAIN=(await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'})).identity_id;
 const TOK=(await pool.query('SELECT token_offen FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL LIMIT 1',[MAIN])).rows[0]?.token_offen;
 check(typeof TOK==='string','Main mit Ausweis');
 const vorbereiten=(name,extra={})=>aufruf('admin',{action:'agent_vorbereiten',project:A,agent_name:name,...extra,grund:'Test T79v User-Auftrag',user_auftrag:'User 24.10.: Koordinator anlegen',token:TOK},
  x=>C.fuehreW1bAdminAus('agent_vorbereiten',x.args));

 // Katalog + Standard
 check(C.PROFIL_PRODUKT_FUNKTIONEN.includes('main_agentenverwaltung')&&C.NUR_AUSDRUECKLICH.includes('main_agentenverwaltung'),'Katalog, nur ausdruecklich');
 check(await S.mainVerwaltungAktiv()===false,'Standard AUS (alle schaltet ihn nicht)');
 check(S.mainVerwaltungErlaubt('admin','agent_vorbereiten')&&S.mainVerwaltungErlaubt('specialist','spawn')&&!S.mainVerwaltungErlaubt('specialist','purge')&&!S.mainVerwaltungErlaubt('thought','add'),'Positivliste');

 // AUS = Bestand
 const {k:k0}=await vorbereiten('t79v-aus');
 check(k0.antwort?.error==='main_nur_lesen'&&/main_agentenverwaltung/.test(k0.antwort.message),'AUS: agent_vorbereiten -> main_nur_lesen mit Hinweis',k0.antwort);

 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'main_agentenverwaltung',aktiv:true,grund:'Test T79v EIN'},{system:'user'});
 check(await S.mainVerwaltungAktiv()===true,'EIN gesetzt');
 const {k:k1,r:r1}=await vorbereiten('t79v-koord');
 check(!k1.antwort&&k1.args.project===A,'EIN: Ausweis-Grenze laesst agent_vorbereiten durch',k1.antwort);
 check(r1.success===true&&typeof r1.identity_id==='string','EIN: Main legt Ausweis in A an',mask(JSON.stringify(r1)).slice(0,400));
 const neu=(await pool.query('SELECT project FROM agent_identitaeten WHERE agent_id=$1',['t79v-koord'])).rows[0];
 check(neu?.project===A,'Identitaet liegt im Projekt A',neu);
 const {r:rk}=await vorbereiten('t79v-koord2',{rolle:'koordinator'});
 const rolleK=(await pool.query('SELECT rolle FROM agent_identitaeten WHERE agent_id=$1',['t79v-koord2'])).rows[0]?.rolle;
 check(rk.success===true&&rolleK==='koordinator','EIN: Main legt KOORDINATOR-Ausweis in A an',{r:mask(JSON.stringify(rk)).slice(0,300),rolleK});
 const {k:k2}=await aufruf('specialist',{action:'status',project:A,name:'t79v-koord',token:TOK});
 check(!k2.antwort,'EIN: specialist status passiert',k2.antwort);
 for(const [tool,args] of [['thought',{action:'add',content:'x'}],['admin',{action:'profil_schalter_setzen',profil_funktion:'verbrauch',aktiv:true,grund:'x'}],['specialist',{action:'purge',name:'x'}]]){
  const {k}=await aufruf(tool,{...args,project:A,token:TOK});
  check(k.antwort?.error==='main_nur_lesen',tool+'.'+args.action+' bleibt main_nur_lesen',k.antwort);
 }
 // Ohne Kontext-Flag kein Main-Recht
 const MP={art:'identitaet',principal:{art:'identity',identity_id:MAIN,project:C.HAUPTAGENT_PROJEKT,rolle:'main',agent_id:'hauptagent'}};
 let f=null;try{await V.pruefeProfilVerwalter(MP,A);}catch(e){f=e.code;}
 check(f==='recht_fehlt','pruefeProfilVerwalter: Main ohne Kontext-Flag -> recht_fehlt',f);
 check(await V.mainVerwaltetProjekt(MP,A)===null,'mainVerwaltetProjekt ohne Flag -> null');
 // AUS wieder -> Bestand
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'main_agentenverwaltung',aktiv:false,grund:'Test T79v AUS'},{system:'user'});
 const {k:k3}=await vorbereiten('t79v-aus2');
 check(k3.antwort?.error==='main_nur_lesen','AUS danach: wieder main_nur_lesen',k3.antwort);
 console.log('P22-T79 Agenten-Verwaltung: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
