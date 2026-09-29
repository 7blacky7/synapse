/**
 * BEFUNDE 875d6a8c (Stresstest), 036c979a (Restbefunde), 83e62b61 (alte Plaene) —
 * nachgestellt im Wegwerf-Projekt PROJECT gegen die ECHTE Datenbank.
 *
 *  S1  HAUPTBUG: ein Agent traegt in ZWEI gemeinsame Plaene (zwei Owner) bei. Vorher griff
 *      coedit_add auf den zweiten Plan den schon an den ersten gebundenen Wait
 *      ("Wait X ist bereits mit Plan Y verbunden") — auch nach Rueckzug und Neuplan.
 *  S2  (a) Wait auf einen Primaer ohne Plan wird an den spaeter entstehenden Plan gebunden;
 *      (b) sein leerer Traeger schliesst, wenn der Plan ohne ihn committet.
 *  S3  (c) PLAN_READY-Events zu committeten Plaenen sind erledigt (nicht mehr pending).
 *  S4  (d) withdraw-Meldung konsistent (geschlossen), Zurueckgezogener nicht mehr unter
 *      contributions, commit-Notiz zaehlt ihn nicht.
 *  S5  (036c979a-2) neuer Owner nach Wechsel steht nicht mehr als Wait in contributions.
 *  S6  (e) plan_status eines committeten Plans nennt committed_by und batch_id.
 *  S7  (036c979a-1) Legacy-commit nennt released_reservations.
 *  S8  (036c979a-3) geschlossener Traeger traegt Vermerk mit Anlass und Plan.
 *  S9  (036c979a-7) Long-Poll: shared_plan_status/plan_status mit wait_seconds warten bis
 *      zur Aenderung bzw. bis zur Frist.
 *  S10 (f) Erklaerung unterschiedlicher expires_at je Datei.
 *  S11 (g) reason gehoert nicht zum Op-Vergleich; bei echter Abweichung nennt die
 *      Ablehnung das Feld.
 *  S12 (83e62b61 + b) open_plans: neueste zuerst, Plaene ohne Aktivitaet > 7 Tage nur
 *      gezaehlt; offene leere Traeger werden gezaehlt statt unsichtbar.
 *
 * AUFRUF: node packages/core/tests/file-batch-fix-875d6a8c.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'fix875-test';

const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const hints = await import(join(dist, 'services', 'plan-hints.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(bedingung, text, detail) {
  if (bedingung) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
async function versuch(fn) { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), geworfen: true }; } }

async function aufraeumen() {
  const zaehler = {};
  zaehler.acks = (await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT])).rowCount;
  for (const tabelle of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) {
    zaehler[tabelle] = (await pool.query(`DELETE FROM ${tabelle} WHERE project = $1`, [PROJECT])).rowCount;
  }
  return zaehler;
}
const inhalt = async (pfad) => (await pool.query('SELECT content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [PROJECT, pfad])).rows[0]?.content ?? null;
const zeile = async (id) => (await pool.query('SELECT status::text AS status, owner_agent_id, reason FROM file_batch_plans WHERE id = $1', [id])).rows[0] ?? null;
async function anlegen(pfad, text) {
  const p = await batch.planBatch({ project: PROJECT, agent_id: 'f8-setup', ops: [{ file_path: pfad, action: 'create', content: text }] });
  const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: 'f8-setup' });
  if (!c.success) throw new Error('anlegen ' + pfad + ': ' + JSON.stringify(c));
}
const sechs = (p) => [1, 2, 3, 4, 5, 6].map((i) => `${p}${i}`).join('\n') + '\n';
const rl = (pfad, line, anker, text, reason) => ({ file_path: pfad, action: 'replace_lines', line_start: line, line_end: line, content: text, anchor_text: anker, ...(reason ? { reason } : {}) });

try {
  console.log('VORHER  ' + JSON.stringify(await aufraeumen()));
  for (const f of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']) await anlegen(`src/${f}.ts`, sechs(f + '-'));

  // ===== S1 Hauptbug =====
  const O1 = 'f8-o1', O2 = 'f8-o2', Z = 'f8-z', Z2 = 'f8-z2';
  await res.addFileReservations({ project: PROJECT, agentId: O1, filePaths: ['src/m1.ts'] });
  await res.addFileReservations({ project: PROJECT, agentId: O2, filePaths: ['src/m2.ts'] });
  const p1 = await batch.planBatch({ project: PROJECT, agent_id: O1, ops: [rl('src/m1.ts', 1, 'm1-1', 'O1')] });
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: O2, ops: [rl('src/m2.ts', 1, 'm2-1', 'O2')] });
  const zOps = [rl('src/m1.ts', 3, 'm1-3', 'Z1', 'z-grund'), rl('src/m2.ts', 3, 'm2-3', 'Z2', 'z-grund')];
  const pz = await batch.planBatch({ project: PROJECT, agent_id: Z, ops: zOps });
  pruefe(pz.total_ops === 0 && pz.coedit_waits?.length === 2, 'S1: Z bekommt einen Traeger mit zwei Waits (zwei Owner)', pz.coedit_waits);
  const a1 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p1.plan_id, agent_id: Z, ops: [zOps[0]] }));
  pruefe(a1.success === true, 'S1: Beitrag in den ersten Plan', a1);
  const a2 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p2.plan_id, agent_id: Z, ops: [zOps[1]] }));
  pruefe(a2.success === true, 'S1 HAUPTBUG: Beitrag in den ZWEITEN Plan gelingt', a2);
  // Z2: Beitrag in p1, Rueckzug, dann Beitrag in p2 (geschlossene Waits duerfen nicht stoeren)
  const z2Ops = [rl('src/m1.ts', 5, 'm1-5', 'ZZ1'), rl('src/m2.ts', 5, 'm2-5', 'ZZ2')];
  await batch.planBatch({ project: PROJECT, agent_id: Z2, ops: z2Ops });
  await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p1.plan_id, agent_id: Z2, ops: [z2Ops[0]] }));
  const wz2 = await batch.cancelBatch(p1.plan_id, Z2, 'Z2 raus aus p1');
  pruefe(wz2.mode === 'withdrawn', 'S1: Z2 zieht aus p1 zurueck', wz2);
  const b2 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p2.plan_id, agent_id: Z2, ops: [z2Ops[1]] }));
  pruefe(b2.success === true, 'S1: nach Rueckzug aus p1 gelingt der Beitrag zu p2', b2);

  // S4 (d): Meldung + contributions + commit-Notiz
  const cancelText = batch.buildCancelResponse(p1.plan_id, wz2).message;
  pruefe(!/wieder beitrittsf/.test(cancelText) && /geschlossen/.test(cancelText), 'S4(d): withdraw-Meldung sagt "geschlossen", nicht "wieder beitrittsfaehig"', cancelText);
  const st1 = batch.buildPlanStatusResponse(await batch.getBatchPlan(p1.plan_id));
  pruefe(!(st1.contributions ?? []).some((c) => c.agent_id === Z2), 'S4(d): Zurueckgezogener steht nicht mehr unter contributions', st1.contributions);
  await batch.markCoeditReady({ project: PROJECT, plan_id: p1.plan_id, agent_id: Z });
  const c1 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: O1 });
  pruefe(c1.success === true && !c1.coedit_note, 'S4(d): commit-Notiz zaehlt den geschlossenen Wait nicht mit', c1);
  const c2 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: O2 });
  pruefe(c2.success === true, 'S1: auch der zweite Plan committet', c2);
  pruefe(await inhalt('src/m1.ts') === 'O1\nm1-2\nZ1\nm1-4\nm1-5\nm1-6\n' && await inhalt('src/m2.ts') === 'O2\nm2-2\nZ2\nm2-4\nZZ2\nm2-6\n',
    'S1: alle Ops genau einmal (ZZ1 zurueckgezogen)', { m1: await inhalt('src/m1.ts'), m2: await inhalt('src/m2.ts') });
  const pzRow = await zeile(pz.plan_id);
  pruefe(pzRow?.status === 'cancelled', 'S1: der Traeger von Z ist geschlossen', pzRow);
  pruefe(/geschlossen durch commit von Plan \d+/.test(pzRow?.reason ?? ''), 'S8(3): geschlossener Traeger nennt Anlass und Plan', pzRow?.reason);

  // S3 (c): PLAN_READY zu committeten Plaenen erledigt
  const pending = await pool.query(
    `SELECT e.id FROM agent_events e
      WHERE e.project = $1 AND e.event_type = 'PLAN_READY'
        AND NOT EXISTS (SELECT 1 FROM agent_event_acks a WHERE a.event_id = e.id)`, [PROJECT]);
  pruefe(pending.rows.length === 0, 'S3(c): keine offenen PLAN_READY-Events zu committeten Plaenen', pending.rows);

  // S6 (e)
  const st6 = batch.buildPlanStatusResponse(await batch.getBatchPlan(p2.plan_id));
  pruefe(st6.committed_by === O2 && st6.batch_id === p2.plan_id, 'S6(e): plan_status nennt committed_by und batch_id', { committed_by: st6.committed_by, batch_id: st6.batch_id });

  // ===== S2 (a)(b) =====
  const O3 = 'f8-o3', W = 'f8-w';
  await res.addFileReservations({ project: PROJECT, agentId: O3, filePaths: ['src/m3.ts'] });
  const wOp = rl('src/m3.ts', 4, 'm3-4', 'W4');
  const pw = await batch.planBatch({ project: PROJECT, agent_id: W, ops: [wOp] });
  pruefe(pw.coedit_waits?.length === 1 && !pw.coedit_waits[0].target_plan_id, 'S2: Wait auf Primaer ohne Plan (noch kein Ziel)', pw.coedit_waits);
  const p3 = await batch.planBatch({ project: PROJECT, agent_id: O3, ops: [rl('src/m3.ts', 1, 'm3-1', 'O3')] });
  const wRow = (await pool.query('SELECT primary_plan_id::text AS p FROM file_batch_waits WHERE wait_token = $1::uuid', [pw.coedit_waits[0].wait_token])).rows[0];
  pruefe(wRow?.p === p3.plan_id, 'S2(a): der Wait wird an den spaeter entstehenden Plan gebunden', wRow);
  const sps = await batch.getSharedPlanStatus({ project: PROJECT, wait_token: pw.coedit_waits[0].wait_token, agent_id: W });
  pruefe(sps.target_plan_id === p3.plan_id, 'S2(a): shared_plan_status nennt den neuen Zielplan', sps.target_plan_id);
  const c3 = await batch.commitBatch({ plan_id: p3.plan_id, agent_id: O3 });
  pruefe(c3.success === true, 'S2: Owner committet ohne W', c3);
  pruefe((await zeile(pw.plan_id))?.status === 'cancelled', 'S2(b): leerer Traeger von W schliesst, obwohl sein Wait nie beigetragen hat', await zeile(pw.plan_id));
  const late = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p3.plan_id, agent_id: W, ops: [wOp] }));
  pruefe(late.follow_up === true, 'S2: W traegt spaeter bei -> Folgeplan', late);
  if (late.plan_id) await batch.commitBatch({ plan_id: late.plan_id, agent_id: W });

  // ===== S5 (036c979a-2) =====
  const O4 = 'f8-o4', V = 'f8-v';
  await res.addFileReservations({ project: PROJECT, agentId: O4, filePaths: ['src/m4.ts'] });
  const p4 = await batch.planBatch({ project: PROJECT, agent_id: O4, ops: [rl('src/m4.ts', 1, 'm4-1', 'O4')] });
  const vOp = rl('src/m4.ts', 3, 'm4-3', 'V3');
  await batch.planBatch({ project: PROJECT, agent_id: V, ops: [vOp] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: V, ops: [vOp] });
  await batch.cancelBatch(p4.plan_id, O4, 'O4 geht');
  const st5 = batch.buildPlanStatusResponse(await batch.getBatchPlan(p4.plan_id));
  pruefe(st5.owner_agent_id === V && !(st5.contributions ?? []).some((c) => c.agent_id === V), 'S5: neuer Owner steht nicht mehr als Wait unter contributions', { owner: st5.owner_agent_id, contributions: st5.contributions });

  // ===== S9 Long-Poll =====
  let t0 = Date.now();
  const lp0 = await batch.pollPlanStatus?.({ plan_id: p4.plan_id, wait_seconds: 2 });
  pruefe(lp0 && lp0.changed === false && Date.now() - t0 >= 1800, 'S9: plan_status mit wait_seconds wartet ohne Aenderung bis zur Frist', { lp0: lp0 && { changed: lp0.changed }, ms: Date.now() - t0 });
  t0 = Date.now();
  const lpPromise = batch.pollPlanStatus?.({ plan_id: p4.plan_id, wait_seconds: 10 });
  setTimeout(() => { batch.commitBatch({ plan_id: p4.plan_id, agent_id: V }).catch(() => null); }, 1000);
  const lp1 = await lpPromise;
  pruefe(lp1 && lp1.changed === true && lp1.status === 'committed' && Date.now() - t0 < 8000, 'S9: plan_status kehrt bei Aenderung frueh zurueck', { changed: lp1?.changed, status: lp1?.status, ms: Date.now() - t0 });
  const O5 = 'f8-o5', U = 'f8-u';
  await res.addFileReservations({ project: PROJECT, agentId: O5, filePaths: ['src/m6.ts'] });
  const pu = await batch.planBatch({ project: PROJECT, agent_id: U, ops: [rl('src/m6.ts', 2, 'm6-2', 'U2')] });
  t0 = Date.now();
  const spPromise = batch.getSharedPlanStatus({ project: PROJECT, wait_token: pu.coedit_waits[0].wait_token, agent_id: U, wait_seconds: 10 });
  setTimeout(() => { batch.planBatch({ project: PROJECT, agent_id: O5, ops: [rl('src/m6.ts', 1, 'm6-1', 'O5')] }).catch(() => null); }, 1000);
  const sp1 = await spPromise;
  pruefe(sp1.changed === true && typeof sp1.target_plan_id === 'string' && Date.now() - t0 < 8000, 'S9: shared_plan_status wartet, bis der Zielplan entsteht', { changed: sp1.changed, target: sp1.target_plan_id, ms: Date.now() - t0 });

  // ===== S7 (036c979a-1) Legacy-commit =====
  const L = 'f8-l';
  await res.addFileReservations({ project: PROJECT, agentId: L, filePaths: ['src/m5.ts'] });
  const pl = await batch.planBatch({ project: PROJECT, agent_id: L, ops: [rl('src/m5.ts', 1, 'm5-1', 'L1')] });
  const cl = await batch.commitBatch({ plan_id: pl.plan_id, agent_id: L });
  pruefe(cl.success === true && (cl.released_reservations ?? []).some((r) => r.agent_id === L && r.file_path === 'src/m5.ts'), 'S7: Legacy-commit nennt released_reservations', cl.released_reservations);

  // ===== S10 (f) =====
  const hint = res.reservationTtlHint?.([{ file_path: 'a', expires_at: '2026-01-01T00:20:00.000Z' }, { file_path: 'b', expires_at: '2026-01-01T00:40:00.000Z' }]);
  pruefe(typeof hint === 'string' && /Beteiligte/.test(hint), 'S10(f): unterschiedliche expires_at werden erklaert', hint);

  // ===== S11 (g) =====
  const O6 = 'f8-o6', R = 'f8-r';
  await res.addFileReservations({ project: PROJECT, agentId: O6, filePaths: ['src/m5.ts'] });
  const p6 = await batch.planBatch({ project: PROJECT, agent_id: O6, ops: [rl('src/m5.ts', 2, 'm5-2', 'O6')] });
  const rOp = rl('src/m5.ts', 4, 'm5-4', 'R4', 'grund-geplant');
  await batch.planBatch({ project: PROJECT, agent_id: R, ops: [rOp] });
  const g1 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p6.plan_id, agent_id: R, ops: [{ ...rOp, reason: 'anderer grund' }] }));
  pruefe(g1.success === true, 'S11(g): abweichender reason verhindert den Beitrag nicht', g1);
  const R2 = 'f8-r2';
  const r2Op = rl('src/m5.ts', 6, 'm5-6', 'R6');
  await batch.planBatch({ project: PROJECT, agent_id: R2, ops: [r2Op] });
  const g2 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p6.plan_id, agent_id: R2, ops: [{ ...r2Op, content: 'ANDERS' }] }));
  pruefe(g2.success !== true && /content/.test(g2.error ?? ''), 'S11(g): echte Abweichung -> Ablehnung nennt das Feld', g2.error);
  await batch.cancelBatch(p6.plan_id, O6);

  // ===== S12 open_plans =====
  const alt = await batch.planBatch({ project: PROJECT, agent_id: 'f8-alt', ops: [rl('src/m7.ts', 5, 'm7-5', 'ALT')] }).catch(() => null);
  if (alt) await pool.query(`UPDATE file_batch_plans SET created_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [alt.plan_id]);
  const neu = await batch.planBatch({ project: PROJECT, agent_id: 'f8-neu', ops: [rl('src/m8.ts', 6, 'm8-6', 'NEU')] }).catch((e) => ({ fehler: e.message }));
  const h = await hints.claimOpenPlanHints(PROJECT, 'f8-beobachter');
  const ids = (h?.plaene ?? []).map((p) => p.plan_id);
  pruefe(alt && !ids.includes(alt.plan_id) && h?.aeltere?.anzahl >= 1 && h?.aeltere?.aelteste_tage >= 30, 'S12: Plaene ohne Aktivitaet > 7 Tage nur gezaehlt, nicht in den Top 5', { ids, aeltere: h?.aeltere });
  pruefe(ids.length > 0 && (neu?.plan_id ? ids[0] === neu.plan_id || ids.includes(neu.plan_id) : true), 'S12: neueste zuerst', { ids, neu: neu?.plan_id });
  pruefe(typeof h?.wartende_traeger === 'number' && h.wartende_traeger >= 1, 'S12(b): offene leere Traeger werden gezaehlt statt unsichtbar', h?.wartende_traeger);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await new Promise((r) => setTimeout(r, 1500));
  const nachher = await aufraeumen().catch((e) => ({ fehler: String(e) }));
  console.log('AUFGERAEUMT ' + JSON.stringify(nachher));
  const rest = await pool.query(
    `SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project = $1) + (SELECT COUNT(*) FROM file_batch_waits WHERE project = $1)
          + (SELECT COUNT(*) FROM file_reservations WHERE project = $1) + (SELECT COUNT(*) FROM file_versions WHERE project = $1)
          + (SELECT COUNT(*) FROM code_files WHERE project = $1) + (SELECT COUNT(*) FROM agent_events WHERE project = $1) AS n`, [PROJECT]);
  console.log('REST    ' + rest.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(rest.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
