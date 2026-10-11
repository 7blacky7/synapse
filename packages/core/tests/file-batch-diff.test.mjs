/**
 * P15-T22 (11.10.2026): PLAN-SCHATTEN + DIFF — Wegwerf-Projekt PROJECT.
 *  D1 Fall wie Plan 23535: CRLF-Datei, search_replace_batch mit zwei weit auseinanderliegenden Edits ->
 *     zwei getrennte Hunks, nur die geaenderten Zeilen + Umfeld (statt Block vom ersten bis zum letzten Edit),
 *     kein \r in der Anzeige, crlf:true. plan() und plan_status(op_index) liefern es.
 *  D2 zwei Ops in einer Datei: je Hunk der Kopf "op <index>", plan_status(op_index) zeigt nur die eigenen Hunks.
 *  D3 nicht anwendbare Op: plan_failed traegt diff mit nicht_anwendbar; plan_status(op_index) anwendbar:false,
 *     diff null (kein erfundenes nachher); die anwendbare Op steht im Diff.
 *  D4 Co-Edit mit 2 Agenten: plan_status (ohne op_index) zeigt diff je Datei mit "op i (agent)".
 *  D5 Drift: Datei nach plan() aussen geaendert -> Diff gegen den Stand bei plan() + Hinweis drift.
 *  D6 committeter Plan: plan_status(op_index) zeigt das Diff gegen den Stand vor dem commit.
 *  D7 Messung: files(plan)-Antwortzeit mit Diff gegen ohne Diff (FILES_DIFF_MAX_ZEICHEN=1), ~100 KB, p95.
 *  D8 echter Plan 23535 (nur lesen, falls vorhanden): Zeilen des Diffs.
 *  Z1 nach dem commit haengt das endgueltige Diff (quelle commit, Kopf op/agent) nebenlaeufig an file_versions.
 *  Z2 fehlt es (NULL: Schreiben ohne Plan oder Prozess starb vor dem Nachtrag), rechnet get_version es nach
 *     und schreibt es zurueck. Z3 history liefert es gekuerzt. Z4 restore_batch-Vorschau zeigt Diffs, schreibt nichts.
 * AUFRUF: node packages/core/tests/file-batch-diff.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'diff-test-p15t22';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const cw = await import(join(dist, 'services', 'code-write.js'));
const fv = await import(join(dist, 'services', 'file-versions.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 800) : '')); }
}
const versuch = async (fn) => { try { return await fn(); } catch (e) { return { success: false, error: e?.message ?? String(e), _err: e }; } };
async function aufraeumen() {
  await pool.query(`DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project = $1)`, [PROJECT]);
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
async function anlegen(p, t) {
  const x = await batch.planBatch({ project: PROJECT, agent_id: 'dt-setup', ops: [{ file_path: p, action: 'create', content: t }] });
  await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'dt-setup' });
}
const zeilen = (praefix, n, nl = '\n') => Array.from({ length: n }, (_, i) => `${praefix}${i + 1}`).join(nl) + nl;
const text = (d) => String(d?.text ?? '');
const hunkZahl = (t) => (t.match(/^@@ /gm) ?? []).length;
const p95 = (werte) => { const s = [...werte].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

try {
  await aufraeumen();

  // ===== D1 Fall wie 23535: CRLF, zwei weit entfernte Edits in EINER Op =====
  await anlegen('src/schema.sql', zeilen('zeile ', 300, '\r\n'));
  const block = Array.from({ length: 17 }, (_, i) => `-- NEU ${i + 1}`).join('\n') + '\n';
  const p1 = await batch.planBatch({ project: PROJECT, agent_id: 'dt-a', ops: [{
    file_path: 'src/schema.sql', action: 'search_replace_batch', edits: [
      { search: 'zeile 10\n', replace: 'zeile 10\n' + block },
      { search: 'zeile 290\n', replace: 'zeile 290\n-- ENDE 1\n-- ENDE 2\n-- ENDE 3\n' },
    ],
  }] });
  const d1 = p1.diff?.dateien?.[0];
  const t1 = text(d1);
  pruefe(d1 && hunkZahl(t1) === 2 && d1.plus === 20 && d1.minus === 0 && d1.crlf === true && !t1.includes('\r') && t1.split('\n').length <= 36,
    'D1: plan() liefert 2 getrennte Hunks, +20/-0, crlf:true, kein \\r, <= 36 Zeilen (statt Block ueber ~280 Zeilen)', { d1, zeilen: t1.split('\n').length });
  const s1 = await batch.getPlanOpsVollstaendig({ plan_id: p1.plan_id, op_index: 0 });
  const st1 = text(s1.ops?.[0]?.diff?.[0]);
  pruefe(s1.ops?.[0]?.anwendbar === true && hunkZahl(st1) === 2 && st1.split('\n').length <= 36 && st1.includes('+-- NEU 17') && st1.includes(' zeile 10') && st1.includes('+-- ENDE 3'),
    'D1: plan_status(op_index) zeigt dieselben 2 Hunks', { zeilen: st1.split('\n').length, kopf: st1.split('\n')[0] });
  console.log('# D1 Beispiel:\n' + st1.split('\n').slice(0, 8).join('\n') + '\n# ...');
  await batch.cancelBatch(p1.plan_id, 'dt-a', 'test');

  // ===== D2 zwei Ops in einer Datei =====
  await anlegen('src/zwei.ts', zeilen('z', 100));
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: 'dt-a', ops: [
    { file_path: 'src/zwei.ts', action: 'replace_lines', line_start: 5, line_end: 5, content: 'Z5', anchor_text: 'z5' },
    { file_path: 'src/zwei.ts', action: 'search_replace', search: 'z80\n', replace: 'Z80\nZ80b\n' },
  ] });
  const t2 = text(p2.diff?.dateien?.[0]);
  pruefe(hunkZahl(t2) === 2 && /^@@ .* @@ op 0$/m.test(t2) && /^@@ .* @@ op 1$/m.test(t2) && p2.diff.dateien[0].plus === 3 && p2.diff.dateien[0].minus === 2,
    'D2: zwei Ops -> zwei Hunks mit Kopf "op 0" bzw. "op 1", +3/-2', { t2 });
  const s2 = await batch.getPlanOpsVollstaendig({ plan_id: p2.plan_id, op_indices: [0, 1] });
  const e20 = text(s2.ops?.[0]?.diff?.[0]);
  const e21 = text(s2.ops?.[1]?.diff?.[0]);
  pruefe(hunkZahl(e20) === 1 && e20.includes('+Z5') && !e20.includes('Z80') && hunkZahl(e21) === 1 && e21.includes('+Z80b') && !e21.includes('Z5'),
    'D2: plan_status je Op nur die eigenen Hunks', { e20, e21 });
  await batch.cancelBatch(p2.plan_id, 'dt-a', 'test');

  // ===== D3 nicht anwendbare Op =====
  await anlegen('src/drei.ts', zeilen('d', 30));
  const f3 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'dt-a', ops: [
    { file_path: 'src/drei.ts', action: 'replace_lines', line_start: 3, line_end: 3, content: 'D3', anchor_text: 'd3' },
    { file_path: 'src/drei.ts', action: 'search_replace', search: 'GIBT ES NICHT', replace: 'x' },
  ] }));
  const r3 = batch.planFailureResponse(f3._err);
  const na = r3.diff?.nicht_anwendbar ?? [];
  pruefe(r3.error === 'plan_failed' && na.length === 1 && na[0].op_index === 1 && /0 matches/.test(na[0].fehler) && text(r3.diff?.dateien?.[0]).includes('+D3') && !text(r3.diff?.dateien?.[0]).includes('GIBT'),
    'D3: plan_failed traegt diff: anwendbare Op im Diff, nicht anwendbare unter nicht_anwendbar', { na, d: r3.diff?.dateien });
  const s3 = await batch.getPlanOpsVollstaendig({ plan_id: r3.plan_id, op_index: 1 });
  pruefe(s3.ops?.[0]?.anwendbar === false && s3.ops?.[0]?.diff === null && /0 matches/.test(s3.ops?.[0]?.nicht_anwendbar ?? '') && !('nachher' in (s3.ops?.[0] ?? {})),
    'D3: plan_status(op_index) der nicht anwendbaren Op: anwendbar:false, diff null, kein nachher', s3.ops?.[0]);
  await batch.cancelBatch(r3.plan_id, 'dt-a', 'test');

  // ===== D4 Co-Edit mit 2 Agenten =====
  await anlegen('src/co.ts', zeilen('c', 40));
  await res.addFileReservations({ project: PROJECT, agentId: 'dt-owner', filePaths: ['src/co.ts'] });
  const p4 = await batch.planBatch({ project: PROJECT, agent_id: 'dt-owner', ops: [{ file_path: 'src/co.ts', action: 'replace_lines', line_start: 2, line_end: 2, content: 'OWNER2', anchor_text: 'c2' }] });
  const bOp = { file_path: 'src/co.ts', action: 'replace_lines', line_start: 30, line_end: 30, content: 'B30', anchor_text: 'c30' };
  await batch.planBatch({ project: PROJECT, agent_id: 'dt-b', ops: [bOp] });
  const add4 = await batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'dt-b', ops: [bOp] });
  const st4 = await batch.buildPlanStatusResponseMitDiff(await batch.getBatchPlan(p4.plan_id));
  const t4 = text(st4.diff?.dateien?.[0]);
  pruefe(add4.success === true && hunkZahl(t4) === 2 && t4.includes('op 0 (dt-owner)') && t4.includes('op 1 (dt-b)') && t4.includes('+OWNER2') && t4.includes('+B30'),
    'D4: Co-Edit: plan_status zeigt diff je Datei mit "op i (agent)" fuer beide Agenten', { t4, add: add4.message });
  const c4 = await batch.commitBatch({ plan_id: p4.plan_id, agent_id: 'dt-owner' });

  // ===== D6 committeter Plan =====
  const s6 = await batch.getPlanOpsVollstaendig({ plan_id: p4.plan_id, op_index: 1 });
  const t6 = text(s6.ops?.[0]?.diff?.[0]);
  pruefe(c4.success === true && s6.ops?.[0]?.status === 'committed' && t6.includes('-c30') && t6.includes('+B30') && !t6.includes('OWNER2'),
    'D6: committeter Plan: Diff der Op gegen den Stand vor dem commit', { c4: c4.message ?? c4.error, t6 });

  // ===== Z1 Diff nach commit an file_versions =====
  await new Promise((r) => setTimeout(r, 1000));
  const z1 = (await pool.query(`SELECT id::text AS id, diff FROM file_versions WHERE project = $1 AND batch_id = $2::bigint AND file_path = 'src/co.ts'`, [PROJECT, p4.plan_id])).rows[0];
  pruefe(z1?.diff?.quelle === 'commit' && String(z1.diff.plan_id) === String(p4.plan_id) && /op 0 \(dt-owner\)/.test(z1.diff.text ?? '') && /op 1 \(dt-b\)/.test(z1.diff.text ?? '') && z1.diff.plus === 2 && z1.diff.minus === 2,
    'Z1: nach commit traegt die file_versions-Zeile des Batches das endgueltige Diff (quelle commit, op/agent je Hunk)', z1?.diff);

  // ===== Z2 Nachberechnung bei NULL (Prozess starb vor dem Nachtrag) =====
  await pool.query(`UPDATE file_versions SET diff = NULL WHERE id = $1::bigint`, [z1?.id]);
  const z2 = await fv.getFileVersion(z1?.id);
  await new Promise((r) => setTimeout(r, 300));
  const z2db = (await pool.query(`SELECT diff FROM file_versions WHERE id = $1::bigint`, [z1?.id])).rows[0]?.diff;
  pruefe(z2?.diff?.quelle === 'nachberechnet' && (z2.diff.text ?? '').includes('+B30') && (z2.diff.text ?? '').includes('-c30') && z2db?.quelle === 'nachberechnet',
    'Z2: get_version rechnet ein fehlendes Diff aus Version und Nachfolger nach und schreibt es zurueck', { z2: z2?.diff, z2db });

  // ===== Z4 restore_batch-Vorschau =====
  const vorZahl = (await pool.query(`SELECT COUNT(*)::int AS n FROM file_versions WHERE project = $1`, [PROJECT])).rows[0].n;
  const z4 = await fv.restoreBatchVorschau(p4.plan_id);
  const nachZahl = (await pool.query(`SELECT COUNT(*)::int AS n FROM file_versions WHERE project = $1`, [PROJECT])).rows[0].n;
  const z4e = z4.find((e) => e.file_path === 'src/co.ts');
  pruefe(z4e && (z4e.batch_diff?.text ?? '').includes('+B30') && (z4e.rueckgaengig?.text ?? '').includes('-B30') && (z4e.rueckgaengig?.text ?? '').includes('+c30') && vorZahl === nachZahl,
    'Z4: restore_batch-Vorschau: batch_diff + rueckgaengig je Datei, nichts geschrieben', { z4e, vorZahl, nachZahl });

  // ===== D5 Drift zwischen plan und commit =====
  await anlegen('src/drift.ts', zeilen('r', 50));
  const p5 = await batch.planBatch({ project: PROJECT, agent_id: 'dt-a', ops: [{ file_path: 'src/drift.ts', action: 'replace_lines', line_start: 10, line_end: 10, content: 'R10', anchor_text: 'r10' }] });
  const vorDrift = await cw.getFileContentFromPg(PROJECT, 'src/drift.ts');
  await cw.updateFileInPg(PROJECT, 'src/drift.ts', vorDrift.replace('r40\n', 'FREMD40\n'), 'dt-fremd', 'test-drift');
  const s5 = await batch.getPlanOpsVollstaendig({ plan_id: p5.plan_id, op_index: 0 });
  const e5 = s5.ops?.[0]?.diff?.[0];
  pruefe(/seit plan\(\) geaendert/.test(e5?.drift ?? '') && /stale/.test(e5?.drift ?? '') && text(e5).includes('+R10') && !text(e5).includes('FREMD40'),
    'D5: Drift: Hinweis "seit plan() geaendert ... stale", Diff gegen den Stand bei plan()', e5);
  const c5 = await batch.commitBatch({ plan_id: p5.plan_id, agent_id: 'dt-a' });
  pruefe(c5.success === false && c5.status === 'stale', 'D5: commit nach Drift endet stale (unveraendertes Verhalten)', c5.status);

  // ===== Z3 history liefert Diffs (auch fuer Schreiben ohne Plan, nachberechnet) =====
  const z3 = await fv.listFileHistory(PROJECT, { file_path: 'src/drift.ts', limit: 10 });
  const z3fremd = z3.find((e) => e.edit_action === 'test-drift');
  pruefe(z3fremd?.diff && (z3fremd.diff.text ?? '').includes('+FREMD40') && (z3fremd.diff.text ?? '').includes('-r40') && z3fremd.diff.plus === 1 && z3fremd.diff.minus === 1,
    'Z3: history liefert je Eintrag das Diff (Schreiben ohne Plan: nachberechnet)', z3.map((e) => ({ a: e.edit_action, d: e.diff })));

  // ===== D7 Messung files(plan)-Antwortzeit =====
  const gross = Array.from({ length: 2500 }, (_, i) => `const wert${i} = berechne(${i}, 'abcdefghijklmnop');`).join('\n') + '\n';
  await anlegen('src/gross.ts', gross);
  const lauf = { mit: { ms: [], diffMs: [] }, ohne: { ms: [], diffMs: [] } };
  const laeufe = async (n, ziel) => {
    const { ms, diffMs } = ziel ?? { ms: [], diffMs: [] };
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      const p = await batch.planBatch({ project: PROJECT, agent_id: 'dt-m', ops: [
        { file_path: 'src/gross.ts', action: 'search_replace', search: 'const wert100 =', replace: `const wert100_${i} =` },
        { file_path: 'src/gross.ts', action: 'search_replace', search: 'const wert2000 =', replace: `const wert2000_${i} =` },
      ] });
      ms.push(performance.now() - t0);
      if (p.diff?.ms !== undefined) diffMs.push(p.diff.ms);
      await batch.cancelBatch(p.plan_id, 'dt-m', 'messung');
    }
    return { ms, diffMs };
  };
  await laeufe(5); // Aufwaermen
  // Verschraenkt (je Runde ohne, dann mit), damit Lastschwankungen der echten DB beide gleich treffen.
  for (let runde = 0; runde < 40; runde++) {
    process.env.FILES_DIFF_MAX_ZEICHEN = '1';
    await laeufe(1, lauf.ohne);
    delete process.env.FILES_DIFF_MAX_ZEICHEN;
    await laeufe(1, lauf.mit);
  }
  const { mit, ohne } = lauf;
  const delta = p95(mit.ms) - p95(ohne.ms);
  console.log(`# D7 ${gross.length} Zeichen, 2 Ops: plan p95 ohne Diff ${p95(ohne.ms).toFixed(1)} ms, mit Diff ${p95(mit.ms).toFixed(1)} ms, Delta ${delta.toFixed(1)} ms; diff.ms p95 ${p95(mit.diffMs).toFixed(1)} ms`);
  pruefe(delta <= 10, 'D7: files(plan) +<= 10 ms p95 durch den Diff (~130 KB, 2 Ops)', { delta, diffMs: p95(mit.diffMs) });

  // ===== D8 echter Plan 23535 (nur lesen) =====
  const echt = await versuch(() => batch.getPlanOpsVollstaendig({ plan_id: '23535', op_index: 0 }));
  if (echt.success && echt.ops?.[0]) {
    const e8 = echt.ops[0];
    const t8 = text(e8.diff?.[0]);
    console.log(`# D8 Plan 23535 op 0: anwendbar=${e8.anwendbar} Zeilen=${t8.split('\n').length} Hunks=${hunkZahl(t8)} plus=${e8.diff?.[0]?.plus} minus=${e8.diff?.[0]?.minus} crlf=${e8.diff?.[0]?.crlf}`);
    console.log(`# D8 nicht_anwendbar: ${e8.nicht_anwendbar ?? '-'} | preview.ok bei plan(): ${e8.preview?.ok}`);
    // Ehrlich statt erfundenem nachher: die Op war schon bei plan() nicht anwendbar (preview ok:false).
    pruefe(e8.preview?.ok === false ? (e8.anwendbar === false && e8.diff === null) : (e8.anwendbar === true && t8.split('\n').length <= 40 && !t8.includes('\r')),
      'D8: Plan 23535: Ergebnis passt zum Trockenlauf bei plan() (nicht anwendbar -> kein nachher, sonst kompaktes Diff)', { anwendbar: e8.anwendbar, ok: e8.preview?.ok });
  } else {
    console.log('# D8 Plan 23535 nicht vorhanden — uebersprungen');
  }
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
