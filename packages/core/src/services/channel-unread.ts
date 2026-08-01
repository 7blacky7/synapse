import { getPool } from '../db/client.js'

export interface UnreadChannelHint {
  project: string
  channel: string
  count: number
  newestId: number
}

/** Speichert nur tatsaechlich ausgelieferte IDs; der optionale Hook bleibt fail-open. */
export async function recordChannelRead(
  project: string,
  channelName: string,
  agentId: string,
  deliveredMessageIds: number[],
): Promise<boolean> {
  const ids = deliveredMessageIds.filter((id) => Number.isSafeInteger(id) && id >= 0)
  if (!agentId || ids.length === 0) return false
  try {
    const { rowCount } = await getPool().query(
      `UPDATE specialist_channel_members mem
       SET last_read_message_id = GREATEST(mem.last_read_message_id, $4),
           read_initialized_at = COALESCE(mem.read_initialized_at, NOW())
       FROM specialist_channels c
       WHERE c.id = mem.channel_id
         AND c.project = $1 AND c.name = $2 AND mem.agent_name = $3`,
      [project, channelName, agentId, Math.max(...ids)],
    )
    return (rowCount ?? 0) > 0
  } catch (error) {
    console.error('[ChannelUnread] Lesestand konnte nicht gespeichert werden:', error)
    return false
  }
}

/** Zaehlt fremde ungelesene Posts und beansprucht jeden neuesten Stand atomisch einmal. */
export async function claimUnreadChannelHints(agentId: string): Promise<UnreadChannelHint[]> {
  if (!agentId) return []
  try {
    const { rows } = await getPool().query<{
      project: string; channel_name: string; unread_count: number; newest_id: string | number
    }>(
      `WITH unread AS (
         SELECT mem.channel_id, c.project, c.name AS channel_name,
                COUNT(msg.id)::int AS unread_count, MAX(msg.id)::bigint AS newest_id
         FROM specialist_channel_members mem
         JOIN specialist_channels c ON c.id = mem.channel_id
         JOIN specialist_channel_messages msg
           ON msg.channel_id = mem.channel_id
          AND msg.id > mem.last_read_message_id
          AND msg.sender <> mem.agent_name
         WHERE mem.agent_name = $1
         GROUP BY mem.channel_id, c.project, c.name
       ),
       claimed AS (
         UPDATE specialist_channel_members mem
         SET last_notified_message_id = unread.newest_id
         FROM unread
         WHERE mem.channel_id = unread.channel_id AND mem.agent_name = $1
           AND mem.last_notified_message_id IS DISTINCT FROM unread.newest_id
         RETURNING unread.project, unread.channel_name,
                   unread.unread_count, unread.newest_id
       )
       SELECT project, channel_name, unread_count, newest_id
       FROM claimed ORDER BY project, channel_name`,
      [agentId],
    )
    return rows.map((row) => ({
      project: row.project, channel: row.channel_name,
      count: row.unread_count, newestId: Number(row.newest_id),
    }))
  } catch (error) {
    console.error('[ChannelUnread] Ungelesen-Hinweise konnten nicht ermittelt werden:', error)
    return []
  }
}
