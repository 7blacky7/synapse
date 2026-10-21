/**
 * P20-T18/R4.3: Serveradapter für denselben R1.1-Registryvertrag.
 * Betreiber konfiguriert node_id/Owner, Service-Token, Registrierungsmetadaten und
 * optional eine read-only JSON-Hostprobe im ComputeResourceReport-Format.
 * Weder os.totalmem() noch cgroup-Werte werden zu freier Hostkapazität umgedeutet.
 */
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {konfiguriereHexWorkIdentitaet,loeseHexWorkIdentitaet,hexWorkStatus,getPool,computeResourceBinding,parseComputeNodeExtension,createServerExecutorIdentity,
  startServerExecutor,configureLocalComputeAdmission,type ServerExecutorIdentity,type ServerExecutorFence,type ComputeResources} from '@synapse/core';
import {validateToken} from './auth.js';
import {cpuNodeRequested,registerCpuNode} from './cpu-nodes.js';
import {registerEmbeddingNode,getEmbeddingReferenceContract,compatibilityProblems,
  validateOllamaUrl,authorizedNodeCapacity,type EmbeddingNodeRegistration} from './embedding-nodes.js';
type Raw=Record<string,unknown>;
const object=(x:unknown):x is Raw=>!!x&&typeof x==='object'&&!Array.isArray(x);
const PROBE_MAX_BYTES=65536;
export async function readServerHostProbe(nodeId:string,cpuOnly=false,probeFile=process.env.SYNAPSE_SERVER_HOST_PROBE_FILE):Promise<ComputeResources> {
  const binding=computeResourceBinding(nodeId);
  if(!binding)throw new Error('server_executor_resource_binding_missing');
  const unknown={gpus:cpuOnly?[]:binding.deviceIds.map(deviceId=>({deviceId}))};
  let report:unknown=unknown;
  const path=probeFile?.trim();
  if(path){
    let fd:Awaited<ReturnType<typeof open>>|undefined;
    try{
      // Keine Programme starten, keine Schreibrechte, keine FIFO-/Symlink-Fallen.
      fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await fd.stat();
      if(!stat.isFile()||stat.size>PROBE_MAX_BYTES)throw new Error('probe_format');
      const buffer=Buffer.alloc(PROBE_MAX_BYTES+1);
      const {bytesRead}=await fd.read(buffer,0,buffer.length,0);
      if(bytesRead>PROBE_MAX_BYTES)throw new Error('probe_size');
      const parsed:unknown=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
      if(!object(parsed))throw new Error('probe_object');
      report=parsed;
    }catch{report=unknown;}finally{await fd?.close();}
  }
  const normalize=(resources:unknown)=>parseComputeNodeExtension(
    {contractVersion:1,features:[],resources},nodeId)?.resources;
  try{return normalize(report)!;}catch{return normalize(unknown)!;}
}
/**
 * P18-T59: envPrefix trennt weitere Server-Knoten (Reverse: SYNAPSE_REVERSE_) vom Parser-Knoten (Default SYNAPSE_SERVER_).
 * nurCpu verlangt eine CPU-only-Registrierung; lokaleAdmission:false lässt die prozessweite GPU-Admission unberührt.
 * P21-T15: hex bestimmt die Hex-Work-Bindung: 'bindet' immer, 'ersatz' nur solange kein anderer Knoten gebunden ist
 * (live gibt es oft keinen Parser-Serverknoten, nur den Reverse-CPU-Knoten), 'aus' nie. Standard: 'bindet' mit lokaler Admission.
 */
export interface ServerExecutorOptionen {envPrefix?:string;nurCpu?:boolean;lokaleAdmission?:boolean;hex?:'bindet'|'ersatz'|'aus'}
export class ServerExecutor {
  readonly identity:ServerExecutorIdentity;
  fence:ServerExecutorFence|undefined;
  cpuOnly=false;
  private ready=false;
  private readonly prefix:string;
  private readonly nurCpu:boolean;
  private readonly lokaleAdmission:boolean;
  private readonly hex:'bindet'|'ersatz'|'aus';
  private hexGebunden=false;
  constructor(o:ServerExecutorOptionen={}){
    this.prefix=o.envPrefix??'SYNAPSE_SERVER_';this.nurCpu=o.nurCpu===true;this.lokaleAdmission=o.lokaleAdmission!==false;
    this.hex=o.hex??(this.lokaleAdmission?'bindet':'aus');
    this.identity=createServerExecutorIdentity(process.env,this.prefix);
  }
  private env(name:string):string|undefined{return process.env[this.prefix+name];}
  async start():Promise<number>{
    const id=this.identity;
    if(!id.nodeId){this.ready=true;return 0;}
    const configured=this.env('NODE_REGISTRATION');
    const raw:unknown=configured?JSON.parse(configured):null;
    if(!object(raw))throw new Error('server_executor_registration_missing');
    if(this.nurCpu&&!cpuNodeRequested(raw))throw new Error('server_executor_cpu_only_required');
    const auth=await validateToken(this.env('COMPUTE_TOKEN')??'');
    if(auth?.kind!=='service'||auth.scope!=='compute-node:'+id.nodeId)throw new Error('server_executor_token_invalid');
    this.cpuOnly=cpuNodeRequested(raw);
    const resources=await readServerHostProbe(id.nodeId,this.cpuOnly,this.env('HOST_PROBE_FILE'));
    const input={...raw,contractVersion:1,features:raw.features??[],nodeId:id.nodeId,bootId:id.bootId,bootStartedAt:id.bootStartedAt,resources};
    // Validierung/Modellzugriffe sind vor der Registry-TX abgeschlossen.
    parseComputeNodeExtension(input,id.nodeId);
    if(!this.cpuOnly){
      const deviceId=this.env('EMBED_DEVICE_ID');
      const gpu=resources.gpus.find(g=>g.deviceId===deviceId);
      const total=gpu?.totalMb,free=gpu?.freeMb;
      if(!total||!free||total.freshness!=='fresh'||free.freshness!=='fresh'||
        total.quality!=='measured'||free.quality!=='measured'||
        !Number.isInteger(total.value)||!Number.isInteger(free.value)||Number(free.value)>Number(total.value))
        throw new Error('server_executor_gpu_measurement_unknown');
      Object.assign(input,{vramTotalMb:total.value,vramFreeMb:free.value});
      const x=input as unknown as EmbeddingNodeRegistration;
      const ref=await getEmbeddingReferenceContract();
      if(typeof x.host!=='string'||!x.host.trim()||x.host.length>255||typeof x.ollamaUrl!=='string'||
        !validateOllamaUrl(x.ollamaUrl)||compatibilityProblems(x,ref).length||
        x.vramTotalMb<ref.requiredTotalVramMb||x.vramFreeMb<ref.requiredFreeVramMb)
        throw new Error('server_executor_embedding_registration_invalid');
      const capacity=authorizedNodeCapacity(x.maxConcurrency);
      if(capacity===null)throw new Error('server_executor_capacity_missing');
      x.maxConcurrency=capacity;
    }
    const fence:ServerExecutorFence={...id,nodeId:id.nodeId,tokenHash:auth.token_hash};
    const released=await startServerExecutor(fence,db=>this.cpuOnly
      ?registerCpuNode(input,auth.token_hash,'1',db)
      :registerEmbeddingNode(auth.token_hash,input as unknown as EmbeddingNodeRegistration,db));
    if(this.lokaleAdmission)configureLocalComputeAdmission({nodeId:fence.nodeId,bootId:fence.bootId,authHash:fence.tokenHash});
    if(this.hex==='bindet'||this.hex==='ersatz'&&!hexWorkStatus().bereit)this.bindeHex(fence);
    this.fence=fence;this.ready=true;return released;
  }
  private bindeHex(f:ServerExecutorFence):void{
    konfiguriereHexWorkIdentitaet({nodeId:f.nodeId,bootGeneration:f.bootId,authHash:f.tokenHash});this.hexGebunden=true;
  }
  /** Ein alter Prozess aktualisiert nie die neue Generation. Probe-I/O vor jedem PG-Zugriff. */
  async refresh():Promise<boolean>{
    if(!this.ready)return false;
    if(!this.fence)return true;
    const f=this.fence;
    const resources=await readServerHostProbe(f.nodeId,this.cpuOnly,this.env('HOST_PROBE_FILE'));
    const r=await getPool().query(`UPDATE embedding_knoten n SET ressourcen=$5::jsonb,last_sequence=n.last_sequence+1,
      letzter_kontakt=NOW(),aktualisiert_am=NOW()
      WHERE n.node_id=$1 AND n.boot_id=$2 AND n.executor_owner=$3 AND n.service_token_hash=$4
        AND EXISTS(SELECT 1 FROM auth_tokens a WHERE a.token_hash=$4 AND a.kind='service'
          AND a.scope=$6 AND (a.expires_at IS NULL OR a.expires_at>NOW())) RETURNING n.node_id`,
      [f.nodeId,f.bootId,f.executorOwner,f.tokenHash,JSON.stringify(resources),'compute-node:'+f.nodeId]);
    const ok=(r.rowCount??0)>0;
    // P21-T15: abgeloeste Generation nimmt ihre Hex-Bindung zurueck; ein Ersatzknoten springt ein, wenn keiner gebunden ist.
    if(!ok&&this.hexGebunden){loeseHexWorkIdentitaet({nodeId:f.nodeId,bootGeneration:f.bootId,authHash:f.tokenHash});this.hexGebunden=false;}
    else if(ok&&this.hex==='ersatz'&&!hexWorkStatus().bereit)this.bindeHex(f);
    return ok;
  }
}
