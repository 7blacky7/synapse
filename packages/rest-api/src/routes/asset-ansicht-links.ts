/**
 * P13-T33/A15: Ansicht-Links über HTTP.
 *
 * ÖFFENTLICH (einzige Auth-Ausnahme, auth-hook.ts → istOeffentlicherAnsichtPfad):
 *   GET /api/assets/ansicht/:token — kein HEAD (würde einmalige Links verbrauchen), keine Metadaten
 *   für unbekannte Tokens, Header no-store/nosniff/no-referrer/CSP, Rate-Limit je Client-IP.
 * GESCHÜTZT (Bearer wie alle /api-Routen, zusätzlich Nutzer-Ausweis geprüft):
 *   GET  /api/assets/ansicht-links?bereich=&ziel_ref=&id=&limit=   Metadaten, nie Token/URL
 *   POST /api/assets/ansicht-links/widerrufen  {bereich, ziel_ref, token_id?, id?, grund?}
 * Erzeugt werden Links ausschließlich über geschützte Tool-Aufrufe (A16), nicht über diese Routen.
 */
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {AnsichtLinkDienst,AnsichtLinkFehler,ansichtClientIp,ladeAnsichtLinkKonfiguration,standardAnsichtLinkDienst} from '@synapse/core';
import type {AnsichtAbruf,AnsichtLinkKonfiguration} from '@synapse/core';
import {validateToken} from '../services/auth.js';
import type {AuthTokenRow} from '../services/auth.js';

export interface AnsichtLinkRouteOptionen {
  dienst?:AnsichtLinkDienst;
  validateToken?:typeof validateToken;
  /** Test/Betrieb: Konfiguration explizit statt aus der Umgebung. */
  link?:AnsichtLinkKonfiguration;
}

const SICHERHEITS_HEADER:Readonly<Record<string,string>>={
  'Cache-Control':'no-store, max-age=0',
  'Pragma':'no-cache',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; sandbox",
  'X-Frame-Options':'DENY',
};

class NutzerFehler extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);}}

/** Nur Nutzer-Ausweise (access/session) verwalten Links; Daemon-/Compute-Ausweise nicht. */
async function nutzer(request:FastifyRequest,pruefe:typeof validateToken):Promise<AuthTokenRow>{
  const token=/^Bearer\s+(.+)$/i.exec(String(request.headers.authorization??''))?.[1]?.trim();
  if(!token)throw new NutzerFehler(401,'unauthorized','Bearer-Token fehlt.');
  const principal=await pruefe(token);
  if(!principal)throw new NutzerFehler(401,'unauthorized','Token ungültig oder abgelaufen.');
  if(principal.kind!=='access'&&principal.kind!=='session')throw new NutzerFehler(403,'token_nicht_erlaubt','Ansicht-Links verwaltet nur ein Nutzer-Ausweis.');
  return principal;
}

export function createAnsichtLinkRoutes(o:AnsichtLinkRouteOptionen={}):(f:FastifyInstance)=>Promise<void>{
  return async fastify=>{
    // Konfiguration beim Start prüfen; ein Fehler legt nur diese Routen still, nicht die API.
    let link:AnsichtLinkKonfiguration|null=o.link??o.dienst?.link??null,konfigFehler=false;
    if(!link){
      try{link=ladeAnsichtLinkKonfiguration();}
      catch(e){konfigFehler=true;console.error('[ansicht-link] Konfiguration ungültig, Ansicht-Links deaktiviert:',(e as Error).message);}
    }
    if(link?.basisFehler)console.warn('[ansicht-link] '+link.basisFehler+' Linkerzeugung wird abgewiesen.');
    const dienst=()=>o.dienst??standardAnsichtLinkDienst();
    const pruefe=o.validateToken??validateToken;

    fastify.route<{Params:{token:string}}>({
      method:'GET',url:'/api/assets/ansicht/:token',exposeHeadRoute:false,
      handler:async(request,reply)=>{
        for(const [k,v] of Object.entries(SICHERHEITS_HEADER))reply.header(k,v);
        if(konfigFehler||!link)return reply.code(503).send({success:false,error:{code:'nicht_verfuegbar'}});
        const meta={
          clientIp:ansichtClientIp(request.socket?.remoteAddress??request.ip,request.headers['cf-connecting-ip'],link.vertrauenswuerdigeProxies),
          userAgent:typeof request.headers['user-agent']==='string'?request.headers['user-agent']:null,
        };
        let r:AnsichtAbruf;
        try{r=await dienst().abrufen(request.params.token,meta);}
        catch{return reply.code(503).header('Retry-After','5').send({success:false,error:{code:'nicht_verfuegbar'}});}
        if(r.status===200&&r.art==='ansicht'){
          return reply.code(200).type('image/png').header('Content-Length',String(r.body.length))
            .header('Content-Disposition','inline').send(r.body);
        }
        if(r.status===200){
          return reply.code(200).type('application/octet-stream').header('Content-Length',String(r.groesse))
            .header('Content-Disposition','attachment').send(r.body);
        }
        if(r.retryAfter)reply.header('Retry-After',String(r.retryAfter));
        return reply.code(r.status).send({success:false,error:{code:r.code}});
      },
    });

    async function verwaltet(reply:FastifyReply,fn:()=>Promise<unknown>){
      reply.header('Cache-Control','no-store');
      try{return await fn();}catch(e){
        if(e instanceof NutzerFehler)return reply.code(e.status).send({success:false,error:{code:e.code,message:e.message}});
        if(e instanceof AnsichtLinkFehler)return reply.code(400).send({success:false,error:{code:e.code,message:e.message}});
        throw e;
      }
    }
    fastify.get<{Querystring:{bereich?:string;ziel_ref?:string;id?:string;limit?:string}}>('/api/assets/ansicht-links',async(request,reply)=>verwaltet(reply,async()=>{
      await nutzer(request,pruefe);
      const q=request.query;
      return {success:true,links:await dienst().liste({bereich:q.bereich,ziel_ref:q.ziel_ref,id:q.id,limit:q.limit===undefined?undefined:Number(q.limit)})};
    }));
    fastify.post<{Body:{bereich?:unknown;ziel_ref?:unknown;token_id?:unknown;id?:unknown;grund?:unknown}}>('/api/assets/ansicht-links/widerrufen',async(request,reply)=>verwaltet(reply,async()=>{
      const principal=await nutzer(request,pruefe);
      const b=request.body??{};
      return {success:true,...await dienst().widerrufen({bereich:b.bereich,ziel_ref:b.ziel_ref,token_id:b.token_id,id:b.id,grund:b.grund,
        akteur:'user:'+principal.token_hash.slice(0,12)})};
    }));
  };
}

export const ansichtLinkRoutes=createAnsichtLinkRoutes();
