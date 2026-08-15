/**
 * Synapse API - Tray Routes (TRAY-1)
 *
 * ZWECK: Read-only Endpunkte fuer den Go-Tray (packages/file-watcher-daemon/tray).
 * Der Tray hielt bisher eine EIGENE PG-Verbindung mit hartcodierter IP
 * ("postgres://synapse@192.168.50.65:5432/synapse", tray.go:309) und setzte vier
 * SELECTs direkt ab. Damit haengt er an der DB statt an der API: keine Auth,
 * kein Fallback, IP fest im Binary.
 *
 * Diese Routen bilden exakt diese vier Abfragen ab — 1:1 dieselben Spalten und
 * Sortierungen, damit die Go-Seite ohne Verhaltensaenderung umgestellt werden kann.
 *
 * Alle Routen liegen unter /api/* — der globale Auth-Hook (registerAuthHook,
 * AUTH-4) gated sie per Bearer-Token. Bis auf /reembed (REEMBED-2) sind sie
 * read-only.
 */

import { FastifyInstance } from 'fastify';
import { getPool, resetProjectEmbeddings, reparseProject } from '@synapse/core';

/** Obergrenze fuer alle Listen-Endpunkte — schuetzt vor versehentlichen Vollscans. */
const MAX_LIMIT = 500;

function clampLimit(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export async function trayRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects/:name/agents
   * Wrapper-/Agenten-Status je Projekt. Ersetzt tray.go:1070.
   */
  fastify.get<{ Params: { name: string } }>(
    '/api/projects/:name/agents',
    async (request) => {
      const { name } = request.params;
      const { rows } = await getPool().query(
        `SELECT agent_name,
                COALESCE(model, '')                     AS model,
                status,
                COALESCE(tokens_percent::text, '0')     AS tokens_percent,
                COALESCE(last_activity::text, '')       AS last_activity
           FROM wrapper_status
          WHERE project = $1
          ORDER BY last_activity DESC NULLS LAST`,
        [name]
      );
      return { success: true, project: name, count: rows.length, agents: rows };
    }
  );

  // HINWEIS: GET /api/projects/:name/file-versions gibt es NICHT hier — die Route
  // existiert bereits in routes/specialists.ts und liefert sogar mehr Felder
  // (id, batch_id, content_hash, agent_note, ...). Eine zweite Deklaration liess
  // Fastify beim Start mit FST_ERR_DUPLICATED_ROUTE abstuerzen. Der Tray nutzt
  // die bestehende Route; api_client.go ist auf deren Antwortform angepasst.

  /**
   * GET /api/projects/:name/sessions
   * Aktive Agent-Sessions. Ersetzt tray.go:1381.
   */
  fastify.get<{ Params: { name: string } }>(
    '/api/projects/:name/sessions',
    async (request) => {
      const { name } = request.params;
      const { rows } = await getPool().query(
        `SELECT id,
                COALESCE(model, '') AS model
           FROM agent_sessions
          WHERE project = $1 AND status = 'active'
          ORDER BY id`,
        [name]
      );
      return { success: true, project: name, count: rows.length, sessions: rows };
    }
  );

  /**
   * GET /api/projects/:name/channels/:channel/messages?since_id=&limit=50
   * Channel-Feed. Ersetzt tray.go:1314/1317 (beide Varianten).
   *
   * OHNE since_id: die letzten N Nachrichten, absteigend (Erst-Laden).
   * MIT  since_id: alles NEUERE aufsteigend (Polling) — identisch zur alten
   * Abfrage, damit der Tray seine Reihenfolge-Logik unveraendert behalten kann.
   */
  fastify.get<{
    Params: { name: string; channel: string };
    Querystring: { since_id?: string; limit?: string };
  }>(
    '/api/projects/:name/channels/:channel/messages',
    async (request) => {
      const { name, channel } = request.params;
      const limit = clampLimit(request.query.limit, 50);
      const sinceRaw = request.query.since_id;
      const sinceId = sinceRaw !== undefined && sinceRaw !== '' ? Number(sinceRaw) : null;

      if (sinceId !== null && !Number.isFinite(sinceId)) {
        return { success: false, error: 'invalid_since_id', message: 'since_id muss numerisch sein.' };
      }

      const { rows } =
        sinceId === null
          ? await getPool().query(
              `SELECT m.id,
                      m.sender,
                      m.content,
                      to_char(m.created_at, 'DD.MM. HH24:MI:SS') AS created_at
                 FROM specialist_channel_messages m
                 JOIN specialist_channels c ON c.id = m.channel_id
                WHERE c.project = $1 AND c.name = $2
                ORDER BY m.id DESC
                LIMIT $3`,
              [name, channel, limit]
            )
          : await getPool().query(
              `SELECT m.id,
                      m.sender,
                      m.content,
                      to_char(m.created_at, 'DD.MM. HH24:MI:SS') AS created_at
                 FROM specialist_channel_messages m
                 JOIN specialist_channels c ON c.id = m.channel_id
                WHERE c.project = $1 AND c.name = $2 AND m.id > $3
                ORDER BY m.id
                LIMIT $4`,
              [name, channel, sinceId, limit]
            );

      return {
        success: true,
        project: name,
        channel,
        since_id: sinceId,
        // Reihenfolge explizit ausweisen: der Client muss beim Erst-Laden umdrehen.
        order: sinceId === null ? 'desc' : 'asc',
        count: rows.length,
        messages: rows,
      };
    }
  );

  /**
   * GET /api/projects/:name/channels/:channel/members  (CH-2, 15.08.2026)
   *
   * Die Teilnehmer EINES Channels — fuer die Liste neben dem Chat-Fenster im Tray.
   * Bis hierher zeigte der Tray dort die aktiven Agenten des PROJEKTS: inhaltlich korrekt
   * (die Ueberschrift sagt es auch), aber die falsche Antwort auf die Frage, die der Ort
   * stellt — neben #channel will man wissen, wer HIER mitredet. Einen Endpunkt dafuer gab es
   * nicht, deshalb dieser.
   *
   * Geliefert werden Mitglieder UND Nur-Poster, getrennt ausgewiesen: channel(post) verlangt
   * kein join, ein Schreiber ist also nicht zwingend Mitglied. Wer nur gepostet hat, bekommt
   * KEINE Hinweise auf neue Nachrichten — deshalb ist die Unterscheidung mehr als Kosmetik.
   */
  fastify.get<{ Params: { name: string; channel: string } }>(
    '/api/projects/:name/channels/:channel/members',
    async (request) => {
      const { name, channel } = request.params;
      const { holeChannelTeilnehmer } = await import('@synapse/core');
      const teilnehmer = await holeChannelTeilnehmer(name, channel);
      return {
        success: true,
        project: name,
        channel,
        count: teilnehmer.length,
        members: teilnehmer,
      };
    }
  );

  /**
   * POST /api/projects/:name/reparse  (REPARSE-2)
   *
   * Erzeugt Symbole, Statements und Call-Kanten neu — OHNE die Embeddings
   * anzufassen. Fuer den Fall, dass ein Parser besser geworden ist: der
   * Dateiinhalt hat sich nicht geaendert, die Chunks und Vektoren bleiben
   * gueltig, nur die abgeleiteten Symbole sind veraltet.
   *
   * ABGRENZUNG, damit niemand den teuren Weg waehlt:
   *   reindex  verwirft Parse UND Embeddings (kostet Rechenzeit und Geld)
   *   reembed  verwirft nur die Vektoren (nach einem Modellwechsel)
   *   reparse  erzeugt nur die Symbole neu (dieser Endpunkt)
   *
   * Body optional: { extensions: ["cpp","hpp"], nur_veraltete: true }.
   * nur_veraltete nimmt auch Dateien mit parser_version NULL mit — anders als
   * der Backlog, denn hier hat jemand den Reparse ausdruecklich angefordert.
   *
   * Antwortet SOFORT, der Lauf geht im Hintergrund weiter.
   */
  fastify.post<{
    Params: { name: string };
    Body?: { extensions?: string[]; nur_veraltete?: boolean };
  }>(
    '/api/projects/:name/reparse',
    async (request, reply) => {
      const { name } = request.params;
      const { rows } = await getPool().query(
        'SELECT 1 FROM projects WHERE name = $1',
        [name]
      );
      if (rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: 'project_not_found',
          message: `Projekt "${name}" ist nicht registriert.`,
        });
      }

      const extensions = request.body?.extensions;
      const nurVeraltete = request.body?.nur_veraltete === true;

      void reparseProject(name, { extensions, nurVeraltete }).catch((err) => {
        request.log.error({ err }, 'reparse abgebrochen');
      });

      return {
        success: true,
        project: name,
        message:
          `Reparse fuer "${name}" gestartet` +
          (extensions?.length ? ` (nur ${extensions.join(', ')})` : '') +
          (nurVeraltete ? ', nur veraltete Parse-Staende' : '') +
          '. Symbole werden neu erzeugt, die Embeddings bleiben unangetastet. ' +
          'Der Lauf geht im Hintergrund weiter.',
      };
    }
  );

  /**
   * POST /api/projects/:name/reembed  (REEMBED-2)
   *
   * Nach einem Embedding-MODELLWECHSEL: verwirft die Qdrant-Code-Collection des
   * Projekts, legt sie mit der aktuellen Modell-Dimension neu an und setzt die
   * Embedding-Marker zurueck. Der Backlog embedded danach im Hintergrund nach.
   *
   * PostgreSQL bleibt inhaltlich unangetastet — weder Content noch Symbole,
   * Chunks oder Versionen werden beruehrt. Zurueckgesetzt werden ausschliesslich
   * code_chunks.embedded_at und code_files.indexed_at; ohne das wuerde der
   * Idempotenz-Skip in parseAndEmbed jede Datei sofort wieder ueberspringen.
   *
   * Antwortet SOFORT — das Neu-Embedden laeuft asynchron ueber den Backlog und
   * kann je nach Projektgroesse und Modell lange dauern. Fortschritt im Log bzw.
   * ueber die sinkende Zahl unembeddeter Chunks.
   */
  fastify.post<{ Params: { name: string } }>(
    '/api/projects/:name/reembed',
    async (request, reply) => {
      const { name } = request.params;

      // Existenz pruefen, damit ein Tippfehler nicht stillschweigend eine leere
      // Collection anlegt.
      const { rows } = await getPool().query(
        'SELECT 1 FROM projects WHERE name = $1',
        [name]
      );
      if (rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: 'project_not_found',
          message: `Projekt "${name}" ist nicht registriert.`,
        });
      }

      try {
        const result = await resetProjectEmbeddings(name);
        return {
          success: true,
          ...result,
          message:
            `Embeddings fuer "${name}" zurueckgesetzt (${result.chunksReset} Chunks, ` +
            `${result.filesReset} Dateien). Qdrant-Collection neu angelegt` +
            (result.vectorSizeBefore !== result.vectorSizeAfter
              ? ` (Dimension ${result.vectorSizeBefore ?? '?'} -> ${result.vectorSizeAfter ?? '?'})`
              : '') +
            '. PostgreSQL-Inhalte unveraendert. Das Neu-Embedden laeuft im Hintergrund.',
        };
      } catch (err) {
        request.log.error({ err }, 'reembed fehlgeschlagen');
        return reply.code(500).send({
          success: false,
          error: 'reembed_failed',
          message: String(err),
        });
      }
    }
  );
}
