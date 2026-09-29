/**
 * PLAENE OHNE ABLAUF (28.09.2026) — Test gegen die ECHTE Datenbank mit Wegwerf-Projekt.
 *
 * Deckt ab:
 *  1. Ein offener Plan laeuft nicht ab: expires_at in der Vergangenheit ist egal —
 *     coedit_add und commit funktionieren, open_plans listet ihn.
 *  2. Kein Plan-Lebenszeichen: ein abgestuerzter Owner mit offenem Plan bekommt
 *     seine Reservierung NICHT verlaengert, und nach der Grace ist sie uebernehmbar.
 *     Kontrollfall: innerhalb der Grace wird NICHT uebernommen.
 *  3. Gescheiterter Batch -> NEUER offener Plan mit eigener ID, gescheiterte Op
 *     markiert. Zweiter Fehlschlag -> weitere eigene ID, der erste bleibt unveraendert.
 *     Ein Plan mit gescheiterter Op ist nicht committbar und schreibt nichts.
 *  4. plan_update (replanBatch) korrigiert per op_index -> Folgeplan mit eigener ID,
 *     Vorgaenger cancelled, commit schreibt das Richtige.
 *  5. commit eines veralteten Plans auf eine inzwischen AUSSERHALB des Plans geaenderte
 *     Datei (externer Schreibzugriff wie Editor/FileWatcher) -> stale, nichts geschrieben
 *     (weder Datei noch file_versions). Ein zweiter Agent, der per plan auf die Datei
 *     geht, wird dagegen in den offenen Plan gefuehrt (siehe 7) — das ist kein Konflikt.
 *  6. open_plans: neuer Plan erscheint, unveraenderter Bestand wird gedrosselt,
 *     nach 15 Minuten oder bei Aenderung erneut gemeldet.
 *  7. Gemeinsamer Plan ueberlebt den Owner: A plant, B traegt bei, A verschwindet
 *     (Reservierung + Waits abgelaufen), C uebernimmt die Reservierung. B's gebundener
 *     Wait wird NICHT verworfen, B kann noch coedit_ready melden, plan_status/open_plans
 *     zeigen A- und B-Ops. C's gescheiterter Batch wird Entwurf mit Verweis auf den
 *     gemeinsamen Plan, nach plan_update landet C als Beitrag DORT (kein Parallelplan).
 *     B committet: A, B, C je genau einmal geschrieben, keine offenen Restplaene.
 *  8. Ohne Blocker: B aendert per plan_update die Owner-Op IM SELBEN Plan (gleiche ID),
 *     darf aber den Co-Edit-Beitrag von C nicht ersetzen. C zieht per cancel nur seine
 *     eigenen Ops zurueck (withdraw), der Plan bleibt; C tritt mit einer Op wieder bei.
 *     Niemand hat ready gemeldet -> commit gelingt trotzdem (kein Ready-Gate). D kommt
 *     zu spaet: coedit_add auf den committeten Plan -> Folgeplan mit neuer ID, commit.
 *     Endstand = genau alle nicht zurueckgezogenen Ops je einmal, keine offenen Restplaene.
 *
 * WARUM DER ALTE STAND ROT WAERE:
 *  - 2: renewDue hatte "OR EXISTS open file_batch_plans" — die Reservierung von C waere
 *    verlaengert worden (renewed=1), und die Takeover-Pruefung hatte has_open_file_plan
 *    als Blocker — D haette NICHT uebernommen.
 *  - 3: planBatch warf bei der ersten gescheiterten Op einen nackten Error, ohne Zeile
 *    in file_batch_plans — kein plan_id-Feld, Planzahl unveraendert.
 *  - 1: addCoeditContribution warf "Plan ... ist abgelaufen" bei expires_at <= NOW().
 *
 * AUFRUF (braucht die DB-Umgebung und ein gebautes packages/core/dist):
 *   node packages/core/tests/file-batch-plaene-ohne-ablauf.test.mjs
 * Mit PLAENE_TEST_DIST=<pfad> laesst sich ein anderes dist pruefen (Gegenprobe alter Stand).
 * Exit 0 = alle Zusagen erfuellt, Exit 1 = mindestens eine verletzt.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'plaene-test';
const O = 'pt-owner';
const A = 'pt-primary';
const B = 'pt-waiter';
const C = 'pt-abgestuerzt';
const D = 'pt-nachfolger';
const X = 'pt-fremd';
const GA = 'pt-g-owner';
const GB = 'pt-g-beitrag';
const GC = 'pt-g-nachfolger';
const HA = 'pt-h-owner';
const HB = 'pt-h-b';
const HC = 'pt-h-c';
const HD = 'pt-h-spaet';

const batch = await import(join(dist, 'services', 'file-batch.js'));
const res = await import(join(dist, 'services', 'file-reservations.js'));
const hints = await import(join(dist, 'services', 'plan-hints.js')).catch(() => null);
const { getPool } = await import(join(dist, 'db', 'client.js'));
const { contentHash } = await import(join(dist, 'services', 'code-write.js'));
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

async function inhalt(pfad) {
  const r = await pool.query('SELECT content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [PROJECT, pfad]);
  return r.rows[0]?.content ?? null;
}

async function planZeile(id) {
  const r = await pool.query('SELECT status::text AS status, ops, previews, expected_hashes FROM file_batch_plans WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

async function planZahl() {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM file_batch_plans WHERE project = $1', [PROJECT]);
  return r.rows[0].n;
}

async function anlegen(agent, pfad, text) {
  const p = await batch.planBatch({ project: PROJECT, agent_id: agent, ops: [{ file_path: pfad, action: 'create', content: text }] });
  const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: agent });
  if (!c.success) throw new Error('Anlegen von ' + pfad + ' fehlgeschlagen: ' + JSON.stringify(c));
}

async function planFehler(args) {
  try {
    const r = await batch.planBatch(args);
    return { geworfen: false, ergebnis: r };
  } catch (err) {
    return { geworfen: true, err };
  }
}

try {
  const vorher = await aufraeumen();
  console.log('VORHER  Reste entfernt: ' + JSON.stringify(vorher));
  const config = res.getReservationTtlConfig();
  pruefe(config.enabled === true, 'Voraussetzung: skalierte Reservierungs-TTL ist aktiv (sonst ist Punkt 2 nicht pruefbar)', config);

  await anlegen(O, 'a.md', 'alpha\nbeta\n');
  await anlegen(O, 'c.md', 'c-eins\nc-zwei\n');
  await anlegen(O, 'x.md', 'eins\nzwei\ndrei\n');
  await anlegen(O, 'y.md', 'y1\ny2\ny3\ny4\n');
  await anlegen(O, 'z.md', 'z1\nz2\nz3\nz4\nz5\nz6\n');

  // ===== 3. Gescheiterter Batch -> neuer offener Plan mit eigener ID =====
  const kaputt = [
    { file_path: 'a.md', action: 'search_replace', search: 'alpha', replace: 'ALPHA' },
    { file_path: 'a.md', action: 'search_replace', search: 'gibt-es-nicht', replace: 'x' },
  ];
  const zahl0 = await planZahl();
  const f1 = await planFehler({ project: PROJECT, agent_id: O, ops: kaputt });
  pruefe(f1.geworfen === true, '3: plan mit gescheiterter Op meldet einen Fehler', f1.ergebnis);
  const f1Id = f1.err?.plan_id;
  pruefe(typeof f1Id === 'string', '3: Fehler traegt eine plan_id (neuer Plan)', f1.err?.message);
  pruefe(await planZahl() === zahl0 + 1, '3: genau ein neuer Plan in file_batch_plans', { vorher: zahl0, nachher: await planZahl() });
  const f1Zeile = f1Id ? await planZeile(f1Id) : null;
  pruefe(f1Zeile?.status === 'open', '3: der neue Plan ist open (nicht committed)', f1Zeile?.status);
  pruefe(f1Zeile?.previews?.[0]?.ok === true && f1Zeile?.previews?.[1]?.ok === false && typeof f1Zeile?.previews?.[1]?.error === 'string',
    '3: erfolgreiche Op mit Preview, gescheiterte Op markiert (Index 1 + Fehlertext)', f1Zeile?.previews);
  pruefe(Array.isArray(f1.err?.failed_ops) && f1.err.failed_ops.length === 1 && f1.err.failed_ops[0].index === 1,
    '3: failed_ops nennt Index 1', f1.err?.failed_ops);
  pruefe(/plan_update/.test(f1.err?.message ?? '') && /cancel/.test(f1.err?.message ?? ''), '3: Meldung sagt, wie man korrigiert/verwirft', f1.err?.message);
  const antwort = batch.planFailureResponse ? batch.planFailureResponse(f1.err) : {};
  pruefe(antwort.success === false && antwort.error === 'plan_failed' && antwort.plan_id === f1Id, '3: Tool-Antwort plan_failed MIT plan_id', antwort);
  pruefe(await inhalt('a.md') === 'alpha\nbeta\n', '3: nichts geschrieben', await inhalt('a.md'));

  const f1Snapshot = JSON.stringify(f1Zeile);
  const f2 = await planFehler({ project: PROJECT, agent_id: O, ops: kaputt });
  const f2Id = f2.err?.plan_id;
  pruefe(typeof f2Id === 'string' && f2Id !== f1Id, '3: zweiter Fehlschlag bekommt eine WEITERE eigene ID', { f1Id, f2Id });
  pruefe(f1Zeile !== null && JSON.stringify(await planZeile(f1Id)) === f1Snapshot, '3: der erste Plan bleibt unveraendert');

  const cf = f1Id ? await batch.commitBatch({ plan_id: f1Id, agent_id: O }) : null;
  pruefe(cf?.success === false && cf?.error === 'plan_has_failed_ops', '3: Plan mit gescheiterter Op ist nicht committbar', cf);
  pruefe(await inhalt('a.md') === 'alpha\nbeta\n', '3: commit-Versuch hat nichts geschrieben', await inhalt('a.md'));

  // ===== 6. open_plans =====
  const t0 = Date.now();
  const h1 = hints ? await hints.claimOpenPlanHints(PROJECT, 'pt-beobachter', t0) : null;
  const ids1 = (h1?.plaene ?? []).map((p) => p.plan_id);
  pruefe(h1 !== null && ids1.includes(f1Id) && ids1.includes(f2Id), '6: open_plans zeigt beide neuen Plaene', h1);
  const h1Eigene = (h1?.plaene ?? []).filter((p) => p.plan_id === f1Id || p.plan_id === f2Id);
  pruefe(h1Eigene.length === 2 && h1Eigene.every((p) => p.fehler_ops === 1 && p.owner === O),
    '6: Eintraege tragen owner und fehler_ops', h1?.plaene);
  pruefe(typeof h1?.gesamt === 'number' && /cancel/.test(h1?.hinweis ?? ''), '6: Gesamtzahl + Hinweis zum Verwerfen', h1);
  const h2 = hints ? await hints.claimOpenPlanHints(PROJECT, 'pt-beobachter', t0 + 1000) : 'x';
  pruefe(h2 === null, '6: unveraenderter Bestand wird sofort danach NICHT wiederholt', h2);
  const h3 = hints ? await hints.claimOpenPlanHints(PROJECT, 'pt-beobachter', t0 + 16 * 60000) : null;
  pruefe(h3 !== null, '6: nach 15 Minuten wird erinnert', h3);

  // ===== 4. plan_update korrigiert =====
  let r = null;
  try {
    r = await batch.replanBatch({
      project: PROJECT, plan_id: f2Id, agent_id: O, op_index: 1,
      ops: [{ file_path: 'a.md', action: 'search_replace', search: 'beta', replace: 'BETA' }],
    });
  } catch (err) {
    pruefe(false, '4: replanBatch wirft nicht', err?.message ?? String(err));
  }
  pruefe(r && r.plan_id !== f2Id && r.plan_id !== f1Id && r.superseded_plan_id === f2Id, '4: Folgeplan mit eigener ID, Vorgaenger genannt', r);
  pruefe((r?.previews ?? []).length === 2 && r.previews.every((p) => p.ok), '4: Folgeplan: alle Ops ok', r?.previews);
  pruefe((await planZeile(f2Id))?.status === 'cancelled', '4: Vorgaenger ist cancelled', (await planZeile(f2Id))?.status);
  pruefe(f1Zeile !== null && JSON.stringify(await planZeile(f1Id)) === f1Snapshot, '4: Fehlschlag-Plan F1 weiter unveraendert');
  const h4 = hints ? await hints.claimOpenPlanHints(PROJECT, 'pt-beobachter', t0 + 16 * 60000 + 1000) : null;
  pruefe(h4 !== null && h4.plaene.some((p) => p.plan_id === r?.plan_id), '6: geaenderter Bestand wird sofort gemeldet (neuer Plan erscheint)', h4);
  const cr = r ? await batch.commitBatch({ plan_id: r.plan_id, agent_id: O }) : null;
  pruefe(cr?.success === true, '4: Folgeplan committed', cr);
  pruefe(await inhalt('a.md') === 'ALPHA\nBETA\n', '4: Datei hat beide Aenderungen', await inhalt('a.md'));
  let replanCommitted = null;
  try { await batch.replanBatch({ project: PROJECT, plan_id: r?.plan_id, agent_id: O, ops: kaputt }); } catch (err) { replanCommitted = err; }
  pruefe(replanCommitted !== null && /nicht offen/.test(replanCommitted.message), '4: plan_update auf committed Plan wird abgelehnt', replanCommitted?.message);
  let replanFremd = null;
  try { await batch.replanBatch({ project: PROJECT, plan_id: f1Id, agent_id: X, ops: kaputt }); } catch (err) { replanFremd = err; }
  pruefe(replanFremd !== null && !/nur der Owner/.test(replanFremd.message) && /veraltet/.test(replanFremd.message),
    '4: plan_update durch einen anderen Agenten ist erlaubt (hier abgelehnt nur, weil F1 veraltet ist — nichts geaendert)', replanFremd?.message);
  pruefe((await batch.cancelBatch(f1Id)).ok === true, '4: Fehlschlag-Plan F1 laesst sich verwerfen');

  // ===== 1. Plan laeuft nicht ab (Co-Edit) =====
  await res.addFileReservations({ project: PROJECT, agentId: A, filePaths: ['x.md'] });
  const p1 = await batch.planBatch({
    project: PROJECT, agent_id: A,
    ops: [{ file_path: 'x.md', action: 'replace_lines', line_start: 1, line_end: 1, content: 'EINS' }],
  });
  const opB = { file_path: 'x.md', action: 'replace_lines', line_start: 3, line_end: 3, content: 'DREI' };
  const p2 = await batch.planBatch({ project: PROJECT, agent_id: B, ops: [opB] });
  pruefe(Array.isArray(p2.coedit_waits) && p2.coedit_waits.length === 1, '1: B wartet auf A', p2.coedit_waits);
  await pool.query(`UPDATE file_batch_plans SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [p1.plan_id]);
  let add = null;
  try { add = await batch.addCoeditContribution({ project: PROJECT, plan_id: p1.plan_id, agent_id: B, ops: [opB] }); } catch (err) { add = { success: false, error: err?.message }; }
  pruefe(add?.success === true, '1: coedit_add auf Plan mit expires_at in der Vergangenheit klappt', add);
  await batch.markCoeditReady({ project: PROJECT, plan_id: p1.plan_id, agent_id: B }).catch(() => null);
  const c1 = await batch.commitBatch({ plan_id: p1.plan_id, agent_id: A });
  pruefe(c1.success === true, '1: commit trotz expires_at in der Vergangenheit', c1);
  pruefe(await inhalt('x.md') === 'EINS\nzwei\nDREI\n', '1: beide Beitraege geschrieben', await inhalt('x.md'));

  // ===== 2. Abgestuerzter Owner mit offenem Plan =====
  await res.addFileReservations({ project: PROJECT, agentId: C, filePaths: ['c.md'] });
  const pc = await batch.planBatch({
    project: PROJECT, agent_id: C,
    ops: [{ file_path: 'c.md', action: 'search_replace', search: 'c-eins', replace: 'C-ALT' }],
  });
  pruefe((await planZeile(pc.plan_id))?.status === 'open', '2: C hat einen offenen Plan auf c.md');
  // Renew-Fenster: Reservierung laeuft gleich ab, C hat seither keine Tool-Aktivitaet.
  const halbesFenster = Math.max(1, Math.floor(config.renewBeforeMinutes / 2));
  await pool.query(
    `UPDATE file_reservations
        SET reserved_at = NOW() - INTERVAL '30 minutes',
            last_extended_at = NOW() - INTERVAL '5 minutes',
            expires_at = NOW() + ($3 * INTERVAL '1 minute')
      WHERE project = $1 AND agent_id = $2 AND released_at IS NULL`,
    [PROJECT, C, halbesFenster],
  );
  const vorRenew = await pool.query('SELECT expires_at FROM file_reservations WHERE project = $1 AND agent_id = $2 AND released_at IS NULL', [PROJECT, C]);
  const renewed = await res.renewFileReservationTtls({ project: PROJECT, filePaths: ['c.md'] });
  const nachRenew = await pool.query('SELECT expires_at FROM file_reservations WHERE project = $1 AND agent_id = $2 AND released_at IS NULL', [PROJECT, C]);
  pruefe(renewed === 0 && String(vorRenew.rows[0]?.expires_at) === String(nachRenew.rows[0]?.expires_at),
    '2: offener Plan verlaengert die Reservierung NICHT (nur Tool-Aktivitaet)', { renewed, vor: vorRenew.rows[0]?.expires_at, nach: nachRenew.rows[0]?.expires_at });

  // Kontrollfall: abgelaufen, aber noch in der Grace -> keine Uebernahme.
  await pool.query(
    `UPDATE file_reservations SET expires_at = NOW() - INTERVAL '10 seconds'
      WHERE project = $1 AND agent_id = $2 AND released_at IS NULL`,
    [PROJECT, C],
  );
  await res.addFileReservations({ project: PROJECT, agentId: D, filePaths: ['c.md'] });
  const inGrace = await pool.query('SELECT released_at, taken_over_by FROM file_reservations WHERE project = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 1', [PROJECT, C]);
  pruefe(inGrace.rows[0]?.released_at === null, '2 (Kontrolle): innerhalb der Grace wird NICHT uebernommen', inGrace.rows[0]);

  await pool.query(
    `UPDATE file_reservations SET expires_at = NOW() - (($3 + 5) * INTERVAL '1 minute')
      WHERE project = $1 AND agent_id = $2 AND released_at IS NULL`,
    [PROJECT, C, config.takeoverGraceMinutes],
  );
  await res.addFileReservations({ project: PROJECT, agentId: D, filePaths: ['c.md'] });
  const nachGrace = await pool.query('SELECT released_at, taken_over_by FROM file_reservations WHERE project = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 1', [PROJECT, C]);
  pruefe(nachGrace.rows[0]?.released_at !== null && nachGrace.rows[0]?.taken_over_by === D,
    '2: nach der Grace uebernimmt D trotz offenem Plan von C', nachGrace.rows[0]);
  pruefe((await planZeile(pc.plan_id))?.status === 'open', '2: der Plan von C bleibt dabei offen (laeuft nicht ab, wird nicht geloescht)');

  // ===== 5. Veralteter Plan -> stale, nichts geschrieben =====
  // Aenderung AUSSERHALB des Plans: wie ein Editor-/FileWatcher-Schreibzugriff direkt
  // in code_files (Inhalt + Hash), ohne Plan.
  const extern = 'c-eins\nC-EXTERN\n';
  await pool.query(
    'UPDATE code_files SET content = $3, content_hash = $4, updated_at = NOW() WHERE project = $1 AND file_path = $2',
    [PROJECT, 'c.md', extern, contentHash(extern)],
  );
  const nachD = await inhalt('c.md');
  pruefe(nachD === extern, '5: c.md wurde ausserhalb des Plans geaendert', nachD);
  const versionenVorher = await pool.query('SELECT COUNT(*)::int AS n FROM file_versions WHERE project = $1', [PROJECT]);
  const cc = await batch.commitBatch({ plan_id: pc.plan_id, agent_id: C });
  pruefe(cc.success === false && cc.error === 'stale', '5: commit des alten Plans von C bricht mit stale ab', cc);
  pruefe(await inhalt('c.md') === extern, '5: c.md unveraendert (externer Stand)', await inhalt('c.md'));
  const versionenNachher = await pool.query('SELECT COUNT(*)::int AS n FROM file_versions WHERE project = $1', [PROJECT]);
  pruefe(versionenNachher.rows[0].n === versionenVorher.rows[0].n, '5: keine file_versions geschrieben', { vorher: versionenVorher.rows[0].n, nachher: versionenNachher.rows[0].n });

  // ===== 7. Gemeinsamer Plan ueberlebt den Owner =====
  await res.addFileReservations({ project: PROJECT, agentId: GA, filePaths: ['y.md'] });
  const gp = await batch.planBatch({
    project: PROJECT, agent_id: GA,
    ops: [{ file_path: 'y.md', action: 'replace_lines', line_start: 1, line_end: 1, content: 'Y1-A' }],
  });
  const opGB = { file_path: 'y.md', action: 'replace_lines', line_start: 2, line_end: 2, content: 'Y2-B' };
  const gb = await batch.planBatch({ project: PROJECT, agent_id: GB, ops: [opGB] });
  pruefe(gb.total_ops === 0 && gb.coedit_waits?.length === 1 && gb.coedit_waits[0].primary_agent === GA, '7: B wird per Wait in den Plan von A gefuehrt', gb);
  const gAddB = await batch.addCoeditContribution({ project: PROJECT, plan_id: gp.plan_id, agent_id: GB, ops: [opGB] });
  pruefe(gAddB.success === true, '7: B traegt bei', gAddB);

  // A verschwindet: Reservierung weit abgelaufen (hinter der Grace), damit auch die Waits.
  await pool.query(
    `UPDATE file_reservations SET expires_at = NOW() - (($3 + 5) * INTERVAL '1 minute')
      WHERE project = $1 AND agent_id = $2 AND released_at IS NULL`,
    [PROJECT, GA, config.takeoverGraceMinutes],
  );
  await pool.query(`UPDATE file_batch_waits SET expires_at = NOW() - INTERVAL '10 minutes' WHERE project = $1 AND primary_agent = $2`, [PROJECT, GA]);

  // C uebernimmt die Reservierung, waehrend B noch 'linked' ist.
  await res.addFileReservations({ project: PROJECT, agentId: GC, filePaths: ['y.md'] });
  const gTake = await pool.query('SELECT taken_over_by FROM file_reservations WHERE project = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 1', [PROJECT, GA]);
  pruefe(gTake.rows[0]?.taken_over_by === GC, '7: C uebernimmt die Reservierung von A', gTake.rows[0]);
  const gWaitB = await pool.query('SELECT status FROM file_batch_waits WHERE project = $1 AND waiting_agent = $2', [PROJECT, GB]);
  pruefe(gWaitB.rows.length === 1 && gWaitB.rows[0].status === 'linked', '7: Takeover verwirft den gebundenen Wait von B NICHT (kein conflict)', gWaitB.rows);
  let gReadyB = null;
  try { gReadyB = await batch.markCoeditReady({ project: PROJECT, plan_id: gp.plan_id, agent_id: GB }); } catch (err) { gReadyB = { success: false, error: err?.message }; }
  pruefe(gReadyB?.success === true, '7: B kann nach Ablauf des Waits noch coedit_ready melden', gReadyB);

  // Sichtbarkeit fuer den Uebernehmenden
  const gStatus = batch.buildPlanStatusResponse(await batch.getBatchPlan(gp.plan_id));
  pruefe(gStatus.status === 'open' && gStatus.ops_count === 2
    && JSON.stringify([...(gStatus.contributors ?? [])].sort()) === JSON.stringify([GA, GB].sort())
    && gStatus.ops_overview?.length === 2,
  '7: plan_status zeigt den offenen Plan mit A- und B-Ops', { status: gStatus.status, ops: gStatus.ops_count, contributors: gStatus.contributors });
  const gHint = hints ? await hints.claimOpenPlanHints(PROJECT, GC) : null;
  const gEintrag = gHint?.plaene?.find((p) => p.plan_id === gp.plan_id);
  pruefe(gEintrag?.ops === 2 && gEintrag?.beitraege_von?.length === 2, '7: open_plans zeigt ihn mit beiden Beitragenden', gHint);
  pruefe(!(gHint?.plaene ?? []).some((p) => p.plan_id === gb.plan_id), '7: der leere Traegerplan von B erscheint nicht in open_plans', gHint?.plaene);

  // C plant zuerst kaputt -> Entwurf mit Verweis auf den gemeinsamen Plan
  const gKaputt = await planFehler({
    project: PROJECT, agent_id: GC,
    ops: [{ file_path: 'y.md', action: 'replace_lines', line_start: 3, line_end: 3, content: 'Y3-C', anchor_text: 'falsch' }],
  });
  const gDraft = gKaputt.err?.plan_id;
  pruefe(typeof gDraft === 'string' && (gKaputt.err?.shared_plans ?? []).some((p) => p.plan_id === gp.plan_id),
    '7: gescheiterter Batch von C wird Entwurf und nennt den gemeinsamen Plan', gKaputt.err?.shared_plans ?? gKaputt.err?.message);
  // Korrektur -> C landet per Wait im gemeinsamen Plan, kein Parallelplan
  const opGC = { file_path: 'y.md', action: 'replace_lines', line_start: 3, line_end: 3, content: 'Y3-C', anchor_text: 'y3' };
  let gFix = null;
  try { gFix = await batch.replanBatch({ project: PROJECT, plan_id: gDraft, agent_id: GC, op_index: 0, ops: [opGC] }); } catch (err) { gFix = { error: err?.message }; }
  pruefe(gFix?.total_ops === 0 && gFix?.coedit_waits?.length === 1 && gFix.coedit_waits[0].primary_agent === GA,
    '7: nach plan_update wird C in den Plan von A gefuehrt (kein Parallelplan)', gFix);
  let gAddC = null;
  try { gAddC = await batch.addCoeditContribution({ project: PROJECT, plan_id: gp.plan_id, agent_id: GC, ops: [opGC] }); } catch (err) { gAddC = { success: false, error: err?.message }; }
  pruefe(gAddC?.success === true && gAddC?.total_plan_ops === 3, '7: C traegt zum gemeinsamen Plan bei (3 Ops)', gAddC);
  await batch.markCoeditReady({ project: PROJECT, plan_id: gp.plan_id, agent_id: GC }).catch(() => null);

  const gCommit = await batch.commitBatch({ plan_id: gp.plan_id, agent_id: GB });
  pruefe(gCommit.success === true, '7: B committet den gemeinsamen Plan des verschwundenen A', gCommit);
  pruefe(await inhalt('y.md') === 'Y1-A\nY2-B\nY3-C\ny4\n', '7: A, B und C je genau einmal geschrieben', await inhalt('y.md'));
  const gOffen = await pool.query(
    `SELECT id::text AS id, jsonb_array_length(ops) AS n FROM file_batch_plans
      WHERE project = $1 AND status = 'open' AND owner_agent_id = ANY($2::text[])`,
    [PROJECT, [GA, GB, GC]],
  );
  pruefe(gOffen.rows.length === 0, '7: keine offenen Rest- oder Traegerplaene von A, B, C', gOffen.rows);

  // ===== 8. Ohne Blocker =====
  const z = (line, text, reason) => ({ file_path: 'z.md', action: 'replace_lines', line_start: line, line_end: line, content: text, anchor_text: `z${line}`, ...(reason ? { reason } : {}) });
  await res.addFileReservations({ project: PROJECT, agentId: HA, filePaths: ['z.md'] });
  const hp = await batch.planBatch({ project: PROJECT, agent_id: HA, reason: 'plan-grund-A', ops: [z(1, 'Z1-A')] });
  const opHB = z(2, 'Z2-B', 'grund-b');
  await batch.planBatch({ project: PROJECT, agent_id: HB, ops: [opHB] });
  const hAddB = await batch.addCoeditContribution({ project: PROJECT, plan_id: hp.plan_id, agent_id: HB, ops: [opHB] });
  const opHC1 = z(3, 'Z3-C', 'grund-c1');
  const opHC2 = z(4, 'Z4-C', 'grund-c2');
  await batch.planBatch({ project: PROJECT, agent_id: HC, ops: [opHC1, opHC2] });
  const hAddC = await batch.addCoeditContribution({ project: PROJECT, plan_id: hp.plan_id, agent_id: HC, ops: [opHC1, opHC2] });
  pruefe(hAddB.success && hAddC.success && hAddC.total_plan_ops === 4, '8: B und C tragen bei (4 Ops)', { b: hAddB.message, c: hAddC.message });

  let hUpd = null;
  try { hUpd = await batch.replanBatch({ project: PROJECT, plan_id: hp.plan_id, agent_id: HB, op_index: 0, ops: [z(1, 'Z1-B-fix', 'grund-b-fix')] }); } catch (err) { hUpd = { error: err?.message }; }
  pruefe(hUpd?.plan_id === hp.plan_id && hUpd?.in_place === true && hUpd?.total_ops === 4, '8: B aendert die Owner-Op per plan_update IM SELBEN Plan (gleiche ID)', hUpd);
  const hStatus = batch.buildPlanStatusResponse(await batch.getBatchPlan(hp.plan_id));
  pruefe(hStatus.ops_overview?.[0]?.agent_id === HB && hStatus.ops_overview?.[2]?.agent_id === HC, '8: ersetzte Op traegt B, unveraenderte behalten ihren Autor', hStatus.ops_overview);
  let hFremd = null;
  try { await batch.replanBatch({ project: PROJECT, plan_id: hp.plan_id, agent_id: HB, op_index: 2, ops: [z(3, 'Z3-B')] }); } catch (err) { hFremd = err; }
  pruefe(hFremd !== null && /nur der Autor/.test(hFremd.message), '8: B darf den Co-Edit-Beitrag von C NICHT ersetzen', hFremd?.message);

  const hW = await batch.cancelBatch(hp.plan_id, HC, 'C zieht Z4 zurueck');
  const hNach = await planZeile(hp.plan_id);
  pruefe(hW.ok === true && hW.mode === 'withdrawn' && hW.withdrawn_ops === 2 && hNach?.status === 'open' && hNach?.ops?.length === 2,
    '8: cancel durch C zieht nur Cs 2 Ops zurueck, der Plan bleibt offen mit 2 Ops', { hW, status: hNach?.status, ops: hNach?.ops?.length });
  const hStatusW = batch.buildPlanStatusResponse(await batch.getBatchPlan(hp.plan_id));
  const hWd = hStatusW.withdrawn?.[0];
  pruefe(
    hWd?.by === HC && /C zieht Z4 zurueck/.test(hWd?.reason ?? '') && typeof hWd?.at === 'string'
      && hWd?.ops?.length === 2 && hWd.ops.map((op) => op.reason).sort().join(',') === 'grund-c1,grund-c2'
      && hWd?.record_plan_id === hW.record_plan_id && hStatusW.reason === 'plan-grund-A',
    '8: zurueckgezogene Ops bleiben mit wer/wann/Grund und ihren reasons erhalten (plan_status.withdrawn), Plan-reason unveraendert',
    { withdrawn: hStatusW.withdrawn, reason: hStatusW.reason },
  );
  const hRecord = hW.record_plan_id ? await planZeile(hW.record_plan_id) : null;
  pruefe(hRecord?.status === 'cancelled' && hRecord?.ops?.length === 2, '8: das Rueckzugsprotokoll ist ein verworfener Eintrag (nie committbar/beitretbar) mit beiden Ops', hRecord?.status);
  // Nach dem Rueckzug ist Cs alter Wait geschlossen (Befund 693bbf48): erneut beitreten = neu planen.
  const hReplan = await batch.planBatch({ project: PROJECT, agent_id: HC, ops: [opHC1] });
  pruefe(hReplan.total_ops === 0 && hReplan.coedit_waits?.[0]?.target_plan_id === hp.plan_id, '8: C plant neu und wird wieder in den gemeinsamen Plan gefuehrt', hReplan.coedit_waits);
  let hReAdd = null;
  try { hReAdd = await batch.addCoeditContribution({ project: PROJECT, plan_id: hp.plan_id, agent_id: HC, ops: [opHC1] }); } catch (err) { hReAdd = { success: false, error: err?.message }; }
  pruefe(hReAdd?.success === true && hReAdd?.appended_ops === 1, '8: C tritt nach dem Rueckzug mit einer Op wieder bei', hReAdd);

  const opHD = z(5, 'Z5-D');
  const hd = await batch.planBatch({ project: PROJECT, agent_id: HD, ops: [opHD] });
  pruefe(hd.total_ops === 0 && (hd.coedit_waits ?? []).length === 1, '8: D wartet (noch nicht beigetreten, nicht ready)', hd);

  const hCommit = await batch.commitBatch({ plan_id: hp.plan_id, agent_id: HA });
  pruefe(hCommit.success === true && typeof hCommit.coedit_note === 'string', '8: commit ohne ein einziges ready gelingt (kein Ready-Gate)', hCommit);
  pruefe(await inhalt('z.md') === 'Z1-B-fix\nZ2-B\nZ3-C\nz4\nz5\nz6\n', '8: geschrieben ist genau, was im Plan stand (C2 zurueckgezogen)', await inhalt('z.md'));
  const hFv = await pool.query(
    `SELECT agent_id, reason FROM file_versions WHERE project = $1 AND batch_id = $2::bigint AND file_path = 'z.md'`,
    [PROJECT, hp.plan_id],
  );
  const hReason = Object.fromEntries(hFv.rows.map((row) => [row.agent_id, row.reason ?? '']));
  pruefe(/grund-b-fix/.test(hReason[HB] ?? '') && /grund-b\b/.test(hReason[HB] ?? '') && /grund-c1/.test(hReason[HC] ?? '') && !/grund-c2/.test(hReason[HC] ?? ''),
    '8: file_versions tragen reason je Autor (B: grund-b + grund-b-fix, C: grund-c1, zurueckgezogenes grund-c2 nicht)', hFv.rows);

  let hLate = null;
  try { hLate = await batch.addCoeditContribution({ project: PROJECT, plan_id: hp.plan_id, agent_id: HD, ops: [opHD] }); } catch (err) { hLate = { success: false, error: err?.message }; }
  pruefe(hLate?.success === true && hLate?.follow_up === true && hLate?.plan_id !== hp.plan_id && hLate?.total_plan_ops === 1,
    '8: spaeter Beitrag von D landet automatisch im Folgeplan (neue ID)', hLate);
  const hLateCommit = hLate?.plan_id ? await batch.commitBatch({ plan_id: hLate.plan_id, agent_id: HD }) : null;
  pruefe(hLateCommit?.success === true, '8: Folgeplan committet', hLateCommit);
  pruefe(await inhalt('z.md') === 'Z1-B-fix\nZ2-B\nZ3-C\nz4\nZ5-D\nz6\n', '8: Endstand = alle nicht zurueckgezogenen Ops genau einmal', await inhalt('z.md'));
  // Ganz verworfener Plan behaelt seine Begruendungen.
  const hv = await batch.planBatch({ project: PROJECT, agent_id: HA, reason: 'grund-verworfener-plan', ops: [z(6, 'Z6-A', 'op-grund-a6')] });
  const hvC = await batch.cancelBatch(hv.plan_id, HA, 'doch nicht');
  const hvZeile = await pool.query('SELECT status::text AS status, ops, reason FROM file_batch_plans WHERE id = $1', [hv.plan_id]);
  const hvRow = hvZeile.rows[0];
  pruefe(hvC.mode === 'cancelled' && hvRow?.status === 'cancelled' && hvRow?.ops?.[0]?.reason === 'op-grund-a6'
    && /grund-verworfener-plan/.test(hvRow?.reason ?? '') && /\[verworfen von pt-h-owner am .*: doch nicht\]/.test(hvRow?.reason ?? ''),
    '8: ganz verworfener Plan behaelt ops, Op-reason und Plan-reason, dazu Vermerk wer/wann/warum', hvRow);
  const hOffen = await pool.query(
    `SELECT id::text AS id, jsonb_array_length(ops) AS n FROM file_batch_plans
      WHERE project = $1 AND status = 'open' AND owner_agent_id = ANY($2::text[])`,
    [PROJECT, [HA, HB, HC, HD]],
  );
  pruefe(hOffen.rows.length === 0, '8: keine offenen Rest- oder Traegerplaene (auch keine leeren)', hOffen.rows);
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
