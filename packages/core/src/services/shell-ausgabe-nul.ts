/** P9-T26: PostgreSQL TEXT und JSONB erlauben kein U+0000. Nach der Secretmaske anwenden. */
export function shellNulText(text:string):{text:string;anzahl:number}{
 let anzahl=0;return {text:text.replace(/\u0000/g,()=>{anzahl++;return '\\0';}),anzahl};
}
export function shellNulDaten<T>(data:T):{daten:T;anzahl:number}{
 let anzahl=0;
 const walk=(v:unknown):unknown=>{
  if(typeof v==='string'){const safe=shellNulText(v);anzahl+=safe.anzahl;return safe.text;}
  if(Array.isArray(v))return v.map(walk);
  if(v&&typeof v==='object'&&!(v instanceof Date))return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));
  return v;
 };
 const daten=walk(data) as T;return {daten,anzahl};
}
