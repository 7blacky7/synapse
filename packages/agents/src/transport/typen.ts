/**
 * MODUL: Vertrag der Wrapper-Zugriffsschicht
 * ZWECK: Alles, was der Wrapper frueher unmittelbar an der Datenbank getan hat,
 *        steht hier als EINE Schnittstelle. Zwei Umsetzungen erfuellen sie:
 *          'pg'  — genau das bisherige Verhalten (getPool + @synapse/core)
 *          'api' — dieselben Faehigkeiten ueber HTTP gegen die synapse-api
 *        Umgeschaltet wird ueber SYNAPSE_WRAPPER_TRANSPORT, Vorgabe 'pg'.
 *        Ohne gesetzte Variable aendert sich nichts.
 *
 * WARUM SO GESCHNITTEN:
 *   Die Schicht liefert DATEN, keine fertigen Texte. Die Wortlaute der Wake-Prompts
 *   bleiben in wrapper.ts. Wanderte die Formulierung in die API, liesse sie sich
 *   nicht mehr aendern, ohne die API neu auszurollen.
 *
 * WAS ABSICHTLICH FEHLT:
 *   ensureSchema als eigene Faehigkeit. DDL gehoert nicht in einen Wrapper, der
 *   auf einer fremden Maschine laufen soll. Der pg-Weg tut es weiterhin in
 *   starte(), der api-Weg meldet sich dort stattdessen an.
 */

export type TransportArt = 'pg' | 'api'

/**
 * Die steuerbare Taktfrequenz aus wrapper_status.
 * ⚠️ Diese Faehigkeit muss der api-Weg genauso koennen wie der pg-Weg. Kann er es
 * nicht, laeuft ein abgeschalteter Wrapper einfach adaptiv weiter und sieht dabei
 * voellig normal aus — der Verlust waere unsichtbar.
 */
export interface HeartbeatKonfiguration {
  /** false = der Wrapper schlaegt nicht mehr von selbst. wake und Live-Kanal wirken weiter. */
  heartbeatEnabled: boolean
  /** null = adaptive Ladder. Zahl = fester Takt in Millisekunden. */
  heartbeatIntervalMs: number | null
}

/** Hoechste bereits gesehene Nachrichten-IDs beim Start (MAX(id), nicht 0). */
export interface Wasserstaende {
  channel: number
  inbox: number
}

export interface ChannelNachricht {
  id: number
  channelName: string
  sender: string
  content: string
}

export interface InboxNachricht {
  id: number
  fromAgent: string
  content: string
}

/**
 * Die vier Item-Arten, die pollSynapseItems heute einzeln aus der Datenbank holt —
 * bereits auf diesen Agenten gefiltert. Das Filtern ist Sache der Umsetzung: der
 * pg-Weg tut es im Prozess (wie bisher), der api-Weg auf dem Server. Die Regeln
 * muessen dieselben sein, sonst bekommt derselbe Agent je nach Weg andere Arbeit.
 */
export interface SynapseItems {
  memories: { name: string; content: string }[]
  thoughts: { id: string; content: string }[]
  tasks: { id: string; title: string; status: string; priority: string; description: string }[]
  events: { id: number; eventType: string; priority: string; payload: string | null }[]
}

/** Nutzlast von buildFullPgStatus — Feld fuer Feld unveraendert uebernommen. */
export interface StatusNutzlast {
  agentName: string
  project: string
  wrapperPid: number | null
  innerPid: number | null
  socketPath: string | null
  model: string | null
  modelFullId: string | null
  provider: string | null
  status: 'running' | 'idle' | 'crashed' | 'stopped'
  busy: boolean
  tokensInput: number | null
  tokensOutput: number | null
  tokensPercent: number | null
  contextCeiling: number | null
  connectedMcp: boolean
  channels: string[]
  currentTask: string | null
}

/**
 * Ereignisse des Live-Kanals. Beim pg-Weg kommen sie aus LISTEN/NOTIFY, beim
 * api-Weg aus einem SSE-Strom. Der Wrapper reagiert auf beide gleich.
 *
 * 'hinweis' traegt die Stufe mit, weil der bisherige Code sie unterscheidet: eine
 * Dateiaenderung setzt den Takt auf 10s zurueck ('hot'), ein blosses NOTIFY auf
 * chat/channel/event nur auf hoechstens 30s ('warm').
 *
 * ⚠️ Feinheit, die beim Umbau leicht verlorengeht: bei synapse_file wird der
 * Hinweis AUCH DANN gesendet, wenn die Nutzlast weggefiltert wurde (fremdes
 * Projekt, eigene Aenderung, kaputtes JSON). So war es vorher, so bleibt es.
 */
export type LiveEreignis =
  | { art: 'wake'; nachricht: string }
  | { art: 'datei'; pfad: string; aktion: string; agent: string }
  | { art: 'hinweis'; kanal: string; stufe: 'hot' | 'warm' }

export type LiveEmpfaenger = (ereignis: LiveEreignis) => void

export interface TransportUmgebung {
  agentName: string
  /** Leer, wenn der Wrapper ohne Projekt laeuft — dann bleiben Projekt-Faehigkeiten still. */
  projekt: string
  log: (msg: string, ...args: unknown[]) => void
}

// ---------------------------------------------------------------------------
// Sichtbarkeit
// ---------------------------------------------------------------------------

/**
 * Die Faehigkeiten, ueber die einzeln Buch gefuehrt wird. Ein Wrapper, dessen
 * Aufrufe stumm scheitern, sieht aus wie ein ruhiger Agent — das ist der Fehler,
 * den diese Zaehler sichtbar machen sollen.
 */
export const FAEHIGKEITEN = [
  'start',
  'konfiguration',
  'wasserstaende',
  'channels',
  'channel-nachrichten',
  'inbox',
  'inbox-quittung',
  'items',
  'status',
] as const

export type Faehigkeit = (typeof FAEHIGKEITEN)[number]

export interface FaehigkeitsZaehler {
  aufrufe: number
  fehler: number
  letzterErfolgTs: number | null
  letzterFehler: string | null
  letzterFehlerTs: number | null
}

export interface TransportBilanz {
  art: TransportArt
  faehigkeiten: Record<Faehigkeit, FaehigkeitsZaehler>
  gesamtAufrufe: number
  gesamtFehler: number
  letzterErfolgTs: number | null
  /**
   * 401/403. Zaehlt getrennt, weil ein abgelaufenes Token der Fall ist, der am
   * meisten wie Ruhe aussieht: alle Aufrufe scheitern gleichzeitig und lautlos.
   */
  abgelehnt: number
  liveVerbunden: boolean
  liveVerbindungsversuche: number
  /** Letztes Zeichen, dass der Kanal ueberhaupt lebt (auch ein Takt-Signal zaehlt). */
  liveLetztesLebenszeichenTs: number | null
  /** Letztes ECHTES Ereignis (wake/datei/hinweis). */
  liveLetztesEreignisTs: number | null
  liveLetzterFehler: string | null
  /**
   * true = dieser Weg sendet ein regelmaessiges Lebenszeichen, Stille ist also ein
   * Befund. false (pg) = LISTEN schweigt stundenlang voellig zu Recht; wer dort
   * Stille meldet, erzeugt nur Rauschen.
   */
  liveErwartetLebenszeichen: boolean
}

export interface WrapperTransport {
  readonly art: TransportArt

  /**
   * Einmalig beim Start. pg: ensureSchema (wie bisher). api: Anmeldung.
   * Darf werfen — der Aufrufer behandelt das wie bisher als nicht toedlich.
   */
  starte(): Promise<void>

  /** null = keine Zeile vorhanden. Fehler werden GEWORFEN, nicht verschluckt. */
  leseHeartbeatKonfiguration(): Promise<HeartbeatKonfiguration | null>

  leseWasserstaende(): Promise<Wasserstaende>
  leseChannels(): Promise<string[]>
  leseNeueChannelNachrichten(seitId: number): Promise<ChannelNachricht[]>
  leseNeueInboxNachrichten(seitId: number): Promise<InboxNachricht[]>
  quittiereInbox(ids: number[]): Promise<void>
  leseSynapseItems(): Promise<SynapseItems>
  schreibeStatus(status: StatusNutzlast): Promise<void>

  /** Beschleuniger, kein Fundament. Faellt er aus, laeuft der Poll-Takt weiter. */
  starteLiveKanal(empfaenger: LiveEmpfaenger): Promise<void>
  beendeLiveKanal(): Promise<void>

  bilanz(): TransportBilanz
}
