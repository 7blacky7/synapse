import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
/** P10-T37: echte feste Lageprobe, nur Docker-Transport simuliert. */
import assert from'node:assert/strict';

import{randomUUID}from'node:crypto';import{PassThrough}from'node:stream';
import{execFile}from'node:child_process';import{promisify}from'node:util';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const db=await import('../dist/db/client.js');
const{WorkspaceOrchestrator}=await import('../../rest-api/dist/services/workspace-orchestrator.js');
const root=await cleanup.createRoot('synapse-shell-e2-workspace-');
const project='test-e3-workspace-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
const run=promisify(execFile);const calls=[];
const isRootGuard=spec=>spec.Cmd[0]==='/bin/sh'&&spec.Cmd[1]==='-ec'&&spec.Cmd[2].startsWith('/bin/chown 1000:1000 /workspace && /bin/chmod 0755 /workspace');
const isUserCommand=spec=>spec.User==='1000:1000'&&spec.Cmd[0]==='/usr/bin/env'&&spec.Cmd[1]==='-i'&&JSON.stringify(spec.Cmd.slice(-3))===JSON.stringify(['/bin/sh','-c','printf E3_WORKSPACE'])&&spec.Cmd.includes('SYNAPSE_PROJECT='+project)&&spec.Cmd.slice(2,-3).every(a=>/^[A-Za-z_]\w*=/.test(a));
const container={inspect:async()=>({Config:{Env:[]},State:{Running:true}}),exec:async(spec)=>{
 calls.push(spec);let output='';
 if(isRootGuard(spec)){
   assert.equal(spec.User,'0');output=''; // Quellschutz-Aufruf erfolgreich quittieren
 }else if(spec.Cmd[0]==='node'){
   assert.equal(spec.Cmd.length,4);assert.ok(!spec.Cmd[2].includes('printf E3_WORKSPACE'));
   output=(await run(process.execPath,spec.Cmd.slice(1),{cwd:root,env:{...process.env,ROOT:root}})).stdout;
 }else {assert.ok(isUserCommand(spec),'nur der erwartete Shell-Nutzerbefehl wird ausgeführt');output='E3_WORKSPACE';}
 return {start:async()=>{
   const stream=new PassThrough();setImmediate(()=>stream.end(output));return stream;
 },inspect:async()=>({ExitCode:0})};
}};
const orch=new WorkspaceOrchestrator();
orch.dockerAvailable=true;
orch.docker={getContainer:()=>container,modem:{demuxStream:(stream,stdout,stderr)=>{stream.pipe(stdout);stream.once('end',()=>stderr.end());}}};
orch.ensureProjectRunning=async()=> 'fixture';
orch.recordActivity=async()=>{};orch.appendToLog=async()=>{};
await db.getPool().query("INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,bereich,project,positiv,negativ,gefaehrlich)VALUES($1,1,'text','rueckfrage',$2::jsonb,'fs.rm','owned-test','aktiv','projekt',$3,'[]','[]','true'::jsonb)",['owned-'+randomUUID(),JSON.stringify({command:['^printf$']}),project]);
const denied=await orch.exec(project,'printf E3_WORKSPACE',{agent_id:'sol-2'});
assert.equal(denied.ausgefuehrt,false);assert.equal(denied.stufe,'rueckfrage');
assert.ok(calls.some(isRootGuard),'Quellschutz wird quittiert');assert.ok(!calls.some(isUserCommand),'Originalbefehl bei Ablehnung nicht gestartet');
const grant={grund:'Eigene ungefährliche Workspaceprobe',...denied.bestaetigungsdaten};
calls.length=0;
let seen=false;
const r=await orch.exec(project,'printf E3_WORKSPACE',{agent_id:'koordinator',bestaetigt:grant,onLage:(lage)=>{seen=true;assert.ok(lage.hash);assert.equal(lage.cwd,root);}});
assert.equal(seen,true);assert.equal(r.exitCode,0);assert.equal(r.stdout,'E3_WORKSPACE');
assert.ok(isRootGuard(calls[0]),'Quellschutz der Workspace-Wurzel wird vor Probe und Befehl quittiert');assert.ok(isUserCommand(calls.at(-1)),'eigentlichen Shell-Befehl prüfen');
calls.length=0;
await assert.rejects(()=>orch.exec(project,'printf E3_WORKSPACE',{onLage:()=>{throw Error('test_gate');}}),/test_gate/);
assert.ok(calls.some(isRootGuard),'Quellschutz wird quittiert');assert.ok(!calls.some(isUserCommand),'Nutzerbefehl nach Gate-Ablehnung nie gestartet');
console.log('P10-T37 Workspace: native Lage, kein Originalspawn ohne Bestätigung, Rollenbestätigung grün.');


}finally{
 globalThis.fetch=oldFetch;
 try{
  try{
   if(fixtureApp)await fixtureApp.close();
   if(fixtureProjects.length){
    const pool=(await import('../dist/db/client.js')).getPool();
    const{rows}=await pool.query('SELECT stream_id FROM shell_jobs WHERE project=ANY($1::text[]) AND stream_id IS NOT NULL',[fixtureProjects]);
    for(const row of rows)cleanup.trackStreamId(row.stream_id);
    await pool.query('DELETE FROM projects WHERE name=ANY($1::text[])',[fixtureProjects]);
   }
  }finally{await(await import('../dist/db/client.js')).closePool();}
 }finally{await cleanup.cleanup();cleanup.dispose();}
}
