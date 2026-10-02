/**
 * MODUL: Archiv-Inspektor 7z
 * ZWECK: Liest den Signature Header (32 Bytes) und — NUR wenn der Header unkomprimiert und unverschluesselt ist —
 *        das Inhaltsverzeichnis (Dateinamen, Groessen, Zeiten, Attribute, Coder-Ketten).
 *
 * GRENZE (bewusst): kein LZMA-/AES-Dekoder. 7z komprimiert den Header standardmaessig (EncodedHeader, 0x17); dann
 * gibt es status 'teilweise' + Warnung 'header_komprimiert_oder_verschluesselt' mit dem, was der Signature Header
 * und der Header-Stream-Beschreibung hergeben (Offsets, Methode, Verschluesselung ja/nein). Nichts wird geraten.
 *
 * SICHERHEIT: StartHeaderCRC und NextHeaderCRC werden geprueft, NextHeader-Offset/-Groesse gegen die Dateigroesse,
 * Zaehler (Dateien, Folder, Coder) gegen die Headergroesse. Pfade werden auf Traversal bewertet, nie geoeffnet.
 */

import { BinaryReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetReference, AssetResult, AssetSource } from '../../types.js';
import {
  MAX_EINTRAEGE_ABSURD,
  OBJEKTE_BEI_BOMBE,
  Warnungen,
  anzeigeName,
  bombeGruende,
  crc32,
  faengFehler,
  istArchivEndung,
  klemme,
  pfadGefahr,
} from './sicherheit.js';

export const SEVENZIP_VERSION = 1;

const HEADER_LESE_MAX = 16 * 1024 * 1024;
const MAX_CODER = 32;

const METHODEN: Record<string, string> = {
  '00': 'kopie',
  '03': 'delta',
  '04': 'bcj_x86',
  '05': 'bcj_ppc',
  '06': 'bcj_ia64',
  '07': 'bcj_arm',
  '08': 'bcj_armt',
  '09': 'bcj_sparc',
  '0a': 'bcj_arm64',
  '21': 'lzma2',
  '030101': 'lzma',
  '030103': 'bcj_x86_alt',
  '03030103': 'bcj_x86',
  '0303011b': 'bcj2',
  '030401': 'ppmd',
  '040108': 'deflate',
  '040109': 'deflate64',
  '040202': 'bzip2',
  '06f10701': 'aes256_sha256',
};
const AES_ID = '06f10701';

class SzFehler extends Error {}

/** Ein Zaehler, der nach der Headergroesse unmoeglich ist (Bombenmerkmal, keine blosse Beschaedigung). */
class SzAbsurd extends SzFehler {}

interface Coder {
  id: string;
  name: string;
  eingaenge: number;
  ausgaenge: number;
}

interface Folder {
  coder: Coder[];
  /** Index des Hauptausgangs (der Ausgang, den kein Bind-Paar verbraucht). */
  hauptAusgang: number;
  /** Entpackte Groesse des Hauptausgangs. */
  entpackt: number;
  crc: number | null;
}

interface StreamsInfo {
  packPos: number;
  packGroessen: number[];
  folder: Folder[];
  /** Groessen/CRCs aller Teilstroeme in Reihenfolge der Folder. */
  teilGroessen: number[];
  teilCrcs: Array<number | null>;
  /** Wie viele Teilstroeme pro Folder. */
  teilAnzahl: number[];
}

interface Datei {
  name: string;
  nameOffset: number;
  nameLaenge: number;
  leerStrom: boolean;
  leereDatei: boolean;
  anti: boolean;
  mtime: string | null;
  attribute: number | null;
}

/** 7z-NUMBER: das fuehrende 1-Bit-Muster des ersten Bytes gibt die Zahl der Folgebytes an. */
function zahl(r: BinaryReader): number {
  const erst = r.u8();
  let maske = 0x80;
  let wert = 0;
  for (let i = 0; i < 8; i++) {
    if ((erst & maske) === 0) {
      wert += (erst & (maske - 1)) * 2 ** (8 * i);
      return Math.min(wert, Number.MAX_SAFE_INTEGER);
    }
    wert += r.u8() * 2 ** (8 * i);
    maske >>= 1;
  }
  return Math.min(wert, Number.MAX_SAFE_INTEGER);
}

/** Liest eine Zahl, die hoechstens max sein darf (Schutz vor absurden Zaehlern). */
function zaehler(r: BinaryReader, max: number, was: string): number {
  const n = zahl(r);
  if (n > max) throw new SzAbsurd(`${was}: ${n} ist unplausibel (Obergrenze ${max})`);
  return n;
}

function bitVektor(r: BinaryReader, n: number): boolean[] {
  const aus: boolean[] = [];
  let b = 0;
  let maske = 0;
  for (let i = 0; i < n; i++) {
    if (maske === 0) {
      b = r.u8();
      maske = 0x80;
    }
    aus.push((b & maske) !== 0);
    maske >>= 1;
  }
  return aus;
}

/** "AllAreDefined"-Byte, sonst Bitvektor. */
function definiert(r: BinaryReader, n: number): boolean[] {
  const alle = r.u8();
  return alle !== 0 ? new Array<boolean>(n).fill(true) : bitVektor(r, n);
}

function digests(r: BinaryReader, n: number): Array<number | null> {
  const d = definiert(r, n);
  return d.map(x => (x ? r.u32le() : null));
}

function leseStreamsInfo(r: BinaryReader, ctx: AssetContext, headerGroesse: number): StreamsInfo {
  const si: StreamsInfo = { packPos: 0, packGroessen: [], folder: [], teilGroessen: [], teilCrcs: [], teilAnzahl: [] };
  let teilGelesen = false;
  for (;;) {
    ctx.pruefeAbbruch();
    const id = r.u8();
    if (id === 0x00) break;
    if (id === 0x06) {
      si.packPos = zahl(r);
      const n = zaehler(r, headerGroesse, 'Anzahl Pack-Streams');
      for (;;) {
        const t = r.u8();
        if (t === 0x00) break;
        if (t === 0x09) for (let i = 0; i < n; i++) si.packGroessen.push(zahl(r));
        else if (t === 0x0a) digests(r, n);
        else throw new SzFehler(`PackInfo: unbekannte Eigenschaft 0x${t.toString(16)}`);
      }
    } else if (id === 0x07) {
      if (r.u8() !== 0x0b) throw new SzFehler('UnPackInfo: kFolder fehlt');
      const nf = zaehler(r, headerGroesse, 'Anzahl Folder');
      if (r.u8() !== 0) throw new SzFehler('UnPackInfo: externe Folder-Daten werden nicht unterstuetzt');
      const ausgaengeJeFolder: number[] = [];
      for (let f = 0; f < nf; f++) {
        const nc = zaehler(r, MAX_CODER, 'Anzahl Coder');
        if (nc === 0) throw new SzFehler('Folder ohne Coder');
        const coder: Coder[] = [];
        let eingaenge = 0;
        let ausgaenge = 0;
        for (let c = 0; c < nc; c++) {
          const flag = r.u8();
          if (flag & 0x80) throw new SzFehler('Coder-Flag mit reserviertem Bit');
          const idBytes = r.bytes(flag & 0x0f);
          let ein = 1;
          let aus = 1;
          if (flag & 0x10) {
            ein = zaehler(r, MAX_CODER, 'Coder-Eingaenge');
            aus = zaehler(r, MAX_CODER, 'Coder-Ausgaenge');
          }
          if (flag & 0x20) r.skip(zaehler(r, headerGroesse, 'Coder-Eigenschaften'));
          const hex = Buffer.from(idBytes).toString('hex');
          coder.push({ id: hex, name: METHODEN[hex] ?? `unbekannt_${hex}`, eingaenge: ein, ausgaenge: aus });
          eingaenge += ein;
          ausgaenge += aus;
        }
        const bind = ausgaenge - 1;
        const gebunden = new Set<number>();
        for (let b = 0; b < bind; b++) {
          zahl(r); // InIndex
          gebunden.add(zahl(r)); // OutIndex
        }
        const gepackt = eingaenge - bind;
        if (gepackt > 1) for (let p = 0; p < gepackt; p++) zahl(r);
        ausgaengeJeFolder.push(ausgaenge);
        let haupt = 0;
        while (haupt < ausgaenge && gebunden.has(haupt)) haupt++;
        si.folder.push({ coder, hauptAusgang: haupt, entpackt: 0, crc: null });
      }
      if (r.u8() !== 0x0c) throw new SzFehler('UnPackInfo: kCodersUnPackSize fehlt');
      for (let f = 0; f < nf; f++) {
        const hauptIndex = si.folder[f].hauptAusgang;
        let haupt = 0;
        for (let o = 0; o < ausgaengeJeFolder[f]; o++) {
          const s = zahl(r);
          if (o === hauptIndex) haupt = s;
        }
        si.folder[f].entpackt = haupt;
      }
      for (;;) {
        const t = r.u8();
        if (t === 0x00) break;
        if (t === 0x0a) {
          const d = digests(r, nf);
          d.forEach((c, i) => (si.folder[i].crc = c));
        } else throw new SzFehler(`UnPackInfo: unbekannte Eigenschaft 0x${t.toString(16)}`);
      }
    } else if (id === 0x08) {
      teilGelesen = true;
      const anzahl = si.folder.map(() => 1);
      let groessenGelesen = false;
      for (;;) {
        const t = r.u8();
        if (t === 0x00) break;
        if (t === 0x0d) {
          for (let f = 0; f < si.folder.length; f++) anzahl[f] = zaehler(r, headerGroesse, 'Teilstroeme je Folder');
        } else if (t === 0x09) {
          groessenGelesen = true;
          for (let f = 0; f < si.folder.length; f++) {
            if (anzahl[f] === 0) continue;
            let summe = 0;
            for (let j = 0; j < anzahl[f] - 1; j++) {
              const s = zahl(r);
              si.teilGroessen.push(s);
              summe += s;
            }
            si.teilGroessen.push(Math.max(0, si.folder[f].entpackt - summe));
          }
        } else if (t === 0x0a) {
          // CRCs gibt es nur fuer Teilstroeme, deren Wert der Folder nicht schon liefert.
          let n = 0;
          for (let f = 0; f < si.folder.length; f++) if (anzahl[f] !== 1 || si.folder[f].crc === null) n += anzahl[f];
          const d = digests(r, n);
          let k = 0;
          for (let f = 0; f < si.folder.length; f++) {
            if (anzahl[f] === 1 && si.folder[f].crc !== null) si.teilCrcs.push(si.folder[f].crc);
            else for (let j = 0; j < anzahl[f]; j++) si.teilCrcs.push(d[k++] ?? null);
          }
        } else throw new SzFehler(`SubStreamsInfo: unbekannte Eigenschaft 0x${t.toString(16)}`);
      }
      si.teilAnzahl = anzahl;
      if (!groessenGelesen) {
        for (let f = 0; f < si.folder.length; f++) {
          if (anzahl[f] === 1) si.teilGroessen.push(si.folder[f].entpackt);
          else if (anzahl[f] > 1) throw new SzFehler('SubStreamsInfo: mehrere Teilstroeme ohne Groessen');
        }
      }
      if (si.teilCrcs.length === 0) {
        for (let f = 0; f < si.folder.length; f++) if (anzahl[f] === 1) si.teilCrcs.push(si.folder[f].crc);
        else for (let j = 0; j < anzahl[f]; j++) si.teilCrcs.push(null);
      }
    } else {
      throw new SzFehler(`StreamsInfo: unbekannte Kennung 0x${id.toString(16)}`);
    }
  }
  if (!teilGelesen) {
    si.teilAnzahl = si.folder.map(() => 1);
    si.teilGroessen = si.folder.map(f => f.entpackt);
    si.teilCrcs = si.folder.map(f => f.crc);
  }
  return si;
}

function filetimeIso(ft: bigint): string | null {
  if (ft === 0n) return null;
  const ms = (ft - 116444736000000000n) / 10000n;
  if (ms < 0n || ms > 253402300799000n) return null;
  return new Date(Number(ms)).toISOString();
}

function leseDateien(r: BinaryReader, basis: number, ctx: AssetContext, headerGroesse: number, w: Warnungen): Datei[] {
  // Jede Datei braucht mindestens ein 2-Byte-Namensende im Header; darueber (und ueber MAX_EINTRAEGE_ABSURD) ist es unmoeglich.
  const n = zaehler(r, Math.min(Math.floor(headerGroesse / 2), MAX_EINTRAEGE_ABSURD), 'Anzahl Dateien');
  const dateien: Datei[] = [];
  for (let i = 0; i < n; i++) {
    dateien.push({ name: '', nameOffset: 0, nameLaenge: 0, leerStrom: false, leereDatei: false, anti: false, mtime: null, attribute: null });
  }
  let leerAnzahl = 0;
  for (;;) {
    ctx.pruefeAbbruch();
    const typ = r.u8();
    if (typ === 0x00) break;
    const groesse = zaehler(r, headerGroesse, 'Eigenschaftsgroesse');
    const posAbs = basis + r.position;
    const d = r.bytes(groesse);
    const pr = new BinaryReader(d, posAbs);
    if (typ === 0x0e) {
      const bits = bitVektor(pr, n);
      bits.forEach((b, i) => (dateien[i].leerStrom = b));
      leerAnzahl = bits.filter(Boolean).length;
    } else if (typ === 0x0f || typ === 0x10) {
      const bits = bitVektor(pr, leerAnzahl);
      let k = 0;
      for (const f of dateien) if (f.leerStrom) (typ === 0x0f ? (f.leereDatei = bits[k++]) : (f.anti = bits[k++]));
    } else if (typ === 0x11) {
      if (pr.u8() !== 0) throw new SzFehler('Namen liegen extern (nicht unterstuetzt)');
      let start = pr.position;
      for (let i = 0; i < n; i++) {
        // UTF-16LE bis zum 0-Paar.
        let ende = start;
        for (;;) {
          if (ende + 2 > d.length) throw new SzFehler('Dateiname nicht abgeschlossen');
          if (d[ende] === 0 && d[ende + 1] === 0) break;
          ende += 2;
        }
        dateien[i].name = Buffer.from(d.subarray(start, ende)).toString('utf16le');
        dateien[i].nameOffset = posAbs + start;
        dateien[i].nameLaenge = ende - start;
        start = ende + 2;
      }
    } else if (typ === 0x14) {
      const def = definiert(pr, n);
      if (pr.u8() !== 0) w.einmal('zeiten_extern', 'Zeitangaben liegen extern (nicht ausgewertet).');
      else def.forEach((x, i) => { if (x) dateien[i].mtime = filetimeIso(pr.u64le()); });
    } else if (typ === 0x15) {
      const def = definiert(pr, n);
      if (pr.u8() === 0) def.forEach((x, i) => { if (x) dateien[i].attribute = pr.u32le(); });
    }
    // 0x12/0x13 (Erstell-/Zugriffszeit), 0x19 (Dummy) u. a. sind fuer die Inspektion unwichtig.
  }
  return dateien;
}

function hexMethoden(si: StreamsInfo): string[] {
  const s = new Set<string>();
  for (const f of si.folder) for (const c of f.coder) s.add(c.name);
  return [...s];
}

function hatAes(si: StreamsInfo): boolean {
  return si.folder.some(f => f.coder.some(c => c.id === AES_ID));
}

async function inspiziere(src: AssetSource, ctx: AssetContext, res: AssetResult, w: Warnungen): Promise<void> {
  const meta = res.metadata;
  const fs = res.format_specific;
  if (src.size < 32) {
    w.add('sevenzip_zu_klein', `Datei (${src.size} Bytes) kleiner als der 7z-Signature-Header (32 Bytes).`);
    res.status = 'teilweise';
    return;
  }
  const sh = await src.readRange(0, 32);
  const r = new BinaryReader(sh, 0);
  const sig = r.bytes(6);
  if (Buffer.from(sig).toString('hex') !== '377abcaf271c') {
    w.add('kein_7z', 'Die Datei beginnt nicht mit der 7z-Signatur.');
    res.status = 'teilweise';
    return;
  }
  const major = r.u8();
  const minor = r.u8();
  const startCrc = r.u32le();
  const nextOffset = r.u64le();
  const nextGroesse = r.u64le();
  const nextCrc = r.u32le();
  meta.version = `${major}.${minor}`;
  const startCrcOk = crc32(sh, 12, 32) === startCrc;
  meta.start_header_crc_ok = startCrcOk;
  fs.next_header_offset = klemme(nextOffset);
  fs.next_header_groesse = klemme(nextGroesse);
  if (major !== 0) {
    w.add('sevenzip_version_unbekannt', `7z-Hauptversion ${major} ist unbekannt (bekannt: 0); Header wird nicht gelesen.`);
    res.status = 'teilweise';
    return;
  }
  if (!startCrcOk) {
    w.add('startheader_crc_falsch', 'Die Pruefsumme des Start-Headers stimmt nicht; Offsets sind unzuverlaessig, Header wird nicht gelesen.');
    res.status = 'teilweise';
    return;
  }
  if (nextGroesse === 0n) {
    if (nextOffset !== 0n) w.add('header_ausserhalb', 'NextHeaderSize ist 0, NextHeaderOffset aber nicht.');
    else meta.eintraege_gesamt = 0;
    meta.header_kodiert = false;
    meta.dateien = 0;
    return; // leeres Archiv
  }
  const start = 32n + nextOffset;
  if (start + nextGroesse > BigInt(src.size)) {
    w.add('header_ausserhalb', `Der Header (Offset ${start}, Groesse ${nextGroesse}) liegt ausserhalb der Datei (${src.size} Bytes): abgeschnitten oder manipuliert.`);
    res.status = 'teilweise';
    return;
  }
  if (nextGroesse > BigInt(HEADER_LESE_MAX)) {
    w.add('header_zu_gross', `Header (${nextGroesse} Bytes) ueber der Lesegrenze (${HEADER_LESE_MAX}).`);
    res.status = 'teilweise';
    return;
  }
  const hStart = Number(start);
  const hLen = Number(nextGroesse);
  const hb = await src.readRange(hStart, hLen);
  if (hb.length < hLen) {
    w.add('header_abgeschnitten', 'Der Header konnte nicht vollstaendig gelesen werden.');
    res.status = 'teilweise';
    return;
  }
  const hdrCrcOk = crc32(hb) === nextCrc;
  meta.header_crc_ok = hdrCrcOk;
  fs.header_offset = hStart;
  fs.header_groesse = hLen;
  if (!hdrCrcOk) {
    w.add('header_crc_falsch', 'Die Pruefsumme des Headers stimmt nicht (Beschaedigung oder Manipulation); Inhalt unsicher.');
    res.status = 'teilweise';
  }

  const hr = new BinaryReader(hb, hStart);
  try {
    const kennung = hr.u8();
    if (kennung === 0x17) {
      // EncodedHeader: der eigentliche Header ist gepackt (meist LZMA) und evtl. verschluesselt.
      meta.header_kodiert = true;
      const si = leseStreamsInfo(hr, ctx, hLen);
      meta.header_methoden = hexMethoden(si);
      const aes = hatAes(si);
      meta.header_verschluesselt = aes;
      fs.header_pack_position = 32 + si.packPos;
      fs.header_pack_groessen = si.packGroessen;
      w.add(
        'header_komprimiert_oder_verschluesselt',
        `Der Header ist ${aes ? 'verschluesselt' : 'komprimiert'} (${hexMethoden(si).join('+')}); ohne Dekoder gibt es kein Inhaltsverzeichnis.`
      );
      if (aes) w.add('archiv_verschluesselt', 'Der Archivheader ist verschluesselt: auch die Dateinamen sind nicht lesbar.');
      res.status = 'teilweise';
      return;
    }
    if (kennung !== 0x01) throw new SzFehler(`Unbekannte Header-Kennung 0x${kennung.toString(16)}`);
    meta.header_kodiert = false;
    await leseHeader(hr, hStart, hLen, src, ctx, res, w);
  } catch (e) {
    if (e instanceof SzAbsurd) {
      meta.bombe_verdacht = true;
      fs.bombe_gruende = [`absurde_zaehler:${e.message}`];
      w.add('archiv_bombe_verdacht', `Der Header enthaelt unmoegliche Zaehler (${e.message}); Archiv wirkt manipuliert oder wie eine Bombe. Inspektion abgebrochen.`);
      res.status = 'teilweise';
    } else if (e instanceof SzFehler) {
      w.add('sevenzip_header_unvollstaendig', `Header nicht vollstaendig auswertbar: ${e.message}`);
      res.status = 'teilweise';
    } else throw e;
  }
}

async function leseHeader(hr: BinaryReader, hStart: number, hLen: number, src: AssetSource, ctx: AssetContext, res: AssetResult, w: Warnungen): Promise<void> {
  const meta = res.metadata;
  const fs = res.format_specific;
  let si: StreamsInfo | null = null;
  let dateien: Datei[] = [];
  for (;;) {
    ctx.pruefeAbbruch();
    const id = hr.u8();
    if (id === 0x00) break;
    if (id === 0x02) {
      for (;;) {
        const t = hr.u8();
        if (t === 0x00) break;
        hr.skip(zaehler(hr, hLen, 'Archiv-Eigenschaft'));
      }
    } else if (id === 0x03) {
      leseStreamsInfo(hr, ctx, hLen);
    } else if (id === 0x04) {
      si = leseStreamsInfo(hr, ctx, hLen);
    } else if (id === 0x05) {
      dateien = leseDateien(hr, hStart, ctx, hLen, w);
    } else throw new SzFehler(`Header: unbekannte Kennung 0x${id.toString(16)}`);
  }

  // Zahlen und Bombenkriterien.
  const komprimiert = si ? si.packGroessen.reduce((a, b) => a + b, 0) : 0;
  const unkomprimiert = si ? si.folder.reduce((a, f) => a + f.entpackt, 0) : 0;
  const gruende = bombeGruende({
    dateigroesse: src.size,
    deklarierteEintraege: dateien.length,
    verzeichnisBytes: hLen,
    minEintragBytes: 0,
    unkomprimiert,
    komprimiert,
    maxEinzelFaktor: si ? si.folder.reduce((m, f, i) => Math.max(m, si!.packGroessen[i] > 0 ? f.entpackt / si!.packGroessen[i] : 0), 0) : 0,
    ueberlappungen: 0,
  });
  const istBombe = gruende.length > 0;
  if (istBombe) {
    w.add('archiv_bombe_verdacht', `Archiv wirkt wie eine Bombe/Manipulation (${gruende.join('; ')}). Nichts wird entpackt; nur ${OBJEKTE_BEI_BOMBE} Eintraege werden gelistet.`);
    res.status = 'teilweise';
    fs.bombe_gruende = gruende;
  }
  const aes = si ? hatAes(si) : false;
  if (aes) w.add('archiv_verschluesselt', 'Die Dateidaten sind mit 7zAES verschluesselt; Namen und Groessen sind lesbar, der Inhalt nicht.');

  // Dateien auf Teilstroeme abbilden.
  const objekte: AssetObject[] = [];
  const refs: AssetReference[] = [];
  let strom = 0;
  let verz = 0;
  let gefaehrlich = 0;
  let verschachtelt = 0;
  const grenze = istBombe ? Math.min(OBJEKTE_BEI_BOMBE, ctx.limits.maxObjects) : ctx.limits.maxObjects;
  const folderZuStrom: number[] = [];
  if (si) si.teilAnzahl.forEach((a, f) => { for (let j = 0; j < a; j++) folderZuStrom.push(f); });
  for (let i = 0; i < dateien.length; i++) {
    if (i % 1024 === 0) ctx.pruefeAbbruch();
    const f = dateien[i];
    const istVerz = f.leerStrom && !f.leereDatei ? true : f.attribute !== null && (f.attribute & 0x10) !== 0;
    if (istVerz) verz++;
    let groesse: number | null = null;
    let crc: number | null = null;
    let ordner: number | null = null;
    if (!f.leerStrom && si) {
      groesse = si.teilGroessen[strom] ?? null;
      crc = si.teilCrcs[strom] ?? null;
      ordner = folderZuStrom[strom] ?? null;
      strom++;
    } else if (f.leereDatei) groesse = 0;
    const gefahr = [...new Set(pfadGefahr(f.name))];
    if (gefahr.length) {
      gefaehrlich++;
      w.add('pfad_gefaehrlich', `Eintrag "${anzeigeName(f.name)}": ${gefahr.join(', ')}`);
    }
    const nest = !istVerz && istArchivEndung(f.name);
    if (nest) verschachtelt++;
    if (i >= grenze) continue;
    const unixModus = f.attribute !== null && (f.attribute & 0x8000) !== 0 ? f.attribute >>> 16 : null;
    const data: Record<string, unknown> = {
      groesse,
      verzeichnis: istVerz,
      leer: f.leereDatei || (f.leerStrom && !istVerz),
      anti: f.anti,
      mtime: f.mtime,
      attribute: f.attribute === null ? null : '0x' + f.attribute.toString(16).padStart(8, '0'),
      crc32: crc === null ? null : crc.toString(16).padStart(8, '0'),
      ordner,
      symlink: unixModus !== null && (unixModus & 0xf000) === 0xa000,
      pfad_gefaehrlich: gefahr.length > 0,
      gefahr,
    };
    if (nest) data.verschachtelt = { art: 'endung', format: null };
    objekte.push({ name: anzeigeName(f.name), kind: 'archive_entry', data, source_range: { offset: f.nameOffset, length: f.nameLaenge } });
    if (nest && refs.length < ctx.limits.maxObjects) refs.push({ target: anzeigeName(f.name), kind: 'archiv_inhalt' });
  }
  if (dateien.length > grenze) {
    w.add('objekte_gekappt', `${dateien.length} Eintraege, als Objekte ausgegeben werden ${grenze}.`);
    res.status = 'teilweise';
  }
  if (verschachtelt > 0) w.einmal('verschachtelte_archive', `${verschachtelt} Eintrag/Eintraege sehen wie Archive aus; sie werden NICHT geoeffnet (nur references vom Typ archiv_inhalt).`);

  meta.eintraege_gesamt = dateien.length;
  meta.dateien = dateien.length - verz;
  meta.verzeichnisse = verz;
  meta.folder = si ? si.folder.length : 0;
  meta.methoden = si ? hexMethoden(si) : [];
  meta.verschluesselt = aes;
  meta.unkomprimiert_gesamt = unkomprimiert;
  meta.komprimiert_gesamt = komprimiert;
  meta.faktor = komprimiert > 0 ? Math.round((unkomprimiert / komprimiert) * 100) / 100 : null;
  meta.gefaehrliche_pfade = gefaehrlich;
  meta.verschachtelte_archive = verschachtelt;
  meta.bombe_verdacht = istBombe;
  fs.pack_position = si ? 32 + si.packPos : null;
  fs.pack_groessen = si ? si.packGroessen.slice(0, 32) : [];
  res.objects = objekte;
  res.references = refs;
}

export const sevenZipInspector: AssetInspector = {
  id: 'archiv-7z',
  formats: ['7z'],
  extensions: ['.7z'],
  magic: [{ offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], format: '7z' }],
  version: SEVENZIP_VERSION,
  async inspect(src, ctx) {
    const w = new Warnungen();
    const res = erzeugeAssetResult(src.filePath, src.size, {
      asset_type: 'archive',
      format: '7z',
      inspector: 'archiv-7z',
      parser_version: SEVENZIP_VERSION,
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
