import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, rm, mkdtemp} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
process.env.SYNAPSE_DB_IDLE_MS='100';
process.env.SYNAPSE_WRAPPER_STOP_MS='1500';
import vm from 'node:vm';
import ts from '../packages/core/node_modules/typescript/lib/typescript.js';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433'); assert.equal(url.pathname,'/synapse_test');
const {getPool,closePool}=await import('../packages/core/dist/db/client.js');
const pool=getPool();
if(process.argv.includes('--api-pool')) {
 assert.equal(pool.options.max,20);assert.equal(pool.options.connectionTimeoutMillis,0);
 const {getHintergrundPool}=await import('../packages/core/dist/db/client.js');assert.equal(getHintergrundPool().options.max,8);
 await closePool();console.log('OK API-Pool Golden max20, Hintergrund8, Connect-Frist0');process.exit(0);
}
let failed=0;
async function check(name,fn) {try {await fn();console.log('OK '+name)}catch(e){failed++;console.log('FEHLER '+name+': '+e.message)}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
await check('Stop nach Sicherzug beendet inneren Prozess und Wrapper',async()=>{
 const source=await readFile(new URL('../packages/agents/src/wrapper.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('wrapper.ts',source,ts.ScriptTarget.Latest,true);
 const names=['handleStop','gracefulShutdown'];
 const funcs=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));
 assert.equal(funcs.length,2,'echte Wrapper-Funktionen vorhanden');
 let stopped=0,cleaned=0,exited=0;
 const context=vm.createContext({log:()=>{},shuttingDown:false,shutdownStarted:false,stopDeadline:null,STOP_FRIST_MS:1500,processAlive:true,agentBusy:false,
 AGENT_NAME:'sol3-t34-fake',wakeAgent:async()=>({content:'MEMORY_SAVED'}),cleanup:async()=>{cleaned++},
 processManager:{stop:async()=>{stopped++}},process:{exit:()=>{exited++}},
 setTimeout,clearTimeout,Promise});
 vm.runInContext(ts.transpile(funcs.map(n=>n.getText(ast)).join('\n')),context);
 await vm.runInContext('handleStop()',context); await pause(180);
 assert.equal(stopped,1);assert.equal(cleaned,1);assert.equal(exited,1);
});
await check('Pool-Grundprofil gemessen',async()=>{console.log('POOL='+JSON.stringify({max:pool.options.max,idleTimeoutMillis:pool.options.idleTimeoutMillis}));assert.ok(pool.options.max<=3,'Wrapper/Daemon sollen höchstens3 Query-Verbindungen nutzen')});
await check('Fremder Prozess mit gleicher PG-PID bleibt unangetastet',async()=>{
 const project='sol3-t34-'+randomUUID(),name='sol3-t34-probe';
 const root=resolve('coedit-test');await mkdir(root,{recursive:true});
 const dir=await mkdtemp(join(root,'sol3-t34-'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,env:{...process.env,SYNAPSE_AGENT_NAME:name,SYNAPSE_PROJECT_NAME:project,SYNAPSE_PROJECT_PATH:dir},stdio:'ignore'});
 try {
  await pause(100);
  await pool.query('INSERT INTO projects(name,path,hostname) VALUES($1,$2,$3)',[project,dir,hostname()]);
  await pool.query("INSERT INTO wrapper_status(agent_name,project,wrapper_pid,status) VALUES($1,$2,$3,'idle')",[name,project,child.pid]);
  const {stopSpecialistTool}=await import('../packages/mcp-server/dist/tools/specialists.js');
  const response=await stopSpecialistTool(name,dir,project);
  const result=JSON.parse(response.content[0].text);
  console.log('STOP_RESULT='+JSON.stringify(result));
  assert.equal(result.success,false);assert.match(result.message,/UNGEPRUEFT/);
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);process.kill(child.pid,0);
 } finally {
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await pool.query('DELETE FROM wrapper_status WHERE project=$1',[project]);
  await pool.query('DELETE FROM projects WHERE name=$1',[project]);
  await rm(dir,{recursive:true,force:true});
 }
});

await check('Kleiner Pool: Last, drei LISTEN-Verbindungen und Idle-Abbau',async()=>{
 const {verbindeListenClient}=await import('../packages/core/dist/db/client.js');
 const clients=await Promise.all([verbindeListenClient(),verbindeListenClient(),verbindeListenClient()]);
 try {
  await Promise.all(clients.map(c=>c.query('LISTEN sol3_t34_test')));
  await Promise.all(Array.from({length:12},()=>pool.query('SELECT pg_sleep(0.02)')));
  assert.ok(pool.totalCount<=3);console.log('QUERY_PEAK='+pool.totalCount+' LISTEN='+clients.length);
  await pause(350);assert.equal(pool.totalCount,0,'Idle-Queryverbindungen abgebaut');
 }finally{await Promise.all(clients.map(c=>c.end()))}
});
async function wrapperProbe(hang) {
 const project='sol3-t34-'+randomUUID(),name='sol3-t34-wrapper';
 const root=resolve('coedit-test');await mkdir(root,{recursive:true});
 const dir=await mkdtemp(join(root,'sol3-t34-')),bin=join(dir,'bin'),socket=join(dir,'wrapper.sock');
 await mkdir(bin);
 const cli=hang ? "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);" :
 "require('node:readline').createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({type:'result',result:'MEMORY_SAVED',usage:{input_tokens:1,output_tokens:1}})));";
 await writeFile(join(bin,'claude'),'#!'+process.execPath+'\n'+cli,{mode:0o700});
 await writeFile(join(dir,'prompt.txt'),'Isolierter sol-3 Test, keine Werkzeuge.');
 await pool.query('INSERT INTO projects(name,path,hostname) VALUES($1,$2,$3)',[project,dir,hostname()]);
 const child=spawn(process.execPath,[resolve('packages/agents/dist/wrapper.js')],{cwd:dir,env:{...process.env,PATH:bin+':'+process.env.PATH,SYNAPSE_AGENT_NAME:name,SYNAPSE_AGENT_MODEL:'sonnet',SYNAPSE_PROJECT_NAME:project,SYNAPSE_PROJECT_PATH:dir,SYNAPSE_SOCKET_PATH:socket,SYNAPSE_SYSTEM_PROMPT_FILE:join(dir,'prompt.txt'),SYNAPSE_WRAPPER_STOP_MS:'1500',SYNAPSE_KEEP_ALIVE:'1',SYNAPSE_WRAPPER_TRANSPORT:'pg',SYNAPSE_WISSEN_QUELLE:'datei'},stdio:['ignore','ignore','pipe']});
 let logs='',inner;
 child.stderr.on('data',b=>{logs+=b.toString()});
 let worker,app;
 try {
  for(let i=0;i<150;i++){
   const {rows}=await pool.query('SELECT inner_pid FROM wrapper_status WHERE project=$1 AND wrapper_pid=$2',[project,child.pid]);
   if(rows[0]?.inner_pid){inner=Number(rows[0].inner_pid);break}
   if(child.exitCode!==null)throw new Error('Wrapperstart: '+logs.slice(-1800));
   await pause(50);
  }
  assert.ok(inner,'Wrapper hat eigene innere PID registriert: '+logs.slice(-1800));
  const {pruefeWrapperProzess}=await import('../packages/core/dist/services/wrapper-prozess.js');
  assert.equal((await pruefeWrapperProzess(child.pid,name,project,dir)).zustand,'wrapper');
  await rm(join(dir,'.synapse','agents','status.json'),{force:true});
  const start=Date.now();
  let result;
  if(hang) {
   const {stopSpecialistTool}=await import('../packages/mcp-server/dist/tools/specialists.js');
   result=JSON.parse((await stopSpecialistTool(name,dir,project)).content[0].text);
  } else {
   const {startSpecialistJobWorker}=await import('../packages/file-watcher-daemon-ts/dist/specialist-job-worker.js');
   worker=await startSpecialistJobWorker(()=>[project]);
   const {default:Fastify}=await import('../packages/rest-api/node_modules/fastify/fastify.js');
   const {specialistRoutes}=await import('../packages/rest-api/dist/routes/specialists.js');
   app=Fastify();await app.register(specialistRoutes);
   const response=await app.inject({method:'POST',url:'/api/projects/'+project+'/specialists/'+name+'/stop'});
   assert.equal(response.statusCode,200,response.body);
   result=response.json();
   if(result.content)result=JSON.parse(result.content[0].text);
  }
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.steps.prozess_beendet,true);
  assert.ok(child.exitCode!==null||child.signalCode!==null,'Wrapper beendet');
  assert.throws(()=>process.kill(inner,0),'innerer FakeCLI-Prozess beendet');
  console.log('WRAPPER_STOP hang='+hang+' ms='+(Date.now()-start)+' exit='+child.exitCode);
  assert.ok(Date.now()-start<8000,'Gesamtfrist einschließlich Sicherzug begrenzt');
 } finally {
  await app?.close();await worker?.stop();
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  if(inner){try{process.kill(inner,'SIGKILL')}catch{}}
  await pool.query('DELETE FROM specialist_jobs WHERE project=$1',[project]);
  await pool.query('DELETE FROM wrapper_status WHERE project=$1',[project]);
  await pool.query('DELETE FROM projects WHERE name=$1',[project]);
  await rm(dir,{recursive:true,force:true});
 }
}
await check('REST-Stop ohne Projektpfad über lokalen Worker, PG-PID, eigener echter Wrapper',()=>wrapperProbe(false));
await check('Hängender Sicherzug/innerer Prozess endet innerhalb Gesamtfrist',()=>wrapperProbe(true));
await check('Reaper markiert nur alte tote lokale Wrapper',async()=>{
 const project='sol3-t34-'+randomUUID(),root=resolve('coedit-test');
 const dir=await mkdtemp(join(root,'sol3-t34-'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const dead=spawn(process.execPath,['-e',''],{stdio:'ignore'});
 await new Promise(r=>dead.once('exit',r));
 try {
  await pool.query('INSERT INTO projects(name,path,hostname) VALUES($1,$2,$3)',[project,dir,hostname()]);
  await pool.query("INSERT INTO wrapper_status(agent_name,project,wrapper_pid,status,last_activity) VALUES ('dead',$1,$2,'running',NOW()-interval '1 hour'),('foreign',$1,$3,'idle',NOW()-interval '1 hour'),('fresh',$1,$2,'idle',NOW())",[project,dead.pid,child.pid]);
  const {reapLokaleWrapper}=await import('../packages/core/dist/services/wrapper-prozess.js');
  assert.equal(await reapLokaleWrapper([project]),1);
  const {rows}=await pool.query('SELECT agent_name,status FROM wrapper_status WHERE project=$1 ORDER BY agent_name',[project]);
  assert.deepEqual(rows,[{agent_name:'dead',status:'crashed'},{agent_name:'foreign',status:'idle'},{agent_name:'fresh',status:'idle'}]);
  process.kill(child.pid,0);
 }finally{
  child.kill('SIGKILL');
  await pool.query('DELETE FROM wrapper_status WHERE project=$1',[project]);
  await pool.query('DELETE FROM projects WHERE name=$1',[project]);
  await rm(dir,{recursive:true,force:true});
 }
});


await check('Stop-Queue nur Zielhost; fremder Host/mehrdeutiges Projekt abgewiesen',async()=>{
 const {enqueueSpecialistJob,claimPendingSpecialistJob}=await import('../packages/core/dist/services/specialist-queue.js');
 const project='sol3-t34-'+randomUUID(),path=resolve('coedit-test');
 try{
  await pool.query('INSERT INTO projects(name,path,hostname) VALUES($1,$2,$3)',[project,path,hostname()]);
  const {id}=await enqueueSpecialistJob({project,action:'stop',args:{name:'eigener-test'}});
  const {rows}=await pool.query('SELECT args FROM specialist_jobs WHERE id=$1',[id]);
  assert.equal(rows[0].args.target_hostname,hostname());
  assert.equal(await claimPendingSpecialistJob(project,'daemon-fremd-1','fremd'),null);
  assert.equal((await claimPendingSpecialistJob(project,'daemon-'+hostname()+'-1',hostname()))?.id,id);
  await pool.query('INSERT INTO projects(name,path,hostname) VALUES($1,$2,$3)',[project,path+'-anderer-host','fremd']);
  await assert.rejects(()=>enqueueSpecialistJob({project,action:'stop',args:{name:'eigener-test'}}),/nicht eindeutig/);
  const {lokalerProjektpfad,reapLokaleWrapper}=await import('../packages/core/dist/services/wrapper-prozess.js');
  assert.equal(await lokalerProjektpfad(project),null,'Mehrhost-Projekt nicht raten');
  assert.equal(await reapLokaleWrapper([project]),0);
 }finally{
  await pool.query('DELETE FROM specialist_jobs WHERE project=$1',[project]);
  await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 }
});

await check('Wiederverwendete PID: Startzeitwechsel verhindert jedes Signal',async()=>{
 const source=await readFile(new URL('../packages/core/src/services/wrapper-prozess.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('wrapper-prozess.ts',source,ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='stoppeLokalenWrapper');
 assert.ok(fn,'echte Stop-Funktion');
 let calls=0,kills=0;
 const context=vm.createContext({exports:{},getPool:()=>({query:async()=>({rows:[{wrapper_pid:123}]})}),
 lokalerProjektpfad:async()=>'/test',pruefeWrapperProzess:async()=>({zustand:'wrapper',start:String(++calls)}),
 process:{kill:()=>{kills++},env:{}},Date,Number,setTimeout});
 vm.runInContext(ts.transpile(fn.getText(ast),{module:ts.ModuleKind.CommonJS}),context);
 const result=await vm.runInContext("stoppeLokalenWrapper('test','/test','projekt')",context);
 assert.equal(result.success,false);assert.equal(calls,2);assert.equal(kills,0);
});

await closePool();
console.log('FEHLER='+failed);process.exit(failed?1:0);
