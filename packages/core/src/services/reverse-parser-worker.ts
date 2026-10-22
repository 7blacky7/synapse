/** P18-T95: isolated Reverse-only registry call. Never executes target code or accesses a DB. */
import {parentPort,workerData} from 'node:worker_threads';
import {getParserForFile} from '../parser/index.js';
import type {ParseResult} from '../parser/types.js';
export interface ReverseParserAntwort {parser:string;version:number;ergebnis:ParseResult;struktur:number}
function parse(daten:{pfad:string;inhalt:string}){
 if(!parentPort)return;
 try{
  const {pfad,inhalt}=daten;
  const p=getParserForFile(pfad,inhalt);
  if(!p)parentPort.postMessage(null);
  else{
   const ergebnis=p.parse(inhalt,pfad),cLike=p.language==='c'||p.language==='cpp';
   const plain=cLike?inhalt.replace(/\/\*[\s\S]*?\*\//g,m=>m.replace(/[^\n]/g,' ')).replace(/\/\/[^\n]*/g,m=>' '.repeat(m.length)):inhalt;
   const lines=plain.split('\n');
   const struktur=ergebnis.symbols.filter(s=>['function','class','interface','enum'].includes(s.symbol_type)
    &&lines.slice(Math.max(0,s.line_start-1),s.line_end??s.line_start).some(l=>l.trim())
    &&(!cLike||!s.line_end||(lines[s.line_end-1]??'').includes('}'))).length;
   parentPort.postMessage({parser:p.language,version:p.version??1,ergebnis,struktur} satisfies ReverseParserAntwort);
  }
 }catch{parentPort.postMessage({fehler:'parser_fehler'});}
}
if(parentPort){
 if(workerData?.sitzung===true)parentPort.on('message',parse);
 else parse(workerData);
}
