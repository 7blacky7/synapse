#!/usr/bin/env node
// test-plan-einordnen.mjs — plan(action:'einordnen'): Jev ordnet Tasks dem passenden Plan zu (P7-T20).
//
//   1. Request-Form: state {project, tasks:[{i,title,description}]}, je Task choice plan_<i>,
//      criteria je Plan (Kurz-ID -> "Name: Beschreibung"), Titel 160 / Beschreibung 400 Zeichen.
//   2. > 50 Tasks = mehrere Jev-Aufrufe (Bloecke a 50), Ergebnis in Reihenfolge.
//   3. Confidence-Tor: darunter unsicher; unbekannte choice = unsicher, nicht geraten.
//   4. verschieben:false (Standard) verschiebt nichts; true nur sicher + anderer Plan,
//      gruppiert je Ziel, "bleibt" wird uebersprungen.
//   5. ziele-Filter, unbekanntes Ziel -> Fehler; Limit 200; Pflichtfelder.
//   6. Key fehlt / HTTP-Fehler / Timeout -> success:false, nichts verschoben, Key nie im Ergebnis.
//
// OHNE echte DB und OHNE echten Jev: Plan-Zugriff, verschiebeTasks und fetch sind gemockt.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-plan-einordnen.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
delete process.env.JEV_OPENROUTER_API_KEY;
delete process.env.JEV_API_URL;
delete process.env.JEV_MODELL;
delete process.env.JEV_TIMEOUT_MS;

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

const KEY = 'sk-or-test-GEHEIM-0123456789';
const mod = await import('../packages/core/dist/services/plan-einordnen.js');
const core = await import('../packages/core/dist/index.js');
const { ordneTasksEin } = mod;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const task = (n, extra = {}) => ({
  id: `t${n}`, kurz_id: `P1-T${n}`, title: `Task ${n}`, description: `Beschreibung ${n}`,
  status: 'todo', priority: 'medium', createdAt: 'x', updatedAt: 'x', ...extra,
});
function plaene(anzahlTasks = 4) {
  return [
    { id: 'u1', kurz_id: 'P1', name: 'Quelle', description: 'Sammelplan', goals: [], architecture: '', aktiv: true,
      tasks: Array.from({ length: anzahlTasks }, (_, i) => task(i + 1)) },
    { id: 'u2', kurz_id: 'P2', name: 'Parser', description: 'Parser und Index', goals: [], architecture: '', aktiv: false, tasks: [] },
    { id: 'u3', kurz_id: 'P3', name: 'Suche', description: 'Embedding und Suche', goals: [], architecture: '', aktiv: false, tasks: [] },
  ];
}

let fetchAufrufe = [];
let antwortFuer;
function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  fetchAufrufe.push({ url, init, body });
  return Promise.resolve(new Response(JSON.stringify({
    answers: antwortFuer(body),
    usage: { input_tokens: 100, cost: 0.001 },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
}
/** je[i] = [choice, confidence] (i = Index im gesamten Aufruf, Block wird ueber offset umgerechnet) */
function antworten(je, blockGroesse = 50) {
  let block = 0;
  return (body) => {
    const offset = block++ * blockGroesse;
    const a = {};
    for (const name of Object.keys(body.questions)) {
      const i = Number(/^plan_(\d+)$/.exec(name)[1]);
      const [choice, confidence] = je[offset + i] ?? ['P1', 0.9];
      a[name] = { type: 'choice', choice, confidence };
    }
    return a;
  };
}

let verschiebeAufrufe = [];
let verschiebeErgebnis;
const deps = (p = plaene()) => ({
  fetch: fakeFetch,
  getPlan: async (_project, ref) => {
    const z = p.find((x) => x.id === ref || x.kurz_id === ref);
    if (!z) throw new Error(`Plan nicht gefunden: ${ref}`);
    return z;
  },
  getAllePlaene: async () => p,
  verschiebeTasks: async (project, ids, ziel) => {
    verschiebeAufrufe.push({ project, ids, ziel });
    return verschiebeErgebnis
      ? verschiebeErgebnis(ids, ziel)
      : { success: true, verschoben: ids.map((id) => ({ id, title: '', alt_kurz_id: null, neu_kurz_id: `${ziel}-T9`, von_plan: 'P1' })), uebersprungen: [] };
  },
});

function reset() {
  fetchAufrufe = [];
  verschiebeAufrufe = [];
  verschiebeErgebnis = undefined;
  antwortFuer = antworten({});
  process.env.JEV_OPENROUTER_API_KEY = KEY;
  delete process.env.JEV_TIMEOUT_MS;
}
const einordnen = (opt, d) => ordneTasksEin('testprojekt', { plan_id: 'P1', task_ids: ['t1', 't2', 't3', 't4'], ...opt }, d ?? deps());

await pruefe('Export: ordneTasksEin ist ueber @synapse/core erreichbar', () => {
  assert.equal(typeof core.ordneTasksEin, 'function');
  assert.equal(core.EINORDNEN_MAX_TASKS, 200);
  assert.equal(core.EINORDNEN_BLOCK, 50);
});

// 1. Request-Form ------------------------------------------------------------
await pruefe('Request: state + Frage plan_<i> + criteria je Plan, Auth-Header', async () => {
  reset();
  const p = plaene();
  p[0].tasks[0].title = 'T'.repeat(300);
  p[0].tasks[0].description = 'D'.repeat(900);
  const r = await einordnen({}, deps(p));
  assert.equal(r.success, true);
  assert.equal(fetchAufrufe.length, 1);
  const { body, init } = fetchAufrufe[0];
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(body.state.project, 'testprojekt');
  assert.equal(body.state.tasks.length, 4);
  assert.deepEqual(Object.keys(body.state.tasks[1]).sort(), ['description', 'i', 'title']);
  assert.ok(body.state.tasks[0].title.length <= 160);
  assert.ok(body.state.tasks[0].description.length <= 400);
  assert.deepEqual(Object.keys(body.questions).sort(), ['plan_0', 'plan_1', 'plan_2', 'plan_3']);
  const q = body.questions.plan_0;
  assert.equal(q.type, 'choice');
  assert.match(q.instructions, /task 0 in the state/);
  assert.deepEqual(Object.keys(q.criteria).sort(), ['P1', 'P2', 'P3']);
  assert.match(q.criteria.P2, /^Parser: Parser und Index/);
});

// 2. Bloecke -------------------------------------------------------------------
await pruefe('>50 Tasks: mehrere Jev-Aufrufe (120 -> 3 Bloecke), Reihenfolge stimmt', async () => {
  reset();
  const p = plaene(120);
  const je = {};
  je[0] = ['P2', 0.9]; je[55] = ['P3', 0.9]; je[119] = ['P2', 0.8];
  antwortFuer = antworten(je);
  const ids = p[0].tasks.map((t) => t.id);
  const r = await einordnen({ task_ids: ids }, deps(p));
  assert.equal(r.success, true);
  assert.equal(fetchAufrufe.length, 3);
  assert.deepEqual(fetchAufrufe.map((a) => a.body.state.tasks.length), [50, 50, 20]);
  assert.equal(r.ergebnisse.length, 120);
  assert.equal(r.ergebnisse[0].vorschlag, 'P2');
  assert.equal(r.ergebnisse[55].vorschlag, 'P3');
  assert.equal(r.ergebnisse[119].vorschlag, 'P2');
  assert.equal(r.zusammenfassung.aufrufe, 3);
  assert.equal(r.zusammenfassung.je_plan.P2, 2);
  assert.ok(Math.abs(r.zusammenfassung.cost - 0.003) < 1e-9);
  assert.equal(r.zusammenfassung.input_tokens, 300);
});

// 3. Tor + unbekannte choice ----------------------------------------------------
await pruefe('Tor: confidence unter Tor = unsicher; eigenes confidence_tor wirkt', async () => {
  reset();
  antwortFuer = antworten({ 0: ['P2', 0.4], 1: ['P2', 0.6] });
  let r = await einordnen({});
  assert.equal(r.ergebnisse[0].unsicher, true);
  assert.equal(r.ergebnisse[1].unsicher, false);
  assert.equal(r.confidence_tor, 0.5);
  reset();
  antwortFuer = antworten({ 0: ['P2', 0.4], 1: ['P2', 0.6] });
  r = await einordnen({ confidence_tor: 0.7 });
  assert.equal(r.ergebnisse[1].unsicher, true);
  assert.equal(r.confidence_tor, 0.7);
});

await pruefe('unbekannte choice: unsicher, vorschlag null, nicht geraten, nie verschoben', async () => {
  reset();
  antwortFuer = antworten({ 0: ['P99', 0.99], 1: ['Quatsch', 0.99] });
  const r = await einordnen({ verschieben: true });
  assert.equal(r.ergebnisse[0].vorschlag, null);
  assert.equal(r.ergebnisse[0].unsicher, true);
  assert.ok(r.ergebnisse[0].hinweis);
  assert.equal(r.ergebnisse[1].unsicher, true);
  assert.ok(!verschiebeAufrufe.some((v) => v.ids.includes('t1') || v.ids.includes('t2')));
});

// 4. Verschieben ------------------------------------------------------------------
await pruefe('verschieben:false (Standard) verschiebt nichts', async () => {
  reset();
  antwortFuer = antworten({ 0: ['P2', 0.9], 1: ['P3', 0.9] });
  const r = await einordnen({});
  assert.equal(r.verschieben, false);
  assert.equal(verschiebeAufrufe.length, 0);
  assert.equal(r.zusammenfassung.verschoben, 0);
  assert.ok(r.ergebnisse.every((z) => z.verschoben === undefined));
});

await pruefe('verschieben:true: gruppiert je Ziel, ueberspringt "bleibt" und unsichere', async () => {
  reset();
  // t1,t3 -> P2; t2 -> P3; t4 bleibt (P1); t5 -> P2 aber unsicher
  const p = plaene(5);
  antwortFuer = antworten({ 0: ['P2', 0.9], 1: ['P3', 0.9], 2: ['P2', 0.8], 3: ['P1', 0.95], 4: ['P2', 0.3] });
  const ids = p[0].tasks.map((t) => t.id);
  const r = await einordnen({ task_ids: ids, verschieben: true }, deps(p));
  assert.equal(r.success, true);
  assert.equal(verschiebeAufrufe.length, 2);
  const p2 = verschiebeAufrufe.find((v) => v.ziel === 'P2');
  const p3 = verschiebeAufrufe.find((v) => v.ziel === 'P3');
  assert.deepEqual(p2.ids, ['t1', 't3']);
  assert.deepEqual(p3.ids, ['t2']);
  assert.equal(r.zusammenfassung.verschoben, 3);
  assert.equal(r.zusammenfassung.bleibt, 1);
  assert.equal(r.zusammenfassung.unsicher, 1);
  assert.equal(r.ergebnisse[0].verschoben, true);
  assert.equal(r.ergebnisse[3].verschoben, undefined);
  assert.equal(r.ergebnisse[4].verschoben, undefined);
});

await pruefe('verschieben: Fehler einer Gruppe wird gemeldet, andere Gruppen laufen weiter', async () => {
  reset();
  antwortFuer = antworten({ 0: ['P2', 0.9], 1: ['P3', 0.9] });
  verschiebeErgebnis = (ids, ziel) => (ziel === 'P2'
    ? { success: false, message: 'kaputt', verschoben: [], uebersprungen: [] }
    : { success: true, verschoben: ids.map((id) => ({ id, title: '', alt_kurz_id: null, neu_kurz_id: null, von_plan: null })), uebersprungen: [] });
  const r = await einordnen({ verschieben: true });
  assert.equal(r.success, true);
  assert.equal(r.zusammenfassung.verschoben, 1);
  assert.equal(r.hinweise.length, 1);
  assert.match(r.hinweise[0], /P2.*kaputt/);
  assert.equal(r.ergebnisse[0].verschoben, undefined);
  assert.equal(r.ergebnisse[1].verschoben, true);
});

// 5. ziele + Pflichtfelder --------------------------------------------------------
await pruefe('ziele-Filter: nur genannte Plaene in criteria; unbekanntes Ziel -> Fehler', async () => {
  reset();
  const r = await einordnen({ ziele: ['P2', 'u3'] });
  assert.equal(r.success, true);
  assert.deepEqual(Object.keys(fetchAufrufe[0].body.questions.plan_0.criteria).sort(), ['P2', 'P3']);
  reset();
  const f = await einordnen({ ziele: ['P2', 'P77'] });
  assert.equal(f.success, false);
  assert.match(f.message, /P77/);
  assert.equal(fetchAufrufe.length, 0);
});

await pruefe('Pflichtfelder und Limit 200', async () => {
  reset();
  let r = await ordneTasksEin('testprojekt', { task_ids: ['t1'] }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /plan_id/);
  r = await ordneTasksEin('testprojekt', { plan_id: 'P1' }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /task_id/);
  r = await ordneTasksEin('testprojekt', { plan_id: 'P1', task_ids: Array.from({ length: 201 }, (_, i) => `x${i}`) }, deps());
  assert.equal(r.success, false);
  assert.match(r.message, /200/);
  r = await einordnen({ task_ids: ['t1', 'gibtsnicht'] });
  assert.equal(r.success, false);
  assert.match(r.message, /gibtsnicht/);
  assert.equal(fetchAufrufe.length, 0);
});

// 6. Fehlerpfade ---------------------------------------------------------------------
await pruefe('fehlender Key: success:false mit Hinweis, kein Jev-Aufruf', async () => {
  reset();
  delete process.env.JEV_OPENROUTER_API_KEY;
  const r = await einordnen({ verschieben: true });
  assert.equal(r.success, false);
  assert.match(r.message, /JEV_OPENROUTER_API_KEY/);
  assert.equal(fetchAufrufe.length, 0);
  assert.equal(verschiebeAufrufe.length, 0);
});

await pruefe('HTTP-Fehler: success:false, nichts verschoben, Key nicht im Ergebnis', async () => {
  reset();
  const d = deps();
  d.fetch = () => Promise.resolve(new Response(`Unauthorized ${KEY}`, { status: 401 }));
  const r = await einordnen({ verschieben: true }, d);
  assert.equal(r.success, false);
  assert.match(r.message, /HTTP 401/);
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.equal(verschiebeAufrufe.length, 0);
});

await pruefe('Timeout: success:false, nichts verschoben', async () => {
  reset();
  process.env.JEV_TIMEOUT_MS = '20';
  const d = deps();
  d.fetch = (_url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(new Error('aborted')));
  });
  const r = await einordnen({ verschieben: true }, d);
  assert.equal(r.success, false);
  assert.match(r.message, /Timeout/);
  assert.equal(verschiebeAufrufe.length, 0);
});

await pruefe('Antwort ohne Key im Ergebnis (Erfolgsfall)', async () => {
  reset();
  const r = await einordnen({});
  assert.ok(!JSON.stringify(r).includes(KEY));
});

console.log(`\n${ok} OK, ${fehler} Fehler`);
process.exit(fehler > 0 ? 1 : 0);
