#!/usr/bin/env node
// test-task-zurueckstellen.mjs — Wiedervorlage fuer einzelne Tasks: plan(zurueckstellen, task_id, tage|bis) (P3-T4).
//
// Geprueft: Setzen ueber tage/bis (Kurz-ID, UUID, Alias), Aufheben mit tage:0, Validierung,
// get-Filter (Standard blendet aus, alle:true / ausdrueckliche task_id zeigt), Zeitgrenze,
// "wieder vorgelegt seit", passende_tasks blendet aus, uebernehmen lehnt zurueckgestellte ab,
// andere Tasks/Felder unveraendert, optimistisches Schreiben ohne Sperre, alte Antwortformen unveraendert.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt (plans-Tabelle im Speicher), Qdrant-Index gestubbt.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-task-zurueckstellen.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
process.env.QDRANT_URL = 'http://127.0.0.1:9';

const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = requireFromCore('pg');

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`OK     ${name}`);
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const TAG = 24 * 3600 * 1000;
const JETZT = new Date('2026-09-29T20:00:00.000Z');
const inTagen = (n) => new Date(JETZT.getTime() + n * TAG).toISOString();

const emp = { modell: 'sonnet', effort: 'medium', kontext: '200k', spawn_alias: 'sonnet', confidence: 0.8, quelle: 'cloud', kandidaten: ['sonnet'], stand: '2026-09-29T19:00:00.000Z', experimentell: true };
const task = (id, kurz, title, extra = {}) => ({
  id, kurz_id: kurz, title, description: `${title}!`, status: 'todo', priority: 'medium',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', empfehlung: emp, eigenesFeld: 7, ...extra,
});
let PLAENE;
let sqlLog;
function reset() {
  PLAENE = [
    { id: 'plan-1', project: 'p', name: 'Alt', description: '', goals: [], architecture: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', kurz_id: 'P1', aktiv: false, naechste_task_nr: 3,
      tasks: [task('a1', 'P1-T1', 'Alt eins'), task('a2', 'P1-T2', 'Alt zwei', { alias_kurz_ids: ['P9-T4'] })] },
    { id: 'plan-2', project: 'p', name: 'Aktiv', description: 'Ziel', goals: [], architecture: null,
      created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', kurz_id: 'P2', aktiv: true, naechste_task_nr: 7,
      tasks: [
        task('b1', 'P2-T1', 'Normal'),
        task('b2', 'P2-T2', 'Schlaeft noch', { zurueckgestellt_bis: inTagen(5) }),
        task('b3', 'P2-T3', 'Wieder da', { zurueckgestellt_bis: inTagen(-3) }),
        task('b4', 'P2-T4', 'Genau jetzt', { zurueckgestellt_bis: JETZT.toISOString() }),
        task('b5', 'P2-T5', 'Eine ms davor', { zurueckgestellt_bis: new Date(JETZT.getTime() + 1).toISOString() }),
        task('b6', 'P2-T6', 'Erledigt', { status: 'done' }),
      ] },
    // Projekt ohne Wiedervorlage-Felder (Zustand vor dem Feature)
    { id: 'alt-1', project: 'alt', name: 'Nur alt', description: '', goals: [], architecture: null,
      created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-01T00:00:00.000Z', kurz_id: 'P1', aktiv: true, naechste_task_nr: 3,
      tasks: [task('x1', 'P1-T1', 'Alt A'), task('x2', 'P1-T2', 'Alt B')] },
  ];
  sqlLog = [];
}
reset();

const ALLE = ['low', 'medium', 'high', 'xhigh', 'max'];
const WRAPPER = { agent_name: 'sonnet-medium', project: 'p', model: 'sonnet', model_full_id: null, provider: 'anthropic', status: 'idle', busy: false,
  current_task: null, context_ceiling: null, tokens_input: 0, tokens_output: 0, tokens_percent: 0, channels: [], connected_mcp: true,
  last_activity: '2026-09-29T19:00:00.000Z', heartbeat_enabled: true, heartbeat_interval_ms: null, effort: 'medium' };
const REG = { alias: 'sonnet', full_id: 'claude-sonnet-5-5', provider: 'anthropic', context_window: 1000000, output_limit: 128000, env_required: [],
  runtime_binary: 'claude', runtime_path: null, corridor_min: 73, corridor_max: 88, pricing_input_usd_per_mtok: null,
  pricing_output_usd_per_mtok: null, pricing_cache_usd_per_mtok: null, cutoff_date: null, enabled: true, default_effort: 'medium', effort_stufen: ALLE };

let eingriff = null;
pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  sqlLog.push(text);
  if (/^SELECT .* FROM plans WHERE project = \$1/i.test(text)) {
    const rows = PLAENE.filter((p) => p.project === params[0]);
    return { rows: structuredClone(rows), rowCount: rows.length };
  }
  if (/^UPDATE plans SET name = \$1/i.test(text)) {
    if (eingriff) { const e = eingriff; eingriff = null; e(); }
    const [name, description, goals, architecture, tasks, naechste, updated_at, id, alt] = params;
    const p = PLAENE.find((x) => x.id === id);
    if (!p || JSON.stringify(p.tasks) !== JSON.stringify(JSON.parse(alt))) return { rows: [], rowCount: 0 };
    Object.assign(p, { name, description, goals, architecture, tasks: JSON.parse(tasks), naechste_task_nr: naechste, updated_at });
    return { rows: [], rowCount: 1 };
  }
  if (/FROM wrapper_status/i.test(text)) {
    const rows = params[0] === WRAPPER.agent_name ? [WRAPPER] : [];
    return { rows: structuredClone(rows), rowCount: rows.length };
  }
  if (/FROM model_registry/i.test(text)) return { rows: [REG], rowCount: 1 };
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const core = await import('../packages/core/dist/index.js');
let indexAufrufe = [];
core.planIndex.sync = async (p) => { indexAufrufe.push(p); };

const t = (planId, id) => PLAENE.find((p) => p.id === planId).tasks.find((x) => x.id === id);
const kurz = (l) => l.map((x) => x.kurz_id);

// ---------------------------------------------------------------------------
// 1. Setzen / Aufheben
// ---------------------------------------------------------------------------
await pruefe('tage:7 per Kurz-ID: Task bekommt zurueckgestellt_bis = jetzt + 7 Tage; andere Tasks und Felder unveraendert', async () => {
  reset();
  const vorher = structuredClone(PLAENE[1]);
  const r = await core.zurueckstelleTask('p', undefined, 'P2-T1', { tage: 7 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(new Date(r.zurueckgestellt_bis).getTime(), JETZT.getTime() + 7 * TAG);
  assert.equal(new Date(t('plan-2', 'b1').zurueckgestellt_bis).getTime(), JETZT.getTime() + 7 * TAG);
  const b1 = t('plan-2', 'b1');
  assert.equal(b1.eigenesFeld, 7);
  assert.equal(b1.status, 'todo');
  assert.deepEqual(b1.empfehlung, emp);
  for (const id of ['b2', 'b3', 'b4', 'b5', 'b6']) assert.deepEqual(t('plan-2', id), vorher.tasks.find((x) => x.id === id));
  assert.equal(r.plan_ref.kurz_id, 'P2');
  assert.equal(r.task.kurz_id, 'P2-T1');
  assert.ok(!sqlLog.some((s) => /^(BEGIN|COMMIT|ROLLBACK)|FOR UPDATE/i.test(s)), 'keine Sperre');
  assert.equal(sqlLog.filter((s) => /^(UPDATE|INSERT|DELETE)/i.test(s)).length, 1, 'genau ein schreibendes Statement');
});

await pruefe('per UUID und plan-uebergreifend (Task in inaktivem Plan) und per Alias-Kurz-ID', async () => {
  reset();
  let r = await core.zurueckstelleTask('p', undefined, 'a1', { tage: 3 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(t('plan-1', 'a1').zurueckgestellt_bis);
  r = await core.zurueckstelleTask('p', 'P1', 'P9-T4', { tage: 3 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(t('plan-1', 'a2').zurueckgestellt_bis, 'Alias findet die Task');
});

await pruefe('bis: ISO-Datum und nur Datum; Qdrant-Index wird nachgezogen', async () => {
  reset();
  indexAufrufe = [];
  const ziel = inTagen(9);
  let r = await core.zurueckstelleTask('p', undefined, 'P2-T1', { bis: ziel }, JETZT);
  assert.equal(r.success, true);
  assert.equal(new Date(t('plan-2', 'b1').zurueckgestellt_bis).getTime(), new Date(ziel).getTime());
  assert.ok(indexAufrufe.some((p) => p.id === 'plan-2'), 'Index nicht nachgezogen');
  r = await core.zurueckstelleTask('p', undefined, 'P2-T1', { bis: '2026-10-15' }, JETZT);
  assert.equal(new Date(t('plan-2', 'b1').zurueckgestellt_bis).toISOString().slice(0, 10), '2026-10-15');
});

await pruefe('tage:0 hebt auf: Feld wird entfernt', async () => {
  reset();
  const r = await core.zurueckstelleTask('p', undefined, 'P2-T2', { tage: 0 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.zurueckgestellt_bis, null);
  assert.ok(!('zurueckgestellt_bis' in t('plan-2', 'b2')), 'Feld muss entfernt sein');
});

await pruefe('Zurueckgestellte Task kann verlaengert werden', async () => {
  reset();
  await core.zurueckstelleTask('p', undefined, 'P2-T2', { tage: 30 }, JETZT);
  assert.equal(new Date(t('plan-2', 'b2').zurueckgestellt_bis).getTime(), JETZT.getTime() + 30 * TAG);
});

await pruefe('Validierung: kaputte tage, tage+bis, weder noch, bis in Vergangenheit, kaputtes bis, unbekannte Task, erledigte Task, falscher Plan -> success:false, nichts geschrieben', async () => {
  reset();
  const vorher = JSON.stringify(PLAENE);
  const faelle = [
    ['P2-T1', { tage: -1 }], ['P2-T1', { tage: 'x' }], ['P2-T1', { tage: 3, bis: inTagen(3) }], ['P2-T1', {}],
    ['P2-T1', { bis: inTagen(-1) }], ['P2-T1', { bis: 'gestern-ish' }],
    ['P2-T99', { tage: 3 }], ['nichtda', { tage: 3 }], ['P2-T6', { tage: 3 }],
  ];
  for (const [ref, opt] of faelle) {
    const r = await core.zurueckstelleTask('p', undefined, ref, opt, JETZT);
    assert.equal(r.success, false, `${ref} ${JSON.stringify(opt)} muss scheitern`);
    assert.ok(r.message);
  }
  const r = await core.zurueckstelleTask('p', 'P1', 'P2-T1', { tage: 3 }, JETZT);
  assert.equal(r.success, false, 'Task gehoert nicht zu Plan P1');
  assert.equal(JSON.stringify(PLAENE), vorher, 'nichts geschrieben');
});

await pruefe('Gleichzeitige Aenderung waehrend des Schreibens: optimistischer Retry, keine Aenderung geht verloren', async () => {
  reset();
  eingriff = () => { t('plan-2', 'b3').title = 'Parallel geaendert'; };
  const r = await core.zurueckstelleTask('p', undefined, 'P2-T1', { tage: 2 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(t('plan-2', 'b3').title, 'Parallel geaendert');
  assert.ok(t('plan-2', 'b1').zurueckgestellt_bis);
});

// ---------------------------------------------------------------------------
// 2. Sichtbarkeit (get)
// ---------------------------------------------------------------------------
await pruefe('Filter Standard: nur Tasks mit Wiedervorlage in der Zukunft ausgeblendet (P2-T2, P2-T5); Grenze bis==jetzt ist sichtbar', () => {
  reset();
  const r = core.filtereWiedervorlageTasks(PLAENE[1].tasks, { jetzt: JETZT });
  assert.deepEqual(kurz(r.tasks), ['P2-T1', 'P2-T3', 'P2-T4', 'P2-T6']);
  assert.equal(r.ausgeblendet, 2);
});

await pruefe('Filter: abgelaufene tragen wieder_vorgelegt_seit (altes Datum), noch schlafende und Normale nicht', () => {
  reset();
  const r = core.filtereWiedervorlageTasks(PLAENE[1].tasks, { jetzt: JETZT });
  const p3 = r.tasks.find((x) => x.kurz_id === 'P2-T3');
  assert.equal(new Date(p3.wieder_vorgelegt_seit).getTime(), new Date(inTagen(-3)).getTime());
  assert.equal(r.tasks.find((x) => x.kurz_id === 'P2-T4').wieder_vorgelegt_seit, JETZT.toISOString());
  assert.equal(r.tasks.find((x) => x.kurz_id === 'P2-T1').wieder_vorgelegt_seit, undefined);
});

await pruefe('Filter alle:true zeigt alle, schlafende mit zurueckgestellt:true; ausdrueckliche task_id zeigt genau diese immer', () => {
  reset();
  const a = core.filtereWiedervorlageTasks(PLAENE[1].tasks, { alle: true, jetzt: JETZT });
  assert.equal(a.tasks.length, 6);
  assert.equal(a.ausgeblendet, 0);
  assert.equal(a.tasks.find((x) => x.kurz_id === 'P2-T2').zurueckgestellt, true);
  assert.equal(a.tasks.find((x) => x.kurz_id === 'P2-T1').zurueckgestellt, undefined);
  const e = core.filtereWiedervorlageTasks(PLAENE[1].tasks, { taskIds: ['P2-T2'], jetzt: JETZT });
  assert.deepEqual(kurz(e.tasks), ['P2-T1', 'P2-T2', 'P2-T3', 'P2-T4', 'P2-T6']);
  assert.equal(e.ausgeblendet, 1);
});

await pruefe('Alt-Aufruf: Tasks ohne Wiedervorlage-Feld kommen unveraendert zurueck (gleiche Felder, keine neuen)', () => {
  reset();
  const tasks = PLAENE[2].tasks;
  const r = core.filtereWiedervorlageTasks(tasks, { jetzt: JETZT });
  assert.deepEqual(r.tasks, tasks);
  assert.equal(r.ausgeblendet, 0);
});

// ---------------------------------------------------------------------------
// 3. passende_tasks / uebernehmen
// ---------------------------------------------------------------------------
await pruefe('passende_tasks blendet zurueckgestellte aus und zaehlt sie; abgelaufene sind wieder dabei', async () => {
  reset();
  const r = await core.passendeTasks('p', 'sonnet-medium', 'P2', JETZT);
  assert.equal(r.success, true, r.message);
  assert.deepEqual(r.passend.map((x) => x.kurz_id), ['P2-T1', 'P2-T3', 'P2-T4']);
  assert.equal(r.zurueckgestellt_ausgeblendet, 2);
});

await pruefe('passende_tasks ohne Zurueckgestellte: KEIN neues Feld in der Antwort (alte Antwortform)', async () => {
  reset();
  const p1 = await core.passendeTasks('p', 'sonnet-medium', 'P1', JETZT);
  assert.equal(p1.success, true, p1.message);
  assert.equal('zurueckgestellt_ausgeblendet' in p1, false);
});

await pruefe('uebernehmen lehnt eine zurueckgestellte Task ab (mit Datum), abgelaufene geht', async () => {
  reset();
  let r = await core.uebernehmeTask('p', 'P2', 'P2-T2', 'sonnet-medium');
  assert.equal(r.success, false);
  assert.match(r.message, /zurueckgestellt/);
  assert.ok(!t('plan-2', 'b2').zugewiesen_an);
  r = await core.uebernehmeTask('p', 'P2', 'P2-T3', 'sonnet-medium');
  assert.equal(r.success, true, r.message);
  assert.equal(t('plan-2', 'b3').zugewiesen_an, 'sonnet-medium');

// ---------------------------------------------------------------------------
// 4. MCP-Tool: zurueckstellen mit task_id, get-Filter
// ---------------------------------------------------------------------------
await pruefe('MCP plan-Tool: zurueckstellen mit task_id stellt die TASK zurueck (nicht den Plan); Schema nennt task_id/alle', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  assert.ok(planTool.definition.inputSchema.properties.alle, 'alle fehlt im Schema');
  const z = await planTool.handler({ action: 'zurueckstellen', project: 'p', task_id: 'P2-T1', tage: 14 });
  assert.equal(z.success, true, JSON.stringify(z));
  assert.ok(z.task && z.task.kurz_id === 'P2-T1', 'Antwort nennt die Task');
  const bis = new Date(t('plan-2', 'b1').zurueckgestellt_bis).getTime();
  assert.ok(Math.abs(bis - (Date.now() + 14 * TAG)) < 60000);
  assert.equal(PLAENE.find((p) => p.id === 'plan-2').zurueckgestellt_bis, undefined, 'Plan darf nicht zurueckgestellt werden');
  const auf = await planTool.handler({ action: 'zurueckstellen', project: 'p', task_id: 'P2-T1', tage: 0 });
  assert.equal(auf.success, true);
  assert.ok(!('zurueckgestellt_bis' in t('plan-2', 'b1')));
});

await pruefe('MCP plan-Tool: get blendet zurueckgestellte Tasks aus (Zaehler), alle:true / task_id zeigen sie', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const g = await planTool.handler({ action: 'get', project: 'p', plan_id: 'P2' });
  const ids = g.tasks.map((x) => x.kurz_id);
  assert.ok(!ids.includes('P2-T2'), 'schlafende Task muss fehlen');
  assert.ok(ids.includes('P2-T1') && ids.includes('P2-T3'));
  assert.equal(g.zurueckgestellt_ausgeblendet, 1);
  const a = await planTool.handler({ action: 'get', project: 'p', plan_id: 'P2', alle: true });
  const t2 = a.tasks.find((x) => x.kurz_id === 'P2-T2');
  assert.ok(t2 && t2.zurueckgestellt === true);
  const e = await planTool.handler({ action: 'get', project: 'p', plan_id: 'P2', task_id: 'P2-T2' });
  assert.ok(e.tasks.some((x) => x.kurz_id === 'P2-T2'));
});

await pruefe('MCP plan-Tool: get ohne Wiedervorlage liefert dieselbe Antwortform wie bisher (kein neues Feld)', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const g = await planTool.handler({ action: 'get', project: 'alt' });
  assert.equal(g.tasks.length, 2);
  assert.equal(g.tasks_total, 2);
  assert.ok(!('zurueckgestellt_ausgeblendet' in g));
  assert.ok(g.tasks.every((x) => !('zurueckgestellt' in x) && !('wieder_vorgelegt_seit' in x)));
});

});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
