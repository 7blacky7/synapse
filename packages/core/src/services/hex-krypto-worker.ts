/** P21-T15: feste native Verfahren, eigener terminierbarer Worker; keine Skripte oder Dateizugriffe. */
import {createDecipheriv,type CipherGCMTypes,type DecipherGCM} from 'node:crypto';
import {inflateSync,inflateRawSync} from 'node:zlib';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
export interface HexKryptoAuftrag {verfahren:string;bytes:Uint8Array;schluessel?:Uint8Array;parameter:Record<string,unknown>;maxOutput:number}
export interface HexKryptoGrenzen {ramBytes:number;laufzeitMs:number;signal?:AbortSignal}
const MARKE='synapse-hex-krypto-v1';
/** Nur auf geschlossene Fehlercodes abbilden; native Fehler koennen Daten enthalten. */
function code(e:unknown):string{return e instanceof Error&&(e.message==='budget_ueberschritten'||('code' in e&&e.code==='ERR_BUFFER_TOO_LARGE'))?'budget_ueberschritten':'entschluesselung_fehlgeschlagen';}
function transformiere(a:HexKryptoAuftrag):Buffer{
 const b=Buffer.from(a.bytes),k=Buffer.from(a.schluessel??[]),p=a.parameter;let out:Buffer;
 try{
  if(a.verfahren==='xor'||a.verfahren==='xor_rolling'){
   if(!k.length)throw Error();
   out=Buffer.alloc(b.length);
   const schritt=Number(p.schritt??0),phase=Number(p.phase??0);
   for(let i=0;i<b.length;i++)out[i]=b[i]^((k[(i+phase)%k.length]+(a.verfahren==='xor_rolling'?i*schritt:0))&255);
  }else if(a.verfahren==='zlib'||a.verfahren==='deflate'){
   out=(a.verfahren==='zlib'?inflateSync:inflateRawSync)(b,{maxOutputLength:a.maxOutput});
  }else{
   const modus=a.verfahren.slice(4),iv=Buffer.from(String(p.iv),'hex');
   const d=modus==='gcm'?createDecipheriv(('aes-'+(k.length*8)+'-gcm') as CipherGCMTypes,k,iv,{authTagLength:Buffer.from(String(p.tag),'hex').length}):createDecipheriv('aes-'+(k.length*8)+'-'+modus,k,iv);
   if(modus==='gcm'){(d as DecipherGCM).setAuthTag(Buffer.from(String(p.tag),'hex'));if(p.aad!==undefined)(d as DecipherGCM).setAAD(Buffer.from(String(p.aad),'hex'));}
   if(modus==='cbc')d.setAutoPadding(p.padding==='pkcs7');
   let teil:Buffer|undefined;
   try{teil=d.update(b);const ende=d.final();try{out=Buffer.concat([teil,ende]);}finally{ende.fill(0);}}finally{teil?.fill(0);}
  }
  if(out.length>a.maxOutput){out.fill(0);throw Error('budget_ueberschritten');}
  return out;
 }finally{k.fill(0);b.fill(0);}
}
if(!isMainThread&&workerData?.marke===MARKE&&parentPort){
 parentPort.once('message',(a:HexKryptoAuftrag)=>{
  try{const out=transformiere(a);try{parentPort!.postMessage({ok:true,bytes:out});}finally{out.fill(0);}}
  catch(e){parentPort!.postMessage({ok:false,code:code(e)});}
  finally{a.schluessel?.fill(0);a.bytes.fill(0);parentPort!.close();}
 });
}
/** Await terminate in allen Pfaden: eine abgelaufene Uhr allein ist kein physischer Abschluss. */
export async function starteHexKryptoWorker(a:HexKryptoAuftrag,g:HexKryptoGrenzen):Promise<Buffer>{
 if(g.signal?.aborted)throw Error('zeitlimit');
 const w=new Worker(new URL(import.meta.url),{workerData:{marke:MARKE},env:{},execArgv:[],
  resourceLimits:{maxOldGenerationSizeMb:Math.max(1,Math.floor(g.ramBytes/1048576))},stdout:true,stderr:true});
 w.stdout?.resume();w.stderr?.resume();
 let timer:NodeJS.Timeout|undefined,abort:()=>void=()=>{};
 try{return await new Promise<Buffer>((resolve,reject)=>{
  let fertig=false;
  const ende=(err:string|null,b?:Uint8Array)=>{if(fertig)return;fertig=true;err?reject(Error(err)):resolve(Buffer.from(b!));};
  abort=()=>ende('zeitlimit');g.signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(abort,g.laufzeitMs);
  w.once('message',(r:{ok:boolean;bytes?:Uint8Array;code?:string})=>ende(r.ok&&r.bytes?null:(r.code==='budget_ueberschritten'?r.code:'entschluesselung_fehlgeschlagen'),r.bytes));
  w.once('error',()=>ende('entschluesselung_fehlgeschlagen'));
  w.once('exit',()=>ende('entschluesselung_fehlgeschlagen'));
  if(g.signal?.aborted)abort();else w.postMessage(a);
 });}finally{if(timer)clearTimeout(timer);g.signal?.removeEventListener('abort',abort);await w.terminate();}
}
