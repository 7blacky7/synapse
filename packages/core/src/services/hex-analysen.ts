/** P21-T15: PG-Metadaten + unveraenderliche interne Assetbytes, keine Schluesselspeicherung. */
import {randomUUID,createHash} from 'node:crypto';
import {getPool} from '../db/client.js';
import {AssetSpeicher,type AssetAdresse} from './asset-speicher.js';
import {getAssetKonfiguration} from '../config/asset-konfig.js';
import {HexFehler,hexAkteur,oeffneHexQuelle,type HexRef,type HexQuelle} from './hex-quellen.js';
import type {HexStand} from './hex-einstellungen.js';
export interface HexAnalyseMetadaten {wurzeln:HexRef[];tiefe:number;expires_at:string;herkunft:Record<string,unknown>}
const adresse=(project:string):AssetAdresse=>({bereich:'projekt',ziel_ref:project,storage_kind:'assets',logischer_pfad:'hex-analyse'});
const speicher=()=>new AssetSpeicher({konfiguration:getAssetKonfiguration()});
export function hexAnalyseWurzeln(quellen:HexQuelle[],stand:HexStand):{wurzeln:HexRef[];tiefe:number}{
 const alle=quellen.flatMap(q=>q.analyse?.wurzeln??[q.ref]);
 const wurzeln=[...new Map(alle.map(r=>[JSON.stringify(r),r])).values()];
 const tiefe=1+Math.max(0,...quellen.map(q=>q.analyse?.tiefe??0));
 if(tiefe>stand.werte.max_analyse_tiefe.wert||wurzeln.length>stand.werte.max_analyse_quellen.wert)throw new HexFehler('analyse_kette_zu_tief');
 return {wurzeln,tiefe};
}
export async function reserviereHexAnalyse(project:string,herkunft:Record<string,unknown>,basis:{wurzeln:HexRef[];tiefe:number},stand:HexStand,maxBytes:number):Promise<string>{
 if(JSON.stringify(herkunft).length>stand.werte.antwort_zeichen.wert)throw new HexFehler('budget_ueberschritten');
 const c=await getPool().connect(),id=randomUUID(),bis=new Date(Date.now()+stand.werte.analyse_minuten.wert*60000);
 try{
  await c.query('BEGIN');
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",['hex-analysen:'+project]);
  // Auch abgelaufene/fehlgeschlagene Auftraege belegen Speicher. Kein ungebremstes Neu-Anlegen nach TTL.
  const z=(await c.query("SELECT COUNT(*)::text AS n,COALESCE(SUM(groesse),0)::text AS bytes FROM hex_analysen WHERE project=$1",[project])).rows[0];
  if(BigInt(z.n)>=BigInt(stand.werte.max_analysen.wert)||BigInt(z.bytes)+BigInt(maxBytes)>BigInt(stand.werte.analyse_speicher_bytes.wert))throw new HexFehler('analyse_speicher_voll');
  await c.query("INSERT INTO hex_analysen(id,project,akteur,status,groesse,herkunft,wurzeln,tiefe,expires_at) VALUES($1,$2,$3,'vorbereitet',$4,$5::jsonb,$6::jsonb,$7,$8)",[id,project,hexAkteur(project),maxBytes,JSON.stringify(herkunft),JSON.stringify(basis.wurzeln),basis.tiefe,bis]);
  await c.query('COMMIT');return id;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
/** Bytes werden exklusiv geschrieben und fsync'ed, bevor die PG-Referenz bereit werden kann. */
export async function stageHexAnalyse(project:string,id:string,bytes:Buffer,maxBytes:number):Promise<string>{
 const sha=createHash('sha256').update(bytes).digest('hex');
 await speicher().schreibeHexAnalyse(adresse(project),id,bytes,maxBytes);
 const r=await getPool().query("UPDATE hex_analysen SET sha256=$3,groesse=$4 WHERE id=$1 AND project=$2 AND status='vorbereitet' AND expires_at>NOW() RETURNING id",[id,project,sha,bytes.length]);
 if(!r.rows.length)throw new HexFehler('analyse_abgelaufen');return sha;
}
export async function publiziereHexAnalyse(project:string,id:string,jobId:string|null):Promise<HexRef>{
 const r=await getPool().query("UPDATE hex_analysen a SET status='bereit',work_job_id=$3 WHERE a.id=$1 AND a.project=$2 AND a.status='vorbereitet' AND a.sha256 IS NOT NULL AND a.expires_at>NOW() AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM work_jobs w WHERE w.id=$3 AND w.state='completed' AND w.project=a.project AND w.output_ref->>'id'=a.id::text AND w.output_ref->>'sha256'=a.sha256)) RETURNING sha256",[id,project,jobId]);
 if(!r.rows.length)throw new HexFehler('analyse_nicht_publiziert');
 return {art:'analyse',id,sha256:r.rows[0].sha256,revision:r.rows[0].sha256};
}
export async function verwerfeHexAnalyse(project:string,id:string):Promise<void>{
 // Physische Daten bleiben erhalten; keine ungefragte Loesch-/Prune-Strecke.
 await getPool().query("UPDATE hex_analysen SET status='fehler' WHERE id=$1 AND project=$2 AND status='vorbereitet'",[id,project]);
}
export async function oeffneHexAnalyse(project:string,ref:HexRef):Promise<HexQuelle>{
 const db=getPool();
 const lade=async()=> (await db.query("SELECT groesse::text,sha256,herkunft,wurzeln,tiefe,expires_at FROM hex_analysen WHERE id=$1 AND project=$2 AND status='bereit' AND expires_at>NOW()",[ref.id,project])).rows[0];
 const z=await lade();if(!z)throw new HexFehler('analyse_nicht_gefunden_oder_abgelaufen');
 const size=Number(z.groesse),sha=String(z.sha256);
 if((ref.sha256&&ref.sha256!==sha)||(ref.revision&&ref.revision!==sha))throw new HexFehler('quelle_geaendert');
 if(!Array.isArray(z.wurzeln)||!z.wurzeln.length||z.wurzeln.some((r:HexRef)=>r.art==='analyse'))throw new HexFehler('quelle_ungueltig');
 const quellen:HexQuelle[]=[];
 for(const r of z.wurzeln)quellen.push(await oeffneHexQuelle(project,r));
 const analyse:HexAnalyseMetadaten={herkunft:z.herkunft,wurzeln:z.wurzeln,tiefe:z.tiefe,expires_at:new Date(z.expires_at).toISOString()};
 return {ref:{art:'analyse',id:ref.id,revision:sha,sha256:sha},file_path:'hex-analyse/'+ref.id,revision:sha,sha256:sha,groesse:size,bytebasis:'analyse_bytes',analyse,
  lesen:async(offset,len,signal)=>{
   if(signal?.aborted)throw new HexFehler('zeitlimit');
   const b=await speicher().leseHexAnalyse(adresse(project),ref.id!,offset,len,size);
   if(signal?.aborted){b.fill(0);throw new HexFehler('zeitlimit');}return b;
  },
  pruefen:async()=>{const a=await lade();if(!a||String(a.sha256)!==sha||Number(a.groesse)!==size)throw new HexFehler('analyse_nicht_gefunden_oder_abgelaufen');for(const q of quellen)await q.pruefen();},
  halten:async(id,bis)=>{const gehalten:HexQuelle[]=[];try{for(const q of quellen){await q.halten(id+':'+gehalten.length,bis);gehalten.push(q);}}catch(e){await Promise.allSettled(gehalten.map((q,i)=>q.freigeben(id+':'+i)));throw e;}},
  freigeben:async id=>{await Promise.allSettled(quellen.map((q,i)=>q.freigeben(id+':'+i)));},
 };
}
