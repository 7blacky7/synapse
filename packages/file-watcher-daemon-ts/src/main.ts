#!/usr/bin/env node
/**
 * MODUL: main.ts
 * ZWECK: Bootstrap fuer den TypeScript-FileWatcher-Daemon. Startet
 *        WatcherManager (der selbst die Config laedt), bindet Fastify-API,
 *        schreibt PID/Port-Files und behandelt graceful Shutdown bei
 *        SIGTERM/SIGINT.
 *
 * DATEIEN:
 *   ~/.synapse/file-watcher/config.json  - Konfiguration (config.ts)
 *   ~/.synapse/file-watcher/daemon.pid   - PID fuer Discovery (moo-Tray)
 *   ~/.synapse/file-watcher/daemon.port  - Port fuer Discovery (moo-Tray)
 */

import fs from 'node:fs';
import os from 'node:os';
import { buildApi } from './api.js';
import { ensureConfigDir, pidFilePath, portFilePath } from './config.js';
import { WatcherManager } from './manager.js';
import { startShellJobWorker, type ShellJobWorkerHandle } from './shell-job-worker.js';
import { startSpecialistJobWorker, type SpecialistJobWorkerHandle } from './specialist-job-worker.js';
import { startProjectInitWorker, type ProjectInitWorkerHandle } from './project-init-worker.js';
import { startDaemonHeartbeat, type DaemonHeartbeatHandle } from './daemon-heartbeat.js';
import { startEnabledSync, type EnabledSyncHandle } from './enabled-sync.js';
import { startInternBruecke, type InternBrueckeHandle } from './intern-bruecke.js';
import { registriereWorker, setzeDbProzess } from '@synapse/core';
import { startLogpflege, type LogpflegeHandle } from './logpflege.js';
import { ApiWeiterleitung, weiterleitungsPortAusConfig } from './api-weiterleitung.js';

async function main(): Promise<void> {
  setzeDbProzess('daemon');
  ensureConfigDir();

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

  // P15 Logpflege: lokale Synapse-Logs rotieren (taeglich bzw. ab Groesse, copytruncate) und
  // Rotationen loeschen, deren juengster Eintrag >= 30 Tage alt ist. Erst NACH der Single-Instance-
  // Pruefung, damit ein zweiter, sofort endender Daemon nichts anfasst. Aus: SYNAPSE_LOGPFLEGE=0.
  let logpflege: LogpflegeHandle | null = null;
  try {
    logpflege = startLogpflege();
  } catch (err) {
    console.error('[daemon] Logpflege konnte nicht gestartet werden:', err);
  }

  const manager = new WatcherManager();
  const { port, projekte } = manager.statusAll();

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

  // Shell-Job-Worker starten (LISTEN 'shell_job_created')
  let shellWorker: ShellJobWorkerHandle | null = null;
  try {
    shellWorker = await startShellJobWorker(() =>
      manager.list()
        .filter((p) => p.enabled && manager.isRunning(p.name))
        .map((p) => p.name)
    );
  } catch (err) {
    console.error('[daemon] Shell-Job-Worker konnte nicht gestartet werden:', err);
    // Kein harter Fehler — Daemon laeuft weiter ohne Queue-Worker
  }

  // Specialist-Job-Worker starten (LISTEN 'specialist_job_created')
  let specialistWorker: SpecialistJobWorkerHandle | null = null;
  try {
    specialistWorker = await startSpecialistJobWorker(() =>
      manager.list()
        .filter((p) => p.enabled && manager.isRunning(p.name))
        .map((p) => p.name)
    );
  } catch (err) {
    console.error('[daemon] Specialist-Job-Worker konnte nicht gestartet werden:', err);
  }

  // Project-Init-Worker starten (LISTEN 'project_init_job_created')
  // Web-KI Self-Service: legt neue Projekte unter WORKSPACE_ROOT an.
  let projectInitWorker: ProjectInitWorkerHandle | null = null;
  try {
    projectInitWorker = await startProjectInitWorker(manager);
  } catch (err) {
    console.error('[daemon] Project-Init-Worker konnte nicht gestartet werden:', err);
  }

  // Daemon-Heartbeat: meldet aktive Projekte in PG, damit das shell-Tool
  // (synapse-api) bei Auto-Routing weiss ob ein lokaler Daemon laeuft.
  let heartbeat: DaemonHeartbeatHandle | null = null;
  if (process.env.DAEMON_HEARTBEAT_DISABLED !== '1') {
    try {
      heartbeat = startDaemonHeartbeat(manager);
    } catch (err) {
      console.error('[daemon] Heartbeat konnte nicht gestartet werden:', err);
    }
  }

  // PG = Source of Truth fuer enabled: Start-Sync + periodischer Abgleich.
  let enabledSync: EnabledSyncHandle | null = null;
  try {
    enabledSync = startEnabledSync(manager);
  } catch (err) {
    console.error('[daemon] Enabled-Sync konnte nicht gestartet werden:', err);
  }

  // P15-T12 E2: Debug-Steuerung ueber die API (nur wenn dort SYNAPSE_INTERN_TOOL=1 gilt).
  let internBruecke: InternBrueckeHandle | null = null;
  if (process.env.DAEMON_INTERN_BRUECKE_DISABLED !== '1') {
    try {
      internBruecke = startInternBruecke();
    } catch (err) {
      console.error('[daemon] intern-Bruecke konnte nicht gestartet werden:', err);
    }
  }

  // P9-T28: lokale API-Weiterleitung (LAN zuerst, Tunnel als Rueckfall) fuer Claude Code/Codex/MCP.
  // Eigener Port (Standard 7879, SYNAPSE_API_WEITERLEITUNG_PORT bzw. config api_weiterleitung_port, 0 = aus).
  let weiterleitung: ApiWeiterleitung | null = null;
  const weiterleitungsPort = weiterleitungsPortAusConfig();
  if (weiterleitungsPort > 0) {
    const w = new ApiWeiterleitung({ port: weiterleitungsPort });
    try {
      await w.start();
      weiterleitung = w;
    } catch (err) {
      console.error('[daemon] API-Weiterleitung konnte nicht gestartet werden:', err);
    }
  }

  const app = buildApi({ manager, weiterleitung });

  try {
    await app.listen({ host: '127.0.0.1', port });
  } catch (err) {
    console.error('[daemon] Fastify listen fehlgeschlagen:', err);
    process.exit(1);
  }

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

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[daemon] ${signal} empfangen — graceful Shutdown...`);

    // Hard-Exit-Fallback: haengt ein stop() (z.B. blockierter PG-Client),
    // lebte der Prozess sonst ewig weiter — SIGTERM wirkte scheinbar gar
    // nicht (User-Report 2026-06-06: Tray-"Deaktivieren" ohne Wirkung,
    // Daemon ueberlebte mehrere kill-Versuche). Nach 5s harter Exit.
    const hardExit = setTimeout(() => {
      console.error('[daemon] Shutdown haengt (>5s) — harter Exit.');
      process.exit(1);
    }, 5_000);
    hardExit.unref();

    try {
      await app.close();
    } catch (err) {
      console.error('[daemon] Fastify close Fehler:', err);
    }

    if (shellWorker !== null) {
      try {
        await shellWorker.stop();
      } catch (err) {
        console.error('[daemon] Shell-Worker stop Fehler:', err);
      }
    }

    if (specialistWorker !== null) {
      try {
        await specialistWorker.stop();
      } catch (err) {
        console.error('[daemon] Specialist-Worker stop Fehler:', err);
      }
    }

    if (projectInitWorker !== null) {
      try {
        await projectInitWorker.stop();
      } catch (err) {
        console.error('[daemon] Project-Init-Worker stop Fehler:', err);
      }
    }

    if (heartbeat !== null) {
      try {
        await heartbeat.stop();
      } catch (err) {
        console.error('[daemon] Heartbeat stop Fehler:', err);
      }
    }

    if (enabledSync !== null) {
      try { enabledSync.stop(); } catch { /* ignore */ }
    }

    if (internBruecke !== null) {
      try { internBruecke.stop(); } catch { /* ignore */ }
    }

    if (logpflege !== null) {
      try { logpflege.stop(); } catch { /* ignore */ }
    }

    if (weiterleitung !== null) {
      try { await weiterleitung.stop(); } catch { /* ignore */ }
    }

    try {
      await manager.stopAll();
    } catch (err) {
      console.error('[daemon] Manager stopAll Fehler:', err);
    }

    try { fs.unlinkSync(pidFilePath()); } catch { /* ignore */ }
    try { fs.unlinkSync(portFilePath()); } catch { /* ignore */ }

    console.error('[daemon] Shutdown abgeschlossen.');
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('uncaughtException', (err) => {
    console.error('[daemon] Uncaught Exception:', err);
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[daemon] Unhandled Rejection:', reason);
  });
}

main().catch((err) => {
  console.error('[daemon] Fataler Fehler beim Start:', err);
  process.exit(1);
});
