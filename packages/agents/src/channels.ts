import { getPool } from '@synapse/core'
import type { ChannelMessage } from './types.js'

export async function createChannel(
  project: string,
  name: string,
  description: string | null,
  createdBy: string,
): Promise<{ id: number; name: string; project: string }> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: number; name: string; project: string }>(
    `INSERT INTO specialist_channels (name, project, description, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
     RETURNING id, name, project`,
    [name, project, description, createdBy],
  )
  return rows[0]
}

export async function deleteChannel(name: string): Promise<boolean> {
  const pool = getPool()
  const { rows } = await pool.query(
    `DELETE FROM specialist_channels WHERE name = $1 RETURNING id`,
    [name],
  )
  return rows.length > 0
}

export async function joinChannel(channelName: string, agentName: string): Promise<boolean> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM specialist_channels WHERE name = $1`,
    [channelName],
  )
  if (rows.length === 0) return false

  const channelId = rows[0].id
  await pool.query(
    `INSERT INTO specialist_channel_members (channel_id, agent_name)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [channelId, agentName],
  )
  return true
}

export async function leaveChannel(channelName: string, agentName: string): Promise<boolean> {
  const pool = getPool()
  const { rows: channelRows } = await pool.query<{ id: number }>(
    `SELECT id FROM specialist_channels WHERE name = $1`,
    [channelName],
  )
  if (channelRows.length === 0) return false

  const channelId = channelRows[0].id
  const { rows } = await pool.query(
    `DELETE FROM specialist_channel_members
     WHERE channel_id = $1 AND agent_name = $2
     RETURNING agent_name`,
    [channelId, agentName],
  )
  return rows.length > 0
}

export async function postMessage(
  channelName: string,
  sender: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<{ id: number; createdAt: Date } | null> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: number; created_at: Date }>(
    `INSERT INTO specialist_channel_messages (channel_id, sender, content, metadata)
     SELECT c.id, $2, $3, $4
     FROM specialist_channels c WHERE c.name = $1
     RETURNING id, created_at`,
    [channelName, sender, content, metadata ? JSON.stringify(metadata) : null],
  )
  if (rows.length === 0) return null
  return { id: rows[0].id, createdAt: rows[0].created_at }
}

export async function getMessages(
  channelName: string,
  opts?: { limit?: number; sinceId?: number; preview?: boolean },
): Promise<ChannelMessage[]> {
  const pool = getPool()
  const limit = opts?.limit ?? 20
  const sinceId = opts?.sinceId ?? 0

  const { rows } = await pool.query<{
    id: number
    channel_name: string
    sender: string
    content: string
    metadata: Record<string, unknown> | null
    created_at: Date
  }>(
    `SELECT cm.id, c.name AS channel_name, cm.sender, cm.content, cm.metadata, cm.created_at
     FROM specialist_channel_messages cm
     JOIN specialist_channels c ON c.id = cm.channel_id
     WHERE c.name = $1
       AND cm.id > $2
     ORDER BY cm.created_at DESC
     LIMIT $3`,
    [channelName, sinceId, limit],
  )

  // Reverse to chronological order (oldest first)
  rows.reverse()

  return rows.map((r) => ({
    id: r.id,
    channelName: r.channel_name,
    sender: r.sender,
    content:
      opts?.preview && r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content,
    metadata: r.metadata ?? undefined,
    createdAt: r.created_at,
  }))
}

export async function getChannelMembers(channelName: string): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query<{ agent_name: string }>(
    `SELECT cm.agent_name
     FROM specialist_channel_members cm
     JOIN specialist_channels c ON c.id = cm.channel_id
     WHERE c.name = $1
     ORDER BY cm.joined_at`,
    [channelName],
  )
  return rows.map((r) => r.agent_name)
}

export async function listChannels(
  project?: string,
): Promise<Array<{ name: string; project: string; description: string | null }>> {
  const pool = getPool()
  if (project) {
    const { rows } = await pool.query<{
      name: string
      project: string
      description: string | null
    }>(
      `SELECT name, project, description
       FROM specialist_channels
       WHERE project = $1
       ORDER BY name`,
      [project],
    )
    return rows
  }
  const { rows } = await pool.query<{ name: string; project: string; description: string | null }>(
    `SELECT name, project, description
     FROM specialist_channels
     ORDER BY project, name`,
  )
  return rows
}

export async function getNewMessagesForAgent(
  agentName: string,
  sinceId: number,
): Promise<ChannelMessage[]> {
  const pool = getPool()
  const { rows } = await pool.query<{
    id: number
    channel_name: string
    sender: string
    content: string
    metadata: Record<string, unknown> | null
    created_at: Date
  }>(
    `SELECT cm.id, c.name AS channel_name, cm.sender, cm.content, cm.metadata, cm.created_at
     FROM specialist_channel_messages cm
     JOIN specialist_channels c ON c.id = cm.channel_id
     JOIN specialist_channel_members mem ON mem.channel_id = c.id
     WHERE mem.agent_name = $1
       AND cm.sender != $1
       AND cm.id > $2
     ORDER BY cm.id
     LIMIT 10`,
    [agentName, sinceId],
  )
  return rows.map((r) => ({
    id: r.id,
    channelName: r.channel_name,
    sender: r.sender,
    content: r.content,
    metadata: r.metadata ?? undefined,
    createdAt: r.created_at,
  }))
}

export async function ensureGeneralChannel(
  project: string,
  createdBy: string,
  agentName?: string,
): Promise<void> {
  const channelName = `${project}-general`
  await createChannel(project, channelName, `General channel for ${project}`, createdBy)
  if (agentName) {
    await joinChannel(channelName, agentName)
  }
}
