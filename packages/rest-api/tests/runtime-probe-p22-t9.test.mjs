import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { RuntimeStatusProbe, captureRuntimeProbe } from '../dist/services/agent-runtime/probe.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// Gegenprobe verwendet echte Basistreiber, Testdatei/Helfer bleiben im aktuellen Baum.
const driverRoot = process.env.P22_T9_BASE
  ? pathToFileURL(resolve(process.env.P22_T9_BASE, 'packages/rest-api/dist/services/agent-runtime') + '/')
  : new URL('../dist/services/agent-runtime/', import.meta.url);
const { CodexRuntimeDriver, persistentRuntimeBinds } = await import(new URL('codex-driver.js', driverRoot));
const { ClaudeRuntimeDriver } = await import(new URL('claude-driver.js', driverRoot));

// Ausschließlich Fake-Docker und synthetische Node-Prozesse, keine echte CLI,
// kein Docker-Socket, keine DB, keine API und kein Abo-/Modellaufruf.
function fixture(runtime) {
  const config = { runtime, role: 'main', rootPath: '/mnt/z/dockdata/synapse-agent-runtime/' + runtime,
    image: 'node:22-bookworm-slim', containerName: 'fake-' + runtime, model: null, assignedToMain: false };
  const state = { execs: 0, auths: 0, pids: 10, failure: null, gate: null, observed: [] };
  const repository = { get: async () => config, updateObserved: async (_r, value) => { state.observed.push(value); } };
  const container = {
    inspect: async () => ({
      Id: 'fake-container', State: { Running: true },
      HostConfig: { PidsLimit: 256, Binds: persistentRuntimeBinds(config.rootPath) },
      Config: { Image: config.image, Labels: { 'synapse.agent-runtime': 'true', 'synapse.runtime': runtime,
        'synapse.agent-role': 'main', 'synapse.runtime-root': config.rootPath } },
    }),
    stats: async () => ({ pids_stats: { current: state.pids } }),
    exec: async options => {
      state.execs++;
      if (state.failure) throw new Error(state.failure);
      const command = options.Cmd[0] === '/usr/local/bin/node' ? options.Cmd.slice(4) : options.Cmd;
      const auth = !command.includes('--version');
      if (auth) state.auths++;
      let stream;
      return {
        start: async () => {
          if (auth && state.gate) await state.gate;
          stream = new PassThrough(); stream.command = command;
          return stream;
        },
        inspect: async () => ({ ExitCode: 0 }),
      };
    },
  };
  const docker = { ping: async () => {}, getContainer: () => container, modem: {
    demuxStream(stream, out) {
      stream.resume();
      queueMicrotask(() => {
        out.write(stream.command.includes('--version') ? runtime + ' 1.0' :
          runtime === 'codex' ? 'Logged in using ChatGPT' : '{"loggedIn":true,"authMethod":"claude.ai"}');
        stream.end();
      });
    },
  } };
  return { state, driver: runtime === 'codex' ? new CodexRuntimeDriver(repository, docker) : new ClaudeRuntimeDriver(repository, docker) };
}

for (const runtime of ['codex', 'claude']) {
  test(runtime + ': 20 parallele Polls starten nur eine Authprüfung, Ergebnis wird gecacht', async () => {
    const { state, driver } = fixture(runtime);
    let release;
    state.gate = new Promise(resolve => { release = resolve; });
    const polls = Array.from({ length: 20 }, () => driver.status());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.auths, 1);
    release();
    const results = await Promise.all(polls);
    assert.equal(state.execs, 2); // Version und Auth, nicht 40 Execs.
    assert.ok(results.every(result => result.authentication.status === 'authenticated'));
    await driver.status();
    assert.equal(state.execs, 2);
  });

  test(runtime + ': volles PID-Limit wird vor Exec erkannt und als eigener Zustand ausgegeben', async () => {
    const { state, driver } = fixture(runtime);
    state.pids = 256;
    const status = await driver.status();
    assert.equal(state.execs, 0);
    assert.equal(status.diagnostic.code, 'pid_limit');
    assert.equal(status.container.status, 'running');
    assert.match(status.lastError, /256\/256/);
    assert.equal(status.authentication.status, 'unknown');
  });

  test(runtime + ': Forkfehler aus Docker erzeugt keine falsche Installationsdiagnose', async () => {
    const { state, driver } = fixture(runtime);
    state.failure = 'OCI runtime exec failed: resource temporarily unavailable';
    const status = await driver.status();
    assert.equal(status.diagnostic.code, 'pid_limit');
    assert.equal(status.container.status, 'running');
    await driver.status();
    assert.equal(state.execs, 1); // Auch Fehlercache verhindert Poll-Sturm.
  });
}

test('Cache läuft ab; Invalidierung während Flug verhindert veralteten Cache', async () => {
  let now = 0, calls = 0, release;
  const cache = new RuntimeStatusProbe(50, () => now);
  const probe = async () => ++calls;
  assert.equal(await cache.run(probe), 1);
  now = 49;
  assert.equal(await cache.run(probe), 1);
  now = 50;
  assert.equal(await cache.run(probe), 2);
  cache.invalidate();
  const pending = cache.run(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  cache.invalidate();
  release(3);
  await pending;
  assert.equal(await cache.run(probe), 3);
  const failing = new RuntimeStatusProbe();
  await assert.rejects(failing.run(async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await failing.run(async () => 4), 4);
});

// Fake-Docker führt NUR den gelieferten Supervisor mit einer synthetischen Node-CLI
// lokal aus. Damit wird Prozessende gemessen, nicht bloß ein Kill-String verglichen.
function processDocker() {
  const children = [];
  const container = { exec: async options => {
    let child, exitCode;
    return {
      start: async () => {
        child = spawn(process.execPath, options.Cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        const stream = new PassThrough();
        stream.child = child;
        child.once('error', error => stream.destroy(error));
        child.once('close', code => { exitCode = code; stream.end(); });
        return stream;
      },
      inspect: async () => ({ ExitCode: exitCode }),
    };
  } };
  const docker = { modem: { demuxStream(stream, out, err) {
    stream.child.stdout.pipe(out);
    stream.child.stderr.pipe(err);
    stream.resume();
  } } };
  return { container, docker, children };
}

async function running(pid) {
  try {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
    return !/^.*\) Z /.test(stat);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

for (const disconnect of [false, true]) test('Fake-Docker: Timeout/Verbindungsabbruch beendet CLI und TERM-resistentes Kind, disconnect=' + disconnect, async t => {
  const fake = processDocker();
  const pids = [];
  // Ausgabe vor dem Timeout merken, obwohl captureRuntimeProbe erwartungsgemäß wirft.
  const demux = fake.docker.modem.demuxStream;
  fake.docker.modem.demuxStream = (stream, out, err) => {
    let text = '';
    stream.child.stdout.on('data', chunk => {
      text += chunk;
      for (const match of text.matchAll(/PID=(\d+)/g)) pids.push(Number(match[1]));
    });
    demux(stream, out, err);
    if (disconnect) stream.child.stdout.once('data', () => setTimeout(() => stream.destroy(new Error('simulierter Transportabbruch')), 50));
  };
  t.after(() => { for (const child of fake.children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const synthetic = "const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); console.log('PID='+process.pid); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'}); console.log('PID='+child.pid);setInterval(()=>{},1000);";
  await assert.rejects(captureRuntimeProbe(fake.docker, fake.container, [process.execPath, '-e', synthetic], [], 500),
    error => disconnect ? /simulierter Transportabbruch/.test(error.message) : error.code === 'probe_timeout');
  assert.ok(new Set(pids).size >= 2, 'CLI und Kind wurden tatsächlich gestartet');
  for (const pid of new Set(pids)) assert.equal(await running(pid), false, 'Prozess ' + pid + ' ist beendet');
});

test('Fake-Docker: normaler Exit und stderr bleiben erhalten', async () => {
  const fake = processDocker();
  const result = await captureRuntimeProbe(fake.docker, fake.container,
    [process.execPath, '-e', "console.log('ok');console.error('not logged in');process.exitCode=1"], [], 2_000);
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /ok/);
  assert.match(result.stderr, /not logged in/);
});

test('Terminal-UX nennt PID-Limit/Timeout/Start/Installation und gibt gesundes Terminal frei', async () => {
  // Reine TS-Hilfsfunktion laden, ohne Browser/Server/DB; type-only Import entfällt.
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = await readFile(new URL('../../web-ui/src/components/runtime-feedback.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022 } }).outputText;
  const { runtimeTerminalBlockReason } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
  const healthy = { configured: true, installed: true, container: { status: 'running' } };
  assert.equal(runtimeTerminalBlockReason(healthy), null);
  assert.match(runtimeTerminalBlockReason({ ...healthy, diagnostic: { code: 'pid_limit' } }), /PID-\/Thread-Limit.*Installation nicht erneut/);
  assert.match(runtimeTerminalBlockReason({ ...healthy, diagnostic: { code: 'probe_timeout' } }), /Zeitlimit.*abgebrochen/);
  assert.match(runtimeTerminalBlockReason({ ...healthy, installed: false }), /Installation abschließen/);
  assert.match(runtimeTerminalBlockReason({ ...healthy, container: { status: 'stopped' } }), /Container zuerst starten/);
  assert.match(runtimeTerminalBlockReason(healthy, 'Einrichtung'), /Einrichtung läuft/);
});
