import { getPool } from '../db/client.js'
import type { ChannelMessage } from '../types/index.js'
import { bereiteChannelSkillVorschlaegeVor, holeChannelSkillsNachBeitritt } from './skill-hook.js'

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
     ON CONFLICT (name, project) DO UPDATE SET description = EXCLUDED.description
     RETURNING id, name, project`,
    [name, project, description, createdBy],
  )
  return rows[0]
}

export async function deleteChannel(project: string, name: string): Promise<boolean> {
  const pool = getPool()
  const { rows } = await pool.query(
    `DELETE FROM specialist_channels WHERE name = $1 AND project = $2 RETURNING id`,
    [name, project],
  )
  return rows.length > 0
}

export async function joinChannel(project: string, channelName: string, agentName: string): Promise<boolean> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: number; max_message_id: string | number }>(
    `SELECT c.id, COALESCE(MAX(msg.id), 0)::bigint AS max_message_id
       FROM specialist_channels c
       LEFT JOIN specialist_channel_messages msg ON msg.channel_id = c.id
      WHERE c.name = $1 AND c.project = $2
      GROUP BY c.id`, [channelName, project])
  if (rows.length === 0) return false

  const channelId = rows[0].id
  const baselineId = Number(rows[0].max_message_id)
  await pool.query(
    `INSERT INTO specialist_channel_members (
       channel_id, agent_name, last_read_message_id,
       last_notified_message_id, read_initialized_at)
     VALUES ($1, $2, $3, $3, NOW())
     ON CONFLICT DO NOTHING`, [channelId, agentName, baselineId])

  // ⚠️ VORRAT FUER DEN NEUEN AGENTEN NACHHOLEN — sonst bleibt sein Vorschlagsblock leer.
  // Der Vorrat entsteht sonst nur beim Posten, und zwar fuer die Mitglieder von genau diesem
  // Moment. Wer danach beitritt, kaeme nie an die Skills der bereits gepostenen Nachrichten.
  // Bewusst AWAIT und nicht fire-and-forget: ein Agent ruft das Skill-Tool oft schon eine
  // Sekunde nach dem Beitritt auf (gemessen), und ein Vorrat, der erst danach fertig wird,
  // haette denselben leeren Block erzeugt wie gar keiner.
  // Ein Fehlschlag darf den Beitritt selbst nicht kippen — aber er wird sichtbar.
  try {
    await holeChannelSkillsNachBeitritt(project, channelName, agentName, pool)
  } catch (fehler) {
    console.error(
      `[SkillHook] Nachholen beim Beitritt von ${agentName} zu ${project}/${channelName} fehlgeschlagen:`,
      fehler instanceof Error ? `${fehler.name}: ${fehler.message}` : fehler,
    )
  }
  return true
}

/**
 * Entfernt einen Agenten aus ALLEN Channels (projektuebergreifend).
 * Wird beim Purge eines Spezialisten aufgerufen.
 */
export async function removeAgentFromAllChannels(agentName: string): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query(
    `DELETE FROM specialist_channel_members WHERE agent_name = $1 RETURNING channel_id`,
    [agentName],
  )
  return rows.length
}

export async function leaveChannel(project: string, channelName: string, agentName: string): Promise<boolean> {
  const pool = getPool()
  const { rows: channelRows } = await pool.query<{ id: number }>(
    `SELECT id FROM specialist_channels WHERE name = $1 AND project = $2`,
    [channelName, project],
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

export async function postChannelMessage(
  project: string,
  channelName: string,
  sender: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<{ id: number; createdAt: Date } | null> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: number; created_at: Date }>(
    `INSERT INTO specialist_channel_messages (channel_id, sender, content, metadata)
     SELECT c.id, $3, $4, $5
     FROM specialist_channels c WHERE c.name = $1 AND c.project = $2
     RETURNING id, created_at`,
    [channelName, project, sender, content, metadata ? JSON.stringify(metadata) : null],
  )
  if (rows.length === 0) return null
  const result = { id: rows[0].id, createdAt: rows[0].created_at }
  // ⚠️ DER FEHLSCHLAG MUSS SICHTBAR SEIN. Hier stand .catch(() => undefined) — jede Ursache
  // wurde kommentarlos verschluckt. GEMESSEN am 01.08.2026: im Container entstand fuer keine
  // ueber die API gepostete Nachricht eine Vorbereitung, waehrend derselbe Aufruf per
  // docker exec im selben Container 20 Eintraege schrieb. Im Log stand dazu NICHTS, und im
  // Feed sieht ein stiller Ausfall exakt aus wie "kein passender Skill".
  // Der Post selbst darf davon unberuehrt bleiben — deshalb weiterhin fire-and-forget, aber
  // mit Spur.
  void bereiteChannelSkillVorschlaegeVor(
    project,
    channelName,
    result.id,
    content,
    pool,
  ).catch((fehler) => {
    console.error(
      `[SkillHook] Vorberechnung fuer Nachricht ${result.id} in ${project}/${channelName} fehlgeschlagen:`,
      fehler instanceof Error ? `${fehler.name}: ${fehler.message}` : fehler,
    )
  })
  return result
}

export async function getChannelMessages(
  project: string,
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
     WHERE c.name = $1 AND c.project = $2
       AND cm.id > $3
     ORDER BY cm.created_at DESC
     LIMIT $4`,
    [channelName, project, sinceId, limit],
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

export async function getChannelMembers(project: string, channelName: string): Promise<string[]> {
  const pool = getPool()
  const { rows } = await pool.query<{ agent_name: string }>(
    `SELECT cm.agent_name
     FROM specialist_channel_members cm
     JOIN specialist_channels c ON c.id = cm.channel_id
     WHERE c.name = $1 AND c.project = $2
     ORDER BY cm.joined_at`,
    [channelName, project],
  )
  return rows.map((r) => r.agent_name)
}

/** Ein Sichtungs-Eintrag: die Beitraege EINES Agenten in EINEM Channel. */
export interface SichtungsEintrag {
  agent: string;
  nachrichten: number;
  letzte_id: number;
  status: 'offen' | 'gesichert' | 'nichts_verwertbares' | 'veraltet';
  memory_name?: string;
  gesichtet_von?: string;
  gesichtet_am?: string;
}

/**
 * CH-3: Wer in diesem Channel geschrieben hat und was davon schon ausgewertet ist.
 *
 * Der Status wird NICHT einfach aus der Tabelle uebernommen, sondern gegen die letzte
 * Nachricht gehalten: steht im Vermerk eine aeltere ID als die neueste Nachricht dieses
 * Agenten, ist er 'veraltet' — es kam etwas dazu, das noch niemand gelesen hat. Genau das
 * ist der Fall, den ein simples Haekchen verschweigen wuerde.
 */
export async function holeSichtungsstand(
  project: string,
  channelName: string,
): Promise<SichtungsEintrag[]> {
  const { rows } = await getPool().query<SichtungsEintrag & { vermerk_bis: string | null }>(
    `SELECT m.sender AS agent,
            count(*)::int AS nachrichten,
            max(m.id)::int AS letzte_id,
            s.memory_name,
            s.gesichtet_von,
            to_char(s.gesichtet_am, 'YYYY-MM-DD HH24:MI') AS gesichtet_am,
            s.bis_nachricht_id AS vermerk_bis,
            CASE
              WHEN s.agent IS NULL THEN 'offen'
              WHEN s.bis_nachricht_id IS NOT NULL AND s.bis_nachricht_id < max(m.id) THEN 'veraltet'
              ELSE s.status
            END AS status
       FROM specialist_channel_messages m
       JOIN specialist_channels c ON c.id = m.channel_id
       LEFT JOIN channel_sichtung s
              ON s.project = c.project AND s.channel = c.name AND s.agent = m.sender
      WHERE c.project = $1 AND c.name = $2
      GROUP BY m.sender, s.agent, s.status, s.memory_name, s.gesichtet_von, s.gesichtet_am, s.bis_nachricht_id
      ORDER BY count(*) DESC`,
    [project, channelName],
  );
  return rows.map(({ vermerk_bis: _weg, ...rest }) => rest);
}

/**
 * CH-3: Die Beitraege eines Agenten in einem Channel als ausgewertet vermerken.
 *
 * ⚠️ MARKIERT DAS MEMORY GLEICH MIT (ausdrueckliche Vorgabe des Users, 15.08.2026).
 * Ein Memory aus einem Channel ist eine MOMENTAUFNAHME — es haelt fest, was Agenten damals
 * dachten, nicht was heute im Code steht. Ohne Herkunft und Datum liest es sich spaeter wie
 * eine gueltige Auskunft. Die Tags landen deshalb hier automatisch am Memory, nicht per
 * Erinnerung an den, der abhakt: was man von Hand nachtragen muss, wird irgendwann vergessen.
 */
export async function setzeSichtung(opts: {
  project: string;
  channel: string;
  agent: string;
  status: 'gesichert' | 'nichts_verwertbares';
  memoryName?: string;
  notiz?: string;
  gesichtetVon: string;
}): Promise<{ ok: boolean; bis_nachricht_id: number | null; memory_markiert: boolean }> {
  const pool = getPool();

  const { rows: maxRows } = await pool.query<{ letzte: string | null }>(
    `SELECT max(m.id) AS letzte
       FROM specialist_channel_messages m
       JOIN specialist_channels c ON c.id = m.channel_id
      WHERE c.project = $1 AND c.name = $2 AND m.sender = $3`,
    [opts.project, opts.channel, opts.agent],
  );
  const bis = maxRows[0]?.letzte ? Number(maxRows[0].letzte) : null;

  await pool.query(
    `INSERT INTO channel_sichtung
            (project, channel, agent, status, memory_name, bis_nachricht_id, notiz, gesichtet_von, gesichtet_am)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
     ON CONFLICT (project, channel, agent) DO UPDATE
        SET status = EXCLUDED.status,
            memory_name = EXCLUDED.memory_name,
            bis_nachricht_id = EXCLUDED.bis_nachricht_id,
            notiz = EXCLUDED.notiz,
            gesichtet_von = EXCLUDED.gesichtet_von,
            gesichtet_am = NOW()`,
    [opts.project, opts.channel, opts.agent, opts.status, opts.memoryName ?? null, bis, opts.notiz ?? null, opts.gesichtetVon],
  );

  // Herkunft ans Memory haengen — Tags, damit man spaeter ALLE Channel-Memories findet
  // (memory list nach Tag) und nicht erst beim Lesen merkt, woher der Inhalt stammt.
  let markiert = false;
  if (opts.memoryName) {
    const res = await pool.query(
      `UPDATE memories
          SET tags = (
                SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}')
                       || ARRAY['aus-channel', 'channel:' || $3, 'stand:' || to_char(NOW(), 'YYYY-MM-DD')]))
              )
        WHERE project = $1 AND name = $2`,
      [opts.project, opts.memoryName, opts.channel],
    );
    markiert = (res.rowCount ?? 0) > 0;
  }

  return { ok: true, bis_nachricht_id: bis, memory_markiert: markiert };
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

/**
 * Neue Channel-Nachrichten fuer einen Agenten, ab sinceId.
 *
 * ⚠️ Das Limit war bis zum 02.08.2026 fest auf 10 verdrahtet. Das war unauffaellig,
 * solange nur der Wrapper es benutzte (er holt im naechsten Takt nach), wurde aber
 * zum stillen Fehler, als die Bruecken-Route dazukam: die kappt auf ihr eigenes
 * Limit (Vorgabe 200) und meldet truncated nur, wenn MEHR Zeilen vorhanden waeren
 * als sie ausliefert. Bekam sie nie mehr als 10, konnte truncated nie true werden —
 * der Aufrufer hielt zehn Nachrichten fuer den vollstaendigen Stand und fasste nicht
 * nach. Gefunden bei der Abnahme von Schritt 3 (poll-verdrahtung).
 *
 * Die Vorgabe bleibt 10, damit sich fuer bestehende Aufrufer nichts aendert; wer
 * mehr braucht, sagt es. Ein Aufrufer, der truncated auswerten will, fragt EINE Zeile
 * mehr ab als er ausliefert — sonst ist "genau limit Zeilen" nicht von "limit Zeilen
 * und da kommt noch was" zu unterscheiden.
 */
export async function getNewMessagesForAgent(
  agentName: string,
  sinceId: number,
  limit = 10,
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
     LIMIT $3`,
    [agentName, sinceId, Math.max(1, Math.floor(limit))],
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
    await joinChannel(project, channelName, agentName)
  }
}
