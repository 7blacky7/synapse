/**
 * CO-EDIT-BEFUNDE 28.09.2026 — Test gegen die ECHTE Datenbank mit Wegwerf-Projekt.
 *
 * Deckt ab:
 *  1. committed_at ist bei conflict + cancel NICHT gesetzt (nur bei echtem Commit).
 *  2. (entfallen 28.09.2026: Plaene laufen nicht mehr ab — siehe
 *     file-batch-plaene-ohne-ablauf.test.mjs)
 *  3. commit gibt Reservierungen frei; ein release danach meldet already_released
 *     (reason "commit", plan_id), missing_paths nur fuer nie reservierte Pfade.
 *  4. Zeitstempel in plan/plan_status/shared_plan_status sind ISO-8601 UTC mit Z.
 *  5. plan_status erklaert ops_count > previews_count per previews_hint.
 *  6. coedit_add liefert overlap_warnings bei ueberlappenden Ankern.
 *
 * Alle Daten liegen im Projekt PROJECT (unten) und werden im finally-Block
 * geloescht — auch wenn eine Zusage scheitert. Echte Projekte werden nicht beruehrt.
 *
 * AUFRUF (braucht die DB-Umgebung und ein gebautes packages/core/dist):
 *   set -a; . ./.env; set +a; node packages/core/tests/file-batch-coedit-befunde.test.mjs
 * Exit 0 = alle Zusagen erfuellt, Exit 1 = mindestens eine verletzt.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const PROJECT = 'coedit-fix-test';
const A = 'cft-primary';
const B = 'cft-waiter';
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();

let fehler = 0;
function pruefe(bedingung, text, detail) {
  if (bedingung) {
    console.log('OK      ' + text);
  } else {
    fehler++;
    console.error('FEHLER  ' + text + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
  }
}

async function aufraeumen() {
  const zaehler = {};
  for (const tabelle of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) {
    const r = await pool.query(`DELETE FROM ${tabelle} WHERE project = $1`, [PROJECT]);
    zaehler[tabelle] = r.rowCount;
  }
  const ev = await pool.query(`DELETE FROM agent_events WHERE project = $1`, [PROJECT]).catch(() => ({ rowCount: 'n/a' }));
  zaehler.agent_events = ev.rowCount;
  return zaehler;
}

try {
  const vorher = await aufraeumen();
  console.log('VORHER  Reste entfernt: ' + JSON.stringify(vorher));

  // --- Legacy-Plan: Dateien anlegen, commit, dann release (Befund 2, 3, 4) ---
  await res.addFileReservations({ project: PROJECT, agentId: A, filePaths: ['a.md', 'b.md'] });
  const p0 = await batch.planBatch({
    project: PROJECT, agent_id: A,
    ops: [
      { file_path: 'a.md', action: 'create', content: 'alpha\nzeile2\n' },
      { file_path: 'b.md', action: 'create', content: 'beta\n' },
    ],
  });

  const s0 = await batch.getBatchPlan(p0.plan_id);
  pruefe(ISO_Z.test(s0.created_at), 'Befund 4: plan_status created_at ISO mit Z', s0);
  pruefe(s0.committed_at === null, 'Befund 1: offener Plan hat committed_at null', s0.committed_at);

  const c0 = await batch.commitBatch({ plan_id: p0.plan_id, agent_id: A });
  pruefe(c0.success === true, 'Legacy-commit erfolgreich', c0);
  const s0b = await batch.getBatchPlan(p0.plan_id);
  pruefe(s0b.status === 'committed' && ISO_Z.test(s0b.committed_at ?? ''), 'committed Plan: committed_at ISO gesetzt', s0b.committed_at);

  const rel = await res.releaseFileReservations({ project: PROJECT, agentId: A, filePaths: ['a.md', 'b.md', 'nie.md'] });
  pruefe(rel.released.length === 0, 'Befund 3: nach commit gibt release nichts mehr frei', rel.released.length);
  pruefe(
    rel.already_released.length === 2 && rel.already_released.every((e) => e.reason === 'commit' && e.plan_id === p0.plan_id && ISO_Z.test(e.released_at)),
    'Befund 3: already_released mit reason "commit", plan_id und ISO released_at',
    rel.already_released,
  );
  pruefe(JSON.stringify(rel.missing_paths) === JSON.stringify(['nie.md']), 'Befund 3: missing_paths nur fuer nie reservierte Pfade', rel.missing_paths);
  const listed = await res.listFileReservations({ project: PROJECT, agentId: A, includeReleased: true });
  pruefe(listed.every((r) => r.plan_id === p0.plan_id), 'Befund 3: freigegebene Reservierungen tragen plan_id des Commits', listed.map((r) => r.plan_id));

  // --- Co-Edit mit gewolltem Konflikt: coedit_add, plan_status, commit, cancel ---
  await res.addFileReservations({ project: PROJECT, agentId: A, filePaths: ['a.md'] });
  const p1 = await batch.planBatch({
    project: PROJECT, agent_id: A,
    ops: [{ file_path: 'a.md', action: 'replace_lines', line_start: 1, line_end: 1, content: 'ALPHA-A' }],
  });
  const opB = { file_path: 'a.md', action: 'replace_lines', line_start: 1, line_end: 1, content: 'ALPHA-B' };
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: B, ops: [opB] });
  pruefe(Array.isArray(p2.coedit_waits) && p2.coedit_waits.length === 1, 'B bekommt einen Wait auf A', p2.coedit_waits);
  const wait = p2.coedit_waits[0];
  pruefe(ISO_Z.test(wait.expires_at), 'Befund 4: coedit_waits.expires_at ISO mit Z', wait.expires_at);

  const add = await batch.addCoeditContribution({ project: PROJECT, plan_id: p1.plan_id, agent_id: B, ops: [opB] });
  pruefe(add.success === true && add.appended_ops === 1, 'coedit_add haengt die Op an', add);
  pruefe(Array.isArray(add.overlap_warnings) && add.overlap_warnings.length === 1, 'Befund 6: coedit_add meldet overlap_warnings', add.overlap_warnings);

  const status = await batch.buildPlanStatusResponse(await batch.getBatchPlan(p1.plan_id));
  pruefe(status.ops_count === 2 && status.previews_count === 1 && typeof status.previews_hint === 'string', 'Befund 5: plan_status erklaert ops_count > previews_count', { ops: status.ops_count, previews: status.previews_count });

  const shared = await batch.getSharedPlanStatus({ project: PROJECT, wait_token: wait.wait_token, agent_id: B });
  pruefe(ISO_Z.test(shared.expires_at), 'Befund 4: shared_plan_status.expires_at ISO mit Z', shared.expires_at);

  const ready = await batch.markCoeditReady({ project: PROJECT, plan_id: p1.plan_id, agent_id: B });
  pruefe(ready.success === true, 'coedit_ready', ready);

  const c1 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: A });
  pruefe(c1.success === false && c1.error === 'coedit_conflict', 'Konflikt bleibt gewollt: coedit_conflict', c1);
  const cancel = await batch.cancelBatch(p1.plan_id);
  pruefe(cancel.ok === true, 'cancel nach Konflikt', cancel);
  const s1 = await batch.getBatchPlan(p1.plan_id);
  pruefe(s1.status === 'cancelled' && s1.committed_at === null, 'Befund 1: cancelled Plan ohne committed_at (API)', s1);
  const roh = await pool.query('SELECT committed_at FROM file_batch_plans WHERE id = $1', [p1.plan_id]);
  pruefe(roh.rows[0].committed_at === null, 'Befund 1: committed_at in der DB NULL', roh.rows[0]);
  const datei = await pool.query('SELECT content FROM code_files WHERE project = $1 AND file_path = $2', [PROJECT, 'a.md']);
  pruefe(datei.rows[0]?.content === 'alpha\nzeile2\n', 'Konflikt hat nichts geschrieben', datei.rows[0]?.content);
} catch (err) {
  fehler++;
  console.error('FEHLER  Ausnahme: ' + (err instanceof Error ? err.stack : String(err)));
} finally {
  const nachher = await aufraeumen().catch((e) => ({ fehler: String(e) }));
  console.log('AUFGERAEUMT ' + JSON.stringify(nachher));
  const rest = await pool.query(
    `SELECT (SELECT COUNT(*) FROM file_batch_plans WHERE project = $1)
          + (SELECT COUNT(*) FROM file_batch_waits WHERE project = $1)
          + (SELECT COUNT(*) FROM file_reservations WHERE project = $1)
          + (SELECT COUNT(*) FROM file_versions WHERE project = $1)
          + (SELECT COUNT(*) FROM code_files WHERE project = $1) AS n`,
    [PROJECT],
  );
  console.log('REST    ' + rest.rows[0].n + ' Zeilen im Testprojekt');
  if (Number(rest.rows[0].n) !== 0) fehler++;
}

console.log(fehler === 0 ? 'ERGEBNIS alle Zusagen erfuellt' : 'ERGEBNIS ' + fehler + ' Zusage(n) verletzt');
process.exit(fehler === 0 ? 0 : 1);
