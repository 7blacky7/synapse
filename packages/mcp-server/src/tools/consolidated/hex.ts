/** P21: stdio transportiert Hex-Aufrufe zur API; keine lokale Byte-/DB-Implementierung. */
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HEX_DEFINITION,baueToolErgebnis} from '@synapse/core';
import type {ConsolidatedTool} from './types.js';
export interface HexApiOptionen {url?:string;token?:string;fetchImpl?:typeof fetch;timeoutMs?:number}
export async function rufeHexApi(args:Record<string,unknown>,o:HexApiOptionen={}):Promise<Record<string,unknown>>{
 try{
  let cfg:Record<string,unknown>={};
  if((o.url===undefined&&!process.env.SYNAPSE_API_URL)||(o.token===undefined&&!process.env.SYNAPSE_API_TOKEN)){
   try{cfg=JSON.parse(await readFile(join(homedir(),'.synapse','file-watcher','config.json'),'utf8'));}catch{/* Kein implizites Ziel. */}
  }
  const raw=o.url??process.env.SYNAPSE_API_URL??cfg.synapse_api_url,secret=o.token??process.env.SYNAPSE_API_TOKEN??cfg.synapse_api_token;
  if(typeof raw!=='string'||!raw||typeof secret!=='string'||!secret)throw Error('config');
  const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('url');
  // Infrastruktur-Transportdeadline wie Reverse; fachliche Laufzeit/Budgets kommen ausschliesslich aus PG.
  const timeout=o.timeoutMs??60000;if(!Number.isSafeInteger(timeout)||timeout<1)throw Error('timeout');
  const r=await(o.fetchImpl??fetch)(url.toString(),{method:'POST',redirect:'error',
   headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+secret},
   body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'hex',arguments:args}}),signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw Error('api');
  const rpc=await r.json() as {result?:Record<string,unknown>;error?:unknown};
  if(rpc.error||!rpc.result||!Array.isArray(rpc.result.content))throw Error('response');
  return rpc.result;
 }catch{
  return baueToolErgebnis({success:false,action:args.action??null,project:args.project??null,beantwortet_von:'hex',fehler:'api_nicht_erreichbar',
   hinweis:'Hex-API-Zugang pruefen; es gibt keinen lokalen Byte-Fallback.'},{tool:'hex',strukturiert:true}) as unknown as Record<string,unknown>;
 }
}
export const hexTool:ConsolidatedTool={definition:HEX_DEFINITION as unknown as Tool,handler:args=>rufeHexApi(args)};
