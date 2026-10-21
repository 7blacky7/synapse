/** A14: echter Raster-/Video-Decoder nur im API-Prozess, keine Header-Pseudovorschau. */
import {spawn} from 'node:child_process';
import {readSync,fstatSync} from 'node:fs';
import {deflate,inflateSync} from 'node:zlib';
import {promisify} from 'node:util';
import type {AssetKonfiguration} from '../config/asset-konfig.js';

export class AssetAnsichtFehler extends Error {
  constructor(public readonly code:string,message:string){super(message);this.name='AssetAnsichtFehler';}
}
export interface AnsichtRenderGrenzen {
  maxPixel:number;maxBytes:number;maxRamBytes:number;timeoutMs:number;
  maxKante:number;maxFrames:number;maxDauerMs:number;
}
export interface AnsichtRaster {png:Buffer;breite:number;hoehe:number;}
export interface AssetAnsichtRenderer {
  readonly version:string;
  unterstuetzt(format:string):boolean;
  render(fd:number,format:string,grenzen:AnsichtRenderGrenzen,signal?:AbortSignal):Promise<AnsichtRaster>;
}
// Dies ist der echte Decodervertrag, kein aus Inspector-Headern abgeleitetes Versprechen.
// Playlists, SVG/HTML und Archiv-Demuxer sind absichtlich nicht registriert.
const DEMUXER:Readonly<Record<string,string>>=Object.freeze({
  png:'png_pipe',jpg:'jpeg_pipe',jpeg:'jpeg_pipe',webp:'webp_pipe',bmp:'bmp_pipe',
  gif:'gif',ico:'ico',tga:'image2',dds:'dds_pipe',
  mp4:'mov',mov:'mov',m4v:'mov',mkv:'matroska',webm:'matroska',
  avi:'avi',mpeg:'mpeg',mpg:'mpeg',ts:'mpegts',m2ts:'mpegts',flv:'flv',ogv:'ogg',
});
/** Formate mit echtem Decoder (DEMUXER-Schlüssel); A4 gibt sie im Vorschau-Katalog frei (asset-konfig.ts). */
export const ANSICHT_RENDERER_FORMATE:readonly string[]=Object.freeze(Object.keys(DEMUXER));
const zip=promisify(deflate);
function crc32(data:Buffer):number{
  let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
  return(c^0xffffffff)>>>0;
}
function chunk(name:string,data:Buffer):Buffer{
  const type=Buffer.from(name,'ascii'),head=Buffer.alloc(4),tail=Buffer.alloc(4);
  head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(Buffer.concat([type,data])));
  return Buffer.concat([head,type,data,tail]);
}
/** Zlib/CRC-Kodierung der Bildprobe; hier RGBA statt künstlichem Probewort. */
export async function kodiereAnsichtPng(rgba:Buffer,breite:number,hoehe:number,g:AnsichtRenderGrenzen):Promise<Buffer>{
  if(!Number.isSafeInteger(breite)||!Number.isSafeInteger(hoehe)||breite<1||hoehe<1||
    breite*hoehe>g.maxPixel||rgba.length!==breite*hoehe*4||rgba.length*8>g.maxRamBytes){
    throw new AssetAnsichtFehler('ansicht_limit','PNG-Pixel-/RAM-Budget überschritten.');
  }
  const stride=breite*4+1,raw=Buffer.alloc(stride*hoehe);
  for(let y=0;y<hoehe;y++)rgba.copy(raw,y*stride+1,y*breite*4,(y+1)*breite*4);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(breite,0);ihdr.writeUInt32BE(hoehe,4);ihdr[8]=8;ihdr[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
    chunk('IDAT',await zip(raw)),chunk('IEND',Buffer.alloc(0))]);
  if(png.length>g.maxBytes)throw new AssetAnsichtFehler('ansicht_limit','PNG-Ausgabebytes überschritten.');
  return png;
}
/** Prüft mindestens die gespeicherte PNG-Struktur/CRC und Abmessungen auch bei Cachetreffern. */
export function pruefeAnsichtPng(png:Buffer,g:Pick<AnsichtRenderGrenzen,'maxPixel'|'maxBytes'> & Partial<Pick<AnsichtRenderGrenzen,'maxRamBytes'>>):{breite:number;hoehe:number}{
  if(png.length>g.maxBytes||png.length<57||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new AssetAnsichtFehler('ansicht_limit','Ungültige PNG-Ausgabe.');
  let at=8,breite=0,hoehe=0,ended=false,idat=false;
  const daten:Buffer[]=[];
  while(at<png.length){
    if(at+12>png.length)throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','PNG abgeschnitten.');
    const n=png.readUInt32BE(at),end=at+12+n;
    if(end>png.length||crc32(png.subarray(at+4,at+8+n))!==png.readUInt32BE(at+8+n))throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','PNG-CRC ungültig.');
    const name=png.toString('ascii',at+4,at+8);
    if(at===8){if(name!=='IHDR'||n!==13)throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','PNG-IHDR fehlt.');breite=png.readUInt32BE(at+8);hoehe=png.readUInt32BE(at+12);}
    if(name==='IDAT'){idat=true;daten.push(png.subarray(at+8,at+8+n));}
    if(name==='IEND'){ended=n===0&&end===png.length;break;}
    at=end;
  }
  if(!ended||!idat||breite<1||hoehe<1||breite*hoehe>g.maxPixel)throw new AssetAnsichtFehler('ansicht_limit','Ungültige PNG-Abmessungen/Struktur.');
  const erwartet=(breite*4+1)*hoehe;
  if(png[24]!==8||png[25]!==6||png[26]!==0||png[27]!==0||png[28]!==0||
    (g.maxRamBytes!==undefined&&erwartet*8>g.maxRamBytes))throw new AssetAnsichtFehler('ansicht_limit','PNG-Profil/RAM-Budget ungültig.');
  try{
    const raw=inflateSync(Buffer.concat(daten),{maxOutputLength:erwartet});
    if(raw.length!==erwartet)throw Error('Falsche Pixelzahl');
    for(let y=0;y<hoehe;y++)if(raw[y*(breite*4+1)]!==0)throw Error('Abweichender Filter');
  }catch{throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','PNG-Daten beschädigt oder Dekompressionsbudget überschritten.');}
  return {breite,hoehe};
}


/** ICO v:0: FFmpeg decodes colors; Windows DIB AND bits supply legacy transparency. */
function wendeIcoAndMaskeAn(fd:number,rgba:Buffer,w:number,h:number):void{
  const bad=(message:string):never=>{throw new AssetAnsichtFehler('ansicht_nicht_darstellbar',message);};
  const size=fstatSync(fd).size;
  const read=(at:number,n:number):Buffer=>{
    if(at<0||n<0||at+n>size)bad('ICO-Bildbereich ist abgeschnitten.');
    const b=Buffer.alloc(n);let got=0;
    while(got<n){const k=readSync(fd,b,got,n-got,at+got);if(!k)bad('ICO-Bildbereich ist abgeschnitten.');got+=k;}
    return b;
  };
  const head=read(0,22),count=head.readUInt16LE(4),end=6+count*16;
  const length=head.readUInt32LE(14),offset=head.readUInt32LE(18);
  if(head.readUInt32LE(0)!==0x10000||!count||end>size||offset<end||offset+length>size||length<12||
    (head[6]||256)!==w||(head[7]||256)!==h)bad('ICO-Verzeichnis passt nicht zum ersten Decoderbild.');
  const prefix=read(offset,12);
  if(prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return; // PNG owns its alpha.
  const header=prefix.readUInt32LE(0);
  if(![12,40,52,56,108,124].includes(header)||header>length)bad('ICO-DIB-Kopf wird nicht unterstützt.');
  const dib=read(offset,header),core=header===12;
  const dw=core?dib.readUInt16LE(4):dib.readInt32LE(4),dh=core?dib.readUInt16LE(6):dib.readInt32LE(8);
  const planes=dib.readUInt16LE(core?8:12),bits=dib.readUInt16LE(core?10:14),compression=core?0:dib.readUInt32LE(16);
  if(dw!==w||Math.abs(dh)!==h*2||planes!==1||![1,4,8,16,24,32].includes(bits)||
    ![0,3,6].includes(compression)||(compression!==0&&bits!==16&&bits!==32))bad('ICO-DIB-Maske ist nicht eindeutig lesbar.');
  const colors=core?0:dib.readUInt32LE(32),palette=colors||(bits<=8?2**bits:0);
  if(palette>256||(bits<=8&&palette>2**bits))bad('ICO-DIB-Palette ist ungültig.');
  const externalMasks=header===40?(compression===3?12:compression===6?16:0):0;
  const stride=Math.ceil(w*bits/32)*4,maskStride=Math.ceil(w/32)*4;
  const maskAt=header+externalMasks+palette*(core?3:4)+stride*h;
  if(maskAt>length)bad('ICO-DIB-Farbdaten sind abgeschnitten.');
  // A nonzero native 32-bit alpha channel is authoritative (do not erase valid semitransparency).
  if(bits===32){
    const xor=read(offset+maskAt-stride*h,stride*h);let native=false;
    for(let y=0;y<h&&!native;y++)for(let x=0;x<w;x++)if(xor[y*stride+x*4+3]!==0){native=true;break;}
    if(native)return;
  }
  if(maskAt+maskStride*h>length)bad('ICO-AND-Maske ist abgeschnitten.');
  const mask=read(offset+maskAt,maskStride*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const row=dh<0?y:h-1-y;
    rgba[(y*w+x)*4+3]=(mask[row*maskStride+(x>>3)]&(0x80>>(x&7)))?0:255;
  }
}
/** Scale already masked ICO pixels, without interpolating opaque background into transparent edges. */
function skaliereIcoRaster(rgba:Buffer,w:number,h:number,breite:number,hoehe:number):Buffer{
  if(w===breite&&h===hoehe)return rgba;
  const out=Buffer.alloc(breite*hoehe*4);
  for(let y=0;y<hoehe;y++)for(let x=0;x<breite;x++){
    const at=(Math.min(h-1,Math.floor((y+.5)*h/hoehe))*w+Math.min(w-1,Math.floor((x+.5)*w/breite)))*4;
    rgba.copy(out,(y*breite+x)*4,at,at+4);
  }
  return out;
}

export class FfmpegAnsichtRenderer implements AssetAnsichtRenderer {
  readonly version='ffmpeg-rgba-png-v2-ico-and';
  constructor(private readonly cfg:AssetKonfiguration){}
  unterstuetzt(format:string):boolean{return Object.hasOwn(DEMUXER,format);}
  private lauf(programm:string,args:string[],fd:number,g:AnsichtRenderGrenzen,maxBytes:number,signal?:AbortSignal):Promise<Buffer>{
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(new AssetAnsichtFehler('ansicht_limit','Decoder abgebrochen.'));return;}
      const cpu=Math.max(1,Math.ceil(g.timeoutMs/1000));
      const child=spawn(this.cfg.vorschau.prlimit??'prlimit',
        ['--as='+g.maxRamBytes,'--cpu='+cpu,'--core=0','--',programm,...args],
        {stdio:['ignore','pipe','pipe',fd],env:{PATH:process.env.PATH,LANG:'C',OMP_NUM_THREADS:'1'}});
      const chunks:Buffer[]=[];let n=0,failure:Error|undefined;
      const stop=(e:Error)=>{failure??=e;child.kill('SIGKILL');};
      const abort=()=>stop(new AssetAnsichtFehler('ansicht_limit','Decoderzeit überschritten.'));
      const timer=setTimeout(abort,g.timeoutMs);signal?.addEventListener('abort',abort,{once:true});
      child.stdout!.on('data',(b:Buffer)=>{n+=b.length;if(n>maxBytes)stop(new AssetAnsichtFehler('ansicht_limit','Decoder-Ausgabebudget überschritten.'));else chunks.push(b);});
      // Fehlertext kann Nutzermetadaten enthalten: verwerfen statt loggen/speichern.
      child.stderr!.resume();
      child.on('error',e=>{failure??=new AssetAnsichtFehler('ansicht_nicht_darstellbar','Rendererwerkzeug nicht verfügbar: '+(e as NodeJS.ErrnoException).code);});
      child.on('close',code=>{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(failure)reject(failure);
        else if(code!==0)reject(new AssetAnsichtFehler('ansicht_nicht_darstellbar','Installierter Decoder kann diese Bytes nicht darstellen.'));
        else resolve(Buffer.concat(chunks,n));
      });
    });
  }
  async render(fd:number,format:string,g:AnsichtRenderGrenzen,signal?:AbortSignal):Promise<AnsichtRaster>{
    const demuxer=DEMUXER[format];if(!demuxer)throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','Kein registrierter Renderer für dieses Format.');
    const start=Date.now(),left=()=>{const timeoutMs=g.timeoutMs-(Date.now()-start);if(timeoutMs<=0)throw new AssetAnsichtFehler('ansicht_limit','Decoderzeit überschritten.');return {...g,timeoutMs};};
    const input=['-protocol_whitelist','file,pipe','-format_whitelist',demuxer,'-f',demuxer,
      ...(demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-i','/proc/self/fd/3'];
    const meta=await this.lauf(this.cfg.vorschau.ffprobe??'ffprobe',
      ['-v','error','-max_alloc',String(Math.floor(g.maxRamBytes/8)),'-threads','1',
        '-read_intervals','%+'+(g.maxDauerMs/1000),...input,
        '-select_streams','v:0','-show_entries','stream=width,height','-of','json'],fd,left(),65536,signal);
    let w:number,h:number;
    try{const stream=JSON.parse(meta.toString('utf8')).streams?.[0];w=stream?.width;h=stream?.height;}
    catch{throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','Decoder lieferte keine gültigen Bilddaten.');}
    if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w!<1||h!<1||w!*h!>g.maxPixel||w!*h!*4>g.maxRamBytes/8){
      throw new AssetAnsichtFehler('ansicht_limit','Quellpixel/RAM überschreiten Decoderbudget.');
    }
    let edge=g.maxKante;
    for(;;){
      const scale=Math.min(1,edge/Math.max(w!,h!));
      const breite=Math.max(1,Math.floor(w!*scale)),hoehe=Math.max(1,Math.floor(h!*scale));
      const pixelBreite=format==='ico'?w!:breite,pixelHoehe=format==='ico'?h!:hoehe;
      const rgba=await this.lauf(this.cfg.vorschau.ffmpeg??'ffmpeg',
        ['-nostdin','-v','error','-max_alloc',String(Math.floor(g.maxRamBytes/8)),'-threads','1',...input,
         '-map','0:v:0','-an','-sn','-dn','-t',String(g.maxDauerMs/1000),'-frames:v',String(Math.min(1,g.maxFrames)),
         '-vf','scale='+pixelBreite+':'+pixelHoehe,'-filter_threads','1','-threads','1',
         '-f','rawvideo','-pix_fmt','rgba','pipe:1'],fd,left(),pixelBreite*pixelHoehe*4,signal);
      if(rgba.length!==pixelBreite*pixelHoehe*4)throw new AssetAnsichtFehler('ansicht_nicht_darstellbar','Kein vollständiges Standbild.');
      if(format==='ico'){left();wendeIcoAndMaskeAn(fd,rgba,w!,h!);left();}
      const output=format==='ico'?skaliereIcoRaster(rgba,w!,h!,breite,hoehe):rgba;
      try{
        const png=await kodiereAnsichtPng(output,breite,hoehe,g);left();
        return {png,breite,hoehe};
      }catch(e){
        if(!(e instanceof AssetAnsichtFehler)||e.code!=='ansicht_limit'||edge===1)throw e;
        edge=Math.max(1,Math.floor(edge/2));
      }
    }
  }
}
