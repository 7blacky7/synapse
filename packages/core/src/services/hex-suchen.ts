/** P21-T5: Streaming-Suche ueber autorisierte Hex-Quellen mit getrennten Scan-, RAM- und Antwortbudgets. */
import type {HexQuelle} from './hex-quellen.js';
import {HexFehler, hexGanzzahl} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
interface Pattern {bytes:Buffer;mask:boolean[];label:string}
function zahlMuster(args:Record<string,unknown>):Buffer{
 const typ=String(args.typ??''),wert=args.wert,le=args.endianness==='le';
 if(!['u8','i8','u16','i16','u32','i32','u64','i64','f32','f64'].includes(typ))throw new HexFehler('muster_ungueltig',{parameter:'typ'});
 const size=Number(typ.match(/[0-9]+$/)?.[0])/8;
 if(size>1&&!['le','be'].includes(String(args.endianness)))throw new HexFehler('muster_ungueltig',{parameter:'endianness'});
 const b=Buffer.alloc(size),view=new DataView(b.buffer,b.byteOffset,b.byteLength);
 try{
  if(typ[0]==='f'){if(typeof wert!=='number'||!Number.isFinite(wert))throw new Error();if(typ==='f32')view.setFloat32(0,wert,le);else view.setFloat64(0,wert,le);}
  else{const n=BigInt(typeof wert==='number'&&Number.isSafeInteger(wert)?wert:String(wert)),bits=BigInt(size*8),min=typ[0]==='i'?-(1n<<(bits-1n)):0n,max=typ[0]==='i'?(1n<<(bits-1n))-1n:(1n<<bits)-1n;if(n<min||n>max)throw new Error();let u=n<0?(1n<<bits)+n:n;for(let i=0;i<size;i++){b[le?i:size-1-i]=Number(u&255n);u>>=8n;}}
 }catch{throw new HexFehler('muster_ungueltig',{parameter:'wert',typ});}
 return b;
}
function parsePattern(args:Record<string,unknown>):Pattern{
 const art=String(args.art??'hex');let bytes:Buffer;
 if(art==='zahl')bytes=zahlMuster(args);
 else if(['ascii','utf8','utf16le','utf16be'].includes(art)){
  if(typeof args.muster!=='string'||!args.muster.length)throw new HexFehler('muster_ungueltig',{parameter:'muster'});
  if(art==='ascii'&&/[^\x00-\x7f]/.test(args.muster))throw new HexFehler('muster_ungueltig',{parameter:'muster',grund:'ascii'});
  bytes=Buffer.from(args.muster,art==='utf16be'?'utf16le':art as BufferEncoding);
  if(art==='utf16be')for(let i=0;i+1<bytes.length;i+=2)[bytes[i],bytes[i+1]]=[bytes[i+1],bytes[i]];
 }else if(art==='hex'){
  if(typeof args.muster!=='string')throw new HexFehler('muster_ungueltig',{parameter:'muster'});
  const tokens=args.muster.trim().split(/\s+/).filter(Boolean);
  if(!tokens.length||tokens.some(x=>! /^(?:[0-9a-f]{2}|\?\?)$/i.test(x)))throw new HexFehler('muster_ungueltig',{parameter:'muster'});
  const b=Buffer.from(tokens.map(x=>x==='??'?'00':x).join(''),'hex');
  return {bytes:b,mask:tokens.map(x=>x!=='??'),label:args.muster};
 }else throw new HexFehler('muster_ungueltig',{parameter:'art'});
 if(!bytes.length)throw new HexFehler('muster_ungueltig',{parameter:'muster'});
 return {bytes,mask:Array.from({length:bytes.length},()=>true),label:art==='zahl'?String(args.wert):String(args.muster)};
}
const hex=(b:Uint8Array)=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(' ');
const ascii=(b:Uint8Array)=>Array.from(b,x=>x>=32&&x<=126?String.fromCharCode(x):'.').join('');
export async function sucheHex(q:HexQuelle,args:Record<string,unknown>,stand:HexStand,signal:AbortSignal):Promise<Record<string,unknown>>{
 const p=parsePattern(args),start=hexGanzzahl(args.offset,'offset',0),size=q.groesse;
 if(start>size)throw new HexFehler('bereich_ausserhalb',{groesse:size});
 const scan=stand.werte.scan_bytes.wert,ram=stand.werte.ram_bytes.wert,cap=stand.werte.max_fundstellen.wert,limit=args.limit===undefined?cap:hexGanzzahl(args.limit,'limit');
 if(p.bytes.length>Math.min(ram,scan))throw new HexFehler('budget_ueberschritten',{parameter:'muster',max_bytes:Math.min(ram,scan)});
 const align=args.ausrichtung===undefined?1:hexGanzzahl(args.ausrichtung,'ausrichtung');
 if(align<1)throw new HexFehler('muster_ungueltig',{parameter:'ausrichtung'});
 if(limit<1||limit>cap)throw new HexFehler('budget_ueberschritten',{parameter:'limit',max:cap});
 const maxAntwort=Math.min(stand.werte.antwort_zeichen.wert,Math.floor(ram/8));
 const chunkMax=Math.min(stand.werte.chunk_bytes.wert,Math.floor((ram-2*maxAntwort-p.bytes.length)/2),scan);
 if(maxAntwort<256||chunkMax<p.bytes.length)throw new HexFehler('budget_ueberschritten',{parameter:'ram_oder_antwort',max_antwort_zeichen:maxAntwort,ram_bytes:ram});
 const chunk=Math.max(p.bytes.length,chunkMax),maxStart=size-p.bytes.length,scanEnd=Math.min(size,start+scan),hits:Array<Record<string,unknown>>=[];
 let readAt=start,readBytes=0,next=start,eof=start>maxStart,stopped=false,carry:Uint8Array=Buffer.alloc(0),ramPeak=0;
 const make=(cursor:number|null,finished:boolean)=>({success:true,action:'suchen',beantwortet_von:'hex',ref:q.ref,file_path:q.file_path,revision:q.revision,sha256:q.sha256,groesse:size,bytebasis:q.bytebasis,
  art:args.art??'hex',muster:p.label,offset:String(start),fundstellen:hits,anzahl:hits.length,naechster_offset:cursor===null?null:String(cursor),eof:finished,vollstaendig:finished,
  budget:{max_fundstellen:cap,seitenlimit:limit,max_scan_bytes:scan,gelesen_bytes:readBytes,gescannt_bytes:Math.max(0,next-start),ram_bytes:ram,ram_schaetzung_peak:ramPeak,max_antwort_zeichen:maxAntwort}});
 const baseSize=JSON.stringify(make(null,false)).length;
 if(baseSize>maxAntwort)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen',min:baseSize,max:maxAntwort});
 while(readAt<scanEnd&&readBytes<scan&&!stopped&&!eof){
  const n=Math.min(chunk,scanEnd-readAt,scan-readBytes);
  if(n+carry.length<p.bytes.length)break;
  const part=await q.lesen(readAt,n,signal);readBytes+=part.length;
  if(signal.aborted)throw new HexFehler('zeitlimit');
  const data=carry.length?Buffer.concat([Buffer.from(carry),Buffer.from(part)]):Buffer.from(part),base=readAt-carry.length,chunkEnd=readAt+part.length;
  ramPeak=Math.max(ramPeak,part.length+data.length+p.bytes.length+JSON.stringify(hits).length*2);
  const first=Math.max(next,base),last=Math.min(maxStart,chunkEnd-p.bytes.length);let candidateNext=first;
  for(let pos=first;pos<=last;pos++){
   candidateNext=pos+1;if(pos%align!==0)continue;
   let ok=true;for(let i=0;i<p.bytes.length;i++)if(p.mask[i]&&data[pos-base+i]!==p.bytes[i]){ok=false;break;}
   if(!ok)continue;
   const lo=Math.max(0,pos-16),hi=Math.min(size,pos+p.bytes.length+16);let ctx:Buffer,ctxLo=lo,ctxHi=hi,ctxComplete=true;
   if(lo>=base&&hi<=base+data.length)ctx=Buffer.from(data.subarray(lo-base,hi-base));
   else{
    const usedHits=JSON.stringify(hits).length*2,ramLeft=Math.max(0,ram-part.length-data.length-p.bytes.length-usedHits);
    const nctx=Math.min(hi-lo,scan-readBytes,Math.floor(ramLeft/2));
    if(nctx>=p.bytes.length){
     const left=Math.min(pos-lo,Math.floor((nctx-p.bytes.length)/2)),from=pos-left,to=Math.min(hi,from+nctx);
     ctx=Buffer.from(await q.lesen(from,to-from,signal));readBytes+=ctx.length;ctxLo=from;ctxHi=from+ctx.length;ctxComplete=ctxLo===lo&&ctxHi===hi;
    }else{
     ctxLo=Math.max(lo,base);ctxHi=Math.min(hi,base+data.length);ctx=Buffer.from(data.subarray(ctxLo-base,ctxHi-base));ctxComplete=ctxLo===lo&&ctxHi===hi;
    }
   }
   const hit={offset:String(pos),offset_hex:'0x'+pos.toString(16),laenge:p.bytes.length,kontext:{offset:String(ctxLo),hex:hex(ctx),ascii:ascii(ctx),vollstaendig:ctxComplete}};
   hits.push(hit);ramPeak=Math.max(ramPeak,part.length+data.length+p.bytes.length+JSON.stringify(hits).length*2+(ctx?.length??0));
   if(JSON.stringify(make(pos,false)).length>maxAntwort){hits.pop();next=pos;stopped=true;break;}
   if(hits.length>=limit){next=pos+1;stopped=true;break;}
   if(readBytes>=scan){next=pos+1;stopped=true;break;}
  }
  if(stopped)break;
  const keep=Math.min(data.length,Math.max(0,p.bytes.length-1));carry=keep?Buffer.from(data.subarray(data.length-keep)):Buffer.alloc(0);
  readAt=chunkEnd;next=Math.max(candidateNext,Math.min(maxStart+1,chunkEnd-p.bytes.length+1));
  if(next>maxStart)eof=true;
 }
 if(!eof&&!stopped){next=Math.max(next,Math.min(maxStart+1,Math.max(start,readAt-p.bytes.length+1)));eof=next>maxStart;}
 const more=!eof,answer=make(more?Math.max(start,next):null,eof);
 if(JSON.stringify(answer).length>maxAntwort)throw new HexFehler('budget_ueberschritten',{parameter:'antwort_zeichen',max:maxAntwort});
 return answer;
}