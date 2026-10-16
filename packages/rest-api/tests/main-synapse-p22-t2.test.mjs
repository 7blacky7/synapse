/**
 * P22-T2 W0b — nur Fake-PG und Fastify.inject, kein Container/Modell/Browserstart.
 * Aus Repo-Root nach Builds: node --test packages/rest-api/tests/main-synapse-p22-t2.test.mjs
 * Basis-Rotkontrolle: dieselbe Datei mit SYNAPSE_P22_T2_DIST_ROOT=/tmp/synapse-basis-e8e6987e
 * ausführen; --test-name-pattern="Variante A lässt shell" prüft Verhalten, kein fehlender Export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '../../..');
const distRoot = process.env.SYNAPSE_P22_T2_DIST_ROOT || repo;
const lade = p => import(pathToFileURL(resolve(distRoot, p)).href);
process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5433/synapse_test';
delete process.env.SYNAPSE_AUTH_DISABLED;
delete process.env.SYNAPSE_MAIN_SYNAPSE;
process.env.SYNAPSE_INTERN_TOOL = '1';
const Fastify = createRequire(resolve(repo, 'packages/rest-api/package.json'))('fastify');
const core = await lade('packages/core/dist/index.js');
const { mcpRoutes } = await lade('packages/rest-api/dist/routes/mcp.js');
const { registerAuthHook } = await lade('packages/rest-api/dist/middleware/auth-hook.js');
const pool = core.getPool();
const echteQuery = pool.query;
const session = 'a0000000-0000-4000-8000-000000000002';
const scope = 'hauptagent:main-synapse:' + session;
const key = 'fake-session-key';
let mainRevoked = false;
let schalter = null;
const ausweis = () => ({
  kind: 'service', scope, token_hash: 'fake-hash',
  expires_at: new Date(Date.now() + 3600000),
});
const queryLog = [];
pool.query = async (sql, values = []) => {
  queryLog.push({ sql, values });
  if (/auth_tokens/.test(sql)) {
    // Auch Widerruf im laufenden Gespräch, nicht nur beim Start.
    return { rows: mainRevoked ? [] : [ausweis()], rowCount: mainRevoked ? 0 : 1 };
  }
  if (/INSERT INTO intern_schalter/.test(sql)) {
    schalter = { name: values[0], aktiv: values[1], modus: values[2], bis: values[3],
      grund: values[4], gesetzt_von: values[5], gesetzt_am: new Date() };
    return { rows: [schalter], rowCount: 1 };
  }
  if (/FROM intern_schalter/.test(sql)) return { rows: schalter ? [schalter] : [] };
  if (/FROM agent_runtime_sessions/.test(sql)) {
    return { rows: values[0] === session ? [{ id: session }] : [] };
  }
  return { rows: [], rowCount: 0 };
};
const headers = {
  authorization: 'Bearer ' + key,
  'x-synapse-hauptagent-session': session,
  'x-synapse-werkzeugprofil': 'main-synapse',
};
const server = Fastify({ logger: false });
registerAuthHook(server);
await server.register(mcpRoutes);
await server.ready();
test.after(async () => { await server.close(); pool.query = echteQuery; await core.closePool(); });
const rpc = async (url, method, params, h = headers) => {
  const r = await server.inject({ method: 'POST', url, headers: h,
    payload: { jsonrpc: '2.0', id: 1, method, params } });
  return { status: r.statusCode, body: r.json() };
};
const datum = () => new Date(Date.now() + 60000);
const einschalten = () => { schalter = { name: 'main_synapse', aktiv: true, modus: 'freigegeben',
  bis: datum(), gesetzt_am: new Date(), grund: 'Fake-Probe', gesetzt_von: 'p22-t2' }; };
const daten = r => r.body.result?.structuredContent
  ?? JSON.parse(r.body.result?.content?.find(c => c.type === 'text')?.text ?? '{}');

// Muss gegen t105 an einer fehlenden WIRKUNG rot sein, bevor neue Helfer importiert werden.
test('Variante A lässt shell im serverseitigen Inventar beider MCP-Wege zu', async () => {
  einschalten();
  for (const url of ['/', '/mcp/messages']) {
    const r = await rpc(url, 'tools/list');
    assert.equal(r.status, 200);
    const names = r.body.result.tools.map(t => t.name);
    for (const name of ['shell', 'code_intel', 'docs', 'files', 'asset_intel', 'skills', 'specialist', 'artefakt']) {
      assert.ok(names.includes(name), url + ': ' + name + ' fehlt bei freigegebener Variante A');
    }
    for (const name of ['intern', 'Bash', 'Write', 'Edit', 'Agent', 'Task']) assert.ok(!names.includes(name));
  }
});

test('Standard AUS und Legacyprofil unverändert, Header allein reicht nicht', async () => {
  schalter = null;
  for (const url of ['/', '/mcp/messages']) {
    // Legacy-Key wird von der Fake-PG als legacy statt als neuer gebundener Scope geliefert.
    const queryVorher = pool.query;
    pool.query = async (sql, values) => /auth_tokens/.test(sql)
      ? { rows: [{ ...ausweis(), scope: 'hauptagent:claude' }] } : queryVorher(sql, values);
    try {
      const legacy = { authorization: 'Bearer legacy', 'x-synapse-hauptagent-session': session };
      const list = await rpc(url, 'tools/list', undefined, legacy);
      assert.deepEqual(list.body.result.tools.map(t => t.name), ['artefakt']);
      const blocked = await rpc(url, 'tools/call', { name: 'shell', arguments: { action: 'exec' } }, legacy);
      assert.equal(daten(blocked).error, 'hauptagent_nur_artefakt');
      einschalten();
      const forged = await rpc(url, 'tools/call', { name: 'shell', arguments: {} },
        { ...legacy, 'x-synapse-werkzeugprofil': 'main-synapse' });
      assert.equal(daten(forged).error, 'main_session_nicht_autorisiert');
    } finally { pool.query = queryVorher; }
  }
});

test('Sessiongrenze, Widerruf und agent_id werden auch beim Aufruf geprüft', async () => {
  einschalten();
  for (const url of ['/', '/mcp/messages']) {
    const noHeader = await rpc(url, 'tools/list', undefined, { authorization: headers.authorization });
    assert.equal(noHeader.status, 401, 'gebundener Scope wird nie allgemeiner Legacyzugang');
    const wrongSession = await rpc(url, 'tools/list', undefined,
      { ...headers, 'x-synapse-hauptagent-session': 'anderer-run' });
    assert.equal(wrongSession.status, 401);
    const id = await rpc(url, 'tools/call', { name: 'shell', arguments: { agent_id: 'koordinator' } });
    assert.equal(daten(id).error, 'main_agent_id_abweichend');
    const intern = await rpc(url, 'tools/call', { name: 'intern', arguments: { action: 'schalter_setzen' } });
    assert.equal(daten(intern).error, 'main_werkzeug_nicht_freigegeben');
    mainRevoked = true;
    try { assert.equal((await rpc(url, 'tools/list')).status, 401); }
    finally { mainRevoked = false; }
  }
});

test('Ablauf/Intern-Aus/Lesefehler fallen auf Produktionsbasis, Basis EIN braucht kein intern', async () => {
  const p = await lade('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  einschalten();
  const stand = (await core.alleSchalter()).find(s => s.name === 'main_synapse');
  assert.equal(p.entscheideMainProfil({}, stand).profile, 'artefakt-only');
  assert.equal(p.entscheideMainProfil({ SYNAPSE_INTERN_TOOL: '1' }, stand).profile, 'main-synapse');
  assert.equal(p.entscheideMainProfil({ SYNAPSE_INTERN_TOOL: '1' }, stand, Date.now() + 120000).profile, 'artefakt-only');
  assert.equal(p.entscheideMainProfil({ SYNAPSE_MAIN_SYNAPSE: '1' }, stand).profile, 'main-synapse');
  const disabled = { ...stand, aktiv: false, gesetzt: false };
  assert.equal(p.entscheideMainProfil({ SYNAPSE_MAIN_SYNAPSE: '1', SYNAPSE_INTERN_TOOL: '1' }, disabled).profile, 'artefakt-only');
  assert.equal(p.entscheideMainProfil({ SYNAPSE_MAIN_SYNAPSE: '1', SYNAPSE_INTERN_TOOL: '1' }, disabled, Date.now() + 120000).profile, 'main-synapse');
  const q = pool.query;
  pool.query = async () => { throw new Error('Fake-Ausfall'); };
  try {
    assert.equal((await p.leseMainProfil()).profile, 'artefakt-only');
    process.env.SYNAPSE_MAIN_SYNAPSE = '1';
    assert.equal((await p.leseMainProfil()).profile, 'main-synapse');
  } finally { pool.query = q; delete process.env.SYNAPSE_MAIN_SYNAPSE; }
});

test('intern/main_synapse befristet EIN und AUS und behält Diagnose nach erneutem Lesen', async () => {
  for (const aktiv of [true, false]) {
    const result = await core.setzeSchalter('main_synapse', { aktiv, grund: 'P22-T2 Fake', agent: 'p22-t2' });
    assert.equal(result.modus, 'freigegeben');
    assert.ok(Date.parse(result.bis) > Date.now());
    assert.ok(Date.parse(result.bis) <= Date.now() + 12 * 3600000 + 1000);
    const wieder = (await core.alleSchalter()).find(s => s.name === 'main_synapse');
    assert.equal(wieder.gesetzt, aktiv);
    assert.equal(wieder.gesetzt_am, result.gesetzt_am);
  }
});

test('CLI-Profil A entfernt alle Builtins und behält MCP, dontAsk und resume', async () => {
  const { buildClaudeCommand, buildHauptagentMcpConfig } = await lade('packages/rest-api/dist/services/agent-runtime/claude-driver.js');
  const cfg = buildHauptagentMcpConfig('http://fake-api/', 'fake', session, 'main-synapse');
  const command = buildClaudeCommand('thread-1', 'sonnet', cfg, 'main-synapse');
  assert.equal(command[command.indexOf('--tools') + 1], '');
  assert.equal(command[command.indexOf('--allowedTools') + 1], 'mcp__synapse__*');
  assert.equal(command[command.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(command.includes('--safe-mode'), false, 'safe-mode schaltet MCP ab');
  assert.ok(command.includes('--strict-mcp-config'));
  assert.deepEqual(command.slice(-2), ['--resume', 'thread-1']);
  assert.equal(JSON.parse(cfg).mcpServers.synapse.headers['X-Synapse-Werkzeugprofil'], 'main-synapse');
  const oldCfg = buildHauptagentMcpConfig('http://fake-api/', 'fake', session);
  assert.equal(buildClaudeCommand(null, 'sonnet', oldCfg).at(-3), 'mcp__synapse__artefakt');
  assert.equal(JSON.parse(oldCfg).mcpServers.synapse.headers['X-Synapse-Werkzeugprofil'], undefined);
});

test('Kind ohne eigenen Ausweis und eigenes bestätigtes Profil bekommt keine implizite Freigabe', async () => {
  const p = await lade('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  const d = { stand: async () => p.entscheideMainProfil({ SYNAPSE_MAIN_SYNAPSE: '1' }),
    token: async () => ausweis(), session: async id => id === session };
  const child = await p.mainToolAccess({ ...headers, 'x-synapse-hauptagent-session': 'child-session' }, d);
  assert.equal(child.error, 'main_session_nicht_autorisiert');
  assert.equal(p.mainToolAblehnung('files', { agent_id: 'child' }, child, [{ name: 'files' }]), child.error);
  const noAuth = await p.mainToolAccess({ ...headers, authorization: undefined }, d);
  assert.equal(noAuth.error, 'main_session_nicht_autorisiert');
});

test('Profilgrenze lässt Browser-, Bild-, Skill- und Datei-Probe unverändert zum Fachwerkzeug durch', async () => {
  const p = await lade('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  const access = { profile: 'main-synapse', sessionId: session, agentId: 'main-' + session };
  const inventory = ['shell', 'asset_intel', 'skills', 'code_intel', 'docs', 'files', 'specialist']
    .map(name => ({ name }));
  const workload = [
    ['specialist', { action: 'spawn', project: 'p22_t2_fixture', name: 'vorhandener-freigegebener-agent' }],
    ['shell', { action: 'exec', project: 'p22_t2_fixture',
      command: "curl -sS -X POST http://192.168.50.65:9222/tabs/new -H 'Content-Type: application/json' -d '{\"active\":false}'" }],
    ['shell', { action: 'exec', project: 'p22_t2_fixture',
      command: "curl -sS -X POST http://192.168.50.65:9222/navigate -H 'Content-Type: application/json' -d '{\"tab_id\":\"eigener-tab\",\"url\":\"https://example.test/quelle\"}'" }],
    ['shell', { action: 'exec', project: 'p22_t2_fixture',
      command: "curl -sS -X POST http://192.168.50.65:9222/evaluate -H 'Content-Type: application/json' -d '{\"tab_id\":\"eigener-tab\",\"script\":\"document.readyState\"}'" }],
    ['shell', { action: 'exec', project: 'p22_t2_fixture',
      command: 'curl -sS "http://192.168.50.65:9222/screenshot?tab_id=eigener-tab&format=png"' }],
    ['shell', { action: 'exec', project: 'p22_t2_fixture',
      command: "curl -sS -X POST http://192.168.50.65:9222/tabs/close -H 'Content-Type: application/json' -d '{\"tab_id\":\"eigener-tab\"}'" }],
    ['asset_intel', { action: 'inspect', project: 'p22_t2_fixture', file_path: 'synthetisch.png', ansicht: 'inline' }],
    ['skills', { action: 'get_section', skill_name: 'p22-fixture', section: 'anwendung' }],
    ['code_intel', { action: 'file', project: 'p22_t2_fixture', file_path: 'probe.ts' }],
    ['docs', { action: 'get_for_file', project: 'p22_t2_fixture', file_path: 'probe.ts', memories: true }],
    ['files', { action: 'reservation_add', project: 'p22_t2_fixture', file_path: 'probe.ts' }],
    ['files', { action: 'plan', project: 'p22_t2_fixture', task_id: 'p22-t2-fixture',
      ops: [{ action: 'search_replace', file_path: 'probe.ts', search: 'alt', replace: 'neu', reason: 'Probe' }] }],
    ['files', { action: 'commit', project: 'p22_t2_fixture', task_id: 'p22-t2-fixture', plan_id: 'fake-plan' }],
  ];
  // Fake-Fach-API: testet nur die NEUE Profilgrenze. Bestehende Shell-/Datei-/Quota-
  // Sicherungen werden weder implementiert noch umgangen. Echte W3-E2E bleibt gesondert.
  const received = [];
  const image = { type: 'image', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=' };
  const fakeApi = async (name, args) => {
    const error = p.mainToolAblehnung(name, args, access, inventory);
    if (error) return { isError: true, error };
    received.push({ name, args: structuredClone(args) });
    if (name === 'asset_intel') return { content: [image] };
    if (name === 'specialist') return { success: false, error: 'quota_0' };
    if (name === 'files' && args.action === 'commit') return { version_id: 'fake-version', batch_id: 'fake-plan' };
    return { success: true };
  };
  for (const [name, args] of workload) {
    const r = await fakeApi(name, args);
    assert.notEqual(r.isError, true, name + ' wird an der Profilgrenze abgewiesen');
    if (name === 'asset_intel') assert.deepEqual(r.content, [image], 'echter Bildblock bleibt erhalten');
    if (name === 'specialist') assert.equal(r.error, 'quota_0', 'Profil überstimmt Quota-Ablehnung nicht');
    if (name === 'files' && args.action === 'commit') assert.equal(r.version_id, 'fake-version');
  }
  assert.deepEqual(received, workload.map(([name, args]) => ({ name, args })), 'keine Umformung von Befehlen, task_id oder Fachargumenten');
  for (const name of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent', 'Task']) {
    assert.equal((await fakeApi(name, {})).error, 'main_werkzeug_nicht_freigegeben');
  }
});

test('MCP-Ausweis ist auch über REST und SSE kein Userterminal-Zugang', async () => {
  for (const url of ['/api/agent-runtimes/claude/terminal/sessions', '/api/status']) {
    const r = await server.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(r.statusCode, 401);
  }
  const r = await server.inject({
    method: 'GET',
    url: '/api/agent-runtimes/claude/terminal/sessions/fixture/events?sse_token=' + key,
  });
  assert.equal(r.statusCode, 401);
});
