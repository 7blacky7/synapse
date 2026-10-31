/**
 * MODUL: Schrift-Inspektoren, gemeinsamer SFNT-Teil (P22-T238 zusammen mit P4-T75, User 31.10.2026, thought 0e4c4c3f)
 * ZWECK: Liest aus den Tabellen name/maxp/head/OS/2/fvar die Metadaten einer Schrift: Familie, Stil, Vollname,
 *        PostScript-Name, Version, Glyphenzahl, unitsPerEm, Gewicht, kursiv/fett, variable Achsen, Outline-Art.
 *        Die Huellen (TTF/OTF/TTC direkt, WOFF zlib, WOFF2 Brotli, EOT) liefern nur 'Tabellen' - hier wird nichts
 *        ueber die Huelle angenommen. Glyphen/Outlines werden nie gelesen.
 * GRENZEN: Jede Tabelle wird hoechstens bis TABELLE_MAX gelesen; Laengen aus der Datei steuern nie eine Allokation.
 */

import type { AssetResult, AssetSource } from '../../types.js';

/** Groesste Tabelle, die fuer Metadaten gelesen wird (name kann bei vielen Sprachen gross sein). */
export const TABELLE_MAX = 1024 * 1024;

/** Zugriff auf die Tabellen einer Schrift, unabhaengig von der Huelle. */
export interface Tabellen {
  tags: string[];
  holen(tag: string): Promise<Buffer | null>;
}

const NAME_ID: Record<number, string> = {
  0: 'copyright', 1: 'family', 2: 'subfamily', 3: 'unique_id', 4: 'full_name', 5: 'version', 6: 'postscript_name',
  8: 'manufacturer', 9: 'designer', 13: 'license', 16: 'typographic_family', 17: 'typographic_subfamily',
};

function utf16be(b: Buffer): string {
  const gerade = b.length - (b.length % 2);
  const c = Buffer.from(b.subarray(0, gerade));
  c.swap16();
  return c.toString('utf16le');
}

/** name-Tabelle: bevorzugt Windows-Unicode Englisch (3/1/0x409), dann Windows, Unicode, Mac Roman. */
export function leseNamen(b: Buffer): Record<string, string> {
  if (b.length < 6) return {};
  const anzahl = b.readUInt16BE(2);
  const stringOffset = b.readUInt16BE(4);
  const beste = new Map<number, { prio: number; text: string }>();
  for (let i = 0; i < anzahl; i++) {
    const r = 6 + 12 * i;
    if (r + 12 > b.length) break;
    const plattform = b.readUInt16BE(r), kodierung = b.readUInt16BE(r + 2), sprache = b.readUInt16BE(r + 4);
    const id = b.readUInt16BE(r + 6), laenge = b.readUInt16BE(r + 8), off = b.readUInt16BE(r + 10);
    if (!(id in NAME_ID)) continue;
    const start = stringOffset + off;
    if (start + laenge > b.length) continue;
    const roh = b.subarray(start, start + laenge);
    let text: string, prio: number;
    if (plattform === 3) { text = utf16be(roh); prio = sprache === 0x409 ? 0 : 1; }
    else if (plattform === 0) { text = utf16be(roh); prio = 2; }
    else if (plattform === 1 && kodierung === 0) { text = roh.toString('latin1'); prio = 3; }
    else continue;
    text = text.replace(/\u0000/g, '').trim().slice(0, 256);
    if (!text) continue;
    const alt = beste.get(id);
    if (!alt || prio < alt.prio) beste.set(id, { prio, text });
  }
  const aus: Record<string, string> = {};
  for (const [id, v] of beste) aus[NAME_ID[id]] = v.text;
  return aus;
}

const GEWICHT: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

function warnung(res: AssetResult, code: string, message: string, teilweise = true): void {
  res.warnings.push({ code, message });
  if (teilweise && res.status === 'ok') res.status = 'teilweise';
}

/** Fuellt metadata/format_specific aus den Tabellen. huelle = 'TrueType' | 'OpenType/CFF' | 'WOFF' ... */
export async function schriftMetadaten(res: AssetResult, t: Tabellen, huelle: string, extra: Record<string, unknown> = {}): Promise<void> {
  const name = await t.holen('name');
  const maxp = await t.holen('maxp');
  const head = await t.holen('head');
  const os2 = await t.holen('OS/2');
  const fvar = t.tags.includes('fvar') ? await t.holen('fvar') : null;
  const namen = name ? leseNamen(name) : {};
  if (!name) warnung(res, 'name_fehlt', 'Keine name-Tabelle: Familie/Stil unbekannt.');
  const glyphen = maxp && maxp.length >= 6 ? maxp.readUInt16BE(4) : null;
  if (glyphen === null) warnung(res, 'maxp_fehlt', 'Keine maxp-Tabelle: Glyphenzahl unbekannt.');
  const unitsPerEm = head && head.length >= 20 ? head.readUInt16BE(18) : null;
  const macStyle = head && head.length >= 46 ? head.readUInt16BE(44) : null;
  const gewicht = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : null;
  const breiteKlasse = os2 && os2.length >= 8 ? os2.readUInt16BE(6) : null;
  const fsSelection = os2 && os2.length >= 64 ? os2.readUInt16BE(62) : null;
  const kursiv = fsSelection !== null ? (fsSelection & 1) !== 0 : macStyle !== null ? (macStyle & 2) !== 0 : null;
  const fett = fsSelection !== null ? (fsSelection & 0x20) !== 0 : macStyle !== null ? (macStyle & 1) !== 0 : null;
  const achsen: string[] = [];
  if (fvar && fvar.length >= 16) {
    const off = fvar.readUInt16BE(4), n = fvar.readUInt16BE(8), groesse = fvar.readUInt16BE(10);
    for (let i = 0; i < n && i < 64 && off + i * groesse + 4 <= fvar.length; i++) {
      const o = off + i * groesse;
      achsen.push(fvar.toString('latin1', o, o + 4));
    }
  }
  const outline = t.tags.includes('CFF ') || t.tags.includes('CFF2') ? 'cff' : t.tags.includes('glyf') ? 'truetype' : null;
  const familie = namen.typographic_family ?? namen.family ?? null;
  const stil = namen.typographic_subfamily ?? namen.subfamily ?? null;
  res.metadata = {
    kind: 'font',
    family: familie,
    style: stil,
    full_name: namen.full_name ?? null,
    postscript_name: namen.postscript_name ?? null,
    version: namen.version ?? null,
    glyph_count: glyphen,
    units_per_em: unitsPerEm,
    weight_class: gewicht,
    weight_name: gewicht !== null ? (GEWICHT[Math.round(gewicht / 100) * 100] ?? null) : null,
    width_class: breiteKlasse,
    italic: kursiv,
    bold: fett,
    variable: achsen.length > 0,
    axes: achsen,
    outline,
    table_count: t.tags.length,
    container: huelle,
    ...extra,
  };
  res.format_specific = { ...res.format_specific, tabellen: t.tags.slice(0, 64), namen };
}

/** Tabellenverzeichnis einer SFNT-Schrift ab basis. relativ=true: Offsets relativ zu basis (EOT). */
export async function sfntTabellen(src: AssetSource, basis: number, relativ = false): Promise<Tabellen | null> {
  const k = await src.readRange(basis, 12);
  if (k.length < 12) return null;
  const n = k.readUInt16BE(4);
  if (n === 0 || n > 512) return null;
  const dir = await src.readRange(basis + 12, 16 * n);
  const eintraege = new Map<string, { offset: number; laenge: number }>();
  for (let i = 0; i < n && 16 * i + 16 <= dir.length; i++) {
    const o = 16 * i;
    eintraege.set(dir.toString('latin1', o, o + 4), { offset: dir.readUInt32BE(o + 8) + (relativ ? basis : 0), laenge: dir.readUInt32BE(o + 12) });
  }
  return {
    tags: [...eintraege.keys()],
    async holen(tag) {
      const e = eintraege.get(tag);
      if (!e || e.offset >= src.size) return null;
      return src.readRange(e.offset, Math.min(e.laenge, TABELLE_MAX, src.size - e.offset));
    },
  };
}

/** Pruefung der SFNT-Kennung am Dateianfang (fuer schwache Magic 00 01 00 00). */
export function istSfntKopf(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const n = (b[4] << 8) | b[5];
  const searchRange = (b[6] << 8) | b[7];
  if (n === 0 || n > 512) return false;
  const p = 2 ** Math.floor(Math.log2(n));
  return searchRange === p * 16;
}
