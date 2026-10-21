/** P18-T88: E-Metadaten wie Projektdateien hashbasiert/idempotent in bestätigten Indexblöcken.
 * Ausschließlich reverse_*; Inhaltsbytes bleiben unter reverseRoot. Kein FS-I/O innerhalb der PG-Transaktion. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {inTransaktionMitRetry} from '../db/transient-retry.js';
import {indexBloeckeAsync} from './index-bloecke.js';
import {normalisiereSpeicherPfad} from './asset-speicher.js';
import {pruefeEDatei,sichereEEltern,eZielOrdner,reverseEGruppe,finalisiereEErgebnis} from './reverse-e-uebernahme.js';
import {reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';

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
 if(!/^[0-9a-f-]{36}$/i.test(e.jobId)||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(e.reverseId)
  ||!/^[1-9][0-9]{0,18}$/.test(e.mediumId)||!/^[a-f0-9]{64}$/.test(e.manifestSha))throw new Error('reverse_e_block_parameter');
 if(e.einstellungen.letzter_fehler)throw new Error(e.einstellungen.letzter_fehler);
 const root=await fs.realpath(e.reverseRoot),arbeit=await fs.realpath(e.arbeitsWurzel);
 if(!innen(path.join(root,'_arbeit'),arbeit))throw new Error('reverse_e_block_pfad');
 const gruppe=reverseEGruppe(e.mediumId),ziel=path.join(root,e.reverseId,'entpackt',gruppe);
 const staging=path.join(root,e.reverseId,'entpackt','.e-'+e.jobId.toLowerCase());
 const medium=(await pool.query('SELECT position,bezeichnung FROM reverse_medien WHERE id=$1 AND eintrag_id=$2',[e.mediumId,e.reverseId])).rows[0];
 if(!medium)throw new Error('reverse_e_block_medium');
 const label=typeof medium.bezeichnung==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(medium.bezeichnung.trim())
  ?medium.bezeichnung.trim():'medium-'+(Number(medium.position)+1);
 const tx=<T>(body:(db:PoolClient)=>Promise<T>)=>inTransaktionMitRetry(pool,'reverse-e-block',async db=>{
  if(!await e.pruefeLease(db))throw new Error('reverse_e_lease_verloren');
  return body(db);
 },{versuche:reverseZahl(e.einstellungen,'retry_max')});
 const auftrag=await tx(async db=>{
  const r=(await db.query("SELECT id::text,uebernahme FROM reverse_auftraege WHERE eintrag_id=$1 AND medium_id=$2 AND schicht='E' AND p20_auftrag_id=$3 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[e.reverseId,e.mediumId,e.jobId])).rows[0];
  if(!r)throw new Error('reverse_e_block_auftrag');
  const alt=r.uebernahme as Checkpoint|null;
  if(alt?.manifest_sha&&alt.manifest_sha!==e.manifestSha)throw new Error('reverse_e_manifest_geaendert');
  const cp:Checkpoint=alt?.manifest_sha?alt:{...alt,manifest_sha:e.manifestSha,position:'0',dateien:'0',verworfen:'0',einstellungen_revision:e.einstellungen.revision};
  await db.query('UPDATE reverse_auftraege SET uebernahme=$2::jsonb WHERE id=$1',[r.id,JSON.stringify(cp)]);
  const bytes=(await db.query('SELECT COALESCE(sum(groesse),0)::text AS bytes FROM reverse_dateien WHERE eintrag_id=$1',[e.reverseId])).rows[0].bytes as string;
  return {id:r.id as string,cp,bytes};
 });
 // Review 028940c6/B5: Eintragssumme einmal je Lauf lesen, danach je bestaetigtem Block um die tatsaechlich geschriebenen Bytes
 // fortschreiben (kein Vollscan je Block). Parallele Laeufe anderer Medien desselben Eintrags sieht der naechste Lauf.
 let cp=auftrag.cp,eintragBytes=BigInt(auftrag.bytes);
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
   const sql={pfad:label+'/'+d.pfad,sha256:d.sha256,groesse:d.groesse,art:ARTEN.has(d.art??'')?d.art:'sonstig',
    storage_key:e.reverseId+'/entpackt/'+gruppe+'/'+d.pfad,meta:{...d.metadaten,e_auftrag:e.jobId,e_pfad:d.pfad,e_position:String(position)}};
   yield {position:String(position),d,sql};
  }
 }
 const grenzen={zeilen:reverseZahl(e.einstellungen,'e_uebernahme_block_zeilen'),bytes:reverseZahl(e.einstellungen,'materialisierung_tx_bytes')-4*Buffer.byteLength(JSON.stringify(cp))-Buffer.byteLength(e.reverseId+e.mediumId+e.jobId)};
 for await(const block of indexBloeckeAsync(rest(),grenzen)){
  const bereit:Array<{position:string;d:ReverseEMetadatei;sql:Record<string,unknown>}>=[];
  const gesehen=new Set<string>();let verworfen=0n;
  for(const item of block){
   const {d}=item;
   let pfad:string;
   try{pfad=normalisiereSpeicherPfad(d.pfad);}catch{verworfen++;continue;}
   if(pfad!==d.pfad||pfad.length>reverseZahl(e.einstellungen,'speicher_pfad_zeichen')||pfad.split('/').length-1>tiefe
    ||pfad.split('/').some(t=>t==='.intern'||t.startsWith('.e-'))||gesehen.has(pfad)
    ||!/^[a-f0-9]{64}$/.test(d.sha256)||!/^(0|[1-9][0-9]*)$/.test(d.groesse)||BigInt(d.groesse)>maxDatei){verworfen++;continue;}
   gesehen.add(pfad);
   if(await dateiAblegen(root,arbeit,ziel,staging,BigInt(item.position),d,chunk))bereit.push(item);else verworfen++;
  }
  const erwartet=cp.position;
  const [naechster,geschriebenBytes]=await tx(async db=>{
   const aktuell=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1 FOR UPDATE',[auftrag.id])).rows[0]?.uebernahme as Checkpoint;
   if(!aktuell||aktuell.manifest_sha!==e.manifestSha||aktuell.position!==erwartet)throw new Error('reverse_e_checkpoint_geaendert');
   // Eintrags-Bytebudget unter derselben Eintragssperre; kein Dateianzahl-Gesamtlimit.
   await db.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[e.reverseId]);
   const altDateien=new Map((await db.query('SELECT pfad,groesse::text FROM reverse_dateien WHERE eintrag_id=$1 AND pfad=ANY($2::text[])',[e.reverseId,bereit.map(x=>label+'/'+x.d.pfad)])).rows
    .map(z=>[z.pfad as string,BigInt(z.groesse as string)]));
   const differenz=(x:{d:ReverseEMetadatei})=>BigInt(x.d.groesse)-(altDateien.get(label+'/'+x.d.pfad)??0n);
   const delta=bereit.reduce((n,x)=>n+differenz(x),0n);
   if(eintragBytes+delta>reverseBigInt(e.einstellungen,'eintrag_bytes'))throw new Error('reverse_e_eintrag_bytes');
   // Genauso wie Projekt-Code: gebundene Werte, Hash-Upsert und bounded SQL, eigene Reverse-Tabelle.
   const r=bereit.length?await db.query(`INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,entpackt_mit,metadaten,status)
    SELECT $1,$2,u.pfad,u.sha256,u.groesse,u.art,u.storage_key,'reverse-E',u.meta,'offen'
    FROM jsonb_to_recordset($3::jsonb) AS u(pfad text,sha256 text,groesse bigint,art text,storage_key text,meta jsonb)
    ON CONFLICT(eintrag_id,pfad) DO UPDATE SET sha256=EXCLUDED.sha256,groesse=EXCLUDED.groesse,storage_key=EXCLUDED.storage_key,
     art=EXCLUDED.art,metadaten=reverse_dateien.metadaten||EXCLUDED.metadaten,updated_at=clock_timestamp()
    WHERE (reverse_dateien.storage_key=EXCLUDED.storage_key OR reverse_dateien.storage_key IS NULL)
     AND (reverse_dateien.metadaten->>'e_auftrag' IS DISTINCT FROM $4 OR reverse_dateien.metadaten->>'e_position'=EXCLUDED.metadaten->>'e_position')
    RETURNING pfad`,
    [e.reverseId,e.mediumId,JSON.stringify(bereit.map(x=>x.sql)),e.jobId]):{rowCount:0,rows:[]};
   const geschrieben=new Set(r.rows.map(z=>z.pfad as string));
   const neu=BigInt(r.rowCount??0);
   const next:Checkpoint={...aktuell,position:block[block.length-1].position,
    dateien:String(BigInt(aktuell.dateien)+neu),verworfen:String(BigInt(aktuell.verworfen)+verworfen+BigInt(bereit.length)-neu)};
   await db.query("UPDATE reverse_auftraege SET uebernahme=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1",[auftrag.id,JSON.stringify(next)]);
   return [next,bereit.reduce((n,x)=>geschrieben.has(label+'/'+x.d.pfad)?n+differenz(x):n,0n)] as const;
  });
  cp=naechster;eintragBytes+=geschriebenBytes;
  await e.fortschritt?.(cp);
 }
 return tx(async db=>{
  const alt=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1 FOR UPDATE',[auftrag.id])).rows[0]?.uebernahme as Checkpoint;
  if(!alt||alt.manifest_sha!==e.manifestSha||alt.position!==cp.position)throw new Error('reverse_e_checkpoint_geaendert');
  const r=await finalisiereEErgebnis(db,e,sicher(cp.dateien),sicher(cp.verworfen));
  if(cp.runner_status==='teilweise'){
   // P18-T87/T88: vorzeitig beendeter Lauf: Uebernommenes bleibt, Auftrag und E-Schicht zeigen teilweise mit Code.
   await db.query("UPDATE reverse_auftraege SET status='teilweise',fehlercode=$2 WHERE id=$1",[auftrag.id,cp.runner_fehlercode??null]);
   await db.query("UPDATE reverse_schichten SET status='teilweise',fehlercode=$2 WHERE auftrag_id=$1 AND aktuell",[auftrag.id,cp.runner_fehlercode??null]);
  }
  await db.query("UPDATE reverse_auftraege SET uebernahme=$2::jsonb WHERE id=$1",[auftrag.id,JSON.stringify({...cp,fertig:true})]);
  return r;
 });
}
