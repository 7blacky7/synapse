#!/usr/bin/env node
/**
 * Synapse MCP Server
 * Entry Point
 */

import 'dotenv/config';
import { startServer } from './server.js';
import { listActiveProjects, stopProjekt } from './tools/index.js';

/**
 * Graceful Shutdown - stoppt alle aktiven FileWatcher
 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.error(`[Synapse MCP] ${signal} empfangen, stoppe alle Watcher...`);

  const activeProjects = listActiveProjects();

  for (const project of activeProjects) {
    try {
      await stopProjekt(project);
      console.error(`[Synapse MCP] Watcher für "${project}" gestoppt`);
    } catch (error) {
      console.error(`[Synapse MCP] Fehler beim Stoppen von "${project}":`, error);
    }
  }

  console.error(`[Synapse MCP] ${activeProjects.length} Watcher gestoppt. Beende.`);
  process.exit(0);
}

// Shutdown-Handler registrieren
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Server starten
startServer().catch((error) => {
  console.error('[Synapse MCP] Fataler Fehler:', error);
  process.exit(1);
});
