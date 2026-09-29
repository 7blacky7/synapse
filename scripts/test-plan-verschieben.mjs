#!/usr/bin/env node
// test-plan-verschieben.mjs — plan(verschieben): Tasks zwischen Plaenen verschieben (P3-T1).
//
// Geprueft: Alias der alten Kurz-ID (Aufloesung in allen Task-Aktionen), Atomaritaet ueber
// beide/alle betroffenen plans-Zeilen in EINEM Statement (keine Sperre mit Client-Wartezeit),
// gleichzeitige Aenderung, unveraenderte Felder, Zaehler, Einzelplan-Projekte, Tool-Verdrahtung.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt (plans-Tabelle im Speicher), Qdrant-Index gestubbt.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-plan-verschieben.mjs   (Exit 1 bei Fehler)

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

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (id, title, kurz, extra = {}) => ({
  id, title, description: `${title} (Beschreibung)`, status: 'todo', priority: 'medium',
  createdAt: `2026-01-0${1 + (id.length % 8)}T00:00:00.000Z`, updatedAt: '2026-01-01T00:00:00.000Z',
  ...(kurz ? { kurz_id: kurz } : {}), ...extra,
});
let PLAENE;
let sqlLog;
let eingriff = null; // Hook: laeuft vor dem naechsten schreibenden Statement (Nebenlaeufigkeit)
let eingriffImmer = false; // Hook bei JEDEM Schreibversuch
function reset() {
  PLAENE = [
    { id: 'plan-m1', project: 'multi', name: 'Grundplan', description: 'leer', goals: [], architecture: null,
      tasks: [task(U(20), 'In P1', 'P1-T1')],
      created_at: '2026-03-15T06:57:00.000Z', updated_at: '2026-03-15T06:57:00.000Z', kurz_id: 'P1', aktiv: false, naechste_task_nr: 2 },
    { id: 'plan-m2', project: 'multi', name: 'PLAN-004', description: 'gross', goals: ['X'], architecture: 'Y',
      tasks: [
        task(U(30), 'In P2 a', 'P2-T1', { empfehlung: { modell: 'sonnet' }, zugewiesen_an: 'x', eigenesFeld: { y: 1 }, priority: 'high', status: 'in_progress' }),
        task(U(31), 'In P2 b', 'P2-T2'),
        task(U(32), 'In P2 c', 'P2-T3'),
      ],
      created_at: '2026-03-15T07:12:00.000Z', updated_at: '2026-09-29T19:00:00.000Z', kurz_id: 'P2', aktiv: true, naechste_task_nr: 4 },
    { id: 'plan-m3', project: 'multi', name: 'Drittplan', description: 'Ziel', goals: [], architecture: null,
      tasks: [],
      created_at: '2026-04-01T00:00:00.000Z', updated_at: '2026-04-01T00:00:00.000Z', kurz_id: 'P3', aktiv: false, naechste_task_nr: 1 },
    // Plan ohne Kurz-ID (Bestand vor dem Skript)
    { id: 'plan-o1', project: 'ohne', name: 'A', description: '', goals: [], architecture: null,
      tasks: [task(U(50), 'X', null)],
      created_at: '2026-03-15T06:57:00.000Z', updated_at: '2026-03-15T06:57:00.000Z', kurz_id: null, aktiv: null, naechste_task_nr: null },
    { id: 'plan-o2', project: 'ohne', name: 'B', description: '', goals: [], architecture: null, tasks: [],
      created_at: '2026-03-16T06:57:00.000Z', updated_at: '2026-03-16T06:57:00.000Z', kurz_id: null, aktiv: null, naechste_task_nr: null },
    // Einzelplan-Projekt
    { id: 'plan-solo', project: 'solo', name: 'Solo-Plan', description: 'Ziel solo', goals: ['G1'], architecture: 'A',
      tasks: [task(U(1), 'Erste', 'P1-T1'), task(U(2), 'Zweite', 'P1-T2')],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', kurz_id: 'P1', aktiv: true, naechste_task_nr: 3 },
  ];
  sqlLog = [];
  eingriff = null;
  eingriffImmer = false;
}
reset();

const zeilen = (project) => PLAENE.filter((p) => p.project === project);
const hole = (id) => PLAENE.find((p) => p.id === id);
function feuereEingriff() {
  if (eingriffImmer && eingriff) { eingriff(); return; }
  if (eingriff) { const e = eingriff; eingriff = null; e(); }
}
pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  sqlLog.push(text);
  if (/^SELECT .* FROM plans WHERE project = \$1/i.test(text)) {
    return { rows: structuredClone(zeilen(params[0])), rowCount: zeilen(params[0]).length };
  }
  if (/^UPDATE plans SET name = \$1/i.test(text)) {
    const [name, description, goals, architecture, tasks, naechste, updated_at, id, alt] = params;
    feuereEingriff();
    const p = hole(id);
    if (!p || JSON.stringify(p.tasks) !== JSON.stringify(JSON.parse(alt))) return { rows: [], rowCount: 0 };
    Object.assign(p, { name, description, goals, architecture, tasks: JSON.parse(tasks), naechste_task_nr: naechste, updated_at });
    return { rows: [], rowCount: 1 };
  }
  // Verschieben: EIN Statement ueber alle betroffenen Plaene (alles oder nichts)
  if (/^WITH neu AS/i.test(text)) {
    const [ids, tasks, nrs, alts, jetzt, n] = params;
    assert.equal(ids.length, n, 'Anzahl Plaene im Statement stimmt mit $6 ueberein');
    feuereEingriff();
    const alleGleich = ids.every((id, i) => {
      const p = hole(id);
      return p && JSON.stringify(p.tasks) === JSON.stringify(JSON.parse(alts[i]));
    });
    if (!alleGleich) return { rows: [], rowCount: 0 };
    ids.forEach((id, i) => Object.assign(hole(id), { tasks: JSON.parse(tasks[i]), naechste_task_nr: nrs[i], updated_at: jetzt }));
    return { rows: [], rowCount: ids.length };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const core = await import('../packages/core/dist/index.js');
let indexAufrufe = [];
core.planIndex.sync = async (plan) => { indexAufrufe.push(plan); };

// ---------------------------------------------------------------------------
// 1. Verschieben einer Task
// ---------------------------------------------------------------------------
await pruefe('verschieben: Task per Kurz-ID -> Zielplan, neue Kurz-ID aus dem Zaehler des Ziels, Alias = alte ID', async () => {
  reset();
  const r = await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.verschoben.length, 1);
  assert.equal(r.verschoben[0].alt_kurz_id, 'P2-T1');
  assert.equal(r.verschoben[0].neu_kurz_id, 'P1-T2');
  const p1 = hole('plan-m1'); const p2 = hole('plan-m2');
  assert.equal(p2.tasks.length, 2, 'aus Quellplan entfernt');
  assert.equal(p1.tasks.length, 2, 'an Zielplan angehaengt');
  const t = p1.tasks[1];
  assert.equal(t.id, U(30), 'UUID bleibt');
  assert.equal(t.kurz_id, 'P1-T2');
  assert.deepEqual(t.alias_kurz_ids, ['P2-T1']);
  assert.equal(p1.naechste_task_nr, 3);
  assert.equal(p2.naechste_task_nr, 4, 'Zaehler der Quelle unveraendert (nie wiederverwendet)');
});

await pruefe('verschieben: Titel, Beschreibung, Status, Prioritaet, empfehlung, zugewiesen_an, createdAt und fremde Felder bleiben', async () => {
  reset();
  const vorher = structuredClone(hole('plan-m2').tasks[0]);
  await core.verschiebeTasks('multi', U(30), 'P3');
  const t = hole('plan-m3').tasks[0];
  for (const f of ['id', 'title', 'description', 'status', 'priority', 'empfehlung', 'zugewiesen_an', 'createdAt', 'eigenesFeld']) {
    assert.deepEqual(t[f], vorher[f], `Feld ${f} veraendert`);
  }
  assert.equal(t.kurz_id, 'P3-T1');
});

await pruefe('verschieben: Zielplan per UUID und per Kurz-ID gleichwertig; Zielplan-Namen in der Antwort', async () => {
  reset();
  const r = await core.verschiebeTasks('multi', ['P2-T2'], 'plan-m3');
  assert.equal(r.success, true);
  assert.equal(r.verschoben[0].neu_kurz_id, 'P3-T1');
  assert.equal(r.ziel.kurz_id, 'P3');
});

await pruefe('verschieben: mehrere Tasks (Array) in der angegebenen Reihenfolge, fortlaufend nummeriert', async () => {
  reset();
  const r = await core.verschiebeTasks('multi', ['P2-T3', 'P2-T1'], 'P3');
  assert.equal(r.success, true);
  assert.deepEqual(r.verschoben.map((v) => v.neu_kurz_id), ['P3-T1', 'P3-T2']);
  assert.deepEqual(hole('plan-m3').tasks.map((t) => t.id), [U(32), U(30)]);
  assert.equal(hole('plan-m3').naechste_task_nr, 3);
  assert.deepEqual(hole('plan-m2').tasks.map((t) => t.id), [U(31)]);
});

await pruefe('verschieben: Tasks aus zwei Quellplaenen in einem Aufruf, EIN Statement (atomar)', async () => {
  reset();
  const r = await core.verschiebeTasks('multi', ['P1-T1', 'P2-T2'], 'P3');
  assert.equal(r.success, true);
  assert.equal(hole('plan-m1').tasks.length, 0);
  assert.equal(hole('plan-m2').tasks.length, 2);
  assert.equal(hole('plan-m3').tasks.length, 2);
  const schreibend = sqlLog.filter((s) => /^(WITH|UPDATE|INSERT|DELETE)/i.test(s));
  assert.equal(schreibend.length, 1, `genau ein schreibendes Statement, war: ${schreibend.length}`);
  assert.match(schreibend[0], /^WITH neu AS/i);
  assert.ok(!sqlLog.some((s) => /^(BEGIN|COMMIT|ROLLBACK)/i.test(s)), 'keine Client-Transaktion');
});

await pruefe('verschieben: Index beider Plaene wird nachgezogen (Quelle und Ziel)', async () => {
  reset();
  indexAufrufe = [];
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  assert.deepEqual(indexAufrufe.map((p) => p.id).sort(), ['plan-m1', 'plan-m2']);
});

// ---------------------------------------------------------------------------
// 2. Alias-Aufloesung
// ---------------------------------------------------------------------------
await pruefe('Alias: updateTask mit ALTER Kurz-ID findet die verschobene Task (plan-uebergreifend)', async () => {
  reset();
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  const t = await core.updateTask('multi', 'P2-T1', { status: 'done' });
  assert.ok(t, 'Task ueber Alias nicht gefunden');
  assert.equal(t.id, U(30));
  assert.equal(t.kurz_id, 'P1-T2');
  assert.equal(t.plan_ref.kurz_id, 'P1');
  assert.equal(hole('plan-m1').tasks[1].status, 'done');
  assert.equal(hole('plan-m2').tasks.some((x) => x.id === U(30)), false);
});

await pruefe('Alias: neue Kurz-ID und UUID gehen weiter; Alias mit plan_id des Ziels ok, mit fremdem plan_id -> Fehler', async () => {
  reset();
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  assert.equal((await core.updateTask('multi', 'P1-T2', { priority: 'low' })).id, U(30));
  assert.equal((await core.updateTask('multi', U(30), { priority: 'high' })).id, U(30));
  assert.equal((await core.updateTask('multi', 'p2-t1', { priority: 'medium' }, 'P1')).id, U(30), 'Alias, Gross-/Kleinschreibung egal, mit Zielplan');
  await assert.rejects(() => core.updateTask('multi', 'P2-T1', { status: 'done' }, 'P3'), /P2-T1/);
});

await pruefe('Alias: deleteTasks ueber alte Kurz-ID loescht die verschobene Task', async () => {
  reset();
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  const r = await core.deleteTasks('multi', ['P2-T1']);
  assert.equal(r.deleted, 1);
  assert.equal(hole('plan-m1').tasks.some((x) => x.id === U(30)), false);
});

await pruefe('Alias: findeTaskInPlan im Zielplan loest die alte Kurz-ID auf', async () => {
  reset();
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  const plan = await core.getPlan('multi', 'P1');
  const t = core.findeTaskInPlan(plan, 'P2-T1');
  assert.equal(typeof t, 'object');
  assert.equal(t.id, U(30));
});

await pruefe('Alias: Nummern werden nie wiederverwendet — neue Task im Quellplan bekommt P2-T4, nicht P2-T1', async () => {
  reset();
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  const neu = await core.addTask('multi', 'Neu in P2', 'd', 'medium', 'P2');
  assert.equal(neu.kurz_id, 'P2-T4');
  assert.equal((await core.updateTask('multi', 'P2-T1', { title: 'via Alias' })).id, U(30), 'Alias zeigt weiter auf die verschobene Task');
});

await pruefe('Alias: zweimal verschieben sammelt beide alten IDs (P2-T1 -> P1-T2 -> P3-T1)', async () => {
  reset();
  await core.verschiebeTasks('multi', 'P2-T1', 'P1');
  await core.verschiebeTasks('multi', 'P2-T1', 'P3'); // ueber den Alias
  const t = hole('plan-m3').tasks[0];
  assert.equal(t.id, U(30));
  assert.equal(t.kurz_id, 'P3-T1');
  assert.deepEqual(t.alias_kurz_ids.sort(), ['P1-T2', 'P2-T1']);
  assert.equal((await core.updateTask('multi', 'P1-T2', { status: 'blocked' })).id, U(30));
});

// ---------------------------------------------------------------------------
// 3. Atomaritaet + Nebenlaeufigkeit + Fehler
// ---------------------------------------------------------------------------
await pruefe('Atomaritaet: unbekannte zweite Task -> Fehler, NICHTS geschrieben', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  const r = await core.verschiebeTasks('multi', ['P2-T1', 'P2-T99'], 'P3');
  assert.equal(r.success, false);
  assert.match(r.message, /P2-T99/);
  assert.deepEqual(PLAENE, vorher);
  assert.ok(!sqlLog.some((s) => /^(WITH|UPDATE)/i.test(s)), 'kein Schreibversuch');
});

await pruefe('Fehler: unbekannter Zielplan, fehlendes Ziel, leere task_id -> klare Meldung, nichts geschrieben', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  let r = await core.verschiebeTasks('multi', 'P2-T1', 'P9');
  assert.equal(r.success, false);
  assert.match(r.message, /P9/);
  assert.match(r.message, /P1/, 'Planliste in der Meldung');
  r = await core.verschiebeTasks('multi', 'P2-T1', '');
  assert.equal(r.success, false);
  assert.match(r.message, /ziel/i);
  r = await core.verschiebeTasks('multi', [], 'P3');
  assert.equal(r.success, false);
  assert.match(r.message, /task_id/);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('Fehler: Zielplan ohne Kurz-ID (Bestand vor dem Skript) -> Fehler, nichts geschrieben', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  const r = await core.verschiebeTasks('ohne', U(50), 'plan-o2');
  assert.equal(r.success, false);
  assert.match(r.message, /Kurz-ID/);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('Task schon im Zielplan -> uebersprungen, kein Schreiben, success', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  const r = await core.verschiebeTasks('multi', 'P2-T1', 'P2');
  assert.equal(r.success, true);
  assert.equal(r.verschoben.length, 0);
  assert.equal(r.uebersprungen.length, 1);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('Gleichzeitige Aenderung im Quellplan zwischen Lesen und Schreiben -> neu gelesen, fremde Aenderung bleibt', async () => {
  reset();
  eingriff = () => {
    const p = hole('plan-m2');
    p.tasks = [...p.tasks, task(U(99), 'Fremd', 'P2-T4')];
    p.naechste_task_nr = 5;
  };
  const r = await core.verschiebeTasks('multi', 'P2-T1', 'P3');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.ok(hole('plan-m2').tasks.some((x) => x.id === U(99)), 'fremde Task verloren');
  assert.equal(hole('plan-m2').tasks.some((x) => x.id === U(30)), false);
  assert.equal(hole('plan-m3').tasks[0].id, U(30));
  assert.equal(hole('plan-m2').naechste_task_nr, 5, 'fremder Zaehler bleibt');
});

await pruefe('Gleichzeitige Aenderung im ZIELplan -> Nummer aus dem neuen Zaehler, nichts doppelt vergeben', async () => {
  reset();
  eingriff = () => {
    const p = hole('plan-m3');
    p.tasks = [task(U(98), 'Fremd im Ziel', 'P3-T1')];
    p.naechste_task_nr = 2;
  };
  const r = await core.verschiebeTasks('multi', 'P2-T1', 'P3');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(hole('plan-m3').tasks.map((t) => t.kurz_id), ['P3-T1', 'P3-T2']);
  assert.equal(hole('plan-m3').tasks[1].id, U(30));
});

await pruefe('Dauerkonflikt (dreimal) -> Fehler, KEIN Teilzustand (weder Quelle noch Ziel geaendert)', async () => {
  reset();
  let n = 0;
  eingriffImmer = true;
  eingriff = () => { n++; const p = hole('plan-m2'); p.tasks = [...p.tasks, task(U(200 + n), `Fremd ${n}`, `P2-T${3 + n}`)]; };
  const r = await core.verschiebeTasks('multi', 'P2-T1', 'P3');
  assert.equal(r.success, false);
  assert.equal(hole('plan-m3').tasks.length, 0, 'Ziel unveraendert');
  assert.equal(hole('plan-m2').tasks.some((x) => x.id === U(30)), true, 'Task noch in der Quelle');
});

// ---------------------------------------------------------------------------
// 4. Rueckwaertskompatibilitaet
// ---------------------------------------------------------------------------
await pruefe('Einzelplan-Projekt: alte Aufrufe unveraendert, keine alias_kurz_ids an alten Tasks, verschieben ohne zweiten Plan -> Fehler', async () => {
  reset();
  const p = await core.getPlan('solo');
  assert.equal(p.tasks.length, 2);
  assert.ok(p.tasks.every((t) => !('alias_kurz_ids' in t)));
  const t = await core.updateTask('solo', 'P1-T2', { status: 'done' });
  assert.equal(t.id, U(2));
  assert.equal('alias_kurz_ids' in t, false);
  const vorher = structuredClone(PLAENE);
  const r = await core.verschiebeTasks('solo', 'P1-T1', 'P2');
  assert.equal(r.success, false);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('Ohne Alias-Treffer: unbekannte Kurz-ID -> null wie bisher; falscher plan_id -> Fehler wie bisher', async () => {
  reset();
  assert.equal(await core.updateTask('multi', 'P2-T99', { status: 'done' }), null);
  await assert.rejects(() => core.updateTask('multi', 'P1-T1', { status: 'done' }, 'P2'), /P1-T1/);
});

// ---------------------------------------------------------------------------
// 5. MCP-Tool
// ---------------------------------------------------------------------------
await pruefe('MCP plan-Tool: verschieben im enum, ziel im Schema, Aufruf verschiebt; Aufruf ohne ziel -> success:false', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const props = planTool.definition.inputSchema.properties;
  assert.ok(props.action.enum.includes('verschieben'), 'verschieben fehlt im enum');
  assert.ok(props.ziel, 'ziel fehlt im Schema');
  const r = await planTool.handler({ action: 'verschieben', project: 'multi', task_id: ['P2-T1'], ziel: 'P1' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.verschoben[0].neu_kurz_id, 'P1-T2');
  const f = await planTool.handler({ action: 'verschieben', project: 'multi', task_id: 'P2-T2' });
  assert.equal(f.success, false);
  const alt = await planTool.handler({ action: 'update_task', project: 'multi', task_id: 'P2-T1', status: 'done' });
  assert.equal(alt.success, true, 'Alias ueber das Tool');
  assert.equal(alt.task.id, U(30));
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
