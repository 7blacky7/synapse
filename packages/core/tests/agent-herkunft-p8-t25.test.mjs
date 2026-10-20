// P8-T25: Herkunft aus specialist_jobs.claimed_by. Pur, gegen den GEBAUTEN dist.
// Start aus dem Repo-Root: node --test packages/core/tests/agent-herkunft-p8-t25.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { herkunftAusDaemonId } from '../dist/services/agent-herkunft.js';

test('Runtime-Daemon im Unraid-Container', () => {
  assert.deepEqual(herkunftAusDaemonId('daemon-synapse-runtime-claude-1'), { art: 'unraid', ort: 'claude', quelle: 'specialist_jobs.claimed_by' });
  assert.equal(herkunftAusDaemonId('daemon-synapse-runtime-codex').ort, 'codex');
  assert.equal(herkunftAusDaemonId('daemon-synapse-runtime-free-pool-3').ort, 'free-pool');
});

test('PC-Daemon mit Hostname, PID wird abgeschnitten', () => {
  assert.deepEqual(herkunftAusDaemonId('daemon-cachyos-x64-2642477'), { art: 'pc', ort: 'cachyos-x64', quelle: 'specialist_jobs.claimed_by' });
  assert.equal(herkunftAusDaemonId('daemon-workstation').ort, 'workstation');
});

test('Unbekanntes Format bleibt sonstiger Ort mit Rohwert', () => {
  assert.deepEqual(herkunftAusDaemonId('irgendwas'), { art: 'sonstig', ort: 'irgendwas', quelle: 'specialist_jobs.claimed_by' });
});
