/** P21-T6: v1 vergleicht zwei autorisierte Quellen streng byteoffsetgleich; Scan, RAM und JSON sind getrennt budgetiert. */
import type {HexQuelle} from './hex-quellen.js';
import {HexFehler,hexGanzzahl} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
const hex=(b:ArrayLike<number>)=>Array.from(b,x=>x<0?'??':x.toString(16).padStart(2,'0')).join(' ');
export async function vergleicheHex(a:HexQuelle,b:HexQuelle,args:Record<string,unknown>,stand:HexStand,signal:AbortSignal):Promise<Record<string,unknown>>{
 const start=hexGanzzahl(args.offset,'offset',0),gesamt=Math.max(a.groesse,b.groesse);
 if(start>gesamt)throw new HexFehler('bereich_ausserhalb',{groesse:gesamt});
 const maxBloecke=stand.werte.max_diff_bloecke.wert,limit=args.limit===undefined?maxBloecke:hexGanzzahl(args.limit,'limit');
 if(limit<1||limit>maxBloecke)throw new HexFehler('budget_ueberschritten',{parameter:'limit',max:maxBloecke});
 const scan=stand.werte.scan_bytes.wert,ram=stand.werte.ram_bytes.wert,antwort=Math.min(stand.werte.antwort_zeichen.wert,Math.floor(ram/8));
 const chunk=Math.min(stand.werte.chunk_bytes.wert,Math.floor(ram/8),scan),maxBlockBytes=Math.max(1,Math.min(stand.werte.max_hex_bytes.wert,Math.floor(ram/64),Math.floor(antwort/16)));
 if(chunk<1||antwort<256)throw new HexFehler('budget_ueberschritten',{parameter:'ram_oder_antwort',ram_bytes:ram,max_antwort_zeichen:antwort});
 const ende=Math.min(gesamt,start+scan),bloecke:Array<Record<string,unknown>>=[];
 let pos=start,unvollstaendig=false,vergleiche=0,bytesA=0,bytesB=0,runStart:number|null=null,aa:number[]=[],bb:number[]=[],ramPeak=0;
 const flush=()=>{if(runStart===null)return;bloecke.push({offset:String(runStart),offset_hex:'0x'+runStart.toString(16),laenge:aa.length,bytes_a:hex(aa),bytes_b:hex(bb)});runStart=null;aa=[];bb=[];};
 const result=(next:number|null,eof:boolean)=>({success:true,action:'vergleichen',beantwortet_von:'hex',modus:'offsetgleich-v1',ref_a:a.ref,ref_b:b.ref,datei_a:a.file_path,datei_b:b.file_path,revision_a:a.revision,revision_b:b.revision,sha256_a:a.sha256,sha256_b:b.sha256,groesse_a:a.groesse,groesse_b:b.groesse,groessendifferenz:a.groesse-b.groesse,offset:String(start),verglichene_bytes:vergleiche,differenzen:bloecke,anzahl_bloecke:bloecke.length,naechster_offset:next===null?null:String(next),eof,vollstaendig:eof,budget:{max_scan_bytes:scan,max_diff_bloecke:maxBloecke,seitenlimit:limit,max_block_bytes:maxBlockBytes,bytes_a:bytesA,bytes_b:bytesB,ram_bytes:ram,ram_schaetzung_peak:ramPeak,max_antwort_zeichen:antwort}});
 const baseSize=JSON.stringify(result(null,false)).length;
 if(baseSize>antwort)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen',min:baseSize,max:antwort});
 while(pos<ende){
  const n=Math.min(chunk,ende-pos),na=Math.min(n,Math.max(0,a.groesse-pos)),nb=Math.min(n,Math.max(0,b.groesse-pos));
  const [xa,xb]=await Promise.all([na?a.lesen(pos,na,signal):Promise.resolve(Buffer.alloc(0)),nb?b.lesen(pos,nb,signal):Promise.resolve(Buffer.alloc(0))]);
  bytesA+=xa.length;bytesB+=xb.length;if(signal.aborted)throw new HexFehler('zeitlimit');
  let stopAt:number|null=null;
  for(let i=0;i<n;i++){
   const ix=pos+i,va=i<na?xa[i]:null,vb=i<nb?xb[i]:null;
   if(va===vb){vergleiche++;flush();continue;}
   if(runStart===null&&bloecke.length>=limit){stopAt=ix;unvollstaendig=true;break;}
   if(runStart===null){runStart=ix;aa=[];bb=[];}
   if(aa.length>=maxBlockBytes){flush();if(bloecke.length>=limit){stopAt=ix;unvollstaendig=true;break;}runStart=ix;aa=[];bb=[];}
   aa.push(va===null?-1:va);bb.push(vb===null?-1:vb);vergleiche++;
   ramPeak=Math.max(ramPeak,xa.length+xb.length+(aa.length+bb.length)*8+JSON.stringify(bloecke).length*2);
  }
  if(stopAt!==null){pos=stopAt;break;}
  pos+=n;
 }
 if(pos===ende)flush();if(unvollstaendig)flush();
 let next=unvollstaendig?pos:pos<gesamt?pos:null,eof=next===null,answer=result(next,eof),encoded=JSON.stringify(answer);
 while(encoded.length>antwort&&bloecke.length){
  const last=bloecke[bloecke.length-1],len=Number(last.laenge),off=Number(last.offset);
  if(len>0){last.laenge=len-1;last.bytes_a=String(last.bytes_a).slice(0,-3);last.bytes_b=String(last.bytes_b).slice(0,-3);next=Math.min(next??gesamt,off+len-1);if(last.laenge===0)bloecke.pop();}
  else bloecke.pop();
  eof=false;answer=result(next,eof);encoded=JSON.stringify(answer);
 }
 if(encoded.length>antwort)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen',max:antwort});
 return answer;
}