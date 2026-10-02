/**
 * Textur-/Bild-Inspektoren (P4-T64): PNG, JPEG, WebP, DDS, KTX, KTX2, EXR, HDR.
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-textur/dist node --test packages/core/tests/asset-intel-textur.test.mjs
 *         (ohne ASSET_TEST_DIST gilt packages/core/dist)
 *
 * DREI BLOECKE, im Namen markiert:
 *  [SPEC]  handgebaute Dateien nach Spezifikation (scripts/asset-fixtures-textur.mjs). Belegt Spec-Konformitaet,
 *          NICHT die Uebereinstimmung mit Fremdwerkzeugen.
 *  [ECHT]  von Fremdwerkzeugen erzeugte Dateien (PIL, ImageMagick, ffmpeg, oiiotool) mit unabhaengig bekannten Werten.
 *          Fehlt ein Werkzeug, wird der Fall uebersprungen (nicht rot).
 *  [PROBE] echte Dateien aus ASSET_SAMPLES_DIR (Default ~/dev/synapse-testdaten/asset-samples). Fehlt Datei/Verzeichnis: uebersprungen.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const samples = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
const A = await import(pathToFileURL(join(dist, 'asset-intel', 'index.js')).href);
const T = await import(pathToFileURL(join(dist, 'asset-intel', 'inspectors', 'textur', 'index.js')).href);
const F = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-textur.mjs')).href);

const reg = new A.AssetRegistry();
for (const i of T.assetTexturInspektoren) reg.register(i);
const fx = await F.erzeugeTexturFixtures();
after(() => fx.aufraeumen());

const lauf = (key, opts = {}) => A.inspectAsset(fx.pfade[key], { registry: reg, ...opts });
const laufPfad = (p, opts = {}) => A.inspectAsset(p, { registry: reg, ...opts });
const codes = r => r.warnings.map(w => w.code);
const namen = r => r.objects.map(o => o.name);

function identifyDims(pfad) {
  try {
    const o = execFileSync('magick', ['identify', '-format', '%w %h\n', pfad + '[0]'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n')[0].split(' ').map(Number);
    return o.length === 2 && o.every(Number.isFinite) ? { w: o[0], h: o[1] } : null;
  } catch {
    return null;
  }
}

describe('Erkennung und Registry', () => {
  test('acht Inspektoren, eindeutige ids, Format-Namen vollstaendig', () => {
    assert.equal(T.assetTexturInspektoren.length, 8);
    assert.deepEqual(T.assetTexturInspektoren.map(i => i.id).sort(), ['textur-dds', 'textur-exr', 'textur-hdr', 'textur-jpeg', 'textur-ktx', 'textur-ktx2', 'textur-png', 'textur-webp']);
    assert.deepEqual(reg.formats(), ['dds', 'exr', 'hdr', 'jpeg', 'ktx', 'ktx2', 'png', 'webp']);
    for (const i of T.assetTexturInspektoren) assert.ok(Number.isInteger(i.version) && i.version >= 1, i.id);
  });

  test('[SPEC] jedes Format wird allein ueber Magic erkannt, ohne mehrdeutige Treffer (Datei ohne Endung)', async () => {
    const erwartet = { pngRgba: 'textur-png', jpegVoll: 'textur-jpeg', webpLossy: 'textur-webp', ddsBc1Mips: 'textur-dds', ktxRgba8: 'textur-ktx', ktx2Rgba8Srgb: 'textur-ktx2', exrRgbaHalf: 'textur-exr', hdrRgbe: 'textur-hdr', hdrKurz: 'textur-hdr' };
    for (const [key, id] of Object.entries(erwartet)) {
      const kopf = fx.daten[key].subarray(0, 64);
      const d = A.detectAsset('/x/ohne-endung', kopf, reg);
      assert.equal(d.inspector?.id, id, key);
      assert.equal(d.via, 'magic', key);
      assert.deepEqual(d.warnings, [], key);
    }
  });

  test('[SPEC] KTX 1.1 und KTX2 sind trotz aehnlicher Kennung nicht verwechselbar', () => {
    assert.equal(A.detectAsset('/x/a', fx.daten.ktxRgba8.subarray(0, 32), reg).format, 'ktx');
    assert.equal(A.detectAsset('/x/a', fx.daten.ktx2Rgba8Srgb.subarray(0, 32), reg).format, 'ktx2');
  });

  test('[SPEC] WebP = WEBP an Offset 8: eine WAV-Datei (RIFF/WAVE) wird NICHT als WebP erkannt', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(30)]);
    const d = A.detectAsset('/x/ton.wav', wav, reg);
    assert.equal(d.inspector, null);
    assert.equal(d.format, null);
  });

  test('[SPEC] KOLLISION mit generic-binary (Standard-Registry): png/jpeg ohne Endung mehrdeutig, mit Endung aufloesbar', () => {
    const r2 = new A.AssetRegistry();
    // Grundschicht-Stand von generic-binary (png/jpeg-Magic, vor der Verdrahtung).
    r2.register({
      ...A.genericBinaryInspector,
      formats: ['png', 'jpeg'],
      magic: [
        { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], format: 'png' },
        { offset: 0, bytes: [0xff, 0xd8, 0xff], format: 'jpeg' },
      ],
    });
    for (const i of T.assetTexturInspektoren) r2.register(i);
    const ohne = A.detectAsset('/x/bild', fx.daten.pngRgba.subarray(0, 64), r2);
    assert.equal(ohne.inspector, null, 'ohne Endung muss die Kollision zu "kein Treffer" aufloesen');
    assert.ok(ohne.warnings.some(w => w.code === 'erkennung_mehrdeutig'));
    const mit = A.detectAsset('/x/bild.png', fx.daten.pngRgba.subarray(0, 64), r2);
    assert.equal(mit.inspector?.id, 'textur-png');
    assert.equal(mit.via, 'magic_und_endung');
    // WebP, DDS, KTX, EXR, HDR kollidieren nicht
    assert.equal(A.detectAsset('/x/bild', fx.daten.ddsBc1Mips.subarray(0, 64), r2).inspector?.id, 'textur-dds');
  });

  test('[SPEC] Endung passt nicht zum Inhalt: Inhalt gilt, Warnung endung_widerspricht_inhalt', async () => {
    const png = await lauf('pngAlsJpg');
    assert.equal(png.format, 'png');
    assert.equal(png.inspector, 'textur-png');
    assert.ok(codes(png).includes('endung_widerspricht_inhalt'));
    assert.equal(png.metadata.width, 32);
    const dds = await lauf('ddsAlsPng');
    assert.equal(dds.format, 'dds');
    assert.ok(codes(dds).includes('endung_widerspricht_inhalt'));
  });
});

describe('[SPEC] PNG', () => {
  test('Minimaldatei: Felder exakt', async () => {
    const r = await lauf('pngRgba');
    assert.equal(r.status, 'ok');
    assert.equal(r.asset_type, 'image');
    assert.equal(r.format, 'png');
    assert.equal(r.inspector, 'textur-png');
    assert.deepEqual(r.warnings, []);
    const m = r.metadata;
    assert.equal(m.kind, 'image');
    assert.equal(m.width, 3);
    assert.equal(m.height, 2);
    assert.equal(m.depth, 1);
    assert.equal(m.mip_levels, 1);
    assert.equal(m.array_layers, 1);
    assert.equal(m.faces, 1);
    assert.equal(m.has_alpha, true);
    assert.equal(m.channels, 4);
    assert.equal(m.bits_per_channel, 8);
    assert.equal(m.power_of_two, false);
    assert.equal(m.geschaetzte_roh_bytes, 24);
    assert.equal(m.format_name, 'RGBA8');
    assert.equal(m.animated, false);
    assert.deepEqual(namen(r), ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual(r.objects[0].source_range, { offset: 8, length: 25 });
    assert.equal(r.objects[1].source_range.offset, 33);
    assert.equal(r.format_specific.crc.fehlerhaft, 0);
    assert.equal(r.format_specific.ihdr.color_type, 6);
  });

  test('viele Chunks: Palette, tRNS, gAMA, sRGB, iCCP, cHRM, pHYs, tIME, Texte, eXIf, IDAT-Lauf', async () => {
    const r = await lauf('pngPaletteViele');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.deepEqual(namen(r), ['IHDR', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'PLTE', 'tRNS', 'pHYs', 'tIME', 'tEXt', 'zTXt', 'iTXt', 'eXIf', 'IDAT', 'IEND']);
    const m = r.metadata;
    assert.equal(m.width, 16);
    assert.equal(m.height, 8);
    assert.equal(m.channels, 1);
    assert.equal(m.has_alpha, true, 'tRNS bedeutet Alpha');
    assert.equal(m.palette_eintraege, 4);
    assert.equal(m.interlaced, true);
    assert.equal(m.color_space, 'sRGB');
    assert.equal(m.icc_profil, 'test-profile');
    assert.equal(m.hat_exif, true);
    assert.ok(Math.abs(m.dpi_x - 72) < 0.1 && Math.abs(m.dpi_y - 72) < 0.1);
    const fs = r.format_specific;
    assert.equal(fs.gamma, 0.45455);
    assert.equal(fs.srgb_intent, 'relativ_farbmetrisch');
    assert.deepEqual(fs.chrm.white, [0.3127, 0.329]);
    assert.equal(fs.time, '2026-10-02T13:05:07Z');
    assert.deepEqual(fs.text.map(t => [t.chunk, t.schluessel, t.wert]), [['tEXt', 'Author', 'Fixture'], ['zTXt', 'Comment', 'komprimierter Text'], ['iTXt', 'Titel', 'Ueberschrift']]);
    assert.equal(fs.idat.chunks, 3);
    const idat = r.objects.find(o => o.name === 'IDAT');
    assert.equal(idat.data.anzahl_chunks, 3, 'drei aufeinanderfolgende IDAT = ein Objekt');
    assert.equal(fs.crc.geprueft, 17);
    assert.equal(fs.crc.fehlerhaft, 0);
    // source_range je Chunk fuegt sich lueckenlos aneinander
    let erwartetOffset = 8;
    for (const o of r.objects) {
      assert.equal(o.source_range.offset, erwartetOffset, o.name);
      erwartetOffset += o.source_range.length;
    }
    assert.equal(erwartetOffset, r.size, 'Chunk-Bereiche decken die ganze Datei ab');
  });

  test('APNG: acTL/fcTL/fdAT', async () => {
    const r = await lauf('pngAnimiert');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.animated, true);
    assert.equal(r.metadata.frame_count, 2);
    assert.equal(r.metadata.loop_count, 0);
    assert.deepEqual(namen(r), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
    assert.equal(r.objects[2].data.delay, '1/10');
  });

  test('CRC-Fehler ist Warnung, kein Abbruch', async () => {
    const r = await lauf('pngCrcFehler');
    assert.equal(r.status, 'teilweise');
    assert.deepEqual(codes(r), ['crc_fehler']);
    assert.equal(r.format_specific.crc.fehlerhaft, 1);
    assert.equal(r.objects.find(o => o.name === 'tEXt').data.crc_ok, false);
    assert.equal(r.metadata.width, 2, 'Metadaten trotzdem vorhanden');
  });

  test('abgeschnitten, nur Signatur, riesiges Chunk, ungueltiger Typ', async () => {
    const a = await lauf('pngAbgeschnitten');
    assert.equal(a.status, 'teilweise');
    assert.ok(codes(a).includes('chunk_abgeschnitten') && codes(a).includes('iend_fehlt'));
    assert.equal(a.metadata.width, 32);
    const n = await lauf('pngNurSignatur');
    assert.equal(n.status, 'fehler');
    assert.ok(codes(n).includes('ihdr_fehlt'));
    const g = await lauf('pngRiesigesChunk');
    assert.equal(g.status, 'teilweise');
    assert.ok(codes(g).includes('chunk_abgeschnitten'));
    const u = await lauf('pngUngueltigerTyp');
    assert.ok(codes(u).includes('chunk_ungueltig'));
  });

  test('falsche Magic mit .png: Fehler, wirft nicht', async () => {
    const r = await lauf('pngFalscheMagic');
    assert.equal(r.status, 'fehler');
    assert.ok(codes(r).includes('signatur_ungueltig'));
    assert.equal(r.metadata.width, undefined);
  });

  test('absurde Abmessungen 65536x65536: Warnung, kein Overflow, schnell', async () => {
    const t0 = Date.now();
    const r = await lauf('pngAbsurd');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(r.status, 'teilweise');
    assert.ok(codes(r).includes('abmessungen_absurd'));
    assert.equal(r.metadata.width, 65536);
    assert.equal(r.metadata.geschaetzte_roh_bytes, 65536 * 65536 * 4);
    assert.ok(Number.isSafeInteger(r.metadata.geschaetzte_roh_bytes));
  });

  test('leere Datei', async () => {
    const r = await lauf('leerPng');
    assert.ok(['teilweise', 'nicht_erkannt'].includes(r.status));
    assert.ok(codes(r).includes('datei_leer'));
    assert.equal(r.size, 0);
  });
});

describe('[SPEC] JPEG', () => {
  test('voller Marker-Satz: JFIF, Exif, ICC, COM, DQT, SOF0, DHT, SOS', async () => {
    const r = await lauf('jpegVoll');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.deepEqual(namen(r), ['APP0', 'APP1', 'APP2', 'COM', 'DQT', 'SOF0', 'DHT', 'SOS']);
    assert.deepEqual(r.objects[0].source_range, { offset: 2, length: 18 });
    const m = r.metadata;
    assert.equal(m.width, 16);
    assert.equal(m.height, 8);
    assert.equal(m.channels, 3);
    assert.equal(m.bits_per_channel, 8);
    assert.equal(m.has_alpha, false);
    assert.equal(m.progressive, false);
    assert.equal(m.chroma_subsampling, '4:2:0');
    assert.equal(m.dpi_x, 72);
    assert.equal(m.hat_exif, true);
    assert.equal(m.exif_orientation, 6);
    assert.equal(m.hat_icc_profil, true);
    assert.equal(m.icc_profil, 'TestProfil');
    assert.equal(m.kommentar, 'Kommentar-Test');
    assert.equal(m.color_space, 'YCbCr (ICC RGB)');
    assert.equal(m.geschaetzte_roh_bytes, 16 * 8 * 3);
    assert.equal(r.format_specific.scan_gestoppt_bei_sos, true);
    assert.equal(r.format_specific.jfif.version, '1.02');
  });

  test('progressiv, Graustufen, CMYK/YCCK', async () => {
    const p = await lauf('jpegProgressiv');
    assert.equal(p.metadata.progressive, true);
    assert.equal(p.metadata.width, 33);
    assert.equal(p.metadata.height, 17);
    assert.equal(p.metadata.power_of_two, false);
    assert.equal(p.metadata.hat_exif, false);
    const g = await lauf('jpegGrau');
    assert.equal(g.metadata.channels, 1);
    assert.equal(g.metadata.color_space, 'Graustufen');
    const c = await lauf('jpegCmyk');
    assert.equal(c.metadata.channels, 4);
    assert.equal(c.metadata.color_space, 'YCCK');
    assert.equal(c.format_specific.adobe_transform, 2);
  });

  test('abgeschnitten, ohne SOF, kaputte Segmentlaenge, falsche Magic, absurd', async () => {
    const a = await lauf('jpegAbgeschnitten');
    assert.notEqual(a.status, 'ok');
    assert.ok(codes(a).includes('segment_abgeschnitten'));
    const o = await lauf('jpegOhneSof');
    assert.equal(o.status, 'fehler');
    assert.ok(codes(o).includes('sof_fehlt'));
    const s = await lauf('jpegSegmentLaenge');
    assert.notEqual(s.status, 'ok');
    const f = await lauf('jpegFalscheMagic');
    assert.equal(f.status, 'fehler');
    assert.ok(codes(f).includes('signatur_ungueltig'));
    const x = await lauf('jpegAbsurd');
    assert.ok(codes(x).includes('abmessungen_absurd'));
    assert.equal(x.metadata.width, 65535);
  });
});

describe('[SPEC] WebP', () => {
  test('lossy, lossless, erweitert (VP8X mit ICC/EXIF/XMP/Alpha)', async () => {
    const a = await lauf('webpLossy');
    assert.equal(a.status, 'ok');
    assert.equal(a.metadata.width, 17);
    assert.equal(a.metadata.height, 9);
    assert.equal(a.metadata.kompression, 'lossy');
    assert.equal(a.metadata.has_alpha, false);
    assert.deepEqual(namen(a), ['VP8 ']);
    const b = await lauf('webpLossless');
    assert.equal(b.metadata.width, 20);
    assert.equal(b.metadata.height, 10);
    assert.equal(b.metadata.kompression, 'lossless');
    assert.equal(b.metadata.has_alpha, true);
    const c = await lauf('webpErweitert');
    assert.equal(c.status, 'ok', JSON.stringify(c.warnings));
    assert.equal(c.metadata.width, 40);
    assert.equal(c.metadata.height, 30);
    assert.equal(c.metadata.has_alpha, true);
    assert.equal(c.metadata.hat_icc_profil, true);
    assert.equal(c.metadata.hat_exif, true);
    assert.equal(c.metadata.hat_xmp, true);
    assert.deepEqual(namen(c), ['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'EXIF', 'XMP ']);
    assert.equal(c.objects[0].source_range.offset, 12);
  });

  test('animiert: ANIM/ANMF, Frame-Zahl, Dauer', async () => {
    const r = await lauf('webpAnimiert');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.animated, true);
    assert.equal(r.metadata.frame_count, 2);
    assert.equal(r.metadata.loop_count, 3);
    assert.equal(r.metadata.dauer_gesamt_ms, 350);
    const frames = r.objects.filter(o => o.kind === 'frame');
    assert.equal(frames.length, 2);
    assert.deepEqual([frames[1].data.x, frames[1].data.y, frames[1].data.breite, frames[1].data.hoehe, frames[1].data.dauer_ms], [2, 4, 8, 8, 250]);
    assert.equal(r.format_specific.frames_lossless, 1);
    assert.equal(r.format_specific.frames_lossy, 1);
  });

  test('abgeschnitten, kaputt, absurd', async () => {
    const a = await lauf('webpAbgeschnitten');
    assert.equal(a.status, 'teilweise');
    assert.ok(codes(a).includes('riff_groesse_abweichend') && codes(a).includes('chunk_abgeschnitten'));
    assert.equal(a.metadata.width, 17);
    const k = await lauf('webpKaputt');
    assert.equal(k.status, 'fehler');
    const x = await lauf('webpAbsurd');
    assert.ok(codes(x).includes('abmessungen_absurd'));
  });
});

describe('[SPEC] DDS', () => {
  test('BC1 mit voller Mip-Kette: Groesse stimmt exakt', async () => {
    const r = await lauf('ddsBc1Mips');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    const m = r.metadata;
    assert.equal(m.kind, 'texture');
    assert.equal(m.width, 256);
    assert.equal(m.height, 128);
    assert.equal(m.mip_levels, 9);
    assert.equal(m.format_name, 'BC1');
    assert.equal(m.faces, 1);
    assert.equal(m.power_of_two, true);
    assert.equal(m.geschaetzte_roh_bytes, 21864);
    assert.equal(m.nutzdaten.status, 'passt');
    assert.equal(m.nutzdaten.vorhanden_bytes, r.size - 128);
    assert.equal(r.format_specific.pixelformat.fourcc, 'DXT1');
    assert.equal(r.objects.length, 10);
    assert.deepEqual(r.objects[1].source_range, { offset: 128, length: 16384 });
    assert.equal(r.objects[9].name, 'mip8');
  });

  test('DXT10: BC7 mit Klartext + Rohkennung, alphaMode', async () => {
    const r = await lauf('ddsDx10Bc7');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.format_name, 'BC7');
    assert.equal(r.metadata.mip_levels, 7);
    assert.equal(r.metadata.alpha_modus, 'straight');
    assert.equal(r.metadata.geschaetzte_roh_bytes, 5488);
    assert.equal(r.format_specific.pixelformat.dxgi_name, 'BC7_UNORM');
    assert.equal(r.format_specific.pixelformat.dxgi_format, 98);
    assert.equal(r.format_specific.dxt10.resource_dimension, 3);
    assert.equal(r.objects[1].name, 'DDS_HEADER_DXT10');
    assert.deepEqual(r.objects[1].source_range, { offset: 128, length: 20 });
    assert.equal(r.metadata.nutzdaten.daten_offset, 148);
  });

  test('Cubemap (6 Flaechen, Bitmasken-Format), Volume, DXT10-Cube-Array', async () => {
    const c = await lauf('ddsCubemap');
    assert.equal(c.status, 'ok', JSON.stringify(c.warnings));
    assert.equal(c.metadata.faces, 6);
    assert.equal(c.metadata.cubemap, true);
    assert.equal(c.metadata.format_name, 'BGRA8');
    assert.equal(c.metadata.has_alpha, true);
    assert.equal(c.metadata.bits_per_channel, 8);
    assert.equal(c.metadata.geschaetzte_roh_bytes, 5460 * 6);
    assert.deepEqual(c.format_specific.cubemap_flaechen, ['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
    const v = await lauf('ddsVolumen');
    assert.equal(v.status, 'ok', JSON.stringify(v.warnings));
    assert.equal(v.metadata.depth, 8);
    assert.equal(v.metadata.volumen, true);
    assert.equal(v.metadata.dimension, 'texture3d');
    assert.equal(v.metadata.format_name, 'RGBA16F');
    assert.equal(v.metadata.geschaetzte_roh_bytes, 16 * 16 * 8 * 8);
    const a = await lauf('ddsDx10CubeArray');
    assert.equal(a.status, 'ok', JSON.stringify(a.warnings));
    assert.equal(a.metadata.faces, 6);
    assert.equal(a.metadata.array_layers, 2);
    assert.equal(a.metadata.format_name, 'BC3');
    assert.equal(a.metadata.geschaetzte_roh_bytes, 368 * 12);
  });

  test('Pflichtfaelle: abgeschnitten (Kopf/Daten), Mip-Zahl passt nicht, ueberschuessige Daten, falsche Magic, leer', async () => {
    const k = await lauf('ddsAbgeschnittenKopf');
    assert.equal(k.status, 'teilweise');
    assert.ok(codes(k).includes('abgeschnitten'));
    const d = await lauf('ddsAbgeschnittenDaten');
    assert.equal(d.status, 'teilweise');
    assert.deepEqual(codes(d), ['nutzdaten_zu_kurz']);
    assert.equal(d.metadata.width, 256);
    const m = await lauf('ddsMipFalsch');
    assert.ok(codes(m).includes('mip_zahl_passt_nicht'));
    assert.equal(m.metadata.mip_levels, 5, 'auf die moegliche Kette gekappt');
    const u = await lauf('ddsNeunMipsZuViele');
    assert.deepEqual(codes(u), ['nutzdaten_ueberschuss']);
    const f = await lauf('ddsFalscheMagic');
    assert.equal(f.status, 'fehler');
    const l = await lauf('leerDds');
    assert.ok(codes(l).includes('datei_leer'));
  });

  test('absurd 65536x65536x65536: Warnung, kein Overflow, keine Allokation', async () => {
    const rss0 = process.memoryUsage().rss;
    const t0 = Date.now();
    const r = await lauf('ddsAbsurd');
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(process.memoryUsage().rss - rss0 < 200 * 1024 * 1024, 'Speicher blaeht nicht auf');
    assert.ok(codes(r).includes('abmessungen_absurd'));
    assert.equal(r.metadata.depth, 65536);
    assert.equal(r.metadata.geschaetzte_roh_bytes, 65536 * 65536 * 65536 / 2);
    assert.ok(codes(r).includes('nutzdaten_zu_kurz'));
  });
});

describe('[SPEC] KTX 1.1', () => {
  test('RGBA8 mit Mip-Kette und Key/Value', async () => {
    const r = await lauf('ktxRgba8');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    const m = r.metadata;
    assert.equal(m.width, 16);
    assert.equal(m.height, 16);
    assert.equal(m.mip_levels, 5);
    assert.equal(m.format_name, 'RGBA8');
    assert.equal(m.has_alpha, true);
    assert.equal(m.geschaetzte_roh_bytes, 1364);
    assert.deepEqual(m.key_value, { KTXorientation: 'S=r,T=d', KTXwriter: 'asset-fixtures-textur' });
    assert.deepEqual(r.format_specific.levels.map(l => l.image_size), [1024, 256, 64, 16, 4]);
    assert.equal(r.format_specific.gl_internal_format_hex, '0x8058');
    assert.equal(r.format_specific.gl_type_name, 'UNSIGNED_BYTE');
    assert.equal(r.format_specific.gl_format_name, 'RGBA');
    assert.equal(r.objects.length, 7);
    assert.equal(r.objects[0].source_range.length, 64);
  });

  test('komprimiert (BC7), Cubemap, Big-Endian', async () => {
    const b = await lauf('ktxBc7');
    assert.equal(b.status, 'ok', JSON.stringify(b.warnings));
    assert.equal(b.metadata.format_name, 'BC7');
    assert.equal(b.metadata.komprimiert, true);
    assert.equal(b.metadata.geschaetzte_roh_bytes, 80);
    const c = await lauf('ktxCube');
    assert.equal(c.status, 'ok', JSON.stringify(c.warnings));
    assert.equal(c.metadata.faces, 6);
    assert.equal(c.metadata.geschaetzte_roh_bytes, 1920);
    const e = await lauf('ktxBigEndian');
    assert.equal(e.status, 'ok', JSON.stringify(e.warnings));
    assert.equal(e.metadata.endian, 'big');
    assert.equal(e.metadata.width, 4);
    assert.equal(e.metadata.key_value.KTXwriter, 'be');
  });

  test('Pflichtfaelle: abgeschnitten, Mip-Zahl, absurd, Key/Value-Laenge, kaputter Endian-Marker', async () => {
    const a = await lauf('ktxAbgeschnitten');
    assert.equal(a.status, 'teilweise');
    assert.ok(codes(a).includes('level_ueber_dateiende'));
    const k = await lauf('ktxKopfAbgeschnitten');
    assert.equal(k.status, 'teilweise');
    assert.ok(codes(k).includes('abgeschnitten'));
    const m = await lauf('ktxMipFalsch');
    assert.ok(codes(m).includes('mip_zahl_passt_nicht'));
    const x = await lauf('ktxAbsurd');
    assert.ok(codes(x).includes('abmessungen_absurd'));
    assert.equal(x.metadata.depth, 65536);
    const kv = await lauf('ktxKvZuLang');
    assert.ok(codes(kv).includes('kv_ueber_dateiende'));
    const en = await lauf('ktxEndianKaputt');
    assert.equal(en.status, 'fehler');
    assert.ok(codes(en).includes('endian_marker_ungueltig'));
  });
});

describe('[SPEC] KTX2', () => {
  test('RGBA8 sRGB: Header, Level-Index, DFD, Key/Value', async () => {
    const r = await lauf('ktx2Rgba8Srgb');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    const m = r.metadata;
    assert.equal(m.width, 16);
    assert.equal(m.mip_levels, 5);
    assert.equal(m.format_name, 'RGBA8 sRGB');
    assert.equal(m.has_alpha, true);
    assert.equal(m.transfer, 'SRGB');
    assert.equal(m.color_space, 'BT709');
    assert.equal(m.supercompression, 'keine');
    assert.equal(m.ktx_writer, 'asset-fixtures-textur v1');
    assert.equal(m.ktx_orientation, 'rd');
    assert.equal(m.geschaetzte_roh_bytes, 1364);
    const fs = r.format_specific;
    assert.equal(fs.vk_format, 43);
    assert.equal(fs.level_index.length, 5);
    assert.deepEqual(fs.level_index.map(l => l.byte_length), [1024, 256, 64, 16, 4]);
    assert.ok(fs.level_index.every(l => !l.ausserhalb));
    assert.equal(fs.dfd.color_model, 'RGBSDA');
    assert.equal(fs.dfd.color_primaries, 'BT709');
    assert.equal(fs.dfd.transfer_function, 'SRGB');
    assert.equal(fs.dfd.samples.length, 4);
    assert.deepEqual(namen(r), ['KTX2_HEADER', 'level0', 'level1', 'level2', 'level3', 'level4', 'DFD', 'KeyValueData']);
    assert.equal(r.objects[1].source_range.length, 1024);
  });

  test('BC7+Zstd, BasisLZ (vkFormat 0, ETC1S), Cubemap, Array', async () => {
    const z = await lauf('ktx2Bc7Zstd');
    assert.equal(z.status, 'ok', JSON.stringify(z.warnings));
    assert.equal(z.metadata.supercompression, 'Zstandard');
    assert.equal(z.metadata.format_name, 'BC7');
    assert.equal(z.format_specific.dfd.color_model, 'BC7');
    assert.deepEqual(z.format_specific.level_index.map(l => l.uncompressed_byte_length), [256, 16]);
    assert.equal(z.metadata.geschaetzte_roh_bytes, 80);
    const b = await lauf('ktx2BasisLz');
    assert.equal(b.status, 'ok', JSON.stringify(b.warnings));
    assert.equal(b.metadata.supercompression, 'BasisLZ');
    assert.equal(b.metadata.format_name, 'UNDEFINED (ETC1S)');
    assert.equal(b.metadata.has_alpha, true);
    assert.ok(namen(b).includes('SGD'));
    const c = await lauf('ktx2Cube');
    assert.equal(c.metadata.faces, 6);
    assert.equal(c.metadata.geschaetzte_roh_bytes, 1920);
    const a = await lauf('ktx2Array');
    assert.equal(a.metadata.array_layers, 3);
    assert.equal(a.metadata.format_name, 'RGBA16F');
    assert.equal(a.metadata.geschaetzte_roh_bytes, 4 * 4 * 8 * 3);
  });

  test('Pflichtfaelle: Level ausserhalb, abgeschnitten, Mip-Zahl, absurd, levelCount riesig, DFD ausserhalb', async () => {
    const l = await lauf('ktx2LevelAusserhalb');
    assert.equal(l.status, 'teilweise');
    assert.equal(codes(l).filter(c => c === 'level_ausserhalb').length, 3);
    const a = await lauf('ktx2Abgeschnitten');
    assert.equal(a.status, 'teilweise');
    assert.ok(codes(a).includes('levelindex_abgeschnitten'));
    const k = await lauf('ktx2KopfAbgeschnitten');
    assert.ok(codes(k).includes('abgeschnitten'));
    const m = await lauf('ktx2MipFalsch');
    assert.ok(codes(m).includes('mip_zahl_passt_nicht'));
    const x = await lauf('ktx2Absurd');
    assert.ok(codes(x).includes('abmessungen_absurd'));
    const h = await lauf('ktx2LevelCountHuge');
    assert.ok(codes(h).includes('levels_gekappt'));
    assert.ok(h.warnings.length < 40, `Warnflut begrenzt (${h.warnings.length})`);
    assert.ok(h.objects.length <= 40);
    const d = await lauf('ktx2DfdAusserhalb');
    assert.ok(codes(d).includes('dfd_ausserhalb'));
  });
});

describe('[SPEC] OpenEXR', () => {
  test('Scanline RGBA HALF: Attribute exakt', async () => {
    const r = await lauf('exrRgbaHalf');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    const m = r.metadata;
    assert.equal(m.width, 8);
    assert.equal(m.height, 4);
    assert.equal(m.format_name, 'RGBA16F');
    assert.equal(m.bits_per_channel, 16);
    assert.equal(m.channels, 4);
    assert.equal(m.has_alpha, true);
    assert.equal(m.compression, 'ZIP');
    assert.deepEqual(m.kanaele, ['A', 'B', 'G', 'R']);
    assert.equal(m.line_order, 'increasing_y');
    assert.equal(m.pixel_aspect_ratio, 1);
    assert.equal(m.geschaetzte_roh_bytes, 8 * 4 * 8);
    assert.deepEqual(m.display_window, [0, 0, 7, 3]);
    assert.deepEqual(r.format_specific.flags, { tiled: false, long_names: false, deep: false, multipart: false });
    assert.equal(r.format_specific.version, 2);
    assert.equal(r.objects.length, 1);
    assert.equal(r.objects[0].source_range.offset, 8);
    assert.ok(r.format_specific.attribute.some(a => a.name === 'compression'));
  });

  test('getilt + Mip-Stufen, FLOAT; gemischte Kanaltypen; Deep', async () => {
    const t = await lauf('exrFloatTiledMip');
    assert.equal(t.status, 'ok', JSON.stringify(t.warnings));
    assert.equal(t.metadata.format_name, 'RGB32F');
    assert.equal(t.metadata.tiled, true);
    assert.equal(t.metadata.mip_levels, 7);
    assert.equal(t.metadata.compression, 'PIZ');
    assert.equal(t.metadata.geschaetzte_roh_bytes, 2731 * 12);
    assert.deepEqual(t.format_specific.teile[0].tiles, { x: 16, y: 16, modus: 'MIPMAP_LEVELS', rundung: 'ROUND_DOWN' });
    const g = await lauf('exrGemischt');
    assert.equal(g.metadata.bits_per_channel, null);
    assert.deepEqual(g.format_specific.teile[0].kanaele.map(k => k.pixel_typ), ['HALF', 'HALF', 'HALF', 'UINT']);
    const d = await lauf('exrDeep');
    assert.equal(d.metadata.deep, true);
    assert.equal(d.metadata.geschaetzte_roh_bytes, null);
  });

  test('Multipart: alle Header', async () => {
    const r = await lauf('exrMultipart');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.multipart, true);
    assert.equal(r.metadata.teile, 2);
    assert.deepEqual(namen(r), ['beauty', 'depth']);
    assert.ok(r.objects.every(o => o.kind === 'part'));
    assert.equal(r.objects[0].data.type, 'scanlineimage');
    assert.equal(r.objects[0].data.compression, 'ZIP');
    assert.equal(r.objects[1].data.compression, 'RLE');
    assert.deepEqual(r.objects[1].data.kanaele.map(k => [k.name, k.pixel_typ]), [['Z', 'FLOAT']]);
    assert.ok(r.objects[1].source_range.offset > r.objects[0].source_range.offset);
    assert.equal(r.format_specific.teile.length, 2);
  });

  test('Pflichtfaelle: abgeschnitten, nur Magic, Attribut-Laenge riesig, absurd, Version, falsche Magic', async () => {
    const a = await lauf('exrAbgeschnitten');
    assert.equal(a.status, 'teilweise');
    assert.ok(codes(a).includes('attribut_ueber_dateiende'));
    const n = await lauf('exrNurMagic');
    assert.equal(n.status, 'teilweise');
    assert.ok(codes(n).includes('abgeschnitten'));
    const r = await lauf('exrAttributRiesig');
    assert.ok(codes(r).includes('attribut_ueber_dateiende'));
    assert.equal(r.metadata.width, 4, 'was vor dem kaputten Attribut stand, bleibt');
    const x = await lauf('exrAbsurd');
    assert.ok(codes(x).includes('abmessungen_absurd'));
    assert.equal(x.metadata.geschaetzte_roh_bytes, 65536 * 65536 * 8);
    const v = await lauf('exrFalscheVersion');
    assert.ok(codes(v).includes('version_unbekannt'));
    const f = await lauf('exrFalscheMagic');
    assert.equal(f.status, 'fehler');
  });
});

describe('[SPEC] Radiance HDR', () => {
  test('RGBE mit Kommentar und EXPOSURE', async () => {
    const r = await lauf('hdrRgbe');
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    const m = r.metadata;
    assert.equal(m.width, 8);
    assert.equal(m.height, 4);
    assert.equal(m.format_name, 'RGBE (8:8:8:8 shared exponent)');
    assert.equal(m.belichtung, 3);
    assert.equal(m.rle, true);
    assert.equal(m.transfer, 'linear');
    assert.equal(m.geschaetzte_roh_bytes, 8 * 4 * 4);
    assert.deepEqual(r.format_specific.kommentare, ['Kommentar eins']);
    assert.equal(r.format_specific.format, '32-bit_rle_rgbe');
    assert.equal(r.format_specific.aufloesungszeile, '-Y 4 +X 8');
    assert.equal(r.format_specific.pixel_daten_bytes, 128);
    assert.deepEqual(namen(r), ['header', 'resolution']);
    assert.equal(r.objects[0].source_range.offset, 0);
    assert.equal(r.objects[1].source_range.offset, r.objects[0].source_range.length);
  });

  test('#?RGBE, XYZE und andere Orientierung; Pflichtfaelle', async () => {
    const k = await lauf('hdrKurz');
    assert.equal(k.status, 'ok', JSON.stringify(k.warnings));
    assert.equal(k.metadata.width, 3);
    assert.equal(k.metadata.height, 2);
    assert.equal(k.metadata.power_of_two, false);
    const x = await lauf('hdrXyz');
    assert.equal(x.metadata.color_space, 'CIE XYZ');
    assert.equal(x.metadata.width, 16);
    assert.equal(x.metadata.height, 8);
    assert.ok(codes(x).includes('orientierung_unueblich'));
    assert.equal(x.status, 'ok', 'Orientierungshinweis ist kein Defekt');
    assert.ok(codes(await lauf('hdrAbgeschnitten')).includes('aufloesung_fehlt'));
    assert.ok(codes(await lauf('hdrOhneLeerzeile')).includes('leerzeile_fehlt'));
    assert.ok(codes(await lauf('hdrFalscheAufloesung')).includes('aufloesung_ungueltig'));
    const a = await lauf('hdrAbsurd');
    assert.ok(codes(a).includes('abmessungen_absurd'));
    assert.equal((await lauf('hdrFalscheMagic')).status, 'fehler');
  });
});

describe('Grenzen, Schema, Verhalten von inspectAsset', () => {
  test('maxObjects kappt die Chunk-Liste mit Warnung', async () => {
    const r = await lauf('pngPaletteViele', { maxObjects: 5 });
    assert.ok(r.objects.length <= 5);
    assert.ok(codes(r).includes('chunk_liste_gekappt'));
    assert.notEqual(r.status, 'ok');
  });

  test('maxFileBytes: nur Erkennung', async () => {
    const r = await lauf('ddsBc1Mips', { maxFileBytes: 100 });
    assert.ok(codes(r).includes('datei_zu_gross'));
    assert.equal(r.format, 'dds');
    assert.deepEqual(r.metadata, {});
  });

  test('maxReadBytes: Lesegrenze wird zur Warnung, nicht zum Wurf', async () => {
    for (const key of ['pngPaletteViele', 'jpegVoll', 'webpAnimiert', 'ddsBc1Mips', 'ktx2Rgba8Srgb', 'exrMultipart', 'hdrRgbe']) {
      const r = await lauf(key, { maxReadBytes: 16 });
      assert.ok(['fehler', 'teilweise'].includes(r.status), `${key}: ${r.status}`);
      assert.ok(codes(r).some(c => c === 'lesegrenze_ueberschritten' || c === 'abgeschnitten'), `${key}: ${codes(r)}`);
    }
  });

  test('es werden nie mehr Bytes gelesen als der Kopfbereich: grosse Datei, kleine maxReadBytes reichen', async () => {
    // 5 MiB EXR-Attrappe: Header klein, Rest Muell; Header-Lesefenster (1 MiB) liegt unter maxReadBytes 2 MiB.
    const { writeFile } = await import('node:fs/promises');
    const p = join(fx.dir, 'gross.exr');
    await writeFile(p, Buffer.concat([fx.daten.exrRgbaHalf.subarray(0, fx.daten.exrRgbaHalf.length - 40), Buffer.alloc(5 * 1024 * 1024, 7)]));
    const r = await laufPfad(p, { maxReadBytes: 2 * 1024 * 1024 });
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.width, 8);
  });

  test('Ergebnisschema vollstaendig und JSON-serialisierbar, parser_version = Inspektor-Version, Objekte mit source_range', async () => {
    const kernfelder = ['asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata', 'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific'];
    const gemeinsam = ['kind', 'format_name', 'width', 'height', 'depth', 'mip_levels', 'array_layers', 'faces', 'has_alpha', 'channels', 'bits_per_channel', 'color_space', 'transfer', 'power_of_two', 'geschaetzte_roh_bytes'];
    let geprueft = 0;
    for (const key of Object.keys(fx.pfade)) {
      const r = await lauf(key);
      for (const f of kernfelder) assert.ok(f in r, `${key}: Feld ${f} fehlt`);
      assert.equal(typeof r.extracted_at, 'string');
      assert.doesNotThrow(() => JSON.stringify(r), key);
      assert.equal(r.references.length, 0);
      if (r.inspector) {
        const insp = reg.get(r.inspector);
        assert.equal(r.parser_version, insp.version, key);
      }
      if (r.status === 'ok') {
        for (const f of gemeinsam) assert.ok(f in r.metadata, `${key}: metadata.${f} fehlt`);
        assert.ok(['texture', 'image'].includes(r.metadata.kind));
        assert.equal(r.asset_type, 'image');
        assert.match(r.sha256, /^[0-9a-f]{64}$/);
        for (const o of r.objects) {
          assert.ok(o.source_range && Number.isInteger(o.source_range.offset) && Number.isInteger(o.source_range.length), `${key}: ${o.name} ohne source_range`);
          assert.ok(o.source_range.offset >= 0 && o.source_range.offset + o.source_range.length <= r.size, `${key}: ${o.name} ausserhalb der Datei`);
        }
        geprueft++;
      }
    }
    assert.ok(geprueft >= 25, `nur ${geprueft} ok-Faelle geprueft`);
  });

  test('nur lesend: Hash und mtime der Fixture bleiben unveraendert', async () => {
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const p = fx.pfade.ktx2Rgba8Srgb;
    const h0 = createHash('sha256').update(readFileSync(p)).digest('hex');
    const m0 = statSync(p).mtimeMs;
    const r = await laufPfad(p);
    assert.equal(r.sha256, h0);
    assert.equal(createHash('sha256').update(readFileSync(p)).digest('hex'), h0);
    assert.equal(statSync(p).mtimeMs, m0);
  });

  test('Fixtures sind deterministisch (zwei Laeufe, gleiche Bytes)', async () => {
    const zweite = await F.erzeugeTexturFixtures(undefined, { echt: false });
    try {
      for (const k of Object.keys(fx.daten)) assert.ok(fx.daten[k].equals(zweite.daten[k]), k);
    } finally {
      await zweite.aufraeumen();
    }
  });

  test('alle absurden/boesartigen Fixtures zusammen: schnell und ohne Speicher-Aufblaehen', async () => {
    const boese = ['pngAbsurd', 'pngRiesigesChunk', 'jpegAbsurd', 'jpegSegmentLaenge', 'webpAbsurd', 'webpKaputt', 'ddsAbsurd', 'ktxAbsurd', 'ktxKvZuLang', 'ktx2Absurd', 'ktx2LevelCountHuge', 'ktx2DfdAusserhalb', 'exrAbsurd', 'exrAttributRiesig', 'hdrAbsurd'];
    const rss0 = process.memoryUsage().rss;
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) for (const k of boese) await lauf(k);
    assert.ok(Date.now() - t0 < 10000, `Dauer ${Date.now() - t0} ms`);
    assert.ok(process.memoryUsage().rss - rss0 < 300 * 1024 * 1024, 'Speicherzuwachs unter 300 MiB');
  });
});

describe('[SPEC] Robustheit: Abschneiden und Bytekorruption (deterministischer Fuzz)', () => {
  test('kein inspektor_fehler/interner_fehler, kein Wurf, Schema bleibt vollstaendig', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { extname } = await import('node:path');
    let seed = 0x12345678;
    const zufall = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const p = join(fx.dir, 'fuzz.bin');
    const kernfelder = ['asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata', 'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific'];
    let laeufe = 0;
    const t0 = Date.now();
    const schlimm = [];
    for (const [key, buf] of Object.entries(fx.daten)) {
      if (buf.length === 0 || buf.length > 40000) continue;
      const endung = extname(fx.pfade[key]);
      const varianten = [];
      for (let i = 1; i <= 24; i++) varianten.push(buf.subarray(0, Math.floor((buf.length * i) / 25)));
      for (let i = 0; i < 40; i++) {
        const kopie = Buffer.from(buf);
        const anzahl = 1 + (zufall() % 3);
        for (let k = 0; k < anzahl; k++) kopie[zufall() % Math.min(kopie.length, 300)] = zufall() & 0xff;
        varianten.push(kopie);
      }
      for (const v of varianten) {
        await writeFile(p + endung, v);
        const r = await laufPfad(p + endung);
        laeufe++;
        for (const f of kernfelder) assert.ok(f in r, `${key}: ${f} fehlt`);
        const schlecht = codes(r).filter(c => c === 'inspektor_fehler' || c === 'interner_fehler');
        if (schlecht.length > 0) schlimm.push(`${key}: ${r.warnings.find(w => schlecht.includes(w.code)).message}`);
        assert.doesNotThrow(() => JSON.stringify(r));
      }
    }
    assert.deepEqual(schlimm.slice(0, 5), [], `${schlimm.length} Faelle mit unerwarteter Ausnahme im Inspektor`);
    assert.ok(laeufe > 3000, `nur ${laeufe} Laeufe`);
    assert.ok(Date.now() - t0 < 60000, `Dauer ${Date.now() - t0} ms`);
  });
});

describe('[ECHT] Dateien von Fremdwerkzeugen (PIL, ImageMagick, ffmpeg, oiiotool)', () => {
  const echt = (t, name) => {
    const e = fx.echt[name];
    if (!e) t.skip(`Werkzeug/Datei nicht verfuegbar: ${name}`);
    return e;
  };

  test('Abmessungen aller echten Dateien = unabhaengig vom Erzeuger bekannte Werte', async t => {
    const namenListe = Object.keys(fx.echt).filter(n => fx.echt[n].w);
    if (namenListe.length === 0) return t.skip('keine echten Dateien erzeugt');
    for (const n of namenListe) {
      const r = await laufPfad(fx.echt[n].datei);
      assert.equal(r.metadata.width, fx.echt[n].w, `${n}: Breite`);
      assert.equal(r.metadata.height, fx.echt[n].h, `${n}: Hoehe`);
      assert.equal(r.status, 'ok', `${n}: ${JSON.stringify(r.warnings)}`);
    }
  });

  test('PNG (PIL): RGBA, Palette+tRNS, ICC, APNG', async t => {
    const a = echt(t, 'echt-rgba.png');
    if (!a) return;
    const r = await laufPfad(a.datei);
    assert.equal(r.metadata.has_alpha, true);
    assert.equal(r.metadata.channels, 4);
    assert.equal(r.metadata.bits_per_channel, 8);
    assert.ok(Math.abs(r.metadata.dpi_x - 72) < 0.1);
    const p = await laufPfad(fx.echt['echt-palette.png'].datei);
    assert.equal(p.metadata.channels, 1);
    assert.equal(p.metadata.palette_eintraege, 256);
    assert.equal(p.metadata.has_alpha, true);
    const i = await laufPfad(fx.echt['echt-icc.png'].datei);
    assert.match(i.metadata.color_space, /^ICC:/);
    const an = await laufPfad(fx.echt['echt-anim.png'].datei);
    assert.equal(an.metadata.animated, true);
    assert.equal(an.metadata.frame_count, 3);
    assert.equal(an.metadata.loop_count, 0);
  });

  test('JPEG (PIL/ImageMagick): progressiv, DPI, Exif-Orientation, ICC, Graustufen, CMYK', async t => {
    if (!echt(t, 'echt-prog.jpg')) return;
    const pr = await laufPfad(fx.echt['echt-prog.jpg'].datei);
    assert.equal(pr.metadata.progressive, true);
    assert.equal(pr.metadata.dpi_x, 300);
    const ba = await laufPfad(fx.echt['echt-base.jpg'].datei);
    assert.equal(ba.metadata.progressive, false);
    assert.equal(ba.metadata.chroma_subsampling, '4:4:4');
    const ex = await laufPfad(fx.echt['echt-exif.jpg'].datei);
    assert.equal(ex.metadata.exif_orientation, 6);
    const ic = await laufPfad(fx.echt['echt-icc.jpg'].datei);
    assert.match(ic.metadata.icc_profil, /sRGB/);
    assert.equal((await laufPfad(fx.echt['echt-gray.jpg'].datei)).metadata.channels, 1);
    if (fx.echt['echt-cmyk.jpg']) assert.equal((await laufPfad(fx.echt['echt-cmyk.jpg'].datei)).metadata.channels, 4);
  });

  test('WebP (PIL): lossy, lossless, animiert', async t => {
    if (!echt(t, 'echt-lossy.webp')) return;
    const ly = await laufPfad(fx.echt['echt-lossy.webp'].datei);
    assert.equal(ly.metadata.kompression, 'lossy');
    assert.equal(ly.metadata.has_alpha, true);
    const ll = await laufPfad(fx.echt['echt-lossless.webp'].datei);
    assert.equal(ll.metadata.kompression, 'lossless');
    const an = await laufPfad(fx.echt['echt-anim.webp'].datei);
    assert.equal(an.metadata.animated, true);
    assert.equal(an.metadata.frame_count, 3);
    assert.equal(an.metadata.loop_count, 2);
  });

  test('DDS (ImageMagick): Format, Mips, Nutzdatengroesse stimmt auf das Byte', async t => {
    if (!echt(t, 'echt-dxt5.dds')) return;
    const d5 = await laufPfad(fx.echt['echt-dxt5.dds'].datei);
    assert.equal(d5.metadata.format_name, 'BC3');
    assert.equal(d5.metadata.mip_levels, 7);
    assert.equal(d5.metadata.nutzdaten.status, 'passt');
    assert.equal(d5.metadata.geschaetzte_roh_bytes, d5.size - 128);
    const d1 = await laufPfad(fx.echt['echt-dxt1.dds'].datei);
    assert.equal(d1.metadata.format_name, 'BC1');
    assert.equal(d1.metadata.nutzdaten.status, 'passt');
    const dr = await laufPfad(fx.echt['echt-roh.dds'].datei);
    assert.equal(dr.metadata.bits_per_channel, 8);
    assert.equal(dr.metadata.nutzdaten.status, 'passt');
  });

  test('EXR (oiiotool/ImageMagick/ffmpeg): Kompression, Kanaltypen, getilt', async t => {
    if (!echt(t, 'echt-oiio-half-zip.exr')) return;
    const h = await laufPfad(fx.echt['echt-oiio-half-zip.exr'].datei);
    assert.equal(h.metadata.compression, 'ZIP');
    assert.equal(h.metadata.bits_per_channel, 16);
    assert.equal(h.metadata.has_alpha, true);
    assert.equal(h.metadata.geschaetzte_roh_bytes, 32 * 16 * 4 * 2);
    const f = await laufPfad(fx.echt['echt-oiio-float-piz.exr'].datei);
    assert.equal(f.metadata.compression, 'PIZ');
    assert.equal(f.metadata.bits_per_channel, 32);
    assert.equal(f.metadata.channels, 3);
    const ti = await laufPfad(fx.echt['echt-oiio-tiled.exr'].datei);
    assert.equal(ti.metadata.tiled, true);
    assert.equal(ti.format_specific.teile[0].tiles.x, 16);
    assert.equal(ti.metadata.compression, 'ZIPS');
  });

  test('HDR (ImageMagick/oiiotool)', async t => {
    if (!echt(t, 'echt-im.hdr')) return;
    const r = await laufPfad(fx.echt['echt-im.hdr'].datei);
    assert.equal(r.metadata.width, 24);
    assert.equal(r.metadata.height, 12);
    assert.equal(r.format_specific.format, '32-bit_rle_rgbe');
    if (fx.echt['echt-oiio.hdr']) assert.equal((await laufPfad(fx.echt['echt-oiio.hdr'].datei)).metadata.width, 20);
  });
});

describe('[PROBE] Echte Beispieldateien aus ASSET_SAMPLES_DIR', () => {
  const probe = (t, rel) => {
    const p = join(samples, rel);
    if (!existsSync(p)) {
      t.skip(`Probe fehlt: ${p}`);
      return null;
    }
    return p;
  };
  const mipsMax = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;

  test('Abmessungen gegen ImageMagick identify (unabhaengig) fuer PNG, JPEG, WebP, DDS, EXR, HDR', async t => {
    const kandidaten = ['png/Containers_icon.png', 'png/Bianco_e_Nero_con_diagonale_Arancione.png', 'jpg/Pexels-pixabay-164828.jpg', 'jpg/Pexels-pixabay-221164.jpg', 'webp/carconcept/Dash_E.webp', 'webp/carconcept/Hex_N.webp', 'webp/carconcept/Dot_N.webp', 'dds/explosion_dxt5_mip.dds', 'dds/disturb_dxt1_mip.dds', 'dds/disturb_dxt1_nomip.dds', 'dds/disturb_argb_nomip.dds', 'exr/kloofendal_48d_partly_cloudy_puresky_1k.exr', 'exr/wooden_crate_01/wooden_crate_01_nor_gl_1k.exr', 'hdr/kloofendal_48d_partly_cloudy_puresky_1k.hdr'];
    let verglichen = 0;
    for (const rel of kandidaten) {
      const p = join(samples, rel);
      if (!existsSync(p)) continue;
      const id = identifyDims(p);
      if (!id) continue;
      const r = await laufPfad(p);
      assert.equal(r.status, 'ok', `${rel}: ${JSON.stringify(r.warnings)}`);
      assert.equal(r.metadata.width, id.w, `${rel}: Breite`);
      assert.equal(r.metadata.height, id.h, `${rel}: Hoehe`);
      verglichen++;
    }
    if (verglichen === 0) t.skip('keine Proben oder kein identify');
  });

  test('DDS (three.js-Beispieltexturen): Format, Mips, Nutzdatengroesse = Dateigroesse minus Header', async t => {
    const faelle = [
      ['dds/explosion_dxt5_mip.dds', 'BC3', 256, 9, 128],
      ['dds/disturb_dxt1_mip.dds', 'BC1', 512, 10, 128],
      ['dds/disturb_dxt1_nomip.dds', 'BC1', 512, 1, 128],
      ['dds/disturb_argb_nomip.dds', 'BGRA8', 256, 1, 128],
      ['dds/disturb_dx10_bc6h_unsigned_nomip.dds', 'BC6H', 512, 1, 148],
    ];
    let n = 0;
    for (const [rel, fmt, kante, mips, kopf] of faelle) {
      const p = join(samples, rel);
      if (!existsSync(p)) continue;
      const r = await laufPfad(p);
      assert.equal(r.status, 'ok', `${rel}: ${JSON.stringify(r.warnings)}`);
      assert.equal(r.metadata.format_name, fmt, rel);
      assert.equal(r.metadata.width, kante, rel);
      assert.equal(r.metadata.mip_levels, mips, rel);
      assert.equal(r.metadata.geschaetzte_roh_bytes, r.size - kopf, `${rel}: Nutzdaten`);
      n++;
    }
    if (n === 0) t.skip('keine DDS-Proben');
  });

  test('KTX 1.1 (three.js): BC1 mit 10 Mips, BC5-Normalmap', async t => {
    const a = probe(t, 'ktx/disturb_BC1.ktx');
    if (!a) return;
    const r = await laufPfad(a);
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.format_name, 'BC1');
    assert.equal(r.metadata.width, 512);
    assert.equal(r.metadata.mip_levels, 10);
    assert.equal(r.format_specific.levels.length, 10);
    assert.equal(r.format_specific.levels[0].image_size, 512 * 512 / 2);
    const b = probe(t, 'ktx/normal.bc5.ktx');
    if (!b) return;
    const n = await laufPfad(b);
    assert.equal(n.status, 'ok', JSON.stringify(n.warnings));
    assert.equal(n.metadata.format_name, 'BC5');
    assert.equal(n.metadata.width, 256);
    assert.equal(n.metadata.channels, 2);
  });

  test('KTX2 (Khronos CarConcept, BasisU): Abmessungen gleich den WebP-Gegenstuecken, volle Mip-Kette, DFD', async t => {
    const gegenstuecke = [['Dash_E', 1024, 256, 'ETC1S'], ['Hex_N', 64, 32, 'UASTC'], ['Dot_N', 128, 128, 'UASTC']];
    let n = 0;
    for (const [name, w, h, modell] of gegenstuecke) {
      const k = join(samples, `ktx2/carconcept/${name}.ktx2`);
      if (!existsSync(k)) continue;
      const r = await laufPfad(k);
      assert.equal(r.status, 'ok', `${name}: ${JSON.stringify(r.warnings)}`);
      assert.equal(r.metadata.width, w, name);
      assert.equal(r.metadata.height, h, name);
      assert.equal(r.metadata.mip_levels, mipsMax(w, h), `${name}: volle Kette`);
      assert.equal(r.format_specific.dfd.color_model, modell, name);
      assert.equal(r.format_specific.level_index.length, mipsMax(w, h));
      assert.ok(r.format_specific.level_index.every(l => !l.ausserhalb), `${name}: Level in der Datei`);
      const webp = join(samples, `webp/carconcept/${name}.webp`);
      if (existsSync(webp)) {
        const wr = await laufPfad(webp);
        assert.equal(wr.metadata.width, r.metadata.width, `${name}: KTX2 = WebP-Breite`);
        assert.equal(wr.metadata.height, r.metadata.height, `${name}: KTX2 = WebP-Hoehe`);
      }
      n++;
    }
    if (n === 0) t.skip('keine KTX2-Proben');
    const u = join(samples, 'ktx2/ktx2-uni-plane.ktx2');
    if (existsSync(u)) {
      const r = await laufPfad(u);
      assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
      assert.equal(r.metadata.width, 64);
      assert.equal(r.metadata.mip_levels, 7);
    }
  });

  test('EXR/HDR (Poly Haven): Kanaele und Kompression', async t => {
    const e = probe(t, 'exr/kloofendal_48d_partly_cloudy_puresky_1k.exr');
    if (!e) return;
    const r = await laufPfad(e);
    assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(r.metadata.width, 1024);
    assert.equal(r.metadata.height, 512);
    assert.equal(r.metadata.has_alpha, true);
    assert.equal(r.metadata.channels, 4);
    const h = join(samples, 'hdr/kloofendal_48d_partly_cloudy_puresky_1k.hdr');
    if (existsSync(h)) {
      const hr = await laufPfad(h);
      assert.equal(hr.metadata.width, 1024);
      assert.equal(hr.metadata.height, 512);
      assert.equal(hr.format_specific.format, '32-bit_rle_rgbe');
    }
    const rough = join(samples, 'exr/wooden_crate_01/wooden_crate_01_rough_1k.exr');
    if (existsSync(rough)) assert.equal((await laufPfad(rough)).metadata.channels, 1);
  });

  test('PNG/JPEG (Wikimedia): iCCP-Name, sRGB-Chunk, progressives JPEG mit ICC', async t => {
    const a = probe(t, 'png/Bianco_e_Nero_con_diagonale_Arancione.png');
    if (!a) return;
    const r = await laufPfad(a);
    assert.equal(r.metadata.icc_profil, 'Photoshop ICC profile');
    assert.equal(r.metadata.has_alpha, true);
    const c = join(samples, 'png/Containers_icon.png');
    if (existsSync(c)) assert.equal((await laufPfad(c)).metadata.color_space, 'sRGB');
    const j = join(samples, 'jpg/Pexels-pixabay-164828.jpg');
    if (existsSync(j)) {
      const jr = await laufPfad(j);
      assert.equal(jr.metadata.progressive, true);
      assert.equal(jr.metadata.hat_icc_profil, true);
    }
  });
});
