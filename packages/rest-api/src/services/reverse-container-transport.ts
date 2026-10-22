/** P18-T105: eigener Transport nur für Reverse; allgemeiner Dockeradapter bleibt unverändert. */
import Docker from 'dockerode';
import {PassThrough,type Duplex} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {realpath,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {ToolDescriptor} from '@synapse/core';
import type {ToolContainerExecutor,ToolInstanceContext,ToolObservation} from './tool-lifecycle.js';
import {DockerToolContainerExecutor,buildToolContainerOptions,type ResolvedToolMount} from './tool-container-docker.js';

export interface ReverseContainerBinding {
 instance_id:string;generation:string;container_id:string|null;tool_id:string;project:string;job_id?:string;attempt?:number;image?:string;descriptor_hash?:string;
}
export const reverseContainerTool=(tool:string,project:string)=>project==='reverse-bibliothek'&&(tool==='reverse-e'||tool==='reverse-leser');
const ungesendet=new WeakMap<Error,Readonly<ReverseContainerBinding>>();
function nichtGesendet(binding:ReverseContainerBinding,code:string):Error{
 const e=Error(code);ungesendet.set(e,Object.freeze({...binding}));return e;
}
/** Untrusted Fehlertext/JSON kann diesen Herkunftsbeleg nicht erzeugen. */
export function reverseNichtGesendet(e:unknown):Readonly<ReverseContainerBinding>|null{
 return e instanceof Error?ungesendet.get(e)??null:null;
}
export class ReverseEntfernungAusstehend extends Error {
 constructor(readonly containerId:string){super('reverse_container_entfernung_ausstehend');}
}
export function istRemoval409(e:unknown):boolean{
 const x=e as {statusCode?:number;message?:string;json?:{message?:string}};
 return x?.statusCode===409&&/removal (?:of container .* )?(?:is )?(?:already )?in progress|container .* is being removed/i.test(String(x.json?.message??x.message??''));
}
interface Session {
 binding:ReverseContainerBinding;stream:Duplex;tail:Promise<void>;buffer:string;maxFrameBytes:number;
 current?:{resolve:(r:Record<string,unknown>)=>void;reject:(e:Error)=>void;finish:()=>void;bytes:number;maxBytes:number;terminal?:()=>void;zwischen?:(r:Record<string,unknown>)=>void};
}
const TERMINAL=new Set(['ok','fertig','completed','failed','fehler','teilweise','error']);
class ReverseDockerSessionExecutor implements ToolContainerExecutor {
 private readonly docker:Docker;private readonly sessions=new Map<string,Session>();
 /** lokaleImages (P18-T59): lokal gebaute Images ohne RepoDigests per Image-ID starten, vorher Id und Name/Tag prüfen. */
 constructor(private readonly cfg:{docker?:Docker;socketPath?:string;resolveMounts?:(d:ToolDescriptor,c:ToolInstanceContext)=>Promise<ResolvedToolMount[]>;gpuProbe?:(id:string)=>Promise<number|null>;lokaleImages?:boolean;binding:(id:string,jobId?:string)=>Promise<ReverseContainerBinding|null>;stopSeconds:()=>Promise<number>}){
  this.docker=cfg.docker??new Docker({socketPath:cfg.socketPath??'/var/run/docker.sock'});
 }
 async start(d:ToolDescriptor,ctx:ToolInstanceContext){
  const mounts=await (this.cfg.resolveMounts?.(d,ctx)??Promise.resolve([]));
  for(const m of mounts){const actual=await realpath(m.source),root=await realpath(m.root);
   if(actual!==resolve(m.source)||root!==resolve(m.root)||(!(await lstat(actual)).isDirectory()&&!(await lstat(actual)).isFile()))throw Error('tool_mount_symlink');
  }
  const options=buildToolContainerOptions(d,ctx,mounts),start=performance.now();
  // 'name@sha256:' löst Docker für lokal gebaute Images nicht auf; Referenz dann = geprüfte Image-ID.
  if(this.cfg.lokaleImages){await this.pruefeLokalesImage(d);options.Image=d.digest;}
  if(!await ctx.isCurrent())throw Error('tool_start_fenced');
  let container:Docker.Container;
  try{container=await this.docker.createContainer(options);}
  catch(e){if((e as {statusCode?:number}).statusCode!==409)throw e;container=this.docker.getContainer(ctx.name);
   const old=await container.inspect();if(old.Config.Labels?.['synapse.generation']!==ctx.generation||old.Config.Labels?.['synapse.instance']!==ctx.instance_id||old.Config.Labels?.['synapse.tool']!==d.tool_id||old.Config.Image!==options.Image)throw Error('tool_container_foreign');}
  try{
   if(!await ctx.isCurrent())throw Error('tool_start_fenced');
   const stream=await container.attach({stream:true,stdin:true,stdout:true,stderr:true,hijack:true}) as unknown as Duplex;
   this.attach(container.id,stream,d.limits.output_bytes,{instance_id:ctx.instance_id,generation:ctx.generation,container_id:container.id,tool_id:d.tool_id,project:ctx.project});
   try{await container.start();}catch(e){if((e as {statusCode?:number}).statusCode!==304)throw e;}
   const state=await container.inspect();if(!state.State.Running||!this.sessions.has(container.id)||!await ctx.isCurrent())throw Error('tool_start_unconfirmed');
   const elapsed=Math.ceil(performance.now()-start);if(elapsed>d.lifecycle.start_timeout_ms)throw Error('tool_start_deadline');
   return {id:container.id,coldstart_ms:elapsed};
  }catch(e){
   // Der Lifecycle beobachtet/stoppt exakt diesen generationsgebundenen Namen; nie force-remove fremder Container.
   throw e;
  }
 }
 /** Id muss exakt dem Descriptor-Digest entsprechen und ein RepoTag zum Descriptor-Namen passen. */
 private async pruefeLokalesImage(d:ToolDescriptor):Promise<void>{
  let info:{Id?:string;RepoTags?:string[]|null};
  try{info=await this.docker.getImage(d.digest).inspect();}catch{throw Error('tool_image_mismatch');}
  const tags=info.RepoTags??[],mitTag=/:[^/]+$/.test(d.image);
  if(info.Id!==d.digest||!tags.some(t=>mitTag?t===d.image:t.startsWith(d.image+':')))throw Error('tool_image_mismatch');
 }
 ready(b:ReverseContainerBinding):boolean{const s=b.container_id?this.sessions.get(b.container_id):undefined;return !!s&&!s.stream.destroyed&&s.stream.writable&&s.binding.instance_id===b.instance_id&&s.binding.generation===b.generation;}
 private attach(id:string,stream:Duplex,maxFrameBytes:number,binding:ReverseContainerBinding){
  const out=new PassThrough(),err=new PassThrough(),decoder=new StringDecoder('utf8');
  const session:Session={binding,stream,tail:Promise.resolve(),buffer:'',maxFrameBytes};this.sessions.set(id,session);
  this.docker.modem.demuxStream(stream,out,err);
  out.on('data',(chunk:Buffer)=>{
   session.buffer+=decoder.write(chunk);
   if(Buffer.byteLength(session.buffer)>session.maxFrameBytes){session.current?.reject(Error('tool_runner_frame_limit'));stream.destroy();return;}
   let end:number;while((end=session.buffer.indexOf('\n'))>=0){
    const line=session.buffer.slice(0,end);session.buffer=session.buffer.slice(end+1);if(!line.trim())continue;
    const current=session.current;if(!current)continue;
    current.bytes+=Buffer.byteLength(line);
    if(current.bytes>current.maxBytes)current.reject(Error('tool_output_limit'));
    let response:Record<string,unknown>;try{response=JSON.parse(line);}catch{current.reject(Error('tool_runner_invalid_json'));continue;}
    if(!response||typeof response!=='object'||Array.isArray(response)){current.reject(Error('tool_runner_invalid_json'));continue;}
    if(TERMINAL.has(String(response.status))){current.terminal?.();current.resolve(response);current.finish();session.current=undefined;}
    // P18-T85: nicht-terminale Zeilen (Live-Fortschritt) nur weiterreichen; ein Fehler dort stoert den Lauf nie.
    else if(current.zwischen){try{current.zwischen(response);}catch{/* nur Anzeige */}}
   }
  });
  err.on('data',()=>{}); // Keine unmaskierten Nutzdaten in Logs.
  const end=()=>{session.current?.reject(Error('tool_runner_disconnected'));session.current?.finish();if(this.sessions.get(id)===session)this.sessions.delete(id);};
  stream.on('end',end);stream.on('error',end);stream.on('close',end);
 }
 async command(id:string,request:Record<string,unknown>,timeoutMs:number,maxBytes:number,onTerminal?:()=>void,maxInputBytes=65536,onZwischen?:(response:Record<string,unknown>)=>void):Promise<Record<string,unknown>>{
  const binding=await this.cfg.binding(id,String(request.auftrag_id??''));
  if(!binding?.job_id||binding.attempt===undefined)throw Error('reverse_transport_binding');
  const session=this.sessions.get(id);
  if(!session||!this.ready(binding))throw nichtGesendet(binding,'reverse_runner_nicht_angebunden');
  const previous=session.tail;let unlock!:()=>void;session.tail=new Promise<void>(r=>{unlock=r;});
  await previous;
  if(this.sessions.get(id)!==session||!this.ready(binding)){unlock();throw nichtGesendet(binding,'reverse_runner_nicht_angebunden');}
  let serialized:string;
  try{serialized=JSON.stringify(request)+'\n';}catch(e){unlock();throw e;}
  if(Buffer.byteLength(serialized)>maxInputBytes){unlock();throw nichtGesendet(binding,'tool_input_limit');}
  return new Promise((resolve,reject)=>{
   let settled=false;
   const timer=setTimeout(()=>bad(Error('tool_runner_timeout')),timeoutMs);
   const ok=(response:Record<string,unknown>)=>{if(!settled){settled=true;clearTimeout(timer);resolve(response);}};
   const bad=(e:Error)=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}};
   session.current={resolve:ok,reject:bad,finish:()=>{clearTimeout(timer);unlock();},bytes:0,maxBytes,terminal:onTerminal,zwischen:onZwischen};
   // Ab diesem Aufruf ist auch ein synchroner Fehler KEIN NichtGesendet-Beweis.
   try{session.stream.write(serialized);}catch(e){bad(e instanceof Error?e:Error(String(e)));}
  });
 }
 private async inspect(id:string):Promise<Docker.ContainerInspectInfo|null>{
  const b=await this.cfg.binding(id);if(!b)throw Error('reverse_transport_binding');
  let info:Docker.ContainerInspectInfo;
  try{info=await this.docker.getContainer(id).inspect();}catch(e){if((e as {statusCode?:number}).statusCode===404)return null;throw e;}
  const labels=info.Config.Labels;
  if(labels?.['synapse.instance']!==b.instance_id||labels?.['synapse.generation']!==b.generation||labels?.['synapse.tool']!==b.tool_id||b.image&&info.Config.Image!==b.image&&!info.Config.Image.endsWith('@'+b.image))throw Error('reverse_container_foreign');
  return info;
 }
 async observe(id:string):Promise<ToolObservation>{
  const container=this.docker.getContainer(id);
  const state=await this.inspect(id);
  if(!state)return {container_id:id,running:false,cpu_percent:null,gpu_percent:null,measured_at:new Date().toISOString()};
  const startObserved=Number.isFinite(Date.parse(state.State.StartedAt))&&Date.parse(state.State.StartedAt)>0;
  if(!state.State.Running)return {container_id:id,running:false,cpu_percent:null,gpu_percent:null,measured_at:new Date().toISOString(),start_observed:startObserved};
  const stats=await container.stats({stream:false}) as unknown as {read:string;cpu_stats:{cpu_usage:{total_usage:number};system_cpu_usage:number;online_cpus:number};precpu_stats:{cpu_usage:{total_usage:number};system_cpu_usage:number}};
  const used=stats.cpu_stats.cpu_usage.total_usage-stats.precpu_stats.cpu_usage.total_usage;
  const system=stats.cpu_stats.system_cpu_usage-stats.precpu_stats.system_cpu_usage;
  const cpu=system>0&&used>=0?100*used/system*stats.cpu_stats.online_cpus:null;
  return {container_id:id,running:true,cpu_percent:cpu,gpu_percent:await(this.cfg.gpuProbe?.(id)??Promise.resolve(null)),measured_at:stats.read,start_observed:startObserved};
 }
 async cleanup(id:string):Promise<void>{
  const sample=await this.observe(id);if(sample.running)throw Error('tool_cleanup_running');
  try{await this.docker.getContainer(id).remove();}catch(e){if((e as {statusCode?:number}).statusCode!==404)throw e;}
 }
 async stop(id:string):Promise<void>{
  const container=this.docker.getContainer(id);
  const state=await this.inspect(id);
  const seconds=await this.cfg.stopSeconds();if(!Number.isSafeInteger(seconds)||seconds<1)throw Error('reverse_stop_budget');
  try{if(state)await container.stop({t:seconds});}catch(e){if(![304,404].includes((e as {statusCode?:number}).statusCode??0))throw e;}
  const sample=await this.observe(id);if(sample.running)throw Error('tool_stop_unconfirmed');
  this.sessions.get(id)?.stream.destroy();this.sessions.delete(id);
  try{await container.remove();}catch(e){if((e as {statusCode?:number}).statusCode!==404)throw e;}
 }
}

/** Nur positiv zugeordnete Nicht-Reverse-Instanzen werden an den unveränderten Adapter delegiert. */
export class ReverseContainerTransport implements ToolContainerExecutor {
 private readonly own:ReverseDockerSessionExecutor;
 private readonly other:DockerToolContainerExecutor;
 private readonly docker:Docker;
 // Ein erfolgreicher Start ist ein positiver Herkunftsbeleg, null aus PG ist keiner.
 private readonly started=new Map<string,{reverse:boolean;instance:string;generation:string;tool:string}>();
 constructor(private readonly cfg:{
  docker?:Docker;socketPath?:string;resolveMounts?:(d:ToolDescriptor,c:ToolInstanceContext)=>Promise<ResolvedToolMount[]>;
  lokaleImages?:boolean;binding:(id:string,jobId?:string)=>Promise<ReverseContainerBinding|null>;stopSeconds:()=>Promise<number>;
 }){
  this.docker=cfg.docker??new Docker({socketPath:cfg.socketPath??'/var/run/docker.sock'});
  this.own=new ReverseDockerSessionExecutor({...cfg,docker:this.docker});this.other=new DockerToolContainerExecutor({...cfg,docker:this.docker});
 }
 ready(binding:ReverseContainerBinding){return this.own.ready(binding);}
 async start(d:ToolDescriptor,c:ToolInstanceContext){
  const reverse=reverseContainerTool(d.tool_id,c.project);
  const result=await (reverse?this.own.start(d,c):this.other.start(d,c));
  this.started.set(result.id,{reverse,instance:c.instance_id,generation:c.generation,tool:d.tool_id});
  return result;
 }
 private async owned(id:string){
  const b=await this.cfg.binding(id),known=this.started.get(id);
  if(b){
   if(b.container_id!==id||!reverseContainerTool(b.tool_id,b.project)||known&&!known.reverse)throw Error('reverse_container_foreign');
   return true;
  }
  // Bekannter Reverse-Start mit verlorener Bindung UND unbekannte IDs bleiben gesperrt.
  // Auch ein Container eines fremden Reverse-Laufs darf nie im generischen Stop landen.
  if(!known||known.reverse)throw Error('reverse_container_binding_fehlt');
  try{
   const state=await this.docker.getContainer(id).inspect(),labels=state.Config.Labels;
   if(labels?.['synapse.instance']!==known.instance||labels?.['synapse.generation']!==known.generation||
    labels?.['synapse.tool']!==known.tool)throw Error('reverse_container_foreign');
  }catch(e){if((e as {statusCode?:number}).statusCode!==404)throw e;}
  return false;
 }
 async observe(id:string){return await this.owned(id)?this.own.observe(id):this.other.observe(id);}
 async stop(id:string){
  if(!await this.owned(id))return this.other.stop(id);
  try{await this.own.stop(id);}catch(e){if(istRemoval409(e))throw new ReverseEntfernungAusstehend(id);throw e;}
 }
 async cleanup(id:string){
  if(!await this.owned(id))return this.other.cleanup(id);
  try{await this.own.cleanup(id);}catch(e){if(istRemoval409(e))throw new ReverseEntfernungAusstehend(id);throw e;}
 }
 async command(...a:Parameters<ToolContainerExecutor['command']>){
  return await this.owned(a[0])?this.own.command(...a):this.other.command(...a);
 }
}
