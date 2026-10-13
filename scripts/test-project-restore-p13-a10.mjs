/** P13-T28/A10: real PG behind the approved client; isolated schema, no filesystem writes. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {oeffneGeschuetzteShellTestDb} from './lib/test-db-schutz.mjs';
const url=new URL(process.env.DATABASE_URL??'');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
process.env.SYNAPSE_API_FEATURES='asset_sync';
const db=await oeffneGeschuetzteShellTestDb();
const schema='p13_a10_'+randomUUID().replaceAll('-','');
const core=await import('../packages/core/dist/index.js');
const {ProjectRestoreService}=await import('../packages/core/dist/services/project-restore.js');
const {PROJECT_RESTORE_SCHEMA_SQL}=await import('../packages/core/dist/db/project-restore-schema.js');
const queue=await import('../packages/core/dist/services/project-init-queue.js');
const adapter={query:db.query,connect:async()=>({query:db.query,release(){}})};
const {mitLesePool}=await import('../packages/core/dist/db/client.js');
const service=new ProjectRestoreService(adapter);
const host='p13-a10-os-host',project='p13-a10-test',hash='a'.repeat(64);
const content='export const value = "Grüße";\n'+'//full-length\n'.repeat(8000);
const sha=createHash('sha256').update(content).digest('hex');
let count=0,app;
async function check(name,fn){await fn();console.log('PASS '+(++count)+' '+name);}
const error=(code)=>e=>e.code===code;
await mitLesePool(adapter,async()=>{
try{
 await db.query('CREATE SCHEMA '+schema);
 await db.query('SET search_path TO '+schema+',public');
 for(const t of ['projects','code_files'])await db.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 await db.query("CREATE TABLE project_init_jobs(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, hostname TEXT, template TEXT, requested_by TEXT, status TEXT NOT NULL DEFAULT 'pending', resolved_path TEXT,error TEXT,message TEXT,claimed_by TEXT,claimed_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())");
 await db.query(PROJECT_RESTORE_SCHEMA_SQL);await db.query(PROJECT_RESTORE_SCHEMA_SQL);
 await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'share','/fixture',true)",[project]);
 await check('missing binding rejects queue; no implicit PC consent',async()=>{
  await assert.rejects(service.enqueue(project,host),error('projekt_nicht_gebunden'));
  assert.equal((await db.query('SELECT count(*) AS n FROM project_host_bindings')).rows[0].n,'0');
 });
 await check('unknown/disabled project, invalid name and invalid host rejected',async()=>{
  await assert.rejects(service.enqueue('p13-a10-absent',host,undefined,true),error('project_not_found'));
  await assert.rejects(service.enqueue('../escape',host),error('invalid_name'));
  await assert.rejects(service.bindDaemonHost(hash,{}),error('host_ungueltig'));
  await db.query('UPDATE projects SET enabled=false WHERE name=$1',[project]);
  await assert.rejects(service.enqueue(project,host,undefined,true),error('project_not_found'));
  await db.query('UPDATE projects SET enabled=true WHERE name=$1',[project]);
 });
 await check('explicit existing daemon mapping, idempotent and hostile rebind fenced',async()=>{
  assert.equal(await service.daemonHost(hash),null);
  assert.equal(await service.bindDaemonHost(hash,host),host);
  assert.equal(await service.bindDaemonHost(hash,host),host);
  await assert.rejects(service.bindDaemonHost(hash,'other-host'),error('daemon_host_bereits_gebunden'));
  assert.equal(await service.daemonHost(hash),host);
 });
 let queued,job;
 await check('explicit restore queues once without project stub/registration',async()=>{
  queued=await service.enqueue(project,host,'sol-5',true);
  assert.equal((await service.enqueue(project,host)).id,queued.id);
  assert.equal((await db.query('SELECT count(*) AS n FROM projects')).rows[0].n,'1');
  assert.equal((await db.query('SELECT mode FROM project_init_jobs WHERE id=$1',[queued.id])).rows[0].mode,'restore_existing');
 });
 await check('legacy PC claim excludes restore; API delivery rejects other host',async()=>{
  assert.equal(await queue.claimPendingProjectInitJob('legacy-worker',host),null);
  assert.equal(await service.claim('other-host'),null);
  job=await service.claim(host);assert.equal(job.id,queued.id);
  assert.equal(await service.claim(host),null);
 });
 await check('lease renewal validates host/UUID/token, then stale lease is reclaimed',async()=>{
  await service.renew(job.id,host,job.restore_lease);
  await assert.rejects(service.renew(job.id,'other-host',job.restore_lease),error('restore_lease_veraltet'));
  await assert.rejects(service.renew(job.id,host,randomUUID()),error('restore_lease_veraltet'));
  await assert.rejects(service.renew('bad-id',host,job.restore_lease),error('id_ungueltig'));
  await db.query("UPDATE project_init_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
  await assert.rejects(service.renew(job.id,host,job.restore_lease),error('restore_lease_veraltet'));
  const next=await service.claim(host);assert.equal(next.id,job.id);assert.notEqual(next.restore_lease,job.restore_lease);job=next;
 });
 await check('unbind/disable revoke reads and renewal, without altering local registry',async()=>{
  await service.unbind(project,host);await assert.rejects(service.renew(job.id,host,job.restore_lease),error('restore_lease_veraltet'));
  await assert.rejects(service.manifest(project,host),error('projekt_nicht_gebunden'));
  await service.enqueue(project,host,undefined,true);
  await db.query('UPDATE projects SET enabled=false WHERE name=$1',[project]);
  await assert.rejects(service.renew(job.id,host,job.restore_lease),error('restore_lease_veraltet'));
  await db.query('UPDATE projects SET enabled=true WHERE name=$1',[project]);
 });
 await check('completion validates path and registers restored host only on done',async()=>{
  await assert.rejects(service.complete(job.id,host,job.restore_lease,{status:'done',path:'relative'}),error('path_ungueltig'));
  await service.complete(job.id,host,job.restore_lease,{status:'done',path:'/fixture/restored'});
  assert.equal((await db.query('SELECT path FROM projects WHERE name=$1 AND hostname=$2',[project,host])).rows[0].path,'/fixture/restored');
  await assert.rejects(service.complete(job.id,host,job.restore_lease,{status:'done',path:'/fixture/restored'}),error('restore_lease_veraltet'));
 });
 await db.query("INSERT INTO code_files(project,file_path,file_name,file_type,content,file_size) VALUES($1,'src/main.ts','main.ts','ts',$2,$3),($1,'z.ts','z.ts','ts','original',8),($1,'.env','.env','env','SECRET=fixture',14)",[project,content,Buffer.byteLength(content)]);
 let manifest;
 await check('paged snapshot excludes secrets and stays stable despite subsequent code writes',async()=>{
  manifest=await service.manifest(project,host,undefined,1);
  assert.equal(manifest.eintraege[0].excluded,true);
  await db.query("UPDATE code_files SET content='changed' WHERE project=$1 AND file_path='z.ts'",[project]);
  const page=await service.manifest(project,host,manifest.cursor,1);assert.equal(page.manifest_id,manifest.manifest_id);
  assert.equal(page.eintraege[0].pfad,'src/main.ts');assert.equal(page.eintraege[0].sha256,sha);
  const last=await service.manifest(project,host,page.cursor,1);assert.equal(last.vollstaendig,true);
  assert.equal(last.eintraege[0].sha256,createHash('sha256').update('original').digest('hex'));
 });
 await check('API engine returns complete >80k UTF8 bytes with exact SHA; secret/stale/wrong host denied',async()=>{
  assert.equal((await service.bytes(project,host,manifest.manifest_id,'src/main.ts',sha)).toString(),content);
  await assert.rejects(service.bytes(project,host,manifest.manifest_id,'.env','a'.repeat(64)),error('lokale_geheimdatei'));
  await assert.rejects(service.bytes(project,'other-host',manifest.manifest_id,'src/main.ts',sha),error('projekt_nicht_gebunden'));
  await assert.rejects(service.bytes(project,host,manifest.manifest_id,'z.ts',createHash('sha256').update('original').digest('hex')),error('code_revision_veraltet'));
 });
 await check('bad cursors, page budgets, expired snapshots fail closed',async()=>{
  await assert.rejects(service.manifest(project,host,'garbage'),error('cursor_ungueltig'));
  await assert.rejects(service.manifest(project,host,undefined,0),error('limit_ungueltig'));
  await db.query("UPDATE project_code_manifests SET lease_until=clock_timestamp()-interval '1 second'");
  await assert.rejects(service.manifest(project,host,manifest.cursor,1),error('manifest_abgelaufen'));
 });
 const require=createRequire(new URL('../packages/rest-api/package.json',import.meta.url));
 const fastify=require('fastify');
 const {registerProjectRestoreRoutes}=await import('../packages/rest-api/dist/routes/project-restore.js');
 const principal={token_hash:hash,kind:'service',scope:'daemon:human-readable-label'};
 app=fastify();await registerProjectRestoreRoutes(app,{service,validateToken:async t=>t==='daemon'?principal:t==='compute'?{...principal,scope:'compute-node:x'}:null});await app.ready();
 const call=(method,path,payload,credential='daemon',contract=true)=>app.inject({method,url:path,headers:{authorization:'Bearer '+credential,...(contract?{[core.API_CONTRACT_HEADER]:'1'}:{})},...(payload===undefined?{}:{payload})});
 await check('HTTP auth/A1/compute credentials are fenced; daemon label never becomes hostname',async()=>{
  assert.equal((await call('GET','/api/project-init/restore/host-binding',undefined,'bad')).statusCode,401);
  assert.equal((await call('GET','/api/project-init/restore/host-binding',undefined,'daemon',false)).statusCode,426);
  assert.equal((await call('POST','/api/project-init/restore/host-binding',{hostname:host},'compute')).statusCode,403);
  assert.equal((await call('GET','/api/project-init/restore/host-binding')).json().hostname,host);
  assert.equal((await call('POST','/api/projects/'+project+'/restore-existing',{hostname:'human-readable-label'})).statusCode,403);
 });
 await check('HTTP explicit restore/claim/renew/complete and manifest/bytes use mapped OS identity',async()=>{
  assert.equal((await call('POST','/api/project-init/restore/host-binding',{hostname:host})).statusCode,200);
  const r=await call('POST','/api/projects/'+project+'/restore-existing',{hostname:host});assert.equal(r.statusCode,200);
  const claimed=(await call('POST','/api/project-init/restore/claim',{})).json().job;assert.equal(claimed.hostname,host);
  assert.equal((await call('POST','/api/project-init/restore/'+claimed.id+'/renew',{restore_lease:claimed.restore_lease})).statusCode,200);
  const page=(await call('GET','/api/projects/'+project+'/code/manifest')).json();assert.equal(page.success,true);
  const bytes=await call('GET','/api/projects/'+project+'/code/bytes?manifest_id='+page.manifest_id+'&pfad=src%2Fmain.ts&sha256='+sha);
  assert.equal(bytes.statusCode,200);assert.equal(bytes.rawPayload.toString(),content);assert.equal(bytes.headers['content-type'],'application/octet-stream');
  assert.equal((await call('POST','/api/project-init/restore/'+claimed.id+'/complete',{restore_lease:claimed.restore_lease,status:'failed',error:'fixture'})).statusCode,200);
 });
 console.log('RESULT A10_DB '+count+'/'+count+' PASS; schema='+schema);
}finally{
 if(app)await app.close();
 await db.query('SET search_path TO public');
 await db.query('DROP SCHEMA '+schema+' CASCADE');
 await db.end();
}
});
