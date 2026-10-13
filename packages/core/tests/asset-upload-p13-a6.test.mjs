/** P13-T24/A6: eigenes synapse_test:5433-Schema, DSN und DB vor jeder Testverbindung geprüft. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const pg=createRequire(new URL('../package.json',import.meta.url))('pg');
async function testClient(){
  const target=new URL(process.env.DATABASE_URL??'postgres://invalid/invalid');
  assert.equal(target.pathname,'/synapse_test');assert.equal(target.port,'5433');
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
  assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
  return {query:(sql,values)=>c.query(sql,values),end:()=>c.end()};
}
import {AssetSpeicher} from '../dist/services/asset-speicher.js';
import {ladeAssetKonfiguration} from '../dist/config/asset-konfig.js';
let api;
try{api=await import('../dist/services/asset-upload.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
test('A6 Uploadkern vorhanden (rote Altstandkontrolle)',()=>assert.equal(typeof api?.AssetUploadKern,'function'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const schema='p13_a6_'+randomUUID().replaceAll('-','');
let admin,root,cfg,pool;
before(async()=>{
  if(!api)return;
  admin=await testClient();
  await admin.query('CREATE SCHEMA '+schema);
  await admin.query('SET search_path TO '+schema+',public');
  for(const sql of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql'])await admin.query(await fs.readFile(new URL('../src/db/schema-sql/'+sql,import.meta.url),'utf8'));
  root=await fs.mkdtemp(join(tmpdir(),'p13-a6-kern-'));
  cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'projekt'),SYNAPSE_REVERSE_ROOT:join(root,'reverse')});
  pool={
    async connect(){const c=await testClient();await c.query('SET search_path TO '+schema+',public');return {...c,release:()=>c.end()};},
    async query(sql,values){const c=await this.connect();try{return await c.query(sql,values);}finally{await c.release();}},
  };
});
after(async()=>{if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}if(root)await fs.rm(root,{recursive:true,force:true});});
const ctx={bereich:'projekt',ziel_ref:'p13_a6',host_id:'daemon_fixture'};
const input=(path,bytes,key)=>({logischer_pfad:path,storage_kind:'assets',groesse:bytes.length,sha256:sha(bytes),basis_revision:'0',idempotency_key:key});
const kern=()=>new api.AssetUploadKern({db:pool,speicher:new AssetSpeicher({konfiguration:cfg}),konfiguration:cfg});
const run=(name,fn)=>test(name,{skip:!api},fn);
run('Resume über neuen Kern; zwei Finalisierer erzeugen genau eine Revision',async()=>{
  const bytes=Buffer.from('streamed-asset');const a=kern();
  const start=await a.erstellen(ctx,input('resume.png',bytes,'resume'));
  assert.equal((await a.erstellen(ctx,input('resume.png',bytes,'resume'))).id,start.id);
  await assert.rejects(a.erstellen(ctx,input('different.png',bytes,'resume')),e=>e.code==='idempotency_konflikt');
  await a.teil(ctx,start.id,0,4,[bytes.subarray(0,4)]);
  const b=kern();assert.equal((await b.status(ctx,start.id)).offset,4);
  await assert.rejects(b.teil(ctx,start.id,0,4,[bytes.subarray(0,4)]),e=>e.code==='offset_konflikt');
  await b.teil(ctx,start.id,4,bytes.length-4,[bytes.subarray(4)]);
  const results=await Promise.allSettled([a.finalisieren(ctx,start.id),b.finalisieren(ctx,start.id)]);
  assert.ok(results.some(r=>r.status==='fulfilled'));
  const done=await b.finalisieren(ctx,start.id);
  assert.equal(done.status,'finalisiert');assert.equal(done.revision,'1');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_revisionen')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_aenderungen')).rows[0].n,1);
  assert.equal(await fs.readFile(join(cfg.speicher.root,'p13_a6','assets','resume.png'),'utf8'),bytes.toString());
  await assert.rejects(a.status({...ctx,ziel_ref:'foreign'},start.id),e=>e.code==='scope_verboten');
  await assert.rejects(a.status({...ctx,host_id:'foreign'},start.id),e=>e.code==='scope_verboten');
});
run('Vollhashfehler verwirft Sitzung; Abbruch lässt Offset unverändert',async()=>{
  const a=kern(),bytes=Buffer.from('right');
  const start=await a.erstellen(ctx,input('hash.png',bytes,'hash'));
  async function* broken(){yield Buffer.from('r');throw new Error('disconnect');}
  await assert.rejects(a.teil(ctx,start.id,0,5,broken()),/disconnect/);
  assert.equal((await a.status(ctx,start.id)).offset,0);
  await a.teil(ctx,start.id,0,5,[Buffer.from('wrong')]);
  await assert.rejects(a.finalisieren(ctx,start.id),e=>e.code==='hash_falsch');
  assert.equal((await a.status(ctx,start.id)).status,'fehler');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM asset_files WHERE file_path='hash.png'")).rows[0].n,0);
});
run('Reverse registriert serverseitigen Finalisierer am selben Kern',async()=>{
  const a=kern(),r={bereich:'reverse',ziel_ref:'rev-test-a1b2c3',host_id:'daemon_fixture'};
  let prepared=0,committed=0;
  a.registriereFinalisierer('reverse',{
    basis:async()=>({sha256:null}),
    vorbereiten:async()=>{prepared++;},
    commit:async(_ctx,_session,op)=>{committed++;return {asset_id:'reverse-original',revision:'1',storage_key:op.storage_key};},
  });
  const bytes=Buffer.from('iso');const start=await a.erstellen(r,input('disc.zip',bytes,'reverse'));
  await a.teil(r,start.id,0,3,[bytes]);const done=await a.finalisieren(r,start.id);
  assert.equal(done.status,'finalisiert');assert.equal(prepared,1);assert.equal(committed,1);
  assert.equal(await fs.readFile(join(cfg.speicher.reverseRoot,r.ziel_ref,'assets','disc.zip'),'utf8'),'iso');
});

run('Revision- und Range-Download bleibt bei neuem Publish bytegleich',async()=>{
  const a=kern(),old=Buffer.from('previous');
  const first=await a.erstellen(ctx,input('download.png',old,'download1'));
  await a.teil(ctx,first.id,0,old.length,[old]);
  const v1=await a.finalisieren(ctx,first.id);
  const next=Buffer.from('next-bytes');
  const second=await a.erstellen(ctx,{...input('download.png',next,'download2'),basis_revision:'1'});
  await a.teil(ctx,second.id,0,next.length,[next]);await a.finalisieren(ctx,second.id);
  const result=await a.bytes(ctx,{asset_id:v1.asset_id,revision:'1'},{offset:1,groesse:4});
  let data='';for await(const b of result.stream)data+=b;
  assert.equal(data,'revi');assert.equal(result.sha256,sha(old));assert.equal(result.gesamt,old.length);
  await assert.rejects(a.bytes({...ctx,ziel_ref:'foreign'},{asset_id:v1.asset_id,revision:'1'}),e=>e.code==='asset_fehlt');
  await assert.rejects(a.bytes(ctx,{asset_id:v1.asset_id,revision:'1'},{offset:100,groesse:1}),e=>e.code==='range_ungueltig');
});
run('PG-Ausfall nach FS-Publish hält Ready zurück, explizite Recovery stellt Basis her',async()=>{
  const a=kern(),old=Buffer.from('old-recover'),next=Buffer.from('new-recover');
  const first=await a.erstellen(ctx,input('recover.png',old,'recover1'));
  await a.teil(ctx,first.id,0,old.length,[old]);await a.finalisieren(ctx,first.id);
  let crash=true;
  const broken={...pool,async connect(){
    const c=await pool.connect();return {...c,async query(sql,values){
      if(crash && sql.startsWith('INSERT INTO asset_revisionen')){crash=false;throw new Error('simulated PG commit failure');}
      return c.query(sql,values);
    }};
  }};
  const b=new api.AssetUploadKern({db:broken,speicher:new AssetSpeicher({konfiguration:cfg}),konfiguration:cfg});
  const second=await b.erstellen(ctx,{...input('recover.png',next,'recover2'),basis_revision:'1'});
  await b.teil(ctx,second.id,0,next.length,[next]);
  await assert.rejects(b.finalisieren(ctx,second.id),/simulated PG commit failure/);
  assert.equal((await pool.query("SELECT storage_status FROM asset_files WHERE project=$1 AND file_path='recover.png'",[ctx.ziel_ref])).rows[0].storage_status,'prepared');
  await pool.query("UPDATE asset_upload_sitzungen SET finalisierer_bis=clock_timestamp()-interval '1 second' WHERE id=$1",[second.id]);
  await assert.rejects(a.recovery(ctx,second.id,{istVerwaist:async()=>false}),e=>e.code==='recovery_unbestaetigt');
  await a.recovery(ctx,second.id,{istVerwaist:async()=>true});
  const row=(await pool.query("SELECT storage_status,transport_revision FROM asset_files WHERE project=$1 AND file_path='recover.png'",[ctx.ziel_ref])).rows[0];
  assert.equal(row.storage_status,'ready');assert.equal(row.transport_revision,'1');
  assert.equal(await fs.readFile(join(cfg.speicher.root,'p13_a6','assets','recover.png'),'utf8'),old.toString());
});


run('Crossscope idempotency keys are serialized and conflicting ownership never accepted',async()=>{
 const a=kern(),b=kern(),bytes=Buffer.from('one'),key=randomUUID();
 const out=await Promise.allSettled([a.erstellen(ctx,input('cross.png',bytes,key)),b.erstellen({...ctx,ziel_ref:'p13_a6_other',host_id:'foreign'},input('cross.png',bytes,key))]);
 assert.equal(out.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(out.filter(x=>x.status==='rejected'&&x.reason.code==='idempotency_konflikt').length,1);
});
run('Configured transfer concurrency across instances, stream timeout and immutable confirmed offsets',async()=>{
 const limits=structuredClone(cfg);limits.speicher.parallelTransfers=1;limits.speicher.timeoutMs=1000;
 const a=new api.AssetUploadKern({db:pool,konfiguration:limits}),b=new api.AssetUploadKern({db:pool,konfiguration:limits});
 const first=await a.erstellen(ctx,input('parallel1.png',Buffer.from('x'),randomUUID()));
 const second=await b.erstellen(ctx,input('parallel2.png',Buffer.from('y'),randomUUID()));
 let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
 async function* slow(){enter();await held;yield Buffer.from('x');}
 const pending=a.teil(ctx,first.id,0,1,slow());await entered;
 await assert.rejects(b.teil(ctx,second.id,0,1,[Buffer.from('y')]),e=>e.code==='transfer_limit');
 release();await pending;
 await b.teil(ctx,second.id,0,1,[Buffer.from('y')]);
 // A new independent session times out while waiting for input, then can safely resume after lease renewal.
 const third=await a.erstellen(ctx,input('timeout.png',Buffer.from('z'),randomUUID()));
 let abort;const blocker=new Promise(r=>abort=r);
 async function* stuck(){await blocker;yield Buffer.from('z');}
 const work=a.teil(ctx,third.id,0,1,stuck());
 // Keep an explicit timer alive because production deadline timers are correctly unref'd.
 const keep=setTimeout(()=>{},1500);
 try{await assert.rejects(work,e=>e.code==='transfer_timeout');}finally{abort();clearTimeout(keep);}
 assert.equal((await a.status(ctx,third.id)).offset,0);
 await pool.query("UPDATE asset_upload_sitzungen SET lease_bis=clock_timestamp()+interval '5 seconds' WHERE id=$1",[third.id]);
 await a.teil(ctx,third.id,0,1,[Buffer.from('z')]);assert.equal((await a.status(ctx,third.id)).offset,1);
});
run('Reverse adapter serves revision bytes through the same download protocol',async()=>{
 const a=kern(),r={bereich:'reverse',ziel_ref:'rev-download',host_id:'daemon_fixture'},bytes=Buffer.from('archive');
 let result;
 a.registriereFinalisierer('reverse',{
  basis:async()=>({sha256:null}),
  vorbereiten:async()=>{},
  commit:async(_c,_s,op)=>{result={asset_id:'original-id',revision:'1',storage_key:op.storage_key};return result;},
  download:async(c,ref)=>{assert.equal(ref.asset_id,'original-id');return {adresse:{bereich:'reverse',ziel_ref:c.ziel_ref,storage_kind:'assets',logischer_pfad:'original.zip'},storage_key:result.storage_key,groesse:bytes.length,sha256:sha(bytes),mime_type:'application/zip'};},
 });
 const u=await a.erstellen(r,input('original.zip',bytes,randomUUID()));await a.teil(r,u.id,0,bytes.length,[bytes]);await a.finalisieren(r,u.id);
 const d=await a.bytes(r,{asset_id:'original-id',revision:'1'},{offset:1,groesse:3});let out='';for await(const b of d.stream)out+=b;
 assert.equal(out,'rch');assert.equal(d.sha256,sha(bytes));
});

