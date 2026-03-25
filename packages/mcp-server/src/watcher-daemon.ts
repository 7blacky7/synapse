/**
 * FileWatcher-Daemon
 *
 * Eigenstaendiger Prozess der Dateiaenderungen ueberwacht und in Synapse indexiert.
 * Ueberlebt MCP-Server-Neustarts (wird mit detached: true gestartet).
 *
 * Steuerung via Unix-Socket (.synapse/sockets/watcher.sock):
 *   { "action": "status" } → { "running": true, "pid": 1234, "project": "..." }
 *   { "action": "stop" }   → { "stopped": true }
 *
 * Env-Variablen:
 *   SYNAPSE_WATCHER_PROJECT_PATH — Absoluter Pfad zum Projekt
 *   SYNAPSE_WATCHER_PROJECT_NAME — Projekt-Name
 *
 * Start:
 *   node watcher-daemon.js (mit gesetzten Env-Variablen)
 */

import { createServer, type Socket } from 'node:net';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  startFileWatcher,
  handleFileEvent,
  cleanupProjekt,
} from '@synapse/core';
import type { FileWatcherInstance } from '@synapse/core';

const projectPath = process.env.SYNAPSE_WATCHER_PROJECT_PATH;
const projectName = process.env.SYNAPSE_WATCHER_PROJECT_NAME;

if (!projectPath || !projectName) {
  console.error('[Watcher-Daemon] SYNAPSE_WATCHER_PROJECT_PATH und SYNAPSE_WATCHER_PROJECT_NAME muessen gesetzt sein');
  process.exit(1);
}

const synapseDir = join(projectPath, '.synapse');
const socketDir = join(synapseDir, 'sockets');
const socketPath = join(socketDir, 'watcher.sock');
const pidFile = join(synapseDir, 'watcher.pid');

// Verzeichnisse sicherstellen
if (!existsSync(socketDir)) {
  mkdirSync(socketDir, { recursive: true });
}

// Alte Socket-Datei entfernen falls vorhanden
try { unlinkSync(socketPath); } catch { /* ignore */ }

// PID-File schreiben
writeFileSync(pidFile, String(process.pid));
console.error(`[Watcher-Daemon] PID ${process.pid} fuer "${projectName}" in ${projectPath}`);

// FileWatcher starten
let watcher: FileWatcherInstance;
try {
  watcher = startFileWatcher({
    projectPath,
    projectName,
    onFileChange: handleFileEvent,
    onError: (error) => console.error(`[Watcher-Daemon] FileWatcher Fehler:`, error),
    onIgnoreChange: async () => {
      try {
        const result = await cleanupProjekt(projectPath, projectName);
        console.error(`[Watcher-Daemon] .synapseignore Cleanup: ${result.deleted} geloescht`);
      } catch (err) {
        console.error(`[Watcher-Daemon] Cleanup Fehler:`, err);
      }
    },
  });
  console.error(`[Watcher-Daemon] FileWatcher gestartet fuer "${projectName}"`);
} catch (err) {
  console.error(`[Watcher-Daemon] FileWatcher Start fehlgeschlagen:`, err);
  cleanup();
  process.exit(1);
}

// Socket-Server fuer Steuerung
const socketServer = createServer((client: Socket) => {
  let data = '';
  client.on('data', (chunk) => {
    data += chunk.toString();
    try {
      const cmd = JSON.parse(data);
      data = '';

      switch (cmd.action) {
        case 'status':
          client.write(JSON.stringify({
            running: true,
            pid: process.pid,
            project: projectName,
            projectPath,
          }));
          break;

        case 'stop':
          client.write(JSON.stringify({ stopped: true }));
          client.end();
          console.error(`[Watcher-Daemon] Stop-Signal empfangen`);
          cleanup();
          break;

        default:
          client.write(JSON.stringify({ error: `Unbekannte action: ${cmd.action}` }));
      }
    } catch {
      // Unvollstaendige JSON-Daten — warte auf mehr
    }
  });

  client.on('error', () => { /* ignore client errors */ });
});

socketServer.listen(socketPath, () => {
  console.error(`[Watcher-Daemon] Socket bereit: ${socketPath}`);
});

socketServer.on('error', (err) => {
  console.error(`[Watcher-Daemon] Socket-Server Fehler:`, err);
});

// Cleanup-Funktion
function cleanup() {
  console.error(`[Watcher-Daemon] Cleanup...`);

  // FileWatcher stoppen
  if (watcher) {
    watcher.stop().catch(() => {});
  }

  // Socket-Server schliessen
  socketServer.close();

  // Dateien aufraeumen
  try { unlinkSync(pidFile); } catch { /* ignore */ }
  try { unlinkSync(socketPath); } catch { /* ignore */ }

  process.exit(0);
}

// Signal-Handler
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('uncaughtException', (err) => {
  console.error(`[Watcher-Daemon] Uncaught Exception:`, err);
  cleanup();
});
