/**
 * RV9 stdio hängt die gemeinsame Definition ein und leitet an die API weiter.
 * Keine eigene Bibliotheks-/Byte-/DB-Logik. Die API liefert bereits alle Hooks.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REVERSE_DEFINITION, baueReverseAntwort, baueToolErgebnis } from '@synapse/core';
import type { ConsolidatedTool } from './types.js';

export interface ReverseApiOptionen {url?:string;token?:string;fetchImpl?:typeof fetch;timeoutMs?:number}
export async function rufeReverseApi(args:Record<string,unknown>,optionen:ReverseApiOptionen={}):Promise<Record<string,unknown>> {
  try {
    let cfg:Record<string,unknown>={};
    if((optionen.url===undefined&&!process.env.SYNAPSE_API_URL)||(optionen.token===undefined&&!process.env.SYNAPSE_API_TOKEN)){
      try{cfg=JSON.parse(await readFile(join(homedir(),'.synapse','file-watcher','config.json'),'utf8'));}catch{/* Keine implizite Zieladresse. */}
    }
    const raw=optionen.url??process.env.SYNAPSE_API_URL??cfg.synapse_api_url;
    const secret=optionen.token??process.env.SYNAPSE_API_TOKEN??cfg.synapse_api_token;
    if(typeof raw!=='string'||!raw||typeof secret!=='string'||!secret)throw new Error('API-Konfiguration fehlt');
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('API-Adresse ungültig');
    const wait=typeof args.warten_sekunden==='number'?Math.min(50,Math.max(0,args.warten_sekunden)):0;
    const timeout=optionen.timeoutMs??Number(process.env.SYNAPSE_REVERSE_API_TIMEOUT_MS??60000);
    if(!Number.isSafeInteger(timeout)||timeout<1)throw new Error('API-Zeitlimit ungültig');
    const response=await (optionen.fetchImpl??fetch)(url.toString(),{method:'POST',
      headers:{'content-type':'application/json',accept:'application/json','authorization':'Bearer '+secret},
      body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'reverse',arguments:args}}),
      signal:AbortSignal.timeout(Math.max(timeout,wait*1000+5000))});
    if(response.status===401||response.status===403)return baueToolErgebnis(baueReverseAntwort(args,{},'keine_berechtigung'),{tool:'reverse',strukturiert:true}) as unknown as Record<string,unknown>;
    if(!response.ok)throw new Error('API nicht erreichbar');
    const rpc=await response.json() as {result?:unknown;error?:unknown};
    if(rpc.error||!rpc.result||typeof rpc.result!=='object'||!Array.isArray((rpc.result as {content?:unknown}).content))throw new Error('API-Antwort ungültig');
    return rpc.result as Record<string,unknown>;
  }catch{
    return baueToolErgebnis(baueReverseAntwort(args,{message:'Reverse-API nicht erreichbar; API-Zugang und Prozesskonfiguration prüfen.'},'werkzeug_fehler'),{tool:'reverse',strukturiert:true}) as unknown as Record<string,unknown>;
  }
}
export const reverseTool:ConsolidatedTool={
  definition:REVERSE_DEFINITION as unknown as Tool,
  handler:args=>rufeReverseApi(args),
};
