/**
 * P22-T58: Container-Spezifikation (U4-Golden, thought 791212a9 Schritt 2c), leichte Beobachtung und CLI-Update mit Fake-Docker.
 * Ohne Docker, ohne DB, ohne Netz.
 *   node --test packages/rest-api/tests/runtime-container-p22-t58.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

delete process.env.AGENT_RUNTIME_DOCKER_NETWORK;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const S = await load('packages/rest-api/dist/services/agent-runtime/runtime-container-spez.js');
const B = await load('packages/rest-api/dist/services/agent-runtime/runtime-beobachtung.js');

const ROOT = '/mnt/z/dockdata/synapse-agent-runtime/claude';
const BINDS = [ROOT + '/home:/root', ROOT + '/projects:/projects', ROOT + '/state:/state', ROOT + '/attachments:/attachments'];
const GRENZEN = { container_memory_mb: 2048, container_pids_limit: 256, container_tmpfs_mb: 256, cli_behalten: 4 };

test('U4-Golden: Claude-Container exakt wie 791212a9 Schritt 2c (ohne Cmd/Hostname, Autoupdate aus der API)', () => {
  const spez = S.runtimeContainerSpez('claude', { containerName: 'synapse-runtime-claude', image: 'synapse-agent-runtime:t1', root: ROOT, binds: BINDS }, GRENZEN);
  assert.deepEqual(spez, {
    name: 'synapse-runtime-claude',
    Image: 'synapse-agent-runtime:t1',
    Labels: {
      'synapse.agent-runtime': 'true', 'synapse.runtime': 'claude', 'synapse.agent-role': 'main',
      'synapse.runtime-root': ROOT, 'synapse.runtime-image': 'agent-runtime',
    },
    Env: [
      'HOME=/root', 'SSL_CERT_FILE=/root/.local/share/ca-certificates.crt',
      'CLAUDE_CONFIG_DIR=/root/.claude', 'NODE_EXTRA_CA_CERTS=/root/.local/share/ca-certificates.crt',
      'SYNAPSE_DAEMON_PROFIL=runtime', 'SYNAPSE_RUNTIME_NAME=claude', 'SYNAPSE_RUNTIME_CLI_AUTOUPDATE=0', 'SYNAPSE_RUNTIME_CLI_BEHALTEN=4',
    ],
    WorkingDir: '/projects', Tty: false, OpenStdin: false,
    HostConfig: {
      NetworkMode: 'proxynet', AutoRemove: false, RestartPolicy: { Name: 'no' }, Init: true, ReadonlyRootfs: true, CapDrop: ['ALL'],
      Binds: BINDS, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, PidsLimit: 256, SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'size=256m,exec' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1g', 'max-file': '3' } },
    },
  });
  assert.equal('Cmd' in spez, false, 'kein Cmd: das Image startet runtime-main');
  assert.equal('Hostname' in spez, false, 'kein Hostname (nur PC/Tray)');
});

test('Codex-Variante und Grenzen aus den Einstellungen', () => {
  const spez = S.runtimeContainerSpez('codex', { containerName: 'synapse-runtime-codex', image: 'reg:5000/synapse-agent-runtime@sha256:ab', root: '/r', binds: ['/r/home:/root'] },
    { container_memory_mb: 4096, container_pids_limit: 512, container_tmpfs_mb: 512, cli_behalten: 2 });
  assert.ok(spez.Env.includes('CODEX_HOME=/root/.codex') && !spez.Env.some((e) => e.startsWith('CLAUDE_CONFIG_DIR')));
  assert.ok(spez.Env.includes('SYNAPSE_RUNTIME_NAME=codex') && spez.Env.includes('SYNAPSE_RUNTIME_CLI_BEHALTEN=2'));
  assert.equal(spez.HostConfig.Memory, 4096 * 1024 * 1024);
  assert.equal(spez.HostConfig.PidsLimit, 512);
  assert.equal(spez.HostConfig.Tmpfs['/tmp'], 'size=512m,exec');
});

test('istAgentRuntimeImage', () => {
  assert.equal(S.istAgentRuntimeImage('synapse-agent-runtime:326916f5-wt10200153'), true);
  assert.equal(S.istAgentRuntimeImage('reg:5000/team/synapse-agent-runtime@sha256:ab'), true);
  assert.equal(S.istAgentRuntimeImage('node:22-bookworm-slim'), false);
  assert.equal(S.istAgentRuntimeImage('synapse-agent-runtime-alt:1'), false);
  assert.equal(S.istAgentRuntimeImage(null), false);
});

/** Fake-Docker: inspect liefert info oder wirft; exec liefert stdout und Exit-Code. */
function fakeDocker({ info, inspectFehler, stdout = '', exitCode = 0 }) {
  const aufrufe = [];
  const container = {
    inspect: async () => { if (inspectFehler) throw new Error(inspectFehler); return info; },
    exec: async (o) => {
      aufrufe.push(o.Cmd);
      return {
        start: async () => { const s = new PassThrough(); setImmediate(() => { s.write(stdout); s.end(); }); return s; },
        inspect: async () => ({ ExitCode: exitCode }),
      };
    },
  };
  return {
    aufrufe,
    getContainer: () => container,
    modem: { demuxStream: (stream, out) => { stream.on('data', (d) => out.write(d)); } },
  };
}
const CONFIG = { runtime: 'claude', role: 'main', rootPath: ROOT, image: 'synapse-agent-runtime:t1', containerName: 'synapse-runtime-claude', model: 'sonnet', assignedToMain: true };
const laufend = (labels = { 'synapse.runtime-image': 'agent-runtime' }, image = 'synapse-agent-runtime:t1') => ({ Id: 'c1', State: { Running: true }, Config: { Labels: labels, Image: image } });
const O = (d, x = {}) => ({ probe_timeout_ms: 1000, daemon_frisch_ms: 90_000, env: [], istEigener: () => true, jetzt: () => Date.parse('2026-10-20T10:00:00Z'), ...x });

test('Beobachtung: Containerzustaende', async () => {
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({}), null, O())).container, 'nicht_konfiguriert');
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ inspectFehler: '(HTTP code 404) no such container' }), CONFIG, O())).container, 'fehlt');
  const f = await B.beobachteRuntimeContainer(fakeDocker({ inspectFehler: 'connect ENOENT /var/run/docker.sock' }), CONFIG, O());
  assert.equal(f.container, 'fehler'); assert.match(f.fehler, /ENOENT/);
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ info: laufend() }), CONFIG, O(null, { istEigener: () => false }))).container, 'fremd');
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ info: { State: { Running: false }, Config: { Labels: {} } } }), CONFIG, O())).container, 'gestoppt');
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ info: { State: { Running: true, Restarting: true }, Config: { Labels: {} } } }), CONFIG, O())).container, 'restarting');
  const alt = fakeDocker({ info: laufend({}, 'node:22-bookworm-slim') });
  const a = await B.beobachteRuntimeContainer(alt, CONFIG, O());
  assert.equal(a.container, 'laeuft'); assert.equal(a.prozess, 'unbekannt'); assert.equal(alt.aufrufe.length, 0, 'altes Image: keine Status-Probe');
});

test('Beobachtung: Status-Probe des Daemons', async () => {
  const frisch = fakeDocker({ info: laufend(), stdout: JSON.stringify({ quelle: 'daemon', erzeugt_am: '2026-10-20T09:59:40Z' }) });
  const ok = await B.beobachteRuntimeContainer(frisch, CONFIG, O());
  assert.equal(ok.prozess, 'ok'); assert.equal(ok.status_alter_s, 20);
  assert.deepEqual(frisch.aufrufe[0].slice(-2), ['synapse-runtime', 'status'], 'Befehl synapse-runtime status');
  const alt = await B.beobachteRuntimeContainer(fakeDocker({ info: laufend(), stdout: JSON.stringify({ quelle: 'daemon', erzeugt_am: '2026-10-20T09:50:00Z' }) }), CONFIG, O());
  assert.equal(alt.prozess, 'daemon_tot'); assert.equal(alt.fehler, 'status.json veraltet');
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ info: laufend(), stdout: JSON.stringify({ quelle: 'live', hinweis: 'fehlt' }) }), CONFIG, O())).prozess, 'daemon_tot');
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ info: laufend(), exitCode: 124 }), CONFIG, O())).prozess, 'haengt');
  assert.equal((await B.beobachteRuntimeContainer(fakeDocker({ info: laufend(), exitCode: 127 }), CONFIG, O())).prozess, 'unbekannt');
});

test('CLI-Update im Container (F5)', async () => {
  const d = fakeDocker({ info: laufend(), stdout: 'claude 2.1.305 aktiv' });
  const r = await B.fuehreCliUpdateImContainerAus(d, CONFIG, 'claude', { timeout_ms: 1000, env: [], istEigener: () => true });
  assert.equal(r.ok, true); assert.match(r.ausgabe, /2\.1\.305/);
  assert.deepEqual(d.aufrufe[0].slice(-7), ['synapse-runtime', 'cli', 'update', 'claude', 'latest', '--akteur', 'api-auto']);
  assert.equal((await B.fuehreCliUpdateImContainerAus(fakeDocker({ info: laufend({}, 'node:22-bookworm-slim') }), CONFIG, 'claude', { timeout_ms: 1000, env: [], istEigener: () => true })).ausgabe, 'kein_agent_runtime_image');
  assert.equal((await B.fuehreCliUpdateImContainerAus(fakeDocker({ info: { State: { Running: false }, Config: { Labels: {} } } }), CONFIG, 'claude', { timeout_ms: 1000, env: [], istEigener: () => true })).ausgabe, 'container_laeuft_nicht');
  assert.equal((await B.fuehreCliUpdateImContainerAus(fakeDocker({ info: laufend() }), CONFIG, 'claude', { timeout_ms: 1000, env: [], istEigener: () => false })).ausgabe, 'fremder_container');
  assert.equal((await B.fuehreCliUpdateImContainerAus(fakeDocker({ info: laufend(), exitCode: 3 }), CONFIG, 'claude', { timeout_ms: 1000, env: [], istEigener: () => true })).ok, false);
});
