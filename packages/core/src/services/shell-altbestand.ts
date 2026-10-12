/** P10-T42 Phase 1+2: reine Kandidaten/Gruppen, Jev-Bewertung; keine DB-Schreibzugriffe. */
import {createHash} from 'node:crypto';
import {maskiereShellDaten,maskiereShellText} from './shell-maske.js';
import {rufeJev,type JevAnfrage,type JevErgebnis} from './jev-client.js';
import {jevPreisJeMio} from './jev-kosten.js';

export interface ShellAltZeile {
  tabelle:'shell_jobs'|'tool_calls';id:string;project:string|null;daten:Record<string,unknown>;gespeichert_am?:string|Date|null;
}
export interface ShellAltBezug {tabelle:ShellAltZeile['tabelle'];id:string;project:string|null;pfad:string;}
export interface ShellAltGruppe {
  id:string;literal_hash:string;feld:string;schluessel:string;
  fundart:'literal'|'muster'|'offene_zuordnung';wertlaenge:number;
  kontext:string;bezuege:ShellAltBezug[];
}
export type ShellAltBewertung='geheimnis'|'beispiel'|'falsch'|'offen';
export interface ShellAltEntscheidung {gruppe:string;bewertung:ShellAltBewertung;confidence:number|null;grund:string;}
type ShellAltWeg=Array<string|number|null>;
interface ShellAltZiel {tabelle:ShellAltZeile['tabelle'];id:string;weg:ShellAltWeg;start:number|null;ende:number|null;}
const ziele=new WeakMap<ShellAltGruppe,ShellAltZiel[]>();
const PLATZ='[WERT]';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const geprueft=new WeakMap<ShellAltGruppe,string>();
const signatur=(g:ShellAltGruppe)=>hash(JSON.stringify(g));
const feldOhneIndex=(s:string)=>s.replace(/\[\d+\]/g,'[]');

/** Nur eindeutige Ersetzungen rekonstruieren. Mehrdeutige Anker sind kein automatisch schreibbarer Fund. */
function ersetzteSpannen(roh:string,safe:string):Array<{start:number;wert:string}>|null {
  const teile=safe.split(PLATZ),spannen:Array<{start:number;wert:string}>=[];
  if(teile.length<2)return null;
  let cursor=0;
  for(let i=0;i<teile.length;i++){
    if(!roh.startsWith(teile[i],cursor))return null;
    cursor+=teile[i].length;
    if(i===teile.length-1)break;
    if(roh.startsWith(PLATZ,cursor)){cursor+=PLATZ.length;continue;}
    const anker=teile[i+1];
    if(!anker && i!==teile.length-2)return null;
    const ende=anker?roh.indexOf(anker,cursor):roh.length;
    if(ende<0 || (anker && roh.indexOf(anker,ende+anker.length)>=0))return null;
    spannen.push({start:cursor,wert:roh.slice(cursor,ende)});cursor=ende;
  }
  return cursor===roh.length?spannen:null;
}

/** Identische Literale nur mit gleichem Feld/Schluessel/Fundart zusammenlegen. Kein Literal in der Rueckgabe. */
export function gruppiereShellAltbestand(zeilen:readonly ShellAltZeile[],werte:readonly string[]):ShellAltGruppe[] {
  const gruppen=new Map<string,ShellAltGruppe>(),bekannt=new Set(werte);
  for(const row of zeilen){
    const safe=maskiereShellDaten(row.daten,werte,true).daten;
    const aufnehmen=(roh:string,feld:string,schluessel:string,art:ShellAltGruppe['fundart'],kontext:string,pfad:string,ziel:ShellAltZiel)=>{
      const literal_hash=hash(roh),kontextSafe=maskiereShellText(kontext,werte).text;
      const feldSafe=maskiereShellText(feld,werte).text,nameSafe=maskiereShellText(schluessel,werte).text,
        pfadSafe=maskiereShellText(pfad,werte).text;
      const fundart=pfadSafe!==pfad?'offene_zuordnung':art;
      // Gleiche Werte in echtem Einsatz und in Beispielen sind verschiedene Faelle.
      const key=JSON.stringify([literal_hash,feldSafe,nameSafe,fundart,hash(kontextSafe)]);
      let g=gruppen.get(key);
      if(!g){g={id:hash(key),literal_hash,feld:feldSafe,schluessel:nameSafe,fundart,wertlaenge:roh.length,
        kontext:kontextSafe.slice(0,1200),bezuege:[]};gruppen.set(key,g);ziele.set(g,[]);}
      if(fundart!=='offene_zuordnung')ziele.get(g)!.push(ziel);
      if(!g.bezuege.some(b=>b.tabelle===row.tabelle && b.id===row.id && b.pfad===pfadSafe))
        g.bezuege.push({tabelle:row.tabelle,id:row.id,project:row.project,pfad:pfadSafe});
    };
    const walk=(roh:unknown,neu:unknown,pfad:string,weg:ShellAltWeg=[]):void=>{
      if(typeof roh==='string' && /(?:^|\.)(?:result|args_preview)$/.test(pfad) && /^\s*[\[{]/.test(roh)){
        try{const obj=JSON.parse(roh);walk(obj,maskiereShellDaten(obj,werte,true).daten,pfad,[...weg,null]);return;}catch{/* freier Logtext */}
      }
      if(JSON.stringify(roh)===JSON.stringify(neu))return;
      if(typeof roh==='string' && typeof neu==='string'){
        if(/^\s*[\[{]/.test(roh) && /^\s*[\[{]/.test(neu))try{walk(JSON.parse(roh),JSON.parse(neu),pfad,[...weg,null]);return;}catch{/* freie Logzeile */}
        const spannen=ersetzteSpannen(roh,neu),feld=feldOhneIndex(pfad);
        if(!spannen){aufnehmen(roh,feld,feld.split('.').pop()??feld,'offene_zuordnung',neu,pfad,{tabelle:row.tabelle,id:row.id,weg,start:null,ende:null});return;}
        for(const s of spannen){
          const vor=roh.slice(0,s.start),kv=/([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*["']?$/.exec(vor);
          const schluessel=kv?.[1]??(/Bearer\s+$/i.test(vor)?'Bearer':feld.split('.').pop()??feld);
          aufnehmen(s.wert,feld,schluessel,bekannt.has(s.wert)?'literal':'muster',neu,pfad,{tabelle:row.tabelle,id:row.id,weg,start:s.start,ende:s.start+s.wert.length});
        }
        return;
      }
      if(Array.isArray(roh) && Array.isArray(neu)){roh.forEach((v,i)=>walk(v,neu[i],pfad+'['+i+']',[...weg,i]));return;}
      if(roh && neu && typeof roh==='object' && typeof neu==='object' && !Array.isArray(roh) && !Array.isArray(neu)){
        for(const [k,v]of Object.entries(roh))walk(v,(neu as Record<string,unknown>)[k],pfad?pfad+'.'+k:k,[...weg,k]);
        return;
      }
      // Ein ganzer JSON-Feldwert wurde ersetzt (auch Zahl/Objekt). Hash bleibt intern.
      const feld=feldOhneIndex(pfad),text=JSON.stringify(roh)??String(roh);
      aufnehmen(text,feld,feld.split('.').pop()??feld,'muster',JSON.stringify(neu)??PLATZ,pfad,{tabelle:row.tabelle,id:row.id,weg,start:null,ende:null});
    };
    walk(row.daten,safe,'');
  }
  const aus=[...gruppen.values()];
  for(const g of aus)geprueft.set(g,signatur(g));
  return aus;
}

function anfrage(g:ShellAltGruppe,opt:{project:string|null;agent_id?:string}):JevAnfrage {
  if(geprueft.get(g)!==signatur(g))throw new Error('Nur unveraenderte, von der gemeinsamen Maske erzeugte Fundgruppen auswerten');
  const state=maskiereShellDaten({
    task:'Classify one historical shell-output masking match; never infer a secret from its hash.',
    feld:g.feld,schluessel:g.schluessel,fundart:g.fundart,wertlaenge:g.wertlaenge,kontext:g.kontext,
    hinweis:'The value is always [WERT]. Missing evidence requires keine_passt. No cleanup is authorized by this classification.'
  },[],true).daten;
  return {funktion:'entscheidung',project:opt.project,agent_id:opt.agent_id,state,questions:{bewertung:{
    type:'choice',instructions:'Classify the masked finding using only the supplied field name and context. Pick exactly one option. Missing evidence: keine_passt.',
    criteria:{
      geheimnis:'Choose when the context identifies an actual credential or confidential value that should be redacted.',
      beispiel:'Choose when the context explicitly identifies a placeholder or illustrative example rather than an actual credential.',
      falsch:'Choose when a public configuration value or ordinary text was incorrectly matched as confidential.',
      keine_passt:'Choose when none applies or the masked evidence is insufficient to distinguish the other options.'
    }
  }}};
}
/** Schätzung ist nur informativ; tatsächliche usage.cost wird vom gemeinsamen Jev-Client gebucht. */
export function schaetzeShellAltbestandKosten(gruppen:readonly ShellAltGruppe[]){
  const input_tokens_geschaetzt=gruppen.reduce((n,g)=>n+Math.ceil(JSON.stringify(anfrage(g,{project:null})).length/4),0);
  const preis_je_mio=jevPreisJeMio();
  return {gruppen:gruppen.length,input_tokens_geschaetzt,preis_je_mio,usd_geschaetzt:input_tokens_geschaetzt*preis_je_mio/1e6,kostentor:false as const};
}
export async function bewerteShellAltbestand(gruppen:readonly ShellAltGruppe[],
  opt:{project:string|null;agent_id?:string},
  deps:{rufeJev?:(a:JevAnfrage)=>Promise<JevErgebnis>;beiBudget?:(hinweis:string)=>void|Promise<void>}={}){
  const bewertungen:ShellAltEntscheidung[]=[],kosten=schaetzeShellAltbestandKosten(gruppen);
  let usd=0;
  for(const g of gruppen){
    const jr=await(deps.rufeJev??rufeJev)(anfrage(g,opt));
    if(!jr.ok){
      if(jr.grund==='budget'){
        const hinweis='Globale Jev-Budget-Bremse: Koordinator informieren; Fundgruppen bleiben offen, kein stiller Teil-Erfolg.';
        await deps.beiBudget?.(hinweis);
        return {status:'budget_pause' as const,bewertungen,verbleibend:gruppen.length-bewertungen.length,hinweis,kosten,usd};
      }
      bewertungen.push({gruppe:g.id,bewertung:'offen',confidence:null,grund:'jev_'+jr.grund});continue;
    }
    usd+=jr.kosten.usd;
    const antwort=jr.daten.answers?.bewertung,choice=antwort?.choice,c=antwort?.confidence;
    const confidence=typeof c==='number' && Number.isFinite(c) && c>=0 && c<=1?c:null;
    const gueltig=choice==='geheimnis'||choice==='beispiel'||choice==='falsch';
    const passt=gueltig && confidence!==null && confidence>=0.7 && g.fundart!=='offene_zuordnung';
    bewertungen.push({gruppe:g.id,bewertung:passt?choice as ShellAltBewertung:'offen',confidence,
      grund:passt?'jev':g.fundart==='offene_zuordnung'?'zuordnung_mehrdeutig':choice==='keine_passt'?'keine_passt':'unter_tor_oder_ungueltig'});
  }
  return {status:'fertig' as const,bewertungen,verbleibend:0,kosten,usd};
}

/** Read-only Kennzeichnung des vom Koordinator vorgegebenen Speicherzeitfensters, keine Reparatur. */
export function zaehleShellUebermaskierungsFenster(zeilen:readonly ShellAltZeile[],fenster:{von:string;bis:string}){
  const von=Date.parse(fenster.von),bis=Date.parse(fenster.bis);
  if(!Number.isFinite(von)||!Number.isFinite(bis)||bis<=von)throw new Error('Gueltiges Speicherzeitfenster [von,bis) erforderlich');
  const aus={shell_jobs:{zeilen_im_fenster:0,mit_platzhaltern:0,zeit_unbekannt:0},
    tool_calls:{zeilen_im_fenster:0,mit_platzhaltern:0,zeit_unbekannt:0},nicht_reparierbar:true as const,
    hinweis:'Platzhalter im bekannten Fehlerzeitfenster sind potenziell uebermaskiert; verlorene Zeichen werden nicht rekonstruiert.'};
  for(const row of zeilen){
    const t=row.gespeichert_am instanceof Date?row.gespeichert_am.getTime():typeof row.gespeichert_am==='string'?Date.parse(row.gespeichert_am):NaN;
    const counter=aus[row.tabelle];
    if(!Number.isFinite(t)){counter.zeit_unbekannt++;continue;}
    if(t>=von && t<bis){counter.zeilen_im_fenster++;if(JSON.stringify(row.daten).includes('[WERT]'))counter.mit_platzhaltern++;}
  }
  return aus;
}

/** Interne Quellkennung; nie Quelltext oder Rohwerte in Marker/Logs speichern. */
export function shellAltQuellHash(row:ShellAltZeile):string{return hash(JSON.stringify(row.daten));}
export interface ShellAltAenderung {
 tabelle:ShellAltZeile['tabelle'];id:string;project:string|null;quell_hash:string;
 daten:Record<string,unknown>;maskiert:number;gruppen:string[];maskiert_pro_gruppe:Record<string,number>;
}
/** Ausschließlich eindeutig zugeordnete, bestätigte Spannen; Beispiele/falsche Treffer bleiben erhalten. */
export function planeShellAltbestand(rows:readonly ShellAltZeile[],werte:readonly string[],entscheidungen:readonly ShellAltEntscheidung[]):ShellAltAenderung[]{
 const bewertet=new Map(entscheidungen.map(b=>[b.gruppe,b]));
 const gruppen=gruppiereShellAltbestand(rows,werte),proZeile=new Map<string,Array<{ziel:ShellAltZiel;gruppe:string}>>();
 for(const g of gruppen){
  const b=bewertet.get(g.id);
  if(b?.bewertung!=='geheimnis'||b.confidence===null||b.confidence<0.7||b.confidence>1||!Number.isFinite(b.confidence)||g.fundart==='offene_zuordnung')continue;
  for(const ziel of ziele.get(g)??[]){
   const key=ziel.tabelle+':'+ziel.id;if(!proZeile.has(key))proZeile.set(key,[]);
   proZeile.get(key)!.push({ziel,gruppe:g.id});
  }
 }
 const aus:ShellAltAenderung[]=[];
 for(const row of rows){
  const targets=proZeile.get(row.tabelle+':'+row.id);if(!targets?.length)continue;
  const proWeg=new Map<string,Array<{ziel:ShellAltZiel;gruppe:string}>>();
  for(const t of targets){const key=JSON.stringify(t.ziel.weg);if(!proWeg.has(key))proWeg.set(key,[]);proWeg.get(key)!.push(t);}
  let maskiert=0;const maskiert_pro_gruppe:Record<string,number>={};
  const zaehle=(gruppe:string)=>{maskiert++;maskiert_pro_gruppe[gruppe]=(maskiert_pro_gruppe[gruppe]??0)+1;};
  const transform=(v:unknown,weg:ShellAltWeg=[]):unknown=>{
   const match=proWeg.get(JSON.stringify(weg));
   if(match){
    if(match.some(t=>t.ziel.start===null)){zaehle(match.find(t=>t.ziel.start===null)!.gruppe);return PLATZ;}
    if(typeof v!=='string')throw new Error('Altbestand-Spanne passt nicht zum Feld');
    const spannen=[...new Map(match.map(t=>[t.ziel.start+':'+t.ziel.ende,t.ziel])).values()].sort((a,b)=>b.start!-a.start!);
    let text=v,grenze=v.length;
    for(const s of spannen){
     if(s.start!<0||s.ende!>grenze||s.start!>=s.ende!)throw new Error('Altbestand-Spannen überlappen');
     text=text.slice(0,s.start!)+PLATZ+text.slice(s.ende!);grenze=s.start!;zaehle(match.find(t=>t.ziel.start===s.start&&t.ziel.ende===s.ende)!.gruppe);
    }
    return text;
   }
   if(typeof v==='string'&&targets.some(t=>JSON.stringify(t.ziel.weg.slice(0,weg.length+1))===JSON.stringify([...weg,null]))){
    const parsed=JSON.parse(v),neu=transform(parsed,[...weg,null]);return JSON.stringify(neu);
   }
   if(Array.isArray(v))return v.map((x,i)=>transform(x,[...weg,i]));
   if(v&&typeof v==='object'&&!(v instanceof Date))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,transform(x,[...weg,k])]));
   return v;
  };
  const daten=transform(row.daten) as Record<string,unknown>;
  if(maskiert)aus.push({tabelle:row.tabelle,id:row.id,project:row.project,quell_hash:shellAltQuellHash(row),daten,maskiert,maskiert_pro_gruppe,gruppen:[...new Set(targets.map(t=>t.gruppe))]});
 }
 return aus;
}
