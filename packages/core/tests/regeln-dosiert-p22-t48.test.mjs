/**
 * P22-T48: Regeln dosiert. Dienst-Ebene gegen synapse_test:5433, privates Schema (Harness wie P22-T43).
 *   node packages/core/tests/regeln-dosiert-p22-t48.test.mjs
 * Prueft:
 *   1 Typ-Agent (Ausweis + Typ, Schalter profilverwaltung/typkatalog EIN): beim Anmelden nur Typ-Regeln voll, Rest als Namen
 *     im regel_verzeichnis, Diagnose zustellung.regeln_quelle 'typ' + typ_regeln (fehlend).
 *   2 Legacy-Form (Ausweis ohne Typ bzw. Schalter typkatalog AUS): unveraendert (Pflichtregeln voll, Rest als Auszug).
 *   3 bei:-Regel mit Ausweis OHNE project kommt an, im Lauf nur einmal, nach Regelaenderung erneut, im neuen Lauf erneut;
 *     im Onboarding voll zugestellte Typ-Regel kommt an der Handlung nicht doppelt.
 *   4 Ohne Ausweis: Bestand (ohne project keine Regeln, mit project bei jedem Aufruf).
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
const schema='p22_t48_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t48-synthetic';
const SRV='srv-t48';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const neuerAusweis=()=>'sai_'+randomBytes(32).toString('hex');
const namen=a=>(a??[]).map(r=>r.name).sort().join(',');

let pool;
try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const L=await load('packages/core/dist/services/agent-lauf.js');
  const O=await load('packages/core/dist/services/agent-onboarding.js');
  const W=await load('packages/core/dist/services/werkzeug-regeln.js');
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  pool=getPool();

  for(const f of ['profilverwaltung','typkatalog','schattenprofile'])
    await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,true,'Test P22-T48','user')",[f]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agenten_ausweis',true,'Test P22-T48','user')",[P]);
  check((await SCH.leseAusweisKern(P)).aktiv===true,'Ausweis-Kern fuer Testprojekt EIN');
  const regel=(name,content,tags)=>pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,$3,'rules',$4,$5)",[randomUUID(),P,name,content,tags]);
  await regel('regel-pflicht-x','Pflichtregel X',['pflicht']);
  await regel('regel-normal-y','Normale Regel Y '+'lang '.repeat(80),[]);
  await regel('regel-typ-a','Typ-Regel A',['bei:files.plan']);
  await regel('regel-typ-b','Typ-Regel B nur Koordinator getaggt',['koordinator-only']);
  await regel('regel-bei-shell','Shell-Regel Version 1',['bei:shell.exec']);
  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t48-typ','projekt',$1,'t48-tester',1,'test')",[P]);
  await pool.query("INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('t48-typ',1,$1,'test')",[JSON.stringify({regeln:['regel-typ-a','regel-typ-b','regel-fehlt']})]);
  const tokenAufruf=(tool,args,arbeit,optionen)=>T.mitAgentToolAufruf(tool,args,SRV,arbeit,undefined,undefined,optionen);
  const identitaet=async(id,agent,typ)=>{
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von,typ_id) VALUES($1,$2,$3,$3,'subagent','test',$4)",[id,P,agent,typ]);
    const t=neuerAusweis();
    await pool.query('INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,t,t.slice(0,12),'vorbereitet']);
    return t;
  };
  const anmelden=tok=>tokenAufruf('chat',{action:'anmelden',token:tok},async k=>k.antwort,{herkunft:'Test'});
  const werkzeug=(tok,tool,action)=>tokenAufruf(tool,{action,token:tok},async k=>{
    if(k.antwort)return {abgelehnt:k.antwort};
    return W.holeWerkzeugRegeln(undefined,tool,action);
  });

  // ================= 1: Typ-Agent beim Anmelden =================
  const tokT=await identitaet('t48-typ-agent','typagent','t48-typ');
  const a1=await anmelden(tokT);
  const ob=a1?.agentOnboarding;
  check(a1?.success===true&&!!ob,'1: Anmeldung Typ-Agent ok');
  check(namen(ob?.rules)==='regel-typ-a,regel-typ-b'&&ob.rules.every(r=>r.vollstaendig&&typeof r.content==='string'),'1: nur Typ-Regeln voll ('+namen(ob?.rules)+')');
  check(ob?.rules?.some(r=>r.name==='regel-typ-b'),'1: Typ-Regel trotz koordinator-only-Tag voll (Typ benennt sie)');
  const vz=ob?.regel_verzeichnis;
  check(vz?.regeln?.includes('regel-pflicht-x')&&vz.regeln.includes('regel-normal-y')&&vz.regeln.includes('regel-bei-shell'),'1: uebrige Regeln (auch pflicht) nur als Namen im Verzeichnis');
  check(!vz?.regeln?.includes('regel-typ-a'),'1: Typ-Regel nicht doppelt im Verzeichnis');
  check(JSON.stringify(vz?.typ_regeln?.fehlend)==='["regel-fehlt"]'&&vz?.typ_regeln?.typ?.schluessel==='t48-tester','1: Diagnose typ_regeln (fehlend, Typ)');
  check(ob?.zustellung?.regeln_quelle==='typ'&&JSON.stringify(ob.zustellung.aus_typ)==='["regel-typ-a","regel-typ-b"]'&&ob.zustellung.als_verzeichnis===vz?.regeln?.length,'1: zustellung zeigt Quelle typ, aus_typ, als_verzeichnis');
  check(!ob?.volltext_hinweis,'1: kein Kuerzungshinweis (nichts gekuerzt geliefert)');
  const f1=await tokenAufruf('thought',{action:'search',query:'x',token:tokT},async()=>O.holeAgentOnboarding({project:P,agentId:'typagent',serverInstanceId:SRV}));
  check(f1===null,'1: Folgeaufruf im selben Lauf ohne erneute Regeln');
  const lauf1=(await pool.query("SELECT id,zugestellt_regeln_stand FROM agent_identitaet_laeufe WHERE identity_id='t48-typ-agent' AND status='aktiv'")).rows[0];
  check(!!lauf1?.zugestellt_regeln_stand,'1: Regelstand im Lauf markiert');

  // ================= 3: bei:-Regeln mit Ausweis =================
  const w1=await werkzeug(tokT,'shell','exec');
  check(!w1?.abgelehnt&&namen(w1)==='regel-bei-shell','3: bei:-Regel mit Ausweis ohne project kommt an');
  const w2=await werkzeug(tokT,'shell','exec');
  check(Array.isArray(w2)&&w2.length===0,'3: im selben Lauf nur einmal');
  const p1=await werkzeug(tokT,'files','plan');
  check(Array.isArray(p1)&&p1.length===0,'3: im Onboarding voll zugestellte Typ-Regel (bei:files.plan) nicht doppelt an der Handlung');
  await pool.query("UPDATE memories SET content='Shell-Regel Version 2' WHERE project=$1 AND name='regel-bei-shell'",[P]);
  const w3=await werkzeug(tokT,'shell','exec');
  check(namen(w3)==='regel-bei-shell'&&w3[0].content==='Shell-Regel Version 2','3: nach Regelaenderung erneut (neuer Inhalt)');
  const w4=await werkzeug(tokT,'shell','exec');
  check(Array.isArray(w4)&&w4.length===0,'3: geaenderte Regel danach wieder nur einmal');
  const marken=(await pool.query("SELECT sitzung,hinweis_id FROM agent_identitaet_hinweis_zustellungen WHERE identity_id='t48-typ-agent' AND quelle_id='werkzeug_regeln'")).rows;
  check(marken.length>=3&&marken.every(m=>m.sitzung==='lauf:'+lauf1.id),'3: Zustellmarken an die lauf_id gekoppelt (Debug)');
  // neuer Lauf (anmelden) -> Typ-Regeln und bei:-Regeln wieder
  const a2=await anmelden(tokT);
  check(namen(a2?.agentOnboarding?.rules)==='regel-typ-a,regel-typ-b','3: neuer Lauf: Typ-Regeln wieder voll');
  const lauf2=(await pool.query("SELECT id FROM agent_identitaet_laeufe WHERE identity_id='t48-typ-agent' AND status='aktiv'")).rows[0];
  check(lauf2?.id&&lauf2.id!==lauf1.id,'3: anmelden beginnt neuen Lauf');
  const w5=await werkzeug(tokT,'shell','exec');
  check(namen(w5)==='regel-bei-shell','3: neuer Lauf: bei:-Regel wieder');
  // mit explizitem project verhaelt es sich gleich (Entprellung)
  const w6=await tokenAufruf('shell',{action:'exec',project:P,token:tokT},async()=>W.holeWerkzeugRegeln(P,'shell','exec'));
  check(Array.isArray(w6)&&w6.length===0,'3: mit project im selben Lauf ebenfalls nur einmal');

  // ================= 2: Legacy-Form =================
  const tokL=await identitaet('t48-ohne-typ','ohnetyp',null);
  const l1=await anmelden(tokL);
  const lob=l1?.agentOnboarding;
  check(lob?.rules?.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig)&&lob.rules.some(r=>r.name==='regel-normal-y'&&!r.vollstaendig&&r.auszug),'2: Ausweis ohne Typ: Bestand (Pflicht voll, Rest Auszug)');
  check(!lob?.rules?.some(r=>r.name==='regel-typ-b'),'2: ohne Typ: koordinator-only bleibt verborgen (Rollenfilter wie bisher)');
  check(lob?.zustellung?.regeln_quelle==='rolle'&&!lob?.regel_verzeichnis?.typ_regeln,'2: zustellung.regeln_quelle rolle, keine typ_regeln');
  // Schalter typkatalog im Projekt AUS -> Typ-Agent faellt auf Bestand zurueck
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'typkatalog',false,'Test P22-T48 aus','user')",[P]);
  L.leereLaufPuffer();
  const a3=await anmelden(tokT);
  check(a3?.agentOnboarding?.rules?.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig)&&a3.agentOnboarding.zustellung?.regeln_quelle==='rolle','2: typkatalog AUS -> Bestand (Pflichtregeln voll, Quelle rolle)');
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion='typkatalog'",[P]);
  L.leereLaufPuffer();
  // Typ, dessen Regelnamen alle fehlen -> Bestand statt leerer Zustellung (wie P22-T30 [d]), Diagnose typ_ohne_regel
  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t48-leer','projekt',$1,'t48-leer',1,'test')",[P]);
  await pool.query("INSERT INTO agent_typ_revisionen(typ_id,revision,inhalt,wer) VALUES('t48-leer',1,$1,'test')",[JSON.stringify({regeln:['nur-fehlend']})]);
  const tokE=await identitaet('t48-leer-agent','leeragent','t48-leer');
  const e1=(await anmelden(tokE))?.agentOnboarding;
  check(e1?.rules?.some(r=>r.name==='regel-pflicht-x'&&r.vollstaendig)&&e1.zustellung?.regeln_quelle==='rolle'&&JSON.stringify(e1.zustellung?.typ_ohne_regel)==='["nur-fehlend"]','2: Typ ohne aufloesbare Regel -> Bestand + Diagnose typ_ohne_regel');

  // ================= 4: ohne Ausweis =================
  const o1=await W.holeWerkzeugRegeln(undefined,'shell','exec');
  check(Array.isArray(o1)&&o1.length===0,'4: ohne Ausweis und ohne project keine Regeln (Bestand)');
  const o2=await W.holeWerkzeugRegeln(P,'shell','exec');
  const o3=await W.holeWerkzeugRegeln(P,'shell','exec');
  check(namen(o2)==='regel-bei-shell'&&namen(o3)==='regel-bei-shell','4: ohne Ausweis mit project bei jedem Aufruf (keine Entprellung)');
  L.leereLaufPuffer();
}catch(e){
  failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
  await pool?.end().catch(()=>{});
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await admin.end();
}
console.log(`\nP22-T48: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
