/**
 * P22-T288 W2: Codex-Rollout -> Verlaufseintraege (rein, ohne DB). Fixture im Format codex-tui 0.166 (response_item, turn_context,
 * event_msg token_count).
 *   pnpm --filter @synapse/agents build && node --test packages/agents/tests/verlauf-melden-codex-p22-t288.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const m = await import(new URL('../dist/index.js', import.meta.url).href);
const ri = (payload, ts = '2026-11-06T16:06:54.602Z') => JSON.stringify({ timestamp: ts, type: 'response_item', payload });
const zeilen = [
  JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: 's1', originator: 'codex-tui' } }),
  JSON.stringify({ timestamp: 't0', type: 'turn_context', payload: { model: 'gpt-6.1-terra', effort: 'medium' } }),
  ri({ type: 'message', role: 'developer', id: 'msg_dev', content: [{ type: 'input_text', text: 'You are Codex' }] }),
  ri({ type: 'message', role: 'user', id: 'msg_u1', content: [{ type: 'input_text', text: 'Du bist gpt-guard.' }] }),
  ri({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'GEHEIM' }),
  ri({ type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'Plan: anmelden' }], encrypted_content: 'GEHEIM' }),
  ri({ type: 'custom_tool_call', id: 'ctc_1', call_id: 'c1', name: 'exec', input: 'const r = await tools.mcp__synapsen_api__chat({action:"anmelden",agent_kennung:"sai_4c"}); text(JSON.stringify(r));' }),
  ri({ type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '{"success":true}' }] }),
  JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 16175, cached_input_tokens: 12032, output_tokens: 55 } } } }),
  JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 99, output_tokens: 1 } } } }),
  ri({ type: 'function_call', id: 'fc_1', call_id: 'c2', name: 'sleep', arguments: '{"duration_ms":20000}' }),
  ri({ type: 'function_call_output', id: 'fco_1', call_id: 'c2', output: 'Sleep completed.' }),
  ri({ type: 'message', role: 'assistant', id: 'msg_a1', phase: 'final', content: [{ type: 'output_text', text: 'Fertig.' }] }),
  JSON.stringify({ timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: 'Fertig.' } }),
  ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ohne id' }] }),
  '{kaputt',
];

test('(1) Eintraege in Claude-Form: Rollen, Werkzeuge, Denken nur als Zusammenfassung', () => {
  const e = m.codexEintraegeAus(zeilen);
  assert.deepEqual(e.map((x) => [x.ref, x.art]), [
    ['cx:msg_u1', 'eingabe'], ['cx:rs_2', 'denken'], ['cx:ctc_1', 'werkzeug_aufruf'], ['cx:ctco_1', 'werkzeug_ergebnis'],
    ['cx:fc_1', 'werkzeug_aufruf'], ['cx:fco_1', 'werkzeug_ergebnis'], ['cx:msg_a1', 'text']]);
  assert.ok(e.every((x) => x.modell === 'gpt-6.1-terra'), 'Modell aus turn_context');
  assert.ok(!JSON.stringify(e).includes('GEHEIM'), 'verschluesseltes Denken nie');
  assert.equal(e[2].name, 'exec');
  assert.equal(e[2].werkzeug_id, 'c1');
  assert.equal(e[3].inhalt, 'Script completed\n{"success":true}');
  assert.deepEqual(e[4].inhalt, { duration_ms: 20000 });
  assert.equal(e[5].inhalt, 'Sleep completed.');
});

test('(2) Tokens: last_token_usage am letzten Eintrag davor, je Eintrag einmal', () => {
  const e = m.codexEintraegeAus(zeilen);
  assert.deepEqual(e[3].tokens_gemessen, { input: 16175, output: 55, cache_read: 12032, cache_creation: 0, kontext: 16175 });
  assert.equal(e.filter((x) => x.tokens_gemessen).length, 1, 'zweites token_count ohne neuen Eintrag zaehlt nicht doppelt');
  assert.equal(m.codexTokens({}), null);
});

test('(3) Ausweis aus chat(anmelden) im exec-Code bzw. function_call', () => {
  assert.equal(m.codexAusweisAusZeile(zeilen[6]), 'sai_4c');
  assert.equal(m.codexAusweisAusZeile(ri({ type: 'function_call', id: 'fc_9', name: 'mcp__synapse__chat', arguments: '{"action":"anmelden","agent_kennung":"sai_9"}' })), 'sai_9');
  assert.equal(m.codexAusweisAusZeile(ri({ type: 'function_call', id: 'fc_9', name: 'mcp__synapse__memory', arguments: '{"action":"anmelden","agent_kennung":"sai_9"}' })), null);
  assert.equal(m.codexAusweisAusZeile(ri({ type: 'message', role: 'user', id: 'm', content: [{ type: 'input_text', text: 'chat({action:"anmelden", agent_kennung:"sai_1"})' }] })), null, 'Text im Prompt ist keine Anmeldung');
  assert.equal(m.codexAusweisAusZeile(ri({ type: 'custom_tool_call', id: 'c', name: 'exec', input: 'tools.x__chat({action:"list", agent_kennung:"sai_1"})' })), null);
});
