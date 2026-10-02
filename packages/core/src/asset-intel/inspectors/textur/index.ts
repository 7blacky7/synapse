/**
 * MODUL: Textur-Inspektoren (P4-T64)
 * ZWECK: Sammelexport der Bild-/Textur-Inspektoren: PNG, JPEG, WebP, DDS, KTX, KTX2, OpenEXR, Radiance HDR.
 *
 * Hier wird nichts registriert; die Verdrahtung in eine Registry geschieht ausserhalb (Koordinator).
 * MAGIC-HINWEIS: generic-binary traegt ebenfalls png- und jpeg-Magic; in der Standard-Registry ist das mehrdeutig,
 * solange es nicht aus generic-binary entfernt wird.
 */

import type { AssetInspector } from '../../types.js';
import { ddsInspector } from './dds.js';
import { exrInspector } from './exr.js';
import { hdrInspector } from './hdr.js';
import { jpegInspector } from './jpeg.js';
import { ktxInspector } from './ktx.js';
import { ktx2Inspector } from './ktx2.js';
import { pngInspector } from './png.js';
import { webpInspector } from './webp.js';

export const assetTexturInspektoren: AssetInspector[] = [
  pngInspector,
  jpegInspector,
  webpInspector,
  ddsInspector,
  ktxInspector,
  ktx2Inspector,
  exrInspector,
  hdrInspector,
];

export { ddsInspector, exrInspector, hdrInspector, jpegInspector, ktxInspector, ktx2Inspector, pngInspector, webpInspector };
