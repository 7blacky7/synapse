/**
 * P22-T67: Bilder im Werkzeugstrom (Claude- und Codex-Zeilen): kein Base64 im Text, Verweis aus den Aufrufargumenten.
 *   node --test packages/rest-api/tests/werkzeug-bilder-p22-t67.test.mjs   (nach pnpm run build in rest-api)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeJsonLine } from '../dist/services/agent-runtime/claude-driver.js';
import { parseCodexJsonLine, werkzeugErgebnisText } from '../dist/services/agent-runtime/codex-driver.js';
import { neuerBildVerweisMerker, bildVerweisAusAufruf, werkzeugBilder, ohneBilddaten } from '../dist/services/agent-runtime/werkzeug-bilder.js';

const zeile = (wert) => JSON.stringify(wert);
const DATEN = 'iVBORw0KGgo'.repeat(3000);
const TEXT = JSON.stringify({ success: true, ansicht: { modus: 'inline', inline: { success: true, breite: 640, hoehe: 480, revision: '4', bytes: 2048 } } });

test('Claude tool_result mit image-Block: Text ohne Base64, bilder mit Metadaten', () => {
  const p = parseClaudeJsonLine(zeile({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: [
    { type: 'text', text: TEXT },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATEN } },
  ] }] } }));
  const end = p.tools[0];
  assert.equal(end.phase, 'end');
  assert.equal(end.output.includes('iVBOR'), false);
  assert.match(end.output, /\[Bild image\/png, \d+ KB\]/);
  assert.equal(end.bilder.length, 1);
  assert.equal(end.bilder[0].mime_type, 'image/png');
  assert.ok(end.bilder[0].bytes > 20000);
  assert.equal(JSON.stringify(end).includes('iVBOR'), false);
});

test('MCP-Form (data + mimeType) und Fehlerergebnis', () => {
  assert.deepEqual(werkzeugBilder([{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]), [{ mime_type: 'image/jpeg', bytes: 3 }]);
  const p = parseClaudeJsonLine(zeile({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a2', is_error: true, content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }] } }));
  assert.equal(p.tools[0].bilder, undefined, 'bei Fehler keine Bilder');
  assert.equal(werkzeugErgebnisText('x'), 'x');
  assert.equal(werkzeugErgebnisText({ a: 1 }), '{"a":1}');
  assert.deepEqual(ohneBilddaten('x'), 'x');
});

test('Codex mcp_tool_call: result.content mit Bild', () => {
  const p = parseCodexJsonLine(zeile({ type: 'item.completed', item: { id: 'c1', type: 'mcp_tool_call', server: 'synapse', tool: 'code_intel', status: 'completed',
    result: { content: [{ type: 'text', text: TEXT }, { type: 'image', data: DATEN, mimeType: 'image/png' }], structured_content: null } } }));
  assert.equal(p.tool.output.includes('iVBOR'), false);
  assert.equal(p.tool.bilder.length, 1);
  assert.equal(JSON.stringify(p.tool).includes('iVBOR'), false);
});

test('Verweis aus den Argumenten des start-Schritts, Revision und Masse aus dem Ergebnis', () => {
  const merke = neuerBildVerweisMerker();
  const start = { phase: 'start', id: 'x', name: 'mcp__synapse__code_intel', input: { action: 'file', project: 'synapse', file_path: 'ui-screenshots/a.png', ansicht: 'inline' } };
  assert.equal(merke(start), start);
  const end = merke({ phase: 'end', id: 'x', output: TEXT, bilder: [{ mime_type: 'image/png', bytes: 2048 }] });
  assert.deepEqual(end.bilder, [{ mime_type: 'image/png', bytes: 2048, project: 'synapse', file_path: 'ui-screenshots/a.png', revision: '4', breite: 640, hoehe: 480 }]);
  // anderes Tool / kein Pfad: Bild ohne Verweis (Hinweis statt Bild in der UI)
  merke({ phase: 'start', id: 'y', name: 'mcp__synapse__shell', input: { command: 'ls' } });
  const ohne = merke({ phase: 'end', id: 'y', output: '', bilder: [{ mime_type: 'image/png', bytes: 1 }] });
  assert.deepEqual(ohne.bilder, [{ mime_type: 'image/png', bytes: 1 }]);
  // end ohne Bilder bleibt unveraendert; gekuerztes Ergebnis: Verweis ohne Revision
  const unveraendert = { phase: 'end', id: 'z', output: 'ok' };
  assert.equal(merke(unveraendert), unveraendert);
  assert.deepEqual(bildVerweisAusAufruf('synapse__asset_intel', { project: 'p', file_path: 'm/a.png' }, '{"kaputt'), { project: 'p', file_path: 'm/a.png' });
});
