/** P10-T37: Queue hat keine native Lage; Prüfung dort nur vor Cache/Attach.
 * Der Worker prüft anschließend den echten Rechner vor jedem Originalspawn.
 */
import{pruefeShellText}from'./shell-sicherung.js';
import{holeShellDbFreigabe}from'./shell-db-freigabe.js';
import type{ShellDbFreigabe}from'./shell-db-zuordnung.js';
import{aktuelleUserHerkunft,type UserHerkunft}from'./user-herkunft.js';
import{holeShellStartKatalog}from'./shell-sicherungs-lauf.js';
import type{ShellBestaetigung}from'./shell-start-sicherung.js';
import type{SicherungsShell}from'./shell-sicherung-parser.js';
export interface ShellSicherungsAnfrage{datenbank_freigabe?:ShellDbFreigabe;bestaetigt?:ShellBestaetigung|null;shell?:SicherungsShell;herkunft?:UserHerkunft;}
export interface ShellJobSicherung{anfrage?:ShellSicherungsAnfrage;antwort?:import('./shell-start-sicherung.js').ShellSicherungsAntwort;}
export async function pruefeShellEinreihung(o:{project:string;command:string;shell?:SicherungsShell;bestaetigt?:ShellBestaetigung|null}){
  const k=await holeShellStartKatalog();
  // Queue kennt OS/Hostname des Zielhosts noch nicht. Potentiell passende
  // Geltung darf Cache nicht erlauben; endgültige Geltung prüft der Executor.
  const katalog={...k,regeln:k.regeln.map(r=>({...r,os:undefined,rechner:undefined})),
    antworten:k.antworten.map(a=>({...a,os:undefined,rechner:undefined}))};
  const r=pruefeShellText(o.command,{project:o.project,shell:o.shell,katalog});
  const wiederverwendbar=!o.bestaetigt&&!o.shell&&r.stufe==='laeuft'&&!r.risiko_verb&&!r.ungeklaert.length&&
    !k.regeln.some(x=>x.status==='aktiv'&&x.art==='lage'&&(x.bereich!=='projekt'||x.project===o.project))&&
    !/context-handoff\.sh|cc-handoff/i.test(o.command);
  const db=wiederverwendbar?undefined:await holeShellDbFreigabe(o.project);
  return {wiederverwendbar,sicherung:wiederverwendbar?null:{anfrage:{
    ...(db?.ziele.length?{datenbank_freigabe:db}:{}),
    ...(o.bestaetigt?{bestaetigt:o.bestaetigt}:{}),...(o.shell?{shell:o.shell}:{}),
    ...(o.bestaetigt&&aktuelleUserHerkunft()?{herkunft:aktuelleUserHerkunft()}:{} )}}};
}
