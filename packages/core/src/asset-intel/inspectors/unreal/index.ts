/**
 * MODUL: Unreal-Inspektoren
 * ZWECK: Sammelt die Unreal-Inspektoren fuer die Asset-Registry.
 *
 *  - unreal-package: .uasset/.umap (klassisches Paket, Magic C1 83 2A 9E)
 *  - unreal-uexp:    .uexp (Exportdaten gecookter Pakete, Tag am Dateiende, nur Endung)
 *  - unreal-pak:     .pak (nur Endung; Footer-Magic sitzt am Dateiende)
 *  - unreal-utoc:    .utoc (IoStore, Kopf am Magic)
 *  - unreal-ucas:    .ucas (IoStore, nur Erkennung ueber die Endung)
 */

import type { AssetInspector } from '../../types.js';
import { unrealPackageInspector } from './package.js';
import { unrealUexpInspector } from './uexp.js';
import { unrealPakInspector } from './pak.js';
import { unrealUtocInspector, unrealUcasInspector } from './iostore.js';

export { unrealPackageInspector, PACKAGE_FILE_TAG, UNTERSTUETZT, UE4_VER, UE5_VER, PKG_FLAGS, importGroesse, exportGroesse } from './package.js';
export { unrealUexpInspector } from './uexp.js';
export { unrealPakInspector, PAK_MAGIC, PAK_HOECHSTE_VERSION, footerGroesse } from './pak.js';
export { unrealUtocInspector, unrealUcasInspector, UTOC_MAGIC, UTOC_HOECHSTE_VERSION } from './iostore.js';

export const assetUnrealInspektoren: AssetInspector[] = [
  unrealPackageInspector,
  unrealUexpInspector,
  unrealPakInspector,
  unrealUtocInspector,
  unrealUcasInspector,
];
