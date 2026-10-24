/**
 * P22-T120: Antwort des geweckten Agenten identitaetsadressiert an den Wecker (Main in synapse-hauptagent).
 * Rein + echte PG-SQL (nur synapse_test:5433, eigenes Schema, wird entfernt).
 *   pnpm --filter @synapse/core build && node packages/core/tests/wake-antwort-identitaet-p22-t120.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const S = await load('packages/core/dist/services/agent-profil-schalter.js');
const R = await load('packages/core/dist/services/wake-rueckadresse.js');

assert.equal(R.WAKE_ANTWORT_IDENTITAET_FUNKTION, 'wake_antwort_identitaet');
assert.ok(S.NUR_AUSDRUECKLICH.includes('wake_antwort_identitaet'), 'nur ausdruecklich (Std AUS)');
assert.equal(await R.wakeAntwortIdentitaetAktiv('x'), false, 'Lesefehler -> AUS');

// rein: Rueckadresse nur fuer Identitaets-Principal, der genau der Absender ist
const main = { art: 'identity', identity_id: 'id-main', agent_id: 'hauptagent', project: 'synapse-hauptagent' };
assert.equal(R.rueckadresseAusPrincipal('hauptagent', main), 'id-main');
assert.equal(R.rueckadresseAusPrincipal('rest-api', main), null, 'Absender != Principal -> keine Rueckadresse');
assert.equal(R.rueckadresseAusPrincipal('hauptagent', { art: 'legacy', agent_id: 'hauptagent' }), null, 'Legacy -> keine');
assert.equal(R.rueckadresseAusPrincipal('hauptagent', null), null);

const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test', 'nur synapse_test');
const schema = 'p22_t120_' + process.pid;
const db = new pg.Client({ connectionString: url.href });
await db.connect();
const q = (s, p) => db.query(s, p);
try {
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  await db.query(`CREATE TABLE agent_identitaeten (id text PRIMARY KEY, project text, agent_id text, status text)`);
  await db.query(`CREATE TABLE specialist_inbox (id bigserial PRIMARY KEY, from_agent text, to_agent text, content text, project text,
    from_identity_id text REFERENCES agent_identitaeten(id), to_identity_id text REFERENCES agent_identitaeten(id), processed boolean DEFAULT false)`);
  const mainId = randomUUID();
  await db.query(`INSERT INTO agent_identitaeten VALUES ($1,'synapse-hauptagent','hauptagent','aktiv')`, [mainId]);
  const p = { ...main, identity_id: mainId };
  // Live-Fall: wake von Main (Absender hauptagent) an claude-x im Projekt synapse, Zeile ohne from_identity_id
  const wake = (await db.query(`INSERT INTO specialist_inbox(from_agent,to_agent,content,project) VALUES('hauptagent','claude-x','weck','synapse') RETURNING id`)).rows[0].id;

  // Schalter AUS: nichts
  assert.deepEqual(await R.merkeWakeRueckadresse(Number(wake), 'synapse', 'hauptagent', q, false, p), { gesetzt: false, grund: 'schalter_aus' });
  assert.equal(await R.rueckadresseFuer('synapse', 'hauptagent', 'claude-x', q), null, 'AUS/ohne Rueckadresse: Bestand (to_identity NULL)');
  // fremder Absender (rest-api) bekommt keine Rueckadresse
  assert.equal((await R.merkeWakeRueckadresse(Number(wake), 'synapse', 'rest-api', q, true, p)).grund, 'kein_identitaets_principal');
  // EIN: Rueckadresse gesetzt
  const m = await R.merkeWakeRueckadresse(Number(wake), 'synapse', 'hauptagent', q, true, p);
  assert.equal(m.gesetzt, true); assert.equal(m.identity_id, mainId);
  // Antwort claude-x -> 'hauptagent' findet die Main-Identitaet (projektuebergreifend)
  const r = await R.rueckadresseFuer('synapse', 'hauptagent', 'claude-x', q);
  assert.deepEqual(r, { identity_id: mainId, agent_id: 'hauptagent', wake_inbox_id: Number(wake) });
  // nur an den Geweckten: ein anderer Agent bekommt keine Rueckadresse
  assert.equal(await R.rueckadresseFuer('synapse', 'hauptagent', 'claude-y', q), null, 'nicht geweckt -> Bestand');
  // andere Projekte nicht
  assert.equal(await R.rueckadresseFuer('anderes', 'hauptagent', 'claude-x', q), null);
  // deaktivierte Identitaet nicht
  await db.query(`UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1`, [mainId]);
  assert.equal(await R.rueckadresseFuer('synapse', 'hauptagent', 'claude-x', q), null, 'deaktiviert -> Bestand');
  await db.query(`UPDATE agent_identitaeten SET status='aktiv' WHERE id=$1`, [mainId]);
  // zweites Setzen idempotent (Zeile schon belegt)
  assert.equal((await R.merkeWakeRueckadresse(Number(wake), 'synapse', 'hauptagent', q, true, p)).grund, 'zeile_unpassend');
  // Lesepfad des Main: identitaetsadressierte Antwort (project=synapse) ist ueber to_identity_id ohne Projektfilter sichtbar
  // (so liest inbox.ts bei Schalter EIN: ($frei OR project=$p) AND to_identity_id=$id).
  await db.query(`INSERT INTO specialist_inbox(from_agent,to_agent,content,project,to_identity_id) VALUES('claude-x','hauptagent','antwort','synapse',$1)`, [mainId]);
  const lies = (frei) => db.query(`SELECT content FROM specialist_inbox WHERE ($3::boolean OR project=$2) AND to_identity_id=$1 AND processed=false`, [mainId, 'synapse-hauptagent', frei]);
  assert.deepEqual((await lies(true)).rows.map(x => x.content), ['antwort'], 'EIN: Main findet Antwort projektuebergreifend');
  assert.equal((await lies(false)).rows.length, 0, 'AUS: Bestand (nur eigenes Projekt)');
  // Fehler wirft nie
  assert.equal((await R.merkeWakeRueckadresse(1, 'synapse', 'hauptagent', async () => { throw new Error('x'); }, true, p)).grund, 'fehler');
  assert.equal(await R.rueckadresseFuer('synapse', 'hauptagent', 'claude-x', async () => { throw new Error('x'); }), null);
  assert.equal((await R.merkeWakeRueckadresse(undefined, 'synapse', 'hauptagent', q, true, p)).grund, 'keine_inbox_zeile');
  console.log('OK wake-antwort-identitaet-p22-t120');
} finally {
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await db.end();
}
