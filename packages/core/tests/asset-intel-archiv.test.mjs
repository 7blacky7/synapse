/**
 * Asset-Intel Archiv-Inspektoren (P4-T66 Teil a): ZIP, TAR(+gzip), 7z, SQLite gegen gebautes dist.
 *
 * GEMESSEN (gegen ECHTE, von Fremdwerkzeugen erzeugte Dateien, mit Gegenmessung durch das Werkzeug selbst):
 *   python3-zipfile / 7z / unzip -Z1, tar -tvf, 7z l -slt, sqlite3 (pragma table_info / foreign_key_list / count(*)).
 *   Optional zusaetzlich die Proben von asset-sammler (ASSET_SAMPLES_DIR, Standard ~/dev/synapse-testdaten/asset-samples).
 * NUR GEGEN DIE SPEZIFIKATION (handgebaut): ZIP64-Randfaelle, Selbstextraktor-Praefix, Traversal-Namen, Bomben,
 *   TAR-Langnamen/pax/base-256, 7z-Header, SQLite-Zyklus/defekte Zellen. Das steht in den Testnamen ("[SPEC]").
 *
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-archiv/dist node --test packages/core/tests/asset-intel-archiv.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const Z = await import(join(dist, 'asset-intel', 'inspectors', 'archiv', 'index.js'));
const { inspectAsset, AssetRegistry } = A;
// Grundschicht-Stand von generic-binary (zip/gzip/7z-Magic, vor der Verdrahtung) fuer die dokumentierten Kollisionsfaelle.
const genericBinaryInspector = {
  ...A.genericBinaryInspector,
  formats: ['zip', 'gzip', '7z'],
  magic: [
    { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], format: 'zip' },
    { offset: 0, bytes: [0x1f, 0x8b], format: 'gzip' },
    { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], format: '7z' },
  ],
};
const { assetArchivInspektoren } = Z;
const G = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-archiv.mjs')).href);

const MIB = 1024 * 1024;
const GZ_KAPPE = 16 * MIB;
const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];

const reg = new AssetRegistry();
for (const i of assetArchivInspektoren) reg.register(i);

const pruefe = (pfad, opts = {}) => inspectAsset(pfad, { registry: reg, ...opts });
const codes = r => r.warnings.map(w => w.code);
const namen = r => r.objects.map(o => o.name);
const objekt = (r, name) => {
  const o = r.objects.find(x => x.name === name);
  assert.ok(o, `Objekt "${name}" fehlt; vorhanden: ${namen(r).slice(0, 12).join(' | ')}`);
  return o;
};
const sha = pfad => createHash('sha256').update(readFileSync(pfad)).digest('hex');
const hex8 = n => n.toString(16).padStart(8, '0');
const KAPUTT_CODES = ['inspektor_fehler', 'interner_fehler'];

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, wo + ': Feld fehlt: ' + k);
  assert.equal(typeof r.asset_type, 'string', wo);
  assert.ok(r.format === null || typeof r.format === 'string', wo + ' format');
  assert.ok(Number.isInteger(r.size) && r.size >= 0, wo + ' size');
  assert.ok(r.sha256 === null || /^[0-9a-f]{64}$/.test(r.sha256), wo + ' sha256');
  assert.ok(['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'].includes(r.status), wo + ' status');
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), wo + ' ' + k);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), wo + ' ' + k);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', wo + ' warning-Form');
  for (const o of r.objects) {
    assert.ok(typeof o.kind === 'string' && o.kind, wo + ' Objekt.kind');
    assert.ok(o.name === null || typeof o.name === 'string', wo + ' Objekt.name');
    assert.ok(o.data && typeof o.data === 'object', wo + ' Objekt.data');
    assert.ok(o.source_range && Number.isSafeInteger(o.source_range.offset) && Number.isSafeInteger(o.source_range.length), wo + ' source_range ' + JSON.stringify(o.source_range));
  }
  for (const x of r.references) assert.ok(typeof x.target === 'string' && typeof x.kind === 'string', wo + ' reference');
  assert.ok(Number.isInteger(r.parser_version) && r.parser_version >= 1, wo + ' parser_version');
  JSON.stringify(r);
}

let fx;
before(async () => {
  fx = await G.erzeugeArchivFixtures();
});
after(async () => {
  await fx.aufraeumen();
});

/** Ueberspringt den Test, wenn ein Werkzeug fehlt (nichts wird installiert). */
function braucht(t, ...werkzeuge) {
  const fehlt = werkzeuge.filter(w => !fx.werkzeuge[w]);
  if (fehlt.length) {
    t.skip('Werkzeug fehlt: ' + fehlt.join(', '));
    return true;
  }
  return false;
}
const P = n => fx.pfade[n];
const unzipNamen = pfad => execFileSync('unzip', ['-Z1', pfad]).toString().split('\n').filter(Boolean);

// =============================================================== ZIP: echte Dateien (GEMESSEN)

test('ZIP echt (python3-zipfile): jedes Feld exakt gegen die Fremdwerkzeug-Metadaten', async t => {
  if (braucht(t, 'python3')) return;
  const man = fx.erwartet.zipManifest['echt.zip'];
  const r = await pruefe(P('zip:echt.zip'));
  pruefeSchema(r, 'echt.zip');
  assert.equal(r.status, 'ok');
  assert.equal(r.format, 'zip');
  assert.equal(r.inspector, 'archiv-zip');
  assert.equal(r.asset_type, 'archive');
  assert.deepEqual(namen(r), man.map(m => m.name));
  man.forEach((m, i) => {
    const d = r.objects[i].data;
    assert.equal(d.komprimiert, m.comp, m.name + ' komprimiert');
    assert.equal(d.unkomprimiert, m.size, m.name + ' unkomprimiert');
    assert.equal(d.crc32, hex8(m.crc), m.name + ' crc');
    assert.equal(d.methode, m.method, m.name + ' methode');
    assert.equal(d.utf8, (m.flags & 0x800) !== 0, m.name + ' utf8-Flag');
    assert.equal(d.verzeichnis, m.name.endsWith('/'), m.name + ' verzeichnis');
    assert.equal(d.verschluesselt, false);
    assert.equal(d.pfad_gefaehrlich, false);
    assert.equal(d.mtime, '2020-01-02T03:04:06');
  });
  assert.equal(r.metadata.eintraege_gesamt, 5);
  assert.equal(r.metadata.dateien, 4);
  assert.equal(r.metadata.verzeichnisse, 1);
  assert.equal(r.metadata.kommentar, 'Testkommentar');
  assert.equal(r.metadata.zip64, false);
  assert.equal(r.metadata.praefix_bytes, 0);
  assert.equal(r.metadata.bombe_verdacht, false);
  assert.equal(r.metadata.hint, null);
  assert.deepEqual(r.warnings, []);
  // source_range zeigt auf den Verzeichnissatz: dort steht die Signatur PK\1\2 und der Name.
  const roh = readFileSync(P('zip:echt.zip'));
  for (const o of r.objects) {
    assert.equal(roh.readUInt32LE(o.source_range.offset), 0x02014b50);
    assert.ok(roh.subarray(o.source_range.offset, o.source_range.offset + o.source_range.length).includes(Buffer.from(o.name, 'utf8')));
  }
});

test('ZIP echt: Namen entsprechen `unzip -Z1` (python3, 7z, mit Unicode und Verzeichnissen)', async t => {
  if (braucht(t, 'unzip', 'python3')) return;
  for (const f of ['echt.zip', 'verschachtelt.zip', 'symlinks.zip', 'viele.zip', 'doppelt.zip', 'hint-odt.zip']) {
    const r = await pruefe(P('zip:' + f));
    assert.deepEqual(namen(r), unzipNamen(P('zip:' + f)), f);
  }
  if (fx.werkzeuge['7z']) {
    const r = await pruefe(P('zip:sevenz.zip'));
    assert.equal(r.status, 'ok');
    assert.deepEqual(namen(r), unzipNamen(P('zip:sevenz.zip')), 'von 7z erzeugtes ZIP');
  }
});

test('ZIP echt (python3): ZIP64-Extra (force_zip64) liefert dieselben Groessen wie das Werkzeug', async t => {
  if (braucht(t, 'python3')) return;
  const man = fx.erwartet.zipManifest['zip64-echt.zip'];
  const r = await pruefe(P('zip:zip64-echt.zip'));
  assert.deepEqual(namen(r), man.map(m => m.name));
  man.forEach((m, i) => {
    assert.equal(r.objects[i].data.unkomprimiert, m.size);
    assert.equal(r.objects[i].data.komprimiert, m.comp);
    assert.equal(r.objects[i].data.crc32, hex8(m.crc));
  });
});

test('ZIP echt (python3, >65535 Eintraege => echter ZIP64-Endsatz): 70000 Eintraege gezaehlt', async t => {
  if (braucht(t, 'python3')) return;
  const r = await pruefe(P('zip:viele64.zip'));
  assert.equal(r.metadata.zip64, true);
  assert.notEqual(r.format_specific.zip64_eocd_offset, null);
  assert.equal(r.metadata.eintraege_gesamt, 70000);
  assert.equal(r.metadata.eintraege_gelesen, 70000);
  assert.equal(r.objects.length, 10_000); // Standard-maxObjects
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.equal(r.status, 'teilweise');
});

test('ZIP echt: Hinweise JAR/WAR/APK/DOCX/XLSX/ODT/EPUB nur aus Eintragsnamen (kein usdz-Eingriff)', async t => {
  if (braucht(t, 'python3')) return;
  const erwartet = { 'hint-jar.zip': 'jar', 'hint-war.zip': 'war', 'hint-apk.zip': 'apk', 'hint-docx.zip': 'docx', 'hint-xlsx.zip': 'xlsx', 'hint-odt.zip': 'odt', 'hint-epub.zip': 'epub', 'hint-keins.zip': null };
  for (const [f, hint] of Object.entries(erwartet)) {
    const r = await pruefe(P('zip:' + f));
    assert.equal(r.status, 'ok', f);
    assert.equal(r.metadata.hint, hint, f);
    assert.equal(r.format, 'zip', f + ': Format bleibt zip, der Hinweis steht nur in metadata.hint');
  }
  assert.ok(!A.getRegisteredFormats(reg).includes('usdz'), 'usdz gehoert asset-dcc');
  assert.ok(!assetArchivInspektoren.some(i => i.extensions.some(e => e.includes('usdz'))), 'Endung .usdz nicht beansprucht');
});

test('ZIP echt: Verschluesselung (ZipCrypto, WinZip-AES) wird erkannt und gemeldet', async t => {
  if (braucht(t, '7z')) return;
  const zc = await pruefe(P('zip:zipcrypto.zip'));
  assert.ok(codes(zc).includes('archiv_verschluesselt'));
  assert.equal(zc.objects[0].data.verschluesselt, true);
  assert.equal(zc.metadata.verschluesselte_eintraege, 1);
  assert.equal(zc.objects[0].name, 'quelle/a.txt'); // Name bleibt lesbar
  const aes = await pruefe(P('zip:aes.zip'));
  assert.ok(codes(aes).includes('archiv_verschluesselt'));
  assert.equal(aes.objects[0].data.methode, 99);
  assert.equal(aes.objects[0].data.aes_staerke, 256);
  assert.ok([0, 8].includes(aes.objects[0].data.methode_eigentlich), 'eigentliche Methode aus dem AES-Extra');
});

test('ZIP echt: verschachtelte Archive nur gemeldet (Endung UND Magic), nie geoeffnet', async t => {
  if (braucht(t, 'python3')) return;
  const r = await pruefe(P('zip:verschachtelt.zip'));
  assert.deepEqual(r.references.map(x => x.target).sort(), ['beilage/inner.zip', 'ohne_endung', 'pakete/x.tar.gz']);
  assert.ok(r.references.every(x => x.kind === 'archiv_inhalt'));
  assert.equal(objekt(r, 'beilage/inner.zip').data.verschachtelt.art, 'endung');
  assert.equal(objekt(r, 'ohne_endung').data.verschachtelt.art, 'magic', 'Magic des Inhalts (gespeicherter Eintrag)');
  assert.equal(objekt(r, 'ohne_endung').data.verschachtelt.format, 'zip');
  assert.equal(objekt(r, 'daten.bin').data.verschachtelt, undefined);
  assert.equal(r.metadata.verschachtelte_archive, 3);
  assert.ok(!namen(r).includes('innen.txt'), 'der Inhalt des inneren Archivs wird NICHT aufgelistet');
  assert.ok(codes(r).includes('verschachtelte_archive'));
});

test('ZIP echt: Symlinks (Unix-Modus) erkannt, Ziel ausserhalb gemeldet, Ziel innerhalb nicht', async t => {
  if (braucht(t, 'python3')) return;
  const r = await pruefe(P('zip:symlinks.zip'));
  assert.equal(objekt(r, 'lnk_innen').data.symlink, true);
  assert.equal(objekt(r, 'lnk_aussen').data.symlink_ziel, '../../etc/passwd');
  const aussen = r.warnings.filter(w => w.code === 'link_ziel_ausserhalb').map(w => w.message);
  assert.equal(aussen.length, 2);
  assert.ok(aussen.some(m => m.includes('lnk_aussen')) && aussen.some(m => m.includes('lnk_abs')));
  assert.ok(!aussen.some(m => m.includes('lnk_innen')));
  assert.equal(objekt(r, 'ziel/ok.txt').data.symlink, false);
});

test('ZIP echt: doppelte Namen (auch nur durch Gross-/Kleinschreibung) werden gemeldet', async t => {
  if (braucht(t, 'python3')) return;
  const r = await pruefe(P('zip:doppelt.zip'));
  assert.ok(codes(r).includes('doppelte_eintragsnamen'));
  assert.equal(r.objects.length, 3);
});

test('ZIP echt: leeres ZIP (nur Endsatz) => ok, 0 Eintraege', async t => {
  if (braucht(t, 'python3')) return;
  const r = await pruefe(P('zip:leer.zip'));
  assert.equal(r.status, 'ok');
  assert.equal(r.inspector, 'archiv-zip');
  assert.equal(r.metadata.eintraege_gesamt, 0);
  assert.deepEqual(r.objects, []);
});

// =============================================================== ZIP: Hand-Fixtures [SPEC]

test('ZIP [SPEC]: handgebautes ZIP, Felder exakt (Methode 0/8, Verzeichnis, CRC, Zeit)', async () => {
  const r = await pruefe(P('zipHandKlein'));
  assert.equal(r.status, 'ok');
  assert.deepEqual(namen(r), ['ordner/', 'ordner/a.txt', 'b.bin']);
  const a = objekt(r, 'ordner/a.txt').data;
  assert.equal(a.unkomprimiert, 120);
  assert.equal(a.methode, 8);
  assert.equal(a.methode_name, 'deflate');
  assert.equal(a.crc32, hex8(G.crc32(Buffer.from('alpha\n'.repeat(20)))));
  assert.equal(a.mtime, '2020-01-02T03:04:06');
  assert.equal(objekt(r, 'ordner/').data.verzeichnis, true);
  assert.equal(objekt(r, 'b.bin').data.methode_name, 'gespeichert');
  assert.equal(objekt(r, 'b.bin').data.lokaler_header_offset, 37 + (30 + 12) + a.komprimiert, '"ordner/" (37) + lokaler Kopf von a.txt (42) + dessen Daten');
  assert.equal(objekt(r, 'ordner/a.txt').data.lokaler_header_offset, 37);
  assert.equal(r.metadata.zip64, false);
});

test('ZIP [SPEC] SICHERHEIT: Path Traversal (.., absolut, Laufwerk, Backslash, UNC, Null-Byte) je Eintrag Flag + Warnung', async () => {
  const r = await pruefe(P('zipTraversal'));
  const gefahr = n => objekt(r, n).data;
  assert.equal(gefahr('ok/fine.txt').pfad_gefaehrlich, false);
  assert.equal(gefahr('punkte../name.txt').pfad_gefaehrlich, false, '"punkte.." ist kein ..-Segment');
  assert.deepEqual(gefahr('../../evil.txt').gefahr, ['traversal']);
  assert.deepEqual(gefahr('/etc/passwd').gefahr, ['absolut']);
  assert.deepEqual(gefahr('C:\\Windows\\system32\\x.dll').gefahr, ['laufwerk']);
  assert.deepEqual(gefahr('..\\..\\boot.ini').gefahr, ['traversal']);
  assert.deepEqual(gefahr('a/../../b.txt').gefahr, ['traversal']);
  assert.deepEqual(gefahr('\\\\server\\share\\x').gefahr, ['unc']);
  const nullName = r.objects.find(o => o.data.gefahr.includes('null_byte'));
  assert.ok(nullName, 'Eintrag mit Null-Byte erkannt');
  assert.ok(!nullName.name.includes('\0'), 'Null-Byte steht nicht roh im Namen');
  assert.ok(nullName.name.includes('\\x00'), 'Null-Byte sichtbar escaped');
  assert.ok(nullName.data.gefahr.includes('traversal'));
  const flagged = r.objects.filter(o => o.data.pfad_gefaehrlich).length;
  assert.equal(flagged, 8);
  assert.equal(r.metadata.gefaehrliche_pfade, 8);
  assert.equal(r.warnings.filter(w => w.code === 'pfad_gefaehrlich').length, 8, 'eine Warnung je Eintrag');
});

test('ZIP [SPEC] SICHERHEIT: Unicode-Pfad-Extra mit Traversal hinter harmlosem Standardnamen', async () => {
  const r = await pruefe(P('zipUnicodePfad'));
  const o = objekt(r, 'harmlos.txt');
  assert.equal(o.data.pfad_gefaehrlich, true);
  assert.deepEqual(o.data.gefahr, ['traversal']);
  assert.equal(o.data.unicode_name, '../../unicode-evil.txt');
  assert.ok(codes(r).includes('unicode_pfad_abweichend'));
});

test('ZIP [SPEC] SICHERHEIT: Bombe durch riesige Deklarationen (ZIP64, 1 TiB) in kleiner Datei', async () => {
  const t0 = Date.now();
  const r = await pruefe(P('zipBombeDeklariert'));
  assert.ok(statSync(P('zipBombeDeklariert')).size < 5000, 'Fixture bleibt klein');
  assert.ok(codes(r).includes('archiv_bombe_verdacht'));
  assert.equal(r.status, 'teilweise');
  assert.equal(r.metadata.bombe_verdacht, true);
  assert.ok(r.format_specific.bombe_gruende.some(g => g.startsWith('unkomprimiert_ueber_absoluter_grenze')));
  assert.ok(r.format_specific.bombe_gruende.some(g => g.startsWith('gesamtfaktor')));
  assert.equal(objekt(r, 'riesig.bin').data.unkomprimiert, 2 ** 40);
  assert.ok(Date.now() - t0 < 2000, 'kontrolliert, nicht rechnend');
});

test('ZIP [SPEC] SICHERHEIT: Bombe durch ueberlappende Eintraege (300 Eintraege auf demselben Datenbereich)', async () => {
  const r = await pruefe(P('zipBombeUeberlappend'));
  assert.ok(codes(r).includes('archiv_bombe_verdacht'));
  assert.equal(r.metadata.ueberlappende_eintraege, 300);
  assert.ok(r.format_specific.bombe_gruende.some(g => g.startsWith('ueberlappende_eintraege')));
  assert.ok(r.objects.length <= 100, 'nach Bombenverdacht nur wenige Objekte');
  assert.ok(!codes(r).includes('lokaler_header_ungueltig'), 'keine Sonden mehr nach Bombenverdacht');
});

test('ZIP [SPEC] SICHERHEIT: Bombe durch absurde Eintragszahl (5 Mio laut ZIP64-Endsatz, 1 echter Eintrag)', async () => {
  const r = await pruefe(P('zipBombeEintragszahl'));
  assert.ok(codes(r).includes('archiv_bombe_verdacht'));
  assert.ok(r.format_specific.bombe_gruende.some(g => g === 'absurde_eintragszahl:5000000'));
  assert.ok(codes(r).includes('eintragszahl_abweichend'));
  assert.equal(r.status, 'teilweise');
});

test('ZIP [SPEC] SICHERHEIT: Bombe durch Kompressionsfaktor (2 x 600 MiB aus je ~20 Bytes)', async () => {
  const r = await pruefe(P('zipBombeFaktor'));
  assert.ok(codes(r).includes('archiv_bombe_verdacht'));
  assert.ok(r.format_specific.bombe_gruende.some(g => g.startsWith('gesamtfaktor')));
  assert.ok(r.format_specific.bombe_gruende.some(g => g.startsWith('einzelfaktor')));
  assert.equal(r.metadata.unkomprimiert_gesamt, 1200 * MIB);
});

test('ZIP [SPEC]: Eintragsgroessen/Offsets groesser als die Datei => eintrag_ausserhalb, kein Absturz', async () => {
  const r = await pruefe(P('zipEintragGroesserAlsDatei'));
  const aussen = r.warnings.filter(w => w.code === 'eintrag_ausserhalb').map(w => w.message);
  assert.ok(aussen.some(m => m.includes('luege.bin')));
  assert.ok(aussen.some(m => m.includes('offset.bin')));
  assert.equal(objekt(r, 'luege.bin').data.ausserhalb_der_datei, true);
  assert.equal(objekt(r, 'ok.txt').data.ausserhalb_der_datei, undefined);
  assert.equal(r.status, 'teilweise');
  assert.ok(!codes(r).some(c => KAPUTT_CODES.includes(c)));
});

test('ZIP [SPEC]: Verzeichnis (Groesse/Offset) liegt ausserhalb der Datei', async () => {
  const r = await pruefe(P('zipCdAusserhalb'));
  assert.ok(codes(r).includes('zip_verzeichnis_ausserhalb'));
  assert.equal(r.status, 'teilweise');
  assert.deepEqual(r.objects, []);
});

test('ZIP [SPEC]: ZIP64 von Hand (gesaettigte Felder, Groessen+Offset im Extra, EOCD64 + Locator)', async () => {
  const r = await pruefe(P('zipZip64Hand'));
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.zip64, true);
  assert.notEqual(r.format_specific.zip64_eocd_offset, null);
  const z1 = objekt(r, 'z1.txt').data;
  const z2 = objekt(r, 'z2.txt').data;
  assert.equal(z1.unkomprimiert, 4);
  assert.equal(z1.lokaler_header_offset, 0);
  assert.equal(z2.unkomprimiert, 9);
  assert.equal(z2.lokaler_header_offset, 30 + 6 + 4);
  assert.deepEqual(z1.extra_ids, ['0x0001']);
  assert.equal(r.metadata.eintraege_gesamt, 2);
});

test('ZIP [SPEC]: Selbstextraktor-Praefix (4096 Bytes) => Offsets korrigiert, Namen gleich', async () => {
  const ohne = await pruefe(P('zipHandKlein'));
  const mit = await pruefe(P('zipSfx'));
  assert.equal(mit.status, 'ok');
  assert.equal(mit.metadata.praefix_bytes, fx.erwartet.sfxPraefix);
  assert.equal(mit.metadata.selbstextraktor_verdacht, true);
  assert.ok(codes(mit).includes('praefix_vorhanden'));
  assert.deepEqual(namen(mit), namen(ohne));
  mit.objects.forEach((o, i) => assert.equal(o.data.lokaler_header_offset, ohne.objects[i].data.lokaler_header_offset + 4096));
  assert.ok(!codes(mit).includes('lokaler_header_ungueltig'), 'Sonden fanden die lokalen Header an den korrigierten Offsets');
  const z64 = await pruefe(P('zipSfx64'));
  assert.equal(z64.metadata.praefix_bytes, 4096, 'auch mit ZIP64-Endsatz');
  assert.equal(z64.metadata.zip64, true);
  assert.deepEqual(namen(z64), ['z1.txt']);
});

test('ZIP [SPEC]: Mehr-Datei-Archiv wird als solches gemeldet', async () => {
  const r = await pruefe(P('zipMehrteilig'));
  assert.equal(r.metadata.mehrteilig, true);
  assert.ok(codes(r).includes('mehrteiliges_archiv'));
  assert.equal(r.status, 'teilweise');
});

test('ZIP [SPEC]: Schein-Endsatz im Kommentar taeuscht die Rueckwaertssuche nicht', async () => {
  const r = await pruefe(P('zipKommentarSchein'));
  assert.equal(r.status, 'ok');
  assert.equal(r.metadata.eintraege_gesamt, 3);
  assert.ok(r.metadata.kommentar.startsWith('vorne '));
  assert.deepEqual(namen(r), ['ordner/', 'ordner/a.txt', 'b.bin']);
});

test('ZIP [SPEC]: abgeschnitten (kein Endsatz) => Rettung ueber lokale Header, teilweise', async () => {
  for (const f of ['zipOhneCd', 'zipEocdKaputt']) {
    const r = await pruefe(P(f));
    assert.equal(r.status, 'teilweise', f);
    assert.ok(codes(r).includes('zip_verzeichnis_fehlt'), f);
    assert.deepEqual(namen(r).slice(0, 2), ['ordner/', 'ordner/a.txt'], f);
    assert.equal(r.objects[0].data.quelle, 'lokaler_header');
  }
  assert.equal((await pruefe(P('zipEocdKaputt'))).objects.length, 3);
});

test('ZIP [SPEC]: Endung passt nicht zum Inhalt (Text als .zip), zu kurz, nur Signatur => teilweise, kein Absturz', async () => {
  const text = await pruefe(P('zipTextAlsZip'));
  assert.equal(text.status, 'teilweise');
  assert.ok(codes(text).includes('magic_fehlt'));
  assert.ok(codes(text).includes('zip_verzeichnis_fehlt'));
  assert.deepEqual(text.objects, []);
  const kurz = await pruefe(P('zipNurSignatur'));
  assert.equal(kurz.status, 'teilweise');
  assert.ok(codes(kurz).includes('zip_zu_klein'));
});

test('ZIP: Grenzwert maxObjects kappt Objekte UND meldet es (40 Eintraege, Grenze 7)', async t => {
  if (braucht(t, 'python3')) return;
  const r = await pruefe(P('zip:viele.zip'), { maxObjects: 7 });
  assert.equal(r.objects.length, 7);
  assert.equal(r.metadata.eintraege_gelesen, 40);
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.equal(r.status, 'teilweise');
});

test('ZIP: 100000 Eintraege: Leistung und Speicher (GEMESSEN)', async t => {
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const r = await pruefe(P('zipVieleEintraege'));
  const dauer = Date.now() - t0;
  const rss = (process.memoryUsage().rss - rss0) / MIB;
  t.diagnostic(`100000 Eintraege: ${dauer} ms, RSS-Zuwachs ${rss.toFixed(0)} MiB, Datei ${(statSync(P('zipVieleEintraege')).size / MIB).toFixed(1)} MiB`);
  assert.equal(r.metadata.eintraege_gelesen, 100_000);
  assert.equal(r.objects.length, 10_000);
  assert.ok(dauer < 8000, `zu langsam: ${dauer} ms`);
  assert.ok(rss < 400, `zu viel Speicher: ${rss} MiB`);
});

test('ZIP: Lesebudget maxReadBytes zu klein => teilweise mit Warnung, kein Absturz', async () => {
  const r = await pruefe(P('zipHandKlein'), { maxReadBytes: 100 });
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('lesegrenze_ueberschritten'));
});

test('ZIP: Zeitgrenze wird eingehalten (100000 Eintraege, 1 ms) => Status fehler + zeitgrenze, kein Absturz', async () => {
  const r = await pruefe(P('zipVieleEintraege'), { timeoutMs: 1 });
  assert.ok(codes(r).includes('zeitgrenze'));
  assert.equal(r.status, 'fehler');
});

// =============================================================== TAR: echte Dateien (GEMESSEN)

/** Parst `tar -tvf`: Name, Groesse, Typzeichen. */
function tarListe(pfad) {
  return execFileSync('tar', ['-tvf', pfad]).toString().trim().split('\n').map(zeile => {
    const m = /^(\S)\S+\s+\S+\s+(\d+)\s+\d{4}-\d\d-\d\d \d\d:\d\d (.*)$/.exec(zeile);
    assert.ok(m, 'tar-Zeile nicht lesbar: ' + zeile);
    return { typ: m[1], groesse: Number(m[2]), name: m[3].split(' -> ')[0].split(' link to ')[0] };
  });
}

test('TAR echt (gnu/posix/ustar): Namen, Groessen, Typen entsprechen `tar -tvf`', async t => {
  if (braucht(t, 'tar')) return;
  for (const f of ['gnu.tar', 'posix.tar', 'ustar.tar']) {
    const r = await pruefe(P(f));
    pruefeSchema(r, f);
    assert.equal(r.status, 'ok', f);
    assert.equal(r.format, 'tar');
    const soll = tarListe(P(f));
    assert.deepEqual(namen(r), soll.map(s => s.name), f);
    soll.forEach((s, i) => {
      assert.equal(r.objects[i].data.groesse, s.groesse, f + ' ' + s.name);
      const typ = s.typ === 'd' ? 'verzeichnis' : s.typ === 'l' ? 'symlink' : s.typ === 'h' ? 'hardlink' : 'datei';
      assert.equal(r.objects[i].data.typ, typ, f + ' ' + s.name);
      assert.equal(r.objects[i].data.mtime, '1970-01-01T00:00:00.000Z');
      assert.equal(r.objects[i].data.uid, 0);
    });
    assert.equal(r.metadata.ende_gefunden, true);
    assert.equal(r.metadata.eintraege_gelesen, soll.length);
    assert.equal(r.metadata.unkomprimiert_gesamt, soll.reduce((a, s) => a + s.groesse, 0));
  }
  assert.equal((await pruefe(P('gnu.tar'))).metadata.tar_variante, 'gnu');
  assert.equal((await pruefe(P('ustar.tar'))).metadata.tar_variante, 'ustar');
  const px = await pruefe(P('posix.tar'));
  assert.equal(px.metadata.pax_header, true, 'posix = pax-Erweiterungsheader');
});

test('TAR echt: Symlink-Ziele ausserhalb des Archivs gemeldet, innerhalb nicht (Praezision)', async t => {
  if (braucht(t, 'tar')) return;
  const r = await pruefe(P('gnu.tar'));
  assert.equal(objekt(r, 'quelle/abs').data.link_ziel_ausserhalb, true);
  assert.equal(objekt(r, 'quelle/abs').data.link_ziel, '/etc/shadow');
  assert.equal(objekt(r, 'quelle/sub/raus').data.link_ziel_ausserhalb, true, '../../../x aus quelle/sub verlaesst das Archiv');
  assert.equal(objekt(r, 'quelle/sub/innen').data.link_ziel_ausserhalb, false, '../../etc/passwd aus quelle/sub bleibt im Archiv');
  assert.equal(r.warnings.filter(w => w.code === 'link_ziel_ausserhalb').length, 2);
  assert.equal(r.metadata.link_ziele_ausserhalb, 2);
});

test('TAR echt: .tgz (gzip, strömend) liefert dieselben Eintraege wie das unkomprimierte TAR', async t => {
  if (braucht(t, 'tar', 'gzip')) return;
  const plain = await pruefe(P('gnu.tar'));
  const r = await pruefe(P('echt.tgz'));
  pruefeSchema(r, 'tgz');
  assert.equal(r.status, 'ok');
  assert.equal(r.format, 'tar.gz');
  assert.equal(r.metadata.kompression, 'gzip');
  assert.equal(r.metadata.enthaelt_tar, true);
  assert.deepEqual(namen(r), namen(plain));
  assert.equal(r.format_specific.entpackt_bytes, statSync(P('gnu.tar')).size);
  assert.equal(r.metadata.isize_laut_trailer, statSync(P('gnu.tar')).size, 'ISIZE aus dem gzip-Trailer');
  assert.equal(r.format_specific.gzip_ende_erreicht, true);
  assert.equal(r.format_specific.offsets_beziehen_sich_auf, 'entpackter_tar_strom');
});

test('TAR echt: bzip2/xz/zstd nur erkannt => teilweise + kompression_nicht_unterstuetzt', async t => {
  if (braucht(t, 'tar')) return;
  const faelle = [['echt.tar.bz2', 'bzip2', 'tar.bz2', 'bzip2'], ['echt.tar.xz', 'xz', 'tar.xz', 'xz'], ['echt.tar.zst', 'zstd', 'tar.zst', 'zstd']];
  for (const [f, komp, format, werkzeug] of faelle) {
    if (!fx.werkzeuge[werkzeug]) continue;
    const r = await pruefe(P(f));
    assert.equal(r.status, 'teilweise', f);
    assert.equal(r.format, format, f);
    assert.equal(r.metadata.kompression, komp, f);
    assert.ok(codes(r).includes('kompression_nicht_unterstuetzt'), f);
    assert.deepEqual(r.objects, [], f + ': ohne Dekoder keine Eintragsliste, nichts erfunden');
  }
});

test('TAR echt: gzip-Datei ohne TAR => ok/gzip; .tgz-Name ohne TAR => teilweise + kein_tar_im_gzip', async t => {
  if (braucht(t, 'tar', 'gzip')) return;
  const g = await pruefe(P('text.gz'));
  assert.equal(g.format, 'gzip');
  assert.equal(g.status, 'ok');
  assert.equal(g.metadata.enthaelt_tar, false);
  assert.equal(g.metadata.isize_laut_trailer, 6);
  const k = await pruefe(P('kein-tar.tgz'));
  assert.equal(k.status, 'teilweise');
  assert.ok(codes(k).includes('kein_tar_im_gzip'));
});

test('TAR echt: abgeschnittenes .tgz => teilweise + gzip_abgeschnitten_oder_kaputt', async t => {
  if (braucht(t, 'tar', 'gzip')) return;
  const r = await pruefe(P('tgzAbgeschnitten'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('gzip_abgeschnitten_oder_kaputt'));
  assert.ok(!codes(r).some(c => KAPUTT_CODES.includes(c)));
});

// =============================================================== TAR: Hand-Fixtures [SPEC]

test('TAR [SPEC]: GNU-Langname (Typ L) ersetzt den gekuerzten Namen', async () => {
  const r = await pruefe(P('tarGnuLangname'));
  assert.equal(r.objects.length, 1, 'der L-Eintrag selbst ist kein Objekt');
  assert.equal(r.objects[0].name, fx.erwartet.langerName);
  assert.ok(r.objects[0].name.length > 100);
  assert.equal(r.metadata.gnu_langnamen, true);
  assert.equal(r.objects[0].data.groesse, 6);
  assert.equal(r.metadata.tar_variante, 'gnu');
});

test('TAR [SPEC]: ustar-Praefix + Name werden zusammengesetzt', async () => {
  const r = await pruefe(P('tarPraefix'));
  assert.equal(r.objects[0].name, fx.erwartet.praefixName);
  assert.equal(r.metadata.tar_variante, 'ustar');
});

test('TAR [SPEC]: pax-Header (path ueber 100 Zeichen, mtime mit Bruchteil) gilt fuer den naechsten Eintrag', async () => {
  const r = await pruefe(P('tarPax'));
  assert.equal(r.objects.length, 1);
  assert.equal(r.objects[0].name, fx.erwartet.paxPfad);
  assert.equal(r.objects[0].data.mtime, '2020-09-13T12:26:40.000Z');
  assert.equal(r.metadata.pax_header, true);
});

test('TAR [SPEC] SICHERHEIT: Traversal, absolute Pfade, Symlink/Hardlink-Ziele ausserhalb, Geraetedatei', async () => {
  const r = await pruefe(P('tarTraversal'));
  assert.deepEqual(objekt(r, '../../evil.txt').data.gefahr, ['traversal']);
  assert.deepEqual(objekt(r, '/etc/cron.d/evil').data.gefahr, ['absolut']);
  assert.equal(objekt(r, 'ok/fine.txt').data.pfad_gefaehrlich, false);
  assert.equal(r.metadata.gefaehrliche_pfade, 2);
  assert.equal(r.warnings.filter(w => w.code === 'pfad_gefaehrlich').length, 2);
  assert.equal(objekt(r, 'lnk_aussen').data.link_ziel_ausserhalb, true);
  assert.equal(objekt(r, 'lnk_hoch').data.link_ziel_ausserhalb, true);
  assert.equal(objekt(r, 'dir/lnk_innen').data.link_ziel_ausserhalb, false);
  assert.equal(objekt(r, 'hart').data.typ, 'hardlink');
  assert.equal(objekt(r, 'hart').data.link_ziel_ausserhalb, true);
  assert.equal(objekt(r, 'hart_innen').data.link_ziel_ausserhalb, false);
  assert.equal(r.warnings.filter(w => w.code === 'link_ziel_ausserhalb').length, 3);
  assert.equal(objekt(r, 'dev/null').data.typ, 'zeichengeraet');
  assert.ok(codes(r).includes('tar_geraetedatei'));
});

test('TAR [SPEC]: Groessenfeld base-256', async () => {
  const r = await pruefe(P('tarBase256'));
  assert.equal(r.objects[0].data.groesse, 3);
  assert.equal(r.status, 'ok');
});

test('TAR [SPEC]: falsche Kopf-Pruefsumme => Lesen stoppt, vorherige Eintraege bleiben', async () => {
  const r = await pruefe(P('tarPruefsumme'));
  assert.deepEqual(namen(r), ['eins']);
  assert.ok(codes(r).includes('pruefsumme_falsch'));
  assert.equal(r.status, 'teilweise');
});

test('TAR [SPEC]: abgeschnitten mitten in den Daten => tar_abgeschnitten', async () => {
  const r = await pruefe(P('tarAbgeschnitten'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('tar_abgeschnitten'));
  assert.ok(codes(r).includes('tar_groesse_ausserhalb'));
  assert.equal(r.objects[0].name, 'eins');
  assert.equal(r.objects[0].data.daten_abgeschnitten, true);
});

test('TAR [SPEC] SICHERHEIT: Groessenangabe 16 TiB in einer kleinen Datei => nichts wird reserviert/gelesen', async () => {
  const t0 = Date.now();
  const r = await pruefe(P('tarGroesseLuege'));
  assert.ok(statSync(P('tarGroesseLuege')).size < 5000);
  assert.equal(r.objects[0].data.groesse, 2 ** 44);
  assert.ok(codes(r).includes('tar_groesse_ausserhalb'));
  assert.equal(r.status, 'teilweise');
  assert.ok(Date.now() - t0 < 1000);
});

test('TAR [SPEC]: ohne Endbloecke / leeres TAR / kein TAR / zu kurz', async () => {
  const ohne = await pruefe(P('tarOhneEnde'));
  assert.equal(ohne.objects.length, 3);
  assert.ok(codes(ohne).includes('tar_ende_fehlt'));
  assert.equal(ohne.status, 'ok');
  const leer = await pruefe(P('tarLeer'));
  assert.equal(leer.status, 'ok');
  assert.equal(leer.metadata.ende_gefunden, true);
  assert.deepEqual(leer.objects, []);
  const nein = await pruefe(P('tarKeinTar'));
  assert.equal(nein.status, 'teilweise');
  assert.ok(codes(nein).includes('kein_tar'));
  const kurz = await pruefe(P('tarKurz'));
  assert.equal(kurz.status, 'teilweise');
  assert.ok(codes(kurz).includes('tar_zu_klein'));
});

test('TAR: Grenzwert maxObjects (60 Eintraege, Grenze 10)', async () => {
  const r = await pruefe(P('tarVieleDateien'), { maxObjects: 10 });
  assert.equal(r.objects.length, 10);
  assert.ok(codes(r).includes('objekte_gekappt'));
  assert.equal(r.status, 'teilweise');
});

test('TAR [SPEC] SICHERHEIT: gzip-Bombe (300 MiB Nullen) => Ausgabekappe haelt, Zeit und Speicher (GEMESSEN)', async t => {
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const r = await pruefe(P('bombe-nullen.gz'));
  const dauer = Date.now() - t0;
  const rss = (process.memoryUsage().rss - rss0) / MIB;
  const groesse = statSync(P('bombe-nullen.gz')).size;
  t.diagnostic(`gzip-Bombe: Datei ${groesse} B, entpackt hoechstens ${GZ_KAPPE} B, ${dauer} ms, RSS-Zuwachs ${rss.toFixed(0)} MiB`);
  assert.ok(groesse < 2 * MIB, 'Fixture bleibt klein');
  assert.ok(r.format_specific.entpackt_bytes <= GZ_KAPPE, 'nie mehr als die Kappe entpackt');
  assert.ok(codes(r).includes('archiv_bombe_verdacht'));
  assert.equal(r.metadata.bombe_verdacht, true);
  assert.equal(r.status, 'teilweise');
  assert.ok(dauer < 3000, `zu langsam: ${dauer} ms`);
  assert.ok(rss < 200, `zu viel Speicher: ${rss} MiB`);
});

test('TAR [SPEC] SICHERHEIT: tar.gz-Bombe (Eintrag verspricht 300 MiB) => erster Eintrag gelistet, gekappt, Bombenverdacht', async () => {
  const t0 = Date.now();
  const r = await pruefe(P('bombe.tar.gz'));
  assert.equal(r.format, 'tar.gz');
  assert.equal(r.objects[0].name, 'riesig.bin');
  assert.equal(r.objects[0].data.groesse, 300 * MIB);
  assert.equal(r.objects[0].data.daten_abgeschnitten, true);
  assert.ok(codes(r).includes('tar_gz_gekappt'));
  assert.ok(codes(r).includes('archiv_bombe_verdacht'));
  assert.ok(r.format_specific.entpackt_bytes <= GZ_KAPPE);
  assert.ok(!codes(r).includes('tar_abgeschnitten'), 'Kappung ist keine Abschneidung');
  assert.equal(r.status, 'teilweise');
  assert.ok(Date.now() - t0 < 3000);
});

// =============================================================== 7z

/** `7z l -slt`: Eintragsliste nach dem Trenner. */
function parse7zListe(text) {
  const nach = text.split(/^----------\r?\n/m)[1] ?? '';
  return nach.split(/\r?\n\r?\n/).filter(b => b.includes('Path =')).map(b => {
    const d = {};
    for (const z of b.split(/\r?\n/)) {
      const m = /^(\w[\w ]*?) = (.*)$/.exec(z);
      if (m) d[m[1]] = m[2];
    }
    return d;
  });
}

test('7z echt (unkomprimierter Header): Namen, Groessen, CRCs entsprechen `7z l -slt`', async t => {
  if (braucht(t, '7z')) return;
  const r = await pruefe(P('plain.7z'));
  pruefeSchema(r, '7z');
  assert.equal(r.status, 'ok');
  assert.equal(r.format, '7z');
  assert.equal(r.inspector, 'archiv-7z');
  const soll = parse7zListe(fx.erwartet.siebenListe);
  assert.ok(soll.length >= 4);
  assert.deepEqual(namen(r).sort(), soll.map(s => s.Path).sort());
  for (const s of soll) {
    const o = objekt(r, s.Path);
    if (s.Attributes.startsWith('D')) {
      assert.equal(o.data.verzeichnis, true, s.Path);
    } else {
      assert.equal(o.data.verzeichnis, false, s.Path);
      assert.equal(o.data.groesse, Number(s.Size), s.Path + ' Groesse');
      if (s.CRC) assert.equal(o.data.crc32, s.CRC.toLowerCase(), s.Path + ' CRC');
    }
  }
  assert.equal(r.metadata.version, '0.4');
  assert.equal(r.metadata.start_header_crc_ok, true);
  assert.equal(r.metadata.header_crc_ok, true);
  assert.equal(r.metadata.header_kodiert, false);
  assert.deepEqual(r.metadata.methoden, ['lzma2']);
  assert.equal(r.metadata.verschluesselt, false);
  // source_range zeigt auf den UTF-16-Namen im Header.
  const roh = readFileSync(P('plain.7z'));
  for (const o of r.objects) {
    assert.equal(roh.subarray(o.source_range.offset, o.source_range.offset + o.source_range.length).toString('utf16le'), o.name);
  }
});

test('7z echt: komprimierter Header (7z-Standard) => teilweise + header_komprimiert_oder_verschluesselt, nichts geraten', async t => {
  if (braucht(t, '7z')) return;
  const r = await pruefe(P('kodiert.7z'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('header_komprimiert_oder_verschluesselt'));
  assert.equal(r.metadata.header_kodiert, true);
  assert.deepEqual(r.metadata.header_methoden, ['lzma']);
  assert.equal(r.metadata.header_verschluesselt, false);
  assert.equal(r.metadata.start_header_crc_ok, true);
  assert.equal(r.metadata.header_crc_ok, true);
  assert.deepEqual(r.objects, []);
});

test('7z echt: verschluesselter Header (-mhe=on) und verschluesselte Daten (-mhe=off) werden gemeldet', async t => {
  if (braucht(t, '7z')) return;
  const h = await pruefe(P('hdr-aes.7z'));
  assert.equal(h.status, 'teilweise');
  assert.equal(h.metadata.header_verschluesselt, true);
  assert.ok(codes(h).includes('archiv_verschluesselt'));
  assert.ok(codes(h).includes('header_komprimiert_oder_verschluesselt'));
  const d = await pruefe(P('daten-aes.7z'));
  assert.equal(d.metadata.header_kodiert, false);
  assert.equal(d.metadata.verschluesselt, true);
  assert.ok(codes(d).includes('archiv_verschluesselt'));
  assert.ok(namen(d).includes('quelle/a.txt'), 'Namen sind bei -mhe=off lesbar');
  assert.ok(d.metadata.methoden.includes('aes256_sha256'));
});

test('7z [SPEC]: handgebauter Header (Kopie-Coder), Felder exakt', async () => {
  const r = await pruefe(P('sz7Hand'));
  assert.equal(r.status, 'ok');
  assert.deepEqual(namen(r), ['ok/a.txt', 'ok/b.txt', 'c.bin']);
  assert.deepEqual(r.objects.map(o => o.data.groesse), [5, 11, 100]);
  assert.equal(objekt(r, 'ok/a.txt').data.crc32, hex8(G.crc32(Buffer.from('alpha'))));
  assert.equal(objekt(r, 'c.bin').data.crc32, hex8(G.crc32(G.fuell(100, 3))));
  assert.equal(r.metadata.faktor, 1);
  assert.deepEqual(r.metadata.methoden, ['kopie']);
  assert.equal(r.metadata.eintraege_gesamt, 3);
});

test('7z [SPEC] SICHERHEIT: Traversal-Namen im Header', async () => {
  const r = await pruefe(P('sz7Traversal'));
  assert.deepEqual(objekt(r, '../../evil.txt').data.gefahr, ['traversal']);
  assert.deepEqual(objekt(r, '/etc/passwd').data.gefahr, ['absolut']);
  assert.deepEqual(objekt(r, 'C:\\x.dll').data.gefahr, ['laufwerk']);
  assert.equal(objekt(r, 'gut.txt').data.pfad_gefaehrlich, false);
  assert.equal(r.warnings.filter(w => w.code === 'pfad_gefaehrlich').length, 3);
  assert.equal(r.metadata.gefaehrliche_pfade, 3);
});

test('7z [SPEC] SICHERHEIT: Bombe (2^50 Bytes entpackt aus ~100) und absurde Dateizahl (50 Mio)', async () => {
  const b = await pruefe(P('sz7Bombe'));
  assert.ok(codes(b).includes('archiv_bombe_verdacht'));
  assert.equal(b.metadata.bombe_verdacht, true);
  assert.equal(b.status, 'teilweise');
  assert.ok(b.objects.length <= 100);
  assert.ok(statSync(P('sz7Bombe')).size < 1000);
  const z = await pruefe(P('sz7ZuViele'));
  assert.ok(codes(z).includes('archiv_bombe_verdacht'));
  assert.equal(z.status, 'teilweise');
  assert.deepEqual(z.objects, []);
});

test('7z [SPEC]: StartHeaderCRC falsch => Header wird nicht gelesen; NextHeaderCRC falsch => gelesen aber teilweise', async () => {
  const s = await pruefe(P('sz7StartCrc'));
  assert.ok(codes(s).includes('startheader_crc_falsch'));
  assert.equal(s.metadata.start_header_crc_ok, false);
  assert.equal(s.status, 'teilweise');
  assert.deepEqual(s.objects, []);
  const h = await pruefe(P('sz7HeaderCrc'));
  assert.ok(codes(h).includes('header_crc_falsch'));
  assert.equal(h.metadata.header_crc_ok, false);
  assert.equal(h.status, 'teilweise');
  assert.equal(h.objects.length, 3);
});

test('7z [SPEC]: Header ausserhalb der Datei / abgeschnitten / Version / zu klein / leeres Archiv', async () => {
  for (const f of ['sz7HeaderAusserhalb', 'sz7Abgeschnitten']) {
    const r = await pruefe(P(f));
    assert.ok(codes(r).includes('header_ausserhalb'), f);
    assert.equal(r.status, 'teilweise', f);
  }
  const major = await pruefe(P('sz7Major'));
  assert.ok(codes(major).includes('sevenzip_version_unbekannt'));
  assert.equal(major.status, 'teilweise');
  const klein = await pruefe(P('sz7Nur6'));
  assert.ok(codes(klein).includes('sevenzip_zu_klein'));
  const leer = await pruefe(P('sz7Leer'));
  assert.equal(leer.status, 'ok');
  assert.equal(leer.metadata.eintraege_gesamt, 0);
});

test('7z: Grenzwert maxObjects', async () => {
  const r = await pruefe(P('sz7Hand'), { maxObjects: 2 });
  assert.equal(r.objects.length, 2);
  assert.ok(codes(r).includes('objekte_gekappt'));
});

// =============================================================== SQLite

const sq = (db, sql) =>
  execFileSync('sqlite3', ['-readonly', '-separator', '\x1f', db, sql]).toString().split('\n').filter(Boolean).map(z => z.split('\x1f'));
const norm = s => String(s ?? '').replace(/\s+/g, '');

test('SQLite echt (sqlite3-CLI): sqlite_master 1:1 (Typ, Name, Tabelle, Rootpage, Reihenfolge)', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('schema.db'));
  pruefeSchema(r, 'schema.db');
  assert.equal(r.status, 'ok');
  assert.equal(r.format, 'sqlite');
  assert.equal(r.asset_type, 'database');
  const soll = sq(P('schema.db'), 'select type,name,tbl_name,rootpage from sqlite_master order by rowid');
  assert.deepEqual(
    r.objects.map(o => [o.kind, o.name, o.data.tabelle, String(o.data.rootpage)]),
    soll
  );
  const zaehle = k => soll.filter(s => s[0] === k).length;
  assert.equal(r.metadata.tabellen, zaehle('table'));
  assert.equal(r.metadata.indizes, zaehle('index'));
  assert.equal(r.metadata.views, 1);
  assert.equal(r.metadata.trigger, 1);
  // CREATE-SQL buchstaeblich.
  for (const [typ, name] of soll.map(s => [s[0], s[1]])) {
    const echt = execFileSync('sqlite3', ['-readonly', P('schema.db'), `select sql from sqlite_master where name='${name}'`]).toString().replace(/\n$/, '');
    const o = objekt(r, name);
    assert.equal(o.data.sql ?? '', echt, typ + ' ' + name);
  }
});

test('SQLite echt: Spalten (Name, Typ, NOT NULL, PRIMARY KEY) gleich `pragma table_info`', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('schema.db'));
  let geprueft = 0;
  for (const o of r.objects.filter(x => x.kind === 'table')) {
    const info = sq(P('schema.db'), `pragma table_info("${o.name}")`);
    const ist = o.data.columns.map(c => [c.name, norm(c.type), c.not_null ? '1' : '0', c.primary_key ? '1' : '0']);
    const soll = info.map(i => [i[1], norm(i[2]), i[3], Number(i[5]) > 0 ? '1' : '0']);
    assert.deepEqual(ist, soll, 'Tabelle ' + o.name);
    geprueft += soll.length;
  }
  assert.ok(geprueft >= 15, `nur ${geprueft} Spalten geprueft`);
  assert.deepEqual(objekt(r, 'posten').data.primary_key, ['bestellung_id', 'pos']);
  assert.equal(objekt(r, 'kunde').data.autoincrement, true);
  assert.equal(objekt(r, 'ohne_rowid').data.without_rowid, true);
  assert.deepEqual(objekt(r, 'mit leerzeichen').data.columns.map(c => c.name), ['a', 'b c']);
});

test('SQLite echt: Fremdschluessel gleich `pragma foreign_key_list`, references mit resolved', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('schema.db'));
  let fks = 0;
  for (const o of r.objects.filter(x => x.kind === 'table')) {
    const soll = sq(P('schema.db'), `pragma foreign_key_list("${o.name}")`).map(f => [f[3], f[2], f[4] || null]).sort();
    const ist = o.data.foreign_keys.map(f => [f.spalte, f.ziel_tabelle, f.ziel_spalte]).sort();
    assert.deepEqual(ist, soll, 'FK ' + o.name);
    fks += soll.length;
  }
  assert.equal(fks, 3);
  assert.deepEqual(
    r.references.map(x => [x.target, x.kind, x.resolved]).sort(),
    [['bestellung.id', 'foreign_key', true], ['kunde.id', 'foreign_key', true], ['nichtda.y', 'foreign_key', false]]
  );
});

test('SQLite echt: Header (Seitengroesse, user_version, application_id, Cookie, Codierung, Seitenzahl) gleich pragma', async t => {
  if (braucht(t, 'sqlite3')) return;
  const p = P('schema.db');
  const r = await pruefe(p);
  const pragma = n => sq(p, 'pragma ' + n)[0][0];
  assert.equal(r.metadata.seitengroesse, Number(pragma('page_size')));
  assert.equal(r.metadata.user_version, Number(pragma('user_version')));
  assert.equal(r.metadata.user_version, 42);
  assert.equal(r.metadata.application_id, Number(pragma('application_id')));
  assert.equal(r.metadata.application_name, 'GeoPackage');
  assert.equal(r.metadata.schema_cookie, Number(pragma('schema_version')));
  assert.equal(r.metadata.seiten, Number(pragma('page_count')));
  assert.equal(r.metadata.textcodierung, 'utf-8');
  assert.equal(r.metadata.freiliste_seiten, Number(pragma('freelist_count')));
  assert.equal(r.metadata.wal_modus, false);
  assert.equal(String(pragma('encoding')), 'UTF-8');
});

test('SQLite echt: Indizes, Views, Trigger (Unique, Spalten, Teilindex, Zeitpunkt/Ereignis, Auto-Index)', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('schema.db'));
  const ix = objekt(r, 'idx_kunde_email2').data;
  assert.equal(ix.unique, true);
  assert.deepEqual(ix.spalten, ['email', 'name']);
  assert.equal(ix.tabelle, 'kunde');
  assert.equal(objekt(r, 'idx_posten_artikel').data.teilindex, true);
  const tr = objekt(r, 'trg_kunde').data;
  assert.equal(tr.zeitpunkt, 'AFTER');
  assert.equal(tr.ereignis, 'INSERT');
  assert.equal(objekt(r, 'v_summe').kind, 'view');
  const auto = r.objects.filter(o => o.kind === 'index' && o.data.sql === null);
  assert.ok(auto.length >= 2, 'automatische Indizes (UNIQUE/PK ohne rowid)');
  assert.ok(auto.every(o => o.data.automatisch === true && o.data.intern === true));
  assert.equal(objekt(r, 'sqlite_sequence').data.intern, true);
});

test('SQLite echt: Zeilenzahl nur fuer kleine Baeume und dann exakt `count(*)`', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('schema.db'));
  const n = (db, tab) => Number(execFileSync('sqlite3', ['-readonly', db, `select count(*) from "${tab}"`]).toString());
  let gezaehlt = 0;
  for (const o of r.objects.filter(x => x.kind === 'table')) {
    if (typeof o.data.zeilen === 'number') {
      assert.equal(o.data.zeilen, n(P('schema.db'), o.name), o.name);
      gezaehlt++;
    }
  }
  assert.ok(gezaehlt >= 5);
  assert.equal(objekt(r, 'kunde').data.zeilen, 3);
  assert.equal(objekt(r, 'ohne_rowid').data.zeilen, null, 'Index-Baum (WITHOUT ROWID) wird nicht gezaehlt');
  const g = await pruefe(P('gross.db'));
  assert.equal(objekt(g, 'klein').data.zeilen, 5);
  assert.equal(n(P('gross.db'), 'gross'), 5000);
  assert.equal(objekt(g, 'gross').data.zeilen, null, '5000 Zeilen auf 1-KiB-Seiten: Baum zu gross => weggelassen');
  assert.equal(objekt(g, 'gross').data.zeilen_hinweis, 'nicht_gezaehlt_baum_gross_oder_index_baum');
  assert.ok(codes(g).includes('zeilenzahl_weggelassen'));
  assert.equal(g.metadata.seitengroesse, 1024);
});

test('SQLite echt: 300 Tabellen auf 512-Byte-Seiten (Innenseiten in sqlite_master) vollstaendig und in Reihenfolge', async t => {
  if (braucht(t, 'sqlite3')) return;
  const db = P('viele-tabellen.db');
  const r = await pruefe(db);
  assert.equal(fx.erwartet.viele_page1_typ, 0x05, 'Voraussetzung: Seite 1 ist eine Innenseite');
  const soll = sq(db, 'select type,name from sqlite_master order by rowid');
  assert.equal(soll.length, 303);
  assert.deepEqual(r.objects.map(o => [o.kind, o.name]), soll);
  assert.ok(r.format_specific.master_seiten_besucht > 3, 'mehrere Seiten gelesen');
  assert.equal(r.metadata.seitengroesse, 512);
  assert.equal(r.metadata.tabellen, 302);
});

test('SQLite echt: CREATE-SQL ueber Overflow-Seiten (3000 und 20000 Zeichen)', async t => {
  if (braucht(t, 'sqlite3')) return;
  const db = P('viele-tabellen.db');
  const r = await pruefe(db);
  const echt = execFileSync('sqlite3', ['-readonly', db, "select sql from sqlite_master where name='langtext'"]).toString().replace(/\n$/, '');
  assert.ok(echt.length > 3000);
  const lang = objekt(r, 'langtext').data;
  assert.equal(lang.sql, echt, 'ueber Overflow-Seiten vollstaendig rekonstruiert');
  assert.equal(lang.sql_gekappt, false);
  assert.deepEqual(lang.columns.map(c => c.name), ['a', 'b']);
  const sehr = objekt(r, 'sehrlang').data;
  assert.equal(sehr.sql_gekappt, true);
  assert.ok(sehr.sql.startsWith('CREATE TABLE sehrlang (a INT DEFAULT \'yyyy'));
  assert.ok(sehr.sql.length <= 4000);
  assert.ok(codes(r).includes('sqlite_sql_gekappt'));
  assert.deepEqual(sehr.columns.map(c => c.name), ['a'], 'Spalten aus dem gekappten Text, soweit lesbar');
  assert.equal(r.status, 'ok');
});

test('SQLite echt: WAL-Modus, UTF-16LE, 64-KiB-Seiten', async t => {
  if (braucht(t, 'sqlite3')) return;
  const wal = await pruefe(P('wal.db'));
  assert.equal(wal.metadata.wal_modus, true);
  assert.ok(codes(wal).includes('wal_modus'));
  assert.equal(sq(P('wal.db'), 'pragma journal_mode')[0][0], 'wal');
  assert.deepEqual(namen(wal), ['w']);
  const u16 = await pruefe(P('utf16.db'));
  assert.equal(u16.metadata.textcodierung, 'utf-16le');
  const soll = sq(P('utf16.db'), 'select name from sqlite_master order by rowid').map(x => x[0]);
  assert.deepEqual(namen(u16), soll);
  assert.ok(namen(u16).includes('tüä'));
  assert.deepEqual(objekt(u16, 'tüä').data.columns.map(c => c.name), ['spalte_ö']);
  const g = await pruefe(P('page64k.db'));
  assert.equal(g.metadata.seitengroesse, 65536);
  assert.deepEqual(namen(g), ['gross_seite']);
  assert.equal(objekt(g, 'gross_seite').data.zeilen, 2);
});

test('SQLite SICHERHEIT: Inspektion veraendert nichts und erzeugt keine -wal/-shm/-journal (auch bei WAL-DB)', async t => {
  if (braucht(t, 'sqlite3')) return;
  const vorher = readdirSync(fx.dir).sort();
  const hashes = {};
  for (const n of ['schema.db', 'wal.db', 'viele-tabellen.db', 'gross.db', 'utf16.db']) {
    hashes[n] = { sha: sha(P(n)), mtime: statSync(P(n)).mtimeMs };
    await pruefe(P(n));
  }
  assert.deepEqual(readdirSync(fx.dir).sort(), vorher, 'keine neuen Dateien');
  for (const [n, h] of Object.entries(hashes)) {
    assert.equal(sha(P(n)), h.sha, n);
    assert.equal(statSync(P(n)).mtimeMs, h.mtime, n);
  }
});

test('SQLite [SPEC]: abgeschnitten / nur Header / ungueltige Seitengroesse / Rauschen / zu klein', async t => {
  if (braucht(t, 'sqlite3')) return;
  const a = await pruefe(P('dbAbgeschnitten'));
  assert.equal(a.status, 'teilweise');
  assert.ok(codes(a).includes('sqlite_abgeschnitten') || codes(a).includes('sqlite_groesse_kein_vielfaches'));
  assert.deepEqual(namen(a), ['klein', 'gross'], 'sqlite_master liegt auf Seite 1 und ist noch lesbar');
  const h = await pruefe(P('dbNurHeader'));
  assert.equal(h.status, 'teilweise');
  assert.ok(codes(h).includes('sqlite_keine_seite'));
  const s = await pruefe(P('dbSeitengroesseUngueltig'));
  assert.ok(codes(s).includes('sqlite_seitengroesse_ungueltig'));
  assert.equal(s.status, 'teilweise');
  const r = await pruefe(P('dbRauschen'));
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('sqlite_header_ungueltig'), 'verschluesselt (z. B. SQLCipher) oder kein SQLite');
  assert.deepEqual(r.objects, []);
  const k = await pruefe(P('dbKlein'));
  assert.ok(codes(k).includes('sqlite_zu_klein'));
});

test('SQLite [SPEC] SICHERHEIT: B-Baum-Zyklus (Seite verweist auf sich) endet, uebrige Tabellen bleiben lesbar', async t => {
  if (braucht(t, 'sqlite3')) return;
  const t0 = Date.now();
  const r = await pruefe(P('dbZyklus'));
  assert.ok(codes(r).includes('sqlite_zyklus'));
  const soll = sq(P('viele-tabellen.db'), 'select name from sqlite_master order by rowid').map(x => x[0]);
  assert.equal(fx.erwartet.viele_kind_typ, 0x05, 'Voraussetzung: das Kind der Wurzel ist eine Innenseite');
  assert.equal(r.status, 'teilweise');
  assert.ok(r.objects.length >= 1 && r.objects.length < soll.length, 'ein Teilbaum fehlt, der Rest ist da');
  assert.deepEqual(namen(r), soll.slice(0, r.objects.length), 'das Gelesene ist ein exakter Anfang der echten Liste');
  assert.ok(Date.now() - t0 < 2000);
});

test('SQLite [SPEC]: defekter Zellzeiger => Zelle uebersprungen, Rest lesbar, teilweise', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('dbKaputteZelle'));
  assert.ok(codes(r).includes('sqlite_zelle_defekt'));
  assert.equal(r.status, 'teilweise');
  assert.ok(r.objects.length >= 5);
});

test('SQLite: leere Datei (0 Bytes) => datei_leer, kein Absturz', async () => {
  const p = join(fx.dir, 'leer.db');
  writeFileSync(p, Buffer.alloc(0));
  const r = await pruefe(p);
  assert.ok(codes(r).includes('datei_leer'));
  assert.equal(r.status, 'teilweise');
});

test('SQLite: Grenzwert maxObjects (302 Objekte, Grenze 20)', async t => {
  if (braucht(t, 'sqlite3')) return;
  const r = await pruefe(P('viele-tabellen.db'), { maxObjects: 20 });
  assert.equal(r.objects.length, 20);
  assert.equal(r.status, 'teilweise');
});

// =============================================================== Erkennung / Registry

test('Registry: Magic vor Endung — ZIP, SQLite, tar.gz, ustar-TAR werden OHNE passende Endung erkannt', async t => {
  if (braucht(t, 'tar', 'sqlite3', 'gzip')) return;
  const kopf = p => readFileSync(p).subarray(0, 4096);
  const faelle = [
    [P('zipHandKlein'), 'archiv-zip', 'zip'],
    [P('schema.db'), 'archiv-sqlite', 'sqlite'],
    [P('echt.tgz'), 'archiv-tar', 'tar.gz'],
    [P('gnu.tar'), 'archiv-tar', 'tar'],
    [P('plain.7z'), 'archiv-7z', '7z'],
  ];
  for (const [p, id, format] of faelle) {
    const d = reg.detect('/tmp/irgendwas.dat', kopf(p));
    assert.equal(d.inspector?.id, id, p);
    assert.equal(d.format, format, p);
    assert.equal(d.via, 'magic', p);
  }
  for (const [p, id, format] of [[P('echt.tar.bz2'), 'archiv-tar', 'tar.bz2'], [P('echt.tar.xz'), 'archiv-tar', 'tar.xz'], [P('echt.tar.zst'), 'archiv-tar', 'tar.zst']]) {
    if (!existsSync(p)) continue;
    const d = reg.detect('/tmp/irgendwas.dat', kopf(p));
    assert.equal(d.inspector?.id, id, p);
    assert.equal(d.format, format, p);
  }
  // Text, der zufaellig mit "BZh" beginnt, ist kein bzip2.
  assert.equal(reg.detect('/tmp/x.dat', Buffer.from('BZh Hallo, das ist nur Text')).inspector, null);
});

test('Registry: Endung widerspricht Inhalt => Inhalt gilt (SQLite-Datei als .zip benannt)', async t => {
  if (braucht(t, 'sqlite3')) return;
  const d = reg.detect('/tmp/falsch.zip', readFileSync(P('schema.db')).subarray(0, 4096));
  assert.equal(d.inspector.id, 'archiv-sqlite');
  assert.ok(d.warnings.some(w => w.code === 'endung_widerspricht_inhalt'));
});

test('Registry: KOLLISION mit generic-binary dokumentiert (zip/gzip/7z) — Endung loest auf, ohne Endung mehrdeutig', async () => {
  const mit = new AssetRegistry();
  mit.register(genericBinaryInspector);
  for (const i of assetArchivInspektoren) mit.register(i);
  const zipKopf = readFileSync(P('zipHandKlein')).subarray(0, 4096);
  const mitEndung = mit.detect('/tmp/a.zip', zipKopf);
  assert.equal(mitEndung.inspector?.id, 'archiv-zip', 'Endung .zip loest die Magic-Gleichheit auf');
  const ohne = mit.detect('/tmp/a.dat', zipKopf);
  assert.equal(ohne.inspector, null, 'ohne Endung: mehrdeutig => kein Treffer');
  assert.ok(ohne.warnings.some(w => w.code === 'erkennung_mehrdeutig'));
  // Behebung bei der Verdrahtung: zip/gzip/7z aus generic-binary entfernen.
  const sauber = new AssetRegistry();
  sauber.register({ ...genericBinaryInspector, magic: genericBinaryInspector.magic.filter(m => !['zip', 'gzip', '7z'].includes(m.format)) });
  for (const i of assetArchivInspektoren) sauber.register(i);
  assert.equal(sauber.detect('/tmp/a.dat', zipKopf).inspector?.id, 'archiv-zip');
});

test('Registry: Inspektoren-Metadaten (ids, Endungen, kein .usdz, Versionen)', () => {
  assert.deepEqual(assetArchivInspektoren.map(i => i.id), ['archiv-zip', 'archiv-tar', 'archiv-7z', 'archiv-sqlite']);
  for (const i of assetArchivInspektoren) {
    assert.ok(Number.isInteger(i.version) && i.version >= 1);
    assert.ok(i.extensions.every(e => e.startsWith('.')));
  }
  const alleEndungen = assetArchivInspektoren.flatMap(i => i.extensions);
  assert.equal(new Set(alleEndungen).size, alleEndungen.length, 'keine Endung doppelt beansprucht');
  assert.ok(!alleEndungen.includes('.usdz'));
});

// =============================================================== Querschnitt

test('Schema + Kaputt-Codes: ALLE Fixtures liefern vollstaendiges, serialisierbares Ergebnis ohne inspektor_fehler', async t => {
  let n = 0;
  for (const [name, pfad] of Object.entries(fx.pfade)) {
    const r = await pruefe(pfad);
    pruefeSchema(r, name);
    assert.ok(!codes(r).some(c => KAPUTT_CODES.includes(c)), `${name}: ${JSON.stringify(r.warnings.filter(w => KAPUTT_CODES.includes(w.code)))}`);
    n++;
  }
  t.diagnostic(`${n} Fixtures geprueft`);
  assert.ok(n >= 80);
});

test('NUR LESEND: kein Fixture wird veraendert, keine neue Datei im Verzeichnis (alle Formate)', async () => {
  const vorher = readdirSync(fx.dir).sort();
  const snap = {};
  for (const [n, p] of Object.entries(fx.pfade)) snap[n] = { sha: sha(p), mtime: statSync(p).mtimeMs };
  for (const p of Object.values(fx.pfade)) await pruefe(p);
  assert.deepEqual(readdirSync(fx.dir).sort(), vorher);
  for (const [n, p] of Object.entries(fx.pfade)) {
    assert.equal(statSync(p).mtimeMs, snap[n].mtime, n);
    assert.equal(sha(p), snap[n].sha, n);
  }
});

test('KEIN Entpacken, KEIN Schreiben: Inspektoren importieren weder fs-Schreibfunktionen noch child_process', () => {
  const quellen = ['sicherheit', 'zip', 'tar', 'sevenzip', 'sqlite', 'index'].map(n => join(hier, '..', 'src', 'asset-intel', 'inspectors', 'archiv', n + '.ts'));
  for (const q of quellen) {
    if (!existsSync(q)) continue; // Test gegen dist ohne Quellen
    const text = readFileSync(q, 'utf8');
    assert.ok(!/from ['"](node:)?(fs|fs\/promises|child_process)['"]/.test(text), q + ' importiert fs/child_process');
    assert.ok(!/writeFile|createWriteStream|appendFile|mkdir|unlink|rename\(|execFile|spawn\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), q + ' enthaelt Schreib-/Prozessaufrufe');
  }
});

// =============================================================== Fuzz

function xorshift(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

async function fuzzFamilie(t, endungen) {
  const dir = join(fx.dir, 'fuzz');
  mkdirSync(dir, { recursive: true });
  let laeufe = 0;
  let langsamster = 0;
  const kandidaten = Object.entries(fx.pfade).filter(([, p]) => endungen.includes(extname(p).toLowerCase()) && statSync(p).size < 200_000);
  assert.ok(kandidaten.length >= 3, 'zu wenige Fixtures fuer ' + endungen.join(','));
  let idx = 0;
  for (const [name, pfad] of kandidaten) {
    idx++;
    const roh = readFileSync(pfad);
    const n = roh.length;
    const ziel = join(dir, basename(pfad));
    const varianten = [];
    for (const l of [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 16, 21, 22, 23, 31, 32, 33, 63, 64, 99, 100, 101, 255, 256, 511, 512, 513, 1023, 1024, n >> 1, n - 1, n - 2, n - 10, n - 22, n - 23]) {
      if (l >= 0 && l < n) varianten.push(['abgeschnitten ' + l, roh.subarray(0, l)]);
    }
    const rnd = xorshift(1234 + idx * 7919);
    for (let k = 0; k < 14; k++) {
      const kopie = Buffer.from(roh);
      const flips = 1 + (k % 3) * 2;
      for (let f = 0; f < flips; f++) {
        const region = rnd() % 10;
        const pos = region < 4 ? rnd() % Math.min(n, 160) : region < 8 ? n - 1 - (rnd() % Math.min(n, 160)) : rnd() % n;
        kopie[pos] = rnd() & 0xff;
      }
      varianten.push(['korrupt ' + k, kopie]);
    }
    for (const [was, inhalt] of varianten) {
      writeFileSync(ziel, inhalt);
      const t0 = Date.now();
      const r = await pruefe(ziel);
      const dauer = Date.now() - t0;
      langsamster = Math.max(langsamster, dauer);
      const bad = r.warnings.filter(w => KAPUTT_CODES.includes(w.code) || w.code === 'zeitgrenze');
      assert.equal(bad.length, 0, `${name} (${was}): ${JSON.stringify(bad)}`);
      assert.ok(dauer < 5000, `${name} (${was}) brauchte ${dauer} ms`);
      pruefeSchema(r, `${name} (${was})`);
      laeufe++;
    }
  }
  t.diagnostic(`Fuzz ${endungen.join(',')}: ${laeufe} Laeufe, ${kandidaten.length} Dateien, langsamster ${langsamster} ms, 0 interne Fehler`);
  return laeufe;
}

test('FUZZ ZIP: abgeschnittene und beschaedigte Varianten aller ZIP-Fixtures => nie inspektor_fehler/Zeitgrenze', async t => {
  assert.ok((await fuzzFamilie(t, ['.zip'])) > 500);
});
test('FUZZ TAR/gzip: abgeschnittene und beschaedigte Varianten', async t => {
  assert.ok((await fuzzFamilie(t, ['.tar', '.tgz', '.gz', '.bz2', '.xz', '.zst'])) > 300);
});
test('FUZZ 7z: abgeschnittene und beschaedigte Varianten', async t => {
  assert.ok((await fuzzFamilie(t, ['.7z'])) > 300);
});
test('FUZZ SQLite: abgeschnittene und beschaedigte Varianten (kleine Datenbanken)', async t => {
  assert.ok((await fuzzFamilie(t, ['.db', '.sqlite'])) > 100);
});

// =============================================================== Proben von asset-sammler (echte Fremddateien, optional)

const PROBEN = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
const probe = (...teile) => join(PROBEN, ...teile);

/** Namen laut python3-zipfile (Fremdwerkzeug-Referenz; dekodiert Namen ohne UTF-8-Flag wie die Spezifikation als CP437). */
const pyZipNamen = p => JSON.parse(execFileSync('python3', ['-c', 'import zipfile,sys,json;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', p]).toString());

test('PROBEN ZIP (asset-sammler/sharpcompress): Namen == python3-zipfile (inkl. CP437); Evil.zip flaggt Pfade; Kommentar; WinZip-AES; Deflate64', async t => {
  if (!existsSync(probe('zip')) || braucht(t, 'python3')) return t.skip('keine Proben');
  let n = 0;
  for (const f of readdirSync(probe('zip')).filter(x => x.endsWith('.zip'))) {
    const p = probe('zip', f);
    const r = await pruefe(p);
    pruefeSchema(r, f);
    assert.ok(!codes(r).some(c => KAPUTT_CODES.includes(c)), f);
    assert.deepEqual(namen(r), pyZipNamen(p), f);
    n++;
  }
  assert.ok(n >= 5);
  const evil = await pruefe(probe('zip', 'Zip.Evil.zip'));
  assert.ok(evil.metadata.gefaehrliche_pfade >= 1, 'Evil.zip: ' + JSON.stringify(namen(evil)));
  assert.ok(codes(evil).includes('pfad_gefaehrlich'));
  const kom = await pruefe(probe('zip', 'Zip.EntryComment.zip'));
  assert.ok(kom.objects.some(o => o.data.kommentar), 'Eintragskommentar gelesen');
  const aes = await pruefe(probe('zip', 'Zip.deflate.WinzipAES.zip'));
  assert.ok(aes.objects.some(o => o.data.methode === 99 && o.data.verschluesselt));
  assert.ok(codes(aes).includes('archiv_verschluesselt'));
  const d64 = await pruefe(probe('zip', 'Zip.deflate64.zip'));
  assert.ok(d64.objects.some(o => o.data.methode === 9));
});

test('PROBEN TAR/tar.gz: Namen und Groessen == tar -tvf', async t => {
  if (!existsSync(probe('tar')) || braucht(t, 'tar')) return t.skip('keine Proben');
  for (const p of [probe('tar', 'Tar.tar'), probe('tar', 'Tar.PaxGlobalHeader.tar')]) {
    const r = await pruefe(p);
    const soll = tarListe(p);
    assert.equal(r.status, 'ok', p);
    // tar zeigt Namen mit ungueltigem UTF-8 als \\ooo-Escapes; der Inspektor liefert dort U+FFFD (kein Raten der Codierung).
    assert.deepEqual(namen(r).map(x => (x.includes('�') ? '<ungueltig>' : x)), soll.map(s => (/\\[0-7]{3}/.test(s.name) ? '<ungueltig>' : s.name)), p);
    soll.forEach((s, i) => assert.equal(r.objects[i].data.groesse, s.groesse, s.name));
  }
  if (existsSync(probe('tar.gz', 'Tar.tar.gz'))) {
    const p = probe('tar.gz', 'Tar.tar.gz');
    const r = await pruefe(p);
    assert.equal(r.format, 'tar.gz');
    assert.deepEqual(namen(r).map(x => (x.includes('�') ? '<ungueltig>' : x)), tarListe(p).map(s => (/\\[0-7]{3}/.test(s.name) ? '<ungueltig>' : s.name)));
  }
});

test('PROBEN 7z (sharpcompress): plain => Namen == 7z l -slt; sonst teilweise + Warnung', async t => {
  if (!existsSync(probe('7z')) || braucht(t, '7z')) return t.skip('keine Proben');
  let plain = 0;
  let kodiert = 0;
  for (const f of readdirSync(probe('7z')).filter(x => x.endsWith('.7z'))) {
    const p = probe('7z', f);
    const r = await pruefe(p);
    pruefeSchema(r, f);
    assert.ok(!codes(r).some(c => KAPUTT_CODES.includes(c)), f + ' ' + JSON.stringify(r.warnings));
    if (r.status === 'ok') {
      plain++;
      const soll = parse7zListe(execFileSync('7z', ['l', '-slt', '-pwrong', p]).toString());
      assert.deepEqual(namen(r).sort(), soll.map(s => s.Path).sort(), f);
    } else {
      kodiert++;
      assert.ok(codes(r).includes('header_komprimiert_oder_verschluesselt') || codes(r).includes('archiv_verschluesselt'), f + ' ' + JSON.stringify(r.warnings));
    }
  }
  t.diagnostic(`7z-Proben: ${plain} mit lesbarem Header, ${kodiert} komprimiert/verschluesselt (teilweise)`);
  assert.ok(plain + kodiert >= 4);
});

test('PROBEN SQLite (Chinook, 1 MB): sqlite_master, Spalten, Fremdschluessel, Zeilenzahlen == sqlite3', async t => {
  const db = probe('sqlite', 'Chinook_Sqlite.sqlite');
  if (!existsSync(db) || braucht(t, 'sqlite3')) return t.skip('keine Probe');
  const r = await pruefe(db);
  pruefeSchema(r, 'chinook');
  assert.equal(r.status, 'ok');
  const soll = sq(db, 'select type,name,tbl_name,rootpage from sqlite_master order by rowid');
  assert.deepEqual(r.objects.map(o => [o.kind, o.name, o.data.tabelle, String(o.data.rootpage)]), soll);
  let fks = 0;
  let spalten = 0;
  for (const o of r.objects.filter(x => x.kind === 'table')) {
    const info = sq(db, `pragma table_info("${o.name}")`);
    assert.deepEqual(
      o.data.columns.map(c => [c.name, norm(c.type), c.not_null ? '1' : '0', c.primary_key ? '1' : '0']),
      info.map(i => [i[1], norm(i[2]), i[3], Number(i[5]) > 0 ? '1' : '0']),
      o.name
    );
    spalten += info.length;
    // pragma foreign_key_list nennt die Fremdschluessel in umgekehrter Deklarationsreihenfolge: Reihenfolge ignorieren.
    const fk = sq(db, `pragma foreign_key_list("${o.name}")`).map(f => [f[3], f[2], f[4] || null]).sort();
    assert.deepEqual(o.data.foreign_keys.map(f => [f.spalte, f.ziel_tabelle, f.ziel_spalte]).sort(), fk, 'FK ' + o.name);
    fks += fk.length;
    if (typeof o.data.zeilen === 'number') {
      assert.equal(o.data.zeilen, Number(sq(db, `select count(*) from "${o.name}"`)[0][0]), 'Zeilen ' + o.name);
    }
  }
  t.diagnostic(`Chinook: ${soll.length} Schemaobjekte, ${spalten} Spalten, ${fks} Fremdschluessel gegen sqlite3 verglichen; ` +
    `Zeilen gezaehlt fuer ${r.objects.filter(o => typeof o.data.zeilen === 'number').length} Tabellen`);
  assert.ok(fks >= 8);
  assert.equal(r.metadata.seiten, Number(sq(db, 'pragma page_count')[0][0]));
});
