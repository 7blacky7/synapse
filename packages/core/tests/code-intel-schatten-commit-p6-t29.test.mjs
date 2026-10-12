/** P6-T29: Commit-Uebergabe ohne Index-Loch, nur eigene Projekte in synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
process.env.QDRANT_URL='http://127.0.0.1:9';process.env.OLLAMA_URL='http://127.0.0.1:9';
const {getPool,closePool}=await import('../dist/db/client.js');
const {mitCodeIntelSchatten}=await import('../dist/services/code-intel-schatten.js');
const ci=await import('../dist/services/code-intel.js');
const fb=await import('../dist/services/file-batch.js');
const pool=getPool(),project='test-p6-t29-'+randomUUID(),task=randomUUID();
const hash=text=>createHash('sha256').update(text).digest('hex');
const text='export function afterCommit(){ return 29; }\n';
const bestand=async(action,args)=>action==='functions'?{success:true,functions:await ci.getFunctions(project,args.file_path,args.name),project}:
 action==='file'?{success:true,...await ci.getFileContent(project,args.file_path),project}:
 action==='tree'?{success:true,tree:await ci.getProjectTree(project,args),project}:
 action==='search'?{success:true,results:await ci.fullTextSearchCode(project,args.query),project}:null;
const run=(action,args={})=>mitCodeIntelSchatten(action,{project,...args},()=>bestand(action,args));
const plan=async(ops,status='open')=>(await pool.query(
 "INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,expires_at,committed_at) VALUES($1,'sol-1-t29-a',$2::jsonb,$3::jsonb,'[]',$4::text::file_batch_status,NOW()+INTERVAL '1 day',CASE WHEN $4='committed' THEN NOW() ELSE NULL END) RETURNING id::text",
 [project,JSON.stringify(ops.map(op=>({...op,task_id:task}))),JSON.stringify(Object.fromEntries(ops.flatMap(op=>[op.file_path,...(op.new_path?[op.new_path]:[])]).map(file=>[file,hash('')]))),status])).rows[0].id;
const file=async(path,content,ready=false)=>{
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size,updated_at,parsed_at,parser_version) VALUES($1,$2,$3,$3,'ts',$4,$5,$6,NOW()-INTERVAL '1 second',CASE WHEN $7 THEN NOW() ELSE NULL END,CASE WHEN $7 THEN 1 ELSE NULL END) ON CONFLICT(project,file_path) DO UPDATE SET content=$4,content_hash=$5,updated_at=NOW(),parsed_at=NULL",[randomUUID(),project,path,content,hash(content),Buffer.byteLength(content),ready]);
};
try{
 assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t29-test','/tmp/t29-fixture']);
 await pool.query('INSERT INTO plans(id,project,name,kurz_id,tasks) VALUES($1,$2,$3,$4,$5::jsonb)',[randomUUID(),project,'Commit-Test','P6',JSON.stringify([{id:task,kurz_id:'P6-T29',title:'Uebergabe',status:'todo'}])]);
 const id=await plan([{action:'create',file_path:'neu/commit.ts',content:text,agent_id:'sol-1-t29-a'}]);
 assert.equal((await run('functions',{schatten:id,name:'afterCommit'})).functions.length,1);
 // Genau der echte Commit-Zwischenstand: neuer Hash ist da, struktureller Index noch leer.
 await file('neu/commit.ts',text);
 await pool.query("UPDATE file_batch_plans SET status='committed',committed_at=NOW() WHERE id=$1",[id]);
 assert.equal((await ci.getFunctions(project,'neu/commit.ts')).length,0,'Kontrolle: echter Index hat die Luecke');
 const normal=await run('functions',{file_path:'neu/commit.ts'});
 assert.equal(normal.functions.length,1,'RED: Standardsicht darf nach Commit nicht leer sein');
 assert(normal.index_folgt?.length);assert.equal(normal.functions[0].schatten,true);
 const explicit=await run('functions',{schatten:id,file_path:'neu/commit.ts'});
 assert.equal(explicit.functions.length,1);assert.equal(explicit.status,'committet, Index folgt');
 assert.match((await run('tree')).tree,/commit.ts/);
 assert((await run('search',{query:'afterCommit'})).results.some(r=>r.file_path==='neu/commit.ts'));
 // Neuer Modul-Prozess simuliert API-Neustart: Rekonstruktion ohne alten Cache.
 const frisch=await import('../dist/services/code-intel-schatten.js?restart='+randomUUID());
 assert.equal((await frisch.mitCodeIntelSchatten('functions',{project,file_path:'neu/commit.ts'},()=>bestand('functions',{file_path:'neu/commit.ts'}))).functions.length,1);
 await pool.query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) VALUES($1,$2,'neu/commit.ts','function','afterCommit',1,true)",[project+':real',project]);
 // Hash stimmt bereits, aber Parse-Zeit ist alt: Uebergabe noch nicht fertig.
 await pool.query("UPDATE code_files SET parsed_at=updated_at-INTERVAL '1 second',parser_version=1 WHERE project=$1",[project]);
 assert.equal((await run('functions',{file_path:'neu/commit.ts'})).functions[0].schatten,true);
 await pool.query('UPDATE code_files SET parsed_at=NOW(),parser_version=1 WHERE project=$1',[project]);
 const ready=await run('functions',{file_path:'neu/commit.ts'});
 assert.equal(ready.functions[0].id,project+':real');assert.equal(ready.index_folgt,undefined);
 assert.equal((await run('functions',{schatten:id,file_path:'neu/commit.ts'})).functions[0].id,project+':real');
 // Nicht vorgewärmter committed Plan (Daemon/API-Neustart), mehrere Dateien unterschiedlich weit.
 const multi=await plan([{action:'create',file_path:'multi/a.ts',content:'export function multiA(){}'},
  {action:'create',file_path:'multi/b.ts',content:'export function multiB(){}'}],'committed');
 await file('multi/a.ts','export function multiA(){}',true);await file('multi/b.ts','export function multiB(){}');
 await pool.query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) VALUES($1,$2,'multi/a.ts','function','multiA',1,true)",[project+':multiA',project]);
 const mixed=await run('functions',{file_path:'multi/',schatten:multi});
 assert.equal(mixed.functions.find(f=>f.name==='multiA').id,project+':multiA');assert.equal(mixed.functions.find(f=>f.name==='multiA').schatten,undefined);
 assert.equal(mixed.functions.find(f=>f.name==='multiB').schatten,true);
 // Vollstaendiger Cancel und echter teilweiser Rueckzug zweier Agenten.
 const cancel=await plan([{action:'create',file_path:'cancel.ts',content:'export function cancelled(){}'}]);
 assert.equal((await run('functions',{schatten:cancel,name:'cancelled'})).functions.length,1);
 await fb.cancelBatch(cancel,'sol-1-t29-a','Test vollstaendig abbrechen');
 assert.equal((await run('functions',{schatten:cancel,name:'cancelled'})).success,false);
 assert.equal((await run('functions',{name:'cancelled'})).functions.length,0);
 const shared=await plan([{action:'create',file_path:'shared.ts',content:'export function sharedA(){}',agent_id:'sol-1-t29-a'},
  {action:'create',file_path:'withdraw.ts',content:'export function sharedB(){}',agent_id:'sol-1-t29-b'}]);
 assert.equal((await run('functions',{schatten:shared,name:'sharedB'})).functions.length,1);
 assert.equal((await fb.cancelBatch(shared,'sol-1-t29-b','Eigenen Beitrag zurueckziehen')).mode,'withdrawn');
 assert.equal((await run('functions',{schatten:shared,name:'sharedB'})).functions.length,0);
 assert.equal((await run('functions',{schatten:shared,name:'sharedA'})).functions.length,1);
 await file('shared.ts','export function sharedA(){}');
 await pool.query("UPDATE file_batch_plans SET status='committed',committed_at=NOW() WHERE id=$1",[shared]);
 assert.equal((await run('functions',{name:'sharedA'})).functions.length,1);
 assert.equal((await run('functions',{name:'sharedB'})).functions.length,0);
 // Bestehende Datei: Vorher-Version plus nicht idempotente Einfuegung, nie doppelt anwenden.
 const old='export function oldName(){}\n', changed=old+'export function inserted(){}\n';
 await file('update.ts',old,true);
 const update=await plan([{action:'insert_after',file_path:'update.ts',after_line:1,content:'export function inserted(){}'}]);
 await pool.query('UPDATE file_batch_plans SET expected_hashes=$2::jsonb WHERE id=$1',[update,JSON.stringify({'update.ts':hash(old)})]);
 await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,batch_id,size_bytes) VALUES($1,'update.ts',$2,$3,'batch:update',$4,$5)",[project,old,hash(old),update,Buffer.byteLength(old)]);
 await file('update.ts',changed);
 await pool.query("UPDATE file_batch_plans SET status='committed',committed_at=NOW() WHERE id=$1",[update]);
 const updateResult=await run('functions',{file_path:'update.ts'});
 assert.equal(updateResult.functions.filter(f=>f.name==='inserted').length,1);
 assert.equal((await run('file',{schatten:update,file_path:'update.ts'})).content,changed);
 // Ein neuerer Schreibstand darf keinen alten Commit wieder einblenden.
 await file('update.ts','export function newer(){}\n');
 assert.equal((await run('functions',{file_path:'update.ts'})).functions.some(f=>f.name==='inserted'),false);
 const removed='export function removed(){}\n';
 await file('removed.ts',removed,true);
 await pool.query("INSERT INTO code_symbols(id,project,file_path,symbol_type,name,line_start,is_exported) VALUES($1,$2,'removed.ts','function','removed',1,true)",[project+':removed',project]);
 const del=await plan([{action:'delete',file_path:'removed.ts'}]);
 await pool.query('UPDATE file_batch_plans SET expected_hashes=$2::jsonb WHERE id=$1',[del,JSON.stringify({'removed.ts':hash(removed)})]);
 await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,edit_action,batch_id,size_bytes) VALUES($1,'removed.ts',$2,$3,'batch:delete',$4,$5)",[project,removed,hash(removed),del,Buffer.byteLength(removed)]);
 await pool.query('UPDATE code_files SET deleted_at=NOW(),updated_at=NOW() WHERE project=$1 AND file_path=$2',[project,'removed.ts']);
 await pool.query("UPDATE file_batch_plans SET status='committed',committed_at=NOW() WHERE id=$1",[del]);
 assert.equal((await ci.getFunctions(project,'removed.ts')).length,1,'Kontrolle: Tombstone allein entfernt den alten Symbolindex noch nicht');
 assert.equal((await run('functions',{file_path:'removed.ts'})).functions.length,0,'Delete-Schatten unterdrueckt Restindex bis zum echten Loeschen');
 await pool.query('DELETE FROM code_symbols WHERE id=$1',[project+':removed']);
 assert.equal((await run('functions',{schatten:del,file_path:'removed.ts'})).functions.length,0);
 if(process.argv.includes('--strecken')){
  const {handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
  const {codeIntelTool}=await import('../../mcp-server/dist/tools/consolidated/code-intel.js');
  for(const handler of [codeIntelTool.handler,args=>handleToolCall('code_intel',args)]){
   const r=await handler({action:'functions',project,name:'sharedA'});
   assert.equal(r.functions.length,1);assert.equal(r.functions[0].schatten,true);
  }
 }
 console.log('OK P6-T29: Standard/explicit, Hash vor Parse, restart, dateiweise Uebergabe, Cancel und Rueckzug zweier Agenten');
}finally{
 for(const table of ['code_references','code_call_edges','code_statements','code_symbols','code_files','file_versions','file_batch_waits','file_batch_plans','file_reservations','plans','projects'])await pool.query('DELETE FROM '+table+' WHERE '+(table==='projects'?'name':'project')+'=$1',[project]);
 await closePool();
}
process.exit(0);
