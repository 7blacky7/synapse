/**
 * MODUL: Asset 3D OBJ
 * ZWECK: Inspektor fuer Wavefront .obj (Text): Zaehler v/vt/vn/f, Objekte und Gruppen mit
 *        Zeilenbereich, usemtl, mtllib-Referenzen, Bounding-Box aus den v-Zeilen.
 *
 * Die Datei wird zeilenweise in Bloecken gelesen (nie komplett im Speicher) und hoechstens bis
 * zum Lesebudget (ctx.limits.maxReadBytes). Wird dort gekappt, sind die Zaehler Mindestwerte
 * und das Ergebnis ist 'teilweise'.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { Bbox, Lesebudget, Sammler, kappeText, leseZeilen, sammleReferenz, sieheBinaerAus } from './helpers.js';

/** Schluesselwoerter der OBJ-/MTL-Familie (Erkennung, ob der Inhalt zur Endung passt). */
const BEKANNT = new Set([
  'v', 'vt', 'vn', 'vp', 'f', 'l', 'p', 'o', 'g', 's', 'usemtl', 'mtllib', 'mg', 'cstype', 'deg', 'bmat', 'step',
  'curv', 'curv2', 'surf', 'parm', 'trim', 'hole', 'scrv', 'sp', 'end', 'con', 'bevel', 'c_interp', 'd_interp',
  'lod', 'usemap', 'maplib', 'shadow_obj', 'trace_obj', 'ctech', 'stech', 'vc',
]);

interface Block {
  kind: 'object' | 'group';
  name: string | null;
  implizit: boolean;
  line_start: number;
  line_end: number;
  faces: number;
  triangles: number;
  materials: Set<string>;
}

export const objInspector: AssetInspector = {
  id: '3d-obj',
  formats: ['obj'],
  extensions: ['.obj'],
  version: 1,
  async inspect(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
    const s = new Sammler(ctx);
    const budget = new Lesebudget(ctx);
    const kopf = await budget.lese(src, 0, Math.min(src.size, 4096));
    const fertig = (extra: Partial<AssetResult>): AssetResult =>
      erzeugeAssetResult(src.filePath, src.size, {
        asset_type: 'model3d',
        format: 'obj',
        inspector: '3d-obj',
        parser_version: 1,
        status: s.problem ? 'teilweise' : 'ok',
        objects: s.objects,
        references: s.references,
        warnings: s.abschluss(),
        ...extra,
      });

    if (sieheBinaerAus(kopf)) {
      s.warn('inhalt_passt_nicht_zur_endung', 'Endung .obj, aber der Inhalt sieht nach Binaerdaten aus (kein OBJ-Text).');
      return fertig({ metadata: { gelesen_bytes: kopf.length } });
    }

    let v = 0, vt = 0, vn = 0, f = 0, linien = 0, punkte = 0, dreiecke = 0;
    let degeneriert = 0;
    let badVertex = 0;
    let badIndex = 0;
    let maxV = 0, maxVt = 0, maxVn = 0;
    let erkannt = 0;
    let unbekannt = 0;
    let kommentare = 0;
    const bbox = new Bbox();
    const flaechenNachEcken: Record<string, number> = {};
    const mtllibs: string[] = [];
    const materialien = new Map<string, number>();
    const unbekannteKeys = new Map<string, number>();
    const bloecke: Block[] = [];
    let aktuell: Block | null = null;
    let aktivesMaterial: string | null = null;
    let bloeckeGesamt = 0;
    let objekteAnzahl = 0;
    let gruppenAnzahl = 0;
    const mtlRefs: string[] = [];

    const schliesse = (nr: number): void => {
      if (aktuell) aktuell.line_end = Math.max(aktuell.line_start, nr);
    };
    const neuerBlock = (kind: 'object' | 'group', name: string | null, nr: number, implizit: boolean): Block => {
      bloeckeGesamt++;
      if (kind === 'object') objekteAnzahl++;
      else gruppenAnzahl++;
      const b: Block = { kind, name, implizit, line_start: nr, line_end: nr, faces: 0, triangles: 0, materials: new Set() };
      if (bloecke.length < ctx.limits.maxObjects) bloecke.push(b);
      return b;
    };

    const res = await leseZeilen(src, ctx, budget, (roh, nr) => {
      if (roh.length === 0) return;
      let zeile = roh;
      const c0 = zeile.charCodeAt(0);
      if (c0 === 35) {
        kommentare++;
        return;
      }
      if (c0 === 32 || c0 === 9) {
        zeile = zeile.trim();
        if (zeile.length === 0) return;
        if (zeile.charCodeAt(0) === 35) {
          kommentare++;
          return;
        }
      }
      const sp = zeile.search(/[ \t]/);
      const key = sp < 0 ? zeile : zeile.slice(0, sp);
      const rest = sp < 0 ? '' : zeile.slice(sp + 1).trim();
      if (BEKANNT.has(key)) erkannt++;
      else {
        unbekannt++;
        if (unbekannteKeys.size < 20 || unbekannteKeys.has(key)) unbekannteKeys.set(kappeText(key, 32), (unbekannteKeys.get(key) ?? 0) + 1);
      }
      switch (key) {
        case 'v': {
          const t = rest.split(/\s+/);
          if (t.length < 3) {
            badVertex++;
          } else {
            const x = Number(t[0]), y = Number(t[1]), z = Number(t[2]);
            if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) badVertex++;
            else bbox.add(x, y, z);
          }
          v++;
          break;
        }
        case 'vt':
          vt++;
          break;
        case 'vn':
          vn++;
          break;
        case 'f': {
          if (!aktuell) aktuell = neuerBlock('group', null, nr, true);
          const t = rest.length === 0 ? [] : rest.split(/\s+/);
          f++;
          aktuell.faces++;
          if (aktivesMaterial !== null && aktuell.materials.size < 20) aktuell.materials.add(aktivesMaterial);
          const n = t.length;
          const label = n === 3 ? '3' : n === 4 ? '4' : n < 3 ? '<3' : '5+';
          flaechenNachEcken[label] = (flaechenNachEcken[label] ?? 0) + 1;
          if (n < 3) degeneriert++;
          else {
            dreiecke += n - 2;
            aktuell.triangles += n - 2;
          }
          for (const tok of t) {
            const p = tok.split('/');
            const vi = parseInt(p[0], 10);
            if (Number.isNaN(vi) || vi === 0 || (vi < 0 && -vi > v)) badIndex++;
            else if (vi > maxV) maxV = vi;
            if (p.length > 1 && p[1] !== '') {
              const ti = parseInt(p[1], 10);
              if (Number.isNaN(ti) || ti === 0 || (ti < 0 && -ti > vt)) badIndex++;
              else if (ti > maxVt) maxVt = ti;
            }
            if (p.length > 2 && p[2] !== '') {
              const ni = parseInt(p[2], 10);
              if (Number.isNaN(ni) || ni === 0 || (ni < 0 && -ni > vn)) badIndex++;
              else if (ni > maxVn) maxVn = ni;
            }
          }
          break;
        }
        case 'l':
          linien++;
          break;
        case 'p':
          punkte++;
          break;
        case 'o':
        case 'g':
          schliesse(nr - 1);
          aktuell = neuerBlock(key === 'o' ? 'object' : 'group', rest === '' ? null : kappeText(rest, 128), nr, false);
          break;
        case 'usemtl': {
          const name = kappeText(rest, 128);
          materialien.set(name, (materialien.get(name) ?? 0) + 1);
          aktivesMaterial = name;
          break;
        }
        case 'mtllib':
          if (rest !== '') {
            if (mtllibs.length < 100) mtllibs.push(kappeText(rest, 256));
            mtlRefs.push(rest);
          }
          break;
        default:
      }
      if ((nr & 0x3fff) === 0) ctx.pruefeAbbruch();
    });
    schliesse(res.zeilen);

    if (res.grund === 'zeile_zu_lang') {
      s.warn('inhalt_passt_nicht_zur_endung', 'Zeile ueber 1 MiB ohne Zeilenende — das ist kein OBJ-Text.');
    } else if (!res.vollstaendig) {
      s.warn('lesegrenze_erreicht', `Nur ${res.bytesGelesen} von ${src.size} Bytes gelesen (Lesegrenze); alle Zaehler sind Mindestwerte.`);
    }
    if (erkannt === 0 && res.grund !== 'zeile_zu_lang') {
      if (unbekannt > 0) s.warn('inhalt_passt_nicht_zur_endung', 'Keine einzige OBJ-Anweisung erkannt; Inhalt passt nicht zu einer .obj-Datei.');
      else s.info('obj_ohne_geometrie', 'Datei enthaelt keine Anweisungen (nur Kommentare/Leerzeilen).');
    } else if (unbekannt > 0 && unbekannt > erkannt) {
      s.warn('obj_viele_unbekannte_zeilen', `${unbekannt} unbekannte Anweisungen gegenueber ${erkannt} bekannten.`);
    }
    if (res.vollstaendig) {
      if (maxV > v) s.warn('face_index_ausserhalb', `Flaechen verweisen auf Vertex ${maxV}, es gibt nur ${v} v-Zeilen.`);
      if (maxVt > vt) s.warn('face_index_ausserhalb', `Flaechen verweisen auf vt ${maxVt}, es gibt nur ${vt} vt-Zeilen.`);
      if (maxVn > vn) s.warn('face_index_ausserhalb', `Flaechen verweisen auf vn ${maxVn}, es gibt nur ${vn} vn-Zeilen.`);
    }
    if (badIndex > 0) s.warn('face_index_ungueltig', `${badIndex} ungueltige Flaechen-Indizes (0, nicht numerisch oder relativ zu weit zurueck).`);
    if (badVertex > 0) s.warn('vertex_ungueltig', `${badVertex} v-Zeilen ohne drei gueltige Zahlen.`);
    if (bbox.ungueltig > 0) s.warn('vertex_nicht_endlich', `${bbox.ungueltig} v-Zeilen mit nicht endlichen Werten.`);
    if (degeneriert > 0) s.info('flaeche_unter_drei_ecken', `${degeneriert} f-Zeilen mit weniger als 3 Ecken.`);

    // Referenzen
    for (const ziel of mtlRefs) {
      ctx.pruefeAbbruch();
      const teile = ziel.split(/\s+/).filter(x => x !== '');
      const ganz = ziel.replace(/^"|"$/g, '');
      // Ein Name mit Leerzeichen ist erlaubt; mehrere Bibliotheken in einer Zeile ebenfalls. Erst als Ganzes versuchen.
      const vorher = s.references.length;
      await sammleReferenz(src.filePath, ganz, 'material_library', s);
      const erste = s.references[s.references.length - 1];
      if (teile.length > 1 && !(s.references.length > vorher && erste?.resolved)) {
        for (const t of teile) await sammleReferenz(src.filePath, t.replace(/^"|"$/g, ''), 'material_library', s);
      }
    }

    // Objekte
    for (const b of bloecke) {
      s.addObject({
        name: b.name,
        kind: b.kind === 'object' ? 'obj_object' : 'obj_group',
        data: { faces: b.faces, triangles: b.triangles, materials: [...b.materials], implizit: b.implizit },
        source_range: { line_start: b.line_start, line_end: b.line_end },
      });
    }
    if (bloeckeGesamt > bloecke.length) s.warn('objekte_gekappt', `${bloeckeGesamt} Bloecke, aufgefuehrt werden ${bloecke.length}.`);

    return fertig({
      metadata: {
        vertex_count: v,
        texcoord_count: vt,
        normal_count: vn,
        face_count: f,
        triangle_count: dreiecke,
        line_count: linien,
        point_count: punkte,
        faces_by_corner_count: flaechenNachEcken,
        object_count: objekteAnzahl,
        group_count: gruppenAnzahl,
        materials_used: [...materialien.keys()].slice(0, 200),
        material_library_files: mtllibs,
        has_normals: vn > 0,
        has_texcoords: vt > 0,
        line_total: res.zeilen,
        comment_lines: kommentare,
        bounding_box: bbox.alsObjekt(),
        read_bytes: res.bytesGelesen,
        complete: res.vollstaendig,
      },
      format_specific: {
        unknown_keywords: Object.fromEntries(unbekannteKeys),
        unknown_line_count: unbekannt,
        materials_usage: Object.fromEntries([...materialien.entries()].slice(0, 200)),
      },
    });
  },
};
