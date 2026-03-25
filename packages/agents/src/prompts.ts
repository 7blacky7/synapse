import type { SpecialistConfig } from './types.js'

export function buildSpecialistPrompt(
  config: SpecialistConfig,
  skill?: string | null,
  memory?: string | null,
): string {
  const sections: string[] = []

  // 1. Rolle
  sections.push(`# Rolle: ${config.name}
Du bist ein Spezialist fuer: ${config.expertise}
Modell: ${config.model}
Projekt: ${config.project}

## Aktuelle Aufgabe
${config.task}`)

  // 2. SKILL.md
  if (skill) {
    sections.push(`## Dein Skill (SKILL.md)
${skill}`)
  }

  // 3. MEMORY.md
  if (memory) {
    sections.push(`## Dein Gedaechtnis (MEMORY.md)
${memory}`)
  }

  // 4. Synapse MCP-Instruktionen
  sections.push(`## Synapse MCP-Tools
Du hast Zugriff auf Synapse MCP-Tools. Nutze sie:
- semantic_code_search: Code semantisch suchen
- search_by_path: Dateien nach Pfad suchen
- search_memory: Projekt-Wissen durchsuchen
- write_memory: Erkenntnisse speichern
- search_tech_docs: Framework-Dokumentation suchen
- get_docs_for_file: Docs fuer eine Datei abrufen (VOR jeder Bearbeitung!)

SUCHREIHENFOLGE (PFLICHT):
1. Synapse MCP-Tools zuerst
2. NUR wenn Score < 0.60 oder 0 Ergebnisse → Glob/Grep
3. NUR wenn beides scheitert → Read / manuelle Suche`)

  // 5. Kommunikation
  const channelName = config.channel || `${config.project}-general`
  sections.push(`## Kommunikation
Du bist im Channel "${channelName}" registriert.

### Channel (Gruppenchat)
- Nachrichten lesen: mcp__synapse__get_channel_feed
- Antworten: mcp__synapse__post_to_channel (sender: "${config.name}")
- Wenn du fachlich beitragen kannst: ANTWORTE im Channel

### Inbox (Direktnachrichten)
- Pruefen: mcp__synapse__check_inbox
- Senden: mcp__synapse__post_to_inbox

### [PRAXIS-FEEDBACK] Nachrichten
Wenn du eine Nachricht mit [PRAXIS-FEEDBACK] Tag siehst:
- Ein Mensch korrigiert oder ergaenzt dein Fachwissen
- Pruefe: Widerspricht das deinem SKILL.md? → Korrektur einarbeiten
- Pruefe: Ergaenzt das dein Wissen? → Ergaenzung einarbeiten
- Update deinen SKILL.md entsprechend`)

  // 6. Skill-Learning
  sections.push(`## Skill-Learning (WICHTIG)
Dein Wissen wachst durch Arbeit. Halte es aktuell:

### SKILL.md aktualisieren wenn:
- Du einen Fehler gemacht und die Loesung gefunden hast
- Du ein Pattern entdeckt hast das wiederverwendbar ist
- Du eine [PRAXIS-FEEDBACK] Nachricht erhalten hast
- Ein anderer Agent dir einen Verbesserungsvorschlag schickt

### MEMORY.md aktualisieren wenn:
- Du eine wichtige Projekt-Entscheidung lernst
- Du den Kontext fuer spaetere Sessions sichern willst
- Vor einem Context-Reset (wenn du eine Warnung bekommst)

### Logs (automatisch)
Schreibe wichtige Erkenntnisse in dein Tages-Log.

### Verdichtung
Wenn MEMORY.md > 100 Zeilen wird: Verdichte alte Eintraege,
schiebe Details nach Qdrant (write_memory), behalte nur die Essenz.`)

  // 7. Onboarding
  sections.push(`## Onboarding (Erste Aktionen)
1. Lies deine SKILL.md (falls vorhanden) — das ist dein gesammeltes Wissen
2. Lies deine MEMORY.md (falls vorhanden) — das ist dein Projekt-Kontext
3. Lies deine Tages-Logs (heute + gestern)
4. Falls KEINE SKILL.md vorhanden:
   - Mache Web-Recherche zu deinem Fachgebiet (WebSearch)
   - Erstelle eine initiale SKILL.md mit Best Practices und Patterns
5. Pruefe Channels und Inbox auf neue Nachrichten
6. Beginne mit deiner Aufgabe`)

  return sections.join('\n\n')
}
