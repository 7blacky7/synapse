/**
 * V2 OHNE GRENZE (User-Vorgabe 29.09.2026): Agenten duerfen so viel aendern, wie sie wollen.
 * Spaete Zeilen-Ops (Stand VOR einem commit) werden ueber die beim commit gespeicherte exakte
 * Zeilentabelle umgerechnet — ohne Obergrenze, auch ueber mehrere commits hinweg.
 *  T1 5.000 eingefuegte Zeilen vor der Zielzeile: spaeter replace_lines trifft exakt die Zeile.
 *  T2 50.000 eingefuegte Zeilen: ebenso.
 *  T3 Zielzeile liegt in einem vom commit geaenderten Bereich -> late_line_ops_unmappable, nichts geschrieben.
 *  T4 Kette aus 3 commits (je 3.000 Zeilen eingefuegt) zwischen Stand des Beitrags und jetzt.
 *  T5 Fallback ohne Tabelle (alter commit): Diff ohne Obergrenze, trifft die richtige Zeile.
 *  M  Messung: Umrechnung bei 100k-Zeilen-Datei (Tabelle und Fallback).
 * AUFRUF: node packages/core/tests/file-batch-v2-ohne-grenze.test.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.PLAENE_TEST_DIST || join(hier, '..', 'dist');
const PROJECT = 'v2grenze-test';
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
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files', 'agent_events', 'tool_calls']) await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]);
}
const inhalt = async (p) => (await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL', [PROJECT, p])).rows[0]?.content ?? null;
async function anlegen(p, t) { const x = await batch.planBatch({ project: PROJECT, agent_id: 'v2-setup', ops: [{ file_path: p, action: 'create', content: t }] }); const c = await batch.commitBatch({ plan_id: x.plan_id, agent_id: 'v2-setup' }); if (!c.success) throw new Error(JSON.stringify(c)); }
const datei = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`).join('\n') + '\n';
const block = (p, n) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`).join('\n');
const rl = (f, line, anker, text) => ({ file_path: f, action: 'replace_lines', line_start: line, line_end: line, content: text, ...(anker ? { anchor_text: anker } : {}) });

/** Owner plant ownerOps und committet; Wartender plant spaet-Op VORHER (Stand vor dem commit). */
async function szenario(f, owner, ownerOps, wartender, spaetOp) {
  await res.addFileReservations({ project: PROJECT, agentId: owner, filePaths: [f] });
  const p = await batch.planBatch({ project: PROJECT, agent_id: owner, ops: ownerOps });
  const w = await batch.planBatch({ project: PROJECT, agent_id: wartender, ops: [spaetOp] });
  if (w.coedit_waits?.[0]?.target_plan_id !== p.plan_id) throw new Error(`kein Ziel: ${JSON.stringify(w.coedit_waits)}`);
  const c = await batch.commitBatch({ plan_id: p.plan_id, agent_id: owner });
  if (!c.success) throw new Error(`commit: ${JSON.stringify(c).slice(0, 300)}`);
  return p.plan_id;
}
async function spaet(planId, agent, op) {
  const t0 = Date.now();
  const r = await versuch(() => batch.addCoeditContribution({ project: PROJECT, plan_id: planId, agent_id: agent, ops: [op] }));
  const ms = Date.now() - t0;
  const c = r.follow_up && r.plan_id && !r.coedit_waits ? await versuch(() => batch.commitBatch({ plan_id: r.plan_id, agent_id: agent })) : r;
  return { r, c, ms };
}

try {
  await aufraeumen();

  // ===== T1 / T2 =====
  for (const [name, n] of [['T1', 5000], ['T2', 50000]]) {
    const f = `src/${name}.ts`;
    await anlegen(f, datei('z', 20));
    // Anfang UND Ende mitgeaendert: kein gemeinsamer Praefix/Suffix, die Einfuegung liegt voll im Diff.
    const planId = await szenario(f, `v2-o-${name}`, [
      rl(f, 1, 'z1', 'ANFANG'),
      { file_path: f, action: 'insert_after', after_line: 2, content: block('NEU', n) },
      rl(f, 20, 'z20', 'ENDE'),
    ], `v2-w-${name}`, rl(f, 15, 'z15', `SPAET-${name}`));
    const vorher = await inhalt(f);
    const { r, c } = await spaet(planId, `v2-w-${name}`, rl(f, 15, 'z15', `SPAET-${name}`));
    pruefe(c.success === true && await inhalt(f) === vorher.replace('\nz15\n', `\nSPAET-${name}\n`),
      `${name}: ${n} eingefuegte Zeilen vor der Zielzeile — spaeter replace_lines trifft exakt die richtige Zeile`, { r: { ...r, previews: undefined }, c: c.success ? 'ok' : c });
  }

  // ===== T3 Zielzeile im geaenderten Bereich =====
  {
    const f = 'src/T3.ts';
    await anlegen(f, datei('y', 20));
    const planId = await szenario(f, 'v2-o-T3', [
      { file_path: f, action: 'insert_after', after_line: 2, content: block('NEU', 6000) },
      { file_path: f, action: 'replace_lines', line_start: 10, line_end: 12, content: 'ERSETZT', anchor_text: 'y10' },
    ], 'v2-w-T3', rl(f, 11, undefined, 'SPAET-T3'));
    const vorher = await inhalt(f);
    const { r } = await spaet(planId, 'v2-w-T3', rl(f, 11, undefined, 'SPAET-T3'));
    pruefe(r.success === false && r.error === 'late_line_ops_unmappable' && await inhalt(f) === vorher && /ERSETZT/.test(JSON.stringify(r.aktueller_stand ?? '')),
      'T3: Zielzeile in einem geaenderten Bereich -> abgelehnt mit aktuellem Stand, nichts geschrieben', { error: r.error, stand: r.aktueller_stand });
  }

  // ===== T4 Kette aus 3 commits =====
  {
    const f = 'src/T4.ts';
    await anlegen(f, datei('x', 30));
    const planId = await szenario(f, 'v2-o-T4', [{ file_path: f, action: 'insert_after', after_line: 1, content: block('A', 3000) }], 'v2-w-T4', rl(f, 25, 'x25', 'SPAET-T4'));
    // zwei weitere commits anderer Agenten auf den neuen Stand
    const q = await batch.planBatch({ project: PROJECT, agent_id: 'v2-q', ops: [{ file_path: f, action: 'insert_after', after_line: 3005, content: block('B', 3000) }] });
    const qc = await batch.commitBatch({ plan_id: q.plan_id, agent_id: 'v2-q' });
    const rr = await batch.planBatch({ project: PROJECT, agent_id: 'v2-r', ops: [{ file_path: f, action: 'search_replace', search: 'x2\n', replace: 'x2\n' + block('C', 3000) + '\n' }] });
    const rc = await batch.commitBatch({ plan_id: rr.plan_id, agent_id: 'v2-r' });
    const vorher = await inhalt(f);
    const { r, c } = await spaet(planId, 'v2-w-T4', rl(f, 25, 'x25', 'SPAET-T4'));
    pruefe(qc.success && rc.success && c.success === true && await inhalt(f) === vorher.replace('\nx25\n', '\nSPAET-T4\n'),
      'T4: Kette aus 3 commits (9.000 Zeilen, auch search_replace) — spaete Op trifft die richtige Zeile', { qc: qc.success, rc: rc.success, r: r.error ?? r.message, c: c.success ? 'ok' : c });
  }

  // ===== T5 Fallback ohne Tabelle + M Messung (100k Zeilen) =====
  for (const [name, ohneTabelle] of [['M-Tabelle', false], ['T5-Fallback', true]]) {
    const f = `src/${name}.ts`;
    // 95k + 5k = 100k Zeilen (groesser scheitert am tsvector-Limit von code_files, siehe Bericht)
    await anlegen(f, datei('m', 95000));
    const planId = await szenario(f, `v2-o-${name}`, [
      rl(f, 1, 'm1', 'ANFANG'),
      { file_path: f, action: 'insert_after', after_line: 2, content: block('NEU', 5000) },
      rl(f, 95000, 'm95000', 'ENDE'),
      { file_path: f, action: 'replace_lines', line_start: 60000, line_end: 60000, content: 'GEAENDERT', anchor_text: 'm60000' },
    ], `v2-w-${name}`, rl(f, 90000, 'm90000', `SPAET-${name}`));
    if (ohneTabelle) {
      // alter commit vor dem Umbau: keine Zeilentabelle in den previews
      await pool.query(`UPDATE file_batch_plans SET previews = (SELECT COALESCE(jsonb_agg(e - 'zeilen'), '[]'::jsonb) FROM jsonb_array_elements(previews) e) WHERE id = $1::bigint`, [planId]);
    }
    const vorher = await inhalt(f);
    const { r, c, ms } = await spaet(planId, `v2-w-${name}`, rl(f, 90000, 'm90000', `SPAET-${name}`));
    console.log(`MESSUNG ${name}: spaeter Beitrag (Umrechnung + Folgeplan) bei 100k-Zeilen-Datei: ${ms} ms gesamt, Umrechnung ${JSON.stringify(r.umrechnung ?? null)}`);
    pruefe(c.success === true && await inhalt(f) === vorher.replace('\nm90000\n', `\nSPAET-${name}\n`),
      `${name}: 100k-Zeilen-Datei, spaete Op trifft die richtige Zeile${ohneTabelle ? ' (Fallback-Diff ohne Obergrenze)' : ''}`, { r: r.error ?? r.message, c: c.success ? 'ok' : c });
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
