/** P20-T14: additive Work-Job-Familie im vorhandenen embedding-nodes-Vertrag. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  API_CONTRACT_HEADER, apiCapabilitiesForClient, computeResourceBinding,
  createWorkJobService, WorkJobError, validateWorkReference, validateWorkResources,
  type WorkJobService, type WorkJobInput, type WorkIdentity,
} from '@synapse/core';
import { validateToken, type AuthTokenRow } from '../services/auth.js';

export interface WorkJobRouteDependencies {
  validateToken?: (token: string) => Promise<AuthTokenRow | null>;
  service?: WorkJobService;
}
type LeaseBody = {
  bootGeneration?: string; claimToken?: string; limit?: number; leaseSeconds?: number;
  inputRef?: unknown; outputRef?: unknown;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function registerWorkJobRoutes(
  fastify: FastifyInstance, overrides: WorkJobRouteDependencies = {},
): Promise<void> {
  const authenticate = overrides.validateToken ?? validateToken;
  // Default-off darf weder neue Konfiguration noch eine neue DB-Abhängigkeit initialisieren.
  let current = overrides.service;
  const service = (): WorkJobService => current ??= createWorkJobService({
    resourceDomain: nodeId => computeResourceBinding(nodeId)?.hostResourceDomain,
  });
  async function principal(request: FastifyRequest): Promise<AuthTokenRow | null> {
    const token = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization ?? '').trim())?.[1];
    return token ? authenticate(token) : null;
  }
  function enabled(request: FastifyRequest,reply: FastifyReply): boolean {
    const negotiated = apiCapabilitiesForClient(request.headers[API_CONTRACT_HEADER]);
    if (process.env.SYNAPSE_WORK_JOBS_ENABLED !== '1' || !negotiated?.features.includes('compute_resources')) {
      reply.code(503).send({success:false,error:'work_jobs_disabled'});
      return false;
    }
    return true;
  }
  async function admin(request: FastifyRequest,reply: FastifyReply): Promise<boolean> {
    const auth = await principal(request);
    if (!auth || !['access','session'].includes(auth.kind)) {
      reply.code(403).send({success:false,error:'admin_token_required'});
      return false;
    }
    return enabled(request,reply);
  }
  async function identity(request: FastifyRequest<{Params:{nodeId:string};Body:LeaseBody}>,
    reply: FastifyReply): Promise<WorkIdentity | null> {
    const auth = await principal(request);
    const nodeId = request.params.nodeId;
    if (auth?.kind !== 'service' || auth.scope !== 'compute-node:'+nodeId) {
      reply.code(403).send({success:false,error:'node_token_mismatch'});
      return null;
    }
    if (!enabled(request,reply)) return null;
    if (!UUID.test(request.body?.bootGeneration ?? '')) {
      reply.code(400).send({success:false,error:'invalid_work_identity'});
      return null;
    }
    // Ausschließlich validierter API-Ausweis; ein authHash im Clientbody wird ignoriert.
    return {nodeId,bootGeneration:request.body.bootGeneration!,authHash:auth.token_hash};
  }
  function error(reply: FastifyReply,exception: unknown) {
    if (exception instanceof WorkJobError)
      return reply.code(exception.code === 'idempotency_conflict' ? 409 : 400)
        .send({success:false,error:exception.code});
    throw exception;
  }
  fastify.post<{Body:WorkJobInput}>('/api/embedding-nodes/work/jobs',async(request,reply)=>{
    if (!await admin(request,reply)) return;
    try {
      validateWorkReference(request.body?.inputRef);
      validateWorkResources(request.body?.resourceNeed);
      return reply.code(201).send({success:true,job:await service().enqueue(request.body)});
    } catch(exception) {return error(reply,exception);}
  });
  fastify.get<{Params:{jobId:string};Querystring:{project?:string}}>(
    '/api/embedding-nodes/work/jobs/:jobId',async(request,reply)=>{
      if (!await admin(request,reply)) return;
      if (!request.query.project) return reply.code(400).send({success:false,error:'project_required'});
      const found=await service().get(request.params.jobId,request.query.project);
      if (!found) return reply.code(404).send({success:false,error:'work_job_not_found'});
      const {claimToken:_private,...visible}=found;
      return reply.send({success:true,job:visible});
    });
  fastify.post<{Params:{nodeId:string};Body:LeaseBody}>(
    '/api/embedding-nodes/:nodeId/work/claims',async(request,reply)=>{
      const who=await identity(request,reply);
      if (!who) return;
      try {return reply.send({success:true,claims:await service().claim(who,{
        limit:request.body.limit,leaseSeconds:request.body.leaseSeconds}),policyReady:service().ready()});}
      catch(exception) {return error(reply,exception);}
    });
  for (const action of ['renew','stage','complete','release'] as const) {
    fastify.post<{Params:{nodeId:string;jobId:string};Body:LeaseBody}>(
      '/api/embedding-nodes/:nodeId/work/jobs/:jobId/'+action,async(request,reply)=>{
        const who=await identity(request,reply);
        if (!who) return;
        const body=request.body;
        if (!UUID.test(body.claimToken??'') || !UUID.test(request.params.jobId))
          return reply.code(400).send({success:false,error:'invalid_work_lease'});
        try {
          const jobId=request.params.jobId;
          const token=body.claimToken!;
          if (action==='complete') return reply.send({success:true,
            ...await service().complete(who,jobId,token,validateWorkReference(body.inputRef))});
          const accepted=action==='renew' ? await service().renew(who,jobId,token,body.leaseSeconds)
            : action==='stage' ? await service().stage(who,jobId,token,validateWorkReference(body.outputRef))
            : await service().release(who,jobId,token);
          return reply.send({success:true,accepted});
        } catch(exception) {return error(reply,exception);}
      });
  }
}
