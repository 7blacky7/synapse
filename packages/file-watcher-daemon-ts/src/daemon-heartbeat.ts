/**
 * MODUL: daemon-heartbeat (Daemon-Side)
 * ZWECK: Periodisch (alle HEARTBEAT_INTERVAL_MS, Default 10s) pro aktiv laufendem
 *        Projekt UPSERT in daemon_heartbeats(last_seen=NOW()). Die synapse-api
 *        liest diese Tabelle, um das shell-Tool zwischen lokalem Daemon und
 *        Workspace-Container zu routen.
 */

import os from 'node:os';
import { upsertDaemonHeartbeat, clearDaemonHeartbeat, lokaleZustandsQuellen, erhebeZustand, baueWarteschlangenTelemetrie, type WarteschlangenBeobachtung, type WarteschlangenTelemetrie } from '@synapse/core';
import type { WatcherManager } from './manager.js';
// P9-T27 Welle 2: Heartbeat ueber die API statt eigener PG-Verbindung (daemon_jobs_weg=api)
import { daemonJobsWeg, heartbeatApi } from './daemon-jobs-api.js';
import { loadConfig } from './config.js';

/**
 * P22-T237: Projekte mit eingeschaltetem Tray-Schalter Asset-Sync (projekte[].asset_sync.aktiv, P13-T44/T45; global
 * asset_sync.aktiv=false schaltet alle aus). Die API zeigt damit 'Asset-Sync AUS' statt still liegender Share-Assets.
 */
export function assetSyncAktiveProjekte(projekte: Array<{ name: string; asset_sync?: { aktiv?: boolean } }>, global?: boolean): string[] {
  let an = global;
  if (an === undefined) { try { an = loadConfig().asset_sync?.aktiv !== false; } catch { an = true; } }
  // P22-T238 (thought d59f32e8): Standard EIN, nur ausdruecklich aktiv:false ist aus.
  return an ? projekte.filter((p) => p.asset_sync?.aktiv !== false).map((p) => p.name) : [];
}

const HEARTBEAT_INTERVAL_MS = Number(process.env.DAEMON_HEARTBEAT_INTERVAL_MS ?? 10_000);
const HOSTNAME = os.hostname();
const PID = process.pid;

/**
 * P27-T6 (Transportentscheidung T1): Warteschlangen-Telemetrie v1 reist mit dem REGULAEREN Heartbeat (nicht ueber die
 * intern-Bruecke, die bei intern AUS stumm ist). Nur lesend, nacheinander, je Quelle hoechstens 2 s, nie ueberlappend.
 * Aus: DAEMON_STAU_TELEMETRIE_DISABLED=1. Nur im API-Weg (PG-Weg = Altbetrieb ohne Telemetrie).
 */
let telemetrieLaeuft = false;
export async function sammleWarteschlangenTelemetrie(): Promise<WarteschlangenTelemetrie | undefined> {
  if (process.env.DAEMON_STAU_TELEMETRIE_DISABLED === '1' || telemetrieLaeuft) return undefined;
  telemetrieLaeuft = true;
  try {
    const beobachtungen: WarteschlangenBeobachtung[] = [];
    for (const q of lokaleZustandsQuellen().slice(0, 50)) beobachtungen.push(await erhebeZustand(q, 2000));
    return baueWarteschlangenTelemetrie(beobachtungen);
  } finally {
    telemetrieLaeuft = false;
  }
}

export interface DaemonHeartbeatHandle {
  stop: () => Promise<void>;
}

export function startDaemonHeartbeat(manager: WatcherManager): DaemonHeartbeatHandle {
  let stopped = false;
  const weg = daemonJobsWeg();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const active = manager.list().filter((p) => p.enabled && manager.isRunning(p.name));
    if (weg === 'api') {
      try {
        const telemetrie = await sammleWarteschlangenTelemetrie().catch(() => undefined);
        await heartbeatApi('melden', active.map((p) => p.name), assetSyncAktiveProjekte(active), telemetrie);
      } catch (err) {
        console.error(`[daemon-heartbeat] Meldung (API) fehlgeschlagen: ${(err as Error).message}`);
      }
      return;
    }
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
  console.error(`[daemon-heartbeat] aktiv (interval=${HEARTBEAT_INTERVAL_MS}ms, host=${HOSTNAME}, Weg: ${weg === 'api' ? 'API' : 'PG'})`);

  const stop = async (): Promise<void> => {
    stopped = true;
    clearInterval(interval);
    // Beim graceful Shutdown alle Heartbeats fuer diesen Daemon entfernen,
    // damit shell-Routing sofort auf Workspace switcht.
    const active = manager.list().filter((p) => p.enabled);
    if (weg === 'api') {
      try { await heartbeatApi('loeschen', active.map((p) => p.name)); } catch { /* ignore */ }
    } else {
      for (const p of active) {
        try {
          await clearDaemonHeartbeat(p.name);
        } catch { /* ignore */ }
      }
    }
    console.error('[daemon-heartbeat] gestoppt.');
  };

  return { stop };
}
