/**
 * P27-T10: admin warteschlangen_aufraeumen kennt coedit_waits (User 06.11.2026: Alt-Waits nicht mehr anzeigen, nichts loeschen).
 * Prueft packages/core/src/services/warteschlangen-altbestand.ts (Kandidaten = Stau-Definition coedit_waits + Schwelle ab expires_at), den
 * gemeinsamen Schliessweg packages/core/src/services/coedit-wait-schliessen.ts (aus intern waits_tot) und Schema 180:
 *   A Schema-Spiegel 180 (idempotent), schema.ts, CHECK, Parameter-Enum, Definition wortgleich mit dem Stau-Waechter;
 *   B vorschau (je Projekt/Status, Ausnahmen jung/nicht abgelaufen, Lauf ohne warteschlange ohne Waits, aufraeumen_ids, Schwelle);
 *   C Schalter AUS -> funktion_aus, nichts geaendert;
 *   D ausfuehren: Waits closed, leerer Traeger cancelled, Traeger mit Op bleibt offen, nichts geloescht, vorher vollstaendig,
 *     Stau-Waechter zaehlt sie nicht mehr, junge/nicht abgelaufene/geschlossene/fremde Waits unberuehrt;
 *   E wiederherstellen per Lauf: Status, updated_at und Traeger exakt zurueck, Stau wieder wie vorher;
 *   F gezielt per Wait-Token aus- und wieder einblenden (eintrag_uuid, zweite Markierung nach Rueckweg);
 *   G specialist_inbox mit aufraeumen_ausnahmen_einschliessen: nur mit ids und warteschlange specialist_inbox, benannte Eintraege mit
 *     lebendem Wrapper / juenger als die Schwelle raeumbar, Nicht-Benannte unberuehrt, eigene Bestaetigung, Rueckweg wiederherstellen.
 * Nur synapse_test:5433, privates Schema (Tabellen LIKE public + Schema 179/180 aus dist), feste IDs (keine Sequenzen aus public).
 *   DATABASE_URL=postgres://...:5433/synapse_test node --test packages/core/tests/warteschlangen-altbestand-coedit-p27-t10.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433', 'P27-T10 Testziel Port 5433'); assert.equal(url.pathname, '/synapse_test', 'P27-T10 Testziel synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env, { SYNAPSE_SKIP_EMBEDDINGS: '1', SYNAPSE_INTERN_TOOL: '0', QDRANT_URL: 'http://127.0.0.1:1', SYNAPSE_W1B_GATE_TTL_MS: '0' });
const schema = 'p27_t10_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = scoped.href;
const { Pool } = createRequire(new URL('../package.json', import.meta.url))('pg');
const raw = new Pool({ connectionString: url.href, max: 4, options: '-c search_path=' + schema + ',public' });
await raw.query('CREATE SCHEMA ' + schema);
for (const t of ['file_batch_waits', 'file_batch_plans', 'specialist_inbox', 'agent_zustellungen', 'agent_identitaeten', 'wrapper_status', 'agent_profil_schalter', 'intern_schalter', 'work_jobs']) {
  await raw.query('CREATE TABLE ' + schema + '.' + t + ' (LIKE public.' + t + ' INCLUDING ALL)');
}
const SCH = await import('../dist/db/warteschlangen-altbestand-schema.js');
await raw.query(SCH.WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL);
await raw.query(SCH.WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL);
await raw.query(SCH.WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL); // zweimal: idempotent
const W = await import('../dist/services/warteschlangen-altbestand.js');
const S = await import('../dist/services/agent-profil-schalter.js');
const AD = await import('../dist/services/warteschlangen-adapter.js').catch((e) => { console.log('# warteschlangen-adapter nicht ladbar, Stau per SQL: ' + e.message); return null; });
const lies = (p) => readFile(new URL('../../../' + p, import.meta.url), 'utf8');

/** Zeile mit allen Pflichtspalten (NOT NULL ohne Standard) - Werte aus v, sonst neutrale Fixture-Werte. */
async function zeile(tabelle, v) {
  const cols = (await raw.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND ((is_nullable='NO' AND column_default IS NULL AND is_identity='NO') OR column_name = ANY($3::text[]))",
    [schema, tabelle, Object.keys(v)])).rows;
  const werte = cols.map((c) => Object.hasOwn(v, c.column_name) ? v[c.column_name] : c.data_type === 'boolean' ? false : /int|numeric/.test(c.data_type) ? 0 : /json/.test(c.data_type) ? '{}' : /time/.test(c.data_type) ? new Date() : c.data_type === 'ARRAY' ? [] : 'fixture');
  await raw.query('INSERT INTO ' + tabelle + '(' + cols.map((c) => '"' + c.column_name + '"').join(',') + ') VALUES(' + werte.map((_, i) => '$' + (i + 1)).join(',') + ')', werte);
}
const P = 'p27t10', ANDERS = 'p27t10-anders', tag = 86_400_000;
const vor = (tage) => new Date(Date.now() - tage * tag);
const T = { w1: randomUUID(), w2: randomUUID(), w3: randomUUID(), w4: randomUUID(), w5: randomUUID(), w6: randomUUID() };
const OPS1 = [{ file_path: 'src/a.ts', action: 'search_replace', search: 'alt', replace: 'neu', agent_id: 'alt-agent-a' }];
const OPS2 = [{ file_path: 'src/b.ts', action: 'insert_after', after_line: 3, content: '// b', agent_id: 'alt-agent-b' }];
const plan = (id, project, ops, reason) => zeile('file_batch_plans', { id, project, owner_agent_id: 'alt-agent', ops: JSON.stringify(ops), expected_hashes: '{}', previews: '[]', status: 'open', reason });
const wait = (token, plan_id, project, status, ablaufTage, ops, waiting_agent) => zeile('file_batch_waits', {
  wait_token: token, source_plan_id: plan_id, project, waiting_agent, primary_agent: 'alt-primaer', shared_files: ops.map((o) => o.file_path),
  deferred_ops: JSON.stringify(ops), deferred_op_indexes: ops.map((_, i) => i), status, expires_at: vor(ablaufTage), created_at: vor(ablaufTage + 2), updated_at: vor(ablaufTage) });
await plan(7101, P, [], 'Traeger W1'); await plan(7102, P, [{ file_path: 'src/x.ts', action: 'create', content: 'x' }], 'Traeger W2 mit Op');
await plan(7103, P, [], 'Traeger W3'); await plan(7104, P, [], 'Traeger W4'); await plan(7105, P, [], 'Traeger W5'); await plan(7106, ANDERS, [], 'Traeger W6');
await wait(T.w1, 7101, P, 'ready', 10, OPS1, 'alt-agent-a');      // Kandidat, Traeger danach leer -> cancelled
await wait(T.w2, 7102, P, 'waiting', 20, OPS2, 'alt-agent-b');    // Kandidat, Traeger hat eine Op -> bleibt offen
await wait(T.w3, 7103, P, 'no_changes', 2, OPS1, 'alt-agent-c');  // abgelaufen, juenger als Schwelle
await wait(T.w4, 7104, P, 'waiting', -1 / 24, OPS1, 'alt-agent-d'); // nicht abgelaufen (expires in 1 h)
await wait(T.w5, 7105, P, 'closed', 30, OPS1, 'alt-agent-e');     // schon geschlossen
await wait(T.w6, 7106, ANDERS, 'linked', 15, OPS1, 'alt-agent-f'); // anderes Projekt
// G: Inbox-Eintraege, die ohne Ausnahme-Flag immer ausgenommen sind (lebender Wrapper bzw. juenger als die Schwelle).
const inbox = (id, to, created) => zeile('specialist_inbox', { id, from_agent: 'koordinator', to_agent: to, content: 'Nachricht ' + id, processed: false, created_at: created, project: P });
await inbox(9101, 'lebend-agent', vor(10)); await inbox(9102, 'lebend-agent', vor(1)); await inbox(9103, 'weg-agent', vor(1)); await inbox(9104, 'anderer-lebend', vor(10));
await zeile('wrapper_status', { agent_name: 'lebend-agent', project: P, status: 'running' });
await zeile('wrapper_status', { agent_name: 'anderer-lebend', project: P, status: 'running' });

const user = { art: 'user' };
const admin = (args) => W.fuehreWsAltbestandAdminAus('warteschlangen_aufraeumen', { project: P, ...args }, user);
const schalter = (funktion, aktiv) => S.setzeProfilProduktSchalter({ ebene: 'global', funktion, aktiv, grund: 'P27-T10 Test' }, { system: 'user' });
const DEF = AD?.STAU_KOHORTEN?.find((d) => d.name === 'coedit_waits') ?? null;
/** Stau-Waechter-Sicht: faellige coedit_waits (alle Projekte) - ueber den echten Kohorten-Zustand, sonst dieselbe faellig-Bedingung per SQL. */
async function stau() {
  if (DEF) return (await AD.kohortenZustand(DEF)()).wartend;
  return Number((await raw.query('SELECT count(*) FROM file_batch_waits t WHERE ' + W.WS_ALTBESTAND_COEDIT_FAELLIG)).rows[0].count);
}
const waitZeile = async (token) => (await raw.query('SELECT status, updated_at::text AS u, deferred_ops, shared_files FROM file_batch_waits WHERE wait_token=$1', [token])).rows[0];
const planZeile = async (id) => (await raw.query('SELECT status::text AS status, reason, jsonb_array_length(ops)::int AS ops FROM file_batch_plans WHERE id=$1', [id])).rows[0];
const stand = {};
for (const k of Object.keys(T)) stand[k] = await waitZeile(T[k]);
const stauVorher = await stau();

test.after(async () => { await raw.query('DROP SCHEMA ' + schema + ' CASCADE'); await raw.end(); });

test('A P27-T10 Schema 180, Spiegel, CHECK, Parameter, Definition wie Stau-Waechter', async () => {
  const sql = await lies('packages/core/src/db/schema-sql/180_warteschlangen_altbestand_coedit.sql');
  assert.equal(SCH.WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL.trim(), sql.trim(), 'TS-Spiegel = SQL-Datei 180');
  const schemaTs = await lies('packages/core/src/db/schema.ts');
  assert.ok(schemaTs.indexOf('${WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL}') >= 0 && schemaTs.indexOf('${WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL}') > schemaTs.indexOf('${WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL}'), 'schema.ts fuehrt 180 nach 179 aus');
  assert.ok(W.WS_ALTBESTAND_ADMIN_PARAMETER.warteschlange.enum.includes('coedit_waits'), 'Parameter-Enum kennt coedit_waits');
  const adapter = await lies('packages/core/src/services/warteschlangen-adapter.ts');
  assert.ok(adapter.includes('faellig: "' + W.WS_ALTBESTAND_COEDIT_FAELLIG + '"'), 'faellig wortgleich mit STAU_KOHORTEN coedit_waits');
  if (DEF) assert.equal(DEF.faellig, W.WS_ALTBESTAND_COEDIT_FAELLIG);
  const checks = (await raw.query("SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = to_regclass('warteschlangen_ausblendungen') AND contype = 'c' ORDER BY 1")).rows;
  assert.equal(checks.filter((c) => c.d.includes('specialist_inbox')).length, 1, 'genau ein Warteschlangen-CHECK: ' + JSON.stringify(checks));
  assert.ok(checks.some((c) => c.d.includes('coedit_waits')));
  await assert.rejects(raw.query("INSERT INTO warteschlangen_ausblendungen(warteschlange, eintrag_id, vorher, ausgeblendet_von, ausgeblendet_grund, schwelle_tage, lauf_id) VALUES ('work_jobs', 1, '{}', 't', 't', 7, 'x')"), /check/i, 'work_jobs bleibt verboten');
  await assert.rejects(raw.query("INSERT INTO warteschlangen_ausblendungen(warteschlange, vorher, ausgeblendet_von, ausgeblendet_grund, schwelle_tage, lauf_id) VALUES ('coedit_waits', '{}', 't', 't', 7, 'x')"), /check/i, 'ohne Schluessel verboten');
  assert.equal(stauVorher, 4, 'Stau-Waechter vorher: W1, W2, W3, W6');
});

let vorschau;
test('B P27-T10 vorschau: genau die abgelaufenen, nicht geschlossenen Waits aelter als die Schwelle', async () => {
  vorschau = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits' });
  assert.equal(vorschau.success, true, JSON.stringify(vorschau));
  assert.deepEqual(vorschau.beispiele.map((b) => b.id).sort(), [T.w1, T.w2].sort(), 'nur W1 und W2');
  assert.equal(vorschau.anzahl.coedit_waits, 2); assert.equal(vorschau.anzahl.gesamt, 2);
  assert.deepEqual(vorschau.coedit_je_projekt_status.map((g) => g.project + ':' + g.status + ':' + g.anzahl).sort(), [P + ':ready:1', P + ':waiting:1']);
  assert.ok(vorschau.beispiele.every((b) => b.status), 'Beispiele mit Wait-Status');
  assert.ok(vorschau.gruppen.some((g) => g.warteschlange === 'coedit_waits' && g.empfaenger === 'alt-agent-a' && g.alter_tage >= 11), JSON.stringify(vorschau.gruppen));
  assert.equal(vorschau.ausgenommen.juenger_als_schwelle.coedit_waits, 1, 'W3 juenger als 7 Tage');
  assert.equal(vorschau.ausgenommen.coedit_nicht_abgelaufen, 1, 'W4 nicht abgelaufen');
  assert.match(vorschau.bestaetigung, /^[0-9a-f]{16}$/);
  const ohne = await admin({ aufraeumen_modus: 'vorschau' });
  assert.equal(ohne.anzahl.gesamt, 0, 'Lauf ohne warteschlange nimmt keine Waits'); assert.equal(ohne.anzahl.coedit_waits, undefined);
  const gezielt = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits', aufraeumen_ids: ['alt-agent-a'] });
  assert.deepEqual(gezielt.beispiele.map((b) => b.id), [T.w1], 'aufraeumen_ids = Besitzer');
  const schwelle1 = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits', aufraeumen_tage: 1 });
  assert.equal(schwelle1.anzahl.coedit_waits, 3, 'Schwelle 1 Tag nimmt W3 dazu');
  const alle = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits', project: undefined });
  assert.ok(alle.anzahl.coedit_waits >= 2);
});

test('C P27-T10 ausfuehren: Schalter AUS -> funktion_aus, nichts geaendert', async () => {
  const r = await admin({ aufraeumen_modus: 'ausfuehren', warteschlange: 'coedit_waits', aufraeumen_bestaetigung: vorschau.bestaetigung });
  assert.equal(r.error, 'funktion_aus', JSON.stringify(r));
  assert.equal((await waitZeile(T.w1)).status, 'ready');
  await schalter('warteschlangen_altbestand', true); W.leereWsAltbestandCache();
  assert.equal((await admin({ aufraeumen_modus: 'ausfuehren', warteschlange: 'coedit_waits' })).error, 'bestaetigung_fehlt');
});

let lauf;
test('D P27-T10 ausfuehren: Waits geschlossen wie bei waits_tot, nichts geloescht, Stau zaehlt sie nicht mehr', async () => {
  const anzahlVorher = Number((await raw.query('SELECT count(*) FROM file_batch_waits')).rows[0].count);
  const r = await admin({ aufraeumen_modus: 'ausfuehren', warteschlange: 'coedit_waits', aufraeumen_bestaetigung: vorschau.bestaetigung, grund: 'P27-T10 Test Altbestand' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(r.ausgeblendet, { specialist_inbox: 0, zustellungen: 0, coedit_waits: 2, gesamt: 2 });
  assert.equal(r.coedit_traeger_verworfen, 1);
  lauf = r.lauf_id;
  assert.equal(Number((await raw.query('SELECT count(*) FROM file_batch_waits')).rows[0].count), anzahlVorher, 'nichts geloescht');
  const w1 = await waitZeile(T.w1), w2 = await waitZeile(T.w2);
  assert.equal(w1.status, 'closed'); assert.equal(w2.status, 'closed');
  assert.deepEqual(w1.deferred_ops, OPS1, 'Ops bleiben in der Wait-Zeile'); assert.deepEqual(w2.shared_files, ['src/b.ts']);
  const p1 = await planZeile(7101), p2 = await planZeile(7102);
  assert.equal(p1.status, 'cancelled', 'leerer Traeger verworfen'); assert.match(p1.reason, /^Traeger W1 \[Traegerplan geschlossen durch admin warteschlangen_aufraeumen coedit_waits, Lauf /);
  assert.deepEqual([p2.status, p2.reason, p2.ops], ['open', 'Traeger W2 mit Op', 1], 'Traeger mit Op bleibt offen');
  for (const k of ['w3', 'w4', 'w5', 'w6']) assert.deepEqual(await waitZeile(T[k]), stand[k], k + ' unberuehrt');
  for (const id of [7103, 7104, 7105, 7106]) assert.equal((await planZeile(id)).status, 'open');
  const m = (await raw.query('SELECT eintrag_id, eintrag_uuid::text AS u, project, empfaenger, vorher, schwelle_tage FROM warteschlangen_ausblendungen WHERE lauf_id=$1 ORDER BY empfaenger', [lauf])).rows;
  assert.deepEqual(m.map((x) => [x.eintrag_id, x.u, x.project, x.empfaenger]), [[null, T.w1, P, 'alt-agent-a'], [null, T.w2, P, 'alt-agent-b']]);
  assert.equal(m[0].vorher.status, 'ready'); assert.equal(m[0].vorher.updated_at, stand.w1.u); assert.deepEqual(m[0].vorher.ops, OPS1);
  assert.deepEqual([m[0].vorher.traeger_plan_id, m[0].vorher.traeger_status, m[0].vorher.traeger_verworfen, m[0].vorher.traeger_reason_vorher], ['7101', 'open', true, 'Traeger W1']);
  assert.deepEqual([m[1].vorher.status, m[1].vorher.traeger_verworfen, m[1].vorher.traeger_reason_vorher, m[1].vorher.traeger_ops], ['waiting', false, null, 1]);
  assert.equal(await stau(), 2, 'Stau-Waechter zaehlt nur noch W3 und W6');
  assert.equal((await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits' })).anzahl.coedit_waits, 0, 'zweite Vorschau leer');
  const st = await admin({ aufraeumen_modus: 'status' });
  assert.deepEqual(st.offene_ausblendungen, [{ warteschlange: 'coedit_waits', anzahl: 2 }]);
  assert.equal(st.letzte_laeufe[0].lauf_id, lauf);
});

test('E P27-T10 wiederherstellen: Status, updated_at und Traeger exakt zurueck', async () => {
  const r = await admin({ aufraeumen_modus: 'wiederherstellen', aufraeumen_lauf_id: lauf, grund: 'P27-T10 Test Rueckweg' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual([r.wiederhergestellt, r.eintrag_fehlt, r.geaendert, r.traeger_wieder_offen], [2, 0, [], 1]);
  assert.deepEqual(await waitZeile(T.w1), stand.w1, 'W1 exakt wie vorher (Status, updated_at, Ops)');
  assert.deepEqual(await waitZeile(T.w2), stand.w2, 'W2 exakt wie vorher');
  assert.deepEqual([(await planZeile(7101)).status, (await planZeile(7101)).reason], ['open', 'Traeger W1'], 'Traeger wieder offen, reason von vorher');
  assert.equal(await stau(), stauVorher, 'Stau wieder wie vorher');
  assert.equal(Number((await raw.query('SELECT count(*) FROM warteschlangen_ausblendungen WHERE wiederhergestellt_am IS NULL')).rows[0].count), 0);
  assert.equal((await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits' })).anzahl.coedit_waits, 2, 'wieder Kandidaten');
});

test('F P27-T10 gezielt per Wait-Token aus- und wieder einblenden', async () => {
  const v = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'coedit_waits', aufraeumen_ids: [T.w2.toUpperCase()] });
  assert.deepEqual(v.beispiele.map((b) => b.id), [T.w2], 'Wait-Token als aufraeumen_ids');
  const a = await admin({ aufraeumen_modus: 'ausfuehren', warteschlange: 'coedit_waits', aufraeumen_ids: [T.w2.toUpperCase()], aufraeumen_bestaetigung: v.bestaetigung, grund: 'P27-T10 gezielt' });
  assert.equal(a.success, true, JSON.stringify(a)); assert.equal(a.ausgeblendet.coedit_waits, 1); assert.equal(a.coedit_traeger_verworfen, 0);
  assert.equal((await waitZeile(T.w2)).status, 'closed'); assert.equal((await waitZeile(T.w1)).status, 'ready', 'W1 nicht mitgenommen');
  const r = await admin({ aufraeumen_modus: 'wiederherstellen', aufraeumen_ids: [T.w2], warteschlange: 'coedit_waits', grund: 'P27-T10 gezielt zurueck' });
  assert.equal(r.success, true, JSON.stringify(r)); assert.equal(r.wiederhergestellt, 1);
  assert.deepEqual(await waitZeile(T.w2), stand.w2);
  assert.equal(Number((await raw.query('SELECT count(*) FROM warteschlangen_ausblendungen WHERE eintrag_uuid=$1', [T.w2])).rows[0].count), 2, 'zwei Markierungen als Historie');
});

test('G P27-T10 specialist_inbox: Ausnahmen nur gezielt per aufraeumen_ids, gleicher Rueckweg', async () => {
  const processed = async () => (await raw.query('SELECT id, processed FROM specialist_inbox WHERE id BETWEEN 9101 AND 9104 ORDER BY id')).rows.map((z) => z.id + ':' + z.processed);
  const ohneFlag = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'specialist_inbox', aufraeumen_ids: ['lebend-agent', 'weg-agent'] });
  assert.equal(ohneFlag.anzahl.gesamt, 0, 'ohne Flag bleiben lebender Wrapper und junge Eintraege ausgenommen: ' + JSON.stringify(ohneFlag.beispiele));
  const pauschal = await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'specialist_inbox' });
  assert.ok(!pauschal.beispiele.some((b) => Number(b.id) >= 9101 && Number(b.id) <= 9104), 'ohne ids nie');
  assert.ok(pauschal.ausgenommen.empfaenger_aktiv.specialist_inbox >= 2 && pauschal.ausgenommen.juenger_als_schwelle.specialist_inbox >= 2);
  assert.equal((await admin({ aufraeumen_modus: 'vorschau', warteschlange: 'specialist_inbox', aufraeumen_ausnahmen_einschliessen: true })).error, 'ausnahmen_nur_mit_ids');
  assert.equal((await admin({ aufraeumen_modus: 'vorschau', aufraeumen_ids: ['lebend-agent'], aufraeumen_ausnahmen_einschliessen: true })).error, 'ausnahmen_nur_specialist_inbox');
  assert.equal((await admin({ aufraeumen_modus: 'ausfuehren', warteschlange: 'coedit_waits', aufraeumen_ids: [T.w1], aufraeumen_ausnahmen_einschliessen: true })).error, 'ausnahmen_nur_specialist_inbox');
  const args = { warteschlange: 'specialist_inbox', aufraeumen_ids: ['lebend-agent', '9103'], aufraeumen_ausnahmen_einschliessen: true };
  const v = await admin({ aufraeumen_modus: 'vorschau', ...args });
  assert.equal(v.success, true, JSON.stringify(v));
  assert.deepEqual(v.beispiele.map((b) => b.id + ':' + (b.ausnahme ?? []).join('+')),
    ['9101:empfaenger_aktiv', '9102:empfaenger_aktiv+juenger_als_schwelle', '9103:juenger_als_schwelle'], 'nur Benannte (Empfaenger bzw. Inbox-ID), 9104 nicht');
  assert.deepEqual([v.ausnahmen_einschliessen, v.davon_ausnahmen, v.anzahl.gesamt], [true, 3, 3]);
  assert.notEqual(v.bestaetigung, ohneFlag.bestaetigung, 'eigene Bestaetigung');
  assert.equal((await admin({ aufraeumen_modus: 'ausfuehren', warteschlange: 'specialist_inbox', aufraeumen_ids: ['lebend-agent', '9103'], aufraeumen_bestaetigung: v.bestaetigung })).error, 'vorschau_veraltet', 'Bestaetigung gilt nur mit Flag');
  const a = await admin({ aufraeumen_modus: 'ausfuehren', ...args, aufraeumen_bestaetigung: v.bestaetigung, grund: 'P27-T10 gezielte Inbox-Ausnahmen' });
  assert.equal(a.success, true, JSON.stringify(a)); assert.equal(a.ausgeblendet.specialist_inbox, 3);
  assert.deepEqual(await processed(), ['9101:true', '9102:true', '9103:true', '9104:false'], 'nichts geloescht, 9104 unberuehrt');
  const m = (await raw.query('SELECT eintrag_id::int AS id, vorher FROM warteschlangen_ausblendungen WHERE lauf_id=$1 ORDER BY eintrag_id', [a.lauf_id])).rows;
  assert.deepEqual(m.map((x) => [x.id, x.vorher.processed, x.vorher.ausnahme]), [[9101, false, ['empfaenger_aktiv']], [9102, false, ['empfaenger_aktiv', 'juenger_als_schwelle']], [9103, false, ['juenger_als_schwelle']]]);
  const r = await admin({ aufraeumen_modus: 'wiederherstellen', aufraeumen_lauf_id: a.lauf_id, grund: 'P27-T10 Inbox-Rueckweg' });
  assert.equal(r.success, true, JSON.stringify(r)); assert.deepEqual([r.wiederhergestellt, r.geaendert], [3, []]);
  assert.deepEqual(await processed(), ['9101:false', '9102:false', '9103:false', '9104:false'], 'exakt zurueck');
});
