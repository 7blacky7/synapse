/**
 * P22-T120 R1/R2 (rea4 9d101b8f): echte Inbox-Dienste (postToInbox/checkInbox/getNewInboxMessages/getInboxHistory) mit
 * Principal-Kontext und PG-Schalter. Nur synapse_test:5433, eigenes Schema (wird entfernt).
 *   pnpm --filter @synapse/core build && node packages/core/tests/wake-antwort-identitaet-dienste-p22-t120.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(repo, 'packages/core/package.json'));
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.pathname, '/synapse_test'); assert.equal(url.port, '5433');
const admin = new Client({ connectionString: url.href }); await admin.connect();
const schema = 'p22_t120_dienste_' + process.pid;
url.searchParams.set('options', '-c search_path=' + schema + ',public'); process.env.DATABASE_URL = url.href;
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const DB = await load('packages/core/dist/db/client.js');
const A = await load('packages/core/dist/services/agent-bezug.js');
const I = await load('packages/core/dist/services/inbox.js');
const R = await load('packages/core/dist/services/wake-rueckadresse.js');
const pool = DB.getPool();
const principal = (id, agent, project) => ({ art: 'identity', identity_id: id, agent_id: agent, project, rolle: 'subagent', modell: 'fixture', context_epoch: 1, lauf_id: null });
const main = principal('main-id', 'main', 'home'), worker = principal('worker-id', 'worker', 'work'), bob = principal('bob-id', 'bob', 'home');
const run = (p, f) => A.mitAgentAufrufKontext({ principal: p, bezug: { modus: 'beide', standard: 'beide', quelle: 'standard', bis: null, letzter_fehler: null } }, f);
const zeile = async (id) => (await admin.query('SELECT * FROM specialist_inbox WHERE id=$1', [id])).rows[0];
const schalter = (an) => admin.query('UPDATE agent_profil_schalter SET aktiv=$1', [an]);

// rein
assert.equal(R.projektfreiesLesenErlaubt('main-id', main), true);
assert.equal(R.projektfreiesLesenErlaubt('bob-id', main), false, 'fremde Identitaet');
assert.equal(R.projektfreiesLesenErlaubt('main-id', null), false, 'ohne Principal');
assert.equal(R.projektfreiesLesenErlaubt('main-id', { art: 'legacy', identity_id: 'main-id' }), false, 'Legacy');

try {
  await admin.query('CREATE SCHEMA ' + schema); await admin.query('SET search_path TO ' + schema + ',public');
  await admin.query('CREATE TABLE agent_identitaeten(id text primary key,agent_id text,project text,status text)');
  await admin.query('CREATE TABLE agent_identitaet_tokens(identity_id text,widerrufen_am timestamptz,token_offen text,gueltig_bis timestamptz)');
  await admin.query('CREATE TABLE agent_sessions(id text,project text,identity_id text,status text)');
  await admin.query('CREATE TABLE agent_profil_schalter(ebene text,project text,funktion text,aktiv bool,grund text,gesetzt_von text,gesetzt_am timestamptz)');
  await admin.query("INSERT INTO agent_profil_schalter VALUES('global',NULL,'wake_antwort_identitaet',true,'test','test',NOW())");
  await admin.query('CREATE TABLE specialist_inbox(id serial primary key,from_agent text,to_agent text,project text,content text,from_identity_id text,to_identity_id text,processed bool default false,created_at timestamptz default now())');
  for (const p of [main, worker, bob]) await admin.query("INSERT INTO agent_identitaeten VALUES($1,$2,$3,'aktiv')", [p.identity_id, p.agent_id, p.project]);

  // R2: Rueckadresse vorab + atomar im Wake-INSERT; schnelle Antwort direkt danach (vor jedem weiteren Schritt) erreicht Main.
  const vorab = await run(main, () => R.wakeRueckadresseVorab('work', 'main'));
  assert.deepEqual(vorab, { identity_id: 'main-id', grund: 'vorab' });
  const wake = await run(main, () => I.postToInbox('main', 'worker', 'wake', 'work', { fromIdentityId: vorab.identity_id }));
  assert.equal((await zeile(wake.id)).from_identity_id, 'main-id', 'Rueckadresse steht bereits mit dem INSERT');
  const reply = await run(worker, () => I.postToInbox('worker', 'main', 'reply-schnell', 'work'));
  assert.equal((await zeile(reply.id)).to_identity_id, 'main-id', 'schnelle Antwort identitaetsadressiert');
  assert.deepEqual((await run(main, () => I.getNewInboxMessages('main', 0, 'home'))).map(m => m.content), ['reply-schnell'], 'getNew: eigene Identitaet projektfrei');
  assert.deepEqual((await run(main, () => I.getInboxHistory('main', 'home'))).map(m => m.content), ['reply-schnell'], 'History: eigene Identitaet projektfrei');
  assert.deepEqual((await run(main, () => I.checkInbox('main', 'home'))).map(m => m.content), ['reply-schnell'], 'checkInbox: eigene Identitaet projektfrei');
  assert.equal((await zeile(reply.id)).processed, true);
  // Vorab: fremder Absender / Worker-Principal / Schalter AUS -> keine Rueckadresse
  assert.equal((await run(worker, () => R.wakeRueckadresseVorab('work', 'main'))).identity_id, null, 'fremder Principal');
  assert.equal((await run(main, () => R.wakeRueckadresseVorab('work', 'rest-api'))).identity_id, null, 'Absender != Principal');
  assert.equal((await R.wakeRueckadresseVorab('work', 'main', true, null)).identity_id, null, 'ohne Principal');
  await schalter(false);
  assert.deepEqual(await run(main, () => R.wakeRueckadresseVorab('work', 'main')), { identity_id: null, grund: 'schalter_aus' });
  await schalter(true);

  // R1: fremdes explizites Identitaetsziel wird NICHT projektfrei gelesen/quittiert (alle drei Lesedienste)
  const secret = (await admin.query("INSERT INTO specialist_inbox(from_agent,to_agent,project,content,to_identity_id) VALUES('x','bob','foreign','BOB-SECRET','bob-id') RETURNING id")).rows[0].id;
  for (const p of [main, worker]) {
    assert.ok(!(await run(p, () => I.getInboxHistory('identity:bob-id', 'home'))).some(m => m.id === secret), 'History fremd abgewiesen');
    assert.ok(!(await run(p, () => I.getNewInboxMessages('identity:bob-id', 0, 'home'))).some(m => m.id === secret), 'getNew fremd abgewiesen');
    assert.ok(!(await run(p, () => I.checkInbox('identity:bob-id', 'home'))).some(m => m.id === secret), 'checkInbox fremd abgewiesen');
  }
  assert.equal((await zeile(secret)).processed, false, 'fremde Zeile nicht quittiert');
  // Bob selbst darf seine eigene Nachricht projektfrei lesen
  assert.deepEqual((await run(bob, () => I.getInboxHistory('bob', 'home'))).map(m => m.content), ['BOB-SECRET'], 'eigene Identitaet ok');
  // Schalter AUS: Bestand (nur eigenes Projekt), auch fuer die eigene Identitaet
  await schalter(false);
  assert.equal((await run(bob, () => I.getInboxHistory('bob', 'home'))).length, 0, 'AUS: Bestand');
  await schalter(true);
  // R2-Rest (rea4 66293a98): Insertfehler im EIN-Zweig (echte CHECK-Verletzung) -> kein Notify, ok=false, Debug
  await admin.query("ALTER TABLE specialist_inbox ADD CONSTRAINT t120_check CHECK (content <> 'VERBOTEN')");
  let notifies = 0;
  const notifyZaehler = async () => { notifies++; return true; };
  const fehlerInsert = async () => { try { return (await run(main, () => I.postToInbox('main', 'worker', 'VERBOTEN', 'work', { fromIdentityId: 'main-id' }))).id; } catch (e) { assert.match(String(e?.message ?? e), /t120_check|check/i); return undefined; } };
  const f = await R.wakeReihenfolge(true, fehlerInsert, notifyZaehler);
  assert.deepEqual(f, { ok: false, notifyOk: false, inboxId: undefined, rueckadresse_fehler: 'inbox_insert_fehlgeschlagen_kein_notify' }, 'EIN + Insertfehler: success=false');
  assert.equal(notifies, 0, 'EIN + Insertfehler: kein Notify');
  // EIN + Erfolg: erst Insert, dann Notify
  const reihenfolge = [];
  const g = await R.wakeReihenfolge(true, async () => { reihenfolge.push('insert'); return 7; }, async () => { reihenfolge.push('notify'); return true; });
  assert.deepEqual(reihenfolge, ['insert', 'notify']); assert.equal(g.ok, true); assert.equal(g.inboxId, 7);
  // AUS-Zweig unveraendert: Notify zuerst, Insertfehler + Notify ok -> ok=true wie bisher
  const r2 = []; notifies = 0;
  const h = await R.wakeReihenfolge(false, async () => { r2.push('insert'); return fehlerInsert(); }, async () => { r2.push('notify'); return notifyZaehler(); });
  assert.deepEqual(r2, ['notify', 'insert']); assert.equal(h.ok, true, 'AUS: Bestand'); assert.equal(h.rueckadresse_fehler, null);
  await admin.query('ALTER TABLE specialist_inbox DROP CONSTRAINT t120_check');

  // Altweg ohne Rueckadresse: Antwort bleibt Bestand (to_identity NULL) - dokumentiert, Routen nutzen ihn nicht mehr
  await admin.query('TRUNCATE specialist_inbox');
  await run(main, () => I.postToInbox('main', 'worker', 'wake-ohne', 'work'));
  const alt = await run(worker, () => I.postToInbox('worker', 'main', 'reply-alt', 'work'));
  assert.equal((await zeile(alt.id)).to_identity_id, null, 'ohne Rueckadresse: Bestand');
  console.log('OK wake-antwort-identitaet-dienste-p22-t120');
} finally {
  await pool.end(); await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
}
