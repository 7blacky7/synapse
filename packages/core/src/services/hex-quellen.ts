/** P21: API-only, autorisierte unveraenderliche Bytequellen fuer alle Hex-Aktionen. */
import {randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {aktuellerAgentAufruf,agentSchluessel} from './agent-bezug.js';
import {aktuelleUserHerkunft} from './user-herkunft.js';
import {isProjectEnabled} from './project-registry.js';
import {AssetSpeicher,normalisiereSpeicherPfad,type AssetAdresse} from './asset-speicher.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {AssetRetention} from './asset-retention.js';
import {ReverseAnsichtRetention,pruefeReverseAnsichtBindung} from './reverse-ansicht-retention.js';
import {reverseDateiSpeicherAdresse} from './reverse-eingang.js';
import type {HexStand} from './hex-einstellungen.js';
import {oeffneHexAnalyse,type HexAnalyseMetadaten} from './hex-analysen.js';

export class HexFehler extends Error {
 constructor(public readonly code:string,public readonly details:Record<string,unknown>={}){super(code);}
}
export type HexQuellenArt='projekt_asset'|'projekt_text'|'reverse_datei'|'reverse_asset'|'analyse';
export interface HexRef {
 art:HexQuellenArt;id?:string;file_path?:string;reverse_id?:string;revision?:string;version_id?:string;sha256?:string;
}
export interface HexQuelle {
 ref:HexRef;file_path:string;revision:string;sha256:string;groesse:number;bytebasis:'asset_revision'|'pg_text_utf8'|'reverse_bytes'|'analyse_bytes';analyse?:HexAnalyseMetadaten;
 lesen:(offset:number,laenge:number,signal?:AbortSignal)=>Promise<Buffer>;
 pruefen:()=>Promise<void>;
 halten:(id:string,bis:Date)=>Promise<void>;
 freigeben:(id:string)=>Promise<void>;
}
export function hexGanzzahl(v:unknown,name:string,standard?:number):number{
 if(v===undefined&&standard!==undefined)return standard;
 if(typeof v==='number'){if(Number.isSafeInteger(v)&&v>=0)return v;}
 else if(typeof v==='string'&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(v)){
  const n=BigInt(v);if(n<=BigInt(Number.MAX_SAFE_INTEGER))return Number(n);
 }
 throw new HexFehler('offset_ungueltig',{parameter:name});
}
export function hexAkteur(project:string):string{
 const k=aktuellerAgentAufruf(),p=k?.principal;
 if(p&&p.project===project)return agentSchluessel(p);
 if(aktuelleUserHerkunft())return 'user';
 throw new HexFehler('keine_berechtigung');
}
export async function pruefeHexZugang(project:string):Promise<void>{
 hexAkteur(project);
 if(!(await getPool().query('SELECT 1 FROM projects WHERE name=$1',[project])).rows[0])throw new HexFehler('projekt_unbekannt');
 if(!await isProjectEnabled(project))throw new HexFehler('projekt_deaktiviert');
}
const SHA=/^[a-f0-9]{64}$/;
const ID=/^[1-9][0-9]*$/;
export function pruefeHexRef(v:unknown):HexRef{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new HexFehler('quelle_fehlt');
 const a=v as Record<string,unknown>,erlaubt=['art','id','file_path','reverse_id','revision','version_id','sha256'];
 if(Object.keys(a).some(k=>!erlaubt.includes(k)))throw new HexFehler('quelle_ungueltig');
 if(!['projekt_asset','projekt_text','reverse_datei','reverse_asset','analyse'].includes(String(a.art)))throw new HexFehler('quelle_ungueltig');
 for(const k of erlaubt.filter(k=>k!=='art'))if(a[k]!==undefined&&(typeof a[k]!=='string'||!a[k]||String(a[k]).length>4096))throw new HexFehler('quelle_ungueltig',{parameter:k});
 if(a.file_path!==undefined){
  try{const p=normalisiereSpeicherPfad(a.file_path as string);if(p!==a.file_path)throw Error();}catch{throw new HexFehler('pfad_ungueltig');}
 }
 if(a.sha256!==undefined&&!SHA.test(String(a.sha256)))throw new HexFehler('quelle_ungueltig',{parameter:'sha256'});
 for(const k of ['id','version_id'])if(a[k]!==undefined&&ID.test(String(a[k]))&&BigInt(String(a[k]))>9223372036854775807n)throw new HexFehler('quelle_ungueltig',{parameter:k});
 const art=a.art as HexQuellenArt;
 if(art==='analyse'){
  if(typeof a.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.id)||['file_path','reverse_id','version_id'].some(k=>a[k]!==undefined)||(a.revision!==undefined&&!SHA.test(String(a.revision))))throw new HexFehler('quelle_ungueltig');
  return {...a} as unknown as HexRef;
 }
 if(art.startsWith('reverse_')){
  if(typeof a.reverse_id!=='string'||!/^rev-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{6}$/.test(a.reverse_id)||a.version_id!==undefined)throw new HexFehler('quelle_ungueltig');
 }else if(a.reverse_id!==undefined)throw new HexFehler('quelle_ungueltig');
 if(art!=='projekt_asset'&&a.revision!==undefined&&!SHA.test(String(a.revision)))throw new HexFehler('quelle_ungueltig',{parameter:'revision'});
 if(art==='projekt_text'){
  if(!a.file_path||a.id!==undefined||(a.version_id!==undefined&&!ID.test(String(a.version_id))))throw new HexFehler('quelle_ungueltig');
 }else{
  if((!a.id&&!a.file_path)||a.version_id!==undefined||(a.id!==undefined&&!ID.test(String(a.id))))throw new HexFehler('quelle_ungueltig');
  if(art==='projekt_asset'&&a.revision!==undefined&&!ID.test(String(a.revision)))throw new HexFehler('quelle_ungueltig');
 }
 return {...a} as unknown as HexRef;
}
function checkRange(size:number,offset:number,len:number):void{
 if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(len)||offset<0||len<0||offset>size||len>size-offset)throw new HexFehler('bereich_ausserhalb',{groesse:size});
}
/** Alle physischen Speicherkeys kommen ausschliesslich aus PG. Keine oeffentlichen Root-/Key-Parameter. */
export async function oeffneHexQuelle(project:string,raw:unknown):Promise<HexQuelle>{
 await pruefeHexZugang(project);
 const ref=pruefeHexRef(raw),db=getPool();
 if(ref.art==='analyse')return oeffneHexAnalyse(project,ref);
 let q:HexQuelle;
 if(ref.art==='projekt_text'){
  const hist=ref.version_id!==undefined;
  const where=hist?'project=$1 AND file_path=$2 AND id=$3::bigint':'project=$1 AND file_path=$2 AND deleted_at IS NULL';
  const table=hist?'file_versions':'code_files';
  const vals:unknown[]=hist?[project,ref.file_path,ref.version_id]:[project,ref.file_path];
  const r=await db.query("SELECT octet_length(content)::text AS groesse,encode(digest(convert_to(content,'UTF8'),'sha256'),'hex') AS sha256 FROM "+table+" WHERE "+where+" AND content IS NOT NULL",vals);
  const row=r.rows[0];if(!row)throw new HexFehler('quelle_nicht_gefunden');
  const sha=String(row.sha256),size=Number(row.groesse);
  q={ref:{...ref,sha256:sha,revision:sha},revision:sha,sha256:sha,groesse:size,file_path:ref.file_path!,bytebasis:'pg_text_utf8',
   lesen:async(offset,len,signal)=>{
    checkRange(size,offset,len);if(signal?.aborted)throw new HexFehler('zeitlimit');
    const z=await db.query("SELECT substring(convert_to(content,'UTF8') FROM $"+(vals.length+1)+"::integer+1 FOR $"+(vals.length+2)+"::integer) AS bytes FROM "+table+" WHERE "+where+" AND encode(digest(convert_to(content,'UTF8'),'sha256'),'hex')=$"+(vals.length+3),[...vals,offset,len,sha]);
    if(!z.rows[0])throw new HexFehler('quelle_geaendert');
    return z.rows[0].bytes as Buffer;
   },
   pruefen:async()=>{
    const z=await db.query("SELECT 1 FROM "+table+" WHERE "+where+" AND encode(digest(convert_to(content,'UTF8'),'sha256'),'hex')=$"+(vals.length+1),[...vals,sha]);
    if(!z.rows[0])throw new HexFehler('quelle_geaendert');
   },halten:async()=>{},freigeben:async()=>{}};
 }else{
  const cfg=getAssetKonfiguration();
  let row:Record<string,unknown>,adresse:AssetAdresse,key:string;
  let halten:HexQuelle['halten'],freigeben:HexQuelle['freigeben'],pruefen:HexQuelle['pruefen'];
  if(ref.art==='projekt_asset'){
   const r=await db.query("SELECT a.id::text,a.file_path,a.storage_kind,r.revision::text,r.sha256,r.groesse::text,r.storage_key FROM asset_files a JOIN asset_revisionen r ON r.asset_id=a.id AND r.revision=COALESCE($4::bigint,a.transport_revision) WHERE a.project=$1 AND ($2::bigint IS NULL OR a.id=$2::bigint) AND ($3::text IS NULL OR a.file_path=$3) AND a.deleted_at IS NULL AND a.storage_status='ready' AND a.prepared_upload_id IS NULL AND a.prepared_mutation_id IS NULL AND a.prepared_konflikt_id IS NULL AND r.tombstone=false LIMIT 2",[project,ref.id??null,ref.file_path??null,ref.revision??null]);
   if(r.rows.length!==1)throw new HexFehler(r.rows.length?'quelle_mehrdeutig':'quelle_nicht_gefunden');
   row=r.rows[0];if(!['assets','binaries'].includes(String(row.storage_kind)))throw new HexFehler('quelle_ungueltig');
   adresse={bereich:'projekt',ziel_ref:project,storage_kind:row.storage_kind as 'assets'|'binaries',logischer_pfad:String(row.file_path)};
   key=String(row.storage_key);
   const retention=new AssetRetention({speicher:new AssetSpeicher({konfiguration:cfg}),konfiguration:cfg});
   halten=(id,bis)=>retention.halten({ref_key:id,asset_id:String(row.id),revision:String(row.revision),art:'ansicht',expires_at:bis});
   freigeben=id=>retention.freigeben(id);
   pruefen=async()=>{
    const z=await db.query("SELECT 1 FROM asset_files a JOIN asset_revisionen r ON r.asset_id=a.id WHERE a.project=$1 AND a.id=$2::bigint AND r.revision=$3::bigint AND r.sha256=$4 AND r.tombstone=false AND a.deleted_at IS NULL AND a.storage_status='ready' AND a.prepared_upload_id IS NULL AND a.prepared_mutation_id IS NULL AND a.prepared_konflikt_id IS NULL",[project,row.id,row.revision,row.sha256]);
    if(!z.rows[0])throw new HexFehler('quelle_geaendert');
   };
  }else{
   if(await pruefeReverseAnsichtBindung(db,{projekt:project,eintrag_id:ref.reverse_id})!=='ok')throw new HexFehler('nicht_gebunden');
   const table=ref.art==='reverse_datei'?'reverse_dateien':'reverse_assets';
   const r=await db.query("SELECT id::text,pfad AS file_path,sha256,groesse::text,storage_key FROM "+table+" WHERE eintrag_id=$1 AND ($2::bigint IS NULL OR id=$2::bigint) AND ($3::text IS NULL OR pfad=$3) LIMIT 2",[ref.reverse_id,ref.id??null,ref.file_path??null]);
   if(r.rows.length!==1)throw new HexFehler(r.rows.length?'quelle_mehrdeutig':'quelle_nicht_gefunden');
   row=r.rows[0];row.revision=row.sha256;key=String(row.storage_key);
   if(ref.art==='reverse_datei'){
    const a=await reverseDateiSpeicherAdresse(db,ref.reverse_id!,String(row.id));adresse=a.adresse;
    if(a.storage_key!==key||a.sha256!==row.sha256)throw new HexFehler('quelle_geaendert');
   }else adresse={bereich:'reverse',ziel_ref:ref.reverse_id!,storage_kind:'assets',logischer_pfad:String(row.file_path)};
   const h=new ReverseAnsichtRetention().halter(ref.reverse_id!,String(row.sha256));halten=h.halten;freigeben=h.freigeben;
   pruefen=async()=>{
    if(await pruefeReverseAnsichtBindung(db,{projekt:project,eintrag_id:ref.reverse_id,sha256:row.sha256})!=='ok')throw new HexFehler('nicht_gebunden');
    const z=await db.query("SELECT 1 FROM "+table+" WHERE eintrag_id=$1 AND id=$2::bigint AND sha256=$3 AND storage_key=$4",[ref.reverse_id,row.id,row.sha256,key]);
    if(!z.rows[0])throw new HexFehler('quelle_geaendert');
   };
  }
  // Projektlayout bleibt sichtbar; readStorageStream oeffnet separat den PG-gepinnten internen Revisionskey.
  const speicher=new AssetSpeicher({konfiguration:cfg,...(ref.art==='projekt_asset'?{}:{layout:()=>key})}),size=Number(row.groesse);
  q={ref:{art:ref.art,id:String(row.id),file_path:String(row.file_path),...(ref.reverse_id?{reverse_id:ref.reverse_id}:{}),revision:String(row.revision),sha256:String(row.sha256)},
   file_path:String(row.file_path),revision:String(row.revision),sha256:String(row.sha256),groesse:size,bytebasis:ref.art==='projekt_asset'?'asset_revision':'reverse_bytes',
   halten,freigeben,pruefen,
   lesen:async(offset,len,signal)=>{
    checkRange(size,offset,len);if(signal?.aborted)throw new HexFehler('zeitlimit');
    const stream=await speicher.readStorageStream(adresse,key,offset,len);
    const abort=()=>stream.destroy(new HexFehler('zeitlimit'));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    try{const parts:Buffer[]=[];let n=0;for await(const c of stream){const b=Buffer.from(c);n+=b.length;if(n>len)throw new HexFehler('quelle_geaendert');parts.push(b);}if(n!==len)throw new HexFehler('quelle_geaendert');return Buffer.concat(parts,n);}
    finally{signal?.removeEventListener('abort',abort);stream.destroy();}
   }};
 }
 if(!Number.isSafeInteger(q.groesse)||q.groesse<0||!SHA.test(q.sha256))throw new HexFehler('quelle_ungueltig');
 if((ref.sha256&&ref.sha256!==q.sha256)||(ref.revision&&ref.revision!==q.revision))throw new HexFehler('quelle_geaendert');
 return q;
}
/** Gemeinsamer Einstieg fuer Folgeaktionen: halten -> arbeiten -> erneut pruefen -> freigeben. */
export async function mitHexQuelle<T>(project:string,ref:unknown,stand:HexStand,arbeit:(q:HexQuelle,signal:AbortSignal)=>Promise<T>):Promise<T>{
 const q=await oeffneHexQuelle(project,ref),id='hex:'+randomUUID();
 const bis=new Date(Date.now()+stand.werte.cursor_minuten.wert*60000);
 await q.halten(id,bis);
 try{
  const r=await arbeit(q,AbortSignal.timeout(stand.werte.laufzeit_ms.wert));
  await pruefeHexZugang(project);await q.pruefen();return r;
 }finally{await q.freigeben(id);}
}
