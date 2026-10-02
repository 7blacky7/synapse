/**
 * MODUL: DCC Blend-Inspektor
 * ZWECK: Liest eine Blender-Datei (.blend) DIREKT aus den Bytes — ohne Blender zu starten:
 *  Dateikopf (alt 12 Byte 'BLENDER_v293' und neu ab Blender 5 'BLENDER17-01v0501'),
 *  Kompression (gzip entpacken, zstd entpacken wenn Node es kann, sonst nur erkennen),
 *  Blockliste mit Statistik je Code, SDNA (Strukturbeschreibung der Datei) und damit
 *  ID-Namen, Objekt-Hierarchie, Mesh-Zaehler, Szenen-Bildbereich, Bild-Pfade und Bibliotheken.
 *
 * GRENZE (bewusst): Alles, was Auswertung braucht (Modifier-Ergebnis, Node-Graph-Semantik,
 * Geometrie-Inhalt, Animationskurven), steht in format_specific.nicht_erfasst. Ob dafuer
 * spaeter Blender selbst als Inspektor laeuft, ist NICHT entschieden (P4-T62).
 *
 * GEMESSEN (Blender 5.1.1, eigene Fixtures): neuer Kopf 17 Byte, Blockkopf 'LargeBHead8'
 * (code 4, SDNAnr i32, old u64, len i64, nr i64 = 32 Byte); Feldnamen im SDNA sind die
 * LEGACY-Namen (Image/Library 'name[1024]' statt 'filepath'), ID.name ist name[258].
 * NUR SPEC: alter Kopf mit BHead4/BHead8 (Blender < 5), Big-Endian ('V'), gzip-.blend (< 3.0).
 */

import * as path from 'path';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { AssetReadError } from '../../errors.js';
import {
  BufferQuelle,
  FensterLeser,
  Sammler,
  abbruchTakt,
  entpackeGzip,
  entpackeZstd,
  pruefeReferenz,
  zstdVerfuegbar,
} from './hilfen.js';
import type { AufloeseBudget } from './hilfen.js';

const VERSION = 1;
const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

/** ID-Code (2 Zeichen) -> Objektart. */
const ID_ARTEN: Record<string, string> = {
  OB: 'object', ME: 'mesh', MA: 'material', TE: 'texture', IM: 'image', SC: 'scene', WO: 'world',
  CA: 'camera', LA: 'light', AC: 'action', NT: 'node_tree', LI: 'library', GR: 'collection',
  AR: 'armature', CU: 'curve', CV: 'curves', PT: 'pointcloud', VO: 'volume', GD: 'grease_pencil_legacy',
  GP: 'grease_pencil', BR: 'brush', PA: 'particles', SO: 'sound', VF: 'font', TX: 'text',
  MC: 'movieclip', MS: 'mask', LS: 'linestyle', PL: 'palette', PC: 'paint_curve', CF: 'cachefile',
  KE: 'shape_key', LT: 'lattice', MB: 'metaball', SK: 'speaker', LP: 'lightprobe', ID: 'verknuepft',
  WM: 'window_manager', WS: 'workspace', SN: 'screen', SR: 'screen_alt',
};
/** Oberflaechen-IDs: zaehlen in der Statistik, sind aber keine Szeneninhalte. */
const UI_CODES = new Set(['WM', 'WS', 'SN', 'SR']);

/** Object.type -> Klartext (DNA_object_types.h). */
const OBJEKT_TYPEN: Record<number, string> = {
  0: 'empty', 1: 'mesh', 2: 'curve_legacy', 3: 'surface', 4: 'font', 5: 'metaball', 10: 'light',
  11: 'camera', 12: 'speaker', 13: 'lightprobe', 22: 'lattice', 25: 'armature', 26: 'gpencil_legacy',
  27: 'curves', 28: 'pointcloud', 29: 'volume', 30: 'grease_pencil',
};

/** Was der Direktparser bewusst NICHT liefert (fuer die Blender-Entscheidung im Report). */
const NICHT_ERFASST = [
  'geometrie_inhalt (Vertex-Positionen, Attribute)',
  'modifier_und_evaluierte_geometrie',
  'node_graph_semantik (Shader/Geometry Nodes)',
  'animationskurven_inhalt',
  'transformationsmatrizen',
  'custom_properties (IDProperties)',
];

type BHeadArt = 'large8' | 'bhead8' | 'bhead4';

interface Block {
  code: string;
  offset: number;
  kopf: number;
  len: number;
  sdna: number;
  old: string;
  nr: number;
}

interface Feld {
  typ: string;
  name: string;
  basis: string;
  zeiger: boolean;
  offset: number;
  groesse: number;
}

interface Struktur {
  typ: string;
  groesse: number;
  felder: Feld[];
  /** false: Summe der Feldgroessen passt nicht zu TLEN -> Felder nicht lesen. */
  verlaesslich: boolean;
}

interface Dna {
  structs: Struktur[];
  nachTyp: Map<string, Struktur>;
  namen: number;
  typen: number;
}

/** Zahlenleser mit Endian-Schalter, Bounds-Check ueber Buffer (wirft RangeError -> abgefangen). */
class Zahlen {
  constructor(private readonly le: boolean) {}
  i16(b: Buffer, o: number): number {
    return this.le ? b.readInt16LE(o) : b.readInt16BE(o);
  }
  u16(b: Buffer, o: number): number {
    return this.le ? b.readUInt16LE(o) : b.readUInt16BE(o);
  }
  i32(b: Buffer, o: number): number {
    return this.le ? b.readInt32LE(o) : b.readInt32BE(o);
  }
  u32(b: Buffer, o: number): number {
    return this.le ? b.readUInt32LE(o) : b.readUInt32BE(o);
  }
  i64(b: Buffer, o: number): bigint {
    return this.le ? b.readBigInt64LE(o) : b.readBigInt64BE(o);
  }
  zeiger(b: Buffer, o: number, groesse: number): string {
    if (groesse === 4) return this.u32(b, o).toString(16);
    return (this.le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o)).toString(16);
  }
}

/** Dateiversion -> Blender-Version: bis 2.x zweistellig (248 -> 2.48), ab 3.0 Haupt.Neben (304 -> 3.4). */
function versionAnzeige(v: number): string {
  const haupt = Math.floor(v / 100);
  return haupt < 3 ? `${haupt}.${String(v % 100).padStart(2, '0')}` : `${haupt}.${v % 100}`;
}

function idArt(code: string): string {
  return ID_ARTEN[code] ?? 'id_' + code.toLowerCase();
}

function blockCode(b: Buffer): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) return '0x' + b.subarray(0, 4).toString('hex');
    s += String.fromCharCode(c);
  }
  return s;
}

function cText(b: Buffer): string {
  const ende = b.indexOf(0);
  return b.subarray(0, ende < 0 ? b.length : ende).toString('utf8');
}

/** Parst den DNA1-Block (SDNA). Wirft AssetReadError bei kaputten Daten. */
function parseDna(d: Buffer, z: Zahlen, zeigerGroesse: number): Dna {
  let q = 0;
  const marke = (soll: string): void => {
    if (d.toString('latin1', q, q + 4) !== soll) {
      throw new AssetReadError('ausserhalb', `SDNA: '${soll}' erwartet bei ${q}`, q, 4, d.length - q);
    }
    q += 4;
  };
  const anzahl = (max: number, was: string): number => {
    const n = z.i32(d, q);
    q += 4;
    if (n < 0 || n > max) throw new AssetReadError('ausserhalb', `SDNA: ${was}-Anzahl ${n} unplausibel`, q, 4, d.length - q);
    return n;
  };
  const strings = (n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const e = d.indexOf(0, q);
      if (e < 0) throw new AssetReadError('cstring_unterminiert', 'SDNA: Name ohne Abschluss', q, 0, d.length - q);
      out.push(d.toString('latin1', q, e));
      q = e + 1;
    }
    return out;
  };
  const ausrichten = (): void => {
    q = (q + 3) & ~3;
  };
  marke('SDNA');
  marke('NAME');
  const namen = strings(anzahl(200_000, 'NAME'));
  ausrichten();
  marke('TYPE');
  const typen = strings(anzahl(100_000, 'TYPE'));
  ausrichten();
  marke('TLEN');
  const tlen: number[] = [];
  for (let i = 0; i < typen.length; i++) tlen.push(z.u16(d, q + 2 * i));
  q += 2 * typen.length;
  ausrichten();
  marke('STRC');
  const ns = anzahl(100_000, 'STRC');
  const structs: Struktur[] = [];
  const nachTyp = new Map<string, Struktur>();
  for (let i = 0; i < ns; i++) {
    const t = z.i16(d, q);
    const nf = z.i16(d, q + 2);
    q += 4;
    if (t < 0 || t >= typen.length || nf < 0) throw new AssetReadError('ausserhalb', `SDNA: Struktur ${i} ungueltig`, q, 0, 0);
    const felder: Feld[] = [];
    let off = 0;
    for (let j = 0; j < nf; j++) {
      const ft = z.i16(d, q);
      const fn = z.i16(d, q + 2);
      q += 4;
      if (ft < 0 || ft >= typen.length || fn < 0 || fn >= namen.length) {
        throw new AssetReadError('ausserhalb', `SDNA: Feld ${j} von Struktur ${i} ungueltig`, q, 0, 0);
      }
      const name = namen[fn];
      const zeiger = name.startsWith('*') || name.startsWith('(*');
      let groesse = zeiger ? zeigerGroesse : tlen[ft];
      for (const m of name.matchAll(/\[(\d+)\]/g)) groesse *= Number(m[1]);
      const basis = name.replace(/^\(?\*+/, '').replace(/\)\(.*$/, '').replace(/\[.*$/, '');
      felder.push({ typ: typen[ft], name, basis, zeiger, offset: off, groesse });
      off += groesse;
    }
    const s: Struktur = { typ: typen[t], groesse: tlen[t], felder, verlaesslich: off === tlen[t] };
    structs.push(s);
    if (!nachTyp.has(s.typ)) nachTyp.set(s.typ, s);
  }
  return { structs, nachTyp, namen: namen.length, typen: typen.length };
}

/** Sucht ein Feld (per Basisname) ggf. ueber eingebettete Strukturen: ['r','sfra']. */
function feldPfad(dna: Dna, s: Struktur, pfad: string[]): Feld | null {
  let akt: Struktur | undefined = s;
  let off = 0;
  let f: Feld | undefined;
  for (let i = 0; i < pfad.length; i++) {
    if (!akt || !akt.verlaesslich) return null;
    f = akt.felder.find(x => x.basis === pfad[i]);
    if (!f) return null;
    off += f.offset;
    if (i < pfad.length - 1) {
      if (f.zeiger) return null;
      akt = dna.nachTyp.get(f.typ);
    }
  }
  return f ? { ...f, offset: off } : null;
}

function ersterFeld(dna: Dna, s: Struktur, namen: string[]): Feld | null {
  for (const n of namen) {
    const f = feldPfad(dna, s, [n]);
    if (f) return f;
  }
  return null;
}

/** Inspiziert eine .blend-Datei. Wirft nicht absichtlich; Lesefehler faengt inspectAsset ab. */
export async function inspiziereBlend(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'scene',
    format: 'blend',
    inspector: 'dcc-blend',
    parser_version: VERSION,
  });
  const s = new Sammler(ctx.limits.maxObjects);
  const fs_: Record<string, unknown> = { tiefe: 'struktur', nicht_erfasst: NICHT_ERFASST };
  res.format_specific = fs_;
  const fertig = (): AssetResult => {
    s.indErgebnis(res);
    return res;
  };

  const anfang = await src.readRange(0, 32);
  let quelle: AssetSource = src;
  let komprimierung: 'keine' | 'gzip' | 'zstd' = 'keine';
  if (anfang.length >= 4 && (anfang[0] === 0x1f && anfang[1] === 0x8b || anfang.readUInt32LE(0) === 0xfd2fb528)) {
    komprimierung = anfang[0] === 0x1f ? 'gzip' : 'zstd';
    res.metadata.komprimierung = komprimierung;
    if (komprimierung === 'zstd' && !zstdVerfuegbar()) {
      s.warn('nur_erkannt', 'zstd-komprimierte .blend erkannt; diese Node-Version kann zstd nicht entpacken — Inhalt nicht gelesen.');
      res.status = 'teilweise';
      return fertig();
    }
    // Eingabe so weit lesen, wie das Lesebudget reicht (Rest ist dann nicht entpackbar).
    const lesbar = Math.min(src.size, Math.max(0, ctx.limits.maxReadBytes - anfang.length));
    if (lesbar < src.size) s.warn('eingabe_gekappt', `Nur ${lesbar} von ${src.size} komprimierten Bytes gelesen (Lesebudget).`);
    const roh = await src.readRange(0, lesbar);
    const kappe = Math.max(1, ctx.limits.maxReadBytes);
    const ent =
      komprimierung === 'gzip' ? await entpackeGzip(roh, kappe) : entpackeZstd(roh, kappe, () => ctx.pruefeAbbruch());
    fs_.entpackt_bytes = ent.daten.length;
    if (ent.frames !== undefined) fs_.zstd_frames = ent.frames;
    fs_.offsets_beziehen_sich_auf = 'entpackten_inhalt';
    if (ent.unvollstaendig) {
      s.warn('entpacken_unvollstaendig', `${komprimierung}: ${ent.grund ?? 'unvollstaendig'}`);
      res.status = 'teilweise';
    }
    quelle = new BufferQuelle(src.filePath, ent.daten);
  }

  const f = new FensterLeser(quelle);
  const kopf = await f.lies(0, 17);
  if (kopf.length < 12 || kopf.toString('latin1', 0, 7) !== 'BLENDER') {
    s.warn('kein_blend_kopf', komprimierung === 'keine' ? 'Dateikopf ist nicht "BLENDER".' : `Entpackter ${komprimierung}-Inhalt beginnt nicht mit "BLENDER".`);
    res.status = 'fehler';
    return fertig();
  }

  // Kopf: alt = 'BLENDER' + Zeiger('_'|'-') + Endian('v'|'V') + 3 Ziffern (12 Byte);
  //       neu = 'BLENDER' + Kopfgroesse(2 Ziffern) + '-' + Formatversion(2) + Endian + 4 Ziffern.
  let kopfGroesse: number;
  let zeigerGroesse: number;
  let le: boolean;
  let versionZahl: number;
  let art: BHeadArt;
  const istZiffer = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;
  if (istZiffer(kopf[7])) {
    if (kopf.length < 17 || !istZiffer(kopf[8]) || kopf[9] !== 0x2d) {
      s.warn('kopf_unbekannt', `Unbekannter .blend-Kopf "${kopf.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}".`);
      res.status = 'teilweise';
      return fertig();
    }
    kopfGroesse = Number(kopf.toString('latin1', 7, 9));
    const formatVersion = Number(kopf.toString('latin1', 10, 12));
    le = kopf[12] === 0x76; // 'v'
    versionZahl = Number(kopf.toString('latin1', 13, 17));
    zeigerGroesse = 8;
    art = 'large8';
    fs_.kopf_format = 'neu';
    fs_.dateiformat_version = formatVersion;
    res.metadata.blender_version = versionAnzeige(versionZahl);
    if (formatVersion !== 1 || (kopf[12] !== 0x76 && kopf[12] !== 0x56)) {
      s.warn('nur_erkannt', `.blend-Dateiformat-Version ${formatVersion} ist unbekannt (bekannt: 01, gemessen mit Blender 5.1); Bloecke nicht gelesen.`);
      res.status = 'teilweise';
      return fertig();
    }
    if (kopfGroesse !== 17) {
      s.warn('kopfgroesse_unerwartet', `Kopfgroesse ${kopfGroesse} statt 17.`);
      if (kopfGroesse < 17 || kopfGroesse > 64) {
        res.status = 'teilweise';
        return fertig();
      }
    }
  } else {
    if (kopf[7] !== 0x5f && kopf[7] !== 0x2d) {
      s.warn('kopf_unbekannt', 'Zeigergroessen-Zeichen ist weder "_" noch "-".');
      res.status = 'teilweise';
      return fertig();
    }
    zeigerGroesse = kopf[7] === 0x5f ? 4 : 8;
    le = kopf[8] === 0x76;
    versionZahl = Number(kopf.toString('latin1', 9, 12));
    kopfGroesse = 12;
    art = zeigerGroesse === 8 ? 'bhead8' : 'bhead4';
    fs_.kopf_format = 'alt';
    res.metadata.blender_version = versionAnzeige(versionZahl);
    if (!Number.isFinite(versionZahl) || (kopf[8] !== 0x76 && kopf[8] !== 0x56)) {
      s.warn('kopf_unbekannt', 'Alter .blend-Kopf mit ungueltiger Version/Endian-Angabe.');
      res.status = 'teilweise';
      return fertig();
    }
  }
  if (!le) s.warn('big_endian_ungeprueft', 'Big-Endian-.blend: nur gegen die Spezifikation implementiert, nicht an echter Datei gemessen.');
  const z = new Zahlen(le);
  res.metadata.version_zahl = versionZahl;
  res.metadata.zeigergroesse = zeigerGroesse;
  res.metadata.endian = le ? 'little' : 'big';
  fs_.kopf = kopf.subarray(0, kopfGroesse).toString('latin1');
  fs_.blockkopf = art;

  // Blockliste ablaufen.
  const kopfLen = art === 'large8' ? 32 : art === 'bhead8' ? 24 : 20;
  const takt = abbruchTakt(ctx);
  const statistik = new Map<string, { anzahl: number; bytes: number }>();
  const bloecke: Block[] = [];
  const maxGemerkt = Math.max(1000, ctx.limits.maxObjects * 2);
  let dnaBlock: Block | null = null;
  let globBlock: Block | null = null;
  let p = kopfGroesse;
  let anzahl = 0;
  let endb = false;
  for (;;) {
    takt();
    if (p + kopfLen > quelle.size) {
      s.warn('endb_fehlt', `Blockliste endet bei ${p} ohne ENDB-Block (Datei abgeschnitten?).`);
      break;
    }
    const h = await f.genau(p, kopfLen);
    const code = blockCode(h);
    let len: number;
    let sdna: number;
    let old: string;
    let nr: number;
    if (art === 'large8') {
      sdna = z.i32(h, 4);
      old = z.zeiger(h, 8, 8);
      const l = z.i64(h, 16);
      const n = z.i64(h, 24);
      len = l < 0n || l > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(l);
      nr = n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(n);
    } else if (art === 'bhead8') {
      len = z.i32(h, 4);
      old = z.zeiger(h, 8, 8);
      sdna = z.i32(h, 16);
      nr = z.i32(h, 20);
    } else {
      len = z.i32(h, 4);
      old = z.zeiger(h, 8, 4);
      sdna = z.i32(h, 12);
      nr = z.i32(h, 16);
    }
    if (code === 'ENDB') {
      endb = true;
      break;
    }
    if (len < 0 || p + kopfLen + len > quelle.size) {
      s.warn('block_ausserhalb', `Block "${code}" bei ${p} meldet Laenge ${len}, die Datei endet bei ${quelle.size} — Blockliste abgebrochen.`);
      break;
    }
    anzahl++;
    const st = statistik.get(code) ?? { anzahl: 0, bytes: 0 };
    st.anzahl++;
    st.bytes += len;
    statistik.set(code, st);
    const b: Block = { code, offset: p, kopf: kopfLen, len, sdna, old, nr };
    if (code === 'DNA1') dnaBlock = b;
    else if (code === 'GLOB') globBlock = b;
    else if (code !== 'DATA' && code !== 'TEST' && code !== 'REND' && code !== 'USER') {
      if (bloecke.length < maxGemerkt) bloecke.push(b);
    }
    p += kopfLen + len;
  }
  if (!endb) res.status = 'teilweise';
  res.metadata.block_anzahl = anzahl;
  const statSortiert = [...statistik.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 64);
  res.metadata.bloecke = Object.fromEntries(statSortiert);
  if (statistik.size > 64) s.warn('blockstatistik_gekappt', `${statistik.size} Blockcodes, gezeigt werden die 64 groessten.`);

  // SDNA.
  if (!dnaBlock) {
    s.warn('dna_fehlt', 'Kein DNA1-Block gefunden; ID-Namen und Felder nicht lesbar (nur Blockstatistik).');
    if (res.status === 'ok') res.status = 'teilweise';
    return fertig();
  }
  if (dnaBlock.len > 32 * 1024 * 1024) {
    s.warn('dna_zu_gross', `DNA1-Block mit ${dnaBlock.len} Bytes ist unplausibel gross; nicht gelesen.`);
    if (res.status === 'ok') res.status = 'teilweise';
    return fertig();
  }
  let dna: Dna;
  try {
    dna = parseDna(await f.genau(dnaBlock.offset + dnaBlock.kopf, dnaBlock.len), z, zeigerGroesse);
  } catch (e) {
    if (e instanceof AssetReadError || e instanceof RangeError) {
      s.warn('dna_ungueltig', `SDNA nicht lesbar: ${(e as Error).message}`);
      if (res.status === 'ok') res.status = 'teilweise';
      return fertig();
    }
    throw e;
  }
  fs_.dna = { strukturen: dna.structs.length, typen: dna.typen, namen: dna.namen };
  const unzuverlaessig = dna.structs.filter(x => !x.verlaesslich).length;
  if (unzuverlaessig > 0) s.warn('dna_groesse_abweichend', `${unzuverlaessig} Strukturen: Feldsumme passt nicht zu TLEN; deren Felder werden nicht gelesen.`);

  const idStruct = dna.nachTyp.get('ID');
  const idName = idStruct ? feldPfad(dna, idStruct, ['name']) : null;
  const idLib = idStruct ? feldPfad(dna, idStruct, ['lib']) : null;
  if (!idStruct || !idName) {
    s.warn('dna_ohne_id', 'SDNA enthaelt keine verwendbare ID-Struktur; Namen nicht lesbar.');
    if (res.status === 'ok') res.status = 'teilweise';
    return fertig();
  }

  // GLOB: Unterversion und Build-Hash.
  if (globBlock) {
    const gs = dna.structs[globBlock.sdna];
    if (gs && gs.typ === 'FileGlobal') {
      const basis = globBlock.offset + globBlock.kopf;
      const sub = feldPfad(dna, gs, ['subversion']);
      const hash = feldPfad(dna, gs, ['build_hash']);
      try {
        if (sub && sub.groesse === 2) res.metadata.unterversion = z.i16(await f.genau(basis + sub.offset, 2), 0);
        if (hash) fs_.build_hash = cText(await f.genau(basis + hash.offset, hash.groesse));
      } catch {
        s.warn('glob_unlesbar', 'FileGlobal-Felder nicht lesbar.');
      }
    }
  }

  interface IdEintrag {
    code: string;
    name: string;
    block: Block;
    struct: Struktur;
    idBasis: number;
    lib: string | null;
  }
  const nachZeiger = new Map<string, IdEintrag>();
  const ids: IdEintrag[] = [];
  const idZaehler: Record<string, number> = {};
  for (const b of bloecke) {
    takt();
    const st = b.sdna >= 0 && b.sdna < dna.structs.length ? dna.structs[b.sdna] : null;
    if (!st) continue;
    let idBasis: number;
    if (st.typ === 'ID') idBasis = 0;
    else if (st.felder[0]?.typ === 'ID' && st.felder[0].basis === 'id' && !st.felder[0].zeiger) idBasis = 0;
    else continue;
    if (b.len < idBasis + idName.offset + idName.groesse) {
      s.warn('id_block_zu_kurz', `ID-Block "${b.code}" bei ${b.offset} ist kuerzer als die ID-Struktur.`);
      continue;
    }
    const datum = b.offset + b.kopf;
    const roh = cText(await f.genau(datum + idBasis + idName.offset, idName.groesse));
    const name = roh.length >= 2 ? roh.slice(2) : roh;
    let lib: string | null = null;
    if (idLib && idLib.zeiger) {
      const zp = z.zeiger(await f.genau(datum + idBasis + idLib.offset, zeigerGroesse), 0, zeigerGroesse);
      if (zp !== '0') lib = zp;
    }
    const e: IdEintrag = { code: b.code, name, block: b, struct: st, idBasis, lib };
    ids.push(e);
    nachZeiger.set(b.old, e);
    const art = idArt(b.code);
    idZaehler[art] = (idZaehler[art] ?? 0) + 1;
  }
  res.metadata.ids = idZaehler;

  const blendDir = path.dirname(src.filePath);
  const budget: AufloeseBudget = { rest: Math.min(1000, ctx.limits.maxObjects) };
  const bibliotheken = new Map<string, string>();

  // Bibliotheken zuerst, damit verknuepfte IDs ihren Pfad tragen.
  const pfadVon = async (e: IdEintrag, feldNamen: string[]): Promise<string | null> => {
    const fp = ersterFeld(dna, e.struct, feldNamen);
    if (!fp || fp.zeiger || fp.typ !== 'char' || fp.groesse < 64) return null;
    return cText(await f.genau(e.block.offset + e.block.kopf + fp.offset, fp.groesse));
  };
  const referenz = async (ziel: string, kind: string): Promise<boolean | undefined> => {
    const rel = ziel.startsWith('//') ? ziel.slice(2) : ziel;
    const r = await pruefeReferenz(blendDir, rel, budget);
    s.referenz({ target: ziel, kind, resolved: r.resolved });
    return r.resolved;
  };
  for (const e of ids) {
    if (e.code !== 'LI') continue;
    const p2 = await pfadVon(e, ['filepath', 'name']);
    if (p2) {
      bibliotheken.set(e.block.old, p2);
      await referenz(p2, 'library');
    }
  }

  const leseInt = async (e: IdEintrag, namen: string[]): Promise<number | undefined> => {
    const fp = ersterFeld(dna, e.struct, namen);
    if (!fp || fp.zeiger) return undefined;
    const b = await f.genau(e.block.offset + e.block.kopf + fp.offset, fp.groesse);
    if (fp.groesse === 4) return z.i32(b, 0);
    if (fp.groesse === 2) return z.i16(b, 0);
    return undefined;
  };
  const leseZeiger = async (e: IdEintrag, pfad: string[]): Promise<string | null> => {
    const fp = feldPfad(dna, e.struct, pfad);
    if (!fp || !fp.zeiger) return null;
    const zp = z.zeiger(await f.genau(e.block.offset + e.block.kopf + fp.offset, zeigerGroesse), 0, zeigerGroesse);
    return zp === '0' ? null : zp;
  };
  const leseFloat = async (e: IdEintrag, pfad: string[]): Promise<number | undefined> => {
    const fp = feldPfad(dna, e.struct, pfad);
    if (!fp || fp.zeiger || fp.typ !== 'float' || fp.groesse !== 4) return undefined;
    const b = await f.genau(e.block.offset + e.block.kopf + fp.offset, 4);
    return le ? b.readFloatLE(0) : b.readFloatBE(0);
  };

  for (const e of ids) {
    takt();
    if (UI_CODES.has(e.code)) continue;
    const data: Record<string, unknown> = { code: e.code };
    if (e.lib) {
      data.verknuepft = true;
      const lp = bibliotheken.get(e.lib);
      if (lp) data.bibliothek = lp;
    }
    if (e.code === 'OB') {
      const t = await leseInt(e, ['type']);
      if (t !== undefined) data.objekt_typ = OBJEKT_TYPEN[t] ?? t;
      const eltern = await leseZeiger(e, ['parent']);
      if (eltern) data.eltern = nachZeiger.get(eltern)?.name ?? null;
      const daten = await leseZeiger(e, ['data']);
      if (daten) {
        const d = nachZeiger.get(daten);
        if (d) data.daten = { name: d.name, art: idArt(d.code) };
      }
    } else if (e.code === 'ME') {
      for (const [k, namen] of [
        ['vertices', ['verts_num', 'totvert']],
        ['kanten', ['edges_num', 'totedge']],
        ['flaechen', ['faces_num', 'totpoly', 'totface']],
        ['ecken', ['corners_num', 'totloop']],
      ] as Array<[string, string[]]>) {
        const v = await leseInt(e, namen);
        if (v !== undefined) data[k] = v;
      }
    } else if (e.code === 'SC') {
      for (const [k, pf] of [
        ['bild_start', ['r', 'sfra']],
        ['bild_ende', ['r', 'efra']],
        ['fps', ['r', 'frs_sec']],
      ] as Array<[string, string[]]>) {
        const fp = feldPfad(dna, e.struct, pf);
        if (fp && !fp.zeiger && (fp.groesse === 4 || fp.groesse === 2)) {
          const b = await f.genau(e.block.offset + e.block.kopf + fp.offset, fp.groesse);
          data[k] = fp.groesse === 4 ? z.i32(b, 0) : z.i16(b, 0);
        }
      }
      const kamera = await leseZeiger(e, ['camera']);
      if (kamera) data.kamera = nachZeiger.get(kamera)?.name ?? null;
    } else if (e.code === 'IM') {
      const quelleTyp = await leseInt(e, ['source']);
      if (quelleTyp !== undefined) data.quelle_typ = quelleTyp;
      const gepackt = (await leseZeiger(e, ['packedfile'])) ?? (await leseZeiger(e, ['packedfiles', 'first']));
      if (gepackt) data.gepackt = true;
      const p2 = await pfadVon(e, ['filepath', 'name']);
      if (p2) {
        data.pfad = p2;
        // Erzeugte/Viewer-Bilder (source 4/5) haben keinen Dateibezug.
        if (quelleTyp !== 4 && quelleTyp !== 5) {
          const ok = await referenz(p2, 'texture');
          if (gepackt) data.datei_vorhanden = ok;
        }
      }
    } else if (e.code === 'CA') {
      const lens = await leseFloat(e, ['lens']);
      if (lens !== undefined) data.brennweite_mm = Math.round(lens * 1000) / 1000;
    }
    s.objekt({
      name: e.name,
      kind: idArt(e.code),
      data,
      source_range: { offset: e.block.offset, length: e.block.kopf + e.block.len },
    });
  }
  return fertig();
}

export const blendInspektor: AssetInspector = {
  id: 'dcc-blend',
  formats: ['blend'],
  extensions: ['.blend'],
  // Unkomprimierter Kopf ('BLENDER') sowie gzip (< 3.0) und zstd (ab 3.0): beide Magic teilt sich der Inspektor
  // mit archiv-tar; die Registry loest die Mehrdeutigkeit ueber die Endung .blend. Ohne Endung bleibt es mehrdeutig.
  magic: [
    { offset: 0, bytes: ASCII('BLENDER'), format: 'blend' },
    { offset: 0, bytes: [0x1f, 0x8b, 0x08], format: 'blend' },
    { offset: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd], format: 'blend' },
  ],
  version: VERSION,
  inspect: (src, ctx) => inspiziereBlend(src, ctx),
};
