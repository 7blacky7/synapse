/**
 * P22-T16: OAuth-MCP + SDK/stdio, Legacy bleibt ohne persoenlichen Ausweis unveraendert.
 * Ausschliesslich private Tabellen/Sequenzen in synapse_test:5433; kein Modell/Daemon.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const key of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED'])delete process.env[key];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_INTERN_TOOL:'1',SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t16_sol31_'+process.pid+'_'+randomUUID().slice(0,8);
const project='p22-t16-synthetic',legacy='legacy-client',thoughtId=randomUUID();
const bearer=randomUUID()+randomUUID(),secrets=[bearer],close=[],failures=[];
let core,pool,seq=0,checks=0;
const unwrap=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const mask=s=>secrets.reduce((s,x)=>s.replaceAll(x,'[GEHEIM]'),String(s))
 .replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
function comparable(r){
 const value=structuredClone(r);
 // Die explizite Schalterdiagnose MUSS sich zwischen AUS/EIN unterscheiden.
 if(value.action==='schalter_liste')delete value.token_identitaet;
 return value;
}
async function equalCall(t,name,args,baseline,label){
 const actual=await t.call(name,args);
 try{assert.deepEqual(comparable(actual),comparable(baseline));check(true,label);}
 catch{check(false,label+' ('+(actual.error??'Antwortabweichung')+')');}
 if(name==='intern'&&actual.success)check(actual.token_identitaet.freigegeben===true,label+' effektiver Schalter EIN');
}
async function transports(){
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const apps=[];
 for(let i=0;i<2;i++){
  const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();
  apps.push(app);close.push(()=>app.close());
  for(const path of ['/','/mcp/messages']){
   const unauth=await app.inject({method:'POST',url:path,payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
   check(unauth.statusCode===401,'OAuth fehlt '+i+path);
   const invalid=await app.inject({method:'POST',url:path,headers:{authorization:'Bearer invalid'},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
   check(invalid.statusCode===401,'OAuth falsch '+i+path);
  }
 }
 for(let i=0;i<200;i++){
  const response=await apps[0].inject({method:'POST',url:i%2?'/':'/mcp/messages',payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  check(response.statusCode===401,'Anonymer Burst bleibt abgewiesen');
 }
 const before=(await pool.query("SELECT count(*)::int n FROM tool_calls WHERE tool_name='mcp' AND action='auth'")).rows[0].n;
 check(before<=1,'Anonymer Burst erzeugt hoechstens eine Aggregatzeile statt Insert je Request');
 const http=(i,path)=>({name:'http'+i+path,source:'cloud',async call(name,args,extra={}){
  const response=await apps[i].inject({method:'POST',url:path,
   headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t16-session-'+i,...extra},
   payload:{jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}}});
  assert.equal(response.statusCode,200,'OAuth-MCP HTTP200');return unwrap(response.json().result);
 }});
 const sdk=join(repo,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm');
 const {InMemoryTransport}=await import(pathToFileURL(join(sdk,'inMemory.js')).href);
 const {Client}=await import(pathToFileURL(join(sdk,'client/index.js')).href);
 const {createServer}=await load('packages/mcp-server/dist/server.js');
 const stdios=[];
 for(let i=0;i<2;i++){
  const server=createServer(),client=new Client({name:'p22-t16-'+i,version:'1'});
  const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  close.push(()=>client.close());stdios.push({name:'stdio'+i,source:'stdio',call:async(name,args)=>unwrap(await client.callTool({name,arguments:args}))});
 }
 const groups=[[http(0,'/'),http(1,'/')],[http(0,'/mcp/messages'),http(1,'/mcp/messages')],stdios];
 groups.closeHttp=async()=>{for(const app of apps)await app.close();};
 process.env.SYNAPSE_AGENT_TOKEN='';
 const legacyEmpty=await stdios[0].call('thought',{action:'get',project,id:thoughtId});
 check(legacyEmpty.success!==false,'AUS: leeres SYNAPSE_AGENT_TOKEN entspricht fehlender Env');
 const explicitEmpty=await stdios[0].call('thought',{action:'get',project,id:thoughtId,token:''});
 check(explicitEmpty.error==='token_identitaet_aus','AUS: expliziter leerer Tooltoken bleibt abgewiesen');
 delete process.env.SYNAPSE_AGENT_TOKEN;
 return groups;
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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-ausweis-schema','agent-ausweis-nr-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO thoughts(id,project,source,content,tags) VALUES($1,$2,$3,$4,$5)',[thoughtId,project,'synthetic','Legacy fixture',[]]);
 const chat=await load('packages/core/dist/services/chat.js');await chat.registerAgent(legacy,project,'synthetic');
 const groups=await transports();
 const cases=[['thought',{action:'get',project,id:thoughtId}],['shell',{action:'activity',project,since:'2099-01-01T00:00:00Z'}],['intern',{action:'schalter_liste',project}]];
 for(const mode of ['alt','beide','neu']){
  process.env.SYNAPSE_AGENT_BEZUG_MODUS=mode;
  for(const [first,second]of groups){
   process.env.SYNAPSE_TOKEN_IDENTITAET='0';
   const baselines=[];
   for(const [name,args]of cases)for(const withId of [false,true]){
    const a={...args,...(withId?{agent_id:legacy}:{})};
    await first.call(name,a); // Hinweise einmalig ausgeben, dann stabilen Fachvertrag erfassen.
    const response=await first.call(name,a);
    if(name==='intern'&&first.source==='stdio'){
     // intern ist im bestehenden stdio-Vertrag nicht registriert; auch diese Antwort bleibt exakt gleich.
     check(response.error==='Error: Unbekanntes Tool: intern','stdio-AUS kennt intern erwartungsgemaess nicht');
    }else check(response.success!==false,'AUS-Positivanker '+name+' '+first.name);
    baselines.push({name,args:a,response,withId});
   }
   process.env.SYNAPSE_TOKEN_IDENTITAET='1';
   const identityName='token-'+mode+'-'+first.name.replace(/[^a-z0-9]/g,'');
   const issued=await first.call('chat',{action:'register',id:identityName,project,model:'synthetic'});
   if(!issued.token)throw Error('Synthetischer Token-Bootstrap fehlgeschlagen');
   secrets.push(issued.token);
   check((await first.call('chat',{action:'anmelden',token:issued.token})).success,'Tokenlogin '+mode+first.name);
   // Zweite Verbindung nutzt denselben OAuth-Bearer, aber keine persoenliche Identitaet.
   for(const t of [first,second])for(const c of baselines)
    await equalCall(t,c.name,c.args,c.response,mode+' '+t.name+' '+c.name+' agent_id='+c.withId);
   const auditStart=(await pool.query('SELECT COALESCE(max(id),0)::text n FROM tool_calls')).rows[0].n;
   for(const t of [first,second]){
    const denied=await t.call('thought',{action:'get',project,id:thoughtId,agent_id:issued.principal.agent_id});
    check(denied.error==='agent_token_fehlt','Tokenname braucht Ausweis '+mode+t.name);
    const wrong=await t.call('thought',{action:'get',project,id:thoughtId,token:'invalid-personal-'+mode});
    check(wrong.error==='agent_token_ungueltig','Falscher Ausweis kein Legacy-Fallback '+mode+t.name);
    const empty=await t.call('thought',{action:'get',project,id:thoughtId,token:''});
    check(empty.error==='agent_token_ungueltig','Leerer Ausweis kein Legacy-Fallback '+mode+t.name);
   }
   // Erfasste Ablehnungen muessen projektbezogen sichtbar sein, ohne ungepruefte ID-Bindung.
   let audit=[];
   for(let i=0;i<30;i++){
    audit=(await pool.query("SELECT * FROM tool_calls WHERE id>$1 AND project=$2 AND source=$3 AND error IN ('agent_token_ungueltig','agent_token_fehlt') ORDER BY id",[auditStart,project,first.source])).rows;
    if(audit.length>=6)break;
    await new Promise(r=>setTimeout(r,10));
   }
   check(audit.length===6,'Genau eine projektbezogene Diagnose pro Ablehnung '+mode+first.name);
   check(audit.filter(r=>r.error==='agent_token_ungueltig').length===4,'Vier feste Ungueltig-Codes '+mode+first.name);
   check(audit.filter(r=>r.error==='agent_token_fehlt').length===2,'Zwei feste Fehlend-Codes '+mode+first.name);
   check(audit.every(r=>r.identity_id===null),'Ungepruefter Ausweis verleiht keine Audit-Identitaet');
   for(const t of [first,second]){
    const unknown=await t.call('thought',{action:'get',project,id:thoughtId,agent_id:'legacy-ohne-sitzung'});
    check(unknown.success!==false,'Legacy ohne vorhandene Sitzung '+mode+t.name);
    const foreign=await t.call('thought',{action:'get',project:project+'-foreign',id:thoughtId,agent_id:issued.principal.agent_id});
    check(foreign.error!=='agent_token_fehlt','Tokenname nur im eigenen Projekt reserviert '+mode+t.name);
    const wrongProject=await t.call('chat',{action:'identitaet',token:issued.token,project:project+'-foreign'});
    check(wrongProject.error==='agent_token_fremdes_projekt','Persoenlicher Ausweis wahrt Projektgrenze '+mode+t.name);
    const transportCall=async(token,args)=>{
     if(t.source==='cloud')return t.call('chat',args,{'x-synapse-agent-token':token});
     process.env.SYNAPSE_AGENT_TOKEN=token;
     try{return await t.call('chat',args);}finally{delete process.env.SYNAPSE_AGENT_TOKEN;}
    };
    const transported=await transportCall(issued.token,{action:'identitaet'});
    check(transported.principal?.identity_id===issued.principal.identity_id,'Dedizierter Transport bleibt persoenlich '+mode+t.name);
    const badTransport=await transportCall('invalid-transport',{action:'list',project});
    check(badTransport.error==='agent_token_ungueltig','Kein Legacyfallback bei ungueltigem Transportausweis '+mode+t.name);
    const explicitEmpty=await transportCall(issued.token,{action:'identitaet',token:''});
    check(explicitEmpty.error==='agent_token_ungueltig','Explizites Leerfeld verdraengt gueltigen Transportausweis '+mode+t.name);
   }
   console.log('GEPRUEFT '+mode+' '+first.name);
  }
 }
 await groups.closeHttp();
 const oauthAudit=(await pool.query("SELECT * FROM tool_calls WHERE tool_name='mcp' AND action='auth'")).rows;
 check(oauthAudit.length===1&&oauthAudit.every(r=>r.ok===false&&r.error==='unauthorized'&&r.agent_id===null&&r.identity_id===null),'OAuth-Ablehnungen: maximal eine Aggregatzeile pro Prozess/Minute');
 const aggregate=oauthAudit.length===1?JSON.parse(oauthAudit[0].result):{};
 check(aggregate.count===208&&Array.isArray(aggregate.gruppen)&&aggregate.gruppen.reduce((n,g)=>n+g.count,0)===208,'OAuth-Aggregat zaehlt alle Abweisungen nach Pfad und festem Grund');
 const logs=JSON.stringify((await pool.query('SELECT * FROM tool_calls')).rows);
 // P22-T55 (User 19.10.): der Personenausweis ist kein Geheimnis mehr (unmaskiert im Tool-Log); OAuth bleibt geschwaerzt.
 check(!logs.includes(bearer),'Kein OAuth-Bearer im Audit');
 check((await pool.query('SELECT identity_id FROM agent_sessions WHERE id=$1 AND project=$2',[legacy,project])).rows[0].identity_id===null,'Legacy-Sitzung bleibt ungebunden');
 check(network===0,'Keine echten Netzwerk-/Modellaufrufe');
 console.log('P22-T16 '+checks+' Pruefungen, '+failures.length+' Fehler');
 if(failures.length)process.exitCode=1;
}catch(error){console.error(mask(error.stack));process.exitCode=1;}
finally{
 for(const fn of close.reverse())try{await fn();}catch(error){console.error(mask('Transport-Cleanup: '+error.message));process.exitCode=1;}
 if(core)await core.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(process.exitCode||0);
