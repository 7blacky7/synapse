/** P21-T1/RV27: begrenzte Formatindikatoren auf bereits autorisierten Bytes. Keine Asset-Persistenz. */
export interface Rv27Quelle {size:number;path:string;readRange:(offset:number,length:number)=>Promise<Uint8Array>}
export interface Rv27Limits {scanBytes:number;ramBytes:number;blockBytes:number;sampleBytes:number;maxCandidates:number}
const hex=(b:Uint8Array)=>Buffer.from(b).toString('hex');
function entropy(b:Uint8Array):number|null{if(!b.length)return null;const c=new Uint32Array(256);for(const x of b)c[x]++;let h=0;for(const n of c)if(n){const p=n/b.length;h-=p*Math.log2(p);}return Number(h.toFixed(4));}
function plausible(b:Buffer,i:number,magic:string):{length:number|null;proof:string}|null{
 const left=b.length-i,read32=(p:number)=>p+4<=b.length?b.readUInt32LE(p):null;
 if(magic==='png'&&left>=33&&hex(b.subarray(i,i+8))==='89504e470d0a1a0a'&&b.readUInt32BE(i+8)===13&&hex(b.subarray(i+12,i+16))==='49484452'){
  const w=b.readUInt32BE(i+16),h=b.readUInt32BE(i+20);if(w>0&&h>0&&w<=100000&&h<=100000)return {length:null,proof:`IHDR 13 bytes, ${w}x${h}`};
 }
 if(magic==='gif'&&left>=10&&['474946383761','474946383961'].includes(hex(b.subarray(i,i+6)))){const w=b.readUInt16LE(i+6),h=b.readUInt16LE(i+8);if(w&&h)return {length:null,proof:`GIF logical screen ${w}x${h}`};}
 if(magic==='bmp'&&left>=26&&b[i]===0x42&&b[i+1]===0x4d){const n=read32(i+2),dib=read32(i+14),off=read32(i+10),w=read32(i+18),h=read32(i+22);if(n!==null&&dib!==null&&off!==null&&w!==null&&h!==null&&n>=26&&n<=left&&off>=14+dib&&off<=n&&w>0&&w<100000&&h>0&&h<100000)return {length:n,proof:`BMP size ${n}, pixel offset ${off}, DIB ${dib}`};}
 if(magic==='wav'&&left>=12&&hex(b.subarray(i,i+4))==='52494646'&&hex(b.subarray(i+8,i+12))==='57415645'){const n=read32(i+4);if(n!==null&&n>=4&&n+8<=left)return {length:n+8,proof:`RIFF length ${n+8}, WAVE form`};}
 if(magic==='zip'&&left>=30&&['504b0304','504b0506','504b0708'].includes(hex(b.subarray(i,i+4)))){const n=b.readUInt32LE(i+18),name=b.readUInt16LE(i+26),extra=b.readUInt16LE(i+28);if(name>0&&30+name+extra<=left)return {length:n>0&&n<=left?n:null,proof:`ZIP local header, name bytes ${name}, extra ${extra}`};}
 if(magic==='ogg'&&left>=27&&hex(b.subarray(i,i+4))==='4f676753'&&b[i+4]===0&&27+b[i+26]<=left)return {length:null,proof:`Ogg page v0, segment count ${b[i+26]}`};
 if(magic==='midi'&&left>=14&&hex(b.subarray(i,i+4))==='4d546864'&&b.readUInt32BE(i+4)===6){const f=b.readUInt16BE(i+8),tracks=b.readUInt16BE(i+10);if(f<=2&&tracks>0)return {length:null,proof:`MIDI header format ${f}, tracks ${tracks}`};}
 if(magic==='jpeg'&&left>=4&&b[i]===0xff&&b[i+1]===0xd8&&b[i+2]===0xff)return {length:null,proof:'JPEG SOI gefolgt von Marker'};
 if(magic==='pcx'&&left>=128&&b[i]===0x0a&&b[i+2]===1&&[1,2,4,8].includes(b[i+3])&&b.readUInt16LE(i+8)>=b.readUInt16LE(i+4)&&b.readUInt16LE(i+10)>=b.readUInt16LE(i+6))return {length:null,proof:'PCX manufacturer/version/encoding/planes und Bounds plausibel'};
 // Gruppierungshelfer folgt nach der Signaturtabelle.

 return null;
}
function erkenneMagic(b:Uint8Array):string{for(const [name,sig] of SIG){if(b.length<sig.length)continue;if(sig.every((x,i)=>b[i]===x))return name;}return b.length?`hex-${hex(b.subarray(0,4))}`:'leer';}
export function gruppiereRv27Dateien(dateien:Array<Record<string,unknown>>):Array<Record<string,unknown>>{
 const gruppen=new Map<string,Array<Record<string,unknown>>>();
 for(const d of dateien){const key=[d.extension,d.magic,d.size_pattern].join('|'),g=gruppen.get(key)??[];g.push(d);gruppen.set(key,g);}
 return [...gruppen.entries()].map(([key,files])=>{const headers=files.map(f=>Buffer.from(String(f.header_hex??''),'hex')),base=headers[0]??Buffer.alloc(0),diff:number[]=[];
  for(let i=0;i<Math.min(32,...headers.map(h=>h.length));i++)if(headers.some(h=>h[i]!==base[i]))diff.push(i);
  return {key,extension:files[0]?.extension,magic:files[0]?.magic,size_pattern:files[0]?.size_pattern,count:files.length,files,header_comparison:{reference:files[0]?.path??null,bytes_compared:Math.min(32,...headers.map(h=>h.length)),different_offsets:diff.slice(0,64)}};
 }).sort((a,b)=>String(a.key).localeCompare(String(b.key)));
}
const SIG:[string,number[]][]=[['png',[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]],['gif',[0x47,0x49,0x46,0x38]],['bmp',[0x42,0x4d]],['wav',[0x52,0x49,0x46,0x46]],['zip',[0x50,0x4b]],['ogg',[0x4f,0x67,0x67,0x53]],['midi',[0x4d,0x54,0x68,0x64]],['jpeg',[0xff,0xd8,0xff]],['pcx',[0x0a]]];
export async function analysiereRv27(q:Rv27Quelle,limits:Rv27Limits):Promise<Record<string,unknown>>{

 const scanned=Math.min(q.size,limits.scanBytes,limits.ramBytes);if(!Number.isSafeInteger(scanned)||scanned<0)throw new Error('rv27_budget_ungueltig');
 const sampleN=Math.min(q.size,limits.sampleBytes,scanned),sample=sampleN?Buffer.from(await q.readRange(0,sampleN)):Buffer.alloc(0);
 const blocks:Array<Record<string,unknown>>=[],signatureCandidates:Array<Record<string,unknown>>=[];let wholeCounts=new Uint32Array(256),wholeN=0,offset=0,header=Buffer.alloc(0);
 while(offset<scanned){const n=Math.min(limits.blockBytes,scanned-offset);if(n<=0)throw new Error('rv27_block_ungueltig');const bytes=Buffer.from(await q.readRange(offset,n));if(bytes.length!==n)throw new Error('rv27_quelle_kurz');
  if(header.length<Math.min(scanned,4096)){const take=Math.min(bytes.length,Math.min(scanned,4096)-header.length);header=Buffer.concat([Buffer.from(header),Buffer.from(bytes.subarray(0,take))]);}
  for(const x of bytes)wholeCounts[x]++;wholeN+=bytes.length;blocks.push({offset:String(offset),laenge:bytes.length,entropie:entropy(bytes)});
  const tailN=Math.min(7,scanned-offset-n),tail=tailN?Buffer.from(await q.readRange(offset+n,tailN)):Buffer.alloc(0),scanBytes=tailN?Buffer.concat([bytes,tail]):bytes;
  for(let i=0;i<bytes.length;i++)for(const [format,sig] of SIG){if(scanBytes[i]!==sig[0])continue;let ok=true;for(let k=1;k<sig.length;k++)if(offset+i+k>=scanned||scanBytes[i+k]!==sig[k]){ok=false;break;}if(!ok)continue;
   const abs=offset+i,window=await q.readRange(abs,Math.min(Math.max(128,sig.length+64),scanned-abs)),valid=plausible(Buffer.from(window),0,format);if(valid&&signatureCandidates.length<limits.maxCandidates)signatureCandidates.push({format,candidate:true,offset:String(abs),length:valid.length===null?null:String(valid.length),plausibility:valid.proof,stored:false});
  }
  offset+=n;
 }
 const hypotheses:Array<Record<string,unknown>>=[];
 for(const endian of ['le','be'] as const){const vals:number[]=[];for(let i=0;i+4<=header.length;i+=4)vals.push(endian==='le'?header.readUInt32LE(i):header.readUInt32BE(i));let runStart=0,last=-1,run:number[]=[];const emit=()=>{if(run.length<4)return;const byteOffset=runStart*4,byteLength=run.length*4;hypotheses.push({type:'offsettabelle',endianness:endian,confidence:Math.min(.9,.45+run.length*.05),evidence:{offset:String(byteOffset),length:byteLength,values:run.slice(0,8),bytes_hex:hex(header.subarray(byteOffset,byteOffset+byteLength))}});};for(let i=0;i<vals.length;i++){const v=vals[i];if(v>last&&v<q.size){if(!run.length)runStart=i;run.push(v);last=v;}else{emit();run=[];last=v<q.size?v:-1;}}emit();}
 for(let i=0;i<header.length;){if(header[i]>=32&&header[i]<=126){const start=i;while(i<header.length&&header[i]>=32&&header[i]<=126)i++;if(i-start>=6)hypotheses.push({type:'stringbereich',confidence:.55,evidence:{offset:String(start),length:i-start,bytes_hex:hex(header.subarray(start,Math.min(i,start+24)))}});}else i++;}
 for(let stride=8;stride<=256&&stride*4<=header.length;stride*=2){let same=0;for(let col=0;col<stride;col++){const v=header[col];if(header[col+stride]===v&&header[col+2*stride]===v&&header[col+3*stride]===v)same++;}const ratio=same/stride;if(ratio>=.35)hypotheses.push({type:'feste_datensatzlaenge',laenge:stride,confidence:Number(Math.min(.75,.35+ratio*.4).toFixed(2)),evidence:{offset:'0',length:stride*4,wiederkehrende_positionen:same,vergleich:'4 aufeinanderfolgende Datensaetze',bytes_hex:hex(header.subarray(0,stride*4))}});}
 for(const n of [768,1024])if(q.size>=n)hypotheses.push({type:'palette_kandidat',confidence:.25,evidence:{offset:'0',length:n,layout:n===768?'256xRGB':'256xRGBA',basis:'Groesse allein; visuell/semantisch nicht bestaetigt',bytes_hex:hex(header.subarray(0,Math.min(n,header.length)))}});
 const ext=q.path.includes('.')?q.path.slice(q.path.lastIndexOf('.')).toLowerCase():'(keine)';
 const first=header.subarray(0,32),sampleEntropy=entropy(sample);
 const sizeBand=q.size?Math.floor(Math.log2(q.size)):0;
 return {path:q.path,groesse:q.size,extension:ext,magic:erkenneMagic(first),size_pattern:q.size?`2^${sizeBand}..2^${sizeBand+1}`:'0',magic_hex:hex(first),header_hex:hex(first),bytes_gelesen:wholeN,scan_vollstaendig:wholeN===q.size,entropie_gesamt:{wert:wholeN?Number(((()=>{let h=0;for(const n of wholeCounts)if(n){const p=n/wholeN;h-=p*Math.log2(p);}return h;})()).toFixed(4)):null,bytes:wholeN,vollstaendig:wholeN===q.size},entropie_stichprobe_4096:{wert:sampleEntropy,bytes:sample.length,bereich:'[0,min(groesse,4096))'},entropie_bloecke:blocks,struktur_hypothesen:hypotheses,eingebettete_kandidaten:signatureCandidates};
}
