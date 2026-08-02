/**
 * Synapse API — Wrapper-Bruecke (API-Bruecke, Schritt 1)
 *
 * ZWECK: Alles, was der Spezialisten-Wrapper heute per DIREKTER PostgreSQL-Verbindung
 * macht, ueber HTTP anbieten. Damit kann ein Wrapper ohne DATABASE_URL laufen —
 * auf einem anderen Rechner, in Docker auf Unraid, oder in der synapse-api selbst.
 *
 * ADDITIV: keine bestehende Route wird veraendert. Der heutige PG-Weg bleibt
 * unberuehrt; laufende Wrapper merken von diesen Routen nichts.
 *
 * ABBILDUNG (Quelle: packages/agents/src/wrapper.ts):
 *   getWrapperStatus        :143   -> GET  .../config
 *   initializeWatermarks    :1387  -> GET  .../watermarks (auch in /config und /poll)
 *   fetchCurrentChannels    :1031  -> GET  .../channels
 *   getNewMessagesForAgent  :869   -> GET  .../channel-messages?since_id=
 *   getNewInboxMessages     :926   -> GET  .../inbox?since_id=
 *   UPDATE specialist_inbox :934   -> POST .../inbox/ack
 *   pollSynapseItems        :955   -> GET  .../items
 *   upsertWrapperStatus     :1114  -> POST .../status
 *   LISTEN/NOTIFY           :228   -> GET  .../stream (SSE, gemeinsamer Client)
 *   ensureSchema            :1521  -> faellt im api-Modus ersatzlos weg (DDL gehoert
 *                                     nicht in einen entfernten Wrapper)
 *
 * DER SAMMELENDPUNKT GET .../poll ist der eigentliche Gewinn: der Wrapper fragt heute
 * pro Tick bis zu sieben Mal die Datenbank. Als sieben HTTP-Aufrufe waere die Bruecke
 * langsamer als der PG-Weg; als EIN Aufruf ist sie schneller.
 *
 * SICHTBARKEIT (die Frage "woran wuerde ich merken, dass es kaputt ist"):
 *   - jede config/status/poll-Antwort traegt einen "stream"-Block (connected,
 *     last_event_at, subscribers, listener_connected) — ein toter Stream ist damit
 *     eine Zahl, keine Stille.
 *   - jede inbox/ack-Antwort traegt unacked_count. Bleibt die Zahl stehen, ist zwischen
 *     Lesen und Quittieren etwas verloren gegangen — das ist ueber HTTP moeglich
 *     (zwei Aufrufe), ueber den heutigen PG-Weg nicht.
 *   - GET /api/projects/:name/wrapper-bridge/health zeigt Zaehler und Abonnenten.
 */

import { FastifyInstance } from 'fastify';
import {
  getPool,
  getWrapperStatus,
  upsertWrapperStatus,
  getNewMessagesForAgent,
  getNewInboxMessages,
  listMemories,
  getThoughtsByTag,
  getPlan,
  getPendingEvents,
} from '@synapse/core';
import { abonniere, stromSicht, stromGesundheit } from '../services/wrapper-stream.js';

/** Zaehler fuer GET .../wrapper-bridge/health. Prozesslokal, bewusst kein Speicher. */
const zaehler = {
  config: 0,
  watermarks: 0,
  channels: 0,
  channelMessages: 0,
  inbox: 0,
  inboxAck: 0,
  inboxAckLeer: 0,
  items: 0,
  polls: 0,
  pollsOhneInhalt: 0,
  statusWrites: 0,
  register: 0,
  deregister: 0,
  streams: 0,
  fehler: 0,
  seit: new Date().toISOString(),
};

const ERLAUBTE_STATUS = ['running', 'idle', 'crashed', 'stopped'] as const;
type WrapperStatusWert = (typeof ERLAUBTE_STATUS)[number];

function istStatusWert(wert: unknown): wert is WrapperStatusWert {
  return typeof wert === 'string' && (ERLAUBTE_STATUS as readonly string[]).includes(wert);
}

/** Liest ein Feld in camelCase ODER snake_case — der Aufrufer soll nichts umbenennen muessen. */
function feld(body: Record<string, unknown> | undefined, ...namen: string[]): unknown {
  if (!body) return undefined;
  for (const n of namen) {
    if (body[n] !== undefined && body[n] !== null) return body[n];
  }
  return undefined;
}

function alsZahl(wert: unknown): number | null {
  if (wert === undefined || wert === null) return null;
  const n = Number(wert);
  return Number.isFinite(n) ? n : null;
}

function alsBool(wert: unknown): boolean | null {
  if (typeof wert === 'boolean') return wert;
  if (wert === 'true') return true;
  if (wert === 'false') return false;
  return null;
}

function alsText(wert: unknown): string | null {
  return typeof wert === 'string' && wert.length > 0 ? wert : null;
}

function seitId(roh: unknown): number {
  const n = alsZahl(roh);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
}

function grenze(roh: unknown, standard: number, max: number): number {
  const n = alsZahl(roh);
  if (n === null || n <= 0) return standard;
  return Math.min(Math.floor(n), max);
}

/**
 * MAX(id) der fuer diesen Agenten sichtbaren Channel-Nachrichten bzw. seiner Inbox.
 * Wortgleich zu initializeWatermarks (wrapper.ts:1387-1414) — die Semantik MUSS
 * MAX sein und nicht 0, sonst flutet ein frisch gestarteter Wrapper seinen Agenten
 * mit der gesamten Historie.
 */
async function leseWatermarks(agent: string): Promise<{ channel: number; inbox: number }> {
  const pool = getPool();
  const channelErgebnis = await pool.query<{ max_id: number }>(
    `SELECT COALESCE(MAX(cm.id), 0)::int AS max_id
       FROM specialist_channel_messages cm
       JOIN specialist_channels c ON c.id = cm.channel_id
       JOIN specialist_channel_members mem ON mem.channel_id = c.id
      WHERE mem.agent_name = $1`,
    [agent],
  );
  const inboxErgebnis = await pool.query<{ max_id: number }>(
    `SELECT COALESCE(MAX(id), 0)::int AS max_id
       FROM specialist_inbox
      WHERE to_agent = $1`,
    [agent],
  );
  return {
    channel: channelErgebnis.rows[0]?.max_id ?? 0,
    inbox: inboxErgebnis.rows[0]?.max_id ?? 0,
  };
}

/** Kanal-MITGLIEDSCHAFT dieses Agenten — nicht die Kanalliste des Projekts. */
async function leseMitgliedschaften(agent: string): Promise<string[]> {
  const { rows } = await getPool().query<{ channel_name: string }>(
    `SELECT c.name AS channel_name
       FROM specialist_channels c
       JOIN specialist_channel_members m ON m.channel_id = c.id
      WHERE m.agent_name = $1
      ORDER BY c.name`,
    [agent],
  );
  return rows.map((r) => r.channel_name);
}

/** Wie viele Inbox-Nachrichten sind unquittiert? Die Zahl ist der Beleg gegen stillen Verlust. */
async function zaehleUnquittiert(agent: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM specialist_inbox WHERE to_agent = $1 AND processed = false`,
    [agent],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Die vier Abfragen aus pollSynapseItems (wrapper.ts:955-1024) in EINEM Durchgang,
 * mit exakt denselben Filtern. Geliefert werden DATEN — der Wake-Prompt entsteht
 * weiterhin im Wrapper. Kein Wortlaut wandert in die API.
 */
async function leseItems(project: string, agent: string): Promise<{
  memories: Array<{ name: string; content: string; tags: string[] }>;
  thoughts: Array<{ id: string; content: string; tags: string[] }>;
  tasks: Array<{ id: string; title: string; description: string; status: string; priority: string }>;
  events: Array<{ id: number; eventType: string; priority: string; payload: string | null }>;
}> {
  const [memoriesRoh, thoughtsRoh, plan, eventsRoh] = await Promise.all([
    listMemories(project),
    getThoughtsByTag(project, agent, 10),
    getPlan(project),
    getPendingEvents(project, agent),
  ]);

  const memories = memoriesRoh
    .filter((m) => (m.tags ?? []).includes(agent))
    .map((m) => ({ name: m.name, content: m.content, tags: m.tags ?? [] }));

  const thoughts = thoughtsRoh.map((t) => ({
    id: String(t.id),
    content: t.content,
    tags: t.tags ?? [],
  }));

  const nameKlein = agent.toLowerCase();
  const tasks = (plan?.tasks ?? [])
    .filter(
      (t) =>
        t.title.toLowerCase().includes(nameKlein) &&
        (t.status === 'todo' || t.status === 'in_progress'),
    )
    .map((t) => ({
      id: String(t.id),
      title: t.title,
      description: t.description ?? '',
      status: String(t.status),
      priority: String(t.priority),
    }));

  const events = eventsRoh.map((e) => ({
    id: Number(e.id),
    eventType: String(e.eventType),
    priority: String(e.priority),
    payload: e.payload ?? null,
  }));

  return { memories, thoughts, tasks, events };
}

/**
 * Baut die Heartbeat-Konfiguration fuer die Antwort. Beide Schreibweisen, damit
 * weder Aufrufer noch Server sich auf eine festlegen muss (der Wrapper liest
 * camelCase, die uebrige REST-Antwortform ist snake_case).
 */
function konfigAntwort(zeile: { heartbeatEnabled: boolean; heartbeatIntervalMs: number | null }): Record<string, unknown> {
  return {
    heartbeatEnabled: zeile.heartbeatEnabled,
    heartbeatIntervalMs: zeile.heartbeatIntervalMs,
    heartbeat_enabled: zeile.heartbeatEnabled,
    heartbeat_interval_ms: zeile.heartbeatIntervalMs,
  };
}

export async function wrapperBridgeRoutes(fastify: FastifyInstance): Promise<void> {
  const BASIS = '/api/projects/:name/specialists/:specName';

  /**
   * GET .../config — ersetzt getWrapperStatus in ladeHeartbeatKonfiguration.
   * Wird bei JEDEM Tick gelesen; ohne diese Route verliert der api-Weg die
   * Abschaltbarkeit und die feste Taktvorgabe — und zwar unbemerkt, weil ein
   * Wrapper, der den Takt nicht liest, adaptiv weiterlaeuft und normal aussieht.
   *
   * 404, wenn es noch keine wrapper_status-Zeile gibt. Der Aufrufer MUSS in dem
   * Fall bei seiner letzten bekannten Einstellung bleiben (wrapper.ts:134-137):
   * ein Ausfall darf einen arbeitenden Spezialisten nicht verstummen lassen und
   * einen abgeschalteten nicht aufwecken.
   */
  fastify.get<{ Params: { name: string; specName: string } }>(
    `${BASIS}/config`,
    async (request, reply) => {
      const { name: project, specName: agent } = request.params;
      zaehler.config += 1;
      try {
        const zeile = await getWrapperStatus(agent, project);
        if (!zeile) {
          return reply.status(404).send({
            success: false,
            error: {
              code: 'not_registered',
              message: `Keine wrapper_status-Zeile fuer "${agent}" in "${project}" — letzte bekannte Einstellung beibehalten.`,
            },
          });
        }
        const [watermarks, channels] = await Promise.all([
          leseWatermarks(agent),
          leseMitgliedschaften(agent),
        ]);
        return {
          success: true,
          project,
          agent,
          config: konfigAntwort(zeile),
          watermarks,
          channels,
          status: zeile.status,
          stream: stromSicht(project, agent),
          server_time: new Date().toISOString(),
        };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );

  /** GET .../watermarks — ersetzt initializeWatermarks (MAX(id), nicht 0). */
  fastify.get<{ Params: { name: string; specName: string } }>(
    `${BASIS}/watermarks`,
    async (request, reply) => {
      const { specName: agent } = request.params;
      zaehler.watermarks += 1;
      try {
        return { success: true, agent, watermarks: await leseWatermarks(agent) };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );

  /**
   * GET .../channels — ersetzt fetchCurrentChannels.
   * ⚠️ NICHT zu verwechseln mit GET /api/projects/:name/channels (specialists.ts:303):
   * das liefert ALLE Kanaele des Projekts, hier geht es um die MITGLIEDSCHAFT
   * dieses einen Agenten.
   */
  fastify.get<{ Params: { name: string; specName: string } }>(
    `${BASIS}/channels`,
    async (request, reply) => {
      const { specName: agent } = request.params;
      zaehler.channels += 1;
      try {
        return { success: true, agent, channels: await leseMitgliedschaften(agent) };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );

  /** GET .../channel-messages?since_id=&limit= — ersetzt getNewMessagesForAgent. */
  fastify.get<{
    Params: { name: string; specName: string };
    Querystring: { since_id?: string; limit?: string };
  }>(`${BASIS}/channel-messages`, async (request, reply) => {
    const { specName: agent } = request.params;
    const since = seitId(request.query.since_id);
    const limit = grenze(request.query.limit, 200, 500);
    zaehler.channelMessages += 1;
    try {
      // limit + 1 abfragen: nur so ist "genau limit Zeilen" von "limit Zeilen und da
      // kommt noch was" zu unterscheiden. Ohne das eine Zeile mehr meldet truncated nie.
      const alle = await getNewMessagesForAgent(agent, since, limit + 1);
      const messages = alle.slice(0, limit);
      return {
        success: true,
        agent,
        messages,
        count: messages.length,
        truncated: alle.length > messages.length,
        watermark: messages.length > 0 ? messages[messages.length - 1].id : since,
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET .../inbox?since_id=&limit= — ersetzt getNewInboxMessages (quittiert NICHT). */
  fastify.get<{
    Params: { name: string; specName: string };
    Querystring: { since_id?: string; limit?: string };
  }>(`${BASIS}/inbox`, async (request, reply) => {
    const { specName: agent } = request.params;
    const since = seitId(request.query.since_id);
    const limit = grenze(request.query.limit, 200, 500);
    zaehler.inbox += 1;
    try {
      const alle = await getNewInboxMessages(agent, since);
      const messages = alle.slice(0, limit);
      return {
        success: true,
        agent,
        messages,
        count: messages.length,
        truncated: alle.length > messages.length,
        watermark: messages.length > 0 ? messages[messages.length - 1].id : since,
        unacked_count: await zaehleUnquittiert(agent),
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * POST .../inbox/ack — ersetzt das rohe UPDATE specialist_inbox (wrapper.ts:934-937).
   * updated wird ECHT gezaehlt (RETURNING id): nur so faellt ein ins Leere gelaufenes
   * ack auf. Zusaetzlich unacked_count, weil Lesen und Quittieren ueber HTTP zwei
   * Aufrufe sind — reisst die Verbindung dazwischen, bleibt die Nachricht liegen.
   * Idempotent: ein zweites ack derselben IDs meldet updated=0, kein Fehler.
   * to_agent im WHERE, damit ein Agent nicht fremde Post quittieren kann.
   */
  fastify.post<{
    Params: { name: string; specName: string };
    Body: { ids?: unknown };
  }>(`${BASIS}/inbox/ack`, async (request, reply) => {
    const { specName: agent } = request.params;
    zaehler.inboxAck += 1;
    const roh = Array.isArray(request.body?.ids) ? (request.body?.ids as unknown[]) : [];
    const ids = roh
      .map((v) => alsZahl(v))
      .filter((v): v is number => v !== null)
      .map((v) => Math.floor(v));

    if (ids.length === 0) {
      zaehler.inboxAckLeer += 1;
      return reply.status(400).send({
        success: false,
        error: { code: 'no_ids', message: 'ids (number[]) ist erforderlich und darf nicht leer sein' },
      });
    }

    try {
      const { rows } = await getPool().query<{ id: number }>(
        `UPDATE specialist_inbox
            SET processed = true
          WHERE id = ANY($1::int[]) AND to_agent = $2 AND processed = false
        RETURNING id`,
        [ids, agent],
      );
      return {
        success: true,
        agent,
        requested: ids.length,
        updated: rows.length,
        acked: rows.length,
        unacked_count: await zaehleUnquittiert(agent),
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET .../items — ersetzt pollSynapseItems (vier Abfragen in einem Aufruf). */
  fastify.get<{ Params: { name: string; specName: string } }>(
    `${BASIS}/items`,
    async (request, reply) => {
      const { name: project, specName: agent } = request.params;
      zaehler.items += 1;
      try {
        const items = await leseItems(project, agent);
        return {
          success: true,
          project,
          agent,
          items,
          counts: {
            memories: items.memories.length,
            thoughts: items.thoughts.length,
            tasks: items.tasks.length,
            events: items.events.length,
            total:
              items.memories.length + items.thoughts.length + items.tasks.length + items.events.length,
          },
        };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );

  /**
   * POST .../status — ersetzt upsertWrapperStatus (beide Aufrufstellen).
   * Nimmt camelCase UND snake_case an. agentName/project im Rumpf werden ignoriert,
   * der Pfad gewinnt.
   *
   * ⚠️ heartbeat_enabled und heartbeat_interval_ms werden hier NICHT geschrieben —
   * upsertWrapperStatus fasst diese beiden Spalten gar nicht an (nachgelesen in
   * core/src/services/wrapper-status.ts:86-140, sie stehen weder im INSERT noch im
   * UPDATE SET). Ein Statusschreiben kann einen abgeschalteten Wrapper also nicht
   * versehentlich wieder einschalten. Geaendert wird der Takt allein ueber
   * setzeHeartbeatKonfiguration (steuereHeartbeat).
   */
  fastify.post<{
    Params: { name: string; specName: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/status`, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    const body = (request.body ?? {}) as Record<string, unknown>;
    zaehler.statusWrites += 1;

    const statusRoh = feld(body, 'status');
    if (statusRoh !== undefined && !istStatusWert(statusRoh)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_status',
          message: `status muss einer von ${ERLAUBTE_STATUS.join(', ')} sein (bekommen: ${String(statusRoh)})`,
        },
      });
    }

    const tokens = (feld(body, 'tokens') ?? {}) as Record<string, unknown>;
    const kanaeleRoh = feld(body, 'channels');
    const kanaele = Array.isArray(kanaeleRoh)
      ? kanaeleRoh.filter((c): c is string => typeof c === 'string')
      : null;

    try {
      await upsertWrapperStatus({
        agentName: agent,
        project,
        wrapperPid: alsZahl(feld(body, 'wrapperPid', 'wrapper_pid')),
        innerPid: alsZahl(feld(body, 'innerPid', 'inner_pid')),
        socketPath: alsText(feld(body, 'socketPath', 'socket_path')),
        model: alsText(feld(body, 'model')),
        modelFullId: alsText(feld(body, 'modelFullId', 'model_full_id')),
        provider: alsText(feld(body, 'provider')),
        status: istStatusWert(statusRoh) ? statusRoh : undefined,
        busy: alsBool(feld(body, 'busy')) ?? undefined,
        currentTask: alsText(feld(body, 'currentTask', 'current_task')),
        contextCeiling: alsZahl(feld(body, 'contextCeiling', 'context_ceiling')),
        tokensInput: alsZahl(feld(body, 'tokensInput', 'tokens_input') ?? tokens.input),
        tokensOutput: alsZahl(feld(body, 'tokensOutput', 'tokens_output') ?? tokens.output),
        tokensPercent: alsZahl(feld(body, 'tokensPercent', 'tokens_percent') ?? tokens.percent),
        channels: kanaele ?? undefined,
        connectedMcp: alsBool(feld(body, 'connectedMcp', 'connected_mcp')) ?? undefined,
      });

      // Die Konfiguration gleich mitliefern: damit braucht der Wrapper im Betrieb
      // keinen zweiten Aufruf fuer den Heartbeat-Takt.
      const zeile = await getWrapperStatus(agent, project);
      return {
        success: true,
        project,
        agent,
        config: zeile ? konfigAntwort(zeile) : null,
        stream: stromSicht(project, agent),
        server_time: new Date().toISOString(),
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * POST .../register — Startaufruf: schreibt die erste Statuszeile und liefert in
   * derselben Antwort Konfiguration, Watermarks und Kanalmitgliedschaft. Ersetzt
   * drei Startschritte (initializeWatermarks, initCachedChannels, initiale
   * upsertWrapperStatus) durch einen. Bequemlichkeit, kein Zwang — dieselbe Wirkung
   * hat POST /status gefolgt von GET /config.
   */
  fastify.post<{
    Params: { name: string; specName: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/register`, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    const body = (request.body ?? {}) as Record<string, unknown>;
    zaehler.register += 1;

    const tokens = (feld(body, 'tokens') ?? {}) as Record<string, unknown>;
    const statusRoh = feld(body, 'status');
    const kanaeleRoh = feld(body, 'channels');
    const kanaele = Array.isArray(kanaeleRoh)
      ? kanaeleRoh.filter((c): c is string => typeof c === 'string')
      : null;

    try {
      await upsertWrapperStatus({
        agentName: agent,
        project,
        wrapperPid: alsZahl(feld(body, 'wrapperPid', 'wrapper_pid')),
        innerPid: alsZahl(feld(body, 'innerPid', 'inner_pid')),
        socketPath: alsText(feld(body, 'socketPath', 'socket_path')),
        model: alsText(feld(body, 'model')),
        modelFullId: alsText(feld(body, 'modelFullId', 'model_full_id')),
        provider: alsText(feld(body, 'provider')),
        status: istStatusWert(statusRoh) ? statusRoh : 'running',
        busy: alsBool(feld(body, 'busy')) ?? false,
        contextCeiling: alsZahl(feld(body, 'contextCeiling', 'context_ceiling')),
        tokensInput: alsZahl(feld(body, 'tokensInput', 'tokens_input') ?? tokens.input),
        tokensOutput: alsZahl(feld(body, 'tokensOutput', 'tokens_output') ?? tokens.output),
        tokensPercent: alsZahl(feld(body, 'tokensPercent', 'tokens_percent') ?? tokens.percent),
        channels: kanaele ?? undefined,
        connectedMcp: alsBool(feld(body, 'connectedMcp', 'connected_mcp')) ?? undefined,
      });

      const [zeile, watermarks, channels] = await Promise.all([
        getWrapperStatus(agent, project),
        leseWatermarks(agent),
        leseMitgliedschaften(agent),
      ]);

      return {
        success: true,
        project,
        agent,
        transport: alsText(feld(body, 'transport')) ?? 'api',
        config: zeile ? konfigAntwort(zeile) : null,
        watermarks,
        channels,
        stream: stromSicht(project, agent),
        server_time: new Date().toISOString(),
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * POST .../deregister — Endstatus setzen (stopped/crashed). Die Zeile bleibt
   * bestehen; das Loeschen ist und bleibt Sache von purge (removeWrapperStatus).
   */
  fastify.post<{
    Params: { name: string; specName: string };
    Body: { status?: unknown; reason?: unknown };
  }>(`${BASIS}/deregister`, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    zaehler.deregister += 1;
    const statusRoh = request.body?.status ?? 'stopped';
    if (!istStatusWert(statusRoh) || (statusRoh !== 'stopped' && statusRoh !== 'crashed')) {
      return reply.status(400).send({
        success: false,
        error: { code: 'invalid_status', message: 'status muss "stopped" oder "crashed" sein' },
      });
    }
    try {
      await upsertWrapperStatus({
        agentName: agent,
        project,
        status: statusRoh,
        busy: false,
        currentTask: alsText(request.body?.reason),
      });
      return { success: true, project, agent, status: statusRoh };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * GET .../poll — DER SAMMELENDPUNKT. Alles, was ein Heartbeat-Tick braucht,
   * in EINER Antwort und EINER Runde ueber die Leitung.
   *
   * Query: channel_since_id, inbox_since_id, items=0|1 (Standard 1), limit.
   *
   * Ohne wrapper_status-Zeile gibt es hier KEIN 404 (anders als bei /config):
   * config ist dann null und der Aufrufer behaelt seine letzte Einstellung —
   * aber Nachrichten und Items bekommt er trotzdem. Ein fehlender Statuseintrag
   * darf einen laufenden Agenten nicht von seiner Post abschneiden.
   */
  fastify.get<{
    Params: { name: string; specName: string };
    Querystring: {
      channel_since_id?: string;
      inbox_since_id?: string;
      items?: string;
      limit?: string;
    };
  }>(`${BASIS}/poll`, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    const channelSeit = seitId(request.query.channel_since_id);
    const inboxSeit = seitId(request.query.inbox_since_id);
    const limit = grenze(request.query.limit, 200, 500);
    const mitItems = request.query.items !== '0' && request.query.items !== 'false';
    zaehler.polls += 1;

    try {
      const [zeile, channelAlle, inboxAlle, channels, unacked, items] = await Promise.all([
        getWrapperStatus(agent, project),
        getNewMessagesForAgent(agent, channelSeit, limit + 1),
        getNewInboxMessages(agent, inboxSeit),
        leseMitgliedschaften(agent),
        zaehleUnquittiert(agent),
        mitItems ? leseItems(project, agent) : Promise.resolve(null),
      ]);

      const channelMessages = channelAlle.slice(0, limit);
      const inbox = inboxAlle.slice(0, limit);

      const counts = {
        channel_messages: channelMessages.length,
        inbox: inbox.length,
        memories: items ? items.memories.length : 0,
        thoughts: items ? items.thoughts.length : 0,
        tasks: items ? items.tasks.length : 0,
        events: items ? items.events.length : 0,
      };
      const nichtsDa =
        counts.channel_messages === 0 &&
        counts.inbox === 0 &&
        counts.memories === 0 &&
        counts.thoughts === 0 &&
        counts.tasks === 0 &&
        counts.events === 0;
      if (nichtsDa) zaehler.pollsOhneInhalt += 1;

      return {
        success: true,
        project,
        agent,
        server_time: new Date().toISOString(),
        config: zeile ? konfigAntwort(zeile) : null,
        status: zeile?.status ?? null,
        channels,
        channel_messages: channelMessages,
        inbox,
        unacked_count: unacked,
        items,
        watermarks: {
          channel:
            channelMessages.length > 0
              ? channelMessages[channelMessages.length - 1].id
              : channelSeit,
          inbox: inbox.length > 0 ? inbox[inbox.length - 1].id : inboxSeit,
        },
        truncated: {
          channel_messages: channelAlle.length > channelMessages.length,
          inbox: inboxAlle.length > inbox.length,
        },
        counts,
        stream: stromSicht(project, agent),
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * GET .../stream — SSE, der Ersatz fuer LISTEN/NOTIFY im Wrapper.
   *
   * NUR BESCHLEUNIGER: der Aufrufer pollt weiter. Genau diese Rollenverteilung gilt
   * heute schon (wrapper.ts:249-251) — damit ist ein toter Stream kein Ausfall,
   * sondern nur ein langsamerer Takt.
   *
   * BEARER, KEIN COOKIE: die Ausnahme im Auth-Hook (middleware/auth-hook.ts:102-105)
   * gilt allein fuer /api/projects/:name/events, weil ein Browser-EventSource keinen
   * Header setzen kann. Ein Wrapper in Node kann es — also wird hier normal gegated.
   *
   * Ereignisarten: connected (einmalig), wake, file, hint. Dazu alle 15 Sekunden ein
   * KOMMENTAR-Herzschlag (": heartbeat"), an dem der Aufrufer eine tote von einer
   * bloss stillen Verbindung unterscheiden kann.
   */
  fastify.get<{ Params: { name: string; specName: string } }>(
    `${BASIS}/stream`,
    async (request, reply) => {
      const { name: project, specName: agent } = request.params;
      zaehler.streams += 1;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.sent = true;

      let geschlossen = false;
      const schreibe = (text: string): void => {
        if (geschlossen) return;
        reply.raw.write(text);
      };

      schreibe('retry: 5000\n\n');
      schreibe(`event: connected\ndata: ${JSON.stringify({ project, agent })}\n\n`);

      const abmelden = abonniere(project, agent, (ereignis) => {
        schreibe(`event: ${ereignis.event}\ndata: ${JSON.stringify(ereignis.data)}\n\n`);
      });

      const herzschlag = setInterval(() => {
        schreibe(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, 15_000);

      const aufraeumen = (): void => {
        if (geschlossen) return;
        geschlossen = true;
        clearInterval(herzschlag);
        abmelden();
      };

      request.raw.on('close', aufraeumen);
      request.raw.on('error', aufraeumen);
    },
  );

  /**
   * GET /api/projects/:name/wrapper-bridge/health — Sichtbarkeit.
   * Beantwortet die Frage "woran wuerde ich merken, dass die Bruecke kaputt ist":
   * LISTEN-Zustand, Neuverbindungen, letzter Fehler, offene Abonnenten, Zaehler je
   * Faehigkeit. Ohne diese Zahlen sieht ein toter Stream aus wie ein ruhiger Tag.
   */
  fastify.get<{ Params: { name: string } }>(
    '/api/projects/:name/wrapper-bridge/health',
    async (request) => {
      const { name: project } = request.params;
      return {
        success: true,
        project,
        ...stromGesundheit(project),
        counters: { ...zaehler },
        server_time: new Date().toISOString(),
      };
    },
  );
}
