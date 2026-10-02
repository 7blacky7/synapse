/**
 * MODUL: Asset 3D glTF/GLB
 * ZWECK: Inspektor fuer .gltf (JSON) und .glb (Binaer-Container): GLB-Kopf und Chunk-Tabelle,
 *        danach Auswertung des JSON (Szenen, Nodes, Meshes, Materialien, Texturen, Animationen,
 *        Skins, Kameras, Accessor-Zahlen, Bounding-Box) und externe Referenzen.
 *
 * GRENZEN: Der JSON-Teil wird mit Groessenkappe gelesen (MAX_JSON_BYTES). Nutzdaten (BIN-Chunk,
 * externe .bin) werden NIE gelesen — Vertex-/Indexzahlen kommen aus den Accessor-Angaben im JSON.
 * Bounding-Box = Vereinigung der POSITION-min/max aller Primitive im LOKALEN Mesh-Raum
 * (ohne Node-Transformationen).
 */

import { BinaryReader } from '../../binary-reader.js';
import { AssetReadError } from '../../errors.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetMagic, AssetResult, AssetSource, AssetSourceRange } from '../../types.js';
import { Bbox, Lesebudget, Sammler, endungVon, index, kappeText, sammleReferenz, zahl } from './helpers.js';

const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 64;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

type Json = Record<string, unknown>;

const istObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === 'string' ? kappeText(v) : null);

/** Ein Chunk der GLB-Chunktabelle. */
interface GlbChunk {
  typ: string;
  offset: number;
  laenge: number;
  abgeschnitten: boolean;
}

interface Bereich {
  offset: number;
  length: number;
}

function chunkTypName(t: number): string {
  if (t === CHUNK_JSON) return 'JSON';
  if (t === CHUNK_BIN) return 'BIN';
  return '0x' + t.toString(16).padStart(8, '0');
}

/**
 * Findet in einem JSON-Text die Byte-Bereiche der Elemente von Top-Level-Arrays (z. B. "meshes").
 * Einzelner Durchlauf ueber die Bytes, ohne das JSON zu parsen; Strings und Escapes werden uebersprungen.
 * Bereiche sind relativ zum Puffer. Zu wenige oder keine Bereiche sind erlaubt (Aufrufer faellt zurueck).
 */
export function scanneJsonArrays(
  buf: Uint8Array,
  gesucht: ReadonlySet<string>,
  maxProKey: number,
  pruefe: () => void
): Map<string, Bereich[]> {
  const out = new Map<string, Bereich[]>();
  const n = buf.length;
  let tiefe = 0;
  let erwarteKey = false;
  let key: string | null = null;
  let aktiv: string | null = null;
  let elemStart = -1;
  let letzte = -1;

  const abschliessen = (): void => {
    if (aktiv !== null && elemStart >= 0 && letzte >= elemStart) {
      let liste = out.get(aktiv);
      if (!liste) {
        liste = [];
        out.set(aktiv, liste);
      }
      if (liste.length < maxProKey) liste.push({ offset: elemStart, length: letzte + 1 - elemStart });
    }
    elemStart = -1;
  };

  for (let i = 0; i < n; i++) {
    if ((i & 0xffff) === 0) pruefe();
    const c = buf[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (aktiv !== null && tiefe === 2 && elemStart < 0 && c !== 0x2c && c !== 0x5d) elemStart = i;
    switch (c) {
      case 0x22: {
        const start = i;
        i++;
        while (i < n && buf[i] !== 0x22) {
          if (buf[i] === 0x5c) i++;
          i++;
        }
        if (tiefe === 1 && erwarteKey) {
          key = i - start <= 40 ? Buffer.from(buf.subarray(start + 1, Math.min(i, n))).toString('latin1') : null;
          erwarteKey = false;
        }
        letzte = Math.min(i, n - 1);
        break;
      }
      case 0x7b: // {
      case 0x5b: // [
        if (c === 0x5b && tiefe === 1 && key !== null && gesucht.has(key)) aktiv = key;
        tiefe++;
        if (c === 0x7b && tiefe === 1) {
          erwarteKey = true;
          key = null;
        }
        letzte = i;
        break;
      case 0x7d: // }
      case 0x5d: // ]
        tiefe--;
        if (c === 0x5d && aktiv !== null && tiefe === 1) {
          abschliessen();
          aktiv = null;
        }
        letzte = i;
        break;
      case 0x2c: // ,
        if (tiefe === 1) {
          erwarteKey = true;
          key = null;
        } else if (aktiv !== null && tiefe === 2) {
          abschliessen();
        }
        break;
      case 0x3a: // :
        if (tiefe === 1) erwarteKey = false;
        break;
      default:
        letzte = i;
    }
    if (tiefe < 0) break;
  }
  return out;
}

/** Ergebnis des GLB-Kopf-Lesens. */
interface GlbKopf {
  version: number;
  laengeKopf: number;
  chunks: GlbChunk[];
}

async function leseGlbKopf(src: AssetSource, budget: Lesebudget, ctx: AssetContext, s: Sammler): Promise<GlbKopf | null> {
  const kopf = await budget.lese(src, 0, 12);
  if (kopf.length < 12) {
    s.warn('glb_kopf_abgeschnitten', `GLB-Kopf braucht 12 Bytes, Datei hat nur ${src.size}.`);
    return null;
  }
  const r = new BinaryReader(kopf, 0);
  r.skip(4);
  const version = r.u32le();
  const laengeKopf = r.u32le();
  const chunks: GlbChunk[] = [];
  if (version !== 2) {
    s.warn('glb_version_nicht_unterstuetzt', `GLB-Version ${version} wird nicht ausgewertet (unterstuetzt: 2).`);
    return { version, laengeKopf, chunks };
  }
  if (laengeKopf > src.size) {
    s.warn('glb_laenge_groesser_als_datei', `GLB-Kopf nennt ${laengeKopf} Bytes, die Datei hat nur ${src.size} (abgeschnitten?).`);
  } else if (laengeKopf < src.size) {
    s.warn('glb_ueberhang', `Datei ist ${src.size - laengeKopf} Bytes groesser als die GLB-Laenge im Kopf (${laengeKopf}).`);
  }
  if (laengeKopf < 12) s.warn('glb_laenge_ungueltig', `GLB-Laenge ${laengeKopf} ist kleiner als der Kopf.`);
  const ende = Math.min(Math.max(laengeKopf, 12), src.size);
  let off = 12;
  while (off + 8 <= ende) {
    ctx.pruefeAbbruch();
    if (chunks.length >= MAX_CHUNKS) {
      s.warn('glb_zu_viele_chunks', `Mehr als ${MAX_CHUNKS} Chunks; Rest wird nicht gelesen.`);
      break;
    }
    const h = await budget.lese(src, off, 8);
    if (h.length < 8) {
      s.warn('glb_chunk_kopf_abgeschnitten', `Chunk-Kopf bei Offset ${off} unvollstaendig.`);
      break;
    }
    const laenge = h.readUInt32LE(0);
    const typ = h.readUInt32LE(4);
    const frei = src.size - (off + 8);
    const abgeschnitten = laenge > frei;
    chunks.push({ typ: chunkTypName(typ), offset: off, laenge: abgeschnitten ? frei : laenge, abgeschnitten });
    if (abgeschnitten) {
      s.warn('glb_chunk_ueber_dateiende', `Chunk ${chunkTypName(typ)} bei Offset ${off} nennt ${laenge} Bytes, in der Datei sind nur ${frei} da.`);
      break;
    }
    if (laenge % 4 !== 0) s.warn('glb_chunk_nicht_ausgerichtet', `Chunk ${chunkTypName(typ)} hat Laenge ${laenge}, kein Vielfaches von 4.`);
    if (off + 8 + laenge > Math.max(laengeKopf, 12)) {
      s.warn('glb_chunk_ueber_glb_laenge', `Chunk ${chunkTypName(typ)} reicht ueber die im Kopf genannte GLB-Laenge hinaus.`);
      break;
    }
    off += 8 + laenge;
  }
  return { version, laengeKopf, chunks };
}

/** Trimmt UTF-8-BOM und endstaendige Leerzeichen/NUL (GLB-Padding) und liefert Offset + Text. */
function jsonText(buf: Buffer): { text: string; offsetImPuffer: number } {
  let von = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) von = 3;
  let bis = buf.length;
  while (bis > von && (buf[bis - 1] === 0x20 || buf[bis - 1] === 0x00 || buf[bis - 1] === 0x0a || buf[bis - 1] === 0x0d || buf[bis - 1] === 0x09)) bis--;
  return { text: buf.toString('utf8', von, bis), offsetImPuffer: von };
}

function accessorZahl(accessors: unknown[], idx: unknown, s: Sammler, was: string): Json | null {
  const i = index(idx);
  if (i === undefined || i >= accessors.length || !istObj(accessors[i])) {
    s.warn('accessor_ungueltig', `${was}: Accessor-Index ${String(idx)} existiert nicht (${accessors.length} Accessors).`);
    return null;
  }
  return accessors[i] as Json;
}

const MODUS_NAMEN: Record<number, string> = { 0: 'points', 1: 'lines', 2: 'line_loop', 3: 'line_strip', 4: 'triangles', 5: 'triangle_strip', 6: 'triangle_fan' };

function dreiecke(modus: number, anzahl: number): number {
  if (modus === 4) return Math.floor(anzahl / 3);
  if (modus === 5 || modus === 6) return Math.max(0, anzahl - 2);
  return 0;
}

/** 4x4-Matrix spaltenweise (wie glTF). */
type Mat = number[];
const EINHEIT: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mulMat(a: Mat, b: Mat): Mat {
  const o: Mat = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = sum;
    }
  }
  return o;
}

const zahlen = (v: unknown, n: number): number[] | null =>
  Array.isArray(v) && v.length >= n && v.slice(0, n).every(x => typeof x === 'number' && Number.isFinite(x)) ? (v.slice(0, n) as number[]) : null;

/** Lokale Matrix eines Nodes aus matrix oder translation/rotation/scale; EINHEIT, wenn nichts oder Unbrauchbares da ist. */
function knotenMatrix(no: Json): Mat {
  const m = zahlen(no.matrix, 16);
  if (m) return m;
  const t = zahlen(no.translation, 3) ?? [0, 0, 0];
  const q = zahlen(no.rotation, 4) ?? [0, 0, 0, 1];
  const sk = zahlen(no.scale, 3) ?? [1, 1, 1];
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  const [x, y, z, w] = len > 1e-12 ? q.map(v => v / len) : [0, 0, 0, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sk[0], 2 * (x * y + z * w) * sk[0], 2 * (x * z - y * w) * sk[0], 0,
    2 * (x * y - z * w) * sk[1], (1 - 2 * (x * x + z * z)) * sk[1], 2 * (y * z + x * w) * sk[1], 0,
    2 * (x * z + y * w) * sk[2], 2 * (y * z - x * w) * sk[2], (1 - 2 * (x * x + y * y)) * sk[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

const KOMPONENTEN_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYP_KOMPONENTEN: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Hoechstzahl Nodes, fuer die die Welt-Bounding-Box berechnet wird. */
const MAX_WELT_NODES = 200_000;

const TEXTUR_SLOTS: Array<[string, string[]]> = [
  ['baseColorTexture', ['pbrMetallicRoughness', 'baseColorTexture']],
  ['metallicRoughnessTexture', ['pbrMetallicRoughness', 'metallicRoughnessTexture']],
  ['normalTexture', ['normalTexture']],
  ['occlusionTexture', ['occlusionTexture']],
  ['emissiveTexture', ['emissiveTexture']],
];

/** Wertet das glTF-JSON aus und fuellt den Sammler; liefert metadata und format_specific-Anteile. */
async function wertAus(
  j: Json,
  src: AssetSource,
  s: Sammler,
  ctx: AssetContext,
  rangeFuer: (key: string, i: number) => AssetSourceRange | undefined,
  glb: { binLaenge: number | null } | null
): Promise<Json> {
  const accessors = arr(j.accessors);
  const meshes = arr(j.meshes);
  const nodes = arr(j.nodes);
  const materials = arr(j.materials);
  const textures = arr(j.textures);
  const images = arr(j.images);
  const buffers = arr(j.buffers);
  const bufferViews = arr(j.bufferViews);
  const animations = arr(j.animations);
  const skins = arr(j.skins);
  const cameras = arr(j.cameras);
  const scenes = arr(j.scenes);

  // ---------- Plausibilitaet der Accessor-Angaben (Laengenangaben weit ueber den Daten) ----------
  for (let ai = 0; ai < accessors.length; ai++) {
    if ((ai & 0x3fff) === 0) ctx.pruefeAbbruch();
    const a = accessors[ai];
    if (!istObj(a) || a.sparse !== undefined) continue;
    const bvI = index(a.bufferView);
    const cnt = index(a.count);
    const komp = KOMPONENTEN_BYTES[a.componentType as number];
    const tz = TYP_KOMPONENTEN[a.type as string];
    if (bvI === undefined || cnt === undefined || !komp || !tz) continue;
    const bv = bufferViews[bvI];
    if (!istObj(bv)) {
      s.warn('accessor_bufferview_ungueltig', `Accessor ${ai}: bufferView ${bvI} existiert nicht (${bufferViews.length} BufferViews).`);
      continue;
    }
    const bl = index(bv.byteLength);
    if (bl === undefined) continue;
    const elem = komp * tz;
    const schritt = index(bv.byteStride) ?? elem;
    const noetig = (index(a.byteOffset) ?? 0) + (cnt === 0 ? 0 : (cnt - 1) * schritt + elem);
    if (noetig > bl) s.warn('accessor_groesser_als_bufferview', `Accessor ${ai}: ${cnt} Elemente brauchen ${noetig} Bytes, der BufferView ${bvI} hat ${bl}.`);
  }

  const asset = istObj(j.asset) ? j.asset : {};
  const gltfVersion = text(asset.version);
  if (gltfVersion === null) s.warn('gltf_asset_version_fehlt', 'asset.version fehlt (Pflichtfeld in glTF).');
  else if (!gltfVersion.startsWith('2')) s.warn('gltf_version_nicht_unterstuetzt', `asset.version "${gltfVersion}" — ausgewertet wird nach glTF 2.0.`);

  const extUsed = arr(j.extensionsUsed).filter((x): x is string => typeof x === 'string').map(x => kappeText(x, 80));
  const extReq = arr(j.extensionsRequired).filter((x): x is string => typeof x === 'string').map(x => kappeText(x, 80));
  if (extUsed.includes('KHR_draco_mesh_compression')) s.info('draco_komprimiert', 'Meshes sind Draco-komprimiert; Zaehler stammen aus den Accessor-Angaben, die Geometrie wird nicht dekodiert.');
  if (extReq.length > 0) s.info('extensions_required', `Pflicht-Erweiterungen: ${extReq.join(', ')}`);

  // ---------- Szenen ----------
  const sceneObjekte: Array<{ name: string | null; nodes: number[]; i: number }> = [];
  scenes.forEach((sc, i) => {
    const o = istObj(sc) ? sc : {};
    sceneObjekte.push({ name: text(o.name), nodes: arr(o.nodes).filter((x): x is number => index(x) !== undefined), i });
  });
  const standardSzene = index(j.scene) ?? null;

  // ---------- Node-Hierarchie ----------
  const kinderVon: number[][] = nodes.map(nd => (istObj(nd) ? arr(nd.children).filter((x): x is number => index(x) !== undefined && (x as number) < nodes.length) : []));
  const istKind = new Set<number>();
  for (const ks of kinderVon) for (const k of ks) istKind.add(k);
  let wurzeln: number[] = [];
  if (sceneObjekte.length > 0) {
    const set = new Set<number>();
    for (const sc of sceneObjekte) for (const nIdx of sc.nodes) if (nIdx < nodes.length) set.add(nIdx);
    wurzeln = [...set];
  } else {
    wurzeln = nodes.map((_, i) => i).filter(i => !istKind.has(i));
  }
  let maxTiefe = 0;
  const besucht = new Set<number>();
  let zyklus = false;
  {
    const stapel: Array<[number, number]> = wurzeln.map(w => [w, 1]);
    let schritte = 0;
    while (stapel.length > 0) {
      if ((++schritte & 0x3fff) === 0) ctx.pruefeAbbruch();
      const [nIdx, t] = stapel.pop() as [number, number];
      if (besucht.has(nIdx)) {
        zyklus = true;
        continue;
      }
      besucht.add(nIdx);
      if (t > maxTiefe) maxTiefe = t;
      for (const k of kinderVon[nIdx] ?? []) stapel.push([k, t + 1]);
    }
  }
  if (zyklus) s.warn('node_hierarchie_zyklus', 'Node-Hierarchie enthaelt einen Zyklus oder einen mehrfach referenzierten Node.');
  const nodesMitMesh = nodes.filter(nd => istObj(nd) && index(nd.mesh) !== undefined).length;

  // ---------- Meshes / Accessor-Zahlen ----------
  const gesamt = new Bbox();
  let vertsSumme = 0;
  let indexSumme = 0;
  let dreieckeSumme = 0;
  let primitiveAnzahl = 0;
  const eindeutigePositionen = new Set<number>();
  let positionOhneMinMax = 0;
  const meshDaten: Json[] = [];
  const meshBoxen: Bbox[] = [];
  const nachMaterial = new Map<number, number>();
  meshes.forEach((m, mi) => {
    ctx.pruefeAbbruch();
    const mo = istObj(m) ? m : {};
    const prims = arr(mo.primitives);
    const meshBox = new Bbox();
    let mVerts = 0;
    let mIdx = 0;
    let mTris = 0;
    const attrNamen = new Set<string>();
    const materialIdx = new Set<number>();
    const primDaten: Json[] = [];
    prims.forEach((p, pi) => {
      const po = istObj(p) ? p : {};
      primitiveAnzahl++;
      const modus = index(po.mode) ?? 4;
      const attrs = istObj(po.attributes) ? po.attributes : {};
      const namen = Object.keys(attrs).sort();
      namen.forEach(a => attrNamen.add(a));
      let verts: number | null = null;
      if ('POSITION' in attrs) {
        const acc = accessorZahlOderNull(accessors, attrs.POSITION, s, `Mesh ${mi} Primitive ${pi} POSITION`);
        if (acc) {
          verts = index(acc.count) ?? null;
          if (verts === null) s.warn('accessor_count_ungueltig', `Mesh ${mi} Primitive ${pi}: POSITION.count fehlt oder ist ungueltig.`);
          const ai = attrs.POSITION as number;
          eindeutigePositionen.add(ai);
          if (!(meshBox.addBox(acc.min, acc.max) && gesamt.addBox(acc.min, acc.max))) positionOhneMinMax++;
        }
      } else if (!istObj(po.extensions) || !istObj((po.extensions as Json).KHR_draco_mesh_compression)) {
        s.info('primitive_ohne_position', `Mesh ${mi} Primitive ${pi} hat kein POSITION-Attribut.`);
      }
      let indexAnzahl: number | null = null;
      if (po.indices !== undefined) {
        const acc = accessorZahlOderNull(accessors, po.indices, s, `Mesh ${mi} Primitive ${pi} indices`);
        if (acc) indexAnzahl = index(acc.count) ?? null;
      }
      const basis = indexAnzahl ?? verts;
      const tris = basis === null ? 0 : dreiecke(modus, basis);
      if (verts !== null) mVerts += verts;
      if (indexAnzahl !== null) mIdx += indexAnzahl;
      mTris += tris;
      const mat = index(po.material);
      if (mat !== undefined) {
        materialIdx.add(mat);
        nachMaterial.set(mat, (nachMaterial.get(mat) ?? 0) + 1);
      }
      if (primDaten.length < 16) {
        primDaten.push({
          mode: modus,
          mode_name: MODUS_NAMEN[modus] ?? 'unbekannt',
          attributes: namen,
          vertices: verts,
          indices: indexAnzahl,
          triangles: tris,
          material: mat ?? null,
          morph_targets: arr(po.targets).length,
        });
      }
    });
    vertsSumme += mVerts;
    indexSumme += mIdx;
    dreieckeSumme += mTris;
    const objData: Json = {
      primitive_count: prims.length,
      vertices: mVerts,
      indices: mIdx,
      triangles: mTris,
      attributes: [...attrNamen].sort(),
      materials: [...materialIdx].sort((a, b) => a - b),
      bounding_box: meshBox.alsObjekt(),
      primitives: primDaten,
      morph_target_names: arr(istObj(mo.extras) ? (mo.extras as Json).targetNames : null).filter((x): x is string => typeof x === 'string').slice(0, 32),
    };
    meshDaten.push(objData);
    meshBoxen.push(meshBox);
  });
  if (positionOhneMinMax > 0) s.info('position_ohne_min_max', `${positionOhneMinMax} POSITION-Accessor(s) ohne gueltiges min/max (Pflicht in glTF); Bounding-Box evtl. unvollstaendig.`);

  // ---------- Bounding-Box im Weltraum: Mesh-Boxen durch die Node-Transformationen ----------
  const weltBox = new Bbox();
  if (nodes.length > MAX_WELT_NODES) {
    s.info('welt_bbox_uebersprungen', `${nodes.length} Nodes (Grenze ${MAX_WELT_NODES}); Welt-Bounding-Box nicht berechnet.`);
  } else {
    const stapel: Array<[number, Mat]> = wurzeln.map(w => [w, EINHEIT]);
    const gesehen = new Set<number>();
    let schritte = 0;
    while (stapel.length > 0) {
      if ((++schritte & 0x3fff) === 0) ctx.pruefeAbbruch();
      const [nIdx, eltern] = stapel.pop() as [number, Mat];
      if (gesehen.has(nIdx) || nIdx >= nodes.length) continue;
      gesehen.add(nIdx);
      const no = istObj(nodes[nIdx]) ? (nodes[nIdx] as Json) : {};
      const m = mulMat(eltern, knotenMatrix(no));
      const mi = index(no.mesh);
      if (mi !== undefined && mi < meshBoxen.length && !meshBoxen[mi].leer) {
        const b = meshBoxen[mi];
        for (let ecke = 0; ecke < 8; ecke++) {
          const x = ecke & 1 ? b.max[0] : b.min[0];
          const y = ecke & 2 ? b.max[1] : b.min[1];
          const z = ecke & 4 ? b.max[2] : b.min[2];
          weltBox.add(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
      }
      for (const k of kinderVon[nIdx] ?? []) stapel.push([k, m]);
    }
  }

  // ---------- Objekte (Reihenfolge: Szenen, Meshes, Materialien, Animationen, Skins, Kameras, Bilder, Texturen, Buffers, Nodes) ----------
  for (const sc of sceneObjekte) {
    s.addObject({
      name: sc.name,
      kind: 'scene',
      data: { index: sc.i, root_nodes: sc.nodes.length, nodes: sc.nodes.slice(0, 64), standard: standardSzene === sc.i },
      source_range: rangeFuer('scenes', sc.i),
    });
  }
  meshes.forEach((m, mi) => {
    s.addObject({ name: istObj(m) ? text(m.name) : null, kind: 'mesh', data: { index: mi, ...meshDaten[mi] }, source_range: rangeFuer('meshes', mi) });
  });
  materials.forEach((m, mi) => {
    const mo = istObj(m) ? m : {};
    const pbr = istObj(mo.pbrMetallicRoughness) ? mo.pbrMetallicRoughness : {};
    const slots: Json[] = [];
    for (const [slot, pfad] of TEXTUR_SLOTS) {
      let cur: unknown = mo;
      for (const p of pfad) cur = istObj(cur) ? cur[p] : undefined;
      if (istObj(cur)) {
        const ti = index(cur.index);
        slots.push({ slot, texture: ti ?? null, tex_coord: index(cur.texCoord) ?? 0 });
        if (ti === undefined || ti >= textures.length) s.warn('textur_index_ungueltig', `Material ${mi} ${slot}: Textur-Index ${String(cur.index)} existiert nicht (${textures.length} Texturen).`);
      }
    }
    const ext = istObj(mo.extensions) ? Object.keys(mo.extensions).sort() : [];
    s.addObject({
      name: text(mo.name),
      kind: 'material',
      data: {
        index: mi,
        base_color_factor: Array.isArray(pbr.baseColorFactor) ? (pbr.baseColorFactor as unknown[]).slice(0, 4) : null,
        metallic_factor: zahl(pbr.metallicFactor) ?? null,
        roughness_factor: zahl(pbr.roughnessFactor) ?? null,
        emissive_factor: Array.isArray(mo.emissiveFactor) ? (mo.emissiveFactor as unknown[]).slice(0, 3) : null,
        alpha_mode: text(mo.alphaMode),
        alpha_cutoff: zahl(mo.alphaCutoff) ?? null,
        double_sided: typeof mo.doubleSided === 'boolean' ? mo.doubleSided : null,
        texture_slots: slots,
        extensions: ext,
        primitives_using: nachMaterial.get(mi) ?? 0,
      },
      source_range: rangeFuer('materials', mi),
    });
  });

  let animDauerMax: number | null = null;
  animations.forEach((a, ai) => {
    ctx.pruefeAbbruch();
    const ao = istObj(a) ? a : {};
    const channels = arr(ao.channels);
    const samplers = arr(ao.samplers);
    const pfade = new Set<string>();
    const ziele: Json[] = [];
    for (const ch of channels) {
      const co = istObj(ch) ? ch : {};
      const ta = istObj(co.target) ? co.target : {};
      const pth = text(ta.path);
      if (pth) pfade.add(pth);
      if (ziele.length < 20) ziele.push({ node: index(ta.node) ?? null, path: pth });
    }
    let dauer: number | null = null;
    for (const sp of samplers) {
      const so = istObj(sp) ? sp : {};
      const inp = index(so.input);
      if (inp !== undefined && inp < accessors.length && istObj(accessors[inp])) {
        const mx = (accessors[inp] as Json).max;
        const v = Array.isArray(mx) ? zahl(mx[0]) : undefined;
        if (v !== undefined && (dauer === null || v > dauer)) dauer = v;
      }
    }
    if (dauer !== null && (animDauerMax === null || dauer > animDauerMax)) animDauerMax = dauer;
    s.addObject({
      name: text(ao.name),
      kind: 'animation',
      data: { index: ai, channel_count: channels.length, sampler_count: samplers.length, target_paths: [...pfade].sort(), targets: ziele, duration_s: dauer },
      source_range: rangeFuer('animations', ai),
    });
  });

  skins.forEach((k, ki) => {
    const ko = istObj(k) ? k : {};
    s.addObject({
      name: text(ko.name),
      kind: 'skin',
      data: { index: ki, joint_count: arr(ko.joints).length, skeleton: index(ko.skeleton) ?? null, inverse_bind_matrices: index(ko.inverseBindMatrices) ?? null },
      source_range: rangeFuer('skins', ki),
    });
  });

  cameras.forEach((c, ci) => {
    const co = istObj(c) ? c : {};
    const typ = text(co.type);
    const p = istObj(co.perspective) ? co.perspective : istObj(co.orthographic) ? co.orthographic : {};
    s.addObject({
      name: text(co.name),
      kind: 'camera',
      data: {
        index: ci,
        type: typ,
        yfov: zahl(p.yfov) ?? null,
        aspect_ratio: zahl(p.aspectRatio) ?? null,
        xmag: zahl(p.xmag) ?? null,
        ymag: zahl(p.ymag) ?? null,
        znear: zahl(p.znear) ?? null,
        zfar: zahl(p.zfar) ?? null,
      },
      source_range: rangeFuer('cameras', ci),
    });
  });

  // Bilder: Referenzen aufloesen
  let eingebettetImages = 0;
  let externeImages = 0;
  let bufferViewImages = 0;
  for (let ii = 0; ii < images.length; ii++) {
    ctx.pruefeAbbruch();
    const io = istObj(images[ii]) ? (images[ii] as Json) : {};
    const uri = typeof io.uri === 'string' ? io.uri : null;
    let art: string;
    if (uri === null) {
      art = index(io.bufferView) !== undefined ? 'buffer_view' : 'fehlt';
      if (art === 'buffer_view') bufferViewImages++;
      else s.warn('image_ohne_quelle', `Image ${ii} hat weder uri noch bufferView.`);
    } else if (/^data:/i.test(uri)) {
      art = 'eingebettet_data_uri';
      eingebettetImages++;
    } else {
      art = 'extern';
      externeImages++;
      await sammleReferenz(src.filePath, uri, 'texture', s, { uri: true });
    }
    s.addObject({
      name: text(io.name),
      kind: 'image',
      data: { index: ii, quelle: art, uri: uri !== null && art === 'extern' ? kappeText(uri, 256) : null, mime_type: text(io.mimeType), data_uri_zeichen: art === 'eingebettet_data_uri' ? uri?.length ?? 0 : undefined },
      source_range: rangeFuer('images', ii),
    });
  }

  textures.forEach((t, ti) => {
    const to = istObj(t) ? t : {};
    let quelle = index(to.source);
    if (quelle === undefined && istObj(to.extensions)) {
      for (const e of Object.values(to.extensions)) if (istObj(e) && index(e.source) !== undefined) { quelle = index(e.source); break; }
    }
    if (quelle !== undefined && quelle >= images.length) s.warn('textur_quelle_ungueltig', `Textur ${ti}: Image-Index ${quelle} existiert nicht (${images.length} Images).`);
    s.addObject({
      name: text(to.name),
      kind: 'texture',
      data: { index: ti, source: quelle ?? null, sampler: index(to.sampler) ?? null },
      source_range: rangeFuer('textures', ti),
    });
  });

  // Buffer: Referenzen aufloesen
  let eingebettetBuffers = 0;
  let externeBuffers = 0;
  let bufferBytes = 0;
  for (let bi = 0; bi < buffers.length; bi++) {
    ctx.pruefeAbbruch();
    const bo = istObj(buffers[bi]) ? (buffers[bi] as Json) : {};
    const uri = typeof bo.uri === 'string' ? bo.uri : null;
    const len = index(bo.byteLength);
    if (len === undefined) s.warn('buffer_laenge_fehlt', `Buffer ${bi}: byteLength fehlt oder ist ungueltig.`);
    else bufferBytes += len;
    let art: string;
    if (uri === null) {
      if (glb && bi === 0) {
        art = 'glb_bin_chunk';
        if (len !== undefined && glb.binLaenge !== null && len > glb.binLaenge) {
          s.warn('buffer_groesser_als_bin_chunk', `Buffer 0 nennt ${len} Bytes, der BIN-Chunk hat nur ${glb.binLaenge}.`);
        }
        if (glb.binLaenge === null) s.warn('glb_bin_chunk_fehlt', 'Buffer 0 ohne uri verweist auf den BIN-Chunk, der fehlt.');
      } else {
        art = 'fehlt';
        s.warn('buffer_ohne_uri', `Buffer ${bi} hat keine uri${glb ? '' : ' (nur in GLB fuer Buffer 0 erlaubt)'}.`);
      }
    } else if (/^data:/i.test(uri)) {
      art = 'eingebettet_data_uri';
      eingebettetBuffers++;
    } else {
      art = 'extern';
      externeBuffers++;
      await sammleReferenz(src.filePath, uri, 'buffer', s, { uri: true });
    }
    s.addObject({
      name: text(bo.name),
      kind: 'buffer',
      data: { index: bi, byte_length: len ?? null, quelle: art, uri: art === 'extern' ? kappeText(uri ?? '', 256) : null },
      source_range: rangeFuer('buffers', bi),
    });
  }

  nodes.forEach((nd, ni) => {
    const no = istObj(nd) ? nd : {};
    const mRef = index(no.mesh);
    if (mRef !== undefined && mRef >= meshes.length) s.warn('node_referenz_ungueltig', `Node ${ni}: mesh ${mRef} existiert nicht (${meshes.length} Meshes).`);
    const sRef = index(no.skin);
    if (sRef !== undefined && sRef >= skins.length) s.warn('node_referenz_ungueltig', `Node ${ni}: skin ${sRef} existiert nicht (${skins.length} Skins).`);
    const cRef = index(no.camera);
    if (cRef !== undefined && cRef >= cameras.length) s.warn('node_referenz_ungueltig', `Node ${ni}: camera ${cRef} existiert nicht (${cameras.length} Kameras).`);
    const kinderRoh = arr(no.children).length;
    if ((kinderVon[ni]?.length ?? 0) < kinderRoh) s.warn('node_referenz_ungueltig', `Node ${ni}: ${kinderRoh - (kinderVon[ni]?.length ?? 0)} ungueltige children-Eintraege.`);
    const trs: Json = {};
    if (Array.isArray(no.matrix)) trs.matrix = (no.matrix as unknown[]).slice(0, 16);
    if (Array.isArray(no.translation)) trs.translation = (no.translation as unknown[]).slice(0, 3);
    if (Array.isArray(no.rotation)) trs.rotation = (no.rotation as unknown[]).slice(0, 4);
    if (Array.isArray(no.scale)) trs.scale = (no.scale as unknown[]).slice(0, 3);
    s.addObject({
      name: text(no.name),
      kind: 'node',
      data: {
        index: ni,
        children: kinderVon[ni]?.length ?? 0,
        mesh: index(no.mesh) ?? null,
        skin: index(no.skin) ?? null,
        camera: index(no.camera) ?? null,
        transform: Object.keys(trs).length > 0 ? trs : null,
      },
      source_range: rangeFuer('nodes', ni),
    });
  });

  const box = gesamt.alsObjekt();
  return {
    metadata: {
      gltf_version: gltfVersion,
      min_version: text(asset.minVersion),
      generator: text(asset.generator),
      copyright: text(asset.copyright),
      extensions_used: extUsed,
      extensions_required: extReq,
      default_scene: standardSzene,
      scene_count: scenes.length,
      node_count: nodes.length,
      root_node_count: wurzeln.length,
      hierarchy_max_depth: maxTiefe,
      nodes_with_mesh: nodesMitMesh,
      mesh_count: meshes.length,
      primitive_count: primitiveAnzahl,
      vertex_count: vertsSumme,
      vertex_count_unique_accessors: [...eindeutigePositionen].reduce((sum, ai) => sum + (index((accessors[ai] as Json | undefined)?.count) ?? 0), 0),
      index_count: indexSumme,
      triangle_count: dreieckeSumme,
      accessor_count: accessors.length,
      buffer_view_count: bufferViews.length,
      buffer_count: buffers.length,
      buffer_bytes_total: bufferBytes,
      material_count: materials.length,
      texture_count: textures.length,
      image_count: images.length,
      animation_count: animations.length,
      animation_duration_s: animDauerMax,
      skin_count: skins.length,
      camera_count: cameras.length,
      bounding_box: box,
      bounding_box_raum: 'mesh_lokal_ohne_node_transformation',
      bounding_box_world: weltBox.alsObjekt(),
    },
    format_specific: {
      images: { extern: externeImages, eingebettet_data_uri: eingebettetImages, buffer_view: bufferViewImages },
      buffers: { extern: externeBuffers, eingebettet_data_uri: eingebettetBuffers },
      extras_vorhanden: j.extras !== undefined,
    },
  };
}

function accessorZahlOderNull(accessors: unknown[], idx: unknown, s: Sammler, was: string): Json | null {
  return accessorZahl(accessors, idx, s, was);
}

const SCAN_KEYS: ReadonlySet<string> = new Set(['scenes', 'nodes', 'meshes', 'materials', 'textures', 'images', 'animations', 'skins', 'cameras', 'buffers']);

/** Gemeinsame Inspektion fuer .gltf und .glb; die Kennung kommt vom aufrufenden Inspektor (this.id). */
const gltfGemeinsam = {
  version: 1,
  async inspect(this: AssetInspector, src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
    const s = new Sammler(ctx);
    const budget = new Lesebudget(ctx);
    const ext = endungVon(src.filePath);
    const kopf = await budget.lese(src, 0, 12);
    const istGlb = kopf.length >= 4 && kopf.toString('latin1', 0, 4) === 'glTF';
    const res = (extra: Partial<AssetResult>): AssetResult => {
      const warnungen = s.abschluss();
      return erzeugeAssetResult(src.filePath, src.size, {
        asset_type: 'model3d',
        inspector: this.id,
        parser_version: 1,
        status: s.problem ? 'teilweise' : 'ok',
        objects: s.objects,
        references: s.references,
        warnings: warnungen,
        ...extra,
      });
    };

    if (istGlb && ext === '.gltf') s.warn('inhalt_passt_nicht_zur_endung', 'Endung .gltf, der Inhalt ist ein GLB-Container (Magic "glTF").');
    if (!istGlb && ext === '.glb') s.warn('inhalt_passt_nicht_zur_endung', 'Endung .glb, aber der Dateikopf traegt nicht das GLB-Magic "glTF".');

    let jsonBuf: Buffer | null = null;
    let jsonBasis = 0;
    let glbInfo: Json | null = null;
    let binLaenge: number | null = null;
    const format = istGlb ? 'glb' : 'gltf';

    if (istGlb) {
      const g = await leseGlbKopf(src, budget, ctx, s);
      if (g === null) return res({ format, metadata: { glb: true } });
      glbInfo = { version: g.version, laenge_im_kopf: g.laengeKopf, chunks: g.chunks.map(c => ({ typ: c.typ, offset: c.offset, laenge: c.laenge, abgeschnitten: c.abgeschnitten })) };
      for (const c of g.chunks) {
        s.addObject({
          name: c.typ,
          kind: 'glb_chunk',
          data: { typ: c.typ, laenge: c.laenge, abgeschnitten: c.abgeschnitten },
          source_range: { offset: c.offset, length: 8 + c.laenge },
        });
      }
      const bin = g.chunks.find(c => c.typ === 'BIN');
      if (bin) binLaenge = bin.laenge;
      const jc = g.chunks.find(c => c.typ === 'JSON');
      if (g.version === 2 && !jc) s.warn('glb_json_chunk_fehlt', 'GLB enthaelt keinen JSON-Chunk.');
      if (g.chunks.length > 0 && g.chunks[0].typ !== 'JSON' && jc) s.warn('glb_json_chunk_nicht_zuerst', 'Der erste GLB-Chunk ist nicht JSON (Spezifikation verlangt JSON zuerst).');
      if (jc) {
        if (jc.laenge > Math.min(MAX_JSON_BYTES, ctx.limits.maxReadBytes)) {
          s.warn('json_zu_gross', `JSON-Chunk (${jc.laenge} Bytes) ueber der Lesekappe ${MAX_JSON_BYTES}; nur Kopf und Chunk-Tabelle ausgewertet.`);
        } else {
          jsonBuf = await budget.lese(src, jc.offset + 8, jc.laenge);
          jsonBasis = jc.offset + 8;
          if (jsonBuf.length < jc.laenge) {
            s.warn('json_abgeschnitten', 'JSON-Chunk konnte nicht vollstaendig gelesen werden.');
            jsonBuf = null;
          }
        }
      }
      if (g.version !== 2) return res({ format, metadata: { glb: true, glb_version: g.version }, format_specific: { glb: glbInfo } });
    } else {
      if (src.size > Math.min(MAX_JSON_BYTES, ctx.limits.maxReadBytes)) {
        s.warn('json_zu_gross', `glTF-Datei (${src.size} Bytes) ueber der Lesekappe ${MAX_JSON_BYTES}; nicht ausgewertet.`);
      } else {
        jsonBuf = await budget.lese(src, 0, src.size);
        jsonBasis = 0;
      }
    }

    if (jsonBuf === null) return res({ format, metadata: { glb: istGlb }, format_specific: { glb: glbInfo } });

    const { text: jtext, offsetImPuffer } = jsonText(jsonBuf);
    jsonBasis += offsetImPuffer;
    if (!istGlb && !/^\s*\{/.test(jtext.slice(0, 64))) {
      s.warn('inhalt_passt_nicht_zur_endung', 'Datei beginnt nicht mit einem JSON-Objekt; kein glTF.');
      return res({ format, metadata: { glb: false } });
    }
    let json: unknown;
    try {
      json = JSON.parse(jtext);
    } catch (e) {
      s.warn('json_kaputt', `glTF-JSON nicht lesbar: ${kappeText((e as Error).message, 200)}`);
      return res({ format, metadata: { glb: istGlb }, format_specific: { glb: glbInfo } });
    }
    if (!istObj(json)) {
      s.warn('json_kein_objekt', 'glTF-JSON ist kein Objekt.');
      return res({ format, metadata: { glb: istGlb }, format_specific: { glb: glbInfo } });
    }

    // Byte-Bereiche je Objekt (relativ zum JSON-Text, dann auf Dateioffsets umrechnen).
    let bereiche = new Map<string, Bereich[]>();
    try {
      const rohBuf = jsonBuf.subarray(offsetImPuffer);
      bereiche = scanneJsonArrays(rohBuf, SCAN_KEYS, Math.max(1, ctx.limits.maxObjects), () => ctx.pruefeAbbruch());
    } catch (e) {
      if ((e as Error)?.name === 'AssetLimitError') throw e;
      s.info('bereiche_nicht_ermittelt', 'Byte-Bereiche der JSON-Elemente nicht ermittelt; Objekte tragen den Bereich des gesamten JSON.');
    }
    const gesamtBereich: AssetSourceRange = { offset: jsonBasis, length: Buffer.byteLength(jtext, 'utf8') };
    const rangeFuer = (key: string, i: number): AssetSourceRange => {
      const b = bereiche.get(key)?.[i];
      return b ? { offset: jsonBasis + b.offset, length: b.length } : gesamtBereich;
    };

    let teil: Json;
    try {
      teil = await wertAus(json, src, s, ctx, rangeFuer, istGlb ? { binLaenge } : null);
    } catch (e) {
      if (e instanceof AssetReadError || (e as Error)?.name === 'AssetLimitError') throw e;
      s.warn('gltf_auswertung_fehlgeschlagen', `glTF-Struktur nicht auswertbar: ${kappeText((e as Error)?.message ?? String(e), 200)}`);
      teil = { metadata: {}, format_specific: {} };
    }
    const metadata = { glb: istGlb, ...(teil.metadata as Json) };
    const fs: Json = { ...(teil.format_specific as Json) };
    if (glbInfo) fs.glb = glbInfo;
    fs.json_bereich = gesamtBereich;
    return res({ format, metadata, format_specific: fs });
  },
};

/** GLB-Magic 'glTF' am Dateianfang. */
const GLB_MAGIC: AssetMagic = { offset: 0, bytes: [0x67, 0x6c, 0x54, 0x46], format: 'glb' };

/** glTF als JSON-Text (.gltf) — ohne Magic, nur ueber die Endung. */
export const gltfInspector: AssetInspector = { ...gltfGemeinsam, id: '3d-gltf', formats: ['gltf'], extensions: ['.gltf'] };

/** glTF-Binaer-Container (.glb) — Magic vor Endung. */
export const glbInspector: AssetInspector = { ...gltfGemeinsam, id: '3d-glb', formats: ['glb'], extensions: ['.glb'], magic: [GLB_MAGIC] };
