/** A11: new asset conflict actions use the API; existing metadata actions keep their legacy path. */
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {baueToolErgebnis} from '@synapse/core';
export async function rufeAssetKonfliktApi(args:Record<string,unknown>,o:{url?:string;token?:string;fetchImpl?:typeof fetch;timeoutMs?:number}={}):Promise<Record<string,unknown>>{
 try{
  let cfg:Record<string,unknown>={};
  if((o.url===undefined&&!process.env.SYNAPSE_API_URL)||(o.token===undefined&&!process.env.SYNAPSE_API_TOKEN)){
   try{cfg=JSON.parse(await readFile(join(homedir(),'.synapse','file-watcher','config.json'),'utf8'));}catch{/* No implicit address or credentials. */}
  }
  const raw=o.url??process.env.SYNAPSE_API_URL??cfg.synapse_api_url,secret=o.token??process.env.SYNAPSE_API_TOKEN??cfg.synapse_api_token;
  if(typeof raw!=='string'||!raw||typeof secret!=='string'||!secret)throw Error('config');
  const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('url');
  const timeout=o.timeoutMs??Number(process.env.SYNAPSE_ASSET_API_TIMEOUT_MS??60000);
  if(!Number.isSafeInteger(timeout)||timeout<1)throw Error('timeout');
  const r=await(o.fetchImpl??fetch)(url.toString(),{method:'POST',redirect:'error',headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+secret},
   body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'asset_intel',arguments:args}}),signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw Error('api');
  const rpc=await r.json() as {result?:Record<string,unknown>;error?:unknown};
  if(rpc.error||!rpc.result||!Array.isArray(rpc.result.content))throw Error('response');return rpc.result;
 }catch{
  return baueToolErgebnis({success:false,action:args.action,project:args.project,beantwortet_von:'asset_intel',fehler:'asset_api_nicht_erreichbar',message:'Asset-API nicht erreichbar; API-Zugang prüfen.'},{tool:'asset_intel',strukturiert:true}) as unknown as Record<string,unknown>;
 }
}
