/**
 * MODUL: Schrift-Inspektoren (P22-T238 zusammen mit P4-T75, User 31.10.2026, thought 0e4c4c3f)
 * ZWECK: Metadaten (Familie, Stil, Glyphenzahl, Gewicht, variable Achsen ...) fuer
 *   schrift-sfnt   TTF/OTF/TTC (SFNT direkt; TTC: erste Schrift + font_count)
 *   schrift-woff   WOFF 1 (Tabellen einzeln zlib-komprimiert)
 *   schrift-woff2  WOFF 2 (ein Brotli-Strom; name/maxp/head/OS/2 sind nie transformiert)
 *   schrift-eot    Embedded OpenType (Namen im Kopf; Glyphenzahl nur bei unkomprimierten, unverschluesselten Daten)
 * MAGIC: 00 01 00 00 (TrueType) ist schwach -> pruefeMagic (Tabellenzahl/searchRange) oder Endung;
 *   'OTTO', 'true', 'typ1', 'ttcf', 'wOFF', 'wOF2' sind eindeutig; EOT: 'LP' an Offset 34 + Version + Groesse.
 * asset_type 'font'. Dekomprimiert wird nur mit fester Ausgabegrenze (maxOutputLength).
 */

import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { TABELLE_MAX, istSfntKopf, schriftMetadaten, sfntTabellen } from './sfnt.js';
import type { Tabellen } from './sfnt.js';

const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
/** Groesster WOFF2-Brotli-Strom, der fuer Metadaten entpackt wird. */
const WOFF2_STROM_MAX = 32 * 1024 * 1024;

function warnung(res: AssetResult, code: string, message: string, teilweise = true): void {
  res.warnings.push({ code, message });
  if (teilweise && res.status === 'ok') res.status = 'teilweise';
}

async function sicher(res: AssetResult, fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (e) {
    const name = (e as Error)?.name ?? '';
    if (name === 'AssetLimitError') throw e;
    warnung(res, 'schrift_lesefehler', 'Schrift nicht vollstaendig lesbar: ' + ((e as Error)?.message ?? String(e)).slice(0, 200));
  }
}

function neu(src: AssetSource, ctx: AssetContext, id: string, version: number, format: string): AssetResult {
  return erzeugeAssetResult(src.filePath, src.size, { asset_type: 'font', format: ctx.format ?? format, inspector: id, parser_version: version });
}

// ------------------------------------------------------------------ TTF / OTF / TTC
export const sfntInspector: AssetInspector = {
  id: 'schrift-sfnt',
  formats: ['ttf', 'otf', 'ttc'],
  extensions: ['.ttf', '.otf', '.ttc', '.otc'],
  magic: [
    { offset: 0, bytes: [0x00, 0x01, 0x00, 0x00], format: 'ttf' },
    { offset: 0, bytes: ASCII('true'), format: 'ttf' },
    { offset: 0, bytes: ASCII('typ1'), format: 'ttf' },
    { offset: 0, bytes: ASCII('OTTO'), format: 'otf' },
    { offset: 0, bytes: ASCII('ttcf'), format: 'ttc' },
  ],
  version: 1,
  pruefeMagic(filePath, head) {
    if (/\.(ttf|otf|ttc|otc)$/i.test(filePath)) return true;
    if (head.length >= 4 && head[0] === 0x74 && head[1] === 0x74 && head[2] === 0x63 && head[3] === 0x66) return head.length >= 12;
    return istSfntKopf(head);
  },
  async inspect(src, ctx) {
    const res = neu(src, ctx, 'schrift-sfnt', 1, 'ttf');
    await sicher(res, async () => {
      const k = await src.readRange(0, 16);
      const sig = k.toString('latin1', 0, 4);
      let basis = 0, schriften = 1;
      if (sig === 'ttcf') {
        schriften = k.length >= 12 ? k.readUInt32BE(8) : 0;
        const off = await src.readRange(12, 4);
        if (!schriften || off.length < 4) { res.status = 'fehler'; warnung(res, 'ttc_ungueltig', 'TTC-Kopf ohne Schriften.'); return; }
        basis = off.readUInt32BE(0);
        res.format = 'ttc';
      } else res.format = sig === 'OTTO' ? 'otf' : (ctx.format === 'otf' ? 'otf' : 'ttf');
      const t = await sfntTabellen(src, basis);
      if (!t) { res.status = 'fehler'; warnung(res, 'tabellen_ungueltig', 'SFNT-Tabellenverzeichnis fehlt oder ist unplausibel.'); return; }
      const v = (await src.readRange(basis, 4)).toString('latin1');
      await schriftMetadaten(res, t, res.format === 'ttc' ? 'TrueType Collection' : v === 'OTTO' ? 'OpenType/CFF' : 'TrueType',
        { font_count: schriften, mime_type: res.format === 'otf' ? 'font/otf' : res.format === 'ttc' ? 'font/collection' : 'font/ttf' });
    });
    return res;
  },
};

// ------------------------------------------------------------------ WOFF 1
export const woffInspector: AssetInspector = {
  id: 'schrift-woff',
  formats: ['woff'],
  extensions: ['.woff'],
  magic: [{ offset: 0, bytes: ASCII('wOFF'), format: 'woff' }],
  version: 1,
  async inspect(src, ctx) {
    const res = neu(src, ctx, 'schrift-woff', 1, 'woff');
    await sicher(res, async () => {
      const k = await src.readRange(0, 44);
      if (k.length < 44 || k.toString('latin1', 0, 4) !== 'wOFF') { res.status = 'fehler'; warnung(res, 'signatur_ungueltig', 'Kein WOFF-Kopf.'); return; }
      const flavor = k.toString('latin1', 4, 8), n = k.readUInt16BE(12);
      if (n === 0 || n > 512) { res.status = 'fehler'; warnung(res, 'tabellen_ungueltig', `Unplausible Tabellenzahl ${n}.`); return; }
      if (k.readUInt32BE(8) !== src.size) warnung(res, 'laenge_abweichend', `Kopf meldet ${k.readUInt32BE(8)} Bytes, Datei hat ${src.size}.`);
      const dir = await src.readRange(44, 20 * n);
      const e = new Map<string, { off: number; comp: number; orig: number }>();
      for (let i = 0; i < n && 20 * i + 20 <= dir.length; i++) {
        const o = 20 * i;
        e.set(dir.toString('latin1', o, o + 4), { off: dir.readUInt32BE(o + 4), comp: dir.readUInt32BE(o + 8), orig: dir.readUInt32BE(o + 12) });
      }
      const t: Tabellen = {
        tags: [...e.keys()],
        async holen(tag) {
          const x = e.get(tag);
          if (!x || x.off + x.comp > src.size || x.orig > TABELLE_MAX) return null;
          const d = await src.readRange(x.off, x.comp);
          if (x.comp >= x.orig) return d;
          try { return inflateSync(d, { maxOutputLength: x.orig }); } catch { warnung(res, 'tabelle_nicht_entpackbar', `Tabelle ${tag} nicht entpackbar.`); return null; }
        },
      };
      await schriftMetadaten(res, t, 'WOFF', { flavor: flavor === 'OTTO' ? 'OpenType/CFF' : 'TrueType', mime_type: 'font/woff' });
    });
    return res;
  },
};

// ------------------------------------------------------------------ WOFF 2
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

class Leser {
  constructor(private readonly b: Buffer, public pos = 0) {}
  u8(): number { if (this.pos >= this.b.length) throw new Error('WOFF2-Verzeichnis abgeschnitten'); return this.b[this.pos++]; }
  u16(): number { const v = (this.u8() << 8) | this.u8(); return v; }
  u32(): number { return ((this.u16() << 16) >>> 0) + this.u16(); }
  base128(): number {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const x = this.u8();
      if (i === 0 && x === 0x80) throw new Error('UIntBase128 mit fuehrender Null');
      if (v & 0xfe000000) throw new Error('UIntBase128 zu gross');
      v = (v << 7) | (x & 0x7f);
      if (!(x & 0x80)) return v >>> 0;
    }
    throw new Error('UIntBase128 laenger als 5 Bytes');
  }
  u255(): number {
    const c = this.u8();
    if (c === 253) return this.u16();
    if (c === 255) return this.u8() + 253;
    if (c === 254) return this.u8() + 506;
    return c;
  }
}

export const woff2Inspector: AssetInspector = {
  id: 'schrift-woff2',
  formats: ['woff2'],
  extensions: ['.woff2'],
  magic: [{ offset: 0, bytes: ASCII('wOF2'), format: 'woff2' }],
  version: 1,
  async inspect(src, ctx) {
    const res = neu(src, ctx, 'schrift-woff2', 1, 'woff2');
    await sicher(res, async () => {
      const k = await src.readRange(0, 48);
      if (k.length < 48 || k.toString('latin1', 0, 4) !== 'wOF2') { res.status = 'fehler'; warnung(res, 'signatur_ungueltig', 'Kein WOFF2-Kopf.'); return; }
      const flavor = k.toString('latin1', 4, 8), n = k.readUInt16BE(12), komprimiert = k.readUInt32BE(20);
      if (n === 0 || n > 512) { res.status = 'fehler'; warnung(res, 'tabellen_ungueltig', `Unplausible Tabellenzahl ${n}.`); return; }
      const dirRoh = await src.readRange(48, Math.min(n * 14 + 4096, src.size - 48));
      const l = new Leser(dirRoh);
      const tabellen: Array<{ tag: string; laenge: number }> = [];
      for (let i = 0; i < n; i++) {
        const flags = l.u8();
        const idx = flags & 0x3f, transform = (flags >> 6) & 3;
        let tag: string;
        if (idx === 63) { const b = dirRoh.subarray(l.pos, l.pos + 4); l.pos += 4; tag = b.toString('latin1'); }
        else tag = WOFF2_TAGS[idx] ?? '????';
        const orig = l.base128();
        const transformiert = (tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0;
        const laenge = transformiert ? l.base128() : orig;
        tabellen.push({ tag, laenge });
      }
      let schriften = 1;
      if (flavor === 'ttcf') {
        l.u32();
        schriften = l.u255();
        for (let f = 0; f < schriften; f++) { const m = l.u255(); l.u32(); for (let j = 0; j < m; j++) l.u255(); }
      }
      const start = 48 + l.pos;
      const tags = [...new Set(tabellen.map(x => x.tag))];
      const extra = { flavor: flavor === 'OTTO' ? 'OpenType/CFF' : flavor === 'ttcf' ? 'TrueType Collection' : 'TrueType', font_count: schriften, mime_type: 'font/woff2', komprimiert_bytes: komprimiert };
      if (komprimiert > WOFF2_STROM_MAX || start + komprimiert > src.size || komprimiert > ctx.limits.maxReadBytes) {
        warnung(res, 'strom_nicht_gelesen', `Brotli-Strom (${komprimiert} Bytes) ueber der Lesegrenze oder hinter dem Dateiende: nur Tabellenliste.`);
        await schriftMetadaten(res, { tags, holen: async () => null }, 'WOFF2', extra);
        return;
      }
      const summe = tabellen.reduce((s, x) => s + x.laenge, 0);
      let strom: Buffer;
      try {
        strom = brotliDecompressSync(await src.readRange(start, komprimiert), { maxOutputLength: Math.max(1, Math.min(summe, 512 * 1024 * 1024)) });
      } catch (e) {
        warnung(res, 'strom_nicht_entpackbar', 'Brotli-Strom nicht entpackbar: ' + ((e as Error).message ?? '').slice(0, 120));
        await schriftMetadaten(res, { tags, holen: async () => null }, 'WOFF2', extra);
        return;
      }
      const lage = new Map<string, { off: number; laenge: number }>();
      let pos = 0;
      for (const x of tabellen) { if (!lage.has(x.tag)) lage.set(x.tag, { off: pos, laenge: x.laenge }); pos += x.laenge; }
      const t: Tabellen = {
        tags,
        async holen(tag) {
          const x = lage.get(tag);
          if (!x || x.off + x.laenge > strom.length) return null;
          return strom.subarray(x.off, x.off + Math.min(x.laenge, TABELLE_MAX));
        },
      };
      await schriftMetadaten(res, t, 'WOFF2', extra);
    });
    return res;
  },
};

// ------------------------------------------------------------------ EOT
const EOT_VERSIONEN = [0x00010000, 0x00020001, 0x00020002];

function utf16le(b: Buffer): string { return b.subarray(0, b.length - (b.length % 2)).toString('utf16le').replace(/\u0000/g, '').trim().slice(0, 256); }

export const eotInspector: AssetInspector = {
  id: 'schrift-eot',
  formats: ['eot'],
  extensions: ['.eot'],
  magic: [{ offset: 34, bytes: [0x4c, 0x50], format: 'eot' }],
  version: 1,
  pruefeMagic(filePath, head, size) {
    if (head.length < 36) return false;
    const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    const groesse = b.readUInt32LE(0);
    return EOT_VERSIONEN.includes(b.readUInt32LE(8)) && (size === undefined || groesse === size || /\.eot$/i.test(filePath));
  },
  async inspect(src, ctx) {
    const res = neu(src, ctx, 'schrift-eot', 1, 'eot');
    await sicher(res, async () => {
      const k = await src.readRange(0, Math.min(src.size, 4096));
      if (k.length < 84 || k.readUInt16LE(34) !== 0x504c) { res.status = 'fehler'; warnung(res, 'signatur_ungueltig', 'Kein EOT-Kopf (MagicNumber 0x504C fehlt).'); return; }
      const eotGroesse = k.readUInt32LE(0), datenGroesse = k.readUInt32LE(4), version = k.readUInt32LE(8), flags = k.readUInt32LE(12);
      const italic = k[27] === 1, gewicht = k.readUInt32LE(28);
      // Namen: FamilyName, StyleName, VersionName, FullName - je u16 Laenge + UTF-16LE, mit u16-Padding davor.
      let o = 80;
      const namen: string[] = [];
      for (let i = 0; i < 4; i++) {
        o += 2; // Padding
        if (o + 2 > k.length) break;
        const n = k.readUInt16LE(o); o += 2;
        if (o + n > k.length) break;
        namen.push(utf16le(k.subarray(o, o + n))); o += n;
      }
      const [familie, stil, versionName, vollname] = namen;
      const datenStart = eotGroesse - datenGroesse;
      const komprimiert = (flags & 0x4) !== 0, verschluesselt = (flags & 0x10000000) !== 0;
      let t: Tabellen | null = null;
      if (!komprimiert && !verschluesselt && datenStart > 0 && datenStart < src.size) t = await sfntTabellen(src, datenStart, true);
      if (!t) warnung(res, 'schriftdaten_nicht_lesbar', komprimiert ? 'Schriftdaten MTX-komprimiert: Glyphenzahl unbekannt.' : verschluesselt ? 'Schriftdaten XOR-verschluesselt: Glyphenzahl unbekannt.' : 'Eingebettete Schriftdaten nicht lesbar.', false);
      await schriftMetadaten(res, t ?? { tags: [], holen: async () => null }, 'EOT', { eot_version: '0x' + version.toString(16), mime_type: 'application/vnd.ms-fontobject' });
      // Kopfwerte haben Vorrang, wenn die SFNT-Tabellen fehlen (komprimiert/verschluesselt).
      res.warnings = res.warnings.filter(w => t || (w.code !== 'name_fehlt' && w.code !== 'maxp_fehlt'));
      if (!t && res.status === 'teilweise' && !res.warnings.some(w => w.code !== 'schriftdaten_nicht_lesbar')) res.status = 'ok';
      const m = res.metadata;
      m.family = m.family ?? familie ?? null;
      m.style = m.style ?? stil ?? null;
      m.version = m.version ?? versionName ?? null;
      m.full_name = m.full_name ?? vollname ?? null;
      m.weight_class = m.weight_class ?? (gewicht || null);
      m.italic = m.italic ?? italic;
      res.format_specific = { ...res.format_specific, eot_groesse: eotGroesse, daten_groesse: datenGroesse, flags, komprimiert, verschluesselt };
    });
    return res;
  },
};

export const assetSchriftInspektoren: AssetInspector[] = [sfntInspector, woffInspector, woff2Inspector, eotInspector];
