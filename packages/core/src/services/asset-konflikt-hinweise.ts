/** A11 registers in the existing RV19 source registry only when Assetbetrieb is enabled. */
import {getPool} from '../db/client.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {registriereHinweisQuelle} from './ausloeser-hinweise.js';
import type {HinweisQuelle} from './ausloeser-hinweise.js';
import type {AssetUploadDb} from './asset-upload.js';
export function assetKonfliktHinweisQuelle(db:Pick<AssetUploadDb,'query'>=getPool() as unknown as AssetUploadDb):HinweisQuelle{
 return {quelle_id:'asset_konflikt',async pruefe(c){
  if(!c.projekt||c.signal.aborted)return [];
  const paths=c.pfade.map(p=>p.replaceAll('\\','/').replace(/^\.\//,'')).filter(p=>p&&!p.startsWith('/')&&!/^[A-Za-z]:\//.test(p));
  // Numeric plan/task IDs are unrelated to assets. Only explicit asset fields narrow the query.
  const ids=[c.argumente.asset_id,c.felder.asset_id].filter(x=>typeof x==='string'||typeof x==='number').map(String).filter(x=>/^[1-9][0-9]*$/.test(x));
  const directories=typeof c.argumente.path==='string'&&paths.includes(c.argumente.path)?[c.argumente.path.replace(/\/$/,'')]:[];
  const r=await db.query(`SELECT k.id,k.asset_id,k.pc_revision,a.file_path,share.sha256 AS share_hash,share.groesse AS share_size,
   share.created_at AS share_time,pc.sha256 AS pc_hash,pc.groesse AS pc_size,pc.created_at AS pc_time
   FROM asset_konflikte k JOIN asset_files a ON a.id=k.asset_id
   JOIN asset_revisionen share ON share.asset_id=k.asset_id AND share.revision=k.share_revision
   JOIN asset_revisionen pc ON pc.asset_id=k.asset_id AND pc.revision=k.pc_revision
   WHERE a.project=$1 AND k.status='offen' AND (cardinality($2::text[])=0 AND cardinality($3::bigint[])=0
    OR a.file_path=ANY($2::text[]) OR a.id=ANY($3::bigint[])
    OR EXISTS(SELECT 1 FROM unnest($4::text[]) d WHERE left(a.file_path,length(d)+1)=d||'/'))
   ORDER BY k.id LIMIT 2`,[c.projekt,paths,ids,directories]);
  if(c.signal.aborted)return [];
  const stamp=(v:unknown)=>(v instanceof Date?v.toISOString():String(v)).slice(0,16);
  return r.rows.map(x=>{
   const args={project:c.projekt,asset_id:String(x.asset_id),wahl:'pc'};
   const call='asset_intel({action:"konflikt_loesen",project:'+JSON.stringify(c.projekt)+',asset_id:'+JSON.stringify(String(x.asset_id))+',wahl:"pc"})';
   const file=String(x.file_path);
   const shortFile=file.length>24?'…'+file.slice(-23):file;
   return {hinweis_id:String(x.id)+':'+String(x.pc_revision),modus:'bis_erledigt' as const,spezifitaet:paths.length?100:50,
    // RV19 bounds text to 240 chars: keep the complete executable call ahead of metadata.
    text:call+'; User fragen: PC? '+shortFile+' Share '+stamp(x.share_time).slice(5)+'/'+String(x.share_size)+'B/'+String(x.share_hash).slice(0,6)+
     ' PC '+stamp(x.pc_time).slice(5)+'/'+String(x.pc_size)+'B/'+String(x.pc_hash).slice(0,6),
    kurztext:call+'; User fragen: PC übernehmen? Konflikt offen, PC gesichert. '+String(x.file_path),
    folgeaktion:{tool:'asset_intel',aktion:'konflikt_loesen',argumente:args}};
  });
 }};
}
let registered=false;
export function initialisiereAssetKonfliktHinweise():void{
 if(registered||!getAssetKonfiguration().aktiv)return;
 registriereHinweisQuelle(assetKonfliktHinweisQuelle());registered=true;
}
