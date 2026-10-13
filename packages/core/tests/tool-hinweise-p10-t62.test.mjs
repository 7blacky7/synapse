/** P10-T62: echte REST/stdio-Hinweise, ausschließlich eigenes synapse_test-Schema.
 * Keine Testkommandos/Jev-Aufrufe; DB-Jobs sind ausdrücklich synthetische Fixtures.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createTestFixtureCleanup} from './_helfer/test-fixture-cleanup.mjs';
const db=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const schema='t62_'+randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path='+schema+',public -c statement_timeout=60000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000');
process.env.DATABASE_URL=db.href;process.env.SYNAPSE_DATABASE_URL=db.href;
const project='t62-'+randomUUID(),a='t62-a-'+randomUUID(),b='t62-b-'+randomUUID(),jobA=randomUUID(),jobB=randomUUID();
const cleanup=createTestFixtureCleanup(),capture=process.argv.includes('--capture-old');
let root,pool,app,client,mock,created=false;const measures=[];
function plain(p){while(p?.content?.length===1&&p.content[0]?.type==='text'){const {content,...extra}=p;p={...JSON.parse(content[0].text),...extra};}return p;}
async function call(mode,name,actor,args={}){
  const input={project,agent_id:actor,...args};let result;
  if(mode==='rest'){
    const response=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}}});
    assert.equal(response.statusCode,200);result=response.json().result;
  }else result=await client.callTool({name,arguments:input});
  assert(!result.isError,JSON.stringify(result));
  const text=result.content[0].text;
  const body=plain(result.structuredContent??JSON.parse(text));
  measures.push({mode,name,action:args.action,chars:text.length,shellHints:body.shell_activity?.length??0,chat:!!body.unreadChat,channels:body.unread_channels?.length??0});
  return body;
}
const hints=p=>p.shell_activity??[];
try{
  root=await cleanup.createRoot('t62-hinweise-');await mkdir(join(root,'.synapse'));
  await writeFile(join(root,'.synapse','project-registry.json'),JSON.stringify({[project]:root}));
  await writeFile(join(root,'.synapse','status.json'),JSON.stringify({project,path:root,status:'active',setupPhase:'initial-done'}));
  mock=http.createServer(async(req,res)=>{for await(const chunk of req){}res.setHeader('content-type','application/json');
    const path=req.url;let answer={result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},points_count:0}};
    if(path==='/')answer={title:'fixture',version:'1.15.0'};
    else if(path.includes('/points/search'))answer={result:[]};
    else if(path.includes('/points/scroll'))answer={result:{points:[],next_page_offset:null}};
    else if(path.includes('/api/embed'))answer={embeddings:[[1,0,0]]};
    else if(path.includes('/api/tags'))answer={models:[{name:'t62-fixture',digest:'fixture'}]};
    else if(path.includes('/api/show'))answer={model_info:{'fixture.embedding_length':3}};
    res.end(JSON.stringify(answer));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const endpoint='http://127.0.0.1:'+mock.address().port;
  Object.assign(process.env,{QDRANT_URL:endpoint,OLLAMA_URL:endpoint,OLLAMA_MODEL:'t62-fixture',EMBEDDING_PROVIDER:'ollama',EMBEDDING_TARGET_DIM:'3',EMBEDDING_PRAEFIXE:'aus',SYNAPSE_API_URL:endpoint,CHANNEL_SKILL_MIN_SCORE:'1.1',SYNAPSE_INTERN_TOOL:'0'});
  pool=(await import('../dist/db/client.js')).getPool();await pool.query('CREATE SCHEMA "'+schema+'"');created=true;
  for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
    const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');}
  // Nur private Testtabelle; deckt auch einen älteren public-Test-DB-Stand ab.
  const start=performance.now();await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id BIGINT NOT NULL DEFAULT 0');
  const firstMs=performance.now()-start;const again=performance.now();await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id BIGINT NOT NULL DEFAULT 0');
  console.log('T62_DDL '+JSON.stringify({firstMs,secondMs:performance.now()-again}));
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t62-fixture',root]);
  await pool.query('INSERT INTO chat_lesestand(project,agent_id,letzte_id) VALUES($1,$2,0),($1,$3,0)',[project,a,b]);
  await pool.query("INSERT INTO shell_jobs(id,project,agent_id,command,status,exit_code,output,claimed_at,completed_at) VALUES($1,$2,$3,'printf fixture-a','running',NULL,'',NOW(),NULL),($4,$2,$5,'printf fixture-b','done',0,'fixture\\n',NOW(),NOW())",[jobA,project,a,jobB,b]);
  const channel=(await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('t62',$1,$2) RETURNING id",[project,a])).rows[0].id;
  await pool.query('INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id) VALUES($1,$2,0),($1,$3,0)',[channel,a,b]);
  await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,$2,'Neue Channel-Nachricht')",[channel,b]);
  await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) VALUES($1,$2,NULL,'Broadcast'),($1,$2,$3,'DM')",[project,b,a]);
  const requireRest=createRequire(new URL('../../rest-api/package.json',import.meta.url));
  app=requireRest('fastify')({logger:false});await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
  const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const sp=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url)),tp=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));delete env.SYNAPSE_AGENT_NAME;
  Object.assign(env,{SYNAPSE_PROJECT:project,SYNAPSE_TEST_STREAM_HOME:root});
  const startStdio=async()=>{const transport=new StdioClientTransport({command:process.execPath,args:['--import',fileURLToPath(new URL('./_helfer/fixture-test-home.mjs',import.meta.url)),'--input-type=module','--eval','const {createServer}=await import('+JSON.stringify(sp)+');const {StdioServerTransport}=await import('+JSON.stringify(tp)+');await createServer().connect(new StdioServerTransport());'],cwd:fileURLToPath(new URL('../../../',import.meta.url)),env,stderr:'pipe'});
  transport.stderr?.resume();client=new Client({name:'t62-test',version:'1'});await client.connect(transport);};await startStdio();
  const first=await call('rest','code_intel',a,{action:'tree'});
  const second=await call('stdio','shell',a,{action:'activity',limit:2});
  console.log('T62_MESSUNG '+JSON.stringify(measures));
  if(!capture){
    assert.equal(first.unreadChat.broadcasts,1);assert.equal(first.unreadChat.dms[0].count,1);
    assert.equal(first.unread_channels[0].count,1);
    assert(!second.unreadChat,'Chat-Neuigkeit insgesamt einmal über beide Transporte');
    assert(!second.unread_channels,'Channel-Neuigkeit einmal über beide Transporte');
    assert.equal(Number((await pool.query('SELECT letzte_id FROM chat_lesestand WHERE project=$1 AND agent_id=$2',[project,a])).rows[0].letzte_id),0,'Benachrichtigt ist nicht gelesen');
    await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) VALUES($1,$2,$3,'Neue DM')",[project,b,a]);
    const noProject=await call('stdio','shell',a,{action:'get',id:jobB,project:undefined});
    assert.equal(noProject.unreadChat.dms[0].count,1,'Neue DM auch bei shell/get ohne project');
    assert(!hints(noProject).some(h=>h.job_id===jobB),'Antwort-Job kein zusätzlicher Hinweis');
    assert(!(await call('rest','shell',a,{action:'log',id:jobB,project:undefined})).unreadChat);
    await pool.query('DELETE FROM shell_job_notices');
    const openA=await call('rest','shell',a,{action:'activity',limit:1});
    const openB=await call('stdio','shell',b,{action:'activity',limit:1});
    assert(hints(openA).some(h=>h.job_id===jobA&&h.kind==='start'),'A sieht eigenen running-Job');
    assert(hints(openB).some(h=>h.job_id===jobA&&h.kind==='start'),'B sieht fremden running-Job');
    assert(!hints(await call('stdio','shell',a,{action:'activity',limit:1})).some(h=>h.job_id===jobA),'Start einmal je Empfänger');
    await pool.query("UPDATE shell_jobs SET status='done',exit_code=0,completed_at=NOW() WHERE id=$1",[jobA]);
    const doneA=await call('stdio','shell',a,{action:'activity',limit:1});
    assert(hints(doneA).some(h=>h.job_id===jobA&&h.kind==='done'),'Abschluss nach gesehenem Start');
    await call('rest','shell',b,{action:'get',id:jobA});
    assert(!hints(await call('stdio','shell',b,{action:'activity',limit:1})).some(h=>h.job_id===jobA),'Get quittiert Abschluss vor dem Claim');
    await pool.query('DELETE FROM shell_job_notices');
    const history=await call('rest','shell',a,{action:'history',limit:10});
    assert.equal(hints(history).length,0,'History-Jobs nicht zusätzlich anhängen');
    assert.equal(Number((await pool.query('SELECT count(*) FROM shell_job_notices WHERE agent_id=$1',[a])).rows[0].count),0,'Nicht angehängte History-Jobs nicht als zugestellt verbrauchen');
    assert(hints(await call('stdio','shell',a,{action:'activity',limit:1})).length>0);
    await pool.query('DELETE FROM shell_job_notices WHERE agent_id=$1',[a]);
    await call('stdio','shell',a,{action:'log',id:jobA});
    assert(!hints(await call('rest','shell',a,{action:'activity',limit:1})).some(h=>h.job_id===jobA),'stdio-log wird richtig als gesehen erkannt');
    await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) VALUES($1,$2,$3,'Konkurrenz')",[project,a,b]);
    const chat=await import('../dist/services/chat-unread.js');
    const concurrent=await Promise.all(Array.from({length:12},()=>chat.getUnreadChatHint(project,b)));
    assert.equal(concurrent.filter(Boolean).length,1,'Atomarer Chat-Claim, ein Gewinner');
    await client.close();await startStdio();
    assert(!(await call('stdio','shell',a,{action:'activity',limit:1})).unreadChat,'Neuer stdio-Prozess kennt Chat-Hinweisstand');
    assert(!(await call('stdio','shell',a,{action:'activity',limit:1})).unread_channels,'Neuer stdio-Prozess kennt Channel-Hinweisstand');
    await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) SELECT id,$2,'Neue Channel-Nachricht' FROM specialist_channels WHERE project=$1 AND name='t62'",[project,b]);
    const freshChannel=await call('stdio','guide',a,{tool_name:'shell',project:undefined});
    assert.equal(freshChannel.unread_channels[0].count,2,'Neue Channel-Nachricht auch am nächsten Guide-Aufruf');
    assert(!(await call('rest','shell',a,{action:'activity',limit:1})).unread_channels);
    await pool.query('DELETE FROM shell_job_notices WHERE agent_id=$1',[a]);
    const stdioHistory=await call('stdio','shell',a,{action:'history',limit:10});
    assert.equal(hints(stdioHistory).length,0,'stdio History enthält keine zusätzlichen Hinweise auf Antwort-Jobs');
    assert.equal(Number((await pool.query('SELECT count(*) FROM shell_job_notices WHERE agent_id=$1',[a])).rows[0].count),0,'stdio History verbraucht keine ausgeschlossenen Hinweise');
    const untouched={success:true,count:0};const central=await import('../dist/services/tool-antwort.js');
    await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) VALUES($1,$2,$3,'Listen-Antwort')",[project,b,a]);
    const listData=[{id:'fixture',content:'Inhalt bleibt vollständig'}];
    const listReply=await central.ergaenzeToolHinweise(listData,'thought',{project,action:'search'},a);
    assert.deepEqual(listReply.result,listData,'Fachliche Listen-Inhalte unverändert');
    assert.equal(listReply.unreadChat.dms[0].count,1,'Auch Listen-Antwort beansprucht genau eine neue DM');
    assert.deepEqual(await central.ergaenzeToolHinweise(listData,'thought',{project,action:'search'},a),listData,'Ohne neue Hinweise bleibt Listen-Antwort bytegleich');
    assert.deepEqual(await central.ergaenzeToolHinweise(untouched,'shell',{project},undefined),untouched,'Ohne Identität kein Merkzustand');
    const interrupt={success:true,id:jobA,status:'running_background',unterbrochen_durch:{channel:'t62',message_id:123}};
    const enhanced=await central.ergaenzeToolHinweise(interrupt,'shell',{project,action:'exec'},b);
    assert.deepEqual(enhanced.unterbrochen_durch,interrupt.unterbrochen_durch,'Long-Poll-Unterbrechungsdaten unverändert');
    assert(!hints(enhanced).some(h=>h.job_id===jobA),'exec-Antwort-Job ausschließen');
    console.log('P10-T62 grün: einmalige Chat/Channel-Neuigkeiten, A/B, Transportwechsel, Seen, Antwort-IDs vor Claim, project-Auflösung, anonymer Aufruf, Long-Poll-Daten.');
  }
}finally{
  await client?.close();await app?.close();
  if(pool){if(created)await pool.query('DROP SCHEMA "'+schema+'" CASCADE');await pool.end();}
  if(mock)await new Promise(r=>mock.close(r));await cleanup.cleanup();cleanup.dispose();
}
process.exit(0);
