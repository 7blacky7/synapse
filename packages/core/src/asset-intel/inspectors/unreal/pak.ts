/**
 * MODUL: Unreal-Pak-Inspektor (.pak)
 * ZWECK: Liest den Footer (FPakInfo) vom Dateiende und — NUR wenn unverschluesselt und in einer
 *        bekannten Version — den Index mit der Eintragsliste. Entpackt nie etwas.
 *
 * FOOTER: Seine Groesse haengt von der Version ab, die erst IM Footer steht. Deshalb wird wie in
 * der Engine jede Kandidatenposition (neueste Version zuerst) geprueft und nur akzeptiert, wenn
 * dort die Magic 0x5A6F12E1 steht UND die gelesene Version zum Kandidatenlayout passt.
 *
 * INDEX:
 *  - v1..v9: flacher Index (MountPoint, Eintragszahl, je Eintrag Dateiname + FPakEntry).
 *  - v10/v11: primaerer Index (MountPoint, Zahl, Seed, Lage von PathHashIndex und
 *    FullDirectoryIndex, kodierte Eintraege, nicht kodierte Eintraege) + FullDirectoryIndex
 *    (Verzeichnis -> Datei -> Eintragsposition). Der PathHashIndex wird nicht gebraucht.
 *    Fehlt der FullDirectoryIndex: nur Kopf, 'index_version_nicht_unterstuetzt'.
 *  - verschluesselt: nichts davon -> 'index_verschluesselt'.
 * Jede Indexstufe wird gegen ihren SHA-1 aus der Stufe darueber geprueft.
 *
 *  - v12 (Utf8PakDirectory, UE 5.8): wie v11, Dateinamen im FullDirectoryIndex als FUtf8String
 *    (int32 Bytezahl OHNE Terminator + UTF-8-Bytes; String.cpp.inl). Footer-Groesse aendert sich
 *    ab v10 nicht mehr (FPakInfo::GetSerializedSize).
 *
 * GEPRUEFT GEGEN ECHTE DATEIEN: repak-Testpaks v5 und v11; mit UnrealPak 5.8.3 erzeugte v12-Paks
 * (unkomprimiert, Zlib, Oodle, Index verschluesselt, voll verschluesselt) gegen 'UnrealPak -List'.
 * v1..v4 und v6..v9 nur nach Spezifikation.
 */

import { createHash } from 'crypto';
import { BinaryReader } from '../../binary-reader.js';
import { AssetReadError } from '../../errors.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetResult, AssetSource } from '../../types.js';
import { UnrealFormatFehler, hatTraversal, i32, i64, leseFString, leseGuid } from './lesen.js';

export const PAK_MAGIC = 0x5a6f12e1;
const VERSION = 2;
/** Hoechste hier bekannte Pak-Version (PakFile_Version_Fnv64BugFix). */
export const PAK_HOECHSTE_VERSION = 12;

const PAK_VER = {
  NO_TIMESTAMPS: 2,
  COMPRESSION_ENCRYPTION: 3,
  INDEX_ENCRYPTION: 4,
  ENCRYPTION_KEY_GUID: 7,
  FNAME_BASED_COMPRESSION_METHOD: 8,
  FROZEN_INDEX: 9,
  PATH_HASH_INDEX: 10,
  UTF8_PAK_DIRECTORY: 12,
} as const;

const KOMPRESSIONS_NAME_LAENGE = 32;
const INDEX_MAX = 32 * 1024 * 1024;
const MAX_EINTRAEGE = 10_000_000;
const MAX_PFAD_ZEICHEN = 4096;
/** Kleinster moeglicher flacher Indexeintrag: leeres FString (4) + Offset/Size/USize (24) + Methode (1) + Hash (20). */
const MIN_EINTRAG = 4 + 24 + 1 + 20;

/** Ein Footer-Layout: Version, Zahl der Kompressionsnamen (nur v8: 4 oder 5). */
interface Layout {
  version: number;
  label: string;
  kompNamen: number;
}

/** Bytes vor der Magic: EncryptionKeyGuid (ab v7) + bEncryptedIndex (ab v4). */
function vorMagic(v: number): number {
  return (v >= PAK_VER.ENCRYPTION_KEY_GUID ? 16 : 0) + (v >= PAK_VER.INDEX_ENCRYPTION ? 1 : 0);
}

/** Gesamtgroesse des Footers fuer ein Layout. */
export function footerGroesse(l: Layout): number {
  return (
    vorMagic(l.version) +
    4 + 4 + 8 + 8 + 20 + // Magic, Version, IndexOffset, IndexSize, IndexHash
    (l.version === PAK_VER.FROZEN_INDEX ? 1 : 0) +
    (l.version >= PAK_VER.FNAME_BASED_COMPRESSION_METHOD ? l.kompNamen * KOMPRESSIONS_NAME_LAENGE : 0)
  );
}

/** Kandidaten, neueste zuerst (wie die Engine). v1..v3 haben dieselbe Groesse. */
const LAYOUTS: Layout[] = [
  { version: 12, label: 'v12', kompNamen: 5 },
  { version: 11, label: 'v11', kompNamen: 5 },
  { version: 10, label: 'v10', kompNamen: 5 },
  { version: 9, label: 'v9', kompNamen: 5 },
  { version: 8, label: 'v8b', kompNamen: 5 },
  { version: 8, label: 'v8a', kompNamen: 4 },
  { version: 7, label: 'v7', kompNamen: 0 },
  { version: 6, label: 'v6', kompNamen: 0 },
  { version: 5, label: 'v5', kompNamen: 0 },
  { version: 4, label: 'v4', kompNamen: 0 },
  { version: 3, label: 'v1-3', kompNamen: 0 },
];

interface Footer {
  layout: Layout;
  position: number;
  encryptionKeyGuid: string | null;
  encryptedIndex: boolean;
  version: number;
  indexOffset: number;
  indexSize: number;
  indexHash: string;
  frozen: boolean;
  kompressionen: string[];
}

/** Ein gelesener Eintrag (flach, nicht kodiert oder kodiert). */
interface Eintrag {
  offset: number;
  size: number;
  usize: number;
  methodeRoh: number;
  methode: string;
  hash: string | null;
  bloecke: number;
  verschluesselt: boolean;
  geloescht: boolean;
  blockGroesse: number | null;
}

/** Lage eines Unterindex im primaeren v10-Index. */
interface Unterindex {
  offset: number;
  size: number;
  hash_sha1: string;
  innerhalb_der_datei: boolean;
}

/** Rohe Kompressionsflags vor v8 (ECompressionFlags). */
const ALTE_KOMPRESSION: Record<number, string> = { 0: 'None', 1: 'Zlib', 2: 'Gzip', 4: 'Custom' };

async function inspiziere(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'archive',
    format: 'pak',
    inspector: 'unreal-pak',
    parser_version: VERSION,
  });
  const md = res.metadata;
  const fsp = res.format_specific;
  const teil = (code: string, message: string): void => {
    res.warnings.push({ code, message });
    if (res.status === 'ok') res.status = 'teilweise';
  };

  try {
    const footer = await sucheFooter(src, res);
    if (!footer) return res;
    md.pak_version = footer.version;
    md.footer_layout = footer.layout.label;
    md.index_offset = footer.indexOffset;
    md.index_groesse = footer.indexSize;
    md.index_verschluesselt = footer.encryptedIndex;
    md.kompressionsmethoden = footer.kompressionen;
    fsp.footer_position = footer.position;
    fsp.footer_groesse = footerGroesse(footer.layout);
    fsp.index_hash_sha1 = footer.indexHash;
    if (footer.encryptionKeyGuid !== null) {
      fsp.encryption_key_guid = footer.encryptionKeyGuid;
      md.verschluesselungsschluessel_gesetzt = !/^0+$/.test(footer.encryptionKeyGuid);
    }

    if (footer.indexOffset < 0 || footer.indexSize < 0 || footer.indexOffset + footer.indexSize > footer.position) {
      teil('index_ausserhalb', `Index ${footer.indexOffset}+${footer.indexSize} liegt nicht vor dem Footer (${footer.position}); nicht gelesen.`);
      return res;
    }
    if (footer.encryptedIndex) {
      teil('index_verschluesselt', 'Index ist verschluesselt (bEncryptedIndex); Eintraege nicht lesbar ohne Schluessel.');
      return res;
    }
    if (footer.frozen) {
      teil('index_eingefroren_nicht_unterstuetzt', 'Eingefrorener Index (v9 bIndexIsFrozen); Layout nicht unterstuetzt.');
      return res;
    }
    const ibuf = await leseGeprueft(src, ctx, footer.indexOffset, footer.indexSize, footer.indexHash, 'Index', teil);
    if (!ibuf) return res;
    md.index_hash_stimmt = ibuf.hashStimmt;

    const r = new BinaryReader(ibuf.daten, footer.indexOffset);
    const mount = leseFString(r, MAX_PFAD_ZEICHEN, 'MountPoint');
    const anzahl = i32(r);
    md.mount_point = mount;
    md.eintraege_angegeben = anzahl;
    if (anzahl < 0 || anzahl > MAX_EINTRAEGE) {
      throw new UnrealFormatFehler('zaehler_unplausibel', `Eintragszahl ${anzahl} (als uint32 ${anzahl >>> 0}) unplausibel.`);
    }

    let paare: Array<[string, Eintrag]>;
    if (footer.version >= PAK_VER.PATH_HASH_INDEX) {
      const v10 = await leseIndexV10(src, r, footer, anzahl, ctx, md, fsp, teil);
      if (!v10) return res;
      paare = v10;
    } else {
      if (anzahl * MIN_EINTRAG > r.remaining) {
        throw new UnrealFormatFehler('zaehler_unplausibel', `Eintragszahl ${anzahl} passt nicht in ${r.remaining} Index-Bytes.`);
      }
      paare = [];
      for (let i = 0; i < anzahl; i++) {
        if ((i & 1023) === 0) ctx.pruefeAbbruch();
        if (paare.length >= ctx.limits.maxObjects) break;
        const name = leseFString(r, MAX_PFAD_ZEICHEN, `Eintrag[${i}].Name`);
        paare.push([name, leseEintrag(r, footer, `Eintrag[${i}]`)]);
      }
    }
    if (paare.length < anzahl && paare.length >= ctx.limits.maxObjects) {
      teil('objekte_gekappt', `${anzahl} Eintraege, gelesen werden ${ctx.limits.maxObjects}.`);
    }
    baueObjekte(res, paare, footer, teil);
  } catch (e) {
    if (e instanceof UnrealFormatFehler) {
      teil(e.code, e.message);
    } else if (e instanceof AssetReadError) {
      teil('abgeschnitten', `Daten enden vor dem erwarteten Feld: ${e.message}`);
    } else {
      throw e;
    }
  }
  return res;
}

/** Liest einen Indexbereich ganz und prueft seinen SHA-1. null = nicht lesbar (Warnung gesetzt). */
async function leseGeprueft(
  src: AssetSource,
  ctx: AssetContext,
  offset: number,
  groesse: number,
  hashSoll: string,
  was: string,
  teil: (c: string, m: string) => void
): Promise<{ daten: Buffer; hashStimmt: boolean } | null> {
  if (groesse > INDEX_MAX || groesse > ctx.limits.maxReadBytes / 2) {
    teil('index_zu_gross', `${was} (${groesse} Bytes) ueber der Lesegrenze; nicht gelesen.`);
    return null;
  }
  const daten = await src.readRange(offset, groesse);
  if (daten.length < groesse) {
    teil('abgeschnitten', `${was} endet nach ${daten.length} von ${groesse} Bytes.`);
    return null;
  }
  const ist = createHash('sha1').update(daten).digest('hex');
  const hashStimmt = ist === hashSoll;
  if (!hashStimmt) {
    teil('index_hash_abweichend', `SHA-1 von ${was} (${ist}) weicht vom gespeicherten Wert ab (${hashSoll}); Eintraege mit Vorsicht.`);
  }
  return { daten, hashStimmt };
}

/** Prueft alle Kandidatenpositionen. Ohne Treffer: Warnung + passender Status, null. */
async function sucheFooter(src: AssetSource, res: AssetResult): Promise<Footer | null> {
  const maxFooter = Math.max(...LAYOUTS.map(footerGroesse));
  const n = Math.min(src.size, maxFooter);
  const basis = src.size - n;
  const tail = await src.readRange(basis, n);
  const magicBei = (abs: number): boolean => {
    const rel = abs - basis;
    return rel >= 0 && rel + 8 <= tail.length && tail.readUInt32LE(rel) === PAK_MAGIC;
  };
  const versionBei = (abs: number): number => tail.readInt32LE(abs - basis + 4);

  const fremde: Array<{ position: number; version: number }> = [];
  for (const l of LAYOUTS) {
    const pos = src.size - footerGroesse(l);
    if (pos < 0) continue;
    const magicPos = pos + vorMagic(l.version);
    if (!magicBei(magicPos)) continue;
    const v = versionBei(magicPos);
    const passt = l.version <= PAK_VER.COMPRESSION_ENCRYPTION ? v >= 1 && v <= PAK_VER.COMPRESSION_ENCRYPTION : v === l.version;
    if (!passt) {
      fremde.push({ position: magicPos, version: v });
      continue;
    }
    // Footer dieses Layouts lesen.
    const r = new BinaryReader(tail.subarray(pos - basis), pos);
    const encryptionKeyGuid = l.version >= PAK_VER.ENCRYPTION_KEY_GUID ? leseGuid(r) : null;
    const encryptedIndex = l.version >= PAK_VER.INDEX_ENCRYPTION ? r.u8() !== 0 : false;
    r.skip(4); // Magic
    const version = i32(r);
    const indexOffset = i64(r, 'IndexOffset');
    const indexSize = i64(r, 'IndexSize');
    const indexHash = Buffer.from(r.bytes(20)).toString('hex');
    const frozen = l.version === PAK_VER.FROZEN_INDEX ? r.u8() !== 0 : false;
    const kompressionen: string[] = [];
    if (l.version >= PAK_VER.FNAME_BASED_COMPRESSION_METHOD) {
      for (let i = 0; i < l.kompNamen; i++) {
        const roh = Buffer.from(r.bytes(KOMPRESSIONS_NAME_LAENGE));
        const ende = roh.indexOf(0);
        kompressionen.push(roh.subarray(0, ende < 0 ? roh.length : ende).toString('latin1'));
      }
    } else {
      kompressionen.push('Zlib', 'Gzip', 'Custom');
    }
    return { layout: l, position: pos, encryptionKeyGuid, encryptedIndex, version, indexOffset, indexSize, indexHash, frozen, kompressionen };
  }

  if (fremde.length > 0) {
    const f = fremde[0];
    res.metadata.pak_version = f.version;
    res.format_specific.magic_position = f.position;
    res.status = 'teilweise';
    res.warnings.push({
      code: 'version_nicht_unterstuetzt',
      message: `Pak-Magic bei Offset ${f.position} gefunden, Version ${f.version} passt zu keinem bekannten Footer-Layout (bekannt 1..${PAK_HOECHSTE_VERSION}); nicht weitergelesen.`,
    });
    return null;
  }
  res.status = 'fehler';
  res.warnings.push({
    code: 'kein_unreal_pak',
    message: 'Keine Unreal-Pak-Magic 0x5A6F12E1 an einer Footer-Position; kein Unreal-Pak (andere .pak-Formate, z. B. Chromium-Ressourcen, tragen dieselbe Endung).',
  });
  return null;
}

/** Name der Kompressionsmethode zu einem Rohwert (v8+: 1-basierter Index in die Footer-Namen). */
function methodenName(roh: number, footer: Footer): string {
  if (footer.version < PAK_VER.FNAME_BASED_COMPRESSION_METHOD) return ALTE_KOMPRESSION[roh] ?? `Flags 0x${(roh >>> 0).toString(16)}`;
  return roh === 0 ? 'None' : footer.kompressionen[roh - 1] || `Index ${roh}`;
}

/** FPakEntry in der Index-Form (flacher Index v1..v9, nicht kodierte Eintraege ab v10). */
function leseEintrag(r: BinaryReader, footer: Footer, was: string): Eintrag {
  const v = footer.version;
  const offset = i64(r, `${was}.Offset`);
  const size = i64(r, `${was}.Size`);
  const usize = i64(r, `${was}.UncompressedSize`);
  let methodeRoh: number;
  if (v < PAK_VER.FNAME_BASED_COMPRESSION_METHOD) methodeRoh = i32(r);
  else methodeRoh = footer.layout.label === 'v8a' ? r.u8() : r.u32le(); // v8a: uint8, ab v8b: uint32
  if (v < PAK_VER.NO_TIMESTAMPS) r.skip(8); // Timestamp
  const hash = Buffer.from(r.bytes(20)).toString('hex');
  let bloecke = 0;
  let flags = 0;
  let blockGroesse: number | null = null;
  if (v >= PAK_VER.COMPRESSION_ENCRYPTION) {
    if (methodeRoh !== 0) {
      bloecke = i32(r);
      if (bloecke < 0 || bloecke * 16 > r.remaining) {
        throw new UnrealFormatFehler('zaehler_unplausibel', `${was}: ${bloecke} Kompressionsbloecke unplausibel.`);
      }
      r.skip(bloecke * 16); // je CompressedStart, CompressedEnd (int64)
    }
    flags = r.u8();
    blockGroesse = r.u32le();
  }
  return {
    offset,
    size,
    usize,
    methodeRoh,
    methode: methodenName(methodeRoh, footer),
    hash,
    bloecke,
    verschluesselt: (flags & 0x01) !== 0,
    geloescht: (flags & 0x02) !== 0,
    blockGroesse,
  };
}

/**
 * Kodierter Eintrag (v10+, FPakEntry::EncodeTo). Ein uint32 traegt die Bitfelder:
 *  31 Offset passt in 32 Bit | 30 UncompressedSize in 32 Bit | 29 Size in 32 Bit
 *  28..23 Kompressionsmethode (1-basiert) | 22 verschluesselt | 21..6 Blockzahl
 *  5..0 Blockgroesse >> 11 (0x3F = folgt als eigenes uint32)
 * Danach die Groessen, dann (bei mehreren Bloecken oder Verschluesselung) je Block ein uint32.
 * Der SHA-1 ist in der kodierten Form nicht enthalten.
 */
function leseKodiert(r: BinaryReader, footer: Footer, was: string): Eintrag {
  const bits = r.u32le();
  const methodeRoh = (bits >>> 23) & 0x3f;
  const verschluesselt = (bits & (1 << 22)) !== 0;
  const bloecke = (bits >>> 6) & 0xffff;
  let blockGroesse = bits & 0x3f;
  blockGroesse = blockGroesse === 0x3f ? r.u32le() : blockGroesse << 11;
  const varInt = (bit: number, feld: string): number => ((bits >>> bit) & 1 ? r.u32le() : i64(r, `${was}.${feld}`));
  const offset = varInt(31, 'Offset');
  const usize = varInt(30, 'UncompressedSize');
  const size = methodeRoh !== 0 ? varInt(29, 'Size') : usize;
  if (bloecke > 0 && (verschluesselt || bloecke !== 1)) {
    if (bloecke * 4 > r.remaining) {
      throw new UnrealFormatFehler('zaehler_unplausibel', `${was}: ${bloecke} Bloecke passen nicht in die kodierten Eintraege.`);
    }
    r.skip(bloecke * 4);
  }
  return {
    offset,
    size,
    usize,
    methodeRoh,
    methode: methodenName(methodeRoh, footer),
    hash: null,
    bloecke,
    verschluesselt,
    geloescht: false,
    blockGroesse,
  };
}

/** v10/v11: primaerer Index + FullDirectoryIndex. null = nur Kopf gelesen (Warnung gesetzt). */
async function leseIndexV10(
  src: AssetSource,
  r: BinaryReader,
  footer: Footer,
  anzahl: number,
  ctx: AssetContext,
  md: Record<string, unknown>,
  fsp: Record<string, unknown>,
  teil: (c: string, m: string) => void
): Promise<Array<[string, Eintrag]> | null> {
  fsp.path_hash_seed = r.u64le().toString();
  const unterindex = (was: string): Unterindex | null => {
    const vorhanden = r.u32le() !== 0;
    if (!vorhanden) return null;
    const offset = i64(r, `${was}Offset`);
    const size = i64(r, `${was}Size`);
    const hash = Buffer.from(r.bytes(20)).toString('hex');
    const innen = offset >= 0 && size >= 0 && offset + size <= footer.position;
    return { offset, size, hash_sha1: hash, innerhalb_der_datei: innen };
  };
  const phi = unterindex('PathHashIndex');
  const fdi = unterindex('FullDirectoryIndex');
  fsp.path_hash_index = phi;
  fsp.full_directory_index = fdi;
  md.unterindizes_plausibel = [phi, fdi].every(u => u === null || u.innerhalb_der_datei);

  const kodiertGroesse = i32(r);
  if (kodiertGroesse < 0 || kodiertGroesse > r.remaining) {
    throw new UnrealFormatFehler('zaehler_unplausibel', `Groesse der kodierten Eintraege ${kodiertGroesse} unplausibel (${r.remaining} Bytes uebrig).`);
  }
  const kodiertStart = r.basisOffset + r.position;
  const kodiert = new BinaryReader(r.bytes(kodiertGroesse), kodiertStart);
  const nichtKodiertAnzahl = i32(r);
  if (nichtKodiertAnzahl < 0 || nichtKodiertAnzahl * 53 > r.remaining) {
    throw new UnrealFormatFehler('zaehler_unplausibel', `Zahl nicht kodierter Eintraege ${nichtKodiertAnzahl} unplausibel.`);
  }
  const nichtKodiert: Eintrag[] = [];
  for (let i = 0; i < nichtKodiertAnzahl; i++) nichtKodiert.push(leseEintrag(r, footer, `NichtKodiert[${i}]`));
  md.eintraege_nicht_kodiert = nichtKodiertAnzahl;

  if (!fdi) {
    teil('index_version_nicht_unterstuetzt', `Pak v${footer.version} ohne FullDirectoryIndex; Dateinamen nicht verfuegbar, ${anzahl} Eintraege nur gezaehlt.`);
    return null;
  }
  if (!fdi.innerhalb_der_datei) {
    teil('index_ausserhalb', `FullDirectoryIndex ${fdi.offset}+${fdi.size} liegt nicht vor dem Footer; nicht gelesen.`);
    return null;
  }
  const dbuf = await leseGeprueft(src, ctx, fdi.offset, fdi.size, fdi.hash_sha1, 'FullDirectoryIndex', teil);
  if (!dbuf) return null;
  md.verzeichnisindex_hash_stimmt = dbuf.hashStimmt;

  const d = new BinaryReader(dbuf.daten, fdi.offset);
  const verzeichnisse = i32(d);
  if (verzeichnisse < 0 || verzeichnisse * 8 > d.remaining) {
    throw new UnrealFormatFehler('zaehler_unplausibel', `Verzeichniszahl ${verzeichnisse} unplausibel.`);
  }
  md.verzeichnisse = verzeichnisse;
  const paare: Array<[string, Eintrag]> = [];
  for (let i = 0; i < verzeichnisse && paare.length < ctx.limits.maxObjects; i++) {
    ctx.pruefeAbbruch();
    const verz = leseFString(d, MAX_PFAD_ZEICHEN, `Verzeichnis[${i}]`);
    const dateien = i32(d);
    if (dateien < 0 || dateien * 8 > d.remaining) {
      throw new UnrealFormatFehler('zaehler_unplausibel', `Verzeichnis[${i}]: Dateizahl ${dateien} unplausibel.`);
    }
    for (let k = 0; k < dateien; k++) {
      if ((k & 1023) === 0) ctx.pruefeAbbruch();
      const datei =
        footer.version >= PAK_VER.UTF8_PAK_DIRECTORY
          ? leseUtf8String(d, MAX_PFAD_ZEICHEN * 4, `Verzeichnis[${i}].Datei[${k}]`)
          : leseFString(d, MAX_PFAD_ZEICHEN, `Verzeichnis[${i}].Datei[${k}]`);
      const lage = i32(d);
      if (paare.length >= ctx.limits.maxObjects) break;
      // Verzeichnisse stehen mit fuehrendem '/' (Wurzel = '/') relativ zum MountPoint.
      const name = (verz.startsWith('/') ? verz.slice(1) : verz) + datei;
      let e: Eintrag;
      if (lage >= 0) {
        if (lage >= kodiert.length) {
          throw new UnrealFormatFehler('offset_unplausibel', `${name}: Eintragsposition ${lage} ausserhalb der kodierten Eintraege (${kodiert.length}).`);
        }
        kodiert.seek(lage);
        e = leseKodiert(kodiert, footer, name);
      } else {
        const idx = -lage - 1;
        if (idx >= nichtKodiert.length) {
          throw new UnrealFormatFehler('offset_unplausibel', `${name}: Verweis auf nicht kodierten Eintrag ${idx}, vorhanden ${nichtKodiert.length}.`);
        }
        e = nichtKodiert[idx];
      }
      paare.push([name, e]);
    }
  }
  return paare;
}

/** FUtf8String: int32 Bytezahl (ohne Terminator, nie negativ) + UTF-8-Bytes. */
function leseUtf8String(r: BinaryReader, maxBytes: number, was: string): string {
  const pos = r.basisOffset + r.position;
  const n = i32(r);
  if (n < 0 || n > maxBytes || n > r.remaining) {
    throw new UnrealFormatFehler('fstring_unplausibel', `${was} bei Offset ${pos}: UTF-8-Laenge ${n} unplausibel (${r.remaining} Bytes uebrig).`);
  }
  return Buffer.from(r.bytes(n)).toString('utf8');
}

/** Objekte und Statistik aus den gelesenen Eintraegen. */
function baueObjekte(res: AssetResult, paare: Array<[string, Eintrag]>, footer: Footer, teil: (c: string, m: string) => void): void {
  const objekte: AssetObject[] = [];
  let ausserhalb = 0;
  let verschluesselt = 0;
  let komprimiert = 0;
  let traversal = 0;
  const traversalBeispiele: string[] = [];
  for (const [name, e] of paare) {
    const data: Record<string, unknown> = {
      offset: e.offset,
      size: e.size,
      uncompressed_size: e.usize,
      kompression: e.methode,
    };
    if (e.hash !== null) data.sha1 = e.hash;
    if (e.bloecke > 0) data.bloecke = e.bloecke;
    if (e.blockGroesse !== null) data.block_groesse = e.blockGroesse;
    if (e.verschluesselt) {
      data.verschluesselt = true;
      verschluesselt++;
    }
    if (e.geloescht) data.geloescht = true;
    if (e.methodeRoh !== 0) komprimiert++;
    if (hatTraversal(name)) {
      data.traversal = true;
      traversal++;
      if (traversalBeispiele.length < 5) traversalBeispiele.push(name);
    }
    // offset zeigt auf den Eintragskopf im Pak, die Daten folgen dahinter (Laenge size).
    const innen = e.offset >= 0 && e.size >= 0 && e.offset + e.size <= footer.indexOffset;
    if (!innen) ausserhalb++;
    objekte.push({ name, kind: 'pak_entry', data, ...(innen ? { source_range: { offset: e.offset, length: e.size } } : {}) });
  }
  if (traversal > 0) {
    teil('pfad_traversal', `${traversal} Eintragsnamen fuehren aus dem MountPoint heraus ('..' oder absolut), z. B. ${traversalBeispiele.join(', ')}.`);
  }
  if (ausserhalb > 0) teil('eintrag_ausserhalb', `${ausserhalb} Eintraege mit Offset/Groesse ausserhalb des Datenbereichs vor dem Index.`);
  res.objects = objekte;
  res.metadata.eintraege_gelesen = objekte.length;
  res.metadata.eintraege_verschluesselt = verschluesselt;
  res.metadata.eintraege_komprimiert = komprimiert;
}

export const unrealPakInspector: AssetInspector = {
  id: 'unreal-pak',
  formats: ['pak'],
  extensions: ['.pak'],
  version: VERSION,
  inspect: inspiziere,
};
