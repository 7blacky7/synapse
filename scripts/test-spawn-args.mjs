#!/usr/bin/env node
// test-spawn-args.mjs — P7-T9: Spawn-Wege (REST-Route, Tool ueber REST) liefern dem Daemon-Worker
// dieselben Felder in Worker-Form (snake_case), nie den String "undefined". Ohne DB.
//   - normalisiereSpawnEintrag / normalisiereSpawnBatch / baueSpawnJobArgs / pruefeSpawnEffort
//   - keep_alive: KEIN einheitlicher Standard; jeder Weg uebergibt seinen (REST/Web-KI false)
//   - Verdrahtung: routes/specialists.ts + routes/mcp.ts nutzen die gemeinsame Funktion (Quelltext)
// Aufruf: node scripts/test-spawn-args.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const m = await import('../packages/core/dist/services/specialist-spawn-args.js');
const { normalisiereSpawnEintrag, normalisiereSpawnBatch, baueSpawnJobArgs, pruefeSpawnEffort, SPAWN_BATCH_MAX } = m;

const OPT = { project: 'synapse', projectPath: '/home/blacky/dev/synapse', keepAliveStandard: false };
const basis = { name: 'doc-bot', model: 'sonnet', expertise: 'Doku', task: 'Schreibe Doku' };

// Die Felder, die der HEUTIGE Worker (specialist-job-worker.ts, case 'spawn') liest.
const WORKER_FELDER = ['name', 'model', 'expertise', 'task', 'project', 'project_path'];

await pruefe('Worker-Form: Pflichtfelder gesetzt, kein "undefined", keine camelCase-Reste', () => {
  const r = normalisiereSpawnEintrag(basis, OPT);
  assert.equal(r.ok, true);
  for (const f of WORKER_FELDER) {
    assert.equal(typeof r.args[f], 'string', f);
    assert.notEqual(r.args[f], 'undefined', f);
    assert.ok(r.args[f].length > 0, f);
  }
  assert.equal(r.args.project, 'synapse');
  assert.equal(r.args.project_path, '/home/blacky/dev/synapse');
  assert.ok(!('allowedTools' in r.args) && !('keepAlive' in r.args));
});

await pruefe('Alle Felder in Worker-Form: allowed_tools, channel, keep_alive, cwd, effort', () => {
  const r = normalisiereSpawnEintrag({ ...basis, channel: 'c', allowed_tools: ['Read', 'Edit'], keep_alive: true, cwd: '/x', effort: 'high' }, OPT);
  assert.deepEqual(r.args, {
    name: 'doc-bot', model: 'sonnet', expertise: 'Doku', task: 'Schreibe Doku',
    project: 'synapse', project_path: '/home/blacky/dev/synapse',
    cwd: '/x', channel: 'c', allowed_tools: ['Read', 'Edit'], keep_alive: true, effort: 'high',
  });
});

await pruefe('camelCase-Alias: allowedTools, keepAlive', () => {
  const r = normalisiereSpawnEintrag({ ...basis, allowedTools: ['Read'], keepAlive: true }, OPT);
  assert.deepEqual(r.args.allowed_tools, ['Read']);
  assert.equal(r.args.keep_alive, true);
});

await pruefe('snake_case gewinnt vor camelCase', () => {
  const r = normalisiereSpawnEintrag({ ...basis, allowed_tools: ['A'], allowedTools: ['B'], keep_alive: false, keepAlive: true }, OPT);
  assert.deepEqual(r.args.allowed_tools, ['A']);
  assert.equal(r.args.keep_alive, false);
});

await pruefe('keep_alive: Standard je Weg, ausdruecklicher Wert schlaegt Standard, undefined laesst das Feld weg', () => {
  assert.equal(normalisiereSpawnEintrag(basis, { ...OPT, keepAliveStandard: false }).args.keep_alive, false);
  assert.equal(normalisiereSpawnEintrag(basis, { ...OPT, keepAliveStandard: true }).args.keep_alive, true);
  assert.equal(normalisiereSpawnEintrag({ ...basis, keep_alive: true }, { ...OPT, keepAliveStandard: false }).args.keep_alive, true);
  assert.equal(normalisiereSpawnEintrag({ ...basis, keep_alive: 'true' }, OPT).args.keep_alive, true);
  assert.ok(!('keep_alive' in normalisiereSpawnEintrag(basis, { project: 'p', projectPath: '/p' }).args));
});

await pruefe('Pflichtfelder: klare Meldung mit Feldnamen (leer/fehlend/Leerzeichen)', () => {
  const r = normalisiereSpawnEintrag({ name: 'x', model: 'sonnet', expertise: '  ' }, OPT);
  assert.equal(r.ok, false);
  assert.match(r.fehler, /expertise, task/);
  assert.equal(normalisiereSpawnEintrag({}, OPT).ok, false);
  assert.equal(normalisiereSpawnEintrag(null, OPT).ok, false);
  assert.equal(normalisiereSpawnEintrag([basis], OPT).ok, false);
});

await pruefe('Projektpfad/Projekt fehlen -> Fehler statt "undefined"', () => {
  assert.match(normalisiereSpawnEintrag(basis, { ...OPT, projectPath: '' }).fehler, /Projektpfad/);
  assert.match(normalisiereSpawnEintrag(basis, { ...OPT, project: '' }).fehler, /project/);
});

await pruefe('Leere Listen/Strings werden weggelassen, Werte getrimmt', () => {
  const r = normalisiereSpawnEintrag({ ...basis, name: ' doc-bot ', channel: ' ', allowed_tools: [], cwd: '' }, OPT);
  assert.equal(r.args.name, 'doc-bot');
  assert.ok(!('channel' in r.args) && !('allowed_tools' in r.args) && !('cwd' in r.args));
});

await pruefe('spawn_batch: Worker-Form {project, project_path, specialists[]}, Items ohne project/path', () => {
  const r = baueSpawnJobArgs('spawn_batch', { specialists: [basis, { ...basis, name: 'b', keepAlive: true }] }, OPT);
  assert.equal(r.ok, true);
  assert.equal(r.args.project, 'synapse');
  assert.equal(r.args.project_path, '/home/blacky/dev/synapse');
  assert.equal(r.args.specialists.length, 2);
  assert.equal(r.args.specialists[0].keep_alive, false);
  assert.equal(r.args.specialists[1].keep_alive, true);
  assert.ok(!('project' in r.args.specialists[0]));
});

await pruefe('spawn_batch: leer / zu gross / fehlerhaftes Item mit Index', () => {
  assert.equal(baueSpawnJobArgs('spawn_batch', {}, OPT).ok, false);
  assert.equal(baueSpawnJobArgs('spawn_batch', { specialists: [] }, OPT).ok, false);
  const zuViele = Array.from({ length: SPAWN_BATCH_MAX + 1 }, (_, i) => ({ ...basis, name: `n${i}` }));
  assert.match(normalisiereSpawnBatch(zuViele, OPT).fehler, /Max 10/);
  const r = baueSpawnJobArgs('spawn_batch', { specialists: [basis, { name: 'x' }] }, OPT);
  assert.equal(r.ok, false);
  assert.match(r.fehler, /specialists\[1\].*model/);
});

await pruefe('baueSpawnJobArgs spawn: identisch zu normalisiereSpawnEintrag', () => {
  const a = baueSpawnJobArgs('spawn', basis, OPT);
  assert.deepEqual(a.args, normalisiereSpawnEintrag(basis, OPT).args);
});

await pruefe('pruefeSpawnEffort: Tippfehler sofort, Stufe gegen Modell, andere Binaries ohne Pruefung', async () => {
  const getModel = async alias => (alias === 'sonnet-4.6'
    ? { alias, binary: 'claude', effortStufen: ['low', 'medium', 'high'], defaultEffort: 'medium' }
    : { alias, binary: 'node', effortStufen: [], defaultEffort: null });
  await pruefeSpawnEffort('sonnet-4.6', undefined, { getModel });
  await pruefeSpawnEffort('sonnet-4.6', 'high', { getModel });
  await pruefeSpawnEffort('gemini-flash', 'max', { getModel });
  await assert.rejects(() => pruefeSpawnEffort('sonnet-4.6', 'xhigh', { getModel }));
  await assert.rejects(() => pruefeSpawnEffort('sonnet-4.6', 'ultra', { getModel }));
});

await pruefe('Verdrahtung: Route + mcp.ts nutzen die gemeinsame Funktion, Schema mit specialists', async () => {
  const route = await readFile(new URL('../packages/rest-api/src/routes/specialists.ts', import.meta.url), 'utf8');
  assert.match(route, /baueSpawnJobArgs/);
  assert.match(route, /pruefeSpawnEffort/);
  assert.match(route, /keepAliveStandard: false/);
  const mcp = await readFile(new URL('../packages/rest-api/src/routes/mcp.ts', import.meta.url), 'utf8');
  assert.match(mcp, /baueSpawnJobArgs/);
  assert.match(mcp, /pruefeSpawnEffort/);
  assert.match(mcp, /specialists: \{\s*type: 'array'/);
  const stdio = await readFile(new URL('../packages/mcp-server/src/tools/consolidated/specialist.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(stdio, /Standard: false \(nur fuer kurze One-Shot-Tasks\)/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
