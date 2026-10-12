import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdtemp}from'node:fs/promises';import{join}from'node:path';import{homedir}from'node:os';import{createRequire}from'node:module';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const{getPool,closePool}=await import('../dist/db/client.js');
const{claimPendingShellJob}=await import('../dist/services/shell-queue.js');
const{runClaimedJob}=await import('../../file-watcher-daemon-ts/dist/shell-job-worker.js');
const{shellRoutes}=await import('../../rest-api/dist/routes/shell.js');
const{handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
const require=createRequire(new URL('../../rest-api/package.json',import.meta.url)),app=require('fastify')();
await app.register(shellRoutes);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
for(const mode of ['http','mcp']){
 const root=await mkdtemp(join(homedir(),'dev','synapse-e3-rest-')),project='test-e3-rest-'+randomUUID();
 await getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
 await getPool().query("INSERT INTO shell_sicherungsregeln(id,version,art,stufe,muster,antwort_id,quelle,status,bereich,project,positiv,negativ)VALUES($1,1,'text','anleitung',$2::jsonb,'fs.rm','owned-test','aktiv','projekt',$3,'[]','[]')",['owned-'+randomUUID(),JSON.stringify({command:['^printf$']}),project]);
 const args={action:'exec',project,command:'printf E3_REST',agent_id:'sol-2',target:'local'};
 const call=async(extra={})=>{
   const payload={...args,...extra};
   const pending=mode==='http'?app.inject({method:'POST',url:'/api/shell',payload}).then(r=>{assert.equal(r.statusCode,200);return r.json();}):handleToolCall('shell',payload,payload.agent_id);
   let job;for(let n=0;n<200&&!job;n++){job=await claimPendingShellJob(project,'owned-rest-worker');if(!job)await new Promise(r=>setTimeout(r,10));}
   assert.ok(job,'eigener Queue-Job muss entstanden sein');
   await runClaimedJob(project,job);
   return pending;
 };
 const denied=await call();assert.equal(denied.ausgefuehrt,false);assert.equal(denied.stufe,'anleitung');assert.equal(denied.status,'rejected');
 const approved=await call({agent_id:'koordinator',bestaetigt:{grund:'Eigene ungefährliche REST-Probe',...denied.bestaetigungsdaten}});
 assert.equal(approved.status,'done');assert.equal(approved.ausgefuehrt,true);assert.deepEqual(approved.tail,['E3_REST']);
 const rows=(await getPool().query('SELECT sicherung FROM shell_jobs WHERE project=$1 ORDER BY created_at',[project])).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].sicherung.audit.agent_id,'sol-2');assert.equal(rows[1].sicherung.audit.entscheidung,'bestaetigt');
}
console.log('P10-T37 REST: HTTP und MCP mit realem Worker, flacher Ablehnung, Rollenbestätigung und demselben auditierten Job grün.');
await app.close();await closePool();process.exit(0);
