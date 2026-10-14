/**
 * P9-T30: host_loesen-Auftraege ueber die API abholen (kein PG vom PC).
 *
 * Die API (project(action:'host_loesen') bzw. Tray "Von diesem PC entfernen") entfernt die
 * Registry-Zeile dieses Hosts und reiht einen Auftrag ein. Hier wird nur der config.json-Eintrag
 * entfernt (Watcher stoppt). Dateien und Ordner auf der Platte bleiben unangetastet.
 *
 * Vertrag: POST /api/project-init/host-loesen/claim -> {jobs:[{id,name}]}
 *          POST /api/project-init/host-loesen/:id/complete {status, message?, error?}
 * Alte API ohne Route (404) oder fehlende PC-Zuordnung (403) -> still, naechster Versuch spaeter.
 */
import { AssetApiTransport, AssetApiFehler } from './asset-api-transport.js';
import type { WatcherManager } from './manager.js';

interface HostLoesenJob { id: string; name: string }

export async function verarbeiteHostLoesungen(manager: WatcherManager, api = new AssetApiTransport()): Promise<number> {
  const antwort = await api.json<{ jobs?: HostLoesenJob[] }>('/api/project-init/host-loesen/claim', {});
  let n = 0;
  for (const job of antwort.jobs ?? []) {
    let status: 'done' | 'failed' = 'done';
    let message: string;
    try {
      const p = manager.get(job.name);
      if (p) {
        await manager.unregister(job.name);
        message = `config.json-Eintrag entfernt, Watcher gestoppt (Ordner ${p.pfad} bleibt auf der Platte).`;
      } else {
        message = 'Kein config.json-Eintrag vorhanden.';
      }
    } catch (err) {
      status = 'failed';
      message = (err as Error).message;
    }
    console.error(`[host-loesen] ${job.name}: ${status} — ${message}`);
    await api.json('/api/project-init/host-loesen/' + encodeURIComponent(job.id) + '/complete',
      { status, message, ...(status === 'failed' ? { error: 'daemon_fehler' } : {}) });
    n++;
  }
  return n;
}

export function startHostLoesenWorker(
  manager: WatcherManager,
  api = new AssetApiTransport(),
  intervallMs = Number(process.env.HOST_LOESEN_INTERVAL_MS ?? 30_000),
): { stop: () => Promise<void> } {
  let busy = false, stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    try {
      await verarbeiteHostLoesungen(manager, api);
    } catch (e) {
      const still = e instanceof AssetApiFehler && [0, 401, 403, 404, 426, 503].includes(e.status);
      if (!still) console.error('[host-loesen] ' + (e as Error).message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { if (!busy) running = tick(); }, intervallMs);
  timer.unref();
  running = tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await running; } };
}
