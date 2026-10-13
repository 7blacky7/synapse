/** P20-T15: nur HTTP zum vorhandenen Aussteller, niemals PG auf dem PC. */
import {randomUUID} from 'node:crypto';
import type {AdmissionLease} from '@synapse/core';
/** Vorhandene R1/R4-Metadaten und Features unverändert ergänzen. */
export function withComputeAdmissionFeature<T extends object>(input:T):T&{contractVersion:number;features:string[]}{
 const raw=input as Record<string,unknown>,features=Array.isArray(raw.features)?raw.features.filter((f):f is string=>typeof f==='string'&&!!f.trim()):[];
 return {...input,contractVersion:1,features:[...new Set([...features,'compute_admission'])]};
}
type Transport=(path:string,init:RequestInit)=>Promise<Response>;
interface Options {nodeId:string;bootId:string;transport:Transport;stopped:()=>boolean}
export async function installComputeAdmissionClient(options:Options):Promise<void>{
 const {configureRemoteComputeAdmission}=await import('@synapse/core');
 const endpoint='/api/embedding-nodes/'+encodeURIComponent(options.nodeId)+'/admission';
 const response=await options.transport(endpoint,{method:'GET'});
 if(response.status===404){configureRemoteComputeAdmission(null);return;} // alter API-Stand
 const config=await response.json() as {success?:boolean;enabled?:boolean;pollMs?:number;maxWaitMs?:number};
 if(!response.ok||!config.success)throw Error('admission_negotiation_failed');
 if(!config.enabled){configureRemoteComputeAdmission(null);return;}
 if(!Number.isSafeInteger(config.pollMs)||!Number.isSafeInteger(config.maxWaitMs)||config.pollMs!<=0||config.maxWaitMs!<=0)throw Error('admission_config_invalid');
 async function call(body:object){
  const r=await options.transport(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,bootId:options.bootId})});
  const result=await r.json() as {success?:boolean;enabled?:boolean;admission?:AdmissionLease|null;finished?:boolean;error?:string};
  if(!r.ok||!result.success)throw Error(result.error??'admission_transport_failed');return result;
 }
 configureRemoteComputeAdmission({
  async acquire(model,context){
   const id=randomUUID();let latest:AdmissionLease|null=null;
   const maxWaitMs=Math.min(context.maxWaitMs??config.maxWaitMs!,config.maxWaitMs!);
   try{
    for(;;){
     if(options.stopped())throw Error('admission_stopped');
     const r=await call({action:'acquire',id,model,maxWaitMs,backend:context.backend,source:context.source,claims:context.claims});
     if(r.enabled===false)return null;
     if(!r.admission)throw Error('admission_queue_timeout');
     latest=r.admission;
     if(latest.id!==id||typeof latest.token!=='string')throw Error('admission_response_invalid');
     if(latest.state==='running')return latest;
     if(latest.state!=='waiting')throw Error('admission_response_invalid');
     await new Promise(resolve=>setTimeout(resolve,config.pollMs));
    }
   }catch(e){
    if(latest)await call({action:'finish',id:latest.id,token:latest.token,confirmed:false}).catch(()=>{});
    throw e;
   }
  },
  async finish(lease,confirmed){
   const r=await call({action:'finish',id:lease.id,token:lease.token,confirmed});
   if(r.enabled!==false&&!r.finished)throw Error('admission_finish_rejected');
  },
 });
}
