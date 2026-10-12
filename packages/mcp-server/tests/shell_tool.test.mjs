// Direkt-Test fuer shellTool.handler
// Deckt: exec ok, timeout → stream_id, get_stream, unknown_project,
//        project_inactive (Mock Daemon).

import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const testDb = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(testDb.port, '5433', 'shell_tool.test.mjs darf nur gegen Port 5433 laufen');
assert.equal(testDb.pathname, '/synapse_test', 'shell_tool.test.mjs darf nur gegen synapse_test laufen');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-tool-home-'));
process.env.HOME = TEST_HOME;

// Schutz gegen versehentliches Ueberschreiben des laufenden lokalen Daemons.
const echterPortPfad = path.join(os.homedir(), '.synapse', 'file-watcher', 'daemon.port');
if (fs.existsSync(echterPortPfad)) {
  const echterPort = Number(fs.readFileSync(echterPortPfad, 'utf8').trim());
  if (Number.isInteger(echterPort) && echterPort > 0 && echterPort <= 65535) {
    try {
      const health = await fetch(`http://127.0.0.1:${echterPort}/health`, { signal: AbortSignal.timeout(500) });
      if (health.ok) {
        console.error('ABBRUCH: Ein laufender FileWatcher-Daemon wurde erkannt; shell_tool.test.mjs nicht gegen sein HOME ausfuehren.');
        process.exit(2);
      }
    } catch { /* kein erreichbarer Daemon */ }
  }
}

const TEST_DAEMON_HOME = path.join(TEST_HOME, '.synapse', 'file-watcher');
process.env.SYNAPSE_DAEMON_HOME = TEST_DAEMON_HOME;
const { shellTool } = await import('../dist/tools/consolidated/shell.js');
const { registerProject, upsertDaemonHeartbeat, clearDaemonHeartbeat, getPool } = await import('@synapse/core');

// ---------- Helpers ----------

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// Minimaler Mock-Daemon, der auf /projects/:name/status antwortet.
function startMockDaemon(responder) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const r = responder(req.url ?? '');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function writeDaemonPort(port) {
  fs.mkdirSync(TEST_DAEMON_HOME, { recursive: true });
  fs.writeFileSync(path.join(TEST_DAEMON_HOME, 'daemon.port'), String(port));
}

// registerProject aus @synapse/core schreibt in PostgreSQL (hostname-scoped).

// ---------- Setup ----------

const TEST_PROJECT = `shell-tool-${randomUUID()}`;
const TMP_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-tool-project-'));
fs.writeFileSync(path.join(TMP_PROJECT, 'readme.txt'), 'hallo\nwelt\n');
await registerProject(TEST_PROJECT, TMP_PROJECT);

let mockState = { enabled: true };
const { srv: mockDaemon, port: MOCK_PORT } = await startMockDaemon((url) => {
  if (url.includes('/status')) {
    return { status: 200, body: { enabled: mockState.enabled, name: TEST_PROJECT } };
  }
  return { status: 404, body: { error: 'not found' } };
});
writeDaemonPort(MOCK_PORT);
await upsertDaemonHeartbeat(TEST_PROJECT, 'shell-tool-mock', process.pid);

const results = { pass: 0, fail: 0 };
function test(name, fn) {
  return fn().then(() => {
    console.log(`PASS ${name}`);
    results.pass++;
  }).catch((err) => {
    console.log(`FAIL ${name}: ${err.message}`);
    results.fail++;
  });
}

// ---------- Tests ----------

// Negativkontrolle: Ohne Heartbeat muss Auto-Routing den Workspace-Pfad waehlen.
const ohneHeartbeat = parse(await shellTool.handler({
  action: 'exec', project: `shell-tool-no-heartbeat-${randomUUID()}`, command: 'echo x',
}));
assert.equal(ohneHeartbeat.error, 'workspace_unavailable');
console.error('PASS negative-control-without-heartbeat');

await test('1-unknown_project', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'gibts_nicht', command: 'echo x', target: 'local',
  }));
  assert.equal(r.error, 'unknown_project');
});

await test('2-exec-simple-ok', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: TEST_PROJECT, command: 'cat readme.txt',
  }));
  assert.equal(r.status, 'done');
  assert.equal(r.exit_code, 0);
  assert.ok(r.tail.some(l => l.includes('hallo')), 'tail should contain "hallo"');
});

await test('3-exec-ls-files', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: TEST_PROJECT, command: 'ls',
  }));
  assert.equal(r.status, 'done');
  assert.ok(r.tail.some(l => l.includes('readme.txt')));
});

await test('4-exec-cwd-outside-blocked', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: TEST_PROJECT, command: 'pwd',
    cwd_relative: '../etc',
  }));
  assert.equal(r.error, 'cwd_outside_project');
});

await test('5-project-inactive', async () => {
  mockState.enabled = false;
  const r = parse(await shellTool.handler({
    action: 'exec', project: TEST_PROJECT, command: 'echo x',
  }));
  assert.equal(r.error, 'project_inactive');
  assert.equal(r.reason, 'disabled');
  mockState.enabled = true;
});

await test('6-exec-timeout-returns-stream_id', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: TEST_PROJECT,
    command: 'for i in 1 2 3 4 5; do echo line-$i; sleep 0.2; done',
    timeout_ms: 300,
  }));
  assert.equal(r.status, 'hard_limit');
  assert.ok(r.stream_id, 'stream_id must be present');
  assert.ok(Array.isArray(r.tail));

  // get_stream-Folgecall: mehr Zeilen + eventual done
  await new Promise(res => setTimeout(res, 1500));
  const s = parse(await shellTool.handler({
    action: 'get_stream', stream_id: r.stream_id, tail_lines: 10,
  }));
  assert.ok(['done', 'running', 'failed'].includes(s.status), 'status enum');
  assert.ok(s.total_bytes > 0);
});

await test('7-get_stream-unknown', async () => {
  const r = parse(await shellTool.handler({
    action: 'get_stream', stream_id: 'doesnotexist',
  }));
  assert.equal(r.error, 'unknown_stream');
});

await test('8-tail_lines-respected', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: TEST_PROJECT,
    command: 'for i in 1 2 3 4 5 6 7; do echo z-$i; done',
    tail_lines: 3,
  }));
  assert.equal(r.tail.length, 3);
  assert.ok(r.tail[2].includes('z-7'));
});

// ---------- Cleanup ----------

await new Promise((resolve) => mockDaemon.close(resolve));
await clearDaemonHeartbeat(TEST_PROJECT);
await getPool().query('DELETE FROM projects WHERE name = $1 AND hostname = $2', [TEST_PROJECT, os.hostname()]);
fs.rmSync(TMP_PROJECT, { recursive: true, force: true });
fs.rmSync(TEST_DAEMON_HOME, { recursive: true, force: true });
fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\n${results.pass} bestanden, ${results.fail} fehlgeschlagen`);
process.exit(results.fail > 0 ? 1 : 0);
