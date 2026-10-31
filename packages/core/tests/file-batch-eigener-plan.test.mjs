/**
 * P6-T21 (11.10.2026): NACHTRAG IN DEN EIGENEN OFFENEN PLAN — nachgestellt im Wegwerf-Projekt PROJECT.
 *  E1 update im offenen Plan, danach plan mit search_replace auf einen Anker, den erst dieses update
 *     erzeugt: kein plan_failed, sondern merged_into in DENSELBEN Plan (gleiche plan_id, kein Zweitplan).
 *  E2 create im offenen Plan, danach search_replace auf die neue Datei: ebenso angehaengt.
 *  E3 Nachtrag, der auch zusammen mit dem eigenen Plan nicht passt: plan_failed mit eigene_plaene und
 *     dem plan_update-Aufruf auf den eigenen Plan in der Meldung.
 *  E4 plan_update ohne op_index, das eine Datei aus dem Plan nimmt: files_touched/expected_hashes ohne
 *     diese Datei, und ein fremder Agent bekommt fuer sie KEINEN Wait auf diesen Plan.
 *  E5 plan_update auf einen gescheiterten Entwurf: die Meldung beginnt mit der NEUEN plan_id; beide
 *     Tool-Strecken (REST, MCP-stdio) nennen bei Erfolg die neue plan_id zuerst.
 * Befund: Thought 879427e1 (Plaene 23323/23325 von c7-auto).
 * AUFRUF: node packages/core/tests/file-batch-eigener-plan.test.mjs (DATABASE_URL beachten — legt Zeilen im
 * Projekt PROJECT an und raeumt sie am Ende wieder ab).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'eigener-plan-test';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), geworfen: true, plan_id: e?.plan_id, eigene_plaene: e?.eigene_plaene }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
async function anlegen(p, t) { const x = await batch.planBatch({ project: PROJECT, agent_id: 'ep-setup', ops: [{ file_path: p, action: 'create', content: t }] }); await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'ep-setup' }); }
const offenePlaene = async (agent) => (await pool.query(`SELECT id::text AS id FROM file_batch_plans WHERE project = $1 AND owner_agent_id = $2 AND status = 'open' ORDER BY id`, [PROJECT, agent])).rows.map((r) => r.id);
const sr = (f, search, replace) => ({ file_path: f, action: 'search_replace', search, replace });

try {
  await aufraeumen();

  // ===== E1 update im Plan + search_replace-Nachtrag =====
  await anlegen('src/e1.ts', 'alt\n');
  const p1 = await batch.planBatch({ project: PROJECT, agent_id: 'ep-a', ops: [{ file_path: 'src/e1.ts', action: 'update', content: 'NEU-ANKER\n', anchor_contains: 'alt' }] });
  const n1 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'ep-a', ops: [sr('src/e1.ts', 'NEU-ANKER', 'NEU-ANKER\nNACHTRAG')] }));
  pruefe(!n1.geworfen && n1.plan_id === p1.plan_id && n1.merged_into?.[0]?.plan_id === p1.plan_id && n1.total_ops === 2,
    'E1: Nachtrag auf Anker aus dem update im eigenen Plan wird dort angehaengt (merged_into, gleiche plan_id)', n1);
  pruefe(JSON.stringify(await offenePlaene('ep-a')) === JSON.stringify([p1.plan_id]), 'E1: kein Zweitplan/Entwurf', await offenePlaene('ep-a'));
  const c1 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: 'ep-a' });
  pruefe(c1.success === true && (await inhalt('src/e1.ts')) === 'NEU-ANKER\nNACHTRAG\n', 'E1: commit schreibt update + Nachtrag', { c1, t: await inhalt('src/e1.ts') });

  // ===== E2 create im Plan + search_replace-Nachtrag =====
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: 'ep-b', ops: [{ file_path: 'src/e2-neu.ts', action: 'create', content: 'kopf\n' }] });
  const n2 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'ep-b', ops: [sr('src/e2-neu.ts', 'kopf', 'kopf\nzwei')] }));
  pruefe(!n2.geworfen && n2.plan_id === p2.plan_id && n2.merged_into?.[0]?.plan_id === p2.plan_id && n2.total_ops === 2,
    'E2: Nachtrag auf eine Datei, die erst per create im eigenen Plan entsteht, wird angehaengt', n2);
  pruefe(JSON.stringify(await offenePlaene('ep-b')) === JSON.stringify([p2.plan_id]), 'E2: kein Zweitplan/Entwurf', await offenePlaene('ep-b'));
  const c2 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: 'ep-b' });
  pruefe(c2.success === true && (await inhalt('src/e2-neu.ts')) === 'kopf\nzwei\n', 'E2: commit schreibt create + Nachtrag', { c2, t: await inhalt('src/e2-neu.ts') });

  // ===== E3 Nachtrag passt auch mit dem eigenen Plan nicht =====
  await anlegen('src/e3.ts', 'eins\n');
  const p3 = await batch.planBatch({ project: PROJECT, agent_id: 'ep-c', ops: [sr('src/e3.ts', 'eins', 'EINS')] });
  const n3 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'ep-c', ops: [sr('src/e3.ts', 'GIBTS-NICHT', 'x')] }));
  pruefe(n3.geworfen && n3.plan_id && n3.plan_id !== p3.plan_id && n3.eigene_plaene?.[0]?.plan_id === p3.plan_id
    && new RegExp(`plan_update", plan_id:"${p3.plan_id}"`).test(n3.error),
    'E3: plan_failed nennt den eigenen Plan (eigene_plaene) und den plan_update-Aufruf darauf', n3);
  const st3 = await batch.getBatchPlan(p3.plan_id);
  pruefe(st3.status === 'open' && st3.ops.length === 1, 'E3: der eigene Plan bleibt unveraendert', { status: st3.status, ops: st3.ops.length });
  if (n3.plan_id) await batch.cancelBatch(n3.plan_id, 'ep-c');
  await batch.cancelBatch(p3.plan_id, 'ep-c');

  // ===== E4 plan_update ohne op_index mit ersetzen_alle nimmt eine Datei heraus (P6-T51: ohne ersetzen_alle haengt es an) =====
  await anlegen('src/e4a.ts', 'a\n');
  await anlegen('src/e4b.ts', 'b\n');
  const p4 = await batch.planBatch({ project: PROJECT, agent_id: 'ep-d', ops: [sr('src/e4a.ts', 'a', 'A'), sr('src/e4b.ts', 'b', 'B')] });
  const u4 = await versuch(() => batch.replanBatch({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'ep-d', ersetzen_alle: true, ops: [sr('src/e4a.ts', 'a', 'AA')] }));
  pruefe(!u4.geworfen && u4.in_place === true && JSON.stringify(u4.files_touched) === JSON.stringify(['src/e4a.ts']),
    'E4: files_touched nach plan_update ohne op_index nur noch mit Dateien, die eine Op haben', u4);
  const st4 = await batch.getBatchPlan(p4.plan_id);
  pruefe(!('src/e4b.ts' in (st4.expected_hashes ?? {})), 'E4: expected_hashes ohne die herausgenommene Datei', st4.expected_hashes);
  const f4 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'ep-fremd', ops: [sr('src/e4b.ts', 'b', 'FREMD')] }));
  pruefe(!f4.geworfen && !(f4.coedit_waits?.length) && f4.plan_id !== p4.plan_id && f4.total_ops === 1,
    'E4: fremder Agent bekommt fuer die herausgenommene Datei keinen Wait auf den Plan', f4);
  await batch.cancelBatch(f4.plan_id, 'ep-fremd');
  await batch.cancelBatch(p4.plan_id, 'ep-d');

  // ===== E5 neue plan_id nach plan_update auf einen gescheiterten Entwurf =====
  await anlegen('src/e5.ts', 'fuenf\n');
  const d5 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'ep-e', ops: [sr('src/e5.ts', 'FALSCH', 'x')] }));
  const u5 = await versuch(() => batch.replanBatch({ project: PROJECT, plan_id: d5.plan_id, agent_id: 'ep-e', op_index: 0, ops: [sr('src/e5.ts', 'AUCH-FALSCH', 'x')] }));
  pruefe(u5.geworfen && u5.plan_id && u5.plan_id !== d5.plan_id && u5.error.startsWith(`NEUE plan_id ${u5.plan_id}`),
    'E5: gescheitertes plan_update beginnt mit der NEUEN plan_id', u5);
  const u5b = await versuch(() => batch.replanBatch({ project: PROJECT, plan_id: u5.plan_id, agent_id: 'ep-e', op_index: 0, ops: [sr('src/e5.ts', 'fuenf', 'FUENF')] }));
  pruefe(!u5b.geworfen && u5b.superseded_plan_id === u5.plan_id && u5b.plan_id !== u5.plan_id, 'E5: erfolgreiches plan_update auf den Entwurf liefert neue plan_id + superseded_plan_id', u5b);
  await batch.cancelBatch(u5b.plan_id, 'ep-e');
  const restSrc = readFileSync(join(hier, '..', '..', 'rest-api', 'src', 'routes', 'mcp.ts'), 'utf8');
  const stdioSrc = readFileSync(join(hier, '..', '..', 'mcp-server', 'src', 'tools', 'consolidated', 'files.ts'), 'utf8');
  pruefe(/NEUE plan_id \$\{result\.plan_id\}/.test(restSrc) && /NEUE plan_id \$\{result\.plan_id\}/.test(stdioSrc),
    'E5: REST und MCP-stdio nennen bei plan_update die NEUE plan_id zuerst', null);
} catch (error) {
  fehler++;
  console.error('ABBRUCH ' + (error?.stack ?? error));
} finally {
  await aufraeumen();
  const rest = (await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1) AS n`, [PROJECT])).rows[0].n;
  console.log(`AUFGERAEUMT (Rest ${rest})`);
  await pool.end();
}
console.log(fehler === 0 ? 'ALLE PRUEFUNGEN GRUEN' : `${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
