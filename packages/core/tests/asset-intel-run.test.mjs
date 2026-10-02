/**
 * Asset-Intel Pipeline (P4-T60): inspectAsset Ende zu Ende gegen gebautes dist.
 * Deckt ab: vollstaendiges Ausgabeschema, Magic vor Endung, Grenzen (zu gross, Lesebudget,
 * Zeit, Objekte, Tiefe), leere / fehlende / abgeschnittene / kaputte Datei, nur lesend,
 * wirft nie, Fixtures deterministisch.
 * AUFRUF: node --test packages/core/tests/asset-intel-run.test.mjs  (setzt gebautes dist voraus)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const { inspectAsset, AssetRegistry, AssetReadError, STANDARD_GRENZEN, leseReader, erzeugeAssetResult } = A;
const { erzeugeFixtures } = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures.mjs')).href);

const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];
const sha = pfad => createHash('sha256').update(readFileSync(pfad)).digest('hex');
const codes = r => r.warnings.map(w => w.code);

// Grundschicht-Stand von generic-binary (volle Magic-Liste, vor der Verdrahtung): diese Tests pruefen die Pipeline,
// nicht die Formate. Die Standard-Registry gehoert seit der Verdrahtung den echten Inspektoren (siehe asset-intel-standard.test.mjs).
const GENERIC_ALT_MAGIC = [
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], format: 'png' },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], format: 'jpeg' },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], format: 'gif' },
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], format: 'pdf' },
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], format: 'zip' },
  { offset: 0, bytes: [0x1f, 0x8b], format: 'gzip' },
  { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], format: '7z' },
  { offset: 0, bytes: [0x67, 0x6c, 0x54, 0x46], format: 'glb' },
  { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], format: 'elf' },
];
function grundRegistry() {
  const reg = new AssetRegistry();
  reg.register({ ...A.genericBinaryInspector, formats: GENERIC_ALT_MAGIC.map(m => m.format), magic: GENERIC_ALT_MAGIC });
  return reg;
}

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, wo + ': Feld fehlt: ' + k);
  assert.equal(typeof r.asset_type, 'string', wo + ' asset_type');
  assert.ok(r.format === null || typeof r.format === 'string', wo + ' format');
  assert.equal(typeof r.file_path, 'string');
  assert.ok(Number.isInteger(r.size) && r.size >= 0, wo + ' size');
  assert.ok(r.sha256 === null || /^[0-9a-f]{64}$/.test(r.sha256), wo + ' sha256');
  assert.ok(['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'].includes(r.status), wo + ' status ' + r.status);
  assert.ok(r.inspector === null || typeof r.inspector === 'string');
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), wo + ' ' + k);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), wo + ' ' + k);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', wo + ' warning-Form');
  assert.ok(Number.isInteger(r.parser_version) && r.parser_version >= 0);
  assert.ok(!Number.isNaN(Date.parse(r.extracted_at)) && r.extracted_at.endsWith('Z'), wo + ' extracted_at ISO-UTC');
  JSON.stringify(r); // muss serialisierbar sein (landet in PG)
}

/** Test-Inspektor in eigener Registry; verhalten bestimmt die Funktion. */
function testRegistry(verhalten, extra = {}) {
  const reg = new AssetRegistry();
  reg.register({
    id: 'test-fmt',
    formats: ['tst'],
    extensions: ['.tst', '.glb', '.bin', '.zip'],
    version: 7,
    inspect: verhalten,
    ...extra,
  });
  return reg;
}

let fx;
before(async () => {
  fx = await erzeugeFixtures();
});
after(async () => {
  await fx.aufraeumen();
});

test('Ende zu Ende mit generic-binary: PNG vollstaendiges Schema, sha256 stimmt', async () => {
  const r = await inspectAsset(fx.pfade.pngMinimal, { registry: grundRegistry() });
  pruefeSchema(r, 'png');
  assert.equal(r.status, 'ok');
  assert.equal(r.format, 'png');
  assert.equal(r.asset_type, 'image');
  assert.equal(r.inspector, 'generic-binary');
  assert.equal(r.parser_version, 1);
  assert.equal(r.file_path, fx.pfade.pngMinimal);
  assert.equal(r.size, statSync(fx.pfade.pngMinimal).size);
  assert.equal(r.sha256, sha(fx.pfade.pngMinimal));
  assert.equal(r.format_specific.tiefe, 'nur_magic');
  assert.deepEqual(r.warnings, []);
});

test('generic-binary erkennt glb und zip', async () => {
  const g = await inspectAsset(fx.pfade.glbMinimal);
  pruefeSchema(g, 'glb');
  assert.equal(g.format, 'glb');
  assert.equal(g.asset_type, 'model3d');
  const z = await inspectAsset(fx.pfade.zipMinimal);
  assert.equal(z.format, 'zip');
  assert.equal(z.asset_type, 'archive');
});

test('Magic vor Endung ueber die ganze Pipeline: PNG-Inhalt mit .glb-Endung ist png', async () => {
  const r = await inspectAsset(fx.pfade.pngAlsGlb, { registry: grundRegistry() });
  assert.equal(r.format, 'png');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), [], 'generic-binary hat keine Endungen: keine Widerspruchswarnung');
  const reg = testRegistry(async src => erzeugeAssetResult(src.filePath, src.size, { format: 'tst' }));
  reg.register({ id: 'png-x', formats: ['png'], extensions: ['.png'], magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }], version: 1, inspect: async src => erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'png' }) });
  const r2 = await inspectAsset(fx.pfade.pngAlsGlb, { registry: reg });
  assert.equal(r2.inspector, 'png-x', 'Inhalt (Magic) schlaegt die Endung .glb des anderen Inspektors');
  assert.ok(codes(r2).includes('endung_widerspricht_inhalt'));
});

test('unbekanntes Format: nicht_erkannt + kein_inspektor, kein Fehler', async () => {
  const r = await inspectAsset(fx.pfade.unbekannt);
  pruefeSchema(r, 'unbekannt');
  assert.equal(r.status, 'nicht_erkannt');
  assert.equal(r.format, null);
  assert.equal(r.inspector, null);
  assert.equal(r.parser_version, 0);
  assert.ok(codes(r).includes('kein_inspektor'));
  assert.equal(r.sha256, sha(fx.pfade.unbekannt), 'Hash gibt es auch ohne Inspektor');
});

test('Quelle fehlt: Ergebnis statt Wurf, Status und Warnung quelle_nicht_gefunden', async () => {
  const r = await inspectAsset(join(fx.dir, 'gibt-es-nicht.png'));
  pruefeSchema(r, 'fehlt');
  assert.equal(r.status, 'quelle_nicht_gefunden');
  assert.ok(codes(r).includes('quelle_nicht_gefunden'));
  assert.equal(r.size, 0);
  assert.equal(r.sha256, null);
  // Elternpfad ist eine Datei (ENOTDIR) zaehlt ebenfalls als fehlend
  const r2 = await inspectAsset(join(fx.pfade.pngMinimal, 'unter'));
  assert.equal(r2.status, 'quelle_nicht_gefunden');
});

test('leere Datei: datei_leer, sha256 des leeren Inhalts, Inspektor wird nicht gerufen', async () => {
  let gerufen = 0;
  const reg = testRegistry(async src => {
    gerufen++;
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const r = await inspectAsset(fx.pfade.leer, { registry: reg });
  pruefeSchema(r, 'leer');
  assert.equal(r.size, 0);
  assert.ok(codes(r).includes('datei_leer'));
  assert.equal(r.status, 'teilweise');
  assert.equal(r.sha256, createHash('sha256').update('').digest('hex'));
  assert.equal(gerufen, 0);
  const r2 = await inspectAsset(fx.pfade.leer);
  assert.equal(r2.status, 'nicht_erkannt');
  assert.ok(codes(r2).includes('datei_leer'));
});

test('Verzeichnis statt Datei: keine_datei, kein Wurf', async () => {
  const r = await inspectAsset(fx.dir);
  pruefeSchema(r, 'verzeichnis');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('keine_datei'));
});

test('Datei zu gross (maxFileBytes): erkannt, aber nicht inspiziert, Warnung datei_zu_gross', async () => {
  let gerufen = 0;
  const reg = testRegistry(async src => {
    gerufen++;
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const r = await inspectAsset(fx.pfade.gross, { maxFileBytes: 1000, registry: reg });
  pruefeSchema(r, 'gross');
  assert.equal(r.status, 'teilweise');
  assert.equal(r.inspector, 'test-fmt');
  assert.ok(codes(r).includes('datei_zu_gross'));
  assert.equal(gerufen, 0, 'Inspektor darf bei zu grosser Datei nicht laufen');
  // Gegenprobe: mit passender Grenze laeuft er
  const r2 = await inspectAsset(fx.pfade.gross, { maxFileBytes: 100000, registry: reg });
  assert.equal(gerufen, 1);
  assert.ok(!codes(r2).includes('datei_zu_gross'));
  // Standard-Pipeline: auch hier nur Erkennung (generic-binary erkennt png-Magic)
  const r3 = await inspectAsset(fx.pfade.gross, { maxFileBytes: 1000 });
  assert.equal(r3.format, 'png');
  assert.equal(r3.status, 'teilweise');
});

test('sha256 nur bis maxHashBytes: darueber null + hash_uebersprungen, Inspektion laeuft trotzdem', async () => {
  const r = await inspectAsset(fx.pfade.gross, { maxHashBytes: 100, registry: grundRegistry() });
  pruefeSchema(r, 'hash');
  assert.equal(r.sha256, null);
  assert.ok(codes(r).includes('hash_uebersprungen'));
  assert.equal(r.status, 'ok');
  const r2 = await inspectAsset(fx.pfade.gross, { maxHashBytes: statSync(fx.pfade.gross).size, registry: grundRegistry() });
  assert.equal(r2.sha256, sha(fx.pfade.gross), 'genau an der Grenze wird gehasht');
});

test('Lesebudget (maxReadBytes): Ueberschreitung -> fehler + lesegrenze_ueberschritten, nichts wird gelesen', async () => {
  let gelesen = 0;
  const reg = testRegistry(async src => {
    const a = await src.readRange(0, 100);
    gelesen += a.length;
    const b = await src.readRange(100, 100);
    gelesen += b.length;
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const r = await inspectAsset(fx.pfade.gross, { maxReadBytes: 150, registry: reg });
  pruefeSchema(r, 'budget');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('lesegrenze_ueberschritten'));
  assert.equal(gelesen, 100, 'die zweite Lesung wird VOR dem Lesen abgelehnt');
  gelesen = 0;
  const r2 = await inspectAsset(fx.pfade.gross, { maxReadBytes: 200, registry: reg });
  assert.equal(r2.status, 'ok', 'genau am Budget geht noch');
  assert.equal(gelesen, 200);
  // Riesige Einzelanforderung: wird auf die Dateigroesse gedeckelt (keine 1-TiB-Allokation), das Budget zaehlt diese Bytes
  const reg3 = testRegistry(async src => {
    await src.readRange(0, 2 ** 40);
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const r3 = await inspectAsset(fx.pfade.gross, { maxReadBytes: 1000, registry: reg3 });
  assert.equal(r3.status, 'fehler');
  assert.ok(codes(r3).includes('lesegrenze_ueberschritten'));
  const r4 = await inspectAsset(fx.pfade.gross, { maxReadBytes: 100000, registry: reg3 });
  assert.equal(r4.status, 'ok', 'Gegenprobe: reicht das Budget fuer die ganze Datei, laeuft es durch (' + JSON.stringify(r4.warnings) + ')');
});

test('readRange: Dateiende kuerzt, hinter dem Ende leer, ungueltige Argumente kontrolliert', async () => {
  const gesehen = {};
  const reg = testRegistry(async src => {
    gesehen.ende = (await src.readRange(src.size - 3, 100)).length;
    gesehen.dahinter = (await src.readRange(src.size + 10, 5)).length;
    gesehen.null = (await src.readRange(0, 0)).length;
    for (const [o, l] of [[-1, 4], [0, -1], [1.5, 2], [0, NaN]]) {
      try {
        await src.readRange(o, l);
        gesehen['arg_' + o + '_' + l] = 'kein Fehler';
      } catch (e) {
        gesehen['arg_' + o + '_' + l] = e instanceof AssetReadError ? e.art : 'falsche Klasse ' + e;
      }
    }
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const r = await inspectAsset(fx.pfade.zipMinimal, { registry: reg });
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(gesehen.ende, 3);
  assert.equal(gesehen.dahinter, 0);
  assert.equal(gesehen.null, 0);
  for (const k of ['arg_-1_4', 'arg_0_-1', 'arg_1.5_2', 'arg_0_NaN']) assert.equal(gesehen[k], 'ungueltiges_argument', k);
});

test('Zeitgrenze: haengender Inspektor -> fehler + zeitgrenze, kommt rechtzeitig zurueck', async () => {
  const reg = testRegistry(() => new Promise(() => undefined)); // loest nie auf
  const t0 = Date.now();
  const r = await inspectAsset(fx.pfade.zipMinimal, { timeoutMs: 100, registry: reg });
  const dauer = Date.now() - t0;
  pruefeSchema(r, 'timeout');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('zeitgrenze'));
  assert.equal(codes(r).filter(c => c === 'zeitgrenze').length, 1, 'Warnung genau einmal');
  assert.ok(dauer < 2000, 'Rueckgabe nach ' + dauer + ' ms, Grenze war 100');
  assert.equal(r.inspector, 'test-fmt', 'Erkennung vor dem Timeout bleibt im Ergebnis');
});

test('Zeitgrenze: Rueckgabeobjekt wird nach dem Timeout nicht mehr veraendert', async () => {
  let freigeben;
  const warte = new Promise(res => (freigeben = res));
  const reg = testRegistry(async (src, ctx) => {
    await warte;
    ctx.warn('spaet', 'kommt nach dem Timeout');
    return erzeugeAssetResult(src.filePath, src.size, { format: 'tst', status: 'ok' });
  });
  const r = await inspectAsset(fx.pfade.zipMinimal, { timeoutMs: 50, registry: reg });
  const vorher = JSON.stringify(r);
  freigeben();
  await new Promise(res => setTimeout(res, 50));
  assert.equal(JSON.stringify(r), vorher, 'spaete Arbeit hat das Ergebnis veraendert');
  assert.ok(!codes(r).includes('spaet'));
});

test('Zeitgrenze: Inspektor mit await-loser Schleife wird ueber ctx.pruefeAbbruch gestoppt', async () => {
  const reg = testRegistry(async (src, ctx) => {
    const ende = Date.now() + 1500;
    while (Date.now() < ende) ctx.pruefeAbbruch();
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const t0 = Date.now();
  const r = await inspectAsset(fx.pfade.zipMinimal, { timeoutMs: 80, registry: reg });
  assert.ok(Date.now() - t0 < 1000, 'Schleife wurde nicht abgebrochen');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('zeitgrenze'));
});

test('abgeschnittene Datei: Magic da, Rest fehlt -> AssetReadError wird zu fehler + lesefehler', async () => {
  const reg = new AssetRegistry();
  reg.register({
    id: 'test-glb',
    formats: ['glb'],
    extensions: ['.glb'],
    magic: [{ offset: 0, bytes: [0x67, 0x6c, 0x54, 0x46] }],
    version: 3,
    inspect: async (src, ctx) => {
      const kopf = await leseReader(src, 0, 12); // GLB-Kopf: magic, version, laenge
      kopf.skip(4);
      const version = kopf.u32le();
      const laenge = kopf.u32le();
      return erzeugeAssetResult(src.filePath, src.size, { asset_type: 'model3d', format: 'glb', metadata: { version, laenge } });
    },
  });
  const heil = await inspectAsset(fx.pfade.glbMinimal, { registry: reg });
  pruefeSchema(heil, 'glb-heil');
  assert.equal(heil.status, 'ok', JSON.stringify(heil.warnings));
  assert.equal(heil.metadata.version, 2);
  assert.equal(heil.metadata.laenge, statSync(fx.pfade.glbMinimal).size);
  assert.equal(heil.parser_version, 3);

  const kaputt = await inspectAsset(fx.pfade.glbAbgeschnitten, { registry: reg });
  pruefeSchema(kaputt, 'glb-abgeschnitten');
  assert.equal(kaputt.status, 'fehler');
  assert.ok(codes(kaputt).includes('lesefehler'), JSON.stringify(kaputt.warnings));
  assert.equal(kaputt.format, 'glb', 'Erkennung bleibt erhalten');
  assert.equal(kaputt.size, 10);
  assert.equal(kaputt.sha256, sha(fx.pfade.glbAbgeschnitten));
});

test('kaputte Datei (Endung ohne Magic): Treffer ueber Endung + magic_fehlt, Inspektor-Fehler wird Warnung', async () => {
  const reg = new AssetRegistry();
  reg.register({
    id: 'test-glb',
    formats: ['glb'],
    extensions: ['.glb'],
    magic: [{ offset: 0, bytes: [0x67, 0x6c, 0x54, 0x46] }],
    version: 1,
    inspect: async src => {
      const k = await leseReader(src, 0, 4);
      if (k.u32be() !== 0x676c5446) throw new Error('kein glTF-Kopf');
      return erzeugeAssetResult(src.filePath, src.size);
    },
  });
  const r = await inspectAsset(fx.pfade.glbKaputt, { registry: reg });
  pruefeSchema(r, 'glb-kaputt');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('magic_fehlt'));
  assert.ok(codes(r).includes('inspektor_fehler'));
  assert.ok(r.warnings.find(w => w.code === 'inspektor_fehler').message.includes('kein glTF-Kopf'));
});

test('Inspektor wirft Nicht-Error, undefined oder Muell: immer Ergebnis, nie Wurf', async () => {
  const faelle = [
    async () => { throw 'nur ein Text'; },
    async () => { throw null; },
    async () => undefined,
    async () => 42,
    () => { throw new RangeError('boese'); },
  ];
  for (const [i, f] of faelle.entries()) {
    const r = await inspectAsset(fx.pfade.zipMinimal, { registry: testRegistry(f) });
    pruefeSchema(r, 'muell' + i);
    assert.equal(r.status, 'fehler', 'Fall ' + i);
    assert.ok(codes(r).includes('inspektor_fehler'), 'Fall ' + i + ': ' + JSON.stringify(r.warnings));
  }
});

test('Objekte und Referenzen werden auf maxObjects gekappt (Warnung + Status teilweise)', async () => {
  const reg = testRegistry(async src =>
    erzeugeAssetResult(src.filePath, src.size, {
      format: 'tst',
      objects: Array.from({ length: 25 }, (_, i) => ({ name: 'o' + i, kind: 'mesh', data: {}, source_range: { offset: i, length: 1 } })),
      references: Array.from({ length: 7 }, (_, i) => ({ target: 't' + i, kind: 'texture' })),
    })
  );
  const r = await inspectAsset(fx.pfade.zipMinimal, { maxObjects: 10, registry: reg });
  pruefeSchema(r, 'objekte');
  assert.equal(r.objects.length, 10);
  assert.equal(r.references.length, 7);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.ok(!codes(r).includes('referenzen_gekappt'));
  const r2 = await inspectAsset(fx.pfade.zipMinimal, { maxObjects: 25, registry: reg });
  assert.equal(r2.objects.length, 25);
  assert.equal(r2.status, 'ok', 'genau an der Grenze wird nichts gekappt');
  const r3 = await inspectAsset(fx.pfade.zipMinimal, { maxObjects: 5, registry: reg });
  assert.ok(codes(r3).includes('referenzen_gekappt'));
});

test('Objekt-Positionen (Byte- und Zeilenbereich) und Referenzen bleiben unveraendert erhalten', async () => {
  const reg = testRegistry(async src =>
    erzeugeAssetResult(src.filePath, src.size, {
      format: 'tst',
      objects: [
        { name: 'a', kind: 'chunk', data: { x: 1 }, source_range: { offset: 12, length: 8 } },
        { name: null, kind: 'zeile', data: {}, source_range: { line_start: 3, line_end: 9 } },
      ],
      references: [{ target: 'tex/a.png', kind: 'texture', resolved: false }],
      metadata: { breite: 4 },
      format_specific: { roh: true },
    })
  );
  const r = await inspectAsset(fx.pfade.zipMinimal, { registry: reg });
  assert.deepEqual(r.objects[0].source_range, { offset: 12, length: 8 });
  assert.deepEqual(r.objects[1].source_range, { line_start: 3, line_end: 9 });
  assert.equal(r.objects[1].name, null);
  assert.deepEqual(r.references, [{ target: 'tex/a.png', kind: 'texture', resolved: false }]);
  assert.deepEqual(r.metadata, { breite: 4 });
  assert.deepEqual(r.format_specific, { roh: true });
});

test('Tiefengrenze: ctx.tiefer() wirft ueber maxDepth, ctx.warn landet im Ergebnis', async () => {
  const reg = testRegistry(async (src, ctx) => {
    ctx.warn('hinweis', 'aus dem Inspektor');
    let c = ctx;
    for (let i = 0; i < 5; i++) c = c.tiefer();
    return erzeugeAssetResult(src.filePath, src.size);
  });
  const r = await inspectAsset(fx.pfade.zipMinimal, { maxDepth: 3, registry: reg });
  pruefeSchema(r, 'tiefe');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('tiefengrenze_ueberschritten'));
  assert.ok(codes(r).includes('hinweis'));
  const r2 = await inspectAsset(fx.pfade.zipMinimal, { maxDepth: 5, registry: reg });
  assert.equal(r2.status, 'ok', 'genau fuenf Ebenen bei maxDepth 5 gehen');
});

test('Warnungen des Inspektors im Ergebnis werden uebernommen; Status des Inspektors bleibt', async () => {
  const reg = testRegistry(async src =>
    erzeugeAssetResult(src.filePath, src.size, { status: 'teilweise', warnings: [{ code: 'x_unbekannt', message: 'Chunk uebersprungen' }] })
  );
  const r = await inspectAsset(fx.pfade.zipMinimal, { registry: reg });
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('x_unbekannt'));
});

test('Kernfelder der Quelle gehoeren inspectAsset: Inspektor kann file_path, size, sha256 nicht faelschen', async () => {
  const reg = testRegistry(async () => ({ file_path: '/boese', size: 999999, sha256: 'ff', format: 'tst', asset_type: 'x' }));
  const r = await inspectAsset(fx.pfade.zipMinimal, { registry: reg });
  assert.equal(r.file_path, fx.pfade.zipMinimal);
  assert.equal(r.size, statSync(fx.pfade.zipMinimal).size);
  assert.equal(r.sha256, sha(fx.pfade.zipMinimal));
  pruefeSchema(r, 'gefaelscht');
});

test('unsinnige Optionen und Eingaben werfen nie', async () => {
  const r1 = await inspectAsset(fx.pfade.pngMinimal, { maxFileBytes: NaN, maxReadBytes: -5, timeoutMs: 0, maxObjects: 'viel', maxDepth: Infinity, registry: grundRegistry() });
  pruefeSchema(r1, 'optionen');
  assert.equal(r1.status, 'ok', 'NaN/negativ/0/Text fallen auf den Standard zurueck');
  for (const eingabe of [undefined, null, 42, '', '\0', {}]) {
    const r = await inspectAsset(eingabe);
    pruefeSchema(r, 'eingabe ' + String(eingabe));
    assert.notEqual(r.status, 'ok');
  }
});

test('nur lesend: Inhalt und mtime der Quelle bleiben nach der Inspektion unveraendert', async () => {
  const p = fx.pfade.pngMinimal;
  const vorher = { hash: sha(p), mtime: statSync(p).mtimeMs, size: statSync(p).size };
  await inspectAsset(p);
  await inspectAsset(p, { maxReadBytes: 1 });
  assert.deepEqual({ hash: sha(p), mtime: statSync(p).mtimeMs, size: statSync(p).size }, vorher);
});

test('Standardgrenzen sind gesetzt, eingefroren und vollstaendig', () => {
  for (const k of ['maxFileBytes', 'maxReadBytes', 'maxObjects', 'timeoutMs', 'maxDepth', 'maxHashBytes']) {
    assert.ok(Number.isFinite(STANDARD_GRENZEN[k]) && STANDARD_GRENZEN[k] > 0, k);
  }
  assert.ok(Object.isFrozen(STANDARD_GRENZEN));
});

test('Fixtures sind deterministisch: zwei Laeufe ergeben gleiche Hashes, Dateinamen und Groessen', async () => {
  const a = await erzeugeFixtures();
  const b = await erzeugeFixtures();
  try {
    assert.notEqual(a.dir, b.dir);
    assert.ok(a.dir.startsWith(tmpdir()), 'Fixtures liegen unter os.tmpdir()');
    assert.deepEqual(Object.keys(a.pfade), Object.keys(b.pfade));
    for (const k of Object.keys(a.pfade)) assert.equal(sha(a.pfade[k]), sha(b.pfade[k]), k + ' nicht deterministisch');
    assert.ok(Object.keys(a.pfade).length >= 9);
  } finally {
    await a.aufraeumen();
    await b.aufraeumen();
  }
});
