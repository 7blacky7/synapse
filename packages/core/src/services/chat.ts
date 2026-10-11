/**
 * MODUL: Agenten-Chat
 * ZWECK: Realtime-Kommunikation zwischen KI-Agenten ueber Broadcast und DMs
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - senderId: string - Agent-ID des Absenders
 *   - content: string - Nachrichteninhalt
 *   - recipientId?: string - NULL = Broadcast, sonst DM
 *
 * OUTPUT:
 *   - ChatMessage: Gespeicherte Nachricht mit ID und Timestamp
 *   - ChatMessage[]: Nachrichten-Verlauf (chronologisch)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Schreibt in chat_messages Tabelle
 *   - Kein Qdrant (Chat ist chronologisch, nicht semantisch)
 *
 * ABHÄNGIGKEITEN:
 *   - ../db/client.js (intern) - PostgreSQL Connection Pool
 */

import { getPool } from '../db/client.js';
import { resolveCutoff } from './model-cutoffs.js';

export interface ChatMessage {
  id: number;
  project: string;
  senderId: string;
  recipientId: string | null;
  content: string;
  timestamp: string;
}

export interface AgentSession {
  id: string;
  project: string;
  model: string | null;
  cutoffDate: string | null;
  status: string;
  /** Erstmals registriert (wird bei Wiederanmeldung NICHT fortgeschrieben). */
  registeredAt: string;
  /** P15-T30: Beginn der laufenden Sitzung (jede Registrierung). Altzeilen: registeredAt. */
  sitzungSeit: string | null;
}

/**
 * Registriert einen Agenten fuer ein Projekt
 * Gibt die Session mit automatisch erkanntem Cutoff zurueck
 */
function normalizeCutoffDate(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  throw new Error(`Ungueltiges cutoff_date "${s}". Erwartet YYYY-MM-DD (oder YYYY-MM, YYYY).`);
}

export async function registerAgent(
  id: string,
  project: string,
  model?: string,
  cutoffDate?: string
): Promise<AgentSession> {
  const pool = getPool();

  // Cutoff datengetrieben (model_cutoffs + model_registry, siehe model-cutoffs.ts).
  // POLITIK: Ist das Modell bekannt, gewinnt der bekannte Cutoff — die
  // Selbstauskunft der Agenten ist nachweislich oft falsch. Die Selbstauskunft
  // zaehlt nur, wenn das Modell unbekannt ist.
  const bekannterCutoff = model ? await resolveCutoff(model) : null;
  let resolvedCutoff: string | null;
  if (bekannterCutoff) {
    resolvedCutoff = bekannterCutoff;
    if (cutoffDate) {
      let selbstauskunft: string;
      try {
        selbstauskunft = normalizeCutoffDate(cutoffDate) ?? cutoffDate;
      } catch {
        selbstauskunft = cutoffDate;
      }
      if (selbstauskunft !== bekannterCutoff) {
        console.error(
          `[Synapse Chat] Cutoff-Selbstauskunft von "${id}" (${model}) weicht ab: gemeldet ${selbstauskunft}, bekannt ${bekannterCutoff} — bekannter Wert gilt`
        );
      }
    }
  } else {
    // Web-KIs schicken oft "YYYY-MM" oder "YYYY" — pad zu "YYYY-MM-DD" damit
    // Postgres DATE nicht mit DateTimeParseError 500'd (war Repro: GPT-5 Web).
    resolvedCutoff = normalizeCutoffDate(cutoffDate);
  }
  const cutoffBekannt = bekannterCutoff !== null;

  // Bekannter Cutoff ueberschreibt einen alten gespeicherten Wert; eine
  // Selbstauskunft fuellt nur, was noch fehlt oder ersetzt eine fruehere.
  // P15-T30: registered_at bleibt "erstmals". sitzung_seit = jede Registrierung (neue Sitzung).
  // aktiv_seit nur neu, wenn der Agent vorher nicht 'active' war (abgemeldet, purged, vom Reaper
  // stillgelegt) - ein Handoff/eine Rotation behaelt ihn, damit unquittierte Events nicht verloren gehen.
  // Im SET sieht agent_sessions.status noch den ALTEN Wert.
  const zeit = await pool.query<{ registered_at: Date; sitzung_seit: Date }>(
    `INSERT INTO agent_sessions (id, project, model, cutoff_date, status, registered_at, sitzung_seit, aktiv_seit)
     VALUES ($1, $2, $3, $4, 'active', NOW(), NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET status = 'active', model = COALESCE($3, agent_sessions.model),
       cutoff_date = CASE WHEN $5::boolean THEN $4::date ELSE COALESCE($4::date, agent_sessions.cutoff_date) END,
       sitzung_seit = NOW(),
       aktiv_seit = CASE WHEN agent_sessions.status IS DISTINCT FROM 'active' THEN NOW()
                         ELSE COALESCE(agent_sessions.aktiv_seit, agent_sessions.registered_at, NOW()) END
     RETURNING registered_at, sitzung_seit`,
    [id, project, model || null, resolvedCutoff, cutoffBekannt]
  );
  const jetzt = new Date();
  const registriert = zeit.rows[0]?.registered_at ?? jetzt;
  const sitzung = zeit.rows[0]?.sitzung_seit ?? jetzt;

  console.error(`[Synapse Chat] Agent "${id}" registriert fuer Projekt "${project}"${model ? ` (${model})` : ''}`);

  return {
    id,
    project,
    model: model || null,
    cutoffDate: resolvedCutoff,
    status: 'active',
    registeredAt: new Date(registriert).toISOString(),
    sitzungSeit: new Date(sitzung).toISOString(),
  };
}

/**
 * Registriert mehrere Agenten auf einmal
 */
export async function registerAgentsBatch(
  agents: Array<{ id: string; model?: string; cutoffDate?: string }>,
  project: string
): Promise<AgentSession[]> {
  const results: AgentSession[] = [];
  for (const agent of agents) {
    const session = await registerAgent(agent.id, project, agent.model, agent.cutoffDate);
    results.push(session);
  }
  console.error(`[Synapse Chat] ${results.length} Agenten batch-registriert fuer "${project}"`);
  return results;
}

/**
 * Meldet mehrere Agenten auf einmal ab
 */
export async function unregisterAgentsBatch(ids: string[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_sessions SET status = 'inactive' WHERE id = ANY($1)`,
    [ids]
  );
  console.error(`[Synapse Chat] ${ids.length} Agenten batch-abgemeldet: ${ids.join(', ')}`);
}

/**
 * Meldet einen Agenten ab
 */
export async function unregisterAgent(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_sessions SET status = 'inactive' WHERE id = $1`,
    [id]
  );
  console.error(`[Synapse Chat] Agent "${id}" abgemeldet`);
}

/**
 * Meldet Sessions ab, die seit einer Frist kein Lebenszeichen mehr zeigen.
 *
 * Hintergrund: der Status wechselte nur durch ausdrueckliches Abmelden auf
 * 'inactive'. Wer gepurgt wurde, abgestuerzt ist oder einfach verschwand, blieb
 * dauerhaft 'active' — am 2026-07-26 standen so 28 Eintraege in der Liste, der
 * aelteste vom 15. Maerz, ohne einen einzigen lebenden Prozess dahinter.
 * 'active' war damit kein Lebenszeichen, sondern nur "hat sich mal angemeldet".
 *
 * Als Lebenszeichen gilt, was Aktivitaet wirklich belegt:
 *   - der letzte Tool-Aufruf des Agenten (tool_calls.ts)
 *   - der Heartbeat seines Wrappers (wrapper_status.last_activity) — dadurch
 *     bleibt ein Spezialist verschont, der lebt und nur gerade wartet
 *   - die Anmeldung selbst, fuer Agenten die noch nichts getan haben. P15-T30: die LETZTE
 *     Anmeldung (sitzung_seit) - mit registered_at (erstmals) wurde ein wieder angemeldeter
 *     Agent ohne Tool-Aufruf beim naechsten Lauf sofort wieder stillgelegt.
 *
 * Es wird ausschliesslich der Status gesetzt, nichts geloescht: eine neue
 * Anmeldung holt die Session sofort zurueck.
 */
export async function expireIdleAgentSessions(stunden?: number): Promise<number> {
  const ausUmgebung = Number(process.env.SYNAPSE_SESSION_IDLE_HOURS);
  const frist = stunden ?? (Number.isFinite(ausUmgebung) && ausUmgebung > 0 ? ausUmgebung : 4);
  const pool = getPool();
  const ergebnis = await pool.query<{ id: string }>(
    `UPDATE agent_sessions s
        SET status = 'inactive'
      WHERE s.status = 'active'
        AND GREATEST(
              COALESCE(s.sitzung_seit, s.registered_at),
              COALESCE((SELECT MAX(t.ts) FROM tool_calls t WHERE t.agent_id = s.id), s.sitzung_seit, s.registered_at),
              COALESCE((SELECT MAX(w.last_activity) FROM wrapper_status w WHERE w.agent_name = s.id), s.sitzung_seit, s.registered_at)
            ) < NOW() - (($1::numeric) * INTERVAL '1 hour')
      RETURNING s.id`,
    [frist]
  );
  const anzahl = ergebnis.rowCount ?? 0;
  if (anzahl > 0) {
    const namen = ergebnis.rows.map((zeile) => zeile.id).join(', ');
    console.error(`[Synapse Chat] ${anzahl} Session(s) ohne Lebenszeichen seit ${frist}h abgemeldet: ${namen}`);
  }
  return anzahl;
}

/**
 * Holt die Session eines Agenten
 */
export async function getAgentSession(id: string): Promise<AgentSession | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, project, model, cutoff_date, status, registered_at,
            COALESCE(sitzung_seit, registered_at) AS sitzung_seit
       FROM agent_sessions WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    project: row.project,
    model: row.model,
    cutoffDate: row.cutoff_date,
    status: row.status,
    registeredAt: row.registered_at,
    sitzungSeit: row.sitzung_seit ?? null,
  };
}

/**
 * Listet aktive Agenten eines Projekts
 */
export async function listActiveAgents(project: string): Promise<AgentSession[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, project, model, cutoff_date, status, registered_at,
            COALESCE(sitzung_seit, registered_at) AS sitzung_seit
     FROM agent_sessions WHERE project = $1 AND status = 'active'
     ORDER BY COALESCE(sitzung_seit, registered_at) DESC`,
    [project]
  );

  return result.rows.map(row => ({
    id: row.id,
    project: row.project,
    model: row.model,
    cutoffDate: row.cutoff_date,
    status: row.status,
    registeredAt: row.registered_at,
    sitzungSeit: row.sitzung_seit ?? null,
  }));
}

/**
 * Sendet eine Nachricht (Broadcast oder DM)
 * recipientId = null → Broadcast an alle im Projekt
 * recipientId = "agent-id" → DM an bestimmten Agenten
 */
export async function sendMessage(
  project: string,
  senderId: string,
  content: string,
  recipientId?: string
): Promise<ChatMessage> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO chat_messages (project, sender_id, recipient_id, content, timestamp)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, project, sender_id, recipient_id, content, timestamp`,
    [project, senderId, recipientId || null, content]
  );

  const row = result.rows[0];
  const msg: ChatMessage = {
    id: row.id,
    project: row.project,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    timestamp: row.timestamp,
  };

  const target = recipientId ? `DM an ${recipientId}` : 'Broadcast';
  console.error(`[Synapse Chat] ${senderId} → ${target}: ${content.substring(0, 80)}...`);
  return msg;
}

/**
 * Holt Nachrichten (mit optionalem since-Filter fuer Polling)
 * Gibt Broadcast-Nachrichten + DMs an den anfragenden Agenten zurueck
 */
export async function getMessages(
  project: string,
  options: {
    since?: string;
    senderId?: string;
    agentId?: string;
    limit?: number;
  } = {}
): Promise<ChatMessage[]> {
  const { since, senderId, agentId, limit = 50 } = options;
  const pool = getPool();

  let query = `SELECT id, project, sender_id, recipient_id, content, timestamp
               FROM chat_messages WHERE project = $1`;
  const params: unknown[] = [project];
  let paramIdx = 2;

  // Nur Broadcasts + DMs an diesen Agenten
  if (agentId) {
    query += ` AND (recipient_id IS NULL OR recipient_id = $${paramIdx} OR sender_id = $${paramIdx})`;
    params.push(agentId);
    paramIdx++;
  }

  if (since) {
    query += ` AND timestamp > $${paramIdx}`;
    params.push(since);
    paramIdx++;
  }

  if (senderId) {
    query += ` AND sender_id = $${paramIdx}`;
    params.push(senderId);
    paramIdx++;
  }

  query += ` ORDER BY timestamp ASC LIMIT $${paramIdx}`;
  params.push(limit);

  const result = await pool.query(query, params);

  return result.rows.map(row => ({
    id: row.id,
    project: row.project,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    timestamp: row.timestamp,
  }));
}
