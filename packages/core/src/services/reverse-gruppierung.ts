/** RV5/RV33: nur Vorschläge; Bestätigung bleibt beim User/Koordinator. Keine Extraktion. */
import {createHash} from 'node:crypto';
import * as path from 'node:path';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {ladeReverseEingangKonfiguration} from '../config/reverse-eingang.js';
import type {ReverseEingangKonfiguration} from '../config/reverse-eingang.js';
export interface ReverseFundDatei {rel_pfad:string;groesse:number;sha256:string;mtime?:string;host?:string;}
export interface ReverseGruppenDatei extends ReverseFundDatei {kopf?:Uint8Array;archiv_format?:string|null;referenzen?:string[];}
export interface ReverseMediumVorschlag {
 art:'image'|'ordner'|'archiv'; bezeichnung:string;dateien:ReverseGruppenDatei[];
 haupt:string;fehlend:string[];satz_sha256:string;confidence:number;alternativen:string[];
}
export interface ReverseGruppenvorschlag {titel:string;wurzel:string;medien:ReverseMediumVorschlag[];fingerabdruck:string;case_kollisionen:string[][];}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const natural=(a:string,b:string)=>a.localeCompare(b,'en',{numeric:true,sensitivity:'variant'});
const ext=(p:string)=>path.posix.extname(p).slice(1).toLowerCase();
export function reverseArchivMagic(bytes:Uint8Array|undefined):string|null {
 if(!bytes)return null;const b=Buffer.from(bytes);
 if(b.length>=4&&['504b0304','504b0506','504b0708'].includes(b.subarray(0,4).toString('hex')))return 'zip';
 if(b.length>=6&&b.subarray(0,6).toString('hex')==='377abcaf271c')return '7z';
 if(b.length>=7&&b.subarray(0,7).toString('hex')==='526172211a0700'||b.length>=8&&b.subarray(0,8).toString('hex')==='526172211a070100')return 'rar';
 if(b.length>=262&&b.subarray(257,262).toString()==='ustar')return 'tar';
 return null;
}
export function reverseOrdnerFingerabdruck(dateien:ReverseFundDatei[],wurzel=''):string {
 return hash(dateien.map(f=>[wurzel?f.rel_pfad.slice(wurzel.length+1):f.rel_pfad,f.groesse,f.sha256]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0));
}
export function reverseGruppieren(input:ReverseGruppenDatei[],cfg:ReverseEingangKonfiguration=ladeReverseEingangKonfiguration()):ReverseGruppenvorschlag[] {
 const gruppen=new Map<string,ReverseGruppenDatei[]>();
 for(const f of input){
  const p=normalisiereSpeicherPfad(f.rel_pfad),root=p.includes('/')?p.split('/')[0]:'';
  const key=root||'';const arr=gruppen.get(key)??[];arr.push({...f,rel_pfad:p});gruppen.set(key,arr);
 }
 return [...gruppen].sort(([a],[b])=>natural(a,b)).flatMap(([key,files])=>{
  files.sort((a,b)=>natural(a.rel_pfad,b.rel_pfad));const wurzel=files[0].rel_pfad.includes('/')?key:'';
  const byPath=new Map(files.map(f=>[f.rel_pfad,f])),used=new Set<string>(),medien:ReverseMediumVorschlag[]=[];
  const caseMap=new Map<string,string[]>();for(const f of files){const k=f.rel_pfad.toLowerCase(),a=caseMap.get(k)??[];a.push(f.rel_pfad);caseMap.set(k,a);}
  const add=(art:ReverseMediumVorschlag['art'],fs:ReverseGruppenDatei[],haupt:string,fehlend:string[]=[],confidence=1,alternativen:string[]=[])=>{
   for(const f of fs)used.add(f.rel_pfad);
   medien.push({art,dateien:fs,haupt,bezeichnung:path.posix.basename(haupt),fehlend,confidence,alternativen,
    satz_sha256:art==='archiv'||art==='image'&&fs.length===1?fs[0].sha256:art==='image'?hash(fs.map(f=>[f.rel_pfad===haupt?'haupt':'begleit',f.groesse,f.sha256]).sort((a,b)=>String(a[2]).localeCompare(String(b[2])))):reverseOrdnerFingerabdruck(fs,wurzel)});
  };
  for(const f of files){
   const rule=cfg.companions.find(r=>r.endungen.includes(ext(f.rel_pfad)));if(!rule||f.archiv_format||reverseArchivMagic(f.kopf))continue;
   const base=f.rel_pfad.slice(0,-path.posix.extname(f.rel_pfad).length),required=rule.pflicht.map(e=>base+'.'+e);
   if(rule.referenzen){
    if(f.referenzen===undefined)required.push('[Descriptor noch nicht hochgeladen]');
    else {
     for(const value of f.referenzen){const ref=normalisiereSpeicherPfad(value);required.push((path.posix.dirname(f.rel_pfad)==='.'?'':path.posix.dirname(f.rel_pfad)+'/')+ref);}
     if(!required.length)required.push('[Keine Dateireferenz im Descriptor]');
    }
   }
   const wanted=[...new Set([...required,...rule.optional.map(e=>base+'.'+e)])],found=wanted.flatMap(p=>p!==f.rel_pfad&&byPath.has(p)?[byPath.get(p)!]:[]);
   add('image',[f,...found],f.rel_pfad,required.filter(p=>p===f.rel_pfad||!byPath.has(p)));
  }
  const rest=files.filter(f=>!used.has(f.rel_pfad));
  for(const f of rest)if(f.archiv_format||reverseArchivMagic(f.kopf))add('archiv',[f],f.rel_pfad);
  for(const f of rest)if(!used.has(f.rel_pfad)&&cfg.imageEndungen.includes(ext(f.rel_pfad)))add('image',[f],f.rel_pfad);
  const remaining=files.filter(f=>!used.has(f.rel_pfad));
  if(remaining.length){
   const knownFolder=remaining.some(f=>/\.(exe|dll)$/i.test(f.rel_pfad)||/(^|\/)(data|gfx|snd)\//i.test(f.rel_pfad));
   add('ordner',remaining,wurzel||remaining[0].rel_pfad,[],knownFolder ? .85 : .5,medien.length?['image','archiv']:['archiv']);
  }
  if(new Set(medien.map(m=>m.art)).size>1)for(const m of medien){m.confidence=Math.min(m.confidence,.7);m.alternativen=[...new Set([...m.alternativen,...['image','ordner','archiv'].filter(a=>a!==m.art)])];}
  medien.sort((a,b)=>natural(a.haupt,b.haupt));
  const build=(ms:ReverseMediumVorschlag[],titel:string):ReverseGruppenvorschlag=>({titel,wurzel,medien:ms,
   fingerabdruck:hash(ms.map(m=>[m.art,m.satz_sha256])),case_kollisionen:[...caseMap.values()].filter(a=>a.length>1)});
  if(wurzel)return [build(medien,wurzel)];
  return medien.flatMap(m=>m.art==='ordner'?m.dateien.map(f=>build([{...m,dateien:[f],haupt:f.rel_pfad,satz_sha256:f.sha256}],path.posix.basename(f.rel_pfad,path.posix.extname(f.rel_pfad)))):[build([m],path.posix.basename(m.haupt,path.posix.extname(m.haupt)))]);

 });
}
