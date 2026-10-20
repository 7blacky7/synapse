// P8-T25: Werkzeugaufrufe und Denkphasen des Hauptagenten im Antwortstrom.
// Pure Parser gegen den GEBAUTEN dist (Haus-Muster: plain node, node:test).
// Start aus packages/rest-api: node --test tests/werkzeugstrom-p8-t25.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeJsonLine } from '../dist/services/agent-runtime/claude-driver.js';
import { parseCodexJsonLine, werkzeugErgebnisText } from '../dist/services/agent-runtime/codex-driver.js';

const zeile = (wert) => JSON.stringify(wert);

test('Claude assistant: tool_use wird start-Schritt, thinking wird Denkphase', () => {
  const parsed = parseClaudeJsonLine(zeile({
    type: 'assistant', session_id: 's1',
    message: { content: [
      { type: 'thinking', thinking: '  Ich lese den Plan  ' },
      { type: 'text', text: 'Hallo' },
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__synapse__plan', input: { action: 'get' } },
    ] },
  }));
  assert.equal(parsed.runtimeSessionId, 's1');
  assert.deepEqual(parsed.tools, [{ phase: 'start', id: 'toolu_1', name: 'mcp__synapse__plan', input: { action: 'get' } }]);
  assert.deepEqual(parsed.thinking, ['Ich lese den Plan']);
  assert.equal(parsed.delta, undefined, 'Text kommt weiter nur ueber stream_event-Deltas');
  assert.equal(parsed.debug, undefined);
});

test('Claude user: tool_result wird end-Schritt mit Text und Fehlerkennung', () => {
  const ok = parseClaudeJsonLine(zeile({
    type: 'user', session_id: 's1',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
  }));
  assert.deepEqual(ok.tools, [{ phase: 'end', id: 'toolu_1', output: 'a\nb', isError: false }]);
  const fehler = parseClaudeJsonLine(zeile({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'kaputt', is_error: true }] },
  }));
  assert.deepEqual(fehler.tools, [{ phase: 'end', id: 'toolu_2', output: 'kaputt', isError: true }]);
});

test('Claude user ohne tool_result bleibt wie bisher ein runtime-Debug-Ereignis', () => {
  const parsed = parseClaudeJsonLine(zeile({ type: 'user', message: { content: [{ type: 'text', text: 'x' }] } }));
  assert.equal(parsed.tools, undefined);
  assert.ok(parsed.debug, 'debug bleibt gesetzt');
});

test('Claude Textdelta unveraendert', () => {
  const parsed = parseClaudeJsonLine(zeile({ type: 'stream_event', session_id: 's', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }));
  assert.equal(parsed.delta, 'Hi');
  assert.equal(parsed.tools, undefined);
});

test('Codex: mcp_tool_call und command_execution werden start/end, reasoning wird Denkphase', () => {
  const start = parseCodexJsonLine(zeile({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'synapse', tool: 'plan', arguments: { action: 'get' }, status: 'in_progress' } }));
  assert.deepEqual(start.tool, { phase: 'start', id: 'i1', name: 'synapse__plan', input: { action: 'get' } });
  const ende = parseCodexJsonLine(zeile({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'synapse', tool: 'plan', result: { content: [{ type: 'text', text: 'ok' }] }, status: 'completed' } }));
  assert.equal(ende.tool.phase, 'end');
  assert.equal(ende.tool.isError, false);
  assert.match(ende.tool.output, /ok/);
  const fehlgeschlagen = parseCodexJsonLine(zeile({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 's', tool: 't', status: 'failed' } }));
  assert.equal(fehlgeschlagen.tool.isError, true);
  const shell = parseCodexJsonLine(zeile({ type: 'item.completed', item: { id: 'i3', type: 'command_execution', command: 'ls', aggregated_output: 'a\nb', exit_code: 2, status: 'completed' } }));
  assert.deepEqual(shell.tool, { phase: 'end', id: 'i3', name: 'shell', output: 'a\nb', isError: true });
  const denken = parseCodexJsonLine(zeile({ type: 'item.completed', item: { id: 'i4', type: 'reasoning', text: ' Plan pruefen ' } }));
  assert.equal(denken.thinking, 'Plan pruefen');
});

test('Codex agent_message und usage unveraendert', () => {
  const nachricht = parseCodexJsonLine(zeile({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Fertig' } }));
  assert.deepEqual(nachricht, { messageId: 'm1', messageText: 'Fertig' });
  const usage = parseCodexJsonLine(zeile({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } }));
  assert.equal(usage.usage.inputTokens, 3);
  assert.equal(usage.tool, undefined);
});

test('werkzeugErgebnisText: Text, Bloecke, Objekt, Kappung', () => {
  assert.equal(werkzeugErgebnisText('x'), 'x');
  assert.equal(werkzeugErgebnisText([{ type: 'text', text: 'a' }, 'b']), 'a\nb');
  assert.equal(werkzeugErgebnisText({ a: 1 }), '{"a":1}');
  assert.equal(werkzeugErgebnisText(undefined), '');
  const lang = werkzeugErgebnisText('y'.repeat(25_000));
  assert.ok(lang.length < 20_100 && lang.endsWith('(gekuerzt)'));
});
