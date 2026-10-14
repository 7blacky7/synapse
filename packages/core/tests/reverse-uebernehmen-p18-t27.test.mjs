/** Welle3/P18-T27: nur eigenes synapse_test-Schema und Temp-Wurzeln. Nicht vom Autor ausgeführt.
 * Basis-Rotkontrolle: dieselbe Datei gegen dist von t99; Ergebnis success der Übernahme muss rot werden.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {Pool}=createRequire(import.meta.url)('pg');
test('RV17: Revision, Herkunft, Manifest, Fake-Daemon und verweigerte Übernahmen',async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.pathname,'/synapse_test');assert.equal(url.port,'5433');
 const root=await mkdtemp(join(tmpdir(),'p18-rv17-'));
 Object.assign(process.env,{SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:join(root,'projekte'),SYNAPSE_REVERSE_ROOT:join(root,'reverse')});
 const core=await import('../dist/index.js');
 const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
 const raw=new Pool({connectionString:process.env.DATABASE_URL}),schema='p18_rv17_'+randomUUID().replaceAll('-','');
 const db={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
 const project='p18_rv17',rid='rev-rv17-abcdef',agent='p18-rv17-agent',bytes=Buffer.from('synthetic asset bytes'),sha=createHash('sha256').update(bytes).digest('hex');
 try{
  await raw.query('CREATE SCHEMA '+schema);
  for(const t of ['projects','agent_sessions','tool_aktivitaet'])await db.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING DEFAULTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE code_files(project text,file_path text)');
  for(const f of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql'])await db.query(await readFile(new URL('../src/db/schema-sql/'+f,import.meta.url),'utf8'));
  await db.query(REVERSE_SCHEMA_SQL);
  // Retention table only; links are unrelated to the transfer.
  await db.query("CREATE TABLE reverse_ansicht_retention(ref_key text PRIMARY KEY,eintrag_id text,sha256 text,expires_at timestamptz,released_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())");
  await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rv17',true)",[project]);
  await db.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',now())",[agent,project]);
  await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'RV17','bestaetigt')",[rid]);
  const m=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,art) VALUES($1,0,'ordner') RETURNING id",[rid])).rows[0].id;
  const key=rid+'/assets/menu.png';
  const d=(await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,format) VALUES($1,$2,'menu.png',$3,$4,'asset',$5,'png') RETURNING id",[rid,m,sha,bytes.length,key])).rows[0].id;
  // Derived-asset source uses a stable RV4 layout, avoiding original-medium fixture policy.
  await db.query("INSERT INTO reverse_assets(eintrag_id,datei_id,pfad,sha256,groesse,storage_key,format,mime) VALUES($1,$2,'derived.png',$3,$4,$5,'png','image/png')",[rid,d,sha,bytes.length,key]);
  const cfg=core.ladeAssetKonfiguration(process.env);
  await mkdir(join(cfg.speicher.reverseRoot,rid,'assets'),{recursive:true});await writeFile(join(cfg.speicher.reverseRoot,key),bytes);
  const service=core.createReverseToolService({pool:db});
  const call=(action,extra={})=>service.ausfuehren({action,agent_id:agent,project,reverse_id:rid,...extra});
  const input={file_path:'derived.png',ziel_pfad:'guide/pic/menu.png'};
  assert.equal((await call('uebernehmen',input)).fehlercode,'nicht_gebunden');
  assert.equal((await call('binden')).success,true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM asset_files')).rows[0].n,0,'Bindung kopiert nichts');
  const r=await call('uebernehmen',input);
  assert.equal(r.success,true,JSON.stringify(r)); // Basis t99: nicht_unterstuetzt, echter Ergebnisfehler.
  assert.equal(r.revision,'1');assert.equal(r.ziel_pfad,input.ziel_pfad);
  const row=(await db.query('SELECT * FROM asset_files WHERE id=$1',[r.asset_id])).rows[0];
  assert.equal(row.file_path,input.ziel_pfad);assert.equal(row.reverse_id,rid);assert.equal(row.reverse_quellpfad,'derived.png');assert.equal(row.reverse_quellhash,sha);
  assert.equal(row.storage_status,'ready');assert.equal(row.transport_sha256,sha);
  assert.equal((await db.query('SELECT quelle FROM asset_revisionen WHERE asset_id=$1',[r.asset_id])).rows[0].quelle,'reverse');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reverse_uebernahmen WHERE asset_id=$1 AND asset_revision=1',[r.asset_id])).rows[0].n,1);
  const ctx={bereich:'projekt',ziel_ref:project,host_id:'fake-daemon'};
  const manifest=await new core.AssetManifestKern({db,konfiguration:cfg}).manifest(ctx);
  assert.equal(manifest.eintraege[0].pfad,input.ziel_pfad);
  const download=await new core.AssetUploadKern({db,konfiguration:cfg}).bytes(ctx,{asset_id:r.asset_id,revision:'1'});
  const chunks=[];for await(const b of download.stream)chunks.push(b);assert.deepEqual(Buffer.concat(chunks),bytes);
  assert.deepEqual(await readFile(join(cfg.speicher.root,project,'assets',input.ziel_pfad)),bytes);
  const occupied=await call('uebernehmen',input);assert.equal(occupied.fehlercode,'ziel_belegt');assert.equal(occupied.vorhandene_revision,'1');
  const overwrite=await call('uebernehmen',{...input,ueberschreiben:true});assert.equal(overwrite.success,true,JSON.stringify(overwrite));assert.equal(overwrite.revision,'2');
  for(const layer of ['S1','S2','S3'])assert.equal((await call('uebernehmen',{...input,file_path:'game.exe@'+layer+'/f.c'})).fehlercode,'keine_berechtigung');
  await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,art) VALUES($1,$2,'game.exe','binaer')",[rid,m]);
  assert.equal((await call('uebernehmen',{...input,file_path:'game.exe',ziel_pfad:'game.exe'})).fehlercode,'keine_berechtigung');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM code_files')).rows[0].n,0);
  assert.equal((await call('uebernehmen',{...input,project:'fremd'})).fehlercode,'keine_berechtigung');
 }finally{await raw.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await raw.end();await rm(root,{recursive:true,force:true});}
});
