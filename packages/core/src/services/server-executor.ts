/**
 * P20-T18/R4.3: dauerhafte Registry-Identität, private Claim-Generation.
 * Keine erfundenen Ressourcen und kein pauschales Freigeben fremder Claims.
 */
import {createHash,randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import type {EmbeddingClaimsDbClient,EmbeddingClaimsDbPool} from './embedding-claims.js';
const PROCESS_BOOT={bootId:randomUUID(),bootStartedAt:new Date().toISOString()};
export interface ServerExecutorIdentity {
  nodeId:string|null;
  executorOwner:string;
  bootId:string;
  bootStartedAt:string;
  claimOwner:string;
}
export interface ServerExecutorFence extends ServerExecutorIdentity {nodeId:string;tokenHash:string}
export function serverClaimOwner(nodeId:string,executorOwner:string,bootId:string):string {
  return 'srv-'+createHash('sha256').update(JSON.stringify([nodeId,executorOwner,bootId])).digest('hex').slice(0,60);
}
export function createServerExecutorIdentity(env:NodeJS.ProcessEnv=process.env):ServerExecutorIdentity {
  const nodeId=env.SYNAPSE_SERVER_NODE_ID?.trim()||null;
  const executorOwner=env.SYNAPSE_SERVER_EXECUTOR_OWNER?.trim()||'';
  if(nodeId&&(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(nodeId)||!executorOwner||executorOwner.length>255))
    throw new Error('server_executor_identity_invalid');
  if(!nodeId&&executorOwner)throw new Error('server_executor_node_missing');
  // Ohne Betreiberkonfiguration nur prozessisolierte Claims; unbekannte Altclaims laufen aus.
  const owner=executorOwner||PROCESS_BOOT.bootId;
  return {...PROCESS_BOOT,nodeId,executorOwner:owner,claimOwner:serverClaimOwner(nodeId??'',owner,PROCESS_BOOT.bootId)};
}
/** Aufrufer bereitet Modell/Probe außerhalb der TX vor; callback ist ausschließlich PG. */
export async function startServerExecutor(
  fence:ServerExecutorFence,
  register:(db:EmbeddingClaimsDbClient)=>Promise<unknown|null>,
  pool:EmbeddingClaimsDbPool=getPool() as unknown as EmbeddingClaimsDbPool,
):Promise<number> {
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['server-executor:'+fence.nodeId]);
    const auth=await db.query(`SELECT token_hash FROM auth_tokens WHERE token_hash=$1 AND kind='service'
      AND scope=$2 AND (expires_at IS NULL OR expires_at>NOW()) FOR SHARE`,
      [fence.tokenHash,'compute-node:'+fence.nodeId]);
    if(!auth.rows.length)throw new Error('server_executor_token_invalid');
    const before=await db.query<{boot_id:string;executor_owner:string|null;boot_started_at:Date;service_token_hash:string}>(
      'SELECT boot_id,executor_owner,boot_started_at,service_token_hash FROM embedding_knoten WHERE node_id=$1 FOR UPDATE',[fence.nodeId]);
    const old=before.rows[0];
    if(old&&(old.service_token_hash!==fence.tokenHash||old.executor_owner!==null&&old.executor_owner!==fence.executorOwner))
      throw new Error('server_executor_owner_conflict');
    if(old&&old.boot_id!==fence.bootId&&new Date(old.boot_started_at).getTime()>=Date.parse(fence.bootStartedAt))
      throw new Error('server_executor_stale_boot');
    if(old?.boot_id===fence.bootId&&old.executor_owner===fence.executorOwner){
      await db.query('COMMIT');return 0;
    }
    if(!await register(db))throw new Error('server_executor_registration_rejected');
    await db.query('UPDATE embedding_knoten SET executor_owner=$2 WHERE node_id=$1 AND boot_id=$3',
      [fence.nodeId,fence.executorOwner,fence.bootId]);
    let released=0;
    // Keine Übernahme von unraid-local oder eines noch unbekannten Executor-Owners.
    if(old?.executor_owner===fence.executorOwner){
      const r=await db.query(`UPDATE code_chunks SET claimed_by=NULL,claim_token=NULL,lease_until=NULL
        WHERE claimed_by=$1 AND embedded_at IS NULL`,
        [serverClaimOwner(fence.nodeId,fence.executorOwner,old.boot_id)]);
      released=r.rowCount??0;
    }
    await db.query('COMMIT');return released;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
/** FOR SHARE hält Bootrotation bis zum atomaren Claimabschluss auf. HTTP setzt diesen Fence nie. */
export async function serverExecutorMayClaim(db:EmbeddingClaimsDbClient,fence:ServerExecutorFence,claimOwner:string):Promise<boolean>{
  if(claimOwner!==serverClaimOwner(fence.nodeId,fence.executorOwner,fence.bootId))return false;
  const r=await db.query(`SELECT n.node_id FROM embedding_knoten n JOIN auth_tokens a ON a.token_hash=n.service_token_hash
    WHERE n.node_id=$1 AND n.boot_id=$2 AND n.executor_owner=$3 AND n.service_token_hash=$4
      AND n.node_kind='embedding' AND n.modell IS NOT NULL AND NOT n.gesperrt_vom_user
      AND n.status IN ('ready','busy') AND a.kind='service' AND a.scope=$5
      AND (a.expires_at IS NULL OR a.expires_at>NOW()) FOR SHARE OF n,a`,
    [fence.nodeId,fence.bootId,fence.executorOwner,fence.tokenHash,'compute-node:'+fence.nodeId]);
  return r.rows.length>0;
}
