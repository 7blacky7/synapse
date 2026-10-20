/**
 * P22-T4 Testphase (U4): claude-/codex-driver assertOwnedContainer akzeptiert den auf synapse-agent-runtime umgestellten
 * Container (gleiche Labels/Binds + Label synapse.runtime-image=agent-runtime), auch wenn agent_runtime_instances.image
 * noch das alte Image nennt. Ohne das Label bleibt er fremd. Fake-Docker und Fake-Repository; kein PG, kein Docker.
 *   node --test packages/rest-api/tests/runtime-driver-image-p22-t4.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'services', 'agent-runtime');
const { CodexRuntimeDriver, persistentRuntimeBinds } = await import(pathToFileURL(join(dist, 'codex-driver.js')).href);
const { ClaudeRuntimeDriver } = await import(pathToFileURL(join(dist, 'claude-driver.js')).href);

function aufbau(runtime, { image, label }) {
  const root = `/mnt/z/dockdata/synapse-agent-runtime/${runtime}`;
  const config = { runtime, rootPath: root, image: 'node:22-bookworm-slim', containerName: `synapse-runtime-${runtime}`,
    model: null, assignedToMain: false, containerId: null };
  const gestartet = [];
  const labels = { 'synapse.agent-runtime': 'true', 'synapse.runtime': runtime, 'synapse.agent-role': 'main', 'synapse.runtime-root': root,
    ...(label ? { 'synapse.runtime-image': 'agent-runtime' } : {}) };
  const container = {
    id: 'c-' + runtime,
    async inspect() { return { Id: 'c-' + runtime, Config: { Image: image, Labels: labels }, HostConfig: { Binds: persistentRuntimeBinds(root), PidsLimit: 256 }, State: { Running: false, Status: 'exited' } }; },
    async start() { gestartet.push(runtime); },
  };
  const docker = { async ping() {}, getContainer: () => container, modem: {} };
  const repository = {
    async ensureCodex() { return config; }, async ensureClaude() { return config; },
    async get() { return config; }, async updateObserved() {}, async clearContainer() {},
  };
  return { docker, repository, gestartet };
}

for (const [runtime, Driver] of [['codex', CodexRuntimeDriver], ['claude', ClaudeRuntimeDriver]]) {
  test(`${runtime}: neues Image MIT Label agent-runtime ist eigener Container (start geht)`, async () => {
    const a = aufbau(runtime, { image: 'synapse-agent-runtime:t-test', label: true });
    const d = new Driver(a.repository, a.docker);
    await d.start();
    assert.deepEqual(a.gestartet, [runtime]);
  });

  test(`${runtime}: neues Image OHNE Label bleibt fremd`, async () => {
    const a = aufbau(runtime, { image: 'synapse-agent-runtime:t-test', label: false });
    const d = new Driver(a.repository, a.docker);
    await assert.rejects(d.start(), /fremden oder abweichend/);
    assert.deepEqual(a.gestartet, []);
  });

  test(`${runtime}: altes Image wie konfiguriert bleibt eigener Container (unverändert)`, async () => {
    const a = aufbau(runtime, { image: 'node:22-bookworm-slim', label: false });
    const d = new Driver(a.repository, a.docker);
    await d.start();
    assert.deepEqual(a.gestartet, [runtime]);
  });
}
