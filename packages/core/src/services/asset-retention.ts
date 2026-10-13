/** M4: persistente Tombstones bleiben; nur interne Bytes nach Frist und ohne Referenzen purgen.
 * PG-Fence wird VOR Byte-I/O committed. storage_status=purging ist eine idempotent wiederaufnehmbare Absicht.
 * A15 registriert Ansicht-Referenzen über halteAssetRetention; kein Tokenmaterial wird hier gespeichert.
 */
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import type {AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetSpeicher} from './asset-speicher.js';
import type {AssetAdresse} from './asset-speicher.js';
import type {AssetUploadDb} from './asset-upload.js';
import {starteApiAuftragsLoop} from './api-auftrags-loop.js';
type Row=Record<string,unknown>;
export class AssetRetention {
 private readonly db:AssetUploadDb;private readonly cfg:AssetKonfiguration;private readonly speicher:AssetSpeicher;
 constructor(o:{db?:AssetUploadDb;konfiguration?:AssetKonfiguration;speicher?:AssetSpeicher}={}){
  this.db=o.db??getPool() as unknown as AssetUploadDb;this.cfg=o.konfiguration??getAssetKonfiguration();this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
 }
 private async tx<T>(fn:(db:AssetUploadDb)=>Promise<T>){
  const db=await this.db.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}
  catch(e){await db.query('ROLLBACK');throw e;}finally{await db.release();}
 }
 /** A15/Stream-Adapter rufen dies vor Ausgabe auf; gleicher Asset-Row-Lock wie Purge. */
 async halten(e:{ref_key:string;asset_id:string;revision:string;art:'ansicht'|'transfer';expires_at:Date}):Promise<void>{
  if(!e.ref_key||e.ref_key.length>200||!['ansicht','transfer'].includes(e.art)||!e.expires_at||!Number.isFinite(e.expires_at.getTime())||!/^[1-9][0-9]*$/.test(e.asset_id)||!/^[1-9][0-9]*$/.test(e.revision))throw new TypeError('Ungültige Retentionreferenz');
  await this.tx(async db=>{
   const row=(await db.query("SELECT storage_status FROM asset_files WHERE id=$1 FOR UPDATE",[e.asset_id])).rows[0];
   if(!row||['purging','purged'].includes(String(row.storage_status)))throw new Error('Bytes werden bereits entfernt/sind abgelaufen');
   const revision=(await db.query('SELECT 1 FROM asset_revisionen WHERE asset_id=$1 AND revision=$2',[e.asset_id,e.revision])).rows[0];
   if(!revision)throw new Error('Bytesrevision fehlt');
   const prior=(await db.query('SELECT * FROM asset_retention_referenzen WHERE ref_key=$1',[e.ref_key])).rows[0];
   if(prior&&(String(prior.asset_id)!==e.asset_id||String(prior.revision)!==e.revision||prior.art!==e.art))throw new Error('Retentionreferenz gehört anderem Scope');
   await db.query('INSERT INTO asset_retention_referenzen(ref_key,asset_id,revision,art,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(ref_key) DO UPDATE SET expires_at=GREATEST(asset_retention_referenzen.expires_at,EXCLUDED.expires_at),released_at=NULL',[e.ref_key,e.asset_id,e.revision,e.art,e.expires_at]);
  });
 }
 async freigeben(ref_key:string){await this.db.query('UPDATE asset_retention_referenzen SET released_at=clock_timestamp() WHERE ref_key=$1',[ref_key]);}
 private async sperren(row:Row,db:AssetUploadDb){
  const r=await db.query(`SELECT
   EXISTS(SELECT 1 FROM asset_upload_sitzungen WHERE bereich='projekt' AND ziel_ref=$1 AND logischer_pfad=$2 AND status IN('offen','laeuft','vollstaendig')) OR
   EXISTS(SELECT 1 FROM asset_mutationen WHERE asset_id=$3 AND status IN('offen','prepared')) OR
   EXISTS(SELECT 1 FROM asset_konflikte WHERE asset_id=$3 AND status='offen') OR
   EXISTS(SELECT 1 FROM asset_revisionen WHERE asset_id=$3 AND restore_until>clock_timestamp()) OR
   EXISTS(SELECT 1 FROM asset_retention_referenzen WHERE asset_id=$3 AND released_at IS NULL AND expires_at>clock_timestamp())
   AS gesperrt`,[row.project,row.file_path,row.id]);
  return r.rows[0]?.gesperrt!==false;
 }
 async durchlauf():Promise<{entfernt:number}>{
  if(!this.cfg.aktiv)return {entfernt:0};
  const candidates=(await this.db.query("SELECT id FROM asset_files WHERE deleted_at IS NOT NULL AND restore_until<=clock_timestamp() AND storage_status IN('ready','purging') ORDER BY restore_until LIMIT $1",[this.cfg.speicher.maxObjekteJeDatei])).rows;
  let entfernt=0;
  for(const candidate of candidates){
   const claimed=await this.tx(async db=>{
    const row=(await db.query("SELECT *,restore_until<=clock_timestamp() AS abgelaufen FROM asset_files WHERE id=$1 FOR UPDATE",[candidate.id])).rows[0];
    if(!row?.deleted_at||!row.abgelaufen||!['ready','purging'].includes(String(row.storage_status))||row.prepared_upload_id||row.prepared_mutation_id||row.prepared_konflikt_id||await this.sperren(row,db))return null;
    const revisions=(await db.query('SELECT storage_key,sha256 FROM asset_revisionen WHERE asset_id=$1',[row.id])).rows;
    if(revisions.some(r=>!r.storage_key||!r.sha256))throw new Error('Unbekannte Revisionsbytes verhindern Purge');
    await db.query("UPDATE asset_files SET storage_status='purging' WHERE id=$1",[row.id]);
    return {row,revisions};
   });
   if(!claimed)continue;
   const {row,revisions}=claimed;
   if(row.storage_kind!=='assets'&&row.storage_kind!=='binaries')throw new Error('Purge ohne bekannte Speicherart');
   const adresse:AssetAdresse={bereich:'projekt',ziel_ref:String(row.project),storage_kind:row.storage_kind,logischer_pfad:String(row.file_path)};
   // Kein PG-/Projekt-Lock während Hash/Unlink; neue Retention hält am purging-Fence.
   const keys=new Map<string,string>();
   for(const r of revisions){const key=String(r.storage_key),hash=String(r.sha256);if(keys.has(key)&&keys.get(key)!==hash)throw new Error('Widersprüchliche Revisionshashes verhindern Purge');keys.set(key,hash);}
   if(row.storage_key)keys.set(String(row.storage_key),String(row.transport_sha256));
   for(const [key,hash] of keys)await this.speicher.entferneRevision(adresse,key,hash);
   await this.tx(async db=>{
    const fresh=(await db.query("SELECT * FROM asset_files WHERE id=$1 FOR UPDATE",[row.id])).rows[0];
    if(fresh?.storage_status!=='purging'||String(fresh.transport_revision)!==String(row.transport_revision)||await this.sperren(fresh,db))throw new Error('Purge-Fence änderte sich');
    await db.query("UPDATE asset_files SET storage_status='purged',updated_at=clock_timestamp() WHERE id=$1",[row.id]);
   });
   entfernt++;
  }
  return {entfernt};
 }
}
export function starteAssetRetention(kern=new AssetRetention()){
 return starteApiAuftragsLoop({intervallMs:getAssetKonfiguration().sync.scanIntervallMs,arbeit:async()=>{await kern.durchlauf();},fehler:e=>console.error('[asset-retention]',e)});
}
