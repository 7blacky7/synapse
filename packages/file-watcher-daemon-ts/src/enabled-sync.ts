/**
 * MODUL: enabled-sync
 * ZWECK: PG (projects.enabled) ist Source of Truth. Beim Start + alle
 *        ENABLED_SYNC_INTERVAL_MS wird der Status fuer diesen Host aus PG
 *        gelesen und lokale Watcher (+config.json) angeglichen. Faellt PG
 *        aus, bleibt der letzte lokale Stand (config.json) wirksam.
 *
 *        Damit wirken project(action: "enable"|"disable") aus MCP/REST
 *        innerhalb eines Sync-Intervalls auch auf dem Desktop — und der
 *        Tray-Toggle (manager.enable/disable → setProjectEnabled) bleibt
 *        der zweite Schreibweg in dieselbe Quelle.
 */

import os from 'node:os';
import { getPool } from '@synapse/core';
import type { WatcherManager } from './manager.js';

const SYNC_INTERVAL_MS = Number(process.env.ENABLED_SYNC_INTERVAL_MS ?? 10_000);
const HOSTNAME = os.hostname();

export interface EnabledSyncHandle {
  stop: () => void;
}

export function startEnabledSync(manager: WatcherManager): EnabledSyncHandle {
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const res = await getPool().query<{ name: string; enabled: boolean }>(
        'SELECT name, enabled FROM projects WHERE hostname = $1',
        [HOSTNAME]
      );
      const pgState = new Map(res.rows.map((r) => [r.name, r.enabled]));
      for (const p of manager.list()) {
        const want = pgState.get(p.name);
        if (want === undefined || want === p.enabled) continue;
        try {
          if (want) await manager.enable(p.name);
          else await manager.disable(p.name);
          console.error(`[enabled-sync] ${p.name} -> ${want ? 'enabled' : 'disabled'} (PG = Source of Truth)`);
        } catch (err) {
          console.error(`[enabled-sync] ${p.name} Umschalten fehlgeschlagen: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`[enabled-sync] PG nicht erreichbar — lokaler Stand bleibt: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  // Start-Sync sofort, dann periodisch
  void tick();
  const interval = setInterval(() => void tick(), SYNC_INTERVAL_MS);
  console.error(`[enabled-sync] aktiv (interval=${SYNC_INTERVAL_MS}ms, host=${HOSTNAME}, PG=SoT)`);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
