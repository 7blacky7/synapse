/**
 * MODUL: cli-versionen.ts (P22-T4, W2a)
 * ZWECK: Versionierte Installation der Agenten-CLIs (Claude Code, Codex) im Runtime-Container mit Update und
 *        Rollback. Vertrag: W0c-Bericht 502500cd Abschn. 4, User-Klarstellung e039ae52 (19.10.2026):
 *        versionierte Installation JA, festgeschriebene Version ohne Update NEIN; Updates automatisch UND manuell,
 *        laufende Agenten nicht unterbrechen, installierte Versionen nachvollziehbar, Rollback nach Moeglichkeit.
 *
 * LAYOUT (beschreibbarer, persistenter home-Mount; Rootfs bleibt read-only):
 *   <basis>/<cli>/versions/<version>/          eine Installation je exakter Version; nach einem Update bleiben die
 *                                              neuesten 'behalten' (Runtime-Standard 4 wie am PC), nie entfernt werden
 *                                              aktive Version, Rollback-Ziel und laufende Versionen
 *   <basis>/<cli>/versions/<version>/synapse-version.json   Metadaten (zuletzt geschrieben = Installation fertig)
 *   <basis>/<cli>/verlauf.jsonl                jede Installation/Aktivierung/jedes Rollback mit Quelle und Akteur
 *   <basis>/<cli>/.sperre                      PID des gerade arbeitenden Prozesses (Daemon oder synapse-runtime)
 *   <launcherDir>/<cli>                        EINZIGER aktiver Launcher im PATH: Symlink auf den Einstieg einer Version
 *   Standard: basis ~/.local/share/synapse-cli, launcherDir ~/.local/bin (SYNAPSE_CLI_BASIS, SYNAPSE_CLI_LAUNCHER_DIR).
 *
 * WARUM EIGENES LAYOUT: Der native Claude-Installer/-Updater entfernt alte Versionen selbst (Anthropic-Doku laut
 *   502500cd); unter dem Loeschverbot muss jede Version erhalten bleiben. Darum laeuft der offizielle Installer nur in
 *   einem Wegwerf-HOME unter <basis>/.installer-tmp, die geprueften Binaries landen hier. DISABLE_AUTOUPDATER=1 (Image) verhindert
 *   eigenmaechtige Hintergrund-Updates der CLI; Updates laufen nur ueber diesen Weg.
 *
 * NICHT UNTERBRECHEN: Ein Update installiert die neue Version DANEBEN und tauscht danach nur den Launcher-Symlink
 *   atomar (rename). Laufende CLI-Prozesse behalten ihre Dateien (alte Versionen bleiben liegen); der naechste
 *   Start bzw. Neustart nimmt die neue Version.
 *
 * FREMDER LAUNCHER: Liegt unter <launcherDir>/<cli> etwas, das nicht in dieses Layout zeigt (z. B. die alte
 *   npm-@latest-Installation der heutigen Runtime-Container), wird es nie automatisch ersetzt. Erst eine
 *   ausdrueckliche Aktivierung tauscht den Symlink; das alte Ziel steht im Verlauf und ist per Rollback wieder
 *   herstellbar. Die alte Installation selbst bleibt unberuehrt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const CLI_NAMEN = ['claude', 'codex'] as const;
export type CliName = typeof CLI_NAMEN[number];

export function istCliName(wert: string): wert is CliName {
  return (CLI_NAMEN as readonly string[]).includes(wert);
}

/** npm-Paket je CLI: Versionsaufloesung (dist-tags) und bei Codex die Installation selbst. */
export const CLI_PAKET: Record<CliName, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

export interface CliLayout {
  basis: string;
  launcherDir: string;
}

export function standardLayout(env: NodeJS.ProcessEnv = process.env): CliLayout {
  const home = env.HOME || os.homedir() || '/root';
  return {
    basis: (env.SYNAPSE_CLI_BASIS ?? '').trim() || path.join(home, '.local', 'share', 'synapse-cli'),
    launcherDir: (env.SYNAPSE_CLI_LAUNCHER_DIR ?? '').trim() || path.join(home, '.local', 'bin'),
  };
}

export type AktionsQuelle = 'manuell' | 'automatisch' | 'bundle' | 'auftrag';

export interface Akteur {
  quelle: AktionsQuelle;
  /** z. B. 'user', 'koordinator:<agent>', 'runtime-daemon', 'image-build' */
  akteur: string;
}

export interface VersionsMeta {
  cli: CliName;
  version: string;
  /** relativ zum Versionsverzeichnis */
  einstieg: string;
  installiert_am: string;
  quelle: AktionsQuelle;
  akteur: string;
  /** Ausgabe von --version bei der Pruefung */
  versionsausgabe: string;
}

export type LauncherArt = 'synapse' | 'fremd' | 'fehlt';

export interface LauncherStand {
  launcher: string;
  art: LauncherArt;
  /** aufgeloestes Symlink-Ziel bzw. Pfad der fremden Datei */
  ziel: string | null;
  /** nur bei art 'synapse' */
  version: string | null;
}

export type VerlaufAktion = 'installiert' | 'aktiviert' | 'rollback' | 'fehlgeschlagen' | 'entfernt';

export interface VerlaufEintrag {
  zeit: string;
  aktion: VerlaufAktion;
  version: string | null;
  von?: LauncherStand;
  nach?: LauncherStand;
  quelle: AktionsQuelle;
  akteur: string;
  meldung?: string;
}

export interface CliInventar {
  cli: CliName;
  basis: string;
  aktiv: LauncherStand;
  installiert: VersionsMeta[];
  letzte_aktion: VerlaufEintrag | null;
}

export class CliVersionFehler extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Installer (Testnaht: injizierbar)
// ---------------------------------------------------------------------------------------------
export interface CliInstaller {
  /** Exakte Version unveraendert, sonst dist-tag (latest, stable, ...) ueber die npm-Registry aufloesen. */
  loeseVersion(cli: CliName, ziel: string): Promise<string>;
  /** Installiert genau `version` in das (leere) Verzeichnis zielDir; liefert den Einstieg relativ zu zielDir. */
  installiere(cli: CliName, version: string, zielDir: string, layout: CliLayout): Promise<{ einstieg: string }>;
  /** --version des Einstiegs (absoluter Pfad). */
  versionsausgabe(einstiegAbs: string): Promise<string>;
}

const EXAKTE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function istExakteVersion(wert: string): boolean {
  return EXAKTE_VERSION.test(wert);
}

/** Numerischer Vergleich x.y.z (Vorabversionen zaehlen als kleiner). >0: a neuer als b. */
export function vergleicheVersionen(a: string, b: string): number {
  const teile = (v: string) => {
    const [kern, vorab] = v.split(/[-+]/, 2);
    return { zahlen: kern.split('.').map((z) => Number.parseInt(z, 10) || 0), vorab: v.includes('-') ? (vorab ?? '') : '' };
  };
  const x = teile(a), y = teile(b);
  for (let i = 0; i < Math.max(x.zahlen.length, y.zahlen.length); i++) {
    const d = (x.zahlen[i] ?? 0) - (y.zahlen[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.vorab === y.vorab) return 0;
  if (!x.vorab) return 1;
  if (!y.vorab) return -1;
  return x.vorab < y.vorab ? -1 : 1;
}

interface Lauf { code: number | null; stdout: string; stderr: string }

function fuehreAus(befehl: string, args: string[], opt: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number }): Promise<Lauf> {
  return new Promise((resolve, reject) => {
    const kind = spawn(befehl, args, { env: opt.env ?? process.env, cwd: opt.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    kind.stdout.on('data', (d: Buffer) => { stdout = (stdout + d.toString()).slice(-64_000); });
    kind.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-64_000); });
    const timer = setTimeout(() => { kind.kill('SIGKILL'); }, opt.timeoutMs);
    kind.on('error', (err) => { clearTimeout(timer); reject(err); });
    kind.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function cliUmgebung(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, DISABLE_AUTOUPDATER: '1', ...extra };
}

export const standardInstaller: CliInstaller = {
  async loeseVersion(cli, ziel) {
    const wert = ziel.trim();
    if (istExakteVersion(wert)) return wert;
    if (!DIST_TAG.test(wert)) throw new CliVersionFehler('ziel_ungueltig', `"${ziel}" ist weder eine exakte Version noch ein dist-tag`);
    const registry = ((process.env.SYNAPSE_NPM_REGISTRY ?? process.env.npm_config_registry ?? '').trim() || 'https://registry.npmjs.org').replace(/\/+$/, '');
    const res = await fetch(`${registry}/-/package/${CLI_PAKET[cli]}/dist-tags`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new CliVersionFehler('registry_fehler', `npm-Registry antwortete HTTP ${res.status} fuer ${CLI_PAKET[cli]}`);
    const tags = (await res.json()) as Record<string, unknown>;
    const version = tags[wert];
    if (typeof version !== 'string' || !istExakteVersion(version)) {
      throw new CliVersionFehler('tag_unbekannt', `dist-tag "${wert}" fuer ${CLI_PAKET[cli]} unbekannt`);
    }
    return version;
  },

  async installiere(cli, version, zielDir, layout) {
    if (cli === 'claude') {
      // Offizieller nativer Installer mit exakter Version, aber in einem Wegwerf-HOME: so fasst er weder den
      // echten Launcher noch alte Versionen an. Das gepruefte Binary wird danach ins Versionsverzeichnis kopiert.
      // Das Wegwerf-HOME liegt im Installbereich (gleiches Dateisystem, persistent), nicht in /tmp: das tmpfs der
      // Runtime-Container hat 256 MB, der Installer braucht Download plus Binary.
      const url = (process.env.SYNAPSE_CLAUDE_INSTALLER_URL ?? '').trim() || 'https://claude.ai/install.sh';
      const tmpBasis = (process.env.SYNAPSE_CLI_INSTALL_TMP ?? '').trim() || path.join(layout.basis, '.installer-tmp');
      fs.mkdirSync(tmpBasis, { recursive: true });
      const wegwerf = fs.mkdtempSync(path.join(tmpBasis, `claude-${version}-`));
      try {
        const lauf = await fuehreAus('bash', ['-c', 'set -euo pipefail; curl -fsSL "$SYNAPSE_INSTALLER_URL" | bash -s -- "$SYNAPSE_INSTALLER_VERSION"'], {
          env: cliUmgebung({ HOME: wegwerf, SYNAPSE_INSTALLER_URL: url, SYNAPSE_INSTALLER_VERSION: version }),
          cwd: wegwerf,
          timeoutMs: 15 * 60_000,
        });
        if (lauf.code !== 0) throw new CliVersionFehler('installer_fehler', `Claude-Installer Exit ${lauf.code}: ${(lauf.stderr || lauf.stdout).slice(-1500)}`);
        const versionen = path.join(wegwerf, '.local', 'share', 'claude', 'versions');
        let quelle = path.join(versionen, version);
        if (!fs.existsSync(quelle)) {
          const vorhanden = fs.existsSync(versionen) ? fs.readdirSync(versionen) : [];
          if (vorhanden.length !== 1) throw new CliVersionFehler('installer_fehler', `Claude-Binary ${version} nach dem Installer nicht gefunden (vorhanden: ${vorhanden.join(', ') || 'nichts'})`);
          quelle = path.join(versionen, vorhanden[0]);
        }
        fs.copyFileSync(quelle, path.join(zielDir, 'claude'));
        fs.chmodSync(path.join(zielDir, 'claude'), 0o755);
        return { einstieg: 'claude' };
      } finally {
        // Nur das eigene Wegwerf-HOME dieses Laufs (eben mit mkdtemp angelegt); nichts ausserhalb.
        fs.rmSync(wegwerf, { recursive: true, force: true });
      }
    }
    // Codex: festes Paket in ein eigenes Versionsverzeichnis (pnpm, User-Regel). Store auf dem beschreibbaren Mount.
    const store = (process.env.SYNAPSE_CLI_PNPM_STORE ?? '').trim() || path.join(layout.basis, '.pnpm-store');
    fs.writeFileSync(path.join(zielDir, 'package.json'), JSON.stringify({ name: `synapse-cli-codex-${version}`, private: true }, null, 2) + '\n');
    const lauf = await fuehreAus('pnpm', ['add', '--dir', zielDir, '--ignore-workspace', '--store-dir', store, `${CLI_PAKET.codex}@${version}`], {
      env: cliUmgebung({ CI: '1' }), cwd: zielDir, timeoutMs: 15 * 60_000,
    });
    if (lauf.code !== 0) throw new CliVersionFehler('installer_fehler', `pnpm add ${CLI_PAKET.codex}@${version} Exit ${lauf.code}: ${(lauf.stderr || lauf.stdout).slice(-1500)}`);
    const paketDir = path.join(zielDir, 'node_modules', ...CLI_PAKET.codex.split('/'));
    const pj = JSON.parse(fs.readFileSync(path.join(paketDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pj.bin === 'string' ? pj.bin : pj.bin?.codex;
    if (!bin) throw new CliVersionFehler('installer_fehler', `${CLI_PAKET.codex}@${version} ohne bin-Eintrag codex`);
    return { einstieg: path.relative(zielDir, path.join(paketDir, bin)) };
  },

  async versionsausgabe(einstiegAbs) {
    const lauf = await fuehreAus(einstiegAbs, ['--version'], { env: cliUmgebung(), timeoutMs: 60_000 });
    if (lauf.code !== 0) throw new CliVersionFehler('version_pruefung', `${einstiegAbs} --version Exit ${lauf.code}: ${(lauf.stderr || lauf.stdout).slice(-500)}`);
    return (lauf.stdout || lauf.stderr).trim();
  },
};

// ---------------------------------------------------------------------------------------------
// Pfade, Metadaten, Verlauf
// ---------------------------------------------------------------------------------------------
function cliDir(layout: CliLayout, cli: CliName): string { return path.join(layout.basis, cli); }
function versionenDir(layout: CliLayout, cli: CliName): string { return path.join(cliDir(layout, cli), 'versions'); }
function versionDir(layout: CliLayout, cli: CliName, version: string): string {
  if (!istExakteVersion(version)) throw new CliVersionFehler('version_ungueltig', `"${version}" ist keine exakte Version`);
  return path.join(versionenDir(layout, cli), version);
}
const META_DATEI = 'synapse-version.json';

function leseMeta(dir: string): VersionsMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META_DATEI), 'utf8')) as VersionsMeta;
    return m && typeof m.version === 'string' && typeof m.einstieg === 'string' ? m : null;
  } catch { return null; }
}

export function installierteVersionen(layout: CliLayout, cli: CliName): VersionsMeta[] {
  const dir = versionenDir(layout, cli);
  let namen: string[] = [];
  try { namen = fs.readdirSync(dir); } catch { return []; }
  return namen
    .filter((n) => istExakteVersion(n))
    .map((n) => leseMeta(path.join(dir, n)))
    .filter((m): m is VersionsMeta => m !== null)
    .sort((a, b) => vergleicheVersionen(a.version, b.version));
}

export function launcherStand(layout: CliLayout, cli: CliName): LauncherStand {
  const launcher = path.join(layout.launcherDir, cli);
  let lst: fs.Stats;
  try { lst = fs.lstatSync(launcher); } catch { return { launcher, art: 'fehlt', ziel: null, version: null }; }
  if (!lst.isSymbolicLink()) return { launcher, art: 'fremd', ziel: launcher, version: null };
  const roh = fs.readlinkSync(launcher);
  const ziel = path.resolve(path.dirname(launcher), roh);
  const rel = path.relative(versionenDir(layout, cli), ziel);
  const version = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : null;
  if (version && istExakteVersion(version) && leseMeta(path.join(versionenDir(layout, cli), version))) {
    return { launcher, art: 'synapse', ziel, version };
  }
  return { launcher, art: 'fremd', ziel, version: null };
}

function schreibeVerlauf(layout: CliLayout, cli: CliName, e: Omit<VerlaufEintrag, 'zeit'>): VerlaufEintrag {
  const eintrag: VerlaufEintrag = { zeit: new Date().toISOString(), ...e };
  fs.mkdirSync(cliDir(layout, cli), { recursive: true });
  fs.appendFileSync(path.join(cliDir(layout, cli), 'verlauf.jsonl'), JSON.stringify(eintrag) + '\n');
  return eintrag;
}

export function leseVerlauf(layout: CliLayout, cli: CliName, limit = 50): VerlaufEintrag[] {
  let text = '';
  try { text = fs.readFileSync(path.join(cliDir(layout, cli), 'verlauf.jsonl'), 'utf8'); } catch { return []; }
  const zeilen = text.split('\n').filter(Boolean);
  const ergebnis: VerlaufEintrag[] = [];
  for (const z of zeilen.slice(-limit)) {
    try { ergebnis.push(JSON.parse(z) as VerlaufEintrag); } catch { /* defekte Zeile ueberspringen */ }
  }
  return ergebnis;
}

export function inventar(layout: CliLayout, cli: CliName): CliInventar {
  const verlauf = leseVerlauf(layout, cli, 1);
  return { cli, basis: cliDir(layout, cli), aktiv: launcherStand(layout, cli), installiert: installierteVersionen(layout, cli), letzte_aktion: verlauf[0] ?? null };
}

// ---------------------------------------------------------------------------------------------
// Sperre: genau ein Prozess veraendert eine CLI zur Zeit (Daemon-Automatik vs. manuelles synapse-runtime)
// ---------------------------------------------------------------------------------------------
function prozessLebt(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function mitSperre<T>(layout: CliLayout, cli: CliName, arbeit: () => Promise<T>): Promise<T> {
  fs.mkdirSync(cliDir(layout, cli), { recursive: true });
  const datei = path.join(cliDir(layout, cli), '.sperre');
  try {
    fs.writeFileSync(datei, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pid = Number.parseInt(fs.readFileSync(datei, 'utf8').trim(), 10);
    if (pid && pid !== process.pid && prozessLebt(pid)) {
      throw new CliVersionFehler('cli_gesperrt', `${cli}: anderer Vorgang laeuft (PID ${pid})`);
    }
    fs.writeFileSync(datei, String(process.pid)); // verwaiste Sperre eines beendeten Prozesses uebernehmen
  }
  try {
    return await arbeit();
  } finally {
    try { if (fs.readFileSync(datei, 'utf8').trim() === String(process.pid)) fs.unlinkSync(datei); } catch { /* weg */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Operationen
// ---------------------------------------------------------------------------------------------
export interface InstallErgebnis { version: string; neu: boolean; meta: VersionsMeta }

async function installiereOhneSperre(layout: CliLayout, cli: CliName, version: string, akteur: Akteur, installer: CliInstaller): Promise<InstallErgebnis> {
  const ziel = versionDir(layout, cli, version);
  const vorhanden = leseMeta(ziel);
  if (vorhanden) return { version, neu: false, meta: vorhanden };
  if (fs.existsSync(ziel)) {
    // Abgebrochener frueherer Versuch (ohne Metadaten): beiseitelegen statt loeschen.
    fs.renameSync(ziel, path.join(versionenDir(layout, cli), `.unvollstaendig-${version}-${Date.now()}`));
  }
  fs.mkdirSync(ziel, { recursive: true });
  try {
    const { einstieg } = await installer.installiere(cli, version, ziel, layout);
    const einstiegAbs = path.join(ziel, einstieg);
    const ausgabe = await installer.versionsausgabe(einstiegAbs);
    if (!ausgabe.includes(version)) {
      throw new CliVersionFehler('version_abweichend', `${cli} meldet "${ausgabe.slice(0, 200)}", erwartet ${version}`);
    }
    const meta: VersionsMeta = { cli, version, einstieg, installiert_am: new Date().toISOString(), quelle: akteur.quelle, akteur: akteur.akteur, versionsausgabe: ausgabe.slice(0, 200) };
    fs.writeFileSync(path.join(ziel, META_DATEI), JSON.stringify(meta, null, 2) + '\n');
    schreibeVerlauf(layout, cli, { aktion: 'installiert', version, quelle: akteur.quelle, akteur: akteur.akteur });
    return { version, neu: true, meta };
  } catch (err) {
    const beiseite = path.join(versionenDir(layout, cli), `.fehlgeschlagen-${version}-${Date.now()}`);
    try { fs.renameSync(ziel, beiseite); } catch { /* bleibt ohne Metadaten liegen und zaehlt nicht */ }
    schreibeVerlauf(layout, cli, { aktion: 'fehlgeschlagen', version, quelle: akteur.quelle, akteur: akteur.akteur, meldung: (err as Error).message.slice(0, 500) });
    throw err;
  }
}

function setzeLauncher(layout: CliLayout, cli: CliName, ziel: string): void {
  fs.mkdirSync(layout.launcherDir, { recursive: true });
  const launcher = path.join(layout.launcherDir, cli);
  const neu = `${launcher}.neu-${process.pid}-${randomBytes(3).toString('hex')}`;
  fs.symlinkSync(ziel, neu);
  fs.renameSync(neu, launcher); // atomar: laufende Prozesse sind nicht betroffen
}

function aktiviereOhneSperre(layout: CliLayout, cli: CliName, version: string, akteur: Akteur, aktion: 'aktiviert' | 'rollback' = 'aktiviert'): VerlaufEintrag {
  const dir = versionDir(layout, cli, version);
  const meta = leseMeta(dir);
  if (!meta) throw new CliVersionFehler('version_fehlt', `${cli} ${version} ist nicht installiert`);
  let von = launcherStand(layout, cli);
  if (von.art === 'synapse' && von.version === version) {
    return { zeit: new Date().toISOString(), aktion, version, von, nach: von, quelle: akteur.quelle, akteur: akteur.akteur, meldung: 'bereits aktiv' };
  }
  if (von.art === 'fremd' && von.ziel === von.launcher) {
    // Fremder Launcher ist eine echte Datei (kein Symlink): beiseitelegen, nie ueberschreiben. Rollback zeigt dorthin.
    const gesichert = `${von.launcher}.vor-synapse-${Date.now()}`;
    fs.renameSync(von.launcher, gesichert);
    von = { ...von, ziel: gesichert };
  }
  setzeLauncher(layout, cli, path.join(dir, meta.einstieg));
  return schreibeVerlauf(layout, cli, { aktion, version, von, nach: launcherStand(layout, cli), quelle: akteur.quelle, akteur: akteur.akteur });
}

/** Installiert eine Version daneben (exakt oder dist-tag); aktiviert NICHT. */
export async function installiereVersion(layout: CliLayout, cli: CliName, ziel: string, akteur: Akteur, installer: CliInstaller = standardInstaller): Promise<InstallErgebnis> {
  const version = await installer.loeseVersion(cli, ziel);
  return mitSperre(layout, cli, () => installiereOhneSperre(layout, cli, version, akteur, installer));
}

/** Schaltet den Launcher auf eine installierte Version um (auch weg von einem fremden Launcher). */
export async function aktiviereVersion(layout: CliLayout, cli: CliName, version: string, akteur: Akteur): Promise<VerlaufEintrag> {
  return mitSperre(layout, cli, async () => aktiviereOhneSperre(layout, cli, version, akteur));
}

export interface UpdateErgebnis {
  cli: CliName;
  ziel: string;
  version: string;
  installiert_neu: boolean;
  aktiviert: boolean;
  vorher: LauncherStand;
  hinweis?: string;
  /** nur bei behalten > 0 */
  aufgeraeumt?: AufraeumErgebnis;
}

/**
 * Update = installieren + aktivieren. Ohne `erzwingen` nur, wenn die Zielversion neuer ist als die aktive
 * (Automatik darf nie zurueckstufen). Ein fremder Launcher wird nur bei manueller Ausloesung ersetzt.
 */
export async function aktualisiere(layout: CliLayout, cli: CliName, ziel: string, akteur: Akteur,
  opt: { installer?: CliInstaller; erzwingen?: boolean; behalten?: number } = {}): Promise<UpdateErgebnis> {
  const installer = opt.installer ?? standardInstaller;
  const version = await installer.loeseVersion(cli, ziel);
  return mitSperre(layout, cli, async () => {
    const vorher = launcherStand(layout, cli);
    const basis: UpdateErgebnis = { cli, ziel, version, installiert_neu: false, aktiviert: false, vorher };
    if (vorher.art === 'synapse' && vorher.version === version) return { ...basis, hinweis: 'bereits aktiv' };
    if (vorher.art === 'synapse' && vorher.version && !opt.erzwingen && vergleicheVersionen(version, vorher.version) < 0) {
      return { ...basis, hinweis: `${version} ist aelter als die aktive ${vorher.version} – kein Update (erzwingen fuer Rueckstufung)` };
    }
    if (vorher.art === 'fremd' && akteur.quelle === 'automatisch') {
      return { ...basis, hinweis: 'fremder Launcher aktiv – Umstellung nur manuell (freigegebener Betriebsschritt)' };
    }
    const inst = await installiereOhneSperre(layout, cli, version, akteur, installer);
    aktiviereOhneSperre(layout, cli, version, akteur);
    const aufgeraeumt = opt.behalten && opt.behalten > 0 ? raeumeAufOhneSperre(layout, cli, opt.behalten, akteur) : undefined;
    return { ...basis, installiert_neu: inst.neu, aktiviert: true, ...(aufgeraeumt ? { aufgeraeumt } : {}) };
  });
}

/** Umschaltstapel aus dem Verlauf: jede Aktivierung legt auf, jedes Rollback nimmt die oberste ab. */
function umschaltStapel(layout: CliLayout, cli: CliName): VerlaufEintrag[] {
  const stapel: VerlaufEintrag[] = [];
  for (const e of leseVerlauf(layout, cli, 10_000)) {
    if (e.aktion === 'aktiviert' && e.von && e.nach && e.meldung !== 'bereits aktiv') stapel.push(e);
    else if (e.aktion === 'rollback') stapel.pop();
  }
  return stapel;
}

/** true, wenn ein laufender Prozess eine Datei aus dir ausfuehrt oder in der Kommandozeile nennt (Linux /proc). */
export function versionInBenutzung(dir: string): boolean {
  const praefix = path.resolve(dir) + path.sep;
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return false; }
  for (const pid of pids) {
    try { if (fs.readlinkSync(`/proc/${pid}/exe`).startsWith(praefix)) return true; } catch { /* fremder/beendeter Prozess */ }
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some((a) => a.startsWith(praefix))) return true; } catch { /* dito */ }
  }
  return false;
}

export interface AufraeumErgebnis {
  behalten_soll: number;
  entfernt: string[];
  geschuetzt: Array<{ version: string; grund: 'aktiv' | 'rollback_ziel' | 'laeuft' }>;
}

function raeumeAufOhneSperre(layout: CliLayout, cli: CliName, behalten: number, akteur: Akteur): AufraeumErgebnis {
  const ergebnis: AufraeumErgebnis = { behalten_soll: behalten, entfernt: [], geschuetzt: [] };
  const versionen = installierteVersionen(layout, cli); // aufsteigend
  const ueberzaehlig = versionen.slice(0, Math.max(0, versionen.length - behalten));
  const aktiv = launcherStand(layout, cli).version;
  const rollbackZiel = umschaltStapel(layout, cli).at(-1)?.von?.version ?? null;
  for (const m of ueberzaehlig) {
    const dir = versionDir(layout, cli, m.version);
    if (m.version === aktiv) { ergebnis.geschuetzt.push({ version: m.version, grund: 'aktiv' }); continue; }
    if (m.version === rollbackZiel) { ergebnis.geschuetzt.push({ version: m.version, grund: 'rollback_ziel' }); continue; }
    if (versionInBenutzung(dir)) { ergebnis.geschuetzt.push({ version: m.version, grund: 'laeuft' }); continue; }
    // Erst Metadaten weg (zaehlt dann nicht mehr als installiert), dann das Verzeichnis.
    fs.unlinkSync(path.join(dir, META_DATEI));
    fs.rmSync(dir, { recursive: true, force: true });
    schreibeVerlauf(layout, cli, { aktion: 'entfernt', version: m.version, quelle: akteur.quelle, akteur: akteur.akteur, meldung: `behalten=${behalten}` });
    ergebnis.entfernt.push(m.version);
  }
  return ergebnis;
}

/**
 * Alte Versionen entfernen, bis hoechstens `behalten` installiert sind (die neuesten bleiben). behalten <= 0 = nichts
 * entfernen. Nie entfernt: die aktive Version, das Rollback-Ziel und Versionen, aus denen gerade ein Prozess laeuft
 * (laufende Agenten werden nicht unterbrochen).
 */
export async function raeumeAuf(layout: CliLayout, cli: CliName, behalten: number, akteur: Akteur): Promise<AufraeumErgebnis> {
  if (!Number.isInteger(behalten) || behalten <= 0) return { behalten_soll: behalten, entfernt: [], geschuetzt: [] };
  return mitSperre(layout, cli, async () => raeumeAufOhneSperre(layout, cli, behalten, akteur));
}

/**
 * Rollback auf den Stand vor der letzten Umschaltung (aus dem Verlauf). Ziel war eine eigene Version -> diese
 * aktivieren; war es ein fremder Launcher, wird genau dessen Symlink-Ziel wiederhergestellt, sofern es noch existiert.
 */
export async function rollback(layout: CliLayout, cli: CliName, akteur: Akteur): Promise<VerlaufEintrag> {
  return mitSperre(layout, cli, async () => {
    const jetzt = launcherStand(layout, cli);
    // Stapel -> wiederholtes Rollback geht schrittweise zurueck.
    const letzte = umschaltStapel(layout, cli).at(-1);
    if (!letzte?.von) throw new CliVersionFehler('kein_vorheriger_stand', `${cli}: keine fruehere Umschaltung im Verlauf`);
    if (letzte.nach?.ziel !== jetzt.ziel) {
      throw new CliVersionFehler('launcher_veraendert', `${cli}: aktiver Launcher (${jetzt.ziel ?? 'fehlt'}) passt nicht zur letzten Umschaltung (${letzte.nach?.ziel}) – von Hand geaendert? Mit "use" gezielt umschalten.`);
    }
    const ziel = letzte.von;
    if (ziel.art === 'synapse' && ziel.version) return aktiviereOhneSperre(layout, cli, ziel.version, akteur, 'rollback');
    if (ziel.art === 'fremd' && ziel.ziel && ziel.ziel !== ziel.launcher && fs.existsSync(ziel.ziel)) {
      setzeLauncher(layout, cli, ziel.ziel);
      return schreibeVerlauf(layout, cli, { aktion: 'rollback', version: null, von: jetzt, nach: launcherStand(layout, cli), quelle: akteur.quelle, akteur: akteur.akteur });
    }
    throw new CliVersionFehler('kein_vorheriger_stand', `${cli}: vorheriger Stand (${ziel.art}${ziel.ziel ? ` ${ziel.ziel}` : ''}) ist nicht wiederherstellbar`);
  });
}

/**
 * Kaltstart mit leerem home-Mount: im Image mitgelieferte Versionen (<bundle>/<cli>/versions/<v>) einmalig in den
 * beschreibbaren Bereich kopieren. Aktiviert nur, wenn noch GAR KEIN Launcher existiert (fremde bleiben).
 */
export async function provisioniereBundle(bundleBasis: string, layout: CliLayout, cli: CliName, akteur: Akteur): Promise<{ kopiert: string[]; aktiviert: string | null }> {
  const bundle: CliLayout = { basis: bundleBasis, launcherDir: layout.launcherDir };
  const vorhanden = installierteVersionen(bundle, cli);
  if (vorhanden.length === 0) return { kopiert: [], aktiviert: null };
  return mitSperre(layout, cli, async () => {
    const kopiert: string[] = [];
    for (const m of vorhanden) {
      const ziel = versionDir(layout, cli, m.version);
      if (leseMeta(ziel)) continue;
      if (fs.existsSync(ziel)) fs.renameSync(ziel, path.join(versionenDir(layout, cli), `.unvollstaendig-${m.version}-${Date.now()}`));
      fs.mkdirSync(path.dirname(ziel), { recursive: true });
      const tmp = path.join(versionenDir(layout, cli), `.kopie-${m.version}-${process.pid}`);
      fs.cpSync(versionDir(bundle, cli, m.version), tmp, { recursive: true, verbatimSymlinks: true });
      fs.renameSync(tmp, ziel);
      schreibeVerlauf(layout, cli, { aktion: 'installiert', version: m.version, quelle: akteur.quelle, akteur: akteur.akteur, meldung: 'aus Image-Bundle' });
      kopiert.push(m.version);
    }
    let aktiviert: string | null = null;
    if (launcherStand(layout, cli).art === 'fehlt') {
      const neueste = installierteVersionen(layout, cli).at(-1);
      if (neueste) { aktiviereOhneSperre(layout, cli, neueste.version, akteur); aktiviert = neueste.version; }
    }
    return { kopiert, aktiviert };
  });
}
