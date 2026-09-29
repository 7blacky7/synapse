/**
 * MODUL: rotations-marker
 * ZWECK: Entscheidung, ob ein angeforderter Rotations-Marker
 *        (/tmp/.specialist-rotate-pending-<name>, geschrieben von thought(trigger_respawn) bzw. vom
 *        Daemon-Job 'rotate') JETZT zur Rotation fuehrt (P7-T13).
 *
 * Frueher pruefte nur heartbeatPoll den Marker — bei hoher Heartbeat-Stufe (bis 60 min) bzw. in der
 * Leerlauf-Pause kam eine angeforderte Rotation spaet. Jetzt pruefen ihn ausserdem ein leichter
 * Timer (nur existsSync, keine DB, keine Tokens, kein Weckruf) und das Turn-Ende.
 *
 * Reine Funktion ohne Seiteneffekte.
 */

/** Takt des Marker-Timers. Nur ein existsSync pro Tick. */
export const MARKER_PRUEF_MS = 10_000

export interface RotationsMarkerLage {
  /** Marker-Datei existiert */
  vorhanden: boolean
  /** der Agent bearbeitet gerade einen Turn (nie mitten im Turn rotieren) */
  busy: boolean
  /** eine Rotation laeuft schon (Sperre gegen Doppelstart) */
  rotationLaeuft: boolean
  /** Wrapper faehrt herunter */
  beendet: boolean
}

export type RotationsMarkerAktion = 'rotieren' | 'nichts'

export function rotationsMarkerAktion(lage: RotationsMarkerLage): RotationsMarkerAktion {
  if (!lage.vorhanden) return 'nichts'
  if (lage.beendet) return 'nichts'
  if (lage.rotationLaeuft) return 'nichts'
  if (lage.busy) return 'nichts' // Marker bleibt liegen; das Turn-Ende prueft ihn erneut
  return 'rotieren'
}
