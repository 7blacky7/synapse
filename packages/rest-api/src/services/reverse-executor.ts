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
 leseReverseFortschrittSchalter,normalisiereReverseFortschritt,speichereReverseFortschritt,reverseStornoAngefordert,
 leseReverseAufsicht,leseReverseEinstellwerte,leseReverseBlockSchalter,leseReverseProduktSchalter,reverseZahl,reverseBudget,
 uebernehmeEInBloecken,reverseManifestVerweis,pruefeReverseManifest,leseReverseManifest,REVERSE_EINSTELLKATALOG,type ReverseEinstellSnapshot,
 type ToolDescriptor,type WorkJob,type WorkJobHooks,type WorkJobClient,type WorkNodeAuthority,type WorkIdentity,
 type WorkJobService,type WorkJobPool,type WorkResourceNeed,type ReverseContainerInfo,type ReverseEManifestEintrag} from '@synapse/core';
import type {ToolLifecycle,ToolResourceAdapter,ToolInstanceContext} from './tool-lifecycle.js';
import {DockerToolContainerExecutor,type ResolvedToolMount} from './tool-container-docker.js';
import {configureToolLifecycleAdapters,getToolLifecycle} from './tool-lifecycle-runtime.js';
import {ServerExecutor} from './server-executor.js';
import {ReverseLeserExecutor,LESER_TOOL} from './reverse-leser-executor.js';

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
 /** P18-T86: Lebenszyklus-, Transport- und Eingabewerte des Descriptors aus reverse_einstellungen (ohne Angabe: Katalogstandard). */
 lebenszyklus?:ReverseLebenszyklus;zuschlagS?:number;inputBytes?:number;
 /** P18-T86: true = Ressourcenbedarf kam als Betreiberwert aus der Env und wird nicht durch e_cpu/e_ram_mib bzw. s3_* ersetzt (U4). */
 ressourcenAusEnv?:{e:boolean;s3:boolean};
}
export interface ReverseLebenszyklus {activity_lookback_seconds:number;cpu_idle_percent:number;gpu_idle_percent:number;measurement_max_age_ms:number;
 start_timeout_ms:number;max_starts:number;start_window_ms:number;pause_ms:number}
const kat=(n:keyof typeof REVERSE_EINSTELLKATALOG)=>Number(REVERSE_EINSTELLKATALOG[n].standard);
const LEBENSZYKLUS_STANDARD=():ReverseLebenszyklus=>({activity_lookback_seconds:kat('container_aktivitaet_fenster_s'),cpu_idle_percent:kat('container_cpu_idle_prozent'),
 gpu_idle_percent:kat('container_gpu_idle_prozent'),measurement_max_age_ms:kat('container_messung_max_alter_ms'),start_timeout_ms:kat('container_start_timeout_ms'),
 max_starts:kat('container_max_starts'),start_window_ms:kat('container_start_fenster_ms'),pause_ms:kat('container_pause_ms')});
/**
 * P18-T86: wirksame Betriebswerte aus reverse_einstellungen (global) in die Executor-Konfiguration uebernehmen. Die Env-Werte aus
 * ladeReverseExecutorKonfig sind danach nur noch Startwerte fuer Tests/alte Pfade. Lease-Obergrenze bleibt der P20-Wert.
 * Liefert, ob sich der Descriptor geaendert hat (dann registriert der Executor ihn beim naechsten geordneten Durchlauf neu).
 */
export function reverseKonfigAusEinstellungen(k:ReverseExecutorKonfig,s:ReverseEinstellSnapshot,env:NodeJS.ProcessEnv=process.env):{descriptorGeaendert:boolean}{
 const z=(n:Parameters<typeof reverseZahl>[1])=>reverseZahl(s,n);
 const vorher=JSON.stringify(reverseToolDescriptor(k));
 const leaseSeconds=Math.min(z('executor_lease_s'),ganz(env,'SYNAPSE_WORK_MAX_LEASE_SECONDS',900));
 Object.assign(k,{parallel:z('executor_parallel'),leaseSeconds,renewMs:Math.max(z('executor_renew_min_ms'),Math.floor(leaseSeconds*1000/3)),
  tickMs:z('executor_tick_ms'),zeitlimitS:z('e_zeitlimit_s'),maxBytes:reverseBudget(s,'e_lauf_bytes'),tmpfsMb:z('container_tmpfs_mib'),pids:z('container_pids'),
  outputBytes:z('runner_output_bytes'),retryMax:z('retry_max'),idleMs:z('container_idle_ms'),maxVerschachtelung:z('verschachtelung_max'),
  s3ZeitlimitS:z('s3_zeitlimit_s'),s3MaxBytes:reverseBudget(s,'s3_lauf_bytes'),zuschlagS:z('container_zeit_zuschlag_s'),inputBytes:z('runner_input_bytes'),
  lebenszyklus:{activity_lookback_seconds:z('container_aktivitaet_fenster_s'),cpu_idle_percent:z('container_cpu_idle_prozent'),gpu_idle_percent:z('container_gpu_idle_prozent'),
   measurement_max_age_ms:z('container_messung_max_alter_ms'),start_timeout_ms:z('container_start_timeout_ms'),max_starts:z('container_max_starts'),
   start_window_ms:z('container_start_fenster_ms'),pause_ms:z('container_pause_ms')}});
 if(!k.ressourcenAusEnv?.e)k.resourceNeed={cpu:z('e_cpu'),ram:z('e_ram_mib'),vram:0,gpu:false};
 if(!k.ressourcenAusEnv?.s3)k.s3ResourceNeed={cpu:z('s3_cpu'),ram:z('s3_ram_mib'),vram:0,gpu:false};
 return {descriptorGeaendert:JSON.stringify(reverseToolDescriptor(k))!==vorher};
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
/** P18-T87: Zeitlimit je Kind. */
export const reverseZeitlimitS=(k:ReverseExecutorKonfig,kind:string):number=>kind==='reverse-S3'?k.s3ZeitlimitS:k.zeitlimitS;
/** P18-T87: harte Frist eines Laufs in Sekunden = Zeitlimit + Einstellwert hart_puffer_s; danach beendet der Executor den Lauf selbst. */
export function reverseHarteFrist(k:ReverseExecutorKonfig,kind:string,pufferS:number):number{
 return reverseZeitlimitS(k,kind)+pufferS;
}
/** Liest die Executor-Umgebung; null = aus. Ungültige Werte werfen (der Start bleibt dann aus). */
export function ladeReverseExecutorKonfig(env:NodeJS.ProcessEnv,reverseRoot:string|null):ReverseExecutorKonfig|null{
 if(env.SYNAPSE_REVERSE_ENABLED!=='1'||!reverseRoot)return null;
 const bild=(env.SYNAPSE_REVERSE_IMAGE??'').trim();
 const m=bild.match(/^([a-zA-Z0-9][a-zA-Z0-9._/:-]*)@(sha256:[a-f0-9]{64})$/);
 if(!m)throw Error('reverse_executor_konfig:SYNAPSE_REVERSE_IMAGE (name@sha256:<64 hex> erwartet)');
 // P18-T86/U4: Betreiberwert aus der Env hat Vorrang; ohne ihn gilt e_cpu/e_ram_mib (reverse_einstellungen, Standard 2 CPU/4096 MiB).
 const roh=env.SYNAPSE_REVERSE_RESOURCE_NEED;
 const need=roh?validateWorkResources(JSON.parse(roh)):{cpu:kat('e_cpu'),ram:kat('e_ram_mib'),vram:0,gpu:false};
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
  maxVerschachtelung:ganz(env,'SYNAPSE_REVERSE_MAX_VERSCHACHTELUNG',8,0,32),...s3Konfig(env),
  ressourcenAusEnv:{e:!!roh,s3:env.SYNAPSE_REVERSE_S3_RESOURCE_NEED!==undefined}};
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
  limits:{time_ms:(reverseZeitlimitMax(k)+(k.zuschlagS??kat('container_zeit_zuschlag_s')))*1000,output_bytes:k.outputBytes,input_bytes:k.inputBytes??kat('runner_input_bytes')},
  lifecycle:{idle_ms:k.idleMs,...(k.lebenszyklus??LEBENSZYKLUS_STANDARD())}});
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
/** P18-T87: Eingriff der Aufsicht in einen laufenden Containerlauf. */
type LaufEnde='zeitlimit'|'storno';
interface Aufsicht {grund:()=>LaufEnde|null;beende:(g:LaufEnde)=>void;ende:()=>void}
export class ReverseExecutor {
 private readonly pool:Db;private readonly k:ReverseExecutorKonfig;private readonly jobs:WorkJobService;
 private readonly laufend=new Map<string,Promise<void>>();
 private wer:WorkIdentity|null=null;private eingerichtet=false;private beendet=false;
 /** P18-T64: true, solange noch der alte Descriptor je Auftrag gilt (Migration). */
 private altScope=false;private altGemeldet=false;
 /** P18-T86: geaenderter Descriptor (Einstellungen) -> beim naechsten Durchlauf geordnet neu registrieren (Migrationsweg). */
 descriptorNeu():void{this.eingerichtet=false;}
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
  // P18-T88: bestaetigte E-Manifeste (Blockuebernahme) bleiben fuer die Wiederaufnahme erhalten; keine neue Aufraeumfunktion.
  const eArtefakte=(await this.pool.query("SELECT p20_auftrag_id::text AS id FROM reverse_auftraege WHERE p20_auftrag_id=ANY($1::uuid[]) AND uebernahme->'artefakt' IS NOT NULL",[namen])).rows;
  for(const row of eArtefakte)behalten.add(String(row.id).toLowerCase());
  // Teil C: E ohne explizit bestätigten Vollabschluss ist Rückhalt, auch vor dem ersten PG-Checkpoint.
  // S3 bleibt in beiden bisherigen Abfragen und im Aufräumpfad unverändert.
  const eRest=(await this.pool.query("SELECT DISTINCT p20_auftrag_id::text AS id FROM reverse_auftraege WHERE p20_auftrag_id=ANY($1::uuid[]) AND schicht='E' AND (uebernahme->>'e_abgeschlossen' IS DISTINCT FROM 'true' OR uebernahme->>'retention'='true' OR uebernahme->'rueckhalt' IS NOT NULL OR uebernahme->>'cursor_unbestaetigt'='true')",[namen])).rows;
  for(const row of eRest)behalten.add(String(row.id).toLowerCase());
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
 private async uebernimmUnterFence(job:WorkJob,wer:WorkIdentity,e:Parameters<typeof uebernehmeEErgebnis>[1],
  ende?:{status:string;fehlercode:string|null}):Promise<{dateien:number;verworfen:number}|null>{
  const c=await this.pool.connect();
  let r:Awaited<ReturnType<typeof uebernehmeEErgebnis>>;
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return null;}
   r=await (this.deps.uebernahme??uebernehmeEErgebnis)({query:c.query.bind(c)},e,this.deps.uebernahmeOptionen);
   await c.query('COMMIT');
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
  const wert=r as typeof r&{rueckhalt?:Record<string,unknown>;offen?:number;grund?:string};
  if(wert.rueckhalt||ende?.status==='teilweise'){
   const {eAbschluss,eCheckpoint}=await import('@synapse/core');
   const einstellungen=await leseReverseEinstellwerte({eintrag_id:e.reverseId},this.pool);
   const kontext={...e,einstellungen,pruefeLease:(db:import('pg').PoolClient)=>this.leaseLebt(db,job,wer,true)};
   // Jede Phase trägt ihren Lease-Fence; ein Crash lässt den FS-Beleg bzw. den abgeschlossenen Import bestehen.
   if(wert.rueckhalt)await eCheckpoint(this.pool as Pool,kontext,{retention:true,fortsetzung_gesperrt:true,rueckhalt:wert.rueckhalt});
   await eAbschluss(this.pool as Pool,kontext,{dateien:String(r.dateien),abgewiesen:String(r.verworfen),
    offen:String(wert.offen??0),grund:wert.grund??ende?.fehlercode??'teilweise',rueckhalt:wert.rueckhalt,fertig:false});
  }
  return r;
 }
 /**
  * Endgültiger Fehlschlag unter Lease-Fence. P18-T64: immer eine Logzeile; fachliche Fehler (deterministisch) setzen
  * Auftrag und Schicht sofort auf 'fehler' mit echtem Code, sonst legt die Pipeline einen neuen Versuch an.
  * Review 028940c6/B1: endgueltig=true erzwingt das Ende auch fuer nicht fachliche Codes (Versuchsgrenze des Blockwegs).
  */
 private async scheitern(job:WorkJob,wer:WorkIdentity,code:string,endgueltig=reverseFehlerDeterministisch(code)):Promise<boolean>{
  console.warn('[reverse-executor] Auftrag gescheitert:',job.id,'kind',job.kind,'eintrag',job.inputRef.id,'medium',job.inputRef.revision,'versuch',job.attempt,'code',code,endgueltig?(reverseFehlerDeterministisch(code)?'(fachlich, kein Neuversuch)':'(Versuchsgrenze erreicht, kein Neuversuch)'):'(Neuversuch durch Pipeline)');
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
 /**
  * P18-T87: Aufsicht ueber einen laufenden Containerlauf. Harte Frist (zeitlimit + Puffer): ohne Endmeldung wird der Lauf ueber den
  * Lebenszyklus beendet (Container-Neustart) und endgueltig als zeitlimit gemeldet. Storno-Wunsch aus reverse(abbrechen)
  * (work_job_audit 'storno_angefordert'), geprueft im Executor-Takt: Lauf beenden, Work-Job cancelled, Auftrag abgebrochen.
  */
 private aufsicht(lc:ToolLifecycle,job:WorkJob,fristS:number):Aufsicht{
  let grund:LaufEnde|null=null;
  const beende=(g:LaufEnde)=>{
   if(grund)return;
   grund=g;
   console.warn('[reverse-executor] Lauf wird beendet:',job.id,'kind',job.kind,'grund',g,'frist_s',fristS);
   void lc.neustart(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id).catch(e=>console.error('[reverse-executor] Lauf beenden fehlgeschlagen:',job.id,(e as Error).message));
  };
  const hart=setTimeout(()=>beende('zeitlimit'),fristS*1000);hart.unref();
  const storno=setInterval(()=>{void reverseStornoAngefordert(this.pool,job.id).then(ja=>{if(ja)beende('storno');},()=>undefined);},this.k.tickMs);
  storno.unref();
  return {grund:()=>grund,beende,ende:()=>{clearTimeout(hart);clearInterval(storno);}};
 }
 /** P18-T87: Ende nach Eingriff: Storno -> cancelled/abgebrochen, Frist -> endgueltig zeitlimit (deterministisch, kein Neuversuch). */
 private async eingriffBeenden(job:WorkJob,wer:WorkIdentity,g:LaufEnde):Promise<boolean>{
  await this.pool.query("INSERT INTO work_job_audit(id,job_id,event,detail) VALUES(gen_random_uuid(),$1,'reverse_lauf_beendet',$2::jsonb)",[job.id,JSON.stringify({grund:g,kind:job.kind})])
   .catch(e=>console.error('[reverse-executor] Audit fehlgeschlagen:',job.id,(e as Error).message));
  return g==='storno'?this.stornieren(job,wer):this.scheitern(job,wer,'zeitlimit');
 }
 /** P18-T87: Storno unter Lease-Fence: Work-Job cancelled, alle offenen Fachauftraege abgebrochen, ihre Schichten fehler/abgebrochen. */
 private async stornieren(job:WorkJob,wer:WorkIdentity):Promise<boolean>{
  console.warn('[reverse-executor] Auftrag storniert:',job.id,'kind',job.kind,'eintrag',job.inputRef.id);
  const c=await this.pool.connect();
  try{
   await c.query('BEGIN');
   if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return false;}
   await c.query(`UPDATE work_jobs SET state='cancelled',error_code='abgebrochen',lease_until=NULL,staged_output_ref=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id]);
   await c.query("INSERT INTO work_job_audit(id,job_id,event,detail) VALUES(gen_random_uuid(),$1,'cancelled',$2::jsonb)",[job.id,JSON.stringify({grund:'storno',executor:'reverse'})]);
   await c.query("UPDATE reverse_auftraege SET status='abgebrochen',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE p20_auftrag_id=$1 AND status IN ('offen','wartet','laeuft')",[job.id]);
   await c.query("UPDATE reverse_schichten SET status='fehler',fehlercode='abgebrochen' WHERE aktuell AND status IN ('offen','wartet','laeuft') AND auftrag_id IN (SELECT id FROM reverse_auftraege WHERE p20_auftrag_id=$1)",[job.id]);
   await c.query('COMMIT');return true;
  }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
  finally{c.release();}
 }
 /**
  * P18-T85: Live-Fortschritt (Schalter reverse_fortschritt_live). Liefert den Runner-Takt und den Empfaenger fuer nicht-terminale
  * Runner-Zeilen; das letzte Ereignis landet unter der eigenen Lease in work_jobs.fortschritt (hoechstens eine Schreibung je Sekunde).
  * Aus: null, der Runner bekommt keine Option und meldet wie bisher nur das Ende.
  */
 private async liveFortschritt(job:WorkJob,token:string):Promise<{takt_s:number;melde:(r:Record<string,unknown>)=>void}|null>{
  const stand=await leseReverseFortschrittSchalter().catch(()=>null);
  if(!stand?.aktiv)return null;
  let zuletzt=0,schreibt=false;
  const speichern=(f:Record<string,unknown>)=>{
   schreibt=true;
   void speichereReverseFortschritt(this.pool,job.id,token,f,job.attempt)
    .catch(e=>console.warn('[reverse-executor] Fortschritt nicht gespeichert:',job.id,(e as Error).message)).finally(()=>{schreibt=false;});
  };
  speichern({phase:'start',dateien_bisher:0,bytes_geschrieben:0,aktuelle_datei:null,gesamt:null,runner_seit_s:0});
  return {takt_s:stand.takt_s,melde:r=>{
   const f=normalisiereReverseFortschritt(r);
   if(!f||schreibt||Date.now()-zuletzt<1000)return;
   zuletzt=Date.now();speichern(f);
  }};
 }
 /**
  * P18-T86/T88: E mit fortsetzbarer Blockuebernahme. Der Runner schreibt das Manifest als JSONL-Datei auf Unraid (nur Verweis
  * und Hash in der Antwort); die API uebernimmt es in Bloecken (e_uebernahme_block_zeilen / materialisierung_tx_bytes) mit
  * Checkpoint am Fachauftrag. Einstellungen werden beim ersten Versuch am Auftrag gepinnt. Wiederaufnahme importiert den
  * bestaetigten Rest, ohne erneut zu entpacken. P18-T87 bleibt: harte Frist, Storno, kein Neueinreihen.
  * Fehlerbudget: retry_max Versuche OHNE Fortschritt; deterministische Fehler (Manifest geaendert, Eintragsquote) sofort.
  */
 /** P18-T93: gehaltene E-Arbeit ist ein sichtbarer Abschluss, keine automatische Adoption. */
 private async eHalten(job:WorkJob,wer:WorkIdentity,grund:string,extra:Record<string,unknown>={}):Promise<void>{
  const {eAbschluss,eCheckpoint,eFachauftrag,eRetentionsJournal,eRueckhaltBeleg,eMutation}=await import('@synapse/core');
  const einstellungen=await leseReverseEinstellwerte({eintrag_id:job.inputRef.id},this.pool);
  const e={jobId:job.id,reverseId:job.inputRef.id,mediumId:job.inputRef.revision,einstellungen,pruefeLease:(c:import('pg').PoolClient)=>this.leaseLebt(c,job,wer,true)};
  const arbeit=path.join(this.k.arbeitRoot,job.id),ausgabe=this.altScope?path.join(arbeit,job.id):arbeit;
  let rueckhalt:Record<string,unknown>;
  try{
   rueckhalt=await eRueckhaltBeleg(this.k.reverseRoot,e,job.inputRef.sha256,reverseZahl(einstellungen,'manifest_record_bytes'))
    ??await eRetentionsJournal(this.k.reverseRoot,ausgabe,e,grund,reverseZahl(einstellungen,'manifest_record_bytes'));
  }catch(err){
   rueckhalt={erhalten:true,storage_key:path.relative(this.k.reverseRoot,ausgabe),bytes:null,grund,loeschen:false,
    automatisch_fortsetzen:false,fehler:{errno:(err as NodeJS.ErrnoException).code??'UNBEKANNT',meldung:(err as Error).message}};
  }
  const f=await eFachauftrag(this.pool,e),cp=f.uebernahme??{};
  const vorher=cp.rueckhalt as Record<string,unknown>|undefined,abschluss=cp.abschluss as Record<string,unknown>|undefined;
  // Neu messen, aber offene Dateien und den ursprünglichen Rename-Fehler über Retry hinweg erhalten.
  if(vorher)rueckhalt={...vorher,...rueckhalt,grund:vorher.grund??rueckhalt.grund,
   ...(vorher.fehler?{fehler:vorher.fehler}:{})};
  const ursache=String(vorher?.grund??grund);
  const ex=cp.extraktion as Record<string,unknown>|undefined,artefakt=cp.artefakt as Record<string,unknown>|undefined;
  const rest=artefakt?BigInt(String(artefakt.zeilen??'0'))-BigInt(String(cp.position??'0')):0n;
  const offen=String(rueckhalt.offen??(ex?BigInt(String(ex.offen??'0'))+(rest>0n?rest:0n):abschluss?.offen??(rest>0n?rest:'0')));
  rueckhalt={...rueckhalt,offen,offen_unbekannt:!ex&&!artefakt&&rueckhalt.offen===undefined&&abschluss?.offen===undefined};
  await eCheckpoint(this.pool as Pool,e,{retention:true,fortsetzung_gesperrt:true,rueckhalt,letzter_fehler:ursache,...extra});
  await eAbschluss(this.pool as Pool,e,{dateien:String(cp.dateien??abschluss?.dateien??'0'),abgewiesen:String(cp.verworfen??abschluss?.abgewiesen??rueckhalt.abgewiesen??'0'),
   offen,grund:ursache,rueckhalt,fertig:false});
  if(grund==='storno'||grund==='zeitlimit'){
   // E-Metadaten sind bereits begrenzt abgeschlossen. Auch diese beiden konstanten Steuerzeilen je eine TX.
   await eMutation(this.pool as Pool,e,"INSERT INTO work_job_audit(id,job_id,event,detail) SELECT gen_random_uuid(),$1,$2,$3::jsonb WHERE NOT EXISTS(SELECT 1 FROM work_job_audit WHERE job_id=$1 AND event=$2 AND detail->>'versuch'=$4)",
    [job.id,'reverse_e_erhalten',JSON.stringify({grund,versuch:String(job.attempt)}),String(job.attempt)]);
   await eMutation(this.pool as Pool,e,"UPDATE work_jobs SET state=$2,error_code=$3,lease_until=NULL,staged_output_ref=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [job.id,grund==='storno'?'cancelled':'failed',grund==='storno'?'abgebrochen':'zeitlimit']);
   return;
  }
  const out={scope:'reverse',id:job.id,revision:String(job.attempt),sha256:job.inputRef.sha256};
  if(await this.jobs.stage(wer,job.id,job.claimToken!,out))await this.jobs.complete(wer,job.id,job.claimToken!,job.inputRef);
 }

 private async fuehreEBlockAus(lc:ToolLifecycle,wer:WorkIdentity,job:WorkJob,quelle:ReverseQuelle):Promise<void>{
  const {eFachauftrag,eCheckpoint,eAbschluss,eDateiExists}=await import('@synapse/core');
  const token=job.claimToken!,alt=this.altScope,arbeit=path.join(this.k.arbeitRoot,job.id),ausgabe=alt?path.join(arbeit,job.id):arbeit;
  const f=await eFachauftrag(this.pool,{jobId:job.id,reverseId:quelle.reverseId,mediumId:quelle.mediumId});
  let cp=f.uebernahme??{};
  const aktuell=await leseReverseEinstellwerte({eintrag_id:quelle.reverseId},this.pool);
  const einst=(cp.einstellungen as ReverseEinstellSnapshot|undefined)??aktuell;
  if(aktuell.letzter_fehler||einst.letzter_fehler||aktuell.revision!==einst.revision){
   await this.eHalten(job,wer,'konfiguration_veraltet');return;
  }
  const e={jobId:job.id,reverseId:quelle.reverseId,mediumId:quelle.mediumId,einstellungen:einst,
   pruefeLease:(c:import('pg').PoolClient)=>this.leaseLebt(c,job,wer,true)};
  const failed=Number(cp.fehlversuche??0),retryMax=reverseZahl(einst,'retry_max'),start=String(cp.position??'0');
  if(cp.fortsetzung_gesperrt||cp.retention){await this.eHalten(job,wer,String(cp.letzter_fehler??'fortsetzung_gesperrt'));return;}
  if(failed>=retryMax){await this.eHalten(job,wer,'retry_erschoepft');return;}
  let lebt=true,aufsicht:Aufsicht|null=null;
  const timer=setInterval(()=>{void this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).then(ok=>{if(!ok)lebt=false;},()=>{lebt=false;});},this.k.renewMs);timer.unref();
  try{
   if(!cp.artefakt){
    // Herkunftsloser Altbestand (u.a. XP) wird nie geleert oder still adoptiert.
    if(await eDateiExists(ausgabe)){
     const namen=await readdir(ausgabe);
     if(namen.length&&!namen.includes('.e-journal.sqlite')){await this.eHalten(job,wer,'altarbeit_ohne_cursor');return;}
    }
    await eCheckpoint(this.pool as Pool,e,{version:2,einstellungen:einst,fehlversuche:failed+1,
     cursor_unbestaetigt:true,letzter_fehler:'entpacken_ohne_ende'});
    await mkdir(this.k.arbeitRoot,{recursive:true,mode:0o711});await runnerOrdner(ausgabe);
    const aufs=await leseReverseAufsicht();
    aufsicht=this.aufsicht(lc,job,reverseHarteFrist(this.k,job.kind,aufs.hart_puffer_s.wert));
    const [pe,siedler,live]=await Promise.all([leseReversePeRessourcenSchalter(),leseReverseSiedler3Schalter(),this.liveFortschritt(job,token)]);
    const ergebnis=await lc.execute(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id,wer,token,async()=>({
     kommando:'extrahieren',schicht:'E',blockuebernahme:true,einstellungen:einst,
     fortsetzung:{bindung:{job_id:job.id,eintrag_id:quelle.reverseId,medium_id:quelle.mediumId,quellhash:job.inputRef.sha256,
      werkzeug:f.werkzeug,werkzeug_version:f.werkzeug_version,profil_version:f.profil_version},
      importiert_sha:cp.importiert_sha??null},
     grenzen:{zeitlimit_s:this.k.zeitlimitS,nachlauf_s:aufs.nachlauf_s.wert},
     ...(live?{fortschritt:{takt_s:live.takt_s}}:{}),eingabe:'/bib/'+quelle.storageKey,
     eingabe_name:quelle.dateien[0].name||undefined,ausgabe:'/arbeit/'+job.id,
     begleitdateien:quelle.dateien.slice(1).map(d=>({pfad:'/bib/'+d.storageKey,name:d.name})),
     optionen:{wav_pregap:this.k.wavPregap,pe_ressourcen:pe.aktiv,pe_ressourcen_stand:pe,siedler3:siedler.aktiv,siedler3_stand:siedler},
    }),live?.melde);
    if(!alt)await sperreArbeitsOrdner(arbeit);
    aufsicht.ende();
    if(!lebt)return;
    if(aufsicht.grund()){await this.eHalten(job,wer,aufsicht.grund()!);return;}
    if(!['fertig','teilweise'].includes(String(ergebnis.status))||!ergebnis.manifest_datei){
     await this.eHalten(job,wer,String(ergebnis.fehlercode??(ergebnis.retention as Record<string,unknown>|undefined)?.grund??'ende_unbestaetigt'),{runner_abbruch:ergebnis.retention??null});return;
    }
    const artefakt=reverseManifestVerweis(ergebnis.manifest_datei);
    await pruefeReverseManifest(ausgabe,artefakt,reverseZahl(einst,'lese_block_bytes'));
    const ex=ergebnis.extraktion as Record<string,unknown>|undefined;
    if(artefakt.version===2&&(!ex||ex.version!==1||typeof ex.bindung!=='string'||!/^[a-f0-9]{64}$/.test(ex.bindung)
      ||typeof ex.schritt!=='string'||!/^[1-9][0-9]*$/.test(ex.schritt)||artefakt.pfad!=='.e-manifest-'+ex.schritt+'.jsonl'
      ||typeof ex.fertig!=='boolean'||typeof ex.fortsetzbar!=='boolean'
      ||typeof ex.offen!=='string'||!/^[0-9]+$/.test(ex.offen)
      ||typeof ex.gesamt!=='string'||!/^[0-9]+$/.test(ex.gesamt)
      ||(ex.fertig&&(ex.offen!=='0'||ergebnis.status!=='fertig'))
      ||(artefakt.zeilen==='0'&&ex.fertig&&ex.leertabelle_belegt!==true)))throw new Error('reverse_e_extraktion_ungueltig');
    if(cp.extraktion&&(cp.extraktion as Record<string,unknown>).bindung!==ex?.bindung)throw new Error('reverse_e_cursor_herkunft');
    cp={...cp,version:2,einstellungen:einst,artefakt,extraktion:ex??null,runner_status:ergebnis.status,
     runner_fehlercode:ergebnis.fehlercode??null,fehlversuche:failed,cursor_unbestaetigt:false};
    await eCheckpoint(this.pool as Pool,e,cp);
   }else if(!alt)await sperreArbeitsOrdner(arbeit);
   const artefakt=reverseManifestVerweis(cp.artefakt);
   await pruefeReverseManifest(ausgabe,artefakt,reverseZahl(einst,'lese_block_bytes'));
   const r=await uebernehmeEInBloecken(this.pool as Pool,{
    ...e,arbeitsWurzel:ausgabe,reverseRoot:this.k.reverseRoot,manifestSha:artefakt.sha256,
    manifest:leseReverseManifest(ausgabe,artefakt,reverseZahl(einst,'manifest_record_bytes'),reverseZahl(einst,'lese_block_bytes')),
    fortschritt:async()=>{if(await reverseStornoAngefordert(this.pool,job.id))throw new Error('reverse_e_storno');}
   });
   if(!lebt)return;
   cp=(await eFachauftrag(this.pool,e)).uebernahme??{};
   const ex=cp.extraktion as Record<string,unknown>|undefined;
   if(ex&&!ex.fertig){
    if(ex.fortsetzbar&&(await leseReverseBlockSchalter()).aktiv){
     await eCheckpoint(this.pool as Pool,e,{artefakt:null,manifest_sha:null,position:'0',fertig:false,
      importiert_sha:artefakt.sha256,fehlversuche:0,cursor_unbestaetigt:true});
     await this.jobs.release(wer,job.id,token);return;
    }
    await this.eHalten(job,wer,String(cp.runner_fehlercode??'fortsetzung_nicht_unterstuetzt'));return;
   }
   if(ex?.fertig&&String(ex.gesamt)!==String(r.dateien))throw new Error('reverse_e_extraktion_zaehler');
   const fertig=cp.runner_status==='fertig';
   if(!fertig){await this.eHalten(job,wer,String(cp.runner_fehlercode??'teilweise'));return;}
   await eAbschluss(this.pool as Pool,e,{dateien:String(r.dateien),abgewiesen:String(r.verworfen),offen:'0',grund:null,fertig:true});
   await eCheckpoint(this.pool as Pool,e,{e_abgeschlossen:true,cursor_unbestaetigt:false,retention:false});
   const out={scope:'reverse',id:job.id,revision:String(job.attempt),sha256:artefakt.sha256};
   if(await this.jobs.stage(wer,job.id,token,out))await this.jobs.complete(wer,job.id,token,job.inputRef);
  }catch(err){
   if(!alt)await sperreArbeitsOrdner(arbeit);
   if(!lebt)return;
   const m=(err as Error).message;
   if(m==='tool_runner_timeout')aufsicht?.beende('zeitlimit');
   if(m==='reverse_e_storno'||aufsicht?.grund()){await this.eHalten(job,wer,m==='reverse_e_storno'?'storno':aufsicht!.grund()!);return;}
   if(m==='tool_not_ready'||m==='tool_runner_capacity'){
    await eCheckpoint(this.pool as Pool,e,{fehlversuche:failed});await this.jobs.release(wer,job.id,token);return;
   }
   cp=(await eFachauftrag(this.pool,e)).uebernahme??{};
   const n=String(cp.position??'0')!==start?1:failed+1;
   await eCheckpoint(this.pool as Pool,e,{fehlversuche:n,letzter_fehler:m});
   if(n>=retryMax||/^reverse_(manifest|e_(datei|eintrag|cursor|extraktion))/.test(m)){
    await this.eHalten(job,wer,m);return;
   }
   await this.jobs.release(wer,job.id,token);
  }finally{clearInterval(timer);aufsicht?.ende();}
 }

 /** Vorabfehler ohne Extraktion: dieselben terminalen Zustände, jede eigene Mutation begrenzt. */
 private async eVorabFehler(job:WorkJob,wer:WorkIdentity,code:string):Promise<void>{
  const {eAbschluss,eMutation}=await import('@synapse/core');
  const einstellungen=await leseReverseEinstellwerte({eintrag_id:job.inputRef.id},this.pool);
  const e={jobId:job.id,reverseId:job.inputRef.id,mediumId:job.inputRef.revision,einstellungen,
   pruefeLease:(c:import('pg').PoolClient)=>this.leaseLebt(c,job,wer,true)};
  await eAbschluss(this.pool as Pool,e,{dateien:'0',abgewiesen:'0',offen:'0',grund:code,fertig:false,status:'fehler'});
  await eMutation(this.pool as Pool,e,"INSERT INTO work_job_audit(id,job_id,event,detail) SELECT gen_random_uuid(),$1,'failed',$2::jsonb WHERE NOT EXISTS(SELECT 1 FROM work_job_audit WHERE job_id=$1 AND event='failed' AND detail->>'versuch'=$3)",
   [job.id,JSON.stringify({fehlercode:code,executor:'reverse',versuch:String(job.attempt)}),String(job.attempt)]);
  await eMutation(this.pool as Pool,e,"UPDATE work_jobs SET state='failed',error_code=$2,lease_until=NULL,staged_output_ref=NULL,updated_at=clock_timestamp() WHERE id=$1",[job.id,code]);
 }

 private async fuehreAus(lc:ToolLifecycle,wer:WorkIdentity,job:WorkJob):Promise<void>{
  const token=job.claimToken!;
  if(job.capability!==REVERSE_CAPABILITY||job.project!==REVERSE_PROJEKT||!this.k.kinds.includes(job.kind)){
   await this.jobs.release(wer,job.id,token);return;
  }
  if(job.kind==='reverse-S3')return this.fuehreS3Aus(lc,wer,job);
  // P18-T88: Blockuebernahme (Produkt-Schalter reverse_blockuebernahme, Standard AUS) oder bereits angefangener Blockauftrag.
  // Dort zaehlt ein eigenes Fehlerbudget ohne Fortschritt; erfolgreiche Bloecke gehen nicht auf die alte Versuchsgrenze.
  const blockStand=await leseReverseBlockSchalter();
  const blockRest=(await this.pool.query("SELECT 1 FROM reverse_auftraege WHERE p20_auftrag_id=$1 AND uebernahme->>'version' IN ('1','2') LIMIT 1",[job.id])).rows.length>0;
  const block=blockStand.aktiv;
  if(!block&&blockRest){await this.eHalten(job,wer,'blockuebernahme_aus');return;}
  if(!block&&job.attempt>this.k.retryMax){await this.eHalten(job,wer,'retry_erschoepft');return;}
  const quelle=await this.eingabe(job);
  if(!quelle){await this.eVorabFehler(job,wer,'nicht_gefunden');return;}
  // P18-T64: bekannte, noch nicht unterstützte Formate ohne Containerlauf klar benennen.
  const vorab=await reverseFormatVorpruefung(quelle.dateien.map(d=>({pfad:path.join(this.k.reverseRoot,d.storageKey),rolle:d.rolle,name:d.name})));
  if(vorab){await this.eVorabFehler(job,wer,vorab);return;}
  // P18-T66: Originale liegen ggf. als 0600 root; der Runner (65532) muss sie lesen dürfen.
  const rechte=await reverseEingabeLesbar(quelle.dateien.map(d=>path.join(this.k.reverseRoot,d.storageKey)));
  if(rechte){await this.eVorabFehler(job,wer,rechte);return;}
  if(block)return this.fuehreEBlockAus(lc,wer,job,quelle);
  // Globaler Container: /arbeit=_arbeit, Ausgabe /arbeit/<jobId>. Alter Descriptor: /arbeit=_arbeit/<jobId>, Ausgabe darin.
  const alt=this.altScope;
  const arbeit=await reverseArbeitsOrdner(this.k,job.id),ausgabe=alt?path.join(arbeit,job.id):arbeit;
  const {eRueckhaltBeleg,eFachauftrag}=await import('@synapse/core');
  const es=await leseReverseEinstellwerte({eintrag_id:quelle.reverseId},this.pool);
  const ek={jobId:job.id,reverseId:quelle.reverseId,mediumId:quelle.mediumId};
  const ef=await eFachauftrag(this.pool,ek);
  const beleg=await eRueckhaltBeleg(this.k.reverseRoot,ek,job.inputRef.sha256,reverseZahl(es,'manifest_record_bytes'));
  if(beleg||ef.uebernahme?.retention||(await readdir(ausgabe).catch((err:NodeJS.ErrnoException)=>{if(err.code==='ENOENT')return [];throw err;})).length){
   await this.eHalten(job,wer,String(beleg?.grund??'altarbeit_erhalten'));return;
  }
  await runnerOrdner(ausgabe);
  // P18-T87: Puffer der harten Frist und Nachlauf fuer das Manifest: Einstellwerte (reverse_einstellungen, Code-Wert nur Standard).
  const einst=await leseReverseAufsicht();
  const nachlaufS=einst.nachlauf_s.wert;
  let lebt=true,aufraeumen=false;
  const aufsicht=this.aufsicht(lc,job,reverseHarteFrist(this.k,job.kind,einst.hart_puffer_s.wert));
  const timer=setInterval(()=>{void this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).then(ok=>{if(!ok)lebt=false;},()=>{lebt=false;});},this.k.renewMs);
  timer.unref();
  try{
   let ergebnis:Record<string,unknown>;
   try{
    const [peStand,siedlerStand,live]=await Promise.all([leseReversePeRessourcenSchalter(),leseReverseSiedler3Schalter(),this.liveFortschritt(job,token)]);
    // P18-T93: Auch E-AUS verwendet den eintragsspezifischen PG-Snapshot im Runner.
    const eEinstellungen=await leseReverseEinstellwerte({eintrag_id:quelle.reverseId},this.pool);
    if(eEinstellungen.letzter_fehler)throw new Error(eEinstellungen.letzter_fehler);
    ergebnis=await lc.execute(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id,wer,token,async()=>({kommando:'extrahieren',schicht:'E',einstellungen:eEinstellungen,...(live?{fortschritt:{takt_s:live.takt_s}}:{}),
     eingabe:'/bib/'+quelle.storageKey,eingabe_name:quelle.dateien[0].name||undefined,ausgabe:'/arbeit/'+job.id,
     begleitdateien:quelle.dateien.slice(1).map(d=>({pfad:'/bib/'+d.storageKey,name:d.name})),
     optionen:{wav_pregap:this.k.wavPregap,pe_ressourcen:peStand.aktiv,pe_ressourcen_stand:peStand,siedler3:siedlerStand.aktiv,siedler3_stand:siedlerStand},
     grenzen:{zeitlimit_s:this.k.zeitlimitS,max_dateien:this.k.maxDateien,max_bytes:this.k.maxBytes,max_verschachtelung:this.k.maxVerschachtelung,
      nachlauf_s:nachlaufS}}),live?.melde);
   }catch(e){
    if(!alt)await sperreArbeitsOrdner(arbeit);
    const m=(e as Error).message;
    // P18-T87: Transport-Timeout heisst Frist ueberschritten: Lauf physisch beenden und wie die harte Frist behandeln.
    if(m==='tool_runner_timeout')aufsicht.beende('zeitlimit');
    const eingriff=aufsicht.grund();
    if(eingriff){await this.eHalten(job,wer,eingriff);return;}
    // Nicht abgesetzt: sauber zurückgeben. Sonst bleibt der Auftrag bis zum Lease-Ablauf gesperrt.
    if(m==='tool_not_ready'||m==='tool_runner_capacity'){await this.jobs.release(wer,job.id,token);aufraeumen=true;}
    else console.error('[reverse-executor] Ausführung ohne sicheres Ende:',job.id,m);
    return;
   }
   clearInterval(timer);
   // M1: Lauf beendet -> Ordner gehört wieder root; der Runner kann ihn nicht mehr verändern (Übernahme liest als root).
   if(!alt)await sperreArbeitsOrdner(arbeit);
   aufsicht.ende();
   const status=String(ergebnis.status);
   // P18-T87: Storno kam vor dem Ergebnis an -> Ergebnis verwerfen, der Auftrag bleibt abgebrochen.
   if(aufsicht.grund()==='storno'){await this.eHalten(job,wer,'storno');return;}
   if(ergebnis.retention){await this.eHalten(job,wer,String(ergebnis.fehlercode??(ergebnis.retention as Record<string,unknown>).grund??'teilweise'),{runner_abbruch:ergebnis.retention});return;}
   const manifest=Array.isArray(ergebnis.manifest)?ergebnis.manifest as ReverseEManifestEintrag[]:[];
   if((status==='fertig'||(status==='teilweise'&&manifest.length>0))&&lebt){
    if(ergebnis.abbruch)console.warn('[reverse-executor] Lauf vorzeitig beendet, Teilergebnis wird uebernommen:',job.id,JSON.stringify(ergebnis.abbruch).slice(0,500));
    // K7: Lease vor der Übernahme einmal auffrischen (Hashing großer Ergebnisse unter dem Fence).
    if(!await this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).catch(()=>false)){console.warn('[reverse-executor] Lease verloren, Ergebnis verworfen:',job.id);return;}
    let r:{dateien:number;verworfen:number}|null;
    try{r=await this.uebernimmUnterFence(job,wer,{jobId:job.id,reverseId:quelle.reverseId,mediumId:quelle.mediumId,arbeitsWurzel:ausgabe,manifest},
     {status,fehlercode:status==='teilweise'?fehlercode(ergebnis.fehlercode??'deadline'):null});}
    catch(e){
     // W5: fachlicher Fehler -> endgültig; sonst freigeben, bis der Versuchszähler erreicht ist.
     console.error('[reverse-executor] Übernahme fehlgeschlagen:',job.id,(e as Error).message);
     if(e instanceof ReverseEUebernahmeFehler||job.attempt>=this.k.retryMax)await this.eHalten(job,wer,e instanceof ReverseEUebernahmeFehler?fehlercode(e.code):'werkzeug_fehler');
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
   await this.eHalten(job,wer,status==='teilweise'?String(ergebnis.fehlercode??'deadline'):fehlercode(ergebnis.fehlercode,ergebnis.format_detail));
  }finally{
   clearInterval(timer);aufsicht.ende();
   // Teil C: Arbeitsreste werden hier niemals gelöscht. Der zentrale E-Guard verlangt bestätigten Vollabschluss.
   void aufraeumen;
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
  if(await uebernehmeS3Ergebnis.parserAktiv(this.pool)){
   const lauf=await uebernehmeS3Ergebnis.bloecke(this.pool,e,this.deps.uebernahmeOptionen);
   try{
    while(await lauf.bereit()){
     const c=await this.pool.connect();
     try{
      await c.query('BEGIN');
      if(!await this.leaseLebt(c,job,wer,true)){await c.query('ROLLBACK');return null;}
      const r=await lauf.schritt(c);
      await c.query('COMMIT');
      if(r.fertig)return r.ergebnis;
     }catch(err){await c.query('ROLLBACK').catch(()=>undefined);throw err;}
     finally{c.release();}
    }
    return lauf.ergebnis();
   }finally{await lauf.beenden();}
  }
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
  // P18-T87: Puffer der harten Frist und Nachlauf fuer das Manifest: Einstellwerte (reverse_einstellungen, Code-Wert nur Standard).
  const einst=await leseReverseAufsicht();
  const nachlaufS=einst.nachlauf_s.wert;
  let lebt=true,aufraeumen=false;
  const aufsicht=this.aufsicht(lc,job,reverseHarteFrist(this.k,job.kind,einst.hart_puffer_s.wert));
  const timer=setInterval(()=>{void this.jobs.renew(wer,job.id,token,this.k.leaseSeconds).then(ok=>{if(!ok)lebt=false;},()=>{lebt=false;});},this.k.renewMs);
  timer.unref();
  try{
   let ergebnis:Record<string,unknown>;
   try{
    const live=await this.liveFortschritt(job,token);
    // P18-T86: S3-Grenzen (s3_zeitlimit_s, s3_lauf_bytes, ...) als Einstellungs-Snapshot des Eintrags; grenzen nur Transportfrist/Nachlauf.
    const s3Einst=await leseReverseEinstellwerte({eintrag_id:quelle.reverseId},this.pool);
    ergebnis=await lc.execute(REVERSE_TOOL_ID,REVERSE_PROJEKT,job.id,wer,token,async()=>({werkzeug:'analyzeHeadless',schicht:'S3',...(live?{fortschritt:{takt_s:live.takt_s}}:{}),
     ...(s3Einst.letzter_fehler?{}:{einstellungen:s3Einst}),
     eingabe:'/bib/'+quelle.storageKey,ausgabe:'/arbeit/'+job.id,
     grenzen:{zeitlimit_s:this.k.s3ZeitlimitS,max_bytes:this.k.s3MaxBytes,max_dateien:this.k.maxDateien,
      nachlauf_s:nachlaufS}}),live?.melde);
   }catch(e){
    if(!alt)await sperreArbeitsOrdner(arbeit);
    const m=(e as Error).message;
    // P18-T87: Transport-Timeout heisst Frist ueberschritten: Lauf physisch beenden und wie die harte Frist behandeln.
    if(m==='tool_runner_timeout')aufsicht.beende('zeitlimit');
    const eingriff=aufsicht.grund();
    if(eingriff){aufraeumen=await this.eingriffBeenden(job,wer,eingriff);return;}
    if(m==='tool_not_ready'||m==='tool_runner_capacity'){await this.jobs.release(wer,job.id,token);aufraeumen=true;}
    else console.error('[reverse-executor] S3-Ausfuehrung ohne sicheres Ende:',job.id,m);
    return;
   }
   clearInterval(timer);
   if(!alt)await sperreArbeitsOrdner(arbeit);
   aufsicht.ende();
   const status=String(ergebnis.status);
   // P18-T87: Storno kam vor dem Ergebnis an -> Ergebnis verwerfen, der Auftrag bleibt abgebrochen.
   if(aufsicht.grund()==='storno'){aufraeumen=await this.eingriffBeenden(job,wer,'storno');return;}
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
   aufraeumen=await this.scheitern(job,wer,status==='teilweise'?fehlercode(ergebnis.fehlercode??'deadline'):fehlercode(ergebnis.fehlercode,ergebnis.format_detail));
  }finally{
   clearInterval(timer);aufsicht.ende();
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
 const identitaet=reverseServerIdentitaet();
 const hostRoot=reverseHostWurzel(konfig,new Docker({socketPath:process.env.SYNAPSE_TOOL_DOCKER_SOCKET??'/var/run/docker.sock'}));
 const leser=new ReverseLeserExecutor({reverseRoot:konfig.reverseRoot,image:konfig.image,digest:konfig.digest,resourceDomain:konfig.resourceDomain,
  runtimeSha256:process.env.SYNAPSE_REVERSE_LESER_RUNTIME_SHA256??null,hostRoot,lifecycle:getToolLifecycle,identitaet});
 const alteMounts=reverseMountResolver(konfig,hostRoot);
 try{configureToolLifecycleAdapters({executor:new DockerToolContainerExecutor({socketPath:process.env.SYNAPSE_TOOL_DOCKER_SOCKET,resolveMounts:(d,c)=>d.tool_id===LESER_TOOL?leser.mounts(d,c):alteMounts(d,c),
  lokaleImages:process.env.SYNAPSE_REVERSE_IMAGE_LOKAL==='1'}),resources:{acquire:(d,c)=>d.tool_id===LESER_TOOL?leser.ressourcen.acquire(d,c):reverseRessourcen.acquire(d,c),
   release:t=>t.startsWith('reverse-leser:')?leser.ressourcen.release(t):reverseRessourcen.release(t)}});}
 catch(e){console.error('[reverse-executor] Tool-Lebenszyklus bereits gestartet, Executor bleibt aus:',(e as Error).message);return null;}
 const executor=new ReverseExecutor({konfig,lifecycle:getToolLifecycle,identitaet});
 // P21-T15: Hex bindet sofort und hält den Knoten frisch, auch ohne Docker/Lebenszyklus und ohne Reverse-Aufträge.
 const hexAnbinden=()=>{void identitaet().catch(e=>console.error('[reverse-executor] Hex-Anbindung fehlgeschlagen:',(e as Error).message));};
 hexAnbinden();const hexTimer=setInterval(hexAnbinden,konfig.tickMs);hexTimer.unref();
 const abmelden=registriereWorkJobHooks(REVERSE_CAPABILITY,executor.hooks());
 // K5: reverse(status) liest den echten Containerzustand über die Reverse-Runtime (nach starteReversePipeline gesetzt).
 const ohneStatus=ergaenzeReverseRuntime({containerStatus:rid=>executor.containerStatus(rid)});
 // P18-T64: Ausführer anmelden – Pipeline reiht nur noch diese Kinds ein, Diagnose/Entstörer sehen Kapazität und können neu starten.
 const zeitlimits:Record<string,number>=Object.fromEntries(konfig.kinds.map(kind=>[kind,reverseZeitlimitS(konfig,kind)]));
 const abmeldenAusfuehrer=meldeReverseAusfuehrer({kinds:konfig.kinds,parallel:konfig.parallel,
  zeitlimits,
  kapazitaet:async()=>{const lc=getToolLifecycle();if(!lc)throw Error('tool_lifecycle_aus');return lc.kapazitaet();},
  containerNeustart:async(jobId?:string|null)=>{const lc=getToolLifecycle();if(!lc)return {neu_gestartet:false,zustand:'tool_lifecycle_aus'};return lc.neustart(REVERSE_TOOL_ID,REVERSE_PROJEKT,jobId??null);}});
 // P18-T86: Betriebswerte je Takt aus reverse_einstellungen (eine Lesestelle); geaenderter Descriptor wird geordnet neu registriert.
 const einstellungenAnwenden=async():Promise<void>=>{
  const s=await leseReverseEinstellwerte({});
  if(s.letzter_fehler){console.warn('[reverse-executor] Einstellungen nicht verwendbar, bisherige Werte bleiben:',s.letzter_fehler);return;}
  if(reverseKonfigAusEinstellungen(konfig,s).descriptorGeaendert)executor.descriptorNeu();
  konfig.wavPregap=(await leseReverseProduktSchalter('reverse_wav_pregap')).aktiv;
  for(const kind of konfig.kinds)zeitlimits[kind]=reverseZeitlimitS(konfig,kind);
 };
 let running:Promise<ReverseDurchlauf>|null=null;
 const tick=async()=>{if(!running)running=(async()=>{
  await einstellungenAnwenden().catch(e=>console.error('[reverse-executor] Einstellungen nicht lesbar:',(e as Error).message));
  const ergebnis=await executor.durchlauf();
  await leser.durchlauf().catch(e=>console.error('[reverse-leser] Durchlauf fehlgeschlagen:',(e as Error).message));
  return ergebnis;
 })().finally(()=>{running=null;});return running;};
 registriereWorker({name:'reverse-executor',beschreibung:'RV12 reverse-E-Aufträge im Reverse-Container ausführen',durchlauf:tick});
 const run=()=>{if(workerPausiert('reverse-executor'))return;void tick().catch(e=>console.error('[reverse-executor] Durchlauf fehlgeschlagen:',(e as Error).message));};
 // Takt aus executor_tick_ms, je Runde neu gelesen.
 let timer:NodeJS.Timeout|null=null,beendet=false;
 const planen=()=>{if(beendet)return;timer=setTimeout(()=>{run();planen();},konfig.tickMs);timer.unref();};
 planen();
 console.log('[reverse-executor] aktiv: Kinds '+konfig.kinds.join(',')+', parallel '+konfig.parallel);
 return {beende:async()=>{beendet=true;if(timer)clearTimeout(timer);clearInterval(hexTimer);abmelden();ohneStatus();abmeldenAusfuehrer();await Promise.all([executor.beende(),leser.beende()]);}};
}
