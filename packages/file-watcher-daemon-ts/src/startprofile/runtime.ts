/**
 * MODUL: startprofile/runtime.ts (P22-T4, W2a; Abgleich 04e27b12 Abschn. 1 + P3, W0c-Bericht 502500cd Abschn. 3/4/7)
 * ZWECK: Startprofil 'runtime' des Daemons im Agenten-Runtime-Container (Image docker/synapse-agent-runtime).
 *        Startet AUSSCHLIESSLICH Runtime-Faehigkeiten:
 *          - cli-bundle:      Kaltstart mit leerem home-Mount -> im Image mitgelieferte CLI-Versionen einmalig in den
 *                             beschreibbaren Installbereich kopieren (cli-versionen.ts). Aktiviert nur, wo noch gar
 *                             kein Launcher existiert.
 *          - cli-autoupdate:  periodisches Update der CLIs (neue Version daneben, Launcher-Tausch), danach aeltere
 *                             Versionen ueber SYNAPSE_RUNTIME_CLI_BEHALTEN (Standard 4) hinaus entfernen. Code-Standard AN;
 *                             von der API angelegte Container setzen SYNAPSE_RUNTIME_CLI_AUTOUPDATE=0, dort entscheidet
 *                             die API das Update (fuehreCliUpdatesAus, immer an; P22-T58 F5, P22-T60).
 *          - api-zugang:      nur Zustandsanzeige; Zugang aus ~/.synapse/file-watcher/config.json wie am PC, dort
 *                             abgelegt von der API (P22-T5, Vertrag 462ccb13 F3) (daemon-api-client.ts).
 *          - agentensteuerung: P22-T6 (runtime-agentensteuerung.ts): Spezialisten-Worker wie am PC (Jobs mit
 *                             target_runtime), Lebenszeichen, Runtime-Auftraege. Nur mit API-Zugang und
 *                             SYNAPSE_RUNTIME_NAME (claude|codex, Startkonfiguration des Containers).
 *          - status:          status.json im Runtime-State (Profil, Versionen, Pfadquellen, Komponenten, letzter Fehler).
 *        NICHT gestartet (anders als Profil pc): WatcherManager, startAllEnabled, Sync, Reverse, Shell-Worker,
 *        Project-Init, Enabled-Sync, PC-Heartbeat, Tray-Dateien, Loopback-PC-API, API-Weiterleitung 7879, Logpflege.
 *
 * DATENWEG: immer API, DB-Zugriff gesperrt (sperreDbZugriff) – auch wenn DATABASE_URL gesetzt ist. Kein PG-Rueckfall.
 *
 * SCHALTER: Die Wahl des Profils ist Startkonfiguration (Image-CMD bzw. SYNAPSE_DAEMON_PROFIL), kein Produkt-Schalter.
 *   Ob der Hauptagent ueberhaupt laeuft, entscheidet serverseitig der eine Produkt-Schalter 'hauptagent' (P22-T36,
 *   mit intern-Override); der Daemon bekommt ohne Zugang keine Arbeit. CLI-Updates sind auf User-Entscheidung immer an:
 *   im API-Container ueber die API (Daemon-Autoupdate =0), sonst ueber dieses Autoupdate (Standard AN).
 */
import fs from 'node:fs';
import path from 'node:path';
import { setzeDbProzess, sperreDbZugriff } from '@synapse/core';
import { DaemonKern, type DaemonKernOptionen, type DaemonKernStatus } from '../daemon-kern.js';
import { runtimeApiZugang } from '../daemon-api-client.js';
import { starteRuntimeAgentensteuerung } from '../runtime-agentensteuerung.js';
import { provisioniereRuntimeMods, type RuntimeModPaketStand } from '../runtime-mods.js';
import {
  CLI_NAMEN, istCliName, inventar, provisioniereBundle, aktualisiere, standardInstaller,
  type CliName, type CliLayout, type CliInstaller, type CliInventar, type UpdateErgebnis,
} from '../cli-versionen.js';

export type WertQuelle = 'env' | 'standard';
export interface Konfigwert<T> { wert: T; quelle: WertQuelle }

export interface RuntimeKonfig {
  stateDir: Konfigwert<string>;
  runDir: Konfigwert<string>;
  bundleDir: Konfigwert<string>;
  cliBasis: Konfigwert<string>;
  launcherDir: Konfigwert<string>;
  clis: Konfigwert<CliName[]>;
  autoupdate: Konfigwert<boolean>;
  autoupdateStunden: Konfigwert<number>;
  kanal: Record<CliName, Konfigwert<string>>;
  /** Wie viele Versionen je CLI nach einem Update hoechstens bleiben (User 20.10.2026: wie am PC, Standard 4); 0 = alle. */
  behalten: Konfigwert<number>;
}

function wert<T>(roh: string | undefined, standard: T, umwandeln: (s: string) => T): Konfigwert<T> {
  const s = (roh ?? '').trim();
  return s ? { wert: umwandeln(s), quelle: 'env' } : { wert: standard, quelle: 'standard' };
}

export function leseRuntimeKonfig(env: NodeJS.ProcessEnv = process.env): RuntimeKonfig {
  const home = env.HOME || '/root';
  const clis = wert<CliName[]>(env.SYNAPSE_RUNTIME_CLIS, [...CLI_NAMEN], (s) => {
    const liste = s.split(',').map((x) => x.trim()).filter(Boolean);
    const falsch = liste.filter((x) => !istCliName(x));
    if (falsch.length) throw new Error(`SYNAPSE_RUNTIME_CLIS: unbekannte CLI ${falsch.join(', ')} (erlaubt: ${CLI_NAMEN.join(', ')})`);
    return liste as CliName[];
  });
  const stunden = wert(env.SYNAPSE_RUNTIME_CLI_AUTOUPDATE_STUNDEN, 24, (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 1) throw new Error('SYNAPSE_RUNTIME_CLI_AUTOUPDATE_STUNDEN muss >= 1 sein');
    return n;
  });
  const kanal = {} as Record<CliName, Konfigwert<string>>;
  for (const cli of CLI_NAMEN) kanal[cli] = wert(env[`SYNAPSE_RUNTIME_CLI_KANAL_${cli.toUpperCase()}`], 'latest', (s) => s);
  return {
    stateDir: wert(env.SYNAPSE_RUNTIME_STATE_DIR, '/state/executor', (s) => s),
    runDir: wert(env.SYNAPSE_RUNTIME_RUN_DIR, '/tmp/synapse-runtime', (s) => s),
    bundleDir: wert(env.SYNAPSE_RUNTIME_CLI_BUNDLE, '/opt/synapse/cli-bundle', (s) => s),
    cliBasis: wert(env.SYNAPSE_CLI_BASIS, path.join(home, '.local', 'share', 'synapse-cli'), (s) => s),
    launcherDir: wert(env.SYNAPSE_CLI_LAUNCHER_DIR, path.join(home, '.local', 'bin'), (s) => s),
    clis,
    // User-Entscheidung 20.10.2026: Auto-Update im Container immer AN (Claude und Codex). '0'/'false' nur fuer Tests/Diagnose.
    autoupdate: wert(env.SYNAPSE_RUNTIME_CLI_AUTOUPDATE, true, (s) => !(s === '0' || s.toLowerCase() === 'false')),
    autoupdateStunden: stunden,
    kanal,
    behalten: wert(env.SYNAPSE_RUNTIME_CLI_BEHALTEN, 4, (s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) throw new Error('SYNAPSE_RUNTIME_CLI_BEHALTEN muss eine ganze Zahl >= 0 sein (0 = alle behalten)');
      return n === 1 ? 2 : n; // mindestens aktive + Rollback-Ziel
    }),
  };
}

export function layoutAus(k: RuntimeKonfig): CliLayout {
  return { basis: k.cliBasis.wert, launcherDir: k.launcherDir.wert };
}

export interface BuildInfo {
  daemon_version: string | null;
  image_revision: string | null;
  image_revision_quelle: 'env' | 'datei' | 'unbekannt';
  node: string;
}

export function leseBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  let daemonVersion: string | null = null;
  try {
    const pj = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    daemonVersion = pj.version ?? null;
  } catch { /* unbekannt */ }
  const envRev = (env.SYNAPSE_IMAGE_REVISION ?? '').trim();
  if (envRev) return { daemon_version: daemonVersion, image_revision: envRev, image_revision_quelle: 'env', node: process.version };
  try {
    const rev = fs.readFileSync('/opt/synapse/REVISION', 'utf8').trim();
    if (rev) return { daemon_version: daemonVersion, image_revision: rev, image_revision_quelle: 'datei', node: process.version };
  } catch { /* kein Image */ }
  return { daemon_version: daemonVersion, image_revision: null, image_revision_quelle: 'unbekannt', node: process.version };
}

export interface AutoupdateStand {
  aktiv: boolean;
  quelle: WertQuelle;
  intervall_stunden: number;
  letzter_lauf: string | null;
  naechster_lauf: string | null;
  ergebnisse: Partial<Record<CliName, UpdateErgebnis | { fehler: string }>>;
}

export interface RuntimeStatus {
  schema: 1;
  profil: 'runtime';
  erzeugt_am: string;
  daemon: DaemonKernStatus;
  build: BuildInfo;
  datenweg: { art: 'api'; db_gesperrt: true };
  konfig: RuntimeKonfig;
  api_zugang: { art: 'runtime'; vorhanden: boolean; hinweis: string | null };
  clis: CliInventar[];
  autoupdate: AutoupdateStand;
  mods: RuntimeModPaketStand;
  letzter_fehler: string | null;
}

export interface RuntimeDaemon {
  kern: DaemonKern;
  konfig: RuntimeKonfig;
  status(): RuntimeStatus;
  schreibeStatus(): void;
  /** Ein Autoupdate-Lauf sofort (auch bei Autoupdate AUS nicht automatisch – nur fuer Tests/Diagnose). */
  autoupdateLauf(): Promise<void>;
  stoppe(): Promise<void>;
}

export interface RuntimeProfilOptionen {
  env?: NodeJS.ProcessEnv;
  installer?: CliInstaller;
  kern?: DaemonKernOptionen;
  /** Signale installieren (Standard true; Tests false). */
  signale?: boolean;
  statusIntervallMs?: number;
  /** Verzoegerung des ersten Autoupdate-Laufs nach dem Start (Standard 5 Min). */
  autoupdateStartVerzoegerungMs?: number;
}

export const RUNTIME_STATUS_DATEI = 'status.json';

function schreibeAtomar(datei: string, inhalt: string): void {
  const tmp = `${datei}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, inhalt, { mode: 0o644 });
  fs.renameSync(tmp, datei);
}

export async function starteRuntimeProfil(opt: RuntimeProfilOptionen = {}): Promise<RuntimeDaemon> {
  const env = opt.env ?? process.env;
  try { setzeDbProzess('daemon'); } catch { /* Pool existiert bereits (Tests) – die Sperre unten gilt trotzdem */ }
  sperreDbZugriff('Runtime-Profil (P22-T4): der Daemon im Agenten-Container hat keinen DB-Zugang, alle Daten ueber die Synapse-API');

  const konfig = leseRuntimeKonfig(env);
  const layout = layoutAus(konfig);
  const installer = opt.installer ?? standardInstaller;
  fs.mkdirSync(konfig.stateDir.wert, { recursive: true });
  fs.mkdirSync(konfig.runDir.wert, { recursive: true });

  // Single-Instance je Container (PID-Marker im ephemeren Run-Bereich).
  const pidDatei = path.join(konfig.runDir.wert, 'daemon.pid');
  try {
    const alt = Number(fs.readFileSync(pidDatei, 'utf8').trim());
    if (alt && alt !== process.pid) {
      process.kill(alt, 0);
      console.error(`[daemon] Runtime-Daemon laeuft bereits (PID ${alt}) — beende.`);
      process.exit(0);
    }
  } catch { /* kein Marker oder Prozess tot */ }
  fs.writeFileSync(pidDatei, String(process.pid));

  const kern = new DaemonKern('runtime', opt.kern);
  const build = leseBuildInfo(env);
  let letzterFehler: string | null = null;
  const auto: AutoupdateStand = {
    aktiv: konfig.autoupdate.wert, quelle: konfig.autoupdate.quelle, intervall_stunden: konfig.autoupdateStunden.wert,
    letzter_lauf: null, naechster_lauf: null, ergebnisse: {},
  };

  const akteurDaemon = (quelle: 'bundle' | 'automatisch') => ({ quelle, akteur: 'runtime-daemon' as const });

  // --- cli-bundle -------------------------------------------------------------------------
  if (fs.existsSync(konfig.bundleDir.wert)) {
    await kern.starte('cli-bundle', async () => {
      for (const cli of konfig.clis.wert) {
        const r = await provisioniereBundle(konfig.bundleDir.wert, layout, cli, akteurDaemon('bundle'));
        if (r.kopiert.length || r.aktiviert) console.error(`[runtime] ${cli}: Bundle kopiert [${r.kopiert.join(', ')}]${r.aktiviert ? `, aktiviert ${r.aktiviert}` : ''}`);
      }
      return true;
    });
  } else {
    kern.markiereAus('cli-bundle', `kein Image-Bundle unter ${konfig.bundleDir.wert}`);
  }

  // P22-T194: nach dem HOME-Mount; das Paket bleibt im read-only Image. Keine Mod-Freigabe hier.
  // t223-Nachbesserung: ein defektes Paket darf den Runtime-Daemon nie stoppen (Schalter AUS = Betrieb wie bisher);
  // der verwaltete Start prueft das Paket ohnehin erneut (process.ts) und verweigert dann.
  let mods: RuntimeModPaketStand;
  try { mods = provisioniereRuntimeMods(env); }
  catch (err) {
    mods = { bereit: false, quelle: 'aus', revision: null, version: null, image_pfad: null, home_pfad: null, sha256: null,
      letzter_fehler: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
    console.error('[runtime-mods] Paket nicht bereit: ' + mods.letzter_fehler);
  }
  if (mods.bereit) kern.markiereGestartet('runtime-mods');
  else kern.markiereAus('runtime-mods', mods.letzter_fehler ?? 'kein verwaltetes Mod-Image');

  // --- api-zugang (nur Anzeige) -----------------------------------------------------------
  const zugangStand = () => {
    const z = runtimeApiZugang();
    return { art: 'runtime' as const, vorhanden: !!z.token, hinweis: z.token ? null : z.fehltHinweis };
  };
  const pruefeZugang = () => {
    const z = zugangStand();
    if (z.vorhanden) kern.markiereGestartet('api-zugang'); else kern.markiereAus('api-zugang', z.hinweis ?? 'kein Zugang');
    return z;
  };
  pruefeZugang();

  // --- agentensteuerung (P22-T6) -----------------------------------------------------------
  const runtimeName = (env.SYNAPSE_RUNTIME_NAME ?? '').trim();
  if (!zugangStand().vorhanden) {
    kern.markiereAus('agentensteuerung', 'kein API-Zugang (Runtime-Daemon-Zugang stellt der User in der Web-UI aus, P22-T5)');
  } else if (runtimeName !== 'claude' && runtimeName !== 'codex') {
    kern.markiereAus('agentensteuerung', 'SYNAPSE_RUNTIME_NAME fehlt oder unbekannt (claude|codex)');
  } else {
    const steuerung = await kern.starte('agentensteuerung', () => starteRuntimeAgentensteuerung({ runtime: runtimeName }));
    if (steuerung) kern.beimStopp('agentensteuerung', () => steuerung.stop());
  }

  // --- status ------------------------------------------------------------------------------
  const statusDatei = path.join(konfig.stateDir.wert, RUNTIME_STATUS_DATEI);
  const status = (): RuntimeStatus => ({
    schema: 1,
    profil: 'runtime',
    erzeugt_am: new Date().toISOString(),
    daemon: kern.status(),
    build,
    datenweg: { art: 'api', db_gesperrt: true },
    konfig,
    api_zugang: pruefeZugang(),
    clis: konfig.clis.wert.map((cli) => inventar(layout, cli)),
    autoupdate: { ...auto, ergebnisse: { ...auto.ergebnisse } },
    mods,
    letzter_fehler: letzterFehler,
  });
  const schreibeStatus = () => {
    try { schreibeAtomar(statusDatei, JSON.stringify(status(), null, 2) + '\n'); }
    catch (err) { letzterFehler = `status.json: ${(err as Error).message}`; console.error('[runtime] status.json nicht schreibbar:', err); }
  };

  // --- cli-autoupdate ----------------------------------------------------------------------
  let autoTimer: NodeJS.Timeout | null = null;
  let laeuft = false;
  const autoupdateLauf = async () => {
    if (laeuft) return;
    laeuft = true;
    try {
      auto.letzter_lauf = new Date().toISOString();
      for (const cli of konfig.clis.wert) {
        try {
          auto.ergebnisse[cli] = await aktualisiere(layout, cli, konfig.kanal[cli].wert, akteurDaemon('automatisch'), { installer, behalten: konfig.behalten.wert });
        } catch (err) {
          auto.ergebnisse[cli] = { fehler: (err as Error).message.slice(0, 500) };
          letzterFehler = `autoupdate ${cli}: ${(err as Error).message.slice(0, 300)}`;
        }
      }
    } finally {
      laeuft = false;
      schreibeStatus();
    }
  };
  if (konfig.autoupdate.wert) {
    const intervall = konfig.autoupdateStunden.wert * 3_600_000;
    const plane = (inMs: number) => {
      auto.naechster_lauf = new Date(Date.now() + inMs).toISOString();
      autoTimer = setTimeout(() => { void autoupdateLauf().finally(() => { if (!kern.beendetSich) plane(intervall); }); }, inMs);
      autoTimer.unref();
    };
    plane(opt.autoupdateStartVerzoegerungMs ?? 5 * 60_000);
    kern.markiereGestartet('cli-autoupdate');
  } else {
    kern.markiereAus('cli-autoupdate', 'per Startkonfiguration SYNAPSE_RUNTIME_CLI_AUTOUPDATE=0 abgeschaltet (Standard AN)');
  }

  kern.markiereGestartet('status');
  schreibeStatus();
  const statusTimer = setInterval(schreibeStatus, opt.statusIntervallMs ?? 30_000);

  kern.beimStopp('cli-autoupdate', () => { if (autoTimer) clearTimeout(autoTimer); });
  kern.beimStopp('status', () => { clearInterval(statusTimer); schreibeStatus(); });
  kern.beimStopp('PID-Marker', () => {
    try { if (fs.readFileSync(pidDatei, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidDatei); } catch { /* weg */ }
  });
  if (opt.signale !== false) kern.installiereSignale();

  console.error('================================================');
  console.error('  Synapse Daemon (TS) — Startprofil runtime');
  console.error(`  Build:    ${build.image_revision ?? 'unbekannt'} (Daemon ${build.daemon_version ?? '?'}, Node ${build.node})`);
  console.error(`  CLIs:     ${konfig.clis.wert.join(', ')} (Autoupdate ${konfig.autoupdate.wert ? 'EIN' : 'AUS'})`);
  console.error(`  Status:   ${statusDatei}`);
  console.error(`  PID:      ${process.pid}`);
  console.error('================================================');

  return {
    kern,
    konfig,
    status,
    schreibeStatus,
    autoupdateLauf,
    stoppe: async () => {
      if (autoTimer) clearTimeout(autoTimer);
      clearInterval(statusTimer);
      schreibeStatus();
      try { if (fs.readFileSync(pidDatei, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidDatei); } catch { /* weg */ }
    },
  };
}
