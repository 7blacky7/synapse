/** P18-T14: synthetische eigene Testwurzel, keine Live-Datasets.
 * (angepasst P25-T12, P18-T93: die Reverse-Grenzen kommen aus reverse_einstellungen (pfad_tiefe_max, max_datei_bytes, eintrag_bytes,
 * e_uebernahme_block_zeilen); cfg.inspektion.maxDepth/cfg.reverse.* wirken fuer publishReverseManifest nicht mehr. Der Test liest sie
 * aus einer eigenen reverse_einstellungen im privaten Schema p18_rv4_<uuid> in synapse_test:5433.) */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='p18_rv4_'+randomUUID().replaceAll('-','');
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:2});
const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');
delete process.env.SYNAPSE_DATABASE_URL;process.env.DATABASE_URL=scoped.href;
const api=await import('../dist/services/asset-speicher.js');
const {ladeAssetKonfiguration}=await import('../dist/config/asset-konfig.js');
const {closePool}=await import('../dist/db/client.js');
/** Ersetzt alle Einstellwerte im privaten Schema (global); leer = Katalogstandard. */
async function grenzen(werte={}){
 await raw.query('DELETE FROM '+schema+'.reverse_einstellungen');
 for(const [name,wert]of Object.entries(werte))await raw.query('INSERT INTO '+schema+".reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global',$1,$2,'RV4 fixture','fixture')",[name,wert]);
}
const sha=b=>createHash('sha256').update(b).digest('hex');
let root,cfg;
before(async()=>{await raw.query('CREATE SCHEMA '+schema);await raw.query('CREATE TABLE '+schema+'.reverse_einstellungen (LIKE public.reverse_einstellungen INCLUDING DEFAULTS)');
 root=await fs.mkdtemp(join(tmpdir(),'p18-rv4-'));cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'projekt'),SYNAPSE_REVERSE_ROOT:join(root,'reverse')});});
after(async()=>{await fs.rm(root,{recursive:true,force:true});await closePool().catch(()=>undefined);await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();});
const rid='rev-fixture-a1b2c3';
const newInput=()=>({reverseId:rid,auftragId:randomUUID(),art:'code',gruppe:randomUUID(),dateien:[{pfad:'src/main.txt',groesse:3,sha256:sha('abc')}]});
async function work(s,input){await s.reverseArbeitsbereich(input.auftragId);const dir=join(cfg.speicher.reverseRoot,'_arbeit',input.auftragId);await fs.mkdir(join(dir,'src'),{recursive:true});await fs.writeFile(join(dir,'src/main.txt'),'abc');return dir;}
const options={prepare:async()=>{},commit:async()=>{}};
test('RV4 Schnittstelle vorhanden',()=>{assert.equal(typeof api.AssetSpeicher.prototype.publishReverseManifest,'function');assert.equal(typeof api.erzeugeReverseId,'function');});
test('Reverse-ID stabil für Identität, Kollisionen atomar reserviert',async()=>{
 const reservations=new Map();const reserve=async(id,key)=>{if(!reservations.has(id)){reservations.set(id,key);return 'neu';}return reservations.get(id)===key?'gleich':'belegt';};
 const a=await api.erzeugeReverseId('Älteres Spiel','key-a',reserve);
 assert.match(a,/^rev-[a-z0-9-]+-[a-f0-9]{6}$/);
 assert.equal(await api.erzeugeReverseId('Älteres Spiel','key-a',reserve),a);
 assert.notEqual(await api.erzeugeReverseId('Älteres Spiel','key-b',reserve),a);
 let calls=0;const b=await api.erzeugeReverseId('collision','key',async()=>++calls===1?'belegt':'neu');
 assert.equal(calls,2);assert.match(b,/^rev-collision-[a-f0-9]{6}$/);
});
test('Reverse-Layout und Eingang, Arbeits-/Ghidra-Ordner',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg});
 const a={bereich:'reverse',ziel_ref:rid,storage_kind:'binaries',logischer_pfad:'disc.iso',reverse_layout:{art:'original',gruppe:'cd1'}};
 const stage=await s.stage(a,[Buffer.from('abc')],{groesse:3,sha256:sha('abc')});
 assert.ok((await fs.stat(join(cfg.speicher.reverseRoot,'_eingang',stage.id))).isFile());
 const out=await s.publish(stage,{basisSha256:null,...options});
 assert.equal(out.storage_key,rid+'/original/cd1/disc.iso');
 const id=randomUUID();assert.equal(await s.reverseArbeitsbereich(id),'_arbeit/'+id);
 assert.equal(await s.reverseGhidraBereich('a'.repeat(64),'11.3'),'_arbeit/ghidra/'+'a'.repeat(64)+'-11.3');
});
test('Manifest als ganzer Ordner atomar publiziert; Quelle bleibt bis Recovery',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg}),input=newInput(),dir=await work(s,input);
 const dest=join(cfg.speicher.reverseRoot,rid,input.art,input.gruppe);
 const out=await s.publishReverseManifest(input,{prepare:async()=>{await assert.rejects(fs.stat(dest),e=>e.code==='ENOENT');},commit:async()=>{assert.equal(await fs.readFile(join(dest,'src/main.txt'),'utf8'),'abc');}});
 assert.equal(out.storage_key,rid+'/code/'+input.gruppe);assert.equal(await fs.readFile(join(dir,'src/main.txt'),'utf8'),'abc');
 await assert.rejects(s.publishReverseManifest(input,options),e=>e.code==='konflikt');
});
test('Traversal/absolut/UNC/NUL/Drive/Kodierung und doppelte Pfade abgelehnt',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg});
 for(const pfad of ['../x','/tmp/x','\\\\host/share','C:/x','a\0b','%252e%252e/x']){
  const input=newInput();input.dateien[0].pfad=pfad;await assert.rejects(s.publishReverseManifest(input,options));
 }
 const i=newInput();i.dateien.push({...i.dateien[0]});await assert.rejects(s.publishReverseManifest(i,options),e=>e.code==='manifest_ungueltig');
});
test('Symlink, Hardlink, FIFO und nicht gelistete Datei abgelehnt',async()=>{
 for(const art of ['symlink','hardlink','fifo','extra']){
  const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput(),dir=await work(s,i),p=join(dir,'src/main.txt');
  const outside=join(root,randomUUID());await fs.writeFile(outside,'abc');
  if(art!=='extra')await fs.unlink(p);
  if(art==='symlink')await fs.symlink(outside,p);
  if(art==='hardlink')await fs.link(outside,p);
  if(art==='fifo')execFileSync('mkfifo',[p]);
  if(art==='extra')await fs.writeFile(join(dir,'extra'),'not listed');
  await assert.rejects(s.publishReverseManifest(i,options));
  assert.equal(await fs.readFile(outside,'utf8'),'abc');
 }
});
test('Hash, Größe, Anzahl, Tiefe und Disk-full verhindern Publish',async()=>{
 // (angepasst P25-T12, P18-T93: Anzahl = e_uebernahme_block_zeilen, Tiefe = pfad_tiefe_max (Minimum 1, deshalb ein Pfad der Tiefe 2))
 const erwartet={hash:'hash_falsch',size:'groesse_falsch',count:'blockuebernahme_erforderlich',depth:'quote',disk:'ENOSPC'};
 try{
  for(const art of ['hash','size','count','depth','disk']){
   await grenzen(art==='count'?{e_uebernahme_block_zeilen:1}:art==='depth'?{pfad_tiefe_max:1}:{});
   const s=new api.AssetSpeicher({konfiguration:cfg,...(art==='disk'?{schreiben:async()=>{throw Object.assign(new Error('disk'),{code:'ENOSPC'});}}:{})}),i=newInput();
   await work(s,i);if(art==='hash')i.dateien[0].sha256='0'.repeat(64);if(art==='size')i.dateien[0].groesse=2;if(art==='count')i.dateien.push({pfad:'b',groesse:0,sha256:sha('')});
   if(art==='depth')i.dateien.push({pfad:'a/b/c.txt',groesse:3,sha256:sha('abc')});
   await assert.rejects(s.publishReverseManifest(i,options),e=>e.code===erwartet[art],art);
   await assert.rejects(fs.stat(join(cfg.speicher.reverseRoot,rid,i.art,i.gruppe)),e=>e.code==='ENOENT');
  }
 }finally{await grenzen();}
});

test('Crash nach Rename vor PG-Commit und bestätigte Recovery',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput();await work(s,i);
 await assert.rejects(s.publishReverseManifest(i,{prepare:async()=>{},commit:async()=>{throw new Error('PG unavailable');}}));
 const dest=join(cfg.speicher.reverseRoot,rid,i.art,i.gruppe);
 assert.equal(await fs.readFile(join(dest,'src/main.txt'),'utf8'),'abc');
 const fresh=new api.AssetSpeicher({konfiguration:cfg});
 assert.equal(await fresh.recoveryReversePublish(rid,i.auftragId,{istVerwaist:async()=>false,pgStand:async()=>{throw new Error('must not run');}}),null);
 const op=await fresh.recoveryReversePublish(rid,i.auftragId,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'});
 assert.equal(op.status,'rolled_back');await assert.rejects(fs.stat(dest),e=>e.code==='ENOENT');
 assert.equal((await fresh.recoveryReversePublish(rid,i.auftragId,{istVerwaist:async()=>true,pgStand:async()=> 'rollback'})).status,'rolled_back');
});
test('Recovery committed prüft Bytes; fremde Änderung wird erhalten',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput();await work(s,i);
 await assert.rejects(s.publishReverseManifest(i,{prepare:async()=>{},commit:async()=>{throw new Error('crash after PG');}}));
 const file=join(cfg.speicher.reverseRoot,rid,i.art,i.gruppe,'src/main.txt');
 await fs.writeFile(file,'xyz');
 await assert.rejects(s.recoveryReversePublish(rid,i.auftragId,{istVerwaist:async()=>true,pgStand:async()=> 'committed'}),e=>e.code==='hash_falsch');
 assert.equal(await fs.readFile(file,'utf8'),'xyz');
 await fs.writeFile(file,'abc');
 assert.equal((await s.recoveryReversePublish(rid,i.auftragId,{istVerwaist:async()=>true,pgStand:async()=> 'committed'})).status,'committed');
});
test('Vorhandener API-Snapshot bleibt beim Retry unverändert',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput();await work(s,i);
 const pre=join(cfg.speicher.reverseRoot,'_eingang',i.auftragId+'-manifest');
 await fs.mkdir(pre,{recursive:true});await fs.writeFile(join(pre,'keep'),'prior');
 await assert.rejects(s.publishReverseManifest(i,options));
 assert.equal(await fs.readFile(join(pre,'keep'),'utf8'),'prior');
});
test('Prepare kann keine ungeprüften Container-Nachzügler veröffentlichen',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput(),dir=await work(s,i);
 const op=await s.publishReverseManifest(i,{prepare:async()=>{await fs.writeFile(join(dir,'late'),'not declared');await fs.writeFile(join(dir,'src/main.txt'),'changed');},commit:async()=>{}});
 const dest=join(cfg.speicher.reverseRoot,op.storage_key);
 assert.equal(await fs.readFile(join(dest,'src/main.txt'),'utf8'),'abc');
 await assert.rejects(fs.stat(join(dest,'late')),e=>e.code==='ENOENT');
});


test('Vor RV4 begonnenes Reverse-Staging bleibt publizierbar',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg});
 const a={bereich:'reverse',ziel_ref:'rev-legacy-c0ffee',storage_kind:'assets',logischer_pfad:'old.bin'};
 const st=await s.stage(a,[Buffer.from('abc')],{groesse:3,sha256:sha('abc')});
 const old=a.ziel_ref+'/.intern/staging/'+st.id+'.part',journal=join(cfg.speicher.reverseRoot,a.ziel_ref,'.intern/journal',st.id+'.json');
 await fs.mkdir(join(cfg.speicher.reverseRoot,a.ziel_ref,'.intern/staging'),{recursive:true});
 await fs.rename(join(cfg.speicher.reverseRoot,'_eingang',st.id),join(cfg.speicher.reverseRoot,old));
 const op=JSON.parse(await fs.readFile(journal,'utf8'));op.staging_key=old;await fs.writeFile(journal,JSON.stringify(op));
 await s.publish(st,{basisSha256:null,...options});
 assert.equal((await s.readRange(a,0,3)).toString(),'abc');
});
test('Reverse-Bytegrenzen gelten auch für Manifest-Snapshots',async()=>{
 // (angepasst P25-T12, P18-T93: Grenzen ueber max_datei_bytes und eintrag_bytes statt cfg.reverse.maxDateiBytes/maxProjektBytes)
 try{
  const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput();await work(s,i);
  await grenzen({max_datei_bytes:2});
  await assert.rejects(s.publishReverseManifest(i,options),e=>e.code==='quote');
  // Querbedingung max_datei_bytes <= eintrag_bytes (REVERSE_EINSTELL_REGELN): zwei Dateien je 3 Bytes, je Datei erlaubt, zusammen zu viel.
  await grenzen({eintrag_bytes:5,max_datei_bytes:4});
  const zwei={...i,dateien:[...i.dateien,{pfad:'src/b.txt',groesse:3,sha256:sha('abc')}]};
  await assert.rejects(new api.AssetSpeicher({konfiguration:cfg}).publishReverseManifest(zwei,options),e=>e.code==='quote');
 }finally{await grenzen();}
});

test('Recovery benötigt verwaist UND abgeschlossene Recovery; Ghidra bleibt',async()=>{
 const s=new api.AssetSpeicher({konfiguration:cfg}),i=newInput(),dir=await work(s,i);
 assert.equal(await s.recoveryReverseArbeit(i.auftragId,{istVerwaist:async()=>false,recover:async()=>true}),false);
 assert.ok(await fs.stat(dir));
 assert.equal(await s.recoveryReverseArbeit(i.auftragId,{istVerwaist:async()=>true,recover:async()=>false}),false);
 assert.ok(await fs.stat(dir));
 assert.equal(await s.recoveryReverseArbeit(i.auftragId,{istVerwaist:async()=>true,recover:async()=>true}),true);
 await assert.rejects(fs.stat(dir),e=>e.code==='ENOENT');
 await assert.rejects(s.recoveryReverseArbeit('ghidra',{istVerwaist:async()=>true,recover:async()=>true}));
});
