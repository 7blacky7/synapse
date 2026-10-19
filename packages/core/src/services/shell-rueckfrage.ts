/**
 * P10-T73: Rückfrage-Stufe für gefährliche Shell-Befehle und fürs Demaskieren.
 *
 * Offene Rückfragen leben NUR im Prozessspeicher des prüfenden Prozesses (Daemon,
 * REST-API oder stdio-Server). Eine nicht bestätigte Rückfrage verfällt nach der
 * Frist (Standard 60 s, SYNAPSE_SHELL_RUECKFRAGE_SEK) ohne jede Spur: kein Audit,
 * keine Tabelle. Eine ID ist an Agent, Projekt, Befehl/Ziel und Lage gebunden und
 * wird beim Einlösen verbraucht.
 */
import {randomBytes,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import { aktuelleAgentIdentityId } from './agent-bezug.js';

export type ShellRueckfrageArt='befehl'|'demaskieren';
export interface ShellRueckfrageBindung{
  art:ShellRueckfrageArt; agent_id:string|null; identity_id?:string|null; project:string;
  befehl_hash?:string; lage_hash?:string; regelversion?:string;
  /** Demaskieren von get/log: Aktion + Job-ID. */
  ziel?:string;
}
/** Bestätigung durch den aufrufenden Agenten selbst (jeder Agent, ID + Grund). */
export interface ShellBestaetigungEingabe{id:string;grund:string;frist_stunden?:number;}
export type ShellRueckfrageFehler='bestaetigung_unbekannt'|'bestaetigung_abgelaufen'|'bestaetigung_fremder_agent'|'bestaetigung_veraltet'|'grund_fehlt'|'agent_fehlt';
interface Offen{bindung:ShellRueckfrageBindung;gueltig_bis:number;}
const offen=new Map<string,Offen>();

export function shellRueckfrageFristMs():number{
  const s=Number(process.env.SYNAPSE_SHELL_RUECKFRAGE_SEK??60);
  return (Number.isFinite(s)&&s>0?s:60)*1000;
}
function aufraeumen(jetzt=Date.now()):void{
  for(const [id,e] of offen)if(e.gueltig_bis<=jetzt)offen.delete(id);
}
let raeumer:NodeJS.Timeout|undefined;
function raeumerStarten():void{
  if(raeumer)return;
  raeumer=setInterval(()=>{aufraeumen();if(!offen.size&&raeumer){clearInterval(raeumer);raeumer=undefined;}},15_000);
  raeumer.unref?.();
}
export function befehlHash(project:string,command:string):string{
  return createHash('sha256').update(JSON.stringify([project,command])).digest('hex');
}
/** Neue Rückfrage: kurze zufällige ID, flüchtig, bis gueltig_bis einlösbar. */
export function stelleShellRueckfrage(bindung:ShellRueckfrageBindung):{bestaetigung_id:string;gueltig_bis:string}{
  bindung={...bindung,identity_id:bindung.identity_id!==undefined?bindung.identity_id:aktuelleAgentIdentityId(bindung.project,bindung.agent_id)};
  aufraeumen();
  let id=randomBytes(5).toString('hex');
  while(offen.has(id))id=randomBytes(5).toString('hex');
  const bis=Date.now()+shellRueckfrageFristMs();
  offen.set(id,{bindung:{...bindung},gueltig_bis:bis});
  raeumerStarten();
  return {bestaetigung_id:id,gueltig_bis:new Date(bis).toISOString()};
}
const gleich=(a:ShellRueckfrageBindung,b:ShellRueckfrageBindung)=>
  a.project===b.project&&(a.befehl_hash??null)===(b.befehl_hash??null)&&(a.lage_hash??null)===(b.lage_hash??null)&&
  (a.regelversion??null)===(b.regelversion??null)&&(a.ziel??null)===(b.ziel??null);
/**
 * Löst eine Rückfrage ein. Nur der Agent, der sie ausgelöst hat; Drift (anderer
 * Befehl, andere Lage, neue Regelversion) verbraucht die ID und verlangt neue Prüfung.
 * Eine ID einer anderen Art (z. B. Befehls-ID beim Demaskieren) bleibt unberührt.
 */
export function loeseShellRueckfrageEin(id:unknown,grund:unknown,bindung:ShellRueckfrageBindung):{ok:true}|{ok:false;error:ShellRueckfrageFehler}{
  bindung={...bindung,identity_id:bindung.identity_id!==undefined?bindung.identity_id:aktuelleAgentIdentityId(bindung.project,bindung.agent_id)};
  // P22-T55: mit Ausweis genuegt die Identitaet (identity_id aus dem Principal); agent_id ist dann nicht Pflicht.
  if(!bindung.agent_id&&!bindung.identity_id)return {ok:false,error:'agent_fehlt'};
  if(typeof grund!=='string'||grund.trim().length<10)return {ok:false,error:'grund_fehlt'};
  if(typeof id!=='string')return {ok:false,error:'bestaetigung_unbekannt'};
  const e=offen.get(id);
  if(!e||e.bindung.art!==bindung.art)return {ok:false,error:'bestaetigung_unbekannt'};
  if(e.gueltig_bis<=Date.now()){offen.delete(id);return {ok:false,error:'bestaetigung_abgelaufen'};}
  if((e.bindung.identity_id ? e.bindung.identity_id!==bindung.identity_id : !!bindung.identity_id||e.bindung.agent_id!==bindung.agent_id))return {ok:false,error:'bestaetigung_fremder_agent'};
  offen.delete(id);
  return gleich(e.bindung,bindung)?{ok:true}:{ok:false,error:'bestaetigung_veraltet'};
}
/**
 * Demaskieren bestaetigt, aber der Befehl selbst stellte eine eigene Rueckfrage (gefaehrlich):
 * die Demaskier-Freigabe wird an deren ID gehaengt, damit EINE weitere Bestaetigung genuegt.
 * Ebenso fluechtig und an Agent/Projekt/Befehl gebunden.
 */
const vorab=new Map<string,{bindung:ShellRueckfrageBindung;demaskierung:ShellDemaskierung;gueltig_bis:number}>();
export function merkeShellDemaskierungVor(id:string,bindung:ShellRueckfrageBindung,d:ShellDemaskierung):void{
  bindung={...bindung,identity_id:bindung.identity_id!==undefined?bindung.identity_id:aktuelleAgentIdentityId(bindung.project,bindung.agent_id)};
  const jetzt=Date.now();
  for(const [k,e] of vorab)if(e.gueltig_bis<=jetzt)vorab.delete(k);
  vorab.set(id,{bindung:{...bindung},demaskierung:{...d},gueltig_bis:jetzt+shellRueckfrageFristMs()});
}
export function loeseShellDemaskierungVorab(id:string,bindung:ShellRueckfrageBindung):ShellDemaskierung|undefined{
  bindung={...bindung,identity_id:bindung.identity_id!==undefined?bindung.identity_id:aktuelleAgentIdentityId(bindung.project,bindung.agent_id)};
  const e=vorab.get(id);
  if(!e)return undefined;
  if(e.gueltig_bis<=Date.now()){vorab.delete(id);return undefined;}
  if((e.bindung.identity_id ? e.bindung.identity_id!==bindung.identity_id : !!bindung.identity_id||e.bindung.agent_id!==bindung.agent_id)||!gleich(e.bindung,bindung))return undefined;
  vorab.delete(id);
  return e.demaskierung;
}
/** Nur für Tests/Diagnose: Anzahl offener (nicht abgelaufener) Rückfragen. */
export function offeneShellRueckfragen():number{aufraeumen();return offen.size;}
/** Nur für Tests. */
export function leereShellRueckfragen():void{offen.clear();vorab.clear();}

export function leseShellBestaetigung(v:unknown):ShellBestaetigungEingabe|undefined{
  if(typeof v==='string'){try{v=JSON.parse(v);}catch{throw Error('bestaetigung_ungueltig');}}
  if(v===undefined||v===null)return undefined;
  if(typeof v!=='object'||Array.isArray(v))throw Error('bestaetigung_ungueltig');
  const b=v as Record<string,unknown>;
  if(typeof b.id!=='string'||!/^[a-f0-9]{6,32}$/i.test(b.id)||typeof b.grund!=='string'||b.grund.trim().length<10)throw Error('bestaetigung_ungueltig');
  if(b.frist_stunden!==undefined&&(typeof b.frist_stunden!=='number'||!Number.isFinite(b.frist_stunden)||b.frist_stunden<0))throw Error('bestaetigung_ungueltig');
  return {id:b.id.toLowerCase(),grund:b.grund,...(typeof b.frist_stunden==='number'?{frist_stunden:b.frist_stunden}:{})};
}

/** Bestätigt demaskierte Ausführung: wandert mit dem Job bis zur Speicherung. */
export interface ShellDemaskierung{bestaetigung_id:string;agent_id:string;actor_identity_id?:string|null;grund:string;maskieren_bis:string;}
type DemaskKontext=ShellDemaskierung&{befehl_bestaetigung?:ShellBestaetigungEingabe};
const demaskKontext=new AsyncLocalStorage<DemaskKontext>();
export function mitShellDemaskierung<T>(d:DemaskKontext,lauf:()=>Promise<T>):Promise<T>{return demaskKontext.run(d,lauf);}
export function aktuelleShellDemaskierung():ShellDemaskierung|undefined{
  const d=demaskKontext.getStore();
  return d?{bestaetigung_id:d.bestaetigung_id,agent_id:d.agent_id,grund:d.grund,maskieren_bis:d.maskieren_bis,...(d.actor_identity_id ? {actor_identity_id:d.actor_identity_id} : {})}:undefined;
}
/** Bei maskierung:false gilt bestaetigung der Anzeige; eine zugleich bestaetigte Befehls-Rueckfrage reist hier mit. */
export function demaskierteBefehlsBestaetigung():ShellBestaetigungEingabe|undefined{return demaskKontext.getStore()?.befehl_bestaetigung;}
/** Frist bis zum Nachmaskieren: Standard 72 h (SYNAPSE_SHELL_DEMASKIERT_STUNDEN), kürzer pro Bestätigung. */
export function shellDemaskierFristStunden(gewuenscht?:number):number{
  const roh=Number(process.env.SYNAPSE_SHELL_DEMASKIERT_STUNDEN??72);
  const max=Number.isFinite(roh)&&roh>=0?roh:72;
  return typeof gewuenscht==='number'&&Number.isFinite(gewuenscht)&&gewuenscht>=0?Math.min(gewuenscht,max):max;
}
export function isShellDemaskierung(v:unknown):v is ShellDemaskierung{
  if(!v||typeof v!=='object')return false;
  const d=v as Record<string,unknown>;
  return typeof d.bestaetigung_id==='string'&&typeof d.agent_id==='string'&&d.agent_id.length>0&&typeof d.grund==='string'&&
    typeof d.maskieren_bis==='string'&&!Number.isNaN(Date.parse(d.maskieren_bis));
}
