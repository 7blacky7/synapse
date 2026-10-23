/** P18-T97: Reverse Admission-Cut; P20 und generische Route bleiben unverändert. */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {WorkJob,WorkJobClient} from './work-jobs.js';
import {reverseLeserKanonisch} from './reverse-leser-vertrag.js';
import {leseReverseEinstellwerte,reverseBigInt} from './reverse-einstellwerte.js';
export type ReverseHaltDb=Pick<WorkJobClient,'query'>;
const FUNKTION='reverse_pipeline_halt' as const;
const LOCK="hashtext('reverse-pipeline-halt')";
export class ReverseAdmissionFehler extends Error {constructor(readonly code:string){super(code);this.name='ReverseAdmissionFehler';}}
export async function leseReversePipelineHalt(db:ReverseHaltDb){
 const basis={funktion:FUNKTION,project:null,aktiv:false,quelle:'standard' as 'standard'|'produkt-schalter',
  ebene:null as 'global'|null,regel_funktion:null as typeof FUNKTION|null,gesetzt_von:null as string|null,
  gesetzt_am:null as string|null,grund:null as string|null,letzter_fehler:null as string|null};
 try{
  const rows=(await db.query("SELECT aktiv,grund,gesetzt_von,gesetzt_am FROM agent_profil_schalter WHERE ebene='global' AND project IS NULL AND funktion=$1",[FUNKTION])).rows;
  if(!rows.length)return basis;const z=rows[0];if(rows.length!==1||typeof z.aktiv!=='boolean')throw Error();
  return {...basis,aktiv:z.aktiv,quelle:'produkt-schalter' as const,ebene:'global' as const,regel_funktion:FUNKTION,
   grund:z.grund as string|null,gesetzt_von:String(z.gesetzt_von),gesetzt_am:new Date(String(z.gesetzt_am)).toISOString()};
 }catch{return {...basis,aktiv:true,letzter_fehler:'reverse_halt_nicht_lesbar'};}
}
/** Im Fach-TX VOR Policy-/Eintrags-/Joblocks. Kein Cache, kein neuer Client. */
export async function reverseAdmission(db:ReverseHaltDb){
 if((await db.query('SHOW transaction_isolation')).rows[0]?.transaction_isolation!=='read committed')
  throw new ReverseAdmissionFehler('reverse_admission_isolation');
 await db.query('SELECT pg_advisory_xact_lock_shared('+LOCK+')');return leseReversePipelineHalt(db);
}
export async function fordereReverseAdmission(db:ReverseHaltDb):Promise<void>{
 const s=await reverseAdmission(db);if(s.aktiv||s.letzter_fehler)throw new ReverseAdmissionFehler(s.letzter_fehler??'reverse_pipeline_gehalten');
}
/** Recht wurde vom bestehenden Produkt-Schalter geprüft. Cut = COMMIT, niemals Zeitstempel. */
export async function setzeReversePipelineHalt(pool:Pool,aktiv:boolean,grund:string,wer:string,setter:string|null):Promise<void>{
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock('+LOCK+')');
  await c.query(`INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von,setter_identity_id,gesetzt_am)
   VALUES('global',NULL,$1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(ebene,(COALESCE(project,'')),funktion)
   DO UPDATE SET aktiv=EXCLUDED.aktiv,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,
   setter_identity_id=EXCLUDED.setter_identity_id,gesetzt_am=EXCLUDED.gesetzt_am`,[FUNKTION,aktiv,grund,wer,setter]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
}
type Row=Record<string,unknown>;
const hash=(x:unknown)=>createHash('sha256').update(reverseLeserKanonisch(x)).digest('hex');
const obj=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x);
type Job=Pick<WorkJob,'id'|'kind'|'capability'|'project'|'scope'|'inputRef'|'profileId'>;
function beleg(r:Row,leser:boolean){
 return {version:1,fach_id:String(r.id),job_id:String(leser?r.work_job_id:r.p20_auftrag_id),
  kind:r.kind,capability:r.capability,project:r.project,scope:r.scope,input_ref:r.input_ref,
  profile_id:r.profile_id??null,request_hash:r.request_hash,eintrag_id:r.eintrag_id,
  datei_id:r.datei_id==null?null:String(r.datei_id),medium_id:leser||r.medium_id==null?null:String(r.medium_id),
  ...(leser?{leser_id:r.leser_id,quell_sha256:r.quell_sha256,einstellungen_revision:r.einstellungen_revision,
   runtime_sha256:r.runtime_sha256,runtime_image_digest:r.runtime_image_digest,policy_revision:obj(r.diagnose)?r.diagnose.policy_revision:null}
   :{schicht:r.schicht,fingerabdruck:r.fingerabdruck,werkzeug:r.werkzeug,werkzeug_version:r.werkzeug_version,
    profil_version:r.profil_version,policy_pin:r.policy_pin})};
}
async function rows(db:ReverseHaltDb,id:string,leser:boolean){
 const t=leser?'reverse_leser_laeufe':'reverse_auftraege',k=leser?'work_job_id':'p20_auftrag_id';
 return (await db.query(`SELECT r.*,w.kind,w.capability,w.project,w.scope,w.input_ref,w.profile_id,w.request_hash
  FROM ${t} r JOIN work_jobs w ON w.id=r.${k} WHERE r.${k}=$1`,[id])).rows;
}
function pruefe(r:Row,j:Job,leser:boolean):string|null{
 const ref=r.input_ref as Job['inputRef']|null;
 if(!ref||j.id!==String(leser?r.work_job_id:r.p20_auftrag_id)||j.kind!==r.kind||j.capability!==r.capability||
  j.project!==r.project||j.scope!==r.scope||j.profileId!==(r.profile_id??null)||hash(j.inputRef)!==hash(ref)||
  j.scope!=='reverse'||j.project!=='reverse-bibliothek'||ref.scope!=='reverse'||ref.id!==r.eintrag_id||
  ref.revision!==String(leser?r.datei_id:r.schicht==='E'?r.medium_id:r.datei_id))return 'reverse_fachbindung_ungueltig';
 const doc=leser?r.diagnose:r.uebernahme,a=obj(doc)?doc.admission:null;
 if(!obj(a))return 'reverse_admission_nicht_belegt';
 const b=beleg(r,leser);
 return typeof a.admission_id==='string'&&/^[a-f0-9-]{36}$/.test(a.admission_id)&&hash(a.beleg)===hash(b)&&
  a.sha256===hash([a.admission_id,b])?null:'reverse_fachbindung_ungueltig';
}
/** Auch unter P20-Locks nur den vorhandenen dritten Client verwenden; keinen Halt-Lock nehmen. */
export async function pruefeReverseFachbindung(db:ReverseHaltDb,j:Job,leser=false):Promise<string|null>{
 try{const r=await rows(db,j.id,leser);return !r.length?'reverse_fachbindung_fehlt':r.length!==1?'reverse_fachbindung_ungueltig':pruefe(r[0],j,leser);}
 catch{return 'reverse_fachbindung_nicht_lesbar';}
}
/** Ausschließlich bei gerade unter Admission angelegtem Job+Fachlink; nie fremde Jobs adoptieren. */
export async function belegeReverseAdmission(db:ReverseHaltDb,id:string,fachId:string,leser=false):Promise<void>{
 const rs=await rows(db,id,leser);if(rs.length!==1||String(rs[0].id)!==fachId)throw new ReverseAdmissionFehler('reverse_fachbindung_ungueltig');
 const r=rs[0],doc=leser?r.diagnose:r.uebernahme;
 if(obj(doc)&&doc.admission){
  const code=pruefe(r,{id,kind:String(r.kind),capability:String(r.capability),project:String(r.project),scope:String(r.scope),
   inputRef:r.input_ref as Job['inputRef'],profileId:r.profile_id as string|null},leser);
  if(code)throw new ReverseAdmissionFehler(code);return;
 }
 const b=beleg(r,leser),admission_id=randomUUID(),a={admission_id,beleg:b,sha256:hash([admission_id,b])};
 const s=await leseReverseEinstellwerte({eintrag_id:String(r.eintrag_id)},db);
 // Genau ein Beleg-UPDATE; jeder gültige Katalogwert (auch 1/2) reicht dafür.
 if(s.letzter_fehler||
  BigInt(Buffer.byteLength(reverseLeserKanonisch([r,a])))>reverseBigInt(s,'materialisierung_tx_bytes'))throw new ReverseAdmissionFehler('reverse_admission_budget');
 const t=leser?'reverse_leser_laeufe':'reverse_auftraege',f=leser?'diagnose':'uebernahme';
 const u=await db.query(`UPDATE ${t} SET ${f}=jsonb_set(COALESCE(${f},'{}'::jsonb),'{admission}',$2::jsonb)
  WHERE id=$1 AND NOT (COALESCE(${f},'{}'::jsonb)?'admission')`,[fachId,JSON.stringify(a)]);
 if(u.rowCount!==1)throw new ReverseAdmissionFehler('reverse_fachbindung_ungueltig');
}
/** Gebundene paginierte Sicht. Globale Drain-Zähler enthalten auch nackte generische Jobs. */
export async function reverseAdmissionDiagnose(db:ReverseHaltDb,eintrag:string,limit:number,offset:number){
 const halt=await leseReversePipelineHalt(db),drain=(await db.query(`SELECT count(*) FILTER(WHERE state='pending')::text AS pending,
  count(*) FILTER(WHERE state IN('leased','staged'))::text AS running FROM work_jobs WHERE scope='reverse'
  AND project='reverse-bibliothek' AND (kind LIKE 'reverse-%' OR capability IN('reverse_bibliothek','reverse_leser'))`)).rows[0];
 const api=(await db.query(`SELECT count(*) FILTER(WHERE status IN('offen','wartet'))::text AS wartend,
  count(*) FILTER(WHERE status='laeuft')::text AS laufend,
  count(*) FILTER(WHERE lease_token IS NOT NULL AND lease_bis>clock_timestamp())::text AS leases
  FROM reverse_auftraege WHERE ausfuehrung='api'`)).rows[0];
 const jobs=(await db.query(`SELECT id::text,kind,capability,project,scope,profile_id AS "profileId",input_ref AS "inputRef"
  FROM work_jobs WHERE scope='reverse' AND project='reverse-bibliothek' AND input_ref->>'id'=$1
  AND state IN('pending','leased','staged') ORDER BY created_at,id LIMIT $2 OFFSET $3`,[eintrag,limit,offset])).rows;
 const auftraege=[];for(const j of jobs)auftraege.push({job_id:j.id,kind:j.kind,
  grund:await pruefeReverseFachbindung(db,j as unknown as Job,j.kind==='reverse-leser')});
 return {halt,drain,api,drain_fertig:drain?.pending==='0'&&drain?.running==='0'&&api?.wartend==='0'&&api?.laufend==='0'&&api?.leases==='0',auftraege,offset,limit};
}
