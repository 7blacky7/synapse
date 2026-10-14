/** A8 persistent scoped transfer state. Bytes are streamed through the API, never PG/debug. */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {normalisiereSpeicherPfad,loadGitignore,shouldIgnore} from '@synapse/core';
import type {AssetSyncRichtung} from '@synapse/core';
import {AssetApiTransport,AssetApiFehler} from './asset-api-transport.js';
import {pruefeLokalesAsset} from './asset-erkennung.js';

export interface AssetTransferScope {bereich:'projekt'|'reverse';ziel_ref:string;host:string;root:string;apiPfad?:string;
 /** RV6: eigenes Zustandsverzeichnis außerhalb der Wurzel (Reverse-Bibliothek); ohne = <root>/.synapse/asset-sync. */
 zustandsDir?:string;}
/** RV6: Routenadapter Reverse. Sitzungen entstehen über POST /api/reverse/fundstellen (nicht POST uploads); null = Bytes sind serverseitig bekannt. */
export interface ReverseRoutenAdapter {sitzung(pfad:string,h:{sha256:string;groesse:number}):Promise<{upload_id:string;reverse_id:string}|null>;}
export interface AssetTransferOptionen {richtung:AssetSyncRichtung;chunkBytes:number;retryMs:number;timeoutMs:number;maxDateiBytes:number;erlaubteTypen?:string[];parallelTransfers?:number;}
export interface AssetSyncMeta {
 asset_id:string;pfad:string;revision:string|null;sha256:string|null;groesse:number;storage_kind:'assets'|'binaries'|null;
 storage_status?:string;deleted_at?:string|null;restore_until?:string|null;
}
interface Sitzung {id:string;offset:number;status:string;lease_bis:string;asset_id?:string;revision?:string;konflikt?:{id:string;share:{sha256:string;groesse:number;revision:string;tombstone:boolean}};}
interface Auftrag {
 id:string;art:'upload'|'download'|'loeschen';pfad:string;meta?:AssetSyncMeta;bytes_erledigt?:number;ziel?:string;
 /** RV6/K2: Statsignatur, zu der sha256 gehoert (Reverse); gleich der aktuellen = kein erneuter Hash vor dem Upload. */
 hash_signatur?:string;
 upload?:string;sha256?:string;groesse?:number;signatur?:string;beobachtet_ms?:number;basis?:string;versuche:number;naechster:number;fehler?:string;gesperrt?:boolean;
}
interface Zustand {
 version:1;scope:string;auftraege:Auftrag[];bekannt:Record<string,AssetSyncMeta>;marker:Record<string,{sha256:string;revision:string;phase:'installieren'|'fertig'}>;
 cursor?:string;stand?:string;konflikte?:Record<string,unknown>;
}
function error(code:string,status:number,msg:string):never{throw new AssetApiFehler(status,code,msg);}
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const signature=(s:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint})=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** A8/RV6: streamender Hash mit stat vor/nach; eine wachsende oder ersetzte Datei wird nie als stabil gemeldet. */
export async function hasheStabil(target:string,o:{maxDateiBytes:number;chunkBytes:number;signal?:AbortSignal}){
 const fd=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await fd.stat({bigint:true});if(!before.isFile()||before.size>BigInt(o.maxDateiBytes))error('quote',413,'Dateigröße überschreitet Grenze.');
  const hash=createHash('sha256');let size=0;
  for await(const chunk of fd.createReadStream({autoClose:false,highWaterMark:o.chunkBytes})){if(o.signal?.aborted)throw o.signal.reason;hash.update(chunk);size+=chunk.length;}
  const after=await fd.stat({bigint:true}),actual=await fs.lstat(target,{bigint:true});
  if(signature(before)!==signature(after)||signature(after)!==signature(actual)||size!==Number(before.size))
   error('datei_geaendert',408,'Datei während Hash geändert; neu einreihen.');
  return {sha256:hash.digest('hex'),groesse:size,signatur:signature(after)};
 }finally{await fd.close();}
}
/** RV6: dieselbe Statsignatur wie Queue und Hash (dev:ino:size:mtimeNs:ctimeNs). */
export const dateiSignatur=signature;
/** RV6: Zustandsverzeichnis außerhalb des Benutzerordners, nur für den Daemon lesbar (0700). */
async function privatesVerzeichnis(dir:string):Promise<string>{
 const p=path.resolve(dir);await fs.mkdir(p,{recursive:true,mode:0o700});
 const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())error('pfad_ungueltig',400,'Zustandsverzeichnis ist kein sicheres Verzeichnis.');
 if((s.mode&0o077)!==0)await fs.chmod(p,0o700);
 return p;
}
let aktiveTransfers=0;
const transferWartende=new Set<()=>void>();
async function transferSlot(max:number,signal:AbortSignal){
 while(aktiveTransfers>=max){
  await new Promise<void>((resolve,reject)=>{
   const wake=()=>{transferWartende.delete(wake);signal.removeEventListener('abort',abort);resolve();};
   const abort=()=>{transferWartende.delete(wake);signal.removeEventListener('abort',abort);reject(signal.reason);};
   transferWartende.add(wake);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
 }
 if(signal.aborted)throw signal.reason;
 aktiveTransfers++;
 return ()=>{aktiveTransfers--;for(const wake of [...transferWartende])wake();};
}
function pruefeOptionen(o:AssetTransferOptionen){
 if(!['both','pc_to_share','share_to_pc'].includes(o.richtung))throw new TypeError('Ungültige Transferrichtung.');
 for(const key of ['chunkBytes','retryMs','timeoutMs','maxDateiBytes'] as const)
  if(!Number.isSafeInteger(o[key])||o[key]<1)throw new TypeError('Ungültige Transfergrenze '+key);
 if(o.parallelTransfers!==undefined&&(!Number.isSafeInteger(o.parallelTransfers)||o.parallelTransfers<1))throw new TypeError('Ungültige Transferparallelität.');
}
export class AssetTransferQueue {
 readonly scope:AssetTransferScope;
 private state!:Zustand;private dir!:string;private file!:string;
 private readonly ready:Promise<void>;private serial=Promise.resolve();private stopped=false;
 private readonly abort=new AbortController();
 private wake?:NodeJS.Timeout;private draining=false;private paused=true;private lauf?:Promise<void>;
 constructor(scope:AssetTransferScope,private optionen:AssetTransferOptionen,readonly api=new AssetApiTransport(),
  private readonly geaendert:()=>void=()=>{},private readonly reverse?:ReverseRoutenAdapter){
  pruefeOptionen(optionen);
  this.scope={...scope,root:path.resolve(scope.root)};
  if(!scope.host||normalisiereSpeicherPfad(scope.ziel_ref)!==scope.ziel_ref||scope.ziel_ref.includes('/'))throw new Error('Ungültige Transferbindung.');
  if(scope.apiPfad&&!/^\/api\/[A-Za-z0-9_/%.-]+$/.test(scope.apiPfad))throw new Error('Ungültige Transferroute.');
  if(scope.bereich==='reverse'&&!scope.apiPfad)throw new Error('Reverse braucht seinen registrierten API-Routenadapter.');
  if(scope.zustandsDir!==undefined&&!path.isAbsolute(scope.zustandsDir))throw new Error('Ungültiges Zustandsverzeichnis.');
  this.ready=this.load();
 }
 get base(){return this.scope.apiPfad??'/api/projects/'+encodeURIComponent(this.scope.ziel_ref)+'/assets';}
 /** RV6: Reverse-Sitzungen liegen unter /api/reverse/<reverse_id>/uploads, Projekt unter <base>/uploads. */
 private uploads(j:Auftrag){return this.scope.bereich==='reverse'?this.base+'/'+encodeURIComponent(j.ziel??'')+'/uploads':this.base+'/uploads';}
 /** RV6: Reverse nimmt jede reguläre Datei (Ordner-Medien), ohne gitignore/Asset-Typprüfung. */
 private async reverseKandidat(pfad:string){
  const target=await this.local(pfad);
  try{
   const s=await fs.lstat(target,{bigint:true});
   if(!s.isFile()||s.size>BigInt(this.optionen.maxDateiBytes))return null;
   return {format:'reverse-original',groesse:Number(s.size),signatur:signature(s)};
  }catch(e){if(missing(e))return null;throw e;}
 }
 private async locked<T>(fn:()=>Promise<T>):Promise<T>{
  const run=this.serial.then(fn);this.serial=run.then(()=>{},()=>{});return run;
 }
 private async directory(rel:string):Promise<string>{
  const root=await fs.realpath(this.scope.root);if(root!==this.scope.root)error('pfad_ungueltig',400,'Gebundene Wurzel ist ein Symlink.');
  let p=root;
  for(const part of rel.split('/').filter(Boolean)){
   p=path.join(p,part);await fs.mkdir(p).catch(e=>{if(e.code!=='EEXIST')throw e;});
   const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())error('pfad_ungueltig',400,'Verzeichnis ist kein sicherer Projektpfad.');
  }
  return p;
 }
 private async load(){
  this.dir=this.scope.zustandsDir?await privatesVerzeichnis(this.scope.zustandsDir):await this.directory('.synapse/asset-sync');
  const key=createHash('sha256').update(this.scope.bereich+'\0'+this.scope.ziel_ref+'\0'+this.scope.host).digest('hex');
  this.file=path.join(this.dir,key+'.json');
  const scope=this.scope.bereich+':'+this.scope.ziel_ref+':'+this.scope.host;
  try{
   const handle=await fs.open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW);
   let raw;try{raw=JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
   if(raw.version!==1||raw.scope!==scope||!Array.isArray(raw.auftraege)||!raw.bekannt||!raw.marker)throw new Error('Transferzustand ungültig; keine automatische Überschreibung.');
   this.state=raw;
   this.state.bekannt=Object.assign(Object.create(null),raw.bekannt);this.state.marker=Object.assign(Object.create(null),raw.marker);
   this.state.konflikte=Object.assign(Object.create(null),raw.konflikte??{});
   for(const job of this.state.auftraege){normalisiereSpeicherPfad(job.pfad);if(!UUID.test(job.id)||job.upload!==undefined&&!UUID.test(job.upload)||!['upload','download','loeschen'].includes(job.art))throw new Error('Ungültiger persistierter Transferauftrag.');}
  }catch(e){if(!missing(e))throw e;this.state={version:1,scope,auftraege:[],bekannt:Object.create(null),marker:Object.create(null)};await this.save();}
 }
 private async save(){
  const tmp=this.file+'.'+randomUUID()+'.tmp',fd=await fs.open(tmp,'wx',0o600);
  try{await fd.writeFile(JSON.stringify(this.state));await fd.sync();}finally{await fd.close();}
  await fs.rename(tmp,this.file);
  const d=await fs.open(this.dir,'r');try{await d.sync();}finally{await d.close();}
  this.geaendert();
 }
 async status(){await this.ready;return {bereich:this.scope.bereich,ziel_ref:this.scope.ziel_ref,cursor:this.state.cursor,
  stand:this.state.stand,auftraege:this.state.auftraege.map(j=>({...j})),bekannt:Object.keys(this.state.bekannt).length,konflikte:Object.values(this.state.konflikte??{}),laufend:this.draining};}
 async kandidat(pfad:string){await this.ready;return pruefeLokalesAsset(this.scope.root,this.scope.ziel_ref,pfad,this.optionen);}
 async bekannt(pfad:string){await this.ready;return this.state.bekannt[normalisiereSpeicherPfad(pfad)];}
 async fullscan(){await this.ready;await this.locked(async()=>{delete this.state.cursor;await this.save();});}
 async checkpoint(cursor:string,stand:string){
  await this.ready;await this.locked(async()=>{if(this.state.auftraege.some(j=>j.art!=='upload'))error('checkpoint_offen',409,'Downloads noch nicht bestätigt.');
   this.state.cursor=cursor;this.state.stand=stand;await this.save();});
 }
 /** A10 seeds the already hash-verified installed snapshot before any watcher/queue starts. */
 async restoreCheckpoint(entries:AssetSyncMeta[],cursor:string,stand:string){
  await this.ready;
  if(this.state.auftraege.length)error('restore_queue_belegt',409,'Restore braucht eine ruhende Transferqueue.');
  for(const entry of entries){
   if(!entry.sha256||!entry.revision||(await this.hash(entry.pfad)).sha256!==entry.sha256)error('restore_hash_falsch',409,'Installierter Restorestand ist nicht bestätigt.');
  }
  await this.locked(async()=>{
   for(const entry of entries){this.state.bekannt[entry.pfad]={...entry};this.state.marker[entry.pfad]={sha256:entry.sha256!,revision:entry.revision!,phase:'fertig'};}
   this.state.cursor=cursor;this.state.stand=stand;await this.save();
  });
 }
 setzeOptionen(o:AssetTransferOptionen){pruefeOptionen(o);const changed=this.optionen.richtung!==o.richtung;this.optionen=o;return changed;}
 /** RV6: vom Bibliotheks-Watcher stabil gehashte Datei mit der Sitzung aus POST /api/reverse/fundstellen einreihen. */
 async reverseEinreihen(pfad:string,e:{upload_id:string;reverse_id:string;sha256:string;groesse:number;signatur:string}){
  await this.ready;
  if(this.scope.bereich!=='reverse')error('bereich_ungueltig',400,'Nur für den Reverse-Bereich.');
  if(!UUID.test(e.upload_id)||!HASH.test(e.sha256)||!Number.isSafeInteger(e.groesse)||e.groesse<0||typeof e.reverse_id!=='string'||normalisiereSpeicherPfad(e.reverse_id)!==e.reverse_id||e.reverse_id.includes('/'))
   error('sitzung_ungueltig',409,'Reverse-Sitzung ungültig.');
  const rel=normalisiereSpeicherPfad(pfad);
  await this.locked(async()=>{
   const j=this.state.auftraege.find(x=>x.pfad===rel&&x.art==='upload');
   if(j&&j.upload===e.upload_id&&j.sha256===e.sha256){j.ziel=e.reverse_id;j.hash_signatur=e.signatur;j.gesperrt=false;j.naechster=0;}
   else if(j){
    j.upload=e.upload_id;j.ziel=e.reverse_id;j.sha256=e.sha256;j.groesse=e.groesse;j.signatur=e.signatur;j.hash_signatur=e.signatur;j.bytes_erledigt=0;
    j.gesperrt=false;j.naechster=0;j.versuche=0;delete j.fehler;delete j.beobachtet_ms;
   }else this.state.auftraege.push({id:randomUUID(),art:'upload',pfad:rel,upload:e.upload_id,ziel:e.reverse_id,sha256:e.sha256,groesse:e.groesse,signatur:e.signatur,hash_signatur:e.signatur,basis:'0',versuche:0,naechster:0});
   delete this.state.bekannt[rel];await this.save();
  });
 }
 /** RV6: offene Aufträge eines lokal verschwundenen Pfads verwerfen (nie ein Fern-Löschen). */
 async verwerfen(pfad:string){
  await this.ready;const rel=normalisiereSpeicherPfad(pfad);
  await this.locked(async()=>{
   const vorher=this.state.auftraege.length;this.state.auftraege=this.state.auftraege.filter(j=>j.pfad!==rel);
   const known=rel in this.state.bekannt;delete this.state.bekannt[rel];
   if(vorher!==this.state.auftraege.length||known)await this.save();
  });
 }
 private async local(pfad:string,create=false):Promise<string>{
  const rel=normalisiereSpeicherPfad(pfad);
  if(this.scope.bereich!=='reverse'&&shouldIgnore(loadGitignore(this.scope.root),rel))error('pfad_gesperrt',403,'Gesperrter oder ignorierter Projektpfad.');
  const parts=rel.split('/');let parent=this.scope.root;
  for(const part of parts.slice(0,-1)){
   parent=path.join(parent,part);
   if(create)await fs.mkdir(parent).catch(e=>{if(e.code!=='EEXIST')throw e;});
   const s=await fs.lstat(parent);if(s.isSymbolicLink()||!s.isDirectory())error('pfad_ungueltig',400,'Symlink/Datei im Elternpfad.');
  }
  const target=path.join(parent,parts.at(-1)!);
  try{const s=await fs.lstat(target);if(s.isSymbolicLink()||!s.isFile())error('pfad_ungueltig',400,'Ziel ist kein reguläres Asset.');}catch(e){if(!missing(e))throw e;}
  return target;
 }
 async hash(pfad:string){
  await this.ready;const target=await this.local(pfad);
  return hasheStabil(target,{maxDateiBytes:this.optionen.maxDateiBytes,chunkBytes:this.optionen.chunkBytes,signal:this.abort.signal});
 }
 async ereignis(pfad:string,typ:'add'|'change'|'unlink'){
  await this.ready;const rel=normalisiereSpeicherPfad(pfad);
  if(this.optionen.richtung==='share_to_pc')return;
  await this.locked(async()=>{
   const known=this.state.bekannt[rel];
   if(typ==='unlink'&&!known)return; // A missing source or incomplete scan is never a remote delete.
   const existing=this.state.auftraege.find(j=>j.pfad===rel&&j.art!=='download');
   if(existing){existing.art=typ==='unlink'?'loeschen':'upload';existing.gesperrt=false;existing.naechster=0;}
   else this.state.auftraege.push({id:randomUUID(),art:typ==='unlink'?'loeschen':'upload',pfad:rel,basis:known?.revision??'0',versuche:0,naechster:0});
   await this.save();
  });
 }
 async herunterladen(meta:AssetSyncMeta){
  await this.ready;
  if(this.optionen.richtung==='pc_to_share')return;
  const pfad=normalisiereSpeicherPfad(meta.pfad);
  if(meta.storage_status==='legacy_local'||meta.revision===null)return;
  if(meta.storage_status!=='ready'||!meta.revision||!/^[1-9][0-9]*$/.test(meta.revision)||!meta.sha256||!HASH.test(meta.sha256)||!Number.isSafeInteger(meta.groesse)||meta.groesse<0||meta.groesse>this.optionen.maxDateiBytes)error('metadaten_ungueltig',409,'Nicht bestätigte oder ungültige Share-Revision; Cursor bleibt offen.');
  await this.locked(async()=>{
   const known=this.state.bekannt[pfad];
   if(known?.revision===meta.revision&&known.deleted_at===meta.deleted_at)return;
   const prior=this.state.auftraege.find(j=>j.art==='download'&&j.pfad===pfad);
   if(prior){prior.meta=meta;prior.gesperrt=false;prior.naechster=0;}
   else this.state.auftraege.push({id:randomUUID(),art:'download',pfad,meta,versuche:0,naechster:0});
   await this.save();
  });
 }
 private async upload(j:Auftrag){
  if(this.optionen.richtung==='share_to_pc')return;
    const detected=this.scope.bereich==='reverse'?await this.reverseKandidat(j.pfad):await pruefeLokalesAsset(this.scope.root,this.scope.ziel_ref,j.pfad,this.optionen);
    if(!detected)return;
    if(j.signatur!==detected.signatur){j.signatur=detected.signatur;j.beobachtet_ms=Date.now();await this.save();error('datei_geaendert',408,'Erste stabile Statbeobachtung; Hash erst im nächsten Retry.');}
    if(j.beobachtet_ms!==undefined&&Date.now()-j.beobachtet_ms<this.optionen.retryMs)error('datei_geaendert',408,'Stabilitätsintervall noch nicht abgelaufen.');
    // RV6/K2: Reverse spart den Hash vor dem Upload, wenn genau diese Statsignatur schon stabil gehasht wurde (Kontrollhash nach dem Upload bleibt).
    const h=this.scope.bereich==='reverse'&&j.sha256&&j.groesse!==undefined&&j.hash_signatur===detected.signatur
     ?{sha256:j.sha256,groesse:j.groesse,signatur:detected.signatur}:await this.hash(j.pfad),known=this.state.bekannt[j.pfad];
  const marker=this.state.marker[j.pfad];
  if((known?.sha256===h.sha256&&!known.deleted_at)||(marker?.sha256===h.sha256)){return;}
  if(j.sha256&&j.sha256!==h.sha256){j.upload=undefined;j.id=randomUUID();if(this.scope.bereich==='reverse')delete j.ziel;}
  Object.assign(j,h);if(this.scope.bereich==='reverse')j.hash_signatur=h.signatur;j.basis??=known?.revision??'0';await this.save();
  let upload:Sitzung;
  if(j.upload){
   try{
    upload=(await this.api.json<{upload:Sitzung}>(this.uploads(j)+'/'+encodeURIComponent(j.upload),undefined,'GET',this.abort.signal)).upload;
    if(upload.status!=='finalisiert'&&(['fehler','abgebrochen'].includes(upload.status)||Date.parse(upload.lease_bis)<=Date.now())){
     j.upload=undefined;j.id=randomUUID();j.bytes_erledigt=0;await this.save();
    }
   }
   catch(e){if(e instanceof AssetApiFehler&&[404,410].includes(e.status)){j.upload=undefined;j.id=randomUUID();await this.save();}else throw e;}
  }
  if(!j.upload&&this.scope.bereich==='reverse'){
   // RV6: Reverse-Sitzung kommt aus fundstellen (Routenadapter); bekannt = nichts zu übertragen.
   if(!this.reverse)error('route_fehlt',500,'Reverse-Routenadapter fehlt.');
   const s=await this.reverse.sitzung(j.pfad,{sha256:h.sha256,groesse:h.groesse});
   if(!s){this.state.bekannt[j.pfad]={asset_id:h.sha256,pfad:j.pfad,revision:'1',sha256:h.sha256,groesse:h.groesse,storage_kind:'binaries',deleted_at:null};await this.save();return;}
   if(!UUID.test(s.upload_id)||typeof s.reverse_id!=='string'||normalisiereSpeicherPfad(s.reverse_id)!==s.reverse_id||s.reverse_id.includes('/'))error('sitzung_ungueltig',409,'Reverse-Sitzung ungültig.');
   j.upload=s.upload_id;j.ziel=s.reverse_id;j.bytes_erledigt=0;await this.save();
  }
  if(!j.upload){
   upload=(await this.api.json<{upload:Sitzung}>(this.base+'/uploads',{
    logischer_pfad:j.pfad,storage_kind:'assets',groesse:h.groesse,sha256:h.sha256,basis_revision:j.basis,idempotency_key:j.id,format:detected.format,
   },'POST',this.abort.signal)).upload;j.upload=upload.id;await this.save();
  }else upload=(await this.api.json<{upload:Sitzung}>(this.uploads(j)+'/'+encodeURIComponent(j.upload),undefined,'GET',this.abort.signal)).upload;
  if(!upload!.id||!Number.isSafeInteger(upload!.offset)||upload!.offset<0||upload!.offset>h.groesse)error('offset_ungueltig',409,'Serveroffset ungültig.');
  const target=await this.local(j.pfad),fd=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(signature(await fd.stat({bigint:true}))!==h.signatur)error('datei_geaendert',408,'Datei vor Upload verändert.');
   let offset=upload!.offset;j.bytes_erledigt=offset;await this.save();
   while(offset<h.groesse){
    const length=Math.min(this.optionen.chunkBytes,h.groesse-offset),start=offset;
    let res:Response;
    try{res=await this.api.request(this.uploads(j)+'/'+encodeURIComponent(j.upload!)+'/chunk?offset='+offset,{
     method:'PUT',signal:this.abort.signal,timeoutMs:this.optionen.timeoutMs,headers:{'content-type':'application/octet-stream','content-length':String(length)},
     body:()=>{
      const signal=this.abort.signal,chunkBytes=this.optionen.chunkBytes;
      return (async function*(){
       let at=start,remaining=length;
       while(remaining){
        if(signal.aborted)throw signal.reason;
        const buffer=Buffer.allocUnsafe(Math.min(chunkBytes,remaining));
        const {bytesRead}=await fd.read(buffer,0,buffer.length,at);
        if(!bytesRead)error('datei_geaendert',408,'Datei vor bestätigtem Chunkende verkürzt.');
        yield buffer.subarray(0,bytesRead);at+=bytesRead;remaining-=bytesRead;
       }
      })();
     },
    });}catch(e){
     if(e instanceof AssetApiFehler&&e.status===409&&e.code==='offset_konflikt'){
      const state=(await this.api.json<{upload:Sitzung}>(this.uploads(j)+'/'+encodeURIComponent(j.upload!),undefined,'GET',this.abort.signal)).upload;
      if(state.offset===offset+length){offset=state.offset;continue;}
      error('offset_neu_pruefen',408,'Uploadoffset nach unterbrochener Antwort erneut prüfen.');
     }
     throw e;
    }
    const next=(await res.json() as {upload:Sitzung}).upload.offset;
    if(next!==offset+length)error('offset_ungueltig',409,'Server bestätigt anderen Chunk.');
    offset=next;j.bytes_erledigt=offset;await this.save();
   }
   const fresh=await this.hash(j.pfad);
   if(fresh.signatur!==h.signatur||fresh.sha256!==h.sha256)error('datei_geaendert',408,'Datei während Upload geändert.');
  }finally{await fd.close();}
  const final=(await this.api.json<{upload:Sitzung}>(this.uploads(j)+'/'+encodeURIComponent(j.upload!)+'/finalisieren',{},'POST',this.abort.signal)).upload;
  if(!final.asset_id||!final.revision||final.status!=='finalisiert')error('revision_offen',409,'Finalisierung nicht bestätigt.');
  this.state.bekannt[j.pfad]={asset_id:final.asset_id,pfad:j.pfad,revision:final.revision,sha256:h.sha256,groesse:h.groesse,storage_kind:this.scope.bereich==='reverse'?'binaries':'assets',deleted_at:null};
  if(final.konflikt){
   const share=final.konflikt.share;
   if(!share||!HASH.test(share.sha256)||!Number.isSafeInteger(share.groesse)||!/^[1-9][0-9]*$/.test(share.revision))error('konflikt_ungueltig',409,'Konfliktsicherung ohne kanonische Share-Metadaten.');
   this.state.konflikte??=Object.create(null);this.state.konflikte![j.pfad]=final.konflikt;
   const meta:AssetSyncMeta={asset_id:final.asset_id,pfad:j.pfad,revision:share.revision,sha256:share.sha256,groesse:share.groesse,
    storage_kind:this.state.bekannt[j.pfad].storage_kind,storage_status:'ready',deleted_at:share.tombstone?'tombstone':null};
   const existing=this.state.auftraege.find(x=>x.art==='download'&&x.pfad===j.pfad);
   if(existing){existing.meta=meta;existing.gesperrt=false;existing.naechster=0;}
   else this.state.auftraege.push({id:randomUUID(),art:'download',pfad:j.pfad,meta,versuche:0,naechster:0});
  }
  delete this.state.marker[j.pfad];await this.save();
 }
 private async download(j:Auftrag){
  if(this.optionen.richtung==='pc_to_share')return;
  const m=j.meta!,old=this.state.bekannt[j.pfad],target=await this.local(j.pfad,true);
  let current:Awaited<ReturnType<AssetTransferQueue['hash']>>|undefined;
  try{current=await this.hash(j.pfad);}catch(e){if(!missing(e))throw e;}
  if(m.deleted_at){
   if(current&&(!old?.sha256||current.sha256!==old.sha256))error('lokaler_konflikt',409,'Lokale Änderung vor Share-Tombstone sichern.');
   if(current)await fs.rename(target,path.join(this.dir,'deleted-'+j.id)); // retained until explicit configured retention
   this.state.bekannt[j.pfad]=m;delete this.state.marker[j.pfad];await this.save();return;
  }
  if(current?.sha256===m.sha256){this.state.bekannt[j.pfad]=m;await this.save();return;}
  if(current&&(!old?.sha256||current.sha256!==old.sha256)){
   if(this.optionen.richtung!=='share_to_pc'){
    const upload=this.state.auftraege.find(x=>x.art==='upload'&&x.pfad===j.pfad);
    if(!upload)this.state.auftraege.push({id:randomUUID(),art:'upload',pfad:j.pfad,basis:old?.revision??'0',versuche:0,naechster:0});
    error('konflikt_sichern',408,'PC-Fassung zunächst über API unveränderlich sichern.');
   }
   this.state.konflikte??=Object.create(null);this.state.konflikte![j.pfad]={pfad:j.pfad,art:'lokal',sicherung:'pc-before-install-'+j.id};
   await this.save(); // download-only policy retains the old inode locally before Share installation
  }
  const tmp=path.join(this.dir,'download-'+j.id),fd=await fs.open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  const hash=createHash('sha256');let size=0;j.groesse=m.groesse;j.bytes_erledigt=0;await this.save();
  try{
   const res=await this.api.request(this.base+'/bytes?asset_id='+encodeURIComponent(m.asset_id)+'&revision='+encodeURIComponent(m.revision!),{signal:this.abort.signal,timeoutMs:this.optionen.timeoutMs});
   if(!res.body)error('bytes_fehlen',502,'Download ohne Bytes.');
   for await(const chunk of res.body as unknown as AsyncIterable<Uint8Array>){
    size+=chunk.length;if(size>m.groesse)error('groesse_falsch',409,'Download überschreitet erwartete Größe.');
    hash.update(chunk);let at=0;while(at<chunk.length){const r=await fd.write(chunk,at,chunk.length-at);if(!r.bytesWritten)throw new Error('Download-Schreiben ohne Fortschritt.');at+=r.bytesWritten;}
    j.bytes_erledigt=size;this.geaendert();
   }
   if(size!==m.groesse||hash.digest('hex')!==m.sha256)error('hash_falsch',409,'Downloadintegrität verletzt.');
   await fd.sync();
  }finally{await fd.close();}
  let latest:typeof current;
  try{latest=await this.hash(j.pfad);}catch(e){if(!missing(e))throw e;}
  if((current?.signatur??null)!==(latest?.signatur??null))error('lokaler_konflikt',409,'Lokale Datei während Download geändert.');
  this.state.marker[j.pfad]={sha256:m.sha256!,revision:m.revision!,phase:'installieren'};await this.save();
  await this.local(j.pfad,true);
  if(latest){
   const retained=path.join(this.dir,'pc-before-install-'+j.id);
   try{await fs.link(target,retained);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   const saved=await fs.lstat(retained,{bigint:true});
   // A hardlink legitimately changes ctime; inode, size and mtime must still match.
   if(saved.isSymbolicLink()||signature(saved).split(':').slice(0,-1).join(':')!==latest.signatur.split(':').slice(0,-1).join(':'))
    error('lokaler_konflikt',409,'Lokale Datei am Installationsfence verändert; beide Fassungen erhalten.');
  }
  if(latest)await fs.rename(tmp,target);
  else{await fs.link(tmp,target);await fs.unlink(tmp);} // exclusive absent-target install never overwrites a concurrently created file
  const parent=await fs.open(path.dirname(target),'r');try{await parent.sync();}finally{await parent.close();}
  this.state.marker[j.pfad].phase='fertig';this.state.bekannt[j.pfad]=m;await this.save();
 }
 private async loeschen(j:Auftrag){
  if(this.optionen.richtung==='share_to_pc')return;
  try{await this.hash(j.pfad);j.art='upload';j.upload=undefined;j.sha256=undefined;j.id=randomUUID();await this.save();return this.upload(j);}
  catch(e){if(!missing(e))throw e;}
  const known=this.state.bekannt[j.pfad];if(!known?.revision||known.deleted_at)return;
  const result=await this.api.json<{asset:AssetSyncMeta}>(this.base+'/loeschen',{event_id:j.id,asset_id:known.asset_id,basis_revision:known.revision},'POST',this.abort.signal);
  this.state.bekannt[j.pfad]=result.asset;await this.save();
 }
 async abarbeiten():Promise<void>{
  await this.ready;if(this.lauf)return this.lauf;if(this.stopped||this.paused)return;
  this.lauf=this.durchlauf().finally(()=>{this.lauf=undefined;});return this.lauf;
 }
 private async durchlauf():Promise<void>{
  this.draining=true;
  try{await this.locked(async()=>{
   for(const job of [...this.state.auftraege]){
    if(this.stopped||this.paused||job.gesperrt||job.naechster>Date.now())continue;
    const release=await transferSlot(this.optionen.parallelTransfers??1,this.abort.signal);
    try{
     if(this.paused||this.stopped)continue;
     if(job.art==='upload')await this.upload(job);else if(job.art==='download')await this.download(job);else await this.loeschen(job);
     this.state.auftraege=this.state.auftraege.filter(j=>j!==job);await this.save();
    }catch(e){
     const err=e as Error;job.fehler=err.message;job.versuche++;
     job.gesperrt=e instanceof AssetApiFehler&&!e.wiederholbar&&!['finalisierung_laeuft','transfer_laeuft','revision_offen'].includes(e.code);
     job.naechster=Date.now()+Math.min(this.optionen.retryMs*Math.pow(2,Math.min(job.versuche-1,6)),this.optionen.retryMs*64);
     await this.save();
    }finally{release();}
   }
  });}finally{this.draining=false;}
 }
 pause(){this.paused=true;if(this.wake){clearInterval(this.wake);this.wake=undefined;}}
 start(){
  if(this.stopped)return;this.paused=false;if(this.wake)return;
  this.wake=setInterval(()=>{void this.abarbeiten().catch(e=>console.error('[asset-transfer] Zustand nicht verfügbar:',(e as Error).message));},this.optionen.retryMs);
  this.wake.unref();void this.abarbeiten().catch(e=>console.error('[asset-transfer] Start fehlgeschlagen:',(e as Error).message));
 }
 async stop(){this.stopped=true;if(this.wake)clearInterval(this.wake);this.abort.abort();await this.serial;}
}
