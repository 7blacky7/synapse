/**
 * P22-T107: admin koordinator_heartbeat (Schalter, Rechte, user_auftrag, Spawn-Einstellung). Nur synapse_test:5433, privates Schema.
 *   node packages/core/tests/koordinator-heartbeat-p22-t107.test.mjs
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t107_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let pool,checks=0;
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+JSON.stringify(detail)));}}
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.t107_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema']){
  const m=await load('packages/core/dist/db/'+file+'.js');await pool.query(Object.values(m).find(v=>typeof v==='string'));
 }
 const H=await load('packages/core/dist/services/koordinator-heartbeat.js');
 const L=await load('packages/core/dist/services/hauptagent-lauf.js');
 const P='p107-'+randomUUID().slice(0,6),USER={art:'user'},K='k107-'+randomUUID().slice(0,6),S='s107-'+randomUUID().slice(0,6);
 const ident=(id,agent,rolle)=>pool.query("INSERT INTO agent_identitaeten(id,project,agent_id,name,rolle,status,erstellt_von) VALUES($1,$2,$3,$3,$4,'aktiv','test')",[id,P,agent,rolle]);
 await ident(K,'koordinator','koordinator');await ident(S,'sub107','subagent');
 const KO={art:'identitaet',principal:{art:'identity',identity_id:K,project:P,rolle:'koordinator',agent_id:'koordinator'}};
 const SU={art:'identitaet',principal:{art:'identity',identity_id:S,project:P,rolle:'subagent',agent_id:'sub107'}};
 const adm=(args,a)=>C.fuehreW1bAdminAus('koordinator_heartbeat',{project:P,...args},{akteur:a});
 check(C.W1B_ADMIN_ACTIONS.includes('koordinator_heartbeat')&&C.NUR_AUSDRUECKLICH.includes('koordinator_heartbeat'),'Aktion + Schalter im Katalog');
 const st=await adm({},USER);
 check(st.success&&st.modus==='status'&&st.schalter.aktiv===false&&st.koordinatoren.length===1&&st.koordinatoren[0].gewuenscht.quelle==='standard','Status: Schalter AUS, Standard',st);
 check((await adm({},SU)).error==='recht_fehlt','Subagent Status -> recht_fehlt');
 check((await adm({ziel_identity_id:K,aktiv:false,grund:'Test T107'},USER)).error==='funktion_aus','Schalter AUS -> funktion_aus');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'koordinator_heartbeat',aktiv:true,grund:'Test T107 EIN'},{system:'user'});
 check((await adm({ziel_identity_id:K,aktiv:false,grund:'Test T107'},KO)).error==='user_auftrag_fehlt','Koordinator ohne user_auftrag');
 const s1=await adm({ziel_identity_id:K,aktiv:true,intervall_ms:60000,grund:'Test T107',user_auftrag:'User: Heartbeat 1 min'},KO);
 check(s1.success&&s1.koordinatoren[0].gewuenscht.aktiv===true&&s1.koordinatoren[0].gewuenscht.intervall_ms===60000,'Koordinator setzt mit user_auftrag',s1);
 check((await adm({ziel_identity_id:K,aktiv:true,intervall_ms:100,grund:'Test T107'},USER)).error==='intervall_ungueltig','Takt < 5000 ungueltig');
 check((await adm({ziel_identity_id:S,aktiv:true,grund:'Test T107'},USER)).error==='ziel_nicht_gefunden','Ziel kein Koordinator');
 const s2=await adm({ziel_identity_id:K,aktiv:false,grund:'Test T107 aus'},USER);
 check(s2.success&&s2.koordinatoren[0].gewuenscht.aktiv===false&&s2.koordinatoren[0].gewuenscht.gesetzt_von==='user','User setzt AUS');
 const au=(await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id=$1 AND aktion='koordinator_heartbeat'",[K])).rows[0].n;
 check(au===2,'Audit je Setzen',au);
 check(JSON.stringify(await H.koordinatorHeartbeatBeimSpawn(P,K))===JSON.stringify({enabled:false,intervalMs:null}),'Spawn nimmt Einstellung');
 check(await H.koordinatorHeartbeatBeimSpawn(P,S)===null,'Spawn Nicht-Koordinator: Standard');
 check(typeof L.heartbeatBeimSpawnFuerZiel==='function','Spawn-Weg vorhanden');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'koordinator_heartbeat',aktiv:false,grund:'Test T107 AUS'},{system:'user'});
 check(await H.koordinatorHeartbeatBeimSpawn(P,K)===null,'Schalter AUS: Spawn wie bisher');
}catch(e){failures.push('Abbruch: '+e.message);console.error(e.stack);}
finally{await pool?.end?.().catch(()=>{});await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();}
console.log((failures.length?'FEHLER':'OK')+' P22-T107: '+(checks-failures.length)+'/'+checks+' Checks');
process.exit(failures.length?1:0);
