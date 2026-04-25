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

async function main(): Promise<void> {
  ensureConfigDir();

  const manager = new WatcherManager();
  const { port, projekte } = manager.statusAll();

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

  const app = buildApi({ manager });

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
