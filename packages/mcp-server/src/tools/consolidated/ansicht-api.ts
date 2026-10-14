/**
 * P13-T34/A16: asset_intel/code_intel MIT ansicht-Parameter laufen auch bei stdio ausschliesslich ueber
 * die API (kein lokaler PC-Leseweg). Die fertige MCP-Antwort der API (Textteil mit allen Hooks, danach
 * image-Bloecke {type:'image', mimeType, data}) wird wie bei reverse unveraendert durchgereicht - kein
 * JSON.stringify der content-Bloecke (das verwarf vorher die Bilder).
 */
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {baueToolErgebnis} from '@synapse/core';

export type AnsichtTool = 'asset_intel' | 'code_intel';
export interface AnsichtApiOptionen {url?:string;token?:string;fetchImpl?:typeof fetch;timeoutMs?:number}
export type AnsichtBlock = {type:'text';text:string} | {type:'image';data:string;mimeType:string};
/** Typalias (kein interface): muss zur indexierten ServerResult-Form des MCP-SDK passen. */
export type AnsichtApiAntwort = {content:AnsichtBlock[];structuredContent?:Record<string,unknown>;isError?:boolean};

/** Nur text- und image-Bloecke in der erwarteten Form; alles andere gilt als ungueltige Antwort. */
function istBlock(b:unknown):boolean{
  if(!b||typeof b!=='object')return false;
  const x=b as Record<string,unknown>;
  if(x.type==='text')return typeof x.text==='string';
  if(x.type==='image')return typeof x.data==='string'&&typeof x.mimeType==='string';
  return false;
}

export async function rufeAnsichtApi(tool:AnsichtTool,args:Record<string,unknown>,o:AnsichtApiOptionen={}):Promise<AnsichtApiAntwort>{
  try{
    let cfg:Record<string,unknown>={};
    if((o.url===undefined&&!process.env.SYNAPSE_API_URL)||(o.token===undefined&&!process.env.SYNAPSE_API_TOKEN)){
      try{cfg=JSON.parse(await readFile(join(homedir(),'.synapse','file-watcher','config.json'),'utf8'));}catch{/* Keine implizite Zieladresse. */}
    }
    const raw=o.url??process.env.SYNAPSE_API_URL??cfg.synapse_api_url,secret=o.token??process.env.SYNAPSE_API_TOKEN??cfg.synapse_api_token;
    if(typeof raw!=='string'||!raw||typeof secret!=='string'||!secret)throw new Error('API-Konfiguration fehlt');
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('API-Adresse ungueltig');
    const timeout=o.timeoutMs??60000;
    if(!Number.isSafeInteger(timeout)||timeout<1)throw new Error('API-Zeitlimit ungueltig');
    const response=await(o.fetchImpl??fetch)(url.toString(),{method:'POST',
      headers:{'content-type':'application/json',accept:'application/json',authorization:'Bearer '+secret},
      body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:tool,arguments:args}}),signal:AbortSignal.timeout(timeout)});
    if(!response.ok)throw new Error('Ansicht-API-Aufruf fehlgeschlagen');
    const rpc=await response.json() as {result?:unknown;error?:unknown};
    const result=rpc.result as AnsichtApiAntwort|undefined;
    if(rpc.error||!result||typeof result!=='object'||!Array.isArray(result.content)||result.content.length===0||!result.content.every(istBlock)){
      throw new Error('Ungueltige Ansicht-API-Antwort');
    }
    return result;
  }catch{
    const fehler=tool==='asset_intel'
      ?{success:false,action:args.action??null,project:args.project??null,beantwortet_von:'asset_intel',fehler:'api_nicht_erreichbar',message:'API fuer ansicht nicht erreichbar; API-Konfiguration pruefen.'}
      :{success:false,error:'api_nicht_erreichbar',message:'API fuer ansicht nicht erreichbar; API-Konfiguration pruefen.',project:args.project??null};
    return baueToolErgebnis(fehler,{tool,strukturiert:true}) as unknown as AnsichtApiAntwort;
  }
}
