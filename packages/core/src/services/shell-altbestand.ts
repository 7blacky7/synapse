/** P10-T42 Phase 1+2: reine Kandidaten/Gruppen, Jev-Bewertung; keine DB-Schreibzugriffe. */
import {createHash} from 'node:crypto';
import {maskiereShellDaten,maskiereShellText} from './shell-maske.js';
import {sammleShellMaskenTreffer,holeShellLiteralMatcher,type ShellMaskenTreffer,type ShellMaskenRegel} from './shell-masken-katalog.js';
import {istShellJsonGeheimnisName} from './mcp-json-maske.js';
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
  regel:ShellMaskenRegel;name:string;zeile:number;fenster:string;struktur:string;konfiguration:boolean;literal_normales_wort:boolean;
}
export type ShellAltBewertung='geheimnis'|'beispiel'|'falsch'|'offen';
export interface ShellAltEntscheidung {gruppe:string;bewertung:ShellAltBewertung;confidence:number|null;grund:string;}
type ShellAltWeg=Array<string|number|null>;
interface ShellAltZiel {tabelle:ShellAltZeile['tabelle'];id:string;pfad:string;weg:ShellAltWeg;start:number|null;ende:number|null;}
const ziele=new WeakMap<ShellAltGruppe,ShellAltZiel[]>();
const PLATZ='[WERT]';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const geprueft=new WeakMap<ShellAltGruppe,string>();
// Private Prüfwerte verlassen weder Gruppenobjekt noch Anfrage; gemeinsamer Literal-Katalog.
const anfrageWerte=new WeakMap<ShellAltGruppe,readonly string[]>();
const zielLiteral=new WeakMap<ShellAltGruppe,string>();
const signatur=(g:ShellAltGruppe)=>hash(JSON.stringify(g));
const feldOhneIndex=(s:string)=>s.replace(/\[\d+\]/g,'[]');

/** ±3 echte Feldzeilen; alle anderen Treffer bleiben [WERT], genau ein Treffer ist markiert. */
function trefferFenster(roh:string,t:ShellMaskenTreffer,alle:readonly ShellMaskenTreffer[],werte:readonly string[]){
 const lines=roh.split('\n'),zeile=roh.slice(0,t.start).split('\n').length;
 const von=Math.max(0,zeile-4),bis=Math.min(lines.length,zeile+3),aus:string[]=[];
 let offset=0;
 for(let i=0;i<lines.length;i++){
  const line=lines[i],end=offset+line.length;
  if(i>=von&&i<bis){
   const hits=alle.filter(h=>h.start<end&&h.ende>offset).map(h=>({h,start:Math.max(0,h.start-offset),ende:Math.min(line.length,h.ende-offset)}));
   let text='',cursor=0,markPos=-1;
   for(const hit of hits){
    text+=maskiereShellText(line.slice(cursor,hit.start).replaceAll('⟦TREFFER⟧','[WERT]'),werte).text;
    const selected=hit.h===t&&t.start>=offset&&t.start<=end;
    if(selected)markPos=text.length;
    text+=selected?'⟦TREFFER⟧':'[WERT]';cursor=hit.ende;
   }
   text+=maskiereShellText(line.slice(cursor).replaceAll('⟦TREFFER⟧','[WERT]'),werte).text;
   // Lange UI-/JSON-Zeilen horizontal um den gewählten Treffer, niemals am Feldanfang abschneiden.
   if(text.length>600){
    const lo=markPos>=0?Math.max(0,markPos-280):0,hi=Math.min(text.length,lo+600);
    text=(lo?'…':'')+text.slice(lo,hi)+(hi<text.length?'…':'');
   }
   aus.push((i+1)+': '+text);
  }
  offset=end+1;
 }
 return {zeile,fenster:aus.join('\n')};
}
/** Gleiches Literal/Feld/Kategorie plus ausgewähltes Fenster; keine Rohwerte in Gruppen. */
export function gruppiereShellAltbestand(zeilen:readonly ShellAltZeile[],werte:readonly string[]):ShellAltGruppe[]{
 const gruppen=new Map<string,ShellAltGruppe>(),strukturCache=new WeakMap<object,string>();
 const strukturVon=(p:unknown)=>{if(!p||typeof p!=='object')return '';let s=strukturCache.get(p);if(s===undefined){s=maskiereShellText(JSON.stringify(p),werte).text.slice(0,800);strukturCache.set(p,s);}return s;};
 for(const row of zeilen){
  const safe=maskiereShellDaten(row.daten,werte,true).daten;
  const aufnehmen=(roh:string,pfad:string,ziel:ShellAltZiel,t:ShellMaskenTreffer,fenster:string,zeile:number,art:ShellAltGruppe['fundart'],struktur:string)=>{
   const feld=feldOhneIndex(pfad),name=t.name??feld.split('.').pop()??feld;
   const feldSafe=maskiereShellText(feld,werte).text,nameSafe=maskiereShellText(name,werte).text,pfadSafe=maskiereShellText(pfad,werte).text;
   const fundart=pfadSafe===pfad?art:'offene_zuordnung',literal_hash=hash(roh);
   const key=JSON.stringify([literal_hash,feldSafe,nameSafe,fundart,t.regel,zeile,hash(fenster),hash(struktur)]);
   let g=gruppen.get(key);
   if(!g){
    g={id:hash(key),literal_hash,feld:feldSafe,schluessel:nameSafe,name:nameSafe,regel:t.regel,zeile,fenster,
     kontext:fenster,struktur,fundart,wertlaenge:roh.length,konfiguration:t.konfiguration,literal_normales_wort:t.literal_normales_wort,bezuege:[]};
    gruppen.set(key,g);ziele.set(g,[]);anfrageWerte.set(g,werte);zielLiteral.set(g,roh);
   }
   if(fundart!=='offene_zuordnung')ziele.get(g)!.push(ziel);
   if(!g.bezuege.some(b=>b.tabelle===row.tabelle&&b.id===row.id&&b.pfad===pfadSafe))g.bezuege.push({tabelle:row.tabelle,id:row.id,project:row.project,pfad:pfadSafe});
  };
  const walk=(roh:unknown,neu:unknown,pfad:string,weg:ShellAltWeg=[],parents:unknown[]=[]):void=>{
   if(typeof roh==='string'&&/(?:^|\.)(?:result|args_preview)$/.test(pfad)&&/^\s*[\[{]/.test(roh)){
    try{const obj=JSON.parse(roh);walk(obj,maskiereShellDaten(obj,werte,true).daten,pfad,[...weg,null],parents);return;}catch{/* freier Logtext */}
   }
   if(JSON.stringify(roh)===JSON.stringify(neu))return;
   if(typeof roh==='string'&&typeof neu==='string'&&/^\s*[\[{]/.test(roh)&&/^\s*[\[{]/.test(neu)){
    try{walk(JSON.parse(roh),JSON.parse(neu),pfad,[...weg,null],parents);return;}catch{/* freie Logzeile */}
   }
   const teile=pfad.split('.').map(p=>p.replace(/\[\d+\]/g,''));
   const direct=teile[teile.length-1]??'',sensibel=[...teile].reverse().find(istShellJsonGeheimnisName);
   const strukturSafe=parents.slice(-2).reverse().map(strukturVon).join('\n');
   if(typeof roh==='string'&&typeof neu==='string'){
    const meta=sensibel?{name:sensibel,strukturiert:true}:{name:direct};
    let hits=sammleShellMaskenTreffer(roh,werte,meta);
    if(sensibel&&sensibel!==direct)hits=hits.map(h=>({...h,regel:'mcp_json_feld' as const,name:sensibel}));
    if(!hits.length){
     const t:ShellMaskenTreffer={regel:'mcp_json_feld',name:sensibel??direct,start:0,ende:roh.length,konfiguration:false,literal_normales_wort:false};
     aufnehmen(roh,pfad,{tabelle:row.tabelle,id:row.id,pfad,weg,start:null,ende:null},t,'1: ⟦TREFFER⟧ (maskierte Zuordnung unlesbar)',1,'offene_zuordnung',strukturSafe);return;
    }
    for(const t of hits){
     const f=trefferFenster(roh,t,hits,werte);
     aufnehmen(roh.slice(t.start,t.ende),pfad,{tabelle:row.tabelle,id:row.id,pfad,weg,start:t.start,ende:t.ende},t,f.fenster,f.zeile,t.regel==='env_literal'?'literal':'muster',strukturSafe);
    }
    return;
   }
   if(Array.isArray(roh)&&Array.isArray(neu)){roh.forEach((v,i)=>walk(v,neu[i],pfad+'['+i+']',[...weg,i],[...parents,neu]));return;}
   if(roh&&neu&&typeof roh==='object'&&typeof neu==='object'&&!Array.isArray(roh)&&!Array.isArray(neu)){
    for(const [k,v]of Object.entries(roh))walk(v,(neu as Record<string,unknown>)[k],pfad?pfad+'.'+k:k,[...weg,k],[...parents,neu]);return;
   }
   const text=JSON.stringify(roh)??String(roh);
   const t:ShellMaskenTreffer={regel:sensibel===direct?'json_geheimname':'mcp_json_feld',name:sensibel??direct,start:0,ende:text.length,konfiguration:false,literal_normales_wort:false};
   aufnehmen(text,pfad,{tabelle:row.tabelle,id:row.id,pfad,weg,start:null,ende:null},t,'1: '+(t.name??direct)+'=⟦TREFFER⟧',1,'muster',strukturSafe);
  };
  walk(row.daten,safe,'');
 }
 const aus=[...gruppen.values()];for(const g of aus)geprueft.set(g,signatur(g));return aus;
}
function bearerAuthKontext(g:ShellAltGruppe):boolean{
 const text=g.fenster+'\n'+g.struktur;
 // Historischer Quell-/Testcode gehört zu Jev, auch wenn ein Header darin vorkommt.
 if(/\b(?:assert\w*|expect|fixture|mock\w*|describe)\b|\/(?:tests?|fixtures?)\/|\b(?:const|let|var|val|return|function|class|import|package)\b/i.test(text))return false;
 return /\bAuthorization\s*[:=]|["']Authorization["']\s*:/i.test(text)&&/\b(?:curl|http|headers|mcpServers|config)\b|\bAuthorization\s*[:=]|["']Authorization["']\s*:/i.test(text);
}
export function shellAltIstDeterministisch(g:ShellAltGruppe):boolean{
 return g.fundart!=='offene_zuordnung'&&(['url_passwort','sshpass_passwort'].includes(g.regel)||(g.regel==='bearer'&&bearerAuthKontext(g))||(g.regel==='kv_geheimname'&&g.konfiguration));
}
function enthaeltKlartextLiteral(g:ShellAltGruppe,state:unknown):boolean{
 const matcher=holeShellLiteralMatcher(anfrageWerte.get(g)??[]),roh=zielLiteral.get(g)??'';
 const walk=(v:unknown):boolean=>{
  if(typeof v==='string'){
   if(roh.length>=8&&roh!=='[WERT]'&&v.includes(roh))return true;
   if(matcher instanceof RegExp)return [...v.matchAll(new RegExp(matcher.source,matcher.flags))].some(m=>m[0]!=='[WERT]');
   return !!matcher?.some(w=>v.includes(w));
  }
  if(Array.isArray(v))return v.some(walk);
  return !!v&&typeof v==='object'&&Object.values(v).some(walk);
 };
 return walk(state);
}
/** Trefferkontext-v2: alte Marker werden unter ihrer bisherigen Version erhalten. */
export const SHELL_ALT_TORE={geheimnis:0.6,beispiel:0.7,falsch:0.9} as const;

function anfrage(g:ShellAltGruppe,opt:{project:string|null;agent_id?:string}):JevAnfrage|null{
 if(geprueft.get(g)!==signatur(g))throw new Error('Nur unveränderte geprüfte Fundgruppen auswerten');
 const teile=g.fenster.split('⟦TREFFER⟧');
 if(teile.length!==2)return null;
 // Marker vor dem Sicherheitsnetz herausnehmen; beide Seiten separat schützen, dann wieder einsetzen.
 const fenster=teile.map(t=>maskiereShellText(t,anfrageWerte.get(g)??[]).text).join('⟦TREFFER⟧');
 const state=maskiereShellDaten({
  task:'Classify only the selected match in historical shell output. The matched value is not revealed.',
  regel:g.regel,name:g.name,zeile:g.zeile,feld:g.feld,wertlaenge:g.wertlaenge,struktur:g.struktur,
  literal_normales_wort:g.literal_normales_wort,
  hinweis:'The selected match is ⟦TREFFER⟧. Other redactions are [WERT]. Classify the selected match, not every redaction. No cleanup is authorized.'
 },[],true).daten;
 const payload={...state,fenster};
 if((fenster.match(/⟦TREFFER⟧/g)??[]).length!==1||enthaeltKlartextLiteral(g,payload))return null;
 return {funktion:'entscheidung',project:opt.project,agent_id:opt.agent_id,state:payload,questions:{bewertung:{
  type:'choice',instructions:'Judge the selected match from its category, field path, name, numbered ±3-line window and masked structure. Consider source code, UI/XML dumps, logs, CLI help, docs, config/env and auth headers. Pick exactly one option.',
  criteria:{
   geheimnis:'A credential for a real system being set or printed: a password, token or API key in env/config, auth header, connection string or URL. env_literal means a known configured value matched; plain-word occurrences in UI/prose are not evidence of a credential. json_geheimname/mcp_json_feld means the field name triggered masking, not proof the value is a credential.',
   beispiel:'The selected match is a placeholder, template, documentation snippet, test fixture or illustrative example.',
   falsch:'The selected match is normal source code, UI/XML attributes, log/status text, identifiers, hashes, key IDs, flags, numbers, paths, tokenizer data or prose rather than a credential.',
   keine_passt:'Only when the selected window/structure is too short, unlocatable or garbled to classify.'
  }
 }}};
}
/** Schätzung ist nur informativ; tatsächliche usage.cost wird vom gemeinsamen Jev-Client gebucht. */
export function schaetzeShellAltbestandKosten(gruppen:readonly ShellAltGruppe[]){
  const input_tokens_geschaetzt=gruppen.reduce((n,g)=>{const a=shellAltIstDeterministisch(g)?null:anfrage(g,{project:null});return n+(a?Math.ceil(JSON.stringify(a).length/4):0);},0);
  const preis_je_mio=jevPreisJeMio();
  return {gruppen:gruppen.length,input_tokens_geschaetzt,preis_je_mio,usd_geschaetzt:input_tokens_geschaetzt*preis_je_mio/1e6,kostentor:false as const};
}
export async function bewerteShellAltbestand(gruppen:readonly ShellAltGruppe[],
  opt:{project:string|null;agent_id?:string},
  deps:{rufeJev?:(a:JevAnfrage)=>Promise<JevErgebnis>;beiBudget?:(hinweis:string)=>void|Promise<void>}={}){
  const bewertungen:ShellAltEntscheidung[]=[],kosten=schaetzeShellAltbestandKosten(gruppen);
  let usd=0;
  for(const g of gruppen){
    if(geprueft.get(g)!==signatur(g))throw new Error('Nur unveränderte geprüfte Fundgruppen auswerten');
    if(shellAltIstDeterministisch(g)){bewertungen.push({gruppe:g.id,bewertung:'geheimnis',confidence:1,grund:'deterministisch'});continue;}
    const a=anfrage(g,opt);
    if(!a){bewertungen.push({gruppe:g.id,bewertung:'offen',confidence:null,grund:'fenster_unklar'});continue;}
    const jr=await(deps.rufeJev??rufeJev)(a);
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
    const passt=gueltig && confidence!==null && confidence>=SHELL_ALT_TORE[choice as keyof typeof SHELL_ALT_TORE] && g.fundart!=='offene_zuordnung';
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
 daten:Record<string,unknown>;maskiert:number;gruppen:string[];maskiert_pro_gruppe:Record<string,number>;maskiert_pro_bezug:Record<string,number>;
}
/** Ausschließlich eindeutig zugeordnete, bestätigte Spannen; Beispiele/falsche Treffer bleiben erhalten. */
export function planeShellAltbestand(rows:readonly ShellAltZeile[],werte:readonly string[],entscheidungen:readonly ShellAltEntscheidung[]):ShellAltAenderung[]{
 const bewertet=new Map(entscheidungen.map(b=>[b.gruppe,b]));
 const gruppen=gruppiereShellAltbestand(rows,werte),proZeile=new Map<string,Array<{ziel:ShellAltZiel;gruppe:string}>>();
 for(const g of gruppen){
  const b=bewertet.get(g.id);
  if(b?.bewertung!=='geheimnis'||b.confidence===null||b.confidence<SHELL_ALT_TORE.geheimnis||b.confidence>1||!Number.isFinite(b.confidence)||g.fundart==='offene_zuordnung')continue;
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
  let maskiert=0;const maskiert_pro_gruppe:Record<string,number>={},maskiert_pro_bezug:Record<string,number>={};
  const zaehle=(gruppe:string,pfad:string)=>{maskiert++;maskiert_pro_gruppe[gruppe]=(maskiert_pro_gruppe[gruppe]??0)+1;const key=gruppe+':'+pfad;maskiert_pro_bezug[key]=(maskiert_pro_bezug[key]??0)+1;};
  const transform=(v:unknown,weg:ShellAltWeg=[]):unknown=>{
   const match=proWeg.get(JSON.stringify(weg));
   if(match){
    if(match.some(t=>t.ziel.start===null)){const whole=match.find(t=>t.ziel.start===null)!;zaehle(whole.gruppe,whole.ziel.pfad);return PLATZ;}
    if(typeof v!=='string')throw new Error('Altbestand-Spanne passt nicht zum Feld');
    const spannen=[...new Map(match.map(t=>[t.ziel.start+':'+t.ziel.ende,t.ziel])).values()].sort((a,b)=>b.start!-a.start!);
    let text=v,grenze=v.length;
    for(const s of spannen){
     if(s.start!<0||s.ende!>grenze||s.start!>=s.ende!)throw new Error('Altbestand-Spannen überlappen');
     text=text.slice(0,s.start!)+PLATZ+text.slice(s.ende!);grenze=s.start!;const target=match.find(t=>t.ziel.start===s.start&&t.ziel.ende===s.ende)!;zaehle(target.gruppe,target.ziel.pfad);
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
  if(maskiert)aus.push({tabelle:row.tabelle,id:row.id,project:row.project,quell_hash:shellAltQuellHash(row),daten,maskiert,maskiert_pro_gruppe,maskiert_pro_bezug,gruppen:[...new Set(targets.map(t=>t.gruppe))]});
 }
 return aus;
}
