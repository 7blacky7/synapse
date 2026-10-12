/** P6-T27: Golden am Altstand, isolierte Ghost-Lebenszyklus-Abnahme. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
const ci = await import('../dist/services/code-intel.js');
const db = await import('../dist/db/client.js');
const cw = await import('../dist/services/code-write.js');
const pool = db.getPool();
const project = 'test-p6-t27-' + randomUUID();
const hash = text => createHash('sha256').update(text).digest('hex');
const basis = 'export function golden(){ return 1; }\n';
const normal = value => JSON.parse(JSON.stringify(value, (k,v) =>
 k === 'project' && v === project ? '<projekt>' : typeof v === 'string' ? v.replaceAll(project, '<projekt>') : v));
try {
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project,'p6-t27-test','/tmp/p6-t27-fixture']);
 await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',[randomUUID(),project,'basis.ts','ts',Buffer.byteLength(basis),basis,hash(basis)]);
 const golden = normal({
  file: await ci.getFileContent(project,'basis.ts'),
  tree: await ci.getProjectTree(project,{show_assets:false}),
  search: await ci.fullTextSearchCode(project,'golden')
 });
 if(process.argv.includes('--capture')) {
  console.log('GOLDEN_JSON=' + JSON.stringify(golden));
 } else {
  assert.deepEqual(golden, JSON.parse(readFileSync(new URL('./fixtures/code-intel-schatten-p6-t27.golden.json',import.meta.url),'utf8')));
  console.log('OK Golden file/tree/search am unveränderten Standardweg');
  if(!process.argv.includes('--golden')) {
   const core = await import('../dist/index.js');
   assert.equal(typeof core.mitCodeIntelSchatten, 'function', 'RED: Ghost-Overlay fehlt');
   const ghost = await import('../dist/services/code-intel-schatten.js');
   const fb = await import('../dist/services/file-batch.js');
   const task = randomUUID();
   await pool.query('INSERT INTO plans(id,project,name,kurz_id,tasks) VALUES($1,$2,$3,$4,$5::jsonb)',
    [randomUUID(),project,'Ghost-Abnahme','P6',JSON.stringify([{id:task,title:'Ghost',status:'todo',kurz_id:'P6-T27'}])]);
   const plan = async (ops, expected={}) => (await pool.query(
    "INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,expires_at) VALUES($1,$2,$3::jsonb,$4::jsonb,'[]'::jsonb,'open',NOW()+INTERVAL '1 day') RETURNING id::text",
    [project,'sol-1-test',JSON.stringify(ops.map(op=>({...op,task_id:task}))),JSON.stringify(expected)])).rows[0].id;
   const caller = 'pending();\n';
   await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',[randomUUID(),project,'caller.ts','ts',Buffer.byteLength(caller),caller,hash(caller)]);
   await pool.query("INSERT INTO code_call_edges(project,file_path,callee_name,line_number,call_kind) VALUES($1,'caller.ts','pending',1,'function')",[project]);
   const pending = 'export function pending(){ return golden(); }\n';
   const id = await plan([
    {action:'create',file_path:'neu/tief/pending.ts',content:pending,agent_id:'eins'},
    {action:'search_replace',file_path:'neu/tief/pending.ts',search:'return golden()',replace:'return golden() + 2',agent_id:'zwei'},
    {action:'copy',file_path:'basis.ts',new_path:'kopie/golden.ts',agent_id:'eins'}
   ], {'basis.ts':hash(basis)});
   const run = (action,args={}) => core.mitCodeIntelSchatten(action,{project,schatten:id,...args},async()=>{throw Error('Ghost muss eigenen Nur-Lese-Weg nutzen');});
   const before = (await pool.query('SELECT file_path,content,content_hash FROM code_files WHERE project=$1 ORDER BY file_path',[project])).rows;
   assert.equal((await run('file',{file_path:'pending.ts'})).content,'export function pending(){ return golden() + 2; }\n');
   assert.equal((await run('file',{file_path:'pending.ts',stand_nach_op:0})).content,pending);
   const fun = await run('functions',{name:'pending'});
   assert.equal(fun.functions.length,1); assert.equal(fun.functions[0].schatten,true); assert.equal(fun.functions[0].plan_id,id);
   assert.equal((await run('symbols',{symbol_type:'function',name:'pending'})).symbols.length,1);
   assert((await run('statements',{file_path:'pending.ts'})).statements.length>0);
   assert((await run('calls',{callee:'golden'})).calls.some(c=>c.file_path==='neu/tief/pending.ts'));
   assert((await run('search',{query:'pending'})).results.some(r=>r.file_path==='neu/tief/pending.ts'));
   const tree = await run('tree',{show_ghosts:true});
   assert.match(tree.tree,/\[g\] neu\//); assert.match(tree.tree,/\[g\] neu\/tief\//); assert.match(tree.tree,/\[g\] pending.ts/); assert.match(tree.tree,/\[g\] kopie\//);
   assert.equal(await core.mitCodeIntelSchatten('tree',{project,show_ghosts:false},async()=> 'identisch'),'identisch');
   const refs = await run('references',{name:'pending'});
   assert.equal(refs.definition.file_path,'neu/tief/pending.ts');
   assert(refs.references.some(r=>r.file_path==='caller.ts'),'unveränderter Aufrufer bleibt im Overlay sichtbar');
   assert.equal(refs.references.find(r=>r.file_path==='caller.ts').schatten,undefined);
   if(process.argv.includes('--strecken')) {
    const {handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
    const {codeIntelTool}=await import('../../mcp-server/dist/tools/consolidated/code-intel.js');
    for(const param of ['schatten','stand_nach_op','show_ghosts']) assert(param in codeIntelTool.definition.inputSchema.properties);
    const cases=[
     ['file',{file_path:'pending.ts'}],['functions',{name:'pending'}],['symbols',{symbol_type:'function',name:'pending'}],
     ['references',{name:'pending'}],['search',{query:'pending'}],['statements',{file_path:'pending.ts'}],
     ['calls',{callee:'golden'}],['tree',{show_ghosts:true}]
    ];
    for(const [action,extra]of cases){
     const args={action,project,schatten:id,...extra};
     const a=await codeIntelTool.handler(args), b=await handleToolCall('code_intel',args);
     assert.equal(a.success,true,action+' stdio'); assert.equal(b.success,true,action+' REST');
     assert.deepEqual(a,b,action+' beide Dispatcher identisch');
    }
    for(const handler of [codeIntelTool.handler,args=>handleToolCall('code_intel',args)]){
     assert.deepEqual(normal(await handler({action:'file',project,file_path:'basis.ts'})),{success:true,...golden.file,project:'<projekt>'});
    }
    console.log('OK Stdio/REST: acht Actions, gleiche Schatten-Ausgabe, Default-file Golden unverändert');
   }
   const first = ghost.schattenCacheStatistik();
   await run('functions'); assert(ghost.schattenCacheStatistik().treffer>first.treffer);
   await pool.query("UPDATE file_batch_plans SET ops=ops || $2::jsonb WHERE id=$1",
    [id,JSON.stringify([{action:'search_replace',file_path:'neu/tief/pending.ts',search:'+ 2',replace:'+ 3',agent_id:'drei'}])]);
   assert.match((await run('file',{file_path:'pending.ts'})).content,/\+ 3/);
   await pool.query("UPDATE file_batch_plans SET ops=ops - 3 WHERE id=$1",[id]);
   assert.match((await run('file',{file_path:'pending.ts'})).content,/\+ 2/);
   const move = await plan([{action:'move',file_path:'basis.ts',new_path:'umzug/basis.ts'}],{'basis.ts':hash(basis)});
   const moved = await core.mitCodeIntelSchatten('file',{project,schatten:move,file_path:'basis.ts'},async()=>null);
   assert.equal(moved.file_path,'umzug/basis.ts');
   assert.match((await core.mitCodeIntelSchatten('tree',{project,schatten:move,show_ghosts:true},async()=>null)).tree,/\[g\] umzug\//);
   const secrets = await plan([{action:'create',file_path:'.env.example',content:'PASSWORD=geheim123\n'},{action:'create',file_path:'.mcp.json.backup',content:'{"mcpServers":{"s":{"env":{"API_KEY":"geheim123"}}}}'}]);
   for(const file_path of ['.env.example','.mcp.json.backup']){
    const r=await core.mitCodeIntelSchatten('file',{project,schatten:secrets,file_path},async()=>null);
    assert(!JSON.stringify(r).includes('geheim123')); assert.match(r.content,/\[WERT\]/);
   }
   assert.deepEqual((await pool.query('SELECT file_path,content,content_hash FROM code_files WHERE project=$1 ORDER BY file_path',[project])).rows,before);
   assert.equal((await run('search',{query:'pending',semantic:true})).success,false);
   const concurrent=await Promise.all([run('functions',{name:'pending'}),ci.getFunctions(project,undefined,'pending')]);
   assert.equal(concurrent[0].functions.length,1); assert.equal(concurrent[1].length,0,'Lesekontext bleibt auf Anfrage beschränkt');
   await pool.query("UPDATE file_batch_plans SET status='committed' WHERE id=$1",[id]);
   assert.equal((await run('file',{file_path:'pending.ts'})).success,false);
   await pool.query("UPDATE file_batch_plans SET status='cancelled' WHERE id=$1",[move]);
   assert.equal((await core.mitCodeIntelSchatten('file',{project,schatten:move,file_path:'basis.ts'},async()=>null)).success,false);
   assert.equal((await core.mitCodeIntelSchatten('file',{project:project+'-fremd',schatten:secrets,file_path:'.env.example'},async()=>null)).success,false);
   const alle=await core.mitCodeIntelSchatten('functions',{project,schatten:'alle',name:'pending'},async()=>null);
   assert(alle.staende.length>=1);
   const invalid=await core.mitCodeIntelSchatten('file',{project,schatten:secrets,stand_nach_op:-1,file_path:'.env.example'},async()=>null);
   assert.equal(invalid.success,false);
   const kaputt=await plan([{action:'create',file_path:'kaputt/a.ts',content:'export function ok(){}'},
    {action:'search_replace',file_path:'kaputt/a.ts',search:'fehlt',replace:'x'}]);
   const kaputtResult=await core.mitCodeIntelSchatten('file',{project,schatten:kaputt,file_path:'kaputt/a.ts'},async()=>null);
   assert.equal(kaputtResult.content,'export function ok(){}'); assert.equal(kaputtResult.nicht_anwendbar.length,1);
   const echt=await fb.planBatch({project,agent_id:'sol-1-test',task_id:'P6-T27',
    ops:[{action:'create',file_path:'api/lifecycle.ts',content:'export function lifecycle(){return 1;}'}]});
   const apiRun=()=>core.mitCodeIntelSchatten('file',{project,schatten:echt.plan_id,file_path:'api/lifecycle.ts'},async()=>null);
   assert.match((await apiRun()).content,/return 1/);
   await fb.replanBatch({project,plan_id:echt.plan_id,agent_id:'sol-1-test',op_index:0,
    ops:[{action:'create',file_path:'api/lifecycle.ts',content:'export function lifecycle(){return 2;}',task_id:task}]});
   assert.match((await apiRun()).content,/return 2/);
   assert.equal((await fb.cancelBatch(echt.plan_id,'sol-1-test','Ghost-Abnahme abgeschlossen')).ok,true);
   assert.equal((await apiRun()).success,false);
   const driftPlan=await plan([{action:'copy',file_path:'basis.ts',new_path:'drift/basis.ts'}],{'basis.ts':hash(basis)});
   const driftRun=()=>core.mitCodeIntelSchatten('file',{project,schatten:driftPlan,file_path:'drift/basis.ts'},async()=>null);
   assert.equal((await driftRun()).content,basis);
   await pool.query('UPDATE code_files SET content=$3,content_hash=$4 WHERE project=$1 AND file_path=$2',[project,'basis.ts',basis+'// Drift',hash(basis+'// Drift')]);
   const drift=await driftRun(); assert(drift.drift?.length); assert.match(drift.content,/Drift/);
   await pool.query('UPDATE code_files SET content=$3,content_hash=$4 WHERE project=$1 AND file_path=$2',[project,'basis.ts',basis,hash(basis)]);
   const shared=await plan([{action:'create',file_path:'shared/withdraw.ts',content:'export function shared(){return 1;}',agent_id:'eins'},
    {action:'search_replace',file_path:'shared/withdraw.ts',search:'return 1',replace:'return 2',agent_id:'zwei'}]);
   const sharedRun=()=>core.mitCodeIntelSchatten('file',{project,schatten:shared,file_path:'shared/withdraw.ts'},async()=>null);
   assert.match((await sharedRun()).content,/return 2/);
   const withdrawal=await fb.cancelBatch(shared,'zwei','Eigenen zweiten Beitrag zurückziehen');
   assert.equal(withdrawal.mode,'withdrawn');
   assert.match((await sharedRun()).content,/return 1/);
   assert.equal((await fb.cancelBatch(shared,'eins','Verbleibenden eigenen Beitrag zurückziehen')).ok,true);
   assert.equal((await sharedRun()).success,false);
   const big = readFileSync(new URL('../src/services/file-batch.ts',import.meta.url),'utf8');
   const bigId = await plan([{action:'create',file_path:'gross/file-batch.ts',content:big}]);
   const start = performance.now();
   const cold = await core.mitCodeIntelSchatten('functions',{project,schatten:bigId,file_path:'gross/file-batch.ts'},async()=>null);
   const coldMs = performance.now()-start;
   const warmStart = performance.now();
   const warm = await core.mitCodeIntelSchatten('functions',{project,schatten:bigId,file_path:'gross/file-batch.ts'},async()=>null);
   assert.equal(cold.success,true); assert.equal(warm.functions.length,cold.functions.length);
   console.log('BENCH '+JSON.stringify({zeilen:big.split('\n').length,parse_ms:cold.schatten_parse_ms,kalt_ms:coldMs,warm_ms:performance.now()-warmStart,funktionen:cold.functions.length}));
   console.log('OK Ghost: Ops/Co-Edit, sieben Actions, Cache/Invalidierung, Zwischenstand, neue Ordner inkl. copy/move, Maskierung, keine Indexmutation');
  }
 }
} finally { await db.closePool(); }

process.exit(0); // Nur nach vollständig erfolgreichem Test; importierte Hintergrund-Timer sind kein Testziel.
