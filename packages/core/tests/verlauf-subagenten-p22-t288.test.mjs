/**
 * P22-T288 A3/W7 (Analyse efbe02f1): eine Schreibstelle importiereSitzungsEintraege.
 *  - cliEingabeAbsender: '<teammate-message teammate_id="X"' -> { agent_id: X, herkunft: 'teammate' }; bestehende Formen unveraendert.
 *  - tokens_gemessen aus der CLI (Wrapper/Daemon) nur bei verlauf_token_zaehlung EIN, quelle cli_usage; AUS -> keine Tokens (wie bisher).
 *  - herkunft api: gemessen immer, quelle anbieter_gemessen (P22-T286 unveraendert).
 * Nur synapse_test:5433, eigenes privates Schema, kein Netz.
 *   node packages/core/tests/verlauf-subagenten-p22-t288.test.mjs
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
const schema='p22_t288_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let checks=0,pool;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
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
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','hauptagent-verlauf-schema','agent-startkontext-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const USER={art:'user'},P='p288-'+randomUUID().slice(0,6);
 const H=await load('packages/core/dist/services/hauptagent-verlauf.js');
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T288 alle'},{system:'user'});
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_token_zaehlung',aktiv:false,grund:'Test T288 Ausgang AUS'},{system:'user'});
 await pool.query("INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,'pc-host',true)",[P,'/home/test/'+P]);
 const vb=await C.mitUserHerkunft('web-ui-chat',()=>C.fuehreW1bAdminAus('agent_vorbereiten',{project:P,agent_name:'claude-sub',grund:'Test T288'},{akteur:USER}));
 const A=vb.identity_id;
 check(!!A,'Identitaet claude-sub vorbereitet',vb);
 const zeile=async ref=>(await pool.query('SELECT tokens, absender FROM hauptagent_verlauf WHERE identity_id=$1 AND quelle_ref=$2',[A,ref])).rows[0]??null;
 const T={input:2,output:211,cache_read:22803,cache_creation:11234,kontext:34039};

 await section('A3: teammate-message als Absender, bestehende Formen unveraendert',async()=>{
  check(JSON.stringify(H.cliEingabeAbsender('<teammate-message teammate_id="team-lead" summary="x">\nauftrag\n</teammate-message>'))===JSON.stringify({agent_id:'team-lead',herkunft:'teammate'}),'teammate erkannt');
  check(H.cliEingabeAbsender('[cc-send von codex-rea1] fertig').herkunft==='cc_send','cc-send unveraendert');
  check(H.cliEingabeAbsender('mach mal').herkunft==='cli','eigene Eingabe unveraendert');
  check(H.cliEingabeAbsender('Text <teammate-message teammate_id="x"> mitten drin').herkunft==='cli','teammate nur am Anfang');
  const r=await C.importiereSitzungsEintraege(A,[{ref:'t1:0',art:'eingabe',inhalt:'<teammate-message teammate_id="team-lead">\nlos\n</teammate-message>'}],{runtime:'claude',herkunft:'cli'});
  check(r.aufgenommen===1,'Eingabe aufgenommen',r);
  const z=await zeile('jsonl:t1:0');
  check(z?.absender?.agent_id==='team-lead'&&z?.absender?.herkunft==='teammate','Absender in PG',z?.absender);
 });

 await section('W7: CLI-usage nur bei verlauf_token_zaehlung EIN (cli_usage)',async()=>{
  check((await C.leseTokenZaehlSchalter()).aktiv===false,'verlauf_token_zaehlung Standard AUS');
  await C.importiereSitzungsEintraege(A,[{ref:'w1:0',art:'text',inhalt:'antwort',tokens_gemessen:T}],{runtime:'claude',herkunft:'cli'});
  const aus=await zeile('jsonl:w1:0');
  check(aus&&JSON.stringify(aus.tokens)==='{}','Schalter AUS: keine Tokens (wie bisher)',aus?.tokens);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_token_zaehlung',aktiv:true,grund:'Test T288 EIN'},{system:'user'});
  await C.importiereSitzungsEintraege(A,[{ref:'w2:0',art:'text',inhalt:'antwort',tokens_gemessen:T}],{runtime:'claude',herkunft:'cli'});
  const g=(await zeile('jsonl:w2:0'))?.tokens?.gemessen;
  check(g&&g.quelle==='cli_usage'&&g.input===2&&g.output===211&&g.cache_read===22803&&g.cache_creation===11234&&g.kontext===34039,'Schalter EIN: gemessen cli_usage',g);
  await C.importiereSitzungsEintraege(A,[{ref:'w3:0',art:'text',inhalt:'ohne usage'}],{runtime:'claude'});
  const b=(await zeile('jsonl:w3:0'))?.tokens;
  check(b&&!b.gemessen&&!!b.berechnet,'ohne usage weiter berechnet (Wrapper-Weg ohne herkunft)',b);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'verlauf_token_zaehlung',aktiv:false,grund:'Test T288 AUS'},{system:'user'});
 });

 await section('W7: API-Weg unveraendert (gemessen immer, anbieter_gemessen)',async()=>{
  await C.importiereSitzungsEintraege(A,[{ref:'p1:0',art:'text',inhalt:'api',tokens_gemessen:{input:5,output:7}}],{runtime:'deepseek-api',herkunft:'api'});
  const g=(await zeile('api:p1:0'))?.tokens?.gemessen;
  check(g&&g.quelle==='anbieter_gemessen'&&g.input===5&&g.output===7,'api: gemessen trotz Schalter AUS',g);
 });
}catch(e){failures.push('Lauf: '+mask(e.message));console.error(mask(e.stack));}
finally{
 try{await pool?.end();}catch{}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch{}
 await admin.end();
}
console.log(failures.length?'FEHLER '+failures.length+'/'+checks:'OK '+checks+'/'+checks);
process.exit(failures.length?1:0);
