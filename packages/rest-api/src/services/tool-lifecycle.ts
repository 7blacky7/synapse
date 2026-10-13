/**
 * R5.1: PG-fenced tool lifecycle. Kein Docker/HTTP unter Transaktionslocks.
 * Descriptor, Policy und Jobs sind durable; Poll/Enabled allein startet nichts.
 * resources ist der serverseitige Brokeranschluss. Ohne Adapter keine Ressourcenfreigabe/Starts.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {getPool,validateToolDescriptor,TOOL_CONTAINER_LOCK,registerWorkJobClaimGuard,
 toolDescriptorHash,type ToolDescriptor,type WorkIdentity} from '@synapse/core';
export interface ToolInstanceContext {instance_id:string;project:string;job_id:string|null;warmup_job_id:string;generation:string;name:string;isCurrent:()=>Promise<boolean>}
export interface ToolObservation {container_id:string;running:boolean;cpu_percent:number|null;gpu_percent:number|null;measured_at:string;start_observed?:boolean}
export interface ToolContainerExecutor {
 start(d:ToolDescriptor,ctx:ToolInstanceContext):Promise<{id:string;coldstart_ms:number}>;
 observe(id:string):Promise<ToolObservation>;
 stop(id:string):Promise<void>;
 cleanup?(id:string):Promise<void>;
 command(id:string,request:Record<string,unknown>,timeoutMs:number,maxBytes:number,onTerminal?:()=>void,maxInputBytes?:number):Promise<Record<string,unknown>>;
}
export interface ToolResourceAdapter {
 acquire(d:ToolDescriptor,ctx:ToolInstanceContext):Promise<string|null>;
 /** Idempotent je Reservierungstoken, auch bei gleichzeitiger Recovery zweier API-Prozesse. */
 release(token:string):Promise<void>;
}
type Db=Pick<Pool,'query'|'connect'>;
interface Runtime {
 instance_id:string;tool_id:string;project:string;work_job_id:string|null;generation:string;state:string;
 container_id:string|null;resource_token:string|null;operation_token:string|null;wake_requested:boolean;
 warmup_job_id:string|null;ready_at:Date|null;operation_at:Date|null;measurement_at:Date|null;
 cpu_percent:number|null;gpu_percent:number|null;coldstart_ms:number|null;starts:Date[];
 blocked_until:Date|null;last_error:string|null;now:Date;start_inflight:boolean;
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export class ToolLifecycle {
 private readonly pool:Db;private readonly executor:ToolContainerExecutor;private readonly resources?:ToolResourceAdapter;
 private readonly maxContainers:number;private readonly starts=new Map<string,Promise<unknown>>();private unregister:()=>void;
 constructor(deps:{pool?:Db;executor:ToolContainerExecutor;resources?:ToolResourceAdapter;maxContainers?:number;registerGuards?:boolean}){
  this.pool=deps.pool??getPool();this.executor=deps.executor;this.resources=deps.resources;this.maxContainers=deps.maxContainers??4;
  if(!Number.isSafeInteger(this.maxContainers)||this.maxContainers<1)throw Error('invalid_tool_capacity');
  this.unregister=deps.registerGuards===false?()=>{}:registerWorkJobClaimGuard('tool-lifecycle',{
   lock:async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[TOOL_CONTAINER_LOCK]);},
   allow:async(job,c)=>{
    if(job.kind==='tool-warmup')return false; // Kontrolljob ausschließlich generationsgebundener Lifecycle.
    const r=await c.query<{descriptor:ToolDescriptor;enabled:boolean}>('SELECT descriptor,enabled FROM tool_descriptors WHERE capability=$1',[job.capability]);
    if(!r.rows.length)return true;
    const row=r.rows[0],d=validateToolDescriptor(row.descriptor);
    if(!row.enabled||job.capability!==d.capability)return false; // Warmup nur Lifecycle, kein fremder Executor.
    const enabled=await c.query('SELECT 1 FROM tool_activation WHERE tool_id=$1 AND project=$2 AND enabled AND EXISTS(SELECT 1 FROM projects WHERE name=$2 AND enabled)',[d.tool_id,job.project]);
    if(!enabled.rows.length)return false;
    const state=await c.query('SELECT 1 FROM tool_containers WHERE instance_id=$1 AND state=$2',[this.key(d,job.project,d.instance_scope==='job'?job.id:null),'warm']);
    if(!state.rows.length)return false;
    const runs=await c.query<{n:number;unknown:number}>("SELECT COUNT(*)::int AS n,COUNT(*) FILTER(WHERE state='unknown')::int AS unknown FROM tool_container_runs WHERE instance_id=$1 AND state IN('running','unknown')",[this.key(d,job.project,d.instance_scope==='job'?job.id:null)]);
    return runs.rows[0].unknown===0&&runs.rows[0].n<d.resources.concurrency;
   }
  });
 }
 close(){this.unregister();}
 private key(d:ToolDescriptor,p:string,j:string|null){return hash(d.tool_id+'\0'+p+'\0'+(d.instance_scope==='job'?(j??'warmup'):'project'));}
 private async tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[TOOL_CONTAINER_LOCK]);
   const value=await fn(c);await c.query('COMMIT');return value;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 private async descriptor(id:string):Promise<ToolDescriptor>{
  const r=await this.pool.query('SELECT descriptor FROM tool_descriptors WHERE tool_id=$1',[id]);
  if(!r.rows[0])throw Error('unknown_tool_descriptor');return validateToolDescriptor(r.rows[0].descriptor);
 }
 private async allowed(c:Pick<PoolClient,'query'>,d:ToolDescriptor,p:string):Promise<boolean>{
  const r=await c.query(`SELECT 1 FROM tool_descriptors d JOIN tool_activation a USING(tool_id)
   WHERE d.tool_id=$1 AND d.enabled AND a.project=$2 AND a.enabled
    AND EXISTS(SELECT 1 FROM projects WHERE name=$2 AND enabled)`,[d.tool_id,p]);
  return !!r.rows.length;
 }
 private async signals(c:Pick<PoolClient,'query'>,d:ToolDescriptor,p:string,j:string|null){
  const jobs=await c.query(`SELECT COUNT(*)::int AS n FROM work_jobs
   WHERE project=$1 AND capability=$2 AND kind<>'tool-warmup' AND (state IN('pending','leased','staged') OR resource_unconfirmed)
    AND ($3::uuid IS NULL OR id=$3)`,[p,d.capability,j]);
  const activity=await c.query(`SELECT 1 FROM tool_aktivitaet WHERE projekt=$1 AND tool_id=$2 AND tool=$3
   AND zaehlt_als_aktivitaet AND zeit>=clock_timestamp()-($4*interval '1 second') LIMIT 1`,[p,d.tool_id,d.tool,d.lifecycle.activity_lookback_seconds]);
  return {jobs:Number(jobs.rows[0].n),activity:!!activity.rows.length};
 }
 private async row(c:Pick<PoolClient,'query'>,id:string):Promise<Runtime|null>{
  return (await c.query<Runtime>('SELECT *,clock_timestamp() AS now FROM tool_containers WHERE instance_id=$1',[id])).rows[0]??null;
 }
 private budget<T>(promise:Promise<T>,ms:number):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('tool_operation_timeout')),ms);
   promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
 }
 private context(r:Runtime,token:string):ToolInstanceContext{
  return {instance_id:r.instance_id,project:r.project,job_id:r.work_job_id,warmup_job_id:r.warmup_job_id!,generation:r.generation,
   name:'synapse-tool-'+r.instance_id.slice(0,20)+'-'+r.generation,
   isCurrent:async()=>!!(await this.pool.query('SELECT 1 FROM tool_containers WHERE instance_id=$1 AND generation=$2 AND operation_token=$3 AND state=$4',[r.instance_id,r.generation,token,'waiting'])).rows.length};
 }
 async status(toolId:string,project:string,jobId:string|null=null){
  const d=await this.descriptor(toolId),r=await this.row(this.pool,this.key(d,project,jobId));
  const s=await this.signals(this.pool,d,project,d.instance_scope==='job'?jobId:null);
  return {tool_id:toolId,project,instance_id:r?.instance_id??null,container_id:r?.container_id??null,
   status:r?.state==='warm'&&s.jobs>0?'running':r?.state??'cold',jobs:s.jobs,
   measurement_age_ms:r?.measurement_at?Math.max(0,+r.now-+r.measurement_at):null,
   idle_stop_at:r?.state==='warm'&&r.ready_at&&!s.jobs&&!s.activity?new Date(+r.ready_at+d.lifecycle.idle_ms).toISOString():null,
   coldstart_estimate_ms:r?.coldstart_ms??'unknown',error:r?.last_error??null};
 }
 async wake(toolId:string,project:string,jobId:string|null=null):Promise<unknown>{
  const d=await this.descriptor(toolId),key=this.key(d,project,jobId);
  const existing=this.starts.get(key);if(existing)return existing;
  const start=this.wakeInner(d,project,d.instance_scope==='job'?jobId:null).finally(()=>{if(this.starts.get(key)===start)this.starts.delete(key);});
  this.starts.set(key,start);return start;
 }
 private async wakeInner(d:ToolDescriptor,p:string,j:string|null){
  const id=this.key(d,p,j);
  const reserved=await this.tx(async c=>{
   if(!await this.allowed(c,d,p))return null;
   const version=await c.query('SELECT descriptor_hash FROM tool_descriptors WHERE tool_id=$1',[d.tool_id]);
   if(version.rows[0]?.descriptor_hash!==toolDescriptorHash(d))throw Error('tool_descriptor_changed');
   const signal=await this.signals(c,d,p,j);
   let r=await this.row(c,id);
   if(!signal.jobs&&!signal.activity&&!r?.wake_requested)return null;
   if(j){const job=await c.query('SELECT 1 FROM work_jobs WHERE id=$1 AND project=$2 AND capability=$3',[j,p,d.capability]);if(!job.rows.length)throw Error('tool_job_binding');}
   if(r?.state==='stopping'){await c.query('UPDATE tool_containers SET wake_requested=TRUE WHERE instance_id=$1',[id]);return null;}
   if(r?.state==='warm'||(r?.state==='waiting'&&r.operation_token))return null;
   if(r?.blocked_until&&+r.blocked_until>+r.now)throw Error('container_gesperrt');
   const capacity=await c.query("SELECT COUNT(*)::int AS n FROM tool_containers WHERE state IN('warm','stopping') OR (state='waiting' AND operation_token IS NOT NULL)");
   if(Number(capacity.rows[0].n)>=this.maxContainers)return null; // Kein Pin/LRU-Überziehen.
   const reusableWarmup=r?.state==='waiting'?r.warmup_job_id:null;
   const generation=reusableWarmup?r!.generation:randomUUID(),token=randomUUID();
   await c.query(`INSERT INTO tool_containers(instance_id,tool_id,project,work_job_id,generation,state,operation_token,operation_at)
    VALUES($1,$2,$3,$4,$5,'waiting',$6,clock_timestamp())
    ON CONFLICT(instance_id) DO UPDATE SET generation=$5,state='waiting',operation_token=$6,operation_at=clock_timestamp(),last_error=NULL`,[id,d.tool_id,p,j,generation,token]);
   r=(await this.row(c,id))!;
   const starts=r.starts.filter(t=>+r!.now-+new Date(t)<d.lifecycle.start_window_ms);
   if(starts.length>=d.lifecycle.max_starts){
    await c.query("UPDATE tool_containers SET state='blocked',operation_token=NULL,blocked_until=clock_timestamp()+($2*interval '1 millisecond'),last_error='container_gesperrt' WHERE instance_id=$1",[id,d.lifecycle.pause_ms]);
    if(r.warmup_job_id)await c.query("UPDATE work_jobs SET state='failed',error_code='container_gesperrt',updated_at=clock_timestamp() WHERE id=$1 AND state='pending'",[r.warmup_job_id]);
    return {blocked:true} as const;
   }
   const warmId=reusableWarmup??randomUUID(),input={scope:'tool-descriptor',id:toolDescriptorHash(d),revision:'1',sha256:toolDescriptorHash(d)};
   const need={cpu:d.resources.cpu,ram:d.resources.ram,vram:d.resources.vram,gpu:d.resources.gpu};
   const request={kind:'tool-warmup',capability:d.capability+'.warmup',profileId:d.tool_id,project:p,scope:'tool-container',inputRef:input,resourceNeed:need,priority:'interaktiv',deadline:null};
   await c.query(`INSERT INTO work_jobs(id,kind,capability,profile_id,project,scope,input_ref,resource_need,priority,idempotency_key,request_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(idempotency_key) DO NOTHING`,[warmId,request.kind,request.capability,d.tool_id,p,request.scope,input,need,'interaktiv','tool-warmup:'+id+':'+generation,hash(JSON.stringify(request))]);
   await c.query('UPDATE tool_containers SET warmup_job_id=$2 WHERE instance_id=$1',[id,warmId]);
   return {r:{...r,warmup_job_id:warmId},token,starts};
  });
  if(!reserved)return this.status(d.tool_id,p,j);
  if('blocked' in reserved)throw Error('container_gesperrt');
  const {r,token}=reserved,ctx=this.context(r,token);
  let resource:string|null=null,container=ctx.name;
  try{
   if(!this.resources)throw Error('tool_admission_unconfigured');
   resource=await this.resources.acquire(d,ctx);
   if(!resource)throw Error('tool_resources_waiting');
   await this.tx(async c=>{
    if(!(await this.row(c,id))?.operation_token||!await this.allowed(c,d,p))throw Error('tool_start_fenced');
    const update=await c.query(`UPDATE tool_containers SET resource_token=$3,container_id=$4,start_inflight=TRUE,starts=$5::timestamptz[]||ARRAY[clock_timestamp()]
     WHERE instance_id=$1 AND operation_token=$2`,[id,token,resource,container,reserved.starts]);
    if(!update.rowCount)throw Error('tool_start_fenced');
   });
   const startup=this.executor.start(d,ctx).finally(async()=>{await this.pool.query('UPDATE tool_containers SET start_inflight=FALSE WHERE instance_id=$1 AND generation=$2',[id,r.generation]);});
   const result=await this.budget(startup,d.lifecycle.start_timeout_ms);container=result.id;
   if(!Number.isSafeInteger(result.coldstart_ms)||result.coldstart_ms<0)throw Error('invalid_coldstart_measurement');
   await this.tx(async c=>{
    const update=await c.query(`UPDATE tool_containers SET state='warm',container_id=$3,ready_at=clock_timestamp(),
     coldstart_ms=$4,operation_token=NULL,wake_requested=FALSE,updated_at=clock_timestamp()
     WHERE instance_id=$1 AND operation_token=$2 AND state='waiting'`,[id,token,result.id,result.coldstart_ms]);
    if(!update.rowCount)throw Error('tool_start_fenced');
    await c.query("UPDATE work_jobs SET state='completed',output_ref=input_ref,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND state='pending'",[r.warmup_job_id]);
   });
  }catch(error){
   if(!resource&&error instanceof Error&&['tool_admission_unconfigured','tool_resources_waiting'].includes(error.message)){
    await this.tx(async c=>{await c.query("UPDATE tool_containers SET state='waiting',operation_token=NULL,container_id=NULL,resource_token=NULL,last_error=$3 WHERE instance_id=$1 AND operation_token=$2",[id,token,error.message]);});
    return this.status(d.tool_id,p,j); // Ein einziger pending Warmup, keine fehlgeschlagenen Poll-Jobs.
   }
   // Reservierung bleibt sichtbar, bis der eventuell angelegte Container sicher beendet ist.
   await this.tx(async c=>{
    await c.query("UPDATE tool_containers SET state='stopping',container_id=$3,resource_token=$4,last_error=$5 WHERE instance_id=$1 AND operation_token=$2",[id,token,container,resource,String(error)]);
    await c.query("UPDATE work_jobs SET state='failed',error_code=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='pending'",[r.warmup_job_id,String(error)]);
   });
   await this.finishStop({...r,container_id:container,resource_token:resource,state:'stopping',operation_token:token},d).catch(()=>{});
   throw error;
  }
  return this.status(d.tool_id,p,j);
 }
 private async finishStop(r:Runtime,d:ToolDescriptor):Promise<void>{
  const pending=await this.pool.query('SELECT 1 FROM tool_containers WHERE instance_id=$1 AND generation=$2 AND start_inflight',[r.instance_id,r.generation]);
  const before=r.container_id?await this.budget(this.executor.observe(r.container_id),d.lifecycle.start_timeout_ms):null;
  if(pending.rows.length){
   if(!before?.start_observed)throw Error('tool_start_unconfirmed');
   await this.pool.query('UPDATE tool_containers SET start_inflight=FALSE WHERE instance_id=$1 AND generation=$2',[r.instance_id,r.generation]);
  }
  if(before?.running){await this.budget(this.executor.stop(r.container_id!),d.lifecycle.start_timeout_ms);}
  else if(r.container_id){await this.budget(this.executor.cleanup?.(r.container_id)??Promise.resolve(),d.lifecycle.start_timeout_ms);}
  const after=r.container_id?await this.budget(this.executor.observe(r.container_id),d.lifecycle.start_timeout_ms):null;
  if(after?.running)throw Error('tool_stop_unconfirmed');
  if(r.resource_token){if(!this.resources)throw Error('tool_resource_release_unconfigured');await this.budget(this.resources.release(r.resource_token),d.lifecycle.start_timeout_ms);}
  await this.tx(async c=>{
   await c.query(`UPDATE tool_containers SET state='cold',container_id=NULL,resource_token=NULL,operation_token=NULL,measurement_at=NULL,updated_at=clock_timestamp()
    WHERE instance_id=$1 AND generation=$2 AND operation_token=$3 AND state='stopping'`,[r.instance_id,r.generation,r.operation_token]);
   // Nur physisch beendete Runner dürfen aus unbekannt/running freigegeben werden.
   await c.query("UPDATE tool_container_runs SET state='done',updated_at=clock_timestamp() WHERE instance_id=$1 AND generation=$2",[r.instance_id,r.generation]);
  });
 }
 async tick():Promise<void>{
  // Jobs/Aktivität von gebundenen aktiven Projekten liefern Instanzen, enabled allein nie.
  const descriptors=await this.pool.query('SELECT descriptor FROM tool_descriptors WHERE enabled');
  for(const x of descriptors.rows){
   const d=validateToolDescriptor(x.descriptor);
   const projects=await this.pool.query('SELECT project FROM tool_activation WHERE tool_id=$1 AND enabled',[d.tool_id]);
   for(const {project} of projects.rows){
    const jobs=await this.pool.query("SELECT id FROM work_jobs WHERE project=$1 AND capability=$2 AND kind<>'tool-warmup' AND state IN('pending','leased','staged')",[project,d.capability]);
    if(d.instance_scope==='job')for(const job of jobs.rows)await this.wake(d.tool_id,project,job.id).catch(e=>console.error('[tool-lifecycle] Wake gesperrt:',e));
    else await this.wake(d.tool_id,project).catch(e=>console.error('[tool-lifecycle] Wake gesperrt:',e));
   }
  }
  const rows=await this.pool.query<Runtime>(`SELECT *,clock_timestamp() AS now FROM tool_containers WHERE state IN('warm','stopping') OR (state='waiting' AND operation_token IS NOT NULL) ORDER BY instance_id`);
  for(const r of rows.rows){
   try {
   const d=await this.descriptor(r.tool_id);
   if(r.state==='waiting'&&r.operation_token&&r.operation_at&&+r.now-+r.operation_at>d.lifecycle.start_timeout_ms*2){
    const token=randomUUID();
    await this.tx(async c=>{await c.query("UPDATE tool_containers SET state='stopping',operation_token=$2 WHERE instance_id=$1 AND state='waiting' AND operation_token=$3",[r.instance_id,token,r.operation_token]);});
    const current=await this.row(this.pool,r.instance_id);
    if(current?.operation_token===token)await this.finishStop(current,d);
    continue;
   }
   if(r.state==='stopping'){await this.finishStop(r,d);continue;}
   if(r.state!=='warm'||!r.container_id)continue;
   const sample=await this.budget(this.executor.observe(r.container_id),d.lifecycle.start_timeout_ms);
   if(sample.container_id!==r.container_id)throw Error('tool_measurement_foreign');
   if(!sample.running){
    await this.tx(async c=>{await c.query("UPDATE tool_containers SET state='stopping',operation_token=$3,last_error='container_crashed' WHERE instance_id=$1 AND generation=$2 AND state='warm'",[r.instance_id,r.generation,randomUUID()]);});
    const dead=await this.row(this.pool,r.instance_id);if(dead?.state==='stopping')await this.finishStop(dead,d);
    continue;
   }
   const stopping=await this.tx(async c=>{
    const current=await this.row(c,r.instance_id);if(!current||current.generation!==r.generation||current.state!=='warm')return null;
    const cpu=typeof sample.cpu_percent==='number'&&Number.isFinite(sample.cpu_percent)&&sample.cpu_percent>=0?sample.cpu_percent:null;
    const gpu=typeof sample.gpu_percent==='number'&&Number.isFinite(sample.gpu_percent)&&sample.gpu_percent>=0?sample.gpu_percent:null;
    const measured=new Date(sample.measured_at);
    const age=+current.now-+measured;
    if(!Number.isFinite(age)||age<0||age>d.lifecycle.measurement_max_age_ms)return null;
    await c.query('UPDATE tool_containers SET cpu_percent=$2,gpu_percent=$3,measurement_at=$4 WHERE instance_id=$1',[r.instance_id,cpu,gpu,measured]);
    const signal=await this.signals(c,d,r.project,r.work_job_id);
    const warm=await c.query("SELECT 1 FROM work_jobs WHERE id=$1 AND state IN('pending','leased','staged')",[r.warmup_job_id]);
    const runs=await c.query("SELECT 1 FROM tool_container_runs WHERE instance_id=$1 AND state IN('running','unknown')",[r.instance_id]);
    if(signal.jobs||signal.activity||warm.rows.length||runs.rows.length||current.wake_requested||!current.ready_at||
     +current.now-+current.ready_at<d.lifecycle.idle_ms||cpu===null||cpu>d.lifecycle.cpu_idle_percent||
     (d.resources.gpu&&(gpu===null||gpu>d.lifecycle.gpu_idle_percent)))return null;
    const token=randomUUID();await c.query("UPDATE tool_containers SET state='stopping',operation_token=$2,operation_at=clock_timestamp() WHERE instance_id=$1",[r.instance_id,token]);
    return {...current,state:'stopping',operation_token:token};
   });
   if(stopping)await this.finishStop(stopping,d);
   } catch(e) {console.error('[tool-lifecycle] Instanzprüfung fehlgeschlagen:',e);}
  }
 }
 /** Nur geleaste, ausweis-/boot-/inputgebundene Work-Jobs; Auftrag bleibt bei unklarem Ende gesperrt. */
 async execute(toolId:string,project:string,jobId:string,who:WorkIdentity,claimToken:string,buildCommand:(job:Record<string,unknown>)=>Promise<Record<string,unknown>>){
  const d=await this.descriptor(toolId),id=this.key(d,project,d.instance_scope==='job'?jobId:null);
  const accepted=await this.tx(async c=>{
   const r=await this.row(c,id);if(!r||r.state!=='warm'||!r.container_id||!await this.allowed(c,d,project))throw Error('tool_not_ready');
   const active=await c.query("SELECT COUNT(*)::int AS n,COUNT(*) FILTER(WHERE state='unknown')::int AS unknown FROM tool_container_runs WHERE instance_id=$1 AND state IN('running','unknown')",[id]);
   if(active.rows[0].unknown>0||active.rows[0].n>=d.resources.concurrency)throw Error('tool_runner_capacity');
   const result=await c.query(`SELECT w.* FROM work_jobs w JOIN embedding_knoten n ON n.node_id=w.owner_node
    WHERE w.id=$1 AND w.project=$2 AND w.capability=$3 AND w.kind<>'tool-warmup' AND w.state='leased' AND w.lease_until>clock_timestamp()
     AND (w.deadline IS NULL OR w.deadline>clock_timestamp()) AND w.owner_node=$4 AND w.boot_generation=$5
     AND w.owner_auth_hash=$6 AND w.claim_token=$7 AND n.boot_id=w.boot_generation AND n.service_token_hash=w.owner_auth_hash
    FOR SHARE OF w,n`,[jobId,project,d.capability,who.nodeId,who.bootGeneration,who.authHash,claimToken]);
   const job=result.rows[0];if(!job)throw Error('tool_job_fenced');
   const run=await c.query("INSERT INTO tool_container_runs(job_id,attempt,instance_id,generation,state) VALUES($1,$2,$3,$4,'running') ON CONFLICT DO NOTHING",[jobId,job.attempt,id,r.generation]);
   if(!run.rowCount)throw Error('tool_job_already_executed');
   return {r,job};
  });
  let dispatched=false;
  try{
   const payload=await buildCommand(accepted.job);
   if(Buffer.byteLength(JSON.stringify(payload))>d.limits.input_bytes)throw Error('tool_input_limit');
   const terminal=()=>{void this.pool.query("UPDATE tool_container_runs SET state='done',updated_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2 AND generation=$3",[jobId,accepted.job.attempt,accepted.r.generation]).catch(e=>console.error('[tool-lifecycle] terminal ack failed:',e));};
   const still=await this.pool.query("SELECT 1 FROM work_jobs WHERE id=$1 AND state='leased' AND claim_token=$2 AND attempt=$3 AND lease_until>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp())",[jobId,claimToken,accepted.job.attempt]);
   if(!still.rows.length)throw Error('tool_job_fenced');
   dispatched=true;
   const result=await this.executor.command(accepted.r.container_id!,{...payload,auftrag_id:jobId},d.limits.time_ms,d.limits.output_bytes,terminal,d.limits.input_bytes);
   await this.pool.query("UPDATE tool_container_runs SET state='done',updated_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2 AND generation=$3",[jobId,accepted.job.attempt,accepted.r.generation]);
   return result; // Fachadapter staged/publiziert anschließend mit R2.1-Output-Fence.
  }catch(e){
   await this.pool.query("UPDATE tool_container_runs SET state=$3,updated_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2 AND state='running'",[jobId,accepted.job.attempt,dispatched?'unknown':'done']);
   throw e; // Timeout ist kein physischer Endnachweis und rechtfertigt keinen Idle-Abbruch.
  }
 }
}
