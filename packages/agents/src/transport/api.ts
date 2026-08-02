/**
 * MODUL: api-Umsetzung der Wrapper-Zugriffsschicht
 * ZWECK: Dieselben Faehigkeiten wie der pg-Weg, aber ueber HTTP gegen die
 *        synapse-api mit Bearer-Token. Ziel ist ein Wrapper, der keine
 *        Datenbankverbindung mehr braucht und deshalb auch woanders laufen kann.
 *
 * STAND: gebaut gegen den im Channel api-bruecke vereinbarten Vertrag (v1).
 *        Die Routen entstehen parallel in packages/rest-api. Solange sie fehlen,
 *        scheitert dieser Weg — LAUT, nicht still (siehe unten).
 *
 * SICHTBARKEIT — der eigentliche Punkt dieser Datei:
 *   Ein HTTP-Weg kann auf eine Art kaputtgehen, die der pg-Weg nicht kennt: das
 *   Token laeuft ab. Dann scheitert ALLES gleichzeitig mit 401, der Wrapper
 *   bekommt keine Nachrichten mehr, weckt niemanden mehr, schreibt keinen Status
 *   mehr — und sieht dabei aus wie ein Agent, an den gerade niemand schreibt.
 *   Deshalb: 401/403 wird bei JEDEM Vorkommen protokolliert und getrennt gezaehlt,
 *   und der Bilanz-Waechter meldet zusaetzlich laengere Stille von selbst.
 *
 * WAS DIESER WEG NICHT KANN:
 *   ensureSchema. DDL gehoert nicht in einen entfernten Wrapper; starte() meldet
 *   sich stattdessen an. Das ist kein Verlust, sondern der Sinn der Sache.
 *
 * BEKANNTE KOSTEN (gemessen wird das erst in Schritt 3):
 *   Ein Heartbeat-Tick loest hier mehrere HTTP-Aufrufe aus, wo der pg-Weg mehrere
 *   Abfragen im LAN macht. Der Vertrag sieht mit GET /poll einen Sammelabruf vor,
 *   der alles in EINEN Aufruf legt. Er ist hier bewusst noch NICHT verdrahtet:
 *   dafuer muss der Tick in wrapper.ts umgebaut werden, und das gehoert zu
 *   Schritt 3, nicht in einen Umbau, der pg unveraendert lassen soll.
 */

import { Buchhaltung } from './zaehler.js'
import type {
  ChannelNachricht,
  Faehigkeit,
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

const ZEITLIMIT_MS = 15_000
const RUECKZUG_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Hoechstwert der Route (ihre Vorgabe waere 200). Wer alles will, fragt gross. */
const SAMMEL_LIMIT = 500
/** So oft wird bei gekuerzter Antwort im SELBEN Takt nachgefasst. */
const MAX_NACHFASS_RUNDEN = 10

interface RufOptionen {
  methode?: string
  koerper?: unknown
  /** 404 ist bei /config eine gueltige Antwort ("noch keine Zeile"), kein Fehler. */
  leerBei404?: boolean
}

export class ApiTransport implements WrapperTransport {
  readonly art = 'api' as const

  private readonly basis: string
  private readonly token: string
  private readonly buch: Buchhaltung

  private empfaenger: LiveEmpfaenger | null = null
  private streamAbbruch: AbortController | null = null
  private beendet = false
  private angemeldet = false
  /** Gerade verbunden? Steuert die Uebergangsmeldungen. */
  private warVerbunden = false
  /**
   * Schon einmal verbunden gewesen? Braucht ein EIGENES Feld: waere es dasselbe wie
   * warVerbunden, saehe jede Rueckkehr aus wie ein Erstverbinden — die Wiederkehr
   * bliebe stumm und loeste keinen Poll aus. Genau das ist im Test passiert.
   */
  private jeVerbunden = false
  private letzteServerReconnects: number | null = null
  private taktAbgeschaltet = false

  constructor(private readonly umgebung: TransportUmgebung) {
    const url = (process.env.SYNAPSE_API_URL ?? '').trim().replace(/\/+$/, '')
    const token = (process.env.SYNAPSE_API_TOKEN ?? '').trim()

    if (!url || !token || !umgebung.projekt) {
      // Kein stiller Rueckfall auf den pg-Weg: ein Wrapper, der anders arbeitet
      // als angefordert, ist genau der Fehler, den diese Schicht verhindern soll.
      throw new Error(
        'SYNAPSE_WRAPPER_TRANSPORT=api verlangt SYNAPSE_API_URL, SYNAPSE_API_TOKEN und ein Projekt ' +
          `(url=${url ? 'gesetzt' : 'FEHLT'}, token=${token ? 'gesetzt' : 'FEHLT'}, ` +
          `projekt=${umgebung.projekt ? umgebung.projekt : 'FEHLT'}). ` +
          'Ich falle bewusst NICHT auf den pg-Weg zurueck, sonst laeuft der Wrapper unbemerkt anders als bestellt.',
      )
    }

    this.basis =
      `${url}/api/projects/${encodeURIComponent(umgebung.projekt)}` +
      `/specialists/${encodeURIComponent(umgebung.agentName)}`
    this.token = token
    // true: dieser Weg schickt ein regelmaessiges Takt-Signal, Stille ist hier ein Befund.
    this.buch = new Buchhaltung('api', true)
  }

  bilanz(): TransportBilanz {
    return this.buch.lies()
  }

  // -------------------------------------------------------------------------
  // HTTP-Grundlage
  // -------------------------------------------------------------------------

  private async ruf<T>(
    faehigkeit: Faehigkeit,
    pfad: string,
    optionen: RufOptionen = {},
  ): Promise<T | null> {
    return this.buch.messe(faehigkeit, async () => {
      const kopf: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      }
      if (optionen.koerper !== undefined) kopf['Content-Type'] = 'application/json'

      const antwort = await fetch(`${this.basis}${pfad}`, {
        method: optionen.methode ?? 'GET',
        headers: kopf,
        body: optionen.koerper !== undefined ? JSON.stringify(optionen.koerper) : undefined,
        signal: AbortSignal.timeout(ZEITLIMIT_MS),
      })

      if (antwort.status === 401 || antwort.status === 403) {
        this.buch.zaehleAblehnung()
        this.umgebung.log(
          'TOKEN ABGELEHNT (%d) bei %s — ab jetzt scheitert JEDER Aufruf. Der Wrapper bekommt keine ' +
            'Nachrichten mehr; das sieht im Log sonst aus wie Ruhe.',
          antwort.status,
          pfad,
        )
        throw new Error(`HTTP ${antwort.status} bei ${pfad} (Token abgelehnt)`)
      }

      if (antwort.status === 404 && optionen.leerBei404) return null

      if (!antwort.ok) {
        throw new Error(`HTTP ${antwort.status} bei ${pfad}`)
      }

      const daten = (await antwort.json()) as Record<string, unknown>
      if (daten && daten.success === false) {
        const fehler = daten.error as { message?: string } | undefined
        throw new Error(`API meldet Fehler bei ${pfad}: ${fehler?.message ?? 'ohne Begruendung'}`)
      }
      return daten as T
    })
  }

  /** Wie ruf(), aber eine leere Antwort ist hier ein Vertragsbruch und kein Zustand. */
  private async rufPflicht<T>(
    faehigkeit: Faehigkeit,
    pfad: string,
    optionen: RufOptionen = {},
  ): Promise<T> {
    const daten = await this.ruf<T>(faehigkeit, pfad, optionen)
    if (daten === null) throw new Error(`Leere Antwort von ${pfad}`)
    return daten
  }

  // -------------------------------------------------------------------------
  // Faehigkeiten
  // -------------------------------------------------------------------------

  async starte(): Promise<void> {
    await this.melde()
  }

  private async melde(): Promise<void> {
    await this.rufPflicht('start', '/register', {
      methode: 'POST',
      koerper: { transport: 'api', wrapper_pid: process.pid, status: 'running' },
    })
    this.angemeldet = true
    this.umgebung.log('Bei der synapse-api angemeldet (%s)', this.basis)
  }

  private async holeConfig(): Promise<Record<string, unknown> | null> {
    const daten = await this.ruf<Record<string, unknown>>('konfiguration', '/config', { leerBei404: true })
    this.pruefeStrom(daten)
    return daten
  }

  async leseHeartbeatKonfiguration(): Promise<HeartbeatKonfiguration | null> {
    const daten = await this.holeConfig()
    if (daten === null) return null
    if (daten.exists === false) return null
    return this.deuteConfig(daten.config, '/config', false)
  }

  /**
   * Wertet den config-Block aus — fuer /config UND fuer /poll, damit beide Wege
   * denselben Takt lesen und nicht zwei Auslegungen desselben Feldes entstehen.
   *
   * fehlenErlaubt unterscheidet die beiden Sonderfaelle, die gleich AUSSEHEN und
   * verschieden GEMEINT sind:
   *   /config ohne wrapper_status-Zeile antwortet mit 404 (oben abgefangen); ein
   *   fehlendes config-Feld in einer 200er-Antwort ist dort ein Vertragsbruch und
   *   muss laut sein — sonst laeuft der Wrapper ohne gelesenen Takt adaptiv weiter
   *   und sieht dabei voellig normal aus.
   *   /poll liefert ohne Zeile bewusst config:null UND trotzdem Nachrichten. Das
   *   ist kein Fehler, sondern heisst: letzte bekannte Einstellung behalten.
   */
  private deuteConfig(
    roh: unknown,
    quelle: string,
    fehlenErlaubt: boolean,
  ): HeartbeatKonfiguration | null {
    if (roh === null || roh === undefined) {
      if (fehlenErlaubt) return null
      throw new Error(`Antwort von ${quelle} enthaelt kein Feld "config" — Vertrag verletzt`)
    }
    const config = roh as Record<string, unknown>

    const aktiv = config.heartbeat_enabled ?? config.heartbeatEnabled
    const takt = config.heartbeat_interval_ms ?? config.heartbeatIntervalMs

    if (typeof aktiv !== 'boolean') {
      // Bewusst hart: waere das hier tolerant, verloere der api-Weg die
      // Abschaltbarkeit, und zwar unbemerkt — ein Wrapper ohne gelesene
      // Konfiguration laeuft einfach adaptiv weiter und sieht normal aus.
      throw new Error(
        `Feld heartbeat_enabled fehlt in der Antwort von ${quelle} oder ist kein Wahrheitswert — Takt waere nicht mehr steuerbar`,
      )
    }
    if (takt !== null && takt !== undefined && typeof takt !== 'number') {
      throw new Error(
        `Feld heartbeat_interval_ms aus ${quelle} ist weder Zahl noch null — Takt waere nicht mehr steuerbar`,
      )
    }

    // Gemerkt, weil es die Bewertung einer Luecke aendert: ein abgeschalteter
    // Wrapper pollt nicht und holt sie deshalb NICHT von selbst auf.
    this.taktAbgeschaltet = !aktiv
    return {
      heartbeatEnabled: aktiv,
      heartbeatIntervalMs: typeof takt === 'number' ? takt : null,
    }
  }

  async leseWasserstaende(): Promise<Wasserstaende> {
    type Antwort = { watermarks?: Record<string, unknown> }
    let daten = await this.ruf<Antwort>('wasserstaende', '/watermarks', { leerBei404: true })

    // Beim allerersten Start gibt es die wrapper_status-Zeile noch nicht. Dann
    // erst anmelden und ein zweites Mal fragen — sonst startet der Wrapper bei 0
    // und flutet seinen Agenten mit der gesamten Historie.
    if (daten === null && !this.angemeldet) {
      await this.melde()
      daten = await this.ruf<Antwort>('wasserstaende', '/watermarks', { leerBei404: true })
    }
    if (daten === null) {
      throw new Error('Wasserstaende nicht abrufbar: /watermarks liefert keine Zeile')
    }

    const stand = daten.watermarks
    if (!stand) throw new Error('Antwort von /watermarks enthaelt kein Feld "watermarks" — Vertrag verletzt')

    const kanal = stand.channel ?? stand.channel_msg_id
    const inbox = stand.inbox ?? stand.inbox_msg_id
    if (typeof kanal !== 'number' || typeof inbox !== 'number') {
      throw new Error('watermarks enthaelt keine Zahlen — ein falscher Startwert flutet den Agenten')
    }
    // ⚠️ Von bruecke-api gemessen: /watermarks kann um eins ueber dem watermark der
    // Nachrichtenroute liegen, weil MAX(id) auch die EIGENEN Nachrichten des Agenten
    // zaehlt, die er nie zugestellt bekommt. Genau so ist es im pg-Weg auch.
    return { channel: kanal, inbox }
  }

  async leseChannels(): Promise<string[]> {
    const daten = await this.ruf<{ channels?: unknown }>('channels', '/channels', { leerBei404: true })
    if (daten === null) return []
    if (!Array.isArray(daten.channels)) {
      throw new Error('Antwort von /channels enthaelt kein Feld "channels" — Vertrag verletzt')
    }
    return daten.channels.map((c) => String(c))
  }

  async leseNeueChannelNachrichten(seitId: number): Promise<ChannelNachricht[]> {
    const daten = await this.rufPflicht<{ messages?: unknown; truncated?: unknown }>(
      'channel-nachrichten',
      `/channel-messages?since_id=${seitId}`,
    )
    const roh = daten.messages
    if (!Array.isArray(roh)) {
      throw new Error('Antwort von /channel-messages enthaelt kein Feld "messages" — Vertrag verletzt')
    }
    if (daten.truncated === true) {
      // Bewusst NICHT im selben Takt nachfassen: der Wrapper baut aus diesen
      // Nachrichten EINEN Wake-Prompt, und ein Nachladen wuerde ihn sprengen.
      // Der naechste Takt holt den Rest ab dem neuen Wasserstand.
      this.umgebung.log(
        'Channel-Abruf gekuerzt (Hoechstzahl erreicht) — %d Nachrichten geliefert, der Rest folgt im naechsten Takt.',
        roh.length,
      )
    }
    return ApiTransport.alsChannelNachrichten(roh)
  }

  /** EINE Stelle fuer die Abbildung — /channel-messages und /poll liefern dieselbe Form. */
  private static alsChannelNachrichten(roh: unknown[]): ChannelNachricht[] {
    return roh.map((eintrag) => {
      const m = eintrag as Record<string, unknown>
      return {
        id: Number(m.id),
        channelName: String(m.channelName ?? m.channel_name ?? ''),
        sender: String(m.sender ?? ''),
        content: String(m.content ?? ''),
      }
    })
  }

  async leseNeueInboxNachrichten(seitId: number): Promise<InboxNachricht[]> {
    const daten = await this.rufPflicht<{ messages?: unknown; truncated?: unknown }>(
      'inbox',
      `/inbox?since_id=${seitId}`,
    )
    const roh = daten.messages
    if (!Array.isArray(roh)) {
      throw new Error('Antwort von /inbox enthaelt kein Feld "messages" — Vertrag verletzt')
    }
    if (daten.truncated === true) {
      this.umgebung.log(
        'Inbox-Abruf gekuerzt (Hoechstzahl erreicht) — %d Nachrichten geliefert, der Rest folgt im naechsten Takt.',
        roh.length,
      )
    }
    return ApiTransport.alsInboxNachrichten(roh)
  }

  /** EINE Stelle fuer die Abbildung — /inbox und /poll liefern dieselbe Form. */
  private static alsInboxNachrichten(roh: unknown[]): InboxNachricht[] {
    return roh.map((eintrag) => {
      const m = eintrag as Record<string, unknown>
      return {
        id: Number(m.id),
        fromAgent: String(m.fromAgent ?? m.from_agent ?? ''),
        content: String(m.content ?? ''),
      }
    })
  }

  async quittiereInbox(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    const daten = await this.rufPflicht<{ updated?: unknown; acked?: unknown; unacked_count?: unknown }>(
      'inbox-quittung',
      '/inbox/ack',
      { methode: 'POST', koerper: { ids } },
    )
    // Lesen und Quittieren sind ueber HTTP zwei Aufrufe. Reisst die Verbindung
    // dazwischen, bleibt die Nachricht unquittiert liegen — und das sieht man
    // sonst nirgends. Also hier sagen. ("updated" ist der Name der Route,
    // "acked" derselbe Wert als Zweitname.)
    const rohZahl = daten.updated ?? daten.acked
    const quittiert = typeof rohZahl === 'number' ? rohZahl : null
    if (quittiert !== null && quittiert < ids.length) {
      this.umgebung.log(
        'Inbox-Quittung unvollstaendig: %d von %d bestaetigt (unacked_count=%s). Die Nachrichten bleiben liegen.',
        quittiert,
        ids.length,
        String(daten.unacked_count ?? 'unbekannt'),
      )
    }
  }

  async leseSynapseItems(): Promise<SynapseItems> {
    const daten = await this.rufPflicht<Record<string, unknown>>('items', '/items')
    return ApiTransport.alsItems(daten, '/items')
  }

  /**
   * Der Vertrag legt die vier Listen auf die oberste Ebene; ein Unterobjekt
   * "items" wird ebenfalls akzeptiert — so liefert es /poll. Fehlt eine Liste
   * ganz, ist das ein Fehler und KEINE leere Liste: sonst verschwaende ein
   * Vertragsbruch lautlos die Arbeit des Agenten.
   */
  private static alsItems(daten: Record<string, unknown>, pfad: string): SynapseItems {
    const quelle = (daten.items as Record<string, unknown> | undefined) ?? daten

    const liste = (name: string): Record<string, unknown>[] => {
      const wert = quelle[name]
      if (!Array.isArray(wert)) {
        throw new Error(`Antwort von ${pfad} enthaelt kein Feld "${name}" — Vertrag verletzt`)
      }
      return wert as Record<string, unknown>[]
    }

    return {
      memories: liste('memories').map((m) => ({
        name: String(m.name ?? ''),
        content: String(m.content ?? ''),
      })),
      thoughts: liste('thoughts').map((t) => ({
        id: String(t.id ?? ''),
        content: String(t.content ?? ''),
      })),
      tasks: liste('tasks').map((t) => ({
        id: String(t.id ?? ''),
        title: String(t.title ?? ''),
        status: String(t.status ?? ''),
        priority: String(t.priority ?? ''),
        description: String(t.description ?? ''),
      })),
      events: liste('events').map((e) => ({
        id: Number(e.id),
        eventType: String(e.eventType ?? e.event_type ?? ''),
        priority: String(e.priority ?? ''),
        payload: e.payload === null || e.payload === undefined ? null : String(e.payload),
      })),
    }
  }

  /**
   * DER SAMMELABRUF. Ein Aufruf statt vier — das ist die Stelle, an der der
   * api-Weg aufhoert, langsamer zu sein als der pg-Weg, den er ersetzen soll.
   *
   * ZWEI SONDERFAELLE, an denen man hier scheitert, ohne dass es auffaellt:
   * a) config:null. /poll antwortet OHNE wrapper_status-Zeile bewusst nicht mit
   *    404, sondern mit config:null UND trotzdem Nachrichten — ein fehlender
   *    Statuseintrag darf einen Agenten nicht von seiner Post abschneiden. Genau
   *    wie ein 404 bei /config heisst das: letzte bekannte Einstellung behalten.
   * b) truncated. Die Route kappt bei limit. Wer dann nicht nachfasst, laesst Post
   *    liegen und merkt es nie — ein Wrapper, der nach 200 Nachrichten still
   *    aufhoert, ist genau die Fehlerform dieses Projekts. Also wird im SELBEN
   *    Takt mit dem neuen Wasserstand nachgefasst, bis nichts mehr gekappt ist.
   *    Reicht auch das nicht, steht es im Log und in nochMehr, statt still zu enden.
   */
  async holeAlles(anfrage: SammelAnfrage): Promise<SammelErgebnis> {
    if (!anfrage.mitInhalt) {
      // Abgeschalteter oder beschaeftigter Wrapper: nur nachsehen, ob er wieder
      // anfangen darf. Ein Aufruf, so wie frueher auch.
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

    const pfad = (chSeit: number, ibSeit: number, mitItems: boolean): string =>
      `/poll?channel_since_id=${chSeit}&inbox_since_id=${ibSeit}` +
      `&items=${mitItems ? '1' : '0'}&limit=${SAMMEL_LIMIT}`

    let daten = await this.rufPflicht<Record<string, unknown>>(
      'sammel',
      pfad(anfrage.channelSeitId, anfrage.inboxSeitId, anfrage.mitItems),
    )
    this.pruefeStrom(daten)

    const config = this.deuteConfig(daten.config, '/poll', true)
    const channels = Array.isArray(daten.channels) ? daten.channels.map((c) => String(c)) : null
    const items = anfrage.mitItems ? ApiTransport.alsItems(daten, '/poll') : null
    const unquittiert = typeof daten.unacked_count === 'number' ? daten.unacked_count : null

    const channelNachrichten = ApiTransport.alsChannelNachrichten(this.liste(daten, 'channel_messages'))
    const inbox = ApiTransport.alsInboxNachrichten(this.liste(daten, 'inbox'))

    let gekappt = ApiTransport.gekappt(daten)
    let runde = 0
    while (gekappt && runde < MAX_NACHFASS_RUNDEN) {
      runde++
      const chSeit =
        channelNachrichten.length > 0
          ? channelNachrichten[channelNachrichten.length - 1].id
          : anfrage.channelSeitId
      const ibSeit = inbox.length > 0 ? inbox[inbox.length - 1].id : anfrage.inboxSeitId
      this.umgebung.log(
        'Sammelabruf war gekuerzt (bisher %d Channel-, %d Inbox-Nachrichten) — es wird SOFORT nachgefasst ' +
          '(Runde %d, ab channel>%d inbox>%d). Wer hier aufhoert, laesst Post liegen und merkt es nie.',
        channelNachrichten.length,
        inbox.length,
        runde,
        chSeit,
        ibSeit,
      )
      // items nur im ersten Aufruf: sie haengen nicht am Wasserstand und waeren
      // beim Nachfassen dieselben.
      daten = await this.rufPflicht<Record<string, unknown>>('sammel', pfad(chSeit, ibSeit, false))
      this.pruefeStrom(daten)
      const mehrChannel = ApiTransport.alsChannelNachrichten(this.liste(daten, 'channel_messages'))
      const mehrInbox = ApiTransport.alsInboxNachrichten(this.liste(daten, 'inbox'))
      channelNachrichten.push(...mehrChannel)
      inbox.push(...mehrInbox)
      gekappt = ApiTransport.gekappt(daten)
      if (mehrChannel.length === 0 && mehrInbox.length === 0) {
        // Nichts mehr gekommen, obwohl gekuerzt gemeldet wurde. Weiterdrehen
        // waere eine Endlosschleife — also abbrechen und es sagen.
        if (gekappt) {
          this.umgebung.log(
            'Nachfassen liefert nichts mehr, obwohl die Antwort als gekuerzt gilt — Abbruch, damit hier keine Schleife entsteht.',
          )
        }
        break
      }
    }

    if (gekappt) {
      this.umgebung.log(
        '⚠️ Nach %d Nachfass-Runden ist immer noch etwas offen. Der Rest kommt im naechsten Takt ' +
          '(der Wasserstand ist vorgerueckt, verloren geht nichts) — aber hier staut sich Post.',
        runde,
      )
    }

    return { config, channels, channelNachrichten, inbox, items, unquittiert, nochMehr: gekappt }
  }

  /** Pflichtliste aus der Sammelantwort. Fehlt sie, ist das ein Vertragsbruch und keine Leere. */
  private liste(daten: Record<string, unknown>, name: string): unknown[] {
    const wert = daten[name]
    if (!Array.isArray(wert)) {
      throw new Error(`Antwort von /poll enthaelt kein Feld "${name}" — Vertrag verletzt`)
    }
    return wert
  }

  /** truncated ist ein Objekt {channel_messages, inbox}; ein blosses true gilt auch. */
  private static gekappt(daten: Record<string, unknown>): boolean {
    const t = daten.truncated
    if (t === true) return true
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>
      return o.channel_messages === true || o.inbox === true
    }
    return false
  }

  async schreibeStatus(status: StatusNutzlast): Promise<void> {
    const daten = await this.rufPflicht<Record<string, unknown>>('status', '/status', {
      methode: 'POST',
      koerper: status,
    })
    this.pruefeStrom(daten)
  }

  /**
   * Die API meldet in jeder config/status/poll-Antwort, wie oft ihr LISTEN-Client
   * seit dem Start neu verbinden musste. Steigt die Zahl zwischen zwei Takten,
   * hatte der Live-Kanal ein Loch.
   *
   * ⚠️ WARUM DAS NOETIG IST: die eigene SSE-Verbindung merkt davon NICHTS. Sie
   * haengt am HTTP-Socket, nicht an der Datenbank. Gemessen auf der Serverseite:
   * die Datenbanksitzung wurde beendet, der Server war rund eine Sekunde blind und
   * kam von selbst zurueck — der Strom blieb die ganze Zeit offen. Fuer den Wrapper
   * sah diese Sekunde aus wie ein ruhiger Moment.
   * Eine Luecke, die niemand zaehlt, ist eine Luecke, die niemand findet.
   */
  private pruefeStrom(daten: Record<string, unknown> | null): void {
    if (!daten) return
    const strom = daten.stream as Record<string, unknown> | undefined
    if (!strom) return
    const zahl = strom.listener_reconnects
    if (typeof zahl !== 'number') return

    const vorher = this.letzteServerReconnects
    this.letzteServerReconnects = zahl
    if (vorher === null || zahl <= vorher) return

    const neue = zahl - vorher
    this.buch.zaehleServerLuecken(neue)
    this.umgebung.log(
      'LUECKE im Live-Kanal: der LISTEN-Client der API hat seit dem letzten Takt %dmal neu verbunden ' +
        '(letzte Luecke %sms, %s). Meine SSE-Verbindung hat davon nichts gemerkt — sie haengt am ' +
        'HTTP-Socket, nicht an der Datenbank.',
      neue,
      String(strom.listener_last_gap_ms ?? 'unbekannt'),
      String(strom.listener_last_reconnect_at ?? 'ohne Zeitangabe'),
    )

    // Im Regelfall schliesst sich die Luecke von selbst: diese Pruefung laeuft am
    // ANFANG eines Takts, und derselbe Takt pollt danach ohnehin alles nach.
    // Es gibt aber genau eine Ausnahme, und die darf nicht unausgesprochen bleiben:
    if (this.taktAbgeschaltet) {
      this.umgebung.log(
        '⚠️ Dieser Wrapper hat den Heartbeat abgeschaltet — er pollt NICHT und holt die Luecke also nicht ' +
          'von selbst auf. Ein Weckruf, der in die Luecke fiel, ist verloren und muss wiederholt werden.',
      )
    }
  }

  // -------------------------------------------------------------------------
  // Live-Kanal (SSE)
  // -------------------------------------------------------------------------

  async starteLiveKanal(empfaenger: LiveEmpfaenger): Promise<void> {
    this.empfaenger = empfaenger
    this.beendet = false
    void this.streamSchleife()
  }

  async beendeLiveKanal(): Promise<void> {
    this.beendet = true
    if (this.streamAbbruch) {
      try {
        this.streamAbbruch.abort()
      } catch {
        /* ignore */
      }
      this.streamAbbruch = null
    }
    this.warVerbunden = false
    this.buch.liveVerbindungWeg(null, true)
  }

  /**
   * Verbinden, lesen, bei Abbruch mit wachsender Pause neu versuchen.
   * Node hat keine EventSource mit eingebautem Wiederverbinden — das steht hier.
   */
  private async streamSchleife(): Promise<void> {
    let stufe = 0
    while (!this.beendet) {
      this.buch.liveVerbindungsversuch()
      const abbruch = new AbortController()
      this.streamAbbruch = abbruch
      try {
        const antwort = await fetch(`${this.basis}/stream`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'text/event-stream',
          },
          signal: abbruch.signal,
        })

        if (antwort.status === 401 || antwort.status === 403) {
          this.buch.zaehleAblehnung()
          this.umgebung.log(
            'Live-Kanal ABGELEHNT (%d) — Weckrufe kommen nur noch ueber den Poll-Takt an.',
            antwort.status,
          )
          throw new Error(`HTTP ${antwort.status} am Live-Kanal`)
        }
        if (!antwort.ok || !antwort.body) {
          throw new Error(`HTTP ${antwort.status} am Live-Kanal`)
        }

        const wiederAufgebaut = this.jeVerbunden
        this.jeVerbunden = true
        this.warVerbunden = true
        this.buch.liveVerbindungSteht()
        stufe = 0
        if (wiederAufgebaut) {
          // Wir waren weg. Was in der Zwischenzeit passiert ist, hebt niemand fuer
          // uns auf — also sofort pollen statt auf den naechsten Takt zu warten.
          this.umgebung.log('Live-Kanal WIEDER verbunden — es wird sofort gepollt, um die Luecke zu schliessen.')
          this.empfaenger?.({ art: 'hinweis', kanal: 'stream-wiederverbunden', stufe: 'hot' })
        } else {
          this.umgebung.log('Live-Kanal verbunden (SSE)')
        }
        await this.leseStrom(antwort.body)
        this.buch.liveVerbindungWeg('vom Server beendet')
        if (!this.beendet) this.umgebung.log('Live-Kanal beendet — neuer Versuch folgt')
      } catch (err) {
        const grund = err instanceof Error ? err.message : String(err)
        this.buch.liveVerbindungWeg(grund)
        if (!this.beendet) this.umgebung.log('Live-Kanal-Fehler: %s', grund)
      }

      // DER EIGENE ABRISS — der Fall, den nur diese Seite pruefen kann.
      // "Woran WUERDE ich es merken?" hat hier drei Antworten, absichtlich drei:
      //   1. diese Logzeile, sofort und beim Uebergang (nicht bei jedem Fehlversuch,
      //      sonst waere sie bei einer laengeren Stoerung nur noch Rauschen),
      //   2. ein sofortiger Poll — sonst bliebe die Luecke bis zum naechsten Takt offen,
      //   3. die Bilanz: liveVerbunden=false, eigeneAbrisse und Versuche steigen. Bleibt
      //      der Kanal laenger als eine Minute weg, meldet der Waechter es von selbst.
      if (this.warVerbunden && !this.beendet) {
        this.warVerbunden = false
        this.umgebung.log(
          'Live-Kanal ABGERISSEN — Weckrufe kommen bis zur Rueckkehr nur noch ueber den Poll-Takt. Es wird sofort gepollt.',
        )
        this.empfaenger?.({ art: 'hinweis', kanal: 'stream-getrennt', stufe: 'hot' })
      }

      if (this.beendet) return
      const warte = RUECKZUG_MS[Math.min(stufe, RUECKZUG_MS.length - 1)]
      stufe++
      await new Promise<void>((fertig) => {
        setTimeout(fertig, warte)
      })
    }
  }

  private async leseStrom(koerper: ReadableStream<Uint8Array>): Promise<void> {
    const leser = koerper.getReader()
    const dekoder = new TextDecoder()
    let puffer = ''
    for (;;) {
      const { done, value } = await leser.read()
      if (done) return
      puffer += dekoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let grenze = puffer.indexOf('\n\n')
      while (grenze >= 0) {
        this.verarbeiteBlock(puffer.slice(0, grenze))
        puffer = puffer.slice(grenze + 2)
        grenze = puffer.indexOf('\n\n')
      }
      if (puffer.length > 1_000_000) {
        this.umgebung.log('Live-Kanal: unvollstaendiger Block groesser als 1 MB — verworfen')
        puffer = ''
      }
    }
  }

  /**
   * Ein SSE-Rahmen. Die Route sendet BENANNTE Ereignisse (event: wake | file | hint)
   * und dazwischen einen Kommentar-Herzschlag alle 15s.
   *
   * Der Herzschlag ist hier kein Beiwerk: er ist der einzige Unterschied zwischen
   * "der Kanal ist ruhig" und "der Kanal ist tot". Ohne ihn saehen beide gleich aus.
   */
  private verarbeiteBlock(block: string): void {
    if (block.trim() === '') return
    const zeilen = block.split('\n')
    const daten: string[] = []
    let name = ''
    let nurKommentar = true
    for (const zeile of zeilen) {
      if (zeile.startsWith(':')) continue
      nurKommentar = false
      if (zeile.startsWith('event:')) name = zeile.slice(6).trim()
      else if (zeile.startsWith('data:')) daten.push(zeile.slice(5).trimStart())
    }

    // Jeder vollstaendige Rahmen beweist, dass die Leitung lebt — auch ein
    // blosser Kommentar und auch die "retry"-Zeile.
    this.buch.liveLebenszeichenGesehen()
    if (nurKommentar) return

    let nutz: Record<string, unknown> = {}
    if (daten.length > 0) {
      try {
        nutz = JSON.parse(daten.join('\n')) as Record<string, unknown>
      } catch {
        this.umgebung.log('Live-Kanal: Ereignis "%s" nicht lesbar (kein JSON) — verworfen', name)
        return
      }
    }

    // Der Ereignisname ist massgeblich; ein type-Feld in den Daten gilt ersatzweise.
    const art = name !== '' ? name : String(nutz.type ?? '')
    if (art === '' || art === 'connected' || art === 'heartbeat') return

    this.buch.liveEreignisGesehen()
    const empfaenger = this.empfaenger
    if (!empfaenger) return

    if (art === 'wake') {
      const nachricht = typeof nutz.message === 'string' ? nutz.message : ''
      if (nachricht) empfaenger({ art: 'wake', nachricht })
      return
    }

    if (art === 'file') {
      // Dieselben Filter wie beim pg-Weg: nur dieses Projekt, keine eigenen Aenderungen.
      const pfad = nutz.file_path
      const wer = nutz.agent_id
      if (nutz.project === this.umgebung.projekt && wer !== this.umgebung.agentName && typeof pfad === 'string') {
        empfaenger({
          art: 'datei',
          pfad,
          aktion: typeof nutz.edit_action === 'string' ? nutz.edit_action : 'change',
          agent: typeof wer === 'string' ? wer : '',
        })
      }
      // Der Hinweis kommt auch bei weggefilterter Nutzlast — genau wie beim pg-Weg.
      empfaenger({ art: 'hinweis', kanal: 'synapse_file', stufe: 'hot' })
      return
    }

    if (art === 'hint') {
      const kanal = String(nutz.channel ?? '')
      if (!kanal) return
      // 'resync' meldet, dass der LISTEN-Client der API kurz weg war. In dieser
      // Luecke koennen Ereignisse verlorengegangen sein — deshalb 'hot' und nicht
      // 'warm': es ist kein Lebenszeichen, sondern die Aufforderung, sofort
      // nachzusehen. Ohne diese Behandlung waere die Luecke genau das, wogegen
      // die ganze Bruecke abgesichert wird: unauffaellige Stille.
      if (kanal === 'resync') {
        this.umgebung.log(
          'Live-Kanal meldet eine Luecke (resync, %sms) — es wird sofort gepollt.',
          String(nutz.gap_ms ?? 'unbekannt'),
        )
        empfaenger({ art: 'hinweis', kanal, stufe: 'hot' })
        return
      }
      empfaenger({ art: 'hinweis', kanal, stufe: 'warm' })
      return
    }

    this.umgebung.log('Live-Kanal: unbekannte Ereignisart "%s" — ignoriert', art)
  }
}
