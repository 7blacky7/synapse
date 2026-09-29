/**
 * STRESSTEST RUNDE 3 (Befunde 46ccab5b + Nachtrag dc2d7eac) — nachgestellt im Wegwerf-Projekt PROJECT.
 *  R1 plan_status: op_indices kommt vom Connector auch als JSON-String ("[0,1]") und wird nicht ignoriert.
 *  R2 cancel eines leeren Traegerplans schliesst dessen Waits (closed) und meldet PLAN_CHANGED an den Ziel-Owner;
 *     der commit wartet danach nicht mehr auf den Zurueckgezogenen.
 *  R3 contribution_failed nennt die GLOBALE op_index und agent_id der kollidierenden Op mit fertigem Abruf-Aufruf.
 *  R4 nach contribution_failed: plan_update auf den Traeger (op_index = coedit_source_op_index) aendert die
 *     zurueckgestellte Op, danach nimmt coedit_add die geaenderte Op an.
 *  R5 zweiter plan desselben Agenten, dessen erster Plan ein leerer Traeger auf dasselbe Ziel ist: kein zweiter Traeger.
 *  R6 Wait, der vor dem Owner-Plan entsteht, wird gebunden und ist im plan_status des Traegers sichtbar;
 *     contributions und commit_wartet_auf zeigen denselben Status; PLAN_READY nach ack nicht erneut; Guide.
 *  R7 reine Einfuegungen am selben Punkt: kein Konflikt, INFO insert_notes, jede genau 1x, feste Reihenfolge;
 *     Ersetzung ueber der Einfuegestelle bleibt Konflikt.
 *  R8 plan-Trockenlauf eines Wartenden laeuft gegen den Stand des Zielplans (Anker aus dessen Op).
 *  R9 late_line_ops_unmappable: spaete Zeilen-Op auf eine durch den commit geaenderte Zeile wird abgelehnt.
 * AUFRUF: node packages/core/tests/file-batch-runde3.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'runde3-test';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const events = await import(join(dist, 'services', 'events.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), geworfen: true }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
async function anlegen(p, t) { const x = await batch.planBatch({ project: PROJECT, agent_id: 'r3-setup', ops: [{ file_path: p, action: 'create', content: t }] }); await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'r3-setup' }); }
const aktiv = (agent) => pool.query(`INSERT INTO tool_calls (project, tool_name, action, agent_id, ts) VALUES ($1, 'code_intel', 'file', $2, NOW())`, [PROJECT, agent]);
const zehn = (p) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `${p}${i}`).join('\n') + '\n';
const rl = (f, line, anker, text) => ({ file_path: f, action: 'replace_lines', line_start: line, line_end: line, content: text, anchor_text: anker });
const ia = (f, line, anker, text) => ({ file_path: f, action: 'insert_after', after_line: line, content: text, anchor_text: anker });
const sr = (f, search, replace) => ({ file_path: f, action: 'search_replace', search, replace });
const vorkommen = (text, marke) => (text ?? '').split(marke).length - 1;
const offeneWaits = async (agent) => (await pool.query(
  `SELECT wait_token::text AS wait_token, source_plan_id::text AS source_plan_id, primary_plan_id::text AS primary_plan_id, status::text AS status, deferred_ops
     FROM file_batch_waits WHERE project = $1 AND waiting_agent = $2 AND status <> 'closed' ORDER BY wait_token`,
  [PROJECT, agent],
)).rows;

try {
  await aufraeumen();

  // ===== R1 op_indices als JSON-String =====
  await anlegen('src/r1.ts', zehn('r1-'));
  const p1 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o1', ops: [rl('src/r1.ts', 1, 'r1-1', 'R1A'), rl('src/r1.ts', 3, 'r1-3', 'R1B')] });
  const v1 = await versuch(() => batch.getPlanOpsVollstaendig({ plan_id: p1.plan_id, op_indices: '[0,1]' }));
  pruefe(v1.success === true && v1.ops?.length === 2 && v1.ops.every((e) => !e.fehler) && v1.ops[1]?.op?.content === 'R1B',
    'R1: op_indices als JSON-String liefert genau die beiden Ops vollstaendig', v1);
  const lesen = batch.opIndicesLesen;
  pruefe(typeof lesen === 'function' && JSON.stringify(lesen([0, '1'])) === '[0,1]' && JSON.stringify(lesen('[2,3]')) === '[2,3]'
    && JSON.stringify(lesen('4, 5')) === '[4,5]' && JSON.stringify(lesen(6)) === '[6]' && lesen(undefined) === undefined,
    'R1: opIndicesLesen versteht Array, JSON-String, Komma-Liste und Einzelwert', null);
  const restSrc = readFileSync(join(hier, '..', '..', 'rest-api', 'src', 'routes', 'mcp.ts'), 'utf8');
  const stdioSrc = readFileSync(join(hier, '..', '..', 'mcp-server', 'src', 'tools', 'consolidated', 'files.ts'), 'utf8');
  pruefe(/opIndicesLesen\(/.test(restSrc) && /opIndicesLesen\(/.test(stdioSrc), 'R1: REST (files + files_batch) und MCP-stdio lesen op_indices ueber opIndicesLesen', null);
  await batch.cancelBatch(p1.plan_id, 'r3-o1');

  // ===== R2 cancel eines leeren Traegers schliesst seine Waits =====
  await anlegen('src/r2.ts', zehn('r2-'));
  const o2 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o2', ops: [rl('src/r2.ts', 1, 'r2-1', 'O2')] });
  const w2 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-w2', ops: [rl('src/r2.ts', 5, 'r2-5', 'W2')] });
  pruefe(w2.total_ops === 0 && w2.coedit_waits?.[0]?.target_plan_id === o2.plan_id, 'R2 Vorbereitung: W2 hat einen leeren Traeger mit Wait auf O2', w2);
  await aktiv('r3-w2');
  const c2 = await batch.cancelBatch(w2.plan_id, 'r3-w2');
  const wait2 = (await pool.query('SELECT status::text AS status FROM file_batch_waits WHERE source_plan_id = $1::bigint', [w2.plan_id])).rows;
  pruefe(c2.ok === true && wait2.length === 1 && wait2[0].status === 'closed', 'R2: cancel des Traegers schliesst seinen Wait (closed)', { c2, wait2 });
  const ev2 = (await events.getPendingEvents(PROJECT, 'r3-o2', 50)).filter((e) => e.eventType === 'PLAN_CHANGED');
  pruefe(ev2.length === 1 && String(JSON.parse(ev2[0].payload).plan_id) === String(o2.plan_id), 'R2: Ziel-Owner bekommt PLAN_CHANGED wie beim Rueckzug', ev2);
  const s2 = await batch.getBatchPlan(o2.plan_id);
  pruefe(!(s2.commit_wartet_auf?.length) && !(s2.contributions ?? []).some((c) => c.agent_id === 'r3-w2'), 'R2: der geschlossene Wait taucht weder in contributions noch in commit_wartet_auf auf', s2);
  const cm2 = await batch.commitBatch({ plan_id: o2.plan_id, agent_id: 'r3-o2' });
  pruefe(cm2.success === true, 'R2: commit geht ohne coedit_incomplete/waiting_for_contributors durch', cm2);

  // ===== R3 + R4 contribution_failed: Verursacher global, danach Op per plan_update am Traeger anpassen =====
  await anlegen('src/r3b.ts', zehn('b-'));
  await anlegen('src/r3.ts', 'export const a = 1;\n// ENDE-L\nx\n// SLOT-S\ny\n');
  const o3 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o3', ops: [
    rl('src/r3b.ts', 1, 'b-1', 'B1'), rl('src/r3b.ts', 3, 'b-3', 'B3'), rl('src/r3.ts', 1, 'export const a = 1;', 'export const a = 2;'),
  ] });
  const opL = sr('src/r3.ts', '// ENDE-L', '// ENDE-L\n// SLOT-S kopie');
  const l3 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-l3', ops: [opL] });
  const addL = await batch.addCoeditContribution({ project: PROJECT, plan_id: o3.plan_id, agent_id: 'r3-l3', ops: [opL] });
  pruefe(addL.success === true && l3.coedit_waits?.[0]?.target_plan_id === o3.plan_id, 'R3 Vorbereitung: L traegt als globale Op 3 bei', addL);
  const opS = sr('src/r3.ts', '// SLOT-S', '// SLOT-S\nS5');
  const s3 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-s3', ops: [opS] });
  const addS = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o3.plan_id, agent_id: 'r3-s3', ops: [opS] }));
  const vu = addS.verursacher;
  pruefe(addS.success === false && addS.error === 'contribution_failed' && vu?.op_index === 3 && vu?.agent_id === 'r3-l3'
    && /op_index:3/.test(String(vu?.ansehen)) && /Op 3/.test(addS.message ?? '') && /r3-l3/.test(addS.message ?? '')
    && !/Re-Apply von Op 2/.test(addS.message ?? ''),
    'R3: contribution_failed nennt globale op_index 3 + agent_id r3-l3 des Verursachers mit Abruf-Aufruf', addS);
  const quelle = addS.failed_ops?.[0];
  pruefe(/coedit_add/.test(String(addS.anpassen ?? '')) && new RegExp(`op_index:${quelle?.coedit_source_op_index}`).test(String(addS.anpassen ?? ''))
    && String(quelle?.coedit_source_plan_id) === String(s3.plan_id) && Number.isInteger(quelle?.coedit_source_op_index),
    'R4: contribution_failed nennt den fertigen coedit_add-Aufruf mit op_index (= coedit_source_op_index)', { anpassen: addS.anpassen, quelle });
  const opS2 = sr('src/r3.ts', 'x\n// SLOT-S', 'x\n// SLOT-S\nS5');
  const add4x = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o3.plan_id, agent_id: 'r3-s3', op_index: quelle?.coedit_source_op_index ?? 0, ops: [sr('src/r3b.ts', 'b-5', 'B5')] }));
  pruefe(add4x.success === false && /dieselben Dateien/.test(add4x.error ?? ''), 'R4: Ersatz-Op auf eine andere Datei wird abgelehnt', add4x);
  const add4 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o3.plan_id, agent_id: 'r3-s3', op_index: quelle?.coedit_source_op_index ?? 0, ops: [opS2] }));
  pruefe(add4.success === true && add4.appended_ops === 1, 'R4: coedit_add mit op_index ersetzt die zurueckgestellte Op und traegt sie bei', add4);
  const wait4 = await offeneWaits('r3-s3');
  pruefe(wait4.length === 1 && wait4[0].deferred_ops?.[0]?.search === 'x\n// SLOT-S', 'R4: der Wait haelt die ersetzte Op', wait4);
  const cm3 = await batch.commitBatch({ plan_id: o3.plan_id, agent_id: 'r3-o3' });
  const t3 = await inhalt('src/r3.ts');
  pruefe(cm3.success === true && t3 === 'export const a = 2;\n// ENDE-L\n// SLOT-S kopie\nx\n// SLOT-S\nS5\ny\n', 'R4: commit schreibt alle drei Beitraege genau einmal', { cm3, t3 });

  // ===== R5 zweiter plan mit leerem Traeger auf dasselbe Ziel =====
  await anlegen('src/r5.ts', zehn('r5-'));
  const o5 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o5', ops: [rl('src/r5.ts', 1, 'r5-1', 'O5')] });
  const x1 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-x5', ops: [rl('src/r5.ts', 3, 'r5-3', 'X1')] });
  const x2 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-x5', ops: [rl('src/r5.ts', 5, 'r5-5', 'X2')] });
  const traeger5 = (await pool.query(`SELECT id::text AS id FROM file_batch_plans WHERE project = $1 AND owner_agent_id = 'r3-x5' AND status = 'open'`, [PROJECT])).rows;
  pruefe(x2.plan_id === x1.plan_id && traeger5.length === 1 && x2.reused_carrier?.plan_id === x1.plan_id, 'R5: zweiter plan nutzt den vorhandenen Traeger (kein zweiter)', { x1: x1.plan_id, x2, traeger5 });
  const waits5 = await offeneWaits('r3-x5');
  pruefe(waits5.length === 1 && waits5[0].deferred_ops.length === 2 && x2.coedit_waits?.[0]?.wait_token === waits5[0].wait_token, 'R5: ein Wait mit beiden Ops', waits5);
  const pr5 = (await events.getPendingEvents(PROJECT, 'r3-x5', 50)).filter((e) => e.eventType === 'PLAN_READY');
  pruefe(pr5.length === 1, 'R5: genau ein PLAN_READY', pr5.map((e) => e.payload));
  const add5 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o5.plan_id, agent_id: 'r3-x5', ops: [rl('src/r5.ts', 3, 'r5-3', 'X1'), rl('src/r5.ts', 5, 'r5-5', 'X2')] }));
  pruefe(add5.success === true && add5.appended_ops === 2, 'R5: coedit_add nimmt beide Ops an', add5);
  const cm5 = await batch.commitBatch({ plan_id: o5.plan_id, agent_id: 'r3-o5' });
  const t5 = await inhalt('src/r5.ts');
  pruefe(cm5.success === true && vorkommen(t5, 'X1') === 1 && vorkommen(t5, 'X2') === 1 && vorkommen(t5, 'O5') === 1, 'R5: commit schreibt O5, X1, X2 je genau einmal', { cm5, t5 });

  // ===== R6 Bindung sichtbar, Status konsistent, PLAN_READY nach ack, Guide =====
  await anlegen('src/r6.ts', zehn('r6-'));
  await anlegen('src/r6c.ts', zehn('c-'));
  await anlegen('src/r6frei.ts', zehn('f-'));
  await res.addFileReservations({ project: PROJECT, agentId: 'r3-o6', filePaths: ['src/r6.ts', 'src/r6c.ts'] });
  const w6 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-w6', ops: [rl('src/r6.ts', 9, 'r6-9', 'W6')] });
  pruefe(w6.coedit_waits?.length === 1 && !w6.coedit_waits[0].target_plan_id, 'R6 Vorbereitung: W6 plant vor dem Owner (noch kein Ziel)', w6);
  const o6 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o6', ops: [rl('src/r6.ts', 1, 'r6-1', 'O6'), rl('src/r6c.ts', 1, 'c-1', 'O6C')] });
  const tr6 = batch.buildPlanStatusResponse(await batch.getBatchPlan(w6.plan_id));
  pruefe(tr6.coedit_waits?.[0]?.target_plan_id === o6.plan_id && tr6.coedit_waits?.[0]?.wait_token === w6.coedit_waits[0].wait_token,
    'R6: plan_status des Traegers zeigt das spaeter entstandene Ziel (target_plan_id)', tr6.coedit_waits ?? tr6);
  const st6a = await batch.getBatchPlan(o6.plan_id);
  pruefe((st6a.contributions ?? []).some((c) => c.agent_id === 'r3-w6'), 'R6: der gebundene Wait steht in contributions des Owner-Plans', st6a.contributions);
  const y1 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-y6', ops: [rl('src/r6.ts', 7, 'r6-7', 'Y7'), rl('src/r6frei.ts', 1, 'f-1', 'F1')] });
  const y2 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-y6', ops: [rl('src/r6c.ts', 5, 'c-5', 'Y5')] });
  pruefe(y1.total_ops === 1 && y2.plan_id !== y1.plan_id && (await offeneWaits('r3-y6')).length === 2, 'R6 Vorbereitung: Y6 hat zwei Waits auf den Owner-Plan', { y1, y2 });
  const ready6 = (await events.getPendingEvents(PROJECT, 'r3-y6', 50)).filter((e) => e.eventType === 'PLAN_READY');
  if (ready6.length > 0) await events.acknowledgeEvent(Number(ready6[0].id), 'r3-y6', 'gelesen');
  const ready6b = (await events.getPendingEvents(PROJECT, 'r3-y6', 50)).filter((e) => e.eventType === 'PLAN_READY' && String(JSON.parse(e.payload).plan_id) === String(o6.plan_id));
  pruefe(ready6.length >= 1 && ready6b.length === 0, 'R6: nach ack eines PLAN_READY steht fuer denselben Plan keins mehr in pending_events', { vorher: ready6.length, nachher: ready6b.map((e) => e.payload) });
  await batch.markCoeditNoChanges({ project: PROJECT, plan_id: o6.plan_id, agent_id: 'r3-y6', files: ['src/r6c.ts'] });
  await aktiv('r3-y6');
  const st6 = await batch.getBatchPlan(o6.plan_id);
  const conY = (st6.contributions ?? []).find((c) => c.agent_id === 'r3-y6');
  const gateY = (st6.commit_wartet_auf ?? []).find((c) => c.agent_id === 'r3-y6');
  pruefe(conY && gateY && conY.wait_status === gateY.wait_status && conY.wait_status === 'waiting', 'R6: contributions und commit_wartet_auf zeigen denselben Status', { conY, gateY });
  const guideQuelle = readFileSync(join(hier, '..', 'src', 'guide', 'content.ts'), 'utf8');
  pruefe(/linked = /.test(guideQuelle) && /coedit_source_op_index = /.test(guideQuelle) && /insert_notes/.test(guideQuelle) && /reused_carrier/.test(guideQuelle),
    'R6: Guide erklaert wait_status linked, coedit_source_op_index, insert_notes, reused_carrier', null);
  await batch.cancelBatch(o6.plan_id, 'r3-o6');
  await batch.cancelBatch(y1.plan_id, 'r3-y6');

  // ===== R7 reine Einfuegungen am selben Punkt =====
  const basis7 = 'kopf\n// SLOT-A\nmitte\n// SLOT-B\n}\n\n// SLOT-C\nfuss\n';
  await anlegen('src/r7.ts', basis7);
  const o7 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o7', ops: [rl('src/r7.ts', 1, 'kopf', 'KOPF')] });
  const beitraege7 = [
    ['r3-a7', ia('src/r7.ts', 2, '// SLOT-A', '[A7]')],
    ['r3-b7', ia('src/r7.ts', 2, '// SLOT-A', '[B7]')],
    ['r3-c7', sr('src/r7.ts', '// SLOT-C', '// SLOT-C\n[C7]')],
    ['r3-d7', sr('src/r7.ts', '}\n\n// SLOT-C', '}\n\n// SLOT-C\n[D7]')],
  ];
  const antworten7 = [];
  for (const [agent, op] of beitraege7) {
    await batch.planBatch({ project: PROJECT, agent_id: agent, ops: [op] });
    antworten7.push(await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o7.plan_id, agent_id: agent, ops: [op] })));
  }
  pruefe(antworten7.every((a) => a.success === true && !a.overlap_warnings), 'R7: alle vier Einfuegungen angenommen, keine overlap_warnings', antworten7);
  pruefe(antworten7[1].insert_notes?.length === 1 && antworten7[3].insert_notes?.length === 1 && /r3-a7/.test(JSON.stringify(antworten7[1].insert_notes))
    && /r3-c7/.test(JSON.stringify(antworten7[3].insert_notes)), 'R7: INFO insert_notes an den zweiten Einfuegenden (nennt den ersten)', antworten7.map((a) => a.insert_notes));
  const st7 = await batch.getBatchPlan(o7.plan_id);
  pruefe(!st7.overlap_warnings && st7.insert_notes?.length === 2, 'R7: plan_status zeigt insert_notes fuer alle (keine overlap_warnings)', { ow: st7.overlap_warnings, notes: st7.insert_notes });
  const cm7 = await batch.commitBatch({ plan_id: o7.plan_id, agent_id: 'r3-o7' });
  const t7 = await inhalt('src/r7.ts');
  pruefe(cm7.success === true && ['[A7]', '[B7]', '[C7]', '[D7]', 'KOPF'].every((m) => vorkommen(t7, m) === 1), 'R7: commit, jede Einfuegung genau einmal', { cm7, t7 });
  pruefe(t7 === 'KOPF\n// SLOT-A\n[B7]\n[A7]\nmitte\n// SLOT-B\n}\n\n// SLOT-C\n[D7]\n[C7]\nfuss\n', 'R7: feste Reihenfolge (spaeterer Beitrag direkt an der Einfuegestelle)', t7);
  await anlegen('src/r7neg.ts', basis7);
  const o7n = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o7n', ops: [rl('src/r7neg.ts', 4, '// SLOT-B', '// SLOT-B-neu')] });
  const opN = ia('src/r7neg.ts', 4, '// SLOT-B', '[N7]');
  await batch.planBatch({ project: PROJECT, agent_id: 'r3-n7', ops: [opN] });
  const addN = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o7n.plan_id, agent_id: 'r3-n7', ops: [opN] }));
  pruefe(addN.success === true && addN.overlap_warnings?.length === 1, 'R7: Einfuegung an einer ersetzten Zeile bleibt Konflikt (overlap_warnings)', addN);
  await batch.cancelBatch(o7n.plan_id, 'r3-n7');
  await batch.cancelBatch(o7n.plan_id, 'r3-o7n');

  // ===== R8 Trockenlauf gegen den Stand des Zielplans =====
  await anlegen('src/r8.ts', 'eins\nALT\ndrei\n');
  const o8 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o8', ops: [sr('src/r8.ts', 'ALT', 'ALT\n// NEU-ANKER')] });
  const opW8 = sr('src/r8.ts', '// NEU-ANKER', '// NEU-ANKER\n[W8]');
  const w8 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'r3-w8', ops: [opW8] }));
  pruefe(!w8.geworfen && w8.coedit_waits?.[0]?.target_plan_id === o8.plan_id, 'R8: plan mit Anker aus der Op des Zielplans scheitert nicht (Wait auf den Zielplan)', w8);
  const add8 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o8.plan_id, agent_id: 'r3-w8', ops: [opW8] }));
  pruefe(add8.success === true && !add8.overlap_warnings, 'R8: coedit_add nimmt die Op an, ohne Ueberlappung', add8);
  const cm8 = await batch.commitBatch({ plan_id: o8.plan_id, agent_id: 'r3-o8' });
  const t8 = await inhalt('src/r8.ts');
  pruefe(cm8.success === true && t8 === 'eins\nALT\n// NEU-ANKER\n[W8]\ndrei\n', 'R8: commit schreibt beide in der richtigen Reihenfolge', { cm8, t8 });

  // ===== R9 late_line_ops_unmappable =====
  await anlegen('src/r9.ts', zehn('r9-'));
  const o9 = await batch.planBatch({ project: PROJECT, agent_id: 'r3-o9', ops: [rl('src/r9.ts', 3, 'r9-3', 'O9-NEU')] });
  const opW9 = rl('src/r9.ts', 3, 'r9-3', 'W9');
  await batch.planBatch({ project: PROJECT, agent_id: 'r3-w9', ops: [opW9] });
  const cm9 = await batch.commitBatch({ plan_id: o9.plan_id, agent_id: 'r3-o9' });
  const vor9 = await inhalt('src/r9.ts');
  const add9 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: o9.plan_id, agent_id: 'r3-w9', ops: [opW9] }));
  const offen9 = (await pool.query(`SELECT COUNT(*)::int AS n FROM file_batch_plans WHERE project = $1 AND owner_agent_id = 'r3-w9' AND status = 'open'`, [PROJECT])).rows[0].n;
  pruefe(cm9.success === true && add9.success === false && add9.error === 'late_line_ops_unmappable' && add9.abgelehnte_ops?.[0]?.aendernde_ops?.[0]?.agent_id === 'r3-o9',
    'R9: spaete Zeilen-Op auf die durch den commit geaenderte Zeile -> late_line_ops_unmappable mit aenderender Op', add9);
  pruefe((await inhalt('src/r9.ts')) === vor9 && vorkommen(vor9, 'O9-NEU') === 1 && vorkommen(vor9, 'W9') === 0 && offen9 === 0, 'R9: nichts geaendert, kein offener Plan fuer W9', { vor9, offen9 });
} catch (error) {
  fehler++;
  console.error('ABBRUCH ' + (error?.stack ?? error));
} finally {
  await aufraeumen();
  const rest = (await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1)+(SELECT COUNT(*) FROM tool_calls WHERE project=$1)+(SELECT COUNT(*) FROM file_reservations WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1) AS n`, [PROJECT])).rows[0].n;
  console.log(`AUFGERAEUMT (Rest ${rest})`);
  await pool.end();
}
console.log(fehler === 0 ? 'ALLE PRUEFUNGEN GRUEN' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
