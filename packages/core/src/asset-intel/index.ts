/**
 * MODUL: Asset-Intel
 * ZWECK: Einstiegspunkt der Asset-Inspektion (Nicht-Quellcode-Dateien). Exportiert Modell,
 *        Registry, Reader und inspectAsset; haengt alle Inspektoren (3d, textur, archiv, exe, medien,
 *        dcc, unreal) und den Platzhalter generic-binary in die Standard-Registry.
 *
 * Asset-Intel steht NEBEN Code-Intel (parser/): eigene Registry, eigenes Ausgabemodell,
 * nur lesend. Die Verdrahtung in bestehende Stellen (Watcher, code_intel, Tool, DB) ist
 * bewusst nicht Teil dieser Grundschicht.
 */

import { standardRegistry } from './registry.js';
import { genericBinaryInspector } from './generic-binary.js';
import { alleInspektoren } from './inspectors/index.js';

export * from './types.js';
export * from './errors.js';
export * from './binary-reader.js';
export * from './registry.js';
export * from './run.js';
export { genericBinaryInspector } from './generic-binary.js';
export { alleInspektoren } from './inspectors/index.js';

// Eingebaute Inspektoren. register() ersetzt gleiche ids, mehrfaches Laden ist harmlos.
// generic-binary traegt nur noch Magic von Formaten ohne eigenen Inspektor (gif, pdf).
standardRegistry.register(genericBinaryInspector);
for (const inspektor of alleInspektoren) standardRegistry.register(inspektor);
