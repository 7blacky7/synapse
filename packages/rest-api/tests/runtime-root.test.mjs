// Persistenz-Wache + Basis-Pfad (Befund 19208: Runtimes lagen im RAM).
// Plain node gegen den gebauten dist; die Docker-Seite ist ein Fake — die
// ECHTE stat-Probe prueft der erste Deploy (die Wache meldet sich selbst).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentRuntimeBasisRoot,
  FLUECHTIGE_DATEISYSTEME,
  pruefeRuntimeRootPersistenz,
} from '../dist/services/agent-runtime/runtime-root.js';
import { validateRuntimeRoot } from '../dist/services/agent-runtime/codex-driver.js';

function fakeDocker(ausgabe, { startFehler } = {}) {
  return {
    createContainer: async () => ({
      start: async () => { if (startFehler) throw new Error(startFehler); },
      wait: async () => ({ StatusCode: 0 }),
      logs: async () => Buffer.from(ausgabe, 'utf8'),
      remove: async () => {},
    }),
  };
}

test('agentRuntimeBasisRoot: Vorgabe echter Pool, ENV gewinnt', () => {
  delete process.env.SYNAPSE_AGENT_RUNTIME_ROOT;
  assert.equal(agentRuntimeBasisRoot(), '/mnt/z/dockdata/synapse-agent-runtime');
  process.env.SYNAPSE_AGENT_RUNTIME_ROOT = '/mnt/z/anders/';
  assert.equal(agentRuntimeBasisRoot(), '/mnt/z/anders');
  delete process.env.SYNAPSE_AGENT_RUNTIME_ROOT;
});

test('Persistenz-Wache: RAM bricht LAUT ab, echte Pools passieren, unmessbar warnt statt blockiert', async () => {
  assert.equal(FLUECHTIGE_DATEISYSTEME.has('rootfs'), true);
  assert.equal(FLUECHTIGE_DATEISYSTEME.has('tmpfs'), true);
  assert.equal(FLUECHTIGE_DATEISYSTEME.has('ramfs'), true);
  assert.equal(FLUECHTIGE_DATEISYSTEME.has('zfs'), false);
  await assert.rejects(
    () => pruefeRuntimeRootPersistenz(fakeDocker('rootfs\n'), 'img', '/mnt/user/x'),
    /FLUECHTIGEN Dateisystem \(rootfs/,
  );
  await assert.rejects(
    () => pruefeRuntimeRootPersistenz(fakeDocker('tmpfs\n'), 'img', '/tmp/x'),
    /FLUECHTIGEN/,
  );
  await pruefeRuntimeRootPersistenz(fakeDocker('zfs\n'), 'img', '/mnt/y/x');
  await pruefeRuntimeRootPersistenz(fakeDocker('btrfs\n'), 'img', '/mnt/z/x');
  // Probe selbst kaputt (kein Docker) -> Warnung, kein Block — aber nie still
  await pruefeRuntimeRootPersistenz(fakeDocker('', { startFehler: 'kein docker' }), 'img', '/mnt/y/x');
});

test('validateRuntimeRoot: neue Pools in der Vorgabe-Positivliste, /mnt/user bleibt bis zur Migration', () => {
  delete process.env.AGENT_RUNTIME_ALLOWED_ROOTS;
  assert.equal(validateRuntimeRoot('/mnt/z/dockdata/synapse-agent-runtime/claude'), '/mnt/z/dockdata/synapse-agent-runtime/claude');
  assert.equal(validateRuntimeRoot('/mnt/y/appdata/x'), '/mnt/y/appdata/x');
  assert.equal(validateRuntimeRoot('/mnt/user/synapse-agent-runtime/codex'), '/mnt/user/synapse-agent-runtime/codex');
  assert.throws(() => validateRuntimeRoot('/etc'), /AGENT_RUNTIME_ALLOWED_ROOTS/);
});
