#!/usr/bin/env node
/**
 * MODUL: main.ts
 * ZWECK: Bootstrap fuer den TypeScript-Daemon. Waehlt das Startprofil (P22-T4) und startet es:
 *          - pc (Standard, unveraendert): startprofile/pc.ts — WatcherManager, Fastify-API, Worker,
 *            PID/Port-Files fuer den Tray, graceful Shutdown bei SIGTERM/SIGINT.
 *          - runtime: startprofile/runtime.ts — nur Runtime-Faehigkeiten im Agenten-Container, kein PC-Dienst
 *            (eigener Einstieg runtime-main.ts).
 *        SYNAPSE_DAEMON_PROFIL=pc|runtime; leer = pc, unbekannter Wert = Startfehler.
 *        Die Profile werden dynamisch geladen, damit das Runtime-Profil keine PC-Module (Watcher, Fastify) laedt.
 *
 * DATEIEN (Profil pc):
 *   ~/.synapse/file-watcher/config.json  - Konfiguration (config.ts)
 *   ~/.synapse/file-watcher/daemon.pid   - PID fuer Discovery (moo-Tray)
 *   ~/.synapse/file-watcher/daemon.port  - Port fuer Discovery (moo-Tray)
 */

import { leseStartprofil } from './daemon-kern.js';

async function main(): Promise<void> {
  const profil = leseStartprofil();
  if (profil === 'runtime') {
    const { starteRuntimeProfil } = await import('./startprofile/runtime.js');
    await starteRuntimeProfil();
    return;
  }
  const { startePcProfil } = await import('./startprofile/pc.js');
  await startePcProfil();
}

main().catch((err) => {
  console.error('[daemon] Fataler Fehler beim Start:', err);
  process.exit(1);
});
