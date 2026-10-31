/**
 * P22-T240 (Befund Koordinator 31.10.2026): Download-Endlosschleife, 317k pc-before-install-Sicherungen (103 GB), Cursor blockiert.
 * URSACHE (Code): Ein Delta liefert jede Zwischenrevision eines Assets; herunterladen() verglich nur auf Gleichheit mit der
 * bekannten Revision. Bei blockiertem Cursor (Wurzel P22-T206) wurde dieselbe Delta-Seite alle paar Sekunden erneut angewandt:
 * das Asset pendelte zwischen Revisionen, je Runde ein neuer Auftrag und eine neue pc-before-install-<auftrag>, die nie geloescht wurde.
 * Prueft file-watcher-daemon-ts asset-transfer-queue.ts und asset-sync-aufraeumen.ts gegen eine Fake-API (Loopback, ohne DB):
 *  1 Zwischenrevisionen rev1..rev3 in einem und in wiederholten Deltas: genau rev3 installiert, keine Ruecksprünge, keine Sicherung.
 *  2 PC-Fassung = bekannte Share-Revision: nach dem Ersetzen KEINE pc-before-install-Datei (vorher je Versuch eine).
 *  3 share_to_pc mit lokal geaenderter Datei: Sicherung je Inhalt genau einmal (pc-before-install-<sha256>).
 *  4 dauerhaft scheiternder Download: nach maxVersuche geparkt, Checkpoint laeuft weiter, keine download-<uuid>-Reste;
 *    ein neues Delta hebt das Parken auf. Checkpoint-Meldung nennt Downloads und Loeschauftraege getrennt.
 *  5 Aufraeumwerkzeug: Vorschau loescht nichts; ausfuehren ohne bestaetigt loescht nichts; mit Freigabe nur Duplikate/Temp-Reste.
 * Herkunft: Task P22-T240 (Plan P22), Bezug P22-T206/T237, P13-T26. Aufruf (nach Daemon-Build):
 *   mise exec node@25 -- node --test packages/file-watcher-daemon-ts/tests/asset-download-schleife-p22-t240.test.mjs
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
const { raeumeAssetSyncAuf } = await import(pathToFileURL(join(dist, 'asset-sync-aufraeumen.js')));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const png = (n, fill) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(n, fill)]);
const root = await fs.mkdtemp(join(tmpdir(), 'p22-t240-'));
const servers = new Set(), queues = new Set();
after(async () => {
  for (const q of queues) await q.stop().catch(() => {});
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  await fs.rm(root, { recursive: true, force: true });
});
const opts = { richtung: 'both', chunkBytes: 65536, retryMs: 10, timeoutMs: 2000, maxDateiBytes: 8 * 1024 * 1024, parallelTransfers: 1 };
async function dir() { const p = join(root, randomUUID()); await fs.mkdir(p); return p; }
const meta = (rev, b, pfad = 'bilder/a.png', id = '7') => ({ asset_id: id, pfad, revision: String(rev), sha256: sha(b), groesse: b.length, storage_kind: 'assets', storage_status: 'ready', deleted_at: null });
async function fakeApi({ bytes, fehler = () => false }) {
  const state = { downloads: [] };
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture');
    if (u.pathname.endsWith('/bytes')) {
      const rev = u.searchParams.get('revision'); state.downloads.push(rev);
      if (fehler(rev)) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'kaputt', message: 'fixture 500' } })); }
      const b = bytes.get(rev); res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(b.length) }); return res.end(b);
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'not_found', message: 'fixture' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); servers.add(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  return { state, api: new Transport(fetch, () => ({ token: 'fixture-only', basen: [base] })) };
}
function queue(p, api, o = {}) { const q = new Queue({ bereich: 'projekt', ziel_ref: 'p22_t240', host: 'daemon_fixture', root: p }, { ...opts, ...o }, api); queues.add(q); return q; }
async function drain(q, ms = 5000) { const end = Date.now() + ms; q.start(); while (Date.now() < end) { const s = await q.status(); if (!s.auftraege.some((j) => j.art !== 'upload' && !j.geparkt)) return s; await new Promise((r) => setTimeout(r, 15)); } throw Error('Timeout drain'); }
const sicherungen = async (p) => (await fs.readdir(join(p, '.synapse/asset-sync'))).filter((n) => n.startsWith('pc-before-install-'));
const temps = async (p) => (await fs.readdir(join(p, '.synapse/asset-sync'))).filter((n) => n.startsWith('download-'));

test('1 Zwischenrevisionen: nur die neueste wird installiert, wiederholte Deltas springen nie zurueck', async () => {
  const p = await dir(), r1 = png(300, 1), r2 = png(310, 2), r3 = png(320, 3);
  const f = await fakeApi({ bytes: new Map([['1', r1], ['2', r2], ['3', r3]]) });
  const q = queue(p, f.api);
  for (const [rev, b] of [[1, r1], [2, r2], [3, r3]]) await q.herunterladen(meta(rev, b));
  assert.equal((await q.status()).auftraege.filter((j) => j.art === 'download').length, 1);
  await drain(q);
  assert.equal(sha(await fs.readFile(join(p, 'bilder/a.png'))), sha(r3));
  // Cursor blockiert: dieselbe Delta-Seite fuenfmal erneut -> kein neuer Auftrag, kein Ruecksprung, keine Sicherung.
  for (let i = 0; i < 5; i++) for (const [rev, b] of [[1, r1], [2, r2], [3, r3]]) await q.herunterladen(meta(rev, b));
  assert.equal((await q.status()).auftraege.filter((j) => j.art === 'download').length, 0);
  assert.equal(sha(await fs.readFile(join(p, 'bilder/a.png'))), sha(r3));
  assert.deepEqual(f.state.downloads, ['3']);
  assert.deepEqual(await sicherungen(p), []);
});

test('2 PC-Fassung gleich bekannter Share-Revision: Ersetzen hinterlaesst keine pc-before-install', async () => {
  const p = await dir(), r1 = png(400, 4), r2 = png(410, 5);
  await fs.mkdir(join(p, 'bilder')); await fs.writeFile(join(p, 'bilder/a.png'), r1);
  const f = await fakeApi({ bytes: new Map([['2', r2]]) });
  const seed = queue(p, f.api); await seed.restoreCheckpoint([meta(1, r1)], 'c1', '1'); await seed.stop();
  const q = queue(p, f.api);
  await q.herunterladen(meta(2, r2));
  await drain(q);
  assert.equal(sha(await fs.readFile(join(p, 'bilder/a.png'))), sha(r2));
  assert.deepEqual(await sicherungen(p), []);
  assert.deepEqual(await temps(p), []);
});

test('3 share_to_pc, lokal geaendert: Sicherung je Inhalt genau einmal', async () => {
  const p = await dir(), r1 = png(500, 6), lokal = png(505, 7), r2 = png(510, 8), r3 = png(520, 9);
  await fs.mkdir(join(p, 'bilder')); await fs.writeFile(join(p, 'bilder/a.png'), r1);
  const f = await fakeApi({ bytes: new Map([['2', r2], ['3', r3]]) });
  const seed = queue(p, f.api, { richtung: 'share_to_pc' }); await seed.restoreCheckpoint([meta(1, r1)], 'c1', '1'); await seed.stop();
  await fs.writeFile(join(p, 'bilder/a.png'), lokal);
  const q = queue(p, f.api, { richtung: 'share_to_pc' });
  await q.herunterladen(meta(2, r2)); await drain(q);
  assert.deepEqual(await sicherungen(p), ['pc-before-install-' + sha(lokal)]);
  const k = (await q.status()).konflikte.find((x) => x.pfad === 'bilder/a.png');
  assert.equal(k.sicherung, 'pc-before-install-' + sha(lokal));
  await q.herunterladen(meta(3, r3)); await drain(q); // r2 == bekannt -> keine weitere Sicherung
  assert.deepEqual(await sicherungen(p), ['pc-before-install-' + sha(lokal)]);
  assert.equal(sha(await fs.readFile(join(p, 'bilder/a.png'))), sha(r3));
});

test('4 Dauerfehler: Parken nach maxVersuche, Checkpoint frei, keine Temp-Reste, neues Delta hebt Parken auf', async () => {
  const p = await dir(), r1 = png(600, 10), r2 = png(610, 11);
  let kaputt = true;
  const f = await fakeApi({ bytes: new Map([['1', r1], ['2', r2]]), fehler: () => kaputt });
  const q = queue(p, f.api, { maxVersuche: 3, parkRetryMs: 3_600_000 });
  await q.herunterladen(meta(1, r1));
  await assert.rejects(q.checkpoint('c', '1'), (e) => e.code === 'checkpoint_offen' && /1 Download\(s\) und 0 Löschauftrag/.test(e.message));
  const s = await drain(q);
  const job = s.auftraege.find((j) => j.art === 'download');
  assert.equal(job.geparkt, true);
  assert.equal(job.versuche, 3);
  assert.equal(s.stau.geparkt, 1);
  assert.ok(f.state.downloads.length <= 3, 'kein weiterer Versuch vor parkRetryMs');
  await q.checkpoint('c2', '2'); // geparkter Auftrag blockiert den Cursor nicht
  assert.equal((await q.status()).cursor, 'c2');
  assert.deepEqual(await temps(p), []);
  kaputt = false;
  await q.herunterladen(meta(2, r2)); // neues Delta: Parken aufgehoben, neueste Revision
  const nach = await drain(q);
  assert.equal(nach.auftraege.filter((j) => j.art === 'download').length, 0);
  assert.equal(sha(await fs.readFile(join(p, 'bilder/a.png'))), sha(r2));
  // maxVersuche 0 = Altverhalten (nie parken)
  const q0 = queue(await dir(), f.api, { maxVersuche: 0 }); kaputt = true;
  await q0.herunterladen(meta(1, r1)); q0.start(); await new Promise((r) => setTimeout(r, 300));
  assert.ok(!(await q0.status()).auftraege.some((j) => j.geparkt));
});

test('5 Aufraeumwerkzeug: Vorschau, Freigabe noetig, nur Duplikate und Temp-Reste', async () => {
  const p = await dir(), d = join(p, '.synapse/asset-sync'), pc = png(700, 12), alt = png(710, 13);
  await fs.mkdir(join(p, 'bilder'), { recursive: true }); await fs.mkdir(d, { recursive: true });
  await fs.writeFile(join(p, 'bilder/a.png'), pc);
  const a = 'pc-before-install-' + randomUUID(), b = 'pc-before-install-' + randomUUID(), c = 'pc-before-install-' + randomUUID();
  await fs.writeFile(join(d, a), pc);   // gleich PC-Datei
  await fs.writeFile(join(d, b), alt);  // einmaliger alter Inhalt -> bleibt
  await fs.writeFile(join(d, c), alt);  // Kopie davon -> doppelt
  const tmpAktiv = randomUUID(), tmpAlt = randomUUID();
  await fs.writeFile(join(d, 'download-' + tmpAktiv), ''); await fs.writeFile(join(d, 'download-' + tmpAlt), '');
  const zt = 'abc.json.' + randomUUID() + '.tmp'; await fs.writeFile(join(d, zt), '{}');
  const vor = new Date(Date.now() - 2 * 3600_000); await fs.utimes(join(d, zt), vor, vor);
  await fs.writeFile(join(d, 'zustand.json'), '{}'); await fs.writeFile(join(d, 'deleted-' + randomUUID()), 'x');
  const basis = { dir: d, root: p, pfade: ['bilder/a.png'], aktiveJobIds: new Set([tmpAktiv]) };
  const v = await raeumeAssetSyncAuf(basis);
  assert.equal(v.ausgefuehrt, false);
  assert.equal(v.arten.gleich_pc.anzahl, 1);
  assert.equal(v.arten.doppelt.anzahl, 1);
  assert.equal(v.arten.temp_download.anzahl, 1);
  assert.equal(v.arten.temp_zustand.anzahl, 1);
  assert.equal((await fs.readdir(d)).length, 8, 'Vorschau loescht nichts');
  await raeumeAssetSyncAuf({ ...basis, ausfuehren: true }); // ohne bestaetigt
  assert.equal((await fs.readdir(d)).length, 8);
  const x = await raeumeAssetSyncAuf({ ...basis, ausfuehren: true, bestaetigt: true });
  assert.equal(x.ausgefuehrt, true);
  const rest = (await fs.readdir(d)).sort();
  assert.equal(rest.length, 4);
  assert.ok(rest.includes('zustand.json') && rest.includes('download-' + tmpAktiv) && rest.some((n) => n.startsWith('deleted-')));
  assert.equal(rest.filter((n) => n.startsWith('pc-before-install-')).length, 1, 'genau eine Kopie des einmaligen Inhalts bleibt');
});
