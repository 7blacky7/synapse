/** W3 sol-9: echte PG/FS/Scanner/Queue/Retention, nur synapse_test:5433 und eigene mkdtemp-Wurzel. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';
const repo=process.env.SOL9_W3_REPO||fileURLToPath(new URL('../../../',import.meta.url));
const core=await import(pathToFileURL(join(repo,'packages/core/dist/index.js')).href);
const legacy=Object.fromEntries([
 ['src/main.ts',Buffer.from('export const x=1;')],['pic.png',Buffer.from([137,80,78,71,13,10,26,10])],
 ['anim.gif',Buffer.from('GIF89a')],['model.usda',Buffer.from('#usda 1.0')],['audio.wav',Buffer.from('RIFF0000WAVE')],
 ['doc.pdf',Buffer.from('%PDF-1.7')],['archive.zip',Buffer.from([80,75,3,4])],
].map(([p,head])=>[p,{klasse:core.klassifiziereDatei(p),asset:core.assetArt(p,head),format:core.standardRegistry.detect(p,head).format}]));
if(process.argv.includes('--capture')){console.log('GOLDEN_JSON='+JSON.stringify(legacy));process.exit(0);}
assert.deepEqual(legacy,JSON.parse(await fs.readFile(new URL('./fixtures/asset-w3-sol9-legacy.golden.json',import.meta.url),'utf8')));
if(process.argv.includes('--golden')){console.log('M2 Legacy-Klassifikation bytegleich t85.');process.exit(0);}
const admin=await oeffneGeschuetzteShellTestDb();
assert.equal((await admin.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
const schema='p13_sol9_'+randomUUID().replaceAll('-','');
await admin.query('CREATE SCHEMA '+schema);
async function connection(){
 const client=await oeffneGeschuetzteShellTestDb();
 await client.query('SET search_path TO '+schema+',public');
 return {query:(s,v)=>client.query(s,v),release:()=>client.end()};
}
const db={connect:connection,async query(s,v){const client=await connection();try{return await client.query(s,v);}finally{await client.release();}},end:async()=>{}};
const root=await fs.mkdtemp(join(tmpdir(),'sol9-w3-'));
const share=join(root,'share'),reverse=join(root,'reverse'),pc=join(root,'pc');
const gif=Buffer.from('GIF89a\0\0\0\0\0\0fixture'),gif2=Buffer.from('GIF89a\0\0\0\0\0\0changed');
const hash=b=>createHash('sha256').update(b).digest('hex');
const names={a13:'p13_a13_'+randomUUID().slice(0,8),m2:'p13_t3_'+randomUUID().slice(0,8),m4:'p13_t5_'+randomUUID().slice(0,8)};
const {mitLesePool}=await import('../dist/db/client.js');
const {pruefeLokalesAsset}=await import('../../file-watcher-daemon-ts/dist/asset-erkennung.js');
const {AssetTransferQueue}=await import('../../file-watcher-daemon-ts/dist/asset-transfer-queue.js');
let queue;let checks={A13:0,M2:0,M4:0};
const check=(group,value,label)=>{assert.ok(value,label);checks[group]++;};
const envSaved={};
for(const [key,value] of Object.entries({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:share,SYNAPSE_REVERSE_ROOT:reverse,SYNAPSE_ASSET_CHUNK_BYTES:'65536'})){
 envSaved[key]=process.env[key];process.env[key]=value;
}
core.resetAssetKonfiguration();const cfg=core.getAssetKonfiguration();
const storage=new core.AssetSpeicher({konfiguration:cfg});
const ctx=project=>({bereich:'projekt',ziel_ref:project,host_id:'sol9-test'});
const row=async(project,p)=> (await db.query('SELECT * FROM asset_files WHERE project=$1 AND file_path=$2',[project,p])).rows[0];
const data=async stream=>{const parts=[];for await(const b of stream)parts.push(b);return Buffer.concat(parts);};
async function put(project,p,bytes,basis='0'){
 const up=new core.AssetUploadKern({db,konfiguration:cfg}),c=ctx(project);
 const s=await up.erstellen(c,{logischer_pfad:p,storage_kind:'assets',groesse:bytes.length,sha256:hash(bytes),basis_revision:basis,idempotency_key:randomUUID(),format:'gif'});
 if(bytes.length)await up.teil(c,s.id,0,bytes.length,[bytes]);
 return up.finalisieren(c,s.id);
}
try{
 await Promise.all([fs.mkdir(share),fs.mkdir(reverse),fs.mkdir(pc)]);
 await db.query('CREATE TABLE projects(name TEXT,hostname TEXT,path TEXT,enabled BOOLEAN DEFAULT true,last_access TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(name,hostname))');
 for(const f of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql','100_asset_konflikte.sql'])await db.query(await fs.readFile(new URL('../src/db/schema-sql/'+f,import.meta.url),'utf8'));
 await db.query("CREATE TABLE asset_inspektions_projekte(project TEXT PRIMARY KEY,modus TEXT,updated_at TIMESTAMPTZ DEFAULT NOW())");
 for(const project of Object.values(names)){
  await db.query("INSERT INTO projects(name,hostname,path) VALUES($1,'fixture',$2)",[project,join(root,project)]);
  await fs.mkdir(join(share,project,'assets'),{recursive:true});await fs.mkdir(join(share,project,'binaries'),{recursive:true});
 }
 await mitLesePool(db,async()=>{
  // A13 actual scanner, durable PG checkpoints and real A6 publication.
  const scan=new core.ShareScanner({konfiguration:cfg});
  const stop=core.registriereProjektShareScanner({scanner:scan,db,konfiguration:cfg});
  const target=join(share,names.a13,'assets','anim.gif');await fs.writeFile(target,gif);
  await scan.durchlauf();check('A13',!await row(names.a13,'anim.gif'),'erste Beobachtung veröffentlicht nicht');
  await scan.durchlauf();let a=await row(names.a13,'anim.gif');
  check('A13',a?.transport_sha256===hash(gif)&&String(a.transport_revision)==='1','zweite stabile Beobachtung publiziert');
  check('A13',(await db.query('SELECT quelle FROM asset_revisionen WHERE asset_id=$1',[a.id])).rows[0].quelle==='share','Quelle share ist echt persistiert');
  const first=(await db.query('SELECT * FROM asset_revisionen WHERE asset_id=$1 AND revision=1',[a.id])).rows[0];
  check('A13',first.storage_key.includes('/.intern/'),'Revisionsbytes unveränderlich abgelegt');
  await fs.writeFile(target,gif2);await scan.durchlauf();
  check('A13',String((await row(names.a13,'anim.gif')).transport_revision)==='1','geänderte/halbe Kopie wartet auf zweite Statprobe');
  await scan.durchlauf();a=await row(names.a13,'anim.gif');
  check('A13',String(a.transport_revision)==='2'&&a.transport_sha256===hash(gif2),'Shareänderung erhält neue Revision');
  assert.deepEqual(await data(await storage.readStorageStream({bereich:'projekt',ziel_ref:names.a13,storage_kind:'assets',logischer_pfad:'anim.gif'},first.storage_key)),gif);checks.A13++;
  await scan.durchlauf();await scan.durchlauf();
  check('A13',String((await row(names.a13,'anim.gif')).transport_revision)==='2','Wiederholung ist idempotent');
  for(const dir of ['.intern','_arbeit','_eingang']){
   await fs.mkdir(join(share,names.a13,'assets',dir));await fs.writeFile(join(share,names.a13,'assets',dir,'hidden.gif'),gif);
  }
  await scan.durchlauf();await scan.durchlauf();
  check('A13',(await db.query('SELECT count(*)::int AS n FROM asset_files WHERE project=$1',[names.a13])).rows[0].n===1,'interne Ordner bleiben unsichtbar');
  check('A13',(await db.query('SELECT count(*)::int AS n FROM asset_scan_checkpoints')).rows[0].n>=3,'Rootcheckpoints wirklich in PG');
  await fs.mkdir(join(share,names.a13,'assets','deep','too'),{recursive:true});
  const shallow=new core.ShareScanner({konfiguration:{...cfg,inspektion:{...cfg.inspektion,maxDepth:0}}});
  core.registriereProjektShareScanner({scanner:shallow,db,konfiguration:cfg});
  await assert.rejects(()=>shallow.durchlauf(),/Tiefengrenze/);checks.A13++;
  check('A13',!(await row(names.a13,'anim.gif')).deleted_at,'abgebrochener Scan erzeugt keinen Tombstone');
  const fakeRoot=join(reverse,'_direkt');await fs.mkdir(fakeRoot);await fs.writeFile(join(fakeRoot,'input.gif'),gif);
  let reverseCalls=0;scan.registrieren('reverse',{wurzeln:async()=>[{id:'direkt',pfad:fakeRoot}],datei:async e=>{assert.equal(e.bereich,'reverse');assert.deepEqual(await data(await e.oeffne()),gif);reverseCalls++;}});
  await scan.durchlauf();await scan.durchlauf();check('A13',reverseCalls===1,'zweiter Reverse-Handler nutzt denselben Scanner');
  await fs.symlink(pc,join(share,names.a13,'assets','escape'));await scan.durchlauf();
  check('A13',(await db.query('SELECT count(*)::int AS n FROM asset_files WHERE project=$1',[names.a13])).rows[0].n===1,'Symlinks werden nicht verfolgt');stop();
  // M2 actual detector and persistent A8 queue, API edge adapts to real A6 core.
  await fs.writeFile(join(pc,'anim.gif'),gif);await fs.writeFile(join(pc,'code.ts'),'export const x=1;');
  check('M2',(await pruefeLokalesAsset(pc,names.m2,'anim.gif',{maxDateiBytes:1000,erlaubteTypen:['gif']}))?.format==='gif','Registryformat erkannt');
  check('M2',await pruefeLokalesAsset(pc,names.m2,'code.ts',{maxDateiBytes:1000})===null,'Code bleibt auf Codeweg');
  check('M2',await pruefeLokalesAsset(pc,names.m2,'anim.gif',{maxDateiBytes:1})===null,'Größenlimit wirkt');
  check('M2',await pruefeLokalesAsset(pc,names.m2,'anim.gif',{maxDateiBytes:1000,erlaubteTypen:['png']})===null,'Typenpolicy wirkt');
  await fs.writeFile(join(pc,'.gitignore'),'ignored.gif\n');await fs.writeFile(join(pc,'ignored.gif'),gif);
  check('M2',await pruefeLokalesAsset(pc,names.m2,'ignored.gif',{maxDateiBytes:1000})===null,'gitignore wirkt');
  await fs.writeFile(join(pc,'.synapseignore'),'hidden.gif\n');await fs.writeFile(join(pc,'hidden.gif'),gif);
  check('M2',await pruefeLokalesAsset(pc,names.m2,'hidden.gif',{maxDateiBytes:1000})===null,'synapseignore wirkt');
  await fs.mkdir(join(pc,'.synapse'));await fs.writeFile(join(pc,'.synapse','secret.gif'),gif);
  check('M2',await pruefeLokalesAsset(pc,names.m2,'.synapse/secret.gif',{maxDateiBytes:1000})===null,'Laufzeitbereich gesperrt');
  const up=new core.AssetUploadKern({db,konfiguration:cfg}),c=ctx(names.m2);let creates=0;
  const api={
   async json(route,body,method){
    if(route.endsWith('/uploads')){creates++;return {upload:await up.erstellen(c,body)};}
    const id=route.match(/\/uploads\/([^/]+)/)?.[1];
    if(route.endsWith('/finalisieren'))return {upload:await up.finalisieren(c,id)};
    if(route.endsWith('/loeschen'))return {asset:await new core.AssetManifestKern({db,konfiguration:cfg}).mutieren(c,'loeschen',body)};
    return {upload:await up.status(c,id)};
   },
   async request(route,o){const id=route.match(/\/uploads\/([^/]+)/)[1],offset=Number(route.match(/offset=(\d+)/)[1]);const s=await up.teil(c,id,offset,Number(o.headers['content-length']),o.body());return {json:async()=>({upload:s})};}
  };
  queue=new AssetTransferQueue({bereich:'projekt',ziel_ref:names.m2,host:c.host_id,root:pc},{richtung:'both',chunkBytes:65536,retryMs:1,timeoutMs:30000,maxDateiBytes:1000,erlaubteTypen:['gif']},api);
  await queue.ereignis('anim.gif','add');await queue.abarbeiten();
  check('M2',creates===0,'erste Statprobe hasht/lädt nicht hoch');
  await new Promise(r=>setTimeout(r,10));await queue.abarbeiten();
  check('M2',creates===1&&(await row(names.m2,'anim.gif'))?.transport_sha256===hash(gif),'zweite Statprobe lädt fehlende Bytes wirklich hoch');
  await queue.ereignis('anim.gif','change');await queue.abarbeiten();
  check('M2',creates===1,'gleicher Hash lädt kein zweites Mal');
  await queue.ereignis('unknown.gif','unlink');check('M2',!(await queue.status()).auftraege.some(x=>x.pfad==='unknown.gif'),'unbekannter Unlink kein Delete');
  await fs.writeFile(join(pc,'.gitignore'),'ignored.gif\nanim.gif\n');
  await fs.unlink(join(pc,'anim.gif'));await queue.ereignis('anim.gif','unlink');await queue.abarbeiten();
  check('M2',!(await row(names.m2,'anim.gif')).deleted_at,'Ignorewechsel verursacht keinen Remote-Delete');
  await queue.stop();queue=null;
  // M4 actual delete/restore/purge and durable reader pins.
  await put(names.m4,'restore.gif',gif);let m=await row(names.m4,'restore.gif');
  const mk=new core.AssetManifestKern({db,konfiguration:cfg}),mc=ctx(names.m4);
  await assert.rejects(()=>mk.mutieren(mc,'loeschen',{event_id:randomUUID(),asset_id:String(m.id),basis_revision:String(m.transport_revision),restore_window_ms:cfg.sync.restoreWindowMs+1}),/Löschfenster/);checks.M4++;
  const event=randomUUID(),del=await mk.mutieren(mc,'loeschen',{event_id:event,asset_id:String(m.id),basis_revision:String(m.transport_revision),restore_window_ms:60000});
  check('M4',del.deleted_at&&new Date(del.restore_until)-new Date(del.deleted_at)>=59990,'gewünschtes Löschfenster in PG');
  check('M4',String(del.revision)!==String(m.transport_revision),'Tombstone hat neue Revision');
  check('M4',(await mk.mutieren(mc,'loeschen',{event_id:event,asset_id:String(m.id),basis_revision:String(m.transport_revision),restore_window_ms:60000})).revision===del.revision,'Delete wiederholbar');
  const list=await core.fuehreAssetIntelAus({action:'geloescht',project:names.m4},{apiAusfuehrung:true,agentId:'sol9-fixture'});
  check('M4',list.success&&list.dateien.length===1&&list.dateien[0].wiederherstellbar,'Tool-Löschliste');
  check('M4',!(await core.fuehreAssetIntelAus({action:'geloescht',project:names.m4})).success,'lokaler Schreib-/Restoreweg gesperrt');
  const restored=await core.fuehreAssetIntelAus({action:'wiederherstellen',project:names.m4,asset_id:String(m.id),basis_revision:del.revision,event_id:randomUUID()},{apiAusfuehrung:true,agentId:'sol9-fixture'});
  check('M4',restored.success&&BigInt(restored.asset.revision)>BigInt(del.revision),'Tool-Restore erzeugt neue Revision');
  assert.deepEqual(await fs.readFile(join(share,names.m4,'assets','restore.gif')),gif);checks.M4++;
  m=await row(names.m4,'restore.gif');await mk.mutieren(mc,'loeschen',{event_id:randomUUID(),asset_id:String(m.id),basis_revision:String(m.transport_revision),restore_window_ms:60000});
  const retention=new core.AssetRetention({db,konfiguration:cfg});check('M4',(await retention.durchlauf()).entfernt===0,'vor Frist kein Purge');
  await db.query("UPDATE asset_files SET restore_until=clock_timestamp()-interval '1 second' WHERE id=$1",[m.id]);
  const ref='view-'+randomUUID();await retention.halten({ref_key:ref,asset_id:String(m.id),revision:String(m.transport_revision),art:'ansicht',expires_at:new Date(Date.now()+60000)});
  check('M4',(await retention.durchlauf()).entfernt===0,'offene Ansicht verhindert Purge');
  await retention.freigeben(ref);const purged=await retention.durchlauf();
  check('M4',purged.entfernt===1&&(await row(names.m4,'restore.gif')).storage_status==='purged','nach Frist ohne Referenzen Purge');
  check('M4',(await db.query('SELECT count(*)::int AS n FROM asset_revisionen WHERE asset_id=$1',[m.id])).rows[0].n>=4,'Tombstonehistorie für Offlinehost bleibt');
  await assert.rejects(()=>retention.halten({ref_key:'late-'+randomUUID(),asset_id:String(m.id),revision:String(m.transport_revision),art:'ansicht',expires_at:new Date(Date.now()+60000)}),/entfernt|abgelaufen/);checks.M4++;
  check('M4',(await retention.durchlauf()).entfernt===0,'Purge idempotent');
  console.log('SOL9_W3_CHECKS='+JSON.stringify(checks));
 });
}finally{
 if(queue)await queue.stop();
 await db.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
 await fs.rm(root,{recursive:true,force:true});
 for(const [k,v] of Object.entries(envSaved))if(v===undefined)delete process.env[k];else process.env[k]=v;
 core.resetAssetKonfiguration();
}
process.exit(0);
