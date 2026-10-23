/** P18-T93: E-Fortsetzung/Retention. Nur Reverse-Metadaten, Bytes bleiben auf dem Share.
 * P20 stage/complete bleibt außerhalb dieser Reverse-TX-Grenze (konstant Status+Audit je Auftrag). */
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {REVERSE_FEHLERCODES} from './reverse-tool.js';

export interface EKontext {
 jobId:string;reverseId:string;mediumId:string;einstellungen:ReverseEinstellSnapshot;
 pruefeLease:(db:PoolClient)=>Promise<boolean>;
}
export interface ERetention {
 erhalten:true;storage_key:string;bytes:string|null;grund:string;loeschen:false;automatisch_fortsetzen:false;
 fehler?:{errno:string;pfad:string};[key:string]:unknown;
}
const innen=(root:string,p:string)=>p.startsWith(root+path.sep);
export async function eMutation(pool:Pool,e:EKontext,sql:string,params:unknown[],zeilen=1,vor?:(db:PoolClient)=>Promise<void>,genau=false){
 if(e.einstellungen.letzter_fehler)throw new Error(e.einstellungen.letzter_fehler);
 if(zeilen>reverseZahl(e.einstellungen,'e_uebernahme_block_zeilen')
  ||BigInt(Buffer.byteLength(JSON.stringify(params)))>reverseBigInt(e.einstellungen,'materialisierung_tx_bytes'))
  throw new Error('reverse_e_tx_grenze');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  if(!await e.pruefeLease(c))throw new Error('reverse_e_lease_verloren');
  // Eintragsweiter Serialisierungspunkt auch für konkurrierende Medien.
  await c.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[e.reverseId]);
  await vor?.(c);
  const r=await c.query(sql,params);
  if((r.rowCount??0)>zeilen||(genau&&r.rowCount!==zeilen))throw new Error('reverse_e_tx_zeilen');
  await c.query('COMMIT');return r;
 }catch(err){await c.query('ROLLBACK');throw err;}finally{c.release();}
}
export async function eFachauftrag(pool:Pick<Pool,'query'>,e:Pick<EKontext,'jobId'|'reverseId'|'mediumId'>){
 const r=await pool.query("SELECT id::text,fingerabdruck,uebernahme,werkzeug,werkzeug_version,profil_version FROM reverse_auftraege WHERE p20_auftrag_id=$1 AND eintrag_id=$2 AND medium_id=$3 AND schicht='E' ORDER BY created_at DESC LIMIT 1",
  [e.jobId,e.reverseId,e.mediumId]);
 if(!r.rows.length)throw new Error('reverse_e_auftrag_fehlt');
 return r.rows[0] as {id:string;fingerabdruck:string;uebernahme:Record<string,unknown>|null;werkzeug:string;werkzeug_version:string;profil_version:string};
}
export async function eCheckpoint(pool:Pool,e:EKontext,patch:Record<string,unknown>){
 const f=await eFachauftrag(pool,e);
 const next={...f.uebernahme,...patch};
 await eMutation(pool,e,"UPDATE reverse_auftraege SET uebernahme=COALESCE(uebernahme,'{}'::jsonb)||$2::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND eintrag_id=$3",
  [f.id,JSON.stringify(next),e.reverseId]);
}
/** Kein fehlgeschlagenes rename/Retry darf eine Löschfreigabe erzeugen. */
export async function eArbeitsBeleg(root:string,arbeit:string,grund:string):Promise<ERetention>{
 const base=await fs.realpath(root),p=path.resolve(arbeit),key=path.relative(base,p).split(path.sep).join('/');
 if(base!==path.resolve(root)||!innen(path.join(base,'_arbeit'),p))throw new Error('reverse_e_retention_scope');
 let cursor=base,bytes=0n;
 try{
  for(const part of key.split('/')){
   cursor=path.join(cursor,part);const st=await fs.lstat(cursor);
   if(!st.isDirectory()||st.isSymbolicLink())throw Object.assign(new Error('reverse_e_retention_symlink'),{code:'EPFAD'});
  }
  async function scan(dir:string):Promise<void>{
   const d=await fs.opendir(dir);
   for await(const item of d){
    const child=path.join(dir,item.name),st=await fs.lstat(child,{bigint:true});
    if(st.isDirectory()&&!st.isSymbolicLink())await scan(child);
    else if(st.isFile()&&st.nlink===1n)bytes+=st.size;
    else throw Object.assign(new Error('reverse_e_retention_spezialdatei'),{code:'EPFAD'});
   }
  }
  await scan(p);
  return {erhalten:true,storage_key:key,bytes:String(bytes),grund,loeschen:false,automatisch_fortsetzen:false};
 }catch(err){
  return {erhalten:true,storage_key:key,bytes:null,grund,loeschen:false,automatisch_fortsetzen:false,
   fehler:{errno:(err as NodeJS.ErrnoException).code??'UNBEKANNT',pfad:key}};
 }
}
export async function eDateiExists(p:string):Promise<boolean>{
 try{await fs.lstat(p);return true;}catch(err){if((err as NodeJS.ErrnoException).code==='ENOENT')return false;throw err;}
}
/** Nach rename/vor PG-COMMIT: vorhandenen Rückhalt nur als Rückhalt rekonstruieren, nie als Import adoptieren. */
export async function eRueckhaltBeleg(root:string,e:Pick<EKontext,'jobId'|'reverseId'|'mediumId'>,quellhash:string|null,limit:number){
 const key=e.reverseId+'/.intern/rueckhalt/'+e.jobId.toLowerCase(),base=path.resolve(root),dir=path.join(base,key);
 if(await fs.realpath(root)!==base||!/^[0-9a-f-]{36}$/i.test(e.jobId)||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(e.reverseId))throw new Error('reverse_e_rueckhalt_scope');
 if(!await eDateiExists(dir))return null;
 let p=base;
 for(const part of key.split('/')){p=path.join(p,part);const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('reverse_e_rueckhalt_scope');}
 const h=await fs.open(path.join(dir,'rueckhalt.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let v:Record<string,any>,infoBytes=0n;
 try{const st=await h.stat();if(!st.isFile()||st.nlink!==1||st.size>limit)throw new Error('reverse_e_rueckhalt_beleg');infoBytes=BigInt(st.size);v=JSON.parse(await h.readFile('utf8'));}
 finally{await h.close();}
 if(v.version!==1||v.herkunft?.eintrag_id!==e.reverseId||String(v.herkunft?.medium_id)!==e.mediumId
  ||v.herkunft?.job_id!==e.jobId.toLowerCase()||v.herkunft?.quellhash!==quellhash
  ||v.manifest!=='rueckhalt-manifest.jsonl'||!/^[a-f0-9]{64}$/.test(v.manifest_sha256))
  throw new Error('reverse_e_rueckhalt_herkunft');
 const mf=await fs.open(path.join(dir,v.manifest),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const st=await mf.stat();if(!st.isFile()||st.nlink!==1||String(st.size)!==v.manifest_bytes)throw new Error('reverse_e_rueckhalt_beleg');
  const hash=createHash('sha256');for await(const b of mf.createReadStream({autoClose:false,highWaterMark:limit}))hash.update(b);
  if(hash.digest('hex')!==v.manifest_sha256)throw new Error('reverse_e_rueckhalt_manifest');
 }finally{await mf.close();}
 const bytes=BigInt(v.quell_bytes)+BigInt(v.manifest_bytes)+infoBytes;
 return {storage_key:key,manifest:v.manifest,manifest_sha256:v.manifest_sha256,erhalten:true,bytes:String(bytes),
  offen:v.zaehler.offen,abgewiesen:v.zaehler.abgewiesen,grund:v.grund,loeschen:false,automatisch_fortsetzen:false,
  rekonstruierter_beleg:true};
}
/** Kleine, voneinander wiederholbare Statusphasen; nie ein großer Abschluss-Commit. */
export async function eAbschluss(pool:Pool,e:EKontext,werte:{dateien:string;abgewiesen:string;offen:string;grund:string|null;rueckhalt?:Record<string,unknown>;fertig:boolean;status?:'fehler'}){
 const f=await eFachauftrag(pool,e),status=werte.status??(werte.fertig?'fertig':'teilweise');
 // Die alte Schema-UI hat INTEGER-Zähler; Vollständigkeit hängt nur an den exakten JSON-Dezimalwerten.
 const anzeige=(n:string)=>Number(BigInt(n)>2147483647n?2147483647n:BigInt(n));
 const sum=String(BigInt(werte.dateien)+BigInt(werte.abgewiesen)+BigInt(werte.offen));
 // Rohgrund bleibt im Rückhalt/Checkpoint; nur der öffentliche Fehlercode wird normalisiert.
 const kandidat=werte.grund==='datei_zu_gross'?'zu_gross':werte.grund;
 const fehler=kandidat===null?null:REVERSE_FEHLERCODES.find(code=>code===kandidat)??'werkzeug_fehler';
 const ausgabe=e.reverseId+'/entpackt/m'+e.mediumId+'/'+e.jobId.toLowerCase();
 const alte=(await pool.query("SELECT id::text FROM reverse_schichten WHERE medium_id=$1 AND datei_id IS NULL AND schicht='E' AND aktuell AND fingerabdruck<>$2",[e.mediumId,f.fingerabdruck])).rows;
 for(const row of alte)await eMutation(pool,e,'UPDATE reverse_schichten SET aktuell=false WHERE id=$1 AND medium_id=$2',[row.id,e.mediumId]);
 await eMutation(pool,e,`INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,aktuell,status,fehlercode,werkzeug,funktionen_gesamt,funktionen_fertig,ausgabe_key,auftrag_id,gestartet_at,beendet_at)
  VALUES($1,'E',$2,true,$3,$4,'reverse-E',$5,$6,$7,$8,clock_timestamp(),clock_timestamp())
  ON CONFLICT(medium_id,schicht,fingerabdruck) WHERE datei_id IS NULL DO UPDATE SET aktuell=true,status=EXCLUDED.status,fehlercode=EXCLUDED.fehlercode,
  funktionen_gesamt=EXCLUDED.funktionen_gesamt,funktionen_fertig=EXCLUDED.funktionen_fertig,ausgabe_key=EXCLUDED.ausgabe_key,auftrag_id=EXCLUDED.auftrag_id,beendet_at=EXCLUDED.beendet_at`,
  [e.mediumId,f.fingerabdruck,status,fehler,anzeige(sum),anzeige(werte.dateien),ausgabe,f.id]);
 await eCheckpoint(pool,e,{abschluss:{...werte,rueckhalt:undefined},...(werte.rueckhalt?{rueckhalt:werte.rueckhalt}:{}),
  zaehler_int32_gekappt:BigInt(sum)>2147483647n});
 await eMutation(pool,e,"UPDATE reverse_auftraege SET status=$2,fehlercode=$3,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1 AND eintrag_id=$4",
  [f.id,status,fehler,e.reverseId]);
 await pool.query("SELECT pg_notify('synapse_reverse_changed',$1)",[e.reverseId]);
 // Bestehender T94-Dienst, nach sichtbarer E-Schicht, weiterhin eigene begrenzte TXs.
 const {zieheReverseAssetsNach}=await import('./reverse-asset-registrierung.js');
 await zieheReverseAssetsNach(pool,{eintrag_id:e.reverseId,medium_id:e.mediumId,einstellungen:e.einstellungen,
  pruefeLease:db=>e.pruefeLease(db as PoolClient)});
}
/** Neues eigenes Metadatenjournal; bei Wiederholung wird nur die identische Jobbindung akzeptiert. */
export async function eRetentionsJournal(root:string,arbeit:string,e:Pick<EKontext,'jobId'|'reverseId'|'mediumId'>,grund:string,recordBytes:number){
 const beleg=await eArbeitsBeleg(root,arbeit,grund);
 if(beleg.fehler)return beleg;
 const name='.e-retention.json',ziel=path.join(arbeit,name),bindung={job_id:e.jobId,eintrag_id:e.reverseId,medium_id:e.mediumId};
 if(await eDateiExists(ziel)){
  const h=await fs.open(ziel,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await h.stat();if(!st.isFile()||st.nlink!==1||st.size>recordBytes)throw new Error('reverse_e_retention_beleg');
   const alt=JSON.parse(await h.readFile('utf8'));if(JSON.stringify(alt.bindung)!==JSON.stringify(bindung))throw new Error('reverse_e_retention_bindung');}
  finally{await h.close();}
  return beleg;
 }
 const raw=JSON.stringify({version:1,bindung,grund});
 if(Buffer.byteLength(raw)>recordBytes)throw new Error('reverse_e_retention_record');
 const tmp=path.join(arbeit,'.e-retention-'+randomUUID());
 const h=await fs.open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await h.writeFile(raw);await h.sync();}finally{await h.close();}
 await fs.rename(tmp,ziel);
 const d=await fs.open(arbeit,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await d.sync();}finally{await d.close();}
 return {...beleg,bytes:beleg.bytes===null?null:String(BigInt(beleg.bytes)+BigInt(Buffer.byteLength(raw)))};
}
