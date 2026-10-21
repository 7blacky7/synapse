/** ICO directory inspection only; pixel decoding stays in the shared FFmpeg preview renderer. */
import type {AssetInspector} from '../../types.js';
import {erzeugeAssetResult} from '../../types.js';

export const icoInspector:AssetInspector={
 id:'textur-ico',formats:['ico'],extensions:['.ico'],magic:[{offset:0,bytes:[0,0,1,0],format:'ico'}],version:2,
 /** Four common bytes alone are insufficient for unnamed/foreign binary formats. */
 pruefeMagic(filePath,headBytes,size){
  if(/\.ico$/i.test(filePath))return true;
  if(headBytes.length<22)return false;
  const b=Buffer.from(headBytes.buffer,headBytes.byteOffset,headBytes.byteLength);
  const count=b.readUInt16LE(4),end=6+16*count,planes=b.readUInt16LE(10),bits=b.readUInt16LE(12);
  const length=b.readUInt32LE(14),offset=b.readUInt32LE(18);
  return count>0&&count<=256&&b[9]===0&&planes<=1&&[0,1,4,8,16,24,32].includes(bits)&&
   length>=12&&offset>=end&&offset+length<=(size??b.length);
 },

 async inspect(src,ctx){
  const result=erzeugeAssetResult(src.filePath,src.size,{asset_type:'image',format:'ico',inspector:'textur-ico',parser_version:2,
   metadata:{mime_type:'image/x-icon'}});
  const bad=(message:string)=>{result.status='fehler';result.warnings.push({code:'ico_verzeichnis_ungueltig',message});return result;};
  const head=await src.readRange(0,6);
  if(head.length!==6||head.readUInt16LE(0)!==0||head.readUInt16LE(2)!==1)return bad('Kein vollständiger ICO-Dateikopf.');
  const count=head.readUInt16LE(4),directoryEnd=6+count*16;
  if(!count||directoryEnd>src.size)return bad('ICO-Bildverzeichnis fehlt oder ist abgeschnitten.');
  for(let i=0;i<Math.min(count,ctx.limits.maxObjects);i++){
   ctx.pruefeAbbruch();
   const entry=await src.readRange(6+i*16,16);
   if(entry.length!==16)return bad('ICO-Bildverzeichnis ist abgeschnitten.');
   const width=entry[0]||256,height=entry[1]||256,bits=entry.readUInt16LE(6),length=entry.readUInt32LE(8),offset=entry.readUInt32LE(12);
   if(!length||offset<directoryEnd||offset+length>src.size){
    result.status='teilweise';result.warnings.push({code:'ico_bildbereich_ungueltig',message:'ICO-Bild '+i+' liegt außerhalb der Datei.'});continue;
   }
   result.objects.push({kind:'image',name:'icon-'+i,data:{width,height,bits_per_pixel:bits||null},source_range:{offset,length}});
  }
  if(count>ctx.limits.maxObjects){result.status='teilweise';result.warnings.push({code:'objekte_gekappt',message:'ICO-Bildliste überschreitet die Objektgrenze.'});}
  result.metadata={...result.metadata,image_count:count,width:result.objects[0]?.data.width??null,height:result.objects[0]?.data.height??null};
  if(!result.objects.length&&count<=ctx.limits.maxObjects)result.status='fehler';
  return result;
 },
};
