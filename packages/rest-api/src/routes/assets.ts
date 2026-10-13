/** P13-T24/A6: additive Assetfamilie, gleicher API-Zugang, Binärstream statt JSON-ReadAll. */
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {AssetUploadKern,AssetUploadFehler,AssetSpeicherFehler,API_CONTRACT_HEADER,apiCapabilitiesForClient,isProjectEnabled} from '@synapse/core';
import type {AssetUploadSitzung,AssetUploadEingang,AssetUploadKontext,AssetDownloadRange} from '@synapse/core';
import {validateToken} from '../services/auth.js';
import type {AuthTokenRow} from '../services/auth.js';

export interface AssetRouteAbhaengigkeiten {
  upload?:AssetUploadKern;
  validateToken?:typeof validateToken;
  projektErlaubt?:(projekt:string,principal:AuthTokenRow)=>Promise<boolean>;
}
export function assetSitzungAntwort(s:AssetUploadSitzung){
  return {id:s.id,bereich:s.bereich,ziel_ref:s.ziel_ref,logischer_pfad:s.logischer_pfad,groesse:s.groesse,sha256:s.sha256,
    offset:s.offset,status:s.status,lease_bis:s.lease_bis,...(s.ergebnis?{asset_id:s.ergebnis.asset_id,revision:s.ergebnis.revision}:{})};
}
export function assetRange(header:string|undefined):AssetDownloadRange|undefined {
  if(header===undefined)return undefined;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if(!match||!match[1]&&!match[2])throw new AssetUploadFehler('range_ungueltig',416,'Genau ein gültiger Bytebereich erforderlich.');
  return total=>{
    if(total===0)throw new AssetUploadFehler('range_ungueltig',416,'Leere Datei hat keinen Bytebereich.');
    const number=(s:string)=>{const n=Number(s);if(!Number.isSafeInteger(n)||n<0)throw new AssetUploadFehler('range_ungueltig',416,'Ungültige Bereichszahl.');return n;};
    const offset=match[1]?number(match[1]):Math.max(0,total-number(match[2]));
    const end=match[1]?(match[2]?Math.min(total-1,number(match[2])):total-1):total-1;
    if(offset>=total||end<offset||!match[1]&&number(match[2])===0)throw new AssetUploadFehler('range_ungueltig',416,'Range außerhalb Datei.');
    return {offset,groesse:end-offset+1};
  };
}
export function createAssetsRoutes(o:AssetRouteAbhaengigkeiten={}):(f:FastifyInstance)=>Promise<void>{
  let upload=o.upload;
  const kern=()=>upload??=(new AssetUploadKern());
  async function kontext(request:FastifyRequest,projekt:string,schreiben=true):Promise<AssetUploadKontext>{
    const token=/^Bearer\s+(.+)$/i.exec(String(request.headers.authorization??''))?.[1]?.trim();
    if(!token)throw new AssetUploadFehler('unauthorized',401,'Bearer-Token fehlt.');
    const principal=await (o.validateToken??validateToken)(token);
    if(!principal)throw new AssetUploadFehler('unauthorized',401,'Token ungültig/abgelaufen.');
    const daemon=principal.kind==='service'&&(principal.scope==='daemon'||principal.scope?.startsWith('daemon:'));
    const user=principal.kind==='access'||principal.kind==='session';
    if(principal.scope?.startsWith('compute-node:')||(!daemon&&!user)||schreiben&&!daemon)
      throw new AssetUploadFehler('token_nicht_erlaubt',403,'Diese Operation braucht eine Daemon-Identität; Compute-Ausweise sind ausgeschlossen.');
    const capabilities=apiCapabilitiesForClient(request.headers[API_CONTRACT_HEADER]);
    if(!capabilities)throw new AssetUploadFehler('vertrag_erforderlich',426,'API-Vertrag Version1 erforderlich.');
    if(!capabilities.features.includes('asset_sync'))throw new AssetUploadFehler('asset_sync_deaktiviert',503,'Asset-Sync nicht aktiviert.');
    const allowed=await (o.projektErlaubt??(async p=>isProjectEnabled(p)))(projekt,principal);
    if(!allowed)throw new AssetUploadFehler('projekt_verboten',403,'Projekt fehlt oder ist nicht freigegeben.');
    const host_id=daemon?(principal.scope==='daemon'?'token:'+principal.token_hash:principal.scope!.slice(7)):'user:'+principal.token_hash;
    if(!host_id)throw new AssetUploadFehler('host_ungueltig',403,'Daemon-Hostbindung fehlt.');
    return {bereich:'projekt',ziel_ref:projekt,host_id};
  }
  async function run(reply:FastifyReply,fn:()=>Promise<unknown>){
    try{return await fn();}catch(e){
      if(e instanceof AssetUploadFehler)return reply.code(e.httpStatus).send({success:false,error:{code:e.code,message:e.message}});
      if(e instanceof AssetSpeicherFehler)return reply.code(400).send({success:false,error:{code:e.code,message:e.message}});
      throw e;
    }
  }
  return async fastify=>{
    // Nur dieses gekapselte Plugin nimmt rohe Chunks; bestehende JSONparser bleiben erhalten.
    fastify.addContentTypeParser('application/octet-stream',(request,payload,done)=>done(null,payload));
    const base='/api/projects/:projekt/assets';
    fastify.post<{Params:{projekt:string};Body:AssetUploadEingang}>(base+'/uploads',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt);
      if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new AssetUploadFehler('eingang_ungueltig',400,'Uploadmetadaten fehlen.');
      return {success:true,upload:assetSitzungAntwort(await kern().erstellen(c,req.body))};
    }));
    fastify.get<{Params:{projekt:string;id:string}}>(base+'/uploads/:id',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt);return {success:true,upload:assetSitzungAntwort(await kern().status(c,req.params.id))};
    }));
    fastify.put<{Params:{projekt:string;id:string};Querystring:{offset?:string}}>(base+'/uploads/:id/chunk',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt),raw=req.headers['content-length'];
      if(req.headers['content-type']?.split(';')[0]!=='application/octet-stream'||typeof raw!=='string'||!/^\d+$/.test(raw))
        throw new AssetUploadFehler('stream_erforderlich',400,'Binärstream mit Content-Length erforderlich.');
      const offset=Number(req.query.offset??req.headers['x-synapse-upload-offset']),groesse=Number(raw);
      if(!Number.isSafeInteger(offset)||offset<0)throw new AssetUploadFehler('offset_konflikt',409,'Bestätigter Offset erforderlich.');
      const source=req.body as AsyncIterable<Uint8Array>;
      if(!source||typeof source[Symbol.asyncIterator]!=='function')throw new AssetUploadFehler('stream_erforderlich',400,'Binärstream fehlt.');
      return {success:true,upload:assetSitzungAntwort(await kern().teil(c,req.params.id,offset,groesse,source))};
    }));
    fastify.post<{Params:{projekt:string;id:string}}>(base+'/uploads/:id/finalisieren',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt);return {success:true,upload:assetSitzungAntwort(await kern().finalisieren(c,req.params.id))};
    }));
    fastify.get<{Params:{projekt:string};Querystring:{asset_id?:string;pfad?:string;revision:string}}>(base+'/bytes',async(req,reply)=>run(reply,async()=>{
      const c=await kontext(req,req.params.projekt,false),result=await kern().bytes(c,req.query,assetRange(typeof req.headers.range==='string'?req.headers.range:undefined));
      reply.header('Content-Type','application/octet-stream').header('Content-Length',result.groesse).header('Accept-Ranges','bytes')
        .header('ETag','"'+result.sha256+'"').header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff')
        .header('Content-Disposition','attachment').header('x-synapse-asset-revision',result.revision);
      if(req.headers.range){reply.code(206);reply.header('Content-Range','bytes '+result.offset+'-'+(result.offset+result.groesse-1)+'/'+result.gesamt);}
      return reply.send(result.stream);
    }));
  };
}
export const assetsRoutes=createAssetsRoutes();
