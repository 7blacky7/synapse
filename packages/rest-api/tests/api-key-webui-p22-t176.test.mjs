/** P22-T176: Anthropic-Key aus der Web-UI - core api-schluessel-dienst.ts + REST agent-api.ts (fastify inject, privates synapse_test-Schema).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/api-key-webui-p22-t176.test.mjs
 * Nur Fake-Keys, Test-Tresorschluessel, Fake-Anthropic (lokaler HTTP-Server ueber ANTHROPIC_BASE_URL), kein externes Netz.
 * Sichert ab (Task P22-T176, User 26.10.2026 ~01:30 'Key in der Weboberflaeche eintragen'):
 *   A Schema 160 = Laufzeit-Spiegel, in schema.ts eingebunden, zweimal idempotent.
 *   B Schalter hauptagent_api_key_webui Standard AUS = Altverhalten: nur Env, Hinterlegen funktion_aus.
 *   C Hinterlegen nur mit Grund und gueltiger Form; PG haelt nur Chiffre (v1:, Server-Tresor) + letzte 4; Antworten nie mit Wert.
 *   D Vorrang Web-UI vor Env (core aktuellerApiKey, GET /api/main-agent/api), Ersetzen, Schalter AUS -> Env, Entfernen -> Env.
 *   E Key testen (GET /v1/models, kein Token-Verbrauch): gueltig/ungueltig, Wert nie in der Antwort.
 *   F Tresorschluessel gewechselt/fehlt: Env gilt, Fehler im Stand; Hinterlegen ohne Tresor abgelehnt.
 *   G Rechte: core nur akteur user (recht_fehlt), REST ohne Web-UI-Sitzung 401. H Transport nimmt den wirksamen Key.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich: ...' (nie ein Key-Wert). */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_ANTHROPIC_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','SYNAPSE_AGENT_TOKEN_SCHLUESSEL'])delete process.env[k];
const TRESOR=randomBytes(32).toString('hex'),TRESOR2=randomBytes(32).toString('hex');
const ENV_KEY='sk-ant-test-env-'+randomBytes(12).toString('hex'),WEB_KEY='sk-ant-test-webui-'+randomBytes(12).toString('hex'),WEB_KEY2='sk-ant-test-webui2-'+randomBytes(12).toString('hex');
const GUELTIG=new Set([WEB_KEY,WEB_KEY2]);
Object.assign(process.env,{SYNAPSE_AUTH_DISABLED:'0',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',
 EMBEDDING_BASE_URL:'http://127.0.0.1:1',SYNAPSE_AGENT_TOKEN_SCHLUESSEL:TRESOR,SYNAPSE_ANTHROPIC_API_KEY:ENV_KEY});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t176_'+process.pid+'_'+randomUUID().slice(0,8);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,fake,failure,checks=0;
// Fake-Anthropic: GET /v1/models; merkt nur, OB der erwartete Key kam (nie den Wert ausgeben).
const gesehen=[];
const ohneKey=t=>![ENV_KEY,WEB_KEY,WEB_KEY2].some(k=>String(t).includes(k));
const kurz=v=>{let s;try{s=JSON.stringify(v);}catch{s=String(v);}return ohneKey(s)?s.slice(0,600):'<enthaelt Key - unterdrueckt>';};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG ohne Key-Werte.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):''));assert(value,label);console.log('OK '+label);};
const HD='P22-T176 core api-schluessel-dienst.ts',HR='P22-T176 rest-api agent-api.ts';
try{
 fake=createServer((req,res)=>{
  const k=String(req.headers['x-api-key']??'');gesehen.push(k);
  if(req.method==='GET'&&req.url.startsWith('/v1/models')&&GUELTIG.has(k)){res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({data:[{type:'model',id:'claude-fake-1',display_name:'Fake',created_at:'2026-01-01T00:00:00Z'}],has_more:false,first_id:'claude-fake-1',last_id:'claude-fake-1'}));return;}
  res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'authentication_error',message:'invalid x-api-key'}}));
 });
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));process.env.ANTHROPIC_BASE_URL='http://127.0.0.1:'+fake.address().port;
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const seq=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,r]of seq.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();

 // ================================================================ A Schema 160
 const sqlDatei=readFileSync(join(repo,'packages/core/src/db/schema-sql/160_api_agent_schluessel.sql'),'utf8');
 ok(sqlDatei.trim()===C.API_AGENT_SCHLUESSEL_SCHEMA_SQL.trim(),'P22-T176 schema-sql/160_api_agent_schluessel.sql = api-agent-schluessel-schema.ts (Laufzeit-Spiegel)');
 ok(/\$\{API_AGENT_SCHLUESSEL_SCHEMA_SQL\}/.test(readFileSync(join(repo,'packages/core/src/db/schema.ts'),'utf8')),'P22-T176 db/schema.ts: Schema 160 im ensureSchema-SQL');
 await pool.query(C.API_AGENT_SCHLUESSEL_SCHEMA_SQL);await pool.query(C.API_AGENT_SCHLUESSEL_SCHEMA_SQL);
 ok((await pool.query("SELECT to_regclass('api_agent_schluessel')::text AS t")).rows[0].t!==null,'P22-T176 Schema 160: api_agent_schluessel zweimal idempotent angelegt');
 await pool.query(C.AGENT_API_BUDGET_SCHEMA_SQL);
 await pool.query('DELETE FROM api_agent_schluessel');await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$1",[C.API_KEY_WEBUI_FUNKTION]);

 const R=await load('packages/rest-api/dist/routes/agent-runtimes.js');
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(R.agentRuntimeRoutes);await app.ready();
 const sitzung=(await auth.issueSessionToken(null)).token;
 const inj=(method,url,payload,mitSitzung=true)=>app.inject({method,url,...(payload!==undefined?{payload}:{}),headers:mitSitzung?{authorization:'Bearer '+sitzung}:{}});
 const stand=async()=>{const r=await inj('GET','/api/main-agent/api/key');ok(ohneKey(r.body),HR+' GET /api/main-agent/api/key: Antwort ohne Key-Wert');return r.json().api_key;};
 const zeilen=async()=>(await pool.query('SELECT chiffre, schluessel_id, letzte4, grund, gesetzt_von FROM api_agent_schluessel')).rows;

 // ================================================================ B Schalter AUS = Altverhalten (nur Env)
 let s=await stand();
 ok(s.schalter.aktiv===false&&s.schalter.quelle==='standard'&&s.quelle==='env'&&s.vorhanden&&s.letzte4===ENV_KEY.slice(-4)&&/schalter=AUS/.test(s.debug)&&/env=ja/.test(s.debug),
  HD+' leseApiKeyStand: Standard AUS, Quelle Env, letzte 4, Debugzeile',s);
 let r=await inj('PUT','/api/main-agent/api/key',{key:WEB_KEY,grund:'Test T176 bei AUS'});
 ok(r.statusCode>=400&&r.json().error?.code==='funktion_aus'&&(await zeilen()).length===0&&ohneKey(r.body),HD+' setzeApiKey: Schalter AUS -> funktion_aus, nichts gespeichert',{status:r.statusCode,error:r.json().error});

 // ================================================================ C Hinterlegen (Schalter EIN)
 r=await inj('PUT','/api/main-agent/api/key/schalter',{aktiv:true});
 ok(r.statusCode>=400&&r.json().error?.code==='grund_fehlt',HD+' setzeApiKeySchalter: ohne Grund -> grund_fehlt',r.json());
 r=await inj('PUT','/api/main-agent/api/key/schalter',{aktiv:true,grund:'Test T176 Eingabe einschalten'});
 ok(r.statusCode===200&&r.json().api_key.schalter.aktiv===true&&r.json().api_key.schalter.quelle==='produkt-schalter',HR+' PUT /api/main-agent/api/key/schalter: Produkt-Schalter EIN',r.json());
 r=await inj('PUT','/api/main-agent/api/key',{key:'kein key mit leerzeichen',grund:'Test T176 falsche Form'});
 ok(r.json().error?.code==='api_key_ungueltig'&&(await zeilen()).length===0,HD+' setzeApiKey: falsche Form -> api_key_ungueltig',r.json().error);
 r=await inj('PUT','/api/main-agent/api/key',{key:WEB_KEY});
 ok(r.json().error?.code==='grund_fehlt'&&(await zeilen()).length===0,HD+' setzeApiKey: ohne Grund -> grund_fehlt');
 r=await inj('PUT','/api/main-agent/api/key',{key:'  '+WEB_KEY+'\n',grund:'Test T176 hinterlegen'});
 const k1=r.json().api_key;
 ok(r.statusCode===200&&ohneKey(r.body)&&k1.quelle==='webui'&&k1.letzte4===WEB_KEY.slice(-4)&&k1.webui.gespeichert&&k1.webui.lesbar&&typeof k1.gesetzt_am==='string'&&k1.fehler===null,
  HR+' PUT /api/main-agent/api/key: hinterlegt (Leerraum abgeschnitten), Antwort nur Stand: Quelle webui, letzte 4, gesetzt am',k1);
 let z=await zeilen();
 ok(z.length===1&&z[0].chiffre.startsWith('v1:')&&!z[0].chiffre.includes(WEB_KEY)&&z[0].letzte4===WEB_KEY.slice(-4)&&z[0].gesetzt_von==='user'&&z[0].schluessel_id===k1.tresor.schluessel_id,
  HD+' api_agent_schluessel: nur Chiffre aus dem Server-Tresor (agent-token-tresor.ts) + letzte 4, kein Klartext',{n:z.length,v1:z[0]?.chiffre.startsWith('v1:'),letzte4:z[0]?.letzte4});
 ok((await pool.query("SELECT count(*)::int n FROM api_agent_schluessel WHERE position($1 in chiffre)>0 OR position($1 in grund)>0",[WEB_KEY])).rows[0].n===0,HD+' PG: Klartext in keiner Spalte');

 // ================================================================ D Vorrang, Ersetzen, AUS, Status
 let a=await C.aktuellerApiKey();
 ok(a.key===WEB_KEY&&a.quelle==='webui',HD+' aktuellerApiKey: Web-UI vor Env',{quelle:a.quelle,fehler:a.fehler,gleich:a.key===WEB_KEY});
 r=await inj('GET','/api/main-agent/api');
 ok(r.statusCode===200&&ohneKey(r.body)&&r.json().api_key_vorhanden===true&&r.json().api_key?.quelle==='webui','P22-T176 api-agent-dienst.ts apiAgentStatus (GET /api/main-agent/api): wirksamer Key, Stand ohne Wert',r.json().api_key);
 r=await inj('PUT','/api/main-agent/api/key',{key:WEB_KEY2,grund:'Test T176 ersetzen'});
 ok(r.json().api_key?.letzte4===WEB_KEY2.slice(-4)&&(await zeilen()).length===1&&(await C.aktuellerApiKey()).key===WEB_KEY2,HR+' PUT /api/main-agent/api/key: Ersetzen ueberschreibt die eine Zeile',r.json().api_key);

 // ================================================================ E Key testen
 gesehen.length=0;
 r=await inj('POST','/api/main-agent/api/key/testen',{});
 let t=r.json().test;
 ok(r.statusCode===200&&ohneKey(r.body)&&t.ok===true&&t.quelle==='webui'&&t.http_status===200&&gesehen.length===1&&gesehen[0]===WEB_KEY2,
  HR+' POST /api/main-agent/api/key/testen: GET /v1/models mit dem Web-UI-Key, gueltig, Wert nicht in der Antwort',{t,anfragen:gesehen.length});
 await inj('PUT','/api/main-agent/api/key/schalter',{aktiv:false,grund:'Test T176 Eingabe aus'});
 s=await stand();
 ok(s.quelle==='env'&&s.webui.gespeichert===true&&s.webui.lesbar===false&&s.letzte4===ENV_KEY.slice(-4)&&/webui_zeile=ja/.test(s.debug),HD+' Schalter AUS: gespeicherte Zeile bleibt unbenutzt, Env gilt',s);
 gesehen.length=0;
 r=await inj('POST','/api/main-agent/api/key/testen',{});t=r.json().test;
 ok(t.ok===false&&t.quelle==='env'&&t.http_status===401&&t.fehler==='api_zugang_ungueltig'&&ohneKey(r.body)&&gesehen[0]===ENV_KEY,HR+' Key testen: abgelehnter Key -> api_zugang_ungueltig (HTTP 401), Wert nicht in der Antwort',t);
 await inj('PUT','/api/main-agent/api/key/schalter',{aktiv:true,grund:'Test T176 Eingabe wieder ein'});

 // ================================================================ F Tresorschluessel gewechselt / fehlt
 process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL=TRESOR2;
 s=await stand();
 ok(s.quelle==='env'&&s.fehler==='token_schluessel_gewechselt'&&/fehler=token_schluessel_gewechselt/.test(s.debug),HD+' Tresorschluessel gewechselt: Env gilt, Fehler sichtbar',s);
 delete process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL;
 s=await stand();
 ok(s.tresor.vorhanden===false&&s.fehler==='token_schluessel_fehlt'&&s.quelle==='env',HD+' Tresorschluessel fehlt: tresor.vorhanden=false, Env gilt',s);
 r=await inj('PUT','/api/main-agent/api/key',{key:WEB_KEY,grund:'Test T176 ohne Tresor'});
 ok(r.json().error?.code==='token_schluessel_fehlt'&&ohneKey(r.body),HD+' setzeApiKey ohne Tresorschluessel: abgelehnt, kein Klartext-Fallback',r.json().error);
 process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL=TRESOR;
 ok((await C.aktuellerApiKey()).quelle==='webui',HD+' Tresorschluessel zurueck: Web-UI-Key wieder lesbar');

 // ================================================================ G Rechte
 let fehlerCode=null;try{await C.setzeApiKey(null,{key:WEB_KEY,grund:'Test T176 ohne Akteur'});}catch(e){fehlerCode=e.code;}
 ok(fehlerCode==='recht_fehlt',HD+' setzeApiKey: ohne User-Akteur -> recht_fehlt',fehlerCode);
 fehlerCode=null;try{await C.entferneApiKey({art:'identitaet',principal:{identity_id:'x',project:'synapse-hauptagent',rolle:'main'}},{grund:'Test T176 Main'});}catch(e){fehlerCode=e.code;}
 ok(fehlerCode==='recht_fehlt'&&(await zeilen()).length===1,HD+' entferneApiKey: auch der Hauptagent darf nicht -> recht_fehlt',fehlerCode);
 fehlerCode=null;try{await C.setzeApiKeySchalter(null,{aktiv:false,grund:'Test T176 ohne Akteur'});}catch(e){fehlerCode=e.code;}
 ok(fehlerCode==='recht_fehlt',HD+' setzeApiKeySchalter: nur User');
 for(const [m,u,p] of [['GET','/api/main-agent/api/key'],['PUT','/api/main-agent/api/key',{key:WEB_KEY,grund:'ohne Sitzung'}],['DELETE','/api/main-agent/api/key',{grund:'ohne Sitzung'}],['POST','/api/main-agent/api/key/testen',{}]]){
  r=await inj(m,u,p,false);ok(r.statusCode===401&&ohneKey(r.body),'P22-T176 agent-runtimes.ts Guard: '+m+' '+u+' ohne Web-UI-Sitzung -> 401',r.statusCode);
 }

 // ================================================================ H Entfernen, Transport
 r=await inj('DELETE','/api/main-agent/api/key',{});
 ok(r.json().error?.code==='grund_fehlt'&&(await zeilen()).length===1,HR+' DELETE /api/main-agent/api/key: ohne Grund -> grund_fehlt');
 r=await inj('DELETE','/api/main-agent/api/key',{grund:'Test T176 entfernen'});
 ok(r.statusCode===200&&r.json().api_key.quelle==='env'&&r.json().api_key.webui.gespeichert===false&&(await zeilen()).length===0,HR+' DELETE /api/main-agent/api/key: entfernt, Env gilt wieder',r.json().api_key);
 delete process.env.SYNAPSE_ANTHROPIC_API_KEY;
 s=await stand();
 ok(s.vorhanden===false&&s.quelle===null&&/quelle=keine/.test(s.debug),HD+' ohne Web-UI-Key und ohne Env: vorhanden=false',s);
 const quelle=readFileSync(join(repo,'packages/rest-api/src/routes/agent-api.ts'),'utf8');
 // P22-T183 B3: der Anthropic-Transport zog aus der Route nach services/api-agent-transport.ts (rufeApiTransport); Key-Pruefung dort, Route weiter ohne Env-Zugriff.
 const transportQuelle=readFileSync(join(repo,'packages/rest-api/src/services/api-agent-transport.ts'),'utf8');
 ok(/const key = \(await aktuellerApiKey\(\)\)\.key;/.test(transportQuelle)&&!/process\.env\.SYNAPSE_ANTHROPIC_API_KEY/.test(transportQuelle)&&!/process\.env\.SYNAPSE_ANTHROPIC_API_KEY/.test(quelle),'P22-T176 api-agent-transport.ts Transport (seit P22-T183): wirksamer Key ueber aktuellerApiKey, kein direkter Env-Zugriff mehr');
 ok(/models\.list\(\{ limit: 1 \}\)/.test(quelle),'P22-T176 agent-api.ts Key testen: GET /v1/models (limit 1), kein messages-Aufruf');
 console.log('PASS P22-T176 core+REST '+checks+' checks; private schema '+schema);
}catch(e){failure=e;console.error(ohneKey(e?.stack??e)?e:'Fehler (Text enthielt Key, unterdrueckt)');}finally{
 await app?.close();await C?.closePool?.();fake?.close();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
