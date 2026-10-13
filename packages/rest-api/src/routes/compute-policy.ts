/** P20-T12/T9: Policyrechte über bestehenden Session-/Tray-/Compute-Ausweisvertrag. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {getPool,ComputePolicyError,setzeComputePolicy,setzeComputeProjektPolicy,
  leseComputeProjektPolicy,computePolicyStatus,type ComputePolicyDb} from '@synapse/core';
import {validateToken,type AuthTokenRow} from '../services/auth.js';
import {getEmbeddingReferenceContract,compatibilityProblems} from '../services/embedding-nodes.js';
export interface ComputePolicyRouteDependencies {
  db?:ComputePolicyDb;validateToken?:(token:string)=>Promise<AuthTokenRow|null>;
}
export async function registerComputePolicyRoutes(fastify:FastifyInstance,deps:ComputePolicyRouteDependencies={}):Promise<void>{
  const db:ComputePolicyDb=deps.db??getPool();
  const validate=deps.validateToken??validateToken;
  const principal=(r:FastifyRequest)=>{const token=/^Bearer\s+(.+)$/i.exec(String(r.headers.authorization??'').trim())?.[1];return token?validate(token):Promise.resolve(null);};
  // Bestehende globale Tray-Userrechte; Compute-Ausweise sind grundsätzlich NICHT Userpolicy.
  const user=(a:AuthTokenRow|null)=>a?.kind==='access'||a?.kind==='session'||a?.kind==='service'&&
    (a.scope==='daemon'||(a.scope??'').startsWith('daemon:'));
  const error=(e:unknown,reply:any)=>{
    if(!(e instanceof ComputePolicyError))throw e;
    return reply.code(e.code==='policy_revision_conflict'?409:['node_not_issued','project_not_found'].includes(e.code)?404:400)
      .send({success:false,error:e.code});
  };
  fastify.get<{Params:{nodeId:string};Querystring:{project?:string}}>(
    '/api/embedding-nodes/:nodeId/policy',async(request,reply)=>{
      const auth=await principal(request),nodeId=request.params.nodeId;
      if(!user(auth)&&!(auth?.kind==='service'&&auth.scope==='compute-node:'+nodeId))
        return reply.code(403).send({success:false,error:'node_token_mismatch'});
      try {
        const hint=(await db.query<{modell:string|null}>('SELECT modell FROM embedding_knoten WHERE node_id=$1',[nodeId])).rows[0];
        const reference=hint?.modell?await getEmbeddingReferenceContract().catch(()=>null):null; // HTTP nur VOR dem PG-Statuspfad; CPU-only braucht kein Fakemodell.
        return reply.send({success:true,...await computePolicyStatus(nodeId,request.query.project,db,{
          profileCompatible:(capability,node)=>capability==='embedding'&&!!node&&!!reference&&compatibilityProblems({
            model:node.modell as string,modelDigest:node.modell_digest as string,
            nativeDimension:node.native_dimension as number,targetDimension:node.ziel_dimension as number,
            numCtx:node.num_ctx as number,quantization:node.quantisierung as string|null},reference).length===0,
          resourcesAvailable:(capability,node)=>capability==='embedding'&&!!node&&!!reference&&Number(node.vram_gesamt_mb)>=reference.requiredTotalVramMb,
        })});
      }
      catch(e){return error(e,reply);}
    });
  fastify.patch<{Params:{nodeId:string};Body:unknown}>(
    '/api/embedding-nodes/:nodeId/policy',async(request,reply)=>{
      if(!user(await principal(request)))return reply.code(403).send({success:false,error:'user_policy_required'});
      try{return reply.send({success:true,policy:await setzeComputePolicy(request.params.nodeId,request.body,db)});}
      catch(e){return error(e,reply);}
    });
  fastify.get<{Params:{project:string}}>(
    '/api/projects/:project/compute-policy',async(request,reply)=>{
      if(!user(await principal(request)))return reply.code(403).send({success:false,error:'user_policy_required'});
      try{return reply.send({success:true,policy:await leseComputeProjektPolicy(request.params.project,db)});}
      catch(e){return error(e,reply);}
    });
  fastify.patch<{Params:{project:string};Body:unknown}>(
    '/api/projects/:project/compute-policy',async(request,reply)=>{
      if(!user(await principal(request)))return reply.code(403).send({success:false,error:'user_policy_required'});
      try{return reply.send({success:true,policy:await setzeComputeProjektPolicy(request.params.project,request.body,db)});}
      catch(e){return error(e,reply);}
    });
}
