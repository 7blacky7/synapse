/**
 * Asset-Intel PE/ELF-Inspektoren (P4-T66 Teil b) gegen gebautes dist.
 * Zwei Quellen: (1) handgebaute Spec-Fixtures (scripts/asset-fixtures-exe.mjs) inkl. boesartiger
 * Varianten, (2) ECHTE Dateien von gcc/mingw, deren Bytes zusaetzlich mit readelf/objdump
 * gegengemessen werden (Tests ueberspringen sich, wenn das Werkzeug fehlt). Programme werden
 * nie ausgefuehrt.
 * AUFRUF: ASSET_TEST_DIST=<dist> node --test packages/core/tests/asset-intel-exe.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const X = await import(join(dist, 'asset-intel', 'inspectors', 'exe', 'index.js'));
const E = await import(join(dist, 'asset-intel', 'errors.js'));
const { inspectAsset, AssetRegistry } = A;
const F = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-exe.mjs')).href);

const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];
const STATUS = ['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'];
const codes = r => r.warnings.map(w => w.code);
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, `${wo}: Feld fehlt: ${k}`);
  assert.equal(r.asset_type, 'executable', wo);
  assert.ok(STATUS.includes(r.status), `${wo}: status ${r.status}`);
  assert.ok(r.format === 'pe' || r.format === 'elf', `${wo}: format ${r.format}`);
  assert.ok(r.sha256 === null || /^[0-9a-f]{64}$/.test(r.sha256), wo);
  assert.ok(Number.isInteger(r.size) && r.size >= 0, wo);
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), `${wo} ${k}`);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), `${wo} ${k}`);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', `${wo} warning-Form`);
  for (const o of r.objects) {
    assert.ok(typeof o.kind === 'string' && o.kind, `${wo}: Objekt ohne kind`);
    assert.ok(o.name === null || typeof o.name === 'string', `${wo}: Objektname`);
    assert.ok(o.data && typeof o.data === 'object', `${wo}: Objekt ohne data`);
    // Jedes Objekt traegt eine Position, die in der Datei liegt.
    assert.ok(o.source_range && Number.isSafeInteger(o.source_range.offset) && Number.isSafeInteger(o.source_range.length), `${wo}: source_range fehlt bei ${o.kind} ${o.name}`);
    assert.ok(o.source_range.offset >= 0 && o.source_range.length >= 0 && o.source_range.offset + o.source_range.length <= r.size, `${wo}: source_range ausserhalb der Datei bei ${o.kind} ${o.name}`);
  }
  for (const ref of r.references) assert.ok(typeof ref.target === 'string' && ref.target && typeof ref.kind === 'string', `${wo}: Referenz`);
  assert.ok(Number.isInteger(r.parser_version) && r.parser_version >= 1, wo);
  JSON.stringify(r);
}

const objekte = (r, kind) => r.objects.filter(o => o.kind === kind);
const objekt = (r, kind, name) => r.objects.find(o => o.kind === kind && o.name === name);

let fx;
let reg;
const lauf = (pfad, opts = {}) => inspectAsset(pfad, { registry: reg, ...opts });

before(async () => {
  reg = new AssetRegistry();
  for (const i of X.assetExeInspektoren) reg.register(i);
  fx = await F.erzeugeExeFixtures();
});
after(async () => {
  await fx.aufraeumen();
});

const werkzeug = name => {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const ausgabe = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });

// ---------------------------------------------------------------------------------------------
// Registrierung und Erkennung
// ---------------------------------------------------------------------------------------------

test('Export: assetExeInspektoren = exe-pe + exe-elf, ordentlich registrierbar', () => {
  assert.deepEqual(X.assetExeInspektoren.map(i => i.id), ['exe-pe', 'exe-elf']);
  for (const i of X.assetExeInspektoren) {
    assert.ok(Number.isInteger(i.version) && i.version >= 1);
    assert.ok(i.formats.length >= 1 && i.extensions.length >= 1 && i.magic.length >= 1);
    new AssetRegistry().register(i); // wirft nicht
  }
  assert.deepEqual(reg.formats(), ['elf', 'pe']);
});

test('Magic vor Endung: PE unter .txt/.png, ELF unter .txt werden erkannt; ELF unter .exe -> Inhalt gilt + Warnung', async () => {
  for (const k of ['pe64exeAlsTxt', 'pe64exeAlsPng']) {
    const r = await lauf(fx.pfade[k]);
    assert.equal(r.format, 'pe', k);
    assert.equal(r.inspector, 'exe-pe', k);
    assert.equal(r.status, 'ok', k);
  }
  const t = await lauf(fx.pfade.elfAlsTxt);
  assert.equal(t.format, 'elf');
  assert.equal(t.inspector, 'exe-elf');
  const e = await lauf(fx.pfade.elfAlsExe);
  assert.equal(e.format, 'elf');
  assert.equal(e.inspector, 'exe-elf');
  assert.ok(codes(e).includes('endung_widerspricht_inhalt'));
});

test('Endung ohne passenden Inhalt: .exe ohne MZ -> status fehler mit Warnung, wirft nie', async () => {
  const r = await lauf(fx.pfade.peKeinMz);
  pruefeSchema(r, 'peKeinMz');
  assert.equal(r.status, 'fehler');
  assert.ok(codes(r).includes('keine_mz_signatur'));
  assert.ok(codes(r).includes('magic_fehlt'));
});

test('Magic-Kollision dokumentiert: mit generic-binary ist ELF OHNE Endung mehrdeutig, mit .so loest die Endung auf', async () => {
  const kombi = new AssetRegistry();
  // Grundschicht-Stand von generic-binary (ELF-Magic, vor der Verdrahtung).
  kombi.register({ ...A.genericBinaryInspector, formats: ['elf'], magic: [{ offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], format: 'elf' }] });
  for (const i of X.assetExeInspektoren) kombi.register(i);
  // Datei ohne Endung bauen
  const ohnePfad = join(fx.dir, 'elf-ohne-endung');
  writeFileSync(ohnePfad, readFileSync(fx.pfade.elf64voll));
  const m = await inspectAsset(ohnePfad, { registry: kombi });
  assert.equal(m.inspector, null);
  assert.ok(codes(m).includes('erkennung_mehrdeutig'));
  const s = await inspectAsset(fx.pfade.elf64voll, { registry: kombi });
  assert.equal(s.inspector, 'exe-elf');
});

// ---------------------------------------------------------------------------------------------
// Schema ueber alle Fixtures
// ---------------------------------------------------------------------------------------------

test('Ergebnisschema ist fuer JEDE Fixture-Datei vollstaendig, serialisierbar, ohne Wurf', async () => {
  const alle = { ...fx.pfade };
  for (const [k, p] of Object.entries(fx.echt)) alle['echt.' + k] = p;
  let n = 0;
  for (const [k, p] of Object.entries(alle)) {
    if (typeof p !== 'string') continue;
    const r = await lauf(p);
    pruefeSchema(r, k);
    n++;
  }
  assert.ok(n >= 40, `nur ${n} Fixtures geprueft`);
});

test('Ergebnis ist deterministisch (ausser extracted_at) und die Datei bleibt unveraendert', async () => {
  const p = fx.pfade.pe32dll;
  const vorher = { sha: sha(p), mtime: statSync(p).mtimeMs };
  const a = await lauf(p);
  const b = await lauf(p);
  a.extracted_at = b.extracted_at = '';
  assert.deepEqual(a, b);
  assert.equal(sha(p), vorher.sha);
  assert.equal(statSync(p).mtimeMs, vorher.mtime);
  assert.equal(a.sha256, vorher.sha);
});

// ---------------------------------------------------------------------------------------------
// PE: handgebaut (gegen die Spezifikation)
// ---------------------------------------------------------------------------------------------

test('PE32-DLL (Spec-Fixture): Header, Haertung, Sektionen', async () => {
  const r = await lauf(fx.pfade.pe32dll);
  pruefeSchema(r, 'pe32dll');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.inspector, 'exe-pe');
  const m = r.metadata;
  assert.equal(m.architektur, 'x86 (i386)');
  assert.equal(m.maschine_code, '0x14c');
  assert.equal(m.pe_variante, 'PE32');
  assert.equal(m.bits, 32);
  assert.equal(m.typ, 'dll');
  assert.equal(m.zeitstempel, '2020-07-04T04:05:20.000Z');
  assert.equal(m.linker_version, '14.29');
  assert.equal(m.image_base, '0x10000000');
  assert.equal(m.einstiegspunkt_rva, '0x1000');
  assert.equal(m.einstiegspunkt_sektion, '.text');
  assert.equal(m.subsystem, 'windows_cui');
  assert.equal(m.pruefsumme_gesetzt, false);
  assert.equal(m.haertung.aslr, true);
  assert.equal(m.haertung.high_entropy_va, true);
  assert.equal(m.haertung.dep_nx, true);
  assert.equal(m.haertung.cfg, false);
  assert.equal(m.merkmale.dll, true);
  assert.equal(m.packer_hinweis, null);
  assert.equal(m.overlay_bytes, undefined);
  const sekt = objekte(r, 'sektion');
  assert.deepEqual(sekt.map(s => s.name), ['.text', '.rdata', '.rsrc']);
  assert.equal(sekt[0].data.rechte, 'r-x');
  assert.equal(sekt[0].data.enthaelt_code, true);
  assert.equal(sekt[1].data.rechte, 'r--');
  assert.equal(sekt[0].data.entropie, 0);
  assert.deepEqual(sekt[0].source_range, { offset: 0x200, length: 0x200 });
});

test('PE32-DLL: Imports, Delay-Imports, Exporte als references/objects', async () => {
  const r = await lauf(fx.pfade.pe32dll);
  assert.deepEqual(r.references, [
    { target: 'KERNEL32.dll', kind: 'library' },
    { target: 'USER32.dll', kind: 'library' },
    { target: 'ADVAPI32.dll', kind: 'library' },
  ]);
  const k32 = objekt(r, 'import_dll', 'KERNEL32.dll');
  assert.deepEqual(k32.data.funktionen, ['ExitProcess', 'GetLastError', '#7']); // #7 = Import per Ordinal
  assert.equal(k32.data.funktionen_anzahl, 3);
  assert.equal(k32.data.funktionen_gekappt, false);
  assert.deepEqual(objekt(r, 'import_dll', 'USER32.dll').data.funktionen, ['MessageBoxA']);
  assert.deepEqual(objekt(r, 'delay_import_dll', 'ADVAPI32.dll').data.funktionen, ['RegCloseKey']);
  assert.equal(r.format_specific.import_dll_anzahl, 2);
  assert.equal(r.format_specific.delay_import_dll_anzahl, 1);
  const ex = objekt(r, 'export_verzeichnis', 'foo.dll');
  assert.equal(ex.data.ordinal_basis, 1);
  assert.equal(ex.data.funktionen_anzahl, 3);
  assert.equal(ex.data.namen_anzahl, 2);
  assert.equal(ex.data.nur_ordinal_anzahl, 1);
  assert.deepEqual(ex.data.namen, [{ name: 'foo_add', ordinal: 1 }, { name: 'foo_mul', ordinal: 2 }]);
  assert.equal(r.metadata.export_dll_name, 'foo.dll');
});

test('PE32-DLL: Ressourcen-Typen (oberste Ebene), Versionsinfo, PDB, Authenticode, .NET', async () => {
  const r = await lauf(fx.pfade.pe32dll);
  assert.deepEqual(r.format_specific.ressourcen_typen, [
    { typ: 'ICON', anzahl: 2 },
    { typ: 'VERSION', anzahl: 1 },
    { typ: 'MANIFEST', anzahl: 1 },
  ]);
  assert.deepEqual(r.metadata.versionsinfo, { FileVersion: '1.2.3.4', ProductName: 'Fixture', CompanyName: 'Synapse Test' });
  assert.equal(r.metadata.datei_version, '1.2.3.4');
  assert.deepEqual(r.metadata.pdb, { pfad: 'C:\\build\\foo.pdb', guid: '33221100-5544-7766-8899-aabbccddeeff', alter: 7, format: 'RSDS' });
  assert.equal(r.metadata.authenticode.vorhanden, true);
  assert.equal(r.metadata.authenticode.validiert, false); // wird nie validiert
  assert.equal(r.metadata.authenticode.groesse, 64);
  assert.equal(r.metadata.dotnet.vorhanden, true);
  assert.equal(r.metadata.dotnet.laufzeit_version, 'v4.0.30319');
  assert.equal(r.metadata.dotnet.nur_il, true);
  assert.deepEqual(r.format_specific.debug_typen, ['CODEVIEW']);
});

test('PE32+ EXE mit hoher Entropie: 64 Bit, Packer-Hinweis; ohne Authenticode/.NET', async () => {
  const r = await lauf(fx.pfade.pe64exe);
  pruefeSchema(r, 'pe64exe');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.architektur, 'x64 (AMD64)');
  assert.equal(r.metadata.pe_variante, 'PE32+');
  assert.equal(r.metadata.bits, 64);
  assert.equal(r.metadata.typ, 'exe');
  assert.equal(r.metadata.image_base, '0x180000000');
  assert.deepEqual(r.metadata.packer_hinweis.sektionen_mit_hoher_entropie, ['.text']);
  assert.ok(objekt(r, 'sektion', '.text').data.entropie > 7.2);
  assert.equal(r.metadata.authenticode.vorhanden, false);
  assert.deepEqual(r.metadata.dotnet, { vorhanden: false });
  assert.deepEqual(r.references, [{ target: 'KERNEL32.dll', kind: 'library' }]);
});

test('PE nur Exporte (kein Import-Verzeichnis): Exporte ok, keine Referenzen', async () => {
  const r = await lauf(fx.pfade.peNurExporte);
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.deepEqual(r.references, []);
  assert.deepEqual(objekt(r, 'export_verzeichnis', 'x.dll').data.namen.map(n => n.name), ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------------------------
// PE: boesartig / kaputt
// ---------------------------------------------------------------------------------------------

test('PE abgeschnitten direkt nach e_lfanew: teilweise, kein Wurf, keine Objekte', async () => {
  const r = await lauf(fx.pfade.peAbgeschnittenNachLfanew);
  pruefeSchema(r, 'abgeschnitten');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('pe_header_ausserhalb_datei'));
  assert.deepEqual(r.objects, []);
  assert.equal(r.metadata.pe_header_offset, 128);
});

test('PE im Optional Header abgeschnitten und e_lfanew weit ausserhalb', async () => {
  const k = await lauf(fx.pfade.peAbgeschnittenImKopf);
  pruefeSchema(k, 'kopf');
  assert.equal(k.status, 'teilweise');
  assert.ok(codes(k).includes('optional_header_abgeschnitten'));
  assert.ok(codes(k).includes('sektionstabelle_abgeschnitten'));
  assert.equal(k.metadata.architektur, 'x86 (i386)'); // COFF-Teil ist noch lesbar
  const l = await lauf(fx.pfade.peLfanewAusserhalb);
  assert.equal(l.status, 'teilweise');
  assert.ok(codes(l).includes('pe_header_ausserhalb_datei'));
});

test('PE: Sektionen mit Rohdaten ausserhalb der Datei -> nichts dort gelesen, Verzeichnisse als ausserhalb gemeldet', async () => {
  const r = await lauf(fx.pfade.peSektionenAusserhalb);
  pruefeSchema(r, 'sekt-ausserhalb');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('sektion_ausserhalb_datei'));
  assert.ok(codes(r).includes('import_verzeichnis_ausserhalb'));
  assert.deepEqual(r.references, []);
  const rdata = objekt(r, 'sektion', '.rdata');
  assert.equal(rdata.data.rohdaten_in_datei, false);
  // Position fuer eine Sektion ausserhalb ist der Header-Eintrag, nicht der ungueltige Bereich.
  assert.equal(rdata.source_range.length, 40);
});

test('PE: absurde NumberOfSections (60000) wird gekappt (<= 96), Sektionstabelle an der Dateigrenze abgefangen', async () => {
  const r = await lauf(fx.pfade.peSektionenAbsurd);
  pruefeSchema(r, 'absurd');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('sektionszahl_unplausibel'));
  assert.ok(objekte(r, 'sektion').length <= 96);
  assert.equal(r.metadata.sektionen_laut_header, 60000);
  const a = await lauf(fx.pfade.peSektionenAbgeschnitten);
  pruefeSchema(a, 'sektionen-abgeschnitten');
  assert.ok(codes(a).includes('sektionstabelle_abgeschnitten'));
});

test('PE: Import-Tabellen-Zyklus (Deskriptor wiederholt sich, kein Terminator) endet, KERNEL32 nur einmal', async () => {
  const r = await lauf(fx.pfade.peImportZyklus, { timeoutMs: 5000 });
  pruefeSchema(r, 'zyklus');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('import_zyklus'));
  assert.deepEqual(r.references, [{ target: 'KERNEL32.dll', kind: 'library' }]);
  assert.equal(objekte(r, 'import_dll').length, 1);
});

test('PE: Ressourcen-Zyklus (Typ-Eintrag zeigt auf die Wurzel) wird erkannt', async () => {
  const r = await lauf(fx.pfade.peRessourcenZyklus, { timeoutMs: 5000 });
  pruefeSchema(r, 'res-zyklus');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('ressourcen_zyklus'));
});

test('PE: DLL-Name ohne Nullterminator (Sektionsende) -> gekappt gelesen + Warnung', async () => {
  const r = await lauf(fx.pfade.peNameOhneTerminator);
  pruefeSchema(r, 'ohne-terminator');
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('name_ohne_nullterminator'));
  assert.deepEqual(r.references, [{ target: 'AAAA', kind: 'library' }]);
});

test('PE: leere Datei, nur "MZ", Muell unter .exe -> kontrolliert, nie ein Wurf', async () => {
  const leer = join(fx.dir, 'leer.exe');
  writeFileSync(leer, Buffer.alloc(0));
  const l = await lauf(leer);
  assert.equal(l.status, 'teilweise');
  assert.ok(codes(l).includes('datei_leer'));
  const mz = await lauf(fx.pfade.peLeerMz);
  pruefeSchema(mz, 'nur-mz');
  assert.equal(mz.status, 'teilweise');
  assert.ok(codes(mz).includes('dos_header_abgeschnitten'));
  const dos = join(fx.dir, 'dos-stub.exe');
  writeFileSync(dos, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62), Buffer.from('nur ein DOS-Programm, kein PE-Header folgt')]));
  const d = await lauf(dos);
  assert.equal(d.status, 'teilweise');
  assert.ok(codes(d).includes('pe_header_ausserhalb_datei'));
});

test('PE: Signatur an e_lfanew falsch (NE-Datei) -> kein_pe_header mit Dateityp', async () => {
  const p = join(fx.dir, 'ne.exe');
  const b = Buffer.alloc(256);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('NE', 0x80, 'latin1');
  writeFileSync(p, b);
  const r = await lauf(p);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('kein_pe_header'));
  assert.equal(r.format_specific.dateityp, 'ne');
});

// ---------------------------------------------------------------------------------------------
// Grenzen
// ---------------------------------------------------------------------------------------------

test('Grenzen PE: maxObjects kappt Objekte und Referenzen + Warnung; maxFileBytes nur Erkennung', async () => {
  const r = await lauf(fx.pfade.pe32dll, { maxObjects: 4 });
  pruefeSchema(r, 'maxObjects');
  assert.ok(r.objects.length <= 4 && r.references.length <= 4);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('objekte_gekappt_exe'));
  const g = await lauf(fx.pfade.pe32dll, { maxFileBytes: 100 });
  assert.ok(codes(g).includes('datei_zu_gross'));
  assert.equal(g.status, 'teilweise');
  assert.deepEqual(g.objects, []);
});

test('Grenzen ELF: maxObjects kappt, maxFileBytes nur Erkennung', async () => {
  const r = await lauf(fx.pfade.elf64voll, { maxObjects: 3 });
  pruefeSchema(r, 'elf-maxObjects');
  assert.ok(r.objects.length <= 3 && r.references.length <= 3);
  assert.equal(r.status, 'teilweise');
  assert.ok(codes(r).includes('objekte_gekappt_exe'));
  const g = await lauf(fx.pfade.elf64voll, { maxFileBytes: 100 });
  assert.ok(codes(g).includes('datei_zu_gross'));
});

test('Grenzen: winziges Lesebudget (maxReadBytes) -> Teilergebnis oder Fehler mit Warnung, kein Wurf', async () => {
  for (const [k, p] of [['pe', fx.pfade.pe32dll], ['elf', fx.pfade.elf64voll]]) {
    const r = await lauf(p, { maxReadBytes: 300 });
    pruefeSchema(r, 'readbudget-' + k);
    assert.notEqual(r.status, 'ok', k);
    assert.ok(codes(r).includes('lesegrenze_ueberschritten'), k + ' ' + JSON.stringify(codes(r)));
  }
});

test('Zeitgrenze: pruefeAbbruch in den Schleifen -> AssetLimitError(timeoutMs) wird nicht verschluckt', async () => {
  const buf = readFileSync(fx.pfade.pe32dll);
  const src = { filePath: 'x.dll', size: buf.length, readRange: async (o, l) => buf.subarray(o, o + l) };
  const ctx = {
    format: 'pe',
    limits: { ...A.STANDARD_GRENZEN },
    depth: 0,
    signal: new AbortController().signal,
    pruefeAbbruch() { throw new E.AssetLimitError('timeoutMs', 'Zeit um'); },
    warn() {},
    tiefer() { return ctx; },
  };
  await assert.rejects(X.peInspector.inspect(src, ctx), e => e instanceof E.AssetLimitError && e.grenze === 'timeoutMs');
  const elf = readFileSync(fx.pfade.elf64voll);
  const esrc = { filePath: 'x.so', size: elf.length, readRange: async (o, l) => elf.subarray(o, o + l) };
  await assert.rejects(X.elfInspector.inspect(esrc, ctx), e => e instanceof E.AssetLimitError && e.grenze === 'timeoutMs');
});

// ---------------------------------------------------------------------------------------------
// ELF: handgebaut (gegen die Spezifikation)
// ---------------------------------------------------------------------------------------------

test('ELF64 (Spec-Fixture): Kopf, Dynamic, Haertung, Symbole, Versionen, Notes', async () => {
  const r = await lauf(fx.pfade.elf64voll);
  pruefeSchema(r, 'elf64voll');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  const m = r.metadata;
  assert.equal(m.bits, 64);
  assert.equal(m.endian, 'little');
  assert.equal(m.os_abi, 'System V');
  assert.equal(m.typ, 'DYN');
  assert.equal(m.architektur, 'x86-64');
  assert.equal(m.art, 'pie_ausfuehrbar'); // DYN + PT_INTERP
  assert.equal(m.interpreter, '/lib64/ld-linux-x86-64.so.2');
  assert.equal(m.soname, 'libfix.so.1');
  assert.equal(m.runpath, '/opt/fix/lib');
  assert.equal(m.rpath, null);
  assert.deepEqual(m.abhaengigkeiten, ['libc.so.6', 'libm.so.6']);
  assert.deepEqual(r.references, [{ target: 'libc.so.6', kind: 'library' }, { target: 'libm.so.6', kind: 'library' }]);
  assert.equal(m.build_id, '00112233445566778899aabbccddeeff00112233');
  assert.deepEqual(m.compiler, ['GCC: (Fixture) 13.2.0']);
  assert.equal(m.gestrippt, false);
  assert.equal(m.haertung.relro, 'voll');
  assert.equal(m.haertung.bind_now, true);
  assert.equal(m.haertung.pie, true);
  assert.equal(m.haertung.nx, true);
  assert.equal(m.haertung.stack_schutz, true);
  assert.equal(m.haertung.fortify, true);
  assert.equal(m.hoechste_glibc_version, '2.34');
  assert.deepEqual(r.format_specific.symbolversionen, [{ datei: 'libc.so.6', versionen: ['GLIBC_2.2.5', 'GLIBC_2.34'] }]);
  const sym = objekt(r, 'dynamische_symbole', '.dynsym');
  assert.deepEqual(sym.data.importiert, ['printf', '__stack_chk_fail', '__printf_chk']);
  assert.deepEqual(sym.data.exportiert, ['fix_add', 'fix_mul']);
  assert.equal(sym.data.importiert_anzahl, 3);
  assert.equal(sym.data.exportiert_anzahl, 2);
  assert.equal(sym.data.lokal_anzahl, 1);
  assert.equal(m.symbole.importiert, 3);
});

test('ELF64 (Spec-Fixture): Programm- und Sektions-Header als Objekte mit Position', async () => {
  const r = await lauf(fx.pfade.elf64voll);
  const seg = objekte(r, 'segment');
  assert.deepEqual(seg.map(s => s.name), ['INTERP', 'LOAD', 'DYNAMIC', 'NOTE', 'GNU_STACK', 'GNU_RELRO']);
  assert.equal(seg.find(s => s.name === 'GNU_STACK').data.rechte, 'rw-');
  assert.equal(seg.find(s => s.name === 'LOAD').data.rechte, 'rwx');
  const sek = objekte(r, 'sektion').map(s => s.name);
  for (const n of ['.text', '.interp', '.note.gnu.build-id', '.dynsym', '.dynstr', '.dynamic', '.gnu.version_r', '.comment', '.symtab', '.shstrtab']) assert.ok(sek.includes(n), 'Sektion fehlt: ' + n);
  const dynstr = objekt(r, 'sektion', '.dynstr');
  assert.equal(dynstr.data.typ, 'STRTAB');
  const L = fx.pfade.elf64vollLayout;
  assert.deepEqual(dynstr.source_range, { offset: L.dynstrOff, length: L.dynstrSize });
  assert.equal(r.format_specific.programm_header_anzahl, 6);
});

test('ELF32 little-endian EXEC (Spec-Fixture): 32 Bit, nicht PIE, importiert puts', async () => {
  const r = await lauf(fx.pfade.elf32le);
  pruefeSchema(r, 'elf32le');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.bits, 32);
  assert.equal(r.metadata.endian, 'little');
  assert.equal(r.metadata.architektur, 'x86 (i386)');
  assert.equal(r.metadata.typ, 'EXEC');
  assert.equal(r.metadata.art, 'ausfuehrbar');
  assert.equal(r.metadata.haertung.pie, false);
  assert.equal(r.metadata.interpreter, '/lib/ld-linux.so.2');
  assert.deepEqual(objekt(r, 'dynamische_symbole', '.dynsym').data.importiert, ['puts']);
  assert.deepEqual(r.references, [{ target: 'libc.so.6', kind: 'library' }]);
});

test('ELF big-endian 32 und 64 Bit (Spec-Fixture): Felder werden mit richtiger Byte-Reihenfolge gelesen', async () => {
  const a = await lauf(fx.pfade.elf32be);
  pruefeSchema(a, 'elf32be');
  assert.equal(a.status, 'ok', JSON.stringify(a.warnings));
  assert.equal(a.metadata.endian, 'big');
  assert.equal(a.metadata.bits, 32);
  assert.equal(a.metadata.architektur, 'PowerPC');
  assert.equal(a.metadata.soname, 'libbe.so');
  assert.deepEqual(a.metadata.abhaengigkeiten, ['libc.so.6']);
  const sa = objekt(a, 'dynamische_symbole', '.dynsym').data;
  assert.deepEqual(sa.importiert, ['puts']);
  assert.deepEqual(sa.exportiert, ['be_fn']);
  const b = await lauf(fx.pfade.elf64be);
  pruefeSchema(b, 'elf64be');
  assert.equal(b.status, 'ok', JSON.stringify(b.warnings));
  assert.equal(b.metadata.endian, 'big');
  assert.equal(b.metadata.bits, 64);
  assert.equal(b.metadata.architektur, 'S390');
  assert.equal(b.metadata.soname, 'libbe64.so');
  assert.deepEqual(objekt(b, 'dynamische_symbole', '.dynsym').data.exportiert, ['be64_fn']);
  assert.deepEqual(objekte(b, 'segment').map(s => s.name), ['LOAD', 'DYNAMIC', 'GNU_STACK']); // kein INTERP/NOTE/RELRO gebaut
});

test('ELF ohne Sektions-Header (nur Programm-Header): Dynamic und Symbole ueber DT_HASH, gestrippt unbekannt', async () => {
  const r = await lauf(fx.pfade.elfOhneSektionen);
  pruefeSchema(r, 'ohne-sektionen');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.sektions_header_vorhanden, false);
  assert.equal(r.metadata.gestrippt, null);
  assert.equal(r.metadata.soname, 'libns.so');
  assert.deepEqual(r.metadata.abhaengigkeiten, ['libc.so.6']); // String-Tabelle ueber DT_STRTAB + LOAD-Abbildung
  assert.deepEqual(objekte(r, 'sektion'), []);
  const s = objekt(r, 'dynamische_symbole', '.dynsym').data;
  assert.deepEqual(s.importiert, ['abort']);
  assert.deepEqual(s.exportiert, ['ns_fn']);
  assert.equal(r.format_specific.sektions_header_anzahl, 0);
});

test('Kernelmodul (REL + .modinfo): art kernelmodul mit Modul-Infos', async () => {
  const r = await lauf(fx.pfade.elfKernelmodul);
  pruefeSchema(r, 'kmod');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.typ, 'REL');
  assert.equal(r.metadata.art, 'kernelmodul');
  assert.equal(r.metadata.kernelmodul.license, 'GPL');
  assert.equal(r.metadata.kernelmodul.name, 'fixmod');
  assert.equal(r.metadata.kernelmodul.vermagic, '6.1.0 SMP');
  assert.deepEqual(r.metadata.compiler, ['GCC: (Fixture) 13.2.0']);
});

// ---------------------------------------------------------------------------------------------
// ELF: boesartig / kaputt
// ---------------------------------------------------------------------------------------------

test('ELF abgeschnitten: im Kopf (30 Bytes), nach dem ersten Programm-Header, nur Magic', async () => {
  for (const k of ['elfAbgeschnittenKopf', 'elfAbgeschnittenNachPhdr', 'elfMuell']) {
    const r = await lauf(fx.pfade[k]);
    pruefeSchema(r, k);
    assert.equal(r.status, 'teilweise', k);
    assert.ok(r.warnings.length > 0, k);
  }
  const p = await lauf(fx.pfade.elfAbgeschnittenNachPhdr);
  assert.ok(codes(p).includes('programm_header_abgeschnitten'));
  assert.ok(codes(p).includes('sektions_header_ausserhalb'));
  assert.equal(p.metadata.architektur, 'x86-64'); // Kopf war lesbar
});

test('ELF: absurdes e_shnum / e_phnum (65000) wird gekappt', async () => {
  const s = await lauf(fx.pfade.elfShnumAbsurd);
  pruefeSchema(s, 'shnum');
  assert.equal(s.status, 'teilweise');
  assert.ok(codes(s).includes('shnum_unplausibel'));
  assert.ok(objekte(s, 'sektion').length <= 4096);
  const p = await lauf(fx.pfade.elfPhnumAbsurd);
  pruefeSchema(p, 'phnum');
  assert.ok(codes(p).includes('phnum_unplausibel'));
  assert.ok(objekte(p, 'segment').length <= 512);
});

test('ELF: e_shoff > 2^53 und Sektion mit Groesse ausserhalb der Datei', async () => {
  const a = await lauf(fx.pfade.elfShoffAusserhalb);
  pruefeSchema(a, 'shoff');
  assert.equal(a.status, 'teilweise');
  assert.ok(codes(a).includes('sektions_header_ausserhalb'));
  assert.deepEqual(a.metadata.abhaengigkeiten, ['libc.so.6', 'libm.so.6']); // Dynamic ueber Programm-Header trotzdem lesbar
  const b = await lauf(fx.pfade.elfSektionAusserhalb);
  pruefeSchema(b, 'sekt-ausserhalb');
  assert.ok(codes(b).includes('sektion_ausserhalb_datei'));
});

test('ELF: Namen ohne Nullterminator (SONAME am Tabellenende, Sektionsname am Tabellenende)', async () => {
  const a = await lauf(fx.pfade.elfDynstrOhneTerminator);
  pruefeSchema(a, 'dynstr');
  assert.equal(a.status, 'teilweise');
  assert.ok(codes(a).includes('name_ohne_nullterminator'));
  assert.equal(a.metadata.soname, 'libx.soX'); // gekappt gelesen, nicht verworfen
  const b = await lauf(fx.pfade.elfShstrOhneTerminator);
  pruefeSchema(b, 'shstr');
  assert.ok(codes(b).includes('name_ohne_nullterminator'));
});

test('ELF: Dynamic ohne DT_NULL, ungueltige Klasse, kein ELF unter .so', async () => {
  const a = await lauf(fx.pfade.elfDynamicOhneEnde);
  assert.ok(codes(a).includes('dynamic_ohne_ende'));
  assert.equal(a.status, 'teilweise');
  const b = await lauf(fx.pfade.elfKlasseUngueltig);
  assert.ok(codes(b).includes('elf_klasse_ungueltig'));
  assert.equal(b.status, 'teilweise');
  const so = join(fx.dir, 'kein-elf.so');
  writeFileSync(so, F.zufallBytes(500, 9));
  const c = await lauf(so);
  pruefeSchema(c, 'kein-elf');
  assert.equal(c.status, 'fehler');
  assert.ok(codes(c).includes('elf_magic_fehlt'));
  const leer = join(fx.dir, 'leer.so');
  writeFileSync(leer, Buffer.alloc(0));
  const d = await lauf(leer);
  assert.ok(codes(d).includes('datei_leer'));
});

test('ELF: Zyklus in den Versions-Anforderungen (vn_next zeigt zurueck) endet', async () => {
  const { buf, layout } = F.baueMinimalElf({ klasse: 64, typ: 3, needed: ['libc.so.6'], interp: '/lib64/ld-linux-x86-64.so.2', verneed: [{ datei: 'libc.so.6', versionen: ['GLIBC_2.2.5'] }, { datei: 'libm.so.6', versionen: ['GLIBC_2.2.5'] }] });
  // Zweiter Verneed-Eintrag: vn_next (Offset 12) so setzen, dass er auf sich selbst zeigt (Abstand 0 ist Ende; negativ = Zyklus).
  const p = Buffer.from(buf);
  p.writeUInt32LE(0xfffffff0 >>> 0, layout.verneedOff + 12); // erster: vn_next springt weit hinaus
  const pfad = join(fx.dir, 'verneed-zyklus.so');
  writeFileSync(pfad, p);
  const r = await lauf(pfad, { timeoutMs: 5000 });
  pruefeSchema(r, 'verneed-zyklus');
  assert.ok(['teilweise', 'ok'].includes(r.status));
  assert.ok(Array.isArray(r.format_specific.symbolversionen));
});

// ---------------------------------------------------------------------------------------------
// Robustheit: viele Symbole, zufaellig beschaedigte Dateien
// ---------------------------------------------------------------------------------------------

test('ELF mit 500000 behaupteten dynamischen Symbolen: laeuft zuegig durch, Zaehler stimmt, kein Wurf', async () => {
  const { buf, layout } = F.baueMinimalElf({ klasse: 64, typ: 3, needed: ['libc.so.6'], interp: '/lib64/ld-linux-x86-64.so.2', buildId: '00112233445566778899aabbccddeeff00112233', undef: ['a'] });
  const n = 500_000;
  const gross = Buffer.concat([buf, Buffer.alloc(layout.dynsymOff + n * 24 - buf.length + 24)]);
  gross.writeBigUInt64LE(BigInt(n * 24), layout.shoff + 4 * layout.shLen + 32); // .dynsym-Groesse
  const pfad = join(fx.dir, 'viele-symbole.so');
  writeFileSync(pfad, gross);
  const t0 = Date.now();
  const r = await lauf(pfad, { timeoutMs: 20000 });
  pruefeSchema(r, 'viele-symbole');
  assert.ok(Date.now() - t0 < 10000, 'zu langsam: ' + (Date.now() - t0) + ' ms');
  const s = objekt(r, 'dynamische_symbole', '.dynsym');
  assert.ok(s, JSON.stringify(codes(r)));
  assert.equal(s.data.anzahl_eintraege, n);
  assert.ok(s.data.importiert.length <= 200 && s.data.exportiert.length <= 200); // Namenslisten gekappt
});

test('Zufaellig beschaedigte Dateien (feste Seeds): kein Wurf, kein interner Fehler, keine Zeitgrenze', async () => {
  let lcg = 99;
  const rnd = n => {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    return lcg % n;
  };
  const basen = [['pe32dll', fx.pfade.pe32dll, '.exe'], ['pe64exe', fx.pfade.pe64exe, '.exe'], ['elf64voll', fx.pfade.elf64voll, '.so'], ['elf32be', fx.pfade.elf32be, '.so'], ['elfOhneSektionen', fx.pfade.elfOhneSektionen, '.so']];
  if (fx.echt.win64dll) basen.push(['win64dll', fx.echt.win64dll, '.dll']);
  if (fx.echt.hello) basen.push(['hello', fx.echt.hello, '.so']);
  let laeufe = 0;
  const schlecht = /_fehler$|^inspektor_fehler$|^interner_fehler$|^zeitgrenze$/;
  for (const [name, pfad, ext] of basen) {
    const orig = readFileSync(pfad);
    for (let i = 0; i < 60; i++) {
      const b = Buffer.from(orig);
      for (let k = 0, n = 1 + rnd(6); k < n; k++) {
        const o = rnd(rnd(3) === 0 ? b.length : Math.min(b.length, 1200));
        const modus = rnd(4);
        b[o] = modus === 0 ? 0xff : modus === 1 ? 0 : rnd(256);
        if (rnd(3) === 0 && o + 3 < b.length) b.writeUInt32LE(rnd(2) ? 0xffffffff : rnd(0x7fffffff), o);
      }
      const datei = join(fx.dir, 'fuzz' + ext);
      writeFileSync(datei, rnd(10) === 0 ? b.subarray(0, rnd(b.length)) : b);
      const r = await lauf(datei, { timeoutMs: 8000 });
      pruefeSchema(r, `${name}#${i}`);
      assert.deepEqual(codes(r).filter(c => schlecht.test(c)), [], `${name}#${i}: unerwarteter Fehler`);
      laeufe++;
    }
  }
  assert.ok(laeufe >= 300);
});

// ---------------------------------------------------------------------------------------------
// ECHTE Dateien (gcc / mingw) — GEMESSEN, mit Gegenmessung durch readelf/objdump
// ---------------------------------------------------------------------------------------------

test('ECHT ELF: hello (PIE, Full RELRO, Stack-Protector, Fortify) gegen Quelltext-Fakten', async t => {
  if (!fx.echt.hello) return t.skip('gcc fehlt');
  const r = await lauf(fx.echt.hello);
  pruefeSchema(r, 'echt.hello');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.art, 'pie_ausfuehrbar');
  assert.equal(r.metadata.haertung.pie, true);
  assert.equal(r.metadata.haertung.relro, 'voll');
  assert.equal(r.metadata.haertung.bind_now, true);
  assert.equal(r.metadata.haertung.stack_schutz, true);
  assert.equal(r.metadata.haertung.fortify, true);
  assert.equal(r.metadata.haertung.nx, true);
  assert.equal(r.metadata.gestrippt, false);
  assert.ok(r.metadata.interpreter.includes('ld-linux'));
  const libs = r.metadata.abhaengigkeiten;
  assert.ok(libs.includes('libc.so.6') && libs.includes('libm.so.6'), JSON.stringify(libs)); // hello.c ruft sqrt() und printf()
  const imp = objekt(r, 'dynamische_symbole', '.dynsym').data.importiert;
  for (const n of ['sqrt', 'strncpy', '__printf_chk', '__stack_chk_fail', '__libc_start_main']) assert.ok(imp.includes(n), 'Import fehlt: ' + n);
  assert.match(r.metadata.build_id, /^[0-9a-f]{40}$/);
  assert.ok(r.metadata.compiler[0].startsWith('GCC:'));
  assert.equal(r.metadata.abi_tag.os, 'Linux');
});

test('ECHT ELF: hello-nopie, gestrippt, statisch, Objektdatei, 32 Bit', async t => {
  if (!fx.echt.hello) return t.skip('gcc fehlt');
  const np = await lauf(fx.echt.nopie);
  assert.equal(np.metadata.typ, 'EXEC');
  assert.equal(np.metadata.haertung.pie, false);
  assert.equal(np.metadata.haertung.relro, 'keine');
  assert.equal(np.metadata.haertung.stack_schutz, false);
  const gs = await lauf(fx.echt.gestrippt);
  assert.equal(gs.status, 'ok', JSON.stringify(gs.warnings));
  assert.equal(gs.metadata.gestrippt, true);
  assert.equal(gs.metadata.symtab_eintraege, undefined);
  assert.deepEqual(gs.metadata.abhaengigkeiten.sort(), ['libc.so.6', 'libm.so.6']); // dynamische Symbole/Abhaengigkeiten ueberleben strip
  assert.ok(objekt(gs, 'dynamische_symbole', '.dynsym').data.importiert.includes('sqrt'));
  if (fx.echt.statisch) {
    const st = await lauf(fx.echt.statisch);
    assert.equal(st.status, 'ok', JSON.stringify(st.warnings));
    assert.equal(st.metadata.statisch_gelinkt, true);
    assert.equal(st.metadata.interpreter, null);
    assert.deepEqual(st.references, []);
  }
  if (fx.echt.objekt) {
    const o = await lauf(fx.echt.objekt);
    assert.equal(o.status, 'ok', JSON.stringify(o.warnings));
    assert.equal(o.metadata.typ, 'REL');
    assert.equal(o.metadata.art, 'objektdatei');
    assert.equal(o.metadata.einstiegspunkt, '0x0');
    assert.ok(objekte(o, 'sektion').some(s => s.name === '.text'));
  }
  if (fx.echt.elf32) {
    const e = await lauf(fx.echt.elf32);
    assert.equal(e.status, 'ok', JSON.stringify(e.warnings));
    assert.equal(e.metadata.bits, 32);
    assert.equal(e.metadata.architektur, 'x86 (i386)');
  }
});

test('ECHT ELF: libfoo.so (SONAME, RPATH vs. RUNPATH, Exporte aus foo.c)', async t => {
  if (!fx.echt.libfoo) return t.skip('gcc fehlt');
  const r = await lauf(fx.echt.libfoo);
  pruefeSchema(r, 'echt.libfoo');
  assert.equal(r.status, 'ok', JSON.stringify(r.warnings));
  assert.equal(r.metadata.art, 'shared_object');
  assert.equal(r.metadata.soname, 'libfoo.so.1');
  assert.equal(r.metadata.rpath, '/opt/foo/lib');
  assert.equal(r.metadata.runpath, null);
  assert.deepEqual(r.metadata.abhaengigkeiten, ['libc.so.6']);
  const s = objekt(r, 'dynamische_symbole', '.dynsym').data;
  assert.deepEqual([...s.exportiert].sort(), ['foo_add', 'foo_mul']);
  assert.ok(s.importiert.includes('puts'));
  if (fx.echt.libfooRunpath) {
    const q = await lauf(fx.echt.libfooRunpath);
    assert.equal(q.metadata.soname, 'libfoo2.so');
    assert.equal(q.metadata.runpath, '/opt/foo2');
    assert.equal(q.metadata.rpath, null);
  }
});

test('ECHT ELF gegengemessen mit readelf: NEEDED/SONAME/RPATH, Kopfzahlen, Build-ID, Symbolzaehler', async t => {
  if (!fx.echt.hello || !werkzeug('readelf')) return t.skip('gcc oder readelf fehlt');
  for (const k of ['hello', 'libfoo', 'gestrippt', 'nopie', 'statisch', 'libfooRunpath']) {
    const p = fx.echt[k];
    if (!p) continue;
    const r = await lauf(p);
    const dyn = ausgabe('readelf', ['-W', '-d', p]);
    const needed = [...dyn.matchAll(/\(NEEDED\)\s+Shared library: \[(.+?)\]/g)].map(m => m[1]);
    assert.deepEqual(r.metadata.abhaengigkeiten, needed, `${k}: NEEDED`);
    const so = /\(SONAME\)\s+Library soname: \[(.+?)\]/.exec(dyn);
    assert.equal(r.metadata.soname, so ? so[1] : null, `${k}: SONAME`);
    const rp = /\(RPATH\)\s+Library rpath: \[(.+?)\]/.exec(dyn);
    assert.equal(r.metadata.rpath, rp ? rp[1] : null, `${k}: RPATH`);
    const ru = /\(RUNPATH\)\s+Library runpath: \[(.+?)\]/.exec(dyn);
    assert.equal(r.metadata.runpath, ru ? ru[1] : null, `${k}: RUNPATH`);
    const h = ausgabe('readelf', ['-h', p]);
    assert.equal(r.format_specific.programm_header_anzahl, Number(/Number of program headers:\s+(\d+)/.exec(h)[1]), `${k}: Programm-Header`);
    assert.equal(r.format_specific.sektions_header_anzahl, Number(/Number of section headers:\s+(\d+)/.exec(h)[1]), `${k}: Sektions-Header`);
    assert.equal(r.size, statSize(p));
    const n = ausgabe('readelf', ['-n', p]);
    const bid = /Build ID: ([0-9a-f]+)/.exec(n);
    assert.equal(r.metadata.build_id ?? null, bid ? bid[1] : null, `${k}: Build-ID`);
    const ds = objekt(r, 'dynamische_symbole', '.dynsym');
    if (ds) {
      let imp = 0;
      let exp = 0;
      let lok = 0;
      for (const zeile of ausgabe('readelf', ['-W', '--dyn-syms', p]).split('\n')) {
        const f = zeile.trim().split(/\s+/);
        if (!/^\d+:$/.test(f[0]) || f[0] === '0:') continue;
        if (f[6] === 'UND') imp++;
        else if (['GLOBAL', 'WEAK', 'UNIQUE'].includes(f[4])) exp++;
        else lok++;
      }
      assert.equal(ds.data.importiert_anzahl, imp, `${k}: importierte Symbole`);
      assert.equal(ds.data.exportiert_anzahl, exp, `${k}: exportierte Symbole`);
      assert.equal(ds.data.lokal_anzahl, lok, `${k}: lokale Symbole`);
    }
  }
});

const statSize = p => statSync(p).size;

test('ECHT PE: mingw-w64 EXE/DLL (x64) und EXE (x86) gegen Quelltext-Fakten', async t => {
  if (!fx.echt.win64exe) return t.skip('mingw fehlt');
  const e = await lauf(fx.echt.win64exe);
  pruefeSchema(e, 'echt.win64exe');
  assert.equal(e.status, 'ok', JSON.stringify(e.warnings));
  assert.equal(e.metadata.architektur, 'x64 (AMD64)');
  assert.equal(e.metadata.pe_variante, 'PE32+');
  assert.equal(e.metadata.typ, 'exe');
  assert.equal(e.metadata.subsystem, 'windows_cui');
  assert.equal(e.metadata.haertung.aslr, true);
  assert.equal(e.metadata.haertung.dep_nx, true);
  assert.ok(e.references.some(x => x.target === 'USER32.dll'));
  assert.ok(objekt(e, 'import_dll', 'USER32.dll').data.funktionen.includes('MessageBoxA')); // win.c ruft MessageBoxA
  assert.ok(objekt(e, 'import_dll', 'KERNEL32.dll').data.funktionen.includes('ExitProcess'));
  // mingw legt Debug-Sektionen mit langen Namen ueber die COFF-String-Tabelle an
  assert.ok(objekte(e, 'sektion').some(s => s.name === '.text'));
  assert.ok(objekte(e, 'sektion').some(s => s.name.startsWith('.debug_')), 'lange Sektionsnamen (/n) nicht aufgeloest: ' + objekte(e, 'sektion').map(s => s.name).join(','));
  assert.ok(e.metadata.einstiegspunkt_sektion);
  const d = await lauf(fx.echt.win64dll);
  pruefeSchema(d, 'echt.win64dll');
  assert.equal(d.status, 'ok', JSON.stringify(d.warnings));
  assert.equal(d.metadata.typ, 'dll');
  const ex = objekte(d, 'export_verzeichnis')[0].data;
  assert.deepEqual(ex.namen.map(n => n.name).sort(), ['foo_add', 'foo_mul']); // windll.c exportiert genau diese
  assert.equal(ex.namen_anzahl, 2);
  if (fx.echt.win32exe) {
    const w32 = await lauf(fx.echt.win32exe);
    assert.equal(w32.status, 'ok', JSON.stringify(w32.warnings));
    assert.equal(w32.metadata.architektur, 'x86 (i386)');
    assert.equal(w32.metadata.pe_variante, 'PE32');
    assert.equal(w32.metadata.bits, 32);
    assert.ok(objekt(w32, 'import_dll', 'USER32.dll').data.funktionen.includes('MessageBoxA'));
  }
});

test('ECHT PE gegengemessen mit objdump -p: Header-Felder, DLL-Namen, Funktionslisten', async t => {
  if (!fx.echt.win64exe || !werkzeug('objdump')) return t.skip('mingw oder objdump fehlt');
  for (const k of ['win64exe', 'win64dll', 'win32exe']) {
    const p = fx.echt[k];
    if (!p) continue;
    const r = await lauf(p);
    const o = ausgabe('objdump', ['-p', p]);
    const feld = n => new RegExp('^' + n + '\\s+([0-9a-fA-F]+)', 'm').exec(o)[1];
    assert.equal(r.metadata.pe_variante, /Magic\s+\w+\s+\((PE32\+?)\)/.exec(o)[1], `${k}: Magic`);
    assert.equal(r.metadata.linker_version, `${feld('MajorLinkerVersion').replace(/^0+(?=.)/, '')}.${feld('MinorLinkerVersion').replace(/^0+(?=.)/, '')}`.replace(/\b0x/g, ''), `${k}: Linker-Version`);
    assert.equal(r.metadata.image_base, '0x' + feld('ImageBase').replace(/^0+(?=.)/, ''), `${k}: ImageBase`);
    assert.equal(r.metadata.image_groesse, parseInt(feld('SizeOfImage'), 16), `${k}: SizeOfImage`);
    assert.equal(r.metadata.pruefsumme, parseInt(feld('CheckSum'), 16), `${k}: CheckSum`);
    assert.equal(r.metadata.einstiegspunkt_rva, '0x' + feld('AddressOfEntryPoint').replace(/^0+(?=.)/, ''), `${k}: EntryPoint`);
    assert.equal(r.metadata.merkmale.wert, '0x' + parseInt(/^Characteristics\s+(0x[0-9a-f]+)/m.exec(o)[1], 16).toString(16), `${k}: Characteristics`);
    // Importe: je DLL die Funktionsnamen in Dateireihenfolge
    const ziel = new Map();
    let aktuell = null;
    for (const zeile of o.split('\n')) {
      const d = /^\tDLL Name: (.+)$/.exec(zeile);
      if (d) {
        aktuell = [];
        ziel.set(d[1].trim(), aktuell);
        continue;
      }
      const f = /^\t[0-9a-f]+\s+<none>\s+[0-9a-f]+\s+(\S+)\s*$/.exec(zeile);
      if (f && aktuell) aktuell.push(f[1]);
    }
    assert.deepEqual(r.references.map(x => x.target), [...ziel.keys()], `${k}: DLL-Namen`);
    for (const [dll, funcs] of ziel) {
      const obj = objekt(r, 'import_dll', dll);
      assert.deepEqual(obj.data.funktionen, funcs.slice(0, 100), `${k}: Funktionen von ${dll}`);
      assert.equal(obj.data.funktionen_anzahl, funcs.length, `${k}: Anzahl von ${dll}`);
    }
  }
});

/** Pfade echter, von GCC gebauter Windows-DLLs der mingw-w64-Laufzeit (nicht von uns erzeugt). */
function mingwLaufzeitDlls() {
  const aus = [];
  for (const arch of ['x86_64-w64-mingw32', 'i686-w64-mingw32']) {
    for (const unter of ['lib', 'bin']) {
      const d = `/usr/${arch}/${unter}`;
      try {
        for (const n of readdirSync(d)) if (n.toLowerCase().endsWith('.dll')) aus.push(join(d, n));
      } catch { /* Verzeichnis fehlt */ }
    }
  }
  return aus.slice(0, 24);
}

test('ECHT PE (Fremdbau): mingw-w64-Laufzeit-DLLs gegen objdump -p — Header, Importe, Exporte mit Ordinals', async t => {
  const dlls = mingwLaufzeitDlls();
  if (dlls.length === 0 || !werkzeug('objdump')) return t.skip('keine mingw-Laufzeit-DLLs oder objdump fehlt');
  let exportePruefungen = 0;
  for (const p of dlls) {
    const r = await lauf(p);
    pruefeSchema(r, p);
    assert.equal(r.status, 'ok', `${p}: ${JSON.stringify(r.warnings)}`);
    const o = ausgabe('objdump', ['-p', p]);
    assert.equal(r.metadata.pe_variante, /Magic\s+\w+\s+\((PE32\+?)\)/.exec(o)[1], `${p}: Magic`);
    assert.equal(r.metadata.typ, 'dll');
    assert.equal(r.metadata.image_groesse, parseInt(/^SizeOfImage\s+([0-9a-f]+)/m.exec(o)[1], 16), `${p}: SizeOfImage`);
    assert.equal(r.metadata.pruefsumme, parseInt(/^CheckSum\s+([0-9a-f]+)/m.exec(o)[1], 16), `${p}: CheckSum`);
    // Importe
    const imp = new Map();
    let aktuell = null;
    for (const zeile of o.split('\n')) {
      const d = /^\tDLL Name: (.+)$/.exec(zeile);
      if (d) {
        aktuell = [];
        imp.set(d[1].trim(), aktuell);
        continue;
      }
      const f = /^\t[0-9a-f]+\s+<none>\s+[0-9a-f]+\s+(\S+)\s*$/.exec(zeile);
      if (f && aktuell) aktuell.push(f[1]);
    }
    assert.deepEqual(r.references.map(x => x.target), [...imp.keys()], `${p}: DLL-Namen`);
    for (const [dll, funcs] of imp) assert.deepEqual(objekt(r, 'import_dll', dll).data.funktionen, funcs.slice(0, 100), `${p}: ${dll}`);
    // Exporte: "[ idx] +base[ ord]  hint name"
    const exp = [...o.matchAll(/^\t\[\s*\d+\] \+base\[\s*(\d+)\]\s+[0-9a-f]{4} (\S+)/gm)].map(m => ({ name: m[2], ordinal: Number(m[1]) }));
    const ex = objekte(r, 'export_verzeichnis')[0];
    if (exp.length > 0) {
      assert.ok(ex, `${p}: Export-Verzeichnis fehlt`);
      assert.equal(ex.data.namen_anzahl, exp.length, `${p}: Zahl der Export-Namen`);
      assert.deepEqual(ex.data.namen.map(n => ({ name: n.name, ordinal: n.ordinal })), exp.slice(0, 200), `${p}: Export-Namen + Ordinals`);
      exportePruefungen++;
    }
  }
  assert.ok(exportePruefungen > 0, 'keine einzige DLL mit Exporten gemessen');
});

test('ECHT ELF (Fremdbau): bis zu 60 System-Binaries/-Bibliotheken gegen readelf (NEEDED, SONAME, Kopfzahlen, Symbolzaehler, Build-ID)', async t => {
  if (!werkzeug('readelf')) return t.skip('readelf fehlt');
  const kand = [];
  for (const d of ['/usr/bin', '/usr/lib', '/usr/lib/x86_64-linux-gnu']) {
    try {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        try {
          const s = statSync(p);
          if (!s.isFile() || s.size < 1000 || s.size > 30e6) continue;
          const fd = openSync(p, 'r');
          const b = Buffer.alloc(4);
          readSync(fd, b, 0, 4, 0);
          closeSync(fd);
          if (b.toString('latin1') === '\x7fELF') kand.push(p);
        } catch { /* nicht lesbar */ }
      }
    } catch { /* Verzeichnis fehlt */ }
  }
  if (kand.length < 5) return t.skip('keine System-ELF gefunden');
  const schritt = Math.max(1, Math.floor(kand.length / 60));
  const probe = kand.filter((_, i) => i % schritt === 0).slice(0, 60);
  for (const p of probe) {
    const r = await lauf(p);
    assert.equal(r.status, 'ok', `${p}: ${JSON.stringify(r.warnings)}`);
    const dyn = ausgabe('readelf', ['-W', '-d', p]);
    assert.deepEqual(r.metadata.abhaengigkeiten, [...dyn.matchAll(/\(NEEDED\)\s+Shared library: \[(.+?)\]/g)].map(m => m[1]), `${p}: NEEDED`);
    const so = /\(SONAME\)\s+Library soname: \[(.+?)\]/.exec(dyn);
    assert.equal(r.metadata.soname, so ? so[1] : null, `${p}: SONAME`);
    const h = ausgabe('readelf', ['-h', p]);
    assert.equal(r.format_specific.programm_header_anzahl, Number(/Number of program headers:\s+(\d+)/.exec(h)[1]), `${p}: Programm-Header`);
    assert.equal(r.format_specific.sektions_header_anzahl, Number(/Number of section headers:\s+(\d+)/.exec(h)[1]), `${p}: Sektions-Header`);
    const bid = /Build ID: ([0-9a-f]+)/.exec(ausgabe('readelf', ['-n', p]));
    assert.equal(r.metadata.build_id ?? null, bid ? bid[1] : null, `${p}: Build-ID`);
    let imp = 0;
    let exp = 0;
    for (const zeile of ausgabe('readelf', ['-W', '--dyn-syms', p]).split('\n')) {
      const f = zeile.trim().split(/\s+/);
      if (!/^\d+:$/.test(f[0]) || f[0] === '0:') continue;
      if (f[6] === 'UND') imp++;
      else if (['GLOBAL', 'WEAK', 'UNIQUE'].includes(f[4])) exp++;
    }
    const ds = objekt(r, 'dynamische_symbole', '.dynsym');
    assert.equal(ds ? ds.data.importiert_anzahl : 0, imp, `${p}: importierte Symbole`);
    assert.equal(ds ? ds.data.exportiert_anzahl : 0, exp, `${p}: exportierte Symbole`);
  }
  assert.ok(probe.length >= 5);
});
