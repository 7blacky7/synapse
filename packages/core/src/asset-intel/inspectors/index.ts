/**
 * MODUL: Asset-Intel Inspektoren (Sammelexport)
 * ZWECK: Fasst die sieben Inspektor-Gruppen (3d, textur, archiv, exe, medien, dcc, unreal) zu EINER Liste
 *        zusammen, die asset-intel/index.ts in die Standard-Registry haengt.
 *
 * Die Reihenfolge ist ohne Bedeutung: die Registry entscheidet ueber Magic Bytes und Endung, nicht ueber
 * die Registrierungsreihenfolge. Magic-Ueberschneidungen (zip: archiv-zip/dcc-usdz, gzip und zstd:
 * archiv-tar/dcc-blend) loest die Endung; ohne Endung bleiben genau diese Faelle mehrdeutig.
 */

import type { AssetInspector } from '../types.js';
import { asset3dInspektoren } from './3d/index.js';
import { assetTexturInspektoren } from './textur/index.js';
import { assetArchivInspektoren } from './archiv/index.js';
import { assetExeInspektoren } from './exe/index.js';
import { assetMedienInspektoren } from './medien/index.js';
import { assetDccInspektoren } from './dcc/index.js';
import { assetUnrealInspektoren } from './unreal/index.js';

export {
  asset3dInspektoren,
  assetTexturInspektoren,
  assetArchivInspektoren,
  assetExeInspektoren,
  assetMedienInspektoren,
  assetDccInspektoren,
  assetUnrealInspektoren,
};

/** Alle echten Inspektoren (ohne den Platzhalter generic-binary). */
export const alleInspektoren: AssetInspector[] = [
  ...asset3dInspektoren,
  ...assetTexturInspektoren,
  ...assetArchivInspektoren,
  ...assetExeInspektoren,
  ...assetMedienInspektoren,
  ...assetDccInspektoren,
  ...assetUnrealInspektoren,
];
