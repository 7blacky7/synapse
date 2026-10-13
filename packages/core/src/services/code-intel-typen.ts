/** P16-T15: additive Typbefunde an bestehenden Code-Intel-Antworten. */
import { getPool } from '../db/client.js';
import { getTypPruefDateienFuerPlan } from './file-batch.js';
import { pruefePlanTypen, checkJsAusPg, type TypPruefung } from './typen-pruefung.js';
import type { PruefDatei } from './plan-befunde.js';
type Row=Record<string,unknown>;
const hinweise=new Set<string>();
function pfade(value:unknown,out=new Set<string>()):Set<string>{
  if(Array.isArray(value)) value.forEach(v=>pfade(v,out));
  else if(value&&typeof value==='object') for(const [k,v] of Object.entries(value)) {
    if(k==='file_path'&&typeof v==='string')out.add(v);else pfade(v,out);
  }
  return out;
}
function metadata(pruefung:TypPruefung){
  const {befunde,...meta}=pruefung;
  return {...meta,dateien:pruefung.dateien.map(file_path=>({file_path,befunde:befunde.filter(b=>b.datei===file_path)}))};
}
/** Ein einziger Eingang für REST und stdio. Standardantwort und nicht unterstützte Sprachen bleiben identisch. */
export async function ergaenzeTypbefunde(action:string,args:Row,antwort:Row):Promise<Row>{
  if(args.typen===false || (args.typen!==true&&args.schatten===undefined)
    || !['file','functions','symbols','references','search','tree'].includes(action)
    || antwort.success===false || typeof args.project!=='string')return antwort;
  const project=args.project;
  if(Array.isArray(antwort.staende))return {...antwort,staende:await Promise.all(antwort.staende.map(r=>
    ergaenzeTypbefunde(action,args,r as Row)))};
  const gezielt=pfade(antwort);
  if(['file','functions','symbols'].includes(action)&&typeof args.file_path==='string')gezielt.add(args.file_path);
  if(action==='tree'){
    const prefix=typeof args.path==='string'?args.path:typeof args.file_path==='string'?args.file_path:'';
    const rows=(await getPool().query<{file_path:string}>(
      "SELECT file_path FROM code_files WHERE project=$1 AND deleted_at IS NULL AND ignored=false AND ($2='' OR file_path=$2 OR starts_with(file_path,$2||'/'))",
      [project,prefix.replace(/\/$/,'')])).rows;
    rows.forEach(r=>gezielt.add(r.file_path));
  }
  const plans=typeof antwort.plan_id==='string'?[antwort.plan_id]
    :Array.isArray(antwort.plaene)?antwort.plaene.filter((p):p is string=>typeof p==='string'):[];
  if(plans.length){
    const result:Row[]=[];
    for(const planId of plans){
      const dateien=await getTypPruefDateienFuerPlan(project,planId,
        typeof args.stand_nach_op==='number'?args.stand_nach_op:undefined);
      // file/functions/etc. einer Nicht-TS-Datei bekommen keine Felder aus anderen Plan-Dateien.
      if(action!=='tree'&&!dateien.some(d=>gezielt.has(d.file_path))) {
        // Ein im Ergebnis sichtbarer Aufrufer kann von einer anderen Plan-Datei beeinflusst werden.
        const sichtbare=(await getPool().query<{file_type:string}>(
          'SELECT file_type FROM code_files WHERE project=$1 AND file_path=ANY($2::text[])',[project,[...gezielt]])).rows;
        if(!sichtbare.some(r=>['ts','tsx','mts','cts','js','mjs','cjs'].includes(r.file_type)))continue;
      }
      const typ=await pruefePlanTypen(project,dateien);
      if(typ && (action==='tree'||typ.dateien.some(p=>gezielt.has(p))))
        result.push({plan_id:planId,...metadata(typ)});
    }
    if(result.length)return {...antwort,typbefunde:result.length===1?result[0]:{staende:result}};
  }
  // Ein automatischer Schattenaufruf ohne betroffenen Plan erfindet keine neue Prüfung.
  if(args.typen!==true)return antwort;
  const rows=(await getPool().query<{file_path:string;file_type:string;content:string}>(
    'SELECT file_path,file_type,content FROM code_files WHERE project=$1 AND file_path=ANY($2::text[]) AND deleted_at IS NULL AND ignored=false',
    [project,[...gezielt]])).rows;
  const quellen=(await getPool().query<{file_path:string;content:string}>(
    "SELECT file_path,content FROM code_files WHERE project=$1 AND deleted_at IS NULL AND ignored=false AND file_path LIKE '%.json'",[project])).rows;
  const configs=new Map(quellen.map(r=>[r.file_path,r.content]));
  const unterstuetzt=rows.filter(r=>['ts','tsx','mts','cts'].includes(r.file_type)
    || ['js','mjs','cjs'].includes(r.file_type)&&checkJsAusPg(r.file_path,configs));
  const dateien:PruefDatei[]=unterstuetzt.map(r=>({file_path:r.file_path,basis:r.content,ergebnis:r.content,ops:[]}));
  const typ=await pruefePlanTypen(project,dateien,args.schatten!==undefined);
  let out:Row=typ?{...antwort,typbefunde:metadata(typ)}:antwort;
  const fremde=[...new Set(rows.filter(r=>!unterstuetzt.includes(r)).map(r=>r.file_type))];
  const neu=fremde.filter(t=>{
    const k=[project,args.agent_id??'',t].join('|');
    if(hinweise.has(k))return false;hinweise.add(k);return true;
  });
  while(hinweise.size>512)hinweise.delete(hinweise.values().next().value!);
  if(neu.length)out={...out,typen_hinweis:neu.map(t=>'typen nicht verfügbar für '+t).join('; ')};
  return out;
}
