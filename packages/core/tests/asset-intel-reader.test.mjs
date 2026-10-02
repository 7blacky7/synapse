/**
 * Asset-Intel Reader (P4-T60): Werte LE/BE, Bounds-Check, cstring, kontrollierte Fehler.
 * AUFRUF: node --test packages/core/tests/asset-intel-reader.test.mjs  (setzt gebautes dist voraus)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const { BinaryReader, leseReader, AssetReadError } = await import(join(dist, 'asset-intel', 'index.js'));

const b = (...bytes) => new BinaryReader(Uint8Array.from(bytes));
function fehlerArt(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AssetReadError, 'erwartet AssetReadError, bekam ' + (e && e.constructor && e.constructor.name) + ': ' + e);
    assert.ok(!(e instanceof RangeError));
    return e.art;
  }
  assert.fail('es wurde nichts geworfen');
}

test('u8/u16/u32 little- und big-endian', () => {
  const r = b(0xab, 0x01, 0x02, 0x01, 0x02, 0x01, 0x02, 0x03, 0x04, 0x01, 0x02, 0x03, 0x04);
  assert.equal(r.u8(), 0xab);
  assert.equal(r.u16le(), 0x0201);
  assert.equal(r.u16be(), 0x0102);
  assert.equal(r.u32le(), 0x04030201);
  assert.equal(r.u32be(), 0x01020304);
  assert.equal(r.remaining, 0);
  assert.equal(r.position, 13);
});

test('u64 LE/BE liefert bigint, Zahl-Variante nur im sicheren Bereich', () => {
  assert.equal(b(1, 0, 0, 0, 0, 0, 0, 0).u64le(), 1n);
  assert.equal(b(0, 0, 0, 0, 0, 0, 0, 1).u64be(), 1n);
  assert.equal(b(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff).u64le(), 18446744073709551615n);
  assert.equal(b(5, 0, 0, 0, 0, 0, 0, 0).u64leZahl(), 5);
  assert.equal(b(0, 0, 0, 0, 0, 0, 0, 7).u64beZahl(), 7);
  assert.equal(fehlerArt(() => b(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff).u64leZahl()), 'zahl_zu_gross');
});

test('Zugriff hinter dem Ende wirft AssetReadError (kein RangeError), Position bleibt', () => {
  const r = b(1, 2, 3);
  assert.equal(fehlerArt(() => r.u32le()), 'ausserhalb');
  assert.equal(r.position, 0, 'fehlgeschlagener Zugriff darf nicht vorruecken');
  assert.equal(r.u8(), 1);
  assert.equal(fehlerArt(() => r.u64le()), 'ausserhalb');
  assert.equal(fehlerArt(() => b().u8()), 'ausserhalb');
  assert.equal(fehlerArt(() => r.bytes(3)), 'ausserhalb');
  assert.equal(fehlerArt(() => r.skip(3)), 'ausserhalb');
});

test('Gegenprobe: genau bis zum letzten Byte geht noch', () => {
  const r = b(1, 2, 3, 4);
  assert.equal(r.u32be(), 0x01020304);
  assert.equal(r.remaining, 0);
  assert.equal(b(9).u8(), 9);
});

test('ungueltige Argumente (negativ, Bruch, NaN, Infinity) werfen AssetReadError', () => {
  const r = b(1, 2, 3, 4);
  for (const n of [-1, 1.5, NaN, Infinity]) {
    assert.equal(fehlerArt(() => r.bytes(n)), 'ungueltiges_argument', 'bytes(' + n + ')');
    assert.equal(fehlerArt(() => r.skip(n)), 'ungueltiges_argument', 'skip(' + n + ')');
  }
  assert.equal(fehlerArt(() => r.seek(-1)), 'ungueltiges_argument');
  assert.equal(fehlerArt(() => r.seek(5)), 'ausserhalb');
  assert.equal(fehlerArt(() => r.cstring(-3)), 'ungueltiges_argument');
  r.seek(4); // genau Ende ist erlaubt
  assert.equal(r.remaining, 0);
});

test('cstring: liest bis 0, verbraucht Abschluss; unterminiert wirft', () => {
  const r = b(0x61, 0x62, 0, 0x63, 0xc3, 0xa4, 0, 0x64, 0x65);
  assert.equal(r.cstring(), 'ab');
  assert.equal(r.cstring(), 'cä');
  assert.equal(r.position, 7);
  assert.equal(fehlerArt(() => r.cstring()), 'cstring_unterminiert');
  assert.equal(r.position, 7, 'unterminiert darf nicht vorruecken');
  // maxLen schneidet vor dem Abschluss-Byte ab
  const r2 = b(0x61, 0x62, 0x63, 0);
  assert.equal(fehlerArt(() => r2.cstring(3)), 'cstring_unterminiert');
  assert.equal(r2.cstring(4), 'abc');
  assert.equal(b(0).cstring(), '', 'leerer String');
});

test('Fehler tragen Offset mit basisOffset', () => {
  const r = new BinaryReader(Uint8Array.from([1, 2]), 1000);
  r.u8();
  try {
    r.u32le();
    assert.fail('haette werfen muessen');
  } catch (e) {
    assert.ok(e instanceof AssetReadError);
    assert.equal(e.offset, 1001);
    assert.equal(e.benoetigt, 4);
    assert.equal(e.verfuegbar, 1);
  }
});

test('bytes() liefert Sicht ohne Kopie, Reader auf Buffer-Ausschnitt nutzt byteOffset richtig', () => {
  const gross = Buffer.from([9, 9, 1, 2, 3, 9]);
  const r = new BinaryReader(gross.subarray(2, 5));
  assert.equal(r.length, 3);
  assert.deepEqual([...r.bytes(3)], [1, 2, 3]);
  assert.equal(fehlerArt(() => r.u8()), 'ausserhalb');
});

test('leseReader: genug Bytes -> Reader; zu wenig -> abgeschnitten', async () => {
  const src = { filePath: 'x', size: 4, readRange: async (o, l) => Buffer.from([1, 2, 3, 4]).subarray(o, o + l) };
  const r = await leseReader(src, 0, 4);
  assert.equal(r.u32be(), 0x01020304);
  const r2 = await leseReader(src, 2, 2);
  assert.equal(r2.basisOffset, 2);
  await assert.rejects(leseReader(src, 2, 4), e => e instanceof AssetReadError && e.art === 'abgeschnitten' && e.verfuegbar === 2);
});
