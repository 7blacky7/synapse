/** A10: no PG calls. Restore stages all bytes, then installs without clobbering local files. */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {normalisiereSpeicherPfad,isValidProjectName} from '@synapse/core';
import type {RestoreJob,RestoreCodeEntry} from '@synapse/core';
import {getWorkspaceRoot,loadConfig} from './config.js';
import type {WatcherManager} from './manager.js';
import {AssetApiTransport,AssetApiFehler} from './asset-api-transport.js';
import {AssetTransferQueue,type AssetSyncMeta, type AssetTransferOptionen} from './asset-transfer-queue.js';
type Entry=RestoreCodeEntry&{asset?:AssetSyncMeta;manifest?:string};
interface Journal {project:string;path:string;created:boolean;files:Record<string,string>;complete?:boolean}
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
function logical(raw:string){
 const p=normalisiereSpeicherPfad(raw);
 if(p.split('/').some(s=>['.synapse','.git','node_modules','.intern'].includes(s)))throw new Error('restore_pfad_gesperrt');
 return p;
}
async function directory(root:string,relative:string){
 if(await fs.realpath(root)!==root)throw new Error('restore_symlink');
 let p=root;
 for(const part of relative.split('/').filter(Boolean)){
  p=path.join(p,part);await fs.mkdir(p).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('restore_symlink');
 }
 return p;
}
async function hashFile(p:string){
 const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await h.stat();if(!s.isFile())throw new Error('restore_konflikt');const hash=createHash('sha256');for await(const chunk of h.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex');}
 finally{await h.close();}
}
async function save(p:string,body:unknown){
 const temp=p+'.'+randomUUID(),fd=await fs.open(temp,'wx',0o600);
 try{await fd.writeFile(JSON.stringify(body));await fd.sync();}finally{await fd.close();}
 await fs.rename(temp,p);
}
export async function restoreExistingProject(job:RestoreJob,manager:WatcherManager,api=new AssetApiTransport()){
 if(job.mode!=='restore_existing'||!isValidProjectName(job.name)||job.hostname!==os.hostname())throw new Error('restore_host_verboten');
 const root=path.resolve(getWorkspaceRoot());await fs.mkdir(root,{recursive:true});
 if(await fs.realpath(root)!==root)throw new Error('restore_workspace_symlink');
 const target=path.join(root,job.name),stateDir=await directory(root,'.synapse-restore/'+job.name);
 const journalPath=path.join(stateDir,'state.json'),data=await directory(stateDir,'bytes');
 let journal:Journal;
 try{const fd=await fs.open(journalPath,constants.O_RDONLY|constants.O_NOFOLLOW);try{journal=JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}}
 catch(e){if(!absent(e))throw e;journal={project:job.name,path:target,created:false,files:{}};}
 if(journal.project!==job.name||journal.path!==target||typeof journal.files!=='object')throw new Error('restore_journal_ungueltig');
 if(manager.isRunning(job.name))throw new Error('restore_watcher_laeuft');
 // Existing foreign directories are never adopted, even when they happen to be empty.
 try{const s=await fs.lstat(target);if(!s.isDirectory()||s.isSymbolicLink()||!journal.created)throw new Error('restore_konflikt');}
 catch(e){if(!absent(e))throw e;}
 // Persistent fence also protects starts from an old local config/registry during installation.
 journal.complete=false;await save(journalPath,journal);
 const base='/api/projects/'+encodeURIComponent(job.name);
 const options=await api.json<AssetTransferOptionen&{host:string;scanMs:number}>(base+'/assets/sync-optionen');
 if(!options.host||options.richtung==='pc_to_share')throw new Error('restore_richtung_verboten');
 let renewedAt=0;
 const renew=async()=>{await api.json('/api/project-init/restore/'+job.id+'/renew',{restore_lease:job.restore_lease});renewedAt=Date.now();};
 await renew();const entries=new Map<string,Entry>();let delta='',stand='';
 function add(e:Entry){
  if(e.excluded)return;const p=logical(e.pfad);
  if(!/^[a-f0-9]{64}$/.test(e.sha256)||!Number.isSafeInteger(e.groesse)||e.groesse<0)throw new Error('restore_manifest_ungueltig');
  if(e.groesse>options.maxDateiBytes)throw new Error('restore_dateiquote');
  const old=entries.get(p);if(old&&old.sha256!==e.sha256)throw new Error('restore_code_asset_konflikt');
  entries.set(p,{...e,pfad:p});
 }
 let cursor:string|undefined,codeId:string|undefined;
 do{
  const page=await api.json<{manifest_id:string;eintraege:RestoreCodeEntry[];cursor:string|null;vollstaendig:boolean}>(base+'/code/manifest'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
  if(codeId&&codeId!==page.manifest_id)throw new Error('restore_snapshot_gewechselt');codeId=page.manifest_id;
  for(const e of page.eintraege)add({...e,manifest:codeId});
  cursor=page.cursor??undefined;if(!cursor&&!page.vollstaendig)throw new Error('restore_manifest_unvollstaendig');await renew();
 }while(cursor);
 do{
  const page=await api.json<{eintraege:AssetSyncMeta[];cursor:string|null;vollstaendig:boolean;aenderungs_cursor:string;stand:string}>(base+'/assets/manifest'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
  if(stand&&stand!==page.stand)throw new Error('restore_snapshot_gewechselt');stand=page.stand;delta=page.aenderungs_cursor;
  for(const e of page.eintraege){
   if(e.deleted_at)continue;
   if(e.storage_status!=='ready'||!e.revision||!e.sha256)throw new Error('restore_asset_bytes_fehlen');
   add({pfad:e.pfad,sha256:e.sha256,groesse:e.groesse,asset:e});
  }
  cursor=page.cursor??undefined;if(!cursor&&!page.vollstaendig)throw new Error('restore_manifest_unvollstaendig');await renew();
 }while(cursor);
 // Download cache is content-addressed; no partially downloaded file gets a trusted hash name.
 for(const e of entries.values()){
  const cached=path.join(data,e.sha256);
  try{if(await hashFile(cached)===e.sha256){await renew();continue;}throw new Error('restore_cache_konflikt');}catch(err){if(!absent(err))throw err;}
  const query=e.asset?'assets/bytes?asset_id='+encodeURIComponent(e.asset.asset_id)+'&revision='+encodeURIComponent(e.asset.revision!):
   'code/bytes?manifest_id='+encodeURIComponent(e.manifest!)+'&pfad='+encodeURIComponent(e.pfad)+'&sha256='+e.sha256;
  const response=await api.request(base+'/'+query,{timeoutMs:options.timeoutMs});
  if(!response.body)throw new Error('restore_bytes_fehlen');
  const temp=cached+'.'+randomUUID(),fd=await fs.open(temp,'wx',0o600),hash=createHash('sha256');let bytes=0;
  try{
   const reader=response.body.getReader();
   try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>e.groesse)throw new Error('restore_groesse_falsch');hash.update(r.value);if(Date.now()-renewedAt>options.timeoutMs/3)await renew();let offset=0;while(offset<r.value.byteLength){const written=await fd.write(r.value,offset,r.value.byteLength-offset);offset+=written.bytesWritten;}}}
   finally{await reader.cancel();}
   if(bytes!==e.groesse||hash.digest('hex')!==e.sha256)throw new Error('restore_hash_falsch');await fd.sync();
  }catch(err){await fd.close();await fs.unlink(temp).catch(()=>{});throw err;}finally{await fd.close().catch(()=>{});}
  await fs.rename(temp,cached);await renew();
 }
 // Preflight every owned local file BEFORE any installation. Foreign paths are conflicts.
 if(journal.created){
  const walk=async(dir:string,rel='')=>{
   for(const d of await fs.readdir(dir,{withFileTypes:true})){
    if(!rel&&d.name==='.synapse')continue;
    const p=rel?rel+'/'+d.name:d.name;
    if(d.isSymbolicLink())throw new Error('restore_konflikt');
    if(d.isDirectory())await walk(path.join(dir,d.name),p);
    else if(!journal.files[p]||await hashFile(path.join(dir,d.name))!==journal.files[p])throw new Error('restore_konflikt');
   }
  };await walk(target);
 }
 await renew();
 if(!journal.created){
  await fs.mkdir(target);journal.created=true;await save(journalPath,journal);
 }
 for(const e of entries.values()){
  const parent=await directory(target,path.posix.dirname(e.pfad)==='.'?'':path.posix.dirname(e.pfad)),to=path.join(parent,path.posix.basename(e.pfad));
  try{const existing=await hashFile(to);if(existing!==e.sha256||journal.files[e.pfad]!==e.sha256)throw new Error('restore_konflikt');}
  catch(err){if(!absent(err))throw err;
   // Intent journal comes first: a crash after link is safe to resume; links never overwrite.
   journal.files[e.pfad]=e.sha256;await save(journalPath,journal);
   const installing=path.join(stateDir,'.install-'+randomUUID());
   await fs.copyFile(path.join(data,e.sha256),installing,constants.COPYFILE_EXCL);
   try{await fs.link(installing,to);}finally{await fs.unlink(installing);}
  }
  await renew();
 }
 const assetEntries=[...entries.values()].flatMap(e=>e.asset?[e.asset]:[]);
 const q=new AssetTransferQueue({bereich:'projekt',ziel_ref:job.name,host:options.host,root:target},options,api);
 await q.restoreCheckpoint(assetEntries,delta,stand);await q.stop();
 journal.complete=true;await save(journalPath,journal);await renew();
 await api.json('/api/project-init/restore/'+job.id+'/complete',{restore_lease:job.restore_lease,status:'done',path:target});
 await manager.registerRestored(job.name,target);
 return target;
}
export function startProjectRestoreWorker(manager:WatcherManager,api=new AssetApiTransport()){
 let busy=false,stopped=false;let running:Promise<void>=Promise.resolve();
 const tick=async()=>{
  if(stopped||busy||loadConfig().asset_sync?.aktiv===false)return;busy=true;
  let claimed:RestoreJob|null=null;
  try{
   const {job}=await api.json<{job:RestoreJob|null}>('/api/project-init/restore/claim',{});claimed=job;
   if(job)await restoreExistingProject(job,manager,api);
  }catch(e){
   if(claimed&&!(e instanceof AssetApiFehler&&e.wiederholbar))await api.json('/api/project-init/restore/'+claimed.id+'/complete',{restore_lease:claimed.restore_lease,status:'failed',error:(e as Error).message}).catch(()=>{});
   if(!(e instanceof AssetApiFehler&&[401,403,426,503].includes(e.status)))console.error('[project-restore] '+(e as Error).message);
  }
  finally{busy=false;}
 };
 const timer=setInterval(()=>{if(!busy)running=tick();},loadConfig().asset_sync?.retry_ms??5_000);timer.unref();running=tick();
 return {stop:async()=>{stopped=true;clearInterval(timer);await running;}};
}
