/**
 * P20-T13/R1.3: CPU-only-Metadaten in derselben Registry, keine Embedding-Dummies.
 * Aktivierung: A1 compute_cpu_only + expliziter Clientvertrag. Keine Policy-Freigabe.
 */
import {apiCapabilitiesForClient,parseComputeNodeExtension,computeResourceSnapshot} from '@synapse/core';
type NormalizedComputeNodeExtension=NonNullable<ReturnType<typeof parseComputeNodeExtension>>;
import {authorizedNodeCapacity,validateNodeId,type Queryable} from './embedding-nodes.js';
export class CpuNodeError extends Error {
  constructor(readonly code:string,readonly status=400){super(code);}
}
type Raw=Record<string,unknown>;
const object=(x:unknown):x is Raw=>!!x&&typeof x==='object'&&!Array.isArray(x);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const embeddingFields=['model','modelDigest','ollamaUrl','quantization','nativeDimension','targetDimension',
  'numCtx','vramTotalMb','vramFreeMb','gpuName'];
export function cpuNodeRequested(input:unknown):boolean {
  return object(input)&&Array.isArray(input.features)&&input.features.includes('compute_cpu_only');
}
export function cpuNodeEnabled(version:unknown):boolean {
  return !!apiCapabilitiesForClient(version)?.features.includes('compute_cpu_only');
}
function metadata(input:unknown,nodeId:string,version:unknown,registration:boolean):NormalizedComputeNodeExtension {
  if(!cpuNodeEnabled(version)||!object(input)||input.contractVersion!==1||!cpuNodeRequested(input))
    throw new CpuNodeError('compute_cpu_only_disabled',503);
  if(!validateNodeId(nodeId)||embeddingFields.some(k=>input[k]!==undefined&&input[k]!==null))
    throw new CpuNodeError('invalid_cpu_metadata');
  let ext:NormalizedComputeNodeExtension|undefined;
  try {ext=parseComputeNodeExtension(input,nodeId);}
  catch{throw new CpuNodeError('invalid_cpu_resources');}
  if(!ext||!ext.features?.includes('compute_cpu_only')||ext.resources?.gpus.length||
    (registration&&(!ext.capabilities?.length||ext.capabilities.some(c=>c.id==='embedding'))))
    throw new CpuNodeError('invalid_cpu_capabilities');
  return ext;
}
function common(input:Raw):void {
  if(typeof input.bootId!=='string'||!UUID.test(input.bootId))throw new CpuNodeError('invalid_cpu_boot');
}
export async function registerCpuNode(input:unknown,hash:string,version:unknown,db:Queryable):Promise<Raw|null> {
  const x=object(input)?input:{};
  const nodeId=typeof x.nodeId==='string'?x.nodeId:'';
  const ext=metadata(x,nodeId,version,true);common(x);
  if(typeof x.host!=='string'||!x.host.trim()||x.host.length>255||
    typeof x.bootStartedAt!=='string'||!Number.isFinite(Date.parse(x.bootStartedAt))||
    Date.parse(x.bootStartedAt)>Date.now()+5*60000||
    (x.maxConcurrency!=null&&(!Number.isInteger(x.maxConcurrency)||Number(x.maxConcurrency)<1)))
    throw new CpuNodeError('invalid_cpu_metadata');
  const capacity=authorizedNodeCapacity(x.maxConcurrency as number|undefined);
  if(capacity===null)throw new CpuNodeError('node_capacity_not_configured',503);
  const r=await db.query<Raw>(`INSERT INTO embedding_knoten(
    node_id,host,ollama_url,modell,modell_digest,quantisierung,native_dimension,ziel_dimension,num_ctx,
    vram_gesamt_mb,vram_frei_mb,max_concurrency,active_jobs,status,service_token_hash,boot_id,
    last_sequence,boot_started_at,node_kind,contract_version,features,capability_revision,policy_revision,
    location,host_resource_domain,ressourcen,capabilities)
    VALUES($1,$2,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$3,0,'ready',$4,$5,0,$6,'cpu',
      ($7::jsonb->>'contractVersion')::int,ARRAY(SELECT jsonb_array_elements_text($7::jsonb->'features')),
      ($7::jsonb->>'capabilityRevision')::bigint,($7::jsonb->>'policyRevision')::bigint,
      $7::jsonb->>'location',$7::jsonb->>'hostResourceDomain',$7::jsonb->'resources',$7::jsonb->'capabilities')
    ON CONFLICT(node_id) DO UPDATE SET host=EXCLUDED.host,max_concurrency=EXCLUDED.max_concurrency,
      active_jobs=0,status='ready',service_token_hash=EXCLUDED.service_token_hash,boot_id=EXCLUDED.boot_id,
      last_sequence=0,boot_started_at=EXCLUDED.boot_started_at,letzter_kontakt=NOW(),aktualisiert_am=NOW(),
      contract_version=EXCLUDED.contract_version,features=EXCLUDED.features,
      capability_revision=EXCLUDED.capability_revision,policy_revision=EXCLUDED.policy_revision,
      location=EXCLUDED.location,host_resource_domain=EXCLUDED.host_resource_domain,
      ressourcen=EXCLUDED.ressourcen,capabilities=EXCLUDED.capabilities
    WHERE embedding_knoten.node_kind='cpu' AND
      (embedding_knoten.boot_started_at<=EXCLUDED.boot_started_at OR embedding_knoten.letzter_kontakt<NOW()-INTERVAL '2 minutes')
    RETURNING *`,[nodeId,x.host,capacity,hash,x.bootId,x.bootStartedAt,JSON.stringify(ext)]);
  return r.rows[0]??null;
}
export async function heartbeatCpuNode(nodeId:string,input:unknown,hash:string,version:unknown,db:Queryable):Promise<Raw|null> {
  const x=object(input)?input:{};
  const ext=metadata(x,nodeId,version,false);common(x);
  if(!['ready','busy'].includes(String(x.status))||!Number.isSafeInteger(x.sequence)||Number(x.sequence)<1||
    !Number.isSafeInteger(x.activeJobs)||Number(x.activeJobs)<0)throw new CpuNodeError('invalid_cpu_heartbeat');
  const r=await db.query<Raw>(`UPDATE embedding_knoten SET status=$5,active_jobs=$6,last_sequence=$4,
    letzter_kontakt=NOW(),aktualisiert_am=NOW(),
    features=ARRAY(SELECT jsonb_array_elements_text($7::jsonb->'features')),
    capability_revision=COALESCE(($7::jsonb->>'capabilityRevision')::bigint,capability_revision),
    policy_revision=COALESCE(($7::jsonb->>'policyRevision')::bigint,policy_revision),
    ressourcen=COALESCE($7::jsonb->'resources',ressourcen),capabilities=COALESCE($7::jsonb->'capabilities',capabilities)
    WHERE node_id=$1 AND node_kind='cpu' AND service_token_hash=$2 AND boot_id=$3 AND last_sequence<$4
    RETURNING *`,[nodeId,hash,x.bootId,x.sequence,x.status,x.activeJobs,JSON.stringify(ext)]);
  return r.rows[0]??null;
}
export async function listCpuNodes(db:Queryable,version:unknown,nodeId?:string,hash?:string):Promise<Raw[]> {
  if(!cpuNodeEnabled(version))return [];
  const r=await db.query<Raw>(`SELECT *,NOW() AS server_now FROM embedding_knoten WHERE node_kind='cpu'
    AND ($1::text IS NULL OR node_id=$1) AND ($2::text IS NULL OR service_token_hash=$2) ORDER BY node_id`,[nodeId??null,hash??null]);
  return r.rows.map(row=>{
    const {service_token_hash:_private,ressourcen,contract_version,features,capability_revision,
      policy_revision,location,host_resource_domain,capabilities,node_kind,executor_owner,...visible}=row;
    const old=Number(new Date(row.server_now as string))-Number(new Date(row.letzter_kontakt as string));
    const effectiveStatus=row.gesperrt_vom_user?'locked':!Number.isFinite(old)||old>120000?'failed':row.status;
    return {...visible,nodeKind:node_kind,executorOwner:executor_owner??null,bootGeneration:row.boot_id,contractVersion:contract_version,features,
      capabilityRevision:capability_revision==null?null:Number(capability_revision),
      policyRevision:policy_revision==null?null:Number(policy_revision),location,hostResourceDomain:host_resource_domain,
      resources:computeResourceSnapshot(ressourcen as Parameters<typeof computeResourceSnapshot>[0]),
      capabilities:capabilities??[],effectiveStatus,usable:['ready','busy'].includes(String(effectiveStatus))};
  });
}
