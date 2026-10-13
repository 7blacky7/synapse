/** P18-T13/RV3: synthetic fixtures only, isolated schema in synapse_test. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { testDbOderSkip } from '../../../scripts/lib/test-db-schutz.mjs';
const url = testDbOderSkip('P18-RV3');
assert.ok(url, 'Test-DSN erforderlich, kein stilles Skip');
assert.equal(new URL(url).pathname, '/synapse_test');
const pg = createRequire(import.meta.url)('pg');
const admin = new pg.Client({ connectionString: url });
await admin.connect();
assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'synapse_test');
const schema = 'p18_rv3_' + process.pid;
const fullSchema = schema + '_full';
const moduleUrl = new URL('../dist/db/reverse-schema.js', import.meta.url);
const sqlUrl = new URL('../src/db/schema-sql/97_reverse.sql', import.meta.url);
const originals = ['code_files','code_symbols','code_references','code_call_edges','code_statements','asset_objects','asset_references'];
let pool;
try {
  assert.ok(existsSync(sqlUrl), 'RV3 SQL fehlt am Altstand');
  const sql = readFileSync(sqlUrl, 'utf8');
  const { REVERSE_SCHEMA_SQL } = await import(moduleUrl);
  assert.equal(REVERSE_SCHEMA_SQL.trim(), sql.trim(), 'SQL-Spiegel exakt');
  await admin.query('CREATE SCHEMA ' + schema);
  await admin.query('CREATE SCHEMA ' + fullSchema);
  const scoped = new URL(url);
  scoped.searchParams.set('options', '-c search_path=' + schema + ',public');
  pool = new pg.Pool({ connectionString: scoped.toString() });
  await pool.query(readFileSync(new URL('../src/db/schema-sql/95_asset_intel.sql', import.meta.url), 'utf8'));
  await pool.query(readFileSync(new URL('../src/db/schema-sql/96_asset_transport.sql', import.meta.url), 'utf8'));
  await pool.query(readFileSync(new URL('../src/db/schema-sql/87_work_jobs.sql', import.meta.url), 'utf8'));
  const snapshot = async () => (await pool.query(`
    SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=$1 AND table_name NOT LIKE 'reverse_%'
    ORDER BY table_name,ordinal_position`, [schema])).rows;
  const before = await snapshot();
  const { ensureSchema } = await import('../dist/db/schema.js');
  const { mitLesePool } = await import('../dist/db/client.js');
  const run = opts => mitLesePool(pool, () => ensureSchema({ sperrSchema:schema,versuche:1,koerper:sql,...opts }));
  assert.equal((await run({nurProbe:true})).probe,true);
  assert.equal((await pool.query('SELECT to_regclass($1) AS t',[schema+'.reverse_eintraege'])).rows[0].t,null);
  await run({});
  await run({});
  assert.deepEqual(await snapshot(),before,'RV3 verändert keine bestehenden Spalten');
  const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'reverse_%'",[schema])).rows;
  assert.equal(tables.length,17);
  const pairs = ['dateien','symbole','verweise','kanten','statements'].map((n,i)=>['reverse_code_'+n,originals[i]]);
  for (const [target,source] of pairs) {
    const cols=(await pool.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE (table_schema='public' AND table_name=$1) OR (table_schema=$2 AND table_name=$3)",[source,schema,target])).rows;
    for(const c of cols.filter(c=>c.table_name===source)) assert.ok(cols.some(r=>r.table_name===target && r.column_name===(c.column_name==='project'?'eintrag_id':c.column_name) && r.data_type===c.data_type),source+'.'+c.column_name);
  }
  const bad = async (sql,code,values=[]) => assert.rejects(pool.query(sql,values),e=>e.code===code);
  await pool.query("INSERT INTO reverse_eintraege(id,titel,status,fingerabdruck) VALUES('rev-fixture-000001','A','bestaetigt','fingerprint'),('rev-fixture-000002','B','vorschlag','fingerprint')");
  await bad("UPDATE reverse_eintraege SET status='bestaetigt' WHERE id='rev-fixture-000002'",'23505');
  await pool.query("INSERT INTO reverse_medien(id,eintrag_id,position,art) VALUES(1,'rev-fixture-000001',0,'format-plugin-neu')");
  await bad("INSERT INTO reverse_medien(eintrag_id,position,art) VALUES('rev-fixture-000001',0,'iso')",'23505');
  await pool.query("INSERT INTO reverse_medien_dateien(id,medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES(1,1,'haupt','image.iso',repeat('a',64),42,'originals/a')");
  await bad("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES(1,'begleit','dup',repeat('a',64),42,'originals/b')",'23505');
  await bad("UPDATE reverse_medien_dateien SET upload_id='00000000-0000-0000-0000-000000000001'",'23503');
  await pool.query("INSERT INTO reverse_dateien(id,eintrag_id,medium_id,pfad,art) VALUES(1,'rev-fixture-000001',1,'app.exe','binaer')");
  await bad("UPDATE reverse_dateien SET storage_key='../outside'",'23514');
  await bad("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,art) VALUES('rev-fixture-000001',1,'app.exe','binaer')",'23505');
  await pool.query("INSERT INTO reverse_schichten(datei_id,medium_id,schicht,fingerabdruck,aktuell) VALUES(1,1,'S2','first',true),(NULL,1,'E','first',true)");
  await bad("INSERT INTO reverse_schichten(datei_id,medium_id,schicht,fingerabdruck,aktuell) VALUES(1,1,'S2','second',true)",'23505');
  await bad("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,aktuell) VALUES(1,'E','second',true)",'23505');
  await pool.query("UPDATE reverse_schichten SET aktuell=false");
  await pool.query("INSERT INTO reverse_schichten(datei_id,medium_id,schicht,fingerabdruck,aktuell) VALUES(1,1,'S2','second',true)");
  await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES('p18_rv3','rev-fixture-000001','sol-3')");
  await bad("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES('p18_rv3','rev-fixture-000001','sol-3')",'23505');
  await pool.query("UPDATE reverse_bindungen SET geloest_at=NOW()");
  await pool.query("INSERT INTO reverse_bindungen(project,eintrag_id,gebunden_von) VALUES('p18_rv3','rev-fixture-000001','sol-3')");
  await pool.query("INSERT INTO reverse_code_dateien(id,eintrag_id,datei_id,schicht,fingerabdruck,file_path,file_name,file_type,content) VALUES('cf','rev-fixture-000001',1,'S2','second','app.exe@S2/0_main.asm','0_main.asm','asm','masked instruction')");
  await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,line_start) VALUES('sym','rev-fixture-000001','app.exe@S2/0_main.asm','function','main',1)");
  await pool.query("INSERT INTO reverse_code_statements(id,eintrag_id,file_path,statement_type,line_start,order_index) VALUES(1,'rev-fixture-000001','app.exe@S2/0_main.asm','call',1,0)");
  await pool.query("INSERT INTO reverse_code_kanten(eintrag_id,file_path,statement_id,callee_name,line_number,target_symbol_id) VALUES('rev-fixture-000001','app.exe@S2/0_main.asm',1,'main',1,'sym')");
  await bad("UPDATE reverse_code_kanten SET target_symbol_id='foreign-original-symbol'",'23503');
  await bad("DELETE FROM reverse_eintraege WHERE id='rev-fixture-000001'",'23503');
  const fks=(await pool.query("SELECT conname,confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f'",[schema+'.reverse_auftraege'])).rows;
  assert.ok(fks.some(f=>f.target.endsWith('work_jobs')),'P20-FK gesetzt');
  const triggers=(await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal",[schema+'.reverse_code_dateien'])).rows;
  assert.ok(triggers.every(t=>!t.tgname.includes('code_file_change')));
  const types=(await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name LIKE 'reverse_%'",[schema])).rows;
  assert.ok(types.every(c=>c.data_type!=='bytea'));
  const fullUrl=new URL(url);
  fullUrl.searchParams.set('options','-c search_path='+fullSchema+',public');
  const fullPool=new pg.Pool({connectionString:fullUrl.toString()});
  try {
    assert.equal((await mitLesePool(fullPool,()=>ensureSchema({sperrSchema:fullSchema,nurProbe:true,versuche:1}))).probe,true);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1',[fullSchema])).rows[0].n,0,'vollständiger Startweg zurückgerollt');
  } finally { await fullPool.end(); }
  console.log('RV3 PASS: 17 Tabellen, Migration2x, Rollback, Altspalten, FK/UNIQUE, Retentiongenerationen, Rebind, Code-Vertrag, kein Sync-Trigger, vollständiger Startpfad.');
} finally {
  if(pool) await pool.end();
  await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
  await admin.query('DROP SCHEMA IF EXISTS '+fullSchema+' CASCADE');
  await admin.end();
}
