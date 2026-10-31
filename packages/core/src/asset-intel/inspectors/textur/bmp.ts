/**
 * MODUL: Textur-Inspektor BMP (P22-T238 zusammen mit P4-T75, User 31.10.2026, thought 0e4c4c3f)
 * ZWECK: Windows-Bitmap (BITMAPFILEHEADER + DIB-Kopf CORE/INFO/V2..V5). Liest nur die Koepfe und Farbmasken,
 *        nie Pixeldaten. Metadaten wie textur-png: width/height, channels, has_alpha, bits_per_channel,
 *        Kompression, Palette, top-down, DPI. Die Ansicht dekodiert BMP schon (asset-ansicht-renderer.ts).
 *
 * MAGIC: 'BM' ist nur zwei Bytes lang; pruefeMagic verlangt zusaetzlich eine bekannte DIB-Kopfgroesse und
 *        einen Pixeldaten-Offset innerhalb der Datei (sonst traefe 'BM' fremde Binaerdateien).
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { bildMetadata, pruefeAbmessungen, sicher, warnung } from './util.js';

const ID = 'textur-bmp';
const VERSION = 1;
const DIB_GROESSEN = [12, 16, 40, 52, 56, 64, 108, 124];
const KOMPRESSION: Record<number, string> = { 0: 'BI_RGB', 1: 'BI_RLE8', 2: 'BI_RLE4', 3: 'BI_BITFIELDS', 4: 'BI_JPEG', 5: 'BI_PNG', 6: 'BI_ALPHABITFIELDS', 11: 'BI_CMYK', 12: 'BI_CMYKRLE8', 13: 'BI_CMYKRLE4' };
const DIB_NAME: Record<number, string> = { 12: 'BITMAPCOREHEADER', 16: 'OS22XBITMAPHEADER (kurz)', 40: 'BITMAPINFOHEADER', 52: 'BITMAPV2INFOHEADER', 56: 'BITMAPV3INFOHEADER', 64: 'OS22XBITMAPHEADER', 108: 'BITMAPV4HEADER', 124: 'BITMAPV5HEADER' };

/** Anzahl gesetzter Bits einer Maske (Bits je Kanal). */
function bits(maske: number): number {
  let n = 0;
  for (let m = maske >>> 0; m; m >>>= 1) n += m & 1;
  return n;
}

export const bmpInspector: AssetInspector = {
  id: ID,
  formats: ['bmp'],
  extensions: ['.bmp', '.dib'],
  magic: [{ offset: 0, bytes: [0x42, 0x4d], format: 'bmp' }],
  version: VERSION,
  pruefeMagic(_filePath, head, size) {
    if (head.length < 18) return false;
    const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    const dib = b.readUInt32LE(14);
    const pixel = b.readUInt32LE(10);
    return DIB_GROESSEN.includes(dib) && pixel >= 14 + dib && (size === undefined || pixel <= size);
  },
  async inspect(src, _ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'bmp', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const k = await src.readRange(0, 14 + 124);
      if (k.length < 26 || k.toString('latin1', 0, 2) !== 'BM') {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'Kein BMP-Dateikopf (BM) oder Datei zu kurz.');
        return;
      }
      const dateiGroesse = k.readUInt32LE(2);
      const pixelOffset = k.readUInt32LE(10);
      const dib = k.readUInt32LE(14);
      if (!DIB_GROESSEN.includes(dib) || k.length < 14 + Math.min(dib, 40)) {
        res.status = 'fehler';
        warnung(res, 'dib_unbekannt', `Unbekannte DIB-Kopfgroesse ${dib}.`);
        return;
      }
      let breite: number, hoehe: number, bpp: number, kompression = 0, farben = 0, dpiX: number | null = null, dpiY: number | null = null;
      let topDown = false;
      if (dib === 12) {
        breite = k.readUInt16LE(18); hoehe = k.readUInt16LE(20); bpp = k.readUInt16LE(24);
      } else {
        breite = k.readInt32LE(18);
        const h = k.readInt32LE(22);
        topDown = h < 0;
        hoehe = Math.abs(h);
        bpp = k.readUInt16LE(28);
        if (dib >= 40) {
          kompression = k.readUInt32LE(30);
          const xppm = k.readInt32LE(38), yppm = k.readInt32LE(42);
          dpiX = xppm > 0 ? Math.round(xppm * 0.0254 * 100) / 100 : null;
          dpiY = yppm > 0 ? Math.round(yppm * 0.0254 * 100) / 100 : null;
          farben = k.readUInt32LE(46);
        }
      }
      if (breite <= 0) warnung(res, 'breite_ungueltig', `Breite ${breite} ist ungueltig.`);
      pruefeAbmessungen(res, Math.max(0, breite), hoehe);
      if (dateiGroesse !== src.size) warnung(res, 'dateigroesse_abweichend', `Kopf meldet ${dateiGroesse} Bytes, die Datei hat ${src.size}.`, dateiGroesse > src.size);
      if (pixelOffset > src.size) warnung(res, 'pixeldaten_fehlen', `Pixeldaten-Offset ${pixelOffset} liegt hinter dem Dateiende.`);

      // Farbmasken: im Kopf ab V2 (52+), sonst bei BITFIELDS direkt hinter dem 40-Byte-Kopf.
      let rot = 0, gruen = 0, blau = 0, alphaMaske = 0;
      if (kompression === 3 || kompression === 6 || dib >= 52) {
        const m = dib >= 52 ? k : await src.readRange(14 + 40, 16);
        const o = dib >= 52 ? 54 : 0;
        if (m.length >= o + 12) { rot = m.readUInt32LE(o); gruen = m.readUInt32LE(o + 4); blau = m.readUInt32LE(o + 8); }
        if ((dib >= 56 || kompression === 6) && m.length >= o + 16) alphaMaske = m.readUInt32LE(o + 12);
      }
      const indiziert = bpp <= 8;
      const palette = indiziert ? (farben || 2 ** bpp) : farben || 0;
      let alpha = alphaMaske !== 0;
      if (bpp === 32 && kompression === 0 && dib < 56) {
        // BI_RGB 32 bit: das vierte Byte ist offiziell unbenutzt, wird aber oft als Alpha verwendet.
        warnung(res, 'alpha_unklar', '32 bit BI_RGB: viertes Byte ohne Alpha-Maske (offiziell unbenutzt).', false);
        alpha = false;
      }
      const kanalBits = indiziert ? 8 : (rot && gruen && blau) ? Math.max(bits(rot), bits(gruen), bits(blau)) : bpp === 16 ? 5 : 8;
      const kanaele = (bpp === 1 && palette === 2) ? 3 : alpha ? 4 : 3;
      res.metadata = bildMetadata(
        {
          kind: 'image',
          width: Math.max(0, breite),
          height: hoehe,
          has_alpha: alpha,
          channels: kanaele,
          bits_per_channel: kanalBits,
          format_name: indiziert ? `BMP indiziert ${bpp} bit` : `BMP ${bpp} bit`,
          fmt: bpp > 0 && kompression === 0 ? { bw: 1, bh: 1, bits: bpp } : null,
        },
        {
          animated: false,
          frame_count: 1,
          bits_per_pixel: bpp,
          kompression: KOMPRESSION[kompression] ?? 'unbekannt(' + kompression + ')',
          palette_eintraege: palette || null,
          top_down: topDown,
          dpi_x: dpiX,
          dpi_y: dpiY,
          mime_type: 'image/bmp',
        }
      );
      res.format_specific = {
        dib_kopf: DIB_NAME[dib] ?? String(dib),
        dib_groesse: dib,
        pixel_offset: pixelOffset,
        datei_groesse_kopf: dateiGroesse,
        masken: rot || gruen || blau || alphaMaske ? { rot, gruen, blau, alpha: alphaMaske } : null,
      };
    });
    return res;
  },
};
