/**
 * MODUL: Archiv-Inspektor TAR (+ gzip-Huelle)
 * ZWECK: Liest die Kopfbloecke (512 Bytes) eines TAR-Archivs: ustar, GNU (Langnamen L/K) und pax (x/g).
 *        Es wird NICHTS entpackt oder geschrieben; Inhalte werden nur uebersprungen.
 *
 * KOMPRIMIERT: .tar.gz/.tgz wird ueber node:zlib STROEMEND mit harter Ausgabekappe (GZ_AUSGABE_MAX) gelesen —
 * es wird nur so viel entpackt, wie fuer die Kopfbloecke noetig ist, und nie ueber die Kappe hinaus.
 * bzip2/xz/zstd werden NUR erkannt (Magic): status 'teilweise', Warnung 'kompression_nicht_unterstuetzt'.
 *
 * SICHERHEIT: Pfade (Name+Praefix, Langnamen, pax-path) werden auf Traversal geprueft; Symlink-/Hardlink-Ziele
 * ausserhalb des Archivs werden gemeldet; Pruefsumme jedes Kopfblocks wird verifiziert; Groessenangaben ueber die
 * Dateigroesse hinaus werden als Manipulation/Abschneidung gemeldet. Es wird nie ein Pfad aus dem Archiv geoeffnet.
 */

import * as zlib from 'node:zlib';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetResult, AssetSource } from '../../types.js';
import { AssetLimitError } from '../../errors.js';
import {
  FAKTOR_GRENZE,
  MIN_FAKTOR_BASIS,
  Warnungen,
  anzeigeName,
  faengFehler,
  pfadGefahr,
  unixZeitIso,
  verlaesstWurzel,
} from './sicherheit.js';

export const TAR_VERSION = 1;

const BLOCK = 512;
/** Hoechstzahl entpackter Bytes aus einer gzip-Huelle (16 MiB). */
export const GZ_AUSGABE_MAX = 16 * 1024 * 1024;
/** So gross darf der Datenteil eines Langnamen-/pax-Eintrags sein. */
const META_DATEN_MAX = 65536;
/** Eingabechunk fuers Entpacken (klein, damit der Faktor feinkoernig gemessen wird). */
const GZ_EINGABE_CHUNK = 8192;

/** Die Quelle, gegen die der TAR-Lauf liest: die Datei selbst oder der entpackte Anfang einer gzip-Huelle. */
interface TarQuelle {
  size: number;
  lies(offset: number, length: number): Promise<Buffer>;
  /** false, wenn der Strom vor seinem Ende gekappt wurde (gzip-Ausgabekappe/Fehler). */
  vollstaendig: boolean;
}

export interface TarEintrag {
  name: string;
  typ: string;
  groesse: number;
  daten: Record<string, unknown>;
  pos: number;
  gefahr: string[];
}

interface TarLauf {
  eintraege: TarEintrag[];
  endeGefunden: boolean;
  abgeschnitten: boolean;
  gekappt: boolean;
  pruefsummeFalsch: boolean;
  kaputt: string | null;
  variante: 'ustar' | 'gnu' | 'v7' | null;
  pax: boolean;
  langnamen: boolean;
  summeGroessen: number;
}

/** Octal-ASCII oder base-256 (GNU/star) als Zahl; null bei Unsinn. */
export function tarZahl(f: Buffer): number | null {
  if (f.length === 0) return null;
  if (f[0] & 0x80) {
    if (f[0] === 0xff) return null; // negativ
    let v = f[0] & 0x7f;
    for (let i = 1; i < f.length; i++) {
      v = v * 256 + f[i];
      if (v > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    }
    return v;
  }
  const s = f.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) return null;
  return parseInt(s, 8);
}

function textFeld(f: Buffer): string {
  const i = f.indexOf(0);
  return f.toString('utf8', 0, i >= 0 ? i : f.length);
}

function pruefsummeOk(h: Buffer): boolean {
  const soll = tarZahl(h.subarray(148, 156));
  if (soll === null) return false;
  let u = 0;
  let s = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    u += b;
    s += b > 127 ? b - 256 : b;
  }
  return soll === u || soll === s;
}

function istNullblock(h: Buffer): boolean {
  for (let i = 0; i < h.length; i++) if (h[i] !== 0) return false;
  return true;
}

/** Ist das ein gueltiger TAR-Kopfblock? (Pruefsumme + nichtleerer Name) */
export function istTarKopf(h: Buffer): boolean {
  return h.length >= BLOCK && !istNullblock(h) && pruefsummeOk(h);
}

/** pax-Datensatz-Block: "<len> <key>=<value>\n" wiederholt. */
function parsePax(d: Buffer): Record<string, string> {
  const aus: Record<string, string> = {};
  let p = 0;
  while (p < d.length) {
    const sp = d.indexOf(0x20, p);
    if (sp < 0 || sp - p > 10) break;
    const len = parseInt(d.toString('latin1', p, sp), 10);
    if (!Number.isFinite(len) || len < 4 || p + len > d.length) break;
    const satz = d.toString('utf8', sp + 1, p + len - 1); // ohne abschliessendes \n
    const eq = satz.indexOf('=');
    if (eq > 0) aus[satz.slice(0, eq)] = satz.slice(eq + 1);
    p += len;
  }
  return aus;
}

function typName(t: string): string {
  switch (t) {
    case '0':
    case '\0':
    case '7':
      return 'datei';
    case '1':
      return 'hardlink';
    case '2':
      return 'symlink';
    case '3':
      return 'zeichengeraet';
    case '4':
      return 'blockgeraet';
    case '5':
      return 'verzeichnis';
    case '6':
      return 'fifo';
    default:
      return 'sonstig';
  }
}

function verzeichnisVon(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(0, i) : '';
}

async function laufeTar(q: TarQuelle, ctx: AssetContext, w: Warnungen, maxObj: number): Promise<TarLauf> {
  const lauf: TarLauf = {
    eintraege: [],
    endeGefunden: false,
    abgeschnitten: false,
    gekappt: false,
    pruefsummeFalsch: false,
    kaputt: null,
    variante: null,
    pax: false,
    langnamen: false,
    summeGroessen: 0,
  };
  let pos = 0;
  let nullBloecke = 0;
  let langName: string | null = null;
  let langLink: string | null = null;
  let paxEintrag: Record<string, string> | null = null;
  let paxGlobal: Record<string, string> = {};
  // Endet die Quelle zu frueh: bei der Datei selbst ist sie abgeschnitten, bei einem gekappten Strom nur gekappt.
  const schnitt = (): void => {
    if (q.vollstaendig) lauf.abgeschnitten = true;
    else lauf.gekappt = true;
  };

  for (;;) {
    ctx.pruefeAbbruch();
    if (lauf.eintraege.length >= maxObj) {
      lauf.gekappt = true;
      break;
    }
    if (pos >= q.size) {
      // Strom endet sauber an einer Blockgrenze, aber ohne zwei Nullbloecke.
      break;
    }
    if (pos + BLOCK > q.size) {
      schnitt();
      break;
    }
    const h = await q.lies(pos, BLOCK);
    if (h.length < BLOCK) {
      schnitt();
      break;
    }
    if (istNullblock(h)) {
      nullBloecke++;
      pos += BLOCK;
      if (nullBloecke >= 2) {
        lauf.endeGefunden = true;
        break;
      }
      continue;
    }
    if (nullBloecke === 1) w.einmal('tar_einzelner_nullblock', 'Ein einzelner Nullblock steht mitten im Archiv (nicht zwei am Ende); es wird weitergelesen.');
    nullBloecke = 0;
    if (!pruefsummeOk(h)) {
      lauf.pruefsummeFalsch = true;
      lauf.kaputt = `Pruefsumme des Kopfblocks bei Offset ${pos} stimmt nicht`;
      break;
    }
    const magic = h.toString('latin1', 257, 263);
    const version = h.toString('latin1', 263, 265);
    const variante: 'ustar' | 'gnu' | 'v7' = magic === 'ustar\0' ? 'ustar' : magic.startsWith('ustar ') ? 'gnu' : 'v7';
    lauf.variante ??= variante;

    const typByte = h[156];
    const typ = typByte === 0 ? '0' : String.fromCharCode(typByte);
    let groesse = tarZahl(h.subarray(124, 136));
    if (groesse === null) {
      lauf.kaputt = `Groessenfeld des Kopfblocks bei Offset ${pos} ungueltig`;
      break;
    }

    // Metadaten-Eintraege: GNU-Langname (L), Langlink (K), pax (x lokal, g global).
    if (typ === 'L' || typ === 'K' || typ === 'x' || typ === 'g' || typ === 'X') {
      if (groesse > META_DATEN_MAX || pos + BLOCK + groesse > q.size) {
        lauf.kaputt = groesse > META_DATEN_MAX ? `Metadaten-Eintrag bei Offset ${pos} zu gross (${groesse} Bytes)` : `Metadaten-Eintrag bei Offset ${pos} ragt ueber das Ende`;
        if (pos + BLOCK + groesse > q.size) schnitt();
        break;
      }
      const d = await q.lies(pos + BLOCK, groesse);
      if (typ === 'L') {
        langName = textFeld(d);
        lauf.langnamen = true;
      } else if (typ === 'K') {
        langLink = textFeld(d);
        lauf.langnamen = true;
      } else if (typ === 'g') {
        paxGlobal = { ...paxGlobal, ...parsePax(d) };
        lauf.pax = true;
      } else {
        paxEintrag = { ...(paxEintrag ?? {}), ...parsePax(d) };
        lauf.pax = true;
      }
      pos += BLOCK + Math.ceil(groesse / BLOCK) * BLOCK;
      continue;
    }

    const pax = { ...paxGlobal, ...(paxEintrag ?? {}) };
    paxEintrag = null;
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) groesse = Math.min(Number(pax.size), Number.MAX_SAFE_INTEGER);

    let name = textFeld(h.subarray(0, 100));
    if (variante === 'ustar') {
      const praefix = textFeld(h.subarray(345, 500));
      if (praefix) name = praefix + '/' + name;
    }
    if (langName !== null) name = langName;
    if (pax.path !== undefined) name = pax.path;
    langName = null;
    let link = textFeld(h.subarray(157, 257));
    if (langLink !== null) link = langLink;
    if (pax.linkpath !== undefined) link = pax.linkpath;
    langLink = null;

    // Datenlaenge im Archiv: Links, Verzeichnisse und Geraete tragen keine Daten.
    const datenBytes = '123456'.includes(typ) ? 0 : groesse;
    const naechster = pos + BLOCK + Math.ceil(datenBytes / BLOCK) * BLOCK;

    const gefahr = [...new Set(pfadGefahr(name))];
    const daten: Record<string, unknown> = {
      typ: typName(typ),
      typ_zeichen: typ,
      groesse,
      mode: tarZahl(h.subarray(100, 108)) === null ? null : (tarZahl(h.subarray(100, 108)) as number).toString(8).padStart(4, '0'),
      uid: tarZahl(h.subarray(108, 116)),
      gid: tarZahl(h.subarray(116, 124)),
      mtime: pax.mtime !== undefined && /^\d+(\.\d+)?$/.test(pax.mtime) ? unixZeitIso(Math.floor(Number(pax.mtime))) : unixZeitIso(tarZahl(h.subarray(136, 148)) ?? -1),
      uname: textFeld(h.subarray(265, 297)) || null,
      gname: textFeld(h.subarray(297, 329)) || null,
      variante,
      pfad_gefaehrlich: gefahr.length > 0,
      gefahr,
    };
    if (variante === 'ustar' && version !== '00') daten.ustar_version = version;
    if (typ === '1' || typ === '2') {
      daten.link_ziel = anzeigeName(link);
      const aussen = typ === '2' ? verlaesstWurzel(verzeichnisVon(name), link) : verlaesstWurzel('', link);
      daten.link_ziel_ausserhalb = aussen;
      if (aussen) w.add('link_ziel_ausserhalb', `${typName(typ)} "${anzeigeName(name)}" zeigt auf "${anzeigeName(link)}" ausserhalb des Archivs.`);
    }
    if (typ === '3' || typ === '4') {
      daten.geraet = { major: tarZahl(h.subarray(329, 337)), minor: tarZahl(h.subarray(337, 345)) };
      w.einmal('tar_geraetedatei', 'Das Archiv enthaelt Geraetedateien (Zeichen-/Blockgeraet); ein naiver Entpacker mit Rechten koennte sie anlegen.');
    }
    if (gefahr.length) w.add('pfad_gefaehrlich', `Eintrag "${anzeigeName(name)}": ${gefahr.join(', ')}`);
    if (Object.keys(pax).length) daten.pax_schluessel = Object.keys(pax).slice(0, 12);

    lauf.eintraege.push({ name, typ, groesse, daten, pos, gefahr });
    lauf.summeGroessen += groesse;

    if (datenBytes > 0 && naechster > q.size) {
      // Der Eintrag verspricht mehr Daten, als die Quelle hat.
      daten.daten_abgeschnitten = true;
      if (q.vollstaendig) w.add('tar_groesse_ausserhalb', `Eintrag "${anzeigeName(name)}" verspricht ${datenBytes} Datenbytes, die Datei endet vorher (${q.size - pos - BLOCK} vorhanden).`);
      schnitt();
      break;
    }
    pos = naechster;
  }
  return lauf;
}

interface GzErgebnis {
  daten: Buffer;
  /** true, wenn der gzip-Strom bis zum Ende gelesen wurde. */
  ende: boolean;
  fehler: string | null;
  eingelesen: number;
  gekappt: boolean;
  /** Zeit-/Lesegrenze oder anderer harter Abbruch; muss nach oben weitergereicht werden. */
  abbruch: unknown;
}

/** Entpackt hoechstens maxAus Bytes; liest die Eingabe in kleinen Stuecken und bricht an der Kappe hart ab. */
async function entpackeBegrenzt(src: AssetSource, ctx: AssetContext, maxAus: number): Promise<GzErgebnis> {
  const gz = zlib.createGunzip({ chunkSize: 16 * 1024 });
  const teile: Buffer[] = [];
  let n = 0;
  let fertig = false;
  let ende = false;
  let gekappt = false;
  let fehler: string | null = null;
  let eingelesen = 0;
  let abbruch: unknown = null;
  return new Promise<GzErgebnis>(resolve => {
    const schliesse = (): void => {
      if (fertig) return;
      fertig = true;
      gz.destroy();
      resolve({ daten: Buffer.concat(teile), ende, fehler, eingelesen, gekappt, abbruch });
    };
    gz.on('data', (c: Buffer) => {
      if (fertig) return;
      const frei = maxAus - n;
      if (c.length >= frei) {
        teile.push(c.subarray(0, frei));
        n += frei;
        gekappt = true;
        schliesse();
      } else {
        teile.push(c);
        n += c.length;
      }
    });
    gz.on('end', () => {
      ende = true;
      schliesse();
    });
    gz.on('error', (e: Error) => {
      fehler = e.message;
      schliesse();
    });
    (async () => {
      let pos = 0;
      while (!fertig && pos < src.size) {
        ctx.pruefeAbbruch();
        const b = await src.readRange(pos, GZ_EINGABE_CHUNK);
        if (b.length === 0) break;
        pos += b.length;
        eingelesen = pos;
        if (fertig) break;
        if (!gz.write(b)) await new Promise<void>(r => {
          gz.once('drain', () => r());
          gz.once('close', () => r());
        });
      }
      if (!fertig) gz.end();
    })().catch(e => {
      abbruch = e;
      fehler = (e as Error).message;
      schliesse();
    });
  });
}

/** Liest den gzip-Kopf (Name, Zeit, Betriebssystem). */
function leseGzipKopf(k: Buffer): { mtime: string | null; os: number; name: string | null; kommentar: boolean; flags: number } | null {
  if (k.length < 10 || k[0] !== 0x1f || k[1] !== 0x8b) return null;
  const flags = k[3];
  let p = 10;
  let name: string | null = null;
  if (flags & 4) {
    if (p + 2 > k.length) return null;
    p += 2 + k.readUInt16LE(p);
  }
  if (flags & 8) {
    const e = k.indexOf(0, p);
    if (e < 0) return { mtime: null, os: k[9], name: null, kommentar: (flags & 16) !== 0, flags };
    name = k.toString('latin1', p, e);
    p = e + 1;
  }
  const mt = k.readUInt32LE(4);
  return { mtime: mt > 0 ? unixZeitIso(mt) : null, os: k[9], name, kommentar: (flags & 16) !== 0, flags };
}

const BZ2_STUFE = (b: Buffer): number => b[3] - 0x30;

async function inspiziere(src: AssetSource, ctx: AssetContext, res: AssetResult, w: Warnungen): Promise<void> {
  const kopf = await src.readRange(0, 4096);
  const endung = src.filePath.toLowerCase();
  const sagtTar = /\.(tar|tgz|taz|tbz2?|txz|tzst|tar\.(gz|bz2|xz|zst))$/.test(endung);
  const fs = res.format_specific;
  const meta = res.metadata;

  // 1. Kompressionshuellen.
  const gzipMagic = kopf.length >= 3 && kopf[0] === 0x1f && kopf[1] === 0x8b && kopf[2] === 0x08;
  const bzip2 = kopf.length >= 4 && kopf.toString('latin1', 0, 3) === 'BZh' && kopf[3] >= 0x31 && kopf[3] <= 0x39;
  const xz = kopf.length >= 6 && kopf[0] === 0xfd && kopf.toString('latin1', 1, 5) === '7zXZ' && kopf[5] === 0;
  const zstd = kopf.length >= 4 && kopf[0] === 0x28 && kopf[1] === 0xb5 && kopf[2] === 0x2f && kopf[3] === 0xfd;

  if (bzip2 || xz || zstd) {
    const art = bzip2 ? 'bzip2' : xz ? 'xz' : 'zstd';
    const kurz = bzip2 ? 'bz2' : xz ? 'xz' : 'zst';
    res.format = sagtTar ? `tar.${kurz}` : kurz;
    meta.kompression = art;
    meta.tar_laut_endung = sagtTar;
    if (bzip2) meta.bzip2_blockgroesse = BZ2_STUFE(kopf) * 100000;
    fs.tiefe = 'nur_magic';
    w.add('kompression_nicht_unterstuetzt', `${art}-Kompression wird nur erkannt, nicht gelesen (kein Dekoder im Inspektor); das Inhaltsverzeichnis fehlt.`);
    res.status = 'teilweise';
    return;
  }

  if (gzipMagic) {
    await inspiziereGzip(src, ctx, res, w, kopf, sagtTar);
    return;
  }

  // 2. Reines TAR.
  if (kopf.length < BLOCK) {
    w.add('tar_zu_klein', `Datei (${src.size} Bytes) kleiner als ein TAR-Kopfblock (${BLOCK} Bytes).`);
    res.status = 'teilweise';
    return;
  }
  const leeresTar = kopf.length >= 2 * BLOCK && istNullblock(kopf.subarray(0, BLOCK)) && istNullblock(kopf.subarray(BLOCK, 2 * BLOCK));
  if (!leeresTar && !istTarKopf(kopf.subarray(0, BLOCK))) {
    w.add('kein_tar', istNullblock(kopf.subarray(0, BLOCK)) ? 'Erster Block ist leer, aber es fehlt der zweite Nullblock (kein gueltiges TAR).' : 'Erster Kopfblock hat keine gueltige TAR-Pruefsumme; kein TAR.');
    res.status = 'teilweise';
    return;
  }
  const q: TarQuelle = { size: src.size, lies: (o, l) => src.readRange(o, l), vollstaendig: true };
  const lauf = await laufeTar(q, ctx, w, ctx.limits.maxObjects);
  fuelleErgebnis(res, w, lauf, src.size, false);
}

async function inspiziereGzip(src: AssetSource, ctx: AssetContext, res: AssetResult, w: Warnungen, kopf: Buffer, sagtTar: boolean): Promise<void> {
  const meta = res.metadata;
  const fs = res.format_specific;
  const gk = leseGzipKopf(kopf);
  meta.kompression = 'gzip';
  if (gk) {
    meta.gzip_name = gk.name;
    meta.gzip_mtime = gk.mtime;
    meta.gzip_betriebssystem = gk.os;
  }
  // ISIZE = Groesse der Daten mod 2^32 (letzte 4 Bytes des letzten Members).
  let isize: number | null = null;
  if (src.size >= 18) {
    const t = await src.readRange(src.size - 4, 4);
    if (t.length === 4) isize = t.readUInt32LE(0);
  }
  meta.isize_laut_trailer = isize;

  const g = await entpackeBegrenzt(src, ctx, GZ_AUSGABE_MAX);
  if (g.abbruch instanceof AssetLimitError) throw g.abbruch; // Zeitgrenze etc.: Sache von inspectAsset
  fs.entpackt_bytes = g.daten.length;
  fs.eingelesen_bytes = g.eingelesen;
  fs.ausgabekappe = GZ_AUSGABE_MAX;
  fs.gzip_ende_erreicht = g.ende;

  // Bombenverdacht: Faktor aus dem, was wirklich ausgespuckt wurde.
  const hochgerechnet = g.gekappt ? Math.max(g.daten.length, isize ?? 0) : g.daten.length;
  const faktor = g.eingelesen > 0 ? hochgerechnet / g.eingelesen : 0;
  const trailerFaktor = isize !== null && src.size > 0 ? isize / src.size : 0;
  meta.faktor = Math.round(Math.max(faktor, trailerFaktor) * 100) / 100;
  const bombeGrund: string[] = [];
  if (g.gekappt && g.eingelesen > 0 && g.daten.length / g.eingelesen > FAKTOR_GRENZE) bombeGrund.push(`gesamtfaktor:${Math.round(g.daten.length / g.eingelesen)}`);
  if (isize !== null && isize >= MIN_FAKTOR_BASIS && trailerFaktor > FAKTOR_GRENZE) bombeGrund.push(`trailer_faktor:${Math.round(trailerFaktor)}`);
  if (bombeGrund.length) {
    meta.bombe_verdacht = true;
    fs.bombe_gruende = bombeGrund;
    w.add('archiv_bombe_verdacht', `gzip-Huelle expandiert extrem (${bombeGrund.join('; ')}); es wurden hoechstens ${GZ_AUSGABE_MAX} Bytes entpackt.`);
    res.status = 'teilweise';
  } else meta.bombe_verdacht = false;

  if (g.fehler) {
    w.add('gzip_abgeschnitten_oder_kaputt', `gzip-Strom nicht fehlerfrei lesbar: ${g.fehler}`);
    res.status = 'teilweise';
  }

  const istTar = g.daten.length >= BLOCK && istTarKopf(g.daten.subarray(0, BLOCK));
  if (!istTar) {
    res.format = 'gzip';
    meta.enthaelt_tar = false;
    if (sagtTar) {
      w.add('kein_tar_im_gzip', 'Die Endung deutet auf ein TAR, der entpackte Anfang ist aber kein TAR-Kopfblock.');
      res.status = 'teilweise';
    }
    return;
  }
  res.format = 'tar.gz';
  meta.enthaelt_tar = true;
  fs.offsets_beziehen_sich_auf = 'entpackter_tar_strom';
  const strom = g.daten;
  const q: TarQuelle = {
    size: strom.length,
    lies: (o, l) => Promise.resolve(strom.subarray(o, Math.min(o + l, strom.length))),
    vollstaendig: g.ende,
  };
  if (!g.ende && g.gekappt) {
    w.add('tar_gz_gekappt', `Nur die ersten ${strom.length} Bytes des entpackten Stroms wurden gelesen (Ausgabekappe); die Eintragsliste kann unvollstaendig sein.`);
    res.status = 'teilweise';
  }
  const lauf = await laufeTar(q, ctx, w, ctx.limits.maxObjects);
  fuelleErgebnis(res, w, lauf, strom.length, !g.ende);
}

function fuelleErgebnis(res: AssetResult, w: Warnungen, lauf: TarLauf, stromGroesse: number, stromGekappt: boolean): void {
  const meta = res.metadata;
  const fs = res.format_specific;
  let dateien = 0;
  let verzeichnisse = 0;
  let links = 0;
  let gefaehrlich = 0;
  let linksAussen = 0;
  const objekte: AssetObject[] = [];
  for (const e of lauf.eintraege) {
    const t = e.daten.typ;
    if (t === 'datei') dateien++;
    else if (t === 'verzeichnis') verzeichnisse++;
    else if (t === 'symlink' || t === 'hardlink') links++;
    if (e.gefahr.length) gefaehrlich++;
    if (e.daten.link_ziel_ausserhalb === true) linksAussen++;
    objekte.push({
      name: anzeigeName(e.name),
      kind: 'archive_entry',
      data: e.daten,
      source_range: { offset: e.pos, length: BLOCK },
    });
  }
  res.objects.push(...objekte);
  meta.eintraege_gelesen = lauf.eintraege.length;
  meta.dateien = dateien;
  meta.verzeichnisse = verzeichnisse;
  meta.links = links;
  meta.gefaehrliche_pfade = gefaehrlich;
  meta.link_ziele_ausserhalb = linksAussen;
  meta.unkomprimiert_gesamt = lauf.summeGroessen;
  meta.tar_variante = lauf.variante;
  meta.pax_header = lauf.pax;
  meta.gnu_langnamen = lauf.langnamen;
  meta.ende_gefunden = lauf.endeGefunden;
  fs.strom_groesse = stromGroesse;

  if (!lauf.endeGefunden && !lauf.gekappt && !lauf.abgeschnitten && !lauf.kaputt && !stromGekappt) {
    w.add('tar_ende_fehlt', 'Das Archiv endet ohne die zwei abschliessenden Nullbloecke.');
  }
  if (lauf.abgeschnitten) {
    w.add('tar_abgeschnitten', 'Das Archiv endet mitten in einem Block oder Eintrag (abgeschnitten).');
    res.status = 'teilweise';
  }
  if (lauf.pruefsummeFalsch) {
    w.add('pruefsumme_falsch', `${lauf.kaputt}; Lesen nach ${lauf.eintraege.length} Eintraegen abgebrochen.`);
    res.status = 'teilweise';
  } else if (lauf.kaputt) {
    w.add('tar_kaputt', `${lauf.kaputt}; Lesen nach ${lauf.eintraege.length} Eintraegen abgebrochen.`);
    res.status = 'teilweise';
  }
  if (lauf.gekappt && !stromGekappt) {
    w.add('objekte_gekappt', `Mehr Eintraege als die Grenze (${lauf.eintraege.length} gelesen); der Rest wurde nicht ausgewertet.`);
    res.status = 'teilweise';
  }
}

export const tarInspector: AssetInspector = {
  id: 'archiv-tar',
  formats: ['tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'gzip', 'bz2', 'xz', 'zst'],
  extensions: ['.tar', '.tgz', '.taz', '.tbz', '.tbz2', '.txz', '.tzst', '.gz', '.bz2', '.xz', '.zst'],
  magic: [
    // POSIX ustar ("ustar\0" + "00") und GNU ("ustar  \0") am festen Offset 257.
    { offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30], format: 'tar' },
    { offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0x00], format: 'tar' },
    { offset: 0, bytes: [0x1f, 0x8b, 0x08], format: 'tar.gz' },
    // bzip2: "BZh" + Stufe 1..9 + Blockmagic 0x314159265359 (macht Fehltreffer auf Text praktisch unmoeglich).
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => ({ offset: 0, bytes: [0x42, 0x5a, 0x68, 0x30 + d, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59], format: 'tar.bz2' })),
    { offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], format: 'tar.xz' },
    { offset: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd], format: 'tar.zst' },
  ],
  version: TAR_VERSION,
  async inspect(src, ctx) {
    const w = new Warnungen();
    const res = erzeugeAssetResult(src.filePath, src.size, {
      asset_type: 'archive',
      format: 'tar',
      inspector: 'archiv-tar',
      parser_version: TAR_VERSION,
    });
    try {
      await inspiziere(src, ctx, res, w);
    } catch (e) {
      faengFehler(e, w);
      res.status = 'teilweise';
    }
    res.warnings = w.fertig();
    return res;
  },
};
