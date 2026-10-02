/**
 * MODUL: Asset 3D STL
 * ZWECK: Inspektor fuer .stl in ASCII und binaer. Unterscheidung nicht ueber das Wort "solid"
 *        allein: Eine Binaerdatei darf ihren 80-Byte-Kopf mit "solid" beginnen. Massgeblich ist
 *        zuerst die Groessenformel size == 84 + 50*n; passt sie, ist die Datei binaer.
 *
 * Bounding-Box wird mit Lesekappe berechnet (MAX_SCAN_BYTES bzw. Lesebudget); wird gekappt,
 * ist sie unvollstaendig und das Ergebnis 'teilweise'.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { Bbox, Lesebudget, MAX_SCAN_BYTES, Sammler, kappeText, leseZeilen, sieheBinaerAus } from './helpers.js';

const DREIECK_BYTES = 50;
const KOPF_BYTES = 84;

/** Druckbarer Anfang des 80-Byte-Kopfes (bis zum ersten NUL). */
function kopfText(b: Uint8Array): string {
  let ende = b.length;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) {
      ende = i;
      break;
    }
  }
  return Buffer.from(b.subarray(0, ende)).toString('latin1').replace(/[^\x20-\x7e]/g, '?').trim();
}

export const stlInspector: AssetInspector = {
  id: '3d-stl',
  formats: ['stl'],
  extensions: ['.stl'],
  version: 1,
  async inspect(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
    const s = new Sammler(ctx);
    const budget = new Lesebudget(ctx);
    const kopf = await budget.lese(src, 0, Math.min(src.size, 4096));
    const fertig = (extra: Partial<AssetResult>): AssetResult =>
      erzeugeAssetResult(src.filePath, src.size, {
        asset_type: 'model3d',
        format: 'stl',
        inspector: '3d-stl',
        parser_version: 1,
        status: s.problem ? 'teilweise' : 'ok',
        objects: s.objects,
        references: s.references,
        warnings: s.abschluss(),
        ...extra,
      });

    const deklariert = src.size >= KOPF_BYTES ? kopf.readUInt32LE(80) : -1;
    const erwartet = deklariert >= 0 ? KOPF_BYTES + DREIECK_BYTES * deklariert : -1;
    const kopfLatin = kopf.toString('latin1', 0, Math.min(kopf.length, 4096));
    const beginntSolid = /^(\xef\xbb\xbf)?\s*solid/i.test(kopfLatin.slice(0, 16));

    // Ein binaerer STL enthaelt praktisch immer Bytes ausserhalb von druckbarem ASCII (Nullbytes in Floats).
    const reinerText = !beginntSolid && kopf.length > 0 && /^[\t\n\r\x20-\x7e]*$/.test(kopfLatin);
    let art: 'binaer' | 'ascii';
    let weg: string;
    if (erwartet === src.size) {
      art = 'binaer';
      weg = beginntSolid ? 'groessenformel_trotz_solid_kopf' : 'groessenformel';
    } else if (beginntSolid && !sieheBinaerAus(kopf) && /facet|endsolid/i.test(kopfLatin)) {
      art = 'ascii';
      weg = 'solid_und_text';
    } else if (beginntSolid && !sieheBinaerAus(kopf) && src.size < KOPF_BYTES) {
      art = 'ascii';
      weg = 'solid_und_text_kurz';
    } else if (src.size >= KOPF_BYTES && !reinerText) {
      art = 'binaer';
      weg = 'groessenformel_verletzt';
    } else {
      if (reinerText) s.warn('inhalt_passt_nicht_zur_endung', 'Endung .stl, aber der Inhalt ist reiner Text ohne "solid" und kein binaerer STL.');
      else s.warn('stl_zu_kurz', `Datei (${src.size} Bytes) ist kuerzer als der binaere STL-Kopf (84 Bytes) und beginnt nicht mit "solid".`);
      return fertig({ metadata: { gelesen_bytes: kopf.length } });
    }

    if (art === 'binaer') return binaer(src, ctx, s, budget, kopf, deklariert, erwartet, weg, beginntSolid, fertig);
    return ascii(src, ctx, s, budget, weg, fertig);
  },
};

async function binaer(
  src: AssetSource,
  ctx: AssetContext,
  s: Sammler,
  budget: Lesebudget,
  kopf: Buffer,
  n: number,
  erwartet: number,
  weg: string,
  beginntSolid: boolean,
  fertig: (e: Partial<AssetResult>) => AssetResult
): Promise<AssetResult> {
  const verfuegbar = Math.floor((src.size - KOPF_BYTES) / DREIECK_BYTES);
  const dreiecke = Math.min(n, verfuegbar);
  if (erwartet > src.size) {
    s.warn('stl_abgeschnitten', `Kopf nennt ${n} Dreiecke (${erwartet} Bytes), die Datei hat ${src.size} Bytes — nur ${verfuegbar} Dreiecke vollstaendig.`);
  } else if (erwartet < src.size) {
    s.warn('stl_ueberhang', `Kopf nennt ${n} Dreiecke (${erwartet} Bytes), die Datei hat ${src.size - erwartet} Bytes mehr.`);
  }
  if (beginntSolid && weg !== 'groessenformel_trotz_solid_kopf') {
    s.info('stl_binaer_mit_solid_kopf', 'Binaerer STL, dessen Kopf mit "solid" beginnt.');
  }
  if (n === 0) s.info('stl_ohne_dreiecke', 'STL enthaelt 0 Dreiecke.');

  const box = new Bbox();
  let nichtEndlich = 0;
  let attributGenutzt = 0;
  let gescannt = 0;
  const maxScan = Math.min(budget.rest, MAX_SCAN_BYTES);
  const maxDreiecke = Math.min(dreiecke, Math.floor(maxScan / DREIECK_BYTES));
  const BLOCK = 4096;
  for (let t = 0; t < maxDreiecke; t += BLOCK) {
    ctx.pruefeAbbruch();
    const anzahl = Math.min(BLOCK, maxDreiecke - t);
    const buf = await budget.lese(src, KOPF_BYTES + t * DREIECK_BYTES, anzahl * DREIECK_BYTES);
    const ganze = Math.floor(buf.length / DREIECK_BYTES);
    for (let i = 0; i < ganze; i++) {
      const b = i * DREIECK_BYTES;
      for (let k = 0; k < 3; k++) {
        const o = b + 12 + k * 12;
        const x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nichtEndlich++;
        box.add(x, y, z);
      }
      if (buf.readUInt16LE(b + 48) !== 0) attributGenutzt++;
    }
    gescannt += ganze;
    if (ganze < anzahl) break;
  }
  const bboxVollstaendig = gescannt >= dreiecke;
  if (!bboxVollstaendig) s.warn('bbox_gekappt', `Bounding-Box aus den ersten ${gescannt} von ${dreiecke} Dreiecken (Lesekappe); sie ist unvollstaendig.`);
  if (nichtEndlich > 0) s.warn('stl_nicht_endliche_werte', `${nichtEndlich} Eckpunkte mit NaN/Infinity (ignoriert in der Bounding-Box).`);

  const kt = kopfText(kopf.subarray(0, 80));
  s.addObject({ name: 'header', kind: 'stl_header', data: { text: kappeText(kt, 80), beginnt_mit_solid: beginntSolid }, source_range: { offset: 0, length: Math.min(80, src.size) } });
  s.addObject({
    name: null,
    kind: 'stl_mesh',
    data: { triangles: dreiecke, triangles_declared: n, bounding_box: box.alsObjekt() },
    source_range: { offset: KOPF_BYTES, length: dreiecke * DREIECK_BYTES },
  });

  return fertig({
    metadata: {
      encoding: 'binary',
      triangle_count: dreiecke,
      triangle_count_declared: n,
      vertex_count: dreiecke * 3,
      header_text: kappeText(kt, 80),
      size_matches_formula: erwartet === src.size,
      bounding_box: box.alsObjekt(),
      bounding_box_complete: bboxVollstaendig,
      scanned_triangles: gescannt,
      attribute_bytes_used: attributGenutzt,
    },
    format_specific: { erkennung: weg, header_starts_with_solid: beginntSolid, expected_size: erwartet },
  });
}

interface Solid {
  name: string | null;
  line_start: number;
  line_end: number;
  facets: number;
  vertices: number;
  closed: boolean;
}

async function ascii(
  src: AssetSource,
  ctx: AssetContext,
  s: Sammler,
  budget: Lesebudget,
  weg: string,
  fertig: (e: Partial<AssetResult>) => AssetResult
): Promise<AssetResult> {
  const box = new Bbox();
  const solids: Solid[] = [];
  let aktuell: Solid | null = null;
  let facets = 0;
  let vertices = 0;
  let ausserhalb = 0;
  let verschachtelt = 0;
  let nichtEndlich = 0;

  const res = await leseZeilen(
    src,
    ctx,
    budget,
    (roh, nr) => {
      const z = roh.trim();
      if (z.length === 0) return;
      const sp = z.search(/\s/);
      const key = (sp < 0 ? z : z.slice(0, sp)).toLowerCase();
      switch (key) {
        case 'solid': {
          if (aktuell && !aktuell.closed) verschachtelt++;
          const name = sp < 0 ? '' : z.slice(sp + 1).trim();
          aktuell = { name: name === '' ? null : kappeText(name, 128), line_start: nr, line_end: nr, facets: 0, vertices: 0, closed: false };
          solids.push(aktuell);
          break;
        }
        case 'facet':
          facets++;
          if (aktuell) aktuell.facets++;
          else ausserhalb++;
          break;
        case 'vertex': {
          const t = z.split(/\s+/);
          const x = Number(t[1]), y = Number(t[2]), z3 = Number(t[3]);
          if (t.length < 4 || Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z3)) nichtEndlich++;
          else box.add(x, y, z3);
          vertices++;
          if (aktuell) aktuell.vertices++;
          break;
        }
        case 'endsolid':
          if (aktuell) {
            aktuell.line_end = nr;
            aktuell.closed = true;
            aktuell = null;
          }
          break;
        default:
      }
      if ((nr & 0x3fff) === 0) ctx.pruefeAbbruch();
    },
    { maxBytes: MAX_SCAN_BYTES }
  );
  if (aktuell) {
    const offen = aktuell as Solid;
    offen.line_end = res.zeilen;
  }
  if (res.grund === 'zeile_zu_lang') s.warn('inhalt_passt_nicht_zur_endung', 'Zeile ueber 1 MiB ohne Zeilenende — kein ASCII-STL.');
  else if (!res.vollstaendig) s.warn('bbox_gekappt', `Nur ${res.bytesGelesen} von ${src.size} Bytes gelesen (Lesekappe); Zaehler und Bounding-Box sind unvollstaendig.`);
  const offene = solids.filter(x => !x.closed).length;
  if (res.vollstaendig && offene > 0) s.warn('endsolid_fehlt', `${offene} solid-Block(e) ohne endsolid (Datei abgeschnitten?).`);
  if (verschachtelt > 0) s.warn('stl_solid_verschachtelt', `${verschachtelt} solid-Anweisung(en) vor dem endsolid des vorigen Blocks.`);
  if (ausserhalb > 0) s.warn('facet_ausserhalb_solid', `${ausserhalb} facet-Zeilen ausserhalb eines solid-Blocks.`);
  if (res.vollstaendig && vertices !== facets * 3) s.warn('stl_ascii_vertexzahl', `${vertices} vertex-Zeilen bei ${facets} facets (erwartet ${facets * 3}).`);
  if (nichtEndlich > 0) s.warn('vertex_ungueltig', `${nichtEndlich} vertex-Zeilen ohne drei gueltige Zahlen.`);
  if (solids.length === 0) s.warn('stl_kein_solid', 'Keine solid-Anweisung gefunden.');

  for (const sd of solids) {
    s.addObject({
      name: sd.name,
      kind: 'stl_solid',
      data: { facets: sd.facets, vertices: sd.vertices, closed: sd.closed },
      source_range: { line_start: sd.line_start, line_end: sd.line_end },
    });
  }
  return fertig({
    metadata: {
      encoding: 'ascii',
      solid_count: solids.length,
      name: solids[0]?.name ?? null,
      triangle_count: facets,
      vertex_count: vertices,
      line_total: res.zeilen,
      bounding_box: box.alsObjekt(),
      bounding_box_complete: res.vollstaendig,
      read_bytes: res.bytesGelesen,
    },
    format_specific: { erkennung: weg },
  });
}
