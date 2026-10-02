/**
 * Fixture-Generator fuer die Unreal-Asset-Inspektoren (P4-T63).
 * Erzeugt kleine Dateien DETERMINISTISCH in einem Verzeichnis unter os.tmpdir() — es werden KEINE
 * Binaerdateien eingecheckt.
 *
 * WICHTIG (Ehrlichkeit): Alle Dateien hier sind VON HAND NACH SPEZIFIKATION gebaut (Feldfolge aus
 * FPackageFileSummary / FObjectImport / FObjectExport / FPakInfo / FPakEntry). Sie pruefen, dass der
 * Inspektor das Layout so liest, wie es hier angenommen ist — NICHT, dass die Annahme mit echten
 * Engine-Dateien uebereinstimmt. Dafuer braucht es echte Proben (siehe Report P4-T63).
 *
 * AUFRUF: node packages/core/scripts/asset-fixtures-unreal.mjs   (gibt das Verzeichnis aus)
 * ALS MODUL: const { dir, pfade, aufraeumen } = await erzeugeUnrealFixtures();
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- Grundbausteine ----------
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u8 = n => Buffer.from([n & 0xff]);
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const sha1 = buf => createHash('sha1').update(buf).digest();

/** FString: ASCII positiv (inkl. Terminator), utf16 negativ. */
export function fstring(s, utf16 = false) {
  if (s === '') return i32(0);
  if (utf16) return Buffer.concat([i32(-(s.length + 1)), Buffer.from(s + '\0', 'utf16le')]);
  return Buffer.concat([i32(s.length + 1), Buffer.from(s + '\0', 'latin1')]);
}

/** Deterministische Fuellbytes. */
export function fuell(n, start = 1) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (start + i * 13) & 0xff;
  return b;
}

/** FGuid aus einer Zahl (deterministisch). */
const guid = k => Buffer.concat([u32(0x11111111 * (k % 15 + 1)), u32(k), u32(0xabcdef00 + k), u32(0x01020304)]);

export const PKG = { Cooked: 0x200, UnversionedProperties: 0x2000, ContainsMap: 0x20000, FilterEditorOnly: 0x80000000 };

// ---------- uasset/umap ----------

/**
 * Baut ein klassisches Paket nach Spezifikation.
 * @param {object} o
 *  legacy, ue3, ue4, ue5, licensee, custom (Anzahl), folder, flags,
 *  names: string[], imports: [{cp, cn, outer, name, num?, pkg?, optional?}],
 *  exports: [{cls, sup, tpl, outer, name, num?, flags?, data: Buffer, isAsset?}],
 *  trennen: Exportdaten in separaten uexp-Puffer,
 *  patch: (felder) => void   — Summary-Felder vor dem Schreiben verfaelschen,
 *  folderRoh: Buffer          — FolderName-Feld roh ersetzen,
 *  unversioniert: true        — Versionen als 0/0/0 schreiben, Layout trotzdem nach ue4/ue5 (wie die Engine),
 *  paketnameImmer: true       — Import-PackageName auch bei FilterEditorOnly (UE 5.8; dann = ObjectName).
 * @returns {{uasset: Buffer, uexp: Buffer|null, felder: object}}
 */
export function baueUasset(o) {
  const legacy = o.legacy ?? -7;
  const ue3 = o.ue3 ?? 864;
  const ue4 = o.ue4 ?? 522;
  const ue5 = legacy <= -8 ? (o.ue5 ?? 1008) : null;
  const licensee = o.licensee ?? 0;
  const flags = (o.flags ?? 0) >>> 0;
  const filter = (flags & PKG.FilterEditorOnly) !== 0;
  const names = o.names;
  const idx = s => {
    const i = names.indexOf(s);
    if (i < 0) throw new Error('Name fehlt in der Tabelle: ' + s);
    return i;
  };
  const fname = (s, num = 0) => Buffer.concat([i32(idx(s)), i32(num)]);

  const namenBlock = Buffer.concat(names.map(n => Buffer.concat([fstring(n), ue4 >= 504 ? u32(0x00010002) : Buffer.alloc(0)])));
  const importBlock = Buffer.concat((o.imports ?? []).map(im => Buffer.concat([
    fname(im.cp), fname(im.cn), i32(im.outer), fname(im.name, im.num ?? 0),
    ...((!filter || o.paketnameImmer) && ue4 >= 520 ? [fname(im.pkg ?? (filter ? im.name : 'None'), im.pkg ? 0 : (filter ? im.num ?? 0 : 0))] : []),
    ...(ue5 !== null && ue5 >= 1003 ? [u32(im.optional ? 1 : 0)] : []),
  ])));
  const exporte = o.exports ?? [];
  const u5 = ue5 ?? 0;
  const exportEintrag = (e, serialSize, serialOffset) => Buffer.concat([
    i32(e.cls), i32(e.sup ?? 0),
    ...(ue4 >= 508 ? [i32(e.tpl ?? 0)] : []),
    i32(e.outer), fname(e.name, e.num ?? 0), u32(e.flags ?? 0x1),
    ...(ue4 >= 511 ? [i64(serialSize), i64(serialOffset)] : [i32(serialSize), i32(serialOffset)]),
    u32(0), u32(0), u32(0),
    ...(u5 < 1005 ? [guid(7)] : []),
    ...(u5 >= 1006 ? [u32(0)] : []),
    u32(0),
    ...(ue4 >= 365 ? [u32(0)] : []),
    ...(ue4 >= 485 ? [u32(e.isAsset ? 1 : 0)] : []),
    ...(u5 >= 1003 ? [u32(0)] : []),
    ...(ue4 >= 507 ? [i32(-1), i32(0), i32(0), i32(0), i32(0)] : []),
    ...(u5 >= 1010 && !(flags & PKG.UnversionedProperties) ? [i64(0), i64(0)] : []),
  ]);
  const exportGr = exporte.length > 0 ? exportEintrag(exporte[0], 0, 0).length : 0;
  const dependsBlock = Buffer.concat(exporte.map(() => i32(0)));

  const summary = f => Buffer.concat([
    u32(f.tag ?? 0x9e2a83c1), i32(legacy),
    ...(legacy !== -4 ? [i32(ue3)] : []),
    ...(o.unversioniert ? [i32(0), ...(ue5 !== null ? [i32(0)] : []), i32(0)] : [i32(ue4), ...(ue5 !== null ? [i32(ue5)] : []), i32(licensee)]),
    ...(u5 >= 1016 ? [fuell(20, 99), i32(f.totalHeaderSize)] : []),
    i32(o.custom ?? 0), ...Array.from({ length: o.custom ?? 0 }, (_, k) => Buffer.concat([guid(k + 1), i32(k + 3)])),
    ...(u5 < 1016 ? [i32(f.totalHeaderSize)] : []), o.folderRoh ?? fstring(o.folder ?? 'None'), u32(flags),
    i32(f.nameCount), i32(f.nameOffset),
    ...(ue5 !== null && ue5 >= 1008 ? [i32(0), i32(0)] : []),
    ...(!filter && ue4 >= 516 ? [fstring('LOCID0001')] : []),
    ...(ue4 >= 459 ? [i32(0), i32(0)] : []),
    i32(f.exportCount), i32(f.exportOffset), i32(f.importCount), i32(f.importOffset),
    ...(u5 >= 1015 ? [i32(0), i32(f.dependsOffset), i32(0), i32(f.dependsOffset)] : []),
    ...(u5 >= 1014 ? [i32(f.dependsOffset)] : []),
    i32(f.dependsOffset),
    Buffer.alloc(32), // restliche Summary-Felder (vom Inspektor nicht gelesen)
  ]);
  const sLen = summary({ totalHeaderSize: 0, nameCount: 0, nameOffset: 0, exportCount: 0, exportOffset: 0, importCount: 0, importOffset: 0, dependsOffset: 0 }).length;
  const felder = {
    nameCount: names.length,
    nameOffset: sLen,
    importCount: (o.imports ?? []).length,
    importOffset: sLen + namenBlock.length,
    exportCount: exporte.length,
  };
  felder.exportOffset = felder.importOffset + importBlock.length;
  felder.dependsOffset = felder.exportOffset + exporte.length * exportGr;
  felder.totalHeaderSize = felder.dependsOffset + dependsBlock.length;
  let pos = felder.totalHeaderSize;
  const exportBlock = Buffer.concat(exporte.map(e => {
    const b = exportEintrag(e, e.data.length, pos);
    pos += e.data.length;
    return b;
  }));
  const echt = { ...felder };
  if (o.patch) o.patch(felder);
  const header = Buffer.concat([summary(felder), namenBlock, importBlock, exportBlock, dependsBlock]);
  const daten = Buffer.concat(exporte.map(e => e.data));
  if (o.trennen) {
    // Gecookt: .uexp enthaelt die Exportdaten und endet mit dem Paket-Tag.
    return { uasset: header, uexp: Buffer.concat([daten, u32(0x9e2a83c1)]), felder: echt };
  }
  return { uasset: Buffer.concat([header, daten]), uexp: null, felder: echt };
}

/** Standard-Paket: /Game/Props/Chair (StaticMesh) mit Importen aus /Script/Engine und /Game. */
export function chairPaket(extra = {}) {
  return {
    names: [
      '/Script/CoreUObject', '/Script/Engine', 'Package', 'Class', 'StaticMesh', 'BodySetup', 'Material',
      'Chair', '/Game/Props/Chair', '/Game/Materials/M_Wood', 'M_Wood', '/Game/Missing/Gone', 'Gone', 'None',
    ],
    imports: [
      { cp: '/Script/CoreUObject', cn: 'Package', outer: 0, name: '/Script/Engine' }, // -1
      { cp: '/Script/CoreUObject', cn: 'Class', outer: -1, name: 'StaticMesh' }, // -2
      { cp: '/Script/CoreUObject', cn: 'Package', outer: 0, name: '/Game/Materials/M_Wood' }, // -3
      { cp: '/Script/Engine', cn: 'Material', outer: -3, name: 'M_Wood' }, // -4
      { cp: '/Script/CoreUObject', cn: 'Class', outer: -1, name: 'BodySetup' }, // -5
      { cp: '/Script/CoreUObject', cn: 'Package', outer: 0, name: '/Game/Missing/Gone' }, // -6
      { cp: '/Script/Engine', cn: 'StaticMesh', outer: -6, name: 'Gone' }, // -7
    ],
    exports: [
      { cls: -2, outer: 0, name: 'Chair', data: fuell(40, 5), isAsset: true }, // 1
      { cls: -5, outer: 1, name: 'BodySetup', num: 1, data: fuell(24, 9) }, // 2 -> BodySetup_0
    ],
    folder: 'None',
    ...extra,
  };
}

/** Map-Paket mit PKG_ContainsMap. */
export function mapPaket(extra = {}) {
  return {
    names: ['/Script/CoreUObject', '/Script/Engine', 'Package', 'Class', 'World', 'Level', 'Level1', 'PersistentLevel', 'None'],
    imports: [
      { cp: '/Script/CoreUObject', cn: 'Package', outer: 0, name: '/Script/Engine' },
      { cp: '/Script/CoreUObject', cn: 'Class', outer: -1, name: 'World' },
      { cp: '/Script/CoreUObject', cn: 'Class', outer: -1, name: 'Level' },
    ],
    exports: [
      { cls: -2, outer: 0, name: 'Level1', data: fuell(32, 2), isAsset: true },
      { cls: -3, outer: 1, name: 'PersistentLevel', data: fuell(48, 3) },
    ],
    flags: PKG.ContainsMap,
    ...extra,
  };
}

// ---------- pak ----------

const MAGIC_PAK = 0x5a6f12e1;

/**
 * Baut ein Pak nach Spezifikation (Footer + flacher Index; v10/v11 nur Index-Kopf).
 * @param {object} o version, layout ('v8a'|'v8b'), mount, entries [{name, data, method?, blocks?, flags?}],
 *   encryptedIndex, kompNamen, indexHashFalsch, patchFooter(f), mountRoh, anzahlRoh, versionImFooter
 */
export function bauePak(o) {
  const v = o.version;
  const v8a = o.layout === 'v8a';
  const entries = o.entries ?? [];
  const teile = [];
  let pos = 0;
  const recs = [];
  for (const e of entries) {
    recs.push({ ...e, offset: pos });
    teile.push(e.data);
    pos += e.data.length;
  }
  const eintrag = e => {
    const methode = e.method ?? 0;
    const blocks = e.blocks ?? (methode !== 0 ? 1 : 0);
    return Buffer.concat([
      i64(e.offset), i64(e.data.length), i64(e.usize ?? e.data.length),
      v < 8 ? i32(methode) : v8a ? u8(methode) : u32(methode),
      ...(v < 2 ? [i64(0)] : []),
      sha1(e.data),
      ...(v >= 3 ? [
        ...(methode !== 0 ? [i32(blocks), ...Array.from({ length: blocks }, (_, k) => Buffer.concat([i64(e.offset + k), i64(e.offset + k + 1)]))] : []),
        u8(e.flags ?? 0), u32(methode !== 0 ? 65536 : 0),
      ] : []),
    ]);
  };
  let index;
  let nachIndex = Buffer.alloc(0);
  const kopf = Buffer.concat([o.mountRoh ?? fstring(o.mount ?? '../../../'), i32(o.anzahlRoh ?? entries.length)]);
  const indexOffset = pos;
  if (v >= 10) {
    // Kodierte Eintraege (FPakEntry::EncodeTo) bzw. nicht kodierte Liste.
    const lagen = [];
    const kodiert = [];
    let kpos = 0;
    const nichtKodiert = [];
    for (const r of recs) {
      if (o.nichtKodiert) {
        lagen.push(-(nichtKodiert.length + 1));
        nichtKodiert.push(eintrag(r));
        continue;
      }
      const methode = r.method ?? 0;
      const blocks = methode !== 0 ? (r.blocks ?? 1) : 0;
      const bits = ((1 << 31) | (1 << 30) | (methode !== 0 ? 1 << 29 : 0) | (methode << 23) | ((r.flags ?? 0) & 1 ? 1 << 22 : 0) | (blocks << 6) | (methode !== 0 ? 65536 >> 11 : 0)) >>> 0;
      const b = Buffer.concat([
        u32(bits), u32(r.offset), u32(r.usize ?? r.data.length),
        ...(methode !== 0 ? [u32(r.data.length)] : []),
        ...(blocks > 1 || (blocks > 0 && (r.flags ?? 0) & 1) ? Array.from({ length: blocks }, () => u32(1)) : []),
      ]);
      lagen.push(kpos);
      kodiert.push(b);
      kpos += b.length;
    }
    // FullDirectoryIndex: Verzeichnis ('/' = Wurzel, sonst mit '/' davor und dahinter) -> Datei -> Lage.
    const verz = new Map();
    recs.forEach((r, k) => {
      const schnitt = r.name.lastIndexOf('/');
      const d = schnitt < 0 ? '/' : '/' + r.name.slice(0, schnitt + 1);
      if (!verz.has(d)) verz.set(d, []);
      verz.get(d).push([r.name.slice(schnitt + 1), lagen[k]]);
    });
    // Ab v12 (Utf8PakDirectory) Dateinamen als FUtf8String: int32 Bytezahl ohne Terminator + UTF-8.
    const dateiname = f => (v >= 12 ? Buffer.concat([i32(Buffer.byteLength(f, 'utf8')), Buffer.from(f, 'utf8')]) : fstring(f));
    const fdi = Buffer.concat([i32(verz.size), ...[...verz].map(([d, fs]) => Buffer.concat([fstring(d), i32(fs.length), ...fs.map(([f, l]) => Buffer.concat([dateiname(f), i32(l)]))]))]);
    const phi = fuell(24, 31);
    const primaer = (phiOff, fdiOff) => Buffer.concat([
      kopf, i64(0x1234),
      u32(1), i64(phiOff), i64(phi.length), sha1(phi),
      ...(o.ohneVerzeichnisindex ? [u32(0)] : [u32(1), i64(fdiOff), i64(fdi.length), sha1(fdi)]),
      i32(kpos), ...kodiert,
      i32(nichtKodiert.length), ...nichtKodiert,
    ]);
    const pLen = primaer(0, 0).length;
    index = primaer(indexOffset + pLen, indexOffset + pLen + phi.length);
    nachIndex = Buffer.concat([phi, fdi]);
  } else {
    index = Buffer.concat([kopf, ...recs.map(r => Buffer.concat([fstring(r.name), eintrag(r)]))]);
  }
  const hash = o.indexHashFalsch ? Buffer.alloc(20, 0xee) : sha1(index);
  const f = { indexOffset, indexSize: index.length, version: o.versionImFooter ?? v };
  if (o.patchFooter) o.patchFooter(f);
  const komp = o.kompNamen ?? ['Zlib', 'Oodle'];
  const nNamen = v8a ? 4 : 5;
  const footer = Buffer.concat([
    ...(v >= 7 ? [o.guid ?? Buffer.alloc(16)] : []),
    ...(v >= 4 ? [u8(o.encryptedIndex ? 1 : 0)] : []),
    u32(MAGIC_PAK), i32(f.version), i64(f.indexOffset), i64(f.indexSize), hash,
    ...(v === 9 ? [u8(0)] : []),
    ...(v >= 8 ? Array.from({ length: nNamen }, (_, k) => {
      const b = Buffer.alloc(32);
      if (komp[k]) b.write(komp[k], 'latin1');
      return b;
    }) : []),
  ]);
  return Buffer.concat([...teile, index, nachIndex, footer]);
}

const STANDARD_EINTRAEGE = () => [
  { name: 'MyGame/Content/Props/Chair.uasset', data: fuell(100, 1) },
  { name: 'MyGame/Content/Props/Chair.uexp', data: fuell(60, 2), method: 1, blocks: 2 },
  { name: 'MyGame/Config/DefaultGame.ini', data: fuell(30, 3), flags: 0x01 },
];

// ---------- IoStore ----------
/** utoc-Kopf (FIoStoreTocHeader, 144 Bytes) + etwas Rest; flags = EIoContainerFlags. */
export function baueUtoc(version = 3, flags = 0x9) {
  const kopf = Buffer.alloc(144);
  Buffer.from('-==--==--==--==-', 'latin1').copy(kopf, 0);
  kopf.writeUInt8(version, 16);
  kopf.writeUInt32LE(144, 20);
  kopf.writeUInt32LE(5, 24);
  kopf.writeUInt32LE(5, 28);
  kopf.writeUInt32LE(65536, 44);
  kopf.writeUInt8(flags, 80);
  return Buffer.concat([kopf, fuell(64, 4)]);
}

/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird ein neues unter os.tmpdir() angelegt.
 */
export async function erzeugeUnrealFixtures(ziel) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-asset-unreal-')));
  await mkdir(dir, { recursive: true });

  const ue427 = baueUasset(chairPaket());
  const ue51 = baueUasset(chairPaket({ legacy: -8, ue4: 522, ue5: 1008, custom: 2 }));
  const ue50 = baueUasset(chairPaket({ legacy: -8, ue4: 522, ue5: 1004 }));
  const ue4alt = baueUasset(chairPaket({ legacy: -7, ue4: 510 }));
  const ue54 = baueUasset(chairPaket({ legacy: -8, ue4: 522, ue5: 1012 }));
  const umap = baueUasset(mapPaket());
  const cooked = baueUasset(chairPaket({ flags: PKG.Cooked | PKG.FilterEditorOnly, trennen: true }));
  const ue58unv = baueUasset(chairPaket({
    legacy: -9, ue5: 1018, unversioniert: true, paketnameImmer: true, trennen: true,
    flags: PKG.Cooked | PKG.FilterEditorOnly | PKG.UnversionedProperties,
  }));
  const zyklus = baueUasset(chairPaket({
    imports: [
      { cp: '/Script/CoreUObject', cn: 'Package', outer: -2, name: '/Script/Engine' },
      { cp: '/Script/CoreUObject', cn: 'Class', outer: -1, name: 'StaticMesh' },
    ],
    exports: [
      { cls: -2, outer: 2, name: 'Chair', data: fuell(8, 1) },
      { cls: -2, outer: 1, name: 'BodySetup', data: fuell(8, 2) },
    ],
  }));

  const dateien = {
    // Gueltige Pakete in vier Versionsbaendern (+ UE5-Obergrenze 1012).
    ue427: ['ue427/Chair.uasset', ue427.uasset],
    ue51: ['ue51/Chair.uasset', ue51.uasset],
    ue50: ['ue50/Chair.uasset', ue50.uasset],
    ue4alt: ['ue4alt/Chair.uasset', ue4alt.uasset],
    ue54: ['ue54/Chair.uasset', ue54.uasset],
    umap: ['maps/Level1.umap', umap.uasset],
    // Content-Ordner: /Game/... wird gegen Proj/Content aufgeloest.
    contentChair: ['Proj/Content/Props/Chair.uasset', ue427.uasset],
    contentWood: ['Proj/Content/Materials/M_Wood.uasset', baueUasset(mapPaket({ flags: 0 })).uasset],
    // Gecookt mit getrennten Exportdaten.
    cooked: ['cooked/Chair.uasset', cooked.uasset],
    cookedUexp: ['cooked/Chair.uexp', cooked.uexp],
    cookedOhneUexp: ['cooked-ohne/Chair.uasset', cooked.uasset],
    // Nicht unterstuetzte Versionen.
    legacy10: ['version/legacy10.uasset', Buffer.concat([u32(0x9e2a83c1), i32(-10), fuell(200, 1)])],
    ue58: ['ue58/Chair.uasset', baueUasset(chairPaket({ legacy: -9, ue5: 1018, custom: 3 })).uasset],
    ue58Unversioniert: ['ue58-unversioniert/Chair.uasset', ue58unv.uasset],
    ue58UnversioniertUexp: ['ue58-unversioniert/Chair.uexp', ue58unv.uexp],
    legacy5: ['version/legacy5.uasset', Buffer.concat([u32(0x9e2a83c1), i32(-5), fuell(200, 1)])],
    ue5neu: ['version/ue5-1019.uasset', baueUasset(chairPaket({ legacy: -9, ue5: 1019 })).uasset],
    ue4neu: ['version/ue4-600.uasset', baueUasset(chairPaket({ ue4: 600 })).uasset],
    unversioniert: ['version/unversioniert.uasset', baueUasset(chairPaket({ legacy: -8, ue4: 0, ue5: 0, flags: PKG.Cooked | PKG.FilterEditorOnly })).uasset],
    byteSwap: ['version/bigendian.uasset', Buffer.concat([Buffer.from([0x9e, 0x2a, 0x83, 0xc1]), fuell(100, 1)])],
    // Kaputt / boesartig.
    leer: ['kaputt/leer.uasset', Buffer.alloc(0)],
    abgeschnitten30: ['kaputt/abgeschnitten30.uasset', ue427.uasset.subarray(0, 30)],
    abgeschnittenHeader: ['kaputt/abgeschnitten-header.uasset', ue427.uasset.subarray(0, ue427.felder.totalHeaderSize - 10)],
    ohneExportdaten: ['kaputt/ohne-exportdaten.uasset', ue427.uasset.subarray(0, ue427.felder.totalHeaderSize + 10)],
    offsetRiesig: ['kaputt/offset-riesig.uasset', baueUasset(chairPaket({ patch: f => { f.nameOffset = 0x7ffffff0; f.importOffset = 0x7ffffff0; } })).uasset],
    headerRiesig: ['kaputt/header-riesig.uasset', baueUasset(chairPaket({ patch: f => { f.totalHeaderSize = 0x7fffffff; } })).uasset],
    nameCountFF: ['kaputt/namecount-ff.uasset', baueUasset(chairPaket({ patch: f => { f.nameCount = 0xffffffff; } })).uasset],
    exportCountRiesig: ['kaputt/exportcount-riesig.uasset', baueUasset(chairPaket({ patch: f => { f.exportCount = 0x7fffffff; } })).uasset],
    fstringMin: ['kaputt/fstring-min.uasset', baueUasset(chairPaket({ folderRoh: i32(-2147483648) })).uasset],
    fstringMax: ['kaputt/fstring-max.uasset', baueUasset(chairPaket({ folderRoh: i32(2147483647) })).uasset],
    layoutFalsch: ['kaputt/layout-falsch.uasset', baueUasset(chairPaket({ patch: f => { f.dependsOffset += 4; } })).uasset],
    zyklus: ['kaputt/zyklus.uasset', zyklus.uasset],
    magicFalsch: ['kaputt/magic-falsch.uasset', fuell(256, 3)],
    zen: ['kaputt/zen.uasset', Buffer.concat([u32(0), u32(64), fuell(120, 6)])],

    // Pak.
    pakV8: ['pak/v8b.pak', bauePak({ version: 8, layout: 'v8b', mount: '../../../', entries: STANDARD_EINTRAEGE() })],
    pakV8a: ['pak/v8a.pak', bauePak({ version: 8, layout: 'v8a', entries: STANDARD_EINTRAEGE() })],
    pakV3: ['pak/v3.pak', bauePak({ version: 3, entries: STANDARD_EINTRAEGE() })],
    pakV1: ['pak/v1.pak', bauePak({ version: 1, entries: STANDARD_EINTRAEGE().slice(0, 1) })],
    pakV7: ['pak/v7.pak', bauePak({ version: 7, entries: STANDARD_EINTRAEGE(), guid: guid(42) })],
    pakV9: ['pak/v9.pak', bauePak({ version: 9, entries: STANDARD_EINTRAEGE() })],
    pakV11: ['pak/v11.pak', bauePak({ version: 11, entries: STANDARD_EINTRAEGE() })],
    pakV10NichtKodiert: ['pak/v10-nicht-kodiert.pak', bauePak({ version: 10, entries: STANDARD_EINTRAEGE(), nichtKodiert: true })],
    pakV11OhneVerz: ['pak/v11-ohne-verzeichnis.pak', bauePak({ version: 11, entries: STANDARD_EINTRAEGE(), ohneVerzeichnisindex: true })],
    pakVerschluesselt: ['pak/verschluesselt.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE(), encryptedIndex: true, guid: guid(9) })],
    pakV12: ['pak/v12.pak', bauePak({ version: 12, entries: [...STANDARD_EINTRAEGE(), { name: 'MyGame/Content/Grüße/Äpfel.uasset', data: fuell(12, 5) }] })],
    pakUnbekannt: ['pak/unbekannt.pak', bauePak({ version: 11, entries: STANDARD_EINTRAEGE(), versionImFooter: 13 })],
    pakTraversal: ['pak/traversal.pak', bauePak({ version: 8, entries: [
      { name: '../../../etc/passwd', data: fuell(10, 1) },
      { name: '/absolut/datei.txt', data: fuell(10, 2) },
      { name: 'ok/datei.txt', data: fuell(10, 3) },
    ] })],
    pakIndexAusserhalb: ['pak/index-ausserhalb.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE(), patchFooter: f => { f.indexOffset = 0x7fffffffff; } })],
    pakHashFalsch: ['pak/hash-falsch.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE(), indexHashFalsch: true })],
    pakAnzahlRiesig: ['pak/anzahl-riesig.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE(), anzahlRoh: 0x7fffffff })],
    pakMountMin: ['pak/mount-min.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE(), mountRoh: i32(-2147483648) })],
    pakMountMax: ['pak/mount-max.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE(), mountRoh: i32(2147483647) })],
    pakViele: ['pak/viele.pak', bauePak({ version: 8, entries: Array.from({ length: 50 }, (_, k) => ({ name: `d/f${k}.bin`, data: fuell(4, k) })) })],
    pakLeer: ['pak/leer.pak', Buffer.alloc(0)],
    pakFremd: ['pak/fremd.pak', Buffer.concat([u32(5), u32(0), u32(3), fuell(300, 8)])],
    pakAbgeschnitten: ['pak/abgeschnitten.pak', bauePak({ version: 8, entries: STANDARD_EINTRAEGE() }).subarray(0, 150)],

    // IoStore.
    utoc: ['iostore/global.utoc', baueUtoc()],
    utocNeu: ['iostore-neu/neu.utoc', baueUtoc(9)],
    ucas: ['iostore/global.ucas', fuell(256, 4)],
  };
  const pfade = {};
  for (const [schluessel, [name, inhalt]] of Object.entries(dateien)) {
    const p = join(dir, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
  }
  return {
    dir,
    pfade,
    felder: { ue427: ue427.felder, ue51: ue51.felder, umap: umap.felder, cooked: cooked.felder },
    aufraeumen: () => rm(dir, { recursive: true, force: true }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade } = await erzeugeUnrealFixtures();
  console.log(dir);
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
}
