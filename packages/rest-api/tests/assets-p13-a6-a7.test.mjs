/** A6/A7 HTTP: actual Fastify binary streams and own synapse_test DB, no running API needed. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {AssetUploadKern,AssetManifestKern,ladeAssetKonfiguration,AssetSpeicher} from '@synapse/core';
import {createAssetsRoutes,dispatchAssetFsEreignis,istAssetFsEreignis} from '../dist/routes/assets.js';
import {fsEventsRoutes} from '../dist/routes/fs-events.js';
const require=createRequire(import.meta.url),Fastify=require('fastify'),pg=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const schema='p13_http_'+randomUUID().replaceAll('-',''),project='p13_http',base='/api/projects/'+project+'/assets';
const hash=b=>createHash('sha256').update(b).digest('hex');
let admin,db,root,cfg,app,upload,deps;
const ctx={bereich:'projekt',ziel_ref:project,host_id:'fixture'};
async function connection(){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
 await c.query('SET search_path TO '+schema+',public');
 return {query:(s,v)=>c.query(s,v),release:()=>c.end()};
}
const auth=(token='daemon')=>({authorization:'Bearer '+token,'x-synapse-contract-version':'1'});
before(async()=>{
 admin=await connection();await admin.query('CREATE SCHEMA '+schema);await admin.query('SET search_path TO '+schema+',public');
 for(const f of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql'])await admin.query(await fs.readFile(new URL('../../core/src/db/schema-sql/'+f,import.meta.url),'utf8'));
 root=await fs.mkdtemp(join(tmpdir(),'p13-http-'));process.env.SYNAPSE_API_FEATURES='asset_sync';
 cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:root,SYNAPSE_ASSET_CHUNK_BYTES:'65536'});
 db={connect:connection,async query(s,v){const c=await connection();try{return await c.query(s,v);}finally{await c.release();}}};
 upload=new AssetUploadKern({db,konfiguration:cfg});
 const principal=token=>token==='daemon'?{kind:'service',scope:'daemon:fixture',token_hash:'a'.repeat(64)}:token==='compute'?{kind:'service',scope:'compute-node:fixture',token_hash:'b'.repeat(64)}:token==='user'?{kind:'access',scope:'api',token_hash:'c'.repeat(64)}:null;
 deps={upload,manifest:new AssetManifestKern({db,konfiguration:cfg}),validateToken:async token=>principal(token),projektErlaubt:async p=>p===project};
 app=Fastify({logger:false});await app.register(createAssetsRoutes(deps));await app.register(fsEventsRoutes);await app.ready();
});
after(async()=>{if(app)await app.close();if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.release();}if(root)await fs.rm(root,{recursive:true,force:true});});
const request=(method,url,payload,headers=auth())=>app.inject({method,url:base+url,payload,headers});
const input=(pfad,b)=>({logischer_pfad:pfad,storage_kind:'assets',sha256:hash(b),groesse:b.length,basis_revision:'0',idempotency_key:randomUUID()});
test('401/403/426 and project scopes reject before accepting upload bytes',async()=>{
 const body=input('auth.png',Buffer.from('x'));
 assert.equal((await request('POST','/uploads',body,{})).statusCode,401);
 assert.equal((await request('POST','/uploads',body,auth('compute'))).statusCode,403);
 assert.equal((await request('POST','/uploads',body,auth('user'))).statusCode,403);
 assert.equal((await request('POST','/uploads',body,{authorization:'Bearer daemon'})).statusCode,426);
 assert.equal((await app.inject({method:'POST',url:'/api/projects/foreign/assets/uploads',payload:body,headers:auth()})).statusCode,403);
});
test('actual upload/chunk/finalize stream, no private session fields, user revision Range download',async()=>{
 const b=Buffer.from('0123456789'),body={...input('wire.png',b),host_id:'spoof'};
 const start=await request('POST','/uploads',body);assert.equal(start.statusCode,200);const id=start.json().upload.id;
 assert.equal('auftrag' in start.json().upload,false);assert.equal('finalisierer_token' in start.json().upload,false);
 assert.equal((await upload.status(ctx,id)).host_id,'fixture');
 const invalid=await request('PUT','/uploads/'+id+'/chunk',b, {...auth(),'content-type':'application/octet-stream'});assert.equal(invalid.statusCode,409);
 const headers={...auth(),'content-type':'application/octet-stream','content-length':String(b.length)};
 const chunk=await request('PUT','/uploads/'+id+'/chunk?offset=0',b,headers);assert.equal(chunk.statusCode,200);assert.equal(chunk.json().upload.offset,b.length);
 assert.equal((await request('PUT','/uploads/'+id+'/chunk?offset=0',b,headers)).statusCode,409);
 const done=await request('POST','/uploads/'+id+'/finalisieren',{});assert.equal(done.statusCode,200);const v=done.json().upload;
 assert.equal(v.revision,'1');assert.equal((await request('POST','/uploads/'+id+'/finalisieren',{})).json().upload.revision,'1');
 const got=await request('GET','/bytes?asset_id='+v.asset_id+'&revision=1',undefined,{...auth('user'),range:'bytes=2-4'});
 assert.equal(got.statusCode,206);assert.equal(got.payload,'234');assert.equal(got.headers['content-range'],'bytes 2-4/10');
 assert.equal(got.headers['content-length'],'3');assert.equal(got.headers['cache-control'],'no-store');
 const suffix=await request('GET','/bytes?asset_id='+v.asset_id+'&revision=1',undefined,{...auth(),range:'bytes=-3'});
 assert.equal(suffix.payload,'789');
 assert.equal((await request('GET','/bytes?asset_id='+v.asset_id+'&revision=1',undefined,{...auth(),range:'bytes=0-1,3-4'})).statusCode,416);
 assert.equal((await request('GET','/bytes?asset_id='+v.asset_id+'&revision=1',undefined,{...auth(),range:'bytes=99-'})).statusCode,416);
 assert.equal((await request('GET','/uploads/not-a-uuid')).statusCode,400);
});
test('early new asset event reaches auth before legacy root/delete, old body stays outside dispatcher',async()=>{
 assert.equal(istAssetFsEreignis({projekt:project,typ:'deleted',pfad:'x.png'}),false);
 const e={projekt:project,typ:'deleted',pfad:'unknown.png',asset_id:'999',event_id:randomUUID(),contractVersion:1,erwartete_assetrevision:'1'};
 assert.equal(istAssetFsEreignis(e),true);
 const response=await app.inject({method:'POST',url:'/api/fs/events',payload:e});
 assert.equal(response.statusCode,401); // legacy branch would instead look up project/root and return404
 const b=Buffer.from('event'),s=await upload.erstellen(ctx,input('event.png',b));await upload.teil(ctx,s.id,0,b.length,[b]);
 const req={headers:auth()},published=await dispatchAssetFsEreignis(req,{projekt:project,typ:'added',logischer_pfad:'event.png',event_id:randomUUID(),contractVersion:1,host:'fixture',upload_id:s.id,sha256:hash(b),groesse:b.length,erwartete_assetrevision:'0'},deps);
 assert.equal(published.upload.revision,'1');
 await assert.rejects(dispatchAssetFsEreignis(req,{...e,host:'spoof'},deps),x=>x.code==='host_ungueltig');
 const deleted=await dispatchAssetFsEreignis(req,{...e,asset_id:published.upload.asset_id,logischer_pfad:'event.png'},deps);
 assert.equal(deleted.asset.revision,'2');assert.ok(deleted.asset.deleted_at);
});
test('unregistered formats and unsafe paths are rejected; configured quotas reserve before bytes',async()=>{
 assert.equal((await request('POST','/uploads',input('not-registered.bin',Buffer.from('x')))).statusCode,415);
 assert.equal((await request('POST','/uploads',input('../outside.png',Buffer.from('x')))).statusCode,400);
 await db.query('INSERT INTO asset_projekt_optionen(project,max_datei_bytes) VALUES($1,1)',[project]);
 assert.equal((await request('POST','/uploads',input('too-large.png',Buffer.from('xx')))).statusCode,413);
 await db.query('DELETE FROM asset_projekt_optionen WHERE project=$1',[project]);
});
test('generated large stream uses bounded chunks and memory rather than ReadAll',async()=>{
 const chunk=Buffer.alloc(64*1024,83),n=128,total=chunk.length*n,h=createHash('sha256');for(let i=0;i<n;i++)h.update(chunk);
 const s=await upload.erstellen(ctx,{logischer_pfad:'large.png',storage_kind:'assets',groesse:total,sha256:h.digest('hex'),basis_revision:'0',idempotency_key:randomUUID()});
 const memory=process.memoryUsage().rss;let peak=memory;
 for(let i=0;i<n;i++){await upload.teil(ctx,s.id,i*chunk.length,chunk.length,[chunk]);peak=Math.max(peak,process.memoryUsage().rss);}
 const v=await upload.finalisieren(ctx,s.id),r=await upload.bytes(ctx,{asset_id:v.asset_id,revision:v.revision});let seen=0,largest=0;const digest=createHash('sha256');
 for await(const b of r.stream){seen+=b.length;largest=Math.max(largest,b.length);digest.update(b);peak=Math.max(peak,process.memoryUsage().rss);}
 assert.equal(seen,total);assert.equal(digest.digest('hex'),s.sha256);assert.ok(largest<=cfg.speicher.chunkBytes);
 assert.ok(peak-memory<96*1024*1024,'RSS remains below bounded fixture allowance');console.log('STREAM_BYTES='+total+' MAX_CHUNK='+largest+' RSS_DELTA='+Math.max(0,peak-memory));
});
