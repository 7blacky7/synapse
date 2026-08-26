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
import {
  appendClaudeJsonlChunk,
  buildClaudeAbortCommand,
  buildClaudeCommand,
  buildClaudeRunnerCommand,
  parseClaudeJsonLine,
  validateClaudeModel,
} from '../dist/services/agent-runtime/claude-driver.js';

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
  // Beispielpfad = der echte Ablageort seit dem Umzug 26.08.2026 (Channel 19211)
  // — nicht mehr /mnt/user, das auf diesem Host RAM war.
  assert.deepEqual(persistentRuntimeBinds('/mnt/z/dockdata/synapse-agent-runtime/codex'), [
    '/mnt/z/dockdata/synapse-agent-runtime/codex/home:/root',
    '/mnt/z/dockdata/synapse-agent-runtime/codex/projects:/projects',
    '/mnt/z/dockdata/synapse-agent-runtime/codex/state:/state',
    '/mnt/z/dockdata/synapse-agent-runtime/codex/attachments:/attachments',
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

test('Claude verwendet stream-json, deaktivierte Tools und echte Resume-Semantik', () => {
  const fresh = buildClaudeCommand(null, 'sonnet');
  assert.deepEqual(fresh.slice(0, 4), ['claude', '--print', '--verbose', '--output-format']);
  assert.ok(fresh.includes('stream-json'));
  assert.ok(fresh.includes('--include-partial-messages'));
  assert.equal(fresh[fresh.indexOf('--tools') + 1], '');
  assert.equal(fresh.includes('--resume'), false);

  const resumed = buildClaudeCommand('session-1', 'opus');
  assert.deepEqual(resumed.slice(-2), ['--resume', 'session-1']);
  assert.equal(resumed[resumed.indexOf('--model') + 1], 'opus');
});

test('Claude Modell-ID und gezielter Abort werden validiert', () => {
  assert.equal(validateClaudeModel('claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.throws(() => validateClaudeModel(''), /Modell-ID/);
  assert.throws(() => validateClaudeModel('sonnet; rm -rf'), /Modell-ID/);
  const abort = buildClaudeAbortCommand('/tmp/session.pid');
  assert.ok(abort.join(' ').includes('kill -TERM'));
  assert.ok(abort.join(' ').includes('kill -KILL'));
  assert.equal(abort.join(' ').includes('pkill'), false);
  assert.ok(buildClaudeRunnerCommand().includes('exec 3<&0'));
  assert.ok(buildClaudeRunnerCommand().includes('"$@" <&3 & child=$!'));
  // Rueckfall-Wache: das alte Konstrukt verlor stdin unter dash (Channel 19192)
  assert.equal(buildClaudeRunnerCommand().includes('<&0 &'), false);
});

test('Claude JSONL puffert fachlich Session, Delta und Usage', () => {
  assert.deepEqual(
    parseClaudeJsonLine('{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"session-1\",\"model\":\"sonnet\"}'),
    { runtimeSessionId: 'session-1', context: { model: 'sonnet', apiKeySource: undefined } },
  );
  assert.deepEqual(
    parseClaudeJsonLine('{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hallo\"}}}'),
    { runtimeSessionId: undefined, delta: 'Hallo' },
  );
  const result = parseClaudeJsonLine('{\"type\":\"result\",\"subtype\":\"success\",\"session_id\":\"session-1\",\"result\":\"Hallo\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}');
  assert.equal(result.runtimeSessionId, 'session-1');
  assert.equal(result.resultText, 'Hallo');
  assert.deepEqual(result.usage, {
    inputTokens: 2,
    outputTokens: 1,
    cacheCreationInputTokens: undefined,
    cacheReadInputTokens: undefined,
  });
});

test('Claude result is_error wird als Runtimefehler erkannt', () => {
  const parsed = parseClaudeJsonLine('{"type":"result","subtype":"error","is_error":true,"result":"Login fehlt"}');
  assert.equal(parsed.runtimeError, 'Login fehlt');
});

test('Claude JSONL Framing behaelt beliebige Chunks und den letzten Tail', () => {
  let framed = appendClaudeJsonlChunk('', '{"type":"stream_');
  assert.deepEqual(framed.lines, []);
  framed = appendClaudeJsonlChunk(framed.pending, 'event"}\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Tail"}}}');
  assert.deepEqual(framed.lines, ['{"type":"stream_event"}']);
  assert.ok(framed.pending.startsWith('{"type":"stream_event"'));
  assert.equal(parseClaudeJsonLine(framed.pending).delta, 'Tail');
});

test('Unbekannte oder defekte Claude-Zeilen werden als Debug-Ereignis geliefert', () => {
  assert.deepEqual(parseClaudeJsonLine('kein-json'), { debug: { type: 'raw', content: 'kein-json' } });
  assert.deepEqual(parseClaudeJsonLine('{\"type\":\"future_event\",\"value\":1}'), {
    runtimeSessionId: undefined,
    debug: { type: 'future_event', value: 1 },
  });
});
