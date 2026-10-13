/** A12: reale synapse_test-Isolation, echte Sharebytes und echte Worker; keine Live-DB. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,rename,readFile,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {oeffneGeschuetzteShellTestDb} from '../dist/services/test-db-laufzeit-schutz.js';
import {mitLesePool,closePool} from '../dist/db/client.js';
import {ASSET_INSPEKTIONS_SCHEMA_SQL} from '../dist/db/asset-inspektions-schema.js';
import {AssetInspektionsDienst,starteAssetInspektion} from '../dist/services/asset-inspektion.js';
import {AssetSpeicher} from '../dist/services/asset-speicher.js';
import {ladeAssetKonfiguration,resetAssetKonfiguration} from '../dist/config/asset-konfig.js';
import {assetProjektNutztShare,setzeAssetInspektionsModus} from '../dist/services/asset-inspektions-projekte.js';
import * as store from '../dist/services/asset-intel-store.js';
import {projektHatAssets,vergissAssetStand} from '../dist/services/asset-weiche.js';
import {inspectAssetSource} from '../dist/asset-intel/index.js';
import {AssetInspektionsWorker} from '../dist/asset-intel/worker-runner.js';
import {createAssetsRoutes} from '../../rest-api/dist/routes/assets.js';
import {createRequire} from 'node:module';
const requireApi=createRequire(new URL('../../rest-api/package.json',import.meta.url));
const Fastify=requireApi('fastify');
const here=dirname(fileURLToPath(import.meta.url)),project='p13_a12_test_'+process.pid,schema='p13_a12_test_'+process.pid;
const hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from(JSON.stringify({asset:{version:'2.0'},meshes:[{name:'ShareMesh',primitives:[]}],images:[{uri:'image.png'},{uri:'missing.png'}]}));
const main='assets/model.gltf',key=project+'/assets/'+main;
const adresse={bereich:'projekt',ziel_ref:project,storage_kind:'assets',logischer_pfad:main};
test('A12 Share-Inspektion',async t=>{
 const saved={...process.env},clients=new Set(),services=[];
 const root=await mkdtemp(join(tmpdir(),'synapse-a12-'));
 // Nur direkte FS-Aufrufe dieser Testdatei; kein importierter Cleanup-Helfer.
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 assert.equal(await realpath(root),root,'Testwurzel muss realpath-kanonisch sein');
 const db=await oeffneGeschuetzteShellTestDb();
 const q=db.query;
 let created=false;
 const cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:root,SYNAPSE_ASSET_KONKURRENZ:'1',SYNAPSE_ASSET_RETRY_INTERVAL_MS:'1000'});
 const storage=new AssetSpeicher({konfiguration:cfg});
 const pool={query:q,async connect(){
  const c=await oeffneGeschuetzteShellTestDb();clients.add(c);
  await c.query('SET search_path TO '+schema+',public');
  return {query:c.query,release(){clients.delete(c);void c.end();}};
 }};
 const service=(s=storage)=>{const d=new AssetInspektionsDienst(cfg,s);services.push(d);return d;};
 const row=async()=> (await q('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2',[project,main])).rows[0];
 const reset=async(revision=1,sha=hash(bytes))=>{
  await q('DELETE FROM asset_inspektions_auftraege');
  await q('DELETE FROM asset_objects');await q('DELETE FROM asset_references');
  await q("UPDATE asset_files SET transport_revision=$2,transport_sha256=$3,storage_status='ready',prepared_upload_id=NULL,deleted_at=NULL,inspection_revision=NULL,sha256=NULL,metadata='{}',status='ok',n_objects=0,n_references=0 WHERE project=$1 AND file_path=$4",[project,revision,sha,main]);
  await writeFile(join(root,key),bytes);
 };
 function blockedStorage(){
  let release,entered;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  let first=true;
  const s={async oeffneInspektionsQuelle(...args){
   const source=await storage.oeffneInspektionsQuelle(...args);
   return {...source,async readRange(...range){if(first){first=false;entered();await gate;}return source.readRange(...range);}};
  }};
  return {s,release,ready};
 }
 const waitReady=async b=>{let timer;try{await Promise.race([b.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Worker hat keine Range angefragt')),5000);})]);}finally{clearTimeout(timer);}};
 try{
  await q('CREATE SCHEMA '+schema);created=true;
  await q('SET search_path TO '+schema+',public');
  for(const table of ['code_files','asset_files','asset_objects','asset_references'])
   await q('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
  // LIKE übernimmt nur die Definition; eigene Sequenzen verhindern Änderungen am Public-Altbestand.
  for(const [table,seq] of [['asset_files','af_seq'],['asset_objects','ao_seq'],['asset_references','ar_seq']]){
   await q('CREATE SEQUENCE '+schema+'.'+seq+' START WITH 1000');
   await q("ALTER TABLE "+table+" ALTER COLUMN id SET DEFAULT nextval('"+schema+"."+seq+"')");
  }
  await q('ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS prepared_upload_id uuid');
  await q('CREATE TABLE projects(name text PRIMARY KEY)');
  await q('CREATE TABLE asset_aenderungsstaende(project text PRIMARY KEY,stand bigint NOT NULL DEFAULT 0)');
  await q('INSERT INTO projects VALUES($1)',[project]);
  await q('INSERT INTO asset_aenderungsstaende VALUES($1,0)',[project]);
  await q(ASSET_INSPEKTIONS_SCHEMA_SQL);await q(ASSET_INSPEKTIONS_SCHEMA_SQL);
  await mkdir(dirname(join(root,key)),{recursive:true});await writeFile(join(root,key),bytes);
  await q("INSERT INTO asset_files(id,project,file_path,file_name,extension,asset_type,format,status,file_size,transport_revision,transport_sha256,storage_key,storage_kind,storage_status) VALUES(1,$1,$2,'model.gltf','gltf','model3d','gltf','ok',$3,1,$4,$5,'assets','ready')",[project,main,bytes.length,hash(bytes),key]);
  await q("INSERT INTO asset_files(id,project,file_path,file_name,extension,asset_type,status,file_size) VALUES(2,$1,'assets/image.png','image.png','png','image','ok',64)",[project]);
  await mitLesePool(pool,async()=>{
   await t.test('Schema idempotent; Transportbindung übernimmt Writer',async()=>{
    assert.equal(await assetProjektNutztShare(project),true);
    await setzeAssetInspektionsModus(project,'asset_sync');
    await assert.rejects(()=>setzeAssetInspektionsModus(project,'legacy_local'),/Transportgebundene/);
   });
   await t.test('Echter Worker publiziert aktuelle Revision; Referenzen kommen aus logischem Katalog',async()=>{
    const d=service();await d.durchlauf();
    const a=await row();assert.equal(a.inspection_revision,'1');assert.equal(a.sha256,hash(bytes));assert.equal(a.inspiziert_von,'synapse-api');
    assert.equal(a.n_objects>0,true);
    const refs=(await q('SELECT target,aufloesung FROM asset_references ORDER BY ordnung')).rows;
    assert.ok(refs.some(r=>r.target==='image.png'&&r.aufloesung==='datei'));
    assert.ok(refs.some(r=>r.target==='missing.png'&&r.aufloesung==='fehlt'));
    const j=(await q('SELECT status,versuche,grenzen FROM asset_inspektions_auftraege')).rows;
    assert.equal(j.length,1);assert.equal(j[0].status,'done');assert.equal(j[0].versuche,1);
    assert.deepEqual(j[0].grenzen,cfg.inspektion);
    await d.durchlauf();assert.equal((await q('SELECT sum(versuche)::int AS n FROM asset_inspektions_auftraege')).rows[0].n,1);
   });
   await t.test('Alle lokalen Mutatoren blockieren Share und erhalten Bestand',async()=>{
    const before=JSON.stringify(await row()),result=await inspectAssetSource({filePath:main,size:bytes.length,readRange:async(o,n)=>bytes.subarray(o,o+n)});
    for(const fn of [
     ()=>store.speichereAssetErgebnis(project,main,result),
     ()=>store.markiereAssetQuelleFehlt(project,main),
     ()=>store.benenneAssetUm(project,main,'renamed.gltf'),
     ()=>store.aktualisiereVerweisZiel(project,'assets/image.png',false),
     ()=>store.entferneAssetsEndgueltig(project,{ganzesProjekt:true})
    ])await assert.rejects(fn,e=>e.code==='asset_inspektion_serverseitig');
    assert.equal(JSON.stringify(await row()),before);
   });
   await t.test('Revision während Worker-I/O wechselt: alter Auftrag stale, neuer publiziert',async()=>{
    await reset();const b=blockedStorage(),d=service(b.s),run=d.durchlauf();
    try{await waitReady(b);await q('UPDATE asset_files SET transport_revision=2 WHERE id=1');}finally{b.release();}
    await run;assert.equal((await row()).inspection_revision,null);
    assert.equal((await q('SELECT status FROM asset_inspektions_auftraege')).rows[0].status,'stale');
    await d.durchlauf();assert.equal((await row()).inspection_revision,'2');
   });
   await t.test('Neuer Lease-Owner bleibt vor spätem Ergebnis geschützt',async()=>{
    await reset();const b=blockedStorage(),d=service(b.s),run=d.durchlauf(),token=randomUUID();
    try{await waitReady(b);await q("UPDATE asset_inspektions_auftraege SET lease_token=$1,lease_bis=clock_timestamp()+interval '1 minute'",[token]);}finally{b.release();}
    await run;assert.equal((await row()).inspection_revision,null);
    const j=(await q('SELECT status,lease_token FROM asset_inspektions_auftraege')).rows[0];
    assert.equal(j.status,'running');assert.equal(j.lease_token,token);
   });
   await t.test('Lease abgelaufen: Fehler ist wiederholbar; gleiche Revision wird später publiziert',async()=>{
    await reset();const b=blockedStorage(),d=service(b.s),run=d.durchlauf();
    try{await waitReady(b);await q("UPDATE asset_inspektions_auftraege SET lease_bis=clock_timestamp()-interval '1 second'");}finally{b.release();}
    await run;assert.equal((await row()).inspection_revision,null);
    assert.equal((await q('SELECT status FROM asset_inspektions_auftraege')).rows[0].status,'error');
    await q("UPDATE asset_inspektions_auftraege SET updated_at=clock_timestamp()-interval '2 seconds'");
    await d.durchlauf();assert.equal((await row()).inspection_revision,'1');
   });
   await t.test('Prepare während Inspektion: keine Publikation; nach Freigabe Retry',async()=>{
    await reset();const b=blockedStorage(),d=service(b.s),run=d.durchlauf();
    try{await waitReady(b);await q('UPDATE asset_files SET prepared_upload_id=$1 WHERE id=1',[randomUUID()]);}finally{b.release();}
    await run;assert.equal((await row()).inspection_revision,null);
    assert.equal((await q('SELECT status FROM asset_inspektions_auftraege')).rows[0].status,'error');
    await q('UPDATE asset_files SET prepared_upload_id=NULL WHERE id=1');
    await q("UPDATE asset_inspektions_auftraege SET updated_at=clock_timestamp()-interval '2 seconds'");
    await d.durchlauf();assert.equal((await row()).inspection_revision,'1');
   });
   await t.test('Falscher Transporthash und falsche Größe publizieren nicht',async()=>{
    await reset(1,'a'.repeat(64));await service().durchlauf();assert.equal((await row()).inspection_revision,null);
    await reset();await q('UPDATE asset_files SET file_size=file_size+1 WHERE id=1');
    await service().durchlauf();assert.equal((await row()).inspection_revision,null);
    await q('UPDATE asset_files SET file_size=$1 WHERE id=1',[bytes.length]);
   });
   await t.test('Held-FD statt erneutes Pfadöffnen; Mutation und Range-Budget abgefangen',async()=>{
    await reset();const source=await storage.oeffneInspektionsQuelle(adresse,key);
    try{
     await rename(join(root,key),join(root,key)+'.old');await writeFile(join(root,key),'replacement');
     assert.deepEqual(await source.readRange(0,bytes.length),bytes);
    }finally{await source.schliessen();await rm(join(root,key)+'.old',{force:true});}
    await writeFile(join(root,key),bytes);
    const changing=await storage.oeffneInspektionsQuelle(adresse,key);
    try{await writeFile(join(root,key),Buffer.concat([bytes,Buffer.from(' ')]));await assert.rejects(changing.pruefeUnveraendert,e=>e.code==='konflikt');}finally{await changing.schliessen();}
    await writeFile(join(root,key),bytes);
    const tiny=new AssetSpeicher({konfiguration:{...cfg,inspektion:{...cfg.inspektion,maxHashBytes:64,maxReadBytes:64}}});
    const limited=await tiny.oeffneInspektionsQuelle(adresse,key);
    try{
     await assert.rejects(()=>limited.readRange(-1,1),e=>e.code==='bereich_ungueltig');
     await assert.rejects(()=>limited.readRange(0,4097),e=>e.code==='bereich_ungueltig');
     await assert.rejects(async()=>{for(let i=0;i<100;i++)await limited.readRange(0,128);},e=>e.code==='bereich_ungueltig');
    }finally{await limited.schliessen();}
    await assert.rejects(()=>storage.oeffneInspektionsQuelle({...adresse,ziel_ref:'foreign'},key),e=>e.code==='pfad_ungueltig');
   });
   await t.test('Gecachtes Nein wird sofort durch Katalogrevision ungültig',async()=>{
    const p=project+'_cache';vergissAssetStand(p);
    assert.equal(await projektHatAssets(p),false);
    await q("INSERT INTO asset_files(id,project,file_path,file_name,asset_type,status,file_size) VALUES(3,$1,'cached.png','cached.png','image','ok',1)",[p]);
    await q('INSERT INTO asset_aenderungsstaende VALUES($1,1)',[p]);
    assert.equal(await projektHatAssets(p),true);
   });
   await t.test('Legacy-Writer funktioniert weiter ohne Transportbindung',async()=>{
    const p=project+'_legacy';await q('INSERT INTO projects VALUES($1)',[p]);
    await setzeAssetInspektionsModus(p,'legacy_local');assert.equal(await assetProjektNutztShare(p),false);
    const result=await inspectAssetSource({filePath:'legacy.gltf',size:bytes.length,readRange:async(o,n)=>bytes.subarray(o,o+n)});
    const written=await store.speichereAssetErgebnis(p,'legacy.gltf',result,{mtime:null,erkenneUmbenennung:false});
    assert.ok(written.asset_id>=1000);
    assert.equal(await store.benenneAssetUm(p,'legacy.gltf','renamed.gltf'),true);
    await store.markiereAssetQuelleFehlt(p,'renamed.gltf');
    assert.equal(await store.entferneAssetsEndgueltig(p,{ganzesProjekt:true}),1);
   });
   await t.test('Inspektionsmodus API nutzt Vertrag/Feature/Identität und schließt Compute aus',async()=>{
    process.env.SYNAPSE_API_FEATURES='asset_sync';
    const app=Fastify(),tokens={daemon:{kind:'service',scope:'daemon:test',token_hash:'d'},compute:{kind:'service',scope:'compute-node:test',token_hash:'c'},user:{kind:'session',scope:'mcp:tools',token_hash:'u'}};
    await app.register(createAssetsRoutes({validateToken:async x=>tokens[x]??null,projektErlaubt:async p=>p===project}));
    const call=(method,token,version=true,modus='asset_sync',p=project)=>app.inject({method,url:'/api/projects/'+p+'/assets/inspektionsmodus',headers:{...(token?{authorization:'Bearer '+token}:{}),...(version?{'x-synapse-contract-version':'1'}:{})},...(method==='POST'?{payload:{modus}}:{})});
    try{
     assert.equal((await call('GET')).statusCode,401);
     assert.equal((await call('POST','compute')).statusCode,403);
     assert.equal((await call('POST','user')).statusCode,403);
     assert.equal((await call('POST','daemon',false)).statusCode,426);
     assert.equal((await call('GET','daemon',true,'asset_sync','foreign')).statusCode,403);
     assert.equal((await call('POST','daemon',true,'invalid')).statusCode,400);
     assert.equal((await call('POST','daemon')).statusCode,200);
     assert.equal((await call('GET','user')).json().modus,'asset_sync');
     assert.equal((await call('POST','daemon',true,'legacy_local')).statusCode,409);
     process.env.SYNAPSE_API_FEATURES='';
     assert.equal((await call('GET','daemon')).statusCode,503);
    }finally{await app.close();}
   });
  });
  await t.test('CPU-Hänger hart beendet, Ereignisschleife frei, nächster Worker läuft',async()=>{
   const w=new AssetInspektionsWorker(),source={filePath:'logical.haeng',size:8,readRange:async(o,n)=>Buffer.from('abcdefgh').subarray(o,o+n)};
   let ticks=0;const timer=setInterval(()=>ticks++,20);
   try{
    const r=await w.inspiziereQuelle(source,{registryModul:join(here,'fixtures','asset-inspektion-haenger-p13-a12.mjs'),timeoutMs:200,gnadenfristMs:100});
    assert.equal(r.status,'fehler');assert.ok(r.warnings.some(x=>x.code==='worker_abgebrochen'));assert.ok(ticks>2);
    const next=await w.inspiziereQuelle({filePath:main,size:bytes.length,readRange:async(o,n)=>bytes.subarray(o,o+n)});
    assert.equal(next.status,'ok');assert.equal(next.sha256,hash(bytes));
   }finally{clearInterval(timer);await w.beende();}
  });
  await t.test('API-Schleife startet ohne Betreiberfreigabe nicht',async()=>{
   process.env.SYNAPSE_ASSET_ENABLED='0';resetAssetKonfiguration();
   assert.equal(starteAssetInspektion(),null);
  });
 }finally{
  for(const d of services)await d.beende();
  for(const c of clients)await c.end();
  if(created){await q('SET search_path TO public');await q('DROP SCHEMA '+schema+' CASCADE');}
  await db.end();await closePool();
  for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
  resetAssetKonfiguration();vergissAssetStand();
 }
});
