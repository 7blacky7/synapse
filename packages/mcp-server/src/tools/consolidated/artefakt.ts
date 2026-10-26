/** P22-T191: stdio transportiert Artefakt-Aufrufe zur API; keine lokale Datei-/DB-Implementierung. */
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ARTEFAKT_DEFINITION,baueToolErgebnis} from '@synapse/core';
import type {ConsolidatedTool} from './types.js';
export interface ArtefaktApiOptionen {url?:string;token?:string;fetchImpl?:typeof fetch;timeoutMs?:number}
export async function rufeArtefaktApi(args:Record<string,unknown>,o:ArtefaktApiOptionen={}):Promise<Record<string,unknown>>{
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
   body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'artefakt',arguments:args}}),signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw Error('api');
  const rpc=await r.json() as {result?:Record<string,unknown>;error?:unknown};
  if(rpc.error||!rpc.result||!Array.isArray(rpc.result.content))throw Error('response');
  return rpc.result;
 }catch{
  return baueToolErgebnis({success:false,action:args.action??null,project:args.project??null,beantwortet_von:'artefakt',fehler:'api_nicht_erreichbar',
   hinweis:'Artefakt-API-Zugang pruefen; es gibt keinen lokalen Datei-Fallback.'},{tool:'artefakt',strukturiert:true}) as unknown as Record<string,unknown>;
 }
}
/** stdio nutzt denselben API-Ueberlaufvertrag. */
export async function begrenzeStdioArtefaktAntwort<T extends {content:Array<{type:string;text?:string}>;isError?:boolean}>(antwort:T,args:Record<string,unknown>,tool:string,o:ArtefaktApiOptionen={}):Promise<T>{
 if(tool==='artefakt'||(args.artefakt_id&&args.action==='read'))return antwort;
 const block=antwort.content.find(x=>x.type==='text'&&typeof x.text==='string');
 if(!block?.text || Buffer.byteLength(block.text,'utf8')*2<1000)return antwort;
 // Ohne API-Freigabe gehen KEINE Tool-Nutzdaten an den Ueberlaufvertrag. Kein lokaler PG-Zugang.
 const status=await rufeArtefaktApi({action:'status',project:args.project,agent_kennung:args.agent_kennung??args.token??process.env.SYNAPSE_AGENT_TOKEN},o);
 let stand=status.structuredContent as Record<string,unknown>|undefined;
 if(!stand){try{stand=JSON.parse(String((status.content as Array<{text?:string}>)?.[0]?.text??''));}catch{return antwort;}}
 if(stand?.success!==true || !(stand.antwort_ueberlauf as {aktiv?:boolean}|undefined)?.aktiv)return antwort;
 let wert:unknown;try{wert=JSON.parse(block.text);}catch{wert=block.text;}
 const r=await rufeArtefaktApi({action:'tool_antwort',antwort:wert,tool_name:tool,tool_action:args.action,
 project:args.project,agent_kennung:args.agent_kennung??args.token??process.env.SYNAPSE_AGENT_TOKEN},o);
 let payload=r.structuredContent as Record<string,unknown>|undefined;
 if(!payload){try{payload=JSON.parse(String((r.content as Array<{text?:string}>)?.[0]?.text??''));}catch{return antwort;}}
 const neu=payload?.antwort as Record<string,unknown>|undefined;
 if(!neu?.ueberlauf)return antwort;
 const result=baueToolErgebnis(neu,{tool,strukturiert:true}) as unknown as T;
 return {...result,...(antwort.isError?{isError:true}:{}),content:[...result.content,...antwort.content.filter(x=>x.type!=='text')]};
}
export const artefaktTool:ConsolidatedTool={definition:ARTEFAKT_DEFINITION as unknown as Tool,handler:args=>rufeArtefaktApi(args)};
