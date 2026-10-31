/**
 * P22-T238 mit P4-T75 (User 31.10.2026, thought 0e4c4c3f): Neu uebertragene Binaerformate bekommen Metadaten wie PNG.
 * GEPRUEFT (synthetische Dateien in mkdtemp, kein PG):
 *   A textur/bmp.ts       24 bit BITMAPINFOHEADER, 32 bit V4 mit Alpha-Maske, Magic-Pruefung gegen fremdes 'BM'
 *   B textur/ico.ts       ICO mit eingebettetem PNG (RGBA), CUR mit Hotspot (Version 3)
 *   C textur/heif.ts      AVIF: ispe/pixi/av1C/auxC-Alpha ueber ipma/iref, Format avif, Status ok
 *   D schrift/*.ts        TTF (name/maxp/head/OS/2), WOFF (unkomprimiert), WOFF2 (Brotli), EOT-Kopf
 *   E Registry/Konfig     Formate im Katalog, Erkennung per Magic, kein Text-Asset
 * AUFRUF: mise run build:core && node packages/core/tests/asset-inspektoren-p22-t238-p4-t75.test.mjs
 */
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const { inspectAsset, standardRegistry } = await import(resolve(here, '../dist/asset-intel/index.js'));

let fehler = 0, ok = 0;
function check(herkunft, bedingung, debug) {
  if (bedingung) { ok++; console.log('PASS ' + herkunft); return; }
  fehler++;
  console.log('FAIL ' + herkunft + (debug === undefined ? '' : ' | tatsaechlich: ' + JSON.stringify(debug).slice(0, 500)));
}
const dir = await mkdtemp(join(tmpdir(), 'p22-t238-insp-'));
const datei = async (name, buf) => { const p = join(dir, name); await writeFile(p, buf); return p; };
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const box = (typ, ...teile) => { const inhalt = Buffer.concat(teile); return Buffer.concat([u32be(8 + inhalt.length), Buffer.from(typ, 'latin1'), inhalt]); };
const fullbox = (typ, v, flags, ...teile) => box(typ, Buffer.from([v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...teile);

try {
  // ---------------------------------------------------------------- A BMP
  {
    const pixel = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]);
    const k = Buffer.alloc(54);
    k.write('BM', 0, 'ascii'); k.writeUInt32LE(54 + pixel.length, 2); k.writeUInt32LE(54, 10);
    k.writeUInt32LE(40, 14); k.writeInt32LE(2, 18); k.writeInt32LE(1, 22); k.writeUInt16LE(1, 26); k.writeUInt16LE(24, 28); k.writeInt32LE(2835, 38); k.writeInt32LE(2835, 42);
    const r = await inspectAsset(await datei('a.bmp', Buffer.concat([k, pixel])));
    check('P22-T238 A bmp.ts: 24 bit -> ok, 2x1, 3 Kanaele, 8 bit, kein Alpha, ~72 dpi',
      r.status === 'ok' && r.format === 'bmp' && r.metadata.width === 2 && r.metadata.height === 1 && r.metadata.channels === 3 && r.metadata.bits_per_channel === 8 && r.metadata.has_alpha === false && Math.round(r.metadata.dpi_x) === 72, r);
    const v4 = Buffer.alloc(14 + 108 + 16);
    v4.write('BM', 0, 'ascii'); v4.writeUInt32LE(v4.length, 2); v4.writeUInt32LE(14 + 108, 10);
    v4.writeUInt32LE(108, 14); v4.writeInt32LE(1, 18); v4.writeInt32LE(-4, 22); v4.writeUInt16LE(1, 26); v4.writeUInt16LE(32, 28); v4.writeUInt32LE(3, 30);
    v4.writeUInt32LE(0x00ff0000, 54); v4.writeUInt32LE(0x0000ff00, 58); v4.writeUInt32LE(0x000000ff, 62); v4.writeUInt32LE(0xff000000, 66);
    const r2 = await inspectAsset(await datei('b.bmp', v4));
    check('P22-T238 A bmp.ts: 32 bit V4 mit Alpha-Maske -> has_alpha, 4 Kanaele, top_down', r2.metadata.has_alpha === true && r2.metadata.channels === 4 && r2.metadata.top_down === true && r2.metadata.height === 4, r2.metadata);
    check("P22-T238 A bmp.ts pruefeMagic: 'BM' ohne gueltigen DIB-Kopf ist kein BMP",
      standardRegistry.detect('x.bin', Buffer.from('BMxxxxxxxxxxxxxxxxxxxxxxxx')).format !== 'bmp');
  }

  // ---------------------------------------------------------------- B ICO / CUR
  {
    const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'ascii'); ihdr.writeUInt32BE(48, 8); ihdr.writeUInt32BE(48, 12); ihdr[16] = 8; ihdr[17] = 6;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(12)]);
    const kopf = Buffer.from([0, 0, 1, 0, 1, 0]);
    const e = Buffer.alloc(16); e[0] = 48; e[1] = 48; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(22, 12);
    const r = await inspectAsset(await datei('a.ico', Buffer.concat([kopf, e, png])));
    check('P22-T238 B ico.ts: ICO mit PNG -> 48x48, has_alpha, 4 Kanaele, 8 bit, eingebettete_png 1, Version 3',
      r.status === 'ok' && r.metadata.width === 48 && r.metadata.has_alpha === true && r.metadata.channels === 4 && r.metadata.bits_per_channel === 8 && r.metadata.eingebettete_png === 1 && r.parser_version === 3, r);
    const ck = Buffer.from([0, 0, 2, 0, 1, 0]);
    const dib = Buffer.alloc(40); dib.writeUInt32LE(40, 0); dib.writeInt32LE(32, 4); dib.writeInt32LE(64, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
    const ce = Buffer.alloc(16); ce[0] = 32; ce[1] = 32; ce.writeUInt16LE(5, 4); ce.writeUInt16LE(7, 6); ce.writeUInt32LE(dib.length, 8); ce.writeUInt32LE(22, 12);
    const rc = await inspectAsset(await datei('a.cur', Buffer.concat([ck, ce, dib])));
    check('P22-T238 B ico.ts: CUR -> Format cur, Hotspot 5/7, 32 bit mit Alpha', rc.format === 'cur' && rc.metadata.hotspot_x === 5 && rc.metadata.hotspot_y === 7 && rc.metadata.has_alpha === true, rc);
  }

  // ---------------------------------------------------------------- C AVIF
  {
    const ftyp = box('ftyp', Buffer.from('avif', 'latin1'), u32be(0), Buffer.from('avifmif1miaf', 'latin1'));
    const hdlr = fullbox('hdlr', 0, 0, u32be(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13));
    const pitm = fullbox('pitm', 0, 0, u16be(1));
    const infe = (id, typ) => fullbox('infe', 2, 0, u16be(id), u16be(0), Buffer.from(typ, 'latin1'), Buffer.from([0]));
    const iinf = fullbox('iinf', 0, 0, u16be(2), infe(1, 'av01'), infe(2, 'av01'));
    const iref = fullbox('iref', 0, 0, box('auxl', u16be(2), u16be(1), u16be(1)));
    const ispe = fullbox('ispe', 0, 0, u32be(640), u32be(480));
    const pixi = fullbox('pixi', 0, 0, Buffer.from([3, 10, 10, 10]));
    const av1c = box('av1C', Buffer.from([0x81, 0x00, 0x40, 0x00]));
    const auxc = fullbox('auxC', 0, 0, Buffer.from('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0', 'latin1'));
    const ipco = box('ipco', ispe, pixi, av1c, auxc);
    const ipma = fullbox('ipma', 0, 0, u32be(2), u16be(1), Buffer.from([3, 0x81, 0x82, 0x83]), u16be(2), Buffer.from([2, 0x81, 0x84]));
    const meta = fullbox('meta', 0, 0, hdlr, pitm, iinf, iref, box('iprp', ipco, ipma));
    const r = await inspectAsset(await datei('bild.avif', Buffer.concat([ftyp, meta, box('mdat', Buffer.alloc(16))])));
    check('P22-T238 C heif.ts: AVIF -> ok, 640x480, 10 bit, Alpha aus auxl/auxC, 4 Kanaele, frame_count 1, Format avif',
      r.status === 'ok' && r.format === 'avif' && r.metadata.width === 640 && r.metadata.height === 480 && r.metadata.bits_per_channel === 10 && r.metadata.has_alpha === true && r.metadata.channels === 4 && r.metadata.frame_count === 1 && r.metadata.animated === false, r);
    check('P22-T238 C heif.ts: Erkennung per Magic ftypavif auch ohne Endung', standardRegistry.detect('x', ftyp).format === 'avif');
  }

  // ---------------------------------------------------------------- D Schriften
  {
    const utf16 = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return b; };
    const namenListe = [[1, 'Testfamilie'], [2, 'Kursiv'], [4, 'Testfamilie Kursiv'], [6, 'Testfamilie-Kursiv']];
    const strings = namenListe.map(([, s]) => utf16(s));
    const recs = []; let off = 0;
    for (let i = 0; i < namenListe.length; i++) { recs.push(Buffer.concat([u16be(3), u16be(1), u16be(0x409), u16be(namenListe[i][0]), u16be(strings[i].length), u16be(off)])); off += strings[i].length; }
    const name = Buffer.concat([u16be(0), u16be(namenListe.length), u16be(6 + 12 * namenListe.length), ...recs, ...strings]);
    const maxp = Buffer.concat([u32be(0x00005000), u16be(321)]);
    const head = Buffer.alloc(54); head.writeUInt16BE(1000, 18); head.writeUInt16BE(2, 44);
    const os2 = Buffer.alloc(78); os2.writeUInt16BE(600, 4); os2.writeUInt16BE(5, 6); os2.writeUInt16BE(1, 62);
    const tabellen = [['OS/2', os2], ['head', head], ['maxp', maxp], ['name', name]];
    const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
    const sfnt = () => {
      const n = tabellen.length; let pos = 12 + 16 * n; const dirs = [], daten = [];
      for (const [tag, d] of tabellen) { dirs.push(Buffer.concat([Buffer.from(tag, 'latin1'), u32be(0), u32be(pos), u32be(d.length)])); daten.push(pad(d)); pos += pad(d).length; }
      return Buffer.concat([u32be(0x00010000), u16be(n), u16be(64), u16be(2), u16be(0), ...dirs, ...daten]);
    };
    const erwartung = (r) => r.status === 'ok' && r.asset_type === 'font' && r.metadata.family === 'Testfamilie' && r.metadata.style === 'Kursiv' && r.metadata.glyph_count === 321 && r.metadata.units_per_em === 1000 && r.metadata.weight_class === 600 && r.metadata.italic === true;
    const ttf = sfnt();
    const r = await inspectAsset(await datei('a.ttf', ttf));
    check('P22-T238 D schrift-sfnt: TTF -> Familie, Stil, 321 Glyphen, unitsPerEm 1000, Gewicht 600, kursiv', erwartung(r), r);

    // WOFF 1, Tabellen unkomprimiert (compLength == origLength)
    let pos = 44 + 20 * tabellen.length; const wdir = [], wdat = [];
    for (const [tag, d] of tabellen) { wdir.push(Buffer.concat([Buffer.from(tag, 'latin1'), u32be(pos), u32be(d.length), u32be(d.length), u32be(0)])); wdat.push(pad(d)); pos += pad(d).length; }
    const woffKopf = Buffer.alloc(44); woffKopf.write('wOFF', 0, 'latin1'); woffKopf.writeUInt32BE(0x00010000, 4); woffKopf.writeUInt32BE(pos, 8); woffKopf.writeUInt16BE(tabellen.length, 12);
    const rw = await inspectAsset(await datei('a.woff', Buffer.concat([woffKopf, ...wdir, ...wdat])));
    check('P22-T238 D schrift-woff: WOFF -> dieselben Metadaten', erwartung(rw), rw);

    // WOFF 2: bekannte Tags (OS/2=6, head=1, maxp=4, name=5), keine Transformation, ein Brotli-Strom
    const idx = { 'OS/2': 6, head: 1, maxp: 4, name: 5 };
    const b128 = (n) => { const out = []; do { out.unshift(n & 0x7f); n >>>= 7; } while (n); return Buffer.from(out.map((x, i) => (i < out.length - 1 ? x | 0x80 : x))); };
    const w2dir = Buffer.concat(tabellen.map(([tag, d]) => Buffer.concat([Buffer.from([idx[tag]]), b128(d.length)])));
    const strom = brotliCompressSync(Buffer.concat(tabellen.map(([, d]) => d)));
    const w2 = Buffer.alloc(48); w2.write('wOF2', 0, 'latin1'); w2.writeUInt32BE(0x00010000, 4); w2.writeUInt16BE(tabellen.length, 12); w2.writeUInt32BE(strom.length, 20);
    const w2datei = Buffer.concat([w2, w2dir, strom]); w2datei.writeUInt32BE(w2datei.length, 8);
    const r2 = await inspectAsset(await datei('a.woff2', w2datei));
    check('P22-T238 D schrift-woff2: WOFF2 (Brotli) -> dieselben Metadaten', erwartung(r2), r2);

    // EOT mit unkomprimierten Schriftdaten (Offsets relativ zum Datenbeginn)
    const utf16le = (s) => Buffer.from(s, 'utf16le');
    const nm = (s) => Buffer.concat([Buffer.alloc(2), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(utf16le(s).length); return b; })(), utf16le(s)]);
    const fix = Buffer.alloc(80); fix.writeUInt32LE(0x00020001, 8); fix[27] = 1; fix.writeUInt32LE(600, 28); fix.writeUInt16LE(0x504c, 34);
    const eotKopf = Buffer.concat([fix, nm('Testfamilie'), nm('Kursiv'), nm('Version 1'), nm('Testfamilie Kursiv')]);
    const eot = Buffer.concat([eotKopf, ttf]); eot.writeUInt32LE(eot.length, 0); eot.writeUInt32LE(ttf.length, 4);
    const re = await inspectAsset(await datei('a.eot', eot));
    check('P22-T238 D schrift-eot: EOT -> Familie/Stil/Glyphen aus eingebetteten Daten', re.format === 'eot' && re.metadata.family === 'Testfamilie' && re.metadata.glyph_count === 321, re);
  }

  // ---------------------------------------------------------------- E Registry
  {
    const f = standardRegistry.formats();
    check('P22-T238 E Registry: neue Formate im Katalog (bmp, avif, heic, heif, cur, ttf, otf, ttc, woff, woff2, eot)',
      ['bmp', 'avif', 'heic', 'heif', 'cur', 'ttf', 'otf', 'ttc', 'woff', 'woff2', 'eot'].every((x) => f.includes(x)), f);
    check('P22-T238 E Registry: SVG bleibt ohne Inspector (Code, thought 5eae0647)', standardRegistry.detect('a.svg', Buffer.from('<svg/>')).format === null);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(`\nP22-T238/P4-T75 Inspektoren: ${ok} PASS, ${fehler} FAIL`);
process.exit(fehler ? 1 : 0);
