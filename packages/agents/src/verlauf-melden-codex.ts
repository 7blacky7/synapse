/**
 * P22-T288 W2 (Analyse efbe02f1): lokale Codex-Sitzungen (~/.codex/sessions/<JJJJ>/<MM>/<TT>/rollout-*.jsonl, codex-tui/exec) als
 * Eintraege fuer den Agenten-Verlauf - dieselbe Form wie sitzungsEintraegeAus (Claude-JSONL), damit der Daemon (cli-verlauf.ts) sie
 * ueber DIESELBE Route/Schreibstelle meldet (POST /api/daemon/cli-verlauf -> importiereSitzungsEintraege, runtime codex). Rein.
 * ZEILEN {timestamp, type, payload}:
 *   response_item message role user      -> eingabe (input_text-Bloecke; developer/system bleiben draussen)
 *   response_item message role assistant -> text (output_text)
 *   response_item reasoning               -> denken (nur summary-Text, der verschluesselte Inhalt nie)
 *   response_item function_call | custom_tool_call               -> werkzeug_aufruf (name, arguments bzw. input, call_id)
 *   response_item function_call_output | custom_tool_call_output -> werkzeug_ergebnis (output, voller Text)
 *   turn_context                          -> Modell der folgenden Eintraege
 *   event_msg token_count                 -> info.last_token_usage als tokens_gemessen am letzten Eintrag davor
 *                                            (kontext = input_tokens, cache_read = cached_input_tokens); je Eintrag hoechstens einmal
 * ref = 'cx:' + payload.id (msg_/rs_/fc_/fco_/ctc_/ctco_ ...); ohne id wird die Zeile uebersprungen.
 * AUSWEIS: chat(anmelden) steht im Code-Modus im exec-Input (tools.mcp__<server>__chat({action:"anmelden", agent_kennung:"sai_.."})) oder
 *   als function_call mit Namen *chat und JSON-arguments.
 */
import type { SitzungsEintrag, SitzungsTokens } from './verlauf-melden.js'

const AUSWEIS = /^sai_[A-Za-z0-9_-]{1,64}$/
const ANMELDEN_CODE = /chat\s*\(\s*\{[^}]*\banmelden\b[^}]*\}/g
const KENNUNG = /\b(?:agent_kennung|token)\s*:\s*["'](sai_[A-Za-z0-9_-]{1,64})["']/

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null)
const textBloecke = (inhalt: unknown, typ: string): string =>
  (Array.isArray(inhalt) ? inhalt : []).map((b) => obj(b)).filter((b): b is Obj => !!b && b.type === typ && typeof b.text === 'string')
    .map((b) => b.text as string).join('\n')

/** Ausweis aus einer Rollout-Zeile mit chat(anmelden), sonst null. Rein. */
export function codexAusweisAusZeile(zeile: string): string | null {
  if (!zeile.includes('anmelden') || !zeile.includes('sai_')) return null
  let o: Obj | null
  try { o = obj(JSON.parse(zeile)) } catch { return null }
  const p = obj(o?.payload)
  if (o?.type !== 'response_item' || !p) return null
  if (p.type === 'custom_tool_call' && typeof p.input === 'string') {
    let gefunden: string | null = null
    for (const m of p.input.matchAll(ANMELDEN_CODE)) {
      const k = KENNUNG.exec(m[0])
      if (k && AUSWEIS.test(k[1])) gefunden = k[1]
    }
    return gefunden
  }
  if (p.type === 'function_call' && typeof p.name === 'string' && /(^|__)chat$/.test(p.name) && typeof p.arguments === 'string') {
    try {
      const a = obj(JSON.parse(p.arguments))
      const k = a?.agent_kennung ?? a?.token
      return a?.action === 'anmelden' && typeof k === 'string' && AUSWEIS.test(k) ? k : null
    } catch { return null }
  }
  return null
}

/** last_token_usage eines token_count-Ereignisses -> SitzungsTokens; leer = null. Rein. */
export function codexTokens(info: unknown): SitzungsTokens | null {
  const u = obj(obj(info)?.last_token_usage)
  if (!u) return null
  const z = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const input = z(u.input_tokens)
  const output = z(u.output_tokens)
  if (input + output <= 0) return null
  return { input, output, cache_read: z(u.cached_input_tokens), cache_creation: z(u.cache_write_input_tokens), kontext: input }
}

/** Rollout-Zeilen -> Eintraege (wie sitzungsEintraegeAus). modell: Startwert (z. B. aus dem Stand), turn_context ueberschreibt. Rein. */
export function codexEintraegeAus(zeilen: readonly string[], o: { modell?: string | null } = {}): SitzungsEintrag[] {
  const aus: SitzungsEintrag[] = []
  let modell = o.modell ?? null
  let letzterMitTokens = -1
  for (const zeile of zeilen) {
    if (!zeile.trim()) continue
    let z: Obj | null
    try { z = obj(JSON.parse(zeile)) } catch { continue }
    const p = obj(z?.payload)
    if (!z || !p) continue
    const zeit = typeof z.timestamp === 'string' ? z.timestamp : null
    if (z.type === 'turn_context') { if (typeof p.model === 'string' && p.model) modell = p.model; continue }
    if (z.type === 'event_msg') {
      if (p.type !== 'token_count' || !aus.length || letzterMitTokens === aus.length - 1) continue
      const t = codexTokens(p.info)
      if (t) { aus[aus.length - 1].tokens_gemessen = t; letzterMitTokens = aus.length - 1 }
      continue
    }
    if (z.type !== 'response_item' || typeof p.id !== 'string' || !p.id) continue
    const ref = 'cx:' + p.id
    const callId = typeof p.call_id === 'string' ? p.call_id : null
    switch (p.type) {
      case 'message': {
        if (p.role === 'user') { const t = textBloecke(p.content, 'input_text'); if (t) aus.push({ ref, art: 'eingabe', inhalt: t, zeit, modell }) }
        else if (p.role === 'assistant') { const t = textBloecke(p.content, 'output_text'); if (t) aus.push({ ref, art: 'text', inhalt: t, zeit, modell }) }
        break
      }
      case 'reasoning': {
        const t = textBloecke(p.summary, 'summary_text')
        if (t) aus.push({ ref, art: 'denken', inhalt: t, zeit, modell })
        break
      }
      case 'function_call': {
        let inhalt: unknown = p.arguments ?? null
        if (typeof inhalt === 'string') { try { inhalt = JSON.parse(inhalt) } catch { /* Text bleibt */ } }
        aus.push({ ref, art: 'werkzeug_aufruf', name: typeof p.name === 'string' ? p.name : null, inhalt, werkzeug_id: callId, zeit, modell })
        break
      }
      case 'custom_tool_call':
        aus.push({ ref, art: 'werkzeug_aufruf', name: typeof p.name === 'string' ? p.name : null, inhalt: p.input ?? null, werkzeug_id: callId, zeit, modell })
        break
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const roh = p.output
        const t = typeof roh === 'string' ? roh : textBloecke(roh, 'input_text') || (roh === undefined ? null : JSON.stringify(roh))
        aus.push({ ref, art: 'werkzeug_ergebnis', inhalt: t, werkzeug_id: callId, zeit, modell })
        break
      }
      default: break
    }
  }
  return aus
}
