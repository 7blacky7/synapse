#!/usr/bin/env node
// test-plan-zurueckstellen.mjs — Wiedervorlage fuer Plaene: plan(zurueckstellen, plan_id, tage|bis) (P3-T3).
//
// Geprueft: Setzen ueber tage/bis, Aufheben mit tage:0, aktiver Plan nicht zurueckstellbar,
// Validierung, list/Onboarding blenden bis zum Datum aus, list(alle:true) zeigt mit Vermerk,
// Zeitgrenze (bis == jetzt ist wieder sichtbar), "wieder vorgelegt seit", get mit plan_id
// funktioniert immer, ein Statement ohne Sperre, alte Aufrufe/Antwortformen unveraendert.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt (plans-Tabelle im Speicher), Qdrant-Index gestubbt.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-plan-zurueckstellen.mjs   (Exit 1 bei Fehler)

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
    plan('z-1', 'zs', 'Aktiv', 'P1', true, '2026-09-28T00:00:00.000Z'),
    plan('z-2', 'zs', 'Normal', 'P2', false, '2026-09-27T00:00:00.000Z'),
    plan('z-3', 'zs', 'Schlaeft noch', 'P3', false, '2026-09-26T00:00:00.000Z', { zurueckgestellt_bis: inTagen(5) }),
    plan('z-4', 'zs', 'Wieder da', 'P4', false, '2026-09-25T00:00:00.000Z', { zurueckgestellt_bis: inTagen(-3) }),
    plan('z-5', 'zs', 'Genau jetzt', 'P5', false, '2026-09-24T00:00:00.000Z', { zurueckgestellt_bis: JETZT.toISOString() }),
    plan('z-6', 'zs', 'Eine ms davor', 'P6', false, '2026-09-23T00:00:00.000Z', { zurueckgestellt_bis: new Date(JETZT.getTime() + 1).toISOString() }),
    // Projekt ohne die neue Spalte (Zustand vor der Migration): Feld fehlt
    plan('a-1', 'alt', 'Alt eins', 'P1', true, '2026-03-15T06:57:00.000Z'),
    plan('a-2', 'alt', 'Alt zwei', 'P2', false, '2026-03-14T06:57:00.000Z'),
    // Einzelplan
    plan('s-1', 'solo', 'Solo', 'P1', true, '2026-01-02T00:00:00.000Z'),
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
    const rows = structuredClone(zeilen(params[0]));
    if (!/zurueckgestellt_bis/i.test(text)) rows.forEach((r) => delete r.zurueckgestellt_bis); // alte Abfrage
    return { rows, rowCount: rows.length };
  }
  if (/^UPDATE plans SET zurueckgestellt_bis = \$1 WHERE id = \$2$/i.test(text)) {
    const p = hole(params[1]);
    if (!p) return { rows: [], rowCount: 0 };
    p.zurueckgestellt_bis = params[0];
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

const kurz = (l) => l.map((x) => x.kurz_id);

// ---------------------------------------------------------------------------
// 1. Setzen / Aufheben
// ---------------------------------------------------------------------------
await pruefe('zurueckstellen tage:7: bis = jetzt + 7 Tage; EIN schreibendes Statement, keine Sperre, updated_at/Tasks unveraendert', async () => {
  reset();
  const vorher = structuredClone(hole('z-2'));
  const r = await core.zurueckstellePlan('zs', 'P2', { tage: 7 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(new Date(r.zurueckgestellt_bis).getTime(), JETZT.getTime() + 7 * TAG);
  assert.equal(new Date(hole('z-2').zurueckgestellt_bis).getTime(), JETZT.getTime() + 7 * TAG);
  assert.equal(hole('z-2').updated_at, vorher.updated_at);
  assert.deepEqual(hole('z-2').tasks, vorher.tasks);
  const schreibend = sqlLog.filter((s) => /^(UPDATE|INSERT|DELETE|WITH)/i.test(s));
  assert.equal(schreibend.length, 1, `genau ein schreibendes Statement, war ${schreibend.length}`);
  assert.ok(!sqlLog.some((s) => /^(BEGIN|COMMIT|ROLLBACK)|FOR UPDATE/i.test(s)), 'keine Sperre');
  assert.equal(r.plan_ref.kurz_id, 'P2');
});

await pruefe('zurueckstellen bis: <ISO-Datum>; Qdrant-Index wird mit zurueckgestellt_bis nachgezogen', async () => {
  reset();
  indexAufrufe = [];
  const ziel = inTagen(10);
  const r = await core.zurueckstellePlan('zs', 'P2', { bis: ziel }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(new Date(r.zurueckgestellt_bis).getTime(), new Date(ziel).getTime());
  assert.ok(indexAufrufe.some((p) => p.id === 'z-2' && p.zurueckgestellt_bis), 'Index nicht nachgezogen');
});

await pruefe('zurueckstellen bis nur mit Datum (2026-10-15) wird akzeptiert', async () => {
  reset();
  const r = await core.zurueckstellePlan('zs', 'P2', { bis: '2026-10-15' }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(new Date(r.zurueckgestellt_bis).toISOString().slice(0, 10), '2026-10-15');
});

await pruefe('tage:0 hebt die Wiedervorlage auf (NULL), Plan erscheint sofort wieder in list', async () => {
  reset();
  const r = await core.zurueckstellePlan('zs', 'P3', { tage: 0 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.zurueckgestellt_bis, null);
  assert.equal(hole('z-3').zurueckgestellt_bis, null);
  const l = await core.listPlans('zs', { jetzt: JETZT });
  assert.ok(kurz(l).includes('P3'));
  assert.equal(l.find((x) => x.kurz_id === 'P3').wieder_vorgelegt_seit, undefined, 'nach Aufheben kein Vermerk');
});

await pruefe('Der AKTIVE Plan kann nicht zurueckgestellt werden: klarer Fehler, nichts geschrieben (auch ohne plan_id)', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  const a = await core.zurueckstellePlan('zs', 'P1', { tage: 3 }, JETZT);
  assert.equal(a.success, false);
  assert.match(a.message, /aktiv/i);
  const b = await core.zurueckstellePlan('zs', undefined, { tage: 3 }, JETZT);
  assert.equal(b.success, false);
  assert.match(b.message, /aktiv/i);
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('Validierung: negative/kaputte tage, tage+bis zusammen, weder noch, bis in der Vergangenheit, kaputtes bis, unbekannter Plan -> success:false, nichts geschrieben', async () => {
  reset();
  const vorher = structuredClone(PLAENE);
  const faelle = [
    ['P2', { tage: -1 }],
    ['P2', { tage: 'abc' }],
    ['P2', { tage: Number.NaN }],
    ['P2', { tage: 100000 }],
    ['P2', { tage: 3, bis: inTagen(3) }],
    ['P2', {}],
    ['P2', { bis: inTagen(-1) }],
    ['P2', { bis: 'gestern-ish' }],
    ['P99', { tage: 3 }],
  ];
  for (const [ref, opt] of faelle) {
    const r = await core.zurueckstellePlan('zs', ref, opt, JETZT);
    assert.equal(r.success, false, `${ref} ${JSON.stringify(opt)} haette scheitern muessen`);
    assert.ok(typeof r.message === 'string' && r.message.length > 5);
  }
  assert.deepEqual(PLAENE, vorher);
});

await pruefe('Zurueckgestellter Plan kann neu zurueckgestellt (verlaengert) werden', async () => {
  reset();
  const r = await core.zurueckstellePlan('zs', 'P3', { tage: 30 }, JETZT);
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(new Date(hole('z-3').zurueckgestellt_bis).getTime(), JETZT.getTime() + 30 * TAG);
});

// ---------------------------------------------------------------------------
// 2. Sichtbarkeit: list + Onboarding
// ---------------------------------------------------------------------------
await pruefe('list (Standard) blendet Plaene mit zurueckgestellt_bis in der Zukunft aus (P3, P6); Abgelaufene (P4) und Grenze (P5) bleiben', async () => {
  reset();
  const l = await core.listPlans('zs', { jetzt: JETZT });
  assert.deepEqual(kurz(l).sort(), ['P1', 'P2', 'P4', 'P5']);
});

await pruefe('Zeitgrenze: bis == jetzt ist wieder sichtbar, bis = jetzt + 1 ms noch ausgeblendet', async () => {
  reset();
  const l = await core.listPlans('zs', { jetzt: JETZT });
  assert.ok(kurz(l).includes('P5'));
  assert.ok(!kurz(l).includes('P6'));
  const spaeter = await core.listPlans('zs', { jetzt: new Date(JETZT.getTime() + 1) });
  assert.ok(kurz(spaeter).includes('P6'));
});

await pruefe('Abgelaufene Wiedervorlage: Eintrag traegt wieder_vorgelegt_seit = altes Datum; noch zurueckgestellte haben das Feld nicht', async () => {
  reset();
  const l = await core.listPlans('zs', { jetzt: JETZT });
  const p4 = l.find((x) => x.kurz_id === 'P4');
  assert.equal(new Date(p4.wieder_vorgelegt_seit).getTime(), JETZT.getTime() - 3 * TAG);
  const p5 = l.find((x) => x.kurz_id === 'P5');
  assert.equal(new Date(p5.wieder_vorgelegt_seit).getTime(), JETZT.getTime());
  assert.equal(l.find((x) => x.kurz_id === 'P2').wieder_vorgelegt_seit, undefined);
});

await pruefe('list(alle:true) zeigt auch zurueckgestellte, mit Vermerk zurueckgestellt:true + zurueckgestellt_bis', async () => {
  reset();
  const l = await core.listPlans('zs', { alle: true, jetzt: JETZT });
  assert.equal(l.length, 6);
  const p3 = l.find((x) => x.kurz_id === 'P3');
  assert.equal(p3.zurueckgestellt, true);
  assert.equal(new Date(p3.zurueckgestellt_bis).getTime(), JETZT.getTime() + 5 * TAG);
  assert.equal(l.find((x) => x.kurz_id === 'P2').zurueckgestellt, undefined);
});

await pruefe('listPlansDetail nennt die Zahl der ausgeblendeten Plaene', async () => {
  reset();
  const d = await core.listPlansDetail('zs', { jetzt: JETZT });
  assert.equal(d.ausgeblendet, 2);
  assert.equal(d.plaene.length, 4);
  const d2 = await core.listPlansDetail('zs', { alle: true, jetzt: JETZT });
  assert.equal(d2.ausgeblendet, 0);
});

await pruefe('Onboarding: planUebersicht blendet zurueckgestellte aus und markiert wieder vorgelegte', async () => {
  reset();
  const u = await core.planUebersicht('zs', JETZT);
  assert.deepEqual(u.map((x) => x.kurz_id).sort(), ['P1', 'P2', 'P4', 'P5']);
  assert.ok(u.find((x) => x.kurz_id === 'P4').wieder_vorgelegt_seit);
  assert.equal(u.find((x) => x.kurz_id === 'P2').wieder_vorgelegt_seit, undefined);
});

await pruefe('Der aktive Plan bleibt sichtbar, auch wenn seine Spalte ein Datum traegt (aktiviert nach Zurueckstellen)', async () => {
  reset();
  await core.aktivierePlan('zs', 'P3');
  const l = await core.listPlans('zs', { jetzt: JETZT });
  assert.equal(l[0].kurz_id, 'P3');
  assert.equal(l[0].aktiv, true);
});

await pruefe('get mit ausdruecklicher plan_id funktioniert immer und nennt zurueckgestellt_bis', async () => {
  reset();
  const p = await core.getPlan('zs', 'P3');
  assert.equal(p.name, 'Schlaeft noch');
  assert.equal(new Date(p.zurueckgestellt_bis).getTime(), JETZT.getTime() + 5 * TAG);
  const q = await core.getPlan('zs', 'P2');
  assert.equal(q.zurueckgestellt_bis, undefined);
});

await pruefe('Alt-Aufruf: Projekte ohne Spalte/ohne Wiedervorlage -> list wie bisher (gleiche Felder, kein neues Feld)', async () => {
  reset();
  for (const projekt of ['alt', 'solo']) {
    const l = await core.listPlans(projekt);
    assert.ok(l.length >= 1);
    for (const e of l) {
      for (const f of ['zurueckgestellt', 'zurueckgestellt_bis', 'wieder_vorgelegt_seit']) {
        assert.ok(!(f in e), `Feld ${f} darf ohne Wiedervorlage nicht auftauchen`);
      }
    }
  }
  const u = await core.planUebersicht('alt');
  assert.equal(u.length, 2);
  assert.ok(!('wieder_vorgelegt_seit' in u[0]));
});

// ---------------------------------------------------------------------------
// 3. MCP-Tool
// ---------------------------------------------------------------------------
await pruefe('MCP plan-Tool: Aktion zurueckstellen + Parameter tage/bis/alle im Schema; zurueckstellen, list, list(alle) verdrahtet', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const props = planTool.definition.inputSchema.properties;
  assert.ok(props.action.enum.includes('zurueckstellen'), 'Aktion fehlt im enum');
  for (const f of ['tage', 'bis', 'alle']) assert.ok(props[f], `${f} fehlt im Schema`);

  // Zeit hier real: Zukunft relativ zu jetzt, damit die Sichtbarkeit stimmt
  const z = await planTool.handler({ action: 'zurueckstellen', project: 'zs', plan_id: 'P2', tage: 14 });
  assert.equal(z.success, true, JSON.stringify(z));
  assert.equal(z.plan_ref.kurz_id, 'P2');
  const bis = new Date(z.zurueckgestellt_bis).getTime();
  assert.ok(Math.abs(bis - (Date.now() + 14 * TAG)) < 60000);

  const l = await planTool.handler({ action: 'list', project: 'zs' });
  assert.equal(l.success, true);
  assert.ok(!kurz(l.plaene).includes('P2'), 'P2 muss ausgeblendet sein');
  assert.ok(l.zurueckgestellt_ausgeblendet >= 1, 'Zaehler der ausgeblendeten Plaene fehlt');
  assert.match(String(l.message), /alle:\s*true/);

  const la = await planTool.handler({ action: 'list', project: 'zs', alle: true });
  const p2 = la.plaene.find((x) => x.kurz_id === 'P2');
  assert.ok(p2 && p2.zurueckgestellt === true);

  const f = await planTool.handler({ action: 'zurueckstellen', project: 'zs', plan_id: 'P1', tage: 2 });
  assert.equal(f.success, false);
  assert.match(String(f.message), /aktiv/i);

  const g = await planTool.handler({ action: 'zurueckstellen', project: 'zs', plan_id: 'P2' });
  assert.equal(g.success, false, 'weder tage noch bis');
});

await pruefe('MCP plan-Tool: list ohne alle/ohne Wiedervorlage liefert dieselbe Antwortform wie bisher (Einzelplan)', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const l = await planTool.handler({ action: 'list', project: 'solo' });
  assert.equal(l.success, true);
  assert.equal(l.plaene.length, 1);
  assert.equal(l.aktiver_plan, 'P1');
  assert.ok(!('zurueckgestellt_ausgeblendet' in l), 'kein neues Feld ohne ausgeblendete Plaene');
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
