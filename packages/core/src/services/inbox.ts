import { getPool } from '../db/client.js'
import type { InboxMessage } from '../types/index.js'

function mapRow(row: Record<string, unknown>): InboxMessage {
  return {
    id: row.id as number,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    content: row.content as string,
    processed: row.processed as boolean,
    createdAt: row.created_at as Date,
  }
}

// Post a message to another agent's inbox
export async function postToInbox(
  fromAgent: string,
  toAgent: string,
  content: string,
): Promise<{ id: number; createdAt: Date }> {
  const pool = getPool()
  const result = await pool.query(
    `INSERT INTO specialist_inbox (from_agent, to_agent, content)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [fromAgent, toAgent, content],
  )
  const row = result.rows[0]
  return { id: row.id as number, createdAt: row.created_at as Date }
}

// Check and mark as read all unprocessed messages for an agent (UPDATE...RETURNING)
export async function checkInbox(agentName: string): Promise<InboxMessage[]> {
  const pool = getPool()
  const result = await pool.query(
    `UPDATE specialist_inbox
     SET processed = true
     WHERE to_agent = $1 AND processed = false
     RETURNING id, from_agent, to_agent, content, processed, created_at`,
    [agentName],
  )
  return result.rows.map(mapRow)
}

// Get new unprocessed messages since a given ID (for heartbeat polling, does NOT mark as read)
export async function getNewInboxMessages(agentName: string, sinceId: number): Promise<InboxMessage[]> {
  const pool = getPool()
  const result = await pool.query(
    `SELECT id, from_agent, to_agent, content, processed, created_at
     FROM specialist_inbox
     WHERE to_agent = $1 AND processed = false AND id > $2
     ORDER BY id ASC`,
    [agentName, sinceId],
  )
  return result.rows.map(mapRow)
}

// Get inbox history (all messages, including processed)
export async function getInboxHistory(agentName: string, limit = 50): Promise<InboxMessage[]> {
  const pool = getPool()
  const result = await pool.query(
    `SELECT id, from_agent, to_agent, content, processed, created_at
     FROM specialist_inbox
     WHERE to_agent = $1
     ORDER BY id DESC
     LIMIT $2`,
    [agentName, limit],
  )
  return result.rows.map(mapRow)
}
