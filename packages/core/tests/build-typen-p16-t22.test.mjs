/**
 * P16-T22 (Testphase): Typen-Bestand aus dem Lockfile (core services/build-typen.ts) und seine Anbindung an die
 * projektweite TS-Pruefung (build-pruefung.ts): Platzierung wie node_modules (direkt je Workspace-Paket, transitiv
 * gehoben, Versionskonflikt verschachtelt), nur Typdateien, Pruefsumme, Platten-/Speicher-Cache, Wrapper (types,
 * exports-Unterpfade), Lockfile nicht im Container, Fortschritt (laeuft), Abbruch (abgebrochen + Grund, Basis bleibt),
 * Messwerte (rss_mb, speicher) in build_status. Teil C mit ECHTEM tsc + pruefer_tsbuild.py (lokal, ohne Container):
 * mit Bestand 0 Fehler, ohne Bestand TS2307.
 *
 * Nur synapse_test (5433), eigene Testprojekte, lokale Fake-Registry auf 127.0.0.1 (kein Netz). Am Ende entfernt.
 * Aufruf: node --import ./packages/core/dist/index.js packages/core/tests/build-typen-p16-t22.test.mjs
 *   (--import: bestehender Importzyklus build-pruefung -> agent-bezug -> intern-tool -> intern-waits -> file-batch)
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const ziel = new URL(process.env.DATABASE_URL ?? 'http://ungueltig');
assert.equal(ziel.port, '5433', 'DATABASE_URL muss auf die Test-Instanz 5433 zeigen');
assert.equal(ziel.pathname, '/synapse_test', 'DATABASE_URL muss synapse_test sein');

const hier = dirname(fileURLToPath(import.meta.url));
const repo = resolve(hier, '../../..');
const tmp = mkdtempSync(join(tmpdir(), 'p16t22-'));
delete process.env.BUILD_PRUEFUNG_TYPEN;
Object.assign(process.env, {
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9', BUILD_PRUEFUNG_CACHE_MS: '0', BUILD_PRUEFUNG_SPRACHEN: '',
  BUILD_PRUEFUNG_HEAP_MB: '512', BUILD_PRUEFUNG_TYPEN_CACHE: join(tmp, 'typen-cache'), PRUEFCONTAINER_TMPFS_MB: '256',
});

const dist = process.env.P16_CORE_DIST ?? resolve(hier, '../dist');
const lade = (p) => import(pathToFileURL(join(dist, p)).href);
const db = await lade('db/client.js');
const bp = await lade('services/build-pruefung.js');
const bt = await lade('services/build-typen.js');
const pool = db.getPool();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
const check = async (name, fn) => { await fn(); ok++; console.log('OK ' + name); };

// ─── Tarballs + Fake-Registry ──────────────────────────────────────────────────────────────────────────────────────────

function tarEintrag(name, inhalt) {
  const daten = Buffer.from(inhalt);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(daten.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h[156] = 48;
  h.write('ustar\0', 257);
  h.write('00', 263);
  let summe = 0;
  for (const b of h) summe += b;
  h.write(summe.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, daten, Buffer.alloc((512 - (daten.length % 512)) % 512)]);
}
const tgz = (dateien) => gzipSync(Buffer.concat([...Object.entries(dateien).map(([n, i]) => tarEintrag('package/' + n, i)), Buffer.alloc(1024)]));
const pj = (name, version, extra = {}) => JSON.stringify({ name, version, types: 'index.d.ts', ...extra });
const LIB_X = "import type { Y } from 'lib-y';\nexport declare function x(a: number): Y;\n";
const PAKETE = {
  '@types/fakenode@1.0.0': tgz({ 'package.json': pj('@types/fakenode', '1.0.0'), 'index.d.ts': "declare module 'fake:mod' { export const v: number; }\n", 'index.js': 'nicht uebernehmen()' }),
  'lib-x@1.0.0': tgz({ 'package.json': pj('lib-x', '1.0.0'), 'index.d.ts': LIB_X, 'index.js': 'exports.x = (a) => a;' }),
  'lib-x@2.0.0': tgz({ 'package.json': pj('lib-x', '2.0.0'), 'index.d.ts': LIB_X }),
  'lib-y@1.0.0': tgz({ 'package.json': pj('lib-y', '1.0.0'), 'index.d.ts': 'export type Y = number;\n' }),
  'lib-y@2.0.0': tgz({ 'package.json': pj('lib-y', '2.0.0'), 'index.d.ts': 'export type Y = string;\n' }),
  'lib-kaputt@1.0.0': tgz({ 'package.json': pj('lib-kaputt', '1.0.0'), 'index.d.ts': 'export declare const k: 1;\n' }),
};
const integrity = (k) => 'sha512-' + createHash('sha512').update(PAKETE[k]).digest('base64');
const url = (k) => { const at = k.lastIndexOf('@'); const name = k.slice(0, at); return `/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${k.slice(at + 1)}.tgz`; };
const abrufe = [];
const server = http.createServer((req, res) => {
  abrufe.push(req.url);
  const k = Object.keys(PAKETE).find((p) => url(p) === req.url);
  if (!k) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(PAKETE[k]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.BUILD_PRUEFUNG_NPM_REGISTRY = `http://127.0.0.1:${server.address().port}`;

const lockfile = (kommentar = '') => `lockfileVersion: '9.0'
${kommentar}
importers:

  .:
    devDependencies:
      '@types/fakenode':
        specifier: 1.0.0
        version: 1.0.0

  packages/a:
    dependencies:
      '@tp/b':
        specifier: workspace:*
        version: link:../b
      lib-kaputt:
        specifier: 1.0.0
        version: 1.0.0
      lib-x:
        specifier: ^1
        version: 1.0.0

  packages/b:
    dependencies:
      lib-x:
        specifier: ^2
        version: 2.0.0

packages:

  '@types/fakenode@1.0.0':
    resolution: {integrity: ${integrity('@types/fakenode@1.0.0')}}

  lib-kaputt@1.0.0:
    resolution: {integrity: sha512-${Buffer.alloc(64).toString('base64')}}

  lib-x@1.0.0:
    resolution: {integrity: ${integrity('lib-x@1.0.0')}}

  lib-x@2.0.0:
    resolution: {integrity: ${integrity('lib-x@2.0.0')}}

  lib-y@1.0.0:
    resolution: {integrity: ${integrity('lib-y@1.0.0')}}

  lib-y@2.0.0:
    resolution: {integrity: ${integrity('lib-y@2.0.0')}}

snapshots:

  '@types/fakenode@1.0.0': {}

  lib-kaputt@1.0.0: {}

  lib-x@1.0.0:
    dependencies:
      lib-y: 1.0.0

  lib-x@2.0.0:
    dependencies:
      lib-y: 2.0.0

  lib-y@1.0.0: {}

  lib-y@2.0.0: {}
`;

const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', rootDir: 'src', outDir: 'dist' }, include: ['src'] });
const A_SRC = "import { x } from 'lib-x';\nimport { v } from 'fake:mod';\nimport { b } from '@tp/b/extra';\nexport const n: number = x(v) + b;\n";
const fixture = () => ({
  'package.json': '{"name":"tp-root","private":true}',
  'pnpm-lock.yaml': lockfile(),
  'packages/a/package.json': JSON.stringify({ name: '@tp/a', type: 'module', dependencies: { 'lib-x': '^1', 'lib-kaputt': '1.0.0', '@tp/b': 'workspace:*' } }),
  'packages/a/tsconfig.json': TSCONFIG,
  'packages/a/src/index.ts': A_SRC,
  'packages/b/package.json': JSON.stringify({ name: '@tp/b', type: 'module', exports: { '.': './dist/index.js', './extra': './dist/extra.js' }, dependencies: { 'lib-x': '^2' } }),
  'packages/b/tsconfig.json': TSCONFIG,
  'packages/b/src/index.ts': "import { x } from 'lib-x';\nexport const s: string = x(1);\n",
  'packages/b/src/extra.ts': 'export const b = 2;\n',
});

const projekte = [];
async function seed(project, file, content) {
  await pool.query(`INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored,parsed_at,parser_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),1)
    ON CONFLICT(project,file_path) DO UPDATE SET content=$7,content_hash=$8,file_size=$6,deleted_at=NULL`,
  [randomUUID(), project, file, file.split('/').at(-1), file.split('.').at(-1), Buffer.byteLength(content), content, sha(content)]);
}
async function neuesProjekt(name) {
  const project = `test-p16t22-${name}-${randomUUID().slice(0, 6)}`;
  projekte.push(project);
  for (const [f, c] of Object.entries(fixture())) await seed(project, f, c);
  return project;
}
const status = async (project) => (await bp.fuehreBuildActionAus('build_status', { project }, null)).projekte[0];
async function warteBis(project, bedingung, ms = 60_000) {
  const ende = Date.now() + ms;
  for (;;) {
    const s = await status(project);
    if (bedingung(s)) return s;
    if (Date.now() > ende) throw new Error('Zeit um: ' + JSON.stringify(s).slice(0, 800));
    await sleep(100);
  }
}

// ─── Fake-Pruefcontainer ────────────────────────────────────────────────────────────────────────────────────────────────────────

const fake = {
  auftraege: [], modus: 'normal', sperre: null,
  sperren() { let release; const promise = new Promise((r) => { release = r; }); this.sperre = { promise, release }; },
  freigeben() { const s = this.sperre; this.sperre = null; s?.release(); },
  async pruefe(auftrag) {
    this.auftraege.push(auftrag);
    if (this.sperre) await this.sperre.promise;
    if (this.modus === 'gestoppt') throw new Error('Pruef-Container nicht verfuegbar: Pruef-Container gestoppt (idle > 10 min)');
    return {
      status: 'fertig', dauer_ms: 9, diagnosen: [], werkzeug: 'tsc 5.9.3 (fake)', speicher: { aktuell_mb: 50, peak_mb: 80, limit_mb: 256 },
      projekte: auftrag.projekte.map((projekt) => ({ projekt, status: 'fertig', ms: 4, rc: 0, rss_mb: 123.4 })),
    };
  },
};
const anbindungFake = { pruefe: (a) => fake.pruefe(a), setzeBudget: () => false, budget: () => ({ speicher_mb: 1536, tmpfs_mb: 256 }) };

const pyEnv = {
  ...process.env, PRUEF_TSC: join(repo, 'node_modules/typescript/lib/tsc.js'), PRUEF_LEER: join(tmp, 'leer'), PRUEF_BUILD_TMP: join(tmp, 'bau'),
  PYTHONPATH: join(repo, 'docker/synapse-pruefcontainer'), PYTHONDONTWRITEBYTECODE: '1',
};
const anbindungEchtesTsc = {
  async pruefe(auftrag) {
    const eingabe = JSON.stringify({ dateien: auftrag.dateien, projekte: auftrag.projekte, zeitlimit_s: Math.round(auftrag.zeitlimit_ms / 1000), heap_mb: auftrag.heap_mb });
    const aus = await new Promise((res, rej) => {
      const p = spawn('python3', ['-B', '-c', 'import sys,json,pruefer_tsbuild as t; print(json.dumps(t.pruefe(json.load(sys.stdin))))'], { env: pyEnv });
      let o = ''; let e = '';
      p.stdout.on('data', (d) => { o += d; });
      p.stderr.on('data', (d) => { e += d; });
      p.on('close', (rc) => (rc === 0 ? res(o) : rej(new Error(`python rc ${rc}: ${e.slice(0, 400)}`))));
      p.stdin.end(eingabe);
    });
    return JSON.parse(aus);
  },
  setzeBudget: () => false,
  budget: () => ({ speicher_mb: 1536, tmpfs_mb: 256 }),
};

try {
  // ─── A: Bestand direkt ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  let bestand;
  await check('Bestand: warten:false liefert laedt, danach fertig; Platzierung wie node_modules, nur Typdateien', async () => {
    const quellen = new Map(Object.entries(fixture()));
    assert.equal(await bt.typenBestand(quellen, { warten: false }), 'laedt');
    bestand = await bt.typenBestand(quellen, { warten: true });
    const pfade = bestand.dateien.map((d) => d.pfad).sort();
    assert.deepEqual(pfade, [
      'node_modules/@types/fakenode/index.d.ts', 'node_modules/@types/fakenode/package.json',
      'node_modules/lib-y/index.d.ts', 'node_modules/lib-y/package.json',
      'packages/a/node_modules/lib-x/index.d.ts', 'packages/a/node_modules/lib-x/package.json',
      'packages/b/node_modules/lib-x/index.d.ts', 'packages/b/node_modules/lib-x/node_modules/lib-y/index.d.ts',
      'packages/b/node_modules/lib-x/node_modules/lib-y/package.json', 'packages/b/node_modules/lib-x/package.json',
    ]);
    const inhalt = (p) => bestand.dateien.find((d) => d.pfad === p).inhalt;
    assert.match(inhalt('node_modules/lib-y/index.d.ts'), /number/, 'gehoben: lib-y@1 an der Wurzel');
    assert.match(inhalt('packages/b/node_modules/lib-x/node_modules/lib-y/index.d.ts'), /string/, 'Konflikt: lib-y@2 unter lib-x@2');
    assert.deepEqual(bestand.atTypes.get(''), ['fakenode']);
    assert.deepEqual(bestand.atTypes.get('packages/a'), []);
    assert.equal(bestand.info.pakete, 6);
    assert.equal(bestand.info.fehlend_anzahl, 1);
    assert.match(bestand.info.fehlend[0], /^lib-kaputt@1\.0\.0: Pruefsumme/);
    assert.equal(bestand.info.geladen, 5);
    assert.equal(await bt.typenBestand(quellen, { warten: false }), bestand, 'fertiger Bestand aus dem Speicher');
  });

  await check('Cache: Platte je integrity, anderes Lockfile laedt nichts erneut aus der Registry', async () => {
    assert.equal(readdirSync(process.env.BUILD_PRUEFUNG_TYPEN_CACHE).filter((f) => f.endsWith('.json')).length, 5);
    const vorher = abrufe.length;
    const q = new Map(Object.entries({ ...fixture(), 'pnpm-lock.yaml': lockfile('# geaendert') }));
    const b2 = await bt.typenBestand(q, { warten: true });
    assert.notEqual(b2.schluessel, bestand.schluessel);
    assert.equal(b2.info.geladen, 0);
    assert.equal(b2.info.aus_cache, 5);
    assert.equal(abrufe.length - vorher, 1, 'nur das kaputte Paket wird erneut angefragt');
    const z = bt.typenZustand();
    assert.equal(z.aktiv, true);
    assert.ok(z.bestaende.length >= 2);
  });

  await check('Schalter BUILD_PRUEFUNG_TYPEN=0 und ohne Lockfile', async () => {
    process.env.BUILD_PRUEFUNG_TYPEN = '0';
    assert.equal(await bt.typenBestand(new Map(Object.entries(fixture())), { warten: true }), null);
    delete process.env.BUILD_PRUEFUNG_TYPEN;
    const ohne = await bt.typenBestand(new Map([['package.json', '{}']]), { warten: true });
    assert.equal(ohne.dateien.length, 0);
    assert.equal(ohne.info.quelle, null);
    assert.match(ohne.info.hinweis, /Kein pnpm-lock\.yaml\/package-lock\.json/);
  });

  await check('package-lock.json v3: Baum aus packages, Verweise ausgelassen', async () => {
    const lock = JSON.stringify({ lockfileVersion: 3, packages: {
      '': { devDependencies: { '@types/fakenode': '1.0.0' } },
      'packages/a': { dependencies: { 'lib-x': '^1' } },
      'node_modules/@types/fakenode': { version: '1.0.0', resolved: process.env.BUILD_PRUEFUNG_NPM_REGISTRY + url('@types/fakenode@1.0.0'), integrity: integrity('@types/fakenode@1.0.0') },
      'packages/a/node_modules/lib-x': { version: '1.0.0', resolved: process.env.BUILD_PRUEFUNG_NPM_REGISTRY + url('lib-x@1.0.0'), integrity: integrity('lib-x@1.0.0') },
      'node_modules/@tp/a': { resolved: 'packages/a', link: true },
    } });
    const b = await bt.typenBestand(new Map([['package-lock.json', lock]]), { warten: true });
    assert.equal(b.info.quelle, 'package-lock.json');
    assert.equal(b.info.pakete, 2);
    assert.equal(b.info.fehlend_anzahl, 0);
    assert.ok(b.dateien.some((d) => d.pfad === 'packages/a/node_modules/lib-x/index.d.ts'));
    assert.deepEqual(b.atTypes.get(''), ['fakenode']);
  });

  // ─── B: Anbindung an die Build-Pruefung (Fake-Container) ─────────────────────────────────────────────────────────────────────────────
  bp.registriereBuildPruefer(anbindungFake);
  const pB = await neuesProjekt('fake');
  await check('Basis: Fortschritt sichtbar (laeuft), Auftrag mit Typen, Wrapper types + exports-Unterpfade, kein Lockfile', async () => {
    fake.sperren();
    const vorher = fake.auftraege.length;
    const r = await bp.pruefeBuildBasis(pB, 0);
    assert.equal(r.gestartet, true);
    // phase laeuft beginnt vor dem Budgetabgleich; der Auftrag liegt erst danach beim (Fake-)Container.
    const s = await warteBis(pB, (x) => x.laeuft?.some((f) => f.phase === 'laeuft') && fake.auftraege.length > vorher);
    assert.equal(s.zustand, 'laeuft');
    const f = s.laeuft.find((x) => x.phase === 'laeuft');
    assert.equal(f.sprache, 'typescript');
    assert.equal(f.basis, true);
    assert.equal(f.projekte, 2);
    assert.ok(typeof f.laeuft_s === 'number' && f.gestartet_am, JSON.stringify(f));
    const a = fake.auftraege.at(-1);
    const pfade = new Set(a.dateien.map((d) => d.pfad));
    assert.ok(pfade.has('packages/b/node_modules/lib-x/node_modules/lib-y/index.d.ts'));
    assert.ok(!pfade.has('pnpm-lock.yaml'), 'Lockfile nicht im Container');
    assert.ok(![...pfade].some((p) => p.endsWith('.js')), 'keine JS-Dateien');
    const wa = JSON.parse(a.dateien.find((d) => d.pfad === 'packages/a/tsconfig.synapse-build.json').inhalt);
    assert.deepEqual(wa.compilerOptions.types, ['fakenode']);
    assert.deepEqual(wa.compilerOptions.paths['@tp/b/extra'], ['@@WURZEL@@/packages/b/src/extra.ts']);
    assert.deepEqual(wa.compilerOptions.paths['@tp/b'], ['@@WURZEL@@/packages/b/src/index.ts']);
    fake.freigeben();
  });

  let basisZeit;
  await check('Basis fertig: Messwerte rss_mb je Projekt, speicher, typen in build_status', async () => {
    const s = await warteBis(pB, (x) => x.zustand !== 'laeuft');
    assert.equal(s.zustand, 'gruen', JSON.stringify(s).slice(0, 500));
    assert.equal(s.laeuft, undefined);
    assert.deepEqual(s.basis.laeufe.map((l) => l.rss_mb), [123.4, 123.4]);
    assert.deepEqual(s.basis.speicher, { aktuell_mb: 50, peak_mb: 80, limit_mb: 256 });
    assert.equal(s.basis.typen.pakete, 6);
    assert.equal(s.basis.typen.fehlend_anzahl, 1);
    basisZeit = s.basis.geprueft_am;
  });

  await check('Abbruch: Container gestoppt -> abgebrochen + Grund, Basis bleibt; warten-Antwort nennt es', async () => {
    fake.modus = 'gestoppt';
    await seed(pB, 'packages/b/src/extra.ts', 'export const b = 3;\n');
    const r = await bp.pruefeBuildBasis(pB, 20_000);
    assert.equal(r.fertig, true);
    assert.equal(r.status, 'abgebrochen');
    assert.match(r.grund, /gestoppt \(idle > 10 min\)/);
    const s = await status(pB);
    assert.equal(s.zustand, 'abgebrochen');
    assert.match(s.letzter_abbruch.grund, /gestoppt/);
    assert.equal(s.letzter_abbruch.sprache, 'TypeScript');
    assert.equal(s.basis.geprueft_am, basisZeit, 'Basis nicht ueberschrieben');
    fake.modus = 'normal';
    const r2 = await bp.pruefeBuildBasis(pB, 20_000);
    assert.equal(r2.status, 'fertig');
    assert.equal((await status(pB)).zustand, 'gruen', 'neue Basis loest den Abbruch ab');
  });

  await check('Ohne Lockfile: keine types-Einschraenkung im Wrapper (Verhalten wie vor P16-T22)', async () => {
    await pool.query('UPDATE code_files SET deleted_at = NOW() WHERE project = $1 AND file_path = $2', [pB, 'pnpm-lock.yaml']);
    await bp.pruefeBuildBasis(pB, 20_000);
    const a = fake.auftraege.at(-1);
    const wa = JSON.parse(a.dateien.find((d) => d.pfad === 'packages/a/tsconfig.synapse-build.json').inhalt);
    assert.equal(wa.compilerOptions.types, undefined);
    assert.ok(!a.dateien.some((d) => d.pfad.includes('node_modules/')));
  });

  // ─── C: echtes tsc ueber pruefer_tsbuild.py ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (!existsSync(pyEnv.PRUEF_TSC)) {
    console.log('SKIP C: kein lokales tsc unter ' + pyEnv.PRUEF_TSC);
  } else {
    for (const d of ['leer', 'bau']) (await import('node:fs')).mkdirSync(join(tmp, d), { recursive: true });
    bp.registriereBuildPruefer(anbindungEchtesTsc);
    const pC = await neuesProjekt('tsc');
    // Eigener Inhalt: sonst kaeme der (inhaltsgleiche) Fake-Lauf aus dem Ergebnis-Cache.
    await seed(pC, 'packages/a/src/index.ts', A_SRC + '// echtes tsc\n');
    await check('Echtes tsc: mit Typen-Bestand 0 Fehler (Konflikt-Versionen, @types der Wurzel, exports-Unterpfad), RSS gemessen', async () => {
      const r = await bp.pruefeBuildBasis(pC, 120_000);
      const s = await status(pC);
      assert.equal(r.status, 'fertig', JSON.stringify(r));
      assert.equal(s.basis.fehler, 0, JSON.stringify(s.basis.erste_fehler));
      assert.ok(s.basis.laeufe.every((l) => l.rss_mb > 10), JSON.stringify(s.basis.laeufe));
    });
    await check('Echtes tsc: ohne Typen-Bestand TS2307 (Gegenprobe)', async () => {
      process.env.BUILD_PRUEFUNG_TYPEN = '0';
      try {
        const r = await bp.pruefeBuildBasis(pC, 120_000);
        const s = await status(pC);
        assert.equal(r.status, 'fertig');
        assert.ok(s.basis.fehler >= 2, JSON.stringify(s.basis));
        assert.ok(s.basis.erste_fehler.some((d) => d.code === 'TS2307' && /lib-x|fake:mod/.test(d.meldung)), JSON.stringify(s.basis.erste_fehler));
      } finally {
        delete process.env.BUILD_PRUEFUNG_TYPEN;
      }
    });
  }
  console.log(`TEST_GRUEN P16-T22 build-typen checks=${ok}`);
} finally {
  bp.registriereBuildPruefer(null);
  for (const p of projekte) await pool.query('DELETE FROM code_files WHERE project = $1', [p]);
  server.close();
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
}
