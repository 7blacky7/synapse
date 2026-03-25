#!/usr/bin/env node
/**
 * Synapse MCP Server
 * Entry Point
 */

import 'dotenv/config';
import { startServer } from './server.js';
import { listActiveProjects, stopProjekt, getProjectPath } from './tools/index.js';
import { heartbeatController, readStatus } from '@synapse/agents';

/**
 * Graceful Shutdown - stoppt alle aktiven FileWatcher und Specialist-Wrappers
 */
async function gracefulShutdown(signal: string): Promise<void> {
  console.error(`[Synapse MCP] ${signal} empfangen, stoppe alle Watcher...`);

  const activeProjects = listActiveProjects();

  // Send save_and_pause to all connected specialists (they keep running)
  console.error('[Synapse] Graceful shutdown — saving specialist state...');
  for (const projectName of activeProjects) {
    const projectPath = getProjectPath(projectName);
    if (!projectPath) continue;
    try {
      const status = await readStatus(projectPath);
      for (const name of Object.keys(status.specialists)) {
        if (heartbeatController.isConnected(name)) {
          try {
            await heartbeatController.sendSaveAndPause(name);
          } catch { /* wrapper might already be gone */ }
        }
      }
    } catch { /* no status file — skip */ }
  }

  try {
    await heartbeatController.disconnectAll();
  } catch (err) {
    console.error('[Synapse] Shutdown error during disconnectAll:', err);
  }

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
