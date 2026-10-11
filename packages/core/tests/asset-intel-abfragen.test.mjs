/**
 * Asset-Intel Abfragen + Dispatcher (P4-T67/T70 Etappe B1): alle Actions von asset_intel ueber
 * fuehreAssetIntelAus (die core-Endstrecke, die stdio und REST spaeter nur einhaengen) gegen eine
 * WEGWERF-Datenbank mit den echten Proben und kleinen Fixtures mit bekannter Antwort.
 *
 * SICHERHEIT (wie asset-intel-db.test.mjs, scripts/lib/test-db-schutz.mjs):
 *   - Verbindung nur aus TEST_DATABASE_URL. Fehlt sie: nur die Q0-Faelle ohne DB laufen.
 *   - Port 5432 (auch Default) oder DB-Name 'synapse' -> Abbruch, bevor eine Verbindung entsteht.
 *   - Eigene Datenbank asset_test_abfr_<pid>_<zeit>, im after-Hook geloescht (auch bei Fehler).
 *
 * Faelle:
 *  Q0  ohne DB: Definition im Budget, Filter-Grammatik (gueltig/ungueltig/Injection), Fehlertexte,
 *      unbekannte action/Parameter, Kappung rein.
 *  Q1-Q14 je Action mindestens eine Zusage mit konkreten Namen/Zahlen und Anker (Plattenstand).
 *  Q15 Injection-Versuche bleiben wirkungslos (Tabellen und Zeilenzahlen unveraendert).
 *  Q16 Kappung live: Antwort <= 60.000 Zeichen, gekappt:true, total korrekt.
 *  Q17 keine Verbindung bleibt 'idle in transaction'; statement_timeout wird zurueckgesetzt.
 *  M1  (nur mit ASSET_MESSUNG=1) 20.000 Dateien / 200.000 Objekte / 40.000 Verweise synthetisch in
 *      EIGENER Wegwerf-DB, Median aus 5 Laeufen je Action, EXPLAIN ANALYZE der Kernabfragen.
 *
 * AUFRUF:
 *   TEST_DATABASE_URL='postgresql://<user>:<pw>@<host>:<port != 5432>/postgres' \
 *     ASSET_TEST_DIST=<dist> node --test packages/core/tests/asset-intel-abfragen.test.mjs
 *   Messung zusaetzlich: ASSET_MESSUNG=1 [ASSET_MESSUNG_DATEI=/tmp/x.json]
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const lade = (...teile) => import(pathToFileURL(join(dist, ...teile)).href);
const schutz = await import(pathToFileURL(join(hier, '..', '..', '..', 'scripts', 'lib', 'test-db-schutz.mjs')).href);
const A = await lade('asset-intel', 'index.js');
const store = await lade('services', 'asset-intel-store.js');
const abfr = await lade('services', 'asset-intel-abfragen.js');
const tool = await lade('services', 'asset-intel-tool.js');
const { erzeugeFixtures3d } = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-3d.mjs')).href);
const { inspectAsset, erzeugeAssetResult } = A;
const ai = tool.fuehreAssetIntelAus;

const PROBEN = process.env.ASSET_SAMPLES_DIR || join(homedir(), 'dev', 'synapse-testdaten', 'asset-samples');
const relVon = (root, p) => relative(root, p).split(sep).join('/');
const pfade = (liste, feld = 'file_path') => liste.map(x => x[feld]);
const laenge = x => JSON.stringify(x).length;

// ===================== Q0: ohne Datenbank =====================

test('Q0a Definition: Name, 13 Actions, Budget <= 4.800 Zeichen JSON', () => {
  const d = tool.ASSET_INTEL_DEFINITION;
  assert.equal(d.name, 'asset_intel');
  assert.deepEqual([...d.inputSchema.properties.action.enum].sort(), [
    'graph', 'health', 'inspect', 'missing', 'move_preview', 'objects', 'orphans', 'references', 'roots', 'search', 'search_batch', 'tree', 'used_by',
  ]);
  const z = JSON.stringify(d).length;
  console.log(`# MESSUNG Definition asset_intel: ${z} Zeichen (~${Math.round(z / 4)} Token), ${Object.keys(d.inputSchema.properties).length} Parameter`);
  assert.ok(z <= 4800, `Definition ${z} Zeichen > 4800`);
  assert.deepEqual(d.inputSchema.required, ['action', 'project']);
});

test('Q0b Filter-Grammatik: gueltige Formen', () => {
  const f = abfr.parseAssetFilter(['image.width>=4096', 'mesh.triangles < 1e6', "material.name~'Stahl'", 'image.meta.tiefe.x=3', 'export.klasse!=Blueprint']);
  assert.deepEqual(f.map(x => [x.ziel, x.schluessel.join('.'), x.op, x.wert, x.zahl]), [
    ['image', 'width', '>=', '4096', 4096],
    ['mesh', 'triangles', '<', '1e6', 1000000],
    ['material', 'name', '~', 'Stahl', null],
    ['image', 'meta.tiefe.x', '=', '3', 3],
    ['export', 'klasse', '!=', 'Blueprint', null],
  ]);
  assert.deepEqual(abfr.parseAssetFilter('image.width>1').length, 1, 'einzelner Text erlaubt');
  assert.deepEqual(abfr.parseAssetFilter(undefined), []);
});

test('Q0c Filter-Grammatik: unzulaessige Schluessel/Werte -> filter_ungueltig (kein SQL)', () => {
  const schlecht = [
    "x'; DROP TABLE asset_files;--",
    "image.width'; DROP TABLE asset_files;-->=1",
    'image.wid th>=1',
    'image.(width)>=1',
    'image.width>=abc',
    'image.width~',
    '1image.width=1',
    'image.a.b.c.d.e=1',
    'image.width>=1' + 'x'.repeat(250),
    'image',
    '',
  ];
  for (const s of schlecht) {
    assert.throws(() => abfr.parseAssetFilter([s]), e => e.code === 'filter_ungueltig', `nicht abgelehnt: ${JSON.stringify(s)}`);
  }
  assert.throws(() => abfr.parseAssetFilter(['a.b=1', 'a.b=1', 'a.b=1', 'a.b=1', 'a.b=1', 'a.b=1']), e => e.code === 'filter_ungueltig' && /5/.test(e.message));
  assert.throws(() => abfr.parseAssetFilter({ a: 1 }), e => e.code === 'filter_ungueltig');
  // Gegenprobe: ein Wert mit SQL-Text ist GUELTIG (geht als Parameter), der Schluessel nicht
  const ok = abfr.parseAssetFilter(["image.name=x'; DROP TABLE asset_files;--"]);
  assert.equal(ok[0].wert, "x'; DROP TABLE asset_files;--");
});

test('Q0d Dispatcher ohne DB: unbekannte action/Parameter, project fehlt', async () => {
  const u = await ai({ action: 'zaubern', project: 'p' });
  assert.equal(u.success, false);
  assert.equal(u.fehler, 'unbekannte_action');
  assert.match(u.hinweis, /used_by/);
  const p = await ai({ action: 'tree', project: 'p', fiel_path: 'x' });
  assert.equal(p.fehler, 'unbekannte_parameter');
  assert.deepEqual(p.unbekannt, ['fiel_path']);
  assert.match(p.message, /meintest du "file_path"/);
  const o = await ai({ action: 'tree' });
  assert.equal(o.fehler, 'parameter_fehlt');
  assert.equal(o.beantwortet_von, 'asset_intel');
  assert.equal((await ai(null)).fehler, 'unbekannte_action');
});

test('Q0e kappeAntwort rein: <= 60.000, data auf 300 gekuerzt, Listen halbiert, total bleibt', () => {
  const objekte = Array.from({ length: 1000 }, (_, i) => ({ ordnung: i, kind: 'mesh', name: 'o' + i, data: { text: 'x'.repeat(2000), i } }));
  const a = abfr.kappeAntwort({ success: true, objekte, total: 1000, gekappt: false });
  assert.ok(laenge(a) <= 60000, `laenge ${laenge(a)}`);
  assert.equal(a.gekappt, true);
  assert.equal(a.total, 1000);
  assert.ok(a.objekte.length < 1000 && a.objekte.length > 10);
  assert.ok(a.objekte.every(o => o.data.text.length <= 300 + '…[gekuerzt]'.length && o.data.text.endsWith('…[gekuerzt]')));
  assert.equal(a.objekte[0].data.i, 0, 'kleine Werte bleiben');
  assert.match(a.antwort_gekuerzt, /halbiert/);
  const klein = { success: true, objekte: [{ data: { text: 'y'.repeat(500) } }], total: 1, gekappt: false };
  assert.equal(abfr.kappeAntwort(klein), klein, 'unter der Grenze unveraendert');
  const baum = abfr.kappeAntwort({ success: true, baum: 'z'.repeat(200000), total: 1, gekappt: false });
  assert.ok(laenge(baum) <= 60000);
  assert.match(baum.antwort_gekuerzt, /Baum abgeschnitten/);
});

// ===================== Wegwerf-Datenbank =====================

const bewertung = schutz.bewerteSchemaProbeDb(process.env);
if (bewertung.modus === 'abbruch') {
  console.error('asset-intel-abfragen: ABBRUCH — ' + bewertung.grund + '. Dieser Test laeuft nie gegen die Live-DB.');
  process.exit(2);
}
const mitDb = bewertung.modus === 'ok';
const ohneDb = mitDb ? false : 'TEST_DATABASE_URL nicht gesetzt (Wegwerf-DB noetig)';
const ohneProben = ohneDb || (!existsSync(join(PROBEN, 'gltf', 'suzanne', 'Suzanne.gltf')) && `Proben fehlen: ${PROBEN}`);

let admin = null;
let dbName = null;
let pool = null;
let closePool = async () => {};
let fx3d = null;
let probenDateien = [];

const zaehle = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);

/** Kleine Fixtures mit bekannter Antwort (Projekt 'fx'). */
async function speichereFixtures() {
  const r = (pfad, felder) => erzeugeAssetResult(pfad, 100, { status: 'ok', inspector: 'test', parser_version: 1, ...felder });
  const gltf = (refs) => r('x.gltf', { asset_type: 'model3d', format: 'gltf', references: refs });
  const png = (metadata) => r('x.png', { asset_type: 'image', format: 'png', metadata });
  const liste = [
    ['zyklus/a.gltf', gltf([{ target: 'b.gltf', kind: 'buffer', resolved: true }])],
    ['zyklus/b.gltf', gltf([{ target: 'a.gltf', kind: 'buffer', resolved: true }])],
    ['zyklus/c.gltf', gltf([{ target: 'a.gltf', kind: 'buffer', resolved: true }, { target: '../img/w4096.png', kind: 'texture', resolved: true }])],
    ['img/w4096.png', png({ width: 4096, height: 2048, kodierung: 'rgba8' })],
    ['img/w8192.png', png({ width: 8192, height: 8192 })],
    ['img/w1024.png', png({ width: 1024, height: 1024 })],
    ['img/wtext.png', png({ width: '4096' })],
    ['img/ohne.png', png({})],
    ['modell/held.glb', r('held.glb', {
      asset_type: 'model3d', format: 'glb',
      objects: [
        { name: 'gross', kind: 'mesh', data: { triangles: 5000 } },
        { name: 'klein', kind: 'mesh', data: { triangles: 200 } },
        { name: 'textzahl', kind: 'mesh', data: { triangles: '9999' } },
        { name: 'stahl', kind: 'material', data: { farbe: 'grau' } },
      ],
      references: [{ target: '../img/w1024.png', kind: 'texture', resolved: true }, { target: 'fehlt.png', kind: 'texture', resolved: false }],
    })],
  ];
  for (const [p, e] of liste) await store.speichereAssetErgebnis('fx', p, e, { mtime: null });
}

before(async () => {
  if (!mitDb) return;
  const { default: pg } = await import('pg');
  dbName = `asset_test_abfr_${process.pid}_${Date.now()}`;
  const url = new URL(bewertung.url);
  url.pathname = '/' + dbName;
  admin = new pg.Client({ connectionString: bewertung.url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  process.env.DATABASE_URL = url.toString();
  const client = await lade('db', 'client.js');
  closePool = client.closePool;
  pool = client.getPool();
  assert.equal((await pool.query('SELECT current_database() AS n')).rows[0].n, dbName, 'Pool zeigt auf die Wegwerf-DB');
  const schema = await lade('db', 'schema.js');
  await schema.ensureSchema({ versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 60000, idleTimeoutMs: 10000 });
  await speichereFixtures();
  fx3d = await erzeugeFixtures3d();
  for (const n of ['referenzen.gltf', 'textur.png']) {
    await store.speichereAssetErgebnis('fx3d', n, await inspectAsset(join(fx3d.dir, n)), { projektRoot: fx3d.dir });
  }
  if (existsSync(PROBEN)) {
    (function walk(d) {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else probenDateien.push(p);
      }
    })(PROBEN);
    for (const p of probenDateien) await store.speichereAssetErgebnis('proben', relVon(PROBEN, p), await inspectAsset(p), { projektRoot: PROBEN });
  }
});

after(async () => {
  try { await closePool(); } catch { /* egal */ }
  if (admin && dbName) {
    if (!dbName.startsWith('asset_test_')) throw new Error('Namenspraefix passt nicht');
    // DROP ... WITH (FORCE) beendet evtl. noch offene Pool-Verbindungen (57P01); das ist hier gewollt
    // und darf nach Testende nicht als uncaughtException den Lauf rot machen. Alles andere bleibt rot.
    process.on('uncaughtException', e => {
      if (e && e.code === '57P01') return;
      console.error(e);
      process.exitCode = 1;
    });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    console.log(`# Wegwerf-DB ${dbName} gedroppt`);
  }
  try { await admin?.end(); } catch { /* egal */ }
  try { await fx3d?.aufraeumen(); } catch { /* egal */ }
});

test('Q1 health: Zahl der Dateien = Proben auf der Platte, je_status summiert sich', { skip: ohneProben }, async () => {
  const h = await ai({ action: 'health', project: 'proben' });
  assert.equal(h.success, true);
  assert.equal(h.beantwortet_von, 'asset_intel');
  assert.equal(h.dateien, probenDateien.length, 'Anker: eine Zeile je Datei auf der Platte');
  assert.equal(Object.values(h.je_status).reduce((s, n) => s + n, 0), probenDateien.length);
  assert.equal(h.total, probenDateien.length);
  assert.deepEqual(h.veraltete_inspektor_version, [], 'frisch inspiziert = nichts veraltet');
  assert.ok(h.verweise_je_aufloesung.datei > 0 && h.verweise_je_aufloesung.fehlt > 0);
  // veraltet: eine Zeile kuenstlich zuruecksetzen
  await pool.query(`UPDATE asset_files SET parser_version = 0 WHERE project = 'proben' AND file_path = 'gltf/suzanne/Suzanne.gltf'`);
  const h2 = await ai({ action: 'health', project: 'proben' });
  assert.deepEqual(h2.veraltete_inspektor_version.map(v => [v.inspector, v.parser_version, v.dateien]), [['3d-gltf', 0, 1]]);
  const d = await ai({ action: 'health', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf' });
  assert.equal(d.veraltet, true);
  assert.equal(d.datei.inspector, '3d-gltf');
  await pool.query(`UPDATE asset_files SET parser_version = 1 WHERE project = 'proben' AND file_path = 'gltf/suzanne/Suzanne.gltf'`);
  const leer = await ai({ action: 'health', project: 'gibt_es_nicht' });
  assert.equal(leer.dateien, 0);
  assert.match(leer.hinweis, /lokalen Watcher/);
});

test('Q2 tree: gltf-Ordner = Dateien auf der Platte, Marker, depth/recursive/format', { skip: ohneProben }, async () => {
  const anker = probenDateien.filter(p => relVon(PROBEN, p).startsWith('gltf/')).length;
  assert.equal(anker, 16, 'Anker: 16 Dateien unter gltf/ auf der Platte');
  const t = await ai({ action: 'tree', project: 'proben', path: 'gltf' });
  assert.equal(t.total, 16);
  assert.equal(t.gekappt, false);
  assert.match(t.baum, /^gltf\/\n/);
  assert.match(t.baum, /\n    Suzanne\.gltf \[gltf · 3,6 KB · 9 Obj · 3 Verw · ok\]\n/);
  assert.match(t.baum, /\n      wooden_crate_01_diff_1k\.jpg \[jpeg · /);
  const flach = await ai({ action: 'tree', project: 'proben', path: 'gltf', recursive: false });
  assert.deepEqual(flach.baum.split('\n').filter(z => z.includes('[')).map(z => z.trim().split(' ')[0]), ['malformed_sparse.gltf']);
  const d1 = await ai({ action: 'tree', project: 'proben', path: 'gltf/', depth: 1 });
  assert.equal(d1.total, 13, 'depth 1: 16 minus die 3 Dateien in wooden_crate_01/textures/ (Tiefe 2)');
  const png = await ai({ action: 'tree', project: 'proben', path: 'gltf', format: 'png' });
  assert.equal(png.total, 3);
  const k = await ai({ action: 'tree', project: 'proben', path: 'gltf', limit: 2 });
  assert.equal(k.dateien, 2);
  assert.equal(k.gekappt, true);
  assert.equal(k.total, 16);
  const nv = await ai({ action: 'tree', project: 'proben', path: 'gltf', file_path: 'x' });
  assert.equal(nv.success, true);
  assert.deepEqual(nv.nicht_verwendet, ['file_path'], 'Parameter ohne Wirkung wird gemeldet');
});

test('Q3 inspect: Suzanne.gltf aus der DB, Paging, object_type, unbekannte Datei', { skip: ohneProben }, async () => {
  const i = await ai({ action: 'inspect', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf', limit: 3 });
  assert.equal(i.success, true);
  assert.equal(i.datei.format, 'gltf');
  assert.equal(i.datei.metadata.triangle_count, 3936);
  assert.equal(i.objekte_total, 9);
  assert.equal(i.objekte.length, 3);
  assert.equal(i.gekappt, true);
  assert.deepEqual(i.objekte.map(o => o.ordnung), [0, 1, 2]);
  assert.equal(i.verweise_total, 3);
  const s2 = await ai({ action: 'inspect', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf', offset: 3, limit: 50 });
  assert.equal(s2.objekte.length, 6);
  assert.equal(s2.objekte[0].ordnung, 3);
  assert.deepEqual(s2.verweise.map(v => v.target).sort(), ['Suzanne.bin', 'Suzanne_BaseColor.png', 'Suzanne_MetallicRoughness.png']);
  const m = await ai({ action: 'inspect', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf', object_type: 'mesh' });
  assert.ok(m.objekte.length >= 1 && m.objekte.every(o => o.kind === 'mesh'));
  assert.equal(m.objekte_total, m.objektarten.find(a => a.kind === 'mesh').n);
  const kurz = await ai({ action: 'inspect', project: 'proben', file_path: 'suzanne/Suzanne.gltf' });
  assert.equal(kurz.datei.file_path, 'gltf/suzanne/Suzanne.gltf', 'eindeutiger Endungs-Treffer');
  const mehr = await ai({ action: 'inspect', project: 'proben', file_path: 'Box.gltf' });
  assert.equal(mehr.fehler, 'pfad_mehrdeutig');
  assert.deepEqual([...mehr.kandidaten].sort(), ['gltf/box-embedded/Box.gltf', 'gltf/box/Box.gltf'], 'Reihenfolge haengt an der Collation');
  const weg = await ai({ action: 'inspect', project: 'proben', file_path: 'src/index.ts' });
  assert.equal(weg.success, false);
  assert.equal(weg.fehler, 'datei_nicht_im_asset_index');
  assert.match(weg.hinweis, /code_intel/);
  const abs = await ai({ action: 'inspect', project: 'proben', file_path: '/etc/passwd' });
  assert.equal(abs.fehler, 'pfad_ungueltig');
  const ohne = await ai({ action: 'inspect', project: 'proben' });
  assert.equal(ohne.fehler, 'parameter_fehlt');
});

test('Q4 objects: object_type Pflicht, Proben-Name, Filter mesh.triangles>1000 (Fixture)', { skip: ohneProben }, async () => {
  const f = await ai({ action: 'objects', project: 'proben' });
  assert.equal(f.fehler, 'object_type_fehlt');
  assert.match(f.hinweis, /Vorhandene Arten: .*mesh \(/);
  const anker = await zaehle(`SELECT count(*)::int AS n FROM asset_objects WHERE project = 'proben' AND kind = 'mesh'`);
  const o = await ai({ action: 'objects', project: 'proben', object_type: 'mesh', limit: 1000 });
  assert.equal(o.total, anker);
  assert.ok(anker > 0);
  const suz = await ai({ action: 'objects', project: 'proben', object_type: 'mesh', name: 'Suzanne' });
  assert.ok(pfade(suz.objekte).includes('gltf/suzanne/Suzanne.gltf'));
  const g = await ai({ action: 'objects', project: 'fx', object_type: 'mesh', where: ['mesh.triangles>1000'] });
  assert.deepEqual(g.objekte.map(x => x.name), ['gross'], 'textzahl ("9999" als Text) zaehlt nicht');
  assert.equal(g.total, 1);
  const k = await ai({ action: 'objects', project: 'fx', object_type: 'mesh', where: ['mesh.triangles<=5000'], limit: 1, offset: 1 });
  assert.deepEqual([k.total, k.objekte.length, k.objekte[0].name], [2, 1, 'klein']);
  const kreuz = await ai({ action: 'objects', project: 'fx', object_type: 'mesh', where: ['model3d.x=1'] });
  assert.equal(kreuz.total, 0, 'asset_type-Ziel auf Datei-metadata erlaubt');
  const falsch = await ai({ action: 'objects', project: 'fx', object_type: 'mesh', where: ['material.farbe=grau'] });
  assert.equal(falsch.fehler, 'filter_ungueltig');
  const nichts = await ai({ action: 'objects', project: 'fx', object_type: 'mesh', where: ['mesh.triangles>99999'] });
  assert.equal(nichts.total, 0);
  assert.match(nichts.hinweis, /mesh: haeufigste Schluessel triangles/);
  const unbek = await ai({ action: 'objects', project: 'fx', object_type: 'drache' });
  assert.match(unbek.hinweis, /Keine Objekte der Art "drache".*material/);
});

test('Q5 references: wooden_crate_01_1k.gltf -> 3 Texturen + bin, alle datei', { skip: ohneProben }, async () => {
  for (const n of ['wooden_crate_01_nor_gl_1k.jpg', 'wooden_crate_01_diff_1k.jpg', 'wooden_crate_01_arm_1k.jpg']) {
    assert.ok(existsSync(join(PROBEN, 'gltf', 'wooden_crate_01', 'textures', n)), 'Anker: Textur liegt auf der Platte');
  }
  const r = await ai({ action: 'references', project: 'proben', file_path: 'gltf/wooden_crate_01/wooden_crate_01_1k.gltf' });
  assert.equal(r.total, 4);
  assert.deepEqual(r.je_aufloesung, { datei: 4 });
  assert.deepEqual(r.verweise.map(v => v.ziel_pfad), [
    'gltf/wooden_crate_01/textures/wooden_crate_01_nor_gl_1k.jpg',
    'gltf/wooden_crate_01/textures/wooden_crate_01_diff_1k.jpg',
    'gltf/wooden_crate_01/textures/wooden_crate_01_arm_1k.jpg',
    'gltf/wooden_crate_01/wooden_crate_01.bin',
  ]);
  const t = await ai({ action: 'references', project: 'proben', file_path: 'gltf/wooden_crate_01/wooden_crate_01_1k.gltf', kind: 'buffer' });
  assert.deepEqual([t.total, t.verweise[0].target], [1, 'wooden_crate_01.bin']);
});

test('Q6 used_by: Textur -> verweisendes glTF; name_matches getrennt', { skip: ohneProben }, async () => {
  const u = await ai({ action: 'used_by', project: 'proben', file_path: 'gltf/suzanne/Suzanne_BaseColor.png' });
  assert.deepEqual(pfade(u.verweise), ['gltf/suzanne/Suzanne.gltf']);
  assert.equal(u.total, 1);
  assert.equal(u.verweise[0].kind, 'texture');
  assert.equal(u.name_matches, undefined, 'ohne include_name_matches keine name_matches');
  const n = await ai({ action: 'used_by', project: 'proben', file_path: 'gltf/wooden_crate_01/textures/wooden_crate_01_diff_1k.jpg', include_name_matches: true });
  assert.deepEqual(pfade(n.verweise), ['gltf/wooden_crate_01/wooden_crate_01_1k.gltf']);
  // Anker unabhaengig vom Code: gleiche Endung im target, anderer ziel_pfad. Die .blend-Probe liefert
  // ihren Verweis nur, wenn die Node-Version sie entpacken kann (auf Node 20 fehlt er) -> Menge aus der DB.
  const nmAnker = (await pool.query(
    `SELECT DISTINCT a.file_path FROM asset_references r JOIN asset_files a ON a.id = r.asset_id
      WHERE r.project = 'proben' AND right(r.target, 27) = 'wooden_crate_01_diff_1k.jpg'
        AND r.ziel_pfad IS DISTINCT FROM 'gltf/wooden_crate_01/textures/wooden_crate_01_diff_1k.jpg' ORDER BY 1`)).rows.map(x => x.file_path);
  assert.ok(nmAnker.includes('fbx/wooden_crate_01/wooden_crate_01_1k.fbx'), 'Anker: fbx verweist auf eine gleichnamige Textur');
  assert.deepEqual(pfade(n.name_matches).sort(), nmAnker);
  assert.equal(n.name_matches_total, nmAnker.length);
  // Fixture: used_by der Textur im 3D-Fixture
  const fx = await ai({ action: 'used_by', project: 'fx3d', file_path: 'textur.png' });
  assert.deepEqual(pfade(fx.verweise), ['referenzen.gltf']);
  // Ziel ohne eigene Asset-Zeile, aber mit eingehendem Verweis
  const ohneZeile = await ai({ action: 'used_by', project: 'fx', file_path: 'modell/fehlt.png' });
  assert.equal(ohneZeile.success, true);
  assert.equal(ohneZeile.im_asset_index, false);
  assert.deepEqual(pfade(ohneZeile.verweise), ['modell/held.glb']);
  const weg = await ai({ action: 'used_by', project: 'fx', file_path: 'gar/nichts.png' });
  assert.equal(weg.fehler, 'datei_nicht_im_asset_index');
});

test('Q7 missing: fehlt.png aus dem Fixture; projektweit = SQL-Zaehlung', { skip: ohneProben }, async () => {
  assert.equal(existsSync(join(fx3d.dir, 'fehlt.png')), false, 'Anker: fehlt.png liegt wirklich nicht da');
  const m = await ai({ action: 'missing', project: 'fx3d' });
  assert.ok(m.fehlend.some(v => v.target === 'fehlt.png' && v.file_path === 'referenzen.gltf' && v.ziel_pfad === 'fehlt.png'));
  const anker = await zaehle(`SELECT count(*)::int AS n FROM asset_references WHERE project = 'proben' AND aufloesung = 'fehlt'`);
  const p = await ai({ action: 'missing', project: 'proben' });
  assert.equal(p.total, anker);
  assert.ok(anker > 0);
  const eine = await ai({ action: 'missing', project: 'fx', file_path: 'modell/held.glb' });
  assert.deepEqual(eine.fehlend.map(v => [v.target, v.ziel_pfad]), [['fehlt.png', 'modell/fehlt.png']]);
  assert.equal(eine.ziele_total, 1);
});

test('Q8 graph: Zyklus a->b->a terminiert und wird gekennzeichnet; Proben down/up', { skip: ohneProben }, async () => {
  const t0 = Date.now();
  const g = await ai({ action: 'graph', project: 'fx', file_path: 'zyklus/a.gltf', depth: 10 });
  assert.ok(Date.now() - t0 < 5000, 'terminiert schnell');
  assert.equal(g.success, true);
  assert.deepEqual(g.knoten.map(k => k.pfad).sort(), ['zyklus/a.gltf', 'zyklus/b.gltf']);
  assert.deepEqual(g.kanten.map(k => [k.von, k.nach, k.zyklus === true]).sort(), [
    ['zyklus/a.gltf', 'zyklus/b.gltf', false],
    ['zyklus/b.gltf', 'zyklus/a.gltf', true],
  ]);
  assert.deepEqual(g.zyklen, [{ kette: ['zyklus/a.gltf', 'zyklus/b.gltf', 'zyklus/a.gltf'] }]);
  const up = await ai({ action: 'graph', project: 'fx', file_path: 'zyklus/a.gltf', direction: 'up', depth: 10 });
  assert.deepEqual(up.knoten.map(k => k.pfad).sort(), ['zyklus/a.gltf', 'zyklus/b.gltf', 'zyklus/c.gltf']);
  assert.ok(up.kanten.some(k => k.von === 'zyklus/c.gltf' && k.nach === 'zyklus/a.gltf'));
  assert.equal(up.zyklen.length, 1);
  const c = await ai({ action: 'graph', project: 'fx', file_path: 'zyklus/c.gltf', depth: 99 });
  assert.equal(c.tiefe, 10, 'Tiefe auf 10 begrenzt');
  assert.deepEqual(c.knoten.map(k => k.pfad).sort(), ['img/w4096.png', 'zyklus/a.gltf', 'zyklus/b.gltf', 'zyklus/c.gltf']);
  const d1 = await ai({ action: 'graph', project: 'fx', file_path: 'zyklus/c.gltf', depth: 1 });
  assert.deepEqual(d1.knoten.map(k => k.pfad).sort(), ['img/w4096.png', 'zyklus/a.gltf', 'zyklus/c.gltf']);
  const s = await ai({ action: 'graph', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf' });
  assert.deepEqual(s.kanten.map(k => k.nach).sort(), ['gltf/suzanne/Suzanne.bin', 'gltf/suzanne/Suzanne_BaseColor.png', 'gltf/suzanne/Suzanne_MetallicRoughness.png']);
  assert.equal(s.zyklen.length, 0);
  const su = await ai({ action: 'graph', project: 'proben', file_path: 'gltf/suzanne/Suzanne.bin', direction: 'up' });
  assert.deepEqual(su.kanten, [{ von: 'gltf/suzanne/Suzanne.gltf', nach: 'gltf/suzanne/Suzanne.bin', kind: 'buffer' }]);
  const blatt = await ai({ action: 'graph', project: 'fx', file_path: 'modell/held.glb' });
  assert.equal(blatt.knoten.find(k => k.pfad === 'modell/fehlt.png').im_index, false, 'Ziel ohne Asset-Zeile = Blatt');
  const r = await ai({ action: 'graph', project: 'fx', file_path: 'zyklus/a.gltf', direction: 'seitwaerts' });
  assert.equal(r.fehler, 'parameter_ungueltig');
});

test('Q9 roots/orphans auf dem Fixture', { skip: ohneDb }, async () => {
  const r = await ai({ action: 'roots', project: 'fx' });
  assert.deepEqual(pfade(r.dateien), ['modell/held.glb', 'zyklus/c.gltf']);
  assert.equal(r.total, 2);
  assert.match(r.hinweis, /Quellcode/);
  const o = await ai({ action: 'orphans', project: 'fx' });
  assert.deepEqual(pfade(o.dateien), ['img/ohne.png', 'img/w8192.png', 'img/wtext.png']);
  const f = await ai({ action: 'roots', project: 'fx', format: 'glb' });
  assert.deepEqual(pfade(f.dateien), ['modell/held.glb']);
});

test('Q10 Eigenschaftsfilter: image.width>=4096 und Geschwister mit bekannter Antwort', { skip: ohneDb }, async () => {
  const s = async (where, extra = {}) => pfade((await ai({ action: 'search', project: 'fx', query: extra.query ?? '', where, ...extra })).treffer);
  assert.deepEqual(await s(['image.width>=4096'], { query: 'img' }), ['img/w4096.png', 'img/w8192.png'], 'Text "4096" zaehlt nicht als Zahl');
  assert.deepEqual(await s(['image.width<4096'], { query: 'img' }), ['img/w1024.png']);
  assert.deepEqual(await s(['image.width=4096'], { query: 'img' }), ['img/w4096.png', 'img/wtext.png'], '= vergleicht Zahl ODER Text');
  assert.deepEqual(await s(['image.width!=4096'], { query: 'img' }), ['img/w1024.png', 'img/w8192.png'], 'ohne Schluessel zaehlt nicht als ungleich');
  assert.deepEqual(await s(['image.kodierung~RGB'], { query: 'img' }), ['img/w4096.png']);
  assert.deepEqual(await s(['image.width>=4096', 'image.height<4096'], { query: 'img' }), ['img/w4096.png']);
  // Kurzform in query (ohne where), mit format:
  const k = await ai({ action: 'search', project: 'fx', query: 'format:png image.width>=4096' });
  assert.deepEqual(pfade(k.treffer), ['img/w4096.png', 'img/w8192.png']);
  // Objekt-Ziel auf Dateiebene: Dateien mit einem mesh > 1000 Dreiecken
  const o = await ai({ action: 'search', project: 'fx', query: 'mesh.triangles>1000' });
  assert.deepEqual(pfade(o.treffer), ['modell/held.glb']);
  const n = await ai({ action: 'search', project: 'fx', query: 'image.width>=100000' });
  assert.equal(n.total, 0);
  assert.match(n.hinweis, /image: haeufigste Schluessel .*width/);
  const x = await ai({ action: 'search', project: 'fx', where: ['image.width;1=1'], query: 'img' });
  assert.equal(x.fehler, 'filter_ungueltig');
  assert.match(x.hinweis, /<ziel>|ziel =/);
});

test('Q11 search + search_batch auf den Proben', { skip: ohneProben }, async () => {
  const s = await ai({ action: 'search', project: 'proben', query: 'suzanne' });
  assert.equal(s.treffer[0].file_path, 'gltf/suzanne/Suzanne.gltf', 'meiste Fundstellen zuerst');
  assert.ok(s.treffer[0].fundstellen.includes('objekt|mesh: Suzanne'));
  assert.ok(pfade(s.treffer).includes('blend/Suzanne_248.blend'));
  const zwei = await ai({ action: 'search', project: 'proben', query: 'suzanne basecolor' });
  assert.deepEqual(pfade(zwei.treffer).sort(), ['gltf/suzanne/Suzanne.gltf', 'gltf/suzanne/Suzanne_BaseColor.png'], 'alle Begriffe muessen treffen');
  const b = await ai({ action: 'search_batch', project: 'proben', queries: ['crate', 'format:ktx2', 'image.width>'] });
  assert.equal(b.ergebnisse.length, 3);
  assert.ok(b.ergebnisse[0].total >= 3);
  assert.equal(b.ergebnisse[1].total, 7, 'Anker: 7 ktx2-Proben');
  assert.equal(probenDateien.filter(p => p.endsWith('.ktx2')).length, 7, 'Anker: 7 .ktx2 auf der Platte');
  assert.equal(b.ergebnisse[2].fehler, 'filter_ungueltig', 'Einzelfehler im Batch, Rest laeuft');
  const zuviel = await ai({ action: 'search_batch', project: 'proben', queries: Array(11).fill('a') });
  assert.equal(zuviel.fehler, 'parameter_ungueltig');
  const leer = await ai({ action: 'search', project: 'proben', query: '   ' });
  assert.equal(leer.fehler, 'parameter_fehlt');
});

test('Q12 move_preview: eingehend/ausgehend mit Vorschlag, repariert, Ziel belegt', { skip: ohneProben }, async () => {
  const t = await ai({ action: 'move_preview', project: 'proben', file_path: 'gltf/suzanne/Suzanne_BaseColor.png', new_path: 'tex/Suzanne_BaseColor.png' });
  assert.deepEqual(t.brechen_eingehend, [{ file_path: 'gltf/suzanne/Suzanne.gltf', kind: 'texture', target: 'Suzanne_BaseColor.png', vorschlag_target: '../../tex/Suzanne_BaseColor.png' }]);
  assert.deepEqual(t.brechen_ausgehend, []);
  assert.equal(t.ziel_belegt, false);
  const g = await ai({ action: 'move_preview', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf', new_path: 'neu/Suzanne.gltf' });
  assert.deepEqual(g.brechen_ausgehend.map(v => [v.target, v.zeigt_dann_auf, v.vorschlag_target]), [
    ['Suzanne_BaseColor.png', 'neu/Suzanne_BaseColor.png', '../gltf/suzanne/Suzanne_BaseColor.png'],
    ['Suzanne_MetallicRoughness.png', 'neu/Suzanne_MetallicRoughness.png', '../gltf/suzanne/Suzanne_MetallicRoughness.png'],
    ['Suzanne.bin', 'neu/Suzanne.bin', '../gltf/suzanne/Suzanne.bin'],
  ]);
  const gleicherOrdner = await ai({ action: 'move_preview', project: 'proben', file_path: 'gltf/suzanne/Suzanne.gltf', new_path: 'gltf/suzanne/Affe.gltf' });
  assert.deepEqual(gleicherOrdner.brechen_ausgehend, [], 'Umbenennen im selben Ordner bricht keine relativen Verweise');
  const r = await ai({ action: 'move_preview', project: 'fx3d', file_path: 'textur.png', new_path: 'fehlt.png' });
  assert.deepEqual(r.repariert_eingehend.map(v => [v.file_path, v.target]), [['referenzen.gltf', 'fehlt.png']]);
  assert.deepEqual(r.brechen_eingehend.map(v => v.vorschlag_target), ['fehlt.png']);
  const belegt = await ai({ action: 'move_preview', project: 'fx', file_path: 'img/w1024.png', new_path: 'img/w8192.png' });
  assert.deepEqual(belegt.ziel_belegt, { file_path: 'img/w8192.png', status: 'ok' });
  const vorher = await zaehle(`SELECT count(*)::int AS n FROM asset_files WHERE project = 'proben' AND file_path LIKE 'gltf/suzanne/%'`);
  assert.equal(vorher, 4, 'nur lesend: nichts verschoben');
  const ohne = await ai({ action: 'move_preview', project: 'fx', file_path: 'img/w1024.png' });
  assert.equal(ohne.fehler, 'parameter_fehlt');
});

test('Q13 Antwortformat einheitlich (success, action, project, beantwortet_von, total, gekappt)', { skip: ohneProben }, async () => {
  const aufrufe = [
    { action: 'tree' }, { action: 'inspect', file_path: 'gltf/box/Box.gltf' }, { action: 'objects', object_type: 'mesh' },
    { action: 'references', file_path: 'gltf/box/Box.gltf' }, { action: 'used_by', file_path: 'gltf/box/Box0.bin' }, { action: 'missing' },
    { action: 'graph', file_path: 'gltf/box/Box.gltf' }, { action: 'roots' }, { action: 'orphans' }, { action: 'search', query: 'box' },
    { action: 'search_batch', queries: ['box'] }, { action: 'move_preview', file_path: 'gltf/box/Box0.bin', new_path: 'b/Box0.bin' }, { action: 'health' },
  ];
  assert.equal(aufrufe.length, tool.ASSET_INTEL_ACTIONS.length, 'Anker: jede Action einmal');
  for (const a of aufrufe) {
    const r = await ai({ project: 'proben', agent_id: 'test', ...a });
    assert.equal(r.success, true, `${a.action}: ${r.message}`);
    assert.equal(r.action, a.action);
    assert.equal(r.project, 'proben');
    assert.equal(r.beantwortet_von, 'asset_intel');
    assert.ok('total' in r && 'gekappt' in r, `${a.action}: total/gekappt`);
    assert.equal(typeof r.gekappt, 'boolean');
    assert.ok(laenge(r) <= 60000);
  }
  const used = await ai({ action: 'used_by', project: 'proben', file_path: 'gltf/box/Box0.bin' });
  assert.deepEqual(pfade(used.verweise), ['gltf/box/Box.gltf'], 'Anker Etappe A: Box.gltf -> Box0.bin');
});

test('Q14 Projektname mit SQL-Text ist nur ein Parameter', { skip: ohneDb }, async () => {
  const r = await ai({ action: 'tree', project: "p'; DROP TABLE asset_files;--" });
  assert.equal(r.success, true);
  assert.equal(r.total, 0);
});

test('Q15 Injection-Versuche bleiben wirkungslos', { skip: ohneProben }, async () => {
  const vorher = [
    await zaehle('SELECT count(*)::int AS n FROM asset_files'),
    await zaehle('SELECT count(*)::int AS n FROM asset_objects'),
    await zaehle('SELECT count(*)::int AS n FROM asset_references'),
  ];
  const boese = "x'; DROP TABLE asset_files;--";
  const antworten = [
    await ai({ action: 'search', project: 'proben', query: boese }),
    await ai({ action: 'search', project: 'proben', query: 'box', where: ["image.name=" + boese] }),
    await ai({ action: 'search', project: 'proben', where: [boese], query: 'box' }),
    await ai({ action: 'objects', project: 'proben', object_type: boese }),
    await ai({ action: 'objects', project: 'proben', object_type: 'mesh', name: "%' OR '1'='1" }),
    await ai({ action: 'used_by', project: 'proben', file_path: boese }),
    await ai({ action: 'tree', project: 'proben', path: "gltf%' OR 1=1--" }),
    await ai({ action: 'graph', project: 'proben', file_path: boese }),
    await ai({ action: 'missing', project: 'proben', kind: boese }),
    await ai({ action: 'objects', project: 'proben', object_type: 'mesh', where: ["mesh.a') OR (1=1>=1"] }),
  ];
  assert.equal(antworten[0].total, 0);
  assert.equal(antworten[1].total, 0);
  assert.equal(antworten[2].fehler, 'filter_ungueltig');
  assert.equal(antworten[3].total, 0);
  assert.equal(antworten[4].total, 0, '% und _ im Namen sind maskiert');
  assert.equal(antworten[5].fehler, 'datei_nicht_im_asset_index');
  assert.equal(antworten[6].total, 0);
  assert.equal(antworten[7].fehler, 'datei_nicht_im_asset_index');
  assert.equal(antworten[8].total, 0);
  assert.equal(antworten[9].fehler, 'filter_ungueltig');
  for (const a of antworten) assert.notEqual(a.fehler, 'interner_fehler', JSON.stringify(a).slice(0, 300));
  const nachher = [
    await zaehle('SELECT count(*)::int AS n FROM asset_files'),
    await zaehle('SELECT count(*)::int AS n FROM asset_objects'),
    await zaehle('SELECT count(*)::int AS n FROM asset_references'),
  ];
  assert.deepEqual(nachher, vorher);
  // Gegenprobe: dieselben Wege liefern mit harmlosen Werten Treffer
  assert.ok((await ai({ action: 'objects', project: 'proben', object_type: 'mesh', name: 'Cube' })).total > 0);
  assert.ok((await ai({ action: 'tree', project: 'proben', path: 'gltf' })).total > 0);
});

test('Q16 Kappung live: Antwort <= 60.000, gekappt:true, total korrekt', { skip: ohneDb }, async () => {
  const objects = Array.from({ length: 2000 }, (_, i) => ({ name: 'o' + i, kind: 'mesh', data: { text: 'x'.repeat(2000), i } }));
  await store.speichereAssetErgebnis('gross', 'riesig.glb', erzeugeAssetResult('riesig.glb', 1, { asset_type: 'model3d', format: 'glb', objects }), { mtime: null });
  const o = await ai({ action: 'objects', project: 'gross', object_type: 'mesh', limit: 1000 });
  assert.equal(o.success, true);
  assert.ok(laenge(o) <= 60000, `objects ${laenge(o)}`);
  assert.equal(o.gekappt, true);
  assert.equal(o.total, 2000);
  assert.ok(o.objekte.length > 0 && o.objekte.length < 1000);
  assert.ok(o.objekte.every(x => x.data.text.length <= 311));
  assert.match(o.antwort_gekuerzt, /300 Zeichen/);
  const i = await ai({ action: 'inspect', project: 'gross', file_path: 'riesig.glb', limit: 500 });
  assert.ok(laenge(i) <= 60000);
  assert.equal(i.objekte_total, 2000);
  assert.equal(i.gekappt, true);
  // 3.000 Dateien mit langen Pfaden: Baum wird abgeschnitten
  await pool.query(
    `INSERT INTO asset_files (project, file_path, file_name, status, asset_type, format)
     SELECT 'gross2', 'ordner_' || (g % 30) || '/' || repeat('n', 180) || '_' || g || '.png', 'x.png', 'ok', 'image', 'png'
       FROM generate_series(1, 3000) g`
  );
  const t = await ai({ action: 'tree', project: 'gross2', limit: 5000 });
  assert.ok(laenge(t) <= 60000, `tree ${laenge(t)}`);
  assert.equal(t.total, 3000);
  assert.equal(t.gekappt, true);
  const s = await ai({ action: 'search', project: 'gross2', query: 'nnnn', limit: 200 });
  assert.equal(s.total, 3000);
  assert.ok(laenge(s) <= 60000);
});

test('Q17 keine Verbindung bleibt idle in transaction; statement_timeout zurueckgesetzt', { skip: ohneDb }, async () => {
  const vorher = (await pool.query('SHOW statement_timeout')).rows[0].statement_timeout;
  await Promise.all([
    ai({ action: 'health', project: 'proben' }),
    ai({ action: 'search', project: 'proben', query: 'box' }),
    ai({ action: 'graph', project: 'fx', file_path: 'zyklus/a.gltf', depth: 10 }),
  ]);
  const haengt = await zaehle(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
  assert.equal(haengt, 0);
  const c = await pool.connect();
  try {
    assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout, vorher, 'Pool-Verbindung ohne Rest-Timeout');
  } finally {
    c.release();
  }
});

test('Q18 haeufiger Begriff: search schnell, Fundstellen nur fuer Top-limit; search_batch mit Zeitlimit je Anfrage', { skip: ohneDb, timeout: 120000 }, async () => {
  // 2.000 Dateien x 50 Verweise: 'Ref_' steht in JEDEM Verweis (vor dem Fix: HAVING-Fehlschaetzung -> Seq Scan je Gruppe)
  await pool.query(
    `INSERT INTO asset_files (project, file_path, file_name, status, asset_type, format, n_references)
     SELECT 'haeufig', 'Content/O' || (i % 20) || '/Asset_' || i || '.uasset', 'Asset_' || i || '.uasset', 'ok', 'unreal', 'uasset', 50
       FROM generate_series(0, 1999) i`
  );
  await pool.query(
    `INSERT INTO asset_references (asset_id, project, ordnung, kind, target, ziel_pfad, aufloesung)
     SELECT a.id, 'haeufig', k, 'import', '/Game/O' || (k % 20) || '/Ref_' || substr(md5(a.id || '-' || k), 1, 10), NULL, 'extern'
       FROM asset_files a CROSS JOIN generate_series(0, 49) k WHERE a.project = 'haeufig'`
  );
  await pool.query('ANALYZE asset_files; ANALYZE asset_references');
  assert.equal(await zaehle(`SELECT count(*)::int AS n FROM asset_references WHERE project = 'haeufig' AND target LIKE '%Ref\\_%'`), 100000, 'Anker: Begriff steht in allen 100.000 Verweisen');
  let t0 = performance.now();
  const s = await ai({ action: 'search', project: 'haeufig', query: 'Ref_', limit: 20 });
  const dauer = performance.now() - t0;
  assert.equal(s.success, true, s.message);
  assert.equal(s.total, 2000);
  assert.equal(s.treffer.length, 20);
  assert.equal(s.gekappt, true);
  assert.ok(s.treffer.every(t => t.n_fund === 50 && t.fundstellen.length === 5 && t.fundstellen.every(f => f.startsWith('verweis|'))));
  assert.ok(dauer < 5000, `search haeufig ${Math.round(dauer)} ms`);
  console.log(`# MESSUNG Q18 search 'Ref_' (100.000 Verweise): ${Math.round(dauer)} ms`);
  // zwei Begriffe: beide muessen treffen (Pfad + Verweis)
  const zwei = await ai({ action: 'search', project: 'haeufig', query: 'Ref_ Asset_1999.' });
  assert.deepEqual(pfade(zwei.treffer), ['Content/O19/Asset_1999.uasset']);
  assert.ok(zwei.treffer[0].fundstellen.includes('pfad|Content/O19/Asset_1999.uasset'));
  assert.equal(zwei.treffer[0].n_fund, 51, '50 Verweise + 1 Pfad');
  // Batch: 3 Anfragen, davon 1 haeufig -> alle 3 Antworten
  t0 = performance.now();
  const b = await ai({ action: 'search_batch', project: 'haeufig', queries: ['Asset_7.', 'Ref_', 'gibtesnicht'] });
  assert.ok(performance.now() - t0 < 15000);
  assert.equal(b.success, true);
  assert.equal(b.ergebnisse.length, 3);
  assert.deepEqual(pfade(b.ergebnisse[0].treffer), ['Content/O7/Asset_7.uasset']);
  assert.ok(b.ergebnisse[1].zeitlimit === true ? /zu haeufig/.test(b.ergebnisse[1].hinweis) : b.ergebnisse[1].total === 2000);
  assert.equal(b.ergebnisse[2].total, 0);
  // Zeitlimit-Zweig erzwingen (1 ms): der Batch laeuft weiter, jede Anfrage liefert fuer sich
  process.env.SYNAPSE_ASSET_LESE_TIMEOUT_MS = '1';
  try {
    const z = await ai({ action: 'search_batch', project: 'haeufig', queries: ['Ref_', 'Ref_ O1', 'Asset_'] });
    assert.equal(z.success, true, z.message);
    assert.equal(z.ergebnisse.length, 3);
    const abgebrochen = z.ergebnisse.filter(e => e.zeitlimit === true);
    assert.ok(abgebrochen.length >= 1, 'Anker: mindestens eine Anfrage lief ins Zeitlimit');
    for (const e of abgebrochen) {
      assert.deepEqual(e.treffer, []);
      assert.equal(e.hinweis, 'Begriff zu haeufig: mit format/asset_type/where eingrenzen');
    }
    for (const e of z.ergebnisse.filter(e => e.zeitlimit !== true)) assert.equal(typeof e.total, 'number');
    const einzeln = await ai({ action: 'search', project: 'haeufig', query: 'Ref_' });
    assert.equal(einzeln.fehler, 'zeitlimit', 'einzelne search meldet zeitlimit als Fehler mit Hinweis');
  } finally {
    delete process.env.SYNAPSE_ASSET_LESE_TIMEOUT_MS;
  }
  const danach = await ai({ action: 'search', project: 'haeufig', query: 'Ref_', limit: 1 });
  assert.equal(danach.total, 2000, 'Timeout zurueckgesetzt');
});

// ===================== M1: Messung (nur mit ASSET_MESSUNG=1) =====================

const ohneMessung = ohneDb || (process.env.ASSET_MESSUNG !== '1' && 'nur mit ASSET_MESSUNG=1');

test('M1 Messung: 20.000 Dateien / 200.000 Objekte / 40.000 Verweise, Median aus 5 Laeufen, EXPLAIN', { skip: ohneMessung, timeout: 900000 }, async () => {
  const P = 'mess';
  const t0 = Date.now();
  await pool.query(
    `INSERT INTO asset_files (project, file_path, file_name, extension, asset_type, format, status, inspector, parser_version, file_size, metadata, n_objects, n_references)
     SELECT $1, 'Content/Ordner' || (g % 200) || '/Asset_' || g || '.' || e.ext, 'Asset_' || g || '.' || e.ext, e.ext, e.typ, e.ext,
            CASE WHEN g % 50 = 0 THEN 'nicht_erkannt' ELSE 'ok' END, e.insp, 1, 1000 + g,
            CASE e.typ WHEN 'image' THEN jsonb_build_object('width', 256 * (1 + g % 32), 'height', 128 * (1 + g % 16))
                       WHEN 'model3d' THEN jsonb_build_object('triangle_count', (g * 37) % 2000000)
                       ELSE jsonb_build_object('dauer_s', g % 600) END,
            10, 2
       FROM generate_series(1, 20000) g
       CROSS JOIN LATERAL (SELECT (ARRAY['png','glb','ogg','uasset'])[1 + g % 4] AS ext,
                                  (ARRAY['image','model3d','audio','unreal_asset'])[1 + g % 4] AS typ,
                                  (ARRAY['textur-png','3d-gltf','medien-ogg','unreal-package'])[1 + g % 4] AS insp) e`,
    [P]
  );
  await pool.query(
    `INSERT INTO asset_objects (asset_id, project, ordnung, kind, name, data, byte_offset, byte_length)
     SELECT a.id, $1, j, (ARRAY['mesh','material','export','import','texture'])[1 + j % 5], 'Obj_' || a.id || '_' || j,
            jsonb_build_object('triangles', ((a.id * 13 + j * 7919) % 100000), 'index', j), j * 100, 100
       FROM asset_files a CROSS JOIN generate_series(0, 9) j WHERE a.project = $1`,
    [P]
  );
  // 2 Verweise je Datei: auf (g*7 mod 20000)+1 und (g*13 mod 20000)+1; jeder 20. ins Leere
  await pool.query(
    `WITH n AS (SELECT id, (regexp_match(file_path, 'Asset_([0-9]+)'))[1]::int AS g FROM asset_files WHERE project = $1)
     INSERT INTO asset_references (asset_id, project, ordnung, kind, target, ziel_pfad, aufloesung)
     SELECT n.id, $1, k, CASE WHEN k = 0 THEN 'texture' ELSE 'import' END,
            CASE WHEN n.g % 20 = 0 AND k = 1 THEN 'Fehlt_' || n.g || '.png' ELSE z.pfad END,
            CASE WHEN n.g % 20 = 0 AND k = 1 THEN 'Content/Fehlt_' || n.g || '.png' ELSE z.pfad END,
            CASE WHEN n.g % 20 = 0 AND k = 1 THEN 'fehlt' ELSE 'datei' END
       FROM n CROSS JOIN generate_series(0, 1) k
       CROSS JOIN LATERAL (SELECT ((n.g * CASE k WHEN 0 THEN 7 ELSE 13 END) % 20000) + 1 AS t) zt
       CROSS JOIN LATERAL (SELECT 'Content/Ordner' || (zt.t % 200) || '/Asset_' || zt.t || '.' || (ARRAY['png','glb','ogg','uasset'])[1 + zt.t % 4] AS pfad) z`,
    [P]
  );
  await pool.query('ANALYZE asset_files; ANALYZE asset_objects; ANALYZE asset_references');
  const zahlen = [
    await zaehle(`SELECT count(*)::int AS n FROM asset_files WHERE project = 'mess'`),
    await zaehle(`SELECT count(*)::int AS n FROM asset_objects WHERE project = 'mess'`),
    await zaehle(`SELECT count(*)::int AS n FROM asset_references WHERE project = 'mess'`),
  ];
  console.log(`# MESSUNG Aufbau ${Date.now() - t0} ms: asset_files ${zahlen[0]}, asset_objects ${zahlen[1]}, asset_references ${zahlen[2]}`);
  assert.deepEqual(zahlen, [20000, 200000, 40000]);

  // SQL der Abfragen mitschneiden (fuer EXPLAIN mit denselben Parametern)
  const erfasst = [];
  const orig = pool.connect.bind(pool);
  pool.connect = async (...x) => {
    if (typeof x[0] === 'function') return orig(...x); // pool.query nutzt die Callback-Form
    const c = await orig();
    if (!c.__erfasst) {
      const q = c.query.bind(c);
      c.query = (sql, params, ...rest) => {
        if (typeof sql === 'string' && !/^\s*(SET|RESET|SHOW|EXPLAIN)\b/i.test(sql)) erfasst.push({ sql, params: Array.isArray(params) ? [...params] : params });
        return q(sql, params, ...rest);
      };
      c.__erfasst = true;
    }
    return c;
  };

  const faelle = [
    ['tree Ordner', { action: 'tree', path: 'Content/Ordner7' }],
    ['tree gesamt limit 500', { action: 'tree' }],
    ['inspect', { action: 'inspect', file_path: 'Content/Ordner1/Asset_1001.glb' }],
    ['objects mesh + Filter', { action: 'objects', object_type: 'mesh', where: ['mesh.triangles>90000'] }],
    ['references', { action: 'references', file_path: 'Content/Ordner1/Asset_1001.glb' }],
    ['used_by', { action: 'used_by', file_path: 'Content/Ordner8/Asset_7008.png' }],
    ['used_by + name_matches', { action: 'used_by', file_path: 'Content/Ordner8/Asset_7008.png', include_name_matches: true }],
    ['missing', { action: 'missing' }],
    ['graph down 3', { action: 'graph', file_path: 'Content/Ordner1/Asset_1001.glb', depth: 3 }],
    ['graph down 10', { action: 'graph', file_path: 'Content/Ordner1/Asset_1001.glb', depth: 10 }],
    ['graph up 3', { action: 'graph', file_path: 'Content/Ordner8/Asset_7008.png', direction: 'up', depth: 3 }],
    ['roots', { action: 'roots' }],
    ['orphans', { action: 'orphans' }],
    ['search Name', { action: 'search', query: 'Obj_777_3' }],
    ['search Eigenschaft', { action: 'search', query: 'image.width>=4096' }],
    ['search Objekt-Eigenschaft', { action: 'search', query: 'mesh.triangles>99990' }],
    ['search_batch 3', { action: 'search_batch', queries: ['Asset_123', 'format:glb', 'image.width>=8192'] }],
    ['move_preview', { action: 'move_preview', file_path: 'Content/Ordner8/Asset_7008.png', new_path: 'Neu/Asset_7008.png' }],
    ['health', { action: 'health' }],
  ];
  const ergebnis = [];
  for (const [name, args] of faelle) {
    const r0 = await ai({ project: P, ...args });
    assert.equal(r0.success, true, `${name}: ${r0.fehler} ${r0.message}`);
    const zeiten = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await ai({ project: P, ...args });
      zeiten.push(performance.now() - t);
    }
    zeiten.sort((a, b) => a - b);
    ergebnis.push({ fall: name, median_ms: Math.round(zeiten[2] * 10) / 10, max_ms: Math.round(zeiten[4] * 10) / 10, total: r0.total, gekappt: r0.gekappt, zeichen: laenge(r0) });
  }
  for (const e of ergebnis) console.log(`# MESSUNG ${e.fall.padEnd(28)} median ${String(e.median_ms).padStart(7)} ms  max ${String(e.max_ms).padStart(7)} ms  total ${e.total}  gekappt ${e.gekappt}  ${e.zeichen} Z`);

  // EXPLAIN der Kernabfragen (Eigenschaft, used_by, graph, Namenssuche)
  const plaene = {};
  const explain = async (name, args, auswahl) => {
    erfasst.length = 0;
    await ai({ project: P, ...args });
    const s = erfasst.find(auswahl);
    assert.ok(s, `${name}: Abfrage mitgeschnitten`);
    const r = await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ' + s.sql, s.params);
    plaene[name] = r.rows.map(x => x['QUERY PLAN']);
    console.log(`# EXPLAIN ${name}\n` + plaene[name].map(z => '#   ' + z).join('\n'));
  };
  await explain('Eigenschaft image.width>=4096', { action: 'search', query: 'image.width>=4096' }, x => /count\(\*\) OVER\(\)/.test(x.sql));
  await explain('Objekt-Eigenschaft mesh.triangles>90000', { action: 'objects', object_type: 'mesh', where: ['mesh.triangles>90000'] }, x => /^SELECT count\(\*\)::int AS n FROM asset_objects o/.test(x.sql));
  await explain('search Objekt-Eigenschaft mesh.triangles>99990', { action: 'search', query: 'mesh.triangles>99990' }, x => /count\(\*\) OVER\(\)/.test(x.sql));
  await explain('used_by', { action: 'used_by', file_path: 'Content/Ordner8/Asset_7008.png' }, x => /r\.ziel_pfad = \$2/.test(x.sql));
  await explain('graph down 10', { action: 'graph', file_path: 'Content/Ordner1/Asset_1001.glb', depth: 10 }, x => /WITH RECURSIVE/.test(x.sql));
  await explain('graph up 3', { action: 'graph', file_path: 'Content/Ordner8/Asset_7008.png', direction: 'up', depth: 3 }, x => /WITH RECURSIVE/.test(x.sql));
  await explain('Namenssuche Obj_777_3', { action: 'search', query: 'Obj_777_3' }, x => /count\(\*\) OVER\(\)/.test(x.sql));
  pool.connect = orig;
  if (process.env.ASSET_MESSUNG_DATEI) writeFileSync(process.env.ASSET_MESSUNG_DATEI, JSON.stringify({ zahlen, ergebnis, plaene }, null, 1));
  const zuLangsam = ergebnis.filter(e => e.median_ms >= 1000);
  if (zuLangsam.length > 0) console.log('# MESSUNG UEBER 1 s: ' + zuLangsam.map(e => e.fall).join(', '));
  assert.deepEqual(zuLangsam.map(e => e.fall), [], 'Grenzwert < 1 s je Action (Median)');
});
