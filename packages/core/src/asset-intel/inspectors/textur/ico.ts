/**
 * ICO/CUR-Verzeichnis (P13 bzw. P22-T238 mit P4-T75, User 31.10.2026, thought 0e4c4c3f).
 * Version 3: CUR (Typ 2, Hotspot statt Planes/Bits) und Bildmetadaten wie textur-png fuer das groesste Bild:
 * width/height, channels, has_alpha, bits_per_channel - aus dem eingebetteten PNG (IHDR) bzw. dem DIB-Kopf.
 * Pixel werden nie dekodiert; die Vorschau bleibt beim gemeinsamen FFmpeg-Renderer.
 */
import type {AssetInspector} from '../../types.js';
import {erzeugeAssetResult} from '../../types.js';
import {bildMetadata} from './util.js';

const PNG_MAGIC=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

interface Bild {index:number;width:number;height:number;bits:number|null;alpha:boolean;kanalBits:number;png:boolean;hotspot?:{x:number;y:number}}

export const icoInspector:AssetInspector={
 id:'textur-ico',formats:['ico','cur'],extensions:['.ico','.cur'],
 magic:[{offset:0,bytes:[0,0,1,0],format:'ico'},{offset:0,bytes:[0,0,2,0],format:'cur'}],version:3,
 /** Four common bytes alone are insufficient for unnamed/foreign binary formats. */
 pruefeMagic(filePath,headBytes,size){
  if(/\.(ico|cur)$/i.test(filePath))return true;
  if(headBytes.length<22)return false;
  const b=Buffer.from(headBytes.buffer,headBytes.byteOffset,headBytes.byteLength);
  const typ=b.readUInt16LE(2),count=b.readUInt16LE(4),end=6+16*count,planes=b.readUInt16LE(10),bits=b.readUInt16LE(12);
  const length=b.readUInt32LE(14),offset=b.readUInt32LE(18);
  const icoFelder=typ===2||planes<=1&&[0,1,4,8,16,24,32].includes(bits);
  return count>0&&count<=256&&b[9]===0&&icoFelder&&length>=12&&offset>=end&&offset+length<=(size??b.length);
 },

 async inspect(src,ctx){
  const kopf0=await src.readRange(0,6);
  const cur=kopf0.length>=4&&kopf0.readUInt16LE(2)===2;
  const format=cur?'cur':'ico';
  const result=erzeugeAssetResult(src.filePath,src.size,{asset_type:'image',format,inspector:'textur-ico',parser_version:3,
   metadata:{mime_type:cur?'image/vnd.microsoft.icon':'image/x-icon'}});
  const bad=(message:string)=>{result.status='fehler';result.warnings.push({code:'ico_verzeichnis_ungueltig',message});return result;};
  const head=kopf0;
  if(head.length!==6||head.readUInt16LE(0)!==0||![1,2].includes(head.readUInt16LE(2)))return bad('Kein vollständiger ICO/CUR-Dateikopf.');
  const count=head.readUInt16LE(4),directoryEnd=6+count*16;
  if(!count||directoryEnd>src.size)return bad('ICO-Bildverzeichnis fehlt oder ist abgeschnitten.');
  const bilder:Bild[]=[];
  let pngAnzahl=0;
  for(let i=0;i<Math.min(count,ctx.limits.maxObjects);i++){
   ctx.pruefeAbbruch();
   const entry=await src.readRange(6+i*16,16);
   if(entry.length!==16)return bad('ICO-Bildverzeichnis ist abgeschnitten.');
   let width=entry[0]||256,height=entry[1]||256;
   const feld4=entry.readUInt16LE(4),feld6=entry.readUInt16LE(6),length=entry.readUInt32LE(8),offset=entry.readUInt32LE(12);
   if(!length||offset<directoryEnd||offset+length>src.size){
    result.status='teilweise';result.warnings.push({code:'ico_bildbereich_ungueltig',message:'ICO-Bild '+i+' liegt außerhalb der Datei.'});continue;
   }
   // Bilddaten-Kopf: eingebettetes PNG (IHDR) oder DIB (BITMAPINFOHEADER, Hoehe doppelt fuer XOR+AND-Maske).
   const d=await src.readRange(offset,Math.min(length,40));
   let bits:number|null=cur?null:(feld6||null),alpha=false,kanalBits=8,png=false;
   if(d.length>=29&&d.subarray(0,8).equals(PNG_MAGIC)){
    png=true;pngAnzahl++;
    width=d.readUInt32BE(16)||width;height=d.readUInt32BE(20)||height;
    const tiefe=d[24],farbtyp=d[25];
    alpha=farbtyp===4||farbtyp===6;kanalBits=farbtyp===3?8:tiefe;
    bits=farbtyp===6?tiefe*4:farbtyp===2?tiefe*3:farbtyp===4?tiefe*2:tiefe;
   }else if(d.length>=16&&d.readUInt32LE(0)>=40){
    const dibBits=d.readUInt16LE(14);
    bits=dibBits||bits;alpha=dibBits===32;kanalBits=dibBits>=24?8:dibBits===16?5:8;
   }
   const bild:Bild={index:i,width,height,bits,alpha,kanalBits,png};
   if(cur)bild.hotspot={x:feld4,y:feld6};
   bilder.push(bild);
   result.objects.push({kind:'image',name:(cur?'cursor-':'icon-')+i,
    data:{width,height,bits_per_pixel:bits,has_alpha:alpha,eingebettet_png:png,...(cur?{hotspot_x:feld4,hotspot_y:feld6}:{})},source_range:{offset,length}});
  }
  if(count>ctx.limits.maxObjects){result.status='teilweise';result.warnings.push({code:'objekte_gekappt',message:'ICO-Bildliste überschreitet die Objektgrenze.'});}
  const gross=[...bilder].sort((a,b)=>b.width*b.height-a.width*a.height||(b.bits??0)-(a.bits??0))[0];
  result.metadata={...result.metadata,...bildMetadata({
   kind:'image',width:gross?.width??null,height:gross?.height??null,has_alpha:gross?bilder.some(b=>b.alpha):null,
   channels:gross?(gross.alpha?4:3):null,bits_per_channel:gross?.kanalBits??null,
   format_name:gross?(cur?'CUR':'ICO')+(gross.png?' (PNG)':' (BMP '+(gross.bits??'?')+' bit)'):null,
   fmt:gross?.bits?{bw:1,bh:1,bits:gross.bits}:null,
  },{
   animated:false,frame_count:1,image_count:count,eingebettete_png:pngAnzahl,
   groessen:[...new Set(bilder.map(b=>b.width+'x'+b.height))].slice(0,32),
   ...(cur&&gross?.hotspot?{hotspot_x:gross.hotspot.x,hotspot_y:gross.hotspot.y}:{}),
  })};
  if(!result.objects.length&&count<=ctx.limits.maxObjects)result.status='fehler';
  return result;
 },
};
