import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(new URL(join(here, '..', 'dist', 'index.js'), import.meta.url));

const source = [
  '{',
  '  "mcpServers": {',
  '    "example": {',
  '      "command": "node",',
  '      "env": {',
  '        "API_TOKEN": "token-value-private",',
  '        "VISIBLE_SETTING": "keep-visible"',
  '      },',
  '      "headers": {',
  '        "Authorization": "Bearer auth-value-private",',
  '        "x-visible": "keep-header-visible"',
  '      },',
  '      "apiKey": "key-value-private",',
  '      "endpoint": "https://user-name:pass-value-private@example.test/mcp"',
  '    }',
  '  }',
  '}',
].join('\n');

assert.equal(typeof core.istMcpJsonDatei, 'function');
assert.equal(typeof core.maskiereMcpJson, 'function');
assert.equal(typeof core.mcpJsonSicht, 'function');
assert.equal(typeof core.entmaskiereMcpJson, 'function');

assert.equal(core.istMcpJsonDatei('project/.mcp.json'), true);
assert.equal(core.istMcpJsonDatei('project/.mcp.json.backup-20261012'), true);
assert.equal(core.istMcpJsonDatei('project/.mcp.json.example'), false);
assert.equal(core.istMcpJsonDatei('project/mcp.json'), false);

const masked = core.maskiereMcpJson(source);
for (const secret of ['token-value-private', 'Bearer auth-value-private', 'key-value-private', 'user-name:pass-value-private']) {
  assert.equal(masked.includes(secret), false, 'secret leaked: ' + secret);
}
for (const visible of ['"mcpServers"', '"example"', '"command"', '"env"', '"API_TOKEN"', '"headers"', '"Authorization"', '"x-visible"', '"apiKey"', '"endpoint"']) {
  assert.equal(masked.includes(visible), true, 'visible structure/key missing: ' + visible);
}
assert.equal(masked.includes('keep-visible'), false);
assert.equal(masked.includes('keep-header-visible'), false);
assert.match(masked, /"API_TOKEN": "\[WERT\]"/);
assert.match(masked, /"Authorization": "\[WERT\]"/);
assert.match(masked, /"apiKey": "\[WERT\]"/);
assert.match(masked, /https:\/\/\[WERT\]@example\.test\/mcp/);
assert.equal(core.mcpJsonSicht('project/.mcp.json', source), masked);
assert.equal(core.mcpJsonSicht('project/.mcp.json.example', source), source);

const restored = core.entmaskiereMcpJson(masked, source);
assert.equal(restored.inhalt, source, 'masked round-trip must preserve exact original JSON');
const edited = masked.replace('"VISIBLE_SETTING": "[WERT]"', '"VISIBLE_SETTING": "edited-visible"');
const editedRestored = core.entmaskiereMcpJson(edited, source);
assert.equal(JSON.parse(editedRestored.inhalt).mcpServers.example.env.API_TOKEN, 'token-value-private');
assert.equal(JSON.parse(editedRestored.inhalt).mcpServers.example.env.VISIBLE_SETTING, 'edited-visible');
assert.equal(JSON.parse(editedRestored.inhalt).mcpServers.example.endpoint, 'https://user-name:pass-value-private@example.test/mcp');
assert.equal(editedRestored.hinweise.length, 0);
const quote = String.fromCharCode(34);
const editedUrl = masked.replace('/mcp' + quote, '/changed-path' + quote);
const editedUrlRestored = core.entmaskiereMcpJson(editedUrl, source);
assert.equal(JSON.parse(editedUrlRestored.inhalt).mcpServers.example.endpoint, 'https://user-name:pass-value-private@example.test/changed-path');

const diff = [
  '@@ -1,4 +1,4 @@',
  '   ' + quote + 'env' + quote + ': {',
  '-' + '    ' + quote + 'VISIBLE_SETTING' + quote + ': ' + quote + 'old-private-value' + quote,
  '+' + '    ' + quote + 'VISIBLE_SETTING' + quote + ': ' + quote + 'new-private-value' + quote,
  '   },',
  '+' + '  ' + quote + 'endpoint' + quote + ': ' + quote + 'https://user-name:pass-value-private@example.test/mcp' + quote,
].join(String.fromCharCode(10));
const safeDiff = core.maskiereMcpJsonDiffText(diff);
assert.equal(safeDiff.includes('old-private-value'), false);
assert.equal(safeDiff.includes('new-private-value'), false);
assert.equal(safeDiff.includes('user-name:pass-value-private'), false);
assert.equal(safeDiff.includes('VISIBLE_SETTING'), true);
assert.equal(safeDiff.includes('https://[WERT]@example.test/mcp'), true);
const compactDiff = '+' + JSON.stringify({ mcpServers: { x: { env: { VISIBLE_SETTING: 'compact-private-value' } } } });
const safeCompactDiff = core.maskiereMcpJsonDiffText(compactDiff);
assert.equal(safeCompactDiff.includes('compact-private-value'), false);
assert.equal(safeCompactDiff.includes('VISIBLE_SETTING'), true);
assert.equal(safeCompactDiff.includes('[WERT]'), true);

const unknown = core.entmaskiereMcpJson('{"mcpServers":{"x":{"env":{"NEW_TOKEN":"[WERT]"}}}}', '{}');
assert.equal(JSON.parse(unknown.inhalt).mcpServers.x.env.NEW_TOKEN, '[WERT]');
assert.equal(unknown.hinweise.length, 1);
console.log('P15-T41 mcp-json mask tests passed');
