/** A10: explicit restore contract beside legacy init, host identity from existing auth. */
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {ProjectRestoreService,ProjectRestoreError,API_CONTRACT_HEADER,apiCapabilitiesForClient,HostLoesenFehler,VirtuellesProjektFehler,projektHostLoesen,claimHostLoesungen,schliesseHostLoesung,mitUserHerkunft} from '@synapse/core';
import {validateToken,type AuthTokenRow} from '../services/auth.js';
export interface ProjectRestoreRoutesDeps {service?:ProjectRestoreService;validateToken?:typeof validateToken}
export async function registerProjectRestoreRoutes(f:FastifyInstance,o:ProjectRestoreRoutesDeps={}){
 const service=o.service??new ProjectRestoreService(),validate=o.validateToken??validateToken;
 async function identity(req:FastifyRequest):Promise<AuthTokenRow>{
  const text=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization??''))?.[1];
  const auth=text?await validate(text):null;
  if(!auth)throw new ProjectRestoreError('unauthorized',401);
  if(!apiCapabilitiesForClient(req.headers[API_CONTRACT_HEADER])?.features.includes('asset_sync'))throw new ProjectRestoreError('vertrag_erforderlich',426);
  return auth;
 }
 function daemon(auth:AuthTokenRow){
  return auth.kind==='service'&&(auth.scope==='daemon'||auth.scope?.startsWith('daemon:'));
 }
 // P9-T30 (Nachbesserung): User = Web-UI-Sitzung des Users (session ohne scope; wie user-post P10-T41).
 function webUiUser(auth:AuthTokenRow){return auth.kind==='session'&&auth.scope===null;}
 async function host(auth:AuthTokenRow,requested?:string,userAllowed=false){
  if(daemon(auth)){
   const own=await service.daemonHost(auth.token_hash);
   if(!own)throw new ProjectRestoreError('daemon_host_nicht_gebunden',403);
   if(requested&&requested!==own)throw new ProjectRestoreError('host_verboten',403);return own;
  }
  // Frei waehlbarer hostname nur fuer den User; Access-/OAuth-Token und andere Sitzungen (z. B. ui:tray) -> 403.
  if(userAllowed&&!webUiUser(auth))throw new ProjectRestoreError('nur_koordinator_oder_user',403);
  if(userAllowed&&requested)return requested;
  throw new ProjectRestoreError('daemon_host_erforderlich',403);
 }
 async function run(reply:FastifyReply,fn:()=>Promise<unknown>){
  try{return await fn();}catch(e){
   if(e instanceof ProjectRestoreError||e instanceof HostLoesenFehler)return reply.code(e.httpStatus).send({success:false,error:{code:e.code,message:e.message}});
   if(e instanceof VirtuellesProjektFehler)return reply.code(409).send({success:false,error:{code:e.code,message:e.message}});
   throw e;
  }
 }
 f.get('/api/project-init/restore/host-binding',(req,reply)=>run(reply,async()=>{
  const auth=await identity(req);if(!daemon(auth))throw new ProjectRestoreError('daemon_host_erforderlich',403);
  return {success:true,hostname:await service.daemonHost(auth.token_hash)};
 }));
 f.post<{Body:{hostname:string}}>('/api/project-init/restore/host-binding',(req,reply)=>run(reply,async()=>{
  const auth=await identity(req);if(!daemon(auth))throw new ProjectRestoreError('daemon_host_erforderlich',403);
  return {success:true,hostname:await service.bindDaemonHost(auth.token_hash,req.body?.hostname)};
 }));
 f.post<{Params:{project:string};Body:{hostname?:string}}>('/api/projects/:project/restore-existing',(req,reply)=>run(reply,async()=>{
  const auth=await identity(req),hostname=await host(auth,req.body?.hostname,true);
  const job=await service.enqueue(req.params.project,hostname,auth.token_hash,true);
  return {success:true,mode:'restore_existing',job_id:job.id,hostname};
 }));
 f.get<{Params:{project:string};Querystring:{hostname?:string}}>('/api/projects/:project/host-binding',(req,reply)=>run(reply,async()=>{
  const auth=await identity(req),hostname=await host(auth,req.query.hostname,true);
  return {success:true,project:req.params.project,hostname,bound:await service.binding(req.params.project,hostname)};
 }));
 f.delete<{Params:{project:string};Querystring:{hostname?:string}}>('/api/projects/:project/host-binding',(req,reply)=>run(reply,async()=>{
  const auth=await identity(req),hostname=await host(auth,req.query.hostname,true);
  await service.unbind(req.params.project,hostname);return {success:true,bound:false};
 }));
 // P9-T30: Tray "Von diesem PC entfernen" — Host-Bindung gezielt loesen (Vorschau Standard).
 // Daemon-/Tray-Zugang: nur der eigene, bestaetigte Host. Frei waehlbarer hostname nur fuer den
 // User (Web-UI-Sitzung, session ohne scope; wie user-post P10-T41). Access-/OAuth-Token und andere
 // Sitzungen -> 403. Der User-Kontext wird hier gesetzt; projektHostLoesen verlangt ihn bei 'tray'.
 f.post<{Params:{project:string};Body:{hostname?:string;vorschau?:boolean}}>('/api/projects/:project/host-loesen',(req,reply)=>run(reply,async()=>{
  const auth=await identity(req);
  const user=webUiUser(auth);
  if(!daemon(auth)&&!user)throw new ProjectRestoreError('nur_koordinator_oder_user',403);
  const hostname=await host(auth,req.body?.hostname,user);
  if(req.body?.vorschau!==undefined&&typeof req.body.vorschau!=='boolean')throw new ProjectRestoreError('vorschau_ungueltig',400);
  return await mitUserHerkunft(daemon(auth)?'tray':'web-ui-chat',()=>projektHostLoesen({project:req.params.project,hostname,agent:'tray:'+hostname,vorschau:req.body?.vorschau!==false,berechtigung:'tray'}));
 }));
 // P9-T30: Daemon holt host_loesen-Auftraege fuer seinen Host ab und entfernt den config.json-Eintrag.
 f.post('/api/project-init/host-loesen/claim',(req,reply)=>run(reply,async()=>{
  return {success:true,jobs:await claimHostLoesungen(await host(await identity(req)))};
 }));
 f.post<{Params:{id:string};Body:{status:'done'|'failed';message?:string;error?:string}}>('/api/project-init/host-loesen/:id/complete',(req,reply)=>run(reply,async()=>{
  await schliesseHostLoesung(req.params.id,await host(await identity(req)),req.body);return {success:true};
 }));
 f.post('/api/project-init/restore/claim',(req,reply)=>run(reply,async()=>{
  return {success:true,job:await service.claim(await host(await identity(req)))};
 }));
 f.post<{Params:{id:string};Body:{restore_lease:string}}>('/api/project-init/restore/:id/renew',(req,reply)=>run(reply,async()=>{
  await service.renew(req.params.id,await host(await identity(req)),req.body.restore_lease);return {success:true};
 }));
 f.post<{Params:{id:string};Body:{restore_lease:string;status:'done'|'failed';path?:string;error?:string}}>('/api/project-init/restore/:id/complete',(req,reply)=>run(reply,async()=>{
  if(!['done','failed'].includes(req.body?.status))throw new ProjectRestoreError('status_ungueltig',400);
  await service.complete(req.params.id,await host(await identity(req)),req.body.restore_lease,req.body);return {success:true};
 }));
 f.get<{Params:{project:string};Querystring:{cursor?:string;limit?:string}}>('/api/projects/:project/code/manifest',(req,reply)=>run(reply,async()=>{
  const hostname=await host(await identity(req));
  return {success:true,...await service.manifest(req.params.project,hostname,req.query.cursor,req.query.limit===undefined?undefined:Number(req.query.limit))};
 }));
 f.get<{Params:{project:string};Querystring:{manifest_id:string;pfad:string;sha256:string}}>('/api/projects/:project/code/bytes',(req,reply)=>run(reply,async()=>{
  const hostname=await host(await identity(req)),q=req.query;
  const bytes=await service.bytes(req.params.project,hostname,q.manifest_id,q.pfad,q.sha256);
  return reply.header('content-type','application/octet-stream').header('content-length',bytes.length).header('etag','"'+q.sha256+'"')
   .header('cache-control','no-store').header('x-content-type-options','nosniff').send(bytes);
 }));
}
