/**
 * MODUL: Textur-Inspektoren (P4-T64)
 * ZWECK: Sammelexport der Bild-/Textur-Inspektoren: PNG, JPEG, WebP, DDS, KTX, KTX2, OpenEXR, Radiance HDR.
 *
 * Hier wird nichts registriert; die Verdrahtung in eine Registry geschieht ausserhalb (Koordinator).
 * MAGIC-HINWEIS: generic-binary traegt ebenfalls png- und jpeg-Magic; in der Standard-Registry ist das mehrdeutig,
 * solange es nicht aus generic-binary entfernt wird.
 */

import type { AssetInspector } from '../../types.js';
import { bmpInspector } from './bmp.js';
import { ddsInspector } from './dds.js';
import { heifInspector } from './heif.js';
import { exrInspector } from './exr.js';
import { hdrInspector } from './hdr.js';
import { icoInspector } from './ico.js';
import { jpegInspector } from './jpeg.js';
import { ktxInspector } from './ktx.js';
import { ktx2Inspector } from './ktx2.js';
import { pngInspector } from './png.js';
import { webpInspector } from './webp.js';

export const assetTexturInspektoren: AssetInspector[] = [
  icoInspector,
  pngInspector,
  jpegInspector,
  webpInspector,
  ddsInspector,
  ktxInspector,
  ktx2Inspector,
  exrInspector,
  hdrInspector,
  // P22-T238 mit P4-T75 (thought 0e4c4c3f): BMP und AVIF/HEIC/HEIF mit Bildmetadaten wie PNG.
  bmpInspector,
  heifInspector,
];

export { bmpInspector, heifInspector, ddsInspector, exrInspector, hdrInspector, icoInspector, jpegInspector, ktxInspector, ktx2Inspector, pngInspector, webpInspector };
