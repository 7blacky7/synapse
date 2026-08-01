import { getPool } from '../db/client.js'

export interface UnreadChannelHint {
  project: string
  channel: string
  count: number
  newestId: number
  /** true, sobald count die Navigationsschwelle erreicht (siehe NAVIGATIONSSCHWELLE). */
  navigateByIdOnly?: boolean
}

/**
 * Ab dieser Zahl ungelesener Nachrichten wird nicht mehr pauschal nachgeliefert.
 *
 * Wer 100 ungelesene Nachrichten hat, braucht nicht die von heute frueh — er braucht die
 * letzten. Der Hinweis meldet deshalb ab hier ausdruecklich, dass gezielt ueber since_id
 * gelesen werden soll, statt einen Feed-Abruf ins Uferlose laufen zu lassen.
 * Vorgabe des Users vom 01.08.2026.
 */
export const NAVIGATIONSSCHWELLE = 25

/**
 * Setzt den Lesestand auf den aktuellen Stand des Channels, OHNE die Nachrichten zu liefern.
 *
 * Fuer den Fall, dass ein Agent die letzten Meldungen bereits kennt und den Rest nicht mehr
 * sehen will. Bis dahin ging das nur, indem man die Merkdatei des Hooks von Hand ueberschrieb —
 * ein Trick, kein Vertrag.
 *
 * ⚠️ WIRKT NUR AUSDRUECKLICH. Diese Funktion darf niemals als Nebenwirkung eines anderen
 * Aufrufs laufen: ein Lesestand, der sich selbst weiterschiebt, meldet nie wieder etwas — und
 * dass nichts gemeldet wird, sieht genauso aus wie "es gibt nichts Neues".
 *
 * @returns Anzahl der damit als gelesen markierten fremden Nachrichten (0, wenn nichts offen
 *          war oder der Agent kein Mitglied ist).
 */
export async function markChannelRead(
  project: string,
  channelName: string,
  agentId: string,
): Promise<number> {
  if (!project || !channelName || !agentId) return 0
  try {
    const { rows } = await getPool().query<{ markiert: number }>(
      `WITH offen AS (
         SELECT mem.channel_id,
                COUNT(msg.id)::int AS anzahl,
                COALESCE(MAX(msg.id), mem.last_read_message_id) AS neueste
         FROM specialist_channel_members mem
         JOIN specialist_channels c ON c.id = mem.channel_id
         LEFT JOIN specialist_channel_messages msg
           ON msg.channel_id = mem.channel_id
          AND msg.id > mem.last_read_message_id
          AND msg.sender <> mem.agent_name
         WHERE c.project = $1 AND c.name = $2 AND mem.agent_name = $3
         GROUP BY mem.channel_id, mem.last_read_message_id
       )
       UPDATE specialist_channel_members mem
          SET last_read_message_id = GREATEST(mem.last_read_message_id, offen.neueste),
              last_notified_message_id = GREATEST(
                COALESCE(mem.last_notified_message_id, 0), offen.neueste),
              read_initialized_at = COALESCE(mem.read_initialized_at, NOW())
         FROM offen
        WHERE mem.channel_id = offen.channel_id AND mem.agent_name = $3
        RETURNING offen.anzahl AS markiert`,
      [project, channelName, agentId],
    )
    return rows[0]?.markiert ?? 0
  } catch (error) {
    console.error('[ChannelUnread] Lesestand konnte nicht gesetzt werden:', error)
    return 0
  }
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
      // Der Hinweis traegt nur Zahlen, nie Inhalte. Ab der Schwelle sagt er zusaetzlich,
      // dass gezielt gelesen werden soll — sonst holt sich ein Agent bei 200 Ungelesenen
      // den ganzen Vormittag in den Kontext.
      ...(row.unread_count >= NAVIGATIONSSCHWELLE ? { navigateByIdOnly: true } : {}),
    }))
  } catch (error) {
    console.error('[ChannelUnread] Ungelesen-Hinweise konnten nicht ermittelt werden:', error)
    return []
  }
}
