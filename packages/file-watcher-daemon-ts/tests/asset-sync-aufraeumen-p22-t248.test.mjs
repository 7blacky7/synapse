/**
 * P22-T248 (User 31.10.2026 ~21:08: Screenshots bleiben Assets, im Asset-Sync-Zustandsordner bleibt aber nichts liegen).
 * Prueft file-watcher-daemon-ts asset-sync-aufraeumen.ts ohne Daemon/DB in eigener Testwurzel:
 *  1 Sicherung mit Inhalt einer bekannten Share-Revision -> share_bekannt (entfernt), einmaliger Inhalt bleibt.
 *  2 Frist: einmalige Sicherung juenger als fristMs bleibt, aelter (jetzt in die Zukunft verschoben) -> frist_abgelaufen.
 *     Auch die deduplizierte pc-before-install-<sha256> faellt nach der Frist.
 *  3 Bestand: zustandsordner zaehlt Dateien/Bytes NACH dem Lauf; zaehleZustandsordner einzeln.
 *  4 Ohne Sicherungen werden keine Projektdateien gehasht (nicht existierende Vergleichspfade erzeugen keine Fehler).
 *  5 Altverhalten: ohne shareHashes/fristMs wie P22-T240 (einmalige Inhalte bleiben unbegrenzt).
 * Herkunft: Task P22-T248 (Plan P22), Bezug P22-T240. Aufruf (nach Daemon-Build):
 *   mise exec node@25 -- node --test packages/file-watcher-daemon-ts/tests/asset-sync-aufraeumen-p22-t248.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const dist = new URL('../dist/', import.meta.url).pathname;
const { raeumeAssetSyncAuf, zaehleZustandsordner } = await import(pathToFileURL(join(dist, 'asset-sync-aufraeumen.js')));
const root = await fs.mkdtemp(join(tmpdir(), 'p22-t248-'));
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function aufbau() {
  const p = join(root, randomUUID()), d = join(p, '.synapse/asset-sync');
  await fs.mkdir(d, { recursive: true }); await fs.mkdir(join(p, 'bilder'));
  return { p, d };
}
const TAG = 86_400_000;

test('1 Inhalt einer bekannten Share-Revision -> share_bekannt; einmaliger Inhalt bleibt', async () => {
  const { p, d } = await aufbau();
  const share = Buffer.from('share-revision'), einmalig = Buffer.from('konfliktfassung');
  await fs.writeFile(join(p, 'bilder/a.png'), Buffer.from('aktuell'));
  await fs.writeFile(join(d, 'pc-before-install-' + randomUUID()), share);
  await fs.writeFile(join(d, 'pc-before-install-' + randomUUID()), einmalig);
  const r = await raeumeAssetSyncAuf({ dir: d, root: p, pfade: ['bilder/a.png'], aktiveJobIds: new Set(), shareHashes: new Set([sha(share)]),
    fristMs: 7 * TAG, ausfuehren: true, bestaetigt: true });
  assert.equal(r.arten.share_bekannt.anzahl, 1);
  assert.equal(r.arten.frist_abgelaufen.anzahl, 0);
  assert.equal(r.behalten, 1);
  const rest = await fs.readdir(d);
  assert.equal(rest.length, 1);
  assert.equal(sha(await fs.readFile(join(d, rest[0]))), sha(einmalig));
});

test('2 Frist: juenger bleibt, aelter faellt (auch deduplizierte pc-before-install-<sha256>)', async () => {
  const { p, d } = await aufbau();
  const a = Buffer.from('fassung-a'), b = Buffer.from('fassung-b');
  await fs.writeFile(join(d, 'pc-before-install-' + randomUUID()), a);
  await fs.writeFile(join(d, 'pc-before-install-' + sha(b)), b);
  const jung = await raeumeAssetSyncAuf({ dir: d, root: p, pfade: [], aktiveJobIds: new Set(), fristMs: 7 * TAG, ausfuehren: true, bestaetigt: true });
  assert.equal(jung.arten.frist_abgelaufen.anzahl, 0);
  assert.equal((await fs.readdir(d)).length, 2);
  const alt = await raeumeAssetSyncAuf({ dir: d, root: p, pfade: [], aktiveJobIds: new Set(), fristMs: 7 * TAG, jetzt: Date.now() + 8 * TAG, ausfuehren: true, bestaetigt: true });
  assert.equal(alt.arten.frist_abgelaufen.anzahl, 2);
  assert.deepEqual(await fs.readdir(d), []);
});

test('3 Bestand nach dem Lauf und zaehleZustandsordner', async () => {
  const { p, d } = await aufbau();
  await fs.writeFile(join(d, 'zustand.json'), '{"x":1}');
  await fs.writeFile(join(d, 'pc-before-install-' + randomUUID()), Buffer.alloc(100, 1));
  await fs.writeFile(join(d, 'pc-before-install-' + randomUUID()), Buffer.alloc(100, 1));
  const r = await raeumeAssetSyncAuf({ dir: d, root: p, pfade: [], aktiveJobIds: new Set(), ausfuehren: true, bestaetigt: true });
  assert.equal(r.arten.doppelt.anzahl, 1);
  assert.deepEqual(r.zustandsordner, { dateien: 2, bytes: 107 });
  assert.deepEqual(await zaehleZustandsordner(d), { dateien: 2, bytes: 107 });
});

test('4 Ohne Sicherungen kein Hashen der Projektdateien, keine Fehler', async () => {
  const { p, d } = await aufbau();
  await fs.writeFile(join(d, 'zustand.json'), '{}');
  await fs.mkdir(join(p, 'gesperrt')); await fs.writeFile(join(p, 'gesperrt/x.png'), 'x'); await fs.chmod(join(p, 'gesperrt/x.png'), 0o000);
  const r = await raeumeAssetSyncAuf({ dir: d, root: p, pfade: ['gesperrt/x.png', 'fehlt.png'], aktiveJobIds: new Set(), fristMs: TAG, ausfuehren: true, bestaetigt: true });
  assert.deepEqual(r.fehler, [], 'unlesbare Projektdatei wird ohne Sicherungen gar nicht geoeffnet');
  await fs.chmod(join(p, 'gesperrt/x.png'), 0o600);
});

test('5 Altverhalten ohne shareHashes/fristMs: einmalige Inhalte bleiben unbegrenzt', async () => {
  const { p, d } = await aufbau();
  await fs.writeFile(join(d, 'pc-before-install-' + randomUUID()), Buffer.from('einmalig'));
  const r = await raeumeAssetSyncAuf({ dir: d, root: p, pfade: [], aktiveJobIds: new Set(), jetzt: Date.now() + 365 * TAG, ausfuehren: true, bestaetigt: true });
  assert.equal(r.behalten, 1);
  assert.equal(r.arten.frist_abgelaufen.anzahl, 0);
  assert.equal(r.arten.share_bekannt.anzahl, 0);
});
