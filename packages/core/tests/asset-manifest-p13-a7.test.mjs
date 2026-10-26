/** A7 testphase: only own synapse_test schema and synthetic storage root. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {AssetManifestKern} from '../dist/services/asset-manifest.js';
import {AssetUploadKern} from '../dist/services/asset-upload.js';
import {AssetSpeicher} from '../dist/services/asset-speicher.js';
import {ladeAssetKonfiguration} from '../dist/config/asset-konfig.js';
import {zieheSpaltenNach} from './_helfer/privatschema-spalten.mjs';
const pg=createRequire(new URL('../package.json',import.meta.url))('pg');
const schema='p13_a7_'+randomUUID().replaceAll('-','');
const ctx={bereich:'projekt',ziel_ref:'p13_a7',host_id:'daemon_test'};
const sha=b=>createHash('sha256').update(b).digest('hex');
let admin,db,cfg,root;
async function connection(){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');
 await c.query('SET search_path TO '+schema+',public');
 return {query:(s,v)=>c.query(s,v),release:()=>c.end()};
}
before(async()=>{
 admin=await connection();await admin.query('CREATE SCHEMA '+schema);await admin.query('SET search_path TO '+schema+',public');
 // (angepasst P25-T10, P13-T29: ziel_belegt legt einen Konflikteingang an; ohne 100 landete er in public.asset_konflikt_eingaenge -> FK-Fehler)
 for(const file of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql','100_asset_konflikte.sql']){
  const sql=await fs.readFile(new URL('../src/db/schema-sql/'+file,import.meta.url),'utf8');await admin.query(sql);
  await admin.query(sql); // idempotent mirror DDL
 }
 // (angepasst P25-T10, Handliste ohne spaetere Spalten, z. B. asset_revisionen.restore_until aus P13-T29): Spalten aus public nachziehen.
 await zieheSpaltenNach(admin,schema);
 root=await fs.mkdtemp(join(tmpdir(),'p13-a7-'));
 cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:root});
 db={connect:connection,async query(s,v){const c=await connection();try{return await c.query(s,v);}finally{await c.release();}}};
});
after(async()=>{if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.release();}if(root)await fs.rm(root,{recursive:true,force:true});});
const upload=()=>new AssetUploadKern({db,konfiguration:cfg,speicher:new AssetSpeicher({konfiguration:cfg})});
const manifest=(d=db,s=new AssetSpeicher({konfiguration:cfg}))=>new AssetManifestKern({db:d,konfiguration:cfg,speicher:s});
async function put(pfad,bytes,basis='0',c=ctx){
 const a=upload(),b=Buffer.from(bytes),u=await a.erstellen(c,{logischer_pfad:pfad,storage_kind:'assets',groesse:b.length,sha256:sha(b),basis_revision:basis,idempotency_key:randomUUID()});
 if(b.length)await a.teil(c,u.id,0,b.length,[b]);return a.finalisieren(c,u.id);
}
async function bytes(id,revision,c=ctx){const r=await upload().bytes(c,{asset_id:id,revision});const chunks=[];for await(const b of r.stream)chunks.push(b);return Buffer.concat(chunks).toString();}
const input=(v,extra={})=>({event_id:randomUUID(),asset_id:v.asset_id,basis_revision:v.revision,...extra});
test('A7 feature is absent on deployed baseline (positive counterpart here)',()=>{
 assert.equal(typeof AssetManifestKern,'function');assert.equal(typeof AssetSpeicher.prototype.mutierePfad,'function');
});
test('explicit rename keeps ID, requires old path, no byte upload, revision readers preserved',async()=>{
 const v=await put('rename/from.png','rename-bytes'),s=new AssetSpeicher({konfiguration:cfg});
 s.stage=()=>{throw new Error('move must not stage upload bytes');};
 const m=manifest(db,s),e=input(v,{alter_pfad:'rename/from.png',pfad:'rename/to.png'});
 const moved=await m.mutieren(ctx,'verschieben',e);
 assert.equal(moved.asset_id,v.asset_id);assert.equal(moved.revision,'2');assert.equal(moved.alter_pfad,'rename/from.png');
 assert.equal(await bytes(v.asset_id,'1'),'rename-bytes');assert.equal(await bytes(v.asset_id,'2'),'rename-bytes');
 await assert.rejects(fs.stat(join(root,ctx.ziel_ref,'assets','rename/from.png')),e=>e.code==='ENOENT');
 assert.equal(await fs.readFile(join(root,ctx.ziel_ref,'assets','rename/to.png'),'utf8'),'rename-bytes');
 assert.deepEqual(await m.mutieren(ctx,'verschieben',e),moved);
 assert.equal(await m.assetNachPfad(ctx,'rename/from.png',e.event_id),v.asset_id);
 await assert.rejects(m.mutieren(ctx,'verschieben',{...e,pfad:'rename/wrong.png'}),e=>e.code==='idempotency_konflikt');
});
test('identical content remains two assets; occupied target and missing/wrong old path conflict',async()=>{
 const a=await put('twins/a.png','same'),b=await put('twins/b.png','same'),m=manifest();
 assert.notEqual(a.asset_id,b.asset_id);
 await assert.rejects(m.mutieren(ctx,'verschieben',input(a,{alter_pfad:'twins/a.png',pfad:'twins/b.png'})),e=>e.code==='ziel_belegt');
 await assert.rejects(m.mutieren(ctx,'verschieben',input(a,{alter_pfad:'twins/missing.png',pfad:'twins/c.png'})),e=>e.code==='revision_konflikt');
 assert.equal(await bytes(a.asset_id,'1'),'same');assert.equal(await bytes(b.asset_id,'1'),'same');
});
test('soft delete needs known current base; restore retains ID and creates a new revision',async()=>{
 const v=await put('delete/asset.png','retained'),m=manifest();
 await assert.rejects(m.mutieren(ctx,'loeschen',{event_id:randomUUID(),asset_id:v.asset_id}),e=>e.code==='revision_konflikt');
 await assert.rejects(m.mutieren(ctx,'loeschen',input(v,{basis_revision:'90'})),e=>e.code==='revision_konflikt');
 const e=input(v),deleted=await m.mutieren(ctx,'loeschen',e);
 assert.equal(deleted.revision,'2');assert.ok(deleted.deleted_at);assert.ok(new Date(deleted.restore_until)>new Date(deleted.deleted_at));
 assert.deepEqual(await m.mutieren(ctx,'loeschen',e),deleted);
 await assert.rejects(fs.stat(join(root,ctx.ziel_ref,'assets','delete/asset.png')),e=>e.code==='ENOENT');
 await assert.rejects(upload().bytes(ctx,{asset_id:v.asset_id,revision:'1'}),e=>e.code==='asset_geloescht');
 const restored=await m.mutieren(ctx,'wiederherstellen',input(deleted));
 assert.equal(restored.asset_id,v.asset_id);assert.equal(restored.revision,'3');assert.equal(restored.deleted_at,null);
 assert.equal(await bytes(v.asset_id,'1'),'retained');assert.equal(await bytes(v.asset_id,'3'),'retained');
 await assert.rejects(upload().bytes(ctx,{asset_id:v.asset_id,revision:'2'}),e=>e.code==='revision_fehlt');
});
test('expired restore window cannot revive or discard retained bytes',async()=>{
 const v=await put('expired/asset.png','keep'),m=manifest(),d=await m.mutieren(ctx,'loeschen',input(v));
 const key=(await db.query('SELECT storage_key FROM asset_files WHERE id=$1',[v.asset_id])).rows[0].storage_key;
 await db.query("UPDATE asset_files SET restore_until=clock_timestamp()-interval '1 second' WHERE id=$1",[v.asset_id]);
 await assert.rejects(m.mutieren(ctx,'wiederherstellen',input(d)),e=>e.code==='revision_konflikt');
 assert.equal(await fs.readFile(join(root,key),'utf8'),'keep');
});
test('manifest paging is one stable snapshot; delta catches changes during scan and incomplete scan deletes nothing',async()=>{
 const m=manifest(),v=await put('snapshot/old.png','old'),first=await m.manifest(ctx,{limit:1});
 assert.equal(first.vollstaendig,false);
 await put('snapshot/new.png','new');await put('snapshot/old.png','changed','1');
 const entries=[...first.eintraege];let c=first.cursor;
 while(c){const page=await m.manifest(ctx,{cursor:c,limit:1});assert.equal(page.stand,first.stand);entries.push(...page.eintraege);c=page.cursor;}
 assert.equal(entries.find(x=>x.asset_id===v.asset_id).revision,'1');
 assert.equal(entries.some(x=>x.pfad==='snapshot/new.png'),false);
 const delta=await m.aenderungen(ctx,{cursor:first.aenderungs_cursor});
 assert.ok(delta.eintraege.some(x=>x.metadaten.pfad==='snapshot/new.png'));
 assert.ok(delta.eintraege.some(x=>x.asset_id===v.asset_id&&x.revision==='2'));
 const before=(await db.query('SELECT count(*)::int AS n FROM asset_files WHERE project=$1 AND deleted_at IS NOT NULL',[ctx.ziel_ref])).rows[0].n;
 await m.manifest(ctx,{limit:1}); // deliberately unfinished
 assert.equal((await db.query('SELECT count(*)::int AS n FROM asset_files WHERE project=$1 AND deleted_at IS NOT NULL',[ctx.ziel_ref])).rows[0].n,before);
 await assert.rejects(m.manifest({...ctx,host_id:'foreign'},{cursor:first.cursor}),e=>e.code==='manifest_abgelaufen');
 await assert.rejects(m.aenderungen({...ctx,ziel_ref:'foreign'},{cursor:first.aenderungs_cursor}),e=>e.code==='cursor_ungueltig');
});
test('late commit with lower BIGSERIAL ID is caught by commit watermark',async()=>{
 const c={...ctx,ziel_ref:'p13_a7_late'},v=await put('late.png','late','0',c),m=manifest();
 const start=await m.aenderungen(c),a=await db.connect(),b=await db.connect();
 try{
  await a.query('BEGIN');
  const low=(await a.query("SELECT nextval(pg_get_serial_sequence('asset_aenderungen','id'))::text AS id")).rows[0].id;
  const high=(await b.query("INSERT INTO asset_aenderungen(project,asset_id,revision,art) VALUES($1,$2,1,'early') RETURNING id::text",[c.ziel_ref,v.asset_id])).rows[0].id;
  assert.ok(BigInt(low)<BigInt(high));
  const early=await m.aenderungen(c,{cursor:start.cursor});assert.equal(early.eintraege.at(-1).art,'early');
  await a.query("INSERT INTO asset_aenderungen(id,project,asset_id,revision,art) VALUES($1,$2,$3,1,'late')",[low,c.ziel_ref,v.asset_id]);await a.query('COMMIT');
  const late=await m.aenderungen(c,{cursor:early.cursor});assert.equal(late.eintraege.length,1);assert.equal(late.eintraege[0].art,'late');
  assert.ok(BigInt(late.eintraege[0].stand)>BigInt(early.stand));
 }finally{await a.query('ROLLBACK');await a.release();await b.release();}
});
test('PG failure after move preserves bytes; explicit orphan recovery restores base and is idempotent',async()=>{
 const v=await put('recovery/from.png','recover'),event=randomUUID();let broken=true;
 const crash={...db,async connect(){const c=await db.connect();return {...c,query:async(s,p)=>{if(broken&&s.startsWith('INSERT INTO asset_revisionen')){broken=false;throw new Error('mutation PG crash');}return c.query(s,p);}};}};
 await assert.rejects(manifest(crash).mutieren(ctx,'verschieben',input(v,{event_id:event,alter_pfad:'recovery/from.png',pfad:'recovery/to.png'})),/mutation PG crash/);
 const row=(await db.query('SELECT * FROM asset_mutationen WHERE event_id=$1',[event])).rows[0];
 assert.equal(row.status,'prepared');
 await db.query("UPDATE asset_mutationen SET lease_bis=clock_timestamp()-interval '1 second' WHERE id=$1",[row.id]);
 const m=manifest();await assert.rejects(m.recovery(ctx,row.id,{istVerwaist:async()=>false}),e=>e.code==='recovery_unbestaetigt');
 const recovered=await m.recovery(ctx,row.id,{istVerwaist:async()=>true});assert.equal(recovered.status,'abgebrochen');
 assert.equal((await m.recovery(ctx,row.id,{istVerwaist:async()=>true})).status,'abgebrochen');
 assert.equal(await fs.readFile(join(root,ctx.ziel_ref,'assets','recovery/from.png'),'utf8'),'recover');
 await assert.rejects(fs.stat(join(root,ctx.ziel_ref,'assets','recovery/to.png')),e=>e.code==='ENOENT');
 assert.equal(await bytes(v.asset_id,'1'),'recover');
});
