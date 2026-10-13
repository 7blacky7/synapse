/** A10: API side. Host binding is explicit; no remote PC filesystem access. */
import {randomUUID,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {getPool} from '../db/client.js';
import {getFileContent} from './code-intel.js';
import {istMaskierteDatei} from './env-maske.js';
import {isValidProjectName} from './project-init-queue.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
export class ProjectRestoreError extends Error {
 constructor(readonly code:string,readonly httpStatus=409){super(code);}
}
const fail=(c:string,s=409):never=>{throw new ProjectRestoreError(c,s);};
export interface RestoreCodeEntry {pfad:string;sha256:string;groesse:number;excluded?:boolean}
export interface RestoreJob {id:string;name:string;hostname:string;mode:'restore_existing';restore_lease:string}
function host(h:string){if(typeof h!=='string'||!h||h.length>200||/[\s/\\\x00]/.test(h))fail('host_ungueltig',400);}
function uuid(v:string){if(typeof v!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v))fail('id_ungueltig',400);}
function cursor(raw:string):{id:string;after:string}{
 try {const c=JSON.parse(Buffer.from(raw,'base64url').toString());if(typeof c.id!=='string'||typeof c.after!=='string'||c.after.length>4096)throw 0;uuid(c.id);return c;}
 catch{return fail('cursor_ungueltig',400);}
}
export class ProjectRestoreService {
 constructor(private readonly db:Pool=getPool()){}
 private ttl(){return getAssetKonfiguration().speicher.timeoutMs;}
 /** Explicit Tray operation using the existing daemon credential; labels never identify OS hosts. */
 async bindDaemonHost(tokenHash:string,hostname:string):Promise<string>{
  host(hostname);
  if(!/^[a-f0-9]{64}$/.test(tokenHash))fail('daemon_identitaet_ungueltig',400);
  const r=await this.db.query(`INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2)
   ON CONFLICT(token_hash) DO UPDATE SET updated_at=clock_timestamp()
   WHERE daemon_restore_host_bindings.hostname=EXCLUDED.hostname RETURNING hostname`,[tokenHash,hostname]);
  if(!r.rows.length)fail('daemon_host_bereits_gebunden',409);
  return r.rows[0].hostname;
 }
 async daemonHost(tokenHash:string):Promise<string|null>{
  const r=await this.db.query('SELECT hostname FROM daemon_restore_host_bindings WHERE token_hash=$1',[tokenHash]);
  return r.rows[0]?.hostname??null;
 }

 async binding(project:string,hostname:string):Promise<boolean>{
  host(hostname);
  const r=await this.db.query('SELECT 1 FROM project_host_bindings b WHERE b.project=$1 AND b.hostname=$2 AND b.enabled AND EXISTS(SELECT 1 FROM projects p WHERE p.name=b.project AND p.enabled)',[project,hostname]);
  return r.rows.length>0;
 }
 async requireBinding(project:string,hostname:string){if(!await this.binding(project,hostname))fail('projekt_nicht_gebunden',403);}
 /** Called only after user/Tray authorization; bind=false merely queues an existing binding. */
 async enqueue(project:string,hostname:string,requestedBy?:string,bind=false):Promise<{id:string}>{
  if(!isValidProjectName(project))fail('invalid_name',400);host(hostname);
  const c=await this.db.connect();
  try {
   await c.query('BEGIN');
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['project-restore:'+project+':'+hostname]);
   if(!(await c.query('SELECT 1 FROM projects WHERE name=$1 AND enabled LIMIT 1',[project])).rows.length)fail('project_not_found',404);
   if(bind)await c.query('INSERT INTO project_host_bindings(project,hostname) VALUES($1,$2) ON CONFLICT(project,hostname) DO UPDATE SET enabled=true,updated_at=clock_timestamp()',[project,hostname]);
   if(!(await c.query('SELECT 1 FROM project_host_bindings WHERE project=$1 AND hostname=$2 AND enabled FOR SHARE',[project,hostname])).rows.length)fail('projekt_nicht_gebunden',403);
   const prior=await c.query("SELECT id FROM project_init_jobs WHERE name=$1 AND hostname=$2 AND mode='restore_existing' AND status IN('pending','running') ORDER BY created_at LIMIT 1",[project,hostname]);
   const r=prior.rows.length?prior:await c.query("INSERT INTO project_init_jobs(name,hostname,requested_by,mode) VALUES($1,$2,$3,'restore_existing') RETURNING id",[project,hostname,requestedBy??null]);
   await c.query('COMMIT');return {id:r.rows[0].id};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async unbind(project:string,hostname:string){
  host(hostname);
  await this.db.query('UPDATE project_host_bindings SET enabled=false,updated_at=clock_timestamp() WHERE project=$1 AND hostname=$2',[project,hostname]);
 }
 async claim(hostname:string):Promise<RestoreJob|null>{
  host(hostname);const lease=randomUUID();
  const r=await this.db.query(`WITH candidate AS (
   SELECT j.id FROM project_init_jobs j JOIN project_host_bindings b ON b.project=j.name AND b.hostname=j.hostname AND b.enabled
   WHERE j.mode='restore_existing' AND j.hostname=$1
    AND (j.status='pending' OR j.status='running' AND j.lease_until<clock_timestamp())
    AND EXISTS(SELECT 1 FROM projects p WHERE p.name=j.name AND p.enabled)
   ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  ) UPDATE project_init_jobs j SET status='running',claimed_by=$1,claimed_at=clock_timestamp(),
   restore_lease=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp()
   FROM candidate c WHERE j.id=c.id RETURNING j.*`,[hostname,lease,this.ttl()]);
  return r.rows[0]??null;
 }
 async renew(id:string,hostname:string,lease:string){
  uuid(id);uuid(lease);host(hostname);
  const r=await this.db.query(`UPDATE project_init_jobs j SET lease_until=clock_timestamp()+$4*interval '1 millisecond'
   WHERE id=$1 AND hostname=$2 AND mode='restore_existing' AND restore_lease=$3 AND status='running' AND lease_until>clock_timestamp()
    AND EXISTS(SELECT 1 FROM project_host_bindings b WHERE b.project=j.name AND b.hostname=$2 AND b.enabled)
    AND EXISTS(SELECT 1 FROM projects p WHERE p.name=j.name AND p.enabled) RETURNING id`,[id,hostname,lease,this.ttl()]);
  if(!r.rows.length)fail('restore_lease_veraltet');
 }
 async complete(id:string,hostname:string,lease:string,result:{status:'done'|'failed';path?:string;error?:string}){
  uuid(id);uuid(lease);host(hostname);
  const c=await this.db.connect();
  try{
   await c.query('BEGIN');
   const r=await c.query(`SELECT j.* FROM project_init_jobs j JOIN project_host_bindings b ON b.project=j.name AND b.hostname=j.hostname AND b.enabled
    WHERE j.id=$1 AND j.hostname=$2 AND j.restore_lease=$3 AND j.mode='restore_existing' AND j.status='running' AND j.lease_until>clock_timestamp()
     AND EXISTS(SELECT 1 FROM projects p WHERE p.name=j.name AND p.enabled) FOR UPDATE OF j FOR SHARE OF b`,[id,hostname,lease]);
   if(!r.rows.length)fail('restore_lease_veraltet');
   if(result.status==='done'){
    if(!result.path||!(/^(\/|[A-Za-z]:[\\/])/.test(result.path)))fail('path_ungueltig',400);
    await c.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true) ON CONFLICT(name,hostname) DO UPDATE SET path=EXCLUDED.path,enabled=true,last_access=clock_timestamp()',[r.rows[0].name,hostname,result.path]);
   }
   await c.query("UPDATE project_init_jobs SET status=$2,resolved_path=$3,error=$4,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[id,result.status,result.path??null,result.error??null]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async manifest(project:string,hostname:string,raw?:string,requestedLimit?:number){
  await this.requireBinding(project,hostname);
  const cfg=getAssetKonfiguration(),limit=requestedLimit??Math.min(cfg.speicher.maxProjektDateien,cfg.speicher.maxObjekteJeDatei);
  if(!Number.isSafeInteger(limit)||limit<1||limit>getAssetKonfiguration().speicher.maxProjektDateien)fail('limit_ungueltig',400);
  let id:string,after='';
  if(raw){const c=cursor(raw);id=c.id;after=c.after;}
  else {
   id=randomUUID();const c=await this.db.connect();
   try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const count=await c.query('SELECT COUNT(*)::text AS n FROM code_files WHERE project=$1 AND content IS NOT NULL',[project]);
    if(BigInt(count.rows[0].n)>BigInt(cfg.speicher.maxProjektDateien))fail('restore_quote',413);
    await c.query('DELETE FROM project_code_manifests WHERE project=$1 AND lease_until<=clock_timestamp()',[project]);
    await c.query("INSERT INTO project_code_manifests(id,project,hostname,lease_until) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond')",[id,project,hostname,this.ttl()]);
    await c.query("INSERT INTO project_code_manifest_entries(manifest_id,file_path,sha256,groesse) SELECT $1,file_path,encode(digest(convert_to(content,'UTF8'),'sha256'),'hex'),octet_length(content) FROM code_files WHERE project=$2 AND content IS NOT NULL",[id,project]);
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  const s=await this.db.query("UPDATE project_code_manifests SET lease_until=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1 AND project=$2 AND hostname=$3 AND lease_until>clock_timestamp() RETURNING id",[id,project,hostname,this.ttl()]);
  if(!s.rows.length)fail('manifest_abgelaufen',410);
  const rows=(await this.db.query('SELECT * FROM project_code_manifest_entries WHERE manifest_id=$1 AND file_path>$2 ORDER BY file_path LIMIT $3',[id,after,limit+1])).rows;
  const more=rows.length>limit,page=rows.slice(0,limit);
  const entries:RestoreCodeEntry[]=page.map(r=>({pfad:normalisiereSpeicherPfad(r.file_path),sha256:r.sha256,groesse:Number(r.groesse),...(istMaskierteDatei(r.file_path)?{excluded:true}:{})}));
  return {manifest_id:id,eintraege:entries,vollstaendig:!more,cursor:more?Buffer.from(JSON.stringify({id,after:page.at(-1)!.file_path})).toString('base64url'):null};
 }
 async bytes(project:string,hostname:string,id:string,filePath:string,sha256:string){
  uuid(id);if(typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))fail('sha256_ungueltig',400);
  await this.requireBinding(project,hostname);
  const logical=normalisiereSpeicherPfad(filePath);
  if(istMaskierteDatei(logical))fail('lokale_geheimdatei',403);
  const row=(await this.db.query(`SELECT e.* FROM project_code_manifest_entries e JOIN project_code_manifests m ON m.id=e.manifest_id
   WHERE m.id=$1 AND m.project=$2 AND m.hostname=$3 AND m.lease_until>clock_timestamp() AND e.file_path=$4 AND e.sha256=$5`,[id,project,hostname,logical,sha256])).rows[0];
  if(!row)fail('code_revision_veraltet');
  const file=await getFileContent(project,logical,{vollstaendig:true});
  if(!file)return fail('code_revision_veraltet');
  const bytes=Buffer.from(file.content,'utf8');
  if(createHash('sha256').update(bytes).digest('hex')!==sha256||bytes.length!==Number(row.groesse))fail('code_revision_veraltet');
  return bytes;
 }
}
