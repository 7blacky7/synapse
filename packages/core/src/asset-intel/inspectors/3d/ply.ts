/**
 * MODUL: Asset 3D PLY
 * ZWECK: Inspektor fuer Stanford .ply: Header (format, Elemente + Properties, comment, obj_info),
 *        Zaehler, Bounding-Box aus vertex x/y/z (ASCII und binary little/big endian, mit Lesekappe)
 *        und Textur-Referenzen aus "comment TextureFile ...".
 *
 * Der Header wird auf MAX_HEADER_BYTES begrenzt gelesen. Bounding-Box binaer nur, wenn die
 * Zeilengroesse bekannt ist: das vertex-Element darf keine list-Property haben und alle
 * Elemente davor muessen feste Zeilengroesse haben. Sonst Warnung 'ply_bbox_nicht_berechenbar'.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { Bbox, Lesebudget, MAX_SCAN_BYTES, Sammler, kappeText, leseZeilen, sammleReferenz } from './helpers.js';

const MAX_HEADER_BYTES = 64 * 1024;

type Skalar = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const TYP_ALIAS: Record<string, Skalar> = {
  char: 'int8', int8: 'int8',
  uchar: 'uint8', uint8: 'uint8',
  short: 'int16', int16: 'int16',
  ushort: 'uint16', uint16: 'uint16',
  int: 'int32', int32: 'int32',
  uint: 'uint32', uint32: 'uint32',
  float: 'float32', float32: 'float32',
  double: 'float64', float64: 'float64',
};

const TYP_BYTES: Record<Skalar, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };

interface Prop {
  name: string;
  typ: Skalar | null;
  typRoh: string;
  liste?: { zaehlTyp: Skalar | null; itemTyp: Skalar | null };
}

interface Element {
  name: string;
  count: number;
  props: Prop[];
  line_start: number;
  line_end: number;
}

function leseSkalar(dv: DataView, off: number, t: Skalar, le: boolean): number {
  switch (t) {
    case 'int8': return dv.getInt8(off);
    case 'uint8': return dv.getUint8(off);
    case 'int16': return dv.getInt16(off, le);
    case 'uint16': return dv.getUint16(off, le);
    case 'int32': return dv.getInt32(off, le);
    case 'uint32': return dv.getUint32(off, le);
    case 'float32': return dv.getFloat32(off, le);
    default: return dv.getFloat64(off, le);
  }
}

/** Zeilengroesse in Bytes oder null, wenn eine list-Property oder ein unbekannter Typ dabei ist. */
function festeGroesse(e: Element): number | null {
  let sum = 0;
  for (const p of e.props) {
    if (p.liste || p.typ === null) return null;
    sum += TYP_BYTES[p.typ];
  }
  return sum;
}

/** Interne Kappung beim Durchlaufen des Koerpers (Lesebudget aufgebraucht). */
class Kappung extends Error {}

/** Ergebnis von wandereBinaer. */
interface Wanderung {
  /** Dateioffset des ersten Bytes je Element (nur fuer erreichte Elemente). */
  starts: Map<Element, number>;
  /** Offset hinter dem letzten Element, wenn der ganze Koerper durchlaufen wurde; sonst null. */
  ende: number | null;
  /** Summe der Dreiecke aus der face-Liste (max(0, n-2) je Flaeche); null ohne durchlaufenes face-Element. */
  dreiecke: number | null;
  abgeschnitten: boolean;
  ungueltig: boolean;
  /** Gelesen wurde nur bis zur Lesekappe. */
  gekappt: boolean;
  /** Element, in dem Abschneiden/Ungueltigkeit auftrat. */
  problemIn: string | null;
}

/**
 * Geht den Binaerkoerper Element fuer Element durch. Elemente fester Zeilengroesse werden per Formel
 * uebersprungen, Elemente mit list-Properties Zeile fuer Zeile gelesen (Fenster von 1 MiB, insgesamt
 * hoechstens MAX_SCAN_BYTES). So stimmt die erwartete Dateigroesse auch bei Flaechenlisten.
 */
async function wandereBinaer(
  src: AssetSource,
  ctx: AssetContext,
  budget: Lesebudget,
  elemente: Element[],
  bodyOffset: number,
  le: boolean
): Promise<Wanderung> {
  const starts = new Map<Element, number>();
  const w: Wanderung = { starts, ende: null, dreiecke: null, abgeschnitten: false, ungueltig: false, gekappt: false, problemIn: null };
  const maxBytes = Math.min(budget.rest, MAX_SCAN_BYTES);
  let gelesen = 0;
  let fenster: Buffer = Buffer.alloc(0);
  let fensterStart = 0;
  const lies = async (p: number, t: Skalar): Promise<number | null> => {
    const n = TYP_BYTES[t];
    if (p + n > src.size) return null;
    if (p < fensterStart || p + n > fensterStart + fenster.length) {
      if (gelesen >= maxBytes) throw new Kappung();
      fenster = await budget.lese(src, p, Math.min(1024 * 1024, src.size - p));
      fensterStart = p;
      gelesen += fenster.length;
      if (fenster.length < n) return null;
    }
    return leseSkalar(new DataView(fenster.buffer, fenster.byteOffset + (p - fensterStart), n), 0, t, le);
  };

  let pos = bodyOffset;
  try {
    for (const e of elemente) {
      starts.set(e, pos);
      const fest = festeGroesse(e);
      if (fest !== null) {
        pos += fest * e.count;
        if (pos > src.size) {
          w.abgeschnitten = true;
          w.problemIn = e.name;
          return w;
        }
        continue;
      }
      if (e.props.some(p => (p.liste ? !p.liste.zaehlTyp || !p.liste.itemTyp : p.typ === null))) {
        w.ungueltig = true;
        w.problemIn = e.name;
        return w;
      }
      let tri = 0;
      for (let r = 0; r < e.count; r++) {
        if ((r & 0x3fff) === 0) ctx.pruefeAbbruch();
        let ersteListe = true;
        for (const p of e.props) {
          if (p.liste) {
            const zt = p.liste.zaehlTyp as Skalar;
            const c = await lies(pos, zt);
            if (c === null) {
              w.abgeschnitten = true;
              w.problemIn = e.name;
              return w;
            }
            if (c < 0) {
              w.ungueltig = true;
              w.problemIn = e.name;
              return w;
            }
            pos += TYP_BYTES[zt] + c * TYP_BYTES[p.liste.itemTyp as Skalar];
            if (ersteListe && e.name === 'face') tri += c >= 3 ? c - 2 : 0;
            ersteListe = false;
          } else {
            pos += TYP_BYTES[p.typ as Skalar];
          }
        }
        if (pos > src.size) {
          w.abgeschnitten = true;
          w.problemIn = e.name;
          return w;
        }
      }
      if (e.name === 'face') w.dreiecke = (w.dreiecke ?? 0) + tri;
    }
    w.ende = pos;
  } catch (e) {
    if (e instanceof Kappung) w.gekappt = true;
    else throw e;
  }
  return w;
}

export const plyInspector: AssetInspector = {
  id: '3d-ply',
  formats: ['ply'],
  extensions: ['.ply'],
  magic: [
    { offset: 0, bytes: [0x70, 0x6c, 0x79, 0x0a], format: 'ply' },
    { offset: 0, bytes: [0x70, 0x6c, 0x79, 0x0d, 0x0a], format: 'ply' },
  ],
  version: 1,
  async inspect(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
    const s = new Sammler(ctx);
    const budget = new Lesebudget(ctx);
    const kopf = await budget.lese(src, 0, Math.min(src.size, MAX_HEADER_BYTES));
    const fertig = (extra: Partial<AssetResult>): AssetResult =>
      erzeugeAssetResult(src.filePath, src.size, {
        asset_type: 'model3d',
        format: 'ply',
        inspector: '3d-ply',
        parser_version: 1,
        status: s.problem ? 'teilweise' : 'ok',
        objects: s.objects,
        references: s.references,
        warnings: s.abschluss(),
        ...extra,
      });

    const kopfLatin = kopf.toString('latin1');
    if (!/^ply\r?\n/.test(kopfLatin)) {
      s.warn('inhalt_passt_nicht_zur_endung', 'Endung .ply, aber die Datei beginnt nicht mit "ply" + Zeilenende.');
      return fertig({ metadata: { gelesen_bytes: kopf.length } });
    }
    const endIdx = kopfLatin.search(/(^|\n)end_header\r?(\n|$)/);
    if (endIdx < 0) {
      s.warn('ply_header_unvollstaendig', `Kein end_header innerhalb der ersten ${kopf.length} Bytes (Header abgeschnitten oder ueber ${MAX_HEADER_BYTES} Bytes).`);
      return fertig({ metadata: { gelesen_bytes: kopf.length } });
    }
    const m = /(^|\n)end_header(\r?\n)?/.exec(kopfLatin.slice(endIdx));
    const bodyOffset = endIdx + (m ? m[0].length : 0);
    const headerLines = kopfLatin.slice(0, endIdx).split('\n');
    // end_header selbst zaehlt als Zeile endIdx-basiert; Zeilennummern 1-basiert.
    let formatName: string | null = null;
    let formatVersion: string | null = null;
    const comments: string[] = [];
    const objInfo: string[] = [];
    const elemente: Element[] = [];
    let aktuell: Element | null = null;
    const texturen: string[] = [];

    headerLines.forEach((roh, i) => {
      const nr = i + 1;
      const z = roh.replace(/\r$/, '').trim();
      if (z === '' || nr === 1) return;
      const t = z.split(/\s+/);
      switch (t[0]) {
        case 'format':
          formatName = t[1] ?? null;
          formatVersion = t[2] ?? null;
          break;
        case 'comment': {
          const c = z.slice(7).trim();
          if (comments.length < 200) comments.push(kappeText(c, 256));
          const tm = /^texturefile\s+(.+)$/i.exec(c);
          if (tm && texturen.length < 100) texturen.push(tm[1].trim());
          break;
        }
        case 'obj_info':
          if (objInfo.length < 200) objInfo.push(kappeText(z.slice(8).trim(), 256));
          break;
        case 'element': {
          const count = /^\d+$/.test(t[2] ?? '') ? Number(t[2]) : NaN;
          if (!t[1] || Number.isNaN(count) || !Number.isSafeInteger(count)) {
            s.warn('ply_element_ungueltig', `Zeile ${nr}: element braucht Namen und ganze Anzahl ("${kappeText(z, 80)}").`);
            aktuell = null;
            break;
          }
          aktuell = { name: kappeText(t[1], 64), count, props: [], line_start: nr, line_end: nr };
          elemente.push(aktuell);
          break;
        }
        case 'property': {
          if (!aktuell) {
            s.warn('ply_property_ohne_element', `Zeile ${nr}: property vor dem ersten gueltigen element.`);
            break;
          }
          aktuell.line_end = nr;
          if (t[1] === 'list') {
            const zt = TYP_ALIAS[t[2] ?? ''] ?? null;
            const it = TYP_ALIAS[t[3] ?? ''] ?? null;
            if (!zt || !it || !t[4]) s.warn('ply_typ_unbekannt', `Zeile ${nr}: list-Property mit unbekanntem Typ ("${kappeText(z, 80)}").`);
            aktuell.props.push({ name: kappeText(t[4] ?? '', 64), typ: null, typRoh: `list ${t[2]} ${t[3]}`, liste: { zaehlTyp: zt, itemTyp: it } });
          } else {
            const ty = TYP_ALIAS[t[1] ?? ''] ?? null;
            if (!ty || !t[2]) s.warn('ply_typ_unbekannt', `Zeile ${nr}: property mit unbekanntem Typ ("${kappeText(z, 80)}").`);
            aktuell.props.push({ name: kappeText(t[2] ?? '', 64), typ: ty, typRoh: t[1] ?? '' });
          }
          break;
        }
        default:
          s.info('ply_header_zeile_unbekannt', `Zeile ${nr}: unbekannte Header-Anweisung "${kappeText(t[0], 40)}".`);
      }
    });

    if (formatName === null) s.warn('ply_format_fehlt', 'Header ohne format-Zeile.');
    else if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(formatName)) {
      s.warn('ply_format_unbekannt', `Format "${kappeText(formatName, 40)}" wird nicht unterstuetzt.`);
    }
    if (formatVersion !== null && formatVersion !== '1.0') s.warn('ply_version_unbekannt', `PLY-Version "${kappeText(formatVersion, 20)}" (erwartet 1.0).`);

    for (const tx of texturen) await sammleReferenz(src.filePath, tx, 'texture', s);

    const finde = (name: string): Element | undefined => elemente.find(e => e.name === name);
    const vertexEl = finde('vertex');
    const faceEl = finde('face');
    const edgeEl = finde('edge');
    const hatProp = (e: Element | undefined, ...ns: string[]): boolean => !!e && ns.every(n => e.props.some(p => p.name === n));
    const hatUv = hatProp(vertexEl, 's', 't') || hatProp(vertexEl, 'u', 'v') || hatProp(vertexEl, 'texture_u', 'texture_v') || hatProp(vertexEl, 'texture_s', 'texture_t');
    const hatFarbe = hatProp(vertexEl, 'red', 'green', 'blue') || hatProp(vertexEl, 'r', 'g', 'b');

    const istAscii = formatName === 'ascii';
    const istBinaer = formatName === 'binary_little_endian' || formatName === 'binary_big_endian';
    const le = formatName === 'binary_little_endian';
    const box = new Bbox();
    let bboxVollstaendig = false;
    let bboxGrund: string | null = null;

    // Binaerkoerper Element fuer Element durchlaufen: Elementanfaenge, erwartete Dateigroesse, Dreiecke.
    const elementStart = new Map<Element, number>();
    let erwartet: number | null = null;
    let flaechenDreiecke: number | null = null;
    if (istBinaer) {
      const w = await wandereBinaer(src, ctx, budget, elemente, bodyOffset, le);
      for (const [e, o] of w.starts) elementStart.set(e, o);
      erwartet = w.ende;
      flaechenDreiecke = w.dreiecke;
      if (w.abgeschnitten) s.warn('ply_abgeschnitten', `Koerper endet im Element "${w.problemIn}" (Datei hat ${src.size} Bytes).`);
      else if (w.ungueltig) s.warn('ply_liste_ungueltig', `Element "${w.problemIn}": list-Zaehler negativ oder Typ unbekannt; Rest des Koerpers nicht durchlaufen.`);
      else if (w.gekappt) s.warn('ply_pruefung_gekappt', 'list-Elemente nur teilweise durchlaufen (Lesekappe); Dateigroesse und Dreieckszahl nicht geprueft.');
      else if (w.ende !== null && w.ende < src.size) s.warn('ply_ueberhang', `Datei ist ${src.size - w.ende} Bytes groesser als vom Header verlangt (${w.ende}).`);
    }

    const hatXyz = hatProp(vertexEl, 'x', 'y', 'z');
    if (!vertexEl) {
      bboxGrund = 'kein_vertex_element';
    } else if (!hatXyz) {
      bboxGrund = 'vertex_ohne_xyz';
      s.info('ply_bbox_nicht_berechenbar', 'vertex-Element ohne x/y/z-Properties; keine Bounding-Box.');
    } else if (vertexEl.count === 0) {
      bboxGrund = 'keine_vertices';
    } else if (istBinaer) {
      const stride = festeGroesse(vertexEl);
      const start = elementStart.get(vertexEl);
      if (stride === null || start === undefined) {
        bboxGrund = stride === null ? 'zeilengroesse_unbekannt' : 'elementanfang_unbekannt';
        s.warn('ply_bbox_nicht_berechenbar', stride === null
          ? 'Zeilengroesse des vertex-Elements unbekannt (list-Property oder unbekannter Typ); keine Bounding-Box.'
          : 'Anfang des vertex-Elements nicht ermittelbar (Koerper davor abgeschnitten oder nicht durchlaufbar); keine Bounding-Box.');
      } else {
        const px = vertexEl.props.findIndex(p => p.name === 'x');
        const py = vertexEl.props.findIndex(p => p.name === 'y');
        const pz = vertexEl.props.findIndex(p => p.name === 'z');
        const offs: number[] = [];
        let o = 0;
        for (const p of vertexEl.props) {
          offs.push(o);
          o += TYP_BYTES[p.typ as Skalar];
        }
        const tx = vertexEl.props[px].typ as Skalar, ty = vertexEl.props[py].typ as Skalar, tz = vertexEl.props[pz].typ as Skalar;
        const maxZeilen = Math.min(vertexEl.count, Math.floor(Math.min(budget.rest, MAX_SCAN_BYTES) / Math.max(1, stride)));
        const proBlock = Math.max(1, Math.floor((1024 * 1024) / Math.max(1, stride)));
        let gelesen = 0;
        for (let r = 0; r < maxZeilen; r += proBlock) {
          ctx.pruefeAbbruch();
          const n = Math.min(proBlock, maxZeilen - r);
          const buf = await budget.lese(src, start + r * stride, n * stride);
          const ganze = Math.floor(buf.length / stride);
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          for (let k = 0; k < ganze; k++) {
            const b = k * stride;
            box.add(leseSkalar(dv, b + offs[px], tx, le), leseSkalar(dv, b + offs[py], ty, le), leseSkalar(dv, b + offs[pz], tz, le));
          }
          gelesen += ganze;
          if (ganze < n) break;
        }
        bboxVollstaendig = gelesen >= vertexEl.count;
        if (!bboxVollstaendig) {
          bboxGrund = gelesen < Math.min(vertexEl.count, maxZeilen) ? 'datei_abgeschnitten' : 'lesekappe';
          if (bboxGrund === 'lesekappe') s.warn('bbox_gekappt', `Bounding-Box aus ${gelesen} von ${vertexEl.count} Vertices (Lesekappe).`);
        }
        if (box.ungueltig > 0) s.warn('vertex_nicht_endlich', `${box.ungueltig} Vertices mit NaN/Infinity (ignoriert in der Bounding-Box).`);
      }
    } else if (istAscii) {
      // Zeilenindex (0-basiert, ab Koerperbeginn) des vertex-Elements.
      let vStart = 0;
      for (const e of elemente) {
        if (e === vertexEl) break;
        vStart += e.count;
      }
      const vEnde = vStart + vertexEl.count;
      let fStart = 0;
      for (const e of elemente) {
        if (e === faceEl) break;
        fStart += e.count;
      }
      const zaehleFlaechen = !!faceEl && !!faceEl.props[0]?.liste;
      const fEnde = fStart + (faceEl?.count ?? 0);
      let asciiDreiecke = 0;
      const gesamtZeilen = elemente.reduce((a, e) => a + e.count, 0);
      const props = vertexEl.props;
      const fest = props.every(p => !p.liste);
      const ix = props.findIndex(p => p.name === 'x'), iy = props.findIndex(p => p.name === 'y'), iz = props.findIndex(p => p.name === 'z');
      let gesehen = 0;
      let vertexZeilen = 0;
      const res = await leseZeilen(
        src,
        ctx,
        budget,
        (zeile, nr) => {
          const i = nr - 1;
          gesehen = nr;
          if (zaehleFlaechen && i >= fStart && i < fEnde) {
            const c = parseInt(zeile, 10);
            if (c >= 3) asciiDreiecke += c - 2;
            return;
          }
          if (i < vStart || i >= vEnde) return;
          vertexZeilen++;
          const t = zeile.trim().split(/\s+/);
          let px = ix, py = iy, pz = iz;
          if (!fest) {
            let pos = 0;
            px = py = pz = -1;
            for (const p of props) {
              if (p.name === 'x') px = pos;
              else if (p.name === 'y') py = pos;
              else if (p.name === 'z') pz = pos;
              if (p.liste) {
                const c = Number(t[pos]);
                pos += 1 + (Number.isFinite(c) && c >= 0 ? c : 0);
              } else pos++;
            }
          }
          box.add(Number(t[px]), Number(t[py]), Number(t[pz]));
          if ((nr & 0x3fff) === 0) ctx.pruefeAbbruch();
        },
        { start: bodyOffset, maxBytes: MAX_SCAN_BYTES }
      );
      bboxVollstaendig = vertexZeilen >= vertexEl.count && box.ungueltig === 0;
      if (res.vollstaendig && zaehleFlaechen && gesehen >= fEnde) flaechenDreiecke = asciiDreiecke;
      if (res.grund === 'zeile_zu_lang') {
        s.warn('ply_zeile_zu_lang', 'Zeile ueber 1 MiB im ASCII-Koerper.');
      } else if (!res.vollstaendig) {
        s.warn('bbox_gekappt', `Koerper nur teilweise gelesen (${res.bytesGelesen} Bytes, Lesekappe); Bounding-Box und Pruefung der Zeilenzahl unvollstaendig.`);
        bboxGrund = 'lesekappe';
      } else if (gesehen < gesamtZeilen) {
        s.warn('ply_abgeschnitten', `Koerper hat ${gesehen} Zeilen, der Header verlangt ${gesamtZeilen} (Datei abgeschnitten?).`);
        bboxGrund = 'datei_abgeschnitten';
      }
      if (box.ungueltig > 0) s.warn('vertex_ungueltig', `${box.ungueltig} Vertex-Zeilen ohne drei gueltige Zahlen.`);
    }


    // Objekte
    for (const e of elemente) {
      s.addObject({
        name: e.name,
        kind: 'ply_element',
        data: {
          count: e.count,
          properties: e.props.map(p => ({ name: p.name, type: p.typRoh })),
          row_bytes: istBinaer ? festeGroesse(e) : null,
        },
        source_range: { line_start: e.line_start, line_end: e.line_end },
      });
    }
    s.addObject({ name: 'body', kind: 'ply_body', data: { encoding: formatName }, source_range: { offset: bodyOffset, length: Math.max(0, src.size - bodyOffset) } });

    return fertig({
      metadata: {
        ply_format: formatName,
        ply_version: formatVersion,
        header_bytes: bodyOffset,
        element_count: elemente.length,
        vertex_count: vertexEl?.count ?? 0,
        face_count: faceEl?.count ?? 0,
        triangle_count: flaechenDreiecke,
        edge_count: edgeEl?.count ?? 0,
        has_normals: hatProp(vertexEl, 'nx', 'ny', 'nz'),
        has_texcoords: hatUv,
        has_colors: hatFarbe,
        comments,
        obj_info: objInfo,
        texture_files: texturen,
        bounding_box: box.alsObjekt(),
        bounding_box_complete: bboxVollstaendig,
        bounding_box_reason: bboxVollstaendig ? null : bboxGrund,
      },
      format_specific: { expected_size: erwartet, body_offset: bodyOffset },
    });
  },
};
