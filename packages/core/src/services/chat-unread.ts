import { getPool } from '../db/client.js';

export interface UnreadChatHint {
  broadcasts: number;
  dms: Array<{ from: string; count: number }>;
  hint: string;
}

/** Einmaliger Ausgangsstand: bestehende Marken werden auch bei Wiederanmeldung nie ersetzt. */
export async function initialisiereChatLesestand(project: string, agentId: string): Promise<boolean> {
  if (!project || !agentId) return false;
  const { rowCount } = await getPool().query(
    `INSERT INTO chat_lesestand(project, agent_id, letzte_id)
     SELECT $1, $2, COALESCE((SELECT MAX(id) FROM chat_messages WHERE project = $1), 0)
     WHERE NOT EXISTS (SELECT 1 FROM chat_lesestand WHERE project = $1 AND agent_id = $2)
     ON CONFLICT (project, agent_id) DO NOTHING
     RETURNING letzte_id`,
    [project, agentId],
  );
  return (rowCount ?? 0) > 0;
}

/** Nach dem einmaligen Ausgangsstand reine PG-Zählung; eigene und fremde DMs zählen nicht. */
export async function getUnreadChatHint(project: string, agentId: string): Promise<UnreadChatHint | null> {
  if (!project || !agentId) return null;
  try {
    if (await initialisiereChatLesestand(project, agentId)) return null;
    const { rows } = await getPool().query<{ recipient_id: string | null; sender_id: string | null; count: number }>(
      `SELECT recipient_id,
              CASE WHEN recipient_id IS NOT NULL THEN sender_id END AS sender_id,
              COUNT(*)::int AS count
       FROM chat_messages
       WHERE project = $1 AND sender_id <> $2
         AND (recipient_id IS NULL OR recipient_id = $2)
         AND id > COALESCE((SELECT letzte_id FROM chat_lesestand WHERE project = $1 AND agent_id = $2), 0)
       GROUP BY recipient_id, CASE WHEN recipient_id IS NOT NULL THEN sender_id END
       ORDER BY sender_id NULLS FIRST`,
      [project, agentId],
    );
    if (rows.length === 0) return null;
    const broadcasts = rows.find(row => row.recipient_id === null)?.count ?? 0;
    const dms = rows.filter(row => row.recipient_id !== null).map(row => ({ from: row.sender_id!, count: row.count }));
    const parts: string[] = [];
    if (broadcasts > 0) parts.push(`${broadcasts} Broadcasts`);
    for (const dm of dms) parts.push(`${dm.count} DM von ${dm.from}`);
    return {
      broadcasts, dms,
      hint: `📨 Ungelesene Nachrichten: ${parts.join(', ')}. Lies mit: chat(action: "get", project: "${project}", agent_id: "${agentId}")`,
    };
  } catch (error) {
    console.error('[ChatUnread] Ungelesen-Hinweis konnte nicht ermittelt werden:', error);
    return null; // Ein optionaler Hinweis darf die eigentliche Toolantwort nicht brechen.
  }
}
