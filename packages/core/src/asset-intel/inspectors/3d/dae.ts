/**
 * MODUL: Asset 3D DAE (Collada)
 * ZWECK: Inspektor fuer .dae (Collada, XML) ohne XML-Bibliothek: ein begrenzter Tag-Scanner liest
 *        die Datei in Bloecken, fuehrt einen Element-Stapel und wertet nur die gebrauchten
 *        Stellen aus: asset (unit, up_axis, contributor), library_geometries/images/materials/
 *        effects/visual_scenes/animations/controllers/cameras/lights (Zaehler + Namen),
 *        image init_from -> references, Szenen-Hierarchie in Grobzahlen.
 *
 * Grenzen: Text zwischen Tags wird nur fuer wenige Elemente gesammelt (Kappe 8 KiB) — die
 * grossen float_array-Inhalte werden nie gehalten. Stapeltiefe, Tag-Laenge und gelesene Bytes
 * sind begrenzt. Kein DTD/Entity-Aufloesen (nur die fuenf Standard-Entities).
 */

import { StringDecoder } from 'string_decoder';
import { TextDecoder } from 'util';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetResult, AssetSource } from '../../types.js';
import { Lesebudget, MAX_SCAN_BYTES, Sammler, kappeText, sammleReferenz } from './helpers.js';

const MAX_TIEFE = 256;
const MAX_TAG_LAENGE = 1024 * 1024;
const MAX_TEXT = 8192;

/** Elemente, deren Text wir brauchen. */
const TEXT_ELEMENTE = new Set(['up_axis', 'author', 'authoring_tool', 'comments', 'source_data', 'created', 'modified', 'title', 'subject', 'keywords', 'init_from', 'ref']);

/** Bibliotheken -> (Kind-Element, Objektart). */
const BIBLIOTHEKEN: Record<string, { kind: string; objekt: string }> = {
  library_geometries: { kind: 'geometry', objekt: 'geometry' },
  library_images: { kind: 'image', objekt: 'image' },
  library_materials: { kind: 'material', objekt: 'material' },
  library_effects: { kind: 'effect', objekt: 'effect' },
  library_visual_scenes: { kind: 'visual_scene', objekt: 'visual_scene' },
  library_animations: { kind: 'animation', objekt: 'animation' },
  library_controllers: { kind: 'controller', objekt: 'controller' },
  library_cameras: { kind: 'camera', objekt: 'camera' },
  library_lights: { kind: 'light', objekt: 'light' },
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function entkodiere(s: string): string {
  return s.indexOf('&') < 0 ? s : s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e] ?? '';
  });
}

function parseAttribute(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s)) !== null && n++ < 64) out[m[1]] = entkodiere(m[2] ?? m[3] ?? '');
  return out;
}

function zaehleZeilen(s: string, von: number, bis: number): number {
  let n = 0;
  for (let i = von; i < bis; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function lokalerName(n: string): string {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
}

interface Eintrag {
  name: string | null;
  id: string | null;
  data: Record<string, unknown>;
  line_start: number;
  line_end: number;
}

export const daeInspector: AssetInspector = {
  id: '3d-dae',
  formats: ['dae'],
  extensions: ['.dae'],
  version: 1,
  async inspect(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
    const s = new Sammler(ctx);
    const budget = new Lesebudget(ctx);
    const fertig = (extra: Partial<AssetResult>): AssetResult =>
      erzeugeAssetResult(src.filePath, src.size, {
        asset_type: 'model3d',
        format: 'dae',
        inspector: '3d-dae',
        parser_version: 1,
        status: s.problem ? 'teilweise' : 'ok',
        objects: s.objects,
        references: s.references,
        warnings: s.abschluss(),
        ...extra,
      });

    const maxN = Math.max(1, ctx.limits.maxObjects);
    const listen: Record<string, Eintrag[]> = {};
    for (const b of Object.values(BIBLIOTHEKEN)) listen[b.objekt] = [];
    const zaehler: Record<string, number> = {};
    const zaehle = (k: string): void => {
      zaehler[k] = (zaehler[k] ?? 0) + 1;
    };
    const bibZaehler: Record<string, number> = {};
    const nodes: Eintrag[] = [];
    let nodeGesamt = 0;
    let nodeTiefeMax = 0;
    let colladaVersion: string | null = null;
    let xmlnsGefunden = false;
    const asset: Record<string, unknown> = { contributors: [] as Array<Record<string, string>> };
    const bilder: Array<{ ziel: string; id: string | null }> = [];
    const instanzen: Record<string, number> = {};

    // Zustand
    const stapel: string[] = [];
    const zeilenStapel: number[] = [];
    let zeile = 1; // aktuelle Zeile am Anfang von buf
    let textBuf = '';
    let textAktiv: string | null = null;
    let aktuellerEintrag: { objekt: string; e: Eintrag } | null = null;
    let nodeTiefe = 0;
    let geometrieSource: Map<string, number> | null = null;
    let aktSource: string | null = null;
    let positionsSource: string | null = null;
    let geoTris = 0, geoPolys = 0, geoLines = 0;
    let geoPrimitiveBloecke = 0;
    let verticesId: string | null = null;
    let contributorAktuell: Record<string, string> | null = null;
    let abbruchGrund: string | null = null;
    let tagsVerarbeitet = 0;

    const inLibrary = (): string | null => {
      for (const n of stapel) if (n in BIBLIOTHEKEN) return n;
      return null;
    };

    const oeffne = (name: string, attr: Record<string, string>, selbstSchliessend: boolean, zNr: number): void => {
      const ln = lokalerName(name);
      const eltern = stapel[stapel.length - 1] ?? null;
      if (stapel.length === 0) {
        if (ln === 'COLLADA') {
          colladaVersion = attr.version ?? null;
          xmlnsGefunden = true;
        }
      }
      zaehle(ln);
      const lib = inLibrary();
      // Bibliothekseintraege (direkte Kinder der Bibliothek)
      if (eltern && eltern in BIBLIOTHEKEN && BIBLIOTHEKEN[eltern].kind === ln) {
        const e: Eintrag = { name: attr.name ?? null, id: attr.id ?? null, data: {}, line_start: zNr, line_end: zNr };
        aktuellerEintrag = { objekt: BIBLIOTHEKEN[eltern].objekt, e };
        bibZaehler[BIBLIOTHEKEN[eltern].objekt] = (bibZaehler[BIBLIOTHEKEN[eltern].objekt] ?? 0) + 1;
        if (ln === 'geometry') {
          geometrieSource = new Map();
          positionsSource = null;
          geoTris = geoPolys = geoLines = 0;
          geoPrimitiveBloecke = 0;
          verticesId = null;
        }
      }
      if (lib === 'library_geometries' && aktuellerEintrag?.objekt === 'geometry') {
        if (ln === 'source') aktSource = attr.id ?? null;
        else if (ln === 'accessor' && aktSource && geometrieSource) {
          const c = Number(attr.count);
          if (Number.isFinite(c)) geometrieSource.set(aktSource, c);
        } else if (ln === 'vertices') verticesId = attr.id ?? null;
        else if (ln === 'input' && eltern === 'vertices' && attr.semantic === 'POSITION') positionsSource = (attr.source ?? '').replace(/^#/, '');
        else if (ln === 'triangles' || ln === 'trifans' || ln === 'tristrips') {
          geoTris += Number(attr.count) || 0;
          geoPrimitiveBloecke++;
        } else if (ln === 'polylist' || ln === 'polygons') {
          geoPolys += Number(attr.count) || 0;
          geoPrimitiveBloecke++;
        } else if (ln === 'lines' || ln === 'linestrips') {
          geoLines += Number(attr.count) || 0;
          geoPrimitiveBloecke++;
        }
      }
      if (lib === 'library_images' && ln === 'image' && aktuellerEintrag) aktuellerEintrag.e.data.format = attr.format ?? null;
      if (lib === 'library_materials' && ln === 'instance_effect' && aktuellerEintrag) aktuellerEintrag.e.data.effect = (attr.url ?? '').replace(/^#/, '') || null;
      if (lib === 'library_controllers' && aktuellerEintrag) {
        if (ln === 'skin') aktuellerEintrag.e.data.typ = 'skin';
        else if (ln === 'morph') aktuellerEintrag.e.data.typ = 'morph';
        if (ln === 'skin') aktuellerEintrag.e.data.source = (attr.source ?? '').replace(/^#/, '') || null;
      }
      if (ln.startsWith('instance_') && ln !== 'instance_effect') instanzen[ln] = (instanzen[ln] ?? 0) + 1;
      if (lib === 'library_visual_scenes') {
        if (ln === 'node') {
          nodeTiefe++;
          nodeGesamt++;
          if (nodeTiefe > nodeTiefeMax) nodeTiefeMax = nodeTiefe;
          if (nodes.length < maxN) nodes.push({ name: attr.name ?? null, id: attr.id ?? null, data: { type: attr.type ?? 'NODE', depth: nodeTiefe }, line_start: zNr, line_end: zNr });
          if (selbstSchliessend) nodeTiefe--;
        }
      }
      if (ln === 'unit' && eltern === 'asset' && stapel.length === 2) {
        asset.unit_name = attr.name ?? null;
        asset.unit_meter = attr.meter !== undefined && Number.isFinite(Number(attr.meter)) ? Number(attr.meter) : null;
      }
      if (ln === 'contributor' && eltern === 'asset' && stapel.length === 2) {
        contributorAktuell = {};
        (asset.contributors as Array<Record<string, string>>).push(contributorAktuell);
      }
      if (!selbstSchliessend) {
        stapel.push(ln);
        zeilenStapel.push(zNr);
        const topAsset = stapel.length >= 3 && stapel[1] === 'asset' && stapel[0] === 'COLLADA';
        const brauchtText = TEXT_ELEMENTE.has(ln) && (ln === 'init_from' || ln === 'ref' ? stapel.includes('image') : stapel[1] === 'asset' || topAsset);
        if (brauchtText) {
          textAktiv = ln;
          textBuf = '';
        } else {
          textAktiv = null;
        }
      }
      if (stapel.length > MAX_TIEFE) throw new Error('xml_zu_tief');
    };

    const schliesse = (name: string, zNr: number): void => {
      const ln = lokalerName(name);
      const top = stapel[stapel.length - 1];
      if (top !== ln) {
        // Fehlerhafte Verschachtelung: bis zum passenden Element zurueckgehen, sonst ignorieren.
        const idx = stapel.lastIndexOf(ln);
        if (idx < 0) {
          s.warn('xml_schliessendes_tag_ohne_oeffnendes', `Schliessendes Tag </${kappeText(ln, 40)}> ohne passendes oeffnendes Tag (Zeile ${zNr}).`);
          return;
        }
        s.warn('xml_verschachtelung', `Tag </${kappeText(ln, 40)}> schliesst offene Elemente (Zeile ${zNr}).`);
        while (stapel.length > idx + 1) stapel.pop(), zeilenStapel.pop();
      }
      const eltern = stapel[stapel.length - 2] ?? null;
      if (aktuellerEintrag && eltern && eltern in BIBLIOTHEKEN && BIBLIOTHEKEN[eltern].kind === ln) {
        const { objekt, e } = aktuellerEintrag;
        e.line_end = zNr;
        if (objekt === 'geometry' && geometrieSource) {
          const posId = positionsSource;
          e.data.vertex_count = posId ? geometrieSource.get(posId) ?? null : null;
          e.data.triangle_count = geoTris;
          e.data.polygon_count = geoPolys;
          e.data.line_count = geoLines;
          e.data.primitive_blocks = geoPrimitiveBloecke;
          e.data.source_count = geometrieSource.size;
          geometrieSource = null;
        }
        if (listen[objekt].length < maxN) listen[objekt].push(e);
        aktuellerEintrag = null;
      }
      if (ln === 'source') aktSource = null;
      if (ln === 'node' && stapel.includes('library_visual_scenes')) nodeTiefe = Math.max(0, nodeTiefe - 1);
      if (ln === 'node') {
        // Zeilenende der Node nachtragen (nur die zuletzt angelegte mit passender Tiefe waere genau; Grobzahl reicht).
      }
      if (ln === 'contributor') contributorAktuell = null;
      stapel.pop();
      zeilenStapel.pop();
      textAktiv = null;
    };

    const textFertig = (): void => {
      if (textAktiv === null) return;
      const t = entkodiere(textBuf).trim();
      const ln = textAktiv;
      textAktiv = null;
      textBuf = '';
      if (t === '') return;
      if (ln === 'init_from' || ln === 'ref') {
        // 1.4: image/init_from; 1.5: image/init_from/ref. Surface-init_from (Effekte) zeigt auf Image-IDs und zaehlt nicht.
        const direkt = ln === 'init_from' && stapel[stapel.length - 2] === 'image';
        const ref15 = ln === 'ref' && stapel[stapel.length - 2] === 'init_from' && stapel[stapel.length - 3] === 'image';
        if (direkt || ref15) bilder.push({ ziel: t, id: null });
        return;
      }
      if (contributorAktuell && (ln === 'author' || ln === 'authoring_tool' || ln === 'comments' || ln === 'source_data')) {
        contributorAktuell[ln] = kappeText(t, 256);
        return;
      }
      if (stapel[stapel.length - 2] === 'asset' || stapel[1] === 'asset') {
        if (ln === 'up_axis') asset.up_axis = kappeText(t, 16);
        else if (ln === 'created' || ln === 'modified' || ln === 'title' || ln === 'subject' || ln === 'keywords') asset[ln] = kappeText(t, 256);
      }
    };

    // Streaming
    // Textkodierung: UTF-8, UTF-16 mit BOM oder UTF-16 ohne BOM (erkennbar an '<' + NUL).
    let dekoder: { write(c: Buffer): string; end(): string } = new StringDecoder('utf8');
    let kodierung = 'utf-8';
    let kodierungErkannt = false;
    const waehleKodierung = (c: Buffer): void => {
      kodierungErkannt = true;
      let label: string | null = null;
      if (c.length >= 2 && c[0] === 0xff && c[1] === 0xfe) label = 'utf-16le';
      else if (c.length >= 2 && c[0] === 0xfe && c[1] === 0xff) label = 'utf-16be';
      else if (c.length >= 4 && c[0] === 0x3c && c[1] === 0x00 && c[2] !== 0x00) label = 'utf-16le';
      else if (c.length >= 4 && c[0] === 0x00 && c[1] === 0x3c && c[2] === 0x00) label = 'utf-16be';
      if (label) {
        const td = new TextDecoder(label);
        dekoder = { write: x => td.decode(x, { stream: true }), end: () => td.decode() };
        kodierung = label;
      }
    };
    let buf = '';
    let pos = 0;
    let gelesenBytes = 0;
    const maxBytes = Math.min(budget.rest, MAX_SCAN_BYTES * 2);
    const BLOCK = 512 * 1024;
    let fertigGelesen = false;
    try {
      while (!fertigGelesen) {
        ctx.pruefeAbbruch();
        let neu = '';
        if (gelesenBytes < src.size && gelesenBytes < maxBytes) {
          const chunk = await budget.lese(src, gelesenBytes, Math.min(BLOCK, maxBytes - gelesenBytes, src.size - gelesenBytes));
          if (chunk.length === 0) fertigGelesen = true;
          if (!kodierungErkannt && chunk.length > 0) waehleKodierung(chunk);
          gelesenBytes += chunk.length;
          neu = dekoder.write(chunk);
        } else {
          neu = dekoder.end();
          fertigGelesen = true;
        }
        if (gelesenBytes >= src.size) {
          neu += dekoder.end();
          fertigGelesen = true;
        }
        buf = buf.slice(pos) + neu;
        pos = 0;
        for (;;) {
          const lt = buf.indexOf('<', pos);
          if (lt < 0) {
            // Rest ist Text ohne folgendes Tag.
            if (textAktiv !== null && textBuf.length < MAX_TEXT) textBuf += buf.slice(pos, pos + MAX_TEXT - textBuf.length);
            zeile += zaehleZeilen(buf, pos, buf.length);
            pos = buf.length;
            break;
          }
          // Tag-Ende suchen
          let ende = -1;
          let art: 'tag' | 'kommentar' | 'cdata' | 'pi' | 'decl' = 'tag';
          if (buf.startsWith('<!--', lt)) {
            art = 'kommentar';
            const e = buf.indexOf('-->', lt + 4);
            ende = e < 0 ? -1 : e + 3;
          } else if (buf.startsWith('<![CDATA[', lt)) {
            art = 'cdata';
            const e = buf.indexOf(']]>', lt + 9);
            ende = e < 0 ? -1 : e + 3;
          } else if (buf.startsWith('<?', lt)) {
            art = 'pi';
            const e = buf.indexOf('?>', lt + 2);
            ende = e < 0 ? -1 : e + 2;
          } else if (buf.startsWith('<!', lt)) {
            art = 'decl';
            const e = buf.indexOf('>', lt + 2);
            ende = e < 0 ? -1 : e + 1;
          } else {
            // Normales Tag: '>' ausserhalb von Anfuehrungszeichen.
            let q = 0;
            for (let i = lt + 1; i < buf.length; i++) {
              const c = buf.charCodeAt(i);
              if (q === 0) {
                if (c === 34 || c === 39) q = c;
                else if (c === 62) {
                  ende = i + 1;
                  break;
                }
              } else if (c === q) q = 0;
            }
          }
          if (ende < 0) {
            // Tag unvollstaendig: Text davor verarbeiten, Rest fuer den naechsten Block aufheben.
            if (buf.length - lt > MAX_TAG_LAENGE) {
              abbruchGrund = 'tag_zu_lang';
              fertigGelesen = true;
            }
            if (textAktiv !== null && lt > pos && textBuf.length < MAX_TEXT) textBuf += buf.slice(pos, Math.min(lt, pos + MAX_TEXT - textBuf.length));
            zeile += zaehleZeilen(buf, pos, lt);
            pos = lt;
            break;
          }
          // Text vor dem Tag
          if (lt > pos) {
            if (textAktiv !== null && textBuf.length < MAX_TEXT) textBuf += buf.slice(pos, Math.min(lt, pos + MAX_TEXT - textBuf.length));
            zeile += zaehleZeilen(buf, pos, lt);
          }
          const tagZeile = zeile;
          if (art === 'cdata' && textAktiv !== null && textBuf.length < MAX_TEXT) textBuf += buf.slice(lt + 9, Math.min(ende - 3, lt + 9 + MAX_TEXT - textBuf.length));
          if (art === 'tag') {
            const inhalt = buf.slice(lt + 1, ende - 1);
            if (inhalt.charCodeAt(0) === 47) {
              // </name>
              textFertig();
              schliesse(inhalt.slice(1).trim(), tagZeile);
            } else {
              const selbst = inhalt.charCodeAt(inhalt.length - 1) === 47;
              const koerper = selbst ? inhalt.slice(0, -1) : inhalt;
              const sp = koerper.search(/\s/);
              const name = sp < 0 ? koerper : koerper.slice(0, sp);
              const attrText = sp < 0 ? '' : koerper.slice(sp);
              textFertig();
              const attr = attrText.length > 0 ? parseAttribute(attrText) : {};
              oeffne(name, attr, selbst, tagZeile);
              if (selbst) {
                // Selbstschliessend: wie oeffnen + schliessen fuer Bibliothekseintraege.
                const eltern = stapel[stapel.length - 1] ?? null;
                if (aktuellerEintrag && eltern && eltern in BIBLIOTHEKEN && BIBLIOTHEKEN[eltern].kind === lokalerName(name)) {
                  const { objekt, e } = aktuellerEintrag;
                  if (listen[objekt].length < maxN) listen[objekt].push(e);
                  aktuellerEintrag = null;
                  geometrieSource = null;
                }
              }
            }
            if ((++tagsVerarbeitet & 0x1fff) === 0) ctx.pruefeAbbruch();
          }
          zeile += zaehleZeilen(buf, lt, ende);
          pos = ende;
        }
      }
    } catch (e) {
      if ((e as Error)?.message === 'xml_zu_tief') {
        s.warn('xml_zu_tief', `Verschachtelung ueber ${MAX_TIEFE} Ebenen; Auswertung abgebrochen.`);
        abbruchGrund = 'xml_zu_tief';
      } else {
        throw e;
      }
    }
    // Reste
    if (abbruchGrund === 'tag_zu_lang') s.warn('xml_tag_zu_lang', 'Tag ueber 1 MiB ohne Ende; Auswertung abgebrochen.');
    if (gelesenBytes < src.size && abbruchGrund === null) {
      s.warn('lesegrenze_erreicht', `Nur ${gelesenBytes} von ${src.size} Bytes gelesen (Lesegrenze); Zaehler sind Mindestwerte.`);
    }
    if (!xmlnsGefunden) {
      s.warn('inhalt_passt_nicht_zur_endung', 'Endung .dae, aber kein COLLADA-Wurzelelement gefunden.');
    } else if (stapel.length > 0 && abbruchGrund === null && gelesenBytes >= src.size) {
      s.warn('xml_unvollstaendig', `XML endet mit ${stapel.length} offenen Elementen (zuletzt <${stapel[stapel.length - 1]}>); Datei abgeschnitten?`);
    }

    for (const b of bilder) await sammleReferenz(src.filePath, b.ziel, 'texture', s, { uri: true });

    // Objekte zusammensetzen: Bibliotheken zuerst, Nodes zuletzt.
    for (const [objekt, liste] of Object.entries(listen)) {
      for (const e of liste) {
        s.addObject({
          name: e.name ?? e.id,
          kind: objekt,
          data: { id: e.id, ...e.data },
          source_range: { line_start: e.line_start, line_end: Math.max(e.line_start, e.line_end) },
        });
      }
    }
    for (const nd of nodes) {
      s.addObject({
        name: nd.name ?? nd.id,
        kind: 'node',
        data: { id: nd.id, ...nd.data },
        source_range: { line_start: nd.line_start, line_end: nd.line_start },
      });
    }
    const tris = listen.geometry.reduce((a, g) => a + (Number(g.data.triangle_count) || 0), 0);
    const polys = listen.geometry.reduce((a, g) => a + (Number(g.data.polygon_count) || 0), 0);
    const verts = listen.geometry.reduce((a, g) => a + (Number(g.data.vertex_count) || 0), 0);

    return fertig({
      metadata: {
        collada_version: colladaVersion,
        encoding: kodierung,
        unit_name: asset.unit_name ?? null,
        unit_meter: asset.unit_meter ?? null,
        up_axis: asset.up_axis ?? null,
        created: asset.created ?? null,
        modified: asset.modified ?? null,
        title: asset.title ?? null,
        contributors: asset.contributors,
        geometry_count: bibZaehler.geometry ?? 0,
        image_count: bibZaehler.image ?? 0,
        material_count: bibZaehler.material ?? 0,
        effect_count: bibZaehler.effect ?? 0,
        visual_scene_count: bibZaehler.visual_scene ?? 0,
        animation_count: bibZaehler.animation ?? 0,
        controller_count: bibZaehler.controller ?? 0,
        camera_count: bibZaehler.camera ?? 0,
        light_count: bibZaehler.light ?? 0,
        node_count: nodeGesamt,
        node_max_depth: nodeTiefeMax,
        vertex_count: verts,
        triangle_count: tris,
        polygon_count: polys,
        read_bytes: gelesenBytes,
        complete: gelesenBytes >= src.size && abbruchGrund === null,
      },
      format_specific: {
        instances: instanzen,
        texture_files: bilder.map(b => kappeText(b.ziel, 256)).slice(0, 100),
        element_counts_top: Object.fromEntries(Object.entries(zaehler).sort((a, b) => b[1] - a[1]).slice(0, 30)),
      },
    });
  },
};
