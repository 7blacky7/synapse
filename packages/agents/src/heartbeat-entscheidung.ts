/**
 * MODUL: heartbeat-entscheidung
 * ZWECK: Reine Entscheidung, was ein Wrapper mit ABGESCHALTETEM Heartbeat in einem
 *        Waechter-Takt tut (P7-T19, 29.09.2026). Ohne Seiteneffekte, damit testbar.
 *
 * Abgeschaltet heisst still, nicht taub: ein Weckruf (wake / LISTEN hot) muss auch
 * dann zugestellt werden. Vorher stieg heartbeatPoll bei abgeschaltetem Heartbeat
 * sofort aus und nur eine nachgewiesene Luecke im Live-Kanal loeste einen Durchgang
 * aus — der Weckruf blieb in pendingNotifyWakes liegen.
 *
 * Der Takt selbst wird NIE wieder eingeschaltet: es gibt nur 'nichts' oder EINEN
 * Nachhol-Durchgang. Ist der Agent busy, bleibt der Weckruf in der Queue und wird
 * im naechsten Waechter-Takt (60 s) bzw. nach Leerlauf zugestellt.
 */
export interface AbgeschaltetEingabe {
  /** Der Server meldete seit dem letzten Takt ein Loch im Live-Kanal */
  luecke: boolean
  /** Anzahl wartender Weckrufe (pendingNotifyWakes) */
  wartendeWakes: number
  /** Agent arbeitet gerade */
  busy: boolean
}

export interface AbgeschaltetEntscheidung {
  aktion: 'nichts' | 'nachholPoll'
  grund: 'wake' | 'wake-busy' | 'luecke' | 'still'
}

export function entscheideAbgeschaltet(e: AbgeschaltetEingabe): AbgeschaltetEntscheidung {
  if (e.wartendeWakes > 0) {
    return e.busy
      ? { aktion: 'nichts', grund: 'wake-busy' }
      : { aktion: 'nachholPoll', grund: 'wake' }
  }
  if (e.luecke) return { aktion: 'nachholPoll', grund: 'luecke' }
  return { aktion: 'nichts', grund: 'still' }
}
