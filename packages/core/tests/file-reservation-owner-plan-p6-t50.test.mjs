/**
 * P6-T50 (26.10.2026, Befund P25-T15 cf2fd83f): Reservierung des Owners, die NICHT in seinem offenen Plan steht.
 *   A Owner reserviert n1+n2, plant danach nur n1 -> ein Dritter auf n2 bekommt einen Wait mit Ziel = Owner-Plan
 *     (P6-T48 Punkt 2 / Fix acc82f49 T9/T12a; seit P6-T48 bis P6-T50 schrieb er sofort, Regression).
 *   B Owner reserviert n3 erst NACH seinem Plan -> neue, eigene Absicht: nur Hinweis, der Dritte schreibt sofort
 *     (P6-T48 Punkt 1; file-batch.ts reservierungenMitOffenemPlan, created_at >= reserved_at).
 *   C Owner ohne offenen Plan -> nur Hinweis (P6-T48 Punkt 1, Kontrollfall).
 * Nur synapse_test:5433, eigenes Wegwerf-Projekt, am Ende aufgeraeumt.
 * AUFRUF: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node packages/core/tests/file-reservation-owner-plan-p6-t50.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';

pruefeTestDbUrl('file-reservation-owner-plan-p6-t50.test');
const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();
const PROJECT = 'p6-t50-' + process.pid;

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
const sr = (f, search, replace) => ({ file_path: f, action: 'search_replace', search, replace });
async function anlegen(p) {
  const x = await batch.planBatch({ project: PROJECT, agent_id: 't50-setup', ops: [{ file_path: p, action: 'create', content: 'a\nb\nc\n' }] });
  await batch.commitBatch({ plan_id: x.plan_id, agent_id: 't50-setup' });
}
async function aufraeumen() {
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)', [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
  }
}

try {
  if ((await pool.query('SELECT current_database() AS d')).rows[0].d !== 'synapse_test') throw new Error('nicht synapse_test');
  for (const f of ['n1.ts', 'n2.ts', 'n3.ts', 'c1.ts']) await anlegen(f);

  // ===== A reservieren, dann planen =====
  await res.addFileReservations({ project: PROJECT, agentId: 't50-owner', filePaths: ['n1.ts', 'n2.ts'] });
  await new Promise((r) => setTimeout(r, 20)); // created_at des Plans sicher nach reserved_at
  const po = await batch.planBatch({ project: PROJECT, agent_id: 't50-owner', ops: [sr('n1.ts', 'a', 'A')] });
  const wa = await batch.planBatch({ project: PROJECT, agent_id: 't50-dritter', ops: [sr('n2.ts', 'b', 'B')] });
  pruefe(wa.total_ops === 0 && wa.coedit_waits?.length === 1 && wa.coedit_waits[0].target_plan_id === po.plan_id && !wa.reservation_hint,
    'P6-T50 file-batch.ts reservierungenMitOffenemPlan A: vor dem Plan reservierte Datei -> Wait auf den Owner-Plan', wa);
  const add = await batch.addCoeditContribution({ project: PROJECT, plan_id: po.plan_id, wait_token: wa.coedit_waits?.[0]?.wait_token, agent_id: 't50-dritter', ops: [sr('n2.ts', 'b', 'B')] });
  pruefe(add.success === true, 'P6-T50 A: coedit_add erweitert den Owner-Plan um n2.ts', add);

  // ===== B erst NACH dem Plan reserviert =====
  await new Promise((r) => setTimeout(r, 20));
  await res.addFileReservations({ project: PROJECT, agentId: 't50-owner', filePaths: ['n3.ts'] });
  const wb = await batch.planBatch({ project: PROJECT, agent_id: 't50-dritter', ops: [sr('n3.ts', 'c', 'C')] });
  pruefe(wb.total_ops === 1 && !wb.coedit_waits?.length && wb.reservation_hint?.files?.[0]?.reserviert_von === 't50-owner',
    'P6-T50 B: nach dem Plan reservierte Datei -> nur Hinweis, sofort geplant (P6-T48 Punkt 1)', wb);

  // ===== C Owner ohne offenen Plan =====
  await res.addFileReservations({ project: PROJECT, agentId: 't50-ohneplan', filePaths: ['c1.ts'] });
  const wc = await batch.planBatch({ project: PROJECT, agent_id: 't50-dritter', ops: [sr('c1.ts', 'a', 'X')] });
  pruefe(wc.total_ops === 1 && !wc.coedit_waits?.length && wc.reservation_hint?.files?.[0]?.reserviert_von === 't50-ohneplan',
    'P6-T50 C: Reservierender ohne offenen Plan -> nur Hinweis (Kontrollfall P6-T48 Punkt 1)', wc);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await aufraeumen().catch((e) => console.error('Aufraeumen: ' + e.message));
  await pool.end().catch(() => {});
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : `ERGEBNIS ${fehler} Zusage(n) verletzt`);
process.exit(fehler === 0 ? 0 : 1);
