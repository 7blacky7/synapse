/**
 * Konsolidiertes watcher Tool — FileWatcher-Daemon steuern
 *
 * Actions: status, start, stop
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConsolidatedTool } from './types.js';
import { reqStr } from './types.js';

function getPidFile(projectPath: string): string {
  return join(projectPath, '.synapse', 'watcher.pid');
}

function getSocketPath(projectPath: string): string {
  return join(projectPath, '.synapse', 'sockets', 'watcher.sock');
}

/** Prueft ob der Daemon-Prozess lebt */
function isDaemonRunning(projectPath: string): { running: boolean; pid?: number } {
  const pidFile = getPidFile(projectPath);
  try {
    if (!existsSync(pidFile)) return { running: false };
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim());
    process.kill(pid, 0); // Prueft ob Prozess existiert (wirft bei totem Prozess)
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/** Sendet ein Kommando an den Daemon-Socket und gibt die Antwort zurueck */
function sendSocketCommand(projectPath: string, action: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath(projectPath);
    const client = createConnection(socketPath);
    let data = '';

    client.on('connect', () => {
      client.write(JSON.stringify({ action }));
    });

    client.on('data', (chunk) => {
      data += chunk.toString();
    });

    client.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({ raw: data });
      }
    });

    client.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      client.destroy();
      reject(new Error('Socket timeout'));
    }, 5000);
  });
}

/** Startet den Watcher-Daemon als detached Prozess */
function spawnDaemon(projectPath: string, projectName: string): { pid: number } {
  // watcher-daemon.js relativ zum MCP-Server dist/ Verzeichnis finden
  const daemonPath = resolve(import.meta.dirname ?? __dirname, '..', 'watcher-daemon.js');

  const child = spawn('node', [daemonPath], {
    env: {
      ...process.env,
      SYNAPSE_WATCHER_PROJECT_PATH: projectPath,
      SYNAPSE_WATCHER_PROJECT_NAME: projectName,
    },
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  return { pid: child.pid ?? 0 };
}

export const watcherTool: ConsolidatedTool = {
  definition: {
    name: 'watcher',
    description: 'FileWatcher-Daemon steuern: status (laeuft er?), start (starten falls nicht aktiv), stop (stoppen)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop'],
          description: 'status: Daemon-Status pruefen. start: Daemon starten (wenn nicht aktiv). stop: Daemon stoppen.',
        },
        path: {
          type: 'string',
          description: 'Absoluter Pfad zum Projekt-Ordner',
        },
        name: {
          type: 'string',
          description: 'Projekt-Name (nur bei start noetig)',
        },
      },
      required: ['action', 'path'],
    },
  },

  handler: async (args) => {
    const action = reqStr(args, 'action');
    const projectPath = reqStr(args, 'path');

    switch (action) {
      case 'status': {
        const check = isDaemonRunning(projectPath);
        if (!check.running) {
          return { success: true, running: false, message: 'FileWatcher-Daemon ist nicht aktiv' };
        }
        try {
          const socketStatus = await sendSocketCommand(projectPath, 'status');
          return { success: true, running: true, pid: check.pid, ...socketStatus };
        } catch {
          return { success: true, running: true, pid: check.pid, message: 'Daemon laeuft aber Socket nicht erreichbar' };
        }
      }

      case 'start': {
        const check = isDaemonRunning(projectPath);
        if (check.running) {
          return { success: true, already_running: true, pid: check.pid, message: `FileWatcher-Daemon laeuft bereits (PID ${check.pid})` };
        }

        const projectName = args.name as string | undefined;
        if (!projectName) {
          return { success: false, message: 'Parameter "name" ist erforderlich zum Starten des Daemons' };
        }

        const result = spawnDaemon(projectPath, projectName);

        // Kurz warten und pruefen ob er gestartet ist
        await new Promise(r => setTimeout(r, 1500));
        const verify = isDaemonRunning(projectPath);

        return {
          success: verify.running,
          pid: verify.pid ?? result.pid,
          message: verify.running
            ? `FileWatcher-Daemon gestartet (PID ${verify.pid})`
            : 'Daemon-Start fehlgeschlagen — Logs pruefen',
        };
      }

      case 'stop': {
        const check = isDaemonRunning(projectPath);
        if (!check.running) {
          return { success: true, was_running: false, message: 'FileWatcher-Daemon war nicht aktiv' };
        }

        try {
          await sendSocketCommand(projectPath, 'stop');
          // Kurz warten
          await new Promise(r => setTimeout(r, 500));
          const verify = isDaemonRunning(projectPath);
          return {
            success: !verify.running,
            message: !verify.running
              ? `FileWatcher-Daemon gestoppt (war PID ${check.pid})`
              : `Stop-Signal gesendet, Daemon laeuft aber noch (PID ${check.pid})`,
          };
        } catch {
          // Socket nicht erreichbar — kill direkt
          try {
            process.kill(check.pid!, 'SIGTERM');
            return { success: true, message: `FileWatcher-Daemon gekillt (PID ${check.pid})` };
          } catch {
            return { success: false, message: 'Daemon konnte nicht gestoppt werden' };
          }
        }
      }

      default:
        return { success: false, message: `Unbekannte action: ${action}` };
    }
  },
};
