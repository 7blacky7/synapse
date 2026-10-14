/** P13-A14: synthetische Renderer-/Cachefälle; Ausführen erst in gebündelter Testphase. */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {inflateSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createTestFixtureCleanup} from './_helfer/test-fixture-cleanup.mjs';
import {AssetAnsichtDienst} from '../dist/services/asset-ansicht.js';
import {FfmpegAnsichtRenderer,kodiereAnsichtPng,pruefeAnsichtPng} from '../dist/services/asset-ansicht-renderer.js';
import {AssetSpeicher} from '../dist/services/asset-speicher.js';
import {AssetUploadKern} from '../dist/services/asset-upload.js';
import {ladeAssetKonfiguration} from '../dist/config/asset-konfig.js';
const cleanup=createTestFixtureCleanup({rootDirectory:join(tmpdir(),'synapse-p13-a14-fixtures')});
after(async()=>{await cleanup.cleanup();cleanup.dispose();});
const sha=b=>createHash('sha256').update(b).digest('hex');
const noDb={query(){throw Error('DB-free test touched PG');},connect(){throw Error('DB-free test touched PG');}};
const limits={maxPixel:16777216,maxBytes:8*1024*1024,maxRamBytes:1024*1024*1024,timeoutMs:15000,maxKante:2048,maxFrames:1,maxDauerMs:12000};
async function fixture(extra={}){
 const root=await cleanup.createRoot('p13-a14-');
 const cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'projekt'),
  SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:join(root,'reverse'),...extra});
 return {root,cfg,speicher:new AssetSpeicher({konfiguration:cfg})};
}
const adresse={bereich:'reverse',ziel_ref:'p13_a14',storage_kind:'assets',logischer_pfad:'synthetic.png'};
/** Unabhängiges BMP: zwei Zeilen, durchgehend rot, echte Datei statt Headerdummy. */
function pngFixture(w=4,h=2){
 const stride=Math.ceil(w*3/4)*4,b=Buffer.alloc(54+stride*h);
 b.write('BM');b.writeUInt32LE(b.length,2);b.writeUInt32LE(54,10);b.writeUInt32LE(40,14);
 b.writeInt32LE(w,18);b.writeInt32LE(h,22);b.writeUInt16LE(1,26);b.writeUInt16LE(24,28);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)b[54+y*stride+x*3+2]=255;
 return execFileSync('ffmpeg',['-nostdin','-v','error','-f','bmp_pipe','-i','pipe:0',
  '-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1'],{input:b,timeout:15000});
}
function decodeOwnPng(png){
 const w=png.readUInt32BE(16),h=png.readUInt32BE(20),chunks=[];let at=8;
 assert.equal(png[24],8);assert.equal(png[25],6);
 while(at<png.length){const n=png.readUInt32BE(at);if(png.toString('ascii',at+4,at+8)==='IDAT')chunks.push(png.subarray(at+8,at+8+n));at+=n+12;}
 const raw=inflateSync(Buffer.concat(chunks));assert.equal(raw.length,(w*4+1)*h);
 for(let y=0;y<h;y++)assert.equal(raw[y*(w*4+1)],0);
 return {w,h,raw};
}
function adapter(bytes,extra={}){
 let holds=0,released=0,reads=0;
 const value={bereich:'reverse',id:'test-id',revision:'r1',sha256:sha(bytes),adresse,groesse:bytes.length,
  format:'png',mimeType:'image/png',
  async lesen(){reads++;return Readable.from([bytes]);},
  async halten(){holds++;},async freigeben(){released++;},...extra};
 return {value,stats:()=>({holds,released,reads}),aufloesen:async()=>({...value})};
}
const ref={bereich:'reverse',ziel_ref:'p13_a14',id:'test-id'};
async function service(bytes,extra={},env={}){
 const f=await fixture(env),a=adapter(bytes,extra),dienst=new AssetAnsichtDienst({konfiguration:f.cfg,speicher:f.speicher,db:noDb});
 const unregister=dienst.registriereQuellenAdapter('reverse',a);
 return {...f,a,dienst,unregister};
}
test('PNG zlib/CRC is independently decodable; rejects pixel and KB budgets',async()=>{
 const rgba=Buffer.from([255,0,0,255,0,255,0,255]);
 const png=await kodiereAnsichtPng(rgba,2,1,limits),d=decodeOwnPng(png);
 assert.deepEqual([...d.raw.subarray(1)],[...rgba]);assert.deepEqual(pruefeAnsichtPng(png,limits),{breite:2,hoehe:1});
 await assert.rejects(kodiereAnsichtPng(rgba,2,1,{...limits,maxPixel:1}),e=>e.code==='ansicht_limit');
 await assert.rejects(kodiereAnsichtPng(rgba,2,1,{...limits,maxBytes:1}),e=>e.code==='ansicht_limit');
 const bad=Buffer.from(png);bad[40]^=1;assert.throws(()=>pruefeAnsichtPng(bad,limits));
});
test('real independently encoded PNG decoding/downscale, immutable input, persistent cache across service instances',async()=>{
 const bytes=pngFixture(16,8),before=sha(bytes),s=await service(bytes,{}, {SYNAPSE_ASSET_PREVIEW_MAX_EDGE:'4'});
 const first=await s.dienst.ansicht(ref);assert.equal(first.success,true,JSON.stringify(first));
 assert.equal(first.cacheTreffer,false);assert.equal(first.breite,4);assert.equal(first.hoehe,2);
 const d=decodeOwnPng(first.png);assert.deepEqual([...d.raw.subarray(1,5)],[255,0,0,255]);
 assert.equal(sha(bytes),before);assert.deepEqual(s.a.stats(),{holds:1,released:1,reads:1});
 const secondService=new AssetAnsichtDienst({konfiguration:s.cfg,speicher:s.speicher,db:noDb});
 secondService.registriereQuellenAdapter('reverse',s.a);
 const second=await secondService.ansicht(ref);assert.equal(second.success,true);assert.equal(second.cacheTreffer,true);
 assert.deepEqual(second.png,first.png);assert.equal(s.a.stats().reads,1);
 // Revision and renderer/profile identity must not reuse a different preview.
 s.a.value.revision='r2';const changed=await s.dienst.ansicht(ref);assert.equal(changed.success,true);
 assert.notEqual(changed.cacheKey,first.cacheKey);assert.equal(changed.cacheTreffer,false);
 assert.equal(await s.dienst.bereinigeCache(adresse,first.cacheKey,async()=>false),false);
 assert.ok(await s.speicher.leseAnsichtCache(adresse,first.cacheKey));
 assert.equal(await s.dienst.bereinigeCache(adresse,first.cacheKey,async()=>true),true);
 assert.equal(await s.speicher.leseAnsichtCache(adresse,first.cacheKey),null);
 s.unregister();assert.equal((await s.dienst.ansicht(ref)).fehlercode,'ansicht_nicht_darstellbar');
});
test('unsupported PSD/archive/active SVG and audio return only bound link fallback',async()=>{
 for(const [format,mimeType] of [['psd','image/vnd.adobe.photoshop'],['zip','application/zip'],['svg','image/svg+xml'],['mp3','audio/mpeg']]){
  const s=await service(Buffer.from('synthetic'),{format,mimeType}),r=await s.dienst.ansicht(ref);
  assert.equal(r.success,false);assert.equal(r.fehlercode,'ansicht_nicht_darstellbar');
  assert.equal(r.link_rueckfall.id,ref.id);assert.equal(s.a.stats().reads,0);assert.equal(s.a.stats().holds,0);
 }
});
test('missing bytes, wrong revision/hash and count limits fail without fabricated images',async()=>{
 const s=await service(pngFixture(),{lesen:async()=>{throw Error('ENOENT');}});
 assert.equal((await s.dienst.ansicht(ref)).fehlercode,'ansicht_quelle_fehlt');
 assert.deepEqual(s.a.stats(),{holds:1,released:1,reads:0});
 assert.equal((await s.dienst.ansicht({...ref,sha256:'0'.repeat(64)})).fehlercode,'ansicht_revision_falsch');
 await assert.rejects(s.dienst.ansichten(Array(6).fill(ref)),e=>e.code==='ansicht_limit');
 const bad=await service(pngFixture(),{sha256:'0'.repeat(64)});
 assert.equal((await bad.dienst.ansicht(ref)).fehlercode,'ansicht_revision_falsch');
});
test('real large source pixels, source bytes and tiny PNG budget are bounded',async()=>{
 const pixel=await service(pngFixture(8,8),{}, {SYNAPSE_ASSET_PREVIEW_MAX_PIXELS:'4'});
 assert.equal((await pixel.dienst.ansicht(ref)).fehlercode,'ansicht_limit');
 const input=await service(pngFixture(),{}, {SYNAPSE_ASSET_PREVIEW_MAX_INPUT_BYTES:'1'});
 assert.equal((await input.dienst.ansicht(ref)).fehlercode,'ansicht_limit');assert.equal(input.a.stats().reads,0);
 const output=await service(pngFixture(),{}, {SYNAPSE_ASSET_PREVIEW_MAX_BYTES:'1'});
 assert.equal((await output.dienst.ansicht(ref)).fehlercode,'ansicht_limit');
});
test('decompression-bomb PNG dimensions are rejected within process RAM/time limits',async()=>{
 const png=await kodiereAnsichtPng(Buffer.from([255,0,0,255]),1,1,limits);
 // Claim huge dimensions while retaining one compressed pixel; rebuild only the IHDR CRC.
 const bomb=Buffer.from(png);bomb.writeUInt32BE(100000,16);bomb.writeUInt32BE(100000,20);
 let c=0xffffffff;for(const b of bomb.subarray(12,29)){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}
 bomb.writeUInt32BE((c^0xffffffff)>>>0,29);
 const s=await service(bomb,{format:'png',mimeType:'image/png'}),r=await s.dienst.ansicht(ref);
 assert.equal(r.success,false);assert.ok(['ansicht_limit','ansicht_nicht_darstellbar'].includes(r.fehlercode));
 assert.equal(s.a.stats().released,1);
});
test('stalled stream is destroyed at deadline and its retention hold is released',async()=>{
 const stream=new Readable({read(){}});
 const s=await service(pngFixture(),{lesen:async()=>stream}, {SYNAPSE_ASSET_PREVIEW_TIMEOUT_MS:'20'});
 const r=await s.dienst.ansicht(ref);assert.equal(r.fehlercode,'ansicht_limit');assert.equal(stream.destroyed,true);
 assert.equal(s.a.stats().released,1);
});
test('installed FFmpeg produces video standbild from synthetic MP4; original is unchanged',async()=>{
 const f=await fixture(),file=join(f.root,'synthetic.mp4');
 execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=16x8:d=0.2',
  '-threads','1','-c:v','mpeg4','-y',file],{timeout:15000});
 const bytes=await fs.readFile(file),before=sha(bytes),a=adapter(bytes,{format:'mp4',mimeType:'video/mp4'});
 const dienst=new AssetAnsichtDienst({konfiguration:f.cfg,speicher:f.speicher,db:noDb});dienst.registriereQuellenAdapter('reverse',a);
 const r=await dienst.ansicht(ref);assert.equal(r.success,true,JSON.stringify(r));
 assert.equal(decodeOwnPng(r.png).w,16);assert.equal(sha(await fs.readFile(file)),before);
});
test('no installed renderer gives ansicht_nicht_darstellbar; time/RAM subprocess bounds are configured',async()=>{
 const s=await service(pngFixture(),{}, {SYNAPSE_ASSET_PREVIEW_FFMPEG:'/nonexistent-p13-a14'});
 const r=await s.dienst.ansicht(ref);assert.equal(r.fehlercode,'ansicht_nicht_darstellbar');assert.equal(r.link_rueckfall.id,ref.id);
 assert.equal(s.cfg.vorschau.maxFrames,1);assert.equal(s.cfg.vorschau.maxDauerMs,12000);
 assert.throws(()=>ladeAssetKonfiguration({SYNAPSE_ASSET_PREVIEW_TIMEOUT_MS:'0'}));
});
test('synapse_test project adapter/cache/retention uses own project and survives service recreation', {skip:!process.env.DATABASE_URL},async()=>{
 const url=new URL(process.env.DATABASE_URL);
 assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
 const pg=createRequire(new URL('../package.json',import.meta.url))('pg');
 const schema='p13_a14_'+randomUUID().replaceAll('-',''),project='p13_a14_'+randomUUID().replaceAll('-','');
 let admin,created=false;
 async function connection(){
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
  assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
  await c.query('SET search_path TO '+schema+',public');
  return {query:(s,v)=>c.query(s,v),release:()=>c.end()};
 }
 try{
  admin=await connection();await admin.query('CREATE SCHEMA '+schema);created=true;
  for(const name of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql','100_asset_konflikte.sql']){
   const sql=await fs.readFile(new URL('../src/db/schema-sql/'+name,import.meta.url),'utf8');await admin.query(sql);
  }
  const db={connect:connection,async query(sql,values){const c=await connection();try{return await c.query(sql,values);}finally{await c.release();}}};
  const f=await fixture(),bytes=await kodiereAnsichtPng(Buffer.from([255,0,0,255]),1,1,limits);
  const kern=new AssetUploadKern({db,speicher:f.speicher,konfiguration:f.cfg}),ctx={bereich:'projekt',ziel_ref:project,host_id:'p13-a14-test'};
  const u=await kern.erstellen(ctx,{logischer_pfad:'red.png',storage_kind:'assets',groesse:bytes.length,sha256:sha(bytes),basis_revision:'0',idempotency_key:randomUUID(),mime_type:'image/png',format:'png'});
  await kern.teil(ctx,u.id,0,bytes.length,[bytes]);const v=await kern.finalisieren(ctx,u.id);
  const request={bereich:'projekt',ziel_ref:project,id:v.asset_id,revision:v.revision};
  const first=await new AssetAnsichtDienst({db,speicher:f.speicher,konfiguration:f.cfg}).ansicht(request);
  assert.equal(first.success,true,JSON.stringify(first));assert.equal(first.cacheTreffer,false);
  const second=await new AssetAnsichtDienst({db,speicher:f.speicher,konfiguration:f.cfg}).ansicht(request);
  assert.equal(second.success,true);assert.equal(second.cacheTreffer,true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asset_retention_referenzen WHERE released_at IS NULL')).rows[0].n,0);
  assert.equal(sha(await fs.readFile(join(f.cfg.speicher.root,project,'assets','red.png'))),sha(bytes));
  assert.equal((await new AssetAnsichtDienst({db,speicher:f.speicher,konfiguration:f.cfg}).ansicht({...request,ziel_ref:'wrong-project'})).fehlercode,'ansicht_quelle_fehlt');
 }finally{if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin?.release();}
});
