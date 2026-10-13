/** A11 registers in the existing RV19 source registry only when Assetbetrieb is enabled. */
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {registriereHinweisQuelle} from './ausloeser-hinweise.js';
import type {HinweisQuelle} from './ausloeser-hinweise.js';
import type {AssetUploadDb} from './asset-upload.js';
export function assetKonfliktHinweisQuelle(db:Pick<AssetUploadDb,'query'>=getPool() as unknown as AssetUploadDb):HinweisQuelle{
 return {quelle_id:'asset_konflikt',async pruefe(c){
  if(!c.projekt||c.signal.aborted)return [];
  const paths=c.pfade.map(p=>p.replaceAll('\\','/').replace(/^\.\//,''));
  const ids=c.ids.filter(x=>/^[1-9][0-9]*$/.test(x));
  const r=await db.query(`SELECT k.id,k.asset_id,k.pc_revision,a.file_path,share.sha256 AS share_hash,share.groesse AS share_size,
   share.created_at AS share_time,pc.sha256 AS pc_hash,pc.groesse AS pc_size,pc.created_at AS pc_time
   FROM asset_konflikte k JOIN asset_files a ON a.id=k.asset_id
   JOIN asset_revisionen share ON share.asset_id=k.asset_id AND share.revision=k.share_revision
   JOIN asset_revisionen pc ON pc.asset_id=k.asset_id AND pc.revision=k.pc_revision
   WHERE a.project=$1 AND k.status='offen' AND (cardinality($2::text[])=0 AND cardinality($3::bigint[])=0
    OR a.file_path=ANY($2::text[]) OR a.id=ANY($3::bigint[]))
   ORDER BY k.id LIMIT 2`,[c.projekt,paths,ids]);
  if(c.signal.aborted)return [];
  const stamp=(v:unknown)=>v instanceof Date?v.toISOString():String(v);
  return r.rows.map(x=>{
   const args={project:c.projekt,asset_id:String(x.asset_id),wahl:'pc'};
   const call='asset_intel(action:"konflikt_loesen", project:'+JSON.stringify(c.projekt)+', asset_id:'+JSON.stringify(String(x.asset_id))+', wahl:"pc")';
   return {hinweis_id:String(x.id)+':'+String(x.pc_revision),modus:'bis_erledigt' as const,spezifitaet:paths.length?100:50,
    text:String(x.file_path)+' Konflikt: Share '+stamp(x.share_time)+'/'+String(x.share_size)+'B/'+String(x.share_hash).slice(0,8)+
     ', PC '+stamp(x.pc_time)+'/'+String(x.pc_size)+'B/'+String(x.pc_hash).slice(0,8)+'. User fragen, ob PC gelten soll. '+call,
    kurztext:String(x.file_path)+' Konflikt offen; PC-Fassung gesichert. User fragen: '+call,
    folgeaktion:{tool:'asset_intel',aktion:'konflikt_loesen',argumente:args}};
  });
 }};
}
let registered=false;
export function initialisiereAssetKonfliktHinweise():void{
 if(registered||!getAssetKonfiguration().aktiv)return;
 registriereHinweisQuelle(assetKonfliktHinweisQuelle());registered=true;
}
