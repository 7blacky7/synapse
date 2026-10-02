/**
 * MODUL: Asset 3D Helfer
 * ZWECK: Gemeinsame Bausteine der 3D-Inspektoren (glTF/GLB, OBJ, STL, PLY, DAE):
 *        Ergebnis-Sammler mit Kappung, Lesebudget, Zeilenleser in Bloecken, Bounding-Box,
 *        Aufloesung von Datei-Referenzen ohne Path-Traversal.
 *
 * Alles hier liest nur ueber AssetSource.readRange und haelt die Grenzen aus ctx.limits ein.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AssetContext, AssetObject, AssetReference, AssetSource, AssetWarning } from '../../types.js';

/** Obergrenze fuer Textzeilen (Bytes): laengere Zeilen sind kein 3D-Text mehr. */
export const MAX_ZEILE_BYTES = 1024 * 1024;
/** Obergrenze fuer Bytes, die fuer Bounding-Boxen/Zaehler gelesen werden (Lesekappe). */
export const MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** So viele Warnungen je Code werden einzeln ausgegeben, der Rest wird gezaehlt. */
const MAX_WARN_JE_CODE = 5;

/** Kappt einen Text auf n Zeichen (fuer Namen/Ziele, die aus Dateien kommen). */
export function kappeText(s: string, n = 256): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Sammelt Objekte, Referenzen und Warnungen eines Inspektors und kappt bei ctx.limits.maxObjects.
 * `problem` wird true, sobald eine Warnung den Status 'teilweise' rechtfertigt.
 */
export class Sammler {
  readonly objects: AssetObject[] = [];
  readonly references: AssetReference[] = [];
  readonly warnings: AssetWarning[] = [];
  /** true, sobald eine nicht nur informative Warnung kam -> Status 'teilweise'. */
  problem = false;
  private readonly maxN: number;
  private readonly warnZaehler = new Map<string, number>();
  private readonly refSchluessel = new Set<string>();
  private objGekappt = false;
  private refGekappt = false;

  constructor(readonly ctx: AssetContext) {
    this.maxN = Math.max(0, Math.floor(ctx.limits.maxObjects));
  }

  /** Warnung, die das Ergebnis unvollstaendig oder unsicher macht (Status 'teilweise'). */
  warn(code: string, message: string): void {
    this.problem = true;
    this.schreibe(code, message);
  }

  /** Reine Information (z. B. externe Datei fehlt) — aendert den Status nicht. */
  info(code: string, message: string): void {
    this.schreibe(code, message);
  }

  private schreibe(code: string, message: string): void {
    const n = (this.warnZaehler.get(code) ?? 0) + 1;
    this.warnZaehler.set(code, n);
    if (n <= MAX_WARN_JE_CODE) this.warnings.push({ code, message: kappeText(message, 500) });
  }

  /** Fuegt ein Objekt hinzu; false (und einmalige Warnung), wenn maxObjects erreicht ist. */
  addObject(o: AssetObject): boolean {
    if (this.objects.length >= this.maxN) {
      if (!this.objGekappt) {
        this.objGekappt = true;
        this.warn('objekte_gekappt', `Objektgrenze ${this.maxN} erreicht; weitere Objekte werden nicht aufgefuehrt.`);
      }
      return false;
    }
    this.objects.push(o);
    return true;
  }

  /** Fuegt eine Referenz hinzu (gleiche Art+Ziel nur einmal); false bei Kappung. */
  addRef(r: AssetReference): boolean {
    const key = r.kind + '\u0000' + r.target;
    if (this.refSchluessel.has(key)) return true;
    if (this.references.length >= this.maxN) {
      if (!this.refGekappt) {
        this.refGekappt = true;
        this.warn('referenzen_gekappt', `Referenzgrenze ${this.maxN} erreicht; weitere Referenzen werden nicht aufgefuehrt.`);
      }
      return false;
    }
    this.refSchluessel.add(key);
    this.references.push(r);
    return true;
  }

  /** Haengt Sammelhinweise an, wenn Warnungen unterdrueckt wurden. Einmal am Ende aufrufen. */
  abschluss(): AssetWarning[] {
    for (const [code, n] of this.warnZaehler) {
      if (n > MAX_WARN_JE_CODE) {
        this.warnings.push({ code, message: `... und ${n - MAX_WARN_JE_CODE} weitere Warnungen dieser Art (insgesamt ${n}).` });
      }
    }
    return this.warnings;
  }
}

/** Zaehlt die Bytes, die ein Inspektor noch lesen darf (ctx.limits.maxReadBytes), und liest nie darueber hinaus. */
export class Lesebudget {
  rest: number;
  constructor(ctx: AssetContext) {
    this.rest = Math.max(0, Math.floor(ctx.limits.maxReadBytes));
  }

  /** Liest hoechstens length Bytes; wird das Budget knapp, kommt weniger zurueck (leer bei 0). */
  async lese(src: AssetSource, offset: number, length: number): Promise<Buffer> {
    const l = Math.min(length, this.rest);
    if (l <= 0) return Buffer.alloc(0);
    const b = await src.readRange(offset, l);
    this.rest -= b.length;
    return b;
  }
}

/** Achsenparallele Bounding-Box ueber beliebig viele Punkte; nicht endliche Werte werden gezaehlt, nicht verwendet. */
export class Bbox {
  readonly min = [Infinity, Infinity, Infinity];
  readonly max = [-Infinity, -Infinity, -Infinity];
  punkte = 0;
  ungueltig = 0;

  add(x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.ungueltig++;
      return;
    }
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
    this.punkte++;
  }

  /** Vereinigt mit einer fertigen Box (min/max je 3 Zahlen); false, wenn die Eingabe unbrauchbar ist. */
  addBox(mn: unknown, mx: unknown): boolean {
    if (!Array.isArray(mn) || !Array.isArray(mx) || mn.length < 3 || mx.length < 3) return false;
    for (let i = 0; i < 3; i++) {
      if (typeof mn[i] !== 'number' || typeof mx[i] !== 'number' || !Number.isFinite(mn[i]) || !Number.isFinite(mx[i])) return false;
    }
    this.add(mn[0] as number, mn[1] as number, mn[2] as number);
    this.add(mx[0] as number, mx[1] as number, mx[2] as number);
    return true;
  }

  get leer(): boolean {
    return this.punkte === 0;
  }

  /** Ausgabeform fuer metadata; null ohne Punkte. */
  alsObjekt(): { min: number[]; max: number[]; groesse: number[] } | null {
    if (this.leer) return null;
    return { min: [...this.min], max: [...this.max], groesse: this.max.map((m, i) => m - this.min[i]) };
  }
}

/** true, wenn die ersten Bytes nach Binaerdaten aussehen (NUL oder viele Steuerzeichen). */
export function sieheBinaerAus(kopf: Uint8Array): boolean {
  if (kopf.length === 0) return false;
  let steuer = 0;
  for (let i = 0; i < kopf.length; i++) {
    const b = kopf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) steuer++;
  }
  return steuer / kopf.length > 0.05;
}

/** Ergebnis von leseZeilen. */
export interface ZeilenErgebnis {
  /** Gelesene Bytes (ab start). */
  bytesGelesen: number;
  /** Anzahl verarbeiteter Zeilen (inkl. startZeile). */
  zeilen: number;
  /** true, wenn bis zum Dateiende gelesen wurde. */
  vollstaendig: boolean;
  grund: 'ende' | 'lesegrenze' | 'abbruch_callback' | 'zeile_zu_lang';
}

/**
 * Liest Textzeilen in Bloecken (nie die ganze Datei auf einmal). Zeilenende \n oder \r\n; BOM in
 * Zeile 1 wird entfernt. onZeile(zeile, nr) liefert false zum Abbrechen. maxBytes begrenzt zusaetzlich
 * zum Lesebudget die Menge ab start; eine unvollstaendige letzte Zeile am Ende einer Kappung faellt weg.
 */
export async function leseZeilen(
  src: AssetSource,
  ctx: AssetContext,
  budget: Lesebudget,
  onZeile: (zeile: string, nr: number) => boolean | void,
  opts: { start?: number; maxBytes?: number; blockBytes?: number; startZeile?: number } = {}
): Promise<ZeilenErgebnis> {
  const start = opts.start ?? 0;
  const block = opts.blockBytes ?? 256 * 1024;
  const grenze = Math.min(src.size, start + (opts.maxBytes ?? Number.MAX_SAFE_INTEGER));
  let pos = start;
  let nr = opts.startZeile ?? 0;
  let carry: Buffer = Buffer.alloc(0);
  let erstes = nr === 0;
  let grund: ZeilenErgebnis['grund'] = 'ende';

  const verarbeite = (buf: Buffer, von: number, ende: number): boolean => {
    let e = ende;
    if (e > von && buf[e - 1] === 13) e--;
    nr++;
    let zeile = buf.toString('utf8', von, e);
    if (erstes) {
      erstes = false;
      if (zeile.charCodeAt(0) === 0xfeff) zeile = zeile.slice(1);
    }
    return onZeile(zeile, nr) !== false;
  };

  while (pos < grenze) {
    ctx.pruefeAbbruch();
    const chunk = await budget.lese(src, pos, Math.min(block, grenze - pos));
    if (chunk.length === 0) {
      grund = 'lesegrenze';
      break;
    }
    pos += chunk.length;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let von = 0;
    for (;;) {
      const i = buf.indexOf(10, von);
      if (i < 0) break;
      if (!verarbeite(buf, von, i)) {
        return { bytesGelesen: pos - start, zeilen: nr, vollstaendig: false, grund: 'abbruch_callback' };
      }
      von = i + 1;
    }
    carry = buf.subarray(von);
    if (carry.length > MAX_ZEILE_BYTES) {
      return { bytesGelesen: pos - start, zeilen: nr, vollstaendig: false, grund: 'zeile_zu_lang' };
    }
  }
  const erreichtEnde = pos >= src.size;
  if (erreichtEnde && carry.length > 0) {
    if (!verarbeite(carry, 0, carry.length)) {
      return { bytesGelesen: pos - start, zeilen: nr, vollstaendig: false, grund: 'abbruch_callback' };
    }
  }
  if (!erreichtEnde && grund === 'ende') grund = 'lesegrenze';
  return { bytesGelesen: pos - start, zeilen: nr, vollstaendig: erreichtEnde, grund };
}

/** Dekodiert Prozent-Kodierung, ohne bei kaputten Sequenzen zu werfen. */
export function dekodiereUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Optionen von loeseReferenz. */
export interface ReferenzOptionen {
  /** true: Ziel ist eine URI (Prozent-Kodierung wird aufgeloest), false: einfacher Pfad. */
  uri?: boolean;
}

/**
 * Baut eine AssetReference und loest sie gegen das Dateisystem auf — relativ zum Ordner der Datei.
 * Ziele ausserhalb dieses Ordners (../, absolute Pfade) und Netz-URIs werden NICHT angefasst:
 * resolved bleibt false bzw. undefined, es gibt nur einen Hinweis. data:-URIs liefern null
 * (der Aufrufer vermerkt sie als eingebettet).
 */
export async function loeseReferenz(
  basisDatei: string,
  rohZiel: string,
  kind: string,
  s: Sammler,
  opts: ReferenzOptionen = {}
): Promise<AssetReference | null> {
  const ziel = rohZiel.trim();
  if (ziel === '') return null;
  if (/^data:/i.test(ziel)) return null;
  const anzeige = kappeText(ziel, 1024);

  // Netz- oder sonstige Schemata: nicht versuchen, nur melden.
  if (/^[a-z][a-z0-9+.-]+:/i.test(ziel) && !/^file:/i.test(ziel)) {
    return { target: anzeige, kind };
  }
  let rel = ziel.replace(/^file:\/\//i, '');
  if (opts.uri) rel = dekodiereUri(rel);
  rel = rel.replace(/\\/g, '/');
  if (rel.includes('\u0000')) {
    s.info('referenz_ausserhalb', `Referenz mit NUL-Byte nicht aufgeloest: ${kappeText(ziel, 80)}`);
    return { target: anzeige, kind, resolved: false };
  }
  if (path.isAbsolute(rel) || /^[a-zA-Z]:\//.test(rel)) {
    s.info('referenz_ausserhalb', `Absoluter Pfad nicht aufgeloest: ${kappeText(ziel, 120)}`);
    return { target: anzeige, kind, resolved: false };
  }
  const basis = path.dirname(path.resolve(basisDatei));
  const voll = path.resolve(basis, rel);
  const rr = path.relative(basis, voll);
  if (rr === '' || rr.startsWith('..') || path.isAbsolute(rr)) {
    s.info('referenz_ausserhalb', `Referenz verlaesst den Ordner der Datei und wird nicht aufgeloest: ${kappeText(ziel, 120)}`);
    return { target: anzeige, kind, resolved: false };
  }
  try {
    const st = await fs.promises.stat(voll);
    return { target: anzeige, kind, resolved: st.isFile() };
  } catch {
    s.info('referenz_nicht_gefunden', `Referenzierte Datei fehlt: ${kappeText(ziel, 120)}`);
    return { target: anzeige, kind, resolved: false };
  }
}

/** Kurzform: aufloesen + einsammeln. */
export async function sammleReferenz(
  basisDatei: string,
  rohZiel: string,
  kind: string,
  s: Sammler,
  opts: ReferenzOptionen = {}
): Promise<void> {
  const r = await loeseReferenz(basisDatei, rohZiel, kind, s, opts);
  if (r) s.addRef(r);
}

/** Kleinschrift-Endung einer Datei inklusive Punkt ('' ohne Endung). */
export function endungVon(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

/** Liest eine Zahl aus unbekanntem Wert; undefined, wenn keine endliche Zahl. */
export function zahl(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Ganze, nicht negative Zahl oder undefined. */
export function index(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}
