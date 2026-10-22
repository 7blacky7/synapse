/** P18-T40 Teil B: P20-Leseradapter, keine eigene Queue und keine Tool-Aktionen. */
import {constants} from 'node:fs';
import {open,lstat,realpath,opendir,mkdir,chmod,chown} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {getPool,createWorkJobService,registerToolDescriptor,setToolActivation,validateToolDescriptor,
 materialisiereReverseLeser,leseReverseLeserSchalter,leseReverseLeserRevision,leseReverseEinstellwerte,reverseZahl,reverseBigInt,
 reverseLeserDezimal,reverseLeserPfad,reverseLeserKanonisch,reverseLeserHash,pruefeReverseLeserManifest,reverseLeserSchrittBudget,
 type ReverseLeserRevision,type ReverseLeserManifest,type ReverseEinstellSnapshot,
 type ToolDescriptor,type WorkIdentity,type WorkJob,type WorkJobHooks,type WorkJobPool} from '@synapse/core';
import {planeReverseLeserNachzug,reverseLeserNachzugFreigegeben,reverseLeserProjektarbeitVorrang,leseReverseLeserNachzugSchalter,reverseLeserEintragAktiv as reverseEintragAktiv} from '@synapse/core';
import {pruefeLeserRuntimeSnapshot} from '@synapse/core';
import type {ToolLifecycle,ToolInstanceContext,ToolResourceAdapter} from './tool-lifecycle.js';
import type {ResolvedToolMount} from './tool-container-docker.js';

export const LESER_TOOL='reverse-leser',LESER_CAPABILITY='reverse_leser';
const PROJEKT='reverse-bibliothek',PROTOKOLL='.leser-protokoll.jsonl';
const AUTH={role:'koordinator' as const,authenticated:true as const};
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Raw=Record<string,unknown>;
type Db=Pick<PoolClient,'query'>;
function fail(code:string):never{throw Error(code);}
function obj(v:unknown):v is Raw{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function fields(v:unknown,keys:string[]):asserts v is Raw{
 if(!obj(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!(k in v)))fail('leser_protokoll_felder');
}
function text(v:unknown,s:ReverseEinstellSnapshot):string{
 if(typeof v!=='string'||!v||v.length>reverseZahl(s,'parameter_text_zeichen')||/[\x00-\x1f\x7f]/.test(v))fail('leser_text_ungueltig');
 return v;
}
function hash(v:unknown):string{if(typeof v!=='string'||!SHA.test(v))fail('leser_hash_ungueltig');return v;}
/** Kein Symlink unter irgendeiner Komponente; Wurzel ausschließlich aus Serverkonfiguration. */
export async function leserSichererPfad(root:string,key:string,s:ReverseEinstellSnapshot):Promise<string>{
 reverseLeserPfad(key,s);
 const base=path.resolve(root);if(await realpath(base)!==base)fail('leser_wurzel_symlink');
 let p=base;
 for(const teil of key.split('/')){
  p=path.join(p,teil);const st=await lstat(p);
  if(st.isSymbolicLink()||(!st.isDirectory()&&!st.isFile()))fail('leser_pfad_spezialdatei');
 }
 if(await realpath(p)!==p)fail('leser_pfad_symlink');
 return p;
}
async function datei(p:string,max:bigint,s:ReverseEinstellSnapshot,onBlock?:(b:Buffer)=>Promise<void>){
 const h=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const vor=await h.stat({bigint:true});
  if(!vor.isFile()||vor.nlink!==1n||vor.size>max)fail('leser_datei_ungueltig');
  const digest=createHash('sha256'),buffer=Buffer.alloc(reverseZahl(s,'lese_block_bytes'));let bytes=0n;
  const deadline=Date.now()+reverseZahl(s,'e_zeitlimit_s')*1000;
  for(;;){
   if(Date.now()>deadline)fail('leser_dateipruefung_zeitlimit');
   const r=await h.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;
   bytes+=BigInt(r.bytesRead);if(bytes>max)fail('leser_datei_zu_gross');
   const b=buffer.subarray(0,r.bytesRead);digest.update(b);if(onBlock)await onBlock(b);
  }
  const nach=await h.stat({bigint:true});
  if(bytes!==vor.size||vor.size!==nach.size||vor.mtimeNs!==nach.mtimeNs||vor.ctimeNs!==nach.ctimeNs)fail('leser_datei_veraendert');
  return {bytes:String(bytes),sha256:digest.digest('hex')};
 }finally{await h.close();}
}
async function baum(root:string,s:ReverseEinstellSnapshot,maxDateien:bigint,maxBytes:bigint){
 const files=new Map<string,bigint>();let bytes=0n,ordner=0n;
 const deadline=Date.now()+reverseZahl(s,'e_zeitlimit_s')*1000;
 async function scan(rel:string,tiefe:number):Promise<void>{
  if(tiefe>reverseZahl(s,'pfad_tiefe_max'))fail('leser_pfad_tiefe');
  const dir=rel?await leserSichererPfad(root,rel,s):root;
  for await(const eintrag of await opendir(dir)){
   if(Date.now()>deadline)fail('leser_baumpruefung_zeitlimit');
   const n=eintrag.name,key=rel?rel+'/'+n:n,p=await leserSichererPfad(root,key,s),st=await lstat(p,{bigint:true});
   if(st.isDirectory()){
    if(++ordner>maxDateien*BigInt(reverseZahl(s,'pfad_tiefe_max')+1))fail('leser_verzeichnisse_limit');
    await scan(key,tiefe+1);
   }else{
    if(st.nlink!==1n)fail('leser_hardlink');
    files.set(key,st.size);bytes+=st.size;
    if(BigInt(files.size)>maxDateien||bytes>maxBytes)fail('leser_schrittgrenze');
   }
  }
 }
 await scan('',0);return {files,bytes};
}
async function jsonDatei(p:string,max:bigint,s:ReverseEinstellSnapshot){
 const teile:Buffer[]=[];await datei(p,max,s,async b=>{teile.push(Buffer.from(b));});
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(teile))) as unknown;
}
async function jsonl(p:string,max:bigint,s:ReverseEinstellSnapshot,record:(v:unknown)=>Promise<void>){
 let rest:Buffer=Buffer.alloc(0),zeilen=0n;
 const beleg=await datei(p,max,s,async b=>{
  rest=Buffer.concat([rest,b]);let pos:number;
  while((pos=rest.indexOf(10))>=0){
   if(pos>reverseZahl(s,'e_metadaten_record_bytes'))fail('leser_zeile_limit');
   const line=rest.subarray(0,pos);rest=rest.subarray(pos+1);
   if(!line.length)fail('leser_leere_zeile');
   await record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));zeilen++;
  }
  if(rest.length>reverseZahl(s,'e_metadaten_record_bytes'))fail('leser_zeile_limit');
 });
 if(rest.length)fail('leser_ende_unvollstaendig');
 return {...beleg,zeilen:String(zeilen)};
}
export interface LeserValidierung {
 status:'fertig'|'teilweise';grund:string|null;offen:string;objekte:string;bytes:string;
 manifest:{pfad:string;sha256:string;bytes:string;zeilen:string};cursor:string|null;
}
/** Nur nach bestätigtem Containerende. Exit 0 allein und ein leeres Manifest genügen nie. */
export async function pruefeLeserAusgabe(root:string,s:ReverseEinstellSnapshot,m:ReverseLeserManifest,
 quellBytes:string,antwort:Raw):Promise<LeserValidierung>{
 if(antwort.status!=='fertig'||antwort.leser_exit!==0)fail('leser_prozess_nicht_erfolgreich');
 fields(antwort.leser_protokoll,['pfad','sha256','bytes','zeilen']);
 const behauptet=antwort.leser_protokoll;if(behauptet.pfad!==PROTOKOLL)fail('leser_protokoll_pfad');
 const budget=reverseLeserSchrittBudget(m,s),limit=BigInt(budget.dateien),bytesLimit=BigInt(budget.bytes);
 const bestand=await baum(root,s,limit+1n,bytesLimit+reverseBigInt(s,'runner_output_bytes'));
 const erlaubt=new Set([PROTOKOLL]),members=new Set<string>(),objektpfade=new Set<string>();
 let count=0n,ende:Raw|null=null,cursor:string|null=null,segmente=0n;
 const deadline=Date.now()+reverseZahl(s,'e_zeitlimit_s')*1000;
 const zeit=()=>{if(Date.now()>deadline)fail('leser_validierung_zeitlimit');};
 async function artefakt(roh:unknown,segment=false){
  fields(roh,segment?['pfad','sha256','bytes','zeilen']:['pfad','sha256','bytes']);
  const key=reverseLeserPfad(roh.pfad,s);if(erlaubt.has(key))fail('leser_artefakt_doppelt');
  const bytes=reverseLeserDezimal(roh.bytes);
  if(BigInt(bytes)>reverseBigInt(s,'max_datei_bytes')||bestand.files.get(key)!==BigInt(bytes))fail('leser_artefakt_laenge');
  erlaubt.add(key);return {key,p:await leserSichererPfad(root,key,s),bytes,sha256:hash(roh.sha256)};
 }
 async function objekt(v:unknown){
  zeit();fields(v,['art','member_id','objektpfad','typ','quelle','datei','metadaten']);
  if(v.art!=='objekt')fail('leser_segment_record');
  const member=text(v.member_id,s),op=reverseLeserPfad(v.objektpfad,s);
  if(members.has(member)||objektpfade.has(op))fail('leser_objekt_doppelt');
  members.add(member);objektpfade.add(op);if(++count>limit)fail('leser_objekte_schrittgrenze');
  if(!m.ausgabetypen.includes(v.typ as never))fail('leser_ausgabetyp_ungueltig');
  fields(v.quelle,['offset','laenge']);
  if(BigInt(reverseLeserDezimal(v.quelle.offset))+BigInt(reverseLeserDezimal(v.quelle.laenge))>BigInt(quellBytes))fail('leser_quellbereich');
  if(!obj(v.metadaten))fail('leser_metadaten_ungueltig');
  if(v.datei===null){if(!Object.keys(v.metadaten).length)fail('leser_objekt_ohne_daten');}
  else{
   const f=await artefakt(v.datei),b=await datei(f.p,reverseBigInt(s,'max_datei_bytes'),s,async()=>zeit());
   if(b.sha256!==f.sha256||b.bytes!==f.bytes)fail('leser_artefakt_hash');
  }
 }
 const beleg=await jsonl(await leserSichererPfad(root,PROTOKOLL,s),reverseBigInt(s,'runner_output_bytes'),s,async v=>{
  zeit();if(ende)fail('leser_record_nach_ende');if(!obj(v))fail('leser_record_ungueltig');
  if(v.art==='objekt')await objekt(v);
  else if(v.art==='fortschritt'){
   fields(v,['art','member_id','bearbeitet','offen']);text(v.member_id,s);reverseLeserDezimal(v.bearbeitet);
   if(v.offen!==null)reverseLeserDezimal(v.offen);
  }else if(v.art==='schritt'){
   fields(v,['art','cursor','segment']);
   if(typeof v.cursor!=='string'||!v.cursor||v.cursor.length>reverseZahl(s,'cursor_zeichen'))fail('leser_cursor_ungueltig');
   cursor=v.cursor;if(++segmente>limit)fail('leser_segmente_schrittgrenze');
   const f=await artefakt(v.segment,true),segment=v.segment as Raw,b=await jsonl(f.p,reverseBigInt(s,'max_datei_bytes'),s,objekt);
   if(b.sha256!==f.sha256||b.bytes!==f.bytes||b.zeilen!==reverseLeserDezimal(segment.zeilen))fail('leser_segment_hash');
  }else if(v.art==='ende'){
   fields(v,['art','status','grund','offen','objekte']);
   if(!['fertig','teilweise'].includes(String(v.status)))fail('leser_ende_ohne_ergebnis');
   if(v.grund!==null)text(v.grund,s);
   if(BigInt(reverseLeserDezimal(v.objekte))!==count||count===0n)fail('leser_ende_ohne_daten');
   const offen=BigInt(reverseLeserDezimal(v.offen));
   if(v.status==='fertig'&&offen!==0n||v.status==='teilweise'&&(offen===0n||cursor===null||v.grund===null))fail('leser_ende_widerspruch');
   ende=v;
  }else fail('leser_record_art');
 });
 if(!ende)fail('leser_endmarker_fehlt');
 if(beleg.sha256!==hash(behauptet.sha256)||beleg.bytes!==reverseLeserDezimal(behauptet.bytes)||beleg.zeilen!==reverseLeserDezimal(behauptet.zeilen))fail('leser_protokoll_hash');
 if([...bestand.files.keys()].some(p=>!erlaubt.has(p)))fail('leser_artefakt_ungemeldet');
 if(bestand.bytes-BigInt(beleg.bytes)>bytesLimit)fail('leser_schrittgrenze');
 const e=ende as Raw;
 return {status:e.status as 'fertig'|'teilweise',grund:e.grund as string|null,offen:String(e.offen),objekte:String(count),
  bytes:String(bestand.bytes),manifest:{pfad:PROTOKOLL,...beleg},cursor};
}

export interface LeserExecutorKonfig {
 reverseRoot:string;image:string;digest:string;resourceDomain?:string|null;
 /** Infrastruktur-Pin, nicht vom Leser/Job bestimmbar. Paketbereitstellung folgt in Teil D/V6. */
 hostRoot:()=>Promise<string|null>;
 lifecycle:()=>ToolLifecycle|null;identitaet:()=>Promise<WorkIdentity|null>;pool?:Pool;
}
interface Lauf {
 id:string;eintrag_id:string;datei_id:string;quell_sha256:string;generation:string;
 leser_id:string;einstellungen_revision:string;storage_key:string;groesse:string;cursor_key:string|null;status:string;
 testmodus:boolean;paket_key:string|null;host_validiert:boolean;
 runtime_sha256:string|null;runtime_image_digest:string|null;
}
interface Vorbereitet {lauf:Lauf;s:ReverseEinstellSnapshot;r:ReverseLeserRevision;ausgabe:string;key:string;eingabe:string;paket:string;runtime:string}
export function leserDescriptor(k:LeserExecutorKonfig,s:ReverseEinstellSnapshot):ToolDescriptor{
 const n=(name:Parameters<typeof reverseZahl>[1])=>reverseZahl(s,name);
 return validateToolDescriptor({tool_id:LESER_TOOL,tool:'reverse',capability:LESER_CAPABILITY,image:k.image,digest:k.digest,
  instance_scope:'job',network:'none',allow_project_share:false,
  mounts:[{role:'laufzeit',target:'/opt/reverse',write:false},{role:'leser',target:'/leser',write:false},
   {role:'eingabe',target:'/eingabe',write:false},{role:'ausgabe',target:'/arbeit',write:true,job_only:true}],
  resources:{cpu:n('e_cpu'),ram:n('e_ram_mib'),vram:0,gpu:false,pids:n('container_pids'),tmpfs:n('container_tmpfs_mib'),concurrency:1},
  limits:{time_ms:(n('e_zeitlimit_s')+n('container_zeit_zuschlag_s'))*1000,output_bytes:n('runner_output_bytes'),input_bytes:n('runner_input_bytes')},
  lifecycle:{idle_ms:n('container_idle_ms'),activity_lookback_seconds:n('container_aktivitaet_fenster_s'),cpu_idle_percent:n('container_cpu_idle_prozent'),
   gpu_idle_percent:n('container_gpu_idle_prozent'),measurement_max_age_ms:n('container_messung_max_alter_ms'),start_timeout_ms:n('container_start_timeout_ms'),
   max_starts:n('container_max_starts'),start_window_ms:n('container_start_fenster_ms'),pause_ms:n('container_pause_ms')}});
}
/** Kein enqueue: Teil D liefert autorisierte Work-Jobs und immutable Laufbindungen. */
export class ReverseLeserExecutor {
 private readonly pool:Pool;
 private readonly jobs:ReturnType<typeof createWorkJobService>;
 private readonly laufend=new Map<string,Promise<void>>();
 private readonly vorbereitet=new Map<string,Vorbereitet>();
 private wer:WorkIdentity|null=null;
 private s:ReverseEinstellSnapshot|null=null;
 private beendet=false;
 constructor(private readonly k:LeserExecutorKonfig){
  this.pool=k.pool??getPool();
  // Lokale Hooks: der unveränderte E-Executor darf Leseraufträge NICHT claimen.
  this.jobs=createWorkJobService({pool:this.pool as unknown as WorkJobPool,...this.hooks(),config:{interactiveReserve:0}});
 }
 private async aktiv(db:Db=this.pool){
  const a=await leseReverseLeserSchalter(db as PoolClient);
  return a.aktiv&&!a.letzter_fehler&&!this.beendet;
 }
 private async lauf(job:WorkJob,db:Db=this.pool,lock=false):Promise<Lauf|null>{
  if(job.project!==PROJEKT||job.capability!==LESER_CAPABILITY||job.kind!=='reverse-leser'||job.scope!=='reverse'
   ||job.inputRef.scope!=='reverse'||!await this.aktiv(db))return null;
  const r=await db.query<Lauf>(
   "SELECT l.id::text,l.eintrag_id,l.datei_id::text,l.quell_sha256,l.generation::text,l.leser_id,"+
   "l.einstellungen_revision,l.runtime_sha256,l.runtime_image_digest,l.cursor_key,l.status,d.storage_key,d.groesse::text,"+
   "(l.diagnose->>'testmodus'='true') AS testmodus,l.diagnose->>'paket_key' AS paket_key,"+
   "(l.diagnose->>'host_validiert'='true') AS host_validiert "+
   "FROM reverse_leser_laeufe l JOIN reverse_dateien d ON d.id=l.datei_id AND d.eintrag_id=l.eintrag_id "+
   "JOIN reverse_eintraege e ON e.id=l.eintrag_id JOIN reverse_leser_zustaende z ON z.leser_id=l.leser_id "+
   "JOIN reverse_leser r ON r.id=l.leser_id "+
   "WHERE l.work_job_id=$1 AND l.eintrag_id=$2 AND l.datei_id::text=$3 AND l.quell_sha256=$4 "+
   "AND d.sha256=l.quell_sha256 AND d.storage_key IS NOT NULL AND e.status='bestaetigt' "+
   "AND (z.status='aktiv' OR (l.diagnose->>'testmodus'='true' "+
   "AND l.diagnose->>'paket_key'='.intern/leser/'||r.id||'/'||r.paket_sha256)) "+
   "AND (l.diagnose->>'testmodus' IS DISTINCT FROM 'true' OR "+
   "EXISTS(SELECT 1 FROM reverse_bindungen b WHERE b.eintrag_id=l.eintrag_id AND b.project=l.diagnose->>'quellprojekt' AND b.geloest_at IS NULL)) "+
   "AND EXISTS(SELECT 1 FROM reverse_schichten es WHERE es.medium_id=d.medium_id AND es.schicht='E' AND es.aktuell AND es.status IN('fertig','teilweise')) "+
   (lock?'FOR SHARE OF l,d,e,z':''),[job.id,job.inputRef.id,job.inputRef.revision,job.inputRef.sha256]);
  if(r.rows.length!==1||r.rows[0].status==='fehler'||!await reverseEintragAktiv(db,r.rows[0].eintrag_id))return null;
  if(!await reverseLeserNachzugFreigegeben(db,job.id))return null;
  return r.rows[0];
 }
 private hooks():WorkJobHooks{
  const domain=(n:string)=>this.k.resourceDomain??'reverse:'+n;
  return {
   resourceDomain:n=>this.wer?.nodeId===n?domain(n):undefined,
   authorizeJob:async(n,j,c)=>{
    if(j.priority==='nachzug'&&await reverseLeserProjektarbeitVorrang(c as unknown as Db))return null;
    const l=await this.lauf(j,c as unknown as Db);
    const materialisierung=l?.host_validiert&&['fertig','teilweise'].includes(l.status);
    if(!this.s||!this.wer||n.node_id!==this.wer.nodeId||String(n.boot_id)!==this.wer.bootGeneration||n.service_token_hash!==this.wer.authHash
     ||(j.state==='pending'&&!this.vorbereitet.has(j.id)&&!materialisierung)||!l||j.resourceNeed.gpu)return null;
    const cpu=reverseZahl(this.s,'e_cpu'),ram=reverseZahl(this.s,'e_ram_mib'),parallel=reverseZahl(this.s,'executor_parallel');
    if(j.resourceNeed.cpu!==cpu||j.resourceNeed.ram!==ram||j.resourceNeed.vram!==0)return null;
    return {resourceDomain:domain(n.node_id),maxConcurrent:parallel,budget:{cpu:cpu*parallel,ram:ram*parallel,vram:0,gpu:false}};
   },
   inputStillCurrent:async(j,c)=>!!await this.lauf(j,c as unknown as Db,true),
   outputIsStaged:async(j,out,c)=>{
    if(out.scope!=='reverse-leser'||!await this.lauf(j,c as unknown as Db,true))return false;
    const r=await c.query("SELECT 1 FROM reverse_leser_laeufe WHERE work_job_id=$1 AND id::text=$2 AND datei_id::text=$3 AND manifest_sha256=$4 AND status IN('fertig','teilweise') AND beendet_at IS NOT NULL",
     [j.id,out.id,out.revision,out.sha256]);return r.rows.length===1;
   },
  };
 }
 readonly ressourcen:ToolResourceAdapter={
  acquire:async(d,c)=>d.tool_id===LESER_TOOL&&await this.aktiv()?'reverse-leser:'+c.instance_id+':'+c.generation:null,
  release:async()=>{},
 };
 private async paket(r:ReverseLeserRevision,s:ReverseEinstellSnapshot,testKey:string|null=null){
  const key=testKey??r.storage_key;
  if((!testKey&&r.status!=='aktiv')||!key)fail('leser_revision_inaktiv');
  if(key!=='.intern/leser/'+r.id+'/'+r.paket_sha256)fail('leser_paket_scope');
  const root=await leserSichererPfad(this.k.reverseRoot,key,s);
  const bestand=await baum(root,s,BigInt(r.manifest.dateien.length),reverseBigInt(s,'leser_paket_bytes'));
  if(bestand.files.size!==r.manifest.dateien.length||r.quelle.dateien.length!==r.manifest.dateien.length)fail('leser_paket_dateien');
  const index=[];
  for(const q of r.quelle.dateien){
   if(!r.manifest.dateien.includes(q.pfad))fail('leser_paket_index');
   const b=await datei(await leserSichererPfad(root,q.pfad,s),reverseBigInt(s,'leser_paket_bytes'),s);
   if(b.sha256!==q.sha256||b.bytes!==q.bytes)fail('leser_paket_hash');
   index.push({pfad:q.pfad,sha256:b.sha256,bytes:b.bytes});
  }
  if(reverseLeserHash(reverseLeserKanonisch(index))!==r.code_sha256
   ||reverseLeserHash(reverseLeserKanonisch(r.manifest))!==r.manifest_sha256)fail('leser_revision_hash');
  return root;
 }
 /** V6: vertrauenswürdiger generischer Runtime-Index, kein Plugin darf den Runner liefern. */
 private async runtime(s:ReverseEinstellSnapshot,l:Lauf){
  if(!l.runtime_sha256||!l.runtime_image_digest)fail('leser_laufzeit_pin_fehlt');
  try{return (await pruefeLeserRuntimeSnapshot(this.pool,{
   runtime_sha256:l.runtime_sha256,runtime_image_digest:l.runtime_image_digest},s,this.k.reverseRoot,this.k.digest)).root;}
  catch(e){
   const code=(e as Error).message;
   fail(code.startsWith('leser_runtime_')||code.startsWith('leser_laufzeit_')?code:'leser_runtime_snapshot_ungueltig');
  }
 }
 private async vorbereiten(job:WorkJob):Promise<Vorbereitet>{
  const l=await this.lauf(job);if(!l||!['offen','laeuft'].includes(l.status))fail('leser_lauf_nicht_freigegeben');
  if(!UUID.test(job.id)||!UUID.test(l.generation)||!/^[a-zA-Z0-9_-]+$/.test(l.eintrag_id))fail('leser_lauf_scope');
  if(l.cursor_key!==null)fail('leser_checkpoint_benoetigt_teil_c');
  const s=await leseReverseEinstellwerte({eintrag_id:l.eintrag_id},this.pool);
  if(s.letzter_fehler)fail(s.letzter_fehler);
  if(s.revision!==l.einstellungen_revision)fail('leser_einstellungen_veraendert');
  const r=await leseReverseLeserRevision(this.pool,l.leser_id);if(!r)fail('leser_revision_fehlt');
  r.manifest=pruefeReverseLeserManifest(r.manifest,s);
  if(!l.storage_key.startsWith(l.eintrag_id+'/'))fail('leser_eingabe_scope');
  const eingabe=await leserSichererPfad(this.k.reverseRoot,l.storage_key,s),b=await datei(eingabe,BigInt(l.groesse),s);
  if(b.sha256!==l.quell_sha256||b.bytes!==l.groesse)fail('leser_eingabe_hash');
  const paket=await this.paket(r,s,l.testmodus?l.paket_key:null),runtime=await this.runtime(s,l);
  const key=l.eintrag_id+(l.testmodus?'/.intern/leser-tests/':'/.intern/leser/')+l.generation+'/'+job.id+'/'+String(job.attempt);
  let parent=await leserSichererPfad(this.k.reverseRoot,l.eintrag_id,s);
  for(const part of key.split('/').slice(1)){
   const next=path.join(parent,part);
   try{await mkdir(next,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
   if(await realpath(next)!==next||(await lstat(next)).isSymbolicLink())fail('leser_ausgabe_symlink');
   parent=next;
  }
  const ausgabeDir=await opendir(parent);
  try{if(await ausgabeDir.read())fail('leser_ausgabe_bereits_vorhanden');}finally{await ausgabeDir.close();}
  await chown(parent,65532,65532);await chmod(parent,0o700);
  return {lauf:l,s,r,ausgabe:parent,key,eingabe,paket,runtime};
 }
 async mounts(d:ToolDescriptor,c:ToolInstanceContext):Promise<ResolvedToolMount[]>{
  if(d.tool_id!==LESER_TOOL)return [];
  if(!c.job_id||c.project!==PROJEKT||!await this.aktiv())fail('leser_aus');
  const job=await this.jobs.get(c.job_id,PROJEKT);if(!job)fail('leser_job_fehlt');
  if(job.state!=='pending'||this.laufend.has(job.id))fail('leser_start_nur_vor_claim');
  const v=await this.vorbereiten({...job,attempt:job.attempt+1});
  this.vorbereitet.set(job.id,v);
  const hostWurzel=await this.k.hostRoot();if(!hostWurzel)fail('leser_hostwurzel_fehlt');
  const host=path.resolve(hostWurzel),base=path.resolve(this.k.reverseRoot);
  const mount=(role:string,source:string,write=false):ResolvedToolMount=>({role,source,root:base,
   hostSource:path.join(host,path.relative(base,source)),allowWrite:write,allowProjectShare:false});
  return [mount('laufzeit',v.runtime),mount('leser',v.paket),mount('eingabe',v.eingabe),mount('ausgabe',v.ausgabe,true)];
 }
 /** Ein Statusdatensatz je TX: auch bei PG-Zeilengrenze 1. Der Lauf ist das
  * dauerhafte Abschlussjournal; ein abgebrochener zweiter Schritt wird im Takt fortgesetzt. */
 private async statusTx(s:ReverseEinstellSnapshot,params:unknown[],fn:(c:PoolClient)=>Promise<void>){
  if(reverseZahl(s,'e_uebernahme_block_zeilen')<1
   ||BigInt(Buffer.byteLength(reverseLeserKanonisch(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))
   fail('leser_abschluss_tx_zu_gross');
  const c=await this.pool.connect();
  try{await c.query('BEGIN');await fn(c);await c.query('COMMIT');}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private async fehlerAbschliessen(job:WorkJob,laufId:string,s:ReverseEinstellSnapshot,code:string,
  diagnose:Record<string,unknown>,bytes:string|null,wer?:WorkIdentity){
  const params=[job.id,job.inputRef.id,job.inputRef.revision,job.inputRef.sha256,job.attempt,code,
   {...diagnose,abschluss_versuch:job.attempt},bytes,laufId,!!wer];
  await this.statusTx(s,params,async c=>{
   const own=wer
    ?await c.query("SELECT 1 FROM work_jobs WHERE id=$1 AND state='leased' AND attempt=$2 AND claim_token=$3 AND owner_node=$4 AND boot_generation=$5 AND owner_auth_hash=$6 FOR UPDATE",
      [job.id,job.attempt,job.claimToken,wer.nodeId,wer.bootGeneration,wer.authHash])
    :await c.query("SELECT 1 FROM work_jobs WHERE id=$1 AND state='pending' AND attempt=$2 AND kind='reverse-leser' AND capability=$3 AND project=$4 FOR UPDATE",
      [job.id,job.attempt,LESER_CAPABILITY,PROJEKT]);
   if(!own.rows.length)return;
   // Die immutable Laufbindung verhindert Fremdeintrag-/Dateiabschluss.
   await c.query("UPDATE reverse_leser_laeufe SET status='fehler',fehlercode=$6,diagnose=diagnose||$7::jsonb,ausgabe_bytes=COALESCE($8::bigint,ausgabe_bytes),beendet_at=clock_timestamp() "+
    "WHERE work_job_id=$1 AND eintrag_id=$2 AND datei_id::text=$3 AND quell_sha256=$4 AND id=$9 AND (status IN('offen','laeuft') OR (($10::boolean OR diagnose->>'host_validiert'='true') AND status IN('fertig','teilweise'))) AND $5::integer>=0",params);
  });
  await this.fehlerFortsetzen(job.id,s);
 }
 private async fehlerFortsetzen(id:string,s:ReverseEinstellSnapshot){
  // Nur ein UPDATE; nach Crash zwischen den beiden TX bleibt der Lauf terminal.
  // Claimen wird bei fehlerhaftem Lauf ausgeschlossen, der Versuch darf nicht wechseln.
  await this.statusTx(s,[id],async c=>{
   const jobs=await c.query("SELECT id,attempt FROM work_jobs WHERE id=$1 AND kind='reverse-leser' AND capability=$2 AND project=$3 AND state IN('pending','leased') FOR UPDATE",
    [id,LESER_CAPABILITY,PROJEKT]);
   if(!jobs.rows.length)return;
   const runs=await c.query("SELECT fehlercode,diagnose FROM reverse_leser_laeufe WHERE work_job_id=$1 AND status='fehler' AND diagnose->>'abschluss_versuch'=$2 FOR SHARE",
    [id,String(jobs.rows[0].attempt)]);
   if(runs.rows.length!==1)return;
   const r=runs.rows[0],params=[id,r.fehlercode,r.diagnose.physisches_ende!==true];
   if(BigInt(Buffer.byteLength(reverseLeserKanonisch(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))
    fail('leser_abschluss_tx_zu_gross');
   await c.query("UPDATE work_jobs SET state='failed',error_code=$2,resource_unconfirmed=$3,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1",params);
  });
 }
 private async veraltetenJobAbschliessen(id:string,runtimeCode?:string){
  const job=await this.jobs.get(id,PROJEKT);if(!job||job.state!=='pending')return;
  const l=await this.lauf(job);if(!l)return;
  const s=await leseReverseEinstellwerte({eintrag_id:l.eintrag_id},this.pool);
  if(s.letzter_fehler)fail(s.letzter_fehler);
  if(s.revision===l.einstellungen_revision&&!runtimeCode)return;
  await this.fehlerAbschliessen(job,l.id,s,runtimeCode??(l.host_validiert?'leser_einstellungen_geaendert':'konfiguration_veraltet'),{
   physisches_ende:true,keine_neue_ausgabe:true,
   einstellungen_revision_alt:l.einstellungen_revision,einstellungen_revision_aktuell:s.revision,
  },null);
 }
 async durchlauf(){
  if(!await this.aktiv()){
   // AUS erzeugt keinen Descriptor/Auftrag; eventuell bestehende Aktivierung wird zurückgenommen.
   await this.pool.query('UPDATE tool_activation SET enabled=FALSE WHERE tool_id=$1 AND project=$2 AND enabled',[LESER_TOOL,PROJEKT]);
   return {hinweis:'reverse_leser_aus',gestartet:0};
  }
  const lc=this.k.lifecycle();if(!lc)return {hinweis:'tool_lifecycle_aus',gestartet:0};
  this.s=await leseReverseEinstellwerte({},this.pool);if(this.s.letzter_fehler)fail(this.s.letzter_fehler);
  this.wer=await this.k.identitaet();if(!this.wer)return {hinweis:'server_identitaet_fehlt',gestartet:0};
  await registerToolDescriptor(this.pool,leserDescriptor(this.k,this.s),AUTH);
  await setToolActivation(this.pool,LESER_TOOL,null,true,AUTH);
  await setToolActivation(this.pool,LESER_TOOL,PROJEKT,true,AUTH);
  const abschluesse=await this.pool.query("SELECT j.id,l.eintrag_id FROM work_jobs j JOIN reverse_leser_laeufe l ON l.work_job_id=j.id WHERE j.kind='reverse-leser' AND j.capability=$1 AND j.project=$2 AND j.state IN('pending','leased') AND l.status='fehler' AND l.diagnose->>'abschluss_versuch'=j.attempt::text ORDER BY j.created_at,j.id LIMIT $3",
   [LESER_CAPABILITY,PROJEKT,reverseZahl(this.s,'e_uebernahme_block_zeilen')]);
  for(const row of abschluesse.rows){
   const s=await leseReverseEinstellwerte({eintrag_id:String(row.eintrag_id)},this.pool);
   if(s.letzter_fehler)fail(s.letzter_fehler);
   await this.fehlerFortsetzen(String(row.id),s);
  }
  const frei=reverseZahl(this.s,'executor_parallel')-this.laufend.size;if(frei<=0)return {gestartet:0};
  const nachzug:Record<string,unknown>=await planeReverseLeserNachzug(this.pool,this.k.reverseRoot,{image:this.k.image,digest:this.k.digest}).catch(e=>({status:'fehler',fehlercode:(e as Error).message}));
  const nz=await leseReverseLeserNachzugSchalter(this.pool);
  if(nz.aktiv&&!nz.letzter_fehler){
   const pins=await this.pool.query("SELECT j.id,l.id AS lauf_id,l.eintrag_id,l.einstellungen_revision FROM work_jobs j JOIN reverse_leser_laeufe l ON l.work_job_id=j.id WHERE j.kind='reverse-leser' AND j.capability=$1 AND j.project=$2 AND j.state='pending' AND l.diagnose->>'nachzug'='true' ORDER BY j.created_at,j.id LIMIT $3",
    [LESER_CAPABILITY,PROJEKT,reverseZahl(this.s,'leser_nachzug_block_zeilen')]);
   for(const pin of pins.rows){
    const job=await this.jobs.get(String(pin.id),PROJEKT);if(!job||job.state!=='pending')continue;
    const s=await leseReverseEinstellwerte({eintrag_id:String(pin.eintrag_id)},this.pool);if(s.letzter_fehler)continue;
    const code=!await reverseEintragAktiv(this.pool,String(pin.eintrag_id))?'leser_eintrag_inaktiv':
     !await reverseLeserNachzugFreigegeben(this.pool,job.id)||s.revision!==pin.einstellungen_revision?'leser_einstellungen_geaendert':
     !await this.lauf(job)?'leser_quellstand_oder_revision_geaendert':null;
    if(code)await this.fehlerAbschliessen(job,String(pin.lauf_id),s,code,{physisches_ende:true,keine_neue_ausgabe:true},null);
   }
  }
  const rows=await this.pool.query("SELECT j.id FROM work_jobs j JOIN reverse_leser_laeufe l ON l.work_job_id=j.id WHERE j.capability=$1 AND j.project=$2 AND j.kind='reverse-leser' AND j.state='pending' AND (j.deadline IS NULL OR j.deadline>clock_timestamp()) AND (l.diagnose->>'nachzug' IS DISTINCT FROM 'true' OR $4) ORDER BY CASE j.priority WHEN 'interaktiv' THEN 0 WHEN 'hintergrund' THEN 1 ELSE 2 END,j.created_at,j.id LIMIT $3",[LESER_CAPABILITY,PROJEKT,reverseZahl(this.s,'leser_nachzug_block_zeilen'),nz.aktiv&&!nz.letzter_fehler]);
  let geweckt=0;
  for(const row of rows.rows){
   if(geweckt>=frei)break;
   const job=await this.jobs.get(String(row.id),PROJEKT),l=job?await this.lauf(job):null;
   if(!l||job?.priority==='nachzug'&&await reverseLeserProjektarbeitVorrang(this.pool))continue;
   if(l?.host_validiert&&['fertig','teilweise'].includes(l.status)){
    // Bereits bestätigter Materialisierungspunkt: kein erneuter Sandboxstart.
    // Veralteten pending-Kopf terminal abschließen; unveränderten Lauf anschließend claimen.
    await this.veraltetenJobAbschliessen(String(row.id));continue;
   }
   try{
    const s=await leseReverseEinstellwerte({eintrag_id:l.eintrag_id},this.pool);
    if(s.letzter_fehler)fail(s.letzter_fehler);
    await this.runtime(s,l); // schlechte Pins vor wake terminalisieren: kein haengender Pending-Kopf
    await lc.wake(LESER_TOOL,PROJEKT,String(row.id));geweckt++;
   }catch(e){
    const code=(e as Error).message;
    if(code==='leser_einstellungen_veraendert')await this.veraltetenJobAbschliessen(String(row.id));
    else if(code.startsWith('leser_runtime_')||code.startsWith('leser_laufzeit_'))await this.veraltetenJobAbschliessen(String(row.id),code);
    else throw e;
   }
  }
  const claims=await this.jobs.claim(this.wer,{limit:frei,leaseSeconds:reverseZahl(this.s,'executor_lease_s')});
  const wer=this.wer;
  for(const job of claims){
   const p=this.ausfuehren(lc,wer,job).catch(e=>console.error('[reverse-leser]',job.id,(e as Error).message))
    .finally(()=>{this.laufend.delete(job.id);this.vorbereitet.delete(job.id);});
   this.laufend.set(job.id,p);
  }
  return {gestartet:claims.length,nachzug};
 }
 private async fence(c:PoolClient,job:WorkJob,wer:WorkIdentity){
  const r=await c.query("SELECT 1 FROM work_jobs WHERE id=$1 AND state='leased' AND claim_token=$2 AND owner_node=$3 AND boot_generation=$4 AND owner_auth_hash=$5 AND lease_until>clock_timestamp() AND (deadline IS NULL OR deadline>clock_timestamp()) FOR UPDATE",
   [job.id,job.claimToken,wer.nodeId,wer.bootGeneration,wer.authHash]);
  if(!r.rows.length||!await this.lauf(job,c,true))fail('leser_job_fenced');
 }
 private async ausfuehren(lc:ToolLifecycle,wer:WorkIdentity,job:WorkJob){
  const v=this.vorbereitet.get(job.id);
  if(!v){
   // Wiederanlauf genau am neuen Materialisierungspunkt: Host-Validierung/physisches Ende
   // sind bereits bestätigt. Niemals Sandbox/Leser erneut starten oder den Cursor ersetzen.
   const l=await this.lauf(job);
   const saved=l?(await this.pool.query("SELECT manifest_sha256,diagnose FROM reverse_leser_laeufe WHERE id=$1 AND status IN('fertig','teilweise') AND diagnose->>'host_validiert'='true'",[l.id])).rows[0]:null;
   if(!l||!saved)fail('leser_mountbindung_fehlt');
   const s=await leseReverseEinstellwerte({eintrag_id:l.eintrag_id},this.pool);
   try{
    if(s.letzter_fehler)fail(s.letzter_fehler);
    if(s.revision!==l.einstellungen_revision)fail('leser_einstellungen_geaendert');
    if(!l.testmodus)await materialisiereReverseLeser(this.pool,{lauf_id:l.id,root:this.k.reverseRoot,fence:c=>this.fence(c,job,wer)});
    const out={scope:'reverse-leser',id:l.id,revision:l.datei_id,sha256:String(saved.manifest_sha256)};
    if(!await this.jobs.stage(wer,job.id,job.claimToken!,out)||!(await this.jobs.complete(wer,job.id,job.claimToken!,job.inputRef)).completed)fail('leser_publikation_fenced');
   }catch(e){
    const code=(e as Error).message.startsWith('leser_')?(e as Error).message:'leser_materialisierung_fehlgeschlagen';
    await this.fehlerAbschliessen(job,l.id,s,code,{physisches_ende:true,fortsetzung_materialisierung:true,einstellungen_revision_alt:l.einstellungen_revision,einstellungen_revision_aktuell:s.revision},null,wer);
    throw e;
   }
   return;
  }
  const {s,lauf:l,r}=v,budget=reverseLeserSchrittBudget(r.manifest,s),token=job.claimToken!;
  let verloren=false,erneuert=false,physischBeendet=false;
  const timer=setInterval(()=>{
   if(erneuert)return;erneuert=true;
   void this.jobs.renew(wer,job.id,token,reverseZahl(s,'executor_lease_s')).then(ok=>{if(!ok)verloren=true;},()=>{verloren=true;})
    .finally(()=>{erneuert=false;if(verloren)void this.stop(lc,job.id).then(()=>{physischBeendet=true;},()=>{});});
  },Math.max(reverseZahl(s,'executor_renew_min_ms'),Math.floor(reverseZahl(s,'executor_lease_s')*1000/3)));
  timer.unref();
  const harteMs=Math.max(1,Math.min(Number(budget.zeit_ms)+reverseZahl(s,'hart_puffer_s')*1000,
   job.deadline?Date.parse(job.deadline)-Date.now():Infinity));
  const hart=setTimeout(()=>{if(!physischBeendet){verloren=true;void this.stop(lc,job.id).then(()=>{physischBeendet=true;},()=>{});}},harteMs);
  hart.unref();
  try{
   const antwort=await lc.execute(LESER_TOOL,PROJEKT,job.id,wer,token,async()=>{
    if(!await this.lauf(job))fail('leser_aus');
    return {kommando:'leser_ausfuehren',leser_entrypoint:r.manifest.entrypoint,
     leser_eingabe:{schnittstelle_version:1,eintrag_id:l.eintrag_id,datei_id:l.datei_id,quell_sha256:l.quell_sha256,groesse:l.groesse,
      leser_revision:r.id,code_sha256:r.code_sha256,generation:l.generation,eingabe:'/eingabe',ausgabe:'/arbeit',
      einstellungen_revision:s.revision,cursor:null},
     leser_grenzen:{...budget,cpu:String(reverseZahl(s,'e_cpu')),datei_bytes:String(reverseBigInt(s,'max_datei_bytes')),
      protokoll_bytes:String(reverseBigInt(s,'runner_output_bytes')),zeile_bytes:String(reverseBigInt(s,'e_metadaten_record_bytes')),
      eingabe_bytes:String(reverseBigInt(s,'runner_input_bytes')),lese_bytes:String(reverseZahl(s,'lese_block_bytes')),
      tiefe:String(reverseZahl(s,'pfad_tiefe_max')),poll_ms:String(reverseZahl(s,'guard_intervall_ms')),wait_ms:String(reverseZahl(s,'prozess_wait_ms'))}};
   });
   await this.stop(lc,job.id);physischBeendet=true;
   if(verloren)fail('leser_lease_verloren');
   const result=await pruefeLeserAusgabe(v.ausgabe,s,r.manifest,l.groesse,antwort);
   const c=await this.pool.connect();
   try{
    await c.query('BEGIN');await this.fence(c,job,wer);
    const params=[l.id,l.eintrag_id,job.id,result.status,v.key+'/'+PROTOKOLL,result.manifest.sha256,result.objekte,result.bytes,result.offen,result.grund,result.cursor];
    if(BigInt(Buffer.byteLength(JSON.stringify(params)))>reverseBigInt(s,'materialisierung_tx_bytes'))fail('leser_checkpoint_tx_zu_gross');
    const upd=await c.query("UPDATE reverse_leser_laeufe SET status=$4,manifest_key=$5,manifest_sha256=$6,ausgabe_anzahl=$7::bigint,ausgabe_bytes=$8::bigint,offen=$9::bigint,fehlercode=$10,cursor_key=NULL,diagnose=diagnose||jsonb_build_object('cursor',$11::text,'host_validiert',true),beendet_at=clock_timestamp() WHERE id=$1 AND eintrag_id=$2 AND work_job_id=$3 AND status IN('offen','laeuft')",params);
    if(upd.rowCount!==1)fail('leser_generation_bereits_abgeschlossen');
    await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
   if(!l.testmodus)await materialisiereReverseLeser(this.pool,{
    lauf_id:l.id,root:this.k.reverseRoot,fence:c=>this.fence(c,job,wer),
   });
   const out={scope:'reverse-leser',id:l.id,revision:l.datei_id,sha256:result.manifest.sha256};
   if(!await this.jobs.stage(wer,job.id,token,out)||!(await this.jobs.complete(wer,job.id,token,job.inputRef)).completed)fail('leser_publikation_fenced');
  }catch(e){
   await this.stop(lc,job.id).then(()=>{physischBeendet=true;},()=>{});
   const code=(e as Error).message.startsWith('leser_')?(e as Error).message:'leser_ausfuehrung_fehlgeschlagen';
   let rueckhaltBytes:string|null=null;
   if(physischBeendet)try{
    rueckhaltBytes=String((await baum(v.ausgabe,s,BigInt(budget.dateien)+1n,BigInt(budget.bytes)+reverseBigInt(s,'runner_output_bytes'))).bytes);
   }catch{/* Kein erfundener Messwert bei Symlink, überschrittenem Budget oder unlesbarem Baum. */}
   await this.fehlerAbschliessen(job,l.id,s,code,{
    ausgabe_key:v.key,physisches_ende:physischBeendet,ausgabe_bytes_bekannt:rueckhaltBytes!==null,
   },rueckhaltBytes,wer);
   throw e;
  }finally{clearInterval(timer);clearTimeout(hart);}
 }
 private async stop(lc:ToolLifecycle,id:string){
  await lc.neustart(LESER_TOOL,PROJEKT,id);
  const status=await lc.status(LESER_TOOL,PROJEKT,id);
  if(status.status!=='cold'||status.container_id!==null)fail('leser_stop_unbestaetigt');
 }
 async beende(){this.beendet=true;await Promise.allSettled([...this.laufend.values()]);}
}
