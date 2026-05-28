/**
 * MODUL: daemon-heartbeat (Daemon-Side)
 * ZWECK: Periodisch (alle HEARTBEAT_INTERVAL_MS, Default 10s) pro aktiv laufendem
 *        Projekt UPSERT in daemon_heartbeats(last_seen=NOW()). Die synapse-api
 *        liest diese Tabelle, um das shell-Tool zwischen lokalem Daemon und
 *        Workspace-Container zu routen.
 */

import os from 'node:os';
import { upsertDaemonHeartbeat, clearDaemonHeartbeat } from '@synapse/core';
import type { WatcherManager } from './manager.js';

const HEARTBEAT_INTERVAL_MS = Number(process.env.DAEMON_HEARTBEAT_INTERVAL_MS ?? 10_000);
const HOSTNAME = os.hostname();
const PID = process.pid;

export interface DaemonHeartbeatHandle {
  stop: () => Promise<void>;
}

export function startDaemonHeartbeat(manager: WatcherManager): DaemonHeartbeatHandle {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const active = manager.list().filter((p) => p.enabled && manager.isRunning(p.name));
    for (const p of active) {
      try {
        await upsertDaemonHeartbeat(p.name, HOSTNAME, PID);
      } catch (err) {
        console.error(`[daemon-heartbeat] UPSERT ${p.name} fehlgeschlagen: ${(err as Error).message}`);
      }
    }
  };

  // Sofort + Intervall
  void tick();
  const interval = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  console.error(`[daemon-heartbeat] aktiv (interval=${HEARTBEAT_INTERVAL_MS}ms, host=${HOSTNAME})`);

  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(interval);
    // Beim graceful Shutdown alle Heartbeats fuer diesen Daemon entfernen,
    // damit shell-Routing sofort auf Workspace switcht.
    const active = manager.list().filter((p) => p.enabled);
    for (const p of active) {
      try {
        await clearDaemonHeartbeat(p.name);
      } catch { /* ignore */ }
    }
    console.error('[daemon-heartbeat] gestoppt.');
  };

  return { stop };
}
