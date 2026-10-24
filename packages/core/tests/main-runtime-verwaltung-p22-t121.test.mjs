/**
 * P22-T121 (R7): Main darf specialist.runtime_* nur ueber die Positivliste MAIN_VERWALTUNG (Schalter main_agentenverwaltung).
 * Rein, ohne DB/Netz.
 *   pnpm --filter @synapse/core build && node packages/core/tests/main-runtime-verwaltung-p22-t121.test.mjs
 * Die Ausweis-Grenze (agent-token-tools.ts) und pruefeSteuerRecht sind unveraendert; deren PG-Pfad deckt
 * main-agentenverwaltung-p22-t79.test.mjs bzw. runtime-agenten-steuerung-p22-t116.test.mjs ab.
 */
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (...p) => import(pathToFileURL(join(repo, ...p)).href);
const H = await load('packages/core/dist/services/hauptagent-sonderstellung.js');
const R = await load('packages/core/dist/services/runtime-agenten-steuerung.js');

assert.equal(R.RUNTIME_TOOL_AKTIONEN.length, 6, 'genau sechs runtime_*-Aktionen');
for (const a of R.RUNTIME_TOOL_AKTIONEN) assert.equal(H.mainVerwaltungErlaubt('specialist', a), true, 'Positivliste enthaelt specialist.' + a);
// Nichts darueber hinaus
for (const [t, a] of [['specialist', 'purge'], ['specialist', 'update_skill'], ['specialist', 'runtime_x'], ['admin', 'runtime_steuern'], ['specialist', undefined]])
  assert.equal(H.mainVerwaltungErlaubt(t, a), false, `${t}.${a} nicht erlaubt`);
// Bestand der bisherigen Liste unveraendert
for (const a of ['spawn', 'spawn_batch', 'stop', 'status', 'wake', 'heartbeat', 'capabilities']) assert.equal(H.mainVerwaltungErlaubt('specialist', a), true);
assert.equal(H.MAIN_VERWALTUNG.size, 24, '18 bisherige + 6 neue');
// Schalter: ohne DB -> AUS (fail closed), d. h. ohne main_agentenverwaltung EIN bleibt main_nur_lesen
assert.equal(H.MAIN_AGENTENVERWALTUNG_FUNKTION, 'main_agentenverwaltung');
assert.equal(await H.mainVerwaltungAktiv(), false, 'Lesefehler -> AUS');
assert.match(H.MAIN_VERWALTUNG_HINWEIS, /runtime_steuern/);
assert.equal(H.mainNurLesenAblehnung('specialist', 'runtime_steuern', 'p').error, 'main_nur_lesen');
console.log('OK main-runtime-verwaltung-p22-t121');
