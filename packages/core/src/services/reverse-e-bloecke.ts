/** P18-T88: E-Metadaten wie Projektdateien hashbasiert/idempotent in bestätigten Indexblöcken.
 * Ausschließlich reverse_*; Inhaltsbytes bleiben unter reverseRoot. Kein FS-I/O innerhalb der PG-Transaktion. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {inTransaktionMitRetry} from '../db/transient-retry.js';
import {indexBloeckeAsync} from './index-bloecke.js';
import {zieheReverseAssetsNach} from './reverse-asset-registrierung.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {pruefeEDatei,sichereEEltern,eZielOrdner,reverseEGruppe,finalisiereEErgebnis} from './reverse-e-uebernahme.js';
import {reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {leseReverseDateienBelegt} from './reverse-belegung.js';

export interface ReverseEMetadatei {pfad:string;sha256:string;groesse:string;art?:string;metadaten?:Record<string,unknown>}
export interface ReverseEBlockAuftrag {
 jobId:string;reverseId:string;mediumId:string;arbeitsWurzel:string;reverseRoot:string;manifestSha:string;
 manifest:AsyncIterable<ReverseEMetadatei>;einstellungen:ReverseEinstellSnapshot;
 /** Bestehende Work-Job-Lease inkl. Deadline und Identität prüfen und sperren. */
 pruefeLease:(db:PoolClient)=>Promise<boolean>;
 fortschritt?:(v:{position:string;dateien:string;verworfen:string})=>Promise<void>;
}
interface Checkpoint {version?:number;artefakt?:unknown;einstellungen?:ReverseEinstellSnapshot;runner_status?:string;runner_fehlercode?:string|null;
 fehlversuche?:number;letzter_fehler?:string;manifest_sha:string;position:string;dateien:string;verworfen:string;fertig?:boolean;einstellungen_revision:string}
const innen=(root:string,p:string)=>p.startsWith(root+path.sep);
const ARTEN=new Set(['binaer','asset','text','archiv','sonstig']);
/** Zaehler sind Dezimaltexte (BIGINT); nur sichere Werte gehen als number weiter, nie gerundet. */
const sicher=(s:string)=>{const n=BigInt(s);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('reverse_e_zaehler_bereich');return Number(n);};
const stats=async(p:string)=>{try{return await fs.lstat(p,{bigint:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};

/** Wiederholt auch einen Absturz zwischen rename/link/unlink, ohne Quelldateien erneut zu erzeugen. */
async function dateiAblegen(root:string,arbeit:string,zielBasis:string,staging:string,position:bigint,d:ReverseEMetadatei,chunk:number):Promise<boolean>{
 const ziel=path.join(zielBasis,d.pfad),quelle=path.join(arbeit,d.pfad),zwischen=path.join(staging,String(position));
 if(!innen(zielBasis,ziel)||!innen(arbeit,quelle))return false;
 let z=await stats(ziel),s=await stats(zwischen);
 if(z){
  if(!await sichereEEltern(zielBasis,d.pfad))return false;
  // Crash nach link, vor unlink: nur denselben eigenen Inode entkoppeln.
  if(s&&s.isFile()&&z.isFile()&&s.ino===z.ino&&s.dev===z.dev&&s.nlink===2n){await fs.unlink(zwischen);s=null;}
  return pruefeEDatei(ziel,d,chunk);
 }
 if(!s){
  if(!await sichereEEltern(arbeit,d.pfad))return false;
  const q=await stats(quelle);if(!q?.isFile()||q.nlink!==1n||q.size!==BigInt(d.groesse))return false;
  await fs.rename(quelle,zwischen);s=await stats(zwischen);
 }
 if(!s?.isFile()||s.nlink!==1n||!await pruefeEDatei(zwischen,d,chunk))return false;
 await eZielOrdner(root,path.dirname(ziel));
 try{await fs.link(zwischen,ziel);}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;return false;}
 await fs.unlink(zwischen);
 return true;
}

export async function uebernehmeEInBloecken(pool:Pool,e:ReverseEBlockAuftrag):Promise<{dateien:number;verworfen:number}>{
 const {eFachauftrag,eCheckpoint,eMutation}=await import('./reverse-e-fortsetzung.js');
 if(!/^[0-9a-f-]{36}$/i.test(e.jobId)||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(e.reverseId)
  ||!/^[1-9][0-9]{0,18}$/.test(e.mediumId)||!/^[a-f0-9]{64}$/.test(e.manifestSha))throw new Error('reverse_e_block_parameter');
 if(e.einstellungen.letzter_fehler)throw new Error(e.einstellungen.letzter_fehler);
 const root=await fs.realpath(e.reverseRoot),arbeit=await fs.realpath(e.arbeitsWurzel);
 if(root!==path.resolve(e.reverseRoot)||arbeit!==path.resolve(e.arbeitsWurzel)||!innen(path.join(root,'_arbeit'),arbeit))throw new Error('reverse_e_block_pfad');
 const gruppe=reverseEGruppe(e.mediumId),ziel=path.join(root,e.reverseId,'entpackt',gruppe);
 // Segmentidentität verhindert, dass Position 1 eines Folgesegments einen alten Stagingrest verbraucht.
 const staging=path.join(root,e.reverseId,'entpackt','.e-'+e.jobId.toLowerCase(),e.manifestSha);
 const medium=(await pool.query('SELECT position,bezeichnung FROM reverse_medien WHERE id=$1 AND eintrag_id=$2',[e.mediumId,e.reverseId])).rows[0];
 if(!medium)throw new Error('reverse_e_block_medium');
 const label=typeof medium.bezeichnung==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(medium.bezeichnung.trim())
  ?medium.bezeichnung.trim():'medium-'+(Number(medium.position)+1);
 const f=await eFachauftrag(pool,e),alt=f.uebernahme as unknown as Checkpoint|null;
 if(alt?.manifest_sha&&alt.manifest_sha!==e.manifestSha)throw new Error('reverse_e_manifest_geaendert');
 let cp:Checkpoint=alt?.manifest_sha?alt:{...alt,manifest_sha:e.manifestSha,position:'0',dateien:alt?.dateien??'0',verworfen:alt?.verworfen??'0',einstellungen_revision:e.einstellungen.revision};
 await eCheckpoint(pool,e,cp as unknown as Record<string,unknown>);
 if(cp.fertig)return {dateien:sicher(cp.dateien),verworfen:sicher(cp.verworfen)};
 await eZielOrdner(root,staging);
 const maxRecord=reverseZahl(e.einstellungen,'manifest_record_bytes'),chunk=reverseZahl(e.einstellungen,'lese_block_bytes');
 const maxDatei=reverseBigInt(e.einstellungen,'max_datei_bytes'),tiefe=reverseZahl(e.einstellungen,'pfad_tiefe_max');
 async function* rest(){
  let position=0n;
  for await(const d of e.manifest){
   position++;
   if(position<=BigInt(cp.position))continue;
   if(Buffer.byteLength(JSON.stringify(d))>maxRecord)throw new Error('reverse_e_manifest_record_zu_gross');
   let pfad:string;
   try{pfad=normalisiereSpeicherPfad(d.pfad);}catch{throw new Error('reverse_e_manifest_pfad');}
   if(pfad!==d.pfad||pfad.length>reverseZahl(e.einstellungen,'speicher_pfad_zeichen')||pfad.split('/').length-1>tiefe
    ||pfad.split('/').some(t=>t==='.intern'||t.startsWith('.e-'))
    ||!/^[a-f0-9]{64}$/.test(d.sha256)||!/^(0|[1-9][0-9]*)$/.test(d.groesse))throw new Error('reverse_e_manifest_record_ungueltig');
   if(BigInt(d.groesse)>maxDatei)throw new Error('reverse_e_datei_zu_gross:'+d.pfad);
   const sql={pfad:label+'/'+d.pfad,sha256:d.sha256,groesse:d.groesse,art:ARTEN.has(d.art??'')?d.art:'sonstig',
    storage_key:e.reverseId+'/entpackt/'+gruppe+'/'+d.pfad,
    meta:{...d.metadaten,e_auftrag:e.jobId,e_pfad:d.pfad,e_manifest:e.manifestSha,e_position:String(position)}};
   yield {position:String(position),d,sql};
  }
 }
 const grenzen={zeilen:reverseZahl(e.einstellungen,'e_uebernahme_block_zeilen'),
  bytes:reverseZahl(e.einstellungen,'materialisierung_tx_bytes')-Buffer.byteLength(JSON.stringify([e.reverseId,e.mediumId,e.jobId]))};
 for await(const block of indexBloeckeAsync(rest(),grenzen)){
  const gesehen=new Set<string>();
  for(const {d,position} of block){
   if(gesehen.has(d.pfad))throw new Error('reverse_e_manifest_doppelter_pfad');
   gesehen.add(d.pfad);
   if(!await dateiAblegen(root,arbeit,ziel,staging,BigInt(position),d,chunk))throw new Error('reverse_e_datei_offen:'+d.pfad);
  }
  const erwartet=cp.position;
  // Metadaten und Cursor bewusst in verschiedenen TXs. Wiederholung derselben Segmentposition ist idempotent.
  const r=await eMutation(pool,e,`INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,entpackt_mit,metadaten,status)
   SELECT $1,$2,u.pfad,u.sha256,u.groesse,u.art,u.storage_key,'reverse-E',u.meta,'offen'
   FROM jsonb_to_recordset($3::jsonb) AS u(pfad text,sha256 text,groesse bigint,art text,storage_key text,meta jsonb)
   ON CONFLICT(eintrag_id,pfad) DO UPDATE SET art=EXCLUDED.art,metadaten=reverse_dateien.metadaten||EXCLUDED.metadaten,updated_at=clock_timestamp()
   WHERE reverse_dateien.sha256=EXCLUDED.sha256 AND reverse_dateien.groesse=EXCLUDED.groesse
    AND reverse_dateien.storage_key=EXCLUDED.storage_key
    AND (reverse_dateien.metadaten->>'e_auftrag' IS DISTINCT FROM $4
     OR (reverse_dateien.metadaten->>'e_manifest'=EXCLUDED.metadaten->>'e_manifest'
      AND reverse_dateien.metadaten->>'e_position'=EXCLUDED.metadaten->>'e_position'))
   RETURNING pfad`,
   [e.reverseId,e.mediumId,JSON.stringify(block.map(x=>x.sql)),e.jobId],block.length,async db=>{
    const aktuell=await eFachauftrag(db,e);
    if(aktuell.uebernahme?.manifest_sha!==e.manifestSha||aktuell.uebernahme?.position!==erwartet)throw new Error('reverse_e_checkpoint_geaendert');
    const altDateien=new Map((await db.query('SELECT pfad,groesse::text FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=ANY($2::text[])',
     [e.reverseId,block.map(x=>label+'/'+x.d.pfad)])).rows.map(z=>[z.pfad as string,BigInt(z.groesse as string)]));
    const delta=block.reduce((n,x)=>n+BigInt(x.d.groesse)-(altDateien.get(label+'/'+x.d.pfad)??0n),0n);
    // P18-T113: reverse_dateien-Anteil aus dem laufenden Zaehler (Schalter belegung_zaehler), Rueckhalt wie bisher.
    const dateienBytes=await leseReverseDateienBelegt(db,e.reverseId,e.einstellungen,'e_block');
    const belegt=(await db.query(`SELECT $3::numeric+
     COALESCE((SELECT sum((uebernahme#>>'{rueckhalt,bytes}')::numeric) FROM reverse_auftraege WHERE eintrag_id=$1
      AND p20_auftrag_id IS DISTINCT FROM $2::uuid AND uebernahme#>>'{rueckhalt,bytes}' ~ '^[0-9]+$'),0) AS bytes`,[e.reverseId,e.jobId,dateienBytes])).rows[0].bytes;
    if(BigInt(belegt)+delta>reverseBigInt(e.einstellungen,'eintrag_bytes'))throw new Error('reverse_e_eintrag_bytes');
   },true);
  if(r.rowCount!==block.length)throw new Error('reverse_e_datei_konflikt');
  cp={...cp,position:block[block.length-1].position,dateien:String(BigInt(cp.dateien)+BigInt(block.length))};
  await eCheckpoint(pool,e,cp as unknown as Record<string,unknown>);
  await e.fortschritt?.(cp);
 }
 cp={...cp,fertig:true};
 await eCheckpoint(pool,e,cp as unknown as Record<string,unknown>);
 // Schicht-/Auftragsabschluss folgt erst nach bestätigtem Extraktionsende im Executor.
 // T94 bleibt eintragsspezifisch und schreibt seine eigenen begrenzten Transaktionen.
 await zieheReverseAssetsNach(pool,{eintrag_id:e.reverseId,medium_id:e.mediumId,einstellungen:e.einstellungen,pruefeLease:db=>e.pruefeLease(db as PoolClient)});
 return {dateien:sicher(cp.dateien),verworfen:sicher(cp.verworfen)};
}
