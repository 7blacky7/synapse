/** P10-T37: ein Parameter-/Antwortvertrag für REST und stdio. */
import type{ShellBestaetigung}from'./shell-start-sicherung.js';
import type{SicherungsShell}from'./shell-sicherung-parser.js';
import{leseShellBestaetigung,demaskierteBefehlsBestaetigung,type ShellBestaetigungEingabe}from'./shell-rueckfrage.js';
export const SHELL_SICHERUNGS_PARAMETER={
  bestaetigung:{type:'object',additionalProperties:false,required:['id','grund'],
    description:'Rueckfrage bestaetigen (jeder Agent, nur fuer die EIGENE Rueckfrage): id = bestaetigung_id aus der Antwort stufe:"rueckfrage", grund mind. 10 Zeichen. Gilt fuer gefaehrliche Befehle (gleicher command) und fuers Demaskieren (maskierung:false). Frist Standard 60 s, danach verfaellt die Rueckfrage ohne Spur. frist_stunden (nur Demaskieren): frueher nachmaskieren als der Standard (3 Tage).',
    properties:{id:{type:'string',pattern:'^[a-fA-F0-9]{6,32}$'},grund:{type:'string',minLength:10},frist_stunden:{type:'number',minimum:0}}},
  shell:{type:'string',enum:['sh','bash','cmd','pwsh'],description:'Native Shell; Default sh auf POSIX, cmd auf Windows.'},
  bestaetigt:{type:'object',additionalProperties:false,required:['grund','befehl_hash','lage_hash','regelversion'],
    description:'Nur Koordinator/User: dieselben bestaetigungsdaten mit grund zurückgeben. Drift erfordert erneute Prüfung; sperre ist nicht übergehbar.',
    properties:{grund:{type:'string',minLength:10},befehl_hash:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},
      lage_hash:{type:'string',pattern:'^[a-fA-F0-9]{64}$'},regelversion:{type:'string',pattern:'^[a-fA-F0-9]{64}$'}}},
};
export function shellSicherungsParameter(args:Record<string,unknown>):{shell?:SicherungsShell;bestaetigt?:ShellBestaetigung;bestaetigung?:ShellBestaetigungEingabe}{
  let shell:SicherungsShell|undefined;
  if(args.shell!==undefined){
    if(typeof args.shell!=='string'||!['sh','bash','cmd','pwsh'].includes(args.shell))throw Error('shell_ungueltig');
    shell=args.shell as SicherungsShell;
  }
  // P10-T73: Bestaetigung beim Demaskieren gehoert der Anzeige (mitShellAusgabe), nicht dem Befehl.
  const bestaetigung=args.maskierung===false?demaskierteBefehlsBestaetigung():leseShellBestaetigung(args.bestaetigung);
  const basis={...(shell?{shell}:{}),...(bestaetigung?{bestaetigung}:{})};
  let v=args.bestaetigt;
  if(typeof v==='string'){try{v=JSON.parse(v);}catch{throw Error('bestaetigung_ungueltig');}}
  if(v===undefined||v===null)return basis;
  if(typeof v!=='object'||Array.isArray(v))throw Error('bestaetigung_ungueltig');
  const b=v as Record<string,unknown>;
  if(typeof b.grund!=='string'||b.grund.trim().length<10||
    ['befehl_hash','lage_hash','regelversion'].some(k=>typeof b[k]!=='string'||!/^[a-fA-F0-9]{64}$/.test(b[k] as string)))throw Error('bestaetigung_ungueltig');
  return {...basis,bestaetigt:{grund:b.grund,befehl_hash:b.befehl_hash as string,lage_hash:b.lage_hash as string,regelversion:b.regelversion as string}};
}
/** Ohne Sicherungsentscheid keine neuen Felder in alten Antworten. */
export function shellSicherungsAntwortAus(v:Record<string,unknown>):Record<string,unknown>{
  if(typeof v.ausgefuehrt!=='boolean')return {};
  const out:Record<string,unknown>={};
  for(const key of ['ausgefuehrt','stufe','risiko','lage','sicher','danach','trotzdem','bestaetigungsdaten','bestaetigung_id','gueltig_bis','error','id'])
    if(Object.hasOwn(v,key))out[key]=v[key];
  return out;
}
