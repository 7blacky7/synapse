/**
 * Synapse API - Specialists & Channels Routes
 */

import { FastifyInstance } from 'fastify';
import {
  listWrapperStatus,
  waehleSpezialisten,
  kennzeichnung,
  baueSpawnJobArgs,
  pruefeSpawnEffort,
  enqueueSpecialistJob,
  waitForSpecialistJob,
  postToInbox,
  getPool,
  listChannels,
  getChannelMessages,
  postChannelMessage,
  mitUserHerkunft,
  queryToolCalls,
  logToolCall,
} from '@synapse/core';

import { agentennetzwerkRoutes } from './agentennetzwerk.js';
import { leseNetzwerkKonfiguration, hauptagentIdentitaetsId } from '@synapse/core';
import { validateToken } from '../services/auth.js';
// P22-T170: Channel-Fenster als Herkunft des Lesefensters - Zitate/Pins gehen als Block im Channel-Post an den ganzen Channel.
import { pruefeChatZitateAnfrage, textMitZitaten } from '@synapse/core';
import { ladeAgentenTeam } from '../services/agenten-team.js';
// P22-T172: aktuelle Task je Agent (eine Stelle in core, Schalter agent_aktuelle_task).
import { ermittleAktuelleTasks } from '@synapse/core';

export async function specialistRoutes(fastify: FastifyInstance): Promise<void> {
  await agentennetzwerkRoutes(fastify);
  /**
   * GET /api/projects/:name/specialists
   * Alle Spezialisten eines Projekts auflisten (aus wrapper_status)
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { ausblenden?: string };
  }>('/api/projects/:name/specialists', async (request, reply) => {
    const { name } = request.params;

    try {
      const alleRows = await listWrapperStatus(name);
      // Web-UI braucht die Leichen (Stop/Purge): Standard = alle mit Kennzeichnung (verwaist, inaktiv_seit);
      // ausblenden=true blendet Leichen aus (P7-T10).
      const auswahl = waehleSpezialisten(alleRows, { alle: request.query?.ausblenden !== 'true' });
      const rows = auswahl.sichtbar.map(z => z.row);
      const kennz = new Map(auswahl.sichtbar.map(z => [z.row.agentName, kennzeichnung(z)]));
      const specialists: Record<string, any> = {};

      for (const row of rows) {
        specialists[row.agentName] = {
          ...kennz.get(row.agentName),
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
        ausgeblendet: auswahl.ausgeblendetAnzahl,
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
   * GET /api/projects/:name/agenten-team
   * P22-T89: Agententeam der Web-UI - aktive Identitaeten (Ausweis) des Projekts plus Wrapper-Spezialisten (services/agenten-team.ts)
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/agenten-team', async (request, reply) => {
    try {
      return await ladeAgentenTeam(request.params.name);
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/agenten-aktuelle-task
   * P22-T172: aktuelle Task je Agent des Projekts (core agent-aktuelle-task.ts) fuer die Web-UI ('claude-t50 · P22-T171').
   * Debug: schalter (Quelle), einstellungen (Quelle), reihenfolge, quelle/signale je Zeile, dauer_ms, cache; neu=1 umgeht den Puffer.
   * Schalter AUS -> aktiv false, leere Liste. Wirft nie (Lesefehler in letzter_fehler).
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { neu?: string };
  }>('/api/projects/:name/agenten-aktuelle-task', async (request) => {
    return ermittleAktuelleTasks(request.params.name, { neu: request.query?.neu === '1' });
  });

  /**
   * POST /api/projects/:name/specialists/spawn
   * Einen neuen Spezialisten spawnen
   */
  fastify.post<{
    Params: { name: string };
    // snake_case wie das specialist-Tool; camelCase (allowedTools, keepAlive) als Alias
    Body: {
      name: string; model: string; expertise?: string; task?: string; channel?: string;
      cwd?: string; allowed_tools?: string[]; allowedTools?: string[];
      keep_alive?: boolean; keepAlive?: boolean; effort?: string;
    };
  }>('/api/projects/:name/specialists/spawn', async (request, reply) => {
    const project = request.params.name;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const specName = body.name;
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;

    if (!specName || !body.model) {
      return reply.status(400).send({
        success: false,
        error: { message: 'name und model sind erforderlich (dazu expertise und task)' },
      });
    }

    try {
      // effort frueh pruefen (Tippfehler sofort mit den erlaubten Werten, nicht nach der Queue)
      try {
        await pruefeSpawnEffort(body.model, body.effort);
      } catch (err) {
        return reply.status(400).send({
          success: false,
          error: 'invalid_effort',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Projektpfad IMMER aus der DB (daemon-bekannter Host-Pfad); cwd ist nur das Arbeitsverzeichnis.
      let projectPath: string | undefined;
      {
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

      // Gemeinsame Funktion (core specialist-spawn-args.ts, dieselbe wie im specialist-Tool ueber REST):
      // Worker-Form mit expertise/task/project/project_path/allowed_tools/channel/keep_alive, nie "undefined".
      // keep_alive-Standard auf dem REST/Web-Weg: false (stdio: true) — Vereinheitlichung ist User-Entscheidung.
      const gebaut = baueSpawnJobArgs('spawn', { ...body, cwd }, {
        project,
        projectPath: projectPath ?? '',
        keepAliveStandard: false,
      });
      if (!gebaut.ok) {
        return reply.status(400).send({
          success: false,
          error: 'invalid_spawn_args',
          message: gebaut.fehler,
        });
      }

      const { id } = await enqueueSpecialistJob({
        project,
        action: 'spawn',
        args: gebaut.args,
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

      const result = await waitForSpecialistJob(id, 135_000);
      // Audit: dieser Weg lief bisher an tool_calls VORBEI. GEMESSEN 02.08.2026 —
      // references(logToolCall) hatte genau zwei Aufrufer (stdio + MCP-ueber-REST),
      // diese Route keinen. Jeder Klick im Dashboard war damit unsichtbar, und die
      // Frage "purge ohne vorangehendes stop" systematisch zu niedrig beantwortet,
      // weil ein ganzer Aufrufweg fehlte.
      void logToolCall({
        project,
        agentId: null,
        source: 'web-ui',
        tool: 'specialist',
        action: 'stop',
        argsPreview: JSON.stringify({ name: specName }),
        ok: result.status === 'done',
        error: result.error ?? null,
      });
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
      // Siehe stop-Route: bis 02.08.2026 war dieser Aufrufweg in keiner Statistik.
      // purge ist die zerstoerendste Aktion des Systems (danach sind die Skill-Dateien
      // weg, siehe koordinator-lesson-purge-vs-stop) — ausgerechnet sie war ungezaehlt.
      void logToolCall({
        project,
        agentId: null,
        source: 'web-ui',
        tool: 'specialist',
        action: 'purge',
        argsPreview: JSON.stringify({ name: specName }),
        ok: result.status === 'done',
        error: result.error ?? null,
      });
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
      const { fuehreSpecialistIdentitaetsAktion } = await import('@synapse/core');
      const identityResult = await fuehreSpecialistIdentitaetsAktion({ action:'wake',project,name:specName,message });
      if (identityResult) return identityResult;
      const topic = `synapse_specialist_wake_${specName}`;
      // P22-T119: echter Absender (Ausweis-Principal) statt fest 'rest-api' (Schalter wake_echter_absender, Std AUS).
      const { wakeAbsenderFuer } = await import('@synapse/core');
      const wa = await wakeAbsenderFuer(project, null);
      const payload = JSON.stringify({ message, from: wa.absender, project, timestamp: Date.now() });
      let notifyOk = false;
      let inboxId: number | undefined;
      const wakeErrors: string[] = [];

      // P22-T120 R2: Rueckadresse VORAB, atomar im INSERT der wake-Zeile; mit Rueckadresse erst INSERT, dann Notify (sonst Bestand).
      const { wakeRueckadresseVorab, wakeReihenfolge } = await import('@synapse/core');
      const vorab = await wakeRueckadresseVorab(project, wa.absender);
      const notify = async (): Promise<boolean> => {
        try {
          await getPool().query('SELECT pg_notify($1, $2)', [topic, payload]);
          return true;
        } catch (e) {
          wakeErrors.push(`notify: ${(e as Error).message}`);
          return false;
        }
      };
      const inbox = async (): Promise<number | undefined> => {
        try {
          return (await postToInbox(wa.absender, specName, message, project, vorab.identity_id ? { fromIdentityId: vorab.identity_id } : undefined)).id;
        } catch (e) {
          wakeErrors.push(`inbox: ${(e as Error).message}`);
          return undefined;
        }
      };
      // Mit Rueckadresse: Notify NUR nach erfolgreichem INSERT, sonst success=false (500) mit Debug. Ohne: Bestand.
      const ablauf = await wakeReihenfolge(!!vorab.identity_id, inbox, notify);
      notifyOk = ablauf.notifyOk; inboxId = ablauf.inboxId;
      if (ablauf.rueckadresse_fehler) wakeErrors.push(ablauf.rueckadresse_fehler);
      const rueckadresse = { ...vorab, gesetzt: !!vorab.identity_id && inboxId != null, fehler: ablauf.rueckadresse_fehler };

      const ok = ablauf.ok;
      if (ok) {
        return {
          success: true,
          name: specName,
          notified: notifyOk,
          inboxId,
          debug: { absender: wa.absender, absender_quelle: wa.quelle, schalter: 'wake_echter_absender', rueckadresse },
          message: `Wake gesendet an "${specName}" (notify=${notifyOk}, inbox=${inboxId != null})`,
        };
      }

      return reply.status(500).send({
        success: false,
        errors: wakeErrors,
        debug: { absender: wa.absender, absender_quelle: wa.quelle, schalter: 'wake_echter_absender', rueckadresse },
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

  // P10-T41: Herkunft aus bestehender Web-UI-Sitzung bzw. Tray-/Daemon-Verbindung.
  // Tray und Daemon teilen bewusst den Service-Token; nur der Tray ruft user-post auf.
  // P22-T170 (additiv): zitate wie agent-chat (Schalter chat_zitate im Projekt des Channels, AUS -> 409); content = Text + Block.
  // Ohne zitate unveraendert; nur Zitate ohne Text ist erlaubt. Debug: zitate {anzahl, block_zeichen, schalter_quelle, channel}.
  fastify.post<{ Params: { name: string; channel: string }; Body: { content?: string; zitate?: unknown } }>(
    '/api/projects/:name/channels/:channel/user-post', async (request, reply) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
      const principal = bearer ? await validateToken(bearer) : null;
      const kanal = principal?.kind === 'session' && principal.scope === null
        ? 'web-ui-chat'
        : principal?.kind === 'service' && (principal.scope === 'daemon' || principal.scope?.startsWith('daemon:'))
          ? 'tray' : null;
      if (!kanal) return reply.code(403).send({ success: false, error: { message: 'User-Nachrichten benötigen den angemeldeten Tray- oder Web-UI-Zugang; sender/agent_id ersetzen ihn nicht.' } });
      const text = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
      const z = await pruefeChatZitateAnfrage(request.body?.zitate, request.params.name);
      if (!z.ok) return reply.code(z.status).send({ success: false, error: { code: z.code, message: z.message, ...(z.details ? { details: z.details } : {}) } });
      const content = textMitZitaten(text, z.zitate);
      if (!content) return reply.code(400).send({ success: false, error: { message: 'content ist erforderlich' } });
      if (z.zitate.length && content.length > 20_000) return reply.code(400).send({ success: false, error: { code: 'text_zu_lang', message: 'Nachricht mit Zitaten laenger als 20000 Zeichen' } });
      const result = await mitUserHerkunft(kanal, () => postChannelMessage(request.params.name, request.params.channel, 'user', content));
      if (!result) return reply.code(404).send({ success: false, error: { message: 'Kanal nicht gefunden' } });
      return { success: true, messageId: result.id, createdAt: result.createdAt,
        ...(z.debug ? { zitate: { ...z.debug, block_zeichen: content.length - text.length, channel: request.params.channel } } : {}) };
    },
  );

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
    Querystring: { netzwerk?: string };
  }>('/api/projects/:name/events', async (request, reply) => {
    const { name: project } = request.params;
    const netzwerkStand = request.query.netzwerk === '1' ? await leseNetzwerkKonfiguration(project) : null;
    const netzwerk = netzwerkStand?.schalter.aktiv === true;
    const mainId = netzwerk ? await hauptagentIdentitaetsId() : null;

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
    let netzwerkTimer: ReturnType<typeof setTimeout> | null = null;
    let benachrichtigung: ((msg: { channel: string; payload?: string }) => void) | null = null;

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
      if (netzwerkTimer) clearTimeout(netzwerkTimer);

      if (client) {
        if (benachrichtigung) client.removeListener('notification', benachrichtigung);
        try {
          await client.query('UNLISTEN synapse_specialist_status_change');
          await client.query('UNLISTEN synapse_channel');
          if (netzwerk) await client.query('UNLISTEN synapse_tool_activity');
        } catch (e) {
          // ignore
        } finally {
          client.release();
        }
      }
    };

    reply.raw.on('close', () => {
      cleanup();
    });

    try {
      client = await getPool().connect();
      if (isClosed) { client.release(); return; }

      benachrichtigung = (msg: { channel: string; payload?: string }) => {
        if (isClosed) return;

        try {
          const payload = JSON.parse(msg.payload || '{}');
          // Only send if it matches the current project
          if (payload.project === project || (netzwerk && msg.channel === 'synapse_tool_activity' && mainId && payload.identity_id === mainId)) {
            if (netzwerk) {
              // Ein Hinweis pro Buendel, kein Inhalt und kein wachsender Schreibpuffer bei Last.
              if (!netzwerkTimer) netzwerkTimer = setTimeout(() => {
                netzwerkTimer = null;
                if (!isClosed) reply.raw.write('data: ' + JSON.stringify({channel:'synapse_tool_activity',payload:{project}}) + '\n\n');
              }, netzwerkStand!.werte.buendel_ms);
            } else {
              reply.raw.write(`data: ${JSON.stringify({channel: msg.channel, payload})}\n\n`);
            }
          }
        } catch (err) {
          reply.raw.write(`data: ${JSON.stringify({
            channel: msg.channel,
            ...(netzwerk ? {} : { raw: msg.payload })
          })}\n\n`);
        }
      };
      client.on('notification', benachrichtigung);

      await client.query('LISTEN synapse_specialist_status_change');
      await client.query('LISTEN synapse_channel');
      if (netzwerk) {
        await client.query('LISTEN synapse_tool_activity');
        if (!isClosed) reply.raw.write('data: ' + JSON.stringify({type:'netzwerk_bereit',project}) + '\n\n');
      }
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
