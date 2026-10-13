/** P10-T51: Alt-Golden über echte REST-/stdio-Transporte, ausschließlich Test-DB. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { symlink } from 'node:fs/promises';
import { createTestFixtureCleanup } from './_helfer/test-fixture-cleanup.mjs';

const db = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(db.port, '5433'); assert.equal(db.pathname, '/synapse_test');
const schema = 't51_golden_' + randomUUID().replaceAll('-', '');
db.searchParams.set('options', '-c search_path=' + schema + ',public -c statement_timeout=60000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000');
process.env.DATABASE_URL = db.toString();
process.env.SYNAPSE_DATABASE_URL = db.toString();
const project = 't51-golden-' + randomUUID(), agent = 't51-g-' + randomUUID();
const aliases = new Map([[project, '<PROJECT>'], [agent, '<AGENT>']]);
const ids = Object.fromEntries(['done','inline','git','running','thoughtA','thoughtB','plan','task','file'].map(name => [name, randomUUID()]));
for (const [name,id] of Object.entries(ids)) aliases.set(id, '<ID:' + name + '>');
const capture = process.argv.includes('--capture-old'), verifyOld = process.argv.includes('--verify-old'), checkK1 = process.argv.includes('--check-k1');
const cleanup = createTestFixtureCleanup();
let pool, app, client, mock, root, schemaCreated = false;
const records = {};
const hooks = new Set(['agentOnboarding','tool_guide','shell_activity','open_plans','unread_channels','unreadChat','pending_events','event_warning','skill_suggestions','skill_hook_metrics','skill_hook_skipped_due_to_load','jev_modus','werkzeug_regeln','hinweis_agent_id','erklaerung_faelle','entscheidungen_durchsicht']);
const times = new Set(['created_at','updated_at','claimed_at','completed_at','cancelled_at','createdAt','updatedAt','timestamp','committed_at','geprueft_am','expires_at','expiresAt','ready_at','readyAt','ts']);
function normalize(value, top = true, field = '') {
  if (typeof value === 'string') {
    if (field === '<MCP_TEXT>') {
      try { return JSON.stringify(normalize(JSON.parse(value), true),null,value.includes('\n')?2:undefined); } catch { /* Nicht-JSON-Anzeigetext bleibt Inhalt. */ }
    }
    for (const [actual, stable] of [...aliases].sort((a,b) => b[0].length-a[0].length)) {
      if (/^\d+$/.test(actual)) {
        if (value === actual && ['id','plan_id','batch_id','channel_id','message_id','primary_plan_id','target_plan_id'].includes(field)) return stable;
        value = value.replaceAll('Plan ' + actual + ' ', 'Plan ' + stable + ' ').replaceAll('plan_id:"' + actual + '"', 'plan_id:"' + stable + '"').replaceAll("plan_id:'" + actual + "'", "plan_id:'" + stable + "'");
      } else value = value.replaceAll(actual, stable);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(v => normalize(v, false));
  if (typeof value === 'number' && ['id','channel_id','message_id'].includes(field) && aliases.has(String(value))) return aliases.get(String(value));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key,v] of Object.entries(value)) {
    if (top && hooks.has(key)) continue;
    if (v !== null && times.has(key)) result[key] = '<ZEIT>';
    else if (['dauer_ms','ms','waited_seconds'].includes(key) && typeof v === 'number') result[key] = '<DAUER>';
    else result[key] = normalize(v, false, key==='text' && value.type==='text' ? '<MCP_TEXT>' : key);
  }
  return result;
}
function withoutNull(value, key = '') {
  if (Array.isArray(value)) return value.map(v => withoutNull(v));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k,v]) => v !== null || ['exit_code','total','target_plan_id','plan_id','content_hash_at_reservation'].includes(k)).map(([k,v]) => [k,withoutNull(v,k)]));
}
function approvedChange(value, label, mode, inner = false) {
  let result=JSON.parse(JSON.stringify(value));
  // P10-T55: ausschließlich shell/get und channel/feed verlieren die zusätzliche Hülle.
  if (mode==='stdio' && result?.content?.[0]?.text) {
    if (label.startsWith('shell-get-') || label.startsWith('channel-feed')) {
      result=approvedChange(JSON.parse(result.content[0].text),label,mode,true);
    }
  } else if (label.startsWith('shell-get-') && result?.job) {
    const job=result.job;
    delete job.exec_key;
    if(typeof job.output==='string'){delete job.tail;job.output_size=Buffer.byteLength(job.output);}
    const safety=job.sicherung;
    if(safety?.antwort?.lage && safety.lage){
      assert.deepEqual(safety.antwort.lage,safety.lage,'Fixture enthält dieselbe doppelte Lage');
      delete safety.antwort.lage;safety.antwort.lage_verweis='sicherung.lage';
    }
    for(const command of safety?.lage?.kommandos??[]){
      const script=command.inline_skript?.text;
      for(const arg of command.argv??[]){
        delete arg.raw;
        if(typeof arg.text==='string'&&(arg.text===script||arg.text.length>=160)){
          const text=arg.text;delete arg.text;
          arg.text_info={laenge:text.length,sha256:createHash('sha256').update(text).digest('hex'),verweis:'job.command'};
        }
      }
      if(typeof script==='string'){
        delete command.inline_skript.text;
        command.inline_skript.text_info={laenge:script.length,sha256:createHash('sha256').update(script).digest('hex'),verweis:'job.command'};
      }
    }
  }
  if(label==='thought-search'){
    if(mode==='stdio')result.message += ' (Vorschau; Volltext: thought get mit id oder volltext:true)';
    const hits=mode==='rest'?result.result:result.results;
    for(const hit of hits??[]){
      const payload=mode==='rest'?hit.payload:hit;
      const text=payload.content;
      assert.equal(typeof text,'string');
      delete payload.content;delete payload.embedding_modell;
      payload.vorschau=text.length>300?text.slice(0,300)+'…':text;
      payload.content_laenge=text.length;
    }
  }
  if(label==='code-search-one')for(const hit of result.results??[])for(const match of hit.matches??[])delete match.words;
  result=withoutNull(result);
  // REST dachte bei thought.search an ein Array; nur structuredContent hat dort die result-Hülle.
  if(!Array.isArray(result) && !Object.hasOwn(result,'success') && !(mode==='rest'&&label==='thought-search')) result={success:true,...result};
  return result;
}

async function both(label, name, args) {
  const input = {project, agent_id:agent, ...args};
  const response = await app.inject({method:'POST', url:'/', payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:input}}});
  assert.equal(response.statusCode,200,label);
  const rest = response.json().result;
  assert(rest && !rest.isError, label + ': REST erfolgreich');
  const rt = rest.content.find(b => b.type === 'text').text;
  const restTextPayload=JSON.parse(rt);
  assert.deepEqual(restTextPayload,Array.isArray(restTextPayload)?rest.structuredContent.result:rest.structuredContent,label + ': REST Text/Struktur semantisch identisch');
  const stdio = await client.callTool({name,arguments:input});
  assert(!stdio.isError,label + ': stdio erfolgreich');
  const st = stdio.content.find(b => b.type === 'text').text;
  if(process.argv.includes('--check-t55')&&((name==='shell'&&args.action==='get')||(name==='channel'&&args.action==='feed')))assert.deepEqual(stdio.structuredContent,JSON.parse(st),'T55 tatsächliche Text-/Strukturausgabe identisch');
  const rp = normalize(rest.structuredContent), sp = normalize(JSON.parse(st));
  records[label] = {rest:rp,restTextPayload:normalize(restTextPayload),stdio:sp,restTextChars:rt.length,stdioTextChars:st.length};
  if (!capture && !verifyOld && !checkK1) {
    assert.equal(rt, JSON.stringify(restTextPayload),label + ': REST ohne Einrückung (Array-Hülle bleibt eigener Vertrag)');
    assert.equal(st, JSON.stringify(JSON.parse(st)),label + ': stdio ohne Einrückung');
  }
}
try {
  root = await cleanup.createRoot('t51-golden-'); aliases.set(root,'<ROOT>');
  await mkdir(join(root,'.synapse'),{recursive:true}); await mkdir(join(root,'src'));
  await writeFile(join(root,'.synapse','project-registry.json'),JSON.stringify({[project]:root}));
  await writeFile(join(root,'.synapse','status.json'),JSON.stringify({project,path:root,status:'active',setupPhase:'initial-done'}));
  const code = 'export const goldenAlpha = 42;\n// goldenAlpha goldenBeta\n';
  await writeFile(join(root,'src','golden.ts'),code);
  mock = http.createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type','application/json');
    const points = [{id:ids.thoughtA,score:0.9,payload:{}},{id:ids.thoughtB,score:0.8,payload:{}}];
    const path = req.url;
    let answer = {result:{status:'green',points_count:2,config:{params:{vectors:{size:3,distance:'Cosine'}}}}};
    if (path.includes('/points/search')) answer={result:points};
    else if(path.includes('/points/query')) answer={result:{points}};
    else if(path.includes('/points/scroll')) answer={result:{points:[],next_page_offset:null}};
    else if(path.includes('/api/embed')) answer={embeddings:[[1,0,0]],embedding:[1,0,0]};
    else if(path.includes('/api/show')) answer={model_info:{'fixture.embedding_length':3},details:{}};
    else if(path.includes('/api/tags')) answer={models:[{name:'t51-fixture',model:'t51-fixture',digest:'fixture',details:{}}]};
    else if(path.includes('/v1/embeddings')) answer={data:[{embedding:[1,0,0],index:0}],usage:{prompt_tokens:1,total_tokens:1}};
    res.end(JSON.stringify(answer));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:' + mock.address().port;
  Object.assign(process.env,{QDRANT_URL:endpoint,OLLAMA_URL:endpoint,OLLAMA_MODEL:'t51-fixture',EMBEDDING_PROVIDER:'ollama',EMBEDDING_MODEL:'t51-fixture',EMBEDDING_TARGET_DIM:'3',EMBEDDING_PRAEFIXE:'aus',OLLAMA_NUM_CTX:'512',OLLAMA_NUM_BATCH:'32',CHANNEL_SKILL_MIN_SCORE:'1.1',SYNAPSE_API_URL:endpoint,SYNAPSE_INTERN_TOOL:'0'});
  const {getPool} = await import('../dist/db/client.js'); pool=getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"'); schemaCreated=true;
  const tables=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  for (const {tablename} of tables) {
    const q='"' + tablename.replaceAll('"','""') + '"';
    await pool.query('CREATE TABLE "' + schema + '".' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
  }
  // Der Golden modelliert auch optionale Detailspalten älterer/neuerer Test-DB-Stände, nur im eigenen Schema.
  await pool.query('ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output_size integer DEFAULT 0');
  await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id bigint NOT NULL DEFAULT 0');
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t51-fixture',root]);
  await pool.query("INSERT INTO memories(id,project,name,content,category,tags) VALUES($1,$2,'context-handoff-regeln','Fixture-Regel','rules',$3)",[randomUUID(),project,['pflicht']]);
  const stamp='2026-01-01T00:00:00.000Z';
  const inlineText="console.log('T51_GOLDEN_SCRIPT')";
  const inlineCommand='node -e ' + JSON.stringify(inlineText);
  const argv = [{raw:'node',text:'node',dynamisch:false},{raw:'-e',text:'-e',dynamisch:false},{raw:JSON.stringify(inlineText),text:inlineText,dynamisch:false}];
  const inlineLage = {os:'linux',cwd:root,project_root:root,hash:'fixture-lage',shell:'sh',kommandos:[{argv,inline_skript:{sprache:'javascript',text:inlineText}}],ziele:[],variablen:[],ungeklaert:['fixture-inline'],sicher_aufloesbar:false};
  const gitLage = {os:'linux',cwd:root,project_root:root,hash:'fixture-git',shell:'sh',kommandos:[{argv:[{raw:'git',text:'git',dynamisch:false},{raw:'apply',text:'apply',dynamisch:false},{raw:'--cached',text:'--cached',dynamisch:false}]}],ziele:[],variablen:[],ungeklaert:['fixture-index'],sicher_aufloesbar:false};
  for (const [name,status,command,output,lage] of [
    ['done','done','printf T51_GOLDEN','T51_GOLDEN\nZeile zwei\n',null],
    ['inline','rejected',inlineCommand,null,inlineLage],
    ['git','rejected','git apply --cached',null,gitLage],
    ['running','running','printf T51_RUNNING',null,null],
  ]) {
    const sicherung=lage?{lage,audit:{agent_id:agent,entscheidung:'anleitung',created_at:stamp},antwort:{success:false,ausgefuehrt:false,stufe:'anleitung',lage,risiko:'Fester Testfall',bestaetigungsdaten:{lage_hash:lage.hash,befehl_hash:createHash('sha256').update(command).digest('hex'),regelversion:'fixture'}}}:null;
    await pool.query('INSERT INTO shell_jobs(id,project,agent_id,command,status,exit_code,output,tail,output_size,output_truncated,sicherung,exec_key,created_at,updated_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,0,false,$9::jsonb,$10,$11,$11,$12)',[ids[name],project,agent,command,status,status==='done'?0:null,output,output?JSON.stringify(['Zeile zwei']):null,sicherung?JSON.stringify(sicherung):null,'fixture-exec-key',stamp,status==='running'?null:stamp]);
  }
  const thoughtA='goldenAlpha '+ 'Erhaltener Gedankeninhalt. '.repeat(20);
  await pool.query('INSERT INTO thoughts(id,project,source,content,tags,timestamp) VALUES($1,$2,$3,$4,$5,$6),($7,$2,$3,$8,$5,$6)',[ids.thoughtA,project,agent,thoughtA,['fixture'],stamp,ids.thoughtB,'goldenAlpha zweiter Treffer']);
  await pool.query('INSERT INTO plans(id,project,name,description,goals,tasks,kurz_id,aktiv,prioritaet) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,true,$8)',[ids.plan,project,'Golden-Plan','Fester Plantext',[],JSON.stringify([{id:ids.task,title:'Golden-Task',description:'Bleibt erhalten',status:'todo',priority:'high',kurz_id:'P1-T1'}]),'P1','hoch']);
  await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size,chunk_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0)',[ids.file,project,'src/golden.ts','golden.ts','ts',code,createHash('sha256').update(code).digest('hex'),Buffer.byteLength(code)]);
  // LIKE kopiert keine FTS-Trigger: Suchvektoren ausschließlich für diese eigene Fixture setzen.
  const writableVectors=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='code_files' AND column_name IN ('tsv','tsv_zerlegt') AND is_generated='NEVER'",[schema])).rows;
  for (const {column_name} of writableVectors) await pool.query('UPDATE code_files SET '+column_name+"=to_tsvector('english',content) WHERE project=$1",[project]);
  const batch = await import('../dist/services/file-batch.js');
  const planned = await batch.planBatch({project,agent_id:agent,task_id:'P1-T1',ops:[{action:'search_replace',file_path:'src/golden.ts',search:'42',replace:'43',reason:'Eigene Golden-Fixture'}]});
  assert(planned.plan_id,'Golden-Plan angelegt'); aliases.set(String(planned.plan_id),'<BATCH_ID>');
  const channel = (await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('golden',$1,$2) RETURNING id",[project,agent])).rows[0];
  aliases.set(String(channel.id),'<CHANNEL_ID>');
  const msg=(await pool.query('INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,$2,$3) RETURNING id',[channel.id,agent,'goldenAlpha Nachricht'])).rows[0]; aliases.set(String(msg.id),'<MESSAGE_ID>');
  const requireRest=createRequire(new URL('../../rest-api/package.json',import.meta.url));
  const Fastify=requireRest('fastify'); const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
  app=Fastify({logger:false}); await app.register(mcpRoutes); await app.ready();
  const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const serverPath=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url));
  const transportPath=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
  const childCode='const {createServer}=await import('+JSON.stringify(serverPath)+');const {StdioServerTransport}=await import('+JSON.stringify(transportPath)+');await createServer().connect(new StdioServerTransport());';
  const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string'));
  Object.assign(env,{SYNAPSE_DATABASE_URL:db.toString(),SYNAPSE_PROJECT:project,SYNAPSE_TEST_STREAM_HOME:root});
  delete env.SYNAPSE_AGENT_NAME;
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',fileURLToPath(new URL('./_helfer/fixture-test-home.mjs',import.meta.url)),'--input-type=module','--eval',childCode],cwd:fileURLToPath(new URL('../../../',import.meta.url)),env,stderr:'pipe'});
  transport.stderr?.resume(); client=new Client({name:'t51-golden',version:'1'}); await client.connect(transport);
  for (const name of ['done','inline','git','running']) await both('shell-get-'+name,'shell',{action:'get',id:ids[name]});
  await both('shell-history','shell',{action:'history',limit:4});
  await both('files-plan-status','files',{action:'plan_status',plan_id:planned.plan_id});
  await both('plan-get','plan',{action:'get',plan_id:'P1',compact:false});
  await both('thought-get','thought',{action:'get',id:ids.thoughtA});
  await both('thought-search','thought',{action:'search',query:'goldenAlpha',limit:2});
  assert.equal(records['thought-search'].rest.result.length,2,'Zwei echte Fixture-Treffer');
  await both('channel-feed','channel',{action:'feed',channel_name:'golden',limit:5});
  await both('channel-feed-empty','channel',{action:'feed',channel_name:'golden',since_id:Number(msg.id),limit:5});
  await both('code-search-one','code_intel',{action:'search',query:'goldenAlpha',limit:5});
  await both('code-search-two','code_intel',{action:'search',query:'goldenAlpha goldenBeta',limit:5});
  assert(records['code-search-one'].rest.results.length>0,'Einwort-Suche hat echten Treffer');
  assert(records['code-search-two'].rest.results.length>0,'Zweiwort-Suche hat echten Treffer');
  if(process.argv.includes('--check-t55'))for(const label of ['shell-get-done','shell-get-running','channel-feed','channel-feed-empty']){
    const row=records[label];console.log('T55_MESSUNG '+JSON.stringify({label,restText:row.restTextChars,stdioText:row.stdioTextChars}));
  }
  const baseline={task:'P10-T51',captured_before:'K1-K4/E1/N2/N3',normalization:'Zeit/IDs/Root und explizite Wrapper; Inhalte bleiben',records};
  if (capture) console.log('T51_GOLDEN_JSON '+JSON.stringify(baseline));
  else if (checkK1) {
    for (const mode of ['rest','stdio']) {
      let payload=records['shell-get-done'][mode];
      while(payload?.content?.[0]?.text) payload=JSON.parse(payload.content[0].text);
      assert.equal(Object.hasOwn(payload.job,'exec_key'),false,mode+': interner Exec-Key nicht ausliefern');
      assert.equal(Object.hasOwn(payload.job,'tail'),false,mode+': keine doppelte Ausgabe');
      assert.equal(payload.job.output_size,Buffer.byteLength(payload.job.output),mode+': echte Ausgabegröße');
      let denied=records['shell-get-inline'][mode];
      while(denied?.content?.[0]?.text) denied=JSON.parse(denied.content[0].text);
      assert.equal(Object.hasOwn(denied.job.sicherung.antwort,'lage'),false,mode+': keine doppelte Lage');
    }
    console.log('P10-T51 K1 grün: beide echte Transporte');
  } else if(process.argv.includes('--check-t55')) {
    for(const label of ['shell-get-done','shell-get-running','channel-feed','channel-feed-empty'])assert(!Object.hasOwn(records[label].stdio,'content'),label+': keine innere stdio-Hülle');
    assert.deepEqual(records['shell-get-done'].stdio,records['shell-get-done'].rest);
    assert.equal(records['shell-get-running'].stdio.job.exit_code,null);
    assert.deepEqual(records['channel-feed-empty'].stdio.messages,[]);assert.equal(records['channel-feed-empty'].stdio.count,0);
    console.log('P10-T55 echte REST/stdio-Probe grün.');
  } else {
    const old=JSON.parse(await readFile(new URL('./fixtures/tool-antwort-p10-t51-alt.json',import.meta.url),'utf8'));
    for (const [label,row] of Object.entries(records)) for (const mode of ['rest','stdio']) {
      if(verifyOld) assert.deepEqual(row[mode],old.records[label][mode],label+' '+mode+': Altstand deterministisch');
      else {
        const expected=approvedChange(old.records[label][mode],label,mode);
        assert.deepEqual(row[mode],expected,label+' '+mode+': nur ausdrücklich freigegebene Änderungen');
      }
    }
    for(const [label,row]of Object.entries(records))console.log('T51_MESSUNG '+JSON.stringify({label,restAltText:old.records[label].restTextChars,restNeuText:row.restTextChars,stdioAltText:old.records[label].stdioTextChars,stdioNeuText:row.stdioTextChars,restAltStruktur:JSON.stringify(old.records[label].rest).length,restNeuStruktur:JSON.stringify(row.rest).length}));
    console.log('P10-T51 Golden '+(verifyOld?'ALTSTAND':'NEU')+' grün: '+Object.keys(records).length+' Fälle × REST/stdio');
    if(!verifyOld){
      const plain=p=>{while(p?.content?.[0]?.text)p=JSON.parse(p.content[0].text);return p;};
      await both('shell-full-inline','shell',{action:'get',id:ids.inline,detail:'full'});
      for(const mode of ['rest','stdio']){
        const full=plain(records['shell-full-inline'][mode]);
        assert.deepEqual(full.job.sicherung,old.records['shell-get-inline'].rest.job.sicherung,'Vollabruf bewahrt gesamte maskierte Sicherung');
        assert.equal(Object.hasOwn(full.job,'exec_key'),false);
      }
      await both('thought-search-full','thought',{action:'search',query:'goldenAlpha',limit:2,volltext:true});
      assert.deepEqual(records['thought-search-full'].rest.result,old.records['thought-search'].rest.result,'Volltextabruf erhält beide Gedanken unverändert');
      const waitCode='export const waitValue = 1;'+String.fromCharCode(10);
      await writeFile(join(root,'src','wait.ts'),waitCode);
      await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size,chunk_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0)',[randomUUID(),project,'src/wait.ts','wait.ts','ts',waitCode,createHash('sha256').update(waitCode).digest('hex'),Buffer.byteLength(waitCode)]);
      const reservations=await import('../dist/services/file-reservations.js');
      await reservations.addFileReservations({project,agentId:agent+'-owner',filePaths:['src/wait.ts']});
      const carrier=await batch.planBatch({project,agent_id:agent,ops:[{action:'search_replace',file_path:'src/wait.ts',search:'1',replace:'2'}]});
      const wait=carrier.coedit_waits?.[0];
      assert(wait&&!wait.target_plan_id,'Eigener Co-Edit-Wait ohne Ziel');
      assert.match(wait.handlungsanweisung,/Kein Zielplan vorhanden/);
      aliases.set(String(carrier.plan_id),'<CARRIER_ID>');
      aliases.set(wait.wait_token,'<WAIT_TOKEN>');
      await both('wait-no-target','files',{action:'plan_status',plan_id:carrier.plan_id});
      assert(records['wait-no-target'].rest.coedit_waits?.some(w=>!w.target_plan_id),'Wait ohne Ziel über echte REST-/stdio-Antwort');
      console.log('P10-T51 Zusatzprobe: voller Shell-/Thought-Abruf, leerer Feed und Co-Edit-Wait ohne Ziel grün.');
      if(process.argv.includes('--codex-probe')){
        await app.listen({host:'127.0.0.1',port:0});
        const api='http://127.0.0.1:'+app.server.address().port+'/';
        const codexHome=join(root,'codex-home');await mkdir(codexHome);
        await symlink(join(homedir(),'.codex','auth.json'),join(codexHome,'auth.json'));
        await writeFile(join(codexHome,'config.toml'),['[mcp_servers.t51]','url = '+JSON.stringify(api),'enabled_tools = ["shell","files","channel","thought"]','default_tools_approval_mode = "approve"','startup_timeout_sec = 30','tool_timeout_sec = 30',''].join(String.fromCharCode(10)));
        const prompt='Du bist '+agent+'. Ausschließlich MCP t51 benutzen, keine eingebauten Shell-/Dateiwerkzeuge. Projekt '+project+'. Prüfe mit agent_id '+agent+' genau: shell get id '+ids.running+' (laufend, exit_code:null), files plan_status plan_id '+carrier.plan_id+' (Co-Edit-Wait ohne Ziel), channel feed channel_name golden since_id '+msg.id+' (leere Nachrichtenliste), thought search query goldenAlpha limit 2 einmal ohne volltext und einmal volltext:true. Berichte die fünf Ergebnisse knapp. Keine Writes oder weiteren Aktionen.';
        const cli='/home/blacky/.local/share/mise/installs/node/25.8.1/bin/codex';
        const child=spawn(cli,['exec','--ephemeral','--json','--skip-git-repo-check','--sandbox','read-only',prompt],{cwd:root,env:{...env,CODEX_HOME:codexHome},stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
        const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
        const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code)=>resolve(code));});clearTimeout(timer);
        await writeFile(join(root,'codex-probe.jsonl'),stdout);
        const events=stdout.split(String.fromCharCode(10)).filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
        const calls=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>({server:e.item.server,tool:e.item.tool,arguments:e.item.arguments,status:e.item.status,error:e.item.error}));
        const final=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item?.text;
        console.log('T51_CODEX '+JSON.stringify({exit,calls,final,stderrTail:stderr.slice(-600)}));
        assert.equal(exit,0,'Echter Codex-Client erfolgreich');
        for(const tool of ['shell','files','channel'])assert(calls.some(c=>c.tool===tool&&c.status==='completed'&&!c.error),'Codex rief '+tool+' tatsächlich auf');
        assert(calls.filter(c=>c.tool==='thought'&&c.status==='completed'&&!c.error).length>=2,'Codex rief beide Thought-Suchvarianten auf');
      }
    }
  }
} finally {
  await client?.close();
  await app?.close();
  if (pool) {
    if(schemaCreated) await pool.query('DROP SCHEMA "'+schema+'" CASCADE');
    await pool.end();
  }
  if(mock) await new Promise(resolve=>mock.close(resolve));
  await cleanup.cleanup(); cleanup.dispose();
}
process.exit(0);
