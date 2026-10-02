/**
 * Asset-Intel DCC-Inspektoren (P4-T62): .blend, .fbx, .usda/.usdc/.usd, .usdz — gegen gebautes dist.
 * Bloecke:
 *  - SPEC: handgebaute Dateien nach Spezifikation (scripts/asset-fixtures-dcc.mjs).
 *  - ECHT (Werkzeug): von blender / usdcat / usdzip erzeugt; fehlt ein Werkzeug -> skip.
 *  - PROBEN: ~/dev/synapse-testdaten/asset-samples (Env ASSET_SAMPLES_DIR); fehlt das Verzeichnis -> skip.
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-dcc/dist node --test packages/core/tests/asset-intel-dcc.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(pathToFileURL(join(dist, 'asset-intel', 'index.js')).href);
const D = await import(pathToFileURL(join(dist, 'asset-intel', 'inspectors', 'dcc', 'index.js')).href);
const { inspectAsset, AssetRegistry, genericBinaryInspector } = A;
const { erzeugeDccFixtures, erzeugeEchteDccFixtures } = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-dcc.mjs')).href);

const KERNFELDER = ['asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata', 'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific'];
const codes = r => r.warnings.map(w => w.code);
const obj = (r, kind, name) => r.objects.find(o => o.kind === kind && o.name === name);
const ref = (r, kind, target) => r.references.find(x => x.kind === kind && x.target === target);

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, `${wo}: Feld fehlt: ${k}`);
  assert.ok(['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'].includes(r.status), `${wo}: status ${r.status}`);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), `${wo}: ${k}`);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', `${wo}: warning-Form`);
  for (const o of r.objects) {
    assert.equal(typeof o.kind, 'string', `${wo}: kind`);
    assert.ok(o.name === null || typeof o.name === 'string', `${wo}: name`);
    assert.ok(o.data && typeof o.data === 'object', `${wo}: data`);
    assert.ok(o.source_range, `${wo}: source_range fehlt bei ${o.kind}:${o.name}`);
    if ('offset' in o.source_range) {
      assert.ok(Number.isInteger(o.source_range.offset) && o.source_range.offset >= 0 && o.source_range.length >= 0, `${wo}: Byte-Bereich`);
    } else {
      assert.ok(o.source_range.line_start >= 1 && o.source_range.line_end >= o.source_range.line_start, `${wo}: Zeilenbereich ${JSON.stringify(o.source_range)}`);
    }
  }
  for (const x of r.references) assert.ok(typeof x.target === 'string' && typeof x.kind === 'string', `${wo}: Referenz-Form`);
  JSON.stringify(r);
}

/** Registry nur mit den DCC-Inspektoren. */
function dccRegistry(...extra) {
  const reg = new AssetRegistry();
  for (const i of [...D.assetDccInspektoren, ...extra]) reg.register(i);
  return reg;
}
const REG = dccRegistry();
const lauf = (p, opts = {}) => inspectAsset(p, { registry: REG, ...opts });

/** Anker-Pruefung (regel-nullzusagen-brauchen-anker): Zeile N der Datei muss text enthalten. */
function anker(pfad, zeile, text) {
  const z = readFileSync(pfad, 'utf8').split('\n')[zeile - 1] ?? '';
  assert.ok(z.includes(text), `Anker: Zeile ${zeile} von ${pfad} soll "${text}" enthalten, ist "${z}"`);
}

let fx;
before(async () => {
  fx = await erzeugeDccFixtures();
});
after(async () => {
  await fx?.aufraeumen();
});

// ------------------------------------------------------------------ Grundlagen

test('Export: vier Inspektoren mit Endungen/Magic wie zugesagt', () => {
  const ids = D.assetDccInspektoren.map(i => i.id);
  assert.deepEqual(ids, ['dcc-blend', 'dcc-fbx', 'dcc-usd', 'dcc-usdz']);
  const usdz = D.assetDccInspektoren.find(i => i.id === 'dcc-usdz');
  assert.deepEqual(usdz.extensions, ['.usdz']);
  assert.ok(usdz.magic.length > 0 && usdz.magic.every(m => m.offset === 0 && m.bytes.length === 10 && m.bytes[0] === 0x50 && m.bytes[1] === 0x4b && m.bytes[8] === 0 && m.bytes[9] === 0), 'usdz traegt nur den engen Zip-Kopf (Methode 0)');
  for (const i of D.assetDccInspektoren) assert.ok(Number.isInteger(i.version) && i.version >= 1);
});

test('alle Spec-Fixtures: wirft nie, Schema vollstaendig, serialisierbar', async () => {
  for (const [k, p] of Object.entries(fx.pfade)) {
    const r = await lauf(p);
    pruefeSchema(r, k);
  }
});

// ------------------------------------------------------------------ .blend

async function pruefeBlendSpec(p, wo) {
  const r = await lauf(p);
  pruefeSchema(r, wo);
  assert.equal(r.inspector, 'dcc-blend', wo);
  assert.equal(r.format, 'blend');
  assert.equal(r.asset_type, 'scene');
  const sz = obj(r, 'scene', 'Szene');
  assert.ok(sz, wo + ': Szene');
  assert.equal(sz.data.bild_start, 10);
  assert.equal(sz.data.bild_ende, 90);
  assert.equal(sz.data.fps, 30);
  assert.equal(sz.data.kamera, 'Kamera');
  const kam = obj(r, 'object', 'Kamera');
  assert.equal(kam.data.objekt_typ, 'camera');
  assert.equal(kam.data.eltern, 'Elternteil');
  assert.deepEqual(obj(r, 'object', 'Elternteil').data.daten, { name: 'Netz', art: 'mesh' });
  const netz = obj(r, 'mesh', 'Netz');
  assert.equal(netz.data.vertices, 8);
  assert.equal(netz.data.flaechen, 6);
  assert.equal(obj(r, 'image', 'Bild').data.pfad, '//tex/fehlt.png');
  assert.deepEqual(ref(r, 'texture', '//tex/fehlt.png'), { target: '//tex/fehlt.png', kind: 'texture', resolved: false });
  assert.deepEqual(ref(r, 'library', '//lib_fehlt.blend'), { target: '//lib_fehlt.blend', kind: 'library', resolved: false });
  const vk = obj(r, 'verknuepft', 'Verknuepft');
  assert.equal(vk.data.verknuepft, true);
  assert.equal(vk.data.bibliothek, '//lib_fehlt.blend');
  assert.equal(r.metadata.bloecke.OB.anzahl, 2);
  assert.equal(r.metadata.ids.object, 2);
  return r;
}

test('blend SPEC alt 64 Bit (BLENDER-v293, BHead8): Namen, Hierarchie, Szene, Referenzen', async () => {
  const r = await pruefeBlendSpec(fx.pfade.blend64, 'blend64');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.metadata.blender_version, '2.93');
  assert.equal(r.metadata.zeigergroesse, 8);
  assert.equal(r.format_specific.kopf_format, 'alt');
  assert.equal(r.format_specific.blockkopf, 'bhead8');
  // source_range zeigt auf den Blockkopf: dort steht der Code.
  const buf = readFileSync(fx.pfade.blend64);
  const kam = obj(r, 'object', 'Kamera');
  assert.equal(buf.toString('latin1', kam.source_range.offset, kam.source_range.offset + 2), 'OB');
  assert.ok(kam.source_range.offset + kam.source_range.length <= buf.length);
});

test('blend SPEC alt 32 Bit (BLENDER_v293, BHead4)', async () => {
  const r = await pruefeBlendSpec(fx.pfade.blend32, 'blend32');
  assert.equal(r.metadata.zeigergroesse, 4);
  assert.equal(r.format_specific.blockkopf, 'bhead4');
  assert.equal(r.status, 'ok');
});

test('blend SPEC Big-Endian (BLENDER-V293): gelesen, aber als ungeprueft markiert', async () => {
  const r = await pruefeBlendSpec(fx.pfade.blendBE, 'blendBE');
  assert.equal(r.metadata.endian, 'big');
  assert.ok(codes(r).includes('big_endian_ungeprueft'));
});

test('blend SPEC neues Format (BLENDER17-01v0501, LargeBHead8)', async () => {
  const r = await pruefeBlendSpec(fx.pfade.blendNeu, 'blendNeu');
  assert.equal(r.format_specific.kopf_format, 'neu');
  assert.equal(r.format_specific.dateiformat_version, 1);
  assert.equal(r.format_specific.blockkopf, 'large8');
  assert.equal(r.metadata.blender_version, '5.1');
});

test('blend gzip: entpackt mit Kappe, gleiche Objekte; nur ueber die Endung erkannt', async () => {
  const r = await pruefeBlendSpec(fx.pfade.blendGzip, 'blendGzip');
  assert.equal(r.metadata.komprimierung, 'gzip');
  assert.equal(r.format_specific.offsets_beziehen_sich_auf, 'entpackten_inhalt');
  assert.ok(!codes(r).includes('magic_fehlt'), 'Erkennung per gzip-Magic (seit der Verdrahtung traegt dcc-blend sie mit)');
});

test('blend zstd mehrere Frames (wie Blender): alle Frames entpackt', async t => {
  if (!fx.pfade.blendZstd) return t.skip('zstd in dieser Node-Version nicht verfuegbar');
  const r = await pruefeBlendSpec(fx.pfade.blendZstd, 'blendZstd');
  assert.equal(r.metadata.komprimierung, 'zstd');
  assert.equal(r.format_specific.zstd_frames, 2);
  assert.equal(r.format_specific.entpackt_bytes, readFileSync(fx.pfade.blend64).length);
});

test('blend zstd (Roh-Frame, jede Node-Version): mit zstd gelesen, ohne zstd teilweise + nur_erkannt', async t => {
  const p = fx.pfade.blendZstdRoh;
  if (typeof zlib.zstdDecompressSync === 'function') {
    t.diagnostic(`Node ${process.version} hat zstd: Inhalt wird gelesen`);
    const r = await pruefeBlendSpec(p, 'blendZstdRoh');
    assert.equal(r.status, 'ok');
    assert.equal(r.format_specific.zstd_frames, 1);
    assert.equal(r.format_specific.entpackt_bytes, readFileSync(fx.pfade.blend64).length);
  } else {
    t.diagnostic(`Node ${process.version} ohne zstd: nur_erkannt-Zweig wird positiv geprueft`);
    const r = await lauf(p);
    pruefeSchema(r, 'blendZstdRoh');
    assert.equal(r.inspector, 'dcc-blend');
    assert.equal(r.status, 'teilweise');
    assert.equal(r.metadata.komprimierung, 'zstd');
    assert.ok(codes(r).includes('nur_erkannt'), codes(r).join());
    assert.equal(r.objects.length, 0);
  }
});

test('blend abgeschnitten: teilweise, kein Wurf', async () => {
  const r = await lauf(fx.pfade.blendAbgeschnitten);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).some(c => ['endb_fehlt', 'block_ausserhalb', 'dna_fehlt'].includes(c)), codes(r).join());
});

test('blend boesartig: Blocklaenge weit ueber Dateigroesse -> block_ausserhalb', async () => {
  const r = await lauf(fx.pfade.blendBoese);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('block_ausserhalb'));
  assert.ok(r.metadata.block_anzahl >= 3, 'Bloecke davor wurden gelesen');
});

test('blend unbekannte Formatversion: nur_erkannt, teilweise', async () => {
  const r = await lauf(fx.pfade.blendUnbekannt);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('nur_erkannt'));
  assert.equal(r.format_specific.dateiformat_version, 2);
});

test('blend leer: Erkennung per Endung, teilweise', async () => {
  const r = await lauf(fx.pfade.blendLeer);
  assert.equal(r.inspector, 'dcc-blend');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('datei_leer'));
});

test('Endung passt nicht zum Inhalt: FBX-Bytes als .blend -> FBX-Inspektor gewinnt per Magic', async () => {
  const r = await lauf(fx.pfade.fbxAlsBlend);
  assert.equal(r.inspector, 'dcc-fbx');
  assert.ok(codes(r).includes('endung_widerspricht_inhalt'));
  assert.equal(r.status, 'ok');
});

test('blend maxObjects: gekappt + Warnung', async () => {
  const r = await lauf(fx.pfade.blend64, { maxObjects: 3 });
  assert.equal(r.objects.length, 3);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('objekte_gekappt'));
});

// ------------------------------------------------------------------ FBX

async function pruefeFbxSpec(p, wo) {
  const r = await lauf(p);
  pruefeSchema(r, wo);
  assert.equal(r.inspector, 'dcc-fbx', wo);
  assert.equal(r.asset_type, 'model3d');
  assert.equal(r.metadata.creator, 'Synapse Spec-Fixture');
  assert.equal(r.metadata.erstellzeit, '2026-10-02T12:30:05');
  assert.equal(r.metadata.erstellt, '2026-10-02 12:30:05:000');
  assert.equal(r.metadata.global.UpAxis, 1);
  assert.equal(r.metadata.global.FrontAxis, 2);
  assert.equal(r.metadata.global.UnitScaleFactor, 2.54);
  assert.deepEqual(r.metadata.objekte, { geometry: 1, model: 2, material: 1, texture: 1, video: 1, animationstack: 1, deformer: 1, pose: 1 });
  assert.equal(r.metadata.verbindungen, 3);
  const g = obj(r, 'geometry', 'Wuerfel');
  assert.equal(g.data.vertices, 8);
  assert.equal(g.data.polygon_indizes, 8);
  assert.equal(g.data.typ, 'Mesh');
  assert.equal(g.data.id, 100);
  assert.deepEqual(obj(r, 'model', 'Wuerfel').data.translation, [1, 2, 3]);
  assert.equal(obj(r, 'model', 'Knochen').data.typ, 'LimbNode');
  assert.equal(obj(r, 'deformer', 'Haut').data.typ, 'Skin');
  assert.equal(obj(r, 'video', 'HolzVid').data.eingebettet, true);
  assert.deepEqual(ref(r, 'texture', 'tex/holz_fehlt.png'), { target: 'tex/holz_fehlt.png', kind: 'texture', resolved: false });
  assert.deepEqual(ref(r, 'texture', 'tex/vorhanden.png'), { target: 'tex/vorhanden.png', kind: 'texture', resolved: true });
  const buf = readFileSync(p);
  const gr = g.source_range;
  assert.equal(buf.toString('latin1', gr.offset + (r.format_specific.knoten_offsets === 64 ? 25 : 13), gr.offset + (r.format_specific.knoten_offsets === 64 ? 25 : 13) + 8), 'Geometry');
  return r;
}

test('fbx SPEC binaer 7400 (32-Bit-Offsets): Kopf, Achsen, Objekte, Geometrie-Zahlen, Texturen', async () => {
  const r = await pruefeFbxSpec(fx.pfade.fbx7400, 'fbx7400');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.metadata.fbx_version, 7400);
  assert.equal(r.format_specific.knoten_offsets, 32);
});

test('fbx SPEC binaer 7500 (64-Bit-Offsets)', async () => {
  const r = await pruefeFbxSpec(fx.pfade.fbx7500, 'fbx7500');
  assert.equal(r.status, 'ok');
  assert.equal(r.format_specific.knoten_offsets, 64);
});

test('fbx SPEC 7700 mit zlib-Arrays: Zahlen aus dem Arraykopf, nichts entpackt', async () => {
  const r = await pruefeFbxSpec(fx.pfade.fbxKomprimiert, 'fbxKomp');
  assert.equal(r.status, 'ok');
});

test('fbx abgeschnitten: teilweise mit Warnung, Objekte davor bleiben', async () => {
  const r = await lauf(fx.pfade.fbxAbgeschnitten);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).some(c => ['abgeschnitten', 'knoten_ausserhalb'].includes(c)), codes(r).join());
  assert.equal(r.metadata.creator, 'Synapse Spec-Fixture');
});

test('fbx boesartig: Knoten-Ende hinter der Datei -> knoten_ausserhalb', async () => {
  const r = await lauf(fx.pfade.fbxBoese);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('knoten_ausserhalb'));
  assert.equal(r.objects.length, 0);
});

test('fbx Tiefenbombe (100 Ebenen): tiefengrenze, kein Stackueberlauf', async () => {
  const r = await lauf(fx.pfade.fbxBombe);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('tiefengrenze'));
});

test('fbx riesige Array-Deklaration: unplausibel/ungueltig gemeldet, nichts allokiert', async () => {
  const r = await lauf(fx.pfade.fbxRiesig);
  assert.ok(codes(r).includes('array_unplausibel'), codes(r).join());
  assert.ok(codes(r).includes('eigenschaft_ungueltig'), codes(r).join());
  assert.equal(r.status, 'teilweise');
});

test('fbx SPEC ASCII 7.4: gleiche Kerndaten ueber Zeilenscanner, Zeilenbereiche mit Anker', async () => {
  const p = fx.pfade.fbxAscii;
  const r = await lauf(p);
  pruefeSchema(r, 'ascii');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.format_specific.kodierung, 'ascii');
  assert.equal(r.metadata.fbx_version, 7400);
  assert.equal(r.metadata.creator, 'Synapse ASCII-Fixture');
  assert.equal(r.metadata.erstellzeit, '2026-10-02T08:15:00');
  assert.equal(r.metadata.global.UpAxis, 2);
  assert.equal(r.metadata.global.UnitScaleFactor, 100);
  assert.equal(r.metadata.verbindungen, 2);
  const g = obj(r, 'geometry', 'Wuerfel');
  assert.equal(g.data.vertices, 8);
  assert.equal(g.data.polygon_indizes, 8);
  assert.equal(g.data.klasse, 'Geometry');
  anker(p, g.source_range.line_start, 'Geometry: 100, "Geometry::Wuerfel"');
  anker(p, g.source_range.line_end, '}');
  assert.ok(g.source_range.line_end > g.source_range.line_start + 5);
  assert.deepEqual(obj(r, 'model', 'Wuerfel').data.translation, [4, 5, 6]);
  assert.deepEqual(ref(r, 'texture', 'tex\\vorhanden.png'), { target: 'tex\\vorhanden.png', kind: 'texture', resolved: true });
});

test('fbx SPEC ASCII 6.1: Werte ueber Folgezeilen gezaehlt, Connect gezaehlt', async () => {
  const r = await lauf(fx.pfade.fbxAscii61);
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.fbx_version, 6100);
  const m = obj(r, 'model', 'Alt');
  assert.equal(m.data.vertices, 4);
  assert.equal(m.data.polygon_indizes, 3);
  assert.equal(m.data.typ, 'Mesh');
  assert.ok(obj(r, 'material', 'Lack'));
  assert.equal(r.metadata.verbindungen, 1);
});

test('fbx ASCII mit offener Klammer am Dateiende: klammer_ungleichgewicht', async () => {
  const r = await lauf(fx.pfade.fbxAsciiOffen);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('klammer_ungleichgewicht'));
});

// ------------------------------------------------------------------ USD

test('usda SPEC reich: Layer-Metadaten, Hierarchie, Varianten, Referenzen, rel, Zeilenanker', async () => {
  const p = fx.pfade.usda;
  const r = await lauf(p);
  pruefeSchema(r, 'usda');
  assert.equal(r.inspector, 'dcc-usd');
  assert.equal(r.format, 'usda');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  const m = r.metadata;
  assert.equal(m.usda_version, '1.0');
  assert.equal(m.defaultPrim, 'Welt');
  assert.equal(m.metersPerUnit, 0.01);
  assert.equal(m.upAxis, 'Y');
  assert.equal(m.startTimeCode, 1);
  assert.equal(m.endTimeCode, 240);
  assert.equal(m.timeCodesPerSecond, 24);
  assert.deepEqual(m.subLayers, ['./sub_fehlt.usda', './ref.usda']);
  assert.ok(m.doc.includes('{ geschweiften }'));
  const pfade = r.objects.filter(o => o.kind === 'prim').map(o => o.data.pfad);
  assert.deepEqual(pfade, [
    '/_Basis', '/Welt', '/Welt/Kiste', '/Welt/Looks', '/Welt/Looks/Holz', '/Welt/Looks/Holz/Bild',
    '/Welt{farbe=rot}RotGeo', '/Welt{farbe=blau}BlauGeo', '/Welt/Ueberschrieben',
  ]);
  assert.equal(m.prim_anzahl, 9);
  const welt = obj(r, 'prim', 'Welt');
  assert.equal(welt.data.kind, 'assembly');
  assert.deepEqual(welt.data.varianten_auswahl, { farbe: 'rot' });
  assert.deepEqual(welt.data.variant_sets, ['farbe']);
  assert.deepEqual(welt.data.variant_sets_def, { farbe: ['rot', 'blau'] });
  anker(p, welt.source_range.line_start, 'def Xform "Welt"');
  anker(p, welt.source_range.line_end, '}');
  const kiste = obj(r, 'prim', 'Kiste');
  assert.equal(kiste.data.typ, null);
  assert.deepEqual(kiste.data.referenzen, [{ asset: './ref.usda', prim: '/Ziel' }]);
  assert.equal(kiste.data.references_op, 'prepend');
  assert.deepEqual(kiste.data.payloads, [{ asset: './schwer_fehlt.usd', prim: null }]);
  assert.deepEqual(kiste.data.inherits, ['/_Basis']);
  assert.deepEqual(kiste.data.api_schemas, ['MaterialBindingAPI', 'CollisionAPI']);
  assert.equal(kiste.data.punkte, 4);
  assert.equal(kiste.data.flaechen, 1);
  assert.equal(kiste.data.material, '/Welt/Looks/Holz');
  anker(p, kiste.source_range.line_start, 'def "Kiste"');
  const rel = obj(r, 'rel', 'material:binding');
  assert.deepEqual(rel.data, { prim: '/Welt/Kiste', ziele: ['/Welt/Looks/Holz'] });
  anker(p, rel.source_range.line_start, 'rel material:binding');
  assert.equal(obj(r, 'prim', 'Ueberschrieben').data.spezifizierer, 'over');
  assert.equal(obj(r, 'prim', '_Basis').data.spezifizierer, 'class');
  const refs = Object.fromEntries(r.references.map(x => [x.kind + ' ' + x.target, x.resolved]));
  assert.deepEqual(refs, {
    'sublayer ./sub_fehlt.usda': false,
    'sublayer ./ref.usda': true,
    'reference ./ref.usda': true,
    'payload ./schwer_fehlt.usd': false,
    'texture ./tex/fehlt.png': false,
    'texture ../aussen/textur.png': false,
  });
  assert.ok(codes(r).includes('pfad_traversal'));
});

test('usda unter .usd-Endung: Inhalt entscheidet (usda)', async () => {
  const r = await lauf(fx.pfade.usdaAlsUsd);
  assert.equal(r.format, 'usda');
  assert.equal(r.metadata.prim_anzahl, 9);
});

test('usda Klammer-Ungleichgewicht: teilweise, Prims davor bleiben', async () => {
  const r = await lauf(fx.pfade.usdaOffen);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('klammer_ungleichgewicht'));
  assert.ok(obj(r, 'prim', 'Ueberschrieben'));
});

test('usda Rekursionsbombe (200 Ebenen): tiefengrenze bei 128, iterativ uebersprungen', async () => {
  const r = await lauf(fx.pfade.usdaTief);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('tiefengrenze'));
  assert.equal(r.metadata.prim_anzahl, 128);
  assert.equal(r.metadata.max_tiefe, 128);
  assert.ok(!codes(r).includes('klammer_ungleichgewicht'), 'Uebersprungenes ist trotzdem ausgeglichen');
});

test('usda riesiges Array (100000 Tupel): nur gezaehlt, nicht gespeichert', async () => {
  const r = await lauf(fx.pfade.usdaRiesig);
  assert.equal(r.status, 'ok');
  assert.equal(obj(r, 'prim', 'Gross').data.punkte, 100_000);
  assert.equal(r.format_specific.array_elemente_gezaehlt, 100_000);
  assert.ok(JSON.stringify(r).length < 4000, 'Ergebnis bleibt klein');
});

test('usda Array ohne Ende: klammer_ungleichgewicht', async () => {
  const r = await lauf(fx.pfade.usdaArrayOffen);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('klammer_ungleichgewicht'));
});

test('usda maxObjects: gekappt', async () => {
  const r = await lauf(fx.pfade.usdaViele, { maxObjects: 10 });
  assert.equal(r.objects.length, 10);
  assert.equal(r.metadata.prim_anzahl, 50);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('objekte_gekappt'));
});

test('usda ohne Kopf: fehler + magic_fehlt', async () => {
  const r = await lauf(fx.pfade.usdaOhneKopf);
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('kein_usda_kopf'));
  assert.ok(codes(r).includes('magic_fehlt'));
});

test('usdc SPEC: Kopf + TOC, teilweise mit usdc_nicht_dekodiert; .usd mit Crate-Magic -> usdc', async () => {
  for (const p of [fx.pfade.usdc, fx.pfade.usdcAlsUsd]) {
    const r = await lauf(p);
    pruefeSchema(r, p);
    assert.equal(r.format, 'usdc');
    assert.equal(r.status, 'teilweise');
    assert.deepEqual(codes(r), ['usdc_nicht_dekodiert']);
    assert.equal(r.metadata.usdc_version, '0.8.0');
    assert.deepEqual(r.metadata.sections.map(s => s.name), ['TOKENS', 'STRINGS', 'FIELDS', 'FIELDSETS', 'PATHS', 'SPECS']);
    assert.ok(r.metadata.sections.every(s => s.gueltig && s.groesse === 16));
  }
});

test('usdc boesartig: TOC hinter Dateiende, Abschnitt ausserhalb, abgeschnitten', async () => {
  const a = await lauf(fx.pfade.usdcTocKaputt);
  assert.ok(codes(a).includes('toc_ausserhalb'));
  const b = await lauf(fx.pfade.usdcAbschnittKaputt);
  assert.ok(codes(b).includes('abschnitt_ausserhalb'));
  assert.equal(b.metadata.sections.filter(s => !s.gueltig).length, 1);
  const c = await lauf(fx.pfade.usdcAbgeschnitten);
  assert.equal(c.status, 'fehler');
  assert.ok(codes(c).includes('abgeschnitten'));
});

// ------------------------------------------------------------------ USDZ

test('usdz SPEC: Eintraege ausgerichtet, Layer ueber AusschnittQuelle, Pfade gegen das Paket', async () => {
  const r = await lauf(fx.pfade.usdz);
  pruefeSchema(r, 'usdz');
  assert.equal(r.inspector, 'dcc-usdz');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.eintraege, 2);
  assert.equal(r.metadata.regeln_eingehalten, true);
  assert.equal(r.metadata.layer, 'kiste.usda');
  assert.equal(r.format_specific.layer.format, 'usda');
  assert.equal(r.format_specific.layer.metadata.defaultPrim, 'Kiste');
  for (const e of r.objects.filter(o => o.kind === 'paket_eintrag')) assert.equal(e.source_range.offset % 64, 0);
  const buf = readFileSync(fx.pfade.usdz);
  const layerE = obj(r, 'paket_eintrag', 'kiste.usda');
  assert.equal(buf.toString('utf8', layerE.source_range.offset, layerE.source_range.offset + 5), '#usda');
  assert.equal(obj(r, 'prim', 'Bild').data.paket_datei, 'kiste.usda');
  const refs = Object.fromEntries(r.references.map(x => [x.kind + ' ' + x.target, x.resolved]));
  assert.deepEqual(refs, { 'texture ./tex/farbe.png': true, 'texture ./tex/fehlt_im_paket.png': false, 'paket_inhalt tex/farbe.png': true });
});

test('usdz mit usdc-Layer: Abschnitte auf absolute Offsets verschoben, teilweise', async () => {
  const r = await lauf(fx.pfade.usdzMitUsdc);
  assert.equal(r.status, 'teilweise');
  assert.ok(r.warnings.some(w => w.code === 'usdc_nicht_dekodiert' && w.message.startsWith('[szene.usdc]')));
  const buf = readFileSync(fx.pfade.usdzMitUsdc);
  const layerE = obj(r, 'paket_eintrag', 'szene.usdc');
  const tokens = obj(r, 'crate_abschnitt', 'TOKENS');
  assert.equal(tokens.source_range.offset, layerE.source_range.offset + 88);
  assert.equal(buf.toString('latin1', layerE.source_range.offset, layerE.source_range.offset + 8), 'PXR-USDC');
});

test('usdz Regelbrueche: erste Datei kein Layer, komprimiert, verschluesselt, nicht ausgerichtet', async () => {
  const r = await lauf(fx.pfade.usdzRegelbruch);
  for (const c of ['usdz_erste_datei_kein_layer', 'usdz_komprimiert', 'usdz_verschluesselt', 'usdz_nicht_ausgerichtet']) assert.ok(codes(r).includes(c), c);
  assert.equal(r.metadata.regeln_eingehalten, false);
  assert.equal(r.metadata.layer, 'kiste.usda');
  assert.equal(r.status, 'ok', 'Layer wurde gelesen; Regelbrueche sind Warnungen');
});

test('usdz Layer komprimiert -> nicht inspiziert; Zip64 -> nur erkannt; kaputt -> fehler', async () => {
  const a = await lauf(fx.pfade.usdzLayerKomprimiert);
  assert.equal(a.status, 'teilweise');
  assert.ok(codes(a).includes('layer_nicht_inspiziert'));
  const b = await lauf(fx.pfade.usdzZip64);
  assert.equal(b.status, 'teilweise');
  assert.ok(codes(b).includes('zip64_nicht_unterstuetzt'));
  const c = await lauf(fx.pfade.usdzKaputt);
  assert.equal(c.status, 'fehler');
  assert.ok(codes(c).includes('kein_zip'));
});

test('usdz maxDepth 0: Layer nicht inspiziert (ctx.tiefer greift)', async () => {
  const r = await lauf(fx.pfade.usdz, { maxDepth: 0 });
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('tiefengrenze_ueberschritten'));
  assert.equal(r.objects.filter(o => o.kind === 'prim').length, 0);
});

// ------------------------------------------------------------------ Registry-Kollisionen (Befund fuer den Channel)

test('REGISTRY: .usdz mit Zip-Magic: Endung .usdz entscheidet fuer dcc-usdz, auch wenn ein Zip-Inspektor registriert ist', async () => {
  const fremdZip = { id: 'fremd-zip', formats: ['zip'], extensions: ['.zip'], magic: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }], version: 1, inspect: async (src) => A.erzeugeAssetResult(src.filePath, src.size, { asset_type: 'archive', format: 'zip' }) };
  const r1 = await inspectAsset(fx.pfade.usdz, { registry: dccRegistry(fremdZip) });
  assert.equal(r1.inspector, 'dcc-usdz');
  assert.ok(!codes(r1).includes('endung_widerspricht_inhalt'));
  // Gegenprobe: ohne Zip-Inspektor entscheidet ebenfalls die Endung.
  const r3 = await inspectAsset(fx.pfade.usdz, { registry: dccRegistry() });
  assert.equal(r3.inspector, 'dcc-usdz');
});

test('REGISTRY: gzip-.blend und zstd-.blend gehen trotz gleicher Magic eines fremden Inspektors per Endung an dcc-blend', async () => {
  const fremdGzip = { id: 'fremd-gzip', formats: ['gzip'], extensions: ['.gz'], magic: [{ offset: 0, bytes: [0x1f, 0x8b, 0x08] }], version: 1, inspect: async (src) => A.erzeugeAssetResult(src.filePath, src.size, { asset_type: 'archive', format: 'gzip' }) };
  const r = await inspectAsset(fx.pfade.blendGzip, { registry: dccRegistry(fremdGzip) });
  assert.equal(r.inspector, 'dcc-blend');
  assert.ok(!codes(r).includes('endung_widerspricht_inhalt'));
  if (fx.pfade.blendZstd) {
    const fremdZstd = { id: 'fremd-zstd', formats: ['zst'], extensions: ['.zst'], magic: [{ offset: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd] }], version: 1, inspect: async (src) => A.erzeugeAssetResult(src.filePath, src.size, { asset_type: 'archive', format: 'zst' }) };
    const z = await inspectAsset(fx.pfade.blendZstd, { registry: dccRegistry(fremdZstd) });
    assert.equal(z.inspector, 'dcc-blend');
  }
});

// ------------------------------------------------------------------ ECHT (Fremdwerkzeuge)

let echt = null;
async function echteFixtures() {
  if (!echt) echt = await erzeugeEchteDccFixtures(fx.dir);
  return echt;
}

test('ECHT blender 5.x .blend: Namen, Hierarchie, Szene, Bibliothek', async t => {
  const e = await echteFixtures();
  if (!e.pfade.blend) return t.skip('blender nicht vorhanden ' + e.fehler.join());
  const r = await lauf(e.pfade.blend);
  pruefeSchema(r, 'echt.blend');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.match(r.metadata.blender_version, /^[5-9]\./);
  const w = obj(r, 'object', 'WuerfelObj');
  assert.equal(w.data.objekt_typ, 'mesh');
  assert.deepEqual(w.data.daten, { name: 'WuerfelMesh', art: 'mesh' });
  assert.equal(obj(r, 'object', 'KameraObj').data.eltern, 'WuerfelObj');
  const me = obj(r, 'mesh', 'WuerfelMesh');
  assert.equal(me.data.vertices, 8);
  assert.equal(me.data.flaechen, 6);
  const sz = obj(r, 'scene', 'SzeneA');
  assert.deepEqual([sz.data.bild_start, sz.data.bild_ende, sz.data.fps, sz.data.kamera], [5, 77, 30, 'KameraObj']);
  assert.ok(obj(r, 'action', 'WuerfelAktion'));
  assert.ok(obj(r, 'material', 'RostMat'));
  assert.deepEqual(ref(r, 'library', '//lib.blend'), { target: '//lib.blend', kind: 'library', resolved: true });
  assert.deepEqual(ref(r, 'texture', '//textures/rost_fehlt.png'), { target: '//textures/rost_fehlt.png', kind: 'texture', resolved: false });
  assert.equal(obj(r, 'verknuepft', 'LibObj').data.bibliothek, '//lib.blend');
});

test('ECHT blender zstd-.blend (Mehrframe + Seek-Table): gleiche Objekte wie unkomprimiert', async t => {
  const e = await echteFixtures();
  if (!e.pfade.blendZstd) return t.skip('blender nicht vorhanden');
  if (typeof zlib.zstdDecompressSync !== 'function') return t.skip('zstd in dieser Node-Version nicht verfuegbar');
  const a = await lauf(e.pfade.blend);
  const b = await lauf(e.pfade.blendZstd);
  assert.equal(b.metadata.komprimierung, 'zstd');
  assert.ok(b.format_specific.zstd_frames >= 2, 'Blender schreibt mehrere Frames');
  assert.equal(b.format_specific.entpackt_bytes, statSync(e.pfade.blend).size);
  assert.deepEqual(b.objects.map(o => o.kind + ':' + o.name), a.objects.map(o => o.kind + ':' + o.name));
});

test('ECHT blender FBX-Export (binaer 7400)', async t => {
  const e = await echteFixtures();
  if (!e.pfade.fbx) return t.skip('blender nicht vorhanden');
  const r = await lauf(e.pfade.fbx);
  pruefeSchema(r, 'echt.fbx');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.fbx_version, 7400);
  assert.match(r.metadata.creator, /^Blender/);
  assert.equal(obj(r, 'geometry', 'WuerfelMesh').data.vertices, 8);
  assert.ok(obj(r, 'model', 'WuerfelObj'));
  assert.ok(r.metadata.objekte.animationstack >= 1);
  assert.ok(r.metadata.verbindungen > 5);
});

test('ECHT blender USD-Export: usda-Hierarchie und usdz mit usdc-Layer', async t => {
  const e = await echteFixtures();
  if (!e.pfade.usdaBlender) return t.skip('blender nicht vorhanden');
  const r = await lauf(e.pfade.usdaBlender);
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  const m = r.objects.find(o => o.kind === 'prim' && o.name === 'WuerfelMesh');
  assert.equal(m.data.typ, 'Mesh');
  assert.equal(m.data.punkte, 8);
  assert.ok(String(m.data.material).endsWith('/RostMat'));
  const z = await lauf(e.pfade.usdzBlender);
  assert.equal(z.metadata.regeln_eingehalten, true);
  assert.equal(z.format_specific.layer.format, 'usdc');
  assert.ok(codes(z).includes('usdc_nicht_dekodiert'));
});

test('ECHT usdcat (.usdc) und usdzip (.usdz)', async t => {
  const e = await echteFixtures();
  if (!e.pfade.usdc && !e.pfade.usdz) return t.skip('usdcat/usdzip nicht vorhanden');
  if (e.pfade.usdc) {
    const r = await lauf(e.pfade.usdc);
    assert.equal(r.format, 'usdc');
    assert.equal(r.metadata.sections.length, 6);
    assert.ok(r.metadata.sections.every(s => s.gueltig));
  }
  if (e.pfade.usdz) {
    const r = await lauf(e.pfade.usdz);
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.regeln_eingehalten, true);
    assert.equal(r.metadata.layer, 'haupt.usda');
    assert.deepEqual(ref(r, 'texture', './tex/farbe.png'), { target: './tex/farbe.png', kind: 'texture', resolved: true });
    assert.equal(obj(r, 'prim', 'Geo').data.material, '/Kiste/Mat');
  }
});

// ------------------------------------------------------------------ GEGENPROBEN (Referenzimplementierungen)

const SAMPLES = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
function dateienUnter(dir, re) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...dateienUnter(p, re));
    else if (re.test(e.name)) out.push(p);
  }
  return out.sort();
}
const hat = name => {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const BLENDER_GEGEN = `
import bpy, json
d = bpy.data
out = {"objects": sorted((o.name, o.type, o.parent.name if o.parent else None, o.data.name if o.data else None) for o in d.objects if not o.library),
       "meshes": sorted((m.name, len(m.vertices), len(m.polygons)) for m in d.meshes if not m.library),
       "materials": sorted(m.name for m in d.materials if not m.library),
       "images": sorted((i.name, i.filepath) for i in d.images if i.source in ("FILE","SEQUENCE","MOVIE","TILED")),
       "actions": sorted(a.name for a in d.actions if not a.library),
       "scenes": sorted((s.name, s.frame_start, s.frame_end, s.render.fps) for s in d.scenes)}
print("JSONSTART" + json.dumps(out) + "JSONENDE")
`;
const BL_TYP = { mesh: 'MESH', camera: 'CAMERA', light: 'LIGHT', empty: 'EMPTY', armature: 'ARMATURE', curve_legacy: 'CURVE', font: 'FONT', surface: 'SURFACE', metaball: 'META', lattice: 'LATTICE' };

test('GEGENPROBE Blender selbst: Objekte/Hierarchie/Meshes/Materialien/Bilder/Aktionen/Szenen identisch', async t => {
  if (!hat('blender')) return t.skip('blender nicht vorhanden');
  const e = await echteFixtures();
  const kandidaten = [e.pfade.blend, e.pfade.blendZstd, ...dateienUnter(join(SAMPLES, 'blend'), /\.blend$/i)].filter(Boolean);
  // Ohne zlib.zstdDecompressSync (Node < 22.15) liefert der Inspektor fuer zstd-.blend korrekt nur_erkannt
  // und keine Objekte — ein Vergleich waere dort sinnlos. Erkennung per Magic 28 B5 2F FD, nicht per Name.
  const zstdDa = typeof zlib.zstdDecompressSync === 'function';
  const istZstd = p => {
    const k = readFileSync(p).subarray(0, 4);
    return k.length === 4 && k.readUInt32LE(0) === 0xfd2fb528;
  };
  const dateien = zstdDa ? kandidaten : kandidaten.filter(p => !istZstd(p));
  for (const p of kandidaten.filter(p => !dateien.includes(p))) {
    t.diagnostic(`AUSGELASSEN (zstd, Node ${process.version} ohne zlib.zstdDecompressSync): ${p}`);
  }
  if (dateien.length === 0) return t.skip('keine .blend fuer die Gegenprobe (weder Blender-Fixture noch Proben)');
  const skript = join(fx.dir, 'gegen.py');
  writeFileSync(skript, BLENDER_GEGEN);
  let verglichen = 0;
  let nichtLeer = 0;
  for (const p of dateien) {
    let b;
    try {
      const o = execFileSync('blender', ['-b', '--factory-startup', p, '--python', skript], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
      b = JSON.parse(o.split('JSONSTART')[1].split('JSONENDE')[0]);
    } catch {
      t.diagnostic(`${p}: Blender konnte die Datei nicht oeffnen (uebersprungen)`);
      continue;
    }
    const r = await lauf(p);
    const wir = {
      objects: r.objects.filter(o => o.kind === 'object' && !o.data.verknuepft).map(o => [o.name, BL_TYP[o.data.objekt_typ] ?? String(o.data.objekt_typ).toUpperCase(), o.data.eltern ?? null, o.data.daten?.name ?? null]).sort(),
      meshes: r.objects.filter(o => o.kind === 'mesh' && !o.data.verknuepft).map(o => [o.name, o.data.vertices, o.data.flaechen]).sort(),
      materials: r.objects.filter(o => o.kind === 'material' && !o.data.verknuepft).map(o => o.name).sort(),
      images: r.objects.filter(o => o.kind === 'image' && o.data.pfad !== undefined && ![4, 5].includes(o.data.quelle_typ)).map(o => [o.name, o.data.pfad]).sort(),
      actions: r.objects.filter(o => o.kind === 'action' && !o.data.verknuepft).map(o => o.name).sort(),
      scenes: r.objects.filter(o => o.kind === 'scene').map(o => [o.name, o.data.bild_start, o.data.bild_ende, o.data.fps]).sort(),
    };
    for (const k of Object.keys(wir)) {
      assert.deepEqual(wir[k], b[k], `${p} ${k}`);
      if (b[k].length > 0) nichtLeer++;
    }
    verglichen++;
  }
  t.diagnostic(`${verglichen} Dateien gegen Blender verglichen, ${nichtLeer} nicht-leere Kategorien gleich`);
  // Anker: eine Gleichheit zweier leerer Listen beweist nichts.
  assert.ok(verglichen >= 1 && nichtLeer >= verglichen * 2, `zu wenig Substanz: ${verglichen} Dateien, ${nichtLeer} nicht-leere Kategorien`);
});

const BLENDER_FBX = `
import bpy, json, sys
p = sys.argv[sys.argv.index("--")+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=p)
d = bpy.data
print("JSONSTART" + json.dumps({"models": sorted(o.name for o in d.objects), "meshes": sorted(len(m.vertices) for m in d.meshes), "materials": sorted(m.name for m in d.materials)}) + "JSONENDE")
`;

test('GEGENPROBE Blender-FBX-Import: Model-Namen, Vertexzahlen, Materialien identisch (binaere FBX)', async t => {
  if (!hat('blender')) return t.skip('blender nicht vorhanden');
  const skript = join(fx.dir, 'fbxgegen.py');
  writeFileSync(skript, BLENDER_FBX);
  const e = await echteFixtures();
  const proben = dateienUnter(join(SAMPLES, 'fbx'), /\.fbx$/i);
  const dateien = [e.pfade.fbx, ...proben].filter(Boolean);
  let verglichen = 0;
  for (const p of dateien) {
    let b;
    try {
      const o = execFileSync('blender', ['-b', '--factory-startup', '--python', skript, '--', p], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
      b = JSON.parse(o.split('JSONSTART')[1].split('JSONENDE')[0]);
    } catch {
      // ASCII-FBX importiert Blender nicht; Blender 5.1 scheitert zudem an Lichtern (cast_shadow).
      t.diagnostic(`${p}: Blender-Import gescheitert (uebersprungen)`);
      continue;
    }
    const r = await lauf(p);
    assert.deepEqual(r.objects.filter(o => o.kind === 'model').map(o => o.name).sort(), b.models, `${p} models`);
    assert.deepEqual(r.objects.filter(o => o.kind === 'geometry' && o.data.typ === 'Mesh').map(o => o.data.vertices).sort((x, y) => x - y), b.meshes.sort((x, y) => x - y), `${p} meshes`);
    assert.deepEqual(r.objects.filter(o => o.kind === 'material').map(o => o.name).sort(), b.materials, `${p} materials`);
    verglichen++;
  }
  t.diagnostic(`${verglichen} FBX-Dateien gegen Blender-Import verglichen`);
  // Die selbst erzeugte FBX importiert Blender 5.1 nicht (Lichter: cast_shadow). Der Anker ist daher nur
  // mit echten FBX-Proben erfuellbar — dann bleibt er scharf, der Test darf nicht leer durchlaufen.
  if (proben.length === 0 && verglichen === 0) return t.skip('keine per Blender importierbare FBX-Probe (Probenverzeichnis ohne fbx/)');
  assert.ok(verglichen >= 1, 'Anker: mindestens eine Datei verglichen');
});

test('GEGENPROBE sdfdump (OpenUSD): Prim-Pfade der usda-Layer identisch', async t => {
  if (!hat('sdfdump')) return t.skip('sdfdump nicht vorhanden');
  const e = await echteFixtures();
  const proben = dateienUnter(join(SAMPLES, 'usda'), /\.usda$/i);
  const dateien = [fx.pfade.usda, fx.pfade.usdaRef, e.pfade.usdaBlender, join(fx.dir, 'echt', 'pak', 'haupt.usda'), ...proben].filter(p => p && existsSync(p));
  let prims = 0;
  for (const p of dateien) {
    const o = execFileSync('sdfdump', ['-f', '^specifier$', p], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const soll = [...o.matchAll(/^<([^>]+)> : SdfSpecTypePrim$/gm)].map(m => m[1]).sort();
    const r = await lauf(p);
    const ist = r.objects.filter(x => x.kind === 'prim').map(x => x.data.pfad).sort();
    assert.deepEqual(ist, soll, p);
    prims += soll.length;
  }
  t.diagnostic(`${dateien.length} Layer, ${prims} Prim-Pfade gleich`);
  // Anker: die Spec-Fixtures reich.usda + ref.usda (10 Prims) gibt es immer; mit Proben mindestens 20.
  const mindest = proben.length > 0 ? 20 : 10;
  assert.ok(dateien.includes(fx.pfade.usda) && prims >= mindest, `Anker: ${prims} Prims verglichen, erwartet >= ${mindest}`);
});

test('GEGENPROBE usddumpcrate (OpenUSD): usdc-Version und Abschnitte identisch', async t => {
  if (!hat('usddumpcrate')) return t.skip('usddumpcrate nicht vorhanden');
  const e = await echteFixtures();
  const dateien = [e.pfade.usdc, ...dateienUnter(join(SAMPLES, 'usdc'), /\.usdc$/i)].filter(p => p && existsSync(p));
  if (dateien.length === 0) return t.skip('keine echten usdc-Dateien');
  for (const p of dateien) {
    const o = execFileSync('usddumpcrate', [p], { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const version = /file version (\d+\.\d+\.\d+)/.exec(o)[1];
    const soll = [...o.matchAll(/^\s+(\w+)\s+(\d+) bytes at offset 0x([0-9A-Fa-f]+)$/gm)].map(m => [m[1], Number(m[2]), parseInt(m[3], 16)]);
    const r = await lauf(p);
    assert.equal(r.metadata.usdc_version, version, p);
    assert.deepEqual(r.metadata.sections.map(s => [s.name, s.groesse, s.offset]), soll, p);
    assert.equal(soll.length, 6, 'Anker: 6 Abschnitte');
  }
  t.diagnostic(`${dateien.length} usdc-Dateien gleich`);
});

// ------------------------------------------------------------------ PROBEN (~/dev/synapse-testdaten/asset-samples)

test('PROBEN aus ASSET_SAMPLES_DIR: wirft nie, Schema vollstaendig, Format erkannt', async t => {
  const dir = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
  const manifest = join(dir, 'MANIFEST.json');
  if (!existsSync(manifest)) return t.skip('keine Proben (' + manifest + ')');
  let liste;
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    liste = Array.isArray(m) ? m : [...(m.samples ?? []), ...(m.local_probes ?? [])];
  } catch {
    return t.skip('MANIFEST.json nicht lesbar');
  }
  const unsere = liste
    .map(e => (typeof e === 'string' ? e : e.datei ?? e.file ?? e.pfad ?? e.path))
    .filter(n => typeof n === 'string' && /\.(blend|fbx|usda|usdc|usd|usdz)$/i.test(n))
    .map(n => (n.startsWith('/') ? n : join(dir, n)))
    .filter(existsSync);
  if (unsere.length === 0) return t.skip('keine DCC-Proben im Manifest');
  // Eine Probe darf 'fehler' liefern, wenn sie selbst kaputt ist — dann muss eine Warnung es begruenden.
  const BEGRUENDET = ['kein_blend_kopf', 'kein_fbx_kopf', 'kein_usda_kopf', 'kein_usdc_kopf', 'kein_zip', 'usd_unbekannt'];
  for (const p of unsere) {
    const r = await lauf(p);
    pruefeSchema(r, p);
    assert.ok(r.inspector?.startsWith('dcc-'), `${p}: ${r.inspector} ${JSON.stringify(r.warnings)}`);
    if (r.status === 'fehler') assert.ok(codes(r).some(c => BEGRUENDET.includes(c)), `${p}: ${JSON.stringify(r.warnings)}`);
    t.diagnostic(`${p.slice(dir.length + 1)}: ${r.status} ${r.format} obj=${r.objects.length} refs=${r.references.length} warn=${codes(r).join(',')}`);
  }
});
