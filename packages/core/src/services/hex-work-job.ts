/** P21-T15: bestehende Work-Job-Leases fuer feste Hex-Worker; Aufrufgeheimnisse bleiben nur im RAM. */
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {computeResourceBinding} from '../vertrag/compute-ressourcen.js';
import {createWorkJobService,type WorkIdentity,type WorkJobClient} from './work-jobs.js';
import {HexFehler} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
let identitaet:WorkIdentity|null=null;
/** Ausschliesslich der verifizierte ServerExecutor setzt diese Prozessbindung; kein Tool-/HTTP-Parameter. */
export function konfiguriereHexWorkIdentitaet(w:WorkIdentity|null):void{identitaet=w?{...w}:null;}
export function hexWorkStatus(){return {bereit:!!identitaet,ausfuehrung:'work-job+worker-thread',schluessel_persistiert:false};}
export async function mitHexWorkJob<T>(project:string,id:string,sourceSha:string,stand:HexStand,signal:AbortSignal,
 arbeit:()=>Promise<T>,stagen:(r:T,jobId:string)=>Promise<string>,verwerfen:(r:T)=>void):Promise<{wert:T;job_id:string}>{
 const w=identitaet;if(!w)throw new HexFehler('kein_hex_ausfuehrer');
 const db=getPool(),domain=computeResourceBinding(w.nodeId)?.hostResourceDomain??'hex:'+w.nodeId;
 const parallel=stand.werte.hex_worker_parallel.wert,need={cpu:stand.werte.hex_worker_cpu.wert,ram:Math.ceil(stand.werte.ram_bytes.wert/1048576),vram:0,gpu:false};
 const seconds=Math.ceil(stand.werte.laufzeit_ms.wert/1000)+stand.werte.hex_lease_zusatz_sekunden.wert;
 const eingabe=async(c:Pick<WorkJobClient,'query'>)=>!!(await c.query("SELECT id FROM hex_analysen WHERE id=$1 AND project=$2 AND status='vorbereitet' AND herkunft->>'ursprung_sha256'=$3 AND expires_at>clock_timestamp() FOR SHARE",[id,project,sourceSha])).rows.length;
 const jobs=createWorkJobService({
  config:{leaseSeconds:seconds,maxLeaseSeconds:seconds,agingSeconds:stand.werte.hex_job_aging_sekunden.wert,interactiveReserve:0,maxClaimsPerCall:1,scanLimit:stand.werte.hex_job_scan.wert,nodeFreshnessSeconds:stand.werte.hex_node_frische_sekunden.wert},
  resourceDomain:n=>n===w.nodeId?domain:undefined,
  authorizeJob:async(node,job)=>{
   if(node.node_id!==w.nodeId||String(node.boot_id)!==w.bootGeneration||node.service_token_hash!==w.authHash||job.kind!=='hex-entschluesseln'||job.capability!=='hex_entschluesseln'||job.project!==project||job.inputRef.id!==id)return null;
   return {resourceDomain:domain,maxConcurrent:parallel,budget:{cpu:need.cpu*parallel,ram:need.ram*parallel,vram:0,gpu:false}};
  },
  inputStillCurrent:async(job,c)=>job.inputRef.id===id&&job.inputRef.sha256===sourceSha&&await eingabe(c),
  outputIsStaged:async(job,out,c)=>out.scope==='hex-analyse'&&out.id===id&&job.inputRef.id===id&&!!(await c.query("SELECT 1 FROM hex_analysen WHERE id=$1 AND project=$2 AND status='vorbereitet' AND sha256=$3 FOR SHARE",[id,project,out.sha256])).rows.length,
 });
 const inputRef={scope:'hex-analyse-input',id,revision:'1',sha256:sourceSha};
 const j=await jobs.enqueue({kind:'hex-entschluesseln',capability:'hex_entschluesseln',project,scope:'hex-analyse',inputRef,resourceNeed:need,priority:'interaktiv',idempotencyKey:'hex:'+id,deadline:new Date(Date.now()+stand.werte.laufzeit_ms.wert).toISOString()});
 let token:string|null=null,wert:T|undefined,fertig=false;
 const pruefen=()=>{if(signal.aborted)throw new HexFehler('zeitlimit');};
 try{
  pruefen();const claims=await jobs.claim(w,{limit:1,leaseSeconds:seconds});const c=claims.find(x=>x.id===j.id);
  if(!c?.claimToken)throw new HexFehler('hex_worker_nicht_zugelassen');
  token=c.claimToken;pruefen();wert=await arbeit();pruefen();
  const sha=await stagen(wert,j.id);pruefen();
  if(!await jobs.stage(w,j.id,token,{scope:'hex-analyse',id,revision:'1',sha256:sha}))throw new HexFehler('hex_job_lease_verloren');
  if(!(await jobs.complete(w,j.id,token,inputRef)).completed)throw new HexFehler('hex_job_lease_verloren');
  fertig=true;return {wert,job_id:j.id};
 }finally{
  if(!fertig){
   if(wert!==undefined)verwerfen(wert);
   // Der Worker ist hier physisch beendet. Ausschliesslich die eigene unveraenderte Lease abschliessen.
   await db.query("UPDATE work_jobs SET state='failed',error_code='hex_auftrag_abgebrochen',lease_until=NULL,resource_unconfirmed=false,updated_at=clock_timestamp() WHERE id=$1 AND ((state='pending' AND owner_node IS NULL) OR (state IN ('leased','staged') AND owner_node=$2 AND boot_generation=$3 AND claim_token=$4))",[j.id,w.nodeId,w.bootGeneration,token]).catch(()=>{});
   await db.query("INSERT INTO work_job_audit(id,job_id,event,detail) VALUES($1,$2,'hex_abgebrochen','{}'::jsonb)",[randomUUID(),j.id]).catch(()=>{});
  }
 }
}
