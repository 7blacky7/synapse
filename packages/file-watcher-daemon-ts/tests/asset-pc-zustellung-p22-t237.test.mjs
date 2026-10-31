/**
 * P22-T237 (USER-GRUNDSATZ 31.10.2026, thought 4d6e67d6 Grundsatz 2): Daemon offline -> Asset bleibt im Share; sobald der Daemon
 * online ist, kommt es in den Projektordner. Prueft die Daemon-Seite gegen eine Fake-API (echte Loopback-HTTP-Stroeme, eigene
 * Testwurzel, KEINE Datenbank):
 *  1  API/Daemon zuerst offline (503), dann online: Verhandlung, Manifest mit ZWEI Share-Assets, Download, Dateien im Projektordner
 *     mit gleichem Hash; danach POST assets/pc-stand mit dem bestaetigten Stand und offene_downloads 0.
 *  2  Daemon laengere Zeit offline mit bestehendem Cursor: Delta mit mehreren Aenderungen wird nachgeholt, Stand gemeldet.
 *  3  Aeltere API ohne pc-stand-Route (404): Abgleich bleibt erfolgreich, Meldung pausiert, Debug in status().pc_stand_meldung.
 *  4  Projekt ohne asset_sync.aktiv: weiterhin KEIN API-Aufruf (P13-T44 unveraendert); Heartbeat-Helfer nennt nur aktive Projekte,
 *     globales asset_sync.aktiv=false schaltet alle aus.
 * Herkunft: Task P22-T237; Bestand P13-T26 (A8, asset-sync.ts) und P13-T44/T45 (Asset-Sync je Projekt).
 * Aufruf (nach Build des Daemons): mise exec node@25 -- node --test packages/file-watcher-daemon-ts/tests/asset-pc-zustellung-p22-t237.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const dist = new URL('../dist/', import.meta.url).pathname;
const { AssetTransferQueue: Queue } = await import(pathToFileURL(join(dist, 'asset-transfer-queue.js')));
const { AssetApiTransport: Transport } = await import(pathToFileURL(join(dist, 'asset-api-transport.js')));
const { DaemonAssetSync: Sync } = await import(pathToFileURL(join(dist, 'asset-sync.js')));
const { assetSyncAktiveProjekte } = await import(pathToFileURL(join(dist, 'daemon-heartbeat.js')));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const png = (n, fill) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(n, fill)]);
const NAME = 'p22_t237';
const root = await fs.mkdtemp(join(tmpdir(), 'p22-t237-d-'));
const servers = new Set(), syncs = new Set();
after(async () => {
  for (const s of syncs) await s.stopAll();
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  await fs.rm(root, { recursive: true, force: true });
});
async function until(fn, label, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 15)); } throw Error('Timeout ' + label); }
async function dir() { const p = join(root, randomUUID()); await fs.mkdir(p); return p; }
const meta = (id, pfad, b, rev = '1') => ({ asset_id: id, pfad, revision: rev, sha256: sha(b), groesse: b.length, storage_kind: 'assets', storage_status: 'ready', deleted_at: null });

/** Fake-API: offline() schaltet /api/projects auf 503; assets = id -> Buffer; pcStand = Statuscode der neuen Route. */
async function fakeApi({ offline = () => false, assets, manifest, delta, pcStand = 200 }) {
  const state = { requests: [], pcStand: [] };
  const json = (r, v, s = 200) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(v)); };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture'); state.requests.push(req.method + ' ' + u.pathname);
    if (u.pathname === '/api/projects') {
      if (offline()) return json(res, { error: { code: 'offline', message: 'offline' } }, 503);
      return json(res, { projects: [NAME], activeWatchers: [NAME], capabilities: { contractVersion: 1, features: ['asset_sync'] } });
    }
    if (u.pathname.endsWith('/sync-optionen')) return json(res, { success: true, host: 'daemon_fixture', richtung: 'both', chunkBytes: 65536, retryMs: 10, timeoutMs: 2000, maxDateiBytes: 8 * 1024 * 1024, parallelTransfers: 1, scanMs: 60000 });
    if (u.pathname.endsWith('/inspektionsmodus')) return json(res, { success: true, modus: 'asset_sync' });
    if (u.pathname.endsWith('/manifest')) return json(res, manifest());
    if (u.pathname.endsWith('/aenderungen')) return json(res, delta(u));
    if (u.pathname.endsWith('/bytes')) {
      const b = assets.get(u.searchParams.get('asset_id'));
      if (!b) return json(res, { error: { code: 'asset_fehlt', message: 'fehlt' } }, 404);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(b.length) }); return res.end(b);
    }
    if (u.pathname.endsWith('/pc-stand') && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c;
      state.pcStand.push(JSON.parse(raw));
      if (pcStand !== 200) return json(res, { error: { code: 'not_found', message: 'fixture route' } }, pcStand);
      return json(res, { success: true, gespeichert: true, stand: JSON.parse(raw).stand });
    }
    return json(res, { error: { code: 'not_found', message: 'fixture route' } }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); servers.add(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  return { state, api: new Transport(fetch, () => ({ token: 'fixture-only', basen: [base] })) };
}
function sync(api, project) {
  const config = { asset_sync: { retry_ms: 20 }, projekte: [project] };
  const s = new Sync(() => config, api); syncs.add(s); return s;
}

test('1 Daemon/API zuerst offline, dann online: zwei Share-Assets landen bytegleich im Projektordner, Stand wird gemeldet', async () => {
  const p = await dir(), a = png(1500, 1), b = png(900, 2);
  let offline = true;
  const f = await fakeApi({ offline: () => offline, assets: new Map([['11', a], ['12', b]]),
    manifest: () => ({ eintraege: [meta('11', 'bilder/a.png', a), meta('12', 'bilder/unter/b.png', b)], cursor: null, aenderungs_cursor: 'delta-7', stand: '7', vollstaendig: true }),
    delta: () => ({ eintraege: [], cursor: 'delta-7', stand: '7', vollstaendig: true }) });
  const project = { name: NAME, pfad: p, enabled: true, asset_sync: { aktiv: true } };
  const s = sync(f.api, project); s.starte(project);
  await new Promise((r) => setTimeout(r, 120));
  // Offline: nichts im Projektordner, keine Bytes geholt (Asset bleibt im Share).
  await assert.rejects(fs.stat(join(p, 'bilder/a.png')));
  assert.ok(!f.state.requests.some((r) => r.includes('/bytes')));
  offline = false;
  await until(async () => f.state.pcStand.length > 0, 'pc-stand nach Online');
  assert.equal(sha(await fs.readFile(join(p, 'bilder/a.png'))), sha(a));
  assert.equal(sha(await fs.readFile(join(p, 'bilder/unter/b.png'))), sha(b));
  assert.deepEqual(f.state.pcStand[0], { stand: '7', offene_downloads: 0, letzter_fehler: null });
  const st = await s.status(NAME);
  assert.equal(st.cursor, 'delta-7');
  assert.equal(st.pc_stand_meldung.antwort, 'gespeichert');
});

test('2 Daemon laengere Zeit offline mit Cursor: Delta mit mehreren Aenderungen wird nachgeholt und bestaetigt', async () => {
  const p = await dir(), a = png(700, 3), b = png(800, 4), c = png(600, 5);
  const seeded = new Queue({ bereich: 'projekt', ziel_ref: NAME, host: 'daemon_fixture', root: p },
    { richtung: 'both', chunkBytes: 65536, retryMs: 10, timeoutMs: 2000, maxDateiBytes: 8 * 1024 * 1024, parallelTransfers: 1 });
  await seeded.restoreCheckpoint([], 'delta-3', '3'); await seeded.stop();
  const seen = [];
  const f = await fakeApi({ assets: new Map([['21', a], ['22', b], ['23', c]]),
    manifest: () => { throw new Error('kein Manifest erwartet'); },
    delta: (u) => { seen.push(u.searchParams.get('cursor'));
      return { eintraege: [{ metadaten: meta('21', 'x/a.png', a) }, { metadaten: meta('22', 'x/b.png', b) }, { metadaten: meta('23', 'y/c.png', c) }], cursor: 'delta-12', stand: '12', vollstaendig: true }; } });
  const project = { name: NAME, pfad: p, enabled: true, asset_sync: { aktiv: true } };
  const s = sync(f.api, project); s.starte(project);
  await until(async () => f.state.pcStand.some((m) => m.stand === '12'), 'Stand 12 gemeldet');
  assert.equal(seen[0], 'delta-3');
  for (const [pfad, buf] of [['x/a.png', a], ['x/b.png', b], ['y/c.png', c]]) assert.equal(sha(await fs.readFile(join(p, pfad))), sha(buf));
  assert.equal((await s.status(NAME)).stand, '12');
});

test('3 Aeltere API ohne pc-stand-Route: Abgleich bleibt erfolgreich, Meldung pausiert, Debug sichtbar', async () => {
  const p = await dir(), a = png(500, 6);
  const f = await fakeApi({ pcStand: 404, assets: new Map([['31', a]]),
    manifest: () => ({ eintraege: [meta('31', 'a.png', a)], cursor: null, aenderungs_cursor: 'd1', stand: '1', vollstaendig: true }),
    delta: () => ({ eintraege: [], cursor: 'd1', stand: '1', vollstaendig: true }) });
  const project = { name: NAME, pfad: p, enabled: true, asset_sync: { aktiv: true } };
  const s = sync(f.api, project); s.starte(project);
  assert.equal(await s.bereit(NAME), true);
  await until(async () => (await s.status(NAME))?.pc_stand_meldung, 'Debugmeldung');
  assert.equal(sha(await fs.readFile(join(p, 'a.png'))), sha(a));
  const st = await s.status(NAME);
  assert.match(st.pc_stand_meldung.antwort, /^fehler/);
  const anzahl = f.state.pcStand.length;
  await s.bereit(NAME); // zweiter Abgleich innerhalb der Pause: keine weitere Meldung
  assert.equal(f.state.pcStand.length, anzahl);
});

test('4 Asset-Sync AUS: kein API-Aufruf (P13-T44); Heartbeat nennt nur Projekte mit Schalter AN', async () => {
  const p = await dir();
  const f = await fakeApi({ assets: new Map(), manifest: () => ({}), delta: () => ({}) });
  const project = { name: NAME, pfad: p, enabled: true, asset_sync: { aktiv: false } };
  const s = sync(f.api, project); s.starte(project);
  assert.equal(await s.bereit(NAME), false);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(f.state.requests, []);
  const liste = [{ name: 'an', asset_sync: { aktiv: true } }, { name: 'aus', asset_sync: { aktiv: false } }, { name: 'ohne' }];
  // P22-T238 (thought d59f32e8): fehlendes Feld = EIN (global fuer alle aktiven Projekte).
  assert.deepEqual(assetSyncAktiveProjekte(liste, true), ['an', 'ohne']);
  assert.deepEqual(assetSyncAktiveProjekte(liste, false), []);
});
