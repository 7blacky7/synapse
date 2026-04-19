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

  // ---- 404-Fallback -------------------------------------------------------
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'Not Found' });
  });

  return app;
}
