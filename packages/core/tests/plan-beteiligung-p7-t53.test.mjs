/**
 * P7-T53: reale CAS-/JSON-/Statusstrecke in eigenem Schema von synapse_test.
 * node packages/core/tests/plan-beteiligung-p7-t53.test.mjs
 * Rotkontrolle: T53_ROOT=/tmp/synapse-basis-a252a940 T53_RED_ONLY=1 node <dieses Skript>
 * Ergebnis am t103: zweite Anmeldung scheitert "bereits zugewiesen" (kein fehlender Export).
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';

const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='t53_'+randomUUID().replaceAll('-',''),project='t53-'+randomUUID();
url.searchParams.set('options','-c search_path='+schema+',public');
Object.assign(process.env,{DATABASE_URL:url.toString(),SYNAPSE_DATABASE_URL:url.toString(),
  QDRANT_URL:'http://127.0.0.1:9',SYNAPSE_SKIP_EMBEDDINGS:'1'});
const root=process.env.T53_ROOT||fileURLToPath(new URL('../../../',import.meta.url));
const imp=p=>import(pathToFileURL(path.join(root,p)).href);
const C=await imp('packages/core/dist/index.js'),pool=C.getPool();
C.planIndex.sync=async()=>{};C.taskIndex.sync=async()=>{};
const planId=randomUUID(),taskId=randomUUID(),legacyId=randomUUID();
const a=project+'-a',b=project+'-b',sub=project+'-sub',codex=project+'-codex';
const clone=async table=>pool.query('CREATE TABLE "'+schema+'".'+table+' (LIKE public.'+table+' INCLUDING ALL)');
const task=(id,n,extra={})=>({id,kurz_id:'P1-T'+n,title:'Beteiligung '+n,description:'Fixture',
  status:'todo',priority:'medium',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',
  empfehlung:{spawn_alias:'opus[1m]',effort:'high',kontext:'1m'},...extra});
const stored=async()=>JSON.parse(JSON.stringify((await pool.query('SELECT tasks FROM plans WHERE id=$1',[planId])).rows[0].tasks));
try{
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for(const t of ['plans','agent_sessions','wrapper_status','model_registry'])await clone(t);
 // Test-DB-Basis kann vor P3-T12 liegen; nur das eigene Schema ergaenzen.
 await pool.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS git_branch TEXT');
 await pool.query(`INSERT INTO plans(id,project,name,description,goals,tasks,kurz_id,aktiv,naechste_task_nr)
   VALUES($1,$2,'T53','synthetisch','{}',$3::jsonb,'P1',true,3)`,
   [planId,project,JSON.stringify([task(taskId,1),task(legacyId,2,{zugewiesen_an:'legacy',zugewiesen_am:'2026-10-01T00:00:00Z',status:'in_progress'})])]);
 for(const id of [a,b,sub,codex])await pool.query("INSERT INTO agent_sessions(id,project,model,status)VALUES($1,$2,$3,'active')",[id,project,id===codex?'gpt-6.1-sol':'opus[1m]']);
 for(const id of [a,b])await C.upsertWrapperStatus({agentName:id,project,model:'opus[1m]',effort:'high',status:'running'});
 const one=await C.uebernehmeTask(project,'P1','P1-T1',a);assert.equal(one.success,true,JSON.stringify(one));
 const two=await C.uebernehmeTask(project,'P1','P1-T1',b);
 assert.equal(two.success,true,'zweite Anmeldung muss gelingen: '+JSON.stringify(two));
 assert.deepEqual(two.task.beteiligte.map(x=>x.agent_id),[a,b]);
 console.log('T53 Positivkontrolle PASS: zwei Agenten gemeinsam angemeldet');
 if(!process.env.T53_RED_ONLY){
  assert.match(two.hinweise.join(' '),/history/);assert.match(two.hinweise.join(' '),/op_indices/);
  const before=(await stored())[0].beteiligte;
  assert.equal((await C.uebernehmeTask(project,'P1','P1-T1',a)).bereits_angemeldet,true);
  assert.deepEqual((await stored())[0].beteiligte,before,'idempotent, seit bleibt');
  const third=await C.uebernehmeTask(project,'P1','P1-T1',sub);
  assert.equal(third.success,true,JSON.stringify(third));assert.equal(third.task.beteiligte.length,3);
  assert.match(third.hinweise.join(' '),/Ab 3/);
  await pool.query("UPDATE wrapper_status SET status='stopped' WHERE project=$1 AND agent_name=$2",[project,a]);
  await pool.query("UPDATE agent_sessions SET status='inactive' WHERE project=$1 AND id=$2",[project,a]);
  assert.equal((await C.uebernehmeTask(project,'P1','P1-T1',codex)).success,true);
  const read=await C.getPlan(project,'P1'),first=read.tasks.find(t=>t.id===taskId);
  assert.equal(first.beteiligte.find(x=>x.agent_id===a).status,'inaktiv');
  assert.equal(first.beteiligte.find(x=>x.agent_id===sub).status,'aktiv');
  assert.equal(read.tasks.find(t=>t.id===legacyId).beteiligte[0].agent_id,'legacy');
  const list=await C.passendeTasks(project,codex,'P1');
  assert.equal(list.success,true,JSON.stringify(list));assert.equal(list.profil.model,'gpt-6.1-sol');
  assert.ok(list.tasks.some(t=>t.task_id===taskId),'laufende Task wird nicht ausgeblendet');
  assert.equal((await C.passendeTasks(project,'ohne-session','P1')).profil,'Profil unbekannt');
  // Gleicher Name in fremdem Projekt darf den Aktivitaetsstatus nicht liefern.
  await C.upsertWrapperStatus({agentName:'legacy',project:project+'-fremd',model:'opus',status:'running'});
  assert.equal((await C.getPlan(project,'P1')).tasks.find(t=>t.id===legacyId).beteiligte[0].status,'inaktiv');
  for(const id of [a,b,sub]){const r=await C.meldeTaskAb(project,undefined,taskId,id);assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.task.status,'in_progress');}
  const last=await C.meldeTaskAb(project,undefined,'P1-T1',codex);assert.equal(last.task.status,'todo');assert.deepEqual(last.task.beteiligte,[]);
  assert.equal(last.task.zugewiesen_an,null);
  // Echte konkurrierende UPDATEs: der zweite Versuch liest den neuen Beteiligtenstand.
  const race=await Promise.all([a,b].map(id=>C.uebernehmeTask(project,'P1','P1-T1',id)));
  assert.ok(race.every(r=>r.success),JSON.stringify(race));
  assert.deepEqual(new Set((await stored())[0].beteiligte.map(x=>x.agent_id)),new Set([a,b]));
  await C.updateTask(project,taskId,{status:'done'},'P1');
  await C.meldeTaskAb(project,'P1',taskId,a);
  assert.equal((await C.meldeTaskAb(project,'P1',taskId,b)).task.status,'done');
  await C.updateTask(project,legacyId,{status:'todo'},'P1');
  assert.deepEqual((await stored())[1].beteiligte,[]);assert.equal((await stored())[1].zugewiesen_an,null);
  assert.ok((await stored()).every(t=>(t.beteiligte??[]).every(x=>Object.keys(x).sort().join(',')==='agent_id,seit')));
  console.log('T53 Core PASS: Profile, Legacy, Status, Idempotenz, CAS-Race, Abmeldung, Reset');

  const {handleToolCall}=await imp('packages/rest-api/dist/routes/mcp.js');
  const {planTool}=await imp('packages/mcp-server/dist/tools/consolidated/plan.js');
  for(const mode of ['rest','stdio']){
   const call=args=>mode==='rest'?handleToolCall('plan',{project,agent_id:sub,...args},sub):planTool.handler({project,agent_id:sub,...args});
   const args={plan_id:'P1',task_id:'P1-T2'};
   const u=await call({...args,action:'uebernehmen'});assert.equal(u.success,true,JSON.stringify(u));
   const g=await call({...args,action:'get',compact:true});
   const t=(g.tasks??g.plan?.tasks).find(t=>t.id===legacyId);assert.equal(t.beteiligte[0].agent_id,sub);
   const l=await call({action:'passende_tasks',plan_id:'P1'});assert.ok(l.tasks.some(t=>t.task_id===legacyId));
   const reset=await call({...args,action:'update_task',status:'todo',agent_id:'koordinator'});assert.equal(reset.success,true,JSON.stringify(reset));
   assert.deepEqual(reset.task.beteiligte,[]);
   await call({...args,action:'uebernehmen'});
   assert.equal((await call({...args,action:'abmelden'})).task.status,'todo');
   assert.equal((await call({...args,action:'abmelden'})).success,true);
  }
  console.log('T53 REST/stdio PASS: Anmelden, kompakte Beteiligte, passende_tasks, Reset, Abmelden');
 }
}finally{
 await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
 await C.closePool();
}
