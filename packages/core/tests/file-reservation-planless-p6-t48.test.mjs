/** P6-T48: Golden offener Plan, planlose Hinweise/Schatten und alte zielose Waits; nur synapse_test:5433. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const u=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(u.port,'5433'); assert.equal(u.pathname,'/synapse_test');
process.env.SYNAPSE_PLAN_PRUEFUNG='0'; process.env.QDRANT_URL='http://127.0.0.1:9';
const batch=await import('../dist/services/file-batch.js');
const res=await import('../dist/services/file-reservations.js');
const ci=await import('../dist/services/code-intel.js');
const {mitCodeIntelSchatten}=await import('../dist/services/code-intel-schatten.js');
const {getPool}=await import('../dist/db/client.js'); const pool=getPool();
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
 for(const file of ['src/golden.ts','src/free.ts','src/legacy.ts','src/expired.ts'])await seed(file);
 // Altumfang: vorhandener Ownerplan => exakt dieselbe Antwort, Waitbindung und contribution.
 await res.addFileReservations({project,agentId:owner,filePaths:['src/golden.ts']});
 const p=await batch.planBatch({project,agent_id:owner,ops:[op('src/golden.ts','return 1','return 2')]}); names.set(p.plan_id,'<owner-plan>');
 const w=await batch.planBatch({project,agent_id:writer,ops:[op('src/golden.ts','probe','goldenProbe')]}); names.set(w.plan_id,'<carrier>');
 const contribution=await batch.addCoeditContribution({project,plan_id:p.plan_id,wait_token:w.coedit_waits[0].wait_token,agent_id:writer,ops:[op('src/golden.ts','probe','goldenProbe')]});
 const golden=normal({plan:p,wait:w,contribution});
 if(process.argv.includes('--capture'))console.log('GOLDEN_JSON='+JSON.stringify(golden));
 else assert.deepEqual(golden,JSON.parse(readFileSync(new URL('./fixtures/file-reservation-planless-p6-t48.golden.json',import.meta.url),'utf8')));
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
 console.log('P6-T48 '+(process.argv.includes('--capture')?'Altgolden erfasst':process.argv.includes('--golden')?'Altgolden unverändert':'Golden + Planlos/Schatten/Alt-Wait grün'));
}finally{
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)',[project]);
 for(const t of ['file_batch_waits','file_reservations','file_batch_plans','file_versions','code_files','agent_events'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);await pool.end();
}
