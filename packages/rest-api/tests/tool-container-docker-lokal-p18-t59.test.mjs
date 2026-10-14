/** P18-T59: lokal gebaute Images (RepoDigests leer) per Image-ID; synthetisches Docker, keine DB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Duplex} from 'node:stream';
import {validateToolDescriptor} from '../../core/dist/services/tool-descriptor.js';
import {DockerToolContainerExecutor} from '../dist/services/tool-container-docker.js';
const digest='sha256:'+'b'.repeat(64);
const d=validateToolDescriptor({tool_id:'reverse-e',tool:'reverse',capability:'reverse_bibliothek',image:'synapse-reverse:p18-t60',digest,mounts:[],
 resources:{cpu:1,ram:64,vram:0,gpu:false,pids:32,tmpfs:8,concurrency:1},limits:{time_ms:1000,output_bytes:4096,input_bytes:4096},
 lifecycle:{idle_ms:1,activity_lookback_seconds:1,cpu_idle_percent:1,gpu_idle_percent:1,measurement_max_age_ms:1000,start_timeout_ms:1000,max_starts:3,start_window_ms:60000,pause_ms:60000}});
const ctx={instance_id:'i',project:'reverse-bibliothek',job_id:null,warmup_job_id:'w',generation:'g',name:'synthetic-lokal',isCurrent:async()=>true};
function fakeDocker(image){
 const calls={create:[],inspectImage:0};let alive=false;
 const stream=new Duplex({read(){},write(_c,_e,cb){cb();}});
 const container={id:'fake-lokal',async attach(){return stream;},async start(){alive=true;},
  async inspect(){return {State:{Running:alive,StartedAt:'2026-01-01T00:00:00Z'},Config:{Image:calls.create.at(-1)?.Image,Labels:{}}};}};
 return {calls,docker:{modem:{demuxStream(){}},
  getImage(ref){return {async inspect(){calls.inspectImage++;if(!image||ref!==digest)throw Object.assign(Error('no such image'),{statusCode:404});return image;}};},
  async createContainer(o){calls.create.push(o);return container;},getContainer(){return container;}}};
}
test('lokales Image mit passender Id und Tag startet per Image-ID',async()=>{
 const f=fakeDocker({Id:digest,RepoTags:['synapse-reverse:p18-t60'],RepoDigests:[]});
 const r=await new DockerToolContainerExecutor({docker:f.docker,lokaleImages:true}).start(d,ctx);
 assert.equal(r.id,'fake-lokal');assert.equal(f.calls.create[0].Image,digest);assert.equal(f.calls.inspectImage,1);
});
test('falsche Id, falscher Tag oder fehlendes Image -> tool_image_mismatch ohne create',async()=>{
 for(const image of [{Id:'sha256:'+'c'.repeat(64),RepoTags:['synapse-reverse:p18-t60']},{Id:digest,RepoTags:['anderes:p18-t60']},{Id:digest,RepoTags:null},null]){
  const f=fakeDocker(image);
  await assert.rejects(()=>new DockerToolContainerExecutor({docker:f.docker,lokaleImages:true}).start(d,ctx),/tool_image_mismatch/);
  assert.equal(f.calls.create.length,0);
 }
});
test('Name ohne Tag akzeptiert jeden Tag dieses Namens',async()=>{
 const ohneTag=validateToolDescriptor({...d,image:'synapse-reverse'});
 const f=fakeDocker({Id:digest,RepoTags:['synapse-reverse:p18-t60']});
 await new DockerToolContainerExecutor({docker:f.docker,lokaleImages:true}).start(ohneTag,ctx);
 assert.equal(f.calls.create[0].Image,digest);
});
test('ohne Option unverändert name@digest, keine Image-Pruefung',async()=>{
 const f=fakeDocker(null);
 await new DockerToolContainerExecutor({docker:f.docker}).start(d,ctx);
 assert.equal(f.calls.create[0].Image,'synapse-reverse:p18-t60@'+digest);assert.equal(f.calls.inspectImage,0);
});
