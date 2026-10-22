/** P18-T42 Teil A: interne Persistenz, keine Tool-Aktionen/Jobs/Byte-Ausführung.
 * Transport-Rechte und Paketsnapshot/Freigabe folgen in Teil D; hier entstehen nur Entwürfe.
 * Projektquellen werden ausschließlich LESEND anhand exakter files-Versionen geprüft.
 * Keine Quellbytes in Reverse-Tabellen; keine Projekte, Dateien oder Assets anlegen. */
import {Pool,type PoolClient,type Client} from 'pg';
import {getPool} from '../db/client.js';
import {leseReverseEinstellwerte,leseReverseProduktSchalter,reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {pruefeReverseLeserManifest,reverseLeserDezimal,reverseLeserPfad,reverseLeserHash,reverseLeserKanonisch,ReverseLeserFehler,
 type ReverseLeserQuelle,type ReverseLeserQuellbeleg,type ReverseLeserManifest} from './reverse-leser-vertrag.js';
export type ReverseLeserDb=Pool|PoolClient|Client;
type QueryDb=Pick<PoolClient,'query'>;
export interface ReverseLeserRevision {
 id:string;name:string;version:string;schnittstelle_version:1;runtime:'python3';manifest:ReverseLeserManifest;
 manifest_sha256:string;code_sha256:string;paket_sha256:string;quell_bytes:string;
 quelle:{project:string;manifest:ReverseLeserQuellbeleg;dateien:ReverseLeserQuellbeleg[]};
 registriert_von:string;registriert_at:Date;status:'entwurf'|'aktiv'|'deaktiviert'|'ersetzt';storage_key:string|null;
}
function fail(code:string):never {throw new ReverseLeserFehler(code);}
function text(v:unknown,s:ReverseEinstellSnapshot):string {
 if(typeof v!=='string'||!v.trim()||v.length>reverseZahl(s,'parameter_text_zeichen')||/[\x00-\x1f\x7f]/.test(v))fail('leser_text_ungueltig');
 return v;
}
/** Keine connect()-Duck-Typisierung: gehaltene Clients bleiben im Aufrufer-Kontext. */
async function transaktion<T>(db:ReverseLeserDb,body:(c:QueryDb)=>Promise<T>):Promise<T>{
 if(!(db instanceof Pool))return body(db);
 const c=await db.connect();
 try{await c.query('BEGIN');const r=await body(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}
 finally{c.release();}
}
const SPALTEN=`l.id,l.name,l.version,l.schnittstelle_version,l.runtime,l.manifest,l.manifest_sha256,l.code_sha256,
 l.paket_sha256,l.quelle,l.quell_bytes::text,l.registriert_von,l.registriert_at,z.status,z.storage_key`;
/** Einzige Leser-Freigabelesestelle; reine Diagnose, keine Nebenwirkung bei AUS. */
export async function leseReverseLeserSchalter(db:ReverseLeserDb=getPool()){
 return leseReverseProduktSchalter('reverse_leser',null,db);
}
/** Globaler Nachzug-Produktstandard AUS, unabhängig von Registrierung und Vorschau. */
export async function leseReverseLeserNachzugSchalter(db:ReverseLeserDb=getPool()){
 return leseReverseProduktSchalter('reverse_leser_nachzug',null,db);
}
async function einstellungen(db:QueryDb){
 const s=await leseReverseEinstellwerte({},db);
 if(s.letzter_fehler)fail(s.letzter_fehler);
 return s;
}
/** Autorisierte Quelle übergeben (Teil D prüft Rechte); keine frei behaupteten Code-/Manifest-Hashes akzeptieren.
 * manifest.dateien sind relativ zum Manifestordner, versionsgebunden; alle anderen Dateien bleiben unerreichbar.
 * Ein identisches Retry liefert die alte Revision. Gleicher Name+Version mit anderem Inhalt/Herkunft ist ein Konflikt.
 * Entwurf ist auch bei Produkt AUS erlaubt; KEINE Freigabe/Materialisierung/Nachzug in Teil A. */
export async function registriereReverseLeserEntwurf(
 db:ReverseLeserDb,e:{quelle:ReverseLeserQuelle;registriert_von:string},
):Promise<ReverseLeserRevision>{
 return transaktion(db,async c=>{
  const s=await einstellungen(c),q=e?.quelle;
  if(!q||!Array.isArray(q.dateien))fail('leser_quelle_ungueltig');
  const project=text(q.project,s),von=text(e.registriert_von,s),manifestPfad=reverseLeserPfad(q.manifest_pfad,s);
  const manifestId=reverseLeserDezimal(q.manifest_version_id,true);
  const base=manifestPfad.includes('/')?manifestPfad.slice(0,manifestPfad.lastIndexOf('/')+1):'';
  let bytes=0n;const paketMax=reverseBigInt(s,'leser_paket_bytes');
  async function quelle(pfad:string,versionId:string){
   const rest=paketMax-bytes;
   const r=await c.query({text:`SELECT id::text,content_hash,octet_length(content)::text AS bytes,
    CASE WHEN octet_length(content)<=$4::bigint THEN content ELSE NULL END AS content
    FROM file_versions WHERE id=$1::bigint AND project=$2 AND file_path=$3`,
    values:[versionId,project,pfad,String(rest)],query_timeout:reverseZahl(s,'leser_statement_timeout_ms')} as import('pg').QueryConfig);
   const row=r.rows[0];
   if(!row)fail('leser_quellversion_nicht_gefunden');
   bytes+=BigInt(row.bytes);
   if(bytes>paketMax||typeof row.content!=='string')fail('leser_paket_zu_gross');
   const sha=reverseLeserHash(row.content);
   if(sha!==row.content_hash)fail('leser_quellhash_widerspruch');
   return {content:row.content as string,beleg:{pfad,version_id:versionId,sha256:sha,bytes:String(row.bytes)}};
  }
  const mf=await quelle(manifestPfad,manifestId);
  let roh:unknown;try{roh=JSON.parse(mf.content);}catch{fail('leser_manifest_json_ungueltig');}
  const manifest=pruefeReverseLeserManifest(roh,s),zuordnung=new Map<string,string>();
  for(const d of q.dateien){
   const pfad=reverseLeserPfad(d?.pfad,s),id=reverseLeserDezimal(d?.version_id,true);
   if(zuordnung.has(pfad))fail('leser_quelle_doppelt');zuordnung.set(pfad,id);
  }
  if(zuordnung.size!==manifest.dateien.length||manifest.dateien.some(p=>!zuordnung.has(p)))fail('leser_quelle_unvollstaendig');
  const belege:ReverseLeserQuellbeleg[]=[];
  for(const pfad of manifest.dateien){
   const voll=reverseLeserPfad(base+pfad,s);
   if(voll===manifestPfad)fail('leser_manifest_als_code');
   const v=await quelle(voll,zuordnung.get(pfad)!);
   belege.push({...v.beleg,pfad});
  }
  const manifestSha=reverseLeserHash(reverseLeserKanonisch(manifest));
  const codeSha=reverseLeserHash(reverseLeserKanonisch(belege.map(({pfad,sha256,bytes})=>({pfad,sha256,bytes}))));
  // Paketidentität = kanonischer Inhaltsindex, kein behaupteter Hash eines noch nicht gebauten Archivs.
  const paketSha=reverseLeserHash(reverseLeserKanonisch({schnittstelle_version:1,manifest_sha256:manifestSha,code_sha256:codeSha}));
  const herkunft={project,manifest:mf.beleg,dateien:belege};
  const id=reverseLeserHash(reverseLeserKanonisch({paket_sha256:paketSha,quelle:herkunft}));
  const params=[id,manifest.name,manifest.version,manifest.schnittstelle_version,manifest.runtime,
   JSON.stringify(manifest),manifestSha,codeSha,paketSha,JSON.stringify(herkunft),String(bytes),von];
  // Metadaten + Zustandszeile begrenzen; Quelltext wird nicht geschrieben. Keine stille Kürzung.
  const txBytes=Buffer.byteLength(JSON.stringify(params))+Buffer.byteLength(JSON.stringify([id,manifest.name]));
  if(BigInt(txBytes)>reverseBigInt(s,'materialisierung_tx_bytes')||reverseZahl(s,'e_uebernahme_block_zeilen')<2)fail('leser_registry_tx_zu_gross');
  await c.query(`INSERT INTO reverse_leser(id,name,version,schnittstelle_version,runtime,manifest,manifest_sha256,
   code_sha256,paket_sha256,quelle,quell_bytes,registriert_von) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::bigint,$12)
   ON CONFLICT(name,version) DO NOTHING`,params);
  const alt=(await c.query('SELECT id FROM reverse_leser WHERE name=$1 AND version=$2',[manifest.name,manifest.version])).rows[0];
  if(alt?.id!==id)fail('leser_version_konflikt');
  await c.query("INSERT INTO reverse_leser_zustaende(leser_id,name) VALUES($1,$2) ON CONFLICT(leser_id) DO NOTHING",[id,manifest.name]);
  const row=(await c.query(`SELECT ${SPALTEN} FROM reverse_leser l JOIN reverse_leser_zustaende z ON z.leser_id=l.id WHERE l.id=$1`,[id])).rows[0];
  if(!row)fail('leser_revision_nicht_gespeichert');
  return row as ReverseLeserRevision;
 });
}
export async function leseReverseLeserRevision(db:ReverseLeserDb,id:string):Promise<ReverseLeserRevision|null>{
 if(!/^[0-9a-f]{64}$/.test(id))fail('leser_revision_ungueltig');
 const s=await einstellungen(db);
 const r=await db.query({text:`SELECT ${SPALTEN} FROM reverse_leser l JOIN reverse_leser_zustaende z ON z.leser_id=l.id WHERE l.id=$1`,
  values:[id],query_timeout:reverseZahl(s,'leser_statement_timeout_ms')} as import('pg').QueryConfig);
 return r.rows[0] as ReverseLeserRevision??null;
}
/** Keyset-Seite: kein Gesamtlimit und kein globaler Lauf-/Eintragsinhalt. */
export async function listeReverseLeserRevisionen(db:ReverseLeserDb,o:{nach?:string;limit?:number}={}){
 const s=await einstellungen(db),limit=o.limit??reverseZahl(s,'seiten_limit');
 if(!Number.isSafeInteger(limit)||limit<1||limit>reverseZahl(s,'max_limit'))fail('leser_limit_ungueltig');
 if(o.nach!==undefined&&!/^[0-9a-f]{64}$/.test(o.nach))fail('leser_cursor_ungueltig');
 const r=await db.query({text:`SELECT l.id,l.name,l.version,l.runtime,l.code_sha256,l.paket_sha256,
  l.quell_bytes::text,z.status,l.registriert_at FROM reverse_leser l JOIN reverse_leser_zustaende z ON z.leser_id=l.id
  WHERE ($1::text IS NULL OR l.id>$1) ORDER BY l.id LIMIT $2`,
  values:[o.nach??null,limit+1],query_timeout:reverseZahl(s,'leser_statement_timeout_ms')} as import('pg').QueryConfig);
 const items=r.rows.slice(0,limit);
 return {items,naechster_cursor:r.rows.length>limit?String(items[items.length-1].id):null};
}
