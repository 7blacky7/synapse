/**
 * RV8: API-only scheduler and light S0/S1 inspection. PG transactions never perform FS or Docker work.
 * Container jobs are durable P20 requests, fenced by its server-side authority hooks.
 */
import {fordereReverseAdmission,reverseAdmission,ReverseAdmissionFehler,belegeReverseAdmission,pruefeReverseFachbindung} from './reverse-pipeline-halt.js';
import {aktuelleAgentAkteurIdentityId} from './agent-bezug.js';
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
import {ReverseFehler,configureReverseRuntime,reverseBisSchichtGrenze,begrenzeReverseSchicht,type ReverseAnalyseAnfrage} from './reverse-tool.js';
import {createWorkJobService,validateWorkResources,type WorkResourceNeed} from './work-jobs.js';
import {starteApiAuftragsLoop,type ApiAuftragsLoop} from './api-auftrags-loop.js';
import {reverseKindAusfuehrbar,reverseFehlerDeterministisch,zerlegeReverseFehlercode,reverseResourceNeedRoh,reverseStornoAnfordern} from './reverse-ausfuehrer.js';
import {leseReverseEinstellungen} from './reverse-einstellungen.js';
import {reverseEinstellSnapshot,leseReverseEinstellwerte,leseReverseBlockSchalter,reverseZahl,reverseBudget,type ReverseEinstellSnapshot} from './reverse-einstellwerte.js';
import {materialisiereS1InBloecken,veroeffentlicheS1Generation,materialisiereParserS1InBloecken} from './reverse-s1-bloecke.js';
import {leseReverseParserSchalter,publiziereReverseParser,REVERSE_PARSER_VERSION} from './reverse-parser-adapter.js';
import {leseReversePeRessourcenSchalter} from './reverse-pe-schalter.js';
import {leseProfilProduktSchalter} from './agent-profil-schalter.js';
import {starteReverseEntstoerer} from './reverse-entstoerer.js';
import {analysiereRv27} from './hex-rv27.js';
import {normalisiereS1,uebernehmeNormalisiert} from './reverse-normalisierer/s1.js';

import {bereiteReversePolicyPin,pruefeReversePolicyAuftrag,sperreReversePolicy,halteReversePolicyAuftrag,istReversePolicyFehler,ReversePolicyFehler} from './reverse-analyse-policy.js';
import {reverseNachzugAutoTakt} from './reverse-nachzug-auto.js';

type Row=Record<string,unknown>;
interface AnalysePayload {result:Omit<AssetResult,'file_path'>;strings:string[];metadata:Row;status:string;dauer_ms:number}
const STAGES=['E','S0','S1','S2','S3'] as const;
const OK=['fertig','teilweise'];
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** P18-T66/E1: Werkzeugstand der Container-Schichten, ausdrücklich gesetzt oder aus dem Image-Digest. Ein neues Image ergibt
 * einen neuen Fingerabdruck, damit leben Fehler des alten Werkzeugs automatisch wieder auf. */
function reverseContainerWerkzeugVersion():string{
 const v=process.env.SYNAPSE_REVERSE_WERKZEUG_VERSION?.trim();if(v)return v;
 const d=process.env.SYNAPSE_REVERSE_IMAGE?.trim().match(/@(sha256:[a-f0-9]{64})$/);
 return d?'image:'+d[1]:'nicht-konfiguriert';
}
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
/** ausfuehrbareKinds: nur Tests; sonst gilt die Ausführer-Registry (P18-T64). */
export interface ReversePipelineOptionen {pool?:Pool;konfiguration?:AssetKonfiguration;speicher?:AssetSpeicher;ausfuehrbareKinds?:string[]}
export class ReversePipelineDienst{
 /** Vorhandener Core-Export als Anschluss für den API-Executor, kanonische Implementierung bleibt im Halt-Modul. */
 static readonly pruefeFachbindung=pruefeReverseFachbindung;
 static readonly AdmissionFehler=ReverseAdmissionFehler;
 private readonly pool:Pool;
 private readonly cfg:AssetKonfiguration;
 private readonly speicher:AssetSpeicher;
 private readonly workers:AssetInspektionsWorker[];
 private profile='';
 private readonly version:string;
 private retry=0;
 private readonly leaseMs:number;
 private stringsBytes=0;
 /** P18-T86: wirksame Pipeline-Werte aus reverse_einstellungen (global), je Durchlauf neu gelesen; vor dem ersten Lesen Katalogstandard. */
 private w={stringsMin:1,parallel:1,discovery:1,durchlaufMs:1,spoolBytes:1,stichprobe:1,entropieMilli:0};
 private ein:ReverseEinstellSnapshot=reverseEinstellSnapshot([]);
 /** P18-T88: Produkt-Schalter reverse_blockuebernahme (Standard AUS), je Durchlauf gelesen. Nur S1 bekommt damit ein eigenes Profil. */
 private s1Bloecke=false;
 private parserAdapter=false;
 private readonly kinds?:string[];
 private beendet=false;
 constructor(o:ReversePipelineOptionen={}){
  this.pool=o.pool??getPool();this.cfg=o.konfiguration??getAssetKonfiguration();this.kinds=o.ausfuehrbareKinds;
  this.speicher=o.speicher??new AssetSpeicher({konfiguration:this.cfg});
  this.version=hash(standardRegistry.list().map(i=>[i.id,i.version]).sort());
  this.leaseMs=this.cfg.inspektion.timeoutMs*2+WORKER_GNADENFRIST_MS+this.cfg.speicher.timeoutMs;
  this.workers=[];this.uebernehmeWerte(this.ein);
 }
 /**
  * P18-T86: Pipeline-Werte aus einem Einstellungs-Snapshot (Env ist nur noch Migrationsvorschlag). Bei Standardwerten bleibt das
  * Profil bitgleich zum Stand vor T86; nur abweichende Stichprobe/Packer-Schwelle gehen zusaetzlich ein (dann neuer Lauf).
  */
 private uebernehmeWerte(s:ReverseEinstellSnapshot):void{
  const z=(n:Parameters<typeof reverseZahl>[1])=>reverseZahl(s,n);
  this.ein=s;this.retry=z('retry_max');
  this.stringsBytes=Math.min(reverseBudget(s,'s1_strings_schritt_bytes'),Math.floor(this.cfg.inspektion.maxReadBytes/2));
  this.w={stringsMin:z('s1_strings_min_zeichen'),parallel:z('pipeline_parallel'),discovery:z('pipeline_discovery_block'),durchlaufMs:z('pipeline_durchlauf_ms'),
   spoolBytes:z('analyse_spool_block_bytes'),stichprobe:z('analyse_stichprobe_bytes'),entropieMilli:z('packer_entropie_millibit')};
  const abweichend=(['analyse_stichprobe_bytes','packer_entropie_millibit'] as const).some(n=>s.werte[n].wert!==s.werte[n].standard);
  this.profile=hash({engine:'reverse-api-s0s1-v2-rv14',version:process.env.SYNAPSE_REVERSE_PROFIL_VERSION??'1',limits:this.cfg.inspektion,
   stringsBytes:this.stringsBytes,stringsMin:this.w.stringsMin,...(abweichend?{stichprobe:this.w.stichprobe,entropie_millibit:this.w.entropieMilli}:{})});
  while(this.workers.length<this.w.parallel)this.workers.push(new AssetInspektionsWorker());
 }
 /** Je Durchlauf die globalen Werte neu lesen; nicht lesbar oder inkonsistent: bisherige Werte bleiben. */
 private async einstellungen():Promise<void>{
   this.s1Bloecke=(await leseReverseBlockSchalter(this.pool)).aktiv;
   this.parserAdapter=(await leseReverseParserSchalter(this.pool)).aktiv;
  const s=await leseReverseEinstellwerte({},this.pool);
  if(s.letzter_fehler){console.warn('[Reverse-Pipeline] Einstellungen nicht verwendbar, bisherige Werte bleiben:',s.letzter_fehler);return;}
  if(s.revision!==this.ein.revision)this.uebernehmeWerte(s);
 }
 private async tx<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}
  catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e;}finally{db.release();}
 }
 /** E output depends on the effective global feature values, not on the requesting project. */
 private async eProfil():Promise<string>{
  const pe=await leseReversePeRessourcenSchalter();
   return hash({basis:this.profile,pe_ressourcen:pe.aktiv});
 }
 /** P18-T88: S1 im Blockweg ist ein anderes (vollständiges) Ergebnis und bekommt einen eigenen Fingerabdruck; S0/S2/S3 bleiben unverändert. */
 private s1BlockProfil():string{return hash([this.profile,'s1-bloecke-v1']);}
 private s1ParserProfil():string{return 'parser-s1:'+hash([this.profile,REVERSE_PARSER_VERSION]);}
 private profilFuer(stage:string):string{return stage==='S1'&&this.parserAdapter?this.s1ParserProfil():stage==='S1'&&this.s1Bloecke?this.s1BlockProfil():this.profile;}
 private async naechste(db:PoolClient,rid:string,file:string|null,medium:string|null,target:string):Promise<string|null>{
  if(!file)return 'E';
  const layers=(await db.query('SELECT schicht,status,werkzeug_version,profil_version FROM reverse_schichten WHERE datei_id=$1 AND aktuell',[file])).rows;
  for(const stage of STAGES.slice(1)){
   if(STAGES.indexOf(stage)>STAGES.indexOf(target as typeof STAGES[number]))return null;
   const row=layers.find(x=>x.schicht===stage);if(!row||!OK.includes(row.status)||row.profil_version!==this.profilFuer(stage)||row.werkzeug_version!==(stage==='S0'||stage==='S1'?this.version:reverseContainerWerkzeugVersion()))return stage;
  }
  return null;
 }
 /** P18-T64: gibt es einen angemeldeten Ausführer für diesen Container-Kind? */
 private kindOk(stage:string):boolean{return reverseKindAusfuehrbar('reverse-'+stage,this.kinds);}
 /** Endgültiger Fehler mit echtem Code: Auftrag und aktuelle Schicht stehen danach auf 'fehler'. */
 private async endgueltig(db:PoolClient,id:unknown,code:string):Promise<void>{
  await db.query("UPDATE reverse_auftraege SET status='fehler',fehlercode=$2,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1",[id,code]);
  await db.query("UPDATE reverse_schichten SET status='fehler',fehlercode=$2 WHERE auftrag_id=$1 AND aktuell AND status IN ('offen','wartet','laeuft')",[id,code]);
 }
 private async containerAuftrag(db:PoolClient,j:Row,sha:string,stage:string):Promise<string|null>{
  const raw=reverseResourceNeedRoh('reverse-'+stage),profile=process.env.SYNAPSE_REVERSE_CONTAINER_PROFIL;
  if(!raw||!profile)return null;
  const resources=validateWorkResources(JSON.parse(raw));
  if(resources.cpu<=0||resources.ram<=0)throw new Error('Reverse-Containerprofil benötigt CPU/RAM');
  await db.query("INSERT INTO reverse_analyse_cache(fingerabdruck,sha256,schicht,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[j.fingerabdruck,sha,stage,j.werkzeug,j.werkzeug_version,j.profil_version]);
  const cached=(await db.query('SELECT * FROM reverse_analyse_cache WHERE fingerabdruck=$1 FOR UPDATE',[j.fingerabdruck])).rows[0];
  let workId=cached.p20_auftrag_id,letzterFehler:string|null=null;
  // R4: Erfolg einer belegten Vorgängergeneration verbraucht kein Fehlerbudget.
  // Nur den Zähler übernehmen; Job/Fachlink bleiben durch den folgenden Eigentümerfilter getrennt.
  if(stage==='E'&&workId){
   const vorher=(await db.query('SELECT w.id::text,w.kind,w.capability,w.project,w.scope,w.input_ref AS "inputRef",w.profile_id AS "profileId",w.state,r.status AS fachstatus FROM work_jobs w JOIN reverse_auftraege r ON r.p20_auftrag_id=w.id WHERE w.id=$1',[workId])).rows[0];
   if(vorher?.state==='completed'&&vorher.fachstatus==='fertig'&&!await pruefeReverseFachbindung(db,vorher))cached.versuche=0;
  }
   // Kein fremder/alter Job wird nachträglich mit einem Zulassungsbeleg versehen.
   if(workId){const owner=(await db.query("SELECT id,uebernahme->'admission' AS admission FROM reverse_auftraege WHERE p20_auftrag_id=$1",[workId])).rows;
    if(owner.length!==1||String(owner[0].id)!==String(j.id)||!owner[0].admission)workId=null;}
  if(workId&&j.policy_pin){const owners=await db.query("SELECT 1 FROM reverse_auftraege WHERE p20_auftrag_id=$1 AND (policy_pin IS NULL OR fehlercode LIKE 'policy_%') LIMIT 1",[workId]);if(owners.rowCount)workId=null;}
  if(workId){
   const work=(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[workId])).rows[0];
   // A completed E job has already imported its files and will never call the importer for a new Fachauftrag.
   // Start a fresh generation (including after a successful previous run), while live pending/leased jobs still deduplicate.
   if(stage==='E'&&work?.state==='completed')workId=null;
   if(work?.state==='cancelled'||work?.state==='failed'||work?.state==='expired'){letzterFehler=work.state==='failed'&&work.error_code?String(work.error_code):null;workId=null;}
  }
  if(!workId){
   // P18-T64: fachliche Fehler (z. B. format_nicht_unterstuetzt) scheitern identisch erneut -> nicht still wiederholen.
   if(letzterFehler&&reverseFehlerDeterministisch(letzterFehler)){
    await db.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode=$2 WHERE fingerabdruck=$1",[j.fingerabdruck,letzterFehler]);
    await this.endgueltig(db,j.id,letzterFehler);return null;
   }
   if(Number(cached.versuche)>=this.retry){
    const code=letzterFehler??'werkzeug_fehler';
    await db.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode=$2 WHERE fingerabdruck=$1",[j.fingerabdruck,code]);
    await this.endgueltig(db,j.id,code);
    await db.query('UPDATE reverse_auftraege SET versuch=$2 WHERE id=$1',[j.id,this.retry]);return null;
   }
   const generation=Number(cached.versuche)+1;
   // P18-T66/F1: reverse(analysieren) setzt versuche zurück; der Schlüssel zählt deshalb alle bisherigen Work-Jobs dieses
   // Fingerabdrucks (unter der Cache-Zeilensperre), sonst trifft er einen alten failed-Job (idempotency_conflict bzw. toter Job).
   const runde=Number((await db.query('SELECT count(*)::int AS n FROM work_jobs WHERE idempotency_key LIKE $1',['reverse:'+String(j.fingerabdruck)+':%'])).rows[0].n)+1;
   const work=await createWorkJobService({pool:this.pool}).enqueue({kind:'reverse-'+stage,capability:'reverse_bibliothek',profileId:profile,
    // P18-T69: Container-Work-Jobs laufen immer im Systemprojekt (der Executor nimmt nur reverse-bibliothek an); das anfragende
    // Projekt bleibt in reverse_auftraege.projekt. Vorher blieben manuelle Anforderungen aus einem Projekt ewig pending.
    project:'reverse-bibliothek',scope:'reverse',inputRef:{scope:'reverse',id:String(j.eintrag_id),revision:String(j.datei_id??j.medium_id),sha256:sha},
    resourceNeed:resources,priority:j.prioritaet as 'interaktiv'|'hintergrund'|'nachzug',idempotencyKey:'reverse:'+String(j.fingerabdruck)+':'+runde+':'+randomUUID()},db);
   workId=work.id;
   await db.query('UPDATE reverse_analyse_cache SET p20_auftrag_id=$2,quell_auftrag_id=$3,versuche=$4,updated_at=clock_timestamp() WHERE fingerabdruck=$1',[j.fingerabdruck,workId,j.id,generation]);
  }
  await db.query('UPDATE reverse_auftraege SET p20_auftrag_id=$2,fehlercode=NULL WHERE id=$1',[j.id,workId]);
  if(stage==='E'||stage==='S3')await belegeReverseAdmission(db,String(workId),String(j.id));
   if(j.prioritaet==='interaktiv')await db.query("UPDATE work_jobs SET priority='interaktiv',updated_at=clock_timestamp() WHERE id=$1 AND state='pending'",[workId]);
  return workId;
 }
 /** S1 inspector output remains usable while optional container enrichment waits. */
 private async s1Werkzeuge(db:PoolClient,j:Job):Promise<void>{
  const policy=await pruefeReversePolicyAuftrag(db,j.id,j.eintrag_id,'S1');
  // P18-T64: ohne Ausführer für reverse-S1 keine ergänzenden Container-Aufträge (sonst ewig pending, Plätze belegt).
  if(!this.kindOk('S1'))return;
  const d=(await db.query('SELECT sha256 FROM reverse_dateien WHERE id=$1',[j.datei_id])).rows[0];
  const version=reverseContainerWerkzeugVersion();
  const fp=reverseAnalyseFingerabdruck(d.sha256,'S1','reverse-S1',version,this.profile);
  let supplementary=(await db.query("SELECT * FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id=$2 AND schicht='S1' AND ausfuehrung='container' AND status IN ('offen','wartet','laeuft') FOR UPDATE",[j.eintrag_id,j.datei_id])).rows[0];
  if(!supplementary&&!await this.queuePlatz(db))return;
  if(!supplementary)supplementary=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,prioritaet,status,ausloeser,ausfuehrung,fingerabdruck,ziel_schicht,projekt,werkzeug,werkzeug_version,profil_version,policy_pin) VALUES($1,$2,'S1',$3,'wartet','pipeline:s1-tools','container',$4,$5,$6,'reverse-S1',$7,$8,$9::jsonb) RETURNING *",[j.eintrag_id,j.datei_id,j.prioritaet,fp,j.ziel_schicht,j.projekt,version,this.profile,JSON.stringify({...policy,ursprung:'folge'})])).rows[0];
  if(!await this.containerAuftrag(db,supplementary,d.sha256,'S1'))await db.query("UPDATE reverse_auftraege SET fehlercode='container_gesperrt' WHERE id=$1 AND status<>'fehler'",[supplementary.id]);
 }
 /** Global admission shares the caller's transaction. Only a locked, replaced request may give up its slot. */
 private async queuePlatz(db:PoolClient,ersetzt?:Row):Promise<boolean>{
  await db.query("SELECT pg_advisory_xact_lock(hashtext('reverse-queue-annahme'))");
  const s=await leseReverseEinstellwerte({},db);
  if(s.letzter_fehler||s.migrationsbedarf.some(x=>x.name==='queue_offene_max'))throw new ReversePolicyFehler('policy_nicht_lesbar');
  const n=(await db.query("SELECT count(*) AS n FROM reverse_auftraege WHERE status IN ('offen','wartet','laeuft') AND ($1::uuid IS NULL OR id<>$1::uuid)",[ersetzt?.id??null])).rows[0].n;
  return BigInt(n)<BigInt(reverseZahl(s,'queue_offene_max'));
 }
 private async queue(db:PoolClient,a:ReverseAnalyseAnfrage):Promise<Row>{
  // Nur die mutationsfreie frühe Ablehnung darf normal zurückkehren.
  try{await fordereReverseAdmission(db);}catch(e){
   if(e instanceof ReverseAdmissionFehler)return {status:'gehalten',fehlercode:e.code,auftrag_id:null};throw e;
  }
  try{return await this.queueMitPolicy(db,a);}catch(e){
   if(!istReversePolicyFehler(e))throw e;
   if(e.auftragId)await halteReversePolicyAuftrag(db,e.auftragId,a.reverseId,e.code);
   return {status:'fehler',fehlercode:e.code,auftrag_id:e.auftragId??null,schicht_angefragt:a.bisSchicht};
  }
 }
 private async queueMitPolicy(db:PoolClient,a:ReverseAnalyseAnfrage):Promise<Row>{
  const neuId=randomUUID();
  const pin=await bereiteReversePolicyPin(db,{...a,id:neuId,angefragt:a.bisSchicht,manuell:a.policyManuell,elternId:a.policyElternId});
  a={...a,bisSchicht:pin.wirksam_bis,project:pin.project??'reverse-bibliothek'};
  if(a.policyManuell&&pin.wirksam_bis==='S3'){const nachzug=await this.reiheS3NachzugEin(db,a,neuId,pin);if(nachzug)return nachzug;}
  // The combined Ghidra backend may run only when the effective policy includes S3.
  const offen=await this.naechste(db,a.reverseId,a.dateiId,a.mediumId,a.bisSchicht);
  const stage=offen==='S2'?'S3':offen;
  if(!stage){
   if(a.policyManuell)await db.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,medium_id,schicht,prioritaet,status,ausloeser,projekt,ziel_schicht,policy_pin) VALUES($1,$2,$3,$4,$5,$6,'fertig',$7,$8,$5,$9::jsonb)",[neuId,a.reverseId,a.dateiId,a.dateiId?null:a.mediumId,a.bisSchicht,a.prioritaet,'agent:'+a.agentId,a.project,JSON.stringify(pin)]);
   return {status:'fertig',schicht:a.bisSchicht,auftrag_id:a.policyManuell?neuId:null,policy_pin:pin};
  }
  if(stage==='S3'&&pin.wirksam_bis!=='S3')throw new ReversePolicyFehler('policy_grenze');
  // P18-T69/E5: S3 nur mit Produkt-Schalter reverse_s3 (Standard AUS). Aus: nichts anlegen, nichts einreihen.
  if(stage==='S3'){
   const schalter=await leseProfilProduktSchalter('reverse_s3',a.project);
   if(!schalter.aktiv)return {status:'fehler',fehlercode:'kein_ausfuehrer',fehler_detail:schalter.letzter_fehler??'reverse_s3_aus',schicht_angefragt:a.bisSchicht,auftrag_id:null,eta:null};
  }
  const file=a.dateiId?(await db.query('SELECT sha256,medium_id FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2',[a.dateiId,a.reverseId])).rows[0]:null;
  const medium=!a.dateiId?(await db.query('SELECT satz_sha256 FROM reverse_medien WHERE id=$1 AND eintrag_id=$2',[a.mediumId,a.reverseId])).rows[0]:null;
  const sha=String(file?.sha256??medium?.satz_sha256??'');
  if(!/^[a-f0-9]{64}$/.test(sha))return {status:'wartet',fehlercode:'schicht_nicht_fertig',auftrag_id:null};
  const local=stage==='S0'||stage==='S1',tool=local?'asset-inspektoren':'reverse-'+stage;
  const version=local?this.version:reverseContainerWerkzeugVersion();
  const profil=stage==='E'?await this.eProfil():this.profilFuer(stage);
  // E publishes physical files for one entry/medium; unlike code analysis it cannot share an imported output across entries.
  const fp=reverseAnalyseFingerabdruck(stage==='E'?hash([sha,a.reverseId,a.mediumId]):sha,stage,tool,version,profil);
  const exhausted=(await db.query(local?"SELECT r.id,COALESCE(c.fehlercode,r.fehlercode) AS fehlercode FROM reverse_auftraege r LEFT JOIN reverse_analyse_cache c ON c.fingerabdruck=r.fingerabdruck WHERE r.eintrag_id=$1 AND r.datei_id IS NOT DISTINCT FROM $2::bigint AND r.medium_id IS NOT DISTINCT FROM $3::bigint AND r.fingerabdruck=$4 AND r.status='fehler' AND r.versuch>=$5 LIMIT 1":"SELECT r.id,COALESCE(c.fehlercode,r.fehlercode) AS fehlercode FROM reverse_auftraege r LEFT JOIN reverse_analyse_cache c ON c.fingerabdruck=r.fingerabdruck WHERE r.eintrag_id=$1 AND r.datei_id IS NOT DISTINCT FROM $2::bigint AND r.medium_id IS NOT DISTINCT FROM $3::bigint AND r.fingerabdruck=$4 AND r.status='fehler' AND r.versuch>=$5 AND NOT EXISTS(SELECT 1 FROM reverse_auftraege n WHERE n.eintrag_id=r.eintrag_id AND n.datei_id IS NOT DISTINCT FROM r.datei_id AND n.medium_id IS NOT DISTINCT FROM r.medium_id AND n.schicht=r.schicht AND (n.created_at,n.id)>(r.created_at,r.id)) ORDER BY r.created_at DESC,r.id DESC LIMIT 1",[a.reverseId,a.dateiId,a.dateiId?null:a.mediumId,fp,this.retry])).rows[0];
  if(exhausted&&!a.policyManuell){
   // P18-T66/E2: echten Code melden und die Schicht nicht dauerhaft auf 'wartet' stehen lassen.
   const code=String(exhausted.fehlercode??'werkzeug_fehler');
   await db.query("UPDATE reverse_schichten SET status='fehler',fehlercode=$2 WHERE auftrag_id=$1 AND aktuell AND status IN ('offen','wartet','laeuft')",[exhausted.id,code]);
   return {status:'fehler',fehlercode:zerlegeReverseFehlercode(code).code??'werkzeug_fehler',auftrag_id:exhausted.id};
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-pipeline:'+a.reverseId+':'+(a.dateiId??'m'+a.mediumId)+':'+stage]);
  // Adopt RV9 waiting requests instead of creating a parallel executable job.
  // R5: nur die jüngste Fachgeneration des bestehenden Ausführungswegs; alte Rückhaltzeilen bleiben historisch.
  let j=(await db.query(local?"SELECT * FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint AND ($2::bigint IS NOT NULL OR medium_id IS NOT DISTINCT FROM $4::bigint) AND schicht=$3 AND status IN ('offen','wartet','laeuft','fehler') AND (fingerabdruck IS NULL OR ausfuehrung=$5) ORDER BY (status IN ('offen','wartet','laeuft')) DESC,created_at DESC,id DESC LIMIT 1 FOR UPDATE":"SELECT * FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint AND ($2::bigint IS NOT NULL OR medium_id IS NOT DISTINCT FROM $4::bigint) AND schicht=$3 AND (fingerabdruck IS NULL OR ausfuehrung=$5) ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[a.reverseId,a.dateiId,stage,a.dateiId?null:a.mediumId,local?'api':'container'])).rows[0];
  // Defer manual replacement until admission; a rejected request must not invalidate the old pin.
  let ersetzt:Row|undefined,ersetzCode:ReversePolicyFehler['code']='policy_geaendert',generationWechsel=false;
  if(j){
   try{await pruefeReversePolicyAuftrag(db,String(j.id),a.reverseId,stage);}catch(e){
    if(!istReversePolicyFehler(e))throw e;
    if(!a.policyManuell){await halteReversePolicyAuftrag(db,String(j.id),a.reverseId,e.code);return {auftrag_id:j.id,status:'fehler',fehlercode:e.code};}
    ersetzt=j;ersetzCode=e.code;j=undefined;
   }
   if(j&&a.policyManuell){ersetzt=j;j=undefined;}
  }
  if(j?.status==='laeuft'&&j.fingerabdruck!==fp)return {auftrag_id:j.id,status:'wartet',fehlercode:'schicht_nicht_fertig'};
  if(stage==='E'&&j?.p20_auftrag_id&&j.fingerabdruck!==fp){
   const active=(await db.query("SELECT 1 FROM work_jobs WHERE id=$1 AND state IN ('pending','leased','staged')",[j.p20_auftrag_id])).rowCount;
   // Keep the import/fence binding until this E run finishes. Discovery then observes the changed feature profile.
   if(active)return {auftrag_id:j.id,status:'wartet',fehlercode:'schicht_nicht_fertig'};
  }
  const ohneAusfuehrer=!local&&!this.kindOk(stage);
  // P18-T64: 'kein_ausfuehrer' lebt wieder auf, sobald ein Ausführer angemeldet ist; andere Fehler bleiben stehen.
  // P18-T66/E1: ein neuer Werkzeugstand (anderer Fingerabdruck) belebt auch fachliche Fehler des alten Werkzeugs wieder.
  const wiederbeleben=j?.status==='fehler'&&!String(j.fehlercode??'').startsWith('policy_')&&!ohneAusfuehrer&&(j.fehlercode==='kein_ausfuehrer'||(!!j.fingerabdruck&&j.fingerabdruck!==fp));
  if(j?.status==='fehler'&&j.fingerabdruck===fp&&!wiederbeleben)return {auftrag_id:j.id,status:'fehler',fehlercode:j.fehlercode};
  // T64/T66 entscheidet VOR dem Generationswechsel: Fach-Endgültigkeit bleibt erhalten.
  if(j&&!local&&j.p20_auftrag_id){
   const old=(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[j.p20_auftrag_id])).rows[0];
   if(old?.state==='failed'&&old.error_code&&j.fingerabdruck===fp&&reverseFehlerDeterministisch(String(old.error_code))){
    const code=String(old.error_code);
    await db.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode=$2 WHERE fingerabdruck=$1",[fp,code]);
    await this.endgueltig(db,j.id,code);
    return {auftrag_id:j.id,status:'fehler',fehlercode:code};
   }
   // Nur der nach alter Semantik zulässige Retry erhält einen neuen Fach/Job/Beleg-Kontext.
   if(old&&['failed','expired','cancelled','completed'].includes(String(old.state))){
    ersetzt=j;generationWechsel=true;j=undefined;
   }
  }
  if((!j||wiederbeleben)&&!await this.queuePlatz(db,ersetzt)){
   if(a.policyManuell)throw new ReverseFehler('warteschlange_voll');
   return {success:false,status:'fehler',fehlercode:'warteschlange_voll',auftrag_id:null,schicht_angefragt:a.bisSchicht};
  }
  if(ersetzt){
   if(generationWechsel)await db.query("UPDATE reverse_auftraege SET status=CASE WHEN status IN('offen','wartet','laeuft') THEN 'fehler' ELSE status END,fehlercode=CASE WHEN status IN('offen','wartet','laeuft') THEN 'reverse_generation_abgeloest' ELSE fehlercode END,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1",[ersetzt.id]);
   else await halteReversePolicyAuftrag(db,String(ersetzt.id),a.reverseId,ersetzCode);
  }
  if(!j)j=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,medium_id,schicht,prioritaet,status,ausloeser,trigger_identity_id,id,policy_pin) VALUES($1,$2,$3,$4,$5,'wartet',$6,$7,$8,$9::jsonb) RETURNING *",[a.reverseId,a.dateiId,a.dateiId?null:a.mediumId,stage,a.prioritaet,'agent:'+a.agentId,aktuelleAgentAkteurIdentityId(a.agentId),neuId,JSON.stringify(pin)])).rows[0];
  await db.query("UPDATE reverse_auftraege SET medium_id=CASE WHEN datei_id IS NOT NULL THEN NULL ELSE medium_id END,fingerabdruck=$2,ziel_schicht=COALESCE(ziel_schicht,$3),projekt=COALESCE(projekt,$4),ausfuehrung=$5,werkzeug=$6,werkzeug_version=$7,profil_version=$8,prioritaet=CASE WHEN prioritaet='interaktiv' OR $9='interaktiv' THEN 'interaktiv' ELSE prioritaet END,updated_at=clock_timestamp() WHERE id=$1",
   [j.id,fp,a.bisSchicht,a.project,local?'api':'container',tool,version,profil,a.prioritaet]);
  const prior=(await db.query('SELECT * FROM reverse_schichten WHERE datei_id IS NOT DISTINCT FROM $1::bigint AND medium_id IS NOT DISTINCT FROM $2::bigint AND schicht=$3 AND aktuell',[a.dateiId,a.dateiId?null:a.mediumId,stage])).rows[0];
  // P18-T88: Im S1-Blockweg bleibt eine lesbare alte S1-Schicht aktuell, bis veroeffentlicheS1Generation in einer TX umschaltet.
  const vorlauf=stage==='S1'&&(profil===this.s1BlockProfil()||profil.startsWith('parser-s1:'))&&!!prior&&prior.fingerabdruck!==fp&&OK.includes(prior.status);
  if(prior&&prior.fingerabdruck!==fp&&!vorlauf)await db.query('UPDATE reverse_schichten SET aktuell=false WHERE id=$1',[prior.id]);
  await db.query("INSERT INTO reverse_schichten(datei_id,medium_id,schicht,fingerabdruck,status,werkzeug,werkzeug_version,profil_version,auftrag_id,aktuell) VALUES($1,$2,$3,$4,'wartet',$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
   [a.dateiId,a.dateiId?null:a.mediumId,stage,fp,tool,version,profil,j.id,!vorlauf]);
  await db.query('UPDATE reverse_schichten SET aktuell=$6,auftrag_id=$5 WHERE datei_id IS NOT DISTINCT FROM $1::bigint AND medium_id IS NOT DISTINCT FROM $2::bigint AND schicht=$3 AND fingerabdruck=$4',[a.dateiId,a.dateiId?null:a.mediumId,stage,fp,j.id,!vorlauf]);
  if(wiederbeleben){
   await db.query("UPDATE reverse_auftraege SET status='wartet',fehlercode=NULL,versuch=0,updated_at=clock_timestamp() WHERE id=$1",[j.id]);
   await db.query("UPDATE reverse_schichten SET status='wartet',fehlercode=NULL WHERE auftrag_id=$1 AND aktuell AND fehlercode='kein_ausfuehrer'",[j.id]);
   j={...j,status:'wartet',fehlercode:null};
  }
  if(ohneAusfuehrer){
   await this.endgueltig(db,j.id,'kein_ausfuehrer');
   return {auftrag_id:j.id,status:'fehler',fehlercode:'kein_ausfuehrer',schicht_angefragt:a.bisSchicht,eta:null};
  }
  if(!local){
   const work=await this.containerAuftrag(db,{...j,fingerabdruck:fp,werkzeug:tool,werkzeug_version:version,profil_version:profil,projekt:j.projekt??a.project,prioritaet:j.prioritaet==='interaktiv'?'interaktiv':a.prioritaet},sha,stage);
   if(!work){
    const nach=(await db.query('SELECT status,fehlercode FROM reverse_auftraege WHERE id=$1',[j.id])).rows[0];
    if(nach?.status==='fehler')return {auftrag_id:j.id,status:'fehler',fehlercode:nach.fehlercode,schicht_angefragt:a.bisSchicht,eta:null};
    await db.query("UPDATE reverse_auftraege SET fehlercode='container_gesperrt' WHERE id=$1",[j.id]);
   }
  }
  return {auftrag_id:j.id,status:j.status??'wartet',schicht_angefragt:a.bisSchicht,eta:null,...(!local?{fehlercode:'container_ruht'}:{})};
 }
 /** Ungültige Artefakte dürfen einen frischen Lauf nicht dauerhaft verdrängen; nur PG, keine FS-Arbeit im Tool. */
 private async verwerfeS3Artefakt(db:PoolClient,rid:string,did:string,grund:string):Promise<void>{
  await db.query("UPDATE reverse_dateien SET metadaten=(metadaten-'s3_artefakt')||jsonb_build_object('s3_nachzug_fehler',$3::text) WHERE id=$1 AND eintrag_id=$2",[did,rid,grund]);
  await db.query("UPDATE reverse_analyse_cache SET status='wartet',p20_auftrag_id=NULL,versuche=0 WHERE fingerabdruck IN (SELECT fingerabdruck FROM reverse_schichten WHERE datei_id=$1 AND schicht='S3' AND aktuell)",[did]);
  await db.query("UPDATE reverse_schichten SET status='fehler',fehlercode='werkzeug_fehler' WHERE datei_id=$1 AND schicht='S3' AND aktuell",[did]);
 }
 /** Ein Budget-Nachzug übernimmt das bereits geprüfte Manifest; kein neuer Containerauftrag. */
 private async reiheS3NachzugEin(db:PoolClient,a:ReverseAnalyseAnfrage,neuId:string,pin:Awaited<ReturnType<typeof bereiteReversePolicyPin>>):Promise<Row|null>{
  if(!a.dateiId||a.bisSchicht!=='S3')return null;
  const d=(await db.query("SELECT d.sha256,d.metadaten,s.fingerabdruck FROM reverse_dateien d JOIN reverse_schichten s ON s.datei_id=d.id AND s.schicht='S3' AND s.aktuell WHERE d.id=$1 AND d.eintrag_id=$2",[a.dateiId,a.reverseId])).rows[0];
  const artefakt=d?.metadaten?.s3_artefakt,speicher=d?.metadaten?.s3_speicher;
  if(!speicher?.fehlend_gesamt)return null;
  if(!artefakt||artefakt.sha256!==d.sha256||artefakt.fingerabdruck!==d.fingerabdruck){
   await this.verwerfeS3Artefakt(db,a.reverseId,a.dateiId,!artefakt?'s3_artefakt_fehlt':'s3_artefakt_veraltet');return null;
  }
  const schalter=await leseProfilProduktSchalter('reverse_s3',a.project);
  if(!schalter.aktiv)return {status:'fehler',fehlercode:'kein_ausfuehrer',fehler_detail:'reverse_s3_aus',auftrag_id:null};
  const stand=await leseReverseEinstellungen(a.project,undefined,a.reverseId),budget=stand.werte.s3_pg_budget_bytes.wert;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['reverse-pipeline:'+a.reverseId+':'+a.dateiId+':S3']);
  const aktiv=(await db.query("SELECT id,status FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id=$2 AND schicht='S3' AND status IN ('offen','wartet','laeuft') ORDER BY created_at LIMIT 1 FOR UPDATE",[a.reverseId,a.dateiId])).rows[0];
  if(!await this.queuePlatz(db,aktiv))throw new ReverseFehler('warteschlange_voll');
  if(aktiv)await halteReversePolicyAuftrag(db,String(aktiv.id),a.reverseId,'policy_geaendert');
  const fp=hash([d.fingerabdruck,'nachzug',budget]);
  const j=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,datei_id,schicht,prioritaet,status,ausloeser,trigger_identity_id,ausfuehrung,fingerabdruck,ziel_schicht,projekt,werkzeug,werkzeug_version,profil_version,id,policy_pin) VALUES($1,$2,'S3',$3,'wartet',$4,$5,'api',$6,$7,$8,'reverse-S3-nachzug','1',$9,$10,$11::jsonb) RETURNING id",[a.reverseId,a.dateiId,a.prioritaet,'agent:'+a.agentId,aktuelleAgentAkteurIdentityId(a.agentId),fp,a.bisSchicht,a.project,this.profile,neuId,JSON.stringify(pin)])).rows[0];
  return {auftrag_id:j.id,status:'wartet',nachzug:true,schicht_angefragt:a.bisSchicht,eta:null};
 }
 private async uebernehmeS3Nachzug(j:Job):Promise<void>{
  try{
   const schalter=await leseProfilProduktSchalter('reverse_s3',j.projekt);
   if(!schalter.aktiv)throw Error('reverse_s3_aus');
   await this.tx(async db=>{
    await pruefeReversePolicyAuftrag(db,j.id,j.eintrag_id,'S3');
    const live=(await db.query("SELECT id FROM reverse_auftraege WHERE id=$1 AND lease_token=$2 AND status='laeuft' AND lease_bis>clock_timestamp() FOR UPDATE",[j.id,j.lease_token])).rows[0];
    if(!live)return;
    const stand=await leseReverseEinstellungen(j.projekt,undefined,j.eintrag_id);
    await db.query("UPDATE reverse_auftraege SET versuch=versuch+1,lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token,stand.werte.s3_nachzug_lease_ms.wert]);
    const d=(await db.query("SELECT d.sha256,d.metadaten,s.fingerabdruck FROM reverse_dateien d JOIN reverse_schichten s ON s.datei_id=d.id AND s.schicht='S3' AND s.aktuell WHERE d.id=$1 AND d.eintrag_id=$2",[j.datei_id,j.eintrag_id])).rows[0],artefakt=d?.metadaten?.s3_artefakt;
    if(!artefakt||artefakt.sha256!==d.sha256||artefakt.fingerabdruck!==d.fingerabdruck)throw Error('s3_artefakt_veraltet');
    const {uebernehmeS3Ergebnis}=await import('./reverse-s3-uebernahme.js');
    const r=await uebernehmeS3Ergebnis(db,{jobId:artefakt.job_id,reverseId:j.eintrag_id,dateiId:String(j.datei_id),arbeitsWurzel:artefakt.arbeits_wurzel,manifest:artefakt.manifest,dauerMs:artefakt.dauer_ms},{nachzug:true,konfiguration:this.cfg,budgetProjekt:j.projekt,policyAuftragId:j.id});
    // Row lock fences concurrent claims; an expired lease never publishes a successful API job.
    const done=await db.query("UPDATE reverse_auftraege SET status=$3,fehlercode=$4,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND lease_bis>clock_timestamp() RETURNING id",[j.id,j.lease_token,r.status,r.status==='teilweise'?'zu_gross':null]);
    if(!done.rowCount)throw Error('s3_nachzug_lease_abgelaufen');
   });
  }catch(e){
   if(istReversePolicyFehler(e)){await this.tx(async db=>{const live=(await db.query("SELECT 1 FROM reverse_auftraege WHERE id=$1 AND lease_token=$2 FOR UPDATE",[j.id,j.lease_token])).rows[0];if(live)await halteReversePolicyAuftrag(db,j.id,j.eintrag_id,e.code);});return;}
   const code=(e as {code?:string}).code,ungueltig=['nicht_gefunden','beschaedigt','pfad_gefahr'].includes(code??'')||(e as Error).message==='s3_artefakt_veraltet';
   await this.tx(async db=>{
    const live=(await db.query("SELECT 1 FROM reverse_auftraege WHERE id=$1 AND lease_token=$2 AND status='laeuft' FOR UPDATE",[j.id,j.lease_token])).rows[0];if(!live)return;
    if(ungueltig)await this.verwerfeS3Artefakt(db,j.eintrag_id,String(j.datei_id),'s3_artefakt_nicht_nutzbar');
    await db.query("UPDATE reverse_auftraege SET status='fehler',fehlercode='werkzeug_fehler',versuch=CASE WHEN $3 THEN $4 ELSE versuch+1 END,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token,ungueltig,this.retry]);
   });
  }
 }
 /** Caller holds the same Fachtransaction as tool audit; PG only. */
 async analysieren(a:ReverseAnalyseAnfrage,db:PoolClient):Promise<Row>{
  await fordereReverseAdmission(db);
  a={...a,policyManuell:true};
  await sperreReversePolicy(db,a.reverseId,true);
  // A new explicit request owns a new immutable pin; no automatic revival of legacy requests.
  // Manueller Neuversuch: auch fachlich gescheiterte Container-Aufträge bekommen einen frischen Work-Job.
  // Existing requests retain their pin and state; queue creates or safely reuses a scoped request.
  if(!STAGES.includes(a.bisSchicht as typeof STAGES[number]))throw new Error('Ungültige Schicht');
  // A manual retry can re-open exhausted light jobs, but never running or cancelled work.
  // Existing requests retain their pin and state; queue creates or safely reuses a scoped request.
  const r=await this.queue(db,a);
  if(a.prioritaet==='interaktiv')await db.query("UPDATE work_jobs SET priority='interaktiv',updated_at=clock_timestamp() WHERE id IN (SELECT p20_auftrag_id FROM reverse_auftraege WHERE eintrag_id=$1 AND datei_id IS NOT DISTINCT FROM $2::bigint) AND state='pending'",[a.reverseId,a.dateiId]);
  return r;
 }
 async abbrechen(j:Row,agent:string,db:PoolClient):Promise<Row|void>{
  if(j.p20_auftrag_id){
   // Running leases require RV12's physical cancellation proof; do not fake a release.
   const others=(await db.query("SELECT count(*)::int AS n FROM reverse_auftraege WHERE p20_auftrag_id=$1 AND id<>$2 AND status IN ('offen','wartet','laeuft')",[j.p20_auftrag_id,j.id])).rows[0];
   if(Number(others.n)>0){await db.query('UPDATE reverse_auftraege SET lease_token=NULL,lease_bis=NULL WHERE id=$1',[j.id]);return;}
   const w=(await db.query('SELECT state FROM work_jobs WHERE id=$1 FOR UPDATE',[j.p20_auftrag_id])).rows[0];
   if(w?.state==='leased'||w?.state==='staged'){
    // P18-T87: laufende Containerarbeit nicht vortaeuschen freizugeben, sondern als Storno-Wunsch am Work-Job hinterlegen. Der
    // Executor beendet den Lauf im naechsten Takt (Work-Job cancelled, Auftrag abgebrochen); entdecke reiht nicht neu ein.
    await reverseStornoAnfordern(db,String(j.p20_auftrag_id),{auftrag_id:j.id,agent});
    await db.query('UPDATE reverse_auftraege SET lease_token=NULL,lease_bis=NULL WHERE id=$1',[j.id]);
    return {storno:'angefordert',p20_auftrag_id:String(j.p20_auftrag_id),
     hinweis:'Der laufende Containerlauf wird im naechsten Executor-Takt beendet (Work-Job cancelled). Eine neue Analyse nur ueber reverse analysieren.'};
   }
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
  // Repair pre-fix E requests attached after the original work had already completed. Never mutate live work or replay its import.
  const verwaist=(await this.pool.query("SELECT r.id,r.eintrag_id,r.medium_id::text,r.projekt,r.ziel_schicht,r.prioritaet FROM reverse_auftraege r JOIN work_jobs w ON w.id=r.p20_auftrag_id JOIN reverse_eintraege e ON e.id=r.eintrag_id WHERE r.schicht='E' AND r.datei_id IS NULL AND r.status IN ('offen','wartet') AND w.state='completed' AND e.status='bestaetigt' ORDER BY r.created_at,r.id LIMIT $1",[this.w.discovery])).rows;
  for(const j of verwaist)await this.tx(db=>this.queue(db,{reverseId:j.eintrag_id,dateiId:null,mediumId:j.medium_id,project:j.projekt??'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:j.ziel_schicht??reverseBisSchichtGrenze(this.ein),prioritaet:j.prioritaet,policyElternId:j.id}));
  const eProfil=await this.eProfil();
  const files=(await this.pool.query("SELECT d.id::text,d.eintrag_id,d.medium_id::text,e.analyse_policy FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id WHERE e.status='bestaetigt' AND d.storage_key IS NOT NULL AND d.sha256 IS NOT NULL AND COALESCE((e.analyse_policy->>'automatisch')::boolean,true) AND (NOT EXISTS(SELECT 1 FROM reverse_schichten done WHERE done.datei_id=d.id AND done.schicht='S3' AND done.aktuell AND done.status IN ('fertig','teilweise') AND done.profil_version=$2) OR $3::text IS NOT NULL AND EXISTS(SELECT 1 FROM reverse_schichten s1 WHERE s1.datei_id=d.id AND s1.schicht='S1' AND s1.aktuell AND s1.status IN ('fertig','teilweise') AND s1.profil_version<>$3)) AND NOT EXISTS(SELECT 1 FROM reverse_auftraege ab WHERE ab.datei_id=d.id AND ab.status='abgebrochen' AND NOT EXISTS(SELECT 1 FROM reverse_auftraege nz WHERE nz.datei_id=d.id AND nz.created_at>ab.created_at)) ORDER BY d.pipeline_gesehen_at NULLS FIRST,d.updated_at,d.id LIMIT $1",[this.w.discovery,this.profile,this.parserAdapter?this.s1ParserProfil():this.s1Bloecke?this.s1BlockProfil():null])).rows;
  // P18-T88: $4 = S1-Blockprofil bei Schalter AN - vorhandene S1-Ergebnisse des anderen Profils laufen einmal neu (auch bei Ziel S2/S3).
  for(const d of files)await this.tx(async db=>{const halt=await reverseAdmission(db);if(halt.aktiv||halt.letzter_fehler)return;await sperreReversePolicy(db,d.eintrag_id);await db.query('UPDATE reverse_dateien SET pipeline_gesehen_at=clock_timestamp() WHERE id=$1',[d.id]);return this.queue(db,{reverseId:d.eintrag_id,dateiId:d.id,mediumId:d.medium_id,
   project:'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:reverseBisSchichtGrenze(this.ein),prioritaet:'hintergrund'});});
  // Teil E: Metadatenereignis; dauerhafter Keyset-Scan im vorhandenen Leser-Executor.
  const {meldeReverseLeserKandidat}=await import('./reverse-leser-nachzug.js');
  for(const d of files)await meldeReverseLeserKandidat(this.pool,String(d.eintrag_id),String(d.id));
  const media=(await this.pool.query("SELECT m.id::text,m.eintrag_id FROM reverse_medien m JOIN reverse_eintraege e ON e.id=m.eintrag_id WHERE e.status='bestaetigt' AND m.status='vollstaendig' AND m.art<>'ordner' AND COALESCE((e.analyse_policy->>'automatisch')::boolean,true) AND NOT EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.medium_id=m.id AND s.schicht='E' AND s.aktuell AND s.status IN ('fertig','teilweise') AND s.werkzeug_version IS NOT DISTINCT FROM $2 AND s.profil_version IS NOT DISTINCT FROM $3) AND NOT EXISTS(SELECT 1 FROM reverse_auftraege ab WHERE ab.medium_id=m.id AND ab.datei_id IS NULL AND ab.schicht='E' AND ab.status='abgebrochen' AND NOT EXISTS(SELECT 1 FROM reverse_auftraege nz WHERE nz.medium_id=m.id AND nz.datei_id IS NULL AND nz.schicht='E' AND nz.created_at>ab.created_at)) ORDER BY m.pipeline_gesehen_at NULLS FIRST,m.id LIMIT $1",[this.w.discovery,reverseContainerWerkzeugVersion(),eProfil])).rows;
  // P18-T87: Ist der juengste Auftrag einer Datei bzw. eines Mediums (E) abgebrochen, reiht die Automatik nichts neu ein (beide
  // Abfragen oben); eine neue Analyse gibt es dann nur ueber ein ausdrueckliches reverse(analysieren).
  // P18-T71: Ein neues Reverse-Image (anderer Werkzeugstand) reiht E fertiger Medien einmal neu ein (verschachtelte Container);
  // gibt es schon einen E-Auftrag mit diesem Stand (auch gescheitert), bleibt es dabei - keine Endlosschleife.
  for(const m of media)await this.tx(async db=>{const halt=await reverseAdmission(db);if(halt.aktiv||halt.letzter_fehler)return;await sperreReversePolicy(db,m.eintrag_id);await db.query('UPDATE reverse_medien SET pipeline_gesehen_at=clock_timestamp() WHERE id=$1',[m.id]);return this.queue(db,{reverseId:m.eintrag_id,dateiId:null,mediumId:m.id,project:'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:reverseBisSchichtGrenze(this.ein),prioritaet:'hintergrund'});});
 }
 private async claim():Promise<Job|undefined>{
  return this.tx(async db=>{
   const kandidat=(await db.query("SELECT j.* FROM reverse_auftraege j JOIN reverse_dateien d ON d.id=j.datei_id JOIN reverse_eintraege e ON e.id=j.eintrag_id WHERE j.ausfuehrung='api' AND COALESCE(j.fehlercode,'') NOT LIKE 'policy_%' AND e.status='bestaetigt' AND j.fingerabdruck IS NOT NULL AND j.versuch<$1 AND (j.status='wartet' OR j.status='laeuft' AND j.lease_bis<clock_timestamp() OR j.status='fehler' AND j.updated_at<clock_timestamp()-$2::double precision*interval '1 millisecond') AND (j.schicht='S0' OR j.werkzeug='reverse-S3-nachzug' OR EXISTS(SELECT 1 FROM reverse_schichten s WHERE s.datei_id=d.id AND s.schicht='S0' AND s.aktuell AND s.status IN ('fertig','teilweise'))) ORDER BY CASE j.prioritaet WHEN 'interaktiv' THEN 0 WHEN 'hintergrund' THEN 1 ELSE 2 END,j.created_at,j.id LIMIT 1",[this.retry,this.cfg.sync.retryIntervallMs])).rows[0];
   if(!kandidat)return;
   await sperreReversePolicy(db,String(kandidat.eintrag_id));
   const j=(await db.query("SELECT * FROM reverse_auftraege WHERE id=$1 AND (status IN ('wartet','fehler') OR status='laeuft' AND lease_bis<clock_timestamp()) FOR UPDATE SKIP LOCKED",[kandidat.id])).rows[0];
   if(!j)return;
   try{await pruefeReversePolicyAuftrag(db,String(j.id),String(j.eintrag_id),String(j.schicht));}catch(e){if(!istReversePolicyFehler(e))throw e;await halteReversePolicyAuftrag(db,String(j.id),String(j.eintrag_id),e.code);return;}
   if(j.status==='fehler'&&!await this.queuePlatz(db))return;
   const leaseMs=j.werkzeug==='reverse-S3-nachzug'?(await leseReverseEinstellungen(j.projekt)).werte.s3_nachzug_lease_ms.wert:this.leaseMs;
   const token=randomUUID();await db.query("UPDATE reverse_auftraege SET status='laeuft',lease_token=$2,lease_bis=clock_timestamp()+$3::double precision*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1",[j.id,token,leaseMs]);
   await db.query("UPDATE reverse_schichten SET status='laeuft',gestartet_at=clock_timestamp(),fehlercode=NULL WHERE auftrag_id=$1 AND aktuell AND fingerabdruck=$2",[j.id,j.fingerabdruck]);
   return {...j,lease_token:token} as Job;
  });
 }
 private adresse(rid:string,pfad:string,key:string):AssetAdresse{
  const m=key.match(/^([^/]+)\/(original|entpackt)\/([^/]+)\/(.+)$/);
  if(!m||m[1]!==rid)throw new Error('Ungültige Reverse-Speicherreferenz');
  return {bereich:'reverse',ziel_ref:rid,storage_kind:'binaries',logischer_pfad:m[4],reverse_layout:{art:m[2] as 'original'|'entpackt',gruppe:m[3]}};
 }
 private async materialisiere(db:PoolClient,j:Job,payload:AnalysePayload,block=false):Promise<void>{
  await pruefeReversePolicyAuftrag(db,j.id,j.eintrag_id,j.schicht);
  if(payload.metadata.reverse_parser_adapter===true)await db.query('SELECT id FROM reverse_eintraege WHERE id=$1 FOR UPDATE',[j.eintrag_id]);
  const d=(await db.query('SELECT * FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2 FOR UPDATE',[j.datei_id,j.eintrag_id])).rows[0];
  const r=payload.result as AssetResult,metadata=payload.metadata;
  if(!d||reverseAnalyseFingerabdruck(d.sha256,j.schicht,j.werkzeug,j.werkzeug_version,j.profil_version)!==j.fingerabdruck)throw new Error('Reverse-Revision geändert');
  // P18-T94: fehlender Inspektor entwertet weder eine erkannte Art noch deren Format/MIME.
  const unbekannt=r.asset_type==='unbekannt';
  const ergaenzung={...metadata};
  if(unbekannt)for(const key of ['asset_type','mime','format']){
   const wert=ergaenzung[key];if(wert===undefined||wert===null||wert==='unbekannt')delete ergaenzung[key];
  }
  await db.query('UPDATE reverse_dateien SET format=$2,arch=$3,bits=$4,art=$5,metadaten=metadaten||$6::jsonb,status=$7,updated_at=clock_timestamp() WHERE id=$1',
   [d.id,unbekannt&&(r.format==null||r.format==='unbekannt')?d.format:r.format??d.format,
    r.metadata.architektur??d.arch,typeof r.metadata.bits==='number'?r.metadata.bits:d.bits,
    r.asset_type==='archive'?'archiv':r.asset_type==='executable'?'binaer':unbekannt?d.art:'asset',JSON.stringify(ergaenzung),payload.status]);
  if(j.schicht==='S1'){
   await db.query("DELETE FROM reverse_objekte WHERE datei_id=$1 AND data->>'ursprung' IS DISTINCT FROM 'leser'",[d.id]);
   await db.query("DELETE FROM reverse_verweise WHERE datei_id=$1 AND ursprung='analyse'",[d.id]);
   for(const [i,o] of r.objects.entries()){
    const range=o.source_range;
    await db.query('INSERT INTO reverse_objekte(datei_id,eintrag_id,ordnung,kind,name,data,byte_offset,byte_length,line_start,line_end) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)',
     [d.id,j.eintrag_id,i,o.kind,o.name,JSON.stringify(o.data),range&&'offset'in range?range.offset:null,range&&'length'in range?range.length:null,range&&'line_start'in range?range.line_start:null,range&&'line_end'in range?range.line_end:null]);
   }
   for(const [i,r] of (payload.result as AssetResult).references.entries())await db.query("INSERT INTO reverse_verweise(datei_id,eintrag_id,ordnung,kind,target,aufloesung,inspektor_resolved) VALUES($1,$2,$3,$4,$5,'unbekannt',$6)",[d.id,j.eintrag_id,i,r.kind,r.target,r.resolved??null]);
   // P18-T88: Blockweg - Strings/Importe liegen schon bestätigt in der Staging-Generation; hier nur atomar veröffentlichen.
   if(payload.metadata.reverse_parser_adapter===true){if(await publiziereReverseParser(db,{auftragId:j.id,reverseId:j.eintrag_id,dateiId:String(d.id),fingerabdruck:j.fingerabdruck})==='teilweise')payload.status='teilweise';}
   else if(block)await veroeffentlicheS1Generation(db,{auftragId:j.id,reverseId:j.eintrag_id,dateiId:String(d.id),fingerabdruck:j.fingerabdruck,ordnungAb:r.references.length});
   else{
   const normal=normalisiereS1({strings:payload.strings.map(text=>({text})),importe:r.references.map(x=>({name:x.target}))},
    {maxBytes:this.w.spoolBytes,maxEintraege:this.cfg.inspektion.maxObjects});
   // Old chunks may have disappeared when a new fingerprint yields fewer strings.
   await db.query("DELETE FROM reverse_code_dateien WHERE eintrag_id=$1 AND datei_id=$2::bigint AND schicht='S1' AND (file_name LIKE 'strings%' OR file_name LIKE 'imports%')",[j.eintrag_id,d.id]);
   await uebernehmeNormalisiert(db,{reverseId:j.eintrag_id,dateiId:String(d.id),pfad:d.pfad,fingerabdruck:j.fingerabdruck},normal);
   if(normal.dateiKandidaten.length)await db.query("INSERT INTO reverse_verweise(datei_id,eintrag_id,ordnung,kind,target,aufloesung) SELECT $1,$2,$3+u.i,'string_datei',u.target,'unbekannt' FROM unnest($4::text[]) WITH ORDINALITY AS u(target,i)",
    [d.id,j.eintrag_id,r.references.length,normal.dateiKandidaten]);
   if(normal.gekappt){
    payload.status='teilweise';
    await db.query("UPDATE reverse_dateien SET status='teilweise' WHERE id=$1",[d.id]);
   }
   }
  }
  await db.query("UPDATE reverse_schichten SET status=$3,funktionen_gesamt=$4,funktionen_fertig=$4,beendet_at=clock_timestamp(),dauer_ms=$5 WHERE datei_id=$1 AND schicht=$2 AND fingerabdruck=$6 AND aktuell",[d.id,j.schicht,payload.status,r.objects.length,payload.dauer_ms,j.fingerabdruck]);
  await db.query("UPDATE reverse_auftraege SET status=$3,lease_token=NULL,lease_bis=NULL,fehlercode=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token,payload.status]);
  await db.query("SELECT pg_notify('synapse_reverse_changed',$1)",[j.eintrag_id]);
 }
 private async bearbeite(worker:AssetInspektionsWorker,j:Job):Promise<void>{
  if(j.werkzeug==='reverse-S3-nachzug'){await this.uebernehmeS3Nachzug(j);return;}
  let source:Awaited<ReturnType<AssetSpeicher['oeffneInspektionsQuelle']>>|undefined;
  let ownsCache=false;
  const parser=j.schicht==='S1'&&j.profil_version.startsWith('parser-s1:');
  const block=!parser&&j.schicht==='S1'&&j.profil_version!==this.profile&&j.profil_version===this.s1BlockProfil();
  try{
   const d=(await this.pool.query('SELECT * FROM reverse_dateien WHERE id=$1 AND eintrag_id=$2',[j.datei_id,j.eintrag_id])).rows[0];
   if(!d)throw new Error('Reverse-Datei fehlt');
   if(j.schicht==='S1'&&!parser&&(await leseReverseParserSchalter(this.pool)).aktiv)throw Error('reverse_parser_altlauf_angehalten');
   const cache=await this.tx(async db=>{
    await pruefeReversePolicyAuftrag(db,j.id,j.eintrag_id,j.schicht);
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
    const stringsBudget=j.schicht==='S1'&&!block&&!parser?Math.min(source.size,this.stringsBytes):0;
    const readBudget=this.cfg.inspektion.maxReadBytes-stringsBudget;
    if(readBudget<1)throw new Error('Reverse-Lesebudget zu klein für Inspektion und Strings');
    const started=Date.now(),r=await worker.inspiziereQuelle(source,{grenzen:{...this.cfg.inspektion,maxReadBytes:readBudget},timeoutMs:this.cfg.inspektion.timeoutMs});
    if(this.beendet)throw new Error('Reverse-Dienst beendet');
    if(r.sha256!==null&&r.sha256!==d.sha256)throw new Error('Reverse-Hash geändert');
    if(r.status==='fehler'||r.status==='quelle_nicht_gefunden')throw new Error('Reverse-Inspektion fehlgeschlagen');
    const sample=await source.readRange(0,Math.min(this.w.stichprobe,source.size));
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
    const rv27=j.schicht==='S1'&&(!r.format||r.format==='unbekannt')?await analysiereRv27({size:source.size,path:String(d.pfad),readRange:(off,len)=>source!.readRange(off,len)},{scanBytes:this.cfg.inspektion.maxReadBytes,ramBytes:this.cfg.inspektion.maxReadBytes,blockBytes:Math.min(65536,this.cfg.inspektion.maxReadBytes),sampleBytes:4096,maxCandidates:this.cfg.inspektion.maxObjects}):null;
    const strings:string[]=[];
    if(j.schicht==='S1'&&!block&&!parser){
     const maxBytes=Math.min(source.size,this.stringsBytes),min=this.w.stringsMin;
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
    const packer=this.w.entropieMilli/1000;
    if(entropy>packer||r.objects.some(o=>o.kind==='sektion'&&Number(o.data.entropie)>packer))merkmale.push('packer_verdacht');
    if(r.status==='teilweise'||j.schicht==='S1'&&!block&&!parser&&source.size>this.stringsBytes)merkmale.push('teilweise');
    const {file_path:_path,...result}=r;
    const masked=maskiereReverseAnalyse({result,strings,metadata:{...r.metadata,inspektor_merkmale:r.metadata.merkmale,merkmale,
     format_specific:r.format_specific,warnings:r.warnings,magic_hex:sample.subarray(0,32).toString('hex'),entropie:entropy,entropie_stichprobe_4096:{wert:entropy,bytes:sample.length,bereich:'[0,min(groesse,'+this.w.stichprobe+'))'},rv27,packer_verdacht:merkmale.includes('packer_verdacht')},
     status:r.status==='ok'&&!merkmale.includes('teilweise')?'fertig':'teilweise',dauer_ms:Date.now()-started});
    payload=masked.wert as AnalysePayload;payload.metadata.maskiert_anzahl=masked.treffer;
    if(Buffer.byteLength(JSON.stringify(payload))>this.w.spoolBytes)throw new Error('Reverse-Metadatenlimit');
    await source.pruefeUnveraendert();
   }
   if(parser){
    if(!source){
     const address=await reverseDateiSpeicherAdresse(this.pool,j.eintrag_id,String(d.id));
     const layout=d.storage_key?.startsWith(j.eintrag_id+'/entpackt/')?this.adresse(j.eintrag_id,d.pfad,d.storage_key):address.adresse;
     source=await this.speicher.oeffneInspektionsQuelle(layout,d.storage_key);
     if(source.size!==Number(d.groesse))throw Error('Reverse-Größe geändert');
    }
    const quelle=source,r=payload!.result as AssetResult;
    await materialisiereParserS1InBloecken(this.pool,{size:quelle.size,readRange:(off,len)=>quelle.readRange(off,len)},{
     auftragId:j.id,leaseToken:j.lease_token,leaseMs:this.leaseMs,reverseId:j.eintrag_id,dateiId:String(d.id),fingerabdruck:j.fingerabdruck,cacheLease:ownsCache,
     datei:{pfad:String(d.pfad),sha256:String(d.sha256),format:r.format,art:String(d.art),metadaten:{...d.metadaten,...payload!.metadata}},abbrechen:()=>this.beendet});
    payload!.strings=[];payload!.metadata.reverse_parser_adapter=true;
    await quelle.pruefeUnveraendert();
   }
   if(block){
    // P18-T88: ganze Datei in bestätigten Blöcken (Checkpoint am Auftrag); sichtbar erst mit der Veröffentlichung in materialisiere.
    if(!source){
     const address=await reverseDateiSpeicherAdresse(this.pool,j.eintrag_id,String(d.id));
     const layout=d.storage_key?.startsWith(j.eintrag_id+'/entpackt/')?this.adresse(j.eintrag_id,d.pfad,d.storage_key):address.adresse;
     source=await this.speicher.oeffneInspektionsQuelle(layout,d.storage_key);
     if(source.size!==Number(d.groesse))throw new Error('Reverse-Größe geändert');
    }
    const einst=await leseReverseEinstellwerte({eintrag_id:j.eintrag_id},this.pool);
    if(einst.letzter_fehler)throw new Error('reverse_s1_einstellungen:'+einst.letzter_fehler);
    const quelle=source;
    await materialisiereS1InBloecken(this.pool,{size:quelle.size,readRange:(o,l)=>quelle.readRange(o,l)},{auftragId:j.id,leaseToken:j.lease_token,leaseMs:this.leaseMs,
     reverseId:j.eintrag_id,dateiId:String(d.id),pfad:String(d.pfad),fingerabdruck:j.fingerabdruck,cacheLease:ownsCache,
     importe:(payload!.result as AssetResult).references.map(x=>x.target),einstellungen:einst,abbrechen:()=>this.beendet});
    await quelle.pruefeUnveraendert();
   }
   await this.tx(async db=>{
    const halt=await reverseAdmission(db);
    await pruefeReversePolicyAuftrag(db,j.id,j.eintrag_id,j.schicht);
    const live=(await db.query("SELECT 1 FROM reverse_auftraege WHERE id=$1 AND lease_token=$2 AND status='laeuft' AND lease_bis>clock_timestamp() FOR UPDATE",[j.id,j.lease_token])).rows[0];
    if(!live)return;
    // Recheck after inspector/cache/resume, before publishing any old payload or cache result.
    if(j.schicht==='S1'&&!parser&&(await leseReverseParserSchalter(db)).aktiv)throw Error('reverse_parser_altlauf_angehalten');
    if(ownsCache){
     const c=await db.query("UPDATE reverse_analyse_cache SET status=$3,ergebnis=$4::jsonb,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE fingerabdruck=$1 AND lease_token=$2 AND lease_bis>clock_timestamp() RETURNING fingerabdruck",[j.fingerabdruck,j.lease_token,payload.status,JSON.stringify(payload)]);
     if(!c.rowCount)throw new Error('Reverse-Cachelease verloren');
    }
    await this.materialisiere(db,j,payload,block);
    if(halt.aktiv||halt.letzter_fehler)return; // Elternresultat bleibt publiziert; kein neuer Folgeauftrag.
    if(j.schicht==='S1')await this.s1Werkzeuge(db,j);
    await this.queue(db,{reverseId:j.eintrag_id,dateiId:j.datei_id,mediumId:j.medium_id,project:j.projekt??'reverse-bibliothek',agentId:'reverse-pipeline',bisSchicht:j.ziel_schicht??reverseBisSchichtGrenze(this.ein),prioritaet:j.prioritaet,policyElternId:j.id});
   });
  }catch(e){
   if(istReversePolicyFehler(e)){
    await this.tx(async db=>{const live=await db.query("SELECT 1 FROM reverse_auftraege WHERE id=$1 AND eintrag_id=$2 AND lease_token=$3 AND status='laeuft' FOR UPDATE",[j.id,j.eintrag_id,j.lease_token]);if(live.rowCount)await halteReversePolicyAuftrag(db,j.id,j.eintrag_id,e.code);});
    return;
   }
   if(e instanceof Error&&e.message==='reverse_parser_altlauf_angehalten'){
    // A fenced mode change is not an inspector failure. The new profile can revive this job.
    await this.tx(async db=>{
     const gestoppt=await db.query("UPDATE reverse_auftraege SET status='fehler',fehlercode='reverse_parser_altlauf_angehalten',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token]);
     if(ownsCache)await db.query("UPDATE reverse_analyse_cache SET status='wartet',ergebnis=NULL,fehlercode=NULL,lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE fingerabdruck=$1 AND lease_token=$2",[j.fingerabdruck,j.lease_token]);
     if(gestoppt.rowCount)await db.query("UPDATE reverse_schichten SET status='fehler',fehlercode='reverse_parser_altlauf_angehalten' WHERE auftrag_id=$1 AND status IN ('offen','wartet','laeuft')",[j.id]);
    });
    return;
   }
   const failed=await this.pool.query("UPDATE reverse_auftraege SET status='fehler',fehlercode='werkzeug_fehler',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2",[j.id,j.lease_token]);
   if(ownsCache)await this.pool.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode='werkzeug_fehler',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE fingerabdruck=$1 AND lease_token=$2",[j.fingerabdruck,j.lease_token]);
   if(failed.rowCount)await this.pool.query("UPDATE reverse_schichten SET status='fehler',fehlercode='werkzeug_fehler' WHERE auftrag_id=$1 AND aktuell AND status IN ('offen','wartet','laeuft')",[j.id]);
  }finally{await source?.schliessen();}
 }
 /** P18-T98/T111: Nachzug in eigener Transaktion über den automatischen queue-Weg (Halt und Policy-Sperre wie entdecke). */
 async nachziehen(a:ReverseAnalyseAnfrage,db?:PoolClient):Promise<Row>{
  const lauf=async(c:PoolClient):Promise<Row>=>{
   const halt=await reverseAdmission(c);if(halt.aktiv||halt.letzter_fehler)return {status:'gehalten',fehlercode:null};
   await sperreReversePolicy(c,a.reverseId);return this.queue(c,{...a,policyManuell:false});
  };
  return db?lauf(db):this.tx(lauf);
 }
 /** P18-T98/T111: gedrosselter Nachzug (Schalter in reverse_einstellungen, Standard aus); wirft nie. */
 private async nachzugAuto():Promise<void>{
  await reverseNachzugAutoTakt({pool:this.pool,ein:this.ein,parserProfil:this.parserAdapter?this.s1ParserProfil():null,einreihen:a=>this.nachziehen(a)});
 }
 async durchlauf():Promise<void>{
  if(this.beendet)return;await this.einstellungen();await this.entdecke();await this.nachzugAuto();
  // P18-T68: je Worker so lange Aufträge holen, bis keiner mehr wartet oder das Zeitbudget des Durchlaufs um ist.
  // Vorher genau EIN Auftrag je Worker und Scanintervall (gemessen: 1 Datei/60 s bei ~0,3 s Inspektion).
  const ende=Date.now()+this.w.durchlaufMs;
  await Promise.all(this.workers.slice(0,this.w.parallel).map(async w=>{
   while(!this.beendet&&Date.now()<ende){const j=await this.claim();if(!j)break;await this.bearbeite(w,j);}
  }));
 }
 async beende():Promise<void>{this.beendet=true;await Promise.all(this.workers.map(w=>w.beende()));}
}
/** Called only by the API lifecycle, never stdio or the PC daemon. */
export function starteReversePipeline():ApiAuftragsLoop|null{
 const cfg=getAssetKonfiguration();if(!cfg.reverse.aktiv)return null;
 const dienst=new ReversePipelineDienst({konfiguration:cfg});
 configureReverseRuntime({analysieren:(a,db)=>dienst.analysieren(a,db),nachziehen:a=>dienst.nachziehen(a),abbrechen:(j,agent,db)=>dienst.abbrechen(j,agent,db),containerStatus:rid=>dienst.containerStatus(rid)});
 const loop=starteApiAuftragsLoop({intervallMs:cfg.sync.scanIntervallMs,arbeit:()=>imHintergrund(()=>dienst.durchlauf()),fehler:()=>console.error('[Reverse-Pipeline] Durchlauf fehlgeschlagen')});
 // P18-T64: automatischer Entstörer (gleiche Regeln wie reverse(entstoeren)) läuft im selben API-Prozess.
 const entstoerer=starteReverseEntstoerer();
 return {durchlauf:loop.durchlauf,beende:async()=>{entstoerer?.beende();await dienst.beende();await loop.beende();configureReverseRuntime({});}};
}
