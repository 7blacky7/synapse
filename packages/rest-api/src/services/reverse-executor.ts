/**
 * P18-T59/RV12 (Welle R1-A): führt reverse-E-Aufträge (P20-Work-Jobs) auf dem Unraid-Server aus.
 * Grundlage Wellenplan R1 (thought ef68838e):
 *  E1 Systemprojekt 'reverse-bibliothek' virtuell registrieren + tool_activation, kein Umbau des Lebenszyklus.
 *  E2 instance_scope 'job': je Auftrag /bib (ro, Reverse-Bibliothek) und /arbeit (rw, <reverseRoot>/_arbeit/<jobId>).
 *  E3 nur Kinds aus SYNAPSE_REVERSE_EXECUTOR_KINDS (Default 'reverse-E').
 * Ablauf: offener Auftrag -> Lebenszyklus weckt Job-Container -> Claim nur mit Server-Identität ->
 * lifecycle.execute {kommando:'extrahieren'} -> uebernehmeEErgebnis unter Lease-Fence -> stage -> complete.
 * Alles aus, solange SYNAPSE_REVERSE_ENABLED nicht '1' ist.
 */
import {createHash} from 'node:crypto';
import {mkdir,chmod,chown,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import type {Pool} from 'pg';
import {getPool,getAssetKonfiguration,registerVirtualProject,registerToolDescriptor,setToolActivation,validateToolDescriptor,
 configureWorkJobHooks,createWorkJobService,validateWorkResources,registriereWorker,workerPausiert,uebernehmeEErgebnis,
 reverseEGruppe,ReverseEUebernahmeFehler,ergaenzeReverseRuntime,REVERSE_FEHLERCODES,
 type ToolDescriptor,type WorkJob,type WorkJobHooks,type WorkJobClient,type WorkNodeAuthority,type WorkIdentity,
 type WorkJobService,type WorkJobPool,type WorkResourceNeed,type ReverseContainerInfo,type ReverseEManifestEintrag} from '@synapse/core';
import type {ToolLifecycle,ToolResourceAdapter,ToolInstanceContext} from './tool-lifecycle.js';
import {DockerToolContainerExecutor,type ResolvedToolMount} from './tool-container-docker.js';
import {configureToolLifecycleAdapters,getToolLifecycle} from './tool-lifecycle-runtime.js';
import {ServerExecutor} from './server-executor.js';

export const REVERSE_PROJEKT='reverse-bibliothek';
export const REVERSE_CAPABILITY='reverse_bibliothek';
export const REVERSE_TOOL_ID='reverse-e';
const UNTERSTUETZTE_KINDS=['reverse-E'];
/** Serverseitige Selbstkonfiguration aus der API-Umgebung, niemals aus Clientargumenten. */
const SERVER_AUTHORITY={role:'koordinator',authenticated:true} as const;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db=Pick<Pool,'query'|'connect'>;
type Ref=WorkJob['inputRef'];

// ---------------------------------------------------------------------------------------------
// Work-Job-Hooks je Capability komponieren: configureWorkJobHooks ersetzt den ganzen Satz, deshalb
// registriert jede Capability hier und bekommt nur ihre eigenen Aufträge zu sehen.
const hookRegistry=new Map<string,WorkJobHooks>();
function komponiereWorkJobHooks():WorkJobHooks{
 if(!hookRegistry.size)return {};
 const fuer=(capability:string)=>hookRegistry.get(capability);
 return {
  resourceDomain:nodeId=>{for(const h of hookRegistry.values()){const d=h.resourceDomain?.(nodeId);if(d)return d;}return undefined;},
  authorizeJob:async(node,job,client)=>(await fuer(job.capability)?.authorizeJob?.(node,job,client))??null,
  inputStillCurrent:async(job,client)=>(await fuer(job.capability)?.inputStillCurrent?.(job,client))===true,
  outputIsStaged:async(job,out,client)=>(await fuer(job.capability)?.outputIsStaged?.(job,out,client))===true,
 };
}
/** Registriert Hooks für genau eine Capability; bestehende Hooks anderer Capabilities bleiben. */
export function registriereWorkJobHooks(capability:string,hooks:WorkJobHooks):()=>void{
 hookRegistry.set(capability,hooks);configureWorkJobHooks(komponiereWorkJobHooks());
 return ()=>{if(hookRegistry.get(capability)===hooks){hookRegistry.delete(capability);configureWorkJobHooks(komponiereWorkJobHooks());}};
}

// ---------------------------------------------------------------------------------------------
export interface ReverseExecutorKonfig {
 reverseRoot:string;arbeitRoot:string;image:string;digest:string;kinds:string[];parallel:number;
 leaseSeconds:number;renewMs:number;tickMs:number;resourceNeed:WorkResourceNeed;resourceDomain:string|null;
 zeitlimitS:number;maxDateien:number;maxBytes:number;tmpfsMb:number;pids:number;outputBytes:number;retryMax:number;
}
function ganz(env:NodeJS.ProcessEnv,name:string,fallback:number,min=1,max=2147483647):number{
 const n=Number(env[name]??fallback);
 if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('reverse_executor_konfig:'+name);
 return n;
}
/** Liest die Executor-Umgebung; null = aus. Ungültige Werte werfen (der Start bleibt dann aus). */
export function ladeReverseExecutorKonfig(env:NodeJS.ProcessEnv,reverseRoot:string|null):ReverseExecutorKonfig|null{
 if(env.SYNAPSE_REVERSE_ENABLED!=='1'||!reverseRoot)return null;
 const bild=(env.SYNAPSE_REVERSE_IMAGE??'').trim();
 const m=bild.match(/^([a-zA-Z0-9][a-zA-Z0-9._/:-]*)@(sha256:[a-f0-9]{64})$/);
 if(!m)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_IMAGE (name@sha256:<64 hex> erwartet)');
 const roh=env.SYNAPSE_REVERSE_RESOURCE_NEED;
 if(!roh)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_RESOURCE_NEED');
 const need=validateWorkResources(JSON.parse(roh));
 if(need.gpu||need.cpu<=0||need.ram<=0)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_RESOURCE_NEED (CPU/RAM, keine GPU)');
 const gewuenscht=(env.SYNAPSE_REVERSE_EXECUTOR_KINDS??'reverse-E').split(',').map(s=>s.trim()).filter(Boolean);
 const kinds=gewuenscht.filter(k=>UNTERSTUETZTE_KINDS.includes(k));
 if(kinds.length!==gewuenscht.length)console.warn('[reverse-executor] Nicht unterstützte Kinds ignoriert:',gewuenscht.filter(k=>!kinds.includes(k)).join(','));
 if(!kinds.length)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_EXECUTOR_KINDS');
 const leaseSeconds=ganz(env,'SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS',300,10,ganz(env,'SYNAPSE_WORK_MAX_LEASE_SECONDS',900));
 const root=path.resolve(reverseRoot);
 return {reverseRoot:root,arbeitRoot:path.join(root,'_arbeit'),image:m[1],digest:m[2],kinds,
  parallel:ganz(env,'SYNAPSE_REVERSE_EXECUTOR_PARALLEL',1,1,16),leaseSeconds,renewMs:Math.max(1000,Math.floor(leaseSeconds*1000/3)),
  tickMs:ganz(env,'SYNAPSE_REVERSE_EXECUTOR_TICK_MS',5000,100),resourceNeed:need,
  resourceDomain:env.SYNAPSE_REVERSE_RESOURCE_DOMAIN?.trim()||null,
  zeitlimitS:ganz(env,'SYNAPSE_REVERSE_ZEITLIMIT_S',3600,1,86400),maxDateien:ganz(env,'SYNAPSE_REVERSE_MAX_DATEIEN',20000,1,200000),
  maxBytes:ganz(env,'SYNAPSE_REVERSE_MAX_BYTES',2000000000,1,Number.MAX_SAFE_INTEGER),tmpfsMb:ganz(env,'SYNAPSE_REVERSE_TMPFS_MB',512,16),
  pids:ganz(env,'SYNAPSE_REVERSE_PIDS',256,16),outputBytes:ganz(env,'SYNAPSE_REVERSE_OUTPUT_BYTES',33554432,65536),
  retryMax:ganz(env,'SYNAPSE_REVERSE_RETRY_MAX',3,1,100)};
}
/**
 * E2: ein Container je Auftrag, kein Netz, Bibliothek nur lesend, nur der eigene Arbeitsordner schreibbar.
 * Rootfs ist read-only; der Docker-Adapter hängt /tmp als tmpfs (resources.tmpfs MB) ein – der Runner nutzt TMPDIR=HOME=/tmp.
 */
export function reverseToolDescriptor(k:ReverseExecutorKonfig):ToolDescriptor{
 return validateToolDescriptor({tool_id:REVERSE_TOOL_ID,tool:'reverse',capability:REVERSE_CAPABILITY,image:k.image,digest:k.digest,
  instance_scope:'job',network:'none',allow_project_share:false,
  mounts:[{role:'bibliothek',target:'/bib',write:false},{role:'arbeit',target:'/arbeit',write:true,job_only:true}],
  resources:{cpu:k.resourceNeed.cpu,ram:k.resourceNeed.ram,vram:0,gpu:false,pids:k.pids,tmpfs:k.tmpfsMb,concurrency:1},
  limits:{time_ms:(k.zeitlimitS+60)*1000,output_bytes:k.outputBytes,input_bytes:65536},
  lifecycle:{idle_ms:30000,activity_lookback_seconds:300,cpu_idle_percent:5,gpu_idle_percent:100,measurement_max_age_ms:60000,
   start_timeout_ms:120000,max_starts:20,start_window_ms:600000,pause_ms:300000}});
}
const RUNNER_UID=65532;
/** K4: als root Eigentümer 65532 + 0700; ohne root (Tests/Entwicklung) bleibt nur 0777 übrig. */
async function runnerOrdner(dir:string):Promise<void>{
 await mkdir(dir,{recursive:true,mode:0o700});
 if(process.getuid?.()===0){await chown(dir,RUNNER_UID,RUNNER_UID);await chmod(dir,0o700);}
 else await chmod(dir,0o777);
}
/** Arbeitsordner je Auftrag; der Container läuft als 65532 und muss hinein schreiben. */
export async function reverseArbeitsOrdner(k:ReverseExecutorKonfig,jobId:string):Promise<string>{
 if(!UUID.test(jobId))throw Error('reverse_job_ungueltig');
 await mkdir(k.arbeitRoot,{recursive:true,mode:0o711});
 const dir=path.join(k.arbeitRoot,jobId);
 await runnerOrdner(dir);
 return dir;
}
export function reverseMountResolver(k:ReverseExecutorKonfig):(d:ToolDescriptor,ctx:ToolInstanceContext)=>Promise<ResolvedToolMount[]>{
 return async(d,ctx)=>{
  if(d.tool_id!==REVERSE_TOOL_ID)return [];
  const mounts:ResolvedToolMount[]=[{role:'bibliothek',source:k.reverseRoot,root:k.reverseRoot,allowWrite:false,allowProjectShare:false}];
  if(ctx.job_id)mounts.push({role:'arbeit',source:await reverseArbeitsOrdner(k,ctx.job_id),root:k.arbeitRoot,allowWrite:true,allowProjectShare:false});
  return mounts;
 };
}
/** Lokale Freigabe nur für den Reverse-Container; Kapazität begrenzen Lebenszyklus und Work-Budget. */
export const reverseRessourcen:ToolResourceAdapter={
 async acquire(d,ctx){return d.tool_id===REVERSE_TOOL_ID?'reverse-lokal:'+ctx.instance_id+':'+ctx.generation:null;},
 async release(){},
};
const fehlercode=(roh:unknown):string=>{
 const c=String(roh??'');
 if(c==='deadline')return 'zeitlimit';
 return (REVERSE_FEHLERCODES as readonly string[]).includes(c)?c:'werkzeug_fehler';
};

// ---------------------------------------------------------------------------------------------
export interface ReverseExecutorDeps {
 pool?:Db;konfig:ReverseExecutorKonfig;
 lifecycle:()=>ToolLifecycle|null;
 /** Server-Identität (ServerExecutor); null = noch keine registrierte Bootgeneration. */
 identitaet:()=>Promise<WorkIdentity|null>;
 jobs?:WorkJobService;
 uebernahme?:typeof uebernehmeEErgebnis;
 uebernahmeOptionen?:Parameters<typeof uebernehmeEErgebnis>[2];
 registriereProjekt?:(name:string)=>Promise<void>;
}
export interface ReverseDurchlauf {geprueft:true;geweckt:number;gestartet:number;hinweis?:string}
export class ReverseExecutor {
 private readonly pool:Db;private readonly k:ReverseExecutorKonfig;private readonly jobs:WorkJobService;
 private readonly laufend=new Map<string,Promise<void>>();
 private wer:WorkIdentity|null=null;private eingerichtet=false;private beendet=false;
 constructor(private readonly deps:ReverseExecutorDeps){
  this.pool=deps.pool??getPool();this.k=deps.konfig;
  this.jobs=deps.jobs??createWorkJobService({pool:this.pool as unknown as WorkJobPool});
 }
 private domain(nodeId:string):string{return this.k.resourceDomain??'reverse:'+nodeId;}
 /** Hooks nur für Capability reverse_bibliothek; Claims ausschließlich mit der eigenen Server-Identität. */
 hooks():WorkJobHooks{
  return {
   resourceDomain:nodeId=>this.wer&&nodeId===this.wer.nodeId?this.domain(nodeId):undefined,
   authorizeJob:async(node:WorkNodeAuthority,job:WorkJob)=>{
    const w=this.wer;
    if(!w||this.beendet||node.node_id!==w.nodeId||String(node.boot_id)!==w.bootGeneration||node.service_token_hash!==w.authHash)return null;
    if(job.capability!==REVERSE_CAPABILITY||job.project!==REVERSE_PROJEKT||job.scope!=='reverse'||!this.k.kinds.includes(job.kind)||job.resourceNeed.gpu)return null;
    const max=this.k.parallel+ganz(process.env,'SYNAPSE_WORK_INTERACTIVE_RESERVE',1,0);
    const n=this.k.resourceNeed;
    return {resourceDomain:this.domain(w.nodeId),maxConcurrent:max,budget:{cpu:n.cpu*max,ram:n.ram*max,vram:0,gpu:false}};
   },
   inputStillCurrent:async(job:WorkJob,client:WorkJobClient)=>this.eingabeAktuell(job,client),
   outputIsStaged:async(job:WorkJob,out:Ref,client:WorkJobClient)=>{
    if(out.scope!=='reverse'||out.id!==job.id||job.kind!=='reverse-E')return false;
    const r=await client.query(`SELECT 1 FROM reverse_schichten s JOIN reverse_medien m ON m.id=s.medium_id
     WHERE s.medium_id=$1::bigint AND m.eintrag_id=$2 AND s.datei_id IS NULL AND s.schicht='E' AND s.aktuell
      AND s.status IN ('fertig','teilweise') AND s.ausgabe_key=$3`,
     [job.inputRef.revision,job.inputRef.id,job.inputRef.id+'/entpackt/'+reverseEGruppe(job.inputRef.revision)+'/'+job.id.toLowerCase()]);
    return r.rows.length>0;
   },
  };
 }
 private async eingabeAktuell(job:WorkJob,client:Pick<WorkJobClient,'query'>):Promise<boolean>{
  const ref=job.inputRef;
  if(job.kind!=='reverse-E'||ref.scope!=='reverse'||!/^[1-9][0-9]{0,18}$/.test(ref.revision))return false;
  const r=await client.query(`SELECT 1 FROM reverse_medien m JOIN reverse_eintraege e ON e.id=m.eintrag_id
   WHERE m.id=$1::bigint AND m.eintrag_id=$2 AND m.satz_sha256=$3 AND e.status='bestaetigt' FOR SHARE OF m`,[ref.revision,ref.id,ref.sha256]);
  return r.rows.length>0;
 }
 private async eingabe(job:WorkJob):Promise<{reverseId:string;mediumId:string;storageKey:string}|null>{
  const ref=job.inputRef;
  if(job.kind!=='reverse-E'||!/^[1-9][0-9]{0,18}$/.test(ref.revision))return null;
  const r=(await this.pool.query(`SELECT m.eintrag_id,m.id::text AS medium_id,d.storage_key FROM reverse_medien m
   JOIN reverse_eintraege e ON e.id=m.eintrag_id JOIN reverse_medien_dateien d ON d.medium_id=m.id AND d.rolle='haupt'
   WHERE m.id=$1::bigint AND m.eintrag_id=$2 AND m.satz_sha256=$3 AND e.status='bestaetigt' ORDER BY d.id LIMIT 1`,[ref.revision,ref.id,ref.sha256])).rows[0];
  const key=String(r?.storage_key??'');
  if(!r||!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(t=>!t||t==='.'||t==='..'))return null;
  return {reverseId:String(r.eintrag_id),mediumId:String(r.medium_id),storageKey:key};
 }
 /** E1: Systemprojekt, Descriptor und Aktivierung idempotent anlegen. */
 async einrichten():Promise<void>{
  await (this.deps.registriereProjekt??registerVirtualProject)(REVERSE_PROJEKT);
  try{await registerToolDescriptor(this.pool,reverseToolDescriptor(this.k),SERVER_AUTHORITY);}
  catch(e){if((e as Error).message!=='tool_descriptor_in_use')throw e;console.warn('[reverse-executor] Descriptor geändert, läuft noch mit altem Stand bis die Container ruhen.');}
  await setToolActivation(this.pool,REVERSE_TOOL_ID,null,true,SERVER_AUTHORITY);
  await setToolActivation(this.pool,REVERSE_TOOL_ID,REVERSE_PROJEKT,true,SERVER_AUTHORITY);
  this.eingerichtet=true;
 }
 async durchlauf():Promise<ReverseDurchlauf>{
  const leer=(hinweis?:string):ReverseDurchlauf=>({geprueft:true,geweckt:0,gestartet:0,...(hinweis?{hinweis}:{})});
  if(this.beendet)return leer('beendet');
  // K6: ohne Lebenszyklus nichts schreiben.
  const lc=this.deps.lifecycle();if(!lc)return leer('tool_lifecycle_aus');
  if(!this.eingerichtet)await this.einrichten();
  this.wer=await this.deps.identitaet();
  if(!this.wer)return leer('server_identitaet_fehlt');
  await this.raeumeArbeitAuf().catch(e=>console.error('[reverse-executor] Aufräumen fehlgeschlagen:',(e as Error).message));
  // W3: nur so viele Aufträge wecken und claimen, wie Plätze frei sind.
  const frei=this.k.parallel-this.laufend.size;
  if(frei<=0)return {geprueft:true,geweckt:0,gestartet:0};
  // Der Claim-Guard verlangt einen warmen Job-Container; offene Aufträge deshalb zuerst wecken.
  const offen=(await this.pool.query(`SELECT id FROM work_jobs WHERE capability=$1 AND project=$2 AND kind=ANY($3::text[])
   AND state='pending' AND (deadline IS NULL OR deadline>clock_timestamp()) ORDER BY created_at,id LIMIT $4`,
   [REVERSE_CAPABILITY,REVERSE_PROJEKT,this.k.kinds,frei])).rows;
  let geweckt=0;
  for(const row of offen){try{await lc.wake(REVERSE_TOOL_ID,REVERSE_PROJEKT,String(row.id));geweckt++;}catch(e){console.error('[reverse-executor] Wecken fehlgeschlagen:',(e as Error).message);}}
  const claims=await this.jobs.claim(this.wer,{limit:frei,leaseSeconds:this.k.leaseSeconds});
  const wer=this.wer;
  for(const job of claims){
   const lauf=this.fuehreAus(lc,wer,job).catch(e=>console.error('[reverse-executor] Auftrag fehlgeschlagen:',job.id,(e as Error).message))
    .finally(()=>{this.laufend.delete(job.id);});
   this.laufend.set(job.id,lauf);
  }
  return {geprueft:true,geweckt,gestartet:claims.length};
 }
 /** K3: Arbeitsordner ohne offenen Auftrag (verlorene Lease, Abbruch) entfernen. */
 async raeumeArbeitAuf():Promise<number>{
  let namen:string[];
  try{namen=(await readdir(this.k.arbeitRoot)).filter(n=>UUID.test(n)&&!this.laufend.has(n));}catch{return 0;}
  if(!namen.length)return 0;
  const offen=new Set((await this.pool.query("SELECT id::text FROM work_jobs WHERE id=ANY($1::uuid[]) AND state IN ('pending','leased','staged')",[namen])).rows.map(r=>String(r.id)));
  let n=0;
  for(const name of namen)if(!offen.has(name.toLowerCase())){await rm(path.join(this.k.arbeitRoot,name),{recursive:true,force:true});n++;}
  return n;
 }
 /** Wartet auf laufende Aufträge (Tests, geordnetes Herunterfahren). */
 async leerlauf():Promise<void>{await Promise.allSettled([...this.laufend.values()]);}
 private async leaseLebt(c:Pick<WorkJobClient,'query'>,job:WorkJob,wer:WorkIdentity,sperren:boolean):Promise<boolean>{
  const r=await c.query(`SELECT 1 FROM work_jobs WHERE id=$1 AND claim_token=$2 AND owner_node=$3 AND boot_generation=$4::uuid AND owner_auth_hash=$5
   AND state='leased' AND lease_until>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp())${sperren?' FOR UPDATE':''}`,
   [job.id,job.claimToken,wer.nodeId,wer.bootGeneration,wer.authHash]);
  return r.rows.length>0;
 }
 /** Übernahme nur, solange die eigene Lease gilt; späte Ergebnisse werden verworfen. */
 private async uebernimmUnterFence(job:WorkJob,wer:WorkIdentity,e:Parameters<typeof uebernehmeEErgebnis>[1]):Promise<{dateien:number;verworfen:number}|null>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return null;}
   // Ohne connect(): die Übernahme läuft in dieser Transaktion unter dem Lease-Fence.
   const r=await (this.deps.uebernahme??uebernehmeEErgebnis)({query:c.query.bind(c)},e,this.deps.uebernahmeOptionen);
   await c.query('COMMIT');return r;
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
 }
 /** Endgültiger Fehlschlag unter Lease-Fence; die Pipeline legt bei Bedarf einen neuen Versuch an. */
 private async scheitern(job:WorkJob,wer:WorkIdentity,code:string):Promise<boolean>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return false;}
   await c.query(`UPDATE work_jobs SET state='failed',error_code=$2,lease_until=NULL,staged_output_ref=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id,code]);
   await c.query("INSERT INTO work_job_audit(id,job_id,event,detail) VALUES(gen_random_uuid(),$1,'failed',$2::jsonb)",[job.id,JSON.stringify({fehlercode:code,executor:'reverse'})]);
   await c.query('UPDATE reverse_auftraege SET fehlercode=$2,updated_at=clock_timestamp() WHERE p20_auftrag_id=$1',[job.id,code]);
   await c.query('COMMIT');return true;
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
 }
 private async fuehreAus(lc:ToolLifecycle,wer:WorkIdentity,job:WorkJob):Promise<void>{
  const token=job.claimToken!;
  if(job.capability!==REVERSE_CAPABILITY||job.project!==REVERSE_PROJEKT||!this.k.kinds.includes(job.kind)){
   await this.jobs.release(wer,job.id,token);return;
  }
  // W5/K3: kein Endlos-Neuentpacken nach wiederholtem Lease-Verlust oder Übernahmefehler.
  if(job.attempt>this.k.retryMax){if(await this.scheitern(job,wer,'werkzeug_fehler'))await rm(path.join(this.k.arbeitRoot,job.id),{recursive:true,force:true});return;}
  const quelle=await this.eingabe(job);
  if(!quelle){await this.scheitern(job,wer,'nicht_gefunden');return;}
  const arbeit=await reverseArbeitsOrdner(this.k,job.id),ausgabe=path.join(arbeit,job.id);
  // Der Runner verlangt einen leeren Ausgabeordner; Reste eines verlorenen Versuchs entfernen.
  await rm(ausgabe,{recursive:true,force:true});
  await runnerOrdner(ausgabe);
  let lebt=true,aufraeumen=false;
  const timer=setInterval(()=>{void this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).then(ok=>{if(!ok)lebt=false;},()=>{lebt=false;});},this.k.renewMs);
  timer.unref();
  try{
   let ergebnis:Record<string,unknown>;
   try{
    ergebnis=await lc.execute(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id,wer,token,async()=>({kommando:'extrahieren',schicht:'E',
     eingabe:'/bib/'+quelle.storageKey,ausgabe:'/arbeit/'+job.id,
     grenzen:{zeitlimit_s:this.k.zeitlimitS,max_dateien:this.k.maxDateien,max_bytes:this.k.maxBytes}}));
   }catch(e){
    const m=(e as Error).message;
    // Nicht abgesetzt: sauber zurückgeben. Sonst bleibt der Auftrag bis zum Lease-Ablauf gesperrt.
    if(m==='tool_not_ready'||m==='tool_runner_capacity'){await this.jobs.release(wer,job.id,token);aufraeumen=true;}
    else console.error('[reverse-executor] Ausführung ohne sicheres Ende:',job.id,m);
    return;
   }
   clearInterval(timer);
   const status=String(ergebnis.status);
   const manifest=Array.isArray(ergebnis.manifest)?ergebnis.manifest as ReverseEManifestEintrag[]:[];
   if((status==='fertig'||(status==='teilweise'&&manifest.length>0))&&lebt){
    // K7: Lease vor der Übernahme einmal auffrischen (Hashing großer Ergebnisse unter dem Fence).
    if(!await this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).catch(()=>false)){console.warn('[reverse-executor] Lease verloren, Ergebnis verworfen:',job.id);return;}
    let r:{dateien:number;verworfen:number}|null;
    try{r=await this.uebernimmUnterFence(job,wer,{jobId:job.id,reverseId:quelle.reverseId,mediumId:quelle.mediumId,arbeitsWurzel:ausgabe,manifest});}
    catch(e){
     // W5: fachlicher Fehler -> endgültig; sonst freigeben, bis der Versuchszähler erreicht ist.
     console.error('[reverse-executor] Übernahme fehlgeschlagen:',job.id,(e as Error).message);
     if(e instanceof ReverseEUebernahmeFehler||job.attempt>=this.k.retryMax)aufraeumen=await this.scheitern(job,wer,e instanceof ReverseEUebernahmeFehler?fehlercode(e.code):'werkzeug_fehler');
     else aufraeumen=await this.jobs.release(wer,job.id,token);
     return;
    }
    if(!r){console.warn('[reverse-executor] Späte Rückmeldung nach Lease-Ablauf verworfen:',job.id);return;}
    aufraeumen=true;
    const out={scope:'reverse',id:job.id,revision:String(job.attempt),sha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
    if(!await this.jobs.stage(wer,job.id,token,out)){console.warn('[reverse-executor] Staging abgewiesen:',job.id);return;}
    const done=await this.jobs.complete(wer,job.id,token,job.inputRef);
    if(!done.completed)console.warn('[reverse-executor] Abschluss abgewiesen:',job.id);
    return;
   }
   if(!lebt){console.warn('[reverse-executor] Lease verloren, Ergebnis verworfen:',job.id);return;}
   aufraeumen=await this.scheitern(job,wer,status==='teilweise'?'zeitlimit':fehlercode(ergebnis.fehlercode));
  }finally{
   clearInterval(timer);
   // Nur mit gültigem Abschluss aufräumen: ein Folgeversuch nutzt denselben Auftragsordner.
   if(aufraeumen)await rm(arbeit,{recursive:true,force:true}).catch(()=>undefined);
  }
 }
 /** Lesender Status für reverse(status): Container des jüngsten offenen Auftrags dieses Eintrags. */
 async containerStatus(rid:string):Promise<ReverseContainerInfo>{
  const ruht:ReverseContainerInfo={zustand:'ruht',kaltstart_s:null};
  const lc=this.deps.lifecycle();if(!lc)return ruht;
  try{
   const j=(await this.pool.query(`SELECT id FROM work_jobs WHERE capability=$1 AND project=$2 AND kind=ANY($3::text[]) AND scope='reverse'
    AND input_ref->>'id'=$4 AND state IN ('pending','leased','staged') ORDER BY created_at DESC LIMIT 1`,[REVERSE_CAPABILITY,REVERSE_PROJEKT,this.k.kinds,rid])).rows[0];
   if(!j)return ruht;
   const s=await lc.status(REVERSE_TOOL_ID,REVERSE_PROJEKT,String(j.id));
   const zustand=s.status==='running'||s.status==='warm'?'laeuft':s.status==='waiting'||s.status==='stopping'?'startet':'ruht';
   return {zustand,kaltstart_s:typeof s.coldstart_estimate_ms==='number'?Math.round(s.coldstart_estimate_ms/100)/10:null,
    ...(s.container_id?{container_id:String(s.container_id)}:{})};
  }catch{return ruht;}
 }
 async beende():Promise<void>{this.beendet=true;await this.leerlauf();}
}

// ---------------------------------------------------------------------------------------------
/**
 * B1: eigener CPU-Knoten über denselben R4.3-Registryvertrag, aber eigener Env-Namensraum SYNAPSE_REVERSE_*
 * (NODE_ID, EXECUTOR_OWNER, COMPUTE_TOKEN, NODE_REGISTRATION, HOST_PROBE_FILE). Parser-Knoten (SYNAPSE_SERVER_*)
 * und dessen lokale GPU-Admission bleiben unberührt; claimOwner/Fence sind je node_id eindeutig.
 */
export function reverseServerIdentitaet(env:NodeJS.ProcessEnv=process.env):()=>Promise<WorkIdentity|null>{
 const server=new ServerExecutor({envPrefix:'SYNAPSE_REVERSE_',nurCpu:true,lokaleAdmission:false});let gestartet=false,gemeldet=false;
 const konflikt=!!server.identity.nodeId&&server.identity.nodeId===env.SYNAPSE_SERVER_NODE_ID?.trim();
 return async()=>{
  if(!server.identity.nodeId){if(!gemeldet){gemeldet=true;console.warn('[reverse-executor] SYNAPSE_REVERSE_NODE_ID fehlt – keine Claims.');}return null;}
  if(konflikt){if(!gemeldet){gemeldet=true;console.error('[reverse-executor] SYNAPSE_REVERSE_NODE_ID darf nicht SYNAPSE_SERVER_NODE_ID sein – keine Claims.');}return null;}
  try{
   if(!gestartet){await server.start();gestartet=true;}
   else if(!await server.refresh())return null;
  }catch(e){if(!gemeldet){gemeldet=true;console.error('[reverse-executor] Server-Identität abgelehnt:',(e as Error).message);}return null;}
  const f=server.fence;
  return f?{nodeId:f.nodeId,bootGeneration:f.bootId,authHash:f.tokenHash}:null;
 };
}
/**
 * Vor initToolLifecycle aufrufen: konfiguriert Docker-Mounts/Ressourcen, Hooks und die Abholschleife.
 * Liefert null, wenn Reverse aus ist oder die Konfiguration fehlt.
 */
export function starteReverseExecutor():{beende:()=>Promise<void>}|null{
 const asset=getAssetKonfiguration();
 if(process.env.SYNAPSE_REVERSE_ENABLED!=='1'||!asset.reverse.aktiv)return null;
 let k:ReverseExecutorKonfig|null;
 try{k=ladeReverseExecutorKonfig(process.env,asset.speicher.reverseRoot);}
 catch(e){console.error('[reverse-executor] Konfiguration ungültig, Executor bleibt aus:',(e as Error).message);return null;}
 if(!k)return null;
 const konfig=k;
 try{configureToolLifecycleAdapters({executor:new DockerToolContainerExecutor({socketPath:process.env.SYNAPSE_TOOL_DOCKER_SOCKET,resolveMounts:reverseMountResolver(konfig),
  lokaleImages:process.env.SYNAPSE_REVERSE_IMAGE_LOKAL==='1'}),resources:reverseRessourcen});}
 catch(e){console.error('[reverse-executor] Tool-Lebenszyklus bereits gestartet, Executor bleibt aus:',(e as Error).message);return null;}
 const executor=new ReverseExecutor({konfig,lifecycle:getToolLifecycle,identitaet:reverseServerIdentitaet()});
 const abmelden=registriereWorkJobHooks(REVERSE_CAPABILITY,executor.hooks());
 // K5: reverse(status) liest den echten Containerzustand über die Reverse-Runtime (nach starteReversePipeline gesetzt).
 const ohneStatus=ergaenzeReverseRuntime({containerStatus:rid=>executor.containerStatus(rid)});
 let running:Promise<ReverseDurchlauf>|null=null;
 const tick=async()=>{if(!running)running=executor.durchlauf().finally(()=>{running=null;});return running;};
 registriereWorker({name:'reverse-executor',beschreibung:'RV12 reverse-E-Aufträge im Reverse-Container ausführen',durchlauf:tick});
 const run=()=>{if(workerPausiert('reverse-executor'))return;void tick().catch(e=>console.error('[reverse-executor] Durchlauf fehlgeschlagen:',(e as Error).message));};
 const timer=setInterval(run,konfig.tickMs);timer.unref();
 console.log('[reverse-executor] aktiv: Kinds '+konfig.kinds.join(',')+', parallel '+konfig.parallel);
 return {beende:async()=>{clearInterval(timer);abmelden();ohneStatus();await executor.beende();}};
}
