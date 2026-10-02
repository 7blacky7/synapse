/**
 * MODUL: Unreal-Lesehilfen
 * ZWECK: Gemeinsame Bausteine der Unreal-Inspektoren (uasset/umap, pak, IoStore):
 *        FString, vorzeichenbehaftete Ganzzahlen, FGuid und ein eigener Fehler fuer
 *        unplausible Strukturwerte.
 *
 * GRUNDSATZ: Jeder gelesene Laengen- oder Zaehlerwert wird gegen die vorhandenen Bytes und
 * eine vernuenftige Obergrenze geprueft, BEVOR etwas allokiert oder gelesen wird. Ein
 * unplausibler Wert ist ein Befund (UnrealFormatFehler mit Code), kein Absturz.
 */

import type { BinaryReader } from '../../binary-reader.js';

/** Unplausibler Strukturwert. Der Inspektor macht daraus eine Warnung mit genau diesem Code. */
export class UnrealFormatFehler extends Error {
  constructor(
    /** Stabiler Warnungscode, z. B. 'fstring_unplausibel'. */
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'UnrealFormatFehler';
  }
}

/** int32 little-endian. */
export function i32(r: BinaryReader): number {
  return r.u32le() | 0;
}

/** int64 little-endian als Zahl; ausserhalb des exakt darstellbaren Bereichs: UnrealFormatFehler. */
export function i64(r: BinaryReader, was: string): number {
  const pos = r.basisOffset + r.position;
  const v = BigInt.asIntN(64, r.u64le());
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new UnrealFormatFehler('zahl_unplausibel', `${was} bei Offset ${pos}: int64-Wert ${v} nicht exakt darstellbar`);
  }
  return Number(v);
}

/**
 * FString: int32 SaveNum zaehlt Zeichen INKLUSIVE Null-Terminator.
 *  - 0: leerer String
 *  - > 0: SaveNum Bytes (ANSI/Latin-1)
 *  - < 0: -SaveNum UTF-16LE-Zeichen
 * Ohne Terminator, ueber maxZeichen oder laenger als die restlichen Daten: UnrealFormatFehler.
 */
export function leseFString(r: BinaryReader, maxZeichen: number, was: string): string {
  const pos = r.basisOffset + r.position;
  const n = i32(r);
  if (n === 0) return '';
  // -2^31 laesst sich nicht negieren (Math.abs bliebe im int32-Sinn negativ): sofort unplausibel.
  if (n === -2147483648) {
    throw new UnrealFormatFehler('fstring_unplausibel', `${was} bei Offset ${pos}: FString-Laenge ${n} unmoeglich`);
  }
  const zeichen = Math.abs(n);
  if (zeichen > maxZeichen) {
    throw new UnrealFormatFehler('fstring_unplausibel', `${was} bei Offset ${pos}: FString-Laenge ${n} ueber Obergrenze ${maxZeichen}`);
  }
  const bytes = n > 0 ? zeichen : zeichen * 2;
  if (bytes > r.remaining) {
    throw new UnrealFormatFehler('fstring_unplausibel', `${was} bei Offset ${pos}: FString braucht ${bytes} Bytes, nur ${r.remaining} da`);
  }
  const roh = Buffer.from(r.bytes(bytes));
  const text = n > 0 ? roh.toString('latin1') : roh.toString('utf16le');
  if (!text.endsWith('\0')) {
    throw new UnrealFormatFehler('fstring_ohne_terminator', `${was} bei Offset ${pos}: FString ohne Null-Terminator`);
  }
  return text.slice(0, -1);
}

/** FGuid (4 x uint32 LE) als 32 Hex-Zeichen in der Unreal-Schreibweise %08X%08X%08X%08X. */
export function leseGuid(r: BinaryReader): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += r.u32le().toString(16).toUpperCase().padStart(8, '0');
  return s;
}

/** true, wenn ein Pfad aus seinem Bezugsverzeichnis herausfuehren kann ('..'-Segment oder absolut). */
export function hatTraversal(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return true;
  return p.split(/[\\/]/).some(seg => seg === '..');
}
