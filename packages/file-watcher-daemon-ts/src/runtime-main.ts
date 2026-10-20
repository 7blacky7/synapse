#!/usr/bin/env node
/**
 * MODUL: runtime-main.ts (P22-T4, W2a)
 * ZWECK: Einstieg des Daemons im Agenten-Runtime-Container (Image docker/synapse-agent-runtime). Startet immer das
 *        Startprofil runtime (startprofile/runtime.ts) — ohne Watcher, Sync, Shell-Worker, Project-Init, Tray-Dateien,
 *        Loopback-PC-API und API-Weiterleitung.
 */
import { starteRuntimeProfil } from './startprofile/runtime.js';

starteRuntimeProfil().catch((err) => {
  console.error('[daemon] Fataler Fehler beim Start (Runtime-Profil):', err);
  process.exit(1);
});
