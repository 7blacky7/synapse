#!/usr/bin/env node
// test-plan-zuweisung.mjs — plan(passende_tasks) und plan(uebernehmen) (Aufgabe C, Channel 23094/23096).
//
// User-Vorgabe: Jev BEWERTET nur. Spezialisten nehmen sich selbst passende Tasks, der Server
// setzt das durch. PASST-REGEL (Profil aus wrapper_status + model_registry):
//   - Modellfamilie gleich: spawn_alias ohne [1m] == eigener Alias ohne [1m]
//   - eigener Kontext >= empfohlenem (1M darf eine 200k-Task nehmen, umgekehrt nicht)
//   - Effort gleich der empfohlenen Stufe oder GENAU eine Stufe hoeher (effort_stufen-Reihenfolge)
//   - Modelle ohne Effort (haiku) nur, wenn die Empfehlung ebenfalls keinen Effort hat
// uebernehmen ist atomar (bedingtes UPDATE, keine Sperre mit Client-Wartezeit): doppelte Uebernahme
// scheitert sicher. Tasks ohne Empfehlung oder "unsicher" gehoeren dem Koordinator.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt (plans, wrapper_status, model_registry).
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-plan-zuweisung.mjs   (Exit 1 bei Fehler)

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
// Fake-DB
// ---------------------------------------------------------------------------
const ALLE = ['low', 'medium', 'high', 'xhigh', 'max'];
const reg = (alias, full_id, context_window, effort_stufen) => ({
  alias, full_id, provider: 'anthropic', context_window, output_limit: 128000, env_required: [],
  runtime_binary: 'claude', runtime_path: null, corridor_min: 73, corridor_max: 88,
  pricing_input_usd_per_mtok: null, pricing_output_usd_per_mtok: null, pricing_cache_usd_per_mtok: null,
  cutoff_date: null, enabled: true, default_effort: effort_stufen.length ? 'medium' : null, effort_stufen,
});
const REGISTRY = [
  reg('opus', 'claude-opus-5-5', 200_000, ALLE), reg('opus[1m]', 'claude-opus-5-5', 1_000_000, ALLE),
  reg('sonnet', 'claude-sonnet-5-5', 200_000, ALLE), reg('sonnet[1m]', 'claude-sonnet-5-5', 1_000_000, ALLE),
  reg('haiku', 'claude-haiku-4-5-20251001', 200_000, []), reg('fable', 'claude-fable-5-1', 1_000_000, ALLE),
];
const ws = (agent_name, model, effort) => ({
  agent_name, project: 'p', model, model_full_id: null, provider: 'anthropic', status: 'idle', busy: false,
  current_task: null, context_ceiling: null, tokens_input: 0, tokens_output: 0, tokens_percent: 0,
  channels: [], connected_mcp: true, last_activity: '2026-09-29T19:00:00.000Z', heartbeat_enabled: true,
  heartbeat_interval_ms: null, effort,
});
const WRAPPER = [
  ws('opus-1m-high', 'opus[1m]', 'high'),
  ws('opus-200k-high', 'opus', 'high'),
  ws('opus-1m-xhigh', 'opus[1m]', 'xhigh'),
  ws('opus-1m-max', 'opus[1m]', 'max'),
  ws('opus-1m-medium', 'opus[1m]', 'medium'),
  ws('sonnet-medium', 'sonnet', 'medium'),
  ws('haiku-a', 'haiku', null),
];
const emp = (spawn_alias, effort, kontext, extra = {}) => ({
  modell: spawn_alias.replace(/\[1m\]$/, ''), effort, kontext, spawn_alias, confidence: 0.8, quelle: 'cloud',
  kandidaten: ['opus', 'sonnet', 'haiku', 'fable'], stand: '2026-09-29T19:00:00.000Z', experimentell: true, ...extra,
});
const task = (id, kurz, title, empfehlung, extra = {}) => ({
  id, kurz_id: kurz, title, description: `${title}!`, status: 'todo', priority: 'medium',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...(empfehlung ? { empfehlung } : {}), ...extra,
});
let PLAENE;
let eingriff = null;
function reset() {
  PLAENE = [
    { id: 'plan-1', project: 'p', name: 'Grundplan', description: '', goals: [], architecture: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', kurz_id: 'P1', aktiv: false, naechste_task_nr: 2,
      tasks: [task('a1', 'P1-T1', 'Alt opus', emp('opus[1m]', 'high', '1m'))] },
    { id: 'plan-2', project: 'p', name: 'Aktiv', description: 'Ziel', goals: [], architecture: null,
      created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', kurz_id: 'P2', aktiv: true, naechste_task_nr: 8,
      tasks: [
        task('b1', 'P2-T1', 'Refactor gross', emp('opus[1m]', 'high', '1m'), { eigenesFeld: 7 }),
        task('b2', 'P2-T2', 'Endpunkt', emp('sonnet', 'medium', '200k')),
        task('b3', 'P2-T3', 'Logzeile', emp('haiku', null, '200k')),
        task('b4', 'P2-T4', 'Ohne Empfehlung', null),
        task('b5', 'P2-T5', 'Unsicher', { unsicher: true, bester_vorschlag: { modell: 'opus', effort: 'high', kontext: '200k' }, confidence: 0.3, quelle: 'cloud', kandidaten: [], stand: 'x', experimentell: true }),
        task('b6', 'P2-T6', 'Schon vergeben', emp('opus[1m]', 'high', '1m'), { zugewiesen_an: 'jemand', status: 'in_progress' }),
        task('b7', 'P2-T7', 'Erledigt', emp('opus[1m]', 'high', '1m'), { status: 'done' }),
      ] },
  ];
  eingriff = null;
}
reset();

pg.Pool.prototype.query = async function (sql, params = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
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
    const rows = WRAPPER.filter((w) => w.agent_name === params[0] && (!/project = \$2/.test(text) || w.project === params[1]));
    return { rows: structuredClone(rows), rowCount: rows.length };
  }
  if (/FROM model_registry/i.test(text)) return { rows: structuredClone(REGISTRY), rowCount: REGISTRY.length };
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 90)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const core = await import('../packages/core/dist/index.js');
core.planIndex.sync = async () => {};
const task_ = (planId, id) => PLAENE.find((p) => p.id === planId).tasks.find((t) => t.id === id);

// ---------------------------------------------------------------------------
// 1. Passt-Regel
// ---------------------------------------------------------------------------
await pruefe('Passt-Regel: Familie, Kontext, Effort gleich oder genau eine Stufe hoeher, haiku nur ohne Effort', () => {
  const p = (model, effort, kontext, stufen = ALLE) => ({ name: 'x', model, familie: model.replace(/\[1m\]$/, ''), effort, kontext, effort_stufen: stufen });
  const e = emp('opus[1m]', 'high', '1m');
  assert.equal(core.passtZuProfil(p('opus[1m]', 'high', '1m'), e).passt, true);
  assert.equal(core.passtZuProfil(p('opus[1m]', 'xhigh', '1m'), e).passt, true, 'eine Stufe hoeher');
  assert.equal(core.passtZuProfil(p('opus[1m]', 'max', '1m'), e).passt, false, 'zwei Stufen hoeher');
  assert.equal(core.passtZuProfil(p('opus[1m]', 'medium', '1m'), e).passt, false, 'niedriger');
  assert.equal(core.passtZuProfil(p('opus', 'high', '200k'), e).passt, false, '200k darf keine 1M-Task');
  assert.equal(core.passtZuProfil(p('opus[1m]', 'high', '1m'), emp('opus', 'high', '200k')).passt, true, '1M darf 200k-Task');
  assert.equal(core.passtZuProfil(p('sonnet', 'high', '200k'), emp('opus', 'high', '200k')).passt, false, 'andere Familie');
  assert.equal(core.passtZuProfil(p('haiku', null, '200k', []), emp('haiku', null, '200k')).passt, true);
  assert.equal(core.passtZuProfil(p('haiku', null, '200k', []), emp('haiku', 'low', '200k')).passt, false, 'haiku nur ohne Effort');
  const grund = core.passtZuProfil(p('sonnet', 'medium', '200k'), e).grund;
  assert.match(grund, /empfohlen: opus@high \(1m\)/);
  assert.match(grund, /du bist sonnet@medium \(200k\)/);
});

// ---------------------------------------------------------------------------
// 2. passende_tasks
// ---------------------------------------------------------------------------
await pruefe('passende_tasks: ohne plan_id ueber alle Plaene, je Treffer plan_id; offen_fuer_koordinator getrennt', async () => {
  reset();
  const r = await core.passendeTasks('p', 'opus-1m-high');
  assert.equal(r.success, true, r.message);
  assert.deepEqual(r.passend.map((t) => [t.plan_kurz_id, t.kurz_id]), [['P1', 'P1-T1'], ['P2', 'P2-T1']]);
  assert.equal(r.passend[0].plan_id, 'plan-1');
  assert.deepEqual(r.offen_fuer_koordinator.map((t) => [t.kurz_id, t.grund]).sort(), [['P2-T4', 'keine Empfehlung'], ['P2-T5', 'unsicher']]);
  assert.ok(!JSON.stringify(r).includes('P2-T6'), 'zugewiesene Task ist nicht passend');
  assert.ok(!JSON.stringify(r.passend).includes('P2-T7'), 'erledigte Task ist nicht passend');
  assert.equal(r.profil.model, 'opus[1m]');
  assert.equal(r.profil.kontext, '1m');
});

await pruefe('passende_tasks: mit plan_id nur dieser Plan; anderes Profil -> andere Treffer', async () => {
  reset();
  const r = await core.passendeTasks('p', 'opus-1m-high', 'P2');
  assert.deepEqual(r.passend.map((t) => t.kurz_id), ['P2-T1']);
  const s = await core.passendeTasks('p', 'sonnet-medium');
  assert.deepEqual(s.passend.map((t) => t.kurz_id), ['P2-T2']);
  const h = await core.passendeTasks('p', 'haiku-a');
  assert.deepEqual(h.passend.map((t) => t.kurz_id), ['P2-T3']);
});

await pruefe('passende_tasks: unbekannter oder fehlender Agent -> klarer Fehler', async () => {
  reset();
  let r = await core.passendeTasks('p', 'niemand');
  assert.equal(r.success, false);
  assert.match(r.message, /niemand/);
  r = await core.passendeTasks('p', '');
  assert.equal(r.success, false);
  assert.match(r.message, /agent_id/);
});

// ---------------------------------------------------------------------------
// 3. uebernehmen
// ---------------------------------------------------------------------------
await pruefe('uebernehmen: setzt zugewiesen_an, zugewiesen_am, status in_progress; andere Felder bleiben', async () => {
  reset();
  const r = await core.uebernehmeTask('p', 'P2', 'P2-T1', 'opus-1m-high');
  assert.equal(r.success, true, r.message);
  const t = task_('plan-2', 'b1');
  assert.equal(t.zugewiesen_an, 'opus-1m-high');
  assert.ok(!Number.isNaN(Date.parse(t.zugewiesen_am)));
  assert.equal(t.status, 'in_progress');
  assert.equal(t.eigenesFeld, 7);
  assert.equal(t.empfehlung.effort, 'high');
  assert.equal(r.task.kurz_id, 'P2-T1');
  assert.equal(r.plan_ref.kurz_id, 'P2');
});

await pruefe('uebernehmen: per UUID genauso; eine Stufe hoeher passt', async () => {
  reset();
  const r = await core.uebernehmeTask('p', 'plan-2', 'b1', 'opus-1m-xhigh');
  assert.equal(r.success, true, r.message);
});

await pruefe('uebernehmen: zweiter Agent auf dieselbe Task -> Fehler "bereits zugewiesen"', async () => {
  reset();
  assert.equal((await core.uebernehmeTask('p', 'P2', 'P2-T1', 'opus-1m-high')).success, true);
  const r = await core.uebernehmeTask('p', 'P2', 'P2-T1', 'opus-1m-xhigh');
  assert.equal(r.success, false);
  assert.match(r.message, /bereits zugewiesen/);
  assert.match(r.message, /opus-1m-high/);
  assert.equal(task_('plan-2', 'b1').zugewiesen_an, 'opus-1m-high');
});

await pruefe('uebernehmen: gleichzeitig (fremde Uebernahme zwischen Lesen und Schreiben) -> genau einer gewinnt', async () => {
  reset();
  eingriff = () => {
    const t = task_('plan-2', 'b1');
    Object.assign(t, { zugewiesen_an: 'opus-1m-xhigh', zugewiesen_am: '2026-09-29T19:59:00.000Z', status: 'in_progress' });
  };
  const r = await core.uebernehmeTask('p', 'P2', 'P2-T1', 'opus-1m-high');
  assert.equal(r.success, false, 'darf die fremde Uebernahme nicht ueberschreiben');
  assert.match(r.message, /bereits zugewiesen/);
  assert.equal(task_('plan-2', 'b1').zugewiesen_an, 'opus-1m-xhigh');
});

await pruefe('uebernehmen: Profil passt nicht -> Fehler mit Grund, nichts geschrieben', async () => {
  reset();
  const r = await core.uebernehmeTask('p', 'P2', 'P2-T1', 'sonnet-medium');
  assert.equal(r.success, false);
  assert.match(r.message, /empfohlen: opus@high \(1m\), du bist sonnet@medium \(200k\)/);
  assert.equal(task_('plan-2', 'b1').zugewiesen_an, undefined);
  const k = await core.uebernehmeTask('p', 'P2', 'P2-T1', 'opus-200k-high');
  assert.equal(k.success, false);
  assert.match(k.message, /1m/);
});

await pruefe('uebernehmen: ohne Empfehlung / unsicher / erledigt -> Fehler (gehoert dem Koordinator)', async () => {
  reset();
  for (const [ref, muster] of [['P2-T4', /keine Empfehlung/], ['P2-T5', /unsicher/], ['P2-T7', /done|erledigt/]]) {
    const r = await core.uebernehmeTask('p', 'P2', ref, 'opus-1m-high');
    assert.equal(r.success, false, ref);
    assert.match(r.message, muster, ref);
  }
});

await pruefe('uebernehmen: plan_id und task_id Pflicht; Task aus anderem Plan -> Fehler', async () => {
  reset();
  let r = await core.uebernehmeTask('p', '', 'P2-T1', 'opus-1m-high');
  assert.equal(r.success, false);
  assert.match(r.message, /plan_id/);
  r = await core.uebernehmeTask('p', 'P2', '', 'opus-1m-high');
  assert.equal(r.success, false);
  assert.match(r.message, /task_id/);
  r = await core.uebernehmeTask('p', 'P2', 'P1-T1', 'opus-1m-high');
  assert.equal(r.success, false);
  assert.match(r.message, /P1-T1/);
});

// ---------------------------------------------------------------------------
// 4. Tools + Prompt
// ---------------------------------------------------------------------------
await pruefe('MCP plan-Tool: passende_tasks und uebernehmen im Schema und verdrahtet', async () => {
  reset();
  const { planTool } = await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  const e = planTool.definition.inputSchema.properties.action.enum;
  assert.ok(e.includes('passende_tasks') && e.includes('uebernehmen'));
  const l = await planTool.handler({ action: 'passende_tasks', project: 'p', agent_id: 'sonnet-medium' });
  assert.deepEqual(l.passend.map((t) => t.kurz_id), ['P2-T2']);
  const u = await planTool.handler({ action: 'uebernehmen', project: 'p', plan_id: 'P2', task_id: 'P2-T2', agent_id: 'sonnet-medium' });
  assert.equal(u.success, true, u.message);
});

await pruefe('Prompt: Absatz "Neue Arbeit" mit passende_tasks -> uebernehmen, keine Weitergabe', async () => {
  const { buildSpecialistPrompt } = await import('../packages/agents/dist/prompts.js');
  const t = buildSpecialistPrompt({ name: 'opus-kollege', model: 'opus[1m]', effort: 'high', expertise: 'X', task: 'Y', project: 'p' }, null);
  assert.ok(t.includes("plan(action:'passende_tasks', project:'p', agent_id:'opus-kollege')"), 'passende_tasks-Aufruf fehlt');
  assert.ok(t.includes("plan(action:'uebernehmen'"), 'uebernehmen-Aufruf fehlt');
  assert.match(t, /Nimm nur Tasks, die dir der Server als passend gibt/);
  assert.match(t, /Gib keine Tasks an andere Agenten weiter/);
  assert.match(t, /Passt nichts, melde dich im Channel und warte/);
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
