/** P6-T48: Golden offener Plan, planlose Hinweise/Schatten und alte zielose Waits; nur synapse_test:5433. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const hier=dirname(fileURLToPath(import.meta.url));
assert.ok(/^postgres(?:ql)?:\/\/[^/]+:5433\/synapse_test(?:\?|$)/.test(process.env.DATABASE_URL||''),'Testziel muss synapse_test:5433 sein');
// Die Testumgebung setzt QDRANT_URL im Shell-Aufruf; die DB-Env bleibt unverändert.
const dist=process.env.P6_T48_DIST||join(hier,'..','dist');
const load=rel=>import(pathToFileURL(join(dist,rel)).href);
const batch=await load('services/file-batch.js');
const res=await load('services/file-reservations.js');
const ci=await load('services/code-intel.js');
const {mitCodeIntelSchatten}=await load('services/code-intel-schatten.js');
const {getPool}=await load('db/client.js'); const pool=getPool();
assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
const project='p6_t48_'+randomUUID(), owner='sol-9-t48-owner', writer='sol-9-t48-writer';
const names=new Map(), hash=s=>createHash('sha256').update(s).digest('hex');
const normal=v=>JSON.parse(JSON.stringify(v,(k,x)=>{
 if(['schatten_parse_ms','duration_ms','dauer_ms','ms','gewartet_ms'].includes(k))return undefined;
 if(['expires_at','reserved_at','reserved_since','created_at','updated_at','seit'].includes(k))return '<zeit>';
 if(k==='wait_token')return '<wait>';
 if(typeof x!=='string')return x;
 let out=x.replaceAll(project,'<project>');
 for(const [id,name]of names)out=out.replaceAll(id,name);
 return out;
}));
const op=(file,search,replace)=>({action:'search_replace',file_path:file,search,replace});
const seed=async file=>{
 const content='export function probe(){ return 1; }\n';
 await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
 [randomUUID(),project,file,file.split('/').at(-1),'ts',Buffer.byteLength(content),content,hash(content)]);
};
const run=(action,a)=>mitCodeIntelSchatten(action,{project,...a},async()=>{
 if(action==='file'){const f=await ci.getFileContent(project,a.file_path);return {success:!!f,...f,project};}
 if(action==='tree')return {success:true,tree:await ci.getProjectTree(project,a),project};
 if(action==='functions'){const functions=await ci.getFunctions(project,a.file_path);return {success:true,functions,project};}
 const symbols=await ci.getSymbols(project,a.symbol_type,a.file_path,undefined,100);return {success:true,symbols,project};
});
try {
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'p6-t48-test','/virtual/p6-t48']);
 for(const file of ['src/golden.ts','src/free.ts','src/legacy.ts','src/expired.ts','src/multi-a.ts','src/multi-b.ts'])await seed(file);
 // Altumfang: vorhandener Ownerplan => exakt dieselbe Antwort, Waitbindung und contribution.
 await res.addFileReservations({project,agentId:owner,filePaths:['src/golden.ts']});
 const p=await batch.planBatch({project,agent_id:owner,ops:[op('src/golden.ts','return 1','return 2')]}); names.set(p.plan_id,'<owner-plan>');
 const w=await batch.planBatch({project,agent_id:writer,ops:[op('src/golden.ts','probe','goldenProbe')]}); names.set(w.plan_id,'<carrier>');
 const contribution=await batch.addCoeditContribution({project,plan_id:p.plan_id,wait_token:w.coedit_waits[0].wait_token,agent_id:writer,ops:[op('src/golden.ts','probe','goldenProbe')]});
 const golden=normal({plan:p,wait:w,contribution});
 if(process.argv.includes('--capture'))console.log('GOLDEN_JSON='+JSON.stringify(golden));
 else if(!process.argv.includes('--funktional')) assert.deepEqual(golden,JSON.parse(readFileSync(join(hier,'fixtures','file-reservation-planless-p6-t48.golden.json'),'utf8')));
 if(!process.argv.includes('--capture')&&!process.argv.includes('--golden')){
  // Kein Plan: Absicht sichtbar, Bestand unverändert, Schreiben ohne Wait.
  await res.addFileReservations({project,agentId:owner,filePaths:['src/free.ts','lib/new.ts']});
  if(!process.argv.includes('--planlos')) {
  for(const action of ['file','functions','symbols']){
   const out=await run(action,{file_path:'src/free.ts',symbol_type:'function',schatten:'alle'});
   assert.equal(out.reservierungen?.[0]?.reserviert_von,owner,action+': Reservierung sichtbar');
   assert.equal(out.reservierungen[0].file_path,'src/free.ts');
   assert.ok(out.reservierungen[0].seit&&out.reservierungen[0].expires_at);
   assert.ok(Object.hasOwn(out.reservierungen[0],'task_id'));
  }
  const tree=await run('tree',{path:'lib',show_ghosts:true});
  assert.ok(tree.reservierungen?.some(r=>r.file_path==='lib/new.ts'));
  assert.match(tree.tree,/new.ts/);assert.match(tree.tree,/Reservierungen ohne Plan/);
  const scoped=await run('file',{file_path:'src/free.ts',schatten:p.plan_id});
  assert.ok(scoped.reservierungen?.some(r=>r.file_path==='src/free.ts'));
  const plain=await run('file',{file_path:'src/free.ts'});
  assert.ok(!Object.hasOwn(plain,'reservierungen'),'ohne Schalter unverändert');
  }
  const planned=await batch.planBatch({project,agent_id:writer,ops:[op('src/free.ts','return 1','return 3')]});
  assert.equal(planned.total_ops,1);assert.ok(!planned.coedit_waits?.length);assert.ok(!planned.deferred_ops);
  assert.equal(planned.reservation_hint.files[0].reserviert_von,owner);
  const c=await batch.commitBatch({plan_id:planned.plan_id,agent_id:writer});assert.equal(c.success,true);
  assert.match((await ci.getFileContent(project,'src/free.ts')).content,/return 3/);
  // Gegenprobe: freigegebene/abgelaufene/fremde Reservierungen werden nicht gezeigt.
  await pool.query("INSERT INTO file_reservations(project,agent_id,file_path,content_hash_at_reservation,expires_at) VALUES($1,$2,'src/expired.ts',$3,NOW()-INTERVAL '1 hour')",[project,owner,hash('')]);
  assert.ok(!(await run('file',{file_path:'src/expired.ts',schatten:'alle'})).reservierungen);
  await res.releaseFileReservations({project,agentId:owner,filePaths:['lib/new.ts']});
  assert.ok(!(await run('tree',{path:'lib',show_ghosts:true})).reservierungen);
  // Filter und Metadaten: inaktive/fremde Absichten bleiben unsichtbar;
  // Taskreferenz aus vorhandener Plan-ID ist echt, fehlende Referenz bleibt null.
  const inactive=project+'_inactive';
  await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'stopped')",[inactive,project]);
  await pool.query("INSERT INTO file_reservations(project,agent_id,file_path,content_hash_at_reservation,expires_at) VALUES($1,$2,'filter/inactive.ts',$3,NOW()+INTERVAL '5 minutes')",[project,inactive,hash('')]);
  await pool.query("INSERT INTO file_reservations(project,agent_id,file_path,content_hash_at_reservation,expires_at) VALUES($1,$2,'filter/foreign.ts',$3,NOW()+INTERVAL '5 minutes')",[project+'_foreign',owner,hash('')]);
  assert.ok(!(await run('tree',{path:'filter',show_ghosts:true})).reservierungen);
  await res.addFileReservations({project,agentId:owner,filePaths:['filter/root.ts','filter/deep/new.ts']});
  const filtered=await run('tree',{path:'filter',show_ghosts:true,recursive:false});
  assert.deepEqual(filtered.reservierungen.map(r=>r.file_path),['filter/root.ts']);
  assert.equal(filtered.reservierungen[0].task_id,null);
  const depth=await run('tree',{path:'filter',show_ghosts:true,depth:0});
  assert.deepEqual(depth.reservierungen.map(r=>r.file_path),['filter/root.ts']);
  assert.ok(!(await run('tree',{path:'filter',show_ghosts:true,file_type:'txt'})).reservierungen);
  assert.ok(!(await run('file',{file_path:'src/golden.ts',schatten:'alle'})).reservierungen,'offener Ownerplan ist keine planlose Absicht');
  const referenced=(await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status) VALUES($1,$2,$3::jsonb,'{}','[]','cancelled') RETURNING id::text",
   [project,owner,JSON.stringify([{action:'create',file_path:'filter/task.ts',task_id:'synthetic-task-ref',content:''}])])).rows[0].id;
  await res.addFileReservations({project,agentId:owner,filePaths:['filter/task.ts'],planId:referenced});
  const metadata=await run('file',{file_path:'filter/task.ts',schatten:'alle'});
  assert.equal(metadata.reservierungen[0].task_id,'synthetic-task-ref');
  assert.equal(metadata.reservierungen[0].reserviert_von,owner);
  // Stresstest-Muster: zwei Reservierungen ohne Plan, genau ein sofortiger Writerplan;
  // späterer Reservierender landet additiv in diesem bestehenden Ziel, kein Parallelplan.
  await res.addFileReservations({project,agentId:owner,filePaths:['src/multi-a.ts','src/multi-b.ts']});
  const multi=await batch.planBatch({project,agent_id:writer,ops:[
   op('src/multi-a.ts','return 1','return 5'),op('src/multi-b.ts','return 1','return 6')]});
  assert.equal(multi.total_ops,2);assert.ok(!multi.coedit_waits?.length);
  assert.equal(multi.reservation_hint.files.length,2);
  const followerOps=[op('src/multi-a.ts','probe','laterA'),op('src/multi-b.ts','probe','laterB')];
  const follower=await batch.planBatch({project,agent_id:owner,ops:followerOps});
  assert.equal(follower.total_ops,0);assert.equal(follower.coedit_waits.length,1);
  assert.equal(follower.coedit_waits[0].target_plan_id,multi.plan_id);
  const followAdd=await batch.addCoeditContribution({project,plan_id:multi.plan_id,
   wait_token:follower.coedit_waits[0].wait_token,agent_id:owner,ops:followerOps});
  assert.equal(followAdd.success,true);assert.equal(followAdd.total_plan_ops,4);
  await batch.markCoeditReady({project,plan_id:multi.plan_id,agent_id:owner});
  assert.equal((await batch.commitBatch({plan_id:multi.plan_id,agent_id:writer})).success,true);
  assert.match((await ci.getFileContent(project,'src/multi-a.ts')).content,/laterA.*return 5/);
  assert.match((await ci.getFileContent(project,'src/multi-b.ts')).content,/laterB.*return 6/);
  assert.equal((await pool.query('SELECT status FROM file_batch_plans WHERE id=$1',[follower.plan_id])).rows[0].status,'cancelled');
  // Alt-Wait synthetisch nachstellen: spätere Ownerplanung bindet ihn, Inhalte bleiben erhalten.
  await res.addFileReservations({project,agentId:owner,filePaths:['src/legacy.ts']});
  const carrier=(await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews) VALUES($1,$2,'[]','{}','[]') RETURNING id::text",[project,writer])).rows[0].id;
  const deferred=[op('src/legacy.ts','probe','legacyProbe')];
  const wait=(await pool.query("INSERT INTO file_batch_waits(source_plan_id,project,waiting_agent,primary_agent,shared_files,deferred_ops,deferred_op_indexes,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,NOW()+INTERVAL '1 minute') RETURNING wait_token::text",
   [carrier,project,writer,owner,['src/legacy.ts'],JSON.stringify(deferred),[0]])).rows[0].wait_token;
  const legacy=await batch.planBatch({project,agent_id:owner,ops:[op('src/legacy.ts','return 1','return 4')]});
  const bound=(await pool.query('SELECT primary_plan_id::text,deferred_ops FROM file_batch_waits WHERE wait_token=$1',[wait])).rows[0];
  assert.equal(bound.primary_plan_id,legacy.plan_id);assert.deepEqual(bound.deferred_ops,deferred);
  const status=await batch.getSharedPlanStatus({project,wait_token:wait,agent_id:writer});
  assert.equal(status.target_plan_id,legacy.plan_id);
  const added=await batch.addCoeditContribution({project,plan_id:legacy.plan_id,wait_token:wait,agent_id:writer,ops:deferred});
  assert.equal(added.success,true);
  await batch.markCoeditReady({project,plan_id:legacy.plan_id,agent_id:writer});
  assert.equal((await batch.commitBatch({plan_id:legacy.plan_id,agent_id:owner})).success,true);
  assert.match((await ci.getFileContent(project,'src/legacy.ts')).content,/legacyProbe.*return 4/);
 }
 console.log('P6-T48 '+(process.argv.includes('--capture')?'Altgolden erfasst':process.argv.includes('--golden')?'Altgolden unverändert':process.argv.includes('--funktional')?'Planlos/Schatten/Alt-Wait funktional grün; Golden NICHT geprüft':'Golden + Planlos/Schatten/Alt-Wait grün'));
}finally{
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)',[project]);
 await pool.query('DELETE FROM file_batch_waits WHERE project=$1',[project]);
 await pool.query('DELETE FROM file_reservations WHERE project=$1',[project]);
 await pool.query('DELETE FROM file_batch_plans WHERE project=$1',[project]);
 await pool.query('DELETE FROM file_versions WHERE project=$1',[project]);
 await pool.query('DELETE FROM code_files WHERE project=$1',[project]);
 await pool.query('DELETE FROM agent_events WHERE project=$1',[project]);
 await pool.query('DELETE FROM file_reservations WHERE project=$1',[project+'_foreign']);
 await pool.query('DELETE FROM agent_sessions WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);await pool.end();
}
