/**
 * P18-T97 F3/R1-R3. Coordinator TESTPHASE only; synapse_test:5433 only.
 * Own disposable schema/data, no container/share/production work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ENTRY,canon,sha,createManifest,applyManifest,verifyManifest,projectSentinel,validName,batchCost,failureDiagnostic,sentinelPolicy,encodeRecord,metadataRecords,manifestHeader,pruefeZwischenIntervall,openBatchConnection,transactionSnapshot,transactionGuard} from '../scripts/reverse-f3-bereinigen.mjs';
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
 await pool.query("CREATE TABLE work_jobs(id uuid,scope text,state text,attempt int,resource_unconfirmed boolean,lease_until timestamptz)");
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
   const f=await fixture(t),m=await f.make();
   if(kind==='parent')await f.pool.query("UPDATE reverse_code_symbole SET parent_symbol='a-00000' WHERE id='a-00001'");
   if(kind==='ref')await f.pool.query("INSERT INTO reverse_code_verweise VALUES('ref',$1,'source3@S1/strings.txt','a-00000')",[ENTRY]);
   if(kind==='edge')await f.pool.query("INSERT INTO reverse_code_kanten VALUES(1,$1,'source3@S1/strings.txt','a-00000')",[ENTRY]);
   const before=await f.counts();
   await assert.rejects(f.make(),/f3_abhaengigkeit_stop/);
   if(kind==='parent'){
    // Stale evidence MUST fail its row hash before reaching the dependency guard.
    await assert.rejects(applyManifest(f.pool,m),/f3_symbol_geaendert/);
    // Build an exact synthetic reviewed manifest for the post-change parent row,
    // solely to reach the internal-manifest dependency guard independently.
    const row=(await f.pool.query("SELECT to_jsonb(s)::text AS raw FROM reverse_code_symbole s WHERE id='a-00001'")).rows[0].raw;
    const records=m.records.map(raw=>{
     const x=JSON.parse(raw);
     if(x.kind==='symbol'&&x.id==='a-00001'){x.hash=sha(row);x.row_bytes=Buffer.byteLength(row);return canon(x)+'\n';}
     return raw;
    });
    m.expected=sha(records.join(''));m.lines=async function*(){yield* records;};
   }
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
 const result=await applyManifest(f.pool,m);
 assert.equal(result.status,'fertig');assert.equal(result.projektbilanz.start.diagnose.code,'f3_projekttabelle_unzugeordnet');
 assert.equal(result.projektbilanz.dryrun_zu_start.nicht_vergleichbar,true);
 // Dry-run still validates its complete immutable metadata before producing a manifest.
 await assert.rejects(f.make(),/f3_projekttabelle_unzugeordnet/);
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
run('parallel same-count project UPDATE is informational; own Reverse TX remains clean',async t=>{
 const f=await fixture(t),m=await f.make();
 const result=await applyManifest(f.pool,{...m,afterDelete:async()=>{
  await f.pool.query("UPDATE code_files SET value='legitimate concurrent project change' WHERE id='keep'");
 }});
 assert.equal(result.status,'fertig');assert.equal(result.projektschutz,'eigene_batch_transaktion');
 assert.equal(result.projektbilanz.informativ,true);
 assert.deepEqual(result.projektbilanz.start_zu_ende.tabellen.map(x=>x.tabelle),['code_files']);
 assert.equal(result.projektbilanz.start_zu_ende.tabellen[0].vorher,'1');
 assert.equal(result.projektbilanz.start_zu_ende.tabellen[0].nachher,'1');
 const state=await f.counts();assert.equal(state.evidence,'1');assert.equal(state.symbols.length,0);
 assert.deepEqual(state.files.map(x=>x.id),['d','e','e2','f','foreign','g','h']);
 assert.equal((await f.pool.query("SELECT value FROM code_files WHERE id='keep'")).rows[0].value,'legitimate concurrent project change');
});
run('changed project baseline after dry-run and indirect end changes never stop apply or resume',async t=>{
 const f=await fixture(t,{rows:2}),m=await f.make(),information=[];
 await f.pool.query("UPDATE code_files SET value='after dry-run' WHERE id='keep'");
 const result=await applyManifest(f.pool,{...m,onInformation:x=>information.push(x),afterCommit:async()=>{
  await f.pool.query("UPDATE asset_revisionen SET sha256='external project change' WHERE asset_id=1");
 }});
 assert.equal(result.status,'fertig');assert.equal(result.committed_batches,m.files+m.symbols);
 assert.deepEqual(result.projektbilanz.dryrun_zu_start.tabellen.map(x=>x.tabelle),['code_files']);
 assert.deepEqual(result.projektbilanz.start_zu_ende.tabellen.map(x=>x.tabelle),['asset_revisionen']);
 assert.deepEqual(information.map(x=>x.zeitpunkt),['start','ende']);
 assert.ok(information.every(x=>x.informativ===true&&!Object.hasOwn(x,'projects')));
 const resumed=await applyManifest(f.pool,m);
 assert.equal(resumed.status,'fertig');assert.equal(resumed.committed_batches,0);
 assert.equal(resumed.resumed_batches,result.committed_batches);
 assert.equal(resumed.projektbilanz.dryrun_zu_start.geaendert,true);
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
 await assert.rejects(f.make(),/f3_schema145_fehlt/);
 assert.equal((await f.pool.query("SELECT to_regclass(format('%I.reverse_f3_bereinigungs_batches',current_schema())) AS t")).rows[0].t,null);
});
run('an oversized single row cannot bypass byte budget or omit commit-evidence cost',async t=>{
 const f=await fixture(t);
 await f.pool.query("UPDATE reverse_code_symbole SET value=repeat('x',70000) WHERE id='a-00000'");
 const m=await f.make();
 await assert.rejects(applyManifest(f.pool,m),/f3_einzelzeile_ueber_budget/);
 const header=JSON.parse(m.records[0]);
 const op=m.records.map(JSON.parse).find(x=>x.kind==='symbol'),cost=batchCost({...header,backup:m.backup},[op]);
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
 const dependencies=async()=>JSON.stringify(await Promise.all(
  ['reverse_code_verweise','reverse_code_statements','reverse_code_kanten'].map(async table=>(await f.pool.query('SELECT * FROM '+table)).rows)));
 const before=await source(),projects=await projectSentinel(f.pool),dependencyBefore=await dependencies();
 const root=await mkdtemp(join(tmpdir(),'f3-own-share-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const share=join(root,'original.bin'),bytes=Buffer.from('own source evidence');await writeFile(share,bytes);
 const result=await applyManifest(f.pool,m);assert.equal(result.status,'fertig');
 const delta=(await f.pool.query("SELECT sum((delta->>'files')::int)::text AS files,sum((delta->>'symbols')::int)::text AS symbols FROM reverse_f3_bereinigungs_batches")).rows[0];
 assert.deepEqual(delta,{files:'3',symbols:'3'});
 assert.equal(await source(),before);assert.deepEqual(await readFile(share),bytes);
 assert.equal(await dependencies(),dependencyBefore); // FK lock permission never permits a child-row mutation.
 assert.deepEqual(await projectSentinel(f.pool),projects);
 const remaining=(await f.counts()).files.map(x=>x.id);
 assert.deepEqual(remaining,['d','e','e2','f','foreign','g','h']);
});
run('parallel project COUNT change mid-batch is reported without stopping',async t=>{
 const f=await fixture(t,{rows:2}),m=await f.make();let changed=false;
 const result=await applyManifest(f.pool,{...m,afterDelete:async()=>{
  if(changed)return;changed=true;
  await f.pool.query("INSERT INTO code_files VALUES('external-new','project','legitimate concurrent insert')");
 }});
 assert.equal(result.status,'fertig');assert.equal(result.committed_batches,m.files+m.symbols);
 const diff=result.projektbilanz.start_zu_ende.tabellen.find(x=>x.tabelle==='code_files');
 assert.equal(diff.vorher,'1');assert.equal(diff.nachher,'2');
 const state=await f.counts();assert.equal(state.evidence,String(m.files+m.symbols));assert.equal(state.symbols.length,0);
 assert.deepEqual(state.files.map(x=>x.id),['d','e','e2','f','foreign','g','h']);
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

/** Both the read-lock session and every dedicated batch use the same test-only
 * query interceptor. Fresh batch clients are real pg.Client, never pool checkout.
 */
function mappedPool(pool,map){
 const wrap=c=>({query:(q,...args)=>map(c,q,args),
  ...(c.release?{release:(...args)=>c.release(...args)}:{}),
  ...(c.end?{end:()=>c.end()}:{})});
 return {options:pool.options,connect:async()=>wrap(await pool.connect()),
  connectFresh:async()=>wrap(await openBatchConnection(pool.options))};
}
function injectedPool(pool,inject){
 return mappedPool(pool,async(c,q,args)=>{
  const text=typeof q==='string'?q:q.text,failure=inject(text);
  if(failure){if(text==='ROLLBACK')await c.query(q,...args);throw failure;}
  return c.query(q,...args);
 });
}
run('simulated PG statement timeout exposes phase/SQLSTATE only; first cause survives rollback error',async t=>{
 const f=await fixture(t),before=await f.counts(),records=[];
 const secret='postgres://private:password@internal/private?payload=secret';
 const pool=injectedPool(f.pool,text=>{
  if(text.includes('string_agg(h')&&text.includes('code_files'))return Object.assign(Error(secret),{code:'57014',detail:secret,query:secret});
  if(text==='ROLLBACK')return Object.assign(Error(secret),{code:'25P02'});
 });
 await assert.rejects(createManifest(pool,raw=>records.push(raw)),e=>{
  const d=failureDiagnostic(e);
  assert.deepEqual(d,{status:'gestoppt',code:'f3_werkzeug_fehler',phase:'sentinel_hash',tabelle:'code_files',pg_code:'57014',committed_batches:0,resumed_batches:0});
  assert.equal(JSON.stringify(d).includes(secret),false);return true;
 });
 assert.deepEqual(records,[]);assert.deepEqual(await f.counts(),before);
});
run('FK PG failure diagnostic is safe; dry-run writes zero',async t=>{
 const f=await fixture(t),before=await f.counts();
 const pool=injectedPool(f.pool,text=>text.includes('FROM pg_constraint k')?Object.assign(Error('secret sql detail /private/file'),{code:'42501'}):null);
 await assert.rejects(createManifest(pool,()=>assert.fail('no header before guards')),e=>{
  const d=failureDiagnostic(e);assert.equal(d.phase,'fk_katalog');assert.equal(d.pg_code,'42501');
  assert.equal(JSON.stringify(d).includes('secret'),false);return true;
 });
 assert.deepEqual(await f.counts(),before);
});
run('filesystem failure uses errno allowlist without path/message disclosure',async t=>{
 const f=await fixture(t),before=await f.counts();
 await assert.rejects(createManifest(f.pool,()=>{throw Object.assign(Error('/secret/private-file'),{code:'EACCES'});}),e=>{
  const d=failureDiagnostic(e);assert.equal(d.phase,'manifest_header');assert.equal(d.fs_code,'EACCES');
  assert.equal(d.pg_code,undefined);assert.equal(JSON.stringify(d).includes('/secret'),false);return true;
 });
 assert.deepEqual(await f.counts(),before);
});
run('explicit bounded sentinel timeout is pinned in manifest and every batch journal',async t=>{
 const f=await fixture(t),records=[],result=await createManifest(f.pool,raw=>records.push(raw),{sentinelTimeoutMs:1000});
 const h=JSON.parse(records[0]);assert.equal(h.version,4);
 assert.deepEqual(h.sentinel,{timeout_ms:1000,quelle:'cli'});assert.deepEqual(result.sentinel,h.sentinel);
 const lines=async function*(){yield* records;};
 await applyManifest(f.pool,{lines,expected:result.sha256,backup:'own-backup-proof'});
 const rows=(await f.pool.query("SELECT delta->'sentinel' AS policy FROM reverse_f3_bereinigungs_batches")).rows;
 assert.ok(rows.length>0);for(const row of rows)assert.deepEqual(row.policy,h.sentinel);
 assert.throws(()=>sentinelPolicy(h.settings,0),/f3_sentinel_budget/);
 assert.throws(()=>sentinelPolicy(h.settings,Number.MAX_SAFE_INTEGER),/f3_sentinel_budget/);
});

run('terminal P20 historical markers without live resource are quiet and listed; P20 unchanged',async t=>{
 for(const state of ['completed','failed','cancelled','expired'])await t.test(state,async t=>{
  const f=await fixture(t),id=randomUUID();
  await f.pool.query("INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) VALUES($1,'reverse',$2,2,true)",[id,state]);
  const p20=async()=>(await f.pool.query('SELECT * FROM work_jobs ORDER BY id')).rows;
  const before=await p20(),m=await f.make(),{header:h}=await verifyManifest(m.lines,m.expected,m.backup);
  assert.deepEqual(h.hinweise,[{code:'f3_terminaler_altmarker',job_id:id,state,attempt:2}]);
  assert.deepEqual(await p20(),before);assert.equal(m.hinweise_anzahl,h.hinweise.length);
  assert.equal((await applyManifest(f.pool,m)).status,'fertig');
  assert.deepEqual(await p20(),before);assert.equal((await p20())[0].resource_unconfirmed,true);
 });
});
run('terminal marker with UNKNOWN run, even an older attempt, stops dry-run and apply',async t=>{
 const f=await fixture(t),id=randomUUID();
 await f.pool.query("INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) VALUES($1,'reverse','failed',2,true)",[id]);
 const m=await f.make(),before=await f.counts();
 await f.pool.query("INSERT INTO tool_container_runs VALUES($1,1,'unknown')",[id]);
 const runs=(await f.pool.query('SELECT * FROM tool_container_runs')).rows;
 await assert.rejects(f.make(),/f3_nicht_ruhig/);
 await assert.rejects(applyManifest(f.pool,m),/f3_nicht_ruhig/);
 assert.deepEqual(await f.counts(),before);
 assert.deepEqual((await f.pool.query('SELECT * FROM tool_container_runs')).rows,runs);
 assert.equal((await f.pool.query('SELECT resource_unconfirmed FROM work_jobs')).rows[0].resource_unconfirmed,true);
});
run('quiet guard still rejects every non-terminal job, active run, lease, local work or halt OFF',async t=>{
 const cases=[
  ["INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) VALUES($1,'reverse','pending',0,false)",'f3_nicht_ruhig'],
  ["INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) VALUES($1,'reverse','leased',1,false)",'f3_nicht_ruhig'],
  ["INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) VALUES($1,'reverse','staged',1,false)",'f3_nicht_ruhig'],
  ["INSERT INTO work_jobs VALUES($1,'reverse','completed',2,false,clock_timestamp()+interval '1 minute')",'f3_nicht_ruhig'],
  ["INSERT INTO reverse_auftraege VALUES('wartet',NULL)",'f3_nicht_ruhig'],
  ["INSERT INTO reverse_auftraege VALUES('fertig',clock_timestamp()+interval '1 minute')",'f3_nicht_ruhig'],
  ["UPDATE agent_profil_schalter SET aktiv=false",'f3_halt_erforderlich']
 ];
 for(let i=0;i<cases.length;i++)await t.test(String(i),async t=>{
  const f=await fixture(t),[sql,code]=cases[i],id=randomUUID();
  await f.pool.query(sql,sql.includes('$1')?[id]:[]);
  await assert.rejects(f.make(),new RegExp(code));assert.equal((await f.counts()).evidence,'0');
 });
 await t.test('running run blocks even without marker',async t=>{
  const f=await fixture(t),id=randomUUID();
  await f.pool.query("INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) VALUES($1,'reverse','completed',2,false)",[id]);
  await f.pool.query("INSERT INTO tool_container_runs VALUES($1,2,'running')",[id]);
  await assert.rejects(f.make(),/f3_nicht_ruhig/);assert.equal((await f.counts()).evidence,'0');
 });
});

run('production-scale sentinels across all 27 project tables: thin header, bounded records, exact reconstruction',async t=>{
 const f=await fixture(t);
 const extra=['asset_aenderungen','asset_aenderungsstaende','asset_host_checkpoints','asset_inspektions_auftraege','asset_inspektions_projekte','asset_konflikt_eingaenge','asset_konflikt_loesungen','asset_mutationen','asset_projekt_optionen'];
 for(const table of extra)await f.pool.query('CREATE TABLE '+table+'(id text PRIMARY KEY,project text,value text)');
 const direct=['asset_objects','asset_references','code_files','code_symbols','code_references','code_statements','code_call_edges','code_chunks','file_versions',...extra];
 const ids=Array.from({length:512},(_,i)=>'project-'+String(i).padStart(5,'0'));
 for(const table of direct)await f.pool.query('INSERT INTO '+table+' SELECT x,x,$2 FROM unnest($1::text[]) x',[ids,'own production-scale sentinel fixture']);
 const expected=await projectSentinel(f.pool),before=await f.counts(),m=await f.make();
 assert.equal(Object.keys(expected).length,27);
 const wire=JSON.parse(m.records[0]),limit=wire.settings.recordBytes;
 assert.ok(Buffer.byteLength(canon(expected))>limit);
 assert.equal(Object.hasOwn(wire,'projects'),false);assert.equal(Object.hasOwn(wire,'hinweise'),false);
 assert.ok(Buffer.byteLength(m.records[0])<limit);
 assert.equal(wire.metadaten.project_tables,27);assert.ok(wire.metadaten.project_owners>=18*512);
 for(const raw of m.records)assert.ok(Buffer.byteLength(raw)<=limit);
 assert.deepEqual(await f.counts(),before);
 const {header,operations}=await verifyManifest(m.lines,m.expected,m.backup);
 assert.deepEqual(JSON.parse(canon(header.projects)),expected);assert.equal(operations,6);
 assert.equal((await applyManifest(f.pool,m)).status,'fertig');
 assert.deepEqual(await projectSentinel(f.pool),expected);
});
run('thousands of terminal hints are individual budgeted records, not one oversized header',async t=>{
 const f=await fixture(t),ids=Array.from({length:2000},()=>randomUUID());
 await f.pool.query("INSERT INTO work_jobs(id,scope,state,attempt,resource_unconfirmed) SELECT x,'reverse','failed',1,true FROM unnest($1::uuid[]) x",[ids]);
 const before=(await f.pool.query('SELECT * FROM work_jobs ORDER BY id')).rows,m=await f.make();
 const wire=JSON.parse(m.records[0]),{header}=await verifyManifest(m.lines,m.expected,m.backup);
 assert.equal(wire.metadaten.hinweise,ids.length);assert.equal(header.hinweise.length,ids.length);
 assert.ok(Buffer.byteLength(canon(header.hinweise))>wire.settings.recordBytes);
 assert.equal(m.records.map(JSON.parse).filter(x=>x.kind==='hinweis').length,ids.length);
 for(const raw of m.records)assert.ok(Buffer.byteLength(raw)<=wire.settings.recordBytes);
 assert.deepEqual((await f.pool.query('SELECT * FROM work_jobs ORDER BY id')).rows,before);
});
run('changed, missing, duplicated or second-pass metadata cannot reach DELETE',async t=>{
 const f=await fixture(t),m=await f.make(),before=await f.counts();
 const index=m.records.findIndex(raw=>JSON.parse(raw).kind==='project_owner');assert.ok(index>0);
 for(const kind of ['change','remove','duplicate']){
  let rows=[...m.records];
  if(kind==='change'){const x=JSON.parse(rows[index]);x.n=String(BigInt(x.n)+1n);rows[index]=canon(x)+'\n';}
  if(kind==='remove')rows.splice(index,1);
  if(kind==='duplicate')rows.splice(index,0,rows[index]);
  const lines=async function*(){yield* rows;};
  await assert.rejects(applyManifest(f.pool,{...m,lines,expected:sha(rows.join(''))}),/f3_manifest_metadaten/);
  assert.deepEqual(await f.counts(),before);
 }
 let pass=0;
 const lines=async function*(){
  pass++;for(let i=0;i<m.records.length;i++){
   if(pass>1&&i===index){const x=JSON.parse(m.records[i]);x.n='999';yield canon(x)+'\n';}
   else yield m.records[i];
  }
 };
 await assert.rejects(applyManifest(f.pool,{...m,lines}),/f3_manifest_metadaten/);
 assert.deepEqual(await f.counts(),before);
});
run('overlong candidate or metadata record is rejected BEFORE the first output record',async t=>{
 const f=await fixture(t),records=[];
 await f.add('long',2,'strings-0004.txt');
 await f.pool.query("UPDATE reverse_code_dateien SET file_path=$1 WHERE id='long'",['x'.repeat(65536)+'/strings-0004.txt']);
 const before=await f.counts();
 await assert.rejects(createManifest(f.pool,raw=>records.push(raw)),/f3_manifest_record_zu_gross/);
 assert.deepEqual(records,[]);assert.deepEqual(await f.counts(),before);
 assert.throws(()=>encodeRecord({kind:'project_owner',table:'code_files',owner:'x'.repeat(65536),n:'1',sha256:'a'.repeat(64)},65536),/f3_manifest_record_zu_gross/);
});
run('18966 file contexts / 714611 symbols never inflate one record or batch evidence',async()=>{
 const limit=65536,settings={revision:'a'.repeat(64),rows:5000,maxBytes:4194304,recordBytes:limit,statement:10000,lock:2000};
 const h=manifestHeader(settings,sentinelPolicy(settings),{},[],'e'.repeat(64));
 // Deliberately conservative escaping and numeric widths, greater than current RO maxima.
 const file={id:'\u0001'.repeat(64),path:'\u0001'.repeat(149)+'/strings.txt',name:'strings.txt',source_id:'99999',
  source_sha:'a'.repeat(64),source_hash:'b'.repeat(64),code_hash:'c'.repeat(64),row_bytes:Number.MAX_SAFE_INTEGER};
 const symbol={kind:'symbol',id:'\u0001'.repeat(256),file,hash:'d'.repeat(64),row_bytes:Number.MAX_SAFE_INTEGER};
 const bytes=Buffer.byteLength(encodeRecord(symbol,limit));
 assert.ok(bytes<4096);assert.equal(Buffer.byteLength(encodeRecord(symbol,limit)),bytes);
 assert.ok(18966*bytes>limit);assert.ok(714611*bytes>limit);
 assert.equal(h.metadaten.project_owners,0);assert.ok(Buffer.byteLength(encodeRecord(h,limit))<limit);
 assert.deepEqual([...metadataRecords({},[])],[]);
});

run('default performs EXACTLY TWO full project sentinel passes across many batches',async t=>{
 const f=await fixture(t,{rows:2,symbols:12}),m=await f.make();let full=0;
 const pool=injectedPool(f.pool,text=>{if(text==="SELECT current_setting('statement_timeout') AS v")full++;return null;});
 const result=await applyManifest(pool,m);
 assert.ok(result.committed_batches>2);assert.equal(full,2);
 assert.deepEqual(result.pruefungen,{vollsentinel_alle_batches:0,regulaere_vollpruefungen:2});
 const journal=(await f.pool.query("SELECT delta->'pruefungen' AS controls,delta->>'katalog_sha256' AS pin FROM reverse_f3_bereinigungs_batches")).rows;
 const h=JSON.parse(m.records[0]);assert.match(h.katalog_sha256,/^[a-f0-9]{64}$/);
 for(const row of journal){assert.deepEqual(row.controls,{vollsentinel_alle_batches:0});assert.equal(row.pin,h.katalog_sha256);}
});
run('OID catalog changed between batches stops BEFORE next deletion',async t=>{
 const f=await fixture(t,{rows:2}),m=await f.make();let changed=false;
 await assert.rejects(applyManifest(f.pool,{...m,afterCommit:async()=>{
  if(changed)return;changed=true;
  const row=(await f.pool.query("SELECT conname FROM pg_constraint WHERE conrelid='reverse_code_verweise'::regclass AND confrelid='reverse_code_symbole'::regclass")).rows[0];
  const name='"'+row.conname.replaceAll('"','""')+'"';
  await f.pool.query('ALTER TABLE reverse_code_verweise DROP CONSTRAINT '+name);
  await f.pool.query('ALTER TABLE reverse_code_verweise ADD CONSTRAINT '+name+' FOREIGN KEY(symbol_id) REFERENCES reverse_code_symbole(id) ON DELETE CASCADE');
 }}),e=>e.message==='f3_katalog_geaendert'&&e.committed_batches===1);
 const after=await f.counts();assert.equal(after.evidence,'1');
 assert.deepEqual(after.symbols.map(x=>x.id),['a-00001','a-00002']);
 assert.deepEqual(after.files.map(x=>x.id),['a','b','c','d','e','e2','f','foreign','g','h']);
});
run('DELETE RETURNING deviation rolls back exact deletion AND evidence, then STOP',async t=>{
 const f=await fixture(t),m=await f.make(),before=await f.counts();
 const pool=mappedPool(f.pool,async(c,q,args)=>{
  const result=await c.query(q,...args),text=typeof q==='string'?q:q.text;
  return text.startsWith('DELETE FROM reverse_code_symbole ')?{...result,rows:[]}:result;
 });
 await assert.rejects(applyManifest(pool,m),/f3_loeschmenge_geaendert/);
 assert.deepEqual(await f.counts(),before);
});
run('optional full-sentinel interval is bounded, counted and pinned in journal resume',async t=>{
 const f=await fixture(t,{rows:2,symbols:6}),m=await f.make();let full=0;
 const pool=injectedPool(f.pool,text=>{if(text==="SELECT current_setting('statement_timeout') AS v")full++;return null;});
 const result=await applyManifest(pool,{...m,zwischenSentinelBatches:2});
 assert.equal(full,2+Math.floor((result.committed_batches-1)/2));
 assert.equal(result.pruefungen.vollsentinel_alle_batches,2);
 const controls=(await f.pool.query("SELECT DISTINCT delta->'pruefungen' AS p FROM reverse_f3_bereinigungs_batches")).rows;
 assert.deepEqual(controls,[{p:{vollsentinel_alle_batches:2}}]);
 await assert.rejects(applyManifest(f.pool,{...m,zwischenSentinelBatches:0}),/f3_journal_konflikt/);
 assert.throws(()=>pruefeZwischenIntervall(-1,9),/f3_zwischen_budget/);
 assert.throws(()=>pruefeZwischenIntervall(10,9),/f3_zwischen_budget/);
});

run('own TX project insert/update/delete are rolled back together with DELETE and journal',async t=>{
 for(const sql of [
  "INSERT INTO code_files VALUES('hidden','project','own forbidden write')",
  "UPDATE code_files SET value='hidden' WHERE id='keep'",
  "DELETE FROM code_files WHERE id='keep'"
 ])await t.test(sql.split(' ')[0],async t=>{
  const f=await fixture(t),m=await f.make(),before=await f.counts(),projects=await projectSentinel(f.pool);
  await assert.rejects(applyManifest(f.pool,{...m,afterDelete:({db})=>db.query(sql)}),
   e=>e.message==='f3_tx_fremdmutation'&&e.committed_batches===0&&failureDiagnostic(e).phase==='tx_schutz');
  assert.deepEqual(await f.counts(),before);assert.deepEqual(await projectSentinel(f.pool),projects);
 });
});
run('hidden project mutation through a test trigger in own TX is rolled back',async t=>{
 const f=await fixture(t);
 // Source-side trigger is outside the two DELETE targets. It hides a nested
 // project write from DELETE/RETURNING; the independent xact-stat gate sees it.
 await f.pool.query("CREATE FUNCTION hidden_project_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE code_files SET value='trigger mutation' WHERE id='keep'; RETURN NEW; END $$");
 await f.pool.query("CREATE TRIGGER hidden_project_write AFTER UPDATE ON reverse_dateien FOR EACH ROW EXECUTE FUNCTION hidden_project_write()");
 const m=await f.make(),before=await f.counts(),projects=await projectSentinel(f.pool);
 const sources=(await f.pool.query('SELECT * FROM reverse_dateien ORDER BY id')).rows;
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:({db})=>db.query("UPDATE reverse_dateien SET pfad=pfad WHERE id=1")}),/f3_tx_fremdmutation/);
 assert.deepEqual(await f.counts(),before);assert.deepEqual(await projectSentinel(f.pool),projects);
 assert.deepEqual((await f.pool.query('SELECT * FROM reverse_dateien ORDER BY id')).rows,sources);
});
run('TX guard checks ALL schemas by exact relation OIDs, including a foreign-schema project table',async t=>{
 const f=await fixture(t),other='foreign_'+randomUUID().replaceAll('-','');f.extraSchemas.push(other);
 await f.admin.query('CREATE SCHEMA "'+other+'"');
 await f.admin.query('CREATE TABLE "'+other+'".code_files(id text PRIMARY KEY)');
 const m=await f.make(),before=await f.counts();
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:({db})=>db.query('INSERT INTO "'+other+'".code_files VALUES(\'hidden\')')}),/f3_tx_fremdmutation/);
 assert.deepEqual(await f.counts(),before);
 assert.equal((await f.admin.query('SELECT count(*)::text AS n FROM "'+other+'".code_files')).rows[0].n,'0');
});
run('TX DELTA requires exact deletes/journal; missing, negative/reset counters and query failures stop',async t=>{
 for(const kind of ['delete','journal','missing','negative','query_failure'])await t.test(kind,async t=>{
  const f=await fixture(t),m=await f.make(),before=await f.counts(),reads=new WeakMap();
  const pool=mappedPool(f.pool,async(c,q,args)=>{
   const text=typeof q==='string'?q:q.text;
   if(text.includes('FROM pg_catalog.pg_stat_xact_all_tables')){
    const count=(reads.get(c)??0)+1;reads.set(c,count);
    if(count>1&&kind==='query_failure')throw Object.assign(Error('not exposed'),{code:'42501'});
    const result=await c.query(q,...args);
    const name=kind==='journal'?'reverse_f3_bereinigungs_batches':'reverse_code_symbole';
    const oid=(await c.query('SELECT $1::regclass::oid::text AS oid',[name])).rows[0].oid;
    if(count===1)return kind==='negative'?{...result,rows:result.rows.map(r=>r.oid!==oid?r:{...r,del:'1000000000'})}:result;
    if(kind==='missing')return {...result,rows:result.rows.filter(r=>r.oid!==oid)};
    return {...result,rows:result.rows.map(r=>r.oid!==oid?r:{...r,...(kind==='delete'?{del:String(BigInt(r.del)+1n)}:kind==='journal'?{ins:'0'}:{})})};
   }
   return c.query(q,...args);
  });
  await assert.rejects(applyManifest(pool,m),e=>kind==='query_failure'
   ?failureDiagnostic(e).pg_code==='42501'&&failureDiagnostic(e).phase==='tx_schutz'
   :e.message==='f3_tx_delta_abweichung');
  assert.deepEqual(await f.counts(),before);
 });
});
run('deferred trigger writes are forced BEFORE the final xact-stat check',async t=>{
 const f=await fixture(t);
 await f.pool.query("CREATE FUNCTION deferred_project_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE code_files SET value='deferred mutation' WHERE id='keep'; RETURN NEW; END $$");
 await f.pool.query("CREATE CONSTRAINT TRIGGER deferred_project_write AFTER UPDATE ON reverse_dateien DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deferred_project_write()");
 const m=await f.make(),before=await f.counts(),projects=await projectSentinel(f.pool);
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:({db})=>db.query("UPDATE reverse_dateien SET pfad=pfad WHERE id=1")}),/f3_tx_fremdmutation/);
 assert.deepEqual(await f.counts(),before);assert.deepEqual(await projectSentinel(f.pool),projects);
});

run('informational sentinel timeout never masks a later hard TX violation',async t=>{
 const f=await fixture(t),m=await f.make(),before=await f.counts();
 const pool=injectedPool(f.pool,text=>text==="SELECT current_setting('statement_timeout') AS v"
  ?Object.assign(Error('not exposed'),{code:'57014'}):null);
 // injectedPool throws its Error result; outer mutation diagnostics must stay independent.
 await assert.rejects(applyManifest(pool,{...m,afterDelete:({db})=>db.query("UPDATE code_files SET value='own forbidden mutation'")}),
  e=>e.message==='f3_tx_fremdmutation'&&failureDiagnostic(e).phase==='tx_schutz'&&failureDiagnostic(e).pg_code===undefined);
 assert.deepEqual(await f.counts(),before);
});

run('unavailable informational full sentinel is reported, not a mutation gate',async t=>{
 const f=await fixture(t),m=await f.make(),information=[];
 const pool=injectedPool(f.pool,text=>text==="SELECT current_setting('statement_timeout') AS v"
  ?Object.assign(Error('private payload is never reported'),{code:'57014'}):null);
 const result=await applyManifest(pool,{...m,onInformation:x=>information.push(x)});
 assert.equal(result.status,'fertig');assert.equal(result.projektbilanz.start_zu_ende.nicht_vergleichbar,true);
 assert.equal(result.projektbilanz.start.diagnose.pg_code,'57014');
 assert.equal(result.projektbilanz.ende.diagnose.pg_code,'57014');
 assert.deepEqual(information.map(x=>x.zeitpunkt),['start','ende']);
 assert.equal(JSON.stringify(result).includes('private payload'),false);
 assert.equal((await f.counts()).symbols.length,0);
});

run('multiple apply batches, rollback retry and resume each open/end a distinct dedicated backend',async t=>{
 const f=await fixture(t,{rows:2,symbols:8}),m=await f.make(),pids=[],ended=[];
 const pool={options:f.pool.options,connect:()=>f.pool.connect(),connectFresh:async()=>{
  const c=await openBatchConnection(f.pool.options);
  const pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;pids.push(pid);
  return {query:(...args)=>c.query(...args),end:async()=>{await c.end();ended.push(pid);}};
 }};
 const before=await f.counts();
 await assert.rejects(applyManifest(pool,{...m,afterDelete:()=>{throw Error('rollback probe');}}),/rollback probe/);
 assert.deepEqual(await f.counts(),before);
 await assert.rejects(applyManifest(pool,{...m,afterCommit:()=>{throw Error('lost ACK');}}),/lost ACK/);
 const result=await applyManifest(pool,m);assert.equal(result.status,'fertig');assert.equal(result.resumed_batches,1);
 assert.equal((await applyManifest(pool,m)).committed_batches,0);
 assert.ok(pids.length>10);assert.equal(new Set(pids).size,pids.length);
 assert.deepEqual(ended,pids);assert.equal((await f.counts()).symbols.length,0);
});
run('real guard DELTA remains correct across COMMIT/ROLLBACK/retry on the SAME backend',async t=>{
 const f=await fixture(t),c=await openBatchConnection(f.pool.options);
 try{
 // Prior committed work may still be in the backend's pending counters.
 await c.query("UPDATE code_files SET value='historical committed write'");
 const perform=async(id,batch,commit)=>{
  await c.query('BEGIN');
  const baseline=await transactionSnapshot(c);
  await c.query('DELETE FROM reverse_code_symbole WHERE id=$1',[id]);
  await c.query("INSERT INTO reverse_f3_bereinigungs_batches(eintrag_id,manifest_sha256,batch_nr,batch_sha256,ops,delta,backup_beleg,projekt_sentinel_sha256,einstellungen_revision) VALUES($1,$2,$3,$2,'[]','{}','own-backup',$2,$2)",[ENTRY,'d'.repeat(64),batch]);
  await transactionGuard(c,[{kind:'symbol'}],baseline);
  await c.query(commit?'COMMIT':'ROLLBACK');
 };
 await perform('a-00000',0,true);await perform('a-00001',1,true);
 await perform('a-00002',2,false);
 assert.equal((await f.counts()).evidence,'2');assert.equal((await f.counts()).symbols.length,1);
 await perform('a-00002',2,true);
 assert.equal((await f.counts()).evidence,'3');assert.equal((await f.counts()).symbols.length,0);
 assert.equal((await f.pool.query("SELECT value FROM code_files WHERE id='keep'")).rows[0].value,'historical committed write');
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
});
run('hidden TRUNCATE/DDL functions roll back before COMMIT; project data and journal survive',async t=>{
 for(const command of ['TRUNCATE code_files','CREATE TABLE hidden_ddl(id text)'])await t.test(command,async t=>{
  const f=await fixture(t);
  await f.pool.query("CREATE FUNCTION hidden_sql() RETURNS void LANGUAGE plpgsql AS $$ BEGIN "+command+"; END $$");
  const m=await f.make(),before=await f.counts(),projects=await projectSentinel(f.pool);
  await assert.rejects(applyManifest(f.pool,{...m,afterDelete:({db})=>db.query('SELECT hidden_sql()')}),
   e=>['f3_tx_fremdmutation','f3_tx_lock_unerlaubt','f3_tx_delta_abweichung'].includes(e.message)&&e.committed_batches===0);
  assert.deepEqual(await f.counts(),before);assert.deepEqual(await projectSentinel(f.pool),projects);
  assert.equal((await f.pool.query("SELECT to_regclass(format('%I.hidden_ddl',current_schema())) AS t")).rows[0].t,null);
 });
});
run('writing project lock alone is forbidden even when every tuple delta is zero',async t=>{
 const f=await fixture(t),m=await f.make(),before=await f.counts();
 await assert.rejects(applyManifest(f.pool,{...m,afterDelete:({db})=>db.query('LOCK TABLE code_files IN SHARE MODE')}),
  e=>{
   const d=failureDiagnostic(e);
   assert.equal(e.message,'f3_tx_lock_unerlaubt');assert.equal(d.phase,'tx_locks');
   assert.equal(d.lock.relname,'code_files');assert.equal(d.lock.schema,f.schema);
   assert.match(d.lock.oid,/^[0-9]+$/);assert.equal(d.lock.relkind,'r');assert.equal(d.lock.lockmode,'ShareLock');
   assert.deepEqual(d.lock.erwartet,{ziel:false,closure:false,journal:false,index:false,toast:false});
   return true;
  });
 assert.deepEqual(await f.counts(),before);
});
run('AccessShare/RowShare project locks are permitted without project mutation',async t=>{
 const f=await fixture(t),m=await f.make();
 const result=await applyManifest(f.pool,{...m,afterDelete:({db})=>db.query("SELECT * FROM code_files WHERE id='keep' FOR UPDATE")});
 assert.equal(result.status,'fertig');assert.equal(result.projektbilanz.start_zu_ende.geaendert,false);
});
run('only exact target-parent TOAST writes are permitted; foreign TOAST writes stop',async t=>{
 const f=await fixture(t),value=randomBytes(6000).toString('hex');
 await f.pool.query("UPDATE reverse_code_symbole SET value=$1 WHERE id='a-00000'",[value]);
 await f.pool.query("UPDATE reverse_code_dateien SET content=$1 WHERE id='a'",[value]);
 assert.ok((await f.pool.query("SELECT pg_column_size(value) AS n FROM reverse_code_symbole WHERE id='a-00000'")).rows[0].n>2000);
 const m=await f.make();assert.equal((await applyManifest(f.pool,m)).status,'fertig');
 assert.equal((await f.counts()).symbols.length,0);
 const g=await fixture(t),n=await g.make(),before=await g.counts();
 await assert.rejects(applyManifest(g.pool,{...n,afterDelete:({db})=>db.query("UPDATE code_files SET value=$1 WHERE id='keep'",[value])}),/f3_tx_fremdmutation/);
 assert.deepEqual(await g.counts(),before);
 assert.equal((await g.pool.query("SELECT value FROM code_files WHERE id='keep'")).rows[0].value,'unchanged');
});
run('unreviewed rule, RLS policy/flag and non-system journal trigger stop before mutation',async t=>{
 const cases=[
  ["CREATE RULE hidden_rule AS ON DELETE TO reverse_code_symbole DO INSTEAD NOTHING",'f3_regel_unbekannt'],
  ["CREATE POLICY hidden_policy ON reverse_code_dateien USING (true)",'f3_rls_unbekannt'],
  ["ALTER TABLE reverse_code_dateien ENABLE ROW LEVEL SECURITY",'f3_rls_unbekannt'],
  ["CREATE RULE hidden_journal AS ON INSERT TO reverse_f3_bereinigungs_batches DO INSTEAD NOTHING",'f3_regel_unbekannt'],
  ["CREATE FUNCTION hidden_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER hidden_trigger BEFORE INSERT ON reverse_f3_bereinigungs_batches FOR EACH ROW EXECUTE FUNCTION hidden_trigger()",'f3_journal_nebenwirkung']
 ];
 for(let i=0;i<cases.length;i++)await t.test(String(i),async t=>{
  const f=await fixture(t),m=await f.make(),before=await f.counts(),[sql,code]=cases[i];
  await f.pool.query(sql);
  await assert.rejects(applyManifest(f.pool,m),new RegExp(code));
  assert.deepEqual(await f.counts(),before);
 });
});

run('journal TOAST chunks are allowed only via its exact parent OID',async t=>{
 const f=await fixture(t),c=await openBatchConnection(f.pool.options);
 try{
 await c.query('BEGIN');const baseline=await transactionSnapshot(c);
 const payload=JSON.stringify([{own_fixture:randomBytes(12000).toString('hex')}]);
 await c.query("INSERT INTO reverse_f3_bereinigungs_batches(eintrag_id,manifest_sha256,batch_nr,batch_sha256,ops,delta,backup_beleg,projekt_sentinel_sha256,einstellungen_revision) VALUES($1,$2,0,$2,$3,'{}','own-backup',$2,$2)",[ENTRY,'c'.repeat(64),payload]);
 assert.ok((await c.query('SELECT pg_column_size(ops) AS n FROM reverse_f3_bereinigungs_batches')).rows[0].n>2000);
 await transactionGuard(c,[],baseline);await c.query('COMMIT');
 assert.equal((await f.counts()).evidence,'1');
 }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
});
