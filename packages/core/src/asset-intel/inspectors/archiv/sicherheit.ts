/**
 * MODUL: Archiv-Inspektoren — Sicherheit und Hilfsfunktionen
 * ZWECK: Gemeinsame Schutzfunktionen fuer ZIP/TAR/7z: Pfad-Gefahrenpruefung (Path Traversal),
 *        Bomben-Kriterien, CRC32, kleine Format-Helfer. Nichts hier schreibt oder oeffnet je einen
 *        Pfad aus einem Archiv — Namen sind reine DATEN und werden nur bewertet und angezeigt.
 *
 * GRUNDSATZ: Ein Archiv-Eintragsname ist Angreifer-Eingabe. Er wird nie zum Schreiben, Oeffnen
 * oder Aufloesen benutzt; hier wird nur geprueft, ob ein NAIVER Entpacker damit Schaden anrichten
 * koennte, und das als Flag + Warnung gemeldet.
 */

import { AssetLimitError, AssetReadError } from '../../errors.js';
import type { AssetWarning } from '../../types.js';

/**
 * Kompressionsfaktor (entpackt/gepackt), ab dem ein Archiv verdaechtig ist. Deflate erreicht
 * theoretisch nur ~1032:1, echte Daten liegen bei 1:1 bis ~10:1; ueber 250:1 ist es ungewoehnlich.
 * Gilt nur ab MIN_FAKTOR_BASIS entpackten Bytes (ein kleines Archiv mit Nullen ist keine Bombe).
 */
export const FAKTOR_GRENZE = 250;
/** Ab dieser DEKLARIERTEN Gesamtgroesse (64 MiB) greifen die Faktor-Kriterien. */
export const MIN_FAKTOR_BASIS = 64 * 1024 * 1024;
/** Absolute Grenze fuer die DEKLARIERTE Gesamtgroesse nach dem Entpacken (8 GiB). */
export const ABSOLUT_GRENZE_BYTES = 8 * 1024 * 1024 * 1024;
/** Absurde Eintragszahl (deklariert). */
export const MAX_EINTRAEGE_ABSURD = 1_000_000;
/** So viele Eintraege laufen hoechstens durch die Statistik/Ueberlappungspruefung. */
export const MAX_EINTRAEGE_LAUF = 250_000;
/** Nach einem Bombenverdacht werden nur noch so viele Eintraege als Objekte ausgegeben. */
export const OBJEKTE_BEI_BOMBE = 100;
/** Hoechstzahl Einzel-Warnungen je Code (danach eine Sammelwarnung). */
export const MAX_EINZELWARNUNGEN = 50;
/** Obere Haelfte (0x80-0xFF) des Zeichensatzes CP437: ZIP-Namen ohne UTF-8-Flag sind laut APPNOTE darin codiert. */
const CP437_OBEN =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Dekodiert Bytes als CP437 (ASCII-Teil unveraendert). */
export function cp437(buf: Uint8Array, start: number, ende: number): string {
  let s = '';
  for (let i = start; i < ende; i++) s += buf[i] < 0x80 ? String.fromCharCode(buf[i]) : CP437_OBEN[buf[i] - 0x80];
  return s;
}

/** Namen werden fuer die Ausgabe auf diese Laenge gekappt. */
export const MAX_NAME_ANZEIGE = 1024;

/** Endungen, die auf ein verschachteltes Archiv hindeuten. */
const ARCHIV_ENDUNGEN = [
  '.zip', '.jar', '.war', '.ear', '.apk', '.aar', '.7z', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.zst',
  '.rar', '.cab', '.iso', '.tbz2', '.txz', '.tzst', '.lz4', '.lzma', '.z', '.deb', '.rpm', '.xpi', '.nupkg',
];

/** Sammelt Warnungen; je Code werden nur MAX_EINZELWARNUNGEN einzeln gefuehrt, der Rest wird gezaehlt. */
export class Warnungen {
  readonly liste: AssetWarning[] = [];
  private readonly zaehler = new Map<string, number>();

  /** Fuegt eine Warnung hinzu (gekappt je Code). */
  add(code: string, message: string): void {
    const n = (this.zaehler.get(code) ?? 0) + 1;
    this.zaehler.set(code, n);
    if (n <= MAX_EINZELWARNUNGEN) this.liste.push({ code, message });
  }

  /** Einmalig je Code (z. B. Sammelhinweise). */
  einmal(code: string, message: string): void {
    if (!this.zaehler.has(code)) this.add(code, message);
  }

  has(code: string): boolean {
    return this.zaehler.has(code);
  }

  /** Haengt die Sammelwarnungen fuer gekappte Codes an und liefert die fertige Liste. */
  fertig(): AssetWarning[] {
    for (const [code, n] of this.zaehler) {
      if (n > MAX_EINZELWARNUNGEN) {
        this.liste.push({ code, message: `... insgesamt ${n} Meldungen dieser Art (${MAX_EINZELWARNUNGEN} einzeln aufgefuehrt).` });
      }
    }
    return this.liste;
  }
}

let crcTabelle: Uint32Array | null = null;

/** CRC32 (IEEE, wie ZIP/7z/gzip). zlib.crc32 gibt es erst ab neueren Node-Versionen, daher eigene Tabelle. */
export function crc32(buf: Uint8Array, start = 0, ende = buf.length): number {
  if (!crcTabelle) {
    crcTabelle = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTabelle[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < ende; i++) c = crcTabelle[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** u64 (bigint) als Zahl; ueber 2^53-1 wird geklemmt (Vergleichszwecke, nicht fuer Offsets). */
export function klemme(wert: bigint): number {
  return wert > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(wert);
}

/** Gefahrengruende eines Archivpfads. Leer = unauffaellig. */
export type PfadGefahr = 'null_byte' | 'absolut' | 'laufwerk' | 'unc' | 'traversal' | 'steuerzeichen';

/**
 * Bewertet einen Pfad aus einem Archiv. Es wird NICHTS aufgeloest oder geoeffnet.
 * Beide Trenner (/ und \) zaehlen, denn Windows-Entpacker behandeln \ als Trenner und
 * ein ZIP-Name wie "..\\..\\x" ist ein klassischer Traversal-Trick.
 */
export function pfadGefahr(name: string): PfadGefahr[] {
  const g: PfadGefahr[] = [];
  if (name.includes('\0')) g.push('null_byte');
  // eslint-disable-next-line no-control-regex
  else if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(name)) g.push('steuerzeichen');
  if (/^[\\/]{2}/.test(name)) g.push('unc');
  else if (/^[\\/]/.test(name)) g.push('absolut');
  if (/^[a-zA-Z]:/.test(name)) g.push('laufwerk');
  // Segmente an beiden Trennern; ".." (auch mit Leerzeichen/Punkten am Ende, die Windows verschluckt) gilt als Traversal.
  const segmente = name.split(/[\\/]+/);
  if (segmente.some(s => /^\.\.[ .]*$/.test(s))) g.push('traversal');
  return g;
}

/**
 * Normalisiert einen Pfad logisch (ohne Dateisystem) und sagt, ob er das Wurzelverzeichnis
 * verlaesst. Fuer Link-Ziele: "basis" ist das Verzeichnis des Eintrags im Archiv.
 */
export function verlaesstWurzel(basis: string, ziel: string): boolean {
  if (/^[\\/]/.test(ziel) || /^[a-zA-Z]:/.test(ziel) || ziel.includes('\0')) return true;
  const teile = [...basis.split(/[\\/]+/).filter(s => s !== '' && s !== '.'), ...ziel.split(/[\\/]+/)];
  const stapel: string[] = [];
  for (const s of teile) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (stapel.length === 0) return true;
      stapel.pop();
    } else stapel.push(s);
  }
  return false;
}

/** Name fuer die Ausgabe: Steuerzeichen sichtbar escapen, Laenge kappen. */
export function anzeigeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = name.replace(/[\x00-\x1f\x7f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return s.length > MAX_NAME_ANZEIGE ? s.slice(0, MAX_NAME_ANZEIGE) + '...' : s;
}

/** Deutet der Dateiname auf ein verschachteltes Archiv? */
export function istArchivEndung(name: string): boolean {
  const l = name.toLowerCase();
  return ARCHIV_ENDUNGEN.some(e => l.endsWith(e));
}

/** Erkennt ein Archiv-/Kompressionsformat an den ersten Bytes; null wenn keins. */
export function archivMagic(kopf: Uint8Array): string | null {
  const b = (...w: number[]): boolean => w.every((x, i) => kopf[i] === x);
  if (kopf.length >= 4 && b(0x50, 0x4b, 0x03, 0x04)) return 'zip';
  if (kopf.length >= 4 && b(0x50, 0x4b, 0x05, 0x06)) return 'zip';
  if (kopf.length >= 6 && b(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z';
  if (kopf.length >= 3 && b(0x1f, 0x8b, 0x08)) return 'gzip';
  if (kopf.length >= 4 && b(0x42, 0x5a, 0x68) && kopf[3] >= 0x31 && kopf[3] <= 0x39) return 'bzip2';
  if (kopf.length >= 6 && b(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz';
  if (kopf.length >= 4 && b(0x28, 0xb5, 0x2f, 0xfd)) return 'zstd';
  if (kopf.length >= 6 && b(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return 'rar';
  if (kopf.length >= 4 && b(0x7f, 0x45, 0x4c, 0x46)) return 'elf';
  return null;
}

/** Eine DOS-Datums-/Zeitangabe (ZIP) als ISO-String ohne Zeitzone (DOS kennt keine); null bei Unsinn. */
export function dosZeitIso(datum: number, zeit: number): string | null {
  const jahr = ((datum >> 9) & 127) + 1980;
  const monat = (datum >> 5) & 15;
  const tag = datum & 31;
  const h = zeit >> 11;
  const m = (zeit >> 5) & 63;
  const s = (zeit & 31) * 2;
  if (monat < 1 || monat > 12 || tag < 1 || tag > 31 || h > 23 || m > 59 || s > 59) return null;
  const p = (n: number, l = 2): string => String(n).padStart(l, '0');
  return `${p(jahr, 4)}-${p(monat)}-${p(tag)}T${p(h)}:${p(m)}:${p(s)}`;
}

/** Unix-Sekunden als ISO-UTC; null bei Unsinn. */
export function unixZeitIso(sekunden: number): string | null {
  if (!Number.isFinite(sekunden) || sekunden < 0 || sekunden > 253402300799) return null;
  return new Date(sekunden * 1000).toISOString();
}

/**
 * Faengt Fehler eines Inspektors ab, damit ein Teilergebnis erhalten bleibt. Die Zeitgrenze
 * (und andere harte Grenzen ausser maxReadBytes) wird weitergereicht — die faengt inspectAsset.
 */
export function faengFehler(e: unknown, w: Warnungen): void {
  if (e instanceof AssetLimitError) {
    if (e.grenze !== 'maxReadBytes') throw e;
    w.add('lesegrenze_ueberschritten', e.message);
  } else if (e instanceof AssetReadError) {
    w.add('lesefehler', `Datei abgeschnitten oder beschaedigt: ${e.message}`);
  } else {
    w.add('inspektor_fehler', `Inspektion nur teilweise moeglich: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** Eingabe fuer die Bomben-Pruefung. */
export interface BombeEingabe {
  /** Dateigroesse des Archivs. */
  dateigroesse: number;
  /** Laut Verzeichnis angegebene Eintragszahl. */
  deklarierteEintraege: number;
  /** Groesse des Verzeichnisses (Bytes) und kleinste Eintragsgroesse darin; 0 = nicht anwendbar. */
  verzeichnisBytes: number;
  minEintragBytes: number;
  /** Summe der deklarierten Groessen nach dem Entpacken / im Archiv. */
  unkomprimiert: number;
  komprimiert: number;
  /** Groesster Einzelfaktor (unkomprimiert/komprimiert) eines Eintrags mit komprimiert > 0. */
  maxEinzelFaktor: number;
  /** Anzahl Eintraege, deren Datenbereich in den eines anderen hineinragt (ueberlappende Eintraege). */
  ueberlappungen: number;
}

/** Gruende fuer 'archiv_bombe_verdacht'. Leer = unauffaellig. */
export function bombeGruende(e: BombeEingabe): string[] {
  const g: string[] = [];
  if (e.deklarierteEintraege > MAX_EINTRAEGE_ABSURD) g.push(`absurde_eintragszahl:${e.deklarierteEintraege}`);
  if (e.minEintragBytes > 0 && e.verzeichnisBytes > 0 && e.deklarierteEintraege * e.minEintragBytes > e.verzeichnisBytes + e.dateigroesse) {
    g.push(`eintragszahl_passt_nicht_zur_groesse:${e.deklarierteEintraege}`);
  }
  if (e.unkomprimiert > ABSOLUT_GRENZE_BYTES) g.push(`unkomprimiert_ueber_absoluter_grenze:${e.unkomprimiert}`);
  if (e.unkomprimiert >= MIN_FAKTOR_BASIS) {
    const faktor = e.komprimiert > 0 ? e.unkomprimiert / e.komprimiert : Infinity;
    if (faktor > FAKTOR_GRENZE) g.push(`gesamtfaktor:${Number.isFinite(faktor) ? Math.round(faktor) : 'unendlich'}`);
    if (e.maxEinzelFaktor > FAKTOR_GRENZE) g.push(`einzelfaktor:${Number.isFinite(e.maxEinzelFaktor) ? Math.round(e.maxEinzelFaktor) : 'unendlich'}`);
    if (e.unkomprimiert > e.dateigroesse * FAKTOR_GRENZE) g.push('unkomprimiert_ueber_dateigroesse_mal_faktor');
  }
  if (e.ueberlappungen > 0) g.push(`ueberlappende_eintraege:${e.ueberlappungen}`);
  return g;
}
