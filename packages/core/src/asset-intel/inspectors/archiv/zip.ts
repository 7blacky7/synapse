/**
 * MODUL: Archiv-Inspektor ZIP
 * ZWECK: Liest das Inhaltsverzeichnis (Central Directory) einer ZIP-Datei, OHNE etwas zu entpacken.
 *        Es werden nur Verzeichniseintraege gelesen (Name, Methode, Groessen, CRC, Flags, Zeit, Extra-Felder).
 *
 * SICHERHEIT (Pflicht, getestet):
 *  - Eintragsnamen sind Daten: sie werden bewertet (pfad_gefaehrlich), nie zum Oeffnen/Schreiben benutzt.
 *  - Bombenverdacht (archiv_bombe_verdacht): Gesamt-/Einzelfaktor, absolute Groesse, absurde Eintragszahl,
 *    ueberlappende Eintraege. Dann bricht die Inspektion kontrolliert ab (wenige Objekte, keine Sonden).
 *  - Verschachtelte Archive werden NUR gemeldet (references kind 'archiv_inhalt'), nie geoeffnet.
 *  - Verschluesselung (Flag Bit 0/6, Methode 99) wird erkannt und gemeldet.
 *
 * FORMAT: ZIP (APPNOTE 6.3.x): EOCD (Rueckwaertssuche, begrenzt), ZIP64-EOCD + Locator, Selbstextraktor-Praefix
 * wird ueber die Lage des Verzeichnisses ausgeglichen. JAR/APK/DOCX/XLSX/ODT/... werden nur als metadata.hint
 * aus Eintragsnamen abgeleitet. Abgrenzung zu .usdz macht ein anderer Inspektor ueber die Endung.
 */

import { BinaryReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetReference, AssetResult, AssetSource } from '../../types.js';
import {
  OBJEKTE_BEI_BOMBE,
  MAX_EINTRAEGE_LAUF,
  Warnungen,
  anzeigeName,
  archivMagic,
  bombeGruende,
  cp437,
  dosZeitIso,
  faengFehler,
  istArchivEndung,
  klemme,
  pfadGefahr,
  verlaesstWurzel,
} from './sicherheit.js';

export const ZIP_VERSION = 1;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CD = 0x02014b50;
const SIG_LOKAL = 0x04034b50;
/** Groesstes Verzeichnis, das ueberhaupt gelesen wird (mehr wird gekappt + Warnung). */
const CD_LESE_MAX = 16 * 1024 * 1024;
/** So viele Eintraege bekommen eine Sonde in den lokalen Header (Magic des Inhalts, Symlink-Ziel). */
const SONDEN_MAX = 100;
const EOCD_MIN = 22;
const EOCD_SUCHE = EOCD_MIN + 65535;

const METHODEN: Record<number, string> = {
  0: 'gespeichert',
  8: 'deflate',
  9: 'deflate64',
  12: 'bzip2',
  14: 'lzma',
  93: 'zstd',
  95: 'xz',
  98: 'ppmd',
  99: 'aes',
};

interface Eocd {
  pos: number;
  disk: number;
  cdDisk: number;
  eintraegeDisk: number;
  eintraege: number;
  cdGroesse: number;
  cdOffset: number;
  kommentar: string;
  kommentarLaenge: number;
  zip64: boolean;
  zip64Pos: number | null;
  zip64Fehler: string | null;
}

interface ZipEintrag {
  name: string;
  unicodeName: string | null;
  methode: number;
  methodeEigentlich: number | null;
  aesStaerke: number | null;
  flags: number;
  crc: number;
  komprimiert: number;
  unkomprimiert: number;
  lokalOffset: number;
  mtime: string | null;
  kommentar: string | null;
  extraLaenge: number;
  extraIds: number[];
  extraKaputt: boolean;
  utf8: boolean;
  verzeichnis: boolean;
  symlink: boolean;
  verschluesselt: boolean;
  cdPos: number;
  cdLaenge: number;
  nameLaenge: number;
  /** Ergebnisse der Sonde. */
  lokalUngueltig: boolean;
  verschachtelt: { art: 'endung' | 'magic'; format: string | null } | null;
  symlinkZiel: string | null;
  ausserhalb: boolean;
  groessenWiderspruch: boolean;
  /** Gefahrengruende des Pfads (leer = unauffaellig). */
  gefahr: string[];
}

/** Sucht den End-of-Central-Directory-Satz in den letzten 64 KiB + 22 Bytes. */
async function findeEocd(src: AssetSource, w: Warnungen): Promise<Eocd | null> {
  const len = Math.min(src.size, EOCD_SUCHE);
  const basis = src.size - len;
  const buf = await src.readRange(basis, len);
  let treffer = -1;
  // Erste Runde: der Kommentar reicht GENAU bis zum Dateiende; zweite Runde: er passt wenigstens hinein.
  for (const streng of [true, false]) {
    for (let i = buf.length - EOCD_MIN; i >= 0; i--) {
      if (buf[i] !== 0x50 || buf[i + 1] !== 0x4b || buf[i + 2] !== 0x05 || buf[i + 3] !== 0x06) continue;
      const kl = buf.readUInt16LE(i + 20);
      const ende = i + EOCD_MIN + kl;
      if (streng ? ende === buf.length : ende <= buf.length) {
        treffer = i;
        break;
      }
    }
    if (treffer >= 0) {
      if (!streng) w.add('zip_daten_nach_eocd', 'Nach dem End-of-Central-Directory folgen Zusatzbytes (angehaengte Daten).');
      break;
    }
  }
  if (treffer < 0) return null;
  const r = new BinaryReader(buf.subarray(treffer, treffer + EOCD_MIN), basis + treffer);
  r.skip(4);
  const e: Eocd = {
    pos: basis + treffer,
    disk: r.u16le(),
    cdDisk: r.u16le(),
    eintraegeDisk: r.u16le(),
    eintraege: r.u16le(),
    cdGroesse: r.u32le(),
    cdOffset: r.u32le(),
    kommentar: '',
    kommentarLaenge: r.u16le(),
    zip64: false,
    zip64Pos: null,
    zip64Fehler: null,
  };
  e.kommentar = buf.toString('utf8', treffer + EOCD_MIN, Math.min(buf.length, treffer + EOCD_MIN + Math.min(e.kommentarLaenge, 500)));

  // ZIP64: Locator steht unmittelbar vor dem EOCD.
  const locPos = e.pos - 20;
  if (locPos >= 0) {
    const loc = await src.readRange(locPos, 20);
    if (loc.length === 20 && loc.readUInt32LE(0) === SIG_LOC64) {
      const lr = new BinaryReader(loc, locPos);
      lr.skip(4);
      lr.u32le();
      let angegeben: number;
      try {
        angegeben = lr.u64leZahl();
      } catch {
        angegeben = -1;
      }
      e.zip64 = true;
      for (const kandidat of [angegeben, locPos - 56]) {
        if (kandidat < 0 || kandidat + 56 > src.size) continue;
        const b = await src.readRange(kandidat, 56);
        if (b.length === 56 && b.readUInt32LE(0) === SIG_EOCD64) {
          const rr = new BinaryReader(b, kandidat);
          rr.skip(4);
          rr.u64le(); // Restgroesse des Satzes
          rr.u16le();
          rr.u16le();
          e.disk = rr.u32le();
          e.cdDisk = rr.u32le();
          e.eintraegeDisk = klemme(rr.u64le());
          e.eintraege = klemme(rr.u64le());
          e.cdGroesse = klemme(rr.u64le());
          e.cdOffset = klemme(rr.u64le());
          e.zip64Pos = kandidat;
          break;
        }
      }
      if (e.zip64Pos === null) e.zip64Fehler = 'ZIP64-Locator vorhanden, aber kein gueltiger ZIP64-EOCD-Satz an der angegebenen Stelle.';
    }
  }
  // Saettigungswerte ohne gueltigen ZIP64-Satz heissen: ZIP64 war gemeint, ist aber kaputt.
  if (e.zip64Pos === null && (e.eintraege === 0xffff || e.cdOffset === 0xffffffff || e.cdGroesse === 0xffffffff)) {
    e.zip64 = true;
    e.zip64Fehler ??= 'EOCD enthaelt ZIP64-Saettigungswerte, aber es gibt keinen ZIP64-Satz.';
  }
  return e;
}

/** Liest die Extra-Felder eines Verzeichniseintrags (ZIP64, Unicode-Pfad, AES). */
function leseExtra(extra: Buffer, e: ZipEintrag, satt: { u: boolean; c: boolean; o: boolean }): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const sz = extra.readUInt16LE(p + 2);
    const start = p + 4;
    if (start + sz > extra.length) {
      e.extraKaputt = true;
      return;
    }
    if (e.extraIds.length < 16) e.extraIds.push(id);
    const d = extra.subarray(start, start + sz);
    if (id === 0x0001) {
      let q = 0;
      const nimm = (): number | null => {
        if (q + 8 > d.length) return null;
        const v = klemme(d.readBigUInt64LE(q));
        q += 8;
        return v;
      };
      if (satt.u) e.unkomprimiert = nimm() ?? e.unkomprimiert;
      if (satt.c) e.komprimiert = nimm() ?? e.komprimiert;
      if (satt.o) e.lokalOffset = nimm() ?? e.lokalOffset;
    } else if (id === 0x7075 && d.length >= 5 && d[0] === 1) {
      // Info-ZIP Unicode-Pfad: gilt nur, wenn der CRC zum Standardnamen passt; hier reicht uns der Wert zur Gefahrenpruefung.
      e.unicodeName = d.toString('utf8', 5);
    } else if (id === 0x9901 && d.length >= 7) {
      e.aesStaerke = d[4];
      e.methodeEigentlich = d.readUInt16LE(5);
    }
    p = start + sz;
  }
}

interface VerzeichnisLauf {
  eintraege: ZipEintrag[];
  gekappt: boolean;
  abgeschnitten: boolean;
  beschaedigt: boolean;
  /** Kleinste gesehene Eintragsgroesse im Verzeichnis (Bytes). */
  kleinsterSatz: number;
}

function leseVerzeichnis(buf: Buffer, basis: number, praefix: number, ctx: AssetContext): VerzeichnisLauf {
  const lauf: VerzeichnisLauf = { eintraege: [], gekappt: false, abgeschnitten: false, beschaedigt: false, kleinsterSatz: Infinity };
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (lauf.eintraege.length >= MAX_EINTRAEGE_LAUF) {
      lauf.gekappt = true;
      break;
    }
    if (lauf.eintraege.length % 1024 === 0) ctx.pruefeAbbruch();
    if (buf.readUInt32LE(pos) !== SIG_CD) {
      lauf.beschaedigt = true;
      break;
    }
    if (pos + 46 > buf.length) {
      lauf.abgeschnitten = true;
      break;
    }
    const r = new BinaryReader(buf.subarray(pos, pos + 46), basis + pos);
    r.skip(4);
    r.u8();
    const os = r.u8();
    r.u16le();
    const flags = r.u16le();
    const methode = r.u16le();
    const zeit = r.u16le();
    const datum = r.u16le();
    const crc = r.u32le();
    const cs = r.u32le();
    const us = r.u32le();
    const nl = r.u16le();
    const el = r.u16le();
    const cl = r.u16le();
    r.u16le(); // Start-Disk
    r.u16le(); // interne Attribute
    const ea = r.u32le();
    const lo = r.u32le();
    const gesamt = 46 + nl + el + cl;
    if (pos + gesamt > buf.length) {
      lauf.abgeschnitten = true;
      break;
    }
    const utf8 = (flags & 0x800) !== 0;
    const name = utf8 ? buf.toString('utf8', pos + 46, pos + 46 + nl) : cp437(buf, pos + 46, pos + 46 + nl);
    const unixModus = os === 3 ? ea >>> 16 : 0;
    const e: ZipEintrag = {
      name,
      unicodeName: null,
      methode,
      methodeEigentlich: null,
      aesStaerke: null,
      flags,
      crc,
      komprimiert: cs,
      unkomprimiert: us,
      lokalOffset: lo,
      mtime: dosZeitIso(datum, zeit),
      kommentar: cl > 0 ? (utf8 ? buf.toString('utf8', pos + 46 + nl + el, pos + 46 + nl + el + Math.min(cl, 200)) : cp437(buf, pos + 46 + nl + el, pos + 46 + nl + el + Math.min(cl, 200))) : null,
      extraLaenge: el,
      extraIds: [],
      extraKaputt: false,
      utf8,
      verzeichnis: name.endsWith('/') || name.endsWith('\\') || (unixModus & 0xf000) === 0x4000 || (os !== 3 && (ea & 0x10) !== 0),
      symlink: (unixModus & 0xf000) === 0xa000,
      verschluesselt: (flags & 0x1) !== 0 || (flags & 0x40) !== 0 || methode === 99,
      cdPos: basis + pos,
      cdLaenge: gesamt,
      nameLaenge: nl,
      lokalUngueltig: false,
      verschachtelt: null,
      symlinkZiel: null,
      ausserhalb: false,
      groessenWiderspruch: false,
      gefahr: [],
    };
    if (el > 0) {
      leseExtra(buf.subarray(pos + 46 + nl, pos + 46 + nl + el), e, { u: us === 0xffffffff, c: cs === 0xffffffff, o: lo === 0xffffffff });
    }
    e.lokalOffset += praefix;
    if (gesamt < lauf.kleinsterSatz) lauf.kleinsterSatz = gesamt;
    lauf.eintraege.push(e);
    pos += gesamt;
  }
  return lauf;
}

/** Leitet aus den Eintragsnamen (und einem gelesenen 'mimetype') ab, um welche Art ZIP es sich handelt. */
function leiteHint(namen: Set<string>, mimetype: string | null): string | null {
  if (mimetype) {
    const m = mimetype.trim().toLowerCase();
    if (m === 'application/epub+zip') return 'epub';
    if (m.startsWith('application/vnd.oasis.opendocument.')) {
      const art = m.slice('application/vnd.oasis.opendocument.'.length);
      const karte: Record<string, string> = { text: 'odt', spreadsheet: 'ods', presentation: 'odp', graphics: 'odg' };
      return karte[art] ?? 'odf';
    }
  }
  if (namen.has('[content_types].xml')) {
    if (namen.has('word/document.xml')) return 'docx';
    if (namen.has('xl/workbook.xml')) return 'xlsx';
    if (namen.has('ppt/presentation.xml')) return 'pptx';
    if (namen.has('visio/document.xml')) return 'vsdx';
    return 'ooxml';
  }
  if (namen.has('androidmanifest.xml') && namen.has('classes.dex')) return 'apk';
  if (namen.has('meta-inf/manifest.mf')) return namen.has('web-inf/web.xml') ? 'war' : 'jar';
  if (namen.has('appxmanifest.xml')) return 'appx';
  if (namen.has('mimetype') && namen.has('meta-inf/manifest.xml')) return 'odf';
  return null;
}

function verzeichnisVon(name: string): string {
  const i = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return i >= 0 ? name.slice(0, i) : '';
}

/** Sonde in den lokalen Header: Signatur pruefen, bei gespeicherten Eintraegen die ersten Bytes (Magic) lesen. */
async function sondiere(src: AssetSource, e: ZipEintrag, gross: number): Promise<{ mimetype: string | null }> {
  let mimetype: string | null = null;
  if (e.lokalOffset + 30 > src.size) return { mimetype };
  const kopf = await src.readRange(e.lokalOffset, 30);
  if (kopf.length < 30 || kopf.readUInt32LE(0) !== SIG_LOKAL) {
    e.lokalUngueltig = true;
    return { mimetype };
  }
  if (e.methode !== 0 || e.verschluesselt || e.verzeichnis || e.unkomprimiert < 1) return { mimetype };
  const nl = kopf.readUInt16LE(26);
  const el = kopf.readUInt16LE(28);
  const datenStart = e.lokalOffset + 30 + nl + el;
  const n = Math.min(e.unkomprimiert, e.symlink ? 512 : e.name.toLowerCase() === 'mimetype' ? 100 : Math.max(16, gross));
  if (datenStart + e.unkomprimiert > src.size) return { mimetype };
  const daten = await src.readRange(datenStart, n);
  if (e.symlink && daten.length === e.unkomprimiert) e.symlinkZiel = daten.toString('utf8');
  if (e.name.toLowerCase() === 'mimetype') mimetype = daten.toString('latin1');
  if (!e.verschachtelt) {
    const m = archivMagic(daten);
    if (m && m !== 'elf') e.verschachtelt = { art: 'magic', format: m };
  }
  return { mimetype };
}

/** Rettungsweg ohne Verzeichnis: lokale Header von vorn lesen (abgeschnittene ZIPs). */
async function rettungLokaleHeader(src: AssetSource, ctx: AssetContext, maxObjekte: number): Promise<Array<{ name: string; methode: number; komprimiert: number; unkomprimiert: number; crc: number; pos: number; laenge: number; utf8: boolean; verschluesselt: boolean; stream: boolean }>> {
  const aus: Array<{ name: string; methode: number; komprimiert: number; unkomprimiert: number; crc: number; pos: number; laenge: number; utf8: boolean; verschluesselt: boolean; stream: boolean }> = [];
  let pos = 0;
  while (aus.length < maxObjekte && pos + 30 <= src.size) {
    ctx.pruefeAbbruch();
    const k = await src.readRange(pos, 30);
    if (k.length < 30 || k.readUInt32LE(0) !== SIG_LOKAL) break;
    const flags = k.readUInt16LE(6);
    const methode = k.readUInt16LE(8);
    const crc = k.readUInt32LE(14);
    const cs = k.readUInt32LE(18);
    const us = k.readUInt32LE(22);
    const nl = k.readUInt16LE(26);
    const el = k.readUInt16LE(28);
    const nb = await src.readRange(pos + 30, nl);
    if (nb.length < nl) break;
    const utf8 = (flags & 0x800) !== 0;
    const stream = (flags & 0x8) !== 0;
    aus.push({ name: utf8 ? nb.toString('utf8') : cp437(nb, 0, nb.length), methode, komprimiert: cs, unkomprimiert: us, crc, pos, laenge: 30 + nl, utf8, verschluesselt: (flags & 0x41) !== 0, stream });
    if (stream && cs === 0) break; // Datengroesse steht erst hinter den Daten: ohne Verzeichnis nicht ueberspringbar.
    pos += 30 + nl + el + cs;
  }
  return aus;
}

async function inspiziere(src: AssetSource, ctx: AssetContext, res: AssetResult, w: Warnungen): Promise<void> {
  const maxObj = ctx.limits.maxObjects;
  if (src.size < EOCD_MIN) {
    w.add('zip_zu_klein', `Datei (${src.size} Bytes) kleiner als ein ZIP-Endsatz (${EOCD_MIN} Bytes).`);
    res.status = 'teilweise';
    return;
  }
  const eocd = await findeEocd(src, w);
  if (!eocd) {
    // Rettung: lokale Header von vorn.
    const lok = await rettungLokaleHeader(src, ctx, maxObj);
    w.add('zip_verzeichnis_fehlt', 'Kein End-of-Central-Directory gefunden (Datei abgeschnitten oder kein ZIP); Eintraege aus lokalen Headern gelesen.');
    res.status = 'teilweise';
    res.metadata = { eintraege_gelesen: lok.length, quelle: 'lokale_header' };
    for (const l of lok) {
      const gefahr = pfadGefahr(l.name);
      if (gefahr.length) w.add('pfad_gefaehrlich', `Eintrag "${anzeigeName(l.name)}": ${gefahr.join(', ')}`);
      res.objects.push({
        name: anzeigeName(l.name),
        kind: 'archive_entry',
        data: {
          quelle: 'lokaler_header',
          methode: l.methode,
          methode_name: METHODEN[l.methode] ?? 'unbekannt',
          komprimiert: l.komprimiert,
          unkomprimiert: l.unkomprimiert,
          crc32: l.crc.toString(16).padStart(8, '0'),
          verschluesselt: l.verschluesselt,
          pfad_gefaehrlich: gefahr.length > 0,
          gefahr,
        },
        source_range: { offset: l.pos, length: l.laenge },
      });
    }
    return;
  }

  const meta = res.metadata;
  meta.zip64 = eocd.zip64;
  if (eocd.zip64Fehler) {
    w.add('zip64_ungueltig', eocd.zip64Fehler);
    res.status = 'teilweise';
  }
  if (eocd.kommentar) meta.kommentar = eocd.kommentar;
  const mehrteilig = eocd.disk !== 0 || eocd.cdDisk !== 0 || eocd.eintraegeDisk !== eocd.eintraege;
  meta.mehrteilig = mehrteilig;
  if (mehrteilig) {
    w.add('mehrteiliges_archiv', `Mehr-Datei-Archiv (Disk ${eocd.disk}, Verzeichnis auf Disk ${eocd.cdDisk}): die Daten liegen in weiteren Dateien, diese Datei allein ist unvollstaendig.`);
    res.status = 'teilweise';
  }
  const fs: Record<string, unknown> = res.format_specific;
  fs.eocd_offset = eocd.pos;
  fs.cd_offset = eocd.cdOffset;
  fs.cd_groesse = eocd.cdGroesse;
  fs.eintraege_deklariert = eocd.eintraege;
  fs.zip64_eocd_offset = eocd.zip64Pos;

  // Bombenpruefung 1 (vor dem Lesen): Verzeichnisangaben gegen Dateigroesse.
  const bombe: string[] = [];
  if (eocd.cdGroesse > src.size || eocd.cdOffset > src.size) {
    w.add('zip_verzeichnis_ausserhalb', `Verzeichnis (Offset ${eocd.cdOffset}, Groesse ${eocd.cdGroesse}) liegt ausserhalb der Datei (${src.size} Bytes).`);
    res.status = 'teilweise';
    if (eocd.eintraege * 46 > src.size) bombe.push(`eintragszahl_passt_nicht_zur_groesse:${eocd.eintraege}`);
    meta.eintraege_gesamt = eocd.eintraege;
    if (bombe.length) {
      w.add('archiv_bombe_verdacht', `Archiv wirkt wie eine Bombe/Manipulation (${bombe.join('; ')}); Inspektion abgebrochen.`);
      meta.bombe_verdacht = true;
      fs.bombe_gruende = bombe;
    }
    return;
  }

  // Praefix (Selbstextraktor): wo liegt das Verzeichnis WIRKLICH?
  const cdEnde = eocd.zip64Pos ?? eocd.pos;
  let praefix = 0;
  if (eocd.cdGroesse > 0) {
    const direkt = await src.readRange(eocd.cdOffset, 4);
    if (!(direkt.length === 4 && direkt.readUInt32LE(0) === SIG_CD)) {
      const tatsaechlich = cdEnde - eocd.cdGroesse;
      const alt = tatsaechlich >= 0 ? await src.readRange(tatsaechlich, 4) : Buffer.alloc(0);
      if (alt.length === 4 && alt.readUInt32LE(0) === SIG_CD && tatsaechlich - eocd.cdOffset >= 0) praefix = tatsaechlich - eocd.cdOffset;
      else {
        w.add('zip_verzeichnis_ungueltig', 'An der im Endsatz angegebenen Stelle steht kein Central Directory.');
        res.status = 'teilweise';
        meta.eintraege_gesamt = eocd.eintraege;
        return;
      }
    }
  }
  meta.praefix_bytes = praefix;
  if (praefix > 0) {
    w.add('praefix_vorhanden', `${praefix} Bytes vor dem ZIP-Teil (Selbstextraktor oder angehaengtes Archiv); Offsets um diesen Wert korrigiert.`);
    meta.selbstextraktor_verdacht = true;
  }

  // Verzeichnis lesen (gekappt).
  const lesen = Math.min(eocd.cdGroesse, CD_LESE_MAX);
  const cdBuf = lesen > 0 ? await src.readRange(eocd.cdOffset + praefix, lesen) : Buffer.alloc(0);
  const lauf = leseVerzeichnis(cdBuf, eocd.cdOffset + praefix, praefix, ctx);
  const alle = lauf.eintraege;
  const cdGekappt = eocd.cdGroesse > CD_LESE_MAX;
  if (cdGekappt) {
    w.add('verzeichnis_gekappt', `Verzeichnis (${eocd.cdGroesse} Bytes) nur bis ${CD_LESE_MAX} Bytes gelesen.`);
    res.status = 'teilweise';
  }
  if (lauf.gekappt) {
    w.add('verzeichnis_gekappt', `Mehr als ${MAX_EINTRAEGE_LAUF} Eintraege; nur die ersten ausgewertet.`);
    res.status = 'teilweise';
  }
  if (lauf.abgeschnitten && !cdGekappt) {
    w.add('verzeichnis_abgeschnitten', 'Das Central Directory endet mitten in einem Eintrag.');
    res.status = 'teilweise';
  }
  if (lauf.beschaedigt) {
    w.add('verzeichnis_beschaedigt', `Nach ${alle.length} Eintraegen steht keine gueltige Eintragssignatur mehr.`);
    res.status = 'teilweise';
  }
  if (!cdGekappt && !lauf.gekappt && !lauf.abgeschnitten && !lauf.beschaedigt && alle.length !== eocd.eintraege) {
    w.add('eintragszahl_abweichend', `Endsatz nennt ${eocd.eintraege} Eintraege, im Verzeichnis stehen ${alle.length}.`);
    res.status = 'teilweise';
  }

  // Statistik, Gefahren, Ueberlappung.
  let komprimiert = 0;
  let unkomprimiert = 0;
  let maxFaktor = 0;
  let dateien = 0;
  let verzeichnisse = 0;
  let verschluesselt = 0;
  let gefaehrlich = 0;
  let aussen = 0;
  const methoden: Record<string, number> = {};
  const namenSet = new Set<string>();
  const doppelt = new Set<string>();
  for (let i = 0; i < alle.length; i++) {
    if (i % 2048 === 0) ctx.pruefeAbbruch();
    const e = alle[i];
    komprimiert += e.komprimiert;
    unkomprimiert += e.unkomprimiert;
    if (e.komprimiert > 0) maxFaktor = Math.max(maxFaktor, e.unkomprimiert / e.komprimiert);
    else if (e.unkomprimiert > 0 && !e.verzeichnis) maxFaktor = Infinity;
    if (e.verzeichnis) verzeichnisse++;
    else dateien++;
    if (e.verschluesselt) verschluesselt++;
    const mn = METHODEN[e.methode] ?? `methode_${e.methode}`;
    methoden[mn] = (methoden[mn] ?? 0) + 1;
    const gefahr = [...pfadGefahr(e.name), ...(e.unicodeName !== null ? pfadGefahr(e.unicodeName) : [])];
    if (e.unicodeName !== null && e.unicodeName !== e.name) w.einmal('unicode_pfad_abweichend', `Eintrag "${anzeigeName(e.name)}" hat einen abweichenden Unicode-Pfad (Extra-Feld 0x7075); beide wurden geprueft.`);
    e.gefahr = [...new Set(gefahr)];
    if (gefahr.length) {
      gefaehrlich++;
      w.add('pfad_gefaehrlich', `Eintrag "${anzeigeName(e.name)}": ${[...new Set(gefahr)].join(', ')}`);
    }
    if (e.lokalOffset + 30 > src.size) {
      e.ausserhalb = true;
      aussen++;
      w.add('eintrag_ausserhalb', `Eintrag "${anzeigeName(e.name)}": lokaler Header (Offset ${e.lokalOffset}) liegt ausserhalb der Datei (${src.size} Bytes).`);
    } else if (e.lokalOffset + 30 + e.nameLaenge + e.komprimiert > src.size) {
      e.ausserhalb = true;
      aussen++;
      w.add('eintrag_ausserhalb', `Eintrag "${anzeigeName(e.name)}": Daten (${e.komprimiert} Bytes ab ${e.lokalOffset}) reichen ueber das Dateiende (${src.size} Bytes).`);
    }
    if (e.methode === 0 && !e.verschluesselt && e.unkomprimiert !== e.komprimiert) e.groessenWiderspruch = true;
    const norm = e.name.toLowerCase();
    if (namenSet.has(norm)) doppelt.add(norm);
    namenSet.add(norm);
    if (!e.verzeichnis && istArchivEndung(e.name)) e.verschachtelt = { art: 'endung', format: null };
  }
  if (doppelt.size > 0) {
    w.add('doppelte_eintragsnamen', `${doppelt.size} Eintragsname(n) kommen mehrfach vor (ein naiver Entpacker ueberschreibt dabei Dateien), z. B. "${anzeigeName([...doppelt][0])}".`);
  }

  // Ueberlappende Datenbereiche.
  const ordnung = alle.map((_, i) => i).sort((a, b) => alle[a].lokalOffset - alle[b].lokalOffset);
  let ueberlappungen = 0;
  let maxEnde = -1;
  for (const idx of ordnung) {
    const e = alle[idx];
    const start = e.lokalOffset;
    const ende = start + 30 + e.nameLaenge + e.komprimiert;
    if (start < maxEnde) ueberlappungen++;
    if (ende > maxEnde) maxEnde = ende;
  }

  const gruende = bombeGruende({
    dateigroesse: src.size,
    deklarierteEintraege: eocd.eintraege,
    verzeichnisBytes: eocd.cdGroesse,
    minEintragBytes: Number.isFinite(lauf.kleinsterSatz) ? lauf.kleinsterSatz : 0,
    unkomprimiert,
    komprimiert,
    maxEinzelFaktor: maxFaktor,
    ueberlappungen,
  });
  const istBombe = gruende.length > 0;
  if (istBombe) {
    w.add('archiv_bombe_verdacht', `Archiv wirkt wie eine Zip-Bombe oder Manipulation (${gruende.join('; ')}). Nichts wird entpackt; Inspektion nur noch oberflaechlich (${OBJEKTE_BEI_BOMBE} Eintraege).`);
    res.status = 'teilweise';
    meta.bombe_verdacht = true;
    fs.bombe_gruende = gruende;
  }
  if (aussen > 0) res.status = 'teilweise';
  if (verschluesselt > 0) {
    w.add('archiv_verschluesselt', `${verschluesselt} Eintrag/Eintraege sind verschluesselt; Inhalt nicht lesbar (Namen und Groessen schon).`);
  }

  // Sonden (nicht bei Bombenverdacht).
  let mimetype: string | null = null;
  if (!istBombe) {
    const n = Math.min(alle.length, SONDEN_MAX);
    for (let i = 0; i < n; i++) {
      ctx.pruefeAbbruch();
      const e = alle[i];
      if (e.ausserhalb) continue;
      const s = await sondiere(src, e, 16);
      if (s.mimetype) mimetype = s.mimetype;
      if (e.lokalUngueltig) w.add('lokaler_header_ungueltig', `Eintrag "${anzeigeName(e.name)}": an Offset ${e.lokalOffset} steht kein lokaler ZIP-Header.`);
      if (e.symlinkZiel !== null && verlaesstWurzel(verzeichnisVon(e.name), e.symlinkZiel)) {
        w.add('link_ziel_ausserhalb', `Symlink "${anzeigeName(e.name)}" zeigt auf "${anzeigeName(e.symlinkZiel)}" ausserhalb des Archivs.`);
      }
    }
    if (alle.length > SONDEN_MAX) w.einmal('sonden_begrenzt', `Lokale Header/Inhalts-Magic nur fuer die ersten ${SONDEN_MAX} Eintraege geprueft.`);
  }

  const hint = leiteHint(namenSet, mimetype);
  meta.hint = hint;
  meta.eintraege_gesamt = eocd.eintraege;
  meta.eintraege_gelesen = alle.length;
  meta.dateien = dateien;
  meta.verzeichnisse = verzeichnisse;
  meta.unkomprimiert_gesamt = unkomprimiert;
  meta.komprimiert_gesamt = komprimiert;
  meta.faktor = komprimiert > 0 ? Math.round((unkomprimiert / komprimiert) * 100) / 100 : null;
  meta.verschluesselte_eintraege = verschluesselt;
  meta.gefaehrliche_pfade = gefaehrlich;
  meta.ueberlappende_eintraege = ueberlappungen;
  meta.methoden = methoden;
  meta.bombe_verdacht = istBombe;

  // Objekte + Referenzen.
  const grenze = istBombe ? Math.min(OBJEKTE_BEI_BOMBE, maxObj) : maxObj;
  const objekte: AssetObject[] = [];
  const refs: AssetReference[] = [];
  let verschachtelt = 0;
  for (let i = 0; i < alle.length; i++) {
    const e = alle[i];
    if (e.verschachtelt) verschachtelt++;
    if (i >= grenze) continue;
    const gefahr = e.gefahr;
    const data: Record<string, unknown> = {
      methode: e.methode,
      methode_name: METHODEN[e.methode] ?? 'unbekannt',
      komprimiert: e.komprimiert,
      unkomprimiert: e.unkomprimiert,
      crc32: e.crc.toString(16).padStart(8, '0'),
      verschluesselt: e.verschluesselt,
      utf8: e.utf8,
      mtime: e.mtime,
      verzeichnis: e.verzeichnis,
      symlink: e.symlink,
      lokaler_header_offset: e.lokalOffset,
      extra_laenge: e.extraLaenge,
      extra_ids: e.extraIds.map(x => '0x' + x.toString(16).padStart(4, '0')),
      pfad_gefaehrlich: gefahr.length > 0,
      gefahr,
    };
    if (e.kommentar) data.kommentar = e.kommentar;
    if (e.unicodeName !== null && e.unicodeName !== e.name) data.unicode_name = anzeigeName(e.unicodeName);
    if (e.aesStaerke !== null) {
      data.aes_staerke = e.aesStaerke === 1 ? 128 : e.aesStaerke === 2 ? 192 : e.aesStaerke === 3 ? 256 : null;
      data.methode_eigentlich = e.methodeEigentlich;
    }
    if (e.extraKaputt) data.extra_kaputt = true;
    if (e.ausserhalb) data.ausserhalb_der_datei = true;
    if (e.lokalUngueltig) data.lokaler_header_ungueltig = true;
    if (e.groessenWiderspruch) data.groessen_widerspruch = true;
    if (e.symlinkZiel !== null) data.symlink_ziel = anzeigeName(e.symlinkZiel);
    if (e.verschachtelt) data.verschachtelt = e.verschachtelt;
    objekte.push({ name: anzeigeName(e.name), kind: 'archive_entry', data, source_range: { offset: e.cdPos, length: e.cdLaenge } });
    if (e.verschachtelt && refs.length < maxObj) refs.push({ target: anzeigeName(e.name), kind: 'archiv_inhalt' });
  }
  meta.verschachtelte_archive = verschachtelt;
  if (verschachtelt > 0) {
    w.einmal('verschachtelte_archive', `${verschachtelt} Eintrag/Eintraege sehen wie Archive aus; sie werden NICHT geoeffnet (nur als references vom Typ archiv_inhalt gemeldet).`);
  }
  if (alle.length > grenze) {
    w.add('objekte_gekappt', `${alle.length} Eintraege, als Objekte ausgegeben werden ${grenze}.`);
    res.status = 'teilweise';
  }
  res.objects = objekte;
  res.references = refs;
}

export const zipInspector: AssetInspector = {
  id: 'archiv-zip',
  formats: ['zip'],
  extensions: ['.zip', '.jar', '.war', '.apk', '.aar', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub', '.xpi'],
  magic: [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], format: 'zip' },
    // Leeres ZIP besteht nur aus dem Endsatz.
    { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06], format: 'zip' },
  ],
  version: ZIP_VERSION,
  async inspect(src, ctx) {
    const w = new Warnungen();
    const res = erzeugeAssetResult(src.filePath, src.size, {
      asset_type: 'archive',
      format: 'zip',
      inspector: 'archiv-zip',
      parser_version: ZIP_VERSION,
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
