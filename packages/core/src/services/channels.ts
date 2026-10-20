import { getPool } from '../db/client.js'
import { kommunikationsAgent, aufgeloestesKommunikationsZiel, eigenerKommunikationsAgent, bezugsWert, agentBezugAktiv } from './kommunikation-agent.js'
import { aktuelleAgentIdentityId, aktuellerAgentAufruf, loeseAgentZiel, type AgentZiel } from './agent-bezug.js'
import { aktuelleUserHerkunft } from './user-herkunft.js'
import type { ChannelMessage } from '../types/index.js'
import { bereiteChannelSkillVorschlaegeVor, holeChannelSkillsNachBeitritt } from './skill-hook.js'
import { archivVerweise } from './agent-entfernung.js'

export async function createChannel(
  project: string,
  name: string,
  description: string | null,
  createdBy: string,
): Promise<{ id: number; name: string; project: string }> {
  const pool = getPool()
  if (agentBezugAktiv()) {
    const {rows} = await pool.query(
      `INSERT INTO specialist_channels(name,project,description,created_by,created_by_identity_id)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(name,project) DO UPDATE SET description=EXCLUDED.description RETURNING id,name,project`,
      [name,project,description,createdBy,aktuelleAgentIdentityId(project,createdBy)]);
    return rows[0];
  }
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

export async function joinChannel(project: string, channelName: string, agentName: string | AgentZiel): Promise<boolean> {
  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  agentName = z.agent_id
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
    z.art === 'identity'
      ? `INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id,last_read_message_id,last_notified_message_id,read_initialized_at)
         VALUES($1,$2,$4,$3,$3,NOW()) ON CONFLICT DO NOTHING`
      : `INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id,last_notified_message_id,read_initialized_at)
         VALUES($1,$2,$3,$3,NOW()) ON CONFLICT DO NOTHING`,
    z.art === 'identity' ? [channelId,agentName,baselineId,z.identity_id] : [channelId,agentName,baselineId])

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
export async function removeAgentFromAllChannels(agentName: string | AgentZiel, project?:string): Promise<number> {
  const zielProject = typeof agentName === 'string' ? project ?? aktuellerAgentAufruf()?.principal?.project ?? '' : agentName.project
  const z = await aufgeloestesKommunikationsZiel(zielProject,agentName,true)
  if (z.art === 'identity') {
    const r = await getPool().query('DELETE FROM agent_identitaet_channel_mitglieder WHERE identity_id=$1 RETURNING channel_id',[z.identity_id])
    return r.rows.length
  }
  const pool = getPool()
  const { rows } = await pool.query(
    `DELETE FROM specialist_channel_members WHERE agent_name = $1 RETURNING channel_id`,
    [z.agent_id],
  )
  return rows.length
}

export async function leaveChannel(project: string, channelName: string, agentName: string | AgentZiel): Promise<boolean> {
  const z = await aufgeloestesKommunikationsZiel(project, agentName, true)
  agentName = z.agent_id
  const pool = getPool()
  const { rows: channelRows } = await pool.query<{ id: number }>(
    `SELECT id FROM specialist_channels WHERE name = $1 AND project = $2`,
    [channelName, project],
  )
  if (channelRows.length === 0) return false

  const channelId = channelRows[0].id
  const { rows } = await pool.query(
    z.art === 'identity'
      ? 'DELETE FROM agent_identitaet_channel_mitglieder WHERE channel_id=$1 AND identity_id=$2 RETURNING agent_name'
      : 'DELETE FROM specialist_channel_members WHERE channel_id=$1 AND agent_name=$2 RETURNING agent_name',
    [channelId,bezugsWert(z)],
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
  // Reserviertes Etikett nur aus serverinternem Kontext, nie aus Caller-Metadata.
  const { herkunft: _unvertraut, ...rest } = metadata ?? {}
  const herkunft = aktuelleUserHerkunft()
  metadata = herkunft ? { ...rest, herkunft } : Object.keys(rest).length ? rest : undefined
  if (herkunft) sender = 'user'
  const pool = getPool()
  const { rows } = await pool.query<{ id: number; created_at: Date }>(
    agentBezugAktiv()
      ? `INSERT INTO specialist_channel_messages(channel_id,sender,content,metadata,sender_identity_id)
         SELECT c.id,$3,$4,$5,$6 FROM specialist_channels c WHERE c.name=$1 AND c.project=$2 RETURNING id,created_at`
      : `INSERT INTO specialist_channel_messages(channel_id,sender,content,metadata)
         SELECT c.id,$3,$4,$5 FROM specialist_channels c WHERE c.name=$1 AND c.project=$2 RETURNING id,created_at`,
    [channelName,project,sender,content,metadata ? JSON.stringify(metadata) : null,
      ...(agentBezugAktiv() ? [herkunft ? null : aktuelleAgentIdentityId(project,sender)] : [])],
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
  opts?: {
    limit?: number
    sinceId?: number
    beforeId?: number
    preview?: boolean
    order?: 'asc' | 'desc'
    /** CH-8: true holt auch die archivierten Nachrichten dazu. Vorgabe: sie bleiben draussen. */
    mitArchiv?: boolean
  },
): Promise<ChannelMessage[]> {
  const pool = getPool()
  const limit = opts?.limit ?? 20
  const sinceId = opts?.sinceId ?? 0
  const beforeId = opts?.beforeId ?? null
  // order='desc' (Vorgabe) liefert die NEUESTEN limit Nachrichten — das bisherige Verhalten.
  // order='asc' liefert die AELTESTEN ab sinceId. Erst damit ist der ANFANG eines langen
  // Channels erreichbar: feed lieferte immer nur das Ende, und sinceId verschob allein die
  // Untergrenze — es gab keine Blaetterrichtung nach vorne. Ab etwa 155 Nachrichten sprengt
  // ein voller Abruf die Ausgabegrenze, der Anfang blieb also unlesbar (belegt an
  // ptz-codex, wrapper-status-pg, synapse-general, rollen-trennung, api-bruecke).
  // beforeId setzt die Obergrenze und blaettert mit order='desc' rueckwaerts.
  const aufsteigend = opts?.order === 'asc'

  const { rows } = await pool.query<{
    id: number
    channel_name: string
    sender: string
    sender_identity_id?: string | null
    content: string
    metadata: Record<string, unknown> | null
    created_at: Date
  }>(
    `SELECT cm.id, c.name AS channel_name, cm.sender, cm.content, cm.metadata, cm.created_at${agentBezugAktiv() ? ',cm.sender_identity_id' : ''}
     FROM specialist_channel_messages cm
     JOIN specialist_channels c ON c.id = cm.channel_id
     WHERE c.name = $1 AND c.project = $2
       AND cm.id > $3
       AND ($4::bigint IS NULL OR cm.id < $4::bigint)
       AND ($6::boolean OR c.archiv_bis_nachricht_id IS NULL
            OR cm.id > c.archiv_bis_nachricht_id)
     ORDER BY cm.id ${aufsteigend ? 'ASC' : 'DESC'}
     LIMIT $5`,
    [channelName, project, sinceId, beforeId, limit, opts?.mitArchiv === true],
  )

  // Sortiert wird ueber cm.id statt created_at: geblaettert wird ueber IDs, und bei gleichem
  // Zeitstempel war die alte Reihenfolge unbestimmt.
  // Bei 'desc' holt die Abfrage das ENDE — zurueckgegeben wird trotzdem chronologisch.
  if (!aufsteigend) rows.reverse()

  // P22-T80 Teil 3: Absender bleibt der alte Name; Nachrichten eines umbenannten (archivierten) Agenten tragen den Verweis auf den Archiv-Eintrag.
  const verweise = await archivVerweise(project, rows, (r) => ({ name: r.sender, identity: r.sender_identity_id ?? null, zeit: r.created_at }))
  return rows.map((r, i) => ({
    id: r.id,
    channelName: r.channel_name,
    sender: r.sender,
    ...(agentBezugAktiv() ? { senderIdentityId:r.sender_identity_id } : {}),
    content:
      opts?.preview && r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content,
    metadata: r.metadata ?? undefined,
    createdAt: r.created_at,
    ...(verweise[i] ? { absenderArchiv: verweise[i] } : {}),
  }))
}

export async function getChannelMembers(project: string, channelName: string): Promise<string[]> {
  if (agentBezugAktiv()) {
    const {rows} = await getPool().query(
      `SELECT m.agent_name FROM specialist_channel_members m JOIN specialist_channels c ON c.id=m.channel_id WHERE c.project=$1 AND c.name=$2
       UNION ALL SELECT 'identity:'||m.identity_id FROM agent_identitaet_channel_mitglieder m JOIN specialist_channels c ON c.id=m.channel_id WHERE c.project=$1 AND c.name=$2`,
      [project,channelName])
    return rows.map(r=>r.agent_name)
  }
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
  identity_id?: string | null;
  reviewer_identity_id?: string | null;
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
  if (agentBezugAktiv()) {
    const {rows} = await getPool().query<SichtungsEintrag & {vermerk_bis:string|null}>(
      `WITH vermerke AS (
        SELECT project,channel,agent,identity_id,status,memory_name,gesichtet_von,gesichtet_am,bis_nachricht_id,reviewer_identity_id
        FROM agent_identitaet_channel_sichtung
        UNION ALL
        SELECT project,channel,agent,NULL::text,status,memory_name,gesichtet_von,gesichtet_am,bis_nachricht_id,reviewer_identity_id
        FROM channel_sichtung)
       SELECT m.sender AS agent,m.sender_identity_id AS identity_id,count(*)::int AS nachrichten,max(m.id)::int AS letzte_id,
         s.memory_name,s.gesichtet_von,s.reviewer_identity_id,to_char(s.gesichtet_am,'YYYY-MM-DD HH24:MI') AS gesichtet_am,
         s.bis_nachricht_id AS vermerk_bis,
         CASE WHEN s.project IS NULL THEN 'offen'
           WHEN s.bis_nachricht_id IS NOT NULL AND s.bis_nachricht_id<max(m.id) THEN 'veraltet'
           ELSE s.status END AS status
       FROM specialist_channel_messages m JOIN specialist_channels c ON c.id=m.channel_id
       LEFT JOIN vermerke s ON s.project=c.project AND s.channel=c.name
         AND s.identity_id IS NOT DISTINCT FROM m.sender_identity_id
         AND (s.identity_id IS NOT NULL OR s.agent=m.sender)
       WHERE c.project=$1 AND c.name=$2
       GROUP BY m.sender,m.sender_identity_id,s.project,s.status,s.memory_name,s.gesichtet_von,s.reviewer_identity_id,s.gesichtet_am,s.bis_nachricht_id
       ORDER BY count(*) DESC`,[project,channelName]);
    return rows.map(({vermerk_bis:_weg,...rest})=>rest);
  }
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
  identity_id?: string;
  status: 'gesichert' | 'nichts_verwertbares';
  memoryName?: string;
  notiz?: string;
  gesichtetVon: string;
}): Promise<{ ok: boolean; bis_nachricht_id: number | null; memory_markiert: boolean }> {
  const pool = getPool();
  const ziel=opts.identity_id
    ? await loeseAgentZiel(opts.project,{identity_id:opts.identity_id,...(opts.agent && !opts.agent.startsWith('identity:') ? {agent_id:opts.agent} : {})})
    : opts.agent.startsWith('identity:') ? await aufgeloestesKommunikationsZiel(opts.project,opts.agent) : null;
  if (ziel && !agentBezugAktiv()) throw new Error('agent_bezug_nicht_freigegeben');
  const identity=ziel?.art === 'identity' ? ziel.identity_id : null;
  const reviewer=aktuelleAgentIdentityId(opts.project,opts.gesichtetVon);
  const tabelle=identity ? 'agent_identitaet_channel_sichtung' : 'channel_sichtung';
  const { rows: maxRows } = await pool.query<{ letzte: string | null }>(
    `SELECT max(m.id) AS letzte
       FROM specialist_channel_messages m
       JOIN specialist_channels c ON c.id = m.channel_id
      WHERE c.project = $1 AND c.name = $2 AND ${agentBezugAktiv() ? (identity ? 'm.sender_identity_id=$3' : 'm.sender=$3 AND m.sender_identity_id IS NULL') : 'm.sender=$3'}`,
    [opts.project,opts.channel,identity ?? opts.agent],
  );
  const bis = maxRows[0]?.letzte ? Number(maxRows[0].letzte) : null;

  if (agentBezugAktiv()) {
    await pool.query(
      `INSERT INTO ${tabelle}(project,channel,agent,status,memory_name,bis_nachricht_id,notiz,gesichtet_von,gesichtet_am,reviewer_identity_id${identity ? ',identity_id' : ''})
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9${identity ? ',$10' : ''})
       ON CONFLICT(project,channel,${identity ? 'identity_id' : 'agent'}) DO UPDATE
       SET status=EXCLUDED.status,memory_name=EXCLUDED.memory_name,bis_nachricht_id=EXCLUDED.bis_nachricht_id,
         notiz=EXCLUDED.notiz,gesichtet_von=EXCLUDED.gesichtet_von,reviewer_identity_id=EXCLUDED.reviewer_identity_id,gesichtet_am=NOW()`,
      [opts.project,opts.channel,ziel?.agent_id ?? opts.agent,opts.status,opts.memoryName ?? null,bis,opts.notiz ?? null,opts.gesichtetVon,reviewer,...(identity ? [identity] : [])]);
  } else {
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
  }

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

/**
 * CH-5: Archivierte Channels sind per Vorgabe NICHT dabei. Wer sie sehen will, sagt es
 * ausdruecklich (mitArchiv) — sonst waere das Aufraeumen wirkungslos, weil die Liste gleich
 * lang bliebe. Die Daten sind unveraendert da, nur aus dem Weg.
 */
export async function listChannels(
  project?: string,
  opts: { mitArchiv?: boolean } = {},
): Promise<Array<{ name: string; project: string; description: string | null; archiviert_am?: string | null; letzte_aktivitaet?: string | null }>> {
  const pool = getPool()
  // P8-T29: Zeit der juengsten Nachricht je Channel (eine Abfrage, kein N+1); NULL = noch keine Nachricht.
  const letzteAktivitaet = `(SELECT to_char(MAX(m.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       FROM specialist_channel_messages m WHERE m.channel_id = specialist_channels.id) AS letzte_aktivitaet`
  const archivFilter = opts.mitArchiv ? '' : 'AND archiviert_am IS NULL'
  if (project) {
    const { rows } = await pool.query<{
      name: string
      project: string
      description: string | null
      archiviert_am: string | null
      letzte_aktivitaet: string | null
    }>(
      `SELECT name, project, description, archiviert_am, ${letzteAktivitaet}
       FROM specialist_channels
       WHERE project = $1 ${archivFilter}
       ORDER BY name`,
      [project],
    )
    return rows
  }
  const { rows } = await pool.query<{
    name: string; project: string; description: string | null; archiviert_am: string | null; letzte_aktivitaet: string | null
  }>(
    `SELECT name, project, description, archiviert_am, ${letzteAktivitaet}
     FROM specialist_channels
     ${opts.mitArchiv ? '' : 'WHERE archiviert_am IS NULL'}
     ORDER BY project, name`,
  )
  return rows
}

/**
 * CH-5: Einen ausgewerteten Channel ins Archiv legen.
 *
 * ⚠️ DER NAME WIRD DABEI FREIGEGEBEN, indem der alte Channel umbenannt wird
 * ("readme-update" -> "readme-update~archiv-20260815"). Ohne das bliebe er wegen
 * UNIQUE(name, project) belegt, und ein neuer Channel gleichen Namens waere unmoeglich.
 * Das Datum im Archivnamen erlaubt, denselben Namen spaeter erneut zu archivieren.
 *
 * GELOESCHT WIRD NICHTS. Nachrichten, Mitglieder und Sichtungsvermerke bleiben; der Channel
 * ist unter seinem Archivnamen vollstaendig abrufbar.
 *
 * AUSGENOMMEN IST DER STANDARDCHANNEL <projekt>-general (CH-7). Er ist keine Mission, die
 * einmal endet, sondern die Anlaufstelle des Projekts: ensureGeneralChannel legt ihn beim
 * Onboarding an, wenn er fehlt. Archivieren gibt den Namen frei — der naechste Agent wuerde
 * also still einen ZWEITEN Channel gleichen Namens erzeugen, und die Geschichte des Projekts
 * laege danach auf zwei Kanaelen, von denen einer unsichtbar ist. Sein Inhalt darf ausgewertet
 * und abgehakt werden; geschlossen wird er nie.
 */
export async function archiviereChannel(
  project: string,
  channelName: string,
): Promise<{ ok: boolean; archivname?: string; grund?: string }> {
  const pool = getPool()

  if (channelName === `${project}-general`) {
    return {
      ok: false,
      grund:
        `"${channelName}" ist der Standardchannel des Projekts und wird nicht archiviert. ` +
        'Archivieren gibt den Namen frei, und das Onboarding legt ihn danach neu an — es gaebe ' +
        'zwei Channels gleichen Namens. Auswerten und abhaken ja, schliessen nein.',
    }
  }

  const tag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const archivname = `${channelName}~archiv-${tag}`

  const { rows } = await pool.query<{ archiviert_am: string | null }>(
    'SELECT archiviert_am FROM specialist_channels WHERE project = $1 AND name = $2',
    [project, channelName],
  )
  if (rows.length === 0) return { ok: false, grund: 'Channel nicht gefunden.' }
  if (rows[0].archiviert_am) return { ok: false, grund: 'Channel ist bereits archiviert.' }

  await pool.query(
    'UPDATE specialist_channels SET name = $3, archiviert_am = NOW() WHERE project = $1 AND name = $2',
    [project, channelName, archivname],
  )
  // Der Sichtungsvermerk zeigt auf den Namen — er wandert mit, sonst steht er ins Leere.
  await pool.query(
    'UPDATE channel_sichtung SET channel = $3 WHERE project = $1 AND channel = $2',
    [project, channelName, archivname],
  )
  if (agentBezugAktiv()) await pool.query('UPDATE agent_identitaet_channel_sichtung SET channel=$3 WHERE project=$1 AND channel=$2',[project,channelName,archivname])
  return { ok: true, archivname }
}

/**
 * CH-8: Die Nachrichten eines Channels bis zu einer ID ins Archiv legen, OHNE den Channel
 * zu schliessen.
 *
 * GEDACHT FUER DEN STANDARDCHANNEL <projekt>-general. Der wird nie archiviert (CH-7, sonst
 * legt das Onboarding einen zweiten gleichen Namens an), waechst aber immer weiter. Wer ihn
 * ausgewertet hat, setzt hier den Schnitt: alles bis einschliesslich bisNachrichtId ist damit
 * aus dem Feed draussen, der Channel selbst bleibt offen und benutzbar.
 *
 * GELOESCHT WIRD NICHTS. channel(feed) mit archiv=true liefert weiterhin alles, und ein
 * Aufruf mit bisNachrichtId=null nimmt den Schnitt vollstaendig zurueck.
 */
export async function archiviereNachrichten(
  project: string,
  channelName: string,
  bisNachrichtId: number | null,
): Promise<{ ok: boolean; archiviert?: number; verbleibend?: number; grund?: string }> {
  const pool = getPool()

  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM specialist_channels WHERE project = $1 AND name = $2',
    [project, channelName],
  )
  if (rows.length === 0) return { ok: false, grund: 'Channel nicht gefunden.' }
  const channelId = rows[0].id

  if (bisNachrichtId !== null) {
    // Eine ID, die es im Channel gar nicht gibt, waere ein stiller Fehlgriff: der Schnitt
    // stuende dann irgendwo und niemand merkte es. Lieber ablehnen.
    const { rows: treffer } = await pool.query(
      'SELECT 1 FROM specialist_channel_messages WHERE channel_id = $1 AND id = $2',
      [channelId, bisNachrichtId],
    )
    if (treffer.length === 0) {
      return {
        ok: false,
        grund: `Nachricht ${bisNachrichtId} gehoert nicht zu "${channelName}". ` +
          'Nimm eine ID aus dem Feed dieses Channels.',
      }
    }
  }

  await pool.query(
    'UPDATE specialist_channels SET archiv_bis_nachricht_id = $3 WHERE project = $1 AND name = $2',
    [project, channelName, bisNachrichtId],
  )

  const { rows: zaehler } = await pool.query<{ archiviert: string; verbleibend: string }>(
    `SELECT COUNT(*) FILTER (WHERE $2::bigint IS NOT NULL AND id <= $2::bigint) AS archiviert,
            COUNT(*) FILTER (WHERE $2::bigint IS NULL OR id > $2::bigint)      AS verbleibend
       FROM specialist_channel_messages WHERE channel_id = $1`,
    [channelId, bisNachrichtId],
  )

  return {
    ok: true,
    archiviert: Number(zaehler[0].archiviert),
    verbleibend: Number(zaehler[0].verbleibend),
  }
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
  const z = eigenerKommunikationsAgent(agentName)
  const pool = getPool()
  const { rows } = await pool.query<{
    id: number
    channel_name: string
    sender: string
    sender_identity_id?: string | null
    content: string
    metadata: Record<string, unknown> | null
    created_at: Date
  }>(
    `SELECT cm.id, c.name AS channel_name, cm.sender, cm.content, cm.metadata, cm.created_at${agentBezugAktiv() ? ',cm.sender_identity_id' : ''}
     FROM specialist_channel_messages cm
     JOIN specialist_channels c ON c.id = cm.channel_id
     JOIN ${z.art === 'identity' ? 'agent_identitaet_channel_mitglieder' : 'specialist_channel_members'} mem ON mem.channel_id = c.id
     WHERE mem.${z.art === 'identity' ? 'identity_id' : 'agent_name'} = $1
       AND ${agentBezugAktiv() ? (z.art === 'identity' ? 'cm.sender_identity_id IS DISTINCT FROM $1' : '(cm.sender_identity_id IS NOT NULL OR cm.sender != $1)') : 'cm.sender != $1'}
       AND cm.id > $2
     ORDER BY cm.id
     LIMIT $3`,
    [bezugsWert(z), sinceId, Math.max(1, Math.floor(limit))],
  )
  return rows.map((r) => ({
    id: r.id,
    channelName: r.channel_name,
    sender: r.sender,
    ...(agentBezugAktiv() ? { senderIdentityId:r.sender_identity_id } : {}),
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
