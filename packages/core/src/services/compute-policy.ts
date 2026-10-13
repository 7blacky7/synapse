/**
 * P20-T12/T9: Beobachtung, Userpolicy, Empfehlung und Entscheidung bleiben getrennt.
 * PG-only, keine fremden Geräte steuern, kein HTTP/FS/Docker unter Policylocks.
 * Neues Verhalten aktiviert SYNAPSE_COMPUTE_POLICY_ENABLED=1; Legacy-Claims sonst unverändert.
 */
import {getPool} from '../db/client.js';
import type {ApiContract} from '../vertrag/api-vertrag.js';
type PolicyRevision=NonNullable<ApiContract['policyRevision']>;
import {computeResourceBinding,computeResourceSnapshot,type ComputeResources,type ComputeCapability} from '../vertrag/compute-ressourcen.js';

type Result<T>={rows:T[];rowCount?:number|null};
export interface ComputePolicyDb {
  query<T extends Record<string,unknown> = Record<string,unknown>>(sql:string,values?:unknown[]):Promise<Result<T>>;
  connect?:()=>Promise<{query:ComputePolicyDb['query'];release():void}>;
}
export interface ComputePolicy {
  nodeId:string;ausfuehrungsfreigabe:boolean;modus:'automatik'|'manuell';
  faehigkeit_schalter:Record<string,boolean>;usersperre:Record<string,boolean>;policyRevision:PolicyRevision;
}
export interface ComputeProjectPolicy {project:string;pc_gpu_ausgeschlossen:boolean;policyRevision:PolicyRevision}
export interface ComputePolicyPatch {
  ausfuehrungsfreigabe?:boolean;modus?:'automatik'|'manuell';
  faehigkeit_schalter?:Record<string,boolean>;usersperre?:Record<string,boolean>;policyRevision?:PolicyRevision|string;
}
export interface ComputeAllocationInput {
  nodeId:string;project?:string;capability:string;profileId?:string|null;
  profileCompatible:boolean;resourcesAvailable:boolean;
  /** Nur vom API-internen Executor setzen, niemals aus Requestbody. */
  internalServer?:boolean;
}
export interface ComputeRecommendation {empfohlen:boolean;grund:string;zeit:string}
export interface ComputeAllocationDecision {
  allowed:boolean;reason:string;policyRevision:PolicyRevision;recommendation:ComputeRecommendation;
}
interface NodeRow extends Record<string,unknown> {
  node_id:string;letzter_kontakt:Date;status:string;gesperrt_vom_user:boolean;
  modell?:string|null;native_dimension?:number|null;ziel_dimension?:number|null;
  location?:string|null;ressourcen?:ComputeResources|null;capabilities?:ComputeCapability[]|null;
}
interface PolicyRow extends Record<string,unknown> {
  node_id:string;ausfuehrungsfreigabe:boolean;modus:'automatik'|'manuell';
  faehigkeit_schalter:Record<string,boolean>;usersperre:Record<string,boolean>;policy_revision:string;
}
export interface ComputePolicySnapshot {
  policy:ComputePolicy;node:NodeRow|null;now:string;internalServer:boolean;excludedProjects:Set<string>;
}
export class ComputePolicyError extends Error {
  constructor(readonly code:string){super(code);this.name='ComputePolicyError';}
}
const fail=(code:string):never=>{throw new ComputePolicyError(code);};
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
function record(raw:unknown):Record<string,unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('invalid_compute_policy');
  return raw as Record<string,unknown>;
}
function revision(value:unknown):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return String(value);
  if(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value)&&BigInt(value)<=9223372036854775806n)return value;
  return fail('invalid_policy_revision');
}
function switches(raw:unknown):Record<string,boolean>|undefined {
  if(raw===undefined)return undefined;
  const o=record(raw);
  if(Object.entries(o).some(([key,value])=>!key.trim()||key.length>200||typeof value!=='boolean'))fail('invalid_capability_switch');
  return o as Record<string,boolean>;
}
function patch(raw:unknown):ComputePolicyPatch {
  const a=record(raw);
  if(Object.keys(a).some(k=>!['ausfuehrungsfreigabe','modus','faehigkeit_schalter','usersperre','policyRevision'].includes(k))||
    a.ausfuehrungsfreigabe!==undefined&&typeof a.ausfuehrungsfreigabe!=='boolean'||
    a.modus!==undefined&&!['automatik','manuell'].includes(String(a.modus)))fail('invalid_compute_policy');
  return {ausfuehrungsfreigabe:a.ausfuehrungsfreigabe as boolean|undefined,modus:a.modus as ComputePolicyPatch['modus'],
    faehigkeit_schalter:switches(a.faehigkeit_schalter),usersperre:switches(a.usersperre),policyRevision:revision(a.policyRevision)};
}
function storedRevision(raw:unknown):PolicyRevision {
  const n=Number(raw??0);if(!Number.isSafeInteger(n)||n<0)fail('invalid_policy_revision');return n;
}
function view(nodeId:string,row?:PolicyRow):ComputePolicy {
  return {nodeId,ausfuehrungsfreigabe:row?.ausfuehrungsfreigabe??false,modus:row?.modus??'automatik',
    faehigkeit_schalter:row?.faehigkeit_schalter??{},usersperre:row?.usersperre??{},policyRevision:storedRevision(row?.policy_revision)};
}
async function tx<T>(db:ComputePolicyDb,run:(client:ComputePolicyDb)=>Promise<T>):Promise<T>{
  const client=db.connect?await db.connect():db;
  try{await client.query('BEGIN');const r=await run(client);await client.query('COMMIT');return r;}
  catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{if('release' in client)(client as ComputePolicyDb&{release():void}).release();}
}
export function computePolicyAktiv():boolean{return process.env.SYNAPSE_COMPUTE_POLICY_ENABLED==='1';}
/** Read-only Standardpolicy; registriert/aktiviert keinen Helfer. */
export async function leseComputePolicy(nodeId:string,db:ComputePolicyDb=getPool()):Promise<ComputePolicy>{
  if(!validId(nodeId))fail('invalid_node_id');
  const r=await db.query<PolicyRow>('SELECT * FROM compute_node_policy WHERE node_id=$1',[nodeId]);
  return view(nodeId,r.rows[0]);
}
/** Nur berechtigte API-/Tray-Aufrufer dürfen diesen internen Schreibdienst verwenden. */
export async function setzeComputePolicy(nodeId:string,raw:unknown,db:ComputePolicyDb=getPool()):Promise<ComputePolicy>{
  if(!validId(nodeId))fail('invalid_node_id');const a=patch(raw);
  return tx(db,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['compute-policy:'+nodeId]);
    const issued=await c.query<{valid:boolean}>(`SELECT EXISTS(SELECT 1 FROM auth_tokens WHERE kind='service'
      AND scope=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp())) AS valid`,['compute-node:'+nodeId]);
    if(!issued.rows[0]?.valid)fail('node_not_issued');
    const before=await leseComputePolicy(nodeId,c);
    if(before.policyRevision>=Number.MAX_SAFE_INTEGER)fail('policy_revision_exhausted');
    if(a.policyRevision!==undefined&&a.policyRevision!==String(before.policyRevision))fail('policy_revision_conflict');
    const r=await c.query<PolicyRow>(`INSERT INTO compute_node_policy(node_id,ausfuehrungsfreigabe,modus,faehigkeit_schalter,usersperre,policy_revision)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,1) ON CONFLICT(node_id) DO UPDATE SET
      ausfuehrungsfreigabe=$2,modus=$3,faehigkeit_schalter=compute_node_policy.faehigkeit_schalter||$4::jsonb,
      usersperre=compute_node_policy.usersperre||$5::jsonb,policy_revision=compute_node_policy.policy_revision+1,
      aktualisiert_am=clock_timestamp() RETURNING *`,
      [nodeId,a.ausfuehrungsfreigabe??before.ausfuehrungsfreigabe,a.modus??before.modus,
        JSON.stringify(a.faehigkeit_schalter??{}),JSON.stringify(a.usersperre??{})]);
    return view(nodeId,r.rows[0]);
  });
}
export async function leseComputeProjektPolicy(project:string,db:ComputePolicyDb=getPool()):Promise<ComputeProjectPolicy>{
  if(typeof project!=='string'||!project.trim()||project.length>255)fail('invalid_project');
  const r=await db.query<{pc_gpu_ausgeschlossen:boolean;policy_revision:string}>('SELECT * FROM compute_project_policy WHERE project=$1',[project]);
  return {project,pc_gpu_ausgeschlossen:r.rows[0]?.pc_gpu_ausgeschlossen??false,policyRevision:storedRevision(r.rows[0]?.policy_revision)};
}
export async function setzeComputeProjektPolicy(project:string,raw:unknown,db:ComputePolicyDb=getPool()):Promise<ComputeProjectPolicy>{
  const a=record(raw),expected=revision(a.policyRevision);
  if(Object.keys(a).some(k=>!['pc_gpu_ausgeschlossen','policyRevision'].includes(k))||typeof a.pc_gpu_ausgeschlossen!=='boolean')fail('invalid_project_policy');
  return tx(db,async c=>{
    // Shared Lock in ALLEN Zuteilungen verhindert Opt-out-Inserts zwischen Auswahl und Update.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['compute-project-policy']);
    const exists=await c.query<{valid:boolean}>('SELECT EXISTS(SELECT 1 FROM projects WHERE name=$1) AS valid',[project]);
    if(!exists.rows[0]?.valid)fail('project_not_found');
    const before=await leseComputeProjektPolicy(project,c);
    if(before.policyRevision>=Number.MAX_SAFE_INTEGER)fail('policy_revision_exhausted');
    if(expected!==undefined&&String(before.policyRevision)!==expected)fail('policy_revision_conflict');
    await c.query(`INSERT INTO compute_project_policy(project,pc_gpu_ausgeschlossen,policy_revision) VALUES($1,$2,1)
      ON CONFLICT(project) DO UPDATE SET pc_gpu_ausgeschlossen=$2,policy_revision=compute_project_policy.policy_revision+1,
      aktualisiert_am=clock_timestamp()`,[project,a.pc_gpu_ausgeschlossen]);
    return leseComputeProjektPolicy(project,c);
  });
}
/** Claim-Transaktion hält Shared-Policylocks bis zur atomaren Zuteilung. */
export async function ladeComputePolicySnapshot(nodeId:string,db:ComputePolicyDb,internalServer=false):Promise<ComputePolicySnapshot>{
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))',['compute-policy:'+nodeId]);
  await db.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))',['compute-project-policy']);
  const now=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const node=(await db.query<NodeRow>('SELECT * FROM embedding_knoten WHERE node_id=$1 FOR SHARE',[nodeId])).rows[0]??null;
  const binding=computeResourceBinding(nodeId);
  // Standort aus Betreiberbindung, niemals aus einer frei gemeldeten Client-location.
  const internal=internalServer||binding?.location==='unraid';
  const excludedProjects=new Set((await db.query<{project:string}>('SELECT project FROM compute_project_policy WHERE pc_gpu_ausgeschlossen')).rows.map(r=>r.project));
  return {policy:await leseComputePolicy(nodeId,db),node,now,internalServer:internal,excludedProjects};
}
function limit(key:string):number|undefined{
  const raw=process.env[key];if(raw===undefined||raw==='')return undefined;
  const n=Number(raw);if(!Number.isFinite(n)||n<0)fail('invalid_compute_policy_config');return n;
}
function evaluate(input:ComputeAllocationInput,s:ComputePolicySnapshot):ComputeAllocationDecision{
  const p=s.policy,n=s.node;let reason='Zuteilung erlaubt',allowed=true;
  const deny=(why:string)=>{if(allowed){allowed=false;reason=why;}};
  if(p.usersperre[input.capability]===true)deny('Fähigkeit vom Nutzer gesperrt');
  if(n?.gesperrt_vom_user)deny('Knoten vom Nutzer gesperrt');
  if(!s.internalServer&&!p.ausfuehrungsfreigabe)deny('Ausführungsfreigabe fehlt');
  if(!s.internalServer&&input.project&&s.excludedProjects.has(input.project))deny('Projekt ausgeschlossen');
  const observed=input.capability==='embedding'
    ? !!n?.modell&&(n.native_dimension??0)>0&&(n.ziel_dimension??0)>0
    : !!n?.capabilities?.some(c=>c.id===input.capability&&(!input.profileId||c.profileRef.id===input.profileId));
  if(!s.internalServer&&!observed)deny('Fähigkeit nicht beobachtet');
  if(!s.internalServer&&(p.faehigkeit_schalter[input.capability]===false||
    p.modus==='manuell'&&p.faehigkeit_schalter[input.capability]!==true))deny('Fähigkeit nicht freigegeben');
  if(!input.profileCompatible)deny('Profil nicht kompatibel');
  if(!input.resourcesAvailable)deny('Ressourcen nicht verfügbar');
  const freshness=limit('SYNAPSE_COMPUTE_NODE_FRESHNESS_MS')??120000;
  if(!s.internalServer&&(!n||!['ready','busy'].includes(n.status)||
    !Number.isFinite(new Date(n.letzter_kontakt).getTime())||Date.parse(s.now)-new Date(n.letzter_kontakt).getTime()>freshness))deny('Knoten nicht frisch');
  const resources=computeResourceSnapshot(n?.ressourcen,Date.parse(s.now));
  let recommended=allowed,recommendationReason=reason;
  const cpuLimit=limit('SYNAPSE_COMPUTE_MAX_CPU_LOAD_PERCENT'),gpuLimit=limit('SYNAPSE_COMPUTE_MAX_GPU_LOAD_PERCENT');
  const cpu=resources?.cpu.loadPercent;
  if(cpuLimit!==undefined&&(!cpu||cpu.freshness!=='fresh'||cpu.value===null||cpu.value>cpuLimit)){
    recommended=false;recommendationReason='Eigene CPU-Last hoch oder unbekannt';
  }
  if(gpuLimit!==undefined&&(!resources?.gpus.length||resources.gpus.some(g=>g.utilizationPercent.freshness!=='fresh'||
    g.utilizationPercent.value===null||g.utilizationPercent.value>gpuLimit))){
    recommended=false;recommendationReason='Eigene GPU-Last hoch oder unbekannt';
  }
  if(!s.internalServer&&process.env.SYNAPSE_COMPUTE_PC_HELP_NEEDED==='0'){
    recommended=false;recommendationReason='Unraid benötigt aktuell keine PC-Hilfe';
  }
  if(!s.internalServer&&p.modus==='automatik'&&!recommended)deny(recommendationReason);
  return {allowed,reason,policyRevision:p.policyRevision,
    recommendation:{empfohlen:recommended,grund:recommendationReason,zeit:s.now}};
}
export async function pruefeComputeZuteilung(input:ComputeAllocationInput,db:ComputePolicyDb=getPool(),snapshot?:ComputePolicySnapshot):Promise<ComputeAllocationDecision>{
  if(!validId(input.nodeId)||typeof input.capability!=='string'||!input.capability.trim())fail('invalid_compute_allocation');
  return evaluate(input,snapshot??await ladeComputePolicySnapshot(input.nodeId,db,input.internalServer));
}
/** Alle Auswahlzweige erhalten exakt denselben Policy-Snapshot/Projektfilter. */
export async function embeddingComputePolicy(nodeId:string,db:ComputePolicyDb,internalServer=false){
  if(!computePolicyAktiv())return undefined;
  const snapshot=await ladeComputePolicySnapshot(nodeId,db,internalServer);
  const decision=await pruefeComputeZuteilung({nodeId,capability:'embedding',profileCompatible:true,resourcesAvailable:true,internalServer},db,snapshot);
  return {decision,snapshot,excludedProjects:snapshot.internalServer?[]:[...snapshot.excludedProjects]};
}
export async function computePolicyStatus(nodeId:string,project:string|undefined,db:ComputePolicyDb=getPool(),evidence?:{profileCompatible:(capability:string,node:NodeRow|null)=>boolean;resourcesAvailable:(capability:string,node:NodeRow|null)=>boolean}){
  const s=await ladeComputePolicySnapshot(nodeId,db);
  const ids=new Set(['embedding',...s.node?.capabilities?.map(c=>c.id)??[],...Object.keys(s.policy.faehigkeit_schalter),...Object.keys(s.policy.usersperre)]);
  const recommendations:Record<string,ComputeRecommendation>={};
  for(const capability of ids)recommendations[capability]=evaluate({nodeId,project,capability,profileCompatible:evidence?.profileCompatible(capability,s.node)??false,resourcesAvailable:evidence?.resourcesAvailable(capability,s.node)??false},s).recommendation;
  return {policy:s.policy,observedCapabilities:s.node?.capabilities??[],recommendations,registered:!!s.node};
}
