/** P18-T102: API-only Publisher und PG-Pins der generischen Leser-Laufzeit.
 * Immutable Share-Artefakte, keine Python-/Docker-Ausführung und keine Projektwrites. */
import {Pool,type PoolClient} from 'pg';
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,rename,chmod,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {leseReverseEinstellwerte,leseReverseProduktSchalter,reverseBigInt,reverseZahl,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {reverseLeserHash,reverseLeserKanonisch} from './reverse-leser-vertrag.js';
import {reverseLeserRoot,reverseLeserDateipfad,pruefeReverseLeserDatei,reverseLeserTxBudget} from './reverse-leser-materialisierung.js';
import {LESER_RUNTIME_DATEIEN,LESER_RUNTIME_VERTRAG,runtimeFail,pruefeLeserRuntimeImage,pruefeLeserRuntimePin,
 pruefeLeserRuntimeIndex,pruefeLeserRuntimeQuelle,leserRuntimePin,
 type LeserRuntimeImage,type LeserRuntimeQuelle,type LeserRuntimeIndex,type LeserRuntimePin} from './reverse-leser-runtime-vertrag.js';
type Db=Pick<PoolClient,'query'>;
type Row=Record<string,any>;
export interface RuntimeSchreibauftrag {
 akteur:string;grund:string;schluessel:string;image:LeserRuntimeImage;
 pruefeRecht:()=>Promise<void>;root?:string;
}
export interface RuntimeDatensatz {
 pin:string;vertrag:string;inhaltsindex:LeserRuntimeIndex;storage_key:string;quelle:unknown;
 bytes:string;erstellt_von:string;erstellt_at:Date;
}
export const leseLeserRuntimeVerwaltung=(db:Db)=>leseReverseProduktSchalter('reverse_leser_runtime_verwaltung',null,db);
const hash=(v:unknown)=>reverseLeserHash(reverseLeserKanonisch(v));
async function snapshot(db:Db){
 const s=await leseReverseEinstellwerte({},db);if(s.letzter_fehler)runtimeFail(s.letzter_fehler);return s;
}
export async function leseLeserRuntime(db:Db,pin:string):Promise<RuntimeDatensatz|null>{
 pruefeLeserRuntimePin(pin);
 return (await db.query<RuntimeDatensatz>('SELECT pin,vertrag,inhaltsindex,storage_key,quelle,bytes::text,erstellt_von,erstellt_at FROM reverse_leser_runtimes WHERE pin=$1',[pin])).rows[0]??null;
}
export async function leseLeserRuntimeStandard(db:Db,image:LeserRuntimeImage|undefined){
 const i=pruefeLeserRuntimeImage(image);
 const row=(await db.query("SELECT id::text,pin,phase,akteur,grund,created_at FROM reverse_leser_runtime_ereignisse WHERE image_digest=$1 AND phase IN('aktiviert','deaktiviert') ORDER BY sequenz DESC LIMIT 1",[i.digest])).rows[0];
 return {quelle:row?'registry' as const:'kein_pin' as const,revision:row?.id??'0',runtime_sha256:row?.pin??null,
  runtime_image_digest:i.digest,image:i.image,ereignis:row??null};
}
/** Nur neue Laeufe/Scans waehlen den Standard. Gehaltene Clients bleiben im eigenen Kontext. */
export async function waehleLeserRuntimePin(db:Db,image:LeserRuntimeImage|undefined):Promise<LeserRuntimePin>{
 const p=await leseLeserRuntimeStandard(db,image);
 if(!p.runtime_sha256)runtimeFail('leser_laufzeit_pin_fehlt');
 const pin={runtime_sha256:String(p.runtime_sha256),runtime_image_digest:p.runtime_image_digest};
 await pruefeLeserRuntimeBindung(db,pin,p.runtime_image_digest);return pin;
}
export async function pruefeLeserRuntimeBindung(db:Db,p:Partial<LeserRuntimePin>|null|undefined,imageDigest?:string){
 if(!p?.runtime_sha256||!p.runtime_image_digest)runtimeFail('leser_laufzeit_pin_fehlt');
 pruefeLeserRuntimePin(p.runtime_sha256);
 if(imageDigest!==undefined&&imageDigest!==p.runtime_image_digest)runtimeFail('leser_runtime_image_geaendert');
 const r=await db.query("SELECT 1 FROM reverse_leser_runtime_images i JOIN reverse_leser_runtimes r ON r.pin=i.pin WHERE i.pin=$1 AND i.image_digest=$2 AND r.vertrag=$3",
  [p.runtime_sha256,p.runtime_image_digest,LESER_RUNTIME_VERTRAG]);
 if(!r.rows.length)runtimeFail('leser_runtime_pin_unbekannt');
}
async function syncOrdner(p:string,mode?:number){const f=await open(p,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(mode!==undefined)await f.chmod(mode);await f.sync();}finally{await f.close();}}
/** Ordnerarbeit verwendet stets den expliziten Aufrufer-Snapshot; kein zweiter globaler Grenzleser. */
async function runtimeOrdner(root:string,key:string,s:ReverseEinstellSnapshot,mode=0o755){
 const probe=await reverseLeserDateipfad(root,key+'/.runtime-pfadprobe',s,true),dir=path.dirname(probe);
 const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||await realpath(dir)!==dir)runtimeFail('leser_runtime_pfad');
 // Nur neue eigene Verzeichnisse bekommen Schreibrechte, niemals vorhandene Runtime-Snapshots.
 if(mode===0o700&&st.mode&0o077)await chmod(dir,mode);
 return dir;
}
/** Prueft exakt den gespeicherten Baum vor Aktivierung/Mount; keine Quelle wird erneut ausgefuehrt. */
export async function pruefeLeserRuntimeSnapshot(db:Db,p:LeserRuntimePin,s:ReverseEinstellSnapshot,root=reverseLeserRoot(),imageDigest?:string){
 await pruefeLeserRuntimeBindung(db,p,imageDigest);
 const r=await leseLeserRuntime(db,p.runtime_sha256);if(!r)runtimeFail('leser_runtime_pin_unbekannt');
 return pruefeRuntimeBaum(root,r.pin,pruefeLeserRuntimeIndex(r.inhaltsindex,s),s);
}
async function pruefeRuntimeBaum(root:string,pin:string,index:LeserRuntimeIndex,s:ReverseEinstellSnapshot){
 if(leserRuntimePin(index)!==pin)runtimeFail('leser_laufzeit_hash');
 const key='.intern/leser-runtime/'+pin,bytes=Buffer.byteLength(reverseLeserKanonisch(index));
 const dir=path.join(root,key),st=await lstat(dir);
 if(!st.isDirectory()||st.isSymbolicLink())runtimeFail('leser_runtime_pfad');
 pruefeRuntimeModus(st.mode,true);
 await reverseLeserDateipfad(root,key+'/index.json',s);
 const entries=await readdir(dir,{withFileTypes:true}),erwartet=new Set(['index.json',...index.dateien.map(x=>x.pfad)]);
 if(entries.length!==erwartet.size||entries.some(x=>!erwartet.has(x.name)||!x.isFile()||x.isSymbolicLink()))runtimeFail('leser_laufzeit_zusatzdatei');
 for(const b of [{pfad:'index.json',sha256:pin,bytes:String(bytes)},...index.dateien]){
  const p=await reverseLeserDateipfad(root,key+'/'+b.pfad,s),stat=await lstat(p);
  pruefeRuntimeModus(stat.mode,false);
  await pruefeReverseLeserDatei(root,key+'/'+b.pfad,b.sha256,b.bytes,s);
 }
 return {root:dir,pin,index,bytes:String(index.dateien.reduce((n,b)=>n+BigInt(b.bytes),BigInt(bytes)))};
}
/** V1 garantiert Other-Read/-Search fuer UID 65532, unabhaengig von API-UID und Gruppen. */
function pruefeRuntimeModus(mode:number,ordner:boolean){
 if((mode&0o222)!==0)runtimeFail('leser_runtime_schreibbar');
 const other=ordner?0o005:0o004;
 if((mode&other)!==other)runtimeFail('leser_runtime_container_nicht_lesbar');
 if((mode&0o7777)!==(ordner?0o555:0o444))runtimeFail('leser_runtime_modus_ungueltig');
}
async function freigabe(c:Db,s:ReverseEinstellSnapshot,o:RuntimeSchreibauftrag){
 await o.pruefeRecht();
 const stand=await leseLeserRuntimeVerwaltung(c);
 if(!stand.aktiv||stand.letzter_fehler)runtimeFail('leser_runtime_verwaltung_aus');
 if((await snapshot(c)).revision!==s.revision)runtimeFail('leser_einstellungen_geaendert');
}
async function mutation<T>(c:PoolClient,s:ReverseEinstellSnapshot,o:RuntimeSchreibauftrag,params:unknown,body:()=>Promise<T>){
 reverseLeserTxBudget(s,1,params); // jede Fach-/Auditphase schreibt genau eine Zeile
 try{
  await c.query('BEGIN');await c.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
   [String(reverseZahl(s,'leser_statement_timeout_ms')),String(reverseZahl(s,'leser_lock_timeout_ms'))]);
  await freigabe(c,s,o);const r=await body();await c.query('COMMIT');return r;
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}
}
function auftrag(o:RuntimeSchreibauftrag,art:string,payload:unknown){
 pruefeLeserRuntimeImage(o.image);
 if(!o.akteur||typeof o.grund!=='string'||o.grund.trim().length<5||typeof o.schluessel!=='string'||!o.schluessel)runtimeFail('leser_runtime_auftrag_ungueltig');
 return {key:hash([o.akteur,art,o.schluessel]),payload:hash(payload)};
}
async function requestPruefen(c:Db,k:{key:string;payload:string}){
 const rows=(await c.query('SELECT payload_hash FROM reverse_leser_runtime_ereignisse WHERE request_key=$1 LIMIT 1',[k.key])).rows;
 if(rows.length&&rows[0].payload_hash!==k.payload)runtimeFail('leser_runtime_idempotenz_konflikt');
}
async function ereignis(c:PoolClient,s:ReverseEinstellSnapshot,o:RuntimeSchreibauftrag,k:{key:string;payload:string},
 phase:string,pin:string|null,basis:string|null,details:Row={}){
 const id=randomUUID(),params=[id,k.key,k.payload,phase,o.image.digest,pin,basis,o.akteur,o.grund,details];
 return mutation(c,s,o,params,async()=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['leser-runtime-request:'+k.key]);
  await requestPruefen(c,k);
  await c.query("INSERT INTO reverse_leser_runtime_ereignisse(id,request_key,payload_hash,phase,image_digest,pin,basis_revision,akteur,grund,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(request_key,phase) DO NOTHING",params);
  return (await c.query('SELECT id::text,phase,pin FROM reverse_leser_runtime_ereignisse WHERE request_key=$1 AND phase=$2',[k.key,phase])).rows[0];
 });
}
/** Ausschliesslich Nachher: erster fremder Nachfolgerbatch, sonst der aktuelle PG-Stand.
 * Erwartete Bytes/Hash sind Pflicht im Request; keine Diff-/Dateisystem-Rekonstruktion. */
async function quellen(c:PoolClient,q:LeserRuntimeQuelle,s:ReverseEinstellSnapshot){
 const daten=new Map<string,string>(),belege:Row[]=[];let bytes=0n;
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(reverseZahl(s,'leser_statement_timeout_ms'))]);
  for(const d of q.dateien){
   const pfad='docker/synapse-reverse/'+d.pfad;
   const row=(await c.query(`SELECT v.id::text AS version_id,v.batch_id::text AS anker_batch_id,v.edit_action AS anker_aktion,
    n.id::text AS snapshot_version_id,n.batch_id::text AS snapshot_batch_id,
    CASE WHEN n.id IS NOT NULL THEN 'naechste_version' ELSE 'aktueller_stand' END AS gelesen_aus,
    CASE WHEN n.id IS NULL THEN cf.id::text END AS code_file_id,
    CASE WHEN n.id IS NULL THEN cf.updated_at::text END AS code_updated_at,
    CASE WHEN n.id IS NOT NULL THEN n.content_hash ELSE cf.content_hash END AS content_hash,
    octet_length(CASE WHEN n.id IS NOT NULL THEN n.content ELSE cf.content END)::text AS bytes,
    CASE WHEN octet_length(CASE WHEN n.id IS NOT NULL THEN n.content ELSE cf.content END)<=$4::bigint
     THEN CASE WHEN n.id IS NOT NULL THEN n.content ELSE cf.content END END AS content,
    EXISTS(SELECT 1 FROM file_versions z WHERE n.batch_id IS NOT NULL AND z.project=v.project AND z.file_path=v.file_path
     AND z.batch_id=n.batch_id AND z.id>v.id AND z.content_hash IS DISTINCT FROM n.content_hash) AS batch_konflikt
    FROM file_versions v
    LEFT JOIN LATERAL(SELECT id,batch_id,content,content_hash FROM file_versions n
     WHERE n.project=v.project AND n.file_path=v.file_path AND n.id>v.id
      AND (v.batch_id IS NULL OR n.batch_id IS DISTINCT FROM v.batch_id) ORDER BY n.id LIMIT 1)n ON TRUE
    LEFT JOIN code_files cf ON n.id IS NULL AND cf.project=v.project AND cf.file_path=v.file_path AND cf.deleted_at IS NULL
    WHERE v.id=$1 AND v.project=$2 AND v.file_path=$3`,
    [d.version_id,q.project,pfad,String(reverseBigInt(s,'leser_paket_bytes')-bytes)])).rows[0];
   if(!row||row.anker_aktion?.startsWith('ignore_'))runtimeFail('leser_runtime_nachher_anker_fehlt');
   if(row.batch_konflikt)runtimeFail('leser_runtime_nachher_batch_konflikt');
   if(row.bytes==null)runtimeFail('leser_runtime_nachher_fehlt');
   if(typeof row.content!=='string')runtimeFail('leser_runtime_paket_zu_gross');
   const actualBytes=String(Buffer.byteLength(row.content)),actualHash=reverseLeserHash(row.content);
   if(actualBytes!==row.bytes||actualHash!==row.content_hash)runtimeFail('leser_runtime_quellhash');
   if(actualBytes!==d.bytes||actualHash!==d.sha256)runtimeFail('leser_runtime_nachher_geaendert');
   bytes+=BigInt(actualBytes);
   daten.set(d.pfad,row.content);
   belege.push({pfad:d.pfad,quell_pfad:pfad,version_id:d.version_id,anker_batch_id:row.anker_batch_id,anker_aktion:row.anker_aktion,
    gelesen_aus:row.gelesen_aus,snapshot_version_id:row.snapshot_version_id,snapshot_batch_id:row.snapshot_batch_id,
    code_file_id:row.code_file_id,code_updated_at:row.code_updated_at,sha256:actualHash,bytes:actualBytes});
  }
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}
 return {daten,quelle:{quellvertrag:'files-nachher-v1',project:q.project,stand:q.stand,dateien:belege}};
}
/** Nur eigene zuvor bestaetigte Aufloesung, nie ein dynamisches nachher-Metadatum. */
function quellbeleg(details:Row,q:LeserRuntimeQuelle,pin:string,s:ReverseEinstellSnapshot):Row{
 const quelle=details.quelle;
 if(details.erwarteter_pin!==pin||hash(details.anfrage)!==hash(q)||quelle?.quellvertrag!=='files-nachher-v1'
  ||quelle.project!==q.project||quelle.stand!==q.stand||!Array.isArray(quelle.dateien)||quelle.dateien.length!==q.dateien.length)runtimeFail('leser_runtime_quellbeleg_ungueltig');
 for(const [i,d] of q.dateien.entries()){
  const b=quelle.dateien[i];
  if(!b||b.pfad!==d.pfad||b.quell_pfad!=='docker/synapse-reverse/'+d.pfad||b.version_id!==d.version_id||b.sha256!==d.sha256||b.bytes!==d.bytes
   ||!['naechste_version','aktueller_stand'].includes(b.gelesen_aus)
   ||(b.gelesen_aus==='naechste_version'?!/^[1-9][0-9]*$/.test(b.snapshot_version_id??''):!b.code_file_id))runtimeFail('leser_runtime_quellbeleg_ungueltig');
 }
 reverseLeserTxBudget(s,1,details);return quelle;
}
async function schreibeSnapshot(root:string,request:string,pin:string,index:LeserRuntimeIndex,daten:Map<string,string>,s:ReverseEinstellSnapshot,vorPublikation:()=>Promise<void>){
 const parent=await runtimeOrdner(root,'.intern/leser-runtime',s);
 const target=path.join(parent,pin);
 try{await lstat(target);await pruefeRuntimeBaum(root,pin,index,s);return {vorhanden:true};}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 // Gleicher Parent: rename muss kein '..' im schon versiegelten RO-Ordner aendern.
 const key='.intern/leser-runtime/.bereitstellung-'+request+'-'+randomUUID();
 const stage=await runtimeOrdner(root,key,s,0o700);
 for(const [pfad,text] of [...daten,['index.json',reverseLeserKanonisch(index)] as [string,string]]){
  const p=await reverseLeserDateipfad(root,key+'/'+pfad,s,true),h=await open(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o444);
  try{await h.writeFile(text);await h.chmod(0o444);await h.sync();}finally{await h.close();}
  await pruefeReverseLeserDatei(root,key+'/'+pfad,reverseLeserHash(text),String(Buffer.byteLength(text)),s);
 }
 await syncOrdner(stage,0o555);
 // Session-Lock serialisiert alle API-Publisher; serviceeigener Parent hat keine fremden Writer.
 try{await lstat(target);runtimeFail('leser_runtime_ziel_belegt');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await vorPublikation();
 await rename(stage,target);await syncOrdner(parent);
 await pruefeRuntimeBaum(root,pin,index,s);return {vorhanden:false};
}
export async function stelleLeserRuntimeBereit(pool:Pool,roh:unknown,o:RuntimeSchreibauftrag,vorschau=false){
 if(!(pool instanceof Pool))runtimeFail('leser_runtime_pool_erforderlich');
 await o.pruefeRecht();const s=await snapshot(pool),q=pruefeLeserRuntimeQuelle(roh,s);
 const index=pruefeLeserRuntimeIndex({dateien:q.dateien.map(({pfad,sha256,bytes})=>({pfad,sha256,bytes}))},s),pin=leserRuntimePin(index);
 const k=auftrag(o,'bereitstellen',{quelle:q,image:o.image,grund:o.grund});
 const basis=(quelle:Row)=>({pin,index,quelle,image:o.image,vertrag:LESER_RUNTIME_VERTRAG,
  bytes:String(index.dateien.reduce((n,b)=>n+BigInt(b.bytes),BigInt(Buffer.byteLength(reverseLeserKanonisch(index)))))});
 const c=await pool.connect();let lock:string|null=null,kaputt=false;
 try{
  if(!vorschau)await freigabe(c,s,o);
  await requestPruefen(c,k); // geaenderter Payload scheitert vor jeder Quelle/Share-Schreibphase
  if(!vorschau){
   lock='leser-runtime:'+pin;
   if(!(await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok',[lock])).rows[0]?.ok){lock=null;runtimeFail('leser_runtime_bereitstellung_laeuft');}
   const fertig=(await c.query("SELECT pin,details FROM reverse_leser_runtime_ereignisse WHERE request_key=$1 AND phase='bereitgestellt'",[k.key])).rows[0];
   if(fertig){
    if(fertig.pin!==pin)runtimeFail('leser_runtime_quellbeleg_ungueltig');
    const quelle=quellbeleg(fertig.details,q,pin,s);
    await pruefeLeserRuntimeSnapshot(c,{runtime_sha256:pin,runtime_image_digest:o.image.digest},s,o.root,o.image.digest);
    await freigabe(c,s,o);
    return {status:'bereitgestellt',...basis(quelle),aktiviert:false,idempotent:true};
   }
  }
  let v:{daten:Map<string,string>;quelle:Row}|undefined;
  if(!vorschau){
   const begonnen=(await c.query("SELECT details FROM reverse_leser_runtime_ereignisse WHERE request_key=$1 AND phase='begonnen'",[k.key])).rows[0];
   if(begonnen){
    const quelle=quellbeleg(begonnen.details,q,pin,s);
    // Ein vollstaendiges Ziel plus eigener Aufloesungsbeleg ueberlebt Quelldatei-Aenderung/-Loeschung.
    try{await pruefeRuntimeBaum(o.root??reverseLeserRoot(),pin,index,s);v={daten:new Map(),quelle};}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   }
  }
  v??=await quellen(c,q,s);
  if(vorschau)return {status:'vorschau',...basis(v.quelle),aktiviert:false};
  const details={anfrage:q,quelle:v.quelle,erwarteter_pin:pin};
  await ereignis(c,s,o,k,'begonnen',null,null,details);
  await freigabe(c,s,o);
  let fs:{vorhanden:boolean};
  if(v.daten.size===0){
   await pruefeRuntimeBaum(o.root??reverseLeserRoot(),pin,index,s);await freigabe(c,s,o);fs={vorhanden:true};
  }else fs=await schreibeSnapshot(o.root??reverseLeserRoot(),k.key,pin,index,v.daten,s,()=>freigabe(c,s,o));
  const rp=[pin,LESER_RUNTIME_VERTRAG,index,'.intern/leser-runtime/'+pin,v.quelle,basis(v.quelle).bytes,o.akteur];
  await mutation(c,s,o,rp,()=>c.query("INSERT INTO reverse_leser_runtimes(pin,vertrag,inhaltsindex,storage_key,quelle,bytes,erstellt_von) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6::bigint,$7) ON CONFLICT(pin) DO NOTHING",rp));
  const saved=await leseLeserRuntime(c,pin);
  if(!saved||reverseLeserKanonisch(saved.inhaltsindex)!==reverseLeserKanonisch(index)||saved.storage_key!=='.intern/leser-runtime/'+pin||saved.bytes!==basis(v.quelle).bytes)runtimeFail('leser_runtime_registry_konflikt');
  const ip=[pin,o.image.digest,o.image.image,o.akteur];
  await mutation(c,s,o,ip,()=>c.query('INSERT INTO reverse_leser_runtime_images(pin,image_digest,image,erstellt_von) VALUES($1,$2,$3,$4) ON CONFLICT(pin,image_digest) DO NOTHING',ip));
  await pruefeLeserRuntimeSnapshot(c,{runtime_sha256:pin,runtime_image_digest:o.image.digest},s,o.root);
  await ereignis(c,s,o,k,'bereitgestellt',pin,null,{...details,share_verifiziert:true});
  return {status:'bereitgestellt',...basis(v.quelle),aktiviert:false,idempotent:fs.vorhanden};
 }catch(e){
  const code=(e as Error).message;
  if(lock)try{
   await ereignis(c,s,o,k,'fehler',null,null,{code:/^[a-zA-Z0-9_]+$/.test(code)?code:'leser_runtime_bereitstellung_fehler'});
  }catch{/* Kein Erfolg vortaeuschen, wenn Freigabe/Audit nicht mehr schreibbar ist. */}
  throw e;
 }finally{
  if(lock)try{await c.query('SELECT pg_advisory_unlock(hashtext($1))',[lock]);}catch{kaputt=true;}
  c.release(kaputt);
 }
}
export async function setzeLeserRuntimeStandard(pool:Pool,pin:string|null,basisRevision:string,o:RuntimeSchreibauftrag){
 if(!(pool instanceof Pool))runtimeFail('leser_runtime_pool_erforderlich');
 if(pin!==null)pruefeLeserRuntimePin(pin);
 await o.pruefeRecht();const s=await snapshot(pool),k=auftrag(o,pin?'aktivieren':'deaktivieren',{pin,basisRevision,image:o.image,grund:o.grund});
 const c=await pool.connect();
 try{
  await freigabe(c,s,o);
  if(pin)await pruefeLeserRuntimeSnapshot(c,{runtime_sha256:pin,runtime_image_digest:o.image.digest},s,o.root,o.image.digest);
  const id=randomUUID(),phase=pin?'aktiviert':'deaktiviert',params=[id,k.key,k.payload,phase,o.image.digest,pin,basisRevision,o.akteur,o.grund,{}];
  const row=await mutation(c,s,o,params,async()=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['leser-runtime-standard:'+o.image.digest]);
   await requestPruefen(c,k);
   const old=(await c.query('SELECT id::text,pin,phase FROM reverse_leser_runtime_ereignisse WHERE request_key=$1 AND phase=$2',[k.key,phase])).rows[0];
   if(old)return old;
   const now=await leseLeserRuntimeStandard(c,o.image);
   if(now.revision!==basisRevision)runtimeFail('leser_runtime_basis_geaendert');
   await c.query("INSERT INTO reverse_leser_runtime_ereignisse(id,request_key,payload_hash,phase,image_digest,pin,basis_revision,akteur,grund,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",params);
   return {id,pin,phase};
  });
  return {status:row.phase,pin:row.pin,revision:row.id,standard:await leseLeserRuntimeStandard(c,o.image),keine_neuen_auftraege:true};
 }finally{c.release();}
}
