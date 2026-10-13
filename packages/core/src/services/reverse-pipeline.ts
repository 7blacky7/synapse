/**
 * RV8: API-only scheduler and light S0/S1 inspection. PG transactions never perform FS or Docker work.
 * Container jobs are durable P20 requests, fenced by its server-side authority hooks.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {getPool,imHintergrund} from '../db/client.js';
import {standardRegistry} from '../asset-intel/index.js';
import {AssetInspektionsWorker,WORKER_GNADENFRIST_MS} from '../asset-intel/worker-runner.js';
import type {AssetResult} from '../asset-intel/types.js';
import {getAssetKonfiguration,type AssetKonfiguration} from '../config/asset-konfig.js';
import {AssetSpeicher,type AssetAdresse} from './asset-speicher.js';
import {reverseDateiSpeicherAdresse} from './reverse-eingang.js';
import {maskiereMitKatalog} from './masken-katalog.js';
import {configureReverseRuntime,type ReverseAnalyseAnfrage} from './reverse-tool.js';
import {createWorkJobService,validateWorkResources,type WorkResourceNeed} from './work-jobs.js';
import {starteApiAuftragsLoop,type ApiAuftragsLoop} from './api-auftrags-loop.js';

type Row=Record<string,unknown>;
interface AnalysePayload {result:Omit<AssetResult,'file_path'>;strings:string[];metadata:Row;status:string;dauer_ms:number}
const STAGES=['E','S0','S1','S2','S3'] as const;
const OK=['fertig','teilweise'];
const num=(name:string,fallback:number)=>{const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<1)throw new Error('Ungültige Reverse-Konfiguration '+name);return n;};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function reverseAnalyseFingerabdruck(sha:string,stage:string,tool:string,version:string,profile:string):string{
 if(!/^[a-f0-9]{64}$/.test(sha)||!STAGES.includes(stage as typeof STAGES[number]))throw new Error('Ungültige Reverse-Identität');
 return hash([sha,stage,tool,version,profile]);
}
/** Recursively masks text and keys; only decoded, bounded inspector metadata enters PG. */
export function maskiereReverseAnalyse(value:unknown):{wert:unknown;treffer:number}{
 let treffer=0;
 const text=(s:string)=>{const r=maskiereMitKatalog(s,'reverse');treffer+=r.treffer;return r.text;};
 const walk=(v:unknown):unknown=>{
  if(typeof v==='string')return text(v);
  if(Array.isArray(v))return v.map(walk);
  if(v&&typeof v==='object'){
   if(Buffer.isBuffer(v)||ArrayBuffer.isView(v)||v instanceof ArrayBuffer)throw new Error('Bytes sind kein Reverse-Metadatum');
   return Object.fromEntries(Object.entries(v).map(([k,x])=>[text(k),walk(x)]));
  }
  return v;
 };
 return {wert:walk(value),treffer};
}
interface Job extends Row {id:string;eintrag_id:string;datei_id:string|null;medium_id:string|null;schicht:string;fingerabdruck:string;lease_token:string;werkzeug:string;werkzeug_version:string;profil_version:string;projekt:string;ziel_schicht:string;prioritaet:'interaktiv'|'hintergrund'|'nachzug'}
export interface ReversePipelineOptionen {pool?:Pool;konfiguration?:AssetKonfiguration;speicher?:AssetSpeicher}
export class ReversePipelineDienst{
 private readonly pool:Pool;
 private readonly cfg:AssetKonfiguration;
 private readonly speicher:AssetSpeicher;
 private readonly workers:AssetInspektionsWorker[];
 private readonly profile:string;
 private readonly version:string;
 private readonly retry:number;
 private readonly leaseMs:number;
 private readonly stringsBytes:number;
 private beendet=false;
 constructor(o:ReversePipelineOptionen={}){
  this.pool=o.pool??getPool();this.cfg=o.konfiguration??getAssetKonfiguration();
  this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
  this.retry=num('SYNAPSE_REVERSE_RETRY_MAX',3);
  this.version=hash(standardRegistry.list().map(i=>[i.id,i.version]).sort());
  this.stringsBytes=Math.min(num('SYNAPSE_REVERSE_STRINGS_BYTES',4194304),Math.floor(this.cfg.inspektion.maxReadBytes/2));
  this.profile=hash({engine:'reverse-api-s0s1-v1',version:process.env.SYNAPSE_REVERSE_PROFIL_VERSION??'1',limits:this.cfg.inspektion,
   stringsBytes:this.stringsBytes,stringsMin:num('SYNAPSE_REVERSE_STRINGS_MIN',4)});
  this.leaseMs=this.cfg.inspektion.timeoutMs*2+WORKER_GNADENFRIST_MS+this.cfg.speicher.timeoutMs;
  this.workers=Array.from({length:num('SYNAPSE_REVERSE_PARALLEL',this.cfg.sync.parallelInspektionen)},()=>new AssetInspektionsWorker());
 }
 private async tx<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}
  catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
 }
 private async naechste(db:PoolClient,rid:string,file:string|null,medium:string|null,target:string):Promise<string|null>{
  if(!file)return 'E';
  const layers=(await db.query('SELECT schicht,status,werkzeug_version,profil_version FROM reverse_schichten WHERE datei_id=$1 AND aktuell',[file])).rows;
  for(const stage of STAGES.slice(1)){
   if(STAGES.indexOf(stage)>STAGES.indexOf(target as typeof STAGES[number]))return null;
   const row=layers.find(x=>x.schicht===stage);if(!row||!OK.includes(row.status)||row.profil_version!==this.profile||row.werkzeug_version!==(stage==='S0'||stage==='S1'?this.version:process.env.SYNAPSE_REVERSE_WERKZEUG_VERSION??'nicht-konfiguriert'))return stage;
  }
  return null;
 }
 private async containerAuftrag(db:PoolClient,j:Row,sha:string,stage:string):Promise<string|null>{
  const raw=process.env.SYNAPSE_REVERSE_RESOURCE_NEED,profile=process.env.SYNAPSE_REVERSE_CONTAINER_PROFIL;
  if(!raw||!profile)return null;
  const resources=validateWorkResources(JSON.parse(raw));
  if(resources.cpu<=0||resources.ram<=0)throw new Error('Reverse-Containerprofil benötigt CPU/RAM');
  await db.query("INSERT INTO reverse_analyse_cache(fingerabdruck,sha256,schicht,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[j.fingerabdruck,sha,stage,j.werkzeug,j.werkzeug_version,j.profil_version]);
  const cached=(await db.query('SELECT * FROM reverse_analyse_cache WHERE fingerabdruck=$1 FOR UPDATE',[j.fingerabdruck])).rows[0];
  let workId=cached.p20_auftrag_id;
  if(workId){
   const work=(await db.query('SELECT state FROM work_jobs WHERE id=$1',[workId])).rows[0];
   if(work?.state==='cancelled'||work?.state==='failed'||work?.state==='expired')workId=null;
  }
  if(!workId){
   if(Number(cached.versuche)>=this.retry){
    await db.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode='werkzeug_fehler' WHERE fingerabdruck=$1",[j.fingerabdruck]);
    await db.query("UPDATE reverse_auftraege SET status='fehler',fehlercode='werkzeug_fehler',versuch=$2 WHERE id=$1",[j.id,this.retry]);return null;
   }
   const generation=Number(cached.versuche)+1;
   const work=await createWorkJobService({pool:this.pool}).enqueue({kind:'reverse-'+stage,capability:'reverse_bibliothek',profileId:profile,
    project:String(j.projekt),scope:'reverse',inputRef:{scope:'reverse',id:String(j.eintrag_id),revision:String(j.datei_id??j.medium_id),sha256:sha},
    resourceNeed:resources,priority:j.prioritaet as 'interaktiv'|'hintergrund'|'nachzug',idempotencyKey:'reverse:'+String(j.fingerabdruck)+':'+generation},db);
   workId=work.id;
   await db.query('UPDATE reverse_analyse_cache SET p20_auftrag_id=$2,quell_auftrag_id=$3,versuche=$4,updated_at=clock_timestamp() WHERE fingerabdruck=$1',[j.fingerabdruck,workId,j.id,generation]);
  }
  await db.query('UPDATE reverse_auftraege SET p20_auftrag_id=$2,fehlercode=NULL WHERE id=$1',[j.id,workId]);
  if(j.prioritaet==='interaktiv')await db.query("UPDATE work_jobs SET priority='interaktiv',updated_at=clock_timestamp() WHERE id=$1 AND state='pending'",[workId]);
  return workId;
 }
 /** S1 inspector output remains usable while optional container enrichment waits. */
 private async s1Werkzeuge(db:PoolClient,j:Job):Promise<void>{
  const d=(await db.query('SELECT sha256 FROM reverse_dateien WHERE id=$1',[j.datei_id])).rows[0];
  const version=process.env.SYNAPSE_REVERSE_WERKZEUG_VERSION??'nicht-konfiguriert';
  const fp=reverseAnalyseFingerabdruck(d.sha256,'S1','reverse-S1',version,this.profile);
  let supplementary=(await db.query("SELECT * FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id=$2 AND schicht='S1' AND ausfuehrung='container' AND status IN ('offen','wartet','laeuft') FOR UPDATE",[j.eintrag_id,j.datei_id])).rows[0];
  if(!supplementary)supplementary=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,prioritaet,status,ausloeser,ausfuehrung,fingerabdruck,ziel_schicht,projekt,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,'S1',$3,'wartet','pipeline:s1-tools','container',$4,$5,$6,'reverse-S1',$7,$8) RETURNING *",[j.eintrag_id,j.datei_id,j.prioritaet,fp,j.ziel_schicht,j.projekt,version,this.profile])).rows[0];
  if(!await this.containerAuftrag(db,supplementary,d.sha256,'S1'))await db.query("UPDATE reverse_auftraege SET fehlercode='container_gesperrt' WHERE id=$1",[supplementary.id]);
 }
 private async queue(db:PoolClient,a:ReverseAnalyseAnfrage):Promise<Row>{
  const stage=await this.naechste(db,a.reverseId,a.dateiId,a.mediumId,a.bisSchicht);
  if(!stage)return {status:'fertig',schicht:a.bisSchicht,auftrag_id:null};
  const file=a.dateiId?(await db.query('SELECT sha256,medium_id FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2',[a.dateiId,a.reverseId])).rows[0]:null;
  const medium=!a.dateiId?(await db.query('SELECT satz_sha256 FROM reverse_medien WHERE id=$1 AND eintrag_id=$2',[a.mediumId,a.reverseId])).rows[0]:null;
  const sha=String(file?.sha256??medium?.satz_sha256??'');
  if(!/^[a-f0-9]{64}$/.test(sha))return {status:'wartet',fehlercode:'schicht_nicht_fertig',auftrag_id:null};
  const local=stage==='S0'||stage==='S1',tool=local?'asset-inspektoren':'reverse-'+stage;
  const version=local?this.version:process.env.SYNAPSE_REVERSE_WERKZEUG_VERSION??'nicht-konfiguriert';
  const fp=reverseAnalyseFingerabdruck(sha,stage,tool,version,this.profile);
  const exhausted=(await db.query("SELECT id FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint AND medium_id IS NOT DISTINCT FROM $3::bigint AND fingerabdruck=$4 AND status='fehler' AND versuch>=$5 LIMIT 1",[a.reverseId,a.dateiId,a.dateiId?null:a.mediumId,fp,this.retry])).rows[0];
  if(exhausted)return {status:'fehler',fehlercode:'werkzeug_fehler',auftrag_id:exhausted.id};
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-pipeline:'+a.reverseId+':'+(a.dateiId??'m'+a.mediumId)+':'+stage]);
  // Adopt RV9 waiting requests instead of creating a parallel executable job.
  let j=(await db.query("SELECT * FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint AND ($2::bigint IS NOT NULL OR medium_id IS NOT DISTINCT FROM $4::bigint) AND schicht=$3 AND status IN ('offen','wartet','laeuft','fehler') AND (fingerabdruck IS NULL OR ausfuehrung=$5) ORDER BY created_at LIMIT 1 FOR UPDATE",[a.reverseId,a.dateiId,stage,a.dateiId?null:a.mediumId,local?'api':'container'])).rows[0];
  if(j?.status==='laeuft'&&j.fingerabdruck!==fp)return {auftrag_id:j.id,status:'wartet',fehlercode:'schicht_nicht_fertig'};
  if(j?.status==='fehler'&&j.fingerabdruck===fp)return {auftrag_id:j.id,status:'fehler',fehlercode:j.fehlercode};
  if(!j)j=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,medium_id,schicht,prioritaet,status,ausloeser) VALUES($1,$2,$3,$4,$5,'wartet',$6) RETURNING *",[a.reverseId,a.dateiId,a.dateiId?null:a.mediumId,stage,a.prioritaet,'agent:'+a.agentId])).rows[0];
  await db.query("UPDATE reverse_auftraege SET medium_id=CASE WHEN datei_id IS NOT NULL THEN NULL ELSE medium_id END,fingerabdruck=$2,ziel_schicht=GREATEST(ziel_schicht,$3),projekt=COALESCE(projekt,$4),ausfuehrung=$5,werkzeug=$6,werkzeug_version=$7,profil_version=$8,prioritaet=CASE WHEN prioritaet='interaktiv' OR $9='interaktiv' THEN 'interaktiv' ELSE prioritaet END,updated_at=clock_timestamp() WHERE id=$1",
   [j.id,fp,a.bisSchicht,a.project,local?'api':'container',tool,version,this.profile,a.prioritaet]);
  const prior=(await db.query('SELECT * FROM reverse_schichten WHERE datei_id IS NOT DISTINCT FROM $1::bigint AND medium_id IS NOT DISTINCT FROM $2::bigint AND schicht=$3 AND aktuell',[a.dateiId,a.dateiId?null:a.mediumId,stage])).rows[0];
  if(prior&&prior.fingerabdruck!==fp)await db.query('UPDATE reverse_schichten SET aktuell=false WHERE id=$1',[prior.id]);
  await db.query("INSERT INTO reverse_schichten(datei_id,medium_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,auftrag_id) VALUES($1,$2,$3,$4,'wartet',$5,$6,$7,$8) ON CONFLICT DO NOTHING",
   [a.dateiId,a.dateiId?null:a.mediumId,stage,fp,tool,version,this.profile,j.id]);
  await db.query('UPDATE reverse_schichten SET aktuell=true,auftrag_id=$5 WHERE datei_id IS NOT DISTINCT FROM $1::bigint AND medium_id IS NOT DISTINCT FROM $2::bigint AND schicht=$3 AND fingerabdruck=$4',[a.dateiId,a.dateiId?null:a.mediumId,stage,fp,j.id]);
  if(!local){
   const work=await this.containerAuftrag(db,{...j,fingerabdruck:fp,werkzeug:tool,werkzeug_version:version,profil_version:this.profile,projekt:j.projekt??a.project,prioritaet:j.prioritaet==='interaktiv'?'interaktiv':a.prioritaet},sha,stage);
   if(!work)await db.query("UPDATE reverse_auftraege SET fehlercode='container_gesperrt' WHERE id=$1",[j.id]);
  }
  return {auftrag_id:j.id,status:j.status??'wartet',schicht_angefragt:a.bisSchicht,eta:null,...(!local?{fehlercode:'container_ruht'}:{})};
 }
 /** Caller holds the same Fachtransaction as tool audit; PG only. */
 async analysieren(a:ReverseAnalyseAnfrage,db:PoolClient):Promise<Row>{
  await db.query("UPDATE reverse_analyse_cache SET versuche=0,status='wartet' WHERE status='fehler' AND fingerabdruck IN (SELECT fingerabdruck FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint AND status='fehler')",[a.reverseId,a.dateiId]);
  if(!STAGES.includes(a.bisSchicht as typeof STAGES[number]))throw new Error('Ungültige Schicht');
  // A manual retry can re-open exhausted light jobs, but never running or cancelled work.
  await db.query("UPDATE reverse_auftraege SET status='wartet',versuch=0,fehlercode=NULL,lease_token=NULL,lease_bis=NULL WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint AND status='fehler'",[a.reverseId,a.dateiId]);
  const r=await this.queue(db,a);
  if(a.prioritaet==='interaktiv')await db.query("UPDATE work_jobs SET priority='interaktiv',updated_at=clock_timestamp() WHERE id IN (SELECT p20_auftrag_id FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint) AND state='pending'",[a.reverseId,a.dateiId]);
  return r;
 }
 async abbrechen(j:Row,_agent:string,db:PoolClient):Promise<void>{
  if(j.p20_auftrag_id){
   // Running leases require RV12's physical cancellation proof; do not fake a release.
   const others=(await db.query("SELECT count(*)::int AS n FROM reverse_auftraege WHERE p20_auftrag_id=$1 AND id<>$2 AND status IN ('offen','wartet','laeuft')",[j.p20_auftrag_id,j.id])).rows[0];
   if(Number(others.n)>0){await db.query('UPDATE reverse_auftraege SET lease_token=NULL,lease_bis=NULL WHERE id=$1',[j.id]);return;}
   const w=(await db.query('SELECT state FROM work_jobs WHERE id=$1 FOR UPDATE',[j.p20_auftrag_id])).rows[0];
   if(w&&!['pending','completed','failed','cancelled'].includes(w.state))throw new Error('Aktive Containerarbeit benötigt Executor-Storno');
   await db.query("UPDATE work_jobs SET state='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND state='pending'",[j.p20_auftrag_id]);
  }
  await db.query('UPDATE reverse_auftraege SET lease_token=NULL,lease_bis=NULL WHERE id=$1',[j.id]);
 }
 async containerStatus(_rid:string):Promise<{zustand:'ruht';kaltstart_s:null}>{
  // RV12 may replace this read-only hook with its real lifecycle adapter.
  return {zustand:'ruht',kaltstart_s:null};
 }
 private async entdecke():Promise<void>{
  const files=(await this.pool.query("SELECT d.id::text,d.eintrag_id,d.medium_id::text,e.analyse_policy FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id WHERE e.status='bestaetigt' AND d.storage_key IS NOT NULL AND d.sha256 IS NOT NULL AND COALESCE((e.analyse_policy->>'automatisch')::boolean,true) AND NOT EXISTS(SELECT 1 FROM reverse_schichten done WHERE done.datei_id=d.id AND done.schicht=COALESCE(e.analyse_policy->>'bis_schicht','S3') AND done.aktuell AND done.status IN ('fertig','teilweise') AND done.profil_version=$2) ORDER BY d.pipeline_gesehen_at NULLS FIRST,d.updated_at,d.id LIMIT $1",[num('SYNAPSE_REVERSE_DISCOVERY_BATCH',100),this.profile])).rows;
  for(const d of files)await this.tx(async db=>{await db.query('UPDATE reverse_dateien SET pipeline_gesehen_at=clock_timestamp() WHERE id=$1',[d.id]);return this.queue(db,{reverseId:d.eintrag_id,dateiId:d.id,mediumId:d.medium_id,
   project:'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:STAGES.includes(d.analyse_policy?.bis_schicht)?d.analyse_policy.bis_schicht:'S3',prioritaet:'hintergrund'});});
  const media=(await this.pool.query("SELECT m.id::text,m.eintrag_id FROM reverse_medien m JOIN reverse_eintraege e ON e.id=m.eintrag_id WHERE e.status='bestaetigt' AND m.status='vollstaendig' AND m.art<>'ordner' AND COALESCE((e.analyse_policy->>'automatisch')::boolean,true) AND NOT EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.medium_id=m.id AND s.schicht='E' AND s.aktuell AND s.status IN ('fertig','teilweise')) ORDER BY m.pipeline_gesehen_at NULLS FIRST,m.id LIMIT $1",[num('SYNAPSE_REVERSE_DISCOVERY_BATCH',100)])).rows;
  for(const m of media)await this.tx(async db=>{await db.query('UPDATE reverse_medien SET pipeline_gesehen_at=clock_timestamp() WHERE id=$1',[m.id]);return this.queue(db,{reverseId:m.eintrag_id,dateiId:null,mediumId:m.id,project:'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:'S3',prioritaet:'hintergrund'});});
 }
 private async claim():Promise<Job|undefined>{
  return this.tx(async db=>{
   const j=(await db.query("SELECT j.* FROM reverse_auftraege j JOIN reverse_dateien d ON d.id=j.datei_id JOIN reverse_eintraege e ON e.id=j.eintrag_id WHERE j.ausfuehrung='api' AND e.status='bestaetigt' AND j.fingerabdruck IS NOT NULL AND j.versuch<$1 AND (j.status='wartet' OR j.status='laeuft' AND j.lease_bis<clock_timestamp() OR j.status='fehler' AND j.updated_at<clock_timestamp()-$2::double precision*interval '1 millisecond') AND (j.schicht='S0' OR EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S0' AND s.aktuell AND s.status IN ('fertig','teilweise'))) ORDER BY CASE j.prioritaet WHEN 'interaktiv' THEN 0 WHEN 'hintergrund' THEN 1 ELSE 2 END,j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1",[this.retry,this.cfg.sync.retryIntervallMs])).rows[0];
   if(!j)return;
   const token=randomUUID();await db.query("UPDATE reverse_auftraege SET status='laeuft',lease_token=$2,lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1",[j.id,token,this.leaseMs]);
   await db.query("UPDATE reverse_schichten SET status='laeuft',gestartet_at=clock_timestamp(),fehlercode=NULL WHERE auftrag_id=$1 AND aktuell AND fingerabdruck=$2",[j.id,j.fingerabdruck]);
   return {...j,lease_token:token} as Job;
  });
 }
 private adresse(rid:string,pfad:string,key:string):AssetAdresse{
  const m=key.match(/^([^/]+)\/(original|entpackt)\/([^/]+)\/(.+)$/);
  if(!m||m[1]!==rid)throw new Error('Ungültige Reverse-Speicherreferenz');
  return {bereich:'reverse',ziel_ref:rid,storage_kind:'binaries',logischer_pfad:m[4],reverse_layout:{art:m[2] as 'original'|'entpackt',gruppe:m[3]}};
 }
 private async materialisiere(db:PoolClient,j:Job,payload:AnalysePayload):Promise<void>{
  const d=(await db.query('SELECT * FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2 FOR UPDATE',[j.datei_id,j.eintrag_id])).rows[0];
  const r=payload.result as AssetResult,metadata=payload.metadata;
  if(!d||reverseAnalyseFingerabdruck(d.sha256,j.schicht,j.werkzeug,j.werkzeug_version,j.profil_version)!==j.fingerabdruck)throw new Error('Reverse-Revision geändert');
  await db.query('UPDATE reverse_dateien SET format=$2,arch=$3,bits=$4,art=$5,metadaten=metadaten||$6::jsonb,status=$7,updated_at=clock_timestamp() WHERE id=$1',
   [d.id,r.format??'unbekannt',r.metadata.architektur??'unbekannt',typeof r.metadata.bits==='number'?r.metadata.bits:null,
    r.asset_type==='archive'?'archiv':r.asset_type==='executable'?'binaer':r.asset_type==='unbekannt'?'sonstig':'asset',JSON.stringify(metadata),payload.status]);
  if(j.schicht==='S1'){
   await db.query('DELETE FROM reverse_objekte WHERE datei_id=$1',[d.id]);
   await db.query('DELETE FROM reverse_verweise WHERE datei_id=$1',[d.id]);
   for(const [i,o] of r.objects.entries()){
    const range=o.source_range;
    await db.query('INSERT INTO reverse_objekte(datei_id,eintrag_id,ordnung,kind,name,data,byte_offset,byte_length,line_start,line_end) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)',
     [d.id,j.eintrag_id,i,o.kind,o.name,JSON.stringify(o.data),range&&'offset'in range?range.offset:null,range&&'length'in range?range.length:null,range&&'line_start'in range?range.line_start:null,range&&'line_end'in range?range.line_end:null]);
   }
   for(const [i,r] of (payload.result as AssetResult).references.entries())await db.query("INSERT INTO reverse_verweise(datei_id,eintrag_id,ordnung,kind,target,aufloesung,inspektor_resolved) VALUES($1,$2,$3,$4,$5,'unbekannt',$6)",[d.id,j.eintrag_id,i,r.kind,r.target,r.resolved??null]);
   const imports=r.references.map(x=>x.target).join('\n');
   for(const [name,content] of [['strings.txt',payload.strings.join('\n')],['imports.txt',imports]]){
    const virtual=d.pfad+'@S1/'+name,id=hash([j.eintrag_id,virtual]);
    await db.query("INSERT INTO reverse_code_dateien(id,eintrag_id,file_path,file_name,file_type,file_size,content,content_hash,datei_id,schicht,fingerabdruck,tsv,tsv_zerlegt) VALUES($1,$2,$3,$4,'txt',$5,$6,$7,$8,'S1',$9,to_tsvector('simple',$6),to_tsvector('simple',$6)) ON CONFLICT(eintrag_id,file_path) DO UPDATE SET content=EXCLUDED.content,content_hash=EXCLUDED.content_hash,file_size=EXCLUDED.file_size,fingerabdruck=EXCLUDED.fingerabdruck,tsv=EXCLUDED.tsv,tsv_zerlegt=EXCLUDED.tsv_zerlegt,updated_at=clock_timestamp()",
     [id,j.eintrag_id,virtual,name,Buffer.byteLength(content),content,hash(content),d.id,j.fingerabdruck]);
    await db.query('DELETE FROM reverse_code_symbole WHERE eintrag_id=$1 AND file_path=$2',[j.eintrag_id,virtual]);
    const lines=content.split('\n');
    for(const [i,line] of lines.entries())if(line)await db.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,'S1',$9)",[hash([id,i]),j.eintrag_id,virtual,name==='strings.txt'?'string':'import',name==='strings.txt'?null:line,line,i+1,d.id,j.fingerabdruck]);
   }
  }
  await db.query("UPDATE reverse_schichten SET status=$3,funktionen_gesamt=$4,funktionen_fertig=$4,beendet_at=clock_timestamp(),dauer_ms=$5 WHERE datei_id=$1 AND schicht=$2 AND fingerabdruck=$6 AND aktuell",[d.id,j.schicht,payload.status,r.objects.length,payload.dauer_ms,j.fingerabdruck]);
  await db.query("UPDATE reverse_auftraege SET status=$3,lease_token=NULL,lease_bis=NULL,fehlercode=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token,payload.status]);
  await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[j.eintrag_id]);
 }
 private async bearbeite(worker:AssetInspektionsWorker,j:Job):Promise<void>{
  let source:Awaited<ReturnType<AssetSpeicher['oeffneInspektionsQuelle']>>|undefined;
  let ownsCache=false;
  try{
   const d=(await this.pool.query('SELECT * FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2',[j.datei_id,j.eintrag_id])).rows[0];
   if(!d)throw new Error('Reverse-Datei fehlt');
   const cache=await this.tx(async db=>{
    await db.query("INSERT INTO reverse_analyse_cache(fingerabdruck,sha256,schicht,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[j.fingerabdruck,d.sha256,j.schicht,j.werkzeug,j.werkzeug_version,j.profil_version]);
    const c=(await db.query('SELECT * FROM reverse_analyse_cache WHERE fingerabdruck=$1 FOR UPDATE',[j.fingerabdruck])).rows[0];
    if(OK.includes(c.status))return c.ergebnis;
    if(c.status==='laeuft'&&new Date(c.lease_bis).getTime()>Date.now()||c.versuche>=this.retry){
     await db.query("UPDATE reverse_auftraege SET status=$3,lease_token=NULL,lease_bis=NULL,fehlercode=$4 WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token,c.versuche>=this.retry?'fehler':'wartet',c.versuche>=this.retry?'werkzeug_fehler':null]);
     if(c.versuche>=this.retry)await db.query('UPDATE reverse_auftraege SET versuch=$2 WHERE id=$1',[j.id,this.retry]);return null;
    }
    await db.query("UPDATE reverse_analyse_cache SET status='laeuft',lease_token=$2,lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond',versuche=versuche+1,updated_at=clock_timestamp() WHERE fingerabdruck=$1",[j.fingerabdruck,j.lease_token,this.leaseMs]);
    await db.query('UPDATE reverse_auftraege SET versuch=versuch+1 WHERE id=$1 AND lease_token=$2',[j.id,j.lease_token]);
    ownsCache=true;return undefined;
   });
   if(cache===null)return;
   let payload:AnalysePayload|undefined=cache;
   if(payload===undefined){
    const address=await reverseDateiSpeicherAdresse(this.pool,j.eintrag_id,String(d.id));
    // Extracted RV4 files use explicit trusted layout; originals use the RV5 canonical blob address.
    const layout=d.storage_key?.startsWith(j.eintrag_id+'/entpackt/')?this.adresse(j.eintrag_id,d.pfad,d.storage_key):address.adresse;
    source=await this.speicher.oeffneInspektionsQuelle(layout,d.storage_key);
    if(source.size!==Number(d.groesse))throw new Error('Reverse-Größe geändert');
    const stringsBudget=j.schicht==='S1'?Math.min(source.size,this.stringsBytes):0;
    const readBudget=this.cfg.inspektion.maxReadBytes-stringsBudget;
    if(readBudget<1)throw new Error('Reverse-Lesebudget zu klein für Inspektion und Strings');
    const started=Date.now(),r=await worker.inspiziereQuelle(source,{grenzen:{...this.cfg.inspektion,maxReadBytes:readBudget},timeoutMs:this.cfg.inspektion.timeoutMs});
    if(this.beendet)throw new Error('Reverse-Dienst beendet');
    if(r.sha256!==null&&r.sha256!==d.sha256)throw new Error('Reverse-Hash geändert');
    if(r.status==='fehler'||r.status==='quelle_nicht_gefunden')throw new Error('Reverse-Inspektion fehlgeschlagen');
    const sample=await source.readRange(0,Math.min(4096,source.size));
    // Magic and parsed ZIP entries, never filename extensions, establish managed formats.
    if(sample.length>=8&&sample.subarray(0,4).equals(Buffer.from([0,97,115,109]))&&sample.readUInt32LE(4)===1){
     r.format='wasm';r.asset_type='executable';r.metadata.architektur='wasm';r.metadata.bits=null;
    }else if(sample.length>=8&&sample.readUInt32BE(0)===0xcafebabe&&sample.readUInt16BE(6)>=45&&sample.readUInt16BE(6)<=100){
     r.format='class';r.asset_type='executable';r.metadata.architektur='jvm';r.metadata.bits=null;r.metadata.java_major=sample.readUInt16BE(6);
    }else if(r.format==='zip'){
     const names=new Set(r.objects.filter(o=>o.kind==='archive_entry').map(o=>o.name));
     if(names.has('AndroidManifest.xml')){r.format='apk';r.metadata.architektur='dalvik';}
     else if(names.has('META-INF/MANIFEST.MF')&&[...names].some(n=>n?.endsWith('.class'))){r.format='jar';r.metadata.architektur='jvm';}
    }
    let entropy=0;const counts=new Uint32Array(256);for(const b of sample)counts[b]++;
    for(const n of counts)if(n){const p=n/sample.length;entropy-=p*Math.log2(p);}
    const strings:string[]=[];
    if(j.schicht==='S1'){
     const maxBytes=Math.min(source.size,this.stringsBytes),min=num('SYNAPSE_REVERSE_STRINGS_MIN',4);
     let run='';const add=()=>{if(run.length>=min&&strings.length<this.cfg.inspektion.maxObjects)strings.push(run);run='';};
     for(let off=0;off<maxBytes&&strings.length<this.cfg.inspektion.maxObjects;off+=65536){
      if(Date.now()-started>this.cfg.inspektion.timeoutMs*2)throw new Error('Reverse-Zeitlimit');
      const bytes=await source.readRange(off,Math.min(65536,maxBytes-off));
      for(const b of bytes){if(b>=32&&b<=126){run+=String.fromCharCode(b);if(run.length>=4096)add();}else add();}
     }
     add();
    }
    const merkmale:string[]=[];
    const dotnet=r.metadata.dotnet as Row|undefined;
    if(dotnet?.vorhanden)merkmale.push('dotnet');if(r.metadata.pdb)merkmale.push('pdb');
    if(r.metadata.gestrippt===true)merkmale.push('gestrippt');
    if(entropy>7.2||r.objects.some(o=>o.kind==='sektion'&&Number(o.data.entropie)>7.2))merkmale.push('packer_verdacht');
    if(r.status==='teilweise'||j.schicht==='S1'&&source.size>this.stringsBytes)merkmale.push('teilweise');
    const {file_path:_path,...result}=r;
    const masked=maskiereReverseAnalyse({result,strings,metadata:{...r.metadata,inspektor_merkmale:r.metadata.merkmale,merkmale,
     format_specific:r.format_specific,warnings:r.warnings,magic_hex:sample.subarray(0,32).toString('hex'),entropie:entropy,packer_verdacht:merkmale.includes('packer_verdacht')},
     status:r.status==='ok'&&!merkmale.includes('teilweise')?'fertig':'teilweise',dauer_ms:Date.now()-started});
    payload=masked.wert as AnalysePayload;payload.metadata.maskiert_anzahl=masked.treffer;
    if(Buffer.byteLength(JSON.stringify(payload))>num('SYNAPSE_REVERSE_CACHE_BYTES',8388608))throw new Error('Reverse-Metadatenlimit');
    await source.pruefeUnveraendert();
   }
   await this.tx(async db=>{
    const live=(await db.query("SELECT 1 FROM reverse_auftraege WHERE id=$1 AND lease_token=$2 AND status='laeuft' AND lease_bis>clock_timestamp() FOR UPDATE",[j.id,j.lease_token])).rows[0];
    if(!live)return;
    if(ownsCache){
     const c=await db.query("UPDATE reverse_analyse_cache SET status=$3,ergebnis=$4::jsonb,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE fingerabdruck=$1 AND lease_token=$2 AND lease_bis>clock_timestamp() RETURNING fingerabdruck",[j.fingerabdruck,j.lease_token,payload.status,JSON.stringify(payload)]);
     if(!c.rowCount)throw new Error('Reverse-Cachelease verloren');
    }
    await this.materialisiere(db,j,payload);
    if(j.schicht==='S1')await this.s1Werkzeuge(db,j);
    await this.queue(db,{reverseId:j.eintrag_id,dateiId:j.datei_id,mediumId:j.medium_id,project:j.projekt??'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:j.ziel_schicht??'S3',prioritaet:j.prioritaet});
   });
  }catch{
   const failed=await this.pool.query("UPDATE reverse_auftraege SET status='fehler',fehlercode='werkzeug_fehler',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token]);
   if(ownsCache)await this.pool.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode='werkzeug_fehler',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE fingerabdruck=$1 AND lease_token=$2",[j.fingerabdruck,j.lease_token]);
   if(failed.rowCount)await this.pool.query("UPDATE reverse_schichten SET status='fehler',fehlercode='werkzeug_fehler' WHERE auftrag_id=$1 AND aktuell AND status IN ('offen','wartet','laeuft')",[j.id]);
  }finally{await source?.schliessen();}
 }
 async durchlauf():Promise<void>{
  if(this.beendet)return;await this.entdecke();
  await Promise.all(this.workers.map(async w=>{if(this.beendet)return;const j=await this.claim();if(j)await this.bearbeite(w,j);}));
 }
 async beende():Promise<void>{this.beendet=true;await Promise.all(this.workers.map(w=>w.beende()));}
}
/** Called only by the API lifecycle, never stdio or the PC daemon. */
export function starteReversePipeline():ApiAuftragsLoop|null{
 const cfg=getAssetKonfiguration();if(!cfg.reverse.aktiv)return null;
 const dienst=new ReversePipelineDienst({konfiguration:cfg});
 configureReverseRuntime({analysieren:(a,db)=>dienst.analysieren(a,db),abbrechen:(j,agent,db)=>dienst.abbrechen(j,agent,db),containerStatus:rid=>dienst.containerStatus(rid)});
 const loop=starteApiAuftragsLoop({intervallMs:cfg.sync.scanIntervallMs,arbeit:()=>imHintergrund(()=>dienst.durchlauf()),fehler:()=>console.error('[Reverse-Pipeline] Durchlauf fehlgeschlagen')});
 return {durchlauf:loop.durchlauf,beende:async()=>{await dienst.beende();await loop.beende();configureReverseRuntime({});}};
}
