/** P10-T33: gemeinsamer Shell-Kontext, die Regeln selbst liegen in env-maske (P15-T41). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getPool} from '../db/client.js';
import {getProjectRoot} from './project-registry.js';
import {maskiereShellText,shellGeheimWerte,maskiereMcpJson} from './env-maske.js';
export {maskiereShellText} from './env-maske.js';

export function leseShellWerteVomFs(root?: string): string[] {
  const werte=new Set<string>();
  const lese=(file: string)=>{
    try {
      const text=fs.readFileSync(file,'utf8');
      for(const wert of shellGeheimWerte(path.basename(file).startsWith('.mcp.json')?'':text,
        path.basename(file).startsWith('.mcp.json')?text:'')) {
        werte.add(wert);
        const kodiert=encodeURIComponent(wert);if(kodiert!==wert)werte.add(kodiert);
        const json=JSON.stringify(wert).slice(1,-1);if(json!==wert)werte.add(json);
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Secret-Quelle nicht lesbar; Shell-Ausgabe wird nicht freigegeben');}
  };
  lese(process.env.SYNAPSE_SECRETS_ENV??path.join(os.homedir(),'.config','synapse','secrets.env'));
  if(root) {
    const walk=(dir: string)=>{
      for(const f of fs.readdirSync(dir,{withFileTypes:true})) {
        if(f.isDirectory() && !['.git','node_modules','dist','.synapse'].includes(f.name))walk(path.join(dir,f.name));
        else if(f.isFile() && (/^\.env(?:\.|$)/.test(f.name)||/^\.mcp\.json(?:\.|$)/.test(f.name)||f.name==='secrets.env'))lese(path.join(dir,f.name));
      }
    };
    walk(root);
  }
  for(const [name,value]of Object.entries(process.env))if(value && !/^(?:PWD|OLDPWD|SYNAPSE_SECRETS_ENV)$/.test(name) && !/(?:_PATH|_FILE)$/.test(name) && /(?:key|token|secret|password|pass|pwd|auth|credential)/i.test(name))werte.add(value);
  return [...werte];
}
export async function ladeShellWerte(project?: string, optionen: {projektFs?:boolean} = {}): Promise<string[]> {
  const root=project && optionen.projektFs!==false?await getProjectRoot(project):null;
  const werte=new Set(leseShellWerteVomFs(root && fs.existsSync(root)?root:undefined));
  if(project) {
    const rows=(await getPool().query<{file_path:string;content:string}>(
      "SELECT file_path,content FROM code_files WHERE project=$1 AND (file_path ~ '(^|/)\\.env(\\.[^/]*)?$' OR file_path ~ '(^|/)\\.mcp\\.json(\\.[^/]*)?$' OR file_path ~ '(^|/)secrets\\.env$')",[project])).rows;
    for(const row of rows)for(const value of shellGeheimWerte(row.file_path.split('/').pop()?.startsWith('.mcp.json')?'':row.content??'',
      row.file_path.split('/').pop()?.startsWith('.mcp.json')?row.content??'':''))werte.add(value);
  }
  return [...werte];
}
export function maskiereShellDaten<T>(daten:T,werte:readonly string[],steuerdaten=false): {daten:T;maskiert:number} {
  let maskiert=0;
  const control=new Set(['id','project','status','stream_id','exit_code','success','count','found','action','agent_id','agentId','tool','tool_name','source','ok','duration_ms','durationMs']);
  const payload=new Set(['tail','output','new_lines','stderr_tail','stdout','stderr','result','result_preview','args_preview','argsPreview','message','error']);
  const walk=(wert:unknown,logdaten=!steuerdaten):unknown=>{
    if(typeof wert==='string'){
      if(/^\s*[\[{]/.test(wert))try {
        const parsed=JSON.parse(wert),vorher=maskiert,neu=walk(parsed,logdaten);
        if(maskiert!==vorher)return JSON.stringify(neu);
        return wert;
      }catch { /* freie Logzeile statt JSON */ }
      const direkt=maskiereShellText(wert,werte);maskiert+=direkt.maskiert;
      return direkt.text;
    }
    if(Array.isArray(wert))return wert.map(w=>walk(w,logdaten));
    if(wert && typeof wert==='object' && !(wert instanceof Date))return Object.fromEntries(Object.entries(wert).map(([k,v])=>{
      if(!logdaten && control.has(k))return [k,v];
      const original=JSON.stringify({[k]:v}),safe=maskiereMcpJson(original,true);
      if(safe!==original)try {maskiert+=(safe.match(/\[WERT\]/g)??[]).length-(original.match(/\[WERT\]/g)??[]).length;return [k,JSON.parse(safe)[k]];}catch {/* normales Feld */}
      return [k,walk(v,logdaten||payload.has(k))];
    }));
    return wert;
  };
  return {daten:walk(daten) as T,maskiert};
}
export async function maskiereShellAntwort<T>(project:string|undefined,daten:T):Promise<T> {
  if(shellSichtUnmaskiert())return daten;
  const projekte=new Set<string>();
  const sammle=(v:unknown):void=>{
    if(typeof v==='string' && /^\s*[\[{]/.test(v)){try{sammle(JSON.parse(v));}catch{/* freie Logzeile, kein Projekt-Metadatum */}return;}
    if(Array.isArray(v)){v.forEach(sammle);return;}
    if(v && typeof v==='object'){
      const p=(v as Record<string,unknown>).project;if(typeof p==='string')projekte.add(p);
      Object.values(v).forEach(sammle);
    }
  };
  if(project)projekte.add(project);else sammle(daten);
  const bekannte=new Set<string>();
  if(!projekte.size)for(const value of await ladeShellWerte())bekannte.add(value);
  else for(const p of projekte)for(const value of await ladeShellWerte(p))bekannte.add(value);
  const r=maskiereShellDaten(daten,[...bekannte],true);
  return r.maskiert && r.daten && typeof r.daten==='object' && !Array.isArray(r.daten)
    ? {...r.daten,maskiert:r.maskiert} : r.daten;
}
/** Schreibschutz immer aktiv: ein Anzeige-Override darf die Persistenz nicht entmaskieren. */
export async function maskiereShellVorSpeichern<T>(project:string|undefined,daten:T):Promise<T> {
  const safe=await sicht.run(false,()=>maskiereShellAntwort(project,daten));
  if(daten && typeof daten==='object' && !Array.isArray(daten) && safe && typeof safe==='object') {
    // Steuerdaten sind keine Ausgabe: insbesondere Status/Projekt duerfen vor INSERT nicht veraendert werden.
    const original=daten as Record<string,unknown>,out={...safe} as Record<string,unknown>;
    for(const key of ['id','project','agent_id','agentId','source','tool','action','status','exit_code','ok','durationMs','stream_id','cwd_relative','command','timeout_ms','tail_lines'])
      if(key in original)out[key]=original[key];
    return out as T;
  }
  return safe;
}

import {AsyncLocalStorage} from 'node:async_hooks';
import {logToolCall} from './tool-call-log.js';
const sicht=new AsyncLocalStorage<boolean>();
export function shellSichtUnmaskiert():boolean{return sicht.getStore()===true;}
/** Anzeige-Override mit vorhandener Namenstreue, Speicherung bleibt unabhaengig davon geschuetzt. */
export async function mitShellAusgabe<T>(args:Record<string,unknown>,lauf:()=>Promise<T>):Promise<T> {
  let project=typeof args.project==='string'?args.project:undefined;
  if(!project && typeof args.stream_id==='string' && /^[a-f0-9]{16}$/i.test(args.stream_id))try {
    const meta=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.synapse','shell-streams',args.stream_id+'.meta.json'),'utf8'));
    if(typeof meta.project==='string')project=meta.project;
  }catch {/* unbekannter Stream wird vom bestehenden Handler gemeldet */}
  if(args.maskierung===false){
    const actor=String(args.agent_id??process.env.SYNAPSE_AGENT_NAME??'');
    if(!/^(koordinator|coordinator|user)$/i.test(actor))throw new Error('Maskierung abschalten darf nur Koordinator/User');
    if(typeof args.grund!=='string'||args.grund.trim().length<10)throw new Error('Maskierung abschalten erfordert einen Grund (mindestens 10 Zeichen)');
    await logToolCall({project,agentId:actor,tool:'shell',action:'maskierung_aus',argsPreview:JSON.stringify({grund:args.grund,action:args.action,id:args.id}),ok:true});
    const antwort=await sicht.run(true,lauf);
    return antwort && typeof antwort==='object' && !Array.isArray(antwort)
      ? {...antwort,maskierung_audit:{agent_id:actor,grund:maskiereShellText(args.grund).text}} : antwort;
  }
  return maskiereShellAntwort(project,await lauf());
}

/** Ausschliesslich zaehlen, keine Altzeile bereinigen. Aktuelle bekannte Werte + gemeinsame Muster. */
export async function zaehleShellSecretBestand(project?:string):Promise<Record<string,number>> {
  const pool=getPool(), werte=new Map<string,readonly string[]>(), zaehler:Record<string,number>={jobs:0,tool_calls:0,gepruefte_jobs:0,gepruefte_tool_calls:0};
  for(const table of ['shell_jobs','tool_calls']){
    const client=await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const where=project?' AND project=$1':'';
      await client.query('DECLARE shell_masken_bestand NO SCROLL CURSOR FOR SELECT project,'+
        (table==='shell_jobs'?'output,tail,message,error':'result,args_preview,error')+' FROM '+table+
        (table==='tool_calls'?" WHERE tool_name='shell'"+where:project?' WHERE project=$1':''),
        project?[project]:[]);
      while(true){
        const rows=(await client.query('FETCH FORWARD 300 FROM shell_masken_bestand')).rows;if(!rows.length)break;
        for(const row of rows){
          const p=String(row.project??'');if(!werte.has(p))werte.set(p,await ladeShellWerte(p||undefined,{projektFs:p==='synapse'}));
          if(maskiereShellDaten(row,werte.get(p)!).maskiert)zaehler[table==='shell_jobs'?'jobs':'tool_calls']++;
          zaehler[table==='shell_jobs'?'gepruefte_jobs':'gepruefte_tool_calls']++;
        }
      }
      await client.query('ROLLBACK');
    }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
  }
  return zaehler;
}
