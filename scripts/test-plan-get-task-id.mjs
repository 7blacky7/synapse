#!/usr/bin/env node
// test-plan-get-task-id.mjs — Bug 2faebaf8: plan(get, task_id) ignorierte task_id (lieferte alle Tasks).
//   - filtereNachTaskIds: UUID, Kurz-ID (P7-T10), Alias-Kurz-ID (P2-T376 -> P7-T10), Array, gross/klein,
//     unbekannte IDs unter nichtGefunden, ohne task_id unveraendert, Reihenfolge = Plan-Reihenfolge
//   - zurueckgestellte Tasks: ausdrueckliche task_id zeigt sie (Zusammenspiel mit filtereWiedervorlageTasks)
//   - Verdrahtung: REST routes/mcp.ts + stdio consolidated/plan.ts nutzen die gemeinsame Funktion (Quelltext)
// Aufruf: node scripts/test-plan-get-task-id.mjs   (Exit 1 bei Fehler)
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

const plans = await import('../packages/core/dist/services/plans.js');
const { filtereNachTaskIds, filtereWiedervorlageTasks } = plans;

const U1 = 'd3035831-5d7f-49dc-8616-1d200ede93d1';
const U2 = '0841fbff-32c0-422e-b771-51927e41071e';
const U3 = '18fe3ceb-ff34-4702-86c9-f93eb915f12c';
const tasks = [
  { id: U1, kurz_id: 'P7-T10', title: 'A', status: 'todo', alias_kurz_ids: ['P2-T376'] },
  { id: U2, kurz_id: 'P7-T29', title: 'B', status: 'done' },
  { id: U3, kurz_id: 'P7-T11', title: 'C', status: 'todo', alias_kurz_ids: ['P2-T377', 'P4-T3'] },
];

await pruefe('ohne task_id: alles unveraendert', () => {
  for (const leer of [undefined, null, []]) {
    const r = filtereNachTaskIds(tasks, leer);
    assert.equal(r.tasks.length, 3);
    assert.deepEqual(r.nichtGefunden, []);
    assert.equal(r.gefiltert, false);
  }
});

await pruefe('Kurz-ID: nur diese Task', () => {
  const r = filtereNachTaskIds(tasks, ['P7-T10']);
  assert.deepEqual(r.tasks.map(t => t.id), [U1]);
  assert.equal(r.gefiltert, true);
});

await pruefe('UUID', () => {
  assert.deepEqual(filtereNachTaskIds(tasks, [U2]).tasks.map(t => t.id), [U2]);
});

await pruefe('Alias-Kurz-ID (P2-T376 -> P7-T10, P4-T3 -> P7-T11)', () => {
  assert.deepEqual(filtereNachTaskIds(tasks, ['P2-T376']).tasks.map(t => t.id), [U1]);
  assert.deepEqual(filtereNachTaskIds(tasks, ['P4-T3']).tasks.map(t => t.id), [U3]);
});

await pruefe('gross/klein und Leerzeichen egal', () => {
  assert.deepEqual(filtereNachTaskIds(tasks, [' p7-t10 ']).tasks.map(t => t.id), [U1]);
  assert.deepEqual(filtereNachTaskIds(tasks, [U2.toUpperCase()]).tasks.map(t => t.id), [U2]);
});

await pruefe('mehrere IDs gemischt: Plan-Reihenfolge, Duplikate einmal', () => {
  const r = filtereNachTaskIds(tasks, ['P7-T11', U1, 'P2-T377']);
  assert.deepEqual(r.tasks.map(t => t.id), [U1, U3]);
  assert.deepEqual(r.nichtGefunden, []);
});

await pruefe('unbekannte ID unter nichtGefunden, Rest kommt', () => {
  const r = filtereNachTaskIds(tasks, ['P7-T10', 'P9-T99', 'kaputt']);
  assert.deepEqual(r.tasks.map(t => t.id), [U1]);
  assert.deepEqual(r.nichtGefunden, ['P9-T99', 'kaputt']);
});

await pruefe('nur unbekannte IDs -> leere Liste, nicht alles', () => {
  const r = filtereNachTaskIds(tasks, ['P9-T99']);
  assert.equal(r.tasks.length, 0);
  assert.deepEqual(r.nichtGefunden, ['P9-T99']);
  assert.equal(r.gefiltert, true);
});

await pruefe('leere/nicht-String-Eintraege werden verworfen', () => {
  const r = filtereNachTaskIds(tasks, ['', '  ', 'P7-T29']);
  assert.deepEqual(r.tasks.map(t => t.id), [U2]);
  assert.deepEqual(r.nichtGefunden, []);
});

await pruefe('zurueckgestellte Task: ausdrueckliche task_id zeigt sie, dann Filter darauf', () => {
  const zukunft = new Date(Date.now() + 5 * 86400_000).toISOString();
  const mitSchlaf = tasks.map(t => (t.id === U1 ? { ...t, zurueckgestellt_bis: zukunft } : t));
  const wv = filtereWiedervorlageTasks(mitSchlaf, { taskIds: ['P2-T376'] });
  const r = filtereNachTaskIds(wv.tasks, ['P2-T376']);
  assert.deepEqual(r.tasks.map(t => t.id), [U1]);
});

await pruefe('Verdrahtung: REST + stdio nutzen filtereNachTaskIds', async () => {
  const rest = await readFile(new URL('../packages/rest-api/src/routes/mcp.ts', import.meta.url), 'utf8');
  const stdio = await readFile(new URL('../packages/mcp-server/src/tools/consolidated/plan.ts', import.meta.url), 'utf8');
  assert.match(rest, /filtereNachTaskIds\(/);
  assert.match(stdio, /filtereNachTaskIds\(/);
  assert.match(rest, /tasks_nicht_gefunden/);
  assert.match(stdio, /tasks_nicht_gefunden/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
