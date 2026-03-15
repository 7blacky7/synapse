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
 */

import { getPool } from '../db/client.js';

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
  registeredAt: string;
}

/** Bekannte Modell-Cutoffs (hardcoded) */
const MODEL_CUTOFFS: Record<string, string> = {
  'claude-opus-4-6': '2025-05-01',
  'claude-sonnet-4-6': '2025-05-01',
  'claude-haiku-4-5': '2025-03-01',
  'claude-opus-4-20250514': '2025-03-01',
  'claude-sonnet-4-20250514': '2025-03-01',
  'gpt-4o': '2024-10-01',
  'gpt-4o-mini': '2024-10-01',
  'gpt-4-turbo': '2024-04-01',
  'gemini-2.0-flash': '2025-01-01',
  'gemini-2.0-pro': '2025-01-01',
};

/**
 * Registriert einen Agenten fuer ein Projekt
 * Gibt die Session mit automatisch erkanntem Cutoff zurueck
 */
export async function registerAgent(
  id: string,
  project: string,
  model?: string,
  cutoffDate?: string
): Promise<AgentSession> {
  const pool = getPool();

  // Cutoff automatisch ermitteln wenn nicht angegeben
  // Prefix-Match: "claude-haiku-4-5-20251001" → "claude-haiku-4-5"
  const matchedCutoff = model
    ? MODEL_CUTOFFS[model] || Object.entries(MODEL_CUTOFFS).find(([key]) => model.startsWith(key))?.[1] || null
    : null;
  const resolvedCutoff = cutoffDate || matchedCutoff;

  await pool.query(
    `INSERT INTO agent_sessions (id, project, model, cutoff_date, status, registered_at)
     VALUES ($1, $2, $3, $4, 'active', NOW())
     ON CONFLICT (id) DO UPDATE SET status = 'active', model = COALESCE($3, agent_sessions.model), cutoff_date = COALESCE($4, agent_sessions.cutoff_date)`,
    [id, project, model || null, resolvedCutoff]
  );

  console.error(`[Synapse Chat] Agent "${id}" registriert fuer Projekt "${project}"${model ? ` (${model})` : ''}`);

  return {
    id,
    project,
    model: model || null,
    cutoffDate: resolvedCutoff,
    status: 'active',
    registeredAt: new Date().toISOString(),
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
 * Holt die Session eines Agenten
 */
export async function getAgentSession(id: string): Promise<AgentSession | null> {
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, project, model, cutoff_date, status, registered_at FROM agent_sessions WHERE id = $1',
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
  };
}

/**
 * Listet aktive Agenten eines Projekts
 */
export async function listActiveAgents(project: string): Promise<AgentSession[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, project, model, cutoff_date, status, registered_at
     FROM agent_sessions WHERE project = $1 AND status = 'active'
     ORDER BY registered_at DESC`,
    [project]
  );

  return result.rows.map(row => ({
    id: row.id,
    project: row.project,
    model: row.model,
    cutoffDate: row.cutoff_date,
    status: row.status,
    registeredAt: row.registered_at,
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
