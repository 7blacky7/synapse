/** P18-T28/RV18: @ref aus dem Kommentarindex; Reverse-Inhalte über autorisierten Transport. */
import {getPool} from '../db/client.js';
import {fuehreReverseAus} from './reverse-tool.js';
import {maskiereMitKatalog} from './masken-katalog.js';
type Row=Record<string,unknown>;
export interface RefVergleichDb {query(sql:string,values?:unknown[]):Promise<{rows:Row[]}>;}
export interface RefVergleichOptionen {
 db?:RefVergleichDb;
 reverse?:(args:Row)=>Promise<Row>;
}
export const REF_VERGLEICH_PARAMETER={
 ref_vergleich:{type:'boolean',description:'Nur read: @ref-Kommentare mit der Originalfunktion vergleichen; Standard aus.'},
 name:{type:'string',description:'read mit ref_vergleich: optional exakter Name der neuen Funktion.'},
} as const;
function grenze(name:string,fallback:number):number {
 const n=Number(process.env[name]??fallback);
 if(!Number.isSafeInteger(n)||n<1)throw new Error('Ungültige Vergleichsgrenze '+name);
 return n;
}
function daten(r:Row):Row {
 if(r.structuredContent&&typeof r.structuredContent==='object')return r.structuredContent as Row;
 if(Array.isArray(r.content)){
  for(const c of r.content){if(c?.type==='text'){try{return JSON.parse(c.text);}catch{/* kein JSON-Text */}}}
  return {fehlercode:'werkzeug_fehler',status:'fehler'};
 }
 return r;
}
const maske=(s:unknown)=>maskiereMitKatalog(String(s??''),'reverse').text;
/** Beide files(read)-Wege rufen nur bei explizitem true hierher. Kein Schreiben. */
export async function refVergleich(a:{project:string;file_path:string;content:string;agent_id?:string;name?:string},o:RefVergleichOptionen={}):Promise<Row>{
 const db=o.db??getPool(),reverse=o.reverse??fuehreReverseAus;
 const max=grenze('SYNAPSE_REF_VERGLEICH_MAX_MARKEN',10),budget=grenze('SYNAPSE_REVERSE_ANTWORT_MAX',80000);
 const fenster=grenze('SYNAPSE_REF_VERGLEICH_FENSTER_ZEILEN',200);
 const comments=(await db.query("SELECT line_start,value FROM code_symbols WHERE project=$1 AND file_path=$2 AND symbol_type='comment' AND value ILIKE '%@ref%' ORDER BY line_start,id LIMIT $3",[a.project,a.file_path,max+1])).rows;
 const vergleiche:Row[]=[],lines=a.content.split('\n'),seen=new Set<string>();let gekappt=comments.length>max;
 let marken=0;
 for(const comment of comments){
  const value=String(comment.value??'');
  // Nur die bereits indizierten Kommentare werden nach der vereinbarten Marke durchsucht.
  const regex=/@ref\s+([^\s:]{1,200}):([^\s:]{1,4096}):([^\s*]{1,4096})/g;
  for(const m of value.matchAll(regex)){
   const line=Number(comment.line_start)+value.slice(0,m.index).split('\n').length-1;
   const key=line+':'+m[0];if(seen.has(key))continue;seen.add(key);
   if(++marken>max){gekappt=true;break;}
   if(m[2]==='erkenntnis'){
    const v=/^([1-9][0-9]*)@v([1-9][0-9]*)$/.exec(m[3]);
    const item:Row={marke:maske(m[0]),art:'erkenntnis',original:{reverse_id:m[1]},neue_funktion:null};
    if(!v)item.fehlercode='ref_ungueltig';
    else{
     try{
      const r=daten(await reverse({project:a.project,agent_id:a.agent_id,action:'erkenntnis_get',reverse_id:m[1],verweis_id:v[1],version:v[2]}));
      if(r.fehlercode)item.fehlercode=r.erkenntnis_fehler??r.fehlercode;
      else item.original={...r.erkenntnis as Row,neueste_version:r.neueste_version,neuester_status:r.neuester_status};
     }catch{item.fehlercode='werkzeug_fehler';}
    }
    vergleiche.push(item);continue;
   }
   let funktion=m[3],schicht='S3';
   if(funktion.endsWith(':S2')){funktion=funktion.slice(0,-3);schicht='S2';}
   const original:Row={reverse_id:m[1],datei:m[2],funktion,schicht,status:'offen'};
   const item:Row={marke:maske(m[0]),neue_funktion:null,original};
   const f=(await db.query("SELECT name,line_start,line_end FROM code_symbols WHERE project=$1 AND file_path=$2 AND symbol_type='function' AND ((line_start<=$3 AND COALESCE(line_end,line_start)>=$3) OR line_start>$3) ORDER BY CASE WHEN line_start<=$3 THEN 0 ELSE 1 END,CASE WHEN line_start<=$3 THEN COALESCE(line_end,line_start)-line_start END,line_start,id LIMIT 1",[a.project,a.file_path,line])).rows[0];
   if(a.name&&f?.name!==a.name)continue;
   if(f){
    const from=Number(f.line_start),to=Math.min(lines.length,Number(f.line_end??from+fenster-1));
    item.neue_funktion={name:maske(f.name),from_line:from,to_line:to,content:maske(lines.slice(from-1,to).join('\n'))};
   }else{item.fehlercode='neue_funktion_nicht_gefunden';}
   const base={project:a.project,agent_id:a.agent_id,reverse_id:m[1]};
   try{
    if(!funktion||m[2].includes('@S')||m[2].startsWith('/')||m[2].split('/').some(x=>!x||x==='.'||x==='..')){item.fehlercode='ref_ungueltig';original.status='fehler';}
    else{
     const prefix=m[2]+'@'+schicht;
     const funcs=daten(await reverse({...base,action:'functions',file_path:prefix,name:funktion,limit:Math.min(200,grenze('SYNAPSE_REVERSE_CODE_MAX_LIMIT',500))}));
     if(funcs.fehlercode){item.fehlercode=funcs.fehlercode;original.status=funcs.status??'fehler';for(const k of ['auftrag_id','eta','container','schicht_angefragt'])if(funcs[k]!==undefined)original[k]=funcs[k];}
     else{
      const address=/^0x[0-9a-f]+$/i.test(funktion);
      const candidates=(Array.isArray(funcs.functions)?funcs.functions:[]).filter((x:Row)=>typeof x.file_path==='string'&&x.file_path.startsWith(prefix+'/')&&(address||x.name===funktion));
      if(candidates.length!==1||funcs.gekappt){item.fehlercode=candidates.length>1||funcs.gekappt?'ref_mehrdeutig':'nicht_gefunden';original.status='fehler';}
      else{
       const f=candidates[0],from=Number(f.line_start),to=Number(f.line_end??from+fenster-1);
       const r=daten(await reverse({...base,action:'file',file_path:f.file_path,from_line:from,to_line:Math.min(to,from+fenster-1)}));
       original.status=r.status??(r.fehlercode?'fehler':'fertig');
       if(r.fehlercode){item.fehlercode=r.fehlercode;for(const k of ['auftrag_id','eta','container','schicht_angefragt'])if(r[k]!==undefined)original[k]=r[k];}
       else{original.content=maske(r.content);original.file_path=maske(f.file_path);original.from_line=from;original.to_line=(r.returned_range as Row|undefined)?.to??Math.min(to,from+fenster-1);original.gekappt=Boolean(r.gekappt)||to>=from+fenster;}
      }
     }
    }
   }catch{item.fehlercode='werkzeug_fehler';original.status='fehler';}
   // Berechtigung scheitert im Reverse-Transport vor Symbol-/Inhaltsausgabe.
   vergleiche.push(item);
  }
  if(marken>max)break;
 }
 const result:Row={vergleiche,vergleiche_gekappt:gekappt};
 // Gemeinsames Budget für ALLE neuen und alten Funktionen, nach Maskierung.
 while(Buffer.byteLength(JSON.stringify(result))>budget&&vergleiche.length){
  const texts=vergleiche.flatMap(v=>[v.neue_funktion,v.original]).filter((v):v is Row & {content:string}=>!!v&&typeof v==='object'&&typeof (v as Row).content==='string'&&String((v as Row).content).length>0).sort((x,y)=>y.content.length-x.content.length);
  if(texts.length){const t=texts[0];t.content=t.content.slice(0,Math.floor(t.content.length/2));t.gekappt=true;}
  else vergleiche.pop();
  result.vergleiche_gekappt=true;
 }
 return result;
}
