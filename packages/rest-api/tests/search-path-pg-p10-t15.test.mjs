/** P10-T15: REST und stdio Pfadsuche gegen synapse_test, ohne Qdrant-Vektoren. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port, '5433');
assert.equal(db.pathname, '/synapse_test');
let qdrantCalls = 0;
const trap = createServer((req, res) => {
  qdrantCalls++;
  res.writeHead(404, {'content-type': 'application/json'});
  res.end(JSON.stringify({status: {error: 'Keine Test-Collection'}, time: 0}));
});
await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
process.env.QDRANT_URL = 'http://127.0.0.1:' + trap.address().port;
const {default: Fastify} = await import('../node_modules/fastify/fastify.js');
const {mcpRoutes} = await import('../dist/routes/mcp.js');
const {getPool} = await import('../../core/dist/db/client.js');
const {searchFilesByPath} = await import('../../core/dist/services/code.js');
const {searchByPath} = await import('../../mcp-server/dist/tools/search.js');
const pool = getPool();
const project = 'sol-3-path-' + randomUUID();
const app = Fastify({logger: false});
await app.register(mcpRoutes);
await app.ready();
async function rest(pattern, extra = {}) {
  const response = await app.inject({
    method: 'POST', url: '/', payload: {jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {name: 'search', arguments: {action: 'path', project, path_pattern: pattern, ...extra}}},
  });
  assert.equal(response.statusCode, 200);
  return JSON.parse(response.json().result.content[0].text);
}
try {
  for (const [file, type, count] of [
    ['src/a.ts','ts',2], ['src/b.ts','ts',1], ['deep/unparsed.ts','ts',0],
    ['data/settings.json','json',1], ['src/a.ts.bak','bak',0],
  ]) {
    await pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,chunk_count,file_size) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), project, file, file.split('/').at(-1), type, count, 123]);
  }
  for (const [file, index, content] of [
    ['src/a.ts',0,'first chunk'], ['src/a.ts',1,'NEEDLE second chunk'],
    ['src/b.ts',0,'nothing'], ['data/settings.json',0,'{"needle":true}'],
  ]) {
    await pool.query('INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), project, file, index, content, index * 10 + 1, index * 10 + 4]);
  }
  // Positivanker: Daten existieren ausschließlich in PG, kein Embedding-/Indexierungsaufruf.
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM code_files WHERE project=$1', [project])).rows[0].n, 5);
  assert((await searchFilesByPath(project, '*.ts')).some(row => row.filePath === 'src/a.ts'));

  const first = await rest('*.ts', {limit: 1});
  assert.equal(first.success, true);
  assert.equal(first.results.length, 1, 'PG-only-Datei muss über REST auffindbar sein');
  assert.equal(first.totalMatches, 3, 'Gesamtzahl zählt Dateien vor limit, keine .ts.bak');
  assert.equal(first.results[0].filePath, 'deep/unparsed.ts');
  assert.equal(first.results[0].fileSize, 123);
  assert.equal(first.results[0].chunkCount, 0);
  assert.equal(qdrantCalls, 0, 'Pfadsuche darf Qdrant nicht ansprechen');
  console.log('OK PG-only, exakter Glob, ungeparste Datei und Metadaten');

  const filtered = await rest('*.ts', {content_pattern: 'needle', limit: 1});
  assert.equal(filtered.totalMatches, 1);
  assert.equal(filtered.results[0].filePath, 'src/a.ts');
  assert.equal(filtered.results[0].chunkCount, 2);
  assert.equal(filtered.results[0].lineStart, 11);
  assert.equal(filtered.results[0].lineEnd, 14);
  assert.match(filtered.results[0].content, /NEEDLE/);
  assert.equal((await rest('*.json', {content_pattern: 'NEEDLE'})).totalMatches, 1);
  const invalid = await rest('*.ts', {content_pattern: '['});
  assert.equal(invalid.success, false);
  assert.match(invalid.error, /Regex/);
  assert.equal((await rest('missing/*.ts', {content_pattern: '['})).success, false, 'Regex auch bei leerem Projektbereich validieren');
  assert.equal((await rest('*.ts', {content_pattern: 'absent'})).totalMatches, 0);
  console.log('OK SQL-Regex: zweiter Chunk, case-insensitive, ungültig und leer');

  const stdio = await searchByPath(project, '*.ts', {contentPattern: 'needle', limit: 1});
  assert.equal(stdio.success, true);
  assert.equal(stdio.totalMatches, 1);
  assert.deepEqual(stdio.results, filtered.results);
  assert.equal((await searchByPath(project, '*.ts', {limit: 1})).totalMatches, 3);
  assert.equal((await searchByPath(project, '*.ts', {contentPattern: '['})).success, false);
  assert.equal((await rest('src/*.ts')).totalMatches, 2);
  assert.equal((await rest('**/*.json')).totalMatches, 1);
  assert.equal((await rest('*.ts', {limit: 0})).totalMatches, 3);
  assert.deepEqual((await rest('*.ts', {limit: 0})).results, []);
  console.log('OK REST/stdio gleiche PG-Ergebnisse und echte Gesamtzahl');

  await pool.query(`INSERT INTO code_files(id,project,file_path,file_name,file_type,chunk_count,file_size)
    SELECT $1 || n, $1, 'bulk/' || n || '.json', n || '.json', 'json', 0, 2
    FROM generate_series(1,10001) n`, [project]);
  const large = await rest('*.json', {limit: 2});
  assert.equal(large.totalMatches, 10002);
  assert.equal(large.results.length, 2);
  assert.equal(qdrantCalls, 0);
  console.log('PASS P10-T15: mehr als 10000 Dateien ohne Index-Grenze, kein Qdrant');
} finally {
  await app.close();
  await pool.query('DELETE FROM code_chunks WHERE project=$1', [project]);
  await pool.query('DELETE FROM code_files WHERE project=$1', [project]);
  await pool.query('DELETE FROM tool_calls WHERE project=$1', [project]);
  await pool.end();
  await new Promise(resolve => trap.close(resolve));
}
