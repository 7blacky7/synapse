/**
 * MODUL: Unreal-IoStore-Erkennung (.utoc / .ucas)
 * ZWECK: UE5-IoStore-Container ERKENNEN und den .utoc-Kopf (FIoStoreTocHeader) auswerten. Der
 *        Inhalt (Zen-Pakete, Chunks) wird NICHT gelesen. .ucas hat keinen eigenen Kopf und wird
 *        nur ueber die Endung (plus Nachbar-.utoc) erkannt.
 *
 * AUTORITAET: Core/Internal/IO/IoStore.h (UE 5.8.3): EIoStoreTocVersion 1..8 (Latest =
 * ReplaceIoChunkHashWithIoHash), FIoStoreTocHeader-Feldfolge, EIoContainerFlags.
 */

import * as fs from 'fs';
import * as path from 'path';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector, AssetResult, AssetSource } from '../../types.js';

const VERSION = 2;

/** FIoStoreTocHeader::TocMagicImg. */
export const UTOC_MAGIC = Buffer.from('-==--==--==--==-', 'latin1');
/** Hoechste bekannte EIoStoreTocVersion (UE 5.8.3). */
export const UTOC_HOECHSTE_VERSION = 8;
/** sizeof(FIoStoreTocHeader). */
const UTOC_KOPF_GROESSE = 144;

/** EIoContainerFlags. */
const CONTAINER_FLAGS: Record<string, number> = { Compressed: 1, Encrypted: 2, Signed: 4, Indexed: 8, OnDemand: 16 };

async function istDatei(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function inspiziere(src: AssetSource): Promise<AssetResult> {
  const ext = path.extname(src.filePath).toLowerCase();
  const kopf = await src.readRange(0, Math.min(src.size, UTOC_KOPF_GROESSE));
  const istUtoc = kopf.length >= 16 && kopf.subarray(0, 16).equals(UTOC_MAGIC);
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'archive',
    format: istUtoc ? 'utoc' : 'ucas',
    inspector: istUtoc || ext === '.utoc' ? 'unreal-utoc' : 'unreal-ucas',
    parser_version: VERSION,
    status: 'teilweise',
  });
  const basis = src.filePath.slice(0, src.filePath.length - path.extname(src.filePath).length);
  if (istUtoc) {
    if (kopf.length < UTOC_KOPF_GROESSE) {
      res.warnings.push({ code: 'abgeschnitten', message: `utoc-Kopf braucht ${UTOC_KOPF_GROESSE} Bytes, die Datei hat ${kopf.length}.` });
      return res;
    }
    const version = kopf.readUInt8(16);
    const tocHeaderSize = kopf.readUInt32LE(20);
    res.metadata.utoc_version = version;
    res.metadata.ucas_vorhanden = await istDatei(basis + '.ucas');
    if (version < 1 || version > UTOC_HOECHSTE_VERSION) {
      res.warnings.push({ code: 'version_nicht_unterstuetzt', message: `utoc-Version ${version} unbekannt (bekannt 1..${UTOC_HOECHSTE_VERSION}); Kopffelder nicht ausgewertet.` });
      return res;
    }
    if (tocHeaderSize !== UTOC_KOPF_GROESSE) {
      res.warnings.push({ code: 'kopf_unplausibel', message: `TocHeaderSize ${tocHeaderSize}, erwartet ${UTOC_KOPF_GROESSE}; Kopffelder nicht ausgewertet.` });
      return res;
    }
    const flags = kopf.readUInt8(80);
    res.metadata.toc_entry_count = kopf.readUInt32LE(24);
    res.metadata.compressed_block_count = kopf.readUInt32LE(28);
    res.metadata.compression_method_count = kopf.readUInt32LE(36);
    res.metadata.compression_block_size = kopf.readUInt32LE(44);
    res.metadata.directory_index_size = kopf.readUInt32LE(48);
    res.metadata.partition_count = kopf.readUInt32LE(52);
    res.metadata.container_flags = Object.keys(CONTAINER_FLAGS).filter(k => (flags & CONTAINER_FLAGS[k]) !== 0);
    res.metadata.verschluesselt = (flags & CONTAINER_FLAGS.Encrypted) !== 0;
    res.metadata.komprimiert = (flags & CONTAINER_FLAGS.Compressed) !== 0;
    res.format_specific.container_id = kopf.readBigUInt64LE(56).toString(16).padStart(16, '0');
    res.format_specific.encryption_key_guid = kopf.subarray(64, 80).toString('hex');
  } else if (ext === '.utoc') {
    res.status = 'fehler';
    res.warnings.push({ code: 'tag_falsch', message: 'Endung .utoc, aber ohne IoStore-Magic "-==--==--==--==-".' });
    return res;
  } else {
    res.metadata.utoc_vorhanden = await istDatei(basis + '.utoc');
  }
  res.warnings.push({
    code: 'iostore_nicht_unterstuetzt',
    message: 'UE5-IoStore-Container (.utoc/.ucas): erkannt, Inhalt wird nicht gelesen (Zen-Paketformat nicht unterstuetzt).',
  });
  return res;
}

/** .utoc: am Magic erkannt. */
export const unrealUtocInspector: AssetInspector = {
  id: 'unreal-utoc',
  formats: ['utoc'],
  extensions: ['.utoc'],
  magic: [{ offset: 0, bytes: UTOC_MAGIC, format: 'utoc' }],
  version: VERSION,
  inspect: inspiziere,
};

/**
 * .ucas: hat keinen eigenen Kopf, also KEIN Magic — sonst meldete die Registry bei jeder
 * .ucas-Datei 'magic_fehlt', obwohl nichts fehlt. Eigener Inspektor nur ueber die Endung.
 */
export const unrealUcasInspector: AssetInspector = {
  id: 'unreal-ucas',
  formats: ['ucas'],
  extensions: ['.ucas'],
  version: VERSION,
  inspect: inspiziere,
};
