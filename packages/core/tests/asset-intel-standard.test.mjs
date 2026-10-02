/**
 * Asset-Intel Standard-Registry (Verdrahtung, P4-T60): alle sieben Inspektor-Gruppen + generic-binary in
 * EINER Registry, Ende zu Ende gegen gebautes dist.
 * Bloecke:
 *  - REGISTRY: Zusammensetzung, Magic-Hoheit, statische Kollisionspruefung (nur bewusst aufgeloeste Paare).
 *  - KOLLISIONEN: png/jpeg/elf/7z/glb/zip/gzip/zstd/usdz/blend, mp4-Brands (HEIC/AVIF/M4A/MOV nicht als Video), RIFF.
 *  - PROBEN: JEDE Datei aus MANIFEST.json (Env ASSET_SAMPLES_DIR, Standard ~/dev/synapse-testdaten/asset-samples) und jede lokale
 *    Probe durch inspectAsset mit der Standard-Registry; Tabelle Formate x Status per t.diagnostic.
 *  - OHNE ENDUNG: jede Probe als Kopie unter dem Namen 'datei' (os.tmpdir()); mehrdeutig nur dort, wo bewusst.
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-verdrahtung/dist node --test packages/core/tests/asset-intel-standard.test.mjs
 * Die Proben werden nur gelesen. Fehlt das Proben-Verzeichnis, entfallen die Probenbloecke (skip).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const { inspectAsset, detectAsset, standardRegistry, alleInspektoren, genericBinaryInspector } = A;

const PROBEN_DIR = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
const MANIFEST = join(PROBEN_DIR, 'MANIFEST.json');
const hatProben = existsSync(MANIFEST);

const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];
const STATI = ['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'];
const codes = r => r.warnings.map(w => w.code);
const ascii = s => [...s].map(c => c.charCodeAt(0));

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, wo + ': Feld fehlt: ' + k);
  assert.equal(typeof r.asset_type, 'string', wo + ' asset_type');
  assert.ok(r.format === null || typeof r.format === 'string', wo + ' format');
  assert.ok(Number.isInteger(r.size) && r.size >= 0, wo + ' size');
  assert.ok(r.sha256 === null || /^[0-9a-f]{64}$/.test(r.sha256), wo + ' sha256');
  assert.ok(STATI.includes(r.status), wo + ' status ' + r.status);
  assert.ok(r.inspector === null || typeof r.inspector === 'string', wo + ' inspector');
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), wo + ' ' + k);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), wo + ' ' + k);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', wo + ' warning-Form');
  assert.ok(Number.isInteger(r.parser_version) && r.parser_version >= 0, wo + ' parser_version');
  assert.ok(!Number.isNaN(Date.parse(r.extracted_at)), wo + ' extracted_at');
  JSON.stringify(r);
}

/** Dateikopf aus Teilen (Bytes/Text), auf 64 Byte aufgefuellt; Registry und Erkennung sehen nur den Kopf. */
function kopf(...teile) {
  const b = Buffer.concat(teile.map(t => (typeof t === 'string' ? Buffer.from(t, 'latin1') : Buffer.from(t))));
  return b.length >= 64 ? b : Buffer.concat([b, Buffer.alloc(64 - b.length)]);
}
const erkenne = (name, k) => detectAsset('/x/' + name, k);

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'asset-standard-'));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// =============================================================================== REGISTRY

test('REGISTRY: Standard-Registry enthaelt generic-binary und alle 31 Inspektoren der sieben Gruppen', () => {
  assert.equal(alleInspektoren.length, 31);
  assert.equal(standardRegistry.list().length, 32);
  for (const i of alleInspektoren) assert.equal(standardRegistry.get(i.id), i, i.id + ' nicht in der Standard-Registry');
  assert.equal(standardRegistry.get('generic-binary'), genericBinaryInspector);
  const gruppen = { '3d-': 6, 'textur-': 8, 'archiv-': 4, 'exe-': 2, 'medien-': 2, 'dcc-': 4, 'unreal-': 5 };
  for (const [praefix, n] of Object.entries(gruppen)) {
    assert.equal(alleInspektoren.filter(i => i.id.startsWith(praefix)).length, n, 'Gruppe ' + praefix);
  }
  const ids = alleInspektoren.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, 'ids eindeutig');
  // Formate der Gruppen sind ueber die Registry sichtbar
  const formate = standardRegistry.formats();
  for (const f of ['glb', 'gltf', 'obj', 'stl', 'ply', 'dae', 'png', 'jpeg', 'webp', 'dds', 'ktx', 'ktx2', 'exr', 'hdr', 'zip', 'tar', '7z', 'sqlite', 'pe', 'elf', 'wav', 'ogg', 'flac', 'mp3', 'mp4', 'mkv', 'avi', 'blend', 'fbx', 'usda', 'usdc', 'usdz', 'uasset', 'pak', 'utoc', 'gif', 'pdf']) {
    assert.ok(formate.includes(f), 'Format fehlt: ' + f);
  }
  // doppelte Registrierung ist harmlos (gleiche ids ersetzen sich)
  for (const i of alleInspektoren) standardRegistry.register(i);
  assert.equal(standardRegistry.list().length, 32);
});

test('REGISTRY: generic-binary traegt nur noch Magic von Formaten ohne eigenen Inspektor (gif, pdf)', () => {
  assert.deepEqual(genericBinaryInspector.formats, ['gif', 'pdf']);
  assert.deepEqual(genericBinaryInspector.magic.map(m => m.format), ['gif', 'pdf']);
  assert.deepEqual(genericBinaryInspector.extensions, []);
});

/** Bewusst aufgeloeste Magic-Ueberschneidungen: die Endung entscheidet (siehe inspectors/index.ts). */
const ERLAUBTE_PAARE = new Set(['archiv-zip|dcc-usdz', 'archiv-tar|dcc-blend']);

test('REGISTRY: statische Pruefung — Magic-Ueberschneidungen (gleicher Offset, gleiches Praefix) nur zwischen den bewusst aufgeloesten Paaren', t => {
  const eintraege = [];
  for (const i of standardRegistry.list()) for (const m of i.magic ?? []) eintraege.push({ id: i.id, offset: m.offset, bytes: m.bytes });
  const gefunden = new Set();
  for (let x = 0; x < eintraege.length; x++) {
    for (let y = x + 1; y < eintraege.length; y++) {
      const a = eintraege[x];
      const b = eintraege[y];
      if (a.id === b.id || a.offset !== b.offset) continue;
      const n = Math.min(a.bytes.length, b.bytes.length);
      let gleich = true;
      for (let k = 0; k < n; k++) if (a.bytes[k] !== b.bytes[k]) { gleich = false; break; }
      if (gleich) gefunden.add([a.id, b.id].sort().join('|'));
    }
  }
  t.diagnostic('Magic-Ueberschneidungen: ' + [...gefunden].join(', '));
  for (const p of gefunden) assert.ok(ERLAUBTE_PAARE.has(p), 'unerwartete Magic-Kollision: ' + p);
  // Gegenprobe: die erlaubten Paare gibt es wirklich (sonst waere die Pruefung blind)
  for (const p of ERLAUBTE_PAARE) assert.ok(gefunden.has(p), 'erwartete Ueberschneidung fehlt: ' + p);
  // Magic-Muster am Offset 8 (RIFF-Formtyp) und 4 (ftyp) kollidieren mit nichts
  const ext = new Map();
  for (const i of standardRegistry.list()) for (const e of i.extensions) {
    const k = e.toLowerCase();
    ext.set(k, [...(ext.get(k) ?? []), i.id]);
  }
  const doppelt = [...ext].filter(([, v]) => v.length > 1);
  assert.deepEqual(doppelt, [], 'keine Endung doppelt beansprucht');
});

// =============================================================================== KOLLISIONEN

test('KOLLISION generic-binary: png/jpeg/glb/elf/7z/gif/pdf ohne Endung -> eindeutig, mit passender Endung ebenso', () => {
  const faelle = [
    ['png', kopf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'textur-png', 'png'],
    ['jpeg', kopf([0xff, 0xd8, 0xff, 0xe0]), 'textur-jpeg', 'jpeg'],
    ['elf', kopf([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), 'exe-elf', 'elf'],
    ['7z', kopf([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'archiv-7z', '7z'],
    ['glb', kopf('glTF', [2, 0, 0, 0]), '3d-glb', 'glb'],
    ['gif', kopf('GIF89a'), 'generic-binary', 'gif'],
    ['pdf', kopf('%PDF-1.7'), 'generic-binary', 'pdf'],
    ['sqlite', kopf('SQLite format 3\0'), 'archiv-sqlite', 'sqlite'],
    ['pe', kopf('MZ'), 'exe-pe', 'pe'],
  ];
  for (const [name, k, id, format] of faelle) {
    const d = erkenne('datei', k);
    assert.equal(d.inspector?.id, id, name + ' ohne Endung: ' + JSON.stringify(d.warnings));
    assert.equal(d.format, format, name);
    assert.ok(!codes(d).includes('erkennung_mehrdeutig'), name);
    const m = erkenne('datei.' + (name === 'jpeg' ? 'jpg' : name), k);
    assert.equal(m.inspector?.id, id, name + ' mit Endung');
    assert.ok(m.warnings.every(w => w.code !== 'erkennung_mehrdeutig' && w.code !== 'endung_widerspricht_inhalt'), name + ' Warnungen mit Endung');
  }
});

test('KOLLISION zip: Zip ohne Endung eindeutig solange der erste Eintrag NICHT gespeichert (Methode 0) ist; mit Endung immer', () => {
  const deflate = kopf([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
  const leer = kopf([0x50, 0x4b, 0x05, 0x06]);
  for (const k of [deflate, leer]) {
    const d = erkenne('datei', k);
    assert.equal(d.inspector?.id, 'archiv-zip');
    assert.equal(d.format, 'zip');
  }
  // gespeicherter erster Eintrag (typisch: jar/epub/odt, Proben-Zips, usdz): mit Endung eindeutig, ohne bewusst mehrdeutig
  const gespeichert = kopf([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(erkenne('a.zip', gespeichert).inspector?.id, 'archiv-zip');
  assert.equal(erkenne('a.jar', gespeichert).inspector?.id, 'archiv-zip');
  assert.equal(erkenne('a.docx', gespeichert).inspector?.id, 'archiv-zip');
  const ohne = erkenne('datei', gespeichert);
  assert.equal(ohne.inspector, null, 'bewusst mehrdeutig: archiv-zip oder dcc-usdz');
  assert.ok(codes(ohne).includes('erkennung_mehrdeutig'));
});

test('KOLLISION usdz: .usdz geht an dcc-usdz (Versionen 10/20/45, Flags 0 und UTF-8); unbekannter Zip-Kopf faellt auf archiv-zip', () => {
  for (const version of [0x0a, 0x14, 0x2d]) {
    for (const flags of [[0x00, 0x00], [0x00, 0x08]]) {
      const k = kopf([0x50, 0x4b, 0x03, 0x04, version, 0x00, flags[0], flags[1], 0x00, 0x00]);
      const d = erkenne('modell.usdz', k);
      assert.equal(d.inspector?.id, 'dcc-usdz', 'Version ' + version + ' Flags ' + flags);
      assert.equal(d.via, 'magic_und_endung');
      assert.ok(!codes(d).includes('endung_widerspricht_inhalt'));
    }
  }
  const fremd = kopf([0x50, 0x4b, 0x03, 0x04, 0x3f, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const d = erkenne('modell.usdz', fremd);
  assert.equal(d.inspector?.id, 'archiv-zip', 'dokumentierter Rueckfall');
  assert.ok(codes(d).includes('endung_widerspricht_inhalt'));
});

test('KOLLISION gzip/zstd: .blend -> dcc-blend, .gz/.tgz/.tar.gz/.zst -> archiv-tar, ohne Endung bewusst mehrdeutig; BLENDER-Kopf eindeutig', () => {
  const gz = kopf([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0x0b]);
  const zst = kopf([0x28, 0xb5, 0x2f, 0xfd, 0x60, 0xf4]);
  assert.equal(erkenne('a.blend', gz).inspector?.id, 'dcc-blend');
  assert.equal(erkenne('a.blend', zst).inspector?.id, 'dcc-blend');
  for (const n of ['a.gz', 'a.tgz', 'a.tar.gz']) assert.equal(erkenne(n, gz).inspector?.id, 'archiv-tar', n);
  for (const n of ['a.zst', 'a.tzst']) assert.equal(erkenne(n, zst).inspector?.id, 'archiv-tar', n);
  for (const k of [gz, zst]) {
    const d = erkenne('datei', k);
    assert.equal(d.inspector, null);
    assert.ok(codes(d).includes('erkennung_mehrdeutig'));
  }
  const blender = erkenne('datei', kopf('BLENDER-v305REND'));
  assert.equal(blender.inspector?.id, 'dcc-blend');
  // bzip2 und xz gehoeren nur dem Archiv-Inspektor
  assert.equal(erkenne('datei', kopf([0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59])).inspector?.id, 'archiv-tar');
  assert.equal(erkenne('datei', kopf([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])).inspector?.id, 'archiv-tar');
});

const MP4_BRANDS = ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4VH', 'M4VP'];
const KEIN_VIDEO_BRANDS = ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'qt  ', 'crx ', 'jp2 '];

test('KOLLISION mp4: nur bekannte Video-Brands sind mp4; HEIC/AVIF/M4A/MOV nicht (ohne Endung und mit ihrer eigenen Endung)', () => {
  for (const b of MP4_BRANDS) {
    const d = erkenne('datei', kopf([0, 0, 0, 0x20], 'ftyp', b, [0, 0, 2, 0]));
    assert.equal(d.inspector?.id, 'medien-video', b);
    assert.equal(d.format, 'mp4', b);
    assert.equal(d.via, 'magic', b);
  }
  const endungen = { heic: '.heic', heix: '.heic', hevc: '.heic', mif1: '.heif', msf1: '.heif', avif: '.avif', avis: '.avif', 'M4A ': '.m4a', 'M4B ': '.m4b', 'M4P ': '.m4p', 'qt  ': '.mov', 'crx ': '.cr3', 'jp2 ': '.jp2' };
  for (const b of KEIN_VIDEO_BRANDS) {
    const k = kopf([0, 0, 0, 0x20], 'ftyp', b, [0, 0, 0, 0]);
    const ohne = erkenne('datei', k);
    assert.equal(ohne.inspector, null, b + ' ohne Endung darf nicht als Video erkannt werden');
    const mit = erkenne('datei' + endungen[b], k);
    assert.equal(mit.inspector, null, b + ' mit ' + endungen[b]);
  }
  // Brand unbekannt, aber Endung .mp4: erkannt ueber die Endung, mit Warnung magic_fehlt (kein stilles Raten)
  const f4v = erkenne('film.mp4', kopf([0, 0, 0, 0x20], 'ftyp', 'f4v ', [0, 0, 0, 0]));
  assert.equal(f4v.inspector?.id, 'medien-video');
  assert.equal(f4v.via, 'endung');
  assert.ok(codes(f4v).includes('magic_fehlt'));
});

test('KOLLISION RIFF: WAVE -> wav, AVI  -> avi, WEBP -> webp, anderer Formtyp -> kein Treffer', () => {
  const riff = typ => kopf('RIFF', [0x24, 0, 0, 0], typ);
  const wav = erkenne('datei', riff('WAVE'));
  assert.equal(wav.inspector?.id, 'medien-audio');
  assert.equal(wav.format, 'wav');
  const avi = erkenne('datei', riff('AVI '));
  assert.equal(avi.inspector?.id, 'medien-video');
  assert.equal(avi.format, 'avi');
  const webp = erkenne('datei', riff('WEBP'));
  assert.equal(webp.inspector?.id, 'textur-webp');
  assert.equal(webp.format, 'webp');
  for (const typ of ['ACON', 'CDXA', 'RMID', 'PAL ']) {
    const d = erkenne('datei', riff(typ));
    assert.equal(d.inspector, null, typ);
    assert.ok(!codes(d).includes('erkennung_mehrdeutig'), typ);
  }
});

test('KOLLISION Pipeline: PNG-Inhalt unter .glb ist png (Inhalt gilt, Warnung endung_widerspricht_inhalt)', async () => {
  const p = join(tmp, 'png-als.glb');
  writeFileSync(p, kopf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const r = await inspectAsset(p);
  pruefeSchema(r, 'png-als-glb');
  assert.equal(r.inspector, 'textur-png');
  assert.equal(r.format, 'png');
  assert.ok(codes(r).includes('endung_widerspricht_inhalt'));
});

// =============================================================================== PROBEN

/** Endung -> erwartetes Ergebnis-Format. Abweichungen vom Manifest-Format stehen im Kommentar. */
const EXT_FORMAT = {
  '.glb': 'glb', '.gltf': 'gltf', '.obj': 'obj', '.stl': 'stl', '.ply': 'ply', '.dae': 'dae',
  '.png': 'png', '.jpg': 'jpeg', '.webp': 'webp', '.dds': 'dds', '.ktx': 'ktx', '.ktx2': 'ktx2', '.exr': 'exr', '.hdr': 'hdr',
  '.zip': 'zip', '.tar': 'tar', '.gz': 'tar.gz', '.7z': '7z', '.sqlite': 'sqlite',
  '.wav': 'wav', '.flac': 'flac', '.mp3': 'mp3', '.ogg': 'ogg', '.mp4': 'mp4', '.mkv': 'mkv', '.avi': 'avi',
  '.fbx': 'fbx', '.blend': 'blend', '.usda': 'usda', '.usdc': 'usdc', '.usdz': 'usdz',
  '.pak': 'pak', '.uasset': 'uasset', '.exe': 'pe', '.dll': 'pe',
  // Container-Familien: Manifest sagt webm/ogv, die Inspektoren fuehren sie unter ihrem Container
  '.webm': 'mkv', // Matroska-Container (EBML-Magic) -> medien-video, Format mkv
  '.ogv': 'ogg', // Ogg-Container (OggS-Magic) -> medien-audio, Format ogg
};
/** Beigaben ohne Inspektor (Manifest fuehrt sie unter dem Format der Hauptdatei): erwartet nicht_erkannt + kein_inspektor. */
const BEIGABEN = new Set(['.bin', '.mtl']);

function ladeProben() {
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const proben = [];
  for (const s of man.samples) proben.push({ pfad: join(PROBEN_DIR, s.file), manifest: s.format, name: s.file });
  for (const s of man.local_probes) if (s.path) proben.push({ pfad: s.path, manifest: s.format, name: s.path });
  return proben.filter(p => existsSync(p.pfad));
}

function erwartet(p) {
  const e = extname(p.pfad).toLowerCase();
  if (BEIGABEN.has(e)) return null;
  return EXT_FORMAT[e] ?? p.manifest;
}

const sha = pfad => createHash('sha256').update(readFileSync(pfad)).digest('hex');

test('PROBEN: Manifest vollstaendig (132 Proben + lokale Proben vorhanden)', { skip: !hatProben && 'Proben-Verzeichnis fehlt' }, () => {
  const man = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(man.samples.length, 132);
  const proben = ladeProben();
  assert.ok(proben.length >= 132 + 1, 'Proben gelesen: ' + proben.length);
});

test('PROBEN: jede Probe durch inspectAsset (Standard-Registry): wirft nie, Schema vollstaendig, Format passt, nie nicht_erkannt, nie mehrdeutig', { skip: !hatProben && 'Proben-Verzeichnis fehlt' }, async t => {
  const proben = ladeProben();
  const tabelle = new Map(); // format -> status -> Anzahl
  const fehler = [];
  const zaehle = (format, status) => {
    const z = tabelle.get(format) ?? {};
    z[status] = (z[status] ?? 0) + 1;
    tabelle.set(format, z);
  };
  let beigaben = 0;
  for (const p of proben) {
    const vorher = statSync(p.pfad).mtimeMs;
    let r;
    try {
      r = await inspectAsset(p.pfad);
    } catch (e) {
      fehler.push(p.name + ': WIRFT ' + e);
      continue;
    }
    try {
      pruefeSchema(r, p.name);
    } catch (e) {
      fehler.push(p.name + ': Schema: ' + e.message);
      continue;
    }
    const soll = erwartet(p);
    if (soll === null) {
      beigaben++;
      if (r.status !== 'nicht_erkannt' || !codes(r).includes('kein_inspektor')) fehler.push(p.name + ': Beigabe sollte nicht_erkannt/kein_inspektor sein, ist ' + r.status);
      zaehle('(beigabe)', r.status);
      continue;
    }
    zaehle(r.format ?? '(null)', r.status);
    if (r.format !== soll) fehler.push(p.name + ': Format ' + r.format + ' statt ' + soll);
    if (r.status === 'nicht_erkannt') fehler.push(p.name + ': nicht_erkannt');
    if (r.status === 'fehler' || r.status === 'quelle_nicht_gefunden') fehler.push(p.name + ': Status ' + r.status + ' ' + JSON.stringify(codes(r)));
    if (!r.inspector) fehler.push(p.name + ': ohne Inspektor');
    if (codes(r).includes('erkennung_mehrdeutig')) fehler.push(p.name + ': mehrdeutig');
    if (r.size !== statSync(p.pfad).size) fehler.push(p.name + ': size');
    if (r.sha256 !== null && r.sha256 !== sha(p.pfad)) fehler.push(p.name + ': sha256 weicht ab');
    if (statSync(p.pfad).mtimeMs !== vorher) fehler.push(p.name + ': mtime veraendert');
  }
  const zeilen = [...tabelle].sort(([a], [b]) => a.localeCompare(b)).map(([f, z]) => f.padEnd(10) + STATI.map(s => (z[s] ?? 0).toString().padStart(4)).join(' '));
  t.diagnostic('Proben gesamt: ' + proben.length + ' (davon Beigaben ohne Inspektor: ' + beigaben + ')');
  t.diagnostic('Format     ' + STATI.map(s => s.slice(0, 4).padStart(4)).join(' ') + '   (ok teil nich fehl quel)');
  for (const z of zeilen) t.diagnostic(z);
  assert.deepEqual(fehler, []);
  assert.ok(proben.length >= 133);
});

test('OHNE ENDUNG: jede Probe als Datei \'datei\' — eindeutig oder bewusst mehrdeutig (zip/usdz/gz/blend-komprimiert), sonst kein Magic -> nicht_erkannt', { skip: !hatProben && 'Proben-Verzeichnis fehlt' }, async t => {
  const proben = ladeProben();
  /** Formate, die ohne Endung bewusst mehrdeutig bleiben (Magic mit anderem Inspektor geteilt, siehe inspectors/index.ts). */
  const MEHRDEUTIG_ERLAUBT = new Set(['zip', 'usdz', 'tar.gz', 'blend']);
  /** Formate ohne eigenes Magic am Dateianfang: ohne Endung kein Treffer, aber auch keine Mehrdeutigkeit. */
  const OHNE_MAGIC = new Set(['gltf', 'obj', 'stl', 'dae', 'tar', 'pak']);
  const fehler = [];
  const eindeutig = [];
  const mehrdeutig = [];
  const unerkannt = [];
  let i = 0;
  for (const p of proben) {
    const soll = erwartet(p);
    const dir = join(tmp, 'ohne' + i++);
    mkdirSync(dir);
    const kopie = join(dir, 'datei');
    copyFileSync(p.pfad, kopie);
    const r = await inspectAsset(kopie);
    pruefeSchema(r, p.name + ' (ohne Endung)');
    if (soll === null) {
      if (r.status !== 'nicht_erkannt') fehler.push(p.name + ': Beigabe ohne Endung erkannt als ' + r.format);
      continue;
    }
    if (codes(r).includes('erkennung_mehrdeutig')) {
      mehrdeutig.push(p.name + ' [' + soll + ']');
      if (!MEHRDEUTIG_ERLAUBT.has(soll)) fehler.push(p.name + ': unerwartet mehrdeutig ohne Endung (Format ' + soll + ')');
      if (r.status !== 'nicht_erkannt') fehler.push(p.name + ': mehrdeutig, aber Status ' + r.status);
    } else if (r.status === 'nicht_erkannt') {
      unerkannt.push(p.name + ' [' + soll + ']');
      if (!OHNE_MAGIC.has(soll)) fehler.push(p.name + ': ohne Endung nicht erkannt, obwohl das Format ein Magic haben sollte (' + soll + ')');
    } else {
      eindeutig.push(p.name);
      if (r.format !== soll) fehler.push(p.name + ': ohne Endung Format ' + r.format + ' statt ' + soll);
    }
  }
  t.diagnostic('ohne Endung: eindeutig ' + eindeutig.length + ', bewusst mehrdeutig ' + mehrdeutig.length + ', kein Magic (nicht_erkannt) ' + unerkannt.length);
  t.diagnostic('mehrdeutig: ' + mehrdeutig.join('; '));
  t.diagnostic('nicht erkannt: ' + unerkannt.join('; '));
  assert.deepEqual(fehler, []);
  // Gegenprobe: die Pruefung sieht beide Seiten (sonst waere "keine Fehler" wertlos)
  assert.ok(eindeutig.length > 50, 'viele Proben sind auch ohne Endung eindeutig');
  assert.ok(mehrdeutig.length > 0, 'die bewusst mehrdeutigen Faelle kommen vor');
});
