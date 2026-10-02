/**
 * MODUL: DCC-Inspektoren (P4-T62)
 * ZWECK: Export aller Inspektoren fuer Blender (.blend), FBX und die USD-Familie.
 *  - dcc-blend: .blend (Magic 'BLENDER'; komprimierte .blend nur ueber die Endung)
 *  - dcc-fbx:   .fbx binaer (Magic 'Kaydara FBX Binary') und ASCII (Magic '; FBX')
 *  - dcc-usd:   .usd/.usda/.usdc (Magic '#usda' bzw. 'PXR-USDC' entscheidet)
 *  - dcc-usdz:  .usdz NUR ueber die Endung (Zip-Magic gehoert dem Archiv-Inspektor)
 * Registrierung in der Standard-Registry macht der Koordinator (nicht hier).
 */

import type { AssetInspector } from '../../types.js';
import { blendInspektor } from './blend.js';
import { fbxInspektor } from './fbx.js';
import { usdInspektor } from './usd.js';
import { usdzInspektor } from './usdz.js';

export { blendInspektor, inspiziereBlend } from './blend.js';
export { fbxInspektor, inspiziereFbx } from './fbx.js';
export { usdInspektor, inspiziereUsd, inspiziereUsda, inspiziereUsdc } from './usd.js';
export type { UsdaOptionen } from './usd.js';
export { usdzInspektor, inspiziereUsdz } from './usdz.js';
export { BufferQuelle, AusschnittQuelle } from './hilfen.js';

export const assetDccInspektoren: AssetInspector[] = [blendInspektor, fbxInspektor, usdInspektor, usdzInspektor];
