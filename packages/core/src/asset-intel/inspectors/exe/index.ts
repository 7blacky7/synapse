/**
 * MODUL: Asset-Intel Exe-Inspektoren (T66b)
 * ZWECK: Sammelexport der PE- und ELF-Inspektoren. Haengt seit der Verdrahtung
 *        (asset-intel/inspectors/index.ts) in der Standard-Registry.
 *
 * MAGIC-KOLLISION (geloest): Das ELF-Magic wurde aus generic-binary entfernt, exe-elf hat die Magic-Hoheit;
 * eine ELF-Datei ohne Endung ist damit eindeutig.
 */

import type { AssetInspector } from '../../types.js';
import { elfInspector } from './elf.js';
import { peInspector } from './pe.js';

export { elfInspector, peInspector };

export const assetExeInspektoren: AssetInspector[] = [peInspector, elfInspector];
