/**
 * MODUL: Sichtbarkeit der Zugriffsschicht
 * ZWECK: Die Frage "woran WUERDE ich es merken, wenn es kaputt waere?" hat fuer
 *        einen Wrapper eine unangenehme Antwort: gar nicht. Faellt seine
 *        Datenquelle aus, hoert er auf, Nachrichten zu bekommen — und ein Agent
 *        ohne Nachrichten sieht genauso aus wie ein Agent, an den gerade niemand
 *        schreibt. Zwei reale Vorfaelle hatten genau diese Form:
 *          - ein purge, das Erfolg meldete, waehrend der Prozess weiterlief
 *          - ein LISTEN, das an einem Bindestrich scheiterte und dabei ALLE
 *            Benachrichtigungen abschaltete; auffaellig war das nie, weil der
 *            Heartbeat weiterlief, nur eben traege.
 *
 * DAHER: jede Faehigkeit fuehrt Buch, und ein Waechter macht aus den Zahlen von
 * selbst eine Meldung. Nicht der Mensch muss nachsehen — der Wrapper sagt es.
 */

import {
  FAEHIGKEITEN,
  type Faehigkeit,
  type FaehigkeitsZaehler,
  type TransportArt,
  type TransportBilanz,
} from './typen.js'

export class Buchhaltung {
  private readonly faehigkeiten: Record<Faehigkeit, FaehigkeitsZaehler>
  private gesamtAufrufe = 0
  private gesamtFehler = 0
  private letzterErfolgTs: number | null = null
  private abgelehnt = 0
  private liveVerbunden = false
  private liveVersuche = 0
  private liveLebenszeichen: number | null = null
  private liveEreignis: number | null = null
  private liveFehler: string | null = null
  private liveGetrenntSeit: number | null = null
  private serverLuecken = 0
  private eigeneAbrisse = 0

  constructor(
    private readonly art: TransportArt,
    private readonly erwartetLebenszeichen: boolean,
  ) {
    const leer = {} as Record<Faehigkeit, FaehigkeitsZaehler>
    for (const name of FAEHIGKEITEN) {
      leer[name] = {
        aufrufe: 0,
        fehler: 0,
        letzterErfolgTs: null,
        letzterFehler: null,
        letzterFehlerTs: null,
      }
    }
    this.faehigkeiten = leer
  }

  /**
   * Umschliesst einen Aufruf. Fehler werden gezaehlt und WEITERGEWORFEN —
   * die Buchhaltung entscheidet nie, ob ein Fehler folgenlos ist. Das bleibt
   * beim Aufrufer, der es vorher auch schon entschieden hat.
   */
  async messe<T>(faehigkeit: Faehigkeit, aufruf: () => Promise<T>): Promise<T> {
    const zaehler = this.faehigkeiten[faehigkeit]
    zaehler.aufrufe++
    this.gesamtAufrufe++
    try {
      const ergebnis = await aufruf()
      const jetzt = Date.now()
      zaehler.letzterErfolgTs = jetzt
      this.letzterErfolgTs = jetzt
      return ergebnis
    } catch (err) {
      zaehler.fehler++
      this.gesamtFehler++
      zaehler.letzterFehler = err instanceof Error ? err.message : String(err)
      zaehler.letzterFehlerTs = Date.now()
      throw err
    }
  }

  zaehleAblehnung(): void {
    this.abgelehnt++
  }

  liveVerbindungsversuch(): void {
    this.liveVersuche++
  }

  liveVerbindungSteht(): void {
    this.liveVerbunden = true
    this.liveGetrenntSeit = null
    this.liveLebenszeichen = Date.now()
  }

  liveLebenszeichenGesehen(): void {
    this.liveLebenszeichen = Date.now()
  }

  liveEreignisGesehen(): void {
    const jetzt = Date.now()
    this.liveLebenszeichen = jetzt
    this.liveEreignis = jetzt
  }

  /**
   * geplant=true ist das saubere Herunterfahren. Nur ein UNgeplanter Abriss zaehlt
   * als Stoerung — sonst meldete jeder normale Stopp einen Zwischenfall, und die
   * Zahl waere wertlos.
   */
  liveVerbindungWeg(grund: string | null, geplant = false): void {
    if (this.liveVerbunden && !geplant) {
      this.eigeneAbrisse++
      this.liveGetrenntSeit = Date.now()
    }
    this.liveVerbunden = false
    if (grund) this.liveFehler = grund
  }

  /** Loecher, die der Server gemeldet hat (sein LISTEN-Client hat neu verbunden). */
  zaehleServerLuecken(anzahl: number): void {
    this.serverLuecken += anzahl
  }

  lies(): TransportBilanz {
    return {
      art: this.art,
      faehigkeiten: this.faehigkeiten,
      gesamtAufrufe: this.gesamtAufrufe,
      gesamtFehler: this.gesamtFehler,
      letzterErfolgTs: this.letzterErfolgTs,
      abgelehnt: this.abgelehnt,
      liveVerbunden: this.liveVerbunden,
      liveVerbindungsversuche: this.liveVersuche,
      liveLetztesLebenszeichenTs: this.liveLebenszeichen,
      liveLetztesEreignisTs: this.liveEreignis,
      liveLetzterFehler: this.liveFehler,
      liveGetrenntSeitTs: this.liveGetrenntSeit,
      liveServerLuecken: this.serverLuecken,
      liveEigeneAbrisse: this.eigeneAbrisse,
      liveErwartetLebenszeichen: this.erwartetLebenszeichen,
    }
  }
}

// ---------------------------------------------------------------------------
// Waechter
// ---------------------------------------------------------------------------

/** Routinemeldung, damit die Zahlen auch ohne Zwischenfall gelegentlich im Log stehen. */
const ROUTINE_MS = 10 * 60_000
/** Ab hier gilt "seit langem kein einziger Aufruf mehr geglueckt" als Befund. */
const STILLE_MS = 5 * 60_000
/** Wie oft die Stille-Meldung hoechstens wiederholt wird. */
const STILLE_WIEDERHOLUNG_MS = 60_000
/** Der api-Weg schickt alle 15s ein Takt-Signal. 90s ohne eines ist ein toter Strom. */
const LIVE_STILL_MS = 90_000
/** So lange darf der Live-Kanal weg sein, bevor es sich von selbst meldet. */
const LIVE_GETRENNT_MS = 60_000

function vorWieLange(ts: number | null, jetzt: number): string {
  if (ts === null) return 'nie'
  const sekunden = Math.round((jetzt - ts) / 1000)
  if (sekunden < 120) return `vor ${sekunden}s`
  return `vor ${Math.round(sekunden / 60)}min`
}

/**
 * Nimmt eine Bilanz entgegen und liefert eine Meldung, wenn es etwas zu melden
 * gibt — sonst null. Der Aufrufer schreibt sie ins Log. Bewusst als reine
 * Zustandsmaschine: sie wiederholt sich nicht, drosselt aber auch nichts weg,
 * was neu ist.
 */
export class BilanzWaechter {
  private letzteRoutineTs = 0
  private letzteStilleTs = 0
  private letzteLiveStilleTs = 0
  private gemeldeteFehler = 0
  private gemeldeteAblehnungen = 0
  private gemeldeteServerLuecken = 0
  private readonly startTs = Date.now()

  pruefe(bilanz: TransportBilanz, jetzt: number = Date.now()): string | null {
    const kopf = this.kopfzeile(bilanz, jetzt)

    // 1. Abgelehntes Token zuerst. Es sperrt ALLES gleichzeitig aus und ist der
    //    Fall, der am staerksten nach Ruhe aussieht.
    if (bilanz.abgelehnt > this.gemeldeteAblehnungen) {
      const neu = bilanz.abgelehnt - this.gemeldeteAblehnungen
      this.merkeGemeldet(bilanz, jetzt)
      return (
        `TRANSPORT-ALARM: ${neu} Aufruf(e) mit 401/403 ABGELEHNT — das Token wird nicht akzeptiert. ` +
        `Der Wrapper bekommt keine Nachrichten mehr und schreibt keinen Status mehr; im Log sieht das ` +
        `sonst aus wie ein ruhiger Agent. ${kopf}`
      )
    }

    // 2. Neue Fehler seit der letzten Meldung.
    if (bilanz.gesamtFehler > this.gemeldeteFehler) {
      const neu = bilanz.gesamtFehler - this.gemeldeteFehler
      const schlimmste = this.schlimmsteFaehigkeit(bilanz)
      this.merkeGemeldet(bilanz, jetzt)
      return `TRANSPORT-FEHLER: ${neu} neue seit der letzten Meldung${schlimmste}. ${kopf}`
    }

    // 3. Stille: es wurde versucht, aber lange nichts hat geklappt.
    const bezug = bilanz.letzterErfolgTs ?? this.startTs
    if (bilanz.gesamtAufrufe > 0 && jetzt - bezug > STILLE_MS) {
      if (jetzt - this.letzteStilleTs >= STILLE_WIEDERHOLUNG_MS) {
        this.letzteStilleTs = jetzt
        this.letzteRoutineTs = jetzt
        return (
          `TRANSPORT-STILLE: seit ${vorWieLange(bilanz.letzterErfolgTs, jetzt)} ist kein einziger Aufruf ` +
          `mehr geglueckt. Keine Nachricht heisst hier NICHT "niemand schreibt". ${kopf}`
        )
      }
    }

    // 4. Live-Kanal schweigt, obwohl er ein Takt-Signal schicken muesste.
    if (bilanz.liveErwartetLebenszeichen && bilanz.liveVerbunden) {
      const letztes = bilanz.liveLetztesLebenszeichenTs
      if (letztes !== null && jetzt - letztes > LIVE_STILL_MS) {
        if (jetzt - this.letzteLiveStilleTs >= STILLE_WIEDERHOLUNG_MS) {
          this.letzteLiveStilleTs = jetzt
          this.letzteRoutineTs = jetzt
          return (
            `TRANSPORT-LIVE-STILLE: der Live-Kanal gilt als verbunden, hat aber seit ` +
            `${vorWieLange(letztes, jetzt)} kein Lebenszeichen geschickt. Weckrufe kommen dann nur noch ` +
            `ueber den Poll-Takt an. ${kopf}`
          )
        }
      }
    }

    // 4b. Der Kanal ist weg und kommt nicht zurueck. Das ist der zweite Teil der
    //     Antwort auf "woran WUERDE ich merken, dass MEINE Verbindung abgerissen
    //     ist": der Abriss selbst steht sofort im Log und loest einen Poll aus,
    //     und bleibt er bestehen, meldet er sich hier immer wieder von selbst.
    if (bilanz.liveErwartetLebenszeichen && !bilanz.liveVerbunden && bilanz.liveGetrenntSeitTs !== null) {
      if (
        jetzt - bilanz.liveGetrenntSeitTs > LIVE_GETRENNT_MS &&
        jetzt - this.letzteLiveStilleTs >= STILLE_WIEDERHOLUNG_MS
      ) {
        this.letzteLiveStilleTs = jetzt
        this.letzteRoutineTs = jetzt
        return (
          `TRANSPORT-LIVE-GETRENNT: der Live-Kanal ist seit ${vorWieLange(bilanz.liveGetrenntSeitTs, jetzt)} weg ` +
          `(${bilanz.liveVerbindungsversuche} Verbindungsversuche, zuletzt: ${bilanz.liveLetzterFehler ?? 'ohne Text'}). ` +
          `Weckrufe kommen bis zur Rueckkehr nur noch ueber den Poll-Takt an. ${kopf}`
        )
      }
    }

    // 4c. Loecher, die NUR der Server kennt. Sie sind einzeln schon protokolliert;
    //     hier steht die Summe, damit sie auch dem auffaellt, der die Zeilen ueberliest.
    if (bilanz.liveServerLuecken > this.gemeldeteServerLuecken) {
      const neu = bilanz.liveServerLuecken - this.gemeldeteServerLuecken
      this.gemeldeteServerLuecken = bilanz.liveServerLuecken
      this.letzteRoutineTs = jetzt
      return (
        `TRANSPORT-LIVE-LUECKE: der LISTEN-Client der API hat ${neu}mal neu verbunden. In dieser Zeit war ` +
        `der Live-Kanal blind, ohne dass die eigene Verbindung etwas gemerkt haette. ${kopf}`
      )
    }

    // 5. Routine, damit die Zahlen auch im Normalbetrieb belegt sind.
    if (jetzt - this.letzteRoutineTs >= ROUTINE_MS) {
      this.letzteRoutineTs = jetzt
      return `TRANSPORT-BILANZ: ${kopf}`
    }

    return null
  }

  private merkeGemeldet(bilanz: TransportBilanz, jetzt: number): void {
    this.gemeldeteFehler = bilanz.gesamtFehler
    this.gemeldeteAblehnungen = bilanz.abgelehnt
    this.letzteRoutineTs = jetzt
  }

  private schlimmsteFaehigkeit(bilanz: TransportBilanz): string {
    let name: Faehigkeit | null = null
    let letzter: string | null = null
    let neuesteTs = 0
    for (const schluessel of Object.keys(bilanz.faehigkeiten) as Faehigkeit[]) {
      const z = bilanz.faehigkeiten[schluessel]
      if (z.letzterFehlerTs !== null && z.letzterFehlerTs >= neuesteTs) {
        neuesteTs = z.letzterFehlerTs
        name = schluessel
        letzter = z.letzterFehler
      }
    }
    if (!name) return ''
    return `, zuletzt bei "${name}": ${letzter ?? 'ohne Text'}`
  }

  private kopfzeile(bilanz: TransportBilanz, jetzt: number): string {
    const live = bilanz.liveErwartetLebenszeichen || bilanz.liveVerbindungsversuche > 0
      ? ` live=${bilanz.liveVerbunden ? 'verbunden' : 'getrennt'}` +
        ` (Versuche=${bilanz.liveVerbindungsversuche},` +
        ` eigeneAbrisse=${bilanz.liveEigeneAbrisse},` +
        ` Serverluecken=${bilanz.liveServerLuecken},` +
        ` Lebenszeichen=${vorWieLange(bilanz.liveLetztesLebenszeichenTs, jetzt)},` +
        ` Ereignis=${vorWieLange(bilanz.liveLetztesEreignisTs, jetzt)})`
      : ''
    return (
      `[Weg=${bilanz.art} Aufrufe=${bilanz.gesamtAufrufe} Fehler=${bilanz.gesamtFehler}` +
      ` abgelehnt=${bilanz.abgelehnt} letzterErfolg=${vorWieLange(bilanz.letzterErfolgTs, jetzt)}${live}]`
    )
  }
}
