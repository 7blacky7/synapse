/**
 * Asset-Intel Speichern (P4-T67 Etappe A): Aufloesung target -> ziel_pfad/aufloesung (rein) und
 * Schreibweg in asset_files/asset_objects/asset_references gegen eine WEGWERF-Datenbank.
 *
 * SICHERHEIT (wie schema-sql-ausfuehren.test.mjs, scripts/lib/test-db-schutz.mjs):
 *   - Verbindung nur aus TEST_DATABASE_URL. Fehlt sie: DB-Faelle werden uebersprungen (A-Faelle laufen).
 *   - Port 5432 (auch Default) oder DB-Name 'synapse' -> Abbruch, bevor irgendeine Verbindung entsteht.
 *   - Der Test legt eine EIGENE Datenbank asset_test_<pid>_<zeit> an, arbeitet nur darin und loescht
 *     sie im after-Hook (auch bei Fehler). CREATEDB-Recht noetig.
 *
 * Faelle:
 *  A  Aufloesung (rein, ohne DB): intern, eingebettet, extern, ausserhalb, datei/fehlt, Prozent-Kodierung,
 *     Blender '//', Unreal '/Game/' + '/Script/', Bibliotheken.
 *  D1 ensureSchema legt die drei Tabellen an; CHECK auf status greift (Negativprobe).
 *  D2 ALLE Proben aus ASSET_SAMPLES_DIR inspizieren + speichern; Zeilenzahlen je Datei; Dauer gemessen.
 *  D3 Anker Box.gltf -> Verweis 'Box0.bin' aufloesung 'datei'.
 *  D4 Fixture referenzen.gltf: fehlt.png=fehlt, ../aussen.png=ausserhalb, https=extern, data:=eingebettet.
 *  D5 Idempotenz: zweimal speichern = gleiche id, gleiche Zeilenzahlen.
 *  D6 Umbenennen per sha256 (fehlende Zeile wird uebernommen, id bleibt).
 *  D7 UNLINK -> quelle_nicht_gefunden + eingehende Verweise 'fehlt'; erneutes ADD zieht zurueck.
 *  D8 Kappe 2.000 Objekte (Standard) und maxObjekte-Option.
 *  D9 NUL und einzelne Surrogate landen bereinigt statt als Fehler.
 *  D10 entferneAssetsEndgueltig (Pfade, Frist, ganzes Projekt) + CASCADE.
 *  D11 benenneAssetUm direkt; keine Verbindung bleibt 'idle in transaction'.
 *
 * AUFRUF:
 *   TEST_DATABASE_URL='postgresql://<user>:<pw>@<host>:<port != 5432>/postgres' \
 *     ASSET_TEST_DIST=<dist> node --test packages/core/tests/asset-intel-db.test.mjs
 *   (ohne ASSET_TEST_DIST gilt packages/core/dist; Proben: ASSET_SAMPLES_DIR, Standard
 *    ~/dev/synapse-testdaten/asset-samples — nur gelesen)
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
const { erzeugeFixtures3d } = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-3d.mjs')).href);
const { inspectAsset, erzeugeAssetResult } = A;
const { loesePfadAuf } = store;

const PROBEN = process.env.ASSET_SAMPLES_DIR || join(homedir(), 'dev', 'synapse-testdaten', 'asset-samples');
const relVon = (root, p) => relative(root, p).split(sep).join('/');

// ===================== A: Aufloesung (rein) =====================

test('A1 interne Arten, data:, Netz-URIs', () => {
  const kx = { assetPfad: 'db/x.sqlite' };
  assert.deepEqual(loesePfadAuf({ target: 'Artist.ArtistId', kind: 'foreign_key', resolved: true }, kx), { ziel_pfad: null, aufloesung: 'intern' });
  assert.deepEqual(loesePfadAuf({ target: 'a.usdc', kind: 'paket_inhalt' }, kx), { ziel_pfad: null, aufloesung: 'intern' });
  assert.deepEqual(loesePfadAuf({ target: 'inner.zip', kind: 'archiv_inhalt' }, kx), { ziel_pfad: null, aufloesung: 'intern' });
  assert.deepEqual(loesePfadAuf({ target: 'data:image/png;base64,AAAA', kind: 'image' }, kx), { ziel_pfad: null, aufloesung: 'eingebettet' });
  assert.deepEqual(loesePfadAuf({ target: 'https://example.org/x.png', kind: 'image' }, kx), { ziel_pfad: null, aufloesung: 'extern' });
  assert.deepEqual(loesePfadAuf({ target: 'file:///etc/x.png', kind: 'image' }, kx), { ziel_pfad: null, aufloesung: 'extern' });
  assert.deepEqual(loesePfadAuf({ target: '//cdn.example.org/x.png', kind: 'image' }, kx), { ziel_pfad: null, aufloesung: 'extern' });
});

test('A2 relative Pfade: datei/fehlt nach Inspektor-Urteil, sonst Existenzpruefung, sonst unbekannt', () => {
  const kx = { assetPfad: 'gltf/box/Box.gltf' };
  assert.deepEqual(loesePfadAuf({ target: 'Box0.bin', kind: 'buffer', resolved: true }, kx), { ziel_pfad: 'gltf/box/Box0.bin', aufloesung: 'datei' });
  assert.deepEqual(loesePfadAuf({ target: 'fehlt.png', kind: 'image', resolved: false }, kx), { ziel_pfad: 'gltf/box/fehlt.png', aufloesung: 'fehlt' });
  assert.deepEqual(loesePfadAuf({ target: './tex/a.png', kind: 'image' }, kx), { ziel_pfad: 'gltf/box/tex/a.png', aufloesung: 'unbekannt' });
  const da = new Set(['gltf/tex/b.png']);
  const kx2 = { ...kx, existiert: p => da.has(p) };
  assert.deepEqual(loesePfadAuf({ target: '../tex/b.png', kind: 'image' }, kx2), { ziel_pfad: 'gltf/tex/b.png', aufloesung: 'datei' });
  assert.deepEqual(loesePfadAuf({ target: '../tex/c.png', kind: 'image' }, kx2), { ziel_pfad: 'gltf/tex/c.png', aufloesung: 'fehlt' });
  assert.deepEqual(loesePfadAuf({ target: 'sub%20ordner/tex%20eins.png', kind: 'image', resolved: true }, kx), { ziel_pfad: 'gltf/box/sub ordner/tex eins.png', aufloesung: 'datei' });
  assert.deepEqual(loesePfadAuf({ target: 'win\\pfad\\t.png', kind: 'image' }, kx), { ziel_pfad: 'gltf/box/win/pfad/t.png', aufloesung: 'unbekannt' });
});

test('A3 ausserhalb: ../ ueber die Projektwurzel, absolute Pfade ausserhalb, Windows-Laufwerk', () => {
  const kx = { assetPfad: 'referenzen.gltf', projektRoot: '/home/x/projekt' };
  assert.deepEqual(loesePfadAuf({ target: '../aussen.png', kind: 'image', resolved: false }, kx), { ziel_pfad: null, aufloesung: 'ausserhalb' });
  assert.deepEqual(loesePfadAuf({ target: 'a/../../aussen2.png', kind: 'image', resolved: false }, kx), { ziel_pfad: null, aufloesung: 'ausserhalb' });
  assert.deepEqual(loesePfadAuf({ target: '/etc/passwd', kind: 'image', resolved: false }, kx), { ziel_pfad: null, aufloesung: 'ausserhalb' });
  assert.deepEqual(loesePfadAuf({ target: 'C:\\Users\\x\\t.png', kind: 'texture' }, kx), { ziel_pfad: null, aufloesung: 'ausserhalb' });
  // absoluter Pfad INNERHALB des Projekts wird projekt-relativ
  assert.deepEqual(loesePfadAuf({ target: '/home/x/projekt/tex/t.png', kind: 'texture', resolved: true }, kx), { ziel_pfad: 'tex/t.png', aufloesung: 'datei' });
  // ohne projektRoot ist jeder absolute Pfad ausserhalb
  assert.equal(loesePfadAuf({ target: '/home/x/projekt/tex/t.png', kind: 'texture' }, { assetPfad: 'a.gltf' }).aufloesung, 'ausserhalb');
});

test('A4 Blender //, Unreal /Game/ /Script/, Bibliotheken', () => {
  assert.deepEqual(loesePfadAuf({ target: '//tex/base.png', kind: 'texture', resolved: false }, { assetPfad: 'blend/szene.blend' }), { ziel_pfad: 'blend/tex/base.png', aufloesung: 'fehlt' });
  assert.equal(loesePfadAuf({ target: '//tex/base.png', kind: 'texture' }, { assetPfad: 'gltf/a.gltf' }).aufloesung, 'extern', 'ausserhalb von .blend ist // protokoll-relativ');
  const ue = { assetPfad: 'Spiel/Content/Chars/Held.uasset', existiert: p => p === 'Spiel/Content/Maps/Start.umap' };
  assert.deepEqual(loesePfadAuf({ target: '/Game/Chars/Waffe', kind: 'import' }, ue), { ziel_pfad: 'Spiel/Content/Chars/Waffe.uasset', aufloesung: 'fehlt' });
  assert.deepEqual(loesePfadAuf({ target: '/Game/Maps/Start', kind: 'import' }, ue), { ziel_pfad: 'Spiel/Content/Maps/Start.umap', aufloesung: 'datei' });
  assert.deepEqual(loesePfadAuf({ target: '/Script/CoreUObject', kind: 'klassenpaket' }, ue), { ziel_pfad: null, aufloesung: 'extern' });
  assert.deepEqual(loesePfadAuf({ target: '/Engine/BasicShapes/Cube', kind: 'import' }, ue), { ziel_pfad: null, aufloesung: 'extern' });
  assert.deepEqual(loesePfadAuf({ target: '/MeinPlugin/X', kind: 'import' }, ue), { ziel_pfad: null, aufloesung: 'unbekannt' });
  assert.deepEqual(loesePfadAuf({ target: '/Game/A', kind: 'import' }, { assetPfad: 'lose/x.uasset' }), { ziel_pfad: null, aufloesung: 'unbekannt' }, 'ohne Content-Ordner nicht deutbar');
  const exe = { assetPfad: 'bin/spiel.exe', existiert: p => p === 'bin/eigen.dll' };
  assert.deepEqual(loesePfadAuf({ target: 'KERNEL32.dll', kind: 'library' }, exe), { ziel_pfad: null, aufloesung: 'extern' });
  assert.deepEqual(loesePfadAuf({ target: 'eigen.dll', kind: 'library' }, exe), { ziel_pfad: 'bin/eigen.dll', aufloesung: 'datei' });
  assert.equal(loesePfadAuf({ target: 'libc.so.6', kind: 'library' }, { assetPfad: 'bin/x' }).aufloesung, 'unbekannt', 'ohne Existenzpruefung keine Aussage');
});

test('A5 normalisiereAssetPfad lehnt absolute und herausfuehrende Pfade ab', () => {
  assert.equal(store.normalisiereAssetPfad('./a\\b/../c.png'), 'a/c.png');
  assert.throws(() => store.normalisiereAssetPfad('/etc/passwd'));
  assert.throws(() => store.normalisiereAssetPfad('../x.png'));
  assert.throws(() => store.normalisiereAssetPfad('C:/x.png'));
});

// ===================== D: Wegwerf-Datenbank =====================

const bewertung = schutz.bewerteSchemaProbeDb(process.env);
if (bewertung.modus === 'abbruch') {
  console.error('asset-intel-db: ABBRUCH — ' + bewertung.grund + '. Dieser Test laeuft nie gegen die Live-DB.');
  process.exit(2);
}
const mitDb = bewertung.modus === 'ok';
const ohneDb = mitDb ? false : 'TEST_DATABASE_URL nicht gesetzt (Wegwerf-DB noetig)';

let admin = null;
let dbName = null;
let pool = null;
let closePool = async () => {};
let fx = null;
const messung = [];

const zaehle = async (tabelle, wo = 'TRUE', params = []) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${tabelle} WHERE ${wo}`, params)).rows[0].n);
const zeile = async (project, pfad) =>
  (await pool.query('SELECT * FROM asset_files WHERE project = $1 AND file_path = $2', [project, pfad])).rows[0];
const verweis = async (project, pfad, target) =>
  (await pool.query(
    `SELECT r.* FROM asset_references r JOIN asset_files a ON a.id = r.asset_id
      WHERE a.project = $1 AND a.file_path = $2 AND r.target = $3`, [project, pfad, target])).rows[0];

before(async () => {
  if (!mitDb) return;
  const { default: pg } = await import('pg');
  dbName = `asset_test_${process.pid}_${Date.now()}`;
  const url = new URL(bewertung.url);
  url.pathname = '/' + dbName;
  admin = new pg.Client({ connectionString: bewertung.url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  process.env.DATABASE_URL = url.toString();
  const client = await lade('db', 'client.js');
  closePool = client.closePool;
  pool = client.getPool();
  const dbAktuell = (await pool.query('SELECT current_database() AS n')).rows[0].n;
  assert.equal(dbAktuell, dbName, 'Pool zeigt auf die Wegwerf-DB');
  const schema = await lade('db', 'schema.js');
  await schema.ensureSchema({ versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 60000, idleTimeoutMs: 10000 });
  fx = await erzeugeFixtures3d();
});

after(async () => {
  try { await closePool(); } catch { /* egal */ }
  if (admin && dbName) {
    if (!dbName.startsWith('asset_test_')) throw new Error('Namenspraefix passt nicht');
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    console.log(`# Wegwerf-DB ${dbName} gedroppt`);
  }
  try { await admin?.end(); } catch { /* egal */ }
  try { await fx?.aufraeumen(); } catch { /* egal */ }
});

test('D1 ensureSchema legt asset_files/asset_objects/asset_references an; CHECK greift', { skip: ohneDb }, async () => {
  for (const t of ['asset_files', 'asset_objects', 'asset_references']) {
    const da = (await pool.query('SELECT to_regclass($1) IS NOT NULL AS x', [t])).rows[0].x;
    assert.equal(da, true, `Tabelle ${t} fehlt`);
  }
  const idx = (await pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE 'idx_asset_%'`)).rows[0].n;
  assert.equal(idx, 12, 'zwoelf idx_asset_*-Indizes');
  await assert.rejects(
    pool.query(`INSERT INTO asset_files (project, file_path, file_name, status) VALUES ('p', 'x', 'x', 'quatsch')`),
    e => e.code === '23514'
  );
  await assert.rejects(
    pool.query(`INSERT INTO asset_references (asset_id, project, ordnung, kind, target, aufloesung) VALUES (1, 'p', 0, 'k', 't', 'quatsch')`),
    e => e.code === '23514',
    'CHECK auf aufloesung greift vor dem Fremdschluessel'
  );
});

test('D2 alle Proben inspizieren und speichern (Zeilenzahlen je Datei, Dauer gemessen)', { skip: ohneDb || (!existsSync(PROBEN) && `ASSET_SAMPLES_DIR fehlt: ${PROBEN}`) }, async () => {
  const dateien = [];
  (function walk(d) {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else dateien.push(p);
    }
  })(PROBEN);
  assert.ok(dateien.length >= 100, `erwartet >= 100 Proben, gefunden ${dateien.length}`);
  for (const p of dateien) {
    const rel = relVon(PROBEN, p);
    const t0 = performance.now();
    const r = await inspectAsset(p);
    const tInspekt = performance.now() - t0;
    const e = await store.speichereAssetErgebnis('proben', rel, r, { projektRoot: PROBEN });
    assert.ok(Number.isInteger(e.asset_id), `${rel}: asset_id`);
    const z = await zeile('proben', rel);
    assert.equal(z.status, r.status, `${rel}: status`);
    assert.equal(Number(z.file_size), r.size, `${rel}: file_size`);
    assert.equal(z.sha256, r.sha256, `${rel}: sha256`);
    assert.equal(z.n_objects, r.objects.length, `${rel}: n_objects`);
    assert.equal(await zaehle('asset_objects', 'asset_id = $1', [e.asset_id]), Math.min(r.objects.length, 2000), `${rel}: Objektzeilen`);
    assert.equal(await zaehle('asset_references', 'asset_id = $1', [e.asset_id]), r.references.length, `${rel}: Verweiszeilen`);
    messung.push({ datei: rel, bytes: r.size, objekte: e.objekte, verweise: e.verweise, inspekt_ms: Math.round(tInspekt), speichern_ms: e.dauer_ms });
  }
  assert.equal(await zaehle('asset_files', `project = 'proben'`), dateien.length, 'eine Zeile je Probe');
  const sortiert = [...messung].sort((a, b) => a.speichern_ms - b.speichern_ms);
  const median = sortiert[Math.floor(sortiert.length / 2)].speichern_ms;
  const langsamste = sortiert[sortiert.length - 1];
  const groesste = [...messung].sort((a, b) => b.bytes - a.bytes)[0];
  const meisteObj = [...messung].sort((a, b) => b.objekte - a.objekte)[0];
  const summe = messung.reduce((s, m) => s + m.speichern_ms, 0);
  console.log(`# MESSUNG speichern: ${messung.length} Dateien, Summe ${summe} ms, Median ${median} ms, max ${langsamste.speichern_ms} ms (${langsamste.datei})`);
  console.log(`# MESSUNG groesste Probe: ${groesste.datei} ${groesste.bytes} Bytes, speichern ${groesste.speichern_ms} ms, inspizieren ${groesste.inspekt_ms} ms`);
  console.log(`# MESSUNG meiste Objekte: ${meisteObj.datei} ${meisteObj.objekte} Objekte, speichern ${meisteObj.speichern_ms} ms`);
  if (process.env.ASSET_DB_MESSUNG) writeFileSync(process.env.ASSET_DB_MESSUNG, JSON.stringify(messung, null, 1));
  assert.ok(langsamste.speichern_ms < 15000, 'jede Speicherung unter dem statement_timeout');
});

test('D3 Anker Box.gltf: Verweis Box0.bin ist aufgeloest (datei)', { skip: ohneDb || (!existsSync(join(PROBEN, 'gltf', 'box', 'Box.gltf')) && 'Probe gltf/box/Box.gltf fehlt') }, async () => {
  // Anker: beide Dateien muessen wirklich da sein, sonst waere 'datei' bedeutungslos
  assert.ok(existsSync(join(PROBEN, 'gltf', 'box', 'Box0.bin')), 'Anker: Box0.bin liegt neben Box.gltf');
  const z = await zeile('proben', 'gltf/box/Box.gltf');
  assert.ok(z, 'Box.gltf gespeichert (D2)');
  const v = await verweis('proben', 'gltf/box/Box.gltf', 'Box0.bin');
  assert.ok(v, 'Verweis Box0.bin vorhanden');
  assert.equal(v.kind, 'buffer');
  assert.equal(v.ziel_pfad, 'gltf/box/Box0.bin');
  assert.equal(v.aufloesung, 'datei');
  assert.equal(v.inspektor_resolved, true);
  // used_by-Richtung ueber den Index: wer zeigt auf Box0.bin?
  const rueck = (await pool.query(`SELECT a.file_path FROM asset_references r JOIN asset_files a ON a.id = r.asset_id
     WHERE r.project = 'proben' AND r.ziel_pfad = 'gltf/box/Box0.bin'`)).rows.map(x => x.file_path);
  assert.deepEqual(rueck, ['gltf/box/Box.gltf']);
});

test('D4 Fixture referenzen.gltf: fehlt / ausserhalb / extern / datei / eingebettet', { skip: ohneDb }, async () => {
  const pfad = fx.pfade.gltfReferenzen;
  const rel = relVon(fx.dir, pfad);
  assert.equal(rel, 'referenzen.gltf', 'Anker: Fixture liegt in der Wurzel des Fixture-Ordners');
  const r = await inspectAsset(pfad);
  // data: liefert der glTF-Inspektor nicht als Verweis (er zaehlt ihn in format_specific) -> hier dazu
  r.references.push({ target: 'data:image/png;base64,AAAA', kind: 'image' });
  await store.speichereAssetErgebnis('fx', rel, r, { projektRoot: fx.dir });
  const erwartet = {
    'textur.png': ['textur.png', 'datei'],
    'fehlt.png': ['fehlt.png', 'fehlt'],
    '../aussen.png': [null, 'ausserhalb'],
    'a/../../aussen2.png': [null, 'ausserhalb'],
    '/etc/passwd': [null, 'ausserhalb'],
    'https://example.org/x.png': [null, 'extern'],
    'sub%20ordner/tex%20eins.png': ['sub ordner/tex eins.png', 'datei'],
    'dreieck.bin': ['dreieck.bin', 'datei'],
    'data:image/png;base64,AAAA': [null, 'eingebettet'],
  };
  for (const [target, [ziel, aufl]] of Object.entries(erwartet)) {
    const v = await verweis('fx', rel, target);
    assert.ok(v, `Verweis ${target} fehlt in der DB (Anker)`);
    assert.equal(v.ziel_pfad, ziel, `${target}: ziel_pfad`);
    assert.equal(v.aufloesung, aufl, `${target}: aufloesung`);
  }
});

test('D5 Idempotenz: zweimal speichern = gleiche id und gleiche Zeilenzahlen', { skip: ohneDb || (!existsSync(join(PROBEN, 'gltf', 'box', 'Box.gltf')) && 'Probe fehlt') }, async () => {
  const p = join(PROBEN, 'gltf', 'box', 'Box.gltf');
  const vorher = [await zaehle('asset_files'), await zaehle('asset_objects'), await zaehle('asset_references')];
  const idVorher = (await zeile('proben', 'gltf/box/Box.gltf')).id;
  const r = await inspectAsset(p);
  const e1 = await store.speichereAssetErgebnis('proben', 'gltf/box/Box.gltf', r, { projektRoot: PROBEN });
  const e2 = await store.speichereAssetErgebnis('proben', 'gltf/box/Box.gltf', r, { projektRoot: PROBEN });
  const nachher = [await zaehle('asset_files'), await zaehle('asset_objects'), await zaehle('asset_references')];
  assert.equal(String(e1.asset_id), String(idVorher));
  assert.equal(e2.asset_id, e1.asset_id);
  assert.deepEqual(nachher, vorher);
  assert.ok(vorher[1] > 0 && vorher[2] > 0, 'Anker: es gibt ueberhaupt Objekte und Verweise');
});

test('D6 Umbenennen per sha256: fehlende Zeile wird uebernommen, id bleibt', { skip: ohneDb }, async () => {
  const r = await inspectAsset(fx.pfade.glbDreieck);
  assert.match(r.sha256 ?? '', /^[0-9a-f]{64}$/, 'Anker: sha256 vorhanden');
  const e1 = await store.speichereAssetErgebnis('mv', 'alt/dreieck.glb', r, { mtime: null });
  const m = await store.markiereAssetQuelleFehlt('mv', 'alt/dreieck.glb');
  assert.equal(m.asset_id, e1.asset_id);
  assert.equal(await store.findeVerschobenesAsset('mv', r.sha256), 'alt/dreieck.glb');
  const e2 = await store.speichereAssetErgebnis('mv', 'neu/dreieck.glb', r, { mtime: null });
  assert.equal(e2.umbenannt_von, 'alt/dreieck.glb');
  assert.equal(e2.asset_id, e1.asset_id, 'gleiche id');
  assert.equal(await zeile('mv', 'alt/dreieck.glb'), undefined, 'alter Pfad weg');
  const z = await zeile('mv', 'neu/dreieck.glb');
  assert.equal(z.status, r.status);
  assert.equal(z.quelle_fehlt_seit, null);
  assert.equal(z.file_name, 'dreieck.glb');
  assert.equal(await zaehle('asset_files', `project = 'mv'`), 1);
  // ohne Umbenennungs-Erkennung entsteht eine zweite Zeile
  await store.markiereAssetQuelleFehlt('mv', 'neu/dreieck.glb');
  const e3 = await store.speichereAssetErgebnis('mv', 'drittens/dreieck.glb', r, { mtime: null, erkenneUmbenennung: false });
  assert.equal(e3.umbenannt_von, null);
  assert.notEqual(e3.asset_id, e1.asset_id);
  assert.equal(await zaehle('asset_files', `project = 'mv'`), 2);
});

test('D7 UNLINK -> quelle_nicht_gefunden + eingehende Verweise fehlt; ADD zieht zurueck', { skip: ohneDb }, async () => {
  const tex = await inspectAsset(fx.pfade.textur);
  await store.speichereAssetErgebnis('fx', 'textur.png', tex, { projektRoot: fx.dir });
  const objVorher = await zaehle('asset_objects', `asset_id = (SELECT id FROM asset_files WHERE project = 'fx' AND file_path = 'textur.png')`);
  assert.equal((await verweis('fx', 'referenzen.gltf', 'textur.png')).aufloesung, 'datei', 'Anker: vorher datei (D4)');
  const m = await store.markiereAssetQuelleFehlt('fx', 'textur.png');
  assert.ok(m.asset_id !== null);
  assert.equal(m.verweise_fehlt, 1);
  const z = await zeile('fx', 'textur.png');
  assert.equal(z.status, 'quelle_nicht_gefunden');
  assert.ok(z.quelle_fehlt_seit instanceof Date);
  assert.equal(await zaehle('asset_objects', 'asset_id = $1', [z.id]), objVorher, 'Objekte bleiben lesbar');
  assert.equal((await verweis('fx', 'referenzen.gltf', 'textur.png')).aufloesung, 'fehlt');
  // zweites UNLINK verschiebt den Zeitpunkt nicht
  await store.markiereAssetQuelleFehlt('fx', 'textur.png');
  assert.equal((await zeile('fx', 'textur.png')).quelle_fehlt_seit.getTime(), z.quelle_fehlt_seit.getTime());
  // Ergebnis 'quelle_nicht_gefunden' von inspectAsset wird wie UNLINK behandelt (Objekte bleiben)
  const weg = erzeugeAssetResult('x', 0, { status: 'quelle_nicht_gefunden' });
  const ew = await store.speichereAssetErgebnis('fx', 'textur.png', weg);
  assert.equal(ew.asset_id, Number(z.id));
  assert.equal(await zaehle('asset_objects', 'asset_id = $1', [z.id]), objVorher);
  // erneutes ADD
  const e = await store.speichereAssetErgebnis('fx', 'textur.png', tex, { projektRoot: fx.dir });
  assert.equal(e.eingehend_nachgezogen, 1);
  assert.equal((await verweis('fx', 'referenzen.gltf', 'textur.png')).aufloesung, 'datei');
  const z2 = await zeile('fx', 'textur.png');
  assert.equal(z2.status, tex.status);
  assert.equal(z2.quelle_fehlt_seit, null);
  // Verweisziel ohne eigene Asset-Zeile (fehlt.png): ADD und UNLINK nachziehen
  assert.equal(await store.aktualisiereVerweisZiel('fx', 'fehlt.png', true), 1);
  assert.equal((await verweis('fx', 'referenzen.gltf', 'fehlt.png')).aufloesung, 'datei');
  assert.equal(await store.aktualisiereVerweisZiel('fx', 'fehlt.png', true), 0, 'schon datei');
  assert.equal(await store.aktualisiereVerweisZiel('fx', 'fehlt.png', false), 1);
  assert.equal((await verweis('fx', 'referenzen.gltf', 'fehlt.png')).aufloesung, 'fehlt');
  assert.equal(await store.aktualisiereVerweisZiel('fx', 'aussen.png', true), 0, 'ausserhalb wird nie angefasst');
});

test('D8 Kappe: 2.000 Objekte je Datei (Standard), maxObjekte-Option', { skip: ohneDb }, async () => {
  const objects = Array.from({ length: 2500 }, (_, i) => ({ name: `o${i}`, kind: 'mesh', data: { i }, source_range: { offset: i, length: 1 } }));
  const r = erzeugeAssetResult('viel.bin', 2500, { asset_type: 'binary', format: 'test', inspector: 'test', parser_version: 1, objects });
  const e = await store.speichereAssetErgebnis('kappe', 'viel.bin', r);
  assert.equal(e.objekte, 2000);
  assert.equal(e.gekappt, true);
  const z = await zeile('kappe', 'viel.bin');
  assert.equal(z.n_objects, 2500, 'n_objects = gelieferte Zahl');
  assert.equal(z.objekte_gekappt, true);
  assert.equal(await zaehle('asset_objects', 'asset_id = $1', [z.id]), 2000);
  const letzte = (await pool.query('SELECT max(ordnung) AS m, min(ordnung) AS n FROM asset_objects WHERE asset_id = $1', [z.id])).rows[0];
  assert.deepEqual([letzte.n, letzte.m], [0, 1999], 'die ersten 2000 in Reihenfolge');
  const e2 = await store.speichereAssetErgebnis('kappe', 'viel.bin', r, { maxObjekte: 10 });
  assert.equal(e2.objekte, 10);
  assert.equal(await zaehle('asset_objects', 'asset_id = $1', [z.id]), 10, 'alte Objekte ersetzt, nicht angehaengt');
  const klein = erzeugeAssetResult('klein.bin', 1, { objects: objects.slice(0, 3) });
  const e3 = await store.speichereAssetErgebnis('kappe', 'klein.bin', klein);
  assert.equal(e3.gekappt, false);
  assert.equal((await zeile('kappe', 'klein.bin')).objekte_gekappt, false);
});

test('D9 NUL und einzelne Surrogate werden bereinigt statt abgelehnt', { skip: ohneDb }, async () => {
  const r = erzeugeAssetResult('nul.bin', 3, {
    metadata: { ['k\u0000ey']: 'wert\u0000', big: 12345678901234567890n },
    objects: [{ name: 'a\u0000b', kind: 'chunk', data: { s: '\ud800x', paar: '\ud83d\ude00' } }],
    references: [{ target: 'x\u0000.png', kind: 'image' }],
    warnings: [{ code: 'w', message: 'm\udc00' }],
  });
  const e = await store.speichereAssetErgebnis('nul', 'nul.bin', r);
  assert.equal(e.objekte, 1);
  const o = (await pool.query('SELECT name, data FROM asset_objects WHERE asset_id = $1', [e.asset_id])).rows[0];
  assert.equal(o.name, 'a\uFFFDb');
  assert.equal(o.data.s, '\uFFFDx');
  assert.equal(o.data.paar, '\ud83d\ude00', 'gueltiges Surrogatpaar bleibt');
  const z = await zeile('nul', 'nul.bin');
  assert.equal(z.metadata['k\uFFFDey'], 'wert\uFFFD');
  assert.equal(z.metadata.big, '12345678901234567890');
  assert.equal((await verweis('nul', 'nul.bin', 'x\uFFFD.png')).aufloesung, 'unbekannt');
});

test('D10 entferneAssetsEndgueltig: Pfade, Frist 30 Tage, ganzes Projekt; CASCADE', { skip: ohneDb }, async () => {
  const r = erzeugeAssetResult('x', 1, {
    objects: [{ name: 'o', kind: 'k', data: {} }],
    references: [{ target: 'y.png', kind: 'image' }],
  });
  for (const p of ['a.bin', 'b.bin', 'c.bin', 'd.bin']) await store.speichereAssetErgebnis('weg', p, r);
  assert.equal(await store.entferneAssetsEndgueltig('weg', { pfade: ['a.bin'] }), 1);
  assert.equal(await zeile('weg', 'a.bin'), undefined);
  assert.equal(await zaehle('asset_objects', `project = 'weg'`), 3, 'CASCADE: Objekte von a.bin weg');
  assert.equal(await zaehle('asset_references', `project = 'weg'`), 3, 'CASCADE: Verweise von a.bin weg');
  await store.markiereAssetQuelleFehlt('weg', 'b.bin');
  await store.markiereAssetQuelleFehlt('weg', 'c.bin');
  await pool.query(`UPDATE asset_files SET quelle_fehlt_seit = NOW() - interval '31 days' WHERE project = 'weg' AND file_path = 'b.bin'`);
  assert.equal(await store.entferneAssetsEndgueltig('weg'), 1, 'nur der seit 31 Tagen fehlende');
  assert.equal(await zeile('weg', 'b.bin'), undefined);
  assert.ok(await zeile('weg', 'c.bin'), 'seit eben fehlend bleibt');
  assert.ok(await zeile('weg', 'd.bin'), 'vorhanden bleibt');
  assert.equal(await store.entferneAssetsEndgueltig('weg', { ganzesProjekt: true }), 2);
  assert.equal(await zaehle('asset_files', `project = 'weg'`), 0);
  assert.ok(await zaehle('asset_files', `project = 'proben'`) > 0, 'andere Projekte unberuehrt');
});

test('D11 benenneAssetUm direkt; keine Verbindung bleibt idle in transaction', { skip: ohneDb }, async () => {
  const r = erzeugeAssetResult('x', 1, {});
  await store.speichereAssetErgebnis('um', 'a/x.bin', r);
  await store.speichereAssetErgebnis('um', 'b/y.bin', r);
  const quelle = erzeugeAssetResult('z', 1, { references: [{ target: '../c/x.bin', kind: 'buffer', resolved: false }] });
  await store.speichereAssetErgebnis('um', 'q/z.gltf', quelle);
  assert.equal((await verweis('um', 'q/z.gltf', '../c/x.bin')).aufloesung, 'fehlt', 'Anker: Verweis auf c/x.bin fehlt');
  assert.equal(await store.benenneAssetUm('um', 'a/x.bin', 'b/y.bin'), false, 'Ziel belegt');
  assert.equal(await store.benenneAssetUm('um', 'gibtsnicht.bin', 'c/n.bin'), false, 'Quelle fehlt');
  assert.equal(await store.benenneAssetUm('um', 'a/x.bin', 'c/x.bin'), true);
  assert.equal((await zeile('um', 'c/x.bin')).file_name, 'x.bin');
  assert.equal((await verweis('um', 'q/z.gltf', '../c/x.bin')).aufloesung, 'datei', 'eingehender Verweis auf den neuen Pfad nachgezogen');
  const haengt = (await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`
  )).rows[0].n;
  assert.equal(haengt, 0);
});
