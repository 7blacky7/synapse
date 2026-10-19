/**
 * P22-T28 (W12-T): EIN Produkt-Schalter 'agenten_ausweis' (Ausweis-Kern, V7) gegen synapse_test:5433, privates Schema 111-114.
 *   node packages/core/tests/w1b-ausweis-schalter-p22-t28.test.mjs
 * Matrix: alle Schalter AUS | Produkt-Schalter global/projekt | Einschalt-Pruefung Modus beide | Altschalter-Rueckfall (jeder Modus)
 * | Projekt aus dem Ausweis | tools/list-Schema (S2) | Schattenprofil-Anlage ueber den Kern | Puffer (Schreiber sofort, TTL).
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_W1B_ANTWORTANPASSUNG',
  'SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t28_sw_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t28-a', Q='p22-t28-b';
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const user={system:'user'};

try{
  await admin.query('CREATE SCHEMA '+schema);
  for(const {tablename} of (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows)await admin.query(`CREATE TABLE ${schema}."${tablename}" (LIKE public."${tablename}" INCLUDING ALL)`);
  const cl=await admin.connect();
  try{
    await cl.query('SET search_path TO '+schema);
    for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
  }finally{cl.release();}
  url.searchParams.set('options','-c search_path='+schema+',public');
  process.env.DATABASE_URL=url.href;
  const SCH=await load('packages/core/dist/services/agent-profil-schalter.js');
  const ID=await load('packages/core/dist/services/agent-identitaet.js');
  const T=await load('packages/core/dist/services/agent-token-tools.js');
  const A=await load('packages/core/dist/services/agent-anmeldung.js');
  const {getPool}=await load('packages/core/dist/db/client.js');
  const pool=getPool();
  const bez=()=>({modus:process.env.SYNAPSE_AGENT_BEZUG_MODUS,standard:'beide',quelle:'standard',bis:null,letzter_fehler:null});
  const modus=m=>{process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;};
  const loescheZeilen=()=>pool.query('DELETE FROM agent_profil_schalter');
  const alle=async(p)=>({kern:(await SCH.leseAusweisKern(p)).aktiv,token:await SCH.ausweisTokenAktiv(p),anm:await SCH.ausweisAnmeldungAktiv(p),schatten:p?await SCH.ausweisSchattenAktiv(p):null});

  // ---- 1. Katalog: ein Schalter, alte Namen nur lesbar
  check(SCH.PROFIL_PRODUKT_FUNKTIONEN.includes('agenten_ausweis'),'Katalog enthaelt agenten_ausweis');
  check(!SCH.PROFIL_PRODUKT_FUNKTIONEN.includes('schattenprofile')&&!SCH.PROFIL_PRODUKT_FUNKTIONEN.includes('token_abruf'),'schattenprofile/token_abruf nicht mehr im Katalog');
  check(SCH.ALT_AUSWEIS_FUNKTIONEN.includes('schattenprofile')&&SCH.ALT_AUSWEIS_FUNKTIONEN.includes('token_abruf'),'alte Namen bleiben lesbar (Altschalter-Rueckfall)');

  // ---- 2. Alles AUS (Standard)
  let k=await SCH.leseAusweisKern(P);
  check(k.aktiv===false&&k.quelle==='standard'&&k.agent_bezug_modus==='beide'&&k.letzter_fehler===null,'alles AUS: Kern AUS, Quelle standard');
  let a=await alle(P);
  check(!a.kern&&!a.token&&!a.anm&&!a.schatten,'alles AUS: Token/Anmeldung/Schatten AUS (Lesestellen = Altverhalten)');

  // ---- 3. Produkt-Schalter global EIN (nur bei beide setzbar)
  const st=await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T28 global'},user);
  check(st.aktiv===true&&st.quelle==='produkt-schalter'&&st.funktion==='agenten_ausweis','Produkt-Schalter global EIN gesetzt');
  k=await SCH.leseAusweisKern(P);
  check(k.aktiv===true&&k.quelle==='produkt-schalter','Kern EIN, Quelle produkt-schalter (ohne jedes Env)');
  a=await alle(P);
  check(a.kern&&a.token&&a.anm&&a.schatten,'ein Schalter schaltet Token, Anmeldung und Schatten zusammen');

  // ---- 4. Projekt ueberstimmt global
  await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agenten_ausweis',aktiv:false,grund:'Test T28 Projekt aus'},user);
  check((await SCH.leseAusweisKern(P)).aktiv===false&&(await SCH.leseAusweisKern(P)).quelle==='produkt-schalter','Projekt-AUS ueberstimmt global EIN');
  check((await SCH.leseAusweisKern(Q)).aktiv===true,'anderes Projekt bleibt EIN (global)');
  a=await alle(P);
  check(!a.kern&&!a.token&&!a.anm&&!a.schatten,'Projekt AUS: alle Lesestellen AUS');

  // ---- 5. Einschalt-Pruefung Modus beide; wirksam nur bei beide
  await loescheZeilen();
  modus('alt');
  let code=null;
  try{await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T28 Modus alt'},user);}catch(e){code=e.code;}
  check(code==='agent_bezug_modus_nicht_beide','Einschalten im Modus alt abgelehnt: agent_bezug_modus_nicht_beide');
  check((await pool.query("SELECT 1 FROM agent_profil_schalter WHERE funktion='agenten_ausweis'")).rows.length===0,'abgelehntes Einschalten schreibt nichts');
  const aus=await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:false,grund:'Test T28 aus'},user);
  check(aus.aktiv===false&&aus.quelle==='produkt-schalter','Ausschalten ist in jedem Modus erlaubt');
  await pool.query("UPDATE agent_profil_schalter SET aktiv=true WHERE funktion='agenten_ausweis'");
  k=await SCH.leseAusweisKern(P);
  check(k.aktiv===false&&k.letzter_fehler==='agent_bezug_modus_nicht_beide'&&k.quelle==='produkt-schalter','Zeile EIN, Modus alt: Kern wirksam AUS, sichtbar als agent_bezug_modus_nicht_beide');
  modus('neu');
  check((await SCH.leseAusweisKern(P)).letzter_fehler==='agent_bezug_modus_nicht_beide','Modus neu ebenfalls nicht beide');
  modus('beide');
  check((await SCH.leseAusweisKern(P)).aktiv===true,'zurueck auf beide: Kern EIN');

  // ---- 6. Altschalter-Rueckfall (jeder Modus), Env-Standard
  await loescheZeilen();
  modus('alt');
  process.env.SYNAPSE_TOKEN_IDENTITAET='1';
  a=await alle(P);
  check(a.token===true&&a.kern===false&&a.anm===false&&a.schatten===false,'nur token_identitaet (Modus alt): Token wie t110 EIN, Kern/Anmeldung/Schatten AUS');
  process.env.SYNAPSE_W1B_ANMELDUNG='1';
  a=await alle(P);
  check(a.token&&a.anm&&!a.kern&&a.schatten===false,'plus w1b_anmeldung: Anmeldung EIN, Schatten braucht den alten Produkt-Schalter');
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'schattenprofile',true,'Test T28 alt','user')");
  SCH.leereAusweisKernCache();
  a=await alle(P);
  check(a.schatten===true&&a.kern===false,'alter Produkt-Schalter schattenprofile (Altschalter): Schatten EIN, Kern im Modus alt AUS');
  modus('beide');
  k=await SCH.leseAusweisKern(P);
  check(k.aktiv===true&&k.quelle==='altschalter','Modus beide + alle drei alten Schalter: Kern EIN, Quelle altschalter');
  delete process.env.SYNAPSE_TOKEN_IDENTITAET;delete process.env.SYNAPSE_W1B_ANMELDUNG;await loescheZeilen();SCH.leereAusweisKernCache();
  process.env.SYNAPSE_AGENTEN_AUSWEIS='1';
  k=await SCH.leseAusweisKern(P);
  check(k.aktiv===true&&k.quelle==='standard','Env SYNAPSE_AGENTEN_AUSWEIS=1 (Produktionsstandard) + beide: Kern EIN');
  await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agenten_ausweis',aktiv:false,grund:'Test T28 Produkt vor Env'},user);
  check((await SCH.leseAusweisKern(P)).aktiv===false,'Produkt-Schalter hat Vorrang vor dem Env-Standard');
  delete process.env.SYNAPSE_AGENTEN_AUSWEIS;await loescheZeilen();SCH.leereAusweisKernCache();

  // ---- 7. Projekt aus dem Ausweis (Aufruf nur mit token)
  await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agenten_ausweis',aktiv:true,grund:'Test T28 Projekt EIN'},user);
  const tokP=(await ID.stelleAgentTokenAus({project:P,name:'t28-a'},undefined,bez())).token;
  const tokQ=await pool.query("SELECT 1");
  check((await SCH.leseAusweisKern(null)).aktiv===false,'nur Projekt EIN: Kern ohne Projekt AUS');
  check((await SCH.leseAusweisKernFuerToken(tokP,null)).aktiv===true,'Ausweis ohne project: Projekt aus dem Ausweis, Kern EIN');
  check((await SCH.leseAusweisKernFuerToken('sai_'+'0'.repeat(64),null)).aktiv===false,'unbekannter Ausweis: Kern AUS');
  check(await SCH.ausweisTokenAktiv(null,tokP),'ausweisTokenAktiv mit Ausweis ohne project EIN');
  // Gate: Aufruf nur mit token, ohne project
  const k1=await T.bereiteAgentToolAufrufVor('thought',{action:'get',token:tokP},'srv-t28');
  check(k1.aktiv===true&&!k1.antwort&&k1.principal&&k1.principal.project===P,'Gate: Aufruf mit token ohne project wird angenommen (Projekt aus dem Ausweis)');
  await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agenten_ausweis',aktiv:false,grund:'Test T28 Projekt AUS'},user);
  const k2=await T.bereiteAgentToolAufrufVor('thought',{action:'get',token:tokP},'srv-t28');
  check(k2.aktiv===false&&k2.antwort&&k2.antwort.error==='token_identitaet_aus','Kern AUS: Aufruf mit token -> token_identitaet_aus (Bestandsantwort)');
  await SCH.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agenten_ausweis',aktiv:true,grund:'Test T28 Projekt EIN'},user);

  // ---- 8. tools/list (S2): project nur mit Ausweis UND Kern EIN optional
  const frisch=()=>{const d=[{name:'thought',inputSchema:{type:'object',properties:{project:{type:'string',description:'Projekt-Name'},content:{type:'string'}},required:['project','content']}}];T.ergaenzeAgentTokenParameter(d);return d;};
  await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T28 global EIN'},user);
  const ohne=await T.beworbeneAgentTools(frisch());
  const mit=await T.beworbeneAgentTools(frisch(),{mitAusweis:true});
  check(JSON.stringify(ohne[0].inputSchema.required)==='["project","content"]'&&ohne[0].inputSchema.properties.token!==undefined,'Kern EIN, tools/list ohne Ausweis: required inkl. project, token beworben');
  check(JSON.stringify(mit[0].inputSchema.required)==='["content"]'&&mit[0].inputSchema.properties.project.description.endsWith('optional)'),'Kern EIN, tools/list mit Ausweis: project nicht Pflicht');
  await loescheZeilen();SCH.leereAusweisKernCache();
  const aus2=await T.beworbeneAgentTools(frisch(),{mitAusweis:true});
  check(JSON.stringify(aus2[0].inputSchema.required)==='["project","content"]'&&aus2[0].inputSchema.properties.token===undefined,'Kern AUS, tools/list mit Ausweis: Schema wie t110 (project Pflicht, kein token)');

  // ---- 9. Schattenprofil bei Legacy-Anmeldung haengt am Kern
  await A.registerChatAgent('t28-leg-aus',P,'m1');
  check((await pool.query("SELECT 1 FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id='t28-leg-aus'",[P])).rows.length===0,'Kern AUS: keine Schattenprofil-Anlage bei Legacy-Anmeldung');
  await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T28 global EIN'},user);
  await A.registerChatAgent('t28-leg-ein',P,'m1');
  check((await pool.query("SELECT 1 FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id='t28-leg-ein'",[P])).rows.length===1,'Kern EIN (nur Produkt-Schalter): Schattenprofil bei Legacy-Anmeldung');

  // ---- 10. Puffer: Schreiber sofort, Fremdschreiber nach TTL/Leeren
  process.env.SYNAPSE_W1B_GATE_TTL_MS='60000';SCH.leereAusweisKernCache();
  check((await SCH.leseAusweisKern(Q)).aktiv===true,'Puffer gefuellt (EIN)');
  await SCH.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:false,grund:'Test T28 Puffer'},user);
  check((await SCH.leseAusweisKern(Q)).aktiv===false,'Schreibender Prozess: Aenderung sofort wirksam (Puffer geleert)');
  await pool.query("UPDATE agent_profil_schalter SET aktiv=true WHERE funktion='agenten_ausweis' AND ebene='global'");
  check((await SCH.leseAusweisKern(Q)).aktiv===false,'Fremdschreiber (direkt in PG): innerhalb der TTL noch alter Puffer');
  SCH.leereAusweisKernCache();
  check((await SCH.leseAusweisKern(Q)).aktiv===true,'nach Puffer-Ablauf sieht der Prozess den PG-Stand');
  process.env.SYNAPSE_W1B_GATE_TTL_MS='0';
  await pool.query("UPDATE agent_profil_schalter SET aktiv=false WHERE funktion='agenten_ausweis' AND ebene='global'");
  check((await SCH.leseAusweisKern(Q)).aktiv===false,'TTL 0: jede Aenderung sofort sichtbar');
}catch(e){
  failures.push('Ausnahme: '+(e&&e.stack||e));console.error(e);
}finally{
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
  await admin.end().catch(()=>{});
}
console.log(`\nP22-T28 Ausweis-Schalter: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
process.exit(0);
