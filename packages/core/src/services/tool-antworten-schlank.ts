/**
 * P23-T3 (Befunde P23-T2 thought 6f7d9f88, User 19.10.2026 "oft arbeitet nur EIN Agent, trotzdem zeigen Antworten Fremdes"):
 * SCHLANKE TOOL-ANTWORTEN.
 *
 * SCHALTER (memory regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter agent_profil_schalter funktion
 *   'tool_antworten_schlank' (projekt > global, 'alle' schliesst ihn NICHT ein; intern-Override gleichen Namens), EINE
 *   Lesestelle leseFallSkillSchalter('schlank') in fall-skills.ts. Standard AUS = bisheriges Verhalten unveraendert.
 * WIRKUNG bei EIN (je Produzent an seiner Stelle, hier nur die gemeinsamen Helfer):
 *   1./2. ENTFALLEN (User 20.10.2026, memory entscheidung-fremde-plaene-und-jobs-sichtbar): open_plans und shell_activity
 *      zeigen weiter fremde Plaene/Jobs (Zusammenarbeit); shell_activity nur zeitlich begrenzt (shell-hints.ts,
 *      Einstellung shell_hinweis_minuten), fremde Ergebnisse anbieten unter Schalter shell_fremde_ergebnisse.
 *   3. shell exec stufe 'rueckfrage': ohne Lage-Baum (schlankeShellRueckfrage); Details per shell(get, id, detail:'full').
 *   4. werkzeug_regeln (werkzeug-regeln.ts): auch OHNE Ausweis je Sitzung eines registrierten Agenten nur einmal
 *      (mit Ausweis gilt weiter je Lauf, P22-T48).
 *   5. ENTFALLEN (User, memory entscheidung-code-intel-ohne-grenze): code_intel bleibt ohne zusaetzliche Standardgrenze.
 * DEBUG: leseFallSkillSchalter('schlank', project) -> {aktiv, quelle standard|produkt-schalter|intern, bis, letzter_fehler}.
 */
import { leseFallSkillSchalter } from './fall-skills.js';

/** Wirksamer Stand des Schalters fuer das Projekt; Lesefehler -> AUS (bisheriges Verhalten). */
export async function toolAntwortenSchlank(project?: string | null): Promise<boolean> {
  try {
    return (await leseFallSkillSchalter('schlank', project ?? null)).aktiv;
  } catch {
    return false;
  }
}

/** Felder einer Rueckfrage-Antwort, die nur der Diagnose dienen und per shell(get, id, detail:'full') abrufbar bleiben. */
const RUECKFRAGE_DETAILFELDER = ['lage', 'sicher', 'danach', 'trotzdem', 'bestaetigungsdaten'] as const;

/**
 * shell exec mit stufe 'rueckfrage': nur risiko, error, bestaetigung_id, gueltig_bis, id und ein kurzer Satz, wie man
 * bestaetigt. Andere Antworten bleiben unveraendert. Aendert das Eingabeobjekt nicht.
 */
export function schlankeShellRueckfrage<T extends Record<string, unknown>>(antwort: T): T {
  if (!antwort || antwort.stufe !== 'rueckfrage') return antwort;
  const aus: Record<string, unknown> = { ...antwort };
  for (const feld of RUECKFRAGE_DETAILFELDER) delete aus[feld];
  aus.bestaetigen = 'Nicht ausgefuehrt. Bestaetigen: denselben Befehl mit bestaetigung:{id:<bestaetigung_id>, grund:"<mind. 10 Zeichen>"} '
    + 'bis gueltig_bis erneut senden.'
    + (typeof antwort.id === 'string' && antwort.id ? ' Lage und Details: shell(action:"get", id, detail:"full").' : '');
  return aus as T;
}

/** Wie schlankeShellRueckfrage, aber nur bei wirksamem Schalter fuer das Projekt (REST- und stdio-shell exec). */
export async function schlankeShellRueckfrageWennAktiv<T extends Record<string, unknown>>(project: string | null | undefined, antwort: T): Promise<T> {
  return antwort?.stufe === 'rueckfrage' && await toolAntwortenSchlank(project) ? schlankeShellRueckfrage(antwort) : antwort;
}
