/** RV14 javap -c normalizer; no class loading. */
import {normalSammler,type NormalBudget,type NormalErgebnis,type NormalSymbol} from './s1.js';
export function normalisiereJavap(roh:string,b:NormalBudget):NormalErgebnis{
 const out=normalSammler(b),symbole:NormalSymbol[]=[],kanten:{caller:string;callee:string;zeile:number}[]=[];
 const lines=roh.split(/\r?\n/);let caller='';
 for(const [i,line] of lines.entries()){
  const method=/^\s+(?:(?:public|private|protected|static|final|synchronized|native|abstract|strictfp)\s+)*(?:[\w.$<>[\]]+\s+)?([\w.$<>]+)\([^;]*\).*;\s*$/.exec(line);
  if(method){if(symbole.length)symbole[symbole.length-1].ende=i;caller=method[1];symbole.push({art:'function',name:caller,wert:line.trim(),zeile:i+1,ende:lines.length,adresse:null,groesse:null});}
  const call=/^\s*\d+:\s+invoke\w+.*\/\/\s*(?:InterfaceMethod|Method)\s+([^:]+):/.exec(line);
  if(call&&caller)kanten.push({caller,callee:call[1].replace(/"/g,''),zeile:i+1});
 }
 out.add({pfad:'javap.txt',schicht:'S2',typ:'asm',inhalt:roh,symbole,kanten});return out.r;
}
