#!/usr/bin/env node
// test-modell-registry-db.mjs — Modell-Registry aus der DB statt nur STATIC_FALLBACK.
//
//   1. Ein Alias, der NUR in der DB steht, wird beim Spawn aufgeloest
//      (spawnSpecialistTool laedt die DB-Registry vor resolveModel).
//   2. DB-Fehler: STATIC_FALLBACK bleibt, mit Log.
//   3. cutoff_date kommt ohne Tagesversatz an (oestlich von UTC lieferte
//      toISOString() auf das lokale DATE-Objekt den Vortag).
//
// Ohne echte DB: pg.Pool.prototype.query/connect ersetzt, DATABASE_URL zeigt ins Leere.
// Der Fake verhaelt sich bei DATE wie pg: ohne ::text kommt ein lokales Date-Objekt.
// Aufruf: node scripts/test-modell-registry-db.mjs   (Exit 1 bei Fehler)

process.env.TZ = 'Europe/Berlin';
process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
delete process.env.SYNAPSE_TEST_NIE_GESETZT;

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
const zeile = (alias, full_id, provider, context_window, runtime_binary, env_required, cutoff) => ({
  alias, full_id, provider, context_window, output_limit: null, env_required, runtime_binary,
  runtime_path: runtime_binary === 'node' ? '@synapse/agents-gemini/runtime' : null,
  corridor_min: 80, corridor_max: 97,
  pricing_input_usd_per_mtok: null, pricing_output_usd_per_mtok: null, pricing_cache_usd_per_mtok: null,
  cutoff, enabled: true,
});
const registry = [
  zeile('haiku', 'claude-haiku-4-5-20251001', 'anthropic', 200_000, 'claude', [], '2025-02-28'),
  // Steht NUR in der DB, nicht in STATIC_FALLBACK. Braucht eine ENV, die nie gesetzt ist:
  // der Spawn bricht dann VOR jedem Seiteneffekt am ENV-Check ab — aber erst NACH resolveModel.
  zeile('nur-db-modell', 'nur-db-modell-1', 'google', 1_000_000, 'node', ['SYNAPSE_TEST_NIE_GESETZT'], null),
];
let dbKaputt = false;
let registryAbfragen = 0;

pg.Pool.prototype.query = async function (sql) {
  const text = typeof sql === 'string' ? sql : sql.text;
  if (/FROM model_registry/i.test(text)) {
    registryAbfragen++;
    if (dbKaputt) throw new Error('connect ECONNREFUSED (Test)');
    const alsText = /cutoff_date::text/i.test(text);
    const rows = registry.map((r) => {
      if (!r.cutoff) return { ...r, cutoff_date: null };
      const [j, m, t] = r.cutoff.split('-').map(Number);
      // pg liefert DATE als lokale Mitternacht
      return { ...r, cutoff_date: alsText ? r.cutoff : new Date(j, m - 1, t) };
    });
    return { rows, rowCount: rows.length };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const models = await import('../packages/agents/dist/models.js');
const coreRegistry = await import('../packages/core/dist/services/model-registry.js');
const { spawnSpecialistTool } = await import('../packages/mcp-server/dist/tools/specialists.js');

// ---------------------------------------------------------------------------
// 1. Alias nur in der DB
// ---------------------------------------------------------------------------
await pruefe('Anker: nur-db-modell steht NICHT in STATIC_FALLBACK und ist vor dem Laden unbekannt', () => {
  assert.equal(models.STATIC_FALLBACK['nur-db-modell'], undefined);
  assert.equal(models.resolveModel('nur-db-modell'), null);
});

await pruefe('Spawn loest einen Alias auf, der NUR in der DB steht', async () => {
  const antwort = await spawnSpecialistTool(
    'registry-test', 'nur-db-modell', 'Test', 'Test', 'testprojekt', '/nicht/vorhanden/testprojekt',
  );
  const text = antwort.content[0].text;
  assert.ok(!text.includes('Unbekanntes Modell-Alias'), `Alias nicht aufgeloest: ${text.slice(0, 160)}`);
  assert.match(text, /SYNAPSE_TEST_NIE_GESETZT/, 'erwartet: Abbruch am ENV-Check nach der Aufloesung');
});

await pruefe('Nach dem Laden: resolveModel kennt den DB-Alias, listAliases enthaelt DB- UND Fallback-Aliase', () => {
  assert.equal(models.resolveModel('nur-db-modell')?.fullId, 'nur-db-modell-1');
  const aliase = models.listAliases();
  assert.ok(aliase.includes('nur-db-modell'), 'DB-Alias fehlt');
  assert.ok(aliase.includes('fable'), 'Fallback-Alias fehlt (DB kennt ihn noch nicht)');
});

await pruefe('loadFromDb laedt nur einmal (zweiter Aufruf fragt die DB nicht erneut)', async () => {
  const vorher = registryAbfragen;
  await models.loadFromDb();
  assert.equal(registryAbfragen, vorher);
});

// ---------------------------------------------------------------------------
// 2. DB-Fehler -> STATIC_FALLBACK mit Log
// ---------------------------------------------------------------------------
await pruefe('DB-Fehler: STATIC_FALLBACK bleibt, Fehler wird geloggt', async () => {
  dbKaputt = true;
  coreRegistry.invalidateCache();
  const frisch = await import('../packages/agents/dist/models.js?db-kaputt');
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  try {
    await frisch.loadFromDb();
  } finally {
    console.error = orig;
    dbKaputt = false;
    coreRegistry.invalidateCache();
  }
  assert.equal(frisch.resolveModel('opus')?.fullId, 'claude-opus-5-5');
  assert.equal(frisch.resolveModel('nur-db-modell'), null);
  assert.ok(logs.some((l) => l.includes('STATIC_FALLBACK')), 'kein Log-Hinweis');
});

// ---------------------------------------------------------------------------
// 3. cutoff_date ohne Tagesversatz
// ---------------------------------------------------------------------------
await pruefe('model-registry: cutoff_date bleibt 2025-02-28 (TZ Europe/Berlin)', async () => {
  coreRegistry.invalidateCache();
  const haiku = await coreRegistry.getModel('haiku');
  assert.equal(haiku.cutoffDate, '2025-02-28');
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
