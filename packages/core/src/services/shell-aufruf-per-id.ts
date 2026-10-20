/**
 * P23-T9 (User 20.10.2026): Shell-Rueckfrage nur per ID bestaetigen.
 *
 * Antwortet ein shell-Aufruf mit stufe 'rueckfrage' (gefaehrlicher Befehl oder Demaskieren), merkt sich der
 * Eingangsprozess (REST-MCP bzw. stdio-Server) den vollstaendigen Aufruf (command, cwd_relative, target, workspace,
 * shell, maskierung, Optionen) zur bestaetigung_id. Bestaetigt wird dann ohne erneutes Senden des Befehls:
 *   shell(action:"bestaetigen", id:<bestaetigung_id>, grund)   bzw.   exec/get/log nur mit bestaetigung:{id,grund}.
 * Der gemerkte Aufruf laeuft mit dieser Bestaetigung erneut durch die normale Pruefung: Frist, nur derselbe Agent
 * (Ausweis-Identitaet bzw. agent_id), Drift von Befehl/Lage/Regeln -> neue Rueckfrage (pruefeShellStart).
 * Der alte Weg (Befehl erneut mit bestaetigung) bleibt unveraendert. Fluechtig wie die Rueckfrage selbst (gleiche
 * Frist, nur Prozessspeicher, keine Spur nach Ablauf). Kein Schalter: reiner Bedienweg, der alte Weg bleibt.
 */
import {resolveAgentId} from './agent-id-resolver.js';
import {aktuelleAgentIdentityId} from './agent-bezug.js';
import {leseShellBestaetigung,shellRueckfrageFristMs,type ShellBestaetigungEingabe} from './shell-rueckfrage.js';

interface Gemerkt{args:Record<string,unknown>;project:string;agent_id:string|null;identity_id:string|null;gueltig_bis:number;}
const gemerkt=new Map<string,Gemerkt>();
/** Gehoeren zum aktuellen Aufrufer, nicht zum gemerkten Aufruf. */
const AUFRUFER_FELDER=['token','agent_id'] as const;

function aufraeumen(jetzt=Date.now()):void{
  for(const [id,e] of gemerkt)if(e.gueltig_bis<=jetzt)gemerkt.delete(id);
}
const istObjekt=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Inhalt einer Tool-Antwort: REST liefert das Objekt, stdio {content:[{text}]}. */
function antwortObjekt(v:unknown):{o:Record<string,unknown>;text:boolean}|undefined{
  if(!istObjekt(v))return undefined;
  const text=(v as {content?:Array<{text?:unknown}>}).content?.[0]?.text;
  if(typeof text==='string')try{const o=JSON.parse(text);return istObjekt(o)?{o,text:true}:undefined;}catch{return undefined;}
  return {o:v,text:false};
}
export function kurzerBestaetigungsAufruf(id:string):string{
  return `shell(action:"bestaetigen", id:"${id}", grund:"<mind. 10 Zeichen>")`;
}
/**
 * Kurzform erkennen: action 'bestaetigen' (id + grund oder bestaetigung) oder exec ohne command bzw. get/log ohne
 * Job-ID, aber mit bestaetigung. Sonst undefined (normaler Aufruf, auch der alte Weg).
 */
function kurzform(args:Record<string,unknown>):{b?:ShellBestaetigungEingabe;fehler?:string}|undefined{
  const action=typeof args.action==='string'?args.action:'exec';
  let roh:unknown;
  if(action==='bestaetigen')roh=args.bestaetigung??{id:args.id,grund:args.grund};
  else if(args.bestaetigung!==undefined&&(action==='exec'&&args.command===undefined||(action==='get'||action==='log')&&args.id===undefined))roh=args.bestaetigung;
  else return undefined;
  try{const b=leseShellBestaetigung(roh);return b?{b}:{fehler:'bestaetigung_ungueltig'};}catch{return {fehler:'bestaetigung_ungueltig'};}
}
const fremd=(e:Gemerkt,agent:string|null,identity:string|null)=>e.identity_id?e.identity_id!==identity:!!identity||e.agent_id!==agent;

/**
 * Huelle um den shell-Handler (REST und stdio). akteur: vom Eingang bereits aufgeloeste Agent-ID (REST), sonst
 * agent_id/Principal. form baut aus einem Fehlerobjekt die Antwortform des Eingangs.
 */
export async function mitShellAufrufPerId<T>(args:Record<string,unknown>,lauf:(args:Record<string,unknown>)=>Promise<T>,
  form:(o:Record<string,unknown>)=>T=(o=>o as T),akteur?:string|null):Promise<T>{
  const agent=resolveAgentId(akteur??(typeof args.agent_id==='string'?args.agent_id:null))??null;
  const kurz=kurzform(args);
  let aufruf=args;
  if(kurz){
    const fehler=(error:string,message:string)=>form({success:false,status:'rejected',ausgefuehrt:false,error,message});
    if(!kurz.b)return fehler(kurz.fehler??'bestaetigung_ungueltig','Bestaetigen: shell(action:"bestaetigen", id:<bestaetigung_id>, grund:"<mind. 10 Zeichen>") oder bestaetigung:{id, grund}.');
    aufraeumen();
    const e=gemerkt.get(kurz.b.id);
    if(!e)return fehler('bestaetigung_unbekannt','Keine offene Rueckfrage mit dieser ID (abgelaufen, schon verbraucht oder von einem anderen Synapse-Prozess gestellt). Den Befehl neu senden.');
    if(fremd(e,agent,aktuelleAgentIdentityId(e.project,agent)))return fehler('bestaetigung_fremder_agent','Nur der Agent, der die Rueckfrage ausgeloest hat, kann sie bestaetigen.');
    gemerkt.delete(kurz.b.id);
    aufruf={...e.args,bestaetigung:kurz.b};
    for(const f of AUFRUFER_FELDER)if(args[f]!==undefined)aufruf[f]=args[f];
  }else if(istObjekt(args.bestaetigung)&&typeof args.bestaetigung.id==='string'){
    // Alter Weg mit derselben ID: die gemerkte Fassung ist damit verbraucht.
    const id=args.bestaetigung.id.toLowerCase(),e=gemerkt.get(id);
    if(e&&!fremd(e,agent,aktuelleAgentIdentityId(e.project,agent)))gemerkt.delete(id);
  }
  const antwort=await lauf(aufruf);
  const inhalt=antwortObjekt(antwort);
  if(!inhalt||inhalt.o.stufe!=='rueckfrage'||typeof inhalt.o.bestaetigung_id!=='string')return antwort;
  const project=typeof aufruf.project==='string'?aufruf.project:'';
  const gespeichert:Record<string,unknown>={...aufruf};
  for(const f of [...AUFRUFER_FELDER,'bestaetigung'])delete gespeichert[f];
  aufraeumen();
  gemerkt.set(inhalt.o.bestaetigung_id,{args:gespeichert,project,agent_id:agent,identity_id:aktuelleAgentIdentityId(project,agent),
    gueltig_bis:Date.now()+shellRueckfrageFristMs()});
  // Die schlanke Antwort (P23-T3) traegt den Kurzweg schon samt Detail-Hinweis.
  if(typeof inhalt.o.bestaetigen==='string')return antwort;
  const o={...inhalt.o,bestaetigen:'Nicht ausgefuehrt, der Aufruf ist gespeichert. Bestaetigen: '+kurzerBestaetigungsAufruf(inhalt.o.bestaetigung_id)
    +' bis gueltig_bis - den Befehl NICHT erneut senden.'};
  return (inhalt.text?{...(antwort as Record<string,unknown>),content:[{type:'text',text:JSON.stringify(o,null,2)}]}:o) as T;
}
/** Nur fuer Tests/Diagnose. */
export function gemerkteShellAufrufe():number{aufraeumen();return gemerkt.size;}
export function leereGemerkteShellAufrufe():void{gemerkt.clear();}
