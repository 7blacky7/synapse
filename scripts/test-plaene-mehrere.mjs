#!/usr/bin/env node
// test-plaene-mehrere.mjs — plan-Tool: mehrere Plaene je Projekt + Kurz-IDs (Task 137fabaf).
//
// HARTE BEDINGUNG (User 29.09.2026): kein Projekt darf brechen. Deshalb zuerst die ALTEN Aufrufe:
//   1. Einzelplan-Projekt: getPlan/addTask/addTasksBatch/updateTask/deleteTasks/updatePlan OHNE
//      plan_id liefern dasselbe wie vorher (alle alten Felder), nur mit Zusatzfeldern (kurz_id ...).
//   2. Altbestand VOR dem Kurz-ID-Skript (kurz_id/aktiv NULL): alles laeuft wie heute, es werden
//      keine Kurz-IDs vergeben, "aktiv" = zuletzt geaenderter Plan (= heutiges Qdrant-Verhalten).
//   3. Mehrplan-Projekt: ohne plan_id wirkt der AKTIVE Plan; UUID und Kurz-ID gleichwertig; eine
//      alte Task-UUID aus einem inaktiven Plan bleibt aenderbar; list/create/aktivieren.
//   4. Lesen nur aus PG: kein Qdrant-Zugriff beim Lesen, kein neuer Plan, wenn Qdrant leer ist.
//   5. Kurz-IDs stabil und nie wiederverwendet (Zaehler je Plan); Skript-Logik planeKurzIds.
//   6. Onboarding-Uebersicht (nur aktive/offene Plaene, keine Tasks); MCP-plan-Tool verdrahtet.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt (plans-Tabelle im Speicher), Qdrant-Index gestubbt.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-plaene-mehrere.mjs   (Exit 1 bei Fehler)

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

// ---------------------------------------------------------------------------
// Fake-DB: Tabelle plans im Speicher
// ---------------------------------------------------------------------------
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (id, title, kurz, extra = {}) => ({
  id, title, description: `${title} (Beschreibung)`, status: 'todo', priority: 'medium',
  createdAt: `2026-01-0${1 + (id.length % 8)}T00:00:00.000Z`, updatedAt: '2026-01-01T00:00:00.000Z',
  ...(kurz ? { kurz_id: kurz } : {}), ...extra,
});
let PLAENE;
let sqlLog;
let eingriff = null; // Hook fuer die Nebenlaeufigkeits-Probe
function reset() {
  PLAENE = [
    // Einzelplan-Projekt, schon mit Kurz-IDs (Zustand NACH dem Skript)
    { id: 'plan-solo', project: 'solo', name: 'Solo-Plan', description: 'Ziel solo', goals: ['G1'], architecture: 'A',
      tasks: [task(U(1), 'Erste', 'P1-T1'), task(U(2), 'Zweite', 'P1-T2', { eigenesFeld: { x: 1 } })],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', kurz_id: 'P1', aktiv: true, naechste_task_nr: 3 },
    // Einzelplan-Projekt im Altbestand (VOR dem Skript: keine Kurz-IDs, aktiv NULL)
    { id: 'plan-alt', project: 'alt', name: 'Alt-Plan', description: 'Ziel alt', goals: [], architecture: null,
      tasks: [task(U(10), 'Alte Task', null)],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', kurz_id: null, aktiv: null, naechste_task_nr: null },
    // Mehrplan-Projekt (synapse-Fall NACH dem Skript): P1 leer/inaktiv, P2 aktiv
    { id: 'plan-m1', project: 'multi', name: 'Grundplan', description: 'leer', goals: [], architecture: null,
      tasks: [task(U(20), 'In P1', 'P1-T1')],
      created_at: '2026-03-15T06:57:00.000Z', updated_at: '2026-03-15T06:57:00.000Z', kurz_id: 'P1', aktiv: false, naechste_task_nr: 2 },
    { id: 'plan-m2', project: 'multi', name: 'PLAN-004', description: 'gross', goals: ['X'], architecture: 'Y',
      tasks: [task(U(30), 'In P2 a', 'P2-T1'), task(U(31), 'In P2 b', 'P2-T2')],
      created_at: '2026-03-15T07:12:00.000Z', updated_at: '2026-09-29T19:00:00.000Z', kurz_id: 'P2', aktiv: true, naechste_task_nr: 3 },
    // Mehrplan-Projekt VOR dem Skript (synapse heute): keine Flags
    { id: 'plan-v1', project: 'vorher', name: 'synapse', description: '', goals: [], architecture: null, tasks: [],
      created_at: '2026-03-15T06:57:00.000Z', updated_at: '2026-03-15T06:57:00.000Z', kurz_id: null, aktiv: null, naechste_task_nr: null },
    { id: 'plan-v2', project: 'vorher', name: 'PLAN-004', description: 'gross', goals: [], architecture: null,
      tasks: [task(U(40), 'Heute', null)],
      created_at: '2026-03-15T07:12:00.000Z', updated_at: '2026-09-29T19:00:00.000Z', kurz_id: null, aktiv: null, naechste_task_nr: null },
  ];
  sqlLog = [];
  eingriff = null;
}
reset();

const zeilen = (project) => PLAENE.filter((p) => p.project === project);
pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  sqlLog.push(text);
  if (/^SELECT .* FROM plans WHERE project = \$1/i.test(text)) {
    return { rows: structuredClone(zeilen(params[0])), rowCount: zeilen(params[0]).length };
  }
  if (/^INSERT INTO plans/i.test(text)) {
    const [id, project, name, description, goals, architecture, tasks, created_at, updated_at, kurz_id, aktiv, naechste_task_nr] = params;
    PLAENE.push({ id, project, name, description, goals, architecture, tasks: JSON.parse(tasks), created_at, updated_at, kurz_id, aktiv, naechste_task_nr });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE plans SET aktiv = \(id = \$2\) WHERE project = \$1/i.test(text)) {
    let n = 0;
    for (const p of zeilen(params[0])) { p.aktiv = p.id === params[1]; n++; }
    return { rows: [], rowCount: n };
  }
  if (/^UPDATE plans SET name = \$1/i.test(text)) {
    const [name, description, goals, architecture, tasks, naechste, updated_at, id, alt] = params;
    if (eingriff) { const e = eingriff; eingriff = null; e(); }
    const p = PLAENE.find((x) => x.id === id);
    if (!p || JSON.stringify(p.tasks) !== JSON.stringify(JSON.parse(alt))) return { rows: [], rowCount: 0 };
    Object.assign(p, { name, description, goals, architecture, tasks: JSON.parse(tasks), naechste_task_nr: naechste, updated_at });
    return { rows: [], rowCount: 1 };
  }
  if (/^DELETE FROM plans WHERE id = \$1/i.test(text)) {
    const vorher = PLAENE.length;
    PLAENE = PLAENE.filter((p) => p.id !== params[0]);
    return { rows: [], rowCount: vorher - PLAENE.length };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const core = await import('../packages/core/dist/index.js');
let indexAufrufe = [];
core.planIndex.sync = async (plan) => { indexAufrufe.push(plan); };

const ALTE_PLAN_FELDER = ['id', 'project', 'name', 'description', 'goals', 'architecture', 'tasks', 'createdAt', 'updatedAt'];
const ALTE_TASK_FELDER = ['id', 'title', 'description', 'status', 'priority', 'createdAt', 'updatedAt'];

// ---------------------------------------------------------------------------
// 1. Einzelplan-Projekt, alte Aufrufe
// ---------------------------------------------------------------------------
await pruefe('Einzelplan: getPlan(project) — alle alten Felder, dazu kurz_id/aktiv/plaene_im_projekt', async () => {
  reset();
  const p = await core.getPlan('solo');
  for (const f of ALTE_PLAN_FELDER) assert.ok(f in p, `Feld ${f} fehlt`);
  assert.equal(p.id, 'plan-solo');
  assert.equal(p.name, 'Solo-Plan');
  assert.deepEqual(p.goals, ['G1']);
  assert.equal(p.tasks.length, 2);
  assert.deepEqual(p.tasks[1].eigenesFeld, { x: 1 }, 'fremde Task-Felder bleiben');
  assert.equal(p.kurz_id, 'P1');
  assert.equal(p.aktiv, true);
  assert.equal(p.plaene_im_projekt, 1);
});

await pruefe('Einzelplan: addTask ohne plan_id — alte Rueckgabe + kurz_id P1-T3 + plan_ref, kein hinweis_plaene', async () => {
  reset();
  const t = await core.addTask('solo', 'Neu', 'Beschreibung', 'high');
  for (const f of ALTE_TASK_FELDER) assert.ok(f in t, `Feld ${f} fehlt`);
  assert.equal(t.status, 'todo');
  assert.equal(t.priority, 'high');
  assert.equal(t.kurz_id, 'P1-T3');
  assert.deepEqual(t.plan_ref, { id: 'plan-solo', kurz_id: 'P1', name: 'Solo-Plan', aktiv: true });
  assert.equal(t.hinweis_plaene, undefined);
  const p = zeilen('solo')[0];
  assert.equal(p.tasks.length, 3);
  assert.equal(p.naechste_task_nr, 4);
  assert.equal(p.tasks[2].plan_ref, undefined, 'plan_ref gehoert nur in die Antwort, nicht in die DB');
});

await pruefe('Einzelplan: updateTask per UUID und per Kurz-ID gleichwertig', async () => {
  reset();
  const a = await core.updateTask('solo', U(1), { status: 'done' });
  assert.equal(a.status, 'done');
  assert.equal(a.id, U(1));
  const b = await core.updateTask('solo', 'P1-T2', { priority: 'high' });
  assert.equal(b.id, U(2));
  assert.equal(b.priority, 'high');
  assert.deepEqual(zeilen('solo')[0].tasks[1].eigenesFeld, { x: 1 });
  assert.equal(await core.updateTask('solo', 'gibt-es-nicht', { status: 'done' }), null, 'unbekannt -> null wie bisher');
});

await pruefe('Einzelplan: deleteTasks + neue Task -> Nummer wird NICHT wiederverwendet', async () => {
  reset();
  await core.addTask('solo', 'Drei', 'd'); // P1-T3
  const r = await core.deleteTasks('solo', ['P1-T3']);
  assert.equal(r.deleted, 1);
  const t = await core.addTask('solo', 'Vier', 'd');
  assert.equal(t.kurz_id, 'P1-T4');
});

await pruefe('Einzelplan: addTasksBatch und updatePlan ohne plan_id wie bisher', async () => {
  reset();
  const r = await core.addTasksBatch('solo', [{ title: 'A', description: 'a' }, { title: 'B', description: 'b', priority: 'low' }]);
  assert.equal(r.tasks.length, 2);
  assert.deepEqual(r.tasks.map((t) => t.kurz_id), ['P1-T3', 'P1-T4']);
  assert.equal(r.tasks[1].priority, 'low');
  const p = await core.updatePlan('solo', { name: 'Umbenannt' });
  assert.equal(p.name, 'Umbenannt');
  assert.equal(zeilen('solo')[0].name, 'Umbenannt');
  assert.equal(zeilen('solo')[0].tasks.length, 4, 'updatePlan laesst Tasks stehen');
});

// ---------------------------------------------------------------------------
// 2. Altbestand vor dem Skript
// ---------------------------------------------------------------------------
await pruefe('Altbestand (vor dem Skript): getPlan/addTask laufen, keine Kurz-IDs werden vergeben', async () => {
  reset();
  const p = await core.getPlan('alt');
  assert.equal(p.id, 'plan-alt');
  assert.equal(p.kurz_id, null);
  assert.equal(p.aktiv, true, 'einziger Plan ist effektiv aktiv');
  const t = await core.addTask('alt', 'Neu', 'd');
  assert.equal(t.kurz_id, undefined);
  assert.equal(zeilen('alt')[0].tasks.length, 2);
  assert.equal(zeilen('alt')[0].kurz_id, null, 'kein Nachvergeben der Plan-Kurz-ID ausserhalb des Skripts');
});

await pruefe('Altbestand mit zwei Plaenen (synapse heute): ohne plan_id wirkt der zuletzt geaenderte (= heutiges Verhalten)', async () => {
  reset();
  const p = await core.getPlan('vorher');
  assert.equal(p.id, 'plan-v2');
  const t = await core.addTask('vorher', 'Neu', 'd');
  assert.equal(zeilen('vorher').find((x) => x.id === 'plan-v2').tasks.length, 2);
  assert.equal(t.plan_ref.id, 'plan-v2');
});

await pruefe('Altbestand: createPlan friert den bisher effektiv aktiven Plan ein, der neue loest ihn nicht still ab', async () => {
  reset();
  await core.createPlan('vorher', 'Dritter', 'd', []);
  const p = await core.getPlan('vorher');
  assert.equal(p.id, 'plan-v2');
  assert.equal(zeilen('vorher').find((x) => x.id === 'plan-v2').aktiv, true);
});

// ---------------------------------------------------------------------------
// 3. Mehrplan-Projekt
// ---------------------------------------------------------------------------
await pruefe('Mehrplan: ohne plan_id der AKTIVE Plan (P2), mit P1/UUID der gewaehlte, hinweisPlaene nennt plan(list)', async () => {
  reset();
  const p = await core.getPlan('multi');
  assert.equal(p.id, 'plan-m2');
  assert.equal(p.plaene_im_projekt, 2);
  assert.match(core.hinweisPlaene(p), /P2/);
  assert.match(core.hinweisPlaene(p), /plan\(list\)/);
  assert.equal((await core.getPlan('multi', 'P1')).id, 'plan-m1');
  assert.equal((await core.getPlan('multi', 'p1')).id, 'plan-m1', 'Kurz-ID ohne Beachtung der Gross-/Kleinschreibung');
  assert.equal((await core.getPlan('multi', 'plan-m1')).id, 'plan-m1');
  assert.equal(core.hinweisPlaene(await core.getPlan('solo')), undefined);
});

await pruefe('Mehrplan: addTask ohne plan_id -> aktiver Plan; mit P1 -> P1 (P1-T2), hinweis_plaene in der Antwort', async () => {
  reset();
  const a = await core.addTask('multi', 'Neu aktiv', 'd');
  assert.equal(a.kurz_id, 'P2-T3');
  assert.match(a.hinweis_plaene, /plan\(list\)/);
  const b = await core.addTask('multi', 'Neu P1', 'd', 'medium', 'P1');
  assert.equal(b.kurz_id, 'P1-T2');
  assert.equal(b.plan_ref.kurz_id, 'P1');
});

await pruefe('Mehrplan: alte Task-UUID aus dem INAKTIVEN Plan bleibt ohne plan_id aenderbar', async () => {
  reset();
  const t = await core.updateTask('multi', U(20), { status: 'done' });
  assert.equal(t.status, 'done');
  assert.equal(t.plan_ref.kurz_id, 'P1');
  assert.equal(zeilen('multi').find((x) => x.id === 'plan-m1').tasks[0].status, 'done');
});

await pruefe('Mehrplan: Kurz-ID P2-T1 und UUID treffen dieselbe Task; P1-T1 mit plan_id P2 -> Fehler', async () => {
  reset();
  const a = await core.updateTask('multi', 'P2-T1', { priority: 'low' });
  assert.equal(a.id, U(30));
  await assert.rejects(() => core.updateTask('multi', 'P1-T1', { status: 'done' }, 'P2'), /P1-T1/);
});

await pruefe('Mehrplan: updatePlan am inaktiven Plan -> Fehler (abgeschlossen), ohne plan_id am aktiven', async () => {
  reset();
  await assert.rejects(() => core.updatePlan('multi', { name: 'x' }, 'P1'), /nicht aktiv/);
  const p = await core.updatePlan('multi', { description: 'neu' });
  assert.equal(p.id, 'plan-m2');
  assert.equal(p.description, 'neu');
});

await pruefe('Mehrplan: listPlans mit Kurz-ID, Name, aktiv, offen/gesamt', async () => {
  reset();
  const l = await core.listPlans('multi');
  assert.deepEqual(l.map((x) => [x.kurz_id, x.name, x.aktiv, x.tasks_offen, x.tasks_gesamt]), [
    ['P1', 'Grundplan', false, 1, 1],
    ['P2', 'PLAN-004', true, 2, 2],
  ]);
  assert.equal(l[0].tasks, undefined, 'list liefert keine Tasks');
});

await pruefe('Mehrplan: createPlan (aktiv) -> P3 aktiv, P2 inaktiv; aktivierePlan P2 schaltet zurueck', async () => {
  reset();
  const neu = await core.createPlan('multi', 'Runde 2', 'Ziel', ['Z'], { aktiv: true });
  assert.equal(neu.kurz_id, 'P3');
  assert.equal(neu.aktiv, true);
  assert.equal((await core.getPlan('multi')).kurz_id, 'P3');
  assert.equal(zeilen('multi').filter((p) => p.aktiv === true).length, 1);
  const r = await core.aktivierePlan('multi', 'P2');
  assert.equal(r.kurz_id, 'P2');
  assert.equal((await core.getPlan('multi')).kurz_id, 'P2');
  assert.ok(sqlLog.some((s) => /^UPDATE plans SET aktiv = \(id = \$2\) WHERE project = \$1/i.test(s)), 'Aktivieren ist EIN UPDATE');
});

await pruefe('Mehrplan: createPlan ohne aktiv -> neuer Plan inaktiv, aktiver bleibt', async () => {
  reset();
  const neu = await core.createPlan('multi', 'Entwurf', 'd', []);
  assert.equal(neu.aktiv, false);
  assert.equal((await core.getPlan('multi')).kurz_id, 'P2');
});

await pruefe('Fehler: unbekannter plan_id -> klarer Fehler mit der Planliste', async () => {
  reset();
  await assert.rejects(() => core.getPlan('multi', 'P9'), (e) => /P9/.test(e.message) && /P1/.test(e.message) && /P2/.test(e.message));
});

// ---------------------------------------------------------------------------
// 4. PG statt Qdrant
// ---------------------------------------------------------------------------
await pruefe('Lesen nur aus PG: getPlan ruft keinen Qdrant-Index; Projekt ohne Plan -> null; updatePlan legt dann P1 aktiv an', async () => {
  reset();
  indexAufrufe = [];
  const p = await core.getPlan('solo');
  assert.ok(p);
  assert.equal(indexAufrufe.length, 0);
  assert.equal(await core.getPlan('leer'), null);
  const neu = await core.updatePlan('leer', { name: 'Erster' });
  assert.equal(neu.kurz_id, 'P1');
  assert.equal(neu.aktiv, true);
  assert.equal(zeilen('leer').length, 1);
});

await pruefe('Kein neuer Plan, wenn Qdrant leer ist: vorhandener PG-Plan wird gefunden (Muster init/projects: if (!getPlan) createPlan)', async () => {
  reset();
  const vorher = PLAENE.length;
  // genau das Muster aus rest-api routes/projects.ts und mcp-server tools/init.ts
  if (!(await core.getPlan('vorher'))) await core.createPlan('vorher', 'vorher', 'Projekt-Plan', []);
  assert.equal(PLAENE.length, vorher);
});

await pruefe('Schreiben: gleichzeitige Aenderung -> neu gelesen, fremde Aenderung bleibt, Zaehler stimmt', async () => {
  reset();
  eingriff = () => {
    const p = PLAENE.find((x) => x.id === 'plan-solo');
    p.tasks = [...p.tasks, task(U(99), 'Fremd', 'P1-T3')];
    p.naechste_task_nr = 4;
  };
  const t = await core.addTask('solo', 'Meine', 'd');
  const p = zeilen('solo')[0];
  assert.equal(p.tasks.length, 4);
  assert.ok(p.tasks.some((x) => x.id === U(99)), 'fremde Task verloren');
  assert.equal(t.kurz_id, 'P1-T4');
});

// ---------------------------------------------------------------------------
// 5. Skript-Logik
// ---------------------------------------------------------------------------
await pruefe('planeKurzIds: synapse-Fall -> Leerplan P1 inaktiv, PLAN-004 P2 aktiv, Tasks T1..Tn nach createdAt', () => {
  reset();
  const zeilenVorher = structuredClone(zeilen('vorher'));
  zeilenVorher[1].tasks = [
    task(U(41), 'spaeter', null, { createdAt: '2026-05-01T00:00:00.000Z' }),
    task(U(42), 'frueher', null, { createdAt: '2026-04-01T00:00:00.000Z' }),
  ];
  const aend = core.planeKurzIds(zeilenVorher);
  const leer = aend.find((a) => a.id === 'plan-v1');
  const gross = aend.find((a) => a.id === 'plan-v2');
  assert.equal(leer.kurz_id, 'P1');
  assert.equal(leer.aktiv, false);
  assert.equal(gross.kurz_id, 'P2');
  assert.equal(gross.aktiv, true);
  assert.deepEqual(gross.tasks.map((t) => [t.title, t.kurz_id]), [['spaeter', 'P2-T2'], ['frueher', 'P2-T1']]);
  assert.equal(gross.naechste_task_nr, 3);
});

await pruefe('planeKurzIds: zweiter Lauf aendert nichts (stabil); vorhandene IDs und Zaehler bleiben, Neue zaehlen weiter', () => {
  reset();
  const erst = core.planeKurzIds(structuredClone(zeilen('vorher')));
  const nachher = structuredClone(zeilen('vorher')).map((z) => ({ ...z, ...(erst.find((a) => a.id === z.id) ?? {}) }));
  assert.deepEqual(core.planeKurzIds(nachher), []);
  const mitNeuer = structuredClone(zeilen('solo'));
  mitNeuer[0].naechste_task_nr = 10;
  mitNeuer[0].tasks.push(task(U(77), 'ohne Kurz-ID', null));
  const a = core.planeKurzIds(mitNeuer);
  assert.equal(a.length, 1);
  assert.equal(a[0].tasks[2].kurz_id, 'P1-T10', 'Zaehler zaehlt, nicht das Maximum');
  assert.equal(a[0].naechste_task_nr, 11);
  assert.equal(a[0].tasks[0].kurz_id, 'P1-T1');
});

// ---------------------------------------------------------------------------
// 6. Onboarding + Tool
// ---------------------------------------------------------------------------
await pruefe('Onboarding: planUebersicht nur aktive/offene Plaene, ohne Tasks', async () => {
  reset();
  zeilen('multi')[0].tasks[0].status = 'done'; // P1 hat nichts offen und ist inaktiv
  const u = await core.planUebersicht('multi');
  assert.deepEqual(u, [{ kurz_id: 'P2', name: 'PLAN-004', aktiv: true, offen: 2, gesamt: 2 }]);
});

await pruefe('MCP plan-Tool: list/create/aktivieren im Schema; get mit plan_id; update_task mit Kurz-ID; alte Aufrufe ohne plan_id', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const props = planTool.definition.inputSchema.properties;
  for (const a of ['list', 'create', 'aktivieren']) assert.ok(props.action.enum.includes(a), `${a} fehlt im enum`);
  assert.ok(props.plan_id, 'plan_id fehlt im Schema');
  const liste = await planTool.handler({ action: 'list', project: 'multi' });
  assert.equal(liste.success, true);
  assert.equal(liste.plaene.length, 2);
  const g = await planTool.handler({ action: 'get', project: 'multi', plan_id: 'P1' });
  assert.equal(g.success, true);
  assert.equal(g.plan.id, 'plan-m1');
  assert.equal(g.plan_ref.kurz_id, 'P1');
  const u = await planTool.handler({ action: 'update_task', project: 'multi', task_id: 'P2-T2', status: 'done' });
  assert.equal(u.success, true);
  assert.equal(u.task.id, U(31));
  const alt = await planTool.handler({ action: 'update_task', project: 'solo', task_id: U(1), status: 'in_progress' });
  assert.equal(alt.success, true);
  assert.equal(alt.task.status, 'in_progress');
  const add = await planTool.handler({ action: 'add_task', project: 'solo', title: 'T', description: 'D' });
  assert.equal(add.success, true);
  assert.equal(add.task.kurz_id, 'P1-T3');
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
