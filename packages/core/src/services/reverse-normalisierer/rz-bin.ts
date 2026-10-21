/** RV14 rz-bin JSON (-zj / -ij / -sj), S1 only. S2 comes from Ghidra (da83be67). */
import {adresse,normalisiereS1,normalSammler,type NormalBudget,type NormalErgebnis} from './s1.js';
const rows=(v:unknown,key:string):Record<string,unknown>[]=>{
 if(typeof v==='string'){try{v=JSON.parse(v);}catch{throw new Error('rz_bin_json_beschaedigt');}}
 const a=Array.isArray(v)?v:v&&typeof v==='object'?(v as Record<string,unknown>)[key]:[];
 if(!Array.isArray(a))throw new Error('rz_bin_json_beschaedigt');
 return a.filter((x):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x));
};
export function normalisiereRzBin(roh:{strings?:unknown;imports?:unknown;symbols?:unknown},b:NormalBudget):NormalErgebnis{
 const stringRows=rows(roh.strings??[],'strings'),imports=rows(roh.imports??[],'imports'),symbols=rows(roh.symbols??[],'symbols');
 const base=normalisiereS1({strings:stringRows.filter(x=>typeof x.string==='string').map(x=>({text:x.string as string,adresse:adresse(x.vaddr??x.paddr)})),
  importe:[...imports,...symbols.filter(x=>x.is_imported===true)].filter(x=>typeof x.name==='string').map(x=>({name:x.name as string,adresse:adresse(x.vaddr??x.plt)}))},b);
 const out=normalSammler(b);for(const d of base.dateien)out.add(d);out.r.maskiert+=base.maskiert;out.r.gekappt ||= base.gekappt;
 const defined=symbols.filter(x=>x.is_imported!==true&&typeof x.name==='string');
 if(defined.length)out.add({pfad:'symbols.txt',schicht:'S1',typ:'txt',inhalt:defined.map(x=>String(x.name)).join('\n'),kanten:[],
  symbole:defined.map((x,i)=>({art:'export',name:x.name as string,wert:typeof x.type==='string'?x.type:null,zeile:i+1,ende:i+1,adresse:adresse(x.vaddr??x.paddr),groesse:adresse(x.size)}))});
 return out.r;
}
