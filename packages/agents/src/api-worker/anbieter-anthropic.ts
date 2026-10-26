/**
 * MODUL: Anthropic-Adapter des API-Agent-Workers (P22-T8)
 * ZWECK: Uebersetzt das interne Format (toolschleife.ts) in das Anthropic-Messages-Format und zurueck und ruft den
 *        autorisierten Provider-Transport der Synapse-API (POST /api/agent-api/messages). Der API-Key bleibt dort; der
 *        Server reserviert vorher Budget und bucht danach die echten Kosten. Hier gibt es KEINEN Key und keinen Direktaufruf.
 * FORMAT (Anthropic, platform.claude.com/docs/en/api/messages): content-Bloecke text | image | tool_use | tool_result
 *   (is_error); alle tool_result einer Runde in EINER user-Nachricht; thinking-Bloecke unveraendert zurueckgeben (hier 'roh').
 *   stop_reason end_turn | tool_use | pause_turn | max_tokens | refusal | stop_sequence | model_context_window_exceeded.
 * Nicht als OpenAI-kompatibler Endpunkt behandelt (Konzept 8a).
 */
import type { AnbieterAdapter, AnbieterAnfrage, AnbieterAntwort } from './toolschleife.js'
import { AnbieterFehler } from './toolschleife.js'
import type { SynapseZugang } from './mcp-http-client.js'
import { nachAnthropic, vonAnthropic, stopAusAnthropic } from '@synapse/core'

// P22-T183 B1: Formathelfer liegen in @synapse/core (api-agent-schleife.ts); hier unter den bisherigen Namen weitergereicht.
export { nachAnthropic, vonAnthropic, stopAusAnthropic }

const ZEITLIMIT_MS = 30 * 60_000

export class AnthropicUeberSynapse implements AnbieterAdapter {
  readonly name = 'anthropic-api'

  constructor(
    private readonly zugang: SynapseZugang,
    private readonly opt: { project: string; modell: string },
    private readonly holen: typeof fetch = fetch,
  ) {}

  async rufe(a: AnbieterAnfrage): Promise<AnbieterAntwort> {
    const signal = a.signal ? AbortSignal.any([a.signal, AbortSignal.timeout(ZEITLIMIT_MS)]) : AbortSignal.timeout(ZEITLIMIT_MS)
    const antwort = await this.holen(`${this.zugang.apiBasis}/api/agent-api/messages`, {
      method: 'POST',
      headers: { ...this.zugang.kopf, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        project: this.opt.project,
        modell: this.opt.modell,
        system: a.system,
        max_tokens: a.max_tokens,
        messages: nachAnthropic(a.verlauf),
        tools: a.werkzeuge.map(w => ({ name: w.name, description: w.beschreibung, input_schema: w.schema })),
      }),
      signal,
    })
    const text = await antwort.text()
    let daten: Record<string, unknown> = {}
    try { daten = JSON.parse(text) as Record<string, unknown> } catch { /* unten als Fehler */ }
    if (!antwort.ok || daten.success !== true) {
      const f = (daten.error && typeof daten.error === 'object' ? daten.error : {}) as { code?: string; message?: string; details?: unknown; retry_after?: number }
      throw new AnbieterFehler(f.code ?? `http_${antwort.status}`, f.message ?? text.slice(0, 300), f.details, f.retry_after ?? null)
    }
    const m = (daten.message ?? {}) as { content?: unknown; stop_reason?: unknown; stop_details?: unknown; usage?: Record<string, unknown> }
    const u = m.usage ?? null
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    const kosten = (daten.kosten ?? {}) as { usd?: number }
    return {
      inhalt: vonAnthropic(m.content),
      stop: stopAusAnthropic(m.stop_reason),
      stop_roh: typeof m.stop_reason === 'string' ? m.stop_reason : null,
      stop_details: m.stop_details ?? null,
      nutzung: u ? { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens), cache_creation: n(u.cache_creation_input_tokens) } : null,
      kosten_usd: typeof kosten.usd === 'number' ? kosten.usd : null,
      rest_usd: typeof daten.rest_usd === 'number' ? daten.rest_usd : null,
    }
  }
}

/** Rahmen des eigenen Agenten (Schalter, Rest, Grenzen) ueber GET /api/agent-api/rahmen. */
export async function holeApiRahmen(zugang: SynapseZugang, project: string, holen: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const r = await holen(`${zugang.apiBasis}/api/agent-api/rahmen?project=${encodeURIComponent(project)}`, {
    headers: { ...zugang.kopf, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000),
  })
  const daten = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok || daten.success !== true) {
    const f = (daten.error && typeof daten.error === 'object' ? daten.error : {}) as { code?: string; message?: string }
    throw new AnbieterFehler(f.code ?? `http_${r.status}`, f.message ?? 'Rahmen nicht lesbar')
  }
  return daten
}
