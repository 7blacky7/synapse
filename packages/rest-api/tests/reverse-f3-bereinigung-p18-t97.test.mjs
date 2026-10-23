/**
 * P18-T97 F3/R1-R3. Coordinator TESTPHASE only; synapse_test:5433 only.
 * Own disposable schema/data, no container/share/production work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ENTRY,canon,sha,createManifest,applyManifest,verifyManifest,projectSentinel,validName,batchCost} from '../scripts/reverse-f3-bereinigen.mjs';
const enabled=process.env.SYNAPSE_TEST_PHASE==='P18-T97-F3';
const run=(name,fn)=>test(name,{skip:!enabled},fn);
const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const migration=()=>readFile(new URL('../../core/src/db/schema-sql/145_reverse_f3_bereinigung.sql',import.meta.url),'utf8');
async function fixture(t,{rows=5000,symbols=3}={}){
 const url=new URL(process.env.DATABASE_URL??'http://invalid');
 assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
 const schema='f3_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url.href});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const pool=new Pool({connectionString:url.href,options:'-c search_path='+schema+',public',max:5});
 const extraSchemas=[];
 t.after(async()=>{await pool.end();for(const extra of extraSchemas)await admin.query('DROP SCHEMA IF EXISTS "'+extra+'" CASCADE');await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();});
 await pool.query("CREATE TABLE reverse_eintraege(id text PRIMARY KEY)");
 await pool.query("INSERT INTO reverse_eintraege VALUES($1),('foreign')",[ENTRY]);
 await pool.query("CREATE TABLE reverse_dateien(id bigint PRIMARY KEY,eintrag_id text NOT NULL,pfad text,format text,sha256 text,storage_key text,metadaten jsonb DEFAULT '{}',UNIQUE(id,eintrag_id))");
 await pool.query("CREATE TABLE reverse_code_dateien(id text PRIMARY KEY,eintrag_id text NOT NULL,file_path text NOT NULL,file_name text NOT NULL,datei_id bigint NOT NULL,schicht text NOT NULL,parser_generation_id text,deleted_at timestamptz,content text,content_hash text,UNIQUE(eintrag_id,file_path))");
 await pool.query("CREATE TABLE reverse_code_symbole(id text PRIMARY KEY,eintrag_id text NOT NULL,file_path text NOT NULL,datei_id bigint,schicht text,parser_generation_id text,parent_symbol text REFERENCES reverse_code_symbole(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,value text,FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)");
 await pool.query("CREATE TABLE reverse_code_verweise(id text PRIMARY KEY,eintrag_id text,file_path text,symbol_id text REFERENCES reverse_code_symbole(id) ON DELETE CASCADE,FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)");
 await pool.query("CREATE TABLE reverse_code_statements(id bigint PRIMARY KEY,eintrag_id text,file_path text,FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)");
 await pool.query("CREATE TABLE reverse_code_kanten(id bigint PRIMARY KEY,eintrag_id text,file_path text,target_symbol_id text REFERENCES reverse_code_symbole(id) ON DELETE SET NULL,FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)");
 await pool.query("CREATE TABLE reverse_einstellungen(ebene text,project text,eintrag_id text,name text,wert bigint,wert_text text)");
 await pool.query("INSERT INTO reverse_einstellungen(ebene,eintrag_id,name,wert) VALUES('eintrag',$1,'e_uebernahme_block_zeilen',$2),('eintrag',$1,'materialisierung_tx_bytes',65536)",[ENTRY,rows]);
 await pool.query("CREATE TABLE agent_profil_schalter(ebene text,project text,funktion text,aktiv boolean,grund text,gesetzt_von text,gesetzt_am timestamptz)");
 await pool.query("INSERT INTO agent_profil_schalter VALUES('global',NULL,'reverse_pipeline_halt',true,'own fixture','coordinator',now())");
 await pool.query("CREATE TABLE reverse_auftraege(status text,lease_bis timestamptz)");
 await pool.query("CREATE TABLE work_jobs(id uuid,scope text,state text,attempt int,resource_unconfirmed boolean)");
 await pool.query("CREATE TABLE tool_container_runs(job_id uuid,attempt int,state text)");
 // Direct and every indirect ownership route required by review R3.
 await pool.query("CREATE TABLE asset_files(id bigint PRIMARY KEY,project text,file_path text,sha256 text)");
 await pool.query("INSERT INTO asset_files VALUES(1,'project','keep.png',$1)",['f'.repeat(64)]);
 for(const table of ['asset_objects','asset_references','code_files','code_symbols','code_references','code_statements','code_call_edges','code_chunks','file_versions']){
  await pool.query('CREATE TABLE '+table+'(id text PRIMARY KEY,project text,value text)');
  await pool.query('INSERT INTO '+table+" VALUES('keep','project','unchanged')");
 }
 await pool.query("CREATE TABLE asset_revisionen(asset_id bigint,revision bigint,sha256 text)");
 await pool.query("INSERT INTO asset_revisionen VALUES(1,1,'keep')");
 await pool.query("CREATE TABLE asset_konflikte(id bigint,asset_id bigint,status text)");
 await pool.query("INSERT INTO asset_konflikte VALUES(1,1,'offen')");
 await pool.query("CREATE TABLE asset_retention_referenzen(ref_key text,asset_id bigint,revision bigint,art text)");
 await pool.query("INSERT INTO asset_retention_referenzen VALUES('keep',1,1,'link')");
 await pool.query("CREATE TABLE asset_manifest_sitzungen(id uuid PRIMARY KEY,project text)");
 await pool.query("INSERT INTO asset_manifest_sitzungen VALUES('00000000-0000-4000-8000-000000000001','project')");
 await pool.query("CREATE TABLE asset_manifest_eintraege(manifest_id uuid,asset_id bigint,metadaten jsonb)");
 await pool.query("INSERT INTO asset_manifest_eintraege VALUES('00000000-0000-4000-8000-000000000001',1,'{}')");
 await pool.query("CREATE TABLE asset_scan_checkpoints(root_key text PRIMARY KEY,stand jsonb)");
 await pool.query("INSERT INTO asset_scan_checkpoints VALUES('projekt:own:/log-data','{}')");
 await pool.query("CREATE TABLE asset_upload_sitzungen(id uuid PRIMARY KEY,bereich text,ziel_ref text,sha256 text)");
 await pool.query("INSERT INTO asset_upload_sitzungen VALUES('00000000-0000-4000-8000-000000000002','projekt','project','keep')");
 await pool.query("CREATE TABLE asset_upload_teile(upload_id uuid,byte_offset bigint,sha256 text)");
 await pool.query("INSERT INTO asset_upload_teile VALUES('00000000-0000-4000-8000-000000000002',0,'keep')");
 await pool.query(await migration());await pool.query(await migration());
 for(const [id,format] of [[1,'png'],[2,'wav'],[3,'pe'],[4,'unbekannt']])
  await pool.query('INSERT INTO reverse_dateien VALUES($1,$2,$3,$4,$5,$6,$7)',[id,ENTRY,'source'+id,format,'a'.repeat(64),ENTRY+'/entpackt/source'+id,{}]);
 const add=async(id,source,name,stage='S1',generation=null)=>{
  await pool.query('INSERT INTO reverse_code_dateien VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9)',[id,ENTRY,'source'+source+'@'+stage+'/'+name,name,source,stage,generation,name==='imports.txt'?'':'own noise',sha('own noise')]);
 };
 await add('a',1,'strings.txt');await add('b',1,'imports.txt');await add('c',2,'strings-0002.txt');
 await add('d',3,'strings.txt');await add('e',3,'function.c','S3');await add('e2',3,'instructions.txt','S2');await add('f',4,'strings.txt');
 await add('g',1,'strings-evil.txt');await add('h',1,'strings-0003.txt','S1','new-parser');
 for(let i=0;i<symbols;i++)await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,datei_id,schicht,value) VALUES($1,$2,'source1@S1/strings.txt',1,'S1',$3)",['a-'+String(i).padStart(5,'0'),ENTRY,'own noise '+i]);
 // A genuinely foreign entry and source must remain untouched.
 await pool.query("INSERT INTO reverse_code_dateien VALUES('foreign','foreign','foreign@S1/strings.txt','strings.txt',1,'S1',NULL,NULL,'keep','keep')");
 const counts=async()=>({
  files:(await pool.query('SELECT id FROM reverse_code_dateien ORDER BY id')).rows,
  symbols:(await pool.query('SELECT id,parent_symbol FROM reverse_code_symbole ORDER BY id')).rows,
  evidence:(await pool.query('SELECT count(*)::text AS n FROM reverse_f3_bereinigungs_batches')).rows[0].n
 });
 const make=async()=>{
  const records=[];const result=await createManifest(pool,raw=>records.push(raw));
  const lines=async function*(){yield* records;};
  return {...result,records,lines,expected:result.sha256,backup:'verified-own-test-backup'};
 };
 return {pool,make,counts,admin,schema,add,extraSchemas};
}
run('dry-run is read-only; strict names; genuine code/unknown/foreign protected',async t=>{
 const f=await fixture(t),before=await f.counts(),m=await f.make();
 assert.deepEqual(await f.counts(),before);assert.equal(m.files,3);assert.equal(m.symbols,3);
 const {header}=await verifyManifest(m.lines,m.expected,m.backup);
 assert.equal(header.entry,ENTRY);
 for(const name of ['strings.txt','strings-0002.txt','imports.txt'])assert.equal(validName(name),true);
 for(const name of ['strings-evil.txt','strings.txt/other','xstrings.txt','strings2.txt','imports-1.txt'])assert.equal(validName(name),false);
 assert.deepEqual(m.records.slice(1).map(JSON.parse).filter(x=>x.kind==='file').map(x=>x.id),['a','b','c']);
});
run('bounded multi-batch delete + atomic evidence; resume after ACK loss',async t=>{
 const f=await fixture(t,{rows:2,symbols:12}),m=await f.make(),projects=await projectSentinel(f.pool);
 await assert.rejects(applyManifest(f.pool,{...m,afterCommit:()=>{throw Error('simulated lost ACK');}}),/simulated lost ACK/);
 assert.equal((await f.counts()).evidence,'1');
 const seen=[];
 const result=await applyManifest(f.pool,{...m,onBatch:b=>seen.push(b)});
 assert.equal(result.resumed_batches,1);assert.equal(result.status,'fertig');
 for(const b of seen){assert.ok(b.cost.rows<=2);assert.ok(b.cost.bytes<=65536);}
 const state=await f.counts();assert.deepEqual(state.files.map(x=>x.id),['d','e','e2','f','foreign','g','h']);assert.equal(state.symbols.length,0);
 assert.deepEqual(await projectSentinel(f.pool),projects);
 const again=await applyManifest(f.pool,m);assert.equal(again.committed_batches,0);assert.ok(again.resumed_batches>1);
});
run('crash before COMMIT rolls back deletes AND journal',async t=>{
 const f=await fixture(t,{rows:2}),m=await f.make(),before=await f.counts();
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:()=>{throw Error('before commit');}}),/before commit/);
 assert.deepEqual(await f.counts(),before);
 assert.equal((await applyManifest(f.pool,m)).status,'fertig');
});
run('missing row without atomic evidence is not adopted',async t=>{
 const f=await fixture(t),m=await f.make();
 await f.pool.query("DELETE FROM reverse_code_symbole WHERE id='a-00000'");
 await assert.rejects(applyManifest(f.pool,m),/f3_symbol_geaendert/);
 assert.equal((await f.counts()).evidence,'0');
});
run('internal parent, external ref and SET NULL target all stop without side effects',async t=>{
 for(const kind of ['parent','ref','edge']){
  await t.test(kind,async t=>{
   const f=await fixture(t);
   if(kind==='parent')await f.pool.query("UPDATE reverse_code_symbole SET parent_symbol='a-00000' WHERE id='a-00001'");
   if(kind==='ref')await f.pool.query("INSERT INTO reverse_code_verweise VALUES('ref',$1,'source3@S1/strings.txt','a-00000')",[ENTRY]);
   if(kind==='edge')await f.pool.query("INSERT INTO reverse_code_kanten VALUES(1,$1,'source3@S1/strings.txt','a-00000')",[ENTRY]);
   const m=await f.make(),before=await f.counts();
   await assert.rejects(applyManifest(f.pool,m),/f3_abhaengigkeit_stop/);
   assert.deepEqual(await f.counts(),before);
   if(kind==='edge')assert.equal((await f.pool.query('SELECT target_symbol_id FROM reverse_code_kanten')).rows[0].target_symbol_id,'a-00000');
  });
 }
});
run('FK catalog change and unknown project owner fail closed',async t=>{
 const f=await fixture(t),m=await f.make();
 await f.pool.query("CREATE TABLE surprise(id text REFERENCES reverse_code_symbole(id) ON DELETE SET NULL)");
 await assert.rejects(applyManifest(f.pool,m),/f3_fk_unbekannt/);
 await f.pool.query('DROP TABLE surprise');
 await f.pool.query('CREATE TABLE asset_unzugeordnet(id text)');
 await assert.rejects(applyManifest(f.pool,m),/f3_projekttabelle_unzugeordnet/);
});
run('concurrent FK insert cannot pass the check/delete window',async t=>{
 const f=await fixture(t),m=await f.make(),other=await f.pool.connect();let race;
 try{
  await other.query("SET statement_timeout='10s'");
  await applyManifest(f.pool,{...m,beforeDelete:async({kind})=>{
   if(kind!=='symbol'||race)return;
   race=other.query("INSERT INTO reverse_code_verweise VALUES('race',$1,'source3@S1/strings.txt','a-00000')",[ENTRY]).then(()=>({ok:true}),e=>({code:e.code}));
  }});
  assert.equal((await race).code,'23503');
  assert.equal((await f.pool.query("SELECT count(*)::text AS n FROM reverse_code_verweise WHERE id='race'")).rows[0].n,'0');
 }finally{other.release();}
});
run('same-count project UPDATE before COMMIT rolls back current Reverse batch',async t=>{
 const f=await fixture(t),m=await f.make(),before=await f.counts();
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:async()=>{
  await f.pool.query("UPDATE code_files SET value='legitimate concurrent project change' WHERE id='keep'");
 }}),/f3_projektbestand_geaendert/);
 assert.deepEqual(await f.counts(),before);
 assert.equal((await f.pool.query("SELECT value FROM code_files WHERE id='keep'")).rows[0].value,'legitimate concurrent project change');
});
run('fresh post-COMMIT gate catches indirect same-count revision UPDATE',async t=>{
 const f=await fixture(t,{rows:2}),m=await f.make();
 await assert.rejects(applyManifest(f.pool,{...m,afterCommit:async()=>{
  await f.pool.query("UPDATE asset_revisionen SET sha256='external project change' WHERE asset_id=1");
 }}),e=>e.message==='f3_projektbestand_geaendert'&&e.committed_batches===1);
 assert.equal((await f.counts()).evidence,'1');
 await assert.rejects(applyManifest(f.pool,m),/f3_projektbestand_geaendert/);
});
run('all seven indirect sentinel routes detect same-count mutations',async t=>{
 const f=await fixture(t);
 for(const sql of [
  "UPDATE asset_revisionen SET sha256='changed'",
  "UPDATE asset_konflikte SET status='changed'",
  "UPDATE asset_retention_referenzen SET art='changed'",
  "UPDATE asset_manifest_eintraege SET metadaten='{\"changed\":true}'",
  "UPDATE asset_scan_checkpoints SET stand='{\"changed\":true}'",
  "UPDATE asset_upload_sitzungen SET sha256='changed'",
  "UPDATE asset_upload_teile SET sha256='changed'"
 ]){
  const before=await projectSentinel(f.pool);await f.pool.query(sql);
  assert.notDeepEqual(await projectSentinel(f.pool),before,sql);
 }
});
run('hash, source, parser generation and settings drift stop',async t=>{
 for(const [name,sql] of [
  ['symbol',"UPDATE reverse_code_symbole SET value='changed' WHERE id='a-00000'"],
  ['source',"UPDATE reverse_dateien SET sha256=repeat('b',64) WHERE id=1"],
  ['generation',"UPDATE reverse_code_dateien SET parser_generation_id='new' WHERE id='a'"],
  ['settings',"UPDATE reverse_einstellungen SET wert=3 WHERE name='e_uebernahme_block_zeilen'"]
 ]){
  await t.test(name,async t=>{
   const f=await fixture(t),m=await f.make();await f.pool.query(sql);
   await assert.rejects(applyManifest(f.pool,m),/^Error: f3_(symbol_geaendert|quelle_geaendert|einstellungen_geaendert)$/);
   assert.equal((await f.counts()).evidence,'0');
  });
 }
});
run('reviewed manifest hash and second-pass batch proof are mandatory',async t=>{
 const f=await fixture(t),m=await f.make();
 await assert.rejects(applyManifest(f.pool,{...m,expected:'0'.repeat(64)}),/f3_manifest_hash/);
 let pass=0;
 const lines=async function*(){
  pass++;for(const raw of m.records){
   if(pass>1&&JSON.parse(raw).kind==='symbol'){const x=JSON.parse(raw);x.hash='b'.repeat(64);yield canon(x)+'\n';}
   else yield raw;
  }
 };
 await assert.rejects(applyManifest(f.pool,{...m,lines}),/f3_manifest_batch_geaendert/);
 assert.equal((await f.counts()).evidence,'0');
});
run('journal schema must already exist; script never repairs/creates it',async t=>{
 const f=await fixture(t),m=await f.make();await f.pool.query('DROP TABLE reverse_f3_bereinigungs_batches');
 await assert.rejects(applyManifest(f.pool,m),/f3_schema145_fehlt/);
 assert.equal((await f.pool.query("SELECT to_regclass('reverse_f3_bereinigungs_batches') AS t")).rows[0].t,null);
});
run('an oversized single row cannot bypass byte budget or omit commit-evidence cost',async t=>{
 const f=await fixture(t);
 await f.pool.query("UPDATE reverse_code_symbole SET value=repeat('x',70000) WHERE id='a-00000'");
 const m=await f.make();
 await assert.rejects(applyManifest(f.pool,m),/f3_einzelzeile_ueber_budget/);
 const header=JSON.parse(m.records[0]);
 const op=JSON.parse(m.records[1]),cost=batchCost({...header,backup:m.backup},[op]);
 assert.equal(cost.rows,2);assert.ok(cost.bytes>65536);
 assert.equal((await f.counts()).evidence,'0');
});

run('schema145 mirror equals runtime constant; schema.ts follows additive runtime pattern',async()=>{
 const sql=await migration();
 const ts=await readFile(new URL('../../core/src/db/reverse-f3-bereinigung-schema.ts',import.meta.url),'utf8');
 const literal=ts.match(/export const REVERSE_F3_BEREINIGUNG_SCHEMA_SQL = (".*");/);
 assert.ok(literal);assert.equal(JSON.parse(literal[1]),sql);
 const entry=await readFile(new URL('../../core/src/db/schema.ts',import.meta.url),'utf8');
 assert.ok(entry.includes("import {REVERSE_F3_BEREINIGUNG_SCHEMA_SQL} from './reverse-f3-bereinigung-schema.js';"));
 assert.ok(entry.includes('${REVERSE_PIPELINE_SCHEMA_SQL}\n${REVERSE_F3_BEREINIGUNG_SCHEMA_SQL}'));
 assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS /g)||[]).length,1);
 assert.equal(/ALTER TABLE|CREATE INDEX|VALIDATE CONSTRAINT/.test(sql),false);
});

run('schema145 through regular ensureSchema twice, own test schema only',async t=>{
 const f=await fixture(t),sql=await migration();
 const {ensureSchema}=await import('../../core/dist/db/schema.js');
 const {mitLesePool}=await import('../../core/dist/db/client.js');
 for(let i=0;i<2;i++){
  const result=await mitLesePool(f.pool,()=>ensureSchema({sperrSchema:f.schema,koerper:sql}));
  assert.equal(result.probe,false);
 }
 const catalog=await f.pool.query("SELECT convalidated,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='reverse_f3_bereinigungs_batches'::regclass AND contype='f'");
 assert.deepEqual(catalog.rows,[{convalidated:true,def:'FOREIGN KEY (eintrag_id) REFERENCES reverse_eintraege(id) ON DELETE RESTRICT'}]);
 assert.equal((await f.pool.query('SELECT count(*)::text AS n FROM reverse_f3_bereinigungs_batches')).rows[0].n,'0');
});
run('normal exact delta; complete source records and own share bytes unchanged',async t=>{
 const f=await fixture(t),m=await f.make();
 const source=async()=>JSON.stringify((await f.pool.query('SELECT * FROM reverse_dateien ORDER BY id')).rows);
 const before=await source(),projects=await projectSentinel(f.pool);
 const root=await mkdtemp(join(tmpdir(),'f3-own-share-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const share=join(root,'original.bin'),bytes=Buffer.from('own source evidence');await writeFile(share,bytes);
 const result=await applyManifest(f.pool,m);assert.equal(result.status,'fertig');
 const delta=(await f.pool.query("SELECT sum((delta->>'files')::int)::text AS files,sum((delta->>'symbols')::int)::text AS symbols FROM reverse_f3_bereinigungs_batches")).rows[0];
 assert.deepEqual(delta,{files:'3',symbols:'3'});
 assert.equal(await source(),before);assert.deepEqual(await readFile(share),bytes);
 assert.deepEqual(await projectSentinel(f.pool),projects);
 const remaining=(await f.counts()).files.map(x=>x.id);
 assert.deepEqual(remaining,['d','e','e2','f','foreign','g','h']);
});
run('project COUNT changes mid-batch roll back Reverse and STOP',async t=>{
 const f=await fixture(t,{rows:2}),m=await f.make(),before=await f.counts();
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:async()=>{
  await f.pool.query("INSERT INTO code_files VALUES('external-new','project','legitimate concurrent insert')");
 }}),/f3_projektbestand_geaendert/);
 assert.deepEqual(await f.counts(),before);
 assert.equal((await f.pool.query('SELECT count(*)::text AS n FROM code_files')).rows[0].n,'2');
});

run('same-name foreign-schema CASCADE/SET NULL FK stops before any deletion',async t=>{
 for(const action of ['CASCADE','SET NULL'])await t.test(action,async t=>{
  const f=await fixture(t),m=await f.make(),foreign='f3_foreign_'+randomUUID().replaceAll('-','');
  await f.admin.query('CREATE SCHEMA "'+foreign+'"');
  f.extraSchemas.push(foreign);
  const child=action==='CASCADE'?'reverse_code_verweise':'reverse_code_kanten';
  const column=action==='CASCADE'?'symbol_id':'target_symbol_id';
  await f.pool.query('CREATE TABLE "'+foreign+'".'+child+'(id text PRIMARY KEY,'+column+' text REFERENCES "'+f.schema+'".reverse_code_symbole(id) ON DELETE '+action+')');
  await f.pool.query('INSERT INTO "'+foreign+'".'+child+" VALUES('foreign-ref','a-00000')");
  const before=await f.counts(),foreignRows=async()=>(await f.pool.query('SELECT * FROM "'+foreign+'".'+child+' ORDER BY id')).rows,previous=await foreignRows();
  await assert.rejects(applyManifest(f.pool,m),/f3_fk_unbekannt/);
  await assert.rejects(f.make(),/f3_fk_unbekannt/);
  assert.deepEqual(await f.counts(),before);assert.deepEqual(await foreignRows(),previous);
 });
});
