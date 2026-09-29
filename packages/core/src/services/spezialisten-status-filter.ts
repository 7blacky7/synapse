/**
 * MODUL: spezialisten-status-filter
 * ZWECK: specialist(status) — nach Namen filtern und Leichen kenntlich machen (P7-T10).
 *
 * ANNAHME: wrapper.ts schreibt last_activity ueber einen unabhaengigen 90-s-Timer, auch in der
 * Leerlauf-Pause (P7-T18). Ein lebender Wrapper veraltet daher nie; last_activity aelter als die
 * Schwelle (Standard 24 h, Env SYNAPSE_STATUS_VERALTET_H) heisst: Leiche. Kein PID-Check.
 *
 * Regeln:
 *  - ausdruecklich genannte Namen werden IMMER geliefert (veraltet -> verwaist:true + inaktiv_seit)
 *  - ohne Namen: Leichen ausgeblendet, ausser alle:true
 *  - crashed/stopped mit frischer last_activity bleiben sichtbar (nicht verwaist)
 * Reine Funktionen, keine DB.
 */

const STUNDE_MS = 3_600_000
const TAG_MS = 24 * STUNDE_MS
export const STANDARD_VERALTET_H = 24

export interface StatusZeileMin {
  agentName: string
  status: string
  lastActivity: Date
}

export interface BeschrifteteZeile<T extends StatusZeileMin> {
  row: T
  verwaist: boolean
  /** z. B. '120 Tage' / '30 Stunden'; null solange die Zeile frisch ist */
  inaktivSeit: string | null
}

export interface StatusAuswahl<T extends StatusZeileMin> {
  sichtbar: Array<BeschrifteteZeile<T>>
  ausgeblendet: string[]
  ausgeblendetAnzahl: number
  nichtGefunden: string[]
}

/** Namen als Array, JSON-String oder Komma-String; leere Eintraege fliegen raus. */
export function parseNamen(wert: unknown): string[] {
  let liste: unknown[] = []
  if (Array.isArray(wert)) {
    liste = wert
  } else if (typeof wert === 'string') {
    const t = wert.trim()
    if (t.startsWith('[')) {
      try {
        const geparst = JSON.parse(t)
        liste = Array.isArray(geparst) ? geparst : [t]
      } catch {
        liste = t.split(',')
      }
    } else {
      liste = t.split(',')
    }
  }
  return liste
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.trim())
    .filter(x => x.length > 0)
}

/** Schwelle in ms aus SYNAPSE_STATUS_VERALTET_H (Stunden); ungueltig/<=0 -> 24 h. */
export function veraltetSchwelleMs(env: Record<string, string | undefined> = process.env): number {
  const h = Number(env.SYNAPSE_STATUS_VERALTET_H)
  return Number.isFinite(h) && h > 0 ? h * STUNDE_MS : STANDARD_VERALTET_H * STUNDE_MS
}

function dauerText(ms: number): string {
  if (ms >= 2 * TAG_MS) {
    const t = Math.floor(ms / TAG_MS)
    return `${t} ${t === 1 ? 'Tag' : 'Tage'}`
  }
  const h = Math.max(1, Math.floor(ms / STUNDE_MS))
  return `${h} ${h === 1 ? 'Stunde' : 'Stunden'}`
}

export function beschrifteZeile(
  zeile: StatusZeileMin,
  jetzt: number,
  schwelleMs: number,
): { verwaist: boolean; inaktivSeit: string | null } {
  const alter = jetzt - zeile.lastActivity.getTime()
  if (alter >= schwelleMs) return { verwaist: true, inaktivSeit: dauerText(alter) }
  return { verwaist: false, inaktivSeit: null }
}

export interface WaehleOptionen {
  /** String, Array, JSON-String oder Komma-String */
  namen?: unknown
  alle?: boolean
  jetzt?: number
  veraltetMs?: number
}

export function waehleSpezialisten<T extends StatusZeileMin>(
  rows: T[],
  opt: WaehleOptionen = {},
): StatusAuswahl<T> {
  const jetzt = opt.jetzt ?? Date.now()
  const schwelle = opt.veraltetMs ?? veraltetSchwelleMs()
  const namen = parseNamen(opt.namen)
  const beschriftet = (row: T): BeschrifteteZeile<T> => ({ row, ...beschrifteZeile(row, jetzt, schwelle) })

  if (namen.length > 0) {
    const gewuenscht = new Set(namen)
    const sichtbar = rows.filter(r => gewuenscht.has(r.agentName)).map(beschriftet)
    const gefunden = new Set(sichtbar.map(s => s.row.agentName))
    return {
      sichtbar,
      ausgeblendet: [],
      ausgeblendetAnzahl: 0,
      nichtGefunden: namen.filter(n => !gefunden.has(n)),
    }
  }

  const alle = rows.map(beschriftet)
  if (opt.alle) return { sichtbar: alle, ausgeblendet: [], ausgeblendetAnzahl: 0, nichtGefunden: [] }
  const ausgeblendet = alle.filter(z => z.verwaist).map(z => z.row.agentName)
  return {
    sichtbar: alle.filter(z => !z.verwaist),
    ausgeblendet,
    ausgeblendetAnzahl: ausgeblendet.length,
    nichtGefunden: [],
  }
}

/**
 * Antwort-Felder fuer die Statusliste (REST + stdio): Zeile + Kennzeichnung.
 * verwaist/inaktiv_seit nur, wenn zutreffend (spart Kontext).
 */
export function kennzeichnung(z: { verwaist: boolean; inaktivSeit: string | null }): Record<string, unknown> {
  return z.verwaist ? { verwaist: true, inaktiv_seit: z.inaktivSeit } : {}
}

/** Zusatzfelder der Antwort ohne Namen: was ausgeblendet wurde + Hinweis. */
export function ausblendHinweis(a: { ausgeblendet: string[]; ausgeblendetAnzahl: number; nichtGefunden: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (a.ausgeblendetAnzahl > 0) {
    out.ausgeblendet = a.ausgeblendetAnzahl
    out.ausgeblendet_namen = a.ausgeblendet.slice(0, 10)
    out.hinweis_ausgeblendet =
      `${a.ausgeblendetAnzahl} inaktive Eintraege (Leichen) ausgeblendet; alle:true zeigt den Altbestand, purge nur nach Rueckfrage des Users.`
  }
  if (a.nichtGefunden.length > 0) out.nicht_gefunden = a.nichtGefunden
  return out
}
