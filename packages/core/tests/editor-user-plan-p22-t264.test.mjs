/**
 * P22-T264: Web-Editor-User-Plan - editor-user-plan.ts und die Ausnahmen fuer belegte User-Plaene in file-batch.ts.
 * Herkunft: User 2a26e5e1 + 2d18aa69 (U1-U4), Entwurf aa478ab3, Entscheidungen #t128-team 34558, 34559, 34561, 34565, 34567, 34569, 34580.
 * Prueft (je Assertion Herkunft + erwartet/tatsaechlich):
 *   A speichereEditorUserPlan: nur mit Web-Editor-Herkunft (user-herkunft.ts); maskierte Datei nur lesbar; EIN offener files-Plan
 *     (owner user, editor_userplan, Co-Edit an, expected_hashes = Abbild-Hash); gezielte search_replace-Op (U1); keine Reservierung/kein Wait.
 *   B U2: zweite Datei und erneutes Speichern -> dieselbe plan_id; Drei-Wege leseEditorUserPlanDatei.
 *   C file-batch.ts findJoinableSharedPlans: Agentenplan auf derselben Datei tritt NICHT automatisch bei (34561).
 *   D sendeEditorPruefauftrag: Inbox an den aktiven Koordinator (U3).
 *   E commitBatch: Fremder ohne Ausweis -> fremder_plan.
 *   F Korrektur: plan_update mit op_index ersetzt eine User-Op (c), gleiche plan_id (d); coedit_add ohne Wait (a).
 *   G commitBatch durch aktiven Projektagenten: Dateien geschrieben, agent_note "Autor: user ... Committer".
 *   H Drift: commit -> editor_userplan_drift, Plan bleibt open (kein stale), Grund in der User-Inbox (34558 (3)).
 *   I Ruecknahme: Entwurf == Basis -> Antwort null (UI-Vertrag), Plan cancelled, leseEditorUserPlan null.
 * Nur synapse_test (Port 5433), eigenes Testprojekt; braucht core/dist (pnpm run build in packages/core). Kein Daemon/Browser.
 *   DATABASE_URL=postgres://<user>:<pw>@<host>:5433/synapse_test node packages/core/tests/editor-user-plan-p22-t264.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433', 'P22-T264 Testziel Port 5433'); assert.equal(url.pathname, '/synapse_test', 'P22-T264 Testziel synapse_test');
const db = await import('../dist/db/client.js');
const S = await import('../dist/services/editor-user-plan.js');
const A = await import('../dist/services/editor-abbild.js');
const F = await import('../dist/services/file-batch.js');
const H = await import('../dist/services/user-herkunft.js');
const B = await import('../dist/services/agent-bezug.js');
const pool = db.getPool(), project = 'test-p22-t264-' + randomUUID();
const koord = randomUUID(), agent = randomUUID();
const ctx = (id, rolle, fn) => B.mitAgentAufrufKontext({ principal: { art: 'identity', project, agent_id: id, identity_id: id, rolle, modell: null, context_epoch: 1, lauf_id: null },
  bezug: { modus: 'neu', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null } }, fn);
const user = (fn) => H.mitUserHerkunft('web-ui-editor', fn);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const debug = (x) => JSON.stringify(x)?.slice(0, 700);
const insert = (path, text) => pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)',
  [randomUUID(), project, path, 'txt', Buffer.byteLength(text), text, hash(text)]);
const setze = (path, text) => pool.query('UPDATE code_files SET content=$3,content_hash=$4 WHERE project=$1 AND file_path=$2', [project, path, text, hash(text)]);
const inhalt = async (path) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [project, path])).rows[0]?.content;
const planZeile = async (id) => (await pool.query(
  'SELECT id::text AS id, owner_agent_id, owner_identity_id, status::text AS status, open_for_coedit, editor_userplan, ops, expected_hashes FROM file_batch_plans WHERE id=$1::bigint', [id])).rows[0];
const inboxAnzahl = async () => Number((await pool.query('SELECT count(*)::int AS n FROM specialist_inbox WHERE project=$1', [project])).rows[0].n);
const nebenwirkung = async () => (await pool.query(
  'SELECT (SELECT count(*)::int FROM file_reservations WHERE project=$1) AS r, (SELECT count(*)::int FROM file_batch_waits WHERE project=$1) AS w', [project])).rows[0];

try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'test-p22-t264', '/tmp/p22-t264-' + randomUUID()]);
  for (const [id, rolle] of [[koord, 'koordinator'], [agent, 'subagent']])
    await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,$1,$1,$3,'aktiv','test')", [id, project, rolle]);
  await insert('src/a.txt', 'eins\nzwei\ndrei\n'); await insert('src/b.txt', 'b1\nb2\n'); await insert('.env', 'SECRET=geheim\n');
  const abbild = await A.erstelleEditorAbbild(project);

  // A - Herkunft, Maske, erster User-Plan (thought 2a26e5e1: normaler offener files-Plan; 34559: Co-Edit an).
  await assert.rejects(() => S.speichereEditorUserPlan(project, abbild.id, 'src/a.txt', 'eins\nZWEI\ndrei\n'), /nur_web_editor/,
    'P22-T264 editor-user-plan.ts speichereEditorUserPlan: ohne Web-Editor-Herkunft abgelehnt');
  await assert.rejects(() => user(() => S.speichereEditorUserPlan(project, abbild.id, '.env', 'SECRET=neu\n')), /maskierte_datei_nur_lesbar/,
    'P22-T264 editor-user-plan.ts speichereEditorUserPlan: maskierte Datei bleibt nur lesbar');
  await assert.rejects(() => user(() => S.speichereEditorUserPlan(project, abbild.id, 'src/a.txt', 'eins\nzwei\ndrei\n')), /keine_aenderung/,
    'P22-T264 editor-user-plan.ts speichereEditorUserPlan: ohne Aenderung kein Plan');
  const p1 = await user(() => S.speichereEditorUserPlan(project, abbild.id, 'src/a.txt', 'eins\nZWEI\ndrei\n'));
  const z1 = await planZeile(p1.plan_id);
  assert.ok(z1 && z1.owner_agent_id === 'user' && !z1.owner_identity_id && z1.status === 'open' && z1.open_for_coedit === true && z1.editor_userplan === true,
    'P22-T264 file-batch.ts schreibeEditorUserPlan: offener files-Plan des Users mit Co-Edit, tatsaechlich ' + debug(z1));
  assert.equal(z1.expected_hashes['src/a.txt'], hash('eins\nzwei\ndrei\n'), 'P22-T264 file-batch.ts schreibeEditorUserPlan: expected_hash = Abbild-Hash, tatsaechlich ' + debug(z1.expected_hashes));
  assert.ok(z1.ops.length === 1 && z1.ops[0].action === 'search_replace' && z1.ops[0].agent_id === 'user' && !z1.ops[0].search.includes('drei'),
    'P22-T264 editor-plan-diff.ts U1: gezielte Op statt ganzer Datei, tatsaechlich ' + debug(z1.ops));
  assert.deepEqual(await nebenwirkung(), { r: 0, w: 0 }, 'P22-T264 schreibeEditorUserPlan: keine Reservierung, kein Wait (680ffa06)');

  // B - U2: zweite Datei und erneutes Speichern haengen an dieselbe plan_id (Koordinator 34567 (2)).
  const p2 = await user(() => S.speichereEditorUserPlan(project, abbild.id, 'src/b.txt', 'b1\nB2\n'));
  assert.equal(p2.plan_id, p1.plan_id, 'P22-T264 U2 speichereEditorUserPlan: zweite Datei -> dieselbe plan_id, tatsaechlich ' + debug(p2));
  assert.deepEqual(p2.dateien.map((d) => d.file_path).sort(), ['src/a.txt', 'src/b.txt'], 'P22-T264 leseEditorUserPlan: beide Dateien, tatsaechlich ' + debug(p2));
  const p3 = await user(() => S.speichereEditorUserPlan(project, abbild.id, 'src/a.txt', 'EINS\nZWEI\ndrei\n'));
  assert.equal(p3.plan_id, p1.plan_id, 'P22-T264 U2: erneutes Speichern -> dieselbe plan_id, tatsaechlich ' + debug(p3));
  const d3 = await S.leseEditorUserPlanDatei(project, 'src/a.txt');
  assert.ok(d3 && d3.basis === 'eins\nzwei\ndrei\n' && d3.entwurf === 'EINS\nZWEI\ndrei\n' && d3.aktuell === 'eins\nzwei\ndrei\n' && d3.konflikt === false,
    'P22-T264 leseEditorUserPlanDatei: Drei-Wege Basis/Entwurf/aktuell, tatsaechlich ' + debug(d3));

  // C - kein automatischer Beitritt eines Agentenplans (34561), kein Wait.
  const agentPlan = await ctx(agent, 'subagent', () => F.planBatch({ project, agent_id: agent, ops: [{ file_path: 'src/b.txt', action: 'search_replace', search: 'b1', replace: 'b1-agent' }] }));
  assert.notEqual(String(agentPlan.plan_id), p1.plan_id, 'P22-T264 file-batch.ts findJoinableSharedPlans: User-Plan kein Auto-Ziel, tatsaechlich ' + debug(agentPlan));
  assert.equal((await nebenwirkung()).w, 0, 'P22-T264 file-batch.ts: Agentenplan erzeugt keinen Wait auf den User-Plan');
  await ctx(agent, 'subagent', () => F.cancelBatch(String(agentPlan.plan_id), agent));

  // D - ausdruecklicher Pruefauftrag (U3) an den aktiven Koordinator.
  await assert.rejects(() => S.sendeEditorPruefauftrag(project, p1.plan_id, 'x'), /nur_web_editor/, 'P22-T264 sendeEditorPruefauftrag: nur Web-Editor');
  const vorAuftrag = await inboxAnzahl();
  const auftrag = await user(() => S.sendeEditorPruefauftrag(project, p1.plan_id, 'Bitte Formatierung pruefen'));
  assert.equal(auftrag.koordinatoren_benachrichtigt, 1, 'P22-T264 sendeEditorPruefauftrag: 1 Koordinator, tatsaechlich ' + debug(auftrag));
  assert.equal(await inboxAnzahl(), vorAuftrag + 1, 'P22-T264 sendeEditorPruefauftrag: eine Inbox-Zeile');

  // E - Fremder ohne Ausweis darf den User-Plan nicht committen (kein allgemeines Fremdplanrecht, 34558 (1)).
  const fremd = await F.commitBatch({ plan_id: p1.plan_id, agent_id: 'fremd-legacy-p22-t264' });
  assert.equal(fremd.error, 'fremder_plan', 'P22-T264 file-batch.ts commitBatchOnce: Fremder ohne Ausweis abgelehnt, tatsaechlich ' + debug(fremd));

  // F - Korrektur durch beigetretenen Agenten (34569 (a), (c), (d)).
  const idxB = (await planZeile(p1.plan_id)).ops.findIndex((o) => o.file_path === 'src/b.txt');
  const korr = await ctx(agent, 'subagent', () => F.replanBatch({ project, plan_id: p1.plan_id, agent_id: agent, op_index: idxB,
    ops: [{ file_path: 'src/b.txt', action: 'search_replace', search: 'b2', replace: 'B2-korrigiert' }] }));
  assert.equal(String(korr.plan_id), p1.plan_id, 'P22-T264 file-batch.ts replanBatch (d): gleiche plan_id, tatsaechlich ' + debug(korr));
  assert.equal((await planZeile(p1.plan_id)).ops[idxB].agent_id, agent, 'P22-T264 file-batch.ts updatePlanInPlace (c): User-Op durch Agent ersetzt');
  const add = await ctx(agent, 'subagent', () => F.addCoeditContribution({ project, plan_id: p1.plan_id, agent_id: agent,
    ops: [{ file_path: 'src/a.txt', action: 'search_replace', search: 'drei', replace: 'drei-agent' }] }));
  assert.ok(add.success === true && add.appended_ops === 1 && String(add.plan_id) === p1.plan_id, 'P22-T264 file-batch.ts addCoeditContributionKern (a): ohne Wait, tatsaechlich ' + debug(add));

  // G - Commit durch aktiven Projektagenten; Historie: User Autor, Agent Committer (34558 (2)).
  const commit = await ctx(agent, 'subagent', () => F.commitBatch({ plan_id: p1.plan_id, agent_id: agent }));
  assert.equal(commit.success, true, 'P22-T264 file-batch.ts commitBatchOnce: aktiver Projektagent committet, tatsaechlich ' + debug(commit));
  assert.equal(await inhalt('src/a.txt'), 'EINS\nZWEI\ndrei-agent\n', 'P22-T264 commit: src/a.txt');
  assert.equal(await inhalt('src/b.txt'), 'b1\nB2-korrigiert\n', 'P22-T264 commit: src/b.txt');
  const noten = (await pool.query('SELECT agent_note FROM file_versions WHERE project=$1 AND batch_id=$2::bigint', [project, p1.plan_id])).rows;
  assert.ok(noten.length > 0 && noten.every((r) => /Autor: user/.test(r.agent_note ?? '') && r.agent_note.includes(agent)),
    'P22-T264 file-batch.ts commitBatchOnce: agent_note Autor user + Committer, tatsaechlich ' + debug(noten));

  // H - Drift: Plan bleibt offen, Grund an den User (34558 (3), 34569 (b)).
  const abbild2 = await A.erstelleEditorAbbild(project);
  const pd = await user(() => S.speichereEditorUserPlan(project, abbild2.id, 'src/a.txt', 'EINS\nZWEI\ndrei-agent\nvier\n'));
  assert.notEqual(pd.plan_id, p1.plan_id, 'P22-T264: nach dem Commit entsteht ein neuer User-Plan');
  await setze('src/a.txt', 'anders\n');
  const vorDrift = await inboxAnzahl();
  const drift = await ctx(agent, 'subagent', () => F.commitBatch({ plan_id: pd.plan_id, agent_id: agent }));
  assert.ok(drift.success === false && drift.error === 'editor_userplan_drift', 'P22-T264 file-batch.ts commitLegacyBody: Drift, tatsaechlich ' + debug(drift));
  assert.equal((await planZeile(pd.plan_id)).status, 'open', 'P22-T264 file-batch.ts: User-Plan bleibt bei Drift offen (kein stale)');
  assert.ok(await inboxAnzahl() > vorDrift, 'P22-T264 file-batch.ts meldeEditorUserPlanFehler: Grund in der User-Inbox');
  const dd = await S.leseEditorUserPlanDatei(project, 'src/a.txt');
  assert.ok(dd && dd.konflikt === true && dd.basis === 'EINS\nZWEI\ndrei-agent\n' && dd.aktuell === 'anders\n', 'P22-T264 leseEditorUserPlanDatei: Konflikt sichtbar, tatsaechlich ' + debug(dd));

  // I - Ruecknahme: Entwurf == Basis -> leerer Plan wird verworfen.
  const rueck = await user(() => S.speichereEditorUserPlan(project, abbild2.id, 'src/a.txt', 'EINS\nZWEI\ndrei-agent\n'));
  assert.equal(rueck, null, 'P22-T264 speichereEditorUserPlan: Ruecknahme liefert null (ProjektEditor d.plan), tatsaechlich ' + debug(rueck));
  assert.equal((await planZeile(pd.plan_id)).status, 'cancelled', 'P22-T264 schreibeEditorUserPlan: leerer User-Plan verworfen');
  assert.equal(await S.leseEditorUserPlan(project), null, 'P22-T264 leseEditorUserPlan: kein offener User-Plan mehr');
  console.log('P22-T264 editor-user-plan: alle Pruefungen gruen');
} finally {
  // Aufraeumen auch frueherer Laeufe (Muster test-p22-t264-%); agent_events vor agent_identitaeten (Fremdschluessel).
  for (const sql of ['DELETE FROM specialist_inbox WHERE project LIKE $1', 'DELETE FROM agent_events WHERE project LIKE $1', 'DELETE FROM file_batch_waits WHERE project LIKE $1',
    'DELETE FROM file_reservations WHERE project LIKE $1', 'DELETE FROM file_versions WHERE project LIKE $1', 'DELETE FROM file_batch_plans WHERE project LIKE $1',
    'DELETE FROM editor_abbilder WHERE project LIKE $1', 'DELETE FROM agent_identitaeten WHERE project LIKE $1', 'DELETE FROM code_files WHERE project LIKE $1',
    'DELETE FROM projects WHERE name LIKE $1'])
    await pool.query(sql, ['test-p22-t264-%']).catch((e) => console.error('P22-T264 Aufraeumen fehlgeschlagen:', sql, e.message));
  await pool.end();
}
