#!/usr/bin/env node
// test-effort.mjs — Effort-Stufe fuer Claude-Spezialisten (claude --effort).
//
//   1. Angefragter effort landet als `--effort <stufe>` im Argumentvektor der CLI.
//   2. Ohne effort: default_effort des Modells — fest, nicht mehr still effortLevel
//      aus ~/.claude/settings.json des Users. Auch datengetrieben aus model_registry.
//   3. Ungueltiger Wert: Fehler mit den erlaubten Stufen (core, ProcessManager, Spawn).
//   4. Modell ohne Effort-Unterstuetzung (haiku 4.5) und node-Zweig (Gemini): kein Flag.
//   5. Respawn (Rotation, keep_alive) startet im selben Wrapper mit derselben Stufe.
//   6. Anzeige: wrapper_status.effort, capabilities je Modell; SCHEMA_SQL == STATIC_FALLBACK.
//
// Ohne echte DB: pg.Pool.prototype.query/connect ersetzt, DATABASE_URL zeigt ins Leere.
// Die CLI ist ein Fake-`claude` (bzw. `node`) vorn im PATH, der nur seinen
// Argumentvektor in eine Datei schreibt — gestartet wird nichts Echtes.
// Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-effort.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const STUFEN = ['low', 'medium', 'high', 'xhigh', 'max'];
const OHNE_XHIGH = ['low', 'medium', 'high', 'max'];
// Soll je Version. Beleg: eingebetteter Modellkatalog der CLI 2.1.284 (runtime.effort_levels)
// und Mitschnitt des API-Requests (output_config.effort), siehe CLAUDE_VERSIONEN in models.ts.
const SOLL_STUFEN = (fullId) =>
  fullId === 'claude-haiku-4-5-20251001' ? []
    : ['claude-opus-4-6', 'claude-sonnet-4-6'].includes(fullId) ? OHNE_XHIGH : STUFEN;

// ---------------------------------------------------------------------------
// Fake-CLI: `claude` und `node` vorn im PATH schreiben nur ihren Argumentvektor
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'effort-test-'));
for (const bin of ['claude', 'node']) {
  const pfad = join(dir, bin);
  writeFileSync(pfad, '#!/bin/sh\n[ -n "$SYNAPSE_TEST_ARGV_DATEI" ] && printf \'%s\\n\' "$@" > "$SYNAPSE_TEST_ARGV_DATEI"\nexit 0\n');
  chmodSync(pfad, 0o755);
}
const alterPath = process.env.PATH;
process.env.PATH = `${dir}:${alterPath}`;

const models = await lade('../packages/agents/dist/models.js');
const processMod = await lade('../packages/agents/dist/process.js');
const core = await lade('../packages/core/dist/index.js');
const coreRegistry = await lade('../packages/core/dist/services/model-registry.js');
const wrapperStatus = await lade('../packages/core/dist/services/wrapper-status.js');
const specialists = await lade('../packages/mcp-server/dist/tools/specialists.js');

// ---------------------------------------------------------------------------
// Fake-DB: Registry aus STATIC_FALLBACK, sonnet mit abweichendem default_effort
// ---------------------------------------------------------------------------
const alsZeile = (e) => ({
  alias: e.alias, full_id: e.fullId, provider: e.provider, context_window: e.contextWindow,
  output_limit: null, env_required: e.envRequired, runtime_binary: e.binary, runtime_path: e.runtimePath ?? null,
  corridor_min: e.corridorMin, corridor_max: e.corridorMax,
  pricing_input_usd_per_mtok: null, pricing_output_usd_per_mtok: null, pricing_cache_usd_per_mtok: null,
  cutoff_date: null, enabled: true,
  default_effort: e.alias === 'sonnet' ? 'high' : (e.defaultEffort ?? null),
  effort_stufen: e.effortStufen ?? null,
});
const registryRows = Object.values(models.STATIC_FALLBACK ?? {}).map(alsZeile);
const statusInserts = [];
let statusZeile = null;

pg.Pool.prototype.query = async function (sql, values = []) {
  const text = typeof sql === 'string' ? sql : sql.text;
  if (/FROM model_registry/i.test(text)) return { rows: registryRows, rowCount: registryRows.length };
  if (/INSERT INTO wrapper_status/i.test(text)) {
    statusInserts.push({ sql: text, values });
    return { rows: [], rowCount: 1 };
  }
  if (/FROM wrapper_status/i.test(text)) return { rows: statusZeile ? [statusZeile] : [], rowCount: statusZeile ? 1 : 0 };
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

/** Startet einen Fake-Agenten und liefert den Argumentvektor, den die CLI bekam. */
async function argvVon(model, opts = {}) {
  const pm = new processMod.ProcessManager();
  const name = `effort-${model.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
  const datei = join(dir, `${name}.argv`);
  process.env.SYNAPSE_TEST_ARGV_DATEI = datei;
  const ende = new Promise((resolve) => {
    const fertig = (n) => { if (n === name) resolve(); };
    pm.on('exit', fertig);
    pm.on('error', fertig);
    setTimeout(resolve, 5000).unref();
  });
  await pm.start(name, model, 'Testprompt', { cwd: dir, projectPath: dir, projectName: 'testprojekt', ...opts });
  await ende;
  assert.ok(existsSync(datei), `Fake-CLI wurde nicht gestartet (${model})`);
  return readFileSync(datei, 'utf8').split('\n').filter((z) => z.length > 0);
}
function effortIn(argv) {
  const i = argv.indexOf('--effort');
  return i < 0 ? undefined : argv[i + 1];
}

// ---------------------------------------------------------------------------
// 1. Core: pruefeEffort
// ---------------------------------------------------------------------------
await pruefe('core: EFFORT_STUFEN = low|medium|high|xhigh|max', () => {
  assert.deepEqual([...(core.EFFORT_STUFEN ?? [])], STUFEN);
});
await pruefe('core: pruefeEffort nimmt gueltige Stufen, leer/undefined = keine Angabe', () => {
  assert.equal(core.pruefeEffort('high'), 'high');
  assert.equal(core.pruefeEffort(undefined), undefined);
  assert.equal(core.pruefeEffort(null), undefined);
  assert.equal(core.pruefeEffort(''), undefined);
});
await pruefe('core: pruefeEffort lehnt "turbo" ab und nennt die erlaubten Werte', () => {
  assert.throws(() => core.pruefeEffort('turbo'), (err) => /turbo/.test(err.message) && /low, medium, high, xhigh, max/.test(err.message));
  assert.throws(() => core.pruefeEffort('HIGH'));
});

// ---------------------------------------------------------------------------
// 2. STATIC_FALLBACK
// ---------------------------------------------------------------------------
await pruefe('STATIC_FALLBACK: Stufen je Version (haiku keine, opus-4.6/sonnet-4.6 ohne xhigh, sonst low..max)', () => {
  for (const e of Object.values(models.STATIC_FALLBACK)) {
    if (e.provider !== 'anthropic') continue;
    assert.deepEqual(e.effortStufen, SOLL_STUFEN(e.fullId), e.alias);
    assert.equal(e.defaultEffort, e.effortStufen.length > 0 ? 'medium' : undefined, e.alias);
  }
});
await pruefe('STATIC_FALLBACK: default_effort ist immer in effort_stufen enthalten', () => {
  let geprueft = 0;
  for (const e of Object.values(models.STATIC_FALLBACK)) {
    if (e.defaultEffort === undefined) continue;
    geprueft++;
    assert.ok((e.effortStufen ?? []).includes(e.defaultEffort), `${e.alias}: ${e.defaultEffort} nicht in ${e.effortStufen}`);
  }
  assert.ok(geprueft > 0, 'Anker: kein Modell mit default_effort');
});
await pruefe('STATIC_FALLBACK: Gemini/Antigravity (node) ohne Effort-Stufen', () => {
  for (const e of Object.values(models.STATIC_FALLBACK)) {
    if (e.binary !== 'node') continue;
    assert.equal((e.effortStufen ?? []).length, 0, e.alias);
  }
});

// ---------------------------------------------------------------------------
// 3. ProcessManager: Argumentvektor der CLI (STATIC_FALLBACK, DB noch nicht geladen)
// ---------------------------------------------------------------------------
await pruefe('claude-Zweig: effort high -> "--effort high"', async () => {
  const argv = await argvVon('opus', { effort: 'high' });
  assert.ok(argv.includes('--model'), 'Anker: kein --model im Argumentvektor');
  assert.equal(effortIn(argv), 'high');
});
await pruefe('claude-Zweig: ohne effort -> default_effort des Modells (medium), nicht geerbt', async () => {
  const argv = await argvVon('opus');
  assert.ok(argv.includes('--model'), 'Anker: kein --model im Argumentvektor');
  assert.equal(effortIn(argv), 'medium');
});
await pruefe('claude-Zweig: versionierter Alias (opus-4.7[1m]) bekommt die Stufe ebenso', async () => {
  const argv = await argvVon('opus-4.7[1m]', { effort: 'max' });
  assert.equal(effortIn(argv), 'max');
});
await pruefe('haiku (keine Effort-Stufen): ohne Angabe kein --effort', async () => {
  const argv = await argvVon('haiku');
  assert.ok(argv.includes('--model'), 'Anker: kein --model im Argumentvektor');
  assert.equal(argv.includes('--effort'), false);
});
await pruefe('haiku mit effort: Fehler statt still verworfen', async () => {
  const pm = new processMod.ProcessManager();
  await assert.rejects(
    () => pm.start('effort-haiku', 'haiku', 'Testprompt', { cwd: dir, effort: 'high' }),
    (err) => /haiku/.test(err.message) && /kein/i.test(err.message),
  );
});
await pruefe('opus-4.6 mit xhigh: Fehler mit den Stufen DIESES Modells (kein stiller Rueckfall auf high)', async () => {
  const pm = new processMod.ProcessManager();
  await assert.rejects(
    () => pm.start('effort-opus46', 'opus-4.6', 'Testprompt', { cwd: dir, effort: 'xhigh' }),
    (err) => /xhigh/.test(err.message) && /low, medium, high, max\b/.test(err.message) && !/high, xhigh/.test(err.message),
  );
});
await pruefe('opus-4.6 mit max: erlaubt -> "--effort max"', async () => {
  const argv = await argvVon('opus-4.6', { effort: 'max' });
  assert.equal(effortIn(argv), 'max');
});
await pruefe('ungueltiger effort: start() schlaegt mit den erlaubten Werten fehl', async () => {
  const pm = new processMod.ProcessManager();
  await assert.rejects(
    () => pm.start('effort-ungueltig', 'opus', 'Testprompt', { cwd: dir, effort: 'turbo' }),
    (err) => /low, medium, high, xhigh, max/.test(err.message),
  );
});
await pruefe('node-Zweig (gemini-flash): kein --effort, kein Fehler', async () => {
  const argv = await argvVon('gemini-flash', { effort: 'high' });
  assert.ok(argv.length > 0 && /runtime/.test(argv[0]), `Anker: Runtime-Pfad fehlt (${argv[0]})`);
  assert.equal(argv.includes('--effort'), false);
});

// ---------------------------------------------------------------------------
// 4. Respawn: Rotation und keep_alive starten den inneren Prozess im selben Wrapper
// ---------------------------------------------------------------------------
await pruefe('Wrapper: jeder Start (Erststart, Rotation, keep_alive) nimmt AGENT_EFFORT aus SYNAPSE_AGENT_EFFORT', () => {
  const quelle = readFileSync(new URL('../packages/agents/dist/wrapper.js', import.meta.url), 'utf8');
  const def = quelle.indexOf('async function startAgentProcess(');
  assert.ok(def >= 0, 'Anker: startAgentProcess fehlt');
  assert.ok((quelle.match(/startAgentProcess\(/g) ?? []).length >= 3, 'Anker: Rotation ruft startAgentProcess nicht mehr');
  assert.match(quelle, /const AGENT_EFFORT = process\.env\.SYNAPSE_AGENT_EFFORT/);
  assert.equal((quelle.match(/processManager\.start\(/g) ?? []).length, 1, 'mehr als ein Startweg');
  const rumpf = quelle.slice(def, quelle.indexOf('\n}', def));
  assert.match(rumpf, /effort: AGENT_EFFORT/);
});
await pruefe('Neustart mit derselben Stufe: zweiter Start liefert wieder "--effort xhigh"', async () => {
  const erst = await argvVon('fable', { effort: 'xhigh' });
  const zweit = await argvVon('fable', { effort: 'xhigh' });
  assert.equal(effortIn(erst), 'xhigh');
  assert.equal(effortIn(zweit), 'xhigh');
});
await pruefe('Spawn setzt SYNAPSE_AGENT_EFFORT ausdruecklich (kein Erben aus einem Eltern-Spezialisten)', () => {
  const quelle = readFileSync(new URL('../packages/mcp-server/dist/tools/specialists.js', import.meta.url), 'utf8');
  assert.match(quelle, /SYNAPSE_AGENT_EFFORT: effortWirksam \?\? ''/);
});

// ---------------------------------------------------------------------------
// 5. Spawn: Validierung vor jedem Seiteneffekt
// ---------------------------------------------------------------------------
await pruefe('spawnSpecialistTool: ungueltiger effort -> success:false mit erlaubten Werten', async () => {
  const antwort = await specialists.spawnSpecialistTool(
    'effort-test', 'opus', 'Test', 'Test', 'testprojekt', '/nicht/vorhanden/testprojekt',
    undefined, undefined, undefined, undefined, 'turbo',
  );
  const daten = JSON.parse(antwort.content[0].text);
  assert.equal(daten.success, false);
  assert.match(daten.message, /turbo/);
  assert.match(daten.message, /low, medium, high, xhigh, max/);
});

await pruefe('spawnSpecialistTool: sonnet-4.6 mit xhigh -> success:false mit den Stufen des Modells', async () => {
  const antwort = await specialists.spawnSpecialistTool(
    'effort-test', 'sonnet-4.6', 'Test', 'Test', 'testprojekt', '/nicht/vorhanden/testprojekt',
    undefined, undefined, undefined, undefined, 'xhigh',
  );
  const daten = JSON.parse(antwort.content[0].text);
  assert.equal(daten.success, false);
  assert.match(daten.message, /low, medium, high, max\b/);
});

// ---------------------------------------------------------------------------
// 6. Datengetrieben: default_effort aus model_registry (DB jetzt geladen)
// ---------------------------------------------------------------------------
await pruefe('core model-registry: default_effort/effort_stufen kommen aus der Zeile', async () => {
  coreRegistry.invalidateCache();
  const sonnet = await coreRegistry.getModel('sonnet');
  assert.equal(sonnet.defaultEffort, 'high');
  assert.deepEqual(sonnet.effortStufen, STUFEN);
  const haiku = await coreRegistry.getModel('haiku');
  assert.deepEqual(haiku.effortStufen, []);
  const opus46 = await coreRegistry.getModel('opus-4.6');
  assert.deepEqual(opus46.effortStufen, OHNE_XHIGH);
});
await pruefe('DB-Registry: sonnet mit default_effort high -> "--effort high" ohne Angabe', async () => {
  await models.loadFromDb();
  assert.equal(models.resolveModel('sonnet')?.defaultEffort, 'high');
  assert.deepEqual(models.resolveModel('opus-4.6')?.effortStufen, OHNE_XHIGH);
  const argv = await argvVon('sonnet');
  assert.equal(effortIn(argv), 'high');
});

// ---------------------------------------------------------------------------
// 7. Anzeige: wrapper_status und capabilities
// ---------------------------------------------------------------------------
await pruefe('wrapper_status: upsert schreibt effort, getWrapperStatus liest es', async () => {
  statusInserts.length = 0;
  await wrapperStatus.upsertWrapperStatus({ agentName: 'effort-a', project: 'testprojekt', effort: 'high' });
  assert.equal(statusInserts.length, 1);
  assert.match(statusInserts[0].sql, /\beffort\b/);
  assert.ok(statusInserts[0].values.includes('high'), 'effort nicht als Parameter uebergeben');
  statusZeile = {
    agent_name: 'effort-a', project: 'testprojekt', model: 'opus', status: 'running', busy: false,
    channels: [], connected_mcp: true, last_activity: new Date().toISOString(), effort: 'high',
  };
  const row = await wrapperStatus.getWrapperStatus('effort-a', 'testprojekt');
  assert.equal(row.effort, 'high');
});
await pruefe('capabilities (lokal): Effort-Stufen und default_effort je Modell', () => {
  const daten = JSON.parse(specialists.getAgentCapabilitiesTool().content[0].text);
  assert.deepEqual(daten.effortStufen, STUFEN);
  const je = Object.fromEntries((daten.models ?? []).map((m) => [m.alias, m]));
  assert.equal(je.opus?.defaultEffort, 'medium');
  assert.equal(je.sonnet?.defaultEffort, 'high');
  assert.equal(je.haiku?.effortSupported, false);
  assert.deepEqual(je.haiku?.effortStufen, []);
  assert.deepEqual(je['opus-4.6']?.effortStufen, OHNE_XHIGH);
  assert.deepEqual(je.fable?.effortStufen, STUFEN);
});

// ---------------------------------------------------------------------------
// 8. SCHEMA_SQL und Spiegel
// ---------------------------------------------------------------------------
await pruefe('SCHEMA_SQL: Spalten default_effort/effort_stufen (model_registry) und effort (wrapper_status)', () => {
  const schema = readFileSync(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  assert.match(schema, /ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS default_effort TEXT;/);
  assert.match(schema, /ALTER TABLE model_registry ADD COLUMN IF NOT EXISTS effort_stufen TEXT\[\];/);
  assert.doesNotMatch(schema, /effort_supported/, 'effort_supported ist durch effort_stufen ersetzt');
  assert.match(schema, /ALTER TABLE wrapper_status ADD COLUMN IF NOT EXISTS effort TEXT;/);
});
await pruefe('SCHEMA_SQL: Nachtrag effort_stufen/default_effort == STATIC_FALLBACK je Version', () => {
  const schema = readFileSync(new URL('../packages/core/dist/db/schema.js', import.meta.url), 'utf8');
  const m = schema.match(/UPDATE model_registry[\s\S]*?effort_stufen IS NULL[^;]*;/);
  assert.ok(m, 'Anker: UPDATE fuer effort fehlt');
  // WHEN full_id IN ('a', 'b') THEN ARRAY['low', ...]
  const imSql = {};
  for (const w of m[0].matchAll(/WHEN full_id IN \(([^)]*)\)\s+THEN ARRAY\[([^\]]*)\]/g)) {
    const stufen = [...w[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    for (const id of [...w[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) imSql[id] = stufen;
  }
  const imCode = Object.fromEntries(Object.values(models.STATIC_FALLBACK)
    .filter((e) => e.provider === 'anthropic').map((e) => [e.fullId, e.effortStufen]));
  assert.ok(Object.keys(imSql).length > 0, 'Anker: keine WHEN-Zweige erkannt');
  assert.deepEqual(imSql, imCode);
  // default_effort medium ausser fuer die Modelle ohne Stufen (NULL)
  const ohne = m[0].match(/default_effort = CASE WHEN full_id IN \(([^)]*)\) THEN NULL ELSE 'medium' END/);
  assert.ok(ohne, 'Anker: default_effort-CASE fehlt');
  const ohneSql = [...ohne[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  const ohneCode = [...new Set(Object.values(models.STATIC_FALLBACK)
    .filter((e) => e.provider === 'anthropic' && e.defaultEffort === undefined).map((e) => e.fullId))].sort();
  assert.deepEqual(ohneSql, ohneCode);
});
await pruefe('schema-sql-Spiegel: Spalten stehen in 40_agenten.sql und 45_modelle_embedding.sql', () => {
  const agenten = readFileSync(new URL('../packages/core/src/db/schema-sql/40_agenten.sql', import.meta.url), 'utf8');
  const modelle = readFileSync(new URL('../packages/core/src/db/schema-sql/45_modelle_embedding.sql', import.meta.url), 'utf8');
  const ws = agenten.slice(agenten.indexOf('CREATE TABLE public.wrapper_status'));
  assert.match(ws.slice(0, ws.indexOf(');')), /\beffort text\b/);
  const mr = modelle.slice(modelle.indexOf('CREATE TABLE public.model_registry'));
  const rumpf = mr.slice(0, mr.indexOf(');'));
  assert.match(rumpf, /\bdefault_effort text\b/);
  assert.match(rumpf, /\beffort_stufen text\[\]/);
  assert.doesNotMatch(rumpf, /effort_supported/);
});
await pruefe('Update-Skript pflegt effort_stufen mit (legt die Spalte an, kein effort_supported mehr)', () => {
  const skript = readFileSync(new URL('./modelle-2026-09-aktualisieren.mjs', import.meta.url), 'utf8');
  assert.match(skript, /effort_stufen = EXCLUDED\.effort_stufen/);
  assert.match(skript, /ADD COLUMN IF NOT EXISTS effort_stufen TEXT\[\]/);
  assert.doesNotMatch(skript, /effort_supported/);
});

process.env.PATH = alterPath;
rmSync(dir, { recursive: true, force: true });
console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
