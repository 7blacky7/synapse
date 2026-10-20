/**
 * P22-T63 Stufe 2 A3 (Nachtrag 823715c5): Inhalt einer CLI-Sitzung aus der Session-JSONL (Claude-Format; die Codex-Runtime
 * schreibt dieselbe Form) als Eintraege fuer den Verlauf des Hauptagenten. Vollstaendig, nichts wird gekuerzt: Eingaben
 * (der Turn, wie das Modell ihn bekam), Antworttexte, Werkzeug-Aufrufe mit vollem Input, Werkzeug-Ergebnisse mit vollem
 * Inhalt, Denkphasen. ref = <uuid der Zeile>:<Block-Index> ist je Eintrag eindeutig; der Server nimmt jede ref genau einmal
 * auf. Rein (kein Dateizugriff), damit es mit einer Fixture getestet werden kann.
 */

export type SitzungsArt = 'eingabe' | 'text' | 'werkzeug_aufruf' | 'werkzeug_ergebnis' | 'denken'

export interface SitzungsEintrag {
  ref: string
  art: SitzungsArt
  /** Werkzeugname (werkzeug_aufruf). */
  name?: string | null
  /** Voller Inhalt: Text bzw. Werkzeug-Input/-Ergebnis unveraendert. */
  inhalt: unknown
  werkzeug_id?: string | null
  zeit?: string | null
  modell?: string | null
  fehler?: boolean
}

function textAus(v: unknown): unknown {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.every((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')) {
    return v.map((b) => String((b as { text?: unknown }).text ?? '')).join('')
  }
  return v
}

export function sitzungsEintraegeAus(zeilen: readonly string[]): SitzungsEintrag[] {
  const aus: SitzungsEintrag[] = []
  for (const zeile of zeilen) {
    if (!zeile.trim()) continue
    let obj: Record<string, unknown>
    try { obj = JSON.parse(zeile) as Record<string, unknown> } catch { continue }
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : null
    const typ = obj.type
    const msg = (obj.message ?? null) as { content?: unknown; model?: unknown } | null
    if (!uuid || (typ !== 'user' && typ !== 'assistant') || !msg) continue
    const zeit = typeof obj.timestamp === 'string' ? obj.timestamp : null
    const modell = typeof msg.model === 'string' ? msg.model : null
    const inhalt = msg.content
    if (typeof inhalt === 'string') {
      aus.push({ ref: uuid + ':0', art: typ === 'user' ? 'eingabe' : 'text', inhalt, zeit, modell })
      continue
    }
    if (!Array.isArray(inhalt)) continue
    inhalt.forEach((b, i) => {
      const block = (b ?? {}) as Record<string, unknown>
      const ref = uuid + ':' + i
      if (block.type === 'text') aus.push({ ref, art: typ === 'user' ? 'eingabe' : 'text', inhalt: String(block.text ?? ''), zeit, modell })
      else if (block.type === 'tool_use') {
        aus.push({ ref, art: 'werkzeug_aufruf', name: typeof block.name === 'string' ? block.name : null, inhalt: block.input,
          werkzeug_id: typeof block.id === 'string' ? block.id : null, zeit, modell })
      } else if (block.type === 'tool_result') {
        aus.push({ ref, art: 'werkzeug_ergebnis', inhalt: textAus(block.content), fehler: block.is_error === true,
          werkzeug_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : null, zeit, modell })
      } else if (block.type === 'thinking') {
        aus.push({ ref, art: 'denken', inhalt: String(block.thinking ?? ''), zeit, modell })
      }
    })
  }
  return aus
}
