#!/usr/bin/env node
// test-plan-zuweisung.mjs — plan(passende_tasks) und plan(uebernehmen) (Aufgabe C, Channel 23094/23096).
//
// P7-T53: Alle Agenten beteiligen sich; Profile empfehlen nur. Atomare Konfliktwiederholung erhaelt beide Beteiligten.
// Rotkontrolle: neuer DB-Test plan-beteiligung-p7-t53.test.mjs gegen Basis t103.
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
  reg('sonnet', 'claude-sonnet-5-5', 1_000_000, ALLE), reg('sonnet[1m]', 'claude-sonnet-5-5', 1_000_000, ALLE),
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
  if (/FROM unnest\(/i.test(text)) return { rows: params[1].map(agent_id => ({agent_id, aktiv: agent_id !== 'jemand'})), rowCount: params[1].length };
  if (/SELECT model FROM agent_sessions/i.test(text)) return { rows: params[0] === 'codex' ? [{model:'gpt-6.1-sol'}] : [], rowCount: params[0] === 'codex' ? 1 : 0 };
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
core.taskIndex.sync = async () => {};
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


await pruefe('Alle offenen/laufenden Tasks bleiben sichtbar; Profilabweichung nur Hinweis', async () => {
  reset();
  const r=await core.passendeTasks('p','sonnet-medium');
  assert.equal(r.success,true,r.message);
  assert.equal(r.tasks.length,7);
  const mismatch=r.tasks.find(t=>t.kurz_id==='P2-T1');
  assert.equal(mismatch.profil_hinweis.passt,false);
  assert.match(mismatch.profil_hinweis.hinweis,/passt nicht/);
  assert.equal(r.tasks.find(t=>t.kurz_id==='P2-T6').beteiligte[0].status,'inaktiv');
  assert.ok(!r.tasks.some(t=>t.kurz_id==='P2-T7'));
  assert.deepEqual(r.passend.map(t=>t.kurz_id),['P2-T2']);
  assert.deepEqual(r.offen_fuer_koordinator.map(t=>t.kurz_id),['P2-T4','P2-T5']);
});
await pruefe('Anmeldung aller Profile, ohne Wrapper/Empfehlung, und unbekanntes Profil', async () => {
  reset();
  for(const [ref,agent] of [['P2-T1','sonnet-medium'],['P2-T4','codex'],['P2-T5','subagent']]){
    const r=await core.uebernehmeTask('p','P2',ref,agent);
    assert.equal(r.success,true,r.message);assert.equal(r.task.beteiligte[0].agent_id,agent);
  }
  const c=await core.passendeTasks('p','codex');assert.equal(c.profil.model,'gpt-6.1-sol');assert.equal(c.profil.quelle,'agent_sessions');
  const u=await core.passendeTasks('p','unbekannt');assert.equal(u.success,true);assert.equal(u.profil,'Profil unbekannt');
  assert.equal((await core.uebernehmeTask('p','P2','P2-T2','')).success,false);
});
await pruefe('Zweiter und dritter Agent: beide erfolgreich, Idempotenz, fertige Aufrufe', async () => {
  reset();
  const a=await core.uebernehmeTask('p','P2','P2-T1','opus-1m-high');assert.equal(a.success,true,a.message);
  const first=task_('plan-2','b1').beteiligte[0];
  const again=await core.uebernehmeTask('p','P2','P2-T1','opus-1m-high');
  assert.equal(again.bereits_angemeldet,true);assert.deepEqual(task_('plan-2','b1').beteiligte,[first]);
  const b=await core.uebernehmeTask('p','P2','P2-T1','subagent');
  assert.equal(b.success,true,b.message);assert.equal(b.task.beteiligte.length,2);
  const text=b.hinweise.join(' ');for(const part of ['opus-1m-high','code_intel','schatten','show_ghosts','history','plan_status','op_indices','coedit_add','anchor_text'])assert.ok(text.includes(part),part);
  const c=await core.uebernehmeTask('p','P2','P2-T1','codex');
  assert.equal(c.success,true);assert.equal(c.task.beteiligte.length,3);assert.match(c.hinweise.join(' '),/Ab 3/);
  assert.equal(task_('plan-2','b1').eigenesFeld,7);
  assert.ok(task_('plan-2','b1').beteiligte.every(x=>Object.keys(x).sort().join(',')==='agent_id,seit'));
});
await pruefe('CAS-Wiederholung: konkurrierender Legacy-Agent bleibt neben neuem Agent erhalten',async()=>{
  reset();eingriff=()=>Object.assign(task_('plan-2','b1'),{zugewiesen_an:'anderer',zugewiesen_am:'2026-09-29T19:59:00.000Z',status:'in_progress'});
  const r=await core.uebernehmeTask('p','P2','P2-T1','subagent');
  assert.equal(r.success,true,r.message);assert.deepEqual(r.task.beteiligte.map(x=>x.agent_id),['anderer','subagent']);
});
await pruefe('Legacy im get, Abmelden eines Agenten, letzter -> todo, done bleibt done, Reset',async()=>{
  reset();
  let p=await core.getPlan('p','P2');assert.equal(p.tasks.find(t=>t.id==='b6').beteiligte[0].agent_id,'jemand');
  assert.equal((await core.uebernehmeTask('p','P2','P2-T6','codex')).success,true);
  const a=await core.meldeTaskAb('p',undefined,'P2-T6','jemand');assert.equal(a.success,true,a.message);
  assert.equal(a.task.status,'in_progress');assert.equal(a.task.zugewiesen_an,'codex');
  const b=await core.meldeTaskAb('p',null,'b6','codex');assert.equal(b.success,true,b.message);assert.equal(b.task.status,'todo');assert.equal(b.task.zugewiesen_an,null);
  assert.deepEqual((await core.getPlan('p','P2')).tasks.find(t=>t.id==='b6').beteiligte,[]);
  await core.uebernehmeTask('p','P2','P2-T1','codex');
  await core.updateTask('p','P2-T1',{status:'done'},'P2');
  assert.equal((await core.meldeTaskAb('p','P2','P2-T1','codex')).task.status,'done');
  await core.uebernehmeTask('p','P2','P2-T2','codex');await core.updateTask('p','P2-T2',{status:'todo'},'P2');
  assert.deepEqual(task_('plan-2','b2').beteiligte,[]);assert.equal(task_('plan-2','b2').zugewiesen_an,null);
});
await pruefe('Done, blocked, Wiedervorlage bleiben fachliche Grenzen',async()=>{
  reset();
  assert.equal((await core.uebernehmeTask('p','P2','P2-T7','codex')).success,false);
  task_('plan-2','b1').status='blocked';assert.equal((await core.uebernehmeTask('p','P2','P2-T1','codex')).success,false);
  Object.assign(task_('plan-2','b1'),{status:'todo',zurueckgestellt_bis:'2999-01-01T00:00:00Z'});
  assert.equal((await core.uebernehmeTask('p','P2','P2-T1','codex')).success,false);
});
await pruefe('stdio: An-/Abmeldung verdrahtet und Beteiligte auch kompakt sichtbar',async()=>{
  reset();const {planTool}=await import('../packages/mcp-server/dist/tools/consolidated/plan.js');
  assert.ok(planTool.definition.inputSchema.properties.action.enum.includes('abmelden'));
  const args={project:'p',plan_id:'P2',task_id:'P2-T1',agent_id:'subagent'};
  assert.equal((await planTool.handler({...args,action:'uebernehmen'})).success,true);
  const g=await planTool.handler({...args,action:'get',compact:true});
  assert.equal(g.tasks[0].beteiligte[0].agent_id,'subagent');
  assert.equal((await planTool.handler({...args,action:'abmelden'})).task.status,'todo');
});
await pruefe('Spezialisten-Prompt: Profil als Empfehlung, gemeinsam arbeiten',async()=>{
  const {buildSpecialistPrompt}=await import('../packages/agents/dist/prompts.js');
  const s=buildSpecialistPrompt({name:'x',project:'p',model:'opus',expertise:'x',task:'y'},null);
  assert.match(s,/Empfehlung/);assert.match(s,/Beteiligte/);assert.match(s,/Co-Edit/);
  assert.ok(!s.includes('Nimm nur Tasks, die dir der Server als passend gibt'));
});
console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler>0?1:0);
