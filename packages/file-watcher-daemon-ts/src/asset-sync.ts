/** A8: negotiate API ownership before local asset inspection; recover fullscan then commit-watermark deltas. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {assetArt,loadGitignore,shouldIgnore,parseApiContract} from '@synapse/core';
import type {FileEvent,AssetSyncRichtung} from '@synapse/core';
import type {DaemonConfig,ProjektConfig} from './config.js';
import {AssetApiTransport,AssetApiFehler} from './asset-api-transport.js';
import {AssetTransferQueue} from './asset-transfer-queue.js';
import {pruefeLokalesAsset} from './asset-erkennung.js';
import type {AssetTransferOptionen,AssetSyncMeta} from './asset-transfer-queue.js';

interface Policy {success:boolean;host:string;richtung:AssetSyncRichtung;chunkBytes:number;timeoutMs:number;retryMs:number;scanMs:number;maxDateiBytes:number;erlaubteTypen?:string[];parallelTransfers?:number;}
interface Page {eintraege:AssetSyncMeta[];cursor:string|null;aenderungs_cursor:string;stand:string;vollstaendig:boolean;}
interface Delta {eintraege:Array<{metadaten:AssetSyncMeta}>;cursor:string;stand:string;vollstaendig:boolean;fullscan_erforderlich?:boolean;}
interface Bindung {p:ProjektConfig;mode:'offen'|'legacy'|'api';ready:Promise<void>;queue?:AssetTransferQueue;timer?:NodeJS.Timeout;busy:boolean;next:number;negotiated?:boolean;lauf?:Promise<void>;stopped?:boolean;abort:AbortController;}
export class DaemonAssetSync {
 private readonly bindings=new Map<string,Bindung>();private stopped=false;
 constructor(private readonly config:()=>DaemonConfig,readonly api=new AssetApiTransport(),
  private readonly onStatus:()=>void=()=>{},private readonly verwaltet:(p:ProjektConfig)=>void=()=>{}){}
 starte(p:ProjektConfig):void{
  if(this.stopped||this.bindings.has(p.name))return;
  const b:Bindung={p,mode:p.asset_sync?.verwaltet?'api':'offen',ready:Promise.resolve(),busy:false,next:0,abort:new AbortController()};
  this.bindings.set(p.name,b);
  b.busy=true;
  b.ready=(async()=>{
   if(p.asset_sync?.verwaltet&&p.asset_sync.host&&p.asset_sync.optionen){
    b.queue=new AssetTransferQueue({bereich:'projekt',ziel_ref:p.name,host:p.asset_sync.host,root:p.pfad},p.asset_sync.optionen,this.api,this.onStatus);
    await b.queue.status(); // journal usable offline; processing still waits for fresh API authorization
   }
   await this.verhandle(b);
  })().catch(e=>{b.negotiated=false;b.queue?.pause();console.error('[asset-sync] Verhandlung '+p.name+': '+(e as Error).message);}).finally(()=>{b.busy=false;});
  // Retry negotiation offline and periodically recover changes even without watcher events.
  const period=this.config().asset_sync?.retry_ms??5_000;
  b.timer=setInterval(()=>{void this.tick(b).catch(e=>console.error('[asset-sync] '+p.name+': '+(e as Error).message));},period);b.timer.unref();
 }
 private async verhandle(b:Bindung){
  b.negotiated=false;b.queue?.pause();
  // User-Vorgabe 14.10.2026: Sync nur fuer Projekte mit asset_sync.aktiv:true (Standard aus).
  const projektAktiv=b.p.asset_sync?.aktiv===true;
  if(this.stopped||b.stopped||!b.p.enabled||this.config().asset_sync?.aktiv===false||!projektAktiv){b.mode=projektAktiv&&b.p.asset_sync?.verwaltet?'api':'legacy';return;}
  const response=await this.api.json<{projects:string[];activeWatchers:string[];capabilities?:unknown}>('/api/projects',undefined,'GET',b.abort.signal);
  const contract=parseApiContract(response.capabilities,new Set(['asset_sync']));
  if(!contract?.features.includes('asset_sync')){if(!b.p.asset_sync?.verwaltet)b.mode='legacy';return;}
  if(!response.projects.includes(b.p.name)||!response.activeWatchers.includes(b.p.name))throw new AssetApiFehler(403,'projekt_verboten','Hostprojekt nicht freigegeben.');
  const base='/api/projects/'+encodeURIComponent(b.p.name)+'/assets';
  const policy=await this.api.json<Policy>(base+'/sync-optionen',undefined,'GET',b.abort.signal);
  for(const key of ['chunkBytes','timeoutMs','retryMs','scanMs','maxDateiBytes'] as const){
   if(!Number.isSafeInteger(policy[key])||policy[key]<=0)throw new Error('Ungültige API-Transfergrenze '+key);
  }
  if(!policy.host||!['both','pc_to_share','share_to_pc'].includes(policy.richtung))throw new Error('Ungültige API-Host/Richtungsbindung.');
  const local=b.p.asset_sync?.richtung??this.config().asset_sync?.richtung??'both';
  if(local!=='both'&&policy.richtung!=='both'&&local!==policy.richtung)throw new AssetApiFehler(403,'richtung_verboten','Richtungsfreigaben schneiden sich nicht.');
  const o:AssetTransferOptionen={richtung:local==='both'?policy.richtung:local,chunkBytes:Math.min(policy.chunkBytes,this.config().asset_sync?.chunk_bytes??policy.chunkBytes),
   retryMs:Math.max(policy.retryMs,this.config().asset_sync?.retry_ms??policy.retryMs),timeoutMs:policy.timeoutMs,maxDateiBytes:policy.maxDateiBytes,erlaubteTypen:policy.erlaubteTypen,parallelTransfers:policy.parallelTransfers};
  // A12's persisted owner fence must be set before even the first queue operation.
  await this.api.json(base+'/inspektionsmodus',{modus:'asset_sync'},'POST',b.abort.signal);
  if(b.queue&&b.queue.scope.host!==policy.host){await b.queue.stop();b.queue=undefined;}
  if(!b.queue){
   b.queue=new AssetTransferQueue({bereich:'projekt',ziel_ref:b.p.name,host:policy.host,root:b.p.pfad},o,this.api,this.onStatus);
   await b.queue.status();
  }else if(b.queue.setzeOptionen(o))await b.queue.fullscan();
  b.mode='api';b.negotiated=true;b.p.asset_sync={...b.p.asset_sync,verwaltet:true,host:policy.host,optionen:o};this.verwaltet(b.p);
  b.queue.start();
  b.next=Date.now()+policy.scanMs;
  await this.abgleich(b);
 }
 async ereignis(event:FileEvent):Promise<boolean>{
  const b=this.bindings.get(event.project);if(!b)return false;
  await b.ready;if(b.mode==='legacy')return false;
  if(b.queue){
   let rel=event.path;if(path.isAbsolute(rel))rel=path.relative(b.p.pfad,rel);
   await b.queue.ereignis(rel,event.type);if(b.negotiated)void b.queue.abarbeiten().catch(e=>console.error('[asset-sync] Queue:',(e as Error).message));
  }
  // Pending/offline capability negotiation holds events; fullscan later discovers existing assets.
  return true;
 }
 async bereit(name:string):Promise<boolean>{
  const b=this.bindings.get(name);if(!b)return false;await b.ready;
  if(b.mode==='legacy')return false;
  if(b.queue&&b.negotiated)await this.abgleich(b);return true;
 }
 private async tick(b:Bindung){
  if(this.stopped||b.stopped||b.busy||!b.p.enabled)return;
  b.busy=true;
  try{if(!b.negotiated||Date.now()>=b.next)await this.verhandle(b);}
  catch(e){b.negotiated=false;b.queue?.pause();throw e;}
  finally{b.busy=false;}
 }
 private async lokaleAssets(b:Bindung){
  const ig=loadGitignore(b.p.pfad);
  const walk=async(rel:string)=>{
   const entries=await fs.readdir(path.join(b.p.pfad,rel),{withFileTypes:true});
   for(const entry of entries){
    const p=rel?rel+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink()||shouldIgnore(ig,p))continue;
    if(entry.isDirectory())await walk(p);
    else if(entry.isFile()){
     const detected=await b.queue!.kandidat(p);
     if(detected)await b.queue!.ereignis(p,'change');
    }
   }
  };
  await walk('');
 }
 private async abgleich(b:Bindung){
  if(b.lauf)return b.lauf;
  b.lauf=this.abgleichEinmal(b).finally(()=>{b.lauf=undefined;});return b.lauf;
 }
 private async abgleichEinmal(b:Bindung):Promise<void>{
  const q=b.queue!;if(!q)return;
  await this.lokaleAssets(b); // enqueue PC sources before Share reconcile, including initial conflicts
  const base=q.base,state=await q.status();let checkpoint:string,stand:string;
  if(!state.cursor){
   let cursor:string|undefined;let delta:string|undefined;let lastStand:string|undefined;
   do{
    const page=await this.api.json<Page>(base+'/manifest'+(cursor?'?cursor='+encodeURIComponent(cursor):''),undefined,'GET',b.abort.signal);
    if(!Array.isArray(page.eintraege)||typeof page.stand!=='string'||typeof page.aenderungs_cursor!=='string')throw new Error('Ungültiges Manifest.');
    if(lastStand!==undefined&&lastStand!==page.stand)throw new Error('Manifeststand wechselte zwischen Seiten.');
    lastStand=page.stand;delta=page.aenderungs_cursor;
    for(const meta of page.eintraege)await q.herunterladen(meta);
    cursor=page.cursor??undefined;
    if(!cursor&&!page.vollstaendig)throw new Error('Unvollständiges Manifest ohne Fortsetzung.');
   }while(cursor);
   await q.abarbeiten();checkpoint=delta!;stand=lastStand!;
  }else{
   let cursor=state.cursor,more:boolean;
   do{
    const page=await this.api.json<Delta>(base+'/aenderungen?cursor='+encodeURIComponent(cursor),undefined,'GET',b.abort.signal);
    if(page.fullscan_erforderlich){await q.fullscan();return this.abgleichEinmal(b);}
    if(!Array.isArray(page.eintraege)||typeof page.cursor!=='string'||typeof page.stand!=='string')throw new Error('Ungültige Änderungsliste.');
    for(const item of page.eintraege)await q.herunterladen(item.metadaten);
    await q.abarbeiten();await q.checkpoint(page.cursor,page.stand);
    cursor=page.cursor;more=!page.vollstaendig;stand=page.stand;
   }while(more);
   checkpoint=cursor;stand=stand!;
  }
  await q.checkpoint(checkpoint,stand);
  await this.lokaleAssets(b);await q.abarbeiten();
 }
 async status(name:string){const b=this.bindings.get(name);return b?{modus:b.mode,...(b.queue?await b.queue.status():{})}:undefined;}
 async stop(name:string){
  const b=this.bindings.get(name);if(!b)return;
  b.stopped=true;b.abort.abort();b.negotiated=false;b.queue?.pause();
  if(b.timer)clearInterval(b.timer);await b.ready;await b.queue?.stop();await b.lauf;this.bindings.delete(name);
 }
 async stopAll(){this.stopped=true;await Promise.all([...this.bindings.keys()].map(n=>this.stop(n)));}
}
