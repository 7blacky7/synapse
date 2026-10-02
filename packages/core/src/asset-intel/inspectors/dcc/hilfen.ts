/**
 * MODUL: DCC-Hilfen
 * ZWECK: Gemeinsame Bausteine der DCC-Inspektoren (Blender, FBX, USD-Familie):
 *  - BufferQuelle / AusschnittQuelle: AssetSource-kompatible Adapter (entpackter Inhalt,
 *    Bereich einer Zip-Datei), damit dieselben Leser auf Datei, Puffer und Paketeintrag laufen.
 *  - FensterLeser: gepufferte Lesungen, damit viele kleine Kopf-Lesungen nicht je einen
 *    Dateizugriff kosten (Lesebudget bleibt begrenzt).
 *  - Sammler: Objekte/Referenzen mit harter Kappe (maxObjects) und Warnung.
 *  - pruefeReferenz: Ziel gegen das Dateisystem pruefen (nur stat, nie oeffnen).
 *  - entpackeGzip / entpackeZstd: Entpacken mit Ausgabekappe.
 *
 * ZERO-DEPENDENCY: nur node:fs, node:path, node:zlib.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { AssetReadError } from '../../errors.js';
import type { AssetContext, AssetObject, AssetReference, AssetResult, AssetSource, AssetWarning } from '../../types.js';

/** AssetSource ueber einem Puffer im Speicher (z. B. entpackte .blend). Zaehlt kein Dateibudget. */
export class BufferQuelle implements AssetSource {
  readonly size: number;
  constructor(
    readonly filePath: string,
    private readonly buf: Buffer
  ) {
    this.size = buf.length;
  }

  async readRange(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new AssetReadError('ungueltiges_argument', `readRange(${offset}, ${length}): Argumente ungueltig`, 0, 0, 0);
    }
    if (offset >= this.size || length === 0) return Buffer.alloc(0);
    return this.buf.subarray(offset, Math.min(this.size, offset + length));
  }
}

/**
 * AssetSource auf einem Bereich einer anderen Quelle (z. B. ein gespeicherter Eintrag einer
 * Zip-Datei). Lesungen laufen ueber die Elternquelle und zaehlen deren Lesebudget.
 */
export class AusschnittQuelle implements AssetSource {
  constructor(
    readonly filePath: string,
    private readonly eltern: AssetSource,
    /** Absoluter Offset des Bereichs in der Elternquelle. */
    readonly basis: number,
    readonly size: number
  ) {}

  async readRange(offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new AssetReadError('ungueltiges_argument', `readRange(${offset}, ${length}): Argumente ungueltig`, 0, 0, 0);
    }
    if (offset >= this.size || length === 0) return Buffer.alloc(0);
    return this.eltern.readRange(this.basis + offset, Math.min(length, this.size - offset));
  }
}

/**
 * Gepufferter Leser: haelt ein Fenster der Quelle und bedient kleine Lesungen daraus.
 * Grosse Lesungen gehen direkt an die Quelle. Liefert am Dateiende kuerzere Puffer.
 */
export class FensterLeser {
  private fenster: Buffer = Buffer.alloc(0);
  private start = 0;
  constructor(
    readonly src: AssetSource,
    private readonly groesse = 16 * 1024
  ) {}

  get size(): number {
    return this.src.size;
  }

  /** Liest hoechstens length Bytes ab offset (am Ende kuerzer). */
  async lies(offset: number, length: number): Promise<Buffer> {
    if (length <= 0 || offset >= this.src.size) return Buffer.alloc(0);
    if (offset >= this.start && offset + length <= this.start + this.fenster.length) {
      return this.fenster.subarray(offset - this.start, offset - this.start + length);
    }
    if (length > this.groesse) return this.src.readRange(offset, length);
    this.fenster = await this.src.readRange(offset, Math.min(this.groesse, this.src.size - offset));
    this.start = offset;
    return this.fenster.subarray(0, Math.min(length, this.fenster.length));
  }

  /** Wie lies, aber genau length Bytes oder AssetReadError('abgeschnitten'). */
  async genau(offset: number, length: number): Promise<Buffer> {
    const b = await this.lies(offset, length);
    if (b.length < length) {
      throw new AssetReadError(
        'abgeschnitten',
        `Datei endet bei ${offset + b.length}, gebraucht wurden ${length} Bytes ab ${offset}`,
        offset,
        length,
        b.length
      );
    }
    return b;
  }
}

/** Sammelt Objekte und Referenzen mit Kappe; die erste Ueberschreitung erzeugt eine Warnung. */
export class Sammler {
  readonly objects: AssetObject[] = [];
  readonly references: AssetReference[] = [];
  readonly warnings: AssetWarning[] = [];
  objekteGekappt = 0;
  referenzenGekappt = 0;
  private readonly refSchluessel = new Set<string>();
  constructor(private readonly max: number) {}

  warn(code: string, message: string): void {
    // Gleiche Warnung nicht hundertfach (z. B. je Block): Code+Text einmalig.
    if (this.warnings.length >= 200) return;
    if (this.warnings.some(w => w.code === code && w.message === message)) return;
    this.warnings.push({ code, message });
  }

  objekt(o: AssetObject): boolean {
    if (this.objects.length >= this.max) {
      if (this.objekteGekappt++ === 0) this.warn('objekte_gekappt', `Mehr als ${this.max} Objekte; weitere werden nur gezaehlt.`);
      return false;
    }
    this.objects.push(o);
    return true;
  }

  /** Doppelte (gleiches Ziel + Art) werden zusammengefasst. */
  referenz(r: AssetReference): boolean {
    const k = r.kind + '\u0000' + r.target;
    if (this.refSchluessel.has(k)) return false;
    if (this.references.length >= this.max) {
      if (this.referenzenGekappt++ === 0) this.warn('referenzen_gekappt', `Mehr als ${this.max} Referenzen; weitere werden nur gezaehlt.`);
      return false;
    }
    this.refSchluessel.add(k);
    this.references.push(r);
    return true;
  }

  /** Uebertraegt Objekte, Referenzen und Warnungen ins Ergebnis; Kappe macht den Status 'teilweise'. */
  indErgebnis(res: AssetResult): void {
    res.objects = this.objects;
    res.references = this.references;
    for (const w of this.warnings) res.warnings.push(w);
    if ((this.objekteGekappt > 0 || this.referenzenGekappt > 0) && res.status === 'ok') res.status = 'teilweise';
  }
}

/** Prueft, ob ein Dateipfad existiert. Nur stat, nie oeffnen. */
export type Aufloeser = (ziel: string) => Promise<boolean | undefined>;

/** Zaehler, damit ein Asset mit Millionen Verweisen nicht Millionen stat-Aufrufe ausloest. */
export interface AufloeseBudget {
  rest: number;
}

const URI = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Loest ein Referenzziel relativ zu basisDir gegen das Dateisystem auf.
 * Ergebnis: true/false = geprueft; undefined = nicht geprueft (URI, leer, Budget erschoepft).
 * traversal = Ziel liegt ausserhalb von basisDir (nur gemeldet, nichts wird geoeffnet).
 */
export async function pruefeReferenz(
  basisDir: string,
  ziel: string,
  budget: AufloeseBudget
): Promise<{ resolved: boolean | undefined; traversal: boolean; absolut: string | null }> {
  const roh = ziel.trim();
  if (!roh || URI.test(roh)) return { resolved: undefined, traversal: false, absolut: null };
  const norm = roh.replace(/\\/g, '/');
  // Windows-Laufwerkspfad auf einem anderen System: nicht pruefbar.
  if (/^[a-zA-Z]:\//.test(norm) && process.platform !== 'win32') return { resolved: false, traversal: false, absolut: norm };
  const abs = path.isAbsolute(norm) ? path.normalize(norm) : path.resolve(basisDir, norm);
  const rel = path.relative(basisDir, abs);
  const traversal = !path.isAbsolute(norm) && (rel.startsWith('..') || path.isAbsolute(rel));
  if (budget.rest <= 0) return { resolved: undefined, traversal, absolut: abs };
  budget.rest--;
  try {
    const st = await fs.promises.stat(abs);
    return { resolved: st.isFile(), traversal, absolut: abs };
  } catch {
    return { resolved: false, traversal, absolut: abs };
  }
}

/** Typen fuer die zstd-Funktionen, die erst ab Node 22.15/23.8 existieren. */
type ZstdSync = (buf: Buffer, opts?: { maxOutputLength?: number }) => Buffer;

/** true, wenn diese Node-Version zstd entpacken kann. */
export function zstdVerfuegbar(): boolean {
  return typeof (zlib as unknown as { zstdDecompressSync?: ZstdSync }).zstdDecompressSync === 'function';
}

/** Ergebnis eines gedeckelten Entpackens. */
export interface Entpackt {
  daten: Buffer;
  /** true = Ausgabe an der Kappe abgeschnitten oder Eingabe unvollstaendig. */
  unvollstaendig: boolean;
  /** Klartext, falls unvollstaendig. */
  grund: string | null;
  /** Anzahl zstd-Frames (nur zstd). */
  frames?: number;
}

/** gzip entpacken, hoechstens kappe Bytes; abgeschnittene Eingabe liefert den lesbaren Anfang. */
export function entpackeGzip(eingabe: Buffer, kappe: number): Promise<Entpackt> {
  return new Promise(resolve => {
    const teile: Buffer[] = [];
    let n = 0;
    let fertig = false;
    const z = zlib.createGunzip();
    const ende = (unvollstaendig: boolean, grund: string | null): void => {
      if (fertig) return;
      fertig = true;
      z.removeAllListeners('data');
      z.destroy();
      resolve({ daten: Buffer.concat(teile).subarray(0, Math.min(n, kappe)), unvollstaendig, grund });
    };
    z.on('data', (c: Buffer) => {
      teile.push(c);
      n += c.length;
      if (n > kappe) ende(true, `entpackt mehr als ${kappe} Bytes (Kappe)`);
    });
    z.on('error', (e: Error) => ende(true, `gzip-Fehler: ${e.message}`));
    z.on('end', () => ende(false, null));
    z.end(eingabe);
  });
}

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * zstd entpacken, Frame fuer Frame. Noetig, weil Blender (ab 3.0) MEHRERE Frames plus eine
 * Seek-Table (skippable Frame) schreibt und zstdDecompressSync nur den ersten Frame liefert
 * (gemessen mit Node 25 an einer Blender-5.1-Datei: 67137 von 537934 Bytes).
 */
export function entpackeZstd(eingabe: Buffer, kappe: number, pruefe: () => void): Entpackt {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdSync }).zstdDecompressSync;
  if (typeof fn !== 'function') return { daten: Buffer.alloc(0), unvollstaendig: true, grund: 'zstd in dieser Node-Version nicht verfuegbar', frames: 0 };
  const teile: Buffer[] = [];
  let n = 0;
  let p = 0;
  let frames = 0;
  const fertig = (unvollstaendig: boolean, grund: string | null): Entpackt => ({
    daten: Buffer.concat(teile).subarray(0, Math.min(n, kappe)),
    unvollstaendig,
    grund,
    frames,
  });
  while (p < eingabe.length) {
    pruefe();
    if (p + 8 > eingabe.length) return fertig(true, `Rest von ${eingabe.length - p} Bytes ist kein vollstaendiger Frame`);
    const magic = eingabe.readUInt32LE(p);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // Skippable Frame (z. B. Blenders Seek-Table): Magic + u32 Laenge + Inhalt.
      const len = eingabe.readUInt32LE(p + 4);
      p += 8 + len;
      continue;
    }
    if (magic !== ZSTD_MAGIC) return fertig(true, `kein zstd-Frame bei Offset ${p}`);
    const laenge = zstdFrameLaenge(eingabe, p);
    if (laenge === null) return fertig(true, `zstd-Frame bei Offset ${p} abgeschnitten oder ungueltig`);
    let teil: Buffer;
    try {
      teil = fn(eingabe.subarray(p, p + laenge), { maxOutputLength: Math.max(1, kappe - n + 1) });
    } catch (e) {
      return fertig(true, `zstd-Frame bei Offset ${p}: ${(e as Error).message}`);
    }
    frames++;
    teile.push(teil);
    n += teil.length;
    if (n > kappe) return fertig(true, `entpackt mehr als ${kappe} Bytes (Kappe)`);
    p += laenge;
  }
  return fertig(false, null);
}

/** Laenge eines zstd-Frames ab p (Kopf + Bloecke + optionale Pruefsumme) oder null. */
function zstdFrameLaenge(b: Buffer, p: number): number | null {
  let q = p + 4;
  if (q >= b.length) return null;
  const fhd = b[q++];
  const fcsFlag = fhd >> 6;
  const single = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!single) q += 1;
  q += [0, 1, 2, 4][dictFlag];
  q += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  for (;;) {
    if (q + 3 > b.length) return null;
    const kopf = b[q] | (b[q + 1] << 8) | (b[q + 2] << 16);
    q += 3;
    const letzter = kopf & 1;
    const typ = (kopf >> 1) & 3;
    const groesse = kopf >>> 3;
    if (typ === 3) return null;
    q += typ === 1 ? 1 : groesse;
    if (q > b.length) return null;
    if (letzter) break;
  }
  if (checksum) q += 4;
  return q > b.length ? null : q - p;
}

/** Ruft pruefeAbbruch nur jedes n-te Mal (billig in engen Schleifen). */
export function abbruchTakt(ctx: AssetContext, n = 512): () => void {
  let i = 0;
  return () => {
    if (++i % n === 0) ctx.pruefeAbbruch();
  };
}

/** Kuerzt Text fuer Metadaten (nie unbegrenzt in die Datenbank). */
export function kurz(s: string, max = 512): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Dateiendung ist eine typische Bild-/Texturdatei. */
export function istBildPfad(p: string): boolean {
  return /\.(png|jpe?g|tga|tif|tiff|exr|hdr|bmp|dds|ktx2?|webp|gif|psd|tx|tex)$/i.test(p.split(/[?#]/)[0]);
}
