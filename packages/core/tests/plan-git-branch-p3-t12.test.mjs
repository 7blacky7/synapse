/** P3-T12: git_branch an Plan/Task, Vererbung und Transportwege; nur synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='t12_'+randomUUID().replaceAll('-',''),project='t12-'+randomUUID();
url.searchParams.set('options','-c search_path='+schema+',public');
Object.assign(process.env,{DATABASE_URL:url.toString(),SYNAPSE_DATABASE_URL:url.toString(),JEV_OPENROUTER_API_KEY:'',OLLAMA_URL:'http://127.0.0.1:9',QDRANT_URL:'http://127.0.0.1:9'});
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
let app,client;
const unpack=r=>{let x=r.structuredContent??r;while(x?.content?.[0]?.text)x=JSON.parse(x.content[0].text);return x;};
try {
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id INTEGER NOT NULL DEFAULT 0');
 const alterStart=process.hrtime.bigint();
 await pool.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS git_branch TEXT');
 const alterMs=Number(process.hrtime.bigint()-alterStart)/1e6;
 await pool.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS git_branch TEXT');
 assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='plans' AND column_name='git_branch'",[schema])).rowCount,1);
 const branchAlterStart=process.hrtime.bigint();
 await pool.query("ALTER TABLE hinweis_optionen ADD COLUMN IF NOT EXISTS geschuetzter_hauptbranch TEXT NOT NULL DEFAULT 'main'");
 const branchAlterMs=Number(process.hrtime.bigint()-branchAlterStart)/1e6;
 await pool.query("ALTER TABLE hinweis_optionen ADD COLUMN IF NOT EXISTS geschuetzter_hauptbranch TEXT NOT NULL DEFAULT 'main'");
 assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='hinweis_optionen' AND column_name='geschuetzter_hauptbranch'",[schema])).rowCount,1);
 const P=await import('../dist/services/plans.js');P.planIndex.sync=async()=>{};
 assert.equal(typeof P.pruefeGitBranch,'function','RED: Plan-Service muss Git-Branchnamen pruefen');
 for(const name of ['feature/t12','topic/Abc_123','release-2026.10']){
  assert.equal(P.pruefeGitBranch(name),name);
  execFileSync('git',['check-ref-format','--branch',name],{stdio:'ignore'});
 }
 for(const name of ['','-feature','bad..name','bad//name','bad/','.hidden','x/.hidden','x/end.lock','bad name','bad\\name','bad@{name}','main']){
  assert.throws(()=>P.pruefeGitBranch(name),undefined,name);
  if(name!=='main')assert.throws(()=>execFileSync('git',['check-ref-format','--branch',name],{stdio:'ignore'}),undefined,name);
 }
 assert.equal(P.pruefeGitBranch('master'),'master','Standard: nur main ist geschuetzt');
 assert.equal(P.pruefeGitBranch('main','master'),'main','mit geschuetztem master bleibt main erlaubt');
 assert.throws(()=>P.pruefeGitBranch('master','master'),/geschuetzt/i);
 const H=await import('../dist/services/hinweis-drossel.js');
 assert.equal((await H.projektHauptbranchStatus(project,'koordinator')).geschuetzter_hauptbranch,'main');
 await assert.rejects(H.projektHauptbranchOption(project,'t14-agent','master'),/Koordinator/);
 await H.projektHauptbranchOption(project,'koordinator','master');
 assert.equal((await H.projektHauptbranchStatus(project,'koordinator')).geschuetzter_hauptbranch,'master');
 await assert.rejects(P.createPlan(project,'Verboten','',[],{git_branch:'master'}),/git_branch/i);
 const plan=await P.createPlan(project,'Core branch','test',[],{git_branch:'feature/plan'});
 const inherited=await P.addTask(project,'erbt','', 'medium',plan.id);
 assert.equal(inherited.git_branch,'feature/plan');
 const override=await P.addTask(project,'override','', 'medium',plan.id,'feature/task');
 assert.equal(override.git_branch,'feature/task');
 const updated=await P.updateTask(project,override.id,{git_branch:'feature/task-neu'},plan.id);
 assert.equal(updated.git_branch,'feature/task-neu');
 await P.updatePlan(project,{git_branch:'feature/plan-neu'},plan.id);
 const gelesen=await P.getPlan(project,plan.id);
 assert.equal(gelesen.git_branch,'feature/plan-neu');
 assert.equal(gelesen.tasks.find(t=>t.id===inherited.id).git_branch,'feature/plan-neu');
 assert.equal(gelesen.tasks.find(t=>t.id===override.id).git_branch,'feature/task-neu');
 const ohne=await P.createPlan(project,'Ohne Branch','test');
 const taskOhne=await P.addTask(project,'aktuell','', 'medium',ohne.id);
 assert.equal(taskOhne.git_branch,undefined,'leerer Branch wird weggelassen');
 assert.equal(taskOhne.git_branch_hinweis,undefined,'direkte Task-Antwort wiederholt den Plan-Hinweis nicht');
 const planOhne=await P.getPlan(project,ohne.id);
 assert.equal(planOhne.git_branch,undefined,'plan(get) laesst leeren Plan-Branch weg');
 assert.match(planOhne.git_branch_hinweis,/aktuelle Arbeitsbranch/,'Hinweis bleibt einmalig am Plan');
 const gelesenOhne=planOhne.tasks.find(t=>t.id===taskOhne.id);
 assert.equal(gelesenOhne.git_branch,undefined,'plan(get) laesst leeren Task-Branch weg');
 assert.equal(gelesenOhne.git_branch_hinweis,undefined,'plan(get) wiederholt den Plan-Hinweis nicht an der Task');
 await assert.rejects(P.createPlan(project,'Verboten','',[],{git_branch:'master'}),/git_branch/i);
 await assert.rejects(P.updatePlan(project,{git_branch:'bad..name'},plan.id),/git_branch/i);
 await assert.rejects(P.addTask(project,'Verboten','', 'medium',plan.id,'master'),/git_branch/i);
 await assert.rejects(P.updateTask(project,inherited.id,{git_branch:'bad//name'},plan.id),/git_branch/i);

 const req=createRequire(new URL('../../rest-api/package.json',import.meta.url));app=req('fastify')({logger:false});
 await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
 const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const server=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url));
 const transport=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
 const plans=fileURLToPath(new URL('../dist/services/plans.js',import.meta.url));
 client=new Client({name:'t12-test',version:'1'});const env={...process.env};delete env.SYNAPSE_AGENT_NAME;
 const stdio=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval','const {planIndex}=await import('+JSON.stringify(plans)+');planIndex.sync=async()=>{};const {createServer}=await import('+JSON.stringify(server)+');const {StdioServerTransport}=await import('+JSON.stringify(transport)+');await createServer().connect(new StdioServerTransport());'],env,stderr:'pipe'});
 stdio.stderr?.resume();await client.connect(stdio);
 for(const mode of ['rest','stdio']){
  const call=async args=>{const input={name:'plan',arguments:{project,agent_id:'t12-agent',...args}};
   return unpack(mode==='rest'?(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:input}})).json().result:await client.callTool(input));};
  const projectCall=async args=>{const input={name:'project',arguments:{project,agent_id:'t14-agent',...args}};
   return unpack(mode==='rest'?(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:input}})).json().result:await client.callTool(input));};
  const gesetzt=await projectCall({action:'hinweise',agent_id:'koordinator',geschuetzter_hauptbranch:'master'});
  assert.equal(gesetzt.geschuetzter_hauptbranch,'master',JSON.stringify(gesetzt));
  const statusKoordinator=await projectCall({action:'status',agent_id:'koordinator'});
  assert.equal(statusKoordinator.projekt_optionen?.geschuetzter_hauptbranch,'master',JSON.stringify(statusKoordinator));
  const statusAgent=await projectCall({action:'status'});
  assert.equal(statusAgent.projekt_optionen,undefined,'Hauptbranch-Einstellung ist nur Koordinator/User zugaenglich');
  const verweigert=await projectCall({action:'hinweise',geschuetzter_hauptbranch:'trunk'});
  assert.match(JSON.stringify(verweigert),/Koordinator|User/i);
  const created=await call({action:'create',name:'Transport '+mode,description:'test',git_branch:'feature/'+mode});
  assert.ok(created.success!==false,JSON.stringify(created));
  const planId=created.plan_ref?.id??created.plan?.id;
  assert.ok(planId,JSON.stringify(created));
  const added=await call({action:'add_task',plan_id:planId,title:'erbt '+mode,description:'test'});
  assert.ok(added.success!==false,JSON.stringify(added));const addedTask=added.task??added;assert.equal(addedTask.git_branch,'feature/'+mode);
  const get=await call({action:'get',plan_id:planId});
  const gotPlan=get.plan??get;assert.equal(gotPlan.git_branch,'feature/'+mode);
  const gotTask=(gotPlan.tasks??get.tasks).find(t=>t.id===addedTask.id);
  assert.equal(gotTask.git_branch,'feature/'+mode,'git_branch ist auch kompakt sichtbar');
  const changed=await call({action:'update_task',plan_id:planId,task_id:addedTask.id,git_branch:'feature/task-'+mode});
  assert.equal(changed.task?.git_branch,'feature/task-'+mode);
  await call({action:'update',plan_id:planId,git_branch:'master'}).then(r=>assert.match(JSON.stringify(r),/git_branch|master/i));
  const bad=await call({action:'update',plan_id:planId,git_branch:'feature/plan-neu'});
  assert.ok(bad.success!==false,JSON.stringify(bad));
  const final=await call({action:'get',plan_id:planId});
  const finalPlan=final.plan??final;assert.equal(finalPlan.git_branch,'feature/plan-neu');
  assert.equal((finalPlan.tasks??final.tasks).find(t=>t.id===addedTask.id).git_branch,'feature/task-'+mode);
  const branchlos=await call({action:'create',name:'Ohne Branch '+mode,description:'test'});
  const branchlosId=branchlos.plan_ref?.id??branchlos.plan?.id;
  assert.ok(branchlosId,JSON.stringify(branchlos));
  const branchlosTask=await call({action:'add_task',plan_id:branchlosId,title:'kein Branch '+mode,description:'test'});
  const branchlosGet=await call({action:'get',plan_id:branchlosId});
  const branchlosPlan=branchlosGet.plan??branchlosGet;
  assert.equal(branchlosPlan.git_branch,undefined,mode+': leeres git_branch-Feld am Plan fehlt');
  assert.match(branchlosPlan.git_branch_hinweis,/aktuelle Arbeitsbranch/,mode+': Plan-Hinweis bleibt erhalten');
  const branchlosTasks=branchlosPlan.tasks??branchlosGet.tasks;
  const branchlosReadTask=branchlosTasks.find(t=>t.id===(branchlosTask.task??branchlosTask).id);
  assert.ok(branchlosReadTask,JSON.stringify(branchlosGet));
  assert.equal(branchlosReadTask.git_branch,undefined,mode+': leeres git_branch-Feld an der Task fehlt');
  assert.equal(branchlosReadTask.git_branch_hinweis,undefined,mode+': Task wiederholt den Plan-Hinweis nicht');
  console.log('PASS '+mode+': create/update, add/update task, kompakter get, Vererbung/Override, branchloser Hinweis');
 }
 console.log('PASS P3-T12/T14: Git-Format, Projekt-Schutzbranch, Migration plans '+alterMs.toFixed(3)+' ms, hinweis_optionen '+branchAlterMs.toFixed(3)+' ms, REST+stdio');
} finally {
 await client?.close();await app?.close();await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await closePool();
}
