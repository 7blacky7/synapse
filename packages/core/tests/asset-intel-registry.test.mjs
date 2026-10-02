/**
 * Asset-Intel Registry (P4-T60): Magic vor Endung, Mehrdeutigkeit, Registrierung.
 * Jeder Fall nutzt eine EIGENE Registry; die Standard-Registry wird nur gelesen.
 * AUFRUF: node --test packages/core/tests/asset-intel-registry.test.mjs  (setzt gebautes dist voraus)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const { AssetRegistry, detectAsset, registerInspector, getRegisteredFormats, standardRegistry } = A;

const PNG = [0x89, 0x50, 0x4e, 0x47];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const insp = (id, extra = {}) => ({
  id,
  formats: [id],
  extensions: [],
  version: 1,
  inspect: async () => {
    throw new Error('nicht aufgerufen');
  },
  ...extra,
});
const kopf = (...bytes) => Uint8Array.from(bytes);

test('Magic hat Vorrang vor der Endung (PNG-Inhalt unter .glb)', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('png', { extensions: ['.png'], magic: [{ offset: 0, bytes: PNG }] }), reg);
  registerInspector(insp('glb', { extensions: ['.glb'], magic: [{ offset: 0, bytes: [0x67, 0x6c, 0x54, 0x46] }] }), reg);
  const d = detectAsset('/x/bild.glb', kopf(...PNG, 0, 0), reg);
  assert.equal(d.inspector?.id, 'png');
  assert.equal(d.format, 'png');
  assert.equal(d.via, 'magic');
  assert.ok(d.warnings.some(w => w.code === 'endung_widerspricht_inhalt'), 'Widerspruch Endung/Inhalt muss gemeldet werden');
});

test('Gegenprobe: passt die Endung zum Magic, gibt es keine Widerspruchswarnung', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('png', { extensions: ['.png'], magic: [{ offset: 0, bytes: PNG }] }), reg);
  const d = detectAsset('/x/bild.PNG', kopf(...PNG), reg);
  assert.equal(d.inspector?.id, 'png');
  assert.deepEqual(d.warnings, []);
});

test('ohne Magic-Treffer entscheidet die Endung (Gross/Klein egal, mit oder ohne Punkt registriert)', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('txtfmt', { formats: ['foo', 'bar'], extensions: ['BAR', '.foo'] }), reg);
  const d = detectAsset('/x/a.Bar', kopf(1, 2, 3), reg);
  assert.equal(d.inspector?.id, 'txtfmt');
  assert.equal(d.format, 'bar', 'Format folgt der Endung, wenn sie ein Format des Inspektors ist');
  assert.equal(d.via, 'endung');
  assert.equal(detectAsset('/x/a.foo', kopf(), reg).format, 'foo');
  assert.deepEqual(d.warnings, []);
});

test('Endung eines Magic-Inspektors, aber Kopf passt nicht: Treffer ueber Endung + Warnung magic_fehlt', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('png', { extensions: ['.png'], magic: [{ offset: 0, bytes: PNG }] }), reg);
  const d = detectAsset('/x/kaputt.png', kopf(1, 2, 3, 4), reg);
  assert.equal(d.inspector?.id, 'png');
  assert.equal(d.via, 'endung');
  assert.ok(d.warnings.some(w => w.code === 'magic_fehlt'));
});

test('weder Magic noch Endung: kein Treffer, keine Warnung', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('png', { extensions: ['.png'], magic: [{ offset: 0, bytes: PNG }] }), reg);
  const d = detectAsset('/x/etwas.xyz', kopf(1, 2, 3), reg);
  assert.equal(d.inspector, null);
  assert.equal(d.format, null);
  assert.equal(d.via, null);
  assert.deepEqual(d.warnings, []);
  assert.equal(detectAsset('/x/ohne-endung', kopf(), reg).inspector, null);
});

test('MEHRDEUTIG per Magic (zwei Inspektoren, gleiche Bytes, Endung entscheidet nicht): kein Treffer + Warnung', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('docx', { extensions: ['.docx'], magic: [{ offset: 0, bytes: ZIP }] }), reg);
  registerInspector(insp('jar', { extensions: ['.jar'], magic: [{ offset: 0, bytes: ZIP }] }), reg);
  const d = detectAsset('/x/archiv.bin', kopf(...ZIP, 0), reg);
  assert.equal(d.inspector, null);
  assert.equal(d.format, null);
  const w = d.warnings.find(x => x.code === 'erkennung_mehrdeutig');
  assert.ok(w, 'Warnung erkennung_mehrdeutig erwartet');
  assert.ok(w.message.includes('docx') && w.message.includes('jar'), 'Warnung nennt beide Kandidaten');
});

test('Gegenprobe: gleiche Magic-Mehrdeutigkeit wird von der Endung aufgeloest', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('docx', { extensions: ['.docx'], magic: [{ offset: 0, bytes: ZIP }] }), reg);
  registerInspector(insp('jar', { extensions: ['.jar'], magic: [{ offset: 0, bytes: ZIP }] }), reg);
  const d = detectAsset('/x/a.jar', kopf(...ZIP, 0), reg);
  assert.equal(d.inspector?.id, 'jar');
  assert.equal(d.via, 'magic_und_endung');
  assert.deepEqual(d.warnings, []);
});

test('MEHRDEUTIG per Endung (zwei Inspektoren beanspruchen .dat): kein Treffer + Warnung', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('a', { extensions: ['.dat'] }), reg);
  registerInspector(insp('b', { extensions: ['dat'] }), reg);
  const d = detectAsset('/x/z.dat', kopf(1), reg);
  assert.equal(d.inspector, null);
  assert.ok(d.warnings.some(w => w.code === 'erkennung_mehrdeutig'));
});

test('Magic mit Offset und laengerem Muster: je Inspektor gewinnt das laengste passende', () => {
  const reg = new AssetRegistry();
  registerInspector(
    insp('riff', {
      formats: ['wav', 'avi'],
      magic: [
        { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46], format: 'riff' },
        { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45], format: 'wav' },
      ],
    }),
    reg
  );
  const kopfWav = kopf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
  assert.equal(detectAsset('/x/a', kopfWav, reg).format, 'riff', 'gleich lange Muster: das erste');
  // Offset hinter dem Kopf: kein Treffer, kein Absturz
  assert.equal(detectAsset('/x/a', kopf(0x57, 0x41), reg).inspector, null);
});

test('Registrierung: ungueltige Inspektoren werfen sofort, gleiche id ersetzt', () => {
  const reg = new AssetRegistry();
  assert.throws(() => reg.register(null), /ohne id/);
  assert.throws(() => reg.register(insp('')), /ohne id/);
  assert.throws(() => reg.register(insp('x', { formats: [] })), /ohne formats/);
  assert.throws(() => reg.register(insp('x', { extensions: undefined })), /ohne extensions/);
  assert.throws(() => reg.register(insp('x', { inspect: undefined })), /ohne inspect/);
  assert.throws(() => reg.register(insp('x', { magic: [{ offset: 0, bytes: [] }] })), /Magic/);
  assert.throws(() => reg.register(insp('x', { magic: [{ offset: -1, bytes: [1] }] })), /Magic/);
  assert.equal(reg.list().length, 0, 'nichts halb registriert');
  reg.register(insp('x', { version: 1 }));
  reg.register(insp('x', { version: 2 }));
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get('x').version, 2);
});

test('getRegisteredFormats: eindeutig, sortiert, Kleinschrift', () => {
  const reg = new AssetRegistry();
  registerInspector(insp('b', { formats: ['Zeta', 'alpha'] }), reg);
  registerInspector(insp('c', { formats: ['alpha', 'beta'] }), reg);
  assert.deepEqual(getRegisteredFormats(reg), ['alpha', 'beta', 'zeta']);
});

test('Standard-Registry: generic-binary ist eingehaengt und erkennt seine Formate am Magic', () => {
  assert.ok(standardRegistry.get('generic-binary'), 'generic-binary fehlt in der Standard-Registry');
  const formate = getRegisteredFormats();
  for (const f of ['png', 'jpeg', 'gif', 'pdf', 'zip', 'gzip', '7z', 'glb', 'elf']) assert.ok(formate.includes(f), f + ' fehlt');
  // Seit der Verdrahtung traegt generic-binary nur noch Magic von Formaten ohne eigenen Inspektor (gif, pdf).
  const d = detectAsset('/x/ohne-endung', kopf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0));
  assert.equal(d.inspector?.id, 'generic-binary');
  assert.equal(d.format, 'gif');
  assert.equal(detectAsset('/x/ohne-endung', kopf(0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0)).inspector?.id, '3d-glb', 'glb gehoert dem echten Inspektor');
  // generic-binary hat keine Endungen: reine Endung ergibt nichts
  assert.equal(detectAsset('/x/a.gif', kopf(1, 2, 3)).inspector, null);
});
