/**
 * P22-T89 + P22-T88 (Abnahme c4df97b2): REST-Vertraege fuer die Web-UI.
 *   GET /api/projects/:name/agenten-team  aktive Identitaeten mit Ausweis + Wrapper-Spezialisten; archivierte, Main und archiv-* fehlen;
 *                                         letzte Anmeldung nur mit Schalter agent_anmeldungen; keine Ausweiswerte.
 *   GET /api/projects/:name/thoughts      Thoughts eines archivierten (umbenannten) Absenders tragen absender_archiv.anzeige.
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon/Docker.
 *   node packages/rest-api/tests/agenten-team-p22-t89.test.mjs   (nach Build von core und rest-api)
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t89_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,app,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/gi,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}else console.log('ok   '+label);}
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
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},P='p89';
 const Fastify=requireApi('fastify');
 app=(Fastify.default??Fastify)({logger:false});
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const {thoughtsRoutes}=await load('packages/rest-api/dist/routes/thoughts.js');
 await app.register(specialistRoutes);await app.register(thoughtsRoutes);await app.ready();
 const team=async()=>{const r=await app.inject({method:'GET',url:'/api/projects/'+P+'/agenten-team'});return {status:r.statusCode,body:r.json(),roh:r.body};};
 let A,B;

 await section('Bestand: Identitaeten, Archiv, Main, Wrapper',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:true,grund:'Test T89 Ausweis-Kern'},{system:'user'});
  const va=await C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name:'team-a',grund:'Test T89 Agent A'},USER);
  const vb=await C.W12_DIENSTE.ausweis.agentVorbereiten({project:P,name:'team-b',grund:'Test T89 Agent B'},USER);
  A=(await pool.query('SELECT id,agent_id FROM agent_identitaeten WHERE id=$1',[va.identity_id])).rows[0];
  B=(await pool.query('SELECT id,agent_id FROM agent_identitaeten WHERE id=$1',[vb.identity_id])).rows[0];
  await C.meldeAgentMitTokenAn(va.token,P,await C.leseAgentBezugModus());
  const ident=(id,name,rolle,status='aktiv')=>pool.query("INSERT INTO agent_identitaeten (id,project,name,agent_id,rolle,status,erstellt_von) VALUES ($1,$2,$3,$3,$4,$5,'test')",[id,P,name,rolle,status]);
  await ident('t89-ohne','team-ohne-ausweis','subagent');
  await ident('t89-arch','archiv-20261020-team-alt','subagent','deaktiviert');
  await ident('t89-deakt','team-deaktiviert','subagent','deaktiviert');
  await ident('t89-main','synapse-hauptagent-p89','main');
  const ws=(name,status)=>pool.query("INSERT INTO wrapper_status (agent_name,project,status,tokens_percent,tokens_input,context_ceiling,model,last_activity) VALUES ($1,$2,$3,42,84000,200000,'opus',NOW())",[name,P,status]);
  await ws(A.agent_id,'running');await ws('spez-x','idle');await ws('archiv-20261020-spez-alt','stopped');
  check(A&&B,'zwei Ausweis-Identitaeten angelegt');
 });

 let t;
 await section('GET agenten-team: Schalter agent_anmeldungen AUS',async()=>{
  t=await team();
  check(t.status===200&&t.body.success===true,'HTTP 200 + success',t.body);
  const namen=t.body.agenten.map(z=>z.name);
  check(['team-a','team-b','team-ohne-ausweis','spez-x'].every(n=>namen.includes(n)),'aktive Identitaeten + Wrapper ohne Identitaet sichtbar',namen);
  check(!namen.some(n=>n.startsWith('archiv-')),'archiv-* (Identitaet und Wrapper) ausgeblendet',namen);
  check(!namen.includes('team-deaktiviert')&&!namen.includes('synapse-hauptagent-p89'),'deaktivierte und Main ausgeblendet',namen);
  check(t.body.anzahl.identitaeten===3&&t.body.anzahl.nur_wrapper===1,'Anzahl 3 Identitaeten + 1 Wrapper',t.body.anzahl);
  const a=t.body.agenten.find(z=>z.name==='team-a'),o=t.body.agenten.find(z=>z.name==='team-ohne-ausweis'),s=t.body.agenten.find(z=>z.name==='spez-x');
  check(a.art==='identitaet'&&a.identity_id===A.id&&a.schluessel==='identity:'+A.id&&a.rolle==='subagent','Identitaet A: Art, ID, Schluessel, Rolle',a);
  check(a.ausweis==='gueltig'&&o.ausweis==='keiner','Ausweis gueltig vs. keiner',[a.ausweis,o.ausweis]);
  check(a.wrapper?.status==='running'&&a.wrapper.tokens.percent===42,'Wrapper-Zeile haengt an der Identitaet',a.wrapper);
  check(!t.body.agenten.some(z=>z.art==='wrapper'&&z.name===A.agent_id),'Wrapper der Identitaet nicht doppelt');
  check(a.lauf_status==='aktiv','Laufstatus aus agent_identitaet_laeufe (ohne Schalter)',a.lauf_status);
  check(a.kontext?.quelle==='wrapper_status'&&a.kontext.prozent===42,'Kontext ohne Anmeldung aus wrapper_status',a.kontext);
  check(o.kontext===null&&o.wrapper===null,'ohne Wrapper kein Kontext',o);
  check(s.art==='wrapper'&&s.identity_id===null&&s.ausweis===null&&s.wrapper.status==='idle'&&s.herkunft?.art==='pc','Wrapper-Spezialist ohne Identitaet',s);
  check(t.body.anmeldungen.aktiv===false&&a.letzte_anmeldung===null,'Schalter AUS: keine Anmeldedaten',t.body.anmeldungen);
  check(t.body.quellen?.identitaeten&&t.body.quellen?.letzte_anmeldung,'Quellen in der Antwort');
  check(!/sai_/i.test(t.roh)&&!/token_hash/.test(t.roh),'keine Ausweiswerte in der Antwort');
 });

 await section('GET agenten-team: Schalter agent_anmeldungen EIN',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agent_anmeldungen',aktiv:true,grund:'Test T89 Anmeldungen'},{system:'user'});
  const e=await team();
  const a=e.body.agenten.find(z=>z.name==='team-a'),b=e.body.agenten.find(z=>z.name==='team-b');
  check(e.body.anmeldungen.aktiv===true,'Schalter EIN gemeldet',e.body.anmeldungen);
  check(typeof a.letzte_anmeldung?.zeit?.iso==='string'&&a.letzte_anmeldung.lauf_status==='aktiv'&&a.letzte_anmeldung.anlass==='erste_anmeldung','A: letzte Anmeldung aus admin anmeldungen',a.letzte_anmeldung);
  check(b.letzte_anmeldung===null,'B ohne Anmeldung: null',b.letzte_anmeldung);
  check(a.kontext?.quelle==='wrapper_status','Kontext aus der Anmeldung (aktiver Lauf -> wrapper_status)',a.kontext);
  check(!/sai_/i.test(e.roh),'keine Ausweiswerte (Schalter EIN)');
 });

 await section('GET thoughts: Absender archivierter Agent (P22-T88)',async()=>{
  const th=(id,source,minuten)=>pool.query("INSERT INTO thoughts (id,project,source,content,tags,timestamp) VALUES ($1,$2,$3,'x','{}',$4)",[id,P,source,new Date(Date.now()-minuten*60000).toISOString()]);
  await th(randomUUID(),'alt-agent',120);await th(randomUUID(),'aktiv-agent',100);
  await pool.query("INSERT INTO agent_entfernungen (project,art,agent_id,entfernt_grund,entfernt_von,lauf_id,neuer_name,frueherer_name,entfernt_am) VALUES ($1,'legacy','archiv-20261020-alt-agent','Test T88','test','l89','archiv-20261020-alt-agent','alt-agent',NOW()-INTERVAL '60 minutes')",[P]);
  await th(randomUUID(),'alt-agent',10);
  const r=await app.inject({method:'GET',url:'/api/projects/'+P+'/thoughts?limit=10'});
  const rows=r.json().thoughts;
  check(r.statusCode===200&&rows.length===3,'HTTP 200, drei Thoughts',rows?.length);
  const alt=rows.filter(z=>z.source==='alt-agent').sort((x,y)=>String(x.timestamp).localeCompare(String(y.timestamp)));
  check(alt[0]?.absender_archiv?.anzeige==='alt-agent (archiviert)'&&alt[0].absender_archiv.archiv_name==='archiv-20261020-alt-agent','vor der Umbenennung: absender_archiv.anzeige',alt[0]);
  check(alt[1]&&!alt[1].absender_archiv,'nach der Umbenennung (neuer Agent gleichen Namens): kein Verweis',alt[1]);
  check(!rows.find(z=>z.source==='aktiv-agent').absender_archiv,'nicht archivierter Absender: kein Verweis');
  check(alt[0].source==='alt-agent','source bleibt der alte Name');
 });
 check(network===0,'kein Netz',network);
}catch(e){failures.push('Aufbau: '+mask(e.message));console.error(mask(e.stack));}
finally{
 try{await app?.close?.();}catch{}
 try{await core?.closePool?.();}catch{}
 try{await pool?.end?.();}catch{}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch(e){console.error('Aufraeumen: '+mask(e.message));}
 await admin.end();
}
console.log(`\n${checks-failures.length}/${checks} Pruefungen ok`+(failures.length?`, FEHLER: ${failures.length}`:''));
process.exit(failures.length?1:0);
