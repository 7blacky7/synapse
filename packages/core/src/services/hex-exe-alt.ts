/** P21-T9: MZ/NE/LE/LX, nur Header-/Tabellenlesen. Keine Loader-/Reloc-/Programmausfuehrung. */
import type {AssetSource,AssetContext} from '../asset-intel/types.js';
import type {ExeAdresskarte,ExeBereich} from '../asset-intel/inspectors/exe/adressvertrag.js';
import {HexFehler} from './hex-quellen.js';
export async function leseAltExeAdresskarte(src:AssetSource,ctx:AssetContext,format:'mz'|'ne'|'le'|'lx',neu:number):Promise<ExeAdresskarte>{
 const k:ExeAdresskarte={format,basis:format==='ne'?null:'0',bereiche:[],vollstaendig:true,warnungen:[]};
 const warn=(code:string,message:string)=>{k.vollstaendig=false;k.warnungen.push({code,message});};
 async function read(off:number,len:number):Promise<Buffer>{
  ctx.pruefeAbbruch();if(!Number.isSafeInteger(off)||off<0||len<0||off>src.size||len>src.size-off)throw new HexFehler('exe_header_abgeschnitten',{offset:String(off),laenge:len});
  const b=await src.readRange(off,len);if(b.length!==len)throw new HexFehler('exe_header_abgeschnitten');return b;
 }
 if(format==='mz'){
  const b=await read(0,28),pages=b.readUInt16LE(4),last=b.readUInt16LE(2),start=b.readUInt16LE(8)*16;
  if(last>511||pages===0||start<28)throw new HexFehler('exe_header_ungueltig');
  const end=pages*512-(last?512-last:0);if(end<start)throw new HexFehler('exe_header_ungueltig');
  if(end>src.size)warn('mz_abgeschnitten','MZ-Modulgroesse reicht ueber die Datei');
  k.bereiche.push({art:'segment',index:0,name:'DOS-Lademodul',datei_offset:String(start),datei_bytes:String(end-start),va:'0',speicher_bytes:String(end-start+b.readUInt16LE(10)*16),kopf_offset:0,kopf_bytes:28});
  return k;
 }
 if(format==='ne'){
  const h=await read(neu,64),count=h.readUInt16LE(28),tab=neu+h.readUInt16LE(34),shift=h.readUInt16LE(50);
  if(h.toString('latin1',0,2)!=='NE'||shift>31)throw new HexFehler('exe_header_ungueltig');
  const n=Math.min(count,ctx.limits.maxObjects);if(n<count)warn('adresskarte_gekappt','NE-Segmentzahl ueber Budget');
  for(let i=0;i<n;i++){
   const b=await read(tab+i*8,8),sector=b.readUInt16LE(0),bytes=b.readUInt16LE(2)||65536,flags=b.readUInt16LE(4),mem=b.readUInt16LE(6)||65536;
   const off=sector?BigInt(sector)<<BigInt(shift):null;
   k.bereiche.push({art:'segment',index:i,name:'NE-Segment '+(i+1),segment:i+1,segment_offset:'0',datei_offset:off?.toString()??null,datei_bytes:sector?String(bytes):'0',va:null,speicher_bytes:String(sector?Math.max(mem,bytes):mem),abbildung:flags&8?'kodiert':sector?'linear':'virtuell',kopf_offset:tab+i*8,kopf_bytes:8});
  }return k;
 }
 const h=await read(neu,176),magic=h.toString('latin1',0,2).toLowerCase();
 if(magic!==format||h[2]!==0||h[3]!==0||h.readUInt32LE(4)!==0)throw new HexFehler('exe_variante_nicht_unterstuetzt');
 const pageSize=h.readUInt32LE(40),lastOrShift=h.readUInt32LE(44),count=h.readUInt32LE(68),
 tab=neu+h.readUInt32LE(64),map=neu+h.readUInt32LE(72),data=h.readUInt32LE(128),pages=h.readUInt32LE(20);
 if(pageSize===0||format==='lx'&&lastOrShift>31||format==='le'&&lastOrShift>pageSize)throw new HexFehler('exe_header_ungueltig');
 const n=Math.min(count,ctx.limits.maxObjects);if(n<count)warn('adresskarte_gekappt','Objektzahl ueber Budget');
 let minBase:bigint|null=null,entries=0;
 for(let i=0;i<n;i++){
  const obj=await read(tab+i*24,24),virtual=obj.readUInt32LE(0),base=BigInt(obj.readUInt32LE(4)),first=obj.readUInt32LE(12),num=obj.readUInt32LE(16);
  if(minBase===null||base<minBase)minBase=base;
  if(num>0&&(first<1||first-1>pages||num>pages-(first-1)))throw new HexFehler('exe_seitentabelle_ungueltig');
  const mapped=Math.min(num,Math.ceil(virtual/pageSize));
  for(let j=0;j<mapped;j++){
   ctx.pruefeAbbruch();if(++entries>ctx.limits.maxObjects){warn('adresskarte_gekappt','Seitenzahl ueber Budget');break;}
   const at=map+(first-1+j)*(format==='lx'?8:4),p=await read(at,format==='lx'?8:4);
   let off:bigint|null=null,bytes=0,flag:number;
   if(format==='le'){
    const number=p.readUIntBE(0,3);flag=p[3];
    if(flag===0&&number>0&&number<=pages){off=BigInt(data)+BigInt(number-1)*BigInt(pageSize);bytes=number===pages&&lastOrShift?lastOrShift:pageSize;}
    else if(flag===0)throw new HexFehler('exe_seitentabelle_ungueltig');
   }else{flag=p.readUInt16LE(6);if(flag===0){off=BigInt(data)+(BigInt(p.readUInt32LE(0))<<BigInt(lastOrShift));bytes=p.readUInt16LE(4);}}
   const mem=Math.min(pageSize,virtual-j*pageSize);
   if(bytes>pageSize)throw new HexFehler('exe_seitentabelle_ungueltig');
   k.bereiche.push({art:'seite',index:first-1+j,name:format.toUpperCase()+' Objekt '+(i+1)+' Seite '+j,segment:i+1,segment_offset:String(j*pageSize),datei_offset:off?.toString()??null,datei_bytes:String(bytes),va:(base+BigInt(j)*BigInt(pageSize)).toString(),speicher_bytes:String(mem),abbildung:flag===0?'linear':flag===3?'virtuell':flag===2?'ungueltig':'kodiert',kopf_offset:at,kopf_bytes:format==='lx'?8:4});
  }
  if(mapped*pageSize<virtual)k.bereiche.push({art:'objekt',index:i,name:'Uninitialisierter Objektrest '+(i+1),segment:i+1,segment_offset:String(mapped*pageSize),datei_offset:null,datei_bytes:'0',va:(base+BigInt(mapped)*BigInt(pageSize)).toString(),speicher_bytes:String(virtual-mapped*pageSize),abbildung:'virtuell',kopf_offset:tab+i*24,kopf_bytes:24});
  if(entries>ctx.limits.maxObjects)break;
 }
 k.basis=minBase?.toString()??'0';return k;
}
