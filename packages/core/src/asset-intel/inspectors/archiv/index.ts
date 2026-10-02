/**
 * MODUL: Archiv-Inspektoren (P4-T66 Teil a)
 * ZWECK: Sammelexport der Inspektoren fuer ZIP, TAR(+gzip), 7z und SQLite.
 *        Haengt seit der Verdrahtung (asset-intel/inspectors/index.ts) in der Standard-Registry.
 *
 * VERDRAHTUNG ERLEDIGT: Die Magic-Eintraege zip/gzip/7z wurden aus generic-binary entfernt, der echte Inspektor
 * hat die Magic-Hoheit. BEWUSST BLEIBT eine Ueberschneidung mit dcc-usdz (ZIP-Kopf) und dcc-blend (gzip/zstd):
 * mit Endung entscheidet diese; ein ZIP/tar.gz OHNE Endung und mit gespeichertem ersten Eintrag ist mehrdeutig
 * (Warnung 'erkennung_mehrdeutig', siehe tests/asset-intel-standard.test.mjs).
 */

import type { AssetInspector } from '../../types.js';
import { sevenZipInspector } from './sevenzip.js';
import { sqliteInspector } from './sqlite.js';
import { tarInspector } from './tar.js';
import { zipInspector } from './zip.js';

export { sevenZipInspector, sqliteInspector, tarInspector, zipInspector };

export const assetArchivInspektoren: AssetInspector[] = [zipInspector, tarInspector, sevenZipInspector, sqliteInspector];
