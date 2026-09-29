#!/usr/bin/env node
// test-kontext-korridor.mjs — Context-Schwellen ueber die ganze Kette:
//   Wrapper (agents models.kontextSchwellen)  ==  core-Respawn (pruefeRespawnKorridor)
//   == reine Funktion (core berechneKontextSchwellen), fuer Registry-Modelle und Rueckfall.
// Dazu: fable loest den Respawn erst im 1M-Korridor aus, und der Neustart ueber REST
// geht als Job an den Daemon statt als Marker ins /tmp des API-Containers.
//
// Ohne echte DB: pg.Pool.prototype.query/connect ersetzt, DATABASE_URL zeigt ins Leere.
// Die Fake-Registry wird AUS STATIC_FALLBACK gebaut — genau so muessen Wrapper
// (STATIC_FALLBACK) und core (DB) dieselben Zahlen sehen.
//
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-kontext-korridor.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
async function lade(pfad) {
  try { return await import(pfad); } catch (err) {
    console.log(`(${pfad} nicht ladbar: ${err instanceof Error ? err.message.split('\n')[0] : err})`);
    return {};
  }
}

const models = await lade('../packages/agents/dist/models.js');
const korridor = await lade('../packages/core/dist/services/kontext-korridor.js');
const respawn = await lade('../packages/core/dist/services/specialist-respawn.js');
const registry = await lade('../packages/core/dist/services/model-registry.js');
const worker = await lade('../packages/file-watcher-daemon-ts/dist/specialist-job-worker.js');

// ---------------------------------------------------------------------------
// Fake-DB
// ---------------------------------------------------------------------------
const alsZeile = (e) => ({
  alias: e.alias, full_id: e.fullId, provider: e.provider, context_window: e.contextWindow,
  output_limit: null, env_required: e.envRequired, runtime_binary: e.binary, runtime_path: e.runtimePath ?? null,
  corridor_min: e.corridorMin, corridor_max: e.corridorMax,
  pricing_input_usd_per_mtok: null, pricing_output_usd_per_mtok: null, pricing_cache_usd_per_mtok: null,
  cutoff_date: null, enabled: true,
});
let registryRows = Object.values(models.STATIC_FALLBACK ?? {}).map(alsZeile);
let wrapperRow = null;
const jobInserts = [];

pg.Pool.prototype.query = async function (sql, values = []) {
  const text = typeof sql === 'string' ? sql : sql.text;
  if (/FROM model_registry/i.test(text)) return { rows: registryRows, rowCount: registryRows.length };
  if (/FROM projects/i.test(text)) return { rows: [{ path: '/nicht/vorhanden/testprojekt' }], rowCount: 1 };
  if (/FROM wrapper_status/i.test(text)) return { rows: wrapperRow ? [wrapperRow] : [], rowCount: wrapperRow ? 1 : 0 };
  if (/INSERT INTO specialist_jobs/i.test(text)) {
    jobInserts.push({ sql: text, values });
    return { rows: [{ id: `job-${jobInserts.length}` }], rowCount: 1 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

// ---------------------------------------------------------------------------
// Erwartete Schwellen (absolute Tokens)
//   hard = corridorMax%, rotation = min(95%, hard), handoff = min(corridorMin%, rotation - 30k)
// ---------------------------------------------------------------------------
// Korridore je Groessenklasse (Begruendung: core services/kontext-korridor.ts):
//   200k: corridorMin 73 / corridorMax 88  -> 146k / 176k / 176k
//   1M:   corridorMin 80 / corridorMax 97  -> 800k / 950k / 970k
const ERWARTET = {
  'opus':          { ceiling: 200_000,   handoffTokens: 146_000, rotationTokens: 176_000, hardRotationTokens: 176_000 },
  'opus-4.7[1m]':  { ceiling: 1_000_000, handoffTokens: 800_000, rotationTokens: 950_000, hardRotationTokens: 970_000 },
  'fable':         { ceiling: 1_000_000, handoffTokens: 800_000, rotationTokens: 950_000, hardRotationTokens: 970_000 },
  'haiku':         { ceiling: 200_000,   handoffTokens: 146_000, rotationTokens: 176_000, hardRotationTokens: 176_000 },
  'eigenbau-llm':  { ceiling: 200_000,   handoffTokens: 146_000, rotationTokens: 176_000, hardRotationTokens: 176_000 },
};
// Token-Budget: zwischen Handoff und Rotation Platz fuer Handoff-Turn (MEMORY sichern +
// thought trigger_respawn + ein grosser Tool-Call); nach der harten Rotation Platz fuer
// EIN maximales Tool-Ergebnis (MCP-Ausgabe ~25k Tokens), damit ein busy Agent nicht
// ueber das Fenster laeuft, bevor der naechste Heartbeat rotiert.
const MIN_HANDOFF_BUDGET = 30_000;
const MIN_REST_NACH_HARD = 24_000;
const nurZahlen = (s) => ({
  ceiling: s.ceiling, handoffTokens: s.handoffTokens,
  rotationTokens: s.rotationTokens, hardRotationTokens: s.hardRotationTokens,
});

for (const [alias, soll] of Object.entries(ERWARTET)) {
  await pruefe(`Schwellen ${alias}: reine Funktion`, () => {
    assert.ok(korridor.berechneKontextSchwellen, 'berechneKontextSchwellen fehlt');
    const eintrag = models.resolveModel(alias);
    assert.deepEqual(nurZahlen(korridor.berechneKontextSchwellen(eintrag, alias)), soll);
  });
  await pruefe(`Schwellen ${alias}: Wrapper-Stufe == erwartet`, () => {
    assert.ok(models.kontextSchwellen, 'models.kontextSchwellen fehlt');
    assert.deepEqual(nurZahlen(models.kontextSchwellen(alias)), soll);
  });
  await pruefe(`Schwellen ${alias}: core-Respawn-Stufe == Wrapper-Stufe`, async () => {
    assert.ok(respawn.pruefeRespawnKorridor, 'pruefeRespawnKorridor fehlt');
    const r = await respawn.pruefeRespawnKorridor({ model: alias, tokens: 0 });
    assert.deepEqual(nurZahlen(r.schwellen), soll);
  });
}

await pruefe('Rueckfall-Kennzeichen: unbekannt = fallback, Registry = registry', () => {
  assert.equal(models.kontextSchwellen('eigenbau-llm').quelle, 'fallback');
  assert.equal(models.kontextSchwellen('opus').quelle, 'registry');
});
await pruefe('Rueckfall: unbekanntes [1m]-Modell rechnet mit 1M, nicht 200k', () => {
  assert.equal(models.kontextSchwellen('eigenbau[1m]').ceiling, 1_000_000);
});

await pruefe('Invariante fuer ALLE Registry-Aliase: handoff+30k <= rotation <= hard <= ceiling', () => {
  for (const alias of Object.keys(models.STATIC_FALLBACK)) {
    const s = models.kontextSchwellen(alias);
    assert.ok(s.handoffTokens + 30_000 <= s.rotationTokens, `${alias}: Handoff ${s.handoffTokens} zu nah an Rotation ${s.rotationTokens}`);
    assert.ok(s.rotationTokens <= s.hardRotationTokens, `${alias}: Rotation nach Hard-Rotation`);
    assert.ok(s.hardRotationTokens <= s.ceiling, `${alias}: Hard-Rotation ueber dem Fenster`);
  }
});

await pruefe('Token-Budget fuer ALLE Claude-Aliase: Handoff >= 30k vor Rotation, >= 24k Rest nach Hard-Rotation', () => {
  for (const [alias, e] of Object.entries(models.STATIC_FALLBACK)) {
    if (e.provider !== 'anthropic') continue;
    const s = models.kontextSchwellen(alias);
    assert.ok(s.rotationTokens - s.handoffTokens >= MIN_HANDOFF_BUDGET, `${alias}: Handoff-Budget ${s.rotationTokens - s.handoffTokens}`);
    assert.ok(s.ceiling - s.hardRotationTokens >= MIN_REST_NACH_HARD, `${alias}: Rest nach Hard-Rotation ${s.ceiling - s.hardRotationTokens}`);
  }
});
await pruefe('Korridore je Groessenklasse: 200k = 73/88, 1M = 80/97 (Claude)', () => {
  for (const [alias, e] of Object.entries(models.STATIC_FALLBACK)) {
    if (e.provider !== 'anthropic') continue;
    const soll = e.contextWindow === 1_000_000 ? [80, 97] : [73, 88];
    assert.deepEqual([e.corridorMin, e.corridorMax], soll, alias);
  }
});
await pruefe('Seed im SCHEMA_SQL: Claude-Zeilen der model_registry == STATIC_FALLBACK (Fenster, Korridor, Preise, Cutoff, Output)', () => {
  const schema = readFileSync(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  const zeilen = [...schema.matchAll(/\('([^']+)',\s*'([^']+)',\s*'anthropic',\s*(\d+),\s*ARRAY\[\]::TEXT\[\],\s*'claude',\s*NULL,\s*(\d+),\s*(\d+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*(NULL|'[\d-]+'),\s*(\d+)\)/g)];
  const imSeed = Object.fromEntries(zeilen.map((m) => [m[1], [
    m[2], Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]), Number(m[8]),
    m[9] === 'NULL' ? null : m[9].slice(1, -1), Number(m[10]),
  ]]));
  const imCode = Object.fromEntries(Object.values(models.STATIC_FALLBACK)
    .filter((e) => e.provider === 'anthropic')
    .map((e) => [e.alias, [
      e.fullId, e.contextWindow, e.corridorMin, e.corridorMax,
      e.pricingInputUsdPerMtok, e.pricingOutputUsdPerMtok, e.pricingCacheUsdPerMtok,
      e.cutoffDate ?? null, e.outputLimit,
    ]]));
  assert.ok(zeilen.length > 0, 'keine Claude-Zeilen im Seed erkannt');
  assert.deepEqual(imSeed, imCode);
});

await pruefe('Registry: 200k ohne [1m], 1M fuer alle [1m]-Aliase und fable/fable-5', () => {
  for (const [alias, e] of Object.entries(models.STATIC_FALLBACK)) {
    if (e.provider !== 'anthropic') continue;
    const soll = alias.endsWith('[1m]') || alias.startsWith('fable') ? 1_000_000 : 200_000;
    assert.equal(e.contextWindow, soll, alias);
  }
});

// ---------------------------------------------------------------------------
// fable: Respawn erst im 1M-Korridor
// ---------------------------------------------------------------------------
await pruefe('fable: 170k Tokens (waeren 85% von 200k) loesen NICHT aus', async () => {
  const r = await respawn.pruefeRespawnKorridor({ model: 'fable', tokens: 170_000 });
  assert.equal(r.ausloesen, false);
});
await pruefe('fable: 800k Tokens loesen aus', async () => {
  const r = await respawn.pruefeRespawnKorridor({ model: 'fable', tokens: 800_000 });
  assert.equal(r.ausloesen, true);
});
await pruefe('fable ohne Tokens, nur Prozent vom Wrapper (17% von 1M) loest NICHT aus', async () => {
  const r = await respawn.pruefeRespawnKorridor({ model: 'fable', percent: 17, contextCeiling: 1_000_000 });
  assert.equal(r.ausloesen, false);
});
await pruefe('fable, DB kennt den Alias noch nicht: Wrapper-Ceiling 1M zaehlt, 170k loest NICHT aus', async () => {
  registryRows = registryRows.filter((z) => z.alias !== 'fable');
  registry.invalidateCache?.();
  try {
    const r = await respawn.pruefeRespawnKorridor({ model: 'fable', tokens: 170_000, contextCeiling: 1_000_000 });
    assert.equal(r.schwellen.ceiling, 1_000_000);
    assert.equal(r.ausloesen, false);
  } finally {
    registryRows = Object.values(models.STATIC_FALLBACK ?? {}).map(alsZeile);
    registry.invalidateCache?.();
  }
});
await pruefe('opus (200k): 150k loesen aus, 140k nicht', async () => {
  assert.equal((await respawn.pruefeRespawnKorridor({ model: 'opus', tokens: 150_000 })).ausloesen, true);
  assert.equal((await respawn.pruefeRespawnKorridor({ model: 'opus', tokens: 140_000 })).ausloesen, false);
});

// ---------------------------------------------------------------------------
// Neustart-Aufforderung ueber den Daemon (REST-Weg)
// ---------------------------------------------------------------------------
const NAME = `korridor-test-${process.pid}`;
await pruefe('REST-Weg: maybeTriggerRespawn(ueberDaemon) reiht Job rotate ein, schreibt KEINEN lokalen Marker', async () => {
  wrapperRow = {
    agent_name: NAME, project: 'testprojekt', model: 'fable', status: 'running', busy: true,
    context_ceiling: 1_000_000, tokens_input: 820_000, tokens_output: 5_000, tokens_percent: 83,
    channels: [], connected_mcp: true, last_activity: new Date().toISOString(),
  };
  jobInserts.length = 0;
  const d = await respawn.maybeTriggerRespawn('testprojekt', NAME, { ueberDaemon: true });
  assert.equal(d.triggered, true, d.message);
  assert.equal(jobInserts.length, 1, 'kein Job eingereiht');
  assert.equal(jobInserts[0].values[1], 'rotate');
  assert.equal(JSON.parse(jobInserts[0].values[2]).name, NAME);
  assert.equal(existsSync(`/tmp/.specialist-rotate-pending-${NAME}`), false, 'Marker lokal geschrieben');
});
await pruefe('REST-Weg: unter dem Korridor kein Job', async () => {
  wrapperRow = { ...wrapperRow, tokens_input: 170_000, tokens_output: 0, tokens_percent: 17 };
  jobInserts.length = 0;
  const d = await respawn.maybeTriggerRespawn('testprojekt', NAME, { ueberDaemon: true });
  assert.equal(d.triggered, false);
  assert.equal(jobInserts.length, 0);
});
await pruefe('Daemon: schreibeRotationsMarker legt den Marker an, der Wrapper-Pfad stimmt', () => {
  assert.ok(worker.schreibeRotationsMarker, 'schreibeRotationsMarker fehlt');
  const dir = mkdtempSync(join(tmpdir(), 'korridor-'));
  try {
    const pfad = worker.schreibeRotationsMarker(NAME, dir);
    assert.equal(pfad, join(dir, `.specialist-rotate-pending-${NAME}`));
    assert.ok(readFileSync(pfad, 'utf8').length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
await pruefe('Daemon: schreibeRotationsMarker lehnt Pfadzeichen im Namen ab', () => {
  assert.ok(worker.schreibeRotationsMarker, 'schreibeRotationsMarker fehlt');
  assert.throws(() => worker.schreibeRotationsMarker('../boese', tmpdir()));
  assert.throws(() => worker.schreibeRotationsMarker('a/b', tmpdir()));
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
