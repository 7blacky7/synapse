/**
 * P22-T263 Leinwand (Nacharbeit, User-Vorgabe thought ad8d1f41 vom 01.11.2026): Aenderungen EINES Plans vollstaendig fuer die
 * Editor-Leinwand - core services/editor-plan-strom.ts leseEditorPlanAenderungen und file-batch.ts planSchattenVollstaendig,
 * gegen synapse_test:5433 mit eigenem Testprojekt (wird am Ende entfernt). Nach Core-Build:
 *   node packages/core/tests/editor-plan-leinwand-p22-t263.test.mjs
 * Prueft:
 *   1 offener Plan: vorher/nachher UNGEKUERZT, je Hunk die erzeugende Op (zwei weit getrennte Edits = zwei Hunks), neue Datei, +/-
 *   2 nicht anwendbare Op: mit Grund in nicht_anwendbar, die anwendbare Op steht trotzdem im Diff
 *   3 committeter Plan: quelle commit, Inhalte = Commit-Wahrheit aus PG
 *   4 verworfener Plan: Schatten (was der Plan getan haette), quelle schatten
 *   5 .env maskiert (vorher und nachher), Grund nicht anwendbarer Ops maskierter Dateien ohne Inhalt
 *   6 Summen-Grenze: weitere Dateien zurueckgestellt statt gekappt, datei=<pfad> laedt sie einzeln vollstaendig
 *   7 Schalter editor_plan_leinwand Standard AUS
 * Bei Fehlschlag: Assertion-Text mit Herkunft (Task + Funktion + Datei) und 'tatsaechlich ...'; kein Daemon/Browser.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.port, '5433', 'P22-T263 Testziel Port 5433'); assert.equal(url.pathname, '/synapse_test', 'P22-T263 Testziel synapse_test');
const db = await import('../dist/db/client.js'), S = await import('../dist/services/editor-plan-strom.js'), F = await import('../dist/services/file-batch.js');
const A = await import('../dist/services/agent-profil-schalter.js'), identitaet = await import('../dist/services/agent-bezug.js');
const pool = db.getPool(), project = 'test-p22-t263-lw-' + randomUUID(), agent = randomUUID();
const ctx = (fn) => identitaet.mitAgentAufrufKontext({ principal: { art: 'identity', project, agent_id: agent, identity_id: agent, rolle: 'subagent', modell: null, context_epoch: 1, lauf_id: null }, bezug: { modus: 'neu', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null } }, fn);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const insert = (path, text) => pool.query('INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash) VALUES($1,$2,$3,$3,$4,$5,$6,$7)', [randomUUID(), project, path, 'txt', Buffer.byteLength(text), text, hash(text)]);
const roherPlan = async (status, ops) => (await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status) VALUES($1,'roh-agent',$2::jsonb,'{}'::jsonb,'[]'::jsonb,$3) RETURNING id::text", [project, JSON.stringify(ops), status])).rows[0].id;
const kurz = (v) => { try { return JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 120 ? x.slice(0, 120) + '...(' + x.length + ')' : x)).slice(0, 700); } catch { return String(v).slice(0, 700); } };
const zeilen = Array.from({ length: 20 }, (_, i) => 'l' + String(i + 1).padStart(2, '0')).join('\n');
try {
  await pool.query('INSERT INTO projects(name,hostname,path) VALUES($1,$2,$3)', [project, 'test-p22-t263-lw', '/tmp/p22-t263-lw-' + randomUUID()]);
  await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von) VALUES($1,$2,$1,$1,'subagent','aktiv','test')", [agent, project]);
  await insert('src/a.txt', zeilen); await insert('.env', 'SECRET=geheim');

  // 7 Schalter: neue Funktion Standard AUS (regel-neue-funktionen-mit-schalter-und-debug).
  assert.equal(S.EDITOR_PLAN_LEINWAND_FUNKTION, 'editor_plan_leinwand', 'P22-T263 editor-plan-strom.ts: Funktionsname der Leinwand');
  const schalter = await A.leseProfilProduktSchalter('editor_plan_leinwand', project);
  assert.equal(schalter.aktiv, false, 'P22-T263 agent-profil-schalter.ts: editor_plan_leinwand Standard AUS, tatsaechlich ' + kurz(schalter));

  // 1 Offener Plan: zwei getrennte Edits (Op 0, Op 1) + neue Datei (Op 2). User ad8d1f41: "als Ganzes ... nicht abgehackt".
  const p1 = await ctx(() => F.planBatch({ project, agent_id: agent, open_for_coedit: false, ops: [
    { file_path: 'src/a.txt', action: 'search_replace', search: 'l02', replace: 'L02', reason: 'oben' },
    { file_path: 'src/a.txt', action: 'search_replace', search: 'l18', replace: 'L18\nL18b', reason: 'unten' },
    { file_path: 'src/neu.ts', action: 'create', content: 'export const x = 1;\nexport const y = 2;\n' },
  ] }));
  assert.equal(p1.success !== false, true, 'P22-T263 file-batch.ts planBatch: Plan angelegt, tatsaechlich ' + kurz(p1));
  const id1 = String(p1.plan_id);
  const r1 = await S.leseEditorPlanAenderungen(project, id1);
  assert.ok(r1 && r1.quelle === 'schatten' && r1.plan.zustand === 'entsteht', 'P22-T263 editor-plan-strom.ts leseEditorPlanAenderungen: offener Plan aus dem Schatten, tatsaechlich ' + kurz(r1 && { quelle: r1.quelle, plan: r1.plan.zustand }));
  const a = r1.dateien.find((d) => d.file_path === 'src/a.txt'), n = r1.dateien.find((d) => d.file_path === 'src/neu.ts');
  assert.ok(a && a.vorher === zeilen && a.nachher === zeilen.replace('l02', 'L02').replace('l18', 'L18\nL18b'), 'P22-T263 leseEditorPlanAenderungen: vorher/nachher ungekuerzt, tatsaechlich ' + kurz(a));
  assert.ok(a.hunks.length === 2 && a.hunks[0].ops.join() === '0' && a.hunks[1].ops.join() === '1', 'P22-T263 leseEditorPlanAenderungen: je Hunk die erzeugende Op, tatsaechlich ' + kurz(a.hunks));
  assert.ok(a.plus === 3 && a.minus === 2 && a.ops.join() === '0,1' && a.zurueckgestellt === false && a.zu_gross === null, 'P22-T263 leseEditorPlanAenderungen: +/- und Ops der Datei, tatsaechlich ' + kurz({ plus: a.plus, minus: a.minus, ops: a.ops }));
  assert.ok(n && n.neu === true && n.vorher === '' && n.nachher.startsWith('export const x'), 'P22-T263 leseEditorPlanAenderungen: neue Datei, tatsaechlich ' + kurz(n));
  assert.deepEqual(r1.dateien.map((d) => d.file_path), ['src/a.txt', 'src/neu.ts'], 'P22-T263 leseEditorPlanAenderungen: Reihenfolge wie im Plan');
  assert.equal(r1.nicht_anwendbar.length, 0, 'P22-T263 leseEditorPlanAenderungen: keine nicht anwendbaren Ops, tatsaechlich ' + kurz(r1.nicht_anwendbar));

  // 2 Nicht anwendbare Op (Suchtext fehlt) neben einer anwendbaren. Plan direkt in PG, weil planBatch solche Ops abweist.
  const id2 = await roherPlan('open', [{ file_path: 'src/a.txt', action: 'search_replace', search: 'GIBT-ES-NICHT', replace: 'x' }, { file_path: 'src/a.txt', action: 'search_replace', search: 'l10', replace: 'L10' }]);
  const r2 = await S.leseEditorPlanAenderungen(project, id2);
  assert.ok(r2.nicht_anwendbar.length === 1 && r2.nicht_anwendbar[0].op_index === 0 && r2.nicht_anwendbar[0].file_path === 'src/a.txt' && r2.nicht_anwendbar[0].fehler.length > 0,
    'P22-T263 leseEditorPlanAenderungen: nicht anwendbare Op mit Grund, tatsaechlich ' + kurz(r2.nicht_anwendbar));
  const a2 = r2.dateien.find((d) => d.file_path === 'src/a.txt');
  assert.ok(a2 && a2.nachher.includes('L10') && a2.hunks.length === 1, 'P22-T263 leseEditorPlanAenderungen: anwendbare Op steht trotzdem im Diff, tatsaechlich ' + kurz(a2));

  // 3 Commit -> Commit-Wahrheit aus PG.
  const c1 = await ctx(() => F.commitBatch({ plan_id: id1, agent_id: agent }));
  assert.equal(c1.success, true, 'P22-T263 file-batch.ts commitBatch: Commit, tatsaechlich ' + kurz(c1));
  const r3 = await S.leseEditorPlanAenderungen(project, id1);
  const a3 = r3.dateien.find((d) => d.file_path === 'src/a.txt');
  const aktuell = (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2', [project, 'src/a.txt'])).rows[0].content;
  assert.ok(r3.quelle === 'commit' && a3 && a3.quelle === 'commit' && a3.vorher === zeilen && a3.nachher === aktuell && r3.nicht_anwendbar.length === 0,
    'P22-T263 leseEditorPlanAenderungen: committeter Plan zeigt die Inhalte aus PG, tatsaechlich ' + kurz({ quelle: r3.quelle, a3 }));
  assert.ok(a3.hunks.length === 2 && a3.hunks[0].ops.join() === '0', 'P22-T263 leseEditorPlanAenderungen: Schatten stimmt mit PG ueberein -> Op-Zuordnung bleibt, tatsaechlich ' + kurz(a3.hunks));

  // 4 Verworfener Plan: was der Plan getan haette (Schatten), Zustand verworfen.
  const p4 = await ctx(() => F.planBatch({ project, agent_id: agent, open_for_coedit: false, ops: [{ file_path: 'src/a.txt', action: 'search_replace', search: 'l05', replace: 'NIE' }] }));
  await ctx(() => F.cancelBatch(String(p4.plan_id), agent, 'Test P22-T263 Leinwand'));
  const r4 = await S.leseEditorPlanAenderungen(project, String(p4.plan_id));
  assert.ok(r4.plan.zustand === 'verworfen' && r4.quelle === 'schatten' && r4.dateien[0]?.nachher?.includes('NIE'), 'P22-T263 leseEditorPlanAenderungen: verworfener Plan zeigt seinen Schatten, tatsaechlich ' + kurz({ z: r4.plan.zustand, d: r4.dateien[0] }));

  // 5 .env: Ops auf sensible Dateien wendet die Op-Anwendung nicht an (DEFAULT_IGNORES) -> nicht anwendbar mit maskiertem Grund.
  //   Inhalte maskiert: am committeten Altbestand (Plan + Version direkt in PG, wie im Strom-Test editor-plan-strom-p22-t263).
  const id5 = await roherPlan('open', [{ file_path: '.env', action: 'update', content: 'SECRET=neu-geheim' }]);
  const r5 = await S.leseEditorPlanAenderungen(project, id5);
  assert.ok(r5.nicht_anwendbar.length === 1 && r5.nicht_anwendbar[0].file_path === '.env' && r5.nicht_anwendbar.every((x) => !x.fehler.includes('geheim')),
    'P22-T263 leseEditorPlanAenderungen: Op auf .env nicht anwendbar, Grund ohne Inhalt, tatsaechlich ' + kurz(r5.nicht_anwendbar));
  assert.ok(!JSON.stringify(r5.dateien).includes('geheim'), 'P22-T263 leseEditorPlanAenderungen: kein .env-Inhalt in der Antwort, tatsaechlich ' + kurz(r5.dateien));
  const id5b = (await pool.query("INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,committed_at) VALUES($1,'env-agent',$2::jsonb,'{}'::jsonb,'[]'::jsonb,'committed',NOW()) RETURNING id::text", [project, JSON.stringify([{ file_path: '.env', action: 'update' }])])).rows[0].id;
  await pool.query('INSERT INTO file_versions(project,file_path,content,content_hash,batch_id) VALUES($1,$2,$3,$4,$5::bigint)', [project, '.env', 'SECRET=vorher-geheim', hash('SECRET=vorher-geheim'), id5b]);
  const r5b = await S.leseEditorPlanAenderungen(project, id5b);
  const e5 = r5b.dateien.find((d) => d.file_path === '.env');
  assert.ok(e5 && e5.maskiert && e5.quelle === 'commit' && !String(e5.vorher).includes('geheim') && !String(e5.nachher).includes('geheim'), 'P22-T263 leseEditorPlanAenderungen: .env maskiert (vorher und nachher), tatsaechlich ' + kurz(e5));

  // 6 Summen-Grenze (leinwand_summe_zeichen 4 000 000): vier neue Dateien je ~1,2 Mio. Zeichen -> die vierte wird zurueckgestellt, nicht gekappt.
  const gross = 'zeile\n'.repeat(200000);
  const id6 = await roherPlan('open', [1, 2, 3, 4].map((k) => ({ file_path: 'gross/d' + k + '.txt', action: 'create', content: gross })));
  const r6 = await S.leseEditorPlanAenderungen(project, id6);
  const zurueck = r6.dateien.filter((d) => d.zurueckgestellt);
  assert.ok(r6.dateien.length === 4 && zurueck.length === 1 && zurueck[0].file_path === 'gross/d4.txt' && zurueck[0].nachher === null && zurueck[0].plus > 0,
    'P22-T263 leseEditorPlanAenderungen: Summen-Grenze stellt zurueck (Kopfzahlen bleiben), tatsaechlich ' + kurz(r6.dateien.map((d) => [d.file_path, d.zurueckgestellt, d.nachher?.length ?? null])));
  assert.ok(r6.dateien.filter((d) => !d.zurueckgestellt).every((d) => d.nachher === gross), 'P22-T263 leseEditorPlanAenderungen: nicht zurueckgestellte Dateien ungekuerzt');
  const r6b = await S.leseEditorPlanAenderungen(project, id6, { datei: 'gross/d4.txt' });
  assert.ok(r6b.dateien.length === 1 && r6b.dateien[0].nachher === gross && !r6b.dateien[0].zurueckgestellt, 'P22-T263 leseEditorPlanAenderungen: datei=<pfad> laedt die Datei einzeln vollstaendig, tatsaechlich ' + kurz(r6b.dateien.map((d) => [d.file_path, d.nachher?.length])));
  assert.ok(r6.grenzen.leinwand_summe_zeichen === S.EDITOR_PLAN_STROM_GRENZEN.leinwand_summe_zeichen, 'P22-T263 leseEditorPlanAenderungen: Grenzen im Debug sichtbar, tatsaechlich ' + kurz(r6.grenzen));

  assert.equal(await S.leseEditorPlanAenderungen(project, '999999999999'), null, 'P22-T263 leseEditorPlanAenderungen: unbekannter Plan -> null');
  await assert.rejects(() => S.leseEditorPlanAenderungen(project, 'abc'), /plan_ungueltig/, 'P22-T263 leseEditorPlanAenderungen: ungueltige Plan-ID abgewiesen');
  console.log('OK P22-T263 editor-plan-leinwand (synapse_test)');
} finally {
  await pool.query('DELETE FROM file_versions WHERE project=$1', [project]); await pool.query('DELETE FROM file_reservations WHERE project=$1', [project]).catch(() => {});
  await pool.query('DELETE FROM file_batch_waits WHERE project=$1', [project]).catch(() => {}); await pool.query('DELETE FROM file_batch_plans WHERE project=$1', [project]);
  await pool.query('DELETE FROM agent_identitaeten WHERE project=$1', [project]);
  await pool.query('DELETE FROM code_files WHERE project=$1', [project]); await pool.query('DELETE FROM projects WHERE name=$1', [project]); await pool.end();
}
// Nach Erfolg sicher beenden: geladene Kern-Module (Schalter-Puffer, Nachlauf nach commit) koennen Timer offen halten.
process.exit(0);
