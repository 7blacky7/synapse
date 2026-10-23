/**
 * P18-T109 Teil 1: code_intel/asset_intel mit project="rev-…" (Schalter reverse_intel_abruf, global, Standard AUS).
 * Keine Parallelwelt: der Aufruf läuft durch den reverse-Dispatcher (Rechte, Sichtbarkeit, Nachforderung, Maskierung,
 * Budget, Aktivität) und damit durch dieselbe code_intel-/asset_intel-Engine (REVERSE_BEREICH, P18-T12/T20/T26).
 * Jede Antwort trägt herkunft.bereich='reverse'. AUS, kein rev-Muster, gleichnamiges Projekt oder unbekannter Eintrag
 * -> null, der Bestand antwortet unverändert.
 * FAIL-CLOSED (Abnahme 95d4d016 R1): Hat die Ausweisprüfung den Aufruf als Reverse-Ziel autorisiert (Zeuge am
 * Argumentobjekt, nur serverseitig setzbar), wird er NIE still als Projekt weiterbehandelt: kippt die zweite Prüfung
 * (Schalter, Eintrag, Namenskollision, Lesefehler), kommt reverse_ziel_ungueltig statt Projekt-Fallback.
 * Debug: reverseIntelVerlauf() (letzte Weichen-Entscheidungen, nur Prozess, Länge = diagnose_verlauf_speicher).
 */
import {getPool} from '../db/client.js';
import {leseReverseProduktSchalter,leseReverseEinstellwerte,reverseZahl} from './reverse-einstellwerte.js';
import {aktuellerAgentAufruf} from './agent-bezug.js';

type Row=Record<string,unknown>;
const MUSTER=/^rev-[A-Za-z0-9_.:-]{1,196}$/;
/** Serverseitiger Zeuge: Symbol-Schlüssel kommen nie aus JSON-Argumenten und bleiben bei Objekt-Spread erhalten. */
export const REVERSE_INTEL_ZEUGE=Symbol.for('synapse.p18t109.reverseIntelZiel');
/** code_intel-Aktion -> reverse-Aktion; statements/flow/entrypoints/variables usw. bewusst nicht (User 23.10.2026). */
export const REVERSE_INTEL_CODE:Readonly<Record<string,string>>={tree:'tree',functions:'functions',symbols:'symbols',references:'references',search:'search',file:'file',calls:'calls'};
export const REVERSE_INTEL_ASSET:Readonly<Record<string,string>>={tree:'assets_tree',inspect:'inspect'};
const verlauf:Row[]=[];
async function merke(e:Row):Promise<void>{
  const max=await leseReverseEinstellwerte({}).then(s=>reverseZahl(s,'diagnose_verlauf_speicher')).catch(()=>0);
  verlauf.unshift({zeit:new Date().toISOString(),...e});if(verlauf.length>max)verlauf.length=max;
}
export function reverseIntelVerlauf():Row[]{return verlauf.slice();}

export type ReverseIntelZielGrund='ziel'|'kein_muster'|'schalter_aus'|'schalter_fehler'|'eintrag_unbekannt'|'projekt_gleichnamig'|'lesefehler';
/** Wirft nie. ziel=true nur bei Muster, Schalter EIN, vorhandenem Eintrag und ohne gleichnamiges Projekt. */
export async function pruefeReverseIntelZiel(project:unknown):Promise<{ziel:boolean;grund:ReverseIntelZielGrund}>{
  if(typeof project!=='string'||!MUSTER.test(project))return {ziel:false,grund:'kein_muster'};
  try{
    const s=await leseReverseProduktSchalter('reverse_intel_abruf');
    if(s.letzter_fehler)return {ziel:false,grund:'schalter_fehler'};
    if(!s.aktiv)return {ziel:false,grund:'schalter_aus'};
    const r=await getPool().query('SELECT EXISTS(SELECT 1 FROM reverse_eintraege WHERE id=$1) AS rev,EXISTS(SELECT 1 FROM projects WHERE name=$1) AS proj',[project]);
    if(r.rows[0]?.rev!==true)return {ziel:false,grund:'eintrag_unbekannt'};
    if(r.rows[0]?.proj===true)return {ziel:false,grund:'projekt_gleichnamig'};
    return {ziel:true,grund:'ziel'};
  }catch{return {ziel:false,grund:'lesefehler'};}
}
export async function istReverseIntelZiel(project:unknown):Promise<boolean>{return (await pruefeReverseIntelZiel(project)).ziel;}
/** Nur die Ausweisprüfung (agent-token-tools) bezeugt ein autorisiertes Reverse-Ziel. */
export function bezeugeReverseIntelZiel<T extends object>(args:T,reverseId:string):T{
  (args as Record<symbol,unknown>)[REVERSE_INTEL_ZEUGE]=reverseId;return args;
}
async function aufrufer(agentId:string|null):Promise<{project:string|null;agent_id:string|null}>{
  const p=aktuellerAgentAufruf()?.principal;
  if(p?.project&&p.agent_id)return {project:p.project,agent_id:p.agent_id};
  if(!agentId)return {project:null,agent_id:null};
  const r=await getPool().query('SELECT project FROM agent_sessions WHERE id=$1',[agentId]).catch(()=>({rows:[] as Row[]}));
  const project=r.rows[0]?.project;
  return {project:typeof project==='string'?project:null,agent_id:agentId};
}

export async function leiteReverseIntelUm(tool:'code_intel'|'asset_intel',args:Row|undefined|null,agentId?:string|null):Promise<Row|null>{
  const a:Row=args&&typeof args==='object'&&!Array.isArray(args)?args:{};
  const rid=a.project;
  const bezeugt=typeof rid==='string'&&(a as Record<symbol,unknown>)[REVERSE_INTEL_ZEUGE]===rid;
  const pruefung=await pruefeReverseIntelZiel(rid);
  if(!pruefung.ziel){
    if(!bezeugt)return null;
    // Als Reverse autorisiert, jetzt kein gültiges Ziel mehr: ablehnen, nie in den Projektpfad fallen.
    await merke({bereich:'reverse',reverse_id:rid,tool,action:a.action??null,ergebnis:'reverse_ziel_ungueltig',grund:pruefung.grund});
    return {success:false,action:a.action??null,project:rid,error:'reverse_ziel_ungueltig',fehlercode:'reverse_ziel_ungueltig',grund:pruefung.grund,
      message:'Reverse-Ziel nach der Ausweisprüfung nicht mehr gültig ('+pruefung.grund+'); nichts ausgeführt.',herkunft:{bereich:'reverse',reverse_id:rid,tool}};
  }
  const action=String(a.action??''),tabelle=tool==='code_intel'?REVERSE_INTEL_CODE:REVERSE_INTEL_ASSET,ziel=tabelle[action];
  const herkunft:Row={bereich:'reverse',reverse_id:rid,tool,action,reverse_action:ziel??null};
  if(!ziel){
    await merke({...herkunft,ergebnis:'reverse_nicht_unterstuetzt'});
    return {success:false,action,project:rid,error:'reverse_nicht_unterstuetzt',fehlercode:'reverse_nicht_unterstuetzt',
      message:tool+'(action:"'+action+'") gibt es für Reverse-Einträge nicht.',erlaubt:Object.keys(tabelle),herkunft};
  }
  const wer=await aufrufer(typeof agentId==='string'&&agentId?agentId:typeof a.agent_id==='string'&&a.agent_id?a.agent_id:null);
  if(!wer.project||!wer.agent_id){
    await merke({...herkunft,ergebnis:'keine_berechtigung'});
    return {success:false,action,project:rid,error:'keine_berechtigung',fehlercode:'keine_berechtigung',message:'Aufrufer ohne Heimatprojekt (Ausweis oder agent_id).',herkunft};
  }
  // Dynamisch: reverse-tool zieht viele Module nach; die Weiche bleibt für Bestandsaufrufe leicht.
  const {REVERSE_DEFINITION,fuehreReverseAus}=await import('./reverse-tool.js');
  const erlaubt=new Set(Object.keys(REVERSE_DEFINITION.inputSchema.properties));
  const weiter:Row={};
  for(const [k,v] of Object.entries(a))if(v!==undefined&&erlaubt.has(k)&&!['action','project','agent_id','reverse_id'].includes(k))weiter[k]=v;
  const antwort=await fuehreReverseAus({...weiter,action:ziel,reverse_id:rid,project:wer.project,agent_id:wer.agent_id});
  await merke({...herkunft,heimat:wer.project,bezeugt,ergebnis:antwort.success===true?'ok':String(antwort.fehlercode??'fehler')});
  return {...antwort,herkunft:{...herkunft,heimat_projekt:wer.project,
    hinweis:'Reverse-Inhalt (Vorlage, nicht Projektcode). file braucht virtuelle Pfade <Original>@S1/strings.txt, @S2/<Funktion>.asm, @S3/<Funktion>.c. Ins Projekt nur über reverse(action:"uebernehmen").'}};
}
