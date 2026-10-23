/** P18-T84: formatneutrale Aussagen, Originalanker und unveraenderliche Zielversionen. */
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {maskiereMitKatalog} from './masken-katalog.js';
import {reverseEintragSichtbar} from './reverse-sichtbarkeit.js';
export type ErkenntnisRow=Record<string,any>;
export class ErkenntnisFehler extends Error {
 constructor(readonly kennung:string,readonly extra:ErkenntnisRow={}){super(kennung);}
}
export function erkenntnisFehler(code:string,extra:ErkenntnisRow={}):never{throw new ErkenntnisFehler(code,extra);}
export function objekt(v:unknown):ErkenntnisRow {
 if(!v||typeof v!=='object'||Array.isArray(v))erkenntnisFehler('erkenntnis_inhalt_ungueltig');
 return v as ErkenntnisRow;
}
export function nur(v:ErkenntnisRow,keys:string[]):void{
 if(Object.keys(v).some(k=>!keys.includes(k)))erkenntnisFehler('erkenntnis_feld_unbekannt');
}
export function pflichtText(v:unknown,max:number):string{
 if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v)>max||v.includes('\0'))erkenntnisFehler('erkenntnis_text_ungueltig');
 const m=maskiereMitKatalog(v,'reverse');if(m.text!==v)erkenntnisFehler('erkenntnis_geheimnis_erkannt');
 return v;
}
export function ganzzahl(v:unknown,min=0):number {
 const n=typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):v;
 if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>2147483647)erkenntnisFehler('erkenntnis_zahl_ungueltig');
 return n;
}
export function dezimal(v:unknown):bigint {
 if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||v.length>20)erkenntnisFehler('erkenntnis_offset_ungueltig');
 return BigInt(v);
}
export function sha(v:unknown):string {
 if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))erkenntnisFehler('erkenntnis_hash_ungueltig');return v;
}
export function pfad(v:unknown,max:number):string{
 const p=pflichtText(v,max);
 if(p.startsWith('/')||p.includes('\\')||/[\x00-\x1f:]/.test(p)||p.split('/').some(x=>!x||x==='.'||x==='..'))erkenntnisFehler('erkenntnis_pfad_ungueltig');
 return p;
}
export function kanonisch(v:unknown):string {
 if(Array.isArray(v))return '['+v.map(kanonisch).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+kanonisch(x)).join(',')+'}';
 return JSON.stringify(v);
}
export const hashInhalt=(v:unknown)=>createHash('sha256').update(kanonisch(v)).digest('hex');
export async function bindung(db:PoolClient,project:string,rid:unknown):Promise<string>{
 const id=pflichtText(rid,200);
 // P18-T109: zentrale Sichtbarkeit (reverse_global_sichtbar EIN = Erkenntnisse global, ohne Bindung).
 if(!(await reverseEintragSichtbar(db,project,id,true)))erkenntnisFehler('nicht_gebunden');
 return id;
}
export async function inhaltZugang(db:PoolClient,project:string,inhalt:ErkenntnisRow):Promise<void>{
 const ids=new Set<string>();
 for(const v of [...(inhalt.belege??[]),...(inhalt.ziele??[])])if(v.reverse_id)ids.add(v.reverse_id);
 for(const rid of ids)await bindung(db,project,rid);
}
export async function pruefeInhalt(db:PoolClient,project:string,rid:string,raw:unknown,maxBelege:number,maxAussagen:number,maxPfad:number,vorher?:ErkenntnisRow):Promise<ErkenntnisRow>{
 const x=objekt(raw);nur(x,['text','status','grund','aussagen','belege','ziele','review']);
 pflichtText(x.text,2147483647);
 if(!['aktiv','korrigiert','zurueckgezogen','widersprochen'].includes(x.status))erkenntnisFehler('erkenntnis_status_ungueltig');
 if(x.status!=='aktiv')pflichtText(x.grund,2147483647);
 if(!Array.isArray(x.belege)||x.belege.length>maxBelege||!Array.isArray(x.aussagen)||!x.aussagen.length||x.aussagen.length>maxAussagen||!Array.isArray(x.ziele)||x.ziele.length>maxBelege)erkenntnisFehler('erkenntnis_budget');
 await inhaltZugang(db,project,x);
 const ids=new Set<string>(),keys=new Set<string>();
 const alt=new Set((vorher?.belege??[]).map(hashInhalt));
 for(const rawBeleg of x.belege){
  const b=objekt(rawBeleg);nur(b,['id','reverse_id','pfad','sha256','art','offset','laenge','adresse','adressraum','ladebasis','funktion','ableitung_pfad','ableitung_sha256','from_line','to_line']);
  pflichtText(b.id,200);if(ids.has(b.id))erkenntnisFehler('erkenntnis_beleg_doppelt');ids.add(b.id);
  pfad(b.pfad,maxPfad);sha(b.sha256);
  if(!['bytes','funktion','ableitung'].includes(b.art))erkenntnisFehler('erkenntnis_anker_ungueltig');
  if(b.art==='bytes'){dezimal(b.offset);if(dezimal(b.laenge)<1n)erkenntnisFehler('erkenntnis_bereich_ungueltig');}
  if(b.art==='funktion'){
   pflichtText(b.funktion,maxPfad);dezimal(b.adresse);
   if(!['va','rva','datei'].includes(b.adressraum))erkenntnisFehler('erkenntnis_adressraum_ungueltig');
   if(b.adressraum==='va')dezimal(b.ladebasis);
  }
  if(b.art==='ableitung'){pfad(b.ableitung_pfad,maxPfad);sha(b.ableitung_sha256);if(ganzzahl(b.to_line,1)<ganzzahl(b.from_line,1))erkenntnisFehler('erkenntnis_bereich_ungueltig');}
  // Unveraendert uebernommene historische Belege bleiben auch nach einem Neulauf zitierbar.
  if(alt.has(hashInhalt(b)))continue;
  const f=(await db.query('SELECT id,sha256,groesse FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2',[b.reverse_id,b.pfad])).rows[0];
  if(!f||f.sha256!==b.sha256)erkenntnisFehler('erkenntnis_quellstand_abweichend');
  if(b.art==='bytes'&&dezimal(b.offset)+dezimal(b.laenge)>BigInt(f.groesse))erkenntnisFehler('erkenntnis_bereich_ungueltig');
  if(b.art==='ableitung'){
   const d=(await db.query('SELECT content_hash,content FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2 AND file_path=$3 AND deleted_at IS NULL',[b.reverse_id,f.id,b.ableitung_pfad])).rows[0];
   if(!d||d.content_hash!==b.ableitung_sha256)erkenntnisFehler('erkenntnis_ableitung_abweichend');
   if(typeof d.content!=='string'||b.to_line>d.content.split('\n').length)erkenntnisFehler('erkenntnis_bereich_ungueltig');
  }
 }
 for(const rawAussage of x.aussagen){
  const a=objekt(rawAussage);nur(a,['schluessel','text','konfidenz','begruendung','belege']);
  pflichtText(a.schluessel,200);pflichtText(a.text,2147483647);pflichtText(a.begruendung,2147483647);
  if(keys.has(a.schluessel))erkenntnisFehler('erkenntnis_aussage_doppelt');keys.add(a.schluessel);
  if(!['belegt','vermutet'].includes(a.konfidenz)||!Array.isArray(a.belege)||a.belege.some((id:unknown)=>typeof id!=='string'||!ids.has(id))||a.konfidenz==='belegt'&&!a.belege.length)erkenntnisFehler('erkenntnis_aussage_ungueltig');
 }
 for(const rawZiel of x.ziele){
  const z=objekt(rawZiel);
  if(z.art==='hex_format'){
   nur(z,['art','format_id','version','canonical_hash']);sha(z.canonical_hash);ganzzahl(z.version,1);
   const f=(await db.query("SELECT v.canonical_hash FROM hex_format_versionen v WHERE v.format_id=$1 AND v.version=$2 AND v.herkunft->>'reverse_id'=$3 AND EXISTS(SELECT 1 FROM hex_format_freigaben g WHERE g.format_id=v.format_id AND g.version=v.version AND (g.eintrag_id IS NULL OR g.eintrag_id=$3))",[z.format_id,z.version,rid])).rows[0];
   if(!f||f.canonical_hash!==z.canonical_hash)erkenntnisFehler('erkenntnis_ziel_nicht_lesbar');
  }else if(z.art==='erkenntnis'){
   nur(z,['art','reverse_id','verweis_id','version']);dezimal(z.verweis_id);ganzzahl(z.version,1);
   if(!(await db.query("SELECT 1 FROM reverse_verweis_versionen v JOIN reverse_verweise r ON r.id=v.verweis_id WHERE r.eintrag_id=$1 AND r.id=$2 AND v.version=$3",[z.reverse_id,z.verweis_id,z.version])).rowCount)erkenntnisFehler('erkenntnis_ziel_nicht_lesbar');
  }else if(['reverse_datei','reverse_asset','reverse_funktion'].includes(z.art)){
   nur(z,['art','reverse_id','pfad','sha256','funktion']);pfad(z.pfad,maxPfad);sha(z.sha256);
   const d=(await db.query('SELECT id FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2 AND sha256=$3',[z.reverse_id,z.pfad,z.sha256])).rows[0];
   if(!d)erkenntnisFehler('erkenntnis_ziel_nicht_lesbar');
   if(z.art==='reverse_asset'&&!(await db.query('SELECT 1 FROM reverse_assets WHERE datei_id=$1',[d.id])).rowCount)erkenntnisFehler('erkenntnis_ziel_nicht_lesbar');
   if(z.art==='reverse_funktion'){
    pflichtText(z.funktion,maxPfad);
    if(!(await db.query("SELECT 1 FROM reverse_code_symbole WHERE datei_id=$1 AND name=$2 AND symbol_type='function'",[d.id,z.funktion])).rowCount)erkenntnisFehler('erkenntnis_ziel_nicht_lesbar');
   }
  }else erkenntnisFehler('erkenntnis_ziel_ungueltig');
 }
 return x;
}

export async function quellstaende(db:PoolClient,inhalt:ErkenntnisRow):Promise<ErkenntnisRow[]>{
 const out:ErkenntnisRow[]=[];
 for(const b of inhalt.belege){
  const f=(await db.query('SELECT id,sha256 FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2',[b.reverse_id,b.pfad])).rows[0];
  let status=!f?'quelle_nicht_mehr_verfuegbar':f.sha256!==b.sha256?'quellstand_abweichend':'original_unveraendert';
  if(status==='original_unveraendert'&&b.art==='ableitung'){
   const d=(await db.query('SELECT content_hash FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2 AND file_path=$3 AND deleted_at IS NULL',[b.reverse_id,f.id,b.ableitung_pfad])).rows[0];
   status=!d?'ableitung_nicht_mehr_verfuegbar':d.content_hash!==b.ableitung_sha256?'ableitung_abweichend':'ableitung_unveraendert';
  }
  out.push({beleg_id:b.id,status});
 }
 return out;
}
