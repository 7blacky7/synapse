/**
 * Asset-Intel 3D-Basisformate (P4-T61): glTF, GLB, OBJ, STL, PLY, DAE gegen gebautes dist.
 *
 * Drei Beweisstufen, im Testnamen getrennt:
 *  - "SPEC"    : handgebaute Dateien nach Spezifikation (Fixtures aus scripts/asset-fixtures-3d.mjs).
 *  - "ECHT"    : Dateien, die ein Fremdwerkzeug (Blender) erzeugt hat; nur wenn Blender vorhanden ist,
 *                sonst t.skip. Erwartete Werte folgen aus der Bauvorgabe (zwei Wuerfel, Kantenlaenge 2,
 *                bei x=0 und x=4), nicht aus der Ausgabe des Inspektors.
 *  - "PROBE"   : freie Beispieldateien aus ASSET_SAMPLES_DIR (Standard ~/dev/synapse-testdaten/asset-samples), sonst t.skip.
 *
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-3d/dist node --test packages/core/tests/asset-intel-3d.test.mjs
 *         (ohne ASSET_TEST_DIST gilt packages/core/dist)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(pathToFileURL(join(dist, 'asset-intel', 'index.js')).href);
const D3 = await import(pathToFileURL(join(dist, 'asset-intel', 'inspectors', '3d', 'index.js')).href);
const { erzeugeFixtures3d, erzeugeBlenderProben } = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-3d.mjs')).href);
const { inspectAsset, AssetRegistry } = A;
const { asset3dInspektoren, scanneJsonArrays } = D3;

const registry = new AssetRegistry();
for (const i of asset3dInspektoren) registry.register(i);

const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];
const codes = r => r.warnings.map(w => w.code);
const lauf = (pfad, opts = {}) => inspectAsset(pfad, { registry, ...opts });
const kinds = (r, kind) => r.objects.filter(o => o.kind === kind);
const ref = (r, target) => r.references.find(x => x.target === target);

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, `${wo}: Feld fehlt: ${k}`);
  assert.equal(typeof r.asset_type, 'string');
  assert.ok(Number.isInteger(r.size) && r.size >= 0, wo + ' size');
  assert.ok(r.sha256 === null || /^[0-9a-f]{64}$/.test(r.sha256), wo + ' sha256');
  assert.ok(['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'].includes(r.status), wo + ' status ' + r.status);
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), `${wo} ${k}`);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), `${wo} ${k}`);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', wo + ' warning-Form');
  assert.ok(Number.isInteger(r.parser_version) && r.parser_version >= 1, wo + ' parser_version');
  assert.ok(r.extracted_at.endsWith('Z') && !Number.isNaN(Date.parse(r.extracted_at)), wo + ' extracted_at');
  JSON.stringify(r);
  for (const x of r.references) {
    assert.equal(typeof x.target, 'string', wo + ' ref.target');
    assert.equal(typeof x.kind, 'string', wo + ' ref.kind');
    assert.ok(x.resolved === undefined || typeof x.resolved === 'boolean', wo + ' ref.resolved');
  }
  for (const o of r.objects) {
    assert.ok(o.name === null || typeof o.name === 'string', `${wo}: object.name ${o.kind}`);
    assert.equal(typeof o.kind, 'string');
    assert.ok(o.data && typeof o.data === 'object', `${wo}: object.data ${o.kind}`);
    const sr = o.source_range;
    assert.ok(sr, `${wo}: ${o.kind} ohne source_range`);
    if ('offset' in sr) {
      assert.ok(Number.isInteger(sr.offset) && Number.isInteger(sr.length) && sr.offset >= 0 && sr.length >= 0, `${wo}: ${o.kind} Bytebereich ${JSON.stringify(sr)}`);
      assert.ok(sr.offset + sr.length <= r.size, `${wo}: ${o.kind} Bytebereich ${JSON.stringify(sr)} ueber Dateiende ${r.size}`);
    } else {
      assert.ok(Number.isInteger(sr.line_start) && sr.line_start >= 1 && sr.line_end >= sr.line_start, `${wo}: ${o.kind} Zeilenbereich ${JSON.stringify(sr)}`);
    }
  }
}

let fx;
let blender;
before(async () => {
  fx = await erzeugeFixtures3d();
  blender = await erzeugeBlenderProben(fx.dir);
});
after(async () => {
  await fx.aufraeumen();
});

const P = n => fx.pfade[n];
const bytes = n => readFileSync(P(n));
const nahe = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
function boxGleich(box, min, max, wo = '') {
  assert.ok(box, wo + ' bounding_box fehlt');
  min.forEach((v, i) => nahe(box.min[i], v));
  max.forEach((v, i) => nahe(box.max[i], v));
}

// =============================================================== Registry / Erkennung

test('SPEC Registry: alle sieben Formate bekannt, Endungen eindeutig, Magic vor Endung', () => {
  assert.deepEqual(registry.formats(), ['dae', 'glb', 'gltf', 'obj', 'ply', 'stl']);
  const roh = Buffer.from(bytes('plyAscii'));
  assert.equal(registry.detect('x.dat', roh).inspector.id, '3d-ply', 'PLY per Magic ohne passende Endung');
  assert.equal(registry.detect('x.dat', bytes('glbDreieck')).inspector.id, '3d-glb', 'GLB per Magic');
  assert.equal(registry.detect('a.obj', Buffer.alloc(0)).inspector.id, '3d-obj');
  assert.equal(registry.detect('a.STL', Buffer.alloc(0)).inspector.id, '3d-stl');
  assert.equal(registry.detect('a.dae', Buffer.alloc(0)).inspector.id, '3d-dae');
  assert.equal(registry.detect('a.gltf', Buffer.alloc(0)).inspector.id, '3d-gltf');
  // Magic gewinnt gegen die Endung (PLY-Inhalt unter .obj)
  const d = registry.detect('falsch.obj', roh);
  assert.equal(d.inspector.id, '3d-ply');
  assert.ok(d.warnings.some(w => w.code === 'endung_widerspricht_inhalt'));
});

test('SPEC Registry: GLB-Inhalt unter .gltf-Endung -> 3d-glb + Warnungen, status teilweise', async () => {
  const r = await lauf(P('glbAlsGltf'));
  pruefeSchema(r, 'glbAlsGltf');
  assert.equal(r.inspector, '3d-glb');
  assert.equal(r.format, 'glb');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('endung_widerspricht_inhalt'));
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  assert.equal(r.metadata.triangle_count, 1, 'der Inhalt wird trotzdem ausgewertet');
});

test('SPEC Schema: JEDE Fixture liefert ein vollstaendiges, serialisierbares Ergebnis mit gueltigen Bereichen und wirft nie', async () => {
  let geprueft = 0;
  for (const [name, pfad] of Object.entries(fx.pfade)) {
    if (!/\.(gltf|glb|obj|stl|ply|dae)$/.test(pfad)) continue;
    const r = await lauf(pfad);
    pruefeSchema(r, name);
    assert.equal(r.asset_type === 'model3d' || r.asset_type === 'unbekannt', true, `${name}: asset_type ${r.asset_type}`);
    geprueft++;
  }
  assert.ok(geprueft >= 60, `nur ${geprueft} Fixtures geprueft`);
});

// =============================================================== glTF

test('SPEC glTF: Minimal-Dreieck exakt (Zahlen, Bounding-Box, Referenzen, Objekte)', async () => {
  const r = await lauf(P('gltfDreieck'));
  pruefeSchema(r, 'gltfDreieck');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), []);
  assert.equal(r.inspector, '3d-gltf');
  assert.equal(r.format, 'gltf');
  assert.equal(r.asset_type, 'model3d');
  const m = r.metadata;
  assert.equal(m.glb, false);
  assert.equal(m.gltf_version, '2.0');
  assert.equal(m.generator, 'Spec-Fixture 3d');
  assert.equal(m.copyright, 'Testdatei');
  assert.equal(m.mesh_count, 1);
  assert.equal(m.primitive_count, 1);
  assert.equal(m.vertex_count, 3);
  assert.equal(m.index_count, 3);
  assert.equal(m.triangle_count, 1);
  assert.equal(m.node_count, 1);
  assert.equal(m.material_count, 1);
  assert.equal(m.texture_count, 1);
  assert.equal(m.image_count, 1);
  assert.equal(m.buffer_bytes_total, 44);
  boxGleich(m.bounding_box, [0, 0, 0], [1, 1, 0]);
  boxGleich(m.bounding_box_world, [0, 0, 0], [1, 1, 0]);
  assert.deepEqual(r.references, [
    { target: 'textur.png', kind: 'texture', resolved: true },
    { target: 'dreieck.bin', kind: 'buffer', resolved: true },
  ]);
  const mat = kinds(r, 'material')[0];
  assert.equal(mat.name, 'Rot');
  assert.deepEqual(mat.data.base_color_factor, [1, 0, 0, 1]);
  assert.equal(mat.data.metallic_factor, 0);
  assert.equal(mat.data.roughness_factor, 0.5);
  assert.deepEqual(mat.data.texture_slots, [{ slot: 'baseColorTexture', texture: 0, tex_coord: 0 }]);
  const mesh = kinds(r, 'mesh')[0];
  assert.equal(mesh.name, 'Dreieck-Mesh');
  assert.deepEqual(mesh.data.attributes, ['POSITION']);
  assert.equal(mesh.data.primitives[0].mode_name, 'triangles');
  assert.equal(r.sha256.length, 64);
});

test('SPEC GLB: Minimal-Dreieck mit BIN-Chunk, Chunk-Tabelle, Kopf gegen Dateigroesse', async () => {
  const r = await lauf(P('glbDreieck'));
  pruefeSchema(r, 'glbDreieck');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), []);
  assert.equal(r.inspector, '3d-glb');
  assert.equal(r.format, 'glb');
  const g = r.format_specific.glb;
  assert.equal(g.version, 2);
  assert.equal(g.laenge_im_kopf, r.size);
  assert.deepEqual(g.chunks.map(c => c.typ), ['JSON', 'BIN']);
  assert.equal(g.chunks[0].offset, 12);
  assert.equal(g.chunks[1].laenge, 44);
  assert.equal(g.chunks[1].offset + 8 + 44, r.size);
  assert.equal(r.metadata.glb, true);
  assert.equal(r.metadata.triangle_count, 1);
  assert.equal(r.metadata.vertex_count, 3);
  boxGleich(r.metadata.bounding_box, [0, 0, 0], [1, 1, 0]);
  const chunks = kinds(r, 'glb_chunk');
  assert.deepEqual(chunks.map(c => c.name), ['JSON', 'BIN']);
  assert.deepEqual(chunks[1].source_range, { offset: g.chunks[1].offset, length: 52 });
  // Buffer 0 ohne uri verweist auf den BIN-Chunk, keine externe Referenz
  assert.equal(kinds(r, 'buffer')[0].data.quelle, 'glb_bin_chunk');
  assert.deepEqual(r.references.map(x => x.kind), ['texture']);
});

test('SPEC glTF: Szene mit Hierarchie, Meshes, Material-Slots, Animation, Skin, Kamera, Welt-Bounding-Box', async () => {
  const r = await lauf(P('gltfSzene'));
  pruefeSchema(r, 'gltfSzene');
  const m = r.metadata;
  assert.equal(m.default_scene, 1);
  assert.equal(m.scene_count, 2);
  assert.equal(m.node_count, 4);
  assert.equal(m.root_node_count, 2);
  assert.equal(m.hierarchy_max_depth, 2);
  assert.equal(m.nodes_with_mesh, 2);
  assert.deepEqual(m.extensions_used, ['KHR_materials_emissive_strength']);
  // Primitive 1: 36 Indizes -> 12 Dreiecke; Primitive 2: ohne indices, 24 Vertices -> 8; Linien -> 0
  assert.equal(m.primitive_count, 3);
  assert.equal(m.vertex_count, 24 + 24 + 4);
  assert.equal(m.vertex_count_unique_accessors, 24 + 4);
  assert.equal(m.index_count, 36);
  assert.equal(m.triangle_count, 20);
  boxGleich(m.bounding_box, [-1, -1, -1], [4, 3, 3]);
  // Welt: Wurzel (0,1,0) -> Kind-Mesh Matrix-Translation x=2 -> Box [-1..1] -> [1,0,-1]..[3,2,1]; zweiter Baum unveraendert [2,2,2]..[4,3,3]
  boxGleich(m.bounding_box_world, [1, 0, -1], [4, 3, 3]);
  assert.equal(m.animation_count, 1);
  assert.equal(m.animation_duration_s, 2.5);
  const anim = kinds(r, 'animation')[0];
  assert.equal(anim.name, 'Drehen');
  assert.equal(anim.data.channel_count, 2);
  assert.deepEqual(anim.data.target_paths, ['rotation', 'translation']);
  assert.deepEqual(anim.data.targets[0], { node: 0, path: 'rotation' });
  const skin = kinds(r, 'skin')[0];
  assert.equal(skin.data.joint_count, 2);
  assert.equal(kinds(r, 'camera')[0].data.yfov, 0.8);
  assert.equal(kinds(r, 'camera')[0].data.type, 'perspective');
  const holz = kinds(r, 'material').find(x => x.name === 'Holz');
  assert.deepEqual(holz.data.texture_slots.map(s => [s.slot, s.texture, s.tex_coord]), [
    ['baseColorTexture', 0, 1], ['metallicRoughnessTexture', 1, 0], ['normalTexture', 2, 0],
  ]);
  assert.equal(holz.data.alpha_mode, 'MASK');
  assert.equal(holz.data.alpha_cutoff, 0.4);
  assert.deepEqual(holz.data.extensions, ['KHR_materials_emissive_strength']);
  const nodes = kinds(r, 'node');
  assert.equal(nodes[0].data.transform.translation[1], 1);
  assert.equal(nodes[1].data.transform.matrix.length, 16);
  assert.equal(nodes[0].data.children, 2);
  // data:-URI wird vermerkt, nicht als Referenz gefuehrt und nicht dekodiert
  assert.deepEqual(r.format_specific.images, { extern: 1, eingebettet_data_uri: 1, buffer_view: 0 });
  assert.deepEqual(r.references.map(x => x.target), ['textur.png']);
  assert.equal(kinds(r, 'image')[1].data.quelle, 'eingebettet_data_uri');
  assert.equal(kinds(r, 'buffer')[0].data.quelle, 'eingebettet_data_uri');
  // absichtlich kaputt: Textur 2 verweist auf Image 5
  assert.equal(r.status, 'teilweise');
  assert.deepEqual(codes(r), ['textur_quelle_ungueltig']);
});

test('SPEC glTF: source_range jedes Objekts zeigt auf genau sein JSON-Element (Datei und GLB)', async () => {
  const pruefe = (r, buf, json, wo) => {
    let n = 0;
    for (const o of r.objects) {
      const schluessel = { scene: 'scenes', mesh: 'meshes', material: 'materials', animation: 'animations', skin: 'skins', camera: 'cameras', image: 'images', texture: 'textures', buffer: 'buffers', node: 'nodes' }[o.kind];
      if (!schluessel) continue;
      const teil = JSON.parse(buf.subarray(o.source_range.offset, o.source_range.offset + o.source_range.length).toString('utf8'));
      assert.deepEqual(teil, json[schluessel][o.data.index], `${wo}: ${o.kind} #${o.data.index}`);
      n++;
    }
    return n;
  };
  const rs = await lauf(P('gltfSzene'));
  const bs = bytes('gltfSzene');
  assert.equal(pruefe(rs, bs, JSON.parse(bs.toString('utf8')), 'szene'), 19);
  const rg = await lauf(P('glbDreieck'));
  const bg = bytes('glbDreieck');
  const jlen = bg.readUInt32LE(12);
  const json = JSON.parse(bg.subarray(20, 20 + jlen).toString('utf8'));
  assert.equal(pruefe(rg, bg, json, 'glb'), 7);
});

test('SPEC glTF: Referenzen — vorhanden, fehlend, ausserhalb des Ordners (nicht aufgeloest), Netz, Prozent-Kodierung, data:', async () => {
  const r = await lauf(P('gltfReferenzen'));
  pruefeSchema(r, 'gltfReferenzen');
  assert.equal(ref(r, 'textur.png').resolved, true);
  assert.equal(ref(r, 'fehlt.png').resolved, false);
  assert.equal(ref(r, '../aussen.png').resolved, false);
  assert.equal(ref(r, '/etc/passwd').resolved, false);
  assert.equal(ref(r, 'a/../../aussen2.png').resolved, false);
  assert.equal(ref(r, 'https://example.org/x.png').resolved, undefined, 'Netz-URIs werden nicht versucht');
  assert.equal(ref(r, 'sub%20ordner/tex%20eins.png').resolved, true, 'Prozent-Kodierung aufgeloest');
  assert.equal(ref(r, 'dreieck.bin').kind, 'buffer');
  assert.equal(r.references.filter(x => x.target.startsWith('data:')).length, 0);
  assert.equal(r.format_specific.images.eingebettet_data_uri, 1);
  assert.equal(r.format_specific.images.buffer_view, 1);
  assert.equal(r.format_specific.buffers.eingebettet_data_uri, 1);
  assert.ok(codes(r).includes('referenz_ausserhalb'));
  assert.ok(codes(r).includes('referenz_nicht_gefunden'));
  assert.equal(r.status, 'ok', 'fehlende externe Dateien machen die inspizierte Datei nicht unvollstaendig');
});

test('SPEC glTF: Path-Traversal wird gemeldet, aber NICHT aufgeloest — auch wenn das Ziel existiert', async () => {
  const aussen = await mkdtemp(join(tmpdir(), 'synapse-3d-pt-'));
  try {
    await mkdir(join(aussen, 'innen'));
    await writeFile(join(aussen, 'geheim.png'), 'x');
    await writeFile(join(aussen, 'innen', 'a.gltf'), JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: '../geheim.png' }, { uri: '..%2Fgeheim.png' }, { uri: '%2e%2e/geheim.png' }] }));
    const r = await lauf(join(aussen, 'innen', 'a.gltf'));
    assert.equal(r.references.length, 3);
    for (const x of r.references) assert.equal(x.resolved, false, x.target);
    assert.ok(codes(r).includes('referenz_ausserhalb'));
  } finally {
    await rm(aussen, { recursive: true, force: true });
  }
});

test('SPEC glTF: kaputtes JSON, leer, kein Objekt, tiefe Verschachtelung, BOM', async () => {
  let r = await lauf(P('gltfKaputt'));
  pruefeSchema(r, 'kaputt');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('json_kaputt'));
  r = await lauf(P('gltfLeer'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('datei_leer'));
  r = await lauf(P('gltfKeinObjekt'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  r = await lauf(P('gltfTief'));
  pruefeSchema(r, 'tief');
  assert.notEqual(r.status, 'fehler', 'tief verschachteltes JSON darf nicht abstuerzen');
  r = await lauf(P('gltfTiefOffen'));
  assert.equal(r.status, 'teilweise');
  r = await lauf(P('gltfBom'));
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.triangle_count, 1);
});

test('SPEC glTF: boesartige Angaben (riesige Zaehler, Zyklus, ungueltige Indizes) -> Warnungen, kein Absturz', async () => {
  const r = await lauf(P('gltfBoese'));
  pruefeSchema(r, 'boese');
  assert.equal(r.status, 'teilweise');
  for (const c of ['node_hierarchie_zyklus', 'accessor_ungueltig', 'accessor_groesser_als_bufferview', 'node_referenz_ungueltig', 'textur_index_ungueltig', 'buffer_laenge_fehlt']) {
    assert.ok(codes(r).includes(c), `Warnung ${c} fehlt: ${codes(r)}`);
  }
  assert.ok(Number.isFinite(r.metadata.vertex_count));
  assert.equal(r.metadata.bounding_box.max[0], 1);
});

test('SPEC GLB: abgeschnitten, nur Kopf, JSON kaputt, ohne JSON, Version 1, boese Chunk-Laenge, zu viele Chunks', async () => {
  let r = await lauf(P('glbAbgeschnitten'));
  pruefeSchema(r, 'abgeschnitten');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('glb_laenge_groesser_als_datei'));
  assert.ok(codes(r).includes('glb_chunk_ueber_dateiende'));
  assert.equal(r.metadata.triangle_count, 1, 'das intakte JSON wird trotzdem ausgewertet');
  assert.equal(r.format_specific.glb.chunks[1].abgeschnitten, true);

  r = await lauf(P('glbNurKopf'));
  assert.equal(r.status, 'teilweise');
  assert.deepEqual(codes(r), ['glb_kopf_abgeschnitten']);

  r = await lauf(P('glbJsonKaputt'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('json_kaputt'));
  assert.equal(kinds(r, 'glb_chunk').length, 1);

  r = await lauf(P('glbOhneJson'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('glb_json_chunk_fehlt'));

  r = await lauf(P('glbV1'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('glb_version_nicht_unterstuetzt'));
  assert.equal(r.metadata.glb_version, 1);

  r = await lauf(P('glbChunkBoese'));
  pruefeSchema(r, 'chunkboese');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('glb_chunk_ueber_dateiende'));
  assert.ok(r.format_specific.glb.chunks[0].laenge <= r.size, 'Chunk-Laenge wird auf die Dateigroesse gekappt');

  r = await lauf(P('glbVieleChunks'));
  assert.ok(codes(r).includes('glb_zu_viele_chunks'));
  assert.equal(kinds(r, 'glb_chunk').length, 64);
});

test('SPEC GLB/glTF: Endung passt nicht zum Inhalt (JSON unter .glb, Text unter .glb)', async () => {
  let r = await lauf(P('jsonAlsGlb'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  assert.ok(codes(r).includes('magic_fehlt'));
  assert.equal(r.format, 'gltf');
  assert.equal(r.metadata.triangle_count, 1);
  r = await lauf(P('textAlsGlb'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  assert.equal(r.objects.length, 0);
});

test('SPEC glTF Grenzen: maxObjects kappt + Warnung, kleines maxReadBytes/maxFileBytes ohne Absturz', async () => {
  let r = await lauf(P('gltfSzene'), { maxObjects: 5 });
  assert.equal(r.objects.length, 5);
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.equal(r.status, 'teilweise');
  assert.equal(r.metadata.node_count, 4, 'Zaehler bleiben vollstaendig');

  r = await lauf(P('glbDreieck'), { maxReadBytes: 100 });
  pruefeSchema(r, 'maxRead');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('json_zu_gross'));

  r = await lauf(P('glbDreieck'), { maxFileBytes: 100 });
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('datei_zu_gross'));
  assert.equal(r.objects.length, 0);
});

test('SPEC glTF: JSON-Bereichs-Scanner — Strings mit Klammern/Escapes, verschachtelt, leere Arrays, kaputt', () => {
  const t = Buffer.from('{"a":"]\\"[","meshes":[{"x":[1,2,{"y":"}"}]} , 7 ,"s"],"nodes":[],"meshes2":[1],"z":{"meshes":[9]}}');
  const m = scanneJsonArrays(t, new Set(['meshes', 'nodes']), 100, () => {});
  const teile = m.get('meshes').map(b => t.subarray(b.offset, b.offset + b.length).toString());
  assert.deepEqual(teile, ['{"x":[1,2,{"y":"}"}]}', '7', '"s"']);
  assert.equal(m.get('nodes'), undefined, 'leeres Array erzeugt keine Elemente');
  assert.equal(m.has('meshes2'), false);
  // Kappung je Schluessel
  const m2 = scanneJsonArrays(Buffer.from('{"meshes":[1,2,3,4]}'), new Set(['meshes']), 2, () => {});
  assert.equal(m2.get('meshes').length, 2);
  // Muell wirft nicht
  for (const muell of ['', '{', '}}}]]]', '"unterminiert', '{"meshes":[{', '\u0000\u0001']) {
    scanneJsonArrays(Buffer.from(muell), new Set(['meshes']), 10, () => {});
  }
});

// =============================================================== OBJ

test('SPEC OBJ: Dreieck exakt (Zaehler, Bounding-Box, Material, mtllib-Referenz, Zeilenbereich)', async () => {
  const r = await lauf(P('objDreieck'));
  pruefeSchema(r, 'objDreieck');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), []);
  assert.equal(r.inspector, '3d-obj');
  const m = r.metadata;
  assert.equal(m.vertex_count, 3);
  assert.equal(m.texcoord_count, 3);
  assert.equal(m.normal_count, 1);
  assert.equal(m.face_count, 1);
  assert.equal(m.triangle_count, 1);
  assert.equal(m.object_count, 1);
  assert.deepEqual(m.materials_used, ['Rot']);
  assert.deepEqual(m.material_library_files, ['dreieck.mtl']);
  assert.equal(m.has_normals, true);
  assert.equal(m.complete, true);
  boxGleich(m.bounding_box, [0, 0, 0], [1, 1, 0]);
  assert.deepEqual(r.references, [{ target: 'dreieck.mtl', kind: 'material_library', resolved: true }]);
  assert.equal(r.objects.length, 1);
  assert.equal(r.objects[0].name, 'Dreieck');
  assert.equal(r.objects[0].kind, 'obj_object');
  const zeilen = readFileSync(P('objDreieck'), 'utf8').split('\n');
  assert.deepEqual(r.objects[0].source_range, { line_start: zeilen.indexOf('o Dreieck') + 1, line_end: zeilen.length - 1 });
});

test('SPEC OBJ: Wuerfel mit zwei Objekten/Gruppen, CRLF, n-Ecke, negative Indizes, Zeilenbereiche aus der Datei abgeleitet', async () => {
  const r = await lauf(P('objWuerfel'));
  pruefeSchema(r, 'objWuerfel');
  const m = r.metadata;
  assert.equal(m.vertex_count, 8);
  assert.equal(m.face_count, 8);
  // 1 Dreieck (negativ) + 6 Vierecke (je 2) + 1 Fuenfeck (3)
  assert.equal(m.triangle_count, 1 * 1 + 6 * 2 + 1 * 3 - 0);
  assert.deepEqual(m.faces_by_corner_count, { 3: 1, 4: 6, '5+': 1 });
  assert.equal(m.object_count, 2);
  assert.equal(m.group_count, 2);
  assert.equal(m.line_count, 1);
  assert.equal(m.point_count, 1);
  assert.deepEqual(m.materials_used, ['Rot', 'Blau']);
  assert.deepEqual(r.references, [
    { target: 'dreieck.mtl', kind: 'material_library', resolved: true },
    { target: 'fehlt.mtl', kind: 'material_library', resolved: false },
  ]);
  const zeilen = readFileSync(P('objWuerfel'), 'utf8').split('\r\n');
  const nr = s => zeilen.indexOf(s) + 1;
  const [unten, boden, oben, seiten] = r.objects;
  assert.deepEqual([unten.name, unten.kind, boden.name, boden.kind, oben.name, seiten.name], ['Unten', 'obj_object', 'Boden', 'obj_group', 'Oben', 'Seiten']);
  assert.deepEqual(unten.source_range, { line_start: nr('o Unten'), line_end: nr('g Boden') - 1 });
  assert.deepEqual(boden.source_range, { line_start: nr('g Boden'), line_end: nr('o Oben') - 1 });
  assert.deepEqual(oben.source_range, { line_start: nr('o Oben'), line_end: nr('g Seiten') - 1 });
  assert.equal(seiten.source_range.line_start, nr('g Seiten'));
  assert.equal(seiten.source_range.line_end, m.line_total);
  assert.equal(boden.data.faces, 1);
  assert.deepEqual(unten.data.materials, [], 'usemtl ohne eigene Flaechen im Block');
  assert.deepEqual(boden.data.materials, ['Rot'], 'Material gilt bis zum naechsten usemtl, auch ueber g/o hinweg');
  assert.deepEqual(seiten.data.materials, ['Blau']);
  assert.equal(seiten.data.faces, 7);
});

test('SPEC OBJ: Block-Grenzen — Datei groesser als ein Lesepuffer, exakte Zaehler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-3d-grosz-'));
  try {
    const n = 40000;
    const z = [];
    for (let i = 0; i < n; i++) z.push(`v ${i} ${-i} 0.5`);
    z.push('f 1 2 3');
    const p = join(dir, 'gross.obj');
    await writeFile(p, z.join('\n'));
    assert.ok(statSync(p).size > 512 * 1024, 'Datei muss mehrere 256-KiB-Bloecke umfassen');
    const r = await lauf(p);
    assert.equal(r.status, 'ok');
    assert.equal(r.metadata.vertex_count, n);
    assert.equal(r.metadata.line_total, n + 1);
    boxGleich(r.metadata.bounding_box, [0, -(n - 1), 0.5], [n - 1, 0, 0.5]);

    const klein = await lauf(p, { maxReadBytes: 100_000 });
    assert.equal(klein.status, 'teilweise');
    assert.ok(codes(klein).includes('lesegrenze_erreicht'));
    assert.equal(klein.metadata.complete, false);
    assert.ok(klein.metadata.vertex_count > 1000 && klein.metadata.vertex_count < n, `Zaehler ${klein.metadata.vertex_count}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SPEC OBJ: maxObjects, kaputte/leere/binaere/Muell-Dateien, boese Indizes, 2-MiB-Zeile', async () => {
  let r = await lauf(P('objViele'), { maxObjects: 50 });
  assert.equal(r.objects.length, 50);
  assert.equal(r.metadata.object_count, 300, 'Zaehler zaehlt alle');
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.equal(r.status, 'teilweise');
  r = await lauf(P('objViele'));
  assert.equal(r.objects.length, 300);
  assert.equal(r.status, 'ok');

  r = await lauf(P('objBinaer'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  assert.equal(r.objects.length, 0);
  r = await lauf(P('objLeer'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('datei_leer'));
  r = await lauf(P('objMuell'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  r = await lauf(P('objNurKommentare'));
  assert.equal(r.status, 'ok');
  assert.ok(codes(r).includes('obj_ohne_geometrie'));
  r = await lauf(P('objOhneEndzeile'));
  assert.equal(r.metadata.face_count, 1, 'letzte Zeile ohne Zeilenende zaehlt');

  r = await lauf(P('objBoeseIndizes'));
  pruefeSchema(r, 'indizes');
  assert.equal(r.status, 'teilweise');
  for (const c of ['face_index_ausserhalb', 'face_index_ungueltig', 'vertex_ungueltig', 'vertex_nicht_endlich']) assert.ok(codes(r).includes(c), c);
  boxGleich(r.metadata.bounding_box, [0, 0, 0], [1, 1, 1]);

  r = await lauf(P('objLangeZeile'));
  pruefeSchema(r, 'langezeile');
  assert.equal(r.status, 'teilweise');
  assert.ok(r.metadata.read_bytes < statSync(P('objLangeZeile')).size, 'liest nicht die ganze 2-MiB-Zeile');
});

// =============================================================== STL

test('SPEC STL: ASCII-Wuerfel exakt', async () => {
  const r = await lauf(P('stlAscii'));
  pruefeSchema(r, 'stlAscii');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), []);
  const m = r.metadata;
  assert.equal(m.encoding, 'ascii');
  assert.equal(m.name, 'wuerfel');
  assert.equal(m.solid_count, 1);
  assert.equal(m.triangle_count, 12);
  assert.equal(m.vertex_count, 36);
  assert.equal(m.bounding_box_complete, true);
  boxGleich(m.bounding_box, [0, 0, 0], [1, 1, 1]);
  const zeilen = readFileSync(P('stlAscii'), 'utf8').split('\n');
  assert.deepEqual(r.objects[0].source_range, { line_start: 1, line_end: zeilen.indexOf('endsolid wuerfel') + 1 });
  assert.equal(r.objects[0].data.facets, 12);
});

test('SPEC STL: binaerer Wuerfel exakt, Kopf "solid" wird trotzdem als binaer erkannt (Groessenformel)', async () => {
  let r = await lauf(P('stlBinaer'));
  pruefeSchema(r, 'stlBinaer');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), []);
  let m = r.metadata;
  assert.equal(m.encoding, 'binary');
  assert.equal(m.triangle_count, 12);
  assert.equal(m.triangle_count_declared, 12);
  assert.equal(m.vertex_count, 36);
  assert.equal(m.size_matches_formula, true);
  assert.equal(r.size, 84 + 50 * 12);
  assert.equal(m.header_text, 'Binaer-Fixture');
  boxGleich(m.bounding_box, [0, 0, 0], [1, 1, 1]);
  const mesh = kinds(r, 'stl_mesh')[0];
  assert.deepEqual(mesh.source_range, { offset: 84, length: 600 });

  r = await lauf(P('stlBinaerSolid'));
  m = r.metadata;
  assert.equal(r.status, 'ok');
  assert.equal(m.encoding, 'binary', 'Kopf beginnt mit "solid", Datei ist trotzdem binaer');
  assert.equal(r.format_specific.erkennung, 'groessenformel_trotz_solid_kopf');
  assert.equal(r.format_specific.header_starts_with_solid, true);
  assert.equal(m.triangle_count, 12);
  boxGleich(m.bounding_box, [0, 0, 0], [1, 1, 1]);
});

test('SPEC STL: abgeschnitten, Ueberhang, boesartige Dreieckszahl, 0 Dreiecke, leer, Text, NaN, ASCII ohne endsolid, mehrere solids', async () => {
  let r = await lauf(P('stlBinaerAbgeschnitten'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('stl_abgeschnitten'));
  assert.equal(r.metadata.triangle_count, 5, 'nur vollstaendige Dreiecke');
  assert.equal(r.metadata.triangle_count_declared, 12);

  r = await lauf(P('stlBinaerUeberhang'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('stl_ueberhang'));
  assert.equal(r.metadata.triangle_count, 12);

  r = await lauf(P('stlBoese'));
  pruefeSchema(r, 'stlBoese');
  assert.equal(r.status, 'teilweise');
  assert.equal(r.metadata.triangle_count_declared, 4294967295);
  assert.equal(r.metadata.triangle_count, 2, 'gelesen wird nur, was da ist');
  assert.ok(codes(r).includes('stl_abgeschnitten'));

  r = await lauf(P('stlNull'));
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.triangle_count, 0);
  assert.equal(r.metadata.bounding_box, null);

  r = await lauf(P('stlLeer'));
  assert.ok(codes(r).includes('datei_leer'));
  r = await lauf(P('stlMuell'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));

  r = await lauf(P('stlNan'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('stl_nicht_endliche_werte'));
  assert.ok(Number.isFinite(r.metadata.bounding_box.max[0]));

  r = await lauf(P('stlAsciiAbgeschnitten'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('endsolid_fehlt'));
  assert.equal(r.objects[0].data.closed, false);

  r = await lauf(P('stlAsciiMehrere'));
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.solid_count, 2);
  assert.deepEqual(r.objects.map(o => [o.name, o.data.facets]), [['eins', 4], ['zwei', 2]]);
  assert.equal(r.metadata.triangle_count, 6);
});

test('SPEC STL: Lesekappe der Bounding-Box (grosse Binaerdatei, kleines maxReadBytes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-3d-stlgross-'));
  try {
    const n = 100_000;
    const b = Buffer.alloc(84 + 50 * n);
    b.writeUInt32LE(n, 80);
    for (let i = 0; i < n; i++) b.writeFloatLE(i, 84 + i * 50 + 12);
    const p = join(dir, 'gross.stl');
    await writeFile(p, b);
    let r = await lauf(p);
    assert.equal(r.status, 'ok');
    assert.equal(r.metadata.scanned_triangles, n);
    assert.equal(r.metadata.bounding_box.max[0], n - 1);
    r = await lauf(p, { maxReadBytes: 200_000 });
    assert.equal(r.status, 'teilweise');
    assert.ok(codes(r).includes('bbox_gekappt'));
    assert.equal(r.metadata.bounding_box_complete, false);
    assert.ok(r.metadata.scanned_triangles < n && r.metadata.scanned_triangles > 1000);
    assert.equal(r.metadata.triangle_count, n, 'die Zahl kommt aus dem Kopf, nicht aus dem Scan');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================== PLY

for (const [name, fmt, le] of [['plyAscii', 'ascii', null], ['plyBinaerLE', 'binary_little_endian', true], ['plyBinaerBE', 'binary_big_endian', false]]) {
  test(`SPEC PLY: Wuerfel ${fmt} exakt (Header, Elemente, Zaehler, Bounding-Box, Textur-Referenz)`, async () => {
    const r = await lauf(P(name));
    pruefeSchema(r, name);
    assert.equal(r.status, 'ok');
    assert.deepEqual(codes(r), []);
    const m = r.metadata;
    assert.equal(m.ply_format, fmt);
    assert.equal(m.ply_version, '1.0');
    assert.equal(m.vertex_count, 8);
    assert.equal(m.face_count, 6);
    assert.equal(m.triangle_count, 12, 'sechs Vierecke');
    assert.equal(m.has_colors, true);
    assert.equal(m.has_normals, false);
    assert.deepEqual(m.comments, ['Spec-Fixture', 'TextureFile textur.png']);
    assert.deepEqual(m.obj_info, ['Wuerfel 1x1x1']);
    assert.equal(m.bounding_box_complete, true);
    boxGleich(m.bounding_box, [0, 0, 0], [1, 1, 1]);
    assert.deepEqual(r.references, [{ target: 'textur.png', kind: 'texture', resolved: true }]);
    const el = kinds(r, 'ply_element');
    assert.deepEqual(el.map(e => [e.name, e.data.count]), [['vertex', 8], ['face', 6]]);
    assert.deepEqual(el[0].data.properties.map(p => p.name), ['x', 'y', 'z', 'red', 'green', 'blue']);
    assert.equal(el[1].data.properties[0].type, 'list uchar int');
    if (le !== null) assert.equal(el[0].data.row_bytes, 15);
    const zeilen = readFileSync(P(name), 'latin1').split('\n');
    assert.equal(el[0].source_range.line_start, zeilen.indexOf('element vertex 8') + 1);
    assert.equal(el[1].source_range.line_end, zeilen.indexOf('property list uchar int vertex_indices') + 1);
    const body = kinds(r, 'ply_body')[0];
    assert.equal(body.source_range.offset, m.header_bytes);
    assert.equal(body.source_range.offset + body.source_range.length, r.size);
    if (le !== null) assert.equal(r.format_specific.expected_size, r.size, 'Kopf + Zeilen ergeben exakt die Dateigroesse');
  });
}

test('SPEC PLY: face-Element vor vertex (Anfang hinter list-Daten) -> Bounding-Box trotzdem korrekt', async () => {
  const r = await lauf(P('plyFaceZuerst'));
  assert.equal(r.status, 'ok');
  boxGleich(r.metadata.bounding_box, [0, 0, 0], [1, 1, 1]);
  assert.equal(r.metadata.triangle_count, 12);
});

test('SPEC PLY: abgeschnitten, boesartige Elementzahl, Header ohne end_header, ohne Magic, leer, unbekannter Typ, ASCII zu kurz', async () => {
  let r = await lauf(P('plyBinaerAbgeschnitten'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('ply_abgeschnitten'));

  r = await lauf(P('plyBoese'));
  pruefeSchema(r, 'plyBoese');
  assert.equal(r.status, 'teilweise');
  assert.equal(r.metadata.vertex_count, 4_000_000_000);
  assert.ok(codes(r).includes('ply_abgeschnitten'));
  assert.equal(r.metadata.bounding_box_complete, false);

  r = await lauf(P('plyKaputt'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('ply_header_unvollstaendig'));

  r = await lauf(P('plyOhneMagic'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  assert.ok(codes(r).includes('magic_fehlt'));

  r = await lauf(P('plyLeer'));
  assert.ok(codes(r).includes('datei_leer'));

  r = await lauf(P('plyTypUnbekannt'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('ply_typ_unbekannt'));

  r = await lauf(P('plyAsciiKurz'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('ply_abgeschnitten'));
  assert.equal(r.metadata.bounding_box_complete, false);
});

test('SPEC PLY: vertex-Element mit list-Property -> Bounding-Box nicht berechenbar, ehrliche Warnung (binaer)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-3d-plylist-'));
  try {
    const kopf = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty list uchar int extra\nend_header\n';
    const body = Buffer.alloc(12 + 1 + 4);
    [1, 2, 3].forEach((v, i) => body.writeFloatLE(v, i * 4));
    body[12] = 1;
    const p = join(dir, 'liste.ply');
    await writeFile(p, Buffer.concat([Buffer.from(kopf), body]));
    const r = await lauf(p);
    assert.equal(r.status, 'teilweise');
    assert.ok(codes(r).includes('ply_bbox_nicht_berechenbar'));
    assert.equal(r.metadata.bounding_box, null);
    assert.equal(r.metadata.bounding_box_reason, 'zeilengroesse_unbekannt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================== DAE

test('SPEC DAE: Collada-Szene exakt (asset, Bibliotheken, Bilder, Hierarchie, Zeilenbereiche)', async () => {
  const r = await lauf(P('daeSzene'));
  pruefeSchema(r, 'daeSzene');
  assert.equal(r.inspector, '3d-dae');
  assert.equal(r.status, 'ok');
  const m = r.metadata;
  assert.equal(m.collada_version, '1.4.1');
  assert.equal(m.unit_name, 'centimeter');
  assert.equal(m.unit_meter, 0.01);
  assert.equal(m.up_axis, 'Z_UP');
  assert.equal(m.created, '2026-10-02T00:00:00');
  assert.deepEqual(m.contributors, [{ author: 'Fixture & Co', authoring_tool: 'Spec-Fixture 3d' }]);
  assert.equal(m.geometry_count, 2);
  assert.equal(m.image_count, 2);
  assert.equal(m.material_count, 1);
  assert.equal(m.effect_count, 1);
  assert.equal(m.visual_scene_count, 1);
  assert.equal(m.animation_count, 1, 'verschachtelte animation zaehlt nicht doppelt');
  assert.equal(m.controller_count, 1);
  assert.equal(m.camera_count, 1);
  assert.equal(m.light_count, 1);
  assert.equal(m.node_count, 4);
  assert.equal(m.node_max_depth, 3);
  assert.equal(m.vertex_count, 3 + 4);
  assert.equal(m.triangle_count, 1);
  assert.equal(m.polygon_count, 1);
  assert.equal(m.complete, true);
  // init_from: Bild (1.4: image/init_from) -> Referenz; Surface-init_from im Effekt (zeigt auf Image-ID) nicht
  assert.deepEqual(r.references, [
    { target: 'textur.png', kind: 'texture', resolved: true },
    { target: 'file://fehlt%20bild.png', kind: 'texture', resolved: false },
  ]);
  assert.deepEqual(r.format_specific.instances, { instance_geometry: 2, instance_camera: 1, instance_visual_scene: 1 });
  const geo = kinds(r, 'geometry');
  assert.deepEqual(geo.map(g => g.name), ['Dreieck', 'Quad']);
  assert.equal(geo[0].data.vertex_count, 3);
  assert.equal(geo[0].data.triangle_count, 1);
  assert.equal(geo[1].data.polygon_count, 1);
  const zeilen = readFileSync(P('daeSzene'), 'utf8').split('\n');
  assert.equal(geo[0].source_range.line_start, zeilen.findIndex(z => z.includes('<geometry id="dreieck-geo"')) + 1);
  assert.equal(geo[0].source_range.line_end, zeilen.findIndex(z => z.includes('<geometry id="quad-geo"')));
  assert.equal(kinds(r, 'material')[0].data.effect, 'rot-fx');
  assert.equal(kinds(r, 'controller')[0].data.typ, 'skin');
  const nodes = kinds(r, 'node');
  assert.deepEqual(nodes.map(n => [n.name, n.data.depth]), [['Wurzel', 1], ['Kind', 2], ['Enkel', 3], ['Zweiter', 1]]);
  assert.equal(nodes[2].data.type, 'JOINT');
  assert.equal(r.objects.at(-1).kind, 'node', 'Nodes stehen zuletzt');
});

test('SPEC DAE: grosse float_array ueber mehrere Lesebloecke, Tags am Blockrand, Zaehler exakt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-3d-daegross-'));
  try {
    const floats = Array.from({ length: 250_000 }, (_, i) => (i % 97) + '.5').join(' ');
    const xml = `<?xml version="1.0"?>\n<COLLADA version="1.5.0"><library_geometries><geometry id="g" name="Gross"><mesh><source id="p"><float_array id="pa" count="750000">${floats}</float_array><technique_common><accessor source="#pa" count="250000" stride="3"/></technique_common></source><vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="5"><p>0 1 2</p></triangles></mesh></geometry></library_geometries></COLLADA>\n`;
    const p = join(dir, 'gross.dae');
    await writeFile(p, xml);
    assert.ok(statSync(p).size > 1_000_000);
    const r = await lauf(p);
    assert.equal(r.status, 'ok');
    assert.equal(r.metadata.collada_version, '1.5.0');
    assert.equal(r.metadata.vertex_count, 250_000);
    assert.equal(r.metadata.triangle_count, 5);
    assert.equal(r.metadata.geometry_count, 1);
    assert.equal(r.metadata.complete, true);
    const klein = await lauf(p, { maxReadBytes: 300_000 });
    assert.equal(klein.status, 'teilweise');
    assert.ok(codes(klein).includes('lesegrenze_erreicht'));
    assert.equal(klein.metadata.complete, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SPEC DAE: Collada 1.5 (image/init_from/ref), CDATA, Kommentare, Namespace-Praefix, einfache Anfuehrungszeichen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-3d-dae15-'));
  try {
    const xml = `<?xml version='1.0'?><!-- <image><init_from>kommentar.png</init_from></image> -->
<c:COLLADA xmlns:c='http://www.collada.org/2008/03/COLLADASchema' version='1.5.0'><c:asset><c:unit name='meter' meter='1'/><c:up_axis>Y_UP</c:up_axis></c:asset>
<c:library_images><c:image id='a' name='A'><c:init_from><c:ref><![CDATA[bilder/a.png]]></c:ref></c:init_from></c:image><c:image id='b'/></c:library_images></c:COLLADA>`;
    const p = join(dir, 'v15.dae');
    await mkdir(join(dir, 'bilder'));
    await writeFile(join(dir, 'bilder', 'a.png'), 'x');
    await writeFile(p, xml);
    const r = await lauf(p);
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.collada_version, '1.5.0');
    assert.equal(r.metadata.up_axis, 'Y_UP');
    assert.equal(r.metadata.unit_name, 'meter');
    assert.equal(r.metadata.image_count, 2);
    assert.deepEqual(r.references, [{ target: 'bilder/a.png', kind: 'texture', resolved: true }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SPEC DAE: abgeschnitten, 5000 Ebenen tief, kein XML, fremdes XML, leer, 2-MiB-Tag', async () => {
  let r = await lauf(P('daeAbgeschnitten'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('xml_unvollstaendig'));
  assert.equal(r.metadata.collada_version, '1.4.1');
  assert.ok(r.metadata.image_count >= 1, 'bis zum Abbruch Gelesenes bleibt erhalten');

  r = await lauf(P('daeTief'));
  pruefeSchema(r, 'daeTief');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('xml_zu_tief'));

  r = await lauf(P('daeMuell'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  r = await lauf(P('daeAnderesXml'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('inhalt_passt_nicht_zur_endung'));
  r = await lauf(P('daeLeer'));
  assert.ok(codes(r).includes('datei_leer'));
  r = await lauf(P('daeLangesTag'));
  pruefeSchema(r, 'daeLangesTag');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('xml_tag_zu_lang'));
  assert.ok(r.metadata.read_bytes < statSync(P('daeLangesTag')).size);
});

test('SPEC DAE: maxObjects kappt Bibliotheks- und Node-Objekte, Zaehler bleiben vollstaendig', async () => {
  const r = await lauf(P('daeSzene'), { maxObjects: 4 });
  assert.equal(r.objects.length, 4);
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.equal(r.status, 'teilweise');
  assert.equal(r.metadata.node_count, 4);
  assert.equal(r.metadata.geometry_count, 2);
});

// =============================================================== ECHT (Blender)

function echt(name, fn) {
  test(`ECHT ${name}`, async t => {
    if (!blender?.verfuegbar) return t.skip('Blender nicht vorhanden: ' + (blender?.grund ?? ''));
    await fn(t);
  });
}

const BLENDER_BOX_MIN = [-1, -1, -1];
const BLENDER_BOX_MAX = [5, 1, 1];

echt('Blender GLB: zwei Wuerfel -> 2 Meshes/Nodes, 24 Dreiecke, Material mit Textur, Welt-Bounding-Box [-1..5]', async () => {
  const r = await lauf(blender.pfade.glb);
  pruefeSchema(r, 'blender.glb');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.format, 'glb');
  assert.match(r.metadata.generator, /Khronos glTF Blender I\/O/);
  assert.equal(r.metadata.mesh_count, 2);
  assert.equal(r.metadata.node_count, 2);
  assert.equal(r.metadata.triangle_count, 24);
  assert.equal(r.metadata.material_count, 1);
  assert.equal(r.metadata.image_count, 1);
  boxGleich(r.metadata.bounding_box_world, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
  boxGleich(r.metadata.bounding_box, [-1, -1, -1], [1, 1, 1]);
  assert.deepEqual(r.format_specific.glb.chunks.map(c => c.typ), ['JSON', 'BIN']);
  assert.equal(r.format_specific.glb.laenge_im_kopf, r.size);
  assert.deepEqual(kinds(r, 'node').map(o => o.name).sort(), ['Wuerfel1', 'Wuerfel2']);
  assert.deepEqual(kinds(r, 'mesh').map(o => o.name).sort(), ['Cube', 'Cube.001'], 'Mesh-Daten tragen Blenders Standardnamen');
  assert.equal(kinds(r, 'material')[0].name, 'Holz');
  assert.deepEqual(kinds(r, 'material')[0].data.texture_slots.map(s => s.slot), ['baseColorTexture']);
  const js = JSON.parse(readFileSync(blender.pfade.glb).subarray(20, 20 + readFileSync(blender.pfade.glb).readUInt32LE(12)).toString('utf8'));
  for (const o of kinds(r, 'node')) {
    const buf = readFileSync(blender.pfade.glb);
    assert.deepEqual(JSON.parse(buf.subarray(o.source_range.offset, o.source_range.offset + o.source_range.length).toString('utf8')), js.nodes[o.data.index]);
  }
});

echt('Blender glTF (getrennt): .bin und Textur als aufgeloeste Referenzen', async () => {
  const r = await lauf(blender.pfade.gltf);
  pruefeSchema(r, 'blender.gltf');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.format, 'gltf');
  assert.equal(r.metadata.triangle_count, 24);
  boxGleich(r.metadata.bounding_box_world, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
  assert.deepEqual(r.references.map(x => [x.kind, x.resolved]).sort(), [['buffer', true], ['texture', true]]);
  assert.ok(r.references.some(x => x.kind === 'buffer' && x.target.endsWith('.bin')));
});

echt('Blender OBJ: 16 v, 12 Vierecke = 24 Dreiecke, 2 Objekte, Material Holz, mtl aufgeloest, Bounding-Box', async () => {
  const r = await lauf(blender.pfade.obj);
  pruefeSchema(r, 'blender.obj');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.vertex_count, 16);
  assert.equal(r.metadata.face_count, 12);
  assert.equal(r.metadata.triangle_count, 24);
  assert.deepEqual(r.metadata.faces_by_corner_count, { 4: 12 });
  assert.equal(r.metadata.object_count, 2);
  assert.deepEqual(r.metadata.materials_used, ['Holz']);
  assert.deepEqual(r.objects.map(o => o.name), ['Wuerfel1', 'Wuerfel2']);
  boxGleich(r.metadata.bounding_box, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
  assert.equal(r.references[0].kind, 'material_library');
  assert.equal(r.references[0].resolved, true);
});

echt('Blender STL binaer + ASCII: 24 Dreiecke, Bounding-Box, Erkennung ueber Groessenformel bzw. solid', async () => {
  const b = await lauf(blender.pfade.stl);
  pruefeSchema(b, 'blender.stl');
  assert.equal(b.status, 'ok', JSON.stringify(b.warnings));
  assert.equal(b.metadata.encoding, 'binary');
  assert.equal(b.metadata.triangle_count, 24);
  assert.equal(b.size, 84 + 50 * 24);
  boxGleich(b.metadata.bounding_box, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
  const a = await lauf(blender.pfade.stl_ascii);
  pruefeSchema(a, 'blender-ascii.stl');
  assert.equal(a.status, 'ok', JSON.stringify(a.warnings));
  assert.equal(a.metadata.encoding, 'ascii');
  assert.equal(a.metadata.triangle_count, 24);
  boxGleich(a.metadata.bounding_box, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
});

echt('Blender PLY binaer + ASCII: 12 Flaechen, Bounding-Box, Header-Kommentar', async () => {
  const b = await lauf(blender.pfade.ply);
  pruefeSchema(b, 'blender.ply');
  assert.equal(b.status, 'ok', JSON.stringify(b.warnings));
  assert.equal(b.metadata.ply_format, 'binary_little_endian');
  assert.equal(b.metadata.face_count, 12);
  assert.equal(b.metadata.triangle_count, 24);
  assert.ok(b.metadata.vertex_count >= 16, 'Blender splittet Vertices an UV-Kanten: mindestens 16');
  assert.equal(b.format_specific.expected_size, b.size, 'Dateigroesse stimmt exakt mit dem durchlaufenen Koerper');
  assert.match(b.metadata.comments[0], /Blender/);
  boxGleich(b.metadata.bounding_box, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
  const a = await lauf(blender.pfade.ply_ascii);
  assert.equal(a.status, 'ok', JSON.stringify(a.warnings));
  assert.equal(a.metadata.ply_format, 'ascii');
  assert.equal(a.metadata.vertex_count, b.metadata.vertex_count);
  assert.equal(a.metadata.triangle_count, 24);
  boxGleich(a.metadata.bounding_box, BLENDER_BOX_MIN, BLENDER_BOX_MAX);
});

echt('Blender-Dateien: abgeschnittene Kopien werden als teilweise gemeldet, nicht als ok', async () => {
  for (const k of ['glb', 'stl', 'ply']) {
    const voll = readFileSync(blender.pfade[k]);
    const dir = await mkdtemp(join(tmpdir(), 'synapse-3d-cut-'));
    try {
      const p = join(dir, 'cut' + extname(blender.pfade[k]));
      await writeFile(p, voll.subarray(0, voll.length - 37));
      const r = await lauf(p);
      pruefeSchema(r, 'cut.' + k);
      assert.equal(r.status, 'teilweise', `${k}: abgeschnittene echte Datei darf nicht ok sein`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// =============================================================== PROBE (freie Beispieldateien)

const SAMPLES_ROOT = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
const probeDatei = rel => (existsSync(join(SAMPLES_ROOT, rel)) ? join(SAMPLES_ROOT, rel) : null);
function probeTest(name, rel, fn) {
  test(`PROBE ${name} (${rel})`, async t => {
    const p = probeDatei(rel);
    if (!p) return t.skip(`Probe fehlt: ${join(SAMPLES_ROOT, rel)}`);
    await fn(await lauf(p), p);
  });
}

// Erwartungswerte stammen aus der Natur des Modells (Quelle: MANIFEST.json), nicht aus der Ausgabe des Inspektors.
probeTest('Khronos Box.glb: 1x1x1-Wuerfel, 24 Vertices, 36 Indizes, 12 Dreiecke', 'glb/Box.glb', r => {
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.format, 'glb');
  assert.equal(r.metadata.vertex_count, 24);
  assert.equal(r.metadata.index_count, 36);
  assert.equal(r.metadata.triangle_count, 12);
  boxGleich(r.metadata.bounding_box, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  assert.equal(r.format_specific.glb.laenge_im_kopf, r.size);
});

probeTest('Khronos Box.gltf: externe Box0.bin als aufgeloeste Referenz', 'gltf/box/Box.gltf', r => {
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.triangle_count, 12);
  assert.deepEqual(r.references, [{ target: 'Box0.bin', kind: 'buffer', resolved: true }]);
});

probeTest('Khronos Box (eingebettet): data:-URI-Buffer ohne externe Referenz', 'gltf/box-embedded/Box.gltf', r => {
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.references, []);
  assert.equal(r.format_specific.buffers.eingebettet_data_uri, 1);
  assert.equal(r.metadata.triangle_count, 12);
});

probeTest('Suzanne.gltf: zwei PNG-Texturen und .bin aufgeloest, Material mit PBR-Slots', 'gltf/suzanne/Suzanne.gltf', r => {
  assert.equal(r.status, 'ok');
  assert.equal(r.references.filter(x => x.kind === 'texture' && x.resolved === true).length, 2);
  assert.equal(r.references.filter(x => x.kind === 'buffer' && x.resolved === true).length, 1);
  assert.equal(r.metadata.triangle_count * 3, r.metadata.index_count);
  assert.ok(kinds(r, 'material')[0].data.texture_slots.length >= 1);
});

probeTest('unit_cube.stl: BINAER trotz Kopf "solid unit_cube", 12 Dreiecke, Einheitswuerfel um den Ursprung', 'stl/unit_cube.stl', r => {
  assert.equal(r.metadata.encoding, 'binary');
  assert.equal(r.format_specific.header_starts_with_solid, true);
  assert.equal(r.format_specific.erkennung, 'groessenformel_trotz_solid_kopf');
  assert.equal(r.metadata.triangle_count, 12);
  assert.equal(r.size, 84 + 50 * 12);
  boxGleich(r.metadata.bounding_box, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
});

test('PROBE Spider ASCII-STL und Binaer-STL (dasselbe Modell) -> gleiche Dreieckszahl und Bounding-Box', async t => {
  const a = probeDatei('stl/Spider_ascii.stl');
  const b = probeDatei('stl/Spider_binary.stl');
  if (!a || !b) return t.skip('Spider-Proben fehlen');
  const ra = await lauf(a);
  const rb = await lauf(b);
  assert.equal(ra.metadata.encoding, 'ascii');
  assert.equal(rb.metadata.encoding, 'binary');
  assert.equal(ra.metadata.triangle_count, rb.metadata.triangle_count);
  assert.equal(ra.status, 'ok');
  assert.equal(rb.status, 'ok');
  ra.metadata.bounding_box.min.forEach((v, i) => nahe(v, rb.metadata.bounding_box.min[i], 1e-4));
  ra.metadata.bounding_box.max.forEach((v, i) => nahe(v, rb.metadata.bounding_box.max[i], 1e-4));
});

probeTest('Mehrere solids in einer ASCII-STL', 'stl/triangle_with_two_solids.stl', r => {
  assert.equal(r.metadata.solid_count, 2);
  assert.equal(r.metadata.triangle_count, 2);
  assert.equal(r.objects.length, 2);
});

test('PROBE PLY cube.ply (ASCII) und cube_binary.ply: gleicher Wuerfel -> 8 Vertices, 12 Dreiecke, Bounding-Box 0..1', async t => {
  const a = probeDatei('ply/cube.ply');
  const b = probeDatei('ply/cube_binary.ply');
  if (!a || !b) return t.skip('PLY-Wuerfel-Proben fehlen');
  for (const p of [a, b]) {
    const r = await lauf(p);
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.vertex_count, 8);
    assert.equal(r.metadata.triangle_count, 12);
    boxGleich(r.metadata.bounding_box, [0, 0, 0], [1, 1, 1]);
  }
});

probeTest('OBJ box.obj mit .mtl: aufgeloeste material_library-Referenz', 'obj/box/box.obj', r => {
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.references, [{ target: 'box.mtl', kind: 'material_library', resolved: true }]);
  assert.equal(r.metadata.triangle_count, 12);
  boxGleich(r.metadata.bounding_box, [-1, -1, -1], [1, 1, 1]);
});

probeTest('OBJ mit fehlender mtl-Datei: Referenz resolved:false, Datei selbst ok', 'obj/ico4/ico4.obj', r => {
  assert.equal(r.status, 'ok');
  assert.equal(r.references[0].resolved, false);
  assert.ok(codes(r).includes('referenz_nicht_gefunden'));
});

probeTest('DAE in UTF-16LE (mit BOM) wird dekodiert und ausgewertet', 'dae/cube_UTF16LE.dae', r => {
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.encoding, 'utf-16le');
  assert.ok(r.metadata.collada_version, 'Collada-Version gelesen');
  assert.ok(r.metadata.geometry_count >= 1);
  assert.ok(r.metadata.triangle_count + r.metadata.polygon_count >= 6);
});

probeTest('Collada blue_cube.dae: 8 Vertices, 12 Dreiecke, Z_UP, Meter', 'dae/blue_cube.dae', r => {
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.vertex_count, 8);
  assert.equal(r.metadata.triangle_count, 12);
  assert.equal(r.metadata.up_axis, 'Z_UP');
  assert.equal(r.metadata.unit_meter, 1);
});

const SAMPLES = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
function probenFuer(ext) {
  const dir = join(SAMPLES, ext);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(f => extname(f).toLowerCase() === '.' + ext).map(f => join(dir, f));
  } catch {
    return [];
  }
}

for (const ext of ['glb', 'gltf', 'obj', 'stl', 'ply', 'dae']) {
  test(`PROBE ${ext}: echte freie Beispieldateien aus ${SAMPLES}/${ext} (Schema, kein Absturz, Format erkannt)`, async t => {
    const dateien = probenFuer(ext);
    if (dateien.length === 0) return t.skip(`keine Proben unter ${join(SAMPLES, ext)}`);
    for (const p of dateien) {
      const r = await lauf(p);
      pruefeSchema(r, p);
      assert.equal(r.asset_type, 'model3d', p);
      assert.ok(['ok', 'teilweise'].includes(r.status), `${p}: status ${r.status} ${JSON.stringify(r.warnings)}`);
      assert.equal(r.format, ext, p);
      assert.ok(Object.keys(r.metadata).length > 3, `${p}: metadata leer`);
    }
  });
}
