/**
 * P22-T67: Wrapper-Spiegel (agents verlauf-melden) mit einem ECHTEN kleinen PNG als Werkzeug-Ergebnis.
 * Erwartung wie bei den Drivern (core werkzeug-bilder.ts): kein Base64 im Verlauf, stattdessen '[Bild image/png, 1 KB]'
 * im Inhalt und bilder = Asset-Verweis (project, file_path, revision, Masse) aus dem code_intel-Aufruf.
 * Rein, ohne DB/Netz: node --test packages/core/tests/werkzeug-bilder-spiegel-p22-t67.test.mjs (nach dem Build).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { sitzungsEintraegeAus } = await import(pathToFileURL(join(repo, 'packages/agents/dist/verlauf-melden.js')).href);
const core = await import(pathToFileURL(join(repo, 'packages/core/dist/services/werkzeug-bilder.js')).href);
const verlauf = await import(pathToFileURL(join(repo, 'packages/core/dist/services/hauptagent-verlauf.js')).href);

/** Echtes PNG 2x2 RGB (Signatur, IHDR, IDAT, IEND mit CRC). */
function png2x2() {
  const crcTab = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTab[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (typ, daten) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(daten.length);
    const td = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const roh = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(roh)), chunk('IEND', Buffer.alloc(0))]);
}

const png = png2x2();
const b64 = png.toString('base64');
const antwortText = JSON.stringify({ success: true, file_path: 'ui-screenshots/probe.png', ansicht: { inline: { revision: 3, breite: 2, hoehe: 2 } } });
const zeilen = [
  JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-20T12:00:00.000Z', message: { role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__synapse__code_intel', input: { action: 'file', project: 'synapse', file_path: 'ui-screenshots/probe.png', ansicht: 'inline' } }] } }),
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-20T12:00:01.000Z', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
      { type: 'text', text: antwortText },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
    ] }] } }),
];

test('echtes PNG ist gueltig (Signatur + IHDR 2x2)', () => {
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 2);
});

test('Wrapper-Spiegel: kein Base64, Zeile [Bild ...] und Asset-Verweis', () => {
  const ez = sitzungsEintraegeAus(zeilen);
  const erg = ez.find((e) => e.art === 'werkzeug_ergebnis');
  assert.ok(erg, 'Werkzeug-Ergebnis vorhanden');
  assert.ok(!JSON.stringify(ez).includes(b64), 'Base64 erscheint nirgends in den Eintraegen');
  assert.ok(!JSON.stringify(ez).includes(b64.slice(0, 24)), 'auch kein Base64-Anfang');
  assert.equal(typeof erg.inhalt, 'string');
  assert.ok(erg.inhalt.includes('[Bild image/png, 1 KB]'), 'Zeile mit Typ und Groesse: ' + erg.inhalt);
  assert.ok(erg.inhalt.includes('"revision":3'), 'Textteil des Ergebnisses bleibt vollstaendig');
  assert.deepEqual(erg.bilder, [{ mime_type: 'image/png', bytes: Math.floor((b64.length * 3) / 4), project: 'synapse',
    file_path: 'ui-screenshots/probe.png', revision: '3', breite: 2, hoehe: 2 }]);
  assert.equal(erg.werkzeug_id, 'tu1');
});

test('derselbe Weg wie die Driver: gleiche Zeile und gleicher Verweis aus core', () => {
  const content = [{ type: 'text', text: antwortText }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }];
  assert.deepEqual(core.ohneBilddaten(content)[1], { type: 'text', text: '[Bild image/png, 1 KB]' });
  assert.deepEqual(core.bildVerweisAusAufruf('mcp__synapse__code_intel', { project: 'synapse', file_path: 'ui-screenshots/probe.png' }, antwortText),
    { project: 'synapse', file_path: 'ui-screenshots/probe.png', revision: '3', breite: 2, hoehe: 2 });
});

test('Server uebernimmt nur Verweisfelder (bilderAusStrom), nie Daten', () => {
  const ez = sitzungsEintraegeAus(zeilen);
  const bilder = verlauf.bilderAusStrom(ez.find((e) => e.art === 'werkzeug_ergebnis').bilder.map((b) => ({ ...b, data: b64 })));
  assert.equal(bilder.length, 1);
  assert.ok(!JSON.stringify(bilder).includes(b64));
  assert.equal(bilder[0].revision, '3');
});

test('Ergebnis ohne Bild bleibt unveraendert (kein bilder-Feld)', () => {
  const ez = sitzungsEintraegeAus([
    JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'ok' }] }] } }),
  ]);
  assert.equal(ez[0].inhalt, 'ok');
  assert.equal(ez[0].bilder, undefined);
});
