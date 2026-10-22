/** P18-T42 Teil A: interne Persistenz, keine Tool-Aktionen/Jobs/Byte-Ausführung.
 * Transport-Rechte und Paketsnapshot/Freigabe folgen in Teil D; hier entstehen nur Entwürfe.
 * Projektquellen werden ausschließlich LESEND anhand exakter files-Versionen geprüft.
 * Keine Quellbytes in Reverse-Tabellen; keine Projekte, Dateien oder Assets anlegen. */
import {Pool,type PoolClient,type Client} from 'pg';
import {getPool} from '../db/client.js';
import {leseReverseEinstellwerte,leseReverseProduktSchalter,reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {pruefeReverseLeserManifest,reverseLeserDezimal,reverseLeserPfad,reverseLeserHash,reverseLeserKanonisch,ReverseLeserFehler,
 type ReverseLeserQuelle,type ReverseLeserQuellbeleg,type ReverseLeserManifest} from './reverse-leser-vertrag.js';
import {loeseReverseLeserNachher,mitReverseNachherLesesicht} from './reverse-leser-nachher.js';
export type ReverseLeserDb=Pool|PoolClient|Client;
type QueryDb=Pick<PoolClient,'query'>;
export interface ReverseLeserRevision {
 id:string;name:string;version:string;schnittstelle_version:1;runtime:'python3';manifest:ReverseLeserManifest;
 manifest_sha256:string;code_sha256:string;paket_sha256:string;quell_bytes:string;
 quelle:{project:string;manifest:ReverseLeserQuellbeleg;dateien:ReverseLeserQuellbeleg[];
  quellvertrag?:'files-nachher-v1';stand?:'nachher';anfrage?:ReverseLeserQuelle};
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
/** Reiner Pflichtvertrag; keine SQL-/Datei-Nebenwirkung. Relative Codedateien bleiben im Manifestordner. */
export function pruefeReverseLeserQuelle(roh:unknown,s:ReverseEinstellSnapshot):ReverseLeserQuelle{
 const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 if(!obj(roh)||Object.keys(roh).sort().join()!=='dateien,manifest_bytes,manifest_pfad,manifest_sha256,manifest_version_id,project,stand'
  ||roh.stand!=='nachher'||!Array.isArray(roh.dateien))fail('leser_quelle_ungueltig');
 const project=text(roh.project,s),manifest_pfad=reverseLeserPfad(roh.manifest_pfad,s),manifest_version_id=reverseLeserDezimal(roh.manifest_version_id,true);
 const erwartung=(sha:unknown,n:unknown,positiv=false)=>{
  if(typeof sha!=='string'||!(/^[a-f0-9]{64}$/).test(sha))fail('leser_quelle_ungueltig');
  const bytes=reverseLeserDezimal(n,positiv);return {sha256:sha,bytes};
 };
 const mf=erwartung(roh.manifest_sha256,roh.manifest_bytes,true),base=manifest_pfad.replace(/[^/]+$/,'');
 const gesehen=new Set<string>();let bytes=BigInt(mf.bytes);
 const dateien=roh.dateien.map(d=>{
  if(!obj(d)||Object.keys(d).sort().join()!=='bytes,pfad,sha256,version_id')fail('leser_quelle_ungueltig');
  const pfad=reverseLeserPfad(d.pfad,s),version_id=reverseLeserDezimal(d.version_id,true),e=erwartung(d.sha256,d.bytes);
  if(gesehen.has(pfad))fail('leser_quelle_doppelt');gesehen.add(pfad);
  if(reverseLeserPfad(base+pfad,s)===manifest_pfad)fail('leser_manifest_als_code');
  bytes+=BigInt(e.bytes);return {pfad,version_id,...e};
 }).sort((a,b)=>a.pfad<b.pfad?-1:a.pfad>b.pfad?1:0);
 if(bytes>reverseBigInt(s,'leser_paket_bytes'))fail('leser_paket_zu_gross');
 if(Buffer.byteLength(reverseLeserKanonisch(roh))>reverseZahl(s,'parameter_text_zeichen'))fail('leser_quelle_zu_gross');
 return {project,stand:'nachher',manifest_pfad,manifest_version_id,manifest_sha256:mf.sha256,manifest_bytes:mf.bytes,dateien};
}
/** Neue ID bindet ausschliesslich logische Nachher-Erwartungen, nie dynamische Lesestellen. */
function nachherRevisionId(q:ReverseLeserQuelle){return reverseLeserHash(reverseLeserKanonisch({quellvertrag:'files-nachher-v1',anfrage:q}));}
/** Registrierung schreibt nur Entwurf/Beleg. Kein Paket, Aktivzeiger oder Auftrag. */
export async function registriereReverseLeserEntwurf(
 db:ReverseLeserDb,e:{quelle:ReverseLeserQuelle;registriert_von:string},
):Promise<ReverseLeserRevision>{
 const s=await einstellungen(db),q=pruefeReverseLeserQuelle(e?.quelle,s),von=text(e.registriert_von,s),id=nachherRevisionId(q);
 const alt=await leseReverseLeserRevision(db,id);
 if(alt){
  if(alt.quelle.quellvertrag!=='files-nachher-v1'||reverseLeserKanonisch(alt.quelle.anfrage)!==reverseLeserKanonisch(q))fail('leser_version_konflikt');
  return alt; // bestaetigter Beleg bleibt gueltig, auch wenn die Projektquelle inzwischen fehlt
 }
 const base=q.manifest_pfad.replace(/[^/]+$/,''),erlaubt=new Set([q.manifest_pfad,...q.dateien.map(d=>base+d.pfad)]);
 const v=await mitReverseNachherLesesicht(db,s,async c=>{
  const mf=await loeseReverseLeserNachher(c,q.project,{pfad:q.manifest_pfad,version_id:q.manifest_version_id,sha256:q.manifest_sha256,bytes:q.manifest_bytes},erlaubt,reverseBigInt(s,'leser_paket_bytes'),s);
  let roh:unknown;try{roh=JSON.parse(mf.content);}catch{fail('leser_manifest_json_ungueltig');}
  const manifest=pruefeReverseLeserManifest(roh,s),zuordnung=new Map(q.dateien.map(d=>[d.pfad,d]));
  if(zuordnung.size!==manifest.dateien.length||manifest.dateien.some(p=>!zuordnung.has(p)))fail('leser_quelle_unvollstaendig');
  let bytes=BigInt(mf.beleg.bytes);const belege:ReverseLeserQuellbeleg[]=[];
  for(const pfad of manifest.dateien){
   const d=zuordnung.get(pfad)!;
   const source=await loeseReverseLeserNachher(c,q.project,{...d,pfad:base+pfad},erlaubt,reverseBigInt(s,'leser_paket_bytes')-bytes,s);
   belege.push({...source.beleg,pfad});bytes+=BigInt(source.beleg.bytes);
  }
  const manifestSha=reverseLeserHash(reverseLeserKanonisch(manifest));
  const codeSha=reverseLeserHash(reverseLeserKanonisch(belege.map(({pfad,sha256,bytes})=>({pfad,sha256,bytes}))));
  const paketSha=reverseLeserHash(reverseLeserKanonisch({schnittstelle_version:1,manifest_sha256:manifestSha,code_sha256:codeSha}));
  return {manifest,manifestSha,codeSha,paketSha,bytes,herkunft:{project:q.project,quellvertrag:'files-nachher-v1' as const,stand:q.stand,anfrage:q,manifest:mf.beleg,dateien:belege}};
 });
 return transaktion(db,async c=>{
  if((await einstellungen(c)).revision!==s.revision)fail('leser_einstellungen_geaendert');
  const params=[id,v.manifest.name,v.manifest.version,v.manifest.schnittstelle_version,v.manifest.runtime,
   JSON.stringify(v.manifest),v.manifestSha,v.codeSha,v.paketSha,JSON.stringify(v.herkunft),String(v.bytes),von];
  const txBytes=Buffer.byteLength(JSON.stringify(params))+Buffer.byteLength(JSON.stringify([id,v.manifest.name]));
  if(BigInt(txBytes)>reverseBigInt(s,'materialisierung_tx_bytes')||reverseZahl(s,'e_uebernahme_block_zeilen')<2)fail('leser_registry_tx_zu_gross');
  await c.query(`INSERT INTO reverse_leser(id,name,version,schnittstelle_version,runtime,manifest,manifest_sha256,
   code_sha256,paket_sha256,quelle,quell_bytes,registriert_von) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::bigint,$12)
   ON CONFLICT(name,version) DO NOTHING`,params);
  const alt=(await c.query('SELECT id FROM reverse_leser WHERE name=$1 AND version=$2',[v.manifest.name,v.manifest.version])).rows[0];
  if(alt?.id!==id)fail('leser_version_konflikt');
  await c.query("INSERT INTO reverse_leser_zustaende(leser_id,name) VALUES($1,$2) ON CONFLICT(leser_id) DO NOTHING",[id,v.manifest.name]);
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
