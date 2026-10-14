import{createTestFixtureCleanup,trackShellStreams}from'./_helfer/test-fixture-cleanup.mjs';
import{fixtureCleanupCheckpoint}from'./_helfer/fixture-cleanup-checkpoint.mjs';
import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cleanup=createTestFixtureCleanup();const oldFetch=globalThis.fetch;const fixtureProjects=[];let fixtureApp;
try{
const{getPool,closePool}=await import('../dist/db/client.js');
const{shellTool}=await import('../../mcp-server/dist/tools/consolidated/shell.js');
const root=await cleanup.createRoot('synapse-e3-stdio-'),project='test-e3-stdio-'+randomUUID();
fixtureProjects.push(project);cleanup.trackProject(project);await fixtureCleanupCheckpoint();
await getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
await getPool().query("INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,bereich,project,positiv,negativ,gefaehrlich)VALUES($1,1,'text','rueckfrage',$2::jsonb,'fs.rm','owned-test','aktiv','projekt',$3,'[]','[]','true'::jsonb)",['owned-'+randomUUID(),JSON.stringify({command:['^printf$']}),project]);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
const args={action:'exec',project,command:'printf E3_STDIO',agent_id:'sol-2',target:'local'};
const call=async(extra={})=>JSON.parse((await shellTool.handler({...args,...extra})).content[0].text);
// P10-T71 (6a9bbef8): 'anleitung' laeuft nur noch mit Warnhinweis; vor dem Start anhalten (Koordinator-Bestaetigung) gibt es
// seit P10-T73 (7c83bf3c) nur fuer 'rueckfrage' mit Gefahrkennzeichen. Die eigene Regel ist deshalb rueckfrage + gefaehrlich.
const denied=await call();assert.equal(denied.status,'rejected');assert.equal(denied.ausgefuehrt,false);assert.equal(denied.stufe,'rueckfrage');
const rows=(await getPool().query('SELECT id,sicherung FROM shell_jobs WHERE project=$1',[project])).rows;
assert.equal(rows.length,1,'stdio darf Core-Audit nicht mit zweitem History-Job verdoppeln');assert.equal(rows[0].id,denied.id);
assert.equal(rows[0].sicherung.audit.agent_id,'sol-2');
const approved=await call({agent_id:'koordinator',bestaetigt:{grund:'Eigene ungefährliche stdio-Probe',...denied.bestaetigungsdaten}});
assert.equal(approved.status,'done');assert.deepEqual(approved.tail,['E3_STDIO']);assert.equal(approved.ausgefuehrt,true);
const after=(await getPool().query('SELECT output,sicherung FROM shell_jobs WHERE project=$1 AND id=$2',[project,approved.id])).rows[0];
assert.equal(after.sicherung.audit.agent_id,'koordinator');assert.match(after.output,/E3_STDIO/);
console.log('P10-T37 stdio: gemeinsame Parameter, Flat-Antwort und ein vollständiger auditierter Job grün.');


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
