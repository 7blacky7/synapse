/** W3 RV5/RV33: synthetic bytes, isolated PG schema, own temporary root. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
process.env.SYNAPSE_API_FEATURES='reverse_bibliothek';
const require=createRequire(new URL('../package.json',import.meta.url));
const {Pool}=require('pg');
const {ReverseEingang,katalogisiereReverseOrdner,reverseDateiSpeicherAdresse}=await import('../dist/services/reverse-eingang.js');
const {reverseGruppieren,reverseArchivMagic,reverseOrdnerFingerabdruck}=await import('../dist/services/reverse-gruppierung.js');
const {ladeAssetKonfiguration}=await import('../dist/config/asset-konfig.js');
const {ShareScanner}=await import('../dist/services/share-scanner.js');
const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
const {ASSET_UPLOAD_SCHEMA_SQL}=await import('../dist/db/asset-upload-schema.js');
const {createReverseToolService}=await import('../dist/services/reverse-tool.js');
const {API_CONTRACT_HEADER}=await import('../dist/index.js');
const {createReverseEingangRoutes}=await import('../../rest-api/dist/routes/reverse-eingang.js');
const apiRequire=createRequire(new URL('../../rest-api/package.json',import.meta.url));
const Fastify=apiRequire('fastify');
const hash=b=>createHash('sha256').update(b).digest('hex');
const file=(rel_pfad,b)=>({rel_pfad,groesse:Buffer.byteLength(b),sha256:hash(b)});
test('RV5/RV33 real DB, storage and HTTP contract',async t=>{
 const root=await mkdtemp(join(tmpdir(),'p18-rv5-rv33-'));
 const schema='p18_rv5_'+randomUUID().replaceAll('-','');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:8});
 const connect=async()=>{const c=await pool.connect();await c.query('SET search_path TO "'+schema+'",public');return c;};
 const db={connect,query:async(...a)=>{const c=await connect();try{return await c.query(...a);}finally{c.release();}}};
 let app;
 try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'synapse_test');
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await db.query('CREATE TABLE asset_upload_sitzungen (LIKE public.asset_upload_sitzungen INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE asset_files (LIKE public.asset_files INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE work_jobs(id uuid PRIMARY KEY)');
  await db.query(ASSET_UPLOAD_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);await db.query(REVERSE_SCHEMA_SQL);
  const cfg=ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
  const eingang=new ReverseEingang({db,konfiguration:cfg});
  const ctx=r=>({bereich:'reverse',ziel_ref:r.ziel_ref,host_id:'fake-daemon'});
  const announce=async(p,b)=>eingang.fundstellen('fake-daemon',[file(p,b)]);
  const upload=async(p,b)=>{
   const result=await announce(p,b),r=result.dateien[0];
   if(r.status==='upload_noetig'){if(b.length)await eingang.upload.teil(ctx(r),r.upload_id,0,b.length,[b]);await eingang.finalisieren(ctx(r),r.upload_id);}
   return {...r,reverse_id:result.reverse_ids[0]};
  };
  const media=async rid=>(await db.query('SELECT * FROM reverse_medien WHERE eintrag_id=$1 ORDER BY position',[rid])).rows;
  await t.test('two CDs natural order, optional SUB, missing CUE target and magic priority',()=>{
   const files=['Game/cd10.ccd','Game/cd10.img','Game/cd2.ccd','Game/cd2.img'].map((p,i)=>file(p,Buffer.from(String(i))));
   const g=reverseGruppieren(files)[0];assert.equal(g.medien.length,2);assert.equal(g.medien[0].haupt,'Game/cd2.ccd');
   assert.deepEqual(g.medien.map(m=>m.fehlend),[[],[]]);
   const sub=reverseGruppieren([...files,file('Game/cd2.sub',Buffer.from('sub'))])[0];assert.equal(sub.medien[0].dateien.length,3);
   assert.deepEqual(reverseGruppieren([{...file('Broken/a.cue',Buffer.from('cue')),referenzen:['missing.bin']}])[0].medien[0].fehlend,['Broken/missing.bin']);
   for(const hex of ['504b0304','377abcaf271c','526172211a0700']){
    const bytes=Buffer.from(hex,'hex');assert.ok(reverseArchivMagic(bytes));
    assert.equal(reverseGruppieren([{...file('magic.iso',bytes),kopf:bytes}])[0].medien[0].art,'archiv');
   }
   const tar=Buffer.alloc(512);tar.write('ustar',257);assert.equal(reverseArchivMagic(tar),'tar');
   const mixed=reverseGruppieren([file('Mix/disc.iso',Buffer.from('iso')),file('Mix/game.exe',Buffer.from('exe'))])[0];
   assert.ok(mixed.medien.every(m=>m.confidence<=.7&&m.alternativen.length));
  });
  await t.test('path, host, quota and duplicate rejection before acceptance',async()=>{
   for(const p of ['../outside','/absolute','C:\\outside','//server/share'])await assert.rejects(announce(p,Buffer.from('x')));
   await assert.rejects(eingang.fundstellen('fake-daemon',[{...file('bad',Buffer.from('x')),host:'other'}]),e=>e.code==='host_ungueltig');
   const small=new ReverseEingang({db,konfiguration:{...cfg,reverse:{...cfg.reverse,maxProjektBytes:1}}});
   await assert.rejects(small.fundstellen('fake-daemon',[file('Quota/a',Buffer.from('xx'))]),e=>e.code==='quote');
   assert.equal((await db.query("SELECT count(*)::int n FROM reverse_eintraege WHERE titel='Quota'")).rows[0].n,0);
  });
  let folder,original;
  await t.test('resumable upload and duplicate chunks survive new service instance',async()=>{
   const bytes=Buffer.from('synthetic executable bytes');
   original=bytes;
   const r=(await announce('Installed/game.exe',bytes)).dateien[0];
   const first=bytes.subarray(0,8);
   await eingang.upload.teil(ctx(r),r.upload_id,0,first.length,[first]);
   const reboot=new ReverseEingang({db,konfiguration:cfg});
   const resumed=(await reboot.fundstellen('fake-daemon',[file('Installed/game.exe',bytes)])).dateien[0];
   assert.equal(resumed.upload_id,r.upload_id);assert.equal(Number(resumed.offset),8);
   await assert.rejects(reboot.upload.teil(ctx(r),r.upload_id,0,first.length,[first]),e=>e.code==='offset_konflikt');
   await reboot.upload.teil(ctx(r),r.upload_id,8,bytes.length-8,[bytes.subarray(8)]);
   await reboot.finalisieren(ctx(r),r.upload_id);
   assert.equal((await announce('Installed/game.exe',bytes)).dateien[0].status,'bekannt');
   folder=r.reverse_id;
  });
  await t.test('folder upload, path-preserving catalog and reference dedup',async()=>{
   await upload('Installed/Data/config.dat',Buffer.from('settings'));
   const m=await media(folder);assert.equal(m.length,1);assert.equal(m[0].art,'ordner');assert.equal(m[0].status,'vollstaendig');
   await katalogisiereReverseOrdner(db,folder);
   const rows=(await db.query('SELECT * FROM reverse_dateien WHERE eintrag_id=$1 ORDER BY pfad',[folder])).rows;
   assert.deepEqual(rows.map(r=>r.pfad),['Data/config.dat','game.exe']);
   const address=await reverseDateiSpeicherAdresse(db,folder,String(rows[1].id));
   assert.equal(address.sha256,hash(original));
   const duplicate=await upload('Another/game.exe',original);assert.equal(duplicate.status,'bekannt');
   assert.equal((await db.query('SELECT count(*)::int n FROM reverse_eingang_bytes WHERE sha256=$1',[hash(original)])).rows[0].n,1);
   assert.equal(Number((await db.query('SELECT refcount FROM reverse_eingang_bytes WHERE sha256=$1',[hash(original)])).rows[0].refcount),2);
   const renamed=await upload('Renamed/new.exe',original);assert.equal(renamed.status,'bekannt');
   const fp=reverseOrdnerFingerabdruck([file('x/b',Buffer.from('b')),file('x/a',Buffer.from('a'))],'x');
   assert.equal(fp,reverseOrdnerFingerabdruck([file('y/a',Buffer.from('a')),file('y/b',Buffer.from('b'))],'y'));
  });
  await t.test('confirmed edition remains immutable when one file changes',async()=>{
   const tool=createReverseToolService({pool:db});
   const confirmed=await tool.ausfuehren({action:'bestaetigen',agent_id:'koordinator',reverse_id:folder});
   assert.equal(confirmed.success,true,JSON.stringify(confirmed));
   const next=await upload('Installed/game.exe',Buffer.from('new executable edition'));
   assert.notEqual(next.reverse_id,folder);
   assert.equal((await db.query('SELECT sha256 FROM reverse_eingang_dateien WHERE eintrag_id=$1 AND rel_pfad=$2',[folder,'Installed/game.exe'])).rows[0].sha256,hash(original));
   assert.equal((await db.query('SELECT count(*)::int n FROM reverse_eingang_dateien WHERE eintrag_id=$1',[next.reverse_id])).rows[0].n,2);
  });
  await t.test('real CUE parsing, missing required file and CCD optional SUB',async()=>{
   const cue=await upload('Missing/disc.cue',Buffer.from('FILE "absent.bin" BINARY\n TRACK 01 MODE1/2352\n'));
   let m=(await media(cue.reverse_id))[0];assert.equal(m.status,'unvollstaendig');assert.equal(m.fehlercode,'beschaedigt');
   await upload('Missing/absent.bin',Buffer.from('synthetic track'));
   m=(await media(cue.reverse_id))[0];assert.equal(m.status,'vollstaendig');
   const ccd=await upload('Two/cd1.ccd',Buffer.from('[CloneCD]\nVersion=3'));
   await upload('Two/cd1.img',Buffer.from('disc1'));
   await upload('Two/cd2.ccd',Buffer.from('[CloneCD]\nVersion=3\nCD=2'));
   await upload('Two/cd2.img',Buffer.from('disc2'));
   const ms=await media(ccd.reverse_id);assert.equal(ms.length,2);assert.ok(ms.every(m=>m.status==='vollstaendig'));
  });
  await t.test('hash mismatch never publishes ready bytes',async()=>{
   const expected=Buffer.from('good'),r=(await announce('Bad/hash.iso',expected)).dateien[0];
   await eingang.upload.teil(ctx(r),r.upload_id,0,4,[Buffer.from('evil')]);
   await assert.rejects(eingang.finalisieren(ctx(r),r.upload_id));
   assert.notEqual((await db.query('SELECT status FROM reverse_eingang_bytes WHERE sha256=$1',[hash(expected)])).rows[0].status,'ready');
  });
  await t.test('case collisions are explicit and archives recognized by bytes',async()=>{
   await upload('Case/Game.EXE',Buffer.from('upper'));
   const r=await upload('Case/game.exe',Buffer.from('lower'));
   assert.ok((await media(r.reverse_id)).some(m=>m.fehlercode));
   const zip=await upload('packed.weird',Buffer.from('504b030400000000','hex'));
   assert.equal((await media(zip.reverse_id))[0].art,'archiv');
  });
  await t.test('status snapshot freezes rows, binds host and expires',async()=>{
   const page=await eingang.status('fake-daemon',{limit:1});assert.ok(page.cursor);
   const late=await upload('Late/new.exe',Buffer.from('late'));
   let cursor=page.cursor,all=[...page.dateien];
   while(cursor){const p=await eingang.status('fake-daemon',{cursor,limit:2});all.push(...p.dateien);cursor=p.cursor;}
   assert.ok(!all.some(r=>r.reverse_id===late.reverse_id));
   await assert.rejects(eingang.status('other',{cursor:page.cursor}),e=>e.code==='cursor_ungueltig');
   await db.query("UPDATE reverse_fund_snapshots SET lease_bis=clock_timestamp()-interval '1 second'");
   await assert.rejects(eingang.status('fake-daemon',{cursor:page.cursor}),e=>e.code==='manifest_abgelaufen');
  });
  await t.test('_direkt waits for stability and moves original inode',async()=>{
   await mkdir(join(root,'_direkt'),{recursive:true});
   const source=join(root,'_direkt','direct.iso');await writeFile(source,Buffer.from('direct unique image'));
   const before=await stat(source);const checkpoints=new Map();
   const scanner=new ShareScanner({konfiguration:cfg,store:{laden:async k=>checkpoints.get(k)??null,speichern:async(k,v)=>checkpoints.set(k,structuredClone(v))}});
   let calls=0;
   scanner.registrieren('reverse',{wurzeln:async()=>[{id:'test',pfad:join(root,'_direkt')}],datei:async d=>{calls++;return eingang.direkt(d);}});
   await scanner.durchlauf();assert.equal(calls,0);await stat(source);
   await scanner.durchlauf();assert.equal(calls,1);await assert.rejects(stat(source),e=>e.code==='ENOENT');
   const row=(await db.query("SELECT * FROM reverse_eingang_bytes WHERE host_id='unraid_eingang'")).rows[0];
   assert.equal(row.status,'ready');
   const target=join(root,row.ziel_ref,'original','dateien',row.logischer_pfad);
   assert.equal((await stat(target)).ino,before.ino);
  });
  await t.test('HTTP daemon auth, contract, host scope, actual stream and finalization',async()=>{
   app=Fastify();
   await app.register(createReverseEingangRoutes({eingang,validateToken:async token=>token==='invalid'?null:{kind:token==='user'?'user':'service',scope:'daemon',token_hash:token},daemonHost:async token=>token==='unbound'?null:token==='other'?'other':'fake-daemon'}));
   const headers={authorization:'Bearer ok',[API_CONTRACT_HEADER]:'1'};
   const request=(method,url,payload,h=headers)=>app.inject({method,url,payload,headers:h});
   assert.equal((await request('GET','/api/reverse/fundstellen',undefined,{})).statusCode,401);
   assert.equal((await request('GET','/api/reverse/fundstellen',undefined,{...headers,authorization:'Bearer user'})).statusCode,403);
   assert.equal((await request('GET','/api/reverse/fundstellen',undefined,{authorization:'Bearer ok'})).statusCode,426);
   assert.equal((await request('GET','/api/reverse/fundstellen',undefined,{...headers,authorization:'Bearer unbound'})).statusCode,403);
   assert.equal((await request('POST','/api/reverse/fundstellen',{host:'forged',dateien:[file('http.iso',Buffer.from('http'))]})).statusCode,403);
   const bytes=Buffer.from('http image stream');
   const post=await request('POST','/api/reverse/fundstellen',{dateien:[file('http.iso',bytes)]});
   assert.equal(post.statusCode,200,post.body);const r=post.json().dateien[0],base='/api/reverse/'+r.ziel_ref+'/uploads/'+r.upload_id;
   assert.equal((await request('GET',base,undefined,{...headers,authorization:'Bearer other'})).statusCode,403);
   const chunk=await request('PUT',base+'/chunk?offset=0',bytes,{...headers,'content-type':'application/octet-stream','content-length':String(bytes.length)});
   assert.equal(chunk.statusCode,200,chunk.body);
   const final=await request('POST',base+'/finalisieren');assert.equal(final.statusCode,200,final.body);
   assert.equal((await request('GET','/api/reverse/fundstellen')).statusCode,200);
   assert.equal((await request('GET','/api/reverse/eingang-spiegel')).statusCode,404);
  });
  await t.test('explicit reinterpretation catalogs a complete image as folder',async()=>{
   const r=await upload('Reinterpret/medium.iso',Buffer.from('synthetic reinterpretation'));
   const before=(await media(r.reverse_id))[0];assert.equal(before.art,'image');
   const tool=createReverseToolService({pool:db});
   const result=await tool.ausfuehren({action:'bestaetigen',agent_id:'koordinator',reverse_id:r.reverse_id,medien:[{id:String(before.id),art:'ordner'}]});
   assert.equal(result.success,true,JSON.stringify(result));
   assert.equal((await media(r.reverse_id))[0].art,'ordner');
   assert.equal((await db.query('SELECT pfad FROM reverse_dateien WHERE eintrag_id=$1',[r.reverse_id])).rows[0].pfad,'medium.iso');
   const changedAgain=await tool.ausfuehren({action:'bestaetigen',agent_id:'koordinator',reverse_id:r.reverse_id,medien:[{id:String(before.id),art:'image'}]});
   assert.equal(changedAgain.fehlercode,'ziel_belegt');
  });
  await t.test('PG stores metadata, never bytea in intake tables',async()=>{
   const rows=(await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND data_type='bytea'",[schema])).rows;
   assert.deepEqual(rows,[]);
  });
 }finally{
  if(app)await app.close();
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
  await pool.end();await rm(root,{recursive:true,force:true});
 }
});
