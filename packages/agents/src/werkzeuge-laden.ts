/**
 * MODUL: werkzeuge-laden
 * ZWECK: Hinweis fuer Spezialisten, ihre Synapse-Tools GEZIELT zu laden (P7-T16).
 *
 * Beleg 29.09.: ein Respawn mit ToolSearch('synapse', max_results: 30) kostete +42k Kontext allein
 * durch Tool-Schemas. Weder System-Prompt noch Reset-Text sagten, welche Tools gebraucht werden,
 * also suchte der Agent breit. Dieser Text steht im System-Prompt (buildSpecialistPrompt) und im
 * Onboarding nach einer Rotation (wrapper.ts).
 *
 * PRAEFIX-NEUTRAL: der Werkzeug-Praefix (mcp__synapse-direkt__ / mcp__synapse__) kommt aus der
 * MCP-Konfiguration des Projekts und steht im Wrapper nicht fest.
 * Der Absatz gilt fuer alle Runtimes (Gemini/agy kennen kein ToolSearch — dort harmlos).
 */

/** Standardliste: was ein Spezialist fuer den Normalbetrieb braucht. */
export const STANDARD_WERKZEUGE = ['specialist', 'channel', 'plan', 'code_intel', 'files', 'shell'] as const

/** Erst bei Bedarf laden, jeweils einzeln. */
export const WERKZEUGE_BEI_BEDARF = ['skills', 'jev', 'memory', 'thought', 'event', 'chat', 'docs', 'search'] as const

/** Kurzfassung fuer den Reset-Text (eine Zeile). */
export function baueWerkzeugHinweisKurz(): string {
  const liste = STANDARD_WERKZEUGE.map(n => `<praefix>${n}`).join(',')
  return `Werkzeuge: ToolSearch NUR mit select:${liste} laden (praefix = wie in deiner Tool-Liste, z. B. mcp__synapse-direkt__) — nie breit nach "synapse" mit max_results 30 suchen (~40k Kontext).`
}

/** Voller Abschnitt fuer den System-Prompt. */
export function baueWerkzeugHinweis(): string {
  const liste = STANDARD_WERKZEUGE.map(n => `<praefix>${n}`).join(',')
  return `## Werkzeuge laden (Kontext sparen)
Deine Synapse-Tools sind aufgeschoben und muessen per ToolSearch geladen werden. Lade GEZIELT:
ToolSearch mit query "select:${liste}"
(<praefix> = wie in deiner Tool-Liste, z. B. mcp__synapse-direkt__ oder mcp__synapse__)

- NIE per Stichwort nach "synapse" mit max_results 30 suchen: allein die Tool-Schemas kosten ~40k Kontext.
- Weitere Tools (${WERKZEUGE_BEI_BEDARF.join(', ')}) nur bei Bedarf und einzeln per select:<praefix><name> laden.
- jev nur laden, wenn eine Tool-Antwort den Hinweis jev_modus traegt (User abwesend, Entscheidungen ueber jev).`
}
