/**
 * Unreal-Asset-Inspektoren (P4-T63): uasset/umap, pak, utoc/ucas gegen gebautes dist.
 *
 * EHRLICHKEIT: Alle Unreal-Fixtures sind VON HAND NACH SPEZIFIKATION gebaut
 * (scripts/asset-fixtures-unreal.mjs). Diese Tests belegen, dass die Inspektoren das ANGENOMMENE
 * Layout korrekt und robust lesen — nicht, dass die Annahme zu echten Engine-Dateien passt.
 * Einzige echte Fremddateien: Chromium/QtWebEngine-.pak (anderes Format, gleiche Endung) als
 * Negativprobe, und optional Proben unter ASSET_SAMPLES_DIR (fehlen sie, wird uebersprungen).
 *
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-unreal/dist node --test packages/core/tests/asset-intel-unreal.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const SAMPLES_FRUEH = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const U = await import(join(dist, 'asset-intel', 'inspectors', 'unreal', 'index.js'));
const { inspectAsset, AssetRegistry } = A;
const FX = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-unreal.mjs')).href);
const { erzeugeUnrealFixtures } = FX;

const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];
const codes = r => r.warnings.map(w => w.code);

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, wo + ': Feld fehlt: ' + k);
  assert.ok(['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'].includes(r.status), wo + ' status ' + r.status);
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), wo + ' ' + k);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), wo + ' ' + k);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', wo + ' warning-Form');
  for (const o of r.objects) {
    assert.ok(o.name === null || typeof o.name === 'string', wo + ' object.name');
    assert.equal(typeof o.kind, 'string');
    if (o.source_range) {
      assert.ok(Number.isInteger(o.source_range.offset) && o.source_range.offset >= 0, wo + ' source_range.offset');
      assert.ok(Number.isInteger(o.source_range.length) && o.source_range.length >= 0, wo + ' source_range.length');
      // Ein Bytebereich muss in der Datei liegen.
      assert.ok(o.source_range.offset + o.source_range.length <= r.size, wo + ' source_range in Datei');
    }
  }
  for (const ref of r.references) {
    assert.equal(typeof ref.target, 'string');
    assert.ok(ref.resolved === undefined || typeof ref.resolved === 'boolean');
  }
  JSON.stringify(r);
}

function registry() {
  const reg = new AssetRegistry();
  for (const i of U.assetUnrealInspektoren) reg.register(i);
  return reg;
}
const reg = registry();
const lauf = (p, opts = {}) => inspectAsset(p, { registry: reg, ...opts });

let fx;
before(async () => {
  fx = await erzeugeUnrealFixtures();
});
after(async () => {
  await fx.aufraeumen();
});

// ---------------- Registrierung ----------------

test('Export: fuenf Inspektoren mit eindeutigen ids, Formaten und Endungen; keine Kollision untereinander', () => {
  const ids = U.assetUnrealInspektoren.map(i => i.id);
  assert.deepEqual(ids, ['unreal-package', 'unreal-uexp', 'unreal-pak', 'unreal-utoc', 'unreal-ucas']);
  assert.deepEqual(reg.formats(), ['pak', 'uasset', 'ucas', 'uexp', 'umap', 'utoc']);
  assert.equal(reg.detect('x.uexp', Buffer.alloc(8)).inspector.id, 'unreal-uexp');
  const kopf = Buffer.from([0xc1, 0x83, 0x2a, 0x9e, 0, 0, 0, 0]);
  assert.equal(reg.detect('x.uasset', kopf).inspector.id, 'unreal-package');
  assert.equal(reg.detect('x.bin', kopf).inspector.id, 'unreal-package', 'Magic allein reicht');
  assert.equal(reg.detect('x.pak', Buffer.alloc(8)).inspector.id, 'unreal-pak');
  assert.equal(reg.detect('x.utoc', Buffer.from('-==--==--==--==-')).inspector.id, 'unreal-utoc');
  assert.equal(reg.detect('x.ucas', Buffer.alloc(8)).inspector.id, 'unreal-ucas');
  for (const i of U.assetUnrealInspektoren) assert.ok(Number.isInteger(i.version) && i.version >= 1);
});

test('Magic gegen generic-binary: keine Ueberschneidung (Unreal-Magic ist in keinem anderen Muster)', () => {
  const r = new AssetRegistry();
  r.register(A.genericBinaryInspector);
  for (const i of U.assetUnrealInspektoren) r.register(i);
  const d = r.detect('a.uasset', Buffer.from([0xc1, 0x83, 0x2a, 0x9e]));
  assert.equal(d.inspector.id, 'unreal-package');
  assert.deepEqual(d.warnings, []);
});

// ---------------- uasset / umap: gueltige Pakete ----------------

test('UE4.27-Paket (Legacy -7, UE4 522): Summary, Namen, Importe, Exporte exakt', async () => {
  const r = await lauf(fx.pfade.ue427);
  pruefeSchema(r, 'ue427');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.inspector, 'unreal-package');
  assert.equal(r.asset_type, 'unreal_asset');
  assert.equal(r.format, 'uasset');
  const m = r.metadata;
  assert.equal(m.legacy_file_version, -7);
  assert.equal(m.legacy_ue3_version, 864);
  assert.equal(m.file_version_ue4, 522);
  assert.equal(m.file_version_ue5, null);
  assert.equal(m.file_version_licensee, 0);
  assert.equal(m.engine_band, 'UE4');
  assert.equal(m.header_groesse, fx.felder.ue427.totalHeaderSize);
  assert.equal(m.name_count, 14);
  assert.equal(m.import_count, 7);
  assert.equal(m.export_count, 2);
  assert.equal(m.localization_id, 'LOCID0001');
  assert.equal(m.enthaelt_map, false);
  assert.equal(r.format_specific.offsets.name, fx.felder.ue427.nameOffset);
  assert.equal(r.format_specific.offsets.import, fx.felder.ue427.importOffset);
  assert.equal(r.format_specific.offsets.export, fx.felder.ue427.exportOffset);
  assert.equal(r.format_specific.names_vorschau[0], '/Script/CoreUObject');

  const exp = r.objects.filter(o => o.kind === 'export');
  assert.deepEqual(exp.map(o => o.name), ['Chair', 'BodySetup_0']);
  assert.equal(exp[0].data.class, 'StaticMesh');
  assert.equal(exp[0].data.outer, null);
  assert.equal(exp[0].data.is_asset, true);
  assert.deepEqual(exp[0].source_range, { offset: fx.felder.ue427.totalHeaderSize, length: 40 });
  assert.equal(exp[1].data.class, 'BodySetup');
  assert.equal(exp[1].data.outer, 'Chair');
  assert.deepEqual(exp[1].source_range, { offset: fx.felder.ue427.totalHeaderSize + 40, length: 24 });
  // Die Exportdaten liegen tatsaechlich dort (Fixture-Fuellmuster pruefen).
  const roh = readFileSync(fx.pfade.ue427);
  assert.deepEqual(roh.subarray(exp[0].source_range.offset, exp[0].source_range.offset + 40), FX.fuell(40, 5));

  const imp = r.objects.filter(o => o.kind === 'import');
  assert.equal(imp.length, 7);
  assert.equal(imp[3].name, 'M_Wood');
  assert.equal(imp[3].data.class_name, 'Material');
  assert.equal(imp[3].data.paket, '/Game/Materials/M_Wood');
  assert.equal(imp[3].data.index, -4);
  assert.equal(imp[0].source_range.offset, fx.felder.ue427.importOffset);
  assert.equal(imp[0].source_range.length, U.importGroesse(522, null, true));

  assert.deepEqual(r.references.filter(x => x.kind === 'import').map(x => x.target), ['/Script/Engine', '/Game/Materials/M_Wood', '/Game/Missing/Gone']);
  // Klassenpakete der Importe, soweit nicht schon Importwurzel (die Engine-PkgInfo zaehlt sie mit).
  assert.deepEqual(r.references.filter(x => x.kind === 'klassenpaket').map(x => x.target), ['/Script/CoreUObject']);
  assert.ok(r.references.every(x => x.resolved === undefined), 'ausserhalb Content: nicht aufgeloest');
});

test('UE5.1-Paket (Legacy -8, UE5 1008, 2 CustomVersions): SoftObjectPaths-Feld, ohne Export-Guid', async () => {
  const r = await lauf(fx.pfade.ue51);
  pruefeSchema(r, 'ue51');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.engine_band, 'UE5');
  assert.equal(r.metadata.file_version_ue5, 1008);
  assert.equal(r.metadata.custom_version_count, 2);
  assert.equal(r.format_specific.custom_versions.length, 2);
  assert.equal(r.format_specific.custom_versions[1].version, 4);
  assert.match(r.format_specific.custom_versions[0].guid, /^[0-9A-F]{32}$/);
  assert.equal(r.metadata.soft_object_paths_count, 0);
  assert.deepEqual(r.objects.filter(o => o.kind === 'export').map(o => o.data.class), ['StaticMesh', 'BodySetup']);
  assert.equal(r.objects.find(o => o.kind === 'import').data.optional, false);
  // Eintragsgroessen dieser Version (Spec-Annahme, hier nur gegen sich selbst gerechnet).
  assert.equal(U.exportGroesse(522, 1008), 96);
  assert.equal(U.exportGroesse(522, null), 104);
  assert.equal(U.importGroesse(522, 1008, true), 40);
  assert.equal(U.importGroesse(522, 1008, false), 32);
  assert.equal(U.exportGroesse(522, 1018), 112, 'mit ScriptSerializationOffsets');
  assert.equal(U.exportGroesse(522, 1018, true), 96, 'PKG_UnversionedProperties: ohne ScriptSerializationOffsets');
});

test('weitere Baender: UE5.0 (1004), UE4 alt (510: 32-Bit-SerialSize, ohne LocalizationId), UE5-Obergrenze 1012', async () => {
  for (const k of ['ue50', 'ue4alt', 'ue54']) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'ok', k + ' ' + JSON.stringify(r.warnings));
    assert.deepEqual(r.objects.filter(o => o.kind === 'export').map(o => o.name), ['Chair', 'BodySetup_0'], k);
    assert.equal(r.references.filter(x => x.kind === 'import').length, 3, k);
  }
  const alt = await lauf(fx.pfade.ue4alt);
  assert.equal(alt.metadata.file_version_ue4, 510);
  assert.equal(alt.metadata.localization_id, undefined);
  assert.equal(U.exportGroesse(510, null), 96);
});

test('.umap mit PKG_ContainsMap: format umap, Flag ausgewertet, World-Export', async () => {
  const r = await lauf(fx.pfade.umap);
  pruefeSchema(r, 'umap');
  assert.equal(r.status, 'ok');
  assert.equal(r.format, 'umap');
  assert.equal(r.metadata.enthaelt_map, true);
  assert.deepEqual(r.metadata.flags, ['ContainsMap']);
  assert.equal(r.metadata.package_flags, '0x00020000');
  const exp = r.objects.filter(o => o.kind === 'export');
  assert.deepEqual(exp.map(o => [o.name, o.data.class, o.data.outer]), [['Level1', 'World', null], ['PersistentLevel', 'Level', 'Level1']]);
});

test('/Game-Verweise werden nur im Content-Ordner aufgeloest: vorhanden true, fehlend false, /Script undefined', async () => {
  const r = await lauf(fx.pfade.contentChair);
  pruefeSchema(r, 'content');
  const nach = Object.fromEntries(r.references.map(x => [x.target, x.resolved]));
  assert.equal(nach['/Game/Materials/M_Wood'], true);
  assert.equal(nach['/Game/Missing/Gone'], false);
  assert.equal(nach['/Script/Engine'], undefined);
  assert.ok(r.format_specific.content_verzeichnis.endsWith('Content'));
});

test('gecookt mit .uexp: Exporte hinter dem Dateiende erkannt und gemeldet, nicht gelesen', async () => {
  const r = await lauf(fx.pfade.cooked);
  pruefeSchema(r, 'cooked');
  assert.equal(r.status, 'ok');
  assert.deepEqual(codes(r), [], 'Exporte in der .uexp sind bei gecookten Paketen der Normalfall');
  assert.equal(r.metadata.cooked, true);
  assert.equal(r.metadata.getrennte_exportdaten, true);
  assert.ok(r.metadata.flags.includes('FilterEditorOnly'));
  assert.equal(r.metadata.localization_id, undefined, 'FilterEditorOnly: keine LocalizationId');
  assert.deepEqual(r.format_specific.uexp, { datei: 'Chair.uexp', vorhanden: true, exporte: 2, groesse: 68, erwartete_groesse: 68, groesse_stimmt: true });
  assert.equal(r.format_specific.ubulk.vorhanden, false);
  const exp = r.objects.filter(o => o.kind === 'export');
  assert.ok(exp.every(o => o.source_range === undefined && o.data.in_uexp === true));
  assert.deepEqual(exp.map(o => o.data.uexp_offset), [0, 40]);
  // Die .uexp beginnt wirklich mit den Daten des ersten Exports (Fixture).
  assert.deepEqual(readFileSync(fx.pfade.cookedUexp).subarray(0, 40), FX.fuell(40, 5));
  // Importe ohne PackageName-Feld (FilterEditorOnly, aeltere Engines) per Tabellenabstand erkannt.
  assert.equal(r.format_specific.import_mit_paketname, false);
  assert.equal(r.objects.find(o => o.kind === 'import').data.package_name, undefined);
  // Die .uexp selbst: Begleitdatei erkannt, End-Tag vorhanden.
  const u = await lauf(fx.pfade.cookedUexp);
  pruefeSchema(u, 'uexp');
  assert.equal(u.status, 'ok');
  assert.equal(u.inspector, 'unreal-uexp');
  assert.equal(u.metadata.end_tag, true);
  assert.equal(u.metadata.begleitdatei, 'Chair.uasset');
  assert.deepEqual(u.references, [{ target: 'Chair.uasset', kind: 'header', resolved: true }]);
});

test('UE 5.8 (Legacy -9, UE5 1018): SavedHash vor den CustomVersions, Cells/MetaData im Summary', async () => {
  const r = await lauf(fx.pfade.ue58);
  pruefeSchema(r, 'ue58');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.legacy_file_version, -9);
  assert.equal(r.metadata.file_version_ue5, 1018);
  assert.equal(r.metadata.custom_version_count, 3);
  assert.equal(r.format_specific.saved_hash, FX.fuell(20, 99).toString('hex'));
  assert.equal(r.metadata.cell_export_count, 0);
  assert.deepEqual(r.objects.filter(o => o.kind === 'export').map(o => o.data.class), ['StaticMesh', 'BodySetup']);
});

test('UE 5.8 gecookt + unversioniert: Layout per Selbstpruefung angenommen, PackageName-Hack, keine ScriptOffsets', async () => {
  const r = await lauf(fx.pfade.ue58Unversioniert);
  pruefeSchema(r, 'ue58u');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.deepEqual(codes(r), ['unversioniert_layout_angenommen', 'properties_ohne_mappings']);
  assert.equal(r.metadata.unversioniert, true);
  assert.equal(r.metadata.file_version_ue4, 0);
  assert.equal(r.metadata.layout_angenommen.file_version_ue5, 1018);
  assert.equal(r.format_specific.import_mit_paketname, true);
  assert.ok(r.objects.filter(o => o.kind === 'import').every(o => o.data.package_name === undefined), 'PackageName == ObjectName wird wie in der Engine zurueckgesetzt');
  assert.equal(r.format_specific.uexp.groesse_stimmt, true);
  assert.deepEqual(r.objects.filter(o => o.kind === 'export').map(o => o.name), ['Chair', 'BodySetup_0']);
});

test('gecookt ohne .uexp und abgeschnittene Exportdaten: teilweise + uexp_fehlt', async () => {
  for (const k of ['cookedOhneUexp', 'ohneExportdaten']) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'teilweise', k);
    assert.ok(codes(r).includes('uexp_fehlt'), k + ' ' + codes(r));
  }
});

// ---------------- uasset: nicht unterstuetzte Versionen ----------------

test('nicht unterstuetzte Versionen: teilweise + version_nicht_unterstuetzt mit gelesener Zahl, nichts geraten', async () => {
  const faelle = { legacy10: /LegacyFileVersion -10/, legacy5: /LegacyFileVersion -5/, ue5neu: /FileVersionUE5 1019/, ue4neu: /FileVersionUE4 600/ };
  for (const [k, muster] of Object.entries(faelle)) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'teilweise', k);
    const w = r.warnings.find(x => x.code === 'version_nicht_unterstuetzt');
    assert.ok(w, k + ' ' + codes(r));
    assert.match(w.message, muster);
    assert.equal(r.objects.length, 0, k + ': keine geratenen Objekte');
    assert.equal(r.metadata.name_count, undefined, k + ': Summary-Rest nicht gelesen');
  }
});

test('unversioniertes Paket, zu dem KEIN Layout exakt passt: teilweise + unversioniert, keine geratenen Tabellen', async () => {
  const r = await lauf(fx.pfade.unversioniert);
  pruefeSchema(r, 'unversioniert');
  assert.equal(r.status, 'teilweise');
  assert.deepEqual(codes(r), ['unversioniert']);
  assert.equal(r.objects.length, 0);
  assert.equal(r.metadata.header_groesse, undefined);
  assert.equal(r.format_specific.unversioniert_versuche.length, 7, 'alle Kandidaten probiert und verworfen');
});

test('Big-Endian-Tag: teilweise + byteorder_nicht_unterstuetzt', async () => {
  const r = await lauf(fx.pfade.byteSwap);
  pruefeSchema(r, 'byteSwap');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('byteorder_nicht_unterstuetzt'));
});

// ---------------- uasset: kaputt / boesartig ----------------

test('leere .uasset: teilweise + datei_leer, wirft nicht', async () => {
  const r = await lauf(fx.pfade.leer);
  pruefeSchema(r, 'leer');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('datei_leer'));
});

test('falsche Magic mit .uasset-Endung: fehler + tag_falsch; Zen-Kopf: teilweise + iostore_nicht_unterstuetzt', async () => {
  const r = await lauf(fx.pfade.magicFalsch);
  pruefeSchema(r, 'magicFalsch');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('magic_fehlt') && codes(r).includes('tag_falsch'));
  const z = await lauf(fx.pfade.zen);
  pruefeSchema(z, 'zen');
  assert.equal(z.status, 'teilweise');
  assert.ok(codes(z).includes('iostore_nicht_unterstuetzt'));
  assert.deepEqual(z.format_specific.zen_verdacht, { has_versioning_info: 0, header_size: 64 });
});

test('abgeschnitten (30 Bytes, Header ohne Ende): teilweise mit Code, keine Objekte, wirft nicht', async () => {
  const a = await lauf(fx.pfade.abgeschnitten30);
  pruefeSchema(a, 'ab30');
  assert.equal(a.status, 'teilweise');
  assert.deepEqual(codes(a), ['abgeschnitten']);
  const b = await lauf(fx.pfade.abgeschnittenHeader);
  pruefeSchema(b, 'abHeader');
  assert.equal(b.status, 'teilweise');
  assert.deepEqual(codes(b), ['header_groesser_als_datei']);
  assert.equal(b.objects.length, 0);
});

test('boesartige Zaehler/Offsets: NameCount 0xFFFFFFFF, ExportCount 2^31-1, Offsets und Header weit ueber Dateigroesse', async () => {
  const faelle = {
    nameCountFF: ['zaehler_unplausibel', /NameCount -1 \(als uint32 4294967295\)/],
    exportCountRiesig: ['zaehler_unplausibel', /ExportCount 2147483647/],
    offsetRiesig: ['offset_unplausibel', /Offset 2147483632/],
    headerRiesig: ['header_groesser_als_datei', /2147483647/],
  };
  for (const [k, [code, muster]] of Object.entries(faelle)) {
    const t0 = Date.now();
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'teilweise', k);
    const w = r.warnings.find(x => x.code === code);
    assert.ok(w, k + ' ' + codes(r));
    assert.match(w.message, muster, k);
    assert.equal(r.objects.length, 0, k);
    assert.ok(Date.now() - t0 < 2000, k + ' ohne grosse Allokation');
  }
});

test('absurde FString-Laengen (-2147483648, +2147483647) im FolderName: fstring_unplausibel, keine Allokation', async () => {
  for (const k of ['fstringMin', 'fstringMax']) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'teilweise', k);
    assert.deepEqual(codes(r), ['fstring_unplausibel'], k);
  }
});

test('Layout-Selbstpruefung: passt die Exporttabelle nicht zu DependsOffset, wird sie NICHT gelesen', async () => {
  const r = await lauf(fx.pfade.layoutFalsch);
  pruefeSchema(r, 'layout');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('exporttabelle_layout_unplausibel'));
  assert.equal(r.objects.filter(o => o.kind === 'export').length, 0);
  assert.equal(r.objects.filter(o => o.kind === 'import').length, 7, 'Importe sind unabhaengig bestaetigt');
});

test('zyklische OuterIndex-Verweise: terminiert, outer_zyklus, keine Paketreferenz erfunden', async () => {
  const r = await lauf(fx.pfade.zyklus, { timeoutMs: 5000 });
  pruefeSchema(r, 'zyklus');
  assert.equal(r.status, 'teilweise');
  const w = r.warnings.find(x => x.code === 'outer_zyklus');
  assert.ok(w, codes(r).join());
  assert.match(w.message, /^4 Objekte/);
  assert.equal(r.references.filter(x => x.kind === 'import').length, 0, 'keine Importwurzel erfunden');
});

test('maxObjects kappt Paket-Objekte mit Warnung', async () => {
  const r = await lauf(fx.pfade.ue427, { maxObjects: 3 });
  assert.equal(r.objects.length, 3);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('objekte_gekappt'));
});

// ---------------- pak ----------------

test('Pak v8b, flacher Index: Footer, Kompressionsnamen, Index-Hash, 3 Eintraege exakt', async () => {
  const r = await lauf(fx.pfade.pakV8);
  pruefeSchema(r, 'pakV8');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.inspector, 'unreal-pak');
  assert.equal(r.asset_type, 'archive');
  assert.equal(r.format, 'pak');
  const m = r.metadata;
  assert.equal(m.pak_version, 8);
  assert.equal(m.footer_layout, 'v8b');
  assert.equal(m.index_verschluesselt, false);
  assert.equal(m.index_hash_stimmt, true);
  assert.deepEqual(m.kompressionsmethoden, ['Zlib', 'Oodle', '', '', '']);
  assert.equal(m.mount_point, '../../../');
  assert.equal(m.eintraege_angegeben, 3);
  assert.equal(m.eintraege_gelesen, 3);
  assert.equal(m.eintraege_verschluesselt, 1);
  assert.equal(m.eintraege_komprimiert, 1);
  assert.equal(r.format_specific.footer_groesse, 221);
  assert.equal(r.format_specific.footer_position, r.size - 221);
  assert.deepEqual(r.objects.map(o => o.name), ['MyGame/Content/Props/Chair.uasset', 'MyGame/Content/Props/Chair.uexp', 'MyGame/Config/DefaultGame.ini']);
  assert.ok(r.objects.every(o => o.kind === 'pak_entry'));
  const [a, b, c] = r.objects;
  assert.deepEqual(a.source_range, { offset: 0, length: 100 });
  assert.equal(a.data.kompression, 'None');
  assert.equal(a.data.sha1, createHash('sha1').update(FX.fuell(100, 1)).digest('hex'));
  assert.equal(b.data.kompression, 'Zlib');
  assert.equal(b.data.bloecke, 2);
  assert.equal(b.data.block_groesse, 65536);
  assert.deepEqual(b.source_range, { offset: 100, length: 60 });
  assert.equal(c.data.verschluesselt, true);
  // Daten liegen am angegebenen Offset (Fixture schreibt Rohdaten ohne Eintragskopf).
  assert.deepEqual(readFileSync(fx.pfade.pakV8).subarray(100, 160), FX.fuell(60, 2));
  assert.deepEqual(r.references, []);
});

test('Pak: alle Footer-Layouts v1, v3, v7, v8a, v9 werden an ihrer Kandidatenposition gefunden', async () => {
  const erwartet = { pakV1: ['v1-3', 1, 44], pakV3: ['v1-3', 3, 44], pakV7: ['v7', 7, 61], pakV8a: ['v8a', 8, 189], pakV9: ['v9', 9, 222] };
  for (const [k, [layout, version, groesse]] of Object.entries(erwartet)) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'ok', k + ' ' + JSON.stringify(r.warnings));
    assert.equal(r.metadata.footer_layout, layout, k);
    assert.equal(r.metadata.pak_version, version, k);
    assert.equal(r.format_specific.footer_groesse, groesse, k);
    assert.equal(r.metadata.index_hash_stimmt, true, k);
  }
  const v3 = await lauf(fx.pfade.pakV3);
  assert.equal(v3.objects[1].data.kompression, 'Zlib', 'v3: ECompressionFlags 1');
  assert.deepEqual(v3.metadata.kompressionsmethoden, ['Zlib', 'Gzip', 'Custom']);
  const v7 = await lauf(fx.pfade.pakV7);
  assert.equal(v7.metadata.verschluesselungsschluessel_gesetzt, true);
  assert.match(v7.format_specific.encryption_key_guid, /^[0-9A-F]{32}$/);
  const v8a = await lauf(fx.pfade.pakV8a);
  assert.equal(v8a.objects[1].data.kompression, 'Zlib', 'v8a: Methodenindex als uint8');
});

test('Pak v11: kodierte Eintraege + FullDirectoryIndex, beide SHA-1 geprueft', async () => {
  const r = await lauf(fx.pfade.pakV11);
  pruefeSchema(r, 'pakV11');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.pak_version, 11);
  assert.equal(r.metadata.mount_point, '../../../');
  assert.equal(r.metadata.eintraege_angegeben, 3);
  assert.equal(r.metadata.unterindizes_plausibel, true);
  assert.equal(r.metadata.index_hash_stimmt, true);
  assert.equal(r.metadata.verzeichnisindex_hash_stimmt, true);
  assert.equal(r.metadata.verzeichnisse, 2);
  assert.equal(r.format_specific.path_hash_seed, String(0x1234));
  const nach = Object.fromEntries(r.objects.map(o => [o.name, o.data]));
  assert.deepEqual(Object.keys(nach).sort(), ['MyGame/Config/DefaultGame.ini', 'MyGame/Content/Props/Chair.uasset', 'MyGame/Content/Props/Chair.uexp']);
  assert.deepEqual(nach['MyGame/Content/Props/Chair.uasset'], { offset: 0, size: 100, uncompressed_size: 100, kompression: 'None', block_groesse: 0 });
  assert.equal(nach['MyGame/Content/Props/Chair.uexp'].kompression, 'Zlib');
  assert.equal(nach['MyGame/Content/Props/Chair.uexp'].bloecke, 2);
  assert.equal(nach['MyGame/Content/Props/Chair.uexp'].block_groesse, 65536);
  assert.equal(nach['MyGame/Config/DefaultGame.ini'].verschluesselt, true);
  assert.equal(nach['MyGame/Config/DefaultGame.ini'].sha1, undefined, 'kodierte Form traegt keinen SHA-1');
});

test('Pak v10 mit nicht kodierten Eintraegen (negative Lage) und v11 ohne Verzeichnisindex', async () => {
  const r = await lauf(fx.pfade.pakV10NichtKodiert);
  pruefeSchema(r, 'v10nk');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.eintraege_nicht_kodiert, 3);
  assert.equal(r.objects.length, 3);
  assert.ok(r.objects.every(o => typeof o.data.sha1 === 'string'), 'nicht kodierte Form mit SHA-1');
  const ohne = await lauf(fx.pfade.pakV11OhneVerz);
  pruefeSchema(ohne, 'ohneVerz');
  assert.equal(ohne.status, 'teilweise');
  assert.deepEqual(codes(ohne), ['index_version_nicht_unterstuetzt']);
  assert.equal(ohne.objects.length, 0);
  assert.equal(ohne.metadata.eintraege_angegeben, 3);
});

test('Pak mit verschluesseltem Index: teilweise + index_verschluesselt, kein Eintrag', async () => {
  const r = await lauf(fx.pfade.pakVerschluesselt);
  pruefeSchema(r, 'enc');
  assert.equal(r.status, 'teilweise');
  assert.deepEqual(codes(r), ['index_verschluesselt']);
  assert.equal(r.metadata.index_verschluesselt, true);
  assert.equal(r.objects.length, 0);
});

test('Pak v12 (UE 5.8): Footer wie v11, Dateinamen im Verzeichnisindex als UTF-8 (auch Umlaute)', async () => {
  const r = await lauf(fx.pfade.pakV12);
  pruefeSchema(r, 'pakV12');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.pak_version, 12);
  assert.equal(r.metadata.footer_layout, 'v12');
  assert.equal(r.format_specific.footer_groesse, 221);
  assert.equal(r.metadata.verzeichnisindex_hash_stimmt, true);
  assert.ok(r.objects.some(o => o.name === 'MyGame/Content/Grüße/Äpfel.uasset'), r.objects.map(o => o.name).join());
  assert.equal(r.objects.length, 4);
});

test('Pak mit unbekannter Version (13): teilweise + version_nicht_unterstuetzt mit gelesener Zahl', async () => {
  const r = await lauf(fx.pfade.pakUnbekannt);
  pruefeSchema(r, 'unbekannt');
  assert.equal(r.status, 'teilweise');
  const w = r.warnings.find(x => x.code === 'version_nicht_unterstuetzt');
  assert.ok(w);
  assert.match(w.message, /Version 13/);
  assert.equal(r.metadata.pak_version, 13);
});

test('Pak: Traversal-Namen geflaggt (.. und absolut), MountPoint ../../../ selbst NICHT', async () => {
  const r = await lauf(fx.pfade.pakTraversal);
  pruefeSchema(r, 'trav');
  assert.equal(r.status, 'teilweise');
  assert.deepEqual(codes(r), ['pfad_traversal']);
  assert.deepEqual(r.objects.map(o => o.data.traversal === true), [true, true, false]);
  const ok = await lauf(fx.pfade.pakV8);
  assert.ok(!codes(ok).includes('pfad_traversal'));
});

test('Pak boesartig: Index ausserhalb, Hash falsch, Eintragszahl 2^31-1, FString-Laengen extrem', async () => {
  const faelle = {
    pakIndexAusserhalb: 'index_ausserhalb',
    pakHashFalsch: 'index_hash_abweichend',
    pakAnzahlRiesig: 'zaehler_unplausibel',
    pakMountMin: 'fstring_unplausibel',
    pakMountMax: 'fstring_unplausibel',
  };
  for (const [k, code] of Object.entries(faelle)) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'teilweise', k);
    assert.ok(codes(r).includes(code), k + ' ' + codes(r));
  }
});

test('Pak: leer, fremdes Format, abgeschnittener Footer, maxObjects', async () => {
  const leer = await lauf(fx.pfade.pakLeer);
  pruefeSchema(leer, 'leer');
  assert.equal(leer.status, 'teilweise');
  assert.ok(codes(leer).includes('datei_leer'));
  for (const k of ['pakFremd', 'pakAbgeschnitten']) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'fehler', k);
    assert.deepEqual(codes(r), ['kein_unreal_pak'], k);
  }
  const viele = await lauf(fx.pfade.pakViele, { maxObjects: 10 });
  assert.equal(viele.objects.length, 10);
  assert.equal(viele.status, 'teilweise');
  assert.ok(codes(viele).includes('objekte_gekappt'));
  const alle = await lauf(fx.pfade.pakViele);
  assert.equal(alle.objects.length, 50);
});

// ---------------- IoStore ----------------

test('utoc/ucas: erkannt, teilweise + iostore_nicht_unterstuetzt, keine magic_fehlt-Warnung bei ucas', async () => {
  const t = await lauf(fx.pfade.utoc);
  pruefeSchema(t, 'utoc');
  assert.equal(t.status, 'teilweise');
  assert.equal(t.inspector, 'unreal-utoc');
  assert.deepEqual(codes(t), ['iostore_nicht_unterstuetzt']);
  assert.equal(t.metadata.utoc_version, 3);
  assert.equal(t.metadata.toc_entry_count, 5);
  assert.deepEqual(t.metadata.container_flags, ['Compressed', 'Indexed']);
  const neu = await lauf(fx.pfade.utocNeu);
  pruefeSchema(neu, 'utocNeu');
  assert.equal(neu.status, 'teilweise');
  assert.deepEqual(codes(neu), ['version_nicht_unterstuetzt']);
  assert.equal(neu.metadata.utoc_version, 9);
  assert.equal(t.metadata.ucas_vorhanden, true);
  const c = await lauf(fx.pfade.ucas);
  pruefeSchema(c, 'ucas');
  assert.equal(c.inspector, 'unreal-ucas');
  assert.deepEqual(codes(c), ['iostore_nicht_unterstuetzt']);
  assert.equal(c.metadata.utoc_vorhanden, true);
});

// ---------------- Querschnitt ----------------

test('nur lesend: sha256 und mtime aller Fixtures unveraendert, Ergebnisse deterministisch', async () => {
  for (const [k, p] of Object.entries(fx.pfade)) {
    const vorher = readFileSync(p);
    const mt = statSync(p).mtimeMs;
    const r1 = await lauf(p);
    const r2 = await lauf(p);
    pruefeSchema(r1, k);
    const ohneZeit = r => ({ ...r, extracted_at: null });
    assert.deepEqual(ohneZeit(r1), ohneZeit(r2), k + ' deterministisch');
    assert.deepEqual(readFileSync(p), vorher, k + ' unveraendert');
    assert.equal(statSync(p).mtimeMs, mt, k + ' mtime');
  }
});

test('Fixtures deterministisch: zwei Laeufe ergeben byte-gleiche Dateien', async () => {
  const zweite = await erzeugeUnrealFixtures();
  try {
    for (const k of Object.keys(fx.pfade)) {
      assert.deepEqual(readFileSync(zweite.pfade[k]), readFileSync(fx.pfade[k]), k);
    }
  } finally {
    await zweite.aufraeumen();
  }
});

// ---------------- echte Dateien ----------------

/**
 * Echte Editor-Pakete aus uasset-rs (jorgenpt/uasset-rs, MIT OR Apache-2.0), von asset-sammler2 unter
 * ASSET_SAMPLES_DIR/uasset abgelegt. Erwartete Werte stammen NICHT aus diesem Inspektor, sondern aus:
 *  - MANIFEST.json (Versionsangaben, per xxd ermittelt),
 *  - den uasset-rs-Tests (basic_parsing.rs: Namen enthalten '/Game/SimpleRefs/SimpleRefsRoot';
 *    asset_references.rs: Nicht-/Script-Importe von SimpleRefsRoot = DefaultsRef + GraphRef),
 *  - der Datei selbst (Tabellenabstaende, Exportbereiche bis Dateiende, Namen als Bytes im Namensbereich).
 */
const UASSET_PROBEN = {
  'uasset-rs_UE427_SimpleRefs_SimpleRefsRoot.uasset': { legacy: -7, ue4: 522, ue5: null, root: 'SimpleRefsRoot' },
  'uasset-rs_UE427_SimpleRefs_SimpleRefsSoftRef.uasset': { legacy: -7, ue4: 522, ue5: null, root: 'SimpleRefsSoftRef' },
  'uasset-rs_UE53_SimpleRefs_SimpleRefsGraphRef.uasset': { legacy: -8, ue4: 522, ue5: 1009, root: 'SimpleRefsGraphRef' },
  'uasset-rs_UE55_SimpleRefs_SimpleRefsRoot.uasset': { legacy: -8, ue4: 522, ue5: 1013, root: 'SimpleRefsRoot' },
};

test('GEMESSEN: 4 echte .uasset (uasset-rs, UE4.27/5.3/5.5) — Versionen, Tabellen, Exportbereiche, Namen, Importe', async t => {
  const dir = join(SAMPLES_FRUEH, 'uasset');
  const da = Object.keys(UASSET_PROBEN).filter(f => existsSync(join(dir, f)));
  if (da.length === 0) return t.skip(`keine uasset-rs-Proben unter ${dir}`);
  for (const f of da) {
    const soll = UASSET_PROBEN[f];
    const p = join(dir, f);
    const roh = readFileSync(p);
    const r = await lauf(p);
    pruefeSchema(r, f);
    assert.equal(r.status, 'ok', f + ' ' + JSON.stringify(r.warnings));
    assert.deepEqual(r.warnings, [], f);
    const m = r.metadata;
    assert.equal(m.legacy_file_version, soll.legacy, f);
    assert.equal(m.file_version_ue4, soll.ue4, f);
    assert.equal(m.file_version_ue5, soll.ue5, f);
    const o = r.format_specific.offsets;
    // Tabellen liegen lueckenlos: ImportMap endet bei ExportOffset, ExportMap bei DependsOffset
    // (sonst haette der Inspektor sie gar nicht gelesen) — hier nochmals unabhaengig nachgerechnet.
    const imp = r.objects.filter(x => x.kind === 'import');
    const exp = r.objects.filter(x => x.kind === 'export');
    assert.equal(imp.length, m.import_count, f);
    assert.equal(exp.length, m.export_count, f);
    assert.equal(o.import + imp.length * imp[0].source_range.length, o.export, f + ' Importtabelle endet bei ExportOffset');
    assert.equal(U.exportGroesse(m.file_version_ue4, m.file_version_ue5) * exp.length, o.depends - o.export, f + ' Exporttabelle endet bei DependsOffset');
    // Exportdaten: beginnen am Header-Ende, liegen lueckenlos hintereinander, enden vor dem Dateiende.
    assert.equal(exp[0].data.serial_offset, m.header_groesse, f + ' erster Export am Header-Ende');
    for (let i = 1; i < exp.length; i++) {
      assert.equal(exp[i].data.serial_offset, exp[i - 1].data.serial_offset + exp[i - 1].data.serial_size, f + ' Export ' + i + ' lueckenlos');
    }
    const ende = exp.at(-1).data.serial_offset + exp.at(-1).data.serial_size;
    assert.ok(ende <= r.size, f + ' letzter Export in der Datei');
    if (soll.ue5 === null) {
      // UE4-Editorpakete enden nach den Exportdaten mit dem Paket-Tag (4 Bytes).
      assert.equal(ende + 4, r.size, f + ' Tag am Dateiende');
      assert.equal(roh.readUInt32LE(r.size - 4), U.PACKAGE_FILE_TAG, f);
    }
    // Namen: jeder gelesene Name steht als Bytes im Namensbereich der Datei.
    const namensBereich = roh.subarray(o.name, o.import);
    for (const n of r.format_specific.names_vorschau) assert.ok(namensBereich.includes(Buffer.from(n + '\0', 'latin1')), f + ' Name im Bereich: ' + n);
    assert.equal(r.format_specific.names_vorschau.length, Math.min(100, m.name_count), f);
    // Wurzelexport ist das Blueprint-Asset, die erzeugte Klasse heisst <root>_C.
    assert.equal(exp[0].name, soll.root, f);
    assert.equal(exp[0].data.class, 'Blueprint', f);
    assert.equal(exp[0].data.is_asset, true, f);
    assert.ok(exp.some(x => x.name === soll.root + '_C' && x.data.class === 'BlueprintGeneratedClass'), f);
    // Paketname ab UE5 im Summary (FolderName/PackageName).
    if (soll.ue5 !== null) assert.equal(m.folder_name, '/Game/SimpleRefs/' + soll.root, f);
    if (soll.root === 'SimpleRefsRoot') {
      // uasset-rs basic_parsing.rs: Namen enthalten den Asset-Pfad.
      assert.ok(namensBereich.includes(Buffer.from('/Game/SimpleRefs/SimpleRefsRoot\0', 'latin1')), f);
      // uasset-rs asset_references.rs: Nicht-/Script-Importe.
      const game = r.references.map(x => x.target).filter(x => !x.startsWith('/Script/')).sort();
      assert.deepEqual(game, ['/Game/SimpleRefs/SimpleRefsDefaultsRef', '/Game/SimpleRefs/SimpleRefsGraphRef'], f);
    }
    t.diagnostic(`${f}: ${m.engine_band} ue5=${m.file_version_ue5} namen=${m.name_count} importe=${m.import_count} exporte=${m.export_count} header=${m.header_groesse} refs=${r.references.length}`);
  }
});

/** Echte, NICHT von Unreal stammende .pak-Dateien (Chromium/QtWebEngine-Ressourcen). */
function fremdePaks() {
  const kandidaten = [];
  const qt = '/usr/share/qt6/translations/qtwebengine_locales';
  if (existsSync(qt)) for (const f of readdirSync(qt).filter(f => f.endsWith('.pak')).slice(0, 3)) kandidaten.push(join(qt, f));
  const pw = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (existsSync(pw)) {
    for (const d of readdirSync(pw)) {
      const p = join(pw, d, 'chrome-headless-shell-linux64', 'headless_lib_data.pak');
      if (existsSync(p)) kandidaten.push(p);
    }
  }
  return kandidaten.slice(0, 5);
}

test('GEMESSEN: echte Chromium/Qt-.pak (fremdes Format, gleiche Endung) -> fehler + kein_unreal_pak', async t => {
  const paks = fremdePaks();
  if (paks.length === 0) return t.skip('keine Chromium/Qt-.pak auf diesem System');
  for (const p of paks) {
    const r = await lauf(p);
    pruefeSchema(r, p);
    assert.equal(r.status, 'fehler', p);
    assert.deepEqual(codes(r), ['kein_unreal_pak'], p);
  }
});

const SAMPLES = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');

/**
 * Gegenprobe an der Datei selbst: Am Eintrags-Offset steht der Eintragskopf (FPakEntry, unkomprimiert
 * 53 Bytes), dahinter die Daten. Der SHA-1 der Daten muss zum SHA-1 im Kopf passen, und die im Kopf
 * stehenden Groessen zu dem, was der Inspektor aus dem Index gelesen hat.
 */
function pruefeEintragImPak(pfad, o, wo) {
  const roh = readFileSync(pfad);
  const k = roh.subarray(o.data.offset, o.data.offset + 53);
  assert.equal(Number(k.readBigInt64LE(8)), o.data.size, wo + ' Kopf.Size');
  assert.equal(Number(k.readBigInt64LE(16)), o.data.uncompressed_size, wo + ' Kopf.UncompressedSize');
  const daten = roh.subarray(o.data.offset + 53, o.data.offset + 53 + o.data.size);
  const ist = createHash('sha1').update(daten).digest('hex');
  assert.equal(ist, k.subarray(28, 48).toString('hex'), wo + ' SHA-1 Daten = SHA-1 im Eintragskopf');
  return ist;
}

test('GEMESSEN: echte repak-Testpaks (v5, v11, v11 komprimiert, v11 verschluesselt) — Index, Hashes, Eintraege', async t => {
  const p = n => join(SAMPLES, 'pak', n);
  if (!['pack_v5.pak', 'pack_v11.pak', 'pack_v11_compress.pak', 'pack_v11_encryptindex.pak'].every(n => existsSync(p(n)))) {
    return t.skip(`repak-Testpaks fehlen unter ${SAMPLES}/pak`);
  }
  const erwartet = ['directory/nested.txt', 'test.png', 'test.txt', 'zeros.bin'];
  const v5 = await lauf(p('pack_v5.pak'));
  pruefeSchema(v5, 'v5');
  assert.equal(v5.status, 'ok', JSON.stringify(v5.warnings));
  assert.equal(v5.metadata.pak_version, 5);
  assert.equal(v5.metadata.footer_layout, 'v5');
  assert.equal(v5.metadata.index_hash_stimmt, true, 'Footer-Layout + Index-SHA-1 an Fremddatei bestaetigt');
  assert.equal(v5.metadata.mount_point, '../mount/point/root/');
  assert.deepEqual(v5.objects.map(o => o.name), erwartet);
  const sha = {};
  for (const o of v5.objects) {
    sha[o.name] = pruefeEintragImPak(p('pack_v5.pak'), o, 'v5 ' + o.name);
    assert.equal(o.data.sha1, sha[o.name], 'v5 Index-SHA-1 = Daten-SHA-1');
  }

  const v11 = await lauf(p('pack_v11.pak'));
  pruefeSchema(v11, 'v11');
  assert.equal(v11.status, 'ok', JSON.stringify(v11.warnings));
  assert.equal(v11.metadata.index_hash_stimmt, true);
  assert.equal(v11.metadata.verzeichnisindex_hash_stimmt, true);
  assert.deepEqual(v11.objects.map(o => o.name).sort(), erwartet);
  // Kodierte Eintraege: gleicher Inhalt wie v5, also gleiche Daten-SHA-1 hinter dem Eintragskopf.
  for (const o of v11.objects) assert.equal(pruefeEintragImPak(p('pack_v11.pak'), o, 'v11 ' + o.name), sha[o.name], 'v11 ' + o.name);

  const c = await lauf(p('pack_v11_compress.pak'));
  pruefeSchema(c, 'v11c');
  assert.equal(c.status, 'ok', JSON.stringify(c.warnings));
  assert.equal(c.metadata.eintraege_komprimiert, 2);
  assert.deepEqual(c.metadata.kompressionsmethoden.filter(Boolean), ['Zlib']);
  const cn = Object.fromEntries(c.objects.map(o => [o.name, o.data]));
  assert.equal(cn['test.png'].kompression, 'Zlib');
  assert.equal(cn['test.png'].uncompressed_size, 10257);
  assert.ok(cn['test.png'].size < 10257);
  assert.equal(cn['test.txt'].kompression, 'None');

  const e = await lauf(p('pack_v11_encryptindex.pak'));
  pruefeSchema(e, 'v11e');
  assert.equal(e.status, 'teilweise');
  assert.deepEqual(codes(e), ['index_verschluesselt']);
  assert.equal(e.objects.length, 0);
});
function echteProben() {
  const out = [];
  for (const sub of ['uasset', 'umap', 'pak', 'utoc', 'ucas', 'unreal']) {
    const d = join(SAMPLES, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/\.(uasset|umap|pak|utoc|ucas)$/i.test(f)) out.push(join(d, f));
  }
  return out;
}

test('GEMESSEN (optional): echte Unreal-Proben aus ASSET_SAMPLES_DIR — wirft nie, Schema, Status mit Begruendung', async t => {
  const proben = echteProben();
  if (proben.length === 0) return t.skip(`keine Unreal-Proben unter ${SAMPLES}`);
  for (const p of proben) {
    const r = await lauf(p);
    pruefeSchema(r, p);
    assert.ok(r.inspector && r.inspector.startsWith('unreal-'), p);
    assert.ok(['ok', 'teilweise'].includes(r.status), p + ' ' + r.status + ' ' + codes(r));
    if (r.status !== 'ok') assert.ok(r.warnings.length > 0, p);
    t.diagnostic(`${p}: ${r.status} ${codes(r).join(',')} objekte=${r.objects.length}`);
  }
});


// ---------------- ECHT UE 5.8.3 (eigene, mit der Engine erzeugte Dateien) ----------------

/**
 * Testdaten von asset-unreal-erzeuger (UE 5.8.3, eigenes Projekt AssetProbe). Erwartete Werte stammen
 * aus der ENGINE, nicht aus diesem Inspektor:
 *  - engine-sicht-pkginfo.json: UnrealEditor-Cmd -run=PkgInfo -all (Namen, Importe, Exporte mit
 *    SerialSize/Offset, referenzierte Pakete, SavedHash) fuer alle 24 .uasset/.umap,
 *  - engine-sicht.json: AssetRegistry (harte Abhaengigkeiten der Editor-Pakete),
 *  - engine-sicht-pak.json: UnrealPak -List (Eintraege mit Offset, Groesse, Kompression).
 * Fehlt das Verzeichnis: skip.
 */
const EIGEN = process.env.ASSET_UNREAL_EIGEN_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'unreal-eigen'].join('/');
const ohneOuterPfad = s => (s ? s.split(/[.:]/).pop() : '');

test('ECHT UE 5.8.3: alle .uasset/.umap gegen PkgInfo + AssetRegistry (Namen, Importe, Exporte, Referenzen)', async t => {
  const datei = join(EIGEN, 'engine-sicht-pkginfo.json');
  if (!existsSync(datei)) return t.skip(`keine Engine-Sicht unter ${EIGEN}`);
  const pk = JSON.parse(readFileSync(datei, 'utf8')).pakete;
  const ar = JSON.parse(readFileSync(join(EIGEN, 'engine-sicht.json'), 'utf8')).pakete;
  let geprueft = 0;
  for (const [rel, e] of Object.entries(pk)) {
    const p = join(EIGEN, rel);
    if (!existsSync(p)) continue;
    const r = await lauf(p);
    pruefeSchema(r, rel);
    assert.equal(r.status, 'ok', rel + ' ' + JSON.stringify(r.warnings));
    const m = r.metadata;
    assert.equal(m.legacy_file_version, -9, rel);
    assert.equal(m.name_count, e.name_count, rel + ' NameCount');
    assert.equal(m.import_count, e.import_count, rel + ' ImportCount');
    assert.equal(m.export_count, e.export_count, rel + ' ExportCount');
    assert.equal(r.format_specific.offsets.name, e.name_offset ?? r.format_specific.offsets.name, rel);
    if (e.saved_hash) assert.equal(r.format_specific.saved_hash, e.saved_hash.toLowerCase(), rel + ' SavedHash');
    assert.equal(parseInt(e.package_flags, 16) >>> 0, parseInt(m.package_flags, 16) >>> 0, rel + ' PackageFlags');
    // Namen: Reihenfolge der ersten 100 identisch, jeder Engine-Name steht als FString im Namensbereich.
    assert.deepEqual(r.format_specific.names_vorschau, e.names.slice(0, 100), rel + ' Namen');
    const roh = readFileSync(p);
    const bereich = roh.subarray(r.format_specific.offsets.name, r.format_specific.offsets.import);
    for (const n of e.names) assert.ok(bereich.includes(Buffer.from(n + '\0', 'latin1')) || /[^\x00-\x7f]/.test(n), rel + ' Name ' + n);
    const imp = r.objects.filter(o => o.kind === 'import');
    const exp = r.objects.filter(o => o.kind === 'export');
    e.imports.forEach((ei, i) => {
      const o = imp[i];
      assert.equal(o.name, ei.name, `${rel} imp${i}.name`);
      assert.equal(o.data.class_name, ei.class, `${rel} imp${i}.class`);
      assert.equal(o.data.class_package, ei.class_package, `${rel} imp${i}.class_package`);
      assert.equal(o.data.outer ?? '', ei.outer_index === 0 ? '' : ohneOuterPfad(ei.outer), `${rel} imp${i}.outer`);
    });
    e.exports.forEach((ee, i) => {
      const o = exp[i];
      assert.equal(o.name, ee.name, `${rel} exp${i}.name`);
      assert.equal(o.data.class ?? '', ee.class, `${rel} exp${i}.class`);
      assert.equal(o.data.outer ?? '', ee.outer_index === 0 ? '' : ohneOuterPfad(ee.outer), `${rel} exp${i}.outer`);
      assert.equal(o.data.serial_size, ee.serial_size, `${rel} exp${i}.serial_size`);
      assert.equal(o.data.serial_offset, ee.serial_offset, `${rel} exp${i}.serial_offset`);
    });
    // Referenzen (Importwurzeln + Klassenpakete) = PkgInfo 'referenzierte Pakete'.
    assert.deepEqual(r.references.map(x => x.target).sort(), [...e.referenzierte_pakete].sort(), rel + ' Referenzen');
    // AssetRegistry: harte Abhaengigkeiten ausserhalb /Script = unsere Nicht-/Script-Referenzen (nur Editor-Pakete).
    const a = ar.find(x => x.package === m.folder_name);
    if (a && rel.includes('editor')) {
      const hart = a.abhaengigkeiten_hart.filter(x => !x.startsWith('/Script/')).sort();
      const uns = r.references.map(x => x.target).filter(x => !x.startsWith('/Script/')).sort();
      assert.deepEqual(uns, hart, rel + ' AssetRegistry');
    }
    if (rel.startsWith('uexp/')) {
      assert.equal(m.cooked, true, rel);
      assert.equal(r.format_specific.uexp.groesse_stimmt, true, rel + ' .uexp-Groesse = Exportdaten + Tag');
      assert.ok(exp.every(o => o.data.in_uexp === true), rel + ' Exporte in der .uexp');
    }
    if (rel.includes('unversioniert')) {
      assert.equal(m.unversioniert, true, rel);
      assert.equal(m.layout_angenommen.file_version_ue5, 1018, rel);
      assert.deepEqual(codes(r), ['unversioniert_layout_angenommen', 'properties_ohne_mappings'], rel);
    } else {
      assert.equal(m.file_version_ue5, 1018, rel);
      assert.deepEqual(codes(r), [], rel);
    }
    geprueft++;
    t.diagnostic(`${rel}: N ${m.name_count}/${e.name_count} I ${imp.length}/${e.import_count} E ${exp.length}/${e.export_count} refs ${r.references.length}/${e.referenzierte_pakete.length}`);
  }
  assert.equal(geprueft, Object.keys(pk).length, 'alle Pakete der Engine-Sicht vorhanden und geprueft');
});

test('ECHT UE 5.8.3: .uexp (16) — Begleitdatei, End-Tag', async t => {
  const dirs = ['uexp/gecookt-versioniert', 'uexp/gecookt-unversioniert'].map(d => join(EIGEN, d)).filter(existsSync);
  if (dirs.length === 0) return t.skip(`keine .uexp unter ${EIGEN}`);
  let n = 0;
  for (const d of dirs) {
    for (const f of readdirSync(d).filter(f => f.endsWith('.uexp'))) {
      const r = await lauf(join(d, f));
      pruefeSchema(r, f);
      assert.equal(r.inspector, 'unreal-uexp', f);
      assert.equal(r.status, 'ok', f + ' ' + JSON.stringify(r.warnings));
      assert.equal(r.metadata.end_tag, true, f);
      assert.equal(r.metadata.begleitdatei_vorhanden, true, f);
      n++;
    }
  }
  assert.equal(n, 16);
});

test('ECHT UE 5.8.3: Pak v12 gegen UnrealPak -List (Offset, Groesse, Kompression), verschluesselt erkannt', async t => {
  const datei = join(EIGEN, 'engine-sicht-pak.json');
  if (!existsSync(datei)) return t.skip(`keine Pak-Engine-Sicht unter ${EIGEN}`);
  const paks = JSON.parse(readFileSync(datei, 'utf8')).paks;
  for (const [rel, e] of Object.entries(paks)) {
    const r = await lauf(join(EIGEN, rel));
    pruefeSchema(r, rel);
    assert.equal(r.metadata.pak_version, 12, rel);
    assert.equal(r.metadata.footer_layout, 'v12', rel);
    if (r.metadata.index_verschluesselt) {
      assert.equal(r.status, 'teilweise', rel);
      assert.deepEqual(codes(r), ['index_verschluesselt'], rel);
      assert.ok(/verschluesselt/.test(rel), rel);
      continue;
    }
    assert.equal(r.status, 'ok', rel + ' ' + JSON.stringify(r.warnings));
    assert.equal(r.metadata.index_hash_stimmt, true, rel);
    assert.equal(r.metadata.verzeichnisindex_hash_stimmt, true, rel);
    assert.equal(r.objects.length, e.anzahl, rel + ' Anzahl');
    for (const ee of e.eintraege) {
      const o = r.objects.find(x => x.name === ee.pfad);
      assert.ok(o, `${rel}: ${ee.pfad} fehlt`);
      assert.equal(o.data.offset, ee.offset, `${rel} ${ee.pfad} offset`);
      assert.equal(o.data.size, ee.groesse, `${rel} ${ee.pfad} groesse`);
      assert.equal(o.data.kompression, ee.kompression, `${rel} ${ee.pfad} kompression`);
    }
    t.diagnostic(`${rel}: ${r.objects.length}/${e.anzahl} Eintraege, ${r.metadata.eintraege_komprimiert} komprimiert`);
  }
});

test('ECHT UE 5.8.3: utoc v8 (Eintragszahl, Container-Flags), ucas erkannt', async t => {
  const d = join(EIGEN, 'utoc-ucas');
  if (!existsSync(d)) return t.skip(`kein utoc-ucas unter ${EIGEN}`);
  const soll = {
    'global.utoc': [1, []],
    'AssetProbe-Linux.utoc': [9, ['Indexed']],
    'AssetProbe-Linux-zlib.utoc': [9, ['Compressed', 'Indexed']],
    'AssetProbe-Linux-verschluesselt.utoc': [9, ['Compressed', 'Encrypted', 'Indexed']],
  };
  for (const [f, [anzahl, flags]] of Object.entries(soll)) {
    const r = await lauf(join(d, f));
    pruefeSchema(r, f);
    assert.equal(r.metadata.utoc_version, 8, f);
    assert.equal(r.metadata.toc_entry_count, anzahl, f);
    assert.deepEqual(r.metadata.container_flags, flags, f);
    assert.deepEqual(codes(r), ['iostore_nicht_unterstuetzt'], f);
    const c = await lauf(join(d, f.replace('.utoc', '.ucas')));
    assert.equal(c.inspector, 'unreal-ucas', f);
    assert.equal(c.metadata.utoc_vorhanden, true, f);
  }
});
