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

export async function postToInbox(fromAgent: string, toAgent: string, content: string, project: string): Promise<{ id: number; createdAt: Date }> {
  const result = await getPool().query(
    `INSERT INTO specialist_inbox (from_agent, to_agent, content, project) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [fromAgent, toAgent, content, project],
  )
  const row = result.rows[0]
  return { id: row.id as number, createdAt: row.created_at as Date }
}

export async function checkInbox(agentName: string, project: string): Promise<InboxMessage[]> {
  const result = await getPool().query(
    `UPDATE specialist_inbox SET processed = true WHERE to_agent = $1 AND project = $2 AND processed = false RETURNING id, from_agent, to_agent, content, processed, created_at`,
    [agentName, project],
  )
  return result.rows.map(mapRow)
}

export async function getNewInboxMessages(agentName: string, sinceId: number, project: string): Promise<InboxMessage[]> {
  const result = await getPool().query(
    `SELECT id, from_agent, to_agent, content, processed, created_at FROM specialist_inbox WHERE to_agent = $1 AND project = $3 AND processed = false AND id > $2 ORDER BY id ASC`,
    [agentName, sinceId, project],
  )
  return result.rows.map(mapRow)
}

export async function getInboxHistory(agentName: string, project: string, limit = 50): Promise<InboxMessage[]> {
  const result = await getPool().query(
    `SELECT id, from_agent, to_agent, content, processed, created_at FROM specialist_inbox WHERE to_agent = $1 AND project = $2 ORDER BY id DESC LIMIT $3`,
    [agentName, project, limit],
  )
  return result.rows.map(mapRow)
}

export async function removeInboxForAgent(agentName: string, project: string): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM specialist_inbox WHERE to_agent = $1 AND project = $2 RETURNING id`,
    [agentName, project],
  )
  return result.rowCount ?? result.rows.length
}
