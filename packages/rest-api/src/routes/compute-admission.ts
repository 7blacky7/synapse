/** P20-T15: Admission nutzt den bestehenden nodegebundenen Compute-Ausweis. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {getPool,createComputeAdmission,computeAdmissionDomain,ComputeAdmissionError,type AdmissionPool,type AdmissionLease,type AdmissionContext} from '@synapse/core';
import type {AuthTokenRow} from '../services/auth.js';
interface Dependencies {validateToken:(token:string)=>Promise<AuthTokenRow|null>;admission?:ReturnType<typeof createComputeAdmission>}
interface Body {claims?:AdmissionContext['claims'];backend?:string;source?:string;id?:string;bootId?:string;model?:string;maxWaitMs?:number;action?:string;token?:string;confirmed?:boolean}
export async function registerComputeAdmissionRoutes(app:FastifyInstance,deps:Dependencies){
 const service=deps.admission??createComputeAdmission(getPool() as unknown as AdmissionPool);
 async function auth(request:FastifyRequest,nodeId:string){
  const token=/^Bearer\s+(.+)$/i.exec(String(request.headers.authorization??''))?.[1]?.trim();
  const row=token?await deps.validateToken(token):null;
  return row?.kind==='service'&&row.scope==='compute-node:'+nodeId?row:null;
 }
 app.get<{Params:{nodeId:string}}>('/api/embedding-nodes/:nodeId/admission',async(request,reply)=>{
  const principal=await auth(request,request.params.nodeId);if(!principal)return reply.code(403).send({success:false,error:'node_not_authorized'});
  if(process.env.SYNAPSE_COMPUTE_ADMISSION!=='1')return {success:true,enabled:false};
  try{const d=computeAdmissionDomain(request.params.nodeId)!;return {success:true,enabled:true,pollMs:d.config.pollMs,maxWaitMs:d.config.maxWaitMs};}
  catch(e){return reply.code(503).send({success:false,error:e instanceof ComputeAdmissionError?e.code:'admission_config_invalid'});}
 });
 app.post<{Params:{nodeId:string};Body:Body}>('/api/embedding-nodes/:nodeId/admission',async(request,reply)=>{
  const nodeId=request.params.nodeId,principal=await auth(request,nodeId);
  if(!principal)return reply.code(403).send({success:false,error:'node_not_authorized'});
  const b=request.body;
  if(!b||typeof b.id!=='string'||typeof b.bootId!=='string')return reply.code(400).send({success:false,error:'admission_input_invalid'});
  const identity={nodeId,bootId:b.bootId,authHash:principal.token_hash};
  try{
   if(b.action==='finish'){
    if(typeof b.token!=='string'||typeof b.confirmed!=='boolean')return reply.code(400).send({success:false,error:'admission_input_invalid'});
    const lease:AdmissionLease={id:b.id,token:b.token,domain:'',state:'running'};
    return {success:true,enabled:process.env.SYNAPSE_COMPUTE_ADMISSION==='1',finished:await service.finish(identity,lease,b.confirmed)};
   }
   if(process.env.SYNAPSE_COMPUTE_ADMISSION!=='1')return {success:true,enabled:false};
   if(b.action!==undefined&&b.action!=='acquire'||typeof b.model!=='string')return reply.code(400).send({success:false,error:'admission_input_invalid'});
   const admission=await service.attempt({...identity,id:b.id,model:b.model,backend:b.backend,source:b.source==='unbound'?'unbound':'compute-node',priority:'hintergrund',maxWaitMs:b.maxWaitMs,claims:b.claims});
   return {success:true,enabled:true,admission};
  }catch(e){
   const code=e instanceof ComputeAdmissionError?e.code:'admission_unavailable';
   return reply.code(code.includes('invalid')||code==='admission_request_conflict'?400:code.includes('auth')||code.includes('usable')||code.includes('policy')?403:503).send({success:false,error:code});
  }
 });
}
