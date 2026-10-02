/**
 * MODUL: Textur-Inspektor DDS
 * ZWECK: DDS_HEADER (Flags, Abmessungen, Pitch, Tiefe, MipMapCount, Pixelformat als FourCC oder
 *        Bitmasken, caps/caps2 mit Cubemap und Volume), optional DDS_HEADER_DXT10 (dxgiFormat in
 *        Klartext, resourceDimension, miscFlag, arraySize, alphaMode). Prueft die Nutzdatengroesse
 *        gegen die Dateigroesse (P4-T64). Pixeldaten werden nie gelesen.
 */

import { leseReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { DXGI, FOURCC, dxgiRohname } from './formate.js';
import type { FormatInfo } from './formate.js';
import { bildMetadata, hex32, maxMipKette, pruefeAbmessungen, pruefeMips, sicher, stufenBytes, stufenKante, vierZeichen, warnung } from './util.js';

const ID = 'textur-dds';
const VERSION = 1;

const DDSD_MIPMAPCOUNT = 0x20000;
const DDSD_DEPTH = 0x800000;
const DDSD_PITCH = 0x8;
const DDSD_LINEARSIZE = 0x80000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_ALPHA = 0x2;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_YUV = 0x200;
const DDPF_LUMINANCE = 0x20000;
const CAPS2_CUBEMAP = 0x200;
const CAPS2_VOLUME = 0x200000;
const CAPS_MIPMAP = 0x400000;
const DIMENSIONEN: Record<number, string> = { 2: 'texture1d', 3: 'texture2d', 4: 'texture3d' };
const ALPHA_MODI = ['unbekannt', 'straight', 'premultiplied', 'opaque', 'custom'];
const FACE_NAMEN: Array<[number, string]> = [[0x400, '+X'], [0x800, '-X'], [0x1000, '+Y'], [0x2000, '-Y'], [0x4000, '+Z'], [0x8000, '-Z']];

/** Erkennt klassische Bitmasken-Pixelformate. */
function maskenFormat(flags: number, bits: number, r: number, g: number, b: number, a: number): FormatInfo | null {
  const mk = (name: string, ch: number, bpc: number | null, alpha: boolean): FormatInfo => ({ name, bw: 1, bh: 1, bits, ch, bpc, alpha, srgb: false, komprimiert: false });
  if (flags & DDPF_RGB) {
    if (bits === 32) {
      if (r === 0xff && g === 0xff00 && b === 0xff0000) return a === 0xff000000 ? mk('RGBA8', 4, 8, true) : mk('RGBX8', 3, 8, false);
      if (r === 0xff0000 && g === 0xff00 && b === 0xff) return a === 0xff000000 ? mk('BGRA8', 4, 8, true) : mk('BGRX8', 3, 8, false);
      if (r === 0xffff && g === 0xffff0000) return mk('RG16', 2, 16, false);
      if (r === 0x3ff && g === 0xffc00 && b === 0x3ff00000) return mk('RGB10A2', 4, null, true);
    } else if (bits === 24) {
      if (r === 0xff0000 && g === 0xff00 && b === 0xff) return mk('BGR8', 3, 8, false);
      if (r === 0xff && g === 0xff00 && b === 0xff0000) return mk('RGB8', 3, 8, false);
    } else if (bits === 16) {
      if (r === 0xf800 && g === 0x7e0 && b === 0x1f) return mk('B5G6R5', 3, null, false);
      if (r === 0x7c00 && g === 0x3e0 && b === 0x1f) return mk('B5G5R5A1', a ? 4 : 3, null, a !== 0);
      if (r === 0xf00 && g === 0xf0 && b === 0xf) return mk('B4G4R4A4', 4, 4, true);
    }
    return mk(`RGB${bits} (Masken ${hex32(r)} ${hex32(g)} ${hex32(b)} ${hex32(a)})`, [r, g, b, a].filter(x => x !== 0).length, null, a !== 0);
  }
  if (flags & DDPF_LUMINANCE) return mk(a ? `LA${bits / 2}` : `L${bits}`, a ? 2 : 1, a ? bits / 2 : bits, a !== 0);
  if (flags & DDPF_ALPHA) return mk(`A${bits}`, 1, bits, true);
  return null;
}

export const ddsInspector: AssetInspector = {
  id: ID,
  formats: ['dds'],
  extensions: ['.dds'],
  magic: [{ offset: 0, bytes: [0x44, 0x44, 0x53, 0x20], format: 'dds' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'dds', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const probe = await src.readRange(0, 4);
      if (probe.length < 4 || probe.toString('latin1') !== 'DDS ') {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', "DDS-Magic 'DDS ' fehlt (Endung passt nicht zum Inhalt).");
        return;
      }
      const r = await leseReader(src, 0, 128); // wirft 'abgeschnitten', wenn < 128 Bytes
      r.skip(4);
      const hSize = r.u32le();
      const flags = r.u32le();
      const hoehe = r.u32le();
      const breite = r.u32le();
      const pitchOderGroesse = r.u32le();
      const tiefeRoh = r.u32le();
      const mipRoh = r.u32le();
      r.skip(44); // reserved1[11]
      const pfSize = r.u32le();
      const pfFlags = r.u32le();
      const fourccRoh = r.bytes(4);
      const fourcc = vierZeichen(fourccRoh, 0);
      const fourccZahl = Buffer.from(fourccRoh).readUInt32LE(0);
      const rgbBits = r.u32le();
      const rMask = r.u32le();
      const gMask = r.u32le();
      const bMask = r.u32le();
      const aMask = r.u32le();
      const caps = r.u32le();
      const caps2 = r.u32le();
      const caps3 = r.u32le();
      const caps4 = r.u32le();

      if (hSize !== 124) warnung(res, 'header_groesse_ungueltig', `dwSize ist ${hSize}, erwartet 124.`);
      if (pfSize !== 32) warnung(res, 'pixelformat_groesse_ungueltig', `Pixelformat-dwSize ist ${pfSize}, erwartet 32.`);
      if (!(flags & 0x1) || !(flags & 0x2) || !(flags & 0x4) || !(flags & 0x1000)) {
        warnung(res, 'pflichtflags_fehlen', `DDSD-Flags ${hex32(flags)} enthalten nicht CAPS|HEIGHT|WIDTH|PIXELFORMAT.`, false);
      }

      const dx10 = (pfFlags & DDPF_FOURCC) !== 0 && fourcc === 'DX10';
      let dxgi: number | null = null;
      let resDim: number | null = null;
      let misc = 0;
      let arraySize = 1;
      let misc2 = 0;
      if (dx10) {
        if (src.size < 148) {
          warnung(res, 'abgeschnitten', `FourCC DX10 verlangt 20 Bytes Zusatzheader, die Datei hat nur ${src.size} Bytes.`);
        } else {
          const x = await leseReader(src, 128, 20);
          dxgi = x.u32le();
          resDim = x.u32le();
          misc = x.u32le();
          arraySize = x.u32le();
          misc2 = x.u32le();
        }
      }
      const datenOffset = dx10 ? 148 : 128;

      // Format bestimmen.
      let fmt: FormatInfo | null = null;
      let rohKennung: Record<string, unknown> = {};
      if (dx10 && dxgi !== null) {
        fmt = DXGI[dxgi] ?? null;
        rohKennung = { dxgi_format: dxgi, dxgi_name: dxgiRohname(dxgi) };
        if (!fmt) warnung(res, 'format_unbekannt', `DXGI-Format ${dxgi} (${dxgiRohname(dxgi)}) ist nicht in der Tabelle; Groessenpruefung entfaellt.`, false);
      } else if (pfFlags & DDPF_FOURCC) {
        fmt = FOURCC[fourcc] ?? FOURCC['#' + fourccZahl] ?? null;
        rohKennung = { fourcc, fourcc_wert: fourccZahl };
        if (!fmt) warnung(res, 'format_unbekannt', `FourCC ${JSON.stringify(fourcc)} (${fourccZahl}) ist nicht in der Tabelle; Groessenpruefung entfaellt.`, false);
      } else {
        fmt = maskenFormat(pfFlags, rgbBits, rMask, gMask, bMask, aMask);
        rohKennung = { rgb_bit_count: rgbBits, masken: { r: hex32(rMask), g: hex32(gMask), b: hex32(bMask), a: hex32(aMask) } };
        if (!fmt) warnung(res, 'format_unbekannt', `Pixelformat-Flags ${hex32(pfFlags)} mit ${rgbBits} Bit nicht erkannt (YUV/sonstiges); Groessenpruefung entfaellt.`, false);
        if (pfFlags & DDPF_YUV) rohKennung.yuv = true;
      }

      // Abmessungen, Cubemap, Volume, Mips.
      const cube = (caps2 & CAPS2_CUBEMAP) !== 0 || (misc & 0x4) !== 0;
      const vorhandeneFlaechen = FACE_NAMEN.filter(([bit]) => (caps2 & bit) !== 0).map(([, n]) => n);
      let flaechen = 1;
      if (cube) {
        flaechen = dx10 && (misc & 0x4) !== 0 ? 6 : vorhandeneFlaechen.length || 6;
        if (!dx10 && vorhandeneFlaechen.length !== 6) warnung(res, 'cubemap_unvollstaendig', `Cubemap-Flag gesetzt, aber nur ${vorhandeneFlaechen.length} von 6 Flaechen markiert (${vorhandeneFlaechen.join(' ') || 'keine'}).`);
      }
      const volumen = (caps2 & CAPS2_VOLUME) !== 0 || resDim === 4;
      const tiefe = volumen ? Math.max(1, (flags & DDSD_DEPTH) !== 0 || resDim === 4 ? tiefeRoh : 1) : 1;
      if (volumen && tiefeRoh === 0) warnung(res, 'volumen_ohne_tiefe', 'Volume-Textur ohne Tiefenangabe (depth = 0).');
      if (cube && volumen) warnung(res, 'cubemap_und_volumen', 'Cubemap- und Volume-Flag gleichzeitig gesetzt.');
      const schichten = dx10 ? arraySize : 1;
      if (dx10 && (arraySize === 0 || arraySize > 2048)) warnung(res, 'array_groesse_absurd', `arraySize ${arraySize} ausserhalb 1..2048.`);
      if (dx10 && resDim !== null && !DIMENSIONEN[resDim]) warnung(res, 'dimension_unbekannt', `resourceDimension ${resDim} unbekannt.`, false);

      const hatMipFlag = (flags & DDSD_MIPMAPCOUNT) !== 0 || (caps & CAPS_MIPMAP) !== 0;
      let mips = (flags & DDSD_MIPMAPCOUNT) !== 0 ? Math.max(1, mipRoh) : 1;
      if (hatMipFlag && mips === 1 && mipRoh > 1) mips = mipRoh;
      pruefeAbmessungen(res, breite, hoehe, volumen ? tiefe : 1);
      const mipsWirksam = breite > 0 && hoehe > 0 ? pruefeMips(res, mips, breite, hoehe, volumen ? tiefe : 1) : mips;

      // Nutzdaten gegen Dateigroesse.
      let erwartet: number | null = null;
      const stufen: Array<{ breite: number; hoehe: number; tiefe: number; bytes: number }> = [];
      if (fmt && breite > 0 && hoehe > 0) {
        let summe = 0;
        const n = Math.min(mipsWirksam, 40);
        for (let i = 0; i < n; i++) {
          const lw = stufenKante(breite, i);
          const lh = stufenKante(hoehe, i);
          const ld = volumen ? stufenKante(tiefe, i) : 1;
          const b = stufenBytes(lw, lh, ld, fmt);
          summe += b;
          stufen.push({ breite: lw, hoehe: lh, tiefe: ld, bytes: b });
        }
        const gesamt = summe * schichten * flaechen;
        erwartet = Number.isSafeInteger(gesamt) ? gesamt : null;
      }
      const tatsaechlich = Math.max(0, src.size - datenOffset);
      let nutzdatenStatus: string | null = null;
      if (erwartet !== null) {
        if (tatsaechlich < erwartet) {
          nutzdatenStatus = 'zu_kurz';
          warnung(res, 'nutzdaten_zu_kurz', `Nutzdaten: erwartet ${erwartet} Bytes, vorhanden ${tatsaechlich} (${erwartet - tatsaechlich} fehlen; Datei abgeschnitten oder Mip-Angabe falsch).`);
        } else if (tatsaechlich > erwartet) {
          nutzdatenStatus = 'ueberschuss';
          warnung(res, 'nutzdaten_ueberschuss', `Nutzdaten: erwartet ${erwartet} Bytes, vorhanden ${tatsaechlich} (${tatsaechlich - erwartet} zu viel).`);
        } else nutzdatenStatus = 'passt';
      }

      // Objekte: Header-Bloecke und Mip-Stufen der ersten Schicht.
      res.objects.push({ name: 'DDS_HEADER', kind: 'header', data: { flags: hex32(flags), caps: hex32(caps), caps2: hex32(caps2), pitch_oder_lineare_groesse: pitchOderGroesse, pitch_flag: (flags & DDSD_PITCH) !== 0, lineare_groesse_flag: (flags & DDSD_LINEARSIZE) !== 0 }, source_range: { offset: 0, length: Math.min(128, src.size) } });
      if (dx10) res.objects.push({ name: 'DDS_HEADER_DXT10', kind: 'header', data: { dxgi_format: dxgi, dxgi_name: dxgi === null ? null : dxgiRohname(dxgi), resource_dimension: resDim === null ? null : (DIMENSIONEN[resDim] ?? resDim), misc_flag: hex32(misc), array_size: arraySize, alpha_mode: ALPHA_MODI[misc2 & 7] ?? misc2 & 7 }, source_range: { offset: 128, length: Math.min(20, Math.max(0, src.size - 128)) } });
      if (stufen.length > 0) {
        let off = datenOffset;
        for (let i = 0; i < stufen.length && i < ctx.limits.maxObjects; i++) {
          ctx.pruefeAbbruch();
          const s = stufen[i];
          res.objects.push({ name: `mip${i}`, kind: 'mip_level', data: { breite: s.breite, hoehe: s.hoehe, tiefe: s.tiefe, bytes: s.bytes, schicht: 0 }, source_range: { offset: off, length: s.bytes } });
          off += s.bytes;
        }
      }

      const dimension = resDim !== null ? (DIMENSIONEN[resDim] ?? null) : volumen ? 'texture3d' : 'texture2d';
      const alphaModus = dx10 ? (ALPHA_MODI[misc2 & 7] ?? null) : null;
      const hatAlpha = fmt ? fmt.alpha : (pfFlags & (DDPF_ALPHAPIXELS | DDPF_ALPHA)) !== 0 ? true : null;
      res.metadata = bildMetadata(
        {
          kind: 'texture',
          width: breite,
          height: hoehe,
          depth: volumen ? tiefe : 1,
          mip_levels: mipsWirksam,
          array_layers: schichten,
          faces: flaechen,
          has_alpha: hatAlpha,
          channels: fmt?.ch ?? null,
          bits_per_channel: fmt?.bpc ?? null,
          color_space: fmt ? (fmt.srgb ? 'sRGB' : null) : null,
          transfer: fmt ? (fmt.srgb ? 'sRGB' : 'linear_oder_unbekannt') : null,
          format_name: fmt?.name ?? (dx10 && dxgi !== null ? dxgiRohname(dxgi) : pfFlags & DDPF_FOURCC ? fourcc : null),
          fmt,
        },
        {
          dimension,
          komprimiert: fmt ? fmt.komprimiert : null,
          cubemap: cube,
          volumen,
          alpha_modus: alphaModus,
          nutzdaten: { daten_offset: datenOffset, vorhanden_bytes: tatsaechlich, erwartet_bytes: erwartet, status: nutzdatenStatus },
          mip_kette_max: breite > 0 && hoehe > 0 ? maxMipKette(breite, hoehe, volumen ? tiefe : 1) : null,
        }
      );
      res.format_specific = {
        header_groesse: hSize,
        flags: hex32(flags),
        pixelformat: { flags: hex32(pfFlags), ...rohKennung },
        caps: hex32(caps),
        caps2: hex32(caps2),
        caps3: hex32(caps3),
        caps4: hex32(caps4),
        mip_map_count_roh: mipRoh,
        depth_roh: tiefeRoh,
        cubemap_flaechen: cube ? vorhandeneFlaechen : [],
        dxt10: dx10 ? { dxgi_format: dxgi, resource_dimension: resDim, misc_flag: hex32(misc), array_size: arraySize, misc_flags2: hex32(misc2) } : null,
      };
    });
    return res;
  },
};
