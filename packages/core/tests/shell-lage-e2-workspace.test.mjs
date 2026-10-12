import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
/** P10-T36: echter fester Node-Lesehelfer über simulierten Docker-Transport. */
import assert from'node:assert/strict';

import{randomUUID}from'node:crypto';import{PassThrough}from'node:stream';
import{execFile}from'node:child_process';import{promisify}from'node:util';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const db=await import('../dist/db/client.js');
const{WorkspaceOrchestrator}=await import('../../rest-api/dist/services/workspace-orchestrator.js');
const root=await cleanup.createRoot('synapse-shell-e2-workspace-');
const project='test-e2-workspace-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
const run=promisify(execFile);const calls=[];
const container={exec:async(spec)=>{
 calls.push(spec);let output='';
 if(spec.Cmd[0]==='node'){
   assert.equal(spec.Cmd.length,4);assert.ok(!spec.Cmd[2].includes('printf E2_WORKSPACE'));
   output=(await run(process.execPath,spec.Cmd.slice(1),{cwd:root,env:{...process.env,ROOT:root}})).stdout;
 }else {assert.deepEqual(spec.Cmd,['/bin/sh','-c','printf E2_WORKSPACE']);output='E2_WORKSPACE';}
 return {start:async()=>{
   const stream=new PassThrough();setImmediate(()=>stream.end(output));return stream;
 },inspect:async()=>({ExitCode:0})};
}};
const orch=new WorkspaceOrchestrator();
orch.dockerAvailable=true;
orch.docker={getContainer:()=>container,modem:{demuxStream:(stream,stdout,stderr)=>{stream.pipe(stdout);stream.once('end',()=>stderr.end());}}};
orch.ensureProjectRunning=async()=> 'fixture';
orch.recordActivity=async()=>{};orch.appendToLog=async()=>{};
let seen=false;
const r=await orch.exec(project,'printf E2_WORKSPACE',{onLage:(lage)=>{seen=true;assert.ok(lage.hash);assert.equal(lage.cwd,root);}});
assert.equal(seen,true);assert.equal(r.exitCode,0);assert.equal(r.stdout,'E2_WORKSPACE');
assert.equal(calls[0].Cmd[0],'node');assert.equal(calls.at(-1).Cmd[0],'/bin/sh');
calls.length=0;
await assert.rejects(()=>orch.exec(project,'printf E2_WORKSPACE',{onLage:()=>{throw Error('test_gate');}}),/test_gate/);
assert.ok(calls.every(c=>c.Cmd[0]==='node'),'Nutzerbefehl nach Gate-Ablehnung nie gestartet');
console.log('P10-T36 Workspace: fester read-only Helper, Daten-argv, Preflight/Gate gruen.');


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
