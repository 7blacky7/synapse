/**
 * P27-T11: Altbestand in Warteschlangen ausblenden statt loeschen (User 01.11.2026 "nichts loeschen, nur nicht mehr anzeigen").
 * Prueft packages/core/src/services/warteschlangen-altbestand.ts (admin warteschlangen_aufraeumen), den Filter der Verlaufslisten in
 * user-inbox.ts / inbox.ts, den Katalog (agent-profil-schalter.ts, agent-profil-admin.ts) und den Schema-Spiegel 179:
 *   A Katalog + Schema-Spiegel; B vorschau (Kandidaten, Ausnahmen inkl. work_jobs nie, Gruppen); C ausfuehren: Schalter AUS -> funktion_aus,
 *   Bestaetigung Pflicht; D ausfuehren EIN: processed=true bzw. status fehler, nichts geloescht, Stau-Zaehlung ohne sie, Meine Inbox ohne sie;
 *   E wiederherstellen: exakt der vorherige Zustand; F Schwelle als PG-Einstellung; G Rechte (ohne Akteur recht_fehlt).
 * Nur synapse_test:5433, privates Schema (Tabellen LIKE public + Schema 179 aus dist), feste IDs (keine Sequenzen aus public).
 *   DATABASE_URL=postgres://...:5433/synapse_test node --test packages/core/tests/warteschlangen-altbestand-p27-t11.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433', 'P27-T11 Testziel Port 5433'); assert.equal(url.pathname, '/synapse_test', 'P27-T11 Testziel synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', SYNAPSE_INTERN_TOOL: '0', QDRANT_URL: 'http://127.0.0.1:1', SYNAPSE_W1B_GATE_TTL_MS: '0' });
const schema = 'p27_t11_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = scoped.href;
const { Pool } = createRequire(new URL('../package.json', import.meta.url))('pg');
const raw = new Pool({ connectionString: url.href, max: 4, options: '-c search_path=' + schema + ',public' });
await raw.query('CREATE SCHEMA ' + schema);
for (const t of ['specialist_inbox', 'agent_zustellungen', 'agent_identitaeten', 'wrapper_status', 'agent_profil_schalter', 'intern_schalter', 'work_jobs']) {
  await raw.query('CREATE TABLE ' + schema + '.' + t + ' (LIKE public.' + t + ' INCLUDING ALL)');
}
const { WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL, WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL } = await import('../dist/db/warteschlangen-altbestand-schema.js');
await raw.query(WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL); await raw.query(WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL); // P27-T10: Schema 180
const W = await import('../dist/services/warteschlangen-altbestand.js');
const S = await import('../dist/services/agent-profil-schalter.js');
const A = await import('../dist/services/agent-profil-admin.js');
const U = await import('../dist/services/user-inbox.js');
const lies = (p) => readFile(new URL('../../../' + p, import.meta.url), 'utf8');

/** Zeile mit allen Pflichtspalten (NOT NULL ohne Standard) - Werte aus v, sonst neutrale Fixture-Werte. */
async function zeile(tabelle, v) {
  const cols = (await raw.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND ((is_nullable='NO' AND column_default IS NULL AND is_identity='NO') OR column_name = ANY($3::text[]))",
    [schema, tabelle, Object.keys(v)])).rows;
  const werte = cols.map((c) => Object.hasOwn(v, c.column_name) ? v[c.column_name] : c.data_type === 'boolean' ? false : /int|numeric/.test(c.data_type) ? 0 : /json/.test(c.data_type) ? '{}' : /time/.test(c.data_type) ? new Date() : c.data_type === 'ARRAY' ? [] : 'fixture');
  await raw.query('INSERT INTO ' + tabelle + '(' + cols.map((c) => '"' + c.column_name + '"').join(',') + ') VALUES(' + werte.map((_, i) => '$' + (i + 1)).join(',') + ')', werte);
}
const P = 'p27t11', tag = 86_400_000, alt = new Date(Date.now() - 10 * tag), jung = new Date(Date.now() - 1 * tag);
const inbox = (id, to, created, processed = false) => zeile('specialist_inbox', { id, from_agent: 'koordinator', to_agent: to, content: 'Nachricht ' + id, processed, created_at: created, project: P });
const user = { art: 'user' };
const admin = (args) => W.fuehreWsAltbestandAdminAus('warteschlangen_aufraeumen', { project: P, ...args }, user);
const schalter = (funktion, aktiv) => S.setzeProfilProduktSchalter({ ebene: 'global', funktion, aktiv, grund: 'P27-T11 Test' }, { system: 'user' });

await inbox(9001, 'user', alt); await inbox(9002, 'user', jung); await inbox(9003, 'lebend', alt); await inbox(9004, 'weg-agent', alt); await inbox(9005, 'user', alt, true);
await zeile('wrapper_status', { agent_name: 'lebend', project: P, status: 'running' });
await zeile('agent_identitaeten', { id: 'p27-ident-1', name: 'test-ident', project: P, agent_id: 'test-ident', rolle: 'subagent', status: 'aktiv' });
await zeile('agent_zustellungen', { id: 8001, identity_id: 'p27-ident-1', weg: 'channel', message_id: 1, zustellung: '{}', status: 'pending', versuche: 1, letzter_grund: 'fehler', erstellt_am: alt });
await zeile('agent_zustellungen', { id: 8002, identity_id: 'p27-ident-1', weg: 'channel', message_id: 2, zustellung: '{}', status: 'zugestellt', erstellt_am: alt });
await zeile('work_jobs', { id: randomUUID(), kind: 'reverse-leser', capability: 'reverse_leser', project: P, scope: 'reverse', state: 'pending', priority: 'nachzug', idempotency_key: 'p27t11:' + randomUUID(), created_at: alt }).catch((e) => console.log('# work_jobs-Fixture: ' + e.message));

test.after(async () => { await raw.query('DROP SCHEMA ' + schema + ' CASCADE'); await raw.end(); });

test('A P27-T11 Katalog und Schema-Spiegel 179', async () => {
  assert.ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('warteschlangen_altbestand') && S.NUR_AUSDRUECKLICH.includes('warteschlangen_altbestand') && !S.STANDARD_EIN.includes('warteschlangen_altbestand'), 'Schalter im Katalog, nur ausdruecklich, Standard AUS');
  assert.ok(A.W1B_ADMIN_ACTIONS.includes('warteschlangen_aufraeumen') && A.W1B_ADMIN_PARAMETER.warteschlange, 'admin-Aktion und Parameter eingehaengt');
  const sql = await lies('packages/core/src/db/schema-sql/179_warteschlangen_altbestand.sql');
  assert.equal(WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL.trim(), sql.trim(), 'TS-Spiegel = SQL-Datei');
  assert.ok((await lies('packages/core/src/db/schema.ts')).includes('${WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL}'), 'schema.ts fuehrt 179 aus');
});

let vorschau;
test('B P27-T11 vorschau: alte Eintraege ohne lebenden Empfaenger, Ausnahmen, work_jobs nie', async () => {
  vorschau = await admin({ aufraeumen_modus: 'vorschau' });
  assert.equal(vorschau.success, true, JSON.stringify(vorschau));
  const ids = vorschau.beispiele.map((b) => b.warteschlange + ':' + b.id).sort();
  assert.deepEqual(ids, ['specialist_inbox:9001', 'specialist_inbox:9004', 'zustellungen:8001'], 'nur alt + Empfaenger ohne Wrapper + offen');
  assert.equal(vorschau.anzahl.gesamt, 3);
  assert.equal(vorschau.ausgenommen.juenger_als_schwelle.specialist_inbox, 1, '9002 juenger');
  assert.equal(vorschau.ausgenommen.empfaenger_aktiv.specialist_inbox, 1, '9003 Wrapper lebt');
  assert.equal(vorschau.ausgenommen.work_jobs.nie_ausgeblendet, true);
  assert.ok(vorschau.gruppen.some((g) => g.empfaenger === 'user' && g.anzahl === 1 && g.absender?.includes('koordinator') && g.alter_tage >= 9), JSON.stringify(vorschau.gruppen));
  assert.equal(vorschau.schalter.aktiv, false); assert.equal(vorschau.schwelle.quelle, 'standard'); assert.equal(vorschau.tage, 7);
  assert.match(vorschau.bestaetigung, /^[0-9a-f]{16}$/);
});

test('C P27-T11 ausfuehren: Schalter AUS -> funktion_aus, nichts geaendert; Bestaetigung Pflicht', async () => {
  const r = await admin({ aufraeumen_modus: 'ausfuehren', aufraeumen_bestaetigung: vorschau.bestaetigung });
  assert.equal(r.error, 'funktion_aus', JSON.stringify(r));
  assert.equal((await raw.query('SELECT processed FROM specialist_inbox WHERE id=9001')).rows[0].processed, false);
  await schalter('warteschlangen_altbestand', true); W.leereWsAltbestandCache();
  assert.equal((await admin({ aufraeumen_modus: 'ausfuehren' })).error, 'bestaetigung_fehlt');
  assert.equal((await admin({ aufraeumen_modus: 'ausfuehren', aufraeumen_bestaetigung: '0000000000000000' })).error, 'vorschau_veraltet');
});

let lauf;
test('D P27-T11 ausfuehren EIN: ausgeblendet, nichts geloescht, Stau und Meine Inbox ohne sie', async () => {
  const vorher = Number((await raw.query('SELECT count(*) FROM specialist_inbox')).rows[0].count);
  const r = await admin({ aufraeumen_modus: 'ausfuehren', aufraeumen_bestaetigung: vorschau.bestaetigung, grund: 'P27-T11 Test Altbestand' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(r.ausgeblendet, { specialist_inbox: 2, zustellungen: 1, gesamt: 3 });
  lauf = r.lauf_id;
  assert.equal(Number((await raw.query('SELECT count(*) FROM specialist_inbox')).rows[0].count), vorher, 'nichts geloescht');
  const z = (await raw.query('SELECT status, letzter_grund FROM agent_zustellungen WHERE id=8001')).rows[0];
  assert.deepEqual([z.status, z.letzter_grund], ['ausgeblendet', 'fehler'], 'eigener Status, sonst unveraendert (Koordinator 34681)');
  // Stau-Waechter-Kohorten (warteschlangen-adapter.ts): offen = processed IS NOT TRUE bzw. status='pending'.
  assert.deepEqual((await raw.query("SELECT array_agg(id ORDER BY id) AS ids FROM specialist_inbox WHERE processed IS NOT TRUE")).rows[0].ids, [9002, 9003]);
  assert.equal(Number((await raw.query("SELECT count(*) FROM agent_zustellungen WHERE status='pending'")).rows[0].count), 0);
  const m = (await raw.query('SELECT warteschlange, eintrag_id::int, vorher, ausgeblendet_von, ausgeblendet_grund, schwelle_tage FROM warteschlangen_ausblendungen WHERE lauf_id=$1 ORDER BY 1, 2', [lauf])).rows;
  assert.deepEqual(m.map((x) => x.warteschlange + ':' + x.eintrag_id), ['specialist_inbox:9001', 'specialist_inbox:9004', 'zustellungen:8001']);
  assert.deepEqual(m[2].vorher.status, 'pending'); assert.equal(m[2].vorher.letzter_grund, 'fehler'); assert.equal(m[0].vorher.processed, false);
  assert.equal(m[0].ausgeblendet_von, 'user'); assert.equal(m[0].schwelle_tage, 7);
  // Meine Inbox (user-inbox.ts): ausgeblendete erscheinen weder in der Liste noch in gesamt.
  await schalter('user_inbox', true);
  const ui = await U.leseUserInbox({});
  const sichtbar = ui.nachrichten.map((n) => Number(n.id)).sort();
  assert.ok(!sichtbar.includes(9001) && sichtbar.includes(9002) && sichtbar.includes(9005), 'Liste ohne 9001: ' + JSON.stringify(sichtbar));
  assert.equal(ui.gesamt, 2, 'gesamt ohne ausgeblendete (9002, 9005)');
  assert.equal((await admin({ aufraeumen_modus: 'vorschau' })).anzahl.gesamt, 0, 'zweite Vorschau leer');
  const st = await admin({ aufraeumen_modus: 'status' });
  assert.deepEqual(st.offene_ausblendungen, [{ warteschlange: 'specialist_inbox', anzahl: 2 }, { warteschlange: 'zustellungen', anzahl: 1 }]);
  assert.equal(st.letzte_laeufe[0].lauf_id, lauf);
});

test('E P27-T11 wiederherstellen: exakt der vorherige Zustand, Markierungen geschlossen', async () => {
  assert.equal((await admin({ aufraeumen_modus: 'wiederherstellen', aufraeumen_lauf_id: lauf })).error, 'grund_fehlt');
  assert.equal((await admin({ aufraeumen_modus: 'wiederherstellen', grund: 'P27-T11 ohne Auswahl' })).error, 'auswahl_fehlt');
  const r = await admin({ aufraeumen_modus: 'wiederherstellen', aufraeumen_lauf_id: lauf, grund: 'P27-T11 Test Rueckweg' });
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(r.wiederhergestellt, 3); assert.deepEqual(r.geaendert, []);
  assert.equal((await raw.query('SELECT processed FROM specialist_inbox WHERE id=9001')).rows[0].processed, false);
  const z = (await raw.query('SELECT status, letzter_grund FROM agent_zustellungen WHERE id=8001')).rows[0];
  assert.deepEqual([z.status, z.letzter_grund], ['pending', 'fehler']);
  assert.equal(Number((await raw.query('SELECT count(*) FROM warteschlangen_ausblendungen WHERE wiederhergestellt_am IS NULL')).rows[0].count), 0);
  assert.equal((await admin({ aufraeumen_modus: 'vorschau' })).anzahl.gesamt, 3, 'wieder Kandidaten');
});

test('F P27-T11 Schwelle als PG-Einstellung', async () => {
  assert.equal((await admin({ aufraeumen_modus: 'einstellen', aufraeumen_tage: 0, grund: 'P27-T11 ungueltig' })).error, 'tage_ungueltig');
  const s = await admin({ aufraeumen_modus: 'einstellen', aufraeumen_tage: 30, grund: 'P27-T11 Test Schwelle' });
  assert.deepEqual([s.success, s.schwelle.tage, s.schwelle.quelle], [true, 30, 'einstellung']);
  const v = await admin({ aufraeumen_modus: 'vorschau' });
  assert.deepEqual([v.tage, v.anzahl.gesamt], [30, 0], '10 Tage alt < 30 Tage Schwelle');
  assert.equal((await admin({ aufraeumen_modus: 'vorschau', aufraeumen_tage: 5, warteschlange: 'zustellungen' })).anzahl.gesamt, 1, 'Parameter schlaegt Einstellung, Filter Warteschlange');
  assert.equal((await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'work_jobs' })).error, 'warteschlange_unbekannt');
});

test('G P27-T11 Rechte und Einhaengen im admin-Dispatcher', async () => {
  assert.equal((await W.fuehreWsAltbestandAdminAus('warteschlangen_aufraeumen', { project: P }, null)).error, 'recht_fehlt');
  const quelle = await lies('packages/core/src/services/agent-profil-admin.ts');
  assert.ok(quelle.includes('if (istWsAltbestandAdminAction(action)) return fuehreWsAltbestandAdminAus(action, args, akteur ?? legacyKoordinatorAus(args));'), 'Dispatcher haengt die Aktion ein');
});
