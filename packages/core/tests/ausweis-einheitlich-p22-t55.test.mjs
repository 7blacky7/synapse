/**
 * P22-T55: Ausweis einheitlich in ALLEN Tools - nur die Ausweis-Identitaet zaehlt. synapse_test:5433, privates Schema.
 *   node packages/core/tests/ausweis-einheitlich-p22-t55.test.mjs
 * A tools/list (REST + stdio, ohne Projekt, Kern nur projektweise): token in allen Tools, chat anmelden/identitaet, agent_id-Text.
 * B chat(anmelden): principal.ausweis = Klartext-Ausweis (nicht maskiert).
 * C je Tool-Familie ohne / gleiche / fremde agent_id -> gleiche Attribution (Identitaet), Datenfelder inkl. memories/tech_docs.
 * D Hinweis ausweis_hinweis bei agent_id/role mit Ausweis, je Lauf einmal; fremde agent_id ignoriert, kein Fehler (auch strikt).
 * E Filter: files history (Fachfilter bleibt, Koordinator sieht fremde Versionen, Name/identity_id), shell activity agent_ids.
 * F tool_calls: Ausweis nicht geschwaerzt, andere Geheimnisse weiter geschwaerzt. G Legacy unveraendert. H stdio-Attribution.
 * I shell-Rueckfrage mit identity_id ohne agent_id.
 */
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync} from 'node:fs';
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
 'SYNAPSE_MAIN_SYNAPSE','SYNAPSE_PROJECT','SYNAPSE_W1B_TOKEN_HINWEIS_MS'])delete process.env[k];
const {Pool}=require('pg');
const admin=new Pool({connectionString:url.href});
const schema='p22_t55_'+process.pid+'_'+randomUUID().slice(0,8);
const P='p22-t55-synthetic';
const bearer=randomUUID()+randomUUID();
const failures=[];let checks=0;
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}else console.log('ok   '+label);}
const warte=ms=>new Promise(r=>setTimeout(r,ms));
const close=[];
let pool;
const unwrap=r=>{
 if(!r)return {};
 const sc=r.structuredContent;if(sc&&typeof sc==='object')return sc;
 const t=r.content?.find(c=>c.type==='text')?.text;
 try{return JSON.parse(t);}catch{return {text:t};}
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
 const root=mkdtempSync(join(tmpdir(),'p22-t55-'));
 Object.assign(process.env,{DATABASE_URL:url.href,SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
  SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',SYNAPSE_HINWEIS_BUDGET_MS:'5000',
  QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 const T=await load('packages/core/dist/services/agent-token-tools.js');
 const B=await load('packages/core/dist/services/agent-bezug.js');
 const R=await load('packages/core/dist/services/shell-rueckfrage.js');
 const S=await load('packages/core/dist/services/tool-args-schwaerzen.js');
 await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'access','mcp:tools',NOW()+INTERVAL '1 hour')",[createHash('sha256').update(bearer).digest('hex')]);
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[P,'rest-api',root]);
 // Kern NUR projektweise (Prod-Lage), nicht global
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'agenten_ausweis',true,'Test P22-T55','user')",[P]);
 const identitaet=async(id,agentId,rolle)=>{
  const tok='sai_'+randomBytes(16).toString('hex');
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$2,$3,$3,$4,'test')",[id,P,agentId,rolle]);
  await pool.query("INSERT INTO agent_identitaet_tokens(id,identity_id,token_offen,token_praefix,ausweis_weg) VALUES($1,$2,$3,$4,'vorbereitet')",[randomUUID(),id,tok,tok.slice(0,12)]);
  return tok;
 };
 const tokA=await identitaet('t55-a','t55-sub','subagent');
 const tokK=await identitaet('t55-k','koordinator','koordinator');

 // ---- REST
 const fastify=(await load('packages/rest-api/node_modules/fastify/fastify.js')).default;
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAuthHook}=await load('packages/rest-api/dist/middleware/auth-hook.js');
 const app=fastify({logger:false});registerAuthHook(app);await app.register(mcpRoutes);await app.ready();close.push(()=>app.close());
 let seq=0;
 const rpc=(method,params)=>app.inject({method:'POST',url:'/mcp/messages',headers:{authorization:'Bearer '+bearer,'mcp-session-id':'p22-t55'},payload:{jsonrpc:'2.0',id:++seq,method,params}});
 const rest=async(name,args)=>{const j=(await rpc('tools/call',{name,arguments:args})).json();return j.error?{_rpcError:j.error}:unwrap(j.result);};

 // ---- stdio (Kindprozess, dasselbe private Schema)
 const {Client}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const sp=pathToFileURL(join(repo,'packages/mcp-server/dist/server.js')).href;
 const tp=pathToFileURL(join(repo,'packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href;
 const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
 const transport=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval',
  'const {createServer}=await import('+JSON.stringify(sp)+');const {StdioServerTransport}=await import('+JSON.stringify(tp)+');await createServer().connect(new StdioServerTransport());'],
  cwd:repo,env,stderr:'pipe'});
 const client=new Client({name:'p22-t55',version:'1'});await client.connect(transport);close.push(()=>client.close());
 const st=async(name,args)=>unwrap(await client.callTool({name,arguments:args}));

 // ================= A: tools/list =================
 for(const [weg,liste] of [['REST',(await rpc('tools/list',{})).json().result?.tools??[]],['stdio',(await client.listTools()).tools]]){
  const ohne=liste.filter(t=>t.inputSchema?.properties&&!t.inputSchema.properties.token).map(t=>t.name);
  check(liste.length>10&&ohne.length===0,`A ${weg}: token in allen ${liste.length} Tools beworben (ohne: ${ohne.join(',')})`);
  const en=liste.find(t=>t.name==='chat')?.inputSchema?.properties?.action?.enum??[];
  check(en.includes('anmelden')&&en.includes('identitaet'),`A ${weg}: chat-Enum mit anmelden/identitaet`);
  const aid=liste.find(t=>t.name==='thought')?.inputSchema?.properties?.agent_id?.description??'';
  check(aid.startsWith(T.TEXT_AGENT_ID_MIT_AUSWEIS),`A ${weg}: agent_id-Beschreibung 'nur ohne Ausweis'`);
 }

 // ================= B: anmelden ohne Maske =================
 const anA=await rest('chat',{action:'anmelden',token:tokA});
 check(anA.principal?.ausweis===tokA&&anA.principal?.identity_id==='t55-a','B anmelden: principal.ausweis = Klartext-Ausweis');
 const laufA=anA.principal?.lauf_id;
 const anK=await rest('chat',{action:'anmelden',token:tokK});
 check(anK.principal?.ausweis===tokK,'B Koordinator: Ausweis im Klartext');

 // ================= C + D: Attribution je Tool-Familie =================
 const V=[['ohne',{}],['gleich',{agent_id:'t55-sub'}],['fremd',{agent_id:'fremd-x',role:'koordinator'}]];
 const faelle=[
  ['thought.add',v=>({tool:'thought',args:{action:'add',project:P,content:'t55 '+v}}),"SELECT source AS a,source_identity_id AS i FROM thoughts WHERE project=$1 AND content=$2",v=>[P,'t55 '+v]],
  ['memory.write',v=>({tool:'memory',args:{action:'write',project:P,name:'t55-m-'+v,content:'x'}}),"SELECT author_agent_id AS a,author_identity_id AS i,author_lauf_id AS l FROM memories WHERE project=$1 AND name=$2",v=>[P,'t55-m-'+v]],
  ['docs.add',v=>({tool:'docs',args:{action:'add',project:P,framework:'t55',version:'1',section:'s-'+v,content:'d '+v,type:'gotcha'}}),"SELECT author_agent_id AS a,author_identity_id AS i,author_lauf_id AS l FROM tech_docs WHERE project=$1 AND section=$2",v=>[P,'s-'+v]],
  ['chat.send',v=>({tool:'chat',args:{action:'send',project:P,content:'c '+v}}),"SELECT sender_id AS a,sender_identity_id AS i FROM chat_messages WHERE project=$1 AND content=$2",v=>[P,'c '+v]],
  ['event.emit',v=>({tool:'event',args:{action:'emit',project:P,event_type:'ANNOUNCEMENT',priority:'normal',payload:'e '+v}}),"SELECT source_id AS a,source_identity_id AS i FROM agent_events WHERE project=$1 AND payload::text LIKE $2",v=>[P,'%e '+v+'%']],
  ['proposal.create',v=>({tool:'proposal',args:{action:'create',project:P,file_path:'x.ts',suggested_content:'y',description:'p '+v}}),"SELECT author AS a,author_identity_id AS i FROM proposals WHERE project=$1 AND description=$2",v=>[P,'p '+v]],
  ['files.create',v=>({tool:'files',args:{action:'create',project:P,file_path:'f-'+v+'.txt',content:'z\n'}}),"SELECT agent_id AS a,author_identity_id AS i FROM file_versions WHERE project=$1 AND file_path=$2",v=>[P,'f-'+v+'.txt']],
 ];
 const hinweise=[];
 for(const [name,mk,sql,par] of faelle)for(const [v,extra] of V){
  const {tool,args}=mk(v);
  const r=await rest(tool,{...args,token:tokA,...extra});
  if(r.ausweis_hinweis)hinweise.push({name,v,h:r.ausweis_hinweis});
  check(r.success!==false&&!r._rpcError,`C ${name} [${v}] ohne Fehler (${r.error??''})`);
  const z=(await pool.query(sql,par(v))).rows[0]??{};
  check(z.a==='t55-sub'&&z.i==='t55-a'&&(!('l' in z)||z.l===laufA),`C ${name} [${v}] Attribution Identitaet (${JSON.stringify(z)})`);
 }
 const sesZahl=async()=>(await pool.query("SELECT count(*)::int n FROM agent_sessions WHERE id='t55-sub'")).rows[0].n;
 check(hinweise.filter(h=>h.v==='gleich').length===1&&hinweise.filter(h=>h.v==='fremd').length===1,
  'D ausweis_hinweis je Lauf einmal fuer gleiche und einmal fuer fremde Angabe ('+hinweise.length+')');
 const hf=hinweise.find(h=>h.v==='fremd')?.h;const hText=Array.isArray(hf)?hf.join(' '):String(hf??'');
 check(hText.includes('Mit Ausweis nur token mitgeben')&&hText.includes('ignoriert'),'D Hinweistext: nur token mitgeben + ignoriert');
 // strikt: fremde agent_id = Hinweis statt identitaet_konflikt
 process.env.SYNAPSE_W1B_DURCHSETZUNG='1';
 const strikt=await rest('thought',{action:'add',project:P,content:'t55 strikt',token:tokA,agent_id:'noch-wer'});
 delete process.env.SYNAPSE_W1B_DURCHSETZUNG;
 const zs=(await pool.query("SELECT source,source_identity_id FROM thoughts WHERE project=$1 AND content='t55 strikt'",[P])).rows[0];
 check(strikt.success!==false&&strikt.error!=='identitaet_konflikt'&&zs?.source_identity_id==='t55-a','D strikter Modus: fremde agent_id ignoriert, kein identitaet_konflikt');

 // ================= E: Filter =================
 await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,agent_id,size_bytes) VALUES($1,'legacy.txt','a','h','create','legacy-x',1)",[P]).catch(()=>{});
 const hk=await rest('files',{action:'history',project:P,token:tokK,limit:50});
 const hkA=(hk.entries??[]).filter(e=>e.author_identity_id==='t55-a').length;
 check(hkA>=3,'E files history (Koordinator, ohne Filter): fremde Versionen sichtbar ('+hkA+')');
 const ha=await rest('files',{action:'history',project:P,token:tokA,limit:50});
 check((ha.entries??[]).some(e=>e.agent_id==='legacy-x'),'E files history mit Ausweis ohne Filter: nicht auf eigenen Agenten eingeschraenkt');
 for(const f of [{agent_filter:'t55-sub'},{agent_filter:'t55-a'},{agent_id:'t55-sub'}]){
  const r=await rest('files',{action:'history',project:P,token:tokK,limit:50,...f});
  const e=r.entries??[];
  check(e.length>=3&&e.every(x=>x.author_identity_id==='t55-a'),'E files history Filter '+JSON.stringify(f)+' findet Ausweis-Versionen ('+e.length+')');
 }
 const legacyF=await rest('files',{action:'history',project:P,token:tokK,agent_filter:'legacy-x'});
 check((legacyF.entries??[]).length===1,'E Legacy-Name-Filter unveraendert');
 await warte(300);
 for(const ids of [['t55-sub'],['t55-a'],['identity:t55-a']]){
  const r=await rest('shell',{action:'activity',project:P,agent_ids:ids,limit:20,token:tokK});
  check((r.activity??[]).length>0&&r.activity.every(x=>x.identity_id==='t55-a'),'E shell activity agent_ids '+JSON.stringify(ids)+' -> '+(r.activity??[]).length);
 }
 const z=await B.loeseAgentFilter(P,['t55-sub','legacy-x','identity:t55-k']);
 check(z.identity_ids.includes('t55-a')&&z.identity_ids.includes('t55-k')&&z.namen.includes('legacy-x'),'E loeseAgentFilter: Name, identity:, Legacy');

 check(await sesZahl()===0,'E Filter mit fremdem Namen legt keine Legacy-Sitzung unter diesem Namen an');
 // ================= F: tool_calls ohne Ausweis-Maske =================
 await warte(300);
 const tc=(await pool.query("SELECT result FROM tool_calls WHERE project=$1 AND tool_name='chat' AND action='anmelden' AND identity_id='t55-a' ORDER BY id DESC LIMIT 1",[P])).rows[0];
 check(!!tc&&String(tc.result).includes(tokA),'F tool_calls: Ausweis im Ergebnis im Klartext');
 check(S.schwaerzeToolLogText(JSON.stringify({token:tokA,password:'geheim123x'})).includes(tokA)&&!S.schwaerzeToolLogText(JSON.stringify({token:tokA,password:'geheim123x'})).includes('geheim123x'),
  'F Schwaerzen: Ausweis bleibt, Passwort wird geschwaerzt');
 check(S.schwaerzeToolLogText('Bearer '+'a'.repeat(30)).includes('[WERT]'),'F andere Geheimnisse (Bearer) weiter geschwaerzt');

 // ================= G: Legacy unveraendert =================
 const leg=await rest('thought',{action:'add',project:P,content:'t55 legacy',agent_id:'legacy-y',source:'legacy-y'});
 const zl=(await pool.query("SELECT source,source_identity_id FROM thoughts WHERE project=$1 AND content='t55 legacy'",[P])).rows[0];
 check(leg.success!==false&&zl?.source==='legacy-y'&&zl?.source_identity_id===null&&!leg.ausweis_hinweis,'G Legacy ohne Ausweis unveraendert '+JSON.stringify({leg,zl}).slice(0,300));
 const legTok=await rest('thought',{action:'search',project:P,query:'x',agent_id:'t55-sub'});
 check(legTok.error==='agent_token_fehlt','G Identitaetsname ohne Ausweis -> agent_token_fehlt (Ausweg im Text) '+JSON.stringify(legTok).slice(0,200)
  +JSON.stringify((await pool.query("SELECT id,identity_id,registered_at FROM agent_sessions WHERE id='t55-sub'")).rows));

 // ================= H: stdio =================
 const sa=await st('thought',{action:'add',project:P,content:'t55 stdio',token:tokA,agent_id:'fremd-stdio'});
 const zst=(await pool.query("SELECT source,source_identity_id FROM thoughts WHERE project=$1 AND content='t55 stdio'",[P])).rows[0];
 check(sa.success!==false&&zst?.source==='t55-sub'&&zst?.source_identity_id==='t55-a','H stdio: fremde agent_id ignoriert, Attribution Identitaet');
 const sm=await st('memory',{action:'write',project:P,name:'t55-m-stdio',content:'x',token:tokA});
 const zsm=(await pool.query("SELECT author_identity_id FROM memories WHERE project=$1 AND name='t55-m-stdio'",[P])).rows[0];
 check(sm.success!==false&&zsm?.author_identity_id==='t55-a','H stdio: memory mit Ausweis-Daten');

 // ================= I: shell-Rueckfrage =================
 R.leereShellRueckfragen();
 const bindung={art:'befehl',agent_id:null,identity_id:'t55-a',project:P,befehl_hash:'h',lage_hash:'l',regelversion:'r'};
 const rf=R.stelleShellRueckfrage(bindung);
 const ein=R.loeseShellRueckfrageEin(rf.bestaetigung_id,'Grund lang genug',bindung);
 check(ein.ok===true,'I Rueckfrage mit identity_id ohne agent_id einloesbar ('+JSON.stringify(ein)+')');
 check(R.loeseShellRueckfrageEin('abcdef1234','Grund lang genug',{...bindung,identity_id:null}).error==='agent_fehlt','I ohne agent_id und identity_id weiter agent_fehlt');
}catch(e){
 failures.push('Ausnahme: '+(e?.stack||e));console.error(e);
}finally{
 for(const c of close.reverse())await Promise.resolve(c()).catch(()=>{});
 await pool?.end().catch(()=>{});
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>{});
 await admin.end();
}
console.log(`\nP22-T55: ${checks} Pruefungen, ${failures.length} Fehler`);
if(failures.length){console.error(failures.join('\n'));process.exit(1);}
process.exit(0);
