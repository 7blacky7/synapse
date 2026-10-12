import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
/** P10-T36 Preflight: nur printf ausführen; Gate-Reihenfolge und Maske. */
import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';


const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const db=await import('../dist/db/client.js');
const {execShellInProject:rawExecShellInProject}=await import('../dist/services/shell-exec.js');
const execShellInProject=trackShellStreams(cleanup,rawExecShellInProject);
const {ermittleShellLage}=await import('../dist/services/shell-lage.js');
const {maskiereShellDaten}=await import('../dist/services/shell-maske.js');
const root=await cleanup.createRoot('synapse-shell-e2-hook-');
const project='test-shell-e2-hook-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
const events=[];
const r=await execShellInProject({project,command:'printf E2_OK',onLage:(lage)=>{
 assert.equal(lage.cwd,root);assert.ok(lage.hash);events.push('lage');
},onStarted:()=>events.push('start')});
assert.deepEqual(events,['lage','start']);assert.equal(r.exit_code,0);assert.deepEqual(r.tail,['E2_OK']);
let started=false;
await assert.rejects(()=>execShellInProject({project,command:'printf never',onLage:()=>{throw Error('test_gate');},onStarted:()=>started=true}),/test_gate/);
assert.equal(started,false);
const raw=await ermittleShellLage('rm "$TOKENFILE"',{shell:'bash',os:'linux',cwd:root,project_root:root,env:{TOKENFILE:'fake-sensitive-value'},inspect:false});
assert.ok(!JSON.stringify(maskiereShellDaten(raw,['fake-sensitive-value']).daten).includes('fake-sensitive-value'));
console.log('P10-T36 Preflight vor Spawn, Gate-Abbruch, sol-1-Maske gruen.');


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
