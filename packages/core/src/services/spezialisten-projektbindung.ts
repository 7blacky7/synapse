/**
 * MODUL: spezialisten-projektbindung.ts (P9-T27 Nachbesserung, Testbefund 291473c2 Nr. 1)
 * ZWECK: Projektgebundene Varianten der Spezialisten-Aufraeumschritte (purge/wake).
 *        Bisher wirkten removeAgentFromAllChannels, unregisterAgent und removeInboxForAgent auf den
 *        AGENTNAMEN in allen Projekten. Ein gleichnamiger Agent eines anderen Projekts verlor dabei
 *        Channel-Mitgliedschaften, Chat-Sitzung und Inbox.
 *
 * DATENMODELL:
 *   - specialist_channel_members haengt ueber specialist_channels.project am Projekt -> echt filterbar.
 *   - agent_sessions.id ist GLOBAL (eine Zeile je Name, Spalte project = zuletzt registriert) ->
 *     nur Zeilen mit project = <Projekt> werden angefasst.
 *   - specialist_inbox hat KEINE project-Spalte -> Inbox eines Namens gilt nur dann als Projekt-Inbox,
 *     wenn der Name in keinem anderen Projekt vorkommt (wrapper_status, agent_sessions, Channel-
 *     Mitgliedschaft). Sonst wird nichts geloescht/geschrieben und die anderen Projekte werden genannt.
 */

import { getPool } from '../db/client.js'

/** Entfernt den Agenten nur aus den Channels DIESES Projekts. Liefert die Anzahl entfernter Mitgliedschaften. */
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

/** Meldet die Chat-Sitzung nur ab, wenn sie zu DIESEM Projekt gehoert. Liefert 0 oder 1. */
export async function meldeAgentImProjektAb(agentName: string, project: string): Promise<number> {
  const r = await getPool().query(
    `UPDATE agent_sessions SET status = 'inactive' WHERE id = $1 AND project = $2`,
    [agentName, project],
  )
  return r.rowCount ?? 0
}

/** Projekt der (globalen) Chat-Sitzung dieses Namens, null = keine Sitzung. */
export async function sitzungsProjektDesAgenten(agentName: string): Promise<string | null> {
  const { rows } = await getPool().query<{ project: string }>(
    'SELECT project FROM agent_sessions WHERE id = $1', [agentName])
  return rows.length > 0 ? rows[0].project : null
}

/** Andere Projekte, in denen der Name vorkommt (wrapper_status, agent_sessions, Channel-Mitgliedschaft). */
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
  /** Nicht leer = Name auch in anderen Projekten, NICHTS geloescht. */
  andereProjekte: string[]
}

/**
 * Loescht die Inbox eines Agenten nur, wenn der Name ausschliesslich zu DIESEM Projekt gehoert.
 * Die Bedingung steht zusaetzlich im DELETE selbst, damit ein gleichzeitiger Spawn im anderen
 * Projekt zwischen Pruefung und Loeschen nichts verliert.
 */
export async function entferneInboxImProjekt(agentName: string, project: string): Promise<ProjektInboxErgebnis> {
  const andereProjekte = await andereProjekteDesAgenten(agentName, project)
  if (andereProjekte.length > 0) return { anzahl: 0, andereProjekte }
  const r = await getPool().query(
    `DELETE FROM specialist_inbox i
      WHERE i.to_agent = $1
        AND NOT EXISTS (SELECT 1 FROM wrapper_status w WHERE w.agent_name = $1 AND w.project IS DISTINCT FROM $2)
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = $1 AND s.project IS DISTINCT FROM $2)
        AND NOT EXISTS (SELECT 1 FROM specialist_channel_members m JOIN specialist_channels c ON c.id = m.channel_id
                         WHERE m.agent_name = $1 AND c.project IS DISTINCT FROM $2)
      RETURNING i.id`,
    [agentName, project],
  )
  return { anzahl: r.rowCount ?? r.rows.length, andereProjekte: [] }
}
