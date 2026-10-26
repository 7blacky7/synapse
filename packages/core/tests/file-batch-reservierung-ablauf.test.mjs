/**
 * P15-T27 (11.10.2026) — abgelaufene Reservierung erzeugt einen Wait, der sich nie loest; jeder neue
 * Versuch legt einen neuen leeren Traegerplan an. Live-Fall: Reservierung 3996 (p15-pause2, content.ts,
 * abgelaufen 12:53:55Z, released_at NULL), Plaene 24811/24812 von p15-fehlerkonzept mit
 * retry_after_seconds 1 und expires_at in der Vergangenheit.
 *
 *  A1 abgelaufene, nicht freigegebene fremde Reservierung: plan erzeugt KEINEN Wait, die Op landet
 *     sofort im Plan und der commit schreibt (Ziel 1).
 *  A2 der Direktschreib-Hinweis (reservation_hint) nennt die abgelaufene Reservierung nicht mehr.
 *  A3 gueltige Reservierung eines ABGEMELDETEN Agenten (agent_sessions.status inactive): kein Wait.
 *  B1 Kontrollfall: gueltige fremde Reservierung -> Wait wie bisher.
 *  B2 derselbe plan noch einmal, solange der Wait lebt: derselbe Traeger, der Wait enthaelt die Op
 *     NICHT doppelt (Ziel 2).
 *  B3 plan_status des Traegers mit wait_seconds wacht beim Ablauf der Reservierung auf und zeigt
 *     wait_status 'expired' samt Hinweis (Ziel 1: der Wait loest sich spaetestens bei Ablauf).
 *  B4 shared_plan_status mit wait_seconds wacht ebenso beim Ablauf auf (status 'expired').
 *  B5 erneuter plan nach Ablauf: der vorhandene Traeger wird zum Plan (gleiche plan_id, kein Wait,
 *     alter Wait closed), es entsteht kein neuer Plan; commit schreibt die Op genau einmal (Ziel 2).
 *  C1 Aufraeumen (Ziel 3): releaseStaleFileReservations gibt abgelaufene Reservierungen nach der
 *     Grace-Frist und die abgemeldeter Agenten frei; innerhalb der Grace und lebende bleiben.
 *
 * P25-T15 (26.10.2026): Seit P6-T48 erzeugt plan auf eine nur RESERVIERTE Datei keinen Wait mehr (reservation_hint, sofort
 * geschrieben). B1/B4 legen den zielosen Wait deshalb als Altfall an (_helfer/altfall-wait.mjs). B2: ein erneuter plan schreibt
 * sofort in EINEN neuen Plan (kein weiterer leerer Traeger), der Altfall-Wait bleibt unveraendert. B3/B4 wie bisher. B5: nach
 * Ablauf meldet der Altfall-Traeger nothing_written mit ops_zum_neu_planen, der neue Plan schreibt die Op genau einmal.
 * C1: planlose Reservierungen werden sofort bei Ablauf frei (file-reservations.ts releaseStaleFileReservations), die
 * Grace-Frist gilt nur fuer planbehaftete; 'ab-c-grace' haelt deshalb eine Reservierung mit Plan.
 *
 * AUFRUF (Test-DB!): (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/file-batch-reservierung-ablauf.test.mjs
 * Gegenprobe alter Stand: PLAENE_TEST_DIST=<altes dist> node ...
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('file-batch-reservierung-ablauf.test');
const PROJECT = 'ablauf-test';
const F = 'ab-fremd';
const W = 'ab-warte';
const WEG = 'ab-abgemeldet';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();
const { legeAltfallWaitAn } = await import(join(hier, '_helfer', 'altfall-wait.mjs'));

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 700) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), geworfen: true }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
  }
  await pool.query(`DELETE FROM agent_sessions WHERE id = ANY($1::text[])`, [[F, W, WEG, 'ab-c-alt', 'ab-c-grace', 'ab-c-lebt', 'ab-c-planlos']]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
async function anlegen(p, t) {
  const x = await batch.planBatch({ project: PROJECT, agent_id: 'ab-setup', ops: [{ file_path: p, action: 'create', content: t }] });
  const c = await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'ab-setup' });
  if (!c.success) throw new Error('anlegen ' + p + ': ' + JSON.stringify(c));
}
const sr = (f, search, replace) => ({ file_path: f, action: 'search_replace', search, replace });
const planZahl = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM file_batch_plans WHERE project = $1', [PROJECT])).rows[0].n;
const planZeile = async (id) => (await pool.query('SELECT status::text AS status, jsonb_array_length(ops)::int AS ops FROM file_batch_plans WHERE id = $1', [id])).rows[0] ?? null;
const vorkommen = (text, marke) => (text ?? '').split(marke).length - 1;
async function reservierungAblaufen(agent, pfad, sekundenAbJetzt) {
  await pool.query(
    `UPDATE file_reservations SET expires_at = NOW() + ($3 * INTERVAL '1 second')
      WHERE project = $1 AND agent_id = $2 AND file_path = $4 AND released_at IS NULL`,
    [PROJECT, agent, sekundenAbJetzt, pfad],
  );
  // Wie syncWaitExpiries: der Wait folgt der Primaerreservierung.
  await pool.query(
    `UPDATE file_batch_waits SET expires_at = NOW() + ($3 * INTERVAL '1 second')
      WHERE project = $1 AND primary_agent = $2 AND $4 = ANY(shared_files) AND status IN ('waiting', 'linked')`,
    [PROJECT, agent, sekundenAbJetzt, pfad],
  );
}

try {
  await aufraeumen();

  // ===== A1 abgelaufene fremde Reservierung blockiert plan nicht =====
  await anlegen('src/a1.ts', 'a1-alt\n');
  await res.addFileReservations({ project: PROJECT, agentId: F, filePaths: ['src/a1.ts'] });
  await reservierungAblaufen(F, 'src/a1.ts', -60);
  const a1 = await batch.planBatch({ project: PROJECT, agent_id: W, ops: [sr('src/a1.ts', 'a1-alt', 'a1-NEU')] });
  pruefe((a1.coedit_waits ?? []).length === 0 && a1.total_ops === 1,
    'A1: abgelaufene, nicht freigegebene fremde Reservierung erzeugt keinen Wait, die Op liegt im Plan',
    { total_ops: a1.total_ops, coedit_waits: a1.coedit_waits });
  const a1c = await versuch(() => batch.commitBatch({ plan_id: a1.plan_id, agent_id: W }));
  pruefe(a1c.success === true && (await inhalt('src/a1.ts')) === 'a1-NEU\n', 'A1: commit schreibt die Op', a1c);

  // ===== A2 Direktschreib-Hinweis ohne abgelaufene Reservierung =====
  await anlegen('src/a2.ts', 'a2\n');
  await res.addFileReservations({ project: PROJECT, agentId: F, filePaths: ['src/a2.ts'] });
  const a2vorher = await res.getDirectWriteReservationHint({ project: PROJECT, agentId: W, filePaths: ['src/a2.ts'] });
  await reservierungAblaufen(F, 'src/a2.ts', -60);
  const a2 = await res.getDirectWriteReservationHint({ project: PROJECT, agentId: W, filePaths: ['src/a2.ts'] });
  pruefe(a2vorher?.files?.length === 1 && a2 === undefined,
    'A2: reservation_hint nennt eine lebende Reservierung, eine abgelaufene nicht mehr', { a2vorher, a2 });

  // ===== A3 Reservierung eines abgemeldeten Agenten =====
  await anlegen('src/a3.ts', 'a3-alt\n');
  await pool.query(`INSERT INTO agent_sessions (id, project, status, registered_at) VALUES ($1, $2, 'inactive', NOW())`, [WEG, PROJECT]);
  await res.addFileReservations({ project: PROJECT, agentId: WEG, filePaths: ['src/a3.ts'] });
  const a3 = await batch.planBatch({ project: PROJECT, agent_id: W, ops: [sr('src/a3.ts', 'a3-alt', 'a3-NEU')] });
  pruefe((a3.coedit_waits ?? []).length === 0 && a3.total_ops === 1,
    'A3: gueltige Reservierung eines abgemeldeten Agenten erzeugt keinen Wait', { total_ops: a3.total_ops, coedit_waits: a3.coedit_waits });
  await batch.cancelBatch(a3.plan_id, W, 'Testende A3');

  // ===== B1 Kontrollfall: lebende Reservierung -> Wait =====
  await anlegen('src/b.ts', 'b-alt\n');
  await res.addFileReservations({ project: PROJECT, agentId: F, filePaths: ['src/b.ts'] });
  const opB = sr('src/b.ts', 'b-alt', 'b-NEU');
  // P25-T15: P6-T48 -> lebende planlose Reservierung ist nur Hinweis; der leere Traeger mit Wait ist ein Altfall
  const b1 = await legeAltfallWaitAn(pool, { project: PROJECT, waitingAgent: W, primaryAgent: F, expiresSek: 300, ops: [opB] });
  const traeger = b1.plan_id;
  const wait = b1.coedit_waits?.[0];
  pruefe(b1.total_ops === 0 && b1.coedit_waits?.length === 1 && wait?.primary_agent === F,
    'P25-T15 file-batch-reservierung-ablauf.test.mjs B1: Altfall leerer Traeger mit einem Wait auf lebende fremde Reservierung', b1);

  // ===== B2 Wiederholung, solange der Altfall-Wait lebt (P25-T15 / P6-T48) =====
  const zahlVorB2 = await planZahl();
  const b2 = await batch.planBatch({ project: PROJECT, agent_id: W, ops: [opB] });
  pruefe(b2.plan_id !== traeger && b2.total_ops === 1 && (b2.coedit_waits ?? []).length === 0
    && b2.reservation_hint?.files?.[0]?.reserviert_von === F && (await planZahl()) === zahlVorB2 + 1,
    'P25-T15 file-batch-reservierung-ablauf.test.mjs B2: erneuter plan schreibt sofort in EINEN neuen Plan mit Hinweis, kein weiterer leerer Traeger',
    { traeger, b2: b2.plan_id, total_ops: b2.total_ops, waits: b2.coedit_waits, hint: b2.reservation_hint, neu: (await planZahl()) - zahlVorB2 });
  const waitsB2 = (await pool.query(
    `SELECT wait_token::text AS t, jsonb_array_length(deferred_ops)::int AS n, deferred_op_indexes AS idx FROM file_batch_waits
      WHERE project = $1 AND waiting_agent = $2 AND status <> 'closed' AND $3 = ANY(shared_files)`,
    [PROJECT, W, 'src/b.ts'],
  )).rows;
  pruefe(waitsB2.length === 1 && waitsB2[0].n === 1 && waitsB2[0].idx.length === 1,
    'B2: der Altfall-Wait bleibt unveraendert, enthaelt die Op genau einmal (keine Dublette)', waitsB2);

  // ===== B3 plan_status-Long-Poll wacht beim Ablauf auf =====
  const b3vorher = batch.buildPlanStatusResponse(await batch.getBatchPlan(traeger));
  pruefe(b3vorher.coedit_waits?.[0]?.wait_status === 'waiting', 'B3: vor Ablauf wait_status waiting', b3vorher.coedit_waits);
  await reservierungAblaufen(F, 'src/b.ts', 3);
  const t0 = Date.now();
  const b3 = await batch.pollPlanStatus({ plan_id: traeger, wait_seconds: 12 });
  const dauer = (Date.now() - t0) / 1000;
  pruefe(b3.changed === true && dauer >= 2 && dauer < 9 && b3.coedit_waits?.[0]?.wait_status === 'expired',
    'B3: plan_status mit wait_seconds wacht beim Ablauf auf, wait_status expired', { changed: b3.changed, dauer, waits: b3.coedit_waits });
  pruefe(typeof b3.coedit_waits_abgelaufen === 'string' && b3.coedit_waits_abgelaufen.includes(traeger),
    'B3: Hinweis nennt den Weg (erneut planen, Traeger wird wiederverwendet)', b3.coedit_waits_abgelaufen);

  // ===== B4 shared_plan_status-Long-Poll =====
  // Neue lebende Reservierung + neuer Wait auf eigener Datei, damit B4 unabhaengig von B3 ist.
  await anlegen('src/b4.ts', 'b4-alt\n');
  await res.addFileReservations({ project: PROJECT, agentId: F, filePaths: ['src/b4.ts'] });
  const b4p = await legeAltfallWaitAn(pool, { project: PROJECT, waitingAgent: 'ab-warte4', primaryAgent: F, expiresSek: 300, ops: [sr('src/b4.ts', 'b4-alt', 'b4-NEU')] });
  const b4token = b4p.coedit_waits?.[0]?.wait_token;
  await reservierungAblaufen(F, 'src/b4.ts', 3);
  const t4 = Date.now();
  const b4 = await versuch(() => batch.getSharedPlanStatus({ project: PROJECT, wait_token: b4token, agent_id: 'ab-warte4', wait_seconds: 12 }));
  const dauer4 = (Date.now() - t4) / 1000;
  pruefe(b4.changed === true && dauer4 >= 2 && dauer4 < 9 && b4.status === 'expired',
    'B4: shared_plan_status mit wait_seconds wacht beim Ablauf auf, status expired', { changed: b4.changed, dauer4, status: b4.status, err: b4.error });
  await versuch(() => batch.cancelBatch(b4p.plan_id, 'ab-warte4', 'Testende B4'));

  // ===== B5 nach Ablauf (P25-T15 / P6-T48): Altfall-Traeger meldet nothing_written, der neue Plan schreibt genau einmal =====
  const b5t = await versuch(() => batch.commitBatch({ plan_id: traeger, agent_id: W }));
  pruefe(b5t.success === false && b5t.error === 'nothing_written' && b5t.grund === 'abgelaufen' && b5t.ops_zum_neu_planen?.[0]?.replace === 'b-NEU',
    'P25-T15 file-batch-reservierung-ablauf.test.mjs B5: abgelaufener Altfall-Traeger meldet nothing_written mit ops_zum_neu_planen', b5t);
  const b5c = await versuch(() => batch.commitBatch({ plan_id: b2.plan_id, agent_id: W }));
  const b = await inhalt('src/b.ts');
  pruefe(b5c.success === true && vorkommen(b, 'b-NEU') === 1 && vorkommen(b, 'b-alt') === 0,
    'B5: commit des neuen Plans schreibt die Op genau einmal', { b5c, b });

  // ===== C1 Aufraeumen =====
  await anlegen('src/c.ts', 'c\n');
  await pool.query(`INSERT INTO agent_sessions (id, project, status, registered_at) VALUES ('ab-c-lebt', $1, 'active', NOW())`, [PROJECT]);
  // P25-T15: Grace gilt nur fuer planbehaftete Reservierungen -> 'ab-c-grace' reserviert mit offenem Plan,
  // 'ab-c-planlos' ist planlos und innerhalb der alten Grace abgelaufen (wird sofort frei).
  const graceplan = (await pool.query(
    `INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews) VALUES($1,'ab-c-grace','[]','{}','[]') RETURNING id::text AS id`,
    [PROJECT],
  )).rows[0].id;
  for (const agent of ['ab-c-alt', 'ab-c-planlos', 'ab-c-lebt', WEG]) {
    await res.addFileReservations({ project: PROJECT, agentId: agent, filePaths: ['src/c.ts'] });
  }
  await res.addFileReservations({ project: PROJECT, agentId: 'ab-c-grace', filePaths: ['src/c.ts'], planId: graceplan });
  await reservierungAblaufen('ab-c-planlos', 'src/c.ts', -60);
  await reservierungAblaufen('ab-c-alt', 'src/c.ts', -3600);
  await reservierungAblaufen('ab-c-grace', 'src/c.ts', -60);
  const aufr = typeof res.releaseStaleFileReservations === 'function'
    ? await res.releaseStaleFileReservations({ project: PROJECT })
    : { fehlt: true };
  const offen = (await pool.query(
    `SELECT agent_id FROM file_reservations WHERE project = $1 AND file_path = 'src/c.ts' AND released_at IS NULL ORDER BY agent_id`,
    [PROJECT],
  )).rows.map((r) => r.agent_id);
  pruefe(JSON.stringify(offen) === JSON.stringify(['ab-c-grace', 'ab-c-lebt']),
    'P25-T15 file-batch-reservierung-ablauf.test.mjs C1: abgelaufen (planlos sofort, mit Plan nach Grace) und abgemeldet frei; planbehaftet in der Grace und lebend bleiben', { aufr, offen });
  pruefe(aufr.abgelaufen >= 1 && aufr.abgemeldet >= 1, 'C1: Zaehler nennt beide Gruende', aufr);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await aufraeumen().catch(() => {});
  await pool.end().catch(() => {});
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : `ERGEBNIS ${fehler} Zusage(n) verletzt`);
process.exit(fehler === 0 ? 0 : 1);
