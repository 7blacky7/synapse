/**
 * P22-T119 R1 (Befund 0c19c24c): Wettlauf zweier bestaetigter Startabschluesse. Echte PG-Writes, nur synapse_test:5433,
 * eigenes temporaeres Schema (wird entfernt). Kein Agent/Container.
 *   pnpm --filter @synapse/core build && node packages/core/tests/modell-lauf-bindung-race-p22-t119.test.mjs
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test', 'nur synapse_test');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const M = await import(pathToFileURL(join(repo, 'packages/core/dist/services/plattform-agent-modellwechsel.js')).href);

const schema = 'p22_t119_r1_' + process.pid;
const db = new pg.Client({ connectionString: url.href });
await db.connect();
const q = (sql, p) => db.query(sql, p);
try {
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  await db.query(`CREATE TABLE agent_identitaeten (id uuid PRIMARY KEY, rolle text NOT NULL, startrezept jsonb, modell_bestaetigt text, profil_revision int NOT NULL DEFAULT 0)`);
  const id = randomUUID();
  await db.query(`INSERT INTO agent_identitaeten (id, rolle, startrezept, modell_bestaetigt) VALUES ($1, 'specialist', '{}'::jsonb, 'alt')`, [id]);
  const profil = (lauf) => db.query(`UPDATE agent_identitaeten SET startrezept = jsonb_set(startrezept, '{plattform_modell}', $2::jsonb) WHERE id = $1`,
    [id, JSON.stringify({ modell: lauf.modell, wrapper_pid: lauf.wrapper_pid, lauf_hash: lauf.lauf_hash, job_id: lauf.job_id, quelle: 'spawn_bestaetigt' })]);
  const zeile = async () => (await db.query('SELECT modell_bestaetigt, startrezept FROM agent_identitaeten WHERE id = $1', [id])).rows[0];

  const A = { modell: 'claude-haiku-5-5', job_id: 'job-alt-A', wrapper_pid: 100, lauf_hash: 'a'.repeat(64) };
  const B = { modell: 'claude-opus-5-5', job_id: 'job-neu-B', wrapper_pid: 200, lauf_hash: 'b'.repeat(64) };

  // Verschachtelung wie im Befund: A schreibt Laufprofil, dann wird B vollstaendig bestaetigt, dann setzt A Schritt 2 fort.
  await profil(A);
  await profil(B);
  assert.deepEqual(await M.bindeModellAnLauf(id, B, q), { gesetzt: true, grund: 'gebunden' }, 'B bindet');
  assert.deepEqual(await M.bindeModellAnLauf(id, A, q), { gesetzt: false, grund: 'lauf_nicht_mehr_aktuell' }, 'alter Abschluss A schreibt nicht');
  let z = await zeile();
  assert.equal(z.modell_bestaetigt, B.modell, 'modell_bestaetigt bleibt Opus (B)');
  assert.equal(z.startrezept.plattform_modell.job_id, B.job_id);
  assert.equal(z.startrezept.plattform_modell.wrapper_pid, 200);
  assert.equal(z.startrezept.plattform_modell.modell_bestaetigt_gesetzt, true, 'gesetzt-Flag stammt von B selbst');

  // A kommt VOR B's Bindung zu spaet: Profil ist schon B, B noch nicht gebunden -> A schreibt nicht, kein gesetzt-Flag.
  await db.query(`UPDATE agent_identitaeten SET modell_bestaetigt = 'alt' WHERE id = $1`, [id]);
  await profil(B);
  assert.equal((await M.bindeModellAnLauf(id, A, q)).gesetzt, false);
  z = await zeile();
  assert.equal(z.modell_bestaetigt, 'alt', 'A setzt Haiku nicht auf Lauf B');
  assert.equal(z.startrezept.plattform_modell.modell_bestaetigt_gesetzt, undefined, 'kein falsches gesetzt=true');

  // Gleicher Job, aber andere PID / anderer Hash -> keine Bindung (keine blosse ID-Pruefung).
  assert.equal((await M.bindeModellAnLauf(id, { ...B, wrapper_pid: 201 }, q)).gesetzt, false, 'PID muss passen');
  assert.equal((await M.bindeModellAnLauf(id, { ...B, lauf_hash: 'c'.repeat(64) }, q)).gesetzt, false, 'Laufhash muss passen');
  assert.equal((await M.bindeModellAnLauf(id, { ...B, modell: 'claude-haiku-5-5' }, q)).gesetzt, false, 'Modell muss passen');

  // Echte Nebenlaeufigkeit: beide Bindungen parallel auf getrennten Verbindungen -> nur B gewinnt.
  const db2 = new pg.Client({ connectionString: url.href }); await db2.connect(); await db2.query(`SET search_path TO ${schema}`);
  try {
    const [ra, rb] = await Promise.all([M.bindeModellAnLauf(id, A, (s, p) => db2.query(s, p)), M.bindeModellAnLauf(id, B, q)]);
    assert.equal(ra.gesetzt, false); assert.equal(rb.gesetzt, true);
  } finally { await db2.end(); }
  z = await zeile();
  assert.equal(z.modell_bestaetigt, B.modell);
  assert.equal(z.startrezept.plattform_modell.modell_bestaetigt_gesetzt, true);

  // R1b: Schritt 1 (Laufprofil) generationsgebunden. B (neuerer Job) steht; spaeter Abschluss A (aelterer Job) darf B nicht ueberschreiben.
  const genA = '2026-10-24T10:00:00.000001Z', genB = '2026-10-24T10:00:05.000000Z';
  const eintrag = (l, g) => ({ modell: l.modell, runtime: 'rt', effort: null, start_ort: 'container', start_ziel: 'rt', am: new Date().toISOString(),
    quelle: 'spawn_bestaetigt', wrapper_pid: l.wrapper_pid, lauf_hash: l.lauf_hash, job_id: l.job_id, job_erstellt: g });
  await db.query(`UPDATE agent_identitaeten SET startrezept = '{}'::jsonb, modell_bestaetigt = 'alt' WHERE id = $1`, [id]);
  assert.deepEqual(await M.schreibeLaufProfil(id, eintrag(B, genB), q), { geschrieben: true, grund: 'geschrieben' }, 'B schreibt (leer)');
  assert.equal((await M.bindeModellAnLauf(id, B, q)).gesetzt, true);
  assert.deepEqual(await M.schreibeLaufProfil(id, eintrag(A, genA), q), { geschrieben: false, grund: 'neuerer_lauf_vorhanden' }, 'spaetes A ueberschreibt B nicht');
  assert.equal((await M.bindeModellAnLauf(id, A, q)).gesetzt, false);
  z = await zeile();
  assert.equal(z.startrezept.plattform_modell.job_id, B.job_id, 'Laufprofil bleibt B');
  assert.equal(z.startrezept.plattform_modell.wrapper_pid, 200);
  assert.equal(z.startrezept.plattform_modell.modell, B.modell);
  assert.equal(z.modell_bestaetigt, B.modell);
  assert.equal(z.startrezept.plattform_modell.modell_bestaetigt_gesetzt, true);
  // Gleicher Job darf erneut schreiben (idempotent); neuerer Job C ueberschreibt B regulaer.
  assert.equal((await M.schreibeLaufProfil(id, eintrag(B, genB), q)).geschrieben, true, 'gleicher Job idempotent');
  const C = { modell: 'claude-sonnet-5-5', job_id: 'job-C', wrapper_pid: 300, lauf_hash: 'd'.repeat(64) };
  assert.equal((await M.schreibeLaufProfil(id, eintrag(C, '2026-10-24T10:00:09.000000Z'), q)).geschrieben, true, 'neuerer Lauf C');
  assert.equal((await zeile()).startrezept.plattform_modell.job_id, 'job-C');
  // Altbestand ohne Generation ist ueberschreibbar.
  await db.query(`UPDATE agent_identitaeten SET startrezept = jsonb_build_object('plattform_modell', jsonb_build_object('job_id','alt')) WHERE id = $1`, [id]);
  assert.equal((await M.schreibeLaufProfil(id, eintrag(A, genA), q)).geschrieben, true, 'Altbestand ohne Generation');
  // Parallel: A und B gleichzeitig auf zwei Verbindungen, egal welche Reihenfolge -> Endstand B.
  await db.query(`UPDATE agent_identitaeten SET startrezept = '{}'::jsonb WHERE id = $1`, [id]);
  const db3 = new pg.Client({ connectionString: url.href }); await db3.connect(); await db3.query(`SET search_path TO ${schema}`);
  try {
    await Promise.all([M.schreibeLaufProfil(id, eintrag(A, genA), (s, p) => db3.query(s, p)), M.schreibeLaufProfil(id, eintrag(B, genB), q)]);
  } finally { await db3.end(); }
  assert.equal((await zeile()).startrezept.plattform_modell.job_id, B.job_id, 'parallel: Endstand B');
  assert.deepEqual(await M.schreibeLaufProfil(id, eintrag(A, genA), async () => { throw new Error('x'); }), { geschrieben: false, grund: 'fehler' });

  // R1c: Modellwechsel-Pfad (fuehreWechselAus -> bestaetigeWechselModell). Repro rea4: alter Wechsel A (Haiku) kommt nach
  // bestaetigtem Lauf B (Opus, PID 200) an -> bei Schalter EIN kein Haiku auf B.
  await db.query(`UPDATE agent_identitaeten SET startrezept = '{}'::jsonb, modell_bestaetigt = 'alt' WHERE id = $1`, [id]);
  assert.equal((await M.schreibeLaufProfil(id, eintrag(B, genB), q)).geschrieben, true);
  assert.equal((await M.bestaetigeWechselModell(true, id, B.modell, B, q)).gesetzt, true, 'Wechsel B bindet');
  assert.deepEqual(await M.bestaetigeWechselModell(true, id, A.modell, A, q), { gesetzt: false, grund: 'lauf_nicht_mehr_aktuell' }, 'alter Wechsel A schreibt nicht');
  z = await zeile();
  assert.equal(z.modell_bestaetigt, B.modell, 'Wechsel-Pfad: modell_bestaetigt bleibt Opus');
  assert.equal(z.startrezept.plattform_modell.wrapper_pid, 200);
  assert.deepEqual(await M.bestaetigeWechselModell(true, id, A.modell, null, q), { gesetzt: false, grund: 'kein_laufnachweis' }, 'ohne Laufnachweis nichts');
  assert.equal((await M.bestaetigeWechselModell(true, id, A.modell, { job_id: A.job_id, wrapper_pid: null, lauf_hash: A.lauf_hash }, q)).grund, 'kein_laufnachweis');
  assert.equal((await zeile()).modell_bestaetigt, B.modell);
  // Parallel: Wechsel A und B gleichzeitig -> Endstand B.
  await db.query(`UPDATE agent_identitaeten SET modell_bestaetigt = 'alt' WHERE id = $1`, [id]);
  const db4 = new pg.Client({ connectionString: url.href }); await db4.connect(); await db4.query(`SET search_path TO ${schema}`);
  try {
    await Promise.all([M.bestaetigeWechselModell(true, id, A.modell, A, (s, p) => db4.query(s, p)), M.bestaetigeWechselModell(true, id, B.modell, B, q)]);
  } finally { await db4.end(); }
  assert.equal((await zeile()).modell_bestaetigt, B.modell, 'parallel Wechsel: Endstand B');
  // Schalter AUS: Bestand (ungebunden).
  assert.deepEqual(await M.bestaetigeWechselModell(false, id, A.modell, null, q), { gesetzt: true, grund: 'schalter_aus_bestand' });
  assert.equal((await zeile()).modell_bestaetigt, A.modell, 'AUS: ungebunden wie bisher');

  // Rolle main wird nie gebunden; Fehler wirft nicht.
  await db.query(`UPDATE agent_identitaeten SET rolle = 'main' WHERE id = $1`, [id]);
  assert.equal((await M.bindeModellAnLauf(id, B, q)).gesetzt, false, 'main nie');
  assert.deepEqual(await M.bindeModellAnLauf(id, B, async () => { throw new Error('x'); }), { gesetzt: false, grund: 'fehler' });
  console.log('OK modell-lauf-bindung-race-p22-t119');
} finally {
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await db.end();
}
