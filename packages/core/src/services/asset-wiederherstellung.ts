/** M4 serverseitige Tool-Aktionen: vorhandener A7-Mutationskern, kein lokaler Byteweg. */
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {AssetManifestKern} from './asset-manifest.js';
import {AssetUploadFehler} from './asset-upload.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {isProjectEnabled} from './project-registry.js';
export async function fuehreAssetWiederherstellungAus(action:'geloescht'|'wiederherstellen',project:string,a:Record<string,unknown>):Promise<Record<string,unknown>>{
 const cfg=getAssetKonfiguration();
 if(!cfg.aktiv)throw new AssetUploadFehler('deaktiviert',503,'Assetbetrieb deaktiviert.');
 if(!await isProjectEnabled(project))throw new AssetUploadFehler('projekt_verboten',403,'Projekt fehlt oder ist nicht freigegeben.');
 const db=getPool();
 if(action==='geloescht'){
  const limit=a.limit===undefined?cfg.speicher.maxObjekteJeDatei:Number(a.limit),offset=a.offset===undefined?0:Number(a.offset);
  if(!Number.isSafeInteger(limit)||limit<1||limit>cfg.speicher.maxObjekteJeDatei||!Number.isSafeInteger(offset)||offset<0)throw new AssetUploadFehler('eingang_ungueltig',400,'Ungültiges Paging.');
  const filter=a.file_path===undefined?null:normalisiereSpeicherPfad(String(a.file_path));
  const r=await db.query("SELECT id::text AS asset_id,file_path AS pfad,transport_revision::text AS revision,transport_sha256 AS sha256,file_size AS groesse,deleted_at,restore_until,storage_status,restore_until>clock_timestamp() AND storage_status='ready' AS wiederherstellbar,count(*) OVER()::int AS total FROM asset_files WHERE project=$1 AND deleted_at IS NOT NULL AND ($2::text IS NULL OR file_path=$2) ORDER BY id LIMIT $3 OFFSET $4",[project,filter,limit,offset]);
  const total=Number(r.rows[0]?.total??0),dateien=r.rows.map(({total:_,...row})=>row);
  return {dateien,total,gekappt:offset+dateien.length<total};
 }
 if(typeof a.agent_id!=='string'||!a.agent_id||a.agent_id.length>190||typeof a.basis_revision!=='string'||typeof a.event_id!=='string')throw new AssetUploadFehler('eingang_ungueltig',400,'Agent-ID, Event-ID und bekannte Basisrevision erforderlich.');
 const kern=new AssetManifestKern({quelle:'share'}),ctx={bereich:'projekt' as const,ziel_ref:project,host_id:'mcp:'+a.agent_id};
 const id=typeof a.asset_id==='string'?a.asset_id:await kern.assetNachPfad(ctx,String(a.file_path??''),a.event_id);
 return {asset:await kern.mutieren(ctx,'wiederherstellen',{event_id:a.event_id,asset_id:id,basis_revision:a.basis_revision})};
}
