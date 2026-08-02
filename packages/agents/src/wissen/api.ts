/**
 * MODUL: api-Umsetzung der Wissensschicht
 * ZWECK: Dieselben Faehigkeiten wie der datei-Weg, aber ueber HTTP gegen die
 *        synapse-api. Ziel ist ein Spezialist, der sein Wissen und seinen
 *        System-Prompt nicht mehr von der Platte des Daemons holt und deshalb
 *        auch woanders laufen kann.
 *
 * STAND: gebaut gegen den im Channel api-bruecke vereinbarten Vertrag
 *        (Nachrichten 18520 / 18522 / 18523). Die Routen entstehen parallel in
 *        packages/rest-api. Solange sie fehlen, scheitert dieser Weg — LAUT.
 *
 * ⚠️ KEIN STILLER RUECKFALL AUF DIE PLATTE. Wer 'api' bestellt und bei einem
 * Ausfall heimlich wieder die Datei bekaeme, saehe einen voellig normal
 * laufenden Spezialisten und wuesste nie, dass die Umstellung nie gegriffen hat.
 * Genau diese Fehlerform hat uns heute zweimal getroffen.
 *
 * BASIS-PFAD: /api/projects/<projekt>/specialists/<agent>/wissen
 */

import type { AgentMeta, SkillFile } from '../skills.js'
import type {
  AgentWissen,
  AnlegeErgebnis,
  WissensUmgebung,
  WissensZugriff,
} from './typen.js'

const ZEITLIMIT_MS = 15_000

/**
 * Kuerzer als das ist kein System-Prompt, sondern ein Unfall. buildSpecialistPrompt
 * erzeugt mehrere tausend Zeichen; der Wert ist bewusst weit darunter, damit er
 * nur den kaputten Fall trifft und nicht einen ungewoehnlich knappen.
 */
export const MINDESTLAENGE_SYSTEM_PROMPT = 200

interface RufOptionen {
  methode?: string
  koerper?: unknown
  /** 404 ist hier eine Auskunft ("unbekannt") und kein Fehler. */
  nullBei404?: boolean
}

export class ApiWissen implements WissensZugriff {
  readonly art = 'api' as const

  private readonly wurzel: string
  private readonly token: string

  constructor(private readonly umgebung: WissensUmgebung) {
    const url = (process.env.SYNAPSE_API_URL ?? '').trim().replace(/\/+$/, '')
    const token = (process.env.SYNAPSE_API_TOKEN ?? '').trim()

    if (!url || !token || !umgebung.projekt) {
      throw new Error(
        'SYNAPSE_WISSEN_QUELLE=api verlangt SYNAPSE_API_URL, SYNAPSE_API_TOKEN und ein Projekt ' +
          `(url=${url ? 'gesetzt' : 'FEHLT'}, token=${token ? 'gesetzt' : 'FEHLT'}, ` +
          `projekt=${umgebung.projekt ? umgebung.projekt : 'FEHLT'}). ` +
          'Ich falle bewusst NICHT auf die Platte zurueck — sonst laeuft der Spezialist unbemerkt ' +
          'weiter ortsgebunden, und die Umstellung saehe erfolgreich aus.',
      )
    }

    this.wurzel = `${url}/api/projects/${encodeURIComponent(umgebung.projekt)}/specialists`
    this.token = token
  }

  private basis(agent: string): string {
    return `${this.wurzel}/${encodeURIComponent(agent)}/wissen`
  }

  private async ruf<T>(pfad: string, optionen: RufOptionen = {}): Promise<T | null> {
    const kopf: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    }
    if (optionen.koerper !== undefined) kopf['Content-Type'] = 'application/json'

    let antwort: Response
    try {
      antwort = await fetch(pfad, {
        method: optionen.methode ?? 'GET',
        headers: kopf,
        body: optionen.koerper !== undefined ? JSON.stringify(optionen.koerper) : undefined,
        signal: AbortSignal.timeout(ZEITLIMIT_MS),
      })
    } catch (err) {
      // Ohne diese Einwicklung steht am Ende ein nacktes "fetch failed" im Log —
      // ohne Adresse, ohne Grund, und es sieht aus wie ein beliebiger Absturz.
      throw new Error(
        `Wissens-API nicht erreichbar (${pfad}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (antwort.status === 401 || antwort.status === 403) {
      this.umgebung.log(
        'WISSEN: Token abgelehnt (%d) bei %s — ab jetzt scheitert JEDER Wissens-Aufruf.',
        antwort.status,
        pfad,
      )
      throw new Error(`HTTP ${antwort.status} bei ${pfad} (Token abgelehnt)`)
    }

    if (antwort.status === 404 && optionen.nullBei404) return null

    if (!antwort.ok) throw new Error(`HTTP ${antwort.status} bei ${pfad}`)

    const daten = (await antwort.json()) as Record<string, unknown>
    if (daten && daten.success === false) {
      const fehler = daten.error as { message?: string } | undefined
      const code = typeof daten.code === 'string' ? daten.code : undefined
      if (code === 'unbekannt' && optionen.nullBei404) return null
      throw new Error(`Wissens-API meldet Fehler bei ${pfad}: ${fehler?.message ?? code ?? 'ohne Begruendung'}`)
    }
    return daten as T
  }

  private async rufPflicht<T>(pfad: string, optionen: RufOptionen = {}): Promise<T> {
    const daten = await this.ruf<T>(pfad, optionen)
    if (daten === null) throw new Error(`Leere Antwort von ${pfad}`)
    return daten
  }

  async liesAlles(agent: string): Promise<AgentWissen | null> {
    const daten = await this.ruf<{
      meta?: AgentMeta | null
      text?: string
      leer?: boolean
      zeilen_gesamt?: number
      warnungen?: string[]
    }>(this.basis(agent), { nullBei404: true })

    if (daten === null) return null

    // Warnungen der Gegenseite (z.B. unlesbares meta) NICHT verschlucken: sie
    // sind der einzige Hinweis darauf, dass etwas nur halb angekommen ist.
    for (const warnung of daten.warnungen ?? []) {
      this.umgebung.log('WISSEN-WARNUNG (%s): %s', agent, warnung)
    }

    if (typeof daten.text !== 'string') {
      // Ein fehlendes Textfeld waere sonst ein leerer Prompt — also ein dummer
      // Agent statt eines Fehlers.
      throw new Error(
        `Wissens-API lieferte kein Feld "text" fuer "${agent}". Der Text geht woertlich in den ` +
          'System-Prompt; ich starte damit nicht.',
      )
    }

    return {
      meta: daten.meta ?? null,
      text: daten.text,
      leer: daten.leer ?? daten.text.trim().length === 0,
    }
  }

  async legeAn(agent: string, model: string, expertise: string): Promise<AnlegeErgebnis> {
    const daten = await this.rufPflicht<{ angelegt?: boolean; grund?: string }>(
      `${this.basis(agent)}/anlegen`,
      { methode: 'POST', koerper: { name: agent, model, expertise } },
    )
    return {
      angelegt: daten.angelegt === true,
      grund: daten.grund ?? (daten.angelegt ? 'angelegt' : 'existierte bereits'),
    }
  }

  async liesArt(agent: string, art: SkillFile): Promise<string | null> {
    const daten = await this.ruf<{ text?: string }>(`${this.basis(agent)}/${art}`, {
      nullBei404: true,
    })
    if (daten === null) return null
    return typeof daten.text === 'string' ? daten.text : null
  }

  async schreibeArt(agent: string, art: SkillFile, inhalt: string): Promise<void> {
    await this.rufPflicht(`${this.basis(agent)}/${art}`, { methode: 'PUT', koerper: { inhalt } })
  }

  async haengeAn(agent: string, art: SkillFile, eintrag: string): Promise<void> {
    await this.rufPflicht(`${this.basis(agent)}/${art}/anhaengen`, {
      methode: 'POST',
      koerper: { inhalt: eintrag },
    })
  }

  async entferneEintraege(agent: string, art: SkillFile, enthaelt: string): Promise<number> {
    const daten = await this.ruf<{ entfernte_zeilen?: number }>(
      `${this.basis(agent)}/${art}/eintraege`,
      { methode: 'DELETE', koerper: { enthaelt }, nullBei404: true },
    )
    if (daten === null) return 0
    return typeof daten.entfernte_zeilen === 'number' ? daten.entfernte_zeilen : 0
  }

  async loescheAlles(agent: string): Promise<number> {
    // Idempotent: ein unbekannter Agent ist kein Fehler beim Loeschen.
    const daten = await this.ruf<{ geloeschte_zeilen?: number }>(this.basis(agent), {
      methode: 'DELETE',
      nullBei404: true,
    })
    const zahl = daten?.geloeschte_zeilen
    if (typeof zahl !== 'number') {
      // ⚠️ Die Antwort trug die Zahl nicht. Das als 0 zu melden waere eine
      // Behauptung ("es war nichts da"), die hier niemand belegen kann — deshalb
      // eine sichtbare Warnung, nicht nur eine stille 0.
      this.umgebung.log(
        'WISSEN: WARNUNG — Loeschen von "%s" lieferte keine Anzahl. Melde 0, WEISS es aber nicht.',
        agent,
      )
      return 0
    }
    this.umgebung.log('WISSEN: Ablage von "%s" geloescht (%d Zeilen).', agent, zahl)
    return zahl
  }

  async legeSystemPromptAb(agent: string, inhalt: string): Promise<void> {
    await this.rufPflicht(`${this.basis(agent)}/system-prompt`, {
      methode: 'PUT',
      koerper: { inhalt },
    })
  }

  async holeSystemPrompt(agent: string): Promise<string> {
    const daten = await this.rufPflicht<{
      vorhanden?: boolean
      laenge?: number
      inhalt?: string
    }>(`${this.basis(agent)}/system-prompt`)

    if (daten.vorhanden === false || typeof daten.inhalt !== 'string') {
      throw new Error(
        `Kein System-Prompt fuer "${agent}" hinterlegt. Ich starte den Agenten NICHT: ein leerer ` +
          'Prompt wirft keinen Fehler, er erzeugt nur einen Agenten, der nicht weiss wer er ist.',
      )
    }

    // Zwei Zahlen vergleichen statt einer glauben: die Gegenseite meldet laenge,
    // ich zaehle selbst. Weichen sie ab, ist unterwegs etwas abgeschnitten
    // worden — und ein halber System-Prompt sieht voellig unauffaellig aus.
    if (typeof daten.laenge === 'number' && daten.laenge !== daten.inhalt.length) {
      throw new Error(
        `System-Prompt fuer "${agent}" unvollstaendig: die API meldet ${daten.laenge} Zeichen, ` +
          `angekommen sind ${daten.inhalt.length}.`,
      )
    }

    if (daten.inhalt.length < MINDESTLAENGE_SYSTEM_PROMPT) {
      throw new Error(
        `System-Prompt fuer "${agent}" ist mit ${daten.inhalt.length} Zeichen zu kurz ` +
          `(mindestens ${MINDESTLAENGE_SYSTEM_PROMPT} erwartet). Das ist kein Prompt, das ist ein Rest.`,
      )
    }

    return daten.inhalt
  }
}
