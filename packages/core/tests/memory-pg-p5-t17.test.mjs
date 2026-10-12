/** P5-T17: echte REST/stdio/core-Lesewege, eigene PG-Spielwiese.
 * Embedding/Qdrant: lokale explizite HTTP-Test-Doubles mit deterministischer Cosinus-Rangfolge.
 * Kein Qualitätsbenchmark des produktiven Modells. Altwerte vor Produktionsänderung erfassen.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createTestFixtureCleanup } from './_helfer/test-fixture-cleanup.mjs';

const db = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(db.port,'5433'); assert.equal(db.pathname,'/synapse_test');
const schema='p5t17_'+randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path='+schema+',public -c statement_timeout=60000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000');
process.env.DATABASE_URL=db.href; process.env.SYNAPSE_DATABASE_URL=db.href;
const project='p5t17-'+randomUUID(), agent='p5t17-agent-'+randomUUID();
const cleanup=createTestFixtureCleanup();
const stamp='2026-01-01T00:00:00.000Z';
const topics=['datenbank','auth','cache','parser','gpu','hooks','shell','tests'];
const vector=text=>topics.map((topic,i)=>String(text).toLowerCase().includes(topic)?1:0.03*(i+1));
const cosine=(a,b)=>a.reduce((n,x,i)=>n+x*b[i],0)/(Math.hypot(...a)*Math.hypot(...b));
const fixtures=topics.map((topic,i)=>({id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  project,name:topic+'-wissen',content:topic+' Hinweise zum Projekt',category:'note',tags:[],
  linkedPaths:[],createdAt:stamp,updatedAt:stamp}));
const points=fixtures.map(({id,...payload})=>({id,payload,vector:vector(payload.content)}));
const ghost={id:'00000000-0000-4000-8000-000000000099',payload:{...points[0].payload,name:'geloeschte-index-regel',category:'rules'},vector:Array(8).fill(0)};
const queries=['datenbank Transaktionen','auth Rollen','cache Nachzug','parser Syntax','gpu Vorrang'];
const paths=['src/datenbank.ts','src/auth.ts','src/cache.ts','src/parser.ts','src/gpu.ts'];
const records={}; let pool,app,client,mock,root,created=false,offline=false;
const requests=[];
const capture=process.argv.includes('--capture-golden'), goldenOnly=process.argv.includes('--golden-only');
const plain=p=>{while(p?.content?.[0]?.text)p=JSON.parse(p.content[0].text);return p;};
async function call(mode,name,args){
  const input={project,agent_id:agent,...args};
  if(mode==='rest'){
    const response=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}}});
    assert.equal(response.statusCode,200); const result=response.json().result;
    assert(!result.isError,JSON.stringify(result)); return plain(result.structuredContent??JSON.parse(result.content[0].text));
  }
  const result=await client.callTool({name,arguments:input});assert(!result.isError,JSON.stringify(result));
  return plain(JSON.parse(result.content[0].text));
}
try{
  root=await cleanup.createRoot('p5t17-');
  await mkdir(join(root,'.synapse'));await writeFile(join(root,'.synapse','project-registry.json'),JSON.stringify({[project]:root}));
  await writeFile(join(root,'.synapse','status.json'),JSON.stringify({project,path:root,status:'active',setupPhase:'initial-done'}));
  mock=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):{}, path=new URL(req.url,'http://localhost').pathname;
    res.setHeader('content-type','application/json');
    if(path==='/')return res.end(JSON.stringify({title:'fixture',version:'1.15.0'}));
    if(offline){res.statusCode=503;return res.end(JSON.stringify({status:{error:'P5-T17 geplanter Index-Ausfall'}}));}
    let result={config:{params:{vectors:{size:8,distance:'Cosine'}}},points_count:points.length};
    if(path==='/api/embed')return res.end(JSON.stringify({embeddings:(Array.isArray(body.input)?body.input:[body.input]).map(vector)}));
    if(path==='/api/tags')return res.end(JSON.stringify({models:[{name:'p5t17-fixture',digest:'fixture'}]}));
    if(path==='/api/show')return res.end(JSON.stringify({model_info:{'fixture.embedding_length':8}}));
    if(path.includes('/points/search')){
      const hits=path.includes('_memories/')
        ? points.map(p=>({id:p.id,payload:p.payload,score:cosine(body.vector,p.vector)})).sort((a,b)=>b.score-a.score).slice(0,body.limit)
        : [];
      if(path.includes('_memories/'))requests.push({vector:body.vector,limit:body.limit,filterProject:body.filter?.must?.find(f=>f.key==='project')?.match?.value===project});
      result=hits;
    }else if(path.includes('/points/scroll')){
      const all=[...points,ghost]; const must=body.filter?.must??[];
      result={points:all.filter(p=>must.every(f=>p.payload[f.key]===f.match?.value)).slice(0,body.limit),next_page_offset:null};
    }
    res.end(JSON.stringify({result,status:'ok',time:0}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const endpoint='http://127.0.0.1:'+mock.address().port;
  Object.assign(process.env,{QDRANT_URL:endpoint,OLLAMA_URL:endpoint,OLLAMA_MODEL:'p5t17-fixture',
    EMBEDDING_PROVIDER:'ollama',EMBEDDING_TARGET_DIM:'8',EMBEDDING_PRAEFIXE:'aus',
    SYNAPSE_API_URL:endpoint,CHANNEL_SKILL_MIN_SCORE:'1.1',SYNAPSE_INTERN_TOOL:'0'});
  const database=await import('../dist/db/client.js');pool=database.getPool();
  await pool.query('CREATE SCHEMA "'+schema+'"');created=true;
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for(const {tablename}of tables){const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');}
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'p5t17-fixture',root]);
  await pool.query('INSERT INTO memories(id,project,name,content,category,tags,created_at,updated_at) SELECT id,project,name,content,category,tags,$2,$2 FROM jsonb_to_recordset($1::jsonb) AS x(id text,project text,name text,content text,category text,tags text[])',[JSON.stringify(fixtures),stamp]);
  const memory=await import('../dist/services/memory.js');
  const requireRest=createRequire(new URL('../../rest-api/package.json',import.meta.url));
  app=requireRest('fastify')({logger:false});await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
  const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const serverPath=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url));
  const transportPath=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));delete env.SYNAPSE_AGENT_NAME;
  env.SYNAPSE_PROJECT=project;env.SYNAPSE_TEST_STREAM_HOME=root;
  const childCode='const {createServer}=await import('+JSON.stringify(serverPath)+');const {StdioServerTransport}=await import('+JSON.stringify(transportPath)+');await createServer().connect(new StdioServerTransport());';
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',fileURLToPath(new URL('./_helfer/fixture-test-home.mjs',import.meta.url)),'--input-type=module','--eval',childCode],cwd:fileURLToPath(new URL('../../../',import.meta.url)),env,stderr:'pipe'});
  transport.stderr?.resume();client=new Client({name:'p5t17-golden',version:'1'});await client.connect(transport);
  for(const mode of ['rest','stdio']) {
    for(const query of queries){
      const result=await call(mode,'search',{action:'memory',query,limit:5});
      const hits=result.results??result.result??result;
      assert.equal(hits.length,5,'Semantik-Positivkontrolle');
      const normalized=hits.map(r=>({name:r.name??r.payload?.name,score:r.score}));
      assert.equal(new Set(normalized.map(r=>r.name)).size,5,'Semantik-Golden liefert keine doppelten Namen');
      records[mode+':search:'+query]=normalized;
    }
    for(const file_path of paths){
      const result=await call(mode,'memory',{action:'find_for_file',file_path,limit:5});
      const hits=result.results??result.memories??result.result??result;
      assert.equal(hits.length,5,'find_for_file Semantik-Positivkontrolle');
      records[mode+':find:'+file_path]=hits.map(r=>({name:r.memory?.name??r.name,score:r.score,matchType:r.matchType}));
    }
  }
  // Transport und Query-Embedding/-Filter dürfen sich ebenfalls nicht unbemerkt ändern.
  const baseline={setup:'lokale HTTP-Doubles, Cosinus-Ranking; echte core/REST/stdio-Aufrufe und synapse_test',records,requests};
  if(capture)console.log('P5T17_GOLDEN_JSON '+JSON.stringify(baseline));
  else{
    const old=JSON.parse(await readFile(new URL('./fixtures/memory-semantik-p5-t17-alt.json',import.meta.url),'utf8'));
    assert.deepEqual(baseline,old,'Semantik-Golden vor/nach einschließlich Queryvektor und Filter unverändert');
    console.log('P5-T17 Semantik-Golden: 10 feste Fälle × REST/stdio, Top5 Namen/Reihenfolge/Scores unverändert.');
  }
  if(!capture&&!goldenOnly){
    const ruleId=randomUUID();
    await pool.query("INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,'nur-pg-regel','Aktuelle Regel aus PG','rules',$3)",[ruleId,project,['pflicht']]);
    assert.equal((await memory.getMemoryByName(project,'nur-pg-regel')).content,'Aktuelle Regel aus PG');
    assert((await memory.getMemoriesByNames(project,['nur-pg-regel','datenbank-wissen'])).length===2);
    assert((await memory.getRulesForNewAgent(project)).some(m=>m.id===ruleId));
    assert(!(await memory.getRulesForNewAgent(project)).some(m=>m.name===ghost.payload.name));
    const onboarding=await call('rest','admin',{action:'index_stats',agent_id:agent+'-neu',role:'subagent',sitzung:'neu'});
    assert(onboarding.agentOnboarding?.rules?.some(r=>r.name==='nur-pg-regel'),'PG-only-Regel im echten Onboarding');
    await pool.query("INSERT INTO memories(id,project,name,content,category) SELECT md5($1||n::text),$1,'filler-'||lpad(n::text,4,'0'),'PG-only','note' FROM generate_series(1,1100) n",[project]);
    for(const mode of ['rest','stdio']){
      const all=await call(mode,'memory',{action:'list',names_only:true,limit:2000});
      assert.equal(all.total,1109,mode+': total zählt alle PG-Zeilen ohne Qdrant-Grenze');
      assert.equal(all.memories.length,1109);assert.equal(new Set(all.memories).size,1109);
      assert(!all.memories.includes(ghost.payload.name));assert(all.memories.includes('nur-pg-regel'));
      const small=await call(mode,'memory',{action:'list',names_only:true,limit:3});
      assert.equal(small.total,1109);assert.equal(small.memories.length,3);assert.equal(small.truncated,true);
      const rules=await call(mode,'memory',{action:'list',category:'rules',names_only:true});
      assert.deepEqual(rules.memories,['nur-pg-regel']);
      assert((await call(mode,'memory',{action:'read',name:'nur-pg-regel'})).success);
    }
    await pool.query('DELETE FROM memories WHERE id=$1',[ruleId]);
    assert.equal(await memory.getMemoryByName(project,'nur-pg-regel'),null);
    assert.deepEqual(await memory.getRulesForNewAgent(project),[]);
    offline=true;
    assert.equal((await memory.listMemories(project)).length,1108,'List unabhängig vom Index-Ausfall');
    assert.equal((await memory.listMemories(project,'rules')).length,0);
    assert.equal((await memory.getMemoryByName(project,'datenbank-wissen')).name,'datenbank-wissen');
    assert.equal((await memory.listMemories(project+'-fremd')).length,0,'Projektisolation');
    assert.deepEqual(await memory.getMemoriesByNames(project,[]),[]);
    console.log('P5-T17 PG-Vertrag grün: PG-only-Regel, Löschung/Geisterpunkt, >1000, total/Limit/Kategorie, Projektisolation, Qdrant-Ausfall.');
  }
}finally{
  await client?.close();await app?.close();
  if(pool){if(created)await pool.query('DROP SCHEMA "'+schema+'" CASCADE');await pool.end();}
  if(mock)await new Promise(r=>mock.close(r));
  await cleanup.cleanup();cleanup.dispose();
}
process.exit(0);
