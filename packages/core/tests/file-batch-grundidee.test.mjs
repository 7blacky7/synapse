/**
 * CO-EDIT-GRUNDIDEE (Entscheidung 29.09.2026, Abgleich 11fc9fc8) — Wegwerf-Projekt PROJECT.
 *  E1 Ready-Gate nur fuer AKTIVE: ein Beitragender/Wartender, der noch nicht ready ist und in
 *     den letzten SYNAPSE_COEDIT_AKTIV_MIN Minuten Tool-Aktivitaet hatte, haelt den commit auf
 *     (status waiting_for_contributors, kein terminaler Fehler). Inaktive blockieren nie, ihre
 *     Ops werden mitgeschrieben. commit mit wait_seconds wacht auf, sobald er ready meldet
 *     oder inaktiv wird.
 *  V1 commit/cancel/Rueckzug/Folgeplan quittieren PLAN_READY nicht still: jeder Betroffene
 *     bekommt ein persistentes Nachfolge-Event (PLAN_COMMITTED/PLAN_CANCELLED/PLAN_CHANGED/
 *     PLAN_FOLLOWUP) in pending_events.
 *  V2 Spaete Zeilen-Ops (Stand VOR dem commit) werden in den Folgeplan richtig umgerechnet oder
 *     klar abgelehnt — nie falsche Zeilen.
 *  V3 cancel ohne agent_id verwirft keine fremden Ops.
 *  V4 Plaene auf ueberlappenden Dateien werden zusammengefuehrt (auch desselben Owners): immer
 *     genau ein Ziel.
 * AUFRUF: node packages/core/tests/file-batch-grundidee.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'grundidee-test';
const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const events = await import(join(dist, 'services', 'events.js'));
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
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
const zeile = async (id) => (await pool.query('SELECT status::text AS status, jsonb_array_length(ops)::int AS ops FROM file_batch_plans WHERE id=$1', [id])).rows[0] ?? null;
async function anlegen(p, t) { const x = await batch.planBatch({ project: PROJECT, agent_id: 'gi-setup', ops: [{ file_path: p, action: 'create', content: t }] }); await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'gi-setup' }); }
const zehn = (p) => Array.from({ length: 10 }, (_, i) => `${p}${i + 1}`).join('\n') + '\n';
const rl = (f, line, anker, text) => ({ file_path: f, action: 'replace_lines', line_start: line, line_end: line, content: text, ...(anker ? { anchor_text: anker } : {}) });
const aktiv = (agent) => pool.query(`INSERT INTO tool_calls (project, tool_name, action, agent_id, ts) VALUES ($1, 'code_intel', 'file', $2, NOW())`, [PROJECT, agent]);
const offen = async (agent) => (await events.getPendingEvents(PROJECT, agent, 50)).map((e) => ({ typ: e.eventType, payload: (() => { try { return JSON.parse(e.payload ?? '{}'); } catch { return {}; } })() }));
const ms = (t0) => Date.now() - t0;

try {
  await aufraeumen();

  // ===== E1 Ready-Gate nur fuer aktive Beitragende =====
  await anlegen('src/e1.ts', zehn('e'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o1', filePaths: ['src/e1.ts'] });
  const p1 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o1', ops: [rl('src/e1.ts', 1, 'e1', 'O1')] });
  const opAktiv = rl('src/e1.ts', 3, 'e3', 'AKTIV3');
  const opInaktiv = rl('src/e1.ts', 5, 'e5', 'INAKTIV5');
  const wA = await batch.planBatch({ project: PROJECT, agent_id: 'gi-aktiv', ops: [opAktiv] });
  const wI = await batch.planBatch({ project: PROJECT, agent_id: 'gi-inaktiv', ops: [opInaktiv] });
  pruefe(wA.coedit_waits?.[0]?.target_plan_id === p1.plan_id && wI.coedit_waits?.[0]?.target_plan_id === p1.plan_id, 'E1: beide Wartenden haben den Owner-Plan als Ziel', { a: wA.coedit_waits, i: wI.coedit_waits });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p1.plan_id, agent_id: 'gi-inaktiv', ops: [opInaktiv] });
  await aktiv('gi-aktiv');
  const c1 = await versuch(() => batch.commitBatch({ plan_id: p1.plan_id, agent_id: 'gi-o1' }));
  const liste = c1.waiting_for ?? [];
  pruefe(c1.success === false && c1.status === 'waiting_for_contributors' && liste.some((w) => w.agent_id === 'gi-aktiv') && !liste.some((w) => w.agent_id === 'gi-inaktiv'),
    'E1: commit wartet auf den AKTIVEN, nicht bereiten Wartenden, nicht auf den inaktiven', c1);
  pruefe(liste.find((w) => w.agent_id === 'gi-aktiv')?.letzte_aktivitaet && Array.isArray(liste.find((w) => w.agent_id === 'gi-aktiv')?.dateien),
    'E1: Liste nennt letzte_aktivitaet und dateien', liste);
  pruefe((await zeile(p1.plan_id))?.status === 'open' && await inhalt('src/e1.ts') === zehn('e'), 'E1: blockierter commit ist kein Endzustand, nichts geschrieben', await zeile(p1.plan_id));
  // commit mit wait_seconds wacht auf, sobald der Aktive beitraegt und ready meldet
  let t0 = Date.now();
  const lauf = versuch(() => batch.commitBatch({ plan_id: p1.plan_id, agent_id: 'gi-o1', wait_seconds: 15 }));
  await new Promise((r) => setTimeout(r, 1500));
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p1.plan_id, agent_id: 'gi-aktiv', ops: [opAktiv] });
  await batch.markCoeditReady({ project: PROJECT, plan_id: p1.plan_id, agent_id: 'gi-aktiv' });
  const c1b = await lauf;
  pruefe(c1b.success === true && ms(t0) < 6000, 'E1: wartender commit schreibt, sobald der Aktive ready meldet', { success: c1b.success, status: c1b.status, ms: ms(t0) });
  pruefe(await inhalt('src/e1.ts') === 'O1\ne2\nAKTIV3\ne4\nINAKTIV5\ne6\ne7\ne8\ne9\ne10\n', 'E1: langsamer Aktiver verliert nichts, Ops des Inaktiven mitgeschrieben', await inhalt('src/e1.ts'));
  // Ein Aktiver, der verschwindet, blockiert nicht: nach SYNAPSE_COEDIT_AKTIV_MIN gilt er als inaktiv
  await anlegen('src/e2.ts', zehn('f'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o1b', filePaths: ['src/e2.ts'] });
  const p1c = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o1b', ops: [rl('src/e2.ts', 1, 'f1', 'F1')] });
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-weg', ops: [rl('src/e2.ts', 4, 'f4', 'WEG4')] });
  await aktiv('gi-weg');
  const vorher = process.env.SYNAPSE_COEDIT_AKTIV_MIN;
  process.env.SYNAPSE_COEDIT_AKTIV_MIN = '0.05';
  t0 = Date.now();
  const c1c = await versuch(() => batch.commitBatch({ plan_id: p1c.plan_id, agent_id: 'gi-o1b', wait_seconds: 15 }));
  const dauer = ms(t0);
  if (vorher === undefined) delete process.env.SYNAPSE_COEDIT_AKTIV_MIN; else process.env.SYNAPSE_COEDIT_AKTIV_MIN = vorher;
  pruefe(c1c.success === true && dauer >= 1500 && dauer < 9000, 'E1: wartender commit schreibt, sobald der Aktive inaktiv wird (kein toter Blocker)', { success: c1c.success, status: c1c.status, ms: dauer });

  // ===== V1 Nachfolge-Events statt stillem Quittieren =====
  await anlegen('src/v1.ts', zehn('g'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o2', filePaths: ['src/v1.ts'] });
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o2', ops: [rl('src/v1.ts', 1, 'g1', 'G1')] });
  const opW2 = rl('src/v1.ts', 3, 'g3', 'W2-3');
  const opW2b = rl('src/v1.ts', 6, 'g6', 'W2b-6');
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w2', ops: [opW2] });
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w2b', ops: [opW2b] });
  pruefe((await offen('gi-w2')).some((e) => e.typ === 'PLAN_READY' && String(e.payload.plan_id) === p2.plan_id), 'V1: Wartender hat PLAN_READY', await offen('gi-w2'));
  const c2 = await batch.commitBatch({ plan_id: p2.plan_id, agent_id: 'gi-o2' });
  const ev2 = await offen('gi-w2');
  pruefe(c2.success === true && ev2.some((e) => e.typ === 'PLAN_COMMITTED' && String(e.payload.plan_id) === p2.plan_id && String(e.payload.batch_id) === p2.plan_id),
    'V1: nach commit hat der Wartende PLAN_COMMITTED (plan_id, batch_id) in pending_events', ev2);
  pruefe(!ev2.some((e) => e.typ === 'PLAN_READY' && String(e.payload.plan_id) === p2.plan_id), 'V1: erledigtes PLAN_READY ist zusammen mit dem Nachfolge-Event quittiert', ev2);
  const late2 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p2.plan_id, agent_id: 'gi-w2', ops: [opW2] }));
  const ev2b = await offen('gi-w2b');
  pruefe(late2.follow_up === true && ev2b.some((e) => e.typ === 'PLAN_FOLLOWUP' && String(e.payload.plan_id) === p2.plan_id && String(e.payload.folgeplan_id) === String(late2.plan_id)),
    'V1: weiterer Wartender bekommt PLAN_FOLLOWUP mit folgeplan_id', { late2, ev2b });
  // cancel -> PLAN_CANCELLED
  await anlegen('src/v1c.ts', zehn('h'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o3', filePaths: ['src/v1c.ts'] });
  const p3 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o3', ops: [rl('src/v1c.ts', 1, 'h1', 'H1')] });
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w3', ops: [rl('src/v1c.ts', 3, 'h3', 'W3')] });
  await batch.cancelBatch(p3.plan_id, 'gi-o3', 'verworfen im Test');
  pruefe((await offen('gi-w3')).some((e) => e.typ === 'PLAN_CANCELLED' && String(e.payload.plan_id) === p3.plan_id), 'V1: nach cancel hat der Wartende PLAN_CANCELLED', await offen('gi-w3'));
  // Rueckzug -> PLAN_CHANGED an die Verbleibenden
  await anlegen('src/v1d.ts', zehn('k'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o8', filePaths: ['src/v1d.ts'] });
  const p8 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o8', ops: [rl('src/v1d.ts', 1, 'k1', 'K1')] });
  const opW8 = rl('src/v1d.ts', 3, 'k3', 'W8');
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w8', ops: [opW8] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p8.plan_id, agent_id: 'gi-w8', ops: [opW8] });
  await batch.cancelBatch(p8.plan_id, 'gi-w8', 'Rueckzug im Test');
  pruefe((await offen('gi-o8')).some((e) => e.typ === 'PLAN_CHANGED' && String(e.payload.plan_id) === p8.plan_id), 'V1: nach Rueckzug hat der Owner PLAN_CHANGED', await offen('gi-o8'));

  // ===== V2 Zeilen-Ops im Folgeplan =====
  await anlegen('src/v2.ts', zehn('v'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o4', filePaths: ['src/v2.ts'] });
  const block = Array.from({ length: 50 }, (_, i) => `BLOCK${i + 1}`).join('\n');
  const p4 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o4', ops: [
    { file_path: 'src/v2.ts', action: 'insert_after', after_line: 2, content: block },
    rl('src/v2.ts', 7, 'v7', 'O7'),
  ] });
  const opOhneAnker = rl('src/v2.ts', 8, undefined, 'OHNE-ANKER-8');
  const opMitAnker = rl('src/v2.ts', 9, 'v9', 'MIT-ANKER-9');
  const opGeaendert = rl('src/v2.ts', 7, undefined, 'KAPUTT-7');
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w4', ops: [opOhneAnker] });
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w5', ops: [opMitAnker] });
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w6', ops: [opGeaendert] });
  const c4 = await batch.commitBatch({ plan_id: p4.plan_id, agent_id: 'gi-o4' });
  const nachCommit = await inhalt('src/v2.ts');
  pruefe(c4.success === true && nachCommit.split('\n').length === 61, 'V2: Owner-commit fuegt 50 Zeilen vor den Zielzeilen ein', { c4: c4.success });
  const l4 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'gi-w4', ops: [opOhneAnker] }));
  const l4c = l4.follow_up && l4.plan_id ? await versuch(() => batch.commitBatch({ plan_id: l4.plan_id, agent_id: 'gi-w4' })) : l4;
  const soll4 = nachCommit.replace('\nv8\n', '\nOHNE-ANKER-8\n');
  pruefe(l4c.success === true && await inhalt('src/v2.ts') === soll4, 'V2: spaete Op OHNE Anker trifft die umgerechnete Zeile (v8), nicht Zeile 8 des neuen Stands', { l4, l4c, ist: (await inhalt('src/v2.ts'))?.split('\n').slice(0, 12) });
  const vorW5 = await inhalt('src/v2.ts');
  const l5 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'gi-w5', ops: [opMitAnker] }));
  const l5c = l5.follow_up && l5.plan_id && !l5.coedit_waits ? await versuch(() => batch.commitBatch({ plan_id: l5.plan_id, agent_id: 'gi-w5' })) : l5;
  pruefe(l5c.success === true && await inhalt('src/v2.ts') === vorW5.replace('\nv9\n', '\nMIT-ANKER-9\n'), 'V2: spaete Op MIT Anker wird umgerechnet und gegen den aktuellen Stand geprueft', { l5, l5c });
  const vorW6 = await inhalt('src/v2.ts');
  const l6 = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: p4.plan_id, agent_id: 'gi-w6', ops: [opGeaendert] }));
  pruefe(l6.success === false && /late_line_ops_unmappable/.test(`${l6.error}`) && await inhalt('src/v2.ts') === vorW6 && typeof l6.message === 'string' && /O7/.test(JSON.stringify(l6.aktueller_stand ?? l6.message)),
    'V2: Op auf eine vom commit geaenderte Zeile wird klar abgelehnt (mit aktuellem Stand), nichts geschrieben', l6);

  // ===== V3 cancel ohne agent_id =====
  await anlegen('src/v3.ts', zehn('c'));
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-o5', filePaths: ['src/v3.ts'] });
  const p5 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o5', ops: [rl('src/v3.ts', 1, 'c1', 'C1')] });
  const opW7 = rl('src/v3.ts', 3, 'c3', 'W7');
  await batch.planBatch({ project: PROJECT, agent_id: 'gi-w7', ops: [opW7] });
  await batch.addCoeditContribution({ project: PROJECT, plan_id: p5.plan_id, agent_id: 'gi-w7', ops: [opW7] });
  const x5 = await batch.cancelBatch(p5.plan_id, undefined, 'ohne agent_id');
  pruefe(x5.ok === false && (await zeile(p5.plan_id))?.status === 'open' && (await zeile(p5.plan_id))?.ops === 2, 'V3: cancel ohne agent_id verwirft keine fremden Ops', { x5, z: await zeile(p5.plan_id) });
  pruefe(/agent_id/.test(batch.buildCancelResponse(p5.plan_id, x5).message ?? ''), 'V3: Ablehnung nennt den Ausweg (agent_id)', batch.buildCancelResponse(p5.plan_id, x5));
  const p5b = await batch.planBatch({ project: PROJECT, agent_id: 'gi-solo', ops: [rl('src/v3.ts', 9, 'c9', 'SOLO')] });
  const x5b = await batch.cancelBatch(p5b.plan_id, undefined, 'ohne agent_id, nur eigene Ops');
  pruefe(x5b.ok === true || (await zeile(p5b.plan_id))?.status === 'cancelled' || p5b.coedit_waits, 'V3: Plan ohne fremde Ops laesst sich ohne agent_id verwerfen', { x5b, z: await zeile(p5b.plan_id) });

  // ===== V4 Zusammenfuehren =====
  await anlegen('src/v4.ts', zehn('m'));
  await anlegen('src/v4b.ts', zehn('n'));
  const q1 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o6', ops: [rl('src/v4.ts', 1, 'm1', 'M1')] });
  const q2 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o6', ops: [rl('src/v4.ts', 5, 'm5', 'M5')] });
  pruefe(q2.plan_id === q1.plan_id && (await zeile(q1.plan_id))?.ops === 2, 'V4: zweiter Plan des Owners auf derselben Datei wird in den bestehenden Plan zusammengefuehrt', { q1: q1.plan_id, q2: q2.plan_id, z: await zeile(q1.plan_id) });
  const q3 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-o6', ops: [rl('src/v4.ts', 7, 'm7', 'M7'), rl('src/v4b.ts', 2, 'n2', 'N2')] });
  const offeneOwner = (await pool.query(`SELECT id::text AS id FROM file_batch_plans WHERE project=$1 AND owner_agent_id='gi-o6' AND status='open' AND expected_hashes ? 'src/v4.ts'`, [PROJECT])).rows;
  pruefe(offeneOwner.length === 1 && (await zeile(q1.plan_id))?.ops === 3 && q3.plan_id !== q1.plan_id && (await zeile(q3.plan_id))?.ops === 1,
    'V4: ueberlappende Op wird angehaengt, nicht ueberlappende laeuft normal als eigener Plan', { offeneOwner, q1: await zeile(q1.plan_id), q3: q3.plan_id, z3: await zeile(q3.plan_id) });
  const q4 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: 'gi-o6', ops: [rl('src/v4.ts', 5, 'm5', 'M5-NOCHMAL')] }));
  pruefe(q4.success === false && (await zeile(q1.plan_id))?.ops === 3, 'V4: RAM-Probe scheitert (gleiche Zeile) -> nichts angehaengt, klare Meldung', q4);
  const w9 = await batch.planBatch({ project: PROJECT, agent_id: 'gi-w9', ops: [rl('src/v4.ts', 3, 'm3', 'W9')] });
  pruefe(w9.coedit_waits?.[0]?.target_plan_id === q1.plan_id, 'V4: Wartender hat genau ein Ziel (den zusammengefuehrten Plan)', w9.coedit_waits);
  // Offener fremder Plan hat Vorrang vor einer Reservierung ohne Plan -> ein Ziel
  await anlegen('src/v4c.ts', zehn('p'));
  const qq = await batch.planBatch({ project: PROJECT, agent_id: 'gi-q', ops: [rl('src/v4c.ts', 1, 'p1', 'Q1')] });
  await res.addFileReservations({ project: PROJECT, agentId: 'gi-r', filePaths: ['src/v4c.ts'] });
  const ws = await batch.planBatch({ project: PROJECT, agent_id: 'gi-s', ops: [rl('src/v4c.ts', 5, 'p5', 'S5')] });
  pruefe(ws.coedit_waits?.[0]?.target_plan_id === qq.plan_id, 'V4: Wartender auf reservierte Datei wird in den schon offenen Plan gefuehrt (ein Ziel)', ws.coedit_waits);
  const wr = await batch.planBatch({ project: PROJECT, agent_id: 'gi-r', ops: [rl('src/v4c.ts', 7, 'p7', 'R7')] });
  pruefe(wr.coedit_waits?.[0]?.target_plan_id === qq.plan_id, 'V4: auch der Reservierende selbst wird dorthin gefuehrt', wr.coedit_waits);

  // ===== Schemas + Guide =====
  const mcpFiles = await import(join(hier, '..', '..', 'mcp-server', 'dist', 'tools', 'consolidated', 'files.js')).catch((e) => ({ fehler: e.message }));
  const props = (mcpFiles.filesTool?.definition?.inputSchema ?? {}).properties ?? {};
  pruefe(/commit/.test(props.wait_seconds?.description ?? '') && /waiting_for_contributors/.test(props.wait_seconds?.description ?? ''), 'Schema: MCP-stdio wait_seconds gilt auch fuer commit', { d: props.wait_seconds?.description, fehler: mcpFiles.fehler });
  const { readFileSync } = await import('node:fs');
  const rest = readFileSync(join(hier, '..', '..', 'rest-api', 'dist', 'routes', 'mcp.js'), 'utf8');
  pruefe((rest.match(/waiting_for_contributors/g) ?? []).length >= 2 && /wait_seconds: num\(args, 'wait_seconds'\) \}\);\s*if \(result\.success\)/.test(rest), 'Schema: REST files + files_batch nennen commit-wait_seconds, commit reicht es durch', null);
  const { toolGuides } = await import(join(dist, 'guide', 'content.js')).catch(() => ({}));
  const guideText = JSON.stringify(toolGuides ?? (await import(join(dist, 'guide', 'content.js'))));
  pruefe(/waiting_for_contributors/.test(guideText) && /PLAN_COMMITTED/.test(guideText) && /late_line_ops_unmappable/.test(guideText) && /refused/.test(guideText) && /merged_into/.test(guideText), 'Guide nennt E1, V1, V2, V3, V4', null);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  await new Promise((r) => setTimeout(r, 500));
  await aufraeumen().catch(() => null);
  const r = await pool.query(`SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project=$1)+(SELECT COUNT(*) FROM file_batch_waits WHERE project=$1)+(SELECT COUNT(*) FROM file_reservations WHERE project=$1)+(SELECT COUNT(*) FROM file_versions WHERE project=$1)+(SELECT COUNT(*) FROM code_files WHERE project=$1)+(SELECT COUNT(*) FROM agent_events WHERE project=$1)+(SELECT COUNT(*) FROM tool_calls WHERE project=$1) AS n`, [PROJECT]);
  console.log('REST    ' + r.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(r.rows[0].n) !== 0) fehler++;
}
console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
