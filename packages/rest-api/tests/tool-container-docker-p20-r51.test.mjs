/** R5.1 Docker/JSON-Lines contracts; only synthetic Docker, no daemon or database. */
import assert from 'node:assert/strict';
import {Duplex} from 'node:stream';
import {setTimeout as pause} from 'node:timers/promises';
import {validateToolDescriptor} from '../../core/dist/services/tool-descriptor.js';
import {buildToolContainerOptions,DockerToolContainerExecutor} from '../dist/services/tool-container-docker.js';
const d=validateToolDescriptor({tool_id:'fixture',tool:'reverse',capability:'fixture.reverse',image:'fixture:1',digest:'sha256:'+'a'.repeat(64),mounts:[],
 resources:{cpu:1.5,ram:64,vram:0,gpu:false,pids:32,tmpfs:8,concurrency:2},
 limits:{time_ms:1000,output_bytes:4096,input_bytes:4096},
 lifecycle:{idle_ms:1,activity_lookback_seconds:1,cpu_idle_percent:1,gpu_idle_percent:1,measurement_max_age_ms:1000,start_timeout_ms:1000,max_starts:3,start_window_ms:60000,pause_ms:60000}});
const ctx={instance_id:'fixture',project:'p20_r51_fixture',job_id:'job-fixture',warmup_job_id:'warmup-fixture',generation:'generation-fixture',name:'synthetic-fixture',isCurrent:async()=>true};
const options=buildToolContainerOptions(d,ctx,[]);
assert.equal(options.Image,d.image+'@'+d.digest);assert.equal(options.User,'65532:65532');
assert.equal(options.NetworkDisabled,true);assert.equal(options.HostConfig.NetworkMode,'none');
assert.equal(options.HostConfig.ReadonlyRootfs,true);assert.deepEqual(options.HostConfig.CapDrop,['ALL']);
assert.deepEqual(options.HostConfig.SecurityOpt,['no-new-privileges']);assert.equal(options.HostConfig.NanoCpus,1.5e9);
assert.equal(options.HostConfig.Memory,64*1048576);assert.equal(options.HostConfig.MemorySwap,options.HostConfig.Memory);
assert.equal(options.HostConfig.PidsLimit,32);assert.equal(options.HostConfig.RestartPolicy.Name,'no');
assert.equal(options.HostConfig.DeviceRequests,undefined);
const gpu=validateToolDescriptor({...d,resource_domain:'fixture-gpu',gpu_driver:'nvidia',gpu_device_ids:['GPU-fixture'],resources:{...d.resources,gpu:true,vram:32}});
assert.deepEqual(buildToolContainerOptions(gpu,ctx,[]).HostConfig.DeviceRequests,[{Driver:'nvidia',Count:0,DeviceIDs:['GPU-fixture'],Capabilities:[['gpu']]}]);
assert.throws(()=>validateToolDescriptor({...d,network:'configured'}));
const net=validateToolDescriptor({...d,network:'configured',network_name:'fixture-net'});
assert.equal(buildToolContainerOptions(net,ctx,[]).HostConfig.NetworkMode,'fixture-net');
const mount=validateToolDescriptor({...d,mounts:[{role:'input',target:'/input',write:false}]});
const source={role:'input',source:'/fixture/root/input',root:'/fixture/root',allowWrite:false,allowProjectShare:false};
assert.deepEqual(buildToolContainerOptions(mount,ctx,[source]).HostConfig.Binds,['/fixture/root/input:/input:ro']);
assert.throws(()=>buildToolContainerOptions(mount,ctx,[]),/tool_mount_forbidden/);
assert.throws(()=>buildToolContainerOptions(mount,ctx,[{...source,source:'/fixture/outside'}]),/tool_mount_scope/);
assert.throws(()=>buildToolContainerOptions(mount,ctx,[{...source,source:'/fixture/root/socket:ro'}]),/tool_mount_scope/);
const jobMount=validateToolDescriptor({...d,mounts:[{role:'work',target:'/work',write:true,job_only:true}]});
assert.throws(()=>buildToolContainerOptions(jobMount,ctx,[{...source,role:'work',allowWrite:true}]),/tool_mount_scope/);
assert.deepEqual(buildToolContainerOptions(jobMount,{...ctx,job_id:null},[]).HostConfig.Binds,[]);
const writes=[];let stdout,alive=false,removed=0,createCount=0;
const stream=new Duplex({read(){},write(chunk,encoding,callback){writes.push(JSON.parse(chunk.toString()));callback();}});
const container={id:'fake-id',async attach(){return stream;},async start(){alive=true;},
 async inspect(){return {State:{Running:alive,StartedAt:'2026-01-01T00:00:00Z'},Config:{Image:options.Image,Labels:options.Labels}};},
 async stats(){return {read:'2026-01-01T00:00:01Z',cpu_stats:{cpu_usage:{total_usage:20},system_cpu_usage:200,online_cpus:2},precpu_stats:{cpu_usage:{total_usage:10},system_cpu_usage:100}};},
 async stop(){alive=false;},async remove(){removed++;}};
const docker={modem:{demuxStream(s,out,err){assert.equal(s,stream);stdout=out;}},async createContainer(o){createCount++;assert.equal(o.NetworkDisabled,true);return container;},getContainer(){return container;}};
const executor=new DockerToolContainerExecutor({docker});
await assert.rejects(()=>executor.start(d,{...ctx,isCurrent:async()=>false}),/tool_start_fenced/);
assert.equal(createCount,0);
const started=await executor.start(d,ctx);assert.equal(started.id,'fake-id');assert(Number.isInteger(started.coldstart_ms));
const send=value=>stdout.write(JSON.stringify(value)+'\n');
const until=async fn=>{for(let n=0;n<100&&!fn();n++)await pause(2);assert(fn(),'bounded transport wait');};
let terminals=0;
const first=executor.command('fake-id',{op:'first'},1000,4096,()=>terminals++);
const second=executor.command('fake-id',{op:'second'},1000,4096);
await until(()=>writes.length===1);send({status:'progress',percent:20});await pause(5);
assert.equal(writes.length,1,'progress never releases serial transport');
send({status:'ok',value:'first'});assert.equal((await first).value,'first');
await until(()=>writes.length===2);send({status:'fertig',value:'second'});assert.equal((await second).value,'second');assert.equal(terminals,1);
const timeout=executor.command('fake-id',{op:'timeout'},10,4096,()=>terminals++);
await assert.rejects(timeout,/tool_runner_timeout/);
const queued=executor.command('fake-id',{op:'after-timeout'},1000,4096);
await pause(5);assert.equal(writes.length,3,'timeout retains transport until physical terminal');
send({status:'completed'});await until(()=>writes.length===4);send({status:'ok'});await queued;assert.equal(terminals,2,'late terminal is reported');
await assert.rejects(()=>executor.command('fake-id',{op:'oversize',data:'x'.repeat(100)},1000,4096,undefined,20),/tool_input_limit/);
assert.equal(writes.length,4,'input limit prevents dispatch');
const outputLimit=executor.command('fake-id',{op:'output-limit'},1000,20);
await until(()=>writes.length===5);send({status:'ok',data:'x'.repeat(50)});
await assert.rejects(outputLimit,/tool_output_limit/);
const sample=await executor.observe('fake-id');assert.equal(sample.cpu_percent,20);assert.equal(sample.gpu_percent,null);assert.equal(sample.start_observed,true);
await assert.rejects(()=>executor.cleanup('fake-id'),/tool_cleanup_running/);assert.equal(removed,0);
await executor.stop('fake-id');assert.equal(removed,1);assert.equal(alive,false);
await assert.rejects(()=>executor.command('fake-id',{op:'after-stop'},1000,4096),/tool_runner_not_attached/);
const missing=new DockerToolContainerExecutor({docker:{getContainer(){return {async inspect(){throw Object.assign(Error('missing'),{statusCode:404});}};}}});
const absent=await missing.observe('missing');assert.equal(absent.running,false);assert.equal(absent.cpu_percent,null);assert.equal(absent.start_observed,undefined);
const special=new DockerToolContainerExecutor({docker,resolveMounts:async()=>[{...source,source:'/dev/null',root:'/dev'}]});
await assert.rejects(()=>special.start(mount,ctx),/tool_mount_symlink/);
console.log('PASS p20_r51 Docker: hardening/mounts/network/GPU/fence/JSON-lines/progress/singleflight/late-ACK/input/output/measurement/physical-stop/special-file');
