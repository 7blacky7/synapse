/**
 * MODUL: Verlauf des API-Agent-Workers (P22-T8)
 * ZWECK: Gespraechsverlauf je Lauf (SYNAPSE_SESSION_ID) als JSONL unter .synapse/agents/<name>/api-verlauf-<session>.jsonl -
 *        dieselbe Ablage wie das Wissen lokaler Spezialisten (kein neuer Ort). Jede Nachricht und jeder Werkzeugaufruf-Vermerk
 *        wird SOFORT angehaengt.
 * NEUSTART: Laedt der Worker einen vorhandenen Verlauf (gleiche Session), wird ein vermerkter Werkzeugaufruf ohne Ergebnis
 *   NICHT wiederholt: er bekommt ein Fehler-Ergebnis "nach Neustart unbekannt", damit das Modell den Zustand erst prueft.
 *   Ein neuer Lauf (neue Session, wie bei der Claude-CLI) beginnt leer; Uebergaben laufen ueber den normalen Handoff.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Nachricht, VerlaufSpeicher, WerkzeugAufruf, WerkzeugErgebnis } from './toolschleife.js'

type Zeile = { art: 'nachricht'; nachricht: Nachricht } | { art: 'aufruf'; id: string; name: string; zeit: string }

export const NACH_NEUSTART_UNBEKANNT = 'Ergebnis nach Neustart des Workers unbekannt - der Aufruf wurde NICHT wiederholt. '
  + 'Vor einem erneuten Aufruf den Zustand pruefen (z. B. files history, plan, thought), damit nichts doppelt geschrieben wird.'

export class DateiVerlauf implements VerlaufSpeicher {
  private liste: Nachricht[] = []

  private constructor(private readonly pfad: string) {}

  /** Laedt (falls vorhanden) und repariert offene Werkzeugaufrufe; schreibt die Reparatur sofort an. */
  static async oeffne(pfad: string): Promise<DateiVerlauf> {
    const v = new DateiVerlauf(pfad)
    await mkdir(dirname(pfad), { recursive: true })
    if (!existsSync(pfad)) return v
    const vermerkt = new Map<string, string>()
    for (const roh of (await readFile(pfad, 'utf-8')).split('\n')) {
      if (!roh.trim()) continue
      let z: Zeile
      try { z = JSON.parse(roh) as Zeile } catch { continue }
      if (z.art === 'nachricht') v.liste.push(z.nachricht)
      else if (z.art === 'aufruf') vermerkt.set(z.id, z.name)
    }
    const offen = v.offeneAufrufe()
    if (offen.length) {
      const ergebnisse: WerkzeugErgebnis[] = offen.map(a => ({
        typ: 'werkzeug_ergebnis', aufruf_id: a.id, fehler: true,
        inhalt: [{ typ: 'text', text: (vermerkt.has(a.id) ? '' : '(Aufruf war noch nicht gestartet) ') + NACH_NEUSTART_UNBEKANNT }],
      }))
      await v.fuegeHinzu({ rolle: 'user', inhalt: ergebnisse })
    }
    return v
  }

  /** Werkzeugaufrufe der letzten assistant-Nachricht ohne folgendes Ergebnis. */
  private offeneAufrufe(): WerkzeugAufruf[] {
    const letzte = this.liste[this.liste.length - 1]
    if (!letzte || letzte.rolle !== 'assistant') return []
    return letzte.inhalt.filter((b): b is WerkzeugAufruf => b.typ === 'werkzeug_aufruf')
  }

  nachrichten(): Nachricht[] {
    return this.liste
  }

  async fuegeHinzu(n: Nachricht): Promise<void> {
    this.liste.push(n)
    await appendFile(this.pfad, JSON.stringify({ art: 'nachricht', nachricht: n } satisfies Zeile) + '\n')
  }

  async vermerkeAufruf(a: WerkzeugAufruf): Promise<void> {
    await appendFile(this.pfad, JSON.stringify({ art: 'aufruf', id: a.id, name: a.name, zeit: new Date().toISOString() } satisfies Zeile) + '\n')
  }
}
