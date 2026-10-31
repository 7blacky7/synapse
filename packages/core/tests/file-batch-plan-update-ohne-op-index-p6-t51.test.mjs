/**
 * P6-T51: files(plan_update) ohne op_index entfernt eigene Ops nur noch ausdruecklich.
 * Anlass: User 31.10.2026 ("das hat einige Plaene zerstoert im letzten Run von Moo"), Befund thought 8952e3af: plan_update ohne
 * op_index ersetzte still alle eigenen Ops (Koordinator-Plan 30034, create-Op weg), bei moo Plan 29962 haengte es zufaellig an.
 * Entscheidung User 31.10.2026 ("b schaetze ich"): ohne op_index wird ANGEHAENGT, ersetzen nur mit ersetzen_alle:true.
 * Geprueft (core/src/services/file-batch.ts):
 *  A updatePlanInPlace ohne op_index (Agent will ergaenzen, wie moo 29670) -> angehaengt, nichts entfernt, Bilanz
 *  B anhaengen:true (nur zur Klarheit) -> wie A
 *  C ersetzen_alle:true -> bisheriges Verhalten (alle eigenen ersetzt), entfernt nennt sie
 *  D op_index -> genau diese Op ersetzt, entfernt nennt sie
 *  E replanBatchKern (eigener Entwurf mit gescheiterter Op): ohne op_index -> angehaengt, gescheiterte Op bleibt (neuer Entwurf,
 *    keine Op verloren); op_index repariert
 *  F commit nach C schreibt genau die ersetzende Op
 * Nur synapse_test:5433 (regel-tests-nur-testdatenbank), Wegwerf-Projekt, braucht gebautes packages/core/dist.
 *   DATABASE_URL=postgres://...:5433/synapse_test node packages/core/tests/file-batch-plan-update-ohne-op-index-p6-t51.test.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const url = new URL(process.env.DATABASE_URL || process.env.SYNAPSE_DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433', 'P6-T51: nur gegen die Testdatenbank (Port 5433)');
assert.equal(url.pathname, '/synapse_test', 'P6-T51: nur gegen synapse_test');

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'dist');
const batch = await import(join(dist, 'services', 'file-batch.js'));
const { getPool } = await import(join(dist, 'db', 'client.js'));
const pool = getPool();
const PROJECT = 'p6-t51-test-' + process.pid;
const A = 'p6t51-agent';

let fehler = 0;
/** Debugzeile mit Herkunft (regel-tests-mit-herkunft-kommentieren). */
function pruefe(ok, label, ist) {
  if (ok) { console.log('OK      ' + label); return; }
  fehler++;
  console.error('FEHLER  ' + label + (ist === undefined ? '' : ' | ist: ' + JSON.stringify(ist).slice(0, 400)));
}
async function versuch(fn) { try { return { ok: true, wert: await fn() }; } catch (err) { return { ok: false, err }; } }
async function aufraeumen() {
  for (const t of ['file_batch_waits', 'file_batch_plans', 'file_reservations', 'file_versions', 'code_files']) {
    await pool.query(`DELETE FROM ${t} WHERE project = $1`, [PROJECT]).catch(() => {});
  }
}
async function inhalt(pfad) {
  const r = await pool.query('SELECT content FROM code_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL', [PROJECT, pfad]);
  return r.rows[0]?.content ?? null;
}
async function opsZahl(planId) {
  const r = await pool.query('SELECT jsonb_array_length(ops) AS n, status::text AS status FROM file_batch_plans WHERE id = $1::bigint', [planId]);
  return r.rows[0] ?? null;
}
const sr = (f, s, r) => ({ file_path: f, action: 'search_replace', search: s, replace: r });

try {
  await aufraeumen();
  const anlegen = await batch.planBatch({ project: PROJECT, agent_id: A, ops: [
    { file_path: 'a.txt', action: 'create', content: 'EINS\nZWEI\nDREI\n' },
    { file_path: 'b.txt', action: 'create', content: 'BETA\n' },
  ] });
  assert.ok((await batch.commitBatch({ plan_id: anlegen.plan_id, agent_id: A })).success, 'P6-T51 Vorbereitung: Dateien angelegt');

  // ===== A: ohne op_index (Agent will ergaenzen) -> angehaengt, nichts entfernt =====
  const p = await batch.planBatch({ project: PROJECT, agent_id: A, ops: [sr('a.txt', 'EINS', 'eins'), sr('a.txt', 'ZWEI', 'zwei')] });
  const a = await batch.replanBatch({ project: PROJECT, plan_id: p.plan_id, agent_id: A, ops: [sr('b.txt', 'BETA', 'beta')] });
  pruefe(a.plan_id === p.plan_id && a.in_place === true, 'P6-T51 A updatePlanInPlace ohne op_index: im selben Plan', { plan_id: a.plan_id, in_place: a.in_place });
  pruefe(a.ops_vorher === 2 && a.ops_nachher === 3 && Array.isArray(a.entfernt) && a.entfernt.length === 0,
    'P6-T51 A ohne op_index haengt an: 2 -> 3, nichts entfernt (moo 29670 waere erhalten geblieben)', { ops_vorher: a.ops_vorher, ops_nachher: a.ops_nachher, entfernt: a.entfernt });
  pruefe((await opsZahl(p.plan_id))?.n === 3, 'P6-T51 A Plan hat 3 Ops', await opsZahl(p.plan_id));

  // ===== B: anhaengen:true (nur zur Klarheit) -> wie A =====
  const b = await batch.replanBatch({ project: PROJECT, plan_id: p.plan_id, agent_id: A, anhaengen: true, ops: [sr('a.txt', 'DREI', 'DREI!')] });
  pruefe(b.ops_vorher === 3 && b.ops_nachher === 4 && b.entfernt?.length === 0, 'P6-T51 B anhaengen:true 3 -> 4', { ops_vorher: b.ops_vorher, ops_nachher: b.ops_nachher, entfernt: b.entfernt });

  // ===== D: op_index -> genau diese Op ersetzt =====
  const d = await batch.replanBatch({ project: PROJECT, plan_id: p.plan_id, agent_id: A, op_index: 1, ops: [sr('a.txt', 'ZWEI', 'Zwei')] });
  pruefe(d.ops_vorher === 4 && d.ops_nachher === 4 && d.entfernt?.length === 1 && d.entfernt[0].index === 1 && d.entfernt[0].file_path === 'a.txt',
    'P6-T51 D op_index: Bilanz nennt die ersetzte Op', { ops_vorher: d.ops_vorher, ops_nachher: d.ops_nachher, entfernt: d.entfernt });

  // ===== C: ersetzen_alle -> alle eigenen ersetzt =====
  const c = await batch.replanBatch({ project: PROJECT, plan_id: p.plan_id, agent_id: A, ersetzen_alle: true, ops: [sr('a.txt', 'DREI', 'drei')] });
  pruefe(c.ops_vorher === 4 && c.ops_nachher === 1 && c.entfernt?.length === 4, 'P6-T51 C ersetzen_alle: 4 eigene ersetzt', { ops_vorher: c.ops_vorher, ops_nachher: c.ops_nachher, entfernt: c.entfernt });

  // ===== F: commit schreibt genau die ersetzende Op =====
  const f = await batch.commitBatch({ plan_id: p.plan_id, agent_id: A });
  pruefe(f.success === true, 'P6-T51 F commit nach ersetzen_alle', f);
  pruefe(await inhalt('a.txt') === 'EINS\nZWEI\ndrei\n' && await inhalt('b.txt') === 'BETA\n', 'P6-T51 F nur die ersetzende Op geschrieben',
    { a: await inhalt('a.txt'), b: await inhalt('b.txt') });

  // ===== E: eigener Entwurf mit gescheiterter Op (replanBatchKern) =====
  const e0 = await versuch(() => batch.planBatch({ project: PROJECT, agent_id: A, ops: [sr('b.txt', 'BETA', 'beta'), sr('b.txt', 'NICHT-DA', 'x')] }));
  const entwurf = e0.ok ? e0.wert.plan_id : e0.err?.plan_id;
  pruefe(!e0.ok && typeof entwurf === 'string', 'P6-T51 E Vorbereitung: Entwurf mit gescheiterter Op', e0.err?.message);
  // Ohne op_index: angehaengt; die gescheiterte Op bleibt, also wieder ein Entwurf (neue ID) mit allen 3 Ops, keine verloren.
  const e1 = await versuch(() => batch.replanBatch({ project: PROJECT, plan_id: entwurf, agent_id: A, ops: [sr('b.txt', 'BETA', 'Beta')] }));
  const entwurf2 = e1.ok ? e1.wert.plan_id : e1.err?.plan_id;
  pruefe(typeof entwurf2 === 'string' && entwurf2 !== entwurf && (await opsZahl(entwurf2))?.n === 3,
    'P6-T51 E replanBatchKern ohne op_index: angehaengt, 3 Ops im Folgeentwurf', { ok: e1.ok, entwurf2, ops: entwurf2 ? await opsZahl(entwurf2) : null, msg: e1.err?.message });
  // Reparatur des ganzen Entwurfs ausdruecklich per ersetzen_alle (D2 t216: per op_index waere Op 0 'BETA'->'beta' davor im Weg).
  const e2 = await batch.replanBatch({ project: PROJECT, plan_id: entwurf2, agent_id: A, ersetzen_alle: true, ops: [sr('b.txt', 'BETA', 'BETA2')] });
  pruefe(e2.plan_id !== entwurf2 && e2.superseded_plan_id === entwurf2 && e2.ops_vorher === 3 && e2.ops_nachher === 1 && e2.entfernt?.length === 3,
    'P6-T51 E replanBatchKern ersetzen_alle repariert den Entwurf (Folgeplan, Bilanz 3 -> 1)', { plan_id: e2.plan_id, superseded: e2.superseded_plan_id, ops_vorher: e2.ops_vorher, ops_nachher: e2.ops_nachher, entfernt: e2.entfernt });
  pruefe((await batch.commitBatch({ plan_id: e2.plan_id, agent_id: A })).success === true && await inhalt('b.txt') === 'BETA2\n',
    'P6-T51 E reparierter Entwurf committbar, b.txt = BETA2', await inhalt('b.txt'));
} finally {
  await aufraeumen();
  await pool.end().catch(() => {});
}
console.log(fehler === 0 ? 'P6-T51: alle Pruefungen bestanden' : `P6-T51: ${fehler} Pruefung(en) fehlgeschlagen`);
process.exit(fehler === 0 ? 0 : 1);
