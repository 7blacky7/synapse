/** A13 Projektadapter: direkte Sharedatei -> derselbe A6-Upload/Publishkern, quelle share. */
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {standardRegistry} from '../asset-intel/registry.js';
import {istGesperrt,aktualisiereIgnoreRegeln} from '../watcher/ignore.js';
import {AssetUploadKern} from './asset-upload.js';
import {ShareScanner,shareScanner} from './share-scanner.js';
import type {ShareScanDatei} from './share-scanner.js';
import type {AssetUploadDb} from './asset-upload.js';
export function registriereProjektShareScanner(o:{scanner?:ShareScanner;db?:AssetUploadDb;konfiguration?:AssetKonfiguration}={}):()=>void{
 const cfg=o.konfiguration??getAssetKonfiguration(),db=o.db??getPool() as unknown as AssetUploadDb;
 const upload=new AssetUploadKern({db,konfiguration:cfg,quelle:'share'});
 const scanner=o.scanner??shareScanner;
 return scanner.registrieren('projekt',{
  wurzeln:async()=>{
   if(!cfg.aktiv||!cfg.speicher.root)return [];
   const rows=(await db.query('SELECT name FROM projects GROUP BY name HAVING bool_or(enabled)')).rows;
   const roots=[];
   for(const row of rows){
    const project=String(row.name);
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(project))continue;
    await aktualisiereIgnoreRegeln(project);
    for(const kind of ['assets','binaries'] as const)roots.push({id:project+'/'+kind,pfad:path.join(cfg.speicher.root,project,kind==='assets'?cfg.speicher.assetsUnterordner:cfg.speicher.binariesUnterordner)});
   }
   return roots;
  },
  datei:async(e:ShareScanDatei)=>{
   const [project,kind]=e.wurzel.id.split('/');
   if(kind!=='assets'&&kind!=='binaries')throw new Error('Ungültige Projekt-Scanneridentität');
   if(istGesperrt(e.pfad,e.wurzel.pfad,project))return false;
   const old=(await db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2',[project,e.pfad])).rows[0];
   if(old?.deleted_at||old?.prepared_upload_id||old?.prepared_mutation_id)return false;
   if(old?.transport_sha256===e.sha256&&old.storage_status==='ready')return true;
   const detected=standardRegistry.detect(e.pfad,e.kopf);
   if(!detected.format)return false;
   const basis=String(old?.transport_revision??'0'),ctx={bereich:'projekt' as const,ziel_ref:project,host_id:'share-scanner'};
   const idempotency='share:'+createHash('sha256').update(JSON.stringify([project,e.pfad,basis,e.sha256])).digest('hex');
   let session=await upload.erstellen(ctx,{logischer_pfad:e.pfad,storage_kind:kind,groesse:e.groesse,sha256:e.sha256,
    basis_revision:basis,idempotency_key:idempotency,format:detected.format});
   if(session.status==='finalisiert')return true;
   const stream=await e.oeffne();let offset=0;
   try{
    for await(const raw of stream){
     const bytes=Buffer.from(raw);
     for(let start=0;start<bytes.length;start+=cfg.speicher.chunkBytes){
      const chunk=bytes.subarray(start,start+cfg.speicher.chunkBytes),end=offset+chunk.length;
      if(end>session.offset) {
       if(offset<session.offset)throw new Error('Bestätigter Share-Offset liegt mitten im Quellchunk');
       session=await upload.teil(ctx,session.id,offset,chunk.length,[chunk]);
      }
      offset=end;
     }
    }
    if(offset!==e.groesse)throw new Error('Sharequelle während Transfer verändert');
   }finally{stream.destroy();}
   await upload.finalisieren(ctx,session.id);return true;
  }
 });
}
