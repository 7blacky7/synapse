#!/usr/bin/env node
// test-plan-prioritaeten.mjs — Plan-Prioritaeten hoch/mittel/niedrig (P3-T2).
//
// Geprueft: Standard mittel (auch bei Zeilen ohne die neue Spalte), Setzen ueber create/update
// (Parameter plan_prioritaet), Validierung, Sortierung in list und Onboarding-Uebersicht
// (aktiver Plan zuerst, dann hoch > mittel > niedrig, dann zuletzt geaendert), Prioritaet in
// den Antworten, keine Sperre/Transaktion, alte Aufrufe unveraendert.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt (plans-Tabelle im Speicher), Qdrant-Index gestubbt.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-plan-prioritaeten.mjs   (Exit 1 bei Fehler)

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
const task = (id, title, kurz, status = 'todo') => ({
  id, title, description: `${title} (Beschreibung)`, status, priority: 'medium',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', kurz_id: kurz,
});
const plan = (id, project, name, kurz, aktiv, updated, extra = {}) => ({
  id, project, name, description: `Ziel ${name}`, goals: [], architecture: null,
  tasks: [task(U(Number(kurz.slice(1)) * 10), `Task in ${name}`, `${kurz}-T1`)],
  created_at: '2026-03-01T00:00:00.000Z', updated_at: updated, kurz_id: kurz, aktiv, naechste_task_nr: 2,
  ...extra,
});

let PLAENE;
let sqlLog;
function reset() {
  PLAENE = [
    // Projekt "prio": Spalte prioritaet vorhanden
    plan('p-a', 'prio', 'A niedrig, neu', 'P1', false, '2026-09-28T00:00:00.000Z', { prioritaet: 'niedrig' }),
    plan('p-b', 'prio', 'B hoch, mittel alt', 'P2', false, '2026-09-10T00:00:00.000Z', { prioritaet: 'hoch' }),
    plan('p-c', 'prio', 'C aktiv, mittel', 'P3', true, '2026-08-01T00:00:00.000Z', { prioritaet: 'mittel' }),
    plan('p-d', 'prio', 'D hoch, aelter', 'P4', false, '2026-09-01T00:00:00.000Z', { prioritaet: 'hoch' }),
    plan('p-e', 'prio', 'E mittel, neuer', 'P5', false, '2026-09-20T00:00:00.000Z', { prioritaet: 'mittel' }),
    // Projekt "alt": Zeilen OHNE die Spalte (Feld fehlt bzw. null) — Zustand vor der Migration
    plan('a-1', 'alt', 'Alt eins', 'P1', false, '2026-03-15T06:57:00.000Z'),
    plan('a-2', 'alt', 'Alt zwei', 'P2', true, '2026-09-29T19:00:00.000Z', { prioritaet: null }),
    // Einzelplan-Projekt
    plan('s-1', 'solo', 'Solo', 'P1', true, '2026-01-02T00:00:00.000Z'),
    // Projekt zum Anlegen
    plan('n-1', 'neu', 'Erster', 'P1', true, '2026-01-02T00:00:00.000Z'),
  ];
  sqlLog = [];
}
reset();

const zeilen = (project) => PLAENE.filter((p) => p.project === project);
const hole = (id) => PLAENE.find((p) => p.id === id);
pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  sqlLog.push(text);
  if (/^SELECT .* FROM plans WHERE project = \$1/i.test(text)) {
    if (/prioritaet/i.test(text) === false) {
      // alte Abfrage ohne Spalte: Feld darf fehlen
      return { rows: structuredClone(zeilen(params[0])).map(({ prioritaet, ...r }) => r), rowCount: zeilen(params[0]).length };
    }
    return { rows: structuredClone(zeilen(params[0])), rowCount: zeilen(params[0]).length };
  }
  if (/^INSERT INTO plans/i.test(text)) {
    const [id, project, name, description, goals, architecture, tasks, created_at, updated_at, kurz_id, aktiv, naechste_task_nr, prioritaet] = params;
    PLAENE.push({ id, project, name, description, goals, architecture, tasks: JSON.parse(tasks), created_at, updated_at, kurz_id, aktiv, naechste_task_nr, ...(prioritaet !== undefined ? { prioritaet } : {}) });
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE plans SET prioritaet = \$1 WHERE id = \$2$/i.test(text)) {
    const p = hole(params[1]);
    if (!p) return { rows: [], rowCount: 0 };
    p.prioritaet = params[0];
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE plans SET aktiv = \(id = \$2\) WHERE project = \$1/i.test(text)) {
    for (const p of zeilen(params[0])) p.aktiv = p.id === params[1];
    return { rows: [], rowCount: zeilen(params[0]).length };
  }
  if (/^UPDATE plans SET name = \$1/i.test(text)) {
    const [name, description, goals, architecture, tasks, naechste, updated_at, id, alt] = params;
    const p = hole(id);
    if (!p || JSON.stringify(p.tasks) !== JSON.stringify(JSON.parse(alt))) return { rows: [], rowCount: 0 };
    Object.assign(p, { name, description, goals, architecture, tasks: JSON.parse(tasks), naechste_task_nr: naechste, updated_at });
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const core = await import('../packages/core/dist/index.js');
let indexAufrufe = [];
core.planIndex.sync = async (p) => { indexAufrufe.push(p); };

// ---------------------------------------------------------------------------
// 1. Standard + Lesen
// ---------------------------------------------------------------------------
await pruefe('Standard: Zeile ohne Spalte / mit null -> prioritaet "mittel"; vorhandener Wert kommt durch', async () => {
  reset();
  assert.equal((await core.getPlan('alt', 'P1')).prioritaet, 'mittel');
  assert.equal((await core.getPlan('alt', 'P2')).prioritaet, 'mittel');
  assert.equal((await core.getPlan('prio', 'P2')).prioritaet, 'hoch');
  assert.equal((await core.getPlan('solo')).prioritaet, 'mittel');
});

// ---------------------------------------------------------------------------
// 2. Setzen: create + update
// ---------------------------------------------------------------------------
await pruefe('create: ohne Prioritaet -> mittel; mit "hoch" -> hoch gespeichert und in der Antwort', async () => {
  reset();
  const a = await core.createPlan('neu', 'Zweiter', 'Ziel');
  assert.equal(a.prioritaet, 'mittel');
  const b = await core.createPlan('neu', 'Dritter', 'Ziel', [], { prioritaet: 'hoch' });
  assert.equal(b.prioritaet, 'hoch');
  assert.equal(hole(b.id).prioritaet, 'hoch');
});

await pruefe('create: ungueltige Prioritaet -> Fehler, nichts angelegt', async () => {
  reset();
  const n = PLAENE.length;
  await assert.rejects(() => core.createPlan('neu', 'X', 'Ziel', [], { prioritaet: 'dringend' }), /prioritaet/i);
  assert.equal(PLAENE.length, n);
});

await pruefe('update: Prioritaet eines INAKTIVEN Plans aenderbar; nur EIN Statement, kein Sperren, updated_at/Tasks unveraendert', async () => {
  reset();
  const vorher = structuredClone(hole('p-a'));
  sqlLog = [];
  const r = await core.updatePlan('prio', { prioritaet: 'hoch' }, 'P1');
  assert.equal(r.prioritaet, 'hoch');
  assert.equal(hole('p-a').prioritaet, 'hoch');
  assert.equal(hole('p-a').updated_at, vorher.updated_at, 'updated_at darf sich nicht aendern (sonst wandert der effektiv aktive Plan)');
  assert.deepEqual(hole('p-a').tasks, vorher.tasks);
  const schreibend = sqlLog.filter((s) => /^(UPDATE|INSERT|DELETE|WITH)/i.test(s));
  assert.equal(schreibend.length, 1, `genau ein schreibendes Statement, war ${schreibend.length}`);
  assert.ok(!sqlLog.some((s) => /^(BEGIN|COMMIT|ROLLBACK)|FOR UPDATE/i.test(s)), 'keine Sperre');
});

await pruefe('update: Prioritaet + Name am AKTIVEN Plan zusammen; Index wird nachgezogen', async () => {
  reset();
  indexAufrufe = [];
  const r = await core.updatePlan('prio', { name: 'C neu', prioritaet: 'niedrig' }, 'P3');
  assert.equal(r.name, 'C neu');
  assert.equal(r.prioritaet, 'niedrig');
  assert.equal(hole('p-c').prioritaet, 'niedrig');
  assert.ok(indexAufrufe.some((p) => p.id === 'p-c' && p.prioritaet === 'niedrig'), 'Index nicht mit neuer Prioritaet nachgezogen');
});

await pruefe('update: Prioritaet ohne planRef wirkt auf den aktiven Plan', async () => {
  reset();
  const r = await core.updatePlan('prio', { prioritaet: 'hoch' });
  assert.equal(r.id, 'p-c');
  assert.equal(hole('p-c').prioritaet, 'hoch');
});

await pruefe('update: Name am INAKTIVEN Plan bleibt verboten (wie bisher); mit Prioritaet zusammen nichts geschrieben', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  await assert.rejects(() => core.updatePlan('prio', { name: 'x' }, 'P1'), /nicht aktiv/);
  await assert.rejects(() => core.updatePlan('prio', { name: 'x', prioritaet: 'hoch' }, 'P1'), /nicht aktiv/);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('update: ungueltige Prioritaet -> Fehler, nichts geschrieben', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  await assert.rejects(() => core.updatePlan('prio', { prioritaet: 'sehr-hoch' }, 'P1'), /prioritaet/i);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('update: Gross-/Kleinschreibung und Leerraum werden normalisiert ("Hoch " -> hoch)', async () => {
  reset();
  const r = await core.updatePlan('prio', { prioritaet: ' Hoch ' }, 'P1');
  assert.equal(r.prioritaet, 'hoch');
});

await pruefe('Alt-Aufruf: update ohne Prioritaet schreibt KEIN prioritaet-Statement, Prioritaet bleibt', async () => {
  reset();
  sqlLog = [];
  const r = await core.updatePlan('prio', { description: 'neu' });
  assert.equal(r.description, 'neu');
  assert.equal(r.prioritaet, 'mittel');
  assert.ok(!sqlLog.some((s) => /prioritaet = \$1/i.test(s)), 'unnoetiges prioritaet-Statement');
});

// ---------------------------------------------------------------------------
// 3. Sortierung list + Onboarding
// ---------------------------------------------------------------------------
await pruefe('list: aktiver Plan zuerst, dann hoch > mittel > niedrig, dann zuletzt geaendert; Antwort nennt die Prioritaet', async () => {
  reset();
  const l = await core.listPlans('prio');
  assert.deepEqual(l.map((x) => x.kurz_id), ['P3', 'P2', 'P4', 'P5', 'P1']);
  assert.deepEqual(l.map((x) => x.prioritaet), ['mittel', 'hoch', 'hoch', 'mittel', 'niedrig']);
  assert.equal(l[0].aktiv, true);
});

await pruefe('list: Projekt ohne Spalte -> alle mittel, aktiver zuerst, sonst zuletzt geaendert', async () => {
  reset();
  const l = await core.listPlans('alt');
  assert.deepEqual(l.map((x) => [x.kurz_id, x.prioritaet, x.aktiv]), [['P2', 'mittel', true], ['P1', 'mittel', false]]);
});

await pruefe('list: Einzelplan-Projekt unveraendert (ein Eintrag, alte Felder da)', async () => {
  reset();
  const l = await core.listPlans('solo');
  assert.equal(l.length, 1);
  for (const f of ['id', 'kurz_id', 'name', 'ziel', 'aktiv', 'tasks_gesamt', 'tasks_offen', 'tasks_erledigt', 'created_at', 'updated_at']) {
    assert.ok(f in l[0], `Feld ${f} fehlt`);
  }
});

await pruefe('Onboarding: planUebersicht gleich sortiert, nennt prioritaet, nur aktive/offene Plaene', async () => {
  reset();
  hole('p-e').tasks[0].status = 'done'; // E hat nichts mehr offen und ist nicht aktiv -> raus
  const u = await core.planUebersicht('prio');
  assert.deepEqual(u.map((x) => x.kurz_id), ['P3', 'P2', 'P4', 'P1']);
  assert.deepEqual(u.map((x) => x.prioritaet), ['mittel', 'hoch', 'hoch', 'niedrig']);
  for (const f of ['kurz_id', 'name', 'aktiv', 'offen', 'gesamt']) assert.ok(f in u[0], `Feld ${f} fehlt`);
});

await pruefe('Sortierung aendert sich mit der Prioritaet: A auf hoch -> vor B/D nach neuestem Stand', async () => {
  reset();
  await core.updatePlan('prio', { prioritaet: 'hoch' }, 'P1');
  const l = await core.listPlans('prio');
  assert.deepEqual(l.map((x) => x.kurz_id), ['P3', 'P1', 'P2', 'P4', 'P5']);
});

// ---------------------------------------------------------------------------
// 4. MCP-Tool
// ---------------------------------------------------------------------------
await pruefe('MCP plan-Tool: plan_prioritaet im Schema (enum), create/update/list verdrahtet, ungueltiger Wert -> success:false', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const props = planTool.definition.inputSchema.properties;
  assert.ok(props.plan_prioritaet, 'plan_prioritaet fehlt im Schema');
  assert.deepEqual([...props.plan_prioritaet.enum].sort(), ['hoch', 'mittel', 'niedrig']);
  assert.ok(props.priority.enum.includes('high'), 'Task-priority bleibt unveraendert');

  const c = await planTool.handler({ action: 'create', project: 'neu', name: 'Tool-Plan', description: 'd', plan_prioritaet: 'niedrig' });
  assert.equal(c.success, true, JSON.stringify(c));
  assert.equal(c.plan.prioritaet, 'niedrig');

  const u = await planTool.handler({ action: 'update', project: 'prio', plan_id: 'P1', plan_prioritaet: 'hoch' });
  assert.equal(u.success, true, JSON.stringify(u));
  assert.equal(u.plan.prioritaet, 'hoch');

  const l = await planTool.handler({ action: 'list', project: 'prio' });
  assert.equal(l.success, true);
  assert.equal(l.plaene[0].kurz_id, 'P3', 'aktiver zuerst');
  assert.equal(l.plaene[1].prioritaet, 'hoch');

  const f = await planTool.handler({ action: 'update', project: 'prio', plan_id: 'P2', plan_prioritaet: 'kaputt' });
  assert.equal(f.success, false);
  assert.match(String(f.message), /prioritaet/i);
});

await pruefe('MCP plan-Tool: Task-priority und Plan-Prioritaet kollidieren nicht (add_task priority high, Plan bleibt mittel)', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const r = await planTool.handler({ action: 'add_task', project: 'solo', title: 'T', description: 'd', priority: 'high' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.task.priority, 'high');
  assert.equal((await core.getPlan('solo')).prioritaet, 'mittel');
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
