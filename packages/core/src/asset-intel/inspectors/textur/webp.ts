/**
 * MODUL: Textur-Inspektor WebP
 * ZWECK: RIFF/WEBP-Container: Chunks VP8 (lossy), VP8L (lossless), VP8X (Erweiterung: Alpha, Animation,
 *        ICC/EXIF/XMP-Flags, Canvas), ALPH, ANIM, ANMF (Frame-Zahl, je Frame Position/Groesse/Dauer) (P4-T64).
 *
 * Magic ist 'WEBP' an Offset 8 (nicht 'RIFF' an 0), damit WAV/AVI nicht kollidieren.
 * Es werden nur Chunk-Koepfe und die ersten Bytes der Bitstroeme gelesen.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { Lesefenster, bildMetadata, pruefeAbmessungen, sicher, vierZeichen, warnung } from './util.js';

const ID = 'textur-webp';
const VERSION = 1;

function u24(b: Buffer, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

export const webpInspector: AssetInspector = {
  id: ID,
  formats: ['webp'],
  extensions: ['.webp'],
  magic: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50], format: 'webp' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'webp', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const win = new Lesefenster(src);
      const kopf = await win.lese(0, 12);
      if (kopf.length < 12 || kopf.toString('latin1', 0, 4) !== 'RIFF' || kopf.toString('latin1', 8, 12) !== 'WEBP') {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'Kein RIFF/WEBP-Kopf (Endung passt nicht zum Inhalt oder Datei zu kurz).');
        return;
      }
      const riffGroesse = kopf.readUInt32LE(4);
      const riffEnde = riffGroesse + 8;
      if (riffEnde > src.size) warnung(res, 'riff_groesse_abweichend', `RIFF-Groesse meldet ${riffEnde} Bytes, die Datei hat ${src.size} (abgeschnitten).`);
      else if (riffEnde < src.size) warnung(res, 'daten_nach_riff', `${src.size - riffEnde} Bytes nach dem RIFF-Ende.`, false);
      const ende = Math.min(src.size, riffEnde);

      let pos = 12;
      let vp8x: { flags: number; w: number; h: number } | null = null;
      let vp8: { w: number; h: number; keyframe: boolean; version: number; skalierung: [number, number] } | null = null;
      let vp8l: { w: number; h: number; alpha: boolean; version: number } | null = null;
      let alph = false;
      let iccp = false;
      let exif = false;
      let xmp = false;
      let anim: { hintergrund: number; loops: number } | null = null;
      let frames = 0;
      let framesLossy = 0;
      let framesLossless = 0;
      let dauerGesamt = 0;
      const typen: string[] = [];
      let gekappt = false;

      while (pos + 8 <= ende) {
        ctx.pruefeAbbruch();
        const h = await win.lese(pos, 8);
        if (h.length < 8) break;
        const fourcc = vierZeichen(h, 0);
        const groesse = h.readUInt32LE(4);
        const start = pos + 8;
        const abgeschnitten = start + groesse > src.size;
        if (abgeschnitten) warnung(res, 'chunk_abgeschnitten', `Chunk ${fourcc} bei Offset ${pos} meldet ${groesse} Bytes, die Datei hat nur ${Math.max(0, src.size - start)}.`);
        const lesen = Math.min(groesse, 40, Math.max(0, src.size - start));
        const d = lesen > 0 ? await src.readRange(start, lesen) : Buffer.alloc(0);
        const info: Record<string, unknown> = { length: groesse };
        if (!typen.includes(fourcc)) typen.push(fourcc);

        switch (fourcc) {
          case 'VP8X':
            if (d.length >= 10) {
              vp8x = { flags: d[0], w: u24(d, 4) + 1, h: u24(d, 7) + 1 };
              Object.assign(info, { canvas_breite: vp8x.w, canvas_hoehe: vp8x.h, icc: !!(d[0] & 0x20), alpha: !!(d[0] & 0x10), exif: !!(d[0] & 0x08), xmp: !!(d[0] & 0x04), animation: !!(d[0] & 0x02) });
            } else warnung(res, 'vp8x_zu_kurz', `VP8X hat ${d.length} statt 10 Bytes.`);
            break;
          case 'VP8 ':
            if (d.length >= 10) {
              const tag = d[0] | (d[1] << 8) | (d[2] << 16);
              const keyframe = (tag & 1) === 0;
              if (keyframe && d[3] === 0x9d && d[4] === 0x01 && d[5] === 0x2a) {
                const w = d.readUInt16LE(6);
                const hh = d.readUInt16LE(8);
                const v = { w: w & 0x3fff, h: hh & 0x3fff, keyframe, version: (tag >> 1) & 7, skalierung: [w >> 14, hh >> 14] as [number, number] };
                if (frames === 0 || !vp8) vp8 = v;
                Object.assign(info, { breite: v.w, hoehe: v.h, version: v.version });
              } else warnung(res, 'vp8_kein_keyframe', 'VP8-Bitstrom beginnt nicht mit gueltigem Keyframe-Startcode; Abmessungen unbekannt.');
            } else warnung(res, 'vp8_zu_kurz', `VP8-Chunk hat nur ${d.length} Bytes.`);
            break;
          case 'VP8L':
            if (d.length >= 5 && d[0] === 0x2f) {
              const bits = d.readUInt32LE(1);
              const v = { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, alpha: ((bits >>> 28) & 1) === 1, version: bits >>> 29 };
              if (frames === 0 || !vp8l) vp8l = v;
              Object.assign(info, { breite: v.w, hoehe: v.h, alpha_genutzt: v.alpha, version: v.version });
            } else warnung(res, 'vp8l_signatur', 'VP8L-Chunk ohne Signaturbyte 0x2F.');
            break;
          case 'ALPH':
            alph = true;
            break;
          case 'ICCP':
            iccp = true;
            break;
          case 'EXIF':
            exif = true;
            break;
          case 'XMP ':
            xmp = true;
            break;
          case 'ANIM':
            if (d.length >= 6) {
              anim = { hintergrund: d.readUInt32LE(0), loops: d.readUInt16LE(4) };
              Object.assign(info, { hintergrund_bgra: '0x' + anim.hintergrund.toString(16).padStart(8, '0'), loop_count: anim.loops });
            }
            break;
          case 'ANMF':
            frames++;
            if (d.length >= 16) {
              const dauer = u24(d, 12);
              dauerGesamt += dauer;
              Object.assign(info, { x: u24(d, 0) * 2, y: u24(d, 3) * 2, breite: u24(d, 6) + 1, hoehe: u24(d, 9) + 1, dauer_ms: dauer, dispose_hintergrund: !!(d[15] & 1), blend_aus: !!(d[15] & 2) });
              if (start + 24 <= src.size) {
                const inner = await src.readRange(start + 16, 8);
                const cc = vierZeichen(inner, 0);
                info.codec_chunk = cc;
                if (cc === 'VP8 ') framesLossy++;
                else if (cc === 'VP8L') framesLossless++;
                else if (cc === 'ALPH') framesLossy++;
              }
            } else warnung(res, 'anmf_zu_kurz', `ANMF-Chunk hat nur ${d.length} Bytes.`);
            break;
          default:
            break;
        }

        if (res.objects.length < ctx.limits.maxObjects) {
          res.objects.push({ name: fourcc, kind: fourcc === 'ANMF' ? 'frame' : 'chunk', data: info, source_range: { offset: pos, length: Math.min(8 + groesse + (groesse & 1), src.size - pos) } });
        } else if (!gekappt) {
          gekappt = true;
          warnung(res, 'chunk_liste_gekappt', `Mehr als ${ctx.limits.maxObjects} Chunks; Liste gekappt.`);
        }
        if (abgeschnitten) break;
        pos = start + groesse + (groesse & 1);
      }

      const animiert = vp8x !== null && (vp8x.flags & 0x02) !== 0;
      let breite: number | null = null;
      let hoehe: number | null = null;
      if (vp8x) {
        breite = vp8x.w;
        hoehe = vp8x.h;
      } else if (vp8) {
        breite = vp8.w;
        hoehe = vp8.h;
      } else if (vp8l) {
        breite = vp8l.w;
        hoehe = vp8l.h;
      }
      if (breite === null || hoehe === null) {
        res.status = 'fehler';
        warnung(res, 'abmessungen_unbekannt', 'Weder VP8X noch ein lesbarer VP8/VP8L-Chunk: Abmessungen unbekannt.');
        return;
      }
      pruefeAbmessungen(res, breite, hoehe);
      if (!vp8x && !vp8 && !vp8l) warnung(res, 'bilddaten_fehlen', 'Kein VP8/VP8L/ANMF-Chunk.');
      if (!animiert) {
        const framesW = vp8 ?? vp8l;
        if (vp8x && framesW && (framesW.w !== vp8x.w || framesW.h !== vp8x.h)) {
          warnung(res, 'abmessungen_abweichend', `VP8X-Canvas ${vp8x.w}x${vp8x.h} weicht vom Bitstrom ${framesW.w}x${framesW.h} ab.`);
        }
      } else if (frames === 0 && !gekappt) {
        warnung(res, 'keine_frames', 'Animations-Flag gesetzt, aber kein ANMF-Chunk.');
      }

      const alpha = (vp8x ? (vp8x.flags & 0x10) !== 0 : false) || alph || (vp8l?.alpha ?? false);
      const kompression = animiert ? 'animiert' : vp8l ? 'lossless' : vp8 ? 'lossy' : null;
      res.metadata = bildMetadata(
        {
          kind: 'image',
          width: breite,
          height: hoehe,
          has_alpha: alpha,
          channels: alpha ? 4 : 3,
          bits_per_channel: 8,
          color_space: iccp || (vp8x !== null && (vp8x.flags & 0x20) !== 0) ? 'ICC-Profil eingebettet' : null,
          format_name: animiert ? 'WebP animiert' : vp8l ? 'WebP lossless' : 'WebP lossy',
          fmt: { bw: 1, bh: 1, bits: (alpha ? 4 : 3) * 8 },
        },
        {
          kompression,
          animated: animiert,
          frame_count: animiert ? frames : 1,
          loop_count: anim?.loops ?? null,
          dauer_gesamt_ms: animiert ? dauerGesamt : null,
          hat_icc_profil: iccp || (vp8x !== null && (vp8x.flags & 0x20) !== 0),
          hat_exif: exif || (vp8x !== null && (vp8x.flags & 0x08) !== 0),
          hat_xmp: xmp || (vp8x !== null && (vp8x.flags & 0x04) !== 0),
        }
      );
      res.format_specific = {
        riff_groesse: riffGroesse,
        chunk_typen: typen,
        vp8x: vp8x ? { flags: vp8x.flags, canvas: [vp8x.w, vp8x.h] } : null,
        vp8,
        vp8l,
        anim,
        frames_lossy: framesLossy,
        frames_lossless: framesLossless,
      };
    });
    return res;
  },
};
