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
import { getPool, listChannels, getChannelMessages, postChannelMessage, listActiveAgents, listWrapperStatus, getWrapperStatus, removeWrapperStatus } from '@synapse/core';
import type { WrapperStatusRow } from '@synapse/core';
import { readStatus, removeSpecialist } from '@synapse/agents';
import type { WatcherManager } from './manager.js';

const STARTED_AT = Date.now();

export interface BuildApiOptions {
  manager: WatcherManager;
}

const STALE_MS = 3 * 60_000;

/** Konvertiert eine PG-WrapperStatusRow in das SpecialistStatus-kompatible Format.
 *  Rows ohne Heartbeat-Update seit > 3min werden als 'stale' markiert (konsistent zu REST). */
function pgRowToSpecialist(row: WrapperStatusRow): Record<string, unknown> {
  const ageMs = Date.now() - row.lastActivity.getTime();
  const isStale = (row.status === 'running' || row.status === 'idle') && ageMs > STALE_MS;
  return {
    name: row.agentName,
    model: row.model ?? '',
    status: isStale ? 'stale' : row.status,
    pid: row.innerPid ?? 0,
    wrapperPid: row.wrapperPid ?? 0,
    socket: row.socketPath ?? '',
    tokens: {
      input: row.tokensInput ?? 0,
      output: row.tokensOutput ?? 0,
      percent: row.tokensPercent ?? 0,
    },
    contextCeiling: row.contextCeiling ?? 0,
    lastActivity: row.lastActivity.toISOString(),
    channels: row.channels,
    currentTask: row.currentTask,
    ...(row.provider != null && { provider: row.provider }),
    ...(row.modelFullId != null && { modelFullId: row.modelFullId }),
  };
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

  // ---- GET /projects/:name/file_versions ---------------------------------
  // Letzte N Eintraege aus file_versions-Tabelle (Synapse-eigene "Commits"
  // mit reason + feature_tag + agent_id + git_commit_sha + agent_note).
  // Wird vom Tray-Events-Tab genutzt — zeigt was Synapse-Tools gemacht
  // haben statt was chokidar an Roh-Events sah.
  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/projects/:name/file_versions',
    async (req, reply) => {
      const { name } = req.params;
      if (!manager.status(name)) {
        reply.code(404);
        return { error: 'unknown project' };
      }
      let limit = parseInt(req.query.limit ?? '100', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = 100;
      if (limit > 1000) limit = 1000;
      try {
        const pool = getPool();
        const { rows } = await pool.query(
          `SELECT id, file_path, edit_action, agent_id, reason, feature_tag,
                  git_commit_sha, agent_note, created_at
             FROM file_versions
            WHERE project = $1
            ORDER BY created_at DESC
            LIMIT $2`,
          [name, limit],
        );
        return { versions: rows };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- GET /projects/:name/specialists -----------------------------------
  // Primary: PostgreSQL wrapper_status — gibt alle registrierten Spezialisten
  // mit Status/Modell/Tokens/wrapperPid zurueck.
  // Fallback auf .synapse/agents/status.json wenn PG-Tabelle leer ist.
  // Wird vom Tray-Context-Menue "Agenten" genutzt.
  app.get<{ Params: { name: string } }>(
    '/projects/:name/specialists',
    async (req, reply) => {
      const projectName = req.params.name;
      const info = manager.status(projectName);
      if (!info) {
        reply.code(404);
        return { error: 'unknown project' };
      }
      try {
        // Primary: PostgreSQL wrapper_status
        const pgRows = await listWrapperStatus(projectName);
        // Metadaten (maxSpecialists, lastUpdate-Fallback) aus status.json
        const statusFile = await readStatus(info.pfad);

        if (pgRows.length > 0) {
          const specialists: Record<string, unknown> = {};
          for (const row of pgRows) {
            specialists[row.agentName] = pgRowToSpecialist(row);
          }
          return {
            project: projectName,
            specialists,
            maxSpecialists: statusFile.maxSpecialists,
            lastUpdate: pgRows[0].lastActivity.toISOString(),
          };
        }

        // Fallback: status.json wenn PG-Tabelle leer
        return {
          project: projectName,
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
  // Sendet SIGTERM an die wrapperPid (PG primary, status.json fallback)
  // und bereinigt beide Stores (status.json + PG wrapper_status).
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
        // PG primary: wrapperPid aus wrapper_status
        const pgRow = await getWrapperStatus(specName, name).catch(() => null);
        // Fallback: status.json (fuer Wrapper die noch keinen Heartbeat geschrieben haben)
        const statusFile = await readStatus(info.pfad).catch(() => null);
        const wrapperPid = pgRow?.wrapperPid ?? statusFile?.specialists[specName]?.wrapperPid;
        if (!wrapperPid) {
          reply.code(404);
          return { error: `unknown specialist: ${specName}` };
        }
        // SIGTERM — es ist ok wenn der Prozess schon tot ist
        try {
          process.kill(wrapperPid, 'SIGTERM');
        } catch (err: any) {
          if (err.code !== 'ESRCH') throw err; // ESRCH = no such process, harmlos
        }
        // Cleanup: status.json + PG (beide, non-fatal einzeln)
        await removeSpecialist(info.pfad, specName).catch(() => { /* non-fatal */ });
        await removeWrapperStatus(specName, name).catch(() => { /* non-fatal */ });
        return { ok: true, stopped: specName, wrapperPid };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- GET /projects/:name/channels --------------------------------------
  // Liefert alle Channels eines Projekts (fuer Tray-Submenu).
  app.get<{ Params: { name: string } }>(
    '/projects/:name/channels',
    async (req, reply) => {
      try {
        const channels = await listChannels(req.params.name);
        return { project: req.params.name, channels };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- GET /projects/:name/channels/:channel/feed?limit=50 ---------------
  // Letzte N Nachrichten eines Channels. Default 50.
  app.get<{
    Params: { name: string; channel: string };
    Querystring: { limit?: string };
  }>(
    '/projects/:name/channels/:channel/feed',
    async (req, reply) => {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      try {
        const messages = await getChannelMessages(req.params.name, req.params.channel, { limit });
        return { project: req.params.name, channel: req.params.channel, messages };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- POST /projects/:name/channels/:channel/post -----------------------
  // Body: { sender: string, content: string }
  app.post<{
    Params: { name: string; channel: string };
    Body: { sender?: string; content?: string };
  }>(
    '/projects/:name/channels/:channel/post',
    async (req, reply) => {
      const sender = (req.body?.sender ?? 'synapse-tray').trim();
      const content = (req.body?.content ?? '').trim();
      if (!content) {
        reply.code(400);
        return { error: 'content required' };
      }
      try {
        const res = await postChannelMessage(req.params.name, req.params.channel, sender, content);
        if (!res) {
          reply.code(404);
          return { error: `channel "${req.params.channel}" not found` };
        }
        return { ok: true, messageId: res.id, createdAt: res.createdAt };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ---- GET /projects/:name/agents ----------------------------------------
  // Aktive Chat-Agenten des Projekts (fuer Chat-Fenster Seitenleiste).
  app.get<{ Params: { name: string } }>(
    '/projects/:name/agents',
    async (req, reply) => {
      try {
        const agents = await listActiveAgents(req.params.name);
        return { project: req.params.name, agents };
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
