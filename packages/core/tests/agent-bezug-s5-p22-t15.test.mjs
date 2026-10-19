/**
 * P22-T15 S5: reale PostgreSQL-Verträge, eigenes temporäres Schema in synapse_test.
 * Standard: neue Identitätsstrecken; T15_S5_GOLDEN=1: Legacy-Snapshot.
 * T15_S5_ROOT=/tmp/synapse-basis-89d1c7a7 T15_S5_RED=1: Verhaltens-Rotkontrolle.
 * T15_S5_SNAPSHOT=/tmp/...json speichert Laufzeitresultate für den Golden-Vergleich.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const defaultMode=process.env.T15_S5_MODE||'beide';
const oldFetch=globalThis.fetch;let networkCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw Error('S5: Netzwerk/Modelle im Test gesperrt');};
const schema='sol35_t15_'+randomUUID().replaceAll('-',''),project='sol35-t15-'+randomUUID();
url.searchParams.set('options','-c search_path='+schema+',public');
Object.assign(process.env,{DATABASE_URL:url.href,SYNAPSE_DATABASE_URL:url.href,
 QDRANT_URL:'http://127.0.0.1:9',OLLAMA_URL:'http://127.0.0.1:9',SYNAPSE_SKIP_EMBEDDINGS:'1',
 SYNAPSE_AGENT_BEZUG_MODUS:defaultMode,SYNAPSE_RESERVATION_TTL_GRACE_MINUTES:'0'});
delete process.env.SYNAPSE_INTERN_TOOL;
const root=process.env.T15_S5_ROOT||fileURLToPath(new URL('../../../',import.meta.url));
const imp=p=>import(pathToFileURL(path.join(root,'packages/core/dist/'+p+'.js')).href);
const C=await imp('index'),DB=await imp('db/client'),R=await imp('services/file-reservations'),
 F=await imp('services/file-batch'),V=await imp('services/file-versions'),
 Q=await imp('services/shell-queue'),T=await imp('services/tool-call-log'),
 Z=await imp('services/file-task-zuordnung'),H=await imp('services/shell-hints'),
 K=await imp('services/shell-rueckfrage'),D=await imp('services/shell-demaskierung');
const B=await imp('services/agent-bezug').catch(e=>{
 if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;
 return {mitAgentAufrufKontext:(_k,fn)=>fn()};
});
const pool=DB.getPool(),q=(s,a=[])=>pool.query(s,a);
C.planIndex.sync=async()=>{};C.taskIndex.sync=async()=>{};
let checks=0;const ok=n=>console.log('PASS '+(++checks)+' '+n);
const ids=[randomUUID(),randomUUID()],runs=[randomUUID(),randomUUID()],name='worker';
const principals=ids.map((id,i)=>({art:'identity',project,agent_id:name,identity_id:id,
 rolle:'subagent',modell:'gpt-6.1-sol',context_epoch:i+2,lauf_id:runs[i]}));
const run=(who,fn,modus=defaultMode)=>B.mitAgentAufrufKontext({
 principal:who===null?{art:'legacy',project,agent_id:name}:principals[who],
 bezug:{modus,standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},fn);
const resArgs=f=>({project,agentId:name,filePaths:[f]});
const row=async(t,id)=>(await q('SELECT * FROM '+t+' WHERE id=$1',[id])).rows[0];
const base='one\ntwo\nthree\nfour\nfive\nsix\n';
const create=async f=>{
 const p=await run(null,()=>F.planBatch({project,agent_id:'setup',ops:[{action:'create',file_path:f,content:base}]}));
 assert(p.plan_id,JSON.stringify(p));
 assert.equal((await run(null,()=>F.commitBatch({plan_id:p.plan_id,agent_id:'setup'}))).success,true);
};
const edit=(f,line,anchor,text)=>({action:'replace_lines',file_path:f,line_start:line,line_end:line,anchor_text:anchor,content:text});
const activity=who=>run(who,()=>T.logToolCall({project,agentId:name,tool:'code_intel',action:'file',ok:true}));
try{
 await q('CREATE SCHEMA '+schema);
 const tables=await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
 for(const {tablename} of tables.rows)await q('CREATE TABLE "'+schema+'"."'+tablename+'" (LIKE public."'+tablename+'" INCLUDING ALL)');
 // Additive fixtures also support an older public test-DB schema. Never execute against public.
 for(const file of ['111_agent_identitaet.sql','112_agent_bezug.sql'])
  await q(readFileSync(new URL('../src/db/schema-sql/'+file,import.meta.url),'utf8'));
 await q(readFileSync(new URL('../src/db/schema-sql/105_plan_tasks.sql',import.meta.url),'utf8'));
 for(let i=0;i<2;i++){
  await q("INSERT INTO agent_identitaeten(id,project,name,instanz_nr,agent_id,erstellt_von)VALUES($1,$2,'worker',$3,$4,'test')",
   [ids[i],project,i+1,i?name+'#2':name]);
  await q("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status)VALUES($1,$2,$3,'aktiv')",[runs[i],ids[i],i+2]);
  await q("INSERT INTO agent_identitaet_sitzungen(identity_id,project,agent_id,model)VALUES($1,$2,$3,'gpt-6.1-sol')",[ids[i],project,i?name+'#2':name]);
 }
 await q("INSERT INTO agent_sessions(id,project,model,status)VALUES($1,$2,'legacy-model','active')",[name,project]);
 const planId=randomUUID(),taskId=randomUUID();
 await q("INSERT INTO plans(id,project,name,kurz_id,tasks)VALUES($1,$2,'S5','P1',$3::jsonb)",
 [planId,project,JSON.stringify([{id:taskId,kurz_id:'P1-T1',title:'Test',description:'synthetisch',status:'todo',priority:'medium',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}])]);

 if(process.env.T15_S5_GOLDEN){
  const snap={};
  const norm=(value,key='')=>{
   if(value instanceof Date)return '<zeit>';
   if(Array.isArray(value))return value.map(v=>norm(v,key));
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,norm(v,k)]));
   if(value!==null&&/(?:^id$|plan_id$|batch_id$|version_id$)/.test(key))return '<id>';
   if(typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value))return '<zeit>';
   if(typeof value==='string')return value.replaceAll(project,'<project>').replace(/plan_id:'[0-9]+'/g,"plan_id:'<id>'");
   return value;
  };
  await run(null,async()=>{
   const rs=await R.addFileReservations(resArgs('coedit-test/legacy.txt'));
   snap.reservations=norm(rs);
   snap.reservationKeys=Object.keys(rs[0]).filter(k=>!['id','reserved_at','expires_at','last_extended_at'].includes(k)).sort();
   snap.ownReservations=(await R.listFileReservations({project,agentId:name})).map(r=>r.file_path);
   snap.release=(await R.releaseFileReservations(resArgs('coedit-test/legacy.txt'))).released.length;
   await create('coedit-test/golden.txt');
   const p=await F.planBatch({project,agent_id:name,ops:[edit('coedit-test/golden.txt',1,'one','ONE')]});
   const status=F.buildPlanStatusResponse(await F.getBatchPlan(p.plan_id));
   snap.status=norm(status);
   snap.statusKeys=Object.keys(status).sort();
   snap.commit=(await F.commitBatch({plan_id:p.plan_id,agent_id:name})).success;
   snap.content=(await q('SELECT content FROM code_files WHERE project=$1 AND file_path=$2',[project,'coedit-test/golden.txt'])).rows[0].content;
   await activity(null);
   const logs=await T.queryToolCalls({project,agentId:[name]});
   snap.audit=logs.map(r=>({agent:r.agent_id,keys:Object.keys(r).filter(k=>!['id','ts','project'].includes(k)).sort()}));
   snap.join=(await C.uebernehmeTask(project,'P1','P1-T1',name)).success;
   snap.participants=(await q('SELECT tasks FROM plans WHERE id=$1',[planId])).rows[0].tasks[0].beteiligte.map(({seit,...r})=>r);
   const bind={art:'befehl',project,agent_id:name,befehl_hash:'x',lage_hash:'y',regelversion:'1'};
   const challenge=K.stelleShellRueckfrage(bind);
   snap.challenge=K.loeseShellRueckfrageEin(challenge.bestaetigung_id,'synthetische Bestätigung',bind);
  },'alt');
  if(process.env.T15_S5_SNAPSHOT)writeFileSync(process.env.T15_S5_SNAPSHOT,JSON.stringify(snap,null,2)+'\n');
  console.log(JSON.stringify(snap));ok('Legacy-Golden erfasst');
 }else{
  const f='coedit-test/res.txt';
  await run(0,()=>R.addFileReservations(resArgs(f)));
  await run(1,()=>R.addFileReservations(resArgs(f)));
  // Positivkontrolle auf t107 erreicht dieselbe produktive Operation, keinen fehlenden Export.
  const distinct=await run(0,()=>R.listFileReservations({project,filePaths:[f]}));
  assert.equal(distinct.length,2,'zwei gleichnamige Token-Principals behalten zwei Reservierungen');
  ok('Rotkontrolle: zwei gleichnamige Principals separat reserviert');
  if(!process.env.T15_S5_RED){
   await run(null,()=>R.addFileReservations(resArgs(f)));
   assert.equal((await run(0,()=>R.listFileReservations({project,filePaths:[f]}))).length,3);
   for(const who of [0,1,null])assert.equal((await run(who,()=>R.listFileReservations({project,agentId:name,filePaths:[f]}))).length,1);
   assert.equal((await run(1,()=>R.releaseFileReservations(resArgs(f)))).released.length,1);
   assert.equal((await run(0,()=>R.listFileReservations({project,agentId:name,filePaths:[f]}))).length,1);
   const update=await run(0,()=>R.updateFileReservations({project,agentId:name,keepPaths:[f],addPaths:['coedit-test/added.txt']}));
   assert.equal(update.kept.length,1);assert.equal(update.added.length,1);
   ok('Token/Token/Legacy gemeinsamer Blick, eigene Filter/Release/Keep/Add');

   await create('coedit-test/shared.txt');
   const p=await run(0,()=>F.planBatch({project,agent_id:name,ops:[{...edit('coedit-test/shared.txt',1,'one','ONE'),author_identity_id:ids[1]}]}));
   assert.equal((await row('file_batch_plans',p.plan_id)).owner_identity_id,ids[0]);
   assert.equal((await row('file_batch_plans',p.plan_id)).ops[0].author_identity_id,ids[0]);
   const wb=await run(1,()=>F.planBatch({project,agent_id:name,ops:[edit('coedit-test/shared.txt',3,'three','THREE')]}));
   assert.equal(wb.coedit_waits[0].target_plan_id,p.plan_id);
   await run(1,()=>F.addCoeditContribution({project,plan_id:p.plan_id,agent_id:name,ops:[edit('coedit-test/shared.txt',3,'three','THREE')]}));
   await activity(1);
   const waiting=await run(0,()=>F.commitBatch({plan_id:p.plan_id,agent_id:name}));
   assert.equal(waiting.status,'waiting_for_contributors',JSON.stringify(waiting));
   assert.equal(waiting.waiting_for[0].identity_id,ids[1]);
   await run(1,()=>F.markCoeditReady({project,plan_id:p.plan_id,agent_id:name}));
   assert.equal((await run(0,()=>F.commitBatch({plan_id:p.plan_id,agent_id:name}))).success,true);
   const authors=(await q("SELECT DISTINCT author_identity_id FROM file_versions WHERE project=$1 AND batch_id=$2 AND author_identity_id IS NOT NULL",[project,p.plan_id])).rows.map(x=>x.author_identity_id).sort();
   assert.deepEqual(authors,[...ids].sort());
   assert.equal((await row('file_batch_plans',p.plan_id)).committed_by_identity_id,ids[0]);
   ok('Coedit gleichnamige Autoren, serverseitige Attribution, Ready pro ID, zwei Autorversionen');

   await create('coedit-test/withdraw.txt');
   const wp=await run(0,()=>F.planBatch({project,agent_id:name,ops:[edit('coedit-test/withdraw.txt',1,'one','FIRST')]}));
   await run(1,()=>F.planBatch({project,agent_id:name,ops:[edit('coedit-test/withdraw.txt',3,'three','SECOND')]}));
   await run(1,()=>F.addCoeditContribution({project,plan_id:wp.plan_id,agent_id:name,ops:[edit('coedit-test/withdraw.txt',3,'three','SECOND')]}));
   await run(0,()=>F.cancelBatch(wp.plan_id,name,'eigener Rückzug'));
   assert.equal((await row('file_batch_plans',wp.plan_id)).owner_identity_id,ids[1]);
   assert.equal((await row('file_batch_plans',wp.plan_id)).ops.length,1);
   await assert.rejects(()=>run(null,()=>F.cancelBatch(wp.plan_id,name,'Legacy darf nicht übernehmen'),'alt'),/agent_bezug_nicht_freigegeben/);
   assert.equal((await row('file_batch_plans',wp.plan_id)).status,'open');
   // Nach Owner-Handoff ist dessen alter Wait geschlossen; Owner braucht kein ready.
   assert.equal((await run(1,()=>F.commitBatch({plan_id:wp.plan_id,agent_id:name}),'neu')).success,true);
   ok('Withdraw übergibt Owner-ID; Rückwechsel alt erhält und schützt Zustand; neu setzt fort');

   const history=await run(0,()=>V.listFileHistory(project,{agent_id:name}));
   assert(history.length>0&&history.every(v=>v.author_identity_id===ids[0]));
   const ownVersion=history.find(v=>!v.task_id);
   await assert.rejects(()=>run(1,()=>Z.ordneFileTasksZu({project,agent_id:name,task_id:taskId,version_ids:[ownVersion.id]})),/Nicht berechtigt/);
   await assert.rejects(()=>run(null,()=>Z.ordneFileTasksZu({project,agent_id:name,task_id:taskId,version_ids:[ownVersion.id]})),/Nicht berechtigt/);
   assert.equal((await run(0,()=>Z.ordneFileTasksZu({project,agent_id:name,task_id:taskId,version_ids:[ownVersion.id]}))).success,true);
   assert.equal((await q('SELECT actor_identity_id FROM file_version_task_zuordnungen WHERE version_id=$1',[ownVersion.id])).rows[0].actor_identity_id,ids[0]);
   ok('Versionsfilter + Nachzuordnung nur eigener Autor, auditierte Actor-ID');

   for(const who of [0,1,null])assert.equal((await run(who,()=>C.uebernehmeTask(project,'P1','P1-T1',name))).success,true);
   const task=(await q('SELECT tasks FROM plans WHERE id=$1',[planId])).rows[0].tasks[0];
   assert.equal(task.beteiligte.length,3);assert.equal(task.zugewiesen_an,name);
   assert.deepEqual((await q('SELECT task FROM plan_tasks WHERE id=$1',[taskId])).rows[0].task.beteiligte,task.beteiligte);
   await run(0,()=>C.meldeTaskAb(project,'P1',taskId,name));
   assert.equal((await q('SELECT tasks FROM plans WHERE id=$1',[planId])).rows[0].tasks[0].beteiligte.length,2);
   ok('Task-JSON/Projektion drei Bezüge, ID-eigene Abmeldung');

   await Promise.all([activity(0),activity(1),activity(null)]);
   for(const who of [0,1,null]){
    const calls=await run(who,()=>T.queryToolCalls({project,agentId:[name]}));
    // P22-T55 (User 19.10.): ein Name im Filter findet ohne eigenen Ausweis (Legacy/Koordinator) auch die Ausweis-Eintraege
    // gleichnamiger Identitaeten; der eigene Name eines Ausweis-Agenten meint weiter nur ihn selbst.
    assert(calls.length>0);assert(who===null?calls.some(r=>!r.identity_id)&&calls.every(r=>!r.identity_id||ids.includes(r.identity_id)):calls.every(r=>r.identity_id===ids[who]));
    if(who!==null){assert(calls.every(r=>r.context_epoch===who+2&&r.lauf_id===runs[who]));
     assert((await run(who,()=>T.queryToolCalls({project,agentId:['identity:'+ids[1]]}))).every(r=>r.identity_id===ids[1]));}
   }
   ok('Toolaudit filtert ID/Legacy und speichert Epoch');

   const job=await run(0,()=>Q.enqueueShellJob({project,command:'pnpm run build',agent_id:name}));
   const attached=await run(1,()=>Q.enqueueShellJob({project,command:'pnpm run build',agent_id:name}));
   assert.equal(attached.id,job.id);assert.equal(attached.attached,true);
   assert.equal((await row('shell_jobs',job.id)).owner_identity_id,ids[0]);
   assert.equal((await q("SELECT identity_id FROM shell_job_agent_bezuege WHERE job_id=$1 AND role='attached'",[job.id])).rows[0].identity_id,ids[1]);
   assert.equal((await run(1,()=>Q.cancelShellJob(job.id,name))).ok,false);
   assert.equal((await run(null,()=>Q.cancelShellJob(job.id,name))).ok,false);
   assert.equal((await run(1,()=>Q.hideShellJobHints(job.id,name))).ok,false);
   assert.equal((await run(null,()=>Q.cancelShellJob(job.id,name),'alt')).error,'agent_bezug_nicht_freigegeben');
   assert.equal((await run(0,()=>Q.cancelShellJob(job.id,name))).ok,true);
   assert.equal((await row('shell_jobs',job.id)).cancelled_by_identity_id,ids[0]);
   for(const who of [0,1]){
    const hints=await run(who,()=>H.claimShellJobHints(project,name));
    assert(hints.some(h=>h.job_id===job.id));
    assert.equal((await run(who,()=>H.claimShellJobHints(project,name))).length,0);
   }
   ok('Shell gemeinsamer exec_key, getrennte Anhänger/Notices, Cancel/Hide nur Owner');

   const bind={art:'befehl',project,agent_id:name,befehl_hash:'x',lage_hash:'y',regelversion:'1'};
   const challenge=await run(0,()=>K.stelleShellRueckfrage(bind));
   for(const who of [1,null])assert.equal((await run(who,()=>K.loeseShellRueckfrageEin(challenge.bestaetigung_id,'synthetische Bestätigung',bind))).error,'bestaetigung_fremder_agent');
   assert.equal((await run(0,()=>K.loeseShellRueckfrageEin(challenge.bestaetigung_id,'synthetische Bestätigung',bind))).ok,true);
   await run(1,()=>D.trageShellDemaskierungEin(job.id,project,{bestaetigung_id:'fixture',agent_id:name,grund:'synthetischer Testgrund',maskieren_bis:new Date(Date.now()+60000).toISOString()}));
   assert.equal((await q('SELECT actor_identity_id FROM shell_demaskierungen WHERE job_id=$1',[job.id])).rows[0].actor_identity_id,ids[1]);
   ok('Rückfrage nicht durch Gleichnamige einlösbar; Demaskierung auditiert ID');

   // Nur eigene neue Aktivität verlängert eine fällige Reservierung.
   const ttl='coedit-test/ttl.txt';
   for(const who of [0,1])await run(who,()=>R.addFileReservations({...resArgs(ttl),planId:p.plan_id}));
   await q('DELETE FROM tool_calls WHERE project=$1',[project]);
   await q("UPDATE agent_identitaet_file_reservations SET reserved_at=NOW()-INTERVAL '20 minutes',last_extended_at=NOW()-INTERVAL '20 minutes',expires_at=NOW()+INTERVAL '1 minute' WHERE project=$1 AND file_path=$2",[project,ttl]);
   const before=(await q('SELECT identity_id,expires_at FROM agent_identitaet_file_reservations WHERE project=$1 AND file_path=$2',[project,ttl])).rows;
   await activity(0);
   await run(null,()=>R.renewFileReservationTtls({project,filePaths:[ttl]}));
   const after=(await q('SELECT identity_id,expires_at FROM agent_identitaet_file_reservations WHERE project=$1 AND file_path=$2',[project,ttl])).rows;
   assert(after.find(r=>r.identity_id===ids[0]).expires_at>before.find(r=>r.identity_id===ids[0]).expires_at);
   assert.equal(+after.find(r=>r.identity_id===ids[1]).expires_at,+before.find(r=>r.identity_id===ids[1]).expires_at);
   await q("UPDATE agent_identitaet_sitzungen SET status='inactive' WHERE identity_id=$1",[ids[1]]);
   await run(null,()=>R.releaseStaleFileReservations({project}));
   assert.equal((await run(1,()=>R.listFileReservations({project,agentId:name,filePaths:[ttl]}))).length,0);
   assert.equal((await run(0,()=>R.listFileReservations({project,agentId:name,filePaths:[ttl]}))).length,1);
   await q("UPDATE agent_identitaet_sitzungen SET status='active' WHERE identity_id=$1",[ids[1]]);
   const take='coedit-test/takeover.txt';
   await run(0,()=>R.addFileReservations(resArgs(take)));
   await q("UPDATE agent_identitaet_file_reservations SET expires_at=NOW()-INTERVAL '1 minute' WHERE project=$1 AND file_path=$2",[project,take]);
   await q('DELETE FROM tool_calls WHERE project=$1',[project]);
   await run(1,()=>R.addFileReservations(resArgs(take)));
   const taken=(await q('SELECT * FROM agent_identitaet_file_reservations WHERE project=$1 AND file_path=$2 AND identity_id=$3',[project,take,ids[0]])).rows[0];
   assert(taken.released_at);assert.equal(taken.taken_over_by_identity_id,ids[1]);
   const exp='coedit-test/expired.txt';
   await run(0,()=>R.addFileReservations(resArgs(exp)));
   await q("UPDATE agent_identitaet_file_reservations SET expires_at=NOW()-INTERVAL '1 minute' WHERE project=$1 AND file_path=$2",[project,exp]);
   assert((await run(null,()=>R.releaseStaleFileReservations({project}))).abgelaufen>=1);
   ok('TTL eigene Aktivität, inaktive ID isoliert, Takeover-Actor und Ablauf-Reaper');

   const E=await imp('services/events');
   const pending=await run(1,()=>E.getPendingEvents(project,name,100));
   const committed=pending.find(e=>e.eventType==='PLAN_COMMITTED');
   assert(committed,'Coedit-Folgeevent gehört wartender Identität');
   assert(!(await run(null,()=>E.getPendingEvents(project,name,100))).some(e=>e.id===committed.id));
   await run(1,()=>E.acknowledgeEvent(committed.id,name,'S5 geprüft'));
   assert(!(await run(1,()=>E.getPendingEvents(project,name,100))).some(e=>e.id===committed.id));
   assert.equal((await q('SELECT identity_id FROM agent_identitaet_event_acks WHERE event_id=$1',[committed.id])).rows[0].identity_id,ids[1]);
   assert.equal((await q('SELECT count(*)::int n FROM agent_event_acks WHERE event_id=$1',[committed.id])).rows[0].n,0);
   ok('Coedit-Folgeevent/ACK bleibt ID-gebunden; Legacy-ACK unberührt');

   await create('coedit-test/late.txt');
   const lp=await run(0,()=>F.planBatch({project,agent_id:name,ops:[{action:'insert_after',file_path:'coedit-test/late.txt',after_line:1,content:'extra1\nextra2'}]}));
   const lateOp=edit('coedit-test/late.txt',5,'five','FIVE');
   await run(1,()=>F.planBatch({project,agent_id:name,ops:[lateOp]}));
   assert.equal((await run(0,()=>F.commitBatch({plan_id:lp.plan_id,agent_id:name}))).success,true);
   const late=await run(1,()=>F.addCoeditContribution({project,plan_id:lp.plan_id,agent_id:name,ops:[lateOp]}));
   assert.equal(late.follow_up,true,JSON.stringify(late));
   assert.equal((await row('file_batch_plans',late.plan_id)).owner_identity_id,ids[1]);
   assert.equal((await run(1,()=>F.commitBatch({plan_id:late.plan_id,agent_id:name}))).success,true);
   const text=(await q('SELECT content FROM code_files WHERE project=$1 AND file_path=$2',[project,'coedit-test/late.txt'])).rows[0].content;
   assert.equal(text,'one\nextra1\nextra2\ntwo\nthree\nfour\nFIVE\nsix\n');
   ok('Später Beitrag folgt ID und korrigierter Zeile in Folgeplan');

   const S=await imp('services/shell-start-sicherung'),seed=(await imp('services/shell-sicherung-seed')).SHELL_SICHERUNG_SEED;
   const katalog={...structuredClone(seed),regeln:[{id:'s5-marker',version:1,art:'text',stufe:'rueckfrage',
    muster:{command:['^printf$'],argv_any:['^S5_MARKER$']},antwort_id:'fs.rm',quelle:'test',status:'aktiv',gefaehrlich:true}]};
   const lage={shell:'bash',os:'linux',cwd:'/tmp/s5',project_root:'/tmp/s5',variablen:[],ziele:[],ungeklaert:[],sicher_aufloesbar:true,hash:'synthetic'};
   const input={project,command:'printf S5_MARKER',lage,agent_id:'koordinator',agent_identity_id:ids[0]};
   // Kein Principal im Queueworker: Name koordinator darf gespeicherte ID nicht privilegieren.
   const neutral=fn=>B.mitAgentAufrufKontext({principal:null,bezug:{modus:'beide',standard:'alt',quelle:'standard',bis:null,letzter_fehler:null}},fn);
   const first=neutral(()=>S.pruefeShellStart(input,katalog));
   const bestaetigt={...first.antwort.bestaetigungsdaten,grund:'synthetisch geprüft'};
   const denied=neutral(()=>S.pruefeShellStart({...input,bestaetigt},katalog));
   assert.equal(denied.darf_starten,false);assert.equal(denied.antwort.error,'nur_koordinator');
   const allowed=neutral(()=>S.pruefeShellStart({...input,bestaetigt,agent_koordination_erlaubt:true},katalog));
   assert.equal(allowed.darf_starten,true);assert.equal(allowed.audit.identity_id,ids[0]);
   ok('Neutraler Worker übernimmt keine Namensrolle; verifizierte Freigabe positiv');

   const W=await imp('services/code-write'),A=await imp('services/tool-aktivitaet');
   const direct='coedit-test/direct.txt';
   await run(0,()=>W.createFileInPg(project,direct,'first\n',name));
   await run(0,()=>W.snapshotFileVersion(project,direct,'snapshot','synthetisch',name));
   await run(1,()=>W.updateFileInPg(project,direct,'second\n',name));
   const versions=await V.listFileVersions(project,direct);
   assert.deepEqual(new Set(versions.map(v=>v.author_identity_id)),new Set(ids));
   const original=(await Promise.all(versions.map(v=>V.getFileVersion(v.id,false,{roh:true})))).find(v=>v.author_identity_id===ids[0]&&v.content==='first\n');
   assert(original,'Snapshot des Autors vor zweitem Write vorhanden');
   await run(1,()=>V.restoreFileVersion(original.id,name,'synthetischer Restore'));
   const restored=await V.listFileVersions(project,direct);
   assert.equal(restored[0].author_identity_id,ids[1]);
   assert.equal((await q('SELECT content FROM code_files WHERE project=$1 AND file_path=$2',[project,direct])).rows[0].content,'first\n');
   assert(restored.some(v=>v.id===original.id&&v.author_identity_id===ids[0]));
   const descriptor={toolId:'s5-test',tool:'files',aktivitaetsAktionen:['read']};
   const activation=await run(0,()=>A.erfasseToolAktivitaet({project,tool:'files',aktion:'read',agentId:name,akzeptiert:true,zaehltAlsAktivitaet:true},
    {descriptor,gebundenesProjekt:project,berechtigt:true}));
   assert.equal(activation.identity_id,ids[0]);assert.equal(activation.zaehlt_als_aktivitaet,true);
   ok('Direktwrites und Restore auditieren ausführende ID, Originalhistorie bleibt; Toolaktivität trägt ID');


  }
 }
 assert.equal(networkCalls,0,'keine Modell-/HTTP-Aufrufe');
 console.log('P22-T15 S5 PASS '+checks+' Gruppen; MODE='+defaultMode+'; network=0');
}finally{
 globalThis.fetch=oldFetch;
 K.leereShellRueckfragen();
 await q('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
 await DB.closePool();
}
