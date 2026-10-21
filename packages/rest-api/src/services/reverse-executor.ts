/**
 * P18-T59/RV12 (Welle R1-A): führt reverse-E-Aufträge (P20-Work-Jobs) auf dem Unraid-Server aus.
 * Grundlage Wellenplan R1 (thought ef68838e):
 *  E1 Systemprojekt 'reverse-bibliothek' virtuell registrieren + tool_activation, kein Umbau des Lebenszyklus.
 *  E2 (P18-T64): EIN globaler Reverse-Container (instance_scope 'project' im einzigen virtuellen Projekt reverse-bibliothek)
 *     mit Warteschlange: /bib (ro, Reverse-Bibliothek), /arbeit (rw, <reverseRoot>/_arbeit), je Auftrag /arbeit/<jobId>.
 *     Startet bei Bedarf, schläft nach SYNAPSE_REVERSE_IDLE_MS Leerlauf. Alte Job-Container laufen über den Lebenszyklus aus;
 *     solange einer davon lebt, bleibt der alte Descriptor (je Auftrag) aktiv und die Umstellung wird je Durchlauf erneut versucht.
 *  E3 nur Kinds aus SYNAPSE_REVERSE_EXECUTOR_KINDS (Default 'reverse-E'); die Kinds stehen in der Ausführer-Registry (core).
 * Ablauf: offener Auftrag -> Lebenszyklus weckt den Reverse-Container -> Claim nur mit Server-Identität ->
 * lifecycle.execute {kommando:'extrahieren'} -> uebernehmeEErgebnis unter Lease-Fence -> stage -> complete.
 * Alles aus, solange SYNAPSE_REVERSE_ENABLED nicht '1' ist.
 */
import {createHash} from 'node:crypto';
import {mkdir,chmod,chown,rm,readdir,open,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Docker from 'dockerode';
import type {Pool} from 'pg';
import {leseReverseSiedler3Schalter,leseReversePeRessourcenSchalter,getPool,getAssetKonfiguration,registerVirtualProject,registerToolDescriptor,setToolActivation,validateToolDescriptor,
 configureWorkJobHooks,createWorkJobService,validateWorkResources,registriereWorker,workerPausiert,uebernehmeEErgebnis,
 reverseEGruppe,ReverseEUebernahmeFehler,ergaenzeReverseRuntime,REVERSE_FEHLERCODES,REVERSE_EXECUTOR_UNTERSTUETZT,meldeReverseAusfuehrer,
 reverseFehlerDeterministisch,uebernehmeS3Ergebnis,reverseS3AusgabeKey,ReverseS3UebernahmeFehler,reverseResourceNeedRoh,
 type ToolDescriptor,type WorkJob,type WorkJobHooks,type WorkJobClient,type WorkNodeAuthority,type WorkIdentity,
 type WorkJobService,type WorkJobPool,type WorkResourceNeed,type ReverseContainerInfo,type ReverseEManifestEintrag} from '@synapse/core';
import type {ToolLifecycle,ToolResourceAdapter,ToolInstanceContext} from './tool-lifecycle.js';
import {DockerToolContainerExecutor,type ResolvedToolMount} from './tool-container-docker.js';
import {configureToolLifecycleAdapters,getToolLifecycle} from './tool-lifecycle-runtime.js';
import {ServerExecutor} from './server-executor.js';

export const REVERSE_PROJEKT='reverse-bibliothek';
export const REVERSE_CAPABILITY='reverse_bibliothek';
export const REVERSE_TOOL_ID='reverse-e';
const UNTERSTUETZTE_KINDS:readonly string[]=REVERSE_EXECUTOR_UNTERSTUETZT;
/** Serverseitige Selbstkonfiguration aus der API-Umgebung, niemals aus Clientargumenten. */
const SERVER_AUTHORITY={role:'koordinator',authenticated:true} as const;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db=Pick<Pool,'query'|'connect'>;
type Ref=WorkJob['inputRef'];

// ---------------------------------------------------------------------------------------------
// Work-Job-Hooks je Capability komponieren: configureWorkJobHooks ersetzt den ganzen Satz, deshalb
// registriert jede Capability hier und bekommt nur ihre eigenen Aufträge zu sehen.
const hookRegistry=new Map<string,WorkJobHooks>();
function komponiereWorkJobHooks():WorkJobHooks{
 if(!hookRegistry.size)return {};
 const fuer=(capability:string)=>hookRegistry.get(capability);
 return {
  resourceDomain:nodeId=>{for(const h of hookRegistry.values()){const d=h.resourceDomain?.(nodeId);if(d)return d;}return undefined;},
  authorizeJob:async(node,job,client)=>(await fuer(job.capability)?.authorizeJob?.(node,job,client))??null,
  inputStillCurrent:async(job,client)=>(await fuer(job.capability)?.inputStillCurrent?.(job,client))===true,
  outputIsStaged:async(job,out,client)=>(await fuer(job.capability)?.outputIsStaged?.(job,out,client))===true,
 };
}
/** Registriert Hooks für genau eine Capability; bestehende Hooks anderer Capabilities bleiben. */
export function registriereWorkJobHooks(capability:string,hooks:WorkJobHooks):()=>void{
 hookRegistry.set(capability,hooks);configureWorkJobHooks(komponiereWorkJobHooks());
 return ()=>{if(hookRegistry.get(capability)===hooks){hookRegistry.delete(capability);configureWorkJobHooks(komponiereWorkJobHooks());}};
}

// ---------------------------------------------------------------------------------------------
export interface ReverseExecutorKonfig {
 reverseRoot:string;arbeitRoot:string;
 /** P18-T66: Host-Pfad der Reverse-Wurzel für Docker-Binds (SYNAPSE_REVERSE_HOST_ROOT); null = automatisch ermitteln. */
 hostRoot:string|null;image:string;digest:string;kinds:string[];parallel:number;
 leaseSeconds:number;renewMs:number;tickMs:number;resourceNeed:WorkResourceNeed;resourceDomain:string|null;
 zeitlimitS:number;maxDateien:number;maxBytes:number;tmpfsMb:number;pids:number;outputBytes:number;retryMax:number;wavPregap:boolean;
 /** P18-T64: Leerlauf, nach dem der globale Reverse-Container schläft. */
 idleMs:number;
 /** P18-T71: Tiefe verschachtelter Container beim Entpacken (SYNAPSE_REVERSE_MAX_VERSCHACHTELUNG); 0 = aus. Ohne Wert gilt der Runner-Standard. */
 maxVerschachtelung?:number;
 /** P18-T69: reverse-S3 (Ghidra) je Lauf; User da83be67: 4 GB RAM, 2 CPU, 1 h. */
 s3ResourceNeed:WorkResourceNeed;s3ZeitlimitS:number;s3MaxBytes:number;
}
function ganz(env:NodeJS.ProcessEnv,name:string,fallback:number,min=1,max=2147483647):number{
 const n=Number(env[name]??fallback);
 if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('reverse_executor_konfig:'+name);
 return n;
}
/** P18-T69: S3-Grenzen (SYNAPSE_REVERSE_S3_RESOURCE_NEED, _S3_ZEITLIMIT_S, _S3_MAX_BYTES). */
function s3Konfig(env:NodeJS.ProcessEnv):Pick<ReverseExecutorKonfig,'s3ResourceNeed'|'s3ZeitlimitS'|'s3MaxBytes'>{
 const need=validateWorkResources(JSON.parse(reverseResourceNeedRoh('reverse-S3',env)!));
 if(need.gpu||need.cpu<=0||need.ram<=0)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_S3_RESOURCE_NEED (CPU/RAM, keine GPU)');
 return {s3ResourceNeed:need,s3ZeitlimitS:ganz(env,'SYNAPSE_REVERSE_S3_ZEITLIMIT_S',3600,60,86400),
  s3MaxBytes:ganz(env,'SYNAPSE_REVERSE_S3_MAX_BYTES',268435456,1048576,Number.MAX_SAFE_INTEGER)};
}
/** P18-T69: Container- und Work-Budget = Maximum aus E und (falls aktiv) S3; es gibt nur EINEN Reverse-Container. */
export function reverseContainerBedarf(k:ReverseExecutorKonfig):WorkResourceNeed{
 if(!k.kinds.includes('reverse-S3'))return k.resourceNeed;
 return {cpu:Math.max(k.resourceNeed.cpu,k.s3ResourceNeed.cpu),ram:Math.max(k.resourceNeed.ram,k.s3ResourceNeed.ram),vram:0,gpu:false};
}
const reverseZeitlimitMax=(k:ReverseExecutorKonfig)=>k.kinds.includes('reverse-S3')?Math.max(k.zeitlimitS,k.s3ZeitlimitS):k.zeitlimitS;
/** Liest die Executor-Umgebung; null = aus. Ungültige Werte werfen (der Start bleibt dann aus). */
export function ladeReverseExecutorKonfig(env:NodeJS.ProcessEnv,reverseRoot:string|null):ReverseExecutorKonfig|null{
 if(env.SYNAPSE_REVERSE_ENABLED!=='1'||!reverseRoot)return null;
 const bild=(env.SYNAPSE_REVERSE_IMAGE??'').trim();
 const m=bild.match(/^([a-zA-Z0-9][a-zA-Z0-9._/:-]*)@(sha256:[a-f0-9]{64})$/);
 if(!m)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_IMAGE (name@sha256:<64 hex> erwartet)');
 const roh=env.SYNAPSE_REVERSE_RESOURCE_NEED;
 if(!roh)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_RESOURCE_NEED');
 const need=validateWorkResources(JSON.parse(roh));
 if(need.gpu||need.cpu<=0||need.ram<=0)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_RESOURCE_NEED (CPU/RAM, keine GPU)');
 const gewuenscht=(env.SYNAPSE_REVERSE_EXECUTOR_KINDS??'reverse-E').split(',').map(s=>s.trim()).filter(Boolean);
 const kinds=gewuenscht.filter(k=>UNTERSTUETZTE_KINDS.includes(k));
 if(kinds.length!==gewuenscht.length)console.warn('[reverse-executor] Nicht unterstützte Kinds ignoriert:',gewuenscht.filter(k=>!kinds.includes(k)).join(','));
 if(!kinds.length)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_EXECUTOR_KINDS');
 const leaseSeconds=ganz(env,'SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS',300,10,ganz(env,'SYNAPSE_WORK_MAX_LEASE_SECONDS',900));
 const root=path.resolve(reverseRoot);
 const host=env.SYNAPSE_REVERSE_HOST_ROOT?.trim()||null;
 if(host&&(!path.isAbsolute(host)||host.includes(':')))throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_HOST_ROOT (absoluter Host-Pfad erwartet)');
 return {reverseRoot:root,arbeitRoot:path.join(root,'_arbeit'),hostRoot:host?path.resolve(host):null,image:m[1],digest:m[2],kinds,
  parallel:ganz(env,'SYNAPSE_REVERSE_EXECUTOR_PARALLEL',1,1,16),leaseSeconds,renewMs:Math.max(1000,Math.floor(leaseSeconds*1000/3)),
  tickMs:ganz(env,'SYNAPSE_REVERSE_EXECUTOR_TICK_MS',5000,100),resourceNeed:need,
  resourceDomain:env.SYNAPSE_REVERSE_RESOURCE_DOMAIN?.trim()||null,
  zeitlimitS:ganz(env,'SYNAPSE_REVERSE_ZEITLIMIT_S',3600,1,86400),maxDateien:ganz(env,'SYNAPSE_REVERSE_MAX_DATEIEN',20000,1,200000),
  maxBytes:ganz(env,'SYNAPSE_REVERSE_MAX_BYTES',2000000000,1,Number.MAX_SAFE_INTEGER),tmpfsMb:ganz(env,'SYNAPSE_REVERSE_TMPFS_MB',512,16),
  pids:ganz(env,'SYNAPSE_REVERSE_PIDS',256,16),outputBytes:ganz(env,'SYNAPSE_REVERSE_OUTPUT_BYTES',33554432,65536),
  retryMax:ganz(env,'SYNAPSE_REVERSE_RETRY_MAX',3,1,100),wavPregap:env.SYNAPSE_REVERSE_WAV_PREGAP==='1',idleMs:ganz(env,'SYNAPSE_REVERSE_IDLE_MS',300000,10000,86400000),
  maxVerschachtelung:ganz(env,'SYNAPSE_REVERSE_MAX_VERSCHACHTELUNG',8,0,32),...s3Konfig(env)};
}
/**
 * E2 (P18-T64): EIN globaler Container (instance_scope 'project'; das Projekt ist immer reverse-bibliothek), kein Netz,
 * Bibliothek nur lesend, /arbeit = _arbeit mit je Auftrag eigenem Unterordner. concurrency = parallel (der Runner arbeitet
 * die Zeilen nacheinander ab, weitere warten im Transport). Grenzen je Auftrag kommen mit jedem Kommando.
 * Rootfs ist read-only; der Docker-Adapter hängt /tmp als tmpfs (resources.tmpfs MB) ein – der Runner nutzt TMPDIR=HOME=/tmp.
 */
export function reverseToolDescriptor(k:ReverseExecutorKonfig):ToolDescriptor{
 return validateToolDescriptor({tool_id:REVERSE_TOOL_ID,tool:'reverse',capability:REVERSE_CAPABILITY,image:k.image,digest:k.digest,
  instance_scope:'project',network:'none',allow_project_share:false,
  mounts:[{role:'bibliothek',target:'/bib',write:false},{role:'arbeit',target:'/arbeit',write:true}],
  resources:{cpu:reverseContainerBedarf(k).cpu,ram:reverseContainerBedarf(k).ram,vram:0,gpu:false,pids:k.pids,tmpfs:k.tmpfsMb,concurrency:k.parallel},
  limits:{time_ms:(reverseZeitlimitMax(k)+60)*1000,output_bytes:k.outputBytes,input_bytes:65536},
  lifecycle:{idle_ms:k.idleMs,activity_lookback_seconds:300,cpu_idle_percent:5,gpu_idle_percent:100,measurement_max_age_ms:60000,
   start_timeout_ms:120000,max_starts:20,start_window_ms:600000,pause_ms:300000}});
}
const RUNNER_UID=65532;
/** P18-T69: Dateisystemzugriffe der Rechte-Helfer; Tests ohne root ersetzen chown. */
export interface ReverseRechteOps {lstat:typeof lstat;chown:typeof chown;chmod:typeof chmod}
const RECHTE_OPS:ReverseRechteOps={lstat,chown,chmod};
/** K4: als root Eigentümer 65532 + 0700; ohne root (Tests/Entwicklung) bleibt nur 0777 übrig. */
async function runnerOrdner(dir:string):Promise<void>{
 await mkdir(dir,{recursive:true,mode:0o700});
 if(process.getuid?.()===0){await chown(dir,RUNNER_UID,RUNNER_UID);await chmod(dir,0o700);}
 else await chmod(dir,0o777);
}
/**
 * P18-T64/M1: Nach dem Lauf gehört der Auftragsordner wieder root (0700). Im gemeinsamen Container kann der Runner
 * (uid 65532) damit nur in den Ordner des gerade laufenden Auftrags schreiben, nie in fertige oder fremde. Ohne root
 * (Tests/Entwicklung) nicht möglich, dann bleibt es bei 0711 auf _arbeit und nicht ratbaren UUID-Namen.
 */
export async function sperreArbeitsOrdner(dir:string):Promise<boolean>{
 if(process.getuid?.()!==0)return false;
 try{await chown(dir,0,0);await chmod(dir,0o700);return true;}catch{return false;}
}
/**
 * P18-T66: Eingabedateien eines Mediums für den Runner (uid/gid 65532) lesbar machen: root:65532, 0640. Der Inhalt bleibt
 * unverändert; gilt auch für Originale, die vor dieser Regel mit 0600 abgelegt wurden. Liefert null oder einen Fehlercode;
 * fehlt das Recht für chown/chmod, kommt 'keine_berechtigung:eingabe_rechte' (mit Logzeile) statt eines stillen Runner-Fehlers.
 * P18-T69: Mit wurzel werden zusätzlich die Ordner zwischen wurzel und Datei für den Runner durchquerbar (reverseOrdnerDurchquerbar).
 * Entpackte Dateien liegen unter Ordnern 0750 root:root (E-Übernahme vor P18-T69), die der Runner sonst nicht betreten kann.
 */
export async function reverseEingabeLesbar(pfade:string[],wurzel?:string,ops:ReverseRechteOps=RECHTE_OPS):Promise<string|null>{
 for(const p of pfade){
  if(wurzel!==undefined){const f=await reverseOrdnerDurchquerbar(wurzel,p,ops);if(f)return f;}
  let st;
  try{st=await ops.lstat(p);}catch{return 'nicht_gefunden';}
  if(!st.isFile())return 'pfad_gefahr';
  if(st.uid===0&&st.gid===RUNNER_UID&&(st.mode&0o777)===0o640)continue;
  try{await ops.chown(p,0,RUNNER_UID);await ops.chmod(p,0o640);}
  catch(e){
   console.error('[reverse-executor] Eingaberechte nicht setzbar:',p,(e as NodeJS.ErrnoException).code??(e as Error).message);
   return 'keine_berechtigung:eingabe_rechte';
  }
 }
 return null;
}
/**
 * P18-T69: Ordner zwischen wurzel und Datei für den Runner (gid 65532) durchquerbar machen: root:65532 0710 (betreten ja,
 * auflisten nein). Ordner, die schon jeder betreten darf (o+x, z. B. 755 der Eintragswurzel), oder die bereits root:65532 mit
 * g+x sind, bleiben unverändert. Links und Nicht-Ordner im Pfad sowie Pfade außerhalb der Wurzel -> 'pfad_gefahr'.
 */
export async function reverseOrdnerDurchquerbar(wurzel:string,datei:string,ops:ReverseRechteOps=RECHTE_OPS):Promise<string|null>{
 const rel=path.relative(wurzel,path.dirname(datei));
 if(rel===''||rel==='.')return null;
 if(path.isAbsolute(rel)||rel.split(path.sep).some(t=>!t||t==='.'||t==='..'))return 'pfad_gefahr';
 let p=wurzel;
 for(const t of rel.split(path.sep)){
  p=path.join(p,t);
  let st;
  try{st=await ops.lstat(p);}catch{return 'nicht_gefunden';}
  if(!st.isDirectory())return 'pfad_gefahr';
  if(st.mode&0o001||(st.uid===0&&st.gid===RUNNER_UID&&st.mode&0o010))continue;
  try{await ops.chown(p,0,RUNNER_UID);await ops.chmod(p,0o710);}
  catch(e){
   console.error('[reverse-executor] Ordnerrechte nicht setzbar:',p,(e as NodeJS.ErrnoException).code??(e as Error).message);
   return 'keine_berechtigung:eingabe_rechte';
  }
 }
 return null;
}
/** P18-T69: Runner-Meldung eines gescheiterten Laufs ins Log (z. B. ungueltiger_auftrag); sonst bliebe nur der Fehlercode. */
function meldeRunnerFehler(kind:string,jobId:string,e:Record<string,unknown>):void{
 console.warn('[reverse-executor] Lauf gescheitert:',kind,jobId,'status',String(e.status),'fehlercode',String(e.fehlercode??'-'),
  'meldung',String(e.meldung??'').slice(0,500));
}
/** Arbeitsordner je Auftrag; der Container läuft als 65532 und muss hinein schreiben. */
export async function reverseArbeitsOrdner(k:ReverseExecutorKonfig,jobId:string):Promise<string>{
 if(!UUID.test(jobId))throw Error('reverse_job_ungueltig');
 await mkdir(k.arbeitRoot,{recursive:true,mode:0o711});
 const dir=path.join(k.arbeitRoot,jobId);
 await runnerOrdner(dir);
 return dir;
}
/**
 * P18-T66: Host-Pfad der Reverse-Wurzel. SYNAPSE_REVERSE_HOST_ROOT hat Vorrang; sonst liest die API (im Container) ihren eigenen
 * Mount mit Ziel = Reverse-Wurzel. Ohne Treffer (API nicht im Container) gilt der eigene Pfad. Ergebnis wird einmal ermittelt.
 */
export function reverseHostWurzel(k:ReverseExecutorKonfig,docker:Pick<Docker,'getContainer'>,selbst:string=os.hostname()):()=>Promise<string|null>{
 let ergebnis:Promise<string|null>|null=null;
 return ()=>ergebnis??=(async()=>{
  if(k.hostRoot)return k.hostRoot;
  try{
   const info=await docker.getContainer(selbst).inspect();
   const m=(info.Mounts??[]).find(x=>!!x.Destination&&path.resolve(x.Destination)===k.reverseRoot);
   if(m?.Source&&path.isAbsolute(m.Source)&&!m.Source.includes(':')){console.log('[reverse-executor] Host-Pfad der Bibliothek: '+m.Source);return m.Source;}
   console.warn('[reverse-executor] Kein Mount fuer '+k.reverseRoot+' im eigenen Container gefunden, Binds nutzen den API-Pfad.');
  }catch{/* nicht im Container oder kein Zugriff: eigener Pfad */}
  return null;
 })();
}
export function reverseMountResolver(k:ReverseExecutorKonfig,hostWurzel:()=>Promise<string|null>=async()=>k.hostRoot??null):(d:ToolDescriptor,ctx:ToolInstanceContext)=>Promise<ResolvedToolMount[]>{
 return async(d,ctx)=>{
  if(d.tool_id!==REVERSE_TOOL_ID)return [];
  // P18-T66: Docker bindet Host-Pfade. Ohne Übersetzung legt Docker auf dem Host einen leeren Ordner unter dem API-Pfad an,
  // der Runner findet /bib/<eintrag> nicht (ungueltiger_auftrag) und Ausgaben landeten ausserhalb der Bibliothek.
  const host=await hostWurzel();
  const aufHost=(p:string)=>host?path.join(host,path.relative(k.reverseRoot,p)):p;
  const mounts:ResolvedToolMount[]=[{role:'bibliothek',source:k.reverseRoot,hostSource:aufHost(k.reverseRoot),root:k.reverseRoot,allowWrite:false,allowProjectShare:false}];
  // Alter Descriptor (je Auftrag, während der Migration): nur dessen Ordner. Globaler Container: ganz _arbeit.
  if(ctx.job_id){const quelle=await reverseArbeitsOrdner(k,ctx.job_id);mounts.push({role:'arbeit',source:quelle,hostSource:aufHost(quelle),root:k.arbeitRoot,allowWrite:true,allowProjectShare:false});}
  else{await mkdir(k.arbeitRoot,{recursive:true,mode:0o711});mounts.push({role:'arbeit',source:k.arbeitRoot,hostSource:aufHost(k.arbeitRoot),root:k.arbeitRoot,allowWrite:true,allowProjectShare:false});}
  return mounts;
 };
}
/** Lokale Freigabe nur für den Reverse-Container; Kapazität begrenzen Lebenszyklus und Work-Budget. */
export const reverseRessourcen:ToolResourceAdapter={
 async acquire(d,ctx){return d.tool_id===REVERSE_TOOL_ID?'reverse-lokal:'+ctx.instance_id+':'+ctx.generation:null;},
 async release(){},
};
const fehlercode=(roh:unknown,detail?:unknown):string=>{
 const c=String(roh??'');
 if(c==='deadline')return 'zeitlimit';
 if(c==='format_nicht_unterstuetzt'){const d=String(detail??'').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,64);return d?c+':'+d:c;}
 if((REVERSE_FEHLERCODES as readonly string[]).includes(c))return c;
 // P18-T66/E2: unbekannte Runner-Codes als Detail behalten statt einzuebnen (zerlegeReverseFehlercode trennt sie wieder).
 const d=c.replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,64);
 return d?'werkzeug_fehler:'+d:'werkzeug_fehler';
};
/**
 * P18-T64: Formate, die der Runner (noch) nicht kann, VOR dem Containerlauf klar benennen statt 'nicht_unterstuetzt'.
 * P18-T49/T46: Raw-2352 (libmirage) und CloneCD (eigener Parser) liest der Runner jetzt selbst über seine Parser-Registry
 * und meldet fehlende Parser selbst (format_nicht_unterstuetzt:<format>). Die Liste ist deshalb leer; Einträge nur für
 * Formate, die nachweislich ohne Containerlauf abgelehnt werden sollen. N3: Raw-BIN mit CUE läuft über die CUE.
 */
const VORAB_OHNE_PARSER:readonly {format:string;passt:(kopf:Buffer)=>boolean}[]=[];
export async function reverseFormatVorpruefung(dateien:{pfad:string;rolle:string;name?:string}[]):Promise<string|null>{
 if(!VORAB_OHNE_PARSER.length)return null;
 for(const d of dateien){
  let kopf:Buffer;
  try{const h=await open(d.pfad,'r');try{const b=Buffer.alloc(64);const {bytesRead}=await h.read(b,0,64,0);kopf=b.subarray(0,bytesRead);}finally{await h.close();}}
  catch{continue;}
  for(const f of VORAB_OHNE_PARSER)if(f.passt(kopf))return 'format_nicht_unterstuetzt:'+f.format;
 }
 return null;
}

// ---------------------------------------------------------------------------------------------
export interface ReverseExecutorDeps {
 pool?:Db;konfig:ReverseExecutorKonfig;
 lifecycle:()=>ToolLifecycle|null;
 /** Server-Identität (ServerExecutor); null = noch keine registrierte Bootgeneration. */
 identitaet:()=>Promise<WorkIdentity|null>;
 jobs?:WorkJobService;
 uebernahme?:typeof uebernehmeEErgebnis;
 uebernahmeOptionen?:Parameters<typeof uebernehmeEErgebnis>[2];
 /** P18-T69: Eingaberechte setzen (Standard reverseEingabeLesbar; Tests ohne root ersetzen sie). */
 eingabeLesbar?:(pfade:string[],wurzel?:string)=>Promise<string|null>;
 registriereProjekt?:(name:string)=>Promise<void>;
}
export interface ReverseDurchlauf {geprueft:true;geweckt:number;gestartet:number;hinweis?:string}
interface ReverseQuelle {reverseId:string;mediumId:string;storageKey:string;dateien:{storageKey:string;rolle:string;name:string}[]}
export class ReverseExecutor {
 private readonly pool:Db;private readonly k:ReverseExecutorKonfig;private readonly jobs:WorkJobService;
 private readonly laufend=new Map<string,Promise<void>>();
 private wer:WorkIdentity|null=null;private eingerichtet=false;private beendet=false;
 /** P18-T64: true, solange noch der alte Descriptor je Auftrag gilt (Migration). */
 private altScope=false;private altGemeldet=false;
 constructor(private readonly deps:ReverseExecutorDeps){
  this.pool=deps.pool??getPool();this.k=deps.konfig;
  this.jobs=deps.jobs??createWorkJobService({pool:this.pool as unknown as WorkJobPool});
 }
 private domain(nodeId:string):string{return this.k.resourceDomain??'reverse:'+nodeId;}
 /** Hooks nur für Capability reverse_bibliothek; Claims ausschließlich mit der eigenen Server-Identität. */
 hooks():WorkJobHooks{
  return {
   resourceDomain:nodeId=>this.wer&&nodeId===this.wer.nodeId?this.domain(nodeId):undefined,
   authorizeJob:async(node:WorkNodeAuthority,job:WorkJob)=>{
    const w=this.wer;
    if(!w||this.beendet||node.node_id!==w.nodeId||String(node.boot_id)!==w.bootGeneration||node.service_token_hash!==w.authHash)return null;
    if(job.capability!==REVERSE_CAPABILITY||job.project!==REVERSE_PROJEKT||job.scope!=='reverse'||!this.k.kinds.includes(job.kind)||job.resourceNeed.gpu)return null;
    const max=this.k.parallel+ganz(process.env,'SYNAPSE_WORK_INTERACTIVE_RESERVE',1,0);
    const n=reverseContainerBedarf(this.k);
    return {resourceDomain:this.domain(w.nodeId),maxConcurrent:max,budget:{cpu:n.cpu*max,ram:n.ram*max,vram:0,gpu:false}};
   },
   inputStillCurrent:async(job:WorkJob,client:WorkJobClient)=>this.eingabeAktuell(job,client),
   outputIsStaged:async(job:WorkJob,out:Ref,client:WorkJobClient)=>{
    // P18-T69: S3 gilt als gestaged, wenn die S3-Schicht der Datei den Marker dieses Auftrags traegt.
    if(job.kind==='reverse-S3'){
     if(out.scope!=='reverse'||out.id!==job.id)return false;
     const s=await client.query(`SELECT 1 FROM reverse_schichten WHERE datei_id=$1::bigint AND schicht='S3' AND aktuell
      AND status IN ('fertig','teilweise') AND ausgabe_key=$2`,[job.inputRef.revision,reverseS3AusgabeKey(job.inputRef.id,job.inputRef.revision,job.id)]);
     return s.rows.length>0;
    }
    if(out.scope!=='reverse'||out.id!==job.id||job.kind!=='reverse-E')return false;
    const r=await client.query(`SELECT 1 FROM reverse_schichten s JOIN reverse_medien m ON m.id=s.medium_id
     WHERE s.medium_id=$1::bigint AND m.eintrag_id=$2 AND s.datei_id IS NULL AND s.schicht='E' AND s.aktuell
      AND s.status IN ('fertig','teilweise') AND s.ausgabe_key=$3`,
     [job.inputRef.revision,job.inputRef.id,job.inputRef.id+'/entpackt/'+reverseEGruppe(job.inputRef.revision)+'/'+job.id.toLowerCase()]);
    return r.rows.length>0;
   },
  };
 }
 private async eingabeAktuell(job:WorkJob,client:Pick<WorkJobClient,'query'>):Promise<boolean>{
  const ref=job.inputRef;
  if(job.kind==='reverse-S3')return this.dateiAktuell(job,client);
  if(job.kind!=='reverse-E'||ref.scope!=='reverse'||!/^[1-9][0-9]{0,18}$/.test(ref.revision))return false;
  const r=await client.query(`SELECT 1 FROM reverse_medien m JOIN reverse_eintraege e ON e.id=m.eintrag_id
   WHERE m.id=$1::bigint AND m.eintrag_id=$2 AND m.satz_sha256=$3 AND e.status='bestaetigt' FOR SHARE OF m`,[ref.revision,ref.id,ref.sha256]);
  return r.rows.length>0;
 }
 /** P18-T64: ALLE Dateien des Mediums (z. B. .ccd + .img + .sub, .cue + .bin), Hauptdatei zuerst. */
 private async eingabe(job:WorkJob):Promise<ReverseQuelle|null>{
  const ref=job.inputRef;
  if(job.kind!=='reverse-E'||!/^[1-9][0-9]{0,18}$/.test(ref.revision))return null;
  const rows=(await this.pool.query(`SELECT m.eintrag_id,m.id::text AS medium_id,d.storage_key,d.rolle,d.original_name FROM reverse_medien m
   JOIN reverse_eintraege e ON e.id=m.eintrag_id JOIN reverse_medien_dateien d ON d.medium_id=m.id
   WHERE m.id=$1::bigint AND m.eintrag_id=$2 AND m.satz_sha256=$3 AND e.status='bestaetigt' ORDER BY (d.rolle='haupt') DESC,d.id LIMIT 64`,[ref.revision,ref.id,ref.sha256])).rows;
  const sicher=(k:string)=>!!k&&!k.startsWith('/')&&!k.includes('\\')&&!k.split('/').some(t=>!t||t==='.'||t==='..');
  if(!rows.length||rows[0].rolle!=='haupt'||rows.some(r=>!sicher(String(r.storage_key??''))))return null;
  const dateien=rows.map(r=>({storageKey:String(r.storage_key),rolle:String(r.rolle),name:String(r.original_name??'').slice(0,255)}));
  return {reverseId:String(rows[0].eintrag_id),mediumId:String(rows[0].medium_id),storageKey:dateien[0].storageKey,dateien};
 }
 /** E1: Systemprojekt, Descriptor und Aktivierung idempotent anlegen. */
 /** M2: alte Job-Container ohne laufenden Auftrag über den Lebenszyklus stoppen (finishStop). */
 private async altAuslaufen(lc:ToolLifecycle):Promise<number>{
  const rows=(await this.pool.query(`SELECT t.work_job_id::text AS job FROM tool_containers t LEFT JOIN work_jobs w ON w.id=t.work_job_id
   WHERE t.tool_id=$1 AND t.state IN ('warm','waiting') AND t.work_job_id IS NOT NULL AND (w.id IS NULL OR w.state NOT IN ('leased','staged'))
    AND NOT EXISTS(SELECT 1 FROM tool_container_runs r WHERE r.instance_id=t.instance_id AND r.state IN ('running','unknown'))`,[REVERSE_TOOL_ID])).rows;
  let n=0;
  for(const r of rows){const x=await lc.neustart(REVERSE_TOOL_ID,REVERSE_PROJEKT,String(r.job));if(x.neu_gestartet)n++;}
  if(n)console.log('[reverse-executor] Migration: '+n+' ruhende(r) Alt-Container gestoppt.');
  return n;
 }
 async einrichten(lc:ToolLifecycle|null=null):Promise<void>{
  await (this.deps.registriereProjekt??registerVirtualProject)(REVERSE_PROJEKT);
  let aktuell=true;
  try{await registerToolDescriptor(this.pool,reverseToolDescriptor(this.k),SERVER_AUTHORITY);}
  catch(e){
   if((e as Error).message!=='tool_descriptor_in_use')throw e;
   // P18-T64-Migration: alte Job-Container laufen über den Lebenszyklus aus; je Durchlauf erneut versuchen.
   aktuell=false;if(!this.altGemeldet){this.altGemeldet=true;console.warn('[reverse-executor] Descriptor geändert, läuft noch mit altem Stand bis die Container ruhen.');}
  }
  await setToolActivation(this.pool,REVERSE_TOOL_ID,null,true,SERVER_AUTHORITY);
  // M2: im Altmodus Projektaktivierung aus -> weder Lebenszyklus-Tick noch Wake starten neue Job-Container;
  // laufende Aufträge enden, ruhende Alt-Container werden gestoppt. Danach gelingt die Umstellung sofort.
  await setToolActivation(this.pool,REVERSE_TOOL_ID,REVERSE_PROJEKT,aktuell,SERVER_AUTHORITY);
  if(!aktuell&&lc)await this.altAuslaufen(lc).catch(e=>console.error('[reverse-executor] Alt-Container stoppen fehlgeschlagen:',(e as Error).message));
  if(aktuell){
   const d=(await this.pool.query('SELECT descriptor FROM tool_descriptors WHERE tool_id=$1',[REVERSE_TOOL_ID])).rows[0]?.descriptor;
   this.altScope=validateToolDescriptor(d).instance_scope==='job';
   if(this.altGemeldet)console.log('[reverse-executor] Umstellung auf den globalen Reverse-Container abgeschlossen.');
  }else this.altScope=true;
  this.eingerichtet=aktuell;
 }
 async durchlauf():Promise<ReverseDurchlauf>{
  const leer=(hinweis?:string):ReverseDurchlauf=>({geprueft:true,geweckt:0,gestartet:0,...(hinweis?{hinweis}:{})});
  if(this.beendet)return leer('beendet');
  // K6: ohne Lebenszyklus nichts schreiben.
  const lc=this.deps.lifecycle();if(!lc)return leer('tool_lifecycle_aus');
  if(!this.eingerichtet){
   await this.einrichten(lc);
   // M2: solange alte Container auslaufen, keine neuen wecken oder claimen.
   if(!this.eingerichtet)return leer('migration_alte_container_laufen_aus');
  }
  this.wer=await this.deps.identitaet();
  if(!this.wer)return leer('server_identitaet_fehlt');
  await this.raeumeArbeitAuf().catch(e=>console.error('[reverse-executor] Aufräumen fehlgeschlagen:',(e as Error).message));
  // W3: nur so viele Aufträge wecken und claimen, wie Plätze frei sind.
  const frei=this.k.parallel-this.laufend.size;
  if(frei<=0)return {geprueft:true,geweckt:0,gestartet:0};
  // Der Claim-Guard verlangt einen warmen Job-Container; offene Aufträge deshalb zuerst wecken.
  const offen=(await this.pool.query(`SELECT id FROM work_jobs WHERE capability=$1 AND project=$2 AND kind=ANY($3::text[])
   AND state='pending' AND (deadline IS NULL OR deadline>clock_timestamp()) ORDER BY created_at,id LIMIT $4`,
   [REVERSE_CAPABILITY,REVERSE_PROJEKT,this.k.kinds,frei])).rows;
  let geweckt=0;
  // P18-T64: der globale Container wird einmal geweckt; nur der alte Descriptor braucht einen Container je Auftrag.
  for(const row of this.altScope?offen:offen.slice(0,1)){try{await lc.wake(REVERSE_TOOL_ID,REVERSE_PROJEKT,String(row.id));geweckt++;}catch(e){console.error('[reverse-executor] Wecken fehlgeschlagen:',(e as Error).message);}}
  const claims=await this.jobs.claim(this.wer,{limit:frei,leaseSeconds:this.k.leaseSeconds});
  const wer=this.wer;
  for(const job of claims){
   const lauf=this.fuehreAus(lc,wer,job).catch(e=>console.error('[reverse-executor] Auftrag fehlgeschlagen:',job.id,(e as Error).message))
    .finally(()=>{this.laufend.delete(job.id);});
   this.laufend.set(job.id,lauf);
  }
  return {geprueft:true,geweckt,gestartet:claims.length};
 }
 /** K3: Arbeitsordner ohne offenen Auftrag (verlorene Lease, Abbruch) entfernen. */
 async raeumeArbeitAuf():Promise<number>{
  let namen:string[];
  try{namen=(await readdir(this.k.arbeitRoot)).filter(n=>UUID.test(n)&&!this.laufend.has(n));}catch{return 0;}
  if(!namen.length)return 0;
  const offen=new Set((await this.pool.query("SELECT id::text FROM work_jobs WHERE id=ANY($1::uuid[]) AND state IN ('pending','leased','staged')",[namen])).rows.map(r=>String(r.id)));
  // Fertige S3-Manifeste bleiben für Budget-Nachzüge erhalten. Nur das jeweils referenzierte Artefakt wird gebunden.
  const behalten=new Set((await this.pool.query("SELECT DISTINCT lower(metadaten#>>'{s3_artefakt,job_id}') AS id FROM reverse_dateien WHERE metadaten#>>'{s3_artefakt,job_id}'=ANY($1::text[])",[namen])).rows.map(r=>String(r.id)));
  let n=0;
  for(const name of namen){
   if(behalten.has(name.toLowerCase())){if(!this.altScope)await sperreArbeitsOrdner(path.join(this.k.arbeitRoot,name));continue;}
   if(!offen.has(name.toLowerCase())){await rm(path.join(this.k.arbeitRoot,name),{recursive:true,force:true});n++;}
   else if(!this.altScope)await sperreArbeitsOrdner(path.join(this.k.arbeitRoot,name)); // M1: nicht laufender Auftrag -> für den Runner gesperrt
  }
  return n;
 }
 /** Wartet auf laufende Aufträge (Tests, geordnetes Herunterfahren). */
 async leerlauf():Promise<void>{await Promise.allSettled([...this.laufend.values()]);}
 private async leaseLebt(c:Pick<WorkJobClient,'query'>,job:WorkJob,wer:WorkIdentity,sperren:boolean):Promise<boolean>{
  const r=await c.query(`SELECT 1 FROM work_jobs WHERE id=$1 AND claim_token=$2 AND owner_node=$3 AND boot_generation=$4::uuid AND owner_auth_hash=$5
   AND state='leased' AND lease_until>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp())${sperren?' FOR UPDATE':''}`,
   [job.id,job.claimToken,wer.nodeId,wer.bootGeneration,wer.authHash]);
  return r.rows.length>0;
 }
 /** Übernahme nur, solange die eigene Lease gilt; späte Ergebnisse werden verworfen. */
 private async uebernimmUnterFence(job:WorkJob,wer:WorkIdentity,e:Parameters<typeof uebernehmeEErgebnis>[1]):Promise<{dateien:number;verworfen:number}|null>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return null;}
   // Ohne connect(): die Übernahme läuft in dieser Transaktion unter dem Lease-Fence.
   const r=await (this.deps.uebernahme??uebernehmeEErgebnis)({query:c.query.bind(c)},e,this.deps.uebernahmeOptionen);
   await c.query('COMMIT');return r;
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
 }
 /**
  * Endgültiger Fehlschlag unter Lease-Fence. P18-T64: immer eine Logzeile; fachliche Fehler (deterministisch) setzen
  * Auftrag und Schicht sofort auf 'fehler' mit echtem Code, sonst legt die Pipeline einen neuen Versuch an.
  */
 private async scheitern(job:WorkJob,wer:WorkIdentity,code:string):Promise<boolean>{
  const endgueltig=reverseFehlerDeterministisch(code);
  console.warn('[reverse-executor] Auftrag gescheitert:',job.id,'kind',job.kind,'eintrag',job.inputRef.id,'medium',job.inputRef.revision,'versuch',job.attempt,'code',code,endgueltig?'(fachlich, kein Neuversuch)':'(Neuversuch durch Pipeline)');
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return false;}
   await c.query(`UPDATE work_jobs SET state='failed',error_code=$2,lease_until=NULL,staged_output_ref=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id,code]);
   await c.query("INSERT INTO work_job_audit(id,job_id,event,detail) VALUES(gen_random_uuid(),$1,'failed',$2::jsonb)",[job.id,JSON.stringify({fehlercode:code,executor:'reverse'})]);
   await c.query('UPDATE reverse_auftraege SET fehlercode=$2,updated_at=clock_timestamp() WHERE p20_auftrag_id=$1',[job.id,code]);
   if(endgueltig){
    await c.query("UPDATE reverse_auftraege SET status='fehler',lease_token=NULL,lease_bis=NULL WHERE p20_auftrag_id=$1 AND status IN ('offen','wartet','laeuft')",[job.id]);
    await c.query("UPDATE reverse_schichten SET status='fehler',fehlercode=$2 WHERE aktuell AND status IN ('offen','wartet','laeuft') AND auftrag_id IN (SELECT id FROM reverse_auftraege WHERE p20_auftrag_id=$1)",[job.id,code]);
    await c.query("UPDATE reverse_analyse_cache SET status='fehler',fehlercode=$2 WHERE p20_auftrag_id=$1",[job.id,code]);
   }
   await c.query('COMMIT');return true;
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
 }
 private async fuehreAus(lc:ToolLifecycle,wer:WorkIdentity,job:WorkJob):Promise<void>{
  const token=job.claimToken!;
  if(job.capability!==REVERSE_CAPABILITY||job.project!==REVERSE_PROJEKT||!this.k.kinds.includes(job.kind)){
   await this.jobs.release(wer,job.id,token);return;
  }
  if(job.kind==='reverse-S3')return this.fuehreS3Aus(lc,wer,job);
  // W5/K3: kein Endlos-Neuentpacken nach wiederholtem Lease-Verlust oder Übernahmefehler.
  if(job.attempt>this.k.retryMax){if(await this.scheitern(job,wer,'werkzeug_fehler'))await rm(path.join(this.k.arbeitRoot,job.id),{recursive:true,force:true});return;}
  const quelle=await this.eingabe(job);
  if(!quelle){await this.scheitern(job,wer,'nicht_gefunden');return;}
  // P18-T64: bekannte, noch nicht unterstützte Formate ohne Containerlauf klar benennen.
  const vorab=await reverseFormatVorpruefung(quelle.dateien.map(d=>({pfad:path.join(this.k.reverseRoot,d.storageKey),rolle:d.rolle,name:d.name})));
  if(vorab){await this.scheitern(job,wer,vorab);return;}
  // P18-T66: Originale liegen ggf. als 0600 root; der Runner (65532) muss sie lesen dürfen.
  const rechte=await reverseEingabeLesbar(quelle.dateien.map(d=>path.join(this.k.reverseRoot,d.storageKey)));
  if(rechte){await this.scheitern(job,wer,rechte);return;}
  // Globaler Container: /arbeit=_arbeit, Ausgabe /arbeit/<jobId>. Alter Descriptor: /arbeit=_arbeit/<jobId>, Ausgabe darin.
  const alt=this.altScope;
  const arbeit=await reverseArbeitsOrdner(this.k,job.id),ausgabe=alt?path.join(arbeit,job.id):arbeit;
  // Der Runner verlangt einen leeren Ausgabeordner; Reste eines verlorenen Versuchs entfernen.
  await rm(ausgabe,{recursive:true,force:true});
  await runnerOrdner(ausgabe);
  let lebt=true,aufraeumen=false;
  const timer=setInterval(()=>{void this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).then(ok=>{if(!ok)lebt=false;},()=>{lebt=false;});},this.k.renewMs);
  timer.unref();
  try{
   let ergebnis:Record<string,unknown>;
   try{
    const [peStand,siedlerStand]=await Promise.all([leseReversePeRessourcenSchalter(),leseReverseSiedler3Schalter()]);
    ergebnis=await lc.execute(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id,wer,token,async()=>({kommando:'extrahieren',schicht:'E',
     eingabe:'/bib/'+quelle.storageKey,eingabe_name:quelle.dateien[0].name||undefined,ausgabe:'/arbeit/'+job.id,
     begleitdateien:quelle.dateien.slice(1).map(d=>({pfad:'/bib/'+d.storageKey,name:d.name})),
     optionen:{wav_pregap:this.k.wavPregap,pe_ressourcen:peStand.aktiv,pe_ressourcen_stand:peStand,siedler3:siedlerStand.aktiv,siedler3_stand:siedlerStand},
     grenzen:{zeitlimit_s:this.k.zeitlimitS,max_dateien:this.k.maxDateien,max_bytes:this.k.maxBytes,max_verschachtelung:this.k.maxVerschachtelung}}));
   }catch(e){
    if(!alt)await sperreArbeitsOrdner(arbeit);
    const m=(e as Error).message;
    // Nicht abgesetzt: sauber zurückgeben. Sonst bleibt der Auftrag bis zum Lease-Ablauf gesperrt.
    if(m==='tool_not_ready'||m==='tool_runner_capacity'){await this.jobs.release(wer,job.id,token);aufraeumen=true;}
    else console.error('[reverse-executor] Ausführung ohne sicheres Ende:',job.id,m);
    return;
   }
   clearInterval(timer);
   // M1: Lauf beendet -> Ordner gehört wieder root; der Runner kann ihn nicht mehr verändern (Übernahme liest als root).
   if(!alt)await sperreArbeitsOrdner(arbeit);
   const status=String(ergebnis.status);
   const manifest=Array.isArray(ergebnis.manifest)?ergebnis.manifest as ReverseEManifestEintrag[]:[];
   if((status==='fertig'||(status==='teilweise'&&manifest.length>0))&&lebt){
    // K7: Lease vor der Übernahme einmal auffrischen (Hashing großer Ergebnisse unter dem Fence).
    if(!await this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).catch(()=>false)){console.warn('[reverse-executor] Lease verloren, Ergebnis verworfen:',job.id);return;}
    let r:{dateien:number;verworfen:number}|null;
    try{r=await this.uebernimmUnterFence(job,wer,{jobId:job.id,reverseId:quelle.reverseId,mediumId:quelle.mediumId,arbeitsWurzel:ausgabe,manifest});}
    catch(e){
     // W5: fachlicher Fehler -> endgültig; sonst freigeben, bis der Versuchszähler erreicht ist.
     console.error('[reverse-executor] Übernahme fehlgeschlagen:',job.id,(e as Error).message);
     if(e instanceof ReverseEUebernahmeFehler||job.attempt>=this.k.retryMax)aufraeumen=await this.scheitern(job,wer,e instanceof ReverseEUebernahmeFehler?fehlercode(e.code):'werkzeug_fehler');
     else aufraeumen=await this.jobs.release(wer,job.id,token);
     return;
    }
    if(!r){console.warn('[reverse-executor] Späte Rückmeldung nach Lease-Ablauf verworfen:',job.id);return;}
    aufraeumen=true;
    const out={scope:'reverse',id:job.id,revision:String(job.attempt),sha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
    if(!await this.jobs.stage(wer,job.id,token,out)){console.warn('[reverse-executor] Staging abgewiesen:',job.id);return;}
    const done=await this.jobs.complete(wer,job.id,token,job.inputRef);
    if(!done.completed)console.warn('[reverse-executor] Abschluss abgewiesen:',job.id);
    return;
   }
   if(!lebt){console.warn('[reverse-executor] Lease verloren, Ergebnis verworfen:',job.id);return;}
   meldeRunnerFehler(job.kind,job.id,ergebnis);
   aufraeumen=await this.scheitern(job,wer,status==='teilweise'?'zeitlimit':fehlercode(ergebnis.fehlercode,ergebnis.format_detail));
  }finally{
   clearInterval(timer);
   // Nur mit gültigem Abschluss aufräumen: ein Folgeversuch nutzt denselben Auftragsordner.
   if(aufraeumen)await rm(arbeit,{recursive:true,force:true}).catch(()=>undefined);
  }
 }
 /** P18-T69/E3: Datei-Eingabe eines reverse-S3-Auftrags (inputRef.revision = reverse_dateien.id, sha256 = Dateiinhalt). */
 private async dateiAktuell(job:WorkJob,client:Pick<WorkJobClient,'query'>):Promise<boolean>{
  const ref=job.inputRef;
  if(ref.scope!=='reverse'||!/^[1-9][0-9]{0,18}$/.test(ref.revision))return false;
  const r=await client.query(`SELECT 1 FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id
   WHERE d.id=$1::bigint AND d.eintrag_id=$2 AND d.sha256=$3 AND d.storage_key IS NOT NULL AND e.status='bestaetigt' FOR SHARE OF d`,[ref.revision,ref.id,ref.sha256]);
  return r.rows.length>0;
 }
 private async s3Quelle(job:WorkJob):Promise<{reverseId:string;dateiId:string;storageKey:string}|null>{
  const ref=job.inputRef;
  if(!/^[1-9][0-9]{0,18}$/.test(ref.revision))return null;
  const d=(await this.pool.query(`SELECT d.id::text AS id,d.eintrag_id,d.storage_key FROM reverse_dateien d JOIN reverse_eintraege e ON e.id=d.eintrag_id
   WHERE d.id=$1::bigint AND d.eintrag_id=$2 AND d.sha256=$3 AND e.status='bestaetigt'`,[ref.revision,ref.id,ref.sha256])).rows[0];
  const key=String(d?.storage_key??'');
  if(!d||!key||key.startsWith('/')||key.includes('\\')||key.split('/').some(t=>!t||t==='.'||t==='..'))return null;
  return {reverseId:String(d.eintrag_id),dateiId:String(d.id),storageKey:key};
 }
 private async uebernimmS3UnterFence(job:WorkJob,wer:WorkIdentity,e:Parameters<typeof uebernehmeS3Ergebnis>[1]):Promise<Awaited<ReturnType<typeof uebernehmeS3Ergebnis>>|null>{
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return null;}
   const r=await uebernehmeS3Ergebnis({query:c.query.bind(c)},e,this.deps.uebernahmeOptionen);
   await c.query('COMMIT');return r;
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
 }
 /**
  * P18-T69/E3: reverse-S3 = ein Ghidra-Lauf (Runner werkzeug analyzeHeadless) fuer EINE Datei; die Uebernahme schreibt S2 und S3.
  * Gleicher Ablauf wie E: Lease-Erneuerung, Auftragsordner, Uebernahme unter Lease-Fence, stage, complete.
  */
 private async fuehreS3Aus(lc:ToolLifecycle,wer:WorkIdentity,job:WorkJob):Promise<void>{
  const token=job.claimToken!;
  if(job.attempt>this.k.retryMax){if(await this.scheitern(job,wer,'werkzeug_fehler'))await rm(path.join(this.k.arbeitRoot,job.id),{recursive:true,force:true});return;}
  const quelle=await this.s3Quelle(job);
  if(!quelle){await this.scheitern(job,wer,'nicht_gefunden');return;}
  // P18-T69: Datei 0640 root:65532 und die Ordner darueber durchquerbar (entpackte Dateien liegen unter 0750 root:root).
  const rechte=await (this.deps.eingabeLesbar??reverseEingabeLesbar)([path.join(this.k.reverseRoot,quelle.storageKey)],this.k.reverseRoot);
  if(rechte){await this.scheitern(job,wer,rechte);return;}
  const alt=this.altScope;
  const arbeit=await reverseArbeitsOrdner(this.k,job.id),ausgabe=alt?path.join(arbeit,job.id):arbeit;
  await rm(ausgabe,{recursive:true,force:true});
  await runnerOrdner(ausgabe);
  let lebt=true,aufraeumen=false;
  const timer=setInterval(()=>{void this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).then(ok=>{if(!ok)lebt=false;},()=>{lebt=false;});},this.k.renewMs);
  timer.unref();
  try{
   let ergebnis:Record<string,unknown>;
   try{
    ergebnis=await lc.execute(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id,wer,token,async()=>({werkzeug:'analyzeHeadless',schicht:'S3',
     eingabe:'/bib/'+quelle.storageKey,ausgabe:'/arbeit/'+job.id,
     grenzen:{zeitlimit_s:this.k.s3ZeitlimitS,max_bytes:this.k.s3MaxBytes,max_dateien:this.k.maxDateien}}));
   }catch(e){
    if(!alt)await sperreArbeitsOrdner(arbeit);
    const m=(e as Error).message;
    if(m==='tool_not_ready'||m==='tool_runner_capacity'){await this.jobs.release(wer,job.id,token);aufraeumen=true;}
    else console.error('[reverse-executor] S3-Ausfuehrung ohne sicheres Ende:',job.id,m);
    return;
   }
   clearInterval(timer);
   if(!alt)await sperreArbeitsOrdner(arbeit);
   const status=String(ergebnis.status);
   const manifest=Array.isArray(ergebnis.manifest)?ergebnis.manifest as ReverseEManifestEintrag[]:[];
   if(status==='fertig'&&lebt){
    if(!await this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).catch(()=>false)){console.warn('[reverse-executor] Lease verloren, S3-Ergebnis verworfen:',job.id);return;}
    const dauer=typeof ergebnis.dauer_s==='number'&&Number.isFinite(ergebnis.dauer_s)?Math.round(ergebnis.dauer_s*1000):null;
    let r:Awaited<ReturnType<typeof uebernehmeS3Ergebnis>>|null;
    try{r=await this.uebernimmS3UnterFence(job,wer,{jobId:job.id,reverseId:quelle.reverseId,dateiId:quelle.dateiId,arbeitsWurzel:ausgabe,manifest,dauerMs:dauer});}
    catch(e){
     console.error('[reverse-executor] S3-Uebernahme fehlgeschlagen:',job.id,(e as Error).message);
     if(e instanceof ReverseS3UebernahmeFehler||job.attempt>=this.k.retryMax)aufraeumen=await this.scheitern(job,wer,e instanceof ReverseS3UebernahmeFehler?fehlercode(e.code):'werkzeug_fehler');
     else aufraeumen=await this.jobs.release(wer,job.id,token);
     return;
    }
    if(!r){console.warn('[reverse-executor] Spaete S3-Rueckmeldung nach Lease-Ablauf verworfen:',job.id);return;}
    aufraeumen=false; // Das geprüfte Manifest ist für einen späteren Budget-Nachzug gebunden.
    console.log('[reverse-executor] S3 fertig:',job.id,'datei',quelle.dateiId,'status',r.status,'funktionen',r.funktionen,'gespeichert',r.gespeichert,'dauer_ms',dauer);
    const out={scope:'reverse',id:job.id,revision:String(job.attempt),sha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
    if(!await this.jobs.stage(wer,job.id,token,out)){console.warn('[reverse-executor] S3-Staging abgewiesen:',job.id);return;}
    const done=await this.jobs.complete(wer,job.id,token,job.inputRef);
    if(!done.completed)console.warn('[reverse-executor] S3-Abschluss abgewiesen:',job.id);
    return;
   }
   if(!lebt){console.warn('[reverse-executor] Lease verloren, S3-Ergebnis verworfen:',job.id);return;}
   meldeRunnerFehler(job.kind,job.id,ergebnis);
   aufraeumen=await this.scheitern(job,wer,status==='teilweise'?'zeitlimit':fehlercode(ergebnis.fehlercode,ergebnis.format_detail));
  }finally{
   clearInterval(timer);
   if(aufraeumen)await rm(arbeit,{recursive:true,force:true}).catch(()=>undefined);
  }
 }
 /** Lesender Status für reverse(status): Container des jüngsten offenen Auftrags dieses Eintrags. */
 async containerStatus(rid:string):Promise<ReverseContainerInfo>{
  const ruht:ReverseContainerInfo={zustand:'ruht',kaltstart_s:null};
  const lc=this.deps.lifecycle();if(!lc)return ruht;
  try{
   const j=(await this.pool.query(`SELECT id FROM work_jobs WHERE capability=$1 AND project=$2 AND kind=ANY($3::text[]) AND scope='reverse'
    AND input_ref->>'id'=$4 AND state IN ('pending','leased','staged') ORDER BY created_at DESC LIMIT 1`,[REVERSE_CAPABILITY,REVERSE_PROJEKT,this.k.kinds,rid])).rows[0];
   if(!j)return ruht;
   const s=await lc.status(REVERSE_TOOL_ID,REVERSE_PROJEKT,String(j.id));
   const zustand=s.status==='running'||s.status==='warm'?'laeuft':s.status==='waiting'||s.status==='stopping'?'startet':'ruht';
   return {zustand,kaltstart_s:typeof s.coldstart_estimate_ms==='number'?Math.round(s.coldstart_estimate_ms/100)/10:null,
    ...(s.container_id?{container_id:String(s.container_id)}:{})};
  }catch{return ruht;}
 }
 async beende():Promise<void>{this.beendet=true;await this.leerlauf();}
}

// ---------------------------------------------------------------------------------------------
/**
 * B1: eigener CPU-Knoten über denselben R4.3-Registryvertrag, aber eigener Env-Namensraum SYNAPSE_REVERSE_*
 * (NODE_ID, EXECUTOR_OWNER, COMPUTE_TOKEN, NODE_REGISTRATION, HOST_PROBE_FILE). Parser-Knoten (SYNAPSE_SERVER_*)
 * und dessen lokale GPU-Admission bleiben unberührt; claimOwner/Fence sind je node_id eindeutig.
 * P21-T15: dieselbe Identität ist Ersatz-Ausführer für Hex (live gibt es keinen Parser-Serverknoten). Gleichzeitige
 * Aufrufe (Reverse-Takt und Hex-Anbindung) teilen sich einen Lauf, damit start() nie doppelt rotiert.
 */
export function reverseServerIdentitaet(env:NodeJS.ProcessEnv=process.env):()=>Promise<WorkIdentity|null>{
 const server=new ServerExecutor({envPrefix:'SYNAPSE_REVERSE_',nurCpu:true,lokaleAdmission:false,hex:'ersatz'});let gestartet=false,gemeldet=false;
 const konflikt=!!server.identity.nodeId&&server.identity.nodeId===env.SYNAPSE_SERVER_NODE_ID?.trim();
 let lauf:Promise<WorkIdentity|null>|null=null;
 const einmal=async():Promise<WorkIdentity|null>=>{
  if(!server.identity.nodeId){if(!gemeldet){gemeldet=true;console.warn('[reverse-executor] SYNAPSE_REVERSE_NODE_ID fehlt – keine Claims.');}return null;}
  if(konflikt){if(!gemeldet){gemeldet=true;console.error('[reverse-executor] SYNAPSE_REVERSE_NODE_ID darf nicht SYNAPSE_SERVER_NODE_ID sein – keine Claims.');}return null;}
  try{
   if(!gestartet){await server.start();gestartet=true;}
   else if(!await server.refresh())return null;
  }catch(e){if(!gemeldet){gemeldet=true;console.error('[reverse-executor] Server-Identität abgelehnt:',(e as Error).message);}return null;}
  const f=server.fence;
  return f?{nodeId:f.nodeId,bootGeneration:f.bootId,authHash:f.tokenHash}:null;
 };
 return ()=>lauf??=einmal().finally(()=>{lauf=null;});
}
/**
 * Vor initToolLifecycle aufrufen: konfiguriert Docker-Mounts/Ressourcen, Hooks und die Abholschleife.
 * Liefert null, wenn Reverse aus ist oder die Konfiguration fehlt.
 */
export function starteReverseExecutor():{beende:()=>Promise<void>}|null{
 const asset=getAssetKonfiguration();
 if(process.env.SYNAPSE_REVERSE_ENABLED!=='1'||!asset.reverse.aktiv)return null;
 let k:ReverseExecutorKonfig|null;
 try{k=ladeReverseExecutorKonfig(process.env,asset.speicher.reverseRoot);}
 catch(e){console.error('[reverse-executor] Konfiguration ungültig, Executor bleibt aus:',(e as Error).message);return null;}
 if(!k)return null;
 const konfig=k;
 try{configureToolLifecycleAdapters({executor:new DockerToolContainerExecutor({socketPath:process.env.SYNAPSE_TOOL_DOCKER_SOCKET,resolveMounts:reverseMountResolver(konfig,reverseHostWurzel(konfig,new Docker({socketPath:process.env.SYNAPSE_TOOL_DOCKER_SOCKET??'/var/run/docker.sock'}))),
  lokaleImages:process.env.SYNAPSE_REVERSE_IMAGE_LOKAL==='1'}),resources:reverseRessourcen});}
 catch(e){console.error('[reverse-executor] Tool-Lebenszyklus bereits gestartet, Executor bleibt aus:',(e as Error).message);return null;}
 const identitaet=reverseServerIdentitaet();
 const executor=new ReverseExecutor({konfig,lifecycle:getToolLifecycle,identitaet});
 // P21-T15: Hex bindet sofort und hält den Knoten frisch, auch ohne Docker/Lebenszyklus und ohne Reverse-Aufträge.
 const hexAnbinden=()=>{void identitaet().catch(e=>console.error('[reverse-executor] Hex-Anbindung fehlgeschlagen:',(e as Error).message));};
 hexAnbinden();const hexTimer=setInterval(hexAnbinden,konfig.tickMs);hexTimer.unref();
 const abmelden=registriereWorkJobHooks(REVERSE_CAPABILITY,executor.hooks());
 // K5: reverse(status) liest den echten Containerzustand über die Reverse-Runtime (nach starteReversePipeline gesetzt).
 const ohneStatus=ergaenzeReverseRuntime({containerStatus:rid=>executor.containerStatus(rid)});
 // P18-T64: Ausführer anmelden – Pipeline reiht nur noch diese Kinds ein, Diagnose/Entstörer sehen Kapazität und können neu starten.
 const abmeldenAusfuehrer=meldeReverseAusfuehrer({kinds:konfig.kinds,parallel:konfig.parallel,
  kapazitaet:async()=>{const lc=getToolLifecycle();if(!lc)throw Error('tool_lifecycle_aus');return lc.kapazitaet();},
  containerNeustart:async(jobId?:string|null)=>{const lc=getToolLifecycle();if(!lc)return {neu_gestartet:false,zustand:'tool_lifecycle_aus'};return lc.neustart(REVERSE_TOOL_ID,REVERSE_PROJEKT,jobId??null);}});
 let running:Promise<ReverseDurchlauf>|null=null;
 const tick=async()=>{if(!running)running=executor.durchlauf().finally(()=>{running=null;});return running;};
 registriereWorker({name:'reverse-executor',beschreibung:'RV12 reverse-E-Aufträge im Reverse-Container ausführen',durchlauf:tick});
 const run=()=>{if(workerPausiert('reverse-executor'))return;void tick().catch(e=>console.error('[reverse-executor] Durchlauf fehlgeschlagen:',(e as Error).message));};
 const timer=setInterval(run,konfig.tickMs);timer.unref();
 console.log('[reverse-executor] aktiv: Kinds '+konfig.kinds.join(',')+', parallel '+konfig.parallel);
 return {beende:async()=>{clearInterval(timer);clearInterval(hexTimer);abmelden();ohneStatus();abmeldenAusfuehrer();await executor.beende();}};
}
