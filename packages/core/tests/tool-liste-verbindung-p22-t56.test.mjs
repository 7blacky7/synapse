/**
 * P22-T56: tools/list je Verbindung. synapse_test:5433, privates Schema, Ausweis-Kern nur projektweise (Prod-Lage).
 *   node packages/core/tests/tool-liste-verbindung-p22-t56.test.mjs
 *   T56_GOLDEN_OUT=<pfad> schreibt die Projektion je Variante dorthin (zum Nachziehen des Goldens ueber files).
 * A Schalter AUS: REST (ohne/mit Ausweis-Header, Web-Connector-UA) und stdio (ohne/mit Env) = Bestandsliste, kein _meta.
 * B Schalter EIN, Ausweis im Header bzw. Env: nur Ausweis-Weg (token, kein role/project, agent_id nur als Fachfilter in
 *   chat/files, project nie Pflicht, chat anmelden/identitaet), _meta variante ausweis.
 * C Web-Connector ohne Ausweis (UA Claude-User / openai-mcp): Legacy-Liste ohne token-Werbung, agent_id-Text wie bisher.
 * D Gemeinsame Verbindung (stdio ohne Env, REST unbekannter/kein UA): Liste = Bestand (P22-T55), beide Wege.
 * E Ungueltiger Ausweis im Header -> gemeinsam (ausweis_kern_aus); mehrprojekt EIN -> project bleibt (optional);
 *   SYNAPSE_TOOL_LISTE_LEGACY_UA ersetzt den Standard; Diagnose zaehlt; Aufrufzeit-Erkennung unveraendert.
 * F Golden je Variante (Projektion: Tool, Parameter, Pflichtfelder, chat-Enum).
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_INTERN_TOOL','SYNAPSE_W1B_DURCHSETZUNG',
 'SYNAPSE_W1B_ANTWORTANPASSUNG','SYNAPSE_TOKEN_IDENTITAET','SYNAPSE_W1B_ANMELDUNG','SYNAPSE_AGENTEN_AUSWEIS','SYNAPSE_AGENT_NAME',
 'SYNAPSE_MAIN_SYNAPSE','SYNAPSE_PROJECT','SYNAPSE_W1B_TOKEN_HINWEIS_MS','SYNAPSE_TOOL_LISTE_LEGACY_UA'])delete process.env[k];
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t56_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t56-synthetic';
const bearer=randomUUID()+randomUUID();
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const close=[];
let pool;
const unwrap=r=>{
 if(!r)return {};
 const sc=r.structuredContent;if(sc&&typeof sc==='object')return sc;
 const t=r.content?.find(c=>c.type==='text')?.text;
 try{return JSON.parse(t);}catch{return {text:t};}
};
const GOLDEN=join(repo,'packages/core/tests/fixtures/tool-liste-verbindung-p22-t56.golden.json');
/** Projektion je Liste: Struktur, die die Variante ausmacht (ohne Beschreibungstexte, ausser agent_id/token). */
const projiziere=liste=>liste.map(t=>{
 const p=t.inputSchema?.properties??{};
 return {name:t.name,parameter:Object.keys(p).sort(),pflicht:[...(t.inputSchema?.required??[])].sort(),
  ...(t.name==='chat'?{chat_enum:[...(p.action?.enum??[])]}:{}),
  ...(p.agent_id?{agent_id:p.agent_id.description??null}:{}),
  ...(p.token?{token:p.token.description??null}:{})};
}).sort((a,b)=>a.name.localeCompare(b.name));
/** Golden je Variante: Hash der vollen Projektion + lesbare Zusammenfassung. */
const goldenEintrag=liste=>{
 const p=projiziere(liste);
 const mit=f=>p.filter(t=>t.parameter.includes(f)).map(t=>t.name);
 return {hash:createHash('sha256').update(JSON.stringify(p)).digest('hex'),tools:p.length,mit_ausweis_parameter:mit('token').length,
  mit_agent_id:mit('agent_id'),mit_role:mit('role'),mit_project:mit('project').length,
  project_pflicht:p.filter(t=>t.pflicht.includes('project')).length,chat_enum:p.find(t=>t.name==='chat')?.chat_enum??null};
};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){const q='"'+tablename.replaceAll('"','""')+'"';await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');}
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema]);
 for(const [i,r]of serials.rows.entries()){const s=schema+'.ps_'+i;await admin.query('CREATE SEQUENCE '+s);await admin.query(`ALTER TABLE ${schema}."${r.table_name}" ALTER COLUMN "${r.column_name}" SET DEFAULT nextval('${s}'::regclass)`);}
 const cl=await admin.connect();
 try{
  await cl.query('SET search_path TO '+schema);
  for(const f of ['111_agent_identitaet.sql','112_agent_bezug.sql','113_agent_profil.sql','114_agent_ausweis.sql','115_agent_ausweis_nr.sql','117_agent_ausweis_fristen.sql','118_agent_ausweis_projekte.sql'])
   await cl.query(readFileSync(join(repo,'packages/core/src/db/schema-sql/'+f),'utf8'));
 }finally{cl.release();}
 url.searchParams.set('options','-c search_path='+schema+',public');
 const root=mkdtempSync(join(tmpdir(),'p22-t56-'));
 Object.assign(process.env,{DATABASE_URL:url.href,SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
  SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_HINWEIS_BUDGET_MS:'5000',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 const T=await load('packages/core/dist/services/agent-token-tools.js');
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[P,'rest-api',root]);
 // Kern NUR projektweise (Prod-Lage)
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agenten_ausweis',true,'Test P22-T56','user')",[P]);
 const tokA='sai_'+randomBytes(16).toString('hex');
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES('t56-a',$1,'t56-sub','t56-sub','subagent','test')",[P]);
 await pool.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,'t56-a',$2,$3,'vorbereitet')",[randomUUID(),tokA,tokA.slice(0,12)]);
 const USER={system:'user'};
 const schalter=(aktiv,ebene='global',funktion='tool_liste_je_verbindung')=>C.setzeProfilProduktSchalter({ebene,project:ebene==='projekt'?P:null,funktion,aktiv,grund:'Test P22-T56 '+funktion},USER);

 // ---- REST
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();close.push(()=>app.close());
 let seq=0;
 const rpc=(method,params,extra={})=>app.inject({method:'POST',url:'/mcp/messages',headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t56',...extra},payload:{jsonrpc:'2.0',id:++seq,method,params}});
 const restListe=async(extra={})=>(await rpc('tools/list',{},extra)).json().result;
 const rest=async(name,args,extra={})=>{const j=(await rpc('tools/call',{name,arguments:args},extra)).json();return j.error?{_rpcError:j.error}:unwrap(j.result);};
 // Hilfsfall: wirklich kein User-Agent (inject setzt sonst lightMyRequest).
 const ohneUa=async()=>{const r=await app.inject({method:'POST',url:'/mcp/messages',headers:{authorization:'Bearer '+bearer,'user-agent':''},payload:{jsonrpc:'2.0',id:++seq,method:'tools/list',params:{}}});return r.json().result;};

 // ---- stdio (Kindprozesse, dasselbe private Schema): ohne und mit Ausweis in der Env
 const {Client}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const sp=pathToFileURL(join(repo,'packages/mcp-server/dist/server.js')).href;
 const tp=pathToFileURL(join(repo,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href;
 const starteStdio=async(extra)=>{
  const env={...Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')),...extra};
  const transport=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval',
   'const {createServer}=await import('+JSON.stringify(sp)+');const {StdioServerTransport}=await import('+JSON.stringify(tp)+');await createServer().connect(new StdioServerTransport());'],
   cwd:repo,env,stderr:'pipe'});
  const client=new Client({name:'p22-t56',version:'1'});await client.connect(transport);close.push(()=>client.close());
  return client;
 };
 const stdioOhne=await starteStdio({});
 const stdioMit=await starteStdio({SYNAPSE_AGENT_TOKEN:tokA});
 const stdioListe=async c=>c.listTools();

 const golden={};
 const UA_CC={'user-agent':'claude-code/2.1.0'};
 const UA_WEB={'user-agent':'Claude-User/1.0 (+https://claude.ai)'};
 const UA_GPT={'user-agent':'openai-mcp/1.0.0'};
 const AUSWEIS={'x-synapse-agent-token':tokA};

 // ================= A: Schalter AUS = Bestand =================
 const bestandRest=await restListe(UA_CC);
 const bestandStdio=await stdioListe(stdioOhne);
 check(bestandRest._meta===undefined&&bestandStdio._meta===undefined,'A AUS: kein _meta (REST, stdio)');
 for(const [label,l] of [['REST Web-UA',await restListe(UA_WEB)],['REST ohne UA',await ohneUa()]]){
  check(l._meta===undefined,`A AUS ${label}: kein _meta`);
  check(JSON.stringify(projiziere(l.tools))===JSON.stringify(projiziere(bestandRest.tools)),`A AUS ${label}: Liste wie Bestand`);
 }
 const bestandMitRest=await restListe(AUSWEIS);
 check(bestandMitRest._meta===undefined&&bestandMitRest.tools.some(t=>t.inputSchema?.properties?.role),'A AUS REST Ausweis-Header: kein _meta, Bestand (role weiter beworben)');
 const bestandMitStdio=await stdioListe(stdioMit);
 const tokenIn=l=>l.filter(t=>t.inputSchema?.properties?.token).length;
 check(tokenIn(bestandRest.tools)===bestandRest.tools.filter(t=>t.inputSchema?.properties).length,'A AUS REST: token in allen Tools (P22-T55)');
 check(bestandMitStdio.tools.some(t=>t.inputSchema?.properties?.role)&&bestandMitStdio._meta===undefined,'A AUS stdio mit Env: role weiter beworben (Bestand), kein _meta');
 golden.bestand_rest=goldenEintrag(bestandRest.tools);
 golden.bestand_rest_ausweis=goldenEintrag(bestandMitRest.tools);
 golden.bestand_stdio=goldenEintrag(bestandStdio.tools);

 // ================= B: Schalter EIN, Ausweis in der Verbindung =================
 await schalter(true);
 C.leereToolListeDiagnose();
 const pruefeAusweis=(weg,l)=>{
  check(l._meta?.synapse_tool_liste?.variante==='ausweis',`B ${weg}: _meta variante ausweis (${JSON.stringify(l._meta)})`);
  const tools=l.tools.filter(t=>t.inputSchema?.properties);
  check(tools.length>10&&tools.every(t=>t.inputSchema.properties.token?.description===T.AGENT_TOKEN_PARAMETER.token.description),`B ${weg}: token (kurz) in allen ${tools.length} Tools`);
  const mitRole=tools.filter(t=>t.inputSchema.properties.role).map(t=>t.name);
  check(mitRole.length===0,`B ${weg}: role ausgeblendet (${mitRole.join(',')})`);
  const mitProject=tools.filter(t=>t.inputSchema.properties.project).map(t=>t.name);
  check(mitProject.length===0,`B ${weg}: project ausgeblendet ohne mehrprojekt (${mitProject.join(',')})`);
  const pflicht=tools.filter(t=>(t.inputSchema.required??[]).some(f=>['project','agent_id','role'].includes(f))).map(t=>t.name);
  check(pflicht.length===0,`B ${weg}: keine Selbstangabe Pflicht (${pflicht.join(',')})`);
  const mitAid=tools.filter(t=>t.inputSchema.properties.agent_id).map(t=>t.name).sort();
  check(JSON.stringify(mitAid)===JSON.stringify(['chat','files']),`B ${weg}: agent_id nur in chat/files (${mitAid.join(',')})`);
  const f=tools.find(t=>t.name==='files').inputSchema.properties.agent_id.description;
  check(f===T.TEXT_AGENT_ID_FACHFILTER('files',['history']),`B ${weg}: files.agent_id als Fachfilter beschrieben`);
  const en=tools.find(t=>t.name==='chat').inputSchema.properties.action.enum;
  check(en.includes('anmelden')&&en.includes('identitaet'),`B ${weg}: chat anmelden/identitaet`);
 };
 const ausweisRest=await restListe({...AUSWEIS,...UA_CC});
 pruefeAusweis('REST Header',ausweisRest);
 const ausweisStdio=await stdioListe(stdioMit);
 pruefeAusweis('stdio Env',ausweisStdio);
 check(ausweisRest._meta.synapse_tool_liste.grund==='header_ausweis'&&ausweisStdio._meta.synapse_tool_liste.grund==='env_ausweis','B Begruendung header_ausweis / env_ausweis');
 golden.ausweis_rest=goldenEintrag(ausweisRest.tools);
 golden.ausweis_stdio=goldenEintrag(ausweisStdio.tools);
 // Aufrufzeit: Aufruf mit Ausweis ohne project/agent_id geht durch (das Projekt kommt aus dem Ausweis).
 const th=await rest('thought',{action:'add',content:'t56 ausweis',token:tokA},AUSWEIS);
 check(th.success===true,'B Aufruf mit token ohne project in der Ausweis-Verbindung geht durch '+JSON.stringify(th).slice(0,160));

 // ================= C: Legacy-Verbindung (Web-Connector ohne Ausweis) =================
 for(const [label,ua] of [['Claude-User',UA_WEB],['openai-mcp',UA_GPT]]){
  const l=await restListe(ua);
  check(l._meta?.synapse_tool_liste?.variante==='legacy',`C ${label}: _meta variante legacy (${JSON.stringify(l._meta)})`);
  check(tokenIn(l.tools)===0,`C ${label}: keine token-Werbung`);
  const en=l.tools.find(t=>t.name==='chat').inputSchema.properties.action.enum;
  check(!en.includes('anmelden')&&!en.includes('identitaet'),`C ${label}: chat ohne anmelden/identitaet`);
  const aid=l.tools.find(t=>t.name==='thought').inputSchema.properties.agent_id.description;
  check(!aid.startsWith(T.TEXT_AGENT_ID_MIT_AUSWEIS),`C ${label}: agent_id-Text wie bisher (ohne Ausweis-Vorsatz)`);
  if(label==='Claude-User')golden.legacy_rest=goldenEintrag(l.tools);
 }
 const leg=await rest('thought',{action:'add',project:P,content:'t56 legacy',source:'t56-legacy',agent_id:'t56-legacy'},UA_WEB);
 check(leg.success!==false,'C Legacy-Aufruf mit agent_id unveraendert '+JSON.stringify(leg).slice(0,160));

 // ================= D: gemeinsame Verbindung = Bestand =================
 const gemRest=await restListe(UA_CC);
 check(gemRest._meta?.synapse_tool_liste?.variante==='gemeinsam'&&gemRest._meta.synapse_tool_liste.grund==='rest_ohne_ausweis_client_unbekannt','D REST claude-code: gemeinsam');
 check(JSON.stringify(projiziere(gemRest.tools))===JSON.stringify(projiziere(bestandRest.tools)),'D REST gemeinsam: Liste = Bestand (P22-T55)');
 const gemStdio=await stdioListe(stdioOhne);
 check(gemStdio._meta?.synapse_tool_liste?.grund==='stdio_ohne_ausweis','D stdio ohne Env: gemeinsam (stdio_ohne_ausweis)');
 check(JSON.stringify(projiziere(gemStdio.tools))===JSON.stringify(projiziere(bestandStdio.tools)),'D stdio gemeinsam: Liste = Bestand');
 const nu=await ohneUa();
 check(nu._meta?.synapse_tool_liste?.grund==='rest_ohne_ausweis_ohne_user_agent','D REST ohne User-Agent: gemeinsam '+JSON.stringify(nu._meta));
 golden.gemeinsam_rest=goldenEintrag(gemRest.tools);

 // ================= E: Sonderfaelle =================
 const falsch=await restListe({'x-synapse-agent-token':'sai_ungueltig'});
 check(falsch._meta?.synapse_tool_liste?.variante==='gemeinsam'&&falsch._meta.synapse_tool_liste.grund==='ausweis_kern_aus','E ungueltiger Ausweis im Header -> gemeinsam (ausweis_kern_aus)');
 await schalter(true,'projekt','mehrprojekt');
 const mp=await restListe(AUSWEIS);
 const thMp=mp.tools.find(t=>t.name==='thought').inputSchema;
 check(!!thMp.properties.project&&!(thMp.required??[]).includes('project')&&!thMp.properties.role,'E mehrprojekt EIN: project bleibt (optional), role weiter weg');
 await schalter(false,'projekt','mehrprojekt');
 process.env.SYNAPSE_TOOL_LISTE_LEGACY_UA='mein-connector';
 check((await restListe(UA_WEB))._meta?.synapse_tool_liste?.variante==='gemeinsam','E SYNAPSE_TOOL_LISTE_LEGACY_UA ersetzt den Standard (Claude-User -> gemeinsam)');
 check((await restListe({'user-agent':'Mein-Connector/3'}))._meta?.synapse_tool_liste?.variante==='legacy','E eigener Praefix -> legacy');
 delete process.env.SYNAPSE_TOOL_LISTE_LEGACY_UA;
 const diag=C.toolListeVerbindungDiagnose();
 check(diag.zaehler.ausweis>=1&&diag.zaehler.legacy>=2&&diag.zaehler.gemeinsam>=3&&diag.letzte.length>0&&diag.letzte.every(x=>x.grund),'E Diagnose: Zaehler je Variante + letzte Entscheidungen mit Grund');
 // Projekt-AUS schlaegt global EIN (Rangfolge projekt > global), Ausweis-Weg liest das Projekt des Ausweises.
 await schalter(false,'projekt');
 check((await restListe(AUSWEIS))._meta===undefined,'E Projekt-Schalter AUS schlaegt global EIN fuer Ausweis des Projekts');
 await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='tool_liste_je_verbindung' AND ebene='projekt'");
 // 'alle' schaltet ihn nicht mit
 await schalter(false);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T56 alle'},USER);
 check((await restListe(UA_WEB))._meta===undefined,"E 'alle' EIN schaltet tool_liste_je_verbindung nicht ein");
 await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion='alle'");
 // Zurueck AUS = Bestand
 const wieder=await restListe(AUSWEIS);
 check(wieder._meta===undefined&&JSON.stringify(projiziere(wieder.tools))===JSON.stringify(projiziere(bestandMitRest.tools)),'E Schalter AUS: wieder exakt Bestand');

 // ================= F: Golden =================
 if(process.env.T56_GOLDEN_OUT){writeFileSync(process.env.T56_GOLDEN_OUT,JSON.stringify(golden,null,1)+'\n');console.log('Golden geschrieben: '+process.env.T56_GOLDEN_OUT);}
 if(existsSync(GOLDEN)){
  const soll=JSON.parse(readFileSync(GOLDEN,'utf8'));
  for(const k of Object.keys(golden))check(JSON.stringify(soll[k])===JSON.stringify(golden[k]),'F Golden '+k);
  check(Object.keys(soll).sort().join()===Object.keys(golden).sort().join(),'F Golden: dieselben Varianten');
 }else check(!!process.env.T56_GOLDEN_OUT,'F Golden-Datei fehlt ('+GOLDEN+')');
}catch(e){
 failures.push('Abbruch: '+(e?.stack||e));console.error(e);
}finally{
 for(const f of close.reverse()){try{await f();}catch{}}
 try{await pool?.end();}catch{}
 try{await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}catch{}
 await admin.end();
 console.log(`\n${checks-failures.filter(f=>!f.startsWith('Abbruch')).length}/${checks} ok`+(failures.length?' - FEHLER:\n  '+failures.join('\n  '):''));
 process.exit(failures.length?1:0);
}
