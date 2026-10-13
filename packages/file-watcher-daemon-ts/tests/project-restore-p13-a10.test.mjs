/** P13-T28/A10: filesystem effects stay under a fresh private mkdtemp root. No PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {restoreExistingProject} from '../dist/project-restore-worker.js';
import {WatcherManager} from '../dist/manager.js';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'p13-a10-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const content=Buffer.from('export const value="Grüße";\n'+'//full\n'.repeat(14000));
const binary=Buffer.from([137,80,78,71,13,10,26,10,0,255,128,42]);
const options={host:'separate-logical-daemon-id',richtung:'both',chunkBytes:1024,retryMs:10,timeoutMs:60000,maxDateiBytes:2_000_000};
let serial=0;
async function fixture(t,changes={}){
 const workspace=path.join(root,'case-'+(++serial));await fs.mkdir(workspace);
 process.env.SYNAPSE_WORKSPACE_ROOT=workspace;
 const name='p13-a10-fixture',target=path.join(workspace,name);
 const job={id:randomUUID(),name,hostname:os.hostname(),mode:'restore_existing',restore_lease:randomUUID()};
 const asset={asset_id:'1',pfad:'assets/image.png',revision:'4',sha256:sha(binary),groesse:binary.length,storage_kind:'assets',storage_status:'ready'};
 const entries=[{pfad:'src/main.ts',sha256:sha(content),groesse:content.length},{pfad:'.env',sha256:'a'.repeat(64),groesse:10,excluded:true}];
 const events=[];let requests=0,renewals=0;
 const api={
  async json(url,body){
   events.push({url,body});
   if(url.endsWith('/sync-optionen'))return {...options,...changes.options};
   if(url.includes('/code/manifest')){
    if(changes.code)return changes.code(url);
    return {manifest_id:'stable-code',eintraege:entries,cursor:null,vollstaendig:true};
   }
   if(url.includes('/assets/manifest'))return {eintraege:[asset,{...asset,asset_id:'2',pfad:'deleted.png',deleted_at:'fixture'}],cursor:null,vollstaendig:true,aenderungs_cursor:'delta-cursor',stand:'7',...changes.assets};
   if(url.endsWith('/renew')){renewals++;if(changes.renew)await changes.renew(target,renewals);return {success:true};}
   if(url.endsWith('/complete')){assert.equal(body.status,'done');return {success:true};}
   throw new Error('unexpected API '+url);
  },
  async request(url){
   requests++;
   if(changes.request)return changes.request(url,requests);
   const bytes=url.includes('/code/bytes')?content:binary;
   const chunks=[bytes.subarray(0,3),bytes.subarray(3)];
   return new Response(new ReadableStream({pull(c){const next=chunks.shift();if(next)c.enqueue(next);else c.close();}}));
  }
 };
 const manager={isRunning:()=>false,async registerRestored(n,p){
  assert.equal(n,name);assert.equal(p,target);
  assert.deepEqual(await fs.readFile(path.join(p,'src/main.ts')),content);
  assert.deepEqual(await fs.readFile(path.join(p,asset.pfad)),binary);
  const journal=JSON.parse(await fs.readFile(path.join(workspace,'.synapse-restore',name,'state.json'),'utf8'));
  assert.equal(journal.complete,true);
  assert.ok(events.some(e=>e.url.endsWith('/complete')));
  events.push({url:'watcher-start'});
 }};
 return {workspace,target,name,job,api,manager,events,asset,entries,get requests(){return requests},get renewals(){return renewals}};
}
async function absent(p){await assert.rejects(fs.lstat(p),e=>e.code==='ENOENT');}
try{
 await test('full UTF8+binary restore: all verified bytes and A8 checkpoint precede watcher; no stub',async t=>{
  const f=await fixture(t);assert.equal(await restoreExistingProject(f.job,f.manager,f.api),f.target);
  assert.equal(f.requests,2);assert.ok(f.renewals>=6);
  await absent(path.join(f.target,'README.md'));await absent(path.join(f.target,'.env'));await absent(path.join(f.target,'deleted.png'));await absent(path.join(f.target,'.git'));
  const files=await fs.readdir(path.join(f.target,'.synapse','asset-sync'));assert.equal(files.length,1);
  const state=JSON.parse(await fs.readFile(path.join(f.target,'.synapse','asset-sync',files[0]),'utf8'));
  assert.equal(state.scope,'projekt:'+f.name+':'+options.host);assert.equal(state.cursor,'delta-cursor');assert.equal(state.stand,'7');
  assert.equal(state.auftraege.length,0);assert.equal(state.marker[f.asset.pfad].phase,'fertig');
  const cache=path.join(f.workspace,'.synapse-restore',f.name,'bytes',sha(content));
  assert.notEqual((await fs.stat(cache)).ino,(await fs.stat(path.join(f.target,'src/main.ts'))).ino);
 });
 await test('download hash mismatch leaves project absent, watcher unstarted',async t=>{
  const f=await fixture(t,{request:async()=>new Response(Buffer.alloc(content.length,1))});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_hash_falsch/);await absent(f.target);
  assert.ok(!f.events.some(e=>e.url==='watcher-start'));
 });
 await test('oversized stream is rejected before installation',async t=>{
  const f=await fixture(t,{request:async()=>new Response(Buffer.alloc(content.length+1))});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_groesse_falsch/);await absent(f.target);
 });
 await test('interrupted stream caches only complete prior bytes and recovers without re-downloading them',async t=>{
  let fail=true;const f=await fixture(t,{request:async url=>{
   if(url.includes('/assets/bytes')&&fail)throw new Error('fixture-offline');
   return new Response(url.includes('/code/bytes')?content:binary);
  }});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/fixture-offline/);await absent(f.target);
  fail=false;await restoreExistingProject(f.job,f.manager,f.api);assert.equal(f.requests,3);
 });
 await test('lease failure after first atomic install resumes journal-owned files without overwrite',async t=>{
  let fail=true;const f=await fixture(t,{renew:async target=>{
   try{await fs.lstat(path.join(target,'src/main.ts'));}catch{return;}
   if(fail){fail=false;throw new Error('fixture-lease');}
  }});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/fixture-lease/);
  const ino=(await fs.stat(path.join(f.target,'src/main.ts'))).ino;
  await restoreExistingProject(f.job,f.manager,f.api);assert.equal((await fs.stat(path.join(f.target,'src/main.ts'))).ino,ino);assert.equal(f.requests,2);
 });
 await test('changed local journal-owned file blocks retry; original user bytes survive',async t=>{
  let fail=true;const f=await fixture(t,{renew:async target=>{
   try{await fs.lstat(path.join(target,'src/main.ts'));}catch{return;}
   if(fail){fail=false;throw new Error('fixture-lease');}
  }});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/fixture-lease/);
  await fs.writeFile(path.join(f.target,'src/main.ts'),'local user edit');
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_konflikt/);
  assert.equal(await fs.readFile(path.join(f.target,'src/main.ts'),'utf8'),'local user edit');
 });
 await test('foreign existing empty/nonempty directory is never adopted',async t=>{
  const f=await fixture(t);await fs.mkdir(f.target);
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_konflikt/);
  await fs.writeFile(path.join(f.target,'keep.txt'),'keep');
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_konflikt/);
  assert.equal(await fs.readFile(path.join(f.target,'keep.txt'),'utf8'),'keep');assert.equal(f.requests,0);
 });
 await test('foreign target symlink and workspace symlink rejected',async t=>{
  const f=await fixture(t),outside=path.join(root,'outside-'+serial);await fs.mkdir(outside);await fs.symlink(outside,f.target);
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_konflikt/);
  const link=path.join(root,'root-link-'+serial);await fs.symlink(f.workspace,link);process.env.SYNAPSE_WORKSPACE_ROOT=link;
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_workspace_symlink/);
  assert.deepEqual(await fs.readdir(outside),[]);
 });
 await test('manifest traversal/reserved path fails before any download or target creation',async t=>{
  const f=await fixture(t,{code:()=>({manifest_id:'x',eintraege:[{pfad:'../escape.ts',sha256:sha(content),groesse:content.length}],cursor:null,vollstaendig:true})});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api));await absent(f.target);assert.equal(f.requests,0);
  f.api.json=async url=>url.endsWith('/sync-optionen')?options:url.endsWith('/renew')?{}:{manifest_id:'x',eintraege:[{pfad:'.git/config',sha256:sha(content),groesse:content.length}],cursor:null,vollstaendig:true};
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_pfad_gesperrt/);
 });
 await test('missing manifest page, changed snapshot, missing ready bytes rejected',async t=>{
  const f=await fixture(t,{code:()=>({manifest_id:'x',eintraege:[],cursor:null,vollstaendig:false})});
  await assert.rejects(restoreExistingProject(f.job,f.manager,f.api),/restore_manifest_unvollstaendig/);
  const g=await fixture(t,{code:url=>({manifest_id:url.includes('?')?'second':'first',eintraege:[],cursor:url.includes('?')?null:'next',vollstaendig:url.includes('?')})});
  await assert.rejects(restoreExistingProject(g.job,g.manager,g.api),/restore_snapshot_gewechselt/);
  const h=await fixture(t,{assets:{eintraege:[{pfad:'missing.png',storage_status:'pending'}]}});
  await assert.rejects(restoreExistingProject(h.job,h.manager,h.api),/restore_asset_bytes_fehlen/);
 });
 await test('host/mode/running watcher/direction/quota guards reject before installation',async t=>{
  const f=await fixture(t);await assert.rejects(restoreExistingProject({...f.job,hostname:'other'},f.manager,f.api),/restore_host_verboten/);
  await assert.rejects(restoreExistingProject({...f.job,mode:'create'},f.manager,f.api),/restore_host_verboten/);
  await assert.rejects(restoreExistingProject(f.job,{...f.manager,isRunning:()=>true},f.api),/restore_watcher_laeuft/);
  const g=await fixture(t,{options:{richtung:'pc_to_share'}});await assert.rejects(restoreExistingProject(g.job,g.manager,g.api),/restore_richtung_verboten/);
  const h=await fixture(t,{options:{maxDateiBytes:100}});await assert.rejects(restoreExistingProject(h.job,h.manager,h.api),/restore_dateiquote/);
 });
 await test('real manager refuses all startup paths while persistent restore journal is incomplete',async t=>{
  const f=await fixture(t),dir=path.join(f.workspace,'.synapse-restore',f.name);await fs.mkdir(dir,{recursive:true});await fs.mkdir(f.target);
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({project:f.name,path:f.target,created:true,files:{},complete:false}));
  const manager=new WatcherManager({port:0,synapse_api_url:'http://127.0.0.1:9',projekte:[],asset_sync:{aktiv:false}});
  assert.throws(()=>manager.spawnWatcher({name:f.name,pfad:f.target,enabled:true}),/restore_noch_nicht_abgeschlossen/);
  assert.equal(manager.isRunning(f.name),false);await absent(path.join(f.target,'.synapse'));await manager.stopAll();
 });
}finally{
 delete process.env.SYNAPSE_WORKSPACE_ROOT;
 await fs.rm(root,{recursive:true,force:true});
}
