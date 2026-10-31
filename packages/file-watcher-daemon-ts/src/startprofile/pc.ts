/**
 * MODUL: startprofile/pc.ts (P22-T4, W2a; W0c-Bericht 502500cd Abschn. 3)
 * ZWECK: Startprofil PC = die bisherige main.ts-Komposition, UNVERAENDERT in Ablauf und Reihenfolge: Watcher-Manager,
 *        Sync-Worker, Reverse-Bibliothek, Shell-/Spezialisten-/Project-Init-Worker, PC-Heartbeat, Enabled-Sync,
 *        intern-Bruecke, API-Weiterleitung (7879), Fastify auf 127.0.0.1 und Tray-Discovery (daemon.pid/daemon.port).
 *        Lebenszyklus (Startfehler, Stoppreihenfolge, harter Exit nach 5 s, Signale) ueber den gemeinsamen DaemonKern.
 *
 * DATEIEN:
 *   ~/.synapse/file-watcher/config.json  - Konfiguration (config.ts)
 *   ~/.synapse/file-watcher/daemon.pid   - PID fuer Discovery (moo-Tray)
 *   ~/.synapse/file-watcher/daemon.port  - Port fuer Discovery (moo-Tray)
 */

import fs from 'node:fs';
import os from 'node:os';
import { buildApi } from '../api.js';
import { ensureConfigDir, pidFilePath, portFilePath } from '../config.js';
import { WatcherManager } from '../manager.js';
import { startShellJobWorker } from '../shell-job-worker.js';
import { startSpecialistJobWorker } from '../specialist-job-worker.js';
import { startProjectInitWorker } from '../project-init-worker.js';
import { startDaemonHeartbeat } from '../daemon-heartbeat.js';
import { startEnabledSync } from '../enabled-sync.js';
import { startInternBruecke } from '../intern-bruecke.js';
import { registriereWorker, setzeDbProzess, sperreDbZugriff, setzeWarteschlangenProzess, meldeKernWarteschlangenAn, meldeStauAdapterAn, registriereWarteschlange, seiteAusListe, type WarteschlangenZustand } from '@synapse/core';
// P9-T27 letzter Schritt: Daemon ohne DATABASE_URL
import { daemonJobsWeg, hatDatenbankUrl } from '../daemon-jobs-api.js';
import { installiereIgnoreApiQuelle, leereEreignisPuffer } from '../daemon-sync-api.js';
import { startLogpflege } from '../logpflege.js';
import { ApiWeiterleitung, weiterleitungsPortAusConfig } from '../api-weiterleitung.js';
import { DaemonKern } from '../daemon-kern.js';
import { startCliVerlauf } from '../cli-verlauf.js';
import { startModInbox } from '../mod-inbox.js';

export async function startePcProfil(): Promise<DaemonKern> {
  setzeDbProzess('daemon');
  // P27-T1: Instanzkennung + Kern-Warteschlangen (embedding_queue) schon beim Start, nicht erst beim ersten intern-Aufruf.
  setzeWarteschlangenProzess('daemon');
  meldeKernWarteschlangenAn();
  ensureConfigDir();

  // P9-T27: API-Weg = dieser Prozess oeffnet KEINE PG-Verbindung mehr (Regel regel-pc-nur-ueber-api-kein-
  // lokaler-db-zugang). Jede vergessene Aufrufstelle lehnt dann laut ab statt still zu verbinden.
  // Ignore-Regeln (Watcher + asset-sync) kommen ueber die API. PG-Weg (Rueckfall) bleibt unveraendert.
  const apiWeg = daemonJobsWeg() === 'api';
  if (apiWeg) {
    sperreDbZugriff('Daemon im API-Weg (daemon_jobs_weg=api bzw. ohne DATABASE_URL): alle Daten ueber die Synapse-API');
    installiereIgnoreApiQuelle();
    console.error(`[daemon] Weg: API — keine eigene DB-Verbindung${hatDatenbankUrl() ? ' (DATABASE_URL gesetzt, wird nicht benutzt)' : ''}.`);
  }

  // Single-Instance: lebt der Daemon aus daemon.pid noch, beenden wir uns
  // sofort — zwei parallele Daemons fuehren zu doppeltem Sync, doppeltem
  // Heartbeat und divergenter config.json (Stand 2026-06-06 liefen zwei).
  try {
    const oldPid = Number(fs.readFileSync(pidFilePath(), 'utf8').trim());
    if (oldPid && oldPid !== process.pid) {
      process.kill(oldPid, 0); // wirft wenn Prozess nicht mehr existiert
      console.error(`[daemon] Daemon laeuft bereits (PID ${oldPid}) — beende.`);
      process.exit(0);
    }
  } catch { /* kein PID-File oder Prozess tot -> normal starten */ }

  const kern = new DaemonKern('pc');

  // P15 Logpflege: lokale Synapse-Logs rotieren (taeglich bzw. ab Groesse, copytruncate) und
  // Rotationen loeschen, deren juengster Eintrag >= 30 Tage alt ist. Erst NACH der Single-Instance-
  // Pruefung, damit ein zweiter, sofort endender Daemon nichts anfasst. Aus: SYNAPSE_LOGPFLEGE=0.
  const logpflege = await kern.starte('Logpflege', () => startLogpflege());

  const manager = new WatcherManager();
  const { port, projekte } = manager.statusAll();

  // P27-T6: Stau-Quellen des Daemons (gehen als Telemetrie v1 mit dem regulaeren Heartbeat an die API, daemon-heartbeat.ts).
  // Persistente Asset-Transfers je Projekt (Vorfall 26./27.10.: Finalisierungsfehler ohne fertige Assets bei leerer Legacy-Queue).
  registriereWarteschlange({
    name: 'asset_transfer',
    beschreibung: 'Persistente Asset-Transfers je Projekt (Upload/Download/Loeschen); Fortschritt = fertiger Auftrag, nicht Bytes.',
    reihenfolge: 'Reihenfolge der Auftraege; Wiederholung mit Backoff.',
    verschiebbar: 'Nein.',
    uebersicht: () => ({ projekte: manager.assetSync.transferZustaende() }),
    liste: (f) => seiteAusListe(manager.assetSync.transferZustaende().map((t) => ({
      id: t.projekt, projekt: t.projekt, typ: 'transfer', status: t.zustand ? 'geladen' : 'unbekannt', prioritaet: null, alter_s: null,
      details: t.zustand ?? {},
    })), f),
    teilinstanzen: () => manager.assetSync.transferZustaende().map((t) => ({
      projekt: t.projekt,
      zustand: (): WarteschlangenZustand => {
        const z = manager.assetSync.transferZustaende().find((x) => x.projekt === t.projekt)?.zustand;
        if (!z) throw new Error('transferzustand_nicht_geladen');
        return z as unknown as WarteschlangenZustand;
      },
    })),
  });
  meldeStauAdapterAn('daemon');

  // P15-T12: Sync-Wege einzeln pausierbar (intern, prozess daemon). Nur ausdruecklich, nicht in 'alle'.
  registriereWorker({
    name: 'sync_pg_fs',
    beschreibung: 'PG -> Platte: Aenderungen aus code_files auf die Festplatte schreiben (Poll je Projekt)',
    inAlle: false,
  });
  registriereWorker({
    name: 'sync_fs_pg',
    beschreibung: 'Platte -> PG: Datei-Ereignisse indexieren (storeFileContent + Parsen/Embedding); Ereignisse warten bei Pause',
    inAlle: false,
  });

  // Enabled Projekte direkt starten
  await manager.startAllEnabled();

  // P18-T16/RV6: Reverse-Bibliothek (nur bei reverse_bibliothek.aktiv); der Start blockiert den Daemon nicht.
  void manager.startReverse().catch((err) => console.error('[daemon] Reverse-Bibliothek konnte nicht gestartet werden:', err));

  const aktiveProjekte = () =>
    manager.list()
      .filter((p) => p.enabled && manager.isRunning(p.name))
      .map((p) => p.name);

  // Shell-Job-Worker starten (LISTEN 'shell_job_created'). Kein harter Fehler — Daemon laeuft weiter ohne Queue-Worker.
  const shellWorker = await kern.starte('Shell-Job-Worker', () => startShellJobWorker(aktiveProjekte));

  // Specialist-Job-Worker starten (LISTEN 'specialist_job_created')
  const specialistWorker = await kern.starte('Specialist-Job-Worker', () => startSpecialistJobWorker(aktiveProjekte));

  // Project-Init-Worker starten (LISTEN 'project_init_job_created')
  // Web-KI Self-Service: legt neue Projekte unter WORKSPACE_ROOT an.
  const projectInitWorker = await kern.starte('Project-Init-Worker', () => startProjectInitWorker(manager));

  // Daemon-Heartbeat: meldet aktive Projekte in PG, damit das shell-Tool
  // (synapse-api) bei Auto-Routing weiss ob ein lokaler Daemon laeuft.
  const heartbeat = process.env.DAEMON_HEARTBEAT_DISABLED !== '1'
    ? await kern.starte('Heartbeat', () => startDaemonHeartbeat(manager))
    : (kern.markiereAus('Heartbeat', 'DAEMON_HEARTBEAT_DISABLED=1'), null);

  // PG = Source of Truth fuer enabled: Start-Sync + periodischer Abgleich.
  const enabledSync = await kern.starte('Enabled-Sync', () => startEnabledSync(manager));

  // P15-T12 E2: Debug-Steuerung ueber die API (nur wenn dort SYNAPSE_INTERN_TOOL=1 gilt).
  const internBruecke = process.env.DAEMON_INTERN_BRUECKE_DISABLED !== '1'
    ? await kern.starte('intern-Bruecke', () => startInternBruecke())
    : (kern.markiereAus('intern-Bruecke', 'DAEMON_INTERN_BRUECKE_DISABLED=1'), null);

  // P22-T133: lokale CLI-Sitzungen in den Agenten-Verlauf (nur bei Tray-Haken cli_verlauf.aktiv, API-Weg).
  const cliVerlauf = apiWeg && process.env.CLI_VERLAUF_DISABLED !== '1'
    ? await kern.starte('CLI-Verlauf', () => startCliVerlauf())
    : (kern.markiereAus('CLI-Verlauf', apiWeg ? 'CLI_VERLAUF_DISABLED=1' : 'nur im API-Weg'), null);

  // P22-T134: Mod-Inbox - Sitzungen mit wartender Claude-Code-Mod der API melden (Schalter mod_inbox auf der API, API-Weg).
  const modInbox = apiWeg && process.env.MOD_INBOX_DISABLED !== '1'
    ? await kern.starte('Mod-Inbox', () => startModInbox())
    : (kern.markiereAus('Mod-Inbox', apiWeg ? 'MOD_INBOX_DISABLED=1' : 'nur im API-Weg'), null);

  // P9-T28: lokale API-Weiterleitung (LAN zuerst, Tunnel als Rueckfall) fuer Claude Code/Codex/MCP.
  // Eigener Port (Standard 7879, SYNAPSE_API_WEITERLEITUNG_PORT bzw. config api_weiterleitung_port, 0 = aus).
  let weiterleitung: ApiWeiterleitung | null = null;
  const weiterleitungsPort = weiterleitungsPortAusConfig();
  if (weiterleitungsPort > 0) {
    const w = new ApiWeiterleitung({ port: weiterleitungsPort });
    weiterleitung = await kern.starte('API-Weiterleitung', async () => { await w.start(); return w; });
  } else {
    kern.markiereAus('API-Weiterleitung', 'Port 0');
  }

  const app = buildApi({ manager, weiterleitung });

  try {
    await app.listen({ host: '127.0.0.1', port });
  } catch (err) {
    console.error('[daemon] Fastify listen fehlgeschlagen:', err);
    process.exit(1);
  }
  kern.markiereGestartet('Fastify');

  // PID/Port-Files schreiben (Discovery fuer Tray)
  try {
    fs.writeFileSync(pidFilePath(), String(process.pid));
    fs.writeFileSync(portFilePath(), String(port));
  } catch (err) {
    console.error('[daemon] PID/Port-File konnte nicht geschrieben werden:', err);
  }

  console.error('================================================');
  console.error('  Synapse FileWatcher Daemon (TS)');
  console.error(`  Host:     ${os.hostname()}`);
  console.error(`  Port:     ${port}`);
  console.error(`  Projekte: ${projekte.length}`);
  console.error(`  PID:      ${process.pid}`);
  console.error('================================================');
  console.error(`listening http://127.0.0.1:${port}`);

  // Stoppreihenfolge wie bisher in main.ts.
  kern.beimStopp('Fastify', () => app.close());
  if (shellWorker) kern.beimStopp('Shell-Worker', () => shellWorker.stop());
  if (specialistWorker) kern.beimStopp('Specialist-Worker', () => specialistWorker.stop());
  if (projectInitWorker) kern.beimStopp('Project-Init-Worker', () => projectInitWorker.stop());
  if (heartbeat) kern.beimStopp('Heartbeat', () => heartbeat.stop());
  if (enabledSync) kern.beimStopp('Enabled-Sync', () => enabledSync.stop());
  if (internBruecke) kern.beimStopp('intern-Bruecke', () => internBruecke.stop());
  if (cliVerlauf) kern.beimStopp('CLI-Verlauf', () => cliVerlauf.stop());
  if (modInbox) kern.beimStopp('Mod-Inbox', () => modInbox.stop());
  if (logpflege) kern.beimStopp('Logpflege', () => logpflege.stop());
  if (weiterleitung) {
    const w = weiterleitung;
    kern.beimStopp('API-Weiterleitung', () => w.stop());
  }
  kern.beimStopp('Manager stopAll', () => manager.stopAll());
  // P9-T27: gepufferte watcher_events noch uebertragen (best effort, Hard-Exit nach 5 s bleibt).
  if (apiWeg) kern.beimStopp('Ereignis-Puffer', () => leereEreignisPuffer());
  kern.beimStopp('Discovery-Dateien', () => {
    try { fs.unlinkSync(pidFilePath()); } catch { /* ignore */ }
    try { fs.unlinkSync(portFilePath()); } catch { /* ignore */ }
  });

  kern.installiereSignale();
  return kern;
}
