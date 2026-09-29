/**
 * BEFUND acc82f49 (Stresstest Runde 2) — nachgestellt im Wegwerf-Projekt PROJECT.
 *  T1 Long-Poll auf einen Plan im ENDZUSTAND kehrt sofort zurueck (plan_status + shared_plan_status).
 *  T2 Ein commit WAEHREND des Wartens weckt den Long-Poll: Poll starten, nach 2 s committen,
 *     Antwort < 3 s mit changed:true.
 *  T3 Traeger mit Waits auf ZWEI Zielplaenen bleibt offen, bis ALLE Ziele erledigt sind; ein
 *     Beitrag zum zweiten Ziel ist nach dem commit des ersten noch moeglich.
 *  T4 withdraw + Neu-Beitrag: ein Eintrag je Agent, coedit_ready meldet die zurueckgezogene
 *     Datei nicht als completed.
 *  T5 Schemas (MCP-stdio + REST files/files_batch) nennen plan_update, op_index, wait_seconds, wait_token.
 *  T6 commit-Antwort nennt Dateien UND Ops (committed + committed_ops).
 *  T7 plan_failed eines Nachzueglers auf den Pfaden eines offenen gemeinsamen Plans blockiert diesen
 *     nicht; ein Beitrag, der mit dem Plan zusammen scheitert, wird bei coedit_add abgelehnt.
 *  T8 open_plans.beitraege_von stabil sortiert.
 * AUFRUF: node packages/core/tests/file-batch-fix-acc82f49.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'fixacc-test';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const hints = await import(join(dist, 'services', 'plan-hints.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e) }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
const zeile = async (id) => (await pool.query('SELECT status::text AS status FROM file_batch_plans WHERE id=$1', [id])).rows[0] ?? null;
async function anlegen(p, t) { const x = await batch.planBatch({ project: PROJECT, agent_id: 'fa-setup', ops: [{ file_path: p, action: 'create', content: t }] }); await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'fa-setup' }); }
const sechs = (p) => [1, 2, 3, 4, 5, 6].map((i) => `${p}${i}`).join('\n') + '\n';
const rl = (f, line, anker, text) => ({ file_path: f, action: 'replace_lines', line_start: line, line_end: line, content: text, anchor_text: anker });
const ms = (t0) => Date.now() - t0;

try {
  await aufraeumen();
  for (const f of ['a', 'b', 'c', 'd', 'e', 'g', 'h']) await anlegen(`src/${f}.ts`, sechs(f));

  // ===== T1 Endzustand =====
  const p1 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o1', ops: [rl('src/a.ts', 1, 'a1', 'A1')] });
  await batch.commitBatch({ plan_id: p1.plan_id, agent_id: 'fa-o1' });
  let t0 = Date.now();
  const e1 = await batch.pollPlanStatus({ plan_id: p1.plan_id, wait_seconds: 8 });
  pruefe(e1.status === 'committed' && ms(t0) < 1000, 'T1: plan_status auf committeten Plan kehrt sofort zurueck', { status: e1.status, ms: ms(t0) });
  // shared_plan_status auf Wait, dessen Ziel schon committed ist
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o2', filePaths: ['src/b.ts'] });
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o2', ops: [rl('src/b.ts', 1, 'b1', 'B1')] });
  const w2 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-w2', ops: [rl('src/b.ts', 3, 'b3', 'B3')] });
  await batch.commitBatch({ plan_id: p2.plan_id, agent_id: 'fa-o2' });
  t0 = Date.now();
  const e2 = await batch.getSharedPlanStatus({ project: PROJECT, wait_token: w2.coedit_waits[0].wait_token, agent_id: 'fa-w2', wait_seconds: 8 });
  pruefe(ms(t0) < 1000, 'T1: shared_plan_status auf Wait mit committetem Ziel kehrt sofort zurueck', { ms: ms(t0), status: e2.status });

  // ===== T2 Aufwecken =====
  const p3 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o3', ops: [rl('src/c.ts', 1, 'c1', 'C1')] });
  t0 = Date.now();
  const poll = batch.pollPlanStatus({ plan_id: p3.plan_id, wait_seconds: 10 });
  setTimeout(() => { batch.commitBatch({ plan_id: p3.plan_id, agent_id: 'fa-o3' }).catch(() => null); }, 2000);
  const e3 = await poll;
  pruefe(e3.changed === true && e3.status === 'committed' && ms(t0) < 3000, 'T2: commit waehrend des Wartens weckt den Long-Poll (< 3 s)', { changed: e3.changed, status: e3.status, ms: ms(t0) });
  // Race: commit praktisch gleichzeitig mit dem Start
  const p3b = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o3', ops: [rl('src/c.ts', 2, 'c2', 'C2')] });
  t0 = Date.now();
  const [e3b] = await Promise.all([batch.pollPlanStatus({ plan_id: p3b.plan_id, wait_seconds: 10 }), batch.commitBatch({ plan_id: p3b.plan_id, agent_id: 'fa-o3' })]);
  pruefe(e3b.status === 'committed' && ms(t0) < 3000, 'T2: commit gleichzeitig mit dem Poll-Start fuehrt nicht zu 10 s Warten', { status: e3b.status, changed: e3b.changed, ms: ms(t0) });

  // ===== T3 Traeger mit zwei Zielen =====
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-oa', filePaths: ['src/d.ts'] });
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-ob', filePaths: ['src/e.ts'] });
  const pa = await batch.planBatch({ project: PROJECT, agent_id: 'fa-oa', ops: [rl('src/d.ts', 1, 'd1', 'DA')] });
  const pb = await batch.planBatch({ project: PROJECT, agent_id: 'fa-ob', ops: [rl('src/e.ts', 1, 'e1', 'EB')] });
  const zOps = [rl('src/d.ts', 3, 'd3', 'DZ'), rl('src/e.ts', 3, 'e3', 'EZ')];
  const pz = await batch.planBatch({ project: PROJECT, agent_id: 'fa-z', ops: zOps });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: pa.plan_id, agent_id: 'fa-z', ops: [zOps[0]] });
  await batch.markCoeditReady({ project: PROJECT, plan_id: pa.plan_id, agent_id: 'fa-z' });
  await batch.commitBatch({ plan_id: pa.plan_id, agent_id: 'fa-oa' });
  pruefe((await zeile(pz.plan_id))?.status === 'open', 'T3: Traeger bleibt nach commit des ERSTEN Ziels offen (zweites Ziel noch offen)', await zeile(pz.plan_id));
  const zb = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: pb.plan_id, agent_id: 'fa-z', ops: [zOps[1]] }));
  pruefe(zb.success === true && !zb.follow_up, 'T3: Beitrag zum zweiten Ziel ist danach noch moeglich', zb);
  // Variante: in beide beigetragen + ready in B, dann A committed -> Traeger bleibt bis B erledigt
  const pa2 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-oa', ops: [rl('src/d.ts', 5, 'd5', 'DA5')] });
  const z2Ops = [rl('src/d.ts', 6, 'd6', 'DY'), rl('src/e.ts', 5, 'e5', 'EY')];
  const py = await batch.planBatch({ project: PROJECT, agent_id: 'fa-y', ops: z2Ops });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: pa2.plan_id, agent_id: 'fa-y', ops: [z2Ops[0]] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: pb.plan_id, agent_id: 'fa-y', ops: [z2Ops[1]] });
  await batch.markCoeditReady({ project: PROJECT, plan_id: pb.plan_id, agent_id: 'fa-y' });
  await batch.commitBatch({ plan_id: pa2.plan_id, agent_id: 'fa-oa' });
  pruefe((await zeile(py.plan_id))?.status === 'open', 'T3: Traeger mit ready-Wait auf noch offenes Ziel bleibt offen', await zeile(py.plan_id));
  const cb = await batch.commitBatch({ plan_id: pb.plan_id, agent_id: 'fa-ob' });
  pruefe(cb.success === true && (await zeile(pz.plan_id))?.status === 'cancelled' && (await zeile(py.plan_id))?.status === 'cancelled', 'T3: nach dem letzten Ziel schliessen beide Traeger', { z: await zeile(pz.plan_id), y: await zeile(py.plan_id) });
  pruefe(await inhalt('src/e.ts') === 'EB\ne2\nEZ\ne4\nEY\ne6\n', 'T3: alle Beitraege zu B geschrieben', await inhalt('src/e.ts'));
  // ===== T6 commit-Zaehlung =====
  pruefe(cb.committed === 1 && cb.committed_ops === 3, 'T6: commit-Antwort nennt Dateien (1) und Ops (3)', { committed: cb.committed, committed_ops: cb.committed_ops });

  // ===== T4 withdraw + Neu-Beitrag =====
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o4', filePaths: ['src/g.ts', 'src/h.ts'] });
  const p4 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o4', ops: [rl('src/g.ts', 1, 'g1', 'G1')] });
  const qOps = [rl('src/g.ts', 3, 'g3', 'GQ'), rl('src/h.ts', 3, 'h3', 'HQ')];
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-q', ops: qOps });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'fa-q', ops: qOps });
  await batch.cancelBatch(p4.plan_id, 'fa-q', 'Q zieht zurueck');
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-q', ops: [qOps[0]] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'fa-q', ops: [qOps[0]] });
  const rq = await batch.markCoeditReady({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'fa-q' });
  pruefe(JSON.stringify(rq.completed_files) === JSON.stringify(['src/g.ts']), 'T4: coedit_ready meldet die zurueckgezogene Datei nicht als completed', rq.completed_files);
  const st4 = batch.buildPlanStatusResponse(await batch.getBatchPlan(p4.plan_id));
  const qEintraege = (st4.contributions ?? []).filter((c) => c.agent_id === 'fa-q');
  pruefe(qEintraege.length === 1 && JSON.stringify(qEintraege[0].contributed_files) === JSON.stringify(['src/g.ts']), 'T4: genau ein Eintrag je Agent, ohne zurueckgezogene Datei', st4.contributions);

  // ===== T7 Nachzuegler mit Fehler =====
  const opR = rl('src/g.ts', 5, 'g5', 'GR');
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-r', ops: [opR] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'fa-r', ops: [opR] });
  const spaet = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'fa-spaet', ops: [rl('src/g.ts', 6, 'falsch', 'GS')] }));
  pruefe(spaet.success === false && /plan_update|Entwurf|NEUER offener Plan/.test(spaet.error ?? ''), 'T7: Nachzuegler mit falschem Anker bekommt plan_failed-Entwurf', spaet.error);
  const c4 = await batch.commitBatch({ plan_id: p4.plan_id, agent_id: 'fa-o4' });
  pruefe(c4.success === true, 'T7: der gemeinsame Plan bleibt committbar (Nachzuegler-Fehler blockiert nicht)', c4);
  // Kombinationsfehler: Plan fuegt "zwei" zweites Vorkommen ein, Beitrag ersetzt "zwei" ohne replace_all
  await anlegen('src/k.ts', 'eins\nzwei\ndrei\n');
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o7', filePaths: ['src/k.ts'] });
  const pk = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o7', ops: [{ file_path: 'src/k.ts', action: 'insert_after', after_line: 3, content: 'zwei' }] });
  const kOp = { file_path: 'src/k.ts', action: 'search_replace', search: 'zwei', replace: 'ZWEI' };
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-u', ops: [kOp] });
  const ku = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: pk.plan_id, agent_id: 'fa-u', ops: [kOp] }));
  pruefe(ku.success === false && /abgelehnt|contribution_failed/.test(`${ku.error} ${ku.message}`), 'T7: Beitrag, der mit dem Plan zusammen scheitert, wird bei coedit_add abgelehnt', ku);
  const ck = await batch.commitBatch({ plan_id: pk.plan_id, agent_id: 'fa-o7' });
  pruefe(ck.success === true, 'T7: der gemeinsame Plan bleibt danach committbar', ck);

  // ===== T8 beitraege_von sortiert =====
  await anlegen('src/m.ts', sechs('m'));
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-zz', filePaths: ['src/m.ts'] });
  const pm = await batch.planBatch({ project: PROJECT, agent_id: 'fa-zz', ops: [rl('src/m.ts', 1, 'm1', 'M1')] });
  for (const ag of ['fa-cc', 'fa-aa', 'fa-bb']) {
    const o = rl('src/m.ts', { 'fa-cc': 3, 'fa-aa': 4, 'fa-bb': 5 }[ag], `m${{ 'fa-cc': 3, 'fa-aa': 4, 'fa-bb': 5 }[ag]}`, ag);
    await batch.planBatch({ project: PROJECT, agent_id: ag, ops: [o] });
    await batch.addCoeditContribution({ project: PROJECT, plan_id: pm.plan_id, agent_id: ag, ops: [o] });
  }
  const h8 = await hints.claimOpenPlanHints(PROJECT, 'fa-beob-' + Date.now());
  const e8 = (h8?.plaene ?? []).find((p) => p.plan_id === pm.plan_id);
  pruefe(JSON.stringify(e8?.beitraege_von) === JSON.stringify(['fa-aa', 'fa-bb', 'fa-cc', 'fa-zz']), 'T8: beitraege_von stabil sortiert', e8?.beitraege_von);

  // ===== T9 Owner-Plan deckt nicht alle reservierten Dateien ab (Stress Runde 2) =====
  await anlegen('src/n1.ts', sechs('n1-'));
  await anlegen('src/n2.ts', sechs('n2-'));
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o9', filePaths: ['src/n1.ts', 'src/n2.ts'] });
  const p9 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o9', ops: [rl('src/n1.ts', 1, 'n1-1', 'N1')] });
  const w9ops = [rl('src/n1.ts', 3, 'n1-3', 'W9A'), rl('src/n2.ts', 3, 'n2-3', 'W9B')];
  const w9 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-w9', ops: w9ops });
  pruefe(w9.coedit_waits?.[0]?.target_plan_id === p9.plan_id, 'T9: Wait bekommt den Owner-Plan als Ziel, auch wenn dieser n2.ts noch nicht abdeckt', w9.coedit_waits);
  const a9 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p9.plan_id, agent_id: 'fa-w9', ops: w9ops }));
  pruefe(a9.success === true, 'T9: coedit_add erweitert den Owner-Plan um die vom Owner reservierte Datei', a9);
  const c9 = await batch.commitBatch({ plan_id: p9.plan_id, agent_id: 'fa-o9' });
  pruefe(c9.success === true && await inhalt('src/n2.ts') === 'n2-1\nn2-2\nW9B\nn2-4\nn2-5\nn2-6\n' && (c9.released_reservations ?? []).some((r) => r.file_path === 'src/n2.ts'),
    'T9: commit schreibt beide Dateien und gibt auch die n2-Reservierung frei', { c9: c9.success, n2: await inhalt('src/n2.ts'), rel: c9.released_reservations });

  // ===== T10 Beitragspruefung mit move-Verbindung (Perf-Umbau: nur beruehrte Dateien pruefen) =====
  await anlegen('src/q1.ts', sechs('q1-'));
  await anlegen('src/q9.ts', sechs('q9-'));
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o10', filePaths: ['src/q1.ts', 'src/q9.ts'] });
  const p10 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o10', ops: [
    { file_path: 'src/q9.ts', action: 'replace_lines', line_start: 1, line_end: 1, content: 'Q9', anchor_text: 'q9-1' },
    { file_path: 'src/q1.ts', action: 'move', new_path: 'src/q1-neu.ts' },
  ] });
  const q1op = rl('src/q1.ts', 3, 'q1-3', 'Q1-BEITRAG');
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-w10', ops: [q1op] });
  const a10 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p10.plan_id, agent_id: 'fa-w10', ops: [q1op] }));
  pruefe(a10.success === false && a10.error === 'contribution_failed', 'T10: Beitrag auf eine Datei, die der Plan per move entfernt, wird erkannt und abgelehnt', a10);
  const c10 = await batch.commitBatch({ plan_id: p10.plan_id, agent_id: 'fa-o10' });
  pruefe(c10.success === true && await inhalt('src/q1-neu.ts') === sechs('q1-') && await inhalt('src/q1.ts') === null, 'T10: der Plan bleibt committbar (move ausgefuehrt)', { c10: c10.success, neu: await inhalt('src/q1-neu.ts'), alt: await inhalt('src/q1.ts') });

  // ===== T11 Datei aendert sich ZWISCHEN Vorab-Laden und Plan-Sperre (Perf-Umbau) =====
  // coedit_add laedt die Texte vor der Transaktion. Eine fremde Sperre auf der Plan-Zeile haelt
  // den Aufruf genau in diesem Fenster fest; waehrenddessen aendert sich die Datei. Unter der
  // Sperre muss der content_hash-Abgleich das merken und gegen den NEUEN Stand pruefen.
  const { contentHash: sha } = await import(join(dist, 'services', 'code-write.js'));
  await anlegen('src/r1.ts', sechs('r1-'));
  await anlegen('src/r2.ts', sechs('r2-'));
  await anlegen('src/r3.ts', sechs('r3-'));
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o11', filePaths: ['src/r1.ts', 'src/r2.ts', 'src/r3.ts'] });
  const p11 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o11', ops: [rl('src/r1.ts', 1, 'r1-1', 'R1')] });
  const fremdAendern = async (planId, pfad, text, beitrag, agent) => {
    const sperre = await pool.connect();
    try {
      await sperre.query('BEGIN');
      await sperre.query('SELECT id FROM file_batch_plans WHERE id = $1::bigint FOR UPDATE', [planId]);
      const lauf = versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: planId, agent_id: agent, ops: [beitrag] }));
      await new Promise((r) => setTimeout(r, 700));
      await pool.query('UPDATE code_files SET content = $3, content_hash = $4 WHERE project = $1 AND file_path = $2', [PROJECT, pfad, text, sha(text)]);
      await sperre.query('COMMIT');
      return await lauf;
    } finally { sperre.release(); }
  };
  // (a) Anker-Zeile wird fremd geaendert -> Beitrag passt nicht mehr -> abgelehnt
  const r2op = rl('src/r2.ts', 3, 'r2-3', 'R2-BEITRAG');
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-w11', ops: [r2op] });
  const r2neu = 'r2-1\nr2-2\nFREMD\nr2-4\nr2-5\nr2-6\n';
  const a11 = await fremdAendern(p11.plan_id, 'src/r2.ts', r2neu, r2op, 'fa-w11');
  pruefe(a11.success === false && a11.error === 'contribution_failed', 'T11: Aenderung zwischen Vorab-Laden und Sperre wird erkannt (Beitrag gegen den NEUEN Stand geprueft)', a11);
  // (b) andere Zeile fremd geaendert -> Beitrag passt, Basis-Hash ist der NEUE Stand
  const r3op = rl('src/r3.ts', 3, 'r3-3', 'R3-BEITRAG');
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-v11', ops: [r3op] });
  const r3neu = 'r3-1\nr3-2\nr3-3\nr3-4\nFREMD\nr3-6\n';
  const b11 = await fremdAendern(p11.plan_id, 'src/r3.ts', r3neu, r3op, 'fa-v11');
  const h11 = (await pool.query('SELECT expected_hashes FROM file_batch_plans WHERE id = $1::bigint', [p11.plan_id])).rows[0]?.expected_hashes ?? {};
  pruefe(b11.success === true && h11['src/r3.ts'] === sha(r3neu), 'T11: neu aufgenommene Datei bekommt den Hash des Stands UNTER der Sperre', { b11: b11.success, err: b11.error, hash_ok: h11['src/r3.ts'] === sha(r3neu), alt: h11['src/r3.ts'] === sha(sechs('r3-')) });
  const c11 = await batch.commitBatch({ plan_id: p11.plan_id, agent_id: 'fa-o11' });
  pruefe(c11.success === true && await inhalt('src/r3.ts') === 'r3-1\nr3-2\nR3-BEITRAG\nr3-4\nFREMD\nr3-6\n', 'T11: commit schreibt den Beitrag auf den fremd geaenderten Stand', { c11: c11.success, r3: await inhalt('src/r3.ts') });

  // ===== T12 Wait auf eine Owner-Datei, die KEIN Owner-Plan abdeckt (s2: ST2-STEUER-2 verloren) =====
  // (a) Owner reserviert s1+s2, plant nur s1. Der Wartende auf s2 muss den offenen Owner-Plan als
  //     Ziel bekommen (coedit_add erweitert ihn um die vom Owner reservierte s2). Vorher: kein Ziel,
  //     der Wartende hing bis zum commit des Owners und fand danach gar keins mehr.
  await anlegen('src/s1.ts', sechs('s1-'));
  await anlegen('src/s2.ts', sechs('s2-'));
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o12', filePaths: ['src/s1.ts', 'src/s2.ts'] });
  const p12 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o12', ops: [rl('src/s1.ts', 1, 's1-1', 'S1')] });
  const s2op = rl('src/s2.ts', 3, 's2-3', 'S2-BEITRAG');
  const w12 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-w12', ops: [s2op] });
  const sp12 = await versuch(() => batch.getSharedPlanStatus({ project: PROJECT, wait_token: w12.coedit_waits?.[0]?.wait_token, agent_id: 'fa-w12' }));
  pruefe(w12.coedit_waits?.[0]?.target_plan_id === p12.plan_id && sp12.target_plan_id === p12.plan_id,
    'T12: Wait auf eine reservierte, noch nicht geplante Owner-Datei bekommt den offenen Owner-Plan als Ziel', { plan: w12.coedit_waits?.[0]?.target_plan_id, sps: sp12.target_plan_id, soll: p12.plan_id });
  const a12 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p12.plan_id, agent_id: 'fa-w12', ops: [s2op] }));
  const c12 = await batch.commitBatch({ plan_id: p12.plan_id, agent_id: 'fa-o12' });
  pruefe(a12.success === true && c12.success === true && await inhalt('src/s2.ts') === 's2-1\ns2-2\nS2-BEITRAG\ns2-4\ns2-5\ns2-6\n' && (await zeile(w12.plan_id))?.status === 'cancelled',
    'T12: Beitrag landet im Owner-Plan, commit schreibt ihn, Traeger schliesst', { a12: a12.success, c12: c12.success, s2: await inhalt('src/s2.ts'), traeger: await zeile(w12.plan_id) });
  // (b) Wie s2: Wait entsteht, bevor der Owner plant; ein Dritter deckt u2 im Owner-Plan ab; der Owner
  //     committet, ohne dass der Wartende je ein Ziel sah. Danach muss shared_plan_status den
  //     committeten Plan nennen, damit coedit_add in einen Folgeplan fuehrt — sonst ist die Op verloren.
  await anlegen('src/u1.ts', sechs('u1-'));
  await anlegen('src/u2.ts', sechs('u2-'));
  await res.addFileReservations({ project: PROJECT, agentId: 'fa-o13', filePaths: ['src/u1.ts', 'src/u2.ts'] });
  const u2op = rl('src/u2.ts', 3, 'u2-3', 'U2-SPAET');
  const w13 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-w13', ops: [u2op] });
  const p13 = await batch.planBatch({ project: PROJECT, agent_id: 'fa-o13', ops: [rl('src/u1.ts', 1, 'u1-1', 'U1')] });
  const x13ops = [rl('src/u1.ts', 5, 'u1-5', 'U1-X'), rl('src/u2.ts', 5, 'u2-5', 'U2-X')];
  await batch.planBatch({ project: PROJECT, agent_id: 'fa-x13', ops: x13ops });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p13.plan_id, agent_id: 'fa-x13', ops: x13ops });
  await batch.commitBatch({ plan_id: p13.plan_id, agent_id: 'fa-o13' });
  const sp13 = await versuch(() => batch.getSharedPlanStatus({ project: PROJECT, wait_token: w13.coedit_waits?.[0]?.wait_token, agent_id: 'fa-w13', wait_seconds: 5 }));
  pruefe(sp13.target_plan_id === p13.plan_id && sp13.target_plan_status === 'committed',
    'T12: nach commit ohne Beitrag nennt shared_plan_status den committeten Owner-Plan (Weg in den Folgeplan)', { target: sp13.target_plan_id, status: sp13.target_plan_status, soll: p13.plan_id, err: sp13.error });
  const f13 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: sp13.target_plan_id ?? p13.plan_id, agent_id: 'fa-w13', ops: [u2op] }));
  const fc13 = f13.follow_up && f13.plan_id ? await batch.commitBatch({ plan_id: f13.plan_id, agent_id: 'fa-w13' }) : null;
  pruefe(fc13?.success === true && await inhalt('src/u2.ts') === 'u2-1\nu2-2\nU2-SPAET\nu2-4\nU2-X\nu2-6\n' && (await zeile(w13.plan_id))?.status === 'cancelled',
    'T12: der spaete Beitrag landet per Folgeplan in der Datei, der leere Traeger schliesst', { f13: f13.follow_up, fc13: fc13?.success, u2: await inhalt('src/u2.ts'), traeger: await zeile(w13.plan_id) });

  // ===== T5 Schemas =====
  const mcpFiles = await import(join(hier, '..', '..', 'mcp-server', 'dist', 'tools', 'consolidated', 'files.js')).catch((e) => ({ fehler: e.message }));
  const sch = mcpFiles.filesTool?.definition?.inputSchema ?? mcpFiles.filesTool?.inputSchema ?? null;
  const props = sch?.properties ?? {};
  pruefe(props.action?.enum?.includes('plan_update') && props.op_index && props.wait_seconds && props.wait_token, 'T5: MCP-stdio-Schema nennt plan_update, op_index, wait_seconds, wait_token', { enum: props.action?.enum?.includes('plan_update'), keys: Object.keys(props).filter((k) => ['op_index', 'wait_seconds', 'wait_token'].includes(k)), fehler: mcpFiles.fehler });
  const rest = readFileSync(join(hier, '..', '..', 'rest-api', 'dist', 'routes', 'mcp.js'), 'utf8');
  const enums = rest.match(/enum: \[[^\]]*'shared_plan_status'[^\]]*\]/g) ?? [];
  pruefe(enums.length >= 2 && enums.every((e) => e.includes("'plan_update'")) && (rest.match(/wait_seconds: \{ type: 'number'/g) ?? []).length >= 2 && (rest.match(/op_index: \{ type: 'number'/g) ?? []).length >= 2,
    'T5: REST-Schemas files + files_batch nennen plan_update, op_index, wait_seconds', { enums: enums.length });
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await new Promise((r) => setTimeout(r, 500));
  await aufraeumen().catch(() => null);
  const r = await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM file_reservations WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1) AS n`, [PROJECT]);
  console.log('REST    ' + r.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(r.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
