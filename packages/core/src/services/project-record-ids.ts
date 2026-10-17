import { getPool } from '../db/client.js';
import { getMemoryById } from './memory.js';
import { getMessages } from './chat.js';
import { kommunikationsAgent, agentBezugAktiv } from './kommunikation-agent.js';

export type ProjectRecordArt =
  | 'memory'
  | 'doc'
  | 'channel_message'
  | 'event'
  | 'chat_message'
  | 'jev_decision';

function positiveId(id: string | number): string {
  const value = String(id);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error('ID muss eine positive Ganzzahl sein');
  }
  return value;
}

/**
 * Liest einen bekannten Datensatz direkt aus PostgreSQL, immer im Projektkontext.
 * Chat-DMs und agent-spezifische Events werden zusätzlich auf den anfragenden Agenten begrenzt.
 */
export async function getProjectRecordById(
  art: ProjectRecordArt,
  project: string,
  id: string | number,
  agentId?: string,
): Promise<Record<string, unknown> | null> {
  if (!project.trim()) throw new Error('project ist erforderlich');

  if (art === 'memory') {
    const memory = await getMemoryById(project, String(id));
    return memory ? { ...memory } : null;
  }

  const pool = getPool();
  if (art === 'doc') {
    const { rows } = await pool.query(
      `SELECT id, project, framework, version, section, content, type, category,
              source, content_hash, indexed_at
         FROM tech_docs
        WHERE id = $1 AND (project = $2 OR project IS NULL)
        LIMIT 1`,
      [String(id), project],
    );
    return rows[0] ?? null;
  }

  const idNum = positiveId(id);
  if (art === 'channel_message') {
    const { rows } = await pool.query(
      `SELECT cm.id, c.project, c.name AS "channelName", cm.sender,
              cm.content, cm.metadata, cm.created_at AS "createdAt"${agentBezugAktiv() ? ',cm.sender_identity_id AS "senderIdentityId"' : ''}
         FROM specialist_channel_messages cm
         JOIN specialist_channels c ON c.id = cm.channel_id
        WHERE c.project = $1 AND cm.id = $2
        LIMIT 1`,
      [project, idNum],
    );
    return rows[0] ?? null;
  }

  if ((art === 'event' || art === 'chat_message') && !agentId?.trim()) {
    throw new Error('agent_id ist für diesen ID-Lookup erforderlich');
  }

  if (art === 'event') {
    const z=kommunikationsAgent(project,agentId!);
    const { rows } = await pool.query(
      `SELECT id, project, event_type AS "eventType", priority, scope,
              source_id AS "sourceId", payload, requires_ack AS "requiresAck",
              created_at AS "createdAt"
         FROM agent_events
        WHERE project = $1 AND id = $2
          AND (scope = 'all' OR scope = $3)
        LIMIT 1`,
      [project,idNum,z.art === 'identity' ? `identity:${z.identity_id}` : `agent:${agentId}`],
    );
    return rows[0] ?? null;
  }

  if (art === 'chat_message') {
    const messages = await getMessages(project, { agentId, messageId: idNum, limit: 1 });
    return messages[0] ? { ...messages[0] } : null;
  }

  const { rows } = await pool.query(
    'SELECT * FROM jev_entscheidungen WHERE project = $1 AND id = $2 LIMIT 1',
    [project, idNum],
  );
  return rows[0] ?? null;
}
