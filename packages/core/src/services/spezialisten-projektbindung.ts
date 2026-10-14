/**
 * MODUL: spezialisten-projektbindung.ts
 * ZWECK: Projektgebundene Varianten der Spezialisten-Aufraeumschritte.
 */

import { getPool } from '../db/client.js'

export async function entferneAgentAusProjektChannels(agentName: string, project: string): Promise<number> {
  const { rows } = await getPool().query(
    `DELETE FROM specialist_channel_members m
      USING specialist_channels c
      WHERE m.channel_id = c.id AND c.project = $2 AND m.agent_name = $1
      RETURNING m.channel_id`,
    [agentName, project],
  )
  return rows.length
}

export async function meldeAgentImProjektAb(agentName: string, project: string): Promise<number> {
  const r = await getPool().query(
    `UPDATE agent_sessions SET status = 'inactive' WHERE id = $1 AND project = $2`,
    [agentName, project],
  )
  return r.rowCount ?? 0
}

export async function sitzungsProjektDesAgenten(agentName: string): Promise<string | null> {
  const { rows } = await getPool().query<{ project: string }>(
    'SELECT project FROM agent_sessions WHERE id = $1', [agentName])
  return rows.length > 0 ? rows[0].project : null
}

export async function andereProjekteDesAgenten(agentName: string, project: string): Promise<string[]> {
  const { rows } = await getPool().query<{ project: string }>(
    `SELECT DISTINCT p.project FROM (
        SELECT project FROM wrapper_status WHERE agent_name = $1
        UNION SELECT project FROM agent_sessions WHERE id = $1
        UNION SELECT c.project FROM specialist_channel_members m
                JOIN specialist_channels c ON c.id = m.channel_id
               WHERE m.agent_name = $1
      ) p
      WHERE p.project IS DISTINCT FROM $2
      ORDER BY 1`,
    [agentName, project],
  )
  return rows.map(r => r.project)
}

export interface ProjektInboxErgebnis {
  anzahl: number
  andereProjekte: string[]
}

export async function entferneInboxImProjekt(agentName: string, project: string): Promise<ProjektInboxErgebnis> {
  const r = await getPool().query(
    `DELETE FROM specialist_inbox WHERE to_agent = $1 AND project = $2 RETURNING id`,
    [agentName, project],
  )
  return { anzahl: r.rowCount ?? r.rows.length, andereProjekte: [] }
}
