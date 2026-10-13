/** P20-T16: interne Broker-Schreibschnittstelle; kein zusätzlicher Client-Steuerkanal. */
import {getPool} from '../db/client.js';
import {apiCapabilitiesForClient} from '../vertrag/api-vertrag.js';
import {computeResourceBinding} from '../vertrag/compute-ressourcen.js';
import {embeddingComputePolicy,type ComputePolicyDb} from './compute-policy.js';
import {parseComputeControlCommand,parseComputeControlObservation,type ComputeControlCommand,type ComputeControlResponse} from '../vertrag/compute-steuerung.js';
export function computeControlEnabled():boolean{return !!apiCapabilitiesForClient('1')?.features.includes('compute_control');}
interface ControlNode {node_id:string;boot_id:string;features?:string[]|null;gesperrt_vom_user:boolean;aktualisiert_am:Date}
/** Nur API-interner Broker nach eigener Authority-Prüfung; niemals rohe Requestdaten übergeben. */
export async function setComputeNodeControl(nodeId:string,command:Omit<ComputeControlCommand,'revision'>,db:ComputePolicyDb=getPool()):Promise<ComputeControlCommand>{
 if(!computeControlEnabled())throw Error('compute_control_disabled');
 const parsed=parseComputeControlCommand({...command,revision:1}),binding=computeResourceBinding(nodeId);
 if(!binding?.deviceIds.includes(parsed.deviceId)||Date.parse(parsed.deadline)<=Date.now())throw Error('compute_control_target_invalid');
 const result=await db.query<{desired:ComputeControlCommand}>(`INSERT INTO compute_node_control(node_id,boot_id,revision,desired)
 SELECT node_id,boot_id,1,$3::jsonb FROM embedding_knoten
 WHERE node_id=$1 AND boot_id::text=$2 AND features @> ARRAY['compute_control']::text[]
 ON CONFLICT(node_id) DO UPDATE SET boot_id=EXCLUDED.boot_id,revision=compute_node_control.revision+1,
 desired=jsonb_set(EXCLUDED.desired,'{revision}',to_jsonb(compute_node_control.revision+1)),
 observed=NULL,observed_at=NULL,ack_revision=NULL,requested_at=clock_timestamp()
 WHERE compute_node_control.revision<9007199254740991
 RETURNING desired`,[nodeId,parsed.bootId,JSON.stringify(parsed)]);
 if(!result.rows[0])throw Error('compute_control_node_not_ready');
 return parseComputeControlCommand(result.rows[0].desired);
}
export async function computeNodeControlResponse(node:ControlNode,db:ComputePolicyDb=getPool()):Promise<ComputeControlResponse|undefined>{
 if(!computeControlEnabled()||!node.features?.includes('compute_control'))return undefined;
 const policy=await embeddingComputePolicy(node.node_id,db);
 const allowed=!node.gesperrt_vom_user&&(!policy||policy.decision.allowed);
 const row=(await db.query<{desired:ComputeControlCommand}>('SELECT desired FROM compute_node_control WHERE node_id=$1 AND boot_id=$2',[node.node_id,node.boot_id])).rows[0];
 return {desired:row?parseComputeControlCommand(row.desired):null,allowed,policyRevision:policy?.decision.policyRevision??0,nodeUpdatedAt:new Date(node.aktualisiert_am).toISOString()};
}
export async function observeComputeNodeControl(node:ControlNode,raw:unknown,db:ComputePolicyDb=getPool()):Promise<void>{
 if(raw===undefined||!computeControlEnabled()||!node.features?.includes('compute_control'))return;
 const o=parseComputeControlObservation(raw);
 const response=await computeNodeControlResponse(node,db),canAck=o.state!=='running'||response?.allowed===true;
 if(o.bootId!==node.boot_id)throw Error('compute_control_boot_mismatch');
 // Ablauf ist kein Freigabe-Ack. Beobachtung muss nach Soll und frisch nach PG-Zeit sein.
 await db.query(`UPDATE compute_node_control SET observed=$4::jsonb,observed_at=clock_timestamp(),
 ack_revision=CASE WHEN $5::bigint=revision AND $6::int=0 AND $7::int=0
 AND (($8='unloaded' AND $9::boolean=false AND desired->>'action'<>'resume'
 AND EXISTS(SELECT 1 FROM embedding_knoten n,jsonb_array_elements(COALESCE(n.ressourcen->'gpus','[]'::jsonb)) g
 WHERE n.node_id=$1 AND g->>'deviceId'=desired->>'deviceId'
 AND g->'totalMb'->>'quality'='measured' AND g->'freeMb'->>'quality'='measured'
 AND (g->'freeMb'->>'measuredAt')::timestamptz>=requested_at))
 OR ($8='running' AND desired->>'action'='resume' AND NOT EXISTS(
 SELECT 1 FROM embedding_knoten n WHERE n.node_id=$1 AND n.gesperrt_vom_user)))
 THEN revision ELSE NULL END
 WHERE node_id=$1 AND boot_id=$2 AND revision=$3 AND ($4::jsonb->>'measuredAt')::timestamptz>=requested_at
 AND ($4::jsonb->>'measuredAt')::timestamptz<=clock_timestamp()
 AND ($4::jsonb->>'measuredAt')::timestamptz>clock_timestamp()-INTERVAL '2 minutes'
 AND (desired->>'deadline')::timestamptz>clock_timestamp()
 AND EXISTS(SELECT 1 FROM embedding_knoten n WHERE n.node_id=$1 AND n.boot_id::text=$2)`,
 [node.node_id,o.bootId,o.revision,JSON.stringify(o),canAck?o.ackRevision??null:null,o.activeBatches,o.pendingClaims,o.state,o.modelPresent]);
}
