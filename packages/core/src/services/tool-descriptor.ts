/** R5.1: serverseitiger deklarativer Vertrag, niemals Client-GPU/Shell-Selbstfreigabe. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {toolAktivitaetRetentionTage} from './tool-aktivitaet.js';
export interface ToolDescriptor {
 tool_id:string; tool:string; capability:string; image:string; digest:string;
 instance_scope:'project'|'job'; command?:string[];
 network:'none'|'configured'; network_name?:string; allow_project_share:boolean;
 mounts:Array<{role:string;target:string;write:boolean;project_share?:boolean;job_only?:boolean}>;
 resource_domain?:string; gpu_driver?:string; gpu_device_ids?:string[];
 resources:{cpu:number;ram:number;vram:number;gpu:boolean;pids:number;tmpfs:number;concurrency:number};
 limits:{time_ms:number;output_bytes:number;input_bytes:number};
 lifecycle:{idle_ms:number;activity_lookback_seconds:number;cpu_idle_percent:number;gpu_idle_percent:number;measurement_max_age_ms:number;start_timeout_ms:number;max_starts:number;start_window_ms:number;pause_ms:number};
}
export interface ToolControlAuthority {role:'user'|'koordinator';authenticated:true}
export const TOOL_CONTAINER_LOCK='tool-lifecycle-capacity';
function bad():never {throw Error('invalid_tool_descriptor');}
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(v);
function keys(v:Record<string,unknown>,allowed:string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))bad();}
function positive(v:unknown,integer=false){if(typeof v!=='number'||!Number.isFinite(v)||v<=0||(integer&&!Number.isSafeInteger(v)))bad();}
export function validateToolDescriptor(v:unknown):ToolDescriptor {
 if(!obj(v))bad();
 keys(v,['tool_id','tool','capability','image','digest','instance_scope','command','network','network_name','allow_project_share','mounts','resource_domain','gpu_driver','gpu_device_ids','resources','limits','lifecycle']);
 if(!id(v.tool_id)||!id(v.tool)||!id(v.capability)||typeof v.image!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(v.image)||v.image.includes('@')||
 typeof v.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v.digest))bad();
 if(v.instance_scope!==undefined&&!['project','job'].includes(String(v.instance_scope)))bad();
 const network=v.network??'none';
 if(!['none','configured'].includes(String(network))||(network==='configured'&&!id(v.network_name)))bad();
 if(v.allow_project_share!==undefined&&typeof v.allow_project_share!=='boolean')bad();
 if(v.command!==undefined&&(!Array.isArray(v.command)||!v.command.length||v.command.some(x=>typeof x!=='string'||!x||x.includes('\0'))))bad();
 if(!Array.isArray(v.mounts))bad();
 const targets=new Set<string>();
 for(const m of v.mounts){
  if(!obj(m))bad();keys(m,['role','target','write','project_share','job_only']);
  if(!id(m.role)||typeof m.target!=='string'||!/^\/[a-zA-Z0-9_/-]+$/.test(m.target)||m.target==='/'||m.target.split('/').includes('..')||
   m.target.startsWith('/var/run')||typeof m.write!=='boolean'||targets.has(m.target)||
   (m.project_share!==undefined&&typeof m.project_share!=='boolean')||(m.project_share===true&&v.allow_project_share!==true)||
   (m.job_only!==undefined&&typeof m.job_only!=='boolean'))bad();
  targets.add(m.target);
 }
 if(!obj(v.resources)||!obj(v.limits)||!obj(v.lifecycle))bad();
 keys(v.resources,['cpu','ram','vram','gpu','pids','tmpfs','concurrency']);
 keys(v.limits,['time_ms','output_bytes','input_bytes']);
 keys(v.lifecycle,['idle_ms','activity_lookback_seconds','cpu_idle_percent','gpu_idle_percent','measurement_max_age_ms','start_timeout_ms','max_starts','start_window_ms','pause_ms']);
 for(const k of ['cpu','ram','pids','tmpfs','concurrency'])positive(v.resources[k],k!=='cpu');
 if(typeof v.resources.gpu!=='boolean'||typeof v.resources.vram!=='number'||!Number.isSafeInteger(v.resources.vram)||v.resources.vram<0||(!v.resources.gpu&&v.resources.vram!==0))bad();
 if(v.resources.gpu&&(!id(v.gpu_driver)||!id(v.resource_domain)||!Array.isArray(v.gpu_device_ids)||!v.gpu_device_ids.length||v.gpu_device_ids.some(x=>!id(x))))bad();
 for(const k of ['time_ms','output_bytes','input_bytes'])positive(v.limits[k],true);
 for(const k of ['idle_ms','activity_lookback_seconds','measurement_max_age_ms','start_timeout_ms','max_starts','start_window_ms','pause_ms'])positive(v.lifecycle[k],true);
 for(const k of ['cpu_idle_percent','gpu_idle_percent'])if(typeof v.lifecycle[k]!=='number'||!Number.isFinite(v.lifecycle[k])||v.lifecycle[k]<0||v.lifecycle[k]>100)bad();
 if((v.lifecycle.activity_lookback_seconds as number)>toolAktivitaetRetentionTage()*86400)bad();
 return JSON.parse(JSON.stringify({...v,instance_scope:v.instance_scope??'project',network,allow_project_share:v.allow_project_share??false})) as ToolDescriptor;
}
export function toolDescriptorHash(d:ToolDescriptor):string {
 const sorted=(v:unknown):unknown=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sorted(x)])):v;
 return createHash('sha256').update(JSON.stringify(sorted(d))).digest('hex');
}
type Db=Pick<Pool,'query'|'connect'>;
function authority(a:ToolControlAuthority){if(a?.authenticated!==true||!['user','koordinator'].includes(a.role))throw Error('tool_control_forbidden');}
export async function registerToolDescriptor(db:Db,value:unknown,a:ToolControlAuthority):Promise<void>{
 authority(a);const d=validateToolDescriptor(value),hash=toolDescriptorHash(d);
 const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[TOOL_CONTAINER_LOCK]);
 const active=await c.query("SELECT 1 FROM tool_containers WHERE tool_id=$1 AND state NOT IN('cold','blocked')",[d.tool_id]);
 const previous=await c.query('SELECT descriptor_hash FROM tool_descriptors WHERE tool_id=$1',[d.tool_id]);
 if(active.rows.length&&previous.rows[0]?.descriptor_hash!==hash)throw Error('tool_descriptor_in_use');
 await c.query(`INSERT INTO tool_descriptors(tool_id,capability,descriptor,descriptor_hash) VALUES($1,$2,$3,$4)
 ON CONFLICT(tool_id) DO UPDATE SET capability=EXCLUDED.capability,descriptor=EXCLUDED.descriptor,descriptor_hash=EXCLUDED.descriptor_hash,updated_at=NOW()`,[d.tool_id,d.capability,d,hash]);
 await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function setToolActivation(db:Db,toolId:string,project:string|null,enabled:boolean,a:ToolControlAuthority):Promise<void>{
 authority(a);if(!id(toolId)||(project!==null&&!id(project))||typeof enabled!=='boolean')bad();
 const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[TOOL_CONTAINER_LOCK]);
 if(project===null){const r=await c.query('UPDATE tool_descriptors SET enabled=$2,updated_at=NOW() WHERE tool_id=$1',[toolId,enabled]);if(!r.rowCount)throw Error('unknown_tool_descriptor');}
 else await c.query(`INSERT INTO tool_activation(tool_id,project,enabled,updated_by) VALUES($1,$2,$3,$4)
 ON CONFLICT(tool_id,project) DO UPDATE SET enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[toolId,project,enabled,a.role]);
 await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
