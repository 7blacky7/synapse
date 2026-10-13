/** M4/A11: neue Asset-Schreib-/Restoreaktionen gehen auch bei stdio ausschließlich zur API. */
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {baueToolErgebnis} from '@synapse/core';
export async function rufeAssetApi(args:Record<string,unknown>,o:{url?:string;token?:string;fetchImpl?:typeof fetch;timeoutMs?:number}={}):Promise<Record<string,unknown>>{
 try{
  let cfg:Record<string,unknown>={};
  if((o.url===undefined&&!process.env.SYNAPSE_API_URL)||(o.token===undefined&&!process.env.SYNAPSE_API_TOKEN)){
   try{cfg=JSON.parse(await readFile(join(homedir(),'.synapse','file-watcher','config.json'),'utf8'));}catch{/* Keine implizite Zieladresse. */}
  }
  const raw=o.url??process.env.SYNAPSE_API_URL??cfg.synapse_api_url,secret=o.token??process.env.SYNAPSE_API_TOKEN??cfg.synapse_api_token;
  if(typeof raw!=='string'||!raw||typeof secret!=='string'||!secret)throw new Error('API-Konfiguration fehlt');
  const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('API-Adresse ungültig');
  const timeout=o.timeoutMs??60000;
  if(!Number.isSafeInteger(timeout)||timeout<1)throw new Error('API-Zeitlimit ungültig');
  const response=await(o.fetchImpl??fetch)(url.toString(),{method:'POST',headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+secret},
   body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'asset_intel',arguments:args}}),signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error('Asset-API-Aufruf fehlgeschlagen');
  const rpc=await response.json() as {result?:Record<string,unknown>;error?:unknown};
  if(rpc.error||!rpc.result||!Array.isArray(rpc.result.content))throw new Error('Ungültige Asset-API-Antwort');
  return rpc.result;
 }catch{
  return baueToolErgebnis({success:false,action:args.action??null,project:args.project??null,beantwortet_von:'asset_intel',fehler:'api_nicht_erreichbar',message:'Asset-API nicht erreichbar; API-Konfiguration prüfen.'},{tool:'asset_intel',strukturiert:true}) as unknown as Record<string,unknown>;
 }
}
