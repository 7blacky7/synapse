/**
 * Fixture-Generator fuer die 3D-Inspektoren (P4-T61).
 * Erzeugt kleine Dateien DETERMINISTISCH (gleiche Bytes bei jedem Lauf) in einem Verzeichnis unter
 * os.tmpdir() — es werden KEINE Binaerdateien eingecheckt.
 *
 * HANDGEBAUT (nach Spezifikation): glTF/GLB, OBJ(+MTL), STL ascii/binaer, PLY ascii/binaer LE+BE,
 * DAE — plus kaputte, abgeschnittene, boesartige und falsch benannte Varianten.
 *
 * ECHTE DATEIEN (nur wenn `blender` vorhanden ist): erzeugeBlenderProben() laesst Blender im
 * Hintergrund zwei Wuerfel exportieren (glb, gltf getrennt, obj, stl binaer+ascii, ply binaer+ascii;
 * dae nur, wenn der Collada-Exporter im Blender-Build vorhanden ist — in Blender 5.1.1 auf diesem Rechner nicht).
 * Fehlt Blender, kommt verfuegbar:false zurueck — die Tests ueberspringen dann.
 *
 * AUFRUF: node packages/core/scripts/asset-fixtures-3d.mjs   (gibt das Verzeichnis aus)
 * ALS MODUL: const { dir, pfade, aufraeumen } = await erzeugeFixtures3d();
 */
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- Geometrie ----------
const WUERFEL_V = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
// 12 Dreiecke
const WUERFEL_T = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
];
// 6 Vierecke
const WUERFEL_Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];

const PNG_KOPF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0, 0, 0, 0]);

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function pad4(buf, fuell) {
  const rest = (4 - (buf.length % 4)) % 4;
  return rest === 0 ? buf : Buffer.concat([buf, Buffer.alloc(rest, fuell)]);
}

// ---------- glTF / GLB ----------
function dreieckBin() {
  const b = Buffer.alloc(44);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => b.writeFloatLE(v, i * 4));
  [0, 1, 2].forEach((v, i) => b.writeUInt16LE(v, 36 + i * 2));
  return b; // 36 + 6 + 2 Padding
}

function gltfDreieckJson(bufferUri) {
  return {
    asset: { version: '2.0', generator: 'Spec-Fixture 3d', copyright: 'Testdatei' },
    scene: 0,
    scenes: [{ name: 'Szene', nodes: [0] }],
    nodes: [{ name: 'Dreieck', mesh: 0 }],
    meshes: [{ name: 'Dreieck-Mesh', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{
      name: 'Rot',
      pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 0.5, baseColorTexture: { index: 0 } },
      doubleSided: true,
    }],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ uri: 'textur.png', name: 'Farbe' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    buffers: [bufferUri ? { uri: bufferUri, byteLength: 44 } : { byteLength: 44 }],
  };
}

function glbBauen(json, bin, opts = {}) {
  const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const teile = [Buffer.concat([u32le(jsonBuf.length), Buffer.from('JSON'), jsonBuf])];
  if (bin) {
    const b = pad4(bin, 0);
    teile.push(Buffer.concat([u32le(b.length), Buffer.from([0x42, 0x49, 0x4e, 0x00]), b]));
  }
  const body = Buffer.concat(teile);
  const gesamt = 12 + body.length;
  return Buffer.concat([Buffer.from('glTF'), u32le(opts.version ?? 2), u32le(opts.laenge ?? gesamt), body]);
}

function gltfSzeneJson() {
  const pos = { componentType: 5126, type: 'VEC3' };
  return {
    asset: { version: '2.0', generator: 'Spec-Fixture 3d Szene', minVersion: '2.0' },
    extensionsUsed: ['KHR_materials_emissive_strength'],
    extensionsRequired: [],
    scene: 1,
    scenes: [{ name: 'Leer', nodes: [] }, { name: 'Haupt', nodes: [0, 3] }],
    nodes: [
      { name: 'Wurzel', children: [1, 2], translation: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { name: 'Kind-Mesh', mesh: 0, skin: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] },
      { name: 'Kamera-Node', camera: 0 },
      { name: 'Zweiter-Baum', mesh: 1 },
    ],
    meshes: [
      {
        name: 'Wuerfel',
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 },
          { attributes: { POSITION: 0 }, material: 1, mode: 4 },
        ],
      },
      { name: 'Linien', primitives: [{ attributes: { POSITION: 4 }, mode: 1 }] },
    ],
    materials: [
      {
        name: 'Holz',
        pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 }, metallicRoughnessTexture: { index: 1 } },
        normalTexture: { index: 2 },
        emissiveFactor: [0.1, 0.2, 0.3],
        alphaMode: 'MASK',
        alphaCutoff: 0.4,
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 2 } },
      },
      { name: 'Glas', alphaMode: 'BLEND' },
    ],
    textures: [{ source: 0 }, { source: 1 }, { source: 5 }],
    images: [
      { uri: 'textur.png' },
      { uri: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
    cameras: [{ name: 'Cam', type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, zfar: 100, aspectRatio: 1.5 } }],
    skins: [{ name: 'Skelett', joints: [0, 2], skeleton: 0, inverseBindMatrices: 5 }],
    animations: [{
      name: 'Drehen',
      channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }, { sampler: 1, target: { node: 1, path: 'translation' } }],
      samplers: [{ input: 6, output: 7 }, { input: 6, output: 8 }],
    }],
    accessors: [
      { ...pos, count: 24, min: [-1, -1, -1], max: [1, 1, 1] },
      { ...pos, count: 24 },
      { componentType: 5126, type: 'VEC2', count: 24 },
      { componentType: 5123, type: 'SCALAR', count: 36 },
      { ...pos, count: 4, min: [2, 2, 2], max: [4, 3, 3] },
      { componentType: 5126, type: 'MAT4', count: 2 },
      { componentType: 5126, type: 'SCALAR', count: 5, min: [0], max: [2.5] },
      { componentType: 5126, type: 'VEC4', count: 5 },
      { ...pos, count: 5 },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    buffers: [{ uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAA', byteLength: 12 }],
  };
}

function gltfReferenzenJson() {
  return {
    asset: { version: '2.0' },
    images: [
      { uri: 'textur.png' },
      { uri: 'fehlt.png' },
      { uri: '../aussen.png' },
      { uri: '/etc/passwd' },
      { uri: 'https://example.org/x.png' },
      { uri: 'sub%20ordner/tex%20eins.png' },
      { uri: 'data:image/png;base64,AAAA' },
      { bufferView: 0, mimeType: 'image/png' },
      { uri: 'a/../../aussen2.png' },
    ],
    buffers: [{ uri: 'dreieck.bin', byteLength: 44 }, { uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }],
    bufferViews: [{ buffer: 0, byteLength: 4 }],
  };
}

// ---------- OBJ ----------
const OBJ_DREIECK = [
  '# Dreieck',
  'mtllib dreieck.mtl',
  'o Dreieck',
  'v 0 0 0',
  'v 1 0 0',
  'v 0 1 0',
  'vt 0 0',
  'vt 1 0',
  'vt 0 1',
  'vn 0 0 1',
  'usemtl Rot',
  'f 1/1/1 2/2/1 3/3/1',
  '',
].join('\n');

function objWuerfel() {
  const z = ['# Wuerfel mit zwei Objekten', 'mtllib dreieck.mtl', 'mtllib fehlt.mtl'];
  z.push('o Unten');
  WUERFEL_V.forEach(v => z.push(`v ${v[0]} ${v[1]} ${v[2]}`));
  z.push('usemtl Rot', 'g Boden');
  z.push('f 1 2 3 4');
  z.push('o Oben', 'g Seiten', 'usemtl Blau');
  WUERFEL_Q.slice(1).forEach(q => z.push('f ' + q.map(i => i + 1).join(' ')));
  z.push('f 1 2 3 4 5', 'f -1 -2 -3', 'l 1 2', 'p 3');
  return z.join('\r\n') + '\r\n';
}

// ---------- STL ----------
function normale(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return n.map(x => x / l);
}

function stlAscii(name, dreiecke) {
  const z = [`solid ${name}`];
  for (const t of dreiecke) {
    const [a, b, c] = t.map(i => WUERFEL_V[i]);
    const n = normale(a, b, c);
    z.push(`  facet normal ${n[0]} ${n[1]} ${n[2]}`, '    outer loop');
    for (const p of [a, b, c]) z.push(`      vertex ${p[0]} ${p[1]} ${p[2]}`);
    z.push('    endloop', '  endfacet');
  }
  z.push(`endsolid ${name}`);
  return z.join('\n') + '\n';
}

function stlBinaer(kopfText, dreiecke, deklariert) {
  const kopf = Buffer.alloc(80);
  kopf.write(kopfText, 'latin1');
  const teile = [kopf, u32le(deklariert ?? dreiecke.length)];
  for (const t of dreiecke) {
    const [a, b, c] = t.map(i => WUERFEL_V[i]);
    const dreieck = Buffer.alloc(50);
    const n = normale(a, b, c);
    [...n, ...a, ...b, ...c].forEach((v, i) => dreieck.writeFloatLE(v, i * 4));
    teile.push(dreieck);
  }
  return Buffer.concat(teile);
}

// ---------- PLY ----------
function plyKopf(format, extra) {
  return [
    'ply',
    `format ${format} 1.0`,
    'comment Spec-Fixture',
    'comment TextureFile textur.png',
    'obj_info Wuerfel 1x1x1',
    ...extra,
    'end_header',
    '',
  ].join('\n');
}

function plyAscii() {
  const kopf = plyKopf('ascii', ['element vertex 8', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'element face 6', 'property list uchar int vertex_indices']);
  const v = WUERFEL_V.map((p, i) => `${p[0]} ${p[1]} ${p[2]} ${i * 30} 0 255`);
  const f = WUERFEL_Q.map(q => `4 ${q.join(' ')}`);
  return kopf + v.join('\n') + '\n' + f.join('\n') + '\n';
}

function plyBinaer(le, reihenfolgeFaceZuerst = false) {
  const vertexProps = ['property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue'];
  const elemV = ['element vertex 8', ...vertexProps];
  const elemF = ['element face 6', 'property list uchar int vertex_indices'];
  const kopf = Buffer.from(plyKopf(le ? 'binary_little_endian' : 'binary_big_endian', reihenfolgeFaceZuerst ? [...elemF, ...elemV] : [...elemV, ...elemF]), 'latin1');
  const v = Buffer.alloc(8 * 15);
  WUERFEL_V.forEach((p, i) => {
    const o = i * 15;
    p.forEach((x, k) => (le ? v.writeFloatLE(x, o + k * 4) : v.writeFloatBE(x, o + k * 4)));
    v[o + 12] = i * 30;
    v[o + 13] = 0;
    v[o + 14] = 255;
  });
  const fTeile = [];
  for (const q of WUERFEL_Q) {
    const b = Buffer.alloc(1 + 16);
    b[0] = 4;
    q.forEach((x, k) => (le ? b.writeInt32LE(x, 1 + k * 4) : b.writeInt32BE(x, 1 + k * 4)));
    fTeile.push(b);
  }
  const f = Buffer.concat(fTeile);
  return Buffer.concat([kopf, reihenfolgeFaceZuerst ? Buffer.concat([f, v]) : Buffer.concat([v, f])]);
}

// ---------- DAE ----------
function daeSzene() {
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor>
      <author>Fixture &amp; Co</author>
      <authoring_tool>Spec-Fixture 3d</authoring_tool>
    </contributor>
    <created>2026-10-02T00:00:00</created>
    <modified>2026-10-02T00:00:01</modified>
    <unit name="centimeter" meter="0.01"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_images>
    <image id="tex-img" name="Textur">
      <init_from>textur.png</init_from>
    </image>
    <image id="fehlt-img">
      <init_from>file://fehlt%20bild.png</init_from>
    </image>
  </library_images>
  <library_effects>
    <effect id="rot-fx" name="RotFX">
      <profile_COMMON>
        <newparam sid="surf"><surface type="2D"><init_from>tex-img</init_from></surface></newparam>
        <technique sid="common"><phong><diffuse><color>1 0 0 1</color></diffuse></phong></technique>
      </profile_COMMON>
    </effect>
  </library_effects>
  <library_materials>
    <material id="rot-mat" name="Rot"><instance_effect url="#rot-fx"/></material>
  </library_materials>
  <library_geometries>
    <geometry id="dreieck-geo" name="Dreieck">
      <mesh>
        <source id="dreieck-pos">
          <float_array id="dreieck-pos-arr" count="9">0 0 0 1 0 0 0 1 0</float_array>
          <technique_common><accessor source="#dreieck-pos-arr" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common>
        </source>
        <vertices id="dreieck-vtx"><input semantic="POSITION" source="#dreieck-pos"/></vertices>
        <triangles material="rot-mat" count="1">
          <input semantic="VERTEX" source="#dreieck-vtx" offset="0"/>
          <p>0 1 2</p>
        </triangles>
      </mesh>
    </geometry>
    <geometry id="quad-geo" name="Quad">
      <mesh>
        <source id="quad-pos">
          <float_array id="quad-pos-arr" count="12">0 0 0 1 0 0 1 1 0 0 1 0</float_array>
          <technique_common><accessor source="#quad-pos-arr" count="4" stride="3"/></technique_common>
        </source>
        <vertices id="quad-vtx"><input semantic="POSITION" source="#quad-pos"/></vertices>
        <polylist count="1"><input semantic="VERTEX" source="#quad-vtx" offset="0"/><vcount>4</vcount><p>0 1 2 3</p></polylist>
      </mesh>
    </geometry>
  </library_geometries>
  <library_controllers>
    <controller id="skin-1" name="Haut"><skin source="#dreieck-geo"/></controller>
  </library_controllers>
  <library_animations>
    <animation id="anim-1" name="Bewegung"><animation id="anim-1-x"/></animation>
  </library_animations>
  <library_cameras><camera id="cam-1" name="Kamera"/></library_cameras>
  <library_lights><light id="licht-1" name="Sonne"/></library_lights>
  <library_visual_scenes>
    <visual_scene id="Szene" name="Szene">
      <node id="wurzel" name="Wurzel" type="NODE">
        <node id="kind" name="Kind" type="NODE">
          <instance_geometry url="#dreieck-geo"/>
          <node id="enkel" name="Enkel" type="JOINT"/>
        </node>
        <instance_camera url="#cam-1"/>
      </node>
      <node id="zweiter" name="Zweiter"><instance_geometry url="#quad-geo"/></node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Szene"/></scene>
</COLLADA>
`;
}

// ---------- Blender (echte Dateien) ----------
const BLENDER_SKRIPT = `
import bpy, sys, os
ziel = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
w1 = bpy.context.active_object
w1.name = 'Wuerfel1'
bpy.ops.mesh.primitive_cube_add(size=2, location=(4, 0, 0))
w2 = bpy.context.active_object
w2.name = 'Wuerfel2'
img = bpy.data.images.new('blender-tex', 4, 4)
img.filepath_raw = os.path.join(ziel, 'blender-tex.png')
img.file_format = 'PNG'
img.save()
mat = bpy.data.materials.new('Holz')
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = img
mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
w1.data.materials.append(mat)
w2.data.materials.append(mat)
bpy.ops.object.select_all(action='SELECT')
def tu(name, fn):
    try:
        fn()
        print('PROBE_OK', name)
    except Exception as e:
        print('PROBE_FEHLER', name, e)
os.makedirs(os.path.join(ziel, 'blender-getrennt'), exist_ok=True)
tu('glb', lambda: bpy.ops.export_scene.gltf(filepath=os.path.join(ziel, 'blender.glb'), export_format='GLB'))
tu('gltf', lambda: bpy.ops.export_scene.gltf(filepath=os.path.join(ziel, 'blender-getrennt', 'blender.gltf'), export_format='GLTF_SEPARATE'))
tu('obj', lambda: bpy.ops.wm.obj_export(filepath=os.path.join(ziel, 'blender.obj')))
tu('stl', lambda: bpy.ops.wm.stl_export(filepath=os.path.join(ziel, 'blender.stl'), ascii_format=False))
tu('stl_ascii', lambda: bpy.ops.wm.stl_export(filepath=os.path.join(ziel, 'blender-ascii.stl'), ascii_format=True))
tu('ply', lambda: bpy.ops.wm.ply_export(filepath=os.path.join(ziel, 'blender.ply'), ascii_format=False))
tu('ply_ascii', lambda: bpy.ops.wm.ply_export(filepath=os.path.join(ziel, 'blender-ascii.ply'), ascii_format=True))
tu('dae', lambda: bpy.ops.wm.collada_export(filepath=os.path.join(ziel, 'blender.dae')))
`;

/**
 * Erzeugt mit Blender (falls vorhanden) echte 3D-Dateien eines Wuerfel-Paares in dir.
 * Bekannte Bauvorgabe: zwei Wuerfel der Kantenlaenge 2 bei x=0 und x=4 -> Bounding-Box
 * min [-1,-1,-1], max [5,1,1] (in allen Formaten, da die Achsen-Umrechnung y/z-symmetrisch ist),
 * 2 Objekte, ein Material "Holz" mit Textur blender-tex.png, 12 Dreiecke je Wuerfel.
 * @returns {Promise<{verfuegbar:boolean, grund?:string, version?:string, pfade:Record<string,string>}>}
 */
export async function erzeugeBlenderProben(dir) {
  const v = spawnSync('blender', ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (v.error || v.status !== 0) return { verfuegbar: false, grund: 'blender nicht gefunden', pfade: {} };
  const version = (v.stdout.split('\n')[0] || '').trim();
  const skript = join(dir, 'blender-probe.py');
  await writeFile(skript, BLENDER_SKRIPT);
  const r = spawnSync('blender', ['--background', '--factory-startup', '--python', skript, '--', dir], { encoding: 'utf8', timeout: 180000 });
  if (r.error || r.status !== 0) return { verfuegbar: false, grund: 'blender-Lauf fehlgeschlagen: ' + (r.error?.message ?? 'exit ' + r.status), pfade: {} };
  const ok = new Set([...r.stdout.matchAll(/PROBE_OK (\w+)/g)].map(m => m[1]));
  const kandidaten = {
    glb: 'blender.glb',
    gltf: join('blender-getrennt', 'blender.gltf'),
    obj: 'blender.obj',
    stl: 'blender.stl',
    stl_ascii: 'blender-ascii.stl',
    ply: 'blender.ply',
    ply_ascii: 'blender-ascii.ply',
    dae: 'blender.dae',
  };
  const pfade = {};
  for (const [k, rel] of Object.entries(kandidaten)) {
    if (!ok.has(k)) continue;
    const p = join(dir, rel);
    try {
      if ((await stat(p)).size > 0) pfade[k] = p;
    } catch {
      /* Export fehlt: Test ueberspringt */
    }
  }
  return { verfuegbar: Object.keys(pfade).length > 0, version, pfade };
}

// ---------- Hauptfunktion ----------
/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird ein neues unter os.tmpdir() angelegt.
 * @returns {Promise<{dir:string, pfade:Record<string,string>, aufraeumen:()=>Promise<void>}>}
 */
export async function erzeugeFixtures3d(ziel) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-asset-3d-')));
  await mkdir(join(dir, 'sub ordner'), { recursive: true });

  const bin = dreieckBin();
  const glbOk = glbBauen(gltfDreieckJson(null), bin);
  const tiefJson = '['.repeat(20000);
  const verschachtelteDae = '<?xml version="1.0"?><COLLADA version="1.4.1">' + '<a>'.repeat(5000);

  const dateien = {
    // Hilfsdateien, auf die verwiesen wird
    textur: ['textur.png', PNG_KOPF],
    dreieckBin: ['dreieck.bin', bin],
    subTextur: [join('sub ordner', 'tex eins.png'), PNG_KOPF],
    mtl: ['dreieck.mtl', 'newmtl Rot\nKd 1 0 0\nmap_Kd textur.png\nnewmtl Blau\nKd 0 0 1\n'],

    // glTF / GLB
    gltfDreieck: ['dreieck.gltf', JSON.stringify(gltfDreieckJson('dreieck.bin'), null, 2)],
    glbDreieck: ['dreieck.glb', glbOk],
    gltfSzene: ['szene.gltf', JSON.stringify(gltfSzeneJson())],
    gltfReferenzen: ['referenzen.gltf', JSON.stringify(gltfReferenzenJson())],
    gltfKaputt: ['kaputt.gltf', JSON.stringify(gltfDreieckJson('dreieck.bin')).slice(0, 120)],
    gltfLeer: ['leer.gltf', Buffer.alloc(0)],
    gltfKeinObjekt: ['array.gltf', '[1,2,3]'],
    gltfBoese: ['boese.gltf', JSON.stringify({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ children: [1], mesh: 0 }, { children: [0] }, { mesh: 99 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }, { attributes: { POSITION: -1 } }, { attributes: { POSITION: 7 }, indices: 'x' }] }],
      accessors: [{ count: 1e15, min: [0, 0, 0], max: [1, 1, 1] }, { count: -5 }, { bufferView: 0, componentType: 5126, type: 'VEC3', count: 1000000 }],
      bufferViews: [{ buffer: 0, byteLength: 12 }],
      materials: [{ normalTexture: { index: 40 } }],
      textures: [{ source: 70 }],
      buffers: [{ byteLength: 'viel' }],
    })],
    gltfTief: ['tief.gltf', '{"asset":{"version":"2.0"},"x":' + tiefJson + ']'.repeat(20000) + '}'],
    gltfTiefOffen: ['tiefoffen.gltf', '{"asset":{"version":"2.0"},"x":' + tiefJson],
    gltfBom: ['bom.gltf', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(gltfDreieckJson('dreieck.bin')))])],
    glbAbgeschnitten: ['abgeschnitten.glb', glbOk.subarray(0, glbOk.length - 20)],
    glbNurKopf: ['nurkopf.glb', glbOk.subarray(0, 10)],
    glbJsonKaputt: ['jsonkaputt.glb', (() => {
      const j = Buffer.from('{"asset": {"version": "2.0"', 'utf8');
      const jp = pad4(j, 0x20);
      return Buffer.concat([Buffer.from('glTF'), u32le(2), u32le(12 + 8 + jp.length), u32le(jp.length), Buffer.from('JSON'), jp]);
    })()],
    glbOhneJson: ['ohnejson.glb', (() => {
      const b = pad4(bin, 0);
      return Buffer.concat([Buffer.from('glTF'), u32le(2), u32le(12 + 8 + b.length), u32le(b.length), Buffer.from([0x42, 0x49, 0x4e, 0x00]), b]);
    })()],
    glbV1: ['v1.glb', Buffer.concat([Buffer.from('glTF'), u32le(1), u32le(20), Buffer.alloc(8)])],
    glbChunkBoese: ['chunkboese.glb', Buffer.concat([Buffer.from('glTF'), u32le(2), u32le(0xffffffff), u32le(0xfffffff0), Buffer.from('JSON'), Buffer.alloc(16, 0x20)])],
    glbVieleChunks: ['vielechunks.glb', (() => {
      const teile = [];
      for (let i = 0; i < 100; i++) teile.push(Buffer.concat([u32le(0), Buffer.from([0x58, 0x58, 0x58, 0x58])]));
      const body = Buffer.concat(teile);
      return Buffer.concat([Buffer.from('glTF'), u32le(2), u32le(12 + body.length), body]);
    })()],
    glbAlsGltf: ['glbalsgltf.gltf', glbOk],
    jsonAlsGlb: ['jsonalsglb.glb', JSON.stringify(gltfDreieckJson('dreieck.bin'))],
    textAlsGlb: ['textalsglb.glb', 'das ist kein glTF'],

    // OBJ
    objDreieck: ['dreieck.obj', OBJ_DREIECK],
    objWuerfel: ['wuerfel.obj', objWuerfel()],
    objViele: ['viele.obj', (() => {
      const z = [];
      for (let i = 0; i < 300; i++) z.push(`o Objekt${i}`, 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', `f ${i * 3 + 1} ${i * 3 + 2} ${i * 3 + 3}`);
      return z.join('\n') + '\n';
    })()],
    objBinaer: ['binaer.obj', PNG_KOPF],
    objLeer: ['leer.obj', Buffer.alloc(0)],
    objMuell: ['muell.obj', 'Das ist ein Brief.\nLiebe Gruesse\nund so weiter\n'],
    objNurKommentare: ['kommentare.obj', '# nichts\n# gar nichts\n'],
    objBoeseIndizes: ['indizes.obj', 'v 0 0 0\nv 1 1 1\nf 1 2 99\nf 0 1 2\nf -9 1 2\nf a b c\nv x y z\nv 1e999 0 0\n'],
    objLangeZeile: ['langezeile.obj', Buffer.concat([Buffer.from('v 0 0 0\n# '), Buffer.alloc(2 * 1024 * 1024, 0x61)])],
    objOhneEndzeile: ['ohneende.obj', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'],

    // STL
    stlAscii: ['wuerfel-ascii.stl', stlAscii('wuerfel', WUERFEL_T)],
    stlBinaer: ['wuerfel-binaer.stl', stlBinaer('Binaer-Fixture', WUERFEL_T)],
    stlBinaerSolid: ['solid-binaer.stl', stlBinaer('solid binaerkopf-der-wie-ascii-aussieht', WUERFEL_T)],
    stlBinaerAbgeschnitten: ['abgeschnitten.stl', stlBinaer('x', WUERFEL_T).subarray(0, 84 + 50 * 5 + 17)],
    stlBinaerUeberhang: ['ueberhang.stl', Buffer.concat([stlBinaer('x', WUERFEL_T), Buffer.alloc(33)])],
    stlBoese: ['boese.stl', stlBinaer('x', WUERFEL_T.slice(0, 2), 0xffffffff)],
    stlNull: ['nulldreiecke.stl', stlBinaer('leer', [])],
    stlLeer: ['leer.stl', Buffer.alloc(0)],
    stlMuell: ['muell.stl', 'hello world'],
    stlAsciiAbgeschnitten: ['ascii-abgeschnitten.stl', stlAscii('wuerfel', WUERFEL_T).split('\n').slice(0, 30).join('\n')],
    stlAsciiMehrere: ['mehrere.stl', stlAscii('eins', WUERFEL_T.slice(0, 4)) + stlAscii('zwei', WUERFEL_T.slice(4, 6))],
    stlNan: ['nan.stl', (() => {
      const b = stlBinaer('nan', WUERFEL_T.slice(0, 2));
      b.writeFloatLE(NaN, 84 + 12);
      return b;
    })()],

    // PLY
    plyAscii: ['wuerfel-ascii.ply', plyAscii()],
    plyBinaerLE: ['wuerfel-le.ply', plyBinaer(true)],
    plyBinaerBE: ['wuerfel-be.ply', plyBinaer(false)],
    plyFaceZuerst: ['face-zuerst.ply', plyBinaer(true, true)],
    plyBinaerAbgeschnitten: ['abgeschnitten.ply', plyBinaer(true).subarray(0, plyBinaer(true).length - 40)],
    plyBoese: ['boese.ply', Buffer.concat([Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 4000000000\nproperty float x\nproperty float y\nproperty float z\nend_header\n'), Buffer.alloc(24)])],
    plyKaputt: ['kaputt.ply', 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\n'],
    plyOhneMagic: ['ohnemagic.ply', 'Dies ist keine PLY-Datei\n'],
    plyLeer: ['leer.ply', Buffer.alloc(0)],
    plyTypUnbekannt: ['typ.ply', 'ply\nformat ascii 1.0\nelement vertex 1\nproperty quatsch x\nproperty float y\nproperty float z\nend_header\n1 2 3\n'],
    plyAsciiKurz: ['kurz.ply', 'ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n'],

    // DAE
    daeSzene: ['szene.dae', daeSzene()],
    daeAbgeschnitten: ['abgeschnitten.dae', daeSzene().slice(0, 1500)],
    daeTief: ['tief.dae', verschachtelteDae],
    daeMuell: ['muell.dae', 'Das ist kein XML'],
    daeAnderesXml: ['anderes.dae', '<?xml version="1.0"?><html><body>hallo</body></html>'],
    daeLeer: ['leer.dae', Buffer.alloc(0)],
    daeLangesTag: ['langestag.dae', '<?xml version="1.0"?><COLLADA version="1.4.1"><a ' + 'x="'.padEnd(2 * 1024 * 1024, 'y')],
  };

  const pfade = {};
  for (const [schluessel, [name, inhalt]] of Object.entries(dateien)) {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
  }
  return { dir, pfade, aufraeumen: () => rm(dir, { recursive: true, force: true }), konstanten: { WUERFEL_V, WUERFEL_T } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade } = await erzeugeFixtures3d();
  console.log(dir);
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
  const b = await erzeugeBlenderProben(dir);
  console.log('Blender:', b.verfuegbar ? b.version : b.grund);
  for (const [k, p] of Object.entries(b.pfade)) console.log(`  ${k}: ${p}`);
}
