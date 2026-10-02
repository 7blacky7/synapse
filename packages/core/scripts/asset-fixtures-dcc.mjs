/**
 * Fixture-Generator fuer die DCC-Inspektoren (P4-T62): .blend, .fbx, .usda, .usdc, .usdz.
 *
 * erzeugeDccFixtures(): HANDGEBAUTE Dateien nach Spezifikation, DETERMINISTISCH, in os.tmpdir().
 *   Das sind Spec-Fixtures: sie belegen, dass der Leser die Spezifikation so umsetzt, wie WIR sie
 *   verstehen — nicht, dass echte Dateien so aussehen.
 * erzeugeEchteDccFixtures(dir): ECHTE Dateien, wenn die Werkzeuge da sind (blender, usdcat, usdzip).
 *   Es wird nichts installiert; fehlt ein Werkzeug, fehlt der Eintrag (Tests ueberspringen dann).
 *
 * AUFRUF: node packages/core/scripts/asset-fixtures-dcc.mjs [--echt]
 * Es werden KEINE Binaerdateien eingecheckt.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

// ---------------------------------------------------------------- Byte-Helfer

const u8 = n => Buffer.from([n & 0xff]);
function u16(n, le = true) { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; }
function i16(n, le = true) { const b = Buffer.alloc(2); le ? b.writeInt16LE(n) : b.writeInt16BE(n); return b; }
function u32(n, le = true) { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0); return b; }
function i32(n, le = true) { const b = Buffer.alloc(4); le ? b.writeInt32LE(n) : b.writeInt32BE(n); return b; }
function u64(n, le = true) { const b = Buffer.alloc(8); le ? b.writeBigUInt64LE(BigInt(n)) : b.writeBigUInt64BE(BigInt(n)); return b; }
function i64(n, le = true) { const b = Buffer.alloc(8); le ? b.writeBigInt64LE(BigInt(n)) : b.writeBigInt64BE(BigInt(n)); return b; }
function f64(n) { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; }
const ascii = s => Buffer.from(s, 'latin1');
function cfeld(s, n) { const b = Buffer.alloc(n); Buffer.from(s, 'utf8').copy(b, 0, 0, n - 1); return b; }
const ausrichten4 = b => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

// ---------------------------------------------------------------- .blend (Spec)

/**
 * Minimale .blend im ALTEN Format (Kopf 'BLENDER' + '_'/'-' + 'v'/'V' + '293', BHead4/BHead8)
 * oder im NEUEN Format ('BLENDER17-01v0501', LargeBHead8) mit eigenem SDNA.
 */
export function blendSpec({ zeiger = 8, le = true, neu = false } = {}) {
  const P = neu ? 8 : zeiger;
  // SDNA-Typen: Name -> Groesse (Strukturen werden berechnet).
  const namen = [];
  const nameIdx = n => { let i = namen.indexOf(n); if (i < 0) { namen.push(n); i = namen.length - 1; } return i; };
  const typen = ['char', 'short', 'int', 'void', 'float', 'ID', 'Library', 'Object', 'Mesh', 'Image', 'Scene', 'RenderData'];
  const basis = { char: 1, short: 2, int: 4, void: 0, float: 4 };
  const strukturen = [
    ['ID', [['void', '*next'], ['void', '*prev'], ['Library', '*lib'], ['char', 'name[66]'], ['short', 'flag']]],
    ['Library', [['ID', 'id'], ['char', 'name[1024]']]],
    ['Object', [['ID', 'id'], ['short', 'type'], ['short', 'pad'], ['Object', '*parent'], ['void', '*data']]],
    ['Mesh', [['ID', 'id'], ['int', 'totvert'], ['int', 'totpoly']]],
    ['Image', [['ID', 'id'], ['short', 'source'], ['short', 'pad'], ['char', 'name[1024]']]],
    ['RenderData', [['int', 'sfra'], ['int', 'efra'], ['short', 'frs_sec'], ['short', 'pad']]],
    ['Scene', [['ID', 'id'], ['RenderData', 'r'], ['Object', '*camera']]],
  ];
  const groesse = {};
  const feldGroesse = (t, n) => {
    let g = n.startsWith('*') ? P : basis[t] ?? groesse[t];
    for (const m of n.matchAll(/\[(\d+)\]/g)) g *= Number(m[1]);
    return g;
  };
  for (const [t, felder] of strukturen) groesse[t] = felder.reduce((s, [ft, fn]) => s + feldGroesse(ft, fn), 0);
  const tlen = typen.map(t => basis[t] ?? groesse[t]);
  const strc = strukturen.map(([t, felder]) => Buffer.concat([
    i16(typen.indexOf(t), le), i16(felder.length, le),
    ...felder.map(([ft, fn]) => Buffer.concat([i16(typen.indexOf(ft), le), i16(nameIdx(fn), le)])),
  ]));
  const nameBytes = ausrichten4(Buffer.concat(namen.map(n => Buffer.from(n + '\0', 'latin1'))));
  const dna = Buffer.concat([
    ascii('SDNA'), ascii('NAME'), i32(namen.length, le), nameBytes,
    ascii('TYPE'), i32(typen.length, le), ausrichten4(Buffer.concat(typen.map(t => Buffer.from(t + '\0', 'latin1')))),
    ascii('TLEN'), ausrichten4(Buffer.concat(tlen.map(x => u16(x, le)))),
    ascii('STRC'), i32(strukturen.length, le), ...strc,
  ]);
  const sdna = t => strukturen.findIndex(([n]) => n === t);
  const zg = v => (P === 8 ? u64(v, le) : u32(v, le));
  const id = (code, name, lib = 0) => Buffer.concat([zg(0), zg(0), zg(lib), cfeld(code + name, 66), i16(0, le)]);
  const bloecke = [
    ['SC', 0x1000, sdna('Scene'), Buffer.concat([id('SC', 'Szene'), i32(10, le), i32(90, le), i16(30, le), i16(0, le), zg(0x2000)])],
    ['OB', 0x2000, sdna('Object'), Buffer.concat([id('OB', 'Kamera'), i16(11, le), i16(0, le), zg(0x2100), zg(0)])],
    ['OB', 0x2100, sdna('Object'), Buffer.concat([id('OB', 'Elternteil'), i16(1, le), i16(0, le), zg(0), zg(0x3000)])],
    ['ME', 0x3000, sdna('Mesh'), Buffer.concat([id('ME', 'Netz'), i32(8, le), i32(6, le)])],
    ['IM', 0x4000, sdna('Image'), Buffer.concat([id('IM', 'Bild'), i16(1, le), i16(0, le), cfeld('//tex/fehlt.png', 1024)])],
    ['LI', 0x5000, sdna('Library'), Buffer.concat([id('LI', 'lib.blend'), cfeld('//lib_fehlt.blend', 1024)])],
    ['ID', 0x6000, sdna('ID'), id('OB', 'Verknuepft', 0x5000)],
    ['DATA', 0x7000, 0, Buffer.alloc(16)],
    ['DNA1', 0x8000, 0, dna],
  ];
  const code4 = c => Buffer.concat([ascii(c), Buffer.alloc(4 - c.length)]);
  const kopfBlock = (code, old, sd, len) => {
    if (neu) return Buffer.concat([code4(code), i32(sd, le), u64(old, le), i64(len, le), i64(1, le)]);
    if (P === 8) return Buffer.concat([code4(code), i32(len, le), u64(old, le), i32(sd, le), i32(1, le)]);
    return Buffer.concat([code4(code), i32(len, le), u32(old, le), i32(sd, le), i32(1, le)]);
  };
  const teile = [ascii(neu ? `BLENDER17-01${le ? 'v' : 'V'}0501` : `BLENDER${P === 8 ? '-' : '_'}${le ? 'v' : 'V'}293`)];
  for (const [code, old, sd, daten] of bloecke) teile.push(kopfBlock(code, old, sd, daten.length), daten);
  teile.push(kopfBlock('ENDB', 0, 0, 0));
  return Buffer.concat(teile);
}

// ---------------------------------------------------------------- FBX binaer (Spec)

const P = {
  S: s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([ascii('S'), u32(b.length), b]); },
  I: n => Buffer.concat([ascii('I'), i32(n)]),
  D: n => Buffer.concat([ascii('D'), f64(n)]),
  L: n => Buffer.concat([ascii('L'), i64(n)]),
  Y: n => Buffer.concat([ascii('Y'), i16(n)]),
  C: b => Buffer.concat([ascii('C'), u8(b ? 1 : 0)]),
  R: b => Buffer.concat([ascii('R'), u32(b.length), b]),
  /** Array: typ f/d/l/i/b, werte, komprimiert (zlib, Kodierung 1). */
  A: (typ, werte, komprimiert = false) => {
    const elem = { f: 4, d: 8, l: 8, i: 4, b: 1 }[typ];
    const roh = Buffer.alloc(werte.length * elem);
    werte.forEach((v, k) => {
      if (typ === 'd') roh.writeDoubleLE(v, k * 8); else if (typ === 'f') roh.writeFloatLE(v, k * 4);
      else if (typ === 'i') roh.writeInt32LE(v, k * 4); else if (typ === 'l') roh.writeBigInt64LE(BigInt(v), k * 8);
      else roh[k] = v;
    });
    const daten = komprimiert ? zlib.deflateSync(roh) : roh;
    return Buffer.concat([ascii(typ), u32(werte.length), u32(komprimiert ? 1 : 0), u32(daten.length), daten]);
  },
  /** Roh-Arraykopf mit frei waehlbarer Laenge (boesartige Fixtures). */
  ArrayKopf: (typ, laenge, kodierung, daten) => Buffer.concat([ascii(typ), u32(laenge), u32(kodierung), u32(daten.length), daten]),
};

/** Knoten: [name, props[], kinder[]] */
function fbxKnoten(k, start, breit) {
  const [name, props = [], kinder = []] = k;
  const hs = breit ? 25 : 13;
  const pb = Buffer.concat(props);
  const nb = ascii(name);
  let pos = start + hs + nb.length + pb.length;
  const kb = [];
  for (const c of kinder) { const b = fbxKnoten(c, pos, breit); kb.push(b); pos += b.length; }
  if (kinder.length) { kb.push(Buffer.alloc(hs)); pos += hs; }
  const zahl = v => (breit ? u64(v) : u32(v));
  return Buffer.concat([zahl(pos), zahl(props.length), zahl(pb.length), u8(nb.length), nb, pb, ...kb]);
}

export function fbxDatei(baum, version = 7400) {
  const breit = version >= 7500;
  const kopf = Buffer.concat([ascii('Kaydara FBX Binary  '), Buffer.from([0, 0x1a, 0]), u32(version)]);
  const teile = [kopf];
  let pos = kopf.length;
  for (const k of baum) { const b = fbxKnoten(k, pos, breit); teile.push(b); pos += b.length; }
  teile.push(Buffer.alloc(breit ? 25 : 13));
  teile.push(Buffer.alloc(16, 0xfa)); // Fusszeile (Inhalt egal fuer den Leser)
  return Buffer.concat(teile);
}

/**
 * zstd-Frame aus einem einzigen Roh-Block (RFC 8878): Magic, Frame-Header (Single-Segment,
 * 4-Byte-Inhaltsgroesse), Blockkopf (letzter Block, Typ 0 = roh, Groesse), Daten. Braucht keinen
 * Kompressor und ist damit unter jeder Node-Version erzeugbar. Daten hoechstens 128 KiB.
 */
export function zstdRohFrame(daten) {
  if (daten.length > 128 * 1024) throw new Error('Roh-Block hoechstens 128 KiB');
  const kopf = (daten.length << 3) | 1;
  return Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0]),
    u32(daten.length),
    Buffer.from([kopf & 0xff, (kopf >> 8) & 0xff, (kopf >> 16) & 0xff]),
    daten,
  ]);
}

const WUERFEL = [-1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1];

export function fbxSpecBaum({ komprimiert = false } = {}) {
  const pP = (n, t, ...werte) => ['P', [P.S(n), P.S(t), P.S(''), P.S('A'), ...werte]];
  return [
    ['FBXHeaderExtension', [], [
      ['FBXHeaderVersion', [P.I(1003)]],
      ['FBXVersion', [P.I(7400)]],
      ['CreationTimeStamp', [], [['Version', [P.I(1000)]], ['Year', [P.I(2026)]], ['Month', [P.I(10)]], ['Day', [P.I(2)]], ['Hour', [P.I(12)]], ['Minute', [P.I(30)]], ['Second', [P.I(5)]]]],
      ['Creator', [P.S('Synapse Spec-Fixture')]],
    ]],
    ['CreationTime', [P.S('2026-10-02 12:30:05:000')]],
    ['GlobalSettings', [], [['Version', [P.I(1000)]], ['Properties70', [], [
      pP('UpAxis', 'int', P.I(1)),
      pP('FrontAxis', 'int', P.I(2)),
      pP('UnitScaleFactor', 'double', P.D(2.54)),
    ]]]],
    ['Objects', [], [
      ['Geometry', [P.L(100), P.S('Wuerfel\0\x01Geometry'), P.S('Mesh')], [
        ['Vertices', [P.A('d', WUERFEL, komprimiert)]],
        ['PolygonVertexIndex', [P.A('i', [0, 1, 3, -3, 4, 5, 7, -7], komprimiert)]],
      ]],
      ['Model', [P.L(200), P.S('Wuerfel\0\x01Model'), P.S('Mesh')], [
        ['Version', [P.I(232)]],
        ['Properties70', [], [pP('Lcl Translation', 'Lcl Translation', P.D(1), P.D(2), P.D(3))]],
      ]],
      ['Model', [P.L(201), P.S('Knochen\0\x01Model'), P.S('LimbNode')]],
      ['Material', [P.L(300), P.S('Holz\0\x01Material'), P.S('')]],
      ['Texture', [P.L(400), P.S('HolzTex\0\x01Texture'), P.S('')], [
        ['FileName', [P.S('/gibt/es/nicht/holz.png')]],
        ['RelativeFilename', [P.S('tex/holz_fehlt.png')]],
      ]],
      ['Video', [P.L(500), P.S('HolzVid\0\x01Video'), P.S('Clip')], [
        ['RelativeFilename', [P.S('tex/vorhanden.png')]],
        ['Content', [P.R(Buffer.from('PNGDATEN'))]],
      ]],
      ['AnimationStack', [P.L(600), P.S('Lauf\0\x01AnimStack'), P.S('')]],
      ['Deformer', [P.L(700), P.S('Haut\0\x01Deformer'), P.S('Skin')]],
      ['Pose', [P.L(800), P.S('Bind\0\x01Pose'), P.S('BindPose')]],
    ]],
    ['Connections', [], [
      ['C', [P.S('OO'), P.L(100), P.L(200)]],
      ['C', [P.S('OO'), P.L(200), P.L(0)]],
      ['C', [P.S('OO'), P.L(300), P.L(200)]],
    ]],
  ];
}

const FBX_ASCII = `; FBX 7.4.0 project file
; Synapse Spec-Fixture (ASCII)
; ----------------------------------------------------

FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
	CreationTimeStamp:  {
		Version: 1000
		Year: 2026
		Month: 10
		Day: 2
		Hour: 8
		Minute: 15
		Second: 0
	}
	Creator: "Synapse ASCII-Fixture"
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",2
		P: "UnitScaleFactor", "double", "Number", "",100
	}
}
Objects:  {
	Geometry: 100, "Geometry::Wuerfel", "Mesh" {
		Vertices: *24 {
			a: -1,-1,-1,1,-1,-1,-1,1,-1,1,1,-1,-1,-1,1,1,-1,1,-1,1,1,1,1,1
		} 
		PolygonVertexIndex: *8 {
			a: 0,1,3,-3,4,5,7,-7
		} 
	}
	Model: 200, "Model::Wuerfel", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",4,5,6
		}
	}
	Texture: 400, "Texture::HolzTex", "" {
		FileName: "C:\\Projekte\\fehlt\\holz.png"
		RelativeFilename: "tex\\vorhanden.png"
	}
}
Connections:  {
	C: "OO",100,200
	C: "OO",200,0
}
`;

const FBX_ASCII_61 = `; FBX 6.1.0 project file
; ----------------------------------------------------

Objects:  {
	Model: "Model::Alt", "Mesh" {
		Vertices: 0,0,0,1,0,0,
		 0,1,0,1,1,0
		PolygonVertexIndex: 0,1,-3
	}
	Material: "Material::Lack", "" {
	}
}
Connections:  {
	Connect: "OO", "Model::Alt", "Model::Scene"
}
`;

// ---------------------------------------------------------------- USD (Spec)

const USDA_REICH = `#usda 1.0
(
    doc = """Spec-Fixture mit { geschweiften } und ( runden ) Klammern im Text"""
    defaultPrim = "Welt"
    metersPerUnit = 0.01
    upAxis = "Y"
    startTimeCode = 1
    endTimeCode = 240
    timeCodesPerSecond = 24
    subLayers = [
        @./sub_fehlt.usda@ (offset = 10),
        @./ref.usda@
    ]
)

# Kommentar mit Klammern { [ ( die nichts bedeuten
class "_Basis"
{
}

def Xform "Welt" (
    kind = "assembly"
    variants = {
        string farbe = "rot"
    }
    prepend variantSets = "farbe"
)
{
    def "Kiste" (
        prepend references = @./ref.usda@</Ziel>
        payload = @./schwer_fehlt.usd@
        inherits = </_Basis>
        prepend apiSchemas = ["MaterialBindingAPI", "CollisionAPI"]
    )
    {
        string notiz = "Text mit } und @ und # darin"
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0)]
        int[] faceVertexCounts = [4]
        rel material:binding = </Welt/Looks/Holz>
        float3 xformOp:translate.timeSamples = {
            1: (0, 0, 0),
            240: (0, 5, 0),
        }
    }

    def Scope "Looks"
    {
        def Material "Holz"
        {
            def Shader "Bild"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./tex/fehlt.png@
                asset inputs:fallback = @../aussen/textur.png@
            }
        }
    }

    variantSet "farbe" = {
        "rot" {
            def Mesh "RotGeo"
            {
            }
        }
        "blau" (
            doc = "blaue Variante"
        ) {
            def Mesh "BlauGeo"
            {
            }
        }
    }

    over "Ueberschrieben"
    {
    }
}
`;

const USDA_REF = `#usda 1.0
(
    defaultPrim = "Ziel"
)

def Xform "Ziel"
{
}
`;

/** usdc-Kopf + TOC nach Spezifikation (Crate-Inhalt Platzhalter). */
export function usdcSpec({ tocKaputt = false, abschnittKaputt = false } = {}) {
  const namen = ['TOKENS', 'STRINGS', 'FIELDS', 'FIELDSETS', 'PATHS', 'SPECS'];
  const inhalt = Buffer.alloc(namen.length * 16, 0x11);
  const kopf = Buffer.alloc(88);
  kopf.write('PXR-USDC', 0, 'latin1');
  kopf[8] = 0; kopf[9] = 8; kopf[10] = 0;
  const tocOff = 88 + inhalt.length;
  kopf.writeBigInt64LE(BigInt(tocKaputt ? 10_000_000 : tocOff), 16);
  const toc = [u64(namen.length)];
  namen.forEach((n, k) => {
    const nb = Buffer.alloc(16); nb.write(n, 0, 'latin1');
    const start = 88 + k * 16;
    toc.push(nb, i64(start), i64(abschnittKaputt && k === 5 ? 99_999 : 16));
  });
  return Buffer.concat([kopf, inhalt, ...toc]);
}

// ---------------------------------------------------------------- Zip/USDZ (Spec)

const CRC_TAB = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC_TAB[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/**
 * Zip-Schreiber. eintraege: [{name, daten, methode?:0|8, ausrichten?:bool, verschluesselt?:bool}].
 * ausrichten (Standard true) polstert das Extra-Feld so, dass die Daten auf 64 Byte liegen.
 */
export function zipDatei(eintraege, { zip64Marke = false } = {}) {
  const lokal = [];
  const zentral = [];
  let pos = 0;
  for (const e of eintraege) {
    const name = Buffer.from(e.name, 'utf8');
    const methode = e.methode ?? 0;
    const daten = methode === 8 ? zlib.deflateRawSync(e.daten) : e.daten;
    let extra = Buffer.alloc(0);
    if (e.ausrichten !== false) {
      const roh = pos + 30 + name.length;
      const pad = (64 - (roh % 64)) % 64;
      if (pad > 0) extra = Buffer.alloc(pad < 4 ? pad + 64 : pad);
      if (extra.length >= 4) { extra.writeUInt16LE(0x1986, 0); extra.writeUInt16LE(extra.length - 4, 2); }
    } else if ((pos + 30 + name.length) % 64 === 0) {
      extra = Buffer.from([0x99, 0x99, 0x01, 0x00, 0x00]); // absichtlich nicht ausgerichtet
    }
    const flags = (e.verschluesselt ? 1 : 0) | 0x800;
    const crc = crc32(e.daten);
    const lh = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(methode), u16(0), u16(0x5521), u32(crc), u32(daten.length), u32(e.daten.length), u16(name.length), u16(extra.length), name, extra]);
    zentral.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(flags), u16(methode), u16(0), u16(0x5521), u32(crc), u32(daten.length), u32(e.daten.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(pos), name]));
    lokal.push(lh, daten);
    pos += lh.length + daten.length;
  }
  const cd = Buffer.concat(zentral);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(eintraege.length), u16(zip64Marke ? 0xffff : eintraege.length), u32(cd.length), u32(zip64Marke ? 0xffffffff : pos), u16(0)]);
  return Buffer.concat([...lokal, cd, eocd]);
}

const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');

// ---------------------------------------------------------------- Hauptfunktion

/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird eines unter os.tmpdir() angelegt.
 * @returns {Promise<{dir:string, pfade:Record<string,string>, aufraeumen:()=>Promise<void>}>}
 */
export async function erzeugeDccFixtures(ziel) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-asset-dcc-')));
  await mkdir(join(dir, 'tex'), { recursive: true });
  await writeFile(join(dir, 'tex', 'vorhanden.png'), PNG_1x1);

  const blend64 = blendSpec({ zeiger: 8 });
  const fbx = fbxDatei(fbxSpecBaum());
  // 2 zstd-Frames hintereinander wie bei Blender (falls diese Node-Version zstd kann).
  const zstdKomp = typeof zlib.zstdCompressSync === 'function'
    ? Buffer.concat([zlib.zstdCompressSync(blend64.subarray(0, 200)), zlib.zstdCompressSync(blend64.subarray(200))])
    : null;
  // Block "ME" auf absurde Laenge setzen (Laengenangabe weit ueber der Datei).
  const blendBoese = Buffer.from(blend64);
  const me = blendBoese.indexOf(Buffer.from('ME\0\0', 'latin1'));
  blendBoese.writeInt32LE(0x7fffff00, me + 4);
  // FBX: Knoten-Ende zeigt hinter die Datei.
  const fbxBoese = Buffer.from(fbx);
  const obj = fbxBoese.indexOf(Buffer.from('Objects', 'latin1'));
  fbxBoese.writeUInt32LE(0x7ffffff0, obj - 13);
  // FBX: Tiefenbombe (100 verschachtelte Knoten).
  let bombe = ['Blatt', [P.I(1)]];
  for (let k = 0; k < 100; k++) bombe = ['N' + k, [], [bombe]];
  // FBX: riesige Array-Deklaration (2^30 Elemente bei 12 Bytes Daten).
  const fbxRiesig = fbxDatei([['Objects', [], [['Geometry', [P.L(1), P.S('Riese\0\x01Geometry'), P.S('Mesh')], [
    ['Vertices', [P.ArrayKopf('d', 0x40000000, 1, zlib.deflateSync(Buffer.alloc(8)))]],
    ['PolygonVertexIndex', [P.ArrayKopf('i', 0x40000000, 0, Buffer.alloc(8))]],
  ]]]]]);

  // USDA-Boesartigkeiten.
  let tief = '#usda 1.0\n';
  for (let k = 0; k < 200; k++) tief += `def "T${k}" {\n`;
  for (let k = 0; k < 200; k++) tief += '}\n';
  const riesig = '#usda 1.0\ndef Mesh "Gross"\n{\n    point3f[] points = [' + Array.from({ length: 100_000 }, (_, k) => `(${k}, 0, 0)`).join(', ') + ']\n}\n';
  let viele = '#usda 1.0\n';
  for (let k = 0; k < 50; k++) viele += `def "P${k}" {\n}\n`;

  const layerUsda = Buffer.from(USDA_REICH.replace('@./ref.usda@\n', '@./ref.usda@\n'), 'utf8');
  const paketLayer = Buffer.from('#usda 1.0\n(\n    defaultPrim = "Kiste"\n)\ndef Xform "Kiste"\n{\n    def Shader "Bild"\n    {\n        asset inputs:file = @./tex/farbe.png@\n        asset inputs:normal = @./tex/fehlt_im_paket.png@\n    }\n}\n', 'utf8');

  const dateien = {
    blend64: ['spec64.blend', blend64],
    blend32: ['spec32.blend', blendSpec({ zeiger: 4 })],
    blendBE: ['specbe.blend', blendSpec({ zeiger: 8, le: false })],
    blendNeu: ['specneu.blend', blendSpec({ neu: true })],
    blendGzip: ['specgz.blend', zlib.gzipSync(blend64, { level: 6 })],
    ...(zstdKomp ? { blendZstd: ['speczstd.blend', zstdKomp] } : {}),
    // Gueltiger zstd-Frame mit EINEM Roh-Block (handgebaut, unabhaengig von der Node-Version).
    blendZstdRoh: ['speczstdroh.blend', zstdRohFrame(blend64)],
    blendAbgeschnitten: ['abgeschnitten.blend', blend64.subarray(0, Math.floor(blend64.length / 2))],
    blendBoese: ['boese.blend', blendBoese],
    blendUnbekannt: ['unbekannt.blend', Buffer.concat([ascii('BLENDER17-02v0600'), Buffer.alloc(64)])],
    blendLeer: ['leer.blend', Buffer.alloc(0)],
    fbx7400: ['spec7400.fbx', fbx],
    fbx7500: ['spec7500.fbx', fbxDatei(fbxSpecBaum(), 7500)],
    fbxKomprimiert: ['speckomp.fbx', fbxDatei(fbxSpecBaum({ komprimiert: true }), 7700)],
    fbxAbgeschnitten: ['abgeschnitten.fbx', fbx.subarray(0, Math.floor(fbx.length * 0.6))],
    fbxBoese: ['boese.fbx', fbxBoese],
    fbxBombe: ['bombe.fbx', fbxDatei([bombe])],
    fbxRiesig: ['riesig.fbx', fbxRiesig],
    fbxAscii: ['ascii.fbx', Buffer.from(FBX_ASCII, 'utf8')],
    fbxAscii61: ['ascii61.fbx', Buffer.from(FBX_ASCII_61, 'utf8')],
    fbxAsciiOffen: ['ascii_offen.fbx', Buffer.from(FBX_ASCII.slice(0, FBX_ASCII.indexOf('Connections')) + 'Objects:  {\n\tModel: 9, "Model::Offen", "Null" {\n', 'utf8')],
    fbxAlsBlend: ['fbx_inhalt.blend', fbx],
    usda: ['reich.usda', layerUsda],
    usdaRef: ['ref.usda', Buffer.from(USDA_REF, 'utf8')],
    usdaAlsUsd: ['text.usd', layerUsda],
    usdaOffen: ['offen.usda', Buffer.from(USDA_REICH.slice(0, USDA_REICH.lastIndexOf('}')), 'utf8')],
    usdaTief: ['tief.usda', Buffer.from(tief, 'utf8')],
    usdaRiesig: ['riesig.usda', Buffer.from(riesig, 'utf8')],
    usdaArrayOffen: ['array_offen.usda', Buffer.from('#usda 1.0\ndef Mesh "M"\n{\n    point3f[] points = [(0,0,0), (1,1,1)', 'utf8')],
    usdaViele: ['viele.usda', Buffer.from(viele, 'utf8')],
    usdaOhneKopf: ['ohnekopf.usda', Buffer.from('def "X" {}\n', 'utf8')],
    usdc: ['spec.usdc', usdcSpec()],
    usdcAlsUsd: ['crate.usd', usdcSpec()],
    usdcTocKaputt: ['tockaputt.usdc', usdcSpec({ tocKaputt: true })],
    usdcAbschnittKaputt: ['abschnittkaputt.usdc', usdcSpec({ abschnittKaputt: true })],
    usdcAbgeschnitten: ['abgeschnitten.usdc', usdcSpec().subarray(0, 20)],
    usdz: ['spec.usdz', zipDatei([{ name: 'kiste.usda', daten: paketLayer }, { name: 'tex/farbe.png', daten: PNG_1x1 }])],
    usdzMitUsdc: ['speccrate.usdz', zipDatei([{ name: 'szene.usdc', daten: usdcSpec() }, { name: 'tex/a.png', daten: PNG_1x1 }])],
    usdzRegelbruch: ['regelbruch.usdz', zipDatei([
      { name: 'tex/zuerst.png', daten: PNG_1x1, ausrichten: false },
      { name: 'kiste.usda', daten: paketLayer },
      { name: 'gepackt.txt', daten: Buffer.alloc(500, 0x41), methode: 8 },
      { name: 'geheim.bin', daten: Buffer.alloc(32, 1), verschluesselt: true },
    ])],
    usdzLayerKomprimiert: ['layerkomp.usdz', zipDatei([{ name: 'kiste.usda', daten: paketLayer, methode: 8 }])],
    usdzZip64: ['zip64.usdz', zipDatei([{ name: 'kiste.usda', daten: paketLayer }], { zip64Marke: true })],
    usdzKaputt: ['kaputt.usdz', zipDatei([{ name: 'kiste.usda', daten: paketLayer }]).subarray(0, 100)],
  };
  const pfade = {};
  for (const [schluessel, [name, inhalt]] of Object.entries(dateien)) {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
  }
  return { dir, pfade, aufraeumen: () => rm(dir, { recursive: true, force: true }) };
}

/** Sucht ein Werkzeug im PATH (ohne Shell). */
function werkzeug(name) {
  try {
    execFileSync('which', [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

const BLENDER_SKRIPT = `
import bpy, sys, os
out = sys.argv[sys.argv.index("--")+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
lo = bpy.data.objects.new("LibObj", bpy.data.meshes.new("LibMesh"))
bpy.context.scene.collection.objects.link(lo)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,"lib.blend"), compress=False)
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene; sc.name = "SzeneA"
bpy.ops.mesh.primitive_cube_add(); cube = bpy.context.active_object; cube.name = "WuerfelObj"; cube.data.name = "WuerfelMesh"
mat = bpy.data.materials.new("RostMat")
img = bpy.data.images.new("RostBild", 4, 4); img.filepath = "//textures/rost_fehlt.png"; img.source = "FILE"
img.use_fake_user = True
cube.data.materials.append(mat)
cam = bpy.data.objects.new("KameraObj", bpy.data.cameras.new("KameraDaten")); sc.collection.objects.link(cam); sc.camera = cam
cam.parent = cube
li = bpy.data.objects.new("LichtObj", bpy.data.lights.new("LichtDaten", "POINT")); sc.collection.objects.link(li)
cube.keyframe_insert("location", frame=1); cube.location.x = 2; cube.keyframe_insert("location", frame=10)
cube.animation_data.action.name = "WuerfelAktion"
with bpy.data.libraries.load(os.path.join(out,"lib.blend"), link=True, relative=True) as (src, dst):
    dst.objects = ["LibObj"]
for o in dst.objects:
    if o: sc.collection.objects.link(o)
sc.frame_start = 5; sc.frame_end = 77; sc.render.fps = 30
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,"echt.blend"), compress=False, relative_remap=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out,"echt_zstd.blend"), compress=True, copy=True)
bpy.ops.export_scene.fbx(filepath=os.path.join(out,"echt.fbx"), path_mode="RELATIVE")
bpy.ops.wm.usd_export(filepath=os.path.join(out,"echt_blender.usda"))
bpy.ops.wm.usd_export(filepath=os.path.join(out,"echt_blender.usdz"))
`;

const USDA_FUER_WERKZEUGE = `#usda 1.0
(
    defaultPrim = "Kiste"
    metersPerUnit = 0.01
    upAxis = "Y"
)

def Xform "Kiste" (
    kind = "component"
)
{
    def Mesh "Geo" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </Kiste/Mat>
    }
    def Material "Mat"
    {
        def Shader "Bild"
        {
            uniform token info:id = "UsdUVTexture"
            asset inputs:file = @./tex/farbe.png@
        }
    }
}
`;

/**
 * Echte Dateien aus Fremdwerkzeugen (nichts wird installiert). Liefert nur, was erzeugt werden konnte.
 * @returns {Promise<{pfade:Record<string,string>, werkzeuge:Record<string,boolean>, fehler:string[]}>}
 */
export async function erzeugeEchteDccFixtures(dir) {
  const pfade = {};
  const fehler = [];
  const werkzeuge = { blender: werkzeug('blender'), usdcat: werkzeug('usdcat'), usdzip: werkzeug('usdzip') };
  const echt = join(dir, 'echt');
  await mkdir(join(echt, 'pak', 'tex'), { recursive: true });
  if (werkzeuge.blender) {
    try {
      await writeFile(join(echt, 'gen.py'), BLENDER_SKRIPT);
      execFileSync('blender', ['--background', '--factory-startup', '--python', join(echt, 'gen.py'), '--', echt], { stdio: 'ignore', timeout: 180_000 });
      for (const [k, n] of [['blend', 'echt.blend'], ['blendZstd', 'echt_zstd.blend'], ['fbx', 'echt.fbx'], ['usdaBlender', 'echt_blender.usda'], ['usdzBlender', 'echt_blender.usdz']]) pfade[k] = join(echt, n);
    } catch (e) {
      fehler.push('blender: ' + e.message);
    }
  }
  await writeFile(join(echt, 'pak', 'haupt.usda'), USDA_FUER_WERKZEUGE);
  await writeFile(join(echt, 'pak', 'tex', 'farbe.png'), PNG_1x1);
  if (werkzeuge.usdcat) {
    try {
      execFileSync('usdcat', [join(echt, 'pak', 'haupt.usda'), '-o', join(echt, 'werkzeug.usdc')], { stdio: 'ignore', timeout: 60_000 });
      pfade.usdc = join(echt, 'werkzeug.usdc');
    } catch (e) {
      fehler.push('usdcat: ' + e.message);
    }
  }
  if (werkzeuge.usdzip) {
    try {
      execFileSync('usdzip', [join(echt, 'werkzeug.usdz'), 'haupt.usda', 'tex/farbe.png'], { cwd: join(echt, 'pak'), stdio: 'ignore', timeout: 60_000 });
      pfade.usdz = join(echt, 'werkzeug.usdz');
    } catch (e) {
      fehler.push('usdzip: ' + e.message);
    }
  }
  return { pfade, werkzeuge, fehler };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade } = await erzeugeDccFixtures();
  console.log(dir);
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
  if (process.argv.includes('--echt')) {
    const e = await erzeugeEchteDccFixtures(dir);
    console.log('werkzeuge', e.werkzeuge, 'fehler', e.fehler);
    for (const [k, p] of Object.entries(e.pfade)) console.log(`  echt.${k}: ${p}`);
  }
}
