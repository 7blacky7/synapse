/**
 * MODUL: Textur-Inspektor KTX2
 * ZWECK: Header (vkFormat in Klartext, typeSize, Abmessungen, layerCount, faceCount, levelCount,
 *        supercompressionScheme), Level-Index (Offsets/Groessen gegen die Dateigroesse), Data Format
 *        Descriptor (colorModel, Primaries, transferFunction, Flags) und Key/Value-Daten
 *        (KTXorientation, KTXwriter, ...) (P4-T64). Pixeldaten werden nie gelesen.
 */

import { leseReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { KTX2_SUPERCOMPRESSION, VK } from './formate.js';
import { bildMetadata, maxMipKette, parseKeyValue, pruefeAbmessungen, pruefeMips, sicher, warnung } from './util.js';

const ID = 'textur-ktx2';
const VERSION = 1;
const KENNUNG = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const DFD_MAX = 4096;
const KV_MAX = 64 * 1024;
const LEVEL_MAX = 32;

const COLOR_MODEL: Record<number, string> = {
  0: 'UNSPECIFIED', 1: 'RGBSDA', 2: 'YUVSDA', 3: 'YIQSDA', 4: 'LABSDA', 5: 'CMYKA', 6: 'XYZW', 128: 'BC1A', 129: 'BC2', 130: 'BC3', 131: 'BC4', 132: 'BC5', 133: 'BC6H', 134: 'BC7', 160: 'ETC1', 161: 'ETC2', 162: 'ASTC', 163: 'ETC1S', 164: 'PVRTC', 165: 'PVRTC2', 166: 'UASTC',
};
const PRIMARIES: Record<number, string> = {
  0: 'UNSPECIFIED', 1: 'BT709', 2: 'BT601_EBU', 3: 'BT601_SMPTE', 4: 'BT2020', 5: 'CIEXYZ', 6: 'ACES', 7: 'ACESCC', 8: 'NTSC1953', 9: 'PAL525', 10: 'DISPLAYP3', 11: 'ADOBERGB',
};
const TRANSFER: Record<number, string> = {
  0: 'UNSPECIFIED', 1: 'LINEAR', 2: 'SRGB', 3: 'ITU', 4: 'NTSC', 5: 'SLOG', 6: 'SLOG2', 7: 'BT1886', 8: 'HLG_OETF', 9: 'HLG_EOTF', 10: 'PQ_EOTF', 11: 'PQ_OETF', 12: 'DCIP3', 13: 'PAL_OETF', 14: 'PAL625_EOTF', 15: 'ST240', 16: 'ACESCC', 17: 'ACESCCT', 18: 'ADOBERGB',
};

/** bigint als Zahl; null, wenn nicht exakt darstellbar. */
function bigZahl(v: bigint): number | null {
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
}

/** u64 (little-endian) aus einem Buffer als Zahl; null, wenn nicht exakt darstellbar. */
function u64(b: Buffer, o: number): number | null {
  const v = b.readBigUInt64LE(o);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
}

export const ktx2Inspector: AssetInspector = {
  id: ID,
  formats: ['ktx2'],
  extensions: ['.ktx2'],
  magic: [{ offset: 0, bytes: KENNUNG, format: 'ktx2' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'ktx2', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const id = await src.readRange(0, 12);
      if (id.length < 12 || !KENNUNG.every((b, i) => id[i] === b)) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'KTX2-Kennung fehlt (Endung passt nicht zum Inhalt).');
        return;
      }
      const r = await leseReader(src, 0, 80);
      r.skip(12);
      const vkFormat = r.u32le();
      const typeSize = r.u32le();
      const breite = r.u32le();
      const hoeheRoh = r.u32le();
      const tiefeRoh = r.u32le();
      const layerRoh = r.u32le();
      const faceRoh = r.u32le();
      const levelRoh = r.u32le();
      const superc = r.u32le();
      const dfdOff = r.u32le();
      const dfdLen = r.u32le();
      const kvdOff = r.u32le();
      const kvdLen = r.u32le();
      const sgdOff = bigZahl(r.u64le());
      const sgdLen = bigZahl(r.u64le());

      const hoehe = Math.max(1, hoeheRoh);
      const tiefe = Math.max(1, tiefeRoh);
      const schichten = Math.max(1, layerRoh);
      const fmt = VK[vkFormat] ?? null;
      const dim = tiefeRoh > 0 ? 3 : hoeheRoh > 0 ? 2 : 1;
      const levelAnzahl = Math.max(1, levelRoh);
      const mipsGeneriert = levelRoh === 0;

      if (breite === 0) warnung(res, 'abmessung_null', 'pixelWidth ist 0 (ungueltig).');
      pruefeAbmessungen(res, breite, hoehe, tiefe);
      if (faceRoh !== 1 && faceRoh !== 6) warnung(res, 'flaechenzahl_ungueltig', `faceCount ist ${faceRoh}, erlaubt sind 1 oder 6.`);
      if (faceRoh === 6 && dim === 3) warnung(res, 'cubemap_volumen', 'Cubemap mit pixelDepth > 0 ist ungueltig.');
      const mips = breite > 0 ? pruefeMips(res, levelAnzahl, breite, hoehe, tiefe) : levelAnzahl;
      if (!KTX2_SUPERCOMPRESSION[superc]) warnung(res, 'supercompression_unbekannt', `supercompressionScheme ${superc} ist nicht bekannt.`);
      if (!fmt && vkFormat !== 0) warnung(res, 'format_unbekannt', `vkFormat ${vkFormat} ist nicht in der Tabelle.`, false);

      res.objects.push({ name: 'KTX2_HEADER', kind: 'header', data: { vk_format: vkFormat, type_size: typeSize, supercompression: KTX2_SUPERCOMPRESSION[superc] ?? superc }, source_range: { offset: 0, length: 80 } });

      // Level-Index.
      const levelGelesen = Math.min(levelAnzahl, LEVEL_MAX);
      if (levelAnzahl > LEVEL_MAX) warnung(res, 'levels_gekappt', `levelCount ${levelAnzahl} ueber ${LEVEL_MAX}; nur die ersten ${LEVEL_MAX} Level werden gelesen.`);
      const levels: Array<{ stufe: number; byte_offset: number | null; byte_length: number | null; uncompressed_byte_length: number | null; ausserhalb: boolean }> = [];
      let rohSumme: number | null = 0;
      const liBytes = levelGelesen * 24;
      if (80 + liBytes > src.size) {
        warnung(res, 'levelindex_abgeschnitten', `Level-Index (${liBytes} Bytes ab 80) reicht ueber das Dateiende.`);
        rohSumme = null;
      }
      const li = await src.readRange(80, Math.min(liBytes, Math.max(0, src.size - 80)));
      const vorhandeneLevel = Math.floor(li.length / 24);
      let ausserhalbZahl = 0;
      for (let i = 0; i < vorhandeneLevel; i++) {
        ctx.pruefeAbbruch();
        const off = u64(li, i * 24);
        const len = u64(li, i * 24 + 8);
        const unc = u64(li, i * 24 + 16);
        const aus = off === null || len === null || off + len > src.size;
        if (aus) {
          ausserhalbZahl++;
          if (ausserhalbZahl <= 8) {
            warnung(res, 'level_ausserhalb', `Level ${i}: byteOffset ${off ?? 'riesig'} + byteLength ${len ?? 'riesig'} liegt ausserhalb der Datei (${src.size} Bytes).`);
          }
        }
        if (rohSumme !== null && unc !== null) rohSumme += unc;
        else rohSumme = null;
        levels.push({ stufe: i, byte_offset: off, byte_length: len, uncompressed_byte_length: unc, ausserhalb: aus });
        if (res.objects.length < ctx.limits.maxObjects) {
          res.objects.push({ name: `level${i}`, kind: 'mip_level', data: { byte_length: len, uncompressed_byte_length: unc, ausserhalb: aus }, source_range: { offset: off !== null && len !== null && !aus ? off : 0, length: off !== null && len !== null && !aus ? len : 0 } });
        }
      }

      if (ausserhalbZahl > 8) warnung(res, 'level_ausserhalb_gesamt', `Insgesamt ${ausserhalbZahl} von ${vorhandeneLevel} Leveln liegen ausserhalb der Datei (nur die ersten 8 einzeln gemeldet).`);

      // Data Format Descriptor.
      let dfd: Record<string, unknown> | null = null;
      let dfdAlpha: boolean | null = null;
      if (dfdLen > 0) {
        if (dfdOff + dfdLen > src.size) {
          warnung(res, 'dfd_ausserhalb', `DFD (${dfdLen} Bytes ab ${dfdOff}) liegt ausserhalb der Datei.`);
        } else {
          const roh = await src.readRange(dfdOff, Math.min(dfdLen, DFD_MAX));
          if (roh.length >= 28) {
            const total = roh.readUInt32LE(0);
            const blockSize = roh.readUInt16LE(10);
            const model = roh[12];
            const prim = roh[13];
            const tf = roh[14];
            const fl = roh[15];
            const proben: Array<{ kanal: number; bit_offset: number; bit_laenge: number }> = [];
            const nProben = blockSize >= 24 ? Math.floor((blockSize - 24) / 16) : 0;
            for (let i = 0; i < nProben && i < 16 && 28 + i * 16 + 16 <= roh.length; i++) {
              const o = 28 + i * 16;
              proben.push({ bit_offset: roh.readUInt16LE(o), bit_laenge: roh[o + 2] + 1, kanal: roh[o + 3] & 15 });
            }
            if (model === 1 || model === 163) dfdAlpha = proben.some(p => p.kanal === 15);
            else if (model === 166) dfdAlpha = proben.some(p => p.kanal === 3);
            dfd = {
              total_size: total,
              descriptor_block_size: blockSize,
              color_model: COLOR_MODEL[model] ?? model,
              color_primaries: PRIMARIES[prim] ?? prim,
              transfer_function: TRANSFER[tf] ?? tf,
              alpha_premultiplied: (fl & 1) === 1,
              texel_block_dimension: [roh[16] + 1, roh[17] + 1, roh[18] + 1, roh[19] + 1],
              bytes_plane0: roh[20],
              samples: proben,
            };
            if (total !== dfdLen) warnung(res, 'dfd_groesse_abweichend', `DFD totalSize ${total} weicht von dfdByteLength ${dfdLen} ab.`, false);
          } else warnung(res, 'dfd_zu_kurz', `DFD hat nur ${roh.length} Bytes (mindestens 28 erwartet).`);
          res.objects.push({ name: 'DFD', kind: 'data_format_descriptor', data: dfd ?? {}, source_range: { offset: dfdOff, length: dfdLen } });
        }
      } else warnung(res, 'dfd_fehlt', 'Kein Data Format Descriptor (dfdByteLength 0); laut Spezifikation Pflicht.', false);

      if (vkFormat === 0 && !dfd) warnung(res, 'format_undefiniert', 'vkFormat UNDEFINED und kein auswertbarer DFD: das Format ist nicht bestimmbar.');

      // Key/Value.
      let kv: ReturnType<typeof parseKeyValue> = { eintraege: [], problem: null, gekappt: false };
      if (kvdLen > 0) {
        if (kvdOff + kvdLen > src.size) {
          warnung(res, 'kvd_ausserhalb', `Key/Value-Daten (${kvdLen} Bytes ab ${kvdOff}) liegen ausserhalb der Datei.`);
        } else {
          if (kvdLen > KV_MAX) warnung(res, 'kv_gekappt', `Key/Value-Daten (${kvdLen} Bytes) werden nur bis ${KV_MAX} Bytes ausgewertet.`, false);
          const buf = await src.readRange(kvdOff, Math.min(kvdLen, KV_MAX));
          kv = parseKeyValue(buf, true, Math.min(64, ctx.limits.maxObjects));
          if (kv.problem) warnung(res, 'kv_defekt', kv.problem);
          if (kv.gekappt) warnung(res, 'kv_eintraege_gekappt', 'Mehr als 64 Key/Value-Eintraege; Rest nicht aufgelistet.', false);
          res.objects.push({ name: 'KeyValueData', kind: 'key_value', data: { eintraege: kv.eintraege.length }, source_range: { offset: kvdOff, length: kvdLen } });
        }
      }
      if (sgdLen !== null && sgdLen > 0 && sgdOff !== null) {
        if (sgdOff + sgdLen > src.size) warnung(res, 'sgd_ausserhalb', `Supercompression Global Data (${sgdLen} Bytes ab ${sgdOff}) liegt ausserhalb der Datei.`);
        else res.objects.push({ name: 'SGD', kind: 'supercompression_global_data', data: { byte_length: sgdLen }, source_range: { offset: sgdOff, length: sgdLen } });
      }

      const transferDfd = dfd ? String(dfd.transfer_function) : null;
      const rohBytes = fmt && breite > 0 ? undefined : rohSumme !== null && rohSumme > 0 ? rohSumme : null;
      const hatAlpha = fmt ? fmt.alpha : dfdAlpha;
      const colorModel = dfd ? String(dfd.color_model) : null;
      const formatName = fmt?.name ?? (vkFormat === 0 ? `UNDEFINED${colorModel ? ' (' + colorModel + ')' : ''}` : `vkFormat ${vkFormat}`);
      const kvMap = Object.fromEntries(kv.eintraege.map(e => [e.key, e.value]));
      res.metadata = bildMetadata(
        {
          kind: 'texture',
          width: breite,
          height: hoehe,
          depth: tiefe,
          mip_levels: mips,
          array_layers: schichten,
          faces: faceRoh === 6 ? 6 : 1,
          has_alpha: hatAlpha,
          channels: fmt?.ch ?? null,
          bits_per_channel: fmt?.bpc ?? null,
          color_space: dfd ? `${String(dfd.color_primaries)}` : fmt?.srgb ? 'sRGB' : null,
          transfer: transferDfd ?? (fmt ? (fmt.srgb ? 'SRGB' : null) : null),
          format_name: formatName,
          fmt,
          roh_bytes: rohBytes,
        },
        {
          dimension: dim === 3 ? 'texture3d' : dim === 2 ? 'texture2d' : 'texture1d',
          supercompression: KTX2_SUPERCOMPRESSION[superc] ?? `unbekannt(${superc})`,
          komprimiert: fmt ? fmt.komprimiert : vkFormat === 0 ? true : null,
          mipmaps_zur_laufzeit_erzeugen: mipsGeneriert,
          mip_kette_max: breite > 0 ? maxMipKette(breite, hoehe, tiefe) : null,
          ktx_orientation: kvMap['KTXorientation'] ?? null,
          ktx_writer: kvMap['KTXwriter'] ?? null,
          key_value: kvMap,
        }
      );
      res.format_specific = {
        vk_format: vkFormat,
        type_size: typeSize,
        pixel_height_roh: hoeheRoh,
        pixel_depth_roh: tiefeRoh,
        layer_count_roh: layerRoh,
        face_count: faceRoh,
        level_count_roh: levelRoh,
        supercompression_scheme: superc,
        index: { dfd_offset: dfdOff, dfd_length: dfdLen, kvd_offset: kvdOff, kvd_length: kvdLen, sgd_offset: sgdOff, sgd_length: sgdLen },
        dfd,
        level_index: levels,
        key_value_eintraege: kv.eintraege,
      };
    });
    return res;
  },
};
