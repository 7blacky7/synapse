import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./chat-send.mjs', import.meta.url));
const mockSource = `
import { appendFile } from 'node:fs/promises';
globalThis.fetch = async (input, options = {}) => {
  await appendFile(process.env.TEST_CHAT_CAPTURE, JSON.stringify({
    url: String(input),
    method: options.method,
    headers: Object.fromEntries(new Headers(options.headers)),
    body: JSON.parse(options.body),
  }) + '\\n');
  const status = Number(process.env.TEST_CHAT_HTTP_STATUS || 200);
  if (status === 0) throw new TypeError('fetch failed');
  return new Response(JSON.stringify(status === 200
    ? { jsonrpc: '2.0', id: 1, result: { structuredContent: { id: 42, project: 'test-chat', senderId: 'luna-2', recipientId: null } } }
    : { error: { message: 'unauthorized' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
};
`;
const tempHomes = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function runCli({ token = '', configToken = 'config-token', status = 200 } = {}, args = ['test-chat', 'luna-2', 'hello']) {
  const home = await mkdtemp(join(tmpdir(), 'synapse-chat-send-'));
  tempHomes.push(home);
  const configDir = join(home, '.synapse', 'file-watcher');
  await mkdir(configDir, { recursive: true });
  const capture = join(home, 'request.jsonl');
  const mock = join(home, 'mock-fetch.mjs');
  await writeFile(join(configDir, 'config.json'), JSON.stringify({
    synapse_api_url: 'https://api.test',
    synapse_api_token: configToken,
  }));
  await writeFile(mock, mockSource);
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      SYNAPSE_API_TOKEN: token,
      SYNAPSE_API_FALLBACK_URL: 'https://fallback.test',
      NODE_OPTIONS: `--import=${mock}`,
      TEST_CHAT_CAPTURE: capture,
      TEST_CHAT_HTTP_STATUS: String(status),
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      PGDATABASE: 'synapse_test',
    },
  });
  let requests = [];
  try {
    const lines = (await readFile(capture, 'utf8')).trim().split('\n');
    requests = lines.map(line => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Erwartet bei der RED-Probe: Das alte PG-Skript ruft fetch nicht auf.
  }
  return { ...result, requests, request: requests[0] };
}

test('sendet Broadcast über chat(send), mit Env-Token-Override', async () => {
  const result = await runCli({ token: 'override-token' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.request.url, 'https://api.test/mcp/messages');
  assert.equal(result.request.method, 'POST');
  assert.equal(result.request.headers.authorization, 'Bearer override-token');
  assert.deepEqual(result.request.body.params, {
    name: 'chat',
    arguments: { action: 'send', project: 'test-chat', sender_id: 'luna-2', content: 'hello' },
  });
});

test('erhält DM-Empfänger und nutzt Config-Token', async () => {
  const result = await runCli({}, ['test-chat', 'luna-2', 'hello', 'sol-1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.request.headers.authorization, 'Bearer config-token');
  assert.equal(result.request.body.params.arguments.recipient_id, 'sol-1');
});

test('meldet HTTP-Fehler und liefert Exitcode ungleich null', async () => {
  const result = await runCli({ status: 401 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 401/);
  assert.equal(result.requests.length, 1);
});

test('meldet Unerreichbarkeit und prueft die Fallback-Reihenfolge', async () => {
  const result = await runCli({ status: 0 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synapse-API nicht erreichbar/);
  assert.deepEqual(result.requests.map(request => request.url), [
    'https://api.test/mcp/messages',
    'https://synapse.moosynapse.org/mcp/messages',
    'https://fallback.test/mcp/messages',
  ]);
});
