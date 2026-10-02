/**
 * MODUL: Unreal-Paket-Inspektor (.uasset / .umap)
 * ZWECK: Liest aus einem KLASSISCHEN Unreal-Paket (FPackageFileSummary mit Tag 0x9E2A83C1)
 *        Versionen, Flags, Namens-, Import- und Exporttabelle. Exportdaten (Properties) werden
 *        NICHT dekodiert.
 *
 * AUTORITAET: Feldfolge und Versionsbedingungen nach dem Engine-Quelltext UE 5.8.3
 * (PackageFileSummary.cpp operator<<, ObjectResource.cpp FObjectExport/FObjectImport,
 * ObjectVersion.h, LinkerLoad.cpp). Gelesen wird NUR in den Versionsbaendern in UNTERSTUETZT;
 * alles andere -> status 'teilweise' + 'version_nicht_unterstuetzt' mit der gelesenen Zahl.
 *
 * SELBSTPRUEFUNG DES LAYOUTS: Die Groesse eines Import-/Exporteintrags wird aus Version und Flags
 * berechnet und muss die Tabelle EXAKT bis zum naechsten Summary-Offset fuellen. Passt das nicht,
 * wird die Tabelle NICHT gelesen. Bei unversionierten Paketen (Version 0/0/0 in der Datei) werden
 * die moeglichen Layouts der Reihe nach probiert; angenommen wird nur eines, das ALLE Pruefungen
 * besteht (Summary plausibel, Namen vollstaendig, beide Tabellen exakt).
 *
 * VERIFIKATION: gemessen gegen echte Engine-Dateien (uasset-rs: UE4.27/5.3/5.5; eigene UE-5.8.3-
 * Dateien: Editor, gecookt versioniert und unversioniert, mit Engine-Sicht PkgInfo). Siehe Report P4-T63.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BinaryReader } from '../../binary-reader.js';
import { AssetReadError } from '../../errors.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetReference, AssetResult, AssetSource } from '../../types.js';
import { UnrealFormatFehler, hatTraversal, i32, i64, leseFString, leseGuid } from './lesen.js';

/** PACKAGE_FILE_TAG, little-endian gelesen. In Dateireihenfolge: C1 83 2A 9E. */
export const PACKAGE_FILE_TAG = 0x9e2a83c1;
/** Derselbe Tag byte-vertauscht: Paket in Big-Endian (alte Konsolen-Cooks). */
const PACKAGE_FILE_TAG_SWAPPED = 0xc1832a9e;

const VERSION = 3;

/** EUnrealEngineObjectUE4Version — nur die Schwellen, die das hier gelesene Layout aendern. */
export const UE4_VER = {
  OLDEST_LOADABLE_PACKAGE: 214,
  LOAD_FOR_EDITOR_GAME: 365,
  SERIALIZE_TEXT_IN_PACKAGES: 459,
  COOKED_ASSETS_IN_EDITOR_SUPPORT: 485,
  NAME_HASHES_SERIALIZED: 504,
  PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS: 507,
  TEMPLATE_INDEX_IN_COOKED_EXPORTS: 508,
  EXPORTMAP_64BIT_SERIALSIZES: 511,
  ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID: 516,
  NON_OUTER_PACKAGE_IMPORT: 520,
  AUTOMATIC_VERSION: 522,
} as const;

/** EUnrealEngineObjectUE5Version (ObjectVersion.h, UE 5.8.3) — dito. */
export const UE5_VER = {
  INITIAL_VERSION: 1000,
  OPTIONAL_RESOURCES: 1003,
  REMOVE_OBJECT_EXPORT_PACKAGE_GUID: 1005,
  TRACK_OBJECT_EXPORT_IS_INHERITED: 1006,
  ADD_SOFTOBJECTPATH_LIST: 1008,
  SCRIPT_SERIALIZATION_OFFSET: 1010,
  METADATA_SERIALIZATION_OFFSET: 1014,
  VERSE_CELLS: 1015,
  PACKAGE_SAVED_HASH: 1016,
  OS_SUB_OBJECT_SHADOW_SERIALIZATION: 1017,
  IMPORT_TYPE_HIERARCHIES: 1018,
} as const;

/**
 * Versionsbaender, in denen gelesen wird. Ausserhalb: 'version_nicht_unterstuetzt'.
 * Obergrenze ist der Stand UE 5.8.3 (Legacy -9, UE5 1018 = IMPORT_TYPE_HIERARCHIES); eine
 * spaetere Version kann das Summary nach FileVersionLicensee beliebig aendern (Vertrag von -9).
 */
export const UNTERSTUETZT = {
  legacy: [-6, -7, -8, -9] as readonly number[],
  ue4Min: UE4_VER.OLDEST_LOADABLE_PACKAGE,
  ue4Max: UE4_VER.AUTOMATIC_VERSION,
  ue5Min: UE5_VER.INITIAL_VERSION,
  ue5Max: UE5_VER.IMPORT_TYPE_HIERARCHIES,
} as const;

/** EPackageFlags — nur die hier ausgewerteten. */
export const PKG_FLAGS: Record<string, number> = {
  EditorOnly: 0x00000040,
  Cooked: 0x00000200,
  UnversionedProperties: 0x00002000,
  ContainsMapData: 0x00004000,
  ContainsMap: 0x00020000,
  FilterEditorOnly: 0x80000000,
};

/**
 * Layouts, die bei einem unversionierten Paket probiert werden (neueste zuerst). Je Eintrag ein
 * Vertreter eines Bandes, das sich im hier gelesenen Teil unterscheidet.
 */
const UNVERSIONIERT_KANDIDATEN: ReadonlyArray<{ ue4: number; ue5: number | null; band: string }> = [
  { ue4: 522, ue5: 1018, band: 'UE5 >= 1016 (SavedHash, Verse-Cells, MetaData-Offset)' },
  { ue4: 522, ue5: 1015, band: 'UE5 1015 (Verse-Cells, MetaData-Offset)' },
  { ue4: 522, ue5: 1014, band: 'UE5 1014 (MetaData-Offset)' },
  { ue4: 522, ue5: 1013, band: 'UE5 1010..1013' },
  { ue4: 522, ue5: 1009, band: 'UE5 1008..1009' },
  { ue4: 522, ue5: 1004, band: 'UE5 1003..1004' },
  { ue4: 522, ue5: null, band: 'UE4 522' },
];

/** So viel liest der erste Zugriff (reicht fuer jedes plausible Summary). */
const SUMMARY_LESEN = 64 * 1024;
/** Groesster Header (TotalHeaderSize), der als Ganzes gelesen wird. */
const HEADER_MAX = 64 * 1024 * 1024;
const MAX_ZAEHLER = 10_000_000;
const MAX_CUSTOM_VERSIONS = 10_000;
const MAX_NAME_ZEICHEN = 1024;
const MAX_PFAD_ZEICHEN = 4096;
const MAX_OUTER_TIEFE = 256;
const MAX_AUFLOESUNGEN = 1000;

interface Summary {
  legacy: number;
  ue4: number;
  ue5: number | null;
  savedHash: string | null;
  customVersions: Array<{ guid: string; version: number }>;
  totalHeaderSize: number;
  folderName: string;
  packageFlags: number;
  nameCount: number;
  nameOffset: number;
  softObjectPathsCount: number | null;
  softObjectPathsOffset: number | null;
  localizationId: string | null;
  gatherableTextDataCount: number | null;
  gatherableTextDataOffset: number | null;
  exportCount: number;
  exportOffset: number;
  importCount: number;
  importOffset: number;
  cellExportCount: number | null;
  cellExportOffset: number | null;
  cellImportCount: number | null;
  cellImportOffset: number | null;
  metaDataOffset: number | null;
  dependsOffset: number;
  /** Byte hinter dem letzten gelesenen Summary-Feld. */
  ende: number;
}

interface ImportEintrag {
  classPackage: string;
  className: string;
  outer: number;
  objectName: string;
  packageName: string | null;
  optional: boolean | null;
  offset: number;
}

interface ExportEintrag {
  classIndex: number;
  superIndex: number;
  templateIndex: number | null;
  outer: number;
  objectName: string;
  objectFlags: number;
  serialSize: number;
  serialOffset: number;
  isAsset: boolean | null;
  offset: number;
}

/** Ergebnis des Tabellenlesens fuer EIN Layout. */
interface Tabellen {
  names: string[];
  imports: ImportEintrag[] | null;
  exports: ExportEintrag[] | null;
  importGroesse: number;
  importMitPaketname: boolean | null;
  ungueltigeNamen: number;
  /** Layout-Befunde (Tabelle passt nicht exakt); leer = alles bestaetigt. */
  probleme: Array<{ code: string; message: string }>;
}

const flagGesetzt = (flags: number, name: string): boolean => (flags & PKG_FLAGS[name]) >>> 0 === PKG_FLAGS[name] >>> 0;

/**
 * Groesse eines Importeintrags. PackageName (ab UE4 520) steht laut UE-5.8-Quelltext immer in der
 * Datei; aeltere Engines liessen es bei FilterEditorOnly weg — deshalb gibt es beide Varianten,
 * und die Tabellenlaenge entscheidet (leseTabellen).
 */
export function importGroesse(ue4: number, ue5: number | null, mitPaketname: boolean): number {
  let n = 8 + 8 + 4 + 8; // ClassPackage, ClassName, OuterIndex, ObjectName
  if (mitPaketname && ue4 >= UE4_VER.NON_OUTER_PACKAGE_IMPORT) n += 8; // PackageName
  if (ue5 !== null && ue5 >= UE5_VER.OPTIONAL_RESOURCES) n += 4; // bImportOptional
  return n;
}

/**
 * Groesse eines Exporteintrags (FObjectExport, ObjectResource.cpp). ScriptSerializationStart/End
 * stehen nur, wenn das Paket NICHT mit unversionierten Properties gespeichert ist
 * (PKG_UnversionedProperties, LinkerLoad setzt danach UseUnversionedPropertySerialization).
 */
export function exportGroesse(ue4: number, ue5: number | null, unversionierteProperties = false): number {
  const u5 = ue5 ?? 0;
  let n = 4 + 4; // ClassIndex, SuperIndex
  if (ue4 >= UE4_VER.TEMPLATE_INDEX_IN_COOKED_EXPORTS) n += 4;
  n += 4 + 8 + 4; // OuterIndex, ObjectName, ObjectFlags
  n += ue4 >= UE4_VER.EXPORTMAP_64BIT_SERIALSIZES ? 16 : 8; // SerialSize, SerialOffset
  n += 12; // bForcedExport, bNotForClient, bNotForServer
  if (u5 < UE5_VER.REMOVE_OBJECT_EXPORT_PACKAGE_GUID) n += 16; // PackageGuid
  if (u5 >= UE5_VER.TRACK_OBJECT_EXPORT_IS_INHERITED) n += 4; // bIsInheritedInstance
  n += 4; // PackageFlags
  if (ue4 >= UE4_VER.LOAD_FOR_EDITOR_GAME) n += 4; // bNotAlwaysLoadedForEditorGame
  if (ue4 >= UE4_VER.COOKED_ASSETS_IN_EDITOR_SUPPORT) n += 4; // bIsAsset
  if (u5 >= UE5_VER.OPTIONAL_RESOURCES) n += 4; // bGeneratePublicHash
  if (ue4 >= UE4_VER.PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) n += 20; // 5 x Abhaengigkeits-Zaehler
  if (!unversionierteProperties && u5 >= UE5_VER.SCRIPT_SERIALIZATION_OFFSET) n += 16; // ScriptSerializationStart/EndOffset
  return n;
}

function flagNamen(flags: number): string[] {
  return Object.keys(PKG_FLAGS).filter(name => flagGesetzt(flags, name));
}

function hex32(n: number): string {
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** Liegt die Datei in einem 'Content'-Ordner, ist das dessen Pfad; sonst null. */
function contentVerzeichnis(filePath: string): string | null {
  const teile = path.resolve(filePath).split(path.sep);
  const i = teile.lastIndexOf('Content');
  if (i <= 0) return null;
  return teile.slice(0, i + 1).join(path.sep);
}

async function istDatei(p: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

async function inspiziere(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const ext = path.extname(src.filePath).toLowerCase();
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'unreal_asset',
    format: ext === '.umap' ? 'umap' : 'uasset',
    inspector: 'unreal-package',
    parser_version: VERSION,
  });
  const md = res.metadata;
  const fsp = res.format_specific;
  const teil = (code: string, message: string): void => {
    res.warnings.push({ code, message });
    if (res.status === 'ok') res.status = 'teilweise';
  };
  const hinweis = (code: string, message: string): void => {
    res.warnings.push({ code, message });
  };
  fsp.gelesen_bis = 'nichts';

  try {
    const kopf = await src.readRange(0, Math.min(src.size, SUMMARY_LESEN));
    if (kopf.length < 4) {
      res.status = 'fehler';
      res.warnings.push({ code: 'tag_falsch', message: `Datei zu kurz fuer den Paket-Tag (${kopf.length} Bytes).` });
      return res;
    }
    const r = new BinaryReader(kopf, 0);
    const tag = r.u32le();
    fsp.tag_hex = Buffer.from(kopf.subarray(0, 4)).toString('hex');
    if (tag === PACKAGE_FILE_TAG_SWAPPED) {
      teil('byteorder_nicht_unterstuetzt', 'Paket-Tag byte-vertauscht (Big-Endian-Paket); nicht unterstuetzt.');
      return res;
    }
    if (tag !== PACKAGE_FILE_TAG) {
      pruefeZen(kopf, src, res);
      return res;
    }
    fsp.gelesen_bis = 'tag';

    // --- Versionen. Danach entscheidet sich, ob und mit welchem Layout weitergelesen wird. ---
    const legacy = i32(r);
    md.legacy_file_version = legacy;
    if (!UNTERSTUETZT.legacy.includes(legacy)) {
      teil('version_nicht_unterstuetzt', `LegacyFileVersion ${legacy} nicht unterstuetzt (gelesen werden ${UNTERSTUETZT.legacy.join(', ')}); Layout danach unbekannt, nicht weitergelesen.`);
      return res;
    }
    const ue3 = i32(r);
    const ue4 = i32(r);
    const ue5 = legacy <= -8 ? i32(r) : null;
    const licensee = i32(r);
    md.legacy_ue3_version = ue3;
    md.file_version_ue4 = ue4;
    md.file_version_ue5 = ue5;
    md.file_version_licensee = licensee;
    const nachLicensee = r.position;

    const unversioniert = ue4 === 0 && licensee === 0 && (ue5 === null || ue5 === 0);
    md.unversioniert = unversioniert;
    if (!unversioniert) {
      md.engine_band = ue5 !== null && ue5 >= UE5_VER.INITIAL_VERSION ? 'UE5' : 'UE4';
      const ue4Ok = ue4 >= UNTERSTUETZT.ue4Min && ue4 <= UNTERSTUETZT.ue4Max;
      const ue5Ok = ue5 === null || (ue5 >= UNTERSTUETZT.ue5Min && ue5 <= UNTERSTUETZT.ue5Max);
      if (!ue4Ok || !ue5Ok) {
        teil('version_nicht_unterstuetzt', `FileVersionUE4 ${ue4}${ue5 !== null ? `, FileVersionUE5 ${ue5}` : ''} ausserhalb der gelesenen Baender (UE4 ${UNTERSTUETZT.ue4Min}..${UNTERSTUETZT.ue4Max}, UE5 ${UNTERSTUETZT.ue5Min}..${UNTERSTUETZT.ue5Max}); nicht weitergelesen.`);
        return res;
      }
      const s = leseSummary(kopf, nachLicensee, legacy, ue4, ue5);
      trageSummaryEin(res, s, ext);
      pruefeSummary(s, src.size);
      const hbuf = await leseHeader(src, ctx, s, teil);
      if (!hbuf) return res;
      const t = leseTabellen(new BinaryReader(hbuf, 0), s, ctx);
      for (const p of t.probleme) teil(p.code, p.message);
      await uebernimmTabellen(res, src, ctx, s, t, teil);
      return res;
    }

    // --- Unversioniert: die Datei nennt keine Version. Layouts probieren, nur ein voll bestaetigtes nehmen. ---
    md.engine_band = 'unbekannt';
    const kandidaten = UNVERSIONIERT_KANDIDATEN.filter(k => (legacy <= -8 ? true : k.ue5 === null));
    const versuche: string[] = [];
    for (const k of kandidaten) {
      ctx.pruefeAbbruch();
      try {
        const s = leseSummary(kopf, nachLicensee, legacy, k.ue4, k.ue5);
        pruefeSummary(s, src.size);
        if (s.totalHeaderSize > HEADER_MAX || s.totalHeaderSize > ctx.limits.maxReadBytes / 4) throw new UnrealFormatFehler('header_zu_gross', 'Header zu gross');
        const hbuf = await src.readRange(0, s.totalHeaderSize);
        if (hbuf.length < s.totalHeaderSize) throw new UnrealFormatFehler('abgeschnitten', 'Header laenger als die Datei');
        const t = leseTabellen(new BinaryReader(hbuf, 0), s, ctx);
        if (t.probleme.length > 0 || t.imports === null || t.exports === null || t.ungueltigeNamen > 0) {
          versuche.push(`${k.band}: ${t.probleme.map(p => p.code).join(',') || 'fname_index_ungueltig'}`);
          continue;
        }
        md.engine_band = k.ue5 !== null ? 'UE5' : 'UE4';
        md.layout_angenommen = { file_version_ue4: k.ue4, file_version_ue5: k.ue5, band: k.band };
        fsp.unversioniert_versuche = versuche;
        trageSummaryEin(res, s, ext);
        hinweis(
          'unversioniert_layout_angenommen',
          `Unversioniertes Paket (Version 0/0/0 in der Datei). Layout "${k.band}" angenommen, weil nur damit Summary, Namen, Import- und Exporttabelle exakt aufgehen${versuche.length ? ` (verworfen: ${versuche.join('; ')})` : ''}.`
        );
        await uebernimmTabellen(res, src, ctx, s, t, teil);
        return res;
      } catch (e) {
        if (e instanceof UnrealFormatFehler || e instanceof AssetReadError) {
          versuche.push(`${k.band}: ${e instanceof UnrealFormatFehler ? e.code : 'abgeschnitten'}`);
          continue;
        }
        throw e;
      }
    }
    fsp.unversioniert_versuche = versuche;
    teil('unversioniert', `Unversioniertes Paket: kein bekanntes Layout geht exakt auf (${versuche.join('; ')}); Tabellen nicht gelesen.`);
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

/** Summary-Werte in metadata/format_specific. */
function trageSummaryEin(res: AssetResult, s: Summary, ext: string): void {
  const md = res.metadata;
  const fsp = res.format_specific;
  md.custom_version_count = s.customVersions.length;
  fsp.custom_versions = s.customVersions.slice(0, 64);
  if (s.savedHash !== null) fsp.saved_hash = s.savedHash;
  md.header_groesse = s.totalHeaderSize;
  md.folder_name = s.folderName;
  md.package_flags = hex32(s.packageFlags);
  md.flags = flagNamen(s.packageFlags);
  md.enthaelt_map = flagGesetzt(s.packageFlags, 'ContainsMap');
  md.cooked = flagGesetzt(s.packageFlags, 'Cooked');
  md.unversionierte_properties = flagGesetzt(s.packageFlags, 'UnversionedProperties');
  md.name_count = s.nameCount;
  md.import_count = s.importCount;
  md.export_count = s.exportCount;
  if (s.softObjectPathsCount !== null) md.soft_object_paths_count = s.softObjectPathsCount;
  if (s.gatherableTextDataCount !== null) md.gatherable_text_count = s.gatherableTextDataCount;
  if (s.localizationId !== null) md.localization_id = s.localizationId;
  if (s.cellExportCount !== null) md.cell_export_count = s.cellExportCount;
  if (s.cellImportCount !== null) md.cell_import_count = s.cellImportCount;
  fsp.offsets = {
    name: s.nameOffset,
    import: s.importOffset,
    export: s.exportOffset,
    depends: s.dependsOffset,
    soft_object_paths: s.softObjectPathsOffset,
    gatherable_text: s.gatherableTextDataOffset,
    cell_export: s.cellExportOffset,
    cell_import: s.cellImportOffset,
    meta_data: s.metaDataOffset,
  };
  fsp.summary_ende = s.ende;
  fsp.gelesen_bis = 'summary';
  if (ext !== '.umap' && ext !== '.uasset') res.format = md.enthaelt_map ? 'umap' : 'uasset';
  if (ext === '.umap' && !md.enthaelt_map) {
    res.warnings.push({ code: 'umap_ohne_map_flag', message: 'Endung .umap, aber PKG_ContainsMap ist nicht gesetzt.' });
  }
}

async function leseHeader(src: AssetSource, ctx: AssetContext, s: Summary, teil: (c: string, m: string) => void): Promise<Buffer | null> {
  if (s.totalHeaderSize > HEADER_MAX || s.totalHeaderSize > ctx.limits.maxReadBytes / 2) {
    teil('header_zu_gross', `TotalHeaderSize ${s.totalHeaderSize} ueber der Lesegrenze; Tabellen nicht gelesen.`);
    return null;
  }
  const hbuf = await src.readRange(0, s.totalHeaderSize);
  if (hbuf.length < s.totalHeaderSize) {
    teil('abgeschnitten', `Header (${s.totalHeaderSize} Bytes) laenger als die Datei (${hbuf.length}).`);
    return null;
  }
  return hbuf;
}

/** Kein klassischer Tag: Zen-Paket (UE5 IoStore) vermuten oder als falsche Datei melden. */
function pruefeZen(kopf: Buffer, src: AssetSource, res: AssetResult): void {
  const fsp = res.format_specific;
  if (kopf.length >= 8) {
    const hatVersionsinfo = kopf.readUInt32LE(0);
    const headerGroesse = kopf.readUInt32LE(4);
    // FZenPackageSummary beginnt mit bHasVersioningInfo (0/1) und HeaderSize.
    if ((hatVersionsinfo === 0 || hatVersionsinfo === 1) && headerGroesse >= 24 && headerGroesse <= src.size) {
      fsp.zen_verdacht = { has_versioning_info: hatVersionsinfo, header_size: headerGroesse };
      res.status = 'teilweise';
      res.warnings.push({
        code: 'iostore_nicht_unterstuetzt',
        message: 'Kein klassischer Paket-Tag; der Kopf passt zu einem Zen-Paket (UE5 IoStore). Verdacht, nicht verifiziert; Zen-Pakete werden nicht gelesen.',
      });
      return;
    }
  }
  res.status = 'fehler';
  res.warnings.push({
    code: 'tag_falsch',
    message: `Kein Unreal-Paket: erwartet Tag C1 83 2A 9E, gelesen ${Buffer.from(kopf.subarray(0, 4)).toString('hex')}.`,
  });
}

/**
 * Summary ab FileVersionLicensee (PackageFileSummary.cpp, UE 5.8.3). ue4/ue5 sind die Werte, nach
 * denen das Layout bestimmt wird (bei unversionierten Paketen der angenommene Kandidat).
 */
function leseSummary(kopf: Buffer, nachLicensee: number, legacy: number, ue4: number, ue5: number | null): Summary {
  const r = new BinaryReader(kopf, 0);
  r.seek(nachLicensee);
  const u5 = ue5 ?? 0;
  let savedHash: string | null = null;
  let totalHeaderSize = 0;
  if (u5 >= UE5_VER.PACKAGE_SAVED_HASH) {
    savedHash = Buffer.from(r.bytes(20)).toString('hex'); // FIoHash
    totalHeaderSize = i32(r);
  }
  // CustomVersions im optimierten Format (LegacyFileVersion <= -6): Anzahl, je FGuid + int32.
  const cvAnzahl = i32(r);
  if (cvAnzahl < 0 || cvAnzahl > MAX_CUSTOM_VERSIONS || cvAnzahl * 20 > r.remaining) {
    throw new UnrealFormatFehler('zaehler_unplausibel', `CustomVersions-Anzahl ${cvAnzahl} unplausibel (Obergrenze ${MAX_CUSTOM_VERSIONS}, ${r.remaining} Bytes uebrig).`);
  }
  const customVersions: Array<{ guid: string; version: number }> = [];
  for (let i = 0; i < cvAnzahl; i++) customVersions.push({ guid: leseGuid(r), version: i32(r) });
  if (u5 < UE5_VER.PACKAGE_SAVED_HASH) totalHeaderSize = i32(r);
  const folderName = leseFString(r, MAX_PFAD_ZEICHEN, 'PackageName');
  const packageFlags = r.u32le();
  const nameCount = i32(r);
  const nameOffset = i32(r);
  let softObjectPathsCount: number | null = null;
  let softObjectPathsOffset: number | null = null;
  if (u5 >= UE5_VER.ADD_SOFTOBJECTPATH_LIST) {
    softObjectPathsCount = i32(r);
    softObjectPathsOffset = i32(r);
  }
  let localizationId: string | null = null;
  if (!flagGesetzt(packageFlags, 'FilterEditorOnly') && ue4 >= UE4_VER.ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID) {
    localizationId = leseFString(r, MAX_NAME_ZEICHEN, 'LocalizationId');
  }
  let gatherableTextDataCount: number | null = null;
  let gatherableTextDataOffset: number | null = null;
  if (ue4 >= UE4_VER.SERIALIZE_TEXT_IN_PACKAGES) {
    gatherableTextDataCount = i32(r);
    gatherableTextDataOffset = i32(r);
  }
  const exportCount = i32(r);
  const exportOffset = i32(r);
  const importCount = i32(r);
  const importOffset = i32(r);
  let cellExportCount: number | null = null;
  let cellExportOffset: number | null = null;
  let cellImportCount: number | null = null;
  let cellImportOffset: number | null = null;
  if (u5 >= UE5_VER.VERSE_CELLS) {
    cellExportCount = i32(r);
    cellExportOffset = i32(r);
    cellImportCount = i32(r);
    cellImportOffset = i32(r);
  }
  const metaDataOffset = u5 >= UE5_VER.METADATA_SERIALIZATION_OFFSET ? i32(r) : null;
  const dependsOffset = i32(r);
  return {
    legacy,
    ue4,
    ue5,
    savedHash,
    customVersions,
    totalHeaderSize,
    folderName,
    packageFlags,
    nameCount,
    nameOffset,
    softObjectPathsCount,
    softObjectPathsOffset,
    localizationId,
    gatherableTextDataCount,
    gatherableTextDataOffset,
    exportCount,
    exportOffset,
    importCount,
    importOffset,
    cellExportCount,
    cellExportOffset,
    cellImportCount,
    cellImportOffset,
    metaDataOffset,
    dependsOffset,
    ende: r.position,
  };
}

/** Zaehler und Offsets gegen Header- und Dateigroesse. Wirft UnrealFormatFehler. */
function pruefeSummary(s: Summary, dateiGroesse: number): void {
  if (s.totalHeaderSize < s.ende) {
    throw new UnrealFormatFehler('offset_unplausibel', `TotalHeaderSize ${s.totalHeaderSize} kleiner als das Summary selbst (${s.ende}).`);
  }
  if (s.totalHeaderSize > dateiGroesse) {
    throw new UnrealFormatFehler('header_groesser_als_datei', `TotalHeaderSize ${s.totalHeaderSize} groesser als die Datei (${dateiGroesse}).`);
  }
  const tabellen: Array<[string, number, number]> = [
    ['Name', s.nameCount, s.nameOffset],
    ['Import', s.importCount, s.importOffset],
    ['Export', s.exportCount, s.exportOffset],
  ];
  if (s.softObjectPathsCount !== null) tabellen.push(['SoftObjectPaths', s.softObjectPathsCount, s.softObjectPathsOffset ?? 0]);
  if (s.gatherableTextDataCount !== null) tabellen.push(['GatherableText', s.gatherableTextDataCount, s.gatherableTextDataOffset ?? 0]);
  if (s.cellExportCount !== null) tabellen.push(['CellExport', s.cellExportCount, s.cellExportOffset ?? 0]);
  if (s.cellImportCount !== null) tabellen.push(['CellImport', s.cellImportCount, s.cellImportOffset ?? 0]);
  for (const [was, anzahl, offset] of tabellen) {
    if (anzahl < 0 || anzahl > MAX_ZAEHLER) {
      throw new UnrealFormatFehler('zaehler_unplausibel', `${was}Count ${anzahl} (als uint32 ${anzahl >>> 0}) unplausibel.`);
    }
    if (anzahl > 0 && (offset < s.ende || offset > s.totalHeaderSize)) {
      throw new UnrealFormatFehler('offset_unplausibel', `${was}Offset ${offset} liegt nicht im Header (${s.ende}..${s.totalHeaderSize}).`);
    }
  }
  for (const [was, offset] of [['DependsOffset', s.dependsOffset], ['MetaDataOffset', s.metaDataOffset]] as Array<[string, number | null]>) {
    if (offset !== null && (offset < 0 || offset > s.totalHeaderSize)) {
      throw new UnrealFormatFehler('offset_unplausibel', `${was} ${offset} liegt nicht im Header (0..${s.totalHeaderSize}).`);
    }
  }
  // Mindestgroesse eines Namens: leeres FString (4) + ggf. zwei Hashes (4).
  const minName = 4 + (s.ue4 >= UE4_VER.NAME_HASHES_SERIALIZED ? 4 : 0);
  if (s.nameCount * minName > s.totalHeaderSize - s.nameOffset) {
    throw new UnrealFormatFehler('zaehler_unplausibel', `NameCount ${s.nameCount} passt nicht in ${s.totalHeaderSize - s.nameOffset} Bytes ab NameOffset.`);
  }
}

/** Naechster bekannter Tabellenanfang hinter offset (oder das Header-Ende). */
function grenzeNach(s: Summary, offset: number): number {
  const kandidaten = [
    s.softObjectPathsOffset,
    s.gatherableTextDataOffset,
    s.importOffset,
    s.exportOffset,
    s.cellExportOffset,
    s.cellImportOffset,
    s.metaDataOffset,
    s.dependsOffset,
  ].filter((o): o is number => o !== null && o > offset);
  return kandidaten.length > 0 ? Math.min(...kandidaten) : s.totalHeaderSize;
}

/** Namen, Importe, Exporte fuer ein Summary. Layout-Befunde landen in probleme, Lesefehler werfen. */
function leseTabellen(h: BinaryReader, s: Summary, ctx: AssetContext): Tabellen {
  const probleme: Array<{ code: string; message: string }> = [];
  const names: string[] = [];
  if (s.nameCount > 0) {
    const mitHashes = s.ue4 >= UE4_VER.NAME_HASHES_SERIALIZED;
    h.seek(s.nameOffset);
    for (let i = 0; i < s.nameCount; i++) {
      if ((i & 1023) === 0) ctx.pruefeAbbruch();
      names.push(leseFString(h, MAX_NAME_ZEICHEN, `Name[${i}]`));
      if (mitHashes) h.skip(4); // NonCasePreservingHash, CasePreservingHash (je uint16)
    }
    const grenze = grenzeNach(s, s.nameOffset);
    if (h.position > grenze) {
      probleme.push({ code: 'namentabelle_ueberlappt', message: `Namenstabelle endet bei ${h.position}, die naechste Tabelle beginnt bei ${grenze}.` });
    }
  }

  let ungueltigeNamen = 0;
  const fname = (): string => {
    const idx = i32(h);
    const num = i32(h);
    const basis = idx >= 0 && idx < names.length ? names[idx] : null;
    if (basis === null) {
      ungueltigeNamen++;
      return `<name#${idx}>`;
    }
    return num > 0 ? `${basis}_${num - 1}` : basis;
  };

  // Importe: Eintragsgroesse muss die Tabelle exakt bis zur naechsten fuellen.
  let imports: ImportEintrag[] | null = [];
  let importGr = 0;
  let importMitPaketname: boolean | null = null;
  if (s.importCount > 0) {
    const grenze = grenzeNach(s, s.importOffset);
    const varianten = s.ue4 >= UE4_VER.NON_OUTER_PACKAGE_IMPORT ? [true, false] : [false];
    const passend = varianten.filter(mit => s.importOffset + s.importCount * importGroesse(s.ue4, s.ue5, mit) === grenze);
    if (passend.length !== 1) {
      const gr = varianten.map(mit => importGroesse(s.ue4, s.ue5, mit)).join(' oder ');
      probleme.push({
        code: 'importtabelle_layout_unplausibel',
        message: `Importtabelle: erwartet ${gr} Bytes je Eintrag x ${s.importCount}, der Abstand bis zur naechsten Tabelle ist ${grenze - s.importOffset}; Layout nicht bestaetigt, Importtabelle nicht gelesen.`,
      });
      imports = null;
    } else {
      importMitPaketname = s.ue4 >= UE4_VER.NON_OUTER_PACKAGE_IMPORT ? passend[0] : null;
      importGr = importGroesse(s.ue4, s.ue5, passend[0]);
      const mitOptional = s.ue5 !== null && s.ue5 >= UE5_VER.OPTIONAL_RESOURCES;
      const filter = flagGesetzt(s.packageFlags, 'FilterEditorOnly');
      h.seek(s.importOffset);
      for (let i = 0; i < s.importCount; i++) {
        if ((i & 1023) === 0) ctx.pruefeAbbruch();
        const offset = h.position;
        const classPackage = fname();
        const className = fname();
        const outer = i32(h);
        const objectName = fname();
        let packageName = passend[0] ? fname() : null;
        // Gecookt (FilterEditorOnly) schreibt die Engine statt 'None' den ObjectName; beim Laden zurueckgesetzt.
        if (filter && packageName === objectName) packageName = null;
        if (packageName === 'None') packageName = null;
        const optional = mitOptional ? h.u32le() !== 0 : null;
        imports.push({ classPackage, className, outer, objectName, packageName, optional, offset });
      }
    }
  }

  // Exporte.
  let exports: ExportEintrag[] | null = [];
  if (s.exportCount > 0) {
    const unvProps = flagGesetzt(s.packageFlags, 'UnversionedProperties');
    const groesse = exportGroesse(s.ue4, s.ue5, unvProps);
    const grenze = grenzeNach(s, s.exportOffset);
    if (s.exportOffset + s.exportCount * groesse !== grenze) {
      probleme.push({
        code: 'exporttabelle_layout_unplausibel',
        message: `Exporttabelle: erwartet ${groesse} Bytes je Eintrag x ${s.exportCount}, der Abstand bis zur naechsten Tabelle ist ${grenze - s.exportOffset}; Layout nicht bestaetigt, Exporttabelle nicht gelesen.`,
      });
      exports = null;
    } else {
      const u5 = s.ue5 ?? 0;
      h.seek(s.exportOffset);
      for (let i = 0; i < s.exportCount; i++) {
        if ((i & 1023) === 0) ctx.pruefeAbbruch();
        const offset = h.position;
        const classIndex = i32(h);
        const superIndex = i32(h);
        const templateIndex = s.ue4 >= UE4_VER.TEMPLATE_INDEX_IN_COOKED_EXPORTS ? i32(h) : null;
        const outer = i32(h);
        const objectName = fname();
        const objectFlags = h.u32le();
        let serialSize: number;
        let serialOffset: number;
        if (s.ue4 >= UE4_VER.EXPORTMAP_64BIT_SERIALSIZES) {
          serialSize = i64(h, `Export[${i}].SerialSize`);
          serialOffset = i64(h, `Export[${i}].SerialOffset`);
        } else {
          serialSize = i32(h);
          serialOffset = i32(h);
        }
        h.skip(12); // bForcedExport, bNotForClient, bNotForServer
        if (u5 < UE5_VER.REMOVE_OBJECT_EXPORT_PACKAGE_GUID) h.skip(16);
        if (u5 >= UE5_VER.TRACK_OBJECT_EXPORT_IS_INHERITED) h.skip(4);
        h.skip(4); // PackageFlags
        if (s.ue4 >= UE4_VER.LOAD_FOR_EDITOR_GAME) h.skip(4);
        const isAsset = s.ue4 >= UE4_VER.COOKED_ASSETS_IN_EDITOR_SUPPORT ? h.u32le() !== 0 : null;
        if (u5 >= UE5_VER.OPTIONAL_RESOURCES) h.skip(4);
        if (s.ue4 >= UE4_VER.PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) h.skip(20);
        if (!unvProps && u5 >= UE5_VER.SCRIPT_SERIALIZATION_OFFSET) h.skip(16);
        exports.push({ classIndex, superIndex, templateIndex, outer, objectName, objectFlags, serialSize, serialOffset, isAsset, offset });
      }
    }
  }
  return { names, imports, exports, importGroesse: importGr, importMitPaketname, ungueltigeNamen, probleme };
}

/** Tabellen ins Ergebnis: Objekte, Referenzen, Zyklen, getrennte Exportdaten. */
async function uebernimmTabellen(
  res: AssetResult,
  src: AssetSource,
  ctx: AssetContext,
  s: Summary,
  t: Tabellen,
  teil: (c: string, m: string) => void
): Promise<void> {
  const md = res.metadata;
  const fsp = res.format_specific;
  fsp.names_vorschau = t.names.slice(0, 100);
  if (t.importMitPaketname !== null) fsp.import_mit_paketname = t.importMitPaketname;
  fsp.gelesen_bis = 'tabellen';
  if (t.ungueltigeNamen > 0) teil('fname_index_ungueltig', `${t.ungueltigeNamen} FName-Verweise ausserhalb der Namenstabelle (${t.names.length} Namen).`);
  if (md.unversionierte_properties === true) {
    res.warnings.push({
      code: 'properties_ohne_mappings',
      message: 'PKG_UnversionedProperties: die Exportdaten sind ohne Property-Mappings (.usmap) nicht deutbar; gelesen werden nur Header und Tabellen.',
    });
  }

  const imp = t.imports ?? [];
  const exp = t.exports ?? [];

  /** FPackageIndex -> Objektname: < 0 Import, > 0 Export, 0 = kein Objekt. */
  const objName = (idx: number): string | null => {
    if (idx < 0) return imp[-idx - 1]?.objectName ?? null;
    if (idx > 0) return exp[idx - 1]?.objectName ?? null;
    return null;
  };
  const outerVon = (idx: number): number | undefined => (idx < 0 ? imp[-idx - 1]?.outer : idx > 0 ? exp[idx - 1]?.outer : undefined);

  let zyklen = 0;
  let ungueltig = 0;
  const zyklusBeispiele: string[] = [];
  /** Kette der Outer bis zur Wurzel; erkennt Zyklen und ungueltige Indizes. */
  const kette = (start: number): { wurzel: number | null; tiefe: number } => {
    const gesehen = new Set<number>();
    let idx = start;
    let tiefe = 0;
    while (true) {
      if (gesehen.has(idx) || tiefe > MAX_OUTER_TIEFE) {
        zyklen++;
        if (zyklusBeispiele.length < 5) zyklusBeispiele.push(String(start));
        return { wurzel: null, tiefe };
      }
      gesehen.add(idx);
      const outer = outerVon(idx);
      if (outer === undefined) {
        ungueltig++;
        return { wurzel: null, tiefe };
      }
      if (outer === 0) return { wurzel: idx, tiefe };
      idx = outer;
      tiefe++;
    }
  };

  const objekte: AssetObject[] = [];
  let gekappt = false;
  const fuegeHinzu = (o: AssetObject): void => {
    if (objekte.length >= ctx.limits.maxObjects) {
      gekappt = true;
      return;
    }
    objekte.push(o);
  };

  // Exporte.
  let ausserhalb = 0;
  let unplausibel = 0;
  let exportEnde = 0;
  for (let i = 0; i < exp.length; i++) {
    if ((i & 1023) === 0) ctx.pruefeAbbruch();
    const e = exp[i];
    kette(i + 1);
    const data: Record<string, unknown> = {
      index: i + 1,
      class: objName(e.classIndex),
      super: objName(e.superIndex),
      outer: objName(e.outer),
      object_flags: hex32(e.objectFlags),
      serial_offset: e.serialOffset,
      serial_size: e.serialSize,
    };
    if (e.templateIndex !== null) data.template = objName(e.templateIndex);
    if (e.isAsset !== null) data.is_asset = e.isAsset;
    let source_range: { offset: number; length: number } | undefined;
    if (e.serialOffset < s.totalHeaderSize || e.serialSize < 0) {
      unplausibel++;
    } else {
      exportEnde = Math.max(exportEnde, e.serialOffset + e.serialSize);
      if (e.serialOffset + e.serialSize <= src.size) {
        source_range = { offset: e.serialOffset, length: e.serialSize };
      } else {
        ausserhalb++;
        data.in_uexp = true;
        data.uexp_offset = e.serialOffset - s.totalHeaderSize;
      }
    }
    fuegeHinzu({ name: e.objectName, kind: 'export', data, ...(source_range ? { source_range } : {}) });
  }

  // Importe (Eintrag in der Importtabelle als Bytebereich).
  const pakete = new Set<string>();
  for (let i = 0; i < imp.length; i++) {
    if ((i & 1023) === 0) ctx.pruefeAbbruch();
    const im = imp[i];
    const { wurzel } = kette(-(i + 1));
    const paket = wurzel !== null && wurzel < 0 ? imp[-wurzel - 1].objectName : null;
    if (paket !== null) pakete.add(paket);
    const data: Record<string, unknown> = {
      index: -(i + 1),
      class_package: im.classPackage,
      class_name: im.className,
      outer: objName(im.outer),
      paket,
    };
    if (im.packageName !== null) data.package_name = im.packageName;
    if (im.optional !== null) data.optional = im.optional;
    fuegeHinzu({ name: im.objectName, kind: 'import', data, source_range: { offset: im.offset, length: t.importGroesse } });
  }

  if (zyklen > 0) teil('outer_zyklus', `${zyklen} Objekte mit zyklischer oder zu tiefer OuterIndex-Kette (z. B. Index ${zyklusBeispiele.join(', ')}).`);
  if (ungueltig > 0) teil('index_ungueltig', `${ungueltig} Objekte verweisen auf einen OuterIndex ausserhalb der Tabellen.`);
  if (unplausibel > 0) teil('export_bereich_unplausibel', `${unplausibel} Exporte mit SerialOffset im Header oder negativer SerialSize.`);
  if (gekappt) teil('objekte_gekappt', `Mehr als ${ctx.limits.maxObjects} Objekte; Rest weggelassen.`);

  // Getrennte Exportdaten (gecookt: .uexp/.ubulk neben der .uasset). Mit .uexp ist das der Normalfall.
  if (ausserhalb > 0) {
    const basis = src.filePath.slice(0, src.filePath.length - path.extname(src.filePath).length);
    const uexpGroesse = await istDatei(basis + '.uexp');
    const ubulkGroesse = await istDatei(basis + '.ubulk');
    // Erwartet: die Exportdaten liegen ab Header-Ende in der .uexp; danach folgt der 4-Byte-Tag.
    const erwartet = exportEnde - s.totalHeaderSize + 4;
    fsp.uexp = {
      datei: path.basename(basis) + '.uexp',
      vorhanden: uexpGroesse !== null,
      exporte: ausserhalb,
      groesse: uexpGroesse,
      erwartete_groesse: erwartet,
      groesse_stimmt: uexpGroesse === erwartet,
    };
    fsp.ubulk = { datei: path.basename(basis) + '.ubulk', vorhanden: ubulkGroesse !== null };
    md.getrennte_exportdaten = true;
    if (uexpGroesse === null) {
      teil('uexp_fehlt', `${ausserhalb} Exporte liegen hinter dem Dateiende, aber keine .uexp-Nachbardatei gefunden.`);
    } else if (uexpGroesse < erwartet - 4) {
      teil('uexp_zu_kurz', `.uexp hat ${uexpGroesse} Bytes, die Exporttabelle braucht mindestens ${erwartet - 4}.`);
    }
  }

  // Referenzen: eindeutige Wurzelpakete der Importe ('import') und die Pakete ihrer Klassen, soweit
  // nicht schon Wurzel ('klassenpaket'; die Engine-PkgInfo fuehrt beide als referenzierte Pakete).
  const klassenpakete = new Set<string>();
  for (const im of imp) if (im.classPackage && !pakete.has(im.classPackage)) klassenpakete.add(im.classPackage);
  const content = contentVerzeichnis(src.filePath);
  const refs: AssetReference[] = [];
  let aufgeloest = 0;
  let traversal = 0;
  const ziele: Array<[string, string]> = [...[...pakete].map(z => [z, 'import'] as [string, string]), ...[...klassenpakete].map(z => [z, 'klassenpaket'] as [string, string])];
  for (const [ziel, art] of ziele) {
    ctx.pruefeAbbruch();
    const ref: AssetReference = { target: ziel, kind: art };
    if (content !== null && ziel.startsWith('/Game/') && aufgeloest < MAX_AUFLOESUNGEN) {
      const rest = ziel.slice('/Game/'.length);
      if (hatTraversal(rest)) {
        traversal++;
      } else {
        aufgeloest++;
        const basis = path.join(content, ...rest.split('/'));
        ref.resolved = (await istDatei(basis + '.uasset')) !== null || (await istDatei(basis + '.umap')) !== null;
      }
    }
    refs.push(ref);
  }
  if (traversal > 0) teil('pfad_traversal', `${traversal} /Game/-Verweise mit '..' oder absolutem Pfad; nicht aufgeloest.`);
  if (content !== null) fsp.content_verzeichnis = content;

  res.objects = objekte;
  res.references = refs;
  md.import_pakete = pakete.size;
  md.klassenpakete = klassenpakete.size;
}

export const unrealPackageInspector: AssetInspector = {
  id: 'unreal-package',
  formats: ['uasset', 'umap'],
  extensions: ['.uasset', '.umap'],
  magic: [{ offset: 0, bytes: [0xc1, 0x83, 0x2a, 0x9e], format: 'uasset' }],
  version: VERSION,
  inspect: inspiziere,
};
