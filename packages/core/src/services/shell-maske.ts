/** P10-T33: gemeinsamer Shell-Kontext, die Regeln selbst liegen in env-maske (P15-T41). */
import fs from 'node:fs';
import {shellNulDaten} from './shell-ausgabe-nul.js';
import os from 'node:os';
import path from 'node:path';
import {getPool} from '../db/client.js';
import {darfKoordinatorOderUser}from'./rollen-pruefung.js';
import {resolveAgentId} from './agent-id-resolver.js';
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
  for(const [name,value]of Object.entries(process.env)){
    if(!value || /^(?:PWD|OLDPWD|SYNAPSE_SECRETS_ENV)$/.test(name) || /(?:_PATH|_FILE)$/.test(name))continue;
    for(const wert of shellGeheimWerte(name+'='+value))werte.add(wert);
  }
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
      // Nur unsere typisierten SHA256-Steuerdaten; niemals stdout/tail/Log-JSON.
      if(!logdaten && ['befehl_hash','lage_hash','regelversion','hash'].includes(k) && typeof v==='string' && /^[a-f0-9]{64}$/i.test(v))return [k,v];
      const original=JSON.stringify({[k]:v}),safe=maskiereMcpJson(original,true);
      if(safe!==original)try {maskiert+=(safe.match(/\[WERT\]/g)??[]).length-(original.match(/\[WERT\]/g)??[]).length;return [k,walk(JSON.parse(safe)[k],logdaten||payload.has(k))];}catch {/* normales Feld */}
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
    const nul=shellNulDaten(out);
    if(nul.anzahl)nul.daten.message=[nul.daten.message,`NUL-Bytes ersetzt: ${nul.anzahl}`].filter(Boolean).join('; ');
    return nul.daten as T;
  }
  return shellNulDaten(safe).daten;
}

import {AsyncLocalStorage} from 'node:async_hooks';
import {logToolCall} from './tool-call-log.js';
import {stelleShellRueckfrage,loeseShellRueckfrageEin,leseShellBestaetigung,befehlHash,shellDemaskierFristStunden,mitShellDemaskierung,
  merkeShellDemaskierungVor,loeseShellDemaskierungVorab,type ShellRueckfrageBindung,type ShellBestaetigungEingabe,type ShellDemaskierung} from './shell-rueckfrage.js';
import {drossleShellJobHinweis} from './shell-job-hinweis.js';
import {ergaenzeShellErgebnisHinweis} from './shell-ergebnis-hinweis.js';
const sicht=new AsyncLocalStorage<boolean>();
export function shellSichtUnmaskiert():boolean{return sicht.getStore()===true;}
/** Inhalt einer Tool-Antwort: REST liefert das Objekt, stdio {content:[{text}]}. */
function antwortObjekt(v:unknown):Record<string,unknown>|undefined{
  if(!v||typeof v!=='object'||Array.isArray(v))return undefined;
  const text=(v as {content?:Array<{text?:unknown}>}).content?.[0]?.text;
  if(typeof text==='string')try{const o=JSON.parse(text);return o&&typeof o==='object'&&!Array.isArray(o)?o:undefined;}catch{return undefined;}
  return v as Record<string,unknown>;
}
/**
 * P10-T73: Demaskieren (maskierung:false) fuer JEDEN Agenten ueber die Rueckfrage-Stufe.
 * Ohne gueltige bestaetigung:{id,grund} wird nichts ausgefuehrt/gelesen: Antwort stufe 'rueckfrage' mit
 * bestaetigung_id + gueltig_bis. Verworfenes hinterlaesst keine Spur.
 */
function demaskierBindung(args:Record<string,unknown>,project:string|undefined,actor:string,action:string):ShellRueckfrageBindung{
  return action==='exec'
    ?{art:'demaskieren',agent_id:actor,project:project??'',befehl_hash:befehlHash(project??'',String(args.command??''))}
    :{art:'demaskieren',agent_id:actor,project:project??'',ziel:action+':'+String(args.id??args.log_strom??'')};
}
/** Anzeige-Override mit vorhandener Namenstreue, Speicherung bleibt unabhaengig davon geschuetzt. */
export async function mitShellAusgabe<T>(args:Record<string,unknown>,lauf:()=>Promise<T>,form:(o:Record<string,unknown>)=>T=(o=>o as T)):Promise<T> {
  let project=typeof args.project==='string'?args.project:undefined;
  if(!project && typeof args.stream_id==='string' && /^[a-f0-9]{16}$/i.test(args.stream_id))try {
    const meta=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.synapse','shell-streams',args.stream_id+'.meta.json'),'utf8'));
    if(typeof meta.project==='string')project=meta.project;
  }catch {/* unbekannter Stream wird vom bestehenden Handler gemeldet */}
  // P22-T55: Akteur ueber den Principal (Ausweis) zuerst, dann agent_id/SYNAPSE_AGENT_NAME (resolveAgentId).
  const akteur=resolveAgentId(typeof args.agent_id==='string'?args.agent_id:null)??'';
  if(args.maskierung===false&&!(args.bestaetigung===undefined&&darfKoordinatorOderUser(akteur)&&
    typeof args.grund==='string'&&args.grund.trim().length>=10)){
    const actor=akteur;
    const action=typeof args.action==='string'?args.action:'exec';
    if(!['exec','get','log'].includes(action))throw new Error('maskierung:false gibt es nur fuer exec, get und log');
    if(!actor)throw new Error('Demaskieren erfordert eine agent_id');
    const bindung=demaskierBindung(args,project,actor,action);
    let b:ShellBestaetigungEingabe|undefined,fehler:string|undefined,d:ShellDemaskierung|undefined,befehl:ShellBestaetigungEingabe|undefined;
    try{b=leseShellBestaetigung(args.bestaetigung);}catch{fehler='bestaetigung_ungueltig';}
    if(b){
      const vorab=action==='exec'?loeseShellDemaskierungVorab(b.id,bindung):undefined;
      if(vorab){d=vorab;befehl=b;}
      else{
        const r=loeseShellRueckfrageEin(b.id,b.grund,bindung);
        if(r.ok)d={bestaetigung_id:b.id,agent_id:actor,grund:b.grund.trim(),
          maskieren_bis:new Date(Date.now()+shellDemaskierFristStunden(b.frist_stunden)*3_600_000).toISOString()};
        else fehler=r.error;
      }
    }
    if(!d){
      const rf=stelleShellRueckfrage(bindung);
      return form({success:false,status:'rueckfrage',ausgefuehrt:false,stufe:'rueckfrage',art:'demaskieren',error:fehler??'shell_rueckfrage',
        risiko:'Die Ausgabe wuerde unmaskiert (mit Geheimnissen) angezeigt'+(action==='exec'?' und bis zur Frist unmaskiert gespeichert':'')+'.',
        ...rf,
        trotzdem:'Nicht ausgefuehrt, der Aufruf ist gespeichert. Bestaetigen kann nur der aufrufende Agent selbst: shell(action:"bestaetigen", id:<bestaetigung_id>, '+
          'grund:"<mind. 10 Zeichen>") bis gueltig_bis, ohne den Aufruf erneut zu senden'+(action==='exec'?
          ' (frueher nachmaskieren: shell(action:"bestaetigen", bestaetigung:{id, grund, frist_stunden}); Standard '+shellDemaskierFristStunden()+' h)':'')+
          ' (alter Weg: denselben Aufruf mit maskierung:false und bestaetigung:{id,grund}). Ohne Bestaetigung verfaellt die Rueckfrage ohne Spur.'});
    }
    const demask=d;
    await logToolCall({project,agentId:actor,tool:'shell',action:'demaskieren',argsPreview:JSON.stringify({grund:demask.grund,action,id:args.id,bestaetigung_id:demask.bestaetigung_id}),ok:true});
    const antwort=await ergaenzeShellErgebnisHinweis({...args,project},await drossleShellJobHinweis(args,
      await mitShellDemaskierung({...demask,...(befehl?{befehl_bestaetigung:befehl}:{})},()=>sicht.run(true,lauf))));
    // Der Befehl selbst stellte eine Rueckfrage (gefaehrlich): Demaskier-Freigabe an deren ID haengen.
    const inhalt=antwortObjekt(antwort);
    if(action==='exec'&&inhalt?.stufe==='rueckfrage'&&typeof inhalt.bestaetigung_id==='string')merkeShellDemaskierungVor(inhalt.bestaetigung_id,bindung,demask);
    return antwort && typeof antwort==='object' && !Array.isArray(antwort)
      ? {...antwort,maskierung_audit:{agent_id:actor,grund:maskiereShellText(demask.grund).text,bestaetigung_id:demask.bestaetigung_id,
        ...(action==='exec'?{maskieren_bis:demask.maskieren_bis}:{})}} : antwort;
  }
  if(args.maskierung===false){
    // Altweg (unveraendert): Koordinator/User mit grund, nur Anzeige.
    const actor=akteur;
    await logToolCall({project,agentId:actor,tool:'shell',action:'maskierung_aus',argsPreview:JSON.stringify({grund:args.grund,action:args.action,id:args.id}),ok:true});
    const antwort=await ergaenzeShellErgebnisHinweis({...args,project},await drossleShellJobHinweis(args,await sicht.run(true,lauf)));
    return antwort && typeof antwort==='object' && !Array.isArray(antwort)
      ? {...antwort,maskierung_audit:{agent_id:actor,grund:maskiereShellText(String(args.grund)).text}} : antwort;
  }
  return maskiereShellAntwort(project,await ergaenzeShellErgebnisHinweis({...args,project},await drossleShellJobHinweis(args,await lauf())));
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
