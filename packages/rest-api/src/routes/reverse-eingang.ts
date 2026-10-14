/** RV5: additive Reverse-Routen auf API-Vertrag1, keine Rückspiegelung zum PC. */
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {reverseEingang,AssetUploadFehler,AssetSpeicherFehler,ProjectRestoreService,apiCapabilitiesForClient,API_CONTRACT_HEADER} from '@synapse/core';
import type {ReverseEingang,ReverseFundDatei,ReverseAbmeldung,AssetUploadKontext} from '@synapse/core';
import {validateToken} from '../services/auth.js';
import {assetSitzungAntwort} from './assets.js';
export function createReverseEingangRoutes(o:{eingang?:ReverseEingang;validateToken?:typeof validateToken;daemonHost?:(tokenHash:string)=>Promise<string|null>}={}){
 const kern=()=>o.eingang??reverseEingang();
 async function host(req:FastifyRequest,erwartet?:string){
  const bearer=/^Bearer\s+(.+)$/i.exec(String(req.headers.authorization??''))?.[1]?.trim();
  if(!bearer)throw new AssetUploadFehler('unauthorized',401,'Bearer-Token fehlt.');
  const p=await(o.validateToken??validateToken)(bearer);
  if(!p)throw new AssetUploadFehler('unauthorized',401,'Token ungültig.');
  if(p.kind!=='service'||!(p.scope==='daemon'||p.scope?.startsWith('daemon:')))throw new AssetUploadFehler('token_nicht_erlaubt',403,'Daemon-Ausweis erforderlich.');
  const c=apiCapabilitiesForClient(req.headers[API_CONTRACT_HEADER]);
  if(!c)throw new AssetUploadFehler('vertrag_erforderlich',426,'API-Vertrag1 erforderlich.');
  if(!c.features.includes('reverse_bibliothek'))throw new AssetUploadFehler('deaktiviert',503,'Reverse-Bibliothek nicht freigegeben.');
  const h=await(o.daemonHost??(hash=>new ProjectRestoreService().daemonHost(hash)))(p.token_hash);
  if(!h)throw new AssetUploadFehler('daemon_host_nicht_gebunden',403,'Explizite Daemon-Hostbindung fehlt.');
  if(erwartet!==undefined&&erwartet!==h)throw new AssetUploadFehler('host_ungueltig',403,'Hostbindung abweichend.');
  return h;
 }
 async function ctx(req:FastifyRequest,rid:string):Promise<AssetUploadKontext>{return {bereich:'reverse',ziel_ref:rid,host_id:await host(req)};}
 async function run(reply:FastifyReply,fn:()=>Promise<unknown>){try{return await fn();}catch(e){
  if(e instanceof AssetUploadFehler)return reply.code(e.httpStatus).send({success:false,error:{code:e.code,message:e.message}});
  if(e instanceof AssetSpeicherFehler)return reply.code(e.code==='hash_falsch'||e.code==='konflikt'?409:400).send({success:false,error:{code:e.code,message:e.message}});
  throw e;
 }}
 return async(fastify:FastifyInstance)=>{
  fastify.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
  fastify.post<{Body:{host?:string;dateien:ReverseFundDatei[]}}>('/api/reverse/fundstellen',async(req,reply)=>run(reply,async()=>{
   const h=await host(req,req.body?.host);return {success:true,...await kern().fundstellen(h,req.body?.dateien)};
  }));
  fastify.get<{Querystring:{host?:string;cursor?:string;limit?:string}}>('/api/reverse/fundstellen',async(req,reply)=>run(reply,async()=>{
   const h=await host(req,req.query.host);return {success:true,...await kern().status(h,{cursor:req.query.cursor,limit:req.query.limit===undefined?undefined:Number(req.query.limit)})};
  }));
  // RV6: Policy für den Bibliotheks-Watcher des Daemons (gleicher Gate/Hostbindung).
  fastify.get<{Querystring:{host?:string}}>('/api/reverse/sync-optionen',async(req,reply)=>run(reply,async()=>{
   const h=await host(req,req.query.host);return {success:true,contractVersion:1,...kern().syncOptionen(h)};
  }));
  // RV6: lokal gelöscht/verschoben melden; das Original bleibt in der Bibliothek.
  fastify.post<{Body:{host?:string;dateien:ReverseAbmeldung[]}}>('/api/reverse/fundstellen/abmelden',async(req,reply)=>run(reply,async()=>{
   const h=await host(req,req.body?.host);return {success:true,...await kern().abmelden(h,req.body?.dateien)};
  }));
  // RV6: Hinweis je eigener Fundstelle aus-/einblenden.
  fastify.post<{Body:{host?:string;rel_pfad:string;ausblenden:boolean}}>('/api/reverse/fundstellen/hinweis',async(req,reply)=>run(reply,async()=>{
   const h=await host(req,req.body?.host);return {success:true,...await kern().hinweis(h,req.body?.rel_pfad,req.body?.ausblenden)};
  }));
  // RV6: gesichertes Original einer eigenen Fundstelle zurückholen (Binärstream, optional ab offset).
  fastify.get<{Querystring:{host?:string;rel_pfad?:string;offset?:string}}>('/api/reverse/fundstellen/original',async(req,reply)=>run(reply,async()=>{
   const h=await host(req,req.query.host);
   if(typeof req.query.rel_pfad!=='string'||!req.query.rel_pfad)throw new AssetUploadFehler('eingang_ungueltig',400,'rel_pfad erforderlich.');
   const offset=req.query.offset===undefined?0:/^\d+$/.test(req.query.offset)?Number(req.query.offset):NaN;
   if(!Number.isSafeInteger(offset))throw new AssetUploadFehler('range_ungueltig',416,'offset ungültig.');
   const o2=await kern().original(h,req.query.rel_pfad,offset);
   return reply.code(200).header('content-type','application/octet-stream').header('content-length',String(o2.laenge))
    .header('x-synapse-sha256',o2.sha256).header('x-synapse-groesse',String(o2.groesse)).header('x-synapse-offset',String(o2.offset)).send(o2.stream);
  }));
  const base='/api/reverse/:reverse_id/uploads/:id';
  fastify.get<{Params:{reverse_id:string;id:string}}>(base,async(req,reply)=>run(reply,async()=>({success:true,upload:assetSitzungAntwort(await kern().upload.status(await ctx(req,req.params.reverse_id),req.params.id))})));
  fastify.put<{Params:{reverse_id:string;id:string};Querystring:{offset?:string}}>(base+'/chunk',async(req,reply)=>run(reply,async()=>{
   const c=await ctx(req,req.params.reverse_id),length=req.headers['content-length'],offset=Number(req.query.offset??req.headers['x-synapse-upload-offset']);
   if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream'||typeof length!=='string'||!/^\d+$/.test(length)||!Number.isSafeInteger(offset)||offset<0)throw new AssetUploadFehler('stream_erforderlich',400,'Binärstream, Content-Length und Offset erforderlich.');
   const source=req.body as AsyncIterable<Uint8Array>;if(!source||typeof source[Symbol.asyncIterator]!=='function')throw new AssetUploadFehler('stream_erforderlich',400,'Binärstream fehlt.');
   return {success:true,upload:assetSitzungAntwort(await kern().upload.teil(c,req.params.id,offset,Number(length),source))};
  }));
  fastify.post<{Params:{reverse_id:string;id:string}}>(base+'/finalisieren',async(req,reply)=>run(reply,async()=>({success:true,upload:assetSitzungAntwort(await kern().finalisieren(await ctx(req,req.params.reverse_id),req.params.id))})));
 };
}
export const reverseEingangRoutes=createReverseEingangRoutes();
