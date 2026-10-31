/**
 * P22-T198 / e8f2dc56, 0a3bb226, historische Reihe 46ccab5b:
 * echte file-batch.ts-/PG-Verträge für Zielscope, Ready-Gate, Batch/absolute und Protokollrollen.
 * Nur synapse_test:5433, eigener Projektbereich; Cleanup immer. Keine Produktiv-DB/FS/Browser/LLM.
 * Stress: 100 Protokoll-Identitäten/100000 Zeilen, echte konkurrierende Core-Aufrufe; KEINE Modellagenten.
 * Jeder Check nennt Herkunft und erwartet/ist; Fehlerzahl/Plan-IDs stehen im Log.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_SHELL_JOB:'1'});
const B=await import('../dist/services/file-batch.js');
const R=await import('../dist/services/file-reservations.js');
const D=await import('../dist/db/client.js'),pool=D.getPool(),project='p22-t198-'+randomUUID();
let checks=0,errors=0,sequence=0;
const short=x=>JSON.stringify(x)?.slice(0,1800);
function ok(v,label,ist){assert.ok(v,'P22-T198 file-batch.ts '+label+' erwartet=true ist='+short(ist??v));checks++;console.log('OK P22-T198 '+label);}
async function test(label,fn){if(process.env.T198_FALL_FILTER&&!label.includes(process.env.T198_FALL_FILTER))return;try{await fn();}catch(e){errors++;console.error('FEHLER P22-T198 '+label+' '+e.stack);}}
async function attempt(fn){try{return await fn();}catch(e){return {success:false,error:e.message,plan_id:e.plan_id};}}
const read=async f=>(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[project,f])).rows[0]?.content;
const active=a=>pool.query("INSERT INTO tool_calls(project,tool_name,action,agent_id,ts) VALUES($1,'files','plan_status',$2,now())",[project,a]);
const plan=(a,ops)=>B.planBatch({project,agent_id:a,ops});
const commit=(p,a,wait_seconds)=>B.commitBatch({plan_id:p,agent_id:a,wait_seconds});
const sr=(f,search,replace)=>({file_path:f,action:'search_replace',search,replace});
async function seed(f,text){const p=await plan(project+'seed',[{file_path:f,action:'create',content:text}]);ok((await commit(p.plan_id,project+'seed')).success,'Fixture commit '+f);}
async function cancel(p,a){await B.cancelBatch(p,a);}
const base='KOPF\nOBEN\nMITTE\nUNTEN\nFUSS\n';
async function regionCase(name,first,next,{conflict=false,expected,initial=base}={}){
 const f='region-'+(++sequence)+'.txt',owner=project+'o'+sequence,author=project+'b'+sequence;
 await seed(f,initial);
 const p=await plan(owner,first.map(x=>({...x,file_path:f})));
 await plan(author,next.map(x=>({...x,file_path:f})));
 const added=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:author,ops:next.map(x=>({...x,file_path:f}))});
 ok(added.success,name+' contribution',added);
 const state=await B.getBatchPlan(p.plan_id),warnings=[...(added.overlap_warnings??[]),...(state.overlap_warnings??[])];
 await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:author});
 const cm=await commit(p.plan_id,owner);
 console.log('BELEG P22-T198 '+short({name,plan_id:p.plan_id,warnings,commit:cm.error??cm.success}));
 if(conflict){ok(warnings.length>0&&!cm.success,name+' echte Ueberlappung bleibt Konflikt',{warnings,cm});ok(await read(f)===initial,name+' atomar nichts geschrieben');await cancel(p.plan_id,owner);}
 else{ok(warnings.length===0&&cm.success,name+' disjunkt ohne Ganzdateikonflikt',{warnings,cm});if(expected!==undefined)ok(await read(f)===expected,name+' exakter Inhalt',{actual:await read(f),expected});}
}
const s=(search,replace)=>({action:'search_replace',search,replace});
const batch=(search,replace)=>({action:'search_replace_batch',edits:[{search,replace}]});
try{
 ok((await pool.query('SELECT current_database() db')).rows[0].db==='synapse_test','DB-Ziel');
 await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)',[project,'t198-test','/tmp']);
 // A / 26299: derselbe Primäragent reserviert drei Dateien, sein tatsächlicher Zielplan enthält zwei.
 await test('26299 Scope und erhaltene Außen-Op',async()=>{
  const fs=['scope-a.txt','scope-b.txt','scope-c.txt'],o=project+'scope-o',w=project+'scope-w';
  for(const f of fs)await seed(f,'ALT\nFUSS\n');
  await R.addFileReservations({project,agentId:o,filePaths:fs});
  const p=await plan(o,fs.slice(0,2).map(f=>sr(f,'ALT','OWNER')));
  const ops=fs.map(f=>sr(f,'FUSS','BEITRAG'));
  const carrier=await plan(w,ops),wait=carrier.coedit_waits?.find(x=>x.target_plan_id===p.plan_id);
  ok(!!wait,'26299 gebundener Wait',carrier);
  const raw=(await pool.query('SELECT shared_files FROM file_batch_waits WHERE wait_token=$1',[wait.wait_token])).rows[0];
  ok(raw.shared_files.includes(fs[2]),'26299 echter Roh-Wait enthält Außen-Datei',raw);
  await active(w);
  const blocked=await commit(p.plan_id,o);
  ok(blocked.status==='waiting_for_contributors','26299 echtes Gate vor Ready',blocked);
  for(let i=0;i<2;i++)ok((await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,wait_token:wait.wait_token,op_index:i,ops:[ops[i]]})).success,'26299 Beitrag '+i);
  const ready=await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:w});
  ok(ready.success&&!ready.remaining_files?.length,'26299 Ready verlangt nur Ziel-Dateien',ready);
  ok(ready.ausserhalb_zielplan?.includes(fs[2]),'26299 Außen-Datei sichtbar',ready);
  const state=await B.getSharedPlanStatus({project,agent_id:w,wait_token:wait.wait_token});
  ok(!state.remaining_files?.length&&state.ausserhalb_zielplan?.includes(fs[2]),'26299 Anzeige konsistent',state);
  ok((await commit(p.plan_id,o)).success,'26299 Ziel trotz Außen-Datei commitbar');
  ok(await read(fs[2])==='ALT\nFUSS\n','26299 Außen-Datei unverändert vor Folgeplan');
  const late=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,wait_token:wait.wait_token,op_index:2,ops:[ops[2]]});
  ok(late.success&&late.follow_up,'26299 Außen-Op bleibt für Folgeplan abrufbar',late);
  ok((await commit(late.plan_id,w)).success,'26299 Folgeplan commit');
  ok(await read(fs[2])==='ALT\nBEITRAG\n','26299 Außen-Op genau einmal');
 });
 await test('B disjunkte Batches',()=>regionCase('zwei Batches',[batch('OBEN','A')],[batch('UNTEN','B')],{expected:'KOPF\nA\nMITTE\nB\nFUSS\n'}));
 await test('B Batch nach Insert',()=>regionCase('Batch nach Insert',[s('OBEN','OBEN\nNEU')],[batch('UNTEN','B')],{expected:'KOPF\nOBEN\nNEU\nMITTE\nB\nFUSS\n'}));
 await test('B absolute nach Insert',()=>regionCase('absolute nach Insert',[s('OBEN','OBEN\nNEU')],[{action:'replace_lines',line_start:5,line_end:5,anchor_text:'UNTEN',content:'B',shift_mode:'absolute'}],{expected:'KOPF\nOBEN\nNEU\nMITTE\nB\nFUSS\n'}));
 await test('B Batch echte Überschneidung',()=>regionCase('Batch echte Ueberlappung',[batch('OBEN','X-OBEN-X')],[batch('OBEN','Y-OBEN-Y')],{conflict:true}));
 await test('B neu erzeugter Text',()=>regionCase('Batch fremden neuen Text ersetzen',[s('OBEN','OBEN\nNEU')],[batch('NEU','ANDERS')],{conflict:true}));
 await test('B gleiche reine Einfügestelle',()=>regionCase('Batch gleiche reine Einfuegestelle',[s('OBEN','OBEN\nNEU-A')],[batch('OBEN','OBEN\nNEU-B')],{expected:'KOPF\nOBEN\nNEU-B\nNEU-A\nMITTE\nUNTEN\nFUSS\n'}));
 await test('B absolute echte Überschneidung',()=>regionCase('absolute echte Ueberlappung',[{action:'replace_lines',line_start:2,line_end:2,anchor_text:'OBEN',content:'A',shift_mode:'absolute'}],[{action:'replace_lines',line_start:2,line_end:2,anchor_text:'A',content:'B',shift_mode:'absolute'}],{conflict:true}));
 await test('B CRLF/Dollar/replace_all',()=>regionCase('Batch CRLF und literal Dollar',[batch('oben\nmitte','OBEN\nmitte')],[{action:'search_replace_batch',edits:[{search:'unten',replace:'$& $1',replace_all:true}]}],{initial:'kopf\r\noben\r\nmitte\r\nunten\r\nunten\r\n',expected:'kopf\r\nOBEN\r\nmitte\r\n$& $1\r\n$& $1\r\n'}));
 await test('B Whitespace',()=>regionCase('Batch toleranter Whitespace',[batch('a b','AB')],[batch('c d','CD')],{initial:'a\tb\nMITTE\nc   d\n',expected:'AB\nMITTE\nCD\n'}));
 // C / 26180: weder erfolgreiche noch gescheiterte Korrektur darf die Folge-ID verstecken.
 await test('C neue ID und Ownerrolle',async()=>{
  const f='replan.txt',a=project+'replan';await seed(f,'ALT\n');
  const fail=await attempt(()=>plan(a,[sr(f,'NICHT DA','X')]));ok(!!fail.plan_id,'gescheiterter Entwurf hat ID',fail);
  // P6-T51: ganzen Entwurf ohne op_index ersetzen nur noch ausdruecklich (ersetzen_alle); ohne haengt plan_update an.
  const p=await B.replanBatch({project,plan_id:fail.plan_id,agent_id:a,ersetzen_alle:true,ops:[sr(f,'ALT','NEU')]});
  ok(p.plan_id!==fail.plan_id&&p.superseded_plan_id===fail.plan_id&&p.message?.startsWith('NEUE plan_id '+p.plan_id),'Erfolg nennt neue ID zuerst',p);
  const own=await attempt(()=>B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:a,ops:[sr(f,'ALT','NEU')]}));
  ok(!own.success&&/Owner.*plan_update/.test(own.error),'Owner wird auf plan_update verwiesen',own);
  ok((await commit(p.plan_id,a)).success,'Commit mit neuer ID');
 });
 // A: ein nach Ready gewachsener Zielscope darf das echte Gate nicht umgehen.
 await test('A Ready und späterer Scope-Zuwachs',async()=>{
  const x='grow-x.txt',y='grow-y.txt',o=project+'grow-o',w=project+'grow-w';
  for(const f of [x,y])await seed(f,'ALT\nFUSS\n');
  await R.addFileReservations({project,agentId:o,filePaths:[x,y]});
  const p=await plan(o,[sr(x,'ALT','OWNER')]),wx=sr(x,'FUSS','BEITRAG'),wy=sr(y,'FUSS','BEITRAG');
  await plan(w,[wx,wy]);await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,ops:[wx]});
  await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:w});await active(w);
  const changed=await B.replanBatch({project,plan_id:p.plan_id,agent_id:o,op_index:0,ops:[sr(x,'ALT','OWNER'),sr(y,'ALT','OWNER')]});
  ok(changed.plan_id===p.plan_id,'gemeinsamer Plan bleibt beim Scope-Zuwachs erhalten');
  const cm=await commit(p.plan_id,o);
  ok(cm.status==='waiting_for_contributors','bereits Ready reicht nach Scope-Zuwachs nicht',cm);
  const ready=await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:w}).catch(e=>({success:false,remaining_files:e.remaining_files}));
  ok(!ready.success&&ready.remaining_files?.includes(y),'Ready meldet neue Ziel-Datei',ready);
  const nc=await B.markCoeditNoChanges({project,plan_id:p.plan_id,agent_id:w,files:[y]});
  ok(nc.success&&!nc.remaining_files?.length,'no_changes schließt tatsächlichen Rest',nc);
  ok(nc.status==='linked'&&nc.message.includes('coedit_ready'),'gemischter Rest nennt tatsächlichen Status und nötiges Ready',nc);
  ok((await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:w})).success,'gemischten Beitrag ausdrücklich ready abschließen');
  const final=await commit(p.plan_id,o);ok(final.success,'Gate nach explizitem Ready offen',final);
 });
 // C: Plan-Op-Index ist nicht deferred_op_index; normalisierte Task-UUID ist Teil der Op.
 await test('C deferred-Index und Task-UUID',async()=>{
  const t1=randomUUID(),t2=randomUUID(),pid=randomUUID(),x='idx-x.txt',y='idx-y.txt',o=project+'idx-o',w=project+'idx-w';
  await pool.query('INSERT INTO plans(id,project,name,tasks) VALUES($1,$2,$3,$4::jsonb)',[pid,project,'Testaufgaben',JSON.stringify([{id:t1,kurz_id:'P1-T1',title:'Owner',status:'todo'},{id:t2,kurz_id:'P1-T2',title:'Beitrag',status:'todo'}])]);
  for(const f of [x,y])await seed(f,'ALT\nFUSS\n');
  const p=await plan(o,[sr(x,'ALT','OWNER'),sr(y,'ALT','OWNER')]),op={...sr(y,'FUSS','BEITRAG'),task_id:t2};
  const carrier=await plan(w,[op]),token=carrier.coedit_waits[0].wait_token;
  const s=await B.getBatchPlan(carrier.plan_id),map=s.coedit_waits[0].deferred_op_zuordnung;
  ok(map[0].deferred_op_index===0&&map[0].task_id===t2,'Status zeigt deferred-Index und normalisierte Task-UUID',map);
  const wrong=await attempt(()=>B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,wait_token:token,ops:[{...op,task_id:t1}]}));
  ok(!wrong.success&&/task_id/.test(wrong.error),'fremde Task-UUID passt nicht zur deferred-Op',wrong);
  const index=await attempt(()=>B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,wait_token:token,op_index:2,ops:[op]}));
  ok(!index.success,'globaler Plan-Index ist kein deferred-Index',index);
  const added=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,wait_token:token,op_index:0,ops:[op]});
  ok(added.success,'richtiger deferred-Index nimmt ursprüngliche Task-UUID an',added);
  await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:w});
  ok((await commit(p.plan_id,o)).success,'Taskgebundener Beitrag committed');
 });
 await test('B Ganzdatei-Vorschau und globaler Verursacherindex',async()=>{
  const x='whole-x.txt',y='whole-y.txt',o=project+'whole-o',w=project+'whole-w';
  for(const f of [x,y])await seed(f,base);
  const p=await plan(o,[sr(x,'OBEN','X'),{action:'update',file_path:y,content:base.replace('OBEN','A'),anchor_text:base}]);
  ok(p.previews[1].coedit_ganzdatei?.op_index===1,'Vorschau benennt Ganzdatei-Op1',p.previews);
  const op=sr(y,'UNTEN','B');await plan(w,[op]);
  const added=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:w,ops:[op]});
  const causes=added.overlap_warnings?.flatMap(x=>x.ganzdatei_ops??[]);
  ok(causes?.some(x=>x.op_index===1&&x.file_path===y),'coedit_add meldet globalen Ganzdatei-Verursacher1',added);
  await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:w});
  ok(!(await commit(p.plan_id,o)).success&&await read(y)===base,'Ganzdatei-Überschneidung bleibt atomarer Konflikt');
  await cancel(p.plan_id,o);
 });
 // 46ccab5b: Absturz des Owners, Gate eines aktiven Beiträgers, große gemeinsame Datei und genau-einmal.
 await test('100 Identitäten / 100000 Zeilen',async()=>{
  const f='stress-100k.txt',owner=project+'crashed',N=100;
  const initial=Array.from({length:100000},(_,i)=>'ZEILE-'+String(i).padStart(6,'0')).join('\n')+'\n';
  await seed(f,initial);
  const p=await plan(owner,[{...batch('ZEILE-000000','[STRESS-OWNER]'),file_path:f}]);
  const actors=Array.from({length:N},(_,i)=>({agent:project+'actor-'+i,op:batch('ZEILE-'+String((i+1)*900).padStart(6,'0'),'[STRESS-'+i+']')}));
  const started=Date.now();
  // Kleine gleichzeitige Gruppen: echte PG-Konflikte/Locks, keine gleichzeitigen Testprozesse.
  for(let i=0;i<N;i+=5)await Promise.all(actors.slice(i,i+5).map(async x=>{
   x.op.file_path=f;const carrier=await plan(x.agent,[x.op]);ok(!!carrier.coedit_waits?.length,'Stress Wait '+x.agent.slice(-3));
   const added=await B.addCoeditContribution({project,plan_id:p.plan_id,agent_id:x.agent,ops:[x.op]});
   ok(added.success&&!added.overlap_warnings?.length,'Stress disjunkter Beitrag '+x.agent.slice(-3),added);
   if(x!==actors[N-1])await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:x.agent});
  }));
  await active(actors[N-1].agent);
  const blocked=await commit(p.plan_id,actors[0].agent);
  ok(blocked.status==='waiting_for_contributors','Stress aktiver letzter Agent blockiert trotz abgestürztem Owner',blocked);
  const poll=commit(p.plan_id,actors[0].agent,8);
  await new Promise(r=>setTimeout(r,100));
  await B.markCoeditReady({project,plan_id:p.plan_id,agent_id:actors[N-1].agent});
  const result=await poll,text=await read(f);
  ok(result.success,'Stress Long-Poll nach Ready committed',result);
  for(const marker of ['[STRESS-OWNER]',...actors.map((_,i)=>'[STRESS-'+i+']')])ok(text.split(marker).length===2,'Stress genau einmal '+marker);
  ok(text.split('\n').length===100001,'Stress Zeilenzahl erhalten');
  console.log('BELEG P22-T198 STRESS '+short({plan_id:p.plan_id,actors:N,lines:100000,markers:101,elapsed_ms:Date.now()-started,mode:'Core-Protokoll-Identitäten, keine Modellagenten'}));
 });
}finally{
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]);
 for(const t of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_files','agent_events','tool_calls'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 await pool.query('DELETE FROM plans WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await D.closePool();
}
console.log((errors?'FEHLER ':'BESTANDEN ')+checks+' P22-T198 checks; Fehler='+errors);
process.exit(errors?1:0);
