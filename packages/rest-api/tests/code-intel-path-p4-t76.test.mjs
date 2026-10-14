/**
 * P4-T76: Pfadauflösung fuer Einzeldatei-Abfragen (file + flow).
 * Fuehrt ausschliesslich gegen eine vorhandene synapse_test-Datenbank und ein
 * pro Lauf eindeutiges Testprojekt aus. Keine Datenbank wird angelegt/gedroppt.
 * Build-Voraussetzung: core, rest-api und mcp-server dist.
 */
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.PARSER_LOOP_DISABLED = '1';
// Tests nutzen ausschliesslich DATABASE_URL (im shell-Job automatisch die Projekt-DB synapse_test); eine geerbte System-DB-URL wird verworfen.
delete process.env.SYNAPSE_DATABASE_URL;

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const repo = join(hier, '..', '..', '..');
const lade = (...teile) => import(pathToFileURL(join(repo, ...teile)).href);
const dbUrlRaw = process.env.DATABASE_URL || '';
let dbUrl;
try { dbUrl = new URL(dbUrlRaw); } catch { throw new Error('P4-T76 ABBRUCH: DATABASE_URL fehlt/ungueltig'); }
const dbName = decodeURIComponent(dbUrl.pathname.replace(/^\//, ''));
if (dbName !== 'synapse_test' || (dbUrl.port || '5432') === '5432') {
  throw new Error('P4-T76 ABBRUCH: erwartet synapse_test auf Port ungleich 5432; Zugangsdaten werden nicht ausgegeben');
}

const pg = createRequire(join(repo, 'packages', 'core', 'package.json'))('pg');
const admin = new pg.Client({ connectionString: dbUrlRaw });
await admin.connect();
if ((await admin.query('SELECT current_database() AS name')).rows[0].name !== 'synapse_test') {
  await admin.end();
  throw new Error('P4-T76 ABBRUCH: aktive Datenbank ist nicht synapse_test');
}

const project = 'p4_t76_' + process.pid + '_' + Date.now();
const files = [
  ['README.md', '# Root README\n'],
  ['coedit-test/README.md', '# Nested README\n'],
  ['left/SHARED.md', '# Left\n'],
  ['right/SHARED.md', '# Right\n'],
  ['outer/one/UNIQUE.md', '# Unique suffix\n'],
  ['prefix/subtree/file.js', 'const marker = 1;\n'],
  ['nested/wild%/item.md', '# Percent literal\n'],
  ['nested/wildX/item.md', '# Percent wildcard decoy\n'],
  ['nested/under_score/item.md', '# Underscore literal\n'],
  ['nested/underXscore/item.md', '# Underscore wildcard decoy\n'],
  ['outer/one/flow.ts', "const SOURCE = 'OUTER';\nSOURCE;\n"],
  ['inner/two/flow.ts', "const SOURCE = 'INNER';\nSOURCE;\n"],
];
for (let i = 0; i < 22; i++) files.push(['duplicates/' + i.toString().padStart(2, '0') + '/MANY.md', '# Candidate ' + i + '\n']);

const { createHash, randomUUID } = await import('node:crypto');
const coreDb = await lade('packages', 'core', 'dist', 'db', 'client.js');
const pool = coreDb.getPool();
const ci = await lade('packages', 'core', 'dist', 'services', 'code-intel.js');
const close = [];
let rot = 0;
let gruen = 0;
const pruefe = (label, fn) => {
  try { fn(); gruen++; console.log('OK      ' + label); }
  catch (e) { rot++; console.error('FEHLER  ' + label + ': ' + (e?.message || e)); }
};
const pruefeAsync = async (label, fn) => {
  try { await fn(); gruen++; console.log('OK      ' + label); }
  catch (e) { rot++; console.error('FEHLER  ' + label + ': ' + (e?.stack || e)); }
};

const { InMemoryTransport } = await import(pathToFileURL(join(repo, 'packages', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')).href);
const { Client } = await import(pathToFileURL(join(repo, 'packages', 'mcp-server', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')).href);

async function baueStdio() {
  const { createServer } = await lade('packages', 'mcp-server', 'dist', 'server.js');
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'p4-t76', version: '1.0' });
  await client.connect(clientTransport);
  close.push(() => client.close());
  return client;
}
async function baueRest() {
  const { createServer } = await lade('packages', 'rest-api', 'dist', 'server.js');
  const server = await createServer();
  await server.ready();
  close.push(() => server.close());
  let id = 0;
  let session;
  async function rpc(payload) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const response = await server.inject({ method: 'POST', url: '/mcp/messages', headers, payload });
    if (response.statusCode !== 200) throw new Error('MCP HTTP ' + response.statusCode + ': ' + response.body.slice(0, 200));
    if (response.headers['mcp-session-id']) session = response.headers['mcp-session-id'];
    if (String(response.headers['content-type']).includes('text/event-stream')) {
      const data = response.body.split('\n').filter((line) => line.startsWith('data:'));
      return JSON.parse(data[data.length - 1].slice(5).trim());
    }
    return JSON.parse(response.body);
  }
  await rpc({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p4-t76', version: '1.0' } } });
  return {
    server,
    async call(tool, args) {
      const response = await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } });
      const result = response.result;
      return { isError: result?.isError === true, text: result?.content?.[0]?.text || '', structuredContent: result?.structuredContent };
    },
  };
}
function serial(a) { return JSON.stringify(a); }
function assertAmbiguous(result, a, total) {
  const all = serial(result);
  assert.equal(result.isError, true, 'ambiguous lookup must be an MCP tool error');
  assert.ok(all.includes('mehrdeutig'), 'error type must be mehrdeutig');
  assert.ok(all.includes(a), 'candidate list must contain ' + a);
  assert.ok(all.includes(String(total)), 'total candidate count must be reported');
}

try {
  const platzhalter = files.map((_, i) => {
    const n = i * 8;
    return `($${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},0,$${n + 6},$${n + 7},$${n + 8},NOW(),NOW())`;
  }).join(',');
  const parameter = files.flatMap(([filePath, content]) => [
    randomUUID(), project, filePath, filePath.split('/').pop(), filePath.split('.').pop(),
    Buffer.byteLength(content), content, createHash('sha256').update(content).digest('hex'),
  ]);
  await pool.query(
    'INSERT INTO code_files (id, project, file_path, file_name, file_type, chunk_count, file_size, content, content_hash, indexed_at, updated_at) VALUES ' + platzhalter,
    parameter
  );
  await pool.query(
    `INSERT INTO code_statements (project,file_path,scope_type,scope_name,statement_type,node_kind,line_start,line_end,order_index,depth,text,is_top_level,is_awaited)
     VALUES ($1,'outer/one/flow.ts','module',NULL,'assignment','VariableDeclaration',1,1,1,0,'const SOURCE = ''OUTER'';',true,false),
            ($1,'outer/one/flow.ts','module',NULL,'expression','ExpressionStatement',2,2,2,0,'SOURCE;',true,false),
            ($1,'inner/two/flow.ts','module',NULL,'assignment','VariableDeclaration',1,1,1,0,'const SOURCE = ''INNER'';',true,false),
            ($1,'inner/two/flow.ts','module',NULL,'expression','ExpressionStatement',2,2,2,0,'SOURCE;',true,false)`,
    [project]
  );
  console.log('# Fixtures in synapse_test angelegt: ' + files.length + ' Dateien');

  await pruefeAsync('file: exakter README-Pfad hat Vorrang vor tieferem Pfad', async () => {
    const r = await ci.getFileContent(project, 'README.md');
    assert.equal(r.file_path, 'README.md');
    assert.equal(r.content, '# Root README\n');
  });
  await pruefeAsync('file: eindeutiger Suffix liefert den kanonischen Pfad', async () => {
    const r = await ci.getFileContent(project, 'one/UNIQUE.md');
    assert.equal(r.file_path, 'outer/one/UNIQUE.md');
  });
  await pruefeAsync('file: mehrdeutig liefert Kandidaten und Gesamtzahl', async () => {
    await assert.rejects(() => ci.getFileContent(project, 'SHARED.md'), (e) => {
      assert.equal(e.name, 'CodeIntelAmbiguousFilePathError');
      assert.ok(e.message.includes('"anzahl":2'));
      assert.ok(e.message.includes('left/SHARED.md'));
      return true;
    });
  });
  await pruefeAsync('file: Kandidatenliste auf 20 begrenzt, Gesamtzahl bleibt korrekt', async () => {
    await assert.rejects(() => ci.getFileContent(project, 'MANY.md'), (e) => {
      const body = JSON.parse(e.message);
      assert.equal(body.kandidaten.length, 20);
      assert.equal(body.anzahl, 22);
      return true;
    });
  });
  await pruefeAsync('file: % und _ werden als Pfadzeichen behandelt', async () => {
    assert.equal((await ci.getFileContent(project, 'wild%/item.md')).file_path, 'nested/wild%/item.md');
    assert.equal((await ci.getFileContent(project, 'under_score/item.md')).file_path, 'nested/under_score/item.md');
  });
  await pruefeAsync('file: Teilstring ohne Pfadgrenze trifft keine Datei', async () => {
    assert.equal(await ci.getFileContent(project, 'tree/file.js'), null);
  });
  await pruefeAsync('flow: eindeutiger Suffix waehlt nur eine Datei', async () => {
    const r = await ci.getExecutionFlow(project, 'one/flow.ts');
    assert.equal(r.file_path, 'outer/one/flow.ts');
    assert.ok(r.statements.length > 0);
    assert.ok(r.statements.every((s) => s.file_path === 'outer/one/flow.ts'));
    assert.ok(r.statements.some((s) => String(s.text).includes('OUTER')));
    assert.ok(r.statements.every((s) => !String(s.text).includes('INNER')));
  });
  await pruefeAsync('flow: mehrdeutiger Suffix ist ein Fehler statt vermischter Statements', async () => {
    await assert.rejects(() => ci.getExecutionFlow(project, 'flow.ts'), (e) => {
      assert.equal(e.name, 'CodeIntelAmbiguousFilePathError');
      assert.ok(e.message.includes('"anzahl":2'));
      return true;
    });
  });

  const stdio = await baueStdio();
  const rest = await baueRest();
  const agent_id = 'luna-1';
  const fileErrorStdio = await stdio.callTool({ name: 'code_intel', arguments: { action: 'file', project, file_path: 'SHARED.md', agent_id } });
  const fileErrorText = fileErrorStdio.content?.[0]?.text || '';
  await pruefeAsync('stdio: file ambiguity reports candidate list', async () => {
    assertAmbiguous({ isError: fileErrorStdio.isError === true, text: fileErrorText }, 'left/SHARED.md', 2);
  });
  const flowErrorStdio = await stdio.callTool({ name: 'code_intel', arguments: { action: 'flow', project, file_path: 'flow.ts', agent_id } });
  await pruefeAsync('stdio: flow ambiguity reports candidate list', async () => {
    assertAmbiguous({ isError: flowErrorStdio.isError === true, text: flowErrorStdio.content?.[0]?.text || '' }, 'outer/one/flow.ts', 2);
  });
  const fileErrorRest = await rest.call('code_intel', { action: 'file', project, file_path: 'SHARED.md', agent_id });
  await pruefeAsync('REST MCP: file ambiguity reports candidate list', async () => assertAmbiguous(fileErrorRest, 'left/SHARED.md', 2));
  const flowErrorRest = await rest.call('code_intel', { action: 'flow', project, file_path: 'flow.ts', agent_id });
  await pruefeAsync('REST MCP: flow ambiguity reports candidate list', async () => assertAmbiguous(flowErrorRest, 'outer/one/flow.ts', 2));

  const direct = await rest.server.inject({ method: 'GET', url: '/api/projects/' + project + '/code-intel/file?path=SHARED.md' });
  await pruefeAsync('REST endpoint file: Mehrdeutigkeit mit HTTP 409 und Kandidaten', async () => {
    assert.equal(direct.statusCode, 409);
    assert.ok(direct.body.includes('left/SHARED.md'));
    assert.ok(direct.body.includes('"anzahl":2'));
  });
  const directFlow = await rest.server.inject({ method: 'GET', url: '/api/projects/' + project + '/code-intel/flow?file_path=flow.ts' });
  await pruefeAsync('REST endpoint flow: Mehrdeutigkeit mit HTTP 409 und Kandidaten', async () => {
    assert.equal(directFlow.statusCode, 409);
    assert.ok(directFlow.body.includes('outer/one/flow.ts'));
    assert.ok(directFlow.body.includes('"anzahl":2'));
  });
} finally {
  for (const fn of close.reverse()) {
    try { await fn(); }
    catch (error) { console.error('P4-T76 close error: ' + (error?.message || error)); }
  }
  try {
    await pool.query('DELETE FROM code_files WHERE project = $1', [project]);
    await coreDb.closePool();
  } catch (e) { console.error('P4-T76 cleanup error: ' + (e?.message || e)); rot++; }
  await admin.end();
}
console.log('P4-T76: ' + gruen + ' gruen, ' + rot + ' rot');
// MCP-Server halten Hintergrund-Handles offen; Pools und Server sind zuvor geschlossen.
process.exit(rot > 0 ? 1 : 0);
