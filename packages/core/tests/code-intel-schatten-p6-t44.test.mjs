/** P6-T44: schatten:'alle' nur mit Dateibezug, fs_pruefung nach dem Commit. Golden am Altstand; nur synapse_test.
 * Aufruf: node tests/code-intel-schatten-p6-t44.test.mjs [--capture | --golden]
 *   --capture  Golden am Altstand ausgeben (GOLDEN_JSON=...)
 *   --golden   nur Golden-Vergleich (gezielter Schatten, Aufrufe ohne schatten, commit-Antwort ohne fs_pruefung-Zusatz)
 *   (ohne)     Golden + neue Erwartungen (rot am Altstand, gruen nach dem Fix)
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
process.env.QDRANT_URL = 'http://127.0.0.1:9';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_PLAN_PRUEFUNG = '0';
const ci = await import('../dist/services/code-intel.js');
const db = await import('../dist/db/client.js');
const core = await import('../dist/index.js');
const batch = await import('../dist/services/file-batch.js');
const pool = db.getPool();
assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
const project = 'p6_t44_schatten-' + randomUUID();
const project2 = 'p6_t44_schatten-fs-' + randomUUID();
const hash = text => createHash('sha256').update(text).digest('hex');
const namen = new Map();
const normal = value => JSON.parse(JSON.stringify(value, (key, v) => {
  if (key === 'schatten_parse_ms' || key === 'gewartet_ms') return undefined;
  if (key === 'batch_id' && typeof v === 'string') return '<batch>';
  if (key === 'host' && typeof v === 'string') return '<host>';
  if (typeof v !== 'string') return v;
  let s = v.replaceAll(project2, '<projekt2>').replaceAll(project, '<projekt>');
  for (const [id, name] of namen) {
    if (s === id) return name;
    s = s.replaceAll('ghost:' + id + ':', 'ghost:' + name + ':').replaceAll('(plan ' + id, '(plan ' + name);
  }
  return s;
}));
const A = 'export function alpha(){ return 1; }\n';
const B = 'export function beta(){ return 2; }\n';
const C = 'notiz\n';
const FREI = 'export function frei(){ return 0; }\n';
const bestand = (action, a) => async () => {
  switch (action) {
    case 'file': { const f = await ci.getFileContent(project, a.file_path); return f ? { success: true, ...f, project } : { success: false, project }; }
    case 'functions': { const functions = await ci.getFunctions(project, a.file_path, a.name, false, undefined); return { success: true, functions, count: functions.length, project }; }
    case 'symbols': { const symbols = await ci.getSymbols(project, a.symbol_type, a.file_path, a.name, 100, undefined); return { success: true, symbols, count: symbols.length, symbol_type: a.symbol_type, project }; }
    case 'references': return { success: true, ...await ci.getReferences(project, a.name, false, 200), project };
    case 'search': { const results = await ci.fullTextSearchCode(project, a.query, undefined, 20, a.file_path, {}); return { success: true, results, count: results.length, mode: 'fulltext', project }; }
    case 'statements': { const statements = await ci.getStatements(project, a.file_path, undefined, false, undefined); return { success: true, statements, count: statements.length, project }; }
    case 'calls': { const r = await ci.getCallEdges(project, a.file_path, a.callee, 200); return { success: true, ...r, count: r.calls.length, project }; }
    case 'tree': return { success: true, tree: await ci.getProjectTree(project, a), project };
  }
  throw new Error('unbekannte Action ' + action);
};
const run = (action, a = {}) => core.mitCodeIntelSchatten(action, { project, ...a }, bestand(action, a));
const aufraeumen = async () => {
  for (const sql of ['DELETE FROM file_batch_waits WHERE project=ANY($1)', 'DELETE FROM file_reservations WHERE project=ANY($1)',
    'DELETE FROM file_batch_plans WHERE project=ANY($1)', 'DELETE FROM file_versions WHERE project=ANY($1)',
    'DELETE FROM code_files WHERE project=ANY($1)', 'DELETE FROM projects WHERE name=ANY($1)']) {
    try { await pool.query(sql, [[project, project2]]); } catch { /* Tabelle fehlt oder FK: Testdaten bleiben isoliert */ }
  }
};
let dir;
try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'p6-t44-test', '/tmp/p6-t44-fixture']);
  for (const [file_path, content] of [['src/a.ts', A], ['src/b.ts', B], ['docs/c.txt', C], ['src/frei.ts', FREI]]) {
    await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), project, file_path, file_path.split('/').at(-1), file_path.split('.').at(-1), Buffer.byteLength(content), content, hash(content)]);
  }
  const plan = async (ops, expected) => (await pool.query(
    "INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,expires_at) VALUES($1,$2,$3::jsonb,$4::jsonb,'[]'::jsonb,'open',NOW()+INTERVAL '1 day') RETURNING id::text",
    [project, 'p6-t44-test', JSON.stringify(ops), JSON.stringify(expected)])).rows[0].id;
  const planA = await plan([{ action: 'search_replace', file_path: 'src/a.ts', search: 'return 1', replace: 'return 11' }], { 'src/a.ts': hash(A) });
  const planB = await plan([
    { action: 'create', file_path: 'lib/neu/b2.ts', content: 'export function gamma(){ return beta(); }\n' },
    { action: 'search_replace', file_path: 'src/b.ts', search: 'return 2', replace: 'return 22' }
  ], { 'src/b.ts': hash(B) });
  // Plan C traegt einen veralteten Basis-Hash: Drift nur fuer docs/c.txt.
  const planC = await plan([{ action: 'copy', file_path: 'docs/c.txt', new_path: 'docs/d.txt' }], { 'docs/c.txt': hash('veraltet\n') });
  namen.set(planA, '<A>'); namen.set(planB, '<B>'); namen.set(planC, '<C>');

  dir = await mkdtemp(join(tmpdir(), 'p6-t44-'));
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project2, hostname(), dir]);
  const ALT = 'eins\nzwei\n', NEU = 'eins\nNEU\n';
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,'f.txt','f.txt','txt',$3,$4,$5)",
    [randomUUID(), project2, Buffer.byteLength(ALT), ALT, hash(ALT)]);
  await writeFile(join(dir, 'f.txt'), ALT);
  const fsPlan = await batch.planBatch({ project: project2, agent_id: 'p6-t44-test', ops: [{ action: 'search_replace', file_path: 'f.txt', search: 'zwei', replace: 'NEU' }] });
  namen.set(String(fsPlan.plan_id), '<P>');
  const commit = await batch.commitBatch({ plan_id: fsPlan.plan_id, agent_id: 'p6-t44-test' });
  assert.equal(commit.success, true, JSON.stringify(commit));
  const { fs_pruefung, ...commitRest } = commit;
  const commitGolden = {
    rest: Object.fromEntries(Object.entries(commitRest).filter(([key]) => !key.startsWith('embeddings_'))),
    fs_vor_commit: { status: fs_pruefung?.status, dateien: fs_pruefung?.dateien }
  };

  const golden = normal({
    gezielt: {
      a_file: await run('file', { schatten: planA, file_path: 'src/a.ts' }),
      a_functions: await run('functions', { schatten: planA, name: 'alpha' }),
      b_symbols: await run('symbols', { schatten: planB, symbol_type: 'function' }),
      b_references: await run('references', { schatten: planB, name: 'beta' }),
      b_search: await run('search', { schatten: planB, query: 'gamma' }),
      b_statements: await run('statements', { schatten: planB, file_path: 'src/b.ts' }),
      b_calls: await run('calls', { schatten: planB, callee: 'beta' }),
      b_tree: await run('tree', { schatten: planB, show_ghosts: true, show_assets: false }),
      c_file_fremd: await run('file', { schatten: planC, file_path: 'src/a.ts' }),
      c_file_kopie: await run('file', { schatten: planC, file_path: 'docs/d.txt' })
    },
    ohne: {
      file: await run('file', { file_path: 'src/a.ts' }),
      functions: await run('functions', {}),
      tree: await run('tree', { show_assets: false }),
      tree_ohne_ghosts: await run('tree', { show_ghosts: false, show_assets: false }),
      search: await run('search', { query: 'alpha' })
    },
    commit: commitGolden
  });
  if (process.argv.includes('--capture')) {
    console.log('GOLDEN_JSON=' + JSON.stringify(golden));
  } else {
    assert.deepEqual(golden, JSON.parse(readFileSync(new URL('./fixtures/code-intel-schatten-p6-t44.golden.json', import.meta.url), 'utf8')));
    console.log('OK Golden: gezielter Schatten, Aufrufe ohne schatten und commit-Antwort (ohne fs_pruefung-Zusatz) bytegleich');
    if (!process.argv.includes('--golden')) {
      const ids = r => (r.staende ?? []).map(s => s.plan_id).sort();
      // Datei-Actions: nur Plaene mit Bezug, keine fremde Drift, Zaehlung der uebrigen.
      const fa = await run('file', { schatten: 'alle', file_path: 'src/a.ts' });
      assert.deepEqual(ids(fa), [planA], 'file src/a.ts nur Plan A');
      assert.equal(fa.staende[0].content, A.replace('return 1', 'return 11'));
      assert(!JSON.stringify(fa).includes('docs/c.txt'), 'keine Drift fremder Dateien');
      assert.equal(fa.ohne_bezug, 2);
      assert.match(fa.ohne_bezug_hinweis, /^2 offene Pläne ohne Bezug zu src\/a\.ts/);
      assert(!JSON.stringify(fa).includes('docs/'), 'keine Drift fremder Dateien');
      const fd2 = await run('file', { schatten: 'alle', file_path: 'docs/d.txt' });
      assert.deepEqual(ids(fd2), [planC], 'file docs/d.txt nur Plan C');
      assert.deepEqual(fd2.staende[0].drift.map(d => d.file_path), ['docs/d.txt'], 'Drift der angefragten Datei bleibt');
      const fc = await run('file', { schatten: 'alle', file_path: 'docs/c.txt' });
      assert.deepEqual(ids(fc), [planC], 'Quelle der Kopie: Plan C hat Bezug');
      assert.equal(fc.staende[0].drift, undefined, 'Drift der Kopie gehoert nicht zu docs/c.txt');
      const neu = await run('file', { schatten: 'alle', file_path: 'b2.ts' });
      assert.deepEqual(ids(neu), [planB], 'neue Datei per Suffix nur Plan B');
      const fl = await run('functions', { schatten: 'alle', file_path: 'src/' });
      assert.deepEqual(ids(fl), [planA, planB].sort(), 'LIKE-Muster src/ trifft A und B');
      assert.equal(fl.ohne_bezug, 1);
      const st = await run('statements', { schatten: 'alle', file_path: 'src/b.ts' });
      assert.deepEqual(ids(st), [planB]);
      // Ohne Pfad: nur Plaene, deren Ergebnis sich vom Bestand unterscheidet.
      const fn = await run('functions', { schatten: 'alle', name: 'alpha' });
      assert.deepEqual(ids(fn), [planA], 'functions alpha nur Plan A');
      assert.match(fn.ohne_bezug_hinweis, /ohne Einfluss/);
      const rf = await run('references', { schatten: 'alle', name: 'beta' });
      assert.deepEqual(ids(rf), [planB], 'references beta nur Plan B');
      const se = await run('search', { schatten: 'alle', query: 'gamma' });
      assert.deepEqual(ids(se), [planB], 'search gamma nur Plan B');
      // Kein Plan beruehrt die Datei: Bestandsantwort plus klarer Hinweis.
      const ff = await run('file', { schatten: 'alle', file_path: 'src/frei.ts' });
      assert.equal(ff.content, FREI); assert.equal(ff.staende, undefined);
      assert.match(ff.schatten_hinweis, /Kein offener Plan berührt src\/frei\.ts/);
      assert.equal(ff.ohne_bezug, 3);
      // Ghost-Baum: nur Plaene mit Ghost-Zeilen unter dem Pfad, sonst Hinweis.
      const tr = await run('tree', { show_ghosts: true, path: 'lib', show_assets: false });
      assert.deepEqual(tr.plaene, [planB]); assert.match(tr.tree, /\[g\] b2\.ts/);
      const tn = await run('tree', { show_ghosts: true, path: 'nirgends', show_assets: false });
      assert.equal(tn.tree, await ci.getProjectTree(project, { show_ghosts: true, path: 'nirgends', show_assets: false }));
      assert.match(tn.schatten_hinweis, /Kein offener Plan berührt nirgends/); assert.equal(tn.plaene, undefined);
      console.log('OK schatten:alle: nur Plaene mit Bezug, Drift nur angefragter Dateien, Zaehlung und Hinweis');
      // fs_pruefung: Altwerte bleiben (vor_commit), Stand nach dem Commit ehrlich gekennzeichnet.
      assert.equal(fs_pruefung.zeitpunkt, 'vor_commit');
      assert.equal(fs_pruefung.dateien[0].pg_hash, hash(ALT));
      assert.deepEqual(fs_pruefung.nach_commit, { status: 'noch_nicht_geprueft', dateien: [{ file_path: 'f.txt', pg_hash: hash(NEU), fs_status: 'noch_nicht_geprueft' }] });
      assert.match(fs_pruefung.hinweis, /VOR dem Schreiben/);
      const fd = await import('../dist/services/file-fs-drift.js');
      const ja = fd.fsPruefungNachCommit({ status: 'gleich', dateien: [] }, [{ file_path: 'x', hash: 'h1', auf_platte: 'ja' }, { file_path: 'y', hash: 'h2', deleted: true, auf_platte: 'ja' }]);
      assert.deepEqual(ja.nach_commit, { status: 'gleich', dateien: [{ file_path: 'x', pg_hash: 'h1', fs_hash: 'h1', fs_status: 'gleich' }, { file_path: 'y', pg_hash: null, fs_hash: null, fs_status: 'gleich' }] });
      const nein = fd.fsPruefungNachCommit({ status: 'gleich', dateien: [] }, [{ file_path: 'x', hash: 'h1', auf_platte: 'ja' }, { file_path: 'z', hash: 'h3', auf_platte: 'nein' }]);
      assert.equal(nein.nach_commit.status, 'noch_nicht_synchron'); assert.equal(nein.nach_commit.dateien[1].fs_status, 'noch_nicht_synchron');
      console.log('OK fs_pruefung: vor_commit gekennzeichnet, nach_commit mit neuem PG-Hash und ehrlichem Plattenstatus');
    }
  }
} finally {
  await aufraeumen();
  if (dir) await rm(dir, { recursive: true, force: true });
  await db.closePool();
}
process.exit(0); // Nur nach vollständig erfolgreichem Test; importierte Hintergrund-Timer sind kein Testziel.
