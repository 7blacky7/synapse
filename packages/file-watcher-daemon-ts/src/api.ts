/**
 * MODUL: api.ts
 * ZWECK: Fastify-HTTP-API fuer den FileWatcher-Daemon, kompatibel zur
 *        moo-daemon API (Port 7878), damit moo-Tray + py-Tray unveraendert
 *        weiter funktionieren.
 *
 * ENDPUNKTE:
 *   GET    /health
 *   GET    /projects                      { projekte:[{name,pfad,enabled,running,...}], port, synapse_api_url }
 *   GET    /projects/:name/status         { name, pfad, enabled, watcher_running, running }
 *   GET    /host/status                   { online, hostname, time_ms }
 *   POST   /projects                      { "name": str, "pfad": str }
 *   POST   /projects/:name/enable
 *   POST   /projects/:name/disable
 *   DELETE /projects/:name
 */

import os from 'node:os';
import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { getPool } from '@synapse/core';
import { readStatus, removeSpecialist } from '@synapse/agents';
import type { WatcherManager } from './manager.js';

const STARTED_AT = Date.now();

export interface BuildApiOptions {
  manager: WatcherManager;
}

/** Fuehrt einen throw-basierten Manager-Call aus und mappt Fehler auf HTTP-Codes. */
async function safeCall(
  reply: FastifyReply,
  fn: () => Promise<void> | void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message || 'internal error';
    if (/nicht gefunden/i.test(msg)) reply.code(404);
    else reply.code(400);
    return { ok: false, error: msg };
  }
}

export function buildApi(opts: BuildApiOptions): FastifyInstance {
  const { manager } = opts;

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  // ---- GET /health --------------------------------------------------------
  app.get('/health', async () => ({
    status: 'ok',
    uptime_ms: Date.now() - STARTED_AT,
  }));

  // ---- GET /host/status ---------------------------------------------------
  app.get('/host/status', async () => ({
    online: true,
    hostname: process.env.HOSTNAME || os.hostname() || 'unknown',
    time_ms: Date.now(),
  }));

  // ---- GET /projects ------------------------------------------------------
  // Tray-Kontrakt: { projekte: [{ name, enabled, ... }], port }
  app.get('/projects', async () => {
    const agg = manager.statusAll();
    return {
      projekte: agg.projekte,
      port: agg.port,
      synapse_api_url: agg.synapse_api_url,
    };
  });

  // ---- POST /projects -----------------------------------------------------
  app.post('/projects', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400);
      return { error: 'expected JSON object body' };
    }
    const { name, pfad } = body as { name?: unknown; pfad?: unknown };
    if (typeof name !== 'string' || name.length === 0) {
      reply.code(400);
      return { error: 'missing field: name' };
    }
    if (typeof pfad !== 'string' || pfad.length === 0) {
      reply.code(400);
      return { error: 'missing field: pfad' };
    }
    // Doppelt-Add → 409 (kompatibel zu moo)
    if (manager.status(name)) {
      reply.code(409);
      return { error: 'project exists' };
    }
    try {
      const stat = fs.statSync(pfad);
      if (!stat.isDirectory()) {
        reply.code(400);
        return { error: 'path is not a directory' };
      }
    } catch {
      reply.code(400);
      return { error: 'path is not a directory' };
    }

    try {
      const projekt = await manager.register(name, pfad);
      return { ok: true, projekt };
    } catch (err) {
      reply.code(500);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ---- GET /projects/:name/status ----------------------------------------
  app.get<{ Params: { name: string } }>('/projects/:name/status', async (req, reply) => {
    const { name } = req.params;
    const s = manager.status(name);
    if (!s) {
      reply.code(404);
      return { error: 'unknown project' };
    }
    // watcher_running (moo-Kontrakt) + running (neu) beide liefern — Tray-Kompat
    return {
      name: s.name,
      pfad: s.pfad,
      enabled: s.enabled,
      watcher_running: s.running,
      running: s.running,
    };
  });

  // ---- POST /projects/:name/enable ---------------------------------------
  app.post<{ Params: { name: string } }>('/projects/:name/enable', async (req, reply) => {
    return safeCall(reply, () => manager.enable(req.params.name));
  });

  // ---- POST /projects/:name/disable --------------------------------------
  app.post<{ Params: { name: string } }>('/projects/:name/disable', async (req, reply) => {
    return safeCall(reply, () => manager.disable(req.params.name));
  });

  // ---- DELETE /projects/:name --------------------------------------------
  app.delete<{ Params: { name: string } }>('/projects/:name', async (req, reply) => {
    return safeCall(reply, () => manager.unregister(req.params.name));
  });

  // ---- GET /projects/:name/history ---------------------------------------
  // Letzte N watcher_events (Default 50). Quelle: PostgreSQL watcher_events —
  // wird vom core-Watcher bei jedem chokidar-Event befuellt (siehe core/watcher/index.ts).
  // Wird vom Tray-Context-Menue "Details" genutzt.
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/projects/:name/history',
    async (req, reply) => {
      const { name } = req.params;
      if (!manager.status(name)) {
        reply.code(404);
        return { error: 'unknown project' };
      }
      let limit = parseInt(req.query.limit ?? '50', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      if (limit > 500) limit = 500;
      try {
        const pool = getPool();
        const { rows } = await pool.query(
          `SELECT event_type, file_path, created_at, details
             FROM watcher_events
            WHERE project = $1
            ORDER BY created_at DESC
            LIMIT $2`,
          [name, limit],
        );
        return { events: rows };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- GET /projects/:name/specialists -----------------------------------
  // Liest die lokale .synapse/agents/status.json des Projekts — gibt alle
  // registrierten Spezialisten mit Status/Modell/Tokens/wrapperPid zurueck.
  // Wird vom Tray-Context-Menue "Agenten" genutzt.
  app.get<{ Params: { name: string } }>(
    '/projects/:name/specialists',
    async (req, reply) => {
      const info = manager.status(req.params.name);
      if (!info) {
        reply.code(404);
        return { error: 'unknown project' };
      }
      try {
        const statusFile = await readStatus(info.pfad);
        return {
          project: req.params.name,
          specialists: statusFile.specialists,
          maxSpecialists: statusFile.maxSpecialists,
          lastUpdate: statusFile.lastUpdate,
        };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- POST /projects/:name/specialists/:specName/stop -------------------
  // Sendet SIGTERM an die wrapperPid und entfernt den Eintrag aus status.json.
  // Bei bereits toten Prozessen: no-op mit ok.
  app.post<{ Params: { name: string; specName: string } }>(
    '/projects/:name/specialists/:specName/stop',
    async (req, reply) => {
      const { name, specName } = req.params;
      const info = manager.status(name);
      if (!info) {
        reply.code(404);
        return { error: 'unknown project' };
      }
      try {
        const statusFile = await readStatus(info.pfad);
        const spec = statusFile.specialists[specName];
        if (!spec) {
          reply.code(404);
          return { error: `unknown specialist: ${specName}` };
        }
        // SIGTERM auf wrapperPid — es ist ok wenn der Prozess schon tot ist
        try {
          process.kill(spec.wrapperPid, 'SIGTERM');
        } catch (err: any) {
          if (err.code !== 'ESRCH') throw err; // ESRCH = no such process, harmlos
        }
        await removeSpecialist(info.pfad, specName);
        return { ok: true, stopped: specName, wrapperPid: spec.wrapperPid };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- GET /events (Server-Sent Events) ----------------------------------
  // Push-Stream fuer State-Changes. Tray verbindet einmal, hoert zu,
  // reagiert sofort auf register/enable/disable/unregister.
  app.get('/events', async (_req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Initial-Snapshot, damit der Client sofort den aktuellen State hat
    reply.raw.write(`event: state\ndata: ${JSON.stringify(manager.statusAll())}\n\n`);

    const onChange = (payload: unknown): void => {
      reply.raw.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    manager.events.on('state_change', onChange);

    // Heartbeat alle 25s damit Proxies/Clients den Stream nicht killen
    const heartbeat = setInterval(() => {
      reply.raw.write(`: keep-alive ${Date.now()}\n\n`);
    }, 25_000);

    _req.raw.on('close', () => {
      clearInterval(heartbeat);
      manager.events.off('state_change', onChange);
    });
    return reply;
  });

  // ---- 404-Fallback -------------------------------------------------------
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'Not Found' });
  });

  return app;
}
