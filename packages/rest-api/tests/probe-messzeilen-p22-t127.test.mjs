/**
 * P22-T127 R3a (rea4 f78495d3): Messzeilen der Probe ueberstehen beliebig zerstueckelte stderr-Chunks.
 *   pnpm --filter @synapse/rest-api build && node --test packages/rest-api/tests/probe-messzeilen-p22-t127.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const P = await import(pathToFileURL(join(repo, 'packages/rest-api/dist/services/agent-runtime/probe.js')).href);

const TEXT = 'Warnung x\nSYNAPSE_PROBE_ZEIT supervisor_bereit=812\nmehr stderr\nSYNAPSE_PROBE_ZEIT kind_ende=10433\n';

test('ganzer Text in einem Chunk', () => {
  const m = {}; const l = P.messZeilenLeser(m); l.schreibe(TEXT); l.ende();
  assert.deepEqual(m, { supervisor_bereit: 812, kind_ende: 10433 });
});

test('jede Chunk-Grenze (zwei Teile) liefert dieselben Werte', () => {
  for (let i = 1; i < TEXT.length; i++) {
    const m = {}; const l = P.messZeilenLeser(m); l.schreibe(TEXT.slice(0, i)); l.schreibe(TEXT.slice(i)); l.ende();
    assert.deepEqual(m, { supervisor_bereit: 812, kind_ende: 10433 }, 'Grenze ' + i);
  }
});

test('zeichenweise und letzte Zeile ohne Zeilenende', () => {
  const m = {}; const l = P.messZeilenLeser(m);
  for (const z of TEXT.trimEnd()) l.schreibe(z);
  assert.equal(m.kind_ende, undefined, 'Teilzeile erst am Ende');
  l.ende();
  assert.deepEqual(m, { supervisor_bereit: 812, kind_ende: 10433 });
});

test('Zahl ueber Chunk-Grenze wird nicht abgeschnitten', () => {
  const m = {}; const l = P.messZeilenLeser(m); l.schreibe('SYNAPSE_PROBE_ZEIT kind_ende=10'); l.schreibe('433\n'); l.ende();
  assert.equal(m.kind_ende, 10433);
});

test('Messbefehl enthaelt Messzeilen nur mit messen', () => {
  assert.ok(!P.buildRuntimeProbeCommand(['x'], 1000).join(' ').includes('SYNAPSE_PROBE_ZEIT'));
  assert.ok(P.buildRuntimeProbeCommand(['x'], 1000, true).join(' ').includes('SYNAPSE_PROBE_ZEIT'));
});
