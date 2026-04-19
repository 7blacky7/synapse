// Direkt-Test fuer shellTool.handler
// Deckt: exec ok, timeout → stream_id, get_stream, unknown_project,
//        project_inactive (Mock Daemon).

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

const { shellTool } = await import('../dist/tools/consolidated/shell.js');
const { registerProject } = await import('@synapse/core');

// ---------- Helpers ----------

function parse(result) {
  return JSON.parse(result.content[0].text);
}

// Minimaler Mock-Daemon, der auf /projects/:name/status antwortet.
function startMockDaemon(port, responder) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const r = responder(req.url ?? '');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function writeDaemonPort(port) {
  const dir = path.join(os.homedir(), '.synapse', 'file-watcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'daemon.port'), String(port));
}

// registerProject aus @synapse/core schreibt in PostgreSQL (hostname-scoped).

// ---------- Setup ----------

const TMP_PROJECT = '/tmp/shell_tool_test_project';
fs.rmSync(TMP_PROJECT, { recursive: true, force: true });
fs.mkdirSync(TMP_PROJECT, { recursive: true });
fs.writeFileSync(path.join(TMP_PROJECT, 'readme.txt'), 'hallo\nwelt\n');
await registerProject('shelltest', TMP_PROJECT);

const MOCK_PORT = 17879;
writeDaemonPort(MOCK_PORT);

let mockState = { enabled: true };
const mockDaemon = await startMockDaemon(MOCK_PORT, (url) => {
  if (url.includes('/status')) {
    return { status: 200, body: { enabled: mockState.enabled, name: 'shelltest' } };
  }
  return { status: 404, body: { error: 'not found' } };
});

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

await test('1-unknown_project', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'gibts_nicht', command: 'echo x',
  }));
  assert.equal(r.error, 'unknown_project');
});

await test('2-exec-simple-ok', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'shelltest', command: 'cat readme.txt',
  }));
  assert.equal(r.status, 'done');
  assert.equal(r.exit_code, 0);
  assert.ok(r.tail.some(l => l.includes('hallo')), 'tail should contain "hallo"');
});

await test('3-exec-ls-files', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'shelltest', command: 'ls',
  }));
  assert.equal(r.status, 'done');
  assert.ok(r.tail.some(l => l.includes('readme.txt')));
});

await test('4-exec-cwd-outside-blocked', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'shelltest', command: 'pwd',
    cwd_relative: '../etc',
  }));
  assert.equal(r.error, 'cwd_outside_project');
});

await test('5-project-inactive', async () => {
  mockState.enabled = false;
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'shelltest', command: 'echo x',
  }));
  assert.equal(r.error, 'project_inactive');
  assert.equal(r.reason, 'disabled');
  mockState.enabled = true;
});

await test('6-exec-timeout-returns-stream_id', async () => {
  const r = parse(await shellTool.handler({
    action: 'exec', project: 'shelltest',
    command: 'for i in 1 2 3 4 5; do echo line-$i; sleep 0.2; done',
    timeout_ms: 300,
  }));
  assert.equal(r.status, 'running');
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
    action: 'exec', project: 'shelltest',
    command: 'for i in 1 2 3 4 5 6 7; do echo z-$i; done',
    tail_lines: 3,
  }));
  assert.equal(r.tail.length, 3);
  assert.ok(r.tail[2].includes('z-7'));
});

// ---------- Cleanup ----------

mockDaemon.close();
console.log(`\n${results.pass} bestanden, ${results.fail} fehlgeschlagen`);
process.exit(results.fail > 0 ? 1 : 0);
