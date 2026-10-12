/** P10-T54: zwölf große History-Jobs über echte REST-/stdio-Transporte.
 * Nur eigenes synapse_test-Schema/Projekt; keine Befehle werden ausgeführt.
 * --capture-old misst den Altstand, --verify-old prüft ihn; sonst rote/grüne Größenprobe.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createTestFixtureCleanup } from './_helfer/test-fixture-cleanup.mjs';
const db=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const schema='t54_'+randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path='+schema+',public -c statement_timeout=60000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000');
process.env.DATABASE_URL=db.href;process.env.SYNAPSE_DATABASE_URL=db.href;
const project='t54-'+randomUUID(),agent='t54-agent-'+randomUUID();
const cleanup=createTestFixtureCleanup(),ids=Array.from({length:12},(_,i)=>'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
const commands=ids.map((_,i)=>i===11?'printf kurz':"node -e "+JSON.stringify("console.log('🌍"+'x'.repeat(5000)+"')"));
const tails=ids.map((_,i)=>i===11?[]:Array.from({length:5},(_,n)=>'Zeile '+n+' '+('Ausgabe🌍').repeat(600)));
const stamps=ids.map((_,i)=>new Date(Date.UTC(2026,0,1,0,0,i)).toISOString());
let pool,app,client,mock,root,created=false;const measurements={};
const capture=process.argv.includes('--capture-old'),verifyOld=process.argv.includes('--verify-old');
const plain=p=>{while(p?.content?.[0]?.text)p=JSON.parse(p.content[0].text);return p;};
async function call(mode,args){
  const input={project,agent_id:agent,...args};
  if(mode==='rest'){
    const response=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'shell',arguments:input}}});
    assert.equal(response.statusCode,200);const result=response.json().result;assert(!result.isError);
    return {body:plain(result.structuredContent),textChars:result.content[0].text.length};
  }
  const result=await client.callTool({name:'shell',arguments:input});assert(!result.isError);
  return {body:plain(JSON.parse(result.content[0].text)),textChars:result.content[0].text.length};
}
const normalize=jobs=>JSON.parse(JSON.stringify(jobs).replaceAll(project,'<PROJECT>').replaceAll(agent,'<AGENT>'));
try{
  root=await cleanup.createRoot('t54-history-');await mkdir(join(root,'.synapse'));
  await writeFile(join(root,'.synapse','project-registry.json'),JSON.stringify({[project]:root}));
  await writeFile(join(root,'.synapse','status.json'),JSON.stringify({project,path:root,status:'active',setupPhase:'initial-done'}));
  mock=http.createServer(async(req,res)=>{
    for await(const chunk of req){}res.setHeader('content-type','application/json');
    const path=req.url;let answer={result:{config:{params:{vectors:{size:3,distance:'Cosine'}}},points_count:0}};
    if(path==='/')answer={title:'fixture',version:'1.15.0'};
    else if(path.includes('/points/search'))answer={result:[]};
    else if(path.includes('/points/scroll'))answer={result:{points:[],next_page_offset:null}};
    else if(path.includes('/api/embed'))answer={embeddings:[[1,0,0]]};
    else if(path.includes('/api/tags'))answer={models:[{name:'t54-fixture',digest:'fixture'}]};
    else if(path.includes('/api/show'))answer={model_info:{'fixture.embedding_length':3}};
    res.end(JSON.stringify(answer));
  });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const endpoint='http://127.0.0.1:'+mock.address().port;
  Object.assign(process.env,{QDRANT_URL:endpoint,OLLAMA_URL:endpoint,OLLAMA_MODEL:'t54-fixture',EMBEDDING_PROVIDER:'ollama',EMBEDDING_TARGET_DIM:'3',EMBEDDING_PRAEFIXE:'aus',SYNAPSE_API_URL:endpoint,CHANNEL_SKILL_MIN_SCORE:'1.1',SYNAPSE_INTERN_TOOL:'0'});
  pool=(await import('../dist/db/client.js')).getPool();
  await pool.query('CREATE SCHEMA "'+schema+'"');created=true;
  for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
    const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
  }
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t54-fixture',root]);
  for(let i=0;i<12;i++)await pool.query(
    'INSERT INTO shell_jobs(id,project,agent_id,command,status,exit_code,tail,output,output_truncated,error,message,claimed_by,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$10,$11,$12,$13)',
    [ids[i],project,agent,commands[i],i===0?'running':i===1?'failed':'done',i===0?null:i===1?1:0,JSON.stringify(tails[i]),tails[i].join('\n'),i===1?'E'.repeat(5000):null,i===1?'M'.repeat(5000):null,'daemon-fixture',stamps[i],i===0?null:stamps[i]]);
  const queue=await import('../dist/services/shell-queue.js');
  const requireRest=createRequire(new URL('../../rest-api/package.json',import.meta.url));
  app=requireRest('fastify')({logger:false});await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
  const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const sp=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url)),tp=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));delete env.SYNAPSE_AGENT_NAME;
  Object.assign(env,{SYNAPSE_PROJECT:project,SYNAPSE_TEST_STREAM_HOME:root});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',fileURLToPath(new URL('./_helfer/fixture-test-home.mjs',import.meta.url)),'--input-type=module','--eval','const {createServer}=await import('+JSON.stringify(sp)+');const {StdioServerTransport}=await import('+JSON.stringify(tp)+');await createServer().connect(new StdioServerTransport());'],cwd:fileURLToPath(new URL('../../../',import.meta.url)),env,stderr:'pipe'});
  transport.stderr?.resume();client=new Client({name:'t54-test',version:'1'});await client.connect(transport);
  for(const mode of ['rest','stdio']){
    const result=await call(mode,{action:'history',limit:12});
    assert.equal(result.body.count,12);
    measurements[mode]={textChars:result.textChars,coreChars:JSON.stringify(result.body.jobs).length,jobs:normalize(result.body.jobs)};
  }
  const compactMeasurement=Object.fromEntries(Object.entries(measurements).map(([mode,row])=>[mode,{textChars:row.textChars,coreChars:row.coreChars,jobs:row.jobs.map(({command,tail,error,message,...meta})=>({...meta,commandChars:command.length,tailChars:JSON.stringify(tail).length,errorChars:error?.length??0,messageChars:message?.length??0}))}]));
  if(capture)console.log('T54_ALT_JSON '+JSON.stringify(compactMeasurement));
  else{
    const old=JSON.parse(await readFile(new URL('./fixtures/shell-history-p10-t54-alt.json',import.meta.url),'utf8'));
    if(verifyOld)for(const mode of ['rest','stdio'])assert.deepEqual(compactMeasurement[mode].jobs,old[mode].jobs,'Alter History-Stand deterministisch');
    else{
      for(const mode of ['rest','stdio']){
        const {jobs}=measurements[mode];
        assert(JSON.stringify(jobs).length<16000,mode+': zwölf Jobs unter 16.000 Zeichen Kernstruktur');
        for(const job of jobs){
          assert(job.command.length<=300,mode+': Kommando-Vorschau begrenzt');
          assert(job.command.isWellFormed(),'Keine zerschnittenen Unicode-Surrogate');
          assert((job.tail??[]).every(line=>line.isWellFormed()));
          assert(!Object.hasOwn(job,'output'));assert(!Object.hasOwn(job,'sicherung'));
          assert((job.tail??[]).length<=3);
          assert((job.tail??[]).every(line=>line.length<=160));
          assert(!job.error||job.error.length<=300);assert(!job.message||job.message.length<=300);
          assert.equal(job.output_truncated,false);
        }
        const long=jobs.find(j=>j.id===ids[1]);assert.equal(long.command_truncated,true);assert.equal(long.tail_truncated,true);
        const running=jobs.find(j=>j.id===ids[0]);assert(Object.hasOwn(running,'exit_code'));assert.equal(running.exit_code,null);
        const short=jobs.find(j=>j.id===ids[11]);assert.equal(short.command,'printf kurz');assert.deepEqual(short.tail,[]);assert.equal(short.exit_code,0);assert(!short.command_truncated);
        const filtered=(await call(mode,{action:'history',status:'failed',limit:1})).body;
        assert.equal(filtered.count,1);assert.equal(filtered.jobs[0].id,ids[1]);
        const paged=(await call(mode,{action:'history',offset:2,limit:2})).body;
        assert.deepEqual(paged.jobs.map(j=>j.id),[ids[9],ids[8]]);
        const empty=(await call(mode,{action:'history',project:project+'-leer'})).body;assert.equal(empty.count,0);assert.deepEqual(empty.jobs,[]);
        const full=(await call(mode,{action:'get',id:ids[1]})).body.job;
        assert.equal(full.command,commands[1]);assert.equal(full.output,tails[1].join('\n'));assert.equal(full.error,'E'.repeat(5000));
        console.log('T54_MESSUNG '+JSON.stringify({mode,altText:old[mode].textChars,neuText:measurements[mode].textChars,altKern:old[mode].coreChars,neuKern:measurements[mode].coreChars}));
      }
      // Inneres stdio-JSON behält historische Nullfelder; fehlend/null ist außer exit_code gleichwertig.
      const cleaned=jobs=>jobs.map(j=>Object.fromEntries(Object.entries(j).filter(([k,v])=>v!==null||k==='exit_code')));
      assert.deepEqual(cleaned(measurements.rest.jobs),cleaned(measurements.stdio.jobs),'Gleiche History-Metadaten/Vorschau in beiden Transporten');
      const raw=await queue.getShellJobs({project,limit:12});
      assert.equal(raw.find(j=>j.id===ids[1]).command,commands[1],'Interne/raw-Anzeige unverändert');
      assert.deepEqual(raw.find(j=>j.id===ids[1]).tail,tails[1]);
      const frozen=Object.freeze({...raw.find(j=>j.id===ids[1]),tail:Object.freeze([...tails[1]])});
      const before=JSON.stringify(frozen);
      const projected=(await import('../dist/services/shell-job-anzeige.js')).shellHistoryAnzeige(frozen);
      assert.equal(JSON.stringify(frozen),before,'Anzeige mutiert auch eingefrorene Eingaben nicht');
      assert(projected.command.length<=300);assert.notEqual(projected,frozen);
      const stored=(await pool.query('SELECT command,tail,output FROM shell_jobs WHERE id=$1',[ids[1]])).rows[0];
      assert.equal(stored.command,commands[1]);assert.deepEqual(stored.tail,tails[1]);assert.equal(stored.output,tails[1].join('\n'));
      process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT='0';
      const rollback=await queue.getShellJobs({project,limit:12,anzeige:'kompakt'});
      assert.equal(rollback.find(j=>j.id===ids[1]).command,commands[1],'Gemeinsamer Rückweg bewahrt Altformat');
      delete process.env.SYNAPSE_TOOL_ANTWORT_KOMPAKT;
      console.log('P10-T54 grün: Vorschau/Metadaten, Transport-Parität, Filter/Paging, voller Einzelabruf, Persistenz und Rückweg.');
    }
  }
}finally{
  await client?.close();await app?.close();
  if(pool){if(created)await pool.query('DROP SCHEMA "'+schema+'" CASCADE');await pool.end();}
  if(mock)await new Promise(r=>mock.close(r));
  await cleanup.cleanup();cleanup.dispose();
}
process.exit(0);
