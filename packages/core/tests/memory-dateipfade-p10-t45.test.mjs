// P10-T45: echte PG-Spielwiese; Qdrant/Embedding sind explizite Test-Doubles.
// Aufruf: node --experimental-vm-modules packages/core/tests/memory-dateipfade-p10-t45.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import pg from 'pg';
import ts from 'typescript';

const url = new URL(process.env.DATABASE_URL);
assert.equal(url.port, '5433');
assert.equal(url.pathname, '/synapse_test');
const pool = new pg.Pool({ connectionString: url.href, max: 2 });
const project = 'sol3_t45_' + randomUUID().replaceAll('-', '');
const timestamp = '2026-01-01T00:00:00.000Z';
const fixtures = [];
function fixture(name, content, tags = [], linkedPaths = []) {
  const row = { id: randomUUID(), project, name, content, category: 'note', tags,
    linkedPaths, createdAt: timestamp, updatedAt: timestamp };
  fixtures.push(row);
  return row;
}
const exact = fixture('exact', 'Siehe packages/core/src/example.ts', [], ['packages/core/src/example.ts']);
const suffix = fixture('suffix', 'Siehe src/example.ts', [], ['src/example.ts']);
fixture('moo-tag', 'Geschuetzte Quelldatei.', ['legacy/tray.moo']);
fixture('anderes-index', 'Siehe packages/other/index.ts', [], ['packages/other/index.ts']);
const boundary = fixture('segmentgrenze', 'Siehe other-src/example.ts', [], ['other-src/example.ts']);
fixture('pg-frisch', 'Siehe src/neu.go', ['src/aktuell.rs'], ['src/alt.ts']);
const semantic = fixture('semantik', 'Aktueller Inhalt in PG.');
const domain = fixture('domain', 'https://example.com/src/web.go example.com/src/web.go v1.2.3 1.2.3 /version/1.2.3');
for (let i = fixtures.length; i < 1400; i++) fixture('filler-' + i, 'Unverbundene Notiz ' + i);
fixture('nach-1000', 'Siehe src/spaet.ts', [], ['src/spaet.ts']);
let semanticResults = [];
let semanticFail = false;
let scrollCalls = 0;
const forbidden = () => { throw new Error('Nicht erlaubter Schreibaufruf auf Test-Double'); };
const modules = {
  uuid: { v4: randomUUID },
  '../db/client.js': { getPool: () => pool, getHintergrundPool: () => pool },
  '../embeddings/index.js': { embed: async () => { if (semanticFail) throw new Error('offline'); return [0]; } },
  '../qdrant/collections.js': { ensureCollection: forbidden },
  '../qdrant/operations.js': {
    insertVector: forbidden, deleteVector: forbidden, deleteVectors: forbidden, deleteByFilter: forbidden,
    searchVectors: async () => semanticResults,
    scrollVectors: async (_collection, _filter, limit) => {
      scrollCalls++;
      return fixtures.slice(0, limit).map(({ id, ...payload }) => ({ id, payload }));
    },
  },
  './intern-schalter.js': { embeddingNachtragAngehalten: () => true },
  './embed-nachzug.js': { betteEinzelnEin: forbidden },
  './code.js': { searchCode: forbidden },
  '../types/index.js': { COLLECTIONS: { projectMemories: p => 'test_' + p } },
};
const source = await readFile(new URL('../src/services/memory.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const module = new SourceTextModule(compiled);
await module.link(specifier => {
  assert.ok(modules[specifier], 'Unerwartete Abhaengigkeit: ' + specifier);
  const exports = modules[specifier];
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  });
});
await module.evaluate();
const { findMemoriesForPath: find, extractFilePaths: extract, isValidFilePath: valid } = module.namespace;
let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('OK', name); }
  catch (error) { failed++; console.error('FAIL', name, error.message); }
}
const pathNames = results => Array.from(results.filter(r => r.matchType === 'path'), r => r.memory.name);
try {
  await pool.query(
    'INSERT INTO memories (id,project,name,content,category,tags,created_at,updated_at) SELECT id,project,name,content,category,tags,$2,$2 FROM jsonb_to_recordset($1::jsonb) AS x(id text,project text,name text,content text,category text,tags text[])',
    [JSON.stringify(fixtures), timestamp],
  );
  assert.equal(Number((await pool.query('SELECT count(*) FROM memories WHERE project=$1', [project])).rows[0].count), 1401);
  const golden = await find(project, 'packages/core/src/example.ts', 1);
  const normalized = JSON.parse(JSON.stringify(golden).replaceAll(exact.id, '<id>').replaceAll(project, '<project>'));
  // Unveraendert aus rotem Lauf 2f859908 am alten Stand uebernommen.
  await check('vollstaendiges .ts-Golden unveraendert', () => assert.deepEqual(normalized, [{"memory":{"id":"<id>","project":"<project>","name":"exact","content":"Siehe packages/core/src/example.ts","category":"note","tags":[],"linkedPaths":["packages/core/src/example.ts"],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"matchType":"path","score":1}]));
  console.log('GOLDEN_EXACT', JSON.stringify(normalized));
  await check('exakter .ts-Pfad bleibt 1.0', () => {
    assert.equal(golden.length, 1);
    assert.equal(golden[0].memory.name, 'exact');
    assert.equal(golden[0].score, 1);
    assert.equal(golden[0].matchType, 'path');
  });
  await check('.moo-Tag aus PG', async () => assert.deepEqual(pathNames(await find(project, 'legacy/tray.moo')), ['moo-tag']));
  await check('Memory hinter 1000 gefunden', async () => assert.deepEqual(pathNames(await find(project, 'src/spaet.ts')), ['nach-1000']));
  await check('gleicher Dateiname ist kein Pfadtreffer', async () => assert.deepEqual(pathNames(await find(project, 'packages/core/index.ts')), []));
  await check('reiner Dateiname ist kein Pfadtreffer', async () => assert.deepEqual(pathNames(await find(project, 'index.ts')), []));
  await check('Suffix an Segmentgrenze hat 0.9', async () => {
    const results = await find(project, 'packages/core/src/example.ts');
    assert.equal(results.find(r => r.memory.name === suffix.name)?.score, 0.9);
    assert.ok(!pathNames(results).includes(boundary.name));
  });
  await check('Windows-Pfad und Dot-Praefix', async () => assert.deepEqual(pathNames(await find(project, '.\\legacy\\tray.moo')), ['moo-tag']));
  await check('neue PG-Inhalte und Tags statt altem Payload', async () => {
    assert.deepEqual(pathNames(await find(project, 'src/neu.go')), ['pg-frisch']);
    assert.deepEqual(pathNames(await find(project, 'src/aktuell.rs')), ['pg-frisch']);
    assert.deepEqual(pathNames(await find(project, 'src/alt.ts')), []);
  });
  await check('beliebige Endungen und Referenzformen', () => {
    const tick = String.fromCharCode(96);
    const result = Array.from(extract('src/a.moo ' + tick + 'src/b.go' + tick + ' [Rust](src/c.rs) "src/d.sh" src/e.toml src/f.zz9 src/g.cpp src/h.test.ts'));
    assert.deepEqual(result, ['src/b.go', 'src/c.rs', 'src/a.moo', 'src/d.sh', 'src/e.toml', 'src/f.zz9', 'src/g.cpp', 'src/h.test.ts']);
  });
  await check('Domains und Versionsnummern keine Links', () => {
    assert.deepEqual(Array.from(extract(domain.content)), []);
    for (const path of ['example.com/src/web.go', 'https://example.com/src/web.go', '/version/1.2.3']) assert.equal(valid(path), false, path);
  });
  await check('bestehende Ausschluesse bleiben', () => {
    for (const path of ['node_modules/a/a.ts', 'dist/a.ts', '.git/config.ts', 'index.ts']) assert.equal(valid(path), false, path);
  });
  await check('Semantik ergaenzt mit aktuellem PG-Inhalt, geloeschte Treffer fehlen', async () => {
    semanticResults = [
      { id: semantic.id, score: 0.7, payload: { ...semantic, content: 'VERALTET' } },
      { id: randomUUID(), score: 0.9, payload: { ...semantic, name: 'geloescht' } },
    ];
    const results = await find(project, 'src/unbekannt.go');
    assert.equal(results.length, 1);
    assert.equal(results[0].matchType, 'semantic');
    assert.equal(results[0].memory.content, semantic.content);
    semanticResults = [];
  });
  semanticResults = [];
  await check('Wissensstuecke werden zu einem PG-Memory zusammengefuehrt', async () => {
    semanticResults = [0.6, 0.8].map(score => ({
      id: randomUUID(), score, payload: { ...semantic, content: 'TEIL',
        wissen_stueck: { eintrag_id: semantic.id, nr: 0, version: 1, inhalt: 'TEIL' } },
    }));
    const results = await find(project, 'src/unbekannt.go');
    assert.equal(results.length, 1);
    assert.equal(results[0].memory.id, semantic.id);
    assert.equal(results[0].memory.content, semantic.content);
    assert.equal(results[0].score, 0.8);
    semanticResults = [];
  });
  semanticResults = [];
  await check('Protokollrelative Domain bleibt ausgeschlossen', () => assert.equal(valid('//example.com/src/web.go'), false));
  await check('numerische Dateiendung ist erlaubt, Versionsnummer bleibt ausgeschlossen', () => {
    assert.deepEqual(Array.from(extract('docs/chapter.1 /version/1.2.3')), ['docs/chapter.1']);
  });
  await check('Semantikausfall zerstoert Pfadtreffer nicht', async () => {
    semanticFail = true;
    assert.deepEqual(pathNames(await find(project, 'legacy/tray.moo')), ['moo-tag']);
    semanticFail = false;
  });
  await check('PG-Projektisolation', async () => {
    assert.deepEqual(Array.from(await find(project + '_fremd', 'legacy/tray.moo')), []);
  });
  await check('Pfadermittlung ruft keinen Qdrant-Scroll', () => assert.equal(scrollCalls, 0));
  const timings = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await find(project, 'src/spaet.ts', 1);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  console.log('PERFORMANCE', JSON.stringify({ memories: fixtures.length, runs: timings.length, medianMs: timings[10], p95Ms: timings[19] }));
} finally {
  await pool.query('DELETE FROM memories WHERE project=$1', [project]);
  await pool.end();
}
console.log('FAILED', failed);
process.exitCode = failed ? 1 : 0;
