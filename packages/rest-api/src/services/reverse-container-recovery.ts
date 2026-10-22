/** P18-T105: ausschließlich Reverse-eigene Instanzen und Versuche. Kein allgemeiner P20-Umbau. */
import {randomUUID} from 'node:crypto';
import {setTimeout as warten} from 'node:timers/promises';
import type {Pool,PoolClient,Client} from 'pg';
import {getPool,TOOL_CONTAINER_LOCK,registerWorkJobClaimGuard,leseReverseEinstellwerte,reverseZahl,reverseBigInt,
 type WorkIdentity,type WorkJob,type WorkJobService,type WorkJobClient} from '@synapse/core';
import {reverseContainerTool,reverseNichtGesendet,type ReverseContainerBinding} from './reverse-container-transport.js';

const PROJEKT='reverse-bibliothek';
type Db=Pool|PoolClient|Client;
type Query=Pick<PoolClient,'query'>;
export interface ReverseStopBeleg {instance_id:string;generation:string;container_id:string|null;job_id?:string|null;attempt?:number;tool_id?:string;descriptor_hash?:string}
interface Instanz extends ReverseContainerBinding {state:string;work_job_id:string|null;start_inflight:boolean;operation_token:string|null}
export class ReverseContainerRecovery {
 constructor(private readonly o:{pool?:Db;ready:(b:ReverseContainerBinding)=>boolean;identity:()=>Promise<WorkIdentity|null>}){
  this.db=o.pool??getPool();
 }
 private readonly db:Db;
 private async tx<T>(fn:(c:Query)=>Promise<T>):Promise<T>{
  // Gehaltene Clients gehören dem Aufrufer: weder reconnect noch BEGIN/COMMIT/Release.
  // Nur pg.Pool besitzt diese drei Pool-Zähler. connect() allein wäre auch bei pg.Client wahr (B1).
  if(!('totalCount' in this.db&&'idleCount' in this.db&&'waitingCount' in this.db))return fn(this.db);
  const c=await (this.db as Pool).connect();
  try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private async lock(c:Query){await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[TOOL_CONTAINER_LOCK]);}
 async binding(id:string,jobId?:string):Promise<ReverseContainerBinding|null>{
  const r=await this.db.query(`SELECT t.instance_id,t.generation,t.container_id,t.tool_id,t.project,
   d.descriptor->>'digest' AS image,w.id::text AS job_id,w.attempt FROM tool_containers t JOIN tool_descriptors d USING(tool_id)
   LEFT JOIN work_jobs w ON w.id=$2::uuid AND w.project=t.project
    AND ((t.tool_id='reverse-e' AND w.capability='reverse_bibliothek' AND w.kind IN('reverse-E','reverse-S3'))
      OR (t.tool_id='reverse-leser' AND w.capability='reverse_leser' AND w.kind='reverse-leser'))
   WHERE t.container_id=$1 AND t.project=$3 AND t.tool_id IN('reverse-e','reverse-leser')
    AND ($2::uuid IS NULL OR (w.id IS NOT NULL AND (t.work_job_id IS NULL OR t.work_job_id=w.id)
      AND EXISTS(SELECT 1 FROM tool_container_runs r WHERE r.job_id=w.id AND r.attempt=w.attempt
       AND r.instance_id=t.instance_id AND r.generation=t.generation)))`,[id,jobId||null,PROJEKT]);
  return r.rows.length===1?r.rows[0]:null;
 }
 async current(toolId:string,jobId:string|null,c:Query=this.db):Promise<Instanz|null>{
  if(!reverseContainerTool(toolId,PROJEKT))return null;
  const r=await c.query(`SELECT t.*,d.descriptor_hash FROM tool_containers t JOIN tool_descriptors d USING(tool_id)
   WHERE t.tool_id=$1 AND t.project=$2 AND
    ((d.descriptor->>'instance_scope'='project' AND t.work_job_id IS NULL) OR t.work_job_id=$3::uuid)`,
   [toolId,PROJEKT,jobId]);
  return r.rows.length===1?r.rows[0]:null;
 }
 private async boot(c:Query,w:WorkIdentity):Promise<boolean>{
  return !!(await c.query('SELECT 1 FROM embedding_knoten WHERE node_id=$1 AND boot_id=$2 AND service_token_hash=$3 FOR SHARE',
   [w.nodeId,w.bootGeneration,w.authHash])).rows.length;
 }
 /** Guard.lock ist leer: der bestehende Lifecycle-Guard hält bereits denselben Lock.
  * Nicht-Reverse endet VOR JEDEM DB-/Docker-/Identitätsaufruf. */
 async allow(job:WorkJob,c:WorkJobClient):Promise<boolean>{
  const tool=job.project===PROJEKT&&job.capability==='reverse_bibliothek'&&['reverse-E','reverse-S3'].includes(job.kind)?'reverse-e':
   job.project===PROJEKT&&job.capability==='reverse_leser'&&job.kind==='reverse-leser'?'reverse-leser':null;
  if(!tool)return true;
  const who=await this.o.identity();if(!who||!await this.boot(c as unknown as Query,who))return false;
  if(tool==='reverse-leser'){
   const l=(await c.query("SELECT (diagnose->>'host_validiert'='true') AS host_validiert,diagnose->'transport'->>'phase' AS phase FROM reverse_leser_laeufe WHERE work_job_id=$1",[job.id])).rows[0] as {host_validiert?:boolean;phase?:string}|undefined;
   // Bestehender Materialisierungsresume führt keinen Runner aus: kein zusätzliches Session-Gate.
   // Der unveränderte allgemeine P20-Guard und die Leser-Pins bleiben zuständig.
   if(l?.host_validiert)return true;
   if(l&&['ausfuehrung','stop'].includes(l.phase??''))return false;
  }
  const r=await this.current(tool,job.id,c as unknown as Query);
  if(!r||r.state!=='warm'||!r.container_id||!this.o.ready(r))return false;
  return true;
 }
 register():()=>void{return registerWorkJobClaimGuard('reverse-local-transport',{lock:async()=>{},allow:(j,c)=>this.allow(j,c)});}
 /** Kein Claim auf PG-warm ohne Transport; Recovery reserviert nur nach beweisbarer Ruhe. */
 async before(tool:string,jobId:string):Promise<boolean>{
  const r=await this.current(tool,jobId);
  if(!r||r.state!=='warm')return r?.state!=='stopping';
  if(this.o.ready(r))return true;
  await this.requestStop({...r,job_id:jobId},true);
  return false;
 }
 async stopSeconds():Promise<number>{
  const s=await leseReverseEinstellwerte({},this.db);if(s.letzter_fehler)throw Error(s.letzter_fehler);
  return Math.ceil(reverseZahl(s,'prozess_wait_ms')/1000);
 }
 async requestStop(expected:ReverseStopBeleg,idle=false,diagnose=false):Promise<{neu_gestartet:boolean;zustand:string|null}>{
  const who=await this.o.identity();if(!who)return {neu_gestartet:false,zustand:'server_identitaet_fehlt'};
  const s=await leseReverseEinstellwerte({},this.db);
  if(s.letzter_fehler)throw Error(s.letzter_fehler);
  if(reverseZahl(s,'e_uebernahme_block_zeilen')<1)throw Error('reverse_recovery_tx_zeilen');
  const params=[expected.instance_id,expected.generation,expected.container_id,randomUUID()];
  if(BigInt(Buffer.byteLength(JSON.stringify(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))throw Error('reverse_recovery_tx_bytes');
  return this.tx(async c=>{
   await this.lock(c);if(!await this.boot(c,who))return {neu_gestartet:false,zustand:'reverse_recovery_fenced'};
   const r=(await c.query(`SELECT t.*,d.descriptor_hash FROM tool_containers t JOIN tool_descriptors d USING(tool_id)
    WHERE t.instance_id=$1 AND t.generation=$2 AND (t.container_id IS NOT DISTINCT FROM $3 OR (t.state='cold' AND t.container_id IS NULL AND t.resource_token IS NULL))
     AND t.project=$4 AND t.tool_id IN('reverse-e','reverse-leser') FOR UPDATE OF t`,[...params.slice(0,3),PROJEKT])).rows[0] as Instanz|undefined;
   if(!r||expected.tool_id&&expected.tool_id!==r.tool_id||expected.descriptor_hash&&expected.descriptor_hash!==r.descriptor_hash)return {neu_gestartet:false,zustand:'reverse_generation_geaendert'};
   if(r.state==='cold'||r.state==='stopping')return {neu_gestartet:false,zustand:r.state};
   if(!['warm','waiting'].includes(r.state))return {neu_gestartet:false,zustand:r.state};
   if(expected.job_id&&r.work_job_id&&r.work_job_id!==expected.job_id)return {neu_gestartet:false,zustand:'reverse_job_geaendert'};
   if(expected.attempt!==undefined){
    const run=await c.query('SELECT 1 FROM tool_container_runs r JOIN work_jobs w ON w.id=r.job_id AND w.attempt=r.attempt WHERE r.job_id=$1 AND r.attempt=$2 AND r.instance_id=$3 AND r.generation=$4',
     [expected.job_id,expected.attempt,r.instance_id,r.generation]);
    if(!run.rows.length)return {neu_gestartet:false,zustand:'reverse_versuch_geaendert'};
   }
   if(diagnose){
    const active=await c.query("SELECT 1 FROM tool_container_runs WHERE instance_id=$1 AND generation=$2 AND state='running' LIMIT 1",[r.instance_id,r.generation]);
    if(active.rows.length)return {neu_gestartet:false,zustand:'reverse_diagnose_veraltet'};
    if(expected.attempt!==undefined){
     const unknown=await c.query("SELECT 1 FROM tool_container_runs WHERE job_id=$1 AND attempt=$2 AND instance_id=$3 AND generation=$4 AND state='unknown'",[expected.job_id,expected.attempt,r.instance_id,r.generation]);
     if(!unknown.rows.length)return {neu_gestartet:false,zustand:'reverse_diagnose_veraltet'};
    }
   }
   if(idle){
    if(r.start_inflight||r.state!=='warm'||this.o.ready(r))return {neu_gestartet:false,zustand:'reverse_nicht_ruhig'};
    const active=await c.query(`SELECT 1 FROM tool_container_runs WHERE instance_id=$1 AND state IN('running','unknown')
     UNION ALL SELECT 1 FROM work_jobs WHERE project=$2 AND capability=$3
      AND (state IN('leased','staged') OR resource_unconfirmed)
      AND ($4::uuid IS NULL OR id=$4) LIMIT 1`,
     [r.instance_id,PROJEKT,r.tool_id==='reverse-e'?'reverse_bibliothek':'reverse_leser',r.work_job_id]);
    if(active.rows.length)return {neu_gestartet:false,zustand:'reverse_ende_unbestaetigt'};
    const enabled=await c.query('SELECT 1 FROM tool_descriptors d JOIN tool_activation a USING(tool_id) WHERE d.tool_id=$1 AND d.enabled AND a.project=$2 AND a.enabled',[r.tool_id,PROJEKT]);
    if(!enabled.rows.length)return {neu_gestartet:false,zustand:'reverse_inaktiv'};
   }
   await c.query(`UPDATE tool_containers SET state='stopping',operation_token=$4,operation_at=clock_timestamp(),
    last_error=$5,updated_at=clock_timestamp() WHERE instance_id=$1 AND generation=$2 AND container_id IS NOT DISTINCT FROM $3`,
    [...params,idle?'reverse_runner_nicht_angebunden':'reverse_beendigung_ausstehend']);
   return {neu_gestartet:true,zustand:'stopping'};
  });
 }
 /** Ein Versuch bleibt geleast; der vorhandene Lifecycle-Tick beendet exakt die reservierte Generation. */
 async waitStopped(expected:ReverseStopBeleg,timeoutMs:number,pollMs:number,abgebrochen:()=>boolean=()=>false):Promise<void>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(pollMs)||pollMs<1)throw Error('reverse_stop_budget');
  const result=await this.requestStop(expected);
  if(!result.neu_gestartet&&!['stopping','cold'].includes(result.zustand??''))throw Error(result.zustand??'reverse_stop_fenced');
  const end=Date.now()+timeoutMs;
  for(;;){
   const r=(await this.db.query('SELECT generation,state,container_id,resource_token FROM tool_containers WHERE instance_id=$1 AND project=$2 AND tool_id IN(\'reverse-e\',\'reverse-leser\')',[expected.instance_id,PROJEKT])).rows[0];
   if(!r||r.generation!==expected.generation)throw Error('reverse_generation_geaendert');
   if(r.state==='cold'&&r.container_id===null&&r.resource_token===null)return;
   if(abgebrochen()||Date.now()>=end)throw Error('leser_stop_unbestaetigt');
   await warten(Math.min(pollMs,Math.max(1,end-Date.now())));
  }
 }
 /** Kein release aufgrund eines Fehlertexts. Nach execute-Catch ist nur diese konkrete Runzeile freigebbar. */
 async releaseNotSent(error:unknown,job:WorkJob,who:WorkIdentity,jobs:Pick<WorkJobService,'release'>,beforeRelease?:()=>Promise<void>):Promise<boolean>{
  const p=reverseNichtGesendet(error);
  if(!p||p.job_id!==job.id||p.attempt!==job.attempt||job.project!==PROJEKT)return false;
  const s=await leseReverseEinstellwerte({eintrag_id:job.inputRef.id},this.db);
  if(s.letzter_fehler)throw Error(s.letzter_fehler);
  if(reverseZahl(s,'e_uebernahme_block_zeilen')<1)throw Error('reverse_recovery_tx_zeilen');
  const params=[job.id,job.attempt,p.instance_id,p.generation,who.nodeId,who.bootGeneration,who.authHash,job.claimToken];
  if(BigInt(Buffer.byteLength(JSON.stringify(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))throw Error('reverse_recovery_tx_bytes');
  const ok=await this.tx(async c=>{
   await this.lock(c);if(!await this.boot(c,who))return false;
   const r=await c.query(`UPDATE tool_container_runs r SET state='done',updated_at=clock_timestamp()
    FROM work_jobs w,tool_containers t WHERE r.job_id=$1 AND r.attempt=$2 AND r.instance_id=$3 AND r.generation=$4
     AND r.state IN('running','unknown','done') AND w.id=r.job_id AND w.attempt=r.attempt
     AND w.state='leased' AND w.project='reverse-bibliothek' AND w.owner_node=$5 AND w.boot_generation=$6
     AND w.owner_auth_hash=$7 AND w.claim_token=$8 AND w.lease_until>clock_timestamp()
     AND (w.deadline IS NULL OR w.deadline>clock_timestamp())
     AND t.instance_id=r.instance_id AND t.generation=r.generation AND t.project=w.project
     AND ((t.tool_id='reverse-e' AND w.capability='reverse_bibliothek' AND w.kind IN('reverse-E','reverse-S3'))
       OR (t.tool_id='reverse-leser' AND w.capability='reverse_leser' AND w.kind='reverse-leser'))`,params);
   return r.rowCount===1;
  });
  if(!ok)return false;
  // Eigener Nachweis in separater, idempotenter Einzeilen-TX. Kein Audit je Datei/Block.
  const detail=JSON.stringify({attempt:job.attempt,instance_id:p.instance_id,generation:p.generation,code:'reverse_nicht_gesendet'});
  if(BigInt(Buffer.byteLength(detail)+Buffer.byteLength(JSON.stringify(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))throw Error('reverse_recovery_tx_bytes');
  const audited=await this.tx(async c=>{
   await this.lock(c);if(!await this.boot(c,who))return false;
   const live=await c.query(`SELECT 1 FROM work_jobs w JOIN tool_container_runs r ON r.job_id=w.id AND r.attempt=w.attempt
    WHERE w.id=$1 AND w.attempt=$2 AND r.instance_id=$3 AND r.generation=$4 AND r.state='done'
     AND w.state='leased' AND w.project='reverse-bibliothek' AND w.owner_node=$5 AND w.boot_generation=$6
     AND w.owner_auth_hash=$7 AND w.claim_token=$8 AND w.lease_until>clock_timestamp()
     AND (w.deadline IS NULL OR w.deadline>clock_timestamp()) FOR SHARE OF w`,params);
   if(!live.rows.length)return false;
   await c.query(`INSERT INTO work_job_audit(id,job_id,event,detail) SELECT gen_random_uuid(),$1,'reverse_nicht_gesendet',$2::jsonb
    WHERE NOT EXISTS(SELECT 1 FROM work_job_audit WHERE job_id=$1 AND event='reverse_nicht_gesendet' AND detail->>'attempt'=$3)`,[job.id,detail,String(job.attempt)]);
   return true;
  });
  if(!audited)return false;
  await beforeRelease?.();
  // Ein Leser-Versuch besitzt eigene Mounts. Das generationsgebundene Claimhindernis
  // muss dauerhaft stehen, BEVOR P20 den Job wieder pending macht (R1).
  // Scheitert der Fence, bleibt die Lease bestehen; kein Freigeben auf Verdacht.
  if(p.tool_id==='reverse-leser'){
   const stop=await this.requestStop(p);
   if(!['stopping','cold'].includes(stop.zustand??''))return false;
  }
  // Unveränderter P20-Service: zwei konstante Steuerzeilen, keine Reverse-Bestandsmenge.
  return jobs.release(who,job.id,job.claimToken!);
 }
}
