/**
 * MODUL: leerlauf-entscheidung
 * ZWECK: Reine Zustandslogik fuer die LEERLAUF-PAUSE der keepAlive-Weckrufe (P7-T18,
 *        29.09.2026). Ohne Seiteneffekte, damit testbar.
 *
 * Problem: Ein Agent ohne Aufgabe wurde bei jedem Takt mit "HEARTBEAT — Keine neuen
 * Nachrichten" geweckt und antwortete "HEARTBEAT_OK" — 12 Weckrufe a ~110 Token nach
 * erledigter Arbeit, nur Kontextverbrauch.
 *
 * Regel (aktivitaetsbasiert, keine Abfrage): antwortet der Agent SCHWELLE-mal
 * hintereinander leer (HEARTBEAT_OK) auf einen Leer-Weckruf, gibt es keinen weiteren
 * Leer-Weckruf mehr, bis ein ECHTER Anlass kommt (Channel-Push an ihn, Inbox, Items,
 * wake/NOTIFY, Rotation). Datei-Aenderungen waehrend der Pause wecken nicht einzeln;
 * ihre Anzahl wird gemerkt und beim naechsten echten Anlass als EINE Zeile angehaengt.
 *
 * Nicht beruehrt: heartbeat_enabled, Intervall, Ladder, Rotation, Stuck-Erkennung,
 * Handoff — nur der Leer-Weckruf entfaellt. Schwelle 0 = Verhalten wie bisher.
 */

export const STANDARD_SCHWELLE = 2

export interface LeerlaufZustand {
  /** Leer-Antworten auf Leer-Weckrufe in Folge */
  leerAntworten: number
  /** Datei-Aenderungen, die waehrend der Pause anfielen */
  verpassteDateiAenderungen: number
  /** Pause-Beginn wurde schon geloggt */
  pauseGemeldet: boolean
}

export function neuerLeerlaufZustand(): LeerlaufZustand {
  return { leerAntworten: 0, verpassteDateiAenderungen: 0, pauseGemeldet: false }
}

/** SYNAPSE_LEERLAUF_PAUSE_NACH: ganze Zahl >= 0; 0 = aus; sonst Standard 2. */
export function leseLeerlaufSchwelle(env: Record<string, string | undefined> = process.env): number {
  const roh = env.SYNAPSE_LEERLAUF_PAUSE_NACH
  if (roh === undefined || roh.trim() === '') return STANDARD_SCHWELLE
  if (!/^\d+$/.test(roh.trim())) return STANDARD_SCHWELLE
  return parseInt(roh.trim(), 10)
}

/**
 * Ist die Antwort eine reine Leer-Antwort? Leer, oder nur HEARTBEAT_OK (mit Satzzeichen,
 * Backticks, Whitespace), hoechstens ~40 Zeichen. Alles andere ist eine echte Antwort.
 */
export function istLeerlaufAntwort(content: string | undefined | null): boolean {
  const text = (content ?? '').trim()
  if (text === '') return true
  if (text.length > 40) return false
  const ohneRand = text.replace(/^[\s`*_"'.!\-–—:]+|[\s`*_"'.!\-–—:]+$/g, '')
  return /^heartbeat_ok$/i.test(ohneRand)
}

export function istInPause(z: LeerlaufZustand, schwelle: number): boolean {
  return schwelle > 0 && z.leerAntworten >= schwelle
}

/** Nach einem LEER-WECKRUF: Antwort auswerten. */
export function nachLeerlaufWake(z: LeerlaufZustand, content: string | undefined | null): void {
  if (istLeerlaufAntwort(content)) z.leerAntworten++
  else z.leerAntworten = 0
}

/** Datei-Aenderungen nur in der Pause merken (ausserhalb kommen sie mit dem Weckruf selbst). */
export function merkeDateiAenderungen(z: LeerlaufZustand, anzahl: number, schwelle: number = STANDARD_SCHWELLE): void {
  if (anzahl > 0 && istInPause(z, schwelle)) z.verpassteDateiAenderungen += anzahl
}

/** Einmal je Pause true (fuer eine einzelne Log-Zeile). */
export function pauseNochNichtGemeldet(z: LeerlaufZustand): boolean {
  if (z.pauseGemeldet) return false
  z.pauseGemeldet = true
  return true
}

export interface EchterAnlassErgebnis {
  warPause: boolean
  /** Eine Zeile zum Anhaengen an die Wake-Nachricht, sonst null */
  hinweis: string | null
}

/**
 * Ein ECHTER Anlass (alles ausser dem Leer-Weckruf): Pause beenden, Zaehler zuruecksetzen,
 * gemerkte Datei-Aenderungen als eine Zeile liefern.
 */
export function beiEchtemAnlass(z: LeerlaufZustand, schwelle: number = STANDARD_SCHWELLE): EchterAnlassErgebnis {
  const warPause = istInPause(z, schwelle)
  const n = z.verpassteDateiAenderungen
  z.leerAntworten = 0
  z.verpassteDateiAenderungen = 0
  z.pauseGemeldet = false
  const hinweis = n > 0
    ? `${n} ${n === 1 ? 'Datei-Änderung' : 'Datei-Änderungen'} während der Leerlauf-Pause, Details: files history`
    : null
  return { warPause, hinweis }
}
