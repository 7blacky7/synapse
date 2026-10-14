/** A8: shared configured API access; binary bodies recreated for transport/5xx fallback only. */
import {API_CONTRACT_HEADER,API_CONTRACT_VERSION} from '@synapse/core';
import {apiBasenAusConfig} from './api-adressen.js';
import {leseApiZugang} from './skills-proxy.js';

export class AssetApiFehler extends Error {
 constructor(readonly status:number,readonly code:string,message:string){super(message);this.name='AssetApiFehler';}
 get wiederholbar(){return this.status===0||this.status>=500||this.status===408||this.status===429;}
}
export interface AssetApiAufruf {
 method?:string; headers?:Record<string,string>; body?:()=>NonNullable<RequestInit['body']>|AsyncIterable<Uint8Array>|undefined; timeoutMs?:number; signal?:AbortSignal;
}
export class AssetApiTransport {
 constructor(private readonly fetcher:typeof fetch=fetch,private readonly zugang=()=>{
  const a=leseApiZugang();
  return {token:a.token,basen:apiBasenAusConfig()};
 }){}
 async request(pfad:string,o:AssetApiAufruf={}):Promise<Response>{
  if(!pfad.startsWith('/api/')||pfad.startsWith('//')||/[\\\r\n]/.test(pfad))throw new AssetApiFehler(400,'pfad_ungueltig','API-Pfad ungültig.');
  const access=this.zugang();
  if(!access.token)throw new AssetApiFehler(401,'anmeldung_fehlt','Daemon-Anmeldung fehlt.');
  const bases=[...new Set(access.basen.map(s=>{
   const u=new URL(s);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new AssetApiFehler(400,'basis_ungueltig','API-Basis ungültig.');
   return s.replace(/\/+$/,'');
  }))];
  let last:unknown;
  for(let i=0;i<bases.length;i++){
   if(o.signal?.aborted)throw o.signal.reason;
   const controller=new AbortController(),abort=()=>controller.abort(o.signal?.reason);
   o.signal?.addEventListener('abort',abort,{once:true});
   const timer=setTimeout(()=>controller.abort(),o.timeoutMs??60_000);
   const cleanup=()=>{clearTimeout(timer);o.signal?.removeEventListener('abort',abort);};
   try{
    const body=o.body?.();
    const init:RequestInit&{duplex?:'half'}={method:o.method??'GET',redirect:'manual',signal:controller.signal,
     headers:{authorization:'Bearer '+access.token,[API_CONTRACT_HEADER]:String(API_CONTRACT_VERSION),...o.headers},
     ...(body===undefined?{}:{body:body as NonNullable<RequestInit['body']>,duplex:'half'})};
    const res=await this.fetcher(bases[i]+pfad,init);
    if(res.status>=500&&i+1<bases.length){await res.body?.cancel();cleanup();continue;}
    if(!res.ok){
     let error:unknown;try{error=await res.json();}catch{error={error:{code:'api_http',message:'HTTP '+res.status}};}
     const e=error as {error?:{code?:string;message?:string}|string};
     throw new AssetApiFehler(res.status,typeof e?.error==='object'?e.error.code??'api_http':'api_http',
      typeof e?.error==='object'?e.error.message??'HTTP '+res.status:'HTTP '+res.status);
    }
    // Keep the timeout bound to response consumption, including streamed downloads.
    if(!res.body){cleanup();return res;}
    const reader=res.body.getReader();
    const stream=new ReadableStream<Uint8Array>({
     async pull(c){try{const r=await reader.read();if(r.done){cleanup();c.close();}else c.enqueue(r.value);}catch(e){cleanup();c.error(e);}},
     async cancel(reason){cleanup();await reader.cancel(reason);},
    });
    return new Response(stream,{status:res.status,statusText:res.statusText,headers:res.headers});
   }catch(e){
    cleanup();last=e;
    if(e instanceof AssetApiFehler&&(e.status<500||i+1===bases.length))throw e;
    if(o.signal?.aborted)throw e;
   }
  }
  throw last instanceof AssetApiFehler?last:new AssetApiFehler(0,'transport_fehler','API-Transport nicht erreichbar.');
 }
 async json<T=Record<string,unknown>>(pfad:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal):Promise<T>{
  const res=await this.request(pfad,{method,signal,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:()=>JSON.stringify(body)})});
  return await res.json() as T;
 }
}
