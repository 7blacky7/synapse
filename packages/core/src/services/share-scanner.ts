/** A13: ein periodischer, FD-verankerter Scanner für Projekt und Reverse.
 * Fehlende Dateien erzeugen ausdrücklich KEINE Tombstones. Nur explizite, revisionsgebundene Deletes tun das.
 */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import type {ReadStream} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as path from 'node:path';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {starteApiAuftragsLoop} from './api-auftrags-loop.js';
import type {ApiAuftragsLoop} from './api-auftrags-loop.js';

export interface ShareScanWurzel {id:string;pfad:string;}
export interface ShareScanDatei {
 bereich:'projekt'|'reverse';wurzel:ShareScanWurzel;pfad:string;groesse:number;sha256:string;kopf:Uint8Array;
 /** Nur während des Handlers lesbar; jede Öffnung prüft Inode/Stat, Symlinks werden nie verfolgt. */
 oeffne:()=>Promise<ReadStream>;
}
export interface ShareScannerHandler {
 wurzeln:()=>Promise<ShareScanWurzel[]>;
 datei:(datei:ShareScanDatei)=>Promise<boolean|void>;
}
interface Beobachtung {stat:string;hash?:string;}
export interface ShareScanCheckpoint {dateien:Record<string,Beobachtung>;vollstaendig:boolean;}
export interface ShareScannerStore {
 laden:(key:string)=>Promise<ShareScanCheckpoint|null>;
 speichern:(key:string,stand:ShareScanCheckpoint)=>Promise<void>;
}
const pgStore:ShareScannerStore={
 laden:async key=>(await getPool().query('SELECT stand FROM asset_scan_checkpoints WHERE root_key=$1',[key])).rows[0]?.stand??null,
 speichern:async(key,stand)=>{await getPool().query('INSERT INTO asset_scan_checkpoints(root_key,stand) VALUES($1,$2::jsonb) ON CONFLICT(root_key) DO UPDATE SET stand=EXCLUDED.stand,updated_at=clock_timestamp()',[key,JSON.stringify(stand)]);}
};
const fdPfad=(h:FileHandle)=>'/proc/self/fd/'+h.fd;
const verboten=new Set(['.intern','_arbeit','_eingang']);
/** P13-T46: Share-Ordner entstehen erst mit Asset-Sync. Nur wenn die Wurzel lexikalisch im Mount liegt,
 * selbst nicht existiert (auch nicht als Symlink) und der nächste existierende Vorfahre symlinkfrei ist,
 * gilt sie als "noch nicht angelegt". Alles andere (Symlink, ELOOP, EACCES, außerhalb) bleibt ein Fehler. */
async function wurzelFehltNur(root:string,base:string):Promise<boolean>{
 if(!(root===base||root.startsWith(base+path.sep)))return false;
 let p=root;
 for(;;){
  try{await fs.lstat(p);break;}
  catch(e){if((e as NodeJS.ErrnoException)?.code!=='ENOENT')return false;const up=path.dirname(p);if(up===p)return false;p=up;}
 }
 if(p===root)return false;
 try{return await fs.realpath(p)===p;}catch{return false;}
}
export class ShareScanner {
 private readonly handler=new Map<'projekt'|'reverse',ShareScannerHandler>();
 private laufend:Promise<void>|null=null;
 private readonly fehlendGemeldet=new Set<string>();
 constructor(private readonly o:{konfiguration?:AssetKonfiguration;store?:ShareScannerStore;fehler?:(e:unknown)=>void}={}){}
 registrieren(bereich:'projekt'|'reverse',handler:ShareScannerHandler):()=>void{
  if(!['projekt','reverse'].includes(bereich)||this.handler.has(bereich))throw new Error('Scannerbereich bereits registriert/ungültig');
  this.handler.set(bereich,handler);return()=>{if(this.handler.get(bereich)===handler)this.handler.delete(bereich);};
 }
 durchlauf():Promise<void>{
  if(this.laufend)return this.laufend;
  this.laufend=this.scan().finally(()=>{this.laufend=null;});return this.laufend;
 }
 private async scan():Promise<void>{
  const cfg=this.o.konfiguration??getAssetKonfiguration();
  for(const [bereich,handler] of this.handler){
   if(bereich==='projekt'?!cfg.aktiv:!cfg.reverse.aktiv)continue;
   for(const wurzel of await handler.wurzeln()){
    try{await this.wurzel(bereich,wurzel,handler,cfg);}catch(e){if(this.o.fehler)this.o.fehler(e);else throw e;}
   }
  }
 }
 private async wurzel(bereich:'projekt'|'reverse',wurzel:ShareScanWurzel,handler:ShareScannerHandler,cfg:AssetKonfiguration){
  const mount=bereich==='projekt'?cfg.speicher.root:cfg.speicher.reverseRoot;
  if(!mount||!path.isAbsolute(wurzel.pfad)||!wurzel.id)throw new Error('Ungültige Scannerwurzel');
  const root=path.resolve(wurzel.pfad),base=await fs.realpath(mount),fehlKey=bereich+':'+root;
  let real:string;
  try{real=await fs.realpath(root);}
  catch(e){
   if((e as NodeJS.ErrnoException)?.code==='ENOENT'&&await wurzelFehltNur(root,base)){
    if(!this.fehlendGemeldet.has(fehlKey)){this.fehlendGemeldet.add(fehlKey);console.debug('[share-scanner] Share-Ordner fehlt noch, übersprungen:',root);}
    return;
   }
   throw e;
  }
  this.fehlendGemeldet.delete(fehlKey);
  if(real!==root||!(real===base||real.startsWith(base+path.sep)))throw new Error('Scannerwurzel verlässt konfigurierten Mount');
  const store=this.o.store??pgStore,key=bereich+':'+wurzel.id+':'+root;
  const vorher=await store.laden(key),next:ShareScanCheckpoint={dateien:Object.create(null),vollstaendig:false};
  const rootFd=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  let count=0;
  const max=bereich==='projekt'?cfg.speicher.maxProjektDateien:cfg.reverse.maxProjektDateien;
  const maxBytes=bereich==='projekt'?cfg.speicher.maxDateiBytes:cfg.reverse.maxDateiBytes;
  const sig=(s:import('node:fs').Stats)=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
  const pruefeFd=async(h:FileHandle)=>{const p=await fs.realpath(fdPfad(h));if(!(p===root||p.startsWith(root+path.sep)))throw new Error('Scannerpfad wurde aus Root verschoben');};
  const walk=async(dir:FileHandle,prefix:string,tiefe:number):Promise<void>=>{
   await pruefeFd(dir);
   for(const entry of await fs.readdir(fdPfad(dir),{withFileTypes:true})){
    if(verboten.has(entry.name)||entry.isSymbolicLink())continue;
    const logical=normalisiereSpeicherPfad(prefix+entry.name);
    if(entry.isDirectory()){
     if(tiefe>=cfg.inspektion.maxDepth)throw new Error('Scanner-Tiefengrenze: unvollständiger Scan');
     const child=await fs.open(fdPfad(dir)+'/'+entry.name,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
     try{await walk(child,logical+'/',tiefe+1);}finally{await child.close();}continue;
    }
    if(!entry.isFile())continue;
    if(++count>max)throw new Error('Scanner-Dateigrenze: unvollständiger Scan');
    const name=fdPfad(dir)+'/'+entry.name;
    const h=await fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
     await pruefeFd(h);const before=await h.stat();
     if(!before.isFile()||before.size>maxBytes)continue;
     const stat=sig(before),old=vorher?.dateien[logical];
     next.dateien[logical]={stat};
     if(old?.stat!==stat)continue; // Zweite vollständige Stat-Beobachtung in einem späteren Durchlauf.
     const hash=createHash('sha256');
     for await(const bytes of h.createReadStream({start:0,autoClose:false,highWaterMark:cfg.speicher.chunkBytes}))hash.update(bytes);
     await pruefeFd(h);if(sig(await h.stat())!==stat)continue;
     const sha256=hash.digest('hex');
     const kopf=Buffer.alloc(4096),head=await h.read(kopf,0,kopf.length,0);
     if(old.hash===sha256){next.dateien[logical].hash=sha256;continue;}
     const streams:ReadStream[]=[];
     try{
      const accepted=await handler.datei({bereich,wurzel,pfad:logical,groesse:before.size,sha256,kopf:kopf.subarray(0,head.bytesRead),oeffne:async()=>{
       await pruefeFd(dir);
       const source=await fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
       try{await pruefeFd(source);if(sig(await source.stat())!==stat)throw new Error('Scannerquelle während Transfer verändert');
        const stream=source.createReadStream({autoClose:true,highWaterMark:cfg.speicher.chunkBytes});streams.push(stream);return stream;
       }catch(e){await source.close();throw e;}
      }});
      if(accepted!==false&&sig(await h.stat())===stat)next.dateien[logical].hash=sha256;
     }finally{for(const stream of streams)stream.destroy();}
    }finally{await h.close();}
   }
  };
  try{await walk(rootFd,'',0);next.vollstaendig=true;await store.speichern(key,next);}
  finally{await rootFd.close();}
 }
}
export const shareScanner=new ShareScanner({fehler:e=>console.error('[share-scanner]',e)});
export const registriereShareScannerBereich=(bereich:'projekt'|'reverse',handler:ShareScannerHandler)=>shareScanner.registrieren(bereich,handler);
export function starteShareScanner(scanner=shareScanner):ApiAuftragsLoop{
 return starteApiAuftragsLoop({intervallMs:getAssetKonfiguration().sync.scanIntervallMs,arbeit:()=>scanner.durchlauf(),fehler:e=>console.error('[share-scanner]',e)});
}
