#!/usr/bin/env node
// test-modelle-cutoffs.mjs — Modell-Registry (CLI-Argument fuer claude) und
// datengetriebene Cutoffs (resolveCutoff, registerAgent-Politik).
//
// Laeuft OHNE echte Datenbank: pg.Pool.prototype.query/connect werden ersetzt,
// DATABASE_URL zeigt auf einen Port, auf dem nichts lauscht. Jede SQL, die der
// Fake nicht kennt, ist ein Fehler — so kann der Test nie still in die
// Produktion schreiben oder Sperren nehmen.
//
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-modelle-cutoffs.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

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
const reg = (alias, full_id, context_window, corridor_min, cutoff_date = null) => ({
  alias, full_id, provider: 'anthropic', context_window, output_limit: null, env_required: [],
  runtime_binary: 'claude', runtime_path: null, corridor_min, corridor_max: 99,
  pricing_input_usd_per_mtok: null, pricing_output_usd_per_mtok: null, pricing_cache_usd_per_mtok: null,
  cutoff_date, enabled: true,
});
const registryRows = [
  reg('opus', 'claude-opus-5-5', 200_000, 90),
  reg('opus[1m]', 'claude-opus-5-5', 1_000_000, 80),
  reg('fable', 'claude-fable-5-1', 1_000_000, 80),
  reg('opus-4.7', 'claude-opus-4-7', 200_000, 90),
  reg('fable-5', 'claude-fable-5', 1_000_000, 80),
];
let cutoffRows = [];
let insertCalls = [];

pg.Pool.prototype.query = async function (sql, values = []) {
  const text = typeof sql === 'string' ? sql : sql.text;
  if (/FROM model_cutoffs/i.test(text)) return { rows: cutoffRows, rowCount: cutoffRows.length };
  if (/FROM model_registry/i.test(text)) return { rows: registryRows, rowCount: registryRows.length };
  if (/INSERT INTO agent_sessions/i.test(text)) {
    insertCalls.push({ sql: text, values });
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

// ---------------------------------------------------------------------------
// TEIL A — cliModelArg + Registry-Eintraege
// ---------------------------------------------------------------------------
const models = await import('../packages/agents/dist/models.js');

const cli = (alias) => {
  const entry = models.resolveModel(alias);
  assert.ok(entry, `Alias ${alias} fehlt in der Registry`);
  return models.cliModelArg(entry);
};

await pruefe('cliModelArg: opus bleibt Alias (immer neueste Version)', () => assert.equal(cli('opus'), 'opus'));
await pruefe('cliModelArg: opus[1m] bleibt Alias', () => assert.equal(cli('opus[1m]'), 'opus[1m]'));
await pruefe('cliModelArg: fable bleibt Alias', () => assert.equal(cli('fable'), 'fable'));
await pruefe('cliModelArg: haiku bleibt Alias', () => assert.equal(cli('haiku'), 'haiku'));
await pruefe('cliModelArg: opus-4.7[1m] -> claude-opus-4-7[1m]', () => assert.equal(cli('opus-4.7[1m]'), 'claude-opus-4-7[1m]'));
await pruefe('cliModelArg: sonnet-4.6 -> claude-sonnet-4-6', () => assert.equal(cli('sonnet-4.6'), 'claude-sonnet-4-6'));
await pruefe('cliModelArg: opus-5 -> claude-opus-5', () => assert.equal(cli('opus-5'), 'claude-opus-5'));

await pruefe('Registry: aktuelle Claude-Versionen hinter den Aliasen', () => {
  assert.equal(models.resolveModel('opus').fullId, 'claude-opus-5-5');
  assert.equal(models.resolveModel('opus[1m]').contextWindow, 1_000_000);
  assert.equal(models.resolveModel('sonnet').fullId, 'claude-sonnet-5-5');
  assert.equal(models.resolveModel('haiku').fullId, 'claude-haiku-4-5-20251001');
  assert.equal(models.resolveModel('fable').fullId, 'claude-fable-5-1');
  assert.equal(models.resolveModel('fable').contextWindow, 1_000_000);
});
await pruefe('Registry: versionierte Aliase vorhanden', () => {
  for (const a of ['opus-5', 'opus-5[1m]', 'sonnet-5', 'sonnet-5[1m]', 'fable-5', 'opus-4.8', 'opus-4.8[1m]',
    'opus-4.7', 'opus-4.7[1m]', 'opus-4.6', 'opus-4.6[1m]', 'sonnet-4.6']) {
    assert.ok(models.resolveModel(a), `fehlt: ${a}`);
  }
});
// Je VERSION (full_id), Quelle models.dev 29.09.2026: [output_limit, input, output, cache_read, cutoff]
const JE_VERSION = {
  'claude-fable-5-1': [128_000, 10, 50, 0.25, '2026-06-01'],
  'claude-fable-5': [128_000, 10, 50, 1, '2026-01-31'],
  'claude-opus-5-5': [128_000, 4, 20, 0.2, '2026-06-01'],
  'claude-opus-5': [128_000, 5, 25, 0.5, '2026-05-01'],
  'claude-opus-4-8': [128_000, 5, 25, 0.5, '2026-01-01'],
  'claude-opus-4-7': [128_000, 5, 25, 0.5, '2026-01-31'],
  'claude-opus-4-6': [128_000, 5, 25, 0.5, '2025-05-31'],
  'claude-sonnet-5-5': [128_000, 2, 10, 0.2, '2026-06-01'],
  'claude-sonnet-5': [128_000, 2, 10, 0.2, '2026-01-31'],
  'claude-sonnet-4-6': [128_000, 3, 15, 0.3, '2025-08-31'],
  'claude-haiku-4-5-20251001': [64_000, 1, 5, 0.1, '2025-02-28'],
};
await pruefe('Registry: Output-Limit, Preise und Cutoff je Version (models.dev) fuer JEDEN Claude-Alias', () => {
  for (const e of Object.values(models.STATIC_FALLBACK)) {
    if (e.provider !== 'anthropic') continue;
    const soll = JE_VERSION[e.fullId];
    assert.ok(soll, `${e.alias}: unbekannte Version ${e.fullId}`);
    assert.deepEqual(
      [e.outputLimit, e.pricingInputUsdPerMtok, e.pricingOutputUsdPerMtok, e.pricingCacheUsdPerMtok, e.cutoffDate],
      soll, e.alias);
  }
});
await pruefe('Registry: gleiche full_id -> gleiche Preise/Output/Cutoff (reine, [1m]- und versionierte Aliase)', () => {
  const jeFullId = new Map();
  for (const e of Object.values(models.STATIC_FALLBACK)) {
    if (e.provider !== 'anthropic') continue;
    const werte = JSON.stringify([e.outputLimit, e.pricingInputUsdPerMtok, e.pricingOutputUsdPerMtok, e.pricingCacheUsdPerMtok, e.cutoffDate]);
    if (jeFullId.has(e.fullId)) assert.equal(werte, jeFullId.get(e.fullId), `${e.alias} weicht ab von ${e.fullId}`);
    jeFullId.set(e.fullId, werte);
  }
  assert.ok(jeFullId.size >= 11, `nur ${jeFullId.size} Versionen`);
});

await pruefe('Registry: sonnet-4.6 nur 200k, sonnet-4.6[1m] gibt es nicht (nicht im Abo)', () => {
  assert.equal(models.resolveModel('sonnet-4.6').contextWindow, 200_000);
  assert.equal(models.resolveModel('sonnet-4.6[1m]'), null);
});

// ---------------------------------------------------------------------------
// TEIL B — resolveCutoff
// ---------------------------------------------------------------------------
let mc = null;
try {
  mc = await import('../packages/core/dist/services/model-cutoffs.js');
  cutoffRows = mc.MODEL_CUTOFF_SEED.map(([model_id, cutoff_date]) => ({ model_id, cutoff_date }));
} catch (err) {
  console.log(`(model-cutoffs.js nicht ladbar: ${err instanceof Error ? err.message.split('\n')[0] : err})`);
}
const rc = async (m) => {
  assert.ok(mc, 'model-cutoffs.js fehlt');
  return mc.resolveCutoff(m);
};

await pruefe('Anker: gpt-5 steht mit ANDEREM Wert in der Tabelle (sonst waere der naechste Test wertlos)', async () => {
  assert.ok(mc, 'model-cutoffs.js fehlt');
  const gpt5 = mc.MODEL_CUTOFF_SEED.find(([id]) => id === 'gpt-5');
  assert.ok(gpt5, 'gpt-5 fehlt im Seed');
  assert.notEqual(gpt5[1], '2026-02-16');
});
await pruefe('resolveCutoff: gpt-5.6-sol -> 2026-02-16 (nicht gpt-5)', async () => assert.equal(await rc('gpt-5.6-sol'), '2026-02-16'));
await pruefe('resolveCutoff: gpt-5.6-thinking -> gpt-5.6 (Praefix an -Grenze)', async () => assert.equal(await rc('gpt-5.6-thinking'), '2026-02-16'));
await pruefe('resolveCutoff: gpt-5.7 -> null (kein Rueckfall auf gpt-5)', async () => assert.equal(await rc('gpt-5.7'), null));
await pruefe('resolveCutoff: claude-haiku-4-5-20251001 -> 2025-02-28', async () => assert.equal(await rc('claude-haiku-4-5-20251001'), '2025-02-28'));
await pruefe('resolveCutoff: opus[1m] -> 2026-06-01 (ueber Registry-Alias)', async () => assert.equal(await rc('opus[1m]'), '2026-06-01'));
await pruefe('resolveCutoff: opus-4.7 -> 2026-01-31 (versionierter Alias)', async () => assert.equal(await rc('opus-4.7'), '2026-01-31'));
await pruefe('resolveCutoff: openai/gpt-6-astra -> 2026-04-30', async () => assert.equal(await rc('openai/gpt-6-astra'), '2026-04-30'));
await pruefe('resolveCutoff: " Anthropic/Claude-Opus-4-7 " -> 2026-01-31', async () => assert.equal(await rc(' Anthropic/Claude-Opus-4-7 '), '2026-01-31'));
await pruefe('resolveCutoff: claude-sonnet-5-5[1m] -> 2026-06-01', async () => assert.equal(await rc('claude-sonnet-5-5[1m]'), '2026-06-01'));
await pruefe('resolveCutoff: fable-5 -> 2026-01-31 (models.dev vertex)', async () => assert.equal(await rc('fable-5'), '2026-01-31'));
await pruefe('resolveCutoff: claude-fable-5 -> 2026-01-31', async () => assert.equal(await rc('claude-fable-5'), '2026-01-31'));
await pruefe('resolveCutoff: alte Modelle aus models.dev (gpt-4o, gpt-4o-mini, gpt-4-turbo, gemini-2.5-pro/-flash)', async () => {
  assert.equal(await rc('gpt-4o'), '2023-09-01');
  assert.equal(await rc('gpt-4o-mini'), '2023-09-01');
  assert.equal(await rc('gpt-4-turbo'), '2023-12-01');
  assert.equal(await rc('gemini-2.5-pro'), '2025-01-01');
  assert.equal(await rc('gemini-2.5-flash'), '2025-01-01');
});
await pruefe('resolveCutoff: gpt-4o-2024-08-06 -> gpt-4o (Praefix)', async () => assert.equal(await rc('gpt-4o-2024-08-06'), '2023-09-01'));
await pruefe('resolveCutoff: unbekannt -> null', async () => assert.equal(await rc('voellig-unbekanntes-modell'), null));

// Seed im SCHEMA_SQL (gebautes dist) muss der TS-Liste entsprechen — zwei Orte, ein Stand.
await pruefe('Seed: model_cutoffs im SCHEMA_SQL == MODEL_CUTOFF_SEED', async () => {
  assert.ok(mc, 'model-cutoffs.js fehlt');
  const schema = await readFile(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  const block = schema.match(/INSERT INTO model_cutoffs[\s\S]*?ON CONFLICT \(model_id\) DO NOTHING/);
  assert.ok(block, 'kein Seed fuer model_cutoffs im SCHEMA_SQL');
  const imSchema = [...block[0].matchAll(/\('([^']+)',\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => `${m[1]}=${m[2]}`).sort();
  const imCode = mc.MODEL_CUTOFF_SEED.map(([id, d]) => `${id}=${d}`).sort();
  assert.deepEqual(imSchema, imCode);
});
await pruefe('Seed: model_registry im SCHEMA_SQL kennt fable + versionierte Aliase, kein sonnet-4.6[1m]', async () => {
  const schema = await readFile(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  for (const a of ["('fable',", "('opus-4.7[1m]',", "('sonnet-4.6',", "('fable-5',"]) assert.ok(schema.includes(a), `fehlt: ${a}`);
  assert.ok(!schema.includes("('sonnet-4.6[1m]',"));
  assert.match(schema, /\('fable-5',[^\n]*'2026-01-31',\s*\d+\)/, 'fable-5 ohne Cutoff 2026-01-31 im Registry-Seed');
});

// ---------------------------------------------------------------------------
// TEIL B — registerAgent-Politik
// ---------------------------------------------------------------------------
const chat = await import('../packages/core/dist/services/chat.js');
const origError = console.error;
const hinweise = [];

await pruefe('registerAgent: bekannter Cutoff schlaegt falsche Selbstauskunft', async () => {
  insertCalls = [];
  hinweise.length = 0;
  console.error = (...a) => hinweise.push(a.join(' '));
  let s;
  try { s = await chat.registerAgent('t-bekannt', 'testprojekt', 'claude-opus-5-5', '2024-01'); }
  finally { console.error = origError; }
  assert.equal(s.cutoffDate, '2026-06-01');
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].values[3], '2026-06-01');
  assert.ok(hinweise.some((h) => h.includes('2024-01-01') && h.includes('2026-06-01')), 'kein Abweichungs-Hinweis');
});
await pruefe('registerAgent: bekannter Cutoff ueberschreibt gespeicherten Wert (ON CONFLICT)', async () => {
  assert.ok(insertCalls[0], 'kein INSERT');
  assert.match(insertCalls[0].sql, /cutoff_date\s*=\s*CASE WHEN/i);
  assert.equal(insertCalls[0].values[4], true);
});
await pruefe('registerAgent: unbekanntes Modell nimmt Selbstauskunft', async () => {
  insertCalls = [];
  const s = await chat.registerAgent('t-unbekannt', 'testprojekt', 'eigenbau-llm-7', '2025-03');
  assert.equal(s.cutoffDate, '2025-03-01');
  assert.equal(insertCalls[0].values[3], '2025-03-01');
  assert.equal(insertCalls[0].values[4], false);
});
await pruefe('registerAgent: unbekannt ohne Selbstauskunft -> null', async () => {
  const s = await chat.registerAgent('t-leer', 'testprojekt', 'eigenbau-llm-7');
  assert.equal(s.cutoffDate, null);
});
await pruefe('registerAgent: bekanntes Modell ohne Selbstauskunft -> bekannter Cutoff', async () => {
  const s = await chat.registerAgent('t-nur-modell', 'testprojekt', 'gpt-5.6-sol');
  assert.equal(s.cutoffDate, '2026-02-16');
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
