/**
 * MODUL: Asset-Intel Exe-Helfer
 * ZWECK: Gemeinsame Bausteine der PE- und ELF-Inspektoren: Warnungs-Sammler (je Code eine
 *        Warnung mit Zaehler), Phasen-Huelle (Lesefehler einer Phase sind eine Warnung, kein
 *        Totalausfall), C-String-/Entropie-Helfer.
 *
 * Boesartige Dateien sind der Normalfall: jede Phase (Sektionen, Importe, Symbole, ...)
 * laeuft isoliert, damit ein kaputter Verweis nur diese Phase kostet.
 */

import { AssetLimitError, AssetReadError } from '../../errors.js';
import type { AssetWarning } from '../../types.js';

/** Laengste Namenslaenge, die gelesen und gespeichert wird (DLL-/Funktions-/Symbolnamen). */
export const MAX_NAME = 256;

/** Sammelt Warnungen: je Code genau eine Warnung, mit Haeufigkeit im Text. */
export class WarnSammler {
  private readonly eintraege = new Map<string, { message: string; n: number }>();

  add(code: string, message: string): void {
    const e = this.eintraege.get(code);
    if (e) e.n++;
    else this.eintraege.set(code, { message, n: 1 });
  }

  /** Anzahl verschiedener Warnungscodes. */
  get anzahl(): number {
    return this.eintraege.size;
  }

  liste(): AssetWarning[] {
    return [...this.eintraege].map(([code, e]) => ({
      code,
      message: e.n > 1 ? `${e.message} (${e.n}x)` : e.message,
    }));
  }
}

/**
 * Fuehrt eine Phase aus. AssetReadError (Verweis ausserhalb der Datei, abgeschnitten) und
 * eine erschoepfte Lesegrenze werden zur Warnung; Zeit-/Tiefengrenzen laufen nach oben,
 * damit inspectAsset sie als Zeitueberschreitung melden kann.
 * @returns true, wenn die Phase ohne Fehler durchlief.
 */
export async function phase(name: string, w: WarnSammler, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    if (e instanceof AssetReadError) {
      w.add(`${name}_lesefehler`, `${name}: Datei abgeschnitten oder Verweis ausserhalb der Datei (${e.message})`);
      return false;
    }
    if (e instanceof AssetLimitError && e.grenze === 'maxReadBytes') {
      w.add('lesegrenze_ueberschritten', `${name}: Lesegrenze erreicht, Rest uebersprungen`);
      return false;
    }
    if (e instanceof AssetLimitError) throw e;
    w.add(`${name}_fehler`, `${name}: unerwarteter Fehler (${(e as Error)?.message ?? String(e)})`);
    return false;
  }
}

/** Steuerzeichen aus Namen entfernen (Namen stammen aus fremden Dateien). */
export function bereinige(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '?');
}

/**
 * Liest einen C-String aus buf ab start, hoechstens max Bytes. terminiert=false: kein 0-Byte
 * innerhalb des Fensters (Namen ohne Nullterminator oder gekappt). null: start ausserhalb.
 */
export function cstringAus(
  buf: Uint8Array,
  start: number,
  max: number = MAX_NAME
): { text: string; terminiert: boolean } | null {
  if (!Number.isSafeInteger(start) || start < 0 || start >= buf.length) return null;
  const ende = Math.min(buf.length, start + max);
  let i = start;
  while (i < ende && buf[i] !== 0) i++;
  return { text: bereinige(Buffer.from(buf.subarray(start, i)).toString('utf8')), terminiert: i < ende };
}

/** Shannon-Entropie in Bit pro Byte (0..8), auf 2 Stellen gerundet. */
export function entropie(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  const zaehler = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) zaehler[buf[i]]++;
  let h = 0;
  for (let i = 0; i < 256; i++) {
    if (zaehler[i] === 0) continue;
    const p = zaehler[i] / buf.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 100) / 100;
}

/** Bytes als Hex-String. */
export function hex(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('hex');
}

/** Unix-Sekunden als ISO-8601 UTC; 0 oder unbrauchbar -> null. */
export function isoAusSekunden(sek: number): string | null {
  if (!Number.isFinite(sek) || sek <= 0) return null;
  const d = new Date(sek * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Zahl als Hex-Text mit 0x-Praefix. */
export function hexZahl(n: number | bigint): string {
  return '0x' + n.toString(16);
}
