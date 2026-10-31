/**
 * P22-T194 / 0d2c6c07: passive Claude stream-json metadata only.
 * No Mod, hooks, transcript contents, prompts, model calls or restart.
 * Lauf comes only from a correlated successful chat(anmelden) result.
 */
import type { CacheMessung } from '@synapse/core'
export interface CacheStreamMeldung { lauf_id: string; sitzung: string; messung: CacheMessung }
type Objekt = Record<string, unknown>
const obj = (v: unknown): Objekt | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Objekt : null
const text = (v: unknown): string | null => typeof v === 'string' && v.length <= 200 ? v : null
const zahl = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v)

export class CacheStreamBeobachter {
  private sitzung = ''
  private lauf: string | null = null
  private laufAb = 0
  private anmeldeTool: string | null = null
  private beginn: number | null = null
  private modell: string | null = null
  private version: string | null = null
  private klassen: Array<'5m' | '1h'> = []
  private letzte: CacheMessung | null = null

  constructor(private readonly identity: string, private readonly ausweis: string) {}

  begin(sitzung: string, jetzt: number): void {
    if (sitzung !== this.sitzung) {
      this.sitzung = sitzung; this.lauf = null; this.anmeldeTool = null
      this.modell = null; this.version = null; this.klassen = []
    }
    this.beginn = jetzt; this.letzte = null
  }

  /** P22-T194: nur dieser Prozess kennt die bestaetigte Bindung; Mods liefern keinen Ausweis/Lauf. */
  bindungsStand(): { sitzung: string; lauf_id: string | null; ab_ms: number } { return { sitzung: this.sitzung, lauf_id: this.lauf, ab_ms: this.laufAb }; }

  private bindung(r: Objekt): void {
    const message = obj(r.message)
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const roh of blocks) {
      const b = obj(roh); if (!b) continue
      const input = obj(b.input)
      if (r.type === 'assistant' && b.type === 'tool_use' && typeof b.name === 'string'
        && /(^|__)chat$/.test(b.name) && input?.action === 'anmelden') {
        this.lauf = null; this.letzte = null; this.anmeldeTool = null
        if ((input.agent_kennung ?? input.token) === this.ausweis) this.anmeldeTool = text(b.id)
      }
      if (r.type !== 'user' || b.type !== 'tool_result' || !this.anmeldeTool || b.tool_use_id !== this.anmeldeTool) continue
      const parts = typeof b.content === 'string' ? [b.content] : Array.isArray(b.content)
        ? b.content.map(v => obj(v)).filter(v => v?.type === 'text').map(v => v?.text) : []
      this.anmeldeTool = null
      if (b.is_error === true) continue
      for (const part of parts) {
        if (typeof part !== 'string') continue
        let d: Objekt | null
        try { d = obj(JSON.parse(part)) } catch { continue /* non-JSON result grants no Lauf */ }
        const p = obj(d?.principal)
        if (d?.success === true && p?.identity_id === this.identity && p.ausweis === this.ausweis && uuid(p.lauf_id)) this.lauf = p.lauf_id
      }
    }
  }

  private messung(u: Objekt, modell: string | null, id: string | null, jetzt: number, umfang: 'letzte_anfrage' | 'turn_summe'): CacheMessung {
    if (modell && modell !== this.modell) this.klassen = []
    this.modell = modell ?? this.modell
    const c = obj(u.cache_creation), gefunden: Array<'5m' | '1h'> = []
    if ((zahl(c?.ephemeral_5m_input_tokens) ?? 0) > 0) gefunden.push('5m')
    if ((zahl(c?.ephemeral_1h_input_tokens) ?? 0) > 0) gefunden.push('1h')
    if (gefunden.length) this.klassen = gefunden
    const input = zahl(u.input_tokens), output = zahl(u.output_tokens)
    const gelesen = zahl(u.cache_read_input_tokens), geschrieben = zahl(u.cache_creation_input_tokens)
    return { modell: this.modell, request_id: id, messung_ms: jetzt, nutzungsmessung_ms: jetzt,
      request_beginn_ms: this.beginn, input, output, gelesen, geschrieben,
      kontext_tokens: umfang === 'letzte_anfrage' && input !== null && gelesen !== null && geschrieben !== null ? input + gelesen + geschrieben : null,
      ttl_klassen: [...this.klassen], ttl_quelle: this.klassen.length ? 'stream_json' : 'unbekannt',
      geschrieben_5m: zahl(c?.ephemeral_5m_input_tokens), geschrieben_1h: zahl(c?.ephemeral_1h_input_tokens),
      cli_version: this.version, mod_version: 'wrapper-stream-v1', erfassung: 'wrapper_stream', zeitbasis: 'turn_beginn', nutzungsumfang: umfang }
  }

  event(wert: unknown, sitzung: string, jetzt: number): CacheStreamMeldung | null {
    const r = obj(wert)
    if (!r || sitzung !== this.sitzung || r.isSidechain === true || r.parent_tool_use_id != null) return null
    if (typeof r.session_id === 'string' && r.session_id !== sitzung) return null
    if (r.type === 'system' && r.subtype === 'init') {
      this.modell = text(r.model); this.version = text(r.claude_code_version)
    }
    const vorher = this.lauf
    this.bindung(r)
    if (this.lauf !== vorher) this.laufAb = this.lauf ? jetzt : 0
    const m = obj(r.message), u = obj(m?.usage)
    if (r.type === 'assistant' && u) this.letzte = this.messung(u, text(m?.model), text(m?.id), jetzt, 'letzte_anfrage')
    if (r.type !== 'result') return null
    if (!this.letzte) {
      const usage = obj(r.usage)
      if (usage) {
        const iterations = Array.isArray(usage.iterations) ? usage.iterations.map(obj).filter(v => v?.type === 'message') : []
        const last = iterations.at(-1)
        this.letzte = this.messung(last ?? usage, this.modell, text(r.uuid), jetzt, last ? 'letzte_anfrage' : 'turn_summe')
      }
    }
    // Actual error-turn usage still counts; no-usage turns never fabricate zero or renew old data.
    if (!this.lauf || !this.letzte) return null
    return {lauf_id: this.lauf, sitzung, messung: {...this.letzte, messung_ms: jetzt, turn_fehler: r.is_error === true}}
  }
}
