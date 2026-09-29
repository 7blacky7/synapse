/**
 * FREMDE OP VOLLSTAENDIG SEHEN (User-Vorgabe 29.09.2026) — Wegwerf-Projekt PROJECT.
 * Ein Agent muss die Aenderung eines anderen VOLLSTAENDIG sehen koennen, bevor er an derselben
 * Stelle schreibt.
 *  A1 plan_status mit op_index / op_indices liefert die komplette Op (agent_id, action, alle Felder,
 *     reason, Status) plus die betroffenen Zeilen vorher/nachher — ungekuerzt, auch bei 5.000 Zeilen.
 *     from_line/to_line schneiden ein Fenster aus content.
 *  A2 overlap_warnings (coedit_add), coedit_conflict (commit) und late_line_ops_unmappable nennen
 *     plan_id + op_index + agent_id der fremden Op und den fertigen Aufruf zum Ansehen.
 *  A3 plan_status sagt, wo gekuerzt ist und wie man die Op vollstaendig holt.
 *  A4 Schemas (MCP-stdio, REST files + files_batch) + Guide (op_indices, Suchindex-Kuerzung).
 * AUFRUF: node packages/core/tests/file-batch-op-ansehen.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'opansehen-test';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e) }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
async function anlegen(p, t) { const x = await batch.planBatch({ project: PROJECT, agent_id: 'oa-setup', ops: [{ file_path: p, action: 'create', content: t }] }); await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'oa-setup' }); }
const zwanzig = (p) => Array.from({ length: 20 }, (_, i) => `${p}${i + 1}`).join('\n') + '\n';
const ansehen = batch.getPlanOpsVollstaendig ?? (async () => ({ success: false, error: 'getPlanOpsVollstaendig fehlt' }));
const verweist = (w, planId, index, agent) => w && String(w.plan_id) === String(planId)
  && JSON.stringify(w).includes(`op_index:${index}`) && JSON.stringify(w).includes(agent);

try {
  await aufraeumen();
  await anlegen('src/a.ts', zwanzig('a'));
  await res.addFileReservations({ project: PROJECT, agentId: 'oa-owner', filePaths: ['src/a.ts'] });
  const block = Array.from({ length: 5000 }, (_, i) => `// OWNER-BLOCK ${i + 1}`).join('\n');
  const p = await batch.planBatch({ project: PROJECT, agent_id: 'oa-owner', reason: 'grosser Einschub', ops: [
    { file_path: 'src/a.ts', action: 'replace_lines', line_start: 1, line_end: 1, content: 'A1', anchor_text: 'a1', reason: 'erste Zeile' },
    { file_path: 'src/a.ts', action: 'insert_after', after_line: 5, content: block, anchor_text: 'a5', reason: 'Block nach a5' },
  ] });
  const bOp = { file_path: 'src/a.ts', action: 'replace_lines', line_start: 6, line_end: 6, content: 'B6', anchor_text: 'a6' };
  await batch.planBatch({ project: PROJECT, agent_id: 'oa-b', ops: [bOp] });
  const add = await batch.addCoeditContribution({ project: PROJECT, plan_id: p.plan_id, agent_id: 'oa-b', ops: [bOp] });
  const w = (add.overlap_warnings ?? [])[0];
  pruefe(add.success === true && verweist(w, p.plan_id, 1, 'oa-owner') && /plan_status/.test(JSON.stringify(w)),
    'A2: overlap_warning nennt plan_id, op_index und agent_id der fremden Op samt Aufruf zum Ansehen', w);

  // ===== A1 Op vollstaendig =====
  const v = await versuch(() => ansehen({ plan_id: p.plan_id, op_indices: [1] }));
  const e = v.ops?.[0];
  pruefe(v.success === true && e?.op_index === 1 && e?.agent_id === 'oa-owner' && e?.status === 'aktiv' && e?.op?.action === 'insert_after'
    && e?.op?.content === block && e?.op?.anchor_text === 'a5' && e?.op?.after_line === 5 && e?.op?.reason === 'Block nach a5',
    'A1: fremde Op komplett (agent_id, action, content 5.000 Zeilen ungekuerzt, Anker, reason, Status)', { success: v.success, error: v.error, len: e?.op?.content?.length, soll: block.length, keys: e && Object.keys(e) });
  const nachher = e?.nachher?.zeilen ?? [];
  pruefe(e?.vorher?.zeilen?.includes('a5') && e?.vorher?.zeilen?.includes('a6') && nachher.includes('a5') && nachher.includes('// OWNER-BLOCK 1') && nachher.includes('// OWNER-BLOCK 5000') && nachher.includes('a6')
    && nachher.filter((z) => z.startsWith('// OWNER-BLOCK')).length === 5000,
    'A1: vorher/nachher zeigen die betroffenen Zeilen vollstaendig (alle 5.000 eingefuegten Zeilen)', { vorher: e?.vorher, nachherLaenge: nachher.length });
  const einzeln = await versuch(() => ansehen({ plan_id: p.plan_id, op_index: 2 }));
  pruefe(einzeln.ops?.[0]?.agent_id === 'oa-b' && einzeln.ops?.[0]?.op?.content === 'B6', 'A1: op_index einzeln, Beitrag von B mit Autor', einzeln.ops?.[0]);
  const fenster = await versuch(() => ansehen({ plan_id: p.plan_id, op_index: 1, from_line: 100, to_line: 102 }));
  pruefe(fenster.ops?.[0]?.op?.content === '// OWNER-BLOCK 100\n// OWNER-BLOCK 101\n// OWNER-BLOCK 102' && fenster.ops?.[0]?.content_fenster?.gesamt_zeilen === 5000,
    'A1: from_line/to_line liefern ein Fenster aus content und nennen die Gesamtlaenge', fenster.ops?.[0]?.content_fenster);

  // ===== A3 plan_status sagt, wie man vollstaendig holt =====
  const st = batch.buildPlanStatusResponse(await batch.getBatchPlan(p.plan_id));
  pruefe(/op_index/.test(JSON.stringify(st.op_vollstaendig ?? '')), 'A3: plan_status nennt den Weg zur vollstaendigen Op', st.op_vollstaendig);

  // ===== A2 coedit_conflict beim commit =====
  await anlegen('src/k.ts', zwanzig('k'));
  await res.addFileReservations({ project: PROJECT, agentId: 'oa-o2', filePaths: ['src/k.ts'] });
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: 'oa-o2', ops: [{ file_path: 'src/k.ts', action: 'insert_after', after_line: 3, content: 'O2' }] });
  const cOp = { file_path: 'src/k.ts', action: 'replace_lines', line_start: 4, line_end: 4, content: 'C4', anchor_text: 'k4' };
  await batch.planBatch({ project: PROJECT, agent_id: 'oa-c', ops: [cOp] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p2.plan_id, agent_id: 'oa-c', ops: [cOp] });
  const c2 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: 'oa-o2' });
  const k = (c2.conflicts ?? [])[0];
  pruefe(c2.error === 'coedit_conflict' && String(k?.plan_id) === p2.plan_id && /op_index:0/.test(JSON.stringify(k)) && /op_index:1/.test(JSON.stringify(k)),
    'A2: coedit_conflict nennt plan_id und beide Ops mit Aufruf zum Ansehen', k);

  // ===== A2 late_line_ops_unmappable nennt die aendernde Op =====
  await anlegen('src/l.ts', zwanzig('l'));
  await res.addFileReservations({ project: PROJECT, agentId: 'oa-o3', filePaths: ['src/l.ts'] });
  const p3 = await batch.planBatch({ project: PROJECT, agent_id: 'oa-o3', ops: [{ file_path: 'src/l.ts', action: 'replace_lines', line_start: 7, line_end: 7, content: 'O7', anchor_text: 'l7' }] });
  const dOp = { file_path: 'src/l.ts', action: 'replace_lines', line_start: 7, line_end: 7, content: 'D7' };
  await batch.planBatch({ project: PROJECT, agent_id: 'oa-d', ops: [dOp] });
  await batch.commitBatch({ plan_id: p3.plan_id, agent_id: 'oa-o3' });
  const l = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p3.plan_id, agent_id: 'oa-d', ops: [dOp] }));
  pruefe(l.error === 'late_line_ops_unmappable' && /plan_status/.test(JSON.stringify(l.abgelehnte_ops ?? '')) && /op_index:0/.test(JSON.stringify(l.abgelehnte_ops ?? '')) && /oa-o3/.test(JSON.stringify(l.abgelehnte_ops ?? '')),
    'A2: late_line_ops_unmappable nennt die aendernde Op (plan_id, op_index, agent_id) zum Ansehen', l.abgelehnte_ops);

  // ===== A4 Schemas + Guide =====
  const mcpFiles = await import(join(hier, '..', '..', 'mcp-server', 'dist', 'tools', 'consolidated', 'files.js'));
  const props = mcpFiles.filesTool.definition.inputSchema.properties;
  pruefe(props.op_indices?.type === 'array' && /plan_status/.test(props.op_index?.description ?? ''), 'A4: MCP-stdio-Schema nennt op_indices und op_index fuer plan_status', { op_index: props.op_index?.description });
  const rest = readFileSync(join(hier, '..', '..', 'rest-api', 'dist', 'routes', 'mcp.js'), 'utf8');
  pruefe((rest.match(/op_indices: \{/g) ?? []).length >= 2 && /getPlanOpsVollstaendig/.test(rest), 'A4: REST files + files_batch nennen op_indices, plan_status liefert die Op', null);
  const guide = readFileSync(join(dist, 'guide', 'content.js'), 'utf8');
  pruefe(/op_indices/.test(guide) && /Suchindex/.test(guide) && /vollen Inhalt/.test(guide), 'A4: Guide nennt op_index/op_indices und die Suchindex-Kuerzung', null);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await aufraeumen().catch(() => null);
  const r = await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM file_reservations WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1) AS n`, [PROJECT]);
  console.log('REST    ' + r.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(r.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
