/**
 * P22-T241 (USER-GRUNDSATZ 31.10.2026, thought 5e4ac6f7): Reverse schreibt nie in einen Projekt-Share, ausser reverse(uebernehmen).
 * Prueft ohne Datenbank (Fake-DB) in eigener Testwurzel unter tmp:
 *  1 Reverse-Operationen des Speichers (stage + publish im Bereich 'reverse', Chunk-Staging) schreiben NUR unter
 *    SYNAPSE_REVERSE_ROOT; unter SYNAPSE_PROJEKTE_ROOT entsteht keine Datei (auch kein .intern).
 *  2 inventarProjektIntern: Ordner mit Anzahl/Bytes, Staging/Journal nach Herkunft (reverse-api -> reverse_uebernehmen), fremde
 *    Ordner gelistet, Sperre angezeigt; zusammengesetztes Staging ueber Journal (Pfad+Hash) zugeordnet.
 *  3 raeumeReverseAltbestandAuf: Vorschau loescht nichts; ausfuehren ohne bestaetigt nichts; mit Freigabe NUR Reverse-Herkunft
 *    abgeschlossener Sitzungen, nie PC-Staging, nie aktive Sitzung, nie prepared-Journal, nie Revisionen.
 * Herkunft: Task P22-T241 (Plan P22), Bezug P22-T206, P18-T27, P18-T109.
 * Aufruf: mise exec node@25 -- node --test packages/core/tests/reverse-projekt-share-p22-t241.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const S = await import('../dist/services/asset-speicher.js');
const I = await import('../dist/services/asset-intern-inventar.js');
const { ladeAssetKonfiguration } = await import('../dist/config/asset-konfig.js');

const temp = await fs.mkdtemp(join(tmpdir(), 'p22-t241-'));
after(async () => { await fs.rm(temp, { recursive: true, force: true }); });
const projekte = join(temp, 'projekte'), reverse = join(temp, 'reverse');
await fs.mkdir(projekte); await fs.mkdir(reverse);
const cfg = ladeAssetKonfiguration({ SYNAPSE_ASSET_ENABLED: '1', SYNAPSE_PROJEKTE_ROOT: projekte, SYNAPSE_REVERSE_ENABLED: '1', SYNAPSE_REVERSE_ROOT: reverse });
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function alleDateien(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath ?? e.path, e.name));
  return out;
}

test('1 Reverse-Speicheroperationen schreiben nie unter SYNAPSE_PROJEKTE_ROOT', async () => {
  const s = new S.AssetSpeicher({ konfiguration: cfg });
  const rid = 'rev-t241-' + randomUUID().slice(0, 8), b = Buffer.from('reverse-original');
  const a = { bereich: 'reverse', ziel_ref: rid, storage_kind: 'assets', logischer_pfad: 'cd/bild.png' };
  const teil = await s.stageTeil(a, [b], { groesse: b.length });
  const st = await s.stage(a, [b], { groesse: b.length, sha256: sha(b) });
  await s.publish(st, { basisSha256: null, prepare: async () => {}, commit: async () => {} });
  assert.ok(teil.id && st.id);
  assert.deepEqual(await alleDateien(projekte), [], 'Projekt-Share bleibt leer');
  assert.ok((await alleDateien(reverse)).length > 0, 'Reverse-Share enthaelt die Daten');
});

const P = 'synapse_t241';
const base = join(projekte, P, '.intern');
async function datei(sub, name, inhalt = 'x') { await fs.mkdir(join(base, sub), { recursive: true }); await fs.writeFile(join(base, sub, name), inhalt); }
function fakeDb(sitzungen) {
  // sitzungen: Map staging_id -> {host_id,status,lease_aktiv}; pfad: Map 'pfad\0sha' -> {...}
  return { async query(sql, v) {
    if (/FROM asset_upload_teile/.test(sql)) return { rows: v[1].filter((id) => sitzungen.teile.has(id)).map((id) => ({ id, ...sitzungen.teile.get(id) })) };
    if (/DISTINCT ON \(logischer_pfad, sha256\)/.test(sql)) return { rows: v[1].map((p, i) => sitzungen.pfad.get(p + '\u0000' + v[2][i]) ? { logischer_pfad: p, sha256: v[2][i], ...sitzungen.pfad.get(p + '\u0000' + v[2][i]) } : null).filter(Boolean) };
    throw new Error('unerwartet: ' + sql);
  } };
}
const ids = { revFertig: randomUUID(), revAktiv: randomUUID(), pc: randomUUID(), revVoll: randomUUID(), revPrepared: randomUUID(), unbekannt: randomUUID() };
const voll = { pfad: 'reverse/bild.png', sha: sha(Buffer.from('voll')) };
const db = fakeDb({
  teile: new Map([
    [ids.revFertig, { host_id: 'reverse-api', status: 'finalisiert', lease_aktiv: false }],
    [ids.revAktiv, { host_id: 'reverse-api', status: 'laeuft', lease_aktiv: true }],
    [ids.pc, { host_id: 'daemon-fixture', status: 'finalisiert', lease_aktiv: false }],
    [ids.revPrepared, { host_id: 'reverse-api', status: 'vollstaendig', lease_aktiv: false }],
  ]),
  pfad: new Map([[voll.pfad + '\u0000' + voll.sha, { host_id: 'reverse-api', status: 'fehler', lease_aktiv: false }]]),
});
async function aufbau() {
  await fs.rm(join(projekte, P), { recursive: true, force: true });
  for (const id of [ids.revFertig, ids.revAktiv, ids.pc, ids.unbekannt]) { await datei('staging', id + '.part', 'teil-' + id); await datei('journal', id + '.json', JSON.stringify({ id, status: 'staged' })); }
  await datei('staging', ids.revVoll + '.part', 'voll');
  await datei('journal', ids.revVoll + '.json', JSON.stringify({ id: ids.revVoll, status: 'staged', sha256: voll.sha, adresse: { logischer_pfad: voll.pfad } }));
  await datei('journal', ids.revPrepared + '.json', JSON.stringify({ id: ids.revPrepared, status: 'prepared' }));
  await datei('revisionen', ids.revFertig + '-neu', 'revision');
  await datei('locks', 'publish', ids.revAktiv);
  await datei('reverse-alt', 'rest.bin', 'altkonzept');
}

test('2 Inventar: Ordner, Herkunft je Datei, fremde Ordner, Sperre', async () => {
  await aufbau();
  const inv = await I.inventarProjektIntern(P, { db, konfiguration: cfg });
  assert.equal(inv.vorhanden, true);
  assert.deepEqual(inv.fremde_ordner, ['reverse-alt']);
  assert.equal(inv.sperre.publish, ids.revAktiv);
  assert.equal(inv.staging.dateien, 5);
  assert.equal(inv.staging.nach_herkunft.reverse_uebernehmen.dateien, 3, 'zwei Chunks + ein zusammengesetztes Staging ueber Journal');
  assert.equal(inv.staging.nach_herkunft.pc.dateien, 1);
  assert.equal(inv.staging.nach_herkunft.unbekannt.dateien, 1);
  assert.equal(inv.journal.dateien, 6);
  assert.equal(inv.journal.status.staged, 5);
  assert.equal(inv.journal.status.prepared, 1);
  assert.equal(inv.revisionen.nach_herkunft.reverse_uebernehmen.dateien, 1);
  const ordner = Object.fromEntries(inv.ordner.map((o) => [o.name, o.dateien]));
  assert.deepEqual(ordner, { journal: 6, locks: 1, revisionen: 1, staging: 5, 'reverse-alt': 1 });
  assert.equal((await I.inventarProjektIntern('gibt_es_nicht', { db, konfiguration: cfg })).vorhanden, false);
  assert.equal(I.herkunftVonHost('reverse-api'), 'reverse_uebernehmen');
  assert.equal(I.herkunftVonHost('user:abc'), 'user');
});

test('3 Reverse-Altbestand: Vorschau, Freigabe noetig, nur abgeschlossene Reverse-Herkunft', async () => {
  await aufbau();
  const vor = await I.raeumeReverseAltbestandAuf(P, { db, konfiguration: cfg });
  assert.equal(vor.ausgefuehrt, false);
  assert.equal(vor.staging.dateien, 2, 'revFertig + revVoll; revAktiv ist aktiv und Sperre');
  assert.equal(vor.journal.dateien, 2);
  assert.ok(vor.behalten_aktiv >= 1);
  await I.raeumeReverseAltbestandAuf(P, { db, konfiguration: cfg, ausfuehren: true });
  assert.equal((await fs.readdir(join(base, 'staging'))).length, 5, 'ohne bestaetigt nichts geloescht');
  const r = await I.raeumeReverseAltbestandAuf(P, { db, konfiguration: cfg, ausfuehren: true, bestaetigt: true });
  assert.equal(r.ausgefuehrt, true);
  const staging = (await fs.readdir(join(base, 'staging'))).sort();
  assert.deepEqual(staging, [ids.revAktiv + '.part', ids.pc + '.part', ids.unbekannt + '.part'].sort());
  const journal = await fs.readdir(join(base, 'journal'));
  assert.ok(journal.includes(ids.revPrepared + '.json'), 'prepared bleibt fuer die Recovery');
  assert.ok(journal.includes(ids.pc + '.json') && journal.includes(ids.revAktiv + '.json'));
  assert.ok(!journal.includes(ids.revFertig + '.json') && !journal.includes(ids.revVoll + '.json'));
  assert.deepEqual(await fs.readdir(join(base, 'revisionen')), [ids.revFertig + '-neu'], 'Revisionen bleiben');
  assert.deepEqual(await fs.readdir(join(base, 'reverse-alt')), ['rest.bin'], 'fremde Ordner werden nur gemeldet');
  assert.equal(I.ASSET_INTERN_AUFRAEUMEN, 'asset_intern_aufraeumen');
});
