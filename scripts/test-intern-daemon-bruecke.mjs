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
//   B8 (P15-T29) warteschlange_liste mit prozess daemon ueber das echte intern-bruecke.ts (Uebersicht + Liste)
//   B9 (P15-T29) veralteter Daemon (alte Allowlist) antwortet befehl_unbekannt -> API meldet daemon_veraltet
//      mit Klartext (Neustart), direkt, in der warteschlange_liste-Uebersicht und bei worker_status
// Aufruf: (DATABASE_URL = Projekt-DB aus dem Synapse-shell-Job) node scripts/test-intern-daemon-bruecke.mjs
//   (PG nur fuer validateToken/alleSchalter; braucht gebaute dists von core, rest-api, file-watcher-daemon-ts)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

import { pruefeTestDbUrl } from './lib/test-db-schutz.mjs';
pruefeTestDbUrl('test-intern-daemon-bruecke');

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

  // B8 (P15-T29): warteschlange_liste ueber das echte intern-bruecke.ts (gleicher Prozess = gleiches Register)
  core.registriereWarteschlange({
    name: 'b8_test', beschreibung: 'B8', reihenfolge: 'FIFO', verschiebbar: 'nein',
    uebersicht: () => ({ anzahl: 2 }),
    liste: (f) => core.seiteAusListe([
      { id: 'e1', projekt: 'p', typ: 't', status: 'wartend', prioritaet: null, alter_s: 1 },
      { id: 'e2', projekt: 'q', typ: 't', status: 'wartend', prioritaet: null, alter_s: 2 },
    ], f),
  });
  r = await intern({ action: 'warteschlange_liste', prozess: 'daemon' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.prozess, `daemon:${host}`);
  assert.equal(r.warteschlangen.b8_test.anzahl, 2, JSON.stringify(r));
  r = await intern({ action: 'warteschlange_liste', prozess: `daemon:${host}`, warteschlange: 'b8_test', project: 'q' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.deepEqual(r.eintraege.map((e) => [e.id, e.rang]), [['e2', 2]]);
  console.log('OK  B8 warteschlange_liste ueber das echte intern-bruecke.ts (Uebersicht, Liste mit Filter)');

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

  // B9 (P15-T29): Daemon mit aelterem Build — seine Allowlist kennt warteschlange_liste noch nicht.
  // Er antwortet wie das alte intern-bruecke.ts (befehl_unbekannt ohne action). Live t54 kam das als
  // nichtssagendes { fehler: 'befehl_unbekannt' } in der Uebersicht an.
  kern.vergissDaemons();
  let altLaeuft = true;
  const altSchleife = (async () => {
    while (altLaeuft) {
      const bs = await kern.holeDaemonBefehle('alt', 200);
      for (const b of bs) {
        const alteListe = ['worker_status', 'worker_pausieren', 'worker_fortsetzen', 'worker_durchlauf'];
        kern.meldeDaemonAntwort('alt', b.id, alteListe.includes(b.befehl)
          ? { success: true, worker: [] }
          : { success: false, error: 'befehl_unbekannt', message: `Befehl ${b.befehl} wird vom Daemon nicht ausgefuehrt.` });
      }
    }
  })();
  try {
    r = await intern({ action: 'warteschlange_liste', prozess: 'daemon:alt', warteschlange: 'index' });
    assert.equal(r.success, false, JSON.stringify(r));
    assert.equal(r.error, 'daemon_veraltet', JSON.stringify(r));
    assert.match(r.message, /alt.*warteschlange_liste.*neu starten/s, r.message);
    r = await intern({ action: 'worker_status', prozess: 'daemon:alt' });
    assert.equal(r.success, true, 'Befehle, die der alte Daemon kennt, gehen weiter: ' + JSON.stringify(r));
    r = await intern({ action: 'sync_inspektor', project: 'zz-b9', file_path: 'a.ts', prozess: 'daemon:alt' });
    assert.ok(JSON.stringify(r).includes('daemon_veraltet'), 'sync_inspektor nennt daemon_veraltet: ' + JSON.stringify(r).slice(0, 600));
    r = await intern({ action: 'warteschlange_liste' });
    assert.equal(r.success, true, JSON.stringify(r).slice(0, 400));
    assert.equal(r.daemons?.['daemon:alt']?.fehler, 'daemon_veraltet', 'Uebersicht: ' + JSON.stringify(r.daemons));
    assert.match(r.daemons['daemon:alt'].message, /neu starten/);
  } finally {
    altLaeuft = false;
    kern.vergissDaemons();
    await altSchleife;
  }
  console.log('OK  B9 veralteter Daemon: daemon_veraltet mit Klartext (direkt, Uebersicht, sync_inspektor), bekannte Befehle laufen');
  console.log('ALLE PRUEFUNGEN GRUEN');
} catch (err) {
  // P15-T29: vorher verschluckte das process.exit im finally jeden Fehler (EXIT 0 ohne Ausgabe).
  console.error('FEHLER', err);
  process.exitCode = 1;
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
