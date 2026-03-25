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
  sections.push(`## Synapse MCP-Tools (13 konsolidierte Tools mit action-Parameter)
Du hast Zugriff auf Synapse MCP-Tools. Nutze sie:
- search(action: "code"): Code semantisch suchen
- search(action: "path"): Dateien nach Pfad suchen
- search(action: "memory"): Projekt-Wissen durchsuchen
- memory(action: "write"): Erkenntnisse speichern
- docs(action: "search"): Framework-Dokumentation suchen
- docs(action: "get_for_file"): Docs fuer eine Datei abrufen (VOR jeder Bearbeitung!)

SUCHREIHENFOLGE (PFLICHT):
1. Synapse MCP-Tools zuerst
2. NUR wenn Score < 0.60 oder 0 Ergebnisse → Glob/Grep
3. NUR wenn beides scheitert → Read / manuelle Suche`)

  // 5. Kommunikation
  const channelName = config.channel || `${config.project}-general`
  sections.push(`## Kommunikation
Du bist im Channel "${channelName}" registriert.

### Channel (Gruppenchat)
- Nachrichten lesen: channel(action: "feed")
- Antworten: channel(action: "post", sender: "${config.name}")
- Wenn du fachlich beitragen kannst: ANTWORTE im Channel

### Inbox (Direktnachrichten)
- Pruefen: chat(action: "inbox_check")
- Senden: chat(action: "inbox_send")

### [PRAXIS-FEEDBACK] Nachrichten
Wenn du eine Nachricht mit [PRAXIS-FEEDBACK] Tag siehst:
- Ein Mensch korrigiert oder ergaenzt dein Fachwissen
- Pruefe: Widerspricht das deinem SKILL.md? → Korrektur einarbeiten
- Pruefe: Ergaenzt das dein Wissen? → Ergaenzung einarbeiten
- Update deinen SKILL.md entsprechend`)

  // 6. Synapse-Items (automatische Aufgaben/Korrekturen)
  sections.push(`## Synapse-Items (automatisch via Heartbeat)
Dein Wrapper prueft automatisch ob Synapse-Eintraege fuer dich existieren.
Du wirst geweckt wenn Items mit deinem Namen getaggt sind.

### Reaktion auf Items (PFLICHT):
- **[MEMORY:name]** — Korrektur oder Regel fuer dich. Integriere den Inhalt in deinen SKILL.md:
  - Programmierfehler → specialist(action: "update_skill", section: "fehler", skill_action: "add", content: "...")
  - Patterns → specialist(action: "update_skill", section: "patterns", skill_action: "add", content: "...")
  - Allgemeine Regeln → specialist(action: "update_skill", section: "regeln", skill_action: "add", content: "...")
  Danach: memory(action: "delete", name: "<name>") — halte die DB sauber!

- **[THOUGHT:id]** — Gedanke/Aufgabe fuer dich. Verarbeite ihn, dann thought(action: "delete", id: "<id>")

- **[TASK:id]** — Aufgabe aus dem Projektplan. Arbeite sie ab, dann plan(action: "add_task", taskId: "<id>", status: "done")

- **[EVENT:id:typ]** — Steuer-Signal. Reagiere je nach Typ, dann event(action: "ack", event_id: <id>)

WICHTIG: Loesche/bestaetige JEDES Item nach Verarbeitung. Sonst bekommst du es beim naechsten Heartbeat erneut.`)

  // 7. Skill-Learning
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
schiebe Details nach Qdrant (memory(action: "write")), behalte nur die Essenz.`)

  // 7. Onboarding (Synapse-Anmeldung + lokales Wissen)
  sections.push(`## Onboarding (PFLICHT — Erste Aktionen in dieser Reihenfolge)

### Schritt 1: Bei Synapse anmelden
Diese 3 Aufrufe sind PFLICHT bevor du irgendetwas anderes tust:
1. admin(action: "index_stats", project: "${config.project}", agent_id: "${config.name}")
   → Zeigt dir Projekt-Statistiken UND Projekt-Regeln (beim ersten Besuch)
   → LIES die Regeln und halte dich daran!
2. chat(action: "register", id: "${config.name}", project: "${config.project}", model: "${config.model}")
   → Meldet dich im Agenten-Chat an
3. chat(action: "get", project: "${config.project}", agent_id: "${config.name}", limit: 5)
   → Zeigt dir die letzten Nachrichten (Kontext von anderen Agenten)

### Schritt 2: Lokales Wissen laden
4. Lies deine SKILL.md (falls vorhanden) — das ist dein gesammeltes Wissen
5. Lies deine MEMORY.md (falls vorhanden) — das ist dein Projekt-Kontext
6. Lies deine Tages-Logs (heute + gestern)
7. Falls KEINE SKILL.md vorhanden:
   - Mache Web-Recherche zu deinem Fachgebiet (WebSearch)
   - Erstelle eine initiale SKILL.md mit Best Practices und Patterns

### Schritt 3: Kommunikation pruefen
8. Pruefe Channels und Inbox auf neue Nachrichten
9. Beginne mit deiner Aufgabe`)

  return sections.join('\n\n')
}
