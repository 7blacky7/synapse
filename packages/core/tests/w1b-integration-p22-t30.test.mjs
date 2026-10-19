/**
 * P22-T30 (W12-I): Integration + E2E Agenten-Ausweis ueber das ganze User-Zielbild (498818f4, eeac2976, Vertrag 27acb98b,
 * Vorgaben 4fd83d8f, S2 8c85aee6, memory entscheidung-agenten-ausweis-2026-10-19).
 * EINE durchgehende Kette a-l ueber REST (fastify inject: /mcp/messages mit Bearer, agent-profile mit Web-UI-Sitzung = User)
 * und stdio (mcp-server als Kindprozess), synapse_test:5433, privates Schema 111-114, Modus 'beide',
 * Ausweis-Kern ueber den Produkt-Schalter agenten_ausweis; am Ende Gegenprobe Kern AUS = Altverhalten.
 *   node packages/core/tests/w1b-integration-p22-t30.test.mjs        (aus dem Repo-Root, nutzt dist/)
 * Abweichungen vom Zielbild werden als FAIL gemeldet und NICHT im Test umgangen; wo die Kette sonst abbraeche,
 * laeuft sie ueber einen dokumentierten Rueckfall weiter (z. B. User statt Legacy-Koordinator).
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_W1B_TOKEN_HINWEIS_MS',
 'SYNAPSE_AGENT_NAME','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_PROJECT'])delete process.env[k];

const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t30_int_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t30-int',Q='p22-t30-q';
const L='t30-leg',L2='t30-leg2',K='koordinator-t30',SUB='t30-sub',X='t30-x';
const bearer=randomUUID()+randomUUID();
const tokens=new Set();
const merke=t=>{if(typeof t==='string'&&t.startsWith('sai_'))tokens.add(t);return t;};
const mask=s=>{let t=String(s);for(const x of tokens)t=t.replaceAll(x,'[AUSWEIS]');return t.replaceAll(bearer,'[BEARER]').replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]');};
const schritte={};let aktuell='vorbereitung';
const failures=[];let checks=0;
function check(ok,label){
 checks++;const s=(schritte[aktuell]??={ok:0,fail:0});
 if(ok){s.ok++;console.log('ok   ['+aktuell+'] '+label);}else{s.fail++;failures.push('['+aktuell+'] '+mask(label));console.error('FAIL ['+aktuell+'] '+mask(label));}
}
async function schritt(name,fn){aktuell=name;schritte[name]??={ok:0,fail:0};try{await fn();}catch(e){check(false,'Ausnahme: '+(e?.stack||String(e)));}}
const AUS=/^sai_[a-z0-9]{1,64}$/;
const txt=o=>JSON.stringify(o??null);
const warte=ms=>new Promise(r=>setTimeout(r,ms));
const fehler=async fn=>{try{await fn();return null;}catch(e){return e?.code??('?'+mask(e?.message));}};
function plain(p){
 while(p&&Array.isArray(p.content)&&p.content.length===1&&p.content[0]?.type==='text'){
  const {content,...extra}=p;try{p={...JSON.parse(content[0].text),...extra};}catch{p={text:content[0].text,...extra};}
 }
 return p;
}
const unwrap=r=>{
 if(!r)return {};
 if(r.structuredContent)return {...plain(r.structuredContent),_isError:r.isError};
 const t=r.content?.find(c=>c.type==='text')?.text;
 if(t===undefined)return {...r};
 try{return {...plain(JSON.parse(t)),_isError:r.isError};}catch{return {text:t,_isError:r.isError};}
};
const close=[];
let pool,mock;

try{
 // ---- Fixture: privates Schema (Kopie public + eigene Sequenzen), Schemas 111-114
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
 const cl=await admin.connect();
 try{
  await cl.query('SET search_path TO '+schema);
  for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql'])await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
 }finally{cl.release();}
 url.searchParams.set('options','-c search_path='+schema+',public');

 // ---- Attrappe fuer Qdrant/Ollama/API (kein echtes Netz, keine Modelle)
 mock=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');
  const p=req.url;let a={result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},points_count:0}};
  if(p==='/')a={title:'fixture',version:'1.15.0'};
  else if(p.includes('/points/search'))a={result:[]};
  else if(p.includes('/points/scroll'))a={result:{points:[],next_page_offset:null}};
  else if(p.includes('/api/embed'))a={embeddings:[[1,0,0]]};
  else if(p.includes('/api/tags'))a={models:[{name:'t30-fixture',digest:'fixture'}]};
  else if(p.includes('/api/show'))a={model_info:{'fixture.embedding_length':3}};
  res.end(JSON.stringify(a));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const endpoint='http://127.0.0.1:'+mock.address().port;
 Object.assign(process.env,{DATABASE_URL:url.href,SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
  SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
  SYNAPSE_HINWEIS_BUDGET_MS:'5000',QDRANT_URL:endpoint,OLLAMA_URL:endpoint,EMBEDDING_BASE_URL:endpoint,SYNAPSE_API_URL:endpoint,
  OLLAMA_MODEL:'t30-fixture',EMBEDDING_PROVIDER:'ollama',EMBEDDING_TARGET_DIM:'3',EMBEDDING_PRAEFIXE:'aus',CHANNEL_SKILL_MIN_SCORE:'1.1'});

 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 const V=await load('packages/core/dist/services/agent-profil-vertrag.js');
 const T=await load('packages/core/dist/services/agent-token-tools.js');
 const CU=await load('packages/core/dist/services/chat-unread.js');
 const PL=await load('packages/core/dist/services/plans.js');
 const USER={art:'user'},SYS_USER={system:'user'},DAEMON={art:'daemon'};

 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 for(const p of [P,Q])await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[p,'rest-api','/virtual/'+p]);
 await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-pflicht-t30','rules','Pflichtregel T30',ARRAY['pflicht'])",[randomUUID(),P]);
 for(const n of ['t30-regel-a','t30-regel-b','t30-regel-c'])await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,$3,'rules','Regel '||$3,ARRAY[]::text[])",[randomUUID(),P,n]);

 // ---- REST: MCP-Strecke (Bearer access) und Web-UI-Profilrouten (Sitzung = User)
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();close.push(()=>app.close());
 const appUi=fastify({logger:false});
 await registerAgentProfilRoutes(appUi,{validateToken:async t=>t==='sess-t30'?{kind:'session',scope:null,token_hash:'x'}:null});
 await appUi.ready();close.push(()=>appUi.close());
 let seq=0;
 const rpcRoh=(method,params,headers={},auth=true)=>app.inject({method:'POST',url:'/mcp/messages',
  headers:{...(auth?{authorization:'Bearer '+bearer}:{}),'mcp-session-id':'p22-t30',...headers},payload:{jsonrpc:'2.0',id:++seq,method,params}});
 const rest=async(name,args,headers)=>{
  const r=await rpcRoh('tools/call',{name,arguments:args},headers);
  if(r.statusCode!==200)return {_status:r.statusCode,text:r.body};
  const j=r.json();if(j.error)return {_rpcError:j.error};
  return unwrap(j.result);
 };
 const restTools=async(headers)=>(await rpcRoh('tools/list',{},headers)).json().result?.tools??[];
 const ui=async(method,pfad,payload,auth=true)=>{
  const r=await appUi.inject({method,url:'/api/projects/'+P+'/agent-profile'+pfad,headers:auth?{authorization:'Bearer sess-t30'}:{},...(payload?{payload}:{})});
  let body=null;try{body=r.json();}catch{body={roh:r.body};/* keine JSON-Antwort: Rohtext fuer die Diagnose */}return {status:r.statusCode,body};
 };
 const fehlercode=r=>r?.error??r?.code??(r?._isError?'isError':null);
 const SRV='srv-t30';
 const tokenAufruf=(tool,args,arbeit)=>T.mitAgentToolAufruf(tool,args,SRV,arbeit);

 // ---- stdio: mcp-server als Kindprozess gegen dasselbe private Schema
 const {Client}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const sp=pathToFileURL(join(repo,'packages/mcp-server/dist/server.js')).href;
 const tp=pathToFileURL(join(repo,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href;
 const startStdio=async(extra={})=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
  delete env.SYNAPSE_AGENT_NAME;delete env.SYNAPSE_AGENT_TOKEN;Object.assign(env,extra);
  const transport=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval',
   'const {createServer}=await import('+JSON.stringify(sp)+');const {StdioServerTransport}=await import('+JSON.stringify(tp)+');await createServer().connect(new StdioServerTransport());'],
   cwd:repo,env,stderr:'pipe'});
  let err='';transport.stderr?.on('data',d=>{err+=d;if(err.length>20000)err=err.slice(-20000);});
  const client=new Client({name:'p22-t30',version:'1'});
  try{await client.connect(transport);}catch(e){throw Error('stdio-Start fehlgeschlagen: '+e.message+' stderr: '+mask(err.slice(-2000)));}
  close.push(()=>client.close());
  return {client,stderr:()=>mask(err.slice(-2000))};
 };
 const st=async(c,name,args)=>unwrap(await c.client.callTool({name,arguments:args}));

 // ---- Produkt-Schalter: EIN Schalter agenten_ausweis (Kern) + getrennte Verwaltungsfunktionen
 for(const f of ['agenten_ausweis','profilverwaltung','typkatalog','task_bindung'])
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:f,aktiv:true,grund:'Test P22-T30'},SYS_USER);
 const kern=await C.leseAusweisKern(P);
 check(kern.aktiv===true&&kern.quelle==='produkt-schalter'&&kern.agent_bezug_modus==='beide','Kern EIN ueber Produkt-Schalter agenten_ausweis, Modus beide');

 let schattenL,iidL,tokL,typId,iidX,tokX,iidY,tokY,thX,iidZ,tokZ,sx;

 // =====================================================================================================
 await schritt('a',async()=>{
  const reg=await rest('chat',{action:'register',id:L,project:P,model:'opus',agent_id:L});
  check(reg.success!==false&&!reg._isError&&!reg._status,'L meldet sich mit Name+Projekt an (chat register)');
  check(!/sai_[a-z0-9]{1,64}/.test(txt(reg)),'Anmeldung liefert KEINEN Ausweis');
  const th=await rest('thought',{action:'add',project:P,content:'T30 Legacy-Thought von L',source:L,agent_id:L});
  check(th.success===true,'L arbeitet normal: thought add ('+txt(th).slice(0,300)+')');
  check(!txt(th).includes('Agenten-Ausweis ist bereit'),'vor Bestaetigung kein Ausweis-Hinweis');
  const pl=await rest('plan',{action:'list',project:P,agent_id:L});
  check(pl.success!==false&&!pl._isError,'L arbeitet normal: plan list');
  await rest('channel',{action:'create',project:P,name:'t30-ch',created_by:K,agent_id:K});
  const cj=await rest('channel',{action:'join',project:P,channel_name:'t30-ch',agent_name:L,agent_id:L});
  check(cj.success===true,'L arbeitet normal: channel join');
  const dm=await rest('chat',{action:'send',project:P,sender_id:K,recipient_id:L,content:'T30 DM an L',agent_id:K});
  check(dm.success!==false&&!dm._isError,'DM an L zugestellt (chat send)');
  const s=(await pool.query('SELECT id,revision,zustand FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id=$2',[P,L])).rows;
  check(s.length===1&&s[0].zustand==='pending','Schatten fuer L entstanden (pending)');
  schattenL=s[0];
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[P,L])).rows[0].n===0,'vor Bestaetigung keine Identitaet fuer L');
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaet_tokens')).rows[0].n===0,'KEIN Token ausgestellt');
 });

 // =====================================================================================================
 await schritt('b',async()=>{
  const kb=await rest('admin',{action:'schattenprofil_bestaetigen',project:P,schattenprofil_id:schattenL.id,erwartete_revision:schattenL.revision,
   user_zustimmung:'T30: Freigabe Koordinator',grund:'T30 Legacy-Koordinator bestaetigt',agent_id:K});
  check(kb.success===true,'Legacy-Koordinator (ohne eigenen Ausweis) bestaetigt den Schatten per admin (Ergebnis: '+(fehlercode(kb)??'ok')+')');
  if(kb.success!==true){
   const ub=await ui('POST','/schattenprofile/'+schattenL.id+'/bestaetigen',{erwartete_revision:schattenL.revision,user_zustimmung:'T30 User',grund:'T30 Rueckfall User'});
   console.log('     Rueckfall fuer die Kette: User bestaetigt (REST agent-profile) -> '+ub.status);
   if(ub.status!==200)throw Error('Rueckfall User-Bestaetigung fehlgeschlagen: '+ub.status+' '+txt(ub.body));
  }
  iidL=(await pool.query('SELECT id FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[P,L])).rows[0]?.id;
  const t=(await pool.query('SELECT token_offen,gueltig_bis,zuletzt_benutzt,ausweis_weg FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL',[iidL])).rows[0];
  tokL=merke(t?.token_offen);
  check(AUS.test(tokL??'')&&t.gueltig_bis===null&&t.zuletzt_benutzt===null&&t.ausweis_weg==='schatten_bestaetigt','Bestaetigung: Ausweis sofort aktiv, noch unbenutzt');
  const h1=await rest('thought',{action:'search',project:P,query:'T30',agent_id:L});
  check(h1.success!==false&&!h1._isError,'naechster Legacy-Aufruf von L laeuft normal');
  check(txt(h1).includes('Agenten-Ausweis ist bereit')&&txt(h1).includes(tokL),'... und traegt den Hinweis mit Ausweis');
  const h1b=await rest('thought',{action:'search',project:P,query:'T30',agent_id:L});
  check(!txt(h1b).includes(tokL),'entprellt: kein Wiederholungshinweis im selben Kontext');
  await pool.query('UPDATE agent_sessions SET sitzung_seit=clock_timestamp() WHERE id=$1 AND project=$2',[L,P]);
  const h2=await rest('thought',{action:'search',project:P,query:'T30',agent_id:L});
  check(txt(h2).includes('Agenten-Ausweis ist bereit')&&txt(h2).includes(tokL),'nach Kontextverlust (neue Legacy-Sitzung) erneut mit Ausweis');
  const ob=await rest('admin',{action:'index_stats',project:P,agent_id:L,role:'subagent',sitzung:'fortsetzung',onboarding:true});
  check(!!ob.agentOnboarding&&ob.agentOnboarding.rules?.some(r=>r.name==='regel-pflicht-t30'),'Legacy-Onboarding der neuen Sitzung (index_stats fortsetzung, onboarding:true)');
  // Uebernahme: erster Aufruf mit token
  const u=await rest('thought',{action:'search',project:P,query:'T30',token:tokL});
  check(u.success!==false&&!u._isError&&!u.error,'L ruft mit token auf: angenommen');
  const lauf=(await pool.query('SELECT beginn_art,uebernommen_aus,zugestellt_regeln_stand FROM agent_identitaet_laeufe WHERE identity_id=$1 AND uebernommen_aus IS NOT NULL',[iidL])).rows;
  check(lauf.length===1&&lauf[0].beginn_art==='uebernahme'&&lauf[0].uebernommen_aus?.agent_id===L,'Uebernahme: Lauf beginn_art uebernahme, uebernommen_aus = L');
  check(!(u.agentOnboarding?.rules??[]).some(r=>r.name==='regel-pflicht-t30')&&!!lauf[0]?.zugestellt_regeln_stand,'keine erneuten Projektregeln (Regelstand uebernommen)');
  check((await pool.query('SELECT 1 FROM chat_messages WHERE project=$1 AND recipient_id=$2 AND recipient_identity_id=$3',[P,L,iidL])).rowCount===1,'offene DM auf die Identitaet umgehaengt');
  // Gelesen = Lesestand der Identitaet; ein frueherer Hinweis (Benachrichtigung) ist kein Lesen (P10-T62).
  const dmId=Number((await pool.query("SELECT id FROM chat_messages WHERE project=$1 AND content='T30 DM an L'",[P])).rows[0]?.id);
  const ls=(await pool.query('SELECT letzte_id FROM agent_identitaet_chat_lesestand WHERE project=$1 AND identity_id=$2',[P,iidL])).rows[0];
  check(dmId>0&&(!ls||Number(ls.letzte_id)<dmId),'DM bleibt ungelesen (Lesestand der Identitaet '+(ls?.letzte_id??'leer')+' < '+dmId+')');
  const ch=(await pool.query("SELECT id FROM specialist_channels WHERE project=$1 AND name='t30-ch'",[P])).rows[0]?.id;
  check((await pool.query('SELECT 1 FROM agent_identitaet_channel_mitglieder WHERE identity_id=$1 AND channel_id=$2',[iidL,ch])).rowCount===1,'Channel-Mitgliedschaft uebernommen');
  await pool.query('UPDATE agent_sessions SET sitzung_seit=clock_timestamp() WHERE id=$1 AND project=$2',[L,P]);
  const nie=await rest('thought',{action:'search',project:P,query:'T30',agent_id:L});
  check(!txt(nie).includes(tokL)&&!txt(nie).includes('Agenten-Ausweis ist bereit'),'danach nie wieder Ausweis-Hinweis (auch neue Legacy-Sitzung)');
 });

 // =====================================================================================================
 // P22-T33 (M1, Weg A): chat(register) OHNE token fuer einen Namen mit vorhandener Identitaet (Neuinstanz, Kern EIN) -> Legacy + Hinweis, KEIN Ausweis, kein name#2.
 await schritt('m1',async()=>{
  const idsVor=(await pool.query('SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1',[P])).rows[0].n;
  const tokVor=(await pool.query('SELECT count(*)::int n FROM agent_identitaet_tokens')).rows[0].n;
  await pool.query('DELETE FROM agent_sessions WHERE id=$1 AND project=$2',[L,P]);
  const r2=await rest('chat',{action:'register',id:L,project:P,model:'opus',agent_id:L});
  check(r2.success!==false&&!r2._isError&&!r2._status,'M1: register ohne token fuer den vorhandenen Namen L angenommen ('+txt(r2).slice(0,160)+')');
  check(!/sai_[a-z0-9]{1,64}/.test(txt(r2))&&!r2.token,'M1: Antwort ohne Ausweis');
  check(typeof r2.neuinstanz_hinweis==='string'&&r2.neuinstanz_hinweis.includes('anmelden'),'M1: Hinweis TEXT_NEUINSTANZ (mit Ausweis chat(anmelden, token))');
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1',[P])).rows[0].n===idsVor,'M1: keine zweite Identitaet (kein name#2)');
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaet_tokens')).rows[0].n===tokVor,'M1: kein neuer Ausweis');
  check((await pool.query('SELECT 1 FROM agent_sessions WHERE id=$1 AND project=$2 AND identity_id IS NULL',[L,P])).rowCount===1,'M1: Legacy-Sitzung ohne Identitaetsbindung');
 });

 // =====================================================================================================
 await schritt('c',async()=>{
  await rest('chat',{action:'register',id:L2,project:P,model:'sonnet',agent_id:L2});
  const s2=(await pool.query('SELECT id,revision FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id=$2',[P,L2])).rows[0];
  check(!!s2,'Schatten S2 entstanden');
  await pool.query("UPDATE agent_schattenprofile SET erstellt_am=NOW()-INTERVAL '25 hours', ablauf_am=NOW()-INTERVAL '1 hour' WHERE id=$1",[s2.id]);
  const ub=await ui('POST','/schattenprofile/'+s2.id+'/bestaetigen',{erwartete_revision:s2.revision,user_zustimmung:'T30',grund:'T30 nach 24 h'});
  check(ub.status!==200,'S2 nach 24 h nicht mehr bestaetigbar (HTTP '+ub.status+', '+(ub.body?.error?.code??ub.body?.error??'-')+')');
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[P,L2])).rows[0].n===0,'kein Ausweis/keine Identitaet fuer S2');
  const pend=await ui('GET','/schattenprofile?zustand=pending');
  check(pend.status===200&&!txt(pend.body).includes(s2.id),'S2 nicht mehr in der Liste pending');
  const hl=await rest('thought',{action:'search',project:P,query:'x',agent_id:L2});
  check(!txt(hl).includes('Agenten-Ausweis ist bereit'),'kein Ausweis-Hinweis fuer erloschenen Schatten');
 });

 // =====================================================================================================
 await schritt('d',async()=>{
  const ty=await ui('POST','/typen',{profil_scope:'projekt',typ_schluessel:'t30-tester',typ_inhalt:{kontext_stufe:'kompakt'},grund:'T30 Typ fuer X'});
  typId=ty.body?.typ?.id;
  check(ty.status===200&&!!typId,'Typ t30-tester angelegt (User, REST)');
  const v=await rest('admin',{action:'agent_vorbereiten',project:P,agent_name:X,typ_id:typId,profil_patch:{regeln:['t30-regel-a','t30-regel-b']},
   grund:'T30 Koordinator bereitet X vor',agent_id:K});
  tokX=merke(v.token);iidX=v.identity_id;
  check(v.success===true&&AUS.test(tokX??'')&&v.zustand==='ausgestellt','Koordinator agent_vorbereiten(X, Typ, Regeln): Ausweis mit Frist ('+(fehlercode(v)??'ok')+')');
  check(v.startkonfiguration?.erste_aktion?.tool==='chat'&&v.startkonfiguration.erste_aktion.argumente?.action==='anmelden'&&v.startkonfiguration.erste_aktion.argumente.token===tokX
   &&v.startkonfiguration.startsatz?.includes(tokX),'Startkonfiguration: erste Aktion chat(anmelden, token), Startsatz mit Ausweis');
  const i=(await pool.query('SELECT typ_id,profil,profil_revision FROM agent_identitaeten WHERE id=$1',[iidX])).rows[0];
  check(i?.typ_id===typId&&txt(i.profil?.regeln)==='["t30-regel-a","t30-regel-b"]'&&i.profil_revision===1,'Profil Rev 1 mit Typ und Regeln');
  const an=await rest('chat',{action:'anmelden',token:tokX});
  check(an.success===true&&an.principal?.identity_id===iidX,'X meldet sich innerhalb der Frist mit token an');
  // P22-T48: Typ-Agent bekommt nur die Regeln seines Profils voll, die Pflichtregel nur als Name im Verzeichnis.
  check(an.agentOnboarding?.rules?.map(r=>r.name).sort().join()==='t30-regel-a,t30-regel-b'&&an.agentOnboarding.rules.every(r=>r.vollstaendig)
   &&an.agentOnboarding.regel_verzeichnis?.regeln?.includes('regel-pflicht-t30')&&an.agentOnboarding.zustellung?.regeln_quelle==='typ','Anmeldung: Typ-Regeln vollstaendig, Pflichtregel als Name (P22-T48)');
  // P22-T50: kein fortsetzung-Block; Profil kompakt im Onboarding, Typ-Regeln stehen in rules (nicht doppelt im Profil).
  const pX=an.agentOnboarding?.profil;
  check(!('open_plans' in an)&&!('fortsetzung' in an),'REST chat(anmelden): kein fortsetzung-Block, kein allgemeines open_plans (P22-T50)');
  check(!('fortsetzung' in an)&&pX?.profil_revision===1&&!('regeln' in pX)&&!('identity_id' in pX)&&pX.typ?.schluessel==='t30-tester','Anmeldung: Profilblock im Onboarding (Rev 1, Typ, Regeln nicht doppelt)');
  const z=(await pool.query('SELECT gueltig_bis,zuletzt_benutzt FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL',[iidX])).rows[0];
  check(z?.gueltig_bis===null&&z.zuletzt_benutzt!==null,'erste Anmeldung bestaetigt: Ausweis dauerhaft');
  const th=await rest('thought',{action:'add',project:P,content:'T30 Thought von X',token:tokX});
  thX=th.id??th.thought?.id;
  check(th.success===true&&!!thX,'X arbeitet mit token (thought add)');
  const y=await rest('admin',{action:'agent_vorbereiten',project:P,agent_name:'t30-y',grund:'T30 Ausweis Y bleibt ungenutzt',agent_id:K});
  tokY=merke(y.token);iidY=y.identity_id;
  check(y.success===true&&y.zustand==='ausgestellt','Ausweis Y ausgestellt');
  await pool.query("UPDATE agent_identitaet_tokens SET gueltig_bis=NOW()-INTERVAL '1 minute' WHERE token_offen=$1",[tokY]);
  const ya=await rest('chat',{action:'anmelden',token:tokY});
  check(ya.success!==true&&txt(ya).includes('agent_token_ungueltig'),'Y ungenutzt nach Frist -> ungueltig ('+(fehlercode(ya)??'-')+')');
  const yt=await rest('thought',{action:'search',project:P,query:'x',token:tokY});
  check(yt.success!==true&&txt(yt).includes('agent_token_ungueltig'),'Y auch fuer normale Aufrufe ungueltig');
 });

 // =====================================================================================================
 await schritt('e',async()=>{
  process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
  try{
   const vorher=await rest('shell',{action:'history',project:P,limit:1,token:tokX});
   check(vorher.success!==false&&!vorher._isError,'Positivkontrolle: shell vor der Sperre erlaubt');
   const ae=await ui('POST','/profile/'+iidX+'/aendern',{erwartete_revision:1,profil_patch:{regeln:['t30-regel-a','t30-regel-c'],zuschnitt:{tools:{shell:'verweigert'}}},grund:'T30 Profil X aendern'});
   check(ae.status===200&&ae.body?.profil_revision===2,'User aendert Profil X (Regel neu/entfernt, shell gesperrt) -> Rev 2');
   const e1=await rest('shell',{action:'history',project:P,limit:1,token:tokX});
   check(e1.success===false||e1._isError===true,'naechster Aufruf: Sperre sofort wirksam (shell abgelehnt: '+(fehlercode(e1)??'-')+')');
   const e2=await rest('thought',{action:'get',project:P,id:thX,token:tokX});
   check(e2.success!==false&&!e2._isError,'nicht gesperrtes Werkzeug laeuft weiter');
   const alle=txt(e1)+txt(e2);
   const n=(alle.match(/Profil-Update \(Revision 1 -> 2\)/g)||[]).length;
   check(n===1,'Diff-Hinweis Profil-Update (Revision 1 -> 2) genau einmal ('+n+')');
   check(alle.includes('Regel t30-regel-b entfernt')&&alle.includes('Regel t30-regel-c neu')&&alle.includes('Werkzeug shell gesperrt'),'Diff nennt entfernte/neue Regel und gesperrtes Werkzeug');
   const e3=await rest('thought',{action:'get',project:P,id:thX,token:tokX});
   check(!txt(e3).includes('Profil-Update'),'einmal je Lauf: kein zweiter Diff-Hinweis');
  }finally{delete process.env.SYNAPSE_W1B_DURCHSETZUNG;}
 });

 // =====================================================================================================
 await schritt('f',async()=>{
  sx=await startStdio();
  const fa=await st(sx,'chat',{action:'anmelden',token:tokX});
  check(fa.success===true&&fa.principal?.identity_id===iidX,'stdio (Modellwechsel): X meldet sich mit demselben token (Parameter) an, gleiche Identitaet');
  check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND name LIKE 't30-x%'",[P])).rows[0].n===1,'keine zweite Identitaet (kein name#2)');
  check(fa.agentOnboarding?.rules?.map(r=>r.name).sort().join()==='t30-regel-a,t30-regel-c'&&fa.agentOnboarding.rules.every(r=>r.vollstaendig)
   &&fa.agentOnboarding.regel_verzeichnis?.regeln?.includes('regel-pflicht-t30'),'stdio: Typ-Regeln (Rev 2) vollstaendig, Pflichtregel als Name (P22-T48)');
  const pF=fa.agentOnboarding?.profil;
  check(!('fortsetzung' in fa)&&pF?.profil_revision===2&&!('regeln' in pF)&&pF.werkzeuge?.gesperrt?.includes('shell'),'stdio: Profilblock im Onboarding aktuell (Rev 2, shell gesperrt, Regeln nur in rules)');
  const row=(await pool.query('SELECT source_identity_id FROM thoughts WHERE id=$1',[thX])).rows[0];
  check(row?.source_identity_id===iidX,'Thought von X traegt source_identity_id');
  const tg=await st(sx,'thought',{action:'get',project:P,id:thX,token:tokX});
  check(txt(tg).includes('T30 Thought von X'),'stdio: Thought von X auffindbar');
  check(!(tg.agentOnboarding?.rules??[]).length&&!tg.agentOnboarding?.profil&&!('fortsetzung' in tg),'keine Volluebertragung im selben Lauf (Folgeaufruf ohne Regeln/Profilblock)');
  if(!fa.success)console.log('     stdio stderr: '+sx.stderr());
 });

 // =====================================================================================================
 await schritt('g',async()=>{
  // Zielnamen bezeichnen den Legacy-Namensraum; die Identitaet wird als identity:<id> adressiert (kommunikation-agent.ts).
  const gm=await rest('chat',{action:'send',project:P,sender_id:L,recipient_id:'identity:'+iidX,content:'T30 Nachricht L an X',token:tokL});
  check(gm.success!==false&&!gm._isError,'L sendet Nachricht an X');
  check((await pool.query("SELECT 1 FROM chat_messages WHERE project=$1 AND content='T30 Nachricht L an X' AND recipient_identity_id=$2",[P,iidX])).rowCount===1,'Nachricht an die Identitaet von X adressiert');
  const gx=await rest('thought',{action:'get',project:P,id:thX,token:tokX});
  const hinweis=txt({u:gx.unreadChat,h:gx.ausloeser_hinweise});
  check(hinweis.includes(L),'Kurzhinweis bei X (naechster Aufruf): '+hinweis.slice(0,300));
  // P22-T31 Punkt 4 (Koordinator-Entscheidung 623b0b95): eine DM an den NAMEN erreicht die Identitaet, wenn es genau eine aktive Identitaet mit Ausweis gibt und keine Legacy-Sitzung dieses Namens.
  await rest('chat',{action:'send',project:P,sender_id:K,recipient_id:X,content:'T30 DM an Namen X',agent_id:K});
  check((await pool.query("SELECT 1 FROM chat_messages WHERE project=$1 AND content='T30 DM an Namen X' AND recipient_identity_id=$2",[P,iidX])).rowCount===1,'DM an den Namen erreicht die Identitaet von X');
  const gn=await rest('thought',{action:'get',project:P,id:thX,token:tokX});
  check(txt({u:gn.unreadChat,h:gn.ausloeser_hinweise}).includes(K),'Kurzhinweis bei X nach DM an den Namen');
  const rs=await ui('POST','/vorbereiten',{ziel_identity_id:iidX,grund:'T30 Respawn X'});
  check(rs.status===200&&rs.body?.token===tokX&&rs.body?.zustand==='aktiv','Respawn X: derselbe Ausweis');
  const ds=await C.W12_DIENSTE.ausweis.ausweisFuerStart(P,iidX,DAEMON);
  check(ds.token===tokX&&ds.neu===false,'Daemon agent_start fuer X: derselbe Ausweis');
  check((await pool.query('SELECT count(*)::int n FROM agent_identitaet_tokens WHERE identity_id=$1',[iidX])).rows[0].n===1,'genau eine Ausweiszeile fuer X');
  const sa=await st(sx,'thought',{action:'get',project:P,id:thX,token:tokX});
  check(sa.success!==false&&!sa._isError,'nach Respawn/Daemon-Start: Ausweis ueber stdio weiter gueltig');
 });

 // =====================================================================================================
 await schritt('h',async()=>{
  const z=await ui('POST','/vorbereiten',{agent_name:'t30-z',grund:'T30 Ausweis Z'});
  tokZ=merke(z.body?.token);iidZ=z.body?.identity_id;
  check(z.status===200&&AUS.test(tokZ??''),'User bereitet Z vor');
  await rest('chat',{action:'anmelden',token:tokZ});
  const ug=await ui('GET','/profile/'+iidZ+'/token?anlass=T30-Abruf');
  check(ug.status===200&&ug.body?.token===tokZ,'User ruft Ausweis ab');
  const kg=await rest('admin',{action:'token_abrufen',project:P,ziel_identity_id:iidZ,anlass:'T30-Abruf',agent_id:K});
  check(kg.success===true&&kg.token===tokZ,'Legacy-Koordinator ruft Ausweis ab');
  const sg=await rest('admin',{action:'token_abrufen',project:P,ziel_identity_id:iidZ,anlass:'T30-Abruf',agent_id:SUB});
  check(sg.success===false&&sg.error==='recht_fehlt'&&!txt(sg).includes(tokZ),'Legacy-Subagent: recht_fehlt');
  const xg=await rest('admin',{action:'token_abrufen',project:P,ziel_identity_id:iidZ,anlass:'T30-Abruf',token:tokX});
  check(xg.success===false&&xg.error==='recht_fehlt'&&!txt(xg).includes(tokZ),'Subagent mit Ausweis: recht_fehlt');
  const sl=await rest('admin',{action:'token_loeschen',project:P,ziel_identity_id:iidZ,grund:'T30 Subagent versucht',agent_id:SUB});
  check(sl.success===false&&sl.error==='recht_fehlt','Subagent darf nicht loeschen');
  const kl=await rest('admin',{action:'token_loeschen',project:P,ziel_identity_id:iidZ,grund:'T30 Koordinator loescht Z',agent_id:K});
  check(kl.success===true&&kl.geloescht===true,'Legacy-Koordinator loescht Ausweis Z');
  const za=await rest('chat',{action:'anmelden',token:tokZ});
  check(za.success!==true&&txt(za).includes('agent_token_ungueltig'),'nach Loeschen: token ungueltig');
  const ud=await ui('DELETE','/profile/'+iidY+'/token?grund=T30%20User%20loescht%20Y');
  check(ud.status===200&&ud.body?.geloescht===true,'User loescht Ausweis Y');
 });

 // =====================================================================================================
 await schritt('i',async()=>{
  await rest('channel',{action:'post',project:P,channel_name:'t30-ch',sender:X,content:'T30 Channel-Post von X',token:tokX});
  await warte(500);
  const dump=JSON.stringify([
   (await pool.query('SELECT * FROM tool_calls')).rows,(await pool.query('SELECT * FROM agent_identitaet_audit')).rows,
   (await pool.query('SELECT * FROM agent_token_abruf_audit')).rows,(await pool.query('SELECT * FROM thoughts')).rows,
   (await pool.query('SELECT * FROM specialist_channel_messages')).rows,(await pool.query('SELECT * FROM chat_messages')).rows,
   (await pool.query('SELECT * FROM agent_schattenprofil_audit')).rows,(await pool.query('SELECT * FROM agent_profil_revisionen')).rows]);
  const n=(await pool.query('SELECT count(*)::int n FROM tool_calls')).rows[0].n;
  check(n>0,'tool_calls wurden geschrieben ('+n+')');
  check(!/sai_[a-z0-9]{1,64}/.test(dump)&&[...tokens].every(t=>!dump.includes(t)),'Ausweis-Wert nie in tool_calls/Audit/Thought/Channel/Chat');
  const r401=await rpcRoh('tools/call',{name:'thought',arguments:{action:'search',project:P,query:'x',token:tokX}},{},false);
  check(r401.statusCode===401,'REST /mcp/messages ohne Bearer -> 401 (auch mit Ausweis)');
  const u401=await ui('GET','/profile/'+iidX+'/token?anlass=x',undefined,false);
  check(u401.status===401,'REST agent-profile ohne Bearer -> 401');
 });

 // =====================================================================================================
 await schritt('j',async()=>{
  await pool.query(`INSERT INTO plans(id,project,name,description,goals,architecture,tasks,created_at,updated_at,kurz_id,aktiv,naechste_task_nr,prioritaet)
    VALUES($1,$2,'T30 Plan','',$3,'','[]'::jsonb,NOW(),NOW(),'P1',true,1,'mittel')`,[randomUUID(),P,[]]);
  const t1=await PL.addTask(P,'T30 gebunden 1','Bindung an X','medium');
  const t2=await PL.addTask(P,'T30 gebunden 2','Bindung an X (Header)','medium');
  for(const t of [t1,t2])await V.taskBindungDienst.legeFest(P,t.id,{art:'identitaet',identity_id:iidX},USER,'T30 Bindung an X');
  const status=async id=>(await PL.getAllePlaene(P)).flatMap(p=>p.tasks).find(t=>t.id===id)?.status;
  const o=await rest('plan',{action:'update_task',project:P,task_id:t1.id,status:'in_progress',agent_id:SUB});
  check(o.success!==true&&txt(o).includes('grund_noetig')&&await status(t1.id)==='todo','Legacy ohne grund -> grund_noetig, Status unveraendert');
  const m=await rest('plan',{action:'update_task',project:P,task_id:t1.id,status:'in_progress',agent_id:SUB,grund:'T30: Legacy mit Grund'});
  check(m.success!==false&&!m._isError&&await status(t1.id)==='in_progress','Legacy mit grund -> ok');
  const ho=await rest('plan',{action:'update_task',project:P,task_id:t2.id,status:'in_progress'},{'x-synapse-agent':SUB});
  check(ho.success!==true&&txt(ho).includes('grund_noetig')&&await status(t2.id)==='todo','Header-ID ohne grund -> grund_noetig');
  const hm=await rest('plan',{action:'update_task',project:P,task_id:t2.id,status:'in_progress',grund:'T30: Header mit Grund'},{'x-synapse-agent':SUB});
  check(hm.success!==false&&!hm._isError&&await status(t2.id)==='in_progress','Header-ID mit grund -> ok');
  const aud=(await pool.query("SELECT task_id,wer,grund FROM plan_task_bindung_audit WHERE project=$1 AND aktion='aendern'",[P])).rows;
  check(aud.length===2&&aud.every(a=>a.wer==='legacy:'+SUB),'je Legacy-Update genau ein Audit-Eintrag (legacy:'+SUB+')');
  const xo=await rest('plan',{action:'update_task',project:P,task_id:t1.id,status:'done',token:tokX});
  check(xo.success!==false&&!xo._isError&&await status(t1.id)==='done','gebundene Identitaet X mit Ausweis: ohne grund erlaubt');
 });

 // =====================================================================================================
 await schritt('k',async()=>{
  const req=(tools,name)=>tools.find(t=>t.name===name)?.inputSchema?.required??[];
  const props=(tools,name)=>tools.find(t=>t.name===name)?.inputSchema?.properties??{};
  const ohne=await restTools();
  check(req(ohne,'thought').includes('project')&&!!props(ohne,'thought').token,'REST tools/list ohne Ausweis: project required, token beworben');
  const mit=await restTools({'x-synapse-agent-token':tokX});
  check(!req(mit,'thought').includes('project')&&req(mit,'thought').length>0,'REST tools/list mit Ausweis + Kern EIN: project optional');
  const so=(await sx.client.listTools()).tools;
  check(req(so,'thought').includes('project'),'stdio tools/list ohne Ausweis: project required');
  const sm=await startStdio({SYNAPSE_AGENT_TOKEN:tokX});
  const smt=(await sm.client.listTools()).tools;
  check(!req(smt,'thought').includes('project'),'stdio tools/list mit Ausweis (Bestand SYNAPSE_AGENT_TOKEN) + Kern EIN: project optional');
  const ohneP=await st(sx,'thought',{action:'get',id:thX,token:tokX});
  check(txt(ohneP).includes('T30 Thought von X'),'Aufruf mit token ohne project angenommen (Projekt aus dem Ausweis)');
 });

 // =====================================================================================================
 await schritt('l',async()=>{
  process.env.SYNAPSE_AGENT_BEZUG_MODUS='alt';
  try{
   const e1=await fehler(()=>C.setzeProfilProduktSchalter({ebene:'projekt',project:Q,funktion:'agenten_ausweis',aktiv:true,grund:'T30 l einzeln'},SYS_USER));
   check(e1==='agent_bezug_modus_nicht_beide','agenten_ausweis EIN bei Modus alt -> agent_bezug_modus_nicht_beide');
   const e2=await fehler(()=>C.setzeProfilProduktSchalter({ebene:'projekt',project:Q,funktion:'alle',aktiv:true,grund:'T30 l alle'},SYS_USER));
   const zeilen=(await pool.query("SELECT funktion,aktiv FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1",[Q])).rows;
   const ps=await C.leseProfilProduktSchalter('agenten_ausweis',Q);
   check(e2==='agent_bezug_modus_nicht_beide','funktion \'alle\' EIN bei Modus alt -> ebenfalls agent_bezug_modus_nicht_beide (Ergebnis: '+(e2??'kein Fehler; geschrieben '+txt(zeilen)+'; Produkt-Schalter agenten_ausweis aktiv='+ps.aktiv+' ueber '+ps.regel_funktion)+')');
   const k=await C.leseAusweisKern(Q);
   check(k.aktiv===false&&k.letzter_fehler==='agent_bezug_modus_nicht_beide','Kern bei Modus alt trotzdem wirksam AUS, sichtbar als agent_bezug_modus_nicht_beide');
  }finally{
   process.env.SYNAPSE_AGENT_BEZUG_MODUS='beide';
   await pool.query('DELETE FROM agent_profil_schalter WHERE project=$1',[Q]);
  }
 });

 // =====================================================================================================
 await schritt('gegenprobe-aus',async()=>{
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agenten_ausweis',aktiv:false,grund:'T30 Gegenprobe AUS'},SYS_USER);
  check((await C.leseAusweisKern(P)).aktiv===false,'Kern AUS');
  const r=await rest('chat',{action:'register',id:'t30-aus',project:P,model:'opus',agent_id:'t30-aus'});
  check(r.success!==false&&!r._isError,'Legacy-Anmeldung unveraendert');
  check((await pool.query("SELECT count(*)::int n FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id='t30-aus'",[P])).rows[0].n===0,'Kern AUS: kein Schatten');
  const t=await rest('thought',{action:'get',project:P,id:thX,token:tokX});
  check(t.success===false&&txt(t).includes('token_identitaet_aus'),'Aufruf mit token -> token_identitaet_aus (Bestandsantwort)');
  const tl=await restTools({'x-synapse-agent-token':tokX});
  const th=tl.find(x=>x.name==='thought')?.inputSchema;
  check(th?.required?.includes('project')&&!th?.properties?.token,'tools/list (auch mit Ausweis-Header): Schema wie t110, project required, kein token');
  const lg=await rest('thought',{action:'search',project:P,query:'x',agent_id:L});
  check(lg.success!==false&&!txt(lg).includes('Agenten-Ausweis'),'Legacy-Aufruf normal, ohne Ausweis-Hinweise');
 });

 console.log('\nE2E-Schritte (ok/fail):');
 for(const [n,s]of Object.entries(schritte))console.log('  '+n.padEnd(15)+' '+(s.fail?'ROT ':'GRUEN')+'  '+s.ok+'/'+s.fail);
 console.log('P22-T30 W12-I: '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
}catch(e){console.error(mask(e?.stack||e));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(e){console.error(mask('Cleanup: '+e.message));}
 try{if(pool)await pool.end();}catch{/* ignorieren */}
 mock?.close();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(e=>console.error('Aufraeumen: '+e.message));
 await admin.end();
}
process.exit(process.exitCode||0);
