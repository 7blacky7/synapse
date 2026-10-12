/** P6-T27: reproduzierbare Laufzeitgrenze am grossen Testindex; nur synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
process.env.QDRANT_URL='http://127.0.0.1:9';
process.env.OLLAMA_URL='http://127.0.0.1:9';
const {getPool,closePool}=await import('../dist/db/client.js');
const {mitCodeIntelSchatten}=await import('../dist/services/code-intel-schatten.js');
const ci=await import('../dist/services/code-intel.js');
const pool=getPool(), query=pool.query.bind(pool);
const project='test-p6-t27-perf-'+randomUUID(), fremd=project+'-anderes';
const measure=process.argv.includes('--measure');
const crossOnly=process.argv.includes('--cross-only');
const erklaere=process.argv.includes('--explain');
let erklaert=false;
pool.query=async(sql,values)=>{
 if(erklaere && !erklaert && typeof sql==='string' && sql.includes('_synapse_ghost_') && sql.includes('usage_count')){
  erklaert=true;
  const plan=(await query('EXPLAIN (FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0].Plan;
  const nodes=[];
  const walk=n=>{if(['CTE Scan','Seq Scan','Function Scan','Nested Loop','Hash Join'].includes(n['Node Type']))nodes.push({node:n['Node Type'],relation:n['Relation Name'],cte:n['CTE Name'],rows:n['Plan Rows'],cost:n['Total Cost'],filter:n.Filter,join:n['Join Filter']});for(const child of n.Plans??[])walk(child);};
  walk(plan);console.log('EXPLAIN '+JSON.stringify({cost:plan['Total Cost'],nodes}));
 }
 return query(sql,values);
};
try {
 assert.equal((await query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
 // Gleiches Projekt UND ein fremdes Testprojekt: globale Scans dürfen beide nicht materialisieren.
 for(const p of [project,fremd]){
  await query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[p,'perf-test','/tmp/p6-perf-fixture']);
  if(!crossOnly) await query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,file_size,content_hash) SELECT $1||':file:'||i,$1,'bulk/'||i||'.ts',i||'.ts','ts','export function bulk'||i||'(){ return 0; }',40,md5(i::text) FROM generate_series(1,4000) i",[p]);
  if(!crossOnly) await query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) SELECT $1||':sym:'||i,$1,'bulk/'||(1+(i%4000))||'.ts','function','bulk'||i,1,true FROM generate_series(1,24000) i",[p]);
  if(!crossOnly) await query("INSERT INTO code_references(id,project,file_path,symbol_id,line_number,context) SELECT $1||':ref:'||i,$1,'bulk/'||(1+(i%4000))||'.ts',$1||':sym:'||(1+(i%24000)),1,'bulk call' FROM generate_series(1,120000) i",[p]);
  if(!crossOnly) await query("INSERT INTO code_call_edges(project,file_path,callee_name,target_symbol_id,line_number,call_kind) SELECT $1,'bulk/'||(1+(i%4000))||'.ts','bulk'||(1+(i%24000)),$1||':sym:'||(1+(i%24000)),1,'function' FROM generate_series(1,24000) i",[p]);
 }
 for(const table of ['code_files','code_symbols','code_references','code_call_edges']) await query('ANALYZE '+table);
 // Ein echter committed Aufrufer auf eine im Schatten geänderte Definition prüft Umleitung.
 const text='export function existingProbe(){ return 1; }\n';
 const hash=createHash('sha256').update(text).digest('hex');
 await query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,file_size,content_hash) VALUES($1,$2,'existing.ts','existing.ts','ts',$3,$4,$5)",[project+':existing-file',project,text,Buffer.byteLength(text),hash]);
 await query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) VALUES($1,$2,'existing.ts','function','existingProbe',1,true)",[project+':existing',project]);
 await query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,file_size,content_hash) VALUES($1,$2,'bulk/caller.ts','caller.ts','ts','existingProbe();',16,'fixture')",[project+':caller-file',project]);
 await query("INSERT INTO code_references(id,project,file_path,symbol_id,line_number,context) VALUES($1,$2,'bulk/caller.ts',$3,1,'existingProbe()')",[project+':caller-ref',project,project+':existing']);
 await query("INSERT INTO code_call_edges(project,file_path,callee_name,target_symbol_id,line_number,call_kind) VALUES($1,'bulk/caller.ts','existingProbe',$2,1,'function')",[project,project+':existing']);
 const realText='\n'.repeat(160)+'export function realProbe(){ return 3; }\n';
 for(const [file,content]of [['module.ts',realText],['barrel.ts',"export { realProbe } from './module.js';"],['barrel-outer.ts',"export { realProbe } from './barrel.js';"],['other.ts','\n'.repeat(200)+'export function realProbe(){ return 7; }']]) await query(
  'INSERT INTO code_files(id,project,file_path,file_name,file_type,content,file_size,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',
  [project+':'+file,project,file,'ts',content,Buffer.byteLength(content),createHash('sha256').update(content).digest('hex')]);
 await query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported,value) VALUES($1,$2,'barrel-outer.ts','export','realProbe',24,true,'./barrel.js')",[project+':reexport-outer',project]);
 await query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) VALUES($1,$2,'other.ts','function','realProbe',201,true)",[project+':other-real',project]);
 // Re-export vor echter Definition: Reihenfolge darf Zielwahl nicht beeinflussen.
 await query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported,value) VALUES($1,$2,'barrel.ts','export','realProbe',23,true,'./module.js')",[project+':reexport',project]);
 await query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) VALUES($1,$2,'module.ts','function','realProbe',161,true)",[project+':real',project]);
 const ops=[{action:'create',file_path:'zz-ghost/neu.ts',content:"import { realProbe } from '../module.js';\nexport function ghostProbe(x:number){ return realProbe()+existingProbe()+x; }\n"},
 {action:'create',file_path:'zz-ghost/barrel-user.ts',content:"import { realProbe } from '../barrel-outer.js';\nexport function barrelUser(){ return realProbe(); }\n"},
 {action:'search_replace',file_path:'existing.ts',search:'return 1',replace:'return realProbe()'},
 {action:'insert_after',file_path:'existing.ts',after_line:0,content:"import { realProbe } from './module.js';",shift_mode:'absolute'}];
 const id=(await query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,expires_at) VALUES($1,'sol-1-perf',$2::jsonb,$3::jsonb,'[]','open',NOW()+INTERVAL '1 day') RETURNING id::text",[project,JSON.stringify(ops),JSON.stringify({'existing.ts':hash})])).rows[0].id;
 const run=(action,args)=>mitCodeIntelSchatten(action,{project,schatten:id,...args},async()=>{throw Error('kein Schatten');});
 {
  const ref=await run('references',{name:'realProbe'});
  const calls=await run('calls',{file_path:'zz-ghost/neu.ts',callee:'realProbe'});
  console.log('CROSS '+JSON.stringify({definition:ref.definition,targets:calls.calls?.map(c=>c.target_symbol_id)}));
  assert.equal(ref.definition.id,project+':real','echte Definition vor Ghost-Import und Re-export');
  assert.equal(calls.calls[0].target_symbol_id,project+':real','Ghost-Aufruf zeigt auf dieselbe echte Funktion');
  assert(ref.references.some(r=>r.file_path==='zz-ghost/neu.ts'&&r.symbol_id===project+':real'));
  assert(ref.references.some(r=>r.file_path==='existing.ts'&&r.symbol_id===project+':real'),'neuer Aufruf in Ghost-update der bestehenden Datei');
  const changedCalls=await run('calls',{file_path:'existing.ts',callee:'realProbe'});
  assert.equal(changedCalls.calls[0].target_symbol_id,project+':real');
  const viaBarrel=await run('calls',{file_path:'zz-ghost/barrel-user.ts',callee:'realProbe'});
  assert.equal(viaBarrel.calls[0].target_symbol_id,project+':real','zweistufiger Re-export folgt Importpfad trotz gleichnamiger anderer Definition');
  assert(ref.references.some(r=>r.file_path==='zz-ghost/barrel-user.ts'&&r.symbol_id===project+':real'));
  const back=await run('references',{name:'existingProbe'});
  const backCalls=await run('calls',{file_path:'bulk/caller.ts',callee:'existingProbe'});
  assert(back.definition.id.startsWith('ghost:'));
  assert(back.references.some(r=>r.file_path==='bulk/caller.ts'&&r.symbol_id===back.definition.id));
  assert.equal(backCalls.calls[0].target_symbol_id,back.definition.id,'Bestand->Ghost uses same target as definition');
  // Die andere gleichnamige Deklaration steht nun früher: Importpfad entscheidet die Definition.
  await query('UPDATE code_symbols SET line_start=1 WHERE id=$1',[project+':other-real']);
  assert.equal((await run('references',{name:'realProbe'})).definition.id,project+':real');
  // Re-export-Zyklus darf nicht auf das andere Modul oder in eine Endlosschleife fallen.
  await query("UPDATE code_symbols SET value='./barrel-outer.js' WHERE id=$1",[project+':reexport']);
  assert.equal((await run('calls',{file_path:'zz-ghost/barrel-user.ts',callee:'realProbe'})).calls[0].target_symbol_id,null);
  await query("UPDATE code_symbols SET value='./module.js' WHERE id=$1",[project+':reexport']);
  assert.equal((await run('calls',{file_path:'zz-ghost/barrel-user.ts',callee:'realProbe'})).calls[0].target_symbol_id,project+':real');
  await query('UPDATE code_symbols SET id=$2 WHERE id=$1',[project+':real',project+':real-neu']);
  const freshRef=await run('references',{name:'realProbe'});
  const freshCall=await run('calls',{file_path:'zz-ghost/neu.ts',callee:'realProbe'});
  assert.equal(freshRef.definition.id,project+':real-neu');
  assert.equal(freshCall.calls[0].target_symbol_id,freshRef.definition.id,'Cache muss geänderte Index-Ziel-IDs nachziehen');


 }
 // Cache gezielt vor der Functions-Messung füllen: der Befund betrifft warme SQL-Lesewege.
 await run('file',{file_path:'zz-ghost/neu.ts'});
 const cases=[
 ['functions',{file_path:'zz-ghost/neu.ts'}],['functions',{name:'ghostProbe'}],
 ['references',{name:'ghostProbe'}],['references',{name:'existingProbe'}],
 ['calls',{file_path:'zz-ghost/neu.ts'}],['statements',{file_path:'zz-ghost/neu.ts'}],
 ['symbols',{symbol_type:'function',file_path:'zz-ghost/neu.ts'}],
 ['search',{query:'ghostProbe'}],['file',{file_path:'zz-ghost/neu.ts'}],
 ['tree',{path:'zz-ghost',show_ghosts:true,depth:1}]
 ];
 const measurements=[];
 const baseStart=performance.now();await ci.getFunctions(project,'zz-ghost/neu.ts');
 console.log('BASE functions '+(performance.now()-baseStart).toFixed(1)+' ms');
 for(const [action,args]of (crossOnly?[]:cases)){
  const start=performance.now(), result=await run(action,args), ms=performance.now()-start;
  assert.equal(result.success,true,action+' funktional');
  if(action==='functions')assert(result.functions.some(f=>f.name==='ghostProbe'));
  if(action==='references'&&args.name==='existingProbe'){
   assert(result.definition.id.startsWith('ghost:'));
   assert(result.references.some(r=>r.file_path==='bulk/caller.ts'),'committed Referenz bleibt an neuer Definition');
  }
  const record={action,args,ms:Math.round(ms*10)/10};
  measurements.push(record);console.log('PERF '+JSON.stringify(record));
  if(!measure)assert(ms<1000,action+' Schatten muss unter 1 s bleiben, ist '+ms.toFixed(1)+' ms');
 }
 console.log('PERF_RESULT '+JSON.stringify({project,n_symbols:crossOnly?5:48005,n_references:crossOnly?1:240001,n_calls:crossOnly?1:48001,measurements}));
} finally {
 // Nur die beiden eigenen Testprojekte; keine fremden Fixtures entfernen.
 for(const p of [project,fremd])for(const table of ['code_references','code_call_edges','code_symbols','code_files','file_batch_plans','projects']){
  await query('DELETE FROM '+table+' WHERE '+(table==='projects'?'name':'project')+'=$1',[p]);
 }
 await closePool();
}
process.exit(0);
