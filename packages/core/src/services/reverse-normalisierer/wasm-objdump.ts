/** RV14 wasm-objdump -x/-d normalizer, never executes the module. */
import {normalSammler,type NormalBudget,type NormalErgebnis,type NormalSymbol} from './s1.js';
export function normalisiereWasmObjdump(roh:string,b:NormalBudget):NormalErgebnis{
 const out=normalSammler(b),symbole:NormalSymbol[]=[],kanten:{caller:string;callee:string;zeile:number}[]=[];
 const lines=roh.split(/\r?\n/);let caller='';
 const names=new Map<string,string>();
 for(const line of lines){
  const m=/func\[(\d+)\](?:[^<\n]*<([^>]+)>)?/.exec(line);
  if(m)names.set(m[1],m[2]??names.get(m[1])??'func_'+m[1]);
 }
 for(const [i,line] of lines.entries()){
  const fn=/^\s*([0-9a-f]+)\s+func\[(\d+)\](?:\s*<([^>]+)>)?:/.exec(line);
  if(fn){caller=fn[3]??names.get(fn[2])!;symbole.push({art:'function',name:caller,wert:null,zeile:i+1,ende:i+1,adresse:parseInt(fn[1],16),groesse:null});}
  const imp=/func\[(\d+)\].*<-\s*(\S+)/.exec(line);
  if(imp)symbole.push({art:'import',name:names.get(imp[1])??imp[2],wert:imp[2],zeile:i+1,ende:i+1,adresse:null,groesse:null});
  const exp=/func\[(\d+)\].*->\s*"([^"]+)"/.exec(line);
  if(exp)symbole.push({art:'export',name:exp[2],wert:names.get(exp[1])??'func_'+exp[1],zeile:i+1,ende:i+1,adresse:null,groesse:null});
  const call=/\|\s*call\s+(\d+)(?:\s*<([^>]+)>)?/.exec(line);
  if(call&&caller)kanten.push({caller,callee:call[2]??names.get(call[1])??'func_'+call[1],zeile:i+1});
 }
 let next=lines.length+1;
 for(let i=symbole.length-1;i>=0;i--)if(symbole[i].art==='function'){symbole[i].ende=next-1;next=symbole[i].zeile;}
 const disasm=symbole.some(s=>s.art==='function');
 out.add({pfad:disasm?'wasm-objdump.txt':'wasm-imports.txt',schicht:disasm?'S2':'S1',typ:disasm?'asm':'txt',inhalt:roh,symbole,kanten});return out.r;
}
