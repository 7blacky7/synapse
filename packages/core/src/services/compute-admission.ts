/** P20-T15: kurze PG-Zulassung je physischem Gerät, keine Netzoperation unter Lock. */
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {getPool} from '../db/client.js';
import {embeddingComputePolicy,computePolicyAktiv} from './compute-policy.js';
import {computeResourceBinding,computePhysicalDeviceKey,computeResourceSnapshot,type ComputeResources} from '../vertrag/compute-ressourcen.js';
export type AdmissionPriority='interaktiv'|'hintergrund'|'nachzug';
export interface AdmissionDb {query<T extends Record<string,unknown>=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[];rowCount?:number|null}>}
export interface AdmissionPool extends AdmissionDb {connect():Promise<AdmissionDb&{release():void}>}
export interface AdmissionIdentity {nodeId:string;bootId:string;authHash:string}
export interface AdmissionClaimRef {chunkId:string;claimToken:string;contentHash:string}
export interface AdmissionInput extends AdmissionIdentity {id:string;source:string;priority:AdmissionPriority;model:string;maxWaitMs?:number;backend?:string;claims?:AdmissionClaimRef[]}
export interface AdmissionLease {id:string;token:string;domain:string;state:'waiting'|'running';reason?:'priority'|'model_control'|'http_capacity'|'telemetry_unknown'|'vram_capacity'}
interface DomainConfig {maxHttp:number;interactiveReserve:number;vramMb:number;modelMb:Record<string,number>;pollMs:number;maxWaitMs:number;agingMs:number}
export interface AdmissionContext {source:string;priority:AdmissionPriority;maxWaitMs?:number;backend?:string;claims?:AdmissionClaimRef[];releaseLocal?:()=>void;resumeLocal?:()=>Promise<void>}
export interface AdmissionRemote {
 acquire(model:string,context:AdmissionContext):Promise<AdmissionLease|null>;
 finish(lease:AdmissionLease,confirmed:boolean):Promise<void>;
}
const context=new AsyncLocalStorage<AdmissionContext>();
let remote:AdmissionRemote|null=null;
export function configureRemoteComputeAdmission(adapter:AdmissionRemote|null):void {remote=adapter;}
export function computeAdmissionAktiv():boolean {return !!remote||(process.env.SYNAPSE_COMPUTE_NODE!=='1'&&process.env.SYNAPSE_COMPUTE_ADMISSION==='1');}
export function mitComputeAdmissionKontext<T>(value:AdmissionContext,run:()=>Promise<T>):Promise<T>{return context.run(value,run);}
export class ComputeAdmissionError extends Error {constructor(readonly code:string){super(code);this.name='ComputeAdmissionError';}}
function fail(code:string):never {throw new ComputeAdmissionError(code);}
const uuid=(s:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
const normalModel=(s:string)=>s.includes(':')?s:s+':latest';
const integer=(n:unknown,min:number)=>{if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>2147483647)fail('admission_config_invalid');return n as number;};
export function computeAdmissionDomain(nodeId:string):{host:string;device:string;key:string;config:DomainConfig}|null {
 if(process.env.SYNAPSE_COMPUTE_ADMISSION!=='1')return null;
 if(!computePolicyAktiv())fail('admission_policy_required');
 const binding=computeResourceBinding(nodeId);if(!binding)fail('admission_binding_missing');
 const devices=JSON.parse(process.env.SYNAPSE_COMPUTE_ADMISSION_DEVICES??'{}') as Record<string,string>;
 const device=devices[nodeId]??(binding.deviceIds.length===1?binding.deviceIds[0]:undefined);
 if(!device)fail('admission_device_missing');
 if(nodeId===process.env.SYNAPSE_SERVER_NODE_ID&&process.env.SYNAPSE_SERVER_EMBED_DEVICE_ID&&device!==process.env.SYNAPSE_SERVER_EMBED_DEVICE_ID)fail('admission_device_binding_invalid');
 const key=computePhysicalDeviceKey(binding,device);
 const all=JSON.parse(process.env.SYNAPSE_COMPUTE_ADMISSION_DOMAINS??'{}') as Record<string,DomainConfig>;
 const raw=all[key];if(!raw||typeof raw!=='object')fail('admission_domain_config_missing');
 const config={maxHttp:integer(raw.maxHttp,1),interactiveReserve:integer(raw.interactiveReserve,0),
  vramMb:integer(raw.vramMb,0),modelMb:raw.modelMb,pollMs:integer(raw.pollMs??50,1),
  maxWaitMs:integer(raw.maxWaitMs??30000,1),agingMs:integer(raw.agingMs??300000,1)};
 if(config.interactiveReserve>config.maxHttp||!config.modelMb||typeof config.modelMb!=='object'||Array.isArray(config.modelMb))fail('admission_config_invalid');
 const models:Record<string,number>={};
 for(const [name,n] of Object.entries(config.modelMb)){
  const canonical=normalModel(name);integer(n,0);
  if(Object.hasOwn(models,canonical)&&models[canonical]!==n)fail('admission_model_budget_conflict');models[canonical]=n;
 }
 config.modelMb=models;
 return {host:binding.hostResourceDomain,device,key,config};
}
/** R2/R1.2: dieselbe Hostdomain zuerst, Gerät danach, erst dann Knoten-/Joblocks. */
function domainPolicy(d:NonNullable<ReturnType<typeof computeAdmissionDomain>>){
 const policy={...d.config,modelMb:Object.fromEntries(Object.entries(d.config.modelMb).sort(([a],[b])=>a<b?-1:a>b?1:0))};
 const json=JSON.stringify(policy),hash=createHash('sha256').update(json).digest('hex');return {json,hash};
}
export async function lockComputeAdmissionDomain(db:AdmissionDb,nodeId:string):Promise<ReturnType<typeof computeAdmissionDomain>>{
 if(process.env.SYNAPSE_COMPUTE_ADMISSION!=='1')return null;
 const binding=computeResourceBinding(nodeId);
 if(!binding){
  const node=(await db.query<{node_kind:string}>('SELECT node_kind FROM embedding_knoten WHERE node_id=$1',[nodeId])).rows[0];
  if(node?.node_kind==='cpu')return null; // bestehende CPU-Authority bleibt beim Work-Hostlock
 }
 if(binding?.deviceIds.length===0){
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-domain:'+binding.hostResourceDomain]);return null;
 }
 const d=computeAdmissionDomain(nodeId);if(!d)return null;
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-domain:'+d.host]);
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['compute-device:'+d.key]);
 const policy=domainPolicy(d);
 await db.query('INSERT INTO compute_admission_domains(resource_domain,host_domain,policy_hash,policy) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(resource_domain) DO NOTHING',[d.key,d.host,policy.hash,policy.json]);
 const current=(await db.query<{policy_hash:string}>('SELECT policy_hash FROM compute_admission_domains WHERE resource_domain=$1 FOR SHARE',[d.key])).rows[0];
 if(current?.policy_hash!==policy.hash)fail('admission_domain_config_conflict');
 return d;
}
async function metric(db:AdmissionDb,domain:string,source:string,event:'requested'|'started'|'completed'|'unconfirmed'|'uncovered'|'cancelled'){
 // Spaltenname ist ausschließlich dieser geschlossene interne Event-Typ.
 await db.query(`INSERT INTO compute_admission_metrics(resource_domain,source,${event}) VALUES($1,$2,1)
  ON CONFLICT(resource_domain,source) DO UPDATE SET ${event}=compute_admission_metrics.${event}+1,updated_at=clock_timestamp()`,[domain,source]);
}
async function used(db:AdmissionDb,d:NonNullable<ReturnType<typeof computeAdmissionDomain>>){
 const http=await db.query<{n:number;exclusive:number}>(`SELECT COUNT(*)::int AS n,COUNT(*) FILTER(WHERE source='intern-ollama')::int AS exclusive FROM compute_admission_requests
  WHERE resource_domain=$1 AND state IN ('running','unconfirmed')`,[d.key]);
 const models=await db.query<{mb:number}>('SELECT COALESCE(SUM(reserved_mb),0)::float8 AS mb FROM compute_admission_models WHERE resource_domain=$1',[d.key]);
 // GPU-Jobs der Hostdomain sind konservativ reserviert, auch nach verlorener Lease.
 const jobs=await db.query<{n:number;mb:number}>(`SELECT COUNT(*)::int AS n,COALESCE(SUM((resource_need->>'vram')::numeric),0)::float8 AS mb
  FROM work_jobs w LEFT JOIN embedding_knoten n ON n.node_id=w.owner_node
  WHERE (w.resource_need->>'gpu')::boolean AND (w.state IN ('leased','staged') OR w.resource_unconfirmed)
  AND (w.resource_domain IN ($1,$2)
   OR (n.host_resource_domain=$1 AND NOT EXISTS(SELECT 1 FROM compute_admission_domains p WHERE p.resource_domain=w.resource_domain))
   OR ((w.owner_node IS NULL OR n.host_resource_domain IS NULL OR w.boot_generation::text<>n.boot_id::text)
    AND NOT EXISTS(SELECT 1 FROM compute_admission_domains p WHERE p.resource_domain=w.resource_domain OR p.host_domain=w.resource_domain)))`,[d.host,d.key]);
 return {http:http.rows[0].n,exclusive:http.rows[0].exclusive,models:models.rows[0].mb,jobs:jobs.rows[0].n,jobMb:jobs.rows[0].mb};
}
/** Fehlende/stale Telemetrie bleibt unknown, niemals erfundene freie Kapazität. */
async function physicalBudget(db:AdmissionDb,nodeId:string,d:NonNullable<ReturnType<typeof computeAdmissionDomain>>,prospective?:{model:string;mb:number}):Promise<number|null>{
 const n=(await db.query<{ressourcen:ComputeResources|null;modell:string|null;now:Date}>('SELECT ressourcen,modell,clock_timestamp() AS now FROM embedding_knoten WHERE node_id=$1 FOR SHARE',[nodeId])).rows[0];
 let gpu:ComputeResources['gpus'][number]|undefined;
 try{gpu=n?computeResourceSnapshot(n.ressourcen,new Date(n.now).getTime())?.gpus.find(g=>g.deviceId===d.device):undefined;}catch{return null;}
 if(!gpu)return null;
 const free=gpu.freeMb,total=gpu.totalMb,own=gpu.residentOwnModelMb;
 const measured=(m:typeof free|undefined)=>!!m&&m.freshness==='fresh'&&m.quality==='measured'&&m.scope==='device'&&m.value!==null;
 if(!measured(free)||!measured(total)||free.value!>total.value!)return null;
 // Nur beobachtetes Eigenmodell zurückrechnen; unbekannte/fremde Residency erhält keinen Kredit.
 const name=typeof n?.modell==='string'?normalModel(n.modell):'';
 const charged=(await db.query<{mb:number}>('SELECT reserved_mb AS mb FROM compute_admission_models WHERE resource_domain=$1 AND model=$2',[d.key,name])).rows[0]?.mb??0;
 const planned=prospective?.model===name?prospective.mb:0;
 const ownMb=measured(own)?own.value!:0;
 if(ownMb>total.value!||free.value!+ownMb>total.value!)return null;
 const credit=Math.min(ownMb,Math.max(charged,planned));
 return Math.min(d.config.vramMb,free.value!+credit);
}
/** Unter bereits gehaltenem Domainlock, unmittelbar vor dem Work-Job-Claim. */
export async function computeAdmissionAllowsWork(db:AdmissionDb,nodeId:string,need:{gpu:boolean;vram:number},priority:string,resourceDomain?:string):Promise<boolean>{
 if(!need.gpu||process.env.SYNAPSE_COMPUTE_ADMISSION!=='1')return true;
 const d=computeAdmissionDomain(nodeId)!;
 if(resourceDomain!==d.host&&resourceDomain!==d.key)return false;
 const u=await used(db,d);
 // Noch rechnende/unbestätigte Embeddings und residente Modelle bleiben reserviert.
 const cap=d.config.maxHttp-(priority==='interaktiv'?0:d.config.interactiveReserve),budget=await physicalBudget(db,nodeId,d);
 return budget!==null&&!u.exclusive&&u.http+u.jobs<cap&&u.models+u.jobMb+need.vram<=budget;
}
/** Chunk-Vorrat ist keine Rechnung: nur Registry-/Domainfreigabe prüfen. */
export async function computeAdmissionMayPrefetch(db:AdmissionDb,nodeId:string,internalServer=false):Promise<boolean>{
 const d=computeAdmissionDomain(nodeId);if(!d)return true;
 const node=(await db.query<{features:string[]}>('SELECT features FROM embedding_knoten WHERE node_id=$1 FOR SHARE',[nodeId])).rows[0];
 if(!internalServer&&!node?.features?.includes('compute_admission'))return false;
 const u=await used(db,d);
 const budget=await physicalBudget(db,nodeId,d);
 return budget!==null&&!u.exclusive&&u.jobs<d.config.maxHttp&&u.models+u.jobMb<=budget;
}
export function createComputeAdmission(pool:AdmissionPool=getPool() as unknown as AdmissionPool){
 async function tx<T>(run:(db:AdmissionDb)=>Promise<T>):Promise<T>{
  const db=await pool.connect();try{await db.query('BEGIN');const r=await run(db);await db.query('COMMIT');return r;}
  catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
 }
 async function attempt(input:AdmissionInput):Promise<AdmissionLease|null>{
  const d=computeAdmissionDomain(input.nodeId);if(!d)return null;
  if(!uuid(input.id)||!input.bootId||!input.authHash||!['interaktiv','hintergrund','nachzug'].includes(input.priority)
   ||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(input.source)||typeof input.model!=='string'||!input.model||input.model.length>255)fail('admission_input_invalid');
  input={...input,id:input.id.toLowerCase(),model:normalModel(input.model)};
  if(input.source==='unbound'){await metric(pool,d.key,'unbound','uncovered');fail('admission_producer_unbound');}
  const wait=input.maxWaitMs??d.config.maxWaitMs;integer(wait,0);if(wait>d.config.maxWaitMs)fail('admission_wait_invalid');
  if(!Object.hasOwn(d.config.modelMb,input.model))fail('admission_model_budget_missing');
  return tx(async db=>{
   await lockComputeAdmissionDomain(db,input.nodeId);
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-node:'+input.nodeId]);
   const node=await db.query<{boot_id:string;service_token_hash:string;gesperrt_vom_user:boolean;status:string;features:string[];modell:string;ollama_url:string}>(`SELECT boot_id,service_token_hash,gesperrt_vom_user,status,features,modell,ollama_url FROM embedding_knoten
    WHERE node_id=$1 AND letzter_kontakt>clock_timestamp()-($2::int*INTERVAL '1 millisecond') FOR SHARE`,[input.nodeId,Number(process.env.SYNAPSE_COMPUTE_NODE_FRESHNESS_MS??120000)]);
   const n=node.rows[0];
   if(!n||n.boot_id!==input.bootId||n.service_token_hash!==input.authHash||n.gesperrt_vom_user||!['ready','busy'].includes(n.status))fail('admission_node_not_usable');
   if(input.model!==normalModel(n.modell)||typeof input.backend!=='string'||input.backend.replace(/\/+$/,'')!==n.ollama_url.replace(/\/+$/,''))fail('admission_backend_binding_invalid');
   const auth=await db.query(`SELECT token_hash FROM auth_tokens WHERE token_hash=$1 AND kind='service' AND scope=$2
    AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`,[input.authHash,'compute-node:'+input.nodeId]);
   if(!auth.rows.length)fail('admission_auth_invalid');
   const policy=await embeddingComputePolicy(input.nodeId,db as never,input.nodeId===process.env.SYNAPSE_SERVER_NODE_ID);
   if(policy&&!policy.decision.allowed)fail('admission_policy_denied');
   if(input.source==='compute-node'){
    const refs=input.claims;
    if(!Array.isArray(refs)||!refs.length||refs.length>100||
     refs.some(r=>!r||typeof r!=='object'||!uuid(r.chunkId)||!uuid(r.claimToken)||!/^[a-f0-9]{64}$/.test(r.contentHash))||new Set(refs.map(r=>r.chunkId)).size!==refs.length)fail('admission_claims_invalid');
    const current=await db.query<{project:string}>(`SELECT cc.project FROM code_chunks cc
     JOIN jsonb_to_recordset($2::jsonb) AS x(id text,token text,hash text) ON cc.id=x.id
     WHERE cc.claimed_by=$1 AND cc.claim_token=x.token AND cc.content_hash=x.hash
      AND cc.embedded_at IS NULL AND cc.lease_until>=clock_timestamp() FOR SHARE OF cc`,
     [input.nodeId,JSON.stringify(refs.map(r=>({id:r.chunkId,token:r.claimToken,hash:r.contentHash})))]);
    if(current.rows.length!==refs.length)fail('admission_claims_stale');
    if(policy&&current.rows.some(r=>policy.excludedProjects.includes(r.project)))fail('admission_project_denied');
   }
   const requestHash=createHash('sha256').update(JSON.stringify({model:input.model,backend:input.backend?.replace(/\/+$/,''),source:input.source,priority:input.priority,
    claims:[...input.claims??[]].sort((a,b)=>a.chunkId.localeCompare(b.chunkId))})).digest('hex');
   const inserted=await db.query(`INSERT INTO compute_admission_requests(id,token,resource_domain,host_domain,node_id,boot_id,auth_hash,source,priority,model,request_hash,state,deadline_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12,'waiting',clock_timestamp()+($11::int*INTERVAL '1 millisecond'))
    ON CONFLICT(id) DO NOTHING RETURNING id`,[input.id,randomUUID(),d.key,d.host,input.nodeId,input.bootId,input.authHash,input.source,input.priority,input.model,wait===0?d.config.maxWaitMs:wait,requestHash]);
   if(inserted.rows.length)await metric(db,d.key,input.source,'requested');
   const own=(await db.query<{token:string;state:string;boot_id:string;auth_hash:string;node_id:string;model:string;source:string;priority:string;request_hash:string|null;alive:boolean}>(`SELECT *,deadline_at>=clock_timestamp() AS alive FROM compute_admission_requests WHERE id=$1 FOR UPDATE`,[input.id])).rows[0];
   if(!own||own.node_id!==input.nodeId||own.boot_id!==input.bootId||own.auth_hash!==input.authHash||own.model!==input.model||own.source!==input.source||own.priority!==input.priority||own.request_hash!==requestHash)fail('admission_request_conflict');
   if(own.state==='running')return {id:input.id,token:own.token,domain:d.key,state:'running' as const};
   if(own.state!=='waiting')fail('admission_request_closed');
   const u=await used(db,d);
   const resident=await db.query('SELECT model FROM compute_admission_models WHERE resource_domain=$1 AND model=$2',[d.key,input.model]);
   const required=resident.rows.length?0:d.config.modelMb[input.model];
   const first=(await db.query<{id:string}>(`SELECT id FROM compute_admission_requests WHERE resource_domain=$1 AND state='waiting' AND deadline_at>=clock_timestamp()
     AND (priority='interaktiv' OR $3::boolean)
    ORDER BY GREATEST(0,(CASE priority WHEN 'interaktiv' THEN 0 WHEN 'hintergrund' THEN 1 ELSE 2 END)-FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-queued_at))*1000/$2)),queued_at,id LIMIT 1`,[d.key,d.config.agingMs,u.http+u.jobs<d.config.maxHttp-d.config.interactiveReserve])).rows[0];
   const cap=d.config.maxHttp-(input.priority==='interaktiv'?0:d.config.interactiveReserve),budget=await physicalBudget(db,input.nodeId,d,{model:input.model,mb:required});
   if(own.alive&&first?.id===input.id&&!u.exclusive&&(input.source!=='intern-ollama'||u.http+u.jobs===0)&&u.http+u.jobs<cap&&budget!==null&&u.models+u.jobMb+required<=budget){
    await db.query(`INSERT INTO compute_admission_models(resource_domain,model,reserved_mb) VALUES($1,$2,$3)
     ON CONFLICT(resource_domain,model) DO UPDATE SET revision=compute_admission_models.revision+1,observed_at=clock_timestamp()`,[d.key,input.model,d.config.modelMb[input.model]]);
    await db.query("UPDATE compute_admission_requests SET state='running',started_at=clock_timestamp() WHERE id=$1",[input.id]);
    await metric(db,d.key,input.source,'started');return {id:input.id,token:own.token,domain:d.key,state:'running' as const};
   }
   if(!own.alive||wait===0) {await db.query("UPDATE compute_admission_requests SET state='cancelled',finished_at=clock_timestamp() WHERE id=$1",[input.id]);await metric(db,d.key,input.source,'cancelled');return null;}
   return {id:input.id,token:own.token,domain:d.key,state:'waiting' as const,
    reason:first?.id!==input.id?'priority':u.exclusive?'model_control':u.http+u.jobs>=cap?'http_capacity':budget===null?'telemetry_unknown':'vram_capacity'};
  });
 }
 async function finish(identity:AdmissionIdentity,lease:AdmissionLease,confirmed:boolean):Promise<boolean>{
  if(!uuid(lease.id)||!uuid(lease.token))return false;
  const hint=(await pool.query<{resource_domain:string;host_domain:string}>('SELECT resource_domain,host_domain FROM compute_admission_requests WHERE id=$1',[lease.id])).rows[0];
  if(!hint)return false;
  return tx(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-domain:'+hint.host_domain]);
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['compute-device:'+hint.resource_domain]);
   const r=await db.query<{source:string;state:string}>(`UPDATE compute_admission_requests SET state=CASE WHEN state='waiting' THEN 'cancelled'
    WHEN $6 THEN 'finished' ELSE 'unconfirmed' END,finished_at=CASE WHEN $6 OR state='waiting' THEN clock_timestamp() ELSE NULL END
    WHERE id=$1 AND token=$2 AND node_id=$3 AND boot_id=$4 AND auth_hash=$5 AND resource_domain=$7
    AND state IN ('waiting','running','unconfirmed') AND (state<>'unconfirmed' OR $6) RETURNING source,state`,[lease.id,lease.token,identity.nodeId,identity.bootId,identity.authHash,confirmed,hint.resource_domain]);
   if(!r.rows.length){
    const old=(await db.query<{state:string}>(`SELECT state FROM compute_admission_requests WHERE id=$1 AND token=$2 AND node_id=$3 AND boot_id=$4 AND auth_hash=$5`,[lease.id,lease.token,identity.nodeId,identity.bootId,identity.authHash])).rows[0];
    return !!old&&(old.state==='finished'&&confirmed||old.state==='cancelled'||old.state==='unconfirmed'&&!confirmed);
   }
   await metric(db,hint.resource_domain,r.rows[0].source,r.rows[0].state==='cancelled'?'cancelled':confirmed?'completed':'unconfirmed');return true;
  });
 }
 async function acquire(input:Omit<AdmissionInput,'id'>):Promise<AdmissionLease|null>{
  const d=computeAdmissionDomain(input.nodeId);if(!d)return null;const id=randomUUID();
  for(;;){const r=await attempt({...input,id});if(!r)fail('admission_queue_timeout');if(r.state==='running')return r;
   await new Promise(resolve=>setTimeout(resolve,d.config.pollMs));}
 }
 async function modelObservation(nodeId:string,model:string):Promise<string|null>{
  const d=computeAdmissionDomain(nodeId);if(!d)return null;
  return (await pool.query<{revision:string}>('SELECT revision::text AS revision FROM compute_admission_models WHERE resource_domain=$1 AND model=$2',[d.key,normalModel(model)])).rows[0]?.revision??null;
 }
 async function observeModelAbsent(nodeId:string,model:string,revision:string):Promise<void>{
  model=normalModel(model);
  // Nur nach tatsächlicher /api/ps-Absenz auf dem betreibergebundenen Backend aufrufen.
  await tx(async db=>{const d=await lockComputeAdmissionDomain(db,nodeId);if(!d)return;
   const busy=await db.query("SELECT id FROM compute_admission_requests WHERE resource_domain=$1 AND model=$2 AND state IN ('running','unconfirmed') LIMIT 1",[d.key,model]);
   if(busy.rows.length)fail('admission_model_busy');
   await db.query('DELETE FROM compute_admission_models WHERE resource_domain=$1 AND model=$2 AND revision=$3::bigint',[d.key,model,revision]);});
 }
 async function setDomainConfig(nodeId:string,expectedHash:string):Promise<boolean>{
  if(!/^[a-f0-9]{64}$/.test(expectedHash))return false;
  const d=computeAdmissionDomain(nodeId);if(!d)return false;const policy=domainPolicy(d);
  return tx(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['work-domain:'+d.host]);
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['compute-device:'+d.key]);
   const u=await used(db,d);
   const models=await db.query('SELECT model FROM compute_admission_models WHERE resource_domain=$1 LIMIT 1',[d.key]);
   const pending=await db.query("SELECT id FROM compute_admission_requests WHERE resource_domain=$1 AND state='waiting' AND deadline_at>=clock_timestamp() LIMIT 1",[d.key]);
   if(u.http||u.jobs||models.rows.length||pending.rows.length)fail('admission_domain_not_drained');
   const r=await db.query('UPDATE compute_admission_domains SET policy=$3::jsonb,policy_hash=$4,updated_at=clock_timestamp() WHERE resource_domain=$1 AND policy_hash=$2',[d.key,expectedHash,policy.json,policy.hash]);
   return !!r.rowCount;
  });
 }
 async function status(){return {origins:(await pool.query('SELECT * FROM compute_admission_metrics ORDER BY resource_domain,source')).rows,
  leasedChunks:(await pool.query("SELECT claimed_by AS owner,COUNT(*)::int AS leased_chunks FROM code_chunks WHERE embedded_at IS NULL AND lease_until>clock_timestamp() GROUP BY claimed_by ORDER BY claimed_by")).rows,
  domains:(await pool.query(`SELECT resource_domain,state,COUNT(*)::int AS http_batches FROM compute_admission_requests
   WHERE state IN ('running','unconfirmed') OR (state='waiting' AND deadline_at>=clock_timestamp()) GROUP BY resource_domain,state ORDER BY resource_domain,state`)).rows,
  models:(await pool.query('SELECT * FROM compute_admission_models ORDER BY resource_domain,model')).rows};}
 return {attempt,acquire,finish,modelObservation,observeModelAbsent,setDomainConfig,status};
}
const defaultService=()=>createComputeAdmission();
let localIdentity:AdmissionIdentity|null=null;
export function configureLocalComputeAdmission(identity:AdmissionIdentity|null):void{localIdentity=identity;}
/** Nur serverseitig nach /api/ps-Absenz auf dem gebundenen Backend. */
export async function localComputeModelObservation(model:string):Promise<string|null>{
 return process.env.SYNAPSE_COMPUTE_ADMISSION==='1'&&localIdentity?defaultService().modelObservation(localIdentity.nodeId,model):null;
}
export async function observeLocalComputeModelAbsent(model:string,revision:string|null):Promise<void>{
 if(process.env.SYNAPSE_COMPUTE_ADMISSION==='1'&&localIdentity&&revision!==null)await defaultService().observeModelAbsent(localIdentity.nodeId,model,revision);
}
/** Genau ein transportseitiger Request; erst vollständige HTTP-Antwort bestätigt physisches Ende. */
export async function mitComputeAdmission<T>(model:string,run:(ended:()=>void)=>Promise<T>,backend?:string):Promise<T>{
 const adapter=remote,identity=localIdentity;
 if(!adapter&&(process.env.SYNAPSE_COMPUTE_NODE==='1'||process.env.SYNAPSE_COMPUTE_ADMISSION!=='1'))return run(()=>{});
 const c=context.getStore()??{source:'unbound',priority:'interaktiv' as const};
 const service=adapter?null:defaultService();
 if(!adapter&&!identity){await metric(getPool() as unknown as AdmissionDb,'unbound',c.source,'uncovered');fail('admission_local_identity_missing');}
 let lease:AdmissionLease|null=null,confirmed=false,began=false;
 c.releaseLocal?.();
 try{
  lease=adapter?await adapter.acquire(model,{...c,backend}):await service!.acquire({...identity!,source:c.source,priority:c.priority,maxWaitMs:c.maxWaitMs,model,backend,claims:c.claims});
  await c.resumeLocal?.();began=true;
  return await run(()=>{confirmed=true;});
 }finally{if(lease){if(adapter)await adapter.finish(lease,!began||confirmed);else await service!.finish(identity!,lease,!began||confirmed);}}
}
