/**
 * P23-T3: schlanke Tool-Antworten + fremde Shell-Ergebnisse (memory entscheidung-fremde-plaene-und-jobs-sichtbar).
 * Ausschliesslich synapse_test:5433, eigenes Testprojekt; Schalter nur auf Projektebene dieses Testprojekts.
 *   A Einstellung shell_hinweis_minuten (Standard 60, projekt > Standard, Bereich)
 *   B shell_activity: Jobs ALLER Agenten, laufende + beendete im Fenster (frueher fest 8 min), aeltere fallen weg
 *   C 6a fremd_hinweis nur bei Schalter shell_fremde_ergebnisse EIN und nur fuer fremde Jobs
 *   D 6b fremderLaufFeld: gleicher Befehl + cwd, fremd, beendet, im Fenster; sonst {}
 *   E Rueckfrage kompakt nur bei tool_antworten_schlank EIN
 *   F werkzeug_regeln ohne Ausweis: bei EIN je Sitzung eines registrierten Agenten einmal, AUS jedes Mal
 *   G Quelltext: open_plans nur status open (P6-T49 expired erscheint nicht), code_intel ohne Standardgrenze
 *   node packages/core/tests/tool-antworten-p23-t3.test.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.port, '5433', 'nur Test-Instanz');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test');
// Schalter-/Fristen-Puffer aus: jede Aenderung wirkt sofort.
Object.assign(process.env, { SYNAPSE_W1B_GATE_TTL_MS: '0', SYNAPSE_INTERN_TOOL: '0', SYNAPSE_SKIP_EMBEDDINGS: '1' });

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const load = (...parts) => import(pathToFileURL(join(repo, ...parts)).href);
const { getPool, closePool } = await load('packages/core/dist/db/client.js');
const { AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL } = await load('packages/core/dist/db/agent-ausweis-fristen-schema.js');
const F = await load('packages/core/dist/services/agent-ausweis-fristen.js');
const H = await load('packages/core/dist/services/shell-hints.js');
const S = await load('packages/core/dist/services/tool-antworten-schlank.js');
const W = await load('packages/core/dist/services/werkzeug-regeln.js');
const pool = getPool();
const P = 'test-p23-t3-' + randomUUID();
const starter = 'p23-t3-starter-' + randomUUID();
const dritter = 'p23-t3-dritter-' + randomUUID();
let checks = 0;
const failures = [];
function check(ok, label, detail) { checks++; if (!ok) { failures.push(label); console.error('FAIL ' + label + (detail === undefined ? '' : ' - ' + JSON.stringify(detail))); } }

async function job({ agent = starter, status = 'done', vorMin = 0, command = 'mise run build:core', cwd = null, exit = 0, error = null } = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO shell_jobs(id, project, command, cwd_relative, status, agent_id, exit_code, error, claimed_at, completed_at)
     VALUES($1, $2, $3, $4, $5::shell_job_status, $6, $7, $8, NOW() - ($9::integer * interval '1 minute') - interval '1 second',
            CASE WHEN $5 = 'running' THEN NULL ELSE NOW() - ($9::integer * interval '1 minute') END)`,
    [id, P, command, cwd, status, agent, status === 'running' ? null : exit, error, vorMin]);
  return id;
}
const hints = async (agent) => H.claimShellJobHints(P, agent, 20);
async function schalter(funktion, aktiv) {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion=$2", [P, funktion]);
  if (aktiv !== null) {
    await pool.query("INSERT INTO agent_profil_schalter(ebene, project, funktion, aktiv, grund, gesetzt_von) VALUES('projekt', $1, $2, $3, 'Test P23-T3', 'user')",
      [P, funktion, aktiv]);
  }
}
async function frist(wert) {
  if (wert === null) return F.setzeAusweisFristen({ ebene: 'projekt', project: P, entfernen: ['shell_hinweis_minuten'], grund: 'Test P23-T3' }, { wer: 'test', setter_identity_id: null });
  return F.setzeAusweisFristen({ ebene: 'projekt', project: P, werte: { shell_hinweis_minuten: wert }, grund: 'Test P23-T3' }, { wer: 'test', setter_identity_id: null });
}

try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  // Schema 117 additiv/idempotent: Namens-CHECK kennt shell_hinweis_minuten.
  await pool.query(AGENT_AUSWEIS_FRISTEN_SCHEMA_SQL);

  // ---------------- A Einstellung ----------------
  let st = await F.leseAusweisFristen(P, { frisch: true });
  check(st.fristen.shell_hinweis_minuten.wert === 60 && st.fristen.shell_hinweis_minuten.quelle === 'standard', 'A Standard 60', st.fristen.shell_hinweis_minuten);
  check(st.fristen.shell_hinweis_minuten.einheit === 'minuten' && st.fristen.shell_hinweis_minuten.bereich.max === 1440, 'A Einheit/Bereich');
  st = await frist(20);
  check(st.fristen.shell_hinweis_minuten.wert === 20 && st.fristen.shell_hinweis_minuten.quelle === 'projekt', 'A Projektwert 20', st.fristen.shell_hinweis_minuten);
  let fehler = null;
  try { await frist(0); } catch (e) { fehler = e.code; }
  check(fehler === 'frist_ungueltig', 'A 0 abgewiesen', fehler);
  st = await frist(null);
  check(st.fristen.shell_hinweis_minuten.quelle === 'standard', 'A Entfernen -> Standard');

  // ---------------- B Fenster, alle Agenten ----------------
  await schalter('shell_fremde_ergebnisse', null);
  const j30 = await job({ vorMin: 30 });
  const j90 = await job({ vorMin: 90 });
  const jLauf = await job({ status: 'running', vorMin: 5, command: 'pnpm -r build' });
  let h = await hints(dritter);
  check(h.some(x => x.job_id === j30 && x.kind === 'done'), 'B beendet vor 30 Min sichtbar (Standard 60; frueher 8)', h.map(x => x.job_id));
  check(!h.some(x => x.job_id === j90), 'B beendet vor 90 Min nicht mehr sichtbar');
  check(h.some(x => x.job_id === jLauf && x.kind === 'start'), 'B laufender fremder Job sichtbar');
  check(h.every(x => x.fremd_hinweis === undefined), 'C AUS: kein fremd_hinweis');
  await frist(20);
  const andererLeser = 'p23-t3-leser-' + randomUUID();
  h = await hints(andererLeser);
  check(!h.some(x => x.job_id === j30), 'B Fenster 20 Min: Job vor 30 Min faellt weg', h.map(x => x.job_id));
  check(h.some(x => x.job_id === jLauf), 'B laufende Jobs unabhaengig vom Fenster');
  await frist(null);

  // ---------------- C 6a fremd_hinweis ----------------
  await schalter('shell_fremde_ergebnisse', true);
  const jFremd = await job({ vorMin: 3, exit: 0, command: 'git status' });
  const jEigen = await job({ agent: dritter, vorMin: 2, command: 'git log' });
  const jLauf2 = await job({ status: 'running', vorMin: 1, command: 'pnpm test' });
  const jAbbruch = await job({ vorMin: 1, command: 'sleep 100', status: 'failed', error: 'cancelled' });
  h = await hints(dritter);
  const hf = h.find(x => x.job_id === jFremd);
  check(hf && typeof hf.fremd_hinweis === 'string' && hf.fremd_hinweis.includes('Agent ' + starter) && hf.fremd_hinweis.includes('shell(get, id)') && hf.fremd_hinweis.includes('Exit 0'),
    'C fremder beendeter Job mit Abruf-Hinweis', hf);
  const he = h.find(x => x.job_id === jEigen);
  check(he && he.fremd_hinweis === undefined, 'C eigener Job ohne fremd_hinweis', he);
  const hl = h.find(x => x.job_id === jLauf2);
  check(hl && hl.fremd_hinweis?.startsWith('Laeuft bei Agent ' + starter), 'C laufender fremder Job: nicht doppelt starten', hl);
  const ha = h.find(x => x.job_id === jAbbruch);
  check(!ha || ha.fremd_hinweis === undefined, 'C abgebrochener Job ohne fremd_hinweis');
  check(hf && hf.hinweis !== undefined, 'C Gueltigkeitsauskunft (hinweis) bleibt erhalten');

  // ---------------- D 6b fremderLaufFeld ----------------
  const cmd = 'node scripts/x.mjs ' + randomUUID();
  const jD = await job({ vorMin: 4, command: cmd, cwd: 'packages/core', exit: 1, status: 'failed' });
  let f = await H.fremderLaufFeld({ project: P, command: cmd, cwd_relative: 'packages/core', agent_id: dritter });
  check(f.fremder_lauf?.job_id === jD && f.fremder_lauf.status === 'failed' && f.fremder_lauf.agent === starter && f.fremder_lauf.abruf.includes(jD),
    'D gleicher fremder Lauf genannt', f);
  check(f.fremder_lauf?.vor_min >= 3 && f.fremder_lauf.vor_min <= 5, 'D vor_min', f.fremder_lauf?.vor_min);
  f = await H.fremderLaufFeld({ project: P, command: cmd, cwd_relative: null, agent_id: dritter });
  check(!f.fremder_lauf, 'D anderes cwd -> kein Treffer', f);
  f = await H.fremderLaufFeld({ project: P, command: cmd, cwd_relative: 'packages/core', agent_id: starter });
  check(!f.fremder_lauf, 'D eigener Lauf -> kein Treffer', f);
  f = await H.fremderLaufFeld({ project: P, command: cmd, cwd_relative: 'packages/core', agent_id: dritter, ausser_job_id: jD });
  check(!f.fremder_lauf, 'D ausser_job_id ausgeschlossen', f);
  const cmdAlt = 'node alt.mjs ' + randomUUID();
  await job({ vorMin: 120, command: cmdAlt });
  f = await H.fremderLaufFeld({ project: P, command: cmdAlt, agent_id: dritter });
  check(!f.fremder_lauf, 'D ausserhalb des Fensters -> kein Treffer', f);
  await schalter('shell_fremde_ergebnisse', false);
  f = await H.fremderLaufFeld({ project: P, command: cmd, cwd_relative: 'packages/core', agent_id: dritter });
  check(Object.keys(f).length === 0, 'D Schalter AUS -> {}', f);
  h = await hints('p23-t3-leser2-' + randomUUID());
  check(h.every(x => x.fremd_hinweis === undefined), 'C Schalter AUS (projekt false) -> kein fremd_hinweis');

  // ---------------- E Rueckfrage kompakt ----------------
  const voll = { success: false, ausgefuehrt: false, stufe: 'rueckfrage', risiko: 'R', lage: { gross: 'x'.repeat(2000) }, sicher: 'pwd', danach: 'd',
    trotzdem: 't', bestaetigungsdaten: { a: 1 }, bestaetigung_id: 'abc123', gueltig_bis: 'z', error: 'shell_rueckfrage', id: randomUUID() };
  let r = await S.schlankeShellRueckfrageWennAktiv(P, voll);
  check(r === voll && r.lage, 'E AUS: Rueckfrage unveraendert');
  await schalter('tool_antworten_schlank', true);
  r = await S.schlankeShellRueckfrageWennAktiv(P, voll);
  check(r.lage === undefined && r.bestaetigungsdaten === undefined && r.trotzdem === undefined && r.bestaetigung_id === 'abc123' && r.risiko === 'R'
    && r.gueltig_bis === 'z' && r.bestaetigen.includes('detail:"full"'), 'E EIN: Lage-Baum weg, Kernfelder bleiben', r);
  check(JSON.stringify(r).length < JSON.stringify(voll).length / 3, 'E EIN: deutlich kleiner');
  const hinweisStufe = { stufe: 'hinweis', lage: { a: 1 } };
  check((await S.schlankeShellRueckfrageWennAktiv(P, hinweisStufe)) === hinweisStufe, 'E andere Stufe unveraendert');

  // ---------------- F werkzeug_regeln ohne Ausweis ----------------
  const regel = 'regel-p23-t3-' + randomUUID().slice(0, 8);
  await pool.query("INSERT INTO memories(id, project, name, category, content, tags) VALUES($1, $2, $3, 'rules', 'Testregel P23-T3', ARRAY['bei:shell.exec'])",
    [randomUUID(), P, regel]);
  const reg = 'p23-t3-reg-' + randomUUID();
  const unreg = 'p23-t3-unreg-' + randomUUID();
  await pool.query("INSERT INTO agent_sessions(id, project, status) VALUES($1, $2, 'active')", [reg, P]);
  let rg = await W.holeWerkzeugRegeln(P, 'shell', 'exec', reg);
  check(rg.some(x => x.name === regel), 'F EIN: erste Zustellung', rg);
  rg = await W.holeWerkzeugRegeln(P, 'shell', 'exec', reg);
  check(!rg.some(x => x.name === regel), 'F EIN: im selben Lauf nicht erneut', rg);
  await pool.query("UPDATE memories SET content='Testregel P23-T3 geaendert' WHERE project=$1 AND name=$2", [P, regel]);
  rg = await W.holeWerkzeugRegeln(P, 'shell', 'exec', reg);
  check(rg.some(x => x.name === regel), 'F EIN: geaenderte Regel erneut', rg);
  rg = await W.holeWerkzeugRegeln(P, 'shell', 'exec', unreg);
  const rg2 = await W.holeWerkzeugRegeln(P, 'shell', 'exec', unreg);
  check(rg.some(x => x.name === regel) && rg2.some(x => x.name === regel), 'F unregistrierter Agent: jedes Mal (Pflicht kommt an)');
  const ohneId = await W.holeWerkzeugRegeln(P, 'shell', 'exec');
  check(ohneId.some(x => x.name === regel), 'F ohne agent_id: Regel kommt');
  await schalter('tool_antworten_schlank', false);
  const a1 = await W.holeWerkzeugRegeln(P, 'shell', 'exec', reg);
  const a2 = await W.holeWerkzeugRegeln(P, 'shell', 'exec', reg);
  check(a1.some(x => x.name === regel) && a2.some(x => x.name === regel), 'F AUS: Regel jedes Mal (bisheriges Verhalten)');

  // ---------------- G Quelltext-Anker ----------------
  const planHints = await readFile(join(repo, 'packages/core/src/services/plan-hints.ts'), 'utf8');
  check(/p\.status = 'open'/.test(planHints) && /WHERE project = \$1 AND status = 'open' AND jsonb_array_length\(ops\) = 0/.test(planHints),
    'G open_plans liest nur status open (abgelaufene P6-T49 = expired erscheinen nicht)');
  check(!/toolAntwortenSchlank|eigenFilter/.test(planHints), 'G open_plans ohne nur-eigene-Filter');
  const shellHints = await readFile(join(repo, 'packages/core/src/services/shell-hints.ts'), 'utf8');
  check(!/eigenFilter/.test(shellHints) && !/FERTIG_FENSTER_MIN/.test(shellHints), 'G shell_activity ohne nur-eigene-Filter, Fenster aus Einstellung');
  const ciRest = await readFile(join(repo, 'packages/rest-api/src/routes/mcp.ts'), 'utf8');
  const ciStdio = await readFile(join(repo, 'packages/mcp-server/src/tools/consolidated/code-intel.ts'), 'utf8');
  check(!/kappeListe|CODE_INTEL_STANDARD_LIMIT/.test(ciRest + ciStdio), 'G code_intel ohne Standardgrenze (User-Entscheidung)');

  console.log(`P23-T3: ${checks} Pruefungen, ${failures.length} Fehler`);
  if (failures.length) process.exitCode = 1;
} finally {
  await pool.query('DELETE FROM shell_jobs WHERE project=$1', [P]).catch(() => {});
  await pool.query('DELETE FROM agent_profil_schalter WHERE project=$1', [P]).catch(() => {});
  await pool.query('DELETE FROM agent_ausweis_fristen WHERE project=$1', [P]).catch(() => {});
  await pool.query('DELETE FROM memories WHERE project=$1', [P]).catch(() => {});
  await pool.query('DELETE FROM hinweis_gesehen WHERE project=$1', [P]).catch(() => {});
  await pool.query('DELETE FROM agent_sessions WHERE project=$1', [P]).catch(() => {});
  await closePool().catch(() => {});
}
