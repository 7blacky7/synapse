/** P18-T43: persistente Planung im vorhandenen Executor-Takt; keine eigene Queue.
 * Nur gespeicherte Reverse-Dateien. Keine Projektbytes, Originale oder XP-Arbeitsordner.
 * Jeder Schreibschritt 1 Zeile/TX, eigene Hash-/Policy-Fences, keine Löschung alter Läufe. */
import {fordereReverseAdmission,leseReversePipelineHalt,belegeReverseAdmission,pruefeReverseFachbindung,ReverseAdmissionFehler} from './reverse-pipeline-halt.js';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createWorkJobService,type WorkJobPool,type WorkJobClient} from './work-jobs.js';
import {reverseEintragAktiv} from './reverse-asset-registrierung.js';
import {leseReverseLeserSchalter,leseReverseLeserNachzugSchalter,leseReverseLeserRevision,type ReverseLeserRevision,type ReverseLeserDb} from './reverse-leser-registry.js';
import {leseReverseEinstellwerte,reverseZahl,reverseBigInt,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {reverseLeserHash,reverseLeserKanonisch,ReverseLeserFehler} from './reverse-leser-vertrag.js';
import {reverseLeserDateipfad,reverseLeserRoot,reverseLeserTxBudget} from './reverse-leser-materialisierung.js';
import {waehleLeserRuntimePin,pruefeLeserRuntimeBindung} from './reverse-leser-runtime.js';
import type {LeserRuntimePin,LeserRuntimeImage} from './reverse-leser-runtime-vertrag.js';
export {reverseEintragAktiv as reverseLeserEintragAktiv};
type Db=Pick<PoolClient,'query'>;
interface Datei {id:string;eintrag_id:string;sha256:string;storage_key:string;pfad:string;groesse:string}
interface Punkt {
 eintrag_id:string;leser_id:string;datei_cursor:string;hash_cursor:string|null;scan_bis:string;scan_id:string;
 runtime_sha256:string|null;runtime_image_digest:string|null;
 einstellungen_revision:string;policy_revision:string;status:string;geprueft:string;passend:string;auftraege:string;offen:string;
}
function fail(code:string):never {throw new ReverseLeserFehler(code);}
const hash=(v:unknown)=>reverseLeserHash(reverseLeserKanonisch(v));
const uuid=(h:string)=>h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
const PUNKT='eintrag_id,leser_id,datei_cursor::text,hash_cursor,scan_bis::text,scan_id::text,einstellungen_revision,policy_revision,runtime_sha256,runtime_image_digest,status,geprueft::text,passend::text,auftraege::text,offen::text';
/** B1: gehaltene Clients nie neu verbinden und keine fremde TX abschließen. */
async function tx<T>(db:ReverseLeserDb,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 if(!(db instanceof Pool))return run(db as PoolClient);
 const c=await db.connect();try{await c.query('BEGIN');const r=await run(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
async function schalter(db:Db){
 const a=await leseReverseLeserSchalter(db as PoolClient),b=await leseReverseLeserNachzugSchalter(db as PoolClient);
 return {aktiv:a.aktiv&&b.aktiv&&!a.letzter_fehler&&!b.letzter_fehler,leser:a,nachzug:b};
}
async function snapshot(db:Db,id:string){
 const s=await leseReverseEinstellwerte({eintrag_id:id},db);if(s.letzter_fehler)fail(s.letzter_fehler);return s;
}
async function policy(db:Db,id:string,lock=false){
 const r=await db.query('SELECT analyse_policy FROM reverse_eintraege WHERE id=$1'+(lock?' FOR SHARE':''),[id]);
 if(!r.rows.length)fail('leser_eintrag_inaktiv');return hash(r.rows[0].analyse_policy??{});
}
/** Projektarbeit behält Vorrang; bereits laufende Publikation wird dadurch nicht ungültig. */
export async function reverseLeserProjektarbeitVorrang(db:Db):Promise<boolean>{
 const r=await db.query("SELECT 1 FROM work_jobs WHERE project<>'reverse-bibliothek' AND scope<>'reverse' AND state IN('pending','leased','staged') LIMIT 1");
 return r.rows.length>0;
}
/** Gemeinsamer Claim-/Publikationscheck, nur für echte Nachzugläufe. Keine fremden Eintragsinhalte. */
export async function reverseLeserNachzugFreigegeben(db:Db,jobId:string):Promise<boolean>{
 const rows=(await db.query("SELECT l.*,w.kind,w.capability,w.project,w.scope,w.profile_id,w.input_ref FROM reverse_leser_laeufe l JOIN work_jobs w ON w.id=l.work_job_id WHERE l.work_job_id=$1",[jobId])).rows;
 if(rows.length!==1)return false;const l=rows[0];
 // Der ausdrücklich angelegte Testlauf bleibt ein eigener, isolierter Weg.
 if(l.diagnose?.testmodus===true)return true;
 if(l.diagnose?.nachzug!==true)return false;
 if(await pruefeReverseFachbindung(db,{id:jobId,kind:l.kind,capability:l.capability,project:l.project,scope:l.scope,
  inputRef:l.input_ref,profileId:l.profile_id},true))return false;
 if(!(await schalter(db)).aktiv||!await reverseEintragAktiv(db,l.eintrag_id))return false;
 return await policy(db,l.eintrag_id)===l.diagnose.policy_revision;
}
async function guard(db:Db,id:string,r:ReverseLeserRevision,s:ReverseEinstellSnapshot,p:string,d?:Datei){
 if(!(await schalter(db)).aktiv)fail('leser_nachzug_aus');
 if(!await reverseEintragAktiv(db,id))fail('leser_eintrag_inaktiv');
 if(await policy(db,id,true)!==p||(await snapshot(db,id)).revision!==s.revision)fail('leser_einstellungen_geaendert');
 if(!(await db.query("SELECT 1 FROM reverse_leser_zustaende WHERE leser_id=$1 AND status='aktiv' FOR SHARE",[r.id])).rows.length)fail('leser_revision_inaktiv');
 if(d&&!(await db.query('SELECT 1 FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2 AND sha256=$3 AND storage_key=$4 AND groesse=$5::bigint FOR SHARE',
  [d.id,id,d.sha256,d.storage_key,d.groesse])).rows.length)fail('leser_quellstand_geaendert');
}
async function mutation<T>(db:ReverseLeserDb,id:string,r:ReverseLeserRevision,s:ReverseEinstellSnapshot,p:string,params:unknown,run:(c:PoolClient)=>Promise<T>,d?:Datei){
 reverseLeserTxBudget(s,1,params);
 return tx(db,async c=>{await fordereReverseAdmission(c);await c.query("SELECT set_config('statement_timeout',$1,true)",[String(reverseZahl(s,'leser_statement_timeout_ms'))]);
  await guard(c,id,r,s,p,d);return run(c);});
}
/** Nur begrenzte Magicbytes lesen; Hashprüfung der vollständigen Datei erst beim regulären Claim. */
export async function pruefeReverseLeserKandidat(root:string,d:Datei,r:ReverseLeserRevision,s:ReverseEinstellSnapshot):Promise<boolean>{
 const e=r.manifest.erkennung,n=BigInt(d.groesse);
 if(!d.storage_key.startsWith(d.eintrag_id+'/entpackt/')||!/^([0-9a-f]{64})$/.test(d.sha256))return false;
 if(n<BigInt(e.min_bytes)||e.max_bytes!==null&&n>BigInt(e.max_bytes))return false;
 if(e.endungen.length&&!e.endungen.some(x=>d.pfad.toLowerCase().endsWith(x)))return false;
 const total=e.magic.reduce((sum,m)=>sum+BigInt(m.hex.length/2),0n);
 if(total>reverseBigInt(s,'leser_magic_bytes'))fail('leser_magic_zu_gross');
 const p=await reverseLeserDateipfad(root,d.storage_key,s),f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const vor=await f.stat({bigint:true});if(!vor.isFile()||vor.nlink!==1n||vor.size!==n)fail('leser_quellstand_geaendert');
  let passt=true;
  for(const m of e.magic){
   const offset=BigInt(m.offset),b=Buffer.alloc(m.hex.length/2);
   if(offset+BigInt(b.length)>n){passt=false;break;}
   if(offset>BigInt(Number.MAX_SAFE_INTEGER))fail('leser_magic_offset_zu_gross');
   const read=await f.read(b,0,b.length,Number(offset));
   if(read.bytesRead!==b.length||b.toString('hex')!==m.hex){passt=false;break;}
  }
  const nach=await f.stat({bigint:true});
  if(vor.size!==nach.size||vor.ino!==nach.ino||vor.mtimeNs!==nach.mtimeNs||vor.ctimeNs!==nach.ctimeNs)fail('leser_quellstand_geaendert');
  return passt;
 }finally{await f.close();}
}
async function seite(db:Db,id:string,nach:string,bis:string,limit:number):Promise<Datei[]>{
 return (await db.query<Datei>(`SELECT d.id::text,d.eintrag_id,d.sha256,d.storage_key,d.pfad,d.groesse::text FROM reverse_dateien d
 WHERE d.eintrag_id=$1 AND d.id>$2::bigint AND d.id<=$3::bigint AND d.sha256 IS NOT NULL AND d.storage_key IS NOT NULL
 AND EXISTS(SELECT 1 FROM reverse_schichten e WHERE e.medium_id=d.medium_id AND e.schicht='E' AND e.aktuell AND e.status IN('fertig','teilweise'))
 ORDER BY d.id LIMIT $4`,[id,nach,bis,limit])).rows;
}
async function stand(db:Db,id:string){
 return (await db.query("SELECT COALESCE(max(id),0)::text AS bis,COALESCE(max(updated_at),'-infinity'::timestamptz)::text AS zeit FROM reverse_dateien WHERE eintrag_id=$1",[id])).rows[0] as {bis:string;zeit:string};
}
/** Eine Zeile je Phase. Crash nach enqueue: deterministischer Key bindet denselben Job beim Resume.
 * Claim-Auswahl nimmt ausschließlich Aufträge MIT bestätigter Laufbindung. */
async function auftrag(db:ReverseLeserDb,d:Datei,r:ReverseLeserRevision,s:ReverseEinstellSnapshot,p:string,pin:LeserRuntimePin){
 await pruefeLeserRuntimeBindung(db,pin);
 const identity=hash([d.eintrag_id,d.id,d.sha256,r.id,pin.runtime_sha256,pin.runtime_image_digest]),id=uuid(identity),generation=id;
 const alt=(await db.query("SELECT id,work_job_id,status,einstellungen_revision,diagnose,runtime_sha256,runtime_image_digest FROM reverse_leser_laeufe WHERE id=$1 AND eintrag_id=$2",[id,d.eintrag_id])).rows[0];
 if(alt){
  if(!alt.diagnose?.admission)fail('reverse_admission_nicht_belegt');
  if(alt.runtime_sha256!==pin.runtime_sha256||alt.runtime_image_digest!==pin.runtime_image_digest)fail('leser_runtime_laufpin_geaendert');
  if(alt.einstellungen_revision!==s.revision||alt.diagnose.policy_revision!==p)fail('leser_nachzug_laufpin_veraltet');
  return {id:alt.id,job:alt.work_job_id,neu:false};
 }
 const input={kind:'reverse-leser',capability:'reverse_leser',project:'reverse-bibliothek',scope:'reverse',priority:'nachzug' as const,
  inputRef:{scope:'reverse',id:d.eintrag_id,revision:d.id,sha256:d.sha256},
  resourceNeed:{cpu:reverseZahl(s,'e_cpu'),ram:reverseZahl(s,'e_ram_mib'),vram:0,gpu:false},idempotencyKey:'reverse-leser-nachzug:'+identity+':'+randomUUID()};
 const jobs=createWorkJobService({pool:db as unknown as WorkJobPool});
 // P20 schreibt zusätzlich UUID und Requesthash; auch diese Bytes zählen, nicht nur der Eingabeumschlag.
 const jobParams=[id,input.kind,input.capability,null,input.project,input.scope,JSON.stringify(input.inputRef),JSON.stringify(input.resourceNeed),input.priority,input.idempotencyKey,'0'.repeat(64),null];
 return tx(db,async c=>{
  await fordereReverseAdmission(c);await guard(c,d.eintrag_id,r,s,p,d);
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(reverseZahl(s,'leser_statement_timeout_ms'))]);
  const job=await jobs.enqueue(input,c as unknown as WorkJobClient);
  const diagnose={nachzug:true,nachzug_identitaet:identity,policy_revision:p,quell_storage_key:d.storage_key};
  const params=[id,d.eintrag_id,d.id,r.id,d.sha256,generation,job.id,s.revision,diagnose,pin.runtime_sha256,pin.runtime_image_digest];
  // G1-G3: Job + Lauf + Beleg sind dieselbe TX; Grenzfehler rollt alles zurück.
  reverseLeserTxBudget(s,3,[jobParams,params]);
  const row=await c.query(`INSERT INTO reverse_leser_laeufe
   (id,eintrag_id,datei_id,leser_id,quell_sha256,generation,work_job_id,einstellungen_revision,diagnose,runtime_sha256,runtime_image_digest)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) ON CONFLICT(id) DO NOTHING RETURNING id`,params);
  if(!row.rowCount)fail('reverse_fachbindung_ungueltig');
  await belegeReverseAdmission(c,job.id,id,true);
  return {id,job:job.id,neu:true};
 });
}
async function punkt(db:ReverseLeserDb,id:string,r:ReverseLeserRevision,s:ReverseEinstellSnapshot,p:string,neu=false,image?:LeserRuntimeImage):Promise<Punkt>{
 const alt=(await db.query<Punkt>('SELECT '+PUNKT+' FROM reverse_leser_nachzug WHERE eintrag_id=$1 AND leser_id=$2',[id,r.id])).rows[0];
 if(alt&&!neu){
  await pruefeLeserRuntimeBindung(db,{runtime_sha256:alt.runtime_sha256??undefined,runtime_image_digest:alt.runtime_image_digest??undefined},image?.digest);
  if(alt.einstellungen_revision!==s.revision||alt.policy_revision!==p)fail('leser_einstellungen_geaendert');
  if(alt.hash_cursor&&!(await db.query('SELECT 1 FROM reverse_dateien WHERE eintrag_id=$1 AND id=$2::bigint AND sha256=$3',[id,alt.datei_cursor,alt.hash_cursor])).rows.length)fail('leser_nachzug_quellcursor_geaendert');
  return alt;
 }
 const pin=await waehleLeserRuntimePin(db,image);
 const st=await stand(db,id),params=[id,r.id,randomUUID(),st.bis,st.zeit,s.revision,p,alt?.scan_id??null,pin.runtime_sha256,pin.runtime_image_digest];
 return mutation(db,id,r,s,p,params,async c=>(await c.query<Punkt>(`INSERT INTO reverse_leser_nachzug
  (eintrag_id,leser_id,scan_id,scan_bis,quellstand,einstellungen_revision,policy_revision,runtime_sha256,runtime_image_digest)
  VALUES($1,$2,$3,$4::bigint,$5::timestamptz,$6,$7,$9,$10)
  ON CONFLICT(eintrag_id,leser_id) DO UPDATE SET datei_cursor=0,hash_cursor=NULL,scan_id=EXCLUDED.scan_id,scan_bis=EXCLUDED.scan_bis,
   quellstand=EXCLUDED.quellstand,einstellungen_revision=EXCLUDED.einstellungen_revision,policy_revision=EXCLUDED.policy_revision,
   runtime_sha256=EXCLUDED.runtime_sha256,runtime_image_digest=EXCLUDED.runtime_image_digest,
   status='offen',geprueft=0,passend=0,auftraege=0,offen=0,fehlercode=NULL,fehler_datei=NULL,scan_start=clock_timestamp(),updated_at=clock_timestamp()
  WHERE reverse_leser_nachzug.status<>'offen' AND reverse_leser_nachzug.scan_id=$8::uuid
  RETURNING ${PUNKT}`,params)).rows[0]??(await c.query<Punkt>('SELECT '+PUNKT+' FROM reverse_leser_nachzug WHERE eintrag_id=$1 AND leser_id=$2',[id,r.id])).rows[0]);
}
async function fortschritt(db:ReverseLeserDb,c:Punkt,r:ReverseLeserRevision,s:ReverseEinstellSnapshot,p:string,d:Datei|null,passend:boolean,neu:boolean,fehler:string|null){
 const params=[c.eintrag_id,c.leser_id,c.scan_id,c.datei_cursor,d?.id??c.datei_cursor,d?.sha256??c.hash_cursor,d?1:0,passend?1:0,neu?1:0,fehler?1:0,fehler,d?.id??null];
 return mutation(db,c.eintrag_id,r,s,p,params,async db=>{
  const res=await db.query<Punkt>(`UPDATE reverse_leser_nachzug SET datei_cursor=$5::bigint,hash_cursor=$6,
   geprueft=geprueft+$7,passend=passend+$8,auftraege=auftraege+$9,offen=offen+$10,
   fehlercode=COALESCE($11,fehlercode),fehler_datei=CASE WHEN $11::text IS NULL THEN fehler_datei ELSE $12::bigint END,
   status=CASE WHEN $7=0 THEN CASE WHEN offen+$10>0 THEN 'teilweise' ELSE 'fertig' END ELSE 'offen' END,updated_at=clock_timestamp()
   WHERE eintrag_id=$1 AND leser_id=$2 AND scan_id=$3 AND datei_cursor=$4::bigint RETURNING ${PUNKT}`,params);
  if(!res.rows.length)fail('leser_nachzug_cursor_geaendert');return res.rows[0];
 });
}
/** Ein begrenzter Schritt; Vorschau schreibt weder Checkpoint noch Auftrag, auch bei AUS. */
async function reverseLeserNachziehenIntern(db:ReverseLeserDb,o:{eintrag_id:string;leser_id:string;vorschau?:boolean;root?:string;automatisch?:boolean;image?:LeserRuntimeImage}){
 const halt=await leseReversePipelineHalt(db);
 if(o.vorschau===false&&(halt.aktiv||halt.letzter_fehler))return {status:'gehalten',grund:halt.letzter_fehler??'reverse_pipeline_gehalten'};
 const id=o.eintrag_id,s=await snapshot(db,id),sch=await schalter(db);
 if(!await reverseEintragAktiv(db,id))return {status:'uebersprungen_inaktiv',eintrag_id:id,schalter:sch};
 const r=await leseReverseLeserRevision(db,o.leser_id);
 if(!r||r.status!=='aktiv')fail('leser_revision_inaktiv');
 const preview=o.vorschau!==false,limit=reverseZahl(s,'leser_nachzug_block_zeilen'),p=await policy(db,id);
 if(!preview&&!sch.aktiv)return {status:'leser_nachzug_aus',eintrag_id:id,schalter:sch};
 if(!preview&&await reverseLeserProjektarbeitVorrang(db))return {status:'projektarbeit_hat_vorrang',eintrag_id:id,schalter:sch};
 let c:Punkt|undefined;
 if(!preview){
  // Ein fremder äußerer TX-Kontext kann mehrere Phasen zusammenziehen: fail closed statt reconnect/Commit.
  if(!(db instanceof Pool))fail('leser_nachzug_pool_erforderlich');
  const alt=(await db.query<Punkt>('SELECT '+PUNKT+' FROM reverse_leser_nachzug WHERE eintrag_id=$1 AND leser_id=$2',[id,r.id])).rows[0];
  c=await punkt(db,id,r,s,p,!o.automatisch&&alt?.status==='teilweise',o.image);
 }
 const st=await stand(db,id),rows=await seite(db,id,c?.datei_cursor??'0',c?.scan_bis??st.bis,limit);
 let geprueft=0,passend=0,neu=0,offen=0;
 for(const d of rows){
  // Vor jeder Magicprobe und jeder Mutation erneut Freigabe/Pin prüfen.
  if(!await reverseEintragAktiv(db,id))fail('leser_eintrag_inaktiv');
  if((await snapshot(db,id)).revision!==s.revision||await policy(db,id)!==p)fail('leser_einstellungen_geaendert');
  if(!preview&&!(await schalter(db)).aktiv)fail('leser_nachzug_aus');
  if(!preview&&await reverseLeserProjektarbeitVorrang(db))return {status:'projektarbeit_hat_vorrang',checkpoint:c,geprueft,passend,neue_auftraege:neu,offen};
  let match=false,jobNeu=false,fehler:string|null=null;
  try{
   match=await pruefeReverseLeserKandidat(o.root??reverseLeserRoot(),d,r,s);
   if(match&&!preview){
    if(!c?.runtime_sha256||!c.runtime_image_digest)fail('leser_laufzeit_pin_fehlt');
    jobNeu=(await auftrag(db,d,r,s,p,{runtime_sha256:c.runtime_sha256,runtime_image_digest:c.runtime_image_digest})).neu;
   }
  }catch(e){
   if(e instanceof ReverseAdmissionFehler)throw e;
   const code=(e as {code?:string}).code??(e as Error).message;
   if(['leser_nachzug_aus','leser_eintrag_inaktiv','leser_einstellungen_geaendert','leser_revision_inaktiv'].includes(code))throw e;
   fehler=/^[a-zA-Z0-9_]+$/.test(code)?code:'leser_nachzug_probe_fehlgeschlagen';
  }
  geprueft++;if(match)passend++;if(jobNeu)neu++;if(fehler)offen++;
  if(c)c=await fortschritt(db,c,r,s,p,d,match,jobNeu,fehler);
 }
 const ende=rows.length<limit||(rows.length>0&&rows[rows.length-1].id===(c?.scan_bis??st.bis));
 if(c&&ende)c=await fortschritt(db,c,r,s,p,null,false,false,null);
 return {status:preview?'vorschau':c?.status??'offen',eintrag_id:id,leser_id:r.id,schalter:sch,
  einstellungen_revision:s.revision,policy_revision:p,geprueft,passend,neue_auftraege:neu,offen,
  naechster_cursor:ende?null:rows.at(-1)?.id??null,checkpoint:c??null};
}
/** Durable Polling aus dem vorhandenen Takt. Ein Paar und höchstens PG-Blockzeilen pro Aufruf.
 * Neue Registryrevisionen besitzen einen eigenen Checkpoint; fertige Scans werden bei neuen Quelldaten neu gestartet. */
export async function reverseLeserNachziehen(...args:Parameters<typeof reverseLeserNachziehenIntern>){
 try{return await reverseLeserNachziehenIntern(...args);}catch(e){if(e instanceof ReverseAdmissionFehler)return {status:'gehalten',grund:e.code};throw e;}
}
export async function planeReverseLeserNachzug(db:ReverseLeserDb,root?:string,image?:LeserRuntimeImage){
 const halt=await leseReversePipelineHalt(db);if(halt.aktiv||halt.letzter_fehler)return {status:'gehalten',grund:halt.letzter_fehler??'reverse_pipeline_gehalten'};
 const sch=await schalter(db);if(!sch.aktiv)return {status:'leser_nachzug_aus'};
 if(!(db instanceof Pool))fail('leser_nachzug_pool_erforderlich');
 if(await reverseLeserProjektarbeitVorrang(db))return {status:'projektarbeit_hat_vorrang'};
 const pair=(await db.query(`SELECT e.id AS eintrag_id,z.leser_id,c.status,c.einstellungen_revision,c.policy_revision,c.scan_id
  FROM reverse_eintraege e CROSS JOIN reverse_leser_zustaende z
  LEFT JOIN reverse_leser_nachzug c ON c.eintrag_id=e.id AND c.leser_id=z.leser_id
  WHERE e.status='bestaetigt' AND z.status='aktiv'
  AND EXISTS(SELECT 1 FROM reverse_medien m JOIN reverse_schichten s ON s.medium_id=m.id
   WHERE m.eintrag_id=e.id AND s.schicht='E' AND s.aktuell AND s.status IN('fertig','teilweise'))
  AND (c.eintrag_id IS NULL OR c.status='offen' OR EXISTS(SELECT 1 FROM reverse_dateien d
   WHERE d.eintrag_id=e.id AND (d.id>c.scan_bis OR d.updated_at>c.quellstand)))
  ORDER BY c.updated_at NULLS FIRST,e.id,z.leser_id LIMIT 1`)).rows[0];
 if(!pair)return {status:'fertig'};
 if(!await reverseEintragAktiv(db,pair.eintrag_id))return {status:'uebersprungen_inaktiv'};
 if(pair.status&&pair.status!=='offen'){
  const r=await leseReverseLeserRevision(db,pair.leser_id);if(!r)fail('leser_revision_inaktiv');
  const s=await snapshot(db,pair.eintrag_id),p=await policy(db,pair.eintrag_id);
  await punkt(db,pair.eintrag_id,r,s,p,true,image);
 }
 try{return await reverseLeserNachziehen(db,{eintrag_id:pair.eintrag_id,leser_id:pair.leser_id,vorschau:false,root,automatisch:true,image});}
 catch(e){
  if(e instanceof ReverseAdmissionFehler)return {status:'gehalten',grund:e.code};
  // Ein veralteter Scan blockiert keine anderen Paare oder gesunden Folgejobs (F1).
  const code=(e as Error).message,s=await snapshot(db,pair.eintrag_id);
  const params=[pair.eintrag_id,pair.leser_id,/^[a-zA-Z0-9_]+$/.test(code)?code:'leser_nachzug_fehlgeschlagen',pair.scan_id??null];
  reverseLeserTxBudget(s,1,params);
  await tx(db,c=>c.query("UPDATE reverse_leser_nachzug SET status='teilweise',fehlercode=$3,updated_at=clock_timestamp() WHERE eintrag_id=$1 AND leser_id=$2 AND scan_id=$4::uuid",params));
  return {status:'teilweise',eintrag_id:pair.eintrag_id,leser_id:pair.leser_id,fehlercode:params[2]};
 }
}
/** Metadatenereignis nach Speicherung; verlorene Notifications sind durch den persistenten Scan abgedeckt. */
export async function meldeReverseLeserKandidat(db:Db,eintragId:string,dateiId:string){
 if(!(await schalter(db)).aktiv||!await reverseEintragAktiv(db,eintragId))return;
 await db.query("SELECT pg_notify('reverse_leser_kandidat',$1)",[JSON.stringify({eintrag_id:eintragId,datei_id:dateiId})]);
}
