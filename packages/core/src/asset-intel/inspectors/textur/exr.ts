/**
 * MODUL: Textur-Inspektor OpenEXR
 * ZWECK: Magic 0x762f3101, Versionswort (tiled, long names, deep, multipart), Attributliste bis zum
 *        Header-Ende: channels (HALF/FLOAT/UINT), compression, dataWindow, displayWindow, lineOrder,
 *        pixelAspectRatio, tiles, type, name, chunkCount, chromaticities (P4-T64). Multipart: ALLE Header.
 *
 * Gelesen wird hoechstens HEADER_MAX vom Dateianfang; Offset-Tabellen und Pixel-Chunks bleiben unberuehrt.
 */

import { BinaryReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { bildMetadata, kuerze, maxMipKette, pruefeAbmessungen, sicher, warnung } from './util.js';

const ID = 'textur-exr';
const VERSION = 1;
const HEADER_MAX = 1024 * 1024;
const ATTR_MAX = 1024;
const ATTR_LISTE_MAX = 64;
const KANAL_MAX = 1024;

const KOMPRESSION = ['NO', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K256', 'HTJ2K32'];
const ZEILENFOLGE = ['increasing_y', 'decreasing_y', 'random_y'];
const PIXELTYP = ['UINT', 'HALF', 'FLOAT'];
const PIXEL_BYTES = [4, 2, 4];
const PIXEL_KURZ = ['32U', '16F', '32F'];

interface Kanal {
  name: string;
  pixel_typ: string;
  p_linear: boolean;
  x_sampling: number;
  y_sampling: number;
}

interface Teil {
  start: number;
  ende: number;
  kanaele: Kanal[];
  compression: string | null;
  dataWindow: number[] | null;
  displayWindow: number[] | null;
  lineOrder: string | null;
  pixelAspect: number | null;
  tiles: { x: number; y: number; modus: string; rundung: string } | null;
  typ: string | null;
  name: string | null;
  view: string | null;
  chunkCount: number | null;
  chromaticities: number[] | null;
  attribute: Array<{ name: string; type: string; size: number; wert?: unknown }>;
  attributeGesamt: number;
  vollstaendig: boolean;
}

function einfacherWert(typ: string, d: Buffer): unknown {
  try {
    switch (typ) {
      case 'string':
        return kuerze(d.toString('utf8'));
      case 'int':
        return d.length >= 4 ? d.readInt32LE(0) : undefined;
      case 'float':
        return d.length >= 4 ? d.readFloatLE(0) : undefined;
      case 'double':
        return d.length >= 8 ? d.readDoubleLE(0) : undefined;
      case 'v2i':
        return d.length >= 8 ? [d.readInt32LE(0), d.readInt32LE(4)] : undefined;
      case 'v2f':
        return d.length >= 8 ? [d.readFloatLE(0), d.readFloatLE(4)] : undefined;
      case 'v3f':
        return d.length >= 12 ? [d.readFloatLE(0), d.readFloatLE(4), d.readFloatLE(8)] : undefined;
      case 'box2i':
        return d.length >= 16 ? [d.readInt32LE(0), d.readInt32LE(4), d.readInt32LE(8), d.readInt32LE(12)] : undefined;
      case 'rational':
        return d.length >= 8 ? [d.readInt32LE(0), d.readUInt32LE(4)] : undefined;
      case 'envmap':
        return d.length >= 1 ? d[0] : undefined;
      case 'preview':
        return d.length >= 8 ? { breite: d.readUInt32LE(0), hoehe: d.readUInt32LE(4) } : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Liest einen Header (Attribute bis zum leeren Namen). Bricht bei kaputten Laengen ab, ohne zu werfen. */
function leseTeil(r: BinaryReader, res: { warnings: Array<{ code: string; message: string }> }, pruefe: () => void, gekuerzt: boolean): Teil {
  const t: Teil = {
    start: r.position, ende: r.position, kanaele: [], compression: null, dataWindow: null, displayWindow: null, lineOrder: null, pixelAspect: null, tiles: null, typ: null, name: null, view: null, chunkCount: null, chromaticities: null, attribute: [], attributeGesamt: 0, vollstaendig: false,
  };
  for (;;) {
    pruefe();
    const name = r.cstring(256);
    if (name === '') {
      t.vollstaendig = true;
      break;
    }
    const typ = r.cstring(256);
    const size = r.u32le();
    if (size > r.remaining) {
      res.warnings.push({
        code: gekuerzt ? 'header_ueber_lesefenster' : 'attribut_ueber_dateiende',
        message: `Attribut "${name}" (${typ}) meldet ${size} Bytes, es sind nur noch ${r.remaining} lesbar${gekuerzt ? ` (Header-Lesefenster ${HEADER_MAX} Bytes)` : ' (Datei abgeschnitten oder Laenge manipuliert)'}.`,
      });
      break;
    }
    const d = Buffer.from(r.bytes(size));
    t.attributeGesamt++;
    if (t.attributeGesamt > ATTR_MAX) {
      res.warnings.push({ code: 'attribute_gekappt', message: `Mehr als ${ATTR_MAX} Attribute in einem Header; Rest wird uebersprungen.` });
      break;
    }
    try {
      switch (name) {
        case 'channels': {
          const cr = new BinaryReader(d);
          while (cr.remaining > 0 && t.kanaele.length < KANAL_MAX) {
            const kn = cr.cstring(256);
            if (kn === '') break;
            const pt = cr.u32le();
            const pl = cr.u8();
            cr.skip(3);
            const xs = cr.u32le();
            const ys = cr.u32le();
            t.kanaele.push({ name: kn, pixel_typ: PIXELTYP[pt] ?? `unbekannt(${pt})`, p_linear: pl === 1, x_sampling: xs, y_sampling: ys });
          }
          break;
        }
        case 'compression':
          t.compression = KOMPRESSION[d[0]] ?? `unbekannt(${d[0]})`;
          break;
        case 'dataWindow':
          if (d.length >= 16) t.dataWindow = [d.readInt32LE(0), d.readInt32LE(4), d.readInt32LE(8), d.readInt32LE(12)];
          break;
        case 'displayWindow':
          if (d.length >= 16) t.displayWindow = [d.readInt32LE(0), d.readInt32LE(4), d.readInt32LE(8), d.readInt32LE(12)];
          break;
        case 'lineOrder':
          t.lineOrder = ZEILENFOLGE[d[0]] ?? `unbekannt(${d[0]})`;
          break;
        case 'pixelAspectRatio':
          if (d.length >= 4) t.pixelAspect = d.readFloatLE(0);
          break;
        case 'tiles':
          if (d.length >= 9) t.tiles = { x: d.readUInt32LE(0), y: d.readUInt32LE(4), modus: ['ONE_LEVEL', 'MIPMAP_LEVELS', 'RIPMAP_LEVELS'][d[8] & 15] ?? `unbekannt(${d[8] & 15})`, rundung: (d[8] >> 4) & 1 ? 'ROUND_UP' : 'ROUND_DOWN' };
          break;
        case 'type':
          t.typ = d.toString('utf8');
          break;
        case 'name':
          t.name = kuerze(d.toString('utf8'), 80);
          break;
        case 'view':
          t.view = kuerze(d.toString('utf8'), 80);
          break;
        case 'chunkCount':
          if (d.length >= 4) t.chunkCount = d.readInt32LE(0);
          break;
        case 'chromaticities':
          if (d.length >= 32) t.chromaticities = [0, 1, 2, 3, 4, 5, 6, 7].map(i => d.readFloatLE(i * 4));
          break;
        default:
          break;
      }
    } catch {
      res.warnings.push({ code: 'attribut_defekt', message: `Attribut "${name}" (${typ}) ist in sich nicht lesbar.` });
    }
    if (t.attribute.length < ATTR_LISTE_MAX) {
      const wert = name === 'channels' ? undefined : einfacherWert(typ, d);
      t.attribute.push(wert === undefined ? { name, type: typ, size } : { name, type: typ, size, wert });
    }
  }
  t.ende = r.position;
  return t;
}

/** Kurzname eines Kanalsatzes, z. B. RGBA16F; sonst '5ch 16F'. */
function kanalFormat(kanaele: Kanal[]): { name: string | null; bits: number | null } {
  if (kanaele.length === 0) return { name: null, bits: null };
  const typen = new Set(kanaele.map(k => k.pixel_typ));
  const typ = typen.size === 1 ? [...typen][0] : null;
  const idx = typ ? PIXELTYP.indexOf(typ) : -1;
  const bits = idx >= 0 ? PIXEL_BYTES[idx] * 8 : null;
  const basis = kanaele.map(k => k.name.split('.').pop() ?? k.name);
  if (idx < 0) return { name: `${kanaele.length}ch gemischt`, bits };
  const rgba = ['R', 'G', 'B', 'A'].filter(c => basis.includes(c));
  if (basis.length === new Set(basis).size && rgba.length > 0 && rgba.length === basis.length) return { name: rgba.join('') + PIXEL_KURZ[idx], bits };
  if (basis.length === 1) return { name: basis[0] + PIXEL_KURZ[idx], bits };
  return { name: `${kanaele.length}ch ${PIXEL_KURZ[idx]}`, bits };
}

/** Anzahl Mip-/Rip-Stufen je Achse. */
function stufenZahl(w: number, h: number, t: Teil['tiles']): { x: number; y: number } {
  if (!t || t.modus === 'ONE_LEVEL') return { x: 1, y: 1 };
  const max = (n: number): number => {
    if (n <= 1) return 1;
    return t.rundung === 'ROUND_UP' ? Math.ceil(Math.log2(n)) + 1 : Math.floor(Math.log2(n)) + 1;
  };
  if (t.modus === 'MIPMAP_LEVELS') {
    const n = max(Math.max(w, h));
    return { x: n, y: n };
  }
  return { x: max(w), y: max(h) };
}

function kante(n: number, i: number, rundung: string): number {
  const q = n / 2 ** i;
  return Math.max(1, rundung === 'ROUND_UP' ? Math.ceil(q) : Math.floor(q));
}

export const exrInspector: AssetInspector = {
  id: ID,
  formats: ['exr'],
  extensions: ['.exr'],
  magic: [{ offset: 0, bytes: [0x76, 0x2f, 0x31, 0x01], format: 'exr' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'exr', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const buf = await src.readRange(0, Math.min(src.size, HEADER_MAX));
      if (buf.length < 4 || buf.readUInt32BE(0) !== 0x762f3101) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'EXR-Magic 0x762f3101 fehlt (Endung passt nicht zum Inhalt).');
        return;
      }
      if (buf.length < 8) {
        warnung(res, 'abgeschnitten', 'Versionswort fehlt (Datei endet nach 4 Bytes).');
        return;
      }
      const wort = buf.readUInt32LE(4);
      const version = wort & 0xff;
      const flags = { tiled: (wort & 0x200) !== 0, long_names: (wort & 0x400) !== 0, deep: (wort & 0x800) !== 0, multipart: (wort & 0x1000) !== 0 };
      if (version !== 2) warnung(res, 'version_unbekannt', `EXR-Version ${version} (erwartet 2); Auswertung unsicher.`);
      const gekuerzt = buf.length < src.size;

      const r = new BinaryReader(buf);
      r.seek(8);
      const teile: Teil[] = [];
      try {
        for (;;) {
          ctx.pruefeAbbruch();
          if (flags.multipart && r.remaining > 0 && buf[r.position] === 0) {
            r.skip(1); // leerer Header beendet die Liste
            break;
          }
          if (teile.length >= ctx.limits.maxObjects) {
            warnung(res, 'teile_gekappt', `Mehr als ${ctx.limits.maxObjects} Header; Liste gekappt.`);
            break;
          }
          const t = leseTeil(r, res, () => ctx.pruefeAbbruch(), gekuerzt);
          teile.push(t);
          if (!t.vollstaendig || !flags.multipart) break;
        }
      } catch (e) {
        // Header endet mitten in einem Namen/Typ: Datei abgeschnitten oder beschaedigt; bisher Gelesenes bleibt.
        if ((e as Error).name === 'AssetReadError') warnung(res, gekuerzt ? 'header_ueber_lesefenster' : 'abgeschnitten', `Header endet unvollstaendig: ${(e as Error).message}`);
        else throw e;
      }
      if (teile.length > 0 && !teile[teile.length - 1].vollstaendig && res.warnings.every(w => w.code !== 'header_ueber_lesefenster' && w.code !== 'attribut_ueber_dateiende' && w.code !== 'attribute_gekappt')) {
        warnung(res, 'header_unvollstaendig', 'Header ohne abschliessendes Null-Byte.');
      }
      if (res.warnings.some(w => w.code === 'header_ueber_lesefenster' || w.code === 'attribut_ueber_dateiende' || w.code === 'attribute_gekappt')) {
        if (res.status === 'ok') res.status = 'teilweise';
      }

      if (teile.length === 0) {
        res.status = 'fehler';
        warnung(res, 'kein_header', 'Kein EXR-Header lesbar.');
        return;
      }

      const teilInfos: Array<Record<string, unknown>> = [];
      let rohGesamt: number | null = 0;
      teile.forEach((t, i) => {
        let w: number | null = null;
        let h: number | null = null;
        if (t.dataWindow) {
          const [x0, y0, x1, y1] = t.dataWindow;
          if (x1 < x0 || y1 < y0) warnung(res, 'datawindow_ungueltig', `Teil ${i}: dataWindow ${t.dataWindow.join(',')} hat negative Ausdehnung.`);
          else {
            w = x1 - x0 + 1;
            h = y1 - y0 + 1;
            pruefeAbmessungen(res, w, h);
          }
        } else if (t.vollstaendig) warnung(res, 'datawindow_fehlt', `Teil ${i}: Pflichtattribut dataWindow fehlt.`);
        if (t.vollstaendig && t.kanaele.length === 0) warnung(res, 'channels_fehlen', `Teil ${i}: Pflichtattribut channels fehlt oder leer.`);
        if (t.vollstaendig && !t.compression) warnung(res, 'compression_fehlt', `Teil ${i}: Pflichtattribut compression fehlt.`);
        if (flags.multipart && t.vollstaendig && (!t.name || !t.typ)) warnung(res, 'part_attribute_fehlen', `Teil ${i}: Multipart verlangt name und type.`);
        const deep = flags.deep || (t.typ !== null && t.typ.startsWith('deep'));
        const stufen = w !== null && h !== null ? stufenZahl(w, h, t.tiles) : { x: 1, y: 1 };
        if (t.tiles && t.tiles.modus !== 'ONE_LEVEL' && !flags.tiled && !flags.multipart) warnung(res, 'tiles_ohne_flag', `Teil ${i}: tiles-Attribut gesetzt, aber Tiled-Flag im Versionswort fehlt.`, false);
        // Rohgroesse: Summe ueber alle Stufen.
        let roh: number | null = null;
        if (w !== null && h !== null && !deep && t.kanaele.length > 0) {
          const pixelBytes = t.kanaele.reduce((s, k) => s + PIXEL_BYTES[PIXELTYP.indexOf(k.pixel_typ)] / (Math.max(1, k.x_sampling) * Math.max(1, k.y_sampling)), 0);
          let px = 0;
          const rd = t.tiles?.rundung ?? 'ROUND_DOWN';
          if (t.tiles?.modus === 'RIPMAP_LEVELS') {
            let sx = 0;
            let sy = 0;
            for (let a = 0; a < Math.min(stufen.x, 40); a++) sx += kante(w, a, rd);
            for (let b = 0; b < Math.min(stufen.y, 40); b++) sy += kante(h, b, rd);
            px = sx * sy;
          } else {
            for (let a = 0; a < Math.min(stufen.x, 40); a++) px += kante(w, a, rd) * kante(h, a, rd);
          }
          const summe = Math.round(px * pixelBytes);
          roh = Number.isSafeInteger(summe) ? summe : null;
        }
        rohGesamt = rohGesamt !== null && roh !== null ? rohGesamt + roh : null;
        const kf = kanalFormat(t.kanaele);
        const info = {
          name: t.name,
          type: t.typ,
          compression: t.compression,
          width: w,
          height: h,
          data_window: t.dataWindow,
          display_window: t.displayWindow,
          line_order: t.lineOrder,
          pixel_aspect_ratio: t.pixelAspect,
          tiles: t.tiles,
          kanaele: t.kanaele,
          format_name: kf.name,
          deep,
          chunk_count: t.chunkCount,
          view: t.view,
          geschaetzte_roh_bytes: roh,
          attribute_gesamt: t.attributeGesamt,
        };
        teilInfos.push({ ...info, stufen });
        if (res.objects.length < ctx.limits.maxObjects) {
          res.objects.push({ name: t.name ?? `part${i}`, kind: 'part', data: info, source_range: { offset: t.start, length: Math.max(0, t.ende - t.start) } });
        }
      });

      const erst = teile[0];
      const ew = erst.dataWindow && erst.dataWindow[2] >= erst.dataWindow[0] ? erst.dataWindow[2] - erst.dataWindow[0] + 1 : null;
      const eh = erst.dataWindow && erst.dataWindow[3] >= erst.dataWindow[1] ? erst.dataWindow[3] - erst.dataWindow[1] + 1 : null;
      const kf = kanalFormat(erst.kanaele);
      const hatAlpha = erst.kanaele.length > 0 ? erst.kanaele.some(k => (k.name.split('.').pop() ?? k.name) === 'A') : null;
      const stufe0 = ew !== null && eh !== null ? stufenZahl(ew, eh, erst.tiles) : { x: 1, y: 1 };
      const mipLevels = erst.tiles?.modus === 'RIPMAP_LEVELS' ? Math.max(stufe0.x, stufe0.y) : stufe0.x;
      res.metadata = bildMetadata(
        {
          kind: 'texture',
          width: ew,
          height: eh,
          mip_levels: mipLevels,
          has_alpha: hatAlpha,
          channels: erst.kanaele.length > 0 ? erst.kanaele.length : null,
          bits_per_channel: kf.bits,
          color_space: erst.chromaticities ? 'chromaticities_angegeben' : null,
          transfer: 'linear_konvention',
          format_name: kf.name,
          roh_bytes: rohGesamt,
        },
        {
          compression: erst.compression,
          teile: teile.length,
          tiled: flags.tiled || erst.tiles !== null,
          deep: flags.deep,
          multipart: flags.multipart,
          line_order: erst.lineOrder,
          pixel_aspect_ratio: erst.pixelAspect,
          display_window: erst.displayWindow,
          kanaele: erst.kanaele.map(k => k.name),
          mip_kette_max: ew !== null && eh !== null ? maxMipKette(ew, eh) : null,
        }
      );
      res.format_specific = {
        version,
        versionswort: '0x' + wort.toString(16).padStart(8, '0'),
        flags,
        header_gelesen_bytes: buf.length,
        teile: teilInfos,
        attribute: erst.attribute,
        chromaticities: erst.chromaticities,
      };
    });
    return res;
  },
};
