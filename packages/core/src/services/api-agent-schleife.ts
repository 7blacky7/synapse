/**
 * MODUL: Toolschleife und Formathelfer der API-Agenten (P22-T8, umgezogen nach core in P22-T183 B1, Konzept e7ed9291 Abschn. 8a)
 * ZWECK: EIN gemeinsamer Loop fuer alle API-Anbieter (Anthropic, OpenRouter/OpenAI-Format; spaeter Free-Pool W6):
 *        Anbieter-Antwort -> Werkzeugaufrufe (nur Synapse-Tools) -> Ergebnisse in EINER user-Nachricht -> weiter, bis die
 *        Antwort fertig ist oder eine ausdrueckliche Grenze greift. Keine zweite Schleife je Anbieter.
 *        Genutzt vom Altweg (agents api-worker im Runtime-Container, re-exportiert) und vom neuen Lauf IM API-Prozess (rest-api
 *        api-agent-lauf, P22-T183). Rein: keine Importe, kein I/O.
 *
 * INTERNES FORMAT: Nachricht/Block unten. Anbieter-Adapter uebersetzen in beide Richtungen; anbieterspezifische Bloecke
 *   (z. B. Anthropic thinking) laufen als 'roh' unveraendert mit, weil sie unveraendert zurueckgegeben werden muessen.
 * GRENZEN: toolrunden_max und laufzeit_ms kommen vom Server (Einstellwerte). Greift eine Grenze, endet die Nachricht mit einer
 *   ausdruecklichen Meldung (nie still "fertig"); der Verlauf bleibt gueltig (nach jedem tool_use folgen dessen Ergebnisse).
 * NEUSTART-SCHUTZ: jeder Werkzeugaufruf wird VOR der Ausfuehrung im Verlauf vermerkt; ein vermerkter Aufruf ohne
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

/* ===================== Anthropic-Format (platform.claude.com/docs/en/api/messages) =====================
 * content-Bloecke text | image | tool_use | tool_result (is_error); alle tool_result einer Runde in EINER user-Nachricht;
 * thinking-Bloecke unveraendert zurueckgeben (hier 'roh'). stop_reason end_turn | tool_use | pause_turn | max_tokens | refusal |
 * stop_sequence | model_context_window_exceeded. Nicht als OpenAI-kompatibler Endpunkt behandelt (Konzept 8a). */

export type AnthropicBlock = Record<string, unknown> & { type: string }

function inhaltNachAnthropic(b: Block): AnthropicBlock {
  switch (b.typ) {
    case 'text': return { type: 'text', text: b.text }
    case 'bild': return { type: 'image', source: { type: 'base64', media_type: b.media_type, data: b.daten } }
    case 'werkzeug_aufruf': return { type: 'tool_use', id: b.id, name: b.name, input: b.eingabe }
    case 'werkzeug_ergebnis': return {
      type: 'tool_result', tool_use_id: b.aufruf_id, is_error: b.fehler,
      content: b.inhalt.map(x => x.typ === 'text' ? { type: 'text', text: x.text } : { type: 'image', source: { type: 'base64', media_type: x.media_type, data: x.daten } }),
    }
    case 'roh': return b.block as AnthropicBlock
  }
}

export function nachAnthropic(verlauf: Nachricht[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  return verlauf
    .map(n => ({ role: n.rolle, content: n.inhalt.filter(b => b.typ !== 'roh' || b.anbieter === 'anthropic').map(inhaltNachAnthropic) }))
    .filter(n => n.content.length > 0)
}

export function vonAnthropic(content: unknown): Block[] {
  const aus: Block[] = []
  for (const c of (Array.isArray(content) ? content : []) as AnthropicBlock[]) {
    if (c.type === 'text' && typeof c.text === 'string') aus.push({ typ: 'text', text: c.text })
    else if (c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string') {
      aus.push({ typ: 'werkzeug_aufruf', id: c.id, name: c.name, eingabe: c.input && typeof c.input === 'object' ? c.input as Record<string, unknown> : {} })
    } else aus.push({ typ: 'roh', anbieter: 'anthropic', block: c })
  }
  return aus
}

export function stopAusAnthropic(s: unknown): StopGrund {
  switch (s) {
    case 'end_turn': case 'stop_sequence': return 'ende'
    case 'tool_use': return 'werkzeug'
    case 'pause_turn': return 'pause'
    case 'max_tokens': return 'max_tokens'
    case 'refusal': return 'abgelehnt'
    case 'model_context_window_exceeded': return 'kontext_voll'
    default: return 'sonstig'
  }
}

/* ===================== OpenAI-Format (OpenRouter POST /chat/completions, P22-T183) =====================
 * messages: system | user (content string oder Teile text/image_url) | assistant (content + tool_calls) | tool (tool_call_id).
 * Werkzeugergebnisse folgen als je EINE tool-Nachricht direkt auf die assistant-Nachricht mit den tool_calls; Bilder aus
 * Ergebnissen koennen tool-Nachrichten nicht tragen und folgen deshalb als user-Nachricht. Fehlerergebnisse tragen den
 * Vorsatz '[Fehler] ' (das Format kennt kein is_error). Anthropic-roh-Bloecke (thinking) werden hier nicht gesendet.
 * finish_reason stop | tool_calls | function_call | length | content_filter. */

export type OpenAiTeil = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type OpenAiWerkzeugAufruf = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type OpenAiNachricht =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAiTeil[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiWerkzeugAufruf[] }
  | { role: 'tool'; tool_call_id: string; content: string }

const bildUrl = (b: BildBlock): string => `data:${b.media_type};base64,${b.daten}`

function userInhaltOpenAi(bloecke: Array<TextBlock | BildBlock>): string | OpenAiTeil[] {
  if (bloecke.every(b => b.typ === 'text')) return bloecke.map(b => (b as TextBlock).text).join('\n\n')
  return bloecke.map(b => b.typ === 'text' ? { type: 'text' as const, text: b.text } : { type: 'image_url' as const, image_url: { url: bildUrl(b) } })
}

export function nachOpenAi(system: string, verlauf: Nachricht[]): OpenAiNachricht[] {
  const aus: OpenAiNachricht[] = []
  if (system.trim()) aus.push({ role: 'system', content: system })
  for (const n of verlauf) {
    if (n.rolle === 'assistant') {
      const text = n.inhalt.filter((b): b is TextBlock => b.typ === 'text').map(b => b.text).join('\n\n')
      const aufrufe = n.inhalt.filter((b): b is WerkzeugAufruf => b.typ === 'werkzeug_aufruf')
      if (!text && aufrufe.length === 0) continue
      aus.push({
        role: 'assistant', content: text || null,
        ...(aufrufe.length ? { tool_calls: aufrufe.map(a => ({ id: a.id, type: 'function' as const, function: { name: a.name, arguments: JSON.stringify(a.eingabe ?? {}) } })) } : {}),
      })
      continue
    }
    const bilderAusErgebnissen: Array<TextBlock | BildBlock> = []
    for (const b of n.inhalt) {
      if (b.typ !== 'werkzeug_ergebnis') continue
      const text = b.inhalt.filter((x): x is TextBlock => x.typ === 'text').map(x => x.text).join('\n\n')
      const bilder = b.inhalt.filter((x): x is BildBlock => x.typ === 'bild')
      aus.push({ role: 'tool', tool_call_id: b.aufruf_id, content: `${b.fehler ? '[Fehler] ' : ''}${text || (bilder.length ? '(Bild folgt)' : '(leeres Ergebnis)')}` })
      if (bilder.length) bilderAusErgebnissen.push({ typ: 'text', text: `Bild(er) aus Werkzeugergebnis ${b.aufruf_id}:` }, ...bilder)
    }
    const rest = n.inhalt.filter((b): b is TextBlock | BildBlock => b.typ === 'text' || b.typ === 'bild')
    const user = [...bilderAusErgebnissen, ...rest]
    if (user.length) aus.push({ role: 'user', content: userInhaltOpenAi(user) })
  }
  return aus
}

export function werkzeugeNachOpenAi(werkzeuge: WerkzeugDef[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return werkzeuge.map(w => ({ type: 'function', function: { name: w.name, description: w.beschreibung, parameters: w.schema } }))
}

export function stopAusOpenAi(s: unknown): StopGrund {
  switch (s) {
    case 'stop': return 'ende'
    case 'tool_calls': case 'function_call': return 'werkzeug'
    case 'length': return 'max_tokens'
    case 'content_filter': return 'abgelehnt'
    default: return 'sonstig'
  }
}

/** assistant-message einer choice -> interne Bloecke. Kaputtes arguments-JSON: leere Eingabe plus ausdruecklicher Text. */
export function vonOpenAi(message: unknown): Block[] {
  const m = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>
  const aus: Block[] = []
  const begruendung = typeof m.reasoning === 'string' ? m.reasoning : typeof m.reasoning_content === 'string' ? m.reasoning_content : ''
  if (begruendung.trim()) aus.push({ typ: 'roh', anbieter: 'openai', block: { type: 'reasoning', text: begruendung } })
  if (typeof m.content === 'string' && m.content.length) aus.push({ typ: 'text', text: m.content })
  else if (Array.isArray(m.content)) {
    for (const t of m.content as Array<Record<string, unknown>>) if (t && t.type === 'text' && typeof t.text === 'string') aus.push({ typ: 'text', text: t.text })
  }
  const calls = Array.isArray(m.tool_calls) ? m.tool_calls as Array<Record<string, unknown>> : []
  calls.forEach((c, i) => {
    const f = (c.function && typeof c.function === 'object' ? c.function : {}) as { name?: unknown; arguments?: unknown }
    if (typeof f.name !== 'string' || !f.name) return
    const id = typeof c.id === 'string' && c.id ? c.id : `aufruf_${i}`
    let eingabe: Record<string, unknown> = {}
    const roh = typeof f.arguments === 'string' ? f.arguments.trim() : ''
    if (roh) {
      try {
        const p = JSON.parse(roh) as unknown
        if (p && typeof p === 'object' && !Array.isArray(p)) eingabe = p as Record<string, unknown>
        else aus.push({ typ: 'text', text: `Werkzeugargumente fuer ${f.name} waren kein JSON-Objekt; Aufruf mit leerer Eingabe.` })
      } catch (err) {
        aus.push({ typ: 'text', text: `Werkzeugargumente fuer ${f.name} waren kein gueltiges JSON (${err instanceof Error ? err.message : String(err)}); Aufruf mit leerer Eingabe.` })
      }
    } else if (f.arguments && typeof f.arguments === 'object') eingabe = f.arguments as Record<string, unknown>
    aus.push({ typ: 'werkzeug_aufruf', id, name: f.name, eingabe })
  })
  return aus
}

/** usage der OpenAI-Antwort -> Nutzung (input OHNE Cache-Treffer, wie bei Anthropic). */
export function nutzungAusOpenAi(usage: unknown): Nutzung | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const details = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {}) as Record<string, unknown>
  const cache = n(details.cached_tokens)
  return { input: Math.max(0, n(u.prompt_tokens) - cache), output: n(u.completion_tokens), cache_read: cache, cache_creation: 0 }
}

/** Eine choice (message + finish_reason) -> Bloecke und Stopgrund. Liegen tool_calls vor, ist der Grund immer 'werkzeug',
 *  damit der Verlauf gueltig bleibt (manche Anbieter melden 'stop' trotz tool_calls). */
export function antwortAusOpenAi(choice: unknown): { inhalt: Block[]; stop: StopGrund; stop_roh: string | null } {
  const c = (choice && typeof choice === 'object' ? choice : {}) as { message?: unknown; finish_reason?: unknown }
  const inhalt = vonOpenAi(c.message)
  const stopRoh = typeof c.finish_reason === 'string' ? c.finish_reason : null
  const stop = inhalt.some(b => b.typ === 'werkzeug_aufruf') ? 'werkzeug' : stopAusOpenAi(stopRoh)
  return { inhalt, stop, stop_roh: stopRoh }
}
