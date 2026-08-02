/**
 * MODUL: pg-Umsetzung der Wrapper-Zugriffsschicht
 * ZWECK: Genau das Verhalten, das der Wrapper vorher direkt hatte — dieselben
 *        Funktionen, dieselben Abfragen, dieselbe Reihenfolge. Diese Datei ist
 *        bewusst eine Verschiebung und keine Verbesserung: sie ist der Massstab,
 *        an dem sich die api-Umsetzung messen lassen muss.
 *
 * EINZIGE NEUERUNG: jeder Aufruf laeuft durch die Buchhaltung. Das aendert am
 * Ablauf nichts, macht aber Fehlschlaege zaehlbar, die vorher in einem stillen
 * catch verschwunden sind (fetchCurrentChannels war so ein Fall).
 */

import pg from 'pg'
import {
  getPool,
  listMemories,
  getThoughtsByTag,
  getPlan,
  getPendingEvents,
  upsertWrapperStatus,
  getWrapperStatus,
  ensureSchema,
  getNewMessagesForAgent,
  getNewInboxMessages,
} from '@synapse/core'

import { Buchhaltung } from './zaehler.js'
import type {
  ChannelNachricht,
  HeartbeatKonfiguration,
  InboxNachricht,
  LiveEmpfaenger,
  SammelAnfrage,
  SammelErgebnis,
  StatusNutzlast,
  SynapseItems,
  TransportBilanz,
  TransportUmgebung,
  Wasserstaende,
  WrapperTransport,
} from './typen.js'

/**
 * Kanalname fuer LISTEN, als PostgreSQL-Bezeichner in Anfuehrungszeichen.
 *
 * ⚠️ GEMESSEN AM 02.08.2026: LISTEN synapse_specialist_wake_takt-probe ist fuer
 * PostgreSQL ein Syntaxfehler — ein Bindestrich beendet den Bezeichner. Da Namen wie
 * rollen-ist, agy-claude-opus oder takt-probe die Regel sind, traf das praktisch jeden
 * Spezialisten (12 Wrapper-Logs mit "syntax error at or near").
 * Der Schaden war groesser als der eine fehlende Kanal: der Wurf passierte VOR
 * listenClient.on('notification', ...), also wurde der Handler nie registriert und die
 * vier zuvor gelungenen LISTEN auf chat/channel/event/file liefen ins Leere. Der Wrapper
 * bekam ueberhaupt keine Benachrichtigungen mehr und hing allein an seinem Poll-Takt.
 * Auffaellig war das nie, weil der Heartbeat weiterlief — nur eben traege.
 *
 * pg_notify() auf der Sendeseite nimmt den Namen als Zeichenkette und war deshalb immer
 * korrekt; nur der LISTEN-Befehl braucht die Anfuehrungszeichen. Sie machen den Namen
 * zugleich gross-/kleinschreibungsgenau — was zur Sendeseite passt, die exakt vergleicht.
 */
function listenKanal(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

export class PgTransport implements WrapperTransport {
  readonly art = 'pg' as const

  private readonly buch: Buchhaltung
  private listenClient: pg.Client | null = null

  constructor(private readonly umgebung: TransportUmgebung) {
    // false: LISTEN schweigt stundenlang voellig zu Recht. Wer dort Stille
    // meldet, erzeugt nur Rauschen.
    this.buch = new Buchhaltung('pg', false)
  }

  bilanz(): TransportBilanz {
    return this.buch.lies()
  }

  async starte(): Promise<void> {
    await this.buch.messe('start', async () => {
      await ensureSchema()
    })
  }

  async leseHeartbeatKonfiguration(): Promise<HeartbeatKonfiguration | null> {
    if (!this.umgebung.projekt) return null
    return this.buch.messe('konfiguration', async () => {
      const zeile = await getWrapperStatus(this.umgebung.agentName, this.umgebung.projekt)
      if (!zeile) return null
      return {
        heartbeatEnabled: zeile.heartbeatEnabled,
        heartbeatIntervalMs: zeile.heartbeatIntervalMs,
      }
    })
  }

  /**
   * Sammelabruf ueber den pg-Weg: dieselben Abfragen wie bisher, nur gemeinsam
   * abgeschickt statt nacheinander. Es entsteht KEINE neue Abfrage und keine neue
   * Filterregel — waere das anders, waere der Massstab verstellt, an dem sich der
   * api-Weg messen lassen muss.
   *
   * Gebucht wird weiterhin je Einzelabfrage und NICHT als ein Sammelaufruf. Der
   * pg-Weg macht wirklich mehrere Runden zur Datenbank; sie als eine zu zaehlen
   * wuerde genau den Vergleich schoenrechnen, um den es hier geht.
   *
   * Nie gekuerzt: getNewMessagesForAgent und getNewInboxMessages kennen kein
   * limit, sie liefern alles ab dem Wasserstand. nochMehr ist hier also immer false.
   */
  async holeAlles(anfrage: SammelAnfrage): Promise<SammelErgebnis> {
    if (!anfrage.mitInhalt) {
      return {
        config: await this.leseHeartbeatKonfiguration(),
        channels: null,
        channelNachrichten: [],
        inbox: [],
        items: null,
        unquittiert: null,
        nochMehr: false,
      }
    }

    const [config, channels, channelNachrichten, inbox, items] = await Promise.all([
      this.leseHeartbeatKonfiguration(),
      this.leseChannels(),
      this.leseNeueChannelNachrichten(anfrage.channelSeitId),
      this.leseNeueInboxNachrichten(anfrage.inboxSeitId),
      anfrage.mitItems ? this.leseSynapseItems() : Promise.resolve(null),
    ])

    return {
      config,
      channels,
      channelNachrichten,
      inbox,
      items,
      // Siehe SammelErgebnis.unquittiert: die Zahl belegt einen Verlust, den es
      // nur zwischen zwei HTTP-Aufrufen geben kann. Hier waere sie eine eigene
      // Abfrage je Takt ohne Aussage.
      unquittiert: null,
      nochMehr: false,
    }
  }

  async leseWasserstaende(): Promise<Wasserstaende> {
    return this.buch.messe('wasserstaende', async () => {
      const pool = getPool()
      const channelResult = await pool.query<{ max_id: number }>(
        `SELECT COALESCE(MAX(cm.id), 0)::int AS max_id
         FROM specialist_channel_messages cm
         JOIN specialist_channels c ON c.id = cm.channel_id
         JOIN specialist_channel_members mem ON mem.channel_id = c.id
         WHERE mem.agent_name = $1`,
        [this.umgebung.agentName],
      )
      const inboxResult = await pool.query<{ max_id: number }>(
        `SELECT COALESCE(MAX(id), 0)::int AS max_id
         FROM specialist_inbox
         WHERE to_agent = $1`,
        [this.umgebung.agentName],
      )
      return {
        channel: channelResult.rows[0]?.max_id ?? 0,
        inbox: inboxResult.rows[0]?.max_id ?? 0,
      }
    })
  }

  async leseChannels(): Promise<string[]> {
    if (!this.umgebung.projekt) return []
    return this.buch.messe('channels', async () => {
      const pool = getPool()
      const { rows } = await pool.query<{ channel_name: string }>(
        `SELECT c.name AS channel_name
         FROM specialist_channels c
         JOIN specialist_channel_members m ON m.channel_id = c.id
         WHERE m.agent_name = $1
         ORDER BY c.name`,
        [this.umgebung.agentName],
      )
      return rows.map((r) => r.channel_name)
    })
  }

  async leseNeueChannelNachrichten(seitId: number): Promise<ChannelNachricht[]> {
    return this.buch.messe('channel-nachrichten', async () => {
      const nachrichten = await getNewMessagesForAgent(this.umgebung.agentName, seitId)
      return nachrichten.map((m) => ({
        id: m.id,
        channelName: m.channelName,
        sender: m.sender,
        content: m.content,
      }))
    })
  }

  async leseNeueInboxNachrichten(seitId: number): Promise<InboxNachricht[]> {
    return this.buch.messe('inbox', async () => {
      const nachrichten = await getNewInboxMessages(this.umgebung.agentName, seitId)
      return nachrichten.map((m) => ({
        id: m.id,
        fromAgent: m.fromAgent,
        content: m.content,
      }))
    })
  }

  async quittiereInbox(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    await this.buch.messe('inbox-quittung', async () => {
      const pool = getPool()
      await pool.query(
        `UPDATE specialist_inbox SET processed = true WHERE id = ANY($1::int[])`,
        [ids],
      )
    })
  }

  async leseSynapseItems(): Promise<SynapseItems> {
    if (!this.umgebung.projekt) {
      return { memories: [], thoughts: [], tasks: [], events: [] }
    }
    return this.buch.messe('items', async () => {
      const projekt = this.umgebung.projekt
      const agent = this.umgebung.agentName

      // Reihenfolge und Filter exakt wie vorher in pollSynapseItems.
      const memories = await listMemories(projekt)
      const meineMemories = memories
        .filter((m) => m.tags?.includes(agent))
        .map((m) => ({ name: m.name, content: m.content }))

      const thoughts = await getThoughtsByTag(projekt, agent, 10)
      const meineThoughts = thoughts.map((t) => ({ id: String(t.id), content: t.content }))

      const plan = await getPlan(projekt)
      const nameKlein = agent.toLowerCase()
      const meineTasks = (plan?.tasks ?? [])
        .filter(
          (t) =>
            t.title.toLowerCase().includes(nameKlein) &&
            (t.status === 'todo' || t.status === 'in_progress'),
        )
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          description: t.description,
        }))

      const events = await getPendingEvents(projekt, agent)
      const meineEvents = events.map((e) => ({
        id: e.id,
        eventType: String(e.eventType),
        priority: String(e.priority),
        payload: e.payload,
      }))

      return {
        memories: meineMemories,
        thoughts: meineThoughts,
        tasks: meineTasks,
        events: meineEvents,
      }
    })
  }

  async schreibeStatus(status: StatusNutzlast): Promise<void> {
    await this.buch.messe('status', async () => {
      await upsertWrapperStatus(status)
    })
  }

  /**
   * LISTEN auf die vier bekannten Kanaele plus den eigenen Wake-Kanal.
   * Uebersetzt die Nutzlasten in LiveEreignis — der Wrapper sieht keine
   * PostgreSQL-Nutzlast mehr, nur noch das Ereignis.
   */
  async starteLiveKanal(empfaenger: LiveEmpfaenger): Promise<void> {
    const { agentName, projekt, log } = this.umgebung
    try {
      // Dedicated Client weil LISTEN den Connection blockt — nicht aus dem Pool.
      this.listenClient = new pg.Client({ connectionString: process.env.DATABASE_URL })
      await this.listenClient.connect()
      await this.listenClient.query('LISTEN synapse_chat')
      await this.listenClient.query('LISTEN synapse_channel')
      await this.listenClient.query('LISTEN synapse_event')
      await this.listenClient.query('LISTEN synapse_file')
      // Spezialist-Wake via NOTIFY (Fast-Path; Inbox bleibt Fallback)
      await this.listenClient.query(`LISTEN ${listenKanal(`synapse_specialist_wake_${agentName}`)}`)

      this.listenClient.on('notification', (msg) => {
        const kanal = msg.channel ?? '<unknown>'
        this.buch.liveEreignisGesehen()

        // Spezialist-Wake: Nachricht in die Queue, naechster Heartbeat verarbeitet sie.
        if (kanal === `synapse_specialist_wake_${agentName}` && msg.payload) {
          try {
            const p = JSON.parse(msg.payload) as { message?: string; project?: string }
            if (p.message && (!p.project || p.project === projekt)) {
              empfaenger({ art: 'wake', nachricht: p.message })
            }
          } catch {
            /* ignore parse errors */
          }
          return // Kein weiterer Hinweis — so war es vorher auch.
        }

        // File-Changes: Nutzlast puffern (Echo-Schutz + Projekt-Filter).
        if (kanal === 'synapse_file' && msg.payload) {
          try {
            const p = JSON.parse(msg.payload) as {
              project?: string
              file_path?: string
              edit_action?: string
              agent_id?: string
            }
            if (p.project === projekt && p.agent_id !== agentName && p.file_path) {
              empfaenger({
                art: 'datei',
                pfad: p.file_path,
                aktion: p.edit_action ?? 'change',
                agent: p.agent_id ?? '',
              })
            }
          } catch {
            /* ignore parse errors */
          }
        }

        // File-Changes sind 'hot' (Real-Time), andere Ereignisse nur 'warm'.
        // ⚠️ Der Hinweis kommt bei synapse_file AUCH DANN, wenn die Nutzlast oben
        // weggefiltert wurde — genau wie vorher.
        empfaenger({ art: 'hinweis', kanal, stufe: kanal === 'synapse_file' ? 'hot' : 'warm' })
      })

      this.listenClient.on('error', (err) => {
        this.buch.liveVerbindungWeg(err.message)
        log('PG-LISTEN error: %s — neu verbinden bei naechstem Heartbeat', err.message)
      })

      this.buch.liveVerbindungSteht()
      log(
        'PG-LISTEN aktiv: synapse_chat, synapse_channel, synapse_event, synapse_file, synapse_specialist_wake_%s',
        agentName,
      )
    } catch (err) {
      const grund = err instanceof Error ? err.message : String(err)
      this.buch.liveVerbindungWeg(grund)
      log('PG-LISTEN-Setup fehlgeschlagen (Heartbeat laeuft trotzdem): %s', grund)
    }
  }

  async beendeLiveKanal(): Promise<void> {
    if (!this.listenClient) return
    try {
      await this.listenClient.end()
    } catch {
      /* ignore */
    }
    this.listenClient = null
    this.buch.liveVerbindungWeg(null, true)
  }
}
