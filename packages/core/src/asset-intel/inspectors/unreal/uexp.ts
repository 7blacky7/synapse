/**
 * MODUL: Unreal-.uexp-Inspektor
 * ZWECK: Erkennt die Exportdaten-Begleitdatei gecookter Pakete. Eine .uexp hat KEINEN Kopf: sie
 *        enthaelt die Exportdaten ab TotalHeaderSize der zugehoerigen .uasset/.umap und endet mit
 *        dem Paket-Tag C1 83 2A 9E. Die Exportbereiche stehen in der Exporttabelle der Begleitdatei
 *        (unreal-package meldet sie dort als uexp_offset). Properties werden nicht dekodiert.
 *
 * Kein Magic (der Tag steht am ENDE): Erkennung nur ueber die Endung .uexp.
 */

import * as fs from 'fs';
import * as path from 'path';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { PACKAGE_FILE_TAG } from './package.js';

const VERSION = 1;

async function groesse(p: string): Promise<number | null> {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

async function inspiziere(src: AssetSource): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'unreal_asset',
    format: 'uexp',
    inspector: 'unreal-uexp',
    parser_version: VERSION,
  });
  const md = res.metadata;
  const teil = (code: string, message: string): void => {
    res.warnings.push({ code, message });
    if (res.status === 'ok') res.status = 'teilweise';
  };
  md.groesse = src.size;
  const ende = src.size >= 4 ? await src.readRange(src.size - 4, 4) : Buffer.alloc(0);
  md.end_tag = ende.length === 4 && ende.readUInt32LE(0) === PACKAGE_FILE_TAG;
  const basis = src.filePath.slice(0, src.filePath.length - path.extname(src.filePath).length);
  let begleit: { datei: string; groesse: number } | null = null;
  for (const e of ['.uasset', '.umap']) {
    const g = await groesse(basis + e);
    if (g !== null) {
      begleit = { datei: path.basename(basis) + e, groesse: g };
      break;
    }
  }
  md.begleitdatei = begleit?.datei ?? null;
  md.begleitdatei_vorhanden = begleit !== null;
  if (begleit) res.references.push({ target: begleit.datei, kind: 'header', resolved: true });
  res.format_specific.exportdaten = { offset: 0, length: Math.max(0, src.size - 4), hinweis: 'Exportbereiche stehen in der Exporttabelle der Begleitdatei (uexp_offset).' };
  if (!md.end_tag) teil('end_tag_fehlt', 'Die .uexp endet nicht mit dem Paket-Tag C1 83 2A 9E (abgeschnitten oder keine .uexp).');
  if (!begleit) teil('begleitdatei_fehlt', 'Keine .uasset/.umap mit gleichem Namen daneben; Exportbereiche nicht zuordenbar.');
  return res;
}

export const unrealUexpInspector: AssetInspector = {
  id: 'unreal-uexp',
  formats: ['uexp'],
  extensions: ['.uexp'],
  version: VERSION,
  inspect: inspiziere,
};
