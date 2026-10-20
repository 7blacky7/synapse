/**
 * MODUL: Toolschleife des API-Agent-Workers (P22-T8, Konzept e7ed9291 Abschn. 8a)
 * ZWECK: EIN gemeinsamer Loop fuer alle API-Anbieter (heute Anthropic ueber den Synapse-Transport, spaeter Free-Pool W6):
 *        Anbieter-Antwort -> Werkzeugaufrufe (nur Synapse-MCP-Tools) -> Ergebnisse in EINER user-Nachricht -> weiter, bis die
 *        Antwort fertig ist oder eine ausdrueckliche Grenze greift. Keine zweite Schleife je Anbieter.
 *
 * INTERNES FORMAT: Nachricht/Block unten. Anbieter-Adapter uebersetzen in beide Richtungen; anbieterspezifische Bloecke
 *   (z. B. Anthropic thinking) laufen als 'roh' unveraendert mit, weil sie unveraendert zurueckgegeben werden muessen.
 * GRENZEN: toolrunden_max und laufzeit_ms kommen vom Server (Einstellwerte). Greift eine Grenze, endet die Nachricht mit einer
 *   ausdruecklichen Meldung (nie still "fertig"); der Verlauf bleibt gueltig (nach jedem tool_use folgen dessen Ergebnisse).
 * NEUSTART-SCHUTZ: jeder Werkzeugaufruf wird VOR der Ausfuehrung im Verlauf vermerkt (verlauf.ts); ein vermerkter Aufruf ohne
 *   Ergebnis wird nach einem Neustart NICHT wiederholt.
 * FEHLER des Anbieters (Budget, Schalter, Zugang, Ueberlastung): ausdrueckliche Meldung, kein Ersatzmodell, kein Ersatzanbieter.
 */

export type TextBlock = { typ: 'text'; text: string }
export type BildBlock = { typ: 'bild'; media_type: string; daten: string }
export type WerkzeugAufruf = { typ: 'werkzeug_aufruf'; id: string; name: string; eingabe: Record<string, unknown> }
export type WerkzeugErgebnis = { typ: 'werkzeug_ergebnis'; aufruf_id: string; inhalt: Array<TextBlock | BildBlock>; fehler: boolean }
/** Anbieterblock, der unveraendert zurueck muss (z. B. thinking). */
export type RohBlock = { typ: 'roh'; anbieter: string; block: Record<string, unknown> }
export type Block = TextBlock | BildBlock | WerkzeugAufruf | WerkzeugErgebnis | RohBlock
export interface Nachricht { rolle: 'user' | 'assistant'; inhalt: Block[] }

export interface WerkzeugDef { name: string; beschreibung: string; schema: Record<string, unknown> }

export type StopGrund = 'ende' | 'werkzeug' | 'pause' | 'max_tokens' | 'abgelehnt' | 'kontext_voll' | 'sonstig'
export interface Nutzung { input: number; output: number; cache_read: number; cache_creation: number }
export interface AnbieterAntwort {
  inhalt: Block[]
  stop: StopGrund
  stop_roh: string | null
  nutzung: Nutzung | null
  kosten_usd?: number | null
  rest_usd?: number | null
  /** Zusatz bei stop 'abgelehnt' (z. B. Kategorie) */
  stop_details?: unknown
}
export interface AnbieterAnfrage {
  system: string
  verlauf: Nachricht[]
  werkzeuge: WerkzeugDef[]
  max_tokens: number
  signal?: AbortSignal
}
export interface AnbieterAdapter {
  readonly name: string
  rufe(anfrage: AnbieterAnfrage): Promise<AnbieterAntwort>
}

/** Fehler des Anbieterwegs mit Fachcode (z. B. budget_erschoepft, funktion_aus, ueberlastet). */
export class AnbieterFehler extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown, readonly retryAfterSek?: number | null) {
    super(message)
    this.name = 'AnbieterFehler'
  }
}

export interface WerkzeugAusfuehrer {
  rufe(name: string, eingabe: Record<string, unknown>): Promise<{ inhalt: Array<TextBlock | BildBlock>; fehler: boolean }>
}

export interface VerlaufSpeicher {
  nachrichten(): Nachricht[]
  fuegeHinzu(n: Nachricht): Promise<void>
  /** Vermerk VOR der Ausfuehrung eines Werkzeugaufrufs (Neustart-Schutz). */
  vermerkeAufruf(a: WerkzeugAufruf): Promise<void>
}

export interface Grenzen { toolrunden_max: number; laufzeit_ms: number }

export type NachrichtEnde = 'fertig' | 'grenze_toolrunden' | 'grenze_laufzeit' | 'max_tokens' | 'abgelehnt' | 'kontext_voll' | 'anbieter_fehler' | 'abgebrochen'

export interface NachrichtErgebnis {
  /** gesamter sichtbarer Text dieser Nachricht (alle Runden) */
  text: string
  ende: NachrichtEnde
  meldung: string | null
  runden: number
  nutzung_letzte: Nutzung | null
  kosten_usd: number
}

export interface SchleifenOptionen {
  adapter: AnbieterAdapter
  werkzeuge: WerkzeugDef[]
  ausfuehrer: WerkzeugAusfuehrer
  verlauf: VerlaufSpeicher
  system: string
  max_tokens: number
  grenzen: Grenzen
  signal?: AbortSignal
  jetzt?: () => number
  beiText?: (text: string) => void
  beiNutzung?: (n: Nutzung) => void | Promise<void>
  beiEreignis?: (art: string, daten: Record<string, unknown>) => void
}

const STOP_MELDUNG: Partial<Record<StopGrund, string>> = {
  max_tokens: 'Antwort am Ausgabelimit abgeschnitten (max_tokens). Nicht fertig - bitte nachfragen oder Aufgabe teilen.',
  abgelehnt: 'Das Modell hat die Anfrage abgelehnt (refusal). Es gibt bewusst kein Ersatzmodell.',
  kontext_voll: 'Kontextfenster des Modells voll. Nicht fertig - Handoff/Neustart noetig.',
}

/**
 * Fuehrt EINE eingehende Nachricht aus (die user-Nachricht steht schon im Verlauf). Endet mit einem ausdruecklichen Grund.
 */
export async function fuehreNachrichtAus(o: SchleifenOptionen): Promise<NachrichtErgebnis> {
  const jetzt = o.jetzt ?? Date.now
  const start = jetzt()
  const texte: string[] = []
  let runden = 0
  let kosten = 0
  let nutzung: Nutzung | null = null
  const ende = (e: NachrichtEnde, meldung: string | null): NachrichtErgebnis => {
    if (meldung) o.beiText?.(meldung)
    return { text: [...texte, ...(meldung ? [meldung] : [])].join('\n\n'), ende: e, meldung, runden, nutzung_letzte: nutzung, kosten_usd: kosten }
  }

  while (true) {
    if (o.signal?.aborted) return ende('abgebrochen', 'Abgebrochen.')
    if (jetzt() - start >= o.grenzen.laufzeit_ms) {
      return ende('grenze_laufzeit', `Laufzeitgrenze erreicht (${Math.round(o.grenzen.laufzeit_ms / 60_000)} min, Einstellwert laufzeit_minuten). Nicht fertig - Stand steht im Verlauf.`)
    }
    let antwort: AnbieterAntwort
    try {
      antwort = await o.adapter.rufe({ system: o.system, verlauf: o.verlauf.nachrichten(), werkzeuge: o.werkzeuge, max_tokens: o.max_tokens, signal: o.signal })
    } catch (err) {
      if (o.signal?.aborted) return ende('abgebrochen', 'Abgebrochen.')
      const code = err instanceof AnbieterFehler ? err.code : 'anbieter_fehler'
      const text = err instanceof Error ? err.message : String(err)
      o.beiEreignis?.('anbieter_fehler', { code })
      return ende('anbieter_fehler', `API-Aufruf nicht moeglich (${code}): ${text}`)
    }
    if (antwort.nutzung) {
      nutzung = antwort.nutzung
      await o.beiNutzung?.(antwort.nutzung)
    }
    if (typeof antwort.kosten_usd === 'number') kosten += antwort.kosten_usd
    await o.verlauf.fuegeHinzu({ rolle: 'assistant', inhalt: antwort.inhalt })
    for (const b of antwort.inhalt) {
      if (b.typ === 'text' && b.text.trim()) {
        texte.push(b.text)
        o.beiText?.(b.text)
      }
    }

    if (antwort.stop === 'pause') continue
    if (antwort.stop !== 'werkzeug') {
      const meldung = STOP_MELDUNG[antwort.stop] ?? null
      const art: NachrichtEnde = antwort.stop === 'ende' || antwort.stop === 'sonstig' ? 'fertig'
        : antwort.stop === 'max_tokens' ? 'max_tokens' : antwort.stop === 'abgelehnt' ? 'abgelehnt' : 'kontext_voll'
      return ende(art, meldung)
    }

    const aufrufe = antwort.inhalt.filter((b): b is WerkzeugAufruf => b.typ === 'werkzeug_aufruf')
    if (aufrufe.length === 0) return ende('fertig', null)
    runden += 1
    // Vermerk VOR der Ausfuehrung, Ausfuehrung parallel, Ergebnisse gesammelt in EINER user-Nachricht.
    for (const a of aufrufe) await o.verlauf.vermerkeAufruf(a)
    const ergebnisse = await Promise.all(aufrufe.map(async (a): Promise<WerkzeugErgebnis> => {
      o.beiEreignis?.('werkzeug_aufruf', { name: a.name, id: a.id })
      try {
        const r = await o.ausfuehrer.rufe(a.name, a.eingabe)
        return { typ: 'werkzeug_ergebnis', aufruf_id: a.id, inhalt: r.inhalt.length ? r.inhalt : [{ typ: 'text', text: '(leeres Ergebnis)' }], fehler: r.fehler }
      } catch (err) {
        return { typ: 'werkzeug_ergebnis', aufruf_id: a.id, inhalt: [{ typ: 'text', text: `Werkzeugfehler: ${err instanceof Error ? err.message : String(err)}` }], fehler: true }
      }
    }))
    await o.verlauf.fuegeHinzu({ rolle: 'user', inhalt: ergebnisse })
    if (runden >= o.grenzen.toolrunden_max) {
      return ende('grenze_toolrunden', `Toolrunden-Grenze erreicht (${o.grenzen.toolrunden_max}, Einstellwert toolrunden_max). Nicht fertig - Stand steht im Verlauf, naechste Nachricht setzt fort.`)
    }
  }
}
