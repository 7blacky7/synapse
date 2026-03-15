---
name: synapse-agent-regeln
description: >
  Pflicht-Regeln fuer Subagenten die mit Synapse MCP-Tools arbeiten.
  Use when you are a subagent/teammate and need to use Synapse tools correctly.
  Triggers: Der Koordinator weist dich an diesen Skill aufzurufen,
  "synapse agent regeln", "agent briefing", "synapse onboarding".
---

# Synapse Agent-Regeln

Du bist ein Subagent. Diese Regeln gelten OHNE Ausnahme.

## 1. Onboarding (ALLERERSTE Aktion)

Du bist bereits im Chat registriert (vom Koordinator). Starte mit:

```
get_index_stats(project: "<projekt>", agent_id: "<deine-id>")
get_chat_messages(project: "<projekt>", agent_id: "<deine-id>", limit: 10)
```

## 2. Agent-ID an JEDEN Synapse-Aufruf

```
semantic_code_search(query: "...", project: "...", agent_id: "<deine-id>")
add_thought(project: "...", source: "<deine-id>", content: "...", agent_id: "<deine-id>")
```

**NIEMALS `source: "claude-code"` verwenden.** Immer deine agent_id.

## 3. Suchreihenfolge (PFLICHT)

```
1. Synapse: semantic_code_search / search_by_path / search_memory
2. NUR wenn Score < 0.60 oder 0 Ergebnisse → Glob / Grep
3. NUR wenn beides scheitert → Read / manuelle Suche
```

**VERBOTEN:** Read/Glob/Grep BEVOR Synapse versucht wurde.

## 4. Kommunikation (ueber Agenten-Chat)

**Broadcasts** (alle sehen es):
```
send_chat_message(project: "<projekt>", sender_id: "<deine-id>",
  content: "Status: Task X laeuft, 50% erledigt")
```

**DM an Koordinator** (bei Problemen/Fragen):
```
send_chat_message(project: "<projekt>", sender_id: "<deine-id>",
  content: "Brauche Hilfe: ...", recipient_id: "koordinator")
```

**Neue Nachrichten lesen** (Polling):
```
get_chat_messages(project: "<projekt>", agent_id: "<deine-id>", since: "<letzter-timestamp>")
```

## 5. Task-Abschluss

| Ergebnis | Aktion |
|----------|--------|
| Erfolg | Chat: "Task X erledigt." Task `completed`. |
| Problem | Chat-DM an Koordinator. `add_thought` mit Tag `"problem"`. Task NICHT completed. |

## 6. Ergebnisse speichern

- Plaene, Analysen → `write_memory` (ausfuehrlich)
- Kurze Erkenntnisse → `add_thought`
- KEINE .md-Dateien erstellen — alles in Synapse

## 7. Wissensluecken melden (Cutoff-Handling)

Wenn eine Technologie/Version jenseits deines Cutoffs liegt:

```
1. search_tech_docs(query: "[Frage]", framework: "[tech]", project: "<projekt>")
   → Hat Context7 Auto-Fetch, liefert Basis-Docs automatisch
2. Bei Treffern (Score > 0.60): Docs nutzen, weiterarbeiten
3. Wenn kuratiertes Wissen fehlt (Breaking Changes, Migration, Gotchas):
   → Chat-DM an Koordinator:
   "Wissensluecke: [Tech] v[Version]. Brauche: [was genau fehlt]"
4. NICHT selbst recherchieren (kein Context7, keine Web-Suche, keine externen Skills)
5. NICHT blockieren — mit bestem Wissen weiterarbeiten, TODO-Kommentar setzen
6. Warte auf Antwort (get_chat_messages pollen, max 5x mit 8s Pause)
7. Koordinator dispatcht Docs-Kurator → indexiert kuratierte Docs
8. Danach: search_tech_docs(source: "research") fuer Breaking Changes etc.
```

**Wichtig:** Context7 Auto-Fetch liefert nur Code-Beispiele und API-Referenz.
Fuer Breaking Changes, Migration-Guides und Gotchas braucht es den Docs-Kurator.
Der Koordinator dispatcht ihn automatisch wenn du "Wissensluecke:" meldest.

## 8. Abmeldung (PFLICHT am Ende)

```
unregister_chat_agent(id: "<deine-id>")
```

## 9. Verbote

- Keine Synapse-Einstellungen aendern (init, cleanup, stop)
- NIEMALS `source: "claude-code"` verwenden
- NIEMALS Worktree-Isolation verwenden
- Keine langen Nachrichten per SendMessage — Chat nutzen
