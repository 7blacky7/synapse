/**
 * MODUL: enabled-sync
 * ZWECK: PG (projects-Tabelle) ist Source of Truth. Beim Start + alle
 *        ENABLED_SYNC_INTERVAL_MS wird der Status fuer diesen Host aus PG
 *        gelesen und lokale Watcher (+config.json) angeglichen. Faellt PG
 *        aus, bleibt der letzte lokale Stand (config.json) wirksam.
 *
 *        Damit wirken project(action: "enable"|"disable") aus MCP/REST
 *        innerhalb eines Sync-Intervalls auch auf dem Desktop — und der
 *        Tray-Toggle (manager.enable/disable → setProjectEnabled) bleibt
 *        der zweite Schreibweg in dieselbe Quelle.
 *
 *        Zusaetzlich (seit 2026-07-29): jede PG-Zeile, die lokal noch nicht in
 *        config.json steht, wird hier per manager.discoverFromRegistry()
 *        uebernommen — z.B. ein Projekt, das project(action:"init") ueber
 *        REST/MCP nur in PG registriert hat, ohne dass dieser Daemon je eine
 *        config.json-Zeile dafuer geschrieben hat. Vorher lief ein solches
 *        Projekt nirgends, ohne dass ein Fehler sichtbar wurde.
 */

import os from 'node:os';
import { getPool, getProjectStatus, setProjectStatus } from '@synapse/core';
import type { WatcherManager } from './manager.js';
import type { SetupPhase } from '@synapse/core';

const SYNC_INTERVAL_MS = Number(process.env.ENABLED_SYNC_INTERVAL_MS ?? 10_000);
const HOSTNAME = os.hostname();

export interface EnabledSyncHandle {
  stop: () => void;
}

type ProjectSnapshotRow = {
  name: string;
  path: string;
  enabled: boolean;
  setup_phase: SetupPhase | null;
};

/** Wendet denselben PG-Snapshot auf Registry-Cache und Setup-Status-Cache an. */
export function synchronisiereProjektCache(
  manager: WatcherManager,
  rows: ProjectSnapshotRow[],
): void {
  manager.discoverFromRegistry(rows.map((row) => ({
    name: row.name,
    pfad: row.path,
    enabled: row.enabled,
  })));

  for (const row of rows) {
    try {
      const setupPhase = row.setup_phase ?? 'none';
      const status = row.enabled ? 'active' : 'stopped';
      const current = getProjectStatus(row.path);
      if (current?.project === row.name
        && current.path === row.path
        && current.status === status
        && current.setupPhase === setupPhase) continue;
      setProjectStatus(row.path, {
        project: row.name,
        path: row.path,
        status,
        lastAccess: current?.lastAccess,
        setupPhase,
      });
    } catch (err) {
      console.error(`[enabled-sync] Status-Cache fuer ${row.name} nicht aktualisierbar: ${(err as Error).message}`);
    }
  }
}

export function startEnabledSync(manager: WatcherManager): EnabledSyncHandle {
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const res = await getPool().query<ProjectSnapshotRow>(
        `SELECT p.name, p.path, p.enabled, s.setup_phase
           FROM projects p
           LEFT JOIN project_setup_status s ON s.project = p.name
          WHERE p.hostname = $1`,
        [HOSTNAME]
      );
      // Discovery ZUERST: PG-Projekte, die lokal fehlen, in config.json uebernehmen
      // + Watcher starten. Erst danach das enabled-Flag fuer alle (inkl. der
      // gerade uebernommenen) angleichen — siehe Schleife unten.
      synchronisiereProjektCache(manager, res.rows);
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
