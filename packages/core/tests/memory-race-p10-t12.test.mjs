/** P10-T12: echte parallele PG-Upserts, eigenes Schema ausschließlich in synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port,'5433');
assert.equal(db.pathname,'/synapse_test');
const schema = 'sol3_t12_' + randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path=' + schema + ',public');
process.env.DATABASE_URL = db.toString();
const {getPool,getHintergrundPool} = await import('../dist/db/client.js');
const {writeMemory} = await import('../dist/services/memory.js');
const pool = getPool(), query = pool.query.bind(pool);
const background = getHintergrundPool(), backgroundQuery = background.query.bind(background);
const backgroundIds = [];
// Beobachte die tatsächlich zum Nachzug gegebene ID, ohne Modell-/Qdrant-Aufrufe.
background.query = async (sql, values) => {
  assert(sql.includes('FROM memories'), 'nur Memory-Nachzug erwartet');
  backgroundIds.push(...values[0]);
  return {rows:[]};
};
let arrived = 0, release;
const bothReads = new Promise(resolve => release = resolve);
pool.query = async (sql, values, ...rest) => {
  if (sql.includes('FROM intern_schalter')) return {rows:[]};
  const result = await query(sql,values,...rest);
  if (sql.includes('FROM memories') && values?.[0] === 'test-project' && values?.[1] === 'race' && result.rows.length === 0) {
    // Nur fertige SELECTs verzögern, keine offenen Transaktionen oder gehaltenen Sperren.
    if (++arrived === 2) release();
    await bothReads;
  }
  return result;
};
const source = (await readFile(new URL('../src/db/schema.ts',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const mirror = await readFile(new URL('../src/db/schema-sql/20_wissen.sql',import.meta.url),'utf8');
const failures = [];
function check(label, actual, expected) {
  try { assert.deepEqual(actual,expected,label); } catch(error) { failures.push(error.message); }
}
try {
  await query('CREATE SCHEMA ' + schema);
  for (const table of ['memories','plans','agent_events','agent_event_acks']) {
    const ddl = source.match(new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);'))?.[0];
    assert(ddl,'CREATE TABLE-Anker ' + table);
    await query(ddl);
  }
  await query('ALTER TABLE memories ADD COLUMN embedded_at timestamptz');
  for (const table of ['memories','plans']) {
    const name = 'uq_' + table + '_project_name';
    const ddl = source.match(new RegExp('CREATE UNIQUE INDEX IF NOT EXISTS ' + name + '[^;]+;'))?.[0];
    check('Laufzeitschema enthält ' + name, Boolean(ddl), true);
    // Altstand: Spiegel-Index nachstellen, damit zusätzlich der echte Schreib-Race messbar ist.
    const fallback = mirror.match(new RegExp('CREATE UNIQUE INDEX ' + name + '[^;]+;'))?.[0];
    assert(fallback, 'bereits bestehender Spiegelindex als Positivkontrolle');
    await query((ddl ?? fallback).replaceAll('public.',''));
  }
  const started = performance.now();
  const results = await Promise.allSettled([
    writeMemory('test-project','race','Inhalt A','note',['a']),
    writeMemory('test-project','race','Inhalt B','note',['b']),
  ]);
  check('beide konkurrierenden Schreibaufrufe erfolgreich', results.map(r => r.status), ['fulfilled','fulfilled']);
  const saved = (await query("SELECT * FROM memories WHERE project='test-project' AND name='race'")).rows;
  assert.equal(saved.length,1,'ein Datensatz für Projekt/Name');
  const successful = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  check('alle Rückgaben nennen gespeicherte ID', successful.map(r => r.id), successful.map(() => saved[0].id));
  for (const result of successful) check('createdAt stammt aus PG', result.createdAt,new Date(saved[0].created_at).toISOString());
  // Nachtrag liest IDs synchron nach dem Pause-Check; nächste Eventloop-Runde lässt ihn anlaufen.
  await new Promise(resolve => setImmediate(resolve));
  check('Nachtrag für beide Writes auf kanonischer ID', backgroundIds, [saved[0].id,saved[0].id]);
  const again = await writeMemory('test-project','race','Inhalt C','note',['c']);
  assert.equal(again.id,saved[0].id);
  assert.equal(again.createdAt,new Date(saved[0].created_at).toISOString());
  const final = (await query("SELECT content,tags,embedded_at FROM memories WHERE id=$1",[again.id])).rows[0];
  assert.deepEqual(final,{content:'Inhalt C',tags:['c'],embedded_at:null});
  const other = await writeMemory('other-project','race','Anderes Projekt');
  assert.notEqual(other.id,again.id,'gleicher Name in anderem Projekt bleibt unabhängig');
  await query("INSERT INTO plans(id,project,name) VALUES('one','test-project','Plan')");
  await assert.rejects(query("INSERT INTO plans(id,project,name) VALUES('two','test-project','Plan')"), {code:'23505'});
  const event = (await query("INSERT INTO agent_events(project,event_type,priority,scope,source_id) VALUES('test-project','ANNOUNCEMENT','normal','all','test') RETURNING id")).rows[0];
  await query("INSERT INTO agent_event_acks(event_id,agent_id) VALUES($1,'test')",[event.id]);
  assert.equal((await query('SELECT count(*)::int AS n FROM agent_event_acks')).rows[0].n,1);
  await query('DELETE FROM agent_events WHERE id=$1',[event.id]);
  assert.equal((await query('SELECT count(*)::int AS n FROM agent_event_acks')).rows[0].n,0,'ACK-Cascade wirksam');
  console.log('Race/Upsert/Cascade-Dauer ms:',Math.round(performance.now()-started));
  assert.deepEqual(failures,[],failures.join('\n'));
  console.log('PASS P10-T12: Unique im Laufzeitschema, kanonischer Memory-Upsert, ACK-Cascade');
} finally {
  pool.query = query;
  background.query = backgroundQuery;
  await query('DROP SCHEMA ' + schema + ' CASCADE');
  await background.end();
  await pool.end();
}
