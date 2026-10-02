/**
 * MODUL: Textur-Inspektor KTX (Version 1.1)
 * ZWECK: Header (Endian-Marker, glType/glFormat/glInternalFormat in Klartext, Abmessungen, Array-Elemente,
 *        Flaechen, Mip-Zahl), Key/Value-Daten (gekappt) und die Level-Laengen (imageSize je Mip) gegen die
 *        Dateigroesse (P4-T64). Pixeldaten werden nie gelesen.
 */

import { leseReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { GL_FORMAT, GL_INTERN, GL_TYP, glRohname } from './formate.js';
import { bildMetadata, hex32, maxMipKette, parseKeyValue, pruefeAbmessungen, pruefeMips, sicher, warnung } from './util.js';

const ID = 'textur-ktx';
const VERSION = 1;
const KENNUNG = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const KV_MAX = 64 * 1024;
/** Hoechstzahl Level, die der Durchlauf der imageSize-Felder verfolgt. */
const LEVEL_MAX = 32;

export const ktxInspector: AssetInspector = {
  id: ID,
  formats: ['ktx'],
  extensions: ['.ktx'],
  magic: [{ offset: 0, bytes: KENNUNG, format: 'ktx' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'ktx', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const id = await src.readRange(0, 12);
      if (id.length < 12 || !KENNUNG.every((b, i) => id[i] === b)) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'KTX-1.1-Kennung fehlt (Endung passt nicht zum Inhalt).');
        return;
      }
      const r = await leseReader(src, 0, 64);
      r.skip(12);
      const marker = r.bytes(4);
      const mLe = Buffer.from(marker).readUInt32LE(0);
      let le: boolean;
      if (mLe === 0x04030201) le = true;
      else if (mLe === 0x01020304) le = false;
      else {
        res.status = 'fehler';
        warnung(res, 'endian_marker_ungueltig', `Endian-Marker ${hex32(mLe)} ist weder 0x04030201 noch 0x01020304.`);
        return;
      }
      const u32 = (): number => (le ? r.u32le() : r.u32be());
      const glType = u32();
      const glTypeSize = u32();
      const glFormat = u32();
      const glInternal = u32();
      const glBase = u32();
      const breite = u32();
      const hoeheRoh = u32();
      const tiefeRoh = u32();
      const arrayRoh = u32();
      const flaechen = u32();
      const mipRoh = u32();
      const kvBytes = u32();

      const hoehe = Math.max(1, hoeheRoh);
      const tiefe = Math.max(1, tiefeRoh);
      const schichten = Math.max(1, arrayRoh);
      const komprimiert = glType === 0 && glFormat === 0;
      const fmt = GL_INTERN[glInternal] ?? null;
      const mipsAngabe = Math.max(1, mipRoh);
      const mipsGeneriert = mipRoh === 0;
      const dim = tiefeRoh > 0 ? 3 : hoeheRoh > 0 ? 2 : 1;

      if (breite === 0) warnung(res, 'abmessung_null', 'pixelWidth ist 0 (ungueltig).');
      pruefeAbmessungen(res, breite, hoehe, tiefe);
      if (flaechen !== 1 && flaechen !== 6) warnung(res, 'flaechenzahl_ungueltig', `numberOfFaces ist ${flaechen}, erlaubt sind 1 oder 6.`);
      if (flaechen === 6 && dim === 3) warnung(res, 'cubemap_volumen', 'Cubemap mit pixelDepth > 0 ist ungueltig.');
      const mips = breite > 0 ? pruefeMips(res, mipsAngabe, breite, hoehe, tiefe) : mipsAngabe;
      if (!fmt) warnung(res, 'format_unbekannt', `glInternalFormat ${glRohname(glInternal)} ist nicht in der Tabelle.`, false);
      if (komprimiert && glInternal === 0) warnung(res, 'format_fehlt', 'Komprimiert (glType/glFormat 0), aber glInternalFormat 0.');

      res.objects.push({ name: 'KTX_HEADER', kind: 'header', data: { endian: le ? 'little' : 'big', gl_type: glType, gl_format: glFormat, gl_internal_format: glInternal, bytes_of_key_value_data: kvBytes }, source_range: { offset: 0, length: 64 } });

      // Key/Value-Daten.
      const kvStart = 64;
      let kv: ReturnType<typeof parseKeyValue> = { eintraege: [], problem: null, gekappt: false };
      let kvLesen = 0;
      if (kvBytes > 0) {
        kvLesen = Math.min(kvBytes, KV_MAX, Math.max(0, src.size - kvStart));
        if (kvBytes > src.size - kvStart) warnung(res, 'kv_ueber_dateiende', `bytesOfKeyValueData ${kvBytes} reicht ueber das Dateiende (${Math.max(0, src.size - kvStart)} Bytes dahinter).`);
        else if (kvBytes > KV_MAX) warnung(res, 'kv_gekappt', `Key/Value-Daten (${kvBytes} Bytes) werden nur bis ${KV_MAX} Bytes ausgewertet.`, false);
        const buf = kvLesen > 0 ? await src.readRange(kvStart, kvLesen) : Buffer.alloc(0);
        kv = parseKeyValue(buf, le, Math.min(64, ctx.limits.maxObjects));
        if (kv.problem) warnung(res, 'kv_defekt', kv.problem);
        if (kv.gekappt) warnung(res, 'kv_eintraege_gekappt', 'Mehr als 64 Key/Value-Eintraege; Rest nicht aufgelistet.', false);
        res.objects.push({ name: 'KeyValueData', kind: 'key_value', data: { eintraege: kv.eintraege.length }, source_range: { offset: kvStart, length: kvLesen } });
      }

      // Level-Durchlauf ueber die imageSize-Felder.
      let pos = kvStart + kvBytes;
      const nichtArrayCube = flaechen === 6 && arrayRoh === 0;
      const levels: Array<{ stufe: number; offset: number; image_size: number; bytes_gesamt: number }> = [];
      let levelProblem = false;
      const n = Math.min(mipsAngabe, LEVEL_MAX);
      for (let i = 0; i < n; i++) {
        ctx.pruefeAbbruch();
        if (pos + 4 > src.size) {
          if (!levelProblem) warnung(res, 'levels_fehlen', `Level ${i}: Datei endet bei ${src.size}, das imageSize-Feld stuende bei ${pos}.`);
          levelProblem = true;
          break;
        }
        const f = await src.readRange(pos, 4);
        const imageSize = le ? f.readUInt32LE(0) : f.readUInt32BE(0);
        const padded = Math.ceil(imageSize / 4) * 4;
        const gesamt = nichtArrayCube ? padded * 6 : padded;
        if (pos + 4 + gesamt > src.size) {
          warnung(res, 'level_ueber_dateiende', `Level ${i}: imageSize ${imageSize}${nichtArrayCube ? ' (x6 Flaechen)' : ''} reicht ueber das Dateiende (${Math.max(0, src.size - pos - 4)} Bytes dahinter).`);
          levelProblem = true;
          if (res.objects.length < ctx.limits.maxObjects) res.objects.push({ name: `mip${i}`, kind: 'mip_level', data: { image_size: imageSize, abgeschnitten: true }, source_range: { offset: pos, length: Math.max(0, src.size - pos) } });
          levels.push({ stufe: i, offset: pos, image_size: imageSize, bytes_gesamt: gesamt });
          break;
        }
        if (res.objects.length < ctx.limits.maxObjects) {
          res.objects.push({ name: `mip${i}`, kind: 'mip_level', data: { image_size: imageSize, bytes_gesamt: gesamt, flaechen: nichtArrayCube ? 6 : undefined }, source_range: { offset: pos, length: 4 + gesamt } });
        }
        levels.push({ stufe: i, offset: pos, image_size: imageSize, bytes_gesamt: gesamt });
        pos += 4 + gesamt;
      }
      if (mipsAngabe > LEVEL_MAX) warnung(res, 'levels_gekappt', `${mipsAngabe} Level angegeben, nur die ersten ${LEVEL_MAX} werden verfolgt.`, false);
      if (!levelProblem && pos < src.size) warnung(res, 'daten_nach_levels', `${src.size - pos} Bytes nach dem letzten Level.`, false);

      const farbe = fmt ? (fmt.srgb ? 'sRGB' : null) : null;
      res.metadata = bildMetadata(
        {
          kind: 'texture',
          width: breite,
          height: hoehe,
          depth: tiefe,
          mip_levels: mips,
          array_layers: schichten,
          faces: flaechen === 6 ? 6 : 1,
          has_alpha: fmt ? fmt.alpha : glFormat === 0x1908 || glFormat === 0x80e1 ? true : null,
          channels: fmt?.ch ?? null,
          bits_per_channel: fmt?.bpc ?? null,
          color_space: farbe,
          transfer: fmt ? (fmt.srgb ? 'sRGB' : 'linear_oder_unbekannt') : null,
          format_name: fmt?.name ?? (glInternal !== 0 ? glRohname(glInternal) : GL_FORMAT[glFormat] ?? null),
          fmt,
        },
        {
          dimension: dim === 3 ? 'texture3d' : dim === 2 ? 'texture2d' : 'texture1d',
          komprimiert: komprimiert,
          mipmaps_zur_laufzeit_erzeugen: mipsGeneriert,
          endian: le ? 'little' : 'big',
          mip_kette_max: breite > 0 ? maxMipKette(breite, hoehe, tiefe) : null,
          key_value: Object.fromEntries(kv.eintraege.map(e => [e.key, e.value])),
        }
      );
      res.format_specific = {
        gl_type: glType,
        gl_type_name: GL_TYP[glType] ?? null,
        gl_type_size: glTypeSize,
        gl_format: glFormat,
        gl_format_name: GL_FORMAT[glFormat] ?? null,
        gl_internal_format: glInternal,
        gl_internal_format_hex: glRohname(glInternal),
        gl_base_internal_format: glBase,
        gl_base_internal_format_name: GL_FORMAT[glBase] ?? null,
        number_of_array_elements: arrayRoh,
        number_of_faces: flaechen,
        number_of_mipmap_levels: mipRoh,
        pixel_height_roh: hoeheRoh,
        pixel_depth_roh: tiefeRoh,
        bytes_of_key_value_data: kvBytes,
        key_value_eintraege: kv.eintraege,
        levels,
      };
    });
    return res;
  },
};
