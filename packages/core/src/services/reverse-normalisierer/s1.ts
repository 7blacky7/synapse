/** RV14: bounded, masked records for the EXISTING reverse_code_* tables. No tool execution. */
import {createHash} from 'node:crypto';
import {maskiereMitKatalog} from '../masken-katalog.js';
import {teileReverseText,REVERSE_TEXTSTUECK_BYTES} from '../reverse-code-stuecke.js';
export interface NormalSymbol {art:string;name:string|null;wert:string|null;zeile:number;ende:number;adresse:number|null;groesse:number|null}
export interface NormalDatei {pfad:string;schicht:'S1'|'S2';typ:string;inhalt:string;symbole:NormalSymbol[];kanten:{caller:string;callee:string;zeile:number}[]}
export interface NormalErgebnis {dateien:NormalDatei[];dateiKandidaten:string[];maskiert:number;gekappt:boolean}
/** stueckBytes: wirksames s1_textstueck_bytes (P18-T86); ohne Angabe der Katalogstandard. */
export interface NormalBudget {maxBytes:number;maxEintraege:number;stueckBytes?:number}
export const adresse=(v:unknown):number|null=>{
 const n=typeof v==='number'?v:typeof v==='string'&&/^(?:0x[0-9a-f]+|\d+)$/i.test(v)?Number(v):NaN;
 return Number.isSafeInteger(n)&&n>=0?n:null;
};
export const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function normalSammler(b:NormalBudget){
 if(!Number.isSafeInteger(b.maxBytes)||b.maxBytes<1||!Number.isSafeInteger(b.maxEintraege)||b.maxEintraege<1)throw new Error('normalisierer_budget_ungueltig');
 const r:NormalErgebnis={dateien:[],dateiKandidaten:[],maskiert:0,gekappt:false};
 let bytes=0,eintraege=0;
 const mask=(v:string)=>{const x=maskiereMitKatalog(v,'reverse');r.maskiert+=x.treffer;return x.text;};
 return {r,mask,add(d:NormalDatei){
   const c:NormalDatei={...d,pfad:mask(d.pfad),inhalt:mask(d.inhalt),
    symbole:d.symbole.map(s=>({...s,name:s.name===null?null:mask(s.name),wert:s.wert===null?null:mask(s.wert)})),
    kanten:d.kanten.map(k=>({...k,caller:mask(k.caller),callee:mask(k.callee)}))};
   const n=Buffer.byteLength(JSON.stringify(c)),count=c.symbole.length+c.kanten.length;
   if(bytes+n>b.maxBytes||eintraege+count>b.maxEintraege){r.gekappt=true;return;}
   bytes+=n;eintraege+=count;r.dateien.push(c);
   for(const s of c.symbole)if(s.art==='string'&&s.wert&&/(?:^|[\/\\])?[\w.-]+\.[a-z0-9]{1,8}$/i.test(s.wert)&&!r.dateiKandidaten.includes(s.wert))r.dateiKandidaten.push(s.wert);
  }};
}
export function normalisiereS1(input:{strings:{text:string;adresse?:number|null}[];importe:{name:string;adresse?:number|null}[]},b:NormalBudget):NormalErgebnis{
 const s=normalSammler(b),stueck=b.stueckBytes??REVERSE_TEXTSTUECK_BYTES;
 for(const [pfad,art,rows] of [
  ['strings.txt','string',input.strings.map(x=>({wert:x.text,name:null,adresse:x.adresse??null}))],
  ['imports.txt','import',input.importe.map(x=>({wert:x.name,name:x.name,adresse:x.adresse??null}))]
 ] as const){
  let content:string[]=[],symbols:NormalSymbol[]=[],size=0,part=0;
  const flush=()=>{if(!content.length&&part>0)return;s.add({pfad:part===0?pfad:pfad.replace('.txt','-'+String(part+1).padStart(4,'0')+'.txt'),
    schicht:'S1',typ:'txt',inhalt:content.join('\n'),symbole:symbols,kanten:[]});part++;content=[];symbols=[];size=0;};
  for(const row of rows){
   const value=row.wert.replace(/[\r\n]+/g,' ');
   // P18-T86/T88: überlange Einzelwerte UTF-8-sicher in Teile zerlegen statt verwerfen; jeder Teil bleibt suchbar.
   const teile=Buffer.byteLength(value)+1>stueck?teileReverseText(value,stueck-1):[value];
   for(const teil of teile){
    const n=Buffer.byteLength(teil)+1;
    if(size+n>stueck)flush();
    content.push(teil);symbols.push({art,name:row.name,wert:teil,adresse:row.adresse,groesse:null,zeile:content.length,ende:content.length});size+=n;
   }
  }
  flush();
 }
 return s.r;
}
/** Caller owns transaction/layer fingerprint; never writes project code tables. */
export async function uebernehmeNormalisiert(db:{query:Function},e:{reverseId:string;dateiId:string;pfad:string;fingerabdruck:string},r:NormalErgebnis):Promise<void>{
 const files=r.dateien.map(d=>({...d,p:e.pfad+'@'+d.schicht+'/'+d.pfad})).map(d=>({...d,id:hash([e.reverseId,d.p])}));
 if(!files.length)return;
 await db.query('DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND file_path=ANY($2::text[])',[e.reverseId,files.map(d=>d.p)]);
 await db.query(`INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,file_size,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt)
   SELECT u.id,$1,u.pfad,u.name,u.typ,u.groesse,u.inhalt,u.hash,$2::bigint,u.schicht,$3,to_tsvector('simple',u.inhalt),to_tsvector('simple',u.inhalt)
   FROM unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::int[],$9::text[],$10::text[],$11::text[]) AS u(id,pfad,name,typ,groesse,inhalt,hash,schicht)`,
   [e.reverseId,e.dateiId,e.fingerabdruck,files.map(d=>d.id),files.map(d=>d.p),files.map(d=>d.pfad),files.map(d=>d.typ),
    files.map(d=>Buffer.byteLength(d.inhalt)),files.map(d=>d.inhalt),files.map(d=>hash(d.inhalt)),files.map(d=>d.schicht)]);
 const symbols=files.flatMap(d=>d.symbole.map((s,i)=>({...s,p:d.p,id:hash([d.id,i]),schicht:d.schicht})));
 if(symbols.length)await db.query(`INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck,adresse,groesse_bytes)
   SELECT u.id,$1,u.pfad,u.art,u.name,u.wert,u.zeile,u.ende,$2::bigint,u.schicht,$3,u.adresse,u.groesse
   FROM unnest($4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::int[],$10::int[],$11::text[],$12::bigint[],$13::bigint[]) AS u(id,pfad,art,name,wert,zeile,ende,schicht,adresse,groesse)`,
   [e.reverseId,e.dateiId,e.fingerabdruck,symbols.map(s=>s.id),symbols.map(s=>s.p),symbols.map(s=>s.art),symbols.map(s=>s.name),symbols.map(s=>s.wert),
    symbols.map(s=>s.zeile),symbols.map(s=>s.ende),symbols.map(s=>s.schicht),symbols.map(s=>s.adresse),symbols.map(s=>s.groesse)]);
 const edges=files.flatMap(d=>d.kanten.map(k=>({...k,p:d.p,schicht:d.schicht})));
 if(edges.length)await db.query(`INSERT INTO reverse_code_kanten(eintrag_id,file_path,caller_scope,callee_name,line_number,call_kind,confidence,datei_id,schicht,fingerabdruck)
   SELECT $1,u.pfad,u.caller,u.callee,u.zeile,'call',1.0,$2::bigint,u.schicht,$3
   FROM unnest($4::text[],$5::text[],$6::text[],$7::int[],$8::text[]) AS u(pfad,caller,callee,zeile,schicht)`,
   [e.reverseId,e.dateiId,e.fingerabdruck,edges.map(k=>k.p),edges.map(k=>k.caller),edges.map(k=>k.callee),edges.map(k=>k.zeile),edges.map(k=>k.schicht)]);
}
