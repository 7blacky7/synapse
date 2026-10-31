/**
 * P22-T206 (Befunde 4c11e135, ccb14310): verwaiste Publikationssperre im Journalstatus 'staged'.
 * Prueft core services/asset-speicher.ts (publish: Besitzer vor Lock-Erwerb im Journal, lock-Teilfehler, publishSperre,
 * verwerfeStaging) und services/asset-sperren-recovery.ts (publishOperationVerwaist, pruefePublishSperre) OHNE Datenbank
 * (Fake-DB) in einer eigenen Testwurzel unter tmp.
 *  1 publish schreibt besitzer (Prozess, Lease, Auftrag) ins Journal; Sperre nach Erfolg frei.
 *  2 Abbruch nach Lock-Erwerb und vor Prepare (Prozess weg, simuliert): fremder Besitzer + Lease laeuft -> lease_laeuft;
 *    Lease abgelaufen + PG aktiv -> pg_aktiv; PG verwaist -> vorschau loesbar (nichts geaendert), ausfuehren geloest.
 *  3 Lebender Besitzer (haengendes Prepare in diesem Prozess) -> aktiv, nichts geloest; prepared -> andere_recovery.
 *  4 Alt-Sperre ohne Besitzerangabe (wie die Live-Sperre 7efd51e0): automatisch NIE (verwaist_unbewiesen), nur mit
 *    ohneBesitzerNachweis (User-Freigabe) und PG-Nachweis.
 *  5 verwerfeStaging: Staging eines gescheiterten Versuchs weg, Journal failed; gehaltene Sperre -> nichts.
 *  6 publishOperationVerwaist: Sitzung kennt die Operation / finalisiert gerade -> false; sonst true.
 * Nicht abgedeckt (I/O nicht injizierbar): echter fsync-Fehler beim Lock-Anlegen; der Code entfernt die halbe Sperre (finally).
 * Herkunft: Task P22-T206 (Plan P22), Wurzel von P22-T240. Aufruf: mise exec node@25 -- node --test packages/core/tests/asset-publish-sperre-p22-t206.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const S = await import('../dist/services/asset-speicher.js');
const R = await import('../dist/services/asset-sperren-recovery.js');
const { ladeAssetKonfiguration } = await import('../dist/config/asset-konfig.js');

const root = await fs.mkdtemp(join(tmpdir(), 'p22-t206-'));
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const cfg = ladeAssetKonfiguration({ SYNAPSE_ASSET_ENABLED: '1', SYNAPSE_PROJEKTE_ROOT: root });
const sha = (b) => createHash('sha256').update(b).digest('hex');
let n = 0;
const projekt = () => 'p206' + (++n);
const adresse = (p, pfad = 'bilder/a.png') => ({ bereich: 'projekt', ziel_ref: p, storage_kind: 'assets', logischer_pfad: pfad });
const intern = (p, ...teile) => join(root, p, '.intern', ...teile);
const lies = async (p, id) => JSON.parse(await fs.readFile(intern(p, 'journal', id + '.json'), 'utf8'));
const existiert = (f) => fs.stat(f).then(() => true, () => false);
async function gestaged(s, p, b = Buffer.from('bytes-' + p)) { return s.stage(adresse(p), [b], { groesse: b.length, sha256: sha(b) }); }
/** Simuliert einen Abbruch nach dem Lock-Erwerb: Journal staged (+ optional Besitzer) und Sperrdatei mit der Operations-ID. */
async function verwaist(p, stage, besitzer) {
  const j = await lies(p, stage.id);
  if (besitzer === undefined) delete j.besitzer; else j.besitzer = besitzer;
  await fs.writeFile(intern(p, 'journal', stage.id + '.json'), JSON.stringify(j));
  await fs.mkdir(intern(p, 'locks'), { recursive: true });
  await fs.writeFile(intern(p, 'locks', 'publish'), stage.id);
}
const fremd = (leaseMs) => ({ prozess: randomUUID(), pid: 99999, host: 'anderer', seit: new Date().toISOString(), lease_bis: new Date(Date.now() + leaseMs).toISOString(), auftrag: { art: 'upload', id: randomUUID() } });

test('1 publish: Besitzer vor dem Lock im Journal, Sperre danach frei', async () => {
  const s = new S.AssetSpeicher({ konfiguration: cfg }), p = projekt(), st = await gestaged(s, p);
  await s.publish(st, { basisSha256: null, besitzer: { art: 'upload', id: 'sitzung-1' }, prepare: async () => {}, commit: async () => {} });
  const j = await lies(p, st.id);
  assert.equal(j.status, 'committed');
  assert.equal(j.besitzer.prozess, S.ASSET_SPEICHER_PROZESS);
  assert.deepEqual(j.besitzer.auftrag, { art: 'upload', id: 'sitzung-1' });
  assert.ok(Date.parse(j.besitzer.lease_bis) > Date.parse(j.besitzer.seit));
  assert.deepEqual(await s.publishSperre(adresse(p)), { zustand: 'frei' });
});

test('2 Abbruch nach Lock-Erwerb vor Prepare: Lease, PG-Nachweis, Vorschau, Loesen', async () => {
  const s = new S.AssetSpeicher({ konfiguration: cfg }), p = projekt(), st = await gestaged(s, p);
  await verwaist(p, st, fremd(60_000));
  assert.equal((await s.publishSperre(adresse(p), { istVerwaist: async () => true })).zustand, 'lease_laeuft');
  await verwaist(p, st, fremd(-1000));
  assert.equal((await s.publishSperre(adresse(p), { istVerwaist: async () => false })).zustand, 'pg_aktiv');
  assert.equal((await s.publishSperre(adresse(p))).zustand, 'pg_unbestaetigt');
  const v = await s.publishSperre(adresse(p), { vorschau: true, istVerwaist: async () => true });
  assert.equal(v.zustand, 'loesbar');
  assert.equal(v.owner, st.id);
  assert.equal(v.logischer_pfad, 'bilder/a.png');
  assert.ok(await existiert(intern(p, 'locks', 'publish')), 'Vorschau aendert nichts');
  const r = await s.publishSperre(adresse(p), { istVerwaist: async () => true });
  assert.equal(r.zustand, 'geloest');
  assert.equal(await existiert(intern(p, 'locks', 'publish')), false);
  const j = await lies(p, st.id);
  assert.equal(j.status, 'failed');
  assert.equal(j.recovery.grund, 'besitzer_verwaist');
  assert.equal(await existiert(intern(p, 'staging', st.id + '.part')), false);
  // Danach veroeffentlicht ein neuer Versuch wieder normal.
  const neu = await gestaged(s, p);
  await s.publish(neu, { basisSha256: null, prepare: async () => {}, commit: async () => {} });
  assert.equal((await lies(p, neu.id)).status, 'committed');
});

test('3 Lebender Besitzer im selben Prozess bleibt unberuehrt; prepared gehoert zur bestehenden Recovery', async () => {
  const s = new S.AssetSpeicher({ konfiguration: cfg }), p = projekt(), st = await gestaged(s, p);
  let weiter; const halt = new Promise((r) => { weiter = r; });
  const lauf = s.publish(st, { basisSha256: null, prepare: () => halt, commit: async () => {} });
  for (let i = 0; i < 200 && !(await existiert(intern(p, 'locks', 'publish'))); i++) await new Promise((r) => setTimeout(r, 5));
  const andere = new S.AssetSpeicher({ konfiguration: cfg }); // eigene Instanz, gleicher Prozess (wie Recovery-Schleife)
  assert.equal((await andere.publishSperre(adresse(p), { istVerwaist: async () => true })).zustand, 'aktiv');
  weiter(); await lauf;
  assert.equal((await andere.publishSperre(adresse(p))).zustand, 'frei');
  const st2 = await gestaged(s, p);
  await assert.rejects(s.publish(st2, { basisSha256: sha(Buffer.from('bytes-' + p)), prepare: async () => { throw new Error('PG weg'); }, commit: async () => {} }));
  assert.equal((await andere.publishSperre(adresse(p), { istVerwaist: async () => true })).zustand, 'andere_recovery');
});

test('4 Alt-Sperre ohne Besitzerangabe: nie automatisch, nur mit ausdruecklicher Freigabe', async () => {
  const s = new S.AssetSpeicher({ konfiguration: cfg }), p = projekt(), st = await gestaged(s, p);
  await verwaist(p, st, undefined);
  const a = await s.publishSperre(adresse(p), { istVerwaist: async () => true });
  assert.equal(a.zustand, 'verwaist_unbewiesen');
  assert.equal(a.besitzer, null);
  assert.ok(await existiert(intern(p, 'locks', 'publish')));
  // Automatische Schleife (pruefePublishSperre ohne ohneBesitzerNachweis) loest sie ebenfalls nicht.
  const db = { query: async () => ({ rows: [] }) };
  assert.equal((await R.pruefePublishSperre(p, { db, konfiguration: cfg, speicher: s, ausfuehren: true })).zustand, 'verwaist_unbewiesen');
  const f = await R.pruefePublishSperre(p, { db, konfiguration: cfg, speicher: s, ausfuehren: true, ohneBesitzerNachweis: true });
  assert.equal(f.zustand, 'geloest');
  assert.equal((await lies(p, st.id)).recovery.grund, 'freigabe_ohne_besitzernachweis');
});

test('5 verwerfeStaging: gescheiterter Versuch hinterlaesst kein Staging; gehaltene Sperre bleibt', async () => {
  const s = new S.AssetSpeicher({ konfiguration: cfg }), p = projekt(), st = await gestaged(s, p);
  assert.ok(await existiert(intern(p, 'staging', st.id + '.part')));
  assert.equal(await s.verwerfeStaging(st), true);
  assert.equal(await existiert(intern(p, 'staging', st.id + '.part')), false);
  assert.equal((await lies(p, st.id)).status, 'failed');
  assert.equal(await s.verwerfeStaging(st), false, 'idempotent');
  const st2 = await gestaged(s, p);
  await verwaist(p, st2, fremd(-1000));
  assert.equal(await s.verwerfeStaging(st2), false, 'Sperre der Operation -> nur publishSperre');
});

test('6 publishOperationVerwaist: PG kennt Operation oder Finalisierung laeuft -> nicht verwaist', async () => {
  const op = { id: randomUUID(), adresse: adresse('p206x'), besitzer: fremd(-1) };
  const db = (bekannt, aktiv) => ({ query: async (sql) => ({ rows: /publish_operation->>'id'/.test(sql) ? (bekannt ? [{}] : []) : (aktiv ? [{}] : []) }) });
  assert.equal(await R.publishOperationVerwaist(db(true, false), 'p206x', op), false);
  assert.equal(await R.publishOperationVerwaist(db(false, true), 'p206x', op), false);
  assert.equal(await R.publishOperationVerwaist(db(false, false), 'p206x', op), true);
  assert.equal(R.ASSET_PUBLISH_RECOVERY, 'asset_publish_recovery');
});
