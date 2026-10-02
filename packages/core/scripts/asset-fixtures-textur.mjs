/**
 * Fixture-Generator fuer die Textur-Inspektor-Tests (P4-T64).
 * Erzeugt in einem Verzeichnis unter os.tmpdir() — es werden KEINE Binaerdateien eingecheckt.
 *
 * ZWEI QUELLEN:
 *  1. HANDGEBAUT (deterministisch, gleiche Bytes bei jedem Lauf): Header/Chunks nach Spezifikation,
 *     auch kaputte Varianten (abgeschnitten, falsche Magic, absurde Abmessungen, falsche Mip-Zahl).
 *     Aussagen darueber sind "gegen die Spezifikation" und NICHT gegen Fremdwerkzeuge verifiziert.
 *  2. ECHT (von Fremdwerkzeugen erzeugt, nur wenn vorhanden): python3+PIL, ImageMagick (magick),
 *     ffmpeg, oiiotool. Die erwarteten Abmessungen kommen unabhaengig von `magick identify`.
 *     Nicht vorhandene Werkzeuge werden uebersprungen; nichts wird installiert.
 *
 * AUFRUF: node packages/core/scripts/asset-fixtures-textur.mjs   (gibt das Verzeichnis und die Dateien aus)
 * ALS MODUL: const { dir, pfade, echt, werkzeuge, aufraeumen } = await erzeugeTexturFixtures();
 */
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- Bausteine

export const u16le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
export const u16be = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
export const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
export const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
export const i32le = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
export const f32le = n => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
export const u64le = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const u24le = n => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

/** Deterministische Fuellbytes (kein Math.random). */
export function fuell(n, start = 1) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (start + i * 7) & 0xff;
  return b;
}

const CRC_TAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** Unabhaengige CRC32-Implementierung der Fixtures (nicht die der Inspektoren). */
export function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = CRC_TAB[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- PNG

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngChunk(typ, daten = Buffer.alloc(0), { falscheCrc = false } = {}) {
  const t = Buffer.from(typ, 'latin1');
  const crc = crc32(Buffer.concat([t, daten])) ^ (falscheCrc ? 0xdeadbeef : 0);
  return Buffer.concat([u32be(daten.length), t, daten, u32be(crc)]);
}
export function pngIhdr(w, h, bd, ct, interlace = 0) {
  return pngChunk('IHDR', Buffer.concat([u32be(w), u32be(h), Buffer.from([bd, ct, 0, 0, interlace])]));
}
/** Zlib-Daten fuer ein w x h Bild mit bpp Bytes je Pixel (Filter 0). */
export function pngIdatDaten(w, h, bpp) {
  const zeilen = [];
  for (let y = 0; y < h; y++) zeilen.push(Buffer.concat([Buffer.from([0]), fuell(w * bpp, y + 1)]));
  return deflateSync(Buffer.concat(zeilen));
}
const cstr = s => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);

// ---------------------------------------------------------------- JPEG

export const jpegSeg = (marker, daten) => Buffer.concat([Buffer.from([0xff, marker]), u16be(daten.length + 2), daten]);
function exifTiff(orientation) {
  // little endian TIFF mit einem IFD-Eintrag Orientation (0x0112, SHORT, 1)
  return Buffer.concat([Buffer.from('II'), u16le(42), u32le(8), u16le(1), u16le(0x0112), u16le(3), u32le(1), u16le(orientation), u16le(0), u32le(0)]);
}
function iccProfil(name) {
  const desc = Buffer.concat([Buffer.from('desc'), u32be(0), u32be(name.length + 1), Buffer.from(name + '\0', 'latin1')]);
  const kopf = Buffer.alloc(128);
  kopf.writeUInt32BE(128 + 4 + 12 + desc.length, 0);
  kopf.writeUInt8(2, 8);
  kopf.write('mntr', 12, 'latin1');
  kopf.write('RGB ', 16, 'latin1');
  kopf.write('XYZ ', 20, 'latin1');
  kopf.write('acsp', 36, 'latin1');
  return Buffer.concat([kopf, u32be(1), Buffer.from('desc'), u32be(128 + 4 + 12), u32be(desc.length), desc]);
}
export function jpegBauen({ w = 16, h = 8, sof = 0xc0, precision = 8, komp = [[1, 0x22, 0], [2, 0x11, 1], [3, 0x11, 1]], jfif = true, exif = 6, icc = 'TestProfil', kommentar = 'Kommentar-Test', adobe = null, sos = true, eoi = true } = {}) {
  const teile = [Buffer.from([0xff, 0xd8])];
  if (jfif) teile.push(jpegSeg(0xe0, Buffer.concat([Buffer.from('JFIF\0'), Buffer.from([1, 2, 1]), u16be(72), u16be(72), Buffer.from([0, 0])])));
  if (exif !== null) teile.push(jpegSeg(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), exifTiff(exif)])));
  if (icc) teile.push(jpegSeg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from([1, 1]), iccProfil(icc)])));
  if (adobe !== null) teile.push(jpegSeg(0xee, Buffer.concat([Buffer.from('Adobe'), u16be(100), u16be(0), u16be(0), Buffer.from([adobe])])));
  if (kommentar) teile.push(jpegSeg(0xfe, Buffer.from(kommentar)));
  teile.push(jpegSeg(0xdb, Buffer.concat([Buffer.from([0x00]), fuell(64)])));
  teile.push(jpegSeg(0xc0 === sof || true ? sof : 0xc0, Buffer.concat([Buffer.from([precision]), u16be(h), u16be(w), Buffer.from([komp.length]), ...komp.map(([id, hv, tq]) => Buffer.from([id, hv, tq]))])));
  teile.push(jpegSeg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])])));
  if (sos) {
    teile.push(jpegSeg(0xda, Buffer.concat([Buffer.from([komp.length]), ...komp.map(([id]) => Buffer.from([id, 0x00])), Buffer.from([0, 63, 0])])));
    teile.push(fuell(20, 3).map(b => (b === 0xff ? 0x10 : b)));
    if (eoi) teile.push(Buffer.from([0xff, 0xd9]));
  }
  return Buffer.concat(teile);
}

// ---------------------------------------------------------------- WebP

export function riffChunk(fourcc, daten) {
  return Buffer.concat([Buffer.from(fourcc, 'latin1'), u32le(daten.length), daten, daten.length & 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
}
export function webpDatei(chunks, { riffGroesse } = {}) {
  const inhalt = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  return Buffer.concat([Buffer.from('RIFF'), u32le(riffGroesse ?? inhalt.length), inhalt]);
}
export function vp8Daten(w, h) {
  return Buffer.concat([Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), u16le(w), u16le(h), fuell(12)]);
}
export function vp8lDaten(w, h, alpha) {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  return Buffer.concat([Buffer.from([0x2f]), u32le(bits >>> 0), fuell(10)]);
}
export function vp8xDaten(flags, w, h) {
  return Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24le(w - 1), u24le(h - 1)]);
}
export function anmfDaten(x, y, w, h, dauer, innen) {
  return Buffer.concat([u24le(x / 2), u24le(y / 2), u24le(w - 1), u24le(h - 1), u24le(dauer), Buffer.from([0x02]), innen]);
}

// ---------------------------------------------------------------- DDS

export function ddsPixelformat({ flags, fourcc = null, bits = 0, r = 0, g = 0, b = 0, a = 0 }) {
  const fc = typeof fourcc === 'number' ? u32le(fourcc) : fourcc ? Buffer.from(fourcc, 'latin1') : Buffer.alloc(4);
  return Buffer.concat([u32le(32), u32le(flags), fc, u32le(bits), u32le(r), u32le(g), u32le(b), u32le(a)]);
}
export function ddsDatei({ flags, hoehe, breite, pitch = 0, tiefe = 0, mips = 0, pf, caps, caps2 = 0, dx10 = null, daten = Buffer.alloc(0), magic = 'DDS ' }) {
  const kopf = Buffer.concat([
    Buffer.from(magic, 'latin1'), u32le(124), u32le(flags), u32le(hoehe), u32le(breite), u32le(pitch), u32le(tiefe), u32le(mips),
    Buffer.alloc(44), pf, u32le(caps), u32le(caps2), u32le(0), u32le(0), u32le(0),
  ]);
  const x = dx10 ? Buffer.concat([u32le(dx10.dxgi), u32le(dx10.dim), u32le(dx10.misc ?? 0), u32le(dx10.arraySize ?? 1), u32le(dx10.misc2 ?? 0)]) : Buffer.alloc(0);
  return Buffer.concat([kopf, x, daten]);
}
/** Unabhaengige Bytezahl einer Mip-Kette (Block- oder Pixelformat), alle Stufen, ohne Faces/Layer. */
export function mipKetteBytes(w, h, d, mips, bw, bh, bitsProBlock) {
  let s = 0;
  for (let i = 0; i < mips; i++) {
    const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i), ld = Math.max(1, d >> i);
    s += Math.ceil(lw / bw) * Math.ceil(lh / bh) * ld * bitsProBlock / 8;
  }
  return s;
}

// ---------------------------------------------------------------- KTX 1.1

const KTX1_ID = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
export function kvBytes(eintraege, le = true) {
  const w32 = le ? u32le : u32be;
  return Buffer.concat(eintraege.map(([k, v]) => {
    const roh = Buffer.concat([Buffer.from(k), Buffer.from([0]), Buffer.isBuffer(v) ? v : Buffer.concat([Buffer.from(v), Buffer.from([0])])]);
    return Buffer.concat([w32(roh.length), roh, Buffer.alloc((4 - (roh.length % 4)) % 4)]);
  }));
}
export function ktx1Datei({ le = true, glType = 0, glTypeSize = 1, glFormat = 0, glInternal, glBase = 0x1908, w, h = 0, d = 0, arrayN = 0, faces = 1, mips = 1, kv = Buffer.alloc(0), levels = [] }) {
  const w32 = le ? u32le : u32be;
  const kopf = Buffer.concat([KTX1_ID, le ? Buffer.from([1, 2, 3, 4]) : Buffer.from([4, 3, 2, 1]), ...[glType, glTypeSize, glFormat, glInternal, glBase, w, h, d, arrayN, faces, mips, kv.length].map(w32)]);
  const teile = [kopf, kv];
  for (const l of levels) teile.push(w32(l.imageSize), l.daten, Buffer.alloc((4 - (l.daten.length % 4)) % 4));
  return Buffer.concat(teile);
}

// ---------------------------------------------------------------- KTX2

const KTX2_ID = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
export function dfdBytes({ model, prim, tf, flags = 0, proben, bytesPlane0 = 0, dim = [4, 4, 1, 1] }) {
  const blockSize = 24 + 16 * proben.length;
  const p = proben.map(([kanal, bitOffset, bitLaenge]) => Buffer.concat([u16le(bitOffset), Buffer.from([bitLaenge - 1, kanal, 0, 0, 0, 0]), u32le(0), u32le(0xffffffff)]));
  return Buffer.concat([u32le(4 + blockSize), u32le(0), u16le(2), u16le(blockSize), Buffer.from([model, prim, tf, flags]), Buffer.from(dim.map(x => x - 1)), Buffer.from([bytesPlane0, 0, 0, 0, 0, 0, 0, 0]), ...p]);
}
export function ktx2Datei({ vk, typeSize = 1, w, h = 0, d = 0, layers = 0, faces = 1, levelCount, levels, superc = 0, dfd = null, kv = null, sgd = null, levelIndexAusserhalb = false }) {
  const n = Math.max(1, levelCount ?? levels.length);
  const vorne = 80 + 24 * n;
  const dfdOff = dfd ? vorne : 0;
  const kvOff = kv ? vorne + (dfd?.length ?? 0) : 0;
  const sgdOff = sgd ? vorne + (dfd?.length ?? 0) + (kv?.length ?? 0) : 0;
  let pos = vorne + (dfd?.length ?? 0) + (kv?.length ?? 0) + (sgd?.length ?? 0);
  const index = [];
  const daten = [];
  for (let i = 0; i < n; i++) {
    const l = levels[i] ?? { len: 0, unc: 0 };
    index.push(Buffer.concat([u64le(levelIndexAusserhalb ? pos + 1_000_000 : pos), u64le(l.len), u64le(l.unc ?? l.len)]));
    daten.push(fuell(l.len, i + 1));
    pos += l.len;
  }
  const kopf = Buffer.concat([
    KTX2_ID, ...[vk, typeSize, w, h, d, layers, faces, levelCount ?? levels.length, superc, dfdOff, dfd?.length ?? 0, kvOff, kv?.length ?? 0].map(u32le),
    u64le(sgdOff), u64le(sgd?.length ?? 0),
  ]);
  return Buffer.concat([kopf, ...index, dfd ?? Buffer.alloc(0), kv ?? Buffer.alloc(0), sgd ?? Buffer.alloc(0), ...daten]);
}

// ---------------------------------------------------------------- EXR

export const exrAttr = (name, typ, daten) => Buffer.concat([cstr(name), cstr(typ), u32le(daten.length), daten]);
export function exrChannels(kanaele) {
  return exrAttr('channels', 'chlist', Buffer.concat([...kanaele.map(([n, t, xs = 1, ys = 1]) => Buffer.concat([cstr(n), u32le(t), Buffer.from([0, 0, 0, 0]), u32le(xs), u32le(ys)])), Buffer.from([0])]));
}
export const exrBox = (n, t, x0, y0, x1, y1) => exrAttr(n, t, Buffer.concat([x0, y0, x1, y1].map(i32le)));
export function exrKopf({ kanaele = [['A', 1], ['B', 1], ['G', 1], ['R', 1]], compression = 3, w = 8, h = 4, extra = [], tiles = null, typ = null, name = null, chunkCount = null, lineOrder = 0 } = {}) {
  const a = [
    exrChannels(kanaele),
    exrAttr('compression', 'compression', Buffer.from([compression])),
    exrBox('dataWindow', 'box2i', 0, 0, w - 1, h - 1),
    exrBox('displayWindow', 'box2i', 0, 0, w - 1, h - 1),
    exrAttr('lineOrder', 'lineOrder', Buffer.from([lineOrder])),
    exrAttr('pixelAspectRatio', 'float', f32le(1)),
    exrAttr('screenWindowCenter', 'v2f', Buffer.concat([f32le(0), f32le(0)])),
    exrAttr('screenWindowWidth', 'float', f32le(1)),
  ];
  if (tiles) a.push(exrAttr('tiles', 'tiledesc', Buffer.concat([u32le(tiles.x), u32le(tiles.y), Buffer.from([tiles.modus | (tiles.hoch ? 0x10 : 0)])])));
  if (name) a.push(exrAttr('name', 'string', Buffer.from(name)));
  if (typ) a.push(exrAttr('type', 'string', Buffer.from(typ)));
  if (chunkCount !== null) a.push(exrAttr('chunkCount', 'int', i32le(chunkCount)));
  a.push(...extra);
  return Buffer.concat([...a, Buffer.from([0])]);
}
export function exrDatei(koepfe, { version = 2, tiled = false, longNames = false, deep = false, multipart = false, rest = fuell(40) } = {}) {
  const wort = version | (tiled ? 0x200 : 0) | (longNames ? 0x400 : 0) | (deep ? 0x800 : 0) | (multipart ? 0x1000 : 0);
  return Buffer.concat([Buffer.from([0x76, 0x2f, 0x31, 0x01]), u32le(wort), ...koepfe, multipart ? Buffer.from([0]) : Buffer.alloc(0), rest]);
}

// ---------------------------------------------------------------- HDR

export function hdrDatei({ kennung = '#?RADIANCE', zeilen = ['FORMAT=32-bit_rle_rgbe'], aufloesung = '-Y 4 +X 8', pixel = 32, ohneLeerzeile = false } = {}) {
  const kopf = [kennung, ...zeilen].join('\n') + '\n' + (ohneLeerzeile ? '' : '\n') + (aufloesung ? aufloesung + '\n' : '');
  return Buffer.concat([Buffer.from(kopf, 'latin1'), fuell(pixel * 4 > 0 ? pixel * 4 : 0, 9)]);
}

// ---------------------------------------------------------------- handgebaute Fixtures

function handgebaut() {
  const d = {};
  const png = (name, chunks) => { d[name] = [name + '.png', Buffer.concat([PNG_SIG, ...chunks])]; };

  // PNG
  png('pngRgba', [pngIhdr(3, 2, 8, 6), pngChunk('IDAT', pngIdatDaten(3, 2, 4)), pngChunk('IEND')]);
  const idatAlles = pngIdatDaten(16, 8, 1);
  const t1 = Math.floor(idatAlles.length / 3);
  png('pngPaletteViele', [
    pngIhdr(16, 8, 8, 3, 1),
    pngChunk('gAMA', u32be(45455)),
    pngChunk('cHRM', Buffer.concat([31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].map(u32be))),
    pngChunk('sRGB', Buffer.from([1])),
    pngChunk('iCCP', Buffer.concat([cstr('test-profile'), Buffer.from([0]), deflateSync(fuell(40))])),
    pngChunk('PLTE', fuell(12)),
    pngChunk('tRNS', Buffer.from([0, 128])),
    pngChunk('pHYs', Buffer.concat([u32be(2835), u32be(2835), Buffer.from([1])])),
    pngChunk('tIME', Buffer.concat([u16be(2026), Buffer.from([10, 2, 13, 5, 7])])),
    pngChunk('tEXt', Buffer.concat([cstr('Author'), Buffer.from('Fixture', 'latin1')])),
    pngChunk('zTXt', Buffer.concat([cstr('Comment'), Buffer.from([0]), deflateSync(Buffer.from('komprimierter Text'))])),
    pngChunk('iTXt', Buffer.concat([cstr('Titel'), Buffer.from([0, 0]), cstr('de'), cstr('Titel'), Buffer.from('Ueberschrift')])),
    pngChunk('eXIf', Buffer.concat([Buffer.from('MM'), u16be(42), u32be(8), u16be(0), u32be(0)])),
    pngChunk('IDAT', idatAlles.subarray(0, t1)),
    pngChunk('IDAT', idatAlles.subarray(t1, 2 * t1)),
    pngChunk('IDAT', idatAlles.subarray(2 * t1)),
    pngChunk('IEND'),
  ]);
  png('pngAnimiert', [
    pngIhdr(4, 4, 8, 6),
    pngChunk('acTL', Buffer.concat([u32be(2), u32be(0)])),
    pngChunk('fcTL', Buffer.concat([u32be(0), u32be(4), u32be(4), u32be(0), u32be(0), u16be(1), u16be(10), Buffer.from([0, 0])])),
    pngChunk('IDAT', pngIdatDaten(4, 4, 4)),
    pngChunk('fcTL', Buffer.concat([u32be(1), u32be(4), u32be(4), u32be(0), u32be(0), u16be(1), u16be(10), Buffer.from([0, 0])])),
    pngChunk('fdAT', Buffer.concat([u32be(2), pngIdatDaten(4, 4, 4)])),
    pngChunk('IEND'),
  ]);
  png('pngCrcFehler', [pngIhdr(2, 2, 8, 2), pngChunk('tEXt', Buffer.concat([cstr('K'), Buffer.from('V')]), { falscheCrc: true }), pngChunk('IDAT', pngIdatDaten(2, 2, 3)), pngChunk('IEND')]);
  const ganz = Buffer.concat([PNG_SIG, pngIhdr(32, 32, 8, 6), pngChunk('IDAT', pngIdatDaten(32, 32, 4)), pngChunk('IEND')]);
  d.pngAbgeschnitten = ['pngAbgeschnitten.png', ganz.subarray(0, 8 + 25 + 20)];
  d.pngNurSignatur = ['pngNurSignatur.png', PNG_SIG];
  png('pngAbsurd', [pngIhdr(65536, 65536, 8, 6), pngChunk('IDAT', Buffer.from([1, 2, 3])), pngChunk('IEND')]);
  png('pngRiesigesChunk', [pngIhdr(2, 2, 8, 2), Buffer.concat([u32be(0x7fffffff), Buffer.from('IDAT'), fuell(10)])]);
  png('pngUngueltigerTyp', [pngIhdr(2, 2, 8, 2), Buffer.concat([u32be(4), Buffer.from([0x31, 0x32, 0x33, 0x34]), fuell(8)])]);
  d.pngFalscheMagic = ['pngFalscheMagic.png', fuell(100, 5)];
  d.pngAlsJpg = ['pngAlsJpg.jpg', ganz];

  // JPEG
  d.jpegVoll = ['jpegVoll.jpg', jpegBauen()];
  d.jpegProgressiv = ['jpegProgressiv.jpg', jpegBauen({ sof: 0xc2, w: 33, h: 17, exif: null, icc: null, kommentar: null })];
  d.jpegGrau = ['jpegGrau.jpg', jpegBauen({ komp: [[1, 0x11, 0]], jfif: false, exif: null, icc: null, kommentar: null })];
  d.jpegCmyk = ['jpegCmyk.jpg', jpegBauen({ komp: [[1, 0x11, 0], [2, 0x11, 0], [3, 0x11, 0], [4, 0x11, 0]], adobe: 2, exif: null, icc: null })];
  const jvoll = jpegBauen();
  d.jpegAbgeschnitten = ['jpegAbgeschnitten.jpg', jvoll.subarray(0, 30)];
  d.jpegOhneSof = ['jpegOhneSof.jpg', Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSeg(0xfe, Buffer.from('nur Kommentar')), jpegSeg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0xff, 0xd9])])];
  d.jpegAbsurd = ['jpegAbsurd.jpg', jpegBauen({ w: 65535, h: 65535, exif: null, icc: null })];
  d.jpegSegmentLaenge = ['jpegSegmentLaenge.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xf0]), fuell(100)])];
  d.jpegFalscheMagic = ['jpegFalscheMagic.jpg', fuell(64, 9)];

  // WebP
  d.webpLossy = ['webpLossy.webp', webpDatei([riffChunk('VP8 ', vp8Daten(17, 9))])];
  d.webpLossless = ['webpLossless.webp', webpDatei([riffChunk('VP8L', vp8lDaten(20, 10, true))])];
  d.webpErweitert = ['webpErweitert.webp', webpDatei([riffChunk('VP8X', vp8xDaten(0x20 | 0x10 | 0x08 | 0x04, 40, 30)), riffChunk('ICCP', fuell(10)), riffChunk('ALPH', fuell(6)), riffChunk('VP8 ', vp8Daten(40, 30)), riffChunk('EXIF', fuell(8)), riffChunk('XMP ', fuell(9))])];
  d.webpAnimiert = ['webpAnimiert.webp', webpDatei([
    riffChunk('VP8X', vp8xDaten(0x02 | 0x10, 16, 16)),
    riffChunk('ANIM', Buffer.concat([u32le(0xff000000), u16le(3)])),
    riffChunk('ANMF', anmfDaten(0, 0, 16, 16, 100, riffChunk('VP8L', vp8lDaten(16, 16, true)))),
    riffChunk('ANMF', anmfDaten(2, 4, 8, 8, 250, riffChunk('VP8 ', vp8Daten(8, 8)))),
  ])];
  const wl = webpDatei([riffChunk('VP8 ', vp8Daten(17, 9)), riffChunk('EXIF', fuell(2000))]);
  d.webpAbgeschnitten = ['webpAbgeschnitten.webp', wl.subarray(0, 60)];
  d.webpAbsurd = ['webpAbsurd.webp', webpDatei([riffChunk('VP8X', vp8xDaten(0, 16777216, 16777216)), riffChunk('VP8 ', vp8Daten(16, 16))])];
  d.webpKaputt = ['webpKaputt.webp', Buffer.concat([Buffer.from('RIFF'), u32le(100), Buffer.from('WEBP'), fuell(30)])];

  // DDS
  const pfDxt = fc => ddsPixelformat({ flags: 0x4, fourcc: fc });
  const bc1 = mipKetteBytes(256, 128, 1, 9, 4, 4, 64);
  d.ddsBc1Mips = ['ddsBc1Mips.dds', ddsDatei({ flags: 0x1007 | 0x20000 | 0x80000, hoehe: 128, breite: 256, pitch: 256 * 128 / 2, mips: 9, pf: pfDxt('DXT1'), caps: 0x1000 | 0x400000 | 0x8, daten: fuell(bc1) })];
  const bc7 = mipKetteBytes(64, 64, 1, 7, 4, 4, 128);
  d.ddsDx10Bc7 = ['ddsDx10Bc7.dds', ddsDatei({ flags: 0x1007 | 0x20000 | 0x80000, hoehe: 64, breite: 64, mips: 7, pf: pfDxt('DX10'), caps: 0x1000 | 0x400000 | 0x8, dx10: { dxgi: 98, dim: 3, misc: 0, arraySize: 1, misc2: 1 }, daten: fuell(bc7) })];
  const rgba8cube = mipKetteBytes(32, 32, 1, 6, 1, 1, 32);
  d.ddsCubemap = ['ddsCubemap.dds', ddsDatei({ flags: 0x1007 | 0x20000, hoehe: 32, breite: 32, mips: 6, pf: ddsPixelformat({ flags: 0x41, bits: 32, r: 0xff0000, g: 0xff00, b: 0xff, a: 0xff000000 }), caps: 0x1000 | 0x400000 | 0x8, caps2: 0x200 | 0xfc00, daten: fuell(rgba8cube * 6) })];
  d.ddsVolumen = ['ddsVolumen.dds', ddsDatei({ flags: 0x1007 | 0x800000, hoehe: 16, breite: 16, tiefe: 8, mips: 1, pf: pfDxt(113), caps: 0x1000, caps2: 0x200000, daten: fuell(16 * 16 * 8 * 8) })];
  const bc3 = mipKetteBytes(16, 16, 1, 5, 4, 4, 128);
  d.ddsDx10CubeArray = ['ddsDx10CubeArray.dds', ddsDatei({ flags: 0x1007 | 0x20000, hoehe: 16, breite: 16, mips: 5, pf: pfDxt('DX10'), caps: 0x1000 | 0x400000 | 0x8, caps2: 0x200 | 0xfc00, dx10: { dxgi: 77, dim: 3, misc: 0x4, arraySize: 2 }, daten: fuell(bc3 * 12) })];
  d.ddsAbgeschnittenKopf = ['ddsAbgeschnittenKopf.dds', d.ddsDx10Bc7[1].subarray(0, 100)];
  d.ddsAbgeschnittenDaten = ['ddsAbgeschnittenDaten.dds', d.ddsBc1Mips[1].subarray(0, 128 + 1000)];
  d.ddsMipFalsch = ['ddsMipFalsch.dds', ddsDatei({ flags: 0x1007 | 0x20000 | 0x80000, hoehe: 16, breite: 16, mips: 20, pf: pfDxt('DXT5'), caps: 0x1000 | 0x400000 | 0x8, daten: fuell(mipKetteBytes(16, 16, 1, 5, 4, 4, 128)) })];
  d.ddsAbsurd = ['ddsAbsurd.dds', ddsDatei({ flags: 0x1007 | 0x800000 | 0x80000, hoehe: 65536, breite: 65536, tiefe: 65536, mips: 1, pf: pfDxt('DXT1'), caps: 0x1000, caps2: 0x200000, daten: fuell(64) })];
  d.ddsFalscheMagic = ['ddsFalscheMagic.dds', ddsDatei({ magic: 'DDX ', flags: 0x1007, hoehe: 4, breite: 4, pf: pfDxt('DXT1'), caps: 0x1000, daten: fuell(8) })];
  d.ddsNeunMipsZuViele = ['ddsUeberschuss.dds', ddsDatei({ flags: 0x1007, hoehe: 8, breite: 8, pf: pfDxt('DXT1'), caps: 0x1000, daten: fuell(4 * 8 + 50) })];

  // KTX 1.1
  const kv = kvBytes([['KTXorientation', 'S=r,T=d'], ['KTXwriter', 'asset-fixtures-textur']]);
  const lvl = (w, h, bpp) => { const n = w * h * bpp; return { imageSize: n, daten: fuell(n) }; };
  d.ktxRgba8 = ['ktxRgba8.ktx', ktx1Datei({ glType: 0x1401, glFormat: 0x1908, glInternal: 0x8058, w: 16, h: 16, mips: 5, kv, levels: [lvl(16, 16, 4), lvl(8, 8, 4), lvl(4, 4, 4), lvl(2, 2, 4), lvl(1, 1, 4)] })];
  d.ktxBc7 = ['ktxBc7.ktx', ktx1Datei({ glInternal: 0x8e8c, glBase: 0x1908, w: 8, h: 8, mips: 2, levels: [{ imageSize: 64, daten: fuell(64) }, { imageSize: 16, daten: fuell(16) }] })];
  d.ktxCube = ['ktxCube.ktx', ktx1Datei({ glType: 0x1401, glFormat: 0x1908, glInternal: 0x8058, w: 8, h: 8, faces: 6, mips: 2, levels: [{ imageSize: 8 * 8 * 4, daten: fuell(8 * 8 * 4 * 6) }, { imageSize: 4 * 4 * 4, daten: fuell(4 * 4 * 4 * 6) }] })];
  d.ktxBigEndian = ['ktxBigEndian.ktx', ktx1Datei({ le: false, glType: 0x1401, glFormat: 0x1908, glInternal: 0x8058, w: 4, h: 4, mips: 1, kv: kvBytes([['KTXwriter', 'be']], false), levels: [lvl(4, 4, 4)] })];
  d.ktxAbgeschnitten = ['ktxAbgeschnitten.ktx', d.ktxRgba8[1].subarray(0, 64 + kv.length + 200)];
  d.ktxKopfAbgeschnitten = ['ktxKopfAbgeschnitten.ktx', d.ktxRgba8[1].subarray(0, 40)];
  d.ktxMipFalsch = ['ktxMipFalsch.ktx', ktx1Datei({ glType: 0x1401, glFormat: 0x1908, glInternal: 0x8058, w: 4, h: 4, mips: 12, levels: [lvl(4, 4, 4), lvl(2, 2, 4), lvl(1, 1, 4)] })];
  d.ktxAbsurd = ['ktxAbsurd.ktx', ktx1Datei({ glType: 0x1401, glFormat: 0x1908, glInternal: 0x8058, w: 65536, h: 65536, d: 65536, mips: 1, levels: [{ imageSize: 4, daten: fuell(4) }] })];
  d.ktxKvZuLang = ['ktxKvZuLang.ktx', (() => { const b = Buffer.from(d.ktxRgba8[1]); b.writeUInt32LE(0x7fffff00, 60); return b; })()];
  d.ktxEndianKaputt = ['ktxEndianKaputt.ktx', (() => { const b = Buffer.from(d.ktxRgba8[1]); b.writeUInt32LE(0x12345678, 12); return b; })()];

  // KTX2
  const rgbaDfd = dfdBytes({ model: 1, prim: 1, tf: 2, proben: [[0, 0, 8], [1, 8, 8], [2, 16, 8], [15, 24, 8]], bytesPlane0: 4, dim: [1, 1, 1, 1] });
  const kv2 = kvBytes([['KTXwriter', 'asset-fixtures-textur v1'], ['KTXorientation', 'rd']]);
  const l2 = (w, h, bpp) => ({ len: w * h * bpp });
  d.ktx2Rgba8Srgb = ['ktx2Rgba8Srgb.ktx2', ktx2Datei({ vk: 43, w: 16, h: 16, levels: [l2(16, 16, 4), l2(8, 8, 4), l2(4, 4, 4), l2(2, 2, 4), l2(1, 1, 4)], dfd: rgbaDfd, kv: kv2 })];
  const bc7Dfd = dfdBytes({ model: 134, prim: 1, tf: 1, proben: [[0, 0, 128]], bytesPlane0: 16 });
  d.ktx2Bc7Zstd = ['ktx2Bc7Zstd.ktx2', ktx2Datei({ vk: 145, w: 8, h: 8, levels: [{ len: 30, unc: 64 * 4 }, { len: 14, unc: 16 }], superc: 2, dfd: bc7Dfd })];
  const etc1sDfd = dfdBytes({ model: 163, prim: 1, tf: 2, proben: [[0, 0, 64], [15, 64, 64]], bytesPlane0: 0 });
  d.ktx2BasisLz = ['ktx2BasisLz.ktx2', ktx2Datei({ vk: 0, typeSize: 1, w: 32, h: 32, levels: [{ len: 40, unc: 0 }, { len: 20, unc: 0 }], superc: 1, dfd: etc1sDfd, sgd: fuell(24) })];
  d.ktx2Cube = ['ktx2Cube.ktx2', ktx2Datei({ vk: 37, w: 8, h: 8, faces: 6, levels: [{ len: 8 * 8 * 4 * 6 }, { len: 4 * 4 * 4 * 6 }], dfd: rgbaDfd })];
  d.ktx2Array = ['ktx2Array.ktx2', ktx2Datei({ vk: 97, typeSize: 2, w: 4, h: 4, layers: 3, levels: [{ len: 4 * 4 * 8 * 3 }], dfd: dfdBytes({ model: 1, prim: 1, tf: 1, proben: [[0, 0, 16], [1, 16, 16], [2, 32, 16], [15, 48, 16]], bytesPlane0: 8, dim: [1, 1, 1, 1] }) })];
  d.ktx2LevelAusserhalb = ['ktx2LevelAusserhalb.ktx2', ktx2Datei({ vk: 37, w: 4, h: 4, levels: [l2(4, 4, 4), l2(2, 2, 4), l2(1, 1, 4)], dfd: rgbaDfd, levelIndexAusserhalb: true })];
  d.ktx2Abgeschnitten = ['ktx2Abgeschnitten.ktx2', d.ktx2Rgba8Srgb[1].subarray(0, 120)];
  d.ktx2KopfAbgeschnitten = ['ktx2KopfAbgeschnitten.ktx2', d.ktx2Rgba8Srgb[1].subarray(0, 50)];
  d.ktx2MipFalsch = ['ktx2MipFalsch.ktx2', ktx2Datei({ vk: 37, w: 4, h: 4, levels: Array.from({ length: 9 }, () => ({ len: 4 })), dfd: rgbaDfd })];
  d.ktx2Absurd = ['ktx2Absurd.ktx2', ktx2Datei({ vk: 37, w: 65536, h: 65536, d: 65536, levels: [{ len: 4 }], dfd: rgbaDfd })];
  d.ktx2LevelCountHuge = ['ktx2LevelCountHuge.ktx2', (() => { const b = Buffer.from(d.ktx2Rgba8Srgb[1]); b.writeUInt32LE(0xfffffff0, 40); return b; })()];
  d.ktx2DfdAusserhalb = ['ktx2DfdAusserhalb.ktx2', (() => { const b = Buffer.from(d.ktx2Rgba8Srgb[1]); b.writeUInt32LE(0x7fffff00, 52); return b; })()];

  // EXR
  d.exrRgbaHalf = ['exrRgbaHalf.exr', exrDatei([exrKopf({ w: 8, h: 4 })])];
  d.exrFloatTiledMip = ['exrFloatTiledMip.exr', exrDatei([exrKopf({ kanaele: [['B', 2], ['G', 2], ['R', 2]], compression: 4, w: 64, h: 32, tiles: { x: 16, y: 16, modus: 1 }, typ: 'tiledimage' })], { tiled: true })];
  d.exrMultipart = ['exrMultipart.exr', exrDatei([
    exrKopf({ w: 16, h: 16, name: 'beauty', typ: 'scanlineimage', chunkCount: 1, compression: 3 }),
    exrKopf({ kanaele: [['Z', 2]], w: 16, h: 16, name: 'depth', typ: 'scanlineimage', chunkCount: 1, compression: 1 }),
  ], { multipart: true })];
  d.exrDeep = ['exrDeep.exr', exrDatei([exrKopf({ kanaele: [['A', 1], ['Z', 2]], w: 4, h: 4, typ: 'deepscanline', name: 'tief' })], { deep: true, multipart: false })];
  d.exrGemischt = ['exrGemischt.exr', exrDatei([exrKopf({ kanaele: [['B', 1], ['G', 1], ['R', 1], ['id', 0]], w: 4, h: 4 })])];
  d.exrAbgeschnitten = ['exrAbgeschnitten.exr', d.exrRgbaHalf[1].subarray(0, 100)];
  d.exrNurMagic = ['exrNurMagic.exr', Buffer.from([0x76, 0x2f, 0x31, 0x01])];
  d.exrAbsurd = ['exrAbsurd.exr', exrDatei([exrKopf({ w: 65536, h: 65536 })])];
  d.exrAttributRiesig = ['exrAttributRiesig.exr', exrDatei([Buffer.concat([exrKopf({ w: 4, h: 4 }).subarray(0, -1), cstr('riesig'), cstr('string'), u32le(0x7fffffff), fuell(20), Buffer.from([0])])])];
  d.exrFalscheVersion = ['exrFalscheVersion.exr', exrDatei([exrKopf({ w: 4, h: 4 })], { version: 9 })];
  d.exrFalscheMagic = ['exrFalscheMagic.exr', fuell(64, 7)];

  // HDR
  d.hdrRgbe = ['hdrRgbe.hdr', hdrDatei({ zeilen: ['# Kommentar eins', 'FORMAT=32-bit_rle_rgbe', 'EXPOSURE=1.5', 'EXPOSURE=2'], aufloesung: '-Y 4 +X 8' })];
  d.hdrKurz = ['hdrKurz.hdr', hdrDatei({ kennung: '#?RGBE', zeilen: ['FORMAT=32-bit_rle_rgbe'], aufloesung: '-Y 2 +X 3', pixel: 6 })];
  d.hdrXyz = ['hdrXyz.hdr', hdrDatei({ zeilen: ['FORMAT=32-bit_rle_xyze'], aufloesung: '+Y 8 +X 16', pixel: 8 })];
  d.hdrAbgeschnitten = ['hdrAbgeschnitten.hdr', Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4')];
  d.hdrOhneLeerzeile = ['hdrOhneLeerzeile.hdr', Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n-Y 4 +X 8\n' + 'x'.repeat(3000))];
  d.hdrAbsurd = ['hdrAbsurd.hdr', hdrDatei({ aufloesung: '-Y 70000 +X 70000', pixel: 4 })];
  d.hdrFalscheAufloesung = ['hdrFalscheAufloesung.hdr', hdrDatei({ aufloesung: 'kein-maß', pixel: 4 })];
  d.hdrFalscheMagic = ['hdrFalscheMagic.hdr', fuell(80, 4)];

  // Sonstiges
  d.leerPng = ['leerPng.png', Buffer.alloc(0)];
  d.leerDds = ['leerDds.dds', Buffer.alloc(0)];
  d.ddsAlsPng = ['ddsAlsPng.png', d.ddsBc1Mips[1]];
  return d;
}

// ---------------------------------------------------------------- echte Dateien (Fremdwerkzeuge)

function lauf(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function hat(cmd) {
  try {
    lauf('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

const PY_PIL = `
import sys, json
from PIL import Image, ImageCms
d = sys.argv[1]
ok = {}
def tu(name, fn, w, h):
    try:
        fn(d + '/' + name); ok[name] = [w, h]
    except Exception as e:
        sys.stderr.write(name + ': ' + str(e) + '\\n')
rgba = Image.new('RGBA', (32, 16), (255, 0, 0, 128))
rgb = Image.new('RGB', (40, 24), (10, 200, 30))
icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
tu('echt-rgba.png', lambda p: rgba.save(p, dpi=(72, 72)), 32, 16)
def pal(p):
    im = Image.new('P', (16, 16)); im.putpalette([i % 256 for i in range(768)]); im.save(p, transparency=0)
tu('echt-palette.png', pal, 16, 16)
tu('echt-icc.png', lambda p: rgb.save(p, icc_profile=icc), 40, 24)
frames = [Image.new('RGBA', (16, 16), (i * 60, 0, 0, 255)) for i in range(3)]
tu('echt-anim.png', lambda p: frames[0].save(p, save_all=True, append_images=frames[1:], duration=100, loop=0), 16, 16)
tu('echt-prog.jpg', lambda p: rgb.save(p, quality=80, progressive=True, dpi=(300, 300)), 40, 24)
tu('echt-base.jpg', lambda p: rgb.save(p, quality=90, subsampling=0), 40, 24)
def ex(p):
    e = Image.Exif(); e[0x0112] = 6; rgb.save(p, exif=e)
tu('echt-exif.jpg', ex, 40, 24)
tu('echt-icc.jpg', lambda p: rgb.save(p, icc_profile=icc), 40, 24)
tu('echt-gray.jpg', lambda p: Image.new('L', (24, 24), 128).save(p), 24, 24)
tu('echt-lossy.webp', lambda p: rgba.save(p, quality=60), 32, 16)
tu('echt-lossless.webp', lambda p: rgba.save(p, lossless=True), 32, 16)
tu('echt-anim.webp', lambda p: frames[0].save(p, save_all=True, append_images=frames[1:], duration=80, loop=2), 16, 16)
print(json.dumps(ok))
`;

async function echteDateien(dir, werkzeuge) {
  const echt = {};
  const merke = async (name, erwartet = null) => {
    try {
      const s = await stat(join(dir, name));
      if (s.size > 0) echt[name] = { datei: join(dir, name), size: s.size, ...(erwartet ?? {}) };
    } catch { /* nicht erzeugt */ }
  };
  const identify = name => {
    if (!werkzeuge.magick) return null;
    try {
      const o = lauf('magick', ['identify', '-format', '%w %h\n', join(dir, name)]).trim().split('\n')[0].split(' ').map(Number);
      return o.length === 2 && o.every(Number.isFinite) ? { w: o[0], h: o[1], quelle: 'magick identify' } : null;
    } catch {
      return null;
    }
  };

  if (werkzeuge.pil) {
    try {
      const ok = JSON.parse(lauf('python3', ['-c', PY_PIL, dir]).trim().split('\n').pop());
      for (const [n, [w, h]] of Object.entries(ok)) await merke(n, { w, h, quelle: 'python3+PIL' });
    } catch { /* PIL-Lauf gescheitert: keine PIL-Dateien */ }
  }
  if (werkzeuge.magick) {
    const versuche = [
      ['echt-dxt5.dds', ['-size', '64x32', 'gradient:red-blue', '-define', 'dds:compression=dxt5', '-define', 'dds:mipmaps=6']],
      ['echt-dxt1.dds', ['-size', '32x32', 'gradient:green-white', '-define', 'dds:compression=dxt1', '-define', 'dds:mipmaps=0']],
      ['echt-roh.dds', ['-size', '16x8', 'gradient:red-blue', '-define', 'dds:compression=none', '-define', 'dds:mipmaps=0']],
      ['echt-im.hdr', ['-size', '24x12', 'gradient:red-blue']],
      ['echt-im.exr', ['-size', '16x8', 'gradient:red-blue']],
      ['echt-cmyk.jpg', ['-size', '16x16', 'xc:red', '-colorspace', 'CMYK']],
    ];
    for (const [n, a] of versuche) {
      try {
        lauf('magick', [...a, join(dir, n)]);
        await merke(n, identify(n) ?? {});
      } catch { /* ImageMagick kann dieses Format hier nicht: weglassen */ }
    }
  }
  if (werkzeuge.oiiotool) {
    const versuche = [
      ['echt-oiio-half-zip.exr', ['--create', '32x16', '4', '--pattern', 'checker', '32x16', '4', '-d', 'half', '--compression', 'zip']],
      ['echt-oiio-float-piz.exr', ['--create', '16x16', '3', '-d', 'float', '--compression', 'piz']],
      ['echt-oiio-tiled.exr', ['--create', '64x32', '3', '-d', 'half', '--tile', '16', '16', '--compression', 'zips']],
      ['echt-oiio.hdr', ['--create', '20x10', '3']],
    ];
    for (const [n, a] of versuche) {
      try {
        lauf('oiiotool', [...a, '-o', join(dir, n)]);
        await merke(n, identify(n) ?? {});
      } catch { /* oiiotool kann das nicht: weglassen */ }
    }
  }
  if (werkzeuge.ffmpeg) {
    const versuche = [
      ['echt-ffmpeg.exr', ['-f', 'lavfi', '-i', 'color=c=red:s=16x8', '-frames:v', '1', '-pix_fmt', 'gbrpf32le']],
      ['echt-ffmpeg.webp', ['-f', 'lavfi', '-i', 'testsrc=s=48x32', '-frames:v', '1']],
      ['echt-ffmpeg.png', ['-f', 'lavfi', '-i', 'testsrc=s=48x32', '-frames:v', '1']],
      ['echt-ffmpeg.jpg', ['-f', 'lavfi', '-i', 'testsrc=s=48x32', '-frames:v', '1']],
    ];
    for (const [n, a] of versuche) {
      try {
        lauf('ffmpeg', ['-v', 'error', '-y', ...a, join(dir, n)]);
        await merke(n, identify(n) ?? {});
      } catch { /* ffmpeg ohne diesen Encoder: weglassen */ }
    }
  }
  return echt;
}

/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird ein neues unter os.tmpdir() angelegt.
 * @param {{echt?: boolean}} [opt] echt:false erzeugt nur die handgebauten Dateien.
 * @returns {Promise<{dir:string, pfade:Record<string,string>, daten:Record<string,Buffer>, echt:Record<string,{datei:string,size:number,w?:number,h?:number,quelle?:string}>, werkzeuge:Record<string,boolean>, aufraeumen:()=>Promise<void>}>}
 */
export async function erzeugeTexturFixtures(ziel, opt = {}) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-textur-fixtures-')));
  await mkdir(dir, { recursive: true });
  const pfade = {};
  const daten = {};
  for (const [schluessel, [name, inhalt]] of Object.entries(handgebaut())) {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
    daten[schluessel] = inhalt;
  }
  const werkzeuge = {
    pil: false,
    magick: hat('magick'),
    ffmpeg: hat('ffmpeg'),
    oiiotool: hat('oiiotool'),
    cwebp: hat('cwebp'),
    texconv: hat('texconv'),
    toktx: hat('toktx'),
  };
  if (hat('python3')) {
    try {
      lauf('python3', ['-c', 'import PIL']);
      werkzeuge.pil = true;
    } catch { /* kein PIL */ }
  }
  const echt = opt.echt === false ? {} : await echteDateien(dir, werkzeuge);
  return { dir, pfade, daten, echt, werkzeuge, aufraeumen: () => rm(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade, echt, werkzeuge } = await erzeugeTexturFixtures();
  console.log(dir);
  console.log('Werkzeuge:', JSON.stringify(werkzeuge));
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
  for (const [k, v] of Object.entries(echt)) console.log(`  [echt] ${k}: ${v.size} Bytes ${v.w ? `${v.w}x${v.h} (${v.quelle})` : ''}`);
}
