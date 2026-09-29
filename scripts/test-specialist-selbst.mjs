#!/usr/bin/env node
// test-specialist-selbst.mjs — Selbstauskunft fuer Spezialisten (Aufgabe B, Channel 23092).
//
//   1. specialist(action:'selbst', agent_id) liefert NUR Werte aus DB/Registry:
//      name, model, model_full_id, effort (wrapper_status), effort_stufen, default_effort,
//      context_window, Tokens + Prozent, handoff/rotation/hart (berechneKontextSchwellen),
//      cutoff_date (resolveCutoff), keep_alive, channels, current_task.
//   2. Ohne agent_id / unbekannter Agent / mehrdeutig ohne project: klarer Fehler.
//   3. Nicht in der Registry: Registry-Felder null (nicht geraten), Hinweis, Schwellen-Quelle 'fallback'.
//   4. MCP-consolidated-Handler verdrahtet.
//   5. Spezialisten-Prompt: Absatz "Modelldaten nicht schaetzen" mit dem Namen, Effort in der Rollenzeile.
//
// Ohne echte DB: pg.Pool.prototype.query ersetzt. Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-specialist-selbst.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';

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
const reg = (alias, full_id, context_window, corridor_min, corridor_max, effort_stufen, default_effort) => ({
  alias, full_id, provider: 'anthropic', context_window, output_limit: 128000, env_required: [],
  runtime_binary: 'claude', runtime_path: null, corridor_min, corridor_max,
  pricing_input_usd_per_mtok: '4', pricing_output_usd_per_mtok: '20', pricing_cache_usd_per_mtok: '0.2',
  cutoff_date: '2026-06-01', enabled: true, default_effort, effort_stufen,
});
const REGISTRY = [
  reg('opus[1m]', 'claude-opus-5-5', 1_000_000, 80, 97, ALLE, 'medium'),
  reg('opus', 'claude-opus-5-5', 200_000, 73, 88, ALLE, 'medium'),
  reg('haiku', 'claude-haiku-4-5-20251001', 200_000, 73, 88, [], null),
];
const CUTOFFS = [{ model_id: 'claude-opus-5-5', cutoff_date: '2026-06-01' }, { model_id: 'claude-haiku-4-5', cutoff_date: '2025-02-28' }];

const ws = (o) => ({
  agent_name: 'opus-kollege', project: 'p', wrapper_pid: 1, inner_pid: 2, socket_path: null,
  model: 'opus[1m]', model_full_id: 'claude-opus-5-5', provider: 'anthropic', status: 'idle', busy: false,
  current_task: 'JEV-3 bauen', context_ceiling: 1_000_000, tokens_input: 412345, tokens_output: 9000,
  tokens_percent: '41.2', channels: ['spezialisten-modelle', 'p-general'], connected_mcp: true,
  last_activity: '2026-09-29T19:00:00.000Z', heartbeat_enabled: true, heartbeat_interval_ms: null, effort: 'xhigh',
  ...o,
});
let WRAPPER;
let queries;
function reset() {
  WRAPPER = [
    ws({}),
    ws({ agent_name: 'doppelt', project: 'p1' }),
    ws({ agent_name: 'doppelt', project: 'p2' }),
    ws({ agent_name: 'fremdmodell', model: 'gemini-9-ultra', model_full_id: null, provider: 'google', effort: null, context_ceiling: null }),
  ];
  queries = [];
}
reset();

pg.Pool.prototype.query = async function (sql, params = []) {
  const text = typeof sql === 'string' ? sql : sql.text;
  queries.push({ text, params });
  if (/FROM wrapper_status/i.test(text)) {
    let rows = WRAPPER.filter((w) => w.agent_name === params[0]);
    if (/project = \$2/i.test(text)) rows = rows.filter((w) => w.project === params[1]);
    return { rows: structuredClone(rows), rowCount: rows.length };
  }
  if (/FROM model_registry/i.test(text)) return { rows: structuredClone(REGISTRY), rowCount: REGISTRY.length };
  if (/FROM model_cutoffs/i.test(text)) return { rows: structuredClone(CUTOFFS), rowCount: CUTOFFS.length };
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const core = await import('../packages/core/dist/index.js');
const { selbstAuskunft } = core;

await pruefe('Export: selbstAuskunft ueber @synapse/core', () => {
  assert.equal(typeof selbstAuskunft, 'function');
});

// ---------------------------------------------------------------------------
// 1. Vollstaendige Auskunft
// ---------------------------------------------------------------------------
await pruefe('selbst: alle Felder aus wrapper_status, model_registry, model_cutoffs und Korridor', async () => {
  reset();
  const r = await selbstAuskunft('opus-kollege', 'p');
  assert.equal(r.success, true, r.message);
  assert.equal(r.name, 'opus-kollege');
  assert.equal(r.project, 'p');
  assert.equal(r.model, 'opus[1m]');
  assert.equal(r.model_full_id, 'claude-opus-5-5');
  assert.equal(r.effort, 'xhigh', 'tatsaechlich gestartete Stufe aus wrapper_status');
  assert.deepEqual(r.effort_stufen, ALLE);
  assert.equal(r.default_effort, 'medium');
  assert.equal(r.context_window, 1_000_000);
  assert.deepEqual(r.tokens, { input: 412345, output: 9000, prozent: 41.2, kontext_obergrenze: 1_000_000 });
  // 1M-Korridor 80/97: Handoff 800k, Rotation 950k, Hart 970k (core kontext-korridor.ts)
  assert.deepEqual(r.schwellen, { handoff_tokens: 800_000, rotation_tokens: 950_000, hart_tokens: 970_000, quelle: 'registry' });
  assert.equal(r.cutoff_date, '2026-06-01');
  assert.deepEqual(r.channels, ['spezialisten-modelle', 'p-general']);
  assert.equal(r.current_task, 'JEV-3 bauen');
  assert.equal(r.status, 'idle');
  assert.equal(r.keep_alive, null, 'keep_alive steht nicht in der DB — nicht raten');
  assert.ok(r.hinweise.some((h) => /keep_alive/.test(h)), JSON.stringify(r.hinweise));
});

await pruefe('selbst: ohne project eindeutig ueber den Namen', async () => {
  reset();
  const r = await selbstAuskunft('opus-kollege');
  assert.equal(r.success, true, r.message);
  assert.equal(r.project, 'p');
});

// ---------------------------------------------------------------------------
// 2. Fehler
// ---------------------------------------------------------------------------
await pruefe('selbst: ohne agent_id klarer Fehler, keine DB-Abfrage', async () => {
  reset();
  for (const leer of [undefined, null, '', '   ']) {
    const r = await selbstAuskunft(leer, 'p');
    assert.equal(r.success, false);
    assert.match(r.message, /agent_id/);
  }
  assert.equal(queries.length, 0);
});

await pruefe('selbst: unbekannter Agent -> klarer Fehler mit Namen', async () => {
  reset();
  const r = await selbstAuskunft('niemand', 'p');
  assert.equal(r.success, false);
  assert.match(r.message, /niemand/);
  assert.equal(r.error, 'unbekannter_agent');
});

await pruefe('selbst: mehrdeutig ohne project -> Fehler mit den Projekten', async () => {
  reset();
  const r = await selbstAuskunft('doppelt');
  assert.equal(r.success, false);
  assert.match(r.message, /p1/);
  assert.match(r.message, /p2/);
  assert.match(r.message, /project/);
});

// ---------------------------------------------------------------------------
// 3. Nicht in der Registry
// ---------------------------------------------------------------------------
await pruefe('selbst: Modell nicht in der Registry -> Registry-Felder null, Hinweis, Schwellen-Quelle fallback', async () => {
  reset();
  const r = await selbstAuskunft('fremdmodell', 'p');
  assert.equal(r.success, true, r.message);
  assert.equal(r.model, 'gemini-9-ultra');
  assert.equal(r.effort_stufen, null);
  assert.equal(r.default_effort, null);
  assert.equal(r.context_window, null);
  assert.equal(r.effort, null);
  assert.equal(r.schwellen.quelle, 'fallback');
  assert.ok(r.hinweise.some((h) => /model_registry/.test(h)), JSON.stringify(r.hinweise));
});

// ---------------------------------------------------------------------------
// 4. MCP-Handler
// ---------------------------------------------------------------------------
await pruefe('MCP consolidated: specialist(action:selbst) ist verdrahtet und im Schema', async () => {
  reset();
  const { specialistTool } = await import('../packages/mcp-server/dist/tools/consolidated/specialist.js');
  assert.ok(specialistTool.definition.inputSchema.properties.action.enum.includes('selbst'));
  const r = await specialistTool.handler({ action: 'selbst', agent_id: 'opus-kollege', project: 'p' });
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 200));
  assert.equal(r.effort, 'xhigh');
  const ohne = await specialistTool.handler({ action: 'selbst', project: 'p' });
  assert.equal(ohne.success, false);
});

// ---------------------------------------------------------------------------
// 5. Prompt
// ---------------------------------------------------------------------------
await pruefe('Prompt: Rollenzeile nennt Effort, Absatz verweist auf specialist(selbst) mit eigenem Namen', async () => {
  const { buildSpecialistPrompt } = await import('../packages/agents/dist/prompts.js');
  const cfg = { name: 'opus-kollege', model: 'opus[1m]', effort: 'high', expertise: 'X', task: 'Y', project: 'p' };
  const t = buildSpecialistPrompt(cfg, null);
  assert.match(t, /Modell: opus\[1m\], Effort: high/);
  assert.ok(t.includes(`specialist(action:'selbst', agent_id:'opus-kollege')`), 'Aufruf mit eigenem Namen fehlt');
  assert.match(t, /NICHT schaetzen/);
  const ohne = buildSpecialistPrompt({ ...cfg, model: 'haiku', effort: undefined }, null);
  assert.match(ohne, /Modell: haiku, Effort: ohne/);
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
