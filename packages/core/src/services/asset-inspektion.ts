/** A12: leichte In-API-Worker mit dauerhaften PG-Aufträgen; bestehende Inspector-Engine. */
import {createHash,randomUUID} from 'node:crypto';
import {getPool} from '../db/client.js';
import {standardRegistry} from '../asset-intel/index.js';
import {AssetInspektionsWorker,WORKER_GNADENFRIST_MS} from '../asset-intel/worker-runner.js';
import type {AssetLimits,AssetResult} from '../asset-intel/types.js';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {apiCapabilitiesForClient} from '../vertrag/api-vertrag.js';
import {AssetSpeicher} from './asset-speicher.js';
import {speichereAssetErgebnis,loesePfadAuf,AssetInspektionsRevisionFehler} from './asset-intel-store.js';
import {starteApiAuftragsLoop,type ApiAuftragsLoop} from './api-auftrags-loop.js';

interface Auftrag {
 id:string; asset_id:string; project:string; transport_revision:string; sha256:string; profil:string;
 lease_token:string; file_path:string; storage_key:string; storage_kind:'assets'|'binaries'; file_size:string; grenzen:AssetLimits;
}
const BATCH_MAX=100;

/** Ausschließlich logischer Projektkatalog; kein getProjectRoot oder lokales stat. */
async function katalogExistenz(project:string,pfad:string,r:AssetResult):Promise<(p:string)=>boolean> {
 const kandidaten=new Set<string>();
 for(const ref of r.references){
  const a=loesePfadAuf(ref,{assetPfad:pfad});
  if(a.ziel_pfad)kandidaten.add(a.ziel_pfad);
  if(a.ziel_pfad?.endsWith('.uasset'))kandidaten.add(a.ziel_pfad.slice(0,-7)+'.umap');
 }
 if(!kandidaten.size)return ()=>false;
 const q=await getPool().query<{file_path:string}>(
  "SELECT file_path FROM code_files WHERE project=$1 AND file_path=ANY($2::text[]) "+
  "UNION SELECT file_path FROM asset_files WHERE project=$1 AND file_path=ANY($2::text[]) AND deleted_at IS NULL AND ("+
  "(transport_revision IS NULL AND storage_key IS NULL AND status<>'quelle_nicht_gefunden') OR "+
  "(transport_revision IS NOT NULL AND storage_key IS NOT NULL AND storage_status='ready' AND prepared_upload_id IS NULL))",
  [project,[...kandidaten]]);
 const vorhanden=new Set(q.rows.map(x=>x.file_path));
 return p=>vorhanden.has(p);
}

export class AssetInspektionsDienst {
 private readonly workers:AssetInspektionsWorker[];
 private readonly profil:string;
 private readonly grenzen:AssetLimits;
 private readonly leaseMs:number;
 private beendet=false;
 constructor(private readonly cfg:AssetKonfiguration=getAssetKonfiguration(),private readonly speicher=new AssetSpeicher({konfiguration:cfg})) {
  this.grenzen={...cfg.inspektion};
  this.profil=createHash('sha256').update(JSON.stringify({engine:'asset-readRange-v1',limits:this.grenzen,storeMaxObjects:cfg.speicher.maxObjekteJeDatei,
   inspectors:standardRegistry.list().map(i=>({id:i.id,version:i.version})).sort((a,b)=>a.id.localeCompare(b.id)),
  })).digest('hex');
  this.leaseMs=cfg.inspektion.timeoutMs+WORKER_GNADENFRIST_MS+cfg.speicher.timeoutMs;
  this.workers=Array.from({length:cfg.sync.parallelInspektionen},()=>new AssetInspektionsWorker());
 }
 private async entdecke():Promise<void> {
  const db=getPool();
  await db.query("UPDATE asset_inspektions_auftraege j SET status='stale',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() "+
   "WHERE j.status IN ('waiting','running','error') AND NOT EXISTS(SELECT 1 FROM asset_files a WHERE a.id=j.asset_id "+
   "AND a.transport_revision=j.transport_revision AND a.transport_sha256=j.sha256 AND a.deleted_at IS NULL)");
  await db.query("INSERT INTO asset_inspektions_auftraege(id,asset_id,project,transport_revision,sha256,profil,grenzen) "+
   "SELECT gen_random_uuid(),a.id,a.project,a.transport_revision,a.transport_sha256,$1,$2::jsonb FROM asset_files a "+
   "WHERE a.transport_revision IS NOT NULL AND a.storage_key IS NOT NULL AND a.storage_kind IN ('assets','binaries') "+
   "AND a.transport_sha256 IS NOT NULL AND a.storage_status='ready' AND a.deleted_at IS NULL AND a.prepared_upload_id IS NULL "+
   "AND NOT EXISTS(SELECT 1 FROM asset_inspektions_auftraege j WHERE j.asset_id=a.id AND j.transport_revision=a.transport_revision "+
   "AND j.sha256=a.transport_sha256 AND j.profil=$1) ORDER BY a.id LIMIT $3 "+
   "ON CONFLICT(asset_id,transport_revision,sha256,profil) DO NOTHING",
   [this.profil,JSON.stringify(this.grenzen),BATCH_MAX]);
 }
 private async claim():Promise<Auftrag|undefined> {
  const r=await getPool().query<Auftrag>("WITH kandidat AS (SELECT j.id FROM asset_inspektions_auftraege j JOIN asset_files a ON a.id=j.asset_id "+
   "WHERE j.profil=$1 AND (j.status='waiting' OR j.status='running' AND j.lease_bis<=clock_timestamp() "+
   "OR j.status='error' AND j.updated_at<=clock_timestamp()-$4::double precision*interval '1 millisecond') "+
   "AND a.transport_revision=j.transport_revision AND a.transport_sha256=j.sha256 AND a.storage_status='ready' "+
   "AND a.deleted_at IS NULL AND a.prepared_upload_id IS NULL ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1), "+
   "claim AS (UPDATE asset_inspektions_auftraege j SET status='running',lease_token=$2::uuid,"+
   "lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond',versuche=versuche+1,fehler=NULL,updated_at=clock_timestamp() "+
   "FROM kandidat k WHERE j.id=k.id RETURNING j.*) "+
   "SELECT c.id,c.asset_id::text,c.project,c.transport_revision::text,c.sha256,c.profil,c.lease_token,c.grenzen,"+
   "a.file_path,a.storage_key,a.storage_kind,a.file_size::text FROM claim c JOIN asset_files a ON a.id=c.asset_id",
   [this.profil,randomUUID(),this.leaseMs,this.cfg.sync.retryIntervallMs]);
  return r.rows[0];
 }
 private async bearbeite(worker:AssetInspektionsWorker,j:Auftrag):Promise<void> {
  let quelle:Awaited<ReturnType<AssetSpeicher['oeffneInspektionsQuelle']>>|undefined;
  try {
   quelle=await this.speicher.oeffneInspektionsQuelle({bereich:'projekt',ziel_ref:j.project,storage_kind:j.storage_kind,logischer_pfad:j.file_path},j.storage_key);
   if(String(quelle.size)!==j.file_size)throw new AssetInspektionsRevisionFehler();
   const ergebnis=await worker.inspiziereQuelle(quelle,{grenzen:j.grenzen,timeoutMs:j.grenzen.timeoutMs});
   if(this.beendet)throw new Error('Inspektionsdienst beendet');
   await quelle.pruefeUnveraendert();
   if(ergebnis.sha256!==null&&ergebnis.sha256!==j.sha256)throw new AssetInspektionsRevisionFehler();
   // A3 prüft Transporthash vollständig; bei Hash-Kappung bleibt die bestätigte Identität maßgeblich.
   ergebnis.sha256=j.sha256;
   const existiert=await katalogExistenz(j.project,j.file_path,ergebnis);
   await speichereAssetErgebnis(j.project,j.file_path,ergebnis,{
    erwarteteTransportRevision:j.transport_revision,inspektionsAuftrag:{id:j.id,token:j.lease_token},
    katalogAutoritativ:true,existiert,projektRoot:null,mtime:null,host:'synapse-api',erkenneUmbenennung:false,
   });
  } catch(e) {
   const aktuell=await getPool().query<{aktuell:boolean}>("SELECT EXISTS(SELECT 1 FROM asset_files WHERE id=$1::bigint AND project=$2 AND transport_revision=$3::bigint AND transport_sha256=$4 AND deleted_at IS NULL) AS aktuell",[j.asset_id,j.project,j.transport_revision,j.sha256]);
   // Leaseverlust/Prepare bei unveränderter Revision ist wiederholbar, kein permanenter Stale-Eintrag.
   const stale=aktuell.rows[0]?.aktuell!==true;
   await getPool().query("UPDATE asset_inspektions_auftraege SET status=$3,fehler=$4,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() "+
    "WHERE id=$1::uuid AND lease_token=$2::uuid AND status='running'",
    [j.id,j.lease_token,stale?'stale':'error',stale?'Revision/Lease nicht mehr passend':'Inspektion fehlgeschlagen']);
   if(!stale)console.error('[Asset-Inspektion] Auftrag fehlgeschlagen',j.id,e);
  } finally {await quelle?.schliessen();}
 }
 async durchlauf():Promise<void> {
  if(this.beendet)return;
  await this.entdecke();
  await Promise.all(this.workers.map(async w=>{if(this.beendet)return;const j=await this.claim();if(j)await this.bearbeite(w,j);}));
 }
 async beende():Promise<void> {this.beendet=true;await Promise.all(this.workers.map(w=>w.beende()));}
}

/** Ausschließlich API-Start, Capability-Gate und Betreiber-Konfiguration. */
export function starteAssetInspektion():ApiAuftragsLoop|null {
 const cfg=getAssetKonfiguration();
 if(!cfg.aktiv||!apiCapabilitiesForClient('1')?.features.includes('asset_sync'))return null;
 const dienst=new AssetInspektionsDienst(cfg);
 const loop=starteApiAuftragsLoop({intervallMs:cfg.sync.scanIntervallMs,arbeit:()=>dienst.durchlauf(),
  fehler:e=>console.error('[Asset-Inspektion] Durchlauf fehlgeschlagen',e)});
 return {durchlauf:loop.durchlauf,beende:async()=>{await dienst.beende();await loop.beende();}};
}
