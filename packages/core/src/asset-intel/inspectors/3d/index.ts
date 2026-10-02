/**
 * MODUL: Asset 3D Inspektoren
 * ZWECK: Sammelexport der 3D-Basisformate (glTF/GLB, OBJ, STL, PLY, DAE).
 *        Die Inspektoren sind NICHT in der Standard-Registry eingehaengt; das macht der
 *        Koordinator nach der Welle (Tests registrieren sie in einer eigenen AssetRegistry).
 *
 * MAGIC-HINWEIS: generic-binary traegt ebenfalls das Magic 'glTF' (glb). In einer Registry mit
 * 3d-glb ist eine .glb-Datei per Magic mehrdeutig und wird nur ueber die Endung aufgeloest —
 * beim Verdrahten das glb-Magic aus generic-binary entfernen.
 * ENDUNGEN: .gltf (3d-gltf, ohne Magic), .glb (3d-glb, Magic 'glTF'), .obj, .stl, .ply (Magic 'ply'), .dae.
 */

import type { AssetInspector } from '../../types.js';
import { daeInspector } from './dae.js';
import { glbInspector, gltfInspector } from './gltf.js';
import { objInspector } from './obj.js';
import { plyInspector } from './ply.js';
import { stlInspector } from './stl.js';

export { daeInspector, glbInspector, gltfInspector, objInspector, plyInspector, stlInspector };
export { scanneJsonArrays } from './gltf.js';

/** Alle 3D-Inspektoren (asset_type 'model3d'). */
export const asset3dInspektoren: AssetInspector[] = [gltfInspector, glbInspector, objInspector, stlInspector, plyInspector, daeInspector];
