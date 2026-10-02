/**
 * MODUL: Textur-Inspektoren Util
 * ZWECK: Gemeinsame Bausteine der Bild-/Textur-Inspektoren (P4-T64): Lesefenster, CRC32,
 *        Plausibilitaetspruefungen fuer Abmessungen/Mips, Groessenschaetzung, Key/Value-Parser,
 *        einheitlicher Aufbau der gemeinsamen metadata-Felder.
 *
 * GRUNDSATZ: Es werden nur Header/Chunks gelesen, nie Pixeldaten dekodiert. Laengenangaben aus
 * der Datei steuern nie eine Allokation: gelesen wird immer min(Angabe, fester Deckel, Rest der Datei).
 */

import { AssetReadError } from '../../errors.js';
import type { AssetResult, AssetSource } from '../../types.js';

/** Groesste plausible Kantenlaenge (GPU-Limit heutiger Hardware). Darueber: Warnung. */
export const ABMESSUNG_GRENZE = 16384;
/** Groesste plausible Texelzahl (4 Gi). Darueber: Warnung. */
export const TEXEL_GRENZE = 2 ** 32;
/** Laengste Textausgabe (Zeichen) fuer Metadaten-Werte. */
export const TEXT_MAX = 256;

/**
 * Haengt eine Warnung ans Ergebnis. teilweise=true setzt den Status von 'ok' auf 'teilweise'
 * (bei kaputten/abgeschnittenen Daten); false fuer reine Hinweise.
 */
export function warnung(res: AssetResult, code: string, message: string, teilweise = true): void {
  res.warnings.push({ code, message });
  if (teilweise && res.status === 'ok') res.status = 'teilweise';
}

/** Fuehrt eine Inspektion aus; AssetReadError (Datei zu kurz) wird zur Warnung, das bis dahin Gefuellte bleibt. */
export async function sicher(res: AssetResult, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AssetReadError) {
      warnung(res, 'abgeschnitten', `Datei abgeschnitten oder beschaedigt: ${e.message}`);
      return;
    }
    throw e;
  }
}

/** Kuerzt Text auf max Zeichen (mit Ellipse). */
export function kuerze(text: string, max = TEXT_MAX): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

/** Hex-Darstellung einer 32-Bit-Zahl. */
export function hex32(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

/** ASCII-Text aus vier Bytes (nicht druckbare Zeichen werden zu '?'). */
export function vierZeichen(buf: Uint8Array, offset: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = buf[offset + i];
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '?';
  }
  return s;
}

/**
 * Lesefenster: bedient viele kleine Lesungen aus einem 64-KiB-Block, damit ein Durchlauf ueber
 * tausende Chunks nicht tausende readRange-Aufrufe braucht. Grosse Lesungen gehen direkt durch.
 * Liefert am Dateiende weniger Bytes als gefordert (wie readRange).
 */
export class Lesefenster {
  private basis = -1;
  private puffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly src: AssetSource,
    private readonly block = 65536
  ) {}

  async lese(offset: number, laenge: number): Promise<Buffer> {
    if (laenge > this.block / 2) return this.src.readRange(offset, laenge);
    const ende = this.basis + this.puffer.length;
    const eof = this.basis >= 0 && this.puffer.length < this.block;
    if (this.basis >= 0 && offset >= this.basis && (offset + laenge <= ende || (eof && offset <= ende))) {
      return this.puffer.subarray(offset - this.basis, Math.min(offset - this.basis + laenge, this.puffer.length));
    }
    this.puffer = await this.src.readRange(offset, this.block);
    this.basis = offset;
    return this.puffer.subarray(0, Math.min(laenge, this.puffer.length));
  }
}

const CRC_TABELLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 (PNG/zlib-Polynom). Inkrementell: crc32(b, crc32(a)) == crc32(a+b). */
export function crc32(buf: Uint8Array, vorher = 0): number {
  let c = (vorher ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABELLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Ist n eine Zweierpotenz (n >= 1, ganzzahlig)? */
export function istZweierpotenz(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (BigInt(n) & (BigInt(n) - 1n)) === 0n;
}

/** Laenge der laengstmoeglichen Mip-Kette (inkl. Stufe 0) fuer diese Abmessungen. */
export function maxMipKette(w: number, h: number, d = 1): number {
  const m = Math.max(1, w, h, d);
  return m < 2 ** 32 ? 32 - Math.clz32(m) : Math.floor(Math.log2(m)) + 1;
}

/** Warnt bei Abmessung 0 oder absurd grossen Abmessungen. Allokiert nichts. */
export function pruefeAbmessungen(res: AssetResult, w: number, h: number, d = 1): void {
  if (w === 0 || h === 0 || d === 0) {
    warnung(res, 'abmessung_null', `Abmessung 0 (${w}x${h}x${d}) ist ungueltig.`);
  }
  const texel = w * h * d;
  if (w > ABMESSUNG_GRENZE || h > ABMESSUNG_GRENZE || d > ABMESSUNG_GRENZE || texel > TEXEL_GRENZE) {
    warnung(
      res,
      'abmessungen_absurd',
      `Abmessungen ${w}x${h}x${d} (${texel.toExponential(3)} Texel) liegen ueber der plausiblen Grenze (Kante ${ABMESSUNG_GRENZE}, Texel ${TEXEL_GRENZE}); Datei evtl. kaputt oder manipuliert. Es wird nichts allokiert.`
    );
  }
}

/** Prueft die Mip-Zahl gegen die Abmessungen; liefert die auf die moegliche Kette gekappte Zahl. */
export function pruefeMips(res: AssetResult, mips: number, w: number, h: number, d = 1): number {
  const max = maxMipKette(w, h, d);
  if (mips > max) {
    warnung(res, 'mip_zahl_passt_nicht', `${mips} Mip-Stufen angegeben, Abmessungen ${w}x${h}x${d} erlauben hoechstens ${max}.`);
    return max;
  }
  return mips;
}

/** Blockformat fuer die Groessenrechnung: Blockkante in Texeln und Bits je Block (unkomprimiert: 1x1 und Bits je Pixel). */
export interface BlockFormat {
  bw: number;
  bh: number;
  bits: number;
}

/** Bytes einer Mip-Stufe. */
export function stufenBytes(lw: number, lh: number, ld: number, fmt: BlockFormat): number {
  return Math.ceil((Math.ceil(lw / fmt.bw) * Math.ceil(lh / fmt.bh) * ld * fmt.bits) / 8);
}

/** Kantenlaenge einer Mip-Stufe i. */
export function stufenKante(n: number, i: number): number {
  return Math.max(1, Math.floor(n / 2 ** i));
}

/**
 * Schaetzt die Rohgroesse der Pixeldaten (alle Mips, Schichten, Flaechen). null, wenn das Format
 * unbekannt ist oder der Wert nicht exakt darstellbar waere (kein Overflow, keine Rundung).
 */
export function schaetzeRohBytes(
  w: number,
  h: number,
  d: number,
  mips: number,
  schichten: number,
  fmt: BlockFormat | null
): number | null {
  if (!fmt || !(w > 0 && h > 0 && d > 0)) return null;
  const n = Math.max(1, Math.min(mips, maxMipKette(w, h, d), 40));
  let summe = 0;
  for (let i = 0; i < n; i++) summe += stufenBytes(stufenKante(w, i), stufenKante(h, i), stufenKante(d, i), fmt);
  const gesamt = summe * Math.max(1, schichten);
  return Number.isSafeInteger(gesamt) ? gesamt : null;
}

/** Eingabe fuer die gemeinsamen metadata-Felder. */
export interface BildKern {
  /** 'texture' fuer GPU-/HDR-Texturformate, 'image' fuer Standardbilder. */
  kind: 'texture' | 'image';
  width: number | null;
  height: number | null;
  depth?: number;
  mip_levels?: number | null;
  array_layers?: number;
  faces?: number;
  has_alpha?: boolean | null;
  channels?: number | null;
  bits_per_channel?: number | null;
  color_space?: string | null;
  transfer?: string | null;
  /** Formatname im Klartext (BC7, RGBA16F, ...). */
  format_name?: string | null;
  /** Blockformat fuer die Groessenschaetzung; null = unbekannt. */
  fmt?: BlockFormat | null;
  /** Direkt vorgegebene Rohgroesse (ueberschreibt die Schaetzung). */
  roh_bytes?: number | null;
}

/** Baut die gemeinsamen metadata-Felder; extra kommt formatabhaengig dazu. */
export function bildMetadata(k: BildKern, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const depth = k.depth ?? 1;
  const mips = k.mip_levels ?? 1;
  const layers = k.array_layers ?? 1;
  const faces = k.faces ?? 1;
  const w = k.width;
  const h = k.height;
  const pow2 = w !== null && h !== null ? istZweierpotenz(w) && istZweierpotenz(h) && (depth <= 1 || istZweierpotenz(depth)) : null;
  const roh =
    k.roh_bytes !== undefined
      ? k.roh_bytes
      : w !== null && h !== null
        ? schaetzeRohBytes(w, h, depth, mips, layers * faces, k.fmt ?? null)
        : null;
  return {
    kind: k.kind,
    format_name: k.format_name ?? null,
    width: w,
    height: h,
    depth,
    mip_levels: k.mip_levels ?? 1,
    array_layers: layers,
    faces,
    has_alpha: k.has_alpha ?? null,
    channels: k.channels ?? null,
    bits_per_channel: k.bits_per_channel ?? null,
    color_space: k.color_space ?? null,
    transfer: k.transfer ?? null,
    power_of_two: pow2,
    geschaetzte_roh_bytes: roh,
    ...extra,
  };
}

/** Ein Key/Value-Eintrag (KTX/KTX2). */
export interface KvEintrag {
  key: string;
  value: string;
  /** Rohlaenge des Wertes in Bytes. */
  value_bytes: number;
}

/** Wert als Text, wenn druckbar; sonst Hex der ersten Bytes. */
export function wertAlsText(bytes: Uint8Array): string {
  let ende = bytes.length;
  while (ende > 0 && bytes[ende - 1] === 0) ende--;
  let druckbar = true;
  for (let i = 0; i < ende; i++) {
    const c = bytes[i];
    if (c < 0x20 && c !== 0x0a && c !== 0x09 && c !== 0x0d) {
      druckbar = false;
      break;
    }
  }
  if (druckbar) return kuerze(Buffer.from(bytes.subarray(0, Math.min(ende, TEXT_MAX * 4))).toString('utf8'));
  const kopf = Buffer.from(bytes.subarray(0, 32)).toString('hex');
  return '0x' + kopf + (bytes.length > 32 ? '...' : '');
}

/**
 * Parst die Key/Value-Daten von KTX/KTX2: wiederholt u32 keyAndValueByteSize, Bytes (key\0value),
 * Auffuellung auf 4. Kaputte Laengen beenden den Durchlauf (kein Wurf).
 */
export function parseKeyValue(
  buf: Buffer,
  littleEndian: boolean,
  maxEintraege = 64
): { eintraege: KvEintrag[]; problem: string | null; gekappt: boolean } {
  const eintraege: KvEintrag[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (eintraege.length >= maxEintraege) return { eintraege, problem: null, gekappt: true };
    if (pos + 4 > buf.length) return { eintraege, problem: `Key/Value-Eintrag bei ${pos} unvollstaendig (Laengenfeld).`, gekappt: false };
    const n = littleEndian ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
    if (n === 0 || pos + 4 + n > buf.length) {
      return { eintraege, problem: `Key/Value-Eintrag bei ${pos}: Laenge ${n} passt nicht in die verbleibenden ${buf.length - pos - 4} Bytes.`, gekappt: false };
    }
    const roh = buf.subarray(pos + 4, pos + 4 + n);
    const nul = roh.indexOf(0);
    if (nul < 0) {
      eintraege.push({ key: kuerze(roh.toString('utf8'), 80), value: '', value_bytes: 0 });
    } else {
      const wert = roh.subarray(nul + 1);
      eintraege.push({ key: kuerze(roh.subarray(0, nul).toString('utf8'), 80), value: wertAlsText(wert), value_bytes: wert.length });
    }
    pos += 4 + Math.ceil(n / 4) * 4;
  }
  return { eintraege, problem: null, gekappt: false };
}
