/**
 * Asset-Intel Indexierung im lokalen Watcher (P4-T67 Etappe D).
 *
 * SICHERHEIT (wie asset-intel-db.test.mjs, scripts/lib/test-db-schutz.mjs):
 *   - Verbindung nur aus TEST_DATABASE_URL. Fehlt sie: DB-Faelle werden uebersprungen (R-Faelle laufen).
 *   - Port 5432 (auch Default) oder DB-Name 'synapse' -> Abbruch, bevor irgendeine Verbindung entsteht.
 *   - Eigene Datenbank asset_test_sync_<pid>_<zeit>, im after-Hook geloescht (auch bei Fehler).
 *   - Beobachtet werden NUR Temp-Verzeichnisse unter os.tmpdir(), nie ein echtes Projekt.
 *
 * Faelle:
 *  R1 assetArt/assetEndungen (rein): Code/Doku -> null, Media/Text-Asset -> zusaetzlich, Binaer -> nur_asset.
 *  R2 leseDateiKopf auf einer 3-GB-Sparse-Datei: gelesene Bytes gemessen (/proc/self/io rchar).
 *  D0 Gegenprobe Event-Folge VORHER/NACHHER (ASSET_TEST_DIST_VORHER): fuer Nicht-Assets identische
 *     Ereignisse ohne Feld asset; neue Ereignisse nur fuer Binaer-Assets.
 *  D1 echter Watcher + handleFileEvent(assets:true): asset_files fuer glb/bin/png/gltf/uasset, code_files
 *     fuer ts/md/gltf; keine Binaerdatei in code_files; gltf-Verweis auf e.bin = 'datei'.
 *  D2 change: glb neu inspiziert (id bleibt, sha neu); ts nur Code-Weg.
 *  D3 rename glb (id bleibt), unlink bin/png -> quelle_nicht_gefunden, eingehender Verweis 'fehlt'.
 *  D4 Abgleich nach 'Neustart': unveraendert = 0 Inspektionen; parser_version nachziehen; neu/fehlt;
 *     30-Tage-Aufraeumen; aelterer Daemon ueberschreibt keinen neueren Eintrag.
 *  D5 Haenger-Inspektor: Worker hart beendet nach timeoutMs+5 s, Ereignisschleife bleibt frei.
 *  D6 Sparse-GB-Datei ueber den echten Watcher + Abgleich: nur Kopf gelesen.
 *  D7 Binaer-Schutz in indexFile; REST-Weg (ohne assets) inspiziert nie.
 *  D8 Tabelle fehlt (42P01): EINMAL geloggt, Asset-Weg aus, Code-Weg laeuft.
 *  R3 verarbeiteAssetEreignis wirft nie (../, absolut ausserhalb, C:/), zaehlt nur.
 *  D9 Pfad ausserhalb der Wurzel mit asset:'zusaetzlich': Code-Weg in handleFileEvent laeuft trotzdem.
 *
 * AUFRUF:
 *   TEST_DATABASE_URL='postgresql://<user>:<pw>@<host>:<port != 5432>/postgres' \
 *     ASSET_TEST_DIST=<dist> [ASSET_TEST_DIST_VORHER=<dist vor dem Umbau>] \
 *     node --test packages/core/tests/asset-intel-sync.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const distVorher = process.env.ASSET_TEST_DIST_VORHER || null;
const lade = (d, ...teile) => import(pathToFileURL(join(d, ...teile)).href);
const schutz = await import(pathToFileURL(join(hier, '..', '..', '..', 'scripts', 'lib', 'test-db-schutz.mjs')).href);

// Vor jedem getConfig(): keine Embeddings, kuerzerer Debounce (gilt fuer beide Staende gleich).
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.DEBOUNCE_MS = '300';

const core = await lade(dist, 'index.js');
const codeSvc = await lade(dist, 'services', 'code.js');
const { assetArt, assetEndungen, leseDateiKopf } = core;

const tmpBasis = fs.mkdtempSync(join(os.tmpdir(), 'asset-d-sync-'));
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function warteBis(fn, ms = 20000, schritt = 100) {
  const ende = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > ende) return v;
    await warte(schritt);
  }
}
const rchar = () => {
  try {
    return Number(/rchar:\s*(\d+)/.exec(fs.readFileSync('/proc/self/io', 'utf8'))[1]);
  } catch {
    return null;
  }
};

// ---------------- Probedateien ----------------
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function glb(meshName) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ name: meshName, primitives: [] }] }));
  const j = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const kopf = Buffer.alloc(12);
  kopf.write('glTF', 0, 'ascii');
  kopf.writeUInt32LE(2, 4);
  kopf.writeUInt32LE(12 + 8 + j.length, 8);
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(j.length, 0);
  chunk.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([kopf, chunk, j]);
}
const BIN = Buffer.from([0x05, 0x00, 0xff, 0x10, 0x00, 0x7f, 0x01, 0x02, 0x00, 0x00, 0x33, 0x44]);
const UASSET = Buffer.concat([Buffer.from([0xc1, 0x83, 0x2a, 0x9e]), Buffer.alloc(96, 0)]);
const GLTF = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'e.bin', byteLength: 12 }] }, null, 2) + '\n';

function legeProjektAn(name, mitPdf = false) {
  const root = join(tmpBasis, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(join(root, 'b.md'), '# Titel\n\nText.\n');
  fs.writeFileSync(join(root, 'c.png'), PNG);
  fs.writeFileSync(join(root, 'e.bin'), BIN);
  fs.writeFileSync(join(root, 'f.glb'), glb('Wuerfel'));
  fs.writeFileSync(join(root, 'g.gltf'), GLTF);
  fs.writeFileSync(join(root, 'h.uasset'), UASSET);
  if (mitPdf) fs.writeFileSync(join(root, 'd.pdf'), '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  return root;
}

// ===================== R: rein =====================

test('R1 assetArt: Code/Doku null, Media + Text-Asset zusaetzlich, Binaer nur_asset', () => {
  const root = legeProjektAn('r1', true);
  const art = (n) => assetArt(join(root, n), leseDateiKopf(join(root, n)));
  assert.equal(art('a.ts'), null);
  assert.equal(art('b.md'), null);
  assert.equal(art('d.pdf'), null, 'Dokumente haben ihren eigenen Weg');
  assert.equal(art('c.png'), 'zusaetzlich');
  assert.equal(art('g.gltf'), 'zusaetzlich');
  assert.equal(art('e.bin'), 'nur_asset');
  assert.equal(art('f.glb'), 'nur_asset', 'glb: Nullbytes im Kopf');
  assert.equal(art('h.uasset'), 'nur_asset');
  // Binaer nur per Inhalt (keine bekannte Endung)
  fs.writeFileSync(join(root, 'ohne_endung'), BIN);
  assert.equal(art('ohne_endung'), 'nur_asset');
  // Ohne Kopf (UNLINK/REST): nur Endungen
  assert.equal(assetArt('x/y.uasset'), 'zusaetzlich', 'Registry-Endung ohne Kopf');
  assert.equal(assetArt('x/y.bin'), 'nur_asset', 'BINARY_EXTENSIONS');
  assert.equal(assetArt('x/y.ts'), null);
  assert.equal(assetArt('x/y.obj'), 'nur_asset', '.obj steht in BINARY_EXTENSIONS (Code-Weg unveraendert)');
  const e = assetEndungen();
  for (const x of ['.gltf', '.glb', '.uasset', '.png']) assert.ok(e.has(x), `Endung ${x} fehlt`);
  for (const x of ['.ts', '.js', '.json', '.md', '.xml', '.txt', '.py']) assert.ok(!e.has(x), `Code-Endung ${x} darf keine Asset-Endung sein`);
});

test('R2 leseDateiKopf auf 3-GB-Sparse-Datei liest nur den Kopf (rchar)', { skip: rchar() === null && 'kein /proc/self/io' }, () => {
  const p = join(tmpBasis, 'sparse-r2.bin');
  fs.writeFileSync(p, BIN);
  fs.truncateSync(p, 3 * 1024 ** 3);
  const r0 = rchar();
  const kopf = leseDateiKopf(p);
  const art = assetArt(p, kopf);
  const delta = rchar() - r0;
  console.log(`# R2 gelesen: ${delta} Bytes fuer eine Datei von ${3 * 1024 ** 3} Bytes`);
  assert.equal(kopf.length, 4096);
  assert.equal(art, 'nur_asset');
  assert.ok(delta < 64 * 1024, `nur Kopf erwartet, gelesen ${delta}`);
  fs.unlinkSync(p);
});

test('R3 verarbeiteAssetEreignis wirft nie (../, absolut ausserhalb, C:/) und zaehlt nur', async () => {
  const root = join(tmpBasis, 'r3');
  fs.mkdirSync(root, { recursive: true });
  const vorher = core.assetSyncZaehler().fehler;
  const pfade = ['../ausserhalb.glb', join(os.tmpdir(), 'ganz', 'woanders', 'abs.glb'), 'C:/x.glb'];
  for (const p of pfade) {
    let ergebnis;
    assert.doesNotThrow(() => {
      ergebnis = core.verarbeiteAssetEreignis({ type: 'add', path: p, project: 'asset_d_r3', asset: 'zusaetzlich' }, root);
    }, `wirft synchron bei ${p}`);
    assert.ok(ergebnis instanceof Promise, 'liefert immer ein Promise');
    await ergebnis; // darf nicht verworfen werden
  }
  assert.equal(core.assetSyncZaehler().fehler - vorher, 3, 'jeder abgelehnte Pfad wird gezaehlt');
  // Anker: ein gueltiger Pfad wird NICHT als Fehler gezaehlt (ohne asset = sofort erledigt)
  await core.verarbeiteAssetEreignis({ type: 'add', path: 'ok.ts', project: 'asset_d_r3' }, root);
  assert.equal(core.assetSyncZaehler().fehler - vorher, 3);
});

// ===================== D: Wegwerf-Datenbank =====================

const bewertung = schutz.bewerteSchemaProbeDb(process.env);
if (bewertung.modus === 'abbruch') {
  console.error('asset-intel-sync: ABBRUCH — ' + bewertung.grund + '. Dieser Test laeuft nie gegen die Live-DB.');
  process.exit(2);
}
const mitDb = bewertung.modus === 'ok';
const ohneDb = mitDb ? false : 'TEST_DATABASE_URL nicht gesetzt (Wegwerf-DB noetig)';

let admin = null;
let dbName = null;
let pool = null;
const PROJ = 'asset_d_probe';
let root = null;
let watcher = null;
const zustand = {};

const zeile = async (pfad, project = PROJ) =>
  (await pool.query('SELECT * FROM asset_files WHERE project = $1 AND file_path = $2', [project, pfad])).rows[0];
const codeZeile = async (pfad, project = PROJ) =>
  (await pool.query('SELECT file_path, content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [project, pfad])).rows[0];
const assetPfade = async (project = PROJ) =>
  (await pool.query('SELECT file_path FROM asset_files WHERE project = $1 ORDER BY 1', [project])).rows.map((r) => r.file_path);

async function starteWatcher(mod, dir, project, onFileChange) {
  let bereit;
  const fertig = new Promise((r) => (bereit = r));
  const w = mod.startFileWatcher({ projectPath: dir, projectName: project, onFileChange, onError: () => {}, onReady: () => bereit() });
  await fertig;
  return w;
}

before(async () => {
  if (!mitDb) return;
  const { default: pg } = await import('pg');
  dbName = `asset_test_sync_${process.pid}_${Date.now()}`;
  const url = new URL(bewertung.url);
  url.pathname = '/' + dbName;
  admin = new pg.Client({ connectionString: bewertung.url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  process.env.DATABASE_URL = url.toString();
  pool = core.getPool();
  const dbAktuell = (await pool.query('SELECT current_database() AS n')).rows[0].n;
  assert.equal(dbAktuell, dbName, 'Pool zeigt auf die Wegwerf-DB');
  await core.ensureSchema({ versuche: 1, wartezeitMs: 20, lockTimeoutMs: 5000, statementTimeoutMs: 60000, idleTimeoutMs: 10000 });
});

after(async () => {
  try { await watcher?.stop(); } catch { /* egal */ }
  try { await core.beendeAssetSync(); } catch { /* egal */ }
  // Hintergrund-Timer des Code-Wegs (Parse-Debounce 2 s, danach Cross-File 5 s) MUESSEN vor
  // closePool durch sein: ein spaeter Cross-File-Lauf holt sich sonst per getPool() einen neuen
  // Pool gegen die gedroppte DB und plant sich bei jedem Fehler neu -> der Prozess endet nie.
  if (mitDb) await warte(12000);
  // Der Code-Weg parst im Parser-Worker-Pool (4 Threads); ohne Abbau endet der Prozess nicht.
  try { await (await lade(dist, 'parser', 'worker-pool.js')).resetParserPool(); } catch { /* egal */ }
  try { await core.closePool(); } catch { /* egal */ }
  if (admin && dbName) {
    if (!dbName.startsWith('asset_test_sync_')) throw new Error('Namenspraefix passt nicht');
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    console.log(`# Wegwerf-DB ${dbName} gedroppt`);
  }
  try { await admin?.end(); } catch { /* egal */ }
  try { fs.rmSync(tmpBasis, { recursive: true, force: true }); } catch { /* egal */ }
  if (process.env.ASSET_TEST_DIAG) {
    setTimeout(() => {
      console.log('# DIAG handles: ' + process._getActiveHandles().map((h) => h?.constructor?.name + (h?.remotePort ? `(:${h.remotePort})` : '') + (typeof h?.fd === 'number' ? `(fd${h.fd})` : '') + (h?.hasRef?.() === false ? '(unref)' : '')).join(', '));
      console.log('# DIAG ressourcen: ' + process.getActiveResourcesInfo().join(', '));
      console.log('# DIAG requests: ' + process._getActiveRequests().map((r) => r?.constructor?.name).join(', '));
    }, 3000).unref();
  }
});

// ---- D0: Gegenprobe der Event-Folge vorher/nachher ----

async function sammleEreignisse(mod, name) {
  const dir = legeProjektAn(name, true);
  const ereignisse = [];
  const w = await starteWatcher(mod, dir, 'asset_d_ev', (e) => { ereignisse.push({ ...e }); });
  await warte(1200);
  fs.appendFileSync(join(dir, 'a.ts'), 'export const b = 2;\n');
  fs.writeFileSync(join(dir, 'c.png'), Buffer.concat([PNG, Buffer.from([0])]));
  fs.writeFileSync(join(dir, 'f.glb'), glb('Kugel'));
  await warte(1200);
  fs.unlinkSync(join(dir, 'b.md'));
  fs.unlinkSync(join(dir, 'e.bin'));
  fs.unlinkSync(join(dir, 'c.png'));
  await warte(3000);
  await w.stop();
  const sortiert = ereignisse.map((e) => JSON.stringify(e)).sort();
  return sortiert.map((s) => JSON.parse(s));
}

test('D0 Gegenprobe: Ereignisse fuer Nicht-Assets VORHER == NACHHER (ohne Feld asset)', { skip: ohneDb || (!distVorher && 'ASSET_TEST_DIST_VORHER fehlt') }, async () => {
  const vorherMod = await lade(distVorher, 'index.js');
  const vorher = await sammleEreignisse(vorherMod, 'ev-vorher');
  try { await vorherMod.closePool(); } catch { /* egal */ }
  const nachher = await sammleEreignisse(core, 'ev-nachher');
  console.log(`# D0 vorher ${vorher.length} Ereignisse, nachher ${nachher.length}`);
  // Anker: die Gegenprobe ist nur etwas wert, wenn vorher ueberhaupt Code-Ereignisse kamen.
  assert.ok(vorher.some((e) => e.path === 'a.ts' && e.type === 'change'), 'Anker: change a.ts vorher gesehen');
  assert.ok(vorher.some((e) => e.path === 'd.pdf' && e.type === 'add'), 'Anker: add d.pdf vorher gesehen');
  for (const e of vorher) assert.ok(!('asset' in e), 'vorher kennt kein Feld asset');
  // Nicht-Assets: identisch, OHNE Feld asset
  const nichtAsset = (e) => ['a.ts', 'b.md', 'd.pdf'].includes(e.path);
  assert.deepEqual(nachher.filter(nichtAsset), vorher.filter(nichtAsset));
  for (const e of nachher.filter(nichtAsset)) assert.ok(!('asset' in e), `Feld asset an Code-Ereignis ${e.type} ${e.path}`);
  // 'zusaetzlich' (png add/change, gltf): dieselben Ereignisse wie vorher, nur mit asset markiert
  const ohneAsset = ({ asset, ...rest }) => rest;
  const zusaetzlich = nachher.filter((e) => e.asset === 'zusaetzlich');
  assert.deepEqual(zusaetzlich.map(ohneAsset), vorher.filter((e) => ['c.png', 'g.gltf'].includes(e.path) && e.type !== 'unlink'));
  // neu: nur Binaer-Assets bzw. Unlinks ohne Code-Zeile (vorher verworfen)
  const neu = nachher.filter((e) => e.asset === 'nur_asset');
  assert.ok(neu.length > 0);
  for (const e of neu) assert.ok(['e.bin', 'f.glb', 'h.uasset', 'c.png'].includes(e.path), `unerwartet nur_asset: ${e.path}`);
  assert.equal(vorher.filter((e) => ['e.bin', 'f.glb', 'h.uasset'].includes(e.path)).length, 0, 'vorher erreichten Binaerdateien keinen Konsumenten');
});

// ---- D1-D3: echter Watcher mit Konsument ----

test('D1 Erstscan: asset_files fuer Assets, code_files nur fuer Text; gltf-Verweis datei', { skip: ohneDb }, async () => {
  root = legeProjektAn('d1');
  await core.registerProject(PROJ, root);
  watcher = await starteWatcher(core, root, PROJ, (e) => codeSvc.handleFileEvent(e, root, { assets: true }));
  const pfade = await warteBis(async () => {
    await core.warteAufAssetLeerlauf();
    const p = await assetPfade();
    return p.length >= 5 && (await codeZeile('g.gltf')) && (await codeZeile('a.ts')) ? p : null;
  });
  assert.deepEqual(pfade, ['c.png', 'e.bin', 'f.glb', 'g.gltf', 'h.uasset']);
  // Code-Index: Anker zuerst (Zeile existiert), dann die Abwesenheiten.
  assert.ok(await codeZeile('a.ts'), 'Anker: a.ts im Code-Index');
  assert.ok(await codeZeile('b.md'), 'Anker: b.md im Code-Index');
  assert.ok(await codeZeile('g.gltf'), "'zusaetzlich': gltf bleibt im Code-Index");
  for (const p of ['c.png', 'e.bin', 'f.glb', 'h.uasset']) assert.equal(await codeZeile(p), undefined, `${p} darf nicht in code_files`);
  const binInCode = (await pool.query(
    `SELECT count(*)::int AS n FROM code_files WHERE project = $1 AND file_path ~ '[.](bin|glb|uasset|png)$'`, [PROJ])).rows[0].n;
  assert.equal(binInCode, 0);
  const f = await zeile('f.glb');
  assert.equal(f.inspector, '3d-glb');
  assert.equal(f.status, 'ok');
  assert.equal((await zeile('c.png')).inspector, 'textur-png');
  assert.equal((await zeile('g.gltf')).inspector, '3d-gltf');
  assert.equal((await zeile('h.uasset')).inspector, 'unreal-package');
  assert.equal((await zeile('e.bin')).status, 'nicht_erkannt');
  const ref = (await pool.query(
    `SELECT r.aufloesung, r.ziel_pfad FROM asset_references r JOIN asset_files a ON a.id = r.asset_id
      WHERE a.project = $1 AND a.file_path = 'g.gltf' AND r.target = 'e.bin'`, [PROJ])).rows[0];
  assert.deepEqual(ref, { aufloesung: 'datei', ziel_pfad: 'e.bin' });
  zustand.fId = f.id;
  zustand.fSha = f.sha256;
});

test('D2 change: glb neu inspiziert (id bleibt, sha neu); ts nur im Code-Weg', { skip: ohneDb }, async () => {
  fs.writeFileSync(join(root, 'f.glb'), glb('Kugel'));
  fs.appendFileSync(join(root, 'a.ts'), 'export const marke_d2 = 2;\n');
  const f = await warteBis(async () => {
    const z = await zeile('f.glb');
    return z && z.sha256 !== zustand.fSha ? z : null;
  });
  assert.ok(f, 'glb neu inspiziert');
  assert.equal(f.id, zustand.fId, 'id bleibt');
  const a = await warteBis(async () => {
    const z = await codeZeile('a.ts');
    return z && z.content.includes('marke_d2') ? z : null;
  });
  assert.ok(a, 'a.ts im Code-Index aktualisiert');
  assert.equal(await zeile('a.ts'), undefined, 'a.ts nie in asset_files');
  zustand.fSha = f.sha256;
});

test('D3 rename glb (id bleibt), unlink bin/png -> quelle_nicht_gefunden, Verweis fehlt', { skip: ohneDb }, async () => {
  fs.mkdirSync(join(root, 'sub'));
  fs.renameSync(join(root, 'f.glb'), join(root, 'sub', 'f2.glb'));
  fs.unlinkSync(join(root, 'e.bin'));
  fs.unlinkSync(join(root, 'c.png'));
  const ok = await warteBis(async () => {
    const n = await zeile('sub/f2.glb');
    const e = await zeile('e.bin');
    const c = await zeile('c.png');
    return n && !(await zeile('f.glb')) && e?.status === 'quelle_nicht_gefunden' && c?.status === 'quelle_nicht_gefunden';
  });
  assert.ok(ok, 'Zustand nach rename/unlink erreicht');
  await core.warteAufAssetLeerlauf();
  const n = await zeile('sub/f2.glb');
  assert.equal(n.id, zustand.fId, 'Umbenennung per sha256: id bleibt');
  assert.equal(n.sha256, zustand.fSha);
  assert.equal(await zeile('f.glb'), undefined);
  assert.ok((await zeile('e.bin')).quelle_fehlt_seit, 'quelle_fehlt_seit gesetzt');
  const ref = (await pool.query(
    `SELECT r.aufloesung FROM asset_references r JOIN asset_files a ON a.id = r.asset_id
      WHERE a.project = $1 AND a.file_path = 'g.gltf' AND r.target = 'e.bin'`, [PROJ])).rows[0];
  assert.equal(ref.aufloesung, 'fehlt', 'eingehender Verweis auf die geloeschte .bin');
  await watcher.stop();
  watcher = null;
});

// ---- D4: Abgleich nach Neustart ----

test('D4 Abgleich nach Neustart: unveraendert ohne Inspektion; nachziehen, neu, fehlt, 30 Tage, aelterer Stand', { skip: ohneDb }, async () => {
  await core.warteAufAssetLeerlauf();
  core.setzeAssetSyncZaehlerZurueck();
  const e1 = await core.verifyAssetsAgainstFilesystem(PROJ, root);
  console.log(`# D4 Lauf 1: ${JSON.stringify(e1)} Zaehler ${JSON.stringify(core.assetSyncZaehler())}`);
  assert.equal(e1.kandidaten, 3, 'Anker: sub/f2.glb, g.gltf, h.uasset liegen auf der Platte');
  assert.equal(e1.unveraendert, 3);
  assert.equal(e1.neu + e1.geaendert + e1.nachgezogen, 0);
  assert.equal(core.assetSyncZaehler().inspektionen, 0, 'unveraenderte Dateien werden NICHT neu inspiziert');

  // veraltete parser_version, neue Datei, fehlende Quelle
  await pool.query(`UPDATE asset_files SET parser_version = 0 WHERE project = $1 AND file_path = 'h.uasset'`, [PROJ]);
  fs.writeFileSync(join(root, 'i.glb'), glb('Neu'));
  fs.unlinkSync(join(root, 'g.gltf'));
  core.setzeAssetSyncZaehlerZurueck();
  const e2 = await core.verifyAssetsAgainstFilesystem(PROJ, root);
  console.log(`# D4 Lauf 2: ${JSON.stringify(e2)} Zaehler ${JSON.stringify(core.assetSyncZaehler())}`);
  assert.equal(e2.nachgezogen, 1);
  assert.equal(e2.neu, 1);
  assert.equal(e2.fehlt, 1);
  assert.equal(core.assetSyncZaehler().inspektionen, 2);
  const uv = core.standardRegistry.get('unreal-package').version;
  assert.equal((await zeile('h.uasset')).parser_version, uv, 'parser_version nachgezogen');
  assert.equal((await zeile('i.glb')).status, 'ok');
  assert.equal((await zeile('g.gltf')).status, 'quelle_nicht_gefunden');

  // 30-Tage-Frist
  await pool.query(`UPDATE asset_files SET quelle_fehlt_seit = NOW() - INTERVAL '31 days' WHERE project = $1 AND file_path = 'e.bin'`, [PROJ]);
  const e3 = await core.verifyAssetsAgainstFilesystem(PROJ, root);
  assert.equal(e3.aufgeraeumt, 1);
  assert.equal(await zeile('e.bin'), undefined, 'nach 31 Tagen endgueltig entfernt');
  assert.ok(await zeile('c.png'), 'junge fehlende Quelle bleibt');

  // aelterer Daemon: Eintrag mit hoeherer Version wird nicht ueberschrieben
  await pool.query(`UPDATE asset_files SET parser_version = 99 WHERE project = $1 AND file_path = 'h.uasset'`, [PROJ]);
  core.setzeAssetSyncZaehlerZurueck();
  const e4 = await core.verifyAssetsAgainstFilesystem(PROJ, root);
  assert.equal(e4.aelter_als_eintrag, 1);
  assert.equal(core.assetSyncZaehler().inspektionen, 0);
  assert.equal((await zeile('h.uasset')).parser_version, 99);
});

// ---- D5: Haenger ----

test('D5 Haenger-Inspektor: Worker nach timeoutMs+5 s beendet, Ereignisschleife frei', { skip: ohneDb }, async () => {
  const modul = join(tmpBasis, 'haenger-registry.mjs');
  fs.writeFileSync(modul, [
    `import { AssetRegistry } from ${JSON.stringify(pathToFileURL(join(dist, 'asset-intel', 'registry.js')).href)};`,
    'export const registry = new AssetRegistry();',
    "registry.register({ id: 'haenger', formats: ['haeng'], extensions: ['.haeng'], version: 1,",
    '  inspect: async () => { for (;;) { /* haengt ohne await */ } } });',
    '',
  ].join('\n'));
  fs.writeFileSync(join(root, 'x.haeng'), BIN);
  core.konfiguriereAssetSync({ registryModul: modul, timeoutMs: 300 });
  core.setzeAssetSyncZaehlerZurueck();
  let maxLuecke = 0;
  let letzter = Date.now();
  const takt = setInterval(() => {
    const jetzt = Date.now();
    maxLuecke = Math.max(maxLuecke, jetzt - letzter);
    letzter = jetzt;
  }, 20);
  const t0 = Date.now();
  await core.verarbeiteAssetEreignis({ type: 'add', path: 'x.haeng', project: PROJ, asset: 'nur_asset' }, root);
  const dauer = Date.now() - t0;
  clearInterval(takt);
  core.konfiguriereAssetSync({ registryModul: null, timeoutMs: null });
  console.log(`# D5 Dauer ${dauer} ms, groesste Luecke der Ereignisschleife ${maxLuecke} ms`);
  assert.ok(dauer >= 5000 && dauer < 9000, `harter Abbruch nach ~5,3 s erwartet, war ${dauer}`);
  assert.ok(maxLuecke < 300, `Ereignisschleife blockiert (${maxLuecke} ms)`);
  assert.equal(core.assetSyncZaehler().abgebrochen, 1);
  const z = await zeile('x.haeng');
  assert.equal(z.status, 'fehler');
  assert.ok(z.warnings.some((w) => w.code === 'worker_abgebrochen'), JSON.stringify(z.warnings));
  // Der naechste Auftrag bekommt einen frischen Worker
  fs.writeFileSync(join(root, 'j.glb'), glb('NachHaenger'));
  await core.verarbeiteAssetEreignis({ type: 'add', path: 'j.glb', project: PROJ, asset: 'nur_asset' }, root);
  assert.equal((await zeile('j.glb')).status, 'ok');
});

// ---- D6: Sparse-GB-Datei ueber den echten Watcher ----

test('D6 Sparse-3-GB-Datei: Watcher + Abgleich lesen nur den Kopf', { skip: ohneDb || (rchar() === null && 'kein /proc/self/io') }, async () => {
  const PROJ2 = 'asset_d_gross';
  const dir = join(tmpBasis, 'gross');
  fs.mkdirSync(dir);
  fs.writeFileSync(join(dir, 'gross.bin'), BIN);
  fs.truncateSync(join(dir, 'gross.bin'), 3 * 1024 ** 3);
  await core.registerProject(PROJ2, dir);
  const r0 = rchar();
  const w = await starteWatcher(core, dir, PROJ2, (e) => codeSvc.handleFileEvent(e, dir, { assets: true }));
  const z = await warteBis(async () => {
    await core.warteAufAssetLeerlauf();
    return zeile('gross.bin', PROJ2);
  });
  await w.stop();
  const v = await core.verifyAssetsAgainstFilesystem(PROJ2, dir);
  const delta = rchar() - r0;
  console.log(`# D6 gelesen (Watcher + Inspektion + Abgleich): ${delta} Bytes fuer ${3 * 1024 ** 3} Bytes Datei`);
  assert.ok(z, 'Asset-Zeile fuer gross.bin');
  assert.equal(Number(z.file_size), 3 * 1024 ** 3, 'BIGINT-Groesse');
  assert.equal(z.sha256, null, 'kein Hash ueber maxHashBytes');
  assert.equal(v.unveraendert, 1, 'Abgleich: unveraendert');
  assert.ok(delta < 32 * 1024 * 1024, `GB-Datei darf nie komplett gelesen werden (gelesen ${delta})`);
  assert.equal(await codeZeile('gross.bin', PROJ2), undefined);
});

// ---- D7: Binaer-Schutz, REST-Weg ----

test('D7 indexFile verweigert Binaerdateien; handleFileEvent ohne assets inspiziert nie', { skip: ohneDb }, async () => {
  fs.writeFileSync(join(root, 'k.bin'), BIN);
  fs.writeFileSync(join(root, 'k.ts'), 'export const k = 1;\n');
  assert.equal(await codeSvc.indexFile('k.ts', PROJ, root), 1, 'Anker: Textdatei wird indexiert');
  assert.ok(await codeZeile('k.ts'));
  assert.equal(await codeSvc.indexFile('k.bin', PROJ, root), 0);
  assert.equal(await codeZeile('k.bin'), undefined, '.bin kommt nie in code_files');
  // REST-Prozess (projects.ts) ruft ohne Optionen: kein Code-Weg, keine Inspektion
  await codeSvc.handleFileEvent({ type: 'add', path: 'k.bin', project: PROJ, asset: 'nur_asset' }, root);
  await core.warteAufAssetLeerlauf();
  assert.equal(await zeile('k.bin'), undefined, 'ohne assets:true keine Inspektion');
  assert.equal(await codeZeile('k.bin'), undefined);
});

// ---- D9: Asset-Weg lehnt ab, Code-Weg laeuft ----

test('D9 Pfad ausserhalb der Wurzel mit asset zusaetzlich: Code-Weg laeuft trotzdem', { skip: ohneDb }, async () => {
  // Wie ein Symlink, dem chokidar folgt: relativePath beginnt mit '../'.
  const draussen = join(tmpBasis, 'draussen');
  fs.mkdirSync(draussen, { recursive: true });
  fs.writeFileSync(join(draussen, 'z.gltf'), GLTF);
  const rel = '../draussen/z.gltf';
  const vorher = core.assetSyncZaehler().fehler;
  await assert.doesNotReject(codeSvc.handleFileEvent({ type: 'add', path: rel, project: PROJ, asset: 'zusaetzlich' }, root, { assets: true }));
  assert.ok(await codeZeile(rel), 'Code-Weg hat die Datei trotz abgelehntem Asset-Auftrag indexiert');
  assert.equal(core.assetSyncZaehler().fehler - vorher, 1, 'Asset-Auftrag abgelehnt und gezaehlt');
  await core.warteAufAssetLeerlauf();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM asset_files WHERE project = $1 AND file_path LIKE $2', [PROJ, '%draussen%'])).rows[0].n, 0);
});

// ---- D8: Tabelle fehlt ----

test('D8 42P01: einmal geloggt, Asset-Weg aus, Code-Weg laeuft weiter', { skip: ohneDb }, async () => {
  fs.writeFileSync(join(root, 'n1.bin'), BIN);
  fs.writeFileSync(join(root, 'n2.bin'), Buffer.concat([BIN, BIN]));
  fs.writeFileSync(join(root, 'n.ts'), 'export const n = 1;\n');
  const meldungen = [];
  const original = console.error;
  console.error = (...a) => { meldungen.push(a.map(String).join(' ')); original(...a); };
  await pool.query('ALTER TABLE asset_files RENAME TO asset_files_weg');
  try {
    await codeSvc.handleFileEvent({ type: 'add', path: 'n1.bin', project: PROJ, asset: 'nur_asset' }, root, { assets: true });
    await core.warteAufAssetLeerlauf();
    await codeSvc.handleFileEvent({ type: 'add', path: 'n2.bin', project: PROJ, asset: 'nur_asset' }, root, { assets: true });
    await codeSvc.handleFileEvent({ type: 'add', path: 'n.ts', project: PROJ }, root, { assets: true });
    await core.warteAufAssetLeerlauf();
    const v = await core.verifyAssetsAgainstFilesystem(PROJ, root);
    assert.equal(core.assetWegAbgeschaltet(), true);
    assert.equal(v.abgeschaltet, true);
  } finally {
    await pool.query('ALTER TABLE asset_files_weg RENAME TO asset_files');
    console.error = original;
  }
  assert.equal(meldungen.filter((m) => m.includes('42P01')).length, 1, `genau eine 42P01-Meldung: ${JSON.stringify(meldungen.filter((m) => m.includes('42P01')))}`);
  assert.ok(await codeZeile('n.ts'), 'Code-Weg unberuehrt');
  assert.equal(await zeile('n2.bin'), undefined, 'nach dem Abschalten keine Inspektion mehr');
  core.setzeAssetWegZurueck();
  await core.verarbeiteAssetEreignis({ type: 'add', path: 'n2.bin', project: PROJ, asset: 'nur_asset' }, root);
  assert.ok(await zeile('n2.bin'), 'nach Zuruecksetzen wieder aktiv');
});
