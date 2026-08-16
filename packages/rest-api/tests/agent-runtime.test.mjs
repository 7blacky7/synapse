import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodexCommand,
  cumulativeTextDelta,
  parseCodexJsonLine,
  persistentRuntimeBinds,
  validateRuntimeImage,
  validateRuntimeRoot,
} from '../dist/services/agent-runtime/codex-driver.js';

test('Runtime-Root bleibt innerhalb der konfigurierten Allowlist', () => {
  const previous = process.env.AGENT_RUNTIME_ALLOWED_ROOTS;
  process.env.AGENT_RUNTIME_ALLOWED_ROOTS = '/mnt/user,/srv/synapse';
  try {
    assert.equal(validateRuntimeRoot('/mnt/user/synapse-agent-runtime/codex/'), '/mnt/user/synapse-agent-runtime/codex');
    assert.equal(validateRuntimeRoot('/srv/synapse/codex'), '/srv/synapse/codex');
    assert.throws(() => validateRuntimeRoot('relative/path'), /absoluter Pfad/);
    assert.throws(() => validateRuntimeRoot('/mnt/user/../etc'), /Traversal/);
    assert.throws(() => validateRuntimeRoot('/etc/synapse'), /ausserhalb/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUNTIME_ALLOWED_ROOTS;
    else process.env.AGENT_RUNTIME_ALLOWED_ROOTS = previous;
  }
});

test('Runtime-Image bleibt innerhalb der konfigurierten Allowlist', () => {
  const previous = process.env.AGENT_RUNTIME_ALLOWED_IMAGES;
  process.env.AGENT_RUNTIME_ALLOWED_IMAGES = 'node:22-bookworm-slim,registry.local/codex@sha256:abc';
  try {
    assert.equal(validateRuntimeImage('node:22-bookworm-slim'), 'node:22-bookworm-slim');
    assert.throws(() => validateRuntimeImage('node:latest'), /nicht in/);
    assert.throws(() => validateRuntimeImage('node latest'), /gueltige/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUNTIME_ALLOWED_IMAGES;
    else process.env.AGENT_RUNTIME_ALLOWED_IMAGES = previous;
  }
});

test('Persistente Runtime-Binds enthalten nur die vier vorgesehenen Bereiche', () => {
  assert.deepEqual(persistentRuntimeBinds('/mnt/user/runtime/codex'), [
    '/mnt/user/runtime/codex/home:/root',
    '/mnt/user/runtime/codex/projects:/projects',
    '/mnt/user/runtime/codex/state:/state',
    '/mnt/user/runtime/codex/attachments:/attachments',
  ]);
});

test('Kumulative item.updated-Texte werden ohne Duplikate gestreamt', () => {
  assert.equal(cumulativeTextDelta('', 'Hal'), 'Hal');
  assert.equal(cumulativeTextDelta('Hal', 'Hallo'), 'lo');
  assert.equal(cumulativeTextDelta('Hallo', 'Hallo'), '');
  assert.equal(cumulativeTextDelta('alt', 'neu'), 'neu');
});

test('Codex JSONL liefert Thread, Antwort und Usage', () => {
  assert.deepEqual(
    parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-1"}'),
    { runtimeSessionId: 'thread-1' },
  );
  assert.deepEqual(
    parseCodexJsonLine('{"type":"item.completed","item":{"type":"agent_message","text":"Hallo"}}'),
    { messageId: 'agent-message', messageText: 'Hallo' },
  );
  assert.deepEqual(
    parseCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":4,"cached_input_tokens":3}}'),
    {
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 },
      context: { usage: { input_tokens: 12, output_tokens: 4, cached_input_tokens: 3 } },
    },
  );
});

test('Neue und fortgesetzte Codex-Session verwenden JSONL und stdin', () => {
  const fresh = buildCodexCommand(null);
  assert.deepEqual(fresh.slice(0, 3), ['codex', 'exec', '--json']);
  assert.equal(fresh.at(-1), '-');
  const resumed = buildCodexCommand('thread-1');
  assert.deepEqual(resumed.slice(-3), ['resume', 'thread-1', '-']);
  assert.ok(resumed.includes('read-only'));
});
