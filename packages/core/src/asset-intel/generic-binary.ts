/**
 * MODUL: Asset Generic Binary
 * ZWECK: Platzhalter-Inspektor. Erkennt nur das Format am Magic und meldet Groesse und
 *        Format-Name — damit die Pipeline (Erkennung -> Grenzen -> Ergebnis) Ende zu Ende
 *        laeuft, bevor die echten Inspektoren (T61-T66) dazukommen.
 *
 * Er hat bewusst KEINE Endungen: ohne passenden Magic ist er nicht zustaendig, damit er
 * keinem spaeteren, echten Inspektor eine Endung wegnimmt oder mit ihm mehrdeutig wird.
 *
 * VERDRAHTUNG (Standard-Registry): Magic-Hoheit hat der echte Inspektor. Entfernt wurden png, jpeg
 * (textur), zip (archiv-zip), gzip (archiv-tar), 7z (archiv-7z), glb (3d-glb), elf (exe-elf).
 * Uebrig bleiben nur Formate ohne eigenen Inspektor: gif und pdf.
 */

import { leseReader } from './binary-reader.js';
import { erzeugeAssetResult } from './types.js';
import type { AssetInspector, AssetMagic } from './types.js';

const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

const MAGIC: AssetMagic[] = [
  { offset: 0, bytes: ASCII('GIF8'), format: 'gif' },
  { offset: 0, bytes: ASCII('%PDF-'), format: 'pdf' },
];

/** Grobe Klasse je Format (auch fuer Formate, die ein echter Inspektor uebernommen hat). */
const ASSET_TYPEN: Record<string, string> = {
  png: 'image',
  jpeg: 'image',
  gif: 'image',
  pdf: 'document',
  zip: 'archive',
  gzip: 'archive',
  '7z': 'archive',
  glb: 'model3d',
  elf: 'executable',
};

export const genericBinaryInspector: AssetInspector = {
  id: 'generic-binary',
  formats: ['gif', 'pdf'],
  extensions: [],
  magic: MAGIC,
  version: 1,
  async inspect(src, ctx) {
    const format = ctx.format ?? 'unbekannt';
    const kopf = await leseReader(src, 0, Math.min(src.size, 16));
    return erzeugeAssetResult(src.filePath, src.size, {
      asset_type: ASSET_TYPEN[format] ?? 'binary',
      format,
      inspector: 'generic-binary',
      parser_version: 1,
      metadata: { groesse_bytes: src.size },
      format_specific: {
        tiefe: 'nur_magic',
        kopf_hex: Buffer.from(kopf.bytes(kopf.remaining)).toString('hex'),
      },
    });
  },
};
