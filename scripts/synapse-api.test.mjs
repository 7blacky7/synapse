import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const helperUrl = pathToFileURL(new URL('./synapse-api.mjs', import.meta.url).pathname).href;
const tempHomes = [];

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'synapse-api-test-'));
  tempHomes.push(home);
  const dir = join(home, '.synapse', 'file-watcher');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    synapse_api_url: 'https://api.test/',
    synapse_api_token: 'config-token',
  }));
  return home;
}

test('gemeinsamer Client liest Konfiguration und ruft MCP-Tool mit Bearer auf', async () => {
  const home = await setup();
  const { loadApiConfig, callMcpTool } = await import(helperUrl);
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { structuredContent: { success: true, messages: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = await loadApiConfig({ home, env: {} });
  const result = await callMcpTool(config, 'event', { action: 'pending', project: 'test', agent_id: 'luna-2' }, { fetchImpl });
  assert.equal(request.url, 'https://api.test/mcp/messages');
  assert.equal(request.options.headers.Authorization, 'Bearer config-token');
  assert.deepEqual(JSON.parse(request.options.body).params, {
    name: 'event',
    arguments: { action: 'pending', project: 'test', agent_id: 'luna-2' },
  });
  assert.deepEqual(result, { success: true, messages: [] });
});

test('SYNAPSE_API_URL überschreibt die Config-URL, der Env-Token hat Vorrang und API-Fehler werden lesbar gemeldet', async () => {
  const home = await setup();
  const { loadApiConfig, callMcpTool } = await import(helperUrl);
  const config = await loadApiConfig({ home, env: { SYNAPSE_API_URL: 'https://override.test/', SYNAPSE_API_TOKEN: 'override-token' } });
  let authorization;
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), 'https://override.test/mcp/messages');
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };
  await assert.rejects(
    callMcpTool(config, 'event', { action: 'pending' }, { fetchImpl }),
    /HTTP 401.*unauthorized/,
  );
  assert.equal(authorization, 'Bearer override-token');
});
