/**
 * P22-T218 / Stresstest P22-T214 B3 (Befund a0e03e58): coedit_no_changes fuer Dateien, in denen der Aufrufer
 * schon eigene Ops im Zielplan hat. Vorher still linked, commit wartete weiter; jetzt eigene_ops_vorhanden bzw.
 * zurueckziehen:true = Beitragenden-cancel (nur eigene Ops weg, fremde bleiben, Wait geschlossen).
 * Nur synapse_test:5433, eigener Projektbereich; Cleanup immer. Jeder Check nennt Herkunft und erwartet/ist.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1'});
const B=await import('../dist/services/file-batch.js');
const D=await import('../dist/db/client.js'),pool=D.getPool(),project='p22-t218-'+randomUUID();
let checks=0,errors=0,sequence=0;
const short=x=>JSON.stringify(x)?.slice(0,1500);
function ok(v,label,ist){assert.ok(v,'P22-T218 file-batch.ts '+label+' erwartet=true ist='+short(ist??v));checks++;console.log('OK P22-T218 '+label);}
async function test(label,fn){try{await fn();}catch(e){errors++;console.error('FEHLER P22-T218 '+label+' '+e.stack);}}
const read=async f=>(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[project,f])).rows[0]?.content;
const plan=(a,ops)=>B.planBatch({project,agent_id:a,ops});
const commit=(p,a)=>B.commitBatch({plan_id:p,agent_id:a});
const sr=(f,search,replace)=>({file_path:f,action:'search_replace',search,replace});
const base='ALT\nMITTE\nFUSS\n';
async function seed(f){const p=await plan(project+'seed',[{file_path:f,action:'create',content:base}]);ok((await commit(p.plan_id,project+'seed')).success,'Fixture commit '+f);}
// Owner plant, Beitragender w traegt bei, optional ein Dritter x wartet ohne eigenen Beitrag.
async function aufbau(){
 const n=++sequence,f='t218-'+n+'.txt',o=project+'o'+n,w=project+'w'+n,x=project+'x'+n;
 await seed(f);
 const p=await plan(o,[sr(f,'ALT','OWNER')]);
 await plan(w,[sr(f,'FUSS','BEITRAG')]);
 const added=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,ops:[sr(f,'FUSS','BEITRAG')]});
 ok(added.success,'Aufbau '+n+' Beitrag von w',added);
 await plan(x,[sr(f,'MITTE','DRITTER')]);
 return {f,o,w,x,plan_id:p.plan_id};
}
const planOps=async id=>(await pool.query('SELECT ops FROM file_batch_plans WHERE id=$1::bigint',[id])).rows[0].ops;
const waitStatus=async(id,a)=>(await pool.query('SELECT status FROM file_batch_waits WHERE project=$1 AND primary_plan_id=$2::bigint AND waiting_agent=$3',[project,id,a])).rows.map(r=>r.status);
try{
 ok((await pool.query('SELECT current_database() db')).rows[0].db==='synapse_test','DB-Ziel');
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t218-test','/tmp']);
 await test('no_changes ohne eigene Ops unveraendert',async()=>{
  const s=await aufbau();
  const r=await B.markCoeditNoChanges({project,plan_id:s.plan_id,agent_id:s.x,files:[s.f]});
  ok(r.success&&r.status==='no_changes'&&!r.error,'Dritter ohne Ops: success, status no_changes',r);
  ok((await waitStatus(s.plan_id,s.x)).includes('no_changes'),'Wait des Dritten no_changes',await waitStatus(s.plan_id,s.x));
  ok((await planOps(s.plan_id)).length===2,'Plan unveraendert 2 Ops');
 });
 await test('no_changes mit eigenen Ops: Fehler mit Liste',async()=>{
  const s=await aufbau();
  const r=await B.markCoeditNoChanges({project,plan_id:s.plan_id,agent_id:s.w,files:[s.f]});
  console.log('BELEG P22-T218 '+short(r));
  ok(r.success===false&&r.error==='eigene_ops_vorhanden','error eigene_ops_vorhanden',r);
  ok(r.eigene_ops===1&&JSON.stringify(r.op_indexe)==='[1]'&&r.dateien?.includes(s.f),'Anzahl 1, op_indexe [1], Datei genannt',r);
  ok(typeof r.rueckzug==='string'&&r.rueckzug.includes('"cancel"')&&r.rueckzug.includes(s.plan_id),'fertiger cancel-Aufruf',r.rueckzug);
  ok(typeof r.rueckzug_alternativ==='string'&&r.rueckzug_alternativ.includes('zurueckziehen:true'),'Alternative zurueckziehen:true',r.rueckzug_alternativ);
  ok(typeof r.fertig==='string'&&r.fertig.includes('coedit_ready'),'Hinweis coedit_ready',r.fertig);
  ok((await planOps(s.plan_id)).length===2,'nichts geaendert: 2 Ops');
  const st=await waitStatus(s.plan_id,s.w);
  ok(!st.includes('no_changes')&&!st.includes('closed'),'Wait von w nicht no_changes/closed',st);
 });
 await test('zurueckziehen:true nur eigene Ops weg, fremde bleiben, Wait geschlossen',async()=>{
  const s=await aufbau();
  const r=await B.markCoeditNoChanges({project,plan_id:s.plan_id,agent_id:s.w,files:[s.f],zurueckziehen:true});
  console.log('BELEG P22-T218 '+short(r));
  ok(r.success===true&&r.zurueckgezogen===true&&r.mode==='withdrawn'&&r.withdrawn_ops===1,'Rueckzug withdrawn 1 Op',r);
  ok(typeof r.record_plan_id==='string','Rueckzugsprotokoll vorhanden',r);
  const ops=await planOps(s.plan_id);
  ok(ops.length===1&&ops[0].replace==='OWNER','nur Owner-Op bleibt',ops);
  const st=await waitStatus(s.plan_id,s.w);
  ok(st.length>0&&st.every(x=>x==='closed'),'Waits von w geschlossen',st);
  ok((await B.markCoeditNoChanges({project,plan_id:s.plan_id,agent_id:s.x,files:[s.f]})).success,'Dritter meldet no_changes');
  const cm=await commit(s.plan_id,s.o);
  ok(cm.success,'Owner commit ohne Warten auf w',cm);
  ok(await read(s.f)==='OWNER\nMITTE\nFUSS\n','Inhalt nur Owner-Aenderung',await read(s.f));
 });
}finally{
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]);
 for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 await pool.query('DELETE FROM plans WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await D.closePool();
}
console.log((errors?'FEHLER ':'BESTANDEN ')+checks+' P22-T218 checks; Fehler='+errors);
process.exit(errors?1:0);
