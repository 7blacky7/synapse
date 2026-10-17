import { getPool } from '../db/client.js';
import { kommunikationsAgent, bezugsWert, agentBezugAktiv } from './kommunikation-agent.js';

export interface UnreadChatHint {
  broadcasts: number;
  dms: Array<{ from: string; count: number }>;
  hint: string;
}

/** Einmaliger Ausgangsstand: bestehende Marken werden auch bei Wiederanmeldung nie ersetzt. */
export async function initialisiereChatLesestand(project: string, agentId: string): Promise<boolean> {
  if (!project || !agentId) return false;
  const z = kommunikationsAgent(project, agentId);
  if (z.art === 'identity') {
    const { rowCount } = await getPool().query(
      `INSERT INTO agent_identitaet_chat_lesestand(project,agent_id,identity_id,letzte_id)
       SELECT $1,$2,$3,COALESCE((SELECT MAX(id) FROM chat_messages WHERE project=$1),0)
       ON CONFLICT(project,identity_id) DO NOTHING RETURNING letzte_id`, [project,agentId,z.identity_id]);
    return (rowCount ?? 0)>0;
  }
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

/** Beansprucht neue Hinweise atomisch pro Empfänger; der tatsächliche Lesestand bleibt unverändert. */
export async function getUnreadChatHint(project: string, agentId: string): Promise<UnreadChatHint | null> {
  if (!project || !agentId) return null;
  try {
    if (await initialisiereChatLesestand(project, agentId)) return null;
    const z = kommunikationsAgent(project, agentId);
    if (agentBezugAktiv()) {
      const identity = z.art === 'identity';
      const table = identity ? 'agent_identitaet_chat_lesestand' : 'chat_lesestand';
      const key = identity ? 'identity_id' : 'agent_id';
      const fremd = identity ? 'm.sender_identity_id IS DISTINCT FROM $2' : '(m.sender_identity_id IS NOT NULL OR m.sender_id<>$2)';
      const ziel = identity ? 'm.recipient_identity_id=$2' : '(m.recipient_identity_id IS NULL AND m.recipient_id=$2)';
      const { rows } = await getPool().query(
        `WITH neu AS MATERIALIZED (
          SELECT m.id,m.sender_id,(m.recipient_id IS NULL AND m.recipient_identity_id IS NULL) AS broadcast
          FROM chat_messages m JOIN ${table} l ON l.project=m.project AND l.${key}=$2
          WHERE m.project=$1 AND ${fremd}
          AND ((m.recipient_id IS NULL AND m.recipient_identity_id IS NULL) OR ${ziel})
          AND m.id>GREATEST(l.letzte_id,l.letzte_hinweis_id)
        ), beansprucht AS (
          UPDATE ${table} l SET letzte_hinweis_id=(SELECT MAX(id) FROM neu)
          WHERE l.project=$1 AND l.${key}=$2 AND (SELECT MAX(id) FROM neu)>GREATEST(l.letzte_id,l.letzte_hinweis_id)
          RETURNING l.project)
        SELECT broadcast,sender_id,COUNT(*)::int AS count FROM neu CROSS JOIN beansprucht GROUP BY broadcast,sender_id`,
        [project,bezugsWert(z)]);
      if (!rows.length) return null;
      const broadcasts = rows.filter(r=>r.broadcast).reduce((sum,r)=>sum+r.count,0);
      const dms = rows.filter(r=>!r.broadcast).map(r=>({from:r.sender_id as string,count:r.count as number}));
      return { broadcasts,dms,hint:`📨 Ungelesene Nachrichten: ${broadcasts} Broadcasts${dms.map(d=>', '+d.count+' DM von '+d.from).join('')}. Lies mit: chat(action: "get", project: "${project}", agent_id: "${agentId}")` };
    }
    const { rows } = await getPool().query<{ recipient_id: string | null; sender_id: string | null; count: number }>(
      `WITH neu AS MATERIALIZED (
         SELECT m.id, m.recipient_id, m.sender_id
         FROM chat_messages m
         JOIN chat_lesestand l ON l.project = m.project AND l.agent_id = $2
         WHERE m.project = $1 AND (m.sender_identity_id IS NOT NULL OR m.sender_id <> $2)
           AND m.recipient_identity_id IS NULL AND (m.recipient_id IS NULL OR m.recipient_id = $2)
           AND m.id > GREATEST(l.letzte_id, l.letzte_hinweis_id)
       ), beansprucht AS (
         UPDATE chat_lesestand l
         SET letzte_hinweis_id = (SELECT MAX(id) FROM neu)
         WHERE l.project = $1 AND l.agent_id = $2
           AND (SELECT MAX(id) FROM neu) > GREATEST(l.letzte_id, l.letzte_hinweis_id)
         RETURNING l.project
       )
       SELECT recipient_id,
              CASE WHEN recipient_id IS NOT NULL THEN sender_id END AS sender_id,
              COUNT(*)::int AS count
       FROM neu CROSS JOIN beansprucht
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
