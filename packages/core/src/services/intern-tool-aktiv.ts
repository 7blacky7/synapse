/**
 * P25-T9: Freischaltung des Tools "intern" als Blattmodul ohne Importe.
 * internToolAktiv() lag frueher in intern-tool.ts. agent-bezug, agent-identitaet, agent-profil-schalter u. a. brauchen nur
 * diese Abfrage und zogen dadurch intern-tool samt Importbaum in den Zyklus intern-schalter -> agent-bezug -> intern-tool
 * -> intern-schalter (TDZ beim Laden: INTERN_SCHALTER, SHELL_ALT_ACTIONS, commitAusfuehrer ...).
 * intern-tool.ts re-exportiert die Funktion; der Wert wird wie bisher einmal beim Laden festgehalten.
 */

const INTERN_TOOL_BEIM_START = process.env.SYNAPSE_INTERN_TOOL === '1';

/** true, wenn der Prozess mit SYNAPSE_INTERN_TOOL=1 gestartet wurde. */
export function internToolAktiv(): boolean {
  return INTERN_TOOL_BEIM_START;
}
