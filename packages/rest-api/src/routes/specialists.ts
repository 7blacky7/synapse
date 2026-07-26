/**
 * Synapse API - Specialists & Channels Routes
 */

import { FastifyInstance } from 'fastify';
import {
  listWrapperStatus,
  enqueueSpecialistJob,
  waitForSpecialistJob,
  postToInbox,
  getPool,
  listChannels,
  getChannelMessages,
  postChannelMessage,
  queryToolCalls,
} from '@synapse/core';

export async function specialistRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects/:name/specialists
   * Alle Spezialisten eines Projekts auflisten (aus wrapper_status)
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/specialists', async (request, reply) => {
    const { name } = request.params;

    try {
      const rows = await listWrapperStatus(name);
      const specialists: Record<string, any> = {};

      for (const row of rows) {
        specialists[row.agentName] = {
          name: row.agentName,
          model: row.model ?? '',
          status: row.status,
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
          channels: row.channels ?? [],
          currentTask: row.currentTask ?? null,
          busy: row.busy ?? false,
          provider: row.provider ?? null,
          modelFullId: row.modelFullId ?? null,
        };
      }

      return {
        success: true,
        project: name,
        specialists,
        runningCount: rows.filter(r => r.status === 'running').length,
        lastUpdate: rows[0]?.lastActivity?.toISOString() ?? new Date().toISOString(),
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/specialists/spawn
   * Einen neuen Spezialisten spawnen
   */
  fastify.post<{
    Params: { name: string };
    Body: { name: string; model: string; cwd?: string; allowedTools?: string[] };
  }>('/api/projects/:name/specialists/spawn', async (request, reply) => {
    const project = request.params.name;
    const { name: specName, model, cwd, allowedTools } = request.body ?? {};

    if (!specName || !model) {
      return reply.status(400).send({
        success: false,
        error: { message: 'name und model sind erforderlich' },
      });
    }

    try {
      // Auflösung des Pfads aus der DB falls nicht übergeben
      let projectPath = cwd;
      if (!projectPath) {
        const pgRes = await getPool().query<{ path: string }>(
          `SELECT path FROM projects
           WHERE name = $1 AND path NOT LIKE '/virtual/%'
           ORDER BY last_access DESC NULLS LAST
           LIMIT 1`,
          [project],
        );
        if (pgRes.rows.length > 0) {
          projectPath = pgRes.rows[0].path;
        }
      }

      const { id } = await enqueueSpecialistJob({
        project,
        action: 'spawn',
        args: {
          name: specName,
          model,
          cwd: projectPath,
          allowedTools,
        },
      });

      const result = await waitForSpecialistJob(id, 60_000);
      if (result.status === 'done') {
        return result.result ?? { success: true, message: `Spezialist "${specName}" gestartet` };
      }

      return reply.status(400).send({
        success: false,
        status: result.status,
        error: result.error,
        message: result.message ?? `Spawn für Spezialist "${specName}" fehlgeschlagen.`,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/specialists/:specName/stop
   * Spezialisten stoppen
   */
  fastify.post<{
    Params: { name: string; specName: string };
  }>('/api/projects/:name/specialists/:specName/stop', async (request, reply) => {
    const project = request.params.name;
    const specName = request.params.specName;

    try {
      const { id } = await enqueueSpecialistJob({
        project,
        action: 'stop',
        args: { name: specName },
      });

      const result = await waitForSpecialistJob(id, 60_000);
      if (result.status === 'done') {
        return result.result ?? { success: true, message: `Spezialist "${specName}" gestoppt` };
      }

      return reply.status(400).send({
        success: false,
        status: result.status,
        error: result.error,
        message: result.message ?? `Stoppen von Spezialist "${specName}" fehlgeschlagen.`,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/specialists/:specName/purge
   * Spezialisten bereinigen/entfernen
   */
  fastify.post<{
    Params: { name: string; specName: string };
  }>('/api/projects/:name/specialists/:specName/purge', async (request, reply) => {
    const project = request.params.name;
    const specName = request.params.specName;

    try {
      const { id } = await enqueueSpecialistJob({
        project,
        action: 'purge',
        args: { name: specName },
      });

      const result = await waitForSpecialistJob(id, 60_000);
      if (result.status === 'done') {
        return result.result ?? { success: true, message: `Spezialist "${specName}" bereinigt` };
      }

      return reply.status(400).send({
        success: false,
        status: result.status,
        error: result.error,
        message: result.message ?? `Bereinigung von Spezialist "${specName}" fehlgeschlagen.`,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/specialists/:specName/wake
   * Spezialisten wecken
   */
  fastify.post<{
    Params: { name: string; specName: string };
    Body: { message: string };
  }>('/api/projects/:name/specialists/:specName/wake', async (request, reply) => {
    const project = request.params.name;
    const specName = request.params.specName;
    const { message } = request.body ?? {};

    if (!message) {
      return reply.status(400).send({
        success: false,
        error: { message: 'message ist erforderlich fuer wake' },
      });
    }

    try {
      const topic = `synapse_specialist_wake_${specName}`;
      const payload = JSON.stringify({ message, from: 'rest-api', project, timestamp: Date.now() });
      let notifyOk = false;
      let inboxId: number | undefined;
      const wakeErrors: string[] = [];

      try {
        await getPool().query('SELECT pg_notify($1, $2)', [topic, payload]);
        notifyOk = true;
      } catch (e) {
        wakeErrors.push(`notify: ${(e as Error).message}`);
      }

      try {
        const r = await postToInbox('rest-api', specName, message);
        inboxId = r.id;
      } catch (e) {
        wakeErrors.push(`inbox: ${(e as Error).message}`);
      }

      const ok = notifyOk || inboxId != null;
      if (ok) {
        return {
          success: true,
          name: specName,
          notified: notifyOk,
          inboxId,
          message: `Wake gesendet an "${specName}" (notify=${notifyOk}, inbox=${inboxId != null})`,
        };
      }

      return reply.status(500).send({
        success: false,
        errors: wakeErrors,
        message: `Wake-Fehler fuer "${specName}": ${wakeErrors.join(', ')}`,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/channels
   * Alle Gruppenkanäle auflisten
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/channels', async (request, reply) => {
    const { name } = request.params;
    try {
      const channels = await listChannels(name);
      return {
        success: true,
        project: name,
        channels,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/channels/:channel/feed
   * Kanal-Historie abrufen
   */
  fastify.get<{
    Params: { name: string; channel: string };
    Querystring: { limit?: string };
  }>('/api/projects/:name/channels/:channel/feed', async (request, reply) => {
    const { name, channel } = request.params;
    const limit = request.query.limit ? Number(request.query.limit) : 50;

    try {
      const messages = await getChannelMessages(name, channel, { limit });
      return {
        success: true,
        project: name,
        channel,
        messages,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/channels/:channel/post
   * Nachricht in Gruppenkanal posten
   */
  fastify.post<{
    Params: { name: string; channel: string };
    Body: { sender?: string; content: string };
  }>('/api/projects/:name/channels/:channel/post', async (request, reply) => {
    const { name, channel } = request.params;
    const sender = (request.body?.sender ?? 'user').trim();
    const content = (request.body?.content ?? '').trim();

    if (!content) {
      return reply.status(400).send({
        success: false,
        error: { message: 'content ist erforderlich' },
      });
    }

    try {
      const res = await postChannelMessage(name, channel, sender, content);
      if (!res) {
        return reply.status(404).send({
          success: false,
          error: { message: `Kanal "${channel}" nicht gefunden` },
        });
      }

      return {
        success: true,
        messageId: res.id,
        createdAt: res.createdAt,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/events
   * SSE Live-Stream für Statusänderungen und Kanäle (PG LISTEN)
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/events', async (request, reply) => {
    const { name: project } = request.params;

    // Set correct headers for SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.sent = true;

    // Write initial retry & connection confirmation
    reply.raw.write('retry: 5000\n\n');
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', project })}\n\n`);

    let client: any = null;
    let isClosed = false;

    // Periodic heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      if (!isClosed) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      }
    }, 15000);

    const cleanup = async () => {
      if (isClosed) return;
      isClosed = true;
      clearInterval(heartbeatInterval);

      if (client) {
        try {
          await client.query('UNLISTEN synapse_specialist_status_change');
          await client.query('UNLISTEN synapse_channel');
        } catch (e) {
          // ignore
        } finally {
          client.release();
        }
      }
    };

    request.raw.on('close', () => {
      cleanup();
    });

    try {
      client = await getPool().connect();

      client.on('notification', (msg: any) => {
        if (isClosed) return;

        try {
          const payload = JSON.parse(msg.payload || '{}');
          // Only send if it matches the current project
          if (payload.project === project) {
            reply.raw.write(`data: ${JSON.stringify({
              channel: msg.channel,
              payload
            })}\n\n`);
          }
        } catch (err) {
          reply.raw.write(`data: ${JSON.stringify({
            channel: msg.channel,
            raw: msg.payload
          })}\n\n`);
        }
      });

      await client.query('LISTEN synapse_specialist_status_change');
      await client.query('LISTEN synapse_channel');
    } catch (error) {
      clearInterval(heartbeatInterval);
      if (client) {
        client.release();
      }
      if (!reply.raw.headersSent) {
        reply.status(500).send({
          success: false,
          error: { message: `SSE-Initialisierung fehlgeschlagen: ${String(error)}` }
        });
      } else {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`);
        reply.raw.end();
      }
    }
  });

  /**
   * GET /api/projects/:name/watcher-events
   * Letzte Watcher-Events abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { limit?: string };
  }>('/api/projects/:name/watcher-events', async (request, reply) => {
    const { name } = request.params;
    const limit = request.query.limit ? Number(request.query.limit) : 50;

    try {
      const { rows } = await getPool().query(
        `SELECT id::text AS id, project, event_type, file_path, details, created_at::text AS created_at
         FROM watcher_events
         WHERE project = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [name, limit]
      );

      return {
        success: true,
        project: name,
        events: rows,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/file-versions
   * Letzte Datei-Versionen abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { limit?: string };
  }>('/api/projects/:name/file-versions', async (request, reply) => {
    const { name } = request.params;
    const limit = request.query.limit ? Number(request.query.limit) : 50;

    try {
      const { rows } = await getPool().query(
        `SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id,
                batch_id::text AS batch_id, size_bytes, created_at::text AS created_at, reason,
                feature_tag, parent_version_id::text AS parent_version_id, git_commit_sha, agent_note
         FROM file_versions
         WHERE project = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [name, limit]
      );

      return {
        success: true,
        project: name,
        versions: rows,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/tool-calls
   * Letzte Eintraege aus dem zentralen Tool-Call-Audit-Log (ALLE MCP-Tool-
   * Aufrufe: code_intel, files, shell, etc. — siehe tool-call-log.ts).
   * detail='summary': args_preview + kurze Ergebnis-Vorschau, kein volles
   * Ergebnis — haelt die Liste leicht, auch bei 50+ Zeilen mit grossen Results.
   * Fuer den vollen Inhalt einer einzelnen Zeile: /tool-calls/:id.
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { limit?: string };
  }>('/api/projects/:name/tool-calls', async (request, reply) => {
    const { name } = request.params;
    const limit = request.query.limit ? Number(request.query.limit) : 50;

    try {
      const calls = await queryToolCalls({ project: name, limit, detail: 'summary' });
      return { success: true, project: name, calls };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/tool-calls/:id
   * Ein einzelner Tool-Call MIT vollem Ergebnis (detail='full') — fuer das
   * Detail-Fenster, das beim Anklicken einer Zeile im Aktivitaet-Tab aufgeht.
   */
  fastify.get<{
    Params: { name: string; id: string };
  }>('/api/projects/:name/tool-calls/:id', async (request, reply) => {
    const { name, id } = request.params;

    try {
      const rows = await queryToolCalls({ project: name, id, detail: 'full', limit: 1 });
      if (!rows.length) {
        return reply.status(404).send({ success: false, error: { message: `Tool-Call ${id} nicht gefunden` } });
      }
      return { success: true, project: name, call: rows[0] };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
