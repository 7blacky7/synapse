/**
 * P22-T54: kurze Ausweis-Anmeldung fuer Nicht-Koordinatoren liefert handoff {id, zeit, empfehlung} des neuesten
 * session-uebergabe-Thoughts DIESER Identitaet (End-Thought des vorigen Laufs). synapse_test:5433, privates Schema.
 *   node packages/core/tests/anmeldung-handoff-p22-t54.test.mjs
 * A erster Lauf ohne eigenen End-Thought: handoff fehlt (fremde/Legacy-Thoughts zaehlen nicht).
 * B zweiter Lauf derselben Identitaet sieht den End-Thought des ersten (neuester eigener, nur mit Tag session-uebergabe).
 * C andere Identitaet sieht ihn nicht; Legacy-Thought mit gleichem source-Namen ohne Identitaet zaehlt nie. D nur ID + Zeit + Empfehlung, kein Inhalt.
 * E Koordinator-Kurzform unveraendert. F profilverwaltung AUS: Bestand ohne handoff.
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_W1B_TOKEN_HINWEIS_MS','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_W1B_ANMELDUNG:'1',
  SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_HINWEIS_BUDGET_MS:'5000',SYNAPSE_W1B_GATE_TTL_MS:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t54_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t54-synthetic';
const SRV='srv-t54';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const neuerAusweis=()=>'sai_'+randomBytes(32).toString('hex');

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql','117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const L=await load('packages/core/dist/services/agent-lauf.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  for(const f of ['profilverwaltung','typkatalog','schattenprofile'])
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'Test P22-T54','user')",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agenten_ausweis',true,'Test P22-T54','user')",[P]);
  await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-pflicht-x','rules','Pflichtregel X',$3)",[randomUUID(),P,['pflicht']]);
  const identitaet=async(id,name,agentId,rolle)=>{
    const tok=neuerAusweis();
    await pool.query('INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$4,$5,\'test\')',[id,P,name,agentId,rolle]);
    await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,tok,tok.slice(0,12),'vorbereitet']);
    return tok;
  };
  const tokA=await identitaet('t54-a','sub','sub','subagent');
  const tokB=await identitaet('t54-b','sub#2','sub2','subagent');
  const tokK=await identitaet('t54-koord','koordinator','koordinator','koordinator');
  const th=(id,source,iid,min,tags=['session-uebergabe'],content='GEHEIMER INHALT Uebergabe')=>pool.query(
    `INSERT INTO thoughts(id,project,source,content,tags,"timestamp",source_identity_id) VALUES($1,$2,$3,$4,$5,NOW()-($6||' minutes')::interval,$7)`,[id,P,source,content,tags,String(min),iid]);
  const tokenAufruf=(tool,args,arbeit,optionen)=>T.mitAgentToolAufruf(tool,args,SRV,arbeit,undefined,undefined,optionen);
  const anmelden=tok=>tokenAufruf('chat',{action:'anmelden',token:tok},async k=>k.antwort,{herkunft:'Test'});
  const lauf=async iid=>(await pool.query('SELECT id FROM agent_identitaet_laeufe WHERE identity_id=$1 ORDER BY erstellt_am DESC LIMIT 1',[iid])).rows[0]?.id;

  // fremde/Legacy-Thoughts vorab: gleicher agent_id-Name ohne Identitaet, Koordinator-Handoff
  await th('t54-legacy','sub',null,50);
  await th('t54-koord-h','koordinator','t54-koord',40);

  // ================= A: erster Lauf =================
  const a1=(await anmelden(tokA))?.agentOnboarding;
  const laufA1=await lauf('t54-a');
  check(Array.isArray(a1?.rules)&&!('aktiver_plan' in (a1??{})),'A erster Lauf: kurze Nicht-Koordinator-Anmeldung');
  check(!('handoff' in (a1??{})),'A ohne eigenen End-Thought: handoff fehlt (Legacy gleichen Namens und Koordinator-Handoff zaehlen nicht)');
  // Lauf 1 schreibt End-Thoughts: aelter, neuer, einer ohne Tag (juengster)
  await th('t54-a-alt','sub','t54-a',20);
  await th('t54-a-ende','sub','t54-a',10);
  await th('t54-a-notiz','sub','t54-a',0,['notiz']);

  // ================= B: zweiter Lauf derselben Identitaet =================
  const b1raw=await anmelden(tokA); const b1=b1raw?.agentOnboarding;
  const laufA2=await lauf('t54-a');
  console.log('T54 BEISPIEL '+JSON.stringify(b1?.handoff??null));
  check(!!laufA1&&!!laufA2&&laufA1!==laufA2,'B zweite Anmeldung = neuer Lauf');
  check(b1?.handoff?.id==='t54-a-ende','B zweiter Lauf sieht den neuesten eigenen End-Thought des ersten ('+JSON.stringify(b1?.handoff)+')');
  check(b1?.handoff?.empfehlung==='Zuerst lesen: thought(action:"get", id:"t54-a-ende")'&&!Number.isNaN(Date.parse(b1?.handoff?.zeit??'')),'B handoff mit Zeit + Lese-Empfehlung');
  // ================= D =================
  check(JSON.stringify(Object.keys(b1?.handoff??{}).sort())==='["empfehlung","id","zeit"]'&&!/GEHEIMER INHALT/.test(JSON.stringify(b1raw)),'D nur ID + Zeit + Empfehlung, kein Inhalt');

  // ================= C: andere Identitaet =================
  const c1=(await anmelden(tokB))?.agentOnboarding;
  check(Array.isArray(c1?.rules)&&!('handoff' in (c1??{})),'C andere Identitaet sieht den End-Thought von A nicht');
  await th('t54-b-ende','sub2','t54-b',5);
  const c2=(await anmelden(tokB))?.agentOnboarding;
  const a3=(await anmelden(tokA))?.agentOnboarding;
  check(c2?.handoff?.id==='t54-b-ende'&&a3?.handoff?.id==='t54-a-ende','C jede Identitaet nur ihr eigener End-Thought (B juenger, A bleibt bei eigenem)');

  // ================= E: Koordinator-Kurzform unveraendert =================
  const k1=(await anmelden(tokK))?.agentOnboarding;
  check(k1?.zustellung?.koordinator_kurz===true&&k1?.handoff?.id==='t54-koord-h','E Koordinator-Kurzform: handoff wie bisher');

  // ================= F: profilverwaltung AUS =================
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'profilverwaltung',false,'Test P22-T54 aus','user')",[P]);
  L.leereLaufPuffer();
  const f1=(await anmelden(tokA))?.agentOnboarding;
  check(Array.isArray(f1?.rules)&&!('handoff' in (f1??{})),'F profilverwaltung AUS: Bestand (volles Onboarding) ohne handoff');
  L.leereLaufPuffer();
}catch(e){
  failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
  await pool?.end().catch(()=>{});
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await admin.end();
}
console.log(`\nP22-T54: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
