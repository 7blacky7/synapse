/**
 * MODUL: DCC FBX-Inspektor
 * ZWECK: Liest FBX (binaer und ASCII) ohne das FBX-SDK: Knotenbaum mit Tiefen- und Anzahlkappe,
 *        Kopfdaten (Creator, Erstellzeit, Version), GlobalSettings (Achsen, Einheit), Objekte
 *        (Model/Geometry/Material/Texture/Video/AnimationStack/Deformer/Pose ...) mit Namen,
 *        Zaehler je Art, Verbindungen, Textur-/Video-Dateien als Referenzen und Geometrie-Zahlen
 *        (Vertices = Arraylaenge/3) — Array-INHALTE werden nie entpackt oder geladen.
 *
 * BINAER (Spezifikation, Blender-Export gemessen): Magic 'Kaydara FBX Binary  \0\x1a\0' + u32
 * Version; Knotenkopf ab 7500 mit u64-Feldern (25 Byte), davor u32 (13 Byte); Listenende =
 * Null-Record. Eigenschaften Y/C/I/F/D/L, Arrays f/d/l/i/b (Laenge, Kodierung, komprimierte
 * Laenge), S/R (Laenge + Bytes).
 * ASCII: begrenzter Zeilenscanner; Arrays '*N { a: ... }' (7.x) bzw. Kommazaehlung (6.x).
 */

import * as path from 'path';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetResult, AssetSource, AssetSourceRange } from '../../types.js';
import { AssetReadError } from '../../errors.js';
import { FensterLeser, Sammler, abbruchTakt, kurz, pruefeReferenz } from './hilfen.js';
import type { AufloeseBudget } from './hilfen.js';

const VERSION = 1;
const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
const BINAER_MAGIC = [...ASCII('Kaydara FBX Binary  '), 0x00, 0x1a, 0x00];

/** Hoechste Knotentiefe (echte Dateien: < 10). */
const MAX_TIEFE = 64;
/** Hoechstzahl besuchter Knoten. */
const MAX_KNOTEN = 2_000_000;
/** Gespeicherte Eigenschaften je Knoten (P-Knoten haben ~7). */
const MAX_PROPS = 16;
/** Laengste gelesene Zeichenkette (Rest wird abgeschnitten). */
const MAX_STRING = 1024;
/** Laengste gehaltene ASCII-Zeile. */
const MAX_ZEILE = 8192;

/** Ein Array-Eigenschaftswert: nur Kopfdaten, nie der Inhalt. */
interface FbxArray {
  array: string;
  laenge: number;
  kodierung: number;
  bytes: number;
}
type FbxWert = string | number | boolean | FbxArray | { roh: number };

const istArray = (w: FbxWert | undefined): w is FbxArray => typeof w === 'object' && w !== null && 'array' in w;

const GLOBAL_FELDER = new Set([
  'UpAxis', 'UpAxisSign', 'FrontAxis', 'FrontAxisSign', 'CoordAxis', 'CoordAxisSign',
  'OriginalUpAxis', 'OriginalUpAxisSign', 'UnitScaleFactor', 'OriginalUnitScaleFactor',
  'TimeMode', 'CustomFrameRate', 'TimeSpanStart', 'TimeSpanStop',
]);
const TRANSFORM_FELDER: Record<string, string> = {
  'Lcl Translation': 'translation',
  'Lcl Rotation': 'rotation',
  'Lcl Scaling': 'skalierung',
};

/** Gemeinsamer Besucher fuer Binaer und ASCII: sammelt die Kerndaten. */
class FbxAuswertung {
  readonly meta: Record<string, unknown> = {};
  readonly global: Record<string, unknown> = {};
  readonly zeitstempel: Record<string, number> = {};
  readonly zaehler: Record<string, number> = {};
  verbindungen = 0;
  takes = 0;
  knoten = 0;
  private aktuell: { obj: AssetObject; art: string } | null = null;
  readonly dateiObjekte: AssetObject[] = [];
  /** 6.x-ASCII: laufende Kommazaehlung einer Array-Zeile. */
  offenesArray: { data: Record<string, unknown>; feld: string; teiler: number; werte: number } | null = null;

  constructor(private readonly s: Sammler) {}

  besuche(pfad: string[], name: string, props: FbxWert[], bereich: AssetSourceRange): AssetObject | null {
    this.knoten++;
    const tiefe = pfad.length;
    if (tiefe === 0) {
      if (name === 'Creator' && typeof props[0] === 'string') this.meta.creator = kurz(props[0]);
      else if (name === 'CreationTime' && typeof props[0] === 'string') this.meta.erstellt = props[0];
      return null;
    }
    const p0 = pfad[0];
    if (p0 === 'FBXHeaderExtension') {
      if (tiefe === 1 && name === 'Creator' && typeof props[0] === 'string') this.meta.creator ??= kurz(props[0]);
      else if (tiefe === 1 && name === 'FBXVersion' && typeof props[0] === 'number') this.meta.fbx_version_kopf = props[0];
      else if (tiefe === 2 && pfad[1] === 'CreationTimeStamp' && typeof props[0] === 'number' && name !== 'Version') {
        this.zeitstempel[name] = props[0];
      }
      return null;
    }
    if (p0 === 'GlobalSettings' && tiefe === 2 && pfad[1] === 'Properties70' && (name === 'P' || name === 'Property')) {
      const k = props[0];
      if (typeof k === 'string' && GLOBAL_FELDER.has(k)) this.global[k] = props[props.length - 1];
      return null;
    }
    if (p0 === 'Connections' && tiefe === 1 && (name === 'C' || name === 'Connect')) {
      this.verbindungen++;
      return null;
    }
    if (p0 === 'Takes' && tiefe === 1 && name === 'Take') {
      this.takes++;
      return null;
    }
    if (p0 !== 'Objects') return null;
    if (tiefe === 1) {
      const art = name.toLowerCase();
      this.zaehler[art] = (this.zaehler[art] ?? 0) + 1;
      const { objName, klasse, typ, id } = objektName(props);
      const data: Record<string, unknown> = {};
      if (klasse) data.klasse = klasse;
      if (typ) data.typ = typ;
      if (id !== undefined) data.id = id;
      const obj: AssetObject = { name: objName, kind: art, data, source_range: bereich };
      this.aktuell = this.s.objekt(obj) ? { obj, art } : null;
      if (this.aktuell && (art === 'texture' || art === 'video')) this.dateiObjekte.push(obj);
      return this.aktuell ? obj : null;
    }
    const akt = this.aktuell;
    if (!akt) return null;
    const data = akt.obj.data;
    if (tiefe === 2) {
      const w = props[0];
      if (name === 'Vertices') {
        if (istArray(w)) data.vertices = Math.floor(w.laenge / 3);
        else this.offenesArray = { data, feld: 'vertices', teiler: 3, werte: 0 };
      } else if (name === 'PolygonVertexIndex') {
        if (istArray(w)) data.polygon_indizes = w.laenge;
        else this.offenesArray = { data, feld: 'polygon_indizes', teiler: 1, werte: 0 };
      } else if ((name === 'FileName' || name === 'Filename') && typeof w === 'string') data.dateiname = w;
      else if ((name === 'RelativeFilename' || name === 'RelativeFileName') && typeof w === 'string') data.relativ = w;
      else if (name === 'Content' && typeof w === 'object' && w && 'roh' in w) data.eingebettet_bytes = w.roh;
    } else if (tiefe === 3 && pfad[2] === 'Properties70' && name === 'P') {
      const k = props[0];
      if (typeof k === 'string' && TRANSFORM_FELDER[k]) {
        const werte = props.slice(4, 7).filter((x): x is number => typeof x === 'number');
        if (werte.length === 3) data[TRANSFORM_FELDER[k]] = werte;
      }
    }
    return null;
  }

  /** Kennzeichnet unplausible Arrays (z. B. Laenge 4e9 bei 20 Byte komprimiert). */
  arrayWarnung(name: string, a: FbxArray, offset: number): void {
    this.s.warn('array_unplausibel', `Array "${name}" bei ${offset}: Laenge ${a.laenge} passt nicht zu ${a.bytes} Bytes (Kodierung ${a.kodierung}).`);
  }
}

/** Objektname aus den Eigenschaften: binaer 'Name\0\x01Klasse', ASCII 'Klasse::Name'. */
function objektName(props: FbxWert[]): { objName: string | null; klasse: string | null; typ: string | null; id: number | undefined } {
  const id = typeof props[0] === 'number' ? props[0] : undefined;
  const iName = props.findIndex(p => typeof p === 'string');
  if (iName < 0) return { objName: null, klasse: null, typ: null, id };
  const roh = props[iName] as string;
  const typRoh = props[iName + 1];
  const typ = typeof typRoh === 'string' && typRoh ? typRoh : null;
  const bin = roh.indexOf('\u0000\u0001');
  if (bin >= 0) return { objName: roh.slice(0, bin), klasse: roh.slice(bin + 2) || null, typ, id };
  const asc = roh.indexOf('::');
  if (asc >= 0) return { objName: roh.slice(asc + 2), klasse: roh.slice(0, asc) || null, typ, id };
  return { objName: roh, klasse: null, typ, id };
}

/** Binaeren Knotenbaum ablaufen. */
async function binaerBaum(f: FensterLeser, version: number, a: FbxAuswertung, s: Sammler, ctx: AssetContext): Promise<boolean> {
  const breit = version >= 7500;
  const hs = breit ? 25 : 13;
  const takt = abbruchTakt(ctx, 256);
  let intakt = true;
  const nummer = (b: Buffer, o: number): number => {
    if (!breit) return b.readUInt32LE(o);
    const v = b.readBigUInt64LE(o);
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
  };

  const props = async (start: number, ende: number, anzahl: number, name: string): Promise<FbxWert[]> => {
    const out: FbxWert[] = [];
    let q = start;
    for (let i = 0; i < anzahl && i < MAX_PROPS && q < ende; i++) {
      const t = String.fromCharCode((await f.genau(q, 1))[0]);
      q += 1;
      const fest: Record<string, number> = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };
      if (t in fest) {
        const n = fest[t];
        if (q + n > ende) throw new Error(`Eigenschaft "${t}" ragt ueber das Knotenende`);
        const b = await f.genau(q, n);
        if (t === 'Y') out.push(b.readInt16LE(0));
        else if (t === 'C') out.push(b[0] !== 0);
        else if (t === 'I') out.push(b.readInt32LE(0));
        else if (t === 'F') out.push(b.readFloatLE(0));
        else if (t === 'D') out.push(b.readDoubleLE(0));
        else {
          const v = b.readBigInt64LE(0);
          out.push(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());
        }
        q += n;
      } else if ('fdlib'.includes(t)) {
        if (q + 12 > ende) throw new Error(`Array-Kopf "${t}" ragt ueber das Knotenende`);
        const b = await f.genau(q, 12);
        const laenge = b.readUInt32LE(0);
        const kodierung = b.readUInt32LE(4);
        const clen = b.readUInt32LE(8);
        const elem = t === 'd' || t === 'l' ? 8 : t === 'b' ? 1 : 4;
        const bytes = kodierung === 0 ? laenge * elem : clen;
        const arr: FbxArray = { array: t, laenge, kodierung, bytes };
        if (q + 12 + bytes > ende) throw new Error(`Array "${name}" (${bytes} Bytes) ragt ueber das Knotenende`);
        if (kodierung === 1 && laenge * elem > clen * 1100 + 1024) a.arrayWarnung(name, arr, q - 1);
        if (kodierung > 1) s.warn('array_kodierung_unbekannt', `Array "${name}" bei ${q - 1}: Kodierung ${kodierung}.`);
        out.push(arr);
        q += 12 + bytes;
      } else if (t === 'S' || t === 'R') {
        if (q + 4 > ende) throw new Error(`Laenge von "${t}" ragt ueber das Knotenende`);
        const len = (await f.genau(q, 4)).readUInt32LE(0);
        if (q + 4 + len > ende) throw new Error(`"${t}" mit ${len} Bytes ragt ueber das Knotenende`);
        if (t === 'S') out.push((await f.genau(q + 4, Math.min(len, MAX_STRING))).toString('utf8'));
        else out.push({ roh: len });
        q += 4 + len;
      } else {
        throw new Error(`unbekannter Eigenschaftstyp 0x${t.charCodeAt(0).toString(16)}`);
      }
    }
    return out;
  };

  const liste = async (start: number, ende: number, pfad: string[]): Promise<void> => {
    let p = start;
    while (p + hs <= ende) {
      takt();
      const h = await f.genau(p, hs);
      const endOffset = nummer(h, 0);
      const anzahl = nummer(h, breit ? 8 : 4);
      const propLen = nummer(h, breit ? 16 : 8);
      const nameLen = h[hs - 1];
      if (endOffset === 0 && anzahl === 0 && propLen === 0 && nameLen === 0) return; // Null-Record
      if (endOffset <= p || endOffset > ende) {
        s.warn('knoten_ausserhalb', `Knoten bei ${p} endet bei ${endOffset}, erlaubt bis ${ende} — Baum ab hier nicht gelesen.`);
        intakt = false;
        return;
      }
      const name = (await f.genau(p + hs, nameLen)).toString('latin1');
      const propStart = p + hs + nameLen;
      const propEnde = propStart + propLen;
      if (propEnde > endOffset) {
        s.warn('knoten_ausserhalb', `Eigenschaften von "${name}" bei ${p} ragen ueber das Knotenende.`);
        intakt = false;
        return;
      }
      if (a.knoten >= MAX_KNOTEN) {
        s.warn('knoten_gekappt', `Mehr als ${MAX_KNOTEN} Knoten; Rest nicht gelesen.`);
        intakt = false;
        return;
      }
      let werte: FbxWert[];
      try {
        werte = await props(propStart, propEnde, anzahl, name);
      } catch (e) {
        if (!(e instanceof Error) || e.name === 'AssetLimitError' || e instanceof AssetReadError) throw e;
        s.warn('eigenschaft_ungueltig', `Knoten "${name}" bei ${p}: ${e.message}`);
        intakt = false;
        werte = [];
      }
      a.besuche(pfad, name, werte, { offset: p, length: endOffset - p });
      if (propEnde < endOffset) {
        if (pfad.length + 1 >= MAX_TIEFE) {
          s.warn('tiefengrenze', `Knoten "${name}" bei ${p}: Verschachtelung tiefer als ${MAX_TIEFE}; Kinder nicht gelesen.`);
          intakt = false;
        } else {
          await liste(propEnde, endOffset, [...pfad, name]);
          if (a.knoten >= MAX_KNOTEN) return;
        }
      }
      p = endOffset;
    }
  };
  try {
    await liste(27, f.size, []);
  } catch (e) {
    if (!(e instanceof AssetReadError)) throw e;
    s.warn('abgeschnitten', `Datei endet mitten im Knotenbaum: ${e.message}`);
    intakt = false;
  }
  return intakt;
}

/** Zerlegt den Wertteil einer ASCII-Zeile an Kommas ausserhalb von Anfuehrungszeichen. */
function asciiWerte(rest: string): FbxWert[] {
  const out: FbxWert[] = [];
  let i = 0;
  while (i < rest.length && out.length < MAX_PROPS) {
    while (rest[i] === ' ' || rest[i] === '\t') i++;
    if (i >= rest.length) break;
    let roh: string;
    if (rest[i] === '"') {
      const e = rest.indexOf('"', i + 1);
      roh = rest.slice(i + 1, e < 0 ? rest.length : e);
      i = e < 0 ? rest.length : e + 1;
      out.push(roh);
    } else {
      const e = rest.indexOf(',', i);
      roh = rest.slice(i, e < 0 ? rest.length : e).trim();
      i = e < 0 ? rest.length : e;
      if (/^\*\d+$/.test(roh)) out.push({ array: 'ascii', laenge: Number(roh.slice(1)), kodierung: 0, bytes: 0 });
      else if (roh !== '' && !Number.isNaN(Number(roh))) out.push(Number(roh));
      else out.push(roh);
    }
    while (i < rest.length && rest[i] !== ',') i++;
    i++;
  }
  return out;
}

/** ASCII-FBX zeilenweise lesen (begrenzt), gleicher Besucher wie binaer. */
async function asciiBaum(src: AssetSource, a: FbxAuswertung, s: Sammler, ctx: AssetContext, meta: Record<string, unknown>): Promise<boolean> {
  const takt = abbruchTakt(ctx, 1024);
  const decoder = new TextDecoder('utf-8');
  const stapel: Array<{ name: string; obj: AssetObject | null }> = [];
  let intakt = true;
  let zeileNr = 0;
  let puffer = '';
  let ueberlang = false;
  let kommasRest = 0;
  const blockGroesse = 256 * 1024;

  const zeile = (roh: string, kommas: number): void => {
    zeileNr++;
    takt();
    const t = roh.trim();
    if (zeileNr === 1) {
      const m = /^;\s*FBX\s+(\d+)\.(\d+)\.(\d+)/.exec(t);
      if (m) meta.fbx_version = Number(m[1]) * 1000 + Number(m[2]) * 100 + Number(m[3]) * 10;
    }
    if (!t || t.startsWith(';')) return;
    const m = /^([A-Za-z_][\w|]*)\s*:\s*(.*)$/.exec(t);
    if (!m) {
      if (t.startsWith('}')) {
        const z = stapel.pop();
        if (!z) {
          s.warn('klammer_ungleichgewicht', `Zeile ${zeileNr}: schliessende Klammer ohne offenen Knoten.`);
          intakt = false;
        } else if (z.obj?.source_range && 'line_start' in z.obj.source_range) {
          z.obj.source_range.line_end = zeileNr;
        }
        a.offenesArray = null;
        return;
      }
      // Fortsetzungszeile eines 6.x-Arrays: Werte ueber Kommas zaehlen.
      if (a.offenesArray) {
        a.offenesArray.werte += kommas;
        if (!t.endsWith(',')) a.offenesArray.werte += 1;
        a.offenesArray.data[a.offenesArray.feld] = Math.floor(a.offenesArray.werte / a.offenesArray.teiler);
      }
      return;
    }
    a.offenesArray = null;
    let rest = m[2];
    const oeffnet = rest.endsWith('{');
    if (oeffnet) rest = rest.slice(0, -1).trim();
    const werte = asciiWerte(rest);
    if (a.knoten >= MAX_KNOTEN) {
      if (intakt) s.warn('knoten_gekappt', `Mehr als ${MAX_KNOTEN} Knoten; Rest nicht ausgewertet.`);
      intakt = false;
      return;
    }
    const obj = a.besuche(
      stapel.map(x => x.name),
      m[1],
      werte,
      { line_start: zeileNr, line_end: zeileNr }
    );
    // besuche() kann offenesArray gesetzt haben; TS sieht nur die Zuweisung null oben.
    const oa = a.offenesArray as FbxAuswertung['offenesArray'];
    if (oa) {
      // 6.x: Werte stehen in derselben Zeile (und ggf. Folgezeilen).
      oa.werte = rest.trim() === '' ? 0 : kommas + (rest.trim().endsWith(',') ? 0 : 1);
      oa.data[oa.feld] = Math.floor(oa.werte / oa.teiler);
    }
    if (oeffnet) {
      if (stapel.length >= MAX_TIEFE) {
        s.warn('tiefengrenze', `Zeile ${zeileNr}: Verschachtelung tiefer als ${MAX_TIEFE}; Auswertung abgebrochen.`);
        intakt = false;
        throw new TiefeAbbruch();
      }
      stapel.push({ name: m[1], obj });
    }
  };

  try {
    for (let off = 0; off < src.size; off += blockGroesse) {
      ctx.pruefeAbbruch();
      const b = await src.readRange(off, blockGroesse);
      if (b.length === 0) break;
      const text = decoder.decode(b, { stream: off + b.length < src.size });
      let start = 0;
      for (;;) {
        const nl = text.indexOf('\n', start);
        const stueck = nl < 0 ? text.slice(start) : text.slice(start, nl);
        // Kommas der ganzen Zeile zaehlen, aber hoechstens MAX_ZEILE Zeichen behalten.
        for (let i = 0; i < stueck.length; i++) if (stueck.charCodeAt(i) === 44) kommasRest++;
        if (!ueberlang) {
          puffer += stueck;
          if (puffer.length > MAX_ZEILE) {
            puffer = puffer.slice(0, MAX_ZEILE);
            ueberlang = true;
          }
        }
        if (nl < 0) break;
        zeile(puffer, kommasRest);
        puffer = '';
        ueberlang = false;
        kommasRest = 0;
        start = nl + 1;
      }
    }
    if (puffer.length > 0 || kommasRest > 0) zeile(puffer, kommasRest);
  } catch (e) {
    if (!(e instanceof TiefeAbbruch)) throw e;
  }
  if (stapel.length > 0 && intakt) {
    s.warn('klammer_ungleichgewicht', `Dateiende mit ${stapel.length} offenen Knoten (${stapel.map(x => x.name).slice(-3).join(' > ')}).`);
    intakt = false;
  }
  return intakt;
}

class TiefeAbbruch extends Error {}

/** Inspiziert eine FBX-Datei (binaer oder ASCII). */
export async function inspiziereFbx(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'model3d',
    format: 'fbx',
    inspector: 'dcc-fbx',
    parser_version: VERSION,
  });
  const s = new Sammler(ctx.limits.maxObjects);
  const a = new FbxAuswertung(s);
  const f = new FensterLeser(src, 64 * 1024);
  const kopf = await f.lies(0, 27);
  let intakt: boolean;
  const binaer = kopf.length >= 23 && BINAER_MAGIC.every((b, i) => kopf[i] === b);
  if (binaer) {
    res.format_specific.kodierung = 'binaer';
    if (kopf.length < 27) {
      s.warn('abgeschnitten', 'FBX-Kopf endet vor der Versionsnummer.');
      res.status = 'fehler';
      s.indErgebnis(res);
      return res;
    }
    const version = kopf.readUInt32LE(23);
    res.metadata.fbx_version = version;
    res.format_specific.knoten_offsets = version >= 7500 ? 64 : 32;
    if (version < 6000 || version > 7700) s.warn('version_unbekannt', `FBX-Version ${version} ausserhalb des bekannten Bereichs 6000-7700; gelesen wie ${version >= 7500 ? '>= 7500' : '< 7500'}.`);
    intakt = await binaerBaum(f, version, a, s, ctx);
  } else {
    const anfang = kopf.toString('latin1');
    if (!/^(﻿)?\s*;/.test(anfang) && !/^[A-Za-z_]\w*\s*:/.test(anfang.trimStart())) {
      s.warn('kein_fbx_kopf', 'Weder FBX-Binaer-Magic noch ASCII-FBX-Anfang (";" oder "Name:").');
      res.status = 'fehler';
      s.indErgebnis(res);
      return res;
    }
    res.format_specific.kodierung = 'ascii';
    intakt = await asciiBaum(src, a, s, ctx, res.metadata);
  }

  if (a.meta.creator) res.metadata.creator = a.meta.creator;
  if (a.meta.erstellt) res.metadata.erstellt = a.meta.erstellt;
  if (a.meta.fbx_version_kopf !== undefined) res.metadata.fbx_version_kopf = a.meta.fbx_version_kopf;
  const ts = a.zeitstempel;
  if (ts.Year !== undefined) {
    const zw = (n: number | undefined, l = 2): string => String(n ?? 0).padStart(l, '0');
    res.metadata.erstellzeit = `${zw(ts.Year, 4)}-${zw(ts.Month)}-${zw(ts.Day)}T${zw(ts.Hour)}:${zw(ts.Minute)}:${zw(ts.Second)}`;
  }
  if (Object.keys(a.global).length > 0) res.metadata.global = a.global;
  res.metadata.objekte = a.zaehler;
  res.metadata.verbindungen = a.verbindungen;
  if (a.takes > 0) res.metadata.takes = a.takes;
  res.format_specific.knoten = a.knoten;

  // Textur-/Video-Dateien als Referenzen (relativ bevorzugt, sonst absolut).
  const dir = path.dirname(src.filePath);
  const budget: AufloeseBudget = { rest: Math.min(1000, ctx.limits.maxObjects) };
  for (const o of a.dateiObjekte) {
    const rel = typeof o.data.relativ === 'string' ? o.data.relativ : '';
    const abs = typeof o.data.dateiname === 'string' ? o.data.dateiname : '';
    const ziel = rel || abs;
    if (!ziel) continue;
    let r = await pruefeReferenz(dir, ziel, budget);
    if (r.resolved === false && rel && abs && abs !== rel) {
      const r2 = await pruefeReferenz(dir, abs, budget);
      if (r2.resolved) r = r2;
    }
    if (o.data.eingebettet_bytes) o.data.eingebettet = true;
    s.referenz({ target: ziel, kind: 'texture', resolved: r.resolved });
  }
  if (!intakt && res.status === 'ok') res.status = 'teilweise';
  s.indErgebnis(res);
  return res;
}

export const fbxInspektor: AssetInspector = {
  id: 'dcc-fbx',
  formats: ['fbx'],
  extensions: ['.fbx'],
  magic: [
    { offset: 0, bytes: BINAER_MAGIC, format: 'fbx' },
    { offset: 0, bytes: ASCII('; FBX'), format: 'fbx' },
  ],
  version: VERSION,
  inspect: (src, ctx) => inspiziereFbx(src, ctx),
};
