/** A11 deployed-t85 Golden/semantic positive control. No fixture is generated from the candidate. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
test('A11 semantic deployed-basis red and candidate green',async()=>{
process.env.SYNAPSE_A11_POSITIV='1';
const rootUrl=process.env.SYNAPSE_A11_BASIS?pathToFileURL(process.env.SYNAPSE_A11_BASIS+'/'):new URL('../../../',import.meta.url);
const load=p=>import(new URL(p,rootUrl));
const D=await load('packages/core/dist/db/client.js'),C=await load('packages/core/dist/config/asset-konfig.js');
const pg=createRequire(new URL('../package.json',import.meta.url))('pg');
const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const schema='p13_a11_golden_'+randomUUID().replaceAll('-',''),project='p13_a11',target=await mkdtemp(join(tmpdir(),'synapse-a11-golden-'));
assert.equal(await realpath(target),target);
const connect=async()=>{const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n,'synapse_test');await c.query('SET search_path TO '+schema+',public');return {query:c.query.bind(c),release:()=>c.end()};};
const db={connect,async query(s,v){const c=await connect();try{return await c.query(s,v);}finally{await c.release();}}};
const admin=await connect(),old={...process.env};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const f of ['95_asset_intel.sql','96_asset_transport.sql','98_asset_upload.sql','99_asset_manifest.sql','100_asset_konflikte.sql'])await admin.query(await readFile(new URL('../src/db/schema-sql/'+f,import.meta.url),'utf8'));
 await admin.query('CREATE TABLE code_files(project TEXT,file_path TEXT,file_type TEXT);CREATE TABLE projects(name TEXT,enabled BOOLEAN)');
 await admin.query('INSERT INTO projects VALUES($1,true)',[project]);
 Object.assign(process.env,{SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:target,SYNAPSE_API_FEATURES:'asset_sync'});C.resetAssetKonfiguration();
 const A=await load('packages/core/dist/services/asset-intel-tool.js'),W=await load('packages/core/dist/services/asset-weiche.js');
 if(process.env.SYNAPSE_A11_POSITIV==='1'){
  const {AssetUploadKern}=await load('packages/core/dist/services/asset-upload.js'),cfg=C.ladeAssetKonfiguration(process.env),upload=new AssetUploadKern({db,konfiguration:cfg});
  const ctx={bereich:'projekt',ziel_ref:project,host_id:'positive-control'},sha=x=>createHash('sha256').update(x).digest('hex');
  const stage=async(b,basis='0')=>{const s=await upload.erstellen(ctx,{logischer_pfad:'control.png',storage_kind:'assets',groesse:b.length,sha256:sha(b),basis_revision:basis,idempotency_key:randomUUID()});await upload.teil(ctx,s.id,0,b.length,[b]);return s;};
  const basis=await upload.finalisieren(ctx,(await stage(Buffer.from('basis'))).id);
  const pending=await stage(Buffer.from('PC'),basis.revision);
  const share=await upload.finalisieren(ctx,(await stage(Buffer.from('Share'),basis.revision)).id);
  let result;try{result=await upload.finalisieren(ctx,pending.id);}catch(e){assert.fail('A11 semantic control: both changed must preserve PC revision; old finalizer rejected with '+e.code);}
  assert.equal(result.revision,share.revision);
  assert.equal(result.ergebnis.konflikt.pc.sha256,sha(Buffer.from('PC')));
  assert.equal((await db.query('SELECT transport_sha256 FROM asset_files WHERE project=$1',[project])).rows[0].transport_sha256,sha(Buffer.from('Share')));
  console.log('A11 SEMANTIC POSITIVE CONTROL PASS: Share canonical, PC retained revision');
 }else{
  await admin.query("INSERT INTO asset_files(project,file_path,file_name,extension,asset_type,format,status,inspector,file_size,sha256,mtime,extracted_at,created_at,updated_at) VALUES($1,'golden.png','golden.png','png','bild','png','ok','fixture',4,$2,'2020-01-01','2020-01-01','2020-01-01','2020-01-01')",[project,'a'.repeat(64)]);
  const {assetIntelTool}=await load('packages/mcp-server/dist/tools/consolidated/asset-intel.js');
  const values=[];
  for(const action of ['inspect','objects','references','used_by','missing','graph','move_preview','health']){
   const args={action,project,file_path:'golden.png',...(action==='objects'?{object_type:'image'}:{}),...(action==='move_preview'?{new_path:'new.png'}:{})};
   const rest=await D.mitLesePool(db,()=>A.fuehreAssetIntelAus(args));
   assert.equal(rest.success,true,'Golden requires successful '+action);
   assert.equal('konflikt' in rest,false);
   const stdio=await D.mitLesePool(db,()=>assetIntelTool.handler(args));values.push({action,rest,stdio});
  }
  const weiche=await D.mitLesePool(db,()=>W.ergaenzeCodeIntelAntwort('file',{project,file_path:'golden.png'},{success:false,error:'Datei nicht gefunden'}));
  assert.equal(weiche.beantwortet_von,'asset_intel');assert.equal('konflikt' in weiche,false);
  values.push({weiche});
  process.stdout.write(JSON.stringify(values)+'\n');
 }
}finally{
 await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.release();await rm(target,{recursive:true,force:true});
 for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);C.resetAssetKonfiguration();
}

});
