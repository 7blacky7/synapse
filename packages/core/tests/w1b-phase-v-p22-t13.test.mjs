/**
 * P22-T13 Phase V (W1b Grundlagen): Schema 113 (2x idempotent), Gate-Kern (list+call, mit/ohne Profil),
 * zentrale Tokenaufloesung (F3, REST-Vorbelegung, Fachfilter, Ausweiskonflikt), Schalter, Tresor, Vertrag.
 * Nur synapse_test:5433, eigenes privates Schema/Sequenzen, keine Modelle/Netz/Daemon.
 *   node packages/core/tests/w1b-phase-v-p22-t13.test.mjs                 alle Pruefungen (aktueller Stand)
 *   P22_T13_ROOT=<stand> node ... --golden <datei>                         AUS-Golden-Dump eines Standes (t109 oder neu)
 *   node ... --vergleiche <basis.json> <neu.json>                          Golden-Vergleich
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';

const argv=process.argv.slice(2);
if(argv[0]==='--vergleiche'){
 const a=JSON.parse(readFileSync(argv[1],'utf8')),b=JSON.parse(readFileSync(argv[2],'utf8'));
 const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];let diff=0;
 for(const k of keys){
  try{assert.deepEqual(b[k],a[k]);}
  catch{diff++;console.error('GOLDEN-ABWEICHUNG '+k+'\n basis: '+JSON.stringify(a[k]).slice(0,800)+'\n neu:   '+JSON.stringify(b[k]).slice(0,800));}
 }
 console.log('Golden: '+keys.length+' Faelle, '+diff+' Abweichungen');
 process.exit(diff?1:0);
}
const goldenOut=argv[0]==='--golden'?argv[1]:null;
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T13_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
// intern wird beim Modulstart gelesen: Golden ohne intern (Produktionsmodus), Pruefungen mit intern (Overrides).
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:goldenOut?'0':'1',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t13_w1bv_'+process.pid+'_'+randomUUID().slice(0,8);
const project='p22-t13-synthetic',legacy='legacy-client',thoughtId='00000000-0000-4000-8000-000000000113';
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s))
 .replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
function gleich(a,b){try{assert.deepEqual(a,b);return true;}catch{return false;}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LAUFZEIT=new Set(['ms','dauer_ms','durationMs','duration_ms','sitzung_seit','registeredAt','registered_at','last_seen','lastSeen','timestamp','created_at','updated_at','zeit']);
/** Nur Laufzeitwerte normalisieren (Zeit, IDs, Ausweise); nie fachliche Werte. */
function norm(v){
 return JSON.parse(JSON.stringify(v,(k,x)=>{
  if(LAUFZEIT.has(k))return '<laufzeit>';
  if(typeof x==='string')return x.replace(/sai_[a-z0-9]{1,64}/g,'<ausweis>').replace(/sai_[a-f0-9]{8}/g,'<praefix>')
   .replace(UUID,'<uuid>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?/g,'<ts>');
  return x;
 }));
}

async function transports(){
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();
 close.push(()=>app.close());
 const rpc=async(method,params,extra={})=>{
  const r=await app.inject({method:'POST',url:'/mcp/messages',
   headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t13',...extra},
   payload:{jsonrpc:'2.0',id:++seq,method,params}});
  assert.equal(r.statusCode,200,'HTTP 200');return r.json().result;
 };
 const rest={name:'rest',
  list:async(extra={})=>(await rpc('tools/list',{},extra)).tools,
  call:async(name,args,extra={})=>unwrap(await rpc('tools/call',{name,arguments:args},extra))};
 const sdk=join(root,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
 const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')).href);
 const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')).href);
 const {createServer}=await load('packages/mcp-server/dist/server.js');
 const server=createServer(),client=new Client({name:'p22-t13',version:'1'});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 close.push(()=>client.close());
 const mitEnv=async(token,fn)=>{
  if(token===undefined)return fn();
  process.env.SYNAPSE_AGENT_TOKEN=token;
  try{return await fn();}finally{delete process.env.SYNAPSE_AGENT_TOKEN;}
 };
 const stdio={name:'stdio',
  list:async(token)=>mitEnv(token,async()=>(await client.listTools()).tools),
  call:async(name,args,token)=>mitEnv(token,async()=>unwrap(await client.callTool({name,arguments:args})))};
 return {rest,stdio};
}

/** AUS-Vertrag: identisch zwischen t109 und neuem Stand (alle W1b-Schalter Standard). */
async function goldenFaelle({rest,stdio}){
 const g={};
 g['rest.tools/list']=await rest.list();
 g['stdio.tools/list']=await stdio.list();
 for(const t of [rest,stdio]){
  const n=t.name;
  g[n+'.legacy.thought.get']=await t.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy});
  g[n+'.legacy.chat.get']=await t.call('chat',{action:'get',project,agent_id:legacy,limit:5});
  const reg=await t.call('chat',{action:'register',id:'golden-'+n,project,model:'synthetic'});
  if(reg.token)secrets.push(reg.token);
  g[n+'.token.register']=reg;
  g[n+'.token.anmelden']=await t.call('chat',{action:'anmelden',token:reg.token});
  g[n+'.token.thought.get']=await t.call('thought',{action:'get',project,id:thoughtId,token:reg.token});
  g[n+'.token.thought.get.fremde_id']=await t.call('thought',{action:'get',project,id:thoughtId,token:reg.token,agent_id:'fremd'});
  g[n+'.token.anmelden.fremde_id']=await t.call('chat',{action:'anmelden',token:reg.token,agent_id:'fremd'});
  g[n+'.token.chat.get.filter']=await t.call('chat',{action:'get',project,agent_id:legacy,token:reg.token,limit:5});
  g[n+'.token.identitaet']=await t.call('chat',{action:'identitaet',token:reg.token});
  g[n+'.token.fremdes_projekt']=await t.call('chat',{action:'identitaet',token:reg.token,project:project+'-x'});
  g[n+'.token.ungueltig']=await t.call('thought',{action:'get',project,id:thoughtId,token:'sai_'+'0'.repeat(64)});
  g[n+'.epoch']=(await pool.query('SELECT context_epoch FROM agent_identitaeten WHERE agent_id=$1 AND project=$2',['golden-'+n,project])).rows;
  if(n==='rest'){
   g['rest.token.openai-ua']=await rest.call('thought',{action:'get',project,id:thoughtId,token:reg.token},{'user-agent':'openai-mcp/1.0'});
   g['rest.list.mit_ausweis']=(await rest.list({'x-synapse-agent-token':reg.token})).map(x=>x.name);
  }else{
   g['stdio.list.mit_ausweis']=(await stdio.list(reg.token)).map(x=>x.name);
  }
 }
 g['audit.token-identitaet']=(await pool.query("SELECT tool_name,action,error,ok FROM tool_calls WHERE source='token-identitaet' ORDER BY id")).rows;
 const M=await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
 const inv=[{name:'artefakt'},{name:'files'},{name:'intern'},{name:'thought'}];
 const zug=[{profile:'artefakt-only',sessionId:null,agentId:null},{profile:'artefakt-only',sessionId:'s1',agentId:null},
  {profile:'main-synapse',sessionId:'s1',agentId:'main-s1'},{profile:'artefakt-only',sessionId:'s1',agentId:null,error:'main_synapse_aus'}];
 g['main.liste']=zug.map(a=>M.mainToolListe(inv,a).map(x=>x.name));
 g['main.ablehnung']=zug.map(a=>['artefakt','files','intern','fehlt'].map(name=>[{},{agent_id:'main-s1'},{agent_id:'x'}]
  .map(args=>M.mainToolAblehnung(name,args,a,inv))));
 return norm(g);
}

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[thoughtId,project,'synthetic','W1b fixture',[]]);
 const chat=await load('packages/core/dist/services/chat.js');await chat.registerAgent(legacy,project,'synthetic');

 if(goldenOut){
  const T=await transports();
  writeFileSync(goldenOut,JSON.stringify(await goldenFaelle(T),null,1));
  console.log('Golden-Dump geschrieben ('+root+')');
 }else{
  const C=core;
  { const m114=await load('packages/core/dist/db/agent-ausweis-schema.js');const s114=Object.values(m114).find(v=>typeof v==='string');await pool.query(s114);await pool.query(s114); }
  { const m115=await load('packages/core/dist/db/agent-ausweis-nr-schema.js');const s115=Object.values(m115).find(v=>typeof v==='string');await pool.query(s115);await pool.query(s115); }
  await section('Schema 113 additiv/idempotent',async()=>{
   const {AGENT_PROFIL_SCHEMA_SQL:s113}=await load('packages/core/dist/db/agent-profil-schema.js');
   check(readFileSync(join(root,'packages/core/src/db/schema-sql/113_agent_profil.sql'),'utf8').trim()===s113.trim(),'SQL-Spiegel 113 identisch');
   const schemaJs=readFileSync(join(root,'packages/core/dist/db/schema.js'),'utf8');
   check(/\$\{AGENT_BEZUG_SCHEMA_SQL\}\s*\$\{AGENT_PROFIL_SCHEMA_SQL\}\s*\$\{AGENT_AUSWEIS_SCHEMA_SQL\}\s*(?:\$\{AGENT_AUSWEIS_NR_SCHEMA_SQL\}\s*)?(?:\$\{AGENT_RUNTIME_AUFTRAEGE_SCHEMA_SQL\}\s*)?(?:\$\{AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL\}\s*)?(?:\$\{AGENT_AUSWEIS_PROJEKTE_SCHEMA_SQL\}\s*)?(?:\$\{[A-Z_]+_SCHEMA_SQL\}\s*)*`/.test(schemaJs),'113 im Laufzeitschema direkt nach 112, 114 (Ausweis, W12) direkt danach');
   const ohneKommentar=s113.split('\n').filter(z=>!z.trim().startsWith('--')).join('\n');
   const alters=[...ohneKommentar.matchAll(/ALTER TABLE[^;]*;/g)].map(m=>m[0]);
   check(alters.length>0&&alters.every(a=>/^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS /.test(a)),'nur ADD COLUMN IF NOT EXISTS');
   check(!/\b(DROP|RENAME|ALTER COLUMN|SET NOT NULL|UPDATE|DELETE|TRUNCATE)\b/i.test(ohneKommentar),'keine destruktive/datenaendernde DDL');
   check([...ohneKommentar.matchAll(/CREATE (UNIQUE )?(TABLE|INDEX)\s+(\S+ \S+ \S+)/g)].every(m=>m[3]==='IF NOT EXISTS'),'alle CREATE mit IF NOT EXISTS');
   const bestand=['agent_identitaeten','agent_identitaet_tokens','agent_sessions'];
   const snap=async()=>({
    con:(await pool.query("SELECT conrelid::regclass::text t,conname,pg_get_constraintdef(oid) d FROM pg_constraint WHERE connamespace=$1::regnamespace ORDER BY 1,2",[schema])).rows,
    spalten:(await pool.query('SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 ORDER BY 1,2',[schema])).rows,
    idx:(await pool.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY 1',[schema])).rows});
   const vor=await snap();
   await pool.query(s113);const mitte=await snap();
   await pool.query(s113);const nach=await snap();
   check(gleich(mitte,nach),'zweiter Lauf von 113 aendert nichts');
   const key=r=>JSON.stringify(r);
   check(vor.con.every(c=>nach.con.some(n=>key(n)===key(c))),'alle bestehenden Constraints (PK/UNIQUE/CHECK/FK) unveraendert');
   check(vor.spalten.every(c=>nach.spalten.some(n=>key(n)===key(c))),'bestehende Spalten inkl. NOT NULL/Default unveraendert');
   check(vor.idx.every(c=>nach.idx.some(n=>key(n)===key(c))),'bestehende Indizes unveraendert');
   const neu=nach.spalten.filter(c=>!vor.spalten.some(v=>v.table_name===c.table_name&&v.column_name===c.column_name));
   check(neu.filter(c=>bestand.includes(c.table_name)).every(c=>c.is_nullable==='YES'||c.column_default!==null),'neue Bestandsspalten nullable oder mit Default');
   for(const t of ['agent_profil_schalter','agent_typen','agent_typ_revisionen','agent_profil_revisionen','agent_schattenprofile',
    'agent_schattenprofil_audit','agent_token_abruf_audit','agent_persona_vorlagen','agent_persona_versionen','agent_persona_zuweisungen',
    'agent_persona_audit','plan_task_bindungen','plan_task_bindung_audit'])check(nach.spalten.some(c=>c.table_name===t),'Tabelle '+t);
   const wirft=async(sql,p,label)=>{try{await pool.query(sql,p);check(false,label);}catch{check(true,label);}};
   await wirft("INSERT INTO agent_schattenprofile(id,project,ursprung_agent_id,zustand,ablauf_am) VALUES('s1','p','a','offen',NOW()+INTERVAL '1 day')",[],'Schattenzustand nur pending|bestaetigt|abgelaufen|abgelehnt');
   await wirft("INSERT INTO agent_schattenprofile(id,project,ursprung_agent_id,zustand,ablauf_am) VALUES('s2','p','a','bestaetigt',NOW()+INTERVAL '1 day')",[],'bestaetigt nur mit identity_id');
   await wirft("INSERT INTO plan_task_bindungen(project,task_id,art,identity_ids,gesetzt_von) VALUES('p','t','team','{}','u')",[],'leeres Team abgewiesen');
   await wirft("INSERT INTO plan_task_bindungen(project,task_id,art,identity_ids,gesetzt_von) VALUES('p','t','identitaet','{a,b}','u')",[],'Identitaetsbindung genau eine ID');
   await wirft("INSERT INTO plan_task_bindung_audit(project,task_id,aktion,wer,grund) VALUES('p','t','entblocken','u','  ')",[],'Entblocken ohne Grund abgewiesen');
   await pool.query("INSERT INTO agent_schattenprofile(id,project,ursprung_agent_id,ablauf_am) VALUES('s3','p','a',NOW()+INTERVAL '1 day')");
   await wirft("INSERT INTO agent_schattenprofile(id,project,ursprung_agent_id,ablauf_am) VALUES('s4','p','a',NOW()+INTERVAL '1 day')",[],'ein offener Schattenvorgang je Projekt/Ursprung');
   check((await pool.query("SELECT profil_revision FROM agent_identitaeten LIMIT 1")).rows.length>=0,'profil_revision lesbar');
  });

  await section('Vertrag (reine Helfer, Stubs)',async()=>{
   check(C.SCHATTEN_FRIST_MS===undefined&&C.schattenAblauf(new Date(0),86400000).getTime()===86400000,'24 h Frist ueber schattenAblauf(erstellt, fristMs) (P22-T45: Frist ist Einstellung)');
   check(C.schattenUebergangErlaubt('pending','bestaetigt')&&!C.schattenUebergangErlaubt('abgelaufen','bestaetigt')&&!C.schattenUebergangErlaubt('bestaetigt','pending'),'Zustandsautomat');
   check(C.wirksamerSchattenZustand({zustand:'pending',ablauf_am:new Date(Date.now()-1)})==='abgelaufen'&&C.wirksamerSchattenZustand({zustand:'pending',ablauf_am:new Date(Date.now()+60000)})==='pending','Ablauf ohne Verfallslauf wirksam');
   check(!C.vorgesehenerTokenGueltig('pending')&&C.vorgesehenerTokenGueltig('bestaetigt'),'vorgesehener Token erst nach Bestaetigung gueltig');
   const pr=(rolle,id='k1',p=project)=>({art:'identitaet',principal:{art:'identity',project:p,agent_id:id,identity_id:id,rolle,modell:null,context_epoch:1,lauf_id:null}});
   check(C.darfTokenAbrufen({art:'user'},project)&&C.darfTokenAbrufen(pr('koordinator'),project)&&!C.darfTokenAbrufen(pr('subagent'),project)&&!C.darfTokenAbrufen(pr('koordinator','k1','anders'),project),'Tokenabruf nur User/Koordinator desselben Projekts');
   check(C.darfProfilAendern(pr('koordinator'),{identity_id:'x',project})&&C.darfProfilAendern(pr('koordinator'),{identity_id:'k1',project}) /* P22-T53: Koordinator aendert sein eigenes Profil */
    &&C.darfProfilAendern(pr('koordinator'),{identity_id:'k1',project},{ersterKoordinatorStart:true})&&!C.darfProfilAendern(pr('subagent'),{identity_id:'x',project}),'Eigenprofilregel');
   check(C.taskBindungErlaubt({art:'offen'},{})&&C.taskBindungErlaubt({art:'team',identity_ids:['a','b']},{identity_id:'b'})&&!C.taskBindungErlaubt({art:'identitaet',identity_id:'a'},{identity_id:'b'})&&!C.taskBindungErlaubt({art:'team',identity_ids:['a']},{}),'Task-Bindung offen|identitaet|team');
   check(C.pruefeTaskBindungsAenderung('entblocken',null,' ')==='grund_fehlt'&&C.pruefeTaskBindungsAenderung('aendern',{art:'team',identity_ids:[]},'g')==='team_leer'
    &&C.pruefeTaskBindungsAenderung('aendern',{art:'team',identity_ids:['a']},'')==='grund_fehlt'&&C.pruefeTaskBindungsAenderung('festlegen',{art:'identitaet',identity_id:'a'})===null,'Pflicht-Grund/leeres Team');
   const kat=C.toolKatalogAusDefinitionen([{name:'files',inputSchema:{properties:{action:{enum:['read','plan']}}}},{name:'guide',inputSchema:{properties:{}}}]);
   check(gleich(kat.map(k=>k.schluessel),['files','files.read','files.plan','guide']),'Tool-/Aktionskatalog aus Definitionen');
   check(!C.hinweisAbschaltbar('fehler')&&!C.hinweisAbschaltbar('werkzeug_regeln')&&C.hinweisAbschaltbar('open_plans')&&C.hinweisAbschaltbar('ausloeser.x'),'Hinweisklassen pflicht|optional');
   check(C.PERSONA_STANDARD===null,'Persona Standard leer');
   // Paket A ist umgesetzt (kein Stub mehr, Schalter AUS -> funktion_aus); die Fehlerklasse nennt weiter das Paket.
   let stub;try{await C.W1B_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:'x',user_zustimmung:'x',grund:'x'},{art:'user'});}catch(e){stub=e;}
   check(!(stub instanceof C.W1bNichtUmgesetzt)&&new C.W1bNichtUmgesetzt('A','x').paket==='A','Paket A kein Stub mehr; W1bNichtUmgesetzt nennt Paket');
   let stubT;try{await C.W1B_DIENSTE.taskBindung.entblocke();}catch(e){stubT=e;}
   check(!(stubT instanceof C.W1bNichtUmgesetzt)&&stubT?.code==='funktion_aus','Task-Bindung umgesetzt: Schalter AUS verweigert');
  });

  await section('Tokentresor',async()=>{
   const env={SYNAPSE_AGENT_TOKEN_SCHLUESSEL:'ab'.repeat(32)},tok='sai_'+'c'.repeat(64);
   const v=C.verschluesseleAgentToken(tok,'tid-1',env);
   check(!v.chiffre.includes(tok)&&v.chiffre.startsWith('v1:')&&/^[a-f0-9]{16}$/.test(v.schluessel_id),'Chiffre ohne Klartext');
   check(C.entschluesseleAgentToken(v.chiffre,'tid-1',v.schluessel_id,env)===tok,'Rundweg');
   let e1;try{C.entschluesseleAgentToken(v.chiffre,'tid-2',null,env);}catch(e){e1=e.code;}
   check(e1==='token_chiffre_ungueltig','an Token-ID gebunden');
   let e2;try{C.verschluesseleAgentToken(tok,'t',{});}catch(e){e2=e.code;}
   check(e2==='token_schluessel_fehlt'&&!C.tokenSchluesselStand({}).vorhanden,'kein Klartext-Fallback ohne Schluessel');
   let e3;try{C.entschluesseleAgentToken(v.chiffre,'tid-1',v.schluessel_id,{SYNAPSE_AGENT_TOKEN_SCHLUESSEL:'cd'.repeat(32)});}catch(e){e3=e.code;}
   check(e3==='token_schluessel_gewechselt','Schluesselwechsel erkannt');
  });

  await section('Gate-Kern rein (list+call, mit/ohne Profil)',async()=>{
   const defs=[{name:'files',inputSchema:{properties:{action:{enum:['read','plan','commit']}}}},{name:'guide',inputSchema:{properties:{}}},
    {name:'intern',inputSchema:{properties:{action:{enum:['schalter_liste','schalter_setzen']}}}},{name:'artefakt',inputSchema:{properties:{}}}];
   const vorher=JSON.stringify(defs);
   const altListe=(tools,a)=>a.error?[]:!a.sessionId?tools:tools.filter(t=>a.profile==='main-synapse'?t.name!=='intern':t.name==='artefakt');
   const altAbl=(name,args,a,tools)=>{if(a.error)return a.error;if(!a.sessionId)return null;
    if(!altListe(tools,a).some(t=>t.name===name))return a.profile==='artefakt-only'?'hauptagent_nur_artefakt':'main_werkzeug_nicht_freigegeben';
    if(a.agentId&&args.agent_id!==undefined&&args.agent_id!==a.agentId)return 'main_agent_id_abweichend';return null;};
   const M=await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
   const zug=[{profile:'artefakt-only',sessionId:null,agentId:null},{profile:'artefakt-only',sessionId:'s1',agentId:null},
    {profile:'main-synapse',sessionId:'s1',agentId:'main-s1'},{profile:'artefakt-only',sessionId:'s1',agentId:null,error:'main_synapse_aus'}];
   for(const a of zug){
    check(gleich(C.entscheideToolListe(defs,{transport:a}),altListe(defs,a))&&gleich(M.mainToolListe(defs,a),altListe(defs,a)),'Transportliste wie bisher '+JSON.stringify(a));
    for(const name of ['files','guide','intern','artefakt','fehlt'])for(const args of [{},{agent_id:'main-s1'},{agent_id:'x'}]){
     check((C.entscheideToolAufruf(name,args,{transport:a},defs)?.code??null)===altAbl(name,args,a,defs)&&M.mainToolAblehnung(name,args,a,defs)===altAbl(name,args,a,defs),'Transportaufruf wie bisher '+name+JSON.stringify(args)+a.profile+a.sessionId);
    }
   }
   check(M.mainToolAblehnung('files',{agent_id:'x'},zug[2],defs,{tokenAufruf:true})===null,'Token-Aufruf: keine synthetische Main-ID als Selbstanspruch');
   check(C.entscheideToolListe(defs,{})===defs&&C.entscheideToolAufruf('files',{action:'commit'},{})===null,'ohne Profil exakt heutiges Verhalten');
   const z={revision:'r1',aktionen:{'files.commit':'verweigert'},tools:{guide:'verweigert'}};
   const l=C.entscheideToolListe(defs,{zuschnitt:z});
   check(gleich(l.find(d=>d.name==='files').inputSchema.properties.action.enum,['read','plan'])&&!l.some(d=>d.name==='guide')&&l.some(d=>d.name==='intern')&&l.some(d=>d.name==='artefakt'),'Liste: Aktion gesperrt, Tool verborgen');
   check(JSON.stringify(defs)===vorher,'geteilte Definitionen nie mutiert');
   check(C.entscheideToolAufruf('files',{action:'commit'},{zuschnitt:z})?.code==='profil_aktion_gesperrt'&&C.entscheideToolAufruf('guide',{},{zuschnitt:z})?.code==='profil_werkzeug_gesperrt'
    &&C.entscheideToolAufruf('files',{action:'read'},{zuschnitt:z})===null&&C.entscheideToolAufruf('files',{action:'commit'},{zuschnitt:z}).revision==='r1','Aufruf: dieselbe Entscheidung');
   const nurLesen={revision:'r2',standard:'verweigert',aktionen:{'files.read':'erlaubt'}};
   const l2=C.entscheideToolListe(defs,{zuschnitt:nurLesen});
   check(gleich(l2.map(d=>d.name),['files','intern'])&&gleich(l2[0].inputSchema.properties.action.enum,['read']),'Standard verweigert, Aktion erlaubt; Tool ohne erlaubte Aktion verborgen; intern bleibt (b930e4af)');
   check(C.entscheideToolAufruf('intern',{action:'schalter_setzen'},{zuschnitt:nurLesen})===null,'intern ohne User-Festlegung nicht durch Profil gesperrt');
   const userIntern={revision:'r3',tools:{intern:'verweigert'},intern_user_festgelegt:true};
   check(!C.entscheideToolListe(defs,{zuschnitt:userIntern}).some(d=>d.name==='intern')&&C.entscheideToolAufruf('intern',{action:'schalter_liste'},{zuschnitt:userIntern})?.code==='profil_werkzeug_gesperrt','intern nur mit User-Festlegung beschraenkbar');
   check(!C.entscheideToolListe([{name:'thought'}],{zuschnitt:userIntern}).some(d=>d.name==='intern'),'Kern schaltet intern nie ein');
  });

  await section('Schalter (Produkt + intern-Overrides)',async()=>{
   check(!(await C.leseW1bSchalter('durchsetzung')).freigegeben&&!(await C.leseW1bSchalter('antwortanpassung')).freigegeben,'W1b Standard AUS');
   process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
   const env=await C.leseW1bSchalter('durchsetzung');
   check(env.freigegeben&&env.quelle==='standard','Produktionsstandard per Env EIN');
   const I=await load('packages/core/dist/services/intern-schalter.js');
   await I.setzeSchalter('w1b_durchsetzung',{aktiv:false,dauer_min:5,grund:'p22-t13 test',agent:'test'});
   const aus=await C.leseW1bSchalter('durchsetzung');
   check(!aus.freigegeben&&aus.quelle==='intern'&&aus.bis,'intern-Override AUS ueber Env EIN, befristet');
   delete process.env.SYNAPSE_W1B_DURCHSETZUNG;
   await I.setzeSchalter('w1b_antwortanpassung',{aktiv:true,dauer_min:5,grund:'p22-t13 test',agent:'test'});
   check((await C.leseW1bSchalter('antwortanpassung')).freigegeben,'intern-Override EIN');
   await pool.query("UPDATE intern_schalter SET bis=NOW()-INTERVAL '1 minute' WHERE name IN ('w1b_durchsetzung','w1b_antwortanpassung')");
   const ab=await C.leseW1bSchalter('antwortanpassung');
   check(!ab.freigegeben&&ab.quelle==='standard','Ablauf -> Produktionsstandard');
   const liste=await I.alleSchalter();
   check(liste.some(s=>s.name==='w1b_durchsetzung'&&s.abgelaufen),'Diagnose schalter_liste zeigt Ablauf');
   await pool.query("DELETE FROM intern_schalter WHERE name IN ('w1b_durchsetzung','w1b_antwortanpassung')");
   // Produkt-Schalter
   const p0=await C.leseProfilProduktSchalter('schattenprofile',project);
   check(!p0.aktiv&&p0.quelle==='standard','Produkt-Schalter Standard AUS');
   await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('ps-k',$1,'pk','pk','koordinator','test'),('ps-s',$1,'ps','ps','subagent','test'),('ps-f','fremd','pf','pf','koordinator','test')",[project]);
   const fehler=async(fn)=>{try{await fn();return null;}catch(e){return e.code;}};
   check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'schattenprofile',aktiv:true,grund:'test p22'},{identity_id:'ps-s'}))==='recht_fehlt','Subagent darf nicht schalten');
   check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'schattenprofile',aktiv:true,grund:'test p22'},{identity_id:'ps-f'}))==='recht_fehlt','fremder Koordinator darf nicht schalten');
   // P22-T57: global auch Koordinator des Aufrufprojekts; fremdes Aufrufprojekt bzw. Subagent nie.
   check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'global',funktion:'schattenprofile',aktiv:true,grund:'test p22'},{identity_id:'ps-k',aufruf_project:'fremd'}))==='recht_fehlt','global: Koordinator nur mit eigenem Aufrufprojekt');
   check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'global',funktion:'schattenprofile',aktiv:true,grund:'test p22'},{identity_id:'ps-s',aufruf_project:project}))==='recht_fehlt','global: Subagent nie');
   check(await fehler(()=>C.setzeProfilProduktSchalter({ebene:'global',funktion:'schattenprofile',aktiv:true,grund:' '},{system:'user'}))==='grund_fehlt','Grund Pflicht');
   {const m=process.env.SYNAPSE_AGENT_BEZUG_MODUS;process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';try{await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'test p22'},{system:'user'});}finally{if(m===undefined)delete process.env.SYNAPSE_AGENT_BEZUG_MODUS;else process.env.SYNAPSE_AGENT_BEZUG_MODUS=m;}} // P22-T31 Punkt 3: 'alle' EIN braucht Modus beide
   check((await C.leseProfilProduktSchalter('persona',project)).aktiv,'global alle EIN');
   const pk=await C.setzeProfilProduktSchalter({ebene:'projekt',project,funktion:'persona',aktiv:false,grund:'test p22'},{identity_id:'ps-k'});
   check(!pk.aktiv&&pk.ebene==='projekt'&&pk.gesetzt_von==='ps-k','Projektkoordinator: Projekt vor global');
   check((await C.leseProfilProduktSchalter('persona','anderes')).aktiv,'anderes Projekt unberuehrt');
   await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:false,grund:'test p22 zurueck'},{system:'user'});
   check(!(await C.leseProfilProduktSchalter('typkatalog',project)).aktiv,'dauerhaft in PG, wieder AUS');
   await pool.query('DELETE FROM agent_profil_schalter');
   await pool.query("DELETE FROM agent_identitaeten WHERE id IN ('ps-k','ps-s','ps-f')");
  });

  const T=await transports();
  const {rest,stdio}=T;
  await section('Tokenaufloesung F3/Vorbelegung/Fachfilter',async()=>{
   // Erster Aufruf liefert einmalige Hinweise (First-Use/Onboarding); verglichen wird der stabile Fachvertrag.
   for(const t of [rest,stdio])await t.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy});
   const legacyAus={rest:await rest.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy}),stdio:await stdio.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy})};
   process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
   for(const t of [rest,stdio])check(gleich(await t.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy}),legacyAus[t.name]),'Legacy ohne Token unter Durchsetzung unveraendert '+t.name);
   const reg=await stdio.call('chat',{action:'register',id:'f3-agent',project,model:'m1'});
   const tok=reg.token;secrets.push(tok);
   const idn=reg.principal.identity_id;
   const zustand=async()=>(await pool.query(`SELECT i.context_epoch,i.zuletzt_aktiv::text za,
     (SELECT count(*)::int FROM agent_identitaet_laeufe WHERE identity_id=i.id) laeufe,
     (SELECT max(zuletzt_benutzt)::text FROM agent_identitaet_tokens WHERE identity_id=i.id) benutzt,
     (SELECT count(*)::int FROM agent_identitaet_audit WHERE identity_id=i.id) audit
     FROM agent_identitaeten i WHERE id=$1`,[idn])).rows[0];
   for(const t of [rest,stdio]){
    check((await t.call('thought',{action:'get',project,id:thoughtId,token:tok})).success!==false,'Token ohne Selbstangabe '+t.name);
    check((await t.call('thought',{action:'get',project,id:thoughtId,token:tok,agent_id:'f3-agent',project})).success!==false,'passende Angaben still ignoriert '+t.name);
    // P22-T55 (User 19.10.): mit Ausweis zaehlt NUR die Ausweis-Identitaet; abweichende Selbstangaben werden ignoriert
    // (Hinweis ausweis_hinweis), kein identitaet_konflikt mehr - auch nicht im strikten Modus.
    const k=await t.call('thought',{action:'get',project,id:thoughtId,token:tok,agent_id:'jemand-anders'});
    check(k.success!==false&&k.error!=='identitaet_konflikt','P22-T55: Widerspruch agent_id ignoriert, kein Fehler '+t.name);
    // (ohne index_stats: das liest Qdrant-Zaehler = Netz; der Rollen-Widerspruch wird an einem netzfreien Aufruf geprueft)
    const si=await t.call('thought',{action:'get',project,id:thoughtId,token:tok,role:'koordinator'});
    check(si.error!=='identitaet_konflikt','P22-T55: Rollenwiderspruch ignoriert '+t.name);
    // Actor-Alias ohne Embedding (kein Netz im Test): event.emit.source_id statt thought.add.source.
    const al=await t.call('event',{action:'emit',project,event_type:'ANNOUNCEMENT',priority:'normal',payload:'w1b-'+t.name,token:tok,source_id:'fremder-autor'});
    const alz=(await pool.query('SELECT source_id FROM agent_events WHERE project=$1 AND payload::text LIKE $2',[project,'%w1b-'+t.name+'%'])).rows[0];
    check(al.success!==false&&alz&&alz.source_id!=='fremder-autor','P22-T55: Actor-Alias event.emit.source_id durch den Ausweis ersetzt '+t.name);
    check((await t.call('chat',{action:'identitaet',token:tok,project:project+'-fremd'})).error==='agent_token_fremdes_projekt','fremdes Projekt bleibt Konflikt '+t.name);
   }
   const start=(await pool.query('SELECT COALESCE(max(id),0)::text n FROM tool_calls')).rows[0].n;
   const web=await rest.call('thought',{action:'get',project,id:thoughtId,token:tok},{'user-agent':'openai-mcp/1.0'});
   check(web.success!==false,'REST-Vorbelegung derivedAgentId zaehlt nicht als Agentenangabe');
   const webEx=await rest.call('thought',{action:'get',project,id:thoughtId,token:tok,agent_id:'gpt-web'},{'user-agent':'openai-mcp/1.0'});
   check(webEx.success!==false&&webEx.error!=='identitaet_konflikt','P22-T55: ausdrueckliche abweichende Angabe ignoriert (Hinweis statt Fehler)');
   const falsch=(await pool.query("SELECT count(*)::int n FROM tool_calls WHERE id>$1 AND error='selbstauskunft_weicht_ab'",[start])).rows[0].n;
   check(falsch===0,'keine falsche Abweichungsdiagnose durch Vorbelegung');
   const ka=async(tool,eingabe,opt,transport)=>C.mitAgentToolAufruf(tool,eingabe,'srv-test',async k=>({k,b:C.bestaetigterAufrufKontext()}),transport,undefined,opt);
   const {k:k1}=await ka('chat',{action:'get',project,agent_id:'filter-x',token:tok});
   check(k1.args.agent_id==='filter-x','chat.get.agent_id bleibt Fachfeld (nicht bezeugt)');
   // P22-T86 (Schalter chat_get_eigene, Standard EIN): mit Ausweis liest chat get nur Nachrichten an die eigene Identitaet;
   // ein fremder agent_id-Filter oeffnet keine fremden DMs mehr (Befund thought 08eb5dd6).
   check(k1.antwort?.success===true&&k1.antwort.filter?.agent_id!=='filter-x'&&k1.antwort.filter?.identity_id,'P22-T86: chat.get mit Ausweis nur eigene Nachrichten',k1.antwort);
   const {k:k2}=await ka('specialist',{action:'spawn',project,model:'ziel-modell',token:tok});
   check(k2.args.model==='ziel-modell','specialist.spawn.model bleibt Zielmodell');
   const {k:k3,b}=await ka('thought',{action:'get',project,id:thoughtId,token:tok,agent_id:'gpt-web'},{originalArgs:{action:'get',project,id:thoughtId,token:tok},vorbelegt:['agent_id']});
   check(!k3.antwort&&gleich(k3.bestaetigt.vorbelegung_ignoriert,['agent_id'])&&k3.args.agent_id==='f3-agent'&&k3.bestaetigt.identity_id===idn&&k3.bestaetigt.strikt,'Vorbelegung ignoriert, Kontext explizit');
   check(b?.identity_id===idn&&b.project===project,'bestaetigterAufrufKontext() ueberlebt Spreads (ALS)');
   const reg2=await stdio.call('chat',{action:'register',id:'f3-zwei',project});secrets.push(reg2.token);
   const {k:k4}=await ka('thought',{action:'get',project,id:thoughtId,token:tok},undefined,reg2.token);
   check(k4.antwort?.error==='ausweis_konflikt'&&!JSON.stringify(k4.antwort).includes('sai_'),'Argument- vs. Transportausweis verschiedener Identitaeten abgelehnt');
   const {k:k5}=await ka('thought',{action:'get',project,id:thoughtId,token:tok},undefined,tok);
   check(!k5.antwort,'gleicher Ausweis in Argument und Transport erlaubt');
   delete process.env.SYNAPSE_W1B_DURCHSETZUNG;
   const alt=await rest.call('thought',{action:'get',project,id:thoughtId,token:tok,agent_id:'jemand-anders'});
   check(alt.success!==false,'AUS: t109 fuehrt trotz Abweichung aus (nur Audit)');
   const {k:k6}=await ka('chat',{action:'get',project,agent_id:'filter-x',token:tok});
   check(k6.args.agent_id==='f3-agent','AUS: t109-Bindung unveraendert (chat.get liest als Ausweis-Identitaet)');
   const {k:k7}=await ka('thought',{action:'get',project,id:thoughtId,token:tok},undefined,reg2.token);
   check(!k7.antwort,'AUS: kein neuer Ausweiskonflikt (t109)');
  });

  await section('Gate list+call ueber REST und stdio',async()=>{
   const reg=await stdio.call('chat',{action:'register',id:'gate-agent',project});const tok=reg.token;secrets.push(tok);
   const reg2=await stdio.call('chat',{action:'register',id:'gate-frei',project});secrets.push(reg2.token);
   const voll={rest:await rest.list(),stdio:await stdio.list()};
   let wirf=false;
   C.registriereZuschnittResolver(async p=>{if(wirf)throw Error('db weg');return p.agent_id==='gate-agent'?{revision:'r7',aktionen:{'thought.get':'verweigert'},tools:{memory:'verweigert'}}:null;});
   try{
    const listeMit=t=>t.name==='rest'?rest.list({'x-synapse-agent-token':tok}):stdio.list(tok);
    const ohneProfilAus=await listeMit(rest);
    check(gleich(ohneProfilAus,voll.rest),'Durchsetzung AUS: Liste unveraendert trotz Profil');
    check((await rest.call('thought',{action:'get',project,id:thoughtId,token:tok})).success!==false,'Durchsetzung AUS: Aufruf unveraendert');
    process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
    for(const t of [rest,stdio]){
     const l=await listeMit(t);
     const th=l.find(x=>x.name==='thought');
     check(!l.some(x=>x.name==='memory')&&th&&!th.inputSchema.properties.action.enum.includes('get')&&th.inputSchema.properties.action.enum.includes('add'),'Liste je Identitaet gefiltert '+t.name);
     check(gleich(await t.list(),voll[t.name]),'ohne Ausweis neutrale, unveraenderte Liste '+t.name);
     const tg=await t.call('thought',{action:'get',project,id:thoughtId,token:tok});
     check(tg.error==='profil_aktion_gesperrt'&&tg.profil_revision==='r7','Aktion vor Handler abgelehnt '+t.name);
     check((await t.call('memory',{action:'read',project,name:'x',token:tok})).error==='profil_werkzeug_gesperrt','Werkzeug abgelehnt '+t.name);
     check((await t.call('thought',{action:'add',project,content:'gate '+t.name,token:tok})).success!==false,'erlaubte Aktion laeuft '+t.name);
     check((await t.call('thought',{action:'get',project,id:thoughtId,token:reg2.token})).success!==false,'andere Identitaet ohne Profil unberuehrt '+t.name);
     wirf=true;
     check((await t.call('thought',{action:'add',project,content:'x',token:tok})).error==='profil_nicht_pruefbar','Resolverfehler -> Ablehnung statt alter Freigabe '+t.name);
     wirf=false;
    }
   }finally{C.registriereZuschnittResolver(null);delete process.env.SYNAPSE_W1B_DURCHSETZUNG;}
  });
  const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
  // P22-T55 (User 19.10.): der Agenten-Ausweis wird nicht mehr maskiert; OAuth/Bearer bleibt geschwaerzt.
  check(!logs.includes(bearer),'kein OAuth-Bearer im Audit');
  check(network===0,'keine echten Netzwerk-/Modellaufrufe');
  console.log('P22-T13 Phase V: '+checks+' Pruefungen, '+failures.length+' Fehler');
 }
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Cleanup: '+error.message));}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
