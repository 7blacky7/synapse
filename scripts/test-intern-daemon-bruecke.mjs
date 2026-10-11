#!/usr/bin/env node
// test-intern-daemon-bruecke.mjs — P15-T12 E2: Debug-Steuerung lokaler Daemons ueber die API-Bruecke.
//   B1 ohne Daemon: intern(worker_status, prozess daemon) -> daemon_nicht_verbunden
//   B2 Daemon (echtes intern-bruecke.ts, Zugang aus einer Test-config.json) meldet sich an, sobald die API
//      debug:true liefert; worker_pausieren/status/durchlauf/fortsetzen mit prozess daemon laufen ueber
//      Long-Poll + Antwort, Latenz je Befehl gemessen
//   B3 API-"Neustart" (Server zu, Bruecken-Zustand weg, Server wieder auf): der Daemon verbindet sich mit
//      Backoff neu, erkennt den Modus und ist wieder steuerbar
//   B4 Kern: Antwort-Timeout -> daemon_antwortet_nicht, Befehl verworfen; mehrere Daemons ohne host -> daemon_mehrdeutig
//   B5 API ohne SYNAPSE_INTERN_TOOL -> GET befehle liefert debug:false (eigener Kindprozess)
//   B6 Daemon-Worker: shell pausiert -> processJob claimt nicht (Pruefung per Registry), sync_* nicht in 'alle'
// Aufruf: set -a; . <test-db.env>; set +a; node scripts/test-intern-daemon-bruecke.mjs
//   (PG nur fuer validateToken/alleSchalter; braucht gebaute dists von core, rest-api, file-watcher-daemon-ts)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH: DATABASE_URL zeigt nicht auf die Test-DB (:5433/synapse_test).');
  process.exit(2);
}

const wurzel = new URL('..', import.meta.url).pathname;
// B5 zuerst, in einem Kindprozess OHNE SYNAPSE_INTERN_TOOL (internToolAktiv wird beim Laden festgehalten)
{
  const env = { ...process.env };
  delete env.SYNAPSE_INTERN_TOOL;
  const skript = `
    const { createRequire } = await import('node:module');
    const req = createRequire(${JSON.stringify(wurzel + 'packages/rest-api/package.json')});
    const Fastify = req('fastify');
    const { internDaemonRoutes } = await import(${JSON.stringify(wurzel + 'packages/rest-api/dist/routes/intern-daemon.js')});
    const app = Fastify({ logger: false });
    await app.register(internDaemonRoutes);
    const r = await app.inject({ method: 'GET', url: '/api/intern/daemon/befehle?host=x&warte=25' });
    console.log(r.body);
    await app.close();
    process.exit(0);
  `;
  const aus = execFileSync(process.execPath, ['--input-type=module', '-e', skript], { env, encoding: 'utf8', timeout: 30_000 });
  const zeile = aus.trim().split('\n').filter((z) => z.startsWith('{')).at(-1);
  assert.deepEqual(JSON.parse(zeile), { success: true, debug: false });
  console.log('OK  B5 API ohne SYNAPSE_INTERN_TOOL: debug:false sofort');
}

process.env.SYNAPSE_INTERN_TOOL = '1';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p15-bruecke-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.synapse', 'file-watcher'), { recursive: true });

const requireFromRest = createRequire(new URL('../packages/rest-api/package.json', import.meta.url));
const Fastify = requireFromRest('fastify');
const core = await import('../packages/core/dist/index.js');
const { internDaemonRoutes } = await import('../packages/rest-api/dist/routes/intern-daemon.js');
const kern = await import('../packages/core/dist/services/daemon-bruecke.js');

let app = null;
let port = 0;
async function starteApi() {
  app = Fastify({ logger: false });
  await app.register(internDaemonRoutes);
  await app.listen({ host: '127.0.0.1', port });
  port = app.server.address().port;
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(bedingung, ms, text) {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await bedingung()) return;
    await warte(100);
  }
  throw new Error('Zeitueberschreitung: ' + text);
}
const intern = (args) => core.fuehreInternAus(args, 'tester');

let bruecke = null;
try {
  await starteApi();
  fs.writeFileSync(path.join(home, '.synapse', 'file-watcher', 'config.json'), JSON.stringify({
    port: 7999, synapse_api_url: `http://127.0.0.1:${port}`, synapse_api_token: 'test-token', projekte: [],
  }));

  // B1
  let r = await intern({ action: 'worker_status', prozess: 'daemon' });
  assert.equal(r.success, false);
  assert.equal(r.error, 'daemon_nicht_verbunden');
  console.log('OK  B1 ohne Daemon: daemon_nicht_verbunden');

  // B2 — Worker wie im Daemon anmelden (gleicher Prozess = gleiche Registry, getestet wird der Transport)
  core.registriereWorker({ name: 'sync_pg_fs', beschreibung: 'S', inAlle: false });
  core.registriereWorker({ name: 'shell', beschreibung: 'Shell', inAlle: false, durchlauf: async () => ({ projekte: 0 }) });
  core.registriereWorker({ name: 'specialist_jobs', beschreibung: 'Spec' });
  const { startInternBruecke } = await import('../packages/file-watcher-daemon-ts/dist/intern-bruecke.js');
  bruecke = startInternBruecke();
  await bis(() => core.daemonUebersicht().some((d) => d.verbunden && d.wartet_gerade), 10_000, 'Daemon meldet sich an');
  await bis(() => core.daemonUebersicht()[0].status_am !== null, 5_000, 'Anmeldung mit worker_status');
  const host = core.daemonUebersicht()[0].host;

  let t0 = Date.now();
  r = await intern({ action: 'worker_pausieren', prozess: 'daemon', worker: 'shell', dauer_min: 2, grund: 'Bruecken-Test' });
  const latenzPause = Date.now() - t0;
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.prozess, `daemon:${host}`);
  assert.equal(r.host, host);
  assert.deepEqual(r.pausiert.map((w) => w.name), ['shell']);
  assert.ok(core.workerPausiert('shell'), 'Pause im Daemon-Registry gesetzt');
  t0 = Date.now();
  r = await intern({ action: 'worker_status', prozess: `daemon:${host}` });
  const latenzStatus = Date.now() - t0;
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.prozess, `daemon:${host}`);
  assert.deepEqual(r.pausiert, ['shell']);
  assert.deepEqual(core.daemonUebersicht()[0].pausiert, ['shell'], 'API kennt den Pausenstand des Daemons');
  r = await intern({ action: 'worker_durchlauf', prozess: 'daemon', worker: 'shell' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.trotz_pause, true);
  r = await intern({ action: 'worker_pausieren', prozess: 'daemon', worker: 'shell', grund: 'ohne Dauer' });
  assert.equal(r.success, false);
  assert.equal(r.error, 'dauer_fehlt', 'Fehler des Daemons kommt durch');
  r = await intern({ action: 'worker_fortsetzen', prozess: 'daemon', worker: 'shell' });
  assert.deepEqual(r.fortgesetzt, ['shell']);
  console.log(`OK  B2 Daemon steuerbar: pausieren ${latenzPause} ms, status ${latenzStatus} ms, durchlauf, Fehler, fortsetzen`);

  // B6
  r = await intern({ action: 'worker_pausieren', prozess: 'daemon', worker: 'alle', dauer_min: 1, grund: 'alle' });
  assert.deepEqual(r.pausiert.map((w) => w.name), ['specialist_jobs'], "'alle' laesst shell und sync_* aus");
  await intern({ action: 'worker_fortsetzen', prozess: 'daemon', worker: 'alle' });
  console.log("OK  B6 'alle' im Daemon ohne shell/sync_*");

  // B7 GPU-Helfer-Einstellungen ueber die Bruecke (gpu-helfer.json unter dem Test-HOME)
  const gpuDatei = path.join(home, '.synapse', 'file-watcher', 'gpu-helfer.json');
  fs.writeFileSync(gpuDatei, JSON.stringify({ fremd: 'bleibt', embed_pause_ms: 100 }));
  fs.writeFileSync(path.join(home, '.synapse', 'file-watcher', 'gpu-helfer-status.json'), JSON.stringify({ art: 'oeffentlich', rueckfall_aktiv: true }));
  r = await intern({ action: 'gpu_helfer_einstellen', lan_bevorzugen: true, embed_pause_ms: 75 });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(JSON.parse(fs.readFileSync(gpuDatei, 'utf8')), { fremd: 'bleibt', embed_pause_ms: 75, lan_bevorzugen: true });
  r = await intern({ action: 'gpu_helfer_einstellen', embed_pause_ms: null });
  assert.deepEqual(r.einstellungen, { fremd: 'bleibt', lan_bevorzugen: true }, 'null entfernt den Schluessel');
  r = await intern({ action: 'gpu_helfer_einstellen', embed_pause_ms: -5 });
  assert.equal(r.success, false);
  assert.equal(r.error, 'parameter_ungueltig');
  r = await intern({ action: 'gpu_helfer_einstellen' });
  assert.equal(r.error, 'parameter_fehlt');
  r = await intern({ action: 'gpu_helfer_status' });
  assert.equal(r.success, true);
  assert.deepEqual(r.einstellungen, { fremd: 'bleibt', lan_bevorzugen: true });
  assert.equal(r.status.rueckfall_aktiv, true);
  assert.deepEqual(fs.readdirSync(path.dirname(gpuDatei)).filter((f) => f.endsWith('.tmp')), [], 'keine tmp-Reste');
  console.log('OK  B7 gpu_helfer_einstellen/-status: gezielt, null entfernt, fremde Schluessel bleiben, atomar');

  // B3
  const vorher = core.daemonUebersicht()[0].angemeldet_seit;
  kern.vergissDaemons(); // Zustand der API weg wie nach einem Neustart; weckt den wartenden Poll
  await app.close();
  await warte(300);
  await starteApi();
  await bis(() => core.daemonUebersicht().some((d) => d.verbunden && d.angemeldet_seit !== vorher), 40_000, 'Wiederverbinden nach API-Neustart');
  r = await intern({ action: 'worker_status', prozess: 'daemon' });
  assert.equal(r.success, true, JSON.stringify(r));
  console.log('OK  B3 nach API-Neustart von selbst wieder verbunden und steuerbar');

  // B4
  bruecke.stop();
  bruecke = null;
  kern.vergissDaemons();
  void kern.holeDaemonBefehle('stumm', 0); // meldet sich an, antwortet aber nie
  await assert.rejects(kern.sendeAnDaemon('worker_status', {}, 'stumm', 300), (e) => e.code === 'daemon_antwortet_nicht');
  void kern.holeDaemonBefehle('zweiter', 0);
  await assert.rejects(kern.sendeAnDaemon('worker_status', {}), (e) => e.code === 'daemon_mehrdeutig');
  await assert.rejects(kern.sendeAnDaemon('rm_rf', {}, 'stumm'), (e) => e.code === 'befehl_unbekannt');
  console.log('OK  B4 Timeout, mehrdeutig, unbekannter Befehl');
  console.log('ALLE PRUEFUNGEN GRUEN');
} finally {
  bruecke?.stop();
  core.setzeWorkerFort?.('alle');
  kern.vergissDaemons(); // wartende Long-Polls beenden, sonst haelt app.close() bis zu 25 s
  setTimeout(() => process.exit(process.exitCode ?? 0), 3_000);
  await app?.close().catch(() => {});
  await core.closePool?.();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
