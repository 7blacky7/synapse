/** RV16: Reverse-Quellen für A14; Bytes ausschließlich über den RV4-Speicheradapter. */
import {getPool} from '../db/client.js';
import type {AssetUploadDb} from './asset-upload.js';
import {AssetSpeicher,normalisiereSpeicherPfad,type AssetAdresse} from './asset-speicher.js';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import type {AssetAnsichtQuellenAdapter,AssetAnsichtReferenz} from './asset-ansicht.js';
import {AssetAnsichtFehler} from './asset-ansicht-renderer.js';
import {ReverseAnsichtRetention} from './reverse-ansicht-retention.js';
import {reverseDateiSpeicherAdresse} from './reverse-eingang.js';

export interface ReverseAnsichtDatei {id:string;pfad:string;sha256:string;groesse:string;format:string|null;mime:string|null;storage_key:string;arch?:string;bits?:number;}
/** Exakter Pfad: Originaldatei hat Vorrang; abgeleitete Assets dürfen keine mehrdeutige Auswahl erzeugen. */
export async function holeReverseAnsichtDatei(db:Pick<AssetUploadDb,'query'>,rid:string,pfad:string):Promise<ReverseAnsichtDatei|null>{
  const d=(await db.query("SELECT 'datei:'||id::text AS id,pfad,sha256,groesse::text,format,metadaten->>'mime_type' AS mime,storage_key,arch,bits FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=$2",[rid,pfad])).rows[0];
  if(d)return d as unknown as ReverseAnsichtDatei;
  const assets=(await db.query("SELECT 'asset:'||id::text AS id,pfad,sha256,groesse::text,format,mime,storage_key FROM reverse_assets WHERE eintrag_id=$1 AND pfad=$2 ORDER BY id LIMIT 2",[rid,pfad])).rows;
  if(assets.length>1)throw new AssetAnsichtFehler('ansicht_quelle_mehrdeutig','Mehrere Reverse-Assets unter diesem Pfad.');
  return (assets[0] as unknown as ReverseAnsichtDatei)??null;
}
export function reverseAnsichtAdapter(o:{db?:AssetUploadDb;konfiguration?:AssetKonfiguration;retention?:ReverseAnsichtRetention}={}):AssetAnsichtQuellenAdapter{
  return {async aufloesen(ref:Readonly<AssetAnsichtReferenz>){
    const match=/^(datei|asset):([1-9][0-9]*)$/.exec(ref.id);
    if(ref.bereich!=='reverse'||!match)throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Ungültige Reverse-Quelle.');
    const db=o.db??getPool() as unknown as AssetUploadDb;
    const cfg=o.konfiguration??getAssetKonfiguration();
    const row=(await db.query(match[1]==='datei'
      ? "SELECT id::text,pfad,sha256,groesse::text,format,metadaten->>'mime_type' AS mime,storage_key FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2"
      : "SELECT id::text,pfad,sha256,groesse::text,format,mime,storage_key FROM reverse_assets WHERE eintrag_id=$1 AND id=$2",
      [ref.ziel_ref,match[2]])).rows[0];
    if(!row?.storage_key||!row.sha256)throw new AssetAnsichtFehler('ansicht_quelle_fehlt','Keine bestätigte Reverse-Bytesreferenz.');
    const sha=String(row.sha256);
    if(!/^[a-f0-9]{64}$/.test(sha)||(ref.revision!==undefined&&ref.revision!==sha)||(ref.sha256!==undefined&&ref.sha256!==sha))throw new AssetAnsichtFehler('ansicht_revision_falsch','Reverse-Revision entspricht nicht dem gebundenen Hash.');
    const key=normalisiereSpeicherPfad(String(row.storage_key));
    let adresse:AssetAdresse;
    if(match[1]==='datei'){
      const original=await reverseDateiSpeicherAdresse(db,ref.ziel_ref,match[2]);
      adresse=original.adresse;
      if(original.sha256!==sha||original.storage_key!==key)throw new AssetAnsichtFehler('ansicht_revision_falsch','Speicherreferenz hat sich geändert.');
    }else{
      adresse={bereich:'reverse',ziel_ref:ref.ziel_ref,storage_kind:'assets',logischer_pfad:String(row.pfad)};
    }
    // PG-abgeleitetes RV4-Layout: deduplizierte Originale bleiben bei ihrem kanonischen Bytesziel.
    // Der Cache-Scope unten bleibt der autorisierte Eintrag (A14 verlangt ziel_ref===ref.ziel_ref).
    if(!key.startsWith(adresse.ziel_ref+'/')||key.split('/')[1]==='.intern')throw new AssetAnsichtFehler('ansicht_revision_falsch','Bytesziel gehört nicht zur Reverse-Quelle.');
    const bytes=new AssetSpeicher({konfiguration:cfg,layout:()=>key});
    const format=String(row.format&&row.format!=='unbekannt'?row.format:String(row.pfad).split('.').pop()??'').toLowerCase();
    const mime=String(row.mime??(['wav','mp3','ogg','flac','aac'].includes(format)?'audio/'+format:'application/octet-stream'));
    const halten=(o.retention??new ReverseAnsichtRetention({db})).halter(ref.ziel_ref,sha);
    return {bereich:'reverse',id:ref.id,revision:sha,sha256:sha,groesse:Number(row.groesse),format,mimeType:mime,
      adresse:{bereich:'reverse',ziel_ref:ref.ziel_ref,storage_kind:'assets',logischer_pfad:String(row.pfad)},
      ...halten,
      lesen:async signal=>{
        if(signal.aborted)throw new AssetAnsichtFehler('ansicht_limit','Lesen abgebrochen.');
        const stream=await bytes.readStorageStream(adresse,key);
        const abort=()=>stream.destroy(new AssetAnsichtFehler('ansicht_limit','Lesen abgebrochen.'));
        signal.addEventListener('abort',abort,{once:true});stream.once('close',()=>signal.removeEventListener('abort',abort));
        if(signal.aborted)abort();return stream;
      }};
  }};
}
