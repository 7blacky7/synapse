/**
 * P22-T109: Container-Kontingent setzen durch User immer; Koordinator (eigenes Projekt, auch Legacy) und Main nur mit
 * Produkt-Schalter kontingent_delegiert und user_auftrag. Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node packages/core/tests/container-kontingent-p22-t109.test.mjs
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
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
globalThis.fetch=async()=>{throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t109_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let pool,checks=0;
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+JSON.stringify(detail)));}}

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
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-container-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 const P='p109-'+randomUUID().slice(0,6),Q='p109q-'+randomUUID().slice(0,6),USER={art:'user'},LK={art:'legacy_koordinator',agent_id:'koordinator'};
 const K=randomUUID(),M=randomUUID(),S=randomUUID(),KQ=randomUUID();
 const ident=async(id,project,agent,rolle)=>pool.query("INSERT INTO agent_identitaeten(id,project,agent_id,name,rolle,status,erstellt_von) VALUES($1,$2,$3,$3,$4,'aktiv','test-t109')",[id,project,agent,rolle]);
 await ident(K,P,'k109','koordinator');await ident(M,P,'m109','main');await ident(S,P,'s109','subagent');await ident(KQ,Q,'kq109','koordinator');
 const pr=(id,project,rolle)=>({art:'identitaet',principal:{art:'identity',identity_id:id,project,rolle,agent_id:'x'}});
 const KOORD=pr(K,P,'koordinator'),MAIN=pr(M,P,'main'),SUB=pr(S,P,'subagent'),FREMD=pr(KQ,Q,'koordinator');
 const setz=(akteur,extra={})=>C.fuehreContainerAdminAus('container_kontingent',{project:P,kontingent_modus:'setzen',container_agenten_max:5,grund:'Test T109',...extra},akteur);
 const AUFTRAG='User 24.10.: dann trag 100 ein';

 // Schalter AUS (Standard): nur User
 check((await C.leseProfilProduktSchalter('kontingent_delegiert',P)).aktiv===false,'kontingent_delegiert Standard AUS');
 for(const [n,a] of [['Koordinator',KOORD],['Main',MAIN],['Legacy',LK]]){
  const r=await setz(a,{user_auftrag:AUFTRAG});
  check(r.error==='recht_fehlt'&&!!r.details?.freigabe_weg,n+' ohne Schalter -> recht_fehlt',r);
 }
 const u=await setz(USER);
 check(u.success===true&&u.kontingent.container_agenten_max===5&&u.kontingent.gesetzt_von==='user','User setzt ohne Schalter',u);
 check(u.kontingent_delegiert?.aktiv===false&&u.kontingent_delegiert.wer_setzt==='nur user','Status zeigt delegiert AUS',u.kontingent_delegiert);

 // 'alle' schaltet ihn nicht
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test T109 alle'},{system:'user'});
 check((await C.leseProfilProduktSchalter('kontingent_delegiert',P)).aktiv===false,'alle schaltet kontingent_delegiert nicht');
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'kontingent_delegiert',aktiv:true,grund:'Test T109 EIN'},{system:'user'});

 // Schalter EIN
 check((await setz(KOORD)).error==='user_auftrag_fehlt','Koordinator ohne user_auftrag -> user_auftrag_fehlt');
 const k=await setz(KOORD,{user_auftrag:AUFTRAG,container_agenten_max:100});
 check(k.success===true&&k.kontingent.container_agenten_max===100&&k.kontingent.gesetzt_von==='koordinator:'+K&&k.kontingent.grund.includes(AUFTRAG),'Koordinator setzt 100 mit Zitat',k);
 const m=await setz(MAIN,{user_auftrag:AUFTRAG,container_agenten_max:7});
 check(m.success===true&&m.kontingent.container_agenten_max===7&&m.kontingent.gesetzt_von==='main:'+M,'Main setzt mit Zitat',m);
 const l=await setz(LK,{user_auftrag:AUFTRAG,container_agenten_max:8});
 check(l.success===true&&l.kontingent.gesetzt_von==='legacy:koordinator','Legacy-Koordinator setzt mit Zitat',l);
 check((await setz(SUB,{user_auftrag:AUFTRAG})).error==='recht_fehlt','Subagent -> recht_fehlt');
 check((await setz(FREMD,{user_auftrag:AUFTRAG})).error==='recht_fehlt','Koordinator fremdes Projekt -> recht_fehlt');
 await pool.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1",[M]).catch(()=>pool.query("UPDATE agent_identitaeten SET rolle='subagent' WHERE id=$1",[M]));
 check((await setz(MAIN,{user_auftrag:AUFTRAG})).error==='recht_fehlt','Main nicht aktiv in PG -> recht_fehlt');
 check((await setz(KOORD,{user_auftrag:AUFTRAG,container_agenten_max:101})).error==='container_agenten_max_ungueltig','101 ungueltig');
 const st=await C.fuehreContainerAdminAus('container_kontingent',{project:P},MAIN);
 check(st.success===true&&st.kontingent_delegiert.aktiv===true,'Main darf Status lesen',st);
 check((await C.fuehreContainerAdminAus('container_kontingent',{project:P},SUB)).error==='recht_fehlt','Subagent Status -> recht_fehlt');
 // Schalter wieder AUS -> Altverhalten
 await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'kontingent_delegiert',aktiv:false,grund:'Test T109 AUS'},{system:'user'});
 check((await setz(KOORD,{user_auftrag:AUFTRAG})).error==='recht_fehlt','Schalter AUS -> Koordinator wieder recht_fehlt');
}catch(e){failures.push('Abbruch: '+e.message);console.error(e.stack);}
finally{
 await pool?.end?.().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});await admin.end();
}
console.log((failures.length?'FEHLER':'OK')+' P22-T109: '+(checks-failures.length)+'/'+checks+' Checks');
process.exit(failures.length?1:0);
