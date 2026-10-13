/** P13-T26/A8: real loopback HTTP streams, durable restart, isolated synapse_test and private FS root. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const pg=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const dist=process.env.A8_MODULE_ROOT??new URL('../dist/',import.meta.url).pathname;
let Queue,Transport,ApiError,Sync;
try{
 ({AssetTransferQueue:Queue}=await import(pathToFileURL(join(dist,'asset-transfer-queue.js'))));
 ({AssetApiTransport:Transport,AssetApiFehler:ApiError}=await import(pathToFileURL(join(dist,'asset-api-transport.js'))));
 ({DaemonAssetSync:Sync}=await import(pathToFileURL(join(dist,'asset-sync.js'))));
}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const sha=b=>createHash('sha256').update(b).digest('hex');
const png=n=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(n,7)]);
const opts={richtung:'both',chunkBytes:65536,retryMs:10,timeoutMs:1000,maxDateiBytes:8*1024*1024,parallelTransfers:1};
let root,db;const queues=new Set(),servers=new Set();
const schema='p13_a8_'+randomUUID().replaceAll('-','');
before(async()=>{
 const u=new URL(process.env.DATABASE_URL??'postgres://invalid/invalid');
 assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
 db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
 assert.equal((await db.query('SELECT current_database() n')).rows[0].n,'synapse_test');
 await db.query('CREATE SCHEMA '+schema);
 await db.query('CREATE TABLE '+schema+'.test_run (id text PRIMARY KEY)');
 await db.query('INSERT INTO '+schema+'.test_run VALUES ($1)',['p13_a8']);
 root=await fs.mkdtemp(join(tmpdir(),'p13-a8-'));assert.equal(await fs.realpath(root),root);
});
after(async()=>{
 for(const s of syncs)await s.stopAll();
 for(const q of queues)await q.stop().catch(()=>{});
 for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}
 if(db){await db.query('DROP SCHEMA '+schema+' CASCADE');await db.end();}
 if(root)await fs.rm(root,{recursive:true,force:true});
});
async function dir(){const p=join(root,randomUUID());await fs.mkdir(p);return p;}
const meta=(b,p='a.png',rev='1')=>({asset_id:randomUUID(),pfad:p,revision:rev,sha256:sha(b),groesse:b.length,storage_kind:'assets',storage_status:'ready',deleted_at:null});
async function until(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout '+label);}
function queue(p,api,o={},scope={}){assert.equal(typeof Queue,'function');const q=new Queue({bereich:'projekt',ziel_ref:'p13_a8',host:'daemon_fixture',root:p,...scope},{...opts,...o},api);queues.add(q);return q;}
async function fake({bytes=png(200),onChunk,onBytes,onFinal,extra}={}){
 const state={sessions:new Map(),requests:[],chunks:[],finals:0,deletes:0,active:0,maxActive:0,bytes};
 const json=(r,v,status=200)=>{r.writeHead(status,{'content-type':'application/json'});r.end(JSON.stringify(v));};
 const server=createServer(async(req,res)=>{
  try{
   const u=new URL(req.url,'http://fixture');state.requests.push({path:u.pathname,method:req.method,auth:req.headers.authorization,contract:req.headers['x-synapse-contract-version']});
   if(extra&&await extra(req,res,u,state,json))return;
   if(u.pathname.endsWith('/uploads')&&req.method==='POST'){
    let raw='';for await(const c of req)raw+=c;const input=JSON.parse(raw),id=randomUUID();
    const s={id,offset:0,status:'laeuft',lease_bis:new Date(Date.now()+60000).toISOString(),input,chunks:[]};state.sessions.set(id,s);json(res,{upload:s});return;
   }
   const id=u.pathname.match(/\/uploads\/([^/]+)/)?.[1],s=state.sessions.get(id);
   if(s&&u.pathname.endsWith('/chunk')){
    const chunk=[];for await(const c of req)chunk.push(c);const b=Buffer.concat(chunk),offset=Number(u.searchParams.get('offset'));
    if(offset!==s.offset){json(res,{error:{code:'offset_konflikt',message:'offset'}},409);return;}
    s.chunks.push(b);s.offset+=b.length;state.chunks.push({offset,length:b.length,session:id});state.active++;state.maxActive=Math.max(state.maxActive,state.active);
    try{if(onChunk&&await onChunk(req,res,s,state,json))return;json(res,{upload:{id:s.id,offset:s.offset,status:s.status,lease_bis:s.lease_bis}});}finally{state.active--;}return;
   }
   if(s&&u.pathname.endsWith('/finalisieren')){
    state.finals++;assert.equal(sha(Buffer.concat(s.chunks)),s.input.sha256);assert.equal(s.offset,s.input.groesse);
    if(onFinal&&await onFinal(req,res,s,state,json))return;
    s.status='finalisiert';s.asset_id=randomUUID();s.revision='1';json(res,{upload:s});return;
   }
   if(s){json(res,{upload:s});return;}
   if(u.pathname.endsWith('/bytes')){if(onBytes&&await onBytes(req,res,state))return;res.writeHead(200,{'content-type':'application/octet-stream'});res.end(state.bytes);return;}
   if(u.pathname.endsWith('/loeschen')){let raw='';for await(const c of req)raw+=c;state.deletes++;const i=JSON.parse(raw);json(res,{asset:{...meta(state.bytes),asset_id:i.asset_id,revision:'2',deleted_at:'now'}});return;}
   json(res,{error:{code:'not_found',message:'fixture route'}},404);
  }catch(e){json(res,{error:{code:'fixture',message:e.message}},500);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.add(server);
 const base='http://127.0.0.1:'+server.address().port;
 return {state,base,api:new Transport(fetch,()=>({token:'fixture-only',basen:[base]}))};
}
async function settled(q){await until(async()=>!(await q.status()).auftraege.length,'queue drain');}
test('A8-Module vorhanden: rote Altstand-Positivkontrolle',()=>{assert.equal(typeof Queue,'function');assert.equal(typeof Sync,'function');assert.equal(typeof Transport,'function');});
test('synapse_test:5433 eigener Bereich tatsächlich geöffnet',async()=>assert.equal((await db.query('SELECT id FROM '+schema+'.test_run')).rows[0].id,'p13_a8'));
test('Transport 401/403/409/302 nie Basisfallback, bestehender Vertragheader',async()=>{
 for(const status of [401,403,409,302]){
  const calls=[];const api=new Transport(async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({error:{code:'denied',message:'denied'}}),{status});},()=>({token:'fixture-only',basen:['http://first','http://second']}));
  await assert.rejects(api.json('/api/projects'),e=>e instanceof ApiError&&e.status===status);assert.equal(calls.length,1);
  assert.equal(calls[0].init.redirect,'manual');assert.equal(calls[0].init.headers['x-synapse-contract-version'],'1');
 }
});
test('Transport 503 recreates bounded body exactly for alternate basis',async()=>{
 let factories=0;const got=[];const api=new Transport(async(url,init)=>{const chunks=[];for await(const b of init.body)chunks.push(b);got.push(Buffer.concat(chunks));return new Response('{}',{status:got.length===1?503:200});},()=>({token:'fixture-only',basen:['http://first','http://second']}));
 const bytes=png(1000);const response=await api.request('/api/upload',{method:'PUT',body:()=>{factories++;return(async function*(){yield bytes;})();}});await response.json();
 assert.equal(factories,2);assert.deepEqual(got,[bytes,bytes]);
});
test('Response timeout remains active through actual stalled HTTP download',async()=>{
 const f=await fake({onBytes:async(req,res)=>{res.writeHead(200);res.write(Buffer.from('x'));return true;}});
 const r=await f.api.request('/api/assets/bytes',{timeoutMs:40});await assert.rejects(r.arrayBuffer());
});
test('2MiB actual HTTP upload chunk budget/full hash/ACK and metadata-only journal',async()=>{
 const p=await dir(),b=png(2*1024*1024),f=await fake();await fs.writeFile(join(p,'a.png'),b);
 const q=queue(p,f.api);await q.ereignis('a.png','add');assert.equal(f.state.chunks.length,0);q.start();await settled(q);
 assert.equal(f.state.finals,1);assert.ok(f.state.chunks.length>20);assert.ok(f.state.chunks.every(c=>c.length<=opts.chunkBytes));
 assert.equal((await q.bekannt('a.png')).sha256,sha(b));
 const journals=(await fs.readdir(join(p,'.synapse/asset-sync'))).filter(s=>s.endsWith('.json'));
 const journal=await fs.readFile(join(p,'.synapse/asset-sync',journals[0]),'utf8');assert.ok(!journal.includes(b.toString('base64')));
 assert.ok(f.state.requests.every(r=>r.auth==='Bearer fixture-only'&&r.contract==='1'));
});
test('Lost chunk ACK + stop/restart resumes same session at server-confirmed offset',async()=>{
 const p=await dir(),b=png(200000);await fs.writeFile(join(p,'a.png'),b);let fail=true;
 const f=await fake({onChunk:async(req,res,s,state,json)=>{if(fail){json(res,{error:{code:'offline',message:'offline'}},503);return true;}return false;}});
 let q=queue(p,f.api);await q.ereignis('a.png','add');q.start();await until(()=>f.state.chunks.length===1,'first stored chunk');q.pause();await q.stop();
 assert.equal(f.state.sessions.size,1);fail=false;q=queue(p,f.api);q.start();await settled(q);
 assert.equal(f.state.sessions.size,1);assert.equal(f.state.finals,1);assert.deepEqual(f.state.chunks.map(c=>c.offset),[0,65536,131072,196608]);
});
test('Paused offline queue journals without HTTP; scope host and reverse remain separate',async()=>{
 const p=await dir(),f=await fake();await fs.writeFile(join(p,'a.png'),png(20));
 const q=queue(p,f.api);await q.ereignis('a.png','change');await q.abarbeiten();assert.equal(f.state.requests.length,0);await q.stop();
 const resumed=queue(p,f.api);assert.equal((await resumed.status()).auftraege.length,1);
 const other=queue(p,f.api,{}, {host:'daemon_other'});assert.equal((await other.status()).auftraege.length,0);
 const reverse=queue(p,f.api,{}, {bereich:'reverse',apiPfad:'/api/reverse/p13_a8/assets'});assert.equal((await reverse.status()).auftraege.length,0);assert.notEqual(reverse.base,q.base);
 assert.throws(()=>queue(p,f.api,{}, {bereich:'reverse'}),/Routenadapter/);
});
test('SHA-checked download/atomic install/checkpoint and persisted echo suppression',async()=>{
 const p=await dir(),b=png(400),f=await fake({bytes:b}),q=queue(p,f.api),m=meta(b);
 await q.herunterladen(m);await assert.rejects(q.checkpoint('c','s'),e=>e.code==='checkpoint_offen');q.start();await settled(q);
 assert.deepEqual(await fs.readFile(join(p,'a.png')),b);await q.checkpoint('commit1','stand1');await q.stop();
 const resumed=queue(p,f.api);assert.equal((await resumed.status()).cursor,'commit1');await resumed.ereignis('a.png','change');resumed.start();await settled(resumed);assert.equal(f.state.finals,0);
});
test('Wrong download SHA blocks install and cursor acknowledgement',async()=>{
 const p=await dir(),b=png(50),f=await fake({bytes:png(51)}),q=queue(p,f.api);await q.herunterladen(meta(b));q.start();
 await until(async()=>!!(await q.status()).auftraege[0]?.gesperrt,'integrity error');
 await assert.rejects(fs.stat(join(p,'a.png')),{code:'ENOENT'});await assert.rejects(q.checkpoint('bad','bad'),e=>e.code==='checkpoint_offen');
});
test('Concurrent creation during absent-target download preserves local bytes',async()=>{
 const p=await dir(),b=png(80),local=png(81),f=await fake({bytes:b,onBytes:async(req,res,state)=>{await fs.writeFile(join(p,'a.png'),local);res.writeHead(200);res.end(state.bytes);return true;}});
 const q=queue(p,f.api);await q.herunterladen(meta(b));q.start();await until(async()=>!!(await q.status()).auftraege[0]?.gesperrt,'race blocked');
 assert.deepEqual(await fs.readFile(join(p,'a.png')),local);
});
test('Download-only preserves divergent PC inode before installing Share',async()=>{
 const p=await dir(),b=png(90),pc=png(91),f=await fake({bytes:b});await fs.writeFile(join(p,'a.png'),pc);
 const q=queue(p,f.api,{richtung:'share_to_pc'});await q.herunterladen(meta(b));q.start();await settled(q);
 assert.deepEqual(await fs.readFile(join(p,'a.png')),b);const backup=(await fs.readdir(join(p,'.synapse/asset-sync'))).find(s=>s.startsWith('pc-before-install-'));
 assert.ok(backup);assert.deepEqual(await fs.readFile(join(p,'.synapse/asset-sync',backup)),pc);assert.equal(f.state.finals,0);
});
test('Direction gates never enqueue prohibited transfer; missing scan never deletes',async()=>{
 const p=await dir(),f=await fake(),b=png(50);await fs.writeFile(join(p,'a.png'),b);
 const down=queue(p,f.api,{richtung:'share_to_pc'});await down.ereignis('a.png','add');assert.equal((await down.status()).auftraege.length,0);
 const up=queue(p,f.api,{richtung:'pc_to_share'}, {host:'upload-only'});await up.herunterladen(meta(b));await up.ereignis('unknown.png','unlink');assert.equal((await up.status()).auftraege.length,0);assert.equal(f.state.deletes,0);
});
test('Explicit known unlink sends exactly one revision-bound remote delete',async()=>{
 const p=await dir(),b=png(40),f=await fake({bytes:b}),q=queue(p,f.api);await fs.writeFile(join(p,'a.png'),b);
 await q.restoreCheckpoint([meta(b)],'c','s');await fs.unlink(join(p,'a.png'));await q.ereignis('a.png','unlink');q.start();await settled(q);assert.equal(f.state.deletes,1);
});
test('Ignore/invalid path/parent symlink cannot hash bytes outside project',async()=>{
 const p=await dir(),outside=await dir(),f=await fake(),q=queue(p,f.api);await fs.writeFile(join(outside,'a.png'),png(40));await fs.symlink(outside,join(p,'escape'));
 await assert.rejects(q.hash('escape/a.png'),e=>e.code==='pfad_ungueltig');await assert.rejects(q.hash('../a.png'));
 await fs.writeFile(join(p,'.gitignore'),'hidden.png\n');await fs.writeFile(join(p,'hidden.png'),png(40));
 assert.equal(await q.kandidat('hidden.png'),null);assert.equal(f.state.requests.length,0);
});
test('Corrupt persisted scope state is rejected without automatic overwrite',async()=>{
 const p=await dir(),f=await fake(),q=queue(p,f.api);await q.status();await q.stop();const d=join(p,'.synapse/asset-sync');
 const file=(await fs.readdir(d)).find(s=>s.endsWith('.json'));const text='{"version":1,"scope":"foreign","auftraege":[],"bekannt":{},"marker":{}}';await fs.writeFile(join(d,file),text);
 const broken=queue(p,f.api);await assert.rejects(broken.status(),/ungültig/);assert.equal(await fs.readFile(join(d,file),'utf8'),text);
});
test('Invalid resource limits fail before creating persistent directories',async()=>{
 const p=await dir(),f=await fake();for(const o of [{chunkBytes:0},{retryMs:-1},{parallelTransfers:0},{maxDateiBytes:NaN}])assert.throws(()=>queue(p,f.api,o),/Ungültige/);
 await assert.rejects(fs.stat(join(p,'.synapse')),{code:'ENOENT'});
});
test('Global transfer budget spans two project queues',async()=>{
 const f=await fake({onChunk:async()=>{await new Promise(r=>setTimeout(r,20));return false;}}),p1=await dir(),p2=await dir();
 await fs.writeFile(join(p1,'a.png'),png(100000));await fs.writeFile(join(p2,'a.png'),png(100000));const q1=queue(p1,f.api),q2=queue(p2,f.api,{}, {ziel_ref:'p13_a8_second'});
 await q1.ereignis('a.png','add');await q2.ereignis('a.png','add');q1.start();q2.start();await Promise.all([settled(q1),settled(q2)]);assert.equal(f.state.maxActive,1);assert.equal(f.state.finals,2);
});
test('Legacy daemon configuration operations equal LIVE t85 exactly',async()=>{
 const old=await import(pathToFileURL('/tmp/synapse-basis-844329d/packages/file-watcher-daemon-ts/dist/config.js'));
 const current=await import(new URL('../dist/config.js',import.meta.url));
 const run=m=>{const c={port:9427,host:'127.0.0.1',projekte:[{name:'a',pfad:'/fixture/a',enabled:true}]};m.upsertProjekt(c,{name:'b',pfad:'/fixture/b',enabled:false});const found=m.findProjekt(c,'b');const removed=m.removeProjekt(c,'a');return{c,found,removed,missing:m.removeProjekt(c,'none')};};
 const captured=run(old);assert.deepEqual(run(current),captured);
});


const syncs=new Set();
after(async()=>{for(const s of syncs)await s.stopAll();});
async function negotiation({enabled=true,ownerStatus=200,policy={},pages,changes,offline}={}){
 const p=await dir(),config={asset_sync:{retry_ms:20},projekte:[]},project={name:'p13_a8',pfad:p,enabled:true};
 const defaults={success:true,host:'daemon_fixture',...opts,scanMs:60000},requests=[];
 const f=await fake({extra:async(req,res,u,state,json)=>{
  if(u.pathname==='/api/projects'){requests.push('capability');if(offline?.())json(res,{error:{code:'offline',message:'offline'}},503);else json(res,{projects:['p13_a8'],activeWatchers:['p13_a8'],capabilities:{contractVersion:1,features:enabled?['asset_sync']:[]}});return true;}
  if(u.pathname.endsWith('/sync-optionen')){requests.push('policy');json(res,{...defaults,...policy});return true;}
  if(u.pathname.endsWith('/inspektionsmodus')){requests.push('owner');json(res,ownerStatus===200?{success:true}:{error:{code:'owner_fence',message:'owner denied'}},ownerStatus);return true;}
  if(u.pathname.endsWith('/manifest')){requests.push('manifest');json(res,pages?await pages(u,state):{eintraege:[],cursor:null,aenderungs_cursor:'c1',stand:'s1',vollstaendig:true});return true;}
  if(u.pathname.endsWith('/aenderungen')){requests.push('delta');json(res,changes?await changes(u,state):{eintraege:[],cursor:'c2',stand:'s2',vollstaendig:true});return true;}
  return false;
 }});
 const sync=new Sync(()=>config,f.api);syncs.add(sync);return{p,project,config,f,sync,requests};
}
test('Feature-off retains legacy routing without policy/owner/transfer calls',async()=>{
 const n=await negotiation({enabled:false});n.sync.starte(n.project);assert.equal(await n.sync.bereit(n.project.name),false);
 assert.equal(await n.sync.ereignis({project:n.project.name,path:'a.png',type:'add'}),false);
 assert.deepEqual(n.requests,['capability']);assert.equal(n.project.asset_sync,undefined);await n.sync.stopAll();assert.equal(n.project.enabled,true);
});
test('API ownership fence precedes journal activation and manifest/bytes',async()=>{
 const n=await negotiation();n.sync.starte(n.project);assert.equal(await n.sync.bereit(n.project.name),true);
 assert.deepEqual(n.requests.slice(0,4),['capability','policy','owner','manifest']);
 const status=await n.sync.status(n.project.name);assert.equal(status.modus,'api');assert.ok(status.cursor);assert.equal(n.project.asset_sync.host,'daemon_fixture');await n.sync.stopAll();
});
test('Denied owner/contradictory direction fail closed before manifest or bytes',async()=>{
 const a=await negotiation({ownerStatus:409});a.sync.starte(a.project);await a.sync.bereit(a.project.name);assert.ok(!a.requests.includes('manifest'));assert.equal(a.project.asset_sync,undefined);await a.sync.stopAll();
 const b=await negotiation({policy:{richtung:'share_to_pc'}});b.project.asset_sync={richtung:'pc_to_share'};b.sync.starte(b.project);await b.sync.bereit(b.project.name);
 assert.ok(!b.requests.includes('owner'));assert.ok(!b.requests.includes('manifest'));await b.sync.stopAll();
});
test('Manifest multi-page stand drift leaves cursor unacknowledged',async()=>{
 const n=await negotiation({pages:async u=>({eintraege:[],cursor:u.searchParams.get('cursor')?null:'next',aenderungs_cursor:'c',stand:u.searchParams.get('cursor')?'different':'initial',vollstaendig:!!u.searchParams.get('cursor')})});
 n.sync.starte(n.project);await n.sync.bereit(n.project.name);assert.ok(n.requests.filter(x=>x==='manifest').length>=2);assert.equal((await n.sync.status(n.project.name)).cursor,undefined);await n.sync.stopAll();
});
test('Commit-delta fullscan recovery resets stale cursor and installs fresh full watermark',async()=>{
 let stale=true,full=0;const n=await negotiation({pages:async()=>({eintraege:[],cursor:null,aenderungs_cursor:'full'+(++full),stand:'fullstand'+full,vollstaendig:true}),
 changes:async()=>stale?(stale=false,{eintraege:[],cursor:'old',stand:'old',vollstaendig:true,fullscan_erforderlich:true}):({eintraege:[],cursor:'delta',stand:'delta',vollstaendig:true})});
 n.sync.starte(n.project);await n.sync.bereit(n.project.name);assert.ok(full>=2);assert.match((await n.sync.status(n.project.name)).cursor,/^full/);await n.sync.stopAll();
});
test('Offline managed cache is not authority; explicit unlink resumes only after fresh policy+owner',async()=>{
 let offline=true;const n=await negotiation({offline:()=>offline}),b=png(20);await fs.writeFile(join(n.p,'a.png'),b);
 const seeded=queue(n.p,n.f.api);await seeded.restoreCheckpoint([meta(b)],'prior','prior');await seeded.stop();await fs.unlink(join(n.p,'a.png'));
 n.project.asset_sync={verwaltet:true,host:'daemon_fixture',optionen:opts};n.sync.starte(n.project);await n.sync.bereit(n.project.name);
 await n.sync.ereignis({project:n.project.name,path:join(n.p,'a.png'),type:'unlink'});
 assert.equal(n.f.state.deletes,0);assert.equal((await n.sync.status(n.project.name)).auftraege.length,1);
 offline=false;await until(()=>n.f.state.deletes===1,'authorized offline delete resume');assert.ok(n.requests.indexOf('owner')>n.requests.indexOf('policy'));await n.sync.stopAll();
});


test('Expired interrupted upload lease starts a new idempotent session after restart',async()=>{
 const p=await dir(),b=png(90000);await fs.writeFile(join(p,'a.png'),b);let fail=true;
 const f=await fake({onChunk:async(req,res,s,state,json)=>{if(fail){json(res,{error:{code:'offline',message:'offline'}},503);return true;}return false;}});
 let q=queue(p,f.api);await q.ereignis('a.png','add');q.start();await until(()=>f.state.chunks.length===1,'expired-session chunk');q.pause();await q.stop();
 const old=[...f.state.sessions.values()][0];old.lease_bis=new Date(0).toISOString();fail=false;q=queue(p,f.api);q.start();await settled(q);
 assert.equal(f.state.sessions.size,2);assert.equal(f.state.finals,1);assert.notEqual([...f.state.sessions.values()][1].input.idempotency_key,old.input.idempotency_key);
});
test('File mutation between chunk and final fence cannot publish previous hash',async()=>{
 const p=await dir(),b=png(90000),changed=png(91000);await fs.writeFile(join(p,'a.png'),b);let mutated=false;
 const f=await fake({onChunk:async()=>{if(!mutated){mutated=true;await fs.writeFile(join(p,'a.png'),changed);}return false;}});
 const q=queue(p,f.api);await q.ereignis('a.png','add');q.start();await settled(q);
 assert.equal(f.state.finals,1);assert.equal((await q.bekannt('a.png')).sha256,sha(changed));assert.equal([...f.state.sessions.values()].filter(s=>s.status==='finalisiert')[0].input.sha256,sha(changed));
});
test('Initial divergent PC bytes secured through A11 receipt before canonical Share install',async()=>{
 const p=await dir(),share=png(210),pc=png(220),m=meta(share,'a.png','3');await fs.writeFile(join(p,'a.png'),pc);
 const f=await fake({bytes:share,onFinal:async(req,res,s,state,json)=>{
  state.savedPc=Buffer.concat(s.chunks);s.status='finalisiert';s.asset_id=m.asset_id;s.revision='3';
  json(res,{upload:{...s,konflikt:{id:randomUUID(),share:{sha256:m.sha256,groesse:m.groesse,revision:m.revision,tombstone:false}}}});return true;
 }});
 const q=queue(p,f.api);await q.herunterladen(m);q.start();await settled(q);
 assert.deepEqual(f.state.savedPc,pc);assert.deepEqual(await fs.readFile(join(p,'a.png')),share);assert.equal((await q.bekannt('a.png')).sha256,sha(share));assert.equal((await q.status()).konflikte.length,1);
});
