/**
 * P22-T4 Testphase: Daemonkern + Startprofile, Daemon-Host im Runtime-Container, versionierte CLI-Installation
 * (install/use/update/rollback/fremder Launcher/behalten/laufende Version/Bundle), Startprofil runtime (Status,
 * Standardwerte, DB-Sperre, keine PC-Dienste), synapse-runtime CLI.
 * Nur Temp-Ordner (mkdtemp) und ein Fake-Installer; kein PG, kein Netz, kein Docker, kein echter Daemon.
 * Voraussetzung: core und file-watcher-daemon-ts gebaut.
 *   node --test packages/file-watcher-daemon-ts/tests/runtime-startprofil-p22-t4.test.mjs
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

delete process.env.DATABASE_URL;
delete process.env.SYNAPSE_DATABASE_URL;
delete process.env.SYNAPSE_RUNTIME_NAME;
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const lade = (datei) => import(pathToFileURL(join(dist, datei)).href);
const tmp = fs.mkdtempSync(join(os.tmpdir(), 'p22t4-test-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const cv = await lade('cli-versionen.js');
const { DaemonKern, leseStartprofil } = await lade('daemon-kern.js');

let zaehler = 0;
function layout() {
  const d = join(tmp, `l${++zaehler}`);
  return { basis: join(d, 'basis'), launcherDir: join(d, 'bin') };
}
/** Fake-Installer: Shell-Skript, das seine Version ausgibt; dist-tags latest=9.0.0, stable=1.5.0. */
const fake = {
  aufrufe: 0,
  async loeseVersion(_cli, ziel) { return cv.istExakteVersion(ziel) ? ziel : ({ latest: '9.0.0', stable: '1.5.0' })[ziel]; },
  async installiere(cli, version, dir) {
    this.aufrufe++;
    const f = join(dir, cli);
    fs.writeFileSync(f, `#!/bin/sh\necho "${version} (fake ${cli})"\ncase "$1" in [0-9]*) sleep "$1";; esac\n`);
    fs.chmodSync(f, 0o755);
    return { einstieg: cli };
  },
  async versionsausgabe(einstieg) { return execFileSync(einstieg, ['--version']).toString().trim(); },
};
const MANUELL = { quelle: 'manuell', akteur: 'test' };
const AUTO = { quelle: 'automatisch', akteur: 'runtime-daemon' };

// ---------------------------------------------------------------------------------------------
test('Startprofil: leer = pc, runtime, unbekannt = Fehler', () => {
  assert.equal(leseStartprofil(''), 'pc');
  assert.equal(leseStartprofil(undefined), 'pc');
  assert.equal(leseStartprofil(' Runtime '), 'runtime');
  assert.throws(() => leseStartprofil('quatsch'), /unbekannt/);
});

test('DaemonKern: Startfehler vermerkt, Stoppreihenfolge, Fehler im Stopp haelt Kette nicht an, exit 0', async () => {
  const log = [];
  let exitCode = null;
  const kern = new DaemonKern('runtime', { exit: (c) => { exitCode = c; }, log: (...t) => log.push(t.join(' ')), hardExitMs: 2000 });
  assert.equal(await kern.starte('a', () => 'handle-a'), 'handle-a');
  assert.equal(await kern.starte('b', () => { throw new Error('kaputt'); }), null);
  kern.markiereAus('c', 'Schalter aus');
  const st = Object.fromEntries(kern.status().komponenten.map((k) => [k.name, k]));
  assert.equal(st.a.zustand, 'gestartet');
  assert.equal(st.b.zustand, 'fehler');
  assert.equal(st.b.grund, 'kaputt');
  assert.equal(st.c.zustand, 'aus');
  await assert.rejects(kern.starte('d', () => { throw new Error('pflicht'); }, { pflicht: true }), /pflicht/);
  const reihenfolge = [];
  kern.beimStopp('eins', () => { reihenfolge.push(1); });
  kern.beimStopp('zwei', () => { reihenfolge.push(2); throw new Error('stopfehler'); });
  kern.beimStopp('drei', async () => { reihenfolge.push(3); });
  await kern.shutdown('TEST');
  await kern.shutdown('TEST'); // idempotent
  assert.deepEqual(reihenfolge, [1, 2, 3]);
  assert.equal(exitCode, 0);
  assert.ok(log.some((z) => z.includes('zwei stop Fehler')));
});

test('daemonHost: PC = os.hostname, Runtime = synapse-runtime-<name>, unbekannt = Fehler', async () => {
  const { daemonHost } = await lade('daemon-jobs-api.js');
  assert.equal(daemonHost({}), os.hostname());
  assert.equal(daemonHost({ SYNAPSE_RUNTIME_NAME: 'claude' }), 'synapse-runtime-claude');
  assert.equal(daemonHost({ SYNAPSE_RUNTIME_NAME: 'codex' }), 'synapse-runtime-codex');
  assert.throws(() => daemonHost({ SYNAPSE_RUNTIME_NAME: 'gemini' }), /unbekannt/);
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(dist, 'daemon-jobs-api.js')).href)}).then(m=>console.log(m.DAEMON_API_ID))`],
    { env: { ...process.env, SYNAPSE_RUNTIME_NAME: 'codex' }, encoding: 'utf8' });
  assert.match(r.stdout.trim(), /^daemon-synapse-runtime-codex-\d+$/);
});

// ---------------------------------------------------------------------------------------------
test('CLI: install aktiviert nicht, use/update schalten atomar, Automatik stuft nie zurueck, Rollback als Stapel', async () => {
  const L = layout();
  const inst = await cv.installiereVersion(L, 'codex', '1.0.0', MANUELL, fake);
  assert.equal(inst.neu, true);
  assert.equal(cv.launcherStand(L, 'codex').art, 'fehlt');
  assert.equal((await cv.installiereVersion(L, 'codex', '1.0.0', MANUELL, fake)).neu, false, 'zweite Installation ist No-op');
  await cv.aktiviereVersion(L, 'codex', '1.0.0', MANUELL);
  assert.equal(cv.launcherStand(L, 'codex').version, '1.0.0');
  const up = await cv.aktualisiere(L, 'codex', 'latest', MANUELL, { installer: fake });
  assert.equal(up.aktiviert, true);
  assert.equal(execFileSync(join(L.launcherDir, 'codex'), ['--version']).toString().trim(), '9.0.0 (fake codex)');
  const zurueck = await cv.aktualisiere(L, 'codex', 'stable', AUTO, { installer: fake });
  assert.equal(zurueck.aktiviert, false);
  assert.match(zurueck.hinweis, /aelter/);
  await cv.rollback(L, 'codex', MANUELL);
  assert.equal(cv.launcherStand(L, 'codex').version, '1.0.0');
  await assert.rejects(cv.rollback(L, 'codex', MANUELL), (e) => e.code === 'kein_vorheriger_stand', 'vor 1.0.0 gab es keinen Launcher – nichts wird geloescht');
  await assert.rejects(cv.aktiviereVersion(L, 'codex', '7.7.7', MANUELL), (e) => e.code === 'version_fehlt');
  await assert.rejects(cv.installiereVersion(L, 'codex', '../x', MANUELL, fake), /exakte Version|dist-tag/);
  const aktionen = cv.leseVerlauf(L, 'codex').map((e) => e.aktion);
  assert.deepEqual(aktionen, ['installiert', 'aktiviert', 'installiert', 'aktiviert', 'rollback']);
});

test('CLI: fremder Launcher (echte Datei) nie automatisch ersetzt, manuell beiseitegelegt, Rollback stellt ihn wieder her', async () => {
  const L = layout();
  fs.mkdirSync(L.launcherDir, { recursive: true });
  const alt = join(L.launcherDir, 'claude');
  fs.writeFileSync(alt, '#!/bin/sh\necho alt\n');
  fs.chmodSync(alt, 0o755);
  const auto = await cv.aktualisiere(L, 'claude', 'latest', AUTO, { installer: fake });
  assert.equal(auto.aktiviert, false);
  assert.match(auto.hinweis, /fremder Launcher/);
  assert.equal(fake.aufrufe > 0, true);
  assert.equal(cv.launcherStand(L, 'claude').art, 'fremd');
  await cv.aktualisiere(L, 'claude', '2.0.0', MANUELL, { installer: fake });
  assert.equal(cv.launcherStand(L, 'claude').version, '2.0.0');
  const gesichert = fs.readdirSync(L.launcherDir).find((n) => n.startsWith('claude.vor-synapse-'));
  assert.ok(gesichert, 'alte Datei liegt beiseite');
  await cv.rollback(L, 'claude', MANUELL);
  assert.equal(execFileSync(join(L.launcherDir, 'claude')).toString().trim(), 'alt');
});

test('CLI: behalten raeumt aeltere auf, schuetzt aktive, Rollback-Ziel und laufende Versionen', async () => {
  const L = layout();
  for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) await cv.aktualisiere(L, 'codex', v, MANUELL, { installer: fake });
  assert.equal(cv.installierteVersionen(L, 'codex').length, 4, 'ohne behalten bleibt alles');
  const laeuft = spawn(join(L.basis, 'codex', 'versions', '1.0.0', 'codex'), ['30'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = await cv.aktualisiere(L, 'codex', '1.4.0', AUTO, { installer: fake, behalten: 2 });
    assert.deepEqual(r.aufgeraeumt.entfernt, ['1.1.0', '1.2.0']);
    assert.deepEqual(r.aufgeraeumt.geschuetzt, [{ version: '1.0.0', grund: 'laeuft' }]);
    assert.equal(cv.installierteVersionen(L, 'codex').map((m) => m.version).join(','), '1.0.0,1.3.0,1.4.0');
  } finally { laeuft.kill('SIGKILL'); }
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await cv.raeumeAuf(L, 'codex', 2, MANUELL)).entfernt, ['1.0.0']);
  assert.deepEqual((await cv.raeumeAuf(L, 'codex', 0, MANUELL)).entfernt, [], '0 = nichts entfernen');
  await cv.rollback(L, 'codex', MANUELL);
  assert.equal(cv.launcherStand(L, 'codex').version, '1.3.0', 'Rollback-Ziel war geschuetzt');
  assert.ok(cv.leseVerlauf(L, 'codex').some((e) => e.aktion === 'entfernt' && e.version === '1.1.0'));
});

test('CLI: Sperre gegen paralleles Arbeiten, verwaiste Sperre wird uebernommen', async () => {
  const L = layout();
  fs.mkdirSync(join(L.basis, 'codex'), { recursive: true });
  const fremd = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(join(L.basis, 'codex', '.sperre'), String(fremd.pid));
  try {
    await assert.rejects(cv.installiereVersion(L, 'codex', '1.0.0', MANUELL, fake), (e) => e.code === 'cli_gesperrt');
  } finally { fremd.kill('SIGKILL'); }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await cv.installiereVersion(L, 'codex', '1.0.0', MANUELL, fake)).neu, true);
  assert.equal(fs.existsSync(join(L.basis, 'codex', '.sperre')), false, 'Sperre nach Arbeit wieder frei');
});

test('CLI: Bundle-Provisionierung kopiert fehlende Versionen und aktiviert nur ohne Launcher', async () => {
  const B = layout();
  await cv.installiereVersion(B, 'codex', '0.9.0', { quelle: 'bundle', akteur: 'image-build' }, fake);
  const L = layout();
  const r = await cv.provisioniereBundle(B.basis, L, 'codex', { quelle: 'bundle', akteur: 'runtime-daemon' });
  assert.deepEqual(r, { kopiert: ['0.9.0'], aktiviert: '0.9.0' });
  assert.deepEqual(await cv.provisioniereBundle(B.basis, L, 'codex', { quelle: 'bundle', akteur: 'x' }), { kopiert: [], aktiviert: null });
  const F = layout();
  fs.mkdirSync(F.launcherDir, { recursive: true });
  fs.symlinkSync('/bin/true', join(F.launcherDir, 'codex'));
  const r2 = await cv.provisioniereBundle(B.basis, F, 'codex', { quelle: 'bundle', akteur: 'x' });
  assert.equal(r2.aktiviert, null, 'fremder Launcher bleibt');
  assert.equal(cv.launcherStand(F, 'codex').art, 'fremd');
});

test('vergleicheVersionen', () => {
  assert.ok(cv.vergleicheVersionen('2.1.304', '2.1.30') > 0);
  assert.ok(cv.vergleicheVersionen('1.0.0-beta', '1.0.0') < 0);
  assert.equal(cv.vergleicheVersionen('0.163.0', '0.163.0'), 0);
});

// ---------------------------------------------------------------------------------------------
test('synapse-runtime CLI: JSON, Bedienfehler Exit 2, list', () => {
  const L = layout();
  const cli = join(dist, 'runtime-cli.js');
  const falsch = spawnSync(process.execPath, [cli, 'cli', 'bogus'], { encoding: 'utf8' });
  assert.equal(falsch.status, 2);
  assert.equal(JSON.parse(falsch.stdout).error, 'bedienfehler');
  const liste = spawnSync(process.execPath, [cli, 'cli', 'list', 'codex', '--basis', L.basis, '--launcher-dir', L.launcherDir], { encoding: 'utf8' });
  assert.equal(liste.status, 0, liste.stderr);
  const j = JSON.parse(liste.stdout);
  assert.equal(j.success, true);
  assert.equal(j.ergebnis.aktiv.art, 'fehlt');
});

test('Runtime-Konfig: Autoupdate Standard AN, 0 nur Test-Ausschalter, behalten Standard 4, Quellen sichtbar', async () => {
  const { leseRuntimeKonfig } = await lade('startprofile/runtime.js');
  const k = leseRuntimeKonfig({ HOME: '/root' });
  assert.deepEqual(k.autoupdate, { wert: true, quelle: 'standard' });
  assert.deepEqual(k.behalten, { wert: 4, quelle: 'standard' });
  assert.equal(k.cliBasis.wert, '/root/.local/share/synapse-cli');
  assert.equal(leseRuntimeKonfig({ SYNAPSE_RUNTIME_CLI_AUTOUPDATE: '0' }).autoupdate.wert, false);
  assert.equal(leseRuntimeKonfig({ SYNAPSE_RUNTIME_CLI_BEHALTEN: '1' }).behalten.wert, 2);
  assert.throws(() => leseRuntimeKonfig({ SYNAPSE_RUNTIME_CLIS: 'claude,gemini' }), /unbekannte CLI/);
});

test('Startprofil runtime: Bundle, Status ohne Zugangswerte, DB gesperrt, keine PC-Dienste/Ports, Shutdown raeumt PID', async () => {
  const B = layout();
  await cv.installiereVersion(B, 'claude', '2.1.304', { quelle: 'bundle', akteur: 'image-build' }, fake);
  const d = join(tmp, 'rt');
  const home = join(d, 'home');
  fs.mkdirSync(join(home, '.synapse', 'file-watcher'), { recursive: true });
  fs.writeFileSync(join(home, '.synapse', 'file-watcher', 'config.json'), JSON.stringify({ synapse_api_url: 'http://127.0.0.1:9', synapse_api_token: 'GEHEIM-TOKEN-T4' }), { mode: 0o600 });
  const vorherHome = process.env.HOME;
  process.env.HOME = home; // leseApiZugang liest config.json aus HOME
  const { starteRuntimeProfil } = await lade('startprofile/runtime.js');
  const rt = await starteRuntimeProfil({
    signale: false, installer: fake, statusIntervallMs: 60_000, autoupdateStartVerzoegerungMs: 3_600_000,
    env: {
      HOME: home, SYNAPSE_RUNTIME_STATE_DIR: join(d, 'state'), SYNAPSE_RUNTIME_RUN_DIR: join(d, 'run'),
      SYNAPSE_RUNTIME_CLI_BUNDLE: B.basis, SYNAPSE_CLI_BASIS: join(d, 'cli'), SYNAPSE_CLI_LAUNCHER_DIR: join(d, 'bin'),
      DATABASE_URL: 'postgres://darf-nicht-benutzt-werden',
    },
  });
  try {
    const roh = fs.readFileSync(join(d, 'state', 'status.json'), 'utf8');
    assert.ok(!roh.includes('GEHEIM-TOKEN-T4'), 'Status enthaelt keinen Zugangswert');
    const s = JSON.parse(roh);
    assert.equal(s.profil, 'runtime');
    assert.deepEqual(s.datenweg, { art: 'api', db_gesperrt: true });
    const k = Object.fromEntries(s.daemon.komponenten.map((x) => [x.name, x.zustand]));
    assert.equal(k['cli-bundle'], 'gestartet');
    assert.equal(k['cli-autoupdate'], 'gestartet');
    assert.equal(k['api-zugang'], 'gestartet');
    assert.equal(k.status, 'gestartet');
    assert.equal(s.clis.find((c) => c.cli === 'claude').aktiv.version, '2.1.304');
    assert.equal(s.api_zugang.vorhanden, true);
    const core = await import(pathToFileURL(join(dist, '..', '..', 'core', 'dist', 'index.js')).href);
    assert.ok(core.dbZugriffGesperrt(), 'DB-Zugriff gesperrt');
    assert.ok(!process.getActiveResourcesInfo().includes('TCPServerWrap'), 'kein lauschender Port (keine PC-API, keine Weiterleitung 7879)');
    assert.equal(fs.existsSync(join(home, '.synapse', 'file-watcher', 'daemon.pid')), false, 'keine Tray-Discovery-Dateien');
    assert.equal(fs.readFileSync(join(d, 'run', 'daemon.pid'), 'utf8'), String(process.pid));
  } finally {
    await rt.stoppe();
    process.env.HOME = vorherHome;
  }
  assert.equal(fs.existsSync(join(d, 'run', 'daemon.pid')), false, 'PID-Marker entfernt');
});
