/**
 * P22-T237 (USER-GRUNDSATZ 31.10.2026, thought 4d6e67d6 Grundsatz 2): Projekt-Asset kommt in den Share, waehrend kein Daemon
 * laeuft -> bleibt im Share, sichtbar; Daemon wieder online -> Projektordner. Diese Datei prueft die API-Seite
 * (core services/asset-pc-zustellung.ts, db/asset-pc-zustellung-schema.ts, schema-sql/170, agent-profil-schalter.ts):
 *  A  bewertePcZustellung ohne DB: alle Status (nicht_im_share, richtung_ohne_pc, asset_sync_aus, kein_pc, unterwegs,
 *     auf_pc, wartet_auf_daemon), mehrere Hosts, letzter Fehler im Hinweis.
 *  B  Produkt-Schalter asset_pc_zustellung im Katalog, nur ausdruecklich, Standard AUS; Schema-Spiegel == SQL-Datei.
 *  C  Fake-DB: meldeAssetPcStand (Schalter AUS speichert nicht, Validierung, Upsert), assetPcZustellung (Daemon lange offline mit
 *     mehreren Assets, danach bestaetigt; Asset-Sync AUS laut Heartbeat; Asset nur lokal), pcZustellungFuerAsset bei AUS = null.
 *  D  synapse_test:5433 (nur wenn DATABASE_URL gesetzt): privates Schema, Spiegel 2x idempotent, echter Upsert + Bewertung.
 * Herkunft: Task P22-T237 (Plan P22), Bestand P13-T4/T26/T28; Fall 'Projekt mit Asset-Sync AUS -> klare Meldung' aus der Abnahme.
 * Aufruf: mise exec node@25 -- node --test packages/core/tests/asset-pc-zustellung-p22-t237.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const Z = await import('../dist/services/asset-pc-zustellung.js');
const S = await import('../dist/services/agent-profil-schalter.js');
const { ASSET_PC_ZUSTELLUNG_SCHEMA_SQL } = await import('../dist/db/asset-pc-zustellung-schema.js');
const { ladeAssetKonfiguration } = await import('../dist/config/asset-konfig.js');

const root = await fs.mkdtemp(join(tmpdir(), 'p22-t237-'));
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
const cfg = ladeAssetKonfiguration({ SYNAPSE_ASSET_ENABLED: '1', SYNAPSE_PROJEKTE_ROOT: root });
const AN = { aktiv: true, quelle: 'produkt-schalter', ebene: 'projekt', bis: null, letzter_fehler: null };
const AUS = { aktiv: false, quelle: 'standard', ebene: null, bis: null, letzter_fehler: null };
const JETZT = Date.parse('2026-10-31T17:00:00Z');
const vor = (ms) => new Date(JETZT - ms).toISOString();
const basis = (x = {}) => ({ project: 'p237', richtung: 'both', ziel_stand: 5n, hosts: [], heartbeat: null, frisch_ms: 130_000, scan_ms: 60_000, jetzt: JETZT, ...x });
const host = (stand, alter = 1000, extra = {}) => ({ host_id: 'daemon:pc', stand: String(stand), offene_downloads: 0, letzter_fehler: null, gemeldet_at: vor(alter), ...extra });

// ---------- A: reine Bewertung ----------
test('A1 Asset ohne Share-Aenderung (legacy_local) -> nicht_im_share, keine Uebertragung behauptet', () => {
  const r = Z.bewertePcZustellung(basis({ ziel_stand: null }));
  assert.equal(r.status, 'nicht_im_share');
  assert.match(r.hinweis, /nicht im Share/);
});
test('A2 Richtung pc_to_share -> richtung_ohne_pc mit Grund', () => {
  const r = Z.bewertePcZustellung(basis({ richtung: 'pc_to_share', hosts: [host(1)] }));
  assert.equal(r.status, 'richtung_ohne_pc');
  assert.match(r.hinweis, /pc_to_share/);
});
test('A3 Daemon online, Tray-Schalter Asset-Sync AUS -> asset_sync_aus statt stillem Liegenbleiben', () => {
  const r = Z.bewertePcZustellung(basis({ heartbeat: { hostname: 'cachy', online: true, last_seen: vor(5000), asset_sync_aktiv: false }, hosts: [host(1, 9_999_999)] }));
  assert.equal(r.status, 'asset_sync_aus');
  assert.match(r.hinweis, /Asset-Sync ist für Projekt p237 im Tray AUS/);
  assert.match(r.hinweis, /bleibt im Projekt-Share \(sichtbar und öffenbar\)/);
});
test('A4 Nie ein PC gemeldet -> kein_pc; Daemon ohne Angabe wird benannt', () => {
  assert.equal(Z.bewertePcZustellung(basis()).status, 'kein_pc');
  const r = Z.bewertePcZustellung(basis({ heartbeat: { hostname: 'cachy', online: true, last_seen: vor(1000), asset_sync_aktiv: null } }));
  assert.equal(r.status, 'kein_pc');
  assert.match(r.hinweis, /älterer Daemon oder Asset-Sync AUS/);
});
test('A5 Daemon online mit Asset-Sync AN, erste Meldung fehlt noch -> unterwegs', () => {
  const r = Z.bewertePcZustellung(basis({ heartbeat: { hostname: 'cachy', online: true, last_seen: vor(1000), asset_sync_aktiv: true } }));
  assert.equal(r.status, 'unterwegs');
});
test('A6 Bestaetigter Stand >= Aenderung -> auf_pc (bester von mehreren Hosts)', () => {
  const r = Z.bewertePcZustellung(basis({ hosts: [host(3, 10, { host_id: 'daemon:alt' }), host(5, 9_999_999)] }));
  assert.equal(r.status, 'auf_pc');
  assert.equal(r.host, 'daemon:pc');
});
test('A7 Stand < Aenderung, Meldung frisch -> unterwegs mit offenen Downloads und letztem Fehler', () => {
  const r = Z.bewertePcZustellung(basis({ hosts: [host(4, 10_000, { offene_downloads: 2, letzter_fehler: 'hash_falsch' })] }));
  assert.equal(r.status, 'unterwegs');
  assert.match(r.hinweis, /2 Download\(s\) offen/);
  assert.match(r.hinweis, /hash_falsch/);
});
test('A8 Daemon laengere Zeit offline (Meldung alt, kein Heartbeat) -> wartet_auf_daemon, Uebertragung automatisch', () => {
  const r = Z.bewertePcZustellung(basis({ hosts: [host(4, 3 * 3600_000)] }));
  assert.equal(r.status, 'wartet_auf_daemon');
  assert.match(r.hinweis, /sobald der Daemon wieder läuft/);
});

// ---------- B: Schalter + Schema ----------
test('B1 Produkt-Schalter asset_pc_zustellung: im Katalog, nur ausdruecklich, Standard AUS', () => {
  assert.ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('asset_pc_zustellung'));
  assert.ok(S.NUR_AUSDRUECKLICH.includes('asset_pc_zustellung'));
  assert.ok(!S.STANDARD_EIN.includes('asset_pc_zustellung'));
  assert.equal(Z.ASSET_PC_ZUSTELLUNG, 'asset_pc_zustellung');
});
test('B2 Laufzeit-Spiegel enthaelt dieselben Anweisungen wie schema-sql/170', async () => {
  const sql = await fs.readFile(new URL('../src/db/schema-sql/170_asset_pc_zustellung.sql', import.meta.url), 'utf8');
  const anweisungen = (t) => t.split('\n').map((z) => z.trim()).filter((z) => z && !z.startsWith('--'));
  assert.deepEqual(anweisungen(ASSET_PC_ZUSTELLUNG_SCHEMA_SQL), anweisungen(sql));
  for (const z of anweisungen(sql)) assert.match(z, /IF NOT EXISTS/, 'additiv/idempotent: ' + z);
});

// ---------- C: Fake-DB ----------
function fakeDb(state) {
  const calls = [];
  return {
    calls,
    async query(sql, v = []) {
      calls.push({ sql, v });
      if (/FROM asset_projekt_optionen/.test(sql)) return { rows: state.richtung ? [{ richtung: state.richtung }] : [] };
      if (/INSERT INTO asset_host_checkpoints/.test(sql)) {
        state.hosts = state.hosts.filter((h) => h.host_id !== v[0]);
        state.hosts.push({ host_id: v[0], stand: v[2], offene_downloads: v[3], letzter_fehler: v[4], updated_at: new Date(JETZT) });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM asset_host_checkpoints/.test(sql)) return { rows: [...state.hosts].sort((a, b) => Number(b.stand) - Number(a.stand)) };
      if (/FROM daemon_heartbeats/.test(sql)) return { rows: state.hb ? [state.hb] : [] };
      if (/FROM asset_aenderungsstaende/.test(sql)) return { rows: [{ stand: String(state.stand) }] };
      if (/FROM asset_aenderungen c\s+JOIN asset_files/.test(sql)) {
        const ab = Number(v[1]), offen = new Map();
        for (const c of state.changes) if (c.stand > ab) offen.set(c.asset_id, Math.max(offen.get(c.asset_id) ?? 0, c.stand));
        const rows = [...offen].sort((a, b) => a[1] - b[1]).map(([id, stand]) => ({ asset_id: id, file_path: state.files[id].file_path, stand: String(stand) }));
        return { rows: rows.slice(0, v[2]).map((r) => ({ ...r, gesamt: rows.length })) };
      }
      if (/FROM asset_files a WHERE a.project=\$1 AND a.id=\$2/.test(sql)) {
        const f = state.files[v[1]];
        if (!f) return { rows: [] };
        const s = state.changes.filter((c) => c.asset_id === v[1]).map((c) => c.stand);
        return { rows: [{ asset_id: v[1], file_path: f.file_path, storage_status: f.storage_status, deleted_at: f.deleted_at ?? null, stand: s.length ? String(Math.max(...s)) : null }] };
      }
      if (/UPDATE daemon_heartbeats SET asset_sync_aktiv/.test(sql)) { if (state.hb) state.hb.asset_sync_aktiv = v[2]; return { rows: [], rowCount: state.hb ? 1 : 0 }; }
      throw new Error('unerwartete Abfrage: ' + sql);
    },
  };
}
const neu = () => ({
  stand: 9, hosts: [], hb: null,
  files: { '11': { file_path: 'bilder/a.png', storage_status: 'ready' }, '12': { file_path: 'bilder/b.png', storage_status: 'ready' }, '13': { file_path: 'alt/lokal.png', storage_status: 'legacy_local' } },
  changes: [{ asset_id: '11', stand: 8 }, { asset_id: '12', stand: 9 }],
});
const ctx = { bereich: 'projekt', ziel_ref: 'p237', host_id: 'daemon:pc' };

test('C1 meldeAssetPcStand: Schalter AUS nimmt an, speichert aber nicht (Altverhalten)', async () => {
  const st = neu(), db = fakeDb(st);
  const r = await Z.meldeAssetPcStand(ctx, { stand: '9' }, { db, schalter: AUS });
  assert.equal(r.gespeichert, false);
  assert.equal(r.grund, 'schalter_aus');
  assert.equal(db.calls.length, 0);
});
test('C2 meldeAssetPcStand: Validierung (Zahltext, offene_downloads, Stand <= Projektstand)', async () => {
  const st = neu(), db = fakeDb(st);
  await assert.rejects(Z.meldeAssetPcStand(ctx, { stand: 's1' }, { db, schalter: AN }), (e) => e.code === 'eingang_ungueltig' && e.httpStatus === 400);
  await assert.rejects(Z.meldeAssetPcStand(ctx, { stand: '1', offene_downloads: -1 }, { db, schalter: AN }), (e) => e.code === 'eingang_ungueltig');
  await assert.rejects(Z.meldeAssetPcStand(ctx, { stand: '1', letzter_fehler: 7 }, { db, schalter: AN }), (e) => e.code === 'eingang_ungueltig');
  await assert.rejects(Z.meldeAssetPcStand(ctx, { stand: '10' }, { db, schalter: AN }), (e) => e.code === 'cursor_ungueltig' && e.httpStatus === 409);
  await assert.rejects(Z.meldeAssetPcStand({ ...ctx, bereich: 'reverse' }, { stand: '1' }, { db, schalter: AN }), (e) => e.code === 'scope_verboten');
});
test('C3 Daemon lange offline, mehrere Assets im Share -> wartet_auf_daemon mit Pfaden; nach Meldung auf_pc', async () => {
  const st = neu(); st.hosts = [{ host_id: 'daemon:pc', stand: '7', offene_downloads: 0, letzter_fehler: null, updated_at: new Date(JETZT - 6 * 3600_000) }];
  const db = fakeDb(st);
  let r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT });
  assert.equal(r.aktiv, true);
  assert.equal(r.status, 'wartet_auf_daemon');
  assert.equal(r.projekt_stand, '9');
  assert.equal(r.ausstehend.anzahl, 2);
  assert.deepEqual(r.ausstehend.pfade.map((p) => p.pfad), ['bilder/a.png', 'bilder/b.png']);
  let a = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT, asset_id: '12' });
  assert.equal(a.asset.status, 'wartet_auf_daemon');
  assert.equal(a.asset.stand, '9');
  // Daemon wieder online: Abgleich bestaetigt Stand 9 -> beide Assets im Projektordner.
  const m = await Z.meldeAssetPcStand(ctx, { stand: '9', offene_downloads: 0, letzter_fehler: null }, { db, schalter: AN });
  assert.equal(m.gespeichert, true);
  r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT });
  assert.equal(r.status, 'auf_pc');
  assert.equal(r.ausstehend.anzahl, 0);
  a = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT, asset_id: '11' });
  assert.equal(a.asset.status, 'auf_pc');
});
test('C4 Heartbeat meldet Asset-Sync AUS -> klare Meldung je Asset; Asset nur lokal -> nicht_im_share', async () => {
  const st = neu(); st.hb = { hostname: 'cachy', last_seen: new Date(JETZT), online: true, asset_sync_aktiv: true };
  const db = fakeDb(st);
  await Z.meldeAssetSyncImHeartbeat('p237', 'cachy', false, { db });
  const a = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT, asset_id: '11' });
  assert.equal(a.heartbeat.asset_sync_aktiv, false);
  assert.equal(a.asset.status, 'asset_sync_aus');
  const l = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT, asset_id: '13' });
  assert.equal(l.asset.status, 'nicht_im_share');
  await assert.rejects(Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, asset_id: '99' }), (e) => e.code === 'asset_fehlt');
  await assert.rejects(Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, asset_id: 'x' }), (e) => e.code === 'eingang_ungueltig');
});
test('C5 Schalter AUS: Status-Route liefert nur den Schalter, Kurzform null (keine Feldaenderung in Antworten)', async () => {
  const db = fakeDb(neu());
  const r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AUS });
  assert.deepEqual(r, { aktiv: false, schalter: AUS });
  assert.equal(await Z.pcZustellungFuerAsset('p237', '11', { db, konfiguration: cfg, schalter: AUS }), null);
  const an = await Z.pcZustellungFuerAsset('p237', '11', { db, konfiguration: cfg, schalter: AN, jetzt: JETZT });
  assert.equal(an.status, 'kein_pc');
  assert.equal(db.calls.filter((c) => /INSERT|UPDATE/.test(c.sql)).length, 0);
});

// ---------- D: synapse_test ----------
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const echteDb = url && url.port === '5433' && url.pathname === '/synapse_test';
test('D1 synapse_test: Spiegel 2x idempotent, Upsert und Bewertung gegen echtes PG', { skip: echteDb ? false : 'DATABASE_URL nicht synapse_test:5433' }, async () => {
  const pg = createRequire(new URL('../package.json', import.meta.url))('pg');
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const schema = 'p22_t237_' + randomUUID().replaceAll('-', '').slice(0, 12);
  try {
    assert.equal((await c.query('SELECT current_database() AS n')).rows[0].n, 'synapse_test');
    await c.query('CREATE SCHEMA ' + schema);
    await c.query('SET search_path TO ' + schema);
    await c.query(`CREATE TABLE asset_files(id BIGSERIAL PRIMARY KEY, project TEXT, file_path TEXT, storage_status TEXT, deleted_at TIMESTAMPTZ);
      CREATE TABLE asset_aenderungsstaende(project TEXT PRIMARY KEY, stand BIGINT NOT NULL DEFAULT 0);
      CREATE TABLE asset_aenderungen(id BIGSERIAL PRIMARY KEY, project TEXT, stand BIGINT, asset_id BIGINT, revision BIGINT, art TEXT, UNIQUE(project,stand));
      CREATE TABLE asset_host_checkpoints(host_id TEXT NOT NULL, project TEXT NOT NULL, stand BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(host_id,project));
      CREATE TABLE daemon_heartbeats(project TEXT PRIMARY KEY, hostname TEXT, daemon_pid INT, last_seen TIMESTAMPTZ);
      CREATE TABLE asset_projekt_optionen(project TEXT PRIMARY KEY, richtung TEXT);`);
    await c.query(ASSET_PC_ZUSTELLUNG_SCHEMA_SQL);
    await c.query(ASSET_PC_ZUSTELLUNG_SCHEMA_SQL);
    await c.query("INSERT INTO asset_files(project,file_path,storage_status) VALUES('p237','a.png','ready'),('p237','b.png','ready')");
    await c.query("INSERT INTO asset_aenderungsstaende VALUES('p237',2)");
    await c.query("INSERT INTO asset_aenderungen(project,stand,asset_id,revision,art) VALUES('p237',1,1,1,'upload'),('p237',2,2,1,'upload')");
    await c.query("INSERT INTO daemon_heartbeats VALUES('p237','cachy',1,NOW() - interval '1 hour')");
    const db = { query: (s, v) => c.query(s, v) };
    let r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN });
    assert.equal(r.status, 'kein_pc');
    assert.equal(r.heartbeat.online, false);
    assert.equal(r.ausstehend.anzahl, 2);
    await Z.meldeAssetPcStand(ctx, { stand: '1', offene_downloads: 1, letzter_fehler: '  zeit\nlimit ' }, { db, schalter: AN });
    const row = (await c.query("SELECT stand::text, offene_downloads, letzter_fehler FROM asset_host_checkpoints WHERE project='p237'")).rows[0];
    assert.deepEqual(row, { stand: '1', offene_downloads: 1, letzter_fehler: 'zeit limit' });
    r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, asset_id: '2' });
    assert.equal(r.asset.status, 'unterwegs'); // Meldung frisch (updated_at NOW())
    await c.query("UPDATE daemon_heartbeats SET last_seen=NOW()");
    await Z.meldeAssetSyncImHeartbeat('p237', 'cachy', false, { db });
    r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, asset_id: '2' });
    assert.equal(r.asset.status, 'asset_sync_aus');
    await Z.meldeAssetSyncImHeartbeat('p237', 'cachy', true, { db });
    await Z.meldeAssetPcStand(ctx, { stand: '2' }, { db, schalter: AN });
    r = await Z.assetPcZustellung('p237', { db, konfiguration: cfg, schalter: AN, asset_id: '2' });
    assert.equal(r.asset.status, 'auf_pc');
    assert.equal(r.ausstehend.anzahl, 0);
  } finally {
    await c.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await c.end();
  }
});
