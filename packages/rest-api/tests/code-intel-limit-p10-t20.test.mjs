/** P10-T20: code_intel limit-Weitergabe in stdio und REST; nur synapse_test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.port, '5433', 'nur Test-Instanz');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test');
Object.assign(process.env, {
  SYNAPSE_AUTH_DISABLED: '1',
  QDRANT_URL: 'http://127.0.0.1:9',
  OLLAMA_URL: 'http://127.0.0.1:9',
  PARSER_LOOP_DISABLED: '1',
});
const here = new URL('.', import.meta.url);
const repo = fileURLToPath(new URL('../../..', here));
const load = (...parts) => import(pathToFileURL(join(repo, ...parts)).href);
const { getPool, closePool } = await load('packages/core/dist/db/client.js');
const { codeIntelTool } = await load('packages/mcp-server/dist/tools/consolidated/code-intel.js');
const { createServer } = await load('packages/rest-api/dist/server.js');
// P10-T51 (K3): die MCP-Huelle laesst null-Felder weg; der stdio-Handler liefert das Rohobjekt.
const { kompaktiereToolAntwort, toolAntwortKompaktAktiv } = await load('packages/core/dist/services/tool-antwort.js');
const pool = getPool();
const project = 'test-p10-t20-' + randomUUID();
const functions = ['fn_a', 'fn_b', 'fn_c'];
const variables = ['var_a', 'var_b', 'var_c'];
const statements = ['statement-a', 'statement-b', 'statement-c'];
let server;
let rpcId = 0;
let initialized = false;
let sessionId;

function equalJson(actual, expected, label) {
  const stable = { ...actual };
  delete stable.agentOnboarding;
  delete stable.hinweis_agent_id;
  assert.deepEqual(stable, expected, label);
}
async function restMcp(action, args) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const post = async (payload) => {
    const response = await server.inject({ method: 'POST', url: '/mcp/messages', headers, payload });
    const token = response.headers['mcp-session-id'];
    if (typeof token === 'string' && token) sessionId = token;
    assert.ok([200, 202].includes(response.statusCode), response.body.slice(0, 500));
    if (response.statusCode === 202) return undefined;
    const type = String(response.headers['content-type'] ?? '');
    const body = type.includes('text/event-stream')
      ? JSON.parse(response.body.split('\n').filter(x => x.startsWith('data:')).at(-1).slice(5).trim())
      : JSON.parse(response.body);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body;
  };
  if (!initialized) {
    const response = await post({
      jsonrpc: '2.0', id: ++rpcId, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'p10-t20-limit-test', version: '1.0' } },
    });
    assert.ok(response.result);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    initialized = true;
  }
  const response = await post({
    jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
    params: { name: 'code_intel', arguments: { action, project, agent_id: 'luna-1', ...args } },
  });
  const text = response.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', JSON.stringify(response).slice(0, 500));
  return JSON.parse(text);
}
async function restRoute(action, args = {}) {
  const query = new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)]));
  const response = await server.inject({
    method: 'GET',
    url: '/api/projects/' + project + '/code-intel/' + action + (query.size ? '?' + query.toString() : ''),
  });
  assert.equal(response.statusCode, 200, response.body.slice(0, 500));
  return JSON.parse(response.body);
}

const expectedFunctions = functions.map((name, i) => ({
  id: project + '-fn-' + i,
  file_path: 'fixture.ts',
  name,
  line_start: i + 1,
  line_end: null,
  params: null,
  return_type: null,
  is_exported: true,
  parent_name: null,
  usage_count: 0,
}));
const expectedVariables = variables.map((name, i) => ({
  id: project + '-var-' + i,
  file_path: 'fixture.ts',
  name,
  line_start: i + 10,
  line_end: null,
  is_exported: true,
}));

try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  await pool.query('INSERT INTO projects(name, hostname, path) VALUES($1, $2, $3)', [project, 'p10-t20-test', '/tmp/p10-t20-test']);
  await pool.query(
    'INSERT INTO code_files(id, project, file_path, file_name, file_type, file_size, content, content_hash) VALUES($1,$2,$3,$4,$5,0,$6,$7)',
    [randomUUID(), project, 'fixture.ts', 'fixture.ts', 'ts', '', 'fixture-hash'],
  );
  await pool.query(
    'INSERT INTO code_symbols(id, project, file_path, symbol_type, name, line_start, is_exported) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::bool[])',
    [
      [...functions.map((_, i) => project + '-fn-' + i), ...variables.map((_, i) => project + '-var-' + i)],
      Array(6).fill(project),
      Array(6).fill('fixture.ts'),
      ['function', 'function', 'function', 'variable', 'variable', 'variable'],
      [...functions, ...variables],
      [1, 2, 3, 10, 11, 12],
      Array(6).fill(true),
    ],
  );
  await pool.query(
    'INSERT INTO code_statements(project, file_path, statement_type, line_start, order_index, depth, text) SELECT $1,$2,$3,line_start,order_index,0,text FROM unnest($4::int[], $5::int[], $6::text[]) AS x(line_start,order_index,text)',
    [project, 'fixture.ts', 'expression', [20, 21, 22], [0, 1, 2], statements],
  );

  server = await createServer();
  await server.ready();
  const stdio = (action, args) => codeIntelTool.handler({ action, project, ...args });
  // Golden aus dem alten Stand zuerst: ohne limit bleiben Listen und Antwortfelder gleich.
  for (const [name, run] of [['stdio', stdio], ['REST-MCP', restMcp]]) {
    const fn = await run('functions', {});
    const vars = await run('variables', {});
    // Golden bleibt der Altwert; ueber die MCP-Huelle gilt die freigegebene Regel (null-Felder entfallen).
    const erwartet = (wert) => (name === 'REST-MCP' && toolAntwortKompaktAktiv() ? kompaktiereToolAntwort(wert, 'code_intel') : wert);
    equalJson(fn, erwartet({ success: true, functions: expectedFunctions, count: 3, project }), name + ' Golden functions ohne limit (Altverhalten)');
    equalJson(vars, erwartet({ success: true, variables: expectedVariables, count: 3, project }), name + ' Golden variables ohne limit (Altverhalten)');
  }
  for (const [action, field] of [['functions', 'functions'], ['variables', 'variables'], ['statements', 'statements']]) {
    const args = action === 'statements' ? { file_path: 'fixture.ts' } : {};
    const [limitedStdio, limitedRest, limitedRoute] = await Promise.all([
      stdio(action, { ...args, limit: 1 }),
      restMcp(action, { ...args, limit: 1 }),
      restRoute(action, { ...args, limit: 1 }),
    ]);
    for (const [name, answer] of [['stdio', limitedStdio], ['REST-MCP', limitedRest], ['REST-Route', limitedRoute]]) {
      assert.equal(answer[field].length, 1, action + ' ' + name + ' limit:1 muss ein Ergebnis liefern');
      assert.equal(answer.count, 1, action + ' ' + name + ' count muss die Rueckgabezahl sein');
    }
  }
  for (const [action, field, expected] of [
    ['functions', 'functions', expectedFunctions],
    ['variables', 'variables', expectedVariables],
  ]) {
    const answer = await restRoute(action);
    equalJson(answer, { success: true, [field]: expected, count: 3 }, 'REST-Route Golden ' + action + ' ohne limit (Altverhalten)');
  }
  console.log('OK P10-T20: Positivkontrolle/Limit fuer stdio+REST, Golden ohne limit fuer functions+variables');
} finally {
  if (server) await server.close().catch(() => {});
  await pool.query('DELETE FROM projects WHERE name=$1', [project]).catch(() => {});
  await closePool().catch(() => {});
}
