/**
 * P22-T68: Deep-Link zur Ausweis-Verwaltung (Einstellungen > Agenten-Ausweis) mit vorgewaehlter Identitaet.
 * Aufrufer (Agententeam, Teilnehmer-Chips im Channel) rufen oeffneAusweisVerwaltung; die Arbeitsflaeche wechselt zu den Einstellungen,
 * die Einstellungen waehlen die Kachel, das Panel waehlt die Identitaet. Das Ziel wartet im Modul, bis die Einstellungen es abholen.
 */
export const AUSWEIS_OEFFNEN_EVENT = 'synapse:ausweis-oeffnen';

export interface AusweisZiel { project: string; agentId: string }

let wartend: AusweisZiel | null = null;

export function oeffneAusweisVerwaltung(ziel: AusweisZiel): void {
  wartend = ziel;
  window.dispatchEvent(new CustomEvent<AusweisZiel>(AUSWEIS_OEFFNEN_EVENT, { detail: ziel }));
}

/** Holt das wartende Ziel ab (einmalig). */
export function nimmWartendesAusweisZiel(): AusweisZiel | null {
  const ziel = wartend;
  wartend = null;
  return ziel;
}
