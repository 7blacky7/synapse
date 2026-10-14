import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const{getPool,closePool}=await import('../dist/db/client.js');
const{enqueueShellJob,claimPendingShellJob,waitForShellJob,getShellJobById}=await import('../dist/services/shell-queue.js');
const{runClaimedJob}=await import('../../file-watcher-daemon-ts/dist/shell-job-worker.js');
const root=await cleanup.createRoot('synapse-e3-worker-'),project='test-e3-worker-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
await getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
const args={project,command:'printf E3_WORKER',agent_id:'sol-2',target:'local'};
const old=await enqueueShellJob(args);
await getPool().query("INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,bereich,project,positiv,negativ,gefaehrlich)VALUES($1,1,'text','rueckfrage',$2::jsonb,'fs.rm','owned-test','aktiv','projekt',$3,'[]','[]','true'::jsonb)",['owned-'+randomUUID(),JSON.stringify({command:['^printf$']}),project]);
await runClaimedJob(project,await claimPendingShellJob(project,'owned-worker'));
const denied=await waitForShellJob(old.id,1000);
// P10-T71 (6a9bbef8): 'anleitung' laeuft nur noch mit Warnhinweis; vor dem Start anhalten (Koordinator-Bestaetigung) gibt es
// seit P10-T73 (7c83bf3c) nur fuer 'rueckfrage' mit Gefahrkennzeichen. Die eigene Regel ist deshalb rueckfrage + gefaehrlich.
assert.equal(denied.status,'rejected');assert.equal(denied.ausgefuehrt,false);assert.equal(denied.stufe,'rueckfrage');
assert.equal((await getShellJobById(old.id)).sicherung.audit.agent_id,'sol-2');
const grant={grund:'Eigene ungefährliche Workerprobe',...denied.bestaetigungsdaten};
const approved=await enqueueShellJob({...args,agent_id:'koordinator',bestaetigt:grant});
await runClaimedJob(project,await claimPendingShellJob(project,'owned-worker'));
const result=await waitForShellJob(approved.id,1000);assert.equal(result.status,'done');assert.deepEqual(result.tail,['E3_WORKER']);assert.equal(result.ausgefuehrt,true);
assert.equal((await getShellJobById(approved.id)).sicherung.audit.entscheidung,'bestaetigt');
const{mitUserHerkunft}=await import('../dist/services/user-herkunft.js');
const forged=await enqueueShellJob({...args,agent_id:'user',bestaetigt:grant,herkunft:{akteur:'user',kanal:'tray'}});
await runClaimedJob(project,await claimPendingShellJob(project,'owned-worker'));
assert.equal((await waitForShellJob(forged.id,1000)).error,'nur_koordinator');
const real=await mitUserHerkunft('tray',()=>enqueueShellJob({...args,agent_id:'user',bestaetigt:grant}));
await runClaimedJob(project,await claimPendingShellJob(project,'owned-worker'));
assert.equal((await waitForShellJob(real.id,1000)).status,'done','serverseitige Herkunft muss Worker-Wechsel überleben');
console.log('P10-T37 Worker: Altjob neu geprüft, kein Originalstart, Rollenbestätigung und Audit im selben Job grün.');


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
