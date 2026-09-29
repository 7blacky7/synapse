/**
 * BEFUND 693bbf48 (Ausfalltest 29.09.2026, Projekt coedit-test) — nachgestellt im
 * Wegwerf-Projekt PROJECT gegen die ECHTE Datenbank.
 *
 * Szenario 1 (genau der Ablauf aus dem Befund):
 *   B plant P2 auf beta.ts (1 Op ueber betaEins). C plant, wird per Wait gefuehrt und
 *   traegt 2 Ops bei (betaDrei disjunkt, betaEins = gleicher Anker). C faellt aus.
 *   B committet -> coedit_conflict. B zieht per cancel zurueck (withdrawn).
 *   BUG 1: P2 darf danach KEINE veralteten failed_ops/Konflikte tragen -> committbar.
 *   BUG 2: Owner geht an den verbleibenden Beitragenden (C); B wird beim erneuten Planen
 *          in P2 gefuehrt (Wait, target_plan_id), kein Parallelplan.
 *   (a) plan_status zeigt overlap_warnings und den Wait-Status je Beitragendem.
 *   (b) plan-Antwort des Wartenden und shared_plan_status nennen die Ziel-Plan-ID.
 *   (c) commit-Antwort nennt die freigegebenen Reservierungen.
 * Szenario 2 (BUG 3): zieht ein Beitragender zurueck, werden sein leerer Traegerplan und
 *   sein Wait geschlossen; wird der Ziel-Plan ganz verworfen, ebenso die der anderen.
 * Szenario 3 (d): der plan-Aufruf eines Wartenden verlaengert die Reservierung des
 *   (evtl. ausgefallenen) Owners NICHT — nur echte eigene Aktivitaet verlaengert.
 * Szenario 4 (e): ein ersetzter Entwurf zeigt keinen "Korrigieren"-Hinweis mehr, sondern
 *   den Folgeplan.
 *
 * AUFRUF: node packages/core/tests/file-batch-fix-693bbf48.test.mjs
 * Exit 0 = alle Zusagen erfuellt, Exit 1 = mindestens eine verletzt.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'fix693-test';
const B = 'f6-b';
const C = 'f6-c';
const A2 = 'f6-a2';
const D = 'f6-d';
const E = 'f6-e';
const H = 'f6-h';
const K = 'f6-k';
const X = 'f6-x';

const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(bedingung, text, detail) {
  if (bedingung) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

async function aufraeumen() {
  const zaehler = {};
  for (const tabelle of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) {
    zaehler[tabelle] = (await pool.query(`DELETE FROM ${tabelle} WHERE project = $1`, [PROJECT])).rowCount;
  }
  zaehler.agent_events = (await pool.query(`DELETE FROM agent_events WHERE project = $1`, [PROJECT]).catch(() => ({ rowCount: 'n/a' }))).rowCount;
  return zaehler;
}
const inhalt = async (pfad) => (await pool.query('SELECT content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [PROJECT, pfad])).rows[0]?.content ?? null;
const zeile = async (id) => (await pool.query('SELECT status::text AS status, owner_agent_id, ops, reason FROM file_batch_plans WHERE id = $1', [id])).rows[0] ?? null;
async function anlegen(pfad, text) {
  const p = await batch.planBatch({ project: PROJECT, agent_id: 'f6-setup', ops: [{ file_path: pfad, action: 'create', content: text }] });
  const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: 'f6-setup' });
  if (!c.success) throw new Error('anlegen ' + pfad + ': ' + JSON.stringify(c));
}
const rl = (pfad, line, anker, text, reason) => ({ file_path: pfad, action: 'replace_lines', line_start: line, line_end: line, content: text, anchor_text: anker, ...(reason ? { reason } : {}) });

try {
  console.log('VORHER  ' + JSON.stringify(await aufraeumen()));
  await anlegen('src/beta.ts', 'export function betaEins() {}\nexport function betaZwei() {}\nexport function betaDrei() {}\n');
  await anlegen('src/gamma.ts', 'g1\ng2\ng3\n');
  await anlegen('src/delta.ts', 'd1\nd2\n');
  await anlegen('src/eps.ts', 'e1\ne2\n');

  // ===== Szenario 1 =====
  await res.addFileReservations({ project: PROJECT, agentId: B, filePaths: ['src/beta.ts'] });
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: B, reason: 'B: P2', ops: [rl('src/beta.ts', 1, 'export function betaEins() {}', 'export function betaEins() { return "b1"; }')] });
  const opCA = rl('src/beta.ts', 3, 'export function betaDrei() {}', 'export function betaDrei() { return "c3"; }', 'C: betaDrei');
  const opCB = rl('src/beta.ts', 1, 'export function betaEins() {}', 'export function betaEins() { return "c1"; }', 'C: betaEins');
  const pc = await batch.planBatch({ project: PROJECT, agent_id: C, reason: 'C: Beitrag', ops: [opCA, opCB] });
  pruefe(pc.total_ops === 0 && pc.coedit_waits?.length === 1, '1: C wird per Wait gefuehrt', pc);
  pruefe(pc.coedit_waits?.[0]?.target_plan_id === p2.plan_id, '1(b): plan-Antwort des Wartenden nennt die Ziel-Plan-ID', pc.coedit_waits);
  const sps = await batch.getSharedPlanStatus({ project: PROJECT, wait_token: pc.coedit_waits?.[0]?.wait_token, agent_id: C }).catch((e) => ({ fehler: e.message }));
  pruefe(sps.target_plan_id === p2.plan_id, '1(b): shared_plan_status nennt die Ziel-Plan-ID vor dem Beitritt', sps);
  const addC = await batch.addCoeditContribution({ project: PROJECT, plan_id: p2.plan_id, agent_id: C, ops: [opCA, opCB] });
  pruefe(addC.success === true && (addC.overlap_warnings ?? []).length === 1, '1: coedit_add meldet die Ueberlappung (same_anchor)', addC.overlap_warnings);
  const st1 = batch.buildPlanStatusResponse(await batch.getBatchPlan(p2.plan_id));
  pruefe((st1.overlap_warnings ?? []).length === 1, '1(a): plan_status zeigt overlap_warnings auch spaeter', st1.overlap_warnings);
  pruefe((st1.contributions ?? []).some((c) => c.agent_id === C && c.wait_status === 'linked'), '1(a): plan_status zeigt Wait-/Ready-Status je Beitragendem', st1.contributions);

  // C faellt aus. B committet -> Konflikt, dann Rueckzug.
  const c1 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: B });
  pruefe(c1.success === false && c1.error === 'coedit_conflict', '1: commit endet gewollt in coedit_conflict', c1.error);
  const w = await batch.cancelBatch(p2.plan_id, B, 'B zieht ueberlappende Op zurueck');
  pruefe(w.mode === 'withdrawn' && w.withdrawn_ops === 1, '1: B zieht seine Op zurueck (withdrawn)', w);
  const st2 = batch.buildPlanStatusResponse(await batch.getBatchPlan(p2.plan_id));
  pruefe(st2.status === 'open' && !(st2.failed_ops?.length), 'BUG 1: nach dem Rueckzug keine veralteten failed_ops/Konflikte', { status: st2.status, failed_ops: st2.failed_ops });
  pruefe((st2.overlap_warnings ?? []).length === 0, 'BUG 1: keine Ueberlappung mehr gemeldet (beide Ops von C)', st2.overlap_warnings);
  const z2 = await zeile(p2.plan_id);
  pruefe(z2?.owner_agent_id === C, 'BUG 2: Owner geht an den verbleibenden Beitragenden C', z2?.owner_agent_id);

  // B plant erneut auf die Pfade -> muss in P2 gefuehrt werden.
  const opB2 = rl('src/beta.ts', 2, 'export function betaZwei() {}', 'export function betaZwei() { return "b2"; }', 'B: betaZwei');
  const pb2 = await batch.planBatch({ project: PROJECT, agent_id: B, ops: [opB2] });
  pruefe(pb2.total_ops === 0 && pb2.coedit_waits?.[0]?.target_plan_id === p2.plan_id, 'BUG 2: der fruehere Owner B wird in den gemeinsamen Plan gefuehrt, kein Parallelplan', pb2);
  let addB = null;
  try { addB = await batch.addCoeditContribution({ project: PROJECT, plan_id: p2.plan_id, agent_id: B, ops: [opB2] }); } catch (e) { addB = { success: false, error: e.message }; }
  pruefe(addB?.success === true && addB?.total_plan_ops === 3, 'BUG 2: B traegt wieder zu P2 bei (3 Ops)', addB);

  const c2 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: B });
  pruefe(c2.success === true, 'BUG 1: P2 ist committbar (C ist weg, nie ready)', c2);
  pruefe(await inhalt('src/beta.ts') === 'export function betaEins() { return "c1"; }\nexport function betaZwei() { return "b2"; }\nexport function betaDrei() { return "c3"; }\n',
    '1: Datei enthaelt genau die nicht zurueckgezogenen Ops', await inhalt('src/beta.ts'));
  pruefe(Array.isArray(c2.released_reservations) && c2.released_reservations.some((r) => r.agent_id === B && r.file_path === 'src/beta.ts'),
    '1(c): commit-Antwort nennt die freigegebenen Reservierungen', c2.released_reservations);
  const offen1 = await pool.query(`SELECT id::text AS id FROM file_batch_plans WHERE project = $1 AND status = 'open' AND owner_agent_id = ANY($2::text[])`, [PROJECT, [B, C]]);
  pruefe(offen1.rows.length === 0, '1: keine offenen Rest-/Traegerplaene von B und C', offen1.rows);

  // ===== Szenario 2: BUG 3 =====
  await res.addFileReservations({ project: PROJECT, agentId: A2, filePaths: ['src/gamma.ts'] });
  const pa = await batch.planBatch({ project: PROJECT, agent_id: A2, ops: [rl('src/gamma.ts', 1, 'g1', 'G1-A')] });
  const opD = rl('src/gamma.ts', 3, 'g3', 'G3-D');
  const pd = await batch.planBatch({ project: PROJECT, agent_id: D, ops: [opD] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: pa.plan_id, agent_id: D, ops: [opD] });
  const wd = await batch.cancelBatch(pa.plan_id, D, 'D zieht zurueck');
  pruefe(wd.mode === 'withdrawn', '3: D zieht zurueck', wd);
  const pdRow = await zeile(pd.plan_id);
  const dWait = await pool.query('SELECT status FROM file_batch_waits WHERE project = $1 AND waiting_agent = $2', [PROJECT, D]);
  pruefe(pdRow?.status !== 'open' && dWait.rows.every((r) => !['waiting', 'linked'].includes(r.status)),
    'BUG 3: Traegerplan und Wait des Zurueckziehenden werden geschlossen', { plan: pdRow?.status, waits: dWait.rows });
  const opE = rl('src/gamma.ts', 2, 'g2', 'G2-E');
  const pe = await batch.planBatch({ project: PROJECT, agent_id: E, ops: [opE] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: pa.plan_id, agent_id: E, ops: [opE] });
  const wa = await batch.cancelBatch(pa.plan_id, A2, 'A2 zieht zurueck');
  pruefe(wa.mode === 'withdrawn' && (await zeile(pa.plan_id))?.owner_agent_id === E, '3: A2 zieht zurueck, Owner geht an E', { wa, owner: (await zeile(pa.plan_id))?.owner_agent_id });
  const we = await batch.cancelBatch(pa.plan_id, E, 'E verwirft');
  pruefe(we.mode === 'cancelled', '3: E verwirft den Plan ganz (keine fremden Ops mehr)', we);
  const peRow = await zeile(pe.plan_id);
  const eWait = await pool.query('SELECT status FROM file_batch_waits WHERE project = $1 AND waiting_agent = $2', [PROJECT, E]);
  pruefe(peRow?.status !== 'open' && eWait.rows.every((r) => !['waiting', 'linked'].includes(r.status)),
    'BUG 3: verworfener Ziel-Plan schliesst die Traegerplaene und Waits', { plan: peRow?.status, waits: eWait.rows });
  const offen2 = await pool.query(`SELECT id::text AS id FROM file_batch_plans WHERE project = $1 AND status = 'open' AND owner_agent_id = ANY($2::text[])`, [PROJECT, [A2, D, E]]);
  pruefe(offen2.rows.length === 0, 'BUG 3: keine offenen Leichen von A2, D, E', offen2.rows);

  // ===== Szenario 3: (d) =====
  await res.addFileReservations({ project: PROJECT, agentId: H, filePaths: ['src/delta.ts'] });
  await pool.query(
    `UPDATE file_reservations SET expires_at = NOW() + INTERVAL '2 minutes', last_extended_at = NOW() - INTERVAL '1 minute'
      WHERE project = $1 AND agent_id = $2 AND released_at IS NULL`, [PROJECT, H]);
  const vor = (await pool.query('SELECT expires_at FROM file_reservations WHERE project = $1 AND agent_id = $2 AND released_at IS NULL', [PROJECT, H])).rows[0]?.expires_at;
  const pk = await batch.planBatch({ project: PROJECT, agent_id: K, ops: [rl('src/delta.ts', 2, 'd2', 'D2-K')] });
  const nach = (await pool.query('SELECT expires_at FROM file_reservations WHERE project = $1 AND agent_id = $2 AND released_at IS NULL', [PROJECT, H])).rows[0]?.expires_at;
  pruefe((pk.coedit_waits ?? []).length === 1 && String(vor) === String(nach), '(d): der plan-Aufruf des Wartenden verlaengert die Reservierung des Owners nicht', { vor, nach });

  // ===== Szenario 4: (e) =====
  let entwurf = null;
  try { await batch.planBatch({ project: PROJECT, agent_id: X, ops: [rl('src/eps.ts', 1, 'e1', 'E1-X'), rl('src/eps.ts', 2, 'falsch', 'E2-X')] }); } catch (e) { entwurf = e; }
  const folge = await batch.replanBatch({ project: PROJECT, plan_id: entwurf?.plan_id, agent_id: X, op_index: 1, ops: [rl('src/eps.ts', 2, 'e2', 'E2-X')] });
  const st4 = batch.buildPlanStatusResponse(await batch.getBatchPlan(entwurf?.plan_id));
  pruefe(st4.status === 'cancelled' && !/Korrigieren/.test(st4.failed_hint ?? '') && st4.superseded_by === folge.plan_id,
    '(e): ersetzter Entwurf verweist auf den Folgeplan statt "Korrigieren"', { status: st4.status, failed_hint: st4.failed_hint, superseded_by: st4.superseded_by, folge: folge.plan_id });
  await batch.cancelBatch(folge.plan_id, X);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  const nachher = await aufraeumen().catch((e) => ({ fehler: String(e) }));
  console.log('AUFGERAEUMT ' + JSON.stringify(nachher));
  const rest = await pool.query(
    `SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project = $1) + (SELECT COUNT(*) FROM file_batch_waits WHERE project = $1)
          + (SELECT COUNT(*) FROM file_reservations WHERE project = $1) + (SELECT COUNT(*) FROM file_versions WHERE project = $1)
          + (SELECT COUNT(*) FROM code_files WHERE project = $1) AS n`, [PROJECT]);
  console.log('REST    ' + rest.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(rest.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
