/** Gehärteter Docker/JSON-Lines-Adapter für deklarierte Toolcontainer. */
import Docker from 'dockerode';
import {PassThrough,type Duplex} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {realpath,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import type {ToolDescriptor} from '@synapse/core';
import type {ToolContainerExecutor,ToolInstanceContext,ToolObservation} from './tool-lifecycle.js';
export interface ResolvedToolMount {role:string;source:string;root:string;allowWrite:boolean;allowProjectShare:boolean}
export function buildToolContainerOptions(d:ToolDescriptor,ctx:ToolInstanceContext,mounts:ResolvedToolMount[]):Docker.ContainerCreateOptions {
 const binds:string[]=[];
 for(const m of d.mounts){
  if(m.job_only&&!ctx.job_id)continue;
  const source=mounts.find(x=>x.role===m.role);if(!source||!isAbsolute(source.source)||!isAbsolute(source.root)||
   (m.write&&!source.allowWrite)||(m.project_share&&(!d.allow_project_share||!source.allowProjectShare)))throw Error('tool_mount_forbidden');
  const rel=relative(resolve(source.root),resolve(source.source));
  if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||source.source.includes(':')||
   (m.job_only&&m.write&&!resolve(source.source).split('/').includes(ctx.job_id!)))throw Error('tool_mount_scope');
  binds.push(source.source+':'+m.target+':'+(m.write?'rw':'ro'));
 }
 return {name:ctx.name,Image:d.image+'@'+d.digest,Cmd:d.command,
  Labels:{'synapse.tool':d.tool_id,'synapse.instance':ctx.instance_id,'synapse.generation':ctx.generation},
  User:'65532:65532',Tty:false,OpenStdin:true,StdinOnce:false,AttachStdin:true,AttachStdout:true,AttachStderr:true,
  NetworkDisabled:d.network==='none',
  HostConfig:{NetworkMode:d.network==='none'?'none':d.network_name,ReadonlyRootfs:true,Binds:binds,
   CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],PidsLimit:d.resources.pids,NanoCpus:Math.round(d.resources.cpu*1e9),
   Memory:d.resources.ram*1048576,MemorySwap:d.resources.ram*1048576,
   Tmpfs:{'/tmp':'size='+d.resources.tmpfs+'m,noexec,nosuid,nodev,mode=1777'},AutoRemove:false,RestartPolicy:{Name:'no'},
   ...(d.resources.gpu?{DeviceRequests:[{Driver:d.gpu_driver,Count:0,DeviceIDs:d.gpu_device_ids,Capabilities:[['gpu']]}]}:{})}
 };
}
interface Session {
 stream:Duplex;tail:Promise<void>;buffer:string;maxFrameBytes:number;
 current?:{resolve:(r:Record<string,unknown>)=>void;reject:(e:Error)=>void;finish:()=>void;bytes:number;maxBytes:number;terminal?:()=>void};
}
const TERMINAL=new Set(['ok','fertig','completed','failed','fehler','teilweise','error']);
export class DockerToolContainerExecutor implements ToolContainerExecutor {
 private readonly docker:Docker;private readonly sessions=new Map<string,Session>();
 constructor(private readonly cfg:{docker?:Docker;socketPath?:string;resolveMounts?:(d:ToolDescriptor,c:ToolInstanceContext)=>Promise<ResolvedToolMount[]>;gpuProbe?:(id:string)=>Promise<number|null>}={}){
  this.docker=cfg.docker??new Docker({socketPath:cfg.socketPath??'/var/run/docker.sock'});
 }
 async start(d:ToolDescriptor,ctx:ToolInstanceContext){
  const mounts=await (this.cfg.resolveMounts?.(d,ctx)??Promise.resolve([]));
  for(const m of mounts){const actual=await realpath(m.source),root=await realpath(m.root);
   if(actual!==resolve(m.source)||root!==resolve(m.root)||(!(await lstat(actual)).isDirectory()&&!(await lstat(actual)).isFile()))throw Error('tool_mount_symlink');
  }
  const options=buildToolContainerOptions(d,ctx,mounts),start=performance.now();
  if(!await ctx.isCurrent())throw Error('tool_start_fenced');
  let container:Docker.Container;
  try{container=await this.docker.createContainer(options);}
  catch(e){if((e as {statusCode?:number}).statusCode!==409)throw e;container=this.docker.getContainer(ctx.name);
   const old=await container.inspect();if(old.Config.Labels?.['synapse.generation']!==ctx.generation||old.Config.Image!==options.Image)throw Error('tool_container_foreign');}
  try{
   if(!await ctx.isCurrent())throw Error('tool_start_fenced');
   const stream=await container.attach({stream:true,stdin:true,stdout:true,stderr:true,hijack:true}) as unknown as Duplex;
   this.attach(container.id,stream,d.limits.output_bytes);
   try{await container.start();}catch(e){if((e as {statusCode?:number}).statusCode!==304)throw e;}
   const state=await container.inspect();if(!state.State.Running||!this.sessions.has(container.id)||!await ctx.isCurrent())throw Error('tool_start_unconfirmed');
   const elapsed=Math.ceil(performance.now()-start);if(elapsed>d.lifecycle.start_timeout_ms)throw Error('tool_start_deadline');
   return {id:container.id,coldstart_ms:elapsed};
  }catch(e){
   // Der Lifecycle beobachtet/stoppt exakt diesen generationsgebundenen Namen; nie force-remove fremder Container.
   throw e;
  }
 }
 private attach(id:string,stream:Duplex,maxFrameBytes:number){
  const out=new PassThrough(),err=new PassThrough(),decoder=new StringDecoder('utf8');
  const session:Session={stream,tail:Promise.resolve(),buffer:'',maxFrameBytes};this.sessions.set(id,session);
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
   }
  });
  err.on('data',()=>{}); // Keine unmaskierten Nutzdaten in Logs.
  const end=()=>{session.current?.reject(Error('tool_runner_disconnected'));session.current?.finish();if(this.sessions.get(id)===session)this.sessions.delete(id);};
  stream.on('end',end);stream.on('error',end);stream.on('close',end);
 }
 async command(id:string,request:Record<string,unknown>,timeoutMs:number,maxBytes:number,onTerminal?:()=>void,maxInputBytes=65536):Promise<Record<string,unknown>>{
  const session=this.sessions.get(id);if(!session)throw Error('tool_runner_not_attached');
  const previous=session.tail;let unlock!:()=>void;session.tail=new Promise<void>(r=>{unlock=r;});
  await previous;
  return new Promise((resolve,reject)=>{
   let settled=false;const timer=setTimeout(()=>{settled=true;reject(Error('tool_runner_timeout'));},timeoutMs);
   const ok=(response:Record<string,unknown>)=>{if(!settled){settled=true;clearTimeout(timer);resolve(response);}};
   const bad=(e:Error)=>{if(!settled){settled=true;clearTimeout(timer);reject(e);}};
   const serialized=JSON.stringify(request)+'\n';
   session.current={resolve:ok,reject:bad,finish:()=>{clearTimeout(timer);unlock();},bytes:0,maxBytes,terminal:onTerminal};
   if(Buffer.byteLength(serialized)>maxInputBytes){bad(Error('tool_input_limit'));session.current.finish();session.current=undefined;return;}
   session.stream.write(serialized);
   // Timeout/Fehler löst die Transportfolge NICHT: erst echtes Terminal oder Disconnect.
  });
 }
 async observe(id:string):Promise<ToolObservation>{
  const container=this.docker.getContainer(id);
  let state:Docker.ContainerInspectInfo;
  try{state=await container.inspect();}catch(e){if((e as {statusCode?:number}).statusCode===404)return {container_id:id,running:false,cpu_percent:null,gpu_percent:null,measured_at:new Date().toISOString()};throw e;}
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
  try{await container.stop({t:10});}catch(e){if(![304,404].includes((e as {statusCode?:number}).statusCode??0))throw e;}
  const sample=await this.observe(id);if(sample.running)throw Error('tool_stop_unconfirmed');
  this.sessions.get(id)?.stream.destroy();this.sessions.delete(id);
  try{await container.remove();}catch(e){if((e as {statusCode?:number}).statusCode!==404)throw e;}
 }
}
