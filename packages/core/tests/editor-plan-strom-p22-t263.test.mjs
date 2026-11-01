/**
 * P22-T263: Editor-Plan-Strom aus PG (core services/editor-plan-strom.ts) gegen synapse_test:5433, eigenes Testprojekt.
 * Herkunft: User-Vorgabe thought 9a3005ff, Bestand c31f5886. Nach Core-Build:
 *   node packages/core/tests/editor-plan-strom-p22-t263.test.mjs
 * Prueft: offener Plan im Strom mit Ops-Metadaten ohne Inhalt; Plan waechst per plan_update; Commit -> Zustand committet, Ergebnis
 * vorher/nachher aus PG (aktueller Stand, nach Folgecommit Folgeversion); verworfener Plan im Verlauf ohne Ergebnis; alter Plan nur im
 * Verlauf, nicht im Strom; Cursor vor_id; .env maskiert; editor_plan_offen_sekunden mit Quelle; plan_nachleuchten_sekunden unberuehrt.
 * Erwartung und tatsaechliches Ergebnis stehen in jeder Assertion; kein Daemon/Browser.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433', 'P22-T263 Testziel Port 5433'); assert.equal(url.pathname, '/synapse_test', 'P22-T263 Testziel synapse_test');
const db = await import('../dist/db/client.js'), S = await import('../dist/services/editor-plan-strom.js'), F = await import('../dist/services/file-batch.js');
const N = await import('../dist/services/agentennetzwerk.js'), identitaet = await import('../dist/services/agent-bezug.js');
const pool = db.getPool(), project = 'test-p22-t263-' + randomUUID(), agent = randomUUID();
const ctx = (fn) => identitaet.mitAgentAufrufKontext({ principal: { art: 'identity', project, agent_id: agent, identity_id: agent, rolle: 'subagent', modell: null, context_epoch: 1, lauf_id: null }, bezug: { modus: 'neu', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null } }, fn);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const insert = (path, text) => pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)', [randomUUID(), project, path, 'txt', Buffer.byteLength(text), text, hash(text)]);
const kurz = (v) => JSON.stringify(v).slice(0, 600);
try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'test-p22-t263', '/tmp/p22-t263-' + randomUUID()]);
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,$1,$1,'subagent','aktiv','test')", [agent, project]);
  await insert('src/a.txt', 'alt\nbleibt'); await insert('.env', 'SECRET=geheim');

  // Einstellung: eigener Wert neben plan_nachleuchten_sekunden, Netzwerkwert unveraendert.
  assert.equal(N.NETZWERK_EINSTELLUNGEN.editor_plan_offen_sekunden.standard, 20, 'P22-T263 agentennetzwerk.ts: editor_plan_offen_sekunden Standard 20');
  assert.equal(N.NETZWERK_EINSTELLUNGEN.plan_nachleuchten_sekunden.standard, 3, 'P22-T263 agentennetzwerk.ts: plan_nachleuchten_sekunden bleibt 3');
  const offen = await S.leseEditorPlanOffen(project);
  assert.ok(Number.isInteger(offen.sekunden) && ['standard', 'einstellung'].includes(offen.quelle), 'P22-T263 editor-plan-strom.ts: Offen-Fenster mit Quelle, tatsaechlich ' + kurz(offen));

  // 1 Offener Plan erscheint mit Ops-Metadaten, ohne Inhalte.
  const p1 = await ctx(() => F.planBatch({ project, agent_id: agent, open_for_coedit: false, ops: [{ file_path: 'src/a.txt', action: 'search_replace', search: 'alt', replace: 'neu', reason: 'Grund A' }] }));
  assert.equal(p1.success !== false, true, 'P22-T263 file-batch.ts: Plan angelegt, tatsaechlich ' + kurz(p1));
  const id1 = String(p1.plan_id);
  let strom = await S.leseEditorPlanStrom(project);
  let e1 = strom.plaene.find((p) => p.id === id1);
  assert.ok(e1 && e1.zustand === 'entsteht' && e1.ende_am === null, 'P22-T263 editor-plan-strom.ts: offener Plan im Strom (entsteht), tatsaechlich ' + kurz(e1));
  assert.deepEqual(e1.ops.map((o) => [o.i, o.action, o.file_path, o.reason]), [[0, 'search_replace', 'src/a.txt', 'Grund A']], 'P22-T263 editor-plan-strom.ts: Ops-Metadaten, tatsaechlich ' + kurz(e1.ops));
  assert.ok(!JSON.stringify(e1).includes('"neu"') && !('search' in e1.ops[0]) && !('content' in e1.ops[0]), 'P22-T263 editor-plan-strom.ts: keine Inhalte in der Projektion, tatsaechlich ' + kurz(e1.ops[0]));
  assert.deepEqual(e1.dateien, ['src/a.txt'], 'P22-T263 editor-plan-strom.ts: Dateien des Plans');

  // 2 Plan waechst (plan_update) -> Strom zeigt die neue Op.
  // Eigener Probeplan, damit Plan 1 regulaer committet; plan_update schreibt dieselbe ops-Spalte (NOTIFY-Trigger feuert bei UPDATE).
  const wachs = await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status) VALUES($1,'wachs',$2::jsonb,'{}'::jsonb,'[]'::jsonb,'open') RETURNING id::text", [project, JSON.stringify([{ file_path: 'w.txt', action: 'create', content: 'x' }])]);
  const wachsId = wachs.rows[0].id;
  await pool.query('UPDATE file_batch_plans SET ops = ops || $2::jsonb WHERE id=$1::bigint', [wachsId, JSON.stringify([{ file_path: 'w.txt', action: 'move', new_path: 'v.txt' }])]);
  const ew = (await S.leseEditorPlanStrom(project)).plaene.find((p) => p.id === wachsId);
  assert.ok(ew && ew.ops.length === 2 && ew.ops[1].new_path === 'v.txt' && ew.dateien.join() === 'w.txt,v.txt', 'P22-T263 editor-plan-strom.ts: entstehender Plan waechst live (plan_update), tatsaechlich ' + kurz(ew));
  await pool.query("UPDATE file_batch_plans SET status='cancelled' WHERE id=$1::bigint", [wachsId]);

  // 3 Commit -> committet, Ergebnis vorher/nachher aus PG (aktueller Stand).
  const c1 = await ctx(() => F.commitBatch({ plan_id: id1, agent_id: agent }));
  assert.equal(c1.success, true, 'P22-T263 file-batch.ts: Commit, tatsaechlich ' + kurz(c1));
  strom = await S.leseEditorPlanStrom(project); e1 = strom.plaene.find((p) => p.id === id1);
  assert.ok(e1 && e1.zustand === 'committet' && e1.ende_am, 'P22-T263 editor-plan-strom.ts: frisch committeter Plan bleibt im Strom (Fenster), tatsaechlich ' + kurz(e1));
  let erg = await S.leseEditorPlanErgebnis(project, id1);
  const a1 = erg.dateien.find((d) => d.file_path === 'src/a.txt');
  assert.ok(a1 && a1.vorher === 'alt\nbleibt' && a1.nachher_quelle === 'aktuell' && a1.nachher.startsWith('neu'), 'P22-T263 editor-plan-strom.ts: Ergebnis vorher/nachher (aktuell), tatsaechlich ' + kurz(a1));

  // 4 Folgecommit -> Ergebnis von Plan 1 zeigt weiter den Stand direkt nach Plan 1 (Folgeversion).
  const p2 = await ctx(() => F.planBatch({ project, agent_id: agent, open_for_coedit: false, ops: [{ file_path: 'src/a.txt', action: 'search_replace', search: 'neu', replace: 'neuer' }] }));
  const c2 = await ctx(() => F.commitBatch({ plan_id: p2.plan_id, agent_id: agent }));
  assert.equal(c2.success, true, 'P22-T263 file-batch.ts: Folgecommit, tatsaechlich ' + kurz(c2));
  erg = await S.leseEditorPlanErgebnis(project, id1);
  const a2 = erg.dateien.find((d) => d.file_path === 'src/a.txt');
  assert.ok(a2 && a2.nachher_quelle === 'folgeversion' && a2.nachher.startsWith('neu\n'), 'P22-T263 editor-plan-strom.ts: Stand nach Plan 1 aus der Folgeversion, tatsaechlich ' + kurz(a2));

  // 5 Verworfener Plan: im Verlauf, Ergebnis ohne Dateien.
  const p3 = await ctx(() => F.planBatch({ project, agent_id: agent, open_for_coedit: false, ops: [{ file_path: 'src/a.txt', action: 'search_replace', search: 'neuer', replace: 'nie' }] }));
  await ctx(() => F.cancelBatch(String(p3.plan_id), agent, 'Test P22-T263'));
  const e3 = (await S.leseEditorPlanStrom(project)).plaene.find((p) => p.id === String(p3.plan_id));
  assert.ok(e3 && e3.zustand === 'verworfen', 'P22-T263 editor-plan-strom.ts: verworfener Plan im Strom als verworfen, tatsaechlich ' + kurz(e3));
  const erg3 = await S.leseEditorPlanErgebnis(project, String(p3.plan_id));
  assert.ok(erg3.dateien.length === 0 && erg3.hinweis === 'nicht_committet', 'P22-T263 editor-plan-strom.ts: kein Ergebnis fuer verworfenen Plan, tatsaechlich ' + kurz(erg3));

  // 6 Alter Plan: nur im Verlauf, nicht im Strom; Cursor vor_id.
  const alt = await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,created_at,committed_at) VALUES($1,'alt-agent',$2::jsonb,'{}'::jsonb,'[]'::jsonb,'committed',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '2 hours') RETURNING id::text", [project, JSON.stringify([{ file_path: 'x.txt', action: 'create', content: 'GEHEIM-INHALT' }])]);
  const altId = alt.rows[0].id;
  await pool.query("UPDATE file_batch_plans SET status_geaendert_am=NOW()-INTERVAL '2 hours' WHERE id=$1::bigint", [altId]);
  strom = await S.leseEditorPlanStrom(project);
  assert.ok(!strom.plaene.some((p) => p.id === altId), 'P22-T263 editor-plan-strom.ts: alter Plan nicht im Strom, tatsaechlich ' + kurz(strom.plaene.map((p) => p.id)));
  const v1 = await S.leseEditorPlanVerlauf(project, { limit: 2 });
  assert.ok(v1.plaene.length === 2 && v1.plaene.every((p) => p.status !== 'open') && v1.naechste, 'P22-T263 editor-plan-strom.ts: Verlauf seitenweise, tatsaechlich ' + kurz(v1));
  const v2 = await S.leseEditorPlanVerlauf(project, { vorId: v1.naechste, limit: 10 });
  assert.ok(v2.plaene.every((p) => Number(p.id) < Number(v1.naechste)) && v2.plaene.some((p) => p.id === id1) && [...v1.plaene, ...v2.plaene].some((p) => p.id === altId), 'P22-T263 editor-plan-strom.ts: Cursor vor_id liefert aeltere Plaene, tatsaechlich ' + kurz(v2.plaene.map((p) => p.id)));
  assert.ok(!JSON.stringify([v1, v2]).includes('GEHEIM-INHALT'), 'P22-T263 editor-plan-strom.ts: Verlauf ohne Op-Inhalte');

  // 7 .env maskiert im Ergebnis.
  // .env ist fuer files gesperrt (DEFAULT_IGNORES); Altbestand in PG kann trotzdem Versionen haben -> Plan und Version direkt anlegen.
  const p4 = await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,committed_at) VALUES($1,'env-agent',$2::jsonb,'{}'::jsonb,'[]'::jsonb,'committed',NOW()) RETURNING id::text", [project, JSON.stringify([{ file_path: '.env', action: 'update' }])]);
  const id4 = p4.rows[0].id;
  await pool.query('INSERT INTO file_versions(project,file_path,content,content_hash,batch_id) VALUES($1,$2,$3,$4,$5::bigint)', [project, '.env', 'SECRET=vorher-geheim', hash('SECRET=vorher-geheim'), id4]);
  const e4 = await S.leseEditorPlanErgebnis(project, id4);
  assert.ok(e4.dateien.length === 1 && e4.dateien.every((d) => d.maskiert && !d.vorher.includes('geheim') && !(d.nachher ?? '').includes('geheim')), 'P22-T263 editor-plan-strom.ts: sensible Datei maskiert (vorher und nachher), tatsaechlich ' + kurz(e4.dateien));
  console.log('OK P22-T263 editor-plan-strom (synapse_test)');
} finally {
  await pool.query('DELETE FROM file_versions WHERE project=$1', [project]); await pool.query('DELETE FROM file_reservations WHERE project=$1', [project]).catch(() => {});
  await pool.query('DELETE FROM file_batch_waits WHERE project=$1', [project]).catch(() => {}); await pool.query('DELETE FROM file_batch_plans WHERE project=$1', [project]);
  await pool.query('DELETE FROM agent_identitaeten WHERE project=$1', [project]);
  await pool.query('DELETE FROM code_files WHERE project=$1', [project]); await pool.query('DELETE FROM projects WHERE name=$1', [project]); await pool.end();
}
