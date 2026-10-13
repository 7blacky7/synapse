/**
 * P13-T21/A3: nur synthetische Bytes in eigener temporärer Testwurzel.
 * Kein Live-Dataset, keine DB-Verbindung; PG-Prepare/Commit werden als
 * explizite serverseitige Callbacks mit Absturz-/Recovery-Zuständen geprüft.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const sha = b => createHash('sha256').update(b).digest('hex');
let api;
try { api=await import('../dist/services/asset-speicher.js'); }
catch(e) { if(e.code!=='ERR_MODULE_NOT_FOUND') throw e; }
test('A3 Speicheradapter vorhanden (rote Altstand-Kontrolle)',()=>assert.ok(api?.AssetSpeicher,'AssetSpeicher fehlt'));
let root,config;
const ref={bereich:'projekt',ziel_ref:'p13_a3',storage_kind:'assets',logischer_pfad:'guide/pic/image.png'};
before(async()=>{
  root=await fs.mkdtemp(join(tmpdir(),'p13-a3-'));
  await import('../dist/asset-intel/index.js');
  const { ladeAssetKonfiguration }=await import('../dist/config/asset-konfig.js');
  config=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'projekt'),SYNAPSE_REVERSE_ROOT:join(root,'reverse')});
});
after(async()=>{if(root)await fs.rm(root,{recursive:true,force:true});});
const staged=async(s,bytes,r=ref)=>s.stage(r,[bytes],{groesse:bytes.length,sha256:sha(bytes)});
const publish=async(s,stage,basis=null,overrides={})=>s.publish(stage,{basisSha256:basis,prepare:async()=>{},commit:async()=>{},...overrides});
const run=(name,fn)=>test(name,{skip:!api},fn);
run('Projektlayout 1:1, Range/Stream und Reverse getrennt',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const bytes=Buffer.from('abcdefgh');
  const out=await publish(s,await staged(s,bytes));
  assert.equal(out.storage_key,'p13_a3/assets/guide/pic/image.png');
  assert.equal((await s.readRange(ref,2,3)).toString(),'cde');
  let streamed=''; for await(const chunk of await s.readStream(ref))streamed+=chunk;
  assert.equal(streamed,'abcdefgh');
  const rr={...ref,bereich:'reverse',ziel_ref:'rev-fixture-a1b2c3'};
  await publish(s,await staged(s,Buffer.from('reverse'),rr));
  assert.equal((await s.readRange(rr,0,7)).toString(),'reverse');
  assert.equal((await s.readRange(ref,0,8)).toString(),'abcdefgh');
});
run('Pfadschutz: Traversal, absolut, UNC, Drive, NUL, kodiert und NFC',async()=>{
  for(const p of ['../x','a/../x','/tmp/x','C:/x','C:x','\\\\host\\share','x\0y','%2e%2e/x','%252e%252e%252fx','%00x']) assert.throws(()=>api.normalisiereSpeicherPfad(p));
  assert.equal(api.normalisiereSpeicherPfad('cafe\u0301/image.png'),'café/image.png');
  const s=new api.AssetSpeicher({konfiguration:config});
  await assert.rejects(staged(s,Buffer.from('x'),{...ref,ziel_ref:'../foreign'}),e=>e.code==='pfad_ungueltig');
});
run('Symlinkausbruch bleibt ohne Zugriff auf fremde Bytes',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const outside=join(root,'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside,'keep'),'untouched');
  await fs.mkdir(join(config.speicher.root,'p13_a3','assets'),{recursive:true});
  await fs.symlink(outside,join(config.speicher.root,'p13_a3','assets','escape'));
  await assert.rejects(publish(s,await staged(s,Buffer.from('bad'),{...ref,logischer_pfad:'escape/new'})),e=>e.code==='pfad_ungueltig');
  assert.deepEqual(await fs.readdir(outside),['keep']);
  assert.equal(await fs.readFile(join(outside,'keep'),'utf8'),'untouched');
  await fs.unlink(join(config.speicher.root,'p13_a3','assets','escape'));
});
run('Hash-/Größenfehler und Disk-full lassen alte Bytes unberührt',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,logischer_pfad:'failure.bin'};
  await publish(s,await staged(s,Buffer.from('old'),r));
  await assert.rejects(s.stage(r,[Buffer.from('new')],{groesse:3,sha256:'f'.repeat(64)}),e=>e.code==='hash_falsch');
  await assert.rejects(s.stage(r,[Buffer.from('too-long')],{groesse:3,sha256:sha('new')}),e=>e.code==='groesse_falsch');
  const full=new api.AssetSpeicher({konfiguration:config,schreiben:async()=>{throw Object.assign(new Error('simulated disk full'),{code:'ENOSPC'});}});
  await assert.rejects(staged(full,Buffer.from('new'),r),e=>e.code==='ENOSPC');
  assert.equal((await s.readRange(r,0,3)).toString(),'old');
});
run('Atomischer Publish bewahrt vorherige Revision',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,logischer_pfad:'revisions.bin'};
  await publish(s,await staged(s,Buffer.from('old'),r));
  let prepared=false;
  const out=await publish(s,await staged(s,Buffer.from('new'),r),sha('old'),{prepare:async()=>{prepared=true;},commit:async op=>{assert.equal(prepared,true);assert.equal((await s.readRange(r,0,3)).toString(),'new');assert.equal(op.sha256,sha('new'));}});
  assert.ok(out.vorheriger_storage_key);
  assert.equal((await s.readRevisionRange(r,out.vorheriger_storage_key,0,3)).toString(),'old');
  assert.equal((await s.readRange(r,0,3)).toString(),'new');
});
run('Zwei gleichzeitige Publish: eine gewinnt, andere Konflikt',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,logischer_pfad:'race.bin'};
  await publish(s,await staged(s,Buffer.from('old'),r));
  const a=await staged(s,Buffer.from('aaa'),r),b=await staged(s,Buffer.from('bbb'),r);
  const results=await Promise.allSettled([publish(s,a,sha('old'),{commit:async()=>new Promise(resolve=>setTimeout(resolve,40))}),publish(s,b,sha('old'))]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(results.filter(v=>v.status==='rejected')[0].reason.code,'konflikt');
  assert.ok(['aaa','bbb'].includes((await s.readRange(r,0,3)).toString()));
});
run('Crash nach FS-Publish vor PG-Commit: explizite Recovery rollback',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,logischer_pfad:'recover-rollback.bin'};
  await publish(s,await staged(s,Buffer.from('old'),r));
  await assert.rejects(publish(s,await staged(s,Buffer.from('new'),r),sha('old'),{commit:async()=>{throw new Error('PG unavailable');}}));
  const fresh=new api.AssetSpeicher({konfiguration:config});
  const recovered=await fresh.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'});
  assert.ok(recovered.some(v=>v.status==='rolled_back'));
  assert.equal((await fresh.readRange(r,0,3)).toString(),'old');
});
run('Crash nach PG-Commit: Recovery bestätigt vorhandene neue Bytes',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,logischer_pfad:'recover-commit.bin'};
  let committed=false;
  await publish(s,await staged(s,Buffer.from('old'),r));
  await assert.rejects(publish(s,await staged(s,Buffer.from('new'),r),sha('old'),{commit:async()=>{committed=true;throw new Error('crash after PG');}}));
  const fresh=new api.AssetSpeicher({konfiguration:config});
  const recovered=await fresh.recovery(r,{istVerwaist:async()=>true,pgStand:async()=>committed?'committed':'rollback'});
  assert.ok(recovered.some(v=>v.status==='committed'));
  assert.equal((await fresh.readRange(r,0,3)).toString(),'new');
});
run('Recovery lässt aktive/verwaiste-unbestätigte Operationen stehen',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,logischer_pfad:'recover-active.bin'};
  await assert.rejects(publish(s,await staged(s,Buffer.from('new'),r),null,{commit:async()=>{throw new Error('pending');}}));
  assert.deepEqual(await s.recovery(r,{istVerwaist:async()=>false,pgStand:async()=>{throw new Error('must not run');}}),[]);
  assert.equal((await s.readRange(r,0,3)).toString(),'new');
});
run('Reverse-Layout-Erweiterung und projektweite Quote',async()=>{
  const cfg={...config,speicher:{...config.speicher,maxProjektBytes:2}};
  const s=new api.AssetSpeicher({konfiguration:cfg});
  const r={...ref,ziel_ref:'quota',logischer_pfad:'a'};
  await assert.rejects(publish(s,await staged(s,Buffer.from('abc'),r)),e=>e.code==='quote');
  const custom=new api.AssetSpeicher({konfiguration:config,layout:a=>a.bereich==='reverse'?a.ziel_ref+'/original/cd1/'+a.logischer_pfad:undefined});
  const rr={...ref,bereich:'reverse',ziel_ref:'rev-layout-a1b2c3',logischer_pfad:'disc.iso'};
  assert.equal((await publish(custom,await staged(custom,Buffer.from('iso'),rr))).storage_key,'rev-layout-a1b2c3/original/cd1/disc.iso');
});

run('Finales Journal plus verwaiste Sperre wird idempotent freigegeben',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,ziel_ref:'terminal',logischer_pfad:'file.bin'};
  const done=await publish(s,await staged(s,Buffer.from('old'),r));
  // Absturz nach dauerhaftem committed-Journal, unmittelbar vor Lock-Unlink.
  await fs.writeFile(join(config.speicher.root,'terminal','.intern','locks','publish'),done.id);
  const fresh=new api.AssetSpeicher({konfiguration:config});
  const rec=await fresh.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'committed'});
  assert.equal(rec[0].status,'committed');
  assert.deepEqual(await fresh.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'committed'}),[]);
  await publish(fresh,await staged(fresh,Buffer.from('new'),r),sha('old'));
});
run('Recovery wiederholt nach gesicherten Kopien ohne Datenverlust',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,ziel_ref:'retrycopy',logischer_pfad:'file.bin'};
  await publish(s,await staged(s,Buffer.from('old'),r));
  const st=await staged(s,Buffer.from('new'),r);
  await assert.rejects(publish(s,st,sha('old'),{commit:async()=>{throw new Error('pending');}}));
  const failed=join(config.speicher.root,'retrycopy','.intern','revisionen',st.id+'-abgebrochen');
  const temp=join(config.speicher.root,'retrycopy','.intern','staging',st.id+'-rollback');
  await fs.writeFile(failed,'wrong');
  await assert.rejects(s.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'}),e=>e.code==='hash_falsch');
  assert.equal(await fs.readFile(failed,'utf8'),'wrong');
  assert.equal((await s.readRange(r,0,3)).toString(),'new');
  await fs.writeFile(failed,'new');
  await fs.writeFile(temp,'old');
  const rec=await s.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'});
  assert.equal(rec[0].status,'rolled_back');
  assert.equal((await s.readRange(r,0,3)).toString(),'old');
  assert.deepEqual(await s.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'}),[]);
});
run('Änderung während Prepare wird ohne Überschreiben zum Konflikt',async()=>{
  const s=new api.AssetSpeicher({konfiguration:config});
  const r={...ref,ziel_ref:'directchange',logischer_pfad:'file.bin'};
  await publish(s,await staged(s,Buffer.from('old'),r));
  await assert.rejects(publish(s,await staged(s,Buffer.from('new'),r),sha('old'),{prepare:async()=>fs.writeFile(join(config.speicher.root,'directchange','assets','file.bin'),'user')}),e=>e.code==='konflikt');
  assert.equal((await s.readRange(r,0,4)).toString(),'user');
  await assert.rejects(s.recovery(r,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'}),e=>e.code==='konflikt');
});

