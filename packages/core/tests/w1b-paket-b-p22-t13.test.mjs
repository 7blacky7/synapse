/**
 * P22-T13 Paket B (Anmeldung): Legacy-register + additives Schattenprofil, Koordinator-Hinweis, einmalige Token-Zustellung,
 * erster Koordinator (atomar), tokenfreie Koordinatorliste mit Herkunftsort, Fortsetzungsantwort, Token-Portabilitaet.
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Daemon. REST (fastify inject) UND stdio (InMemory).
 *   node packages/core/tests/w1b-paket-b-p22-t13.test.mjs                 alle Pruefungen (P22_T13_B_MODUS=alt|beide|neu, Standard neu)
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
const modus=process.env.P22_T13_B_MODUS||'neu';
assert.ok(['alt','beide','neu'].includes(modus));
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_W1B_ANMELDUNG','SYNAPSE_W1B_SCHATTEN_HINWEIS_MS','SYNAPSE_AGENT_TOKEN_SCHLUESSEL','SYNAPSE_MAIN_SYNAPSE'])delete process.env[k];
const SCHLUESSEL=randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'0',SYNAPSE_TOKEN_IDENTITAET:'1',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_AGENT_BEZUG_MODUS:modus,
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t13_b_'+process.pid+'_'+randomUUID().slice(0,8);
const project='p22-t13-b-main',legacy='legacy-client',thoughtId='00000000-0000-4000-8000-0000000b0113';
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,chatSvc,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s))
 .replace(/sai_[a-f0-9]{64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){
 try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}
 catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}
}
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LAUFZEIT=new Set(['ms','dauer_ms','durationMs','duration_ms','sitzung_seit','sitzungSeit','registeredAt','registered_at','last_seen','lastSeen','timestamp','created_at','updated_at','zeit','cutoffDate']);
/** Nur Laufzeitwerte normalisieren (Zeit, IDs, Ausweise); nie fachliche Werte. */
function norm(v){
 return JSON.parse(JSON.stringify(v,(k,x)=>{
  if(LAUFZEIT.has(k))return '<laufzeit>';
  if(typeof x==='string')return x.replace(/sai_[a-f0-9]{64}/g,'<ausweis>').replace(/sai_[a-f0-9]{8}/g,'<praefix>')
   .replace(UUID,'<uuid>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?/g,'<ts>');
  return x;
 }));
}
const TOKEN=/sai_[a-f0-9]{64}/;

async function transports(){
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();
 close.push(()=>app.close());
 const rpc=async(method,params,extra={})=>{
  const r=await app.inject({method:'POST',url:'/mcp/messages',
   headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t13-b',...extra},
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
 const server=createServer(),client=new Client({name:'p22-t13-b',version:'1'});
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

/** AUS-Vertrag: identisch zwischen t109 und neuem Stand (W1b-Anmeldung Standard AUS, 113 nicht angewendet). */
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
  g[n+'.register']=reg;
  g[n+'.anmelden.ohne_projekt']=await t.call('chat',{action:'anmelden',token:reg.token});
  g[n+'.token.thought.get']=await t.call('thought',{action:'get',project,id:thoughtId,token:reg.token});
  g[n+'.koordinator_liste']=await t.call('chat',{action:'koordinator_liste',project});
  const k=await t.call('chat',{action:'register',id:'koordinator',project:project+'-gold-'+n});
  if(k.token)secrets.push(k.token);
  g[n+'.register.koordinator']=k;
  g[n+'.epoch']=(await pool.query('SELECT context_epoch FROM agent_identitaeten WHERE agent_id=$1 AND project=$2 ORDER BY project',['golden-'+n,project])).rows;
  g[n+'.legacy.register']=await t.call('chat',{action:'register',id:legacy,project,model:'synthetic'});
 }
 g['audit.token-identitaet']=(await pool.query("SELECT tool_name,action,error,ok FROM tool_calls WHERE source='token-identitaet' ORDER BY id")).rows;
 g['hinweis.zustellungen']=(await pool.query('SELECT count(*)::int n FROM ausloeser_hinweis_aufrufe')).rows;
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
 const schemata=['agent-identitaet-schema','agent-bezug-schema'];
 if(!goldenOut)schemata.push('agent-profil-schema');
 for(const file of schemata){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[thoughtId,project,'synthetic','W1b B fixture',[]]);
 chatSvc=await load('packages/core/dist/services/chat.js');await chatSvc.registerAgent(legacy,project,'synthetic');

 if(goldenOut){
  const T=await transports();
  writeFileSync(goldenOut,JSON.stringify(await goldenFaelle(T),null,1));
  console.log('Golden-Dump geschrieben ('+root+', Modus '+modus+')');
 }else{
  const C=core,T=await transports(),{rest,stdio}=T;
  const sh=v=>JSON.stringify(v);
  const schalterEin=async()=>{process.env.SYNAPSE_W1B_ANMELDUNG='1';C.leereAnmeldungGateCache();C.initialisiereW1bAnmeldungHinweise();};
  const schalterAus=async()=>{delete process.env.SYNAPSE_W1B_ANMELDUNG;C.entregistriereW1bAnmeldungHinweise();C.leereAnmeldungGateCache();};
  const produkt=async(aktiv,proj)=>{await C.setzeProfilProduktSchalter({ebene:proj?'projekt':'global',project:proj,funktion:'schattenprofile',aktiv,grund:'test w1b paket b'},{system:'user'});C.leereAnmeldungGateCache();};
  const schatten=async(agent,proj=project)=>(await pool.query('SELECT * FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id=$2 ORDER BY erstellt_am',[proj,agent])).rows;
  const sitzungText=async(id)=>(await pool.query('SELECT COALESCE(sitzung_seit,registered_at)::text AS s FROM agent_sessions WHERE id=$1',[id])).rows[0]?.s;
  const bestaetige=async(row)=>C.PAKET_A_DIENSTE.schatten.bestaetigeSchattenprofil({schattenprofil_id:row.id,erwartete_revision:row.revision,
   user_zustimmung:'User: Test-Zustimmung',grund:'Paket-B-Test'},{art:'user'});
  const hinweise=r=>Array.isArray(r?.ausloeser_hinweise)?r.ausloeser_hinweise:[];
  const eigene=modus!=='alt';

  await section('AUS = t109 (Schalter AUS)',async()=>{
   await schalterAus();
   for(const t of [rest,stdio]){
    const chat=(await t.list()).find(x=>x.name==='chat');
    check(!chat.inputSchema.properties.action.enum.includes('koordinator_liste'),'AUS: koordinator_liste nicht beworben '+t.name);
    const r=await t.call('chat',{action:'register',id:'aus-'+t.name,project,model:'synthetic'});
    if(r.token)secrets.push(r.token);
    check(r.success===true&&TOKEN.test(r.token||''),'AUS: register liefert wie t109 sofort den Token '+t.name);
    const a=await t.call('chat',{action:'anmelden',token:r.token});
    check(a.success===true&&a.fortsetzung===undefined,'AUS: anmelden ohne Fortsetzungsantwort '+t.name);
    const l=await t.call('chat',{action:'koordinator_liste',project});
    check(l.success!==true&&l.koordinatoren===undefined,'AUS: koordinator_liste ist eine unbekannte Aktion '+t.name);
    const th=await t.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy});
    check(hinweise(th).length===0,'AUS: keine W1b-Hinweise '+t.name);
   }
   check((await pool.query('SELECT count(*)::int n FROM agent_schattenprofile')).rows[0].n===0,'AUS: keine Schattenprofile');
   check((await pool.query('SELECT count(*)::int n FROM ausloeser_hinweis_aufrufe')).rows[0].n===0,'AUS: keine Hinweisverarbeitung (leere Registry)');
   const s=await C.registerChatAgent('aus-legacy',project,'synthetic');
   check(s.id==='aus-legacy'&&s.status==='active'&&(await schatten('aus-legacy')).length===0,'AUS: registerChatAgent = Legacy-Registrierung ohne Schatten');
   // Produkt-Schalter EIN, aber Env AUS: weiterhin AUS (beide muessen EIN sein)
   await produkt(true);
   await C.registerChatAgent('aus-legacy-2',project,'synthetic');
   check((await schatten('aus-legacy-2')).length===0,'Produkt-Schalter allein aktiviert nichts (Env AUS)');
   await produkt(false);
  });

  await section('EIN: Legacy-Anmeldung + Schattenprofil (K3B)',async()=>{
   process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL=SCHLUESSEL;
   await schalterEin();
   await produkt(false);
   const aus=await rest.call('chat',{action:'register',id:'ein-aus',project,model:'claude-test'});
   check(aus.success===true&&(await schatten('ein-aus')).length===0,'Produkt-Schalter AUS: kein Schattenprofil, Token-Weg wie t109');
   await produkt(true);
   for(const t of [rest,stdio]){
    const id='ein-'+t.name;
    const r=await t.call('chat',{action:'register',id,project,model:'claude-test'});
    check(r.success===true&&r.token===undefined&&r.principal===undefined,'register ohne Token = Legacy-Antwort '+t.name);
    const sess=(await pool.query('SELECT identity_id FROM agent_sessions WHERE id=$1 AND project=$2',[id,project])).rows[0];
    check(sess&&sess.identity_id===null,'Legacy-Sitzung ohne Identitaet '+t.name);
    const s=await schatten(id);
    check(s.length===1&&s[0].zustand==='pending'&&s[0].ursprung_art==='legacy_register','genau ein pending Schattenprofil '+t.name);
    check(s[0]?.selbstangaben?.modell==='claude-test'&&s[0]?.selbstangaben?.name===id,'Selbstangaben erhalten '+t.name);
    check(s[0]?.ursprung_sitzung===await sitzungText(id),'Ursprungssitzung = agent_sessions.sitzung_seit '+t.name);
    check(/^[a-f0-9]{64}$/.test(s[0]?.vorgesehener_token_hash||''),'vorgesehener Token liegt (gehasht) vor '+t.name);
    check((await pool.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[project,id])).rows.length===0
     &&(await pool.query('SELECT 1 FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id=t.identity_id WHERE i.project=$1 AND i.agent_id=$2',[project,id])).rows.length===0,
     'vor Bestaetigung weder Identitaet noch gueltiger Token '+t.name);
    check(Math.abs(new Date(s[0].ablauf_am)-new Date(s[0].erstellt_am)-86400000)<2000,'24 h Frist '+t.name);
    const ablauf=s[0].ablauf_am.toISOString();
    await t.call('chat',{action:'register',id,project,model:'claude-test'});
    const s2=await schatten(id);
    check(s2.length===1&&s2[0].ablauf_am.toISOString()===ablauf,'Wiederholung: zusammengefuehrt, Frist nicht verlaengert '+t.name);
   }
   // Ausfall der Entwurfsablage: Standardanmeldung bleibt erfolgreich (K3B)
   delete process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL;
   const ohneKey=await stdio.call('chat',{action:'register',id:'ein-ohne-key',project,model:'claude-test'});
   check(ohneKey.success===true&&(await schatten('ein-ohne-key')).length===0,'Ablage faellt aus: Anmeldung trotzdem erfolgreich');
   process.env.SYNAPSE_AGENT_TOKEN_SCHLUESSEL=SCHLUESSEL;
   // Direkter Core-Aufruf (alle Transporte) mit Legacy-Rueckgabeform
   const s=await C.registerChatAgent('ein-core',project,'claude-test','2026-01-01');
   check(s.id==='ein-core'&&s.status==='active'&&s.cutoffDate!==undefined&&(await schatten('ein-core')).length===1,'registerChatAgent: Legacy-Form + Schatten');
   const wie=await chatSvc.registerAgent('ein-pur',project,'claude-test');
   check(Object.keys(wie).sort().join()===Object.keys(await C.registerChatAgent('ein-pur-2',project,'claude-test')).sort().join(),'Rueckgabeform identisch zur Legacy-Registrierung');
   await schalterAus();
  });

  await section('Koordinator-Hinweis beim naechsten Tool-Aufruf',async()=>{
   await schalterEin();
   // Legacy-Koordinatoren mit gueltigen Namen anlegen (Sitzungen), danach EIN
   for(const k of ['koordinator#3','koordinator#7'])await chatSvc.registerAgent(k,project,'claude-test');
   process.env.SYNAPSE_W1B_SCHATTEN_HINWEIS_MS='0';
   const offen=await schatten('ein-rest');
   for(const t of [rest,stdio]){
    const h=hinweise(await t.call('thought',{action:'get',project,id:thoughtId,agent_id:'koordinator#3'}));
    const z=h.find(x=>x.includes('Schattenprofil wartet'));
    // erste Zustellung voller Text (REST), spaetere Zustellung bis erledigt kurz (stdio)
    check(!!z&&z.includes(offen[0].id)&&(t.name!=='rest'||(z.includes(project)&&/Alter \d+ min/.test(z)&&/Ablauf 20\d\d-/.test(z)&&/Abruf:/.test(z))),'Koordinator sieht ID, Projekt, Alter, Ablauf, Abrufweg '+t.name);
    check(z&&!z.includes('sai_'),'Hinweis ohne Tokenwert '+t.name);
    const fremd=hinweise(await t.call('thought',{action:'get',project,id:thoughtId,agent_id:'ein-rest'}));
    check(!fremd.some(x=>x.includes('Schattenprofil wartet')),'Nicht-Koordinator sieht den Hinweis nicht '+t.name);
   }
   delete process.env.SYNAPSE_W1B_SCHATTEN_HINWEIS_MS;
   const e1=hinweise(await rest.call('thought',{action:'get',project,id:thoughtId,agent_id:'koordinator#7'}));
   const e2=hinweise(await rest.call('thought',{action:'get',project,id:thoughtId,agent_id:'koordinator#7'}));
   const ids=h=>h.filter(x=>x.includes('Schattenprofil wartet')).map(x=>x.match(UUID)?.[0]);
   check(ids(e1).length>0&&ids(e2).every(i=>!ids(e1).includes(i)),'Hinweis entprellt: jedes Schattenprofil nur einmal je Entprellfenster');
   await schalterAus();
   check(!hinweise(await rest.call('thought',{action:'get',project,id:thoughtId,agent_id:'koordinator#3'})).some(x=>x.includes('Schattenprofil')),'AUS: Hinweis verschwindet');
  });

  await section('Bestaetigung -> einmalige Token-Zustellung an die Ursprungssitzung (K10)',async()=>{
   await schalterEin();
   const rows={rest:(await schatten('ein-rest'))[0],stdio:(await schatten('ein-stdio'))[0]};
   await bestaetige(rows.rest);await bestaetige(rows.stdio);
   const idn=(await pool.query('SELECT id,profil_revision FROM agent_identitaeten WHERE project=$1 AND agent_id=$2',[project,'ein-rest'])).rows[0];
   check(idn?.profil_revision===1,'A: Identitaet mit Profilrevision 1');
   // Altmodus: agent_sessions.id ist global, W1a-Guards (agent_token_fehlt / agent_sitzung_bereits_gebunden) sperren den Legacy-Namen nach der
   // Bestaetigung. Zustellung und Token-Anmeldung setzen den ID-Bezug (beide/neu) voraus; Einschraenkung im Bericht.
   if(!eigene){
    const a=await stdio.call('chat',{action:'register',id:'ein-stdio',project,model:'claude-test'});
    check(a.success!==undefined,'Altmodus: Namensschutz meldet klar (kein Absturz)');
    return;
   }
   // Nur wer bis zur Bestaetigung registriert war, in derselben Sitzung, erhaelt den Hinweis.
   const fremdeSitzung=await rest.call('chat',{action:'register',id:'ein-stdio',project,model:'claude-test'});
   check(fremdeSitzung.success===true,'Wiederanmeldung gleichen Namens bleibt Legacy-Anmeldung');
   const keiner=hinweise(await stdio.call('thought',{action:'get',project,id:thoughtId,agent_id:'ein-stdio'}));
   check(!keiner.some(x=>TOKEN.test(x)),'neue Sitzung gleichen Namens erhaelt den Token-Hinweis nicht');
   const h1=hinweise(await rest.call('thought',{action:'get',project,id:thoughtId,agent_id:'ein-rest'}));
   const z=h1.find(x=>TOKEN.test(x));
   check(!!z&&/anmelden/.test(z)&&/portabel/.test(z),'Ursprungssitzung erhaelt Token + Anmeldehinweis');
   const tok=z?.match(TOKEN)?.[0];if(tok)secrets.push(tok);
   const h2=hinweise(await rest.call('thought',{action:'get',project,id:thoughtId,agent_id:'ein-rest'}));
   check(!h2.some(x=>TOKEN.test(x)),'Token-Hinweis nur einmal je Sitzung');
   const andere=hinweise(await stdio.call('thought',{action:'get',project,id:thoughtId,agent_id:legacy}));
   check(!andere.some(x=>TOKEN.test(x)),'anderer Agent erhaelt keinen Token-Hinweis');
   const hv=hinweise(await stdio.call('thought',{action:'get',project,id:thoughtId,agent_id:'ein-rest'}));
   check(!hv.some(x=>TOKEN.test(x)),'Zustellung bindet keine globale zuletzt-angemeldet-Identitaet');
   // Portabilitaet: derselbe Token auf REST (Argument), REST (Header) und stdio (Env), ohne Projekt
   const a1=await rest.call('chat',{action:'anmelden',token:tok},{'user-agent':'openai-mcp/1.0'});
   check(a1.success===true&&a1.principal.identity_id===idn.id&&a1.principal.agent_id==='ein-rest','Anmeldung nur mit Token, Projekt aus dem Token (REST)');
   check(a1.fortsetzung?.identity_id===idn.id&&a1.fortsetzung.project===project&&a1.fortsetzung.profil_revision===1&&a1.fortsetzung.letzter_lauf==null,'Fortsetzungsantwort: Identitaet, Projekt, Profilrevision, noch kein Vorlauf');
   check(a1.fortsetzung.abrufwege.some(w=>w.art==='shell_historie'&&w.aufruf.tool==='shell')&&a1.fortsetzung.abrufwege.some(w=>w.art==='datei_historie'),'Abrufwege fuer Historien');
   check(!sh(a1).includes(tok),'Anmeldeantwort enthaelt den Token nicht');
   // Bestandsarbeit des Vorgaengers fuer die zweite Anmeldung
   await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[randomUUID(),project,'ein-rest','Handoff B',['auto-handoff','session-state']]);
   await pool.query('INSERT INTO plan_tasks(id,project,plan_id,task,plan_kurz_id,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
    ['b-task-1',project,'b-plan-1',sh({id:'b-task-1',kurz_id:'PB-T1',status:'in_progress',beteiligte:[{agent_id:'ein-rest',identity_id:idn.id}]}),'PB',new Date().toISOString()]);
   await pool.query('INSERT INTO plan_tasks(id,project,plan_id,task,plan_kurz_id,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)',
    ['b-task-2',project,'b-plan-1',sh({id:'b-task-2',kurz_id:'PB-T2',status:'done',beteiligte:[{agent_id:'ein-rest',identity_id:idn.id}]}),'PB',new Date().toISOString()]);
   await pool.query("INSERT INTO agent_events(project,event_type,priority,scope,source_id,payload,requires_ack) VALUES($1,'NEW_TASK','normal','agent:ein-rest','koordinator','b',true)",[project]);
   await pool.query("INSERT INTO shell_jobs(project,command,status,agent_id) VALUES($1,'sleep 1','running','ein-rest')",[project]);
   await pool.query("INSERT INTO file_batch_plans(id,project,owner_agent_id,ops,expected_hashes,previews,status) VALUES(987654,$1,'ein-rest','[]'::jsonb,'{}'::jsonb,'[]'::jsonb,'open')",[project]);
   const a2=await stdio.call('chat',{action:'anmelden'},tok);
   check(a2.success===true&&a2.principal.identity_id===idn.id&&a2.principal.context_epoch>a1.principal.context_epoch,'derselbe Token auf anderem Client (stdio/Env): dieselbe Identitaet, keine neue');
   const w=a2.fortsetzung?.abrufwege??[];
   const art=n=>w.filter(x=>x.art===n);
   check(a2.fortsetzung?.letzter_lauf?.abgeloest===true,'vorheriger Lauf als abgeloest ausgewiesen');
   check(art('handoff').length===1&&art('handoff')[0].aufruf.tool==='thought'&&art('handoff')[0].aufruf.action==='get','letzte Uebergabe mit exaktem Abruf');
   check(art('task').length===1&&art('task')[0].id==='PB-T1'&&art('task')[0].aufruf.tool==='plan','nur offene zugeordnete Tasks');
   check(art('event').length===1&&art('event')[0].aufruf.action==='pending','offenes Ereignis mit Abruf (nicht quittiert)');
   check(art('shell_job').length===1&&art('files_plan').length===1&&art('files_plan')[0].id==='987654','laufender Job und offener Plan');
   check(a2.fortsetzung.zaehler?.task===1&&a2.fortsetzung.zaehler?.handoff===1,'Ueberblick mit Zaehlern');
   check((await pool.query('SELECT count(*)::int n FROM agent_events e WHERE NOT EXISTS (SELECT 1 FROM agent_event_acks a WHERE a.event_id=e.id)')).rows[0].n>=1,'Anzeigen quittiert nichts');
   check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_laeufe WHERE identity_id=$1 AND status='aktiv'",[idn.id])).rows[0].n===1,'Ein-Lauf-je-Identitaet bleibt');
   const a3=await rest.call('chat',{action:'identitaet'},{'x-synapse-agent-token':tok});
   check(a3.success===true&&a3.principal.identity_id===idn.id,'Header-Token (REST) bezeugt dieselbe Identitaet');
   check(!hinweise(await rest.call('thought',{action:'get',token:tok,id:thoughtId})).some(x=>TOKEN.test(x)),'Token-Agent erhaelt keine zweite Zustellung');
   await schalterAus();
  });

  await section('Erster Koordinator, Koordinatorliste, Herkunftsort (K3C)',async()=>{
   if(!eigene){console.log('Hinweis: Altmodus - agent_sessions.id global, Koordinatorabschnitt laeuft in beide/neu');return;}
   await schalterEin();
   const P2=project+'-koord';
   for(const t of [rest,stdio]){
    const l0=await t.call('chat',{action:'koordinator_liste',project:P2});
    check(l0.success===true&&l0.erster_koordinator===true&&l0.koordinatoren.length===0&&!!l0.wahl.erster,'leere Liste: erster Koordinator '+t.name);
   }
   check((await rest.call('chat',{action:'koordinator_liste'})).success===false,'koordinator_liste ohne Projekt abgelehnt');
   const reg=await rest.call('chat',{action:'register',id:'koordinator',project:P2,model:'claude-test'},{'user-agent':'openai-mcp/1.0'});
   if(reg.token)secrets.push(reg.token);
   check(reg.success===true&&TOKEN.test(reg.token||'')&&reg.principal.rolle==='koordinator'&&reg.principal.project===P2,'erster Koordinator ohne Anfangstoken: Token + Rolle koordinator');
   const ik=(await pool.query("SELECT id,profil_revision FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator'",[P2])).rows;
   check(ik.length===1&&ik[0].profil_revision===1,'genau ein Koordinatorprofil, Revision 1');
   check((await pool.query("SELECT count(*)::int n FROM agent_identitaet_audit WHERE identity_id=$1 AND grund ILIKE '%User-Auftrag%'",[ik[0].id])).rows[0].n>=1,'User-Auftrag steht im Audit-Grund');
   for(const t of [rest,stdio]){
    const l=await t.call('chat',{action:'koordinator_liste',project:P2});
    const e=l.koordinatoren?.[0];
    check(l.erster_koordinator===false&&l.koordinatoren.length===1&&e.name==='koordinator'&&e.zustand==='laeuft'&&!!e.letzte_aktivitaet,'Liste: Name, Zustand, letzte Aktivitaet '+t.name);
    check(e?.letzter_herkunftsort==='chatgpt.com','Liste: letzter Herkunftsort (Anzeige) '+t.name);
    check(!/sai_|token/i.test(sh(l.koordinatoren)),'Liste ist tokenfrei '+t.name);
    check(!!l.wahl.neu&&!!l.wahl.uebernahme,'Wahl neu/Uebernahme angeboten '+t.name);
   }
   // Uebernahme auf einem anderen Client: Herkunftsort wechselt, Gueltigkeit nicht gebunden
   const u=await stdio.call('chat',{action:'anmelden'},reg.token);
   check(u.success===true&&u.principal.identity_id===ik[0].id,'Uebernahme per Token auf anderem Client (stdio)');
   const l2=await rest.call('chat',{action:'koordinator_liste',project:P2});
   check(l2.koordinatoren[0].letzter_herkunftsort==='CLI/stdio','Herkunftsort wechselt (nur Anzeige)');
   const a=await rest.call('chat',{action:'anmelden',token:reg.token},{'user-agent':'openai-mcp/1.0'});
   check(a.success===true,'Token bleibt auf dem urspruenglichen Client weiter gueltig');
   // Weiterer Koordinator: Standardanmeldung, Schattenprofil koordinator_start, keine automatische Identitaet
   const zwei=await stdio.call('chat',{action:'register',id:'koordinator',project:P2,model:'claude-test'});
   check(zwei.success===true&&zwei.token===undefined,'weiterer Koordinator: kein sofortiger Token');
   check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator'",[P2])).rows[0].n===1,'kein automatisches koordinator#2');
   // Gleichzeitige erste Anmeldungen: genau ein Startfall
   const P3=project+'-rennen';
   const lauf=await Promise.all([rest.call('chat',{action:'register',id:'koordinator',project:P3}),stdio.call('chat',{action:'register',id:'koordinator',project:P3}),
    rest.call('chat',{action:'register',id:'koordinator',project:P3}),stdio.call('chat',{action:'register',id:'koordinator',project:P3})]);
   for(const r of lauf)if(r.token)secrets.push(r.token);
   check(lauf.filter(r=>r.token).length===1,'genau ein erster Koordinator (atomar je Projekt)');
   check((await pool.query("SELECT count(*)::int n FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator'",[P3])).rows[0].n===1,'genau ein Koordinatorprofil nach Wettlauf');
   // Vertrag: W1B_DIENSTE.anmeldung
   const D=C.W1B_DIENSTE.anmeldung;
   check((await D.koordinatorListe(P2)).length===1&&(await D.koordinatorListe('p22-t13-leer')).length===0,'W1B_DIENSTE.anmeldung.koordinatorListe');
   let vergeben=false;try{await D.legeErstenKoordinatorAn(P2,'User-Auftrag: Test');}catch(e){vergeben=e.code==='koordinator_vorhanden';}
   check(vergeben,'zweiter Startfall: koordinator_vorhanden');
   let ohneAuftrag=false;try{await D.legeErstenKoordinatorAn('p22-t13-leer','x');}catch(e){ohneAuftrag=e.code==='user_auftrag_fehlt';}
   check(ohneAuftrag,'ohne User-Auftrag kein Startfall');
   const neu=await D.legeErstenKoordinatorAn('p22-t13-vertrag','User-Auftrag: melde dich als Koordinator an');secrets.push(neu.token);
   check(TOKEN.test(neu.token)&&!!neu.identity_id,'legeErstenKoordinatorAn liefert Identitaet + Token');
   const fi=await D.fortsetzungsInfo({art:'identity',project:'p22-t13-vertrag',agent_id:'koordinator',identity_id:neu.identity_id,rolle:'koordinator',modell:null,context_epoch:1,lauf_id:null});
   check(fi.identity_id===neu.identity_id&&Array.isArray(fi.abrufwege)&&fi.letzter_lauf===null,'W1B_DIENSTE.anmeldung.fortsetzungsInfo');
   await schalterAus();
  });

  await section('Herkunftsort aus Transportkoepfen',async()=>{
   const h=C.herkunftsortAusKopf;
   check(h({'user-agent':'openai-mcp/1.0'})==='chatgpt.com'&&h({origin:'https://claude.ai'})==='claude.ai'&&h({'user-agent':'claude-code/2.1'})==='CLI (Claude Code)','Herkunftsorte erkannt');
   check(h({'x-synapse-client':'Web-UI sai_'+'a'.repeat(64)})==='Web-UI [maskiert]'&&h(undefined)===undefined,'Ausweise nie in der Anzeige');
  });

  const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows)
   +JSON.stringify((await pool.query('SELECT * FROM agent_identitaet_audit')).rows)
   +JSON.stringify((await pool.query('SELECT * FROM agent_schattenprofil_audit')).rows);
  check(secrets.every(s=>!logs.includes(s)),'kein OAuth-/Agentenausweis in Tool-Log oder Audit');
  check(network===0,'keine echten Netzwerk-/Modellaufrufe');
  console.log('P22-T13 Paket B (Modus '+modus+'): '+checks+' Pruefungen, '+failures.length+' Fehler');
 }
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Cleanup: '+error.message));}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
