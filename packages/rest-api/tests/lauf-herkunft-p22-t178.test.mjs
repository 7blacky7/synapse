/** P22-T178: Lauf-Herkunft je Agent ('api · haiku') - core agent-lauf-herkunft.ts + REST specialists.ts (fastify inject, privates synapse_test-Schema).
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/lauf-herkunft-p22-t178.test.mjs
 * Sichert ab (Task P22-T178, User 26.10.2026 ~01:35 'Herkunft eintragen, API-Herkunft'):
 *   A laufHerkunftAus: provider anthropic-api/google/free* -> api, anthropic/antigravity -> cli, openai -> codex; ohne provider nach Modell;
 *     Kurzname (api-haiku -> haiku); unbekannt ohne Text.
 *   B Katalog: Produkt-Schalter agent_lauf_herkunft nur ausdruecklich (agent-profil-schalter.ts).
 *   C ermittleLaufHerkunft: Schalter AUS -> aktiv false, leer (Altverhalten); EIN -> je Wrapper-Zeile (Identitaet + Legacy) Art, Modell, Text,
 *     Quelle; Debug je_art/zeilen. D REST GET /api/projects/:name/agenten-lauf-herkunft = core.
 * Bei Fehlschlag: 'DEBUG <Herkunft> | tatsaechlich: ...'. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const db=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID'])delete process.env[k];
// listWrapperStatus liest Identitaets-Wrapperzeilen nur bei Bezugsmodus beide/neu (Prod: beide).
Object.assign(process.env,{SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_AUTH_DISABLED:'1',SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',DOCKER_SOCKET:'/nicht/vorhanden/docker.sock',QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t178_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t178';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,failure,checks=0;
const kurz=v=>{try{return JSON.stringify(v).slice(0,700);}catch{return String(v).slice(0,700);}};
// Regel regel-tests-mit-herkunft-kommentieren: Label = Task + Einheit + Quelldatei; Fehlschlag -> DEBUG mit tatsaechlichem Wert.
const ok=(value,label,info)=>{checks++;if(!value)console.error('DEBUG '+label+(info!==undefined?' | tatsaechlich: '+kurz(info):''));assert(value,label);console.log('OK '+label);};
const HL='P22-T178 core agent-lauf-herkunft.ts';
try{
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

 // ================================================================ A laufHerkunftAus (rein)
 const fall=(provider,model,erwartet)=>{const h=C.laufHerkunftAus({provider,model});ok(h.art===erwartet.art&&h.text===erwartet.text&&h.quelle===erwartet.quelle,
  HL+' laufHerkunftAus('+provider+', '+model+') -> '+(erwartet.text||'unbekannt'),h);};
 fall('anthropic-api','api-haiku',{art:'api',text:'api · haiku',quelle:'provider:anthropic-api'});
 fall('anthropic-api','api-sonnet',{art:'api',text:'api · sonnet',quelle:'provider:anthropic-api'});
 fall('google','gemini-flash',{art:'api',text:'api · gemini-flash',quelle:'provider:google'});
 fall('free-openrouter','llama-3',{art:'api',text:'api · llama-3',quelle:'provider:free-openrouter'});
 fall('anthropic','opus',{art:'cli',text:'cli · opus',quelle:'provider:anthropic'});
 fall('antigravity','antigravity',{art:'cli',text:'cli · antigravity',quelle:'provider:antigravity'});
 fall('openai','gpt-5',{art:'codex',text:'codex · gpt-5',quelle:'provider:openai'});
 fall(null,'api-haiku',{art:'api',text:'api · haiku',quelle:'modell:api-haiku'});
 fall(null,'codex/gpt-5',{art:'codex',text:'codex · gpt-5',quelle:'modell:codex/gpt-5'});
 fall(null,'sonnet[1m]',{art:'cli',text:'cli · sonnet[1m]',quelle:'modell:sonnet[1m]'});
 fall(null,null,{art:'unbekannt',text:'',quelle:'keine'});
 ok(C.laufHerkunftAus({provider:'anthropic',model:null,modelFullId:'claude-opus-5-5'}).text==='cli · opus-5-5',HL+' laufHerkunftAus: ohne Alias die volle ID ohne claude-');

 // ================================================================ B Katalog
 ok(C.PROFIL_PRODUKT_FUNKTIONEN.includes('agent_lauf_herkunft')&&C.NUR_AUSDRUECKLICH.includes('agent_lauf_herkunft'),
  'P22-T178 agent-profil-schalter.ts PROFIL_PRODUKT_FUNKTIONEN/NUR_AUSDRUECKLICH: agent_lauf_herkunft nur ausdruecklich');

 // ================================================================ C ermittleLaufHerkunft
 const A=randomUUID(),B=randomUUID();
 await pool.query(`INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES
  ($1,$3,'claude-a','claude-a','subagent','aktiv','t178'),($2,$3,'claude-b','claude-b','koordinator','aktiv','t178')`,[A,B,P]);
 await pool.query(`INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled,provider,model) VALUES
  ($1,$3,'claude-a','running',false,NOW(),false,'anthropic-api','api-haiku'),($2,$3,'claude-b','idle',false,NOW(),false,'anthropic','opus')`,[A,B,P]);
 await pool.query("INSERT INTO wrapper_status(agent_name,project,status,model,provider,last_activity) VALUES('codex-c',$1,'running','gpt-5','openai',NOW())",[P]);
 await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='agent_lauf_herkunft'");
 let s=await C.ermittleLaufHerkunft(P);
 ok(s.success===true&&s.aktiv===false&&s.agenten.length===0&&s.schalter.quelle==='standard',HL+' ermittleLaufHerkunft: Schalter Standard AUS -> keine Herkunft (Altverhalten)',s);
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agent_lauf_herkunft',true,'T178 Test','user')",[P]);
 s=await C.ermittleLaufHerkunft(P);
 const nach=n=>s.agenten.find(a=>a.name===n);
 ok(s.aktiv===true&&s.schalter.quelle==='produkt-schalter'&&s.schalter.ebene==='projekt',HL+' ermittleLaufHerkunft: Schalter EIN (Projekt)',s.schalter);
 ok(nach('claude-a')?.text==='api · haiku'&&nach('claude-a')?.identity_id===A&&nach('claude-a')?.provider==='anthropic-api'&&nach('claude-a')?.status==='running',HL+' ermittleLaufHerkunft: API-Agent api · haiku (Identitaet)',nach('claude-a'));
 ok(nach('claude-b')?.text==='cli · opus'&&nach('claude-b')?.art==='cli',HL+' ermittleLaufHerkunft: Abo-CLI cli · opus',nach('claude-b'));
 ok(nach('codex-c')?.text==='codex · gpt-5'&&nach('codex-c')?.identity_id===null,HL+' ermittleLaufHerkunft: Legacy-Zeile codex · gpt-5',nach('codex-c'));
 ok(s.debug.funktion==='agent_lauf_herkunft'&&s.debug.zeilen===3&&s.debug.je_art.api===1&&s.debug.je_art.cli===1&&s.debug.je_art.codex===1,HL+' Debug: zeilen und je_art',s.debug);
 ok((await C.ermittleLaufHerkunft('anderes-projekt')).aktiv===false,HL+' Schalter gilt je Projekt (anderes Projekt AUS)');

 // ================================================================ D REST
 const S=await load('packages/rest-api/dist/routes/specialists.js');
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 await app.register(S.specialistRoutes);await app.ready();
 const r=await app.inject({method:'GET',url:'/api/projects/'+P+'/agenten-lauf-herkunft'});
 const j=r.json();
 ok(r.statusCode===200&&j.aktiv===true&&j.agenten.length===3&&j.agenten.some(a=>a.name==='claude-a'&&a.text==='api · haiku'),'P22-T178 rest-api specialists.ts GET /api/projects/:name/agenten-lauf-herkunft: Stand aus core',{status:r.statusCode,j});
 ok(!/sai_/.test(r.body),'P22-T178 REST: keine Ausweiswerte in der Antwort');
 console.log('PASS P22-T178 core+REST '+checks+' checks; private schema '+schema);
}catch(e){failure=e;console.error(e);}finally{
 await app?.close();await C?.closePool?.();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
