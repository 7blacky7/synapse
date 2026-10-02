/**
 * MODUL: Asset-Intel Binary Reader
 * ZWECK: Begrenzter Lesezugriff auf Bytes mit Bounds-Check. Jeder Zugriff ausserhalb der
 *        Daten wirft AssetReadError — nie einen RangeError aus DataView/Buffer.
 *
 * u64 liefert bigint (Zahlen ueber 2^53 sind in Binaerformaten normal, ein stilles
 * Runden waere ein falscher Messwert). u64leZahl/u64beZahl sind die Kurzform fuer
 * Laengen und Offsets und werfen, wenn der Wert nicht exakt darstellbar ist.
 */

import { AssetReadError } from './errors.js';
import type { AssetSource } from './types.js';

export class BinaryReader {
  private readonly view: DataView;
  private pos = 0;

  /**
   * @param buf Die Daten (werden nicht kopiert).
   * @param basisOffset Absoluter Dateioffset des ersten Bytes — nur fuer genaue Fehlermeldungen.
   */
  constructor(
    private readonly buf: Uint8Array,
    readonly basisOffset = 0
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Anzahl Bytes insgesamt. */
  get length(): number {
    return this.buf.byteLength;
  }

  /** Aktuelle Position relativ zum Anfang der Daten. */
  get position(): number {
    return this.pos;
  }

  /** Noch lesbare Bytes. */
  get remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  /** Springt auf eine absolute Position innerhalb der Daten (0..length). */
  seek(pos: number): void {
    if (!Number.isSafeInteger(pos) || pos < 0 || pos > this.buf.byteLength) {
      throw new AssetReadError(
        pos >= 0 && Number.isSafeInteger(pos) ? 'ausserhalb' : 'ungueltiges_argument',
        `seek(${pos}) ausserhalb der Daten (Laenge ${this.buf.byteLength})`,
        this.basisOffset + (Number.isFinite(pos) ? pos : 0),
        0,
        0
      );
    }
    this.pos = pos;
  }

  /** Ueberspringt n Bytes. */
  skip(n: number): void {
    this.nimm(n, 'skip');
  }

  u8(): number {
    return this.view.getUint8(this.nimm(1, 'u8'));
  }
  u16le(): number {
    return this.view.getUint16(this.nimm(2, 'u16le'), true);
  }
  u16be(): number {
    return this.view.getUint16(this.nimm(2, 'u16be'), false);
  }
  u32le(): number {
    return this.view.getUint32(this.nimm(4, 'u32le'), true);
  }
  u32be(): number {
    return this.view.getUint32(this.nimm(4, 'u32be'), false);
  }
  u64le(): bigint {
    return this.view.getBigUint64(this.nimm(8, 'u64le'), true);
  }
  u64be(): bigint {
    return this.view.getBigUint64(this.nimm(8, 'u64be'), false);
  }

  /** u64 little-endian als Zahl; wirft AssetReadError('zahl_zu_gross') ueber 2^53-1. */
  u64leZahl(): number {
    return this.alsZahl(this.u64le(), 8);
  }

  /** u64 big-endian als Zahl; wirft AssetReadError('zahl_zu_gross') ueber 2^53-1. */
  u64beZahl(): number {
    return this.alsZahl(this.u64be(), 8);
  }

  /** n Bytes als Sicht auf die Daten (keine Kopie). */
  bytes(n: number): Uint8Array {
    const start = this.nimm(n, 'bytes');
    return this.buf.subarray(start, start + n);
  }

  /**
   * Liest einen mit 0 abgeschlossenen UTF-8-String. Ohne Abschluss-Byte innerhalb von
   * maxLen (bzw. der restlichen Daten): AssetReadError('cstring_unterminiert').
   * Das Abschluss-Byte wird verbraucht, gehoert aber nicht zum Ergebnis.
   */
  cstring(maxLen?: number): string {
    if (maxLen !== undefined && (!Number.isSafeInteger(maxLen) || maxLen < 0)) {
      throw new AssetReadError('ungueltiges_argument', `cstring(${maxLen}): maxLen ungueltig`, this.basisOffset + this.pos, 0, this.remaining);
    }
    const ende = maxLen === undefined ? this.buf.byteLength : Math.min(this.buf.byteLength, this.pos + maxLen);
    for (let i = this.pos; i < ende; i++) {
      if (this.buf[i] === 0) {
        const text = Buffer.from(this.buf.subarray(this.pos, i)).toString('utf8');
        this.pos = i + 1;
        return text;
      }
    }
    throw new AssetReadError(
      'cstring_unterminiert',
      `cstring ab Offset ${this.basisOffset + this.pos} ohne Abschluss-Byte in ${ende - this.pos} Bytes`,
      this.basisOffset + this.pos,
      0,
      this.remaining
    );
  }

  /** Prueft n Bytes und rueckt vor; liefert die Startposition. */
  private nimm(n: number, was: string): number {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new AssetReadError('ungueltiges_argument', `${was}(${n}): Anzahl ungueltig`, this.basisOffset + this.pos, 0, this.remaining);
    }
    if (n > this.remaining) {
      throw new AssetReadError(
        'ausserhalb',
        `${was}: ${n} Bytes ab Offset ${this.basisOffset + this.pos} gebraucht, nur ${this.remaining} da`,
        this.basisOffset + this.pos,
        n,
        this.remaining
      );
    }
    const start = this.pos;
    this.pos += n;
    return start;
  }

  private alsZahl(wert: bigint, n: number): number {
    if (wert > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AssetReadError('zahl_zu_gross', `u64-Wert ${wert} nicht exakt als Zahl darstellbar`, this.basisOffset + this.pos - n, n, 0);
    }
    return Number(wert);
  }
}

/**
 * Liest GENAU length Bytes ab offset aus der Quelle und liefert einen Reader darauf.
 * Kommen weniger Bytes zurueck (Datei abgeschnitten): AssetReadError('abgeschnitten').
 */
export async function leseReader(src: AssetSource, offset: number, length: number): Promise<BinaryReader> {
  const buf = await src.readRange(offset, length);
  if (buf.length < length) {
    throw new AssetReadError(
      'abgeschnitten',
      `Datei endet bei ${offset + buf.length}, gebraucht wurden ${length} Bytes ab ${offset}`,
      offset,
      length,
      buf.length
    );
  }
  return new BinaryReader(buf, offset);
}
