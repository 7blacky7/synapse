import { getPool } from '../db/client.js'
import { kommunikationsAgent, aufgeloestesKommunikationsZiel, aufgeloestesSendeZiel, bezugsWert, agentBezugAktiv } from './kommunikation-agent.js'
import type { AgentZiel } from './agent-bezug.js'
import type { InboxMessage } from '../types/index.js'

function mapRow(row: Record<string, unknown>): InboxMessage {
  return {
    id: row.id as number,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    ...(agentBezugAktiv() ? {fromIdentityId:row.from_identity_id as string|null,toIdentityId:row.to_identity_id as string|null} : {}),
    content: row.content as string,
    processed: row.processed as boolean,
    createdAt: row.created_at as Date,
  }
}

export async function postToInbox(fromAgent: string | AgentZiel, toAgent: string | AgentZiel, content: string, project: string): Promise<{ id: number; createdAt: Date }> {
  const sender = kommunikationsAgent(project, fromAgent), ziel = await aufgeloestesSendeZiel(project, toAgent)
  if (agentBezugAktiv()) {
    const { rows } = await getPool().query(
      `INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
      [sender.agent_id,ziel.agent_id,content,project,sender.art === 'identity' ? sender.identity_id : null,ziel.art === 'identity' ? ziel.identity_id : null])
    return { id: rows[0].id, createdAt: rows[0].created_at }
  }
  toAgent = ziel.agent_id
  const result = await getPool().query(
    `INSERT INTO specialist_inbox (from_agent, to_agent, content, project) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [sender.agent_id, toAgent, content, project],
  )
  const row = result.rows[0]
  return { id: row.id as number, createdAt: row.created_at as Date }
}

export async function checkInbox(agentName: string | AgentZiel, project: string): Promise<InboxMessage[]> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const result = await getPool().query(`UPDATE specialist_inbox SET processed=true WHERE project=$2 AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} AND processed=false RETURNING *`, [bezugsWert(z), project])
    return result.rows.map(mapRow)
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `UPDATE specialist_inbox SET processed = true WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $2 AND processed = false RETURNING id, from_agent, to_agent, content, processed, created_at`,
    [agentName, project],
  )
  return result.rows.map(mapRow)
}

export async function getNewInboxMessages(agentName: string | AgentZiel, sinceId: number, project: string): Promise<InboxMessage[]> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const result = await getPool().query(`SELECT * FROM specialist_inbox WHERE project=$3 AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} AND processed=false AND id>$2 ORDER BY id ASC`, [bezugsWert(z), sinceId, project])
    return result.rows.map(mapRow)
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `SELECT id, from_agent, to_agent, content, processed, created_at FROM specialist_inbox WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $3 AND processed = false AND id > $2 ORDER BY id ASC`,
    [agentName, sinceId, project],
  )
  return result.rows.map(mapRow)
}

export async function getInboxHistory(agentName: string | AgentZiel, project: string, limit = 50): Promise<InboxMessage[]> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const result = await getPool().query(`SELECT * FROM specialist_inbox WHERE project=$2 AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} ORDER BY id DESC LIMIT $3`, [bezugsWert(z), project, limit])
    return result.rows.map(mapRow)
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `SELECT id, from_agent, to_agent, content, processed, created_at FROM specialist_inbox WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $2 ORDER BY id DESC LIMIT $3`,
    [agentName, project, limit],
  )
  return result.rows.map(mapRow)
}

export async function removeInboxForAgent(agentName: string | AgentZiel, project: string): Promise<number> {

  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  if (agentBezugAktiv()) {
    const result = await getPool().query(`DELETE FROM specialist_inbox WHERE project=$2 AND ${z.art === 'identity' ? 'to_identity_id=$1' : 'to_agent=$1 AND to_identity_id IS NULL'} RETURNING id`, [bezugsWert(z), project])
    return result.rowCount ?? result.rows.length
  }
  agentName = z.agent_id
  const result = await getPool().query(
    `DELETE FROM specialist_inbox WHERE to_agent = $1 AND to_identity_id IS NULL AND project = $2 RETURNING id`,
    [agentName, project],
  )
  return result.rowCount ?? result.rows.length
}
